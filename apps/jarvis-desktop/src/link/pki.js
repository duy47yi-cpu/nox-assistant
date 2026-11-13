'use strict';

// Двухуровневый PKI для Nox Link: Device Root CA -> Device Leaf (ECDSA P-256) на базе pkijs@3.4.3 / asn1js@3.1.0.
// Самописная сборка ASN.1 DER и вызов внешнего openssl.exe запрещены.
const crypto = require('crypto');
const { webcrypto, X509Certificate } = crypto;
const asn1js = require('asn1js');
const pkijs = require('pkijs');
const { LinkCryptoError, assertUuidV4 } = require('./errors');

const ENGINE_NAME = 'nox-link-webcrypto';
pkijs.setEngine(
  ENGINE_NAME,
  webcrypto,
  new pkijs.CryptoEngine({
    name: ENGINE_NAME,
    crypto: webcrypto,
    subtle: webcrypto.subtle,
  }),
);

const ECDSA_P256_ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const OID_CN = '2.5.4.3';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const OID_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';

const DEFAULT_CA_DAYS = 365 * 5;
const DEFAULT_LEAF_DAYS = 90;
const DEFAULT_LEAF_RENEW_BEFORE_DAYS = 14;
const DEFAULT_CA_RENEW_WARNING_DAYS = 30;
const CLOCK_SKEW_BACK_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function generateDeviceId() {
  return assertUuidV4(crypto.randomUUID().toLowerCase(), 'deviceId');
}

function hostOf(deviceId) {
  assertUuidV4(deviceId, 'deviceId');
  return `${deviceId}.link.nox`;
}

function caCommonName(deviceId) {
  assertUuidV4(deviceId, 'deviceId');
  return `Nox Link Device CA (${deviceId})`;
}

function randomPositiveSerialBytes() {
  const buf = crypto.randomBytes(16);
  // Гарантируем положительный ненулевой DER INTEGER без старшего знакового бита.
  buf[0] &= 0x7f;
  if (buf[0] === 0) buf[0] = 0x01;
  return buf;
}

function makeTime(ms) {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  return new pkijs.Time({
    type: year >= 2050 ? 1 : 0,
    value: date,
  });
}

