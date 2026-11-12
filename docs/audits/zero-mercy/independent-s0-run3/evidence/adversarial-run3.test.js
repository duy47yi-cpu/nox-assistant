'use strict';
// Независимые атакующие тесты прогона 3. Написаны заново, тесты Codex и run2 не копировались.
// Только фиктивные инструменты, временные папки, без сети и реальных данных.
// Запуск из корня репозитория:
//   node --test docs/audits/zero-mercy/independent-s0-run3/evidence/adversarial-run3.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// ZM3_APP — копия приложения для проверки чувствительности тестов (старые версии файлов из HEAD).
const APP = process.env.ZM3_APP || path.resolve(__dirname, '../../../../../apps/jarvis-desktop');
const req = (p) => require(path.join(APP, p));
const { Agent } = req('src/agent/loop');
const { ScreenAgent } = req('src/screen/agent');
const { ToolRegistry } = req('src/tools/registry');
const { Journal } = req('src/journal/journal');
const { ApprovalBroker, voiceApprovalTarget, parseApprovalAnswer } = req('src/policy/approvals');
const { createExecutor } = req('src/tasks/executor');
const { TaskQueue } = req('src/tasks/queue');
const model = req('src/tasks/model');
const { createMandate } = req('src/tasks/mandate');
const { StopSwitch } = req('src/control/stop');
const { WorkspaceIndex } = req('src/rag/index');
const { workspaceTools } = req('src/tools/workspace');
const { runCommand } = req('src/commands/runner');
const modes = req('src/policy/modes');

const tick = () => new Promise((r) => setImmediate(r));
async function waitFor(pred, what = 'условие', n = 2000) {
  for (let i = 0; i < n; i += 1) { if (pred()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}
function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── Брокер ─────────────────────────────────────────────────────────

test('B1: id нельзя выдать повторно ни после ответа, ни после отмены, ни пока ждёт', () => {
  const b = new ApprovalBroker({ autoCancelMs: 0 });
  b.request({ id: 'x', name: 'a' });
  assert.throws(() => b.request({ id: 'x', name: 'b' }), /уже использован/, 'пока ждёт');
  assert.equal(b.list().length, 1);
  assert.equal(b.list()[0].name, 'a', 'ждущий запрос не подменён');
  b.respond('x', 'once');
  assert.throws(() => b.request({ id: 'x', name: 'c' }), /уже использован/, 'после ответа');
  b.request({ id: 'y' }); b.cancel('y');
  assert.throws(() => b.request({ id: 'y' }), /уже использован/, 'после отмены');
  assert.equal(b.respond('x', 'once'), false, 'повторный ответ не принимается');
});

test('B2: вложенные аргументы в списке брокера не меняются ни вызывающим, ни читателем списка', () => {
  const b = new ApprovalBroker({ autoCancelMs: 0 });
  const payload = { id: 'n', name: 'w', args: { file: { path: 'a.txt', parts: ['ok'] } } };
  b.request(payload);
  payload.args.file.path = 'C:/Windows/evil';
  payload.args.file.parts.push('evil');
  const seen = b.list()[0];
  seen.args.file.path = 'evil2';
  assert.deepEqual(b.list()[0].args, { file: { path: 'a.txt', parts: ['ok'] } });
});

test('B3: ответ после автоотмены отвергается, даже если пришёл в ту же миллисекунду', async () => {
  const b = new ApprovalBroker({ autoCancelMs: 5 });
  const p = b.request({ id: 'late' });
  assert.equal(await p, 'reject');
  assert.equal(b.respond('late', 'once'), false);
  assert.equal(b.closedReason('late'), 'время на подтверждение вышло');
});

test('B4: неизвестное решение не одобряет (TypeError, запрос ждёт дальше)', () => {
  const b = new ApprovalBroker({ autoCancelMs: 0 });
  b.request({ id: 'd' });
  for (const bad of ['ONCE', 'yes', '', null, undefined, 1, { decision: 'once' }]) {
    assert.throws(() => b.respond('d', bad), TypeError);
  }
  assert.equal(b.list().length, 1);
});

// ── Голос ─────────────────────────────────────────────────────────

test('V1: голосовое «да» не выбирает цель ни при одном, ни при нескольких запросах', () => {
  assert.equal(parseApprovalAnswer('да'), 'once');
  assert.equal(voiceApprovalTarget([]), null);
  assert.equal(voiceApprovalTarget([{ id: 'a' }]), null);
  assert.equal(voiceApprovalTarget([{ id: 'a' }, { id: 'b' }]), null);
});

// ── Основной чат (Agent) ───────────────────────────────────────────

function brainOf(steps) {
  let i = 0;
  return { async chat() { const s = steps[i++] || { content: 'конец' }; return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] }; } };
}
function recTool(ran, extra = {}) {
  return {
    name: 'fake_action', risk: 'T2', description: 'fake', parameters: { type: 'object', properties: {} },
    async run(args) { ran.push(structuredClone(args)); return { ok: true, summary: 'ok', verified: 'confirmed' }; },
    ...extra,
  };
}
function agentOf(t, { broker, ran, steps, events, tool, emitHook }) {
  const dir = tmp(t, 'zm3-agent-');
  const reg = new ToolRegistry();
  reg.register(tool || recTool(ran));
  return new Agent({
    brain: brainOf(steps), tools: reg, approvals: broker, journal: new Journal(path.join(dir, 'j.jsonl')),
    emit: (e) => { events.push(e); if (emitHook) emitHook(e); }, mode: 'ask', workspace: dir,
  });
}
const call = (id, args) => ({ toolCalls: [{ id, name: 'fake_action', args }] });
const asks = (events) => events.filter((e) => e.type === 'approval_request');

