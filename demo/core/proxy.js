'use strict';

const http = require('http');
const os = require('os');
const { send, proxyTo } = require('./util');

function createProxy({ port, prodPort, idpPort, localPort, lanIp, logger = () => {} }) {
  const ownHosts = new Set([
    '127.0.0.1',
    'localhost',
    // Android emulator's alias for the host machine.
    '10.0.2.2',
    lanIp,
    os.hostname(),
    `${os.hostname()}.local`,
  ]);

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return send(res, 400, 'Bad request URL');
    }

    if (url.protocol !== 'http:') {
      return send(res, 501, 'This demo only proxies HTTP. HTTPS MITM is the Whistle path in the real tool.');
    }

    const host = url.hostname;
    const portPart = url.port || '80';
    const own = ownHosts.has(host);
    const path = url.pathname;

    let target;
    let route;

    if (own && portPart === String(prodPort)) {
      const isApi = /^\/(api|oauth|sso|login)(\/|$)/.test(path);
      if (isApi) {
        target = { hostname: '127.0.0.1', port: prodPort };
        route = 'PROD';
      } else {
        target = { hostname: '127.0.0.1', port: localPort };
        route = 'LOCAL';
      }
    } else if (own && portPart === String(idpPort)) {
      target = { hostname: '127.0.0.1', port: idpPort };
      route = 'IDP';
    } else {
      target = { hostname: host, port: portPart };
      route = 'PASS';
    }

    logger(`[proxy] ${route} ${req.method} ${path}${url.search}`);
    return proxyTo(target, req, res, { route, logger });
  });

  // HTTPS CONNECT is intentionally not implemented in this HTTP-only demo.
  server.on('connect', (req, socket) => {
    logger(`[proxy] CONNECT ${req.url} -> not supported in demo`);
    socket.write(
      'HTTP/1.1 501 Not Implemented\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        'Connection: close\r\n\r\n' +
        'This demo only supports HTTP. The real tool uses Whistle for HTTPS MITM.\r\n'
    );
    socket.destroy();
  });

  return {
    server,
    port,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject);
          logger(`[proxy] listening on 0.0.0.0:${port}`);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      }),
  };
}

module.exports = { createProxy };
