'use strict';

// Сопряжение устройств Nox Link: Commit-then-Reveal + mTLS 1.3 + Proof-of-Possession + транскрипт-привязанный SAS.
// Автоматическое доверие без явного подтверждения владельцев на обоих устройствах запрещено.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  LinkCryptoError,
  assertUuidV4,
  normalizeDeviceName,
  parseSafeJson,
  canonicalizePath,
  atomicWriteFileSync,
  withFileLockSync,
} = require('./errors');
const {
  verifyDeviceCertPair,
  verifyWithLeafCert,
  fingerprint256Raw,
  fingerprintsEqual,
} = require('./pki');
const { verifyLeafUpdateEnvelope } = require('./identity');
const { establishMutualTls, asDuplex, MAX_LINE_BYTES } = require('./tls');

const DEFAULT_PHASE_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 3;
const MAX_PRETLS_BUFFER_BYTES = Math.max(MAX_LINE_BYTES * 8, 512 * 1024);

// Сериализация параллельных попыток сопряжения на одну и ту же пару (ownDeviceId -> expectedPeerId).
const ACTIVE_PAIRING_SLOTS = new Map();

function assertRoomId(roomId) {
  if (typeof roomId !== 'string' || !roomId || roomId.length > 128 || /[\u0000-\u001f\u007f]/.test(roomId)) {
    throw new LinkCryptoError('invalid_room_id', 'Некорректный идентификатор комнаты сопряжения');
  }
  return roomId;
}