test('C1: подмена вложенного аргумента в explain() отклоняет действие', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const events = [];
  const tool = recTool(ran, { explain(a) { a.target.path = 'C:/evil'; return 'x'; } });
  const a = agentOf(t, { broker, ran, events, tool, steps: [call('c1', { target: { path: 'ok.txt' } })] });
  const run = a.run('x');
  await waitFor(() => asks(events).length === 1);
  broker.respond(asks(events)[0].id, 'once');
  await run;
  assert.deepEqual(ran, [], 'подменённое действие не выполнено');
});

test('C2: окно мутирует вложенные args в событии — выполняется ровно то, что было в запросе', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const events = [];
  const emitHook = (e) => { if (e.args && e.args.target) { e.args.target.path = 'evil'; e.args.target.list.push('x'); } };
  const a = agentOf(t, { broker, ran, events, emitHook, steps: [call('c2', { target: { path: 'ok.txt', list: [1] } })] });
  const run = a.run('x');
  await waitFor(() => asks(events).length === 1);
  assert.deepEqual(broker.list()[0].args, { target: { path: 'ok.txt', list: [1] } }, 'брокер хранит исходное');
  broker.respond(asks(events)[0].id, 'once');
  await run;
  assert.deepEqual(ran, [{ target: { path: 'ok.txt', list: [1] } }]);
});

test('C3: модель повторяет один callId трижды в одном ходу — три разных ключа, каждый одобряет только своё', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const events = [];
  const a = agentOf(t, { broker, ran, events, steps: [call('dup', { n: 1 }), call('dup', { n: 2 }), call('dup', { n: 3 })] });
  const run = a.run('x');
  await waitFor(() => asks(events).length === 1);
  const A = asks(events)[0];
  broker.respond(A.id, 'reject');
  await waitFor(() => asks(events).length === 2);
  const B = asks(events)[1];
  assert.notEqual(A.id, B.id);
  assert.equal(broker.respond(A.id, 'once'), false, 'устаревшая карточка A не одобряет B');
  assert.equal(broker.list().length, 1);
  broker.respond(B.id, 'once');
  await waitFor(() => asks(events).length === 3);
  const C = asks(events)[2];
  assert.equal(new Set([A.id, B.id, C.id]).size, 3);
  assert.equal(broker.respond(B.id, 'once'), false);
  broker.respond(C.id, 'reject');
  await run;
  assert.deepEqual(ran, [{ n: 2 }]);
});

