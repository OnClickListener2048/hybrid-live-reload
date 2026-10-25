'use strict';

const net = require('net');
const protocol = require('./bundle-protocol');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Send an already-built request buffer and collect the raw response until the
 * server closes the connection. Used by the smoke test for malformed frames
 * as well as by request() for normal frames.
 */
function exchange({
  host = '127.0.0.1',
  port,
  request,
  timeout = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeout, () => fail(new Error('TCP request timed out')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes + protocol.RESPONSE_HEADER_SIZE) {
        fail(new Error('TCP response exceeds limit'));
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    socket.on('error', fail);
  });
}

async function request({
  host = '127.0.0.1',
  port,
  path,
  timeout = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  const raw = await exchange({
    host,
    port,
    request: protocol.encodeRequest({ path }),
    timeout,
    maxBytes,
  });
  const response = protocol.parseResponse(raw);
  if (!response) throw new Error('incomplete TCP response');
  return response;
}

module.exports = { exchange, request };
