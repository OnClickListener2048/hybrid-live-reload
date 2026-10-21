'use strict';

const http = require('http');
const { send } = require('./util');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function appendQuery(url, params) {
  const hasQuery = url.includes('?');
  return `${url}${hasQuery ? '&' : '?'}${new URLSearchParams(params).toString()}`;
}

function createIdpServer({ port, logger = () => {} }) {
  const server = http.createServer((req, res) => {
    const origin = `http://${req.headers.host || `127.0.0.1:${port}`}`;
    const url = new URL(req.url, origin);

    logger(`[idp] ${req.method} ${url.pathname}`);

    if (url.pathname === '/idp/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, server: 'idp', port }));
    }

    if (url.pathname === '/idp/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const state = url.searchParams.get('state') || '';
      const loginHref = appendQuery(redirectUri, {
        code: 'demo-code',
        state,
      });
      const cancelHref = appendQuery(redirectUri, {
        error: 'access_denied',
        state,
      });

      const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Demo IdP · 统一登录</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0b1020; color: #e8ecf8; padding: 24px;
    }
    .card {
      width: min(560px, 100%); padding: 28px; border-radius: 18px;
      background: #151b31; border: 1px solid #2a3457;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .45);
    }
    .badge {
      display: inline-block; padding: 5px 10px; border-radius: 999px;
      background: #2a1f4d; color: #c7b8ff; font-size: 12px;
      letter-spacing: .08em; font-weight: 700;
    }
    h1 { margin: 16px 0 8px; font-size: 26px; }
    p { color: #9aa7c7; line-height: 1.6; }
    dl {
      margin: 20px 0; padding: 16px; border-radius: 12px;
      background: #0f1427; border: 1px solid #232c49;
      font-size: 13px;
    }
    dt { color: #7f8db3; margin-top: 10px; }
    dt:first-child { margin-top: 0; }
    dd { margin: 4px 0 0; word-break: break-all; font-family: ui-monospace, Menlo, monospace; }
    .actions { display: grid; gap: 10px; margin-top: 22px; }
    a {
      display: block; text-align: center; text-decoration: none;
      padding: 13px 16px; border-radius: 10px; font-weight: 700;
    }
    .primary { background: #6d5dfc; color: white; }
    .secondary { background: #1d2542; color: #aab6d8; border: 1px solid #303b63; }
  </style>
</head>
<body>
  <main class="card">
    <div class="badge">FAKE IDP · ${escapeHtml(origin)}</div>
    <h1>统一登录（演示）</h1>
    <p>这是本地模拟的 IdP。真实环境里这里是企业 SSO / OAuth 提供商。点下面的按钮会带着 <code>code</code> 回到应用的 <code>redirect_uri</code>。</p>
    <dl>
      <dt>IdP origin</dt>
      <dd>${escapeHtml(origin)}</dd>
      <dt>redirect_uri</dt>
      <dd>${escapeHtml(redirectUri)}</dd>
      <dt>state</dt>
      <dd>${escapeHtml(state)}</dd>
    </dl>
    <div class="actions">
      <a class="primary" href="${escapeHtml(loginHref)}">以 Demo User 登录</a>
      <a class="secondary" href="${escapeHtml(cancelHref)}">取消</a>
    </div>
  </main>
</body>
</html>`;

      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(html);
    }

    return send(res, 404, 'IdP: not found');
  });

  return {
    server,
    port,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject);
          logger(`[idp] listening on 0.0.0.0:${port}`);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

module.exports = { createIdpServer };
