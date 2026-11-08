'use strict';

// Протоколы-образцы: «Работа», «Игра», «Отбой» и группа «Windows».
// Проверяем фразы, порядок шагов, белый список клавиш, отсутствие опасных шагов,
// решения политики в режиме «Спрашивать», сохранение и перенос без потерь.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CommandStore, exportCommandJson, previewCommandImport, applyCommandImport } = require('../src/commands/store');
const { SAMPLE_COMMANDS, WINDOWS_COMMANDS, seedSampleCommands } = require('../src/commands/samples');
const { desktopTools } = require('../src/tools/desktop');
const { systemTools } = require('../src/tools/system');
const { windowsTools } = require('../src/tools/windows');
const { uiTools, parseKeys } = require('../src/tools/ui');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { runCommand } = require('../src/commands/runner');
const { decide } = require('../src/policy/modes');

const DANGEROUS = new Set(['pc_shutdown', 'shell_run', 'app_close']);
const LEGACY_NAMES = ['Работа', 'Игра', 'Отбой'];

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-proto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tmpStore(t) {
  return new CommandStore(path.join(tmpDir(t), 'commands.json'));
}

const tools = new Map(
  [...systemTools, ...desktopTools, ...windowsTools(), ...uiTools()].map((tool) => [tool.name, tool])
);
const sample = (name) => SAMPLE_COMMANDS.find((c) => c.name === name);

test('фразы находят команды: «игровой режим» — «Игра», «режим работы» — «Работа», «спокойной ночи» — «Отбой»', (t) => {
  const store = tmpStore(t);
  seedSampleCommands(store);
  assert.equal(store.findByPhrase('игровой режим').name, 'Игра');
  assert.equal(store.findByPhrase('Режим работы.').name, 'Работа');
  assert.equal(store.findByPhrase('спокойной ночи').name, 'Отбой');
});

test('старые сценарии идут в заданном порядке', () => {
  assert.deepEqual(sample('Работа').steps.map((s) => s.tool), ['windows_minimize_all', 'url_open', 'volume_set', 'speak']);
  assert.deepEqual(sample('Работа').steps[2].args, { percent: 30 });
  assert.deepEqual(sample('Игра').steps.map((s) => s.tool), ['windows_minimize_all', 'wait', 'volume_set']);
  assert.deepEqual(sample('Игра').steps[2].args, { percent: 70 });
  assert.deepEqual(sample('Отбой').steps.map((s) => s.tool), ['speak', 'volume_set', 'monitor_off']);
  assert.deepEqual(sample('Отбой').steps[1].args, { percent: 0 });
});

test('группа «Windows»: 7 команд с фразами и папкой Windows (окна влево/вправо убраны)', () => {
  assert.equal(WINDOWS_COMMANDS.length, 7);
  for (const cmd of WINDOWS_COMMANDS) {
    assert.equal(cmd.folder, 'Windows', `${cmd.name}: нет папки Windows`);
    assert.ok(cmd.phrases.length >= 1, `${cmd.name}: нет фраз`);
    assert.ok(cmd.steps.length >= 1, `${cmd.name}: нет шагов`);
    assert.ok(sample(cmd.name), `${cmd.name}: нет в SAMPLE_COMMANDS`);
  }
});

test('«Windows»: порядок шагов и аргументы сочетаний', () => {
  const keys = {
    'Новый рабочий стол': 'win+ctrl+d',
    'Панель эмодзи': 'win+.',
    'Буфер обмена': 'win+v',
    'Экранная лупа': 'win+plus',
    'Блокировка экрана': 'win+l',
  };
  for (const [name, key] of Object.entries(keys)) {
    const cmd = sample(name);
    assert.ok(cmd, `нет команды ${name}`);
    assert.deepEqual(cmd.steps.map((s) => s.tool), ['ui_keys'], name);
    assert.deepEqual(cmd.steps[0].args, { keys: key }, name);
  }
  // Окна влево/вправо/развернуть/свернуть образцами не даём: windows_snap нужно название окна (решение владельца).
  for (const name of ['Окно влево', 'Окно вправо', 'Развернуть окно', 'Свернуть окно вниз']) {
    assert.equal(sample(name), undefined, name);
  }
  // Свернуть все окна — отдельный инструмент, а не клавиши: повтор не разворачивает окна обратно.
  assert.deepEqual(sample('Свернуть все окна').steps.map((s) => s.tool), ['windows_minimize_all']);
  // Проводник и Диспетчер задач открываются по имени, пауза между ними — чтобы окно успело появиться.
  assert.deepEqual(sample('Проводник и диспетчер задач').steps.map((s) => s.tool), ['app_open', 'wait', 'app_open']);
  assert.deepEqual(sample('Проводник и диспетчер задач').steps[0].args, { name: 'explorer' });
  assert.deepEqual(sample('Проводник и диспетчер задач').steps[2].args, { name: 'taskmgr' });
});

test('каждая Win-команда находится по своей фразе и попадает в папку Windows', (t) => {
  const store = tmpStore(t);
  seedSampleCommands(store);
  for (const phrase of ['буфер обмена', 'блокировка экрана', 'свернуть все окна']) {
    const cmd = store.findByPhrase(phrase);
    assert.ok(cmd, `не нашлась команда по фразе «${phrase}»`);
    assert.equal(cmd.folder, 'Windows');
  }
});

test('все шаги с ui_keys проходят белый список клавиш и не выбирают окно', () => {
  for (const cmd of SAMPLE_COMMANDS) {
    for (const step of cmd.steps) {
      if (step.tool !== 'ui_keys') continue;
      const parsed = parseKeys(step.args && step.args.keys);
      assert.equal(parsed.ok, true, `${cmd.name}: ${parsed.error}`);
      // Win-сочетания SendKeys не умеет: они должны идти кодами виртуальных клавиш.
      assert.equal(step.args.window, undefined, `${cmd.name}: окно выбирать нечем, действуем на переднее`);
    }
  }
});

