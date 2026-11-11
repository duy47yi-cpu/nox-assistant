'use strict';
// R3-01: «Разрешить» из окна принимается только на запрос, который окно сейчас показывает (токен показа).
const test = require('node:test');
const assert = require('node:assert/strict');
const { ApprovalBroker } = require('../src/policy/approvals');

test('markShown: токен только у ждущего запроса, новый показ гасит прежний', () => {
  const b = new ApprovalBroker({ autoCancelMs: 0 });
  b.request({ id: 'A' });
  b.request({ id: 'B' });
  assert.equal(b.markShown('nope'), null);
  const tA = b.markShown('A');
  assert.equal(typeof tA, 'string');
  assert.ok(b.isShown('A', tA));
  assert.ok(!b.isShown('B', tA), 'токен A не годится для B');
  assert.ok(!b.isShown('A', undefined));
  assert.ok(!b.isShown('A', 'чужой'));
  const tB = b.markShown('B');
  assert.ok(!b.isShown('A', tA), 'после показа B токен A недействителен');
  assert.ok(b.isShown('B', tB));
});

test('после ответа, отмены или автоотмены показ недействителен', async () => {
  const b = new ApprovalBroker({ autoCancelMs: 20 });
  const pa = b.request({ id: 'A' });
  const tA = b.markShown('A');
  assert.equal(await pa, 'reject'); // автоотмена
  assert.ok(!b.isShown('A', tA));
  assert.equal(b.markShown('A'), null);

  const b2 = new ApprovalBroker({ autoCancelMs: 0 });
  b2.request({ id: 'C' });
  const tC = b2.markShown('C');
  b2.cancel('C', 'стоп');
  assert.ok(!b2.isShown('C', tC));
  b2.request({ id: 'D' });
  const tD = b2.markShown('D');
  assert.ok(b2.respond('D', 'once'));
  assert.ok(!b2.isShown('D', tD));
});

// Повтор логики IPC approval:respond из main.js: согласие без токена показа не доходит до брокера.
function ipcRespond(broker, id, decision, token) {
  if (decision !== 'reject' && !broker.isShown(id, token)) return { ok: false };
  return { ok: broker.respond(id, decision) };
}

test('A показан и истёк, B встал в очередь: согласие с токеном A не одобряет B', async () => {
  const b = new ApprovalBroker({ autoCancelMs: 0 });
  b.request({ id: 'A' });
  let decisionB = null;
  b.request({ id: 'B' }).then((d) => { decisionB = d; });
  const tA = b.markShown('A');
  b.cancel('A', 'время на подтверждение вышло');
  assert.deepEqual(ipcRespond(b, 'B', 'once', tA), { ok: false });
  assert.deepEqual(ipcRespond(b, 'B', 'session', tA), { ok: false });
  assert.deepEqual(ipcRespond(b, 'B', 'once', undefined), { ok: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(decisionB, null);
  // B открыт явно: новый показ, новый токен — теперь согласие принимается.
  const tB = b.markShown('B');
  assert.deepEqual(ipcRespond(b, 'B', 'once', tB), { ok: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(decisionB, 'once');
});

test('отказ принимается без токена', async () => {
  const b = new ApprovalBroker({ autoCancelMs: 0 });
  const p = b.request({ id: 'A' });
  assert.deepEqual(ipcRespond(b, 'A', 'reject'), { ok: true });
  assert.equal(await p, 'reject');
});

test('main.js проверяет токен показа до брокера', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  const i = src.indexOf("ipcMain.handle('approval:respond'");
  assert.ok(i > 0);
  const body = src.slice(i, i + 900);
  assert.match(body, /decision !== 'reject' && !approvals\.isShown\(id, shownToken\)/);
  assert.ok(body.indexOf('isShown') < body.indexOf('approvals.respond('), 'проверка показа раньше ответа брокеру');
  assert.match(src, /ipcMain\.handle\('approval:shown'/);
});
