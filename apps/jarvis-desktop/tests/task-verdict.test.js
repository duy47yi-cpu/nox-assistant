'use strict';

// Этап 2: вид шага (action / observation / service), итог задачи по фактам, отказы мандата в итоге шага,
// отчёт по разделам, проверки numbered_steps и sentence_count. Модель подставная, реальная не вызывается.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../src/tasks/model');
const { TaskQueue } = require('../src/tasks/queue');
const { runCheck, countSentences } = require('../src/tasks/verify');
const { createMandate } = require('../src/tasks/mandate');
const { createExecutor } = require('../src/tasks/executor');
const { StopSwitch } = require('../src/control/stop');
const { ApprovalBroker } = require('../src/policy/approvals');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');

const NOW = Date.UTC(2026, 9, 30, 12, 0);

// Этап 3: новый план обязан содержать критерии приёмки. Сценарии, написанные до этого, их не передают —
// подставная модель добавляет их сама (если ключа criteria в ответе нет): требование — цель задачи целиком
// (из запроса плана), по критерию на каждую проверку шага, кроме file_absent; без проверок — один критерий
// «оценка модели». Итоги старых сценариев от этого не меняются.
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

function scriptedBrain(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async chat(req) {
      calls.push({ purpose: req.purpose, tools: (req.tools || []).map((t) => t.function.name), messages: req.messages.slice() });
      if (i >= script.length) throw new Error('сценарий модели исчерпан');
      const next = withCriteria(script[i], req);
      i += 1;
      return {
        content: next.content || '',
        reasoningContent: null,
        toolCalls: (next.toolCalls || []).map((c, k) => ({ id: `call${calls.length}_${k}`, name: c.name, args: c.args ?? {}, argsError: null })),
        stats: { promptTokens: 100, completionTokens: 20 },
      };
    },
  };
}

const planReply = (steps) => ({ toolCalls: [{ name: 'task_plan_submit', args: { steps } }] });
const toolReply = (...calls) => ({ toolCalls: calls.map(([name, args]) => ({ name, args })) });
const doneReply = (summary = 'готово') => toolReply(['step_done', { summary }]);
const failReply = (reason) => toolReply(['step_fail', { reason }]);

