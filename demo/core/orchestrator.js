'use strict';

const EventEmitter = require('events');
const path = require('path');
const { ports, getLanIp } = require('./config');
const { createProdServer } = require('./prod-server');
const { createIdpServer } = require('./idp-server');
const { createLocalServer } = require('./local-server');
const { createProxy } = require('./proxy');

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.services = null;
    this.logs = [];
    this.startedAt = null;
    this.lastError = null;
  }

  log(line) {
    const entry = { at: new Date().toISOString(), line };
    this.logs.push(entry);
    if (this.logs.length > 800) this.logs.shift();
    this.emit('log', entry);
  }

  status() {
    const lanIp = getLanIp();
    return {
      running: this.running,
      startedAt: this.startedAt,
      lastError: this.lastError,
      lanIp,
      lanIpIsLoopback: lanIp === '127.0.0.1',
      ports,
      prodUrl: `http://${lanIp}:${ports.prod}`,
      localUrl: `http://127.0.0.1:${ports.local}`,
      idpUrl: `http://${lanIp}:${ports.idp}`,
      proxyAddress: `${lanIp}:${ports.proxy}`,
      phoneUrl: `http://${lanIp}:${ports.prod}`,
      phoneProxy: `${lanIp}:${ports.proxy}`,
      logs: this.logs.slice(-200),
    };
  }

  async start() {
    if (this.running) return this.status();

    this.lastError = null;
    this.log('starting demo services...');

    const prod = createProdServer({
      port: ports.prod,
      idpPort: ports.idp,
      logger: (line) => this.log(line),
    });
    const idp = createIdpServer({
      port: ports.idp,
      logger: (line) => this.log(line),
    });
    const local = createLocalServer({
      port: ports.local,
      root: path.join(__dirname, '..', 'web', 'local'),
      logger: (line) => this.log(line),
    });
    const proxy = createProxy({
      port: ports.proxy,
      prodPort: ports.prod,
      idpPort: ports.idp,
      localPort: ports.local,
      lanIp: getLanIp(),
      logger: (line) => this.log(line),
    });

    this.services = { prod, idp, local, proxy };

    try {
      await prod.start();
      await idp.start();
      await local.start();
      await proxy.start();
      this.running = true;
      this.startedAt = new Date().toISOString();
      const status = this.status();
      this.log(`ready: phone ${status.phoneUrl}, proxy ${status.phoneProxy}`);
      this.emit('status', status);
      return status;
    } catch (err) {
      this.lastError = err.message;
      this.log(`start failed: ${err.message}`);
      await this.stop();
      throw err;
    }
  }

  async stop() {
    const services = this.services;
    this.services = null;
    this.running = false;
    this.startedAt = null;

    if (services) {
      await Promise.allSettled([
        services.proxy.stop(),
        services.local.stop(),
        services.idp.stop(),
        services.prod.stop(),
      ]);
    }

    this.log('stopped');
    const status = this.status();
    this.emit('status', status);
    return status;
  }

  clearSession() {
    if (this.services) {
      this.services.prod.clearSessions();
    }
    this.log('sessions cleared');
  }
}

module.exports = new Orchestrator();
