'use strict';
// Независимые отрицательные тесты аудита C6. Каждый тест утверждает БЕЗОПАСНОЕ ожидание:
// падение теста = подтверждённая находка. Только временные каталоги, без реальных данных.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Duplex } = require('node:stream');

const LINK = process.env.AUDIT_LINK_DIR || 'D:/nox-release/apps/jarvis-desktop/src/link';
const link = require(LINK);

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `c6-audit-${p}-`));
const testEnv = (dir) => ({ NOX_DATA_DIR: dir, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' });

// Пара потоков; delayBtoA>0 склеивает всё, что B пишет в A, в один кусок (медленный читатель / TCP-коалесценция).
function makePair({ coalesceBtoAms = 0 } = {}) {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const mk = (out, other) => new Duplex({
    allowHalfOpen: false,
    read() {},
    write(c, e, cb) { out.write(c, e, cb); },
    final(cb) { out.end(); cb(); },
    destroy(err, cb) { out.destroy(); other.destroy(); cb(err); },
  });
  const A = mk(aToB, bToA);
  const B = mk(bToA, aToB);
  let buf = []; let timer = null;
  bToA.on('data', (c) => {
    if (!coalesceBtoAms) { A.push(c); return; }
    buf.push(c);
    if (!timer) timer = setTimeout(() => { timer = null; const all = Buffer.concat(buf); buf = []; A.push(all); }, coalesceBtoAms);
  });
  bToA.on('end', () => A.push(null));
  bToA.on('close', () => { if (!A.destroyed) A.destroy(); });
  aToB.on('data', (c) => B.push(c));
  aToB.on('end', () => B.push(null));
  aToB.on('close', () => { if (!B.destroyed) B.destroy(); });
  return [A, B];
}

const fakeIdentity = (c, name = 'Dev') => ({
  getTlsCredentials: () => ({ deviceId: c.deviceId, deviceName: name, caPem: c.caPem, leafPem: c.leafPem, leafKeyPem: c.leafKeyPem, caFp256: c.caFp256, leafFp256: c.leafFp256 }),
});

async function tryConnect(serverCreds, serverExpects, clientCreds, clientExpects, opts = {}) {
  const [s, c] = makePair();
  const res = await Promise.allSettled([
    link.establishMutualTls({ stream: s, role: 'server', identity: fakeIdentity(serverCreds), expectedPeer: serverExpects, handshakeTimeoutMs: 3000, heartbeatIntervalMs: 0, ...opts }),
    link.establishMutualTls({ stream: c, role: 'client', identity: fakeIdentity(clientCreds), expectedPeer: clientExpects, handshakeTimeoutMs: 3000, heartbeatIntervalMs: 0, ...opts }),
  ]);
  for (const r of res) if (r.status === 'fulfilled') r.value.forceAbort();
  return res;
}

test('A1 NameConstraints: лист с чужим SAN под CA устройства A отвергается TLS-движком (без пина листа)', async () => {
  const devA = await link.createDeviceCertificates();
  const victimId = link.generateDeviceId();
  const evilLeaf = await link.issueDeviceLeaf({ deviceId: victimId, caPem: devA.caPem, caKeyPem: devA.caKeyPem });
  const attacker = { ...devA, deviceId: victimId, leafPem: evilLeaf.leafPem, leafKeyPem: evilLeaf.leafKeyPem, leafFp256: evilLeaf.leafFp256 };
  const devC = await link.createDeviceCertificates();
  const res = await tryConnect(
    attacker, { deviceId: devC.deviceId, rootCaPem: devC.caPem, leafFp256: devC.leafFp256 },
    devC, { deviceId: victimId, rootCaPem: devA.caPem }, // клиент ожидает victimId под CA A, пина листа нет
  );
  const client = res[1];
  assert.equal(client.status, 'rejected', 'клиент принял лист, нарушающий NameConstraints');
  console.log('A1 client error:', client.reason.code, '|', String(client.reason.message).slice(0, 120));
});

test('A2 Пин листа обязателен: без leafFp256 второй лист под тем же CA и тем же SAN не должен приниматься', async () => {
  const devB = await link.createDeviceCertificates();
  const rogue = await link.issueDeviceLeaf({ deviceId: devB.deviceId, caPem: devB.caPem, caKeyPem: devB.caKeyPem });
  const rogueB = { ...devB, leafPem: rogue.leafPem, leafKeyPem: rogue.leafKeyPem, leafFp256: rogue.leafFp256 };
  const devC = await link.createDeviceCertificates();
  const res = await tryConnect(
    rogueB, { deviceId: devC.deviceId, rootCaPem: devC.caPem, leafFp256: devC.leafFp256 },
    devC, { deviceId: devB.deviceId, rootCaPem: devB.caPem }, // API позволяет опустить leafFp256
  );
  assert.equal(res[1].status, 'rejected', 'establishMutualTls без leafFp256 молча работает только по CA (fail-open API)');
});

test('A3 Отзыв в другом экземпляре PeerTrustStore должен рвать сеанс и блокировать новые подключения', async () => {
  const dirA = tmp('revA'); const dirB = tmp('revB');
  const devA = await link.createDeviceCertificates(); const devB = await link.createDeviceCertificates();
  const storeA = new link.PeerTrustStore({ dataDir: dirA });
  const storeB = new link.PeerTrustStore({ dataDir: dirB });
  storeA.trustPeer({ deviceId: devB.deviceId, deviceName: 'B', caPem: devB.caPem, leafPem: devB.leafPem });
  storeB.trustPeer({ deviceId: devA.deviceId, deviceName: 'A', caPem: devA.caPem, leafPem: devA.leafPem });
  const connect = async () => {
    const [s, c] = makePair();
    return Promise.all([
      link.establishMutualTls({ stream: s, role: 'server', identity: fakeIdentity(devA), expectedPeer: { deviceId: devB.deviceId }, peerStore: storeA, heartbeatIntervalMs: 0, handshakeTimeoutMs: 3000 }),
      link.establishMutualTls({ stream: c, role: 'client', identity: fakeIdentity(devB), expectedPeer: { deviceId: devA.deviceId }, peerStore: storeB, heartbeatIntervalMs: 0, handshakeTimeoutMs: 3000 }),
    ]);
  };
  const [sA, sB] = await connect();
  // Второй экземпляр (другое окно / будущая синхронизация с сервером) пишет tombstone в тот же peers.json.
  new link.PeerTrustStore({ dataDir: dirA }).revokePeer(devB.deviceId, { by: 'server_sync' });
  await new Promise((r) => setTimeout(r, 200));
  const aliveAfterRevoke = !sA.destroyed;
  let reconnectOk = false;
  try { const again = await connect(); reconnectOk = true; again.forEach((x) => x.forceAbort()); } catch { /* ожидаемо */ }
  sA.forceAbort(); sB.forceAbort();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dirA, 'link', 'peers.json'), 'utf8')).peers[devB.deviceId].revokedAt;
  console.log('A3 revokedAt on disk:', Boolean(onDisk), 'session alive:', aliveAfterRevoke, 'reconnect ok:', reconnectOk);
  assert.equal(aliveAfterRevoke, false, 'сеанс жив после отзыва, записанного другим экземпляром');
  assert.equal(reconnectOk, false, 'новое подключение прошло, хотя peers.json содержит tombstone');
});

