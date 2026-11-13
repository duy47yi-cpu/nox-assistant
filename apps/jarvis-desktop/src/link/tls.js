'use strict';

// Взаимный TLS 1.3 канал для Nox Link: обязательный пиннинг Root CA + Leaf, проверка deviceId,
// контроль срока сертификата во время сеанса, таймауты, обработка half-open сокетов,
// немедленный разрыв при отзыве и чистая остановка.
const tls = require('tls');
const crypto = require('crypto');
const { Duplex } = require('stream');
const { X509Certificate } = crypto;
const {
  LinkCryptoError,
  assertUuidV4,
  parseSafeJson,
  sanitizeForLog,
} = require('./errors');
const {
  hostOf,
  toPem,
  pemToDer,
  hexToFpBuffer,
  getCertValidityInfo,
  fingerprint256Raw,
  fingerprintsEqual,
} = require('./pki');

const TLS13_OPTIONS = Object.freeze({
  minVersion: 'TLSv1.3',
  maxVersion: 'TLSv1.3',
});

const MAX_LINE_BYTES = 65_536;
const MAX_INBOX_FRAMES = 256;
const MAX_TIMER_HOP_MS = 1_728_000_000; // 20 суток (< 2^31-1 мс во избежание переполнения setTimeout).
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_CLOSE_GRACE_MS = 500;
const MAX_MALFORMED_FRAMES = 3;

function asDuplex(sock, { initialBuffer = null, ended = false } = {}) {
  if (!sock) throw new LinkCryptoError('invalid_stream', 'Требуется транспортный поток');

  let closed = false;
  let eofPushed = false;
  const duplex = new Duplex({
    allowHalfOpen: false,
    read() {
      if (!closed && typeof sock.resume === 'function') sock.resume();
    },
    write(chunk, enc, cb) {
      if (closed || sock.destroyed || sock.writableEnded) {
        cb(new LinkCryptoError('transport_closed', 'Транспортный поток закрыт'));
        return;
      }
      try {
        sock.write(chunk, enc, cb);
      } catch (err) {
        cb(err);
      }
    },
    final(cb) {
      if (!sock.destroyed && !sock.writableEnded && typeof sock.end === 'function') {
        try { sock.end(); } catch { /* ignore */ }
      }
      cb();
    },
    destroy(err, cb) {
      closed = true;
      cleanup();
      if (!sock.destroyed && typeof sock.destroy === 'function') {
        try { sock.destroy(); } catch { /* ignore */ }
      }
      cb(err);
    },
  });

  if (initialBuffer && initialBuffer.length > 0) {
    duplex.push(initialBuffer);
  }
  if (ended || sock.readableEnded) {
    eofPushed = true;
    duplex.push(null);
  }

  const onData = (chunk) => {
    if (closed) return;
    if (!duplex.push(chunk) && typeof sock.pause === 'function') {
      sock.pause();
    }
  };
  const onEnd = () => {
    if (closed) return;
    if (!eofPushed) {
      eofPushed = true;
      duplex.push(null);
    }
    // Исключаем зависание half-open сокета при одностороннем FIN.
    if (!sock.destroyed && !sock.writableEnded && typeof sock.end === 'function') {
      try { sock.end(); } catch { /* ignore */ }
    }
  };
  const onClose = () => {
    if (closed) return;
    closed = true;
    cleanup();
    if (!eofPushed) {
      eofPushed = true;
      duplex.push(null);
    }
    if (!duplex.destroyed) duplex.destroy();
  };
  const onError = (err) => {
    if (closed) return;
    closed = true;
    cleanup();
    duplex.destroy(err);
  };

  function cleanup() {
    sock.off('data', onData);
    sock.off('end', onEnd);
    sock.off('close', onClose);
    sock.off('error', onError);
  }

  sock.on('data', onData);
  sock.on('end', onEnd);
  sock.on('close', onClose);
  sock.on('error', onError);
  return duplex;
}

