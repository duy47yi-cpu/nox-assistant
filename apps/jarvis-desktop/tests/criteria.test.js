'use strict';

// Этап 3: критерии приёмки в плане исполнителя, итог по критериям (verified / unverified / failed), легаси-задачи
// без критериев, сводка стоимости из журнала (cost/summary.js) в отчёте. Модель подставная, реальная не вызывается;
// данные — во временных папках.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../src/tasks/model');
const criteria = require('../src/tasks/criteria');
const { TaskQueue } = require('../src/tasks/queue');
const { createMandate } = require('../src/tasks/mandate');
const { createExecutor, renderReport, READ_ONLY_TEXT, FAILED_TEXT } = require('../src/tasks/executor');
const { taskCostSummary } = require('../src/cost/summary');
const { Meter, MAX_CALLS } = require('../src/cost/meter');
const { StopSwitch } = require('../src/control/stop');
const { ApprovalBroker } = require('../src/policy/approvals');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');

const NOW = Date.UTC(2026, 9, 31, 12, 0);
const PRICED = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const USAGE = Object.freeze({ promptTokens: 800, cachedTokens: 200, completionTokens: 100, reasoningTokens: 0 });

function tmpDir(t, prefix = 'jarvis-criteria-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Подставная модель без автодобавления критериев: что в сценарии, то и в ответе.
function scriptedBrain(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async chat(req) {
      calls.push({ purpose: req.purpose, tools: (req.tools || []).map((x) => x.function.name), messages: req.messages.slice() });
      if (i >= script.length) throw new Error('сценарий модели исчерпан');
      const next = script[i];
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

const plan = (steps, crit) => ({ toolCalls: [{ name: 'task_plan_submit', args: crit === undefined ? { steps } : { steps, criteria: crit } }] });
const toolReply = (...calls) => ({ toolCalls: calls.map(([name, args]) => ({ name, args })) });
const doneReply = (summary = 'готово') => toolReply(['step_done', { summary }]);

function setup(t, { script = [], goal, folders, costSummary } = {}) {
  const base = tmpDir(t, 'jarvis-criteria-exec-');
  const root = path.join(base, 'workspace');
  for (const dir of ['notes', 'reports', 'live-03']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const index = new WorkspaceIndex(root);
  const resolve = (rel) => index.resolveInside(rel);
  const ws = workspaceTools(index);
  const brain = scriptedBrain(script);
  const queue = new TaskQueue({ now: () => NOW });
  const journal = [];
  const events = [];
  const executor = createExecutor({
    queue,
    saveTasks: () => {},
    brain,
    runTool: async (name, args) => {
      const tool = ws.find((x) => x.name === name);
      return tool ? tool.run(args) : { ok: false, summary: `нет инструмента ${name}` };
    },
    toolSpecs: ws,
    approvals: new ApprovalBroker(),
    stop: new StopSwitch(),
    journal: { append: (e) => journal.push(e) },
    resolve,
    emit: (e) => events.push(e),
    costOf: () => null,
    costSummary,
    now: () => NOW,
    sandboxReportsDir: 'reports',
  });
  const addTask = (id) => {
    const m = createMandate({
      goal, tools: ['workspace_list', 'workspace_read', 'workspace_write'], sandboxRoot: root, now: NOW, ...(folders ? { folders } : {}),
    });
    m.approvedBy = 'владелец';
    return queue.add(model.createTask({ id, title: `Задача ${id}`, goal, now: NOW, mandate: m }));
  };
  return { root, resolve, brain, queue, journal, events, executor, addTask };
}

// ---- Разбор критериев (criteria.cleanCriteria).

const okCheck = (c) => ({ value: { ...c } });

test('критерии: requirement — свободный текст (не сверяется с целью); ровно одно из check / manual; пустой список — ошибка', () => {
  const good = criteria.cleanCriteria([
    { requirement: 'ровно два предложения', text: 'в файле два предложения', check: { kind: 'sentence_count', path: 'notes/tea.md', count: 2 } },
    { requirement: 'о чае', text: 'текст о чае', manual: { kind: 'model_only', reason: 'тему оценивает модель' } },
    { requirement: 'Записать в\nnotes/tea.md', text: 'пробелы и переводы строк сводятся к одному', check: { kind: 'file_exists', path: 'notes/tea.md' } },
  ], { cleanCheck: okCheck });
  assert.equal(good.error, undefined, good.error);
  assert.deepEqual(good.value.map((c) => c.id), ['c1', 'c2', 'c3']);
  assert.deepEqual(good.value[1].manual, { kind: 'model_only', reason: 'тему оценивает модель' });
  assert.equal(good.value[1].check, null);
  assert.equal(good.value[2].requirement, 'Записать в notes/tea.md');

  const err = (list) => criteria.cleanCriteria(list, { cleanCheck: okCheck }).error;
  assert.match(err(undefined), /нужен список критериев приёмки criteria/);
  assert.match(err([]), /список критериев приёмки пуст/);
  assert.match(err('c1'), /criteria должен быть списком/);
  assert.match(err([{ text: 'x', manual: { kind: 'impossible', reason: 'r' } }]), /нет requirement/);
  assert.match(err([{ requirement: '   ', text: 'x', manual: { kind: 'impossible', reason: 'r' } }]), /нет requirement/);
  assert.match(err([{ requirement: 'я'.repeat(301), text: 'x', manual: { kind: 'impossible', reason: 'r' } }]), /requirement длиннее 300/);
  assert.match(err([{ requirement: 'о чае', manual: { kind: 'impossible', reason: 'r' } }]), /нет text/);
  assert.match(
    err([{ requirement: 'о чае', text: 'x', check: { kind: 'file_exists', path: 'a.md' }, manual: { kind: 'model_only', reason: 'r' } }]),
    /нужно ровно одно из check \(объективная проверка\) или manual/,
  );
  assert.match(err([{ requirement: 'о чае', text: 'x' }]), /ровно одно из check/);
  assert.match(err([{ requirement: 'о чае', text: 'x', manual: { kind: 'guess', reason: 'r' } }]), /manual\.kind — model_only/);
  assert.match(err([{ requirement: 'о чае', text: 'x', manual: { kind: 'model_only' } }]), /нужна причина reason/);
  const badCheck = criteria.cleanCriteria(
    [{ requirement: 'о чае', text: 'x', check: { kind: 'nope', path: 'a' } }],
    { cleanCheck: () => ({ error: 'неизвестный вид проверки «nope»' }) },
  );
  assert.match(badCheck.error, /^критерий 1: неизвестный вид проверки «nope»/);
});

test('критерии: перефразированный и уточнённый requirement принимается — это происхождение, а не проверка соответствия цели', () => {
  const goal = 'Записать в notes/tea.md ровно два предложения о чае';
  const res = criteria.cleanCriteria([
    { requirement: 'два предложения про чай', text: 'в файле два предложения', check: { kind: 'sentence_count', path: 'notes/tea.md', count: 2 } },
    { requirement: 'Ровно два предложения (уточнено владельцем: без списков)', text: 'нет списков', manual: { kind: 'model_only', reason: 'оценивает модель' } },
    { requirement: 'файл заметки', text: 'файл есть', check: { kind: 'file_exists', path: 'notes/tea.md' } },
  ], { goal, cleanCheck: okCheck });
  assert.equal(res.error, undefined, res.error);
  assert.deepEqual(res.value.map((c) => c.requirement), [
    'два предложения про чай', 'Ровно два предложения (уточнено владельцем: без списков)', 'файл заметки',
  ]);
  for (const c of res.value) assert.equal(goal.includes(c.requirement), false, 'ни один requirement не подстрока цели — и это не ошибка');
  assert.equal(criteria.ORIGIN_NOTE, 'критерий сформулирован планировщиком, полнота не проверена');
  assert.deepEqual(res.value.map(criteria.methodOf), ['объективная проверка', 'оценка модели', 'объективная проверка']);
  assert.equal(criteria.methodOf({ manual: { kind: 'impossible', reason: 'r' } }), 'проверка невозможна');
});

// ---- Итог по критериям (model.taskVerdict) и легаси.

function runningTask({ steps, crit, mandate = true }) {
  const m = mandate ? { goal: 'g', tools: ['workspace_read'], folders: ['.'], root: '/', expiresAt: NOW + 1000, limits: {}, approvedBy: 'x' } : null;
  const task = model.createTask({ id: 'v', title: 'V', goal: 'пять файлов и два предложения', now: NOW, mandate: m });
  const planned = model.setPlan(task, steps, { now: NOW, ...(crit ? { criteria: crit } : {}) });
  return model.transition(model.transition(planned, 'queued'), 'running');
}

const C_CHECK = (id, requirement, verification) => ({
  id, requirement, text: 't', check: { kind: 'file_exists', path: 'a.md' }, manual: null,
  ...(verification ? { result: { verification, evidence: `${verification}: a.md` } } : {}),
});
const C_MANUAL = (id, requirement, kind) => ({ id, requirement, text: 't', check: null, manual: { kind, reason: 'нет проверки' } });

test('итог по критериям: verified только если все критерии подтверждены и нет шагов без проверки; manual → unverified; не подтверждён → failed', () => {
  const confirmedStep = (task) => model.markStep(task, 's1', 'done', { result: { verification: 'confirmed', evidence: 'ok' } });
  const steps = [{ title: 'Записать', check: { kind: 'file_exists', path: 'a.md' } }];

  let v = model.taskVerdict(confirmedStep(runningTask({ steps, crit: [C_CHECK('c1', 'пять файлов', 'confirmed')] })));
  assert.deepEqual([v.status, v.code], ['done', 'verified']);
  assert.match(v.reason, /все критерии приёмки подтверждены проверкой: 1/);
  assert.deepEqual(v.criteria, [{ id: 'c1', requirement: 'пять файлов', state: 'verified', evidence: 'подтверждено: confirmed: a.md' }]);

  v = model.taskVerdict(confirmedStep(runningTask({ steps, crit: [C_CHECK('c1', 'пять файлов', 'confirmed'), C_MANUAL('c2', 'два предложения', 'model_only')] })));
  assert.deepEqual([v.status, v.code], ['unverified', 'unverified']);
  assert.match(v.reason, /^критерий проверен только оценкой модели: c2 \(«два предложения»\)$/);
  assert.equal(v.criteria[1].state, 'model_only');
  assert.equal(v.criteria[1].evidence, 'оценка модели: нет проверки');

  v = model.taskVerdict(confirmedStep(runningTask({ steps, crit: [C_MANUAL('c1', 'пять файлов', 'impossible')] })));
  assert.deepEqual([v.status, v.code], ['unverified', 'unverified']);
  assert.match(v.reason, /критерий проверить невозможно: c1 \(«пять файлов»\)/);
  assert.equal(v.criteria[0].state, 'impossible');

  for (const verification of ['failed', 'unknown', undefined]) {
    v = model.taskVerdict(confirmedStep(runningTask({ steps, crit: [C_CHECK('c1', 'пять файлов', 'confirmed'), C_CHECK('c2', 'два предложения', verification)] })));
    assert.deepEqual([v.status, v.code], ['unverified', 'failed'], String(verification));
    assert.match(v.reason, /^критерий приёмки не подтверждён: c2 \(«два предложения»\) — /);
    assert.equal(v.criteria[1].state, 'failed');
  }

  // Все критерии подтверждены, но шаг-действие без проверки: не «проверено».
  const noCheck = model.markStep(runningTask({ steps: [{ title: 'Подумать' }], crit: [C_CHECK('c1', 'пять файлов', 'confirmed')] }), 's1', 'done');
  v = model.taskVerdict(noCheck);
  assert.deepEqual([v.status, v.code], ['unverified', 'unverified']);
  assert.match(v.reason, /^без объективной проверки \(оценка модели\): s1$/);
  // Шаг с проверкой, которая не подтверждена.
  const unconfirmed = model.markStep(runningTask({ steps, crit: [C_CHECK('c1', 'пять файлов', 'confirmed')] }), 's1', 'done', { result: { verification: 'unknown', evidence: '?' } });
  assert.match(model.taskVerdict(unconfirmed).reason, /проверка не подтверждена: s1/);
});

test('not_applicable не бывает у задачи с критериями: задача на чтение проверяется по критериям', () => {
  const read = (crit) => model.markStep(runningTask({ steps: [{ title: 'Прочитать', kind: 'observation' }], crit }), 's1', 'done', {
    result: { verification: 'not_applicable', evidence: 'только чтение' },
  });
  let v = model.taskVerdict(read([C_MANUAL('c1', 'пять файлов', 'model_only')]));
  assert.deepEqual([v.status, v.code], ['unverified', 'unverified']);
  v = model.taskVerdict(read([C_CHECK('c1', 'пять файлов', 'confirmed')]));
  assert.deepEqual([v.status, v.code], ['done', 'verified'], 'исследование с подтверждённым критерием — «проверено»');
  v = model.taskVerdict(read([C_CHECK('c1', 'пять файлов', 'failed')]));
  assert.deepEqual([v.status, v.code], ['unverified', 'failed']);
  // Та же задача без критериев (легаси) — not_applicable, как раньше.
  v = model.taskVerdict(read(undefined));
  assert.deepEqual([v.status, v.code], ['unverified', 'not_applicable']);
  assert.deepEqual(v.criteria, []);
});

test('легаси без критериев: итог по старым правилам, verdict в очереди — {code, status, reason, criteria: []}', () => {
  const steps = [{ title: 'Записать', check: { kind: 'file_exists', path: 'a.md' } }];
  const legacy = model.markStep(runningTask({ steps }), 's1', 'done', { result: { verification: 'confirmed', evidence: 'ok' } });
  assert.equal(legacy.criteria, undefined);
  const v = model.taskVerdict(legacy);
  assert.deepEqual([v.status, v.code, v.reason], ['done', 'verified', 'все шаги-действия подтверждены проверкой: 1']);
  const q = new TaskQueue({ tasks: [legacy], now: () => NOW });
  q.complete('v');
  assert.deepEqual(q.get('v').verdict, { code: 'verified', status: 'done', reason: 'все шаги-действия подтверждены проверкой: 1', criteria: [] });

  // Пустой список criteria в старой записи — тоже легаси.
  const empty = { ...model.markStep(runningTask({ steps: [{ title: 'Подумать' }] }), 's1', 'done'), criteria: [] };
  assert.deepEqual([model.taskVerdict(empty).code, model.taskVerdict(empty).reason], ['unverified', 'без объективной проверки (оценка модели): s1']);

  // queue.complete отказывает задаче с не подтверждённым критерием, markUnverified пишет failed.
  const failed = model.markStep(runningTask({ steps, crit: [C_CHECK('c1', 'пять файлов', 'failed')] }), 's1', 'done', { result: { verification: 'confirmed', evidence: 'ok' } });
  const fq = new TaskQueue({ tasks: [failed], now: () => NOW });
  assert.throws(() => fq.complete('v'), /«завершено» нельзя: критерий приёмки не подтверждён: c1/);
  fq.markUnverified('v');
  assert.deepEqual([fq.get('v').status, fq.get('v').verdict.code, fq.get('v').verdict.status], ['unverified', 'failed', 'unverified']);
  assert.equal(fq.get('v').verdict.criteria[0].state, 'failed');
});

// ---- Исполнитель: план без критериев не принимается.

test('исполнитель: план без критериев, с пустым списком или с путём проверки наружу — не принят, модель переспрошена с причиной', async (t) => {
  const goal = 'Записать заметку о чае в notes/tea.md';
  const steps = [{ title: 'Записать', check: { kind: 'file_exists', path: 'notes/tea.md' } }];
  const h = setup(t, { goal, script: [plan(steps), plan(steps, [])] });
  h.addTask('m1');
  const out = await h.executor.submit('m1');
  assert.equal(out.status, 'blocked');
  assert.equal(h.queue.get('m1').reason, 'не удалось составить план');
  assert.match(h.brain.calls[1].messages.at(-1).content, /Причина повтора: нужен список критериев приёмки criteria/);
  assert.ok(h.journal.some((e) => /список критериев приёмки пуст/.test(e.summary)));
  // Промпт планирования: критерии обязательны, требование не ослабляется, manual помечается честно.
  const prompt = h.brain.calls[0].messages[0].content;
  assert.match(prompt, /Критерии приёмки \(criteria\) — отдельный список, обязателен, минимум один критерий/);
  assert.match(prompt, /requirement — какое требование цели закрывает критерий \(цитата или своими словами\)/);
  assert.doesNotMatch(prompt, /дословная фраза/);
  assert.match(prompt, /полноту критериев код не проверяет: в отчёте они помечены «критерий сформулирован планировщиком, полнота не проверена»/);
  assert.match(prompt, /не заменяй требование более слабым условием и не выдавай частичную проверку за полную/);
  assert.match(prompt, /manual: model_only \(доступна только оценка модели\) или impossible \(проверить нельзя\)/);

  const p = setup(t, {
    goal,
    script: [
      plan(steps, [{ requirement: 'заметку о чае', text: 'файл есть', check: { kind: 'file_exists', path: '../outside.md' } }]),
      plan(steps, [{ requirement: 'заметку о чае', text: 'файл есть', check: { kind: 'file_exists', path: '../outside.md' } }]),
    ],
  });
  p.addTask('m2');
  assert.equal((await p.executor.submit('m2')).status, 'blocked');
  assert.match(p.brain.calls[1].messages.at(-1).content, /критерий 1: путь проверки «\.\.\/outside\.md» не разрешён/);
  assert.ok(p.journal.some((e) => /критерий 1: путь проверки «\.\.\/outside\.md» не разрешён/.test(e.summary)), 'путь критерия — по правилам шага');
});

test('исполнитель: план с перефразированным requirement принят; критерии с пометкой способа — в событии плана; отчёт пишет происхождение', async (t) => {
  const goal = 'Записать заметку о чае в notes/tea.md';
  const steps = [{ title: 'Записать', check: { kind: 'file_exists', path: 'notes/tea.md' } }];
  const crit = [
    { requirement: 'заметка про чай должна лежать в notes', text: 'файл notes/tea.md есть', check: { kind: 'file_exists', path: 'notes/tea.md' } },
    { requirement: 'заметка о чае (по смыслу)', text: 'текст о чае', manual: { kind: 'model_only', reason: 'тему оценивает модель' } },
    { requirement: 'приятный стиль', text: 'стиль', manual: { kind: 'impossible', reason: 'вкус не проверить' } },
  ];
  const h = setup(t, {
    goal,
    script: [plan(steps, crit), toolReply(['workspace_write', { path: 'notes/tea.md', content: 'Улун.' }], ['step_done', { summary: 'записал' }])],
  });
  h.addTask('m3');
  const out = await h.executor.submit('m3');
  const task = h.queue.get('m3');
  assert.equal(task.criteria[0].requirement, 'заметка про чай должна лежать в notes', 'перефразирование не ошибка');
  assert.equal(task.goal, goal, 'исходная цель хранится дословно');
  assert.equal(task.mandate.goal, goal);
  const ev = h.events.find((e) => /^план: /.test(String(e.message)));
  assert.match(ev.message, /^план: 1 шагов; критерии приёмки \(критерий сформулирован планировщиком, полнота не проверена\): /);
  assert.match(ev.message, /c1\. файл notes\/tea\.md есть — объективная проверка: есть файл notes\/tea\.md/);
  assert.match(ev.message, /c2\. текст о чае — оценка модели: тему оценивает модель/);
  assert.match(ev.message, /c3\. стиль — проверка невозможна: вкус не проверить/);
  assert.deepEqual(ev.criteria.map((c) => [c.id, c.method]), [['c1', 'объективная проверка'], ['c2', 'оценка модели'], ['c3', 'проверка невозможна']]);
  assert.equal(ev.approvalId, undefined, 'план показывается, а не одобряется: подтверждения плана нет');
  // Непроверенные обязательные условия (manual) — не полный проверенный успех.
  assert.equal(out.status, 'unverified');
  assert.equal(task.verdict.code, 'unverified');
  const report = fs.readFileSync(out.reportFile, 'utf8');
  assert.match(report, /Происхождение: критерий сформулирован планировщиком, полнота не проверена\. Исходная цель — в разделе «Цель» дословно\./);
  assert.doesNotMatch(report, /соответств/i, 'не называем это проверкой соответствия цели');
});

// ---- Live-03: фикстура собрана в тесте (data\tasks.json не читается).

const LIVE03_GOAL = 'Live-03: в папке live-03 пять файлов step-1.md … step-5.md, в каждом ровно два предложения о чае; итог — в ответе';
const TWO = (n) => `Чай номер ${n} заваривают при 85 градусах. Этот чай пьют без сахара.`;
const NUMS = [1, 2, 3, 4, 5];

function live03Steps() {
  return [
    ...NUMS.map((n) => ({ title: `Записать live-03/step-${n}.md`, check: { kind: 'file_exists', path: `live-03/step-${n}.md` } })),
    { title: 'Показать состав папки live-03', kind: 'observation' },
    { title: 'Итог в ответе чата', kind: 'service' },
  ];
}

function live03Criteria({ twoSentences }) {
  const files = NUMS.map((n) => ({ requirement: 'пять файлов', text: `есть live-03/step-${n}.md`, check: { kind: 'file_exists', path: `live-03/step-${n}.md` } }));
  const sentences = twoSentences === 'check'
    ? NUMS.map((n) => ({ requirement: 'два предложения', text: `в step-${n}.md ровно два предложения`, check: { kind: 'sentence_count', path: `live-03/step-${n}.md`, count: 2 } }))
    : [{ requirement: 'два предложения', text: 'в каждом файле ровно два предложения', manual: { kind: 'model_only', reason: 'число предложений оценивает модель' } }];
  return [...files, ...sentences];
}

async function runLive03(t, { twoSentences, texts = TWO, costSummary }) {
  const script = [plan(live03Steps(), live03Criteria({ twoSentences }))];
  for (const n of NUMS) script.push(toolReply(['workspace_write', { path: `live-03/step-${n}.md`, content: texts(n) }], ['step_done', { summary: `step-${n}.md записан` }]));
  script.push(toolReply(['workspace_list', { path: 'live-03' }], ['step_done', { summary: 'в папке пять файлов' }]));
  script.push(doneReply('Итог: пять файлов о чае'));
  const h = setup(t, { goal: LIVE03_GOAL, folders: ['live-03'], script, costSummary });
  h.addTask('live03');
  const out = await h.executor.submit('live03');
  return { h, out, task: h.queue.get('live03'), report: fs.readFileSync(out.reportFile, 'utf8') };
}

test('live-03: «пять файлов» (file_exists) и «два предложения» (sentence_count) → verified, «завершено»', async (t) => {
  const { h, out, task, report } = await runLive03(t, { twoSentences: 'check' });
  assert.equal(out.status, 'done');
  assert.equal(task.criteria.length, 10);
  assert.deepEqual(task.criteria.map((c) => c.result.verification), Array(10).fill('confirmed'));
  assert.deepEqual([task.verdict.code, task.verdict.status], ['verified', 'done']);
  assert.match(task.verdict.reason, /^все критерии приёмки подтверждены проверкой: 10; шагов-действий с подтверждённой проверкой: 5$/);
  assert.deepEqual(task.verdict.criteria.map((r) => r.state), Array(10).fill('verified'));
  assert.deepEqual(task.verdict.criteria[5], {
    id: 'c6', requirement: 'два предложения', state: 'verified', evidence: 'подтверждено: в файле ровно 2 предл.: live-03/step-1.md',
  });
  // Отчёт: раздел критериев, код итога, ограничение sentence_count.
  assert.match(report, /\*\*Итог: проверено\*\*/);
  assert.match(report, /- Код итога: verified/);
  assert.match(report, /## Критерии приёмки\n\n1\. c1\. Требование: «пять файлов»\n {3}- Что проверяем: есть live-03\/step-1\.md\n {3}- Способ: проверка: есть файл live-03\/step-1\.md\n {3}- Итог: подтверждено проверкой/);
  assert.match(report, /6\. c6\. Требование: «два предложения»\n {3}- Что проверяем: в step-1\.md ровно два предложения\n {3}- Способ: проверка: в файле live-03\/step-1\.md ровно 2 предл\.\n {3}- Итог: подтверждено проверкой \(в файле ровно 2 предл\.: live-03\/step-1\.md\)/);
  assert.match(report, /## Ограничения проверок\n\n- sentence_count — ограниченная эвристика, а не универсальная проверка естественного языка/);
  // Событие итога для окна.
  const final = h.events.at(-1);
  assert.equal(final.final, true);
  assert.deepEqual(Object.keys(final.verdict), ['code', 'status', 'reason', 'criteria']);
  assert.deepEqual([final.verdict.code, final.verdict.status, final.verdict.criteria.length], ['verified', 'done', 10]);
  assert.match(final.summary, /Критерии приёмки: подтверждено проверкой 10 из 10\./);
  // Шаг видит критерии, которые проверит код.
  assert.match(h.brain.calls[1].messages[0].content, /Критерии приёмки \(их проверит код после всех шагов\):\n- c1\. «пять файлов»: есть live-03\/step-1\.md \(проверка: есть файл live-03\/step-1\.md\)/);
  assert.ok(h.journal.some((e) => e.decision === 'criteria' && e.summary === 'подтверждено проверкой: 10 из 10 критериев'));
});

test('live-03: «два предложения» как manual model_only → unverified с понятной причиной, в отчёте «оценка модели»', async (t) => {
  const { out, task, report } = await runLive03(t, { twoSentences: 'manual' });
  assert.equal(out.status, 'unverified');
  assert.deepEqual([task.verdict.code, task.verdict.status], ['unverified', 'unverified']);
  assert.equal(task.verdict.reason, 'критерий проверен только оценкой модели: c6 («два предложения»)');
  assert.deepEqual(task.verdict.criteria.map((r) => r.state), [...Array(5).fill('verified'), 'model_only']);
  assert.equal(task.verdict.criteria[5].evidence, 'оценка модели: число предложений оценивает модель');
  assert.match(report, /\*\*Итог: выполнено, но не проверено\*\*/);
  assert.match(report, /- Код итога: unverified/);
  assert.match(report, /6\. c6\. Требование: «два предложения»\n {3}- Что проверяем: в каждом файле ровно два предложения\n {3}- Способ: оценка модели \(объективной проверки нет\): число предложений оценивает модель\n {3}- Итог: оценка модели/);
  assert.ok(!/## Ограничения проверок/.test(report), 'sentence_count не использован — пометки об эвристике нет');
});

test('live-03: в одном файле три предложения — критерий не подтверждён, итог failed, «завершено» не ставится', async (t) => {
  const texts = (n) => (n === 3 ? `${TWO(n)} И ещё одно.` : TWO(n));
  const { h, out, task, report } = await runLive03(t, { twoSentences: 'check', texts });
  assert.equal(out.status, 'unverified');
  assert.deepEqual([task.verdict.code, task.verdict.status], ['failed', 'unverified']);
  assert.match(task.verdict.reason, /^критерий приёмки не подтверждён: c8 \(«два предложения»\) — не подтверждено: в файле 3 предл\., нужно ровно 2: live-03\/step-3\.md$/);
  assert.equal(task.verdict.criteria[7].state, 'failed');
  assert.match(report, new RegExp(`\\*\\*Итог: ${FAILED_TEXT}\\*\\*`));
  assert.match(report, /- Код итога: failed/);
  assert.equal(h.events.at(-1).message, `итог: ${FAILED_TEXT}`);
  assert.equal(h.events.at(-1).verdict.code, 'failed');
});

test('задача на исследование с критериями: только чтение, но итог по критериям, а не «только чтение»', async (t) => {
  const goal = 'Найти в notes/a.md сорт чая и ответить в чате';
  const steps = [{ title: 'Прочитать notes/a.md', kind: 'observation' }, { title: 'Ответить', kind: 'service' }];
  const script = (crit) => [
    plan(steps, crit),
    toolReply(['workspace_read', { path: 'notes/a.md' }], ['step_done', { summary: 'прочитал' }]),
    doneReply('Сорт: улун'),
  ];
  const checked = setup(t, { goal, script: script([{ requirement: 'сорт чая', text: 'в заметке есть сорт', check: { kind: 'file_contains', path: 'notes/a.md', text: 'улун' } }]) });
  fs.writeFileSync(path.join(checked.root, 'notes', 'a.md'), 'улун', 'utf8');
  checked.addTask('r1');
  assert.equal((await checked.executor.submit('r1')).status, 'done');
  assert.equal(checked.queue.get('r1').verdict.code, 'verified');

  const manual = setup(t, { goal, script: script([{ requirement: 'ответить в чате', text: 'ответ верный', manual: { kind: 'model_only', reason: 'ответ оценивает модель' } }]) });
  fs.writeFileSync(path.join(manual.root, 'notes', 'a.md'), 'улун', 'utf8');
  manual.addTask('r2');
  const out = await manual.executor.submit('r2');
  assert.equal(out.status, 'unverified');
  assert.equal(manual.queue.get('r2').verdict.code, 'unverified', 'не not_applicable: у задачи есть критерии');
  const report = fs.readFileSync(out.reportFile, 'utf8');
  assert.ok(!report.includes(READ_ONLY_TEXT));
  assert.match(report, /\*\*Итог: выполнено, но не проверено\*\*/);
});

// ---- Сводка стоимости из журнала (cost/summary.js).

function meterOn(t) {
  const file = path.join(tmpDir(t, 'jarvis-criteria-cost-'), 'budget.json');
  return { file, meter: new Meter({ file, now: () => new Date(NOW) }) };
}

test('сводка стоимости: счёт задачи и попытки из журнала; полные данные; файл не меняется', (t) => {
  const { file, meter } = meterOn(t);
  meter.record({ purpose: 'plan', model: PRICED, usage: USAGE, taskId: 't1' });
  meter.record({ purpose: 'step', model: PRICED, usage: USAGE, taskId: 't1' });
  meter.record({ purpose: 'chat', model: PRICED, usage: USAGE });
  meter.record({ purpose: 'step', model: PRICED, usage: USAGE, taskId: 't2' });
  const before = fs.readFileSync(file, 'utf8');
  const s = taskCostSummary({ file, taskId: 't1', since: NOW - 1000, now: NOW });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'журнал только читается');
  assert.deepEqual(
    { available: s.available, attempts: s.attempts, known: s.known, complete: s.complete, problems: s.problems, computedAt: s.computedAt },
    { available: true, attempts: 2, known: true, complete: true, problems: [], computedAt: NOW },
  );
  assert.ok(Math.abs(s.usd - meter.spentForTask('t1')) < 1e-12, 'стоимость — та же, что счёт Meter');

  // Цена неизвестна: попытка есть, в сумму не входит — расход не известен точно.
  meter.record({ purpose: 'step', model: 'неизвестная-модель', usage: USAGE, taskId: 't1' });
  const unknown = taskCostSummary({ file, taskId: 't1', since: NOW - 1000, now: NOW });
  assert.deepEqual([unknown.attempts, unknown.known, unknown.complete], [3, false, true]);
  assert.match(unknown.knownNotes.join('; '), /попыток с неизвестной ценой: 1 — в сумму не входят/);
  // Ответ без usage: верхняя оценка.
  meter.record({ purpose: 'step', model: PRICED, usage: null, pessimisticTokens: { inputTokens: 10, outputTokens: 10 }, taskId: 't1' });
  assert.match(taskCostSummary({ file, taskId: 't1', since: NOW - 1000, now: NOW }).knownNotes.join('; '), /с верхней оценкой вместо точной стоимости: 1/);
});

test('сводка стоимости: журнал вытеснил записи (лимит calls) — «данные неполные», число попыток не выдумывается', (t) => {
  const { file, meter } = meterOn(t);
  for (let i = 0; i < 3; i += 1) meter.record({ purpose: 'step', model: PRICED, usage: USAGE, taskId: 'old' });
  for (let i = 0; i < MAX_CALLS; i += 1) meter.record({ purpose: 'chat', model: PRICED, usage: USAGE });
  const s = taskCostSummary({ file, taskId: 'old', since: NOW, now: NOW });
  assert.equal(s.complete, false);
  assert.equal(s.attempts, null);
  assert.equal(s.attemptsSeen, 0);
  assert.equal(s.known, false);
  assert.ok(s.usd > 0, 'счёт задачи (byTask) не обрезается и показывается');
  assert.match(s.problems.join('; '), new RegExp(`журнал хранит только последние ${MAX_CALLS} вызовов`));
  assert.match(s.problems.join('; '), /сумма видимых записей журнала не совпадает со счётом задачи/);

  // Задача началась после самой старой уцелевшей записи: её записи на месте, данные полные.
  const later = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).calls[0].ts) + 1;
  meter.record({ purpose: 'plan', model: PRICED, usage: USAGE, taskId: 'new' });
  const fresh = taskCostSummary({ file, taskId: 'new', since: later, now: NOW });
  assert.deepEqual([fresh.complete, fresh.attempts, fresh.known], [true, 1, true]);
  // Без since при полном журнале — неполные (проверить нечем).
  assert.equal(taskCostSummary({ file, taskId: 'new', now: NOW }).complete, false);

  const report = renderReport(
    model.createTask({ id: 'old', title: 'Old', goal: 'g', now: NOW }),
    { cost: null, at: NOW, costSummary: s },
  );
  assert.match(report, /## Стоимость по журналу учёта\n\n- Стоимость \(USD, счёт задачи в журнале\): \$0\.\d+\n- Попыток вызова модели: неизвестно \(в журнале видно 0, часть записей могла быть вытеснена\)\n- Расход известен точно: нет\n- \*\*Данные неполные:\*\* журнал хранит только последние 200 вызовов/);
  assert.match(report, /- Время расчёта: \d\d\.\d\d\.2026 \d\d:\d\d/);
});

test('сводка стоимости: нет файла, битый файл, учёт заблокирован, резерв в полёте — «данные неполные», файл не трогается', (t) => {
  const dir = tmpDir(t, 'jarvis-criteria-cost-bad-');
  const missing = taskCostSummary({ file: path.join(dir, 'нет.json'), taskId: 't1', now: NOW });
  assert.deepEqual([missing.available, missing.usd, missing.attempts, missing.complete], [false, null, null, false]);
  assert.match(missing.problems[0], /файла учёта нет/);
  assert.equal(fs.existsSync(path.join(dir, 'нет.json')), false, 'файл не создан');

  const broken = path.join(dir, 'budget.json');
  fs.writeFileSync(broken, '{не json', 'utf8');
  const bad = taskCostSummary({ file: broken, taskId: 't1', now: NOW });
  assert.equal(bad.available, false);
  assert.match(bad.problems[0], /файл учёта повреждён/);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{не json', 'битый файл не тронут');
  assert.deepEqual(fs.readdirSync(dir), ['budget.json'], 'копия corrupt-* не создана: это делает только Meter');

  fs.writeFileSync(broken, JSON.stringify({ date: '2026-10-31', spentUsd: 0, unknownCalls: 0, byTask: {}, pending: [], calls: [], blocked: { reason: 'x' } }), 'utf8');
  assert.match(taskCostSummary({ file: broken, taskId: 't1', now: NOW }).problems[0], /учёт расходов заблокирован/);

  const { file, meter } = meterOn(t);
  meter.reserve(0.01, { purpose: 'step', model: PRICED, taskId: 't1' });
  const flying = taskCostSummary({ file, taskId: 't1', since: NOW - 1, now: NOW });
  assert.equal(flying.complete, false);
  assert.match(flying.problems.join('; '), /вызовов в полёте \(резервов\): 1/);

  const report = renderReport(model.createTask({ id: 't1', title: 'T', now: NOW }), { cost: null, at: NOW, costSummary: missing });
  assert.match(report, /## Стоимость по журналу учёта\n\n- \*\*Данные неполные:\*\* файла учёта нет: расход по задаче не записан\./);
  const none = renderReport(model.createTask({ id: 't1', title: 'T', now: NOW }), { cost: null, at: NOW });
  assert.match(none, /## Стоимость по журналу учёта\n\n- Сводки нет: журнал стоимости исполнителю не подключён\./);
});

test('сводка стоимости в отчёте исполнителя: costSummary получает id задачи; сбой сводки — «данные неполные», отчёт пишется', async (t) => {
  const seen = [];
  const { out } = await runLive03(t, {
    twoSentences: 'check',
    costSummary: (taskId, task) => {
      seen.push([taskId, task.id]);
      throw new Error('журнал недоступен');
    },
  });
  assert.deepEqual(seen, [['live03', 'live03']]);
  const report = fs.readFileSync(out.reportFile, 'utf8');
  assert.match(report, /- \*\*Данные неполные:\*\* сводка не получена: журнал недоступен\./);
});
