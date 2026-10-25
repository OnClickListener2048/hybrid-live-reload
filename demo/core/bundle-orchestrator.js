'use strict';

const EventEmitter = require('events');
const path = require('path');
const { ports, getLanIp } = require('./config');
const { createProdServer } = require('./prod-server');
const { createBundleServer } = require('./bundle-server');
const {
  buildBundle,
  readLatest,
  DEFAULT_SOURCE,
  DEFAULT_OUT,
} = require('./bundle-builder');

const DEMO_ROOT = path.join(__dirname, '..');

function pairUrl({ server, prod, auto = true }) {
  const query = new URLSearchParams({
    server,
    prod,
    auto: auto ? '1' : '0',
  });
  return `hybriddemo-dev://sync?${query.toString()}`;
}

// QR-friendly URL: system cameras understand http(s), then the page opens
// the custom scheme. The HTTP page only serves the pairing UI; bundle data is
// fetched by the app over the custom TCP protocol. `pageBase` is the HTTP
// listener and `server` is the tcp:// endpoint stored in the deep link.
function pairPageUrl({ pageBase, server, prod, auto = true }) {
  const query = new URLSearchParams({
    server,
    prod,
    auto: auto ? '1' : '0',
  });
  return `${pageBase}/pair?${query.toString()}`;
}

class BundleOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.services = null;
    this.logs = [];
    this.startedAt = null;
    this.lastError = null;
    this.building = false;
    this.sourceDir = DEFAULT_SOURCE;
  }

  sourceLabel() {
    const rel = path.relative(DEMO_ROOT, this.sourceDir);
    if (!rel || rel.startsWith('..')) return this.sourceDir;
    return rel.split(path.sep).join('/');
  }

  setSourceDir(dir) {
    if (!dir) return;
    this.sourceDir = path.resolve(dir);
    this.log(`[bundle] build source: ${this.sourceLabel()}`);
  }

  log(line) {
    const entry = { at: new Date().toISOString(), line };
    this.logs.push(entry);
    if (this.logs.length > 800) this.logs.shift();
    this.emit('log', entry);
  }

  latest() {
    const latest = readLatest(DEFAULT_OUT);
    if (!latest) return null;
    let manifest = null;
    try {
      manifest = JSON.parse(
        require('fs').readFileSync(
          path.join(DEFAULT_OUT, 'bundles', latest.version, 'manifest.json'),
          'utf8'
        )
      );
    } catch {
      // Status can still show the latest metadata without the file list.
    }
    return {
      ...latest,
      manifest,
      files: manifest ? Object.keys(manifest.files).sort() : [],
    };
  }

  status() {
    const lanIp = getLanIp();
    const pairPageLan = `http://${lanIp}:${ports.bundle}`;
    const tcpLan = `tcp://${lanIp}:${ports.bundle}`;
    const prodLan = `http://${lanIp}:${ports.prod}`;
    const pairPageEmulator = `http://10.0.2.2:${ports.bundle}`;
    const tcpEmulator = `tcp://10.0.2.2:${ports.bundle}`;
    const prodEmulator = `http://10.0.2.2:${ports.prod}`;
    return {
      running: this.running,
      startedAt: this.startedAt,
      lastError: this.lastError,
      building: this.building,
      lanIp,
      lanIpIsLoopback: lanIp === '127.0.0.1',
      ports,
      prodUrl: prodLan,
      prodEmulatorUrl: prodEmulator,
      // HTTP is only for the pairing page; the app syncs over custom TCP.
      bundleServerUrl: pairPageLan,
      bundleServerEmulatorUrl: pairPageEmulator,
      bundleTcpUrl: tcpLan,
      bundleTcpEmulatorUrl: tcpEmulator,
      pairLink: pairUrl({
        server: tcpLan,
        prod: prodLan,
      }),
      // The QR code uses the HTTP page so the system camera can open it.
      qrLink: pairPageUrl({
        pageBase: pairPageLan,
        server: tcpLan,
        prod: prodLan,
      }),
      pairLinkEmulator: pairUrl({
        server: tcpEmulator,
        prod: prodEmulator,
      }),
      sourceDir: this.sourceDir,
      sourceLabel: this.sourceLabel(),
      latest: this.latest(),
      logs: this.logs.slice(-200),
    };
  }

  async ensureInitialBundle() {
    if (readLatest(DEFAULT_OUT)) return;
    this.log(`[bundle] no build found, creating v1 from ${this.sourceLabel()}`);
    await buildBundle({
      sourceDir: this.sourceDir,
      outDir: DEFAULT_OUT,
      logger: (line) => this.log(line),
    });
  }

  async start() {
    if (this.running) return this.status();
    this.lastError = null;
    this.log('starting bundle-sync demo services...');

    try {
      await this.ensureInitialBundle();
    } catch (err) {
      this.lastError = err.message;
      this.log(`[bundle] initial build failed: ${err.message}`);
      throw err;
    }

    const prod = createProdServer({
      port: ports.prod,
      idpPort: ports.idp,
      logger: (line) => this.log(line),
    });
    const bundleServer = createBundleServer({
      port: ports.bundle,
      root: DEFAULT_OUT,
      logger: (line) => this.log(line),
      // The desktop console log shows every client/server frame with arrows.
      traceFrames: true,
    });
    this.services = { prod, bundleServer };

    try {
      await prod.start();
      await bundleServer.start();
      this.running = true;
      this.startedAt = new Date().toISOString();
      const status = this.status();
      this.log(
        `ready: prod ${status.prodUrl}, bundles ${status.bundleTcpUrl} ` +
          `(pair page ${status.bundleServerUrl})`
      );
      this.emit('status', status);
      return status;
    } catch (err) {
      this.lastError = err.message;
      this.log(`start failed: ${err.message}`);
      await this.stop();
      throw err;
    }
  }

  async buildNewBundle() {
    if (this.building) return this.latest();
    this.building = true;
    this.emit('status', this.status());
    try {
      this.log(`[bundle] building from ${this.sourceLabel()}`);
      const { latest } = await buildBundle({
        sourceDir: this.sourceDir,
        outDir: DEFAULT_OUT,
        logger: (line) => this.log(line),
      });
      this.log(`[bundle] latest is now ${latest.version}`);
      return this.latest();
    } finally {
      this.building = false;
      this.emit('status', this.status());
    }
  }

  async stop() {
    const services = this.services;
    this.services = null;
    this.running = false;
    this.startedAt = null;

    if (services) {
      await Promise.allSettled([
        services.bundleServer.stop(),
        services.prod.stop(),
      ]);
    }

    this.log('stopped');
    this.emit('status', this.status());
  }

  clearSession() {
    if (this.services) this.services.prod.clearSessions();
    this.log('sessions cleared');
  }
}

module.exports = new BundleOrchestrator();
