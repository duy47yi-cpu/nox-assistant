'use strict';

// Изолированное хранилище Stage 1 для Nox Link (С6): устройства аккаунта и авторизованные комнаты ретрансляции.
// Использует общую базу и аутентификацию apps/nox-server/store.js; открытые билеты в SQLite никогда не пишутся.
const crypto = require('crypto');
const { sha256 } = require('./store');
const { rateLimitIpKey } = require('./proxy');

const PAIR_TTL_MS = 120_000;
const SESSION_TTL_MS = 15_000;
const RELAY_WAIT_TIMEOUT_MS = 15_000;
const MAX_OPEN_ROOMS_PER_ACCOUNT = 3;
const MAX_DEVICES_PER_ACCOUNT = 20;
const MAX_TOTAL_DEVICES_PER_ACCOUNT = 60;
const MAX_DEVICE_CREATIONS_PER_WINDOW = 25;
const MAX_DEVICE_REVOCATIONS_PER_WINDOW = 25;
const DEVICE_OP_WINDOW_MS = 15 * 60 * 1000;
const REVOKED_DEVICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLOSED_ROOM_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_CLOSED_ROOMS = 5000;
const MAX_FAILED_ATTEMPTS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOM_ID_RE = /^[0-9a-f]{64}$/;
const FP256_RE = /^[0-9a-f]{64}$/i;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

class LinkError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

function isRoomId(value) {
  return typeof value === 'string' && ROOM_ID_RE.test(value);
}

function normalizeDeviceName(raw) {
  if (typeof raw !== 'string') throw new LinkError(400, 'bad_device_name', 'нужно имя устройства');
  const normalized = raw.normalize('NFC').trim();
  if (!normalized || CONTROL_CHARS_RE.test(normalized) || [...normalized].length > 64) {
    throw new LinkError(400, 'bad_device_name', 'имя устройства: от 1 до 64 символов без управляющих символов');
  }
  return normalized;
}

function normalizeFingerprint(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || !FP256_RE.test(raw)) {
    throw new LinkError(400, 'bad_fingerprint', 'отпечаток корневого сертификата должен быть 64-символьным SHA-256 hex');
  }
  return raw.toLowerCase();
}