function assertPinnedLeafFp(expectedPeer) {
  if (!expectedPeer || !hexToFpBuffer(expectedPeer.leafFp256)) {
    throw new LinkCryptoError(
      'missing_peer_leaf_pin',
      'Отсутствует обязательный закреплённый отпечаток листового сертификата (leafFp256)',
    );
  }
}

function verifyConnectedPeerSocket(tlsSocket, { expectedPeer, nowMs }) {
  assertPinnedLeafFp(expectedPeer);

  if (!tlsSocket.authorized) {
    throw new LinkCryptoError(
      'tls_unauthorized',
      `TLS авторизация не пройдена: ${tlsSocket.authorizationError || 'unauthorized'}`,
    );
  }
  const protocol = tlsSocket.getProtocol();
  if (protocol !== 'TLSv1.3') {
    throw new LinkCryptoError('tls_version_mismatch', `Ожидался TLSv1.3, получен ${protocol || 'unknown'}`);
  }
  const peerCert = tlsSocket.getPeerX509Certificate();
  if (!peerCert) {
    throw new LinkCryptoError('peer_cert_missing', 'Пир не предъявил X.509 сертификат');
  }
  if (peerCert.ca !== false) {
    throw new LinkCryptoError('peer_cert_is_ca', 'Листовой сертификат пира не должен иметь CA:TRUE');
  }

  const expectedHost = hostOf(expectedPeer.deviceId);
  if (!peerCert.checkHost(expectedHost)) {
    throw new LinkCryptoError('peer_host_mismatch', `SAN сертификата не совпадает с ${expectedHost}`);
  }

  let expectedRootX509;
  try {
    const caDer = pemToDer(expectedPeer.rootCaPem, 'CERTIFICATE');
    expectedRootX509 = new X509Certificate(caDer);
  } catch (err) {
    if (err instanceof LinkCryptoError) throw err;
    throw new LinkCryptoError('invalid_expected_ca', 'Некорректный закреплённый Root CA пира');
  }
  if (expectedPeer.rootCaFp256) {
    const caRawFp = fingerprint256Raw(expectedRootX509.raw);
    if (!fingerprintsEqual(caRawFp, expectedPeer.rootCaFp256)) {
      throw new LinkCryptoError('peer_ca_mismatch', 'Отпечаток закреплённого Root CA не совпал');
    }
  }
  const caValidFrom = Date.parse(expectedRootX509.validFrom);
  const caValidTo = Date.parse(expectedRootX509.validTo);
  if (!Number.isFinite(caValidFrom) || !Number.isFinite(caValidTo) || nowMs < caValidFrom || nowMs > caValidTo) {
    throw new LinkCryptoError('peer_ca_expired', 'Срок действия Root CA пира недействителен');
  }
  if (!peerCert.checkIssued(expectedRootX509)) {
    throw new LinkCryptoError('peer_ca_mismatch', 'Листовой сертификат пира не выпущен его закреплённым Root CA');
  }

  const validFrom = Date.parse(peerCert.validFrom);
  const validTo = Date.parse(peerCert.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || nowMs < validFrom || nowMs > validTo) {
    throw new LinkCryptoError('peer_cert_expired', 'Срок действия сертификата пира недействителен');
  }

  const actualLeafRaw = fingerprint256Raw(peerCert.raw);
  if (!fingerprintsEqual(actualLeafRaw, expectedPeer.leafFp256)) {
    throw new LinkCryptoError('peer_leaf_pin_mismatch', 'Отпечаток листа пира не совпадает с закреплённым');
  }

  // На серверном сокете getEphemeralKeyInfo() возвращает null (норма BoringSSL/OpenSSL); читаем только диагностически на клиенте.
  let ephemeral = null;
  try {
    ephemeral = typeof tlsSocket.getEphemeralKeyInfo === 'function' ? tlsSocket.getEphemeralKeyInfo() : null;
  } catch {
    ephemeral = null;
  }

  return {
    protocol,
    peerLeafFp256: actualLeafRaw.toString('hex'),
    peerLeafValidToMs: validTo,
    peerCaValidToMs: caValidTo,
    ephemeral,
  };
}

