'use strict';

const http = require('http');
const orchestrator = require('../core/orchestrator');

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function request(url, options = {}) {
  const {
    proxy,
    method = 'GET',
    headers = {},
    body,
    followRedirects = false,
  } = options;

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const reqOptions = proxy
      ? {
          hostname: proxy.hostname,
          port: proxy.port,
          method,
          path: target.href,
          headers: { host: target.host, ...headers },
        }
      : {
          hostname: target.hostname,
          port: target.port || 80,
          method,
          path: target.pathname + target.search,
          headers: { ...headers },
        };

    if (body) {
      reqOptions.headers['content-length'] = Buffer.byteLength(body);
    }

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const result = {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };

        if (
          followRedirects &&
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          const next = new URL(res.headers.location, url).href;
          resolve(
            request(next, {
              proxy,
              method: 'GET',
              headers,
              followRedirects,
            })
          );
        } else {
          resolve(result);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sessionCookie(headers) {
  const setCookie = headers['set-cookie'] || [];
  for (const cookie of setCookie) {
    const match = /^demo_session=([^;]+)/.exec(cookie);
    if (match) return `demo_session=${match[1]}`;
  }
  return null;
}

let passed = 0;
function pass(name, condition, detail = '') {
  if (!condition) {
    throw new Error(`${name}${detail ? ` — ${detail}` : ''}`);
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

(async () => {
  let status;
  try {
    console.log('Starting demo services…\n');
    status = await orchestrator.start();

    const proxy = { hostname: '127.0.0.1', port: status.ports.proxy };
    const prod = status.prodUrl;

    console.log('Running same-origin / SSO checks:\n');

    const prodPage = await request(`${prod}/`);
    pass(
      'production server serves PRODUCTION page',
      prodPage.status === 200 && prodPage.body.includes('PRODUCTION'),
      `status=${prodPage.status}`
    );

    const localPage = await request(`${prod}/`, { proxy });
    pass(
      'proxy maps the production URL to LOCAL page',
      localPage.status === 200 &&
        localPage.body.includes('LOCAL DEV') &&
        localPage.headers['x-hybrid-demo-route'] === 'LOCAL',
      `status=${localPage.status} route=${localPage.headers['x-hybrid-demo-route']}`
    );

    const api = await request(`${prod}/api/me`, { proxy });
    pass(
      'API request passes through to the real backend',
      api.status === 401 &&
        api.headers['x-hybrid-demo-route'] === 'PROD' &&
        api.body.includes('"authenticated": false'),
      `status=${api.status} route=${api.headers['x-hybrid-demo-route']}`
    );

    const login = await request(`${prod}/api/login/start`, { proxy });
    const loginLocation = login.headers.location || '';
    pass(
      'login redirects to the fake IdP with a production redirect_uri',
      login.status === 302 &&
        loginLocation.includes('/idp/authorize') &&
        decodeURIComponent(loginLocation).includes(`${prod}/callback`),
      `status=${login.status} location=${loginLocation}`
    );

    const idpPage = await request(loginLocation, { proxy });
    pass(
      'IdP request passes through the proxy',
      idpPage.status === 200 && idpPage.body.includes('FAKE IDP'),
      `status=${idpPage.status}`
    );

    const hrefMatch = /<a class="primary" href="([^"]+)"/.exec(idpPage.body);
    if (!hrefMatch) throw new Error('IdP login link not found');
    const loginHref = decodeHtml(hrefMatch[1]);

    pass(
      'IdP login link points back to the production callback with code',
      loginHref.startsWith(`${prod}/callback`) &&
        loginHref.includes('code=demo-code'),
      `href=${loginHref}`
    );

    const callbackPage = await request(loginHref, { proxy });
    pass(
      'callback page is served by local code, URL still production',
      callbackPage.status === 200 &&
        callbackPage.body.includes('LOCAL DEV') &&
        callbackPage.headers['x-hybrid-demo-route'] === 'LOCAL',
      `status=${callbackPage.status} route=${callbackPage.headers['x-hybrid-demo-route']}`
    );

    const token = await request(`${prod}/oauth/token`, {
      proxy,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'demo-code' }),
    });
    const cookie = sessionCookie(token.headers);
    pass(
      'token exchange reaches the backend and sets a session cookie',
      token.status === 200 && Boolean(cookie),
      `status=${token.status}`
    );

    const me = await request(`${prod}/api/me`, {
      proxy,
      headers: { cookie },
    });
    pass(
      'session cookie works on the production origin',
      me.status === 200 && me.body.includes('Demo User'),
      `status=${me.status} body=${me.body.slice(0, 80)}`
    );

    const logout = await request(`${prod}/api/logout`, {
      proxy,
      method: 'POST',
      headers: { cookie },
    });
    const meAfterLogout = await request(`${prod}/api/me`, {
      proxy,
      headers: { cookie },
    });
    pass(
      'logout clears the server-side session',
      logout.status === 200 && meAfterLogout.status === 401,
      `logout=${logout.status} me=${meAfterLogout.status}`
    );

    console.log(`\nAll ${passed} checks passed.`);
    await orchestrator.stop();
    process.exit(0);
  } catch (err) {
    console.error(`\n✗ FAILED: ${err.message}`);
    await orchestrator.stop();
    process.exit(1);
  }
})();
