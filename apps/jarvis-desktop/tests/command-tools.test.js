'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CommandStore, EDITOR_STEP_TOOLS } = require('../src/commands/store');
const { commandModelTools } = require('../src/tools/commands');
const { decide } = require('../src/policy/modes');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cmdtools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CommandStore(path.join(dir, 'commands.json'));
  const known = new Set(['volume_set', 'wait', 'url_open', 'app_open']);
  const [create, list] = commandModelTools(store, () => known);
  return { store, create, list };
}

test('command_create: создаёт сценарий с известными шагами', async (t) => {
  const { store, create } = setup(t);
  const res = await create.run({
    name: 'Кино',
    phrases: ['кино', 'включи кино'],
    steps: [{ tool: 'volume_set', args: { percent: 20 } }, { tool: 'url_open', args: { url: 'https://youtube.com' } }],
  });
  assert.equal(res.ok, true);
  assert.equal(store.findByPhrase('включи кино').name, 'Кино');
});

test('command_create: отказывает для неизвестного инструмента и для команд внутри команд', async (t) => {
  const { store, create } = setup(t);
  const unknown = await create.run({ name: 'X', phrases: ['x1'], steps: [{ tool: 'no_such_tool', args: {} }] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.summary, /нет инструмента/);
  const nested = await create.run({ name: 'Y', phrases: ['y1'], steps: [{ tool: 'command_create', args: {} }] });
  assert.equal(nested.ok, false);
  assert.equal(store.list().length, 0);
});

test('command_create: занятая фраза не перезаписывает другой сценарий', async (t) => {
  const { create, store } = setup(t);
  await create.run({ name: 'A', phrases: ['кино'], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  const second = await create.run({ name: 'B', phrases: ['кино'], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  assert.equal(second.ok, false);
  assert.equal(store.list().length, 1);
});

test('command_list: показывает сценарии или говорит, что их нет', async (t) => {
  const { create, list } = setup(t);
  assert.match((await list.run({})).summary, /пока нет/);
  await create.run({ name: 'Кино', phrases: ['кино'], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  assert.match((await list.run({})).summary, /Кино \(кино\)/);
});

test('политика: создание сценария — T1 (в «Спрашивать» спрашивает), в полном доступе — без вопросов', () => {
  const [create] = commandModelTools(new CommandStore(path.join(os.tmpdir(), `nope-${Date.now()}.json`)), () => new Set());
  assert.equal(create.risk, 'T1');
  assert.equal(decide({ mode: 'auto', name: 'command_create', risk: 'T1', args: {} }), 'ask');
  assert.equal(decide({ mode: 'full', name: 'command_create', risk: 'T1', args: {} }), 'allow');
});

// ── Создание из текста через план, каталог действий и проверка параметров ──────

const DEFS = [
  { name: 'volume_set', risk: 'T1', description: 'Громкость', parameters: { type: 'object', properties: { percent: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['percent'] } },
  { name: 'wait', risk: 'T0', description: 'Подождать', parameters: { type: 'object', properties: { ms: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['ms'] } },
  { name: 'url_open', risk: 'T1', description: 'Открыть адрес', parameters: { type: 'object', properties: { url: { type: 'string', maxLength: 2048 } }, required: ['url'] } },
  { name: 'app_open', risk: 'T1', description: 'Открыть программу', parameters: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 260 } }, required: ['name'] } },
  { name: 'ui_keys', risk: 'T1', description: 'Клавиши', parameters: { type: 'object', properties: { keys: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['keys'] } },
  { name: 'mail_send', risk: 'T2', description: 'Отправка', parameters: { type: 'object', properties: {} } },
];

function setupWithDefs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cmdplan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CommandStore(path.join(dir, 'commands.json'));
  const known = new Set(DEFS.map((def) => def.name));
  const tools = commandModelTools(store, () => known, { toolDefs: () => DEFS });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { store, dir, list: byName.get('command_list'), create: byName.get('command_create') };
}

test('создание из текста: dryRun возвращает редактируемый план и ничего не сохраняет и не запускает', async (t) => {
  const { store, create } = setupWithDefs(t);
  const res = await create.run({
    dryRun: true,
    name: 'Кино',
    phrases: ['кино', 'включи кино'],
    steps: [{ tool: 'volume_set', args: { percent: 20 } }, { tool: 'url_open', args: { url: 'https://youtube.com' } }],
  });
  assert.equal(res.ok, true, res.summary);
  assert.equal(res.data.saved, false);
  assert.equal(res.data.plan.name, 'Кино');
  assert.deepEqual(res.data.plan.steps.map((s) => s.tool), ['volume_set', 'url_open']);
  assert.match(res.summary, /не сохранён и не запущен/);
  assert.equal(store.list().length, 0, 'план не сохраняется');
  assert.equal(store.findByPhrase('кино'), null);
});

test('создание из текста: неверные шаги отклоняются в dryRun и при сохранении', async (t) => {
  const { store, create } = setupWithDefs(t);
  const unknown = await create.run({ dryRun: true, name: 'X', phrases: ['x'], steps: [{ tool: 'no_such_tool', args: {} }] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.summary, /нет инструмента/);
  const wrongType = await create.run({ dryRun: true, name: 'Y', phrases: ['y'], steps: [{ tool: 'volume_set', args: { percent: 'громко' } }] });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.summary, /нужно целое число/);
  const missing = await create.run({ dryRun: true, name: 'Z', phrases: ['z'], steps: [{ tool: 'volume_set', args: {} }] });
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /обязательное поле/);
  const outOfRange = await create.run({ dryRun: true, name: 'W', phrases: ['w'], steps: [{ tool: 'volume_set', args: { percent: 150 } }] });
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.summary, /не больше 100/);
  const dangerous = await create.run({ dryRun: true, name: 'Почта', phrases: ['почта'], steps: [{ tool: 'mail_send', args: {} }] });
  assert.equal(dangerous.ok, false);
  assert.match(dangerous.summary, /нельзя запускать/);
  assert.equal(store.list().length, 0);
});

test('создание из текста: пустое имя и без шагов отклоняются, без фраз — можно', async (t) => {
  const { create } = setupWithDefs(t);
  const noName = await create.run({ dryRun: true, name: '  ', phrases: ['x'], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  assert.equal(noName.ok, false);
  assert.match(noName.summary, /имя/);
  const noSteps = await create.run({ dryRun: true, name: 'Утро', phrases: ['утро'], steps: [] });
  assert.equal(noSteps.ok, false);
  assert.match(noSteps.summary, /шаг/);
  const noPhrases = await create.run({ dryRun: true, name: 'Утро', phrases: [], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  assert.equal(noPhrases.ok, true, noPhrases.summary);
  assert.equal(noPhrases.data.plan.phrases.length, 0);
});

test('каталог действий в command_list: только настоящие действия, опасные исключены', async (t) => {
  const { list } = setupWithDefs(t);
  const res = await list.run({ withParameters: true });
  assert.equal(res.ok, true);
  const names = res.data.actions.map((action) => action.name);
  assert.deepEqual(names.sort(), ['app_open', 'ui_keys', 'url_open', 'volume_set', 'wait']);
  assert.equal(names.includes('mail_send'), false);
  assert.ok(res.data.actions.every((action) => action.parameters && typeof action.parameters === 'object'));
  assert.deepEqual(res.data.actions.filter((action) => action.editable).map((action) => action.name).sort(), EDITOR_STEP_TOOLS.filter((n) => names.includes(n)).sort());
  assert.match(res.summary, /Действий для сценариев: 5/);
  // Обычный список по-прежнему про сохранённые сценарии.
  const plain = await list.run({});
  assert.match(plain.summary, /пока нет/);
});

test('command_create: проверяет параметры и помечает происхождение «ai»', async (t) => {
  const { store, create } = setupWithDefs(t);
  const bad = await create.run({ name: 'X', phrases: ['x'], steps: [{ tool: 'volume_set', args: { percent: 500 } }] });
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /не больше 100/);
  assert.equal(store.list().length, 0);
  const ok = await create.run({ name: 'Кино', phrases: ['кино'], steps: [{ tool: 'volume_set', args: { percent: 20 } }], folder: 'Медиа' });
  assert.equal(ok.ok, true, ok.summary);
  const saved = store.findByPhrase('кино');
  assert.equal(saved.origin, 'ai');
  assert.equal(saved.folder, 'Медиа');
});