// Песочница во временной папке, настоящие инструменты рабочей папки, очередь, стоп и подтверждения.
function setup(t, { script = [], goal = 'Цель теста' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-verdict-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  for (const dir of ['notes', 'reports']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const index = new WorkspaceIndex(root);
  const resolve = (rel) => index.resolveInside(rel);
  const ws = workspaceTools(index);
  const brain = scriptedBrain(script);
  const runs = [];
  const runTool = async (name, args) => {
    runs.push({ name, args });
    const tool = ws.find((x) => x.name === name);
    return tool ? tool.run(args) : { ok: false, summary: `нет инструмента ${name}` };
  };
  const queue = new TaskQueue({ now: () => NOW });
  const stop = new StopSwitch();
  const approvals = new ApprovalBroker();
  const journal = [];
  const events = [];
  const executor = createExecutor({
    queue,
    saveTasks: () => {},
    brain,
    runTool,
    toolSpecs: ws,
    approvals,
    stop,
    journal: { append: (e) => journal.push(e) },
    resolve,
    emit: (e) => events.push(e),
    costOf: () => null,
    now: () => NOW,
    sandboxReportsDir: 'reports',
  });
  const addTask = (id, mandate = {}) => {
    const m = createMandate({ goal, tools: ['workspace_list', 'workspace_read', 'workspace_write'], sandboxRoot: root, now: NOW, ...mandate });
    m.approvedBy = 'владелец';
    return queue.add(model.createTask({ id, title: `Задача ${id}`, goal, now: NOW, mandate: m }));
  };
  return { root, resolve, brain, runs, queue, journal, events, executor, addTask };
}

function running(steps, { mandate = true } = {}) {
  const m = mandate ? { goal: 'g', tools: ['workspace_read'], folders: ['.'], root: '/', expiresAt: NOW + 1000, limits: {}, approvedBy: 'x' } : null;
  const task = model.createTask({ id: 'v', title: 'V', now: NOW, mandate: m });
  const planned = model.setPlan(task, steps, { now: NOW });
  return model.transition(model.transition(planned, 'queued'), 'running');
}

// ---- Вид шага в плане.

test('план: kind — action по умолчанию; неизвестный вид и проверка у наблюдения — ошибка плана с понятным текстом', () => {
  const plain = running([{ title: 'старый шаг без вида' }]);
  assert.equal(plain.plan[0].kind, undefined, 'старые планы не меняют форму');
  assert.equal(model.stepKind(plain.plan[0]), 'action');
  const kinds = running([{ title: 'a', kind: 'action' }, { title: 'o', kind: 'observation' }, { title: 's', kind: 'service' }]);
  assert.deepEqual(kinds.plan.map((s) => model.stepKind(s)), ['action', 'observation', 'service']);

  const draft = model.createTask({ id: 'x', title: 'X' });
  assert.throws(() => model.setPlan(draft, [{ title: 'a', kind: 'наблюдение' }]), /шаг 1: неизвестный вид шага «наблюдение»; есть: action \(действие\), observation \(наблюдение\), service/);
  assert.throws(
    () => model.setPlan(draft, [{ title: 'a' }, { title: 'b', kind: 'observation', check: { kind: 'file_exists', path: 'a.md' } }]),
    /шаг 2: у шага вида observation \(наблюдение\) не бывает проверки check/,
  );
  assert.throws(() => model.setPlan(draft, [{ title: 'a', kind: 'service', check: { kind: 'file_exists', path: 'a.md' } }]), /service/);
});

test('исполнитель: неизвестный вид шага — план не принят, модель переспрошена с причиной; sentence_count без count — тоже', async (t) => {
  const h = setup(t, {
    script: [
      planReply([{ title: 'Посмотреть', kind: 'look' }]),
      planReply([{ title: 'Записать', check: { kind: 'sentence_count', path: 'notes/a.md' } }]),
    ],
  });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  assert.match(h.brain.calls[1].messages.at(-1).content, /Причина повтора: шаг 1: неизвестный вид шага «look»/);
  assert.equal(out.status, 'blocked');
  assert.equal(h.queue.get('m1').reason, 'не удалось составить план');
  assert.ok(h.journal.some((e) => /для sentence_count нужно число предложений count от 1 до 50/.test(e.summary)));
  assert.deepEqual(h.brain.calls[0].tools, ['task_plan_submit']);
  assert.match(h.brain.calls[0].messages[0].content, /вид шага kind: action/, 'план-промпт описывает kind');
  assert.match(h.brain.calls[0].messages[0].content, /sentence_count/);
});

// ---- Вид проверяется по фактам.

test('наблюдение выполнило запись (T1): step_done отклонён с объяснением, шаг не закрыт; факт записи — в итоге шага', async (t) => {
  const h = setup(t, {
    script: [
      planReply([{ title: 'Посмотреть папку notes', kind: 'observation' }]),
      toolReply(['workspace_write', { path: 'notes/a.md', content: 'чай' }]),
      doneReply('посмотрел'),
      failReply('наблюдение записало файл'),
    ],
  });
  h.addTask('m1', { limits: { maxFailuresPerStep: 1 } });
  const out = await h.executor.submit('m1');
  const task = h.queue.get('m1');
  const rejected = h.brain.calls[3].messages.at(-1);
  assert.equal(rejected.role, 'tool');
  assert.match(rejected.content, /"ok":false/);
  assert.match(rejected.content, /step_done отклонён: шаг вида «наблюдение» выполнил действия с побочным эффектом \(workspace_write notes\/a\.md\)/);
  assert.ok(h.journal.some((e) => e.decision === 'kind_violation'));
  assert.notEqual(task.plan[0].status, 'done', 'шаг не закрыт');
  assert.equal(out.status, 'blocked');
  assert.deepEqual(task.plan[0].result.effects, [{ tool: 'workspace_write', target: 'notes/a.md' }]);
  assert.match(h.brain.calls[1].messages[0].content, /Шаг — наблюдение: только чтение \(инструменты без побочного эффекта: workspace_list, workspace_read\)/);
});

// Этап 3: not_applicable остаётся только у легаси-задачи без критериев приёмки (план уже лежит в tasks.json,
// составлен до критериев): исполнитель план не переспрашивает и подводит итог по старым правилам.
// Подпись итога — «Только чтение — изменений не выполнялось» (раньше «проверка не применима (задача только читала)»),
// технический код — отдельной строкой отчёта и в поле verdict события итога.
test('легаси-задача только читала (наблюдение + служебный шаг, без критериев): not_applicable с обоснованием рантайма, не «завершено»', async (t) => {
  const h = setup(t, {
    script: [
      toolReply(['workspace_read', { path: 'notes/a.md' }], ['step_done', { summary: 'прочитал' }]),
      doneReply('Ответ: в заметке про улун'),
    ],
  });
  fs.writeFileSync(path.join(h.root, 'notes', 'a.md'), 'улун', 'utf8');
  const legacy = h.addTask('m1');
  h.queue.replacePlan('m1', model.setPlan(legacy, [{ title: 'Прочитать заметку', kind: 'observation' }, { title: 'Ответить владельцу', kind: 'service' }]).plan);
  assert.equal(h.queue.get('m1').criteria, undefined, 'легаси-запись: поля criteria нет');
  const out = await h.executor.submit('m1');
  assert.ok(h.brain.calls.every((c) => c.purpose === 'step'), 'план у легаси-задачи не переспрашивается');
  const task = h.queue.get('m1');
  assert.equal(task.status, 'unverified', 'статус в очереди — «выполнено, но не проверено»: ответ модели объективно не проверен');
  assert.equal(task.verdict.code, 'not_applicable');
  assert.match(task.verdict.reason, /^задача только читала: шагов-действий нет, действий с побочным эффектом не было \(наблюдений: 1, служебных шагов: 1\)/);
  assert.deepEqual(task.unverifiedSteps, [], 'наблюдение и служебный шаг — не «непроверенные»');
  assert.deepEqual(task.plan.map((s) => s.result.verification), ['not_applicable', 'not_applicable']);
  assert.match(task.plan[0].result.evidence, /^наблюдение: только чтение \(workspace_read\); действий с побочным эффектом нет/);
  assert.throws(() => h.queue.complete('m1'), /не все шаги|недопустим|«завершено» нельзя/);

  const report = fs.readFileSync(out.reportFile, 'utf8');
  assert.match(report, /\*\*Итог: Только чтение — изменений не выполнялось\*\*/);
  assert.match(report, /- Код итога: not_applicable/);
  assert.match(report, /## Критерии приёмки\n\nКритерии приёмки не заданы: план составлен до их введения \(легаси-задача\)/);
  assert.match(report, /Обоснование \(рантайм\): задача только читала/);
  assert.match(report, /## Объективно проверено\n\n- нет/);
  assert.match(report, /## Наблюдения\n\n- s1\. Прочитать заметку: наблюдение: только чтение/);
  assert.match(report, /## Служебные шаги\n\n- s2\. Ответить владельцу: служебный шаг: итог в ответе.*; итог: Ответ: в заметке про улун/);
  assert.match(report, /## Непроверенные шаги\n\n- нет/);
  assert.match(report, /Результат проверки: не применимо: наблюдение/);
  assert.equal(h.events.at(-1).message, 'итог: Только чтение — изменений не выполнялось');
  assert.match(h.events.at(-1).summary, /Обоснование: задача только читала/);
  assert.deepEqual(
    { ...h.events.at(-1).verdict, reason: undefined },
    { code: 'not_applicable', status: 'unverified', reason: undefined, criteria: [] },
    'событие итога несёт verdict {code, status, reason, criteria}',
  );
  assert.equal(h.events.at(-1).verdict.reason, task.verdict.reason);
});

test('queue.complete: задача с мандатом без единой подтверждённой проверки «завершено» не получает', () => {
  const q = new TaskQueue({ now: () => NOW });
  q.add(running([{ title: 'наблюдение', kind: 'observation' }]));
  q.markStep('v', 's1', 'done', { result: { verification: 'not_applicable', evidence: 'только чтение' } });
  assert.throws(() => q.complete('v'), /«завершено» нельзя: задача только читала/);
  q.markUnverified('v');
  assert.equal(q.get('v').verdict.code, 'not_applicable');

  // Без мандата (задачи чата) — как раньше: verdict не пишется и не мешает.
  const chat = new TaskQueue({ now: () => NOW });
  chat.add(running([{ title: 'a' }], { mandate: false }));
  chat.markStep('v', 's1', 'done');
  assert.equal(chat.complete('v').status, 'done');
  assert.equal(chat.get('v').verdict, undefined);
});

test('итог: план менял данные, но действий с проверкой нет — «выполнено, но не проверено», а не «не применимо»', () => {
  // Такая запись возможна, например, у старой задачи или если факты записаны, а шаг закрыт снаружи.
  let task = running([{ title: 'наблюдение', kind: 'observation' }]);
  task = model.addStepFacts(task, 's1', { effects: [{ tool: 'workspace_write', target: 'notes/a.md' }] });
  task = model.markStep(task, 's1', 'done', { result: { verification: 'not_applicable', evidence: 'x' } });
  const v = model.taskVerdict(task);
  assert.deepEqual([v.status, v.code], ['unverified', 'unverified']);
  assert.match(v.reason, /план менял данные \(действий с побочным эффектом: 1\)/);
  assert.deepEqual(task.plan[0].result.effects, [{ tool: 'workspace_write', target: 'notes/a.md' }], 'markStep не стёр факт');
});

test('итог: действие с проверкой без подтверждения (verification не confirmed) — не «завершено»', () => {
  let task = running([{ title: 'a', check: { kind: 'file_exists', path: 'a.md' } }]);
  task = model.markStep(task, 's1', 'done', { result: { verification: 'unknown', evidence: 'не удалось проверить' } });
  const v = model.taskVerdict(task);
  assert.equal(v.status, 'unverified');
  assert.match(v.reason, /проверка не подтверждена: s1/);
});

// ---- Фикстура live-03 (задача tmvvbdz1p7fd80f, «Пять шагов о чае»), собранная в тесте, без data\.
// s1..s5 — записать step-N.md с двумя предложениями о чае; s6..s10 — проверка слова «чай» (file_contains);
// s11 — список папки live-03 (наблюдение); s12 — итоговый отчёт в ответе (служебный шаг), модель пытается
// записать reports/live-03-final.md, мандат отказывает (папка мандата — только live-03).
const LIVE03_GOAL = 'Пять шагов о чае: в папке live-03 файлы step-1.md … step-5.md, в каждом ровно два предложения о чае; итог — в ответе';
const TWO = (n) => `Чай номер ${n} заваривают при 85 градусах. Этот чай пьют без сахара.`;

function live03Plan({ sentenceCount, kinds = true }) {
  const steps = [];
  for (let n = 1; n <= 5; n += 1) {
    const step = { title: `Записать в live-03/step-${n}.md два предложения о чае` };
    if (sentenceCount) step.check = { kind: 'sentence_count', path: `live-03/step-${n}.md`, count: 2 };
    steps.push(step);
  }
  for (let n = 1; n <= 5; n += 1) {
    steps.push({ title: `Убедиться, что в live-03/step-${n}.md есть слово «чай»`, check: { kind: 'file_contains', path: `live-03/step-${n}.md`, text: 'чай' } });
  }
  steps.push({ title: 'Показать состав папки live-03', ...(kinds ? { kind: 'observation' } : {}) });
  steps.push({ title: 'Итоговый отчёт в ответе чата', ...(kinds ? { kind: 'service' } : {}) });
  return steps;
}

function live03Script(plan) {
  const script = [planReply(plan)];
  for (let n = 1; n <= 5; n += 1) {
    script.push(toolReply(['workspace_write', { path: `live-03/step-${n}.md`, content: TWO(n) }], ['step_done', { summary: `step-${n}.md записан` }]));
  }
  for (let n = 1; n <= 5; n += 1) script.push(doneReply(`в step-${n}.md есть «чай»`));
  script.push(toolReply(['workspace_list', { path: 'live-03' }], ['step_done', { summary: 'в папке пять файлов' }]));
  script.push(toolReply(['workspace_write', { path: 'reports/live-03-final.md', content: '# Итог\nпять файлов' }]));
  script.push(doneReply('Итог: пять файлов о чае записаны, в каждом два предложения'));
  return script;
}

async function runLive03(t, opts) {
  const h = setup(t, { goal: LIVE03_GOAL, script: live03Script(live03Plan(opts)) });
  h.addTask('tmvvbdz1p7fd80f', { folders: ['live-03'] });
  const out = await h.executor.submit('tmvvbdz1p7fd80f');
  return { h, out, task: h.queue.get('tmvvbdz1p7fd80f'), report: fs.readFileSync(out.reportFile, 'utf8') };
}

function assertLive03Common({ h, task, report }) {
  assert.equal(task.plan.length, 12);
  const [s11, s12] = [task.plan[10], task.plan[11]];
  // s11/s12 не делают задачу непроверенной.
  assert.ok(!task.unverifiedSteps.includes('s11') && !task.unverifiedSteps.includes('s12'));
  assert.deepEqual([s11.status, s11.result.verification], ['done', 'not_applicable']);
  assert.deepEqual([s12.status, s12.result.verification], ['done', 'not_applicable']);
  assert.match(s11.result.evidence, /^наблюдение: только чтение \(workspace_list\)/);
  // Отказ мандата не затёрт последующим step_done.
  assert.equal(s12.result.refusals.length, 1);
  assert.equal(s12.result.refusals[0].tool, 'workspace_write');
  assert.equal(s12.result.refusals[0].target, 'reports/live-03-final.md');
  assert.match(s12.result.refusals[0].reason, /вне папок мандата/);
  assert.match(s12.result.evidence, /отказов мандата: 1/);
  assert.ok(task.log.some((l) => l.event === 'шаг s12: failed'), 'отказ засчитан ошибкой шага, как раньше');
  assert.equal(task.failures.s12, undefined, 'счётчик неудач сброшен выполнением шага, как раньше');
  assert.equal(fs.existsSync(path.join(h.root, 'reports', 'live-03-final.md')), false, 'запрещённая запись не состоялась');
  for (let n = 1; n <= 5; n += 1) assert.equal(fs.readFileSync(path.join(h.root, 'live-03', `step-${n}.md`), 'utf8'), TWO(n));
  // Отчёт: разделы и отказ мандата.
  assert.match(report, /## Наблюдения\n\n- s11\. Показать состав папки live-03: наблюдение: только чтение \(workspace_list\)/);
  assert.match(report, /## Служебные шаги\n\n- s12\. Итоговый отчёт в ответе чата: служебный шаг: итог в ответе; .*отказов мандата: 1; итог: Итог: пять файлов/);
  assert.match(report, /## Отказы мандата\n\n- s12\. workspace_write reports\/live-03-final\.md: путь «reports\/live-03-final\.md» вне папок мандата/);
  for (let n = 6; n <= 10; n += 1) assert.match(report, new RegExp(`- s${n}\\. Убедиться, что в live-03/step-${n - 5}\\.md есть слово «чай»: подтверждено`));
}

test('live-03, без sentence_count: «выполнено, но не проверено» только из-за «двух предложений» (s1..s5 — оценка модели)', async (t) => {
  const run = await runLive03(t, { sentenceCount: false });
  assertLive03Common(run);
  const { task, report, out } = run;
  assert.equal(out.status, 'unverified');
  assert.equal(task.verdict.code, 'unverified');
  assert.deepEqual(task.unverifiedSteps, ['s1', 's2', 's3', 's4', 's5']);
  assert.deepEqual(model.taskVerdict(task).modelOnly, ['s1', 's2', 's3', 's4', 's5']);
  assert.match(task.verdict.reason, /без объективной проверки \(оценка модели\): s1, s2, s3, s4, s5$/);
  assert.match(report, /\*\*Итог: выполнено, но не проверено\*\*/);
  assert.match(report, /## Оценка модели без объективной проверки\n\n- s1\. Записать в live-03\/step-1\.md два предложения о чае: выполнено по словам модели/);
  assert.match(report, /## Непроверенные шаги\n\n- s1\. .*: выполнен без объективной проверки, результат не проверен/);
  assert.ok(!/- s1[12]\. .*выполнен без объективной проверки/.test(report), 's11 и s12 не в непроверенных');
});

test('live-03, с sentence_count у s1..s5: «завершено» — все 10 объективных проверок подтверждены', async (t) => {
  const run = await runLive03(t, { sentenceCount: true });
  assertLive03Common(run);
  const { task, report, out } = run;
  assert.equal(out.status, 'done');
  assert.equal(task.verdict.code, 'verified');
  assert.deepEqual(task.unverifiedSteps, []);
  assert.equal(task.plan.filter((s) => s.result.verification === 'confirmed').length, 10);
  assert.match(task.plan[0].result.evidence, /подтверждено: в файле ровно 2 предл\.: live-03\/step-1\.md/);
  assert.match(report, /\*\*Итог: проверено\*\*/);
  assert.match(report, /## Оценка модели без объективной проверки\n\n- нет/);
  assert.match(report, /## Непроверенные шаги\n\n- нет/);
  assert.match(report, /## Объективно проверено\n\n- s1\. Записать в live-03\/step-1\.md два предложения о чае: подтверждено/);
});

test('live-03 без kind у s11/s12 (старый план): поведение как раньше — оба шага непроверенные, отказ всё равно в итоге шага', async (t) => {
  const { task, out } = await runLive03(t, { sentenceCount: true, kinds: false });
  assert.equal(out.status, 'unverified');
  assert.deepEqual(task.unverifiedSteps, ['s11', 's12']);
  assert.equal(task.plan[11].result.verification, 'none');
  assert.equal(task.plan[11].result.refusals.length, 1, 'отказ мандата не потерян и у старого плана');
});

// ---- numbered_steps: дополнительные случаи.

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-verdict-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, resolve: (rel) => path.resolve(dir, rel) };
}

test('numbered_steps: раздел по заголовку, только верхний уровень внутри раздела; «Подэтапы» не подменяют «Этапы»', (t) => {
  const { dir, resolve } = tmp(t);
  const check = (body, extra = {}) => {
    fs.writeFileSync(path.join(dir, 'plan.md'), body, 'utf8');
    return runCheck({ kind: 'numbered_steps', path: 'plan.md', section: 'Этапы', count: 5, ...extra }, { resolve });
  };
  const items = (nums) => nums.map((n) => `${n}. Этап ${n}`).join('\n');
  assert.equal(check(`## Этапы\n\n${items([1, 2, 3, 4, 5])}\n`).status, 'confirmed');
  // Нет раздела.
  assert.match(check(`## План\n\n${items([1, 2, 3, 4, 5])}\n`).evidence, /раздел «Этапы» не найден/);
  // Вложенный пункт с отступом не считается.
  assert.equal(check(`## Этапы\n\n${items([1, 2, 3, 4])}\n  5. вложенный\n`).status, 'failed');
  assert.equal(check(`## Этапы\n\n${items([1, 2, 3, 4, 5])}\n   6. вложенный\n`).status, 'confirmed', 'вложенный шестой не мешает');
  // Пункт 5 вне раздела (после заголовка любого уровня) не даёт успеха.
  assert.equal(check(`## Этапы\n\n${items([1, 2, 3, 4])}\n\n### Детали\n\n5. ещё\n`).status, 'failed');
  assert.equal(check(`# Заметки\n\n5. раньше раздела\n\n## Этапы\n\n${items([1, 2, 3, 4])}\n`).status, 'failed');
  // 1, 2, 2, 4 и нулевой пункт.
  assert.match(check(`## Этапы\n\n${items([1, 2, 2, 4])}\n`).evidence, /пункты: 1, 2, 2, 4; нужно ровно 5/);
  assert.equal(check(`## Этапы\n\n${items([0, 1, 2, 3, 4])}\n`).status, 'failed');
  assert.equal(check(`## Этапы\n\n${items([0, 1, 2, 3, 4, 5])}\n`).status, 'failed', 'нулевой пункт — лишний');
  // count вне 1..50 и не целое — «не удалось проверить».
  for (const count of [0, 51, 2.5, '5', -1]) {
    assert.equal(check(`## Этапы\n\n${items([1, 2, 3, 4, 5])}\n`, { count }).status, 'unknown', String(count));
  }
  assert.equal(check(`## Этапы\n\n${items(Array.from({ length: 50 }, (_, i) => i + 1))}\n`, { count: 50 }).status, 'confirmed');
  // Дефект подстроки: раньше «## Подэтапы» выше по тексту перехватывал раздел «Этапы» (ложное «подтверждено»).
  const tricky = `## Подэтапы\n\n${items([1, 2, 3, 4, 5])}\n\n## Этапы\n\n${items([1, 2, 3])}\n`;
  assert.equal(check(tricky).status, 'failed');
  assert.match(check(tricky).evidence, /пункты: 1, 2, 3;/);
  // Точное совпадение заголовка важнее частичного; частичное целыми словами — работает, как раньше.
  assert.equal(check(`## Этапы проекта\n\n${items([1, 2, 3])}\n\n## Этапы\n\n${items([1, 2, 3, 4, 5])}\n`).status, 'confirmed');
  assert.equal(check(`## Этапы разработки\n\n${items([1, 2, 3, 4, 5])}\n`).status, 'confirmed');
});

// ---- sentence_count.

test('sentence_count: ровно count предложений; разделители . ! ? … с пробелом или концом текста', (t) => {
  const { dir, resolve } = tmp(t);
  const check = (body, count = 2) => {
    fs.writeFileSync(path.join(dir, 's.md'), body, 'utf8');
    return runCheck({ kind: 'sentence_count', path: 's.md', count }, { resolve });
  };
  assert.equal(check('Чай — древний напиток. Его пьют во всём мире.').status, 'confirmed');
  assert.match(check('Чай — древний напиток. Его пьют во всём мире.').evidence, /^в файле ровно 2 предл\.: s\.md$/);
  assert.equal(check('Чай вкусный. Он полезен').status, 'confirmed', 'последний фрагмент без точки — предложение');
  assert.equal(check('Чай?! Да… Конечно!').status, 'failed');
  assert.match(check('Чай?! Да… Конечно!').evidence, /в файле 3 предл\., нужно ровно 2/);
  assert.equal(check('Чай.\n\nКофе.\n').status, 'confirmed', 'перевод строки — тоже разделитель');
  assert.equal(check('Чай... . ! Кофе.').status, 'confirmed', 'фрагменты без букв не считаются');
  assert.equal(check('В чашке 0.5 литра чая. Это много.').status, 'confirmed', 'число с точкой без пробела не делит');
  assert.equal(check('Одно предложение без деления').status, 'failed');
  assert.equal(check('', 1).status, 'failed', 'пустой файл — 0 предложений');
  assert.equal(runCheck({ kind: 'sentence_count', path: 'нет.md', count: 2 }, { resolve }).status, 'failed');
  for (const count of [0, 51, 1.5, '2', null]) assert.equal(check('Чай.', count).status, 'unknown', String(count));
  // Ограничения записаны в verify.js: сокращения и номера с точкой и пробелом считаются концом предложения.
  assert.equal(countSentences('Т. е. чай полезен.'), 3);
  assert.equal(countSentences('1. Заварить чай'), 2);
});

// ---- Непроверенный обязательный критерий: не полный проверенный успех.

test('шаги подтверждены, но обязательный критерий не проверен (manual) или не подтверждён — итог не done/verified', async (t) => {
  const steps = [{ title: 'Записать заметку', check: { kind: 'file_exists', path: 'notes/a.md' } }];
  const write = toolReply(['workspace_write', { path: 'notes/a.md', content: 'Улун.' }], ['step_done', { summary: 'записал' }]);
  const cases = [
    { crit: { requirement: 'тема — чай', text: 'о чае', manual: { kind: 'model_only', reason: 'тему оценивает модель' } }, code: 'unverified' },
    { crit: { requirement: 'тема — чай', text: 'о чае', manual: { kind: 'impossible', reason: 'проверить нечем' } }, code: 'unverified' },
    { crit: { requirement: 'есть слово «пуэр»', text: 'пуэр', check: { kind: 'file_contains', path: 'notes/a.md', text: 'пуэр' } }, code: 'failed' },
  ];
  for (const { crit, code } of cases) {
    const ok = { requirement: 'заметка есть', text: 'файл', check: { kind: 'file_exists', path: 'notes/a.md' } };
    const h = setup(t, { script: [{ toolCalls: [{ name: 'task_plan_submit', args: { steps, criteria: [ok, crit] } }] }, write] });
    h.addTask('u');
    const out = await h.executor.submit('u');
    const task = h.queue.get('u');
    assert.equal(task.plan[0].result.verification, 'confirmed', 'шаг подтверждён проверкой');
    assert.notEqual(out.status, 'done', code);
    assert.equal(out.status, 'unverified');
    assert.deepEqual([task.verdict.code, task.verdict.status], [code, 'unverified']);
    assert.notEqual(task.verdict.code, 'verified');
    assert.throws(() => h.queue.complete('u'));
  }
});
