'use strict';

const crypto = require('crypto');

// Custom binary protocol used by the bundle sync transport.
//
// Request (one per TCP connection):
//   magic "HBT1" | version u8 | opcode u8 | tokenLen u16 | pathLen u32 |
//   token (UTF-8) | path (UTF-8)
//
// The token field is kept only for wire compatibility with older clients and
// is ignored by the server; this is a development-only transport with no
// authentication. New clients send tokenLen = 0.
//
// Response:
//   magic "HBR1" | version u8 | status u8 | reserved u16 | bodyLen u64 |
//   sha256(body) 32 bytes | body
//
// The response checksum lets the client reject a truncated or corrupted
// latest.json/manifest before it is parsed. Zip/patch files are also checked
// against the hashes already declared in latest.json/manifest.json.

const REQUEST_MAGIC = Buffer.from('HBT1');
const RESPONSE_MAGIC = Buffer.from('HBR1');
const VERSION = 1;
const OP_GET = 1;

const STATUS = Object.freeze({
  OK: 0,
  BAD_REQUEST: 1,
  UNAUTHORIZED: 2,
  NOT_FOUND: 3,
  TOO_LARGE: 4,
  SERVER_ERROR: 5,
});

const REQUEST_HEADER_SIZE = 12;
const RESPONSE_HEADER_SIZE = 48;
// Legacy request field: accepted for old clients, never checked by the server.
const MAX_TOKEN_BYTES = 4096;
const MAX_PATH_BYTES = 4096;
const MAX_REQUEST_BYTES = REQUEST_HEADER_SIZE + MAX_TOKEN_BYTES + MAX_PATH_BYTES;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function encodeRequest({ token = '', path, opcode = OP_GET } = {}) {
  const tokenBytes = Buffer.from(String(token), 'utf8');
  const pathBytes = Buffer.from(String(path || ''), 'utf8');
  if (tokenBytes.length > MAX_TOKEN_BYTES) {
    throw new Error('sync token is too large');
  }
  if (pathBytes.length > MAX_PATH_BYTES) {
    throw new Error('request path is too large');
  }

  const header = Buffer.alloc(REQUEST_HEADER_SIZE);
  REQUEST_MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(opcode, 5);
  header.writeUInt16BE(tokenBytes.length, 6);
  header.writeUInt32BE(pathBytes.length, 8);
  return Buffer.concat([header, tokenBytes, pathBytes]);
}

// Returns null while the header/body is incomplete. Returns { error } for a
// complete but invalid frame, otherwise { opcode, token, path, total }.
function parseRequest(buffer) {
  if (buffer.length < REQUEST_HEADER_SIZE) return null;
  if (!buffer.subarray(0, 4).equals(REQUEST_MAGIC)) {
    return { error: 'bad_magic' };
  }
  if (buffer.readUInt8(4) !== VERSION) {
    return { error: 'unsupported_version' };
  }
  const opcode = buffer.readUInt8(5);
  const tokenLength = buffer.readUInt16BE(6);
  const pathLength = buffer.readUInt32BE(8);
  if (tokenLength > MAX_TOKEN_BYTES || pathLength > MAX_PATH_BYTES) {
    return { error: 'request_too_large' };
  }

  const total = REQUEST_HEADER_SIZE + tokenLength + pathLength;
  if (buffer.length < total) return null;
  if (buffer.length > total) return { error: 'trailing_bytes' };

  return {
    opcode,
    token: buffer
      .subarray(REQUEST_HEADER_SIZE, REQUEST_HEADER_SIZE + tokenLength)
      .toString('utf8'),
    path: buffer
      .subarray(REQUEST_HEADER_SIZE + tokenLength, total)
      .toString('utf8'),
    total,
  };
}

function encodeResponse(status, body = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const header = Buffer.alloc(RESPONSE_HEADER_SIZE);
  RESPONSE_MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(status, 5);
  header.writeUInt16BE(0, 6);
  header.writeBigUInt64BE(BigInt(payload.length), 8);
  sha256(payload).copy(header, 16);
  return Buffer.concat([header, payload]);
}

// Returns null while the response is incomplete. Throws on a malformed frame
// or a checksum mismatch, so callers cannot accidentally parse corrupt data.
function parseResponse(buffer) {
  if (buffer.length < RESPONSE_HEADER_SIZE) return null;
  if (!buffer.subarray(0, 4).equals(RESPONSE_MAGIC)) {
    throw new Error('bad response magic');
  }
  if (buffer.readUInt8(4) !== VERSION) {
    throw new Error('unsupported response version');
  }

  const status = buffer.readUInt8(5);
  const bodyLength = Number(buffer.readBigUInt64BE(8));
  if (!Number.isSafeInteger(bodyLength) || bodyLength < 0) {
    throw new Error('invalid response length');
  }

  const total = RESPONSE_HEADER_SIZE + bodyLength;
  if (buffer.length < total) return null;
  if (buffer.length > total) throw new Error('trailing response bytes');

  const body = buffer.subarray(RESPONSE_HEADER_SIZE, total);
  const expected = buffer.subarray(16, 48);
  const actual = sha256(body);
  if (!crypto.timingSafeEqual(expected, actual)) {
    throw new Error('response checksum mismatch');
  }
  return { status, body };
}

function statusName(status) {
  switch (status) {
    case STATUS.OK:
      return 'ok';
    case STATUS.BAD_REQUEST:
      return 'bad_request';
    case STATUS.UNAUTHORIZED:
      return 'unauthorized';
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
  OP_GET,
  STATUS,
  REQUEST_HEADER_SIZE,
  RESPONSE_HEADER_SIZE,
  MAX_TOKEN_BYTES,
  MAX_PATH_BYTES,
  MAX_REQUEST_BYTES,
  sha256,
  encodeRequest,
  parseRequest,
  encodeResponse,
  parseResponse,
  statusName,
};
