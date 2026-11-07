'use strict';

// Перезапуск приложения: незавершённые задачи с мандатом (выполнялась, ждала подтверждения, стояла в очереди)
// после перезапуска — на паузе с понятной причиной. Старая очередь сама не запускается, новое поручение C
// запускает только C; старую задачу продолжает только владелец (task_resume с подтверждением).
// Сборка (createRuntime) на временных файлах, настоящие инструменты песочницы, модель подставная.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../src/tasks/model');
const { recoverAfterRestart, RESTART_QUEUED_REASON, RESTART_RUNNING_REASON } = require('../src/tasks/queue');
const { createRuntime } = require('../src/tasks/runtime');
const { readTasks } = require('../src/tasks/store');
const { StopSwitch } = require('../src/control/stop');
const { ApprovalBroker } = require('../src/policy/approvals');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const NOW = Date.UTC(2026, 9, 31, 9, 0);
const USAGE = Object.freeze({ promptTokens: 800, cachedTokens: 200, completionTokens: 100, reasoningTokens: 0 });
const A_GOAL = 'Записать notes/a.md';
const B_GOAL = 'Записать notes/b.md';
const C_GOAL = 'Записать notes/c.md';

const planFor = (file, goal) => ({
  toolCalls: [{
    name: 'task_plan_submit',
    args: {
      steps: [{ title: `Записать ${file}`, check: { kind: 'file_exists', path: file } }],
      criteria: [{ requirement: goal, text: `есть ${file}`, check: { kind: 'file_exists', path: file } }],
    },
  }],
});
const writeAndDone = (file) => ({
  toolCalls: [{ name: 'workspace_write', args: { path: file, content: 'чай' } }, { name: 'step_done', args: { summary: 'записано' } }],
});

async function waitFor(cond, what) {
  for (let i = 0; i < 1000; i += 1) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`не дождались: ${what}`);
}

// Подставная модель: ответ по сценарию (или функция), после ответа — onUsage, как у DeepSeekClient.
function scriptedBrain(script) {
  const brain = {
    requests: [],
    async chat(args) {
      const i = brain.requests.length;
      brain.requests.push({ purpose: args.purpose, taskId: args.taskId });
      let step = i < script.length ? script[i] : new Error('сценарий модели исчерпан');
      if (typeof step === 'function') step = await step(args);
      const fine = !(step instanceof Error);
      args.onUsage({ model: MODEL, purpose: args.purpose, ok: fine, usage: fine ? { ...USAGE } : null, requestChars: 10, attempts: 1 });
      if (!fine) throw step;
      return {
        content: '',
        reasoningContent: null,
        toolCalls: (step.toolCalls || []).map((c, k) => ({ id: `c${i}_${k}`, name: c.name, args: c.args, argsError: null })),
        stats: { ...USAGE },
      };
    },
  };
  return brain;
}

// Сборка как в main.js на файлах base/data; владелец отвечает «один раз» на мандат и возобновление.
function build(t, base, brain) {
  const root = path.join(base, 'workspace');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  const index = new WorkspaceIndex(root);
  const resolve = (rel) => index.resolveInside(rel);
  const real = workspaceTools(index);
  const broker = new ApprovalBroker();
  const events = [];
  const files = { tasks: path.join(base, 'data', 'tasks.json'), budget: path.join(base, 'data', 'budget.json') };
  const runtime = createRuntime({
    brain,
    model: MODEL,
    tasksFile: files.tasks,
    budgetFile: files.budget,
    sandboxRoot: root,
    reportsDir: 'reports',
    dailyLimitUsd: 1,
    toolRegistry: { get: (name) => real.find((x) => x.name === name), list: () => real.slice() },
    approvals: broker,
    stop: new StopSwitch(),
    emit: (ev) => {
      events.push(ev);
      if (ev.type === 'approval_request' && /^(mandate|resume):/.test(String(ev.id))) broker.respond(ev.id, 'once');
    },
    resolve,
    now: () => NOW,
  });
  t.after(() => runtime.close());
  return { root, files, runtime, events, task: (id) => runtime.queue.get(id) };
}

