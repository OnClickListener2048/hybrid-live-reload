'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { serveStatic } = require('./util');

function createLocalServer({ port, root, logger = () => {} }) {
  const clients = new Set();
  const mtimes = new Map();
  let watcher = null;
  let pollTimer = null;
  let lastBroadcast = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    logger(`[local] ${req.method} ${url.pathname}`);

    if (url.pathname === '/__events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 1000\n\n');
      clients.add(res);
      logger(`[local] SSE client connected (${clients.size})`);
      req.on('close', () => {
        clients.delete(res);
        logger(`[local] SSE client disconnected (${clients.size})`);
      });
      return;
    }

    if (url.pathname === '/__local_health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, server: 'local', port }));
    }

    return serveStatic(root, req, res, { spaFallback: true });
  });

  function broadcast(reason) {
    const now = Date.now();
    if (now - lastBroadcast < 250) return;
    lastBroadcast = now;

    const payload = `event: reload\ndata: ${JSON.stringify({
      reason,
      at: now,
    })}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
    logger(`[local] reload broadcast (${reason})`);
  }

  function scan() {
    const next = new Map();
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            next.set(full, fs.statSync(full).mtimeMs);
          } catch {
            // file disappeared during scan
          }
        }
      }
    };
    walk(root);

    let changed = false;
    if (next.size !== mtimes.size) changed = true;
    for (const [file, mtime] of next) {
      if (!mtimes.has(file) || mtimes.get(file) !== mtime) changed = true;
    }

    mtimes.clear();
    for (const [file, mtime] of next) mtimes.set(file, mtime);
    return changed;
  }

  return {
    server,
    port,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject);
          scan();
          try {
            watcher = fs.watch(root, { recursive: true }, () => {
              broadcast('fs.watch');
            });
          } catch {
            watcher = null;
          }
          pollTimer = setInterval(() => {
            if (scan()) broadcast('poll');
          }, 700);
          logger(`[local] listening on 0.0.0.0:${port}, watching ${root}`);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        if (watcher) {
          try {
            watcher.close();
          } catch {
            // ignore
          }
          watcher = null;
        }
        clearInterval(pollTimer);
        pollTimer = null;
        for (const client of clients) {
          try {
            client.end();
          } catch {
            // ignore
          }
        }
        clients.clear();
        server.close(() => resolve());
      }),
  };
}

module.exports = { createLocalServer };
