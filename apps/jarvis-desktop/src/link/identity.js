'use strict';

// Удостоверение устройства Nox Link: жизненный цикл Root CA + Leaf, fail-closed хранение через safeStorage,
// предупредительная ротация и восстановление после истечения leaf, честный сброс при потере профиля/ключа.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const {
  LinkCryptoError,
  assertUuidV4,
  normalizeDeviceName,
  parseSafeJson,
  canonicalizePath,
  atomicWriteFileSync,
} = require('./errors');
const {
  DAY_MS,
  DEFAULT_CA_DAYS,
  DEFAULT_LEAF_DAYS,
  DEFAULT_LEAF_RENEW_BEFORE_DAYS,
  DEFAULT_CA_RENEW_WARNING_DAYS,
  generateDeviceId,
  createDeviceCertificates,
  rotateDeviceLeaf,
  inspectDeviceCertPairLifecycle,
  verifyDeviceCertPair,
  getCertValidityInfo,
  fingerprint256Hex,
  fingerprintsEqual,
  hexToFpBuffer,
  signWithLeafKey,
  verifyWithLeafCert,
} = require('./pki');

function resolveElectronSafeStorage() {
  try {
    // В основном процессе Electron module 'electron' отдаёт объект с safeStorage.
    // В обычном Node или ELECTRON_RUN_AS_NODE=1 safeStorage отсутствует.
    const electron = require('electron');
    if (electron && electron.safeStorage && typeof electron.safeStorage.isEncryptionAvailable === 'function') {
      return electron.safeStorage;
    }
  } catch { /* не в Electron main */ }
  return null;
}

function isPackagedElectron(appOverride = null) {
  if (appOverride && appOverride.isPackaged === true) return true;
  try {
    const electron = require('electron');
    return Boolean(electron && electron.app && electron.app.isPackaged === true);
  } catch {
    return false;
  }
}

function isInsideDir(targetPath, parentDir) {
  const rel = path.relative(parentDir, targetPath);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function normalizeProtectAdapter(protect) {
  if (!protect) return null;
  if (typeof protect.isEncryptionAvailable === 'function'
    && typeof protect.encryptString === 'function'
    && typeof protect.decryptString === 'function') {
    return {
      isEncryptionAvailable: () => Boolean(protect.isEncryptionAvailable()),
      encryptString: (text) => {
        const out = protect.encryptString(String(text));
        if (!Buffer.isBuffer(out) || out.length === 0) {
          throw new LinkCryptoError('safe_storage_encrypt_failed', 'safeStorage.encryptString вернул пустой буфер');
        }
        return out;
      },
      decryptString: (buf) => {
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          throw new LinkCryptoError('safe_storage_decrypt_failed', 'Пустой шифротекст ключа');
        }
        const text = protect.decryptString(buf);
        if (typeof text !== 'string' || !text) {
          throw new LinkCryptoError('safe_storage_decrypt_failed', 'Расшифровка ключа вернула пустое значение');
        }
        return text;
      },
    };
  }
  return null;
}

function canUseTestUnencryptedMode(dataDir, env = process.env, allowTestUnencrypted = false, app = null) {
  if (allowTestUnencrypted !== true) return false;
  if (isPackagedElectron(app)) return false;
  if (!env || env.NOX_LINK_TEST_UNENCRYPTED_KEYS !== '1') return false;
  if (typeof env.NOX_DATA_DIR !== 'string' || !env.NOX_DATA_DIR.trim()) return false;
  if (typeof dataDir !== 'string' || !dataDir.trim()) return false;

  const canonData = canonicalizePath(dataDir);
  const canonEnvData = canonicalizePath(env.NOX_DATA_DIR);
  if (canonData !== canonEnvData) return false;

  const canonTmp = canonicalizePath(os.tmpdir());
  return isInsideDir(canonData, canonTmp);
}

function resolveStorageMode(dataDir, protect, allowTestUnencrypted = false, env = process.env, app = null) {
  const adapter = normalizeProtectAdapter(protect);
  if (adapter && adapter.isEncryptionAvailable()) {
    return { mode: 'safeStorage', adapter };
  }
  if (canUseTestUnencryptedMode(dataDir, env, allowTestUnencrypted, app)) {
    return { mode: 'test-unencrypted', adapter: null };
  }
  throw new LinkCryptoError(
    'safe_storage_unavailable',
    'Защищённое хранилище ОС (Electron safeStorage) недоступно; работа Nox Link заблокирована (fail-closed)',
    { recovery: buildRecoveryAdvice('safe_storage_unavailable', null) },
  );
}

function assertPrivateKeyMatchesX509(privKeyPem, x509Cert, label) {
  let derivedPub;
  try {
    derivedPub = crypto.createPublicKey(privKeyPem);
  } catch {
    throw new LinkCryptoError('invalid_private_key', `${label}: повреждённый закрытый ключ`);
  }
  const expectedDer = x509Cert.publicKey.export({ type: 'spki', format: 'der' });
  const actualDer = derivedPub.export({ type: 'spki', format: 'der' });
  if (!expectedDer.equals(actualDer)) {
    throw new LinkCryptoError('key_cert_mismatch', `${label}: закрытый ключ не соответствует сертификату`);
  }
}

function wipeBuffer(buf) {
  if (Buffer.isBuffer(buf) && buf.length > 0) {
    buf.fill(0);
  }
}

