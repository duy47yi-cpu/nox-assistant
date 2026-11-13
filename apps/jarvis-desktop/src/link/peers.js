'use strict';

// Хранилище доверенных устройств Nox Link:
// единый источник состояния доверия в процессе, согласование изменений на диске с блокировкой,
// безопасная обработка внешних правок peers.json, немедленный отзыв активных сеансов и подтверждённое обновление листа.
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
  sleepSyncMs,
} = require('./errors');
const { verifyDeviceCertPair, fingerprintsEqual, hexToFpBuffer } = require('./pki');
const { verifyLeafUpdateEnvelope } = require('./identity');

const STORE_CORES = new Map();
const ACTIVE_POLL_INTERVAL_MS = 50;

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function validateAndBuildPeerMap(rawText) {
  const parsed = parseSafeJson(rawText);
  if (!parsed || parsed.v !== 3 || !parsed.peers || typeof parsed.peers !== 'object' || Array.isArray(parsed.peers)) {
    throw new LinkCryptoError('peers_corrupted', 'Повреждён формат файла доверенных устройств');
  }
  const rev = parsed.rev === undefined ? 0 : parsed.rev;
  if (!Number.isSafeInteger(rev) || rev < 0) {
    throw new LinkCryptoError('peers_corrupted', 'Некорректный номер ревизии списка доверенных устройств');
  }

  const map = new Map();
  for (const [id, rec] of Object.entries(parsed.peers)) {
    assertUuidV4(id, 'peerDeviceId');
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new LinkCryptoError('peers_corrupted', 'Повреждена запись доверенного устройства');
    }
    if (rec.deviceId !== undefined && rec.deviceId !== id) {
      throw new LinkCryptoError('peers_corrupted', 'Несогласованный deviceId в записи доверенного устройства');
    }
    const isRevoked = rec.revokedAt !== null && rec.revokedAt !== undefined;
    if (isRevoked && !Number.isFinite(rec.revokedAt)) {
      throw new LinkCryptoError('peers_corrupted', 'Некорректная метка времени отзыва устройства');
    }
    if (!isRevoked) {
      if (typeof rec.rootCaPem !== 'string' || typeof rec.leafPem !== 'string'
        || !hexToFpBuffer(rec.rootCaFp256) || !hexToFpBuffer(rec.leafFp256)) {
        throw new LinkCryptoError('peers_corrupted', 'У активного доверенного устройства отсутствуют обязательные пины');
      }
    }
    map.set(id, { ...rec, deviceId: id });
  }
  return { rev, map };
}

function readFileWithTransientRetry(filePath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') && attempt < 4) {
        sleepSyncMs(5 + attempt * 5);
        continue;
      }
      throw new LinkCryptoError('peers_read_failed', 'Не удалось прочитать список доверенных устройств');
    }
  }
  throw new LinkCryptoError('peers_read_failed', 'Не удалось прочитать список доверенных устройств');
}

