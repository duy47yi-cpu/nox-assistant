'use strict';

// Фаза 1: тесты PKI (Device Root CA + Leaf на pkijs/asn1js), safeStorage (fail-closed),
// пиннинга, отзыва/замены сертификатов и отсутствия утечек приватных ключей.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const util = require('node:util');
const asn1js = require('asn1js');
const pkijs = require('pkijs');

const {
  DAY_MS,
  LinkCryptoError,
  generateDeviceId,
  hostOf,
  toPem,
  pemToDer,
  normalizeDeviceName,
  issueDeviceRootCa,
  issueDeviceLeaf,
  createDeviceCertificates,
  rotateDeviceLeaf,
  inspectDeviceCertPairLifecycle,
  verifyDeviceCertPair,
  fingerprint256Hex,
  loadOrCreateIdentity,
  createLeafUpdateEnvelope,
  verifyLeafUpdateEnvelope,
  diagnoseIdentityRecovery,
  resetIdentity,
  PeerTrustStore,
  sanitizeForLog,
  redactText,
} = require('../src/link');

function makeMockProtect(available = true, secretByte = 0x5a) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => {
      const iv = crypto.randomBytes(12);
      const key = crypto.createHash('sha256').update(Buffer.from([secretByte])).digest();
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]);
    },
    decryptString: (buf) => {
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const key = crypto.createHash('sha256').update(Buffer.from([secretByte])).digest();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    },
  };
}

function makeTempDir(prefix = 'nox-link-pki-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('PKI: генерация UUIDv4, 2-уровневый профиль X.509 (CA pathlen:0 + NameConstraints, Leaf CA:FALSE + SAN)', async () => {
  const id = generateDeviceId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(hostOf(id), `${id}.link.nox`);

  const certs = await createDeviceCertificates({ deviceId: id });
  const verified = verifyDeviceCertPair({ deviceId: id, caPem: certs.caPem, leafPem: certs.leafPem });
  assert.equal(verified.ok, true);
  assert.equal(verified.caX509.ca, true);
  assert.equal(verified.leafX509.ca, false);
  assert.equal(verified.leafX509.checkIssued(verified.caX509), true);
  assert.equal(verified.leafX509.checkHost(hostOf(id)), hostOf(id));
  assert.equal(verified.caFp256, fingerprint256Hex(certs.caPem));
  assert.equal(verified.leafFp256, fingerprint256Hex(certs.leafPem));

  // Инспекция KeyUsage DER BitString на обоих уровнях.
  const caKuExt = verified.caCert.extensions.find((e) => e.extnID === pkijs.id_KeyUsage);
  const caKu = asn1js.fromBER(caKuExt.extnValue.valueBlock.valueHexView).result;
  assert.equal(caKu.valueBlock.unusedBits, 1);
  assert.equal(Buffer.from(caKu.valueBlock.valueHexView)[0], 0x06);

  const leafKuExt = verified.leafCert.extensions.find((e) => e.extnID === pkijs.id_KeyUsage);
  const leafKu = asn1js.fromBER(leafKuExt.extnValue.valueBlock.valueHexView).result;
  assert.equal(leafKu.valueBlock.unusedBits, 7);
  assert.equal(Buffer.from(leafKu.valueBlock.valueHexView)[0], 0x80);
});

