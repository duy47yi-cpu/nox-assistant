'use strict';

// Контракт события прогресса (этап 1): runId, порядковый step, статусы планирования/выполнения/ожидания/
// проверки и честный итог запуска (succeeded / unverified / failed / cancelled). Тип события и state не
// переименованы: поля добавлены к действующим событиям, окно может их игнорировать.
// Здесь же: поздний ответ после stop не воскрешает запуск, отказ/тайм-аут подтверждения не выполняют
// действие, непроверенный результат не выглядит успехом, история связывает ход, вызов и проверку.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent, PROGRESS_STATUSES, safeTarget } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const { StopSwitch } = require('../src/control/stop');
const { TurnLog } = require('../src/agent/turnlog');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scriptedBrain(steps) {
  let i = 0;
  return {
    async chat() {
      const s = steps[i++];
      if (!s) throw new Error('сценарий закончился');
      return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] };
    },
  };
}

function tool(name, risk, run, verify) {
  return { name, risk, description: name, parameters: { type: 'object', properties: {} }, run, ...(verify ? { verify } : {}) };
}

function registry(...tools) {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register(t);
  return reg;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const progressEvent = (e) => e && e.type === 'status' && typeof e.status === 'string';
const lastDone = (events) => [...events].reverse().find((e) => e.type === 'done');

test('прогресс: планирование, шаг, проверка и честный итог unverified', async (t) => {
  const dir = setup(t);
  const events = [];
  const journal = new Journal(path.join(dir, 'journal.jsonl'));
  const turns = new TurnLog(path.join(dir, 'turns.jsonl'));
  const brain = scriptedBrain([
    { toolCalls: [{ id: 'c1', name: 'check', args: { path: 'notes/a.md' } }] },
    { content: 'готово' },
  ]);
  const agent = new Agent({
    brain,
    tools: registry(tool('check', 'T2', async () => ({ ok: true, summary: 'сделано', data: {} }), async () => ({ status: 'unknown', evidence: 'нет признака' }))),
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal,
    turnsLog: turns,
    emit: (e) => events.push(e),
    mode: 'full',
    workspace: dir,
  });
  const result = await agent.run('проверь');

  assert.equal(result.ok, true);
  const done = lastDone(events);
  assert.ok(done, 'done отправлен');
  assert.equal(typeof done.runId, 'string');
  assert.equal(done.outcome, 'answer');
  assert.equal(done.status, 'unverified', 'действие без подтверждения — не успех');
  // 1. Планирование первым: step 0, статус planning.
  const planning = events.find(progressEvent);
  assert.ok(planning, 'есть событие статуса прогресса');
  assert.equal(planning.state, 'thinking');
  assert.equal(planning.status, 'planning');
  assert.equal(planning.step, 0);
  assert.equal(planning.runId, done.runId);
  assert.equal(typeof planning.startedAt, 'string');
  // 2. Старт шага: порядковый номер, безопасная цель.
  const start = events.find((e) => e.type === 'tool_start');
  assert.equal(start.runId, done.runId);
  assert.equal(start.step, 1);
  assert.equal(start.status, 'running');
  assert.deepEqual(start.target, { path: 'notes/a.md' });
  // 3. Проверка объявлена отдельным статусом до итога шага.
  const verifying = events.find((e) => progressEvent(e) && e.status === 'verifying');
  assert.ok(verifying, 'видно, что идёт проверка результата');
  assert.equal(verifying.step, 1);
  // 4. Итог шага: не проверено, а не «выполнено».
  const stepResult = events.find((e) => e.type === 'tool_result');
  assert.equal(stepResult.status, 'unverified');
  assert.equal(stepResult.verifiedStatus, 'unverified', 'нормализованный итог проверки — не «подтверждено»');
  assert.equal(stepResult.decision, 'allow');
  assert.equal(stepResult.verified, 'unknown');
  assert.equal(stepResult.runId, done.runId);
  assert.equal(stepResult.step, 1);
  // 5. Итог запуска со сводкой проверки и ссылкой на историю.
  assert.deepEqual(done.verification, { confirmed: 0, unverified: 1, failed: 0, reads: 0, total: 1 });
  assert.equal(done.steps, 1);
  assert.deepEqual(done.history.map((c) => [c.callId, c.step, c.status, c.verified]), [['c1', 1, 'unverified', 'unknown']]);
  for (const status of [planning.status, start.status, verifying.status, stepResult.status, done.status]) {
    assert.ok(PROGRESS_STATUSES.has(status), `статус из контракта: ${status}`);
  }

  // История связывает ход, вызов и проверку: один и тот же runId и callId.
  const [entry] = readJsonl(path.join(dir, 'journal.jsonl'));
  assert.equal(entry.runId, done.runId);
  assert.equal(entry.step, 1);
  assert.equal(entry.callId, 'c1');
  assert.equal(entry.status, 'unverified');
  assert.equal(entry.verified, 'unknown');
  assert.equal(entry.evidence, 'нет признака');
  const turnsLog = readJsonl(path.join(dir, 'turns.jsonl'));
  assert.equal(turnsLog.find((r) => r.kind === 'turn').turn, done.runId);
  assert.equal(turnsLog.find((r) => r.kind === 'tool_start').callId, entry.callId);
});

test('подтверждённый результат даёт succeeded, а провал проверки — failed', async (t) => {
  const dir = setup(t);
  const events = [];
  const make = (verifyStatus) => new Agent({
    brain: scriptedBrain([
      { toolCalls: [{ id: 'c1', name: 'change', args: { path: 'notes/a.md' } }] },
      { content: 'готово' },
    ]),
    tools: registry(tool('change', 'T1', async () => ({ ok: true, summary: 'сделано', data: {} }), async () => ({ status: verifyStatus, evidence: 'проверка' }))),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'full',
    workspace: dir,
  });
  await make('confirmed').run('сделай');
  assert.equal(lastDone(events).status, 'succeeded');
  assert.equal(events.find((e) => e.type === 'tool_result').status, 'succeeded');
  assert.equal(events.find((e) => e.type === 'tool_result').verifiedStatus, 'confirmed');

  events.length = 0;
  await make('failed').run('сделай');
  assert.equal(lastDone(events).status, 'failed');
  const failed = events.find((e) => e.type === 'tool_result');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.verifiedStatus, 'failed');
  assert.equal(failed.ok, false);
});