function lengthPrefixed(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function computePairCommit({
  roomId,
  role,
  deviceId,
  deviceName,
  caPem,
  leafPem,
  nonce,
}) {
  const nonceBuf = Buffer.isBuffer(nonce) ? nonce : Buffer.from(String(nonce), 'hex');
  if (nonceBuf.length !== 32) {
    throw new LinkCryptoError('invalid_nonce', 'Nonce должен содержать ровно 32 байта');
  }
  return crypto.createHash('sha256')
    .update(Buffer.from('NOX-PAIR-COMMIT-V3', 'utf8'))
    .update(lengthPrefixed(assertRoomId(roomId)))
    .update(lengthPrefixed(role))
    .update(lengthPrefixed(assertUuidV4(deviceId, 'deviceId')))
    .update(lengthPrefixed(normalizeDeviceName(deviceName)))
    .update(lengthPrefixed(caPem))
    .update(lengthPrefixed(leafPem))
    .update(lengthPrefixed(nonceBuf))
    .digest();
}

function computeTranscriptHash({ roomId, host, client }) {
  return crypto.createHash('sha256')
    .update(Buffer.from('NOX-PAIR-TRANSCRIPT-V3', 'utf8'))
    .update(lengthPrefixed(assertRoomId(roomId)))
    .update(lengthPrefixed(host.deviceId))
    .update(lengthPrefixed(host.deviceName))
    .update(lengthPrefixed(host.caFp256Bytes))
    .update(lengthPrefixed(host.leafFp256Bytes))
    .update(lengthPrefixed(host.nonce))
    .update(lengthPrefixed(client.deviceId))
    .update(lengthPrefixed(client.deviceName))
    .update(lengthPrefixed(client.caFp256Bytes))
    .update(lengthPrefixed(client.leafFp256Bytes))
    .update(lengthPrefixed(client.nonce))
    .digest();
}

function deriveSasCode({
  transcriptHash,
  hostNonce,
  clientNonce,
  roomId,
  hostDeviceName,
  clientDeviceName,
}) {
  const salt = Buffer.concat([hostNonce, clientNonce]);
  const info = Buffer.concat([
    Buffer.from('NOX-LINK-SAS-V3', 'utf8'),
    lengthPrefixed(assertRoomId(roomId)),
    lengthPrefixed(normalizeDeviceName(hostDeviceName)),
    lengthPrefixed(normalizeDeviceName(clientDeviceName)),
  ]);
  const raw = Buffer.from(crypto.hkdfSync('sha256', transcriptHash, salt, info, 8));
  const value = raw.readBigUInt64BE(0) % 1_000_000n;
  return value.toString().padStart(6, '0');
}

class PairingCooldownTracker {
  #filePath;
  #dirCreated = false;

  constructor({
    maxFailures = DEFAULT_MAX_FAILURES,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    dataDir = null,
    filePath = null,
  } = {}) {
    this.maxFailures = maxFailures;
    this.cooldownMs = cooldownMs;
    this.entries = new Map();
    this.activePeers = new Map();
    const resolved = filePath || (dataDir ? path.join(dataDir, 'pairing-cooldown.json') : null);
    this.#filePath = resolved ? canonicalizePath(resolved) : null;
    if (this.#filePath) {
      this.#syncFromDisk(Date.now());
    }
  }

  get filePath() {
    return this.#filePath;
  }

  #ensureDir() {
    if (!this.#filePath || this.#dirCreated) return;
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    this.#dirCreated = true;
  }

  #readDiskEntries(nowMs) {
    if (!this.#filePath || !fs.existsSync(this.#filePath)) {
      return new Map();
    }
    const raw = fs.readFileSync(this.#filePath, 'utf8');
    const parsed = parseSafeJson(raw);
    if (!parsed || parsed.v !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new LinkCryptoError('cooldown_store_corrupted', 'Повреждён файл ограничений сопряжения');
    }
    const map = new Map();
    for (const [deviceId, entry] of Object.entries(parsed.entries)) {
      try {
        assertUuidV4(deviceId, 'deviceId');
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      if (!Number.isSafeInteger(entry.failures) || entry.failures < 1) continue;
      if (!Number.isFinite(entry.lastFailureAt)) continue;
      if (nowMs - entry.lastFailureAt >= this.cooldownMs) continue;
      map.set(deviceId, { failures: entry.failures, lastFailureAt: entry.lastFailureAt });
    }
    return map;
  }

  #syncFromDisk(nowMs) {
    if (!this.#filePath) return;
    const diskMap = this.#readDiskEntries(nowMs);
    this.entries = diskMap;
  }

  #writeDiskEntries() {
    if (!this.#filePath) return;
    this.#ensureDir();
    const obj = Object.create(null);
    for (const [deviceId, entry] of this.entries.entries()) {
      obj[deviceId] = { failures: entry.failures, lastFailureAt: entry.lastFailureAt };
    }
    atomicWriteFileSync(this.#filePath, `${JSON.stringify({ v: 1, entries: obj }, null, 2)}\n`, { mode: 0o600 });
  }

  #mutateLocked(nowMs, fn) {
    if (!this.#filePath) {
      fn();
      return;
    }
    this.#ensureDir();
    withFileLockSync(`${this.#filePath}.lock`, () => {
      this.#syncFromDisk(nowMs);
      fn();
      for (const [id, entry] of this.entries.entries()) {
        if (nowMs - entry.lastFailureAt >= this.cooldownMs) {
          this.entries.delete(id);
        }
      }
      this.#writeDiskEntries();
    });
  }

  assertAllowed(deviceId, nowMs = Date.now()) {
    assertUuidV4(deviceId, 'deviceId');
    if (this.#filePath) {
      this.#syncFromDisk(nowMs);
    }
    const entry = this.entries.get(deviceId);
    if (!entry) return;
    if (nowMs - entry.lastFailureAt >= this.cooldownMs) {
      this.entries.delete(deviceId);
      return;
    }
    if (entry.failures >= this.maxFailures) {
      throw new LinkCryptoError(
        'pairing_cooldown',
        'Превышен лимит неудачных попыток сопряжения; устройство временно заблокировано',
      );
    }
  }

  tryAcquire(deviceId, nowMs = Date.now()) {
    this.assertAllowed(deviceId, nowMs);
    if (this.activePeers.has(deviceId)) {
      throw new LinkCryptoError(
        'pairing_in_progress',
        'Для этого устройства уже выполняется активное сопряжение',
      );
    }
    const token = Symbol('tracker_pairing_slot');
    this.activePeers.set(deviceId, token);
    return () => {
      if (this.activePeers.get(deviceId) === token) {
        this.activePeers.delete(deviceId);
      }
    };
  }

  recordFailure(deviceId, nowMs = Date.now()) {
    assertUuidV4(deviceId, 'deviceId');
    this.#mutateLocked(nowMs, () => {
      const prev = this.entries.get(deviceId);
      if (!prev || nowMs - prev.lastFailureAt >= this.cooldownMs) {
        this.entries.set(deviceId, { failures: 1, lastFailureAt: nowMs });
      } else {
        this.entries.set(deviceId, { failures: prev.failures + 1, lastFailureAt: nowMs });
      }
    });
  }

  recordSuccess(deviceId, nowMs = Date.now()) {
    assertUuidV4(deviceId, 'deviceId');
    this.#mutateLocked(nowMs, () => {
      this.entries.delete(deviceId);
    });
  }
}

