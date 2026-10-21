'use strict';

const os = require('os');

const ports = {
  prod: 8080,
  idp: 8081,
  local: 3000,
  proxy: 8899,
  bundle: 9090,
};

function getLanIp() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push({ name, address: addr.address });
      }
    }
  }
  const preferred =
    candidates.find((c) => /^(en0|en1|eth0|wlan0|wi-fi|ethernet)/i.test(c.name)) ||
    candidates[0];
  return preferred ? preferred.address : '127.0.0.1';
}

module.exports = { ports, getLanIp };
