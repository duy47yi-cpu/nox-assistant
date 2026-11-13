'use strict';

const crypto = require('node:crypto');

const VERSION = 'nox-bridge-2';
const MAX_FRAME_BYTES = 65536;
const MAX_TEXT_BYTES = 49152;
const MAX_TITLE_BYTES = 512;
const MAX_ORIGIN_BYTES = 512;
const DEFAULT_PAIRING_TTL_MS = 60000;
const MAX_PAIRING_TTL_MS = 300000;
const DEFAULT_SESSION_TTL_MS = 900000;
const MAX_SESSION_TTL_MS = 3600000;
const DEFAULT_READ_TIMEOUT_MS = 10000;
const MAX_READ_TIMEOUT_MS = 30000;

const random = () => crypto.randomBytes(32).toString('hex');
const validHex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const utf8Bytes = value => Buffer.byteLength(value, 'utf8');

function toKeyBuffer(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  if (!validHex(secret)) throw new TypeError('invalid secret');
  return Buffer.from(secret, 'hex');
}

function mac(secret, ...parts) {
  return crypto
    .createHmac('sha256', toKeyBuffer(secret))
    .update(JSON.stringify([VERSION, ...parts]))
    .digest('hex');
}

function equal(a, b) {
  return validHex(a) && validHex(b) && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function allowedOrigin(url) {
  if (typeof url !== 'string' || utf8Bytes(url) > MAX_ORIGIN_BYTES) return null;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === url ? parsed.origin : null;
  } catch {
    return null;
  }
}

module.exports = {
  VERSION,
  MAX_FRAME_BYTES,
  MAX_TEXT_BYTES,
  MAX_TITLE_BYTES,
  MAX_ORIGIN_BYTES,
  DEFAULT_PAIRING_TTL_MS,
  MAX_PAIRING_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  MAX_READ_TIMEOUT_MS,
  random,
  validHex,
  utf8Bytes,
  mac,
  equal,
  hasExactKeys,
  allowedOrigin,
};