function createPreTlsLineReader(stream) {
  let chunks = [];
  let totalBytes = 0;
  let firstLineNlAt = -1;
  let waiter = null;
  let closedErr = null;
  let streamEnded = false;
  let detached = false;

  const rejectWaiter = (err) => {
    if (!waiter) return;
    const current = waiter;
    waiter = null;
    current.reject(err);
  };

  const consumeOneLine = () => {
    if (firstLineNlAt === -1) return null;
    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    const rawLine = all.subarray(0, firstLineNlAt);
    const trimmedLine = (rawLine.length > 0 && rawLine[rawLine.length - 1] === 0x0d)
      ? rawLine.subarray(0, rawLine.length - 1)
      : rawLine;
    const rest = all.subarray(firstLineNlAt + 1);
    chunks = rest.length > 0 ? [rest] : [];
    totalBytes = rest.length;
    firstLineNlAt = rest.indexOf(0x0a);

    const parsed = parseSafeJson(trimmedLine.toString('utf8'));
    if (!parsed || parsed.v !== 3 || typeof parsed.type !== 'string') {
      throw new LinkCryptoError('malformed_pairing_frame', 'Некорректный JSON-кадр на фазе сопряжения');
    }
    return parsed;
  };

  const deliverReadyLine = () => {
    if (!waiter || firstLineNlAt === -1) return;
    const current = waiter;
    waiter = null;
    try {
      const parsed = consumeOneLine();
      current.resolve(parsed);
    } catch (err) {
      closedErr = closedErr || err;
      current.reject(err);
    }
  };

  const fail = (err) => {
    closedErr = closedErr || err;
    if (waiter && firstLineNlAt === -1) {
      rejectWaiter(closedErr);
    }
  };

  const onData = (chunk) => {
    if (detached) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) return;

    if (firstLineNlAt === -1) {
      const nlIdx = buf.indexOf(0x0a);
      if (nlIdx !== -1) {
        firstLineNlAt = totalBytes + nlIdx;
        if (firstLineNlAt > MAX_LINE_BYTES) {
          fail(new LinkCryptoError('frame_too_large', 'Кадр сопряжения до TLS превысил 64 КБ'));
          return;
        }
      } else if (totalBytes + buf.length > MAX_LINE_BYTES) {
        fail(new LinkCryptoError('frame_too_large', 'Кадр сопряжения до TLS превысил 64 КБ'));
        return;
      }
    } else if (totalBytes + buf.length > MAX_PRETLS_BUFFER_BYTES) {
      fail(new LinkCryptoError('pre_tls_buffer_overflow', 'Превышен допустимый буфер сопряжения до TLS'));
      return;
    }

    chunks.push(buf);
    totalBytes += buf.length;

    if (waiter && firstLineNlAt !== -1) {
      deliverReadyLine();
    } else if (!waiter && firstLineNlAt !== -1 && typeof stream.pause === 'function') {
      // Уже есть законченный кадр до TLS; не вытягиваем лишние байты до nextFrame() или detachForTls().
      stream.pause();
    }
  };

  const onEnd = () => {
    streamEnded = true;
    if (firstLineNlAt === -1) {
      fail(new LinkCryptoError('transport_closed', 'Транспорт закрыт во время сопряжения'));
    }
  };
  const onClose = () => fail(new LinkCryptoError('transport_closed', 'Транспорт закрыт во время сопряжения'));
  const onError = (err) => fail(new LinkCryptoError('transport_error', err?.message || 'Ошибка транспорта сопряжения'));

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('close', onClose);
  stream.on('error', onError);

  return {
    send(frame) {
      if (detached || stream.destroyed || stream.writableEnded) {
        return Promise.reject(new LinkCryptoError('transport_closed', 'Транспорт сопряжения закрыт'));
      }
      const line = `${JSON.stringify(frame)}\n`;
      return new Promise((resolve, reject) => {
        try {
          stream.write(line, 'utf8', (err) => {
            if (err) {
              reject(err instanceof LinkCryptoError ? err : new LinkCryptoError('transport_closed', err?.message || 'Транспорт сопряжения закрыт'));
            } else {
              resolve();
            }
          });
        } catch (err) {
          reject(err instanceof LinkCryptoError ? err : new LinkCryptoError('transport_closed', err?.message || 'Транспорт сопряжения закрыт'));
        }
      });
    },
    nextFrame(timeoutMs) {
      if (detached) {
        return Promise.reject(new LinkCryptoError('transport_closed', 'Читатель до TLS уже отключён'));
      }
      if (firstLineNlAt !== -1) {
        try {
          return Promise.resolve(consumeOneLine());
        } catch (err) {
          closedErr = closedErr || err;
          return Promise.reject(err);
        }
      }
      if (closedErr) {
        return Promise.reject(closedErr);
      }
      if (streamEnded || stream.readableEnded || stream.destroyed) {
        return Promise.reject(new LinkCryptoError('transport_closed', 'Транспорт закрыт во время сопряжения'));
      }
      if (typeof stream.resume === 'function') {
        stream.resume();
      }
      return new Promise((resolve, reject) => {
        let timer = null;
        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        };
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timer = setTimeout(() => {
            if (waiter && waiter.reject === rejectHandler) {
              waiter = null;
            }
            reject(new LinkCryptoError('pairing_timeout', 'Таймаут фазы сопряжения'));
          }, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }
        const rejectHandler = (err) => {
          cleanup();
          reject(err);
        };
        waiter = {
          resolve: (frame) => { cleanup(); resolve(frame); },
          reject: rejectHandler,
        };
      });
    },
    detachForTls() {
      if (detached) {
        return { leftover: Buffer.alloc(0), ended: streamEnded };
      }
      detached = true;
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onClose);
      stream.off('error', onError);
      if (waiter) {
        rejectWaiter(new LinkCryptoError('transport_closed', 'Переключение потока на TLS'));
      }
      const leftover = chunks.length === 0
        ? Buffer.alloc(0)
        : (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
      chunks = [];
      totalBytes = 0;
      firstLineNlAt = -1;
      return { leftover, ended: streamEnded };
    },
  };
}

function parseHexBytes(hex, expectedBytes, code, message) {
  if (typeof hex !== 'string' || hex.length !== expectedBytes * 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new LinkCryptoError(code, message);
  }
  return Buffer.from(hex, 'hex');
}

