'use strict';
// Независимые атакующие тесты (run2). Только фиктивные инструменты, временные папки.
// Запуск: node --test docs/audits/zero-mercy/independent-s0-run2/evidence/adversarial.test.js  (из корня репозитория)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = path.resolve(__dirname, '../../../../../apps/jarvis-desktop');
const { Agent } = require(path.join(APP, 'src/agent/loop'));
const { ToolRegistry } = require(path.join(APP, 'src/tools/registry'));
const { Journal } = require(path.join(APP, 'src/journal/journal'));
const { ApprovalBroker } = require(path.join(APP, 'src/policy/approvals'));

const tick = () => new Promise((r) => setImmediate(r));

function brainOf(steps) {
  let i = 0;
  return { async chat() { const s = steps[i++] || { content: 'конец' }; return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] }; } };
}

// Фиктивное действие: только запоминает, что «выполнилось».
function fakeTool(ran) {
  return {
    name: 'fake_action', risk: 'T2', description: 'fake', parameters: { type: 'object', properties: {} },
    async run(args) { ran.push(args.label); return { ok: true, summary: `ok ${args.label}`, verified: true }; },
  };
}

function makeAgent(t, { broker, ran, steps, events, tool }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-run2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reg = new ToolRegistry();
  reg.register(tool || fakeTool(ran));
  return new Agent({
    brain: brainOf(steps), tools: reg, approvals: broker,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e), mode: 'ask', workspace: dir,
  });
}

async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('не дождались'); await tick(); }
}

const call = (id, label) => ({ toolCalls: [{ id, name: 'fake_action', args: { label } }] });
const reqs = (events) => events.filter((e) => e.type === 'approval_request');

test('изменение аргументов при подготовке подтверждения не выполняет подменённое действие', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const events = [];
  const tool = { ...fakeTool(ran), explain(args) { args.label = 'подмена'; return 'тест'; } };
  const a = makeAgent(t, { broker, ran, events, tool, steps: [call('c', 'оригинал')] });
  const pending = a.run('x');
  await waitFor(() => reqs(events).length === 1);
  broker.respond(reqs(events)[0].id, 'once');
  await pending;
  assert.deepEqual(ran, []);
});

test('изменение аргументов в событии и списке не меняет подтверждённое действие', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const events = [];
  const a = makeAgent(t, { broker, ran, events, steps: [call('c', 'оригинал')] });
  const pending = a.run('x');
  await waitFor(() => reqs(events).length === 1);
  const request = reqs(events)[0];
  request.args.label = 'подмена события';
  const listed = broker.list();
  listed[0].args.label = 'подмена списка';
  assert.equal(broker.list()[0].args.label, 'оригинал');
  broker.respond(request.id, 'once');
  await pending;
  assert.deepEqual(ran, ['оригинал']);
});

test('ZM-001: два агента, одинаковый сырой callId — одобрение A не запускает B', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const evA = []; const evB = [];
  const a = makeAgent(t, { broker, ran, events: evA, steps: [call('call_0', 'A')] });
  const b = makeAgent(t, { broker, ran, events: evB, steps: [call('call_0', 'B')] });
  const pa = a.run('a'); const pb = b.run('b');
  await waitFor(() => reqs(evA).length && reqs(evB).length);
  const [ra] = reqs(evA); const [rb] = reqs(evB);
  assert.notEqual(ra.id, rb.id);
  assert.equal(ra.callId, rb.callId);
  assert.notEqual(ra.agentId, rb.agentId);
  assert.equal(broker.respond('call_0', 'once'), false, 'сырой callId не должен быть ключом');
  assert.equal(broker.respond(ra.id, 'once'), true);
  await pa;
  assert.deepEqual(ran, ['A']);
  assert.equal(broker.list().length, 1);
  assert.equal(broker.list()[0].id, rb.id);
  broker.respond(rb.id, 'reject');
  await pb;
  assert.deepEqual(ran, ['A']);
});

test('двойной клик «Разрешить»: второй ответ отвергается, действие одно', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const ev = [];
  const a = makeAgent(t, { broker, ran, events: ev, steps: [call('c', 'A'), call('c', 'A2')] });
  const p = a.run('x');
  await waitFor(() => reqs(ev).length === 1);
  const id1 = reqs(ev)[0].id;
  assert.equal(broker.respond(id1, 'once'), true);
  assert.equal(broker.respond(id1, 'once'), false);
  await waitFor(() => reqs(ev).length === 2);
  // Тот же сырой id модели во втором ходе — новый ключ, старый клик не годится.
  const id2 = reqs(ev)[1].id;
  assert.notEqual(id1, id2);
  assert.equal(broker.respond(id1, 'once'), false, 'поздний повтор старого клика');
  broker.respond(id2, 'reject');
  await p;
  assert.deepEqual(ran, ['A']);
});