class LinkTlsSession {
  #tlsSocket;
  #rawStream;
  #pending = new Map();
  #inbox = [];
  #frameHandlers = new Set();
  #closeHandlers = new Set();
  #unsubscribeRevoke = null;
  #heartbeatTimer = null;
  #idleTimer = null;
  #expiryTimer = null;
  #closePromise = null;
  #closed = false;
  #malformedCount = 0;
  #rxChunks = [];
  #rxBytes = 0;
  #maxInboxFrames;
  #certExpiryMs;
  #now;

  constructor({
    tlsSocket,
    rawStream,
    peerDeviceId,
    ownDeviceId,
    protocol,
    peerLeafFp256,
    ephemeral,
    peerStore = null,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxInboxFrames = MAX_INBOX_FRAMES,
    certExpiryMs = Infinity,
    now = Date.now,
  }) {
    this.#tlsSocket = tlsSocket;
    this.#rawStream = rawStream;
    this.peerDeviceId = peerDeviceId;
    this.ownDeviceId = ownDeviceId;
    this.protocol = protocol;
    this.peerLeafFp256 = peerLeafFp256;
    this.ephemeral = ephemeral;
    this.authorized = true;
    this.reusedSession = Boolean(tlsSocket.isSessionReused && tlsSocket.isSessionReused());
    this.idleTimeoutMs = idleTimeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.#maxInboxFrames = Number.isInteger(maxInboxFrames) && maxInboxFrames > 0 ? maxInboxFrames : MAX_INBOX_FRAMES;
    this.#certExpiryMs = Number.isFinite(certExpiryMs) ? certExpiryMs : Infinity;
    this.#now = typeof now === 'function' ? now : Date.now;

    this.#attachSocketEvents();
    this.#armIdleTimer();
    this.#armHeartbeat();
    this.#armExpiryTimer();

    if (peerStore && typeof peerStore.onRevoke === 'function') {
      this.#unsubscribeRevoke = peerStore.onRevoke(({ deviceId }) => {
        if (deviceId === this.peerDeviceId) {
          this.forceAbort(new LinkCryptoError('peer_revoked', 'Доверие к пиру отозвано во время активного сеанса'));
        }
      });
    }
  }

  get destroyed() {
    return this.#closed || this.#tlsSocket.destroyed;
  }

  get socket() {
    return this.#tlsSocket;
  }

  toJSON() {
    return {
      peerDeviceId: this.peerDeviceId,
      ownDeviceId: this.ownDeviceId,
      protocol: this.protocol,
      peerLeafFp256: this.peerLeafFp256,
      authorized: this.authorized,
      reusedSession: this.reusedSession,
      destroyed: this.destroyed,
    };
  }

  updateCertExpiry(nextCertExpiryMs) {
    this.#certExpiryMs = Number.isFinite(nextCertExpiryMs) ? nextCertExpiryMs : Infinity;
    this.#armExpiryTimer();
  }

  #assertCertNotExpired() {
    if (Number.isFinite(this.#certExpiryMs) && this.#now() > this.#certExpiryMs) {
      const err = new LinkCryptoError('cert_expired', 'Срок действия сертификата истёк во время активного сеанса');
      this.forceAbort(err);
      return err;
    }
    return null;
  }

  onFrame(handler) {
    if (typeof handler !== 'function') return () => {};
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }

  onClose(handler) {
    if (typeof handler !== 'function') return () => {};
    if (this.#closed) {
      queueMicrotask(() => handler(new LinkCryptoError('connection_closed', 'Соединение закрыто')));
      return () => {};
    }
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  sendFrame(frame) {
    const expiredErr = this.#assertCertNotExpired();
    if (expiredErr) {
      return Promise.reject(expiredErr);
    }
    if (this.destroyed || this.#tlsSocket.writableEnded) {
      return Promise.reject(new LinkCryptoError('connection_closed', 'Невозможно отправить кадр: соединение закрыто'));
    }
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      throw new LinkCryptoError('frame_too_large', 'Исходящий кадр превышает 64 КБ');
    }
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new LinkCryptoError('connection_closed', 'Соединение закрыто'));
        return;
      }
      this.#tlsSocket.write(line, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  waitNextFrame({ timeoutMs = 10_000, predicate = null } = {}) {
    const expiredErr = this.#assertCertNotExpired();
    if (expiredErr) {
      return Promise.reject(expiredErr);
    }
    for (let i = 0; i < this.#inbox.length; i += 1) {
      const candidate = this.#inbox[i];
      if (!predicate || predicate(candidate)) {
        this.#inbox.splice(i, 1);
        return Promise.resolve(candidate);
      }
    }
    if (this.destroyed) {
      return Promise.reject(new LinkCryptoError('connection_closed', 'Соединение закрыто'));
    }
    return new Promise((resolve, reject) => {
      const id = Symbol('waiter');
      let timer = null;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.#pending.delete(id);
      };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new LinkCryptoError('frame_timeout', 'Таймаут ожидания кадра по TLS'));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      this.#pending.set(id, {
        predicate,
        resolve: (frame) => {
          cleanup();
          resolve(frame);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
    });
  }

  forceAbort(err) {
    const reason = err || new LinkCryptoError('connection_aborted', 'Соединение принудительно прервано');
    this.#cleanupTimersAndListeners();
    this.#rejectPending(reason);
    if (!this.#tlsSocket.destroyed) {
      try { this.#tlsSocket.destroy(reason); } catch { /* ignore */ }
    }
    if (this.#rawStream && !this.#rawStream.destroyed) {
      try { this.#rawStream.destroy(); } catch { /* ignore */ }
    }
    this.#finalizeClose(reason);
  }

  close({ timeoutMs = DEFAULT_CLOSE_GRACE_MS } = {}) {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = new Promise((resolve) => {
      if (this.#closed && this.#tlsSocket.destroyed) {
        resolve();
        return;
      }
      const closeErr = new LinkCryptoError('connection_closed', 'Соединение закрыто');
      this.#cleanupTimersAndListeners();
      this.#rejectPending(closeErr);

      let fallbackTimer = null;
      const finish = () => {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        if (this.#rawStream && !this.#rawStream.destroyed) {
          try { this.#rawStream.destroy(); } catch { /* ignore */ }
        }
        this.#finalizeClose(closeErr);
        resolve();
      };

      if (this.#tlsSocket.destroyed) {
        finish();
        return;
      }

      this.#tlsSocket.once('close', finish);
      try {
        this.#tlsSocket.end();
      } catch {
        try { this.#tlsSocket.destroy(); } catch { /* ignore */ }
      }
      fallbackTimer = setTimeout(() => {
        if (!this.#tlsSocket.destroyed) {
          try { this.#tlsSocket.destroy(); } catch { /* ignore */ }
        } else {
          finish();
        }
      }, Math.max(10, timeoutMs));
      if (typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
    });
    return this.#closePromise;
  }

  #attachSocketEvents() {
    this.#tlsSocket.on('data', (chunk) => this.#onData(chunk));
    this.#tlsSocket.on('end', () => {
      // Закрываем half-open поток с нашей стороны.
      if (!this.#tlsSocket.destroyed && !this.#tlsSocket.writableEnded) {
        try { this.#tlsSocket.end(); } catch { /* ignore */ }
      }
    });
    this.#tlsSocket.on('error', (err) => {
      const wrapped = err instanceof LinkCryptoError
        ? err
        : new LinkCryptoError('tls_socket_error', err?.message || 'Ошибка TLS сокета');
      this.forceAbort(wrapped);
    });
    this.#tlsSocket.on('close', () => {
      this.#cleanupTimersAndListeners();
      const err = new LinkCryptoError('connection_closed', 'TLS сокет закрыт');
      this.#rejectPending(err);
      if (this.#rawStream && !this.#rawStream.destroyed) {
        try { this.#rawStream.destroy(); } catch { /* ignore */ }
      }
      this.#finalizeClose(err);
    });
  }

  #onData(chunk) {
    if (this.#closed) return;
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    // Линейный сбор строк (O(n)): объединяем куски только при появлении '\n' (P2-10).
    while (buf.length > 0) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (this.#rxBytes + buf.length > MAX_LINE_BYTES) {
          this.#abortOversizedFrame();
          return;
        }
        this.#rxChunks.push(buf);
        this.#rxBytes += buf.length;
        return;
      }

      const lineLen = this.#rxBytes + nl;
      if (lineLen > MAX_LINE_BYTES) {
        this.#abortOversizedFrame();
        return;
      }

      let lineBuf;
      if (this.#rxBytes === 0) {
        lineBuf = buf.subarray(0, nl);
      } else {
        this.#rxChunks.push(buf.subarray(0, nl));
        lineBuf = Buffer.concat(this.#rxChunks, lineLen);
        this.#rxChunks = [];
        this.#rxBytes = 0;
      }
      buf = buf.subarray(nl + 1);

      if (lineBuf.length > 0) {
        this.#handleLine(lineBuf.toString('utf8'));
        if (this.#closed) return;
      }
    }
  }

  #abortOversizedFrame() {
    try { this.#tlsSocket.pause(); } catch { /* ignore */ }
    try {
      if (!this.#tlsSocket.destroyed && !this.#tlsSocket.writableEnded) {
        this.#tlsSocket.write('{"v":3,"type":"error","code":"frame_too_large"}\n');
      }
    } catch { /* ignore */ }
    this.forceAbort(new LinkCryptoError('frame_too_large', 'Входящий NDJSON-кадр превысил 64 КБ'));
  }

  #handleLine(line) {
    if (this.#assertCertNotExpired()) {
      return;
    }

    const frame = parseSafeJson(line);
    if (!frame || frame.v !== 3 || typeof frame.type !== 'string') {
      this.#malformedCount += 1;
      try {
        if (!this.#tlsSocket.destroyed && !this.#tlsSocket.writableEnded) {
          this.#tlsSocket.write('{"v":3,"type":"error","code":"malformed_json"}\n');
        }
      } catch { /* ignore */ }
      if (this.#malformedCount >= MAX_MALFORMED_FRAMES) {
        this.forceAbort(new LinkCryptoError('malformed_json', 'Превышен порог некорректных кадров'));
      }
      return;
    }

    this.#armIdleTimer();

    if (frame.type === 'ping') {
      try {
        if (!this.#tlsSocket.destroyed && !this.#tlsSocket.writableEnded) {
          this.#tlsSocket.write(`${JSON.stringify({ v: 3, type: 'pong', ts: frame.ts ?? this.#now() })}\n`);
        }
      } catch { /* ignore */ }
      return;
    }
    if (frame.type === 'pong') {
      return;
    }

    // Сначала проверяем ожидающие одноразовые waiter'ы (с фильтрацией по predicate).
    for (const waiter of this.#pending.values()) {
      if (!waiter.predicate || waiter.predicate(frame)) {
        waiter.resolve(frame);
        return;
      }
    }

    if (this.#frameHandlers.size === 0) {
      if (this.#inbox.length >= this.#maxInboxFrames) {
        try {
          if (!this.#tlsSocket.destroyed && !this.#tlsSocket.writableEnded) {
            this.#tlsSocket.write('{"v":3,"type":"error","code":"inbox_overflow"}\n');
          }
        } catch { /* ignore */ }
        this.forceAbort(new LinkCryptoError('inbox_overflow', 'Переполнение очереди входящих кадров TLS'));
        return;
      }
      this.#inbox.push(frame);
      return;
    }

    for (const handler of [...this.#frameHandlers]) {
      try {
        handler(frame);
      } catch { /* обработчик не должен ронять цикл чтения */ }
    }
  }

  #armIdleTimer() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#closed || !Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) return;
    this.#idleTimer = setTimeout(() => {
      this.forceAbort(new LinkCryptoError('idle_timeout', 'Соединение закрыто по таймауту неактивности'));
    }, this.idleTimeoutMs);
    if (typeof this.#idleTimer.unref === 'function') this.#idleTimer.unref();
  }

  #armHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#closed || !Number.isFinite(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) return;
    this.#heartbeatTimer = setInterval(() => {
      if (this.destroyed || this.#tlsSocket.writableEnded) return;
      if (this.#assertCertNotExpired()) return;
      try {
        this.#tlsSocket.write(`${JSON.stringify({ v: 3, type: 'ping', ts: this.#now() })}\n`);
      } catch { /* ignore */ }
    }, this.heartbeatIntervalMs);
    if (typeof this.#heartbeatTimer.unref === 'function') this.#heartbeatTimer.unref();
  }

  #armExpiryTimer() {
    if (this.#expiryTimer) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
    if (this.#closed || !Number.isFinite(this.#certExpiryMs)) return;
    const remaining = this.#certExpiryMs - this.#now();
    if (remaining < 0) {
      this.forceAbort(new LinkCryptoError('cert_expired', 'Срок действия сертификата истёк во время активного сеанса'));
      return;
    }
    const delay = Math.min(remaining + 5, MAX_TIMER_HOP_MS);
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = null;
      this.#armExpiryTimer();
    }, delay);
    if (typeof this.#expiryTimer.unref === 'function') this.#expiryTimer.unref();
  }

  #cleanupTimersAndListeners() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#expiryTimer) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
    if (this.#unsubscribeRevoke) {
      this.#unsubscribeRevoke();
      this.#unsubscribeRevoke = null;
    }
  }

  #rejectPending(err) {
    for (const waiter of this.#pending.values()) {
      waiter.reject(err);
    }
    this.#pending.clear();
  }

  #finalizeClose(err) {
    if (this.#closed) return;
    this.#closed = true;
    this.#inbox.length = 0;
    for (const handler of [...this.#closeHandlers]) {
      try { handler(err); } catch { /* ignore */ }
    }
    this.#closeHandlers.clear();
    this.#frameHandlers.clear();
  }
}

