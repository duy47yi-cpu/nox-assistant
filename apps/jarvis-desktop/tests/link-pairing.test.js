'use strict';

// Фаза 3: испытания сопряжения Commit-then-Reveal + mTLS 1.3 + PoP + SAS с каноническим транскриптом.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough, Duplex } = require('node:stream');

const {
  LinkCryptoError,
  loadOrCreateIdentity,
  PeerTrustStore,
  establishMutualTls,
  runPairingSession,
  sendLeafUpdateOverSession,
  acceptLeafUpdateOverSession,
  PairingCooldownTracker,
  computeTranscriptHash,
  deriveSasCode,
  fingerprint256Raw,
} = require('../src/link');

function makeProtect(tag = 0x31) {
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

function makeDuplexPair() {
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

let tempRoot;
before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-pairing-'));
});
after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function makeDevice(name, tag) {
  const dir = path.join(tempRoot, `${name}-${crypto.randomBytes(4).toString('hex')}`);
  const identity = await loadOrCreateIdentity({ dataDir: dir, deviceName: name, protect: makeProtect(tag) });
  const peers = new PeerTrustStore({ dataDir: dir });
  return { dir, identity, peers };
}

test('Полное сопряжение Commit-then-Reveal + PoP + SAS с подтверждением на обоих ПК и последующим mTLS', async () => {
  const hostDev = await makeDevice('Desktop-Home', 0x10);
  const clientDev = await makeDevice('Laptop-Work', 0x20);
  const roomId = crypto.randomBytes(32).toString('hex');
  const [trHost, trClient] = makeDuplexPair();

  const prompts = [];
  const [resHost, resClient] = await Promise.all([
    runPairingSession({
      transport: trHost,
      role: 'host',
      roomId,
      identity: hostDev.identity,
      expectedPeer: { deviceId: clientDev.identity.deviceId, deviceName: 'Laptop-Work' },
      peerStore: hostDev.peers,
      onConfirmSas: async (prompt) => {
        prompts.push({ side: 'host', ...prompt });
        return { confirmed: true };
      },
    }),
    runPairingSession({
      transport: trClient,
      role: 'client',
      roomId,
      identity: clientDev.identity,
      expectedPeer: { deviceId: hostDev.identity.deviceId, deviceName: 'Desktop-Home' },
      peerStore: clientDev.peers,
      onConfirmSas: async (prompt) => {
        prompts.push({ side: 'client', ...prompt });
        return { confirmed: true };
      },
    }),
  ]);

  assert.equal(resHost.ok, true);
  assert.equal(resClient.ok, true);
  assert.match(resHost.sasCode, /^\d{6}$/);
  assert.equal(resHost.sasCode, resClient.sasCode);
  assert.equal(resHost.transcriptHash, resClient.transcriptHash);
  assert.equal(prompts.length, 2);

  // Доверие сохранено на обеих сторонах и работает в последующем рабочем mTLS-сеансе.
  const [s1, s2] = makeDuplexPair();
  const [m1, m2] = await Promise.all([
    establishMutualTls({
      stream: s1,
      role: 'server',
      identity: hostDev.identity,
      expectedPeer: hostDev.peers.requireTrustedPeer(clientDev.identity.deviceId),
      peerStore: hostDev.peers,
      heartbeatIntervalMs: 0,
    }),
    establishMutualTls({
      stream: s2,
      role: 'client',
      identity: clientDev.identity,
      expectedPeer: clientDev.peers.requireTrustedPeer(hostDev.identity.deviceId),
      peerStore: clientDev.peers,
      heartbeatIntervalMs: 0,
    }),
  ]);
  const waitMsg = m1.waitNextFrame({ timeoutMs: 2000 });
  await m2.sendFrame({ v: 3, type: 'hello_paired', ok: true });
  assert.equal((await waitMsg).ok, true);
  await Promise.all([m1.close(), m2.close()]);

  hostDev.identity.dispose();
  clientDev.identity.dispose();
});