async function pairIdentities() {
  const dA = tmp('pairA'); const dB = tmp('pairB');
  const idA = await link.loadOrCreateIdentity({ dataDir: dA, deviceName: 'Host PC', protect: null, env: testEnv(dA) });
  const idB = await link.loadOrCreateIdentity({ dataDir: dB, deviceName: 'Client PC', protect: null, env: testEnv(dB) });
  return { idA, idB, stA: new link.PeerTrustStore({ dataDir: dA }), stB: new link.PeerTrustStore({ dataDir: dB }) };
}

test('A4 Сопряжение устойчиво к склейке кадров: reveal клиента и ClientHello в одном куске у медленного хоста', async () => {
  let ok = 0; const errors = [];
  const RUNS = 10;
  for (let i = 0; i < RUNS; i += 1) {
    const { idA, idB, stA, stB } = await pairIdentities();
    const [host, client] = makePair({ coalesceBtoAms: 30 }); // всё, что клиент пишет хосту, приходит пачкой
    const roomId = `room-${i}`;
    const res = await Promise.allSettled([
      link.runPairingSession({ transport: host, role: 'host', roomId, identity: idA, expectedPeer: { deviceId: idB.deviceId, deviceName: 'Client PC' }, peerStore: stA, onConfirmSas: async () => ({ confirmed: true }), phaseTimeoutMs: 3000, handshakeTimeoutMs: 3000 }),
      link.runPairingSession({ transport: client, role: 'client', roomId, identity: idB, expectedPeer: { deviceId: idA.deviceId, deviceName: 'Host PC' }, peerStore: stB, onConfirmSas: async () => ({ confirmed: true }), phaseTimeoutMs: 3000, handshakeTimeoutMs: 3000 }),
    ]);
    if (res.every((r) => r.status === 'fulfilled')) ok += 1;
    else errors.push(res.map((r) => (r.status === 'rejected' ? r.reason.code : 'ok')).join('/'));
  }
  console.log(`A4 coalesced pairing: ${ok}/${RUNS} ok; errors: ${[...new Set(errors)].join(', ')}`);
  assert.equal(ok, RUNS, 'сопряжение ломается при склейке reveal и ClientHello');
});

