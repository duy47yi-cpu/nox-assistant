'use strict';

// Исполнитель автономной задачи: план → шаги → проверка → отчёт. Стоп, мандат, лимиты и подтверждения
// проверяет код исполнителя; модель здесь подставная (сценарий ответов со счётчиком вызовов).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../src/tasks/model');
const { TaskQueue, recoverAfterRestart } = require('../src/tasks/queue');
const { taskTools } = require('../src/tasks/tools');
const { createMandate } = require('../src/tasks/mandate');
const { createExecutor, renderReport, finalSummary } = require('../src/tasks/executor');
const { StopSwitch } = require('../src/control/stop');
const { ApprovalBroker } = require('../src/policy/approvals');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');

const NOW = Date.UTC(2026, 9, 30, 12, 0);
const HOUR = 60 * 60 * 1000;
const GOAL = 'Собрать заметку о чае в notes/tea.md и сводку в reports/tea.md';

// Этап 3: новый план обязан содержать критерии приёмки. Сценарии, написанные до этого, их не передают —
// подставная модель добавляет их сама (если ключа criteria в ответе нет): требование — цель задачи целиком
// (из запроса плана), по критерию на каждую проверку шага, кроме file_absent (это предусловие «файла ещё нет»,
// а не результат); без проверок — один критерий «оценка модели». Итоги старых сценариев от этого не меняются.
function planGoal(req) {
  const ask = (req.messages || []).find((m) => m.role === 'user' && /^Составь план для цели: /.test(String(m.content)));
  return ask ? String(ask.content).replace(/^Составь план для цели: /, '') : '';
}

function autoCriteria(steps, goal) {
  const checks = (Array.isArray(steps) ? steps : []).filter((s) => s && s.check && s.check.kind !== 'file_absent');
  if (!checks.length) return [{ requirement: goal, text: 'итог по словам модели', manual: { kind: 'model_only', reason: 'объективной проверки в сценарии нет' } }];
  return checks.map((s) => ({ requirement: goal, text: String(s.title), check: s.check }));
}

function withCriteria(reply, req) {
  if (!reply || !Array.isArray(reply.toolCalls)) return reply;
  return {
    ...reply,
    toolCalls: reply.toolCalls.map((c) => (c.name === 'task_plan_submit' && c.args && typeof c.args === 'object' && !('criteria' in c.args)
      ? { ...c, args: { ...c.args, criteria: autoCriteria(c.args.steps, planGoal(req)) } }
      : c)),
  };
}

// Подставная модель. Элемент сценария — ответ {content?, toolCalls?, stats?}, ошибка (бросается)
// или функция (req) → ответ. Каждый вызов записывается; tick сдвигает часы на время «ответа».
function scriptedBrain(script, { clock, tick = 0 } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async chat(req) {
      calls.push({
        purpose: req.purpose,
        taskId: req.taskId,
        maxTokens: req.maxTokens,
        tools: (req.tools || []).map((t) => t.function.name),
        messages: req.messages.slice(),
      });
      if (tick) clock.advance(tick);
      if (i >= script.length) throw new Error('сценарий модели исчерпан');
      let next = script[i];
      i += 1;
      if (typeof next === 'function') next = await next(req);
      if (next instanceof Error) throw next;
      next = withCriteria(next, req);
      return {
        content: next.content || '',
        reasoningContent: null,
        toolCalls: (next.toolCalls || []).map((c, k) => ({
          id: c.id || `call${calls.length}_${k}`, name: c.name, args: c.args ?? {}, argsError: c.argsError || null,
        })),
        stats: next.stats === undefined ? { promptTokens: 100, completionTokens: 20 } : next.stats,
      };
    },
  };
}

const planReply = (steps) => ({ toolCalls: [{ name: 'task_plan_submit', args: { steps } }] });
const toolReply = (...calls) => ({ toolCalls: calls.map(([name, args]) => ({ name, args })) });
const doneReply = (summary = 'готово') => toolReply(['step_done', { summary }]);

// Подделка: инструмент из белого списка мандата с пометкой requiresApproval: true — только такие ждут владельца.
// Настоящие инструменты рабочей папки так не помечены, workspace_write — тоже.
const ASKING = {
  name: 'web_fetch',
  risk: 'T1',
  requiresApproval: true,
  description: 'Прочитать веб-страницу (подделка: каждый вызов — с подтверждения владельца).',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
};
const ASKING_RESULT = { ok: true, summary: 'страница прочитана (подделка)', data: { text: 'улун' } };
const WITH_ASKING = { tools: ['workspace_read', 'workspace_write', 'web_fetch'] };
const fetchReply = (url = 'https://example.com/tea') => toolReply(['web_fetch', { url }]);

async function waitFor(cond, what) {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`не дождались: ${what}`);
}

async function ticks(n = 20) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