test('Запрет авто-сопряжения без onConfirmSas и отмена при отказе хотя бы одного владельца', async () => {
  const devA = await makeDevice('Auto-A', 0x30);
  const devB = await makeDevice('Auto-B', 0x40);
  const roomId = crypto.randomBytes(16).toString('hex');
  const [t1, t2] = makeDuplexPair();

  // 1. Отсутствие onConfirmSas должно немедленно отклоняться.
  await assert.rejects(
    runPairingSession({
      transport: t1,
      role: 'host',
      roomId,
      identity: devA.identity,
      expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Auto-B' },
      peerStore: devA.peers,
      onConfirmSas: null,
    }),
    (err) => err instanceof LinkCryptoError && err.code === 'confirmation_required',
  );
  t2.destroy();

  // 2. Host подтвердил, Client отклонил -> доверие НЕ записывается ни на одной стороне!
  const [p1, p2] = makeDuplexPair();
  const settled = await Promise.allSettled([
    runPairingSession({
      transport: p1,
      role: 'host',
      roomId,
      identity: devA.identity,
      expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Auto-B' },
      peerStore: devA.peers,
      onConfirmSas: async () => ({ confirmed: true }),
    }),
    runPairingSession({
      transport: p2,
      role: 'client',
      roomId,
      identity: devB.identity,
      expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Auto-A' },
      peerStore: devB.peers,
      onConfirmSas: async () => ({ confirmed: false }),
    }),
  ]);
  assert.ok(settled.every((r) => r.status === 'rejected'));
  assert.equal(devA.peers.getPeer(devB.identity.deviceId), null);
  assert.equal(devB.peers.getPeer(devA.identity.deviceId), null);

  devA.identity.dispose();
  devB.identity.dispose();
});

test('Нарушение порядка Commit-then-Reveal, подмена commit, подмена имени устройства и привязка SAS к roomId/именам', async () => {
  const devA = await makeDevice('Host-Order', 0x50);
  const devB = await makeDevice('Client-Order', 0x60);
  const roomId = crypto.randomBytes(16).toString('hex');

  // 1. Злоумышленник шлёт pair_reveal до pair_commit.
  const [t1, t2] = makeDuplexPair();
  const hostPromise = runPairingSession({
    transport: t1,
    role: 'host',
    roomId,
    identity: devA.identity,
    expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Client-Order' },
    peerStore: devA.peers,
    onConfirmSas: async () => ({ confirmed: true }),
  });
  t2.write(`${JSON.stringify({
    v: 3,
    type: 'pair_reveal',
    role: 'client',
    deviceId: devB.identity.deviceId,
    deviceName: 'Client-Order',
    caPem: devB.identity.caPem,
    leafPem: devB.identity.leafPem,
    nonce: crypto.randomBytes(32).toString('hex'),
  })}\n`);
  await assert.rejects(hostPromise, (err) => err instanceof LinkCryptoError && err.code === 'protocol_violation_reveal_before_commit');
  t2.destroy();

  // 2. Неверный commit -> отказ commit_mismatch.
  const [c1, c2] = makeDuplexPair();
  const hostCommitCheck = runPairingSession({
    transport: c1,
    role: 'host',
    roomId,
    identity: devA.identity,
    expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Client-Order' },
    peerStore: devA.peers,
    onConfirmSas: async () => ({ confirmed: true }),
  });
  c2.write(`${JSON.stringify({ v: 3, type: 'pair_commit', commit: 'ab'.repeat(32) })}\n`);
  c2.write(`${JSON.stringify({
    v: 3,
    type: 'pair_reveal',
    role: 'client',
    deviceId: devB.identity.deviceId,
    deviceName: 'Client-Order',
    caPem: devB.identity.caPem,
    leafPem: devB.identity.leafPem,
    nonce: crypto.randomBytes(32).toString('hex'),
  })}\n`);
  await assert.rejects(hostCommitCheck, (err) => err instanceof LinkCryptoError && err.code === 'commit_mismatch');
  c2.destroy();

  // 3. Подмена имени устройства (expectedPeer.deviceName не совпадает с реальным именем пира).
  const [n1, n2] = makeDuplexPair();
  const nameMismatch = await Promise.allSettled([
    runPairingSession({
      transport: n1,
      role: 'host',
      roomId,
      identity: devA.identity,
      expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Spoofed-Name' },
      peerStore: devA.peers,
      onConfirmSas: async () => ({ confirmed: true }),
    }),
    runPairingSession({
      transport: n2,
      role: 'client',
      roomId,
      identity: devB.identity,
      expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Host-Order' },
      peerStore: devB.peers,
      onConfirmSas: async () => ({ confirmed: true }),
    }),
  ]);
  assert.ok(nameMismatch.every((r) => r.status === 'rejected'));

  // 4. Привязка SAS к roomId и именам устройств: изменение любого поля меняет SAS.
  const nonceH = crypto.randomBytes(32);
  const nonceC = crypto.randomBytes(32);
  const hostPart = {
    deviceId: devA.identity.deviceId,
    deviceName: 'Desktop-1',
    caFp256Bytes: fingerprint256Raw(devA.identity.caPem),
    leafFp256Bytes: fingerprint256Raw(devA.identity.leafPem),
    nonce: nonceH,
  };
  const clientPart = {
    deviceId: devB.identity.deviceId,
    deviceName: 'Laptop-2',
    caFp256Bytes: fingerprint256Raw(devB.identity.caPem),
    leafFp256Bytes: fingerprint256Raw(devB.identity.leafPem),
    nonce: nonceC,
  };
  const tHash1 = computeTranscriptHash({ roomId: 'room-1', host: hostPart, client: clientPart });
  const tHash2 = computeTranscriptHash({ roomId: 'room-2', host: hostPart, client: clientPart });
  const tHash3 = computeTranscriptHash({ roomId: 'room-1', host: { ...hostPart, deviceName: 'Desktop-X' }, client: clientPart });
  assert.equal(tHash1.equals(tHash2), false);
  assert.equal(tHash1.equals(tHash3), false);

  const sas1 = deriveSasCode({
    transcriptHash: tHash1,
    hostNonce: nonceH,
    clientNonce: nonceC,
    roomId: 'room-1',
    hostDeviceName: 'Desktop-1',
    clientDeviceName: 'Laptop-2',
  });
  const sas2 = deriveSasCode({
    transcriptHash: tHash2,
    hostNonce: nonceH,
    clientNonce: nonceC,
    roomId: 'room-2',
    hostDeviceName: 'Desktop-1',
    clientDeviceName: 'Laptop-2',
  });
  assert.notEqual(sas1, sas2);

  devA.identity.dispose();
  devB.identity.dispose();
});

