'use strict';

// Базовые ошибки, санитизация логов, валидация идентификаторов и атомарная запись на диск для Nox Link.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

const SCRIPT_CHECKS = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Armenian', /\p{Script=Armenian}/u],
  ['Georgian', /\p{Script=Georgian}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Japanese', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Thai', /\p{Script=Thai}/u],
];

function sleepSyncMs(ms) {
  const wait = Math.max(1, Math.trunc(ms));
  try {
    Atomics.wait(SLEEP_BUF, 0, 0, wait);
  } catch {
    const end = Date.now() + wait;
    while (Date.now() < end) { /* fallback */ }
  }
}

class LinkCryptoError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'LinkCryptoError';
    this.code = String(code || 'link_crypto_error');
    if (details && typeof details === 'object') {
      this.details = sanitizeForLog(details);
    }
  }
}

function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

function assertUuidV4(value, fieldName = 'deviceId') {
  if (!isUuidV4(value)) {
    throw new LinkCryptoError('invalid_device_id', `${fieldName} должен быть строгим UUIDv4 в нижнем регистре`);
  }
  return value;
}

function normalizeDeviceName(name) {
  if (typeof name !== 'string') {
    throw new LinkCryptoError('invalid_device_name', 'Имя устройства должно быть строкой');
  }
  const normalized = name.normalize('NFC').trim();
  if (!normalized || normalized.length > 64) {
    throw new LinkCryptoError('invalid_device_name', 'Имя устройства должно содержать от 1 до 64 символов');
  }
  // Запрещаем управляющие, невидимые, bidi/форматные символы (Cc, Cf, Cs, Co, Cn, Zl, Zp) и не-ASCII пробелы.
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new LinkCryptoError('invalid_device_name', 'Имя устройства содержит недопустимые управляющие или невидимые символы');
  }
  if (/[^\S ]/u.test(normalized)) {
    throw new LinkCryptoError('invalid_device_name', 'Имя устройства содержит недопустимые пробельные символы');
  }
  if (!/[\p{L}\p{N}]/u.test(normalized)) {
    throw new LinkCryptoError('invalid_device_name', 'Имя устройства должно содержать буквы или цифры');
  }
  if (/^\p{M}|\p{M}{3,}/u.test(normalized)) {
    throw new LinkCryptoError('invalid_device_name', 'Имя устройства содержит недопустимые комбинируемые знаки');
  }
  // Запрещаем смешение разных алфавитов внутри одного слова (защита от гомографов),
  // не мешая составным именам вроде "Ноутбук Lenovo".
  for (const token of normalized.split(/[ ._-]+/)) {
    if (!token) continue;
    let scriptsInToken = 0;
    for (const [, re] of SCRIPT_CHECKS) {
      if (re.test(token)) {
        scriptsInToken += 1;
        if (scriptsInToken > 1) {
          throw new LinkCryptoError('invalid_device_name', 'Имя устройства смешивает разные алфавиты в одном слове');
        }
      }
    }
  }
  return normalized;
}

function redactText(text) {
  let out = String(text ?? '');
  out = out.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  out = out.replace(/("(?:caKeyPem|leafKeyPem|caKeyEnc|leafKeyEnc|privateKey|privKey|keyPem|nonce|hostNonce|clientNonce|signature)"\s*:\s*")([^"]*)(")/gi, '$1[REDACTED]$3');
  return out;
}

function sanitizeForLog(value, depth = 0) {
  if (depth > 6) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return `[Buffer len=${value.length}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      code: value.code || undefined,
      message: redactText(value.message),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      if (/^(?:caKeyPem|leafKeyPem|caKeyEnc|leafKeyEnc|privateKey|privKey|keyPem|secret|token|nonce)$/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeForLog(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function parseSafeJson(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText, (key, val) => {
      if (DANGEROUS_KEYS.has(key)) return undefined;
      return val;
    });
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

function canonicalizePath(targetPath) {
  const abs = path.resolve(String(targetPath || ''));
  const pending = [];
  let cursor = abs;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    pending.unshift(path.basename(cursor));
    cursor = parent;
  }
  let base = cursor;
  try {
    base = typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(cursor)
      : fs.realpathSync(cursor);
  } catch { /* fallback to unresolved base */ }
  const joined = pending.length > 0 ? path.join(base, ...pending) : base;
  return process.platform === 'win32' ? joined.toLowerCase() : joined;
}

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    fs.writeFileSync(fd, content, { encoding: typeof content === 'string' ? 'utf8' : undefined });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        fs.renameSync(tmpPath, filePath);
        return;
      } catch (err) {
        if ((err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') && attempt < 7) {
          sleepSyncMs(5 + attempt * 5);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code !== 'ESRCH';
  }
}

function withFileLockSync(lockPath, fn, { timeoutMs = 3000, staleMs = 15_000 } = {}) {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + Math.max(50, timeoutMs);

  while (true) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
      fs.writeFileSync(fd, token, 'utf8');
      fs.closeSync(fd);
      fd = null;
      break;
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      if (err && err.code === 'EEXIST') {
        try {
          const st = fs.statSync(lockPath);
          const raw = fs.readFileSync(lockPath, 'utf8');
          const holderPid = Number.parseInt(raw.split(':')[0], 10);
          const staleByAge = (Date.now() - st.mtimeMs) > staleMs;
          const staleByDeadPid = Number.isInteger(holderPid) && holderPid > 0 && !isPidAlive(holderPid);
          if (staleByAge || staleByDeadPid) {
            try { fs.unlinkSync(lockPath); } catch { /* raced with another cleaner */ }
            continue;
          }
        } catch { /* lock vanished between open and stat */ }
        if (Date.now() >= deadline) {
          throw new LinkCryptoError('lock_timeout', 'Не удалось получить блокировку файла хранилища Nox Link');
        }
        sleepSyncMs(5);
        continue;
      }
      throw err;
    }
  }

  try {
    return fn();
  } finally {
    try {
      const current = fs.readFileSync(lockPath, 'utf8');
      if (current === token) {
        fs.unlinkSync(lockPath);
      }
    } catch { /* ignore */ }
  }
}

module.exports = {
  UUID_V4_RE,
  LinkCryptoError,
  isUuidV4,
  assertUuidV4,
  normalizeDeviceName,
  redactText,
  sanitizeForLog,
  parseSafeJson,
  sleepSyncMs,
  canonicalizePath,
  atomicWriteFileSync,
  withFileLockSync,
};