// Песочница во временной папке, настоящие инструменты рабочей папки, очередь, стоп и подтверждения как в main.js.
function setup(t, opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-exec-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  for (const dir of ['notes', 'reports']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const index = new WorkspaceIndex(root);
  const resolve = (rel) => index.resolveInside(rel);
  const ws = workspaceTools(index);
  let ms = opts.now ?? NOW;
  const clock = { now: () => ms, advance: (d) => { ms += d; }, set: (v) => { ms = v; } };
  const brain = scriptedBrain(opts.script || [], { clock, tick: opts.tick || 0 });
  const runs = [];
  const runTool = async (name, args, ctx) => {
    runs.push({ name, args });
    if (opts.runTool) return opts.runTool(name, args, ctx);
    const fake = opts.fakes && opts.fakes[name];
    if (fake !== undefined) return typeof fake === 'function' ? fake(args) : fake;
    const tool = ws.find((x) => x.name === name);
    if (tool) return tool.run(args);
    return name === ASKING.name ? { ...ASKING_RESULT } : { ok: false, summary: `нет инструмента ${name}` };
  };
  const queue = new TaskQueue({ now: clock.now });
  const stop = new StopSwitch();
  const approvals = opts.approvals || new ApprovalBroker();
  if (opts.wireStop !== false) {
    // Как в main.js: стоп отклоняет ожидающие подтверждения и ставит выполняющуюся задачу на паузу.
    stop.onTrigger(({ reason }) => {
      approvals.cancelAll();
      queue.stopAll(reason);
    });
  }
  const journal = [];
  const events = [];
  let saves = 0;
  const executor = createExecutor({
    queue,
    saveTasks: opts.saveTasks || (() => { saves += 1; }),
    brain,
    runTool,
    toolSpecs: [...ws, ...(opts.extraSpecs || [])],
    approvals,
    stop,
    journal: { append: (e) => journal.push(e) },
    resolve,
    emit: (e) => {
      events.push(e);
      if (opts.onEvent) opts.onEvent(e);
    },
    costOf: opts.costOf || (() => null),
    now: clock.now,
    sandboxReportsDir: 'reports',
    ...(opts.executorOpts || {}),
  });
  // Задача с мандатом; по умолчанию мандат подтверждён владельцем.
  const addTask = (id = 'm1', { mandate = {}, approved = true, priority = 0 } = {}) => {
    const m = createMandate({ goal: GOAL, tools: ['workspace_read', 'workspace_write'], sandboxRoot: root, now: NOW, ...mandate });
    if (approved) m.approvedBy = 'владелец';
    return queue.add(model.createTask({ id, title: `Задача ${id}`, goal: GOAL, now: NOW, priority, mandate: m }));
  };
  return { base, root, resolve, clock, brain, runs, queue, stop, approvals, journal, events, saves: () => saves, executor, addTask };
}

test('проверки и отчёт используют папку самой задачи, даже если одноимённый файл есть в другом пространстве', async (t) => {
  let indexB;
  const h = setup(t, {
    script: [
      planReply([{ title: 'Записать', check: { kind: 'file_contains', path: 'notes/tea.md', text: 'улун' } }]),
      toolReply(['workspace_write', { path: 'notes/tea.md', content: 'Чай: улун' }]),
      doneReply('записано'),
    ],
    executorOpts: { resolve: (rel, taskId) => {
      if (taskId !== 'spaceB') throw new Error('не указан контекст задачи');
      return indexB.resolveInside(rel);
    } },
    runTool: (name, args, ctx) => {
      assert.equal(ctx.taskId, 'spaceB');
      return workspaceTools(indexB).find((tool) => tool.name === name).run(args);
    },
  });
  const other = path.join(h.base, 'workspaceB');
  fs.mkdirSync(path.join(other, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(h.root, 'notes', 'tea.md'), 'другой проект');
  indexB = new WorkspaceIndex(other);
  const mandate = createMandate({ goal: GOAL, tools: ['workspace_write'], sandboxRoot: other, now: NOW });
  mandate.approvedBy = 'владелец';
  h.queue.add(model.createTask({ id: 'spaceB', title: 'Другое пространство', goal: GOAL, now: NOW, mandate }));
  const result = await h.executor.submit('spaceB');
  assert.equal(result.status, 'done');
  assert.equal(fs.readFileSync(path.join(other, 'notes', 'tea.md'), 'utf8'), 'Чай: улун');
  assert.equal(fs.readFileSync(path.join(h.root, 'notes', 'tea.md'), 'utf8'), 'другой проект');
  assert.ok(fs.existsSync(path.join(other, 'reports', 'task-spaceB.md')));
  assert.equal(fs.existsSync(path.join(h.root, 'reports', 'task-spaceB.md')), false);
});

test('следующий шаг получает проверенный результат предыдущего шага', async (t) => {
  const h = setup(t, { script: [
    planReply([
      { title: 'Записать заметку', check: { kind: 'file_contains', path: 'notes/tea.md', text: 'улун' } },
      { title: 'Подготовить сводку', check: { kind: 'file_exists', path: 'reports/tea.md' } },
    ]),
    toolReply(['workspace_write', { path: 'notes/tea.md', content: 'Чай: улун.' }]),
    doneReply('Сохранил заметку об улуне'),
    doneReply('Сводка'),
    doneReply('Сводка'),
    doneReply('Сводка'),
  ] });
  h.addTask();
  h.queue.addNote('m1', { id: 'note1', kind: 'decision', text: 'Использовать улун', createdAt: NOW });
  await h.executor.submit('m1');
  const prompt = h.brain.calls[3].messages[0].content;
  assert.match(prompt, /Сохранил заметку об улуне/);
  assert.match(prompt, /notes\/tea\.md/);
  assert.match(prompt, /confirmed|подтверждено/i);
  assert.match(prompt, /Использовать улун/);
});

test('полный путь: задача без плана → план → шаги → проверка → «завершено», отчёт файлом в песочнице', async (t) => {
  const h = setup(t, {
    costOf: () => 0.0123,
    script: [
      planReply([
        { title: 'Записать заметку о чае', check: { kind: 'file_contains', path: 'notes/tea.md', text: 'улун' } },
        { title: 'Записать сводку', check: { kind: 'file_exists', path: 'reports/tea.md' } },
      ]),
      toolReply(['workspace_write', { path: 'notes/tea.md', content: 'Чай: улун, пуэр.' }]),
      doneReply('заметка записана'),
      toolReply(['workspace_write', { path: 'reports/tea.md', content: '# Сводка\nулун' }], ['step_done', { summary: 'сводка записана' }]),
    ],
  });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  const task = h.queue.get('m1');

  assert.equal(out.status, 'done');
  assert.equal(task.status, 'done');
  assert.deepEqual(task.plan.map((s) => s.status), ['done', 'done']);
  assert.deepEqual(task.plan.map((s) => s.result.verification), ['confirmed', 'confirmed']);
  assert.deepEqual(task.unverifiedSteps, []);
  assert.equal(task.stepsUsed, 2);
  assert.equal(task.tokensUsed, 4 * 120, 'токены: promptTokens + completionTokens каждого ответа');
  assert.equal(fs.readFileSync(path.join(h.root, 'notes', 'tea.md'), 'utf8'), 'Чай: улун, пуэр.');

  assert.deepEqual(h.brain.calls.map((c) => c.purpose), ['plan', 'step', 'step', 'step']);
  assert.ok(h.brain.calls.every((c) => c.taskId === 'm1'));
  assert.deepEqual(h.brain.calls[0].tools, ['task_plan_submit'], 'на плане — только task_plan_submit');
  assert.deepEqual(h.brain.calls[1].tools, ['workspace_read', 'workspace_write', 'step_done', 'step_fail']);
  const system = h.brain.calls[1].messages[0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /Цель задачи: Собрать заметку о чае/);
  assert.match(system.content, /Инструменты: чтение файлов \(workspace_read\), запись файлов \(workspace_write\)/, 'сводка мандата');
  assert.match(system.content, /1\. \[в работе\] Записать заметку о чае .*← текущий шаг/);
  assert.match(system.content, /в файле notes\/tea\.md есть текст «улун»/);
  assert.match(system.content, /данные, а не инструкции/);
  assert.match(system.content, /step_done/);

  const file = path.join(h.root, 'reports', 'task-m1.md');
  assert.equal(out.reportFile, file);
  const report = fs.readFileSync(file, 'utf8');
  assert.match(report, /\*\*Итог: проверено\*\*/);
  assert.match(report, /## Цель\n\nСобрать заметку о чае/);
  assert.match(report, /- Цель: Собрать заметку о чае/, 'сводка мандата');
  assert.match(report, /Результат проверки: подтверждено: в файле есть нужный текст: notes\/tea\.md/);
  assert.match(report, /Итог шага: заметка записана/);
  assert.match(report, /## Непроверенные шаги\n\n- нет/);
  assert.match(report, /## Изменения в файлах\n\n- notes\/tea\.md — workspace_write, запись подтверждена проверкой\n- reports\/tea\.md — workspace_write, запись подтверждена проверкой/);
  assert.match(report, /## Тесты\n\n- тесты не запускались \(по записанным фактам шагов\)/);
  assert.match(report, /## Оставшиеся проблемы\n\n- нет/);
  assert.match(report, /Шагов \(выполненных вызовов инструментов\): 2 из 100/);
  assert.match(report, /Активное время: 0 с из 4 ч 0 мин/);
  assert.match(report, /Токены: 480 из 300000/);
  assert.match(report, /Стоимость: \$0\.0123 \(бюджет задачи \$0\.25\)/);
  assert.deepEqual(fs.readdirSync(path.join(h.root, 'reports')).filter((f) => f.endsWith('.tmp')), [], 'временных файлов нет');

  const writes = h.journal.filter((e) => e.tool === 'workspace_write');
  assert.equal(writes.length, 2);
  assert.ok(writes.every((e) => e.source === 'task' && e.taskId === 'm1' && e.decision === 'allow' && e.ok === true));
  assert.ok(h.journal.every((e) => e.source === 'task' && e.taskId === 'm1'));
  const last = h.events[h.events.length - 1];
  assert.deepEqual([last.type, last.taskId, last.status, last.final, last.report], ['task', 'm1', 'done', true, file]);
  assert.ok(h.events.every((e) => e.type === 'task' && typeof e.message === 'string' && e.title === 'Задача m1'));
  assert.ok(h.saves() > 0);
  assert.equal(h.executor.isBusy(), false);
});

test('шаг без проверки: итог «выполнено, но не проверено», в отчёте явный список непроверенных шагов', async (t) => {
  const h = setup(t, { script: [planReply([{ title: 'Продумать структуру заметки' }]), doneReply('структура продумана')] });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  const task = h.queue.get('m1');
  assert.equal(task.status, 'unverified');
  assert.equal(model.humanStatus(task), 'выполнено, но не проверено');
  assert.deepEqual(task.unverifiedSteps, ['s1']);
  assert.equal(task.plan[0].status, 'done');
  const report = fs.readFileSync(out.reportFile, 'utf8');
  assert.match(report, /\*\*Итог: выполнено, но не проверено\*\*/);
  assert.match(report, /## Непроверенные шаги\n\n- s1\. Продумать структуру заметки: выполнен без объективной проверки, результат не проверен/);
  assert.match(report, /Результат проверки: не проверено: у шага нет объективной проверки/);
  assert.match(report, /Стоимость: не учтена/);
  assert.equal(h.events.at(-1).message, 'итог: выполнено, но не проверено');
});

test('подтверждение (requiresApproval: true): пока ждём, модель не вызывается и время не идёт; «отказ» — ход дальше, «один раз» — выполняется', async (t) => {
  const h = setup(t, {
    tick: 1000,
    extraSpecs: [ASKING],
    script: [
      planReply([{ title: 'Прочитать страницу и записать заметку', check: { kind: 'file_contains', path: 'notes/tea.md', text: 'улун' } }]),
      fetchReply(),
      fetchReply(),
      toolReply(['workspace_write', { path: 'notes/tea.md', content: 'улун' }], ['step_done', { summary: 'заметка записана' }]),
    ],
  });
  h.addTask('m1', { mandate: WITH_ASKING });
  const running = h.executor.submit('m1');

  await waitFor(() => h.approvals.list().length === 1, 'первый запрос подтверждения');
  const [ask] = h.approvals.list();
  assert.deepEqual(
    { id: ask.id, name: ask.name, risk: ask.risk, reason: ask.reason, allowSession: ask.allowSession, url: ask.args.url },
    { id: 'm1:call2_0', name: 'web_fetch', risk: 'T1', reason: 'инструмент требует подтверждения владельца', allowSession: false, url: 'https://example.com/tea' },
  );
  assert.equal(h.queue.get('m1').status, 'waiting_approval');
  assert.equal(h.brain.calls.length, 2);
  h.clock.advance(HOUR); // владелец думает час
  await ticks();
  assert.equal(h.brain.calls.length, 2, 'пока ждём подтверждения — модель не вызывается');
  assert.equal(h.runs.length, 0);

  h.approvals.respond(ask.id, 'reject');
  await waitFor(() => h.approvals.list().length === 1 && h.approvals.list()[0].id !== ask.id, 'второй запрос подтверждения');
  assert.equal(h.brain.calls.length, 3, 'после отказа ход продолжился');
  assert.match(h.brain.calls[2].messages.at(-1).content, /отклонено владельцем/);
  assert.equal(h.runs.length, 0, 'отклонённое не выполнено');
  assert.equal(h.queue.get('m1').failures.s1, undefined, 'отказ владельца — не ошибка шага');

  h.approvals.respond(h.approvals.list()[0].id, 'once');
  const out = await running;
  assert.equal(out.status, 'done');
  assert.deepEqual(h.runs.map((r) => r.name), ['web_fetch', 'workspace_write'], 'после «один раз» инструмент выполнен; workspace_write — без вопроса');
  assert.match(h.brain.calls[3].messages.at(-1).content, /страница прочитана \(подделка\)/);
  const task = h.queue.get('m1');
  assert.equal(task.stepsUsed, 2);
  assert.equal(task.activeMs, 4000, 'четыре ответа модели по 1 с; час ожидания не засчитан');
  assert.deepEqual(h.journal.filter((e) => e.tool === 'web_fetch').map((e) => e.decision), ['ask', 'reject', 'ask', 'once']);
  assert.deepEqual(h.journal.filter((e) => e.tool === 'workspace_write').map((e) => e.decision), ['allow']);
  assert.ok(task.log.some((l) => l.event === 'статус: waiting_approval'));
});

test('workspace_write поверх существующего файла вне reports: отказ самого инструмента, подтверждения не спрашивают', async (t) => {
  const h = setup(t, {
    script: [
      planReply([
        { title: 'Обновить сводку', check: { kind: 'file_contains', path: 'reports/tea.md', text: 'новое' } },
        { title: 'Обновить заметку', check: { kind: 'file_contains', path: 'notes/old.md', text: 'новое' } },
      ]),
      toolReply(['workspace_write', { path: 'reports/tea.md', content: 'новое' }], ['step_done', { summary: 'сводка обновлена' }]),
      toolReply(['workspace_write', { path: 'notes/old.md', content: 'новое' }]),
      toolReply(['step_fail', { reason: 'заметку перезаписать нельзя' }]),
    ],
  });
  fs.writeFileSync(path.join(h.root, 'reports', 'tea.md'), 'старое', 'utf8');
  fs.writeFileSync(path.join(h.root, 'notes', 'old.md'), 'старое', 'utf8');
  h.addTask('m1', { mandate: { limits: { maxFailuresPerStep: 1 } } });
  const out = await h.executor.submit('m1');

  assert.equal(h.journal.filter((e) => e.decision === 'ask').length, 0, 'владельца не спрашивали');
  assert.equal(h.approvals.list().length, 0);
  assert.ok(!h.queue.get('m1').log.some((l) => l.event === 'статус: waiting_approval'));
  assert.ok(!h.events.some((e) => /^ждёт подтверждения/.test(e.message)));
  assert.deepEqual(h.runs.map((r) => r.args.path), ['reports/tea.md', 'notes/old.md'], 'инструмент вызван и решил сам');
  assert.equal(fs.readFileSync(path.join(h.root, 'reports', 'tea.md'), 'utf8'), 'новое', 'в reports перезапись проходит');
  assert.equal(fs.readFileSync(path.join(h.root, 'notes', 'old.md'), 'utf8'), 'старое', 'вне reports инструмент не перезаписал');
  const refused = h.journal.filter((e) => e.tool === 'workspace_write').at(-1);
  assert.deepEqual([refused.decision, refused.ok, refused.summary], ['allow', false, 'перезаписывать можно только в reports']);
  assert.match(h.brain.calls[3].messages.at(-1).content, /перезаписывать можно только в reports/, 'модель получила отказ инструмента');
  assert.equal(out.status, 'blocked');
  assert.deepEqual(h.queue.get('m1').plan.map((s) => s.status), ['done', 'failed']);
});

test('стоп во время ожидания подтверждения: инструмент не выполнен, задача на паузе, модель больше не вызывается', async (t) => {
  const h = setup(t, {
    extraSpecs: [ASKING],
    script: [planReply([{ title: 'Прочитать страницу' }]), fetchReply()],
  });
  h.addTask('m1', { mandate: WITH_ASKING });
  const running = h.executor.submit('m1');
  await waitFor(() => h.approvals.list().length === 1, 'запрос подтверждения');
  h.stop.trigger('аварийный стоп');
  const out = await running;
  assert.equal(h.runs.length, 0, 'инструмент не выполнен');
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m1').reason, 'аварийный стоп');
  assert.equal(h.brain.calls.length, 2);
  assert.equal(out.reportFile, null, 'после аварийного стопа новых действий нет, отчёта тоже');
  assert.ok(h.journal.some((e) => e.tool === 'web_fetch' && e.decision === 'stop'));
  assert.equal(h.executor.isBusy(), false);
  assert.equal(h.executor.kick(), null, 'пока стоп включён, исполнитель ничего не берёт');
});

test('стоп во время ожидания: одобренное уже после стопа действие всё равно не выполняется', async (t) => {
  let answer = null;
  const approvals = {
    request: () => new Promise((r) => { answer = r; }),
    respond: () => false, // этот брокер не принимает «отказ» от стопа: решение придёт позже
    cancelAll: () => 0,
  };
  const h = setup(t, {
    approvals,
    wireStop: false, // stopAll не подключён: на паузу задачу ставит сам исполнитель
    extraSpecs: [ASKING],
    script: [planReply([{ title: 'Прочитать страницу' }]), fetchReply()],
  });
  h.addTask('m1', { mandate: WITH_ASKING });
  const running = h.executor.submit('m1');
  await waitFor(() => answer !== null, 'запрос подтверждения');
  h.stop.trigger('аварийный стоп');
  answer('once');
  const out = await running;
  assert.equal(h.runs.length, 0);
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m1').reason, 'аварийный стоп');
  assert.ok(h.journal.some((e) => e.summary === 'не выполнено: аварийный стоп во время ожидания подтверждения'));
  const events = h.queue.get('m1').log.map((l) => l.event);
  assert.deepEqual(events.slice(events.lastIndexOf('статус: waiting_approval')), ['статус: waiting_approval', 'статус: paused'], 'из ожидания — сразу на паузу, не в работу');
});

test('стоп до вызова модели: модель не вызвана', async (t) => {
  // Стоп включён до постановки: задача в очередь не ставится (остаётся черновиком), ничего не стартует.
  const a = setup(t, { script: [planReply([{ title: 'x' }])] });
  a.addTask('m1');
  a.stop.trigger('аварийный стоп');
  assert.equal(await a.executor.submit('m1'), null);
  assert.equal(a.queue.get('m1').status, 'draft', 'при включённом стопе задача не становится «в очереди»');
  assert.equal(a.brain.calls.length, 0);
  // Задача, уже стоявшая «в очереди» (стоп без stopAll в подписчике), при submit во время стопа — на паузу.
  const q = setup(t, { wireStop: false, script: [planReply([{ title: 'x' }])] });
  q.addTask('m1');
  q.queue.enqueue('m1');
  q.stop.trigger('аварийный стоп');
  assert.equal(await q.executor.submit('m1'), null);
  assert.deepEqual([q.queue.get('m1').status, q.queue.get('m1').reason], ['paused', 'аварийный стоп: задача в очереди ждёт вашего решения']);
  assert.equal(q.brain.calls.length, 0);

  // Стоп сразу после старта: проверка перед вызовом модели его видит.
  const b = setup(t, {
    script: [planReply([{ title: 'x' }])],
    onEvent: (e) => { if (e.message === 'запущена') b.stop.trigger('аварийный стоп'); },
  });
  b.addTask('m1');
  const out = await b.executor.submit('m1');
  assert.equal(b.brain.calls.length, 0);
  assert.equal(out.status, 'paused');
  assert.equal(b.queue.get('m1').reason, 'аварийный стоп');

  // То же без stopAll в подписчике стопа: исполнитель сам проверяет стоп и ставит задачу на паузу.
  const c = setup(t, {
    wireStop: false,
    script: [planReply([{ title: 'x' }])],
    onEvent: (e) => { if (e.message === 'запущена') c.stop.trigger('аварийный стоп'); },
  });
  c.addTask('m1');
  const alone = await c.executor.submit('m1');
  assert.equal(c.brain.calls.length, 0);
  assert.equal(alone.status, 'paused');
  assert.equal(c.queue.get('m1').reason, 'аварийный стоп');
});

test('стоп во время запроса к модели: запрос прерван сигналом (AbortError), задача на паузе, дальше ничего', async (t) => {
  let started = false;
  const h = setup(t, {
    wireStop: false,
    script: [
      (req) => new Promise((resolve, reject) => {
        started = true;
        req.signal.addEventListener('abort', () => reject(Object.assign(new Error('запрос отменён'), { name: 'AbortError' })), { once: true });
      }),
    ],
  });
  h.addTask('m1');
  const running = h.executor.submit('m1');
  await waitFor(() => started, 'запрос плана');
  h.stop.trigger('аварийный стоп');
  const out = await running;
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m1').reason, 'аварийный стоп');
  assert.equal(h.brain.calls.length, 1);
  assert.equal(h.queue.get('m1').plan.length, 0);
  assert.ok(h.journal.some((e) => e.tool === 'модель' && e.decision === 'stop'));
});

test('истёкший мандат: пауза «срок мандата истёк», модель не вызвана; истёк по ходу — инструмент не запущен', async (t) => {
  const a = setup(t, { now: NOW + 25 * HOUR, script: [planReply([{ title: 'x' }])] });
  a.addTask('m1'); // мандат выдан в NOW на сутки
  const out = await a.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.equal(a.queue.get('m1').reason, 'срок мандата истёк');
  assert.equal(a.brain.calls.length, 0);

  const b = setup(t, {
    script: [
      planReply([{ title: 'Записать заметку' }]),
      () => {
        b.clock.set(NOW + 25 * HOUR); // пока модель отвечала, срок мандата вышел
        return toolReply(['workspace_write', { path: 'notes/a.md', content: 'x' }]);
      },
    ],
  });
  b.addTask('m1');
  const late = await b.executor.submit('m1');
  assert.equal(late.status, 'paused');
  assert.equal(b.queue.get('m1').reason, 'срок мандата истёк');
  assert.equal(b.runs.length, 0);
  assert.equal(fs.existsSync(path.join(b.root, 'notes', 'a.md')), false);
});

test('инструмент вне мандата (shell_run): модели не предлагается, вызов отклонён как ошибка шага, runTool не вызван', async (t) => {
  const h = setup(t, {
    extraSpecs: [
      { name: 'shell_run', description: 'PowerShell', risk: 'T2', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
      { type: 'function', function: { name: 'web_fetch', description: 'страница', parameters: { type: 'object', properties: {} } } },
    ],
    script: [
      planReply([{ title: 'Записать заметку' }]),
      toolReply(['shell_run', { command: 'Remove-Item C:\\ -Recurse' }]),
      toolReply(['workspace_write', { path: 'notes/a.md', content: 'чай' }]),
      doneReply(),
    ],
  });
  h.addTask('m1');
  h.queue.get('m1').mandate.tools.push('shell_run'); // даже дописанный вручную мандат не открывает shell_run
  const out = await h.executor.submit('m1');
  assert.deepEqual(h.brain.calls[1].tools, ['workspace_read', 'workspace_write', 'step_done', 'step_fail'], 'ни shell_run, ни web_fetch вне мандата');
  assert.deepEqual(h.runs.map((r) => r.name), ['workspace_write']);
  const deny = h.journal.find((e) => e.tool === 'shell_run');
  assert.equal(deny.decision, 'deny');
  assert.match(deny.summary, /^отказ: инструмент «shell_run» запрещён/);
  const obs = h.brain.calls[2].messages.at(-1);
  assert.equal(obs.role, 'tool');
  assert.match(obs.content, /отказ: инструмент «shell_run» запрещён/);
  assert.ok(h.queue.get('m1').log.some((l) => l.event === 'шаг s1: failed'), 'отказ — ошибка шага');
  assert.equal(out.status, 'unverified');
});

test('подтверждение — только при requiresApproval === true: «1» не считается; метка в формате OpenAI — на элементе или в function', async (t) => {
  const spec = (name, extra = {}) => ({ name, description: name, parameters: { type: 'object', properties: {} }, ...extra });
  const h = setup(t, {
    extraSpecs: [
      spec('web_wiki', { requiresApproval: 1 }), // не true: подтверждения нет
      { type: 'function', function: spec('web_search', { requiresApproval: true }) }, // метка внутри function
      { type: 'function', requiresApproval: true, function: spec('web_fetch') }, // метка на элементе
    ],
    runTool: (name) => ({ ok: true, summary: `${name}: ок` }),
    script: [
      planReply([{ title: 'Найти справку' }]),
      toolReply(['web_wiki', { query: 'чай' }], ['web_search', { query: 'чай' }], ['web_fetch', { url: 'https://example.com' }]),
      doneReply(),
    ],
  });
  h.addTask('m1', { mandate: { tools: ['web_wiki', 'web_search', 'web_fetch'] } });
  const running = h.executor.submit('m1');
  await waitFor(() => h.approvals.list().length === 1, 'подтверждение web_search');
  assert.deepEqual(h.runs.map((r) => r.name), ['web_wiki'], 'web_wiki выполнен без вопроса');
  assert.equal(h.approvals.list()[0].name, 'web_search');
  h.approvals.respond(h.approvals.list()[0].id, 'once');
  await waitFor(() => h.approvals.list().length === 1 && h.approvals.list()[0].name === 'web_fetch', 'подтверждение web_fetch');
  h.approvals.respond(h.approvals.list()[0].id, 'once');
  const out = await running;
  assert.equal(out.status, 'unverified');
  assert.deepEqual(h.runs.map((r) => r.name), ['web_wiki', 'web_search', 'web_fetch']);
  assert.deepEqual(h.journal.filter((e) => e.decision === 'ask').map((e) => e.tool), ['web_search', 'web_fetch']);
});

test('инструмент мандата без описания: модели не предлагается, вызов отклонён как ошибка шага, runTool не вызван', async (t) => {
  const h = setup(t, {
    script: [
      planReply([{ title: 'Найти справку' }]),
      toolReply(['web_search', { query: 'чай' }]),
      doneReply(),
    ],
  });
  h.addTask('m1', { mandate: { tools: ['workspace_read', 'web_search'] } }); // web_search в мандате, но не описан
  const out = await h.executor.submit('m1');
  assert.deepEqual(h.brain.calls[1].tools, ['workspace_read', 'step_done', 'step_fail']);
  assert.equal(h.runs.length, 0);
  const deny = h.journal.find((e) => e.tool === 'web_search');
  assert.equal(deny.decision, 'deny');
  assert.match(deny.summary, /исполнителю не описан/);
  assert.ok(h.queue.get('m1').log.some((l) => l.event === 'шаг s1: failed'));
  assert.equal(out.status, 'unverified');
});

test('выход за папку: resolve бросает — отказ шага, инструмент не вызван; три отказа подряд блокируют', async (t) => {
  const h = setup(t, {
    script: [
      planReply([{ title: 'Записать заметку' }]),
      toolReply(['workspace_write', { path: '../outside.md', content: 'x' }]),
      toolReply(['workspace_read', { path: path.join(os.tmpdir(), 'secret.md') }]),
      toolReply(['step_fail', { reason: 'нет доступа' }]),
    ],
  });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  assert.equal(h.runs.length, 0);
  assert.equal(fs.existsSync(path.join(h.base, 'outside.md')), false);
  const denies = h.journal.filter((e) => e.decision === 'deny');
  assert.equal(denies.length, 2);
  assert.ok(denies.every((e) => /не разрешён: путь вне рабочей папки/.test(e.summary)));
  assert.equal(out.status, 'blocked');
  assert.match(h.queue.get('m1').reason, /не получился 3 раза подряд/);
});

test('лимит шагов: после maxSteps выполненных инструментов — пауза «лимит шагов», лишний вызов не выполнен', async (t) => {
  const h = setup(t, {
    script: [
      planReply([{ title: 'Прочитать заметки' }]),
      toolReply(['workspace_read', { path: 'notes/a.md' }], ['workspace_read', { path: 'notes/a.md' }], ['workspace_read', { path: 'notes/a.md' }]),
    ],
  });
  fs.writeFileSync(path.join(h.root, 'notes', 'a.md'), 'чай', 'utf8');
  h.addTask('m1', { mandate: { limits: { maxSteps: 2 } } });
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m1').reason, 'лимит шагов');
  assert.equal(h.runs.length, 2);
  assert.equal(h.queue.get('m1').stepsUsed, 2);
  assert.equal(h.brain.calls.length, 2);
  const report = fs.readFileSync(out.reportFile, 'utf8');
  assert.match(report, /\*\*Итог: не выполнено \(на паузе: лимит шагов\)\*\*/);
  assert.match(report, /Шагов \(выполненных вызовов инструментов\): 2 из 2/);
  assert.ok(h.journal.some((e) => e.decision === 'pause' && e.summary === 'пауза: лимит шагов'));
});

test('наблюдение для модели обрезается до 1500 символов', async (t) => {
  const h = setup(t, {
    script: [planReply([{ title: 'Прочитать' }]), toolReply(['workspace_read', { path: 'notes/big.md' }]), doneReply()],
  });
  fs.writeFileSync(path.join(h.root, 'notes', 'big.md'), 'чай '.repeat(2000), 'utf8');
  h.addTask('m1');
  await h.executor.submit('m1');
  const obs = h.brain.calls[2].messages.at(-1);
  assert.equal(obs.role, 'tool');
  assert.ok(obs.content.endsWith(' …(обрезано)'));
  assert.equal(obs.content.length, 1500 + ' …(обрезано)'.length);
});

test('лимит токенов: пауза «лимит токенов» до следующего вызова модели', async (t) => {
  const h = setup(t, { script: [{ ...planReply([{ title: 'x' }]), stats: { promptTokens: 120, completionTokens: 40 } }] });
  h.addTask('m1', { mandate: { limits: { maxTokens: 150 } } });
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m1').reason, 'лимит токенов');
  assert.equal(h.queue.get('m1').tokensUsed, 160);
  assert.equal(h.brain.calls.length, 1);
  assert.equal(h.brain.calls[0].maxTokens, 150, 'ответ модели ограничен остатком токенов задачи');
});

test('лимит активного времени: пауза «лимит времени», инструмент не запущен', async (t) => {
  const h = setup(t, {
    tick: 3000,
    script: [planReply([{ title: 'Прочитать' }]), toolReply(['workspace_read', { path: 'notes/a.md' }]), doneReply()],
  });
  h.addTask('m1', { mandate: { limits: { maxActiveMs: 5000 } } });
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m1').reason, 'лимит времени');
  assert.equal(h.queue.get('m1').activeMs, 6000);
  assert.equal(h.runs.length, 0);
  assert.equal(h.brain.calls.length, 2);
});

test('ошибка бюджета от модели: пауза с причиной, задача не заблокирована и шаг не провален', async (t) => {
  const a = setup(t, { script: [Object.assign(new Error('Бюджет исчерпан'), { code: 'budget', reason: 'дневной бюджет $1 исчерпан' })] });
  a.addTask('m1');
  const out = await a.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.equal(a.queue.get('m1').reason, 'дневной бюджет $1 исчерпан');

  const b = setup(t, { script: [planReply([{ title: 'x' }]), Object.assign(new Error('бюджет задачи исчерпан'), { code: 'budget' })] });
  b.addTask('m1');
  const onStep = await b.executor.submit('m1');
  assert.equal(onStep.status, 'paused');
  assert.equal(b.queue.get('m1').reason, 'бюджет задачи исчерпан', 'без reason — текст ошибки');
  assert.deepEqual(b.queue.get('m1').failures, {});
});

test('известная стоимость дошла до бюджета мандата: пауза до вызова модели', async (t) => {
  const h = setup(t, { costOf: () => 0.25, script: [planReply([{ title: 'x' }])] });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m1').reason, 'бюджет задачи исчерпан');
  assert.equal(h.brain.calls.length, 0);
});

test('одна задача за раз: вторая ждёт в очереди, пока первая работает или ждёт подтверждения', async (t) => {
  let releasePlan = null;
  const h = setup(t, {
    extraSpecs: [ASKING],
    script: [
      () => new Promise((r) => { releasePlan = () => r(planReply([{ title: 'Прочитать страницу' }])); }),
      fetchReply(),
      doneReply(),
      planReply([{ title: 'Подумать' }]),
      doneReply(),
    ],
  });
  h.addTask('m1', { mandate: WITH_ASKING });
  h.addTask('m2');
  const first = h.executor.submit('m1');
  await waitFor(() => releasePlan !== null, 'запрос плана первой задачи');
  assert.equal(h.queue.get('m1').status, 'running');
  assert.equal(h.executor.isBusy(), true);
  assert.equal(await h.executor.submit('m2'), null, 'исполнитель занят: вторая не стартует');
  assert.equal(h.queue.get('m2').status, 'queued');
  await assert.rejects(h.executor.run('m2'), /уже ведёт другую задачу/);

  releasePlan();
  await waitFor(() => h.approvals.list().length === 1, 'подтверждение первой задачи');
  assert.equal(h.queue.get('m1').status, 'waiting_approval');
  assert.equal(h.executor.kick(), null, 'пока первая ждёт подтверждения, вторая не стартует');
  assert.equal(h.queue.get('m2').status, 'queued');
  assert.throws(() => h.queue.start('m2'), /уже выполняется/);
  assert.ok(h.brain.calls.every((c) => c.taskId === 'm1'));

  h.approvals.respond(h.approvals.list()[0].id, 'once');
  const out = await first;
  assert.equal(out.status, 'unverified');
  assert.equal(h.queue.get('m2').status, 'unverified', 'после итога первой исполнитель сам взял вторую');
  assert.deepEqual(h.brain.calls.map((c) => c.taskId), ['m1', 'm1', 'm1', 'm2', 'm2']);
});

test('после паузы первой задачи вторая сама не стартует: решает главный процесс (kick)', async (t) => {
  const h = setup(t, { script: [Object.assign(new Error('бюджет'), { code: 'budget' }), planReply([{ title: 'x' }]), doneReply()] });
  h.addTask('m1', { priority: 1 });
  h.addTask('m2');
  h.queue.enqueue('m2');
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m2').status, 'queued');
  const next = await h.executor.kick();
  assert.equal(next.taskId, 'm2');
  assert.equal(next.status, 'unverified');
});

test('проверка не прошла maxFailuresPerStep раз подряд — задача заблокирована', async (t) => {
  const h = setup(t, {
    script: [
      planReply([{ title: 'Записать сводку', check: { kind: 'file_exists', path: 'reports/tea.md' } }]),
      doneReply('сводка записана'), // файла нет: проверка не прошла (1)
      doneReply('теперь точно'), // (2) — лимит
    ],
  });
  h.addTask('m1', { mandate: { limits: { maxFailuresPerStep: 2 } } });
  const out = await h.executor.submit('m1');
  const task = h.queue.get('m1');
  assert.equal(task.status, 'blocked');
  assert.match(task.reason, /шаг «Записать сводку» не получился 2 раза подряд/);
  assert.equal(task.plan[0].result.verification, 'failed');
  assert.equal(h.brain.calls.length, 3);
  assert.match(h.brain.calls[2].messages.at(-1).content, /проверка не прошла: не подтверждено: нет файла: reports\/tea\.md/);
  const report = fs.readFileSync(out.reportFile, 'utf8');
  assert.match(report, /\*\*Итог: не выполнено \(заблокирована: шаг «Записать сводку» не получился 2 раза подряд\)\*\*/);
  assert.match(report, /Результат проверки: не подтверждено: нет файла: reports\/tea\.md/);
});

test('ответ без инструментов — напоминание; восемь таких ответов — ошибка шага; прочая ошибка модели — тоже', async (t) => {
  const a = setup(t, { script: [planReply([{ title: 'Подумать' }]), ...Array.from({ length: 8 }, () => ({ content: 'Думаю…' }))] });
  a.addTask('m1', { mandate: { limits: { maxFailuresPerStep: 1 } } });
  const out = await a.executor.submit('m1');
  assert.equal(out.status, 'blocked');
  assert.equal(a.brain.calls.length, 9);
  assert.match(a.brain.calls[2].messages.at(-1).content, /Вызови step_done, когда шаг сделан, или нужный инструмент/);
  assert.match(a.queue.get('m1').plan[0].result.summary, /не завершён за 8 обращений/);

  const b = setup(t, { script: [planReply([{ title: 'Подумать' }]), new Error('сеть недоступна'), doneReply()] });
  b.addTask('m1');
  const retried = await b.executor.submit('m1');
  assert.equal(retried.status, 'unverified', 'после ошибки модели шаг повторён');
  assert.equal(b.queue.get('m1').log.filter((l) => l.event === 'шаг s1: failed').length, 1);
});

test('план: модель дважды не вызвала task_plan_submit — «не удалось составить план», инструменты не выполнялись', async (t) => {
  const h = setup(t, { script: [{ content: 'Сейчас всё сделаю!' }, toolReply(['workspace_write', { path: 'notes/a.md', content: 'x' }])] });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'blocked');
  assert.equal(h.queue.get('m1').reason, 'не удалось составить план');
  assert.equal(h.brain.calls.length, 2);
  assert.match(h.brain.calls[1].messages.at(-1).content, /Напоминание: ответь одним вызовом task_plan_submit/);
  assert.equal(h.runs.length, 0);
  assert.equal(fs.existsSync(path.join(h.root, 'notes', 'a.md')), false);
});

test('план: проверка вне папок мандата не принимается, повтор с причиной, затем верный план', async (t) => {
  const h = setup(t, {
    script: [
      planReply([{ title: 'Записать', check: { kind: 'file_exists', path: 'reports/x.md' } }]),
      planReply([{ title: 'Записать', check: { kind: 'file_exists', path: 'notes/x.md' } }]),
      toolReply(['workspace_write', { path: 'notes/x.md', content: 'x' }], ['step_done', { summary: 'записал' }]),
    ],
  });
  h.addTask('m1', { mandate: { folders: ['notes'] } });
  const out = await h.executor.submit('m1');
  assert.match(h.brain.calls[1].messages.at(-1).content, /Причина повтора: шаг 1: путь проверки «reports\/x\.md» вне папок мандата/);
  assert.equal(out.status, 'done');
  assert.deepEqual(h.queue.get('m1').plan.map((s) => s.check.path), ['notes/x.md']);
});

test('мандат без подтверждения владельца не запускается', async (t) => {
  const h = setup(t, { script: [planReply([{ title: 'x' }])] });
  h.addTask('m1', { approved: false });
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m1').reason, 'мандат не подтверждён владельцем');
  assert.equal(h.brain.calls.length, 0);
});

test('после перезапуска выполнявшаяся задача на паузе, и исполнитель её сам не запускает', async (t) => {
  const h = setup(t, { script: [planReply([{ title: 'x' }])] });
  h.addTask('m1');
  h.queue.enqueue('m1');
  h.queue.start('m1'); // задача работала, когда приложение закрылось
  const restored = new TaskQueue({ tasks: recoverAfterRestart(h.queue.list(), { now: NOW }) });
  assert.equal(restored.get('m1').status, 'paused');
  assert.match(restored.get('m1').reason, /перезапуск/);
  const executor = createExecutor({
    queue: restored, brain: h.brain, runTool: async () => ({ ok: true }), resolve: h.resolve, stop: new StopSwitch(), now: h.clock.now,
  });
  assert.equal(executor.kick(), null);
  assert.equal(restored.get('m1').status, 'paused');
  const out = await executor.run('m1');
  assert.equal(out.status, 'paused', 'run тоже не продолжает задачу на паузе');
  assert.equal(h.brain.calls.length, 0);
});

test('возобновление: прерванный шаг с проверкой сначала проверяется, действия не повторяются', async (t) => {
  const h = setup(t, { script: [] });
  h.addTask('m1');
  h.queue.enqueue('m1');
  h.queue.start('m1');
  h.queue.replacePlan('m1', model.setPlan(h.queue.get('m1'), [{ title: 'Записать', check: { kind: 'file_exists', path: 'notes/done.md' } }]).plan);
  h.queue.markStep('m1', 's1', 'doing');
  h.queue.pause('m1', 'аварийный стоп');
  fs.writeFileSync(path.join(h.root, 'notes', 'done.md'), 'x', 'utf8');
  h.queue.resume('m1');
  const out = await h.executor.kick();
  assert.equal(out.status, 'done');
  assert.equal(h.brain.calls.length, 0);
  assert.equal(h.runs.length, 0);
});

test('возобновление: прерванное действие без проверки не повторяется вслепую и блокирует задачу окончательно', async (t) => {
  const h = setup(t, { script: [toolReply(['workspace_write', { path: 'notes/tea.md', content: 'снова' }]), doneReply()] });
  h.addTask('m1');
  h.queue.enqueue('m1');
  h.queue.start('m1');
  h.queue.replacePlan('m1', model.setPlan(h.queue.get('m1'), [{ title: 'Записать заметку' }]).plan);
  h.queue.markStep('m1', 's1', 'doing');
  h.queue.pause('m1', 'перезапуск');
  h.queue.resume('m1');
  const out = await h.executor.kick();
  // Не пауза: иначе каждое возобновление снова упиралось бы в ту же ветку. Блокировка терминальна.
  assert.equal(out.status, 'blocked');
  assert.equal(h.queue.get('m1').status, 'blocked');
  assert.match(h.queue.get('m1').reason, /исход.*неизвестен/i);
  assert.match(h.queue.get('m1').reason, /поручите задачу заново/i);
  assert.equal(h.brain.calls.length, 0);
  assert.equal(h.runs.length, 0, 'действие не повторено');
  // Заблокированную задачу очередь сама не берёт: цикла «пауза → возобновление» нет.
  assert.equal(h.executor.kick(), null);
  assert.equal(h.queue.get('m1').status, 'blocked');
  const report = fs.readFileSync(out.reportFile, 'utf8');
  assert.match(report, /\*\*Итог: не выполнено \(заблокирована: исход прерванного действия неизвестен, поручите задачу заново\)\*\*/);
});

test('инструменты чата: задачу с мандатом меняет только исполнитель, task_list её показывает', async (t) => {
  const h = setup(t);
  h.addTask('m1');
  const tools = taskTools({ queue: h.queue, save: () => {}, resolve: h.resolve });
  const call = (name, args) => tools.find((x) => x.name === name).run(args);
  const mutating = [
    ['task_plan', { id: 'm1', steps: [{ title: 'a' }] }],
    ['task_enqueue', { id: 'm1' }],
    ['task_start', { id: 'm1' }],
    ['task_step', { id: 'm1', step_id: 's1', status: 'skipped' }],
    ['task_verify', { id: 'm1', step_id: 's1' }],
  ];
  for (const [name, args] of mutating) {
    const res = await call(name, args);
    assert.equal(res.ok, false, name);
    assert.equal(res.summary, 'задача ведётся исполнителем', name);
  }
  assert.equal(h.queue.get('m1').status, 'draft', 'статус не изменился');
  assert.deepEqual(h.queue.get('m1').plan, []);
  const list = await call('task_list', {});
  assert.equal(list.ok, true);
  assert.equal(list.data.tasks[0].byExecutor, true);
  // Задача без мандата — как раньше.
  const plain = await call('task_create', { title: 'Обычная' });
  assert.equal((await call('task_plan', { id: plain.data.id, steps: [{ title: 'a' }] })).ok, true);
  assert.equal((await call('task_enqueue', { id: plain.data.id })).ok, true);
});

test('модель и очередь: «выполнено, но не проверено» — конечный статус; без плана в очередь и в работу — только с мандатом', () => {
  let t1 = model.transition(model.transition(model.setPlan(model.createTask({ id: 'a', title: 'A' }), [{ title: 'x' }]), 'queued'), 'running');
  t1 = model.transition(t1, 'unverified');
  assert.equal(model.humanStatus(t1), 'выполнено, но не проверено');
  assert.deepEqual(model.TRANSITIONS.unverified, []);
  assert.ok(model.FINAL_STATUSES.includes('unverified'));
  assert.throws(() => model.transition(t1, 'queued'), /недопустим/);
  assert.throws(() => model.transition(model.createTask({ id: 'q', title: 'Q' }), 'unverified'), /недопустим/, 'только из running');
  const fresh = model.createTask({ id: 'b', title: 'B' });
  assert.equal(fresh.stepsUsed, 0);
  assert.equal(fresh.tokensUsed, 0);
  assert.equal(fresh.mandate, undefined);

  const q = new TaskQueue({});
  q.add(model.createTask({ id: 'plain', title: 'P' }));
  assert.throws(() => q.enqueue('plain'), /сначала задайте план/, 'без мандата — по-прежнему нужен план');

  const mandate = createMandate({
    goal: 'цель', tools: ['workspace_read'], sandboxRoot: path.join(os.tmpdir(), 'jarvis-exec-model'), now: NOW, limits: { maxFailuresPerStep: 1 },
  });
  q.add(model.createTask({ id: 'auto', title: 'Авто', mandate }));
  assert.notEqual(q.get('auto').mandate, mandate, 'задача хранит свою копию мандата');
  q.enqueue('auto');
  q.start('auto');
  assert.equal(q.get('auto').status, 'running');
  q.replacePlan('auto', model.setPlan(q.get('auto'), [{ title: 'шаг' }]).plan);
  assert.throws(() => model.setPlan(q.get('auto'), [{ title: 'другой' }]), /до старта/, 'план меняется только первый раз');
  q.markStep('auto', 's1', 'failed');
  assert.equal(q.get('auto').status, 'blocked', 'лимит неудач мандата строже лимита задачи');

  q.add(model.createTask({ id: 'auto2', title: 'Авто 2', mandate }));
  q.enqueue('auto2');
  q.start('auto2');
  q.replacePlan('auto2', model.setPlan(q.get('auto2'), [{ title: 'шаг' }]).plan);
  assert.throws(() => q.markUnverified('auto2'), /не все шаги/);
  q.markStep('auto2', 's1', 'done');
  assert.throws(() => q.complete('auto2'), /без проверки/, 'с мандатом «завершено» — только проверенное');
  q.markUnverified('auto2');
  assert.equal(q.get('auto2').status, 'unverified');
  assert.equal(q.running(), null);
});

// Регрессия: после аварийного стопа ничего не запускается само. A выполняется, B стоит в очереди; стоп;
// снятие стопа; позднее ответ модели для A; новая задача C — только по явному поручению и без цепочки на B.
test('после стопа и снятия стопа: A и B не продолжаются и не запускаются сами; C — только по явному поручению', async (t) => {
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const h = setup(t, {
    script: [
      planReply([{ title: 'Записать заметку' }]),
      () => gateA.then(() => toolReply(['workspace_write', { path: 'notes/tea.md', content: 'поздно' }], ['step_done', { summary: 'готово' }])),
      planReply([{ title: 'Шаг C' }]),
      doneReply('C готова'),
    ],
  });
  h.addTask('A');
  h.addTask('B');
  h.queue.enqueue('B');
  const pA = h.executor.submit('A');
  await waitFor(() => h.brain.calls.length === 2, 'шаг A ждёт модель');
  assert.equal(h.queue.get('A').status, 'running');

  h.stop.trigger('аварийный стоп');
  h.stop.reset(); // «Возобновить после стопа» снимает блокировку
  releaseA(); // поздний ответ модели для A приходит уже после снятия стопа
  const outA = await pA;

  assert.equal(outA.status, 'paused', 'поздний ответ не сделал A выполненной');
  assert.equal(h.queue.get('A').reason, 'аварийный стоп');
  assert.equal(h.runs.some((r) => r.name === 'workspace_write'), false, 'поздний ответ не исполнен');
  assert.equal(fs.existsSync(path.join(h.root, 'notes', 'tea.md')), false);
  assert.equal(h.brain.calls.length, 2, 'после стопа новых вызовов модели нет');

  // Обычное сообщение в чат или любой шаг чата: очередь сама не стартует.
  assert.equal(h.executor.kick(), null);
  await ticks(40);
  assert.equal(h.brain.calls.length, 2);
  assert.equal(h.queue.get('A').status, 'paused', 'A не возобновилась сама');
  // B стояла в очереди: стоп ставит её на паузу (stopAll), иначе её взял бы исполнитель после перезапуска.
  assert.deepEqual([h.queue.get('B').status, h.queue.get('B').reason], ['paused', 'аварийный стоп: задача в очереди ждёт вашего решения'], 'B не запустилась сама');

  // Новая задача C с подтверждённым мандатом — явное действие владельца: запускается ровно она.
  h.addTask('C');
  const outC = await h.executor.submit('C');
  assert.equal(outC.status, 'unverified', 'C выполнена без проверки (шаг без check)');
  assert.equal(h.brain.calls.length, 4, 'вызовы: план A, шаг A (поздний), план C, шаг C');
  assert.equal(h.queue.get('A').status, 'paused', 'A всё так же на паузе');
  assert.equal(h.queue.get('B').status, 'paused', 'B не запущена цепочкой после C');
  assert.equal(h.runs.some((r) => r.name === 'workspace_write'), false);
});

// ---- Ревью: пробелы сценария «стоп → reset → поздний ответ → C».

// Эпоха стопа — единственная защита, когда задачу на паузу не ставит stopAll (подписчик main.js не подключён,
// как в сборке runtime.js). Без проверки эпохи в halted() поздний ответ после reset исполнил бы workspace_write.
// B здесь остаётся «в очереди» (stopAll не подключён), и после снятия стопа её не запускает kick().
test('ревью E1: стоп → reset → поздний ответ без stopAll: инструмент не запущен, A на паузе, B из очереди не стартует', async (t) => {
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const h = setup(t, {
    wireStop: false,
    script: [
      planReply([{ title: 'Записать заметку' }]),
      () => gateA.then(() => toolReply(['workspace_write', { path: 'notes/tea.md', content: 'поздно' }], ['step_done', { summary: 'готово' }])),
    ],
  });
  h.addTask('A');
  h.addTask('B');
  const pA = h.executor.submit('A');
  await waitFor(() => h.brain.calls.length === 2, 'шаг A ждёт модель');
  h.queue.enqueue('B');
  h.stop.trigger('аварийный стоп');
  h.stop.reset();
  releaseA();
  const outA = await pA;
  assert.equal(outA.status, 'paused');
  assert.equal(h.queue.get('A').reason, 'аварийный стоп');
  assert.equal(h.runs.length, 0, 'поздний ответ не исполнен');
  assert.equal(fs.existsSync(path.join(h.root, 'notes', 'tea.md')), false);
  assert.deepEqual(h.queue.get('A').plan.map((s) => s.status), ['doing'], 'шаг не закрыт поздним step_done');
  assert.equal(outA.reportFile, null);
  assert.equal(h.executor.kick(), null, 'после стопа очередь сама не стартует');
  await ticks(40);
  assert.equal(h.queue.get('B').status, 'queued', 'без stopAll B остаётся «в очереди», но не запущена');
  assert.equal(h.brain.calls.length, 2);
});

// После стопа и снятия стопа явный submit запускает задачу, но только с подтверждённым мандатом.
test('ревью E2: после стопа и reset задача C без подтверждённого мандата не стартует', async (t) => {
  const h = setup(t, { script: [planReply([{ title: 'x' }]), doneReply()] });
  h.addTask('A');
  h.stop.trigger('аварийный стоп');
  h.stop.reset();
  h.addTask('C', { approved: false });
  const outC = await h.executor.submit('C');
  assert.equal(outC.status, 'paused');
  assert.equal(h.queue.get('C').reason, 'мандат не подтверждён владельцем');
  assert.equal(h.brain.calls.length, 0);
});

// Поздний ответ после reset: запуск A остановлен прежней эпохой — отчёта и итогового события нет (как при включённом стопе).
test('ревью E3: поздний ответ после reset не пишет отчёт и не шлёт итоговое событие', async (t) => {
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const h = setup(t, {
    script: [
      planReply([{ title: 'Записать заметку' }]),
      () => gateA.then(() => doneReply('готово')),
    ],
  });
  h.addTask('A');
  const pA = h.executor.submit('A');
  await waitFor(() => h.brain.calls.length === 2, 'шаг A ждёт модель');
  h.stop.trigger('аварийный стоп');
  h.stop.reset();
  releaseA();
  const outA = await pA;
  assert.equal(outA.status, 'paused');
  assert.equal(outA.reportFile, null, 'отчёт по прерванному стопом запуску не пишется');
  assert.equal(fs.existsSync(path.join(h.root, 'reports', 'task-A.md')), false);
  assert.equal(h.events.some((e) => e.taskId === 'A' && e.final), false, 'итогового события нет');
});

// Возобновление A, пока её прежний запуск ещё ждёт поздний ответ модели: A не застревает «в очереди».
test('ревью E4: resume A после reset, пока старый запуск A ещё занят: A на паузе с причиной, не «в очереди»', async (t) => {
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const h = setup(t, {
    script: [
      planReply([{ title: 'Записать заметку' }]),
      () => gateA.then(() => doneReply('поздно')),
      doneReply('после возобновления'),
    ],
  });
  h.addTask('A');
  const pA = h.executor.submit('A');
  await waitFor(() => h.brain.calls.length === 2, 'шаг A ждёт модель');
  h.stop.trigger('аварийный стоп');
  h.stop.reset();
  assert.equal(h.queue.get('A').status, 'paused');
  // Как runtime.resumeTask после «один раз»: queue.resume + executor.submit.
  h.queue.resume('A');
  const resumed = await h.executor.submit('A');
  assert.equal(resumed, null, 'исполнитель ещё занят старым запуском: новый запуск не начат');
  assert.equal(h.queue.get('A').status, 'paused', 'сразу на паузе, а не «в очереди»');
  assert.match(h.queue.get('A').reason, /исполнитель ещё завершал прежний запуск/);
  assert.ok(h.journal.some((e) => e.taskId === 'A' && e.decision === 'busy'), 'отказ запуска записан в журнал');
  releaseA();
  await pA;
  await ticks(20);
  const st = h.queue.get('A').status;
  assert.notEqual(st, 'queued', `A застряла в статусе ${st}: её не запустит ни kick, ни task_resume`);
  assert.equal(st, 'paused');
  assert.equal(h.brain.calls.length, 2, 'новых вызовов модели нет');
  assert.equal(h.events.some((e) => e.taskId === 'A' && e.final), false);
});

// Отчёт отвечает на вопрос владельца «что изменено, какие тесты, что осталось» — по фактам шагов,
// а не по словам модели. Собираем задачу вручную: renderReport чистый, модель и диск не нужны.
function reportTask(patch = {}) {
  const at = Date.UTC(2026, 10, 5, 6, 0);
  const base = model.createTask({ id: 'r1', title: 'Проверить отчёт', goal: 'Собрать отчёт и запустить тесты', now: at });
  return { ...base, status: 'done', ...patch };
}

test('отчёт: изменения, тесты и оставшиеся проблемы по фактам шагов', () => {
  const at = Date.UTC(2026, 10, 5, 6, 0);
  const task = reportTask({
    plan: [
      {
        id: 's1', title: 'Записать отчёт', kind: 'action', status: 'done',
        check: { kind: 'file_exists', path: 'reports/r.md' },
        result: {
          verification: 'confirmed', evidence: 'подтверждено: файл есть', summary: 'записан',
          effects: [{ tool: 'workspace_write', target: 'reports/r.md', backup: 'backups/20261105-060000__r.md__abc123.bak' }],
        },
      },
      {
        id: 's2', title: 'Прогнать тесты', kind: 'action', status: 'done',
        check: { kind: 'file_exists', path: 'reports/r.md' },
        result: {
          verification: 'confirmed', evidence: 'подтверждено: тесты прошли', summary: 'тесты прошли',
          effects: [{ tool: 'code_test', target: 'apps/demo' }],
        },
      },
    ],
    criteria: [{
      id: 'c1', requirement: 'отчёт существует', text: 'файл reports/r.md существует',
      check: { kind: 'file_exists', path: 'reports/r.md' }, manual: null,
      result: { verification: 'confirmed', evidence: 'файл есть' },
    }],
  });
  const md = renderReport(task, { cost: null, at, costSummary: null });
  assert.match(md, /## Изменения в файлах\n\n- reports\/r\.md — workspace_write, запись подтверждена проверкой; прежняя версия: backups\/20261105-060000__r\.md__abc123\.bak/);
  assert.match(md, /## Тесты\n\n- s2\. Прогнать тесты: подтверждено: тесты прошли \(apps\/demo\)/);
  assert.match(md, /## Оставшиеся проблемы\n\n- нет/);
  assert.ok(md.indexOf('## Изменения в файлах') < md.indexOf('## Тесты'), 'порядок: изменения, потом тесты');
  assert.ok(md.indexOf('## Тесты') < md.indexOf('## Оставшиеся проблемы'), 'порядок: тесты, потом проблемы');
});

test('отчёт: неподтверждённые критерии, непроверенные шаги и отказы попадают в «Оставшиеся проблемы»', () => {
  const at = Date.UTC(2026, 10, 5, 6, 0);
  const task = reportTask({
    status: 'unverified',
    plan: [
      {
        id: 's1', title: 'Перезаписать старую заметку', kind: 'action', status: 'failed',
        check: null,
        result: {
          verification: 'none', evidence: 'проверки нет', summary: 'шаг не получился',
          refusals: [{ tool: 'workspace_write', target: 'notes/old.md', reason: 'перезаписывать можно только в reports' }],
        },
      },
      {
        id: 's2', title: 'Продумать структуру', kind: 'action', status: 'done',
        check: null,
        result: { verification: 'none', evidence: 'проверки нет', summary: 'готово' },
      },
    ],
    unverifiedSteps: ['s2'],
    criteria: [{
      id: 'c1', requirement: 'старая заметка обновлена', text: 'в файле новый текст',
      check: { kind: 'file_contains', path: 'notes/old.md', text: 'новый' }, manual: null,
      result: { verification: 'failed', evidence: 'файла нет' },
    }],
  });
  const md = renderReport(task, { cost: null, at, costSummary: null });
  const problems = md.split('## Оставшиеся проблемы')[1].split('## Расход')[0];
  assert.match(problems, /- Критерий c1: «старая заметка обновлена» — не подтверждено \(не подтверждено: файла нет\)/);
  assert.match(problems, /- Шаг s2 «Продумать структуру»: выполнен без объективной проверки/);
  assert.match(problems, /- Шаг s1 «Перезаписать старую заметку»: не получился/);
  assert.match(problems, /- Отказы мандата: 1/);
  assert.match(md, /## Тесты\n\n- тесты не запускались \(по записанным фактам шагов\)/, 'о тестах без записи не выдумываем');
});

test('отчёт: упавшие тесты видны в разделе «Тесты», а не выдаются за отсутствие запусков', () => {
  const at = Date.UTC(2026, 10, 5, 6, 0);
  const task = reportTask({
    status: 'blocked',
    plan: [{
      id: 's1', title: 'Прогнать тесты', kind: 'action', status: 'failed', check: null,
      result: {
        verification: null, evidence: '', summary: 'тесты упали: 2 из 10',
        effects: [{ tool: 'code_test', target: 'apps/demo' }],
      },
    }],
  });
  const md = renderReport(task, { cost: null, at, costSummary: null });
  assert.match(md, /## Тесты\n\n- s1\. Прогнать тесты: шаг не получился — тесты упали: 2 из 10 \(apps\/demo\)/);
  assert.match(md, /## Оставшиеся проблемы\n\n[\s\S]*- Шаг s1 «Прогнать тесты»: не получился/, 'упавший шаг остаётся в проблемах');
});

test('отчёт: код выхода тестов важнее проверки шага — упавшие тесты не зовутся успехом', () => {
  const at = Date.UTC(2026, 10, 5, 6, 0);
  const task = reportTask({
    status: 'done',
    plan: [{
      id: 's1', title: 'Прогнать тесты', kind: 'action', status: 'done', check: null,
      result: {
        verification: 'confirmed', evidence: 'файл есть', summary: 'запустил тесты',
        effects: [{ tool: 'code_test', target: 'apps/demo', exitCode: 1 }],
      },
    }],
  });
  const md = renderReport(task, { cost: null, at, costSummary: null });
  assert.match(md, /## Тесты\n\n- s1\. Прогнать тесты: провалились \(код 1\) \(apps\/demo\)/);
  assert.doesNotMatch(md, /- s1\. Прогнать тесты: прошли/, 'падение не выдаётся за успех');
});

test('отчёт: успешный код выхода 0 даёт «прошли»', () => {
  const at = Date.UTC(2026, 10, 5, 6, 0);
  const task = reportTask({
    status: 'done',
    plan: [{
      id: 's1', title: 'Прогнать тесты', kind: 'action', status: 'done', check: null,
      result: { verification: 'confirmed', evidence: 'файл есть', summary: 'ok', effects: [{ tool: 'code_test', target: 'apps/demo', exitCode: 0 }] },
    }],
  });
  const md = renderReport(task, { cost: null, at, costSummary: null });
  assert.match(md, /## Тесты\n\n- s1\. Прогнать тесты: прошли \(apps\/demo\)/);
});

test('живой прогон: отчёт по настоящим шагам показывает копию прежней версии и упавшие тесты', async (t) => {
  const h = setup(t, {
    extraSpecs: [{
      name: 'code_test', risk: 'T2',
      description: 'Запустить тесты проекта (в этом тесте — подделка, исход задаётся вручную).',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    }],
    fakes: {
      code_test: (args) => ({ ok: true, summary: `тесты: код 1`, data: { exitCode: 1, output: '2 из 10 не прошли', command: args && args.command } }),
    },
    script: [
      planReply([
        { title: 'Обновить отчёт', check: { kind: 'file_contains', path: 'reports/r.md', text: 'версия 2' } },
        { title: 'Прогнать тесты' },
      ]),
      toolReply(['workspace_write', { path: 'reports/r.md', content: 'версия 2' }]),
      doneReply('отчёт обновлён'),
      toolReply(['code_test', { command: 'node --test' }]),
      doneReply('тесты запущены'),
    ],
  });
  fs.writeFileSync(path.join(h.root, 'reports', 'r.md'), 'версия 1', 'utf8');
  h.addTask('m1', { mandate: { tools: ['workspace_read', 'workspace_write', 'code_test'], folders: ['reports'] } });
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'unverified', 'у второго шага нет объективной проверки — итог не «проверено»');
  const report = fs.readFileSync(out.reportFile, 'utf8');

  // Изменение по факту: настоящий workspace_write снял копию прежней версии, отчёт это показывает.
  assert.match(report, /## Изменения в файлах\n\n- reports\/r\.md — workspace_write, запись подтверждена проверкой; прежняя версия: backups\/[^\s]+\.bak/);
  const copy = fs.readdirSync(path.join(h.root, 'backups')).filter((f) => f.endsWith('.bak'));
  assert.equal(copy.length, 1, 'копия прежней версии одна');
  assert.equal(fs.readFileSync(path.join(h.root, 'backups', copy[0]), 'utf8'), 'версия 1', 'в копии лежит прежняя версия');
  // Тесты: шаг не проверялся объективно, но код выхода 1 не даёт назвать их успехом.
  assert.match(report, /## Тесты\n\n- s2\. Прогнать тесты: провалились \(код 1\) \(node --test\)/);
  assert.doesNotMatch(report, /## Тесты\n\n- s2\. Прогнать тесты: прошли/);
  // Непроверенный шаг остаётся в проблемах, а не выдаётся за подтверждённый.
  assert.match(report, /## Оставшиеся проблемы\n\n[\s\S]*Шаг s2 «Прогнать тесты»: выполнен без объективной проверки/);
});

test('отчёт: последний запуск без кода выхода не прикрывается кодом предыдущего', () => {
  const at = Date.UTC(2026, 10, 5, 6, 0);
  const task = reportTask({
    status: 'done',
    plan: [{
      id: 's1', title: 'Прогнать тесты', kind: 'action', status: 'done', check: null,
      result: {
        verification: 'confirmed', evidence: '', summary: 'ok',
        effects: [
          { tool: 'code_test', target: 'apps/demo', exitCode: 1 },
          { tool: 'code_test', target: 'apps/demo' },
        ],
      },
    }],
  });
  const md = renderReport(task, { cost: null, at, costSummary: null });
  assert.match(md, /## Тесты\n\n- s1\. Прогнать тесты: исход последнего запуска не записан \(apps\/demo\)/);
  assert.doesNotMatch(md, /провалились \(код 1\)/, 'код прошлого запуска не выдаётся за текущий');
});

test('зависший вызов модели: задача на паузе, очередь освобождается', async (t) => {
  const h = setup(t, {
    executorOpts: { modelTimeoutMs: 40 },
    script: [() => new Promise(() => {})],
  });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m1').status, 'paused');
  assert.match(h.queue.get('m1').reason, /модель не ответила за/);
  assert.equal(h.executor.isBusy(), false, 'исполнитель не занят зависшим вызовом');
});

test('зависший инструмент: задача на паузе, повтор вслепую не запускается', async (t) => {
  const h = setup(t, {
    executorOpts: { toolTimeoutMs: 40 },
    fakes: { workspace_read: () => new Promise(() => {}) },
    script: [
      planReply([{ title: 'Прочитать заметку', check: { kind: 'file_exists', path: 'notes/tea.md' } }]),
      toolReply(['workspace_read', { path: 'notes/tea.md' }]),
    ],
  });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.match(h.queue.get('m1').reason, /workspace_read не ответил за/);
  assert.equal(h.runs.length, 1, 'второй вызов после зависания не делался');
  assert.equal(h.executor.isBusy(), false);
});

test('сбой сохранения состояния: следующие действия не выполняются, задача на паузе', async (t) => {
  let saves = 0;
  const h = setup(t, {
    saveTasks: () => { saves += 1; if (h0 && h0.runs.length >= 1) throw new Error('диск переполнен'); },
    script: [
      planReply([{ title: 'Записать заметку', check: { kind: 'file_exists', path: 'notes/tea.md' } }]),
      toolReply(['workspace_write', { path: 'notes/tea.md', content: 'улун' }]),
      doneReply('записано'),
      doneReply('записано'),
    ],
  });
  var h0 = h;
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused', 'задача остановлена, а не продолжена вслепую');
  assert.match(h.queue.get('m1').reason, /не сохранено/);
  assert.ok(saves > 0);
});

// ---- Таймаут прерывает сам вызов, а не только ожидание (пункт 1 аудита).

test('таймаут модели прерывает запрос сигналом, поздний ответ учитывает токены один раз', async (t) => {
  let seenSignal = null;
  let lateResolve = null;
  const h = setup(t, {
    executorOpts: { modelTimeoutMs: 40 },
    script: [
      (req) => {
        seenSignal = req.signal;
        return new Promise((resolve) => {
          lateResolve = () => resolve({ content: '', toolCalls: [], stats: { promptTokens: 30, completionTokens: 10 } });
        });
      },
    ],
  });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.match(h.queue.get('m1').reason, /модель не ответила за/);
  assert.ok(seenSignal, 'модель получила сигнал отмены');
  assert.equal(seenSignal.aborted, true, 'по таймауту вызов прерван, а не просто перестали ждать');
  assert.equal(h.queue.get('m1').tokensUsed, 0, 'ответа не было — токенов нет');

  // Поздний ответ приходит уже после паузы: процесс не падает, токены всё равно учтены — один раз.
  assert.equal(typeof lateResolve, 'function');
  lateResolve();
  await ticks(30);
  assert.equal(h.queue.get('m1').tokensUsed, 40, 'токены позднего ответа учтены');
  await ticks(30);
  assert.equal(h.queue.get('m1').tokensUsed, 40, 'дважды не учтены');
  assert.ok(h.journal.some((e) => e.tool === 'модель' && e.decision === 'late'), 'поздний ответ отмечен в журнале');
});

test('таймаут инструмента прерывает его сигналом, поздний результат не засчитывается шагом', async (t) => {
  let seenSignal = null;
  let lateResolve = null;
  const h = setup(t, {
    executorOpts: { toolTimeoutMs: 40 },
    runTool: (name, args, ctx) => {
      seenSignal = ctx.signal;
      return new Promise((resolve) => {
        lateResolve = () => resolve({ ok: true, summary: 'поздно' });
      });
    },
    script: [
      planReply([{ title: 'Прочитать', check: { kind: 'file_exists', path: 'notes/tea.md' } }]),
      toolReply(['workspace_read', { path: 'notes/tea.md' }]),
    ],
  });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'paused');
  assert.match(h.queue.get('m1').reason, /workspace_read не ответил за/);
  assert.ok(seenSignal, 'инструмент получил сигнал отмены');
  assert.equal(seenSignal.aborted, true, 'по таймауту инструмент прерван, а не просто перестали ждать');
  assert.equal(h.queue.get('m1').stepsUsed, 0, 'зависший вызов не засчитан шагом');

  lateResolve();
  await ticks(30);
  assert.equal(h.queue.get('m1').stepsUsed, 0, 'поздний результат не засчитан как шаг');
  assert.equal(h.queue.get('m1').status, 'paused', 'поздний результат не меняет статус задачи');
  assert.ok(h.journal.some((e) => e.tool === 'workspace_read' && e.decision === 'late'), 'поздний ответ отмечен в журнале');
  assert.equal(h.runs.length, 1, 'повторного вызова не было');
});

test('стоп прерывает зависший инструмент через локальный сигнал, связанный с отменой задачи', async (t) => {
  let seenSignal = null;
  let release = null;
  const h = setup(t, {
    wireStop: false, // паузу ставит сам исполнитель, stopAll не подключён
    runTool: (name, args, ctx) => {
      seenSignal = ctx.signal;
      return new Promise((resolve) => { release = () => resolve({ ok: false, summary: 'поздно' }); });
    },
    script: [
      planReply([{ title: 'Прочитать', check: { kind: 'file_exists', path: 'notes/tea.md' } }]),
      toolReply(['workspace_read', { path: 'notes/tea.md' }]),
    ],
  });
  h.addTask('m1');
  const running = h.executor.submit('m1');
  await waitFor(() => seenSignal !== null, 'инструмент запущен');
  h.stop.trigger('аварийный стоп');
  assert.equal(seenSignal.aborted, true, 'стоп задачи прерывает локальный сигнал вызова');
  release();
  const out = await running;
  assert.equal(out.status, 'paused');
  assert.equal(h.queue.get('m1').status, 'paused');
  assert.equal(h.runs.length, 1);
});

// ---- Отчёт маскирует секреты перед записью (пункт 3 аудита).

test('отчёт: секреты из результатов скрываются, а формат, id задачи и счётчики остаются', async (t) => {
  const longId = 'tmvvbdz1p7fd80f9x2y3z4'; // длинный id похож на ключ по looksSecret — маскировать его нельзя
  const withStats = (reply) => ({ ...reply, stats: { promptTokens: 1000, completionTokens: 200 } });
  const h = setup(t, {
    script: [
      withStats(planReply([{ title: 'Записать заметку', check: { kind: 'file_exists', path: 'notes/tea.md' } }])),
      withStats(toolReply(['workspace_write', { path: 'notes/tea.md', content: 'x' }])),
      withStats(doneReply('сохранил ключ api_key=sk-1234567890abcdef')),
    ],
  });
  h.addTask(longId);
  const out = await h.executor.submit(longId);
  assert.equal(out.status, 'done');
  const report = fs.readFileSync(out.reportFile, 'utf8');
  assert.doesNotMatch(report, /sk-1234567890abcdef/, 'секрет не попал в отчёт');
  assert.match(report, /^ {3}- \[строка скрыта: похоже на секрет\]$/m, 'строка с секретом помечена, отступ списка сохранён');
  assert.match(report, new RegExp(`^# Отчёт по задаче «Задача ${longId}»$`, 'm'), 'заголовок отчёта не скрыт');
  assert.match(report, new RegExp(`^- Задача: ${longId}$`, 'm'), 'id задачи в шапке не скрыт');
  assert.match(report, /^- Токены: 3600 из 300000$/m, 'счётчик токенов не принят за секрет');
  assert.match(report, /^- Папки: /m, 'раздел «Мандат» не скрыт: там пути, а не секреты');
  assert.match(report, /## Изменения в файлах\n\n- notes\/tea\.md — workspace_write, запись подтверждена проверкой/);
  assert.match(report, /## Тесты\n\n- тесты не запускались/);
  assert.match(report, /\*\*Итог: проверено\*\*/);
});

test('итог для чата тоже не показывает секреты из доказательств шагов', () => {
  const at = Date.UTC(2026, 10, 5, 6, 0);
  const task = reportTask({
    title: 'Собрать сводку',
    plan: [{
      id: 's1', title: 'Прочитать файл', kind: 'action', status: 'done', check: null,
      result: { verification: 'confirmed', evidence: 'в файле ключ sk-1234567890abcdef', summary: 'прочитал' },
    }],
  });
  const text = finalSummary(task, 'reports/task-r1.md', 0.01);
  assert.match(text, /Собрать сводку/);
  assert.match(text, /\[строка скрыта: похоже на секрет\]/);
  assert.doesNotMatch(text, /sk-1234567890abcdef/, 'секрет не попал в ленту');
  assert.match(text, /Отчёт: reports\/task-r1\.md/);
});