test('Ограничение попыток сопряжения (cooldown после 3 отказов SAS) и повторное сопряжение после отзыва', async () => {
  const devA = await makeDevice('Cooldown-A', 0x70);
  const devB = await makeDevice('Cooldown-B', 0x80);
  let clock = Date.now();
  const now = () => clock;
  const tracker = new PairingCooldownTracker({ maxFailures: 3, cooldownMs: 300_000 });

  for (let i = 0; i < 3; i += 1) {
    const [t1, t2] = makeDuplexPair();
    const res = await Promise.allSettled([
      runPairingSession({
        transport: t1,
        role: 'host',
        roomId: `room-fail-${i}`,
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Cooldown-B' },
        peerStore: devA.peers,
        cooldownTracker: tracker,
        now,
        onConfirmSas: async () => ({ confirmed: false }),
      }),
      runPairingSession({
        transport: t2,
        role: 'client',
        roomId: `room-fail-${i}`,
        identity: devB.identity,
        expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Cooldown-A' },
        peerStore: devB.peers,
        now,
        onConfirmSas: async () => ({ confirmed: false }),
      }),
    ]);
    assert.ok(res.every((r) => r.status === 'rejected'));
  }

  // 4-я попытка сразу должна блокироваться cooldown.
  const [b1, b2] = makeDuplexPair();
  await assert.rejects(
    runPairingSession({
      transport: b1,
      role: 'host',
      roomId: 'room-blocked',
      identity: devA.identity,
      expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Cooldown-B' },
      peerStore: devA.peers,
      cooldownTracker: tracker,
      now,
      onConfirmSas: async () => ({ confirmed: true }),
    }),
    (err) => err instanceof LinkCryptoError && err.code === 'pairing_cooldown',
  );
  b2.destroy();

  // После истечения 5 минут сопряжение разрешается.
  clock += 300_001;
  const [ok1, ok2] = makeDuplexPair();
  const [pA, pB] = await Promise.all([
    runPairingSession({
      transport: ok1,
      role: 'host',
      roomId: 'room-after-cooldown',
      identity: devA.identity,
      expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Cooldown-B' },
      peerStore: devA.peers,
      cooldownTracker: tracker,
      now,
      onConfirmSas: async () => ({ confirmed: true }),
    }),
    runPairingSession({
      transport: ok2,
      role: 'client',
      roomId: 'room-after-cooldown',
      identity: devB.identity,
      expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Cooldown-A' },
      peerStore: devB.peers,
      now,
      onConfirmSas: async () => ({ confirmed: true }),
    }),
  ]);
  assert.equal(pA.ok, true);
  assert.equal(pB.ok, true);

  // Отзываем и проверяем, что без allowReplace повторное сопряжение не перезапишет tombstone, а с allowReplace: true — обновит доверие.
  devA.peers.revokePeer(devB.identity.deviceId, { by: 'owner', reason: 'rotate_device' });
  const [r1, r2] = makeDuplexPair();
  await assert.rejects(
    runPairingSession({
      transport: r1,
      role: 'host',
      roomId: 'room-revoked-no-replace',
      identity: devA.identity,
      expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Cooldown-B' },
      peerStore: devA.peers,
      allowReplace: false,
      now,
      onConfirmSas: async () => ({ confirmed: true }),
    }),
    (err) => err instanceof LinkCryptoError && err.code === 'peer_revoked',
  );
  r2.destroy();

  const [rp1, rp2] = makeDuplexPair();
  const [repairedA] = await Promise.all([
    runPairingSession({
      transport: rp1,
      role: 'host',
      roomId: 'room-repair',
      identity: devA.identity,
      expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Cooldown-B' },
      peerStore: devA.peers,
      allowReplace: true,
      now,
      onConfirmSas: async () => ({ confirmed: true }),
    }),
    runPairingSession({
      transport: rp2,
      role: 'client',
      roomId: 'room-repair',
      identity: devB.identity,
      expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Cooldown-A' },
      peerStore: devB.peers,
      allowReplace: true,
      now,
      onConfirmSas: async () => ({ confirmed: true }),
    }),
  ]);
  assert.equal(repairedA.peer.revokedAt, null);

  devA.peers.close();
  devB.peers.close();
  devA.identity.dispose();
  devB.identity.dispose();
});

