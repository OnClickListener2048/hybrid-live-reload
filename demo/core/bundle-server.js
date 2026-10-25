'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { send, sendJson } = require('./util');
const protocol = require('./bundle-protocol');

const SOCKET_TIMEOUT_MS = 60000;
const DEFAULT_HEARTBEAT_MS = 15000;
const MAX_UPLOAD_BYTES = protocol.MAX_UPLOAD_BYTES;
const MAX_MESSAGE_BYTES = protocol.MAX_MESSAGE_BYTES;

const BUNDLE_FILE_RE =
  /^\/bundles\/([A-Za-z0-9._-]+)\/(bundle\.zip|manifest\.json|patch-from-[A-Za-z0-9._-]+\.(?:zip|json))$/;
const EVENT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function contentTypeFor(file) {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.zip')) return 'application/zip';
  if (file.endsWith('.txt') || file.endsWith('.md')) {
    return 'text/plain; charset=utf-8';
  }
  return 'application/octet-stream';
}

function resolveBundleFile(root, pathname) {
  if (pathname === '/latest.json') {
    return {
      file: path.join(root, 'latest.json'),
      contentType: 'application/json; charset=utf-8',
    };
  }

  const match = BUNDLE_FILE_RE.exec(pathname);
  if (!match) return null;

  const bundlesRoot = path.resolve(root, 'bundles');
  const file = path.resolve(bundlesRoot, match[1], match[2]);
  if (!file.startsWith(`${bundlesRoot}${path.sep}`)) return null;
  return { file, contentType: contentTypeFor(match[2]) };
}

// Upload paths are restricted to /uploads/... and cannot escape that root.
function uploadRelativePath(pathname) {
  if (!pathname.startsWith('/uploads/')) return null;
  const rel = pathname.slice('/uploads/'.length);
  if (!rel || rel.includes('\u0000') || rel.includes('\\')) return null;
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join(path.sep);
}

function resolveUploadFile(uploadsDir, pathname) {
  const rel = uploadRelativePath(pathname);
  if (!rel) return null;
  const root = path.resolve(uploadsDir);
  const file = path.resolve(root, rel);
  if (!file.startsWith(`${root}${path.sep}`)) return null;
  return { file, contentType: contentTypeFor(file) };
}

function resolveFile(root, uploadsDir, pathname) {
  return (
    resolveBundleFile(root, pathname) ||
    resolveUploadFile(uploadsDir, pathname)
  );
}

function errorBody(error) {
  return protocol.jsonPayload({ ok: false, error });
}

