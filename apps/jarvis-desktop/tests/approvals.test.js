'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApprovalBroker, DEFAULT_AUTO_CANCEL_MS, parseApprovalAnswer } = require('../src/policy/approvals');

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

test('автоотмена: по умолчанию 30 секунд, запрос отменяется сам и причина известна', async () => {
  assert.equal(DEFAULT_AUTO_CANCEL_MS, 30000);
  assert.equal(new ApprovalBroker().autoCancelMs, 30000);
  const broker = new ApprovalBroker({ autoCancelMs: 20 });
  const payload = { id: 'auto-1', name: 'shell_run' };
  const waiting = broker.request(payload);
  assert.equal(typeof payload.autoCancelAt, 'number', 'окно получает время автоотмены');
  assert.equal(await waiting, 'reject');
  assert.equal(broker.respond('auto-1', 'once'), false, 'поздний ответ не принимается');
  assert.equal(broker.closedReason('auto-1'), 'время на подтверждение вышло');
  assert.deepEqual(broker.list(), []);
});

test('автоотмена сообщает окну id и причину, а не молчит', async () => {
  const expired = [];
  const broker = new ApprovalBroker({ autoCancelMs: 15, onAutoCancel: (id, reason) => expired.push({ id, reason }) });
  await broker.request({ id: 'auto-2', name: 'publish_post' });
  assert.deepEqual(expired, [{ id: 'auto-2', reason: 'время на подтверждение вышло' }]);
});

test('ask() — тот же запрос с таймером', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 15 });
  assert.equal(await broker.ask({ id: 'ask-1', name: 'ui_click' }), 'reject');
  assert.equal(broker.closedReason('ask-1'), 'время на подтверждение вышло');
});

test('явный timeoutMs важнее автоотмены; autoCancelMs: 0 — ждать без ограничения', async () => {
  const fast = new ApprovalBroker({ timeoutMs: 10, autoCancelMs: 60000 });
  const payload = { id: 'fast-1' };
  const waiting = fast.request(payload);
  assert.equal(await waiting, 'reject');
  const slow = new ApprovalBroker({ autoCancelMs: 0 });
  const pending = slow.request({ id: 'slow-1' });
  assert.equal(slow.remaining('slow-1'), null, 'таймера нет');
  assert.equal(slow.list().length, 1, 'запрос ждёт владельца');
  slow.respond('slow-1', 'once');
  assert.equal(await pending, 'once');
});

test('remaining() считает секунды до автоотмены по внедрённому времени', async () => {
  let clock = 1000;
  const broker = new ApprovalBroker({ autoCancelMs: 30000, now: () => clock });
  const waiting = broker.request({ id: 'rem-1' });
  assert.equal(broker.remaining('rem-1'), 30000);
  clock += 12000;
  assert.equal(broker.remaining('rem-1'), 18000);
  clock += 18000;
  assert.equal(broker.remaining('rem-1'), 0);
  assert.equal(broker.remaining('нет-такого'), null);
  broker.respond('rem-1', 'once');
  assert.equal(await waiting, 'once');
  assert.equal(broker.remaining('rem-1'), null, 'решённый запрос времени не показывает');
});

test('фразовый ответ: «да/давай/подтверждаю/правильно» — согласие', () => {
  for (const phrase of ['да', 'Да!', 'давай', 'Подтверждаю', 'правильно', 'да, давай', 'разрешаю']) {
    assert.equal(parseApprovalAnswer(phrase), 'once', phrase);
  }
});

test('фразовый ответ: «нет/отмена/не надо/стоп» — отказ', () => {
  for (const phrase of ['нет', 'Нет.', 'отмена', 'не надо', 'стоп', 'отменить', 'не подтверждаю']) {
    assert.equal(parseApprovalAnswer(phrase), 'reject', phrase);
  }
});

test('фразовый ответ: «останови команду» снимает все ожидающие', () => {
  for (const phrase of ['останови команду', 'Останови команду!', 'отмени все подтверждения']) {
    assert.equal(parseApprovalAnswer(phrase), 'cancelAll', phrase);
  }
});

test('обычная речь — не ответ на подтверждение', () => {
  for (const phrase of ['открой ютуб', 'сколько время', 'да нет наверное', '', '   ', null, 42]) {
    assert.equal(parseApprovalAnswer(phrase), null, String(phrase));
  }
});

test('фраза снимает все ожидающие подтверждения через cancelAll', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const a = broker.request({ id: 'v-1' });
  const b = broker.request({ id: 'v-2' });
  assert.equal(parseApprovalAnswer('останови команду'), 'cancelAll');
  assert.equal(broker.cancelAll('голосом: останови команду'), 2);
  assert.deepEqual([await a, await b], ['reject', 'reject']);
  assert.equal(broker.closedReason('v-1'), 'голосом: останови команду');
});