test('просроченное подтверждение: действие не выполняется, поздний ответ отвергнут с причиной', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 30 });
  const ran = []; const ev = [];
  const a = makeAgent(t, { broker, ran, events: ev, steps: [call('c', 'A')] });
  const p = a.run('x');
  await waitFor(() => reqs(ev).length === 1);
  const id = reqs(ev)[0].id;
  await p; // автоотмена через 30 мс
  assert.deepEqual(ran, []);
  assert.equal(broker.respond(id, 'once'), false);
  assert.match(broker.closedReason(id), /время/);
});

test('отказ и сразу новый запрос: ответ на старый id не трогает новый', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const ev = [];
  const a = makeAgent(t, { broker, ran, events: ev, steps: [call('c', 'A'), call('c', 'B')] });
  const p = a.run('x');
  await waitFor(() => reqs(ev).length === 1);
  const idA = reqs(ev)[0].id;
  broker.respond(idA, 'reject');
  await waitFor(() => reqs(ev).length === 2);
  assert.equal(broker.respond(idA, 'once'), false);
  assert.equal(broker.list().length, 1);
  broker.respond(reqs(ev)[1].id, 'reject');
  await p;
  assert.deepEqual(ran, []);
});

test('стоп хода во время ожидания: запрос снят, позднее одобрение не запускает действие', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const ev = [];
  const a = makeAgent(t, { broker, ran, events: ev, steps: [call('c', 'A')] });
  const ctl = new AbortController();
  const p = a.run('x', { signal: ctl.signal });
  await waitFor(() => reqs(ev).length === 1);
  const id = reqs(ev)[0].id;
  if (typeof a.stop === 'function') a.stop(); else ctl.abort();
  ctl.abort();
  await p;
  assert.equal(broker.list().length, 0, 'запрос должен быть снят');
  assert.equal(broker.respond(id, 'once'), false);
  assert.deepEqual(ran, []);
});

test('одобрение и стоп в одном такте: действие не выполняется', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const ev = [];
  const a = makeAgent(t, { broker, ran, events: ev, steps: [call('c', 'A')] });
  const ctl = new AbortController();
  const p = a.run('x', { signal: ctl.signal });
  await waitFor(() => reqs(ev).length === 1);
  broker.respond(reqs(ev)[0].id, 'once');
  if (typeof a.stop === 'function') a.stop();
  ctl.abort();
  await p;
  assert.deepEqual(ran, []);
});

// Повторяем сценарии R2-01 и R2-01b как проверки защиты.
test('R2-01: отменённый ключ нельзя выдать повторно и поздний ответ отклонён', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const first = broker.request({ id: 'task-1:call_0', args: { path: 'A.txt' } });
  broker.cancel('task-1:call_0', 'время вышло');
  assert.equal(await first, 'reject');
  assert.throws(() => broker.request({ id: 'task-1:call_0', args: { path: 'B.txt' } }));
  const second = broker.request({ id: 'task-1:new-key', args: { path: 'B.txt' } });
  assert.equal(broker.respond('task-1:call_0', 'once'), false);
  assert.equal(broker.list()[0].id, 'task-1:new-key');
  broker.respond('task-1:new-key', 'reject');
  assert.equal(await second, 'reject');
});

test('R2-01b: повторный ключ не заменяет ожидающее действие', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const first = broker.request({ id: 'task-1:call_0', args: { label: 'A' } });
  assert.throws(() => broker.request({ id: 'task-1:call_0', args: { label: 'B' } }));
  assert.equal(broker.list()[0].args.label, 'A');
  broker.respond('task-1:call_0', 'reject');
  assert.equal(await first, 'reject');
});

test('R2-02: голос не выбирает запрос без привязки к показанному действию', async () => {
  const { voiceApprovalTarget } = require(path.join(APP, 'src/policy/approvals'));
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const pa = broker.request({ id: 'A' });
  const pb = broker.request({ id: 'B' });
  assert.equal(voiceApprovalTarget(broker.list()), null);
  broker.cancel('A');
  assert.equal(await pa, 'reject');
  assert.equal(voiceApprovalTarget(broker.list()), null);
  broker.cancel('B');
  assert.equal(await pb, 'reject');
  assert.equal(voiceApprovalTarget(broker.list()), null);
  const pc = broker.request({ id: 'C' });
  assert.equal(voiceApprovalTarget(broker.list()), null);
  broker.cancel('C');
  assert.equal(await pc, 'reject');
});
