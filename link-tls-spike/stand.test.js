'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const http = require('http');
const { startRelay } = require('./relay');
const { Device, hostOf, roomOf, TLS13 } = require('./device');
const { createDevice } = require('./certs');

const SECRET = 'СЕКРЕТНОЕ-ПОРУЧЕНИЕ-42';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-tls-'));
let n = 0;
const fresh = (id) => { const dir = path.join(root, `dev${n += 1}`); createDevice(dir, id); return new Device(dir); };
const pairBoth = (a, b) => { a.pair(b.id, b.cert); b.pair(a.id, a.cert); };
const QUICK = { timeoutMs: 800 };
// a — клиент TLS, b — сервер TLS.
const link = (relay, a, b, opts) => Promise.all([a.connect(relay.port, b.id, 'client', opts), b.connect(relay.port, a.id, 'server', opts)]);
const linkSettled = (relay, a, b) => Promise.allSettled([a.connect(relay.port, b.id, 'client', QUICK), b.connect(relay.port, a.id, 'server', QUICK)]);
const tasksOf = (device) => { const list = []; device.onTask = (text) => list.push(text); return list; };

let relay; let A; let B;
test.before(async () => { relay = await startRelay(); A = fresh(); B = fresh(); pairBoth(A, B); });
test.after(async () => { await relay.close(); fs.rmSync(root, { recursive: true, force: true }); });
test.afterEach(() => { relay.mangle = null; relay.seen.length = 0; relay.dropAll(); });

test('TLS 1.3 через Duplex и посредника: взаимная проверка, ECDHE, без возобновления сеанса', async () => {
  const got = tasksOf(B);
  const [sa, sb] = await link(relay, A, B);
  assert.strictEqual(sa.socket.getProtocol(), 'TLSv1.3');
  assert.strictEqual(sb.socket.getProtocol(), 'TLSv1.3');
  assert.strictEqual(sa.socket.authorized, true);
  assert.strictEqual(sb.socket.authorized, true);
  // В Node 24 тип обмена ключами называется TLSGroup (ECDHE-группа), а не ECDH.
  assert.strictEqual(sa.socket.getEphemeralKeyInfo().type, 'TLSGroup');
  assert.strictEqual(sa.socket.isSessionReused(), false);
  assert.strictEqual(await sa.send('m-ok', SECRET), 'done');
  assert.deepStrictEqual(got, [SECRET]);
});

test('посредник видит только непрозрачные байты', async () => {
  tasksOf(B);
  const [sa] = await link(relay, A, B);
  await sa.send('m-opaque', SECRET);
  const wire = Buffer.concat(relay.seen);
  assert.ok(wire.length > 0);
  assert.strictEqual(wire.includes(SECRET), false);
  assert.strictEqual(wire.includes('m-opaque'), false);
});

test('подмена байта посредником после рукопожатия: сообщение не доходит, связь рвётся', async () => {
  const got = tasksOf(B);
  const [sa] = await link(relay, A, B);
  relay.mangle = (chunk) => { const copy = Buffer.from(chunk); copy[copy.length - 1] ^= 1; return copy; };
  await assert.rejects(sa.send('m-tamper', SECRET));
  assert.deepStrictEqual(got, []);
});

test('подмена байта во время рукопожатия: связь не устанавливается', async () => {
  relay.mangle = (chunk) => { const copy = Buffer.from(chunk); copy[copy.length - 1] ^= 1; return copy; };
  const results = await linkSettled(relay, A, B);
  assert.ok(results.every((r) => r.status === 'rejected'));
});

test('подмена устройства: тот же идентификатор, другой ключ — отказ в обе стороны', async () => {
  const fakeB = fresh(B.id); // выдаёт себя за B перед A
  fakeB.pair(A.id, A.cert);
  const got = tasksOf(fakeB);
  let results = await linkSettled(relay, A, fakeB);
  assert.ok(results.every((r) => r.status === 'rejected'), 'A не должен принять поддельный B');
  const fakeA = fresh(A.id); // выдаёт себя за A перед B
  fakeA.pair(B.id, B.cert);
  const gotB = tasksOf(B);
  results = await linkSettled(relay, fakeA, B);
  assert.ok(results.every((r) => r.status === 'rejected'), 'B не должен принять поддельный A');
  assert.deepStrictEqual([...got, ...gotB], []);
});