class PeerStoreCore {
  constructor(filePath) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.peers = new Map();
    this.rev = 0;
    this.lastFileHash = null;
    this.corruptedError = null;
    this.revokeListeners = new Set();
    this.watcher = null;
    this.pollTimer = null;
    this.retryTimer = null;
    this._syncing = false;
  }

  addRevokeListener(listener) {
    if (typeof listener !== 'function') return () => {};
    this.revokeListeners.add(listener);
    this._ensureWatchers();
    return () => {
      this.revokeListeners.delete(listener);
      this._stopWatchersIfIdle();
    };
  }

  _emitRevocations(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    for (const ev of events) {
      for (const listener of [...this.revokeListeners]) {
        try {
          listener(ev);
        } catch { /* слушатель не должен срывать отзыв */ }
      }
    }
  }

  _collectTrustedIds() {
    const ids = [];
    for (const [id, rec] of this.peers.entries()) {
      if (rec.revokedAt === null || rec.revokedAt === undefined) {
        ids.push(id);
      }
    }
    return ids;
  }

  syncFromDisk({ fromBackground = false } = {}) {
    if (this._syncing) return;
    this._syncing = true;
    try {
      const raw = readFileWithTransientRetry(this.filePath);
      if (raw === null) {
        const hadFile = this.lastFileHash !== null && this.lastFileHash !== 'MISSING';
        this.lastFileHash = 'MISSING';
        this.corruptedError = null;
        if (hadFile) {
          const lostIds = this._collectTrustedIds();
          this.peers.clear();
          this.rev = 0;
          if (lostIds.length > 0) {
            const now = Date.now();
            this._emitRevocations(lostIds.map((deviceId) => ({
              deviceId,
              by: 'external',
              reason: 'trust_store_removed',
              revokedAt: now,
            })));
          }
        }
        return;
      }

      const hash = sha256Text(raw);
      if (hash === this.lastFileHash && !this.corruptedError) {
        return;
      }

      let parsed;
      try {
        parsed = validateAndBuildPeerMap(raw);
      } catch (err) {
        const cryptoErr = err instanceof LinkCryptoError
          ? err
          : new LinkCryptoError('peers_corrupted', 'Повреждён формат файла доверенных устройств');
        if (fromBackground) {
          // Если внешний редактор пишет неатомарно, даём одну короткую паузу перед фиксацией порчи.
          if (!this.retryTimer) {
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              try {
                this.syncFromDisk({ fromBackground: false });
              } catch (finalErr) {
                this._handleBackgroundCorruption(finalErr);
              }
            }, 25);
            if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
          }
          return;
        }
        this.corruptedError = cryptoErr;
        throw cryptoErr;
      }

      const revocations = [];
      for (const [id, prevRec] of this.peers.entries()) {
        const wasActive = prevRec.revokedAt === null || prevRec.revokedAt === undefined;
        if (!wasActive) continue;
        const nextRec = parsed.map.get(id);
        if (!nextRec) {
          revocations.push({
            deviceId: id,
            by: 'external',
            reason: 'peer_removed',
            revokedAt: Date.now(),
          });
          continue;
        }
        if (nextRec.revokedAt !== null && nextRec.revokedAt !== undefined) {
          revocations.push({
            deviceId: id,
            by: nextRec.revokedBy || 'external',
            reason: nextRec.revokeReason || 'revoked',
            revokedAt: nextRec.revokedAt,
          });
          continue;
        }
        if (prevRec.rootCaFp256 && !fingerprintsEqual(prevRec.rootCaFp256, nextRec.rootCaFp256)) {
          revocations.push({
            deviceId: id,
            by: 'external',
            reason: 'ca_pin_changed',
            revokedAt: Date.now(),
          });
        }
      }

      this.peers.clear();
      for (const [id, rec] of parsed.map.entries()) {
        this.peers.set(id, rec);
      }
      this.rev = parsed.rev;
      this.lastFileHash = hash;
      this.corruptedError = null;
      if (revocations.length > 0) {
        this._emitRevocations(revocations);
      }
    } finally {
      this._syncing = false;
    }
  }

  _handleBackgroundCorruption(err) {
    this.corruptedError = err;
    const activeIds = this._collectTrustedIds();
    if (activeIds.length > 0) {
      const now = Date.now();
      this._emitRevocations(activeIds.map((deviceId) => ({
        deviceId,
        by: 'external',
        reason: 'peers_corrupted',
        revokedAt: now,
      })));
    }
  }

  _backgroundSync() {
    try {
      this.syncFromDisk({ fromBackground: true });
    } catch (err) {
      this._handleBackgroundCorruption(err);
    }
  }

  _ensureWatchers() {
    if (this.revokeListeners.size === 0) return;
    if (!this.watcher) {
      try {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const targetBase = path.basename(this.filePath);
        this.watcher = fs.watch(dir, (_, filename) => {
          if (!filename || String(filename) === targetBase) {
            this._backgroundSync();
          }
        });
        this.watcher.on('error', () => { /* fallback poll remains active */ });
        if (typeof this.watcher.unref === 'function') this.watcher.unref();
      } catch {
        this.watcher = null;
      }
    }
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this._backgroundSync(), ACTIVE_POLL_INTERVAL_MS);
      if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    }
  }

  _stopWatchersIfIdle() {
    if (this.revokeListeners.size > 0) return;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  mutateLocked(mutator) {
    return withFileLockSync(this.lockPath, () => {
      // Внутри блокировки обязательно подтягиваем свежее состояние с диска, чтобы не затереть чужие изменения.
      this.syncFromDisk({ fromBackground: false });
      const result = mutator();
      const obj = {};
      for (const [id, rec] of this.peers.entries()) {
        obj[id] = rec;
      }
      this.rev += 1;
      const serialized = JSON.stringify({ v: 3, rev: this.rev, peers: obj }, null, 2);
      atomicWriteFileSync(this.filePath, serialized);
      this.lastFileHash = sha256Text(serialized);
      this.corruptedError = null;
      return result;
    });
  }

  close() {
    this.revokeListeners.clear();
    this._stopWatchersIfIdle();
  }
}

