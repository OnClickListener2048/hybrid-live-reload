'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const protocol = require('./bundle-protocol');

const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = protocol.MAX_GET_BYTES;
const CLOSE_WAIT_MS = 500;

function statusError(status, body, label) {
  let detail = '';
  if (body && body.length > 0) {
    const text = body.toString('utf8').trim();
    if (text) {
      try {
        const info = JSON.parse(text);
        detail = info.error ? `: ${info.error}` : `: ${text}`;
      } catch {
        detail = `: ${text}`;
      }
    }
  }
  const err = new Error(`${label} failed (${protocol.statusName(status)})${detail}`);
  err.status = status;
  return err;
}

/**
 * A persistent, full-duplex client for the custom bundle protocol.
 *
 * One TCP connection carries all requests. Each request gets a requestId and
 * can run concurrently with others; responses, server events, heartbeat
 * frames and arbitrary messages all share the connection.
 *
 * This is a development transport: plaintext and unauthenticated. Response
 * SHA-256 values detect corruption, not tampering.
 */
class BundleSession extends EventEmitter {
  constructor({
    host = '127.0.0.1',
    port,
    timeout = DEFAULT_TIMEOUT_MS,
    connectTimeout = DEFAULT_CONNECT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    clientName = 'hybrid-node',
  } = {}) {
    super();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('invalid port');
    }
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.connectTimeout = connectTimeout;
    this.maxBytes = maxBytes;
    this.clientName = clientName;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextRequestId = 1;
    this.welcome = null;
    this.connected = false;
    this.closing = false;
    this.closed = false;
    this.heartbeatMs = 0;
    this.heartbeatTimer = null;
  }

  async connect() {
    if (this.socket || this.connected) {
      throw new Error('session is already connected');
    }
    this.closed = false;
    this.closing = false;

    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    this._attachSocket(socket);

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error('TCP connect timed out'));
      }, this.connectTimeout);

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', fail);
        socket.removeListener('close', onClose);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onClose = () => {
        fail(new Error('TCP connection closed during connect'));
      };

      socket.once('connect', onConnect);
      socket.once('error', fail);
      socket.once('close', onClose);
    }).catch((err) => {
      this._shutdown(err);
      throw err;
    });

    try {
      const rawWelcome = await this._request(
        protocol.TYPE.HELLO,
        protocol.jsonPayload({
          client: this.clientName,
          protocol: protocol.VERSION,
          capabilities: [
            'get',
            'put',
            'message',
            'subscribe',
            'event',
            'heartbeat',
          ],
        }),
        {
          expectedType: protocol.TYPE.WELCOME,
          kind: 'HELLO',
          timeout: this.connectTimeout,
        }
      );
      this.welcome = JSON.parse(rawWelcome.toString('utf8'));
      if (Number(this.welcome.protocol) !== protocol.VERSION) {
        throw new Error(
          `server protocol ${this.welcome.protocol} is not ${protocol.VERSION}`
        );
      }
      this.connected = true;
      this.heartbeatMs = Number(this.welcome.heartbeatMs) || 0;
      this._startHeartbeatWatchdog();
      this.emit('connected', this.welcome);
      return this.welcome;
    } catch (err) {
      this._shutdown(err);
      throw err;
    }
  }

  async get(
    pathname,
    { timeout = this.timeout, maxBytes = this.maxBytes } = {}
  ) {
    this._validatePath(pathname);
    const body = await this._request(
      protocol.TYPE.GET,
      Buffer.from(pathname, 'utf8'),
      {
        expectedType: protocol.TYPE.RESPONSE,
        kind: 'GET',
        timeout,
        maxBytes,
      }
    );
    return body;
  }

  async put(pathname, data, { timeout = this.timeout } = {}) {
    const payload = protocol.encodePutPayload(pathname, data);
    const body = await this._request(protocol.TYPE.PUT, payload, {
      expectedType: protocol.TYPE.RESPONSE,
      kind: 'PUT',
      timeout,
    });
    return JSON.parse(body.toString('utf8'));
  }

  async message(data, { timeout = this.timeout } = {}) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (payload.length > protocol.MAX_MESSAGE_BYTES) {
      throw new Error('message is too large');
    }
    return this._request(protocol.TYPE.MESSAGE, payload, {
      expectedType: protocol.TYPE.MESSAGE,
      kind: 'MESSAGE',
      timeout,
    });
  }

  async subscribe(events, { timeout = this.timeout } = {}) {
    const list = Array.isArray(events) ? events : [events];
    const body = await this._request(
      protocol.TYPE.SUBSCRIBE,
      protocol.jsonPayload({ events: list }),
      {
        expectedType: protocol.TYPE.RESPONSE,
        kind: 'SUBSCRIBE',
        timeout,
      }
    );
    return JSON.parse(body.toString('utf8'));
  }

  async ping({ timeout = this.timeout } = {}) {
    const payload = Buffer.alloc(8);
    payload.writeBigUInt64BE(BigInt(Date.now()));
    const started = Date.now();
    const echoed = await this._request(protocol.TYPE.PING, payload, {
      expectedType: protocol.TYPE.PONG,
      kind: 'PING',
      timeout,
    });
    if (!echoed.equals(payload)) {
      throw new Error('PONG did not mirror the PING payload');
    }
    return Date.now() - started;
  }

  onEvent(name, handler) {
    const listener = (event, data, info) => {
      if (event === name) handler(data, info);
    };
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  waitForEvent(name, timeout = this.timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`event ${name} timed out`));
      }, timeout);
      const unsubscribe = this.onEvent(name, (data, info) => {
        clearTimeout(timer);
        unsubscribe();
        resolve({ data, info });
      });
    });
  }

  close() {
    if (this.closed || this.closing) return;
    this.closing = true;
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      this._shutdown(null);
      return;
    }
    const frame = protocol.encodeFrame({
      magic: protocol.REQUEST_MAGIC,
      type: protocol.TYPE.CLOSE,
    });
    try {
      socket.write(frame, () => socket.end());
    } catch {
      socket.destroy();
    }
    const timer = setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, CLOSE_WAIT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  _validatePath(pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
      throw new Error('path must start with /');
    }
    const size = Buffer.byteLength(pathname, 'utf8');
    if (size > protocol.MAX_PATH_BYTES) {
      throw new Error('path is too long');
    }
    if (pathname.includes('\u0000')) {
      throw new Error('path contains a NUL byte');
    }
  }

  _nextId() {
    for (let attempts = 0; attempts < 0xffffffff; attempts += 1) {
      const id = this.nextRequestId;
      this.nextRequestId = id >= 0xffffffff ? 1 : id + 1;
      if (!this.pending.has(id)) return id;
    }
    throw new Error('no request ids available');
  }

  _request(type, payload, { expectedType, kind, timeout, maxBytes } = {}) {
    if (this.closed || this.closing || !this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('TCP session is not connected'));
    }
    const requestId = this._nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${kind || 'request'} timed out`));
      }, timeout);
      this.pending.set(requestId, {
        expectedType,
        kind,
        maxBytes,
        resolve,
        reject,
        timer,
      });
      try {
        this._sendFrame(type, requestId, payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  _sendFrame(type, requestId, payload) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('TCP socket is not connected');
    }
    this.socket.write(
      protocol.encodeFrame({
        magic: protocol.REQUEST_MAGIC,
        type,
        requestId,
        payload,
      })
    );
  }

  _attachSocket(socket) {
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._shutdown(err));
    socket.on('close', () => {
      this._shutdown(
        this.closing ? null : new Error('TCP connection closed')
      );
    });
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (
      this.buffer.length >
      protocol.FRAME_HEADER_SIZE + protocol.MAX_PAYLOAD_BYTES
    ) {
      this._shutdown(new Error('incoming frame is too large'));
      return;
    }

    while (!this.closed) {
      const frame = protocol.parseFrame(this.buffer, {
        magic: protocol.RESPONSE_MAGIC,
      });
      if (frame === null) return;
      if (frame.error) {
        this._shutdown(new Error(`invalid server frame: ${frame.error}`));
        return;
      }
      this.buffer = this.buffer.subarray(frame.total);
      this._touchHeartbeat();
      try {
        this._handleFrame(frame);
      } catch (err) {
        this._shutdown(err);
        return;
      }
    }
  }

  _handleFrame(frame) {
    switch (frame.type) {
      case protocol.TYPE.PING: {
        this._sendFrame(protocol.TYPE.PONG, frame.requestId, frame.payload);
        this.emit('ping');
        return;
      }
      case protocol.TYPE.PONG: {
        this._settle(frame, frame.payload);
        return;
      }
      case protocol.TYPE.WELCOME:
      case protocol.TYPE.RESPONSE:
      case protocol.TYPE.MESSAGE: {
        this._settle(frame, frame.payload);
        return;
      }
      case protocol.TYPE.EVENT: {
        let info;
        try {
          info = protocol.parseJsonPayload(frame.payload);
        } catch {
          this.emit('protocol-error', 'invalid EVENT payload');
          return;
        }
        this.emit('event', info.event, info.data, info);
        return;
      }
      case protocol.TYPE.ERROR: {
        let info = null;
        try {
          info = protocol.parseJsonPayload(frame.payload);
        } catch {
          // Keep the raw error as a fallback below.
        }
        const err = new Error(
          info && info.error
            ? `server error: ${info.error}`
            : 'server protocol error'
        );
        err.code = info && info.error;
        if (!this._rejectPending(frame.requestId, err)) {
          this.emit('protocol-error', err);
        }
        return;
      }
      case protocol.TYPE.CLOSE: {
        this.emit('server-close');
        this._shutdown(null);
        return;
      }
      default:
        this.emit('protocol-error', `unsupported server frame ${frame.type}`);
    }
  }

  _settle(frame, body) {
    const pending = this.pending.get(frame.requestId);
    if (!pending) {
      this.emit('unhandled-frame', frame);
      return;
    }
    if (pending.expectedType !== frame.type) {
      this._rejectPending(
        frame.requestId,
        new Error(
          `expected frame type ${pending.expectedType}, got ${frame.type}`
        )
      );
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.requestId);

    if (frame.type !== protocol.TYPE.RESPONSE) {
      pending.resolve(body);
      return;
    }

    let response;
    try {
      response = protocol.parseResponsePayload(frame.payload);
    } catch (err) {
      pending.reject(err);
      this._shutdown(err);
      return;
    }
    if (response.status !== protocol.STATUS.OK) {
      pending.reject(statusError(response.status, response.body, pending.kind));
      return;
    }
    if (response.body.length > pending.maxBytes) {
      const err = new Error(`${pending.kind} response exceeds maxBytes`);
      pending.reject(err);
      this._shutdown(err);
      return;
    }
    pending.resolve(response.body);
  }

  _rejectPending(requestId, err) {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(err);
    return true;
  }

  _startHeartbeatWatchdog() {
    this._stopHeartbeatWatchdog();
    if (!this.heartbeatMs) return;
    const timeout = Math.max(this.heartbeatMs * 3, 45000);
    this.heartbeatTimer = setTimeout(() => {
      this._shutdown(new Error('heartbeat timeout'));
    }, timeout);
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  _touchHeartbeat() {
    if (this.heartbeatTimer && typeof this.heartbeatTimer.refresh === 'function') {
      this.heartbeatTimer.refresh();
    }
  }

  _stopHeartbeatWatchdog() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _shutdown(err) {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.welcome = null;
    this._stopHeartbeatWatchdog();
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    const closeError = err || new Error('TCP session closed');
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(closeError);
      this.pending.delete(requestId);
    }
    this.emit('close', err || null);
  }
}

async function openSession(options) {
  const session = new BundleSession(options);
  await session.connect();
  return session;
}

/**
 * Sends raw bytes and resolves as soon as one complete server frame has been
 * received (or the socket closes). Used by the smoke test to exercise
 * malformed hand-built frames and checksum corruption.
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
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(buffer);
    };
    const timer = setTimeout(
      () => finish(new Error('TCP raw exchange timed out')),
      timeout
    );

    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < protocol.FRAME_HEADER_SIZE) return;
      const payloadLength = buffer.readUInt32BE(12);
      if (payloadLength > maxBytes) {
        finish(new Error('TCP response exceeds limit'));
        return;
      }
      if (buffer.length >= protocol.FRAME_HEADER_SIZE + payloadLength) {
        finish(null);
      }
    });
    socket.on('end', () => finish(null));
    socket.on('error', (err) => finish(err));
  });
}

module.exports = { BundleSession, openSession, exchange };