// Many Android system cameras only open http(s) links, not custom schemes.
// The QR code therefore points here; this page forwards to the deep link
// after a user gesture (some browsers refuse scheme jumps without one).
const PAIR_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>打开 Hybrid DevShell</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #07111d; color: #e9f2fb;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: min(420px, calc(100vw - 40px)); padding: 24px;
    border: 1px solid rgba(122, 162, 198, .25); border-radius: 16px;
    background: rgba(15, 32, 51, .82); }
  h1 { margin: 0 0 8px; font-size: 22px; }
  #hint { color: #94a9bf; font-size: 14px; }
  #open { display: block; margin: 20px 0 12px; padding: 13px 16px;
    border-radius: 10px; background: #5eead4; color: #05221e;
    font-weight: 700; text-align: center; text-decoration: none; }
  .tip { color: #94a9bf; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>Hybrid DevShell</h1>
  <p id="hint">正在尝试打开 App…</p>
  <a id="open" href="#">打开 Hybrid DevShell</a>
  <p class="tip">如果浏览器没有跳转，请点上面的按钮。仍然没有反应时，确认手机已安装 DevShell，或回到 App 手动填写服务器地址。</p>
</main>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var wanted = new URLSearchParams();
  ['server', 'prod', 'auto'].forEach(function (key) {
    var value = params.get(key);
    if (value) wanted.set(key, value);
  });
  var deepLink = 'hybriddemo-dev://sync?' + wanted.toString();
  document.getElementById('open').href = deepLink;
  document.getElementById('hint').textContent = '已生成配对链接，点按钮打开 App。';
  setTimeout(function () { location.href = deepLink; }, 600);
})();
</script>
</body>
</html>`;

/**
 * One listener for two protocols on the same port:
 *
 * - Requests whose first bytes are "HBT1" are the custom TCP bundle sync
 *   protocol. The Android client uses a raw Socket for these, so Android's
 *   cleartext policy (which is enforced by HttpURLConnection/OkHttp/WebView)
 *   never sees the request.
 * - Everything else is handed to the HTTP server, which only serves the
 *   public pairing page and a health endpoint. Bundle data is never served
 *   over HTTP.
 *
 * v3 keeps the TCP connection open and allows frames in both directions:
 * request IDs, concurrent GETs, PUT uploads, messages, subscriptions and
 * server-pushed events. See core/bundle-protocol.js for the wire format.
 */
function createBundleServer({
  port,
  root,
  uploadsDir = path.join(root, 'uploads'),
  logger = () => {},
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  watchBundles = true,
  watchIntervalMs = 500,
  traceFrames = false,
}) {
  const sockets = new Set();
  const sessions = new Set();
  let latestWatch = null;
  let nextSessionId = 1;

  function log(line) {
    logger(line);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '?';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function sessionLabel(session) {
    const client = session.client ? ` ${session.client}` : '';
    return `#${session.id}${client}`;
  }

  function safeJson(buffer) {
    try {
      return protocol.parseJsonPayload(buffer);
    } catch {
      return null;
    }
  }

  function inboundDetail(frame) {
    switch (frame.type) {
      case protocol.TYPE.HELLO: {
        const hello = safeJson(frame.payload) || {};
        return (
          `client=${hello.client || 'unknown'} ` +
          `protocol=${hello.protocol ?? '?'}`
        );
      }
      case protocol.TYPE.GET:
        return `path=${frame.payload.toString('utf8')}`;
      case protocol.TYPE.PUT: {
        try {
          const upload = protocol.parsePutPayload(frame.payload);
          return `path=${upload.path} body=${formatBytes(upload.body.length)}`;
        } catch {
          return 'invalid_put';
        }
      }
      case protocol.TYPE.SUBSCRIBE: {
        const value = safeJson(frame.payload);
        const events = Array.isArray(value) ? value : value && value.events;
        return Array.isArray(events)
          ? `events=${events.join(',') || '(none)'}`
          : 'events=?';
      }
      case protocol.TYPE.ERROR: {
        const value = safeJson(frame.payload) || {};
        return `error=${value.error || 'unknown'}`;
      }
      case protocol.TYPE.CLOSE:
        return 'graceful';
      default:
        return '';
    }
  }

  function outboundDetail(type, payload) {
    switch (type) {
      case protocol.TYPE.WELCOME: {
        const value = safeJson(payload) || {};
        return (
          `protocol=${value.protocol ?? '?'} ` +
          `heartbeat=${value.heartbeatMs ?? '?'}ms`
        );
      }
      case protocol.TYPE.RESPONSE: {
        if (payload.length < protocol.RESPONSE_PREFIX_SIZE) return '';
        return `status=${protocol.statusName(payload.readUInt8(0))}`;
      }
      case protocol.TYPE.EVENT: {
        const value = safeJson(payload) || {};
        const data = value.data || {};
        const detail = data.version
          ? ` version=${data.version}`
          : data.path
            ? ` path=${data.path}`
            : '';
        return `event=${value.event || 'unknown'}${detail}`;
      }
      case protocol.TYPE.ERROR: {
        const value = safeJson(payload) || {};
        return `error=${value.error || 'unknown'}`;
      }
      case protocol.TYPE.MESSAGE:
        return 'echo';
      case protocol.TYPE.CLOSE:
        return 'graceful';
      default:
        return '';
    }
  }

  function traceFrame(session, direction, type, requestId, payload, detail) {
    // Heartbeats would otherwise add two log lines every interval; WELCOME
    // already reports the negotiated interval.
    if (
      !traceFrames ||
      type === protocol.TYPE.PING ||
      type === protocol.TYPE.PONG
    ) {
      return;
    }
    const arrow = direction === 'in' ? '←' : '→';
    const id = requestId ? ` #${requestId}` : '';
    const size = payload && payload.length ? ` ${formatBytes(payload.length)}` : '';
    const suffix = detail ? ` ${detail}` : '';
    log(
      `[bundle-tcp ${sessionLabel(session)}] ${arrow} ` +
        `${protocol.typeName(type)}${id}${size}${suffix}`
    );
  }

  function traceNote(session, note) {
    if (!traceFrames) return;
    log(`[bundle-tcp ${sessionLabel(session)}] ${note}`);
  }

  function httpHandler(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad_request' });
    }

    log(`[bundle-http] ${req.method} ${url.pathname}`);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
    }

    if (url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'bundle-server',
        transport: 'custom-tcp',
        protocol: protocol.VERSION,
        features: [
          'persistent',
          'multiplexed-get',
          'put',
          'message',
          'subscribe',
          'server-push',
          'heartbeat',
        ],
        now: new Date().toISOString(),
      });
    }

    // Public by design: it only forwards the query parameters to the app.
    if (url.pathname === '/pair') {
      return send(res, 200, PAIR_PAGE, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
    }

    return sendJson(res, 404, { ok: false, error: 'not_found' });
  }

  const httpServer = http.createServer(httpHandler);

  function sendFrame(session, type, requestId, payload = Buffer.alloc(0)) {
    if (session.closed || session.socket.destroyed) return false;
    const frame = protocol.encodeFrame({
      magic: protocol.RESPONSE_MAGIC,
      type,
      requestId,
      payload,
    });
    try {
      session.socket.write(frame);
      traceFrame(
        session,
        'out',
        type,
        requestId,
        payload,
        outboundDetail(type, payload)
      );
      return true;
    } catch (err) {
      log(`[bundle-tcp ${sessionLabel(session)}] write failed: ${err.message}`);
      return false;
    }
  }

  function sendResponse(session, requestId, status, body = Buffer.alloc(0)) {
    return sendFrame(
      session,
      protocol.TYPE.RESPONSE,
      requestId,
      protocol.encodeResponsePayload(status, body)
    );
  }

  function sendErrorResponse(session, requestId, status, error) {
    return sendResponse(session, requestId, status, errorBody(error));
  }

  function sendProtocolError(session, requestId, error, message) {
    return sendFrame(
      session,
      protocol.TYPE.ERROR,
      requestId,
      protocol.jsonPayload({
        ok: false,
        error,
        ...(message ? { message } : {}),
      })
    );
  }

  function closeSession(session, { notify = false } = {}) {
    if (session.closed) return;
    session.closed = true;
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
    }
    if (session.socket.destroyed) return;
    const finish = () => {
      if (!session.socket.destroyed) session.socket.end();
    };
    if (notify) {
      const frame = protocol.encodeFrame({
        magic: protocol.RESPONSE_MAGIC,
        type: protocol.TYPE.CLOSE,
      });
      traceFrame(
        session,
        'out',
        protocol.TYPE.CLOSE,
        0,
        Buffer.alloc(0),
        'graceful'
      );
      session.socket.write(frame, () => setTimeout(finish, 50));
    } else {
      // Keep the same delayed-FIN behavior used by earlier versions for the
      // emulator NAT, even though normal sessions now stay open.
      setTimeout(finish, 50);
    }
  }

  async function serveGet(session, requestId, pathname) {
    if (
      pathname.length === 0 ||
      !pathname.startsWith('/') ||
      pathname.includes('\u0000')
    ) {
      return sendErrorResponse(
        session,
        requestId,
        protocol.STATUS.BAD_REQUEST,
        'bad_path'
      );
    }

    if (!traceFrames) log(`[bundle-tcp] GET ${pathname}`);
    const resolved = resolveFile(root, uploadsDir, pathname);
    if (!resolved) {
      return sendErrorResponse(
        session,
        requestId,
        protocol.STATUS.NOT_FOUND,
        'not_found'
      );
    }

    let stat;
    try {
      stat = await fs.promises.stat(resolved.file);
    } catch {
      return sendErrorResponse(
        session,
        requestId,
        protocol.STATUS.NOT_FOUND,
        'not_found'
      );
    }
    if (!stat.isFile()) {
      return sendErrorResponse(
        session,
        requestId,
        protocol.STATUS.NOT_FOUND,
        'not_found'
      );
    }
    if (stat.size > protocol.MAX_GET_BYTES) {
      return sendErrorResponse(
        session,
        requestId,
        protocol.STATUS.TOO_LARGE,
        'response_too_large'
      );
    }

    let body;
    try {
      body = await fs.promises.readFile(resolved.file);
    } catch (err) {
      log(`[bundle-tcp] read failed: ${err.message}`);
      return sendErrorResponse(
        session,
        requestId,
        protocol.STATUS.SERVER_ERROR,
        'read_failed'
      );
    }
    sendResponse(session, requestId, protocol.STATUS.OK, body);
  }

  async function writeUpload(pathname, body) {
    const resolved = resolveUploadFile(uploadsDir, pathname);
    if (!resolved) throw new Error('bad_upload_path');
    await fs.promises.mkdir(path.dirname(resolved.file), { recursive: true });

    const tmp = `${resolved.file}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    try {
      await fs.promises.writeFile(tmp, body);
      try {
        await fs.promises.rename(tmp, resolved.file);
      } catch (err) {
        // Windows may refuse rename-over-existing; replace explicitly.
        if (err.code !== 'EEXIST' && err.code !== 'EPERM') throw err;
        await fs.promises.rm(resolved.file, { force: true });
        await fs.promises.rename(tmp, resolved.file);
      }
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return resolved.file;
  }

  async function servePut(session, frame) {
    let upload;
    try {
      upload = protocol.parsePutPayload(frame.payload);
    } catch (err) {
      return sendErrorResponse(
        session,
        frame.requestId,
        protocol.STATUS.BAD_REQUEST,
        err.message || 'bad_put'
      );
    }

    if (!uploadRelativePath(upload.path)) {
      return sendErrorResponse(
        session,
        frame.requestId,
        protocol.STATUS.BAD_REQUEST,
        'upload_path_must_be_under_/uploads'
      );
    }
    if (upload.body.length > MAX_UPLOAD_BYTES) {
      return sendErrorResponse(
        session,
        frame.requestId,
        protocol.STATUS.TOO_LARGE,
        'upload_too_large'
      );
    }

    try {
      await writeUpload(upload.path, upload.body);
    } catch (err) {
      log(`[bundle-tcp] upload failed: ${err.message}`);
      return sendErrorResponse(
        session,
        frame.requestId,
        protocol.STATUS.SERVER_ERROR,
        'upload_failed'
      );
    }

    const digest = protocol.sha256(upload.body).toString('hex');
    if (!traceFrames) {
      log(`[bundle-tcp] PUT ${upload.path} (${upload.body.length} bytes)`);
    }
    sendResponse(
      session,
      frame.requestId,
      protocol.STATUS.OK,
      protocol.jsonPayload({
        ok: true,
        path: upload.path,
        size: upload.body.length,
        sha256: digest,
      })
    );
    broadcastEvent('upload', {
      path: upload.path,
      size: upload.body.length,
      sha256: digest,
    });
  }

  function parseEvents(payload) {
    const value = protocol.parseJsonPayload(payload);
    const list = Array.isArray(value) ? value : value && value.events;
    if (!Array.isArray(list)) throw new Error('events must be an array');
    if (list.length > 32) throw new Error('too many events');
    const events = new Set();
    for (const name of list) {
      if (typeof name !== 'string' || !EVENT_NAME_RE.test(name)) {
        throw new Error('bad event name');
      }
      events.add(name);
    }
    return events;
  }

  function serveSubscribe(session, frame) {
    let events;
    try {
      events = parseEvents(frame.payload);
    } catch (err) {
      return sendErrorResponse(
        session,
        frame.requestId,
        protocol.STATUS.BAD_REQUEST,
        err.message || 'bad_subscribe'
      );
    }
    session.subscriptions = events;
    if (!traceFrames) {
      log(`[bundle-tcp] SUBSCRIBE ${[...events].join(',') || '(none)'}`);
    }
    sendResponse(
      session,
      frame.requestId,
      protocol.STATUS.OK,
      protocol.jsonPayload({ ok: true, events: [...events] })
    );
  }

  function serveMessage(session, frame) {
    if (frame.payload.length > MAX_MESSAGE_BYTES) {
      return sendProtocolError(
        session,
        frame.requestId,
        'message_too_large',
        `message is limited to ${MAX_MESSAGE_BYTES} bytes`
      );
    }
    if (!traceFrames) {
      log(`[bundle-tcp] MESSAGE ${frame.payload.length} bytes`);
    }
    // Demo behavior: the server echoes the message back on the same
    // connection. Applications can replace this with their own dispatch.
    sendFrame(session, protocol.TYPE.MESSAGE, frame.requestId, frame.payload);
  }

  function startHeartbeat(session) {
    if (session.heartbeatTimer) return;
    const interval = Math.max(200, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);
    const timeout = Math.max(interval * 3, 45000);
    session.lastPong = Date.now();
    session.heartbeatTimer = setInterval(() => {
      if (session.closed) return;
      if (Date.now() - session.lastPong > timeout) {
        log(`[bundle-tcp ${sessionLabel(session)}] heartbeat timeout`);
        session.socket.destroy();
        return;
      }
      const payload = Buffer.alloc(8);
      payload.writeBigUInt64BE(BigInt(Date.now()));
      sendFrame(session, protocol.TYPE.PING, 0, payload);
    }, interval);
    if (typeof session.heartbeatTimer.unref === 'function') {
      session.heartbeatTimer.unref();
    }
  }

  function handleFrame(session, frame) {
    switch (frame.type) {
      case protocol.TYPE.HELLO: {
        let hello = {};
        try {
          hello = protocol.parseJsonPayload(frame.payload);
        } catch {
          // A malformed HELLO should not take down the connection.
        }
        session.hello = true;
        session.client = hello.client || null;
        startHeartbeat(session);
        if (!traceFrames) {
          log(
            `[bundle-tcp] HELLO client=${hello.client || 'unknown'} ` +
              `protocol=${hello.protocol || '?'}`
          );
        }
        sendFrame(
          session,
          protocol.TYPE.WELCOME,
          frame.requestId,
          protocol.jsonPayload({
            ok: true,
            server: 'bundle-server',
            protocol: protocol.VERSION,
            heartbeatMs,
            maxPayloadBytes: protocol.MAX_PAYLOAD_BYTES,
            maxUploadBytes: protocol.MAX_UPLOAD_BYTES,
            capabilities: [
              'get',
              'put',
              'message',
              'subscribe',
              'server-push',
              'heartbeat',
            ],
          })
        );
        return undefined;
      }
      case protocol.TYPE.GET:
        return serveGet(
          session,
          frame.requestId,
          frame.payload.toString('utf8')
        );
      case protocol.TYPE.PUT:
        return servePut(session, frame);
      case protocol.TYPE.MESSAGE:
        return serveMessage(session, frame);
      case protocol.TYPE.SUBSCRIBE:
        return serveSubscribe(session, frame);
      case protocol.TYPE.PING: {
        sendFrame(
          session,
          protocol.TYPE.PONG,
          frame.requestId,
          frame.payload
        );
        return undefined;
      }
      case protocol.TYPE.PONG: {
        session.lastPong = Date.now();
        return undefined;
      }
      case protocol.TYPE.CLOSE: {
        closeSession(session, { notify: true });
        return undefined;
      }
      default:
        return sendProtocolError(
          session,
          frame.requestId,
          'unsupported_type',
          `unsupported type ${frame.type}`
        );
    }
  }

  function failFrame(session, error, requestId = 0) {
    if (traceFrames) {
      log(`[bundle-tcp ${sessionLabel(session)}] ! protocol ${error}`);
    }
    sendProtocolError(session, requestId, error);
    closeSession(session);
  }

  function onSessionData(session, chunk) {
    session.buffer = Buffer.concat([session.buffer, chunk]);
    if (session.buffer.length > protocol.FRAME_HEADER_SIZE + protocol.MAX_PAYLOAD_BYTES) {
      return failFrame(session, 'frame_too_large');
    }

    while (!session.closed) {
      const frame = protocol.parseFrame(session.buffer, {
        magic: protocol.REQUEST_MAGIC,
      });
      if (frame === null) return;
      if (frame.error) {
        return failFrame(session, frame.error);
      }
      session.buffer = session.buffer.subarray(frame.total);
      session.lastSeen = Date.now();
      traceFrame(
        session,
        'in',
        frame.type,
        frame.requestId,
        frame.payload,
        inboundDetail(frame)
      );

      try {
        const result = handleFrame(session, frame);
        if (result && typeof result.catch === 'function') {
          result.catch((err) => {
            log(
              `[bundle-tcp ${sessionLabel(session)}] frame failed: ${err.message}`
            );
            sendErrorResponse(
              session,
              frame.requestId,
              protocol.STATUS.SERVER_ERROR,
              'server_error'
            );
          });
        }
      } catch (err) {
        log(
          `[bundle-tcp ${sessionLabel(session)}] frame failed: ${err.message}`
        );
        failFrame(session, 'server_error', frame.requestId);
        return;
      }
    }
  }

  function cleanupSession(session) {
    session.closed = true;
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
    }
    sessions.delete(session);
  }

  function handleSession(socket) {
    const session = {
      id: nextSessionId++,
      client: null,
      socket,
      buffer: Buffer.alloc(0),
      subscriptions: new Set(),
      hello: false,
      lastPong: Date.now(),
      lastSeen: Date.now(),
      heartbeatTimer: null,
      closed: false,
    };
    sessions.add(session);
    sockets.add(socket);
    traceNote(
      session,
      `connected from ${socket.remoteAddress || '?'}:${socket.remotePort ?? '?'}`
    );

    socket.on('data', (chunk) => {
      if (session.closed) return;
      onSessionData(session, chunk);
    });
    socket.on('error', (err) => {
      log(`[bundle-tcp ${sessionLabel(session)}] socket error: ${err.message}`);
    });
    socket.on('close', () => {
      cleanupSession(session);
      sockets.delete(socket);
      traceNote(session, 'disconnected');
    });
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
      log(`[bundle-tcp ${sessionLabel(session)}] socket timeout`);
      socket.destroy();
    });
    socket.setNoDelay(true);
  }

  function broadcastEvent(event, data) {
    if (!EVENT_NAME_RE.test(event)) return;
    const payload = protocol.jsonPayload({
      event,
      data,
      at: new Date().toISOString(),
    });
    for (const session of sessions) {
      if (session.closed || !session.subscriptions.has(event)) continue;
      sendFrame(session, protocol.TYPE.EVENT, 0, payload);
    }
  }

  function startLatestWatcher() {
    if (!watchBundles) return;
    const latestPath = path.join(root, 'latest.json');
    let lastHash = null;

    const readLatest = async () => {
      const text = await fs.promises.readFile(latestPath, 'utf8');
      return JSON.parse(text);
    };

    readLatest()
      .then((latest) => {
        if (latest && typeof latest.sha256 === 'string') {
          lastHash = latest.sha256;
        }
      })
      .catch(() => {});

    const listener = async (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      if (curr.nlink === 0) return;
      let latest;
      try {
        latest = await readLatest();
      } catch {
        return;
      }
      if (!latest || typeof latest.sha256 !== 'string') return;
      if (latest.sha256 === lastHash) return;
      lastHash = latest.sha256;
      log(
        `[bundle-tcp] bundle changed: ${latest.version || '?'} ` +
          `${latest.sha256.slice(0, 12)}…`
      );
      broadcastEvent('bundle-changed', {
        version: latest.version || null,
        sha256: latest.sha256,
        size: latest.size ?? null,
      });
    };

    fs.watchFile(latestPath, { interval: watchIntervalMs }, listener);
    latestWatch = { path: latestPath, listener };
  }

  function stopLatestWatcher() {
    if (!latestWatch) return;
    fs.unwatchFile(latestWatch.path, latestWatch.listener);
    latestWatch = null;
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', (err) => {
      log(`[bundle-tcp] socket error: ${err.message}`);
    });
    socket.setNoDelay(true);

    // Peek only enough bytes to tell the custom protocol from HTTP. The
    // bytes are put back before handing the socket to either parser.
    let head = Buffer.alloc(0);
    const onFirstData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      if (head.length < protocol.REQUEST_MAGIC.length) return;

      socket.pause();
      socket.removeListener('data', onFirstData);
      socket.unshift(head);
      if (head.subarray(0, 4).equals(protocol.REQUEST_MAGIC)) {
        handleSession(socket);
      } else {
        httpServer.emit('connection', socket);
      }
      socket.resume();
    };
    socket.on('data', onFirstData);
  });

  return {
    server,
    port,
    root,
    uploadsDir,
    broadcastEvent,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject);
          startLatestWatcher();
          log(
            `[bundle] listening on 0.0.0.0:${port} ` +
              '(custom TCP v3 + HTTP /pair)'
          );
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        stopLatestWatcher();
        for (const session of sessions) {
          closeSession(session);
        }
        sessions.clear();
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

module.exports = { createBundleServer };