function lpField(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr), 'utf8');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function buildLeafUpdatePayload({ deviceId, caFp256, previousLeafFp256, newLeafFp256, issuedAt, nonce }) {
  assertUuidV4(deviceId, 'deviceId');
  const caBuf = hexToFpBuffer(caFp256);
  const prevBuf = hexToFpBuffer(previousLeafFp256);
  const nextBuf = hexToFpBuffer(newLeafFp256);
  if (!caBuf || !prevBuf || !nextBuf) {
    throw new LinkCryptoError('invalid_leaf_update', 'Некорректные отпечатки сертификатов в обновлении листа');
  }
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new LinkCryptoError('invalid_leaf_update', 'Некорректная метка времени обновления листа');
  }
  const nonceBuf = Buffer.isBuffer(nonce) ? nonce : Buffer.from(String(nonce || ''), 'hex');
  if (nonceBuf.length !== 32) {
    throw new LinkCryptoError('invalid_leaf_update', 'Некорректный nonce обновления листа');
  }
  return Buffer.concat([
    Buffer.from('NOX-LINK-LEAF-UPDATE-V3', 'utf8'),
    lpField(deviceId),
    lpField(caBuf),
    lpField(prevBuf),
    lpField(nextBuf),
    lpField(String(issuedAt)),
    lpField(nonceBuf),
  ]);
}

function createLeafUpdateEnvelope({
  deviceId,
  caFp256,
  caKeyPem,
  previousLeafFp256,
  previousLeafKeyPem = null,
  newLeafPem,
  newLeafKeyPem,
  newLeafFp256,
  issuedAt = Date.now(),
}) {
  const nonce = crypto.randomBytes(32);
  const payload = buildLeafUpdatePayload({
    deviceId,
    caFp256,
    previousLeafFp256,
    newLeafFp256,
    issuedAt,
    nonce,
  });
  const caSignature = signWithLeafKey(caKeyPem, payload).toString('base64');
  const newLeafSignature = signWithLeafKey(newLeafKeyPem, payload).toString('base64');
  const previousLeafSignature = previousLeafKeyPem
    ? signWithLeafKey(previousLeafKeyPem, payload).toString('base64')
    : null;

  return {
    v: 3,
    type: 'leaf_update',
    deviceId,
    caFp256,
    previousLeafFp256,
    newLeafPem,
    newLeafFp256,
    issuedAt,
    nonce: nonce.toString('hex'),
    caSignature,
    newLeafSignature,
    previousLeafSignature,
  };
}

function verifyLeafUpdateEnvelope({
  envelope,
  expectedPeer,
  nowMs = Date.now(),
  requirePreviousLeafSig = true,
  maxAgeMs = 30 * DAY_MS,
}) {
  if (!envelope || typeof envelope !== 'object' || envelope.v !== 3 || envelope.type !== 'leaf_update') {
    throw new LinkCryptoError('invalid_leaf_update', 'Некорректный формат конверта обновления сертификата');
  }
  if (!expectedPeer || typeof expectedPeer !== 'object') {
    throw new LinkCryptoError('invalid_expected_peer', 'Отсутствует запись доверенного устройства');
  }
  const deviceId = assertUuidV4(expectedPeer.deviceId, 'expectedPeer.deviceId');
  if (envelope.deviceId !== deviceId) {
    throw new LinkCryptoError('peer_device_id_mismatch', 'Идентификатор устройства в обновлении сертификата не совпал');
  }
  if (typeof envelope.caPem === 'string' && envelope.caPem.trim()) {
    const sentCaFp = fingerprint256Hex(envelope.caPem);
    if (!fingerprintsEqual(sentCaFp, expectedPeer.rootCaFp256)) {
      throw new LinkCryptoError('ca_pin_mismatch', 'Запрещена незаметная смена Root CA при обновлении сертификата');
    }
  }
  if (!fingerprintsEqual(envelope.caFp256, expectedPeer.rootCaFp256)) {
    throw new LinkCryptoError('ca_pin_mismatch', 'Отпечаток Root CA в обновлении не совпадает с закреплённым');
  }
  if (!fingerprintsEqual(envelope.previousLeafFp256, expectedPeer.leafFp256)) {
    throw new LinkCryptoError(
      'leaf_chain_continuity_mismatch',
      'Предыдущий отпечаток листа не совпадает с текущим закреплённым; требуется повторное сопряжение с SAS',
    );
  }

  const verifiedNew = verifyDeviceCertPair({
    deviceId,
    caPem: expectedPeer.rootCaPem,
    leafPem: envelope.newLeafPem,
    nowMs,
  });
  if (envelope.newLeafFp256 && !fingerprintsEqual(envelope.newLeafFp256, verifiedNew.leafFp256)) {
    throw new LinkCryptoError('invalid_leaf_update', 'Отпечаток нового листа не соответствует переданному сертификату');
  }
  if (fingerprintsEqual(verifiedNew.leafFp256, expectedPeer.leafFp256)) {
    throw new LinkCryptoError('invalid_leaf_update', 'Новый сертификат совпадает с уже закреплённым');
  }

  if (!Number.isSafeInteger(envelope.issuedAt) || envelope.issuedAt > nowMs + 5 * 60_000) {
    throw new LinkCryptoError('invalid_leaf_update', 'Время выпуска обновления сертификата некорректно или из будущего');
  }
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && (nowMs - envelope.issuedAt) > maxAgeMs) {
    throw new LinkCryptoError('leaf_update_expired', 'Конверт обновления сертификата устарел');
  }
  if (typeof envelope.nonce !== 'string' || !/^[0-9a-f]{64}$/i.test(envelope.nonce)) {
    throw new LinkCryptoError('invalid_leaf_update', 'Некорректный nonce обновления сертификата');
  }

  const payload = buildLeafUpdatePayload({
    deviceId,
    caFp256: verifiedNew.caFp256,
    previousLeafFp256: expectedPeer.leafFp256,
    newLeafFp256: verifiedNew.leafFp256,
    issuedAt: envelope.issuedAt,
    nonce: envelope.nonce,
  });

  if (typeof envelope.caSignature !== 'string' || !envelope.caSignature) {
    throw new LinkCryptoError('leaf_update_signature_invalid', 'Отсутствует подпись Root CA в обновлении сертификата');
  }
  if (!verifyWithLeafCert(expectedPeer.rootCaPem, payload, Buffer.from(envelope.caSignature, 'base64'))) {
    throw new LinkCryptoError('leaf_update_signature_invalid', 'Подпись Root CA в обновлении сертификата недействительна');
  }

  if (typeof envelope.newLeafSignature !== 'string' || !envelope.newLeafSignature) {
    throw new LinkCryptoError('leaf_update_signature_invalid', 'Отсутствует PoP-подпись нового ключа листа');
  }
  if (!verifyWithLeafCert(verifiedNew.leafPem, payload, Buffer.from(envelope.newLeafSignature, 'base64'))) {
    throw new LinkCryptoError('leaf_update_signature_invalid', 'PoP-подпись нового листа недействительна');
  }

  if (requirePreviousLeafSig || envelope.previousLeafSignature) {
    if (typeof expectedPeer.leafPem !== 'string' || !expectedPeer.leafPem.trim()) {
      throw new LinkCryptoError('leaf_update_signature_invalid', 'Нет закреплённого старого сертификата для проверки непрерывности');
    }
    if (typeof envelope.previousLeafSignature !== 'string' || !envelope.previousLeafSignature) {
      throw new LinkCryptoError('leaf_update_signature_invalid', 'Отсутствует подпись предыдущим ключом листа');
    }
    if (!verifyWithLeafCert(expectedPeer.leafPem, payload, Buffer.from(envelope.previousLeafSignature, 'base64'))) {
      throw new LinkCryptoError('leaf_update_signature_invalid', 'Подпись предыдущим ключом листа недействительна');
    }
  }

  return {
    ok: true,
    deviceId,
    caFp256: verifiedNew.caFp256,
    previousLeafFp256: expectedPeer.leafFp256,
    canonicalNewLeafPem: verifiedNew.leafPem,
    newLeafFp256: verifiedNew.leafFp256,
    issuedAt: envelope.issuedAt,
  };
}

