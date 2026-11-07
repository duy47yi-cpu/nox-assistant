'use strict';

// Инструменты кода через поручение целиком: task_submit (чат-инструмент, как его вызывает модель) → подтверждение
// мандата владельцем «один раз» → исполнитель → план с критериями (task_plan_submit) → code_write → code_edit →
// code_read → проверка критериев кодом → итог и отчёт. Сборка — настоящая (src/tasks/runtime.js: страж бюджета,
// учёт, очередь, стоп, брокер подтверждений), инструменты кода — настоящие (src/tools/code.js) с roots, как в main.js:
// папки мандата задачи. Модель подставная, реальная не вызывается. Песочница — копия во временной папке теста
// (os.tmpdir()), в ней отдельная папка jarvis-acceptance/code-test; workspace владельца не трогается.
// Код не запускается: инструмента запуска нет ни в реестре, ни среди предложенных модели.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntime } = require('../src/tasks/runtime');
const mandates = require('../src/tasks/mandate');
const { codeTools, CODE_TOOL_NAMES } = require('../src/tools/code');
const { StopSwitch } = require('../src/control/stop');
const { ApprovalBroker } = require('../src/policy/approvals');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const NOW = Date.UTC(2026, 9, 31, 9, 0);
const USAGE = Object.freeze({ promptTokens: 800, cachedTokens: 200, completionTokens: 100, reasoningTokens: 0 });
const CODE_DIR = 'jarvis-acceptance/code-test';
const FILE = `${CODE_DIR}/calculator.py`;
const DRAFT = 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a + b  # ошибка\n';
const FINAL = 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n';
// Корень репозитория Джарвиса и папка приложения: их мандат не принимает ни в каком написании.
const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Поручение, как его передаёт модель в task_submit.
const SUBMIT = Object.freeze({
  goal: 'Создать в jarvis-acceptance/code-test файл calculator.py с функциями add и sub, затем исправить sub, чтобы она вычитала',
  title: 'Калькулятор на Python',
  tools: ['code_read', 'code_write', 'code_edit'],
  folders: [CODE_DIR],
  expiresInHours: 2,
  budgetUsd: 0.05,
});

const PLAN = {
  steps: [
    { title: 'Создать calculator.py', check: { kind: 'file_exists', path: FILE } },
    { title: 'Исправить sub: вычитание', check: { kind: 'file_contains', path: FILE, text: 'return a - b' } },
    { title: 'Прочитать результат', kind: 'observation' },
  ],
  criteria: [
    { requirement: 'файл calculator.py в code-test', text: 'файл создан', check: { kind: 'file_exists', path: FILE } },
    { requirement: 'add складывает', text: 'в файле return a + b', check: { kind: 'file_contains', path: FILE, text: 'return a + b' } },
    { requirement: 'sub вычитает (исправление)', text: 'в файле return a - b', check: { kind: 'file_contains', path: FILE, text: 'return a - b' } },
  ],
};

const reply = (...calls) => ({ toolCalls: calls.map(([name, args]) => ({ name, args })) });
const HAPPY = [
  reply(['task_plan_submit', PLAN]),
  // Пути — от корня песочницы, как в поручении и проверках шагов (а не от папки мандата).
  reply(['code_write', { path: FILE, content: DRAFT }]),
  reply(['step_done', { summary: 'calculator.py создан' }]),
  reply(['code_edit', { path: FILE, old_string: 'return a + b  # ошибка', new_string: 'return a - b' }]),
  reply(['step_done', { summary: 'sub исправлена' }]),
  reply(['code_read', { path: FILE }]),
  reply(['step_done', { summary: 'файл прочитан' }]),
];

function tmpBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-code-int-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

