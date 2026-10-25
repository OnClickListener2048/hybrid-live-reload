'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const protocol = require('../core/bundle-protocol');
const { buildBundle, DEFAULT_SOURCE } = require('../core/bundle-builder');
const { createBundleServer } = require('../core/bundle-server');
const { BundleSession, exchange } = require('../core/bundle-tcp-client');

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

function malformed(buffer, patch) {
  const copy = Buffer.from(buffer);
  patch(copy);
  return copy;
}

function parseServerFrame(raw) {
  return protocol.parseFrame(raw, {
    magic: protocol.RESPONSE_MAGIC,
  });
}

function frameError(frame) {
  if (!frame || frame.error) return frame ? frame.error : 'missing_frame';
  if (frame.type !== protocol.TYPE.ERROR) {
    return `expected ERROR, got ${frame.type}`;
  }
  try {
    return protocol.parseJsonPayload(frame.payload).error;
  } catch {
    return 'invalid_error_payload';
  }
}

async function rawError({ host, port, request }) {
  const raw = await exchange({ host, port, request });
  return frameError(parseServerFrame(raw));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-bundle-smoke-'));
  const sourceDir = path.join(tmp, 'source');
  const outDir = path.join(tmp, 'out');
  const port = 19090 + Math.floor(Math.random() * 200);
  const host = '127.0.0.1';
  let bundleServer;
  let session;
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
    check(
      'health reports protocol 3',
      healthBody.protocol === 3,
      String(healthBody.protocol)
    );
    check(
      'health lists the duplex capabilities',
      ['put', 'subscribe', 'server-push', 'heartbeat'].every((name) =>
        healthBody.features.includes(name)
      ),
      JSON.stringify(healthBody.features)
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

    console.log('\nsession handshake and multiplexed GET checks:');
    session = new BundleSession({ host, port });
    const welcome = await session.connect();
    check(
      'session handshake returns WELCOME',
      welcome.server === 'bundle-server',
      JSON.stringify(welcome)
    );
    check(
      'WELCOME reports protocol 3',
      welcome.protocol === protocol.VERSION,
      String(welcome.protocol)
    );
    check(
      'WELCOME advertises upload and push',
      welcome.capabilities.includes('put') &&
        welcome.capabilities.includes('server-push'),
      JSON.stringify(welcome.capabilities)
    );
    check(
      'WELCOME advertises a heartbeat interval',
      Number(welcome.heartbeatMs) > 0,
      String(welcome.heartbeatMs)
    );

    const latestBody = await session.get('/latest.json');
    const remoteLatest = JSON.parse(latestBody.toString('utf8'));
    check('latest version is v2', remoteLatest.version === 'v2', remoteLatest.version);
    check('latest hash matches local build', remoteLatest.sha256 === latest.sha256);

    const zipBody = await session.get(`/${remoteLatest.bundle}`);
    check('bundle zip size matches latest.json', zipBody.length === remoteLatest.size);
    check('zip SHA-256 matches latest.json', sha256(zipBody) === remoteLatest.sha256);

    const zip = await JSZip.loadAsync(zipBody);
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

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        session.get(index % 2 === 0 ? '/latest.json' : `/${remoteLatest.bundle}`)
      )
    );
    check(
      'eight concurrent requests complete on one connection',
      concurrent.length === 8
    );
    check(
      'out-of-order responses keep their own bodies',
      concurrent.every((body, index) =>
        index % 2 === 0
          ? JSON.parse(body.toString('utf8')).sha256 === remoteLatest.sha256
          : sha256(body) === remoteLatest.sha256
      )
    );

    let traversalStatus;
    try {
      await session.get('/bundles/%2e%2e%2flatest.json');
    } catch (err) {
      traversalStatus = err.status;
    }
    check(
      'encoded path traversal is not served',
      traversalStatus === protocol.STATUS.NOT_FOUND,
      protocol.statusName(traversalStatus)
    );

    let dotDotStatus;
    try {
      await session.get('/bundles/../latest.json');
    } catch (err) {
      dotDotStatus = err.status;
    }
    check(
      'dot-dot path traversal is not served',
      dotDotStatus === protocol.STATUS.NOT_FOUND,
      protocol.statusName(dotDotStatus)
    );

    let unknownStatus;
    try {
      await session.get('/not-a-bundle');
    } catch (err) {
      unknownStatus = err.status;
    }
    check(
      'unknown path returns not found',
      unknownStatus === protocol.STATUS.NOT_FOUND,
      protocol.statusName(unknownStatus)
    );

    console.log('\nraw frame and protocol error checks:');
    const validRequest = protocol.encodeFrame({
      type: protocol.TYPE.GET,
      requestId: 77,
      payload: Buffer.from('/latest.json'),
    });
    const rawLatest = await exchange({ host, port, request: validRequest });
    const rawLatestFrame = parseServerFrame(rawLatest);
    check(
      'raw GET returns a RESPONSE frame',
      rawLatestFrame &&
        rawLatestFrame.type === protocol.TYPE.RESPONSE &&
        rawLatestFrame.requestId === 77,
      JSON.stringify(rawLatestFrame)
    );
    const rawResponse = protocol.parseResponsePayload(rawLatestFrame.payload);
    check(
      'raw GET body is valid JSON',
      rawResponse.status === protocol.STATUS.OK &&
        JSON.parse(rawResponse.body.toString('utf8')).version === 'v2'
    );

    const corruptedPayload = Buffer.from(rawLatestFrame.payload);
    corruptedPayload[corruptedPayload.length - 1] ^= 0xff;
    let checksumRejected = false;
    try {
      protocol.parseResponsePayload(corruptedPayload);
    } catch {
      checksumRejected = true;
    }
    check('response checksum rejects corrupted frames', checksumRejected);

    const badVersion = malformed(validRequest, (buf) => buf.writeUInt8(9, 4));
    check(
      'unsupported protocol version is refused',
      (await rawError({ host, port, request: badVersion })) ===
        'unsupported_version'
    );

    const badType = malformed(validRequest, (buf) => buf.writeUInt8(99, 5));
    check(
      'unknown frame type is refused',
      (await rawError({ host, port, request: badType })) ===
        'unsupported_type'
    );

    const badFlags = malformed(validRequest, (buf) => buf.writeUInt8(1, 6));
    check(
      'unsupported frame flags are refused',
      (await rawError({ host, port, request: badFlags })) ===
        'unsupported_flags'
    );

    const oversizedHeader = Buffer.alloc(protocol.FRAME_HEADER_SIZE);
    protocol.REQUEST_MAGIC.copy(oversizedHeader, 0);
    oversizedHeader.writeUInt8(protocol.VERSION, 4);
    oversizedHeader.writeUInt8(protocol.TYPE.GET, 5);
    oversizedHeader.writeUInt32BE(protocol.MAX_PAYLOAD_BYTES + 1, 12);
    check(
      'oversized frame payload is refused',
      (await rawError({ host, port, request: oversizedHeader })) ===
        'payload_too_large'
    );

    const partialHeader = Buffer.alloc(10);
    check(
      'incomplete header is buffered, not rejected',
      protocol.parseFrame(partialHeader) === null
    );
    const partialPayload = Buffer.alloc(protocol.FRAME_HEADER_SIZE + 3);
    protocol.REQUEST_MAGIC.copy(partialPayload, 0);
    partialPayload.writeUInt8(protocol.VERSION, 4);
    partialPayload.writeUInt8(protocol.TYPE.GET, 5);
    partialPayload.writeUInt32BE(8, 12);
    check(
      'incomplete payload is buffered, not rejected',
      protocol.parseFrame(partialPayload) === null
    );

    console.log('\nupload, message, ping and push checks:');
    const uploadBody = Buffer.from('hello from v3\n');
    const upload = await session.put('/uploads/smoke/hello.txt', uploadBody);
    check(
      'PUT writes an upload and returns its hash',
      upload.ok === true &&
        upload.size === uploadBody.length &&
        upload.sha256 === sha256(uploadBody),
      JSON.stringify(upload)
    );
    const uploaded = await session.get('/uploads/smoke/hello.txt');
    check('uploaded bytes can be fetched over the same session', uploaded.equals(uploadBody));
    check(
      'upload is written under the configured uploads directory',
      fs
        .readFileSync(path.join(outDir, 'uploads', 'smoke', 'hello.txt'))
        .equals(uploadBody)
    );

    const httpUpload = await fetch(`${base}/uploads/smoke/hello.txt`);
    check(
      'uploaded data is not exposed over HTTP',
      httpUpload.status === 404,
      `HTTP ${httpUpload.status}`
    );

    let outsideStatus;
    try {
      await session.put('/not-uploads/escape.txt', Buffer.from('x'));
    } catch (err) {
      outsideStatus = err.status;
    }
    check(
      'PUT outside /uploads is refused',
      outsideStatus === protocol.STATUS.BAD_REQUEST,
      protocol.statusName(outsideStatus)
    );

    let traversalUploadStatus;
    try {
      await session.put('/uploads/../escape.txt', Buffer.from('x'));
    } catch (err) {
      traversalUploadStatus = err.status;
    }
    check(
      'PUT path traversal is refused',
      traversalUploadStatus === protocol.STATUS.BAD_REQUEST,
      protocol.statusName(traversalUploadStatus)
    );

    const messageBody = Buffer.from('arbitrary application bytes');
    const echoed = await session.message(messageBody);
    check('MESSAGE is echoed by the server', echoed.equals(messageBody));

    const rtt = await session.ping();
    check('PING receives a matching PONG', rtt >= 0, `${rtt}ms`);

    const subscribed = await session.subscribe(['upload', 'bundle-changed']);
    check(
      'SUBSCRIBE acknowledges both events',
      subscribed.ok === true &&
        subscribed.events.includes('upload') &&
        subscribed.events.includes('bundle-changed'),
      JSON.stringify(subscribed)
    );

    const uploadEvent = session.waitForEvent('upload', 5000);
    await session.put('/uploads/smoke/event.txt', Buffer.from('push me'));
    const uploadPush = await uploadEvent;
    check(
      'server pushes an upload event without polling',
      uploadPush.data.path === '/uploads/smoke/event.txt',
      JSON.stringify(uploadPush.data)
    );

    const mixed = await Promise.all([
      session.get('/latest.json'),
      session.message(Buffer.from('parallel message')),
      session.put('/uploads/smoke/parallel.txt', Buffer.from('parallel')),
      session.ping(),
    ]);
    check(
      'GET, MESSAGE, PUT and PING run concurrently on one connection',
      JSON.parse(mixed[0].toString('utf8')).version === 'v2' &&
        mixed[1].toString() === 'parallel message' &&
        mixed[2].ok === true &&
        mixed[3] >= 0
    );

    const bundleEvent = session.waitForEvent('bundle-changed', 10000);
    fs.appendFileSync(
      path.join(sourceDir, 'app.js'),
      '\n// push smoke change\n'
    );
    const { latest: v3Latest } = await buildBundle({
      sourceDir,
      outDir,
      version: 'v3',
    });
    const bundlePush = await bundleEvent;
    check(
      'server pushes bundle-changed when latest.json changes',
      bundlePush.data.version === 'v3' &&
        bundlePush.data.sha256 === v3Latest.sha256,
      JSON.stringify(bundlePush.data)
    );

    const latestV3 = JSON.parse(
      (await session.get('/latest.json')).toString('utf8')
    );
    check(
      'same session sees the new latest.json after the push',
      latestV3.version === 'v3'
    );

    console.log('\nfile-level patch checks over custom TCP:');
    const patch = remoteLatest.patches && remoteLatest.patches.v1;
    check('latest has a patch from v1', Boolean(patch));

    const patchManifestBody = await session.get(`/${patch.manifest}`);
    const patchManifest = JSON.parse(patchManifestBody.toString('utf8'));
    check(
      'patch manifest bytes are valid JSON',
      patchManifest.version === 'v2' && patchManifest.baseVersion === 'v1'
    );

    const patchZipBuffer = await session.get(`/${patch.zip}`);
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

    const closed = new Promise((resolve) => session.once('close', resolve));
    session.close();
    await closed;
    check('session closes gracefully after CLOSE', true);
    session = null;
  } finally {
    if (session) session.close();
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