function buildRecoveryAdvice(reasonCode, deviceId = null) {
  switch (reasonCode) {
    case 'safe_storage_decrypt_failed':
      return {
        status: 'decrypt_failed_reset_required',
        recoverableKey: false,
        requiresResetAndRepairing: true,
        canAutoRecoverLeaf: false,
        deviceId,
        message: 'Приватные ключи привязаны к системному хранилищу (DPAPI/профилю Electron) и не могут быть расшифрованы или восстановлены без старого профиля. Выполните безопасный сброс идентичности (resetIdentity) и заново выполните сопряжение с кодом SAS на других устройствах.',
      };
    case 'ca_expired':
      return {
        status: 'ca_expired_reset_required',
        recoverableKey: false,
        requiresResetAndRepairing: true,
        canAutoRecoverLeaf: false,
        deviceId,
        message: 'Срок действия корневого сертификата устройства (Root CA) истёк. Требуется сброс идентичности (resetIdentity) и повторное сопряжение со всеми устройствами.',
      };
    case 'identity_corrupted':
      return {
        status: 'corrupted_reset_required',
        recoverableKey: false,
        requiresResetAndRepairing: true,
        canAutoRecoverLeaf: false,
        deviceId,
        message: 'Файл удостоверения повреждён и не может быть восстановлен автоматически. Выполните безопасный сброс идентичности (resetIdentity) и повторное сопряжение с SAS.',
      };
    case 'safe_storage_unavailable':
      return {
        status: 'storage_unavailable',
        recoverableKey: false,
        requiresResetAndRepairing: false,
        canAutoRecoverLeaf: false,
        deviceId,
        message: 'Защищённое хранилище ОС (safeStorage) сейчас недоступно. Дождитесь готовности приложения (app.whenReady) или проверьте системную защиту профиля; незашифрованное хранение ключей заблокировано.',
      };
    default:
      return {
        status: 'reset_required',
        recoverableKey: false,
        requiresResetAndRepairing: true,
        canAutoRecoverLeaf: false,
        deviceId,
        message: 'Выполните безопасный сброс идентичности (resetIdentity) и повторное сопряжение с доверенными устройствами.',
      };
  }
}

class DeviceIdentity {
  #caKeyEncBuf;
  #caKeyBuf;
  #leafKeyBuf;
  #protect;
  #allowTestUnencrypted;
  #env;
  #app;
  #dataDir;