test('опасные инструменты не входят в образцы', () => {
  for (const cmd of SAMPLE_COMMANDS) {
    for (const step of cmd.steps) assert.equal(DANGEROUS.has(step.tool), false, `${cmd.name}: ${step.tool}`);
  }
});

test('все образцы сохраняются без ошибок и повторный запуск ничего не дублирует', (t) => {
  const store = tmpStore(t);
  assert.deepEqual(seedSampleCommands(store), SAMPLE_COMMANDS.map((c) => c.name));
  assert.deepEqual(seedSampleCommands(store), [], 'повторный запуск ничего не добавляет');
  assert.equal(store.list().length, SAMPLE_COMMANDS.length);
  for (const name of LEGACY_NAMES) assert.ok(store.findByPhrase(sample(name).phrases[0]), `нет ${name}`);
});

test('каждый шаг известен и проходит политику в режиме «Спрашивать» без отказа', () => {
  for (const cmd of SAMPLE_COMMANDS) {
    for (const step of cmd.steps) {
      const tool = tools.get(step.tool);
      assert.ok(tool, `${cmd.name}: нет инструмента ${step.tool}`);
      const verdict = decide({
        mode: 'ask',
        name: tool.name,
        risk: tool.risk,
        args: step.args,
        workspace: os.tmpdir(),
        sessionAllow: new Set(),
        hasPathParam: false,
      });
      assert.notEqual(verdict, 'deny', `${cmd.name}: ${step.tool} отклонён политикой`);
      if (tool.risk === 'T0') assert.equal(verdict, 'allow', `${cmd.name}: ${step.tool} должен идти без вопроса`);
    }
  }
});

test('фразы образцов уникальны', () => {
  const phrases = SAMPLE_COMMANDS.flatMap((c) => c.phrases);
  assert.equal(new Set(phrases).size, phrases.length);
  for (const cmd of SAMPLE_COMMANDS) assert.equal(new Set(cmd.phrases).size, cmd.phrases.length, cmd.name);
});

test('образцы: происхождение sample и версия схемы, перенос без потерь', (t) => {
  const store = tmpStore(t);
  seedSampleCommands(store);
  for (const saved of store.list()) {
    assert.equal(saved.origin, 'sample');
    assert.equal(saved.schemaVersion, 2);
  }
  assert.equal(store.list().find((c) => c.name === 'Свернуть все окна').folder, 'Windows');
  assert.equal(store.list().find((c) => c.name === 'Работа').folder, null);
  const text = exportCommandJson(store.list());
  const target = tmpStore(t);
  const preview = previewCommandImport(text, target);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.preview.counts.add, SAMPLE_COMMANDS.length);
  const applied = applyCommandImport(text, target, { confirm: true });
  assert.equal(applied.ok, true, applied.error);
  assert.deepEqual(
    target.list().map((c) => [c.name, c.steps.map((s) => s.tool), c.origin, c.folder]),
    store.list().map((c) => [c.name, c.steps.map((s) => s.tool), c.origin, c.folder])
  );
  assert.equal(target.findByPhrase('игровой режим').name, 'Игра');
  assert.equal(target.findByPhrase('буфер обмена').name, 'Буфер обмена');
});

// Исполнение образца целиком: инструменты подменены, порядок шагов проверяется по вызовам.
function fakeTools(dir, ran) {
  const registry = new ToolRegistry();
  const fake = (name, risk) => ({
    name,
    risk,
    description: name,
    parameters: { type: 'object', properties: {} },
    run: async (args) => {
      ran.push([name, args]);
      return { ok: true, summary: name, data: {} };
    },
  });
  registry.register(fake('app_open', 'T1'));
  registry.register(fake('wait', 'T0'));
  registry.register(fake('windows_minimize_all', 'T1'));
  registry.register(fake('ui_keys', 'T1'));
  return registry;
}

function runDeps(dir, registry) {
  return {
    tools: registry,
    policy: { decide },
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    mode: 'ask',
    workspace: dir,
    approvals: { request: async () => 'once', respond: () => {} },
  };
}

test('«Проводник и диспетчер задач» выполняется по порядку через политику', async (t) => {
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));
  seedSampleCommands(store);
  const cmd = store.findByPhrase('проводник и диспетчер задач');
  const ran = [];
  const out = await runCommand(cmd, runDeps(dir, fakeTools(dir, ran)));
  assert.equal(out.ok, true, JSON.stringify(out.results));
  assert.deepEqual(ran, [
    ['app_open', { name: 'explorer' }],
    ['wait', { ms: 1000 }],
    ['app_open', { name: 'taskmgr' }],
  ]);
});

test('«Блокировка экрана» отправляет только win+l через ui_keys', async (t) => {
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));
  seedSampleCommands(store);
  const cmd = store.findByPhrase('заблокируй экран');
  const ran = [];
  const out = await runCommand(cmd, runDeps(dir, fakeTools(dir, ran)));
  assert.equal(out.ok, true);
  assert.deepEqual(ran, [['ui_keys', { keys: 'win+l' }]]);
});

test('«Свернуть все окна» использует windows_minimize_all, а не клавиши', async (t) => {
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));
  seedSampleCommands(store);
  const cmd = store.findByPhrase('сверни все окна');
  const ran = [];
  const out = await runCommand(cmd, runDeps(dir, fakeTools(dir, ran)));
  assert.equal(out.ok, true);
  assert.deepEqual(ran, [['windows_minimize_all', {}]]);
});