// Подставная модель: ответы по сценарию; после каждого — onUsage, как у DeepSeekClient (страж учитывает расход).
function scriptedBrain(script) {
  const brain = {
    model: MODEL,
    requests: [],
    async chat(args) {
      const i = brain.requests.length;
      brain.requests.push({ purpose: args.purpose, tools: (args.tools || []).map((x) => x.function.name), messages: (args.messages || []).slice() });
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

// Все файлы под dir (относительные пути через «/»).
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

// Сборка как в main.js на временных файлах: реестр задач = инструменты песочницы + код с roots по мандату задачи.
// answer(ev) — ответ владельца на запрос подтверждения; по умолчанию «один раз» на всё.
function build(t, { script = [], answer = () => 'once' } = {}) {
  const base = tmpBase(t);
  const root = path.join(base, 'workspace');
  for (const dir of ['reports', CODE_DIR, 'jarvis-acceptance/other']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'jarvis-acceptance', 'other', 'keep.md'), 'не трогать', 'utf8');
  const index = new WorkspaceIndex(root);
  const resolve = (rel) => index.resolveInside(rel);
  const h = { base, root, events: [], journal: [], brain: scriptedBrain(script) };
  // Та же функция roots, что в main.js: только task.mandate.folders; база путей — корень песочницы, как в main.js.
  const code = codeTools({
    base: root,
    roots: (ctx) => {
      const task = ctx && ctx.taskId ? h.runtime.queue.get(ctx.taskId) : null;
      if (!task || !task.mandate) return [];
      return Array.isArray(task.mandate.folders) ? task.mandate.folders : [];
    },
    denyDirs: [path.join(base, 'data')],
  });
  const tools = [...workspaceTools(index), ...code];
  h.registry = { get: (name) => tools.find((x) => x.name === name) || null, list: () => tools.slice() };
  const broker = new ApprovalBroker();
  h.runtime = createRuntime({
    brain: h.brain,
    model: MODEL,
    tasksFile: path.join(base, 'data', 'tasks.json'),
    budgetFile: path.join(base, 'data', 'budget.json'),
    sandboxRoot: root,
    reportsDir: 'reports',
    dailyLimitUsd: 1,
    toolRegistry: h.registry,
    approvals: broker,
    stop: new StopSwitch(),
    journal: { append: (e) => h.journal.push(e) },
    emit: (ev) => {
      h.events.push(ev);
      if (ev.type === 'approval_request') {
        const decision = answer(ev);
        if (decision) broker.respond(ev.id, decision);
      }
    },
    resolve,
    now: () => NOW,
  });
  t.after(() => h.runtime.close());
  h.submit = (args) => h.runtime.chatTools.find((x) => x.name === 'task_submit').run(args, {});
  h.asks = () => h.events.filter((e) => e.type === 'approval_request');
  h.decisions = (tool) => h.journal.filter((e) => e.tool === tool).map((e) => e.decision);
  return h;
}

test('код через поручение: task_submit → «один раз» → план с критериями → code_write → code_edit → code_read → проверено', async (t) => {
  const h = build(t, { script: HAPPY });
  const before = walk(h.root);
  const res = await h.submit({ ...SUBMIT });
  assert.equal(res.ok, true, res.summary);
  await h.runtime.whenIdle();
  const id = res.data.id;
  const task = h.runtime.queue.get(id);

  // Подтверждение мандата: один запрос, «на сессию» не предлагается; в тексте — папка и инструменты кода по-русски.
  // На code_write и code_edit отдельного вопроса нет: разрешение — подтверждённый мандат.
  const asks = h.asks();
  assert.deepEqual(asks.map((a) => a.name), ['мандат задачи'], 'спрашивается только мандат');
  assert.ok(asks.every((a) => a.allowSession === false));
  const text = asks[0].args.мандат;
  const folder = path.join(h.root, ...CODE_DIR.split('/'));
  assert.ok(text.includes(`Папки: ${folder}`), text);
  assert.ok(text.includes(`Код (без запуска, только в папках мандата: ${folder}): чтение — code_read; `
    + 'изменение — code_write, code_edit, без отдельного подтверждения каждого вызова: разрешение — этот мандат'), text);
  assert.match(text, /Инструменты: чтение исходников \(code_read\), создание исходников \(code_write\), правка исходников \(code_edit\)/);
  assert.deepEqual(task.mandate.folders, [folder]);
  assert.equal(Object.hasOwn(task.mandate, 'codeFolders'), false);

  // Файл создан в папке мандата, правка применилась, содержимое совпадает.
  assert.equal(fs.readFileSync(path.join(folder, 'calculator.py'), 'utf8'), FINAL);
  // Вне папки мандата ничего не появилось (кроме отчёта задачи в reports).
  const added = walk(h.root).filter((f) => !before.includes(f));
  assert.deepEqual(added, [`${CODE_DIR}/calculator.py`, `reports/task-${id}.md`]);
  assert.equal(fs.readFileSync(path.join(h.root, 'jarvis-acceptance', 'other', 'keep.md'), 'utf8'), 'не трогать');
  assert.deepEqual(walk(h.base).filter((f) => !f.startsWith('workspace/') && !f.startsWith('data/')), [], 'рядом с песочницей ничего');

  // Итог: все критерии подтверждены кодом, шаги-действия подтверждены, третий шаг — наблюдение.
  assert.equal(task.status, 'done');
  assert.deepEqual([task.verdict.code, task.verdict.status], ['verified', 'done']);
  assert.deepEqual(task.criteria.map((c) => c.result.verification), ['confirmed', 'confirmed', 'confirmed']);
  assert.deepEqual(task.plan.map((s) => s.result.verification), ['confirmed', 'confirmed', 'not_applicable']);

  // Журнал: code_write, code_edit и code_read — без вопроса (разрешение — мандат).
  assert.deepEqual(h.decisions('code_write'), ['allow']);
  assert.deepEqual(h.decisions('code_edit'), ['allow']);
  assert.deepEqual(h.decisions('code_read'), ['allow']);
  const done = h.journal.filter((e) => /^code_/.test(e.tool) && e.ok === true).map((e) => e.summary);
  assert.deepEqual(done, [
    `создан ${FILE}: ${Buffer.byteLength(DRAFT)} байт, строк 6`,
    `изменён ${FILE}: 1 замена (строка 6), было ${Buffer.byteLength(DRAFT)} байт, стало ${Buffer.byteLength(FINAL)} байт`,
    `${FILE}: прочитано ${Buffer.byteLength(FINAL)} байт, строк 6`,
  ]);
  assert.ok(h.journal.some((e) => e.tool === 'мандат задачи' && e.decision === 'once'));

  // Событие плана: критерии с пометкой способа.
  const planEv = h.events.find((e) => e.type === 'task' && /^план: 3 шагов/.test(String(e.message)));
  assert.deepEqual(planEv.criteria.map((c) => c.method), ['объективная проверка', 'объективная проверка', 'объективная проверка']);

  // Отчёт: строка про код в мандате, критерии с происхождением, итог «проверено».
  const report = fs.readFileSync(path.join(h.root, 'reports', `task-${id}.md`), 'utf8');
  assert.match(report, /\*\*Итог: проверено\*\*/);
  assert.ok(report.includes(`- Код (без запуска, только в папках мандата: ${folder}): чтение — code_read;`), report);
  assert.match(report, /Происхождение: критерий сформулирован планировщиком, полнота не проверена/);

  // Код не запускается: ни в реестре, ни среди предложенных модели нет инструмента запуска.
  const runLike = /run|exec|shell|spawn|python|eval|process/i;
  assert.deepEqual(h.registry.list().map((x) => x.name).filter((n) => runLike.test(n)), []);
  const offered = new Set(h.brain.requests.filter((r) => r.purpose === 'step').flatMap((r) => r.tools));
  assert.deepEqual([...offered].sort(), ['code_edit', 'code_read', 'code_write', 'step_done', 'step_fail']);
  assert.equal(mandates.ALLOWED_TOOLS.some((n) => runLike.test(n)), false);
});

test('task_submit: папки вне песочницы (корень проекта, apps/jarvis-desktop, «..») — отказ с причиной, вопроса владельцу нет', async (t) => {
  const h = build(t);
  const cases = [
    [[REPO_ROOT], /укажите путь относительно песочницы; абсолютный путь не принимается, папки вне песочницы \(в том числе проект Джарвиса\) не разрешаются/],
    [[APP_DIR], /укажите путь относительно песочницы/],
    [[path.join(APP_DIR, 'src')], /укажите путь относительно песочницы/],
    [['..'], /папка «\.\.» вне песочницы/],
    [['../..'], /вне песочницы/],
    [['../apps/jarvis-desktop'], /вне песочницы/],
    [[`${CODE_DIR}/../../..`], /вне песочницы/],
    [[CODE_DIR, '../data'], /вне песочницы/],
  ];
  for (const [folders, reason] of cases) {
    const res = await h.submit({ ...SUBMIT, folders });
    assert.equal(res.ok, false, folders.join());
    assert.match(res.summary, reason, folders.join());
  }
  assert.equal(h.asks().length, 0, 'неверный мандат владельцу не показывается');
  assert.equal(h.runtime.queue.list().length, 0);
  assert.equal(h.brain.requests.length, 0);
});

test('task_submit: code_* без folders — ошибка поручения; пустой список — тоже', async (t) => {
  const h = build(t);
  const { folders, ...noFolders } = SUBMIT;
  for (const args of [noFolders, { ...noFolders, folders: null }, { ...noFolders, tools: ['code_read'] }]) {
    const res = await h.submit(args);
    assert.equal(res.ok, false);
    assert.match(res.summary, /для инструментов кода \(code_read, code_write, code_edit, code_test\) нужен явный непустой список папок folders внутри песочницы/);
  }
  const empty = await h.submit({ ...SUBMIT, folders: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.summary, /folders — непустой список/);
  assert.equal(h.asks().length, 0);
  assert.equal(h.runtime.queue.list().length, 0);
  // Параметра codeFolders у поручения нет.
  const extra = await h.submit({ ...SUBMIT, codeFolders: [APP_DIR] });
  assert.equal(extra.ok, false);
  assert.match(extra.summary, /неизвестный параметр «codeFolders»/);
});

test('task_submit: папка мандата — junction из песочницы в проект — отказ до вопроса владельцу', async (t) => {
  const h = build(t);
  const target = path.join(h.base, 'project-src');
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, path.join(h.root, 'jarvis-acceptance', 'link'), 'junction');
  } catch (err) {
    t.skip(`ОС не дала создать junction: ${err.code || err.message}`);
    return;
  }
  const res = await h.submit({ ...SUBMIT, folders: ['jarvis-acceptance/link'] });
  assert.equal(res.ok, false);
  assert.match(res.summary, /после раскрытия ссылок \(symlink, junction\) ведёт за пределы песочницы/);
  assert.equal(h.asks().length, 0);
});

test('нет code_* в tools мандата: модели код не предлагается, вызов отклонён мандатом, файл не создан', async (t) => {
  const plan = {
    steps: [{ title: 'Создать calculator.py', check: { kind: 'file_exists', path: FILE } }],
    criteria: [{ requirement: 'файл есть', text: 'файл создан', check: { kind: 'file_exists', path: FILE } }],
  };
  const script = [reply(['task_plan_submit', plan])];
  // Модель упорно зовёт code_write: каждый вызов — отказ мандата и неудача шага, на лимите неудач задача блокируется.
  for (let i = 0; i < 12; i += 1) script.push(reply(['code_write', { path: 'calculator.py', content: DRAFT }]));
  const h = build(t, { script });
  const res = await h.submit({ ...SUBMIT, tools: ['workspace_read', 'workspace_list'] });
  assert.equal(res.ok, true, res.summary);
  await h.runtime.whenIdle();
  const task = h.runtime.queue.get(res.data.id);
  assert.doesNotMatch(h.asks()[0].args.мандат, /Код \(без запуска/);
  assert.equal(fs.existsSync(path.join(h.root, FILE)), false);
  const denied = h.journal.filter((e) => e.tool === 'code_write');
  assert.ok(denied.length > 0);
  assert.ok(denied.every((e) => e.decision === 'deny' && /инструмента «code_write» нет в мандате/.test(e.summary)), JSON.stringify(denied));
  assert.equal(h.asks().filter((a) => a.name === 'code_write').length, 0, 'до подтверждения не дошло');
  assert.ok(h.brain.requests.filter((r) => r.purpose === 'step').every((r) => !r.tools.some((n) => CODE_TOOL_NAMES.includes(n))));
  assert.notEqual(task.status, 'done');
  // Вторая линия — сборка: runTool по такой задаче тоже отказывает (задача уже не выполняется — отказ ещё раньше).
  assert.equal(mandates.checkTool(task.mandate, { name: 'code_write', args: { path: 'calculator.py' }, now: NOW }).ok, false);
});

test('мандат неизменяем: новая папка — новое поручение с новым подтверждением; прежняя задача не меняется', async (t) => {
  const h = build(t, { script: HAPPY });
  const args = { ...SUBMIT, folders: [CODE_DIR] };
  const first = await h.submit(args);
  assert.equal(first.ok, true, first.summary);
  await h.runtime.whenIdle();
  const a = h.runtime.queue.get(first.data.id);
  const folderA = path.join(h.root, ...CODE_DIR.split('/'));
  // Правка аргументов поручения после подтверждения в задачу не попадает.
  args.folders.push('jarvis-acceptance/other');
  assert.deepEqual(h.runtime.queue.get(first.data.id).mandate.folders, [folderA]);

  // Новая папка — новое поручение: свой мандат, своё подтверждение владельца, своя задача.
  fs.mkdirSync(path.join(h.root, 'jarvis-acceptance', 'code-test2'));
  const second = await h.submit({ ...SUBMIT, folders: ['jarvis-acceptance/code-test2'] });
  assert.equal(second.ok, true, second.summary);
  const mandateAsks = h.asks().filter((x) => x.name === 'мандат задачи');
  assert.equal(mandateAsks.length, 2);
  assert.notEqual(mandateAsks[0].id, mandateAsks[1].id);
  const folderB = path.join(h.root, 'jarvis-acceptance', 'code-test2');
  assert.ok(mandateAsks[1].args.мандат.includes(`Папки: ${folderB}`));
  await h.runtime.whenIdle();
  const b = h.runtime.queue.get(second.data.id);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.mandate.id, b.mandate.id);
  assert.deepEqual(h.runtime.queue.get(a.id).mandate.folders, [folderA], 'новое поручение не меняет прежний мандат');
  assert.deepEqual(b.mandate.folders, [folderB]);
  // Прежний мандат по-прежнему не пускает в новую папку.
  const v = mandates.checkTool(h.runtime.queue.get(a.id).mandate, { name: 'code_write', args: { path: path.join(folderB, 'x.py') }, now: NOW });
  assert.equal(v.ok, false);
  assert.match(v.reason, /вне разрешённых папок/);
  // Возобновление папки не принимает: только id.
  const resume = h.runtime.chatTools.find((x) => x.name === 'task_resume');
  assert.deepEqual(Object.keys(resume.parameters.properties), ['id']);
});