  constructor({
    dataDir,
    filePath,
    deviceId,
    deviceName,
    caPem,
    leafPem,
    caFp256,
    leafFp256,
    caKeyPem,
    caKeyEncBuf = null,
    leafKeyPem,
    createdAt,
    rotatedAt,
    lastRotationReason = 'initial',
    pendingLeafUpdate = null,
    storageMode,
    protect,
    allowTestUnencrypted = false,
    env = process.env,
    app = null,
  }) {
    this.filePath = filePath;
    this.deviceId = assertUuidV4(deviceId, 'deviceId');
    this.deviceName = normalizeDeviceName(deviceName);
    this.caPem = caPem;
    this.leafPem = leafPem;
    this.caFp256 = caFp256;
    this.leafFp256 = leafFp256;
    this.createdAt = createdAt;
    this.rotatedAt = rotatedAt;
    this.lastRotationReason = lastRotationReason;
    this.pendingLeafUpdate = pendingLeafUpdate;
    this.storageMode = storageMode;

    this.#dataDir = dataDir;
    this.#protect = protect;
    this.#allowTestUnencrypted = allowTestUnencrypted;
    this.#env = env;
    this.#app = app;
    this.#leafKeyBuf = Buffer.from(String(leafKeyPem), 'utf8');

    // В режиме safeStorage не держим открытый ключ Root CA в памяти между ротациями (P2-11).
    if (storageMode === 'safeStorage' && caKeyEncBuf && Buffer.isBuffer(caKeyEncBuf)) {
      this.#caKeyEncBuf = Buffer.from(caKeyEncBuf);
      this.#caKeyBuf = null;
    } else if (storageMode === 'safeStorage') {
      const adapter = normalizeProtectAdapter(protect);
      if (adapter && adapter.isEncryptionAvailable()) {
        this.#caKeyEncBuf = adapter.encryptString(caKeyPem);
        this.#caKeyBuf = null;
      } else {
        this.#caKeyEncBuf = null;
        this.#caKeyBuf = Buffer.from(String(caKeyPem), 'utf8');
      }
    } else {
      this.#caKeyEncBuf = null;
      this.#caKeyBuf = Buffer.from(String(caKeyPem), 'utf8');
    }
  }

  publicProfile() {
    return {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      caPem: this.caPem,
      leafPem: this.leafPem,
      caFp256: this.caFp256,
      leafFp256: this.leafFp256,
      createdAt: this.createdAt,
      rotatedAt: this.rotatedAt,
      lastRotationReason: this.lastRotationReason,
      pendingLeafUpdate: this.pendingLeafUpdate,
      storageMode: this.storageMode,
    };
  }

  toJSON() {
    return this.publicProfile();
  }

  [util.inspect.custom]() {
    return `DeviceIdentity(${JSON.stringify({
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      caFp256: this.caFp256,
      leafFp256: this.leafFp256,
      storageMode: this.storageMode,
    })})`;
  }

  getTlsCredentials() {
    if (!this.#leafKeyBuf) {
      throw new LinkCryptoError('identity_disposed', 'Ключи устройства очищены из памяти');
    }
    return {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      caPem: this.caPem,
      leafPem: this.leafPem,
      leafKeyPem: this.#leafKeyBuf.toString('utf8'),
      caFp256: this.caFp256,
      leafFp256: this.leafFp256,
    };
  }

