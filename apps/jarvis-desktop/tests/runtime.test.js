'use strict';

// Сборка автономных задач (src/tasks/runtime.js) целиком: поручение с мандатом → подтверждение владельца →
// исполнитель → проверка → отчёт, вместе с настоящими стражем бюджета, учётом стоимости, очередью, стопом
// и брокером подтверждений. Модель подставная: ответы по сценарию, и после каждого ответа — onUsage с usage,
// как у DeepSeekClient, поэтому страж учитывает расход. Файлы данных и песочница — во временной папке теста.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntime } = require('../src/tasks/runtime');
const { readTasks } = require('../src/tasks/store');
const { summarize } = require('../src/tasks/mandate');
const { costOf, REASON_CORRUPT } = require('../src/cost/meter');
const { priceFor } = require('../src/cost/prices');
const { StopSwitch } = require('../src/control/stop');
const { ApprovalBroker } = require('../src/policy/approvals');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const NOW = Date.UTC(2026, 9, 30, 9, 0);
const HOUR = 60 * 60 * 1000;
const GOAL = 'Собрать заметку о чае в notes/tea.md и сводку в reports/tea.md';
const USAGE = Object.freeze({ promptTokens: 800, cachedTokens: 200, completionTokens: 100, reasoningTokens: 0 });
const CALL_USD = costOf(USAGE, priceFor(MODEL)); // стоимость одного ответа подставной модели по prices.js
const TEA_PLAN = [
  { title: 'Записать заметку о чае', check: { kind: 'file_contains', path: 'notes/tea.md', text: 'улун' } },
  { title: 'Записать сводку', check: { kind: 'file_exists', path: 'reports/tea.md' } },
];

const planReply = (steps) => ({ toolCalls: [{ name: 'task_plan_submit', args: { steps } }] });
const toolReply = (...calls) => ({ toolCalls: calls.map(([name, args]) => ({ name, args })) });
const doneReply = (summary = 'готово') => toolReply(['step_done', { summary }]);

