'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj, null, 2);
  send(res, status, body, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function safeJoin(root, urlPath) {
  const resolvedRoot = path.resolve(root);
  let clean = urlPath.split('?')[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    return null;
  }
  const relative = clean.replace(/^\/+/, '');
  const full = path.resolve(resolvedRoot, relative);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return full;
}

function serveFile(file, res) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'content-type': contentType(file),
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

function serveStatic(root, req, res, { spaFallback = true } = {}) {
  const urlPath = (req.url || '/').split('?')[0];
  let full = safeJoin(root, urlPath);
  if (!full) return send(res, 400, 'Bad path');
  if (urlPath === '/' || urlPath === '') {
    full = path.join(root, 'index.html');
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      if (spaFallback && !path.extname(urlPath)) {
        return serveFile(path.join(root, 'index.html'), res);
      }
      return send(res, 404, 'Not found');
    }
    return serveFile(full, res);
  });
}

/**
 * Forward a request to an upstream HTTP server.
 * The original Host header is preserved so the app sees the same origin
 * in redirects and cookies.
 */
function proxyTo(target, req, res, { route = 'PASS', logger = () => {} } = {}) {
  const base = `http://${req.headers.host || 'localhost'}`;
  const parsed = new URL(req.url, base);
  const isAbsolute = /^https?:\/\//i.test(req.url);
  const pathWithQuery = isAbsolute ? parsed.pathname + parsed.search : req.url;

  const headers = { ...req.headers };
  delete headers['proxy-connection'];
  delete headers.connection;

  const options = {
    hostname: target.hostname,
    port: target.port || 80,
    method: req.method,
    path: pathWithQuery,
    headers,
  };

  const upstream = http.request(options, (upRes) => {
    const outHeaders = { ...upRes.headers, 'x-hybrid-demo-route': route };
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
  });

  upstream.on('error', (err) => {
    logger(`[proxy] ${route} ${req.method} ${pathWithQuery} -> ${target.hostname}:${target.port} failed: ${err.message}`);
    if (!res.headersSent) {
      send(res, 502, `Upstream error: ${err.message}`);
    } else {
      res.destroy();
    }
  });

  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

module.exports = {
  send,
  sendJson,
  readBody,
  parseCookies,
  serveStatic,
  proxyTo,
  contentType,
};