function getCoreForDataDir(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new LinkCryptoError('invalid_data_dir', 'Требуется корректный каталог данных для списка пиров');
  }
  const filePath = path.join(dataDir, 'link', 'peers.json');
  const key = canonicalizePath(filePath);
  let core = STORE_CORES.get(key);
  if (!core) {
    core = new PeerStoreCore(filePath);
    STORE_CORES.set(key, core);
  }
  return core;
}

class PeerTrustStore {
  #core;
  #ownSubscriptions = new Set();

  constructor({ dataDir }) {
    this.#core = getCoreForDataDir(dataDir);
    this.filePath = this.#core.filePath;
    this.#core.syncFromDisk({ fromBackground: false });
  }

  get peers() {
    return this.#core.peers;
  }

  sync() {
    this.#core.syncFromDisk({ fromBackground: false });
  }

  close() {
    for (const unsub of [...this.#ownSubscriptions]) {
      unsub();
    }
    this.#ownSubscriptions.clear();
  }

  onRevoke(listener) {
    if (typeof listener !== 'function') return () => {};
    const unsub = this.#core.addRevokeListener(listener);
    this.#ownSubscriptions.add(unsub);
    return () => {
      this.#ownSubscriptions.delete(unsub);
      unsub();
    };
  }

  getPeer(deviceId) {
    assertUuidV4(deviceId, 'peerDeviceId');
    this.#core.syncFromDisk({ fromBackground: false });
    const rec = this.#core.peers.get(deviceId);
    return rec ? { ...rec } : null;
  }

  listPeers() {
    this.#core.syncFromDisk({ fromBackground: false });
    return [...this.#core.peers.values()].map((rec) => ({ ...rec }));
  }

  requireTrustedPeer(deviceId, { nowMs = Date.now() } = {}) {
    assertUuidV4(deviceId, 'peerDeviceId');
    this.#core.syncFromDisk({ fromBackground: false });
    const rec = this.#core.peers.get(deviceId);
    if (!rec) {
      throw new LinkCryptoError('peer_not_trusted', 'Устройство не входит в список доверенных');
    }
    if (rec.revokedAt !== null && rec.revokedAt !== undefined) {
      throw new LinkCryptoError('peer_revoked', 'Доверие к устройству отозвано');
    }
    if (!hexToFpBuffer(rec.rootCaFp256) || !hexToFpBuffer(rec.leafFp256)) {
      throw new LinkCryptoError('peer_pin_corrupted', 'Закреплённые отпечатки пира повреждены');
    }
    // Проверяем целостность и срок действия закреплённых сертификатов перед подключением.
    const verified = verifyDeviceCertPair({
      deviceId,
      caPem: rec.rootCaPem,
      leafPem: rec.leafPem,
      nowMs,
    });
    if (!fingerprintsEqual(verified.caFp256, rec.rootCaFp256) || !fingerprintsEqual(verified.leafFp256, rec.leafFp256)) {
      throw new LinkCryptoError('peer_pin_corrupted', 'Закреплённые отпечатки пира повреждены');
    }
    return {
      ...rec,
      rootCaPem: verified.caPem,
      leafPem: verified.leafPem,
    };
  }

  trustPeer({
    deviceId,
    deviceName,
    caPem,
    leafPem,
    nowMs = Date.now(),
    allowReplace = false,
    allowCaChange = false,
  }) {
    assertUuidV4(deviceId, 'peerDeviceId');
    const normalizedName = normalizeDeviceName(deviceName);
    const verified = verifyDeviceCertPair({ deviceId, caPem, leafPem, nowMs });

    return this.#core.mutateLocked(() => {
      const existing = this.#core.peers.get(deviceId);
      if (existing) {
        if (existing.revokedAt !== null && existing.revokedAt !== undefined && !allowReplace) {
          throw new LinkCryptoError(
            'peer_revoked',
            'Устройство было отозвано; требуется явная замена / новое сопряжение с SAS',
          );
        }
        const sameCa = existing.rootCaFp256
          ? fingerprintsEqual(existing.rootCaFp256, verified.caFp256)
          : true;
        if (!sameCa) {
          if (!allowReplace) {
            throw new LinkCryptoError(
              'peer_pin_conflict',
              'Устройство уже сопряжено с другим Root CA; молчаливая подмена запрещена',
            );
          }
          if (!allowCaChange) {
            throw new LinkCryptoError(
              'ca_pin_mismatch',
              'Root CA отличается от закреплённого; для смены Root CA требуется явное подтверждение allowCaChange',
            );
          }
        }
        const sameLeaf = existing.leafFp256
          ? fingerprintsEqual(existing.leafFp256, verified.leafFp256)
          : false;
        if ((!sameCa || !sameLeaf) && !allowReplace) {
          throw new LinkCryptoError(
            'peer_pin_conflict',
            'Устройство уже сопряжено с другими сертификатами; молчаливая подмена запрещена',
          );
        }
      }

      const record = {
        deviceId,
        deviceName: normalizedName,
        rootCaPem: verified.caPem,
        rootCaFp256: verified.caFp256,
        leafPem: verified.leafPem,
        leafFp256: verified.leafFp256,
        pairedAt: existing?.pairedAt || nowMs,
        updatedAt: nowMs,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
        previousLeafFp256: existing && existing.leafFp256 && !fingerprintsEqual(existing.leafFp256, verified.leafFp256)
          ? existing.leafFp256
          : (existing?.previousLeafFp256 || null),
      };
      this.#core.peers.set(deviceId, record);
      return { ...record };
    });
  }

