'use strict';

// Фаза 2 и 4: испытания взаимного TLS 1.3 ядра Nox Link в двух изолированных профилях.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { PassThrough, Duplex } = require('node:stream');

const {
  DAY_MS,
  MAX_INBOX_FRAMES,
  LinkCryptoError,
  loadOrCreateIdentity,
  PeerTrustStore,
  establishMutualTls,
  verifyConnectedPeerSocket,
  asDuplex,
  issueDeviceLeaf,
  createDeviceCertificates,
  generateDeviceId,
  hostOf,
} = require('../src/link');

function makeProtect(tag = 0x42) {
  const key = crypto.createHash('sha256').update(Buffer.from([tag])).digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]);
    },
    decryptString: (buf) => {
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

function startLoopbackRelay() {
  const rooms = new Map();
  const sockets = new Set();
  const relay = { port: 0, seen: [], mangle: null };
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => {
      sockets.delete(sock);
      if (rooms.get(req.url) === sock) rooms.delete(req.url);
    });
    const other = rooms.get(req.url);
    if (!other) {
      rooms.set(req.url, sock);
      return;
    }
    rooms.delete(req.url);
    for (const s of [sock, other]) {
      s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: nox-link\r\n\r\n');
    }
    const pipe = (from, to) => {
      from.on('data', (chunk) => {
        relay.seen.push(chunk);
        if (!to.destroyed) to.write(relay.mangle ? relay.mangle(chunk) : chunk);
      });
      from.on('end', () => {
        if (!to.destroyed) to.end();
      });
      from.on('close', () => {
        if (!to.destroyed) to.destroy();
      });
    };
    pipe(sock, other);
    pipe(other, sock);
  });
  relay.dropAll = () => {
    for (const s of [...sockets]) {
      try { s.destroy(); } catch { /* ignore */ }
    }
  };
  relay.close = () => new Promise((resolve) => {
    relay.dropAll();
    server.close(resolve);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      relay.port = server.address().port;
      resolve(relay);
    });
  });
}

function dialRelay(port, roomPath, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: roomPath,
      headers: { Connection: 'Upgrade', Upgrade: 'nox-link' },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('relay_dial_timeout'));
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on('upgrade', (res, sock, head) => {
      clearTimeout(timer);
      resolve(asDuplex(sock, { initialBuffer: head }));
    });
    req.end();
  });
}

function makeInMemoryDuplexPair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const sideA = new Duplex({
    allowHalfOpen: false,
    read() {},
    write(chunk, enc, cb) { aToB.write(chunk, enc, cb); },
    final(cb) { aToB.end(); cb(); },
    destroy(err, cb) { aToB.destroy(); bToA.destroy(); cb(err); },
  });
  const sideB = new Duplex({
    allowHalfOpen: false,
    read() {},
    write(chunk, enc, cb) { bToA.write(chunk, enc, cb); },
    final(cb) { bToA.end(); cb(); },
    destroy(err, cb) { bToA.destroy(); aToB.destroy(); cb(err); },
  });
  bToA.on('data', (c) => sideA.push(c));
  bToA.on('end', () => sideA.push(null));
  bToA.on('close', () => { if (!sideA.destroyed) sideA.destroy(); });
  aToB.on('data', (c) => sideB.push(c));
  aToB.on('end', () => sideB.push(null));
  aToB.on('close', () => { if (!sideB.destroyed) sideB.destroy(); });
  return [sideA, sideB];
}

async function createProfile(rootDir, name, tag) {
  const dataDir = path.join(rootDir, name);
  const identity = await loadOrCreateIdentity({
    dataDir,
    deviceName: name,
    protect: makeProtect(tag),
    env: {},
  });
  const peers = new PeerTrustStore({ dataDir });
  return { dataDir, identity, peers };
}

function pairProfiles(p1, p2) {
  p1.peers.trustPeer({
    deviceId: p2.identity.deviceId,
    deviceName: p2.identity.deviceName,
    caPem: p2.identity.caPem,
    leafPem: p2.identity.leafPem,
  });
  p2.peers.trustPeer({
    deviceId: p1.identity.deviceId,
    deviceName: p1.identity.deviceName,
    caPem: p1.identity.caPem,
    leafPem: p1.identity.leafPem,
  });
}

let tempRoot;
let relay;
let profA;
let profB;

before(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-tls-core-'));
  relay = await startLoopbackRelay();
  profA = await createProfile(tempRoot, 'Profile-A', 0x11);
  profB = await createProfile(tempRoot, 'Profile-B', 0x22);
  pairProfiles(profA, profB);
});