test('C4: два агента ждут одновременно, ответы в обратном порядке — каждый выполняет только своё', async (t) => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const ranA = []; const ranB = []; const evA = []; const evB = [];
  const a = agentOf(t, { broker, ran: ranA, events: evA, steps: [call('call_0', { who: 'A' })] });
  const b = agentOf(t, { broker, ran: ranB, events: evB, steps: [call('call_0', { who: 'B' })] });
  const pa = a.run('x'); const pb = b.run('x');
  await waitFor(() => asks(evA).length === 1 && asks(evB).length === 1);
  assert.notEqual(asks(evA)[0].agentId, asks(evB)[0].agentId);
  broker.respond(asks(evB)[0].id, 'reject');
  broker.respond(asks(evA)[0].id, 'once');
  await Promise.all([pa, pb]);
  assert.deepEqual(ranA, [{ who: 'A' }]);
  assert.deepEqual(ranB, []);
});

// ── Экранный агент ─────────────────────────────────────────────────

test('S1: «на сессию» для опасного шага экрана не разрешает следующий такой же шаг без вопроса', async (t) => {
  const dir = tmp(t, 'zm3-screen-');
  const runs = []; const events = [];
  const reg = new ToolRegistry();
  reg.register({ name: 'ui_click', risk: 'T1', description: '', parameters: { type: 'object', properties: {} },
    async run(a) { runs.push(a.name); return { ok: true, summary: 'ok' }; }, async verify() { return { status: 'confirmed', evidence: 'фикстура' }; } });
  const look = { name: 'screen_look', risk: 'T1', description: '', async run() { return { ok: true, summary: 'снимок', image: 'data:image/jpeg;base64,AA==' }; } };
  let n = 0;
  const brain = { async chat() {
    n += 1;
    if (n === 1) return { content: '', toolCalls: [{ id: 'l', name: 'screen_look', args: {} }] };
    if (n === 2 || n === 3) return { content: '', toolCalls: [{ id: 'same', name: 'ui_click', args: { name: 'Отправить' } }] };
    return { content: 'готово', toolCalls: [] };
  } };
  const approvals = new ApprovalBroker({ autoCancelMs: 0 });
  const agent = new ScreenAgent({ brain, tools: reg, look, policy: modes, approvals,
    journal: new Journal(path.join(dir, 'j.jsonl')), emit: (e) => events.push(e), mode: 'full', workspace: dir });
  const run = agent.run('сделай на экране: отправь');
  await waitFor(() => asks(events).length === 1, 'первый опасный шаг');
  approvals.respond(asks(events)[0].id, 'session');
  await waitFor(() => asks(events).length === 2 || n >= 4, 'второй опасный шаг');
  assert.equal(asks(events).length, 2, 'второй опасный шаг снова спрошен');
  assert.notEqual(asks(events)[0].id, asks(events)[1].id);
  assert.equal(runs.length, 1, 'второй шаг не выполнен без ответа');
  approvals.respond(asks(events)[1].id, 'reject');
  await run;
  assert.deepEqual(runs, ['Отправить']);
});

// ── Исполнитель задач ─────────────────────────────────────────────