test('PKI негатив: отклонение Leaf с CA:TRUE, keyEncipherment, неверным SAN, чужим CA или истёкшим сроком', async () => {
  const idA = generateDeviceId();
  const idB = generateDeviceId();
  const certsA = await createDeviceCertificates({ deviceId: idA });
  const certsB = await createDeviceCertificates({ deviceId: idB });

  // 1. Чужой Leaf под нашим CA / несовпадающий deviceId.
  assert.throws(
    () => verifyDeviceCertPair({ deviceId: idB, caPem: certsA.caPem, leafPem: certsA.leafPem }),
    (err) => err instanceof LinkCryptoError && err.code === 'invalid_ca_subject',
  );
  assert.throws(
    () => verifyDeviceCertPair({ deviceId: idA, caPem: certsA.caPem, leafPem: certsB.leafPem }),
    (err) => err instanceof LinkCryptoError && err.code === 'invalid_leaf_chain',
  );

  // 2. Истёкший Leaf.
  const pastNow = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const expiredLeaf = await issueDeviceLeaf({
    deviceId: idA,
    caPem: certsA.caPem,
    caKeyPem: certsA.caKeyPem,
    notBeforeMs: pastNow - 5 * 24 * 60 * 60 * 1000,
    notAfterMs: pastNow,
  });
  assert.throws(
    () => verifyDeviceCertPair({ deviceId: idA, caPem: certsA.caPem, leafPem: expiredLeaf.leafPem }),
    (err) => err instanceof LinkCryptoError && err.code === 'cert_expired',
  );

  // 3. Выпускаем искажённый Leaf через pkijs с запрещённым keyEncipherment (0xa0) и проверяем отказ.
  const caCert = pkijs.Certificate.fromBER(pemToDer(certsA.caPem, 'CERTIFICATE'));
  const caPriv = await crypto.webcrypto.subtle.importKey(
    'pkcs8',
    pemToDer(certsA.caKeyPem, 'PRIVATE KEY'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
  const badKeys = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const badLeaf = new pkijs.Certificate();
  badLeaf.version = 2;
  badLeaf.serialNumber = new asn1js.Integer({ valueHex: new Uint8Array([1, 2, 3, 4]) });
  badLeaf.issuer = caCert.subject;
  badLeaf.subject.typesAndValues.push(new pkijs.AttributeTypeAndValue({
    type: '2.5.4.3',
    value: new asn1js.Utf8String({ value: hostOf(idA) }),
  }));
  badLeaf.notBefore = new pkijs.Time({ type: 0, value: new Date(Date.now() - 60_000) });
  badLeaf.notAfter = new pkijs.Time({ type: 0, value: new Date(Date.now() + 86_400_000) });
  await badLeaf.subjectPublicKeyInfo.importKey(badKeys.publicKey);
  badLeaf.extensions = [
    new pkijs.Extension({
      extnID: pkijs.id_BasicConstraints,
      critical: true,
      extnValue: new pkijs.BasicConstraints({ cA: false }).toSchema().toBER(false),
    }),
    new pkijs.Extension({
      extnID: pkijs.id_KeyUsage,
      critical: true,
      extnValue: new asn1js.BitString({ valueHex: new Uint8Array([0xa0]), unusedBits: 5 }).toBER(false),
    }),
  ];
  await badLeaf.sign(caPriv, 'SHA-256');
  const badLeafPem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(badLeaf.toSchema().toBER(false)).toString('base64')}\n-----END CERTIFICATE-----\n`;

  assert.throws(
    () => verifyDeviceCertPair({ deviceId: idA, caPem: certsA.caPem, leafPem: badLeafPem }),
    (err) => err instanceof LinkCryptoError && err.code === 'invalid_leaf_key_usage',
  );
});

test('Identity & safeStorage: fail-closed при недоступности защищённого хранения, отсутствие открытых ключей на диске и в логах', async () => {
  const dir = makeTempDir();
  try {
    // 1. Без safeStorage должен быть жёсткий отказ и ноль файлов на диске.
    await assert.rejects(
      loadOrCreateIdentity({
        dataDir: dir,
        deviceName: 'PC-FailClosed',
        protect: makeMockProtect(false),
        env: {},
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'safe_storage_unavailable',
    );
    assert.equal(fs.existsSync(path.join(dir, 'link', 'identity.json')), false);

    // 2. Даже с NOX_LINK_TEST_UNENCRYPTED_KEYS=1, но без NOX_DATA_DIR — всё равно отказ.
    await assert.rejects(
      loadOrCreateIdentity({
        dataDir: dir,
        deviceName: 'PC-FailClosed',
        protect: makeMockProtect(false),
        env: { NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'safe_storage_unavailable',
    );

    // 3. С рабочим safeStorage ключи шифруются и открытый текст на диск не попадает.
    const protect = makeMockProtect(true, 0x77);
    const id1 = await loadOrCreateIdentity({
      dataDir: dir,
      deviceName: 'Workstation-A',
      protect,
      env: {},
    });
    const rawJson = fs.readFileSync(path.join(dir, 'link', 'identity.json'), 'utf8');
    assert.equal(rawJson.includes('BEGIN PRIVATE KEY'), false);
    assert.equal(rawJson.includes('caKeyPlain'), false);
    assert.equal(rawJson.includes('leafKeyPlain'), false);
    assert.ok(JSON.parse(rawJson).caKeyEnc);
    assert.ok(JSON.parse(rawJson).leafKeyEnc);

    // 4. В JSON.stringify, util.inspect и sanitizeForLog приватные ключи отсутствуют.
    const serialized = JSON.stringify(id1);
    const inspected = util.inspect(id1);
    const sanitizedCreds = JSON.stringify(sanitizeForLog(id1.getTlsCredentials()));
    assert.equal(serialized.includes('PRIVATE KEY'), false);
    assert.equal(inspected.includes('PRIVATE KEY'), false);
    assert.equal(sanitizedCreds.includes('PRIVATE KEY'), false);
    assert.equal(redactText(id1.getTlsCredentials().leafKeyPem).includes('BEGIN PRIVATE KEY'), false);

    // 5. Перезагрузка тем же protect возвращает то же удостоверение.
    const id2 = await loadOrCreateIdentity({ dataDir: dir, deviceName: 'Workstation-A', protect, env: {} });
    assert.equal(id2.deviceId, id1.deviceId);
    assert.equal(id2.caFp256, id1.caFp256);
    assert.equal(id2.leafFp256, id1.leafFp256);

    // 6. Попытка расшифровать другим ключом DPAPI/safeStorage падает fail-closed.
    await assert.rejects(
      loadOrCreateIdentity({
        dataDir: dir,
        deviceName: 'Workstation-A',
        protect: makeMockProtect(true, 0x99),
        env: {},
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'safe_storage_decrypt_failed',
    );

    // 7. Ротация листа сохраняет CA и меняет только Leaf.
    const prevCaFp = id2.caFp256;
    const prevLeafFp = id2.leafFp256;
    await id2.rotateLeaf();
    assert.equal(id2.caFp256, prevCaFp);
    assert.notEqual(id2.leafFp256, prevLeafFp);
    const id3 = await loadOrCreateIdentity({ dataDir: dir, deviceName: 'Workstation-A', protect, env: {} });
    assert.equal(id3.leafFp256, id2.leafFp256);

    id1.dispose();
    id2.dispose();
    id3.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PeerTrustStore: пиннинг, отзыв (tombstone), запрет тихой подмены и явная замена сертификата', async () => {
  const dir = makeTempDir('nox-link-peers-');
  try {
    const store = new PeerTrustStore({ dataDir: dir });
    const idB = generateDeviceId();
    const certsB1 = await createDeviceCertificates({ deviceId: idB });
    const certsB2 = await createDeviceCertificates({ deviceId: idB });
    const rotatedLeafB = await issueDeviceLeaf({
      deviceId: idB,
      caPem: certsB1.caPem,
      caKeyPem: certsB1.caKeyPem,
    });

    store.trustPeer({
      deviceId: idB,
      deviceName: 'Peer B',
      caPem: certsB1.caPem,
      leafPem: certsB1.leafPem,
    });
    assert.equal(store.requireTrustedPeer(idB).leafFp256, certsB1.leafFp256);

    // Молчаливая подмена сертификата тем же deviceId запрещена.
    assert.throws(
      () => store.trustPeer({
        deviceId: idB,
        deviceName: 'Peer B',
        caPem: certsB2.caPem,
        leafPem: certsB2.leafPem,
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'peer_pin_conflict',
    );

    // Явная замена листа под тем же Root CA проходит.
    const replacedLeaf = store.replacePeerCertificate(idB, {
      leafPem: rotatedLeafB.leafPem,
      by: 'owner',
    });
    assert.equal(replacedLeaf.leafFp256, rotatedLeafB.leafFp256);
    assert.equal(replacedLeaf.previousLeafFp256, certsB1.leafFp256);

    // Замена на другой Root CA без явного allowCaChange запрещена.
    assert.throws(
      () => store.replacePeerCertificate(idB, {
        caPem: certsB2.caPem,
        leafPem: certsB2.leafPem,
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'ca_pin_mismatch',
    );

    // Отзыв ставит tombstone и блокирует доступ, даже после перезагрузки PeerTrustStore.
    const revokedEvents = [];
    store.onRevoke((ev) => revokedEvents.push(ev));
    store.revokePeer(idB, { by: 'owner', reason: 'lost_laptop' });
    assert.equal(revokedEvents.length, 1);
    assert.equal(revokedEvents[0].deviceId, idB);

    const storeReloaded = new PeerTrustStore({ dataDir: dir });
    assert.throws(
      () => storeReloaded.requireTrustedPeer(idB),
      (err) => err instanceof LinkCryptoError && err.code === 'peer_revoked',
    );
    assert.throws(
      () => storeReloaded.trustPeer({
        deviceId: idB,
        deviceName: 'Peer B',
        caPem: certsB2.caPem,
        leafPem: certsB2.leafPem,
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'peer_revoked',
    );

    // Восстановление после отзыва возможно только явной заменой с allowCaChange + allowReenable.
    const reenabled = storeReloaded.replacePeerCertificate(idB, {
      caPem: certsB2.caPem,
      leafPem: certsB2.leafPem,
      allowCaChange: true,
      allowReenable: true,
      by: 'owner_repair',
    });
    assert.equal(reenabled.revokedAt, null);
    assert.equal(storeReloaded.requireTrustedPeer(idB).rootCaFp256, certsB2.caFp256);
    store.close();
    storeReloaded.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A5/A4 Жизненный цикл сертификатов: предупредительная ротация, восстановление истёкшего leaf, подтверждённый update у пира, запрет смены CA и сброс при потере ключа', async () => {
  const dirA = makeTempDir('nox-link-lc-a-');
  const dirPeer = makeTempDir('nox-link-lc-p-');
  const protectA = makeMockProtect(true, 0x22);
  const t0 = Date.now();

  let idA = null;
  const peerStore = new PeerTrustStore({ dataDir: dirPeer });
  try {
    // День 0: выпуск Root CA (3650 дн.) и Leaf (90 дн.).
    idA = await loadOrCreateIdentity({
      dataDir: dirA,
      deviceName: 'Lifecycle-A',
      protect: protectA,
      nowMs: t0,
    });
    peerStore.trustPeer({
      deviceId: idA.deviceId,
      deviceName: 'Lifecycle-A',
      caPem: idA.caPem,
      leafPem: idA.leafPem,
      nowMs: t0,
    });

    const st0 = idA.getLifecycleStatus({ nowMs: t0 });
    assert.equal(st0.leafExpired, false);
    assert.equal(st0.needsLeafRotation, false);
    assert.equal(st0.needsCaReset, false);

    // День 80 (за 10 дней до окончания 90-дневного leaf): предупредительная ротация.
    const t80 = t0 + 80 * DAY_MS;
    idA.dispose();
    idA = await loadOrCreateIdentity({
      dataDir: dirA,
      deviceName: 'Lifecycle-A',
      protect: protectA,
      nowMs: t80,
    });
    assert.equal(idA.lastRotationReason, 'proactive_before_expiry');
    assert.ok(idA.pendingLeafUpdate);
    const leaf80Fp = idA.leafFp256;

    // Попытка обновить доверенный пир без onConfirmCertUpdate — жёсткий отказ.
    await assert.rejects(
      () => peerStore.confirmAndUpdatePeerLeaf(idA.deviceId, {
        envelope: idA.pendingLeafUpdate,
        nowMs: t80,
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'confirmation_required',
    );

    // Отказ владельца не меняет закреплённый leafFp256.
    await assert.rejects(
      () => peerStore.confirmAndUpdatePeerLeaf(idA.deviceId, {
        envelope: idA.pendingLeafUpdate,
        nowMs: t80,
        onConfirmCertUpdate: async () => ({ confirmed: false }),
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'cert_update_rejected',
    );
    assert.notEqual(peerStore.requireTrustedPeer(idA.deviceId, { nowMs: t80 }).leafFp256, leaf80Fp);

    // Подделка CA или подписи внутри конверта обновления отвергаются.
    const rogue = await createDeviceCertificates({ deviceName: 'Rogue', nowMs: t80 });
    assert.throws(
      () => verifyLeafUpdateEnvelope({
        envelope: {
          ...idA.pendingLeafUpdate,
          caFp256: rogue.caFp256,
        },
        expectedPeer: peerStore.requireTrustedPeer(idA.deviceId, { nowMs: t80 }),
        nowMs: t80,
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'ca_pin_mismatch',
    );
    assert.throws(
      () => verifyLeafUpdateEnvelope({
        envelope: {
          ...idA.pendingLeafUpdate,
          caSignature: Buffer.from('bad-sig').toString('base64'),
        },
        expectedPeer: peerStore.requireTrustedPeer(idA.deviceId, { nowMs: t80 }),
        nowMs: t80,
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'leaf_update_signature_invalid',
    );

    // Явное подтверждение владельца обновляет leaf при сохранении закреплённого Root CA.
    const updatedPeer = await peerStore.confirmAndUpdatePeerLeaf(idA.deviceId, {
      envelope: idA.pendingLeafUpdate,
      nowMs: t80,
      onConfirmCertUpdate: async (prompt) => {
        assert.equal(prompt.deviceId, idA.deviceId);
        assert.equal(prompt.newLeafFp256, leaf80Fp);
        assert.ok(prompt.signal instanceof AbortSignal);
        return { confirmed: true };
      },
    });
    assert.equal(updatedPeer.leafFp256, leaf80Fp);
    assert.equal(updatedPeer.rootCaFp256, idA.caFp256);

    // День 175 (лист дня 80 истёк на дне 170, но Root CA ещё действует):
    // автоматическое восстановление leaf без потери deviceId и Root CA.
    const t175 = t0 + 175 * DAY_MS;
    idA.dispose();
    idA = await loadOrCreateIdentity({
      dataDir: dirA,
      deviceName: 'Lifecycle-A',
      protect: protectA,
      nowMs: t175,
    });
    assert.equal(idA.lastRotationReason, 'expired_leaf_recovered');
    assert.equal(idA.caFp256, updatedPeer.rootCaFp256);
    assert.notEqual(idA.leafFp256, leaf80Fp);
    assert.ok(idA.pendingLeafUpdate);

    // Цепочка обновления с несовпадающим previousLeafFp256 отвергается при requirePreviousLeafSig.
    const staleEnv = { ...idA.pendingLeafUpdate, previousLeafFp256: '00'.repeat(32) };
    await assert.rejects(
      () => peerStore.confirmAndUpdatePeerLeaf(idA.deviceId, {
        envelope: staleEnv,
        nowMs: t175,
        onConfirmCertUpdate: async () => ({ confirmed: true }),
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'leaf_chain_continuity_mismatch',
    );

    // Но с корректным envelope от восстановленного leaf (подписан CA + старый leaf + новый leaf) обновление проходит.
    const updatedAfterExpiry = await peerStore.confirmAndUpdatePeerLeaf(idA.deviceId, {
      envelope: idA.pendingLeafUpdate,
      nowMs: t175,
      onConfirmCertUpdate: async () => ({ confirmed: true }),
    });
    assert.equal(updatedAfterExpiry.leafFp256, idA.leafFp256);

    // Истечение Root CA (день 3700): честный отказ без обещания восстановления.
    const tCaExpired = t0 + 3700 * DAY_MS;
    idA.dispose();
    await assert.rejects(
      () => loadOrCreateIdentity({
        dataDir: dirA,
        deviceName: 'Lifecycle-A',
        protect: protectA,
        nowMs: tCaExpired,
      }),
      (err) => {
        assert.equal(err.code, 'ca_expired');
        assert.equal(err.details?.recovery?.recoverableKey, false);
        assert.equal(err.details?.recovery?.requiresResetAndRepairing, true);
        return true;
      },
    );

    // Потеря системного ключа safeStorage (другой secretByte): честная диагностика без обещания расшифровки + resetIdentity.
    const wrongProtect = makeMockProtect(true, 0x99);
    const diagLost = diagnoseIdentityRecovery({ dataDir: dirA, protect: wrongProtect, nowMs: t175 });
    assert.equal(diagLost.status, 'decrypt_failed_reset_required');
    assert.equal(diagLost.recoverableKey, false);
    assert.equal(diagLost.requiresResetAndRepairing, true);

    await assert.rejects(
      () => loadOrCreateIdentity({ dataDir: dirA, deviceName: 'Lifecycle-A', protect: wrongProtect, nowMs: t175 }),
      (err) => err instanceof LinkCryptoError && err.code === 'safe_storage_decrypt_failed' && err.details?.recovery?.recoverableKey === false,
    );

    // resetIdentity требует confirmReset: true.
    await assert.rejects(
      () => resetIdentity({ dataDir: dirA, protect: wrongProtect, nowMs: t175 }),
      (err) => err instanceof LinkCryptoError && err.code === 'reset_confirmation_required',
    );

    const oldDeviceId = idA.deviceId;
    const resetRes = await resetIdentity({
      dataDir: dirA,
      deviceName: 'Lifecycle-A-Reset',
      protect: wrongProtect,
      confirmReset: true,
      nowMs: t175,
    });
    assert.equal(resetRes.requiresRepairing, true);
    assert.equal(resetRes.previousDeviceId, oldDeviceId);
    idA = resetRes.identity;
    assert.notEqual(idA.deviceId, oldDeviceId);
    assert.equal(idA.getLifecycleStatus({ nowMs: t175 }).caExpired, false);
    assert.equal(idA.getLifecycleStatus({ nowMs: t175 }).leafExpired, false);
  } finally {
    idA?.dispose();
    peerStore.close();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirPeer, { recursive: true, force: true });
  }
});

test('A6 (P2-2, P2-6, P2-11): тестовый режим по умолчанию запрещён, блокировка понижения storageMode и зануление буферов при dispose', async () => {
  const dir = makeTempDir('nox-link-a6-');
  const outsideLike = path.join(path.parse(os.tmpdir()).root, 'nox-non-temp-path-test');
  try {
    // P2-2: Даже с NOX_LINK_TEST_UNENCRYPTED_KEYS=1 и совпадающим NOX_DATA_DIR без allowTestUnencrypted=true — fail-closed.
    await assert.rejects(
      () => loadOrCreateIdentity({
        dataDir: dir,
        deviceName: 'A6-Default-Off',
        protect: null,
        env: { NOX_DATA_DIR: dir, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'safe_storage_unavailable',
    );

    // Несовпадение NOX_DATA_DIR и dataDir даже с allowTestUnencrypted=true — fail-closed.
    await assert.rejects(
      () => loadOrCreateIdentity({
        dataDir: dir,
        deviceName: 'A6-Mismatch',
        protect: null,
        allowTestUnencrypted: true,
        env: { NOX_DATA_DIR: makeTempDir('nox-link-other-'), NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'safe_storage_unavailable',
    );

    // Путь вне os.tmpdir() с allowTestUnencrypted=true тоже отклонён.
    await assert.rejects(
      () => loadOrCreateIdentity({
        dataDir: outsideLike,
        deviceName: 'A6-OutsideTmp',
        protect: null,
        allowTestUnencrypted: true,
        env: { NOX_DATA_DIR: outsideLike, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'safe_storage_unavailable',
    );

    // Полный тестовый режим во временной папке работает явно.
    const testDir = makeTempDir('nox-link-a6-ok-');
    try {
      const testId = await loadOrCreateIdentity({
        dataDir: testDir,
        deviceName: 'A6-Explicit-Test',
        protect: null,
        allowTestUnencrypted: true,
        env: { NOX_DATA_DIR: testDir, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
      });
      assert.equal(testId.storageMode, 'test-unencrypted');
      testId.dispose();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }

    // P2-6 & P2-11: safeStorage профиль нельзя понизить в test-unencrypted, а dispose затирает ключи.
    const protect = makeMockProtect(true, 0x33);
    const idSafe = await loadOrCreateIdentity({ dataDir: dir, deviceName: 'Safe-Only', protect, env: {} });
    await assert.rejects(
      () => loadOrCreateIdentity({
        dataDir: dir,
        deviceName: 'Safe-Only',
        protect: null,
        allowTestUnencrypted: true,
        env: { NOX_DATA_DIR: dir, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'safe_storage_unavailable',
    );
    idSafe.dispose();
    assert.throws(
      () => idSafe.signProof(Buffer.from('test')),
      (err) => err instanceof LinkCryptoError && err.code === 'identity_disposed',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A7 (P2-3): строгий PEM-парсинг отвергает лишний текст, нестандартные заголовки и дубли блоков', async () => {
  const dir = makeTempDir('nox-link-a7-');
  const store = new PeerTrustStore({ dataDir: dir });
  try {
    const certA = await createDeviceCertificates({ deviceName: 'Clean-A' });
    const certB = await createDeviceCertificates({ deviceName: 'Other-B' });

    const withPreamble = `# comment\n${certA.caPem}`;
    const withSecondBlock = `${certA.caPem}\n${certB.caPem}`;
    const withTrustedHeader = certA.caPem.replace(/CERTIFICATE-----/g, 'TRUSTED CERTIFICATE-----');
    const withJunkInside = certA.caPem.replace('\n', '\n!!!\n');

    for (const badCa of [withPreamble, withSecondBlock, withTrustedHeader, withJunkInside]) {
      assert.throws(() => pemToDer(badCa, 'CERTIFICATE'), (err) => err instanceof LinkCryptoError);
      assert.throws(
        () => verifyDeviceCertPair({ deviceId: certA.deviceId, caPem: badCa, leafPem: certA.leafPem }),
        (err) => err instanceof LinkCryptoError,
      );
      assert.throws(
        () => store.trustPeer({ deviceId: certA.deviceId, deviceName: 'Clean-A', caPem: badCa, leafPem: certA.leafPem }),
        (err) => err instanceof LinkCryptoError,
      );
    }

    // Не-канонический base64 в PEM также отвергается.
    const canonicalDer = pemToDer(certA.caPem, 'CERTIFICATE');
    const altB64 = `${canonicalDer.toString('base64')}====`;
    assert.throws(
      () => pemToDer(`-----BEGIN CERTIFICATE-----\n${altB64}\n-----END CERTIFICATE-----\n`, 'CERTIFICATE'),
      (err) => err instanceof LinkCryptoError,
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A8 (P2-4): нормализация имени устройства отвергает невидимые Unicode, bidi, управляющие и смешанные скрипты', () => {
  assert.equal(normalizeDeviceName('  Ноутбук Lenovo  '), 'Ноутбук Lenovo');
  assert.equal(normalizeDeviceName('  MacBook-Pro 16  '), 'MacBook-Pro 16');

  const badNames = [
    'Evil\u202EPhone',      // RLO bidi override
    'Ghost\u200BDevice',    // ZWSP
    'Isolate\u2066Name\u2069',
    'Tab\tName',
    'Line\nBreak',
    'Nbsp\u00A0Device',
    '\u0301LeadingCombine',
    'Аdmin',                // смешанные кириллица + латиница в одном токене
    'Ноутbook',
    '   ',
  ];
  for (const name of badNames) {
    assert.throws(
      () => normalizeDeviceName(name),
      (err) => err instanceof LinkCryptoError && err.code === 'invalid_device_name',
      `Имя ${JSON.stringify(name)} должно быть отклонено`,
    );
  }
});

test('A3 (P1-1): единый PeerTrustStore в процессе, внешний отзыв peers.json, гонки записи и fail-closed при порче файла', async () => {
  const dir = makeTempDir('nox-link-a3-');
  const s1 = new PeerTrustStore({ dataDir: dir });
  const s2 = new PeerTrustStore({ dataDir: dir });
  try {
    const devB = await createDeviceCertificates({ deviceName: 'Peer-B' });
    const devC = await createDeviceCertificates({ deviceName: 'Peer-C' });

    // s1 видит доверие, записанное через s2 (единое состояние процесса).
    s2.trustPeer({ deviceId: devB.deviceId, deviceName: 'Peer-B', caPem: devB.caPem, leafPem: devB.leafPem });
    assert.equal(s1.requireTrustedPeer(devB.deviceId).leafFp256, devB.leafFp256);

    // Одновременное добавление devC через s1 сохраняет и devB, и devC.
    s1.trustPeer({ deviceId: devC.deviceId, deviceName: 'Peer-C', caPem: devC.caPem, leafPem: devC.leafPem });
    assert.ok(s2.requireTrustedPeer(devB.deviceId));
    assert.ok(s2.requireTrustedPeer(devC.deviceId));

    // Отзыв через s2 немедленно стреляет на подписке s1.
    const revokeEvents = [];
    s1.onRevoke((ev) => revokeEvents.push(ev));
    s2.revokePeer(devB.deviceId, { by: 's2_admin', reason: 'lost_device' });
    assert.equal(revokeEvents.some((e) => e.deviceId === devB.deviceId), true);
    assert.throws(() => s1.requireTrustedPeer(devB.deviceId), (e) => e.code === 'peer_revoked');

    // Внешняя прямая запись в peers.json (имитация внешнего процесса) отзывает devC на живом listener s1.
    const peersPath = s1.filePath;
    const raw = JSON.parse(fs.readFileSync(peersPath, 'utf8'));
    raw.peers[devC.deviceId].revokedAt = Date.now();
    raw.peers[devC.deviceId].revokeReason = 'external_cli_revoke';
    raw.rev = (raw.rev || 0) + 1;
    fs.writeFileSync(peersPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const deadline = Date.now() + 2000;
    while (!revokeEvents.some((e) => e.deviceId === devC.deviceId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(revokeEvents.some((e) => e.deviceId === devC.deviceId), true);
    assert.throws(() => s1.requireTrustedPeer(devC.deviceId), (e) => e.code === 'peer_revoked');

    // Порча peers.json: fail-closed без молчаливого затирания.
    fs.writeFileSync(peersPath, '{ broken json', 'utf8');
    assert.throws(
      () => s1.requireTrustedPeer(devC.deviceId),
      (err) => err instanceof LinkCryptoError && err.code === 'peers_corrupted',
    );
    assert.equal(fs.readFileSync(peersPath, 'utf8'), '{ broken json');
  } finally {
    s1.close();
    s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
