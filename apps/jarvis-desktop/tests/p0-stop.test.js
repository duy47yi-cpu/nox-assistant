'use strict';

// P0: глобальный стоп и корректное ожидание подтверждений.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StopSwitch } = require('../src/control/stop');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const { MissionScheduler } = require('../src/missions/scheduler');
const { runCommand } = require('../src/commands/runner');
const modes = require('../src/policy/modes');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p0-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scripted(steps) {
  let i = 0;
  const brain = {
    calls: 0,
    async chat() {
      brain.calls += 1;
      const s = steps[i++];
      if (!s) throw new Error('сценарий закончился');
      return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] };
    },
  };
  return brain;
}

function tool(name, risk, run) {
  return { name, risk, description: name, parameters: { type: 'object', properties: {} }, run };
}

function registry(...list) {
  const reg = new ToolRegistry();
  for (const t of list) reg.register(t);
  return reg;
}

test('StopSwitch: включается один раз, сообщает подписчикам, сбрасывается явно', () => {
  const stop = new StopSwitch();
  const seen = [];
  stop.onTrigger((e) => seen.push(e.reason));
  assert.equal(stop.isStopped(), false);
  assert.equal(stop.trigger('горячая клавиша'), true);
  assert.equal(stop.trigger('ещё раз'), false, 'повторное включение ничего не делает');
  assert.equal(stop.isStopped(), true);
  assert.deepEqual(seen, ['горячая клавиша']);
  stop.reset();
  assert.equal(stop.isStopped(), false);
});

test('стоп до хода: модель не вызывается, инструмент не запускается', async (t) => {
  const dir = setup(t);
  const stop = new StopSwitch();
  stop.trigger('тест');
  let ran = 0;
  const brain = scripted([{ toolCalls: [{ id: 'a', name: 'echo', args: {} }] }]);
  const agent = new Agent({
    brain,
    tools: registry(tool('echo', 'T0', async () => { ran += 1; return { ok: true, summary: 'ok' }; })),
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: () => {},
    mode: 'full',
    workspace: dir,
    stop,
  });
  await agent.run('сделай');
  assert.equal(brain.calls, 0, 'после стопа модель не вызываем');
  assert.equal(ran, 0, 'после стопа инструмент не запускаем');
});

test('стоп во время ожидания подтверждения: вызов отклонён, инструмент не выполнен, модель не вызвана снова', async (t) => {
  const dir = setup(t);
  const stop = new StopSwitch();
  const approvals = new ApprovalBroker({ timeoutMs: null });
  const events = [];
  let ran = 0;
  const brain = scripted([{ toolCalls: [{ id: 'w1', name: 'wipe', args: { path: 'notes/a.md' } }] }]);
  const agent = new Agent({
    brain,
    tools: registry(tool('wipe', 'T2', async () => { ran += 1; return { ok: true, summary: 'стёрто' }; })),
    approvals,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_request') {
        // Владелец нажимает «Стоп», не отвечая на подтверждение.
        setTimeout(() => {
          stop.trigger('тест');
          agent.stop();
          approvals.cancelAll('стоп');
        }, 10);
      }
    },
    mode: 'auto',
    workspace: dir,
    stop,
  });
  await agent.run('сотри');
  assert.equal(ran, 0);
  assert.equal(brain.calls, 1, 'пока ждём подтверждение, модель не дёргаем');
  assert.ok(events.some((e) => e.type === 'approval_request'));
  assert.equal(approvals.list().length, 0, 'ожидания очищены');
});

test('миссии: при стопе новые задачи не запускаются', async () => {
  const stop = new StopSwitch();
  const ran = [];
  const store = {
    due: () => [{ id: 'm1' }, { id: 'm2' }],
    markStart() {},
    markRun() {},
  };
  const scheduler = new MissionScheduler({
    store,
    run: async (m) => {
      ran.push(m.id);
      if (m.id === 'm1') stop.trigger('тест'); // стоп прилетает во время первой задачи
      return { report: 'готово', file: null };
    },
    notify: () => {},
    stop,
  });
  const done = await scheduler.tick();
  assert.deepEqual(ran, ['m1'], 'вторая задача не стартует после стопа');
  assert.equal(done, 1);
  assert.equal(await scheduler.tick(), 0, 'пока стоп включён, тик ничего не делает');
});

test('команда-ярлык: после стопа следующий шаг не выполняется', async () => {
  const stop = new StopSwitch();
  const calls = [];
  const cmd = {
    id: 'c1',
    name: 'Тест',
    steps: [{ tool: 'a', args: {} }, { tool: 'b', args: {} }],
  };
  const tools = {
    get: (name) => ({
      name,
      risk: 'T0',
      run: async () => {
        calls.push(name);
        stop.trigger('тест');
        return { ok: true, summary: name };
      },
    }),
  };
  const out = await runCommand(cmd, {
    tools,
    policy: modes,
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: { append() {} },
    emit: () => {},
    mode: 'full',
    stop,
  });
  assert.deepEqual(calls, ['a'], 'второй шаг не запускается после стопа');
  assert.equal(out.ok, false);
});

test('подтверждение без автоотказа: по умолчанию таймаута нет', async () => {
  const broker = new ApprovalBroker();
  assert.equal(broker.timeoutMs, null);
  const p = broker.request({ id: 'x1', name: 'shell_run' });
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, 'решения ещё нет — и отказа тоже');
  assert.deepEqual(broker.list().map((e) => e.id), ['x1']);
  assert.equal(broker.respond('x1', 'once'), true);
  assert.equal(await p, 'once');
});

test('cancelAll отклоняет все ожидающие подтверждения', async () => {
  const broker = new ApprovalBroker({ timeoutMs: null });
  const a = broker.request({ id: 'a', name: 'ui_click' });
  const b = broker.request({ id: 'b', name: 'shell_run' });
  assert.equal(broker.cancelAll('стоп'), 2);
  assert.equal(await a, 'reject');
  assert.equal(await b, 'reject');
  assert.equal(broker.list().length, 0);
});

test('миссия, прерванная стопом, не запускается сама после возобновления', async () => {
  const stop = new StopSwitch();
  const ran = [];
  const marked = new Set();
  const store = {
    due: () => [{ id: 'm1' }, { id: 'm2' }].filter((m) => !marked.has(m.id)),
    markStart() {},
    markRun(id) { marked.add(id); },
  };
  const scheduler = new MissionScheduler({
    store,
    run: async (m) => {
      ran.push(m.id);
      if (m.id === 'm1') stop.trigger('тест'); // стоп прилетает во время первой задачи
      return { report: 'часть отчёта', file: null };
    },
    notify: () => {},
    stop,
  });
  await scheduler.tick();
  assert.deepEqual(ran, ['m1']);
  stop.reset();
  await scheduler.tick();
  assert.deepEqual(ran, ['m1', 'm2'], 'прерванная m1 не повторяется, m2 идёт в обычном порядке');
});
