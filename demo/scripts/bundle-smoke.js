'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const protocol = require('../core/bundle-protocol');
const { buildBundle, DEFAULT_SOURCE } = require('../core/bundle-builder');
const { createBundleServer } = require('../core/bundle-server');
const { exchange, request } = require('../core/bundle-tcp-client');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function jsonBody(response) {
  return JSON.parse(response.body.toString('utf8'));
}

function malformed(buffer, patch) {
  const copy = Buffer.from(buffer);
  patch(copy);
  return copy;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-bundle-smoke-'));
  const sourceDir = path.join(tmp, 'source');
  const outDir = path.join(tmp, 'out');
  const port = 19090 + Math.floor(Math.random() * 200);
  const host = '127.0.0.1';
  let bundleServer;
  try {
    fs.cpSync(DEFAULT_SOURCE, sourceDir, { recursive: true });

    await buildBundle({
      sourceDir,
      outDir,
      version: 'v1',
    });

    // Change one source file so v2 has a small, predictable patch from v1.
    fs.appendFileSync(
      path.join(sourceDir, 'app.js'),
      '\n// patch smoke change\n'
    );
    const { latest } = await buildBundle({
      sourceDir,
      outDir,
      version: 'v2',
    });

    bundleServer = createBundleServer({
      port,
      root: outDir,
      logger: (line) => console.log(`       ${line}`),
    });
    await bundleServer.start();

    const base = `http://${host}:${port}`;
    console.log('\nHTTP pairing / health checks:');

    const health = await fetch(`${base}/health`);
    const healthBody = await health.json();
    check('health returns 200', health.status === 200, `HTTP ${health.status}`);
    check(
      'health reports custom-tcp transport',
      healthBody.transport === 'custom-tcp',
      JSON.stringify(healthBody)
    );

    const pair = await fetch(
      `${base}/pair?server=${encodeURIComponent(`tcp://${host}:${port}`)}`
    );
    const pairHtml = await pair.text();
    check('pair page returns 200', pair.status === 200, `HTTP ${pair.status}`);
    check(
      'pair page builds the custom-scheme deep link',
      pairHtml.includes('hybriddemo-dev://sync?')
    );

    const httpLatest = await fetch(`${base}/latest.json?token=anything`, {
      headers: { 'x-sync-token': 'anything' },
    });
    check(
      'bundle data is not exposed over HTTP',
      httpLatest.status === 404,
      `HTTP ${httpLatest.status}`
    );

    console.log('\ncustom TCP token-free checks:');
    const legacyTokenRes = protocol.parseResponse(
      await exchange({
        host,
        port,
        request: protocol.encodeRequest({
          token: 'legacy-client-token',
          path: '/latest.json',
        }),
      })
    );
    check(
      'legacy token bytes are ignored, not required',
      legacyTokenRes.status === protocol.STATUS.OK,
      protocol.statusName(legacyTokenRes.status)
    );

    console.log('\ncustom TCP bundle checks:');
    const latestRes = await request({
      host,
      port,
      path: '/latest.json',
    });
    check(
      'latest.json returns OK',
      latestRes.status === protocol.STATUS.OK,
      protocol.statusName(latestRes.status)
    );
    const remoteLatest = jsonBody(latestRes);
    check('latest version is v2', remoteLatest.version === 'v2', remoteLatest.version);
    check('latest hash matches local build', remoteLatest.sha256 === latest.sha256);

    const zipRes = await request({
      host,
      port,
      path: `/${remoteLatest.bundle}`,
    });
    check(
      'bundle zip returns OK',
      zipRes.status === protocol.STATUS.OK,
      protocol.statusName(zipRes.status)
    );
    const zipBuffer = zipRes.body;
    check('zip size matches latest.json', zipBuffer.length === remoteLatest.size);
    check('zip SHA-256 matches latest.json', sha256(zipBuffer) === remoteLatest.sha256);

    const zip = await JSZip.loadAsync(zipBuffer);
    const manifestBytes = await zip.file('manifest.json').async('nodebuffer');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    let hashesOk = true;
    for (const [name, info] of Object.entries(manifest.files)) {
      const entry = zip.file(name);
      if (!entry) {
        hashesOk = false;
        break;
      }
      const data = await entry.async('nodebuffer');
      if (sha256(data) !== info.sha256 || data.length !== info.size) {
        hashesOk = false;
        break;
      }
    }
    check('every manifest file hash matches zip', hashesOk);

    const buildInfo = await zip.file('build-info.js').async('string');
    check('build-info.js was injected', /"version": "v2"/.test(buildInfo));

    const traversalA = await request({
      host,
      port,
      path: '/bundles/%2e%2e%2flatest.json',
    });
    check(
      'encoded path traversal is not served',
      traversalA.status === protocol.STATUS.NOT_FOUND,
      protocol.statusName(traversalA.status)
    );

    const traversalB = await request({
      host,
      port,
      path: '/bundles/../latest.json',
    });
    check(
      'dot-dot path traversal is not served',
      traversalB.status === protocol.STATUS.NOT_FOUND,
      protocol.statusName(traversalB.status)
    );

    const unknown = await request({
      host,
      port,
      path: '/not-a-bundle',
    });
    check(
      'unknown path returns not found',
      unknown.status === protocol.STATUS.NOT_FOUND,
      protocol.statusName(unknown.status)
    );

    console.log('\ncustom TCP protocol checks:');
    const validRequest = protocol.encodeRequest({ path: '/latest.json' });

    const badVersion = malformed(validRequest, (buf) => buf.writeUInt8(9, 4));
    const badVersionRes = protocol.parseResponse(
      await exchange({ host, port, request: badVersion })
    );
    check(
      'unsupported protocol version is refused',
      badVersionRes.status === protocol.STATUS.BAD_REQUEST,
      protocol.statusName(badVersionRes.status)
    );

    const badOpcode = malformed(validRequest, (buf) => buf.writeUInt8(9, 5));
    const badOpcodeRes = protocol.parseResponse(
      await exchange({ host, port, request: badOpcode })
    );
    check(
      'unknown opcode is refused',
      badOpcodeRes.status === protocol.STATUS.BAD_REQUEST,
      protocol.statusName(badOpcodeRes.status)
    );

    const trailing = Buffer.concat([validRequest, Buffer.from([0])]);
    const trailingRes = protocol.parseResponse(
      await exchange({ host, port, request: trailing })
    );
    check(
      'trailing request bytes are refused',
      trailingRes.status === protocol.STATUS.BAD_REQUEST,
      protocol.statusName(trailingRes.status)
    );

    const oversizedHeader = Buffer.alloc(protocol.REQUEST_HEADER_SIZE);
    protocol.REQUEST_MAGIC.copy(oversizedHeader, 0);
    oversizedHeader.writeUInt8(protocol.VERSION, 4);
    oversizedHeader.writeUInt8(protocol.OP_GET, 5);
    oversizedHeader.writeUInt16BE(0, 6);
    oversizedHeader.writeUInt32BE(protocol.MAX_PATH_BYTES + 1, 8);
    const oversizedRes = protocol.parseResponse(
      await exchange({ host, port, request: oversizedHeader })
    );
    check(
      'oversized request frame is refused',
      oversizedRes.status === protocol.STATUS.BAD_REQUEST,
      protocol.statusName(oversizedRes.status)
    );

    const rawLatest = await exchange({
      host,
      port,
      request: validRequest,
    });
    const corrupted = Buffer.from(rawLatest);
    corrupted[corrupted.length - 1] ^= 0xff;
    let checksumRejected = false;
    try {
      protocol.parseResponse(corrupted);
    } catch {
      checksumRejected = true;
    }
    check('response checksum rejects corrupted frames', checksumRejected);

    console.log('\nfile-level patch checks over custom TCP:');
    const patch = remoteLatest.patches && remoteLatest.patches.v1;
    check('latest has a patch from v1', Boolean(patch));

    const patchManifestRes = await request({
      host,
      port,
      path: `/${patch.manifest}`,
    });
    check(
      'patch manifest returns OK',
      patchManifestRes.status === protocol.STATUS.OK,
      protocol.statusName(patchManifestRes.status)
    );
    const patchManifest = jsonBody(patchManifestRes);

    const patchZipRes = await request({
      host,
      port,
      path: `/${patch.zip}`,
    });
    check(
      'patch zip returns OK',
      patchZipRes.status === protocol.STATUS.OK,
      protocol.statusName(patchZipRes.status)
    );
    const patchZipBuffer = patchZipRes.body;
    check('patch zip size matches latest.json', patchZipBuffer.length === patch.size);
    check('patch zip SHA-256 matches latest.json', sha256(patchZipBuffer) === patch.sha256);
    check(
      'patch manifest targets v2 from v1',
      patchManifest.version === 'v2' && patchManifest.baseVersion === 'v1'
    );
    check(
      'patch manifest carries the full target file map',
      JSON.stringify(patchManifest.files) === JSON.stringify(manifest.files)
    );

    const changed = [...patchManifest.changed].sort();
    check(
      'patch changes app.js and build-info.js',
      JSON.stringify(changed) === JSON.stringify(['app.js', 'build-info.js']),
      JSON.stringify(changed)
    );
    check('patch has no removed files', patchManifest.removed.length === 0);
    check('patch is smaller than the full bundle', patch.size < remoteLatest.size);

    const patchZip = await JSZip.loadAsync(patchZipBuffer);
    const patchEntries = Object.keys(patchZip.files)
      .filter((name) => !patchZip.files[name].dir)
      .sort();
    check(
      'patch zip contains only changed files',
      JSON.stringify(patchEntries) === JSON.stringify(changed),
      JSON.stringify(patchEntries)
    );

    const v1Zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(outDir, 'bundles', 'v1', 'bundle.zip'))
    );
    const changedSet = new Set(changed);
    let reconstructed = true;
    for (const [name, info] of Object.entries(manifest.files)) {
      const entry = changedSet.has(name)
        ? patchZip.file(name)
        : v1Zip.file(name);
      if (!entry) {
        reconstructed = false;
        break;
      }
      const data = await entry.async('nodebuffer');
      if (sha256(data) !== info.sha256 || data.length !== info.size) {
        reconstructed = false;
        break;
      }
    }
    check('v1 + patch reconstructs the full v2 tree', reconstructed);
  } finally {
    if (bundleServer) await bundleServer.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