  signProof(data) {
    if (!this.#leafKeyBuf) {
      throw new LinkCryptoError('identity_disposed', 'Ключи устройства очищены из памяти');
    }
    return signWithLeafKey(this.#leafKeyBuf.toString('utf8'), data);
  }

  getLifecycleStatus({
    nowMs = Date.now(),
    renewBeforeDays = DEFAULT_LEAF_RENEW_BEFORE_DAYS,
    caWarningDays = DEFAULT_CA_RENEW_WARNING_DAYS,
  } = {}) {
    const caTimes = getCertValidityInfo(this.caPem);
    const leafTimes = getCertValidityInfo(this.leafPem);
    const caRemainingMs = caTimes.validToMs - nowMs;
    const leafRemainingMs = leafTimes.validToMs - nowMs;
    const caExpired = caRemainingMs < 0;
    const leafExpired = leafRemainingMs < 0;
    const leafExpiringSoon = !leafExpired && leafRemainingMs <= renewBeforeDays * DAY_MS;
    const caExpiringSoon = !caExpired && caRemainingMs <= caWarningDays * DAY_MS;
    return {
      deviceId: this.deviceId,
      caFp256: this.caFp256,
      leafFp256: this.leafFp256,
      caValidFromMs: caTimes.validFromMs,
      caValidToMs: caTimes.validToMs,
      caRemainingMs,
      caDaysRemaining: Math.floor(caRemainingMs / DAY_MS),
      caExpired,
      caExpiringSoon,
      leafValidFromMs: leafTimes.validFromMs,
      leafValidToMs: leafTimes.validToMs,
      leafRemainingMs,
      leafDaysRemaining: Math.floor(leafRemainingMs / DAY_MS),
      leafExpired,
      leafExpiringSoon,
      needsLeafRotation: !caExpired && (leafExpired || leafExpiringSoon),
      needsCaReset: caExpired,
      lastRotationReason: this.lastRotationReason,
      hasPendingLeafUpdate: Boolean(this.pendingLeafUpdate),
    };
  }

  async ensureFreshLeaf({
    leafDays = DEFAULT_LEAF_DAYS,
    renewBeforeDays = DEFAULT_LEAF_RENEW_BEFORE_DAYS,
    nowMs = Date.now(),
  } = {}) {
    const status = this.getLifecycleStatus({ nowMs, renewBeforeDays });
    if (status.caExpired) {
      throw new LinkCryptoError(
        'ca_expired',
        'Срок действия корневого сертификата устройства (Root CA) истёк; требуется сброс идентичности',
        { recovery: buildRecoveryAdvice('ca_expired', this.deviceId) },
      );
    }
    if (!status.needsLeafRotation) {
      return { rotated: false, profile: this.publicProfile(), lifecycle: status };
    }
    const reason = status.leafExpired ? 'expired_leaf_recovered' : 'proactive_before_expiry';
    const profile = await this.rotateLeaf({ leafDays, nowMs, reason });
    return {
      rotated: true,
      reason,
      profile,
      leafUpdateEnvelope: profile.leafUpdateEnvelope,
      lifecycle: this.getLifecycleStatus({ nowMs, renewBeforeDays }),
    };
  }

  #withCaKeyPem(fn) {
    if (!this.#caKeyEncBuf && !this.#caKeyBuf) {
      throw new LinkCryptoError('identity_disposed', 'Ключи устройства очищены из памяти');
    }
    if (this.#caKeyBuf) {
      return fn(this.#caKeyBuf.toString('utf8'));
    }
    const adapter = normalizeProtectAdapter(this.#protect);
    if (!adapter || !adapter.isEncryptionAvailable()) {
      throw new LinkCryptoError(
        'safe_storage_unavailable',
        'safeStorage недоступен для расшифровки ключа Root CA при ротации',
        { recovery: buildRecoveryAdvice('safe_storage_unavailable', this.deviceId) },
      );
    }
    let caKeyBuf = null;
    try {
      const caKeyText = adapter.decryptString(this.#caKeyEncBuf);
      caKeyBuf = Buffer.from(caKeyText, 'utf8');
      return fn(caKeyText);
    } catch (err) {
      if (err instanceof LinkCryptoError) throw err;
      throw new LinkCryptoError(
        'safe_storage_decrypt_failed',
        'Ошибка расшифровки ключа Root CA',
        { recovery: buildRecoveryAdvice('safe_storage_decrypt_failed', this.deviceId) },
      );
    } finally {
      wipeBuffer(caKeyBuf);
    }
  }

  async rotateLeaf({ leafDays = DEFAULT_LEAF_DAYS, nowMs = Date.now(), reason = 'manual' } = {}) {
    if (!this.#leafKeyBuf) {
      throw new LinkCryptoError('identity_disposed', 'Ключи устройства очищены из памяти');
    }
    const resolvedStorage = resolveStorageMode(
      this.#dataDir || path.dirname(path.dirname(this.filePath)),
      this.#protect,
      this.#allowTestUnencrypted,
      this.#env,
      this.#app,
    );
    // Никогда не понижаем хранилище из safeStorage в test-unencrypted.
    if (this.storageMode === 'safeStorage' && resolvedStorage.mode !== 'safeStorage') {
      throw new LinkCryptoError(
        'safe_storage_unavailable',
        'Нельзя выполнить ротацию: защищённое хранилище safeStorage стало недоступно',
      );
    }

    const oldLeafKeyPem = this.#leafKeyBuf.toString('utf8');
    const previousLeafFp256 = this.leafFp256;

    const { nextLeaf, envelope, nextCaKeyEncBuf } = await this.#withCaKeyPem(async (caKeyPem) => {
      const issued = await rotateDeviceLeaf({
        deviceId: this.deviceId,
        caPem: this.caPem,
        caKeyPem,
        leafDays,
        nowMs,
      });
      const env = createLeafUpdateEnvelope({
        deviceId: this.deviceId,
        caFp256: this.caFp256,
        caKeyPem,
        previousLeafFp256,
        previousLeafKeyPem: oldLeafKeyPem,
        newLeafPem: issued.leafPem,
        newLeafKeyPem: issued.leafKeyPem,
        newLeafFp256: issued.leafFp256,
        issuedAt: nowMs,
      });
      const persisted = persistIdentityRecord({
        filePath: this.filePath,
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        caPem: this.caPem,
        caKeyPem,
        caFp256: this.caFp256,
        leafPem: issued.leafPem,
        leafKeyPem: issued.leafKeyPem,
        leafFp256: issued.leafFp256,
        createdAt: this.createdAt,
        rotatedAt: nowMs,
        lastRotationReason: reason,
        pendingLeafUpdate: env,
        resolvedStorage,
      });
      return { nextLeaf: issued, envelope: env, nextCaKeyEncBuf: persisted.caKeyEncBuf };
    });

    wipeBuffer(this.#leafKeyBuf);
    this.#leafKeyBuf = Buffer.from(nextLeaf.leafKeyPem, 'utf8');
    if (nextCaKeyEncBuf) {
      wipeBuffer(this.#caKeyEncBuf);
      this.#caKeyEncBuf = nextCaKeyEncBuf;
    }

    this.leafPem = nextLeaf.leafPem;
    this.leafFp256 = nextLeaf.leafFp256;
    this.rotatedAt = nowMs;
    this.lastRotationReason = reason;
    this.pendingLeafUpdate = envelope;
    return {
      ...this.publicProfile(),
      leafUpdateEnvelope: envelope,
    };
  }

  dispose() {
    wipeBuffer(this.#leafKeyBuf);
    wipeBuffer(this.#caKeyBuf);
    wipeBuffer(this.#caKeyEncBuf);
    this.#leafKeyBuf = null;
    this.#caKeyBuf = null;
    this.#caKeyEncBuf = null;
  }
}

function persistIdentityRecord({
  filePath,
  deviceId,
  deviceName,
  caPem,
  caKeyPem,
  caFp256,
  leafPem,
  leafKeyPem,
  leafFp256,
  createdAt,
  rotatedAt,
  lastRotationReason = 'initial',
  pendingLeafUpdate = null,
  resolvedStorage,
}) {
  const { mode, adapter } = resolvedStorage;
  const record = {
    v: 3,
    deviceId,
    deviceName,
    caPem,
    leafPem,
    caFp256,
    leafFp256,
    createdAt,
    rotatedAt,
    lastRotationReason,
    pendingLeafUpdate,
    storageMode: mode,
  };
  let caKeyEncBuf = null;
  if (mode === 'safeStorage') {
    caKeyEncBuf = adapter.encryptString(caKeyPem);
    const leafKeyEncBuf = adapter.encryptString(leafKeyPem);
    record.caKeyEnc = caKeyEncBuf.toString('base64');
    record.leafKeyEnc = leafKeyEncBuf.toString('base64');
  } else {
    record.caKeyPlainTestOnly = caKeyPem;
    record.leafKeyPlainTestOnly = leafKeyPem;
  }
  atomicWriteFileSync(filePath, JSON.stringify(record, null, 2));
  return { mode, caKeyEncBuf };
}

function identityFilePath(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new LinkCryptoError('invalid_data_dir', 'Требуется корректный каталог данных для Nox Link');
  }
  return path.join(dataDir, 'link', 'identity.json');
}

function decryptStoredKeys(parsed, resolvedStorage, deviceId) {
  const { mode, adapter } = resolvedStorage;
  if (typeof parsed.caKeyEnc === 'string' && typeof parsed.leafKeyEnc === 'string') {
    if (mode !== 'safeStorage' || !adapter) {
      throw new LinkCryptoError(
        'safe_storage_unavailable',
        'Зашифрованные ключи устройства не могут быть расшифрованы без доступного safeStorage',
        { recovery: buildRecoveryAdvice('safe_storage_unavailable', deviceId) },
      );
    }
    try {
      const caKeyEncBuf = Buffer.from(parsed.caKeyEnc, 'base64');
      const leafKeyEncBuf = Buffer.from(parsed.leafKeyEnc, 'base64');
      const caKeyPem = adapter.decryptString(caKeyEncBuf);
      const leafKeyPem = adapter.decryptString(leafKeyEncBuf);
      return { caKeyPem, leafKeyPem, caKeyEncBuf };
    } catch (err) {
      if (err instanceof LinkCryptoError && err.code !== 'safe_storage_decrypt_failed') throw err;
      throw new LinkCryptoError(
        'safe_storage_decrypt_failed',
        'Невозможно расшифровать приватные ключи устройства через safeStorage; старый профиль потерян или изменён — выполните сброс идентичности и повторное сопряжение',
        { recovery: buildRecoveryAdvice('safe_storage_decrypt_failed', deviceId) },
      );
    }
  }
  if (parsed.storageMode === 'test-unencrypted' && mode === 'test-unencrypted') {
    return {
      caKeyPem: parsed.caKeyPlainTestOnly,
      leafKeyPem: parsed.leafKeyPlainTestOnly,
      caKeyEncBuf: null,
    };
  }
  throw new LinkCryptoError('identity_storage_mismatch', 'Формат хранения ключей не соответствует безопасному режиму');
}

async function loadOrCreateIdentity({
  dataDir,
  deviceName = 'Nox Device',
  protect = resolveElectronSafeStorage(),
  allowTestUnencrypted = false,
  env = process.env,
  app = null,
  caDays = DEFAULT_CA_DAYS,
  leafDays = DEFAULT_LEAF_DAYS,
  renewBeforeDays = DEFAULT_LEAF_RENEW_BEFORE_DAYS,
  autoRotateExpiredLeaf = true,
  proactiveRotate = true,
  nowMs = Date.now(),
} = {}) {
  const filePath = identityFilePath(dataDir);
  const normalizedName = normalizeDeviceName(deviceName);
  // Определяем режим хранения ровно ОДИН раз ДО чтения/генерации ключей (P2-6).
  const resolvedStorage = resolveStorageMode(dataDir, protect, allowTestUnencrypted, env, app);

  if (fs.existsSync(filePath)) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      throw new LinkCryptoError('identity_read_failed', 'Не удалось прочитать файл удостоверения устройства');
    }
    const parsed = parseSafeJson(raw);
    if (!parsed || parsed.v !== 3) {
      throw new LinkCryptoError(
        'identity_corrupted',
        'Повреждённый формат файла удостоверения устройства',
        { recovery: buildRecoveryAdvice('identity_corrupted', null) },
      );
    }
    const deviceId = assertUuidV4(parsed.deviceId, 'deviceId');

    // Сначала проверяем Root CA: если истёк именно Root CA, автоматическое восстановление невозможно — требуется сброс.
    let lifecycle;
    try {
      lifecycle = inspectDeviceCertPairLifecycle({
        deviceId,
        caPem: parsed.caPem,
        leafPem: parsed.leafPem,
        nowMs,
      });
    } catch (err) {
      if (err instanceof LinkCryptoError && err.code === 'cert_expired') {
        throw new LinkCryptoError(
          'ca_expired',
          'Срок действия корневого сертификата устройства (Root CA) истёк; требуется сброс идентичности и повторное сопряжение',
          { recovery: buildRecoveryAdvice('ca_expired', deviceId) },
        );
      }
      throw err;
    }

    const { caKeyPem, leafKeyPem, caKeyEncBuf } = decryptStoredKeys(parsed, resolvedStorage, deviceId);
    assertPrivateKeyMatchesX509(caKeyPem, lifecycle.caX509, 'Root CA');
    assertPrivateKeyMatchesX509(leafKeyPem, lifecycle.leafX509, 'Device Leaf');

    const remainingMs = lifecycle.leafValidToMs - nowMs;
    const isExpiringSoon = !lifecycle.leafExpired && remainingMs <= renewBeforeDays * DAY_MS;

    if (lifecycle.leafExpired && !autoRotateExpiredLeaf) {
      throw new LinkCryptoError('cert_expired', 'Device Leaf: срок действия сертификата истёк');
    }

    if ((lifecycle.leafExpired && autoRotateExpiredLeaf) || (proactiveRotate && isExpiringSoon)) {
      const reason = lifecycle.leafExpired ? 'expired_leaf_recovered' : 'proactive_before_expiry';
      const rotated = await rotateDeviceLeaf({
        deviceId,
        caPem: lifecycle.caPem,
        caKeyPem,
        leafDays,
        nowMs,
      });
      const envelope = createLeafUpdateEnvelope({
        deviceId,
        caFp256: lifecycle.caFp256,
        caKeyPem,
        previousLeafFp256: lifecycle.leafFp256,
        previousLeafKeyPem: leafKeyPem,
        newLeafPem: rotated.leafPem,
        newLeafKeyPem: rotated.leafKeyPem,
        newLeafFp256: rotated.leafFp256,
        issuedAt: nowMs,
      });
      const persisted = persistIdentityRecord({
        filePath,
        deviceId,
        deviceName: parsed.deviceName || normalizedName,
        caPem: lifecycle.caPem,
        caKeyPem,
        caFp256: lifecycle.caFp256,
        leafPem: rotated.leafPem,
        leafKeyPem: rotated.leafKeyPem,
        leafFp256: rotated.leafFp256,
        createdAt: parsed.createdAt || nowMs,
        rotatedAt: nowMs,
        lastRotationReason: reason,
        pendingLeafUpdate: envelope,
        resolvedStorage,
      });
      return new DeviceIdentity({
        dataDir,
        filePath,
        deviceId,
        deviceName: parsed.deviceName || normalizedName,
        caPem: lifecycle.caPem,
        leafPem: rotated.leafPem,
        caFp256: lifecycle.caFp256,
        leafFp256: rotated.leafFp256,
        caKeyPem,
        caKeyEncBuf: persisted.caKeyEncBuf,
        leafKeyPem: rotated.leafKeyPem,
        createdAt: parsed.createdAt || nowMs,
        rotatedAt: nowMs,
        lastRotationReason: reason,
        pendingLeafUpdate: envelope,
        storageMode: resolvedStorage.mode,
        protect,
        allowTestUnencrypted,
        env,
        app,
      });
    }

    return new DeviceIdentity({
      dataDir,
      filePath,
      deviceId,
      deviceName: parsed.deviceName || normalizedName,
      caPem: lifecycle.caPem,
      leafPem: lifecycle.leafPem,
      caFp256: lifecycle.caFp256,
      leafFp256: lifecycle.leafFp256,
      caKeyPem,
      caKeyEncBuf,
      leafKeyPem,
      createdAt: parsed.createdAt || nowMs,
      rotatedAt: parsed.rotatedAt || parsed.createdAt || nowMs,
      lastRotationReason: parsed.lastRotationReason || 'initial',
      pendingLeafUpdate: parsed.pendingLeafUpdate || null,
      storageMode: resolvedStorage.mode,
      protect,
      allowTestUnencrypted,
      env,
      app,
    });
  }

  const deviceId = generateDeviceId();
  const certs = await createDeviceCertificates({ deviceId, caDays, leafDays, nowMs });
  const persisted = persistIdentityRecord({
    filePath,
    deviceId,
    deviceName: normalizedName,
    caPem: certs.caPem,
    caKeyPem: certs.caKeyPem,
    caFp256: certs.caFp256,
    leafPem: certs.leafPem,
    leafKeyPem: certs.leafKeyPem,
    leafFp256: certs.leafFp256,
    createdAt: nowMs,
    rotatedAt: nowMs,
    lastRotationReason: 'initial',
    pendingLeafUpdate: null,
    resolvedStorage,
  });

  return new DeviceIdentity({
    dataDir,
    filePath,
    deviceId,
    deviceName: normalizedName,
    caPem: certs.caPem,
    leafPem: certs.leafPem,
    caFp256: certs.caFp256,
    leafFp256: certs.leafFp256,
    caKeyPem: certs.caKeyPem,
    caKeyEncBuf: persisted.caKeyEncBuf,
    leafKeyPem: certs.leafKeyPem,
    createdAt: nowMs,
    rotatedAt: nowMs,
    lastRotationReason: 'initial',
    pendingLeafUpdate: null,
    storageMode: resolvedStorage.mode,
    protect,
    allowTestUnencrypted,
    env,
    app,
  });
}

function diagnoseIdentityRecovery({
  dataDir,
  protect = resolveElectronSafeStorage(),
  allowTestUnencrypted = false,
  env = process.env,
  app = null,
  nowMs = Date.now(),
  renewBeforeDays = DEFAULT_LEAF_RENEW_BEFORE_DAYS,
} = {}) {
  const filePath = identityFilePath(dataDir);
  let resolvedStorage;
  try {
    resolvedStorage = resolveStorageMode(dataDir, protect, allowTestUnencrypted, env, app);
  } catch {
    return buildRecoveryAdvice('safe_storage_unavailable', null);
  }
  if (!fs.existsSync(filePath)) {
    return {
      status: 'missing',
      recoverableKey: false,
      requiresResetAndRepairing: false,
      canAutoRecoverLeaf: false,
      deviceId: null,
      message: 'Удостоверение устройства ещё не создано; можно выполнить первичную инициализацию.',
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return buildRecoveryAdvice('identity_corrupted', null);
  }
  const parsed = parseSafeJson(raw);
  if (!parsed || parsed.v !== 3) {
    return buildRecoveryAdvice('identity_corrupted', null);
  }
  let deviceId = null;
  try {
    deviceId = assertUuidV4(parsed.deviceId, 'deviceId');
  } catch {
    return buildRecoveryAdvice('identity_corrupted', null);
  }

  let lifecycle;
  try {
    lifecycle = inspectDeviceCertPairLifecycle({
      deviceId,
      caPem: parsed.caPem,
      leafPem: parsed.leafPem,
      nowMs,
    });
  } catch (err) {
    if (err instanceof LinkCryptoError && err.code === 'cert_expired') {
      return buildRecoveryAdvice('ca_expired', deviceId);
    }
    return buildRecoveryAdvice('identity_corrupted', deviceId);
  }

  try {
    const { caKeyPem, leafKeyPem } = decryptStoredKeys(parsed, resolvedStorage, deviceId);
    assertPrivateKeyMatchesX509(caKeyPem, lifecycle.caX509, 'Root CA');
    assertPrivateKeyMatchesX509(leafKeyPem, lifecycle.leafX509, 'Device Leaf');
  } catch (err) {
    if (err instanceof LinkCryptoError && err.code === 'safe_storage_unavailable') {
      return buildRecoveryAdvice('safe_storage_unavailable', deviceId);
    }
    if (err instanceof LinkCryptoError && err.code === 'safe_storage_decrypt_failed') {
      return buildRecoveryAdvice('safe_storage_decrypt_failed', deviceId);
    }
    return buildRecoveryAdvice('identity_corrupted', deviceId);
  }

  const remainingMs = lifecycle.leafValidToMs - nowMs;
  if (lifecycle.leafExpired || remainingMs <= renewBeforeDays * DAY_MS) {
    return {
      status: 'needs_leaf_rotation',
      recoverableKey: true,
      requiresResetAndRepairing: false,
      canAutoRecoverLeaf: true,
      deviceId,
      leafExpired: lifecycle.leafExpired,
      message: lifecycle.leafExpired
        ? 'Срок действия листового сертификата истёк, но Root CA действителен — лист автоматически перевыпустится при загрузке.'
        : 'Срок действия листового сертификата скоро истечёт — доступна предупредительная ротация с подтверждением на пирах.',
    };
  }

  return {
    status: 'ok',
    recoverableKey: true,
    requiresResetAndRepairing: false,
    canAutoRecoverLeaf: false,
    deviceId,
    message: 'Удостоверение устройства исправно и готово к работе.',
  };
}

async function resetIdentity({
  dataDir,
  deviceName = 'Nox Device',
  protect = resolveElectronSafeStorage(),
  allowTestUnencrypted = false,
  env = process.env,
  app = null,
  confirmReset = false,
  archiveBroken = true,
  caDays = DEFAULT_CA_DAYS,
  leafDays = DEFAULT_LEAF_DAYS,
  nowMs = Date.now(),
} = {}) {
  if (confirmReset !== true) {
    throw new LinkCryptoError(
      'reset_confirmation_required',
      'Сброс идентичности требует явного подтверждения владельца (confirmReset: true), так как все старые сопряжения нужно будет выполнить заново',
    );
  }
  const filePath = identityFilePath(dataDir);
  const normalizedName = normalizeDeviceName(deviceName);
  const resolvedStorage = resolveStorageMode(dataDir, protect, allowTestUnencrypted, env, app);

  let previousDeviceId = null;
  let archivedPath = null;
  if (fs.existsSync(filePath)) {
    try {
      const oldParsed = parseSafeJson(fs.readFileSync(filePath, 'utf8'));
      if (oldParsed && typeof oldParsed.deviceId === 'string') {
        try { previousDeviceId = assertUuidV4(oldParsed.deviceId, 'deviceId'); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    if (archiveBroken) {
      archivedPath = `${filePath}.reset.${nowMs}.${crypto.randomBytes(4).toString('hex')}.bak`;
      fs.renameSync(filePath, archivedPath);
    } else {
      fs.rmSync(filePath, { force: true });
    }
  }

  const deviceId = generateDeviceId();
  const certs = await createDeviceCertificates({ deviceId, caDays, leafDays, nowMs });
  const persisted = persistIdentityRecord({
    filePath,
    deviceId,
    deviceName: normalizedName,
    caPem: certs.caPem,
    caKeyPem: certs.caKeyPem,
    caFp256: certs.caFp256,
    leafPem: certs.leafPem,
    leafKeyPem: certs.leafKeyPem,
    leafFp256: certs.leafFp256,
    createdAt: nowMs,
    rotatedAt: nowMs,
    lastRotationReason: 'identity_reset',
    pendingLeafUpdate: null,
    resolvedStorage,
  });

  const identity = new DeviceIdentity({
    dataDir,
    filePath,
    deviceId,
    deviceName: normalizedName,
    caPem: certs.caPem,
    leafPem: certs.leafPem,
    caFp256: certs.caFp256,
    leafFp256: certs.leafFp256,
    caKeyPem: certs.caKeyPem,
    caKeyEncBuf: persisted.caKeyEncBuf,
    leafKeyPem: certs.leafKeyPem,
    createdAt: nowMs,
    rotatedAt: nowMs,
    lastRotationReason: 'identity_reset',
    pendingLeafUpdate: null,
    storageMode: resolvedStorage.mode,
    protect,
    allowTestUnencrypted,
    env,
  });

  return {
    identity,
    previousDeviceId,
    archivedPath,
    requiresRepairing: true,
    message: 'Создано новое удостоверение устройства. Повторите сопряжение с кодом SAS на доверенных устройствах и отзовите утерянный профиль.',
  };
}

module.exports = {
  DeviceIdentity,
  resolveElectronSafeStorage,
  loadOrCreateIdentity,
  createLeafUpdateEnvelope,
  verifyLeafUpdateEnvelope,
  diagnoseIdentityRecovery,
  resetIdentity,
};
