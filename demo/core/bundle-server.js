'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { send, sendJson } = require('./util');

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

function createBundleServer({
  port,
  root,
  logger = () => {},
}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    logger(`[bundle] ${req.method} ${url.pathname}`);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
    }

    if (url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'bundle-server',
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

    if (url.pathname === '/latest.json') {
      let latest;
      try {
        latest = fs.readFileSync(path.join(root, 'latest.json'));
      } catch {
        return sendJson(res, 404, {
          ok: false,
          error: 'no_bundle_built',
        });
      }
      return send(res, 200, latest, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
    }

    const match =
      /^\/bundles\/([A-Za-z0-9._-]+)\/(bundle\.zip|manifest\.json|patch-from-[A-Za-z0-9._-]+\.(?:zip|json))$/.exec(
        url.pathname
      );
    if (!match) {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }

    const file = path.resolve(root, 'bundles', match[1], match[2]);
    const bundlesRoot = path.resolve(root, 'bundles');
    if (!file.startsWith(`${bundlesRoot}${path.sep}`)) {
      return sendJson(res, 400, { ok: false, error: 'bad_path' });
    }

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }
    if (!stat.isFile()) {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }

    const headers = {
      'content-type': match[2].endsWith('.zip')
        ? 'application/zip'
        : 'application/json; charset=utf-8',
      'content-length': stat.size,
      'cache-control': 'no-store',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      logger(`[bundle] stream failed: ${err.message}`);
      res.destroy(err);
    });
    return stream.pipe(res);
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
          logger(`[bundle] listening on 0.0.0.0:${port}`);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

module.exports = { createBundleServer };
