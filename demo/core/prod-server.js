'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const {
  send,
  sendJson,
  readBody,
  parseCookies,
  serveStatic,
} = require('./util');

function createProdServer({ port, idpPort, logger = () => {} }) {
  const sessions = new Map();

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || `127.0.0.1:${port}`;
    const hostname = host.split(':')[0];
    const url = new URL(req.url, `http://${host}`);
    const pathname = url.pathname;

    logger(`[prod] ${req.method} ${pathname}`);

    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        server: 'prod',
        port,
        now: new Date().toISOString(),
      });
    }

    if (pathname === '/api/me') {
      const auth = req.headers.authorization || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (bearer === 'native-demo-token') {
        return sendJson(res, 200, {
          ok: true,
          authenticated: true,
          user: 'Demo User',
          auth: 'native-token',
          tokenSource: 'URL query',
          server: 'prod',
        });
      }

      const cookies = parseCookies(req);
      const session = sessions.get(cookies.demo_session);
      if (!session) {
        return sendJson(res, 401, {
          ok: false,
          authenticated: false,
          server: 'prod',
        });
      }
      return sendJson(res, 200, {
        ok: true,
        authenticated: true,
        user: session.user,
        auth: 'cookie',
        sessionId: cookies.demo_session,
        issuedAt: session.issuedAt,
        server: 'prod',
      });
    }

    if (pathname === '/api/login/start') {
      const redirectUri = `http://${host}/callback`;
      const state = crypto.randomBytes(8).toString('hex');
      const idpUrl =
        `http://${hostname}:${idpPort}/idp/authorize?` +
        new URLSearchParams({
          redirect_uri: redirectUri,
          state,
          client_id: 'hybrid-demo',
        }).toString();
      logger(`[prod] redirect to IdP: ${idpUrl}`);
      res.writeHead(302, {
        location: idpUrl,
        'cache-control': 'no-store',
      });
      return res.end();
    }

    if (pathname === '/oauth/token' && req.method === 'POST') {
      const body = await readBody(req);
      let code = '';
      try {
        code = JSON.parse(body).code || '';
      } catch {
        // fall through to invalid_code
      }
      if (code !== 'demo-code') {
        return sendJson(res, 400, { ok: false, error: 'invalid_code' });
      }
      const sessionId = crypto.randomBytes(16).toString('hex');
      sessions.set(sessionId, {
        user: 'Demo User',
        issuedAt: new Date().toISOString(),
      });
      res.setHeader('set-cookie', [
        `demo_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
        `demo_ui=${sessionId}; Path=/; SameSite=Lax`,
      ]);
      logger(`[prod] issued session ${sessionId.slice(0, 8)}…`);
      return sendJson(res, 200, {
        ok: true,
        user: 'Demo User',
        sessionId,
      });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const cookies = parseCookies(req);
      sessions.delete(cookies.demo_session);
      res.setHeader('set-cookie', [
        'demo_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax',
        'demo_ui=; Path=/; Max-Age=0; SameSite=Lax',
      ]);
      logger('[prod] session cleared');
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/echo' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, {
        ok: true,
        server: 'prod',
        received: body,
      });
    }

    if (pathname.startsWith('/api/') || pathname.startsWith('/oauth/')) {
      return sendJson(res, 404, {
        ok: false,
        error: 'not_found',
        server: 'prod',
      });
    }

    return serveStatic(path.join(__dirname, '..', 'web', 'prod'), req, res, {
      spaFallback: true,
    });
  });

  return {
    server,
    port,
    sessions,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject);
          logger(`[prod] listening on 0.0.0.0:${port}`);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
    clearSessions: () => sessions.clear(),
  };
}

module.exports = { createProdServer };