function timingSafeEqualHex(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string' || aHex.length !== bHex.length || aHex.length === 0) {
    return false;
  }
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function formatDevice(row) {
  return {
    deviceId: row.device_id,
    deviceName: row.device_name,
    rootCaFp256: row.root_ca_fp256,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

class LinkStore {
  constructor(store, options = {}) {
    if (!store || !store.db || typeof store.accountByToken !== 'function') {
      throw new Error('LinkStore требует существующий экземпляр Store');
    }
    this.store = store;
    this.db = store.db;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.pairTtlMs = positiveInt(options.pairTtlMs, PAIR_TTL_MS);
    this.sessionTtlMs = positiveInt(options.sessionTtlMs, SESSION_TTL_MS);
    this.maxOpenRoomsPerAccount = positiveInt(options.maxOpenRoomsPerAccount, MAX_OPEN_ROOMS_PER_ACCOUNT);
    this.maxDevicesPerAccount = positiveInt(options.maxDevicesPerAccount, MAX_DEVICES_PER_ACCOUNT);
    this.maxTotalDevicesPerAccount = positiveInt(options.maxTotalDevicesPerAccount, MAX_TOTAL_DEVICES_PER_ACCOUNT);
    this.maxDeviceCreationsPerWindow = positiveInt(options.maxDeviceCreationsPerWindow, MAX_DEVICE_CREATIONS_PER_WINDOW);
    this.maxDeviceRevocationsPerWindow = positiveInt(options.maxDeviceRevocationsPerWindow, MAX_DEVICE_REVOCATIONS_PER_WINDOW);
    this.deviceOpWindowMs = positiveInt(options.deviceOpWindowMs, DEVICE_OP_WINDOW_MS);
    this.revokedDeviceRetentionMs = nonNegInt(options.revokedDeviceRetentionMs, REVOKED_DEVICE_RETENTION_MS);
    this.closedRoomRetentionMs = nonNegInt(options.closedRoomRetentionMs, CLOSED_ROOM_RETENTION_MS);
    this.maxClosedRooms = positiveInt(options.maxClosedRooms, MAX_CLOSED_ROOMS);
    this.maxFailedAttempts = positiveInt(options.maxFailedAttempts, MAX_FAILED_ATTEMPTS);
    this.failWindowMs = positiveInt(options.failWindowMs, FAIL_WINDOW_MS);
    this._fallbackTxDepth = 0;
    this._fallbackTxSeq = 0;
    this._migrate();
    this._recoverOnStart();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS link_devices (
        device_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        device_name TEXT NOT NULL,
        root_ca_fp256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER NULL
      );
      CREATE INDEX IF NOT EXISTS link_devices_account ON link_devices(account_id, revoked_at);

      CREATE TABLE IF NOT EXISTS link_rooms (
        room_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        purpose TEXT NOT NULL,
        host_device_id TEXT NOT NULL REFERENCES link_devices(device_id),
        client_device_id TEXT NOT NULL REFERENCES link_devices(device_id),
        host_ticket_hash TEXT NOT NULL,
        client_ticket_hash TEXT NOT NULL,
        host_consumed_at INTEGER NULL,
        client_consumed_at INTEGER NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        closed_at INTEGER NULL,
        close_reason TEXT NULL
      );
      CREATE INDEX IF NOT EXISTS link_rooms_account ON link_rooms(account_id, closed_at, expires_at);
      CREATE INDEX IF NOT EXISTS link_rooms_pair ON link_rooms(account_id, purpose, closed_at, host_device_id, client_device_id);
      CREATE INDEX IF NOT EXISTS link_rooms_closed_at ON link_rooms(closed_at);
    `);
  }

  _pruneClosedRooms(t = this.now()) {
    this.db.prepare(
      'DELETE FROM link_rooms WHERE closed_at IS NOT NULL AND closed_at <= ?',
    ).run(t - this.closedRoomRetentionMs);
    const { totalClosed } = this.db.prepare(
      'SELECT COUNT(*) AS totalClosed FROM link_rooms WHERE closed_at IS NOT NULL',
    ).get();
    if (totalClosed > this.maxClosedRooms) {
      const overflow = totalClosed - this.maxClosedRooms;
      this.db.prepare(
        'DELETE FROM link_rooms WHERE room_id IN (SELECT room_id FROM link_rooms WHERE closed_at IS NOT NULL ORDER BY closed_at ASC LIMIT ?)',
      ).run(overflow);
    }
  }

  _pruneExpiredRevokedDevices(accountId, t = this.now()) {
    this.db.prepare(`
      DELETE FROM link_devices
      WHERE account_id = ?
        AND revoked_at IS NOT NULL
        AND revoked_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM link_rooms r
          WHERE r.host_device_id = link_devices.device_id OR r.client_device_id = link_devices.device_id
        )
    `).run(accountId, t - this.revokedDeviceRetentionMs);
  }

  _recoverOnStart() {
    this._inTx(() => {
      const t = this.now();
      this.db.prepare(
        'UPDATE link_rooms SET closed_at = ?, close_reason = ? WHERE closed_at IS NULL AND expires_at <= ?',
      ).run(t, 'expired', t);
      // Все незакрытые комнаты прошлого процесса теряют SSE/ожидающих участников и не должны оставаться зомби после рестарта.
      this.db.prepare(
        'UPDATE link_rooms SET closed_at = ?, close_reason = ? WHERE closed_at IS NULL',
      ).run(t, 'server_restart');
      this._pruneClosedRooms(t);
    });
  }

  _inTx(fn) {
    if (typeof this.store._inTx === 'function') {
      return this.store._inTx(fn);
    }
    if (this._fallbackTxDepth > 0) {
      const savepoint = `nox_link_sp_${++this._fallbackTxSeq}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this._fallbackTxDepth += 1;
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (err) {
        try { this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch { /* уже откачена */ }
        try { this.db.exec(`RELEASE SAVEPOINT ${savepoint}`); } catch { /* уже снята */ }
        throw err;
      } finally {
        this._fallbackTxDepth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this._fallbackTxDepth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* уже откачена */ }
      throw err;
    } finally {
      this._fallbackTxDepth = 0;
    }
  }

  _assertAuthorizedInTx(accountId, tokenHash, t) {
    if (tokenHash && typeof this.store.isTokenActive === 'function') {
      if (!this.store.isTokenActive(tokenHash, t)) {
        throw new LinkError(401, 'unauthorized', 'нужно войти в аккаунт');
      }
      return;
    }
    const acc = this.db.prepare('SELECT disabled FROM accounts WHERE id = ?').get(accountId);
    if (!acc || acc.disabled) {
      throw new LinkError(401, 'unauthorized', 'нужно войти в аккаунт');
    }
  }

  _checkWindowLimit(key, max, perMs, t, code = 'too_many', message = 'слишком много неудачных попыток, попробуйте позже') {
    if (!this.store.tooMany(key, { max, perMs, now: t })) return;
    const row = this.db.prepare('SELECT MIN(at) AS oldest FROM attempts WHERE key = ? AND at >= ?')
      .get(key, t - perMs);
    const retryAfterMs = row && Number.isFinite(row.oldest)
      ? Math.max(1000, row.oldest + perMs - t)
      : perMs;
    throw new LinkError(429, code, message, { retryAfterMs });
  }

  checkRateLimit(key, t = this.now()) {
    this._checkWindowLimit(key, this.maxFailedAttempts, this.failWindowMs, t);
  }

  checkRateLimitWithMax(key, max, t = this.now()) {
    this._checkWindowLimit(key, max, this.failWindowMs, t);
  }

  recordFailure({ anonIp, ip, accountId, now: t = this.now() }) {
    if (anonIp) this.store.recordAttempt(`link-fail:anon:ip:${rateLimitIpKey(anonIp)}`, t);
    if (ip) this.store.recordAttempt(`link-fail:ip:${rateLimitIpKey(ip)}`, t);
    if (accountId) this.store.recordAttempt(`link-fail:acc:${accountId}`, t);
  }

  sweepExpired(t = this.now(), activeBridgedSessionRoomIds = new Set()) {
    return this._inTx(() => {
      const candidates = this.db.prepare(
        'SELECT room_id, purpose FROM link_rooms WHERE closed_at IS NULL AND expires_at <= ?',
      ).all(t);
      const expiredIds = [];
      for (const row of candidates) {
        if (row.purpose === 'session' && activeBridgedSessionRoomIds.has(row.room_id)) continue;
        const res = this.db.prepare(
          'UPDATE link_rooms SET closed_at = ?, close_reason = ? WHERE room_id = ? AND closed_at IS NULL',
        ).run(t, 'expired', row.room_id);
        if (res.changes > 0) expiredIds.push(row.room_id);
      }
      this._pruneClosedRooms(t);
      return expiredIds;
    });
  }

  registerDevice({ accountId, tokenHash = null, deviceId, deviceName, rootCaFp256, now: t = this.now() }) {
    if (!isUuidV4(deviceId)) {
      throw new LinkError(400, 'bad_device_id', 'deviceId должен быть строгим UUIDv4 в нижнем регистре');
    }
    const cleanName = normalizeDeviceName(deviceName);
    const fp = normalizeFingerprint(rootCaFp256);

    return this._inTx(() => {
      this._assertAuthorizedInTx(accountId, tokenHash, t);
      const existing = this.db.prepare('SELECT * FROM link_devices WHERE device_id = ?').get(deviceId);
      if (existing) {
        if (existing.account_id !== accountId) {
          throw new LinkError(403, 'device_forbidden', 'устройство недоступно для этого аккаунта');
        }
        if (existing.revoked_at !== null) {
          throw new LinkError(403, 'device_revoked', 'устройство отозвано');
        }
        if (existing.root_ca_fp256 && fp && existing.root_ca_fp256 !== fp) {
          throw new LinkError(409, 'fingerprint_mismatch', 'отпечаток сертификата устройства не совпадает с зарегистрированным');
        }
        const nextFp = existing.root_ca_fp256 || fp;
        this.db.prepare(
          'UPDATE link_devices SET device_name = ?, root_ca_fp256 = ?, last_seen_at = ? WHERE device_id = ?',
        ).run(cleanName, nextFp, t, deviceId);
        return {
          created: false,
          device: formatDevice(this.db.prepare('SELECT * FROM link_devices WHERE device_id = ?').get(deviceId)),
        };
      }

      const { count } = this.db.prepare(
        'SELECT COUNT(*) AS count FROM link_devices WHERE account_id = ? AND revoked_at IS NULL',
      ).get(accountId);
      if (count >= this.maxDevicesPerAccount) {
        throw new LinkError(409, 'device_limit_reached', 'достигнут предел активных устройств аккаунта');
      }

      this._pruneClosedRooms(t);
      this._pruneExpiredRevokedDevices(accountId, t);

      const { totalCount } = this.db.prepare(
        'SELECT COUNT(*) AS totalCount FROM link_devices WHERE account_id = ?',
      ).get(accountId);
      if (totalCount >= this.maxTotalDevicesPerAccount) {
        throw new LinkError(409, 'device_history_limit_reached', 'достигнут общий предел устройств аккаунта');
      }

      this._checkWindowLimit(
        `link-dev-create:${accountId}`,
        this.maxDeviceCreationsPerWindow,
        this.deviceOpWindowMs,
        t,
        'too_many_device_ops',
        'слишком много регистраций устройств, попробуйте позже',
      );
      this.store.recordAttempt(`link-dev-create:${accountId}`, t);

      this.db.prepare(
        'INSERT INTO link_devices (device_id, account_id, device_name, root_ca_fp256, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      ).run(deviceId, accountId, cleanName, fp, t, t);
      return {
        created: true,
        device: formatDevice(this.db.prepare('SELECT * FROM link_devices WHERE device_id = ?').get(deviceId)),
      };
    });
  }

  listDevices(accountId) {
    return this.db.prepare('SELECT * FROM link_devices WHERE account_id = ? ORDER BY created_at ASC')
      .all(accountId)
      .map(formatDevice);
  }

  isDeviceActive(accountId, deviceId) {
    if (!isUuidV4(deviceId)) return false;
    const row = this.db.prepare(
      'SELECT 1 FROM link_devices WHERE device_id = ? AND account_id = ? AND revoked_at IS NULL',
    ).get(deviceId, accountId);
    return Boolean(row);
  }

  requireActiveDevice(accountId, deviceId, { notFoundStatus = 403, notFoundCode = 'device_forbidden', notFoundMessage = 'устройство не зарегистрировано для этого аккаунта' } = {}) {
    if (!isUuidV4(deviceId)) {
      throw new LinkError(400, 'bad_device_id', 'неверный идентификатор устройства');
    }
    const row = this.db.prepare('SELECT * FROM link_devices WHERE device_id = ?').get(deviceId);
    if (!row || row.account_id !== accountId) {
      throw new LinkError(notFoundStatus, notFoundCode, notFoundMessage);
    }
    if (row.revoked_at !== null) {
      throw new LinkError(403, 'device_revoked', 'устройство отозвано');
    }
    return formatDevice(row);
  }

  touchDevice(deviceId, t = this.now()) {
    this._inTx(() => {
      this.db.prepare('UPDATE link_devices SET last_seen_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(t, deviceId);
    });
  }

  revokeDevice({ accountId, tokenHash = null, deviceId, now: t = this.now() }) {
    if (!isUuidV4(deviceId)) {
      throw new LinkError(400, 'bad_device_id', 'неверный идентификатор устройства');
    }
    return this._inTx(() => {
      this._assertAuthorizedInTx(accountId, tokenHash, t);
      const row = this.db.prepare('SELECT * FROM link_devices WHERE device_id = ?').get(deviceId);
      if (!row || row.account_id !== accountId) {
        throw new LinkError(404, 'not_found', 'устройство не найдено');
      }
      this._checkWindowLimit(
        `link-dev-revoke:${accountId}`,
        this.maxDeviceRevocationsPerWindow,
        this.deviceOpWindowMs,
        t,
        'too_many_device_ops',
        'слишком много отзывов устройств, попробуйте позже',
      );
      this.store.recordAttempt(`link-dev-revoke:${accountId}`, t);
      const newlyRevoked = row.revoked_at === null;
      if (newlyRevoked) {
        this.db.prepare('UPDATE link_devices SET revoked_at = ? WHERE device_id = ?').run(t, deviceId);
      }
      const openRooms = newlyRevoked
        ? this.db.prepare(
            'SELECT room_id FROM link_rooms WHERE account_id = ? AND closed_at IS NULL AND (host_device_id = ? OR client_device_id = ?)',
          ).all(accountId, deviceId, deviceId)
        : [];
      if (openRooms.length > 0) {
        this.db.prepare(
          'UPDATE link_rooms SET closed_at = ?, close_reason = ? WHERE account_id = ? AND closed_at IS NULL AND (host_device_id = ? OR client_device_id = ?)',
        ).run(t, 'device_revoked', accountId, deviceId, deviceId);
      }
      const updated = this.db.prepare('SELECT * FROM link_devices WHERE device_id = ?').get(deviceId);
      return {
        newlyRevoked,
        device: formatDevice(updated),
        closedRoomIds: openRooms.map((r) => r.room_id),
      };
    });
  }

  createRoom({ accountId, tokenHash = null, purpose, hostDeviceId, clientDeviceId, now: t = this.now(), activeBridgedSessionRoomIds = new Set() }) {
    if (purpose !== 'pair' && purpose !== 'session') {
      throw new LinkError(400, 'bad_purpose', 'неверный тип комнаты');
    }
    if (!isUuidV4(hostDeviceId) || !isUuidV4(clientDeviceId)) {
      throw new LinkError(400, 'bad_device_id', 'неверный идентификатор устройства');
    }
    if (hostDeviceId === clientDeviceId) {
      throw new LinkError(400, 'same_device', 'нельзя создать комнату с тем же устройством');
    }

    return this._inTx(() => {
      this._assertAuthorizedInTx(accountId, tokenHash, t);
      const expiredRoomIds = this.sweepExpired(t, activeBridgedSessionRoomIds);
      const host = this.requireActiveDevice(accountId, hostDeviceId);
      const client = this.requireActiveDevice(accountId, clientDeviceId, {
        notFoundStatus: 404,
        notFoundCode: 'device_not_found',
        notFoundMessage: 'целевое устройство не найдено',
      });

      if (purpose === 'pair') {
        const existingPair = this.db.prepare(`
          SELECT room_id FROM link_rooms
          WHERE account_id = ? AND purpose = 'pair' AND closed_at IS NULL AND expires_at > ?
            AND ((host_device_id = ? AND client_device_id = ?) OR (host_device_id = ? AND client_device_id = ?))
          LIMIT 1
        `).get(accountId, t, hostDeviceId, clientDeviceId, clientDeviceId, hostDeviceId);
        if (existingPair) {
          throw new LinkError(409, 'pairing_already_active', 'для этой пары устройств уже открыто сопряжение');
        }
      }

      const { openCount } = this.db.prepare(
        'SELECT COUNT(*) AS openCount FROM link_rooms WHERE account_id = ? AND closed_at IS NULL',
      ).get(accountId);
      if (openCount >= this.maxOpenRoomsPerAccount) {
        const soonest = this.db.prepare(`
          SELECT MIN(expires_at) AS next_exp FROM link_rooms
          WHERE account_id = ? AND closed_at IS NULL AND (host_consumed_at IS NULL OR client_consumed_at IS NULL)
        `).get(accountId);
        const retryAfterMs = soonest && Number.isFinite(soonest.next_exp)
          ? Math.max(1000, soonest.next_exp - t)
          : 5000;
        throw new LinkError(429, 'too_many_rooms', 'слишком много открытых комнат для аккаунта', { retryAfterMs });
      }

      const roomId = crypto.randomBytes(32).toString('hex');
      const hostTicket = crypto.randomBytes(32).toString('base64url');
      const clientTicket = crypto.randomBytes(32).toString('base64url');
      const ttlMs = purpose === 'pair' ? this.pairTtlMs : this.sessionTtlMs;
      const expiresAt = t + ttlMs;

      this.db.prepare(`
        INSERT INTO link_rooms (
          room_id, account_id, purpose, host_device_id, client_device_id,
          host_ticket_hash, client_ticket_hash, host_consumed_at, client_consumed_at,
          created_at, expires_at, closed_at, close_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)
      `).run(roomId, accountId, purpose, hostDeviceId, clientDeviceId, sha256(hostTicket), sha256(clientTicket), t, expiresAt);

      this.db.prepare('UPDATE link_devices SET last_seen_at = ? WHERE device_id = ?').run(t, hostDeviceId);

      return {
        roomId,
        purpose,
        accountId,
        hostDeviceId,
        hostDeviceName: host.deviceName,
        clientDeviceId,
        clientDeviceName: client.deviceName,
        hostTicket,
        clientTicket,
        createdAt: t,
        expiresAt,
        expiredRoomIds,
      };
    });
  }

  admitToRoom({ accountId, deviceId, roomId, joinTicket, now: t = this.now() }) {
    if (!isUuidV4(deviceId)) {
      throw new LinkError(400, 'bad_device_id', 'неверный идентификатор устройства');
    }
    if (!isRoomId(roomId)) {
      throw new LinkError(400, 'bad_room_id', 'неверный идентификатор комнаты');
    }
    if (typeof joinTicket !== 'string' || joinTicket.length < 16 || joinTicket.length > 256) {
      throw new LinkError(400, 'bad_ticket', 'неверный формат билета подключения');
    }

    const result = this._inTx(() => {
      this.requireActiveDevice(accountId, deviceId);

      const room = this.db.prepare('SELECT * FROM link_rooms WHERE room_id = ?').get(roomId);
      if (!room) {
        throw new LinkError(404, 'room_not_found', 'комната не найдена');
      }
      if (room.account_id !== accountId) {
        throw new LinkError(403, 'forbidden', 'нет доступа к комнате');
      }

      const hostDev = this.db.prepare('SELECT revoked_at FROM link_devices WHERE device_id = ?').get(room.host_device_id);
      const clientDev = this.db.prepare('SELECT revoked_at FROM link_devices WHERE device_id = ?').get(room.client_device_id);
      if (!hostDev || !clientDev || hostDev.revoked_at !== null || clientDev.revoked_at !== null) {
        if (room.closed_at === null) {
          this.db.prepare('UPDATE link_rooms SET closed_at = ?, close_reason = ? WHERE room_id = ? AND closed_at IS NULL').run(t, 'device_revoked', roomId);
        }
        return { __denied: { status: 403, code: 'device_revoked', message: 'устройство комнаты отозвано' } };
      }

      let role;
      let expectedHash;
      let consumedAt;
      if (deviceId === room.host_device_id) {
        role = 'host';
        expectedHash = room.host_ticket_hash;
        consumedAt = room.host_consumed_at;
      } else if (deviceId === room.client_device_id) {
        role = 'client';
        expectedHash = room.client_ticket_hash;
        consumedAt = room.client_consumed_at;
      } else {
        throw new LinkError(403, 'device_not_in_room', 'устройство не относится к этой комнате');
      }

      if (!timingSafeEqualHex(sha256(joinTicket), expectedHash)) {
        throw new LinkError(403, 'invalid_ticket', 'неверный билет подключения');
      }
      if (room.expires_at <= t || room.close_reason === 'expired') {
        if (room.closed_at === null) {
          this.db.prepare('UPDATE link_rooms SET closed_at = ?, close_reason = ? WHERE room_id = ? AND closed_at IS NULL').run(t, 'expired', roomId);
        }
        return { __denied: { status: 403, code: 'ticket_expired', message: 'срок действия комнаты и билета истёк' } };
      }
      if (consumedAt !== null) {
        throw new LinkError(409, 'ticket_already_used', 'билет подключения уже использован');
      }
      if (room.closed_at !== null) {
        throw new LinkError(409, 'room_closed', 'комната уже закрыта');
      }

      const col = role === 'host' ? 'host_consumed_at' : 'client_consumed_at';
      const updated = this.db.prepare(
        `UPDATE link_rooms SET ${col} = ? WHERE room_id = ? AND ${col} IS NULL AND closed_at IS NULL`,
      ).run(t, roomId);
      if (updated.changes !== 1) {
        throw new LinkError(409, 'room_full', 'слот комнаты недоступен');
      }

      this.db.prepare('UPDATE link_devices SET last_seen_at = ? WHERE device_id = ?').run(t, deviceId);

      return {
        roomId: room.room_id,
        accountId: room.account_id,
        purpose: room.purpose,
        role,
        deviceId,
        hostDeviceId: room.host_device_id,
        clientDeviceId: room.client_device_id,
        expiresAt: room.expires_at,
      };
    });
    if (result && result.__denied) {
      throw new LinkError(result.__denied.status, result.__denied.code, result.__denied.message);
    }
    return result;
  }

  closeRoom(roomId, reason, t = this.now()) {
    return this._inTx(() =>
      this.db.prepare(
        'UPDATE link_rooms SET closed_at = ?, close_reason = ? WHERE room_id = ? AND closed_at IS NULL',
      ).run(t, String(reason || 'closed'), roomId).changes > 0,
    );
  }

  closeAccountRooms(accountId, reason = 'account_disabled', t = this.now()) {
    return this._inTx(() => {
      const openRooms = this.db.prepare(
        'SELECT room_id FROM link_rooms WHERE account_id = ? AND closed_at IS NULL',
      ).all(accountId);
      if (openRooms.length > 0) {
        this.db.prepare(
          'UPDATE link_rooms SET closed_at = ?, close_reason = ? WHERE account_id = ? AND closed_at IS NULL',
        ).run(t, String(reason || 'account_disabled'), accountId);
      }
      return openRooms.map((r) => r.room_id);
    });
  }
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

module.exports = {
  LinkStore,
  LinkError,
  isUuidV4,
  isRoomId,
  normalizeDeviceName,
  normalizeFingerprint,
  PAIR_TTL_MS,
  SESSION_TTL_MS,
  RELAY_WAIT_TIMEOUT_MS,
  MAX_OPEN_ROOMS_PER_ACCOUNT,
  MAX_DEVICES_PER_ACCOUNT,
  MAX_TOTAL_DEVICES_PER_ACCOUNT,
  MAX_DEVICE_CREATIONS_PER_WINDOW,
  MAX_DEVICE_REVOCATIONS_PER_WINDOW,
  DEVICE_OP_WINDOW_MS,
  REVOKED_DEVICE_RETENTION_MS,
  CLOSED_ROOM_RETENTION_MS,
  MAX_CLOSED_ROOMS,
  MAX_FAILED_ATTEMPTS,
  FAIL_WINDOW_MS,
};