test('recoverAfterRestart: running и waiting_approval — на паузе; queued с мандатом — на паузе; queued без мандата, paused и итоговые — как были', () => {
  const mandate = { goal: 'g', tools: [], folders: [], approvedBy: 'owner' };
  const queued = (id, m) => model.transition(model.setPlan(model.createTask({ id, title: id, now: NOW, mandate: m }), [{ title: 'x' }]), 'queued');
  const running = model.transition(queued('r', mandate), 'running');
  const waiting = model.transition(running, 'waiting_approval');
  const paused = model.transition(queued('p', mandate), 'paused', { reason: 'аварийный стоп: задача в очереди ждёт вашего решения' });
  const list = [running, { ...waiting, id: 'w' }, queued('qm', mandate), queued('qc', null), paused];
  const after = recoverAfterRestart(list, { now: NOW + 1 });
  assert.deepEqual(after.map((t) => [t.id, t.status, t.reason]), [
    ['r', 'paused', RESTART_RUNNING_REASON],
    ['w', 'paused', RESTART_RUNNING_REASON],
    ['qm', 'paused', 'перезапуск приложения: задача в очереди ждёт вашего решения'],
    ['qc', 'queued', null],
    ['p', 'paused', 'аварийный стоп: задача в очереди ждёт вашего решения'],
  ]);
  assert.equal(RESTART_QUEUED_REASON, 'перезапуск приложения: задача в очереди ждёт вашего решения');
  assert.equal(after[2].log.at(-1).reason, RESTART_QUEUED_REASON, 'причина — в журнале задачи');
});

test('перезапуск: B из очереди на паузе и не стартует; новое поручение C запускает только C; B — только по task_resume', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-restart-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  // Первый процесс: A выполняется (ответ модели на шаг «в полёте»), B стоит в очереди. Процесс завершился.
  let hung = false;
  const first = build(t, base, scriptedBrain([planFor('notes/a.md', A_GOAL), () => { hung = true; return new Promise(() => {}); }]));
  const a = (await first.runtime.submitTask({ goal: A_GOAL })).data.id;
  await waitFor(() => hung, 'шаг A ждёт модель');
  const b = (await first.runtime.submitTask({ goal: B_GOAL })).data.id;
  assert.equal(first.task(b).status, 'queued', 'B ждёт: исполнитель занят A');
  const onDisk = Object.fromEntries(readTasks(first.files.tasks).map((x) => [x.id, x.status]));
  assert.deepEqual([onDisk[a], onDisk[b]], ['running', 'queued'], 'на диске: A выполняется, B в очереди');
  first.runtime.close();

  // Перезапуск: новая сборка на тех же файлах.
  const brain = scriptedBrain([
    planFor('notes/c.md', C_GOAL), writeAndDone('notes/c.md'),
    planFor('notes/b.md', B_GOAL), writeAndDone('notes/b.md'),
  ]);
  const second = build(t, base, brain);
  assert.deepEqual([second.task(a).status, second.task(a).reason], ['paused', RESTART_RUNNING_REASON]);
  assert.deepEqual([second.task(b).status, second.task(b).reason], ['paused', 'перезапуск приложения: задача в очереди ждёт вашего решения']);
  const saved = Object.fromEntries(readTasks(second.files.tasks).map((x) => [x.id, [x.status, x.reason]]));
  assert.deepEqual(saved[b], ['paused', RESTART_QUEUED_REASON], 'пауза сразу на диске');

  // Сама старая очередь не запускается: ни при сборке, ни при явном kick.
  assert.equal(second.runtime.executor.kick(), null);
  await second.runtime.whenIdle();
  assert.equal(brain.requests.length, 0, 'модель не вызвана');

  // Новое поручение C стартует только C.
  const c = await second.runtime.submitTask({ goal: C_GOAL });
  assert.equal(c.ok, true, c.summary);
  await second.runtime.whenIdle();
  assert.equal(second.task(c.data.id).status, 'done');
  assert.deepEqual(brain.requests.map((r) => r.taskId), [c.data.id, c.data.id], 'B и A не запускались');
  assert.deepEqual([second.task(a).status, second.task(b).status], ['paused', 'paused']);
  assert.equal(fs.existsSync(path.join(second.root, 'notes', 'b.md')), false);
  // Отчёт C: сводка стоимости из журнала (budget.json) — две попытки, данные полные.
  const report = fs.readFileSync(path.join(second.root, 'reports', `task-${c.data.id}.md`), 'utf8');
  assert.match(report, /## Стоимость по журналу учёта\n\n- Стоимость \(USD, счёт задачи в журнале\): \$0\.\d+\n- Попыток вызова модели: 2\n- Расход известен точно: да\n- Данные: полные/);

  // B продолжает только явное действие владельца: task_resume с подтверждением.
  const resumed = await second.runtime.chatTools.find((x) => x.name === 'task_resume').run({ id: b }, {});
  assert.equal(resumed.ok, true, resumed.summary);
  assert.equal(second.events.filter((e) => e.type === 'approval_request' && String(e.id).startsWith(`resume:${b}:`)).length, 1, 'владельца спросили');
  await second.runtime.whenIdle();
  assert.equal(second.task(b).status, 'done');
  assert.deepEqual(brain.requests.slice(2).map((r) => r.taskId), [b, b]);
  assert.equal(second.task(a).status, 'paused', 'A без своего возобновления осталась на паузе');
});