after(async () => {
  profA?.identity?.dispose();
  profB?.identity?.dispose();
  await relay?.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

afterEach(() => {
  relay.mangle = null;
  relay.seen.length = 0;
  relay.dropAll();
});

test('Корректная пара устройств: взаимный TLS 1.3 через relay, шифрование трафика, чистая остановка', async () => {
  const room = `/pair/${crypto.randomBytes(8).toString('hex')}`;
  const [rawA, rawB] = await Promise.all([
    dialRelay(relay.port, room),
    dialRelay(relay.port, room),
  ]);
  const [sessA, sessB] = await Promise.all([
    establishMutualTls({
      stream: rawA,
      role: 'client',
      identity: profA.identity,
      expectedPeer: profA.peers.requireTrustedPeer(profB.identity.deviceId),
      peerStore: profA.peers,
      heartbeatIntervalMs: 0,
    }),
    establishMutualTls({
      stream: rawB,
      role: 'server',
      identity: profB.identity,
      expectedPeer: profB.peers.requireTrustedPeer(profA.identity.deviceId),
      peerStore: profB.peers,
      heartbeatIntervalMs: 0,
    }),
  ]);

  assert.equal(sessA.protocol, 'TLSv1.3');
  assert.equal(sessB.protocol, 'TLSv1.3');
  assert.equal(sessA.authorized, true);
  assert.equal(sessB.authorized, true);
  assert.equal(sessA.reusedSession, false);
  assert.equal(sessB.reusedSession, false);
  assert.equal(JSON.stringify(sessA).includes('PRIVATE KEY'), false);

  const secretPayload = 'TOP-SECRET-PAYLOAD-C6';
  const recvB = sessB.waitNextFrame({ timeoutMs: 2000 });
  await sessA.sendFrame({ v: 3, type: 'ping_data', payload: secretPayload });
  const got = await recvB;
  assert.equal(got.payload, secretPayload);

  // Посредник не видит открытый текст.
  const wire = Buffer.concat(relay.seen);
  assert.ok(wire.length > 0);
  assert.equal(wire.includes(secretPayload), false);

  await Promise.all([sessA.close(), sessB.close()]);
  assert.equal(sessA.destroyed, true);
  assert.equal(sessB.destroyed, true);
});

test('Чужой сертификат и второй лист под тем же CA (нарушение leafFp256 пина) отвергаются', async () => {
  // 1. Третье устройство C (даже если оно сопряжено с B) не может притвориться A.
  const profC = await createProfile(tempRoot, `Profile-C-${Date.now()}`, 0x33);
  profB.peers.trustPeer({
    deviceId: profC.identity.deviceId,
    deviceName: profC.identity.deviceName,
    caPem: profC.identity.caPem,
    leafPem: profC.identity.leafPem,
  });
  profC.peers.trustPeer({
    deviceId: profB.identity.deviceId,
    deviceName: profB.identity.deviceName,
    caPem: profB.identity.caPem,
    leafPem: profB.identity.leafPem,
  });

  const [s1, s2] = makeInMemoryDuplexPair();
  const res = await Promise.allSettled([
    establishMutualTls({
      stream: s1,
      role: 'client',
      identity: profC.identity,
      expectedPeer: profC.peers.requireTrustedPeer(profB.identity.deviceId),
      handshakeTimeoutMs: 1500,
      heartbeatIntervalMs: 0,
    }),
    establishMutualTls({
      stream: s2,
      role: 'server',
      identity: profB.identity,
      expectedPeer: profB.peers.requireTrustedPeer(profA.identity.deviceId), // B ждёт A, а не C!
      handshakeTimeoutMs: 1500,
      heartbeatIntervalMs: 0,
    }),
  ]);
  assert.ok(res.every((r) => r.status === 'rejected'));
  profC.identity.dispose();

  // 2. Второй валидный лист под собственным CA устройства A с тем же SAN, но не закреплённый у B.
  const credsA = profA.identity.getTlsCredentials();
  const dataDirFakeLeaf = makeInMemoryDuplexPair();
  // Получаем ещё один лист от того же CA через createDeviceCertificates нельзя? Нет — напрямую issueDeviceLeaf от отдельного CA или ротации:
  // Симулируем украденный CA ключ A: выпускаем второй лист для A.deviceId под тем же CA, но B закрепил первый leafFp256!
  const fakeADir = path.join(tempRoot, `Profile-FakeLeaf-${Date.now()}`);
  const tempIdentityA2 = await loadOrCreateIdentity({
    dataDir: fakeADir,
    deviceName: 'FakeA2',
    protect: makeProtect(0x44),
  });
  // Чтобы подписать лист именно CA устройства A, подменяем leaf через ротацию на копии profA?
  // Проще: создаём отдельную пару (ca, leaf1, leaf2) от одного CA!
  const devXId = generateDeviceId();
  const devX = await createDeviceCertificates({ deviceId: devXId });
  const devXSecondLeaf = await issueDeviceLeaf({
    deviceId: devXId,
    caPem: devX.caPem,
    caKeyPem: devX.caKeyPem,
  });
  const peerStoreX = new PeerTrustStore({ dataDir: path.join(tempRoot, `storeX-${Date.now()}`) });
  peerStoreX.trustPeer({
    deviceId: devXId,
    deviceName: 'DevX',
    caPem: devX.caPem,
    leafPem: devX.leafPem, // закреплён leaf #1
  });
  const fakeXIdentity = {
    getTlsCredentials: () => ({
      deviceId: devXId,
      deviceName: 'DevX',
      caPem: devX.caPem,
      leafPem: devXSecondLeaf.leafPem, // предъявляет leaf #2 (другой ключ, тот же CA + SAN!)
      leafKeyPem: devXSecondLeaf.leafKeyPem,
      caFp256: devX.caFp256,
      leafFp256: devXSecondLeaf.leafFp256,
    }),
  };
  const [x1, x2] = makeInMemoryDuplexPair();
  const resPin = await Promise.allSettled([
    establishMutualTls({
      stream: x1,
      role: 'client',
      identity: fakeXIdentity,
      expectedPeer: {
        deviceId: profB.identity.deviceId,
        rootCaPem: profB.identity.caPem,
        leafFp256: profB.identity.leafFp256,
      },
      handshakeTimeoutMs: 1500,
      heartbeatIntervalMs: 0,
    }),
    establishMutualTls({
      stream: x2,
      role: 'server',
      identity: profB.identity,
      expectedPeer: peerStoreX.requireTrustedPeer(devXId),
      handshakeTimeoutMs: 1500,
      heartbeatIntervalMs: 0,
    }),
  ]);
  assert.ok(resPin.every((r) => r.status === 'rejected'));
  tempIdentityA2.dispose();
});

test('Подмена идентификатора и истёкший сертификат: отказ на уровне X.509/TLS и пиннинга', async () => {
  // Подмена deviceId в expectedPeer (заявляет чужой UUID при предъявлении сертификата A).
  const spoofedId = generateDeviceId();
  const [s1, s2] = makeInMemoryDuplexPair();
  const resSpoof = await Promise.allSettled([
    establishMutualTls({
      stream: s1,
      role: 'client',
      identity: profA.identity,
      expectedPeer: profA.peers.requireTrustedPeer(profB.identity.deviceId),
      handshakeTimeoutMs: 1200,
      heartbeatIntervalMs: 0,
    }),
    establishMutualTls({
      stream: s2,
      role: 'server',
      identity: profB.identity,
      expectedPeer: {
        deviceId: spoofedId,
        rootCaPem: profA.identity.caPem,
        leafFp256: profA.identity.leafFp256,
      },
      handshakeTimeoutMs: 1200,
      heartbeatIntervalMs: 0,
    }),
  ]);
  assert.ok(resSpoof.every((r) => r.status === 'rejected'));

  // Истёкший лист: создаём устройство с просроченным листом и проверяем отказ.
  const expId = generateDeviceId();
  const expCerts = await createDeviceCertificates({ deviceId: expId });
  const past = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const expLeaf = await issueDeviceLeaf({
    deviceId: expId,
    caPem: expCerts.caPem,
    caKeyPem: expCerts.caKeyPem,
    notBeforeMs: past - 5 * 24 * 60 * 60 * 1000,
    notAfterMs: past,
  });
  const expIdentity = {
    getTlsCredentials: () => ({
      deviceId: expId,
      deviceName: 'Expired',
      caPem: expCerts.caPem,
      leafPem: expLeaf.leafPem,
      leafKeyPem: expLeaf.leafKeyPem,
      caFp256: expCerts.caFp256,
      leafFp256: expLeaf.leafFp256,
    }),
  };
  const [e1, e2] = makeInMemoryDuplexPair();
  const resExp = await Promise.allSettled([
    establishMutualTls({
      stream: e1,
      role: 'client',
      identity: expIdentity,
      expectedPeer: {
        deviceId: profB.identity.deviceId,
        rootCaPem: profB.identity.caPem,
        leafFp256: profB.identity.leafFp256,
      },
      handshakeTimeoutMs: 1200,
      heartbeatIntervalMs: 0,
    }),
    establishMutualTls({
      stream: e2,
      role: 'server',
      identity: profB.identity,
      expectedPeer: {
        deviceId: expId,
        rootCaPem: expCerts.caPem,
        leafFp256: expLeaf.leafFp256,
      },
      handshakeTimeoutMs: 1200,
      heartbeatIntervalMs: 0,
    }),
  ]);
  assert.ok(resExp.every((r) => r.status === 'rejected'));
});

test('Отзыв доверия во время активного сеанса: мгновенный разрыв, отказ висящих промисов и блок переподключения', async () => {
  const p1 = await createProfile(tempRoot, `Revoke1-${Date.now()}`, 0x51);
  const p2 = await createProfile(tempRoot, `Revoke2-${Date.now()}`, 0x52);
  pairProfiles(p1, p2);

  const [raw1, raw2] = makeInMemoryDuplexPair();
  const [sess1, sess2] = await Promise.all([
    establishMutualTls({
      stream: raw1,
      role: 'client',
      identity: p1.identity,
      expectedPeer: p1.peers.requireTrustedPeer(p2.identity.deviceId),
      peerStore: p1.peers,
      heartbeatIntervalMs: 0,
    }),
    establishMutualTls({
      stream: raw2,
      role: 'server',
      identity: p2.identity,
      expectedPeer: p2.peers.requireTrustedPeer(p1.identity.deviceId),
      peerStore: p2.peers,
      heartbeatIntervalMs: 0,
    }),
  ]);

  const waiting = sess1.waitNextFrame({ timeoutMs: 5000 });
  p1.peers.revokePeer(p2.identity.deviceId, { by: 'owner', reason: 'stolen' });

  await assert.rejects(waiting, (err) => err instanceof LinkCryptoError);
  assert.equal(sess1.destroyed, true);

  // Повторное подключение к отозванному пиру запрещено ещё до TLS.
  const [r1, r2] = makeInMemoryDuplexPair();
  await assert.rejects(
    establishMutualTls({
      stream: r1,
      role: 'client',
      identity: p1.identity,
      expectedPeer: { deviceId: p2.identity.deviceId, rootCaPem: p2.identity.caPem },
      peerStore: p1.peers,
      heartbeatIntervalMs: 0,
    }),
    (err) => err instanceof LinkCryptoError && err.code === 'peer_revoked',
  );
  r2.destroy();
  await sess2.close();
  p1.identity.dispose();
  p2.identity.dispose();
});

test('Разрыв и переподключение + таймауты + half-open сокеты + >64KB/malformed JSON без висящих промисов', async () => {
  // 1. Разрыв ретранслятора и переподключение.
  const room1 = `/reconn1/${crypto.randomBytes(6).toString('hex')}`;
  const [rawA1, rawB1] = await Promise.all([dialRelay(relay.port, room1), dialRelay(relay.port, room1)]);
  const [sessA1, sessB1] = await Promise.all([
    establishMutualTls({
      stream: rawA1,
      role: 'client',
      identity: profA.identity,
      expectedPeer: profA.peers.requireTrustedPeer(profB.identity.deviceId),
      peerStore: profA.peers,
      heartbeatIntervalMs: 0,
    }),
    establishMutualTls({
      stream: rawB1,
      role: 'server',
      identity: profB.identity,
      expectedPeer: profB.peers.requireTrustedPeer(profA.identity.deviceId),
      peerStore: profB.peers,
      heartbeatIntervalMs: 0,
    }),
  ]);
  const pendingBeforeDrop = sessA1.waitNextFrame({ timeoutMs: 5000 });
  relay.dropAll();
  await assert.rejects(pendingBeforeDrop);
  await Promise.all([sessA1.close(), sessB1.close()]);

  // Переподключение с новым рукопожатием.
  const room2 = `/reconn2/${crypto.randomBytes(6).toString('hex')}`;
  const [rawA2, rawB2] = await Promise.all([dialRelay(relay.port, room2), dialRelay(relay.port, room2)]);
  const [sessA2, sessB2] = await Promise.all([
    establishMutualTls({
      stream: rawA2,
      role: 'client',
      identity: profA.identity,
      expectedPeer: profA.peers.requireTrustedPeer(profB.identity.deviceId),
      peerStore: profA.peers,
      heartbeatIntervalMs: 0,
    }),
    establishMutualTls({
      stream: rawB2,
      role: 'server',
      identity: profB.identity,
      expectedPeer: profB.peers.requireTrustedPeer(profA.identity.deviceId),
      peerStore: profB.peers,
      heartbeatIntervalMs: 0,
    }),
  ]);
  assert.equal(sessA2.reusedSession, false);
  const rx2 = sessB2.waitNextFrame({ timeoutMs: 2000 });
  await sessA2.sendFrame({ v: 3, type: 'after_reconnect', n: 2 });
  assert.equal((await rx2).n, 2);

  // 2. Превышение 64 КБ UTF-8 в одном кадре (проверка по байтам).
  assert.throws(
    () => sessA2.sendFrame({ v: 3, type: 'big', text: 'я'.repeat(40_000) }),
    (err) => err instanceof LinkCryptoError && err.code === 'frame_too_large',
  );

  // 3. Прямая инъекция oversized кадра по TLS сокету со стороны A обрывает B без падения.
  const closedB = new Promise((resolve) => sessB2.onClose(resolve));
  sessA2.socket.write(`${'a'.repeat(70_000)}\n`);
  await closedB;
  await sessA2.close();

  // 4. Таймаут зависшего рукопожатия.
  const [hung1, hung2] = makeInMemoryDuplexPair();
  await assert.rejects(
    establishMutualTls({
      stream: hung1,
      role: 'client',
      identity: profA.identity,
      expectedPeer: profA.peers.requireTrustedPeer(profB.identity.deviceId),
      handshakeTimeoutMs: 120,
      heartbeatIntervalMs: 0,
    }),
    (err) => err instanceof LinkCryptoError && err.code === 'tls_handshake_timeout',
  );
  hung2.destroy();

  // 5. Half-open FIN на raw-сокете до закрытия не оставляет висячий сеанс.
  const [ho1, ho2] = makeInMemoryDuplexPair();
  const [hsA, hsB] = await Promise.all([
    establishMutualTls({
      stream: ho1,
      role: 'client',
      identity: profA.identity,
      expectedPeer: profA.peers.requireTrustedPeer(profB.identity.deviceId),
      heartbeatIntervalMs: 0,
    }),
    establishMutualTls({
      stream: ho2,
      role: 'server',
      identity: profB.identity,
      expectedPeer: profB.peers.requireTrustedPeer(profA.identity.deviceId),
      heartbeatIntervalMs: 0,
    }),
  ]);
  const waitHo = hsB.waitNextFrame({ timeoutMs: 3000 });
  ho1.end(); // односторонний FIN на нижнем потоке
  await assert.rejects(waitHo);
  await Promise.all([hsA.close(), hsB.close()]);
});

test('Параллельное создание 6 mTLS 1.3 сессий без взаимного вмешательства и утечек', async () => {
  const count = 6;
  const pairs = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const room = `/parallel/${i}-${crypto.randomBytes(6).toString('hex')}`;
      const [rawA, rawB] = await Promise.all([dialRelay(relay.port, room), dialRelay(relay.port, room)]);
      const [sa, sb] = await Promise.all([
        establishMutualTls({
          stream: rawA,
          role: 'client',
          identity: profA.identity,
          expectedPeer: profA.peers.requireTrustedPeer(profB.identity.deviceId),
          peerStore: profA.peers,
          heartbeatIntervalMs: 0,
        }),
        establishMutualTls({
          stream: rawB,
          role: 'server',
          identity: profB.identity,
          expectedPeer: profB.peers.requireTrustedPeer(profA.identity.deviceId),
          peerStore: profB.peers,
          heartbeatIntervalMs: 0,
        }),
      ]);
      const pRx = sb.waitNextFrame({ timeoutMs: 3000 });
      await sa.sendFrame({ v: 3, type: 'parallel_msg', index: i });
      const got = await pRx;
      assert.equal(got.index, i);
      return [sa, sb];
    }),
  );

  await Promise.all(pairs.flat().map((s) => s.close()));
});