function makeShapedPair({
  holdClientRevealWithTls = false,
  chunkSize = 0,
  delayMs = 0,
} = {}) {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  let held = [];
  let revealReleased = !holdClientRevealWithTls;
  let commitSeenFromClient = false;

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
    write(chunk, enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
      if (!revealReleased) {
        held.push(buf);
        const text = Buffer.concat(held).toString('utf8');
        if (!commitSeenFromClient && text.includes('"pair_commit"')) {
          const nl = text.indexOf('\n');
          if (nl !== -1) {
            commitSeenFromClient = true;
            const allBuf = Buffer.concat(held);
            const commitBuf = allBuf.subarray(0, allBuf.indexOf(0x0a) + 1);
            const rem = allBuf.subarray(commitBuf.length);
            held = rem.length > 0 ? [rem] : [];
            bToA.write(commitBuf);
          }
        }
        // Ждём пока pair_reveal И первые байты ClientHello (0x16) окажутся в одном буфере.
        const currentAll = Buffer.concat(held);
        const nlPos = currentAll.indexOf(0x0a);
        if (commitSeenFromClient && nlPos !== -1 && currentAll.length > nlPos + 1 && currentAll[nlPos + 1] === 0x16) {
          revealReleased = true;
          held = [];
          if (delayMs > 0) {
            setTimeout(() => { if (!bToA.destroyed) bToA.write(currentAll); }, delayMs);
          } else {
            bToA.write(currentAll);
          }
        }
        cb();
        return;
      }
      bToA.write(buf, cb);
    },
    final(cb) { bToA.end(); cb(); },
    destroy(err, cb) { bToA.destroy(); aToB.destroy(); cb(err); },
  });

  const forward = (src, dst) => {
    const queue = [];
    let draining = false;
    let srcEnded = false;
    let ops = 0;

    const drainNext = () => {
      if (dst.destroyed) {
        draining = false;
        return;
      }
      if (queue.length === 0) {
        draining = false;
        if (srcEnded) {
          dst.push(null);
        }
        return;
      }
      draining = true;
      const item = queue.shift();
      const sendSlice = (buf) => {
        if (dst.destroyed) {
          draining = false;
          return;
        }
        ops += 1;
        let moreChunks = false;
        if (chunkSize > 0 && buf.length > chunkSize) {
          const sliceLen = chunkSize === 1
            ? 1
            : (1 + ((buf.length * 7 + buf[0]) % chunkSize));
          const part = buf.subarray(0, sliceLen);
          const rest = buf.subarray(sliceLen);
          dst.push(part);
          queue.unshift(rest);
          moreChunks = true;
        } else {
          dst.push(buf);
        }
        if (delayMs > 0 && (!moreChunks || ops % 48 === 0)) {
          const t = setTimeout(drainNext, delayMs);
          if (typeof t.unref === 'function') t.unref();
        } else if (moreChunks) {
          setImmediate(drainNext);
        } else {
          drainNext();
        }
      };

      if (delayMs > 0 && ops === 0) {
        const t = setTimeout(() => sendSlice(item), delayMs);
        if (typeof t.unref === 'function') t.unref();
      } else {
        sendSlice(item);
      }
    };

    src.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length === 0) return;
      queue.push(buf);
      if (!draining) drainNext();
    });
    src.on('end', () => {
      srcEnded = true;
      if (!draining && queue.length === 0) {
        dst.push(null);
      }
    });
    src.on('close', () => {
      if (!srcEnded && !dst.destroyed) {
        dst.destroy();
      }
    });
  };

  forward(bToA, sideA);
  forward(aToB, sideB);
  return [sideA, sideB];
}

