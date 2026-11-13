'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { PassThrough, Duplex } = require('node:stream');
const tls = require('node:tls');
const link = require(process.env.AUDIT_LINK_DIR || 'D:/nox-release/apps/jarvis-desktop/src/link');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `c6-audit-${p}-`));
const testEnv = (dir) => ({ NOX_DATA_DIR: dir, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' });

// holdUntilBinary: B->A — первый кусок сразу, дальше копим, пока не придёт двоичный TLS-кусок, и отдаём всё одним push.
function makePair({ holdUntilBinary = false } = {}) {
  const aToB = new PassThrough(); const bToA = new PassThrough();
  const mk = (out, other) => new Duplex({ allowHalfOpen: false, read() {}, write(c, e, cb) { out.write(c, e, cb); }, final(cb) { out.end(); cb(); }, destroy(err, cb) { out.destroy(); other.destroy(); cb(err); } });
  const A = mk(aToB, bToA); const B = mk(bToA, aToB);
  let first = true; let held = []; let released = false; let timer = null;
  const flush = () => { if (timer) clearTimeout(timer); timer = null; if (held.length) { A.push(Buffer.concat(held)); held = []; } };
  bToA.on('data', (c) => {
    if (!holdUntilBinary || released) return A.push(c);
    if (first) { first = false; return A.push(c); }
    held.push(c);
    if (c[0] === 0x16) { released = true; setTimeout(flush, 20); }
    else if (!timer) timer = setTimeout(flush, 1500);
  });
  bToA.on('end', () => A.push(null)); bToA.on('close', () => { if (!A.destroyed) A.destroy(); });
  aToB.on('data', (c) => B.push(c)); aToB.on('end', () => B.push(null)); aToB.on('close', () => { if (!B.destroyed) B.destroy(); });
  return [A, B];
}
const fakeIdentity = (c) => ({ getTlsCredentials: () => ({ deviceId: c.deviceId, deviceName: 'D', caPem: c.caPem, leafPem: c.leafPem, leafKeyPem: c.leafKeyPem, caFp256: c.caFp256, leafFp256: c.leafFp256 }) });

test('A1b NameConstraints: контроль + чистая проверка цепочки', async () => {
  const devA = await link.createDeviceCertificates();
  const victimId = link.generateDeviceId();
  const evil = await link.issueDeviceLeaf({ deviceId: victimId, caPem: devA.caPem, caKeyPem: devA.caKeyPem });
  // Чистый TLS без кода Nox: сервер с evil-листом, клиент доверяет только CA A и ждёт victim host.
  const run = (leafPem, keyPem, host) => new Promise((resolve) => {
    const [s, c] = makePair();
    const srv = tls.createServer({ key: keyPem, cert: `${leafPem}\n${devA.caPem}`, minVersion: 'TLSv1.3' });
    srv.on('tlsClientError', () => {}); srv.emit('connection', s);
    const sock = tls.connect({ socket: c, ca: [devA.caPem], servername: host, minVersion: 'TLSv1.3', rejectUnauthorized: false }, () => { resolve({ authorized: sock.authorized, err: sock.authorizationError }); sock.destroy(); });
    sock.on('error', (e) => resolve({ error: e.code || e.message }));
  });
  const control = await run(devA.leafPem, devA.leafKeyPem, link.hostOf(devA.deviceId));
  const attack = await run(evil.leafPem, evil.leafKeyPem, link.hostOf(victimId));
  console.log('A1b control:', JSON.stringify(control), '| NC attack:', JSON.stringify(attack), '|', process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`);
  assert.equal(control.authorized, true);
  assert.equal(attack.authorized, false);
});

test('A4b Склейка reveal клиента и ClientHello в одном куске у хоста', async () => {
  let ok = 0; const codes = []; const RUNS = 10;
  for (let i = 0; i < RUNS; i += 1) {
    const dA = tmp('pA'); const dB = tmp('pB');
    const idA = await link.loadOrCreateIdentity({ dataDir: dA, deviceName: 'Host PC', protect: null, env: testEnv(dA) });
    const idB = await link.loadOrCreateIdentity({ dataDir: dB, deviceName: 'Client PC', protect: null, env: testEnv(dB) });
    const [host, client] = makePair({ holdUntilBinary: true });
    const res = await Promise.allSettled([
      link.runPairingSession({ transport: host, role: 'host', roomId: `room-${i}`, identity: idA, expectedPeer: { deviceId: idB.deviceId, deviceName: 'Client PC' }, peerStore: new link.PeerTrustStore({ dataDir: dA }), onConfirmSas: async () => ({ confirmed: true }), phaseTimeoutMs: 4000, handshakeTimeoutMs: 4000 }),
      link.runPairingSession({ transport: client, role: 'client', roomId: `room-${i}`, identity: idB, expectedPeer: { deviceId: idA.deviceId, deviceName: 'Host PC' }, peerStore: new link.PeerTrustStore({ dataDir: dB }), onConfirmSas: async () => ({ confirmed: true }), phaseTimeoutMs: 4000, handshakeTimeoutMs: 4000 }),
    ]);
    if (res.every((r) => r.status === 'fulfilled')) ok += 1;
    codes.push(res.map((r) => (r.status === 'rejected' ? r.reason.code : 'ok')).join('/'));
  }
  console.log(`A4b: ${ok}/${RUNS} ok; outcomes: ${[...new Set(codes)].join(', ')}`);
  assert.equal(ok, RUNS);
});