test('отказ в подтверждении: действие не выполняется, итог failed, шаг с decision reject', async (t) => {
  const dir = setup(t);
  const events = [];
  const approvals = new ApprovalBroker({ timeoutMs: null });
  let runs = 0;
  const agent = new Agent({
    brain: scriptedBrain([
      { toolCalls: [{ id: 'w1', name: 'write', args: { path: 'notes/a.md' } }] },
      { content: 'понял' },
    ]),
    tools: registry(tool('write', 'T2', async () => { runs += 1; return { ok: true, summary: 'записано' }; })),
    approvals,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_request') approvals.respond(e.id, 'reject');
    },
    mode: 'auto',
    workspace: dir,
  });
  await agent.run('запиши');

  assert.equal(runs, 0, 'после отказа действие не выполняется');
  const request = events.find((e) => e.type === 'approval_request');
  assert.equal(request.status, 'awaiting_approval');
  assert.equal(request.step, 1);
  assert.deepEqual(request.target, { path: 'notes/a.md' });
  assert.equal(typeof request.runId, 'string');
  assert.equal(typeof request.label, 'string');
  assert.ok(!/\bundefined\b/i.test(request.reason), 'в причине разрешения нет «undefined»');
  const result = events.find((e) => e.type === 'tool_result');
  assert.equal(result.status, 'failed');
  assert.equal(result.verifiedStatus, null, 'проверки не было: null, а не успех');
  assert.equal(result.decision, 'reject');
  assert.equal(lastDone(events).status, 'failed');
  assert.equal(lastDone(events).verification.failed, 1);
  assert.equal(readJsonl(path.join(dir, 'journal.jsonl'))[0].decision, 'reject');
});

test('тайм-аут подтверждения: действие не выполняется и помечено отказом', async (t) => {
  const dir = setup(t);
  const events = [];
  let runs = 0;
  const agent = new Agent({
    brain: scriptedBrain([
      { toolCalls: [{ id: 'w1', name: 'write', args: {} }] },
      { content: 'понял' },
    ]),
    // Автоотказа по умолчанию нет; тайм-аут задан явно — решение всё равно reject, а не «разрешить».
    tools: registry(tool('write', 'T2', async () => { runs += 1; return { ok: true, summary: 'записано' }; })),
    approvals: new ApprovalBroker({ timeoutMs: 40 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'auto',
    workspace: dir,
  });
  await agent.run('запиши');

  assert.equal(runs, 0);
  assert.equal(readJsonl(path.join(dir, 'journal.jsonl'))[0].decision, 'reject');
  assert.equal(events.find((e) => e.type === 'tool_result').status, 'failed');
});

test('stop во время шага: итог cancelled, поздний ответ инструмента не воскрешает запуск', async (t) => {
  const dir = setup(t);
  const events = [];
  const stop = new StopSwitch();
  let agent = null;
  const slow = tool('slow', 'T1', async () => {
    // Инструмент отвечает уже после остановки, как настоящий внешний вызов.
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { ok: true, summary: 'поздний успех' };
  });
  agent = new Agent({
    brain: scriptedBrain([{ toolCalls: [{ id: 's1', name: 'slow', args: { path: 'notes/a.md' } }] }]),
    tools: registry(slow),
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      events.push(e);
      if (e.type === 'tool_start') setTimeout(() => { stop.trigger('тест'); agent.stop(); }, 0);
    },
    mode: 'full',
    workspace: dir,
    stop,
  });
  const result = await agent.run('сделай');

  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'stopped');
  const dones = events.filter((e) => e.type === 'done');
  assert.equal(dones.length, 1, 'ровно один итог запуска');
  assert.equal(dones[0].status, 'cancelled');
  assert.equal(dones[0].outcome, 'stopped');
  assert.equal(dones[0].cancelled, true, 'явный признак отмены для окна');
  // После done допустим только idle: поздний tool_result в окно не идёт.
  const doneIndex = events.indexOf(dones[0]);
  assert.deepEqual(events.slice(doneIndex + 1).map((e) => e.type + ':' + (e.state || '')), ['status:idle']);
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 0, 'поздний успех не показан как шаг');
  // В истории вызов записан как остановленный, а не как успех.
  const [entry] = readJsonl(path.join(dir, 'journal.jsonl'));
  assert.equal(entry.decision, 'stop');
  assert.equal(entry.ok, false);
  assert.equal(entry.runId, dones[0].runId);
});