function near(actual, expected, what = 'сумма') {
  assert.equal(typeof actual, 'number', `${what}: ожидалось число, получено ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-12, `${what}: ${actual} ≠ ${expected}`);
}

async function waitFor(cond, what) {
  for (let i = 0; i < 1000; i += 1) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`не дождались: ${what}`);
}

async function ticks(n = 20) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

// Своя уникальная временная папка на каждый тест: чужие файлы не задеваются.
function tmpBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function makeClock(start = NOW) {
  let ms = start;
  return { now: () => ms, advance: (d) => { ms += d; } };
}

// Ответ модели, который придёт, когда тест вызовет release(ответ). Пока не пришёл — запрос «в полёте».
function deferred() {
  const d = { req: null, release: null };
  d.step = (req) => new Promise((resolve) => {
    d.req = req;
    d.release = resolve;
  });
  return d;
}

// Этап 3: новый план обязан содержать критерии приёмки. Сценарии, написанные до этого, их не передают —
// подставная модель добавляет их сама (если ключа criteria в ответе нет): требование — цель задачи целиком
// (из запроса плана), по критерию на каждую проверку шага, кроме file_absent (это предусловие «файла ещё нет»,
// а не результат); без проверок — один критерий «оценка модели». Итоги старых сценариев от этого не меняются.
function planGoal(messages) {
  const ask = (messages || []).find((m) => m.role === 'user' && /^Составь план для цели: /.test(String(m.content)));
  return ask ? String(ask.content).replace(/^Составь план для цели: /, '') : '';
}

function autoCriteria(steps, goal) {
  const checks = (Array.isArray(steps) ? steps : []).filter((s) => s && s.check && s.check.kind !== 'file_absent');
  if (!checks.length) return [{ requirement: goal, text: 'итог по словам модели', manual: { kind: 'model_only', reason: 'объективной проверки в сценарии нет' } }];
  return checks.map((s) => ({ requirement: goal, text: String(s.title), check: s.check }));
}

function withCriteria(reply, messages) {
  if (!reply || !Array.isArray(reply.toolCalls)) return reply;
  return {
    ...reply,
    toolCalls: reply.toolCalls.map((c) => (c.name === 'task_plan_submit' && c.args && typeof c.args === 'object' && !('criteria' in c.args)
      ? { ...c, args: { ...c.args, criteria: autoCriteria(c.args.steps, planGoal(messages)) } }
      : c)),
  };
}

// Подставная модель. Элемент сценария — ответ {content?, toolCalls?}, ошибка или функция (req) → ответ.
// После «ответа» сообщает onUsage о попытке с usage, как DeepSeekClient.
function scriptedBrain(script) {
  const brain = {
    model: MODEL,
    calls: 0,
    requests: [],
    async chat(args) {
      brain.calls += 1;
      const i = brain.calls - 1;
      brain.requests.push({
        purpose: args.purpose,
        taskId: args.taskId,
        maxTokens: args.maxTokens,
        taskBudgetUsd: args.taskBudgetUsd,
        hasOnUsage: typeof args.onUsage === 'function',
        tools: (args.tools || []).map((x) => x.function.name),
        messages: (args.messages || []).slice(),
        signal: args.signal,
      });
      let step = i < script.length ? script[i] : new Error('сценарий модели исчерпан');
      if (typeof step === 'function') step = await step(args);
      const fine = !(step instanceof Error);
      args.onUsage({
        model: MODEL,
        purpose: args.purpose,
        ok: fine,
        usage: fine ? { ...USAGE } : null,
        requestChars: JSON.stringify(args.messages || []).length,
        attempts: 1,
      });
      if (!fine) throw step;
      step = withCriteria(step, args.messages);
      return {
        content: step.content || '',
        reasoningContent: null,
        toolCalls: (step.toolCalls || []).map((c, k) => ({ id: c.id || `c${i + 1}_${k}`, name: c.name, args: c.args ?? {}, argsError: null })),
        stats: { ...USAGE },
      };
    },
  };
  return brain;
}

// Инструменты обычного чата (подделка): workspace_write пишет в песочницу через resolve; shell_run, web_fetch
// и web_search — заглушки, которые только запоминают вызов. Сети нет. web_search помечен requiresApproval:
// только такой инструмент исполнитель запускает после подтверждения владельца (workspace_write не помечен).
function fakeRegistry(resolve) {
  const calls = [];
  const tools = [
    {
      name: 'workspace_write',
      risk: 'T1',
      description: 'Записать .md или .txt файл в песочницу.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      async run(args, ctx) {
        calls.push({ name: 'workspace_write', args, ctx });
        const abs = resolve(String(args.path).trim());
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(args.content), 'utf8');
        return { ok: true, summary: 'записал', data: { path: args.path } };
      },
    },
    {
      name: 'shell_run',
      risk: 'T2',
      description: 'Команда PowerShell.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      async run(args, ctx) {
        calls.push({ name: 'shell_run', args, ctx });
        return { ok: true, summary: 'выполнено' };
      },
    },
    {
      name: 'web_fetch',
      risk: 'T0',
      description: 'Прочитать веб-страницу (заглушка без сети).',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      async run(args, ctx) {
        calls.push({ name: 'web_fetch', args, ctx });
        return { ok: true, summary: 'страница (заглушка)', data: { text: 'чай' } };
      },
    },
    {
      name: 'web_search',
      risk: 'T1',
      requiresApproval: true,
      description: 'Поиск в интернете (заглушка без сети; каждый вызов — с подтверждения владельца).',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async run(args, ctx) {
        calls.push({ name: 'web_search', args, ctx });
        return { ok: true, summary: 'найдено (заглушка)', data: { text: 'улун' } };
      },
    },
  ];
  return {
    calls,
    names: () => calls.map((c) => c.name),
    get: (name) => tools.find((x) => x.name === name),
    list: () => tools.slice(),
  };
}

// Ответ владельца только на запросы сборки (мандат, возобновление); перезапись файла исполнителем ждёт теста.
const ownerSays = (decision) => (ev) => (/^(mandate|resume):/.test(String(ev.id)) ? decision : null);

// Сборка как в main.js, но на временных файлах. h.answer(ev) — ответ владельца на запрос подтверждения
// ('once', 'reject', …) или null: тогда запрос ждёт, пока тест не ответит сам.
function build(t, opts = {}) {
  const base = opts.base || tmpBase(t);
  const root = path.join(base, 'workspace');
  for (const dir of ['notes', 'reports']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const index = new WorkspaceIndex(root);
  const resolve = (rel) => index.resolveInside(rel);
  const clock = opts.clock || makeClock();
  const brain = opts.brain || scriptedBrain(opts.script || []);
  // opts.tools(index) — настоящие инструменты песочницы вместо подставных (сценарий с реальной файловой системой).
  let registry = fakeRegistry(resolve);
  if (opts.tools) {
    const real = opts.tools(index);
    registry = { get: (name) => real.find((x) => x.name === name), list: () => real.slice() };
  }
  const broker = new ApprovalBroker();
  const stop = new StopSwitch();
  const events = [];
  const journal = [];
  const h = { base, root, resolve, clock, brain, registry, broker, stop, events, journal, answer: opts.answer || null };
  h.files = { tasks: path.join(base, 'data', 'tasks.json'), budget: path.join(base, 'data', 'budget.json') };
  h.runtime = createRuntime({
    brain,
    model: MODEL,
    tasksFile: h.files.tasks,
    budgetFile: h.files.budget,
    sandboxRoot: root,
    reportsDir: 'reports',
    dailyLimitUsd: opts.dailyLimitUsd ?? 1,
    toolRegistry: registry,
    approvals: broker,
    stop,
    journal: { append: (e) => journal.push(e) },
    emit: (ev) => {
      events.push(ev);
      const decision = ev.type === 'approval_request' && typeof h.answer === 'function' ? h.answer(ev) : null;
      if (decision) broker.respond(ev.id, decision);
    },
    resolve,
    workspaceForId: opts.workspaceForId,
    now: clock.now,
  });
  h.asks = (prefix = '') => events.filter((e) => e.type === 'approval_request' && String(e.id).startsWith(prefix));
  h.task = (id) => h.runtime.queue.get(id);
  h.tool = (name) => h.runtime.chatTools.find((x) => x.name === name);
  t.after(() => h.runtime.close());
  return h;
}

test('поручение привязано к подтверждённой папке пространства, а не к выбранной позже', async (t) => {
  const base = tmpBase(t);
  const root = path.join(base, 'space-a');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  const index = new WorkspaceIndex(root);
  const tools = workspaceTools(index);
  const registry = { get: (name) => tools.find((tool) => tool.name === name), list: () => tools.slice() };
  const h = build(t, {
    base, answer: ownerSays('once'),
    workspaceForId: (id) => id === 'space-a' ? { root, resolve: (rel) => index.resolveInside(rel), toolRegistry: registry } : null,
    script: [planReply(TEA_PLAN), toolReply(['workspace_write', { path: 'notes/tea.md', content: 'улун' }]),
      doneReply(), toolReply(['workspace_write', { path: 'reports/tea.md', content: 'сводка' }], ['step_done', { summary: 'готово' }])],
  });
  const result = await h.runtime.submitTask({ goal: GOAL, tools: ['workspace_write'], folders: ['notes', 'reports'] }, { workspaceId: 'space-a' });
  assert.equal(result.ok, true, result.summary);
  await h.runtime.whenIdle();
  const task = h.task(result.data.id);
  assert.equal(task.workspaceId, 'space-a');
  assert.equal(task.mandate.root, root);
  assert.equal(task.status, 'done');
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'tea.md'), 'utf8'), 'улун');
  assert.ok(fs.existsSync(path.join(root, 'reports', `task-${task.id}.md`)));
  assert.equal(h.runtime.reportPath(task.id), path.join(root, 'reports', `task-${task.id}.md`));
  assert.equal(fs.existsSync(path.join(h.root, 'notes', 'tea.md')), false);
  assert.equal(readTasks(h.files.tasks).find((item) => item.id === task.id).workspaceId, 'space-a');
  assert.equal(h.asks('mandate:')[0].args.папка, root, 'владелец видел папку до подтверждения');
  // Подменённая привязка не должна дать возобновить старый мандат в общем пространстве.
  h.runtime.queue._set({ ...task, workspaceId: 'default', status: 'paused' });
  assert.equal(h.runtime.reportPath(task.id), null, 'отчёт с чужим мандатом не открывается');
  const resumed = await h.runtime.resumeTask(task.id);
  assert.equal(resumed.ok, false);
  assert.match(resumed.summary, /не совпадает с подтверждённым мандатом/);
  assert.equal(h.asks('resume:').length, 0);
});

test('инструменты чата видят и изменяют только поручения своего пространства', async (t) => {
  const h = build(t);
  const { createTask } = require('../src/tasks/model');
  for (const [id, space] of [['a', 'space-a'], ['b', 'space-b'], ['c', null]]) {
    const task = createTask({ id, title: id, goal: id, now: NOW });
    if (space) task.workspaceId = space;
    h.runtime.queue.add(task);
  }
  const toolsA = h.runtime.scopedChatTools('space-a');
  const common = h.runtime.scopedChatTools('default');
  const invoke = (tools, name, args) => tools.find((tool) => tool.name === name).run(args, {});
  assert.deepEqual((await invoke(toolsA, 'task_list', {})).data.tasks.map((task) => task.id), ['a']);
  assert.deepEqual((await invoke(common, 'task_list', {})).data.tasks.map((task) => task.id), ['c']);
  assert.equal((await invoke(toolsA, 'task_list', { id: 'b' })).ok, false);
  assert.equal((await invoke(toolsA, 'task_note', { id: 'b', kind: 'next', text: 'чужая запись' })).ok, false);
  assert.equal((await invoke(common, 'task_note', { id: 'a', kind: 'next', text: 'чужая запись' })).ok, false);
  assert.equal((await invoke(toolsA, 'task_resume', { id: 'b' })).ok, false);
});

test('после перезапуска поручение остаётся в прежнем пространстве и ждёт подтверждения', async (t) => {
  const base = tmpBase(t);
  const spaceRoot = path.join(base, 'space-a');
  fs.mkdirSync(path.join(spaceRoot, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(spaceRoot, 'reports'), { recursive: true });
  const index = new WorkspaceIndex(spaceRoot);
  const spaceTools = workspaceTools(index);
  const workspaceForId = (id) => id === 'space-a' ? { root: spaceRoot, resolve: (rel) => index.resolveInside(rel),
    toolRegistry: { get: (name) => spaceTools.find((tool) => tool.name === name), list: () => spaceTools.slice() } } : null;
  const hang = deferred();
  const first = build(t, { base, workspaceForId, answer: ownerSays('once'),
    script: [planReply(TEA_PLAN), toolReply(['workspace_write', { path: 'notes/tea.md', content: 'улун' }]), doneReply(), hang.step] });
  const submitted = await first.runtime.submitTask({ goal: GOAL, tools: ['workspace_write'], folders: ['notes', 'reports'] }, { workspaceId: 'space-a' });
  assert.equal(submitted.ok, true, submitted.summary);
  await waitFor(() => hang.release !== null, 'прерванный шаг');
  first.runtime.close();
  const second = build(t, { base, workspaceForId, answer: ownerSays('once'),
    script: [toolReply(['workspace_write', { path: 'reports/tea.md', content: 'сводка' }], ['step_done', { summary: 'готово' }])] });
  assert.equal(second.task(submitted.data.id).workspaceId, 'space-a');
  assert.equal(second.task(submitted.data.id).status, 'paused');
  assert.equal(second.brain.calls, 0);
  const resumed = await second.runtime.resumeTask(submitted.data.id);
  assert.equal(resumed.ok, true, resumed.summary);
  await second.runtime.whenIdle();
  assert.equal(second.task(submitted.data.id).status, 'done');
  assert.ok(fs.existsSync(path.join(spaceRoot, 'reports', 'tea.md')));
  assert.equal(fs.existsSync(path.join(second.root, 'reports', 'tea.md')), false);
  assert.equal(second.runtime.reportPath(submitted.data.id), path.join(spaceRoot, 'reports', `task-${submitted.data.id}.md`));
});

test('1. отказ владельца на task_submit: задача не создана, модель не вызвана', async (t) => {
  const h = build(t, { answer: ownerSays('reject'), script: [planReply(TEA_PLAN)] });
  const res = await h.runtime.submitTask({ goal: GOAL });
  assert.deepEqual([res.ok, res.summary], [false, 'отклонено владельцем']);

  const [ask] = h.asks('mandate:');
  assert.ok(ask, 'владельца спросили');
  assert.match(ask.id, /^mandate:m-/);
  assert.deepEqual([ask.name, ask.risk, ask.allowSession], ['мандат задачи', 'T1', false]);
  assert.equal(ask.reason, 'разрешить самостоятельную работу в песочнице по этому мандату');
  assert.match(ask.args['мандат'], /^Цель: Собрать заметку о чае/);
  assert.match(ask.args['мандат'], /Инструменты: список файлов \(workspace_list\), чтение файлов \(workspace_read\), поиск по файлам \(workspace_search\), запись файлов \(workspace_write\)\n/,
    'по умолчанию — только файлы песочницы');
  assert.match(ask.args['мандат'], /Бюджет: до \$0\.25, сверен с дневным бюджетом/);

  assert.equal(h.runtime.queue.list().length, 0);
  assert.deepEqual(readTasks(h.files.tasks), [], 'на диске задач нет');
  assert.equal(h.brain.calls, 0);
  assert.equal(h.runtime.approvals.list().length, 0, 'ожидающих подтверждений нет');
  assert.ok(h.journal.some((e) => e.tool === 'мандат задачи' && e.decision === 'reject' && e.ok === false));

  // «На сессию» — тоже отказ: принимается только «один раз». Через инструмент чата — то же самое.
  h.answer = ownerSays('session');
  const viaChat = await h.tool('task_submit').run({ goal: GOAL }, {});
  assert.deepEqual([viaChat.ok, viaChat.summary], [false, 'отклонено владельцем']);
  assert.equal(h.asks('mandate:').length, 2);
  assert.equal(h.runtime.queue.list().length, 0);
  assert.equal(h.brain.calls, 0);
});

test('2. одобрение «один раз»: мандат от владельца, план → шаги → проверка, отчёт в песочнице, расход учтён', async (t) => {
  const h = build(t, {
    answer: ownerSays('once'),
    script: [
      planReply(TEA_PLAN),
      toolReply(['workspace_write', { path: 'notes/tea.md', content: 'Чай: улун, пуэр.' }]),
      doneReply('заметка записана'),
      toolReply(['workspace_write', { path: 'reports/tea.md', content: '# Сводка\nулун' }], ['step_done', { summary: 'сводка записана' }]),
    ],
  });
  const res = await h.runtime.submitTask({ goal: GOAL, title: 'Чай', tools: ['workspace_write'], folders: ['notes', 'reports'] });
  assert.equal(res.ok, true, res.summary);
  assert.match(res.summary, /^мандат подтверждён владельцем, задача «Чай» у исполнителя/);
  const { id } = res.data;
  await h.runtime.whenIdle();

  const task = h.task(id);
  assert.equal(task.status, 'done');
  assert.equal(task.mandate.approvedBy, 'owner');
  assert.equal(task.mandate.approvedAt, NOW);
  assert.deepEqual(task.mandate.tools, ['workspace_write']);
  assert.deepEqual(task.mandate.folders, [path.join(h.root, 'notes'), path.join(h.root, 'reports')]);
  assert.deepEqual(task.plan.map((s) => [s.status, s.result.verification]), [['done', 'confirmed'], ['done', 'confirmed']]);
  const [ask] = h.asks('mandate:');
  assert.equal(ask.id, `mandate:${task.mandate.id}`);
  assert.equal(ask.args['мандат'], summarize(task.mandate), 'владелец видел ровно этот мандат');

  const file = path.join(h.root, 'reports', `task-${id}.md`);
  assert.ok(fs.existsSync(file), 'отчёт в песочнице');
  const report = fs.readFileSync(file, 'utf8');
  assert.match(report, /\*\*Итог: проверено\*\*/);
  assert.match(report, /Стоимость: \$0\.\d+ \(бюджет задачи \$0\.25\)/, 'стоимость известна');

  assert.equal(h.brain.calls, 4);
  assert.deepEqual(h.brain.requests.map((r) => r.purpose), ['plan', 'step', 'step', 'step']);
  assert.ok(h.brain.requests.every((r) => r.taskId === id && r.hasOnUsage && r.maxTokens === 4096), 'все вызовы — через стража');
  assert.ok(h.brain.requests.every((r) => r.taskBudgetUsd === undefined), 'бюджет задачи остаётся у стража');
  assert.deepEqual(h.brain.requests[1].tools, ['workspace_write', 'step_done', 'step_fail'], 'модели — только инструменты мандата');

  const spent = h.runtime.meter.spentForTask(id);
  assert.ok(spent > 0);
  near(spent, 4 * CALL_USD, 'расход задачи');
  near(h.runtime.meter.spentToday(), 4 * CALL_USD, 'расход дня');
  assert.equal(h.runtime.meter.reservedUsd, 0, 'резервы сняты');

  assert.equal(readTasks(h.files.tasks).find((x) => x.id === id).status, 'done', 'итог на диске');
  assert.deepEqual(h.registry.calls.map((c) => c.args.path), ['notes/tea.md', 'reports/tea.md']);
  assert.ok(h.registry.calls.every((c) => c.ctx.taskId === id && c.ctx.workspace === h.root));
  const final = h.events.filter((e) => e.type === 'task').at(-1);
  assert.deepEqual([final.status, final.final, final.report], ['done', true, file]);
  assert.ok(h.journal.some((e) => e.tool === 'мандат задачи' && e.decision === 'once' && e.taskId === id));
});

test('3. бюджет исчерпан: страж отказывает до запроса — модель не вызвана, задача на паузе, не заблокирована', async (t) => {
  // Дневной лимит меньше одной HTTP-попытки: отказ по дню до запроса.
  const day = build(t, { dailyLimitUsd: 0.002, answer: ownerSays('once'), script: [planReply(TEA_PLAN)] });
  const res = await day.runtime.submitTask({ goal: GOAL, budgetUsd: 0.002 });
  assert.equal(res.ok, true, res.summary);
  await day.runtime.whenIdle();
  const task = day.task(res.data.id);
  assert.equal(day.brain.calls, 0, 'запроса к модели не было');
  assert.equal(task.status, 'paused');
  assert.match(task.reason, /^дневной лимит: остаток \$0\.002, следующая попытка до \$/);
  assert.deepEqual(task.failures, {}, 'это не ошибка шага');
  assert.equal(day.runtime.meter.spentToday(), 0);
  assert.equal(day.runtime.meter.reservedUsd, 0);
  assert.ok(day.events.some((e) => e.type === 'task' && /^на паузе: дневной лимит/.test(e.message)), 'владелец уведомлён');
  assert.match(fs.readFileSync(path.join(day.root, 'reports', `task-${task.id}.md`), 'utf8'), /на паузе: дневной лимит/);

  // Бюджет задачи меньше худшего случая вызова: отказ по задаче (бюджет мандата стражу передаёт сборка).
  const own = build(t, { answer: ownerSays('once'), script: [planReply(TEA_PLAN)] });
  const small = await own.runtime.submitTask({ goal: GOAL, budgetUsd: 0.001 });
  assert.equal(small.ok, true, small.summary);
  await own.runtime.whenIdle();
  assert.equal(own.brain.calls, 0);
  assert.deepEqual([own.task(small.data.id).status, own.task(small.data.id).reason], ['paused', 'бюджет задачи исчерпан']);

  // Остаток дня меньше бюджета задачи: поручение отклонено ещё до вопроса владельцу.
  const tight = build(t, { dailyLimitUsd: 0.1, answer: ownerSays('once') });
  const big = await tight.runtime.submitTask({ goal: GOAL, budgetUsd: 0.25 });
  assert.equal(big.ok, false);
  assert.match(big.summary, /бюджет задачи \$0\.25 больше дневного бюджета \$0\.10/);
  assert.equal(tight.asks().length, 0);
});

test('4. срок мандата истёк: пауза «срок мандата истёк», модель не вызвана', async (t) => {
  // Владелец ответил поздно: пока ждали подтверждения, сутки прошли.
  const late = build(t, { script: [planReply(TEA_PLAN)] });
  late.answer = () => {
    late.clock.advance(25 * HOUR);
    return 'once';
  };
  const res = await late.runtime.submitTask({ goal: GOAL });
  assert.equal(res.ok, true, res.summary);
  assert.match(res.summary, /на паузе \(срок мандата истёк\)/);
  await late.runtime.whenIdle();
  const task = late.task(res.data.id);
  assert.deepEqual([task.status, task.reason], ['paused', 'срок мандата истёк']);
  assert.equal(late.brain.calls, 0);
  assert.equal(late.registry.calls.length, 0);
  // Возобновить по истёкшему мандату нельзя: отказ без вопроса владельцу.
  const asked = late.asks().length;
  const again = await late.runtime.resumeTask(task.id);
  assert.equal(again.ok, false);
  assert.match(again.summary, /^срок мандата истёк/);
  assert.equal(late.asks().length, asked);

  // Вторая задача ждала в очереди, пока работала первая, и её мандат истёк: она на паузе, модель для неё не вызывалась.
  const plan = deferred();
  const q = build(t, { answer: ownerSays('once'), script: [plan.step, doneReply('продумано')] });
  const first = await q.runtime.submitTask({ goal: 'Продумать структуру заметки' });
  await waitFor(() => plan.release !== null, 'запрос плана первой задачи');
  const second = await q.runtime.submitTask({ goal: GOAL, expiresInHours: 1 });
  assert.equal(second.ok, true, second.summary);
  assert.equal(q.task(second.data.id).status, 'queued', 'исполнитель занят: вторая в очереди');
  assert.match(second.summary, /в очереди$/);
  q.clock.advance(90 * 60 * 1000);
  plan.release(planReply([{ title: 'Продумать структуру' }]));
  await q.runtime.whenIdle();
  assert.equal(q.task(first.data.id).status, 'unverified');
  assert.deepEqual([q.task(second.data.id).status, q.task(second.data.id).reason], ['paused', 'срок мандата истёк']);
  assert.equal(q.brain.calls, 2);
  assert.ok(q.brain.requests.every((r) => r.taskId === first.data.id), 'для второй задачи модель не вызывалась');
});

test('5. запрещённый инструмент: shell_run модели не предложен, его вызов — отказ, сам инструмент не запущен', async (t) => {
  const last = deferred();
  const h = build(t, {
    answer: ownerSays('once'),
    script: [
      planReply([{ title: 'Записать заметку', check: { kind: 'file_exists', path: 'notes/a.md' } }]),
      toolReply(['shell_run', { command: 'Remove-Item C:\\ -Recurse' }]),
      last.step,
    ],
  });
  // В мандат shell_run не попадает вовсе: такое поручение отклонено до вопроса владельцу.
  const banned = await h.runtime.submitTask({ goal: GOAL, tools: ['workspace_write', 'shell_run'] });
  assert.equal(banned.ok, false);
  assert.match(banned.summary, /инструмент «shell_run» запрещён для автономных задач/);
  assert.equal(h.asks().length, 0);

  const res = await h.runtime.submitTask({ goal: GOAL, tools: ['workspace_write', 'web_fetch'] });
  const { id } = res.data;
  await waitFor(() => last.release !== null, 'третий запрос к модели');
  assert.deepEqual(h.brain.requests[1].tools, ['workspace_write', 'web_fetch', 'step_done', 'step_fail'], 'shell_run модели не предложен');
  assert.equal(h.registry.calls.length, 0, 'shell_run не запускался');
  const deny = h.journal.find((e) => e.tool === 'shell_run');
  assert.equal(deny.decision, 'deny');
  assert.match(deny.summary, /^отказ: инструмент «shell_run» запрещён/);
  assert.match(h.brain.requests[2].messages.at(-1).content, /отказ: инструмент «shell_run» запрещён/, 'модель получила отказ как наблюдение');

  // Вторая линия: runTool сборки и для выполняющейся задачи пускает только то, что разрешает её мандат.
  assert.equal(h.task(id).status, 'running');
  const direct = async (name, args, ctx = { taskId: id }) => (await h.runtime.runTool(name, args, ctx)).summary;
  assert.match(await direct('shell_run', { command: 'dir' }), /^отказ: инструмент «shell_run» запрещён для автономных задач/);
  assert.match(await direct('workspace_read', { path: 'notes/a.md' }), /^отказ: инструмента «workspace_read» нет в мандате/);
  assert.match(await direct('workspace_write', { path: '../outside.md', content: 'x' }), /^отказ: путь «\.\.\/outside\.md» не разрешён/);
  assert.match(await direct('workspace_write', { path: 'notes/x.md', content: 'x' }, {}), /^отказ: .*вне задачи с мандатом/);
  assert.equal(h.registry.calls.length, 0, 'ни один запрещённый вызов не дошёл до инструмента');
  const fetched = await h.runtime.runTool('web_fetch', { url: 'https://example.com' }, { taskId: id });
  assert.equal(fetched.ok, true, 'инструмент из мандата выполняется');
  assert.deepEqual([h.registry.calls[0].name, h.registry.calls[0].ctx.taskId], ['web_fetch', id]);

  last.release(toolReply(['workspace_write', { path: 'notes/a.md', content: 'чай' }], ['step_done', { summary: 'записал' }]));
  await h.runtime.whenIdle();
  assert.equal(h.task(id).status, 'done');
  assert.deepEqual(h.registry.names(), ['web_fetch', 'workspace_write']);
  assert.match(await direct('workspace_write', { path: 'notes/y.md', content: 'x' }), /^отказ: задача не выполняется/, 'после итога — ничего');
});

test('6. выход за папку: «../outside.md», абсолютный путь и папка вне мандата — отказ, файлов снаружи нет', async (t) => {
  const base = tmpBase(t);
  const outsideAbs = path.join(base, 'outside2.md');
  const h = build(t, {
    base,
    answer: ownerSays('once'),
    script: [
      planReply([
        { title: 'Записать заметку', check: { kind: 'file_exists', path: 'notes/b.md' } },
        { title: 'Записать вторую', check: { kind: 'file_exists', path: 'notes/c.md' } },
      ]),
      toolReply(['workspace_write', { path: '../outside.md', content: 'x' }]),
      toolReply(['workspace_write', { path: outsideAbs, content: 'x' }]),
      toolReply(['workspace_write', { path: 'notes/b.md', content: 'чай' }], ['step_done', { summary: 'записал' }]),
      toolReply(['workspace_write', { path: 'reports/x.md', content: 'x' }]),
      toolReply(['workspace_write', { path: 'notes/c.md', content: 'чай' }], ['step_done', { summary: 'записал' }]),
    ],
  });
  const res = await h.runtime.submitTask({ goal: 'Записать заметки в notes', tools: ['workspace_write'], folders: ['notes'] });
  await h.runtime.whenIdle();
  assert.equal(fs.existsSync(path.join(base, 'outside.md')), false, 'над песочницей файла нет');
  assert.equal(fs.existsSync(outsideAbs), false);
  assert.equal(fs.existsSync(path.join(h.root, 'reports', 'x.md')), false, 'вне папок мандата файла нет');
  assert.deepEqual(h.registry.calls.map((c) => c.args.path), ['notes/b.md', 'notes/c.md'], 'инструмент получил только разрешённые пути');
  const denies = h.journal.filter((e) => e.decision === 'deny');
  assert.equal(denies.length, 3);
  assert.match(denies[0].summary, /не разрешён: путь вне рабочей папки/);
  assert.match(denies[1].summary, /не разрешён: путь вне рабочей папки/);
  assert.match(denies[2].summary, /«reports\/x\.md» вне папок мандата/);
  assert.equal(h.task(res.data.id).status, 'done');
});

test('7. стоп во время запроса к модели: запрос отменён, ответ не исполняется, новых вызовов нет, задача на паузе', async (t) => {
  const hang = deferred();
  const h = build(t, { answer: ownerSays('once'), script: [planReply(TEA_PLAN), hang.step] });
  const { data: { id } } = await h.runtime.submitTask({ goal: GOAL });
  await waitFor(() => hang.release !== null, 'запрос шага к модели');
  assert.equal(h.task(id).status, 'running');

  h.stop.trigger('аварийный стоп');
  assert.equal(hang.req.signal.aborted, true, 'запрос к модели отменён сигналом');
  // Модель всё же ответила (сигнал не услышала): вызов инструмента из ответа не выполняется.
  hang.release(toolReply(['workspace_write', { path: 'notes/tea.md', content: 'x' }]));
  await h.runtime.whenIdle();

  const task = h.task(id);
  assert.deepEqual([task.status, task.reason], ['paused', 'аварийный стоп']);
  assert.equal(h.brain.calls, 2);
  assert.equal(h.registry.calls.length, 0, 'новых инструментов нет');
  assert.equal(fs.existsSync(path.join(h.root, 'notes', 'tea.md')), false);
  await ticks();
  assert.equal(h.brain.calls, 2, 'и дальше модель не вызывается');
  assert.equal(h.runtime.executor.isBusy(), false);
  assert.equal(h.runtime.executor.kick(), null, 'пока стоп включён, исполнитель ничего не берёт');
  assert.equal(fs.existsSync(path.join(h.root, 'reports', `task-${id}.md`)), false, 'после стопа ничего нового, и отчёта тоже');
  assert.equal(readTasks(h.files.tasks).find((x) => x.id === id).status, 'paused', 'пауза на диске');
  assert.equal(h.runtime.meter.reservedUsd, 0, 'резерв прерванного запроса снят');
});

test('8. после стопа задача сама не запускается: возобновление только с подтверждением, «отказ» — остаётся на паузе', async (t) => {
  const hang = deferred();
  const h = build(t, {
    answer: ownerSays('once'),
    script: [
      planReply(TEA_PLAN),
      hang.step,
      toolReply(['workspace_write', { path: 'notes/tea.md', content: 'Чай: улун.' }], ['step_done', { summary: 'заметка' }]),
      toolReply(['workspace_write', { path: 'reports/tea.md', content: 'сводка' }], ['step_done', { summary: 'сводка' }]),
    ],
  });
  const { data: { id } } = await h.runtime.submitTask({ goal: GOAL });
  await waitFor(() => hang.release !== null, 'запрос шага');
  h.stop.trigger('аварийный стоп');
  hang.release({ content: 'думаю' });
  await h.runtime.whenIdle();
  assert.equal(h.task(id).status, 'paused');

  // Пока стоп включён, возобновить нельзя, и владельца даже не спрашивают.
  h.answer = null;
  const asked = h.asks().length;
  const during = await h.runtime.resumeTask(id);
  assert.equal(during.ok, false);
  assert.match(during.summary, /^аварийный стоп включён/);
  assert.equal(h.asks().length, asked);

  // Стоп снят («Возобновить после стопа» в трее): ничего не запускается само.
  h.stop.reset();
  assert.equal(h.runtime.executor.kick(), null);
  await ticks();
  assert.equal(h.task(id).status, 'paused');
  assert.equal(h.brain.calls, 2);

  // Возобновление ждёт решения владельца; «отказ» — задача на паузе, модель не вызвана.
  const pending = h.runtime.resumeTask(id);
  await waitFor(() => h.asks('resume:').length === 1, 'запрос возобновления');
  const [ask] = h.asks('resume:');
  assert.match(ask.id, new RegExp(`^resume:${id}:\\d+$`));
  assert.deepEqual(ask.args, { задача: h.task(id).title, 'причина паузы': 'аварийный стоп' });
  assert.deepEqual([ask.name, ask.risk, ask.allowSession, ask.reason], ['возобновление задачи', 'T1', false, 'продолжить задачу по её мандату']);
  assert.equal(h.task(id).status, 'paused', 'пока владелец думает — на паузе');
  h.runtime.approvals.respond(ask.id, 'reject');
  const rejected = await pending;
  assert.deepEqual([rejected.ok, rejected.summary], [false, 'отклонено владельцем']);
  await ticks();
  assert.equal(h.task(id).status, 'paused');
  assert.equal(h.brain.calls, 2, 'модель не вызвана');

  // «Один раз» — задача продолжается с прерванного шага и доходит до проверенного итога.
  h.answer = ownerSays('once');
  const resumed = await h.runtime.resumeTask(id);
  assert.equal(resumed.ok, true, resumed.summary);
  await h.runtime.whenIdle();
  assert.equal(h.task(id).status, 'done');
  assert.equal(h.brain.calls, 4);
  assert.ok(fs.existsSync(path.join(h.root, 'reports', `task-${id}.md`)));
});

test('9. перезапуск: расход и остаток дня из файла, прерванный запрос — в расходе, задача на паузе и сама не стартует', async (t) => {
  const base = tmpBase(t);
  const clock = makeClock();
  const hang = deferred();
  const first = build(t, {
    base,
    clock,
    answer: ownerSays('once'),
    script: [
      planReply(TEA_PLAN),
      toolReply(['workspace_write', { path: 'notes/tea.md', content: 'Чай: улун.' }]),
      doneReply('заметка записана'),
      hang.step, // процесс «упал», пока модель отвечала на шаг 2: этот ответ не придёт никогда
    ],
  });
  const { data: { id } } = await first.runtime.submitTask({ goal: GOAL });
  await waitFor(() => hang.release !== null, 'запрос шага 2');
  const spentTask = first.runtime.meter.spentForTask(id);
  const spentDay = first.runtime.meter.spentToday();
  const inFlight = first.runtime.meter.reservedUsd;
  near(spentTask, 3 * CALL_USD, 'до сбоя: три ответа');
  assert.ok(inFlight > 0, 'резерв запроса в полёте лежит в файле учёта');
  assert.equal(readTasks(first.files.tasks).find((x) => x.id === id).status, 'running', 'на диске задача «работает»');
  first.runtime.close();

  // Новый процесс: те же файлы, новая сборка и единственный в ней Meter.
  const brain = scriptedBrain([
    toolReply(['workspace_write', { path: 'reports/tea.md', content: 'сводка' }], ['step_done', { summary: 'сводка записана' }]),
  ]);
  const second = build(t, { base, clock, brain });
  near(second.runtime.meter.spentForTask(id), spentTask + inFlight, 'расход задачи сохранился; прерванный запрос — по верхней границе');
  near(second.runtime.meter.spentToday(), spentDay + inFlight, 'расход дня сохранился');
  near(second.runtime.meter.remainingToday(), 1 - (spentDay + inFlight), 'остаток дня');
  assert.equal(second.runtime.meter.reservedUsd, 0);
  const interrupted = JSON.parse(fs.readFileSync(second.files.budget, 'utf8')).calls.filter((c) => c.interrupted);
  assert.deepEqual(interrupted.map((c) => [c.taskId, c.purpose, c.known]), [[id, 'step', false]]);

  const task = second.task(id);
  assert.equal(task.status, 'paused');
  assert.match(task.reason, /^перезапуск приложения/);
  assert.deepEqual(task.plan.map((s) => s.status), ['done', 'doing'], 'план и сделанный шаг сохранились');
  assert.equal(readTasks(second.files.tasks).find((x) => x.id === id).status, 'paused', 'пауза сразу записана');
  assert.equal(second.runtime.executor.kick(), null);
  await ticks();
  assert.equal(brain.calls, 0, 'без возобновления модель не вызывается');
  assert.equal(second.task(id).status, 'paused');

  // Возобновление с подтверждением: прерванный шаг доделывается, итог проверен.
  second.answer = ownerSays('once');
  const resumed = await second.runtime.resumeTask(id);
  assert.equal(resumed.ok, true, resumed.summary);
  await second.runtime.whenIdle();
  assert.equal(second.task(id).status, 'done');
  assert.equal(brain.calls, 1);
  near(second.runtime.meter.spentForTask(id), spentTask + inFlight + CALL_USD, 'расход задачи после возобновления');
});

test('10. обёртка подтверждений: запрос исполнителя уходит в окно как approval_request; ответ и список — как у брокера', async (t) => {
  // Подтверждения ждёт только инструмент с пометкой requiresApproval (в подделке — web_search).
  const script = () => [
    planReply([{ title: 'Найти сорт и записать заметку', check: { kind: 'file_contains', path: 'notes/tea.md', text: 'улун' } }]),
    toolReply(['web_search', { query: 'чай улун' }]),
    toolReply(['workspace_write', { path: 'notes/tea.md', content: 'Чай: улун.' }], ['step_done', { summary: 'заметка записана' }]),
  ];
  const goal = 'Найти сорт чая и записать заметку в notes/tea.md';
  const tools = ['web_search', 'workspace_write'];
  const h = build(t, { answer: ownerSays('once'), script: script() }); // мандат — «один раз», вызов инструмента ждёт теста
  const { data: { id } } = await h.runtime.submitTask({ goal, tools });
  await waitFor(() => h.runtime.approvals.list().length === 1, 'подтверждение инструмента');
  const [pending] = h.runtime.approvals.list();
  const ev = h.events.find((e) => e.type === 'approval_request' && e.id === pending.id);
  assert.ok(ev, 'окно получило approval_request');
  assert.deepEqual(
    { id: ev.id, name: ev.name, risk: ev.risk, reason: ev.reason, allowSession: ev.allowSession, query: ev.args.query },
    { id: `${id}:c2_0`, name: 'web_search', risk: 'T1', reason: 'инструмент требует подтверждения владельца', allowSession: false, query: 'чай улун' },
  );
  assert.equal(h.task(id).status, 'waiting_approval');
  assert.equal(h.registry.calls.length, 0, 'до ответа инструмент не запущен');
  assert.equal(h.runtime.approvals.respond(pending.id, 'once'), true);
  await h.runtime.whenIdle();
  assert.equal(h.task(id).status, 'done');
  assert.deepEqual(h.registry.names(), ['web_search', 'workspace_write']);
  assert.equal(h.asks(`${id}:`).length, 1, 'workspace_write подтверждения не просил');
  assert.match(fs.readFileSync(path.join(h.root, 'notes', 'tea.md'), 'utf8'), /улун/);

  // Ответ прямо из обработчика события не теряется: запрос к этому моменту уже зарегистрирован у брокера.
  const quick = build(t, { answer: () => 'once', script: script() });
  const fast = await quick.runtime.submitTask({ goal, tools });
  await quick.runtime.whenIdle();
  assert.equal(quick.task(fast.data.id).status, 'done');
  assert.equal(quick.asks(`${fast.data.id}:`).length, 1);

  // Запрос без id: id выдаёт брокер, в событии тот же; cancelAll отклоняет ожидающие.
  const waiting = h.runtime.approvals.request({ name: 'проверка', args: {}, risk: 'T1' });
  const last = h.events.at(-1);
  assert.equal(last.type, 'approval_request');
  assert.equal(typeof last.id, 'string');
  assert.deepEqual(h.runtime.approvals.list().map((p) => p.id), [last.id]);
  assert.equal(h.runtime.approvals.cancelAll(), 1);
  assert.equal(await waiting, 'reject');
});

test('11. инструменты чата: задачу с мандатом не меняют task_plan, task_step, task_verify — «ведётся исполнителем»', async (t) => {
  const plan = deferred();
  const h = build(t, { answer: ownerSays('once'), script: [plan.step, doneReply('продумано')] });
  assert.deepEqual(h.runtime.chatTools.map((x) => x.name),
    ['task_note', 'task_create', 'task_plan', 'task_enqueue', 'task_start', 'task_step', 'task_verify', 'task_list', 'task_submit', 'task_resume']);
  for (const name of ['task_submit', 'task_resume']) {
    assert.equal(h.tool(name).risk, 'T0', `${name}: подтверждение внутри, не политикой хода`);
    assert.equal(typeof h.tool(name).description, 'string');
  }
  assert.deepEqual(h.tool('task_submit').parameters.required, ['goal']);

  const call = (name, args) => h.tool(name).run(args, {});
  const { data: { id } } = await call('task_submit', { goal: 'Продумать структуру заметки' });
  await waitFor(() => plan.release !== null, 'исполнитель составляет план');
  const before = JSON.stringify(h.task(id));
  for (const [name, args] of [
    ['task_plan', { id, steps: [{ title: 'чужой план' }] }],
    ['task_step', { id, step_id: 's1', status: 'skipped' }],
    ['task_verify', { id, step_id: 's1' }],
    ['task_enqueue', { id }],
    ['task_start', { id }],
  ]) {
    const res = await call(name, args);
    assert.deepEqual([res.ok, res.summary], [false, 'задача ведётся исполнителем'], name);
  }
  assert.equal(JSON.stringify(h.task(id)), before, 'задача не изменилась');
  const shown = (await call('task_list', {})).data.tasks.find((x) => x.id === id);
  assert.deepEqual([shown.byExecutor, shown.status], [true, 'running']);

  plan.release(planReply([{ title: 'Продумать структуру' }]));
  await h.runtime.whenIdle();
  assert.equal(h.task(id).status, 'unverified');
});

test('12. битый файл задач: отложен как .corrupt-<время>, список пуст, сообщение в консоль', (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  const base = tmpBase(t);
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), '{ это не JSON', 'utf8');
  fs.writeFileSync(path.join(dataDir, `tasks.json.corrupt-${NOW}`), 'прежняя копия', 'utf8');
  const h = build(t, { base });
  assert.equal(h.runtime.queue.list().length, 0);
  assert.equal(fs.readFileSync(path.join(dataDir, `tasks.json.corrupt-${NOW}-2`), 'utf8'), '{ это не JSON', 'битый файл отложен');
  assert.equal(fs.readFileSync(path.join(dataDir, `tasks.json.corrupt-${NOW}`), 'utf8'), 'прежняя копия', 'прежняя копия не перезаписана');
  assert.deepEqual(readTasks(h.files.tasks), [], 'на месте — пустой список');
  assert.ok(errors.some((e) => /^задачи: файл .*tasks\.json не читается/.test(e)), errors.join('\n'));

  // Записи не той структуры — тоже битый файл.
  const other = tmpBase(t);
  fs.mkdirSync(path.join(other, 'data'), { recursive: true });
  fs.writeFileSync(path.join(other, 'data', 'tasks.json'), JSON.stringify({ version: 1, tasks: [{ id: 5 }] }), 'utf8');
  const g = build(t, { base: other });
  assert.equal(g.runtime.queue.list().length, 0);
  assert.ok(fs.existsSync(path.join(other, 'data', `tasks.json.corrupt-${NOW}`)));
});

test('13. учёт заблокирован (битый файл учёта): причина видна — поручение отклонено с ней, чат и исполнитель получают отказ', async (t) => {
  t.mock.method(console, 'error', () => {});
  const base = tmpBase(t);
  fs.mkdirSync(path.join(base, 'data'), { recursive: true });
  fs.writeFileSync(path.join(base, 'data', 'budget.json'), '{ битый', 'utf8');
  const h = build(t, { base, answer: ownerSays('once') });
  assert.equal(h.runtime.meter.blockedReason(), REASON_CORRUPT);
  const res = await h.runtime.submitTask({ goal: GOAL });
  assert.equal(res.ok, false);
  assert.match(res.summary, /^задача не создана: учёт расходов заблокирован: файл учёта повреждён — лимит не обеспечен/);
  assert.equal(h.asks().length, 0, 'владельца не спрашивали: работать всё равно нельзя');
  await assert.rejects(h.runtime.guardedBrain.chat({ messages: [{ role: 'user', content: 'привет' }] }), (err) => {
    assert.deepEqual([err.code, err.scope, err.reason], ['budget', 'meter', REASON_CORRUPT]);
    return true;
  });
  assert.equal(h.brain.calls, 0);

  // Учёт сломался, пока задача ждала старта: исполнитель ставит её на паузу с той же причиной, без запроса к модели.
  const w = build(t, { script: [planReply(TEA_PLAN)] });
  w.answer = () => {
    fs.writeFileSync(w.files.budget, '{ битый', 'utf8');
    return 'once';
  };
  const r = await w.runtime.submitTask({ goal: GOAL });
  assert.equal(r.ok, true, r.summary);
  await w.runtime.whenIdle();
  assert.equal(w.brain.calls, 0);
  assert.deepEqual([w.task(r.data.id).status, w.task(r.data.id).reason], ['paused', REASON_CORRUPT]);
  assert.match(fs.readFileSync(path.join(w.root, 'reports', `task-${r.data.id}.md`), 'utf8'), /файл учёта повреждён/);
  const resume = await w.runtime.resumeTask(r.data.id);
  assert.equal(resume.ok, false);
  assert.match(resume.summary, /учёт расходов заблокирован: файл учёта повреждён/);
});

test('14. подтверждение мандата: отмена хода чата и стоп — отказ; после close() стоп его не трогает, но задачу не создать', async (t) => {
  const h = build(t, { script: [planReply(TEA_PLAN)] });
  // Ход чата остановлен (signal): ожидающее подтверждение отклонено, задачи нет.
  const controller = new AbortController();
  const viaChat = h.tool('task_submit').run({ goal: GOAL }, { signal: controller.signal });
  await waitFor(() => h.runtime.approvals.list().length === 1, 'запрос мандата');
  controller.abort();
  assert.deepEqual(await viaChat.then((r) => [r.ok, r.summary]), [false, 'отклонено владельцем']);
  assert.equal(h.runtime.approvals.list().length, 0);

  // Стоп: своё ожидающее подтверждение сборка отклоняет сама.
  const first = h.runtime.submitTask({ goal: GOAL });
  await waitFor(() => h.runtime.approvals.list().length === 1, 'второй запрос мандата');
  h.stop.trigger('аварийный стоп');
  assert.deepEqual(await first.then((r) => [r.ok, r.summary]), [false, 'аварийный стоп включён: задача не создана']);
  assert.equal(h.runtime.approvals.list().length, 0);

  // После close() сборка от стопа отписана: запрос ждёт. Одобрение во время стопа задачу всё равно не создаёт.
  h.stop.reset();
  h.runtime.close();
  const second = h.runtime.submitTask({ goal: GOAL });
  await waitFor(() => h.runtime.approvals.list().length === 1, 'третий запрос мандата');
  h.stop.trigger('аварийный стоп');
  await ticks();
  assert.equal(h.runtime.approvals.list().length, 1, 'после close() стоп этот запрос не отклоняет');
  h.runtime.approvals.respond(h.runtime.approvals.list()[0].id, 'once');
  assert.deepEqual(await second.then((r) => [r.ok, r.summary]), [false, 'аварийный стоп включён: задача не создана']);
  assert.equal(h.runtime.queue.list().length, 0);
  assert.equal(h.brain.calls, 0);
});

test('15. неверные параметры task_submit: отказ с причиной до вопроса владельцу; без параметров — безопасные значения', async (t) => {
  const h = build(t, { dailyLimitUsd: 0.3, answer: ownerSays('reject') });
  const outside = path.join(h.base, 'elsewhere');
  const cases = [
    [{}, /нужна цель задачи/],
    [{ goal: '   ' }, /нужна цель задачи/],
    [{ goal: 'ч'.repeat(2001) }, /цель длиннее 2000 символов/],
    [{ goal: GOAL, tools: [] }, /нужен непустой список инструментов/],
    [{ goal: GOAL, tools: ['ui_click'] }, /«ui_click» не входит в разрешённые/],
    [{ goal: GOAL, folders: ['../секрет'] }, /вне песочницы/],
    [{ goal: GOAL, folders: [outside] }, /укажите путь относительно песочницы/],
    [{ goal: GOAL, expiresInHours: 0.5 }, /expiresInHours/],
    [{ goal: GOAL, expiresInHours: 169 }, /expiresInHours/],
    [{ goal: GOAL, budgetUsd: 0 }, /бюджет задачи должен быть больше \$0/],
    [{ goal: GOAL, budgetUsd: 1.5 }, /не больше \$1/],
    [{ goal: GOAL, budgetUsd: 0.5 }, /больше дневного бюджета/],
    // Лимиты поручение не задаёт: модель не может ослабить «неудач подряд 3» (живой прогон: модель поставила 2).
    [{ goal: GOAL, limits: { maxFailuresPerStep: 2 } }, /неизвестный параметр «limits»/],
    [{ goal: GOAL, priority: 5 }, /неизвестный параметр «priority»/],
  ];
  for (const [args, reason] of cases) {
    const res = await h.runtime.submitTask(args);
    const what = JSON.stringify(args).slice(0, 80);
    assert.equal(res.ok, false, what);
    assert.match(res.summary, reason, what);
  }
  assert.equal(h.asks().length, 0, 'владельца ни разу не спросили');
  assert.equal(h.runtime.queue.list().length, 0);

  // Без параметров кроме цели: файлы песочницы, вся песочница, сутки, $0.25 (сверен с остатком дня).
  await h.runtime.submitTask({ goal: GOAL });
  const text = h.asks('mandate:')[0].args['мандат'];
  assert.match(text, /Инструменты: список файлов \(workspace_list\), чтение файлов \(workspace_read\), поиск по файлам \(workspace_search\), запись файлов \(workspace_write\)\n/);
  assert.ok(text.includes(`Папки: ${h.root}\n`), text);
  assert.match(text, /\(24 ч\)/);
  assert.match(text, /Бюджет: до \$0\.25, сверен с дневным бюджетом/);
  assert.match(text, /Лимиты: шагов до 100, неудач подряд на шаге до 3, активной работы до 4 ч, токенов до 300 000/);
});

// Регрессия живого прогона: целевой папки нет до задачи. Список «папки нет» — наблюдение, а не отказ;
// шаг «убедиться, что файла ещё нет» проходит по file_absent; запись создаёт папку внутри мандата.
test('17. отсутствующая целевая папка: список — «папки нет» без неудачи, запись создаёт папку, все проверки проходят', async (t) => {
  const FOLDER = 'jarvis-acceptance/live-01';
  const FILE = `${FOLDER}/calculator-plan.md`;
  const PLAN = [
    { title: 'Проверить папку через workspace_list и убедиться, что файла ещё нет', check: { kind: 'file_absent', path: FILE } },
    { title: 'Записать план', check: { kind: 'file_exists', path: FILE } },
    { title: 'Проверить раздел «Критерии готовности»', check: { kind: 'file_contains', path: FILE, text: 'Критерии готовности' } },
  ];
  const h = build(t, {
    answer: ownerSays('once'),
    tools: (index) => workspaceTools(index),
    script: [
      planReply(PLAN),
      toolReply(['workspace_list', { path: FOLDER }], ['step_done', { summary: 'папки нет, файла нет' }]),
      toolReply(['workspace_write', { path: FILE, content: '# План\n\n## Цель\n\nКалькулятор\n\n## Критерии готовности\n\nТесты зелёные\n' }], ['step_done', { summary: 'записан' }]),
      doneReply('проверено'),
    ],
  });
  assert.equal(fs.existsSync(path.join(h.root, FOLDER)), false, 'папки до задачи нет');

  const res = await h.runtime.submitTask({ goal: 'План калькулятора', tools: ['workspace_list', 'workspace_write'], folders: [FOLDER] });
  assert.equal(res.ok, true, res.summary);
  await h.runtime.whenIdle();
  const task = h.task(res.data.id);
  assert.equal(task.status, 'done', task.reason);
  assert.deepEqual(task.failures, {}, 'ни одной неудачи');
  assert.deepEqual(task.plan.map((s) => [s.status, s.result.verification]), [['done', 'confirmed'], ['done', 'confirmed'], ['done', 'confirmed']]);
  // Список отсутствующей папки в журнале — успешное наблюдение с понятным текстом, а не отказ инструмента.
  assert.deepEqual(h.journal.filter((e) => e.tool === 'workspace_list').map((e) => [e.ok, e.summary]), [[true, `папки «${FOLDER}» пока нет`]]);
  assert.ok(fs.readFileSync(path.join(h.root, FILE), 'utf8').includes('Критерии готовности'));
  assert.equal(h.runtime.meter.reservedUsd, 0);
  // Отчёт называет проверку отсутствия по-русски, а не «неизвестная проверка».
  const report = fs.readFileSync(path.join(h.root, 'reports', `task-${task.id}.md`), 'utf8');
  assert.match(report, new RegExp(`файла ${FILE.replace(/[.]/g, '\\.')} нет`));
  assert.ok(!report.includes('неизвестная проверка'));
  // Итог с сводкой ушёл в окно: шаги с результатом, стоимость и путь к отчёту.
  const final = h.events.filter((e) => e.type === 'task' && e.final).at(-1);
  assert.match(final.summary, /^\*\*проверено:\*\*/);
  assert.match(final.summary, /Шагов выполнено: 3 из 3\. Проверок подтверждено: 3\./);
  assert.match(final.summary, /Стоимость: \$\d+\.\d{4} из бюджета задачи \$0\.25\./);
  assert.ok(final.summary.includes(`Отчёт: ${final.report}`));
});

test('16. чат идёт через того же стража: расход учтён как chat; неверные опции сборки — ошибка сразу', async (t) => {
  const h = build(t, { script: [{ content: 'Привет!' }] });
  const res = await h.runtime.guardedBrain.chat({ messages: [{ role: 'user', content: 'привет' }] });
  assert.equal(res.content, 'Привет!');
  assert.deepEqual([h.brain.requests[0].purpose, h.brain.requests[0].maxTokens, h.brain.requests[0].hasOnUsage], ['chat', 4096, true]);
  near(h.runtime.meter.spentToday(), CALL_USD, 'расход чата');
  const calls = JSON.parse(fs.readFileSync(h.files.budget, 'utf8')).calls;
  assert.deepEqual(calls.map((c) => [c.purpose, c.known]), [['chat', true]]);

  const base = tmpBase(t);
  const root = path.join(base, 'workspace');
  const good = {
    brain: scriptedBrain([]),
    model: MODEL,
    tasksFile: path.join(base, 'data', 'tasks.json'),
    budgetFile: path.join(base, 'data', 'budget.json'),
    sandboxRoot: root,
    dailyLimitUsd: 1,
    toolRegistry: fakeRegistry((rel) => path.resolve(root, rel)),
    approvals: new ApprovalBroker(),
    stop: new StopSwitch(),
    resolve: (rel) => path.resolve(root, rel),
  };
  assert.throws(() => createRuntime({ ...good, brain: null }), /нужна модель brain/);
  assert.throws(() => createRuntime({ ...good, model: '' }), /нужен model/);
  assert.throws(() => createRuntime({ ...good, sandboxRoot: 'workspace' }), /абсолютный путь sandboxRoot/);
  assert.throws(() => createRuntime({ ...good, approvals: {} }), /брокер подтверждений/);
  assert.throws(() => createRuntime({ ...good, resolve: null }), /resolve/);
  assert.throws(() => createRuntime({ ...good, reportsDir: '../reports' }), /внутри песочницы/);
  assert.throws(() => createRuntime({ ...good, reportsDir: '.' }), /не быть ею самой/);
  assert.throws(() => createRuntime({ ...good, dailyLimitUsd: 'много' }), /недопустимый дневной лимит/);
  assert.equal(fs.existsSync(path.join(base, 'data')), false, 'при ошибке опций файлы не созданы');
});

// ---- Ревью: сценарий «A работает → B в очереди → стоп → reset → поздний ответ A → обычный чат →
// C по явному поручению» целиком на сборке, и что меняет перезапуск.
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

const C_GOAL = 'Записать notes/c.md';
const C_PLAN = [{ title: 'Записать C', check: { kind: 'file_exists', path: 'notes/c.md' } }];
const QUEUED_STOP_REASON = 'аварийный стоп: задача в очереди ждёт вашего решения';

// Как main.js: стоп ставит выполняющуюся и стоящие в очереди задачи с мандатом на паузу и сохраняет задачи.
function wireStopLikeMain(h) {
  h.stop.onTrigger(({ reason }) => { h.runtime.queue.stopAll(reason); h.runtime.saveTasks(); });
}

// Ход чата как в main.js: инструменты чата сборки, task_step/task_verify подталкивают исполнителя (withExecutorKick).
function chatAgent(h, reply = { content: 'Привет! Чем помочь?', toolCalls: [] }) {
  const tools = new ToolRegistry();
  for (const tool of h.runtime.chatTools) {
    const kicking = ['task_step', 'task_verify'].includes(tool.name);
    tools.register(kicking ? { ...tool, run: async (a, c) => { const r = await tool.run(a, c); if (!h.runtime.queue.running()) h.runtime.executor.kick(); return r; } } : tool);
  }
  const brain = { calls: 0, async chat() { brain.calls += 1; return { content: reply.content, reasoningContent: null, toolCalls: reply.toolCalls }; } };
  const agent = new Agent({ brain, tools, approvals: h.runtime.approvals, journal: { append() {} }, emit: () => {}, stop: h.stop, mode: 'auto' });
  return { agent, brain };
}

test('ревью R1: A работает, B в очереди → стоп → reset → поздний ответ A → обычный чат → C только по поручению', async (t) => {
  const hang = deferred();
  const h = build(t, {
    answer: ownerSays('once'),
    script: [
      planReply(TEA_PLAN), // A: план
      hang.step, // A: шаг 1 — ответ придёт после reset
      planReply(C_PLAN), // C: план
      toolReply(['workspace_write', { path: 'notes/c.md', content: 'c' }], ['step_done', { summary: 'c' }]),
    ],
  });
  wireStopLikeMain(h);
  const { data: { id: a } } = await h.runtime.submitTask({ goal: GOAL });
  await waitFor(() => hang.release !== null, 'шаг A ждёт модель');
  const { data: { id: b } } = await h.runtime.submitTask({ goal: 'Задача B: notes/b.md' });
  assert.equal(h.task(b).status, 'queued', 'B ждёт: исполнитель занят A');

  h.stop.trigger('аварийный стоп');
  h.stop.reset();
  hang.release(toolReply(['workspace_write', { path: 'notes/tea.md', content: 'поздно' }], ['step_done', { summary: 'готово' }]));
  await h.runtime.whenIdle();
  assert.deepEqual([h.task(a).status, h.task(a).reason], ['paused', 'аварийный стоп']);
  assert.deepEqual([h.task(b).status, h.task(b).reason], ['paused', QUEUED_STOP_REASON], 'B из очереди — на паузе');
  assert.equal(h.registry.calls.length, 0, 'поздний ответ не запустил инструменты');
  assert.equal(fs.existsSync(path.join(h.root, 'notes', 'tea.md')), false);
  assert.equal(h.brain.calls, 2);

  // Обычное сообщение в чат (без task_*): старые задачи не возобновляются.
  const chat = chatAgent(h);
  await chat.agent.run('привет');
  await ticks(40);
  assert.equal(chat.brain.calls, 1);
  assert.equal(h.task(a).status, 'paused');
  assert.equal(h.task(b).status, 'paused');
  assert.equal(h.brain.calls, 2, 'модель задач не вызвана');

  // C — явное поручение с подтверждением мандата: стартует ровно C, без цепочки на B.
  const asksBefore = h.asks('mandate:').length;
  const c = await h.runtime.submitTask({ goal: C_GOAL });
  assert.equal(c.ok, true, c.summary);
  assert.equal(h.asks('mandate:').length, asksBefore + 1, 'мандат C спрошен у владельца');
  await h.runtime.whenIdle();
  assert.equal(h.task(c.data.id).status, 'done');
  assert.deepEqual(h.brain.requests.map((r) => r.taskId), [a, a, c.data.id, c.data.id]);
  assert.equal(h.task(a).status, 'paused');
  assert.equal(h.task(b).status, 'paused', 'B не запущена после C');
  assert.deepEqual(h.registry.calls.map((x) => x.args.path), ['notes/c.md']);
});

// Стоп не переживает перезапуск: в новом процессе эпоха 0. B, стоявшая в очереди до стопа, на диске — на паузе
// (stopAll), поэтому kick() первого же поручения C её не запускает: первой стартует C.
test('ревью R2: после стопа и перезапуска B из прежней очереди не стартует сама при поручении C', async (t) => {
  const base = tmpBase(t);
  const clock = makeClock();
  const hang = deferred();
  const first = build(t, { base, clock, answer: ownerSays('once'), script: [planReply(TEA_PLAN), hang.step] });
  wireStopLikeMain(first);
  const { data: { id: a } } = await first.runtime.submitTask({ goal: GOAL });
  await waitFor(() => hang.release !== null, 'шаг A ждёт модель');
  const { data: { id: b } } = await first.runtime.submitTask({ goal: 'Задача B: notes/b.md' });
  assert.equal(first.task(b).status, 'queued');
  first.stop.trigger('аварийный стоп');
  first.runtime.close(); // владелец закрыл приложение после стопа

  const brain = scriptedBrain([
    planReply(C_PLAN),
    toolReply(['workspace_write', { path: 'notes/c.md', content: 'c' }], ['step_done', { summary: 'c' }]),
    planReply([{ title: 'B' }]),
    doneReply('B'),
  ]);
  const second = build(t, { base, clock, brain, answer: ownerSays('once') });
  assert.equal(second.task(a).status, 'paused');
  assert.deepEqual([second.task(b).status, second.task(b).reason], ['paused', QUEUED_STOP_REASON], 'B на диске — на паузе, не «в очереди»');
  const c = await second.runtime.submitTask({ goal: C_GOAL });
  assert.equal(c.ok, true, c.summary);
  await second.runtime.whenIdle();
  assert.equal(brain.requests[0].taskId, c.data.id, `первой запущена ${brain.requests[0].taskId}, а не C`);
  assert.deepEqual(brain.requests.map((r) => r.taskId), [c.data.id, c.data.id], 'B не запускалась');
  assert.equal(second.task(c.data.id).status, 'done');
  assert.equal(second.task(b).status, 'paused', 'B без нового подтверждения не запускается');
});

// Резерв запроса, прерванного падением процесса, становится расходом один раз: второй перезапуск его не добавляет.
test('ревью R3: прерванный резерв учитывается один раз и после двух перезапусков', async (t) => {
  const base = tmpBase(t);
  const clock = makeClock();
  const hang = deferred();
  const first = build(t, { base, clock, answer: ownerSays('once'), script: [planReply(TEA_PLAN), hang.step] });
  const { data: { id } } = await first.runtime.submitTask({ goal: GOAL });
  await waitFor(() => hang.release !== null, 'шаг ждёт модель');
  const spent = first.runtime.meter.spentForTask(id);
  const inFlight = first.runtime.meter.reservedUsd;
  assert.ok(inFlight > 0);
  first.runtime.close();
  const second = build(t, { base, clock, brain: scriptedBrain([]) });
  near(second.runtime.meter.spentForTask(id), spent + inFlight, 'после первого перезапуска');
  second.runtime.close();
  const third = build(t, { base, clock, brain: scriptedBrain([]) });
  near(third.runtime.meter.spentForTask(id), spent + inFlight, 'после второго — без повторного учёта');
  near(third.runtime.meter.spentToday(), second.runtime.meter.spentToday(), 'день тоже');
  assert.equal(third.runtime.meter.reservedUsd, 0);
  assert.equal(third.task(id).status, 'paused');
});
