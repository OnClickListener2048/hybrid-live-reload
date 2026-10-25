'use strict';

const crypto = require('crypto');

// Custom binary protocol used by the bundle sync transport.
//
// v3 is a persistent, full-duplex protocol. Both sides send frames with the
// same layout; only the magic differs by direction:
//
//   client -> server: "HBT1" | version | type | flags | reserved |
//                     requestId u32 | payloadLen u32 | payload
//   server -> client: "HBR1" | ...same layout...
//
// requestId correlates requests with responses and lets multiple requests be
// in flight on one connection. requestId 0 is reserved for unsolicited server
// events and heartbeat frames.
//
// Frame types:
//   HELLO      client -> server  JSON {client, protocol, capabilities}
//   WELCOME    server -> client  JSON {server, protocol, heartbeatMs, ...}
//   GET        client -> server  path (UTF-8)
//   RESPONSE   server -> client  status u8 | reserved u8 | sha256(body) 32 | body
//   PUT        client -> server  pathLen u16 | path | sha256(body) 32 | body
//   MESSAGE    both directions   arbitrary bytes; the demo server echoes it
//   EVENT      server -> client  JSON {event, data, at}
//   SUBSCRIBE  client -> server  JSON {events: ["bundle-changed", ...]}
//   PING       both directions   8-byte timestamp (may be empty)
//   PONG       both directions   mirrors the PING payload
//   ERROR      both directions   JSON {ok:false, error, message?}
//   CLOSE      both directions   empty; graceful shutdown
//
// The response SHA-256 protects file/message payloads against truncation and
// corruption. It is integrity only: this development transport is still
// plaintext and unauthenticated.

const REQUEST_MAGIC = Buffer.from('HBT1');
const RESPONSE_MAGIC = Buffer.from('HBR1');
const VERSION = 3;

const TYPE = Object.freeze({
  HELLO: 1,
  WELCOME: 2,
  GET: 3,
  RESPONSE: 4,
  PUT: 5,
  MESSAGE: 6,
  EVENT: 7,
  SUBSCRIBE: 8,
  PING: 9,
  PONG: 10,
  ERROR: 11,
  CLOSE: 12,
});

const STATUS = Object.freeze({
  OK: 0,
  BAD_REQUEST: 1,
  NOT_FOUND: 2,
  TOO_LARGE: 3,
  SERVER_ERROR: 4,
});

const TYPE_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(TYPE).map(([name, value]) => [value, name])
  )
);

const FRAME_HEADER_SIZE = 16;
const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;
const MAX_GET_BYTES = 128 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const RESPONSE_PREFIX_SIZE = 34; // status + reserved + sha256
const PUT_PREFIX_SIZE = 34; // pathLen + sha256

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function isKnownType(type) {
  return Number.isInteger(type) && type >= TYPE.HELLO && type <= TYPE.CLOSE;
}

function typeName(type) {
  return TYPE_NAMES[type] || `type_${type}`;
}

function encodeFrame({
  magic = REQUEST_MAGIC,
  type,
  requestId = 0,
  payload = Buffer.alloc(0),
} = {}) {
  if (!Buffer.isBuffer(magic) || magic.length !== 4) {
    throw new Error('frame magic must be 4 bytes');
  }
  if (!isKnownType(type)) {
    throw new Error('unknown frame type');
  }
  if (!Number.isInteger(requestId) || requestId < 0 || requestId > 0xffffffff) {
    throw new Error('invalid requestId');
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_PAYLOAD_BYTES) {
    throw new Error('frame payload is too large');
  }

  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  magic.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(type, 5);
  header.writeUInt8(0, 6); // flags
  header.writeUInt8(0, 7); // reserved
  header.writeUInt32BE(requestId, 8);
  header.writeUInt32BE(body.length, 12);
  return Buffer.concat([header, body]);
}