test('поздний stop после конца хода не шлёт второй done', async (t) => {
  const dir = setup(t);
  const events = [];
  const agent = new Agent({
    brain: scriptedBrain([{ content: 'ответ' }]),
    tools: registry(),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'auto',
    workspace: dir,
  });
  await agent.run('привет');
  const before = events.slice();
  agent.stop();
  agent.stop();
  assert.deepEqual(events, before, 'после завершённого хода stop молчит');
});

test('поздний ответ модели после stop не даёт текста и не меняет итог', async (t) => {
  const dir = setup(t);
  const events = [];
  let release = null;
  const brain = {
    chat({ signal }) {
      return new Promise((resolve) => {
        release = resolve;
        signal.addEventListener('abort', () => resolve({ content: 'поздний ответ', toolCalls: [] }), { once: true });
      });
    },
  };
  const agent = new Agent({
    brain,
    tools: registry(),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'auto',
    workspace: dir,
  });
  const pending = agent.run('долгий ход');
  await new Promise((resolve) => setTimeout(resolve, 10));
  agent.stop();
  release({ content: 'поздний ответ', toolCalls: [] });
  await pending;

  const done = lastDone(events);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.cancelled, true);
  assert.equal(events.filter((e) => e.type === 'text').length, 0, 'позднего текста в окне нет');
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
});

test('ошибка хода: error и done несут runId, итог failed', async (t) => {
  const dir = setup(t);
  const events = [];
  const agent = new Agent({
    brain: { async chat() { throw new Error('сеть недоступна'); } },
    tools: registry(),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'auto',
    workspace: dir,
  });
  await agent.run('привет');

  const error = events.find((e) => e.type === 'error');
  const done = lastDone(events);
  assert.equal(typeof error.runId, 'string');
  assert.equal(error.status, 'failed');
  assert.equal(done.status, 'failed');
  assert.equal(done.outcome, 'error');
  assert.equal(done.runId, error.runId);
});

test('безопасная цель и описание не содержат секретов и сырых аргументов', async (t) => {
  const dir = setup(t);
  const events = [];
  const secret = 'sk-live-abcdefghijklmnop';
  const agent = new Agent({
    brain: scriptedBrain([
      { toolCalls: [{ id: 's1', name: 'workspace_write', args: { path: 'notes/a.md', content: 'x', text: 'пароль hunter2', command: `curl ${secret}`, password: secret } }] },
      { content: 'готово' },
    ]),
    tools: registry(tool('workspace_write', 'T1', async () => ({ ok: true, summary: 'записано', data: {} }))),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'full',
    workspace: dir,
  });
  await agent.run('запиши');
  const done = lastDone(events);
  // Поля прогресса — только безопасные: цель из белого списка, описание — фиксированные слова.
  assert.deepEqual(events.find((e) => e.type === 'tool_start').target, { path: 'notes/a.md' });
  const safe = JSON.stringify({
    target: events.find((e) => e.type === 'tool_start').target,
    label: events.find((e) => e.type === 'tool_start').label,
    done: done,
  });
  assert.ok(!safe.includes('hunter2'), 'текст не попадает в прогресс');
  assert.ok(!safe.includes(secret), 'ключ не попадает в прогресс');
  // Сводка шагов в done не несёт ни аргументов, ни текстов.
  for (const call of done.history) {
    assert.deepEqual(Object.keys(call).sort(), ['callId', 'decision', 'risk', 'status', 'step', 'tool', 'verified']);
  }
});

test('safeTarget: белый список полей, обрезка длинных значений, мусор не ломает', () => {
  assert.deepEqual(safeTarget({ path: 'a', url: 'https://x', text: 'секрет', command: 'rm -rf /' }), { path: 'a', url: 'https://x' });
  assert.equal(safeTarget(null), undefined);
  assert.equal(safeTarget('строка'), undefined);
  assert.equal(safeTarget({}), undefined);
  assert.equal(safeTarget({ minutes: 5 }).minutes, 5);
  assert.ok(safeTarget({ path: 'x'.repeat(500) }).path.length <= 120);
});

test('контракт статусов: в множестве ровно ожидаемые значения', () => {
  assert.deepEqual([...PROGRESS_STATUSES].sort(), [
    'awaiting_approval', 'cancelled', 'failed', 'planning', 'running', 'succeeded', 'unverified', 'verifying',
  ]);
});