const ASKING = {
  name: 'web_fetch', risk: 'T1', requiresApproval: true, description: 'фикстура',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
};
function execSetup(t, script, { onEvent } = {}) {
  const base = tmp(t, 'zm3-exec-');
  const root = path.join(base, 'ws');
  for (const d of ['notes', 'reports']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const index = new WorkspaceIndex(root);
  const ws = workspaceTools(index);
  let i = 0;
  const brain = { async chat(r) {
    const s = script[i++];
    if (!s) throw new Error('сценарий исчерпан');
    const reply = typeof s === 'function' ? s(r) : s;
    return { content: reply.content || '', reasoningContent: null, toolCalls: (reply.toolCalls || []).map((c) => ({ argsError: null, ...c })), stats: { promptTokens: 1, completionTokens: 1 } };
  } };
  const runs = [];
  const runTool = async (name, args) => {
    runs.push({ name, args: structuredClone(args) });
    const tool = ws.find((x) => x.name === name);
    return tool ? tool.run(args) : { ok: true, summary: 'фикстура прочитана' };
  };
  const queue = new TaskQueue({ now: () => Date.now() });
  const stop = new StopSwitch();
  const approvals = new ApprovalBroker({ autoCancelMs: 0 });
  stop.onTrigger(({ reason }) => { approvals.cancelAll(); queue.stopAll(reason); });
  const events = [];
  const executor = createExecutor({
    queue, saveTasks: () => {}, brain, runTool, toolSpecs: [...ws, ASKING], approvals, stop,
    journal: { append: () => {} }, resolve: (rel) => index.resolveInside(rel),
    emit: (e) => { events.push(e); if (onEvent) onEvent(e); }, costOf: () => null, now: () => Date.now(), sandboxReportsDir: 'reports',
  });
  const m = createMandate({ goal: 'G', tools: ['workspace_read', 'workspace_write', 'web_fetch'], sandboxRoot: root, now: Date.now() });
  m.approvedBy = 'владелец';
  queue.add(model.createTask({ id: 'm1', title: 'T', goal: 'G', now: Date.now(), mandate: m }));
  return { executor, approvals, runs, queue, stop, events };
}
const plan = { toolCalls: [{ id: 'p', name: 'task_plan_submit', args: {
  steps: [{ title: 'шаг' }], criteria: [{ requirement: 'G', text: 'оценка', manual: { kind: 'model_only', reason: 'фикстура' } }] } }] };
const fetch = (id, url) => ({ toolCalls: [{ id, name: 'web_fetch', args: { url } }] });
const done = { toolCalls: [{ id: 'd', name: 'step_done', args: { summary: 'ok' } }] };

test('E1: исполнитель, модель повторяет id вызова — устаревшая карточка не одобряет новое действие', async (t) => {
  const h = execSetup(t, [plan, fetch('dup', 'https://a.test/'), fetch('dup', 'https://b.test/'), done, { content: 'итог' }]);
  const running = h.executor.submit('m1');
  await waitFor(() => h.approvals.list().length === 1, 'запрос A');
  const [A] = h.approvals.list();
  assert.equal(A.callId, 'dup');
  assert.notEqual(A.id, 'm1:dup');
  h.approvals.respond(A.id, 'reject');
  await waitFor(() => h.approvals.list().length === 1 && h.approvals.list()[0].id !== A.id, 'запрос B');
  const [B] = h.approvals.list();
  assert.equal(B.callId, 'dup');
  assert.equal(h.approvals.respond(A.id, 'once'), false, 'клик по карточке A не принят');
  assert.equal(h.approvals.list().length, 1, 'B всё ещё ждёт');
  assert.equal(h.runs.length, 0);
  h.approvals.respond(B.id, 'once');
  await running;
  assert.deepEqual(h.runs.filter((r) => r.name === 'web_fetch').map((r) => r.args.url), ['https://b.test/']);
});

test('E2: исполнитель — окно мутирует args события подтверждения, выполняется исходный адрес', async (t) => {
  const h = execSetup(t, [plan, fetch('c', 'https://ok.test/'), done, { content: 'итог' }], {
    onEvent: (e) => { if (e.args && typeof e.args === 'object' && 'url' in e.args) e.args.url = 'https://evil.test/'; },
  });
  const running = h.executor.submit('m1');
  await waitFor(() => h.approvals.list().length === 1);
  const [A] = h.approvals.list();
  assert.equal(A.args.url, 'https://ok.test/');
  h.approvals.respond(A.id, 'once');
  await running;
  assert.deepEqual(h.runs.filter((r) => r.name === 'web_fetch').map((r) => r.args.url), ['https://ok.test/']);
});

test('E3: исполнитель — стоп во время ожидания, позднее «once» ничего не запускает', async (t) => {
  const h = execSetup(t, [plan, fetch('c', 'https://a.test/'), done, { content: 'итог' }]);
  const running = h.executor.submit('m1');
  await waitFor(() => h.approvals.list().length === 1);
  const [A] = h.approvals.list();
  h.stop.trigger('аварийный стоп');
  assert.equal(h.approvals.respond(A.id, 'once'), false);
  await running;
  assert.equal(h.runs.length, 0);
});

test('E4: исполнитель — ответ «session» на запрос без сессии не разрешает следующий вызов', async (t) => {
  const h = execSetup(t, [plan, fetch('c1', 'https://a.test/'), fetch('c2', 'https://a.test/'), done, { content: 'итог' }]);
  const running = h.executor.submit('m1');
  await waitFor(() => h.approvals.list().length === 1);
  const [A] = h.approvals.list();
  assert.equal(A.allowSession, false);
  h.approvals.respond(A.id, 'session');
  await waitFor(() => h.approvals.list().length === 1 && h.approvals.list()[0].id !== A.id, 'второй вопрос');
  assert.equal(h.runs.filter((r) => r.name === 'web_fetch').length, 1, 'второй вызов ждёт ответа');
  h.approvals.respond(h.approvals.list()[0].id, 'reject');
  await running;
  assert.equal(h.runs.filter((r) => r.name === 'web_fetch').length, 1);
});

// ── Команды ───────────────────────────────────────────────────────

function cmdDeps(t, approvals, ran, onApproval) {
  const dir = tmp(t, 'zm3-cmd-');
  const reg = new ToolRegistry();
  reg.register({ name: 'fixture_write', risk: 'T2', description: '', parameters: { type: 'object', properties: { path: { type: 'string' } } },
    async run(a) { ran.push(structuredClone(a)); return { ok: true, summary: 'ok' }; } });
  return { tools: reg, policy: modes, journal: { append: () => {} }, workspace: dir, mode: 'ask', approvals,
    emit: (e) => { if (e.type === 'approval_request') onApproval(e); } };
}

test('K1: две одновременные команды с одинаковыми шагами — разные ключи, ответ одной не трогает другую', async (t) => {
  const approvals = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const seen = [];
  const deps = cmdDeps(t, approvals, ran, (e) => seen.push(e));
  const cmd = { id: 'c', name: 'К', steps: [{ tool: 'fixture_write', args: { path: 'a.txt' } }] };
  const p1 = runCommand(cmd, deps); const p2 = runCommand(cmd, deps);
  await waitFor(() => seen.length === 2);
  assert.notEqual(seen[0].id, seen[1].id);
  approvals.respond(seen[1].id, 'reject');
  approvals.respond(seen[0].id, 'once');
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true); assert.equal(r2.ok, false);
  assert.equal(ran.length, 1);
});

test('K2: команда — отмена сигнала сразу после одобрения не выполняет шаг', async (t) => {
  const approvals = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = []; const ctrl = new AbortController();
  const deps = { ...cmdDeps(t, approvals, ran, (e) => { queueMicrotask(() => { approvals.respond(e.id, 'once'); ctrl.abort(); }); }), signal: ctrl.signal };
  const r = await runCommand({ id: 'c', name: 'К', steps: [{ tool: 'fixture_write', args: { path: 'a.txt' } }] }, deps);
  assert.equal(r.ok, false);
  assert.deepEqual(ran, []);
});

test('K3: команда — окно мутирует args события, выполняется исходный путь', async (t) => {
  const approvals = new ApprovalBroker({ autoCancelMs: 0 });
  const ran = [];
  const deps = cmdDeps(t, approvals, ran, (e) => { e.args.path = 'evil.txt'; approvals.respond(e.id, 'once'); });
  await runCommand({ id: 'c', name: 'К', steps: [{ tool: 'fixture_write', args: { path: 'a.txt' } }] }, deps);
  assert.deepEqual(ran, [{ path: 'a.txt' }]);
});