// Parses the first complete frame in buffer. Returns null while incomplete,
// {error} for an invalid frame, otherwise {type, requestId, payload, total}.
// Extra bytes after a valid frame are left for the next call.
function parseFrame(buffer, { magic = REQUEST_MAGIC } = {}) {
  if (buffer.length < FRAME_HEADER_SIZE) return null;
  if (!buffer.subarray(0, 4).equals(magic)) {
    return { error: 'bad_magic' };
  }
  if (buffer.readUInt8(4) !== VERSION) {
    return { error: 'unsupported_version' };
  }
  if (buffer.readUInt8(6) !== 0 || buffer.readUInt8(7) !== 0) {
    return { error: 'unsupported_flags' };
  }

  const type = buffer.readUInt8(5);
  if (!isKnownType(type)) {
    return { error: 'unsupported_type' };
  }
  const requestId = buffer.readUInt32BE(8);
  const payloadLength = buffer.readUInt32BE(12);
  if (payloadLength > MAX_PAYLOAD_BYTES) {
    return { error: 'payload_too_large' };
  }

  const total = FRAME_HEADER_SIZE + payloadLength;
  if (buffer.length < total) return null;
  return {
    type,
    requestId,
    payload: buffer.subarray(FRAME_HEADER_SIZE, total),
    total,
  };
}

function encodeResponsePayload(status, body = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const payload = Buffer.alloc(RESPONSE_PREFIX_SIZE + data.length);
  payload.writeUInt8(status, 0);
  payload.writeUInt8(0, 1);
  sha256(data).copy(payload, 2);
  data.copy(payload, RESPONSE_PREFIX_SIZE);
  return payload;
}

// Throws on a malformed payload or checksum mismatch, so callers cannot
// accidentally use corrupt data.
function parseResponsePayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < RESPONSE_PREFIX_SIZE) {
    throw new Error('response payload is too short');
  }
  const status = payload.readUInt8(0);
  const expected = payload.subarray(2, 34);
  const body = payload.subarray(RESPONSE_PREFIX_SIZE);
  const actual = sha256(body);
  if (!crypto.timingSafeEqual(expected, actual)) {
    throw new Error('response checksum mismatch');
  }
  return { status, body };
}

function encodePutPayload(path, body = Buffer.alloc(0)) {
  const pathBytes = Buffer.from(String(path || ''), 'utf8');
  if (pathBytes.length === 0 || pathBytes.length > 0xffff) {
    throw new Error('upload path is too large');
  }
  if (pathBytes.length > MAX_PATH_BYTES) {
    throw new Error('upload path is too large');
  }
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new Error('upload body is too large');
  }
  const payload = Buffer.alloc(2 + pathBytes.length + 32 + data.length);
  payload.writeUInt16BE(pathBytes.length, 0);
  pathBytes.copy(payload, 2);
  sha256(data).copy(payload, 2 + pathBytes.length);
  data.copy(payload, PUT_PREFIX_SIZE + pathBytes.length);
  return payload;
}

function parsePutPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < PUT_PREFIX_SIZE) {
    throw new Error('put payload is too short');
  }
  const pathLength = payload.readUInt16BE(0);
  const bodyOffset = 2 + pathLength + 32;
  if (pathLength === 0 || pathLength > MAX_PATH_BYTES) {
    throw new Error('invalid upload path length');
  }
  if (payload.length < bodyOffset) {
    throw new Error('put payload is truncated');
  }
  const expected = payload.subarray(2 + pathLength, bodyOffset);
  const body = payload.subarray(bodyOffset);
  if (body.length > MAX_UPLOAD_BYTES) {
    throw new Error('upload body is too large');
  }
  const actual = sha256(body);
  if (!crypto.timingSafeEqual(expected, actual)) {
    throw new Error('put checksum mismatch');
  }
  return {
    path: payload.subarray(2, 2 + pathLength).toString('utf8'),
    body,
  };
}

function jsonPayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function parseJsonPayload(payload) {
  return JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : payload);
}

function statusName(status) {
  switch (status) {
    case STATUS.OK:
      return 'ok';
    case STATUS.BAD_REQUEST:
      return 'bad_request';
    case STATUS.NOT_FOUND:
      return 'not_found';
    case STATUS.TOO_LARGE:
      return 'too_large';
    case STATUS.SERVER_ERROR:
      return 'server_error';
    default:
      return `status_${status}`;
  }
}

module.exports = {
  REQUEST_MAGIC,
  RESPONSE_MAGIC,
  VERSION,
  TYPE,
  STATUS,
  FRAME_HEADER_SIZE,
  MAX_PAYLOAD_BYTES,
  MAX_GET_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_CONTROL_BYTES,
  MAX_PATH_BYTES,
  RESPONSE_PREFIX_SIZE,
  PUT_PREFIX_SIZE,
  sha256,
  encodeFrame,
  parseFrame,
  encodeResponsePayload,
  parseResponsePayload,
  encodePutPayload,
  parsePutPayload,
  jsonPayload,
  parseJsonPayload,
  statusName,
  typeName,
};
