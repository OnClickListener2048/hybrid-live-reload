'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { send, sendJson } = require('./util');
const protocol = require('./bundle-protocol');

const SOCKET_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

const BUNDLE_FILE_RE =
  /^\/bundles\/([A-Za-z0-9._-]+)\/(bundle\.zip|manifest\.json|patch-from-[A-Za-z0-9._-]+\.(?:zip|json))$/;

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

  return {
    file,
    contentType: match[2].endsWith('.zip')
      ? 'application/zip'
      : 'application/json; charset=utf-8',
  };
}

function errorBody(error) {
  return Buffer.from(JSON.stringify({ ok: false, error }), 'utf8');
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
 */
function createBundleServer({
  port,
  root,
  logger = () => {},
}) {
  const sockets = new Set();

  function log(line) {
    logger(line);
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

  function sendTcp(socket, status, body) {
    if (socket.destroyed) return;
    const frame = protocol.encodeResponse(status, body);
    // The Android emulator's NAT occasionally drops the last byte when FIN
    // follows the body immediately. Give the data a moment to settle first;
    // otherwise a 1-byte-short response looks like a truncated bundle.
    socket.write(frame, () => {
      setTimeout(() => {
        if (!socket.destroyed) socket.end();
      }, 50);
    });
  }

  function sendTcpError(socket, status, error) {
    sendTcp(socket, status, errorBody(error));
  }

  async function serveTcpRequest(socket, request) {
    if (
      request.path.length === 0 ||
      !request.path.startsWith('/') ||
      request.path.includes('\u0000')
    ) {
      return sendTcpError(socket, protocol.STATUS.BAD_REQUEST, 'bad_path');
    }

    log(`[bundle-tcp] GET ${request.path}`);
    const resolved = resolveBundleFile(root, request.path);
    if (!resolved) {
      return sendTcpError(socket, protocol.STATUS.NOT_FOUND, 'not_found');
    }

    let stat;
    try {
      stat = await fs.promises.stat(resolved.file);
    } catch {
      return sendTcpError(socket, protocol.STATUS.NOT_FOUND, 'not_found');
    }
    if (!stat.isFile()) {
      return sendTcpError(socket, protocol.STATUS.NOT_FOUND, 'not_found');
    }
    if (stat.size > MAX_RESPONSE_BYTES) {
      return sendTcpError(socket, protocol.STATUS.TOO_LARGE, 'response_too_large');
    }

    let body;
    try {
      body = await fs.promises.readFile(resolved.file);
    } catch (err) {
      log(`[bundle-tcp] read failed: ${err.message}`);
      return sendTcpError(socket, protocol.STATUS.SERVER_ERROR, 'read_failed');
    }

    sendTcp(socket, protocol.STATUS.OK, body);
  }

  function handleTcp(socket) {
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > protocol.MAX_REQUEST_BYTES) {
        socket.removeListener('data', onData);
        return sendTcpError(
          socket,
          protocol.STATUS.BAD_REQUEST,
          'request_too_large'
        );
      }

      const request = protocol.parseRequest(buffer);
      if (request === null) return; // Wait for the rest of the frame.
      socket.removeListener('data', onData);

      if (request.error) {
        return sendTcpError(socket, protocol.STATUS.BAD_REQUEST, request.error);
      }
      if (request.opcode !== protocol.OP_GET) {
        return sendTcpError(
          socket,
          protocol.STATUS.BAD_REQUEST,
          'unsupported_opcode'
        );
      }

      serveTcpRequest(socket, request).catch((err) => {
        log(`[bundle-tcp] request failed: ${err.message}`);
        sendTcpError(socket, protocol.STATUS.SERVER_ERROR, 'server_error');
      });
    };

    socket.on('data', onData);
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', (err) => {
      log(`[bundle-tcp] socket error: ${err.message}`);
    });
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
      log('[bundle-tcp] socket timeout');
      socket.destroy();
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
        handleTcp(socket);
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
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject);
          log(`[bundle] listening on 0.0.0.0:${port} (custom TCP + HTTP /pair)`);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

module.exports = { createBundleServer };
