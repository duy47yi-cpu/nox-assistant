'use strict';

// Живой путь задачи с кодом, собранный так же, как main.js: настоящий брокер подтверждений (src/policy/approvals.js),
// createRuntime (src/tasks/runtime.js) с реестром задач как в main.js (taskToolRegistry: инструменты чата + codeTools
// с base = корень песочницы и roots = папки мандата задачи, denyDirs = data), инструменты задач для чата
// регистрируются в реестре чата (как runtime.chatTools в main.js), emit — как emitToWindow (link.js для approval_request).
// Владелец отвечает через брокер, как окно через IPC approval:respond. Модель подставная, реальная не вызывается.
// Песочница — временная папка os.tmpdir(); workspace и data владельца не трогаются.
//
// Регресс живого прогона tmvw15xsl6caf27: code_write с путём «jarvis-acceptance/code-test/calculator.py» писал файл
// в <папка мандата>\jarvis-acceptance\code-test\calculator.py (база — папка мандата), проверка шага file_exists
// (база — корень песочницы) файла не находила; на каждый code_write и code_edit спрашивалось подтверждение.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntime } = require('../src/tasks/runtime');
const { codeTools } = require('../src/tools/code');
const { ToolRegistry } = require('../src/tools/registry');
const { workspaceTools } = require('../src/tools/workspace');
const { webTools } = require('../src/tools/web');
const { WorkspaceIndex } = require('../src/rag/index');
const { ApprovalBroker } = require('../src/policy/approvals');
const { StopSwitch } = require('../src/control/stop');
const { requestedApproval, resolvedApproval } = require('../src/tasks/link');

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const NOW = Date.UTC(2026, 9, 31, 9, 0);
const USAGE = Object.freeze({ promptTokens: 800, cachedTokens: 200, completionTokens: 100, reasoningTokens: 0 });
const CODE_DIR = 'jarvis-acceptance/code-test';
// Путь так, как его пишет модель в живом прогоне: от корня песочницы.
const FILE = `${CODE_DIR}/calculator.py`;
const DRAFT = 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a + b\n';
const FINAL = 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n';
const MANDATE = 'мандат задачи';

const SUBMIT = Object.freeze({
  goal: `Создать ${FILE} с функциями add и sub, затем исправить sub, чтобы она вычитала`,
  title: `calculator.py + тесты (${CODE_DIR})`,
  tools: ['workspace_list', 'code_read', 'code_write', 'code_edit'],
  folders: [CODE_DIR],
  expiresInHours: 2,
  budgetUsd: 0.05,
});

const PLAN = {
  steps: [
    { title: `Создать ${FILE}`, check: { kind: 'file_exists', path: FILE } },
    { title: 'Исправить sub: вычитание', check: { kind: 'file_contains', path: FILE, text: 'return a - b' } },
    { title: 'Прочитать результат', kind: 'observation' },
  ],
  criteria: [
    { requirement: 'файл calculator.py', text: 'файл создан', check: { kind: 'file_exists', path: FILE } },
    { requirement: 'sub вычитает', text: 'в файле return a - b', check: { kind: 'file_contains', path: FILE, text: 'return a - b' } },
  ],
};

const reply = (...calls) => ({ toolCalls: calls.map(([name, args]) => ({ name, args })) });
const HAPPY = [
  reply(['task_plan_submit', PLAN]),
  reply(['code_write', { path: FILE, content: DRAFT }]),
  reply(['step_done', { summary: 'calculator.py создан' }]),
  reply(['code_edit', { path: FILE, old_string: 'def sub(a, b):\n    return a + b', new_string: 'def sub(a, b):\n    return a - b' }]),
  reply(['step_done', { summary: 'sub исправлена' }]),
  reply(['code_read', { path: FILE }]),
  reply(['step_done', { summary: 'файл прочитан' }]),
];

function scriptedBrain(script) {
  const brain = {
    model: MODEL,
    requests: [],
    async chat(args) {
      const i = brain.requests.length;
      brain.requests.push({ purpose: args.purpose, messages: (args.messages || []).slice() });
      const step = i < script.length ? script[i] : new Error('сценарий модели исчерпан');
      const fine = !(step instanceof Error);
      args.onUsage({ model: MODEL, purpose: args.purpose, ok: fine, usage: fine ? { ...USAGE } : null, requestChars: 1, attempts: 1 });
      if (!fine) throw step;
      return {
        content: '',
        reasoningContent: null,
        toolCalls: (step.toolCalls || []).map((c, k) => ({ id: `c${i + 1}_${k}`, name: c.name, args: c.args ?? {}, argsError: null })),
        stats: { ...USAGE },
      };
    },
  };
  return brain;
}