// Идёт тихо: сопротивляющегося клиента B не должен принять. Сторона B ждёт A на комнате A~B.
function rawToRoom(a, b) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: relay.port, path: roomOf(a, b), headers: { Connection: 'Upgrade', Upgrade: 'nox-link' } });
    req.on('upgrade', (res, sock) => resolve(sock)).on('error', reject).end();
  });
}

test('неправильный сертификат: третье устройство с сертификатом не от A не проходит вместо A', async () => {
  const C = fresh();
  pairBoth(C, B); // C честно сопряжён с B, но это не A
  const got = tasksOf(B);
  const pB = B.connect(relay.port, A.id, 'server', QUICK); // B ждёт A
  const asC = tls.connect({ ...TLS13, socket: await rawToRoom(A.id, B.id), key: C.key, cert: C.cert, ca: [B.cert], servername: hostOf(B.id) });
  asC.on('error', () => {});
  await assert.rejects(pB);
  asC.destroy();
  assert.deepStrictEqual(got, []);
});

test('клиент без сертификата: сервер отвергает, поручения нет', async () => {
  const got = tasksOf(B);
  const pB = B.connect(relay.port, A.id, 'server', QUICK);
  const anon = tls.connect({ ...TLS13, socket: await rawToRoom(A.id, B.id), ca: [B.cert], servername: hostOf(B.id) });
  anon.on('error', () => {});
  await assert.rejects(pB);
  anon.destroy();
  assert.deepStrictEqual(got, []);
});

test('обрыв связи и переподключение: новое рукопожатие, старое поручение повторно не выполняется', async () => {
  const got = tasksOf(B);
  let [sa] = await link(relay, A, B);
  assert.strictEqual(await sa.send('m-once', SECRET), 'done');
  relay.dropAll();
  await assert.rejects(sa.send('m-lost', SECRET));
  [sa] = await link(relay, A, B);
  assert.strictEqual(sa.socket.isSessionReused(), false);
  assert.strictEqual(await sa.send('m-once', SECRET), 'replay');
  assert.strictEqual(await sa.send('m-new', 'второе'), 'done');
  // m-once выполнен ровно один раз; m-lost ушёл уже в оборванное соединение и не дошёл.
  assert.strictEqual(got.filter((t) => t === SECRET).length, 1);
  assert.strictEqual(got.filter((t) => t === 'второе').length, 1);
});

test('повтор после перезапуска приёмника блокируется', async () => {
  let [sa] = await link(relay, A, B);
  assert.strictEqual(await sa.send('m-restart', SECRET), 'done');
  relay.dropAll();
  const B2 = new Device(B.dir); // тот же диск, новый процесс
  const got = tasksOf(B2);
  [sa] = await link(relay, A, B2);
  assert.strictEqual(await sa.send('m-restart', SECRET), 'replay');
  assert.deepStrictEqual(got, []);
});

test('отзыв доверия: живая связь рвётся, новая не устанавливается', async () => {
  const X = fresh(); const Y = fresh(); pairBoth(X, Y);
  const got = tasksOf(Y);
  const [sx] = await link(relay, X, Y);
  Y.revoke(X.id);
  await assert.rejects(sx.send('m-after-revoke', SECRET));
  await assert.rejects(Y.connect(relay.port, X.id, 'server', QUICK), /peer_not_trusted/);
  await assert.rejects(X.connect(relay.port, Y.id, 'client', QUICK));
  assert.deepStrictEqual(got, []);
  // Отзыв на одной стороне: вторая всё ещё доверяет, но связь не поднимается.
  const P = fresh(); const Q = fresh(); pairBoth(P, Q);
  P.revoke(Q.id);
  const fakeQ = new Device(P.dir); // P после отзыва не знает Q
  await assert.rejects(fakeQ.connect(relay.port, Q.id, 'client', QUICK), /peer_not_trusted/);
});

test('в журналах диагностики нет текста поручений', async () => {
  tasksOf(B);
  const [sa] = await link(relay, A, B);
  await sa.send('m-log', SECRET);
  for (const device of [A, B]) {
    const log = fs.existsSync(path.join(device.dir, 'diag.log')) ? fs.readFileSync(path.join(device.dir, 'diag.log'), 'utf8') : '';
    assert.strictEqual(log.includes(SECRET), false);
  }
  assert.ok(fs.readFileSync(path.join(B.dir, 'diag.log'), 'utf8').includes('"ev":"task"'));
  assert.strictEqual(fs.readFileSync(path.join(B.dir, 'seen.json'), 'utf8').includes(SECRET), false);
});