function toPem(label, derBuffer) {
  const b64 = Buffer.from(derBuffer).toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function pemToDer(pem, expectedLabel) {
  if (typeof pem !== 'string' || !pem.trim()) {
    throw new LinkCryptoError('invalid_pem', `Отсутствует PEM (${expectedLabel})`);
  }
  const trimmed = pem.trim();
  const escapedLabel = expectedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^-----BEGIN ${escapedLabel}-----\\r?\\n([A-Za-z0-9+/=\\r\\n]+?)\\r?\\n-----END ${escapedLabel}-----$`,
  );
  const match = trimmed.match(re);
  if (!match) {
    throw new LinkCryptoError('invalid_pem', `Ожидался строго один канонический блок ${expectedLabel} без посторонних данных`);
  }
  const body = match[1].replace(/\s+/g, '');
  if (!body || body.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) {
    throw new LinkCryptoError('invalid_pem', `Повреждённое содержимое PEM (${expectedLabel})`);
  }
  const der = Buffer.from(body, 'base64');
  if (der.length === 0 || der.toString('base64') !== body) {
    throw new LinkCryptoError('invalid_pem', `Неканонический base64 или пустой DER (${expectedLabel})`);
  }
  return der;
}

function fingerprint256Raw(pemOrDer) {
  const der = Buffer.isBuffer(pemOrDer)
    ? pemOrDer
    : pemToDer(pemOrDer, 'CERTIFICATE');
  return crypto.createHash('sha256').update(der).digest();
}

function fingerprint256Hex(pemOrDer) {
  return fingerprint256Raw(pemOrDer).toString('hex');
}

function hexToFpBuffer(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) {
    return null;
  }
  return Buffer.from(hex, 'hex');
}

function fingerprintsEqual(a, b) {
  const bufA = Buffer.isBuffer(a) ? a : hexToFpBuffer(a);
  const bufB = Buffer.isBuffer(b) ? b : hexToFpBuffer(b);
  if (!bufA || !bufB || bufA.length !== 32 || bufB.length !== 32) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function computeSubjectKeyIdentifier(cert) {
  const spkiBytes = Buffer.from(cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView);
  return crypto.createHash('sha1').update(spkiBytes).digest();
}

async function generateEcP256KeyPair() {
  return webcrypto.subtle.generateKey(ECDSA_P256_ALG, true, ['sign', 'verify']);
}

async function exportPrivateKeyPem(privateKey) {
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', privateKey);
  return toPem('PRIVATE KEY', pkcs8);
}

async function importPrivateKeyPem(privateKeyPem) {
  const der = pemToDer(privateKeyPem, 'PRIVATE KEY');
  return webcrypto.subtle.importKey('pkcs8', der, ECDSA_P256_ALG, true, ['sign']);
}

function computeValidityWindow({ nowMs = Date.now(), days, notBeforeMs, notAfterMs }) {
  const nb = Number.isFinite(notBeforeMs) ? notBeforeMs : (nowMs - CLOCK_SKEW_BACK_MS);
  const na = Number.isFinite(notAfterMs) ? notAfterMs : (nowMs + days * DAY_MS);
  return { nb, na };
}

async function issueDeviceRootCa({
  deviceId = generateDeviceId(),
  caDays = DEFAULT_CA_DAYS,
  nowMs = Date.now(),
  notBeforeMs,
  notAfterMs,
} = {}) {
  assertUuidV4(deviceId, 'deviceId');
  const host = hostOf(deviceId);
  const cn = caCommonName(deviceId);
  const caKeys = await generateEcP256KeyPair();

  const cert = new pkijs.Certificate();
  cert.version = 2;
  const serialBytes = randomPositiveSerialBytes();
  cert.serialNumber = new asn1js.Integer({ valueHex: serialBytes });
  cert.subject.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: OID_CN,
      value: new asn1js.Utf8String({ value: cn }),
    }),
  );
  cert.issuer.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: OID_CN,
      value: new asn1js.Utf8String({ value: cn }),
    }),
  );

  const { nb, na } = computeValidityWindow({ nowMs, days: caDays, notBeforeMs, notAfterMs });
  cert.notBefore = makeTime(nb);
  cert.notAfter = makeTime(na);

  await cert.subjectPublicKeyInfo.importKey(caKeys.publicKey);
  const ski = computeSubjectKeyIdentifier(cert);

  const basicConstraints = new pkijs.BasicConstraints({ cA: true, pathLenConstraint: 0 });
  // RFC 5280 KeyUsage: keyCertSign (bit 5 = 0x04) | cRLSign (bit 6 = 0x02) = 0x06, unusedBits = 1.
  const keyUsage = new asn1js.BitString({ valueHex: new Uint8Array([0x06]), unusedBits: 1 });
  const nameConstraints = new pkijs.NameConstraints({
    permittedSubtrees: [
      new pkijs.GeneralSubtree({
        base: new pkijs.GeneralName({ type: 2, value: host }),
      }),
    ],
  });
  const skiOctet = new asn1js.OctetString({ valueHex: ski });

  cert.extensions = [
    new pkijs.Extension({
      extnID: pkijs.id_BasicConstraints,
      critical: true,
      extnValue: basicConstraints.toSchema().toBER(false),
    }),
    new pkijs.Extension({
      extnID: pkijs.id_KeyUsage,
      critical: true,
      extnValue: keyUsage.toBER(false),
    }),
    new pkijs.Extension({
      extnID: pkijs.id_NameConstraints,
      critical: true,
      extnValue: nameConstraints.toSchema().toBER(false),
    }),
    new pkijs.Extension({
      extnID: pkijs.id_SubjectKeyIdentifier,
      critical: false,
      extnValue: skiOctet.toBER(false),
    }),
  ];

  await cert.sign(caKeys.privateKey, 'SHA-256');
  const caDer = Buffer.from(cert.toSchema().toBER(false));
  const caPem = toPem('CERTIFICATE', caDer);
  const caKeyPem = await exportPrivateKeyPem(caKeys.privateKey);
  const caFp256 = fingerprint256Hex(caDer);

  return {
    deviceId,
    host,
    caPem,
    caKeyPem,
    caFp256,
    serialHex: serialBytes.toString('hex'),
  };
}

async function issueDeviceLeaf({
  deviceId,
  caPem,
  caKeyPem,
  leafDays = DEFAULT_LEAF_DAYS,
  nowMs = Date.now(),
  notBeforeMs,
  notAfterMs,
}) {
  assertUuidV4(deviceId, 'deviceId');
  const host = hostOf(deviceId);
  const caDer = pemToDer(caPem, 'CERTIFICATE');
  const caCert = pkijs.Certificate.fromBER(caDer);
  const caSki = computeSubjectKeyIdentifier(caCert);
  const caPrivateKey = await importPrivateKeyPem(caKeyPem);

  // Проверяем, что caKeyPem действительно соответствует открытому ключу caPem.
  const caX509 = new X509Certificate(caDer);
  const caPubFromPriv = crypto.createPublicKey(caKeyPem);
  if (!caX509.publicKey.export({ type: 'spki', format: 'der' }).equals(
    caPubFromPriv.export({ type: 'spki', format: 'der' }),
  )) {
    throw new LinkCryptoError('ca_key_mismatch', 'Приватный ключ Root CA не соответствует сертификату CA');
  }

  const leafKeys = await generateEcP256KeyPair();
  const cert = new pkijs.Certificate();
  cert.version = 2;
  const serialBytes = randomPositiveSerialBytes();
  cert.serialNumber = new asn1js.Integer({ valueHex: serialBytes });
  cert.issuer = caCert.subject;
  cert.subject.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: OID_CN,
      value: new asn1js.Utf8String({ value: host }),
    }),
  );

  const { nb, na } = computeValidityWindow({ nowMs, days: leafDays, notBeforeMs, notAfterMs });
  cert.notBefore = makeTime(nb);
  cert.notAfter = makeTime(na);

  await cert.subjectPublicKeyInfo.importKey(leafKeys.publicKey);
  const leafSki = computeSubjectKeyIdentifier(cert);

  const basicConstraints = new pkijs.BasicConstraints({ cA: false });
  // RFC 5280 KeyUsage: digitalSignature (bit 0 = 0x80), unusedBits = 7. keyEncipherment и keyCertSign запрещены.
  const keyUsage = new asn1js.BitString({ valueHex: new Uint8Array([0x80]), unusedBits: 7 });
  const extKeyUsage = new pkijs.ExtKeyUsage({
    keyPurposes: [OID_SERVER_AUTH, OID_CLIENT_AUTH],
  });
  const altNames = new pkijs.GeneralNames({
    names: [new pkijs.GeneralName({ type: 2, value: host })],
  });
  const skiOctet = new asn1js.OctetString({ valueHex: leafSki });
  const aki = new pkijs.AuthorityKeyIdentifier({
    keyIdentifier: new asn1js.OctetString({ valueHex: caSki }),
  });

  cert.extensions = [
    new pkijs.Extension({
      extnID: pkijs.id_BasicConstraints,
      critical: true,
      extnValue: basicConstraints.toSchema().toBER(false),
    }),
    new pkijs.Extension({
      extnID: pkijs.id_KeyUsage,
      critical: true,
      extnValue: keyUsage.toBER(false),
    }),
    new pkijs.Extension({
      extnID: pkijs.id_ExtKeyUsage,
      critical: false,
      extnValue: extKeyUsage.toSchema().toBER(false),
    }),
    new pkijs.Extension({
      extnID: pkijs.id_SubjectAltName,
      critical: false,
      extnValue: altNames.toSchema().toBER(false),
    }),
    new pkijs.Extension({
      extnID: pkijs.id_SubjectKeyIdentifier,
      critical: false,
      extnValue: skiOctet.toBER(false),
    }),
    new pkijs.Extension({
      extnID: pkijs.id_AuthorityKeyIdentifier,
      critical: false,
      extnValue: aki.toSchema().toBER(false),
    }),
  ];

  await cert.sign(caPrivateKey, 'SHA-256');
  const leafDer = Buffer.from(cert.toSchema().toBER(false));
  const leafPem = toPem('CERTIFICATE', leafDer);
  const leafKeyPem = await exportPrivateKeyPem(leafKeys.privateKey);
  const leafFp256 = fingerprint256Hex(leafDer);

  return {
    deviceId,
    host,
    leafPem,
    leafKeyPem,
    leafFp256,
    serialHex: serialBytes.toString('hex'),
  };
}

async function createDeviceCertificates({
  deviceId = generateDeviceId(),
  caDays = DEFAULT_CA_DAYS,
  leafDays = DEFAULT_LEAF_DAYS,
  nowMs = Date.now(),
} = {}) {
  const ca = await issueDeviceRootCa({ deviceId, caDays, nowMs });
  const leaf = await issueDeviceLeaf({
    deviceId,
    caPem: ca.caPem,
    caKeyPem: ca.caKeyPem,
    leafDays,
    nowMs,
  });
  return {
    deviceId: ca.deviceId,
    host: ca.host,
    caPem: ca.caPem,
    caKeyPem: ca.caKeyPem,
    caFp256: ca.caFp256,
    leafPem: leaf.leafPem,
    leafKeyPem: leaf.leafKeyPem,
    leafFp256: leaf.leafFp256,
  };
}

async function rotateDeviceLeaf({
  deviceId,
  caPem,
  caKeyPem,
  leafDays = DEFAULT_LEAF_DAYS,
  nowMs = Date.now(),
}) {
  assertUuidV4(deviceId, 'deviceId');
  // Проверяем целостность CA до выпуска нового листа.
  inspectRootCa({ deviceId, caPem, nowMs });
  return issueDeviceLeaf({ deviceId, caPem, caKeyPem, leafDays, nowMs });
}

function getExtension(cert, oid) {
  if (!Array.isArray(cert.extensions)) return null;
  return cert.extensions.find((ext) => ext.extnID === oid) || null;
}

function assertPositiveSerial(cert, label) {
  const bytes = Buffer.from(cert.serialNumber.valueBlock.valueHexView);
  if (bytes.length === 0 || bytes.length > 20 || cert.serialNumber.valueBlock.isNegative) {
    throw new LinkCryptoError('invalid_cert_serial', `${label}: недопустимый серийный номер сертификата`);
  }
  if ((bytes[0] & 0x80) !== 0 || bytes.every((b) => b === 0)) {
    throw new LinkCryptoError('invalid_cert_serial', `${label}: серийный номер должен быть положительным ненулевым`);
  }
}

function assertEcP256Key(x509, label) {
  const pub = x509.publicKey;
  if (!pub || pub.asymmetricKeyType !== 'ec' || pub.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new LinkCryptoError('invalid_cert_key', `${label}: требуется ключ ECDSA P-256`);
  }
}

function assertValidTimeWindow(x509, nowMs, label, { allowExpired = false } = {}) {
  const fromMs = Date.parse(x509.validFrom);
  const toMs = Date.parse(x509.validTo);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new LinkCryptoError('invalid_cert_time', `${label}: повреждён срок действия сертификата`);
  }
  if (nowMs < fromMs) {
    throw new LinkCryptoError('cert_not_yet_valid', `${label}: сертификат ещё не вступил в силу`);
  }
  const expired = nowMs > toMs;
  if (expired && !allowExpired) {
    throw new LinkCryptoError('cert_expired', `${label}: срок действия сертификата истёк`);
  }
  return { validFromMs: fromMs, validToMs: toMs, expired };
}

function getCertValidityInfo(pemOrDer) {
  const der = Buffer.isBuffer(pemOrDer) ? pemOrDer : pemToDer(pemOrDer, 'CERTIFICATE');
  const x509 = new X509Certificate(der);
  const validFromMs = Date.parse(x509.validFrom);
  const validToMs = Date.parse(x509.validTo);
  if (!Number.isFinite(validFromMs) || !Number.isFinite(validToMs) || validFromMs >= validToMs) {
    throw new LinkCryptoError('invalid_cert_time', 'Повреждён срок действия сертификата');
  }
  return { validFromMs, validToMs };
}

function parseKeyUsageBitString(ext, label) {
  if (!ext || ext.critical !== true) {
    throw new LinkCryptoError('invalid_cert_key_usage', `${label}: отсутствует critical KeyUsage`);
  }
  const asn = asn1js.fromBER(ext.extnValue.valueBlock.valueHexView);
  if (asn.offset === -1 || !(asn.result instanceof asn1js.BitString)) {
    throw new LinkCryptoError('invalid_cert_key_usage', `${label}: повреждён KeyUsage BitString`);
  }
  const bytes = Buffer.from(asn.result.valueBlock.valueHexView);
  const unusedBits = asn.result.valueBlock.unusedBits;
  return { bytes, unusedBits };
}

function parseExtensionObject(ClassRef, ext, code, label) {
  if (!ext) {
    throw new LinkCryptoError(code, `${label}: отсутствует обязательное расширение`);
  }
  try {
    return ClassRef.fromBER(ext.extnValue.valueBlock.valueHexView);
  } catch {
    throw new LinkCryptoError(code, `${label}: повреждённое расширение X.509`);
  }
}

function inspectRootCa({ deviceId, caPem, nowMs = Date.now() }) {
  assertUuidV4(deviceId, 'deviceId');
  const expectedHost = hostOf(deviceId);
  const expectedCn = caCommonName(deviceId);

  const caDer = pemToDer(caPem, 'CERTIFICATE');
  let caCert;
  let caX509;
  try {
    caCert = pkijs.Certificate.fromBER(caDer);
    caX509 = new X509Certificate(caDer);
  } catch {
    throw new LinkCryptoError('invalid_ca_cert', 'Device Root CA не является корректным X.509 сертификатом');
  }

  assertPositiveSerial(caCert, 'Root CA');
  assertEcP256Key(caX509, 'Root CA');
  const caTimes = assertValidTimeWindow(caX509, nowMs, 'Root CA');

  if (!caX509.checkIssued(caX509) || !caX509.verify(caX509.publicKey)) {
    throw new LinkCryptoError('invalid_ca_signature', 'Device Root CA должен быть валидно самоподписан');
  }

  const cnAttr = caCert.subject.typesAndValues.find((tv) => tv.type === OID_CN);
  if (!cnAttr || cnAttr.value.valueBlock.value !== expectedCn) {
    throw new LinkCryptoError('invalid_ca_subject', 'Subject Device Root CA не соответствует deviceId');
  }

  const bcExt = getExtension(caCert, pkijs.id_BasicConstraints);
  if (!bcExt || bcExt.critical !== true) {
    throw new LinkCryptoError('invalid_ca_basic_constraints', 'Root CA: BasicConstraints должен быть critical');
  }
  const bc = parseExtensionObject(pkijs.BasicConstraints, bcExt, 'invalid_ca_basic_constraints', 'Root CA');
  const pathLen = typeof bc.pathLenConstraint === 'number'
    ? bc.pathLenConstraint
    : bc.pathLenConstraint?.valueBlock?.valueDec;
  if (bc.cA !== true || pathLen !== 0) {
    throw new LinkCryptoError('invalid_ca_basic_constraints', 'Root CA: требуется CA:TRUE и pathlen:0');
  }

  const ku = parseKeyUsageBitString(getExtension(caCert, pkijs.id_KeyUsage), 'Root CA');
  if (ku.bytes.length !== 1 || ku.bytes[0] !== 0x06 || ku.unusedBits !== 1) {
    throw new LinkCryptoError('invalid_ca_key_usage', 'Root CA: разрешены только keyCertSign | cRLSign (0x06, unusedBits=1)');
  }

  if (getExtension(caCert, pkijs.id_ExtKeyUsage)) {
    throw new LinkCryptoError('invalid_ca_eku', 'Root CA не должен содержать ExtendedKeyUsage');
  }
  if (getExtension(caCert, pkijs.id_SubjectAltName)) {
    throw new LinkCryptoError('invalid_ca_san', 'Root CA не должен содержать SubjectAltName');
  }

  const ncExt = getExtension(caCert, pkijs.id_NameConstraints);
  if (!ncExt || ncExt.critical !== true) {
    throw new LinkCryptoError('invalid_ca_name_constraints', 'Root CA: NameConstraints должен быть critical');
  }
  const nc = parseExtensionObject(pkijs.NameConstraints, ncExt, 'invalid_ca_name_constraints', 'Root CA');
  if (
    !Array.isArray(nc.permittedSubtrees)
    || nc.permittedSubtrees.length !== 1
    || (nc.excludedSubtrees && nc.excludedSubtrees.length > 0)
  ) {
    throw new LinkCryptoError('invalid_ca_name_constraints', 'Root CA: NameConstraints должен содержать ровно один permittedSubtree');
  }
  const subtreeBase = nc.permittedSubtrees[0].base;
  if (!subtreeBase || subtreeBase.type !== 2 || subtreeBase.value !== expectedHost) {
    throw new LinkCryptoError('invalid_ca_name_constraints', 'Root CA: NameConstraints не ограничивает DNS до host устройства');
  }

  const skiExt = getExtension(caCert, pkijs.id_SubjectKeyIdentifier);
  if (!skiExt) {
    throw new LinkCryptoError('invalid_ca_ski', 'Root CA: отсутствует SubjectKeyIdentifier');
  }
  const skiAsn = asn1js.fromBER(skiExt.extnValue.valueBlock.valueHexView);
  if (skiAsn.offset === -1 || !(skiAsn.result instanceof asn1js.OctetString)) {
    throw new LinkCryptoError('invalid_ca_ski', 'Root CA: повреждён SubjectKeyIdentifier');
  }
  const caSkiBytes = Buffer.from(skiAsn.result.valueBlock.valueHexView);

  return {
    caDer,
    caPem: toPem('CERTIFICATE', caDer),
    caCert,
    caX509,
    caFp256: fingerprint256Hex(caDer),
    caSkiBytes,
    validFromMs: caTimes.validFromMs,
    validToMs: caTimes.validToMs,
  };
}

function inspectLeaf({ deviceId, leafPem, caInfo, nowMs = Date.now(), allowExpired = false }) {
  assertUuidV4(deviceId, 'deviceId');
  const expectedHost = hostOf(deviceId);
  const leafDer = pemToDer(leafPem, 'CERTIFICATE');
  let leafCert;
  let leafX509;
  try {
    leafCert = pkijs.Certificate.fromBER(leafDer);
    leafX509 = new X509Certificate(leafDer);
  } catch {
    throw new LinkCryptoError('invalid_leaf_cert', 'Device Leaf не является корректным X.509 сертификатом');
  }

  assertPositiveSerial(leafCert, 'Device Leaf');
  assertEcP256Key(leafX509, 'Device Leaf');
  const leafTimes = assertValidTimeWindow(leafX509, nowMs, 'Device Leaf', { allowExpired });

  // Запрещаем совпадение ключей CA и Leaf.
  const caSpki = caInfo.caX509.publicKey.export({ type: 'spki', format: 'der' });
  const leafSpki = leafX509.publicKey.export({ type: 'spki', format: 'der' });
  if (caSpki.equals(leafSpki)) {
    throw new LinkCryptoError('shared_ca_leaf_key', 'Root CA и Device Leaf не должны использовать один и тот же ключ');
  }

  if (!leafX509.checkIssued(caInfo.caX509) || !leafX509.verify(caInfo.caX509.publicKey)) {
    throw new LinkCryptoError('invalid_leaf_chain', 'Device Leaf не подписан указанным Device Root CA');
  }

  const bcExt = getExtension(leafCert, pkijs.id_BasicConstraints);
  if (!bcExt || bcExt.critical !== true) {
    throw new LinkCryptoError('invalid_leaf_basic_constraints', 'Device Leaf: BasicConstraints должен быть critical');
  }
  const bc = parseExtensionObject(pkijs.BasicConstraints, bcExt, 'invalid_leaf_basic_constraints', 'Device Leaf');
  if (bc.cA !== false) {
    throw new LinkCryptoError('invalid_leaf_basic_constraints', 'Device Leaf обязан иметь CA:FALSE');
  }

  const ku = parseKeyUsageBitString(getExtension(leafCert, pkijs.id_KeyUsage), 'Device Leaf');
  if (ku.bytes.length !== 1 || ku.bytes[0] !== 0x80 || ku.unusedBits !== 7) {
    throw new LinkCryptoError('invalid_leaf_key_usage', 'Device Leaf: разрешён только digitalSignature (0x80, unusedBits=7)');
  }

  const eku = parseExtensionObject(
    pkijs.ExtKeyUsage,
    getExtension(leafCert, pkijs.id_ExtKeyUsage),
    'invalid_leaf_eku',
    'Device Leaf',
  );
  const purposes = Array.isArray(eku.keyPurposes) ? eku.keyPurposes : [];
  if (
    purposes.length !== 2
    || !purposes.includes(OID_SERVER_AUTH)
    || !purposes.includes(OID_CLIENT_AUTH)
  ) {
    throw new LinkCryptoError('invalid_leaf_eku', 'Device Leaf: EKU должен содержать строго serverAuth и clientAuth');
  }

  const san = parseExtensionObject(
    pkijs.GeneralNames,
    getExtension(leafCert, pkijs.id_SubjectAltName),
    'invalid_leaf_san',
    'Device Leaf',
  );
  if (!Array.isArray(san.names) || san.names.length !== 1 || san.names[0].type !== 2 || san.names[0].value !== expectedHost) {
    throw new LinkCryptoError('invalid_leaf_san', 'Device Leaf: SubjectAltName должен содержать строго DNS:<deviceId>.link.nox');
  }
  if (leafX509.checkHost(expectedHost) !== expectedHost) {
    throw new LinkCryptoError('invalid_leaf_san', 'Device Leaf не проходит проверку checkHost для deviceId');
  }

  const aki = parseExtensionObject(
    pkijs.AuthorityKeyIdentifier,
    getExtension(leafCert, pkijs.id_AuthorityKeyIdentifier),
    'invalid_leaf_aki',
    'Device Leaf',
  );
  const akiBytes = aki.keyIdentifier ? Buffer.from(aki.keyIdentifier.valueBlock.valueHexView) : null;
  if (!akiBytes || akiBytes.length !== caInfo.caSkiBytes.length || !crypto.timingSafeEqual(akiBytes, caInfo.caSkiBytes)) {
    throw new LinkCryptoError('invalid_leaf_aki', 'Device Leaf: AuthorityKeyIdentifier не совпадает с SubjectKeyIdentifier CA');
  }

  return {
    leafDer,
    leafPem: toPem('CERTIFICATE', leafDer),
    leafCert,
    leafX509,
    leafFp256: fingerprint256Hex(leafDer),
    validFromMs: leafTimes.validFromMs,
    validToMs: leafTimes.validToMs,
    expired: leafTimes.expired,
  };
}

function verifyDeviceCertPair({ deviceId, caPem, leafPem, nowMs = Date.now() }) {
  const caInfo = inspectRootCa({ deviceId, caPem, nowMs });
  const leafInfo = inspectLeaf({ deviceId, leafPem, caInfo, nowMs, allowExpired: false });
  return {
    ok: true,
    deviceId,
    host: hostOf(deviceId),
    caPem: caInfo.caPem,
    leafPem: leafInfo.leafPem,
    caFp256: caInfo.caFp256,
    leafFp256: leafInfo.leafFp256,
    caX509: caInfo.caX509,
    leafX509: leafInfo.leafX509,
    caCert: caInfo.caCert,
    leafCert: leafInfo.leafCert,
    caValidFromMs: caInfo.validFromMs,
    caValidToMs: caInfo.validToMs,
    leafValidFromMs: leafInfo.validFromMs,
    leafValidToMs: leafInfo.validToMs,
  };
}

function inspectDeviceCertPairLifecycle({ deviceId, caPem, leafPem, nowMs = Date.now() }) {
  const caInfo = inspectRootCa({ deviceId, caPem, nowMs });
  const leafInfo = inspectLeaf({ deviceId, leafPem, caInfo, nowMs, allowExpired: true });
  return {
    ok: true,
    deviceId,
    host: hostOf(deviceId),
    caPem: caInfo.caPem,
    leafPem: leafInfo.leafPem,
    caFp256: caInfo.caFp256,
    leafFp256: leafInfo.leafFp256,
    caX509: caInfo.caX509,
    leafX509: leafInfo.leafX509,
    caValidFromMs: caInfo.validFromMs,
    caValidToMs: caInfo.validToMs,
    leafValidFromMs: leafInfo.validFromMs,
    leafValidToMs: leafInfo.validToMs,
    leafExpired: leafInfo.expired,
  };
}

function signWithLeafKey(leafKeyPem, data) {
  const key = crypto.createPrivateKey(leafKeyPem);
  return crypto.sign('sha256', Buffer.from(data), key);
}

function verifyWithLeafCert(leafPem, data, signature) {
  const der = pemToDer(leafPem, 'CERTIFICATE');
  const x509 = new X509Certificate(der);
  return crypto.verify('sha256', Buffer.from(data), x509.publicKey, Buffer.from(signature));
}

module.exports = {
  DAY_MS,
  DEFAULT_CA_DAYS,
  DEFAULT_LEAF_DAYS,
  DEFAULT_LEAF_RENEW_BEFORE_DAYS,
  DEFAULT_CA_RENEW_WARNING_DAYS,
  OID_SERVER_AUTH,
  OID_CLIENT_AUTH,
  generateDeviceId,
  hostOf,
  caCommonName,
  toPem,
  pemToDer,
  hexToFpBuffer,
  fingerprint256Raw,
  fingerprint256Hex,
  fingerprintsEqual,
  getCertValidityInfo,
  issueDeviceRootCa,
  issueDeviceLeaf,
  createDeviceCertificates,
  rotateDeviceLeaf,
  inspectDeviceCertPairLifecycle,
  verifyDeviceCertPair,
  signWithLeafKey,
  verifyWithLeafCert,
};