test('A4/A4b (P1-2): склейка pair_reveal+ClientHello, произвольное дробление по 1..N байт, задержки, повторы и 100 сопряжений подряд', async () => {
  const devA = await makeDevice('Host-Chunked', 0x41);
  const devB = await makeDevice('Client-Chunked', 0x42);

  try {
    // 1. Точный сценарий A4b: клиентский pair_reveal и TLS ClientHello приходят хосту одним TCP-куском + задержка.
    const [c1, c2] = makeShapedPair({ holdClientRevealWithTls: true, delayMs: 8 });
    const [rA, rB] = await Promise.all([
      runPairingSession({
        transport: c1,
        role: 'host',
        roomId: 'room-a4b-exact',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Client-Chunked' },
        peerStore: devA.peers,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
      runPairingSession({
        transport: c2,
        role: 'client',
        roomId: 'room-a4b-exact',
        identity: devB.identity,
        expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Host-Chunked' },
        peerStore: devB.peers,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
    ]);
    assert.equal(rA.ok, true);
    assert.equal(rA.sasCode, rB.sasCode);

    // 2. Дробление по 1..7 байт + задержки + последующий обрыв и повторная попытка.
    const [d1, d2] = makeDuplexPair();
    d2.on('error', () => {});
    d1.on('error', () => {});
    d2.destroy(new Error('network_blip'));
    await assert.rejects(
      () => runPairingSession({
        transport: d1,
        role: 'host',
        roomId: 'room-blip',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Client-Chunked' },
        peerStore: devA.peers,
        allowReplace: true,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
      (err) => err instanceof LinkCryptoError,
    );

    const [j1, j2] = makeShapedPair({ holdClientRevealWithTls: true, chunkSize: 7, delayMs: 1 });
    const [jA, jB] = await Promise.all([
      runPairingSession({
        transport: j1,
        role: 'host',
        roomId: 'room-jitter',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Client-Chunked' },
        peerStore: devA.peers,
        allowReplace: true,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
      runPairingSession({
        transport: j2,
        role: 'client',
        roomId: 'room-jitter',
        identity: devB.identity,
        expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Host-Chunked' },
        peerStore: devB.peers,
        allowReplace: true,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
    ]);
    assert.equal(jA.sasCode, jB.sasCode);

    // 3. 100 последовательных сопряжений подряд со смешанной нарезкой/склейкой потока.
    for (let i = 0; i < 100; i += 1) {
      const mode = i % 4;
      const [p1, p2] = mode === 0
        ? makeShapedPair({ holdClientRevealWithTls: true })
        : (mode === 1
            ? makeShapedPair({ holdClientRevealWithTls: true, chunkSize: 13 })
            : (mode === 2
                ? makeShapedPair({ chunkSize: 1 })
                : makeDuplexPair()));
      const room = `room-100-${i}`;
      const [res1, res2] = await Promise.all([
        runPairingSession({
          transport: p1,
          role: 'host',
          roomId: room,
          identity: devA.identity,
          expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Client-Chunked' },
          peerStore: devA.peers,
          allowReplace: true,
          onConfirmSas: async () => ({ confirmed: true }),
        }),
        runPairingSession({
          transport: p2,
          role: 'client',
          roomId: room,
          identity: devB.identity,
          expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Host-Chunked' },
          peerStore: devB.peers,
          allowReplace: true,
          onConfirmSas: async () => ({ confirmed: true }),
        }),
      ]);
      assert.equal(res1.sasCode, res2.sasCode, `Итерация ${i} должна совпадать по SAS`);
    }
  } finally {
    devA.peers.close();
    devB.peers.close();
    devA.identity.dispose();
    devB.identity.dispose();
  }
});

test('A9 (P2-5) & A8 (P2-4): блокировка параллельных сопряжений (pairing_in_progress), персистентный cooldown и фильтр Unicode', async () => {
  const devA = await makeDevice('Par-Host', 0x51);
  const devB = await makeDevice('Par-Client', 0x52);
  const cooldownDir = path.join(tempRoot, `cd-${crypto.randomBytes(4).toString('hex')}`);

  try {
    // A8: невидимые и bidi-символы отклоняются до запуска SAS.
    const [b1, b2] = makeDuplexPair();
    await assert.rejects(
      () => runPairingSession({
        transport: b1,
        role: 'host',
        roomId: 'room-unicode-bad',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Evil\u202EClient' },
        peerStore: devA.peers,
        onConfirmSas: async () => { throw new Error('must_not_prompt'); },
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'invalid_device_name',
    );
    b1.destroy();
    b2.destroy();

    // A9: 6 параллельных сопряжений к одному пиру — только 1 доходит до SAS, остальные 5 отвергаются с pairing_in_progress.
    let sasCalls = 0;
    let releaseFirstSas;
    const firstReachedSas = new Promise((resolve) => {
      releaseFirstSas = resolve;
    });
    let confirmFirstResolver;
    const firstConfirmGate = new Promise((resolve) => {
      confirmFirstResolver = resolve;
    });

    const trackerA = new PairingCooldownTracker({ maxFailures: 2, cooldownMs: 60_000, dataDir: cooldownDir });
    const [m1, m2] = makeDuplexPair();
    const firstClientPromise = runPairingSession({
      transport: m2,
      role: 'client',
      roomId: 'room-par-0',
      identity: devB.identity,
      expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Par-Host' },
      peerStore: devB.peers,
      onConfirmSas: async () => ({ confirmed: true }),
    });
    firstClientPromise.catch(() => {});
    const firstHostPromise = runPairingSession({
      transport: m1,
      role: 'host',
      roomId: 'room-par-0',
      identity: devA.identity,
      expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Par-Client' },
      peerStore: devA.peers,
      cooldownTracker: trackerA,
      onConfirmSas: async () => {
        sasCalls += 1;
        releaseFirstSas();
        return firstConfirmGate;
      },
    });

    await firstReachedSas;

    const extras = [];
    for (let k = 1; k < 6; k += 1) {
      const [e1] = makeDuplexPair();
      extras.push(
        runPairingSession({
          transport: e1,
          role: 'host',
          roomId: `room-par-${k}`,
          identity: devA.identity,
          expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Par-Client' },
          peerStore: devA.peers,
          cooldownTracker: trackerA,
          onConfirmSas: async () => {
            sasCalls += 1;
            return { confirmed: true };
          },
        }),
      );
    }
    const extraResults = await Promise.allSettled(extras);
    assert.equal(extraResults.filter((r) => r.status === 'rejected' && r.reason?.code === 'pairing_in_progress').length, 5);
    assert.equal(sasCalls, 1);

    // Отказываем первую сессию, чтобы накрутить счётчик неудач на диск (1/2).
    confirmFirstResolver({ confirmed: false });
    await assert.rejects(() => firstHostPromise, (err) => err instanceof LinkCryptoError && err.code === 'sas_rejected');
    await firstClientPromise.catch(() => {});

    // 2-й отказ SAS достигает порога maxFailures=2.
    const [f1, f2] = makeDuplexPair();
    await Promise.allSettled([
      runPairingSession({
        transport: f1,
        role: 'host',
        roomId: 'room-cd-2',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Par-Client' },
        peerStore: devA.peers,
        cooldownTracker: trackerA,
        onConfirmSas: async () => ({ confirmed: false }),
      }),
      runPairingSession({
        transport: f2,
        role: 'client',
        roomId: 'room-cd-2',
        identity: devB.identity,
        expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Par-Host' },
        peerStore: devB.peers,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
    ]);

    // Новый экземпляр PairingCooldownTracker после «перезапуска процесса» сохраняет блокировку.
    const nowT = Date.now();
    const reloadedTracker = new PairingCooldownTracker({ maxFailures: 2, cooldownMs: 60_000, dataDir: cooldownDir });
    const [g1, g2] = makeDuplexPair();
    await assert.rejects(
      () => runPairingSession({
        transport: g1,
        role: 'host',
        roomId: 'room-cd-3',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Par-Client' },
        peerStore: devA.peers,
        cooldownTracker: reloadedTracker,
        now: () => nowT + 1000,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
      (err) => err instanceof LinkCryptoError && err.code === 'pairing_cooldown',
    );
    g1.destroy();
    g2.destroy();
  } finally {
    devA.peers.close();
    devB.peers.close();
    devA.identity.dispose();
    devB.identity.dispose();
  }
});

test('P2-7, P2-8 и A4: обязательный sas_complete перед записью доверия, таймаут/AbortSignal в SAS, запрет смены CA и leaf_update по mTLS', async () => {
  const devA = await makeDevice('Sec-Host', 0x61);
  const devB = await makeDevice('Sec-Client', 0x62);

  try {
    // 1. P2-7: обрыв соединения прямо на 3-м TLS ApplicationData (sas_complete) не записывает пир ни на одной стороне.
    const rawAtoB = new PassThrough();
    const rawBtoA = new PassThrough();
    let appRecordsBtoA = 0;
    const wireHost = new Duplex({
      allowHalfOpen: false,
      read() {},
      write(c, enc, cb) { rawAtoB.write(c, enc, cb); },
      final(cb) { rawAtoB.end(); cb(); },
      destroy(err, cb) { rawAtoB.destroy(); rawBtoA.destroy(); cb(err); },
    });
    const wireClient = new Duplex({
      allowHalfOpen: false,
      read() {},
      write(chunk, enc, cb) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
        // TLS 1.3 ApplicationData имеет record header type 0x17:
        // 1=pair_pop, 2=sas_confirm, 3=sas_complete (перехватываем 3-ю запись!).
        if (buf[0] === 0x17) {
          appRecordsBtoA += 1;
          if (appRecordsBtoA >= 3) {
            wireHost.destroy(new Error('drop_sas_complete'));
            wireClient.destroy(new Error('drop_sas_complete'));
            cb(new Error('drop_sas_complete'));
            return;
          }
        }
        rawBtoA.write(buf, cb);
      },
      final(cb) { rawBtoA.end(); cb(); },
      destroy(err, cb) { rawBtoA.destroy(); rawAtoB.destroy(); cb(err); },
    });
    rawBtoA.on('data', (c) => wireHost.push(c));
    rawBtoA.on('end', () => wireHost.push(null));
    rawAtoB.on('data', (c) => wireClient.push(c));
    rawAtoB.on('end', () => wireClient.push(null));

    const dropRes = await Promise.allSettled([
      runPairingSession({
        transport: wireHost,
        role: 'host',
        roomId: 'room-p2-7',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Sec-Client' },
        peerStore: devA.peers,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
      runPairingSession({
        transport: wireClient,
        role: 'client',
        roomId: 'room-p2-7',
        identity: devB.identity,
        expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Sec-Host' },
        peerStore: devB.peers,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
    ]);
    assert.ok(dropRes.every((r) => r.status === 'rejected'));
    assert.equal(devA.peers.getPeer(devB.identity.deviceId), null);
    assert.equal(devB.peers.getPeer(devA.identity.deviceId), null);

    // 2. P2-8: таймаут подтверждения SAS и AbortSignal прерывают зависший диалог владельца.
    const [t1, t2] = makeDuplexPair();
    let seenSignalAborted = false;
    const timeoutRes = await Promise.allSettled([
      runPairingSession({
        transport: t1,
        role: 'host',
        roomId: 'room-p2-8-to',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Sec-Client' },
        peerStore: devA.peers,
        confirmTimeoutMs: 180,
        onConfirmSas: (prompt) => new Promise(() => {
          prompt.signal.addEventListener('abort', () => { seenSignalAborted = true; }, { once: true });
        }),
      }),
      runPairingSession({
        transport: t2,
        role: 'client',
        roomId: 'room-p2-8-to',
        identity: devB.identity,
        expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Sec-Host' },
        peerStore: devB.peers,
        confirmTimeoutMs: 3000,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
    ]);
    assert.equal(timeoutRes[0].status, 'rejected');
    assert.equal(timeoutRes[0].reason.code, 'confirmation_timeout');
    assert.equal(seenSignalAborted, true);
    assert.equal(timeoutRes[1].status, 'rejected');

    // Внешний AbortController прерывает сопряжение с pairing_aborted.
    const extAbort = new AbortController();
    const [a1, a2] = makeDuplexPair();
    const abortRes = await Promise.allSettled([
      runPairingSession({
        transport: a1,
        role: 'host',
        roomId: 'room-p2-8-abort',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Sec-Client' },
        peerStore: devA.peers,
        signal: extAbort.signal,
        onConfirmSas: async (prompt) => {
          extAbort.abort();
          assert.equal(prompt.signal.aborted, true);
          return { confirmed: true };
        },
      }),
      runPairingSession({
        transport: a2,
        role: 'client',
        roomId: 'room-p2-8-abort',
        identity: devB.identity,
        expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Sec-Host' },
        peerStore: devB.peers,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
    ]);
    assert.equal(abortRes[0].status, 'rejected');
    assert.equal(abortRes[0].reason.code, 'pairing_aborted');

    // 3. Нормальное сопряжение -> отказ смены CA без allowCaChange -> подтверждённое обновление leaf через mTLS.
    const [ok1, ok2] = makeDuplexPair();
    await Promise.all([
      runPairingSession({
        transport: ok1,
        role: 'host',
        roomId: 'room-ok',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Sec-Client' },
        peerStore: devA.peers,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
      runPairingSession({
        transport: ok2,
        role: 'client',
        roomId: 'room-ok',
        identity: devB.identity,
        expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Sec-Host' },
        peerStore: devB.peers,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
    ]);

    // Молчаливая подмена CA при allowReplace: true (без allowCaChange: true) должна жёстко отклоняться с ca_pin_mismatch.
    const [sc1, sc2] = makeDuplexPair();
    const { createDeviceCertificates } = require('../src/link');
    const altCa = await createDeviceCertificates({ deviceId: devB.identity.deviceId });
    const spoofedBIdent = {
      deviceId: devB.identity.deviceId,
      deviceName: 'Sec-Client',
      getTlsCredentials() {
        return {
          deviceId: devB.identity.deviceId,
          deviceName: 'Sec-Client',
          caPem: altCa.caPem,
          leafPem: altCa.leafPem,
          leafKeyPem: altCa.leafKeyPem,
        };
      },
      signProof: () => Buffer.alloc(64),
    };
    const caSwapRes = await Promise.allSettled([
      runPairingSession({
        transport: sc1,
        role: 'host',
        roomId: 'room-ca-swap',
        identity: devA.identity,
        expectedPeer: { deviceId: devB.identity.deviceId, deviceName: 'Sec-Client' },
        peerStore: devA.peers,
        allowReplace: true,
        allowCaChange: false,
        onConfirmSas: async () => { throw new Error('must_not_prompt_on_ca_swap'); },
      }),
      runPairingSession({
        transport: sc2,
        role: 'client',
        roomId: 'room-ca-swap',
        identity: spoofedBIdent,
        expectedPeer: { deviceId: devA.identity.deviceId, deviceName: 'Sec-Host' },
        peerStore: devB.peers,
        allowReplace: true,
        allowCaChange: false,
        onConfirmSas: async () => ({ confirmed: true }),
      }),
    ]);
    assert.equal(caSwapRes[0].status, 'rejected');
    assert.equal(caSwapRes[0].reason.code, 'ca_pin_mismatch');

    const [m1, m2] = makeDuplexPair();
    const [sessA, sessB] = await Promise.all([
      establishMutualTls({
        stream: m1,
        role: 'server',
        identity: devA.identity,
        expectedPeer: devA.peers.requireTrustedPeer(devB.identity.deviceId),
        peerStore: devA.peers,
        heartbeatIntervalMs: 0,
      }),
      establishMutualTls({
        stream: m2,
        role: 'client',
        identity: devB.identity,
        expectedPeer: devB.peers.requireTrustedPeer(devA.identity.deviceId),
        peerStore: devB.peers,
        heartbeatIntervalMs: 0,
      }),
    ]);

    // Клиент B выпускает новый leaf внутри того же Root CA и отправляет конверт обновления по живому mTLS.
    const oldLeafFp = devB.identity.leafFp256;
    await devB.identity.rotateLeaf({ reason: 'proactive_test' });
    assert.notEqual(devB.identity.leafFp256, oldLeafFp);

    // Отказ владельца на A оставляет старый leaf закреплённым.
    await assert.rejects(
      Promise.all([
        acceptLeafUpdateOverSession(sessA, {
          peerStore: devA.peers,
          onConfirmCertUpdate: async () => ({ confirmed: false }),
        }),
        sendLeafUpdateOverSession(sessB, { identity: devB.identity }),
      ]),
      (err) => err instanceof LinkCryptoError && err.code === 'cert_update_rejected',
    );
    assert.equal(devA.peers.requireTrustedPeer(devB.identity.deviceId).leafFp256, oldLeafFp);

    // Подтверждение владельца на A обновляет пин leafFp256 у devA.
    const [updatedRec, ackRes] = await Promise.all([
      acceptLeafUpdateOverSession(sessA, {
        peerStore: devA.peers,
        onConfirmCertUpdate: async () => ({ confirmed: true }),
      }),
      sendLeafUpdateOverSession(sessB, { identity: devB.identity }),
    ]);
    assert.equal(ackRes.ok, true);
    assert.equal(updatedRec.leafFp256, devB.identity.leafFp256);
    await sessA.close();
    await sessB.close();

    // Новое подключение mTLS 1.3 проходит уже с новым листовым сертификатом devB!
    const [n1, n2] = makeDuplexPair();
    const [sessA2, sessB2] = await Promise.all([
      establishMutualTls({
        stream: n1,
        role: 'server',
        identity: devA.identity,
        expectedPeer: devA.peers.requireTrustedPeer(devB.identity.deviceId),
        peerStore: devA.peers,
        heartbeatIntervalMs: 0,
      }),
      establishMutualTls({
        stream: n2,
        role: 'client',
        identity: devB.identity,
        expectedPeer: devB.peers.requireTrustedPeer(devA.identity.deviceId),
        peerStore: devB.peers,
        heartbeatIntervalMs: 0,
      }),
    ]);
    assert.equal(sessA2.peerLeafFp256, devB.identity.leafFp256);
    await sessA2.close();
    await sessB2.close();
  } finally {
    devA.peers.close();
    devB.peers.close();
    devA.identity.dispose();
    devB.identity.dispose();
  }
});