  replacePeerCertificate(deviceId, {
    caPem,
    leafPem,
    deviceName,
    by = 'owner',
    allowCaChange = false,
    allowReenable = false,
    nowMs = Date.now(),
  }) {
    assertUuidV4(deviceId, 'peerDeviceId');

    return this.#core.mutateLocked(() => {
      const existing = this.#core.peers.get(deviceId);
      if (!existing) {
        throw new LinkCryptoError('peer_not_trusted', 'Нельзя заменить сертификат неизвестного устройства');
      }
      if (existing.revokedAt !== null && existing.revokedAt !== undefined && !allowReenable) {
        throw new LinkCryptoError(
          'peer_revoked',
          'Устройство отозвано; для восстановления доверия требуется явное переподтверждение',
        );
      }

      const targetCaPem = caPem || existing.rootCaPem;
      const verified = verifyDeviceCertPair({ deviceId, caPem: targetCaPem, leafPem, nowMs });

      if (existing.rootCaFp256 && !fingerprintsEqual(existing.rootCaFp256, verified.caFp256) && !allowCaChange) {
        throw new LinkCryptoError(
          'ca_pin_mismatch',
          'Root CA отличается от закреплённого; для смены Root CA требуется явное подтверждение allowCaChange',
        );
      }

      const record = {
        ...existing,
        deviceName: deviceName ? normalizeDeviceName(deviceName) : existing.deviceName,
        rootCaPem: verified.caPem,
        rootCaFp256: verified.caFp256,
        leafPem: verified.leafPem,
        leafFp256: verified.leafFp256,
        previousLeafFp256: existing.leafFp256,
        updatedAt: nowMs,
        replacedBy: String(by || 'owner'),
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
      };
      this.#core.peers.set(deviceId, record);
      return { ...record };
    });
  }

  async confirmAndUpdatePeerLeaf(deviceId, {
    envelope,
    onConfirmCertUpdate,
    nowMs = Date.now(),
    confirmTimeoutMs = 60_000,
    signal = null,
    requirePreviousLeafSig = true,
  } = {}) {
    assertUuidV4(deviceId, 'peerDeviceId');
    if (typeof onConfirmCertUpdate !== 'function') {
      throw new LinkCryptoError(
        'confirmation_required',
        'Автоматическая замена сертификата доверенного устройства без подтверждения владельца запрещена',
      );
    }

    this.#core.syncFromDisk({ fromBackground: false });
    const existing = this.#core.peers.get(deviceId);
    if (!existing) {
      throw new LinkCryptoError('peer_not_trusted', 'Устройство не входит в список доверенных');
    }
    if (existing.revokedAt !== null && existing.revokedAt !== undefined) {
      throw new LinkCryptoError('peer_revoked', 'Доверие к устройству отозвано; обновление сертификата запрещено');
    }

    const verifiedEnv = verifyLeafUpdateEnvelope({
      envelope,
      expectedPeer: existing,
      nowMs,
      requirePreviousLeafSig,
    });

    const controller = new AbortController();
    let timer = null;
    const onAbortExternal = () => controller.abort(signal?.reason || new LinkCryptoError('cert_update_aborted', 'Обновление сертификата прервано'));
    if (signal) {
      if (signal.aborted) {
        throw new LinkCryptoError('cert_update_aborted', 'Обновление сертификата прервано');
      }
      signal.addEventListener('abort', onAbortExternal, { once: true });
    }

    let decision;
    try {
      const prompt = {
        deviceId,
        deviceName: existing.deviceName,
        rootCaFp256: existing.rootCaFp256,
        previousLeafFp256: existing.leafFp256,
        newLeafFp256: verifiedEnv.newLeafFp256,
        issuedAt: verifiedEnv.issuedAt,
        signal: controller.signal,
      };
      const decisionPromise = Promise.resolve().then(() => onConfirmCertUpdate(prompt));
      const timeoutPromise = new Promise((_, reject) => {
        if (Number.isFinite(confirmTimeoutMs) && confirmTimeoutMs > 0) {
          timer = setTimeout(() => {
            const err = new LinkCryptoError('confirmation_timeout', 'Истекло время ожидания подтверждения обновления сертификата');
            controller.abort(err);
            reject(err);
          }, confirmTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }
      });
      decision = await Promise.race([decisionPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbortExternal);
    }

    if (!decision || decision.confirmed !== true) {
      throw new LinkCryptoError('cert_update_rejected', 'Владелец отклонил обновление сертификата устройства');
    }

    return this.replacePeerCertificate(deviceId, {
      leafPem: verifiedEnv.canonicalNewLeafPem,
      by: 'owner_confirmed_rotation',
      allowCaChange: false,
      allowReenable: false,
      nowMs,
    });
  }

  revokePeer(deviceId, { by = 'owner', reason = 'revoked', nowMs = Date.now() } = {}) {
    assertUuidV4(deviceId, 'peerDeviceId');
    const tombstone = this.#core.mutateLocked(() => {
      const existing = this.#core.peers.get(deviceId);
      const next = existing
        ? {
            ...existing,
            revokedAt: nowMs,
            revokedBy: String(by || 'owner'),
            revokeReason: String(reason || 'revoked'),
            updatedAt: nowMs,
          }
        : {
            deviceId,
            deviceName: null,
            rootCaPem: null,
            rootCaFp256: null,
            leafPem: null,
            leafFp256: null,
            pairedAt: null,
            updatedAt: nowMs,
            revokedAt: nowMs,
            revokedBy: String(by || 'owner'),
            revokeReason: String(reason || 'revoked'),
          };
      this.#core.peers.set(deviceId, next);
      return next;
    });

    this.#core._emitRevocations([{
      deviceId,
      by: tombstone.revokedBy,
      reason: tombstone.revokeReason,
      revokedAt: nowMs,
    }]);
    return { ...tombstone };
  }
}

module.exports = {
  PeerTrustStore,
};
