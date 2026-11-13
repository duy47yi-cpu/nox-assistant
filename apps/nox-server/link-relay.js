'use strict';

// Изолированный сервис и маршрутизатор Stage 1 для Nox Link (С6):
// регистрация тестовых устройств, комнаты сопряжения и сеансов, одноразовые билеты, SSE/pending и слепой Upgrade-ретранслятор.
// Использует существующую аутентификацию и базу Store; криптография, сертификаты и удалённый Agent.run сюда не входят.
const http = require('http');
const crypto = require('crypto');
const { Store } = require('./store');
const { createProxyResolver } = require('./proxy');
const {
  LinkStore,
  LinkError,
  isUuidV4,
  RELAY_WAIT_TIMEOUT_MS,
} = require('./link-store');

const MAX_LINK_BODY = 4096;
const MAX_PREPIPE_BYTES = 64 * 1024;
const SSE_HEARTBEAT_MS = 25_000;
const REVOKED_EVENT_TTL_MS = 5 * 60 * 1000;
const MAX_SSE_PER_DEVICE = 2;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SSE_BUFFER_BYTES = 64 * 1024;
const DEFAULT_SSE_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RELAY_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_RELAY_DRAIN_TIMEOUT_MS = 15_000;
const DEFAULT_RELAY_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_HALF_OPEN_GRACE_MS = 500;
const MAX_TIMEOUT_MS = 2_147_483_647;
const BEARER_TOKEN_FORMAT_RE = /^nox_[A-Za-z0-9_-]{8,128}$/;

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  499: 'Client Closed Request',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const protectedSockets = new WeakSet();

function protectSocket(socket) {
  if (!socket || typeof socket.on !== 'function' || protectedSockets.has(socket)) return;
  protectedSockets.add(socket);
  socket.on('error', () => {});
}

function safeDestroy(socket) {
  protectSocket(socket);
  if (socket && !socket.destroyed && typeof socket.destroy === 'function') {
    try { socket.destroy(); } catch { /* ignore */ }
  }
}

function isSocketUsable(socket) {
  return Boolean(
    socket
    && !socket.destroyed
    && socket.readable !== false
    && !socket.readableEnded
    && socket.writable !== false
    && !socket.writableEnded
    && !socket.writableFinished,
  );
}

function scheduleBoundedTimer(delayMs, fn) {
  if (!Number.isFinite(delayMs)) return { clear() {} };
  let timer = null;
  let cancelled = false;
  const arm = (remaining) => {
    if (cancelled) return;
    const step = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(remaining)));
    timer = setTimeout(() => {
      if (cancelled) return;
      const left = remaining - step;
      if (left > 0) arm(left);
      else fn();
    }, step);
    if (typeof timer.unref === 'function') timer.unref();
  };
  arm(delayMs);
  return {
    clear() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    const val = String(secret || '');
    if (val.length >= 6) out = out.split(val).join('***');
  }
  return out
    .replace(/nox_[A-Za-z0-9_-]{8,}/g, 'nox_***')
    .replace(/((?:Bearer|Basic)\s+)\S+/gi, '$1***')
    .replace(/(x-nox-join-ticket\s*[:=]\s*)[^\s,;'"}\]]+/gi, '$1***')
    .replace(/("(?:hostTicket|clientTicket|joinTicket|ticket|token|accessToken|refreshToken|password|pass|secret|adminKey|authorization)"\s*:\s*")([^"]*)(")/gi, '$1***$3')
    .replace(/(\b(?:hostTicket|clientTicket|joinTicket|ticket|token|password|secret|adminKey)\s*[=:]\s*)([^\s&;,'"\n\r]+)/gi, '$1***')
    .replace(/([?&](?:token|ticket|joinTicket|hostTicket|clientTicket|key|secret|password)=)([^&#\s]+)/gi, '$1***')
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***');
}

function sendJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function rejectUpgrade(socket, status, code, message, extraHeaders = {}) {
  if (!socket || socket.destroyed) return;
  protectSocket(socket);
  const body = JSON.stringify({ error: { code, message } });
  const reason = STATUS_TEXT[status] || 'Error';
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    'X-Content-Type-Options: nosniff',
    'Connection: close',
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
    '',
    body,
  ];
  try {
    socket.end(lines.join('\r\n'));
    const timer = setTimeout(() => {
      safeDestroy(socket);
    }, 200);
    if (typeof timer.unref === 'function') timer.unref();
    socket.once('close', () => clearTimeout(timer));
  } catch {
    safeDestroy(socket);
  }
}

function readBody(req, max, timeoutMs = DEFAULT_BODY_TIMEOUT_MS, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new LinkError(503, 'server_closing', 'сервер останавливается'));
      return;
    }
    if (req.aborted || req.destroyed) {
      reject(new LinkError(499, 'request_aborted', 'запрос прерван клиентом'));
      return;
    }
    const parts = [];
    let size = 0;
    let settled = false;
    let timer = null;

    const onSignalAbort = () => {
      fail(new LinkError(503, 'server_closing', 'сервер останавливается'));
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onSignalAbort);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('close', onClose);
      req.off('error', onError);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > max) {
        if (typeof req.pause === 'function') req.pause();
        fail(new LinkError(413, 'too_large', 'запрос слишком большой'));
        return;
      }
      parts.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(parts));
    };

    const onAborted = () => {
      fail(new LinkError(499, 'request_aborted', 'запрос прерван клиентом'));
    };

    const onClose = () => {
      if (!req.complete) {
        fail(new LinkError(499, 'request_aborted', 'соединение прервано до завершения запроса'));
      }
    };

    const onError = (err) => {
      if (err && (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'EPIPE')) {
        fail(new LinkError(499, 'request_aborted', 'соединение прервано'));
        return;
      }
      fail(err);
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (typeof req.pause === 'function') req.pause();
        fail(new LinkError(408, 'request_timeout', 'превышено время чтения тела запроса'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    if (signal) signal.addEventListener('abort', onSignalAbort, { once: true });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('close', onClose);
    req.on('error', onError);
  });
}

async function readJson(req, max, timeoutMs = DEFAULT_BODY_TIMEOUT_MS, signal = null) {
  const raw = await readBody(req, max, timeoutMs, signal);
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('не объект');
    return value;
  } catch {
    throw new LinkError(400, 'bad_json', 'тело запроса не JSON-объект');
  }
}

function parsePathname(rawUrl) {
  try {
    return new URL(rawUrl || '/', 'http://x').pathname;
  } catch {
    throw new LinkError(400, 'bad_request', 'неверный адрес');
  }
}

function retryAfterHeaders(err) {
  const ms = err && err.extra && err.extra.retryAfterMs;
  if (!Number.isFinite(ms) || ms <= 0) return {};
  return { 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))) };
}

function nonNegInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function posInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function createLinkService(config) {
  const {
    store,
    now = () => Date.now(),
    trustProxy = false,
    trustedProxies,
    relayWaitTimeoutMs = RELAY_WAIT_TIMEOUT_MS,
    relayIdleTimeoutMs = DEFAULT_RELAY_IDLE_TIMEOUT_MS,
    relayDrainTimeoutMs = DEFAULT_RELAY_DRAIN_TIMEOUT_MS,
    maxRelayBufferBytes = DEFAULT_MAX_RELAY_BUFFER_BYTES,
    halfOpenGraceMs = DEFAULT_HALF_OPEN_GRACE_MS,
    sseHeartbeatMs = SSE_HEARTBEAT_MS,
    maxSsePerDevice = MAX_SSE_PER_DEVICE,
    maxSseBufferBytes = DEFAULT_MAX_SSE_BUFFER_BYTES,
    sseDrainTimeoutMs = DEFAULT_SSE_DRAIN_TIMEOUT_MS,
    bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS,
    revokedEventTtlMs = REVOKED_EVENT_TTL_MS,
    pairTtlMs,
    sessionTtlMs,
    maxOpenRoomsPerAccount,
    maxDevicesPerAccount,
    maxTotalDevicesPerAccount,
    maxDeviceCreationsPerWindow,
    maxDeviceRevocationsPerWindow,
    deviceOpWindowMs,
    revokedDeviceRetentionMs,
    closedRoomRetentionMs,
    maxClosedRooms,
    maxFailedAttempts,
    failWindowMs,
  } = config || {};

  const linkStore = new LinkStore(store, {
    now,
    pairTtlMs,
    sessionTtlMs,
    maxOpenRoomsPerAccount,
    maxDevicesPerAccount,
    maxTotalDevicesPerAccount,
    maxDeviceCreationsPerWindow,
    maxDeviceRevocationsPerWindow,
    deviceOpWindowMs,
    revokedDeviceRetentionMs,
    closedRoomRetentionMs,
    maxClosedRooms,
    maxFailedAttempts,
    failWindowMs,
  });

  const proxy = createProxyResolver({ trustProxy, trustedProxies });
  const effectiveMaxSsePerDevice = posInt(maxSsePerDevice, MAX_SSE_PER_DEVICE);
  const effectiveMaxSseBufferBytes = posInt(maxSseBufferBytes, DEFAULT_MAX_SSE_BUFFER_BYTES);
  const effectiveSseDrainTimeoutMs = posInt(sseDrainTimeoutMs, DEFAULT_SSE_DRAIN_TIMEOUT_MS);
  const effectiveMaxRelayBufferBytes = posInt(maxRelayBufferBytes, DEFAULT_MAX_RELAY_BUFFER_BYTES);
  const effectiveRelayDrainTimeoutMs = posInt(relayDrainTimeoutMs, DEFAULT_RELAY_DRAIN_TIMEOUT_MS);
  const effectiveRelayIdleTimeoutMs = nonNegInt(relayIdleTimeoutMs, DEFAULT_RELAY_IDLE_TIMEOUT_MS);
  const effectiveHalfOpenGraceMs = nonNegInt(halfOpenGraceMs, DEFAULT_HALF_OPEN_GRACE_MS);
  const effectiveBodyTimeoutMs = nonNegInt(bodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS);

  const activeRooms = new Map(); // roomId -> roomState
  const bridgedSessionRoomIds = new Set(); // roomId для активных сеансов
  const sseByDevice = new Map(); // `${accountId}:${deviceId}` -> Set<entry>
  const pendingByDevice = new Map(); // `${accountId}:${deviceId}` -> Map<eventId, item>
  const activeHttpRequests = new Set();
  const closeAbortController = new AbortController();
  let closed = false;

  const deviceKey = (accountId, deviceId) => `${accountId}:${deviceId}`;
  const clientIp = (req) => proxy.clientIp(req);
  const bearer = (req) => (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '') || [])[1] || '';

  const logError = (err, extraSecrets = []) => console.error(redact(`nox-link: ${err && err.message ? err.message : err}`, extraSecrets));

  function tryCloseRoomDb(roomId, reason) {
    try {
      linkStore.closeRoom(roomId, reason, now());
    } catch {
      // БД могла быть уже закрыта при завершении работы сервера.
    }
  }

  function removePendingByRoom(roomId) {
    for (const [key, map] of pendingByDevice.entries()) {
      for (const [id, item] of map.entries()) {
        if (item.roomId === roomId) map.delete(id);
      }
      if (map.size === 0) pendingByDevice.delete(key);
    }
  }

  function removePendingForDevice(accountId, deviceId) {
    pendingByDevice.delete(deviceKey(accountId, deviceId));
    for (const [key, map] of pendingByDevice.entries()) {
      if (!key.startsWith(`${accountId}:`)) continue;
      for (const [id, item] of map.entries()) {
        if (item.fromDeviceId === deviceId) map.delete(id);
      }
      if (map.size === 0) pendingByDevice.delete(key);
    }
  }

  function isSessionTokenStillActive(tokenHash, t = now()) {
    if (!tokenHash) return false;
    if (typeof store.isTokenActive === 'function') {
      try {
        return store.isTokenActive(tokenHash, t);
      } catch {
        return false;
      }
    }
    return true;
  }

  function isSseEntryAuthorized(entry, t = now()) {
    if (!entry || entry.closed) return false;
    if (Number.isFinite(entry.expiresAt) && entry.expiresAt <= t) return false;
    if (!isSessionTokenStillActive(entry.tokenHash, t)) return false;
    try {
      return linkStore.isDeviceActive(entry.accountId, entry.deviceId);
    } catch {
      return false;
    }
  }

  function writeSseFrame(entry, frame) {
    const res = entry.res;
    if (entry.closed || res.destroyed || res.writableEnded) {
      entry.close();
      return false;
    }
    if (res.writableLength >= effectiveMaxSseBufferBytes) {
      entry.close();
      return false;
    }
    let ok;
    try {
      ok = res.write(frame);
    } catch {
      entry.close();
      return false;
    }
    if (res.writableLength > effectiveMaxSseBufferBytes) {
      entry.close();
      return false;
    }
    if (!ok) {
      entry.armDrainTimeout();
    }
    return true;
  }

  function pushSse(accountId, targetDeviceId, event) {
    const entries = sseByDevice.get(deviceKey(accountId, targetDeviceId));
    if (!entries || entries.size === 0) return;
    const t = now();
    const frame = `event: ${event.type}\nid: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const entry of [...entries]) {
      if (!isSseEntryAuthorized(entry, t)) {
        entry.close();
        continue;
      }
      writeSseFrame(entry, frame);
    }
  }

  function queuePending(accountId, targetDeviceId, event) {
    const key = deviceKey(accountId, targetDeviceId);
    let map = pendingByDevice.get(key);
    if (!map) {
      map = new Map();
      pendingByDevice.set(key, map);
    }
    map.set(event.id, event);
  }

  function dispatchEvent(accountId, targetDeviceId, event) {
    queuePending(accountId, targetDeviceId, event);
    pushSse(accountId, targetDeviceId, event);
  }

  function closeSseForDevice(accountId, targetDeviceId) {
    const entries = sseByDevice.get(deviceKey(accountId, targetDeviceId));
    if (!entries) return;
    for (const entry of [...entries]) entry.close();
  }

  function teardownWaitingRoom(roomState, reason, { status = 409, code = 'room_closed', message = 'комната закрыта' } = {}) {
    if (!roomState || roomState.bridged || roomState.torn) return;
    roomState.torn = true;
    clearTimeout(roomState.waitTimer);
    if (roomState.ttlTimer) clearTimeout(roomState.ttlTimer);
    if (roomState.tokenExpiryTimers) {
      for (const timer of roomState.tokenExpiryTimers) timer.clear();
      roomState.tokenExpiryTimers = [];
    }
    activeRooms.delete(roomState.roomId);
    removePendingByRoom(roomState.roomId);
    tryCloseRoomDb(roomState.roomId, reason);
    for (const sock of Object.values(roomState.slots)) {
      if (!sock) continue;
      if (roomState.cleanupWaiting) roomState.cleanupWaiting(sock);
      if (status) {
        rejectUpgrade(sock, status, code, message);
      } else {
        safeDestroy(sock);
      }
    }
  }

  function closeActiveRoom(roomId, reason, waitingReject = null) {
    const roomState = activeRooms.get(roomId);
    if (!roomState) return;
    if (roomState.bridged && roomState.teardown) {
      roomState.teardown(reason);
    } else {
      teardownWaitingRoom(roomState, reason, waitingReject || { status: 0 });
    }
  }

  function sweepExpired() {
    if (closed) return [];
    const t = now();
    const expiredRoomIds = linkStore.sweepExpired(t, bridgedSessionRoomIds);
    for (const roomId of expiredRoomIds) {
      removePendingByRoom(roomId);
      closeActiveRoom(roomId, 'expired', {
        status: 403,
        code: 'ticket_expired',
        message: 'срок действия комнаты истёк',
      });
    }
    // Проверяем истечение или отзыв токена у активных комнат и SSE-подписок.
    for (const [roomId, roomState] of [...activeRooms.entries()]) {
      const hashes = Object.values(roomState.tokenHashes || {}).filter(Boolean);
      if (hashes.some((h) => !isSessionTokenStillActive(h, t))) {
        closeActiveRoom(roomId, 'token_revoked', {
          status: 401,
          code: 'unauthorized',
          message: 'сеанс завершён',
        });
      }
    }
    for (const entries of [...sseByDevice.values()]) {
      for (const entry of [...entries]) {
        if (!isSseEntryAuthorized(entry, t)) entry.close();
      }
    }
    for (const [key, map] of pendingByDevice.entries()) {
      for (const [id, item] of map.entries()) {
        if (item.expiresAt <= t) map.delete(id);
      }
      if (map.size === 0) pendingByDevice.delete(key);
    }
    return expiredRoomIds;
  }

  function ensureTransport(req) {
    if (!proxy.isSecureTransport(req)) {
      throw new LinkError(403, 'insecure_transport', 'для Nox Link требуется HTTPS/WSS (HTTP допустим только на 127.0.0.1)');
    }
  }

  function authenticateSession(req, { t = now(), anonBucket = 'auth' } = {}) {
    const token = bearer(req);
    if (token && BEARER_TOKEN_FORMAT_RE.test(token)) {
      const session = typeof store.sessionByToken === 'function'
        ? store.sessionByToken(token, t)
        : (() => {
            const account = store.accountByToken(token, t);
            return account ? { account, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: null } : null;
          })();
      if (session) {
        return { ...session, ip: clientIp(req) };
      }
    }
    const ip = clientIp(req);
    if (anonBucket === 'room') {
      linkStore.checkRateLimit(`link-fail:anon:ip:${ip}`, t);
      linkStore.recordFailure({ anonIp: ip, now: t });
    } else if (anonBucket === 'auth') {
      const authMax = Math.max(linkStore.maxFailedAttempts * 4, 20);
      const authKey = `link-fail:anon-auth:ip:${ip}`;
      linkStore.checkRateLimitWithMax(authKey, authMax, t);
      store.recordAttempt(authKey, t);
    }
    throw new LinkError(401, 'unauthorized', 'нужно войти в аккаунт');
  }

  function senderDeviceId(req, body) {
    const fromHeader = req.headers['x-nox-device-id'] ? String(req.headers['x-nox-device-id']) : '';
    const fromBody = body && (body.fromDeviceId || body.sourceDeviceId || body.deviceId)
      ? String(body.fromDeviceId || body.sourceDeviceId || body.deviceId)
      : '';
    if (fromHeader && fromBody && fromHeader !== fromBody) {
      throw new LinkError(400, 'device_mismatch', 'идентификатор устройства в заголовке и теле не совпадает');
    }
    const chosen = fromHeader || fromBody;
    if (!isUuidV4(chosen)) {
      throw new LinkError(400, 'bad_device_id', 'нужен корректный UUIDv4 устройства');
    }
    return chosen;
  }

  function assertNotClosingOrAborted(req, res) {
    if (closed) {
      throw new LinkError(503, 'server_closing', 'сервер останавливается');
    }
    if (req.aborted || (req.readableEnded && !req.complete) || (res && (res.destroyed || res.writableEnded))) {
      throw new LinkError(499, 'request_aborted', 'запрос прерван клиентом');
    }
  }

  async function handleRegisterDevice(req, res) {
    const t0 = now();
    const initialSession = authenticateSession(req, { t: t0, anonBucket: 'auth' });
    const body = await readJson(req, MAX_LINK_BODY, effectiveBodyTimeoutMs, closeAbortController.signal);
    assertNotClosingOrAborted(req, res);
    const t = now();
    const session = authenticateSession(req, { t, anonBucket: 'auth' });
    if (session.account.id !== initialSession.account.id || session.tokenHash !== initialSession.tokenHash) {
      throw new LinkError(401, 'unauthorized', 'нужно войти в аккаунт');
    }
    const { created, device } = linkStore.registerDevice({
      accountId: session.account.id,
      tokenHash: session.tokenHash,
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      rootCaFp256: body.rootCaFp256,
      now: t,
    });
    return sendJson(res, created ? 201 : 200, { device });
  }

  async function handleListDevices(req, res) {
    const t = now();
    const { account } = authenticateSession(req, { t, anonBucket: 'auth' });
    const devices = linkStore.listDevices(account.id).map((d) => ({
      ...d,
      online: d.revokedAt === null && (sseByDevice.get(deviceKey(account.id, d.deviceId))?.size || 0) > 0,
    }));
    return sendJson(res, 200, { devices });
  }

  async function handleRevokeDevice(req, res, deviceId) {
    assertNotClosingOrAborted(req, res);
    const t = now();
    const { account, tokenHash } = authenticateSession(req, { t, anonBucket: 'auth' });
    linkStore.checkRateLimit(`link-fail:acc:${account.id}`, t);

    let revokedResult;
    try {
      revokedResult = linkStore.revokeDevice({
        accountId: account.id,
        tokenHash,
        deviceId,
        now: t,
      });
    } catch (err) {
      if (err instanceof LinkError && err.code !== 'too_many_device_ops' && err.status !== 401) {
        linkStore.recordFailure({ accountId: account.id, now: t });
      }
      throw err;
    }
    const { newlyRevoked, device, closedRoomIds } = revokedResult;

    if (newlyRevoked) {
      for (const roomId of closedRoomIds) {
        removePendingByRoom(roomId);
        closeActiveRoom(roomId, 'device_revoked', {
          status: 403,
          code: 'device_revoked',
          message: 'устройство отозвано',
        });
      }
      removePendingForDevice(account.id, deviceId);
      closeSseForDevice(account.id, deviceId);

      const others = linkStore.listDevices(account.id).filter((d) => d.revokedAt === null && d.deviceId !== deviceId);
      for (const peer of others) {
        dispatchEvent(account.id, peer.deviceId, {
          id: crypto.randomUUID(),
          kind: 'revoked',
          type: 'link.device.revoked',
          roomId: null,
          fromDeviceId: deviceId,
          createdAt: t,
          expiresAt: t + revokedEventTtlMs,
          data: { deviceId, revokedAt: device.revokedAt },
        });
      }
    }

    return sendJson(res, 200, { ok: true, device });
  }

  async function handleOpenRoom(req, res, purpose, reqSecrets = []) {
    const t0 = now();
    const initialSession = authenticateSession(req, { t: t0, anonBucket: 'room' });
    linkStore.checkRateLimit(`link-fail:acc:${initialSession.account.id}`, t0);

    let body;
    try {
      body = await readJson(req, MAX_LINK_BODY, effectiveBodyTimeoutMs, closeAbortController.signal);
    } catch (err) {
      if (err.status !== 413 && err.status !== 499 && err.status !== 408 && err.status !== 503) {
        linkStore.recordFailure({ accountId: initialSession.account.id, now: now() });
      }
      throw err;
    }

    assertNotClosingOrAborted(req, res);
    const t = now();
    const session = authenticateSession(req, { t, anonBucket: 'room' });
    if (session.account.id !== initialSession.account.id || session.tokenHash !== initialSession.tokenHash) {
      throw new LinkError(401, 'unauthorized', 'нужно войти в аккаунт');
    }
    const { account, tokenHash } = session;
    linkStore.checkRateLimit(`link-fail:acc:${account.id}`, t);

    let created;
    try {
      const hostDeviceId = senderDeviceId(req, body);
      const clientDeviceId = body.targetDeviceId;
      created = linkStore.createRoom({
        accountId: account.id,
        tokenHash,
        purpose,
        hostDeviceId,
        clientDeviceId,
        now: t,
        activeBridgedSessionRoomIds: bridgedSessionRoomIds,
      });
    } catch (err) {
      // Квоты открытых комнат (429), дубль активного сопряжения (409) и истёкшая сессия (401) не пишутся как подбор комнаты.
      if (err instanceof LinkError && err.code !== 'too_many_rooms' && err.code !== 'pairing_already_active' && err.status !== 401) {
        linkStore.recordFailure({ accountId: account.id, now: t });
      }
      throw err;
    }
    reqSecrets.push(created.hostTicket, created.clientTicket);

    for (const expiredId of created.expiredRoomIds) {
      removePendingByRoom(expiredId);
      closeActiveRoom(expiredId, 'expired', {
        status: 403,
        code: 'ticket_expired',
        message: 'срок действия комнаты истёк',
      });
    }

    const eventType = purpose === 'pair' ? 'link.pair.invite' : 'link.session.incoming';
    dispatchEvent(account.id, created.clientDeviceId, {
      id: crypto.randomUUID(),
      kind: 'invite',
      type: eventType,
      roomId: created.roomId,
      fromDeviceId: created.hostDeviceId,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
      data: {
        roomId: created.roomId,
        clientTicket: created.clientTicket,
        fromDeviceId: created.hostDeviceId,
        fromDeviceName: created.hostDeviceName,
        expiresAt: created.expiresAt,
      },
    });

    // Инициатор получает только свой hostTicket; clientTicket уходит исключительно целевому устройству.
    return sendJson(res, 201, {
      roomId: created.roomId,
      hostTicket: created.hostTicket,
      purpose: created.purpose,
      targetDeviceId: created.clientDeviceId,
      expiresAt: created.expiresAt,
    });
  }

  async function handleEvents(req, res) {
    assertNotClosingOrAborted(req, res);
    const t = now();
    const { account, tokenHash, expiresAt } = authenticateSession(req, { t, anonBucket: 'auth' });
    const deviceId = String(req.headers['x-nox-device-id'] || '');
    linkStore.requireActiveDevice(account.id, deviceId);
    if (closed) {
      throw new LinkError(503, 'server_closing', 'сервер останавливается');
    }
    if (req.aborted || req.destroyed || res.destroyed || res.writableEnded) return;
    linkStore.touchDevice(deviceId, t);
    if (closed) {
      throw new LinkError(503, 'server_closing', 'сервер останавливается');
    }

    protectSocket(req.socket);
    protectSocket(res.socket);
    req.setTimeout(0);
    res.setTimeout(0);
    if (req.socket && typeof req.socket.setNoDelay === 'function') req.socket.setNoDelay(true);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const key = deviceKey(account.id, deviceId);
    while ((sseByDevice.get(key)?.size || 0) >= effectiveMaxSsePerDevice) {
      const currentSet = sseByDevice.get(key);
      const oldest = currentSet ? currentSet.values().next().value : null;
      if (oldest) oldest.close();
      else break;
    }

    let set = sseByDevice.get(key);
    if (!set) {
      set = new Set();
      sseByDevice.set(key, set);
    }

    let drainTimer = null;
    const onDrain = () => {
      entry.clearDrainTimeout();
    };
    const onClose = () => {
      entry.close();
    };

    const entry = {
      accountId: account.id,
      deviceId,
      tokenHash,
      expiresAt,
      res,
      heartbeatTimer: null,
      expiryTimer: null,
      closed: false,
      armDrainTimeout() {
        if (entry.closed || drainTimer) return;
        drainTimer = setTimeout(() => {
          drainTimer = null;
          entry.close();
        }, effectiveSseDrainTimeoutMs);
        if (typeof drainTimer.unref === 'function') drainTimer.unref();
      },
      clearDrainTimeout() {
        if (drainTimer) {
          clearTimeout(drainTimer);
          drainTimer = null;
        }
      },
      close() {
        if (entry.closed) return;
        entry.closed = true;
        entry.clearDrainTimeout();
        if (entry.heartbeatTimer) {
          clearInterval(entry.heartbeatTimer);
          entry.heartbeatTimer = null;
        }
        if (entry.expiryTimer) {
          entry.expiryTimer.clear();
          entry.expiryTimer = null;
        }
        res.off('drain', onDrain);
        req.off('aborted', onClose);
        req.off('close', onClose);
        res.off('close', onClose);
        res.off('error', onClose);
        const liveSet = sseByDevice.get(key);
        if (liveSet) {
          liveSet.delete(entry);
          if (liveSet.size === 0) sseByDevice.delete(key);
        }
        if (!res.destroyed && !res.writableEnded) {
          try { res.end(); } catch { /* ignore */ }
        }
        safeDestroy(res.socket);
      },
    };
    set.add(entry);

    res.on('drain', onDrain);
    req.on('aborted', onClose);
    req.on('close', onClose);
    res.on('close', onClose);
    res.on('error', onClose);

    if (!writeSseFrame(entry, `event: ready\nid: ready-${t}\ndata: ${JSON.stringify({ deviceId, ts: t })}\n\n`)) {
      return;
    }

    if (Number.isFinite(expiresAt)) {
      const armExpiryCheck = () => {
        if (entry.closed) return;
        const cur = now();
        const left = expiresAt - cur;
        if (left <= 0 || !isSessionTokenStillActive(tokenHash, cur)) {
          entry.close();
          return;
        }
        entry.expiryTimer = scheduleBoundedTimer(left, armExpiryCheck);
      };
      armExpiryCheck();
    }

    if (sseHeartbeatMs > 0 && !entry.closed) {
      entry.heartbeatTimer = setInterval(() => {
        if (!isSseEntryAuthorized(entry, now())) {
          entry.close();
          return;
        }
        if (res.destroyed || res.writableEnded) {
          entry.close();
          return;
        }
        if (res.writableNeedDrain || res.writableLength > 0) {
          entry.armDrainTimeout();
          return;
        }
        writeSseFrame(entry, ': ping\n\n');
      }, sseHeartbeatMs);
      if (typeof entry.heartbeatTimer.unref === 'function') entry.heartbeatTimer.unref();
    }
  }

  async function handlePending(req, res) {
    const t = now();
    const { account } = authenticateSession(req, { t, anonBucket: 'auth' });
    const deviceId = String(req.headers['x-nox-device-id'] || '');
    linkStore.requireActiveDevice(account.id, deviceId);
    linkStore.touchDevice(deviceId, t);
    sweepExpired();

    const key = deviceKey(account.id, deviceId);
    const map = pendingByDevice.get(key);
    const events = [];
    if (map) {
      for (const [id, item] of [...map.entries()]) {
        if (item.expiresAt <= t) {
          map.delete(id);
          continue;
        }
        events.push({
          id: item.id,
          type: item.type,
          data: item.data,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
        });
        if (item.kind === 'revoked') map.delete(id);
      }
      if (map.size === 0) pendingByDevice.delete(key);
    }

    return sendJson(res, 200, { events });
  }

  async function routeHttp(req, res, reqSecrets = []) {
    if (closed) {
      throw new LinkError(503, 'server_closing', 'сервер останавливается');
    }
    ensureTransport(req);
    const pathname = parsePathname(req.url);
    if (req.method === 'POST' && pathname === '/v1/link/devices/register') return handleRegisterDevice(req, res);
    if (req.method === 'GET' && pathname === '/v1/link/devices') return handleListDevices(req, res);
    const revokeMatch = req.method === 'POST' && /^\/v1\/link\/devices\/([^/]+)\/revoke$/.exec(pathname);
    if (revokeMatch) return handleRevokeDevice(req, res, revokeMatch[1]);
    if (req.method === 'POST' && pathname === '/v1/link/pairings/start') return handleOpenRoom(req, res, 'pair', reqSecrets);
    if (req.method === 'POST' && pathname === '/v1/link/sessions/open') return handleOpenRoom(req, res, 'session', reqSecrets);
    if (req.method === 'GET' && pathname === '/v1/link/events') return handleEvents(req, res);
    if (req.method === 'GET' && pathname === '/v1/link/pending') return handlePending(req, res);
    if (req.method === 'GET' && pathname === '/v1/link/relay') {
      throw new LinkError(426, 'upgrade_required', 'требуется заголовок Upgrade: nox-link');
    }
    throw new LinkError(404, 'not_found', 'нет такого адреса');
  }

  function collectReqSecrets(req) {
    const out = [];
    const tok = bearer(req);
    if (tok) out.push(tok);
    const jt = req?.headers?.['x-nox-join-ticket'];
    if (jt) out.push(String(jt));
    return out;
  }

  function handleHttp(req, res) {
    if (closed) {
      sendJson(res, 503, { error: { code: 'server_closing', message: 'сервер останавливается' } }, { Connection: 'close' });
      return Promise.resolve();
    }
    const reqSecrets = collectReqSecrets(req);
    const onAborted = () => { /* корректно перехватываем обрыв запроса */ };
    req.on('aborted', onAborted);
    const reqHandle = {
      abort() {
        safeDestroy(req.socket);
        if (typeof req.destroy === 'function' && !req.destroyed) {
          try { req.destroy(); } catch { /* ignore */ }
        }
        if (typeof res.destroy === 'function' && !res.destroyed && !res.writableEnded) {
          try { res.destroy(); } catch { /* ignore */ }
        }
      },
    };
    activeHttpRequests.add(reqHandle);
    return routeHttp(req, res, reqSecrets)
      .catch((err) => {
        if (err instanceof LinkError && err.code === 'request_aborted') {
          if (!res.headersSent && !res.destroyed && !res.writableEnded) {
            try { sendJson(res, 499, { error: { code: err.code, message: err.message } }, { Connection: 'close' }); } catch { /* ignore */ }
          }
          return;
        }
        if (res.headersSent || res.destroyed || res.writableEnded) return;
        if (err instanceof LinkError) {
          const headers = retryAfterHeaders(err);
          if (err.status === 413 || err.status === 408) {
            headers.Connection = 'close';
            res.once('finish', () => req.destroy());
          }
          sendJson(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } }, headers);
          return;
        }
        logError(err, reqSecrets);
        sendJson(res, 500, { error: { code: 'internal', message: 'внутренняя ошибка' } });
      })
      .finally(() => {
        activeHttpRequests.delete(reqHandle);
        req.off('aborted', onAborted);
      });
  }

  function armRoomTokenExpiry(roomState, tokenHash, expiresAt) {
    if (!Number.isFinite(expiresAt) || roomState.torn) return;
    if (!roomState.tokenExpiryTimers) roomState.tokenExpiryTimers = [];
    const check = () => {
      if (roomState.torn) return;
      const cur = now();
      const left = expiresAt - cur;
      if (left <= 0 || !isSessionTokenStillActive(tokenHash, cur)) {
        closeActiveRoom(roomState.roomId, 'token_expired', {
          status: 401,
          code: 'unauthorized',
          message: 'срок действия сеанса истёк',
        });
        return;
      }
      const handle = scheduleBoundedTimer(left, check);
      roomState.tokenExpiryTimers.push(handle);
    };
    const initial = scheduleBoundedTimer(Math.max(1, expiresAt - now()), check);
    roomState.tokenExpiryTimers.push(initial);
  }

  function bridgeSockets(roomState, secondRole, secondSocket, secondHead) {
    const firstRole = secondRole === 'host' ? 'client' : 'host';
    const firstSocket = roomState.slots[firstRole];
    protectSocket(firstSocket);
    protectSocket(secondSocket);

    if (!isSocketUsable(firstSocket)) {
      teardownWaitingRoom(roomState, 'peer_disconnected', { status: 0 });
      rejectUpgrade(secondSocket, 409, 'room_closed', 'первый участник отключился');
      return;
    }
    if (!isSocketUsable(secondSocket)) {
      teardownWaitingRoom(roomState, 'peer_disconnected', {
        status: 409,
        code: 'room_closed',
        message: 'второй участник отключился',
      });
      safeDestroy(secondSocket);
      return;
    }
    if (secondHead && secondHead.length > MAX_PREPIPE_BYTES) {
      teardownWaitingRoom(roomState, 'prepipe_overflow', { status: 0 });
      rejectUpgrade(secondSocket, 413, 'too_large', 'слишком много ранних данных до переключения протокола');
      return;
    }

    clearTimeout(roomState.waitTimer);
    roomState.waitTimer = null;
    if (roomState.cleanupWaiting) roomState.cleanupWaiting(firstSocket);

    let torn = false;
    let eofGraceTimer = null;
    let idleTimer = null;
    const drainTimers = new Map();
    const endedSockets = new Set();
    const cleanups = [];

    const hostSock = secondRole === 'host' ? secondSocket : firstSocket;
    const clientSock = secondRole === 'client' ? secondSocket : firstSocket;
    hostSock.allowHalfOpen = false;
    clientSock.allowHalfOpen = false;

    function clearDrainTimer(sock) {
      const timer = drainTimers.get(sock);
      if (timer) {
        clearTimeout(timer);
        drainTimers.delete(sock);
      }
    }

    function resetIdleTimer() {
      if (effectiveRelayIdleTimeoutMs <= 0 || torn) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => teardownPipe('idle_timeout'), effectiveRelayIdleTimeoutMs);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    }

    function teardownPipe(reason) {
      if (torn) return;
      torn = true;
      roomState.torn = true;
      clearTimeout(eofGraceTimer);
      eofGraceTimer = null;
      clearTimeout(idleTimer);
      idleTimer = null;
      clearTimeout(roomState.ttlTimer);
      roomState.ttlTimer = null;
      if (roomState.tokenExpiryTimers) {
        for (const timer of roomState.tokenExpiryTimers) timer.clear();
        roomState.tokenExpiryTimers = [];
      }
      for (const timer of drainTimers.values()) clearTimeout(timer);
      drainTimers.clear();
      for (const fn of cleanups) {
        try { fn(); } catch { /* ignore */ }
      }
      cleanups.length = 0;
      activeRooms.delete(roomState.roomId);
      bridgedSessionRoomIds.delete(roomState.roomId);
      tryCloseRoomDb(roomState.roomId, reason);
      safeDestroy(hostSock);
      safeDestroy(clientSock);
    }

    roomState.slots[secondRole] = secondSocket;
    roomState.bridged = true;
    roomState.teardown = teardownPipe;
    if (roomState.purpose === 'session') bridgedSessionRoomIds.add(roomState.roomId);

    const writeToPeer = (sock, data) => {
      if (torn || !isSocketUsable(sock)) {
        teardownPipe('write_failed');
        return { ok: false, needDrain: false };
      }
      if (sock.writableLength + data.length > effectiveMaxRelayBufferBytes) {
        teardownPipe('backpressure_overflow');
        return { ok: false, needDrain: false };
      }
      try {
        const flushed = sock.write(data, (err) => {
          if (err && !torn) teardownPipe('write_failed');
        });
        if (torn) return { ok: false, needDrain: false };
        if (sock.writableLength > effectiveMaxRelayBufferBytes) {
          teardownPipe('backpressure_overflow');
          return { ok: false, needDrain: false };
        }
        return { ok: true, needDrain: !flushed };
      } catch {
        teardownPipe('write_failed');
        return { ok: false, needDrain: false };
      }
    };

    const okHeader = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: nox-link\r\n\r\n';
    if (!writeToPeer(firstSocket, okHeader).ok || torn) return;
    if (!writeToPeer(secondSocket, okHeader).ok || torn) return;

    let firstNeedsDrain = false;
    let secondNeedsDrain = false;
    const firstPre = roomState.preBuffers?.[firstRole] || [];
    for (const chunk of firstPre) {
      if (chunk.length > 0) {
        const res = writeToPeer(secondSocket, chunk);
        if (!res.ok || torn) return;
        if (res.needDrain) secondNeedsDrain = true;
      }
    }
    if (secondHead && secondHead.length > 0) {
      const res = writeToPeer(firstSocket, secondHead);
      if (!res.ok || torn) return;
      if (res.needDrain) firstNeedsDrain = true;
    }
    roomState.preBuffers = null;

    const armDrainTimer = (to) => {
      if (torn || drainTimers.has(to)) return;
      const timer = setTimeout(() => {
        drainTimers.delete(to);
        teardownPipe('drain_timeout');
      }, effectiveRelayDrainTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      drainTimers.set(to, timer);
    };

    const forward = (from, to) => {
      const onData = (chunk) => {
        if (torn) return;
        if (!isSocketUsable(to)) {
          teardownPipe('peer_closed');
          return;
        }
        resetIdleTimer();
        const res = writeToPeer(to, chunk);
        if (!res.ok) return;
        if (res.needDrain) {
          if (typeof from.pause === 'function') from.pause();
          armDrainTimer(to);
        }
      };
      const onDrain = () => {
        clearDrainTimer(to);
        if (torn) return;
        resetIdleTimer();
        if (!from.destroyed && typeof from.resume === 'function') from.resume();
      };
      const onFinish = () => {
        if (!torn && endedSockets.size >= 2 && hostSock.writableLength === 0 && clientSock.writableLength === 0) {
          teardownPipe('peer_eof');
        }
      };
      const onEnd = () => {
        if (torn) return;
        endedSockets.add(from);
        if (!to.destroyed && !to.writableEnded) {
          try { to.end(); } catch { /* ignore */ }
        }
        if (endedSockets.size >= 2 && hostSock.writableLength === 0 && clientSock.writableLength === 0) {
          teardownPipe('peer_eof');
          return;
        }
        if (!eofGraceTimer) {
          const grace = to.writableLength > 0
            ? Math.max(effectiveHalfOpenGraceMs, Math.min(effectiveRelayDrainTimeoutMs, 2000))
            : effectiveHalfOpenGraceMs;
          eofGraceTimer = setTimeout(() => teardownPipe('peer_eof'), grace);
          if (typeof eofGraceTimer.unref === 'function') eofGraceTimer.unref();
        }
      };
      const onClose = () => teardownPipe('peer_closed');
      const onError = () => teardownPipe('peer_error');

      from.on('data', onData);
      to.on('drain', onDrain);
      to.on('finish', onFinish);
      from.on('end', onEnd);
      from.on('close', onClose);
      from.on('error', onError);
      cleanups.push(() => {
        from.off('data', onData);
        to.off('drain', onDrain);
        to.off('finish', onFinish);
        from.off('end', onEnd);
        from.off('close', onClose);
        from.off('error', onError);
      });
    };

    forward(hostSock, clientSock);
    forward(clientSock, hostSock);

    if (secondNeedsDrain) {
      if (typeof firstSocket.pause === 'function') firstSocket.pause();
      armDrainTimer(secondSocket);
    } else if (typeof firstSocket.resume === 'function') {
      firstSocket.resume();
    }

    if (firstNeedsDrain) {
      if (typeof secondSocket.pause === 'function') secondSocket.pause();
      armDrainTimer(firstSocket);
    } else if (typeof secondSocket.resume === 'function') {
      secondSocket.resume();
    }

    resetIdleTimer();

    if (roomState.purpose === 'pair') {
      const ttlRemaining = Math.max(1, roomState.expiresAt - now());
      roomState.ttlTimer = setTimeout(() => teardownPipe('pair_expired'), ttlRemaining);
      if (typeof roomState.ttlTimer.unref === 'function') roomState.ttlTimer.unref();
    }
  }

  function handleUpgrade(req, socket, head) {
    if (!socket) return;
    protectSocket(socket);
    if (closed) {
      rejectUpgrade(socket, 503, 'server_closing', 'сервер останавливается');
      return;
    }

    const reqSecrets = collectReqSecrets(req);
    let pathname;
    try {
      pathname = parsePathname(req.url);
    } catch (err) {
      rejectUpgrade(socket, err.status, err.code, err.message);
      return;
    }

    if (req.method !== 'GET' || pathname !== '/v1/link/relay') {
      rejectUpgrade(socket, 404, 'not_found', 'нет такого адреса');
      return;
    }

    const upgradeHeader = String(req.headers.upgrade || '').trim().toLowerCase();
    if (upgradeHeader !== 'nox-link') {
      rejectUpgrade(socket, 400, 'bad_upgrade', 'ожидается Upgrade: nox-link');
      return;
    }

    try {
      ensureTransport(req);
    } catch (err) {
      rejectUpgrade(socket, err.status, err.code, err.message);
      return;
    }

    const t = now();
    let session;
    try {
      session = authenticateSession(req, { t, anonBucket: 'room' });
    } catch (err) {
      rejectUpgrade(socket, err.status, err.code, err.message, retryAfterHeaders(err));
      return;
    }
    const { account, tokenHash, expiresAt } = session;

    try {
      linkStore.checkRateLimit(`link-fail:acc:${account.id}`, t);
    } catch (err) {
      rejectUpgrade(socket, err.status, err.code, err.message, retryAfterHeaders(err));
      return;
    }

    if (!isSocketUsable(socket)) {
      safeDestroy(socket);
      return;
    }

    const deviceId = String(req.headers['x-nox-device-id'] || '');
    const roomId = String(req.headers['x-nox-room-id'] || '');
    const joinTicket = String(req.headers['x-nox-join-ticket'] || '');

    let admission;
    try {
      admission = linkStore.admitToRoom({
        accountId: account.id,
        deviceId,
        roomId,
        joinTicket,
        now: t,
      });
    } catch (err) {
      if (err instanceof LinkError) {
        if (err.code === 'ticket_expired' || err.code === 'device_revoked' || err.code === 'room_closed') {
          removePendingByRoom(roomId);
          closeActiveRoom(roomId, err.code === 'ticket_expired' ? 'expired' : err.code, {
            status: err.status,
            code: err.code,
            message: err.message,
          });
        }
        linkStore.recordFailure({ accountId: account.id, now: t });
        rejectUpgrade(socket, err.status, err.code, err.message, retryAfterHeaders(err));
        return;
      }
      logError(err, reqSecrets);
      rejectUpgrade(socket, 500, 'internal', 'внутренняя ошибка');
      return;
    }

    try {
      if (admission.role === 'client') removePendingByRoom(roomId);

      const existing = activeRooms.get(roomId);
      if (existing) {
        if (existing.bridged || existing.slots[admission.role] || existing.torn) {
          rejectUpgrade(socket, 409, 'room_full', 'комната уже заполнена');
          return;
        }
        if (typeof socket.setTimeout === 'function') socket.setTimeout(0);
        if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
        if (!existing.tokenHashes) existing.tokenHashes = {};
        existing.tokenHashes[admission.role] = tokenHash;
        armRoomTokenExpiry(existing, tokenHash, expiresAt);
        bridgeSockets(existing, admission.role, socket, head);
        return;
      }

      if (head && head.length > MAX_PREPIPE_BYTES) {
        tryCloseRoomDb(roomId, 'prepipe_overflow');
        rejectUpgrade(socket, 413, 'too_large', 'слишком много ранних данных до переключения протокола');
        return;
      }

      if (!isSocketUsable(socket)) {
        tryCloseRoomDb(roomId, 'peer_disconnected');
        safeDestroy(socket);
        return;
      }

      socket.allowHalfOpen = false;
      if (typeof socket.setTimeout === 'function') socket.setTimeout(0);
      if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

      const roomState = {
        roomId,
        accountId: admission.accountId,
        purpose: admission.purpose,
        hostDeviceId: admission.hostDeviceId,
        clientDeviceId: admission.clientDeviceId,
        expiresAt: admission.expiresAt,
        tokenHashes: { [admission.role]: tokenHash },
        tokenExpiryTimers: [],
        slots: { [admission.role]: socket },
        preBuffers: { [admission.role]: head && head.length > 0 ? [Buffer.from(head)] : [] },
        preBytes: head ? head.length : 0,
        bridged: false,
        torn: false,
        waitTimer: null,
        ttlTimer: null,
        teardown: null,
        cleanupWaiting: null,
      };

      const onWaitingData = (chunk) => {
        if (roomState.bridged || roomState.torn) return;
        roomState.preBytes += chunk.length;
        if (roomState.preBytes > MAX_PREPIPE_BYTES) {
          teardownWaitingRoom(roomState, 'prepipe_overflow', {
            status: 413,
            code: 'too_large',
            message: 'слишком много ранних данных до подключения второго участника',
          });
          return;
        }
        roomState.preBuffers[admission.role].push(chunk);
      };
      const onWaitingAbort = () => {
        if (roomState.bridged || roomState.torn) return;
        teardownWaitingRoom(roomState, 'peer_disconnected', { status: 0 });
      };

      roomState.cleanupWaiting = (s) => {
        s.off('data', onWaitingData);
        s.off('end', onWaitingAbort);
        s.off('close', onWaitingAbort);
        s.off('error', onWaitingAbort);
      };

      socket.on('data', onWaitingData);
      socket.on('end', onWaitingAbort);
      socket.on('close', onWaitingAbort);
      socket.on('error', onWaitingAbort);

      const waitMs = Math.min(relayWaitTimeoutMs, Math.max(1, admission.expiresAt - t));
      roomState.waitTimer = setTimeout(() => {
        teardownWaitingRoom(roomState, 'wait_timeout', {
          status: 408,
          code: 'wait_timeout',
          message: 'второй участник не подключился вовремя',
        });
      }, waitMs);
      if (typeof roomState.waitTimer.unref === 'function') roomState.waitTimer.unref();

      armRoomTokenExpiry(roomState, tokenHash, expiresAt);
      activeRooms.set(roomId, roomState);
    } catch (err) {
      logError(err, reqSecrets);
      tryCloseRoomDb(roomId, 'upgrade_failed');
      activeRooms.delete(roomId);
      bridgedSessionRoomIds.delete(roomId);
      rejectUpgrade(socket, 500, 'internal', 'внутренняя ошибка');
    }
  }

  function disconnectToken(tokenHash, reason = 'token_revoked') {
    if (!tokenHash || closed) return;
    for (const [roomId, roomState] of [...activeRooms.entries()]) {
      const hashes = Object.values(roomState.tokenHashes || {});
      if (!hashes.includes(tokenHash)) continue;
      closeActiveRoom(roomId, reason, {
        status: 401,
        code: 'unauthorized',
        message: 'сеанс завершён',
      });
    }
    for (const set of [...sseByDevice.values()]) {
      for (const entry of [...set]) {
        if (entry.tokenHash === tokenHash) entry.close();
      }
    }
  }

  function disconnectAccount(accountId, reason = 'account_disabled') {
    if (!accountId || closed) return;
    const t = now();
    for (const [roomId, roomState] of [...activeRooms.entries()]) {
      if (roomState.accountId !== accountId) continue;
      if (roomState.bridged && roomState.teardown) {
        roomState.teardown(reason);
      } else {
        teardownWaitingRoom(roomState, reason, {
          status: 401,
          code: 'unauthorized',
          message: 'доступ аккаунта прекращён',
        });
      }
      removePendingByRoom(roomId);
    }
    try {
      linkStore.closeAccountRooms(accountId, reason, t);
    } catch { /* ignore */ }
    for (const [key] of [...pendingByDevice.entries()]) {
      if (key.startsWith(`${accountId}:`)) pendingByDevice.delete(key);
    }
    for (const [key, set] of [...sseByDevice.entries()]) {
      if (!key.startsWith(`${accountId}:`)) continue;
      for (const entry of [...set]) entry.close();
    }
  }

  const storeUnsubscribers = [];
  if (typeof store.onTokenRevoked === 'function') {
    storeUnsubscribers.push(store.onTokenRevoked((tokenHash) => disconnectToken(tokenHash, 'token_revoked')));
  }
  if (typeof store.onAccountDisabled === 'function') {
    storeUnsubscribers.push(store.onAccountDisabled((accountId) => disconnectAccount(accountId, 'account_disabled')));
  }

  function close() {
    if (closed) return;
    closed = true;
    closeAbortController.abort();
    for (const reqHandle of [...activeHttpRequests]) {
      reqHandle.abort();
    }
    activeHttpRequests.clear();
    for (const unsub of storeUnsubscribers) {
      try { unsub(); } catch { /* ignore */ }
    }
    storeUnsubscribers.length = 0;
    for (const roomState of [...activeRooms.values()]) {
      if (roomState.bridged && roomState.teardown) {
        roomState.teardown('server_shutdown');
      } else {
        teardownWaitingRoom(roomState, 'server_shutdown', { status: 0 });
      }
    }
    activeRooms.clear();
    bridgedSessionRoomIds.clear();
    pendingByDevice.clear();
    for (const set of [...sseByDevice.values()]) {
      for (const entry of [...set]) entry.close();
    }
    sseByDevice.clear();
  }

  function matchesHttp(req) {
    try {
      return parsePathname(req.url).startsWith('/v1/link/');
    } catch {
      return false;
    }
  }

  function matchesUpgrade(req) {
    try {
      return parsePathname(req.url) === '/v1/link/relay';
    } catch {
      return false;
    }
  }

  function stats() {
    let waitingRooms = 0;
    let bridgedRooms = 0;
    for (const room of activeRooms.values()) {
      if (room.bridged) bridgedRooms += 1;
      else waitingRooms += 1;
    }
    let activeSseCount = 0;
    for (const set of sseByDevice.values()) activeSseCount += set.size;
    return {
      activeRooms: activeRooms.size,
      waitingRooms,
      bridgedRooms,
      activeSseCount,
    };
  }

  return {
    linkStore,
    matchesHttp,
    matchesUpgrade,
    handleHttp,
    handleUpgrade,
    disconnectToken,
    disconnectAccount,
    sweepExpired,
    close,
    stats,
  };
}

// Автономный HTTP-сервер для изолированного запуска/проверки Stage 1 без подключения к общему server.js.
function createLinkServer(options = {}) {
  const ownStore = !options.store;
  const store = options.store || new Store(options.dbFile, { sessionTtlMs: options.accountSessionTtlMs });
  const service = createLinkService({ ...options, store });

  const server = http.createServer((req, res) => {
    if (service.matchesHttp(req)) {
      service.handleHttp(req, res);
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: 'нет такого адреса' } });
  });
  server.requestTimeout = 60 * 1000;
  server.headersTimeout = 30 * 1000;
  server.on('upgrade', (req, socket, head) => {
    service.handleUpgrade(req, socket, head);
  });
  const origClose = server.close.bind(server);
  server.close = (cb) => {
    service.close();
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return origClose(cb);
  };
  server.on('close', () => {
    service.close();
    if (ownStore) store.close();
  });

  return { server, store, service };
}

module.exports = {
  createLinkService,
  createLinkServer,
  redact,
  MAX_LINK_BODY,
  MAX_PREPIPE_BYTES,
  MAX_SSE_PER_DEVICE,
};