async function runPairingSession({
  transport,
  role,
  roomId,
  identity,
  expectedPeer,
  peerStore,
  onConfirmSas,
  cooldownTracker = null,
  phaseTimeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
  confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
  handshakeTimeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
  allowReplace = false,
  allowCaChange = false,
  signal = null,
  now = Date.now,
} = {}) {
  if (role !== 'host' && role !== 'client') {
    throw new LinkCryptoError('invalid_pairing_role', 'Роль сопряжения должна быть "host" или "client"');
  }
  if (!transport) {
    throw new LinkCryptoError('invalid_stream', 'Требуется транспортный поток для сопряжения');
  }
  if (typeof onConfirmSas !== 'function') {
    throw new LinkCryptoError('confirmation_required', 'Автоматическое сопряжение без подтверждения владельца запрещено');
  }
  if (!identity || typeof identity.getTlsCredentials !== 'function' || typeof identity.signProof !== 'function') {
    throw new LinkCryptoError('invalid_identity', 'Требуется корректный объект DeviceIdentity');
  }
  if (!peerStore || typeof peerStore.trustPeer !== 'function') {
    throw new LinkCryptoError('invalid_peer_store', 'Требуется PeerTrustStore');
  }
  if (!expectedPeer || typeof expectedPeer !== 'object') {
    throw new LinkCryptoError('invalid_expected_peer', 'Требуются метаданные ожидаемого пира');
  }
  if (signal && signal.aborted) {
    throw new LinkCryptoError('pairing_aborted', 'Сопряжение отменено до запуска');
  }

  assertRoomId(roomId);
  const expectedPeerId = assertUuidV4(expectedPeer.deviceId, 'expectedPeer.deviceId');
  const expectedPeerName = normalizeDeviceName(expectedPeer.deviceName);
  const creds = identity.getTlsCredentials();
  if (creds.deviceId === expectedPeerId) {
    throw new LinkCryptoError('self_pairing_forbidden', 'Нельзя сопрячь устройство с самим собой');
  }

  const startNow = now();
  const slotKey = `${creds.deviceId}->${expectedPeerId}`;
  if (ACTIVE_PAIRING_SLOTS.has(slotKey)) {
    throw new LinkCryptoError(
      'pairing_in_progress',
      'Для этого устройства уже выполняется активное сопряжение',
    );
  }

  let releaseTrackerSlot = null;
  if (cooldownTracker && typeof cooldownTracker.tryAcquire === 'function') {
    releaseTrackerSlot = cooldownTracker.tryAcquire(expectedPeerId, startNow);
  } else if (cooldownTracker) {
    cooldownTracker.assertAllowed(expectedPeerId, startNow);
  }

  const slotToken = Symbol('pairing_slot');
  ACTIVE_PAIRING_SLOTS.set(slotKey, slotToken);

  const releaseAllSlots = () => {
    if (ACTIVE_PAIRING_SLOTS.get(slotKey) === slotToken) {
      ACTIVE_PAIRING_SLOTS.delete(slotKey);
    }
    if (releaseTrackerSlot) {
      const fn = releaseTrackerSlot;
      releaseTrackerSlot = null;
      fn();
    }
  };

  if (typeof peerStore.sync === 'function') {
    peerStore.sync();
  }
  const existingPeer = typeof peerStore.getPeer === 'function' ? peerStore.getPeer(expectedPeerId) : null;
  if (existingPeer && existingPeer.revokedAt !== null && existingPeer.revokedAt !== undefined && !allowReplace) {
    releaseAllSlots();
    throw new LinkCryptoError(
      'peer_revoked',
      'Устройство было отозвано; для нового сопряжения требуется явная замена (allowReplace)',
    );
  }

  const ownNonce = crypto.randomBytes(32);
  const ownCommit = computePairCommit({
    roomId,
    role,
    deviceId: creds.deviceId,
    deviceName: creds.deviceName,
    caPem: creds.caPem,
    leafPem: creds.leafPem,
    nonce: ownNonce,
  });

  const preReader = createPreTlsLineReader(transport);
  let tlsSession = null;
  let countFailureForCooldown = false;
  const sessionAbortController = new AbortController();
  const onExternalAbort = () => {
    const abortErr = new LinkCryptoError('pairing_aborted', 'Сопряжение прервано внешним сигналом');
    sessionAbortController.abort(abortErr);
    if (tlsSession) {
      tlsSession.forceAbort(abortErr);
    } else if (!transport.destroyed) {
      try { transport.destroy(abortErr); } catch { /* ignore */ }
    }
  };
  if (signal) {
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    // ── Фаза 1: Commit (до раскрытия данных) ────────────────────────────
    await preReader.send({
      v: 3,
      type: 'pair_commit',
      commit: ownCommit.toString('hex'),
    });

    const commitFrame = await preReader.nextFrame(phaseTimeoutMs);
    if (commitFrame.type === 'pair_reveal') {
      throw new LinkCryptoError(
        'protocol_violation_reveal_before_commit',
        'Нарушение протокола: раскрытие получено до commit',
      );
    }
    if (commitFrame.type !== 'pair_commit') {
      throw new LinkCryptoError('unexpected_pairing_frame', 'Ожидался кадр pair_commit');
    }
    const peerCommit = parseHexBytes(
      commitFrame.commit,
      32,
      'invalid_commit',
      'Некорректный формат commit пира',
    );

    // ── Фаза 2: Reveal и полная проверка сертификатов ──────────────────
    await preReader.send({
      v: 3,
      type: 'pair_reveal',
      role,
      deviceId: creds.deviceId,
      deviceName: creds.deviceName,
      caPem: creds.caPem,
      leafPem: creds.leafPem,
      nonce: ownNonce.toString('hex'),
    });

    const revealFrame = await preReader.nextFrame(phaseTimeoutMs);
    if (revealFrame.type !== 'pair_reveal') {
      throw new LinkCryptoError('unexpected_pairing_frame', 'Ожидался кадр pair_reveal');
    }

    const expectedPeerRole = role === 'host' ? 'client' : 'host';
    if (revealFrame.role !== expectedPeerRole) {
      throw new LinkCryptoError('peer_role_mismatch', 'Роль пира в pair_reveal не противоположна нашей');
    }
    if (revealFrame.deviceId !== expectedPeerId) {
      throw new LinkCryptoError('peer_device_id_mismatch', 'deviceId пира не совпадает с ожидаемым');
    }
    const revealedPeerName = normalizeDeviceName(revealFrame.deviceName);
    if (revealedPeerName !== expectedPeerName) {
      throw new LinkCryptoError('peer_name_mismatch', 'Имя устройства пира не совпадает с приглашением');
    }
    const peerNonce = parseHexBytes(
      revealFrame.nonce,
      32,
      'invalid_peer_nonce',
      'Некорректный nonce пира',
    );

    const recomputedPeerCommit = computePairCommit({
      roomId,
      role: expectedPeerRole,
      deviceId: expectedPeerId,
      deviceName: revealedPeerName,
      caPem: revealFrame.caPem,
      leafPem: revealFrame.leafPem,
      nonce: peerNonce,
    });
    if (!crypto.timingSafeEqual(peerCommit, recomputedPeerCommit)) {
      throw new LinkCryptoError('commit_mismatch', 'Данные pair_reveal не соответствуют ранее полученному commit');
    }

    const peerCertInfo = verifyDeviceCertPair({
      deviceId: expectedPeerId,
      caPem: revealFrame.caPem,
      leafPem: revealFrame.leafPem,
      nowMs: now(),
    });

    if (typeof peerStore.sync === 'function') {
      peerStore.sync();
    }
    const latestExisting = typeof peerStore.getPeer === 'function' ? peerStore.getPeer(expectedPeerId) : null;
    if (latestExisting && latestExisting.revokedAt !== null && latestExisting.revokedAt !== undefined && !allowReplace) {
      throw new LinkCryptoError(
        'peer_revoked',
        'Устройство было отозвано; для нового сопряжения требуется явная замена (allowReplace)',
      );
    }
    const sameCa = latestExisting && latestExisting.rootCaFp256
      ? fingerprintsEqual(latestExisting.rootCaFp256, peerCertInfo.caFp256)
      : true;
    const sameLeaf = latestExisting && latestExisting.leafFp256
      ? fingerprintsEqual(latestExisting.leafFp256, peerCertInfo.leafFp256)
      : true;
    if (latestExisting && (!sameCa || !sameLeaf) && !allowReplace) {
      throw new LinkCryptoError(
        'peer_pin_conflict',
        'Устройство уже сопряжено с другими сертификатами; для замены требуется явное разрешение владельца (allowReplace)',
      );
    }
    if (latestExisting && !sameCa && allowReplace && !allowCaChange) {
      throw new LinkCryptoError(
        'ca_pin_mismatch',
        'Root CA устройства отличается от закреплённого; молчаливая подмена CA запрещена (требуется allowCaChange)',
      );
    }
    const certChange = !latestExisting
      ? 'new_peer'
      : (latestExisting.revokedAt !== null && latestExisting.revokedAt !== undefined
          ? 'replace_revoked'
          : (!sameCa ? 'ca_changed' : (!sameLeaf ? 'leaf_changed' : 'unchanged')));

    // Переключаем канал на взаимный TLS 1.3 с обязательным пином leaf + CA до передачи любого байта.
    const { leftover, ended } = preReader.detachForTls();
    if (sessionAbortController.signal.aborted) {
      throw sessionAbortController.signal.reason;
    }
    const tlsTransport = asDuplex(transport, { initialBuffer: leftover, ended });
    const tlsRole = role === 'host' ? 'server' : 'client';
    tlsSession = await establishMutualTls({
      stream: tlsTransport,
      role: tlsRole,
      identity,
      expectedPeer: {
        deviceId: expectedPeerId,
        rootCaPem: peerCertInfo.caPem,
        leafFp256: peerCertInfo.leafFp256,
      },
      peerStore: null, // На этапе сопряжения пир ещё не записан в peers.json.
      handshakeTimeoutMs,
      heartbeatIntervalMs: 0,
      idleTimeoutMs: Math.max(phaseTimeoutMs, confirmTimeoutMs) + 10_000,
      now,
    });

    // ── Фаза 3: Канонический транскрипт + Proof-of-Possession внутри mTLS ──
    const ownPart = {
      deviceId: creds.deviceId,
      deviceName: creds.deviceName,
      caFp256Bytes: fingerprint256Raw(creds.caPem),
      leafFp256Bytes: fingerprint256Raw(creds.leafPem),
      nonce: ownNonce,
    };
    const peerPart = {
      deviceId: expectedPeerId,
      deviceName: revealedPeerName,
      caFp256Bytes: fingerprint256Raw(peerCertInfo.caPem),
      leafFp256Bytes: fingerprint256Raw(peerCertInfo.leafPem),
      nonce: peerNonce,
    };
    const hostPart = role === 'host' ? ownPart : peerPart;
    const clientPart = role === 'client' ? ownPart : peerPart;

    const transcriptHash = computeTranscriptHash({
      roomId,
      host: hostPart,
      client: clientPart,
    });
    const transcriptHex = transcriptHash.toString('hex');

    const popPayload = Buffer.concat([Buffer.from('NOX-PAIR-POP-V3', 'utf8'), transcriptHash]);
    const ownPopSig = identity.signProof(popPayload);

    const peerPopPromise = tlsSession.waitNextFrame({
      timeoutMs: phaseTimeoutMs,
      predicate: (f) => f.type === 'pair_pop' || f.type === 'sas_abort',
    });
    await tlsSession.sendFrame({
      v: 3,
      type: 'pair_pop',
      transcriptHash: transcriptHex,
      signature: ownPopSig.toString('base64'),
    });
    const peerPopFrame = await peerPopPromise;
    if (peerPopFrame.type === 'sas_abort') {
      throw new LinkCryptoError('peer_aborted_pairing', 'Пир прервал сопряжение');
    }
    const peerPopTranscript = parseHexBytes(
      peerPopFrame.transcriptHash,
      32,
      'transcript_mismatch',
      'Некорректный транскрипт PoP пира',
    );
    if (!crypto.timingSafeEqual(peerPopTranscript, transcriptHash)) {
      throw new LinkCryptoError('transcript_mismatch', 'Хэш транскрипта сопряжения не совпал');
    }
    if (typeof peerPopFrame.signature !== 'string' || !peerPopFrame.signature) {
      throw new LinkCryptoError('invalid_pop_signature', 'Отсутствует подпись PoP пира');
    }
    const peerPopSigBuf = Buffer.from(peerPopFrame.signature, 'base64');
    if (!verifyWithLeafCert(peerCertInfo.leafPem, popPayload, peerPopSigBuf)) {
      throw new LinkCryptoError('pop_verification_failed', 'Подпись доказательства владения ключом (PoP) недействительна');
    }

    // ── Фаза 4: SAS, обязательное подтверждение владельца и финальный sas_complete ──
    const sasCode = deriveSasCode({
      transcriptHash,
      hostNonce: hostPart.nonce,
      clientNonce: clientPart.nonce,
      roomId,
      hostDeviceName: hostPart.deviceName,
      clientDeviceName: clientPart.deviceName,
    });

    const peerConfirmPromise = tlsSession.waitNextFrame({
      timeoutMs: confirmTimeoutMs,
      predicate: (f) => f.type === 'sas_confirm' || f.type === 'sas_abort',
    });
    peerConfirmPromise.catch(() => {});

    countFailureForCooldown = true;

    const confirmAbort = new AbortController();
    const confirmExpiresAt = Number.isFinite(confirmTimeoutMs) && confirmTimeoutMs > 0
      ? now() + confirmTimeoutMs
      : null;

    let confirmTimer = null;
    let onAbortSessionSync = null;
    let unsubscribeClose = null;
    let ownerDecision;

    try {
      const abortWaitPromise = new Promise((_, reject) => {
        const triggerAbort = (reasonErr) => {
          const err = reasonErr instanceof Error
            ? reasonErr
            : new LinkCryptoError('confirmation_timeout', 'Истекло время подтверждения кода SAS');
          if (!confirmAbort.signal.aborted) {
            confirmAbort.abort(err);
          }
          reject(err);
        };

        if (sessionAbortController.signal.aborted) {
          triggerAbort(sessionAbortController.signal.reason);
          return;
        }
        onAbortSessionSync = () => triggerAbort(sessionAbortController.signal.reason);
        sessionAbortController.signal.addEventListener('abort', onAbortSessionSync, { once: true });

        unsubscribeClose = tlsSession.onClose((err) => {
          triggerAbort(err instanceof LinkCryptoError ? err : new LinkCryptoError('connection_closed', 'Соединение закрыто во время подтверждения SAS'));
        });

        peerConfirmPromise.then(
          (frame) => {
            if (frame && frame.type === 'sas_abort') {
              triggerAbort(new LinkCryptoError('peer_sas_rejected', 'Второе устройство отклонило код SAS'));
            }
          },
          (err) => triggerAbort(err),
        );

        if (Number.isFinite(confirmTimeoutMs) && confirmTimeoutMs > 0) {
          confirmTimer = setTimeout(() => {
            triggerAbort(new LinkCryptoError('confirmation_timeout', 'Истекло время ожидания подтверждения кода SAS'));
          }, confirmTimeoutMs);
          if (typeof confirmTimer.unref === 'function') confirmTimer.unref();
        }
      });
      abortWaitPromise.catch(() => {});

      const decisionPromise = Promise.resolve().then(() => onConfirmSas({
        sasCode,
        remoteDeviceId: expectedPeerId,
        remoteDeviceName: revealedPeerName,
        localDeviceId: creds.deviceId,
        localDeviceName: creds.deviceName,
        roomId,
        transcriptHash: transcriptHex,
        localRole: role,
        certChange,
        peerRootCaFp256: peerCertInfo.caFp256,
        peerLeafFp256: peerCertInfo.leafFp256,
        expiresAt: confirmExpiresAt,
        signal: confirmAbort.signal,
      })).catch((err) => {
        if (confirmAbort.signal.aborted) {
          throw confirmAbort.signal.reason;
        }
        return { confirmed: false, error: err };
      });

      ownerDecision = await Promise.race([decisionPromise, abortWaitPromise]);
    } catch (err) {
      if (err instanceof LinkCryptoError && err.code === 'confirmation_timeout') {
        try {
          await tlsSession.sendFrame({ v: 3, type: 'sas_abort', reason: 'confirmation_timeout' });
        } catch { /* ignore */ }
      }
      throw err;
    } finally {
      if (confirmTimer) {
        clearTimeout(confirmTimer);
        confirmTimer = null;
      }
      if (onAbortSessionSync) {
        sessionAbortController.signal.removeEventListener('abort', onAbortSessionSync);
      }
      if (unsubscribeClose) {
        unsubscribeClose();
      }
    }

    if (!ownerDecision || ownerDecision.confirmed !== true) {
      try {
        await tlsSession.sendFrame({ v: 3, type: 'sas_abort', reason: 'owner_rejected' });
      } catch { /* ignore */ }
      throw new LinkCryptoError('sas_rejected', 'Владелец отклонил подтверждение кода SAS');
    }

    await tlsSession.sendFrame({
      v: 3,
      type: 'sas_confirm',
      ok: true,
      transcriptHash: transcriptHex,
    });

    const peerConfirmFrame = await peerConfirmPromise;
    if (peerConfirmFrame.type === 'sas_abort' || peerConfirmFrame.ok !== true) {
      throw new LinkCryptoError('peer_sas_rejected', 'Второе устройство отклонило код SAS');
    }
    const peerConfirmTranscript = parseHexBytes(
      peerConfirmFrame.transcriptHash,
      32,
      'transcript_mismatch',
      'Некорректный транскрипт подтверждения SAS',
    );
    if (!crypto.timingSafeEqual(peerConfirmTranscript, transcriptHash)) {
      throw new LinkCryptoError('transcript_mismatch', 'Транскрипт подтверждения SAS не совпал');
    }

    // Финальное взаимное подтверждение завершения SAS перед записью доверия на диск.
    const peerCompletePromise = tlsSession.waitNextFrame({
      timeoutMs: phaseTimeoutMs,
      predicate: (f) => f.type === 'sas_complete' || f.type === 'sas_abort',
    });
    peerCompletePromise.catch(() => {});

    await tlsSession.sendFrame({
      v: 3,
      type: 'sas_complete',
      ok: true,
      transcriptHash: transcriptHex,
    });

    const peerCompleteFrame = await peerCompletePromise;
    if (peerCompleteFrame.type === 'sas_abort' || peerCompleteFrame.ok !== true) {
      throw new LinkCryptoError('peer_sas_rejected', 'Второе устройство прервало завершение сопряжения SAS');
    }
    const peerCompleteTranscript = parseHexBytes(
      peerCompleteFrame.transcriptHash,
      32,
      'transcript_mismatch',
      'Некорректный транскрипт завершения SAS',
    );
    if (!crypto.timingSafeEqual(peerCompleteTranscript, transcriptHash)) {
      throw new LinkCryptoError('transcript_mismatch', 'Транскрипт завершения SAS не совпал');
    }

    // Только после получения sas_complete с ОБЕИХ сторон записываем доверие в peers.json.
    const peerRecord = peerStore.trustPeer({
      deviceId: expectedPeerId,
      deviceName: revealedPeerName,
      caPem: peerCertInfo.caPem,
      leafPem: peerCertInfo.leafPem,
      nowMs: now(),
      allowReplace,
      allowCaChange,
    });
    countFailureForCooldown = false;
    if (cooldownTracker) {
      cooldownTracker.recordSuccess(expectedPeerId, now());
    }

    await tlsSession.close();
    return {
      ok: true,
      sasCode,
      transcriptHash: transcriptHex,
      certChange,
      peer: peerRecord,
    };
  } catch (err) {
    preReader.detachForTls();
    if (countFailureForCooldown && cooldownTracker) {
      cooldownTracker.recordFailure(expectedPeerId, now());
    }
    if (tlsSession) {
      tlsSession.forceAbort(err);
    } else if (!transport.destroyed) {
      try { transport.destroy(); } catch { /* ignore */ }
    }
    if (sessionAbortController.signal.aborted && err instanceof LinkCryptoError && err.code === 'transport_closed') {
      throw sessionAbortController.signal.reason;
    }
    throw err;
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
    releaseAllSlots();
  }
}