test('Неожиданное завершение одного процесса (SIGKILL): второй процесс чисто обнаруживает обрыв без зависания', async () => {
  const pChild = await createProfile(tempRoot, `ChildProc-${Date.now()}`, 0x61);
  pairProfiles(profA, pChild);

  const childScript = `
    const net = require('node:net');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const { loadOrCreateIdentity, PeerTrustStore, establishMutualTls } = require(${JSON.stringify(path.resolve(__dirname, '../src/link'))});
    const key = crypto.createHash('sha256').update(Buffer.from([0x61])).digest();
    const protect = {
      isEncryptionAvailable: () => true,
      encryptString: (t) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.getAuthTag(), c.update(t, 'utf8'), c.final()]); },
      decryptString: (b) => { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); },
    };
    (async () => {
      const identity = await loadOrCreateIdentity({ dataDir: ${JSON.stringify(pChild.dataDir)}, deviceName: 'ChildProc', protect });
      const peers = new PeerTrustStore({ dataDir: ${JSON.stringify(pChild.dataDir)} });
      const server = net.createServer(async (sock) => {
        try {
          const sess = await establishMutualTls({
            stream: sock,
            role: 'server',
            identity,
            expectedPeer: peers.requireTrustedPeer(${JSON.stringify(profA.identity.deviceId)}),
            peerStore: peers,
            heartbeatIntervalMs: 0,
          });
          await sess.sendFrame({ v: 3, type: 'child_ready', pid: process.pid });
        } catch (err) {
          process.stderr.write(String(err.stack || err));
          process.exit(1);
        }
      });
      server.listen(0, '127.0.0.1', () => {
        process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n');
      });
    })();
  `;

  const child = spawn(process.execPath, ['-e', childScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('child_boot_timeout')), 5000);
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          clearTimeout(timer);
          resolve(JSON.parse(buf.slice(0, nl)).port);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`child_exited_${code}`));
      });
    });

    const tcpSock = net.connect(port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      tcpSock.once('connect', resolve);
      tcpSock.once('error', reject);
    });
    const sessA = await establishMutualTls({
      stream: tcpSock,
      role: 'client',
      identity: profA.identity,
      expectedPeer: profA.peers.requireTrustedPeer(pChild.identity.deviceId),
      peerStore: profA.peers,
      heartbeatIntervalMs: 0,
    });

    const ready = await sessA.waitNextFrame({ timeoutMs: 3000 });
    assert.equal(ready.type, 'child_ready');

    const pendingAfterKill = sessA.waitNextFrame({ timeoutMs: 5000 });
    const closedPromise = new Promise((resolve) => sessA.onClose(resolve));
    child.kill('SIGKILL');

    await assert.rejects(pendingAfterKill);
    await closedPromise;
    assert.equal(sessA.destroyed, true);
    await sessA.close();
  } finally {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    pChild.identity.dispose();
  }
});

