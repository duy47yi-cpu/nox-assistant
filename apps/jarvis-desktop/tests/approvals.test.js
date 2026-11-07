'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApprovalBroker } = require('../src/policy/approvals');

test('respond резолвит ожидание решением once, session и reject', async () => {
  const broker = new ApprovalBroker({ timeoutMs: 1000 });
  for (const decision of ['once', 'session', 'reject']) {
    const payload = { id: `req-${decision}` };
    const waiting = broker.request(payload);
    assert.equal(broker.respond(payload.id, decision), true);
    assert.equal(await waiting, decision);
  }
});

test('respond на неизвестный id возвращает false; неверное решение бросает TypeError', () => {
  const broker = new ApprovalBroker();
  assert.equal(broker.respond('нет-такого', 'once'), false);
  assert.throws(() => broker.respond('нет-такого', 'maybe'), TypeError);
});

test('по таймауту решение reject', async () => {
  const broker = new ApprovalBroker({ timeoutMs: 20 });
  assert.equal(await broker.request({ name: 'shell_run' }), 'reject');
});

test('id генерируется, если не передан, и пишется обратно в payload', async () => {
  const broker = new ApprovalBroker({ timeoutMs: 1000 });
  const payload = { name: 'url_open' };
  const waiting = broker.request(payload);
  assert.equal(typeof payload.id, 'string');
  assert.ok(payload.id.length > 0);
  assert.equal(broker.respond(payload.id, 'once'), true);
  assert.equal(await waiting, 'once');
});

test('по умолчанию без таймаута: решение ждёт владельца', () => {
  assert.equal(new ApprovalBroker().timeoutMs, null);
});

test('cancel по id и cancelPrefix по id задачи: ожидание — отказ, поздний ответ не принимается, причина известна', async () => {
  const broker = new ApprovalBroker();
  const a = broker.request({ id: 't1:c1' });
  const b = broker.request({ id: 't1:c2' });
  const other = broker.request({ id: 't10:c1' });
  const single = broker.request({ id: 'x' });
  assert.equal(broker.cancel('x', 'задача отменена'), true);
  assert.equal(await single, 'reject');
  assert.equal(broker.cancel('x'), false, 'повторно отменять нечего');
  assert.deepEqual(broker.cancelPrefix('t1:', 'задача заблокирована'), ['t1:c1', 't1:c2']);
  assert.deepEqual([await a, await b], ['reject', 'reject']);
  assert.deepEqual(broker.list().map((p) => p.id), ['t10:c1'], 'чужая задача с похожим id не тронута');
  assert.equal(broker.respond('t1:c1', 'once'), false);
  assert.equal(broker.closedReason('t1:c1'), 'задача заблокирована');
  assert.equal(broker.closedReason('x'), 'задача отменена');
  assert.equal(broker.closedReason('t10:c1'), null);
  assert.deepEqual(broker.cancelPrefix(''), [], 'пустой префикс ничего не отменяет');
  // cancelAll — причина «аварийный стоп»; новый запрос с тем же id — новое ожидание.
  assert.equal(broker.cancelAll(), 1);
  assert.equal(await other, 'reject');
  assert.equal(broker.closedReason('t10:c1'), 'аварийный стоп');
  const again = broker.request({ id: 't10:c1' });
  assert.equal(broker.closedReason('t10:c1'), null);
  assert.equal(broker.respond('t10:c1', 'once'), true);
  assert.equal(await again, 'once');
});