async function waitFor(cond, what) {
  for (let i = 0; i < 2000; i += 1) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`не дождались: ${what}`);
}

// Сборка как в main.js. answer(ev) — решение владельца на approval_request (null — владелец не отвечает).
// askingWrite — проверка общего механизма подтверждения шага: code_write с пометкой requiresApproval: true
// (как было до правки политики), чтобы получить ожидающее подтверждение исполнителя.
function build(t, { script = HAPPY, answer = (ev) => (ev.name === MANDATE ? 'once' : null), askingWrite = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-code-live-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const WORKSPACE = path.join(base, 'workspace');
  const DATA_DIR = path.join(base, 'data');
  for (const dir of ['reports', CODE_DIR]) fs.mkdirSync(path.join(WORKSPACE, dir), { recursive: true });
  const workspaceIndex = new WorkspaceIndex(WORKSPACE);
  const h = { base, root: WORKSPACE, events: [], journal: [], asks: [], brain: scriptedBrain(script) };
  const approvals = new ApprovalBroker();
  h.approvals = approvals;

  // Реестр чата (как tools в main.js): инструменты песочницы и интернета; code_* в чат не попадают.
  const tools = new ToolRegistry();
  for (const tool of [...workspaceTools(workspaceIndex), ...webTools()]) tools.register(tool);
  // Код песочницы — как taskCodeTools в main.js.
  let taskCodeTools = codeTools({
    base: WORKSPACE,
    roots: (ctx) => {
      const task = ctx && ctx.taskId ? h.runtime.queue.get(ctx.taskId) : null;
      if (!task || !task.mandate) return [];
      return Array.isArray(task.mandate.folders) ? task.mandate.folders : [];
    },
    denyDirs: [DATA_DIR],
  });
  if (askingWrite) taskCodeTools = taskCodeTools.map((x) => (x.name === 'code_write' ? { ...x, requiresApproval: true } : x));
  const taskToolRegistry = {
    get: (name) => tools.get(name) || taskCodeTools.find((x) => x.name === name) || null,
    list: () => [...tools.list(), ...taskCodeTools],
  };
  h.tools = tools;

  // emit — как emitToWindow: задачи чата «ждут подтверждения» через link.js; окно отвечает позже, через IPC.
  function emitToWindow(event) {
    h.events.push(event);
    if (event.type === 'approval_request') {
      if (requestedApproval(h.runtime.queue)) h.runtime.saveTasks(h.runtime.queue.list());
      h.asks.push(event);
      const decision = answer(event);
      if (decision) {
        setImmediate(() => {
          const ok = approvals.respond(event.id, decision);
          if (ok && resolvedApproval(h.runtime.queue)) h.runtime.saveTasks(h.runtime.queue.list());
        });
      }
    }
  }

  h.runtime = createRuntime({
    brain: h.brain,
    model: MODEL,
    tasksFile: path.join(DATA_DIR, 'tasks.json'),
    budgetFile: path.join(DATA_DIR, 'budget.json'),
    sandboxRoot: WORKSPACE,
    reportsDir: 'reports',
    dailyLimitUsd: 1,
    toolRegistry: taskToolRegistry,
    approvals,
    stop: new StopSwitch(),
    journal: { append: (e) => h.journal.push(e) },
    emit: emitToWindow,
    resolve: (rel) => workspaceIndex.resolveInside(rel),
    now: () => NOW,
  });
  t.after(() => h.runtime.close());
  // Инструменты задач — в реестре чата, как в main.js (там ещё обёртка withExecutorKick для task_step и task_verify).
  for (const tool of h.runtime.chatTools) tools.register(tool);
  // Модель поручает задачу инструментом чата task_submit.
  h.submit = (args) => tools.get('task_submit').run(args, {});
  h.decisions = (tool) => h.journal.filter((e) => e.tool === tool).map((e) => e.decision);
  h.closed = () => h.events.filter((e) => e.type === 'approval_closed');
  return h;
}

test('живой путь: task_submit → «один раз» → code_write по пути от песочницы без второго вопроса → file_exists проходит → code_edit → code_read', { timeout: 15000 }, async (t) => {
  const h = build(t);
  assert.equal(h.tools.get('code_write'), undefined, 'code_* в чате не регистрируются');
  const res = await h.submit({ ...SUBMIT });
  assert.equal(res.ok, true, res.summary);
  await h.runtime.whenIdle();
  const task = h.runtime.queue.get(res.data.id);

  // Файл — ровно там, где его ищет проверка шага: <песочница>\jarvis-acceptance\code-test\calculator.py.
  const onDisk = path.join(h.root, 'jarvis-acceptance', 'code-test', 'calculator.py');
  assert.equal(fs.readFileSync(onDisk, 'utf8'), FINAL);
  // Вложенной папки (база — папка мандата) нет.
  assert.equal(fs.existsSync(path.join(h.root, 'jarvis-acceptance', 'code-test', 'jarvis-acceptance')), false, 'вложенной jarvis-acceptance нет');

  // Подтверждение спрашивалось один раз — на мандат (task_submit), не на каждый шаг.
  assert.deepEqual(h.asks.map((a) => a.name), [MANDATE]);
  assert.deepEqual(h.decisions('code_write'), ['allow']);
  assert.deepEqual(h.decisions('code_edit'), ['allow']);
  assert.deepEqual(h.decisions('code_read'), ['allow']);
  assert.ok(!h.journal.some((e) => e.decision === 'ask'), 'вопросов на шагах нет');

  // Проверка шага file_exists по тому же пути прошла; шаги — без неудач.
  assert.deepEqual(task.plan.map((s) => [s.status, s.result.verification]), [
    ['done', 'confirmed'], ['done', 'confirmed'], ['done', 'not_applicable'],
  ]);
  assert.deepEqual(task.failures, {});
  assert.ok(!h.journal.some((e) => e.decision === 'step_failed'), JSON.stringify(h.journal.filter((e) => e.decision === 'step_failed')));
  assert.equal(task.status, 'done');
  assert.deepEqual(task.criteria.map((c) => c.result.verification), ['confirmed', 'confirmed']);

  // Ответы инструментов — с путём от песочницы; code_read вернул исправленное содержимое.
  const summaries = h.journal.filter((e) => /^code_/.test(e.tool)).map((e) => e.summary);
  assert.equal(summaries[0], `создан ${FILE}: ${Buffer.byteLength(DRAFT)} байт, строк 6`);
  assert.match(summaries[1], new RegExp(`^изменён ${FILE}: 1 замена`));
  assert.equal(summaries[2], `${FILE}: прочитано ${Buffer.byteLength(FINAL)} байт, строк 6`);
  const afterRead = h.brain.requests[h.brain.requests.length - 1].messages.filter((m) => m.role === 'tool');
  assert.ok(afterRead.some((m) => String(m.content).includes('return a - b')), 'code_read передал модели содержимое файла');

  // Окно: запрос мандата закрыт событием approval_closed, ожидающих подтверждений нет.
  assert.deepEqual(h.approvals.list(), []);
  assert.deepEqual(h.closed().map((e) => [e.id, e.decision, e.cancelled]), [[h.asks[0].id, 'once', false]]);
});

// Ожидающее подтверждение шага исполнителя (code_write с пометкой requiresApproval: true).
const ONE_STEP = {
  steps: [{ title: `Создать ${FILE}`, check: { kind: 'file_exists', path: FILE } }],
  criteria: [{ requirement: 'файл calculator.py', text: 'файл создан', check: { kind: 'file_exists', path: FILE } }],
};

async function pendingWrite(t, after = []) {
  const script = [reply(['task_plan_submit', ONE_STEP]), reply(['code_write', { path: FILE, content: DRAFT }]), ...after];
  const h = build(t, { askingWrite: true, script });
  const res = await h.submit({ ...SUBMIT });
  assert.equal(res.ok, true, res.summary);
  const id = res.data.id;
  await waitFor(() => h.approvals.list().some((a) => a.name === 'code_write'), 'подтверждение code_write');
  const ask = h.approvals.list().find((a) => a.name === 'code_write');
  assert.equal(h.runtime.queue.get(id).status, 'waiting_approval');
  return { h, id, ask };
}

function assertCancelled(h, id, ask, statusRe) {
  // Подтверждение отменено и из окна убрано (approval_closed с причиной).
  assert.deepEqual(h.approvals.list(), [], 'ожидающих подтверждений нет');
  const closed = h.closed().find((e) => e.id === ask.id);
  assert.ok(closed, 'окну отправлено approval_closed');
  assert.equal(closed.cancelled, true);
  assert.match(closed.reason, statusRe);
  // Старое подтверждение использовать нельзя: ответ — отказ с понятной причиной.
  assert.equal(h.approvals.respond(ask.id, 'once'), false);
  assert.match(h.approvals.closedReason(ask.id), statusRe);
  assert.match(h.runtime.approvals.closedReason(ask.id), /подтверждение больше не действует/);
  // Задача не продолжила запись.
  assert.equal(fs.existsSync(path.join(h.root, ...FILE.split('/'))), false, 'файл не записан');
  assert.ok(!h.journal.some((e) => e.tool === 'code_write' && e.ok === true), 'code_write не выполнялся');
  assert.ok(h.journal.some((e) => e.tool === 'code_write' && e.decision === 'stop' && /статус задачи изменился во время ожидания/.test(e.summary)));
  // Отменённое ожидание — не неудача шага.
  assert.deepEqual(h.runtime.queue.get(id).failures, {});
  assert.ok(!h.journal.some((e) => e.decision === 'step_failed'));
}

test('блокировка задачи при ожидающем подтверждении: подтверждение отменено, ответ на него — отказ с причиной, запись не продолжается', { timeout: 15000 }, async (t) => {
  const { h, id, ask } = await pendingWrite(t);
  // Задача уходит в «заблокирована», а её запрос ещё висит (как в живом прогоне). Прямого перехода из
  // «ждёт подтверждения» в blocked модель не допускает, поэтому — через «работает».
  h.runtime.queue.resolveApproval(id);
  h.runtime.queue.block(id, 'внешняя блокировка (тест)');
  await h.runtime.whenIdle();
  assertCancelled(h, id, ask, /заблокирована/);
  assert.equal(h.runtime.queue.get(id).status, 'blocked');
  // Поздний ответ «один раз» ничего не запускает.
  await h.runtime.whenIdle();
  assert.equal(fs.existsSync(path.join(h.root, ...FILE.split('/'))), false);
});

test('пауза задачи при ожидающем подтверждении: подтверждение отменено и недействительно', { timeout: 15000 }, async (t) => {
  const { h, id, ask } = await pendingWrite(t);
  h.runtime.queue.pause(id, 'пауза владельцем (тест)');
  await h.runtime.whenIdle();
  assertCancelled(h, id, ask, /на паузе/);
  assert.equal(h.runtime.queue.get(id).status, 'paused');
});

test('ожидание подтверждения шага — не неудача: пока ждём, счётчик неудач пуст; после «один раз» шаг выполнен и проверен', { timeout: 15000 }, async (t) => {
  const { h, id, ask } = await pendingWrite(t, [reply(['step_done', { summary: 'calculator.py создан' }])]);
  const waiting = h.runtime.queue.get(id);
  assert.deepEqual(waiting.failures, {}, 'ожидание не засчитано неудачей');
  assert.equal(waiting.plan[0].status, 'doing');
  assert.ok(!h.journal.some((e) => e.decision === 'step_failed'));
  // Владелец отвечает «один раз» (как окно через IPC approval:respond): шаг продолжается.
  assert.equal(h.approvals.respond(ask.id, 'once'), true);
  await h.runtime.whenIdle();
  assert.equal(fs.readFileSync(path.join(h.root, ...FILE.split('/')), 'utf8'), DRAFT, 'запись выполнена после подтверждения');
  assert.deepEqual(h.decisions('code_write'), ['ask', 'once']);
  const closed = h.closed().find((e) => e.id === ask.id);
  assert.deepEqual([closed.decision, closed.cancelled], ['once', false]);
  const task = h.runtime.queue.get(id);
  assert.deepEqual(task.failures, {});
  assert.ok(!h.journal.some((e) => e.decision === 'step_failed'));
  assert.deepEqual([task.plan[0].status, task.plan[0].result.verification, task.status], ['done', 'confirmed', 'done']);
});