test('A2 (P2-1): обязательный leafFp256 пин — отказ при отсутствии пина и против второго листа под тем же CA/SAN', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-a2-'));
  let pA = null;
  let pB = null;
  try {
    pA = await createProfile(tmp, 'A', 0x51);
    pB = await createProfile(tmp, 'B', 0x52);

    // Прямой вызов verifyConnectedPeerSocket без leafFp256 немедленно отказывает.
    assert.throws(
      () => verifyConnectedPeerSocket({}, { expectedPeer: { deviceId: pB.identity.deviceId, rootCaPem: pB.identity.caPem } }),
      (err) => err instanceof LinkCryptoError && err.code === 'missing_peer_leaf_pin',
    );

    // Второй лист под тем же CA и тем же SAN deviceId_B.
    const secondLeafB = await issueDeviceLeaf({
      deviceId: pB.identity.deviceId,
      caPem: pB.identity.caPem,
      caKeyPem: fs.existsSync(path.join(pB.dataDir, 'link', 'identity.json'))
        ? undefined
        : undefined,
    }).catch(() => null);
    assert.equal(secondLeafB, null); // CA ключ защищён; протестируем через createDeviceCertificates (с явным CA) ниже.

    // Попытка подключиться с omitted/null leafFp256 на клиенте и сервере отвергается с missing_peer_leaf_pin.
    const [s1, s2] = makeInMemoryDuplexPair();
    await Promise.all([
      assert.rejects(
        () => establishMutualTls({
          stream: s1,
          role: 'server',
          identity: pA.identity,
          expectedPeer: { deviceId: pB.identity.deviceId, rootCaPem: pB.identity.caPem },
          heartbeatIntervalMs: 0,
        }),
        (err) => err instanceof LinkCryptoError && err.code === 'missing_peer_leaf_pin',
      ),
      assert.rejects(
        () => establishMutualTls({
          stream: s2,
          role: 'client',
          identity: pB.identity,
          expectedPeer: { deviceId: pA.identity.deviceId, rootCaPem: pA.identity.caPem, leafFp256: pA.identity.leafFp256 },
          heartbeatIntervalMs: 0,
        }),
        (err) => err instanceof LinkCryptoError,
      ),
    ]);

    // Тест против второго leaf под тем же CA + SAN при отсутствии leafFp256 и с подменным leafFp256.
    const fakeCaCerts = await createDeviceCertificates({ deviceName: 'DualLeaf' });
    const rogueLeaf2 = await issueDeviceLeaf({
      deviceId: fakeCaCerts.deviceId,
      caPem: fakeCaCerts.caPem,
      caKeyPem: fakeCaCerts.caKeyPem,
    });
    const fakeIdent2 = {
      deviceId: fakeCaCerts.deviceId,
      deviceName: 'DualLeaf',
      caPem: fakeCaCerts.caPem,
      leafPem: rogueLeaf2.leafPem,
      leafKeyPem: rogueLeaf2.leafKeyPem,
      getTlsCredentials() {
        return {
          deviceId: fakeCaCerts.deviceId,
          deviceName: 'DualLeaf',
          caPem: fakeCaCerts.caPem,
          leafPem: rogueLeaf2.leafPem,
          leafKeyPem: rogueLeaf2.leafKeyPem,
        };
      },
    };
    const [r1, r2] = makeInMemoryDuplexPair();
    await Promise.all([
      assert.rejects(
        () => establishMutualTls({
          stream: r1,
          role: 'server',
          identity: pA.identity,
          expectedPeer: {
            deviceId: fakeCaCerts.deviceId,
            rootCaPem: fakeCaCerts.caPem,
            leafFp256: fakeCaCerts.leafFp256, // закреплён первый leaf, предъявлен второй
          },
          handshakeTimeoutMs: 1500,
          heartbeatIntervalMs: 0,
        }),
        (err) => err instanceof LinkCryptoError && err.code === 'peer_leaf_pin_mismatch',
      ),
      assert.rejects(
        () => establishMutualTls({
          stream: r2,
          role: 'client',
          identity: fakeIdent2,
          expectedPeer: {
            deviceId: pA.identity.deviceId,
            rootCaPem: pA.identity.caPem,
            leafFp256: pA.identity.leafFp256,
          },
          handshakeTimeoutMs: 1500,
          heartbeatIntervalMs: 0,
        }),
        (err) => err instanceof LinkCryptoError,
      ),
    ]);
  } finally {
    pA?.peers.close();
    pB?.peers.close();
    pA?.identity.dispose();
    pB?.identity.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A3 (P1-1): отзыв через второй PeerTrustStore и внешнее редактирование peers.json рвёт живой mTLS-сеанс и блокирует переподключение', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-a3-tls-'));
  let pA = null;
  let pB = null;
  let secondStoreA = null;
  let sessA = null;
  let sessB = null;
  try {
    pA = await createProfile(tmp, 'A', 0x61);
    pB = await createProfile(tmp, 'B', 0x62);
    pairProfiles(pA, pB);

    secondStoreA = new PeerTrustStore({ dataDir: pA.dataDir });

    const [t1, t2] = makeInMemoryDuplexPair();
    [sessA, sessB] = await Promise.all([
      establishMutualTls({
        stream: t1,
        role: 'server',
        identity: pA.identity,
        expectedPeer: pA.peers.requireTrustedPeer(pB.identity.deviceId),
        peerStore: pA.peers,
        heartbeatIntervalMs: 0,
      }),
      establishMutualTls({
        stream: t2,
        role: 'client',
        identity: pB.identity,
        expectedPeer: pB.peers.requireTrustedPeer(pA.identity.deviceId),
        peerStore: pB.peers,
        heartbeatIntervalMs: 0,
      }),
    ]);

    const waitA = sessA.waitNextFrame({ timeoutMs: 4000 });
    const waitB = sessB.waitNextFrame({ timeoutMs: 4000 });

    // Отзыв во втором экземпляре PeerTrustStore должен немедленно оборвать живую сессию pA.
    secondStoreA.revokePeer(pB.identity.deviceId, { by: 'second_instance', reason: 'audit_a3' });
    await assert.rejects(waitA, (err) => err instanceof LinkCryptoError && err.code === 'peer_revoked');
    await assert.rejects(waitB);
    assert.equal(sessA.destroyed, true);

    assert.throws(
      () => pA.peers.requireTrustedPeer(pB.identity.deviceId),
      (err) => err instanceof LinkCryptoError && err.code === 'peer_revoked',
    );
    await sessA.close();
    await sessB.close();

    // Восстанавливаем доверие и проверяем внешний отзыв прямой записью в peers.json.
    pA.peers.replacePeerCertificate(pB.identity.deviceId, {
      caPem: pB.identity.caPem,
      leafPem: pB.identity.leafPem,
      allowReenable: true,
      by: 'restore',
    });
    const [r1, r2] = makeInMemoryDuplexPair();
    [sessA, sessB] = await Promise.all([
      establishMutualTls({
        stream: r1,
        role: 'server',
        identity: pA.identity,
        expectedPeer: pA.peers.requireTrustedPeer(pB.identity.deviceId),
        peerStore: pA.peers,
        heartbeatIntervalMs: 0,
      }),
      establishMutualTls({
        stream: r2,
        role: 'client',
        identity: pB.identity,
        expectedPeer: pB.peers.requireTrustedPeer(pA.identity.deviceId),
        peerStore: pB.peers,
        heartbeatIntervalMs: 0,
      }),
    ]);

    const waitExtA = sessA.waitNextFrame({ timeoutMs: 4000 });
    const raw = JSON.parse(fs.readFileSync(pA.peers.filePath, 'utf8'));
    raw.peers[pB.identity.deviceId].revokedAt = Date.now();
    raw.peers[pB.identity.deviceId].revokeReason = 'external_disk_write';
    raw.rev = (raw.rev || 0) + 1;
    fs.writeFileSync(pA.peers.filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    await assert.rejects(waitExtA, (err) => err instanceof LinkCryptoError && err.code === 'peer_revoked');
  } finally {
    await sessA?.close().catch(() => {});
    await sessB?.close().catch(() => {});
    secondStoreA?.close();
    pA?.peers.close();
    pB?.peers.close();
    pA?.identity.dispose();
    pB?.identity.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-9: переполнение очереди входящих кадров #inbox завершает сеанс с ошибкой inbox_overflow без тихой потери', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-p2-9-'));
  let pA = null;
  let pB = null;
  let sessA = null;
  let sessB = null;
  try {
    pA = await createProfile(tmp, 'A', 0x71);
    pB = await createProfile(tmp, 'B', 0x72);
    pairProfiles(pA, pB);

    const [t1, t2] = makeInMemoryDuplexPair();
    [sessA, sessB] = await Promise.all([
      establishMutualTls({
        stream: t1,
        role: 'server',
        identity: pA.identity,
        expectedPeer: pA.peers.requireTrustedPeer(pB.identity.deviceId),
        peerStore: pA.peers,
        heartbeatIntervalMs: 0,
      }),
      establishMutualTls({
        stream: t2,
        role: 'client',
        identity: pB.identity,
        expectedPeer: pB.peers.requireTrustedPeer(pA.identity.deviceId),
        peerStore: pB.peers,
        heartbeatIntervalMs: 0,
      }),
    ]);

    const closeErrA = new Promise((resolve) => sessA.onClose(resolve));
    const closeErrB = new Promise((resolve) => sessB.onClose(resolve));
    for (let i = 0; i <= MAX_INBOX_FRAMES + 5; i += 1) {
      if (sessB.destroyed) break;
      try {
        await sessB.sendFrame({ v: 3, type: 'flood', seq: i });
      } catch {
        break;
      }
    }
    const errA = await closeErrA;
    await closeErrB;
    assert.equal(errA.code, 'inbox_overflow');
    assert.equal(sessA.destroyed, true);
  } finally {
    await sessA?.close().catch(() => {});
    await sessB?.close().catch(() => {});
    pA?.peers.close();
    pB?.peers.close();
    pA?.identity.dispose();
    pB?.identity.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-12: истечение срока сертификата во время активного TLS-сеанса немедленно обрывает соединение (cert_expired)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-p2-12-'));
  let pA = null;
  let pB = null;
  let sessA = null;
  let sessB = null;
  try {
    pA = await createProfile(tmp, 'A', 0x81);
    pB = await createProfile(tmp, 'B', 0x82);
    pairProfiles(pA, pB);

    // 1. Детерминированная проверка через инъекцию часов now().
    let clock = Date.now();
    const [t1, t2] = makeInMemoryDuplexPair();
    [sessA, sessB] = await Promise.all([
      establishMutualTls({
        stream: t1,
        role: 'server',
        identity: pA.identity,
        expectedPeer: pA.peers.requireTrustedPeer(pB.identity.deviceId),
        peerStore: pA.peers,
        heartbeatIntervalMs: 0,
        now: () => clock,
      }),
      establishMutualTls({
        stream: t2,
        role: 'client',
        identity: pB.identity,
        expectedPeer: pB.peers.requireTrustedPeer(pA.identity.deviceId),
        peerStore: pB.peers,
        heartbeatIntervalMs: 0,
        now: () => clock,
      }),
    ]);

    const pingWait = sessA.waitNextFrame({ timeoutMs: 2000 });
    await sessB.sendFrame({ v: 3, type: 'probe_msg', ok: true });
    assert.equal((await pingWait).type, 'probe_msg');

    // Сдвигаем часы за предел 90-дневного срока действия leaf.
    clock += 100 * DAY_MS;
    await assert.rejects(
      () => sessA.sendFrame({ v: 3, type: 'after_expiry' }),
      (err) => err instanceof LinkCryptoError && err.code === 'cert_expired',
    );
    assert.equal(sessA.destroyed, true);
    await sessA.close();
    await sessB.close();

    // 2. Реальный таймер активной сессии на короткоживущем leaf-сертификате (~2 с).
    const shortRoot = await createDeviceCertificates({ deviceName: 'ShortLeaf', leafDays: 1 });
    const nowMs = Date.now();
    const shortLeaf = await issueDeviceLeaf({
      deviceId: shortRoot.deviceId,
      caPem: shortRoot.caPem,
      caKeyPem: shortRoot.caKeyPem,
      notBeforeMs: nowMs - 10_000,
      notAfterMs: nowMs + 2_200,
    });
    const shortIdentity = {
      deviceId: shortRoot.deviceId,
      deviceName: 'ShortLeaf',
      caPem: shortRoot.caPem,
      leafPem: shortLeaf.leafPem,
      leafKeyPem: shortLeaf.leafKeyPem,
      getTlsCredentials() {
        return {
          deviceId: shortRoot.deviceId,
          deviceName: 'ShortLeaf',
          caPem: shortRoot.caPem,
          leafPem: shortLeaf.leafPem,
          leafKeyPem: shortLeaf.leafKeyPem,
          leafFp256: shortLeaf.leafFp256,
        };
      },
    };
    const [r1, r2] = makeInMemoryDuplexPair();
    [sessA, sessB] = await Promise.all([
      establishMutualTls({
        stream: r1,
        role: 'server',
        identity: pA.identity,
        expectedPeer: {
          deviceId: shortIdentity.deviceId,
          rootCaPem: shortIdentity.caPem,
          leafFp256: shortLeaf.leafFp256,
        },
        heartbeatIntervalMs: 0,
      }),
      establishMutualTls({
        stream: r2,
        role: 'client',
        identity: shortIdentity,
        expectedPeer: {
          deviceId: pA.identity.deviceId,
          rootCaPem: pA.identity.caPem,
          leafFp256: pA.identity.leafFp256,
        },
        heartbeatIntervalMs: 0,
      }),
    ]);

    const closeA = new Promise((resolve) => sessA.onClose(resolve));
    const closeB = new Promise((resolve) => sessB.onClose(resolve));
    const [errA, errB] = await Promise.race([
      Promise.all([closeA, closeB]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('expiry_timer_did_not_fire')), 5000)),
    ]);
    assert.ok(
      errA.code === 'cert_expired' || errB.code === 'cert_expired',
      `Ожидали cert_expired хотя бы на одной стороне, получили errA=${errA.code}, errB=${errB.code}`,
    );
    assert.equal(sessA.destroyed, true);
    assert.equal(sessB.destroyed, true);
    await sessA.close();
    await sessB.close();

    // 3. Проверка адресного updateCertExpiry на одной стороне: именно эта сторона рвёт сеанс с cert_expired.
    const [u1, u2] = makeInMemoryDuplexPair();
    [sessA, sessB] = await Promise.all([
      establishMutualTls({
        stream: u1,
        role: 'server',
        identity: pA.identity,
        expectedPeer: {
          deviceId: pB.identity.deviceId,
          rootCaPem: pB.identity.caPem,
          leafFp256: pB.identity.leafFp256,
        },
        heartbeatIntervalMs: 0,
      }),
      establishMutualTls({
        stream: u2,
        role: 'client',
        identity: pB.identity,
        expectedPeer: {
          deviceId: pA.identity.deviceId,
          rootCaPem: pA.identity.caPem,
          leafFp256: pA.identity.leafFp256,
        },
        heartbeatIntervalMs: 0,
      }),
    ]);
    const localClosePromise = new Promise((resolve) => sessA.onClose(resolve));
    sessA.updateCertExpiry(Date.now() + 80);
    const localExpiredErr = await Promise.race([
      localClosePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('update_cert_expiry_did_not_fire')), 3000)),
    ]);
    assert.equal(localExpiredErr.code, 'cert_expired');
    assert.equal(sessA.destroyed, true);
  } finally {
    await sessA?.close().catch(() => {});
    await sessB?.close().catch(() => {});
    pA?.peers.close();
    pB?.peers.close();
    pA?.identity.dispose();
    pB?.identity.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