async function sendLeafUpdateOverSession(session, {
  identity = null,
  envelope = null,
  timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
  signal = null,
} = {}) {
  if (!session || typeof session.sendFrame !== 'function' || typeof session.waitNextFrame !== 'function') {
    throw new LinkCryptoError('invalid_session', 'Требуется активная сессия LinkTlsSession');
  }
  const env = envelope || identity?.pendingLeafUpdate;
  if (!env || typeof env !== 'object' || env.v !== 3 || env.type !== 'leaf_update') {
    throw new LinkCryptoError('invalid_leaf_update', 'Отсутствует подписанный конверт обновления leaf-сертификата');
  }
  if (signal && signal.aborted) {
    throw new LinkCryptoError('cert_update_aborted', 'Отправка обновления сертификата прервана');
  }

  const waitPromise = session.waitNextFrame({
    timeoutMs,
    predicate: (f) => f.type === 'leaf_update_ack' || f.type === 'leaf_update_rejected',
  });

  let onAbort = null;
  let abortRace = null;
  if (signal) {
    abortRace = new Promise((_, reject) => {
      onAbort = () => reject(new LinkCryptoError('cert_update_aborted', 'Отправка обновления сертификата прервана'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    abortRace.catch(() => {});
  }

  try {
    await session.sendFrame(env);
    const ack = abortRace ? await Promise.race([waitPromise, abortRace]) : await waitPromise;
    if (ack.type === 'leaf_update_rejected') {
      throw new LinkCryptoError(
        typeof ack.code === 'string' && ack.code ? ack.code : 'cert_update_rejected',
        typeof ack.message === 'string' && ack.message ? ack.message : 'Пир отклонил обновление сертификата',
      );
    }
    if (ack.ok !== true || !ack.newLeafFp256 || !fingerprintsEqual(ack.newLeafFp256, env.newLeafFp256)) {
      throw new LinkCryptoError('invalid_leaf_update', 'Пир вернул некорректное подтверждение обновления сертификата');
    }
    return {
      ok: true,
      deviceId: session.peerDeviceId,
      newLeafFp256: env.newLeafFp256,
      ack,
    };
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

async function acceptLeafUpdateOverSession(session, {
  peerStore,
  envelope = null,
  onConfirmCertUpdate,
  timeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
  confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
  signal = null,
  requirePreviousLeafSig = true,
  now = Date.now,
} = {}) {
  if (!session || typeof session.sendFrame !== 'function' || typeof session.waitNextFrame !== 'function') {
    throw new LinkCryptoError('invalid_session', 'Требуется активная сессия LinkTlsSession');
  }
  if (!peerStore || typeof peerStore.confirmAndUpdatePeerLeaf !== 'function') {
    throw new LinkCryptoError('invalid_peer_store', 'Требуется PeerTrustStore');
  }
  if (typeof onConfirmCertUpdate !== 'function') {
    throw new LinkCryptoError(
      'confirmation_required',
      'Автоматическое принятие нового сертификата без подтверждения владельца запрещено',
    );
  }

  const frame = envelope || await session.waitNextFrame({
    timeoutMs,
    predicate: (f) => f.type === 'leaf_update',
  });

  try {
    const updated = await peerStore.confirmAndUpdatePeerLeaf(session.peerDeviceId, {
      envelope: frame,
      onConfirmCertUpdate,
      nowMs: now(),
      confirmTimeoutMs,
      signal,
      requirePreviousLeafSig,
    });
    await session.sendFrame({
      v: 3,
      type: 'leaf_update_ack',
      ok: true,
      deviceId: session.peerDeviceId,
      newLeafFp256: updated.leafFp256,
    });
    return updated;
  } catch (err) {
    try {
      await session.sendFrame({
        v: 3,
        type: 'leaf_update_rejected',
        code: err instanceof LinkCryptoError ? err.code : 'cert_update_rejected',
        message: err?.message || 'Обновление сертификата отклонено',
      });
    } catch { /* ignore */ }
    throw err;
  }
}

module.exports = {
  DEFAULT_PHASE_TIMEOUT_MS,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_FAILURES,
  lengthPrefixed,
  computePairCommit,
  computeTranscriptHash,
  deriveSasCode,
  PairingCooldownTracker,
  runPairingSession,
  sendLeafUpdateOverSession,
  acceptLeafUpdateOverSession,
  verifyLeafUpdateEnvelope,
};