async function establishMutualTls({
  stream,
  role,
  identity,
  expectedPeer,
  peerStore = null,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxInboxFrames = MAX_INBOX_FRAMES,
  now = Date.now,
} = {}) {
  if (role !== 'server' && role !== 'client') {
    throw new LinkCryptoError('invalid_tls_role', 'Роль TLS должна быть "server" или "client"');
  }
  if (!stream) {
    throw new LinkCryptoError('invalid_stream', 'Требуется транспортный поток для TLS');
  }
  if (!identity || typeof identity.getTlsCredentials !== 'function') {
    throw new LinkCryptoError('invalid_identity', 'Требуется объект DeviceIdentity');
  }
  if (!expectedPeer || typeof expectedPeer !== 'object') {
    throw new LinkCryptoError('invalid_expected_peer', 'Требуется описание ожидаемого пира');
  }

  const peerDeviceId = assertUuidV4(expectedPeer.deviceId, 'expectedPeer.deviceId');
  const nowMs = now();

  // Если передан peerStore, проверяем доверие и отсутствие отзыва ДО запуска TLS (с синхронизацией с диском).
  let pinnedPeer = expectedPeer;
  if (peerStore) {
    pinnedPeer = peerStore.requireTrustedPeer(peerDeviceId, { nowMs });
  }
  if (typeof pinnedPeer.rootCaPem !== 'string' || !pinnedPeer.rootCaPem.trim()) {
    throw new LinkCryptoError('missing_peer_ca', 'Отсутствует закреплённый Root CA пира');
  }
  const pinnedCaPem = toPem('CERTIFICATE', pemToDer(pinnedPeer.rootCaPem, 'CERTIFICATE'));
  if (pinnedPeer.rootCaFp256 && !fingerprintsEqual(fingerprint256Raw(pinnedCaPem), pinnedPeer.rootCaFp256)) {
    throw new LinkCryptoError('peer_ca_mismatch', 'Отпечаток закреплённого Root CA пира повреждён');
  }
  assertPinnedLeafFp(pinnedPeer);

  const creds = identity.getTlsCredentials();
  const ownLeafPem = toPem('CERTIFICATE', pemToDer(creds.leafPem, 'CERTIFICATE'));
  const ownCaPem = toPem('CERTIFICATE', pemToDer(creds.caPem, 'CERTIFICATE'));
  const ownLeafTimes = getCertValidityInfo(ownLeafPem);
  const ownCaTimes = getCertValidityInfo(ownCaPem);
  if (nowMs < ownLeafTimes.validFromMs || nowMs < ownCaTimes.validFromMs) {
    throw new LinkCryptoError('cert_not_yet_valid', 'Собственный сертификат ещё не вступил в силу');
  }
  if (nowMs > ownLeafTimes.validToMs || nowMs > ownCaTimes.validToMs) {
    throw new LinkCryptoError('cert_expired', 'Срок действия собственного сертификата истёк');
  }

  const expectedHost = hostOf(peerDeviceId);
  const rawStream = stream instanceof Duplex ? stream : asDuplex(stream);

  const secureOptions = crypto.constants.SSL_OP_NO_TICKET || 0;
  const baseOpts = {
    ...TLS13_OPTIONS,
    key: creds.leafKeyPem,
    cert: `${ownLeafPem}\n${ownCaPem}`,
    ca: [pinnedCaPem],
    sessionTimeout: 0,
    secureOptions,
  };

  let tlsSocket;
  let ephemeralServer = null;
  let unsubscribePreRevoke = null;

  try {
    tlsSocket = await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (unsubscribePreRevoke) {
          unsubscribePreRevoke();
          unsubscribePreRevoke = null;
        }
        rawStream.off('close', onRawClose);
        rawStream.off('error', onRawError);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (ephemeralServer) {
          try { ephemeralServer.close(); } catch { /* ignore */ }
        }
        reject(err instanceof LinkCryptoError ? err : new LinkCryptoError('tls_handshake_failed', err?.message || 'Ошибка рукопожатия TLS', sanitizeForLog(err)));
      };

      const succeed = (sock) => {
        if (settled) {
          try { sock.destroy(); } catch { /* ignore */ }
          return;
        }
        settled = true;
        cleanup();
        if (ephemeralServer) {
          try { ephemeralServer.close(); } catch { /* ignore */ }
        }
        resolve(sock);
      };

      const onRawClose = () => fail(new LinkCryptoError('transport_closed', 'Транспорт закрыт до завершения TLS-рукопожатия'));
      const onRawError = (err) => fail(new LinkCryptoError('transport_error', err?.message || 'Ошибка транспортного потока'));

      rawStream.on('close', onRawClose);
      rawStream.on('error', onRawError);

      if (peerStore && typeof peerStore.onRevoke === 'function') {
        unsubscribePreRevoke = peerStore.onRevoke(({ deviceId }) => {
          if (deviceId === peerDeviceId) {
            fail(new LinkCryptoError('peer_revoked', 'Доверие к пиру отозвано во время подключения'));
          }
        });
      }

      if (Number.isFinite(handshakeTimeoutMs) && handshakeTimeoutMs > 0) {
        timer = setTimeout(() => {
          fail(new LinkCryptoError('tls_handshake_timeout', 'Превышен таймаут рукопожатия TLS 1.3'));
        }, handshakeTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }

      if (role === 'server') {
        ephemeralServer = tls.createServer({
          ...baseOpts,
          requestCert: true,
          rejectUnauthorized: true,
        });
        ephemeralServer.once('secureConnection', (sock) => succeed(sock));
        ephemeralServer.once('tlsClientError', (err, sock) => {
          if (sock && !sock.destroyed) {
            try { sock.destroy(); } catch { /* ignore */ }
          }
          fail(err);
        });
        ephemeralServer.once('error', (err) => fail(err));
        ephemeralServer.emit('connection', rawStream);
        if (rawStream.readableFlowing === false && typeof rawStream.resume === 'function') {
          rawStream.resume();
        }
      } else {
        const sock = tls.connect({
          ...baseOpts,
          socket: rawStream,
          servername: expectedHost,
          rejectUnauthorized: true,
          checkServerIdentity: (_, cert) => tls.checkServerIdentity(expectedHost, cert),
        }, () => succeed(sock));
        sock.once('error', (err) => fail(err));
        if (rawStream.readableFlowing === false && typeof rawStream.resume === 'function') {
          rawStream.resume();
        }
      }
    });
  } catch (err) {
    try { rawStream.destroy(); } catch { /* ignore */ }
    throw err;
  }

  // Строгая проверка после TLS-рукопожатия до передачи первого байта приложения.
  let verifiedTls;
  try {
    if (peerStore) {
      peerStore.requireTrustedPeer(peerDeviceId, { nowMs: now() });
    }
    verifiedTls = verifyConnectedPeerSocket(tlsSocket, { expectedPeer: pinnedPeer, nowMs: now() });
  } catch (err) {
    try { tlsSocket.destroy(); } catch { /* ignore */ }
    try { rawStream.destroy(); } catch { /* ignore */ }
    throw err;
  }

  const certExpiryMs = Math.min(
    ownLeafTimes.validToMs,
    ownCaTimes.validToMs,
    verifiedTls.peerLeafValidToMs,
    verifiedTls.peerCaValidToMs,
  );

  const session = new LinkTlsSession({
    tlsSocket,
    rawStream,
    peerDeviceId,
    ownDeviceId: creds.deviceId,
    protocol: verifiedTls.protocol,
    peerLeafFp256: verifiedTls.peerLeafFp256,
    ephemeral: verifiedTls.ephemeral,
    peerStore,
    heartbeatIntervalMs,
    idleTimeoutMs,
    maxInboxFrames,
    certExpiryMs,
    now,
  });

  // В TLS 1.3 клиент заканчивает рукопожатие раньше, чем сервер проверит его сертификат.
  // Барьер __nox_tls_ready гарантирует, что оба конца прошли взаимную проверку до возврата сессии.
  try {
    const readyPromise = session.waitNextFrame({
      timeoutMs: handshakeTimeoutMs,
      predicate: (f) => f.type === '__nox_tls_ready',
    });
    await session.sendFrame({
      v: 3,
      type: '__nox_tls_ready',
      deviceId: creds.deviceId,
      leafFp256: creds.leafFp256,
    });
    const peerReady = await readyPromise;
    if (peerReady.deviceId !== peerDeviceId) {
      throw new LinkCryptoError('peer_device_id_mismatch', 'Идентификатор устройства в TLS-подтверждении не совпал');
    }
    if (!fingerprintsEqual(peerReady.leafFp256, pinnedPeer.leafFp256)) {
      throw new LinkCryptoError('peer_leaf_pin_mismatch', 'Отпечаток листа в TLS-подтверждении не совпал');
    }
  } catch (err) {
    session.forceAbort(err);
    throw err;
  }

  return session;
}

module.exports = {
  TLS13_OPTIONS,
  MAX_LINE_BYTES,
  MAX_INBOX_FRAMES,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_CLOSE_GRACE_MS,
  asDuplex,
  verifyConnectedPeerSocket,
  LinkTlsSession,
  establishMutualTls,
};