test('A5 Истечение листа (90 дней) не должно навсегда блокировать собственное удостоверение', async () => {
  const d = tmp('exp');
  const t0 = Date.now();
  await link.loadOrCreateIdentity({ dataDir: d, deviceName: 'X', protect: null, env: testEnv(d), nowMs: t0 });
  let err = null;
  try { await link.loadOrCreateIdentity({ dataDir: d, deviceName: 'X', protect: null, env: testEnv(d), nowMs: t0 + 91 * 86400000 }); } catch (e) { err = e; }
  console.log('A5 load after 91 days:', err ? err.code : 'ok');
  assert.equal(err, null, 'после 91 дня identity не загружается (cert_expired), rotateLeaf недостижим');
});

test('A6 Тестовый режим без шифрования: включается любой непустой NOX_DATA_DIR и пишет ключи в любой dataDir', async () => {
  const realLooking = tmp('notTheDataDir');
  let mode = null;
  try {
    const id = await link.loadOrCreateIdentity({ dataDir: realLooking, deviceName: 'X', protect: null, env: { NOX_DATA_DIR: 'C:/anything', NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' } });
    mode = id.storageMode;
  } catch (e) { mode = e.code; }
  const raw = fs.existsSync(path.join(realLooking, 'link', 'identity.json')) ? fs.readFileSync(path.join(realLooking, 'link', 'identity.json'), 'utf8') : '';
  console.log('A6 mode:', mode, 'plaintext PRIVATE KEY on disk:', raw.includes('PRIVATE KEY'));
  assert.notEqual(mode, 'test-unencrypted', 'гейт не привязан к временной папке/тестовому процессу');
});

test('A7 PEM: лишний текст и второй блок другого типа в caPem должны отвергаться', async () => {
  const dev = await link.createDeviceCertificates();
  const other = await link.createDeviceCertificates();
  const body = other.caPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '-----$1 TRUSTED CERTIFICATE-----');
  const smuggled = `junk before\n${dev.caPem}${body}`;
  let accepted = false;
  try { link.verifyDeviceCertPair({ deviceId: dev.deviceId, caPem: smuggled, leafPem: dev.leafPem }); accepted = true; } catch { /* ok */ }
  console.log('A7 smuggled PEM accepted by verifyDeviceCertPair:', accepted);
  assert.equal(accepted, false, 'PEM с посторонним блоком принят; в peers.json и в TLS ca уйдёт сырой текст');
});

test('A8 Имя устройства: невидимые и bidi-символы (U+202E, U+200B) не должны проходить в SAS-диалог', () => {
  let ok = 0;
  for (const s of ['Office\u202Egnp.exe', 'Ноутбук\u200B', '\u2066Home\u2069']) {
    try { link.normalizeDeviceName(s); ok += 1; } catch { /* ok */ }
  }
  console.log('A8 accepted spoofable names:', ok, '/ 3');
  assert.equal(ok, 0, 'normalizeDeviceName пропускает символы формата Cf');
});

test('A9 Параллельные сопряжения одного устройства обходят лимит cooldown', async () => {
  const { idA, idB, stA, stB } = await pairIdentities();
  const tracker = new link.PairingCooldownTracker({ maxFailures: 3 });
  const runs = [];
  for (let i = 0; i < 6; i += 1) {
    const [h, c] = makePair();
    runs.push(link.runPairingSession({ transport: h, role: 'host', roomId: `r${i}`, identity: idA, expectedPeer: { deviceId: idB.deviceId, deviceName: 'Client PC' }, peerStore: stA, cooldownTracker: tracker, onConfirmSas: async () => ({ confirmed: false }), phaseTimeoutMs: 3000 }));
    runs.push(link.runPairingSession({ transport: c, role: 'client', roomId: `r${i}`, identity: idB, expectedPeer: { deviceId: idA.deviceId, deviceName: 'Host PC' }, peerStore: stB, onConfirmSas: async () => ({ confirmed: false }), phaseTimeoutMs: 3000 }));
  }
  const res = await Promise.allSettled(runs);
  const hostResults = res.filter((_, i) => i % 2 === 0).map((r) => r.reason?.code);
  const reachedSas = hostResults.filter((c) => c === 'sas_rejected' || c === 'peer_sas_rejected').length;
  console.log('A9 host outcomes:', hostResults.join(','), '| SAS shown:', reachedSas);
  assert.ok(reachedSas <= 3, `показано ${reachedSas} SAS-диалогов при лимите 3`);
});

test('A10 Таймаут рукопожатия: молчащий пир не оставляет висящего промиса', async () => {
  const dev = await link.createDeviceCertificates(); const other = await link.createDeviceCertificates();
  const [s] = makePair();
  const t = Date.now();
  const r = await Promise.allSettled([link.establishMutualTls({ stream: s, role: 'server', identity: fakeIdentity(dev), expectedPeer: { deviceId: other.deviceId, rootCaPem: other.caPem, leafFp256: other.leafFp256 }, handshakeTimeoutMs: 300 })]);
  const dt = Date.now() - t;
  console.log('A10', r[0].status, r[0].reason?.code, `${dt}ms`);
  assert.equal(r[0].reason?.code, 'tls_handshake_timeout');
  assert.ok(dt < 1500);
});
