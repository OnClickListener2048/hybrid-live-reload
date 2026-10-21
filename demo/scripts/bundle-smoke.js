'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { buildBundle, DEFAULT_SOURCE } = require('../core/bundle-builder');
const { createBundleServer } = require('../core/bundle-server');

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

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-bundle-smoke-'));
  const sourceDir = path.join(tmp, 'source');
  const outDir = path.join(tmp, 'out');
  const token = 'smoke-token';
  const port = 19090 + Math.floor(Math.random() * 200);
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
      token,
      logger: (line) => console.log(`       ${line}`),
    });
    await bundleServer.start();

    const base = `http://127.0.0.1:${port}`;
    console.log('\nbundle server smoke checks:');

    const unauthorized = await fetch(`${base}/latest.json`);
    check(
      'latest.json requires token',
      unauthorized.status === 401,
      `HTTP ${unauthorized.status}`
    );

    const latestRes = await fetch(`${base}/latest.json`, {
      headers: { 'x-sync-token': token },
    });
    check('latest.json returns 200', latestRes.status === 200, `HTTP ${latestRes.status}`);
    const remoteLatest = await latestRes.json();
    check('latest version is v2', remoteLatest.version === 'v2', remoteLatest.version);
    check('latest hash matches local build', remoteLatest.sha256 === latest.sha256);

    const zipRes = await fetch(`${base}/${remoteLatest.bundle}`, {
      headers: { 'x-sync-token': token },
    });
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    check('zip returns 200', zipRes.status === 200, `HTTP ${zipRes.status}`);
    check('zip size matches latest.json', zipBuffer.length === remoteLatest.size);

    const zipSha = sha256(zipBuffer);
    check('zip SHA-256 matches latest.json', zipSha === remoteLatest.sha256);

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

    const traversal = await fetch(`${base}/bundles/%2e%2e%2flatest.json`, {
      headers: { 'x-sync-token': token },
    });
    check('path traversal is not served', traversal.status === 404, `HTTP ${traversal.status}`);

    const wrongToken = await fetch(`${base}/latest.json?token=nope`);
    check('wrong query token is rejected', wrongToken.status === 401, `HTTP ${wrongToken.status}`);

    console.log('\nfile-level patch checks:');
    const patch = remoteLatest.patches && remoteLatest.patches.v1;
    check('latest has a patch from v1', Boolean(patch));

    const patchManifestRes = await fetch(`${base}/${patch.manifest}`, {
      headers: { 'x-sync-token': token },
    });
    check(
      'patch manifest returns 200',
      patchManifestRes.status === 200,
      `HTTP ${patchManifestRes.status}`
    );
    const patchManifestBytes = Buffer.from(await patchManifestRes.arrayBuffer());
    const patchManifest = JSON.parse(patchManifestBytes.toString('utf8'));

    const patchZipRes = await fetch(`${base}/${patch.zip}`, {
      headers: { 'x-sync-token': token },
    });
    const patchZipBuffer = Buffer.from(await patchZipRes.arrayBuffer());
    check(
      'patch zip returns 200',
      patchZipRes.status === 200,
      `HTTP ${patchZipRes.status}`
    );
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
