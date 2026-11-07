'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CommandStore, EDITOR_STEP_TOOLS, DANGEROUS_TOOLS, MAX_STEPS } = require('../src/commands/store');
const {
  moveStep, describeSteps, stepWarning, warningsForSteps, foldersOf, groupCommands,
  diffLines, previewCountsLine, canApplyImport,
} = require('../renderer/cmd-steps');

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cmd-editor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new CommandStore(path.join(dir, 'commands.json'));
}

const step = (tool, args = {}) => ({ tool, args });

test('команда с тремя шагами сохраняется и читается в том же порядке', (t) => {
  const store = makeStore(t);
  const saved = store.save({
    name: 'Рабочее утро',
    phrases: ['рабочее утро'],
    steps: [step('app_open', { name: 'notepad' }), step('wait', { seconds: 2 }), step('speak', { text: 'Готово' })],
  });
  assert.deepEqual(saved.steps.map((s) => s.tool), ['app_open', 'wait', 'speak']);
  assert.deepEqual(store.get(saved.id).steps.map((s) => s.tool), ['app_open', 'wait', 'speak']);
});

test('лимит: 20 шагов можно, 21 нельзя', (t) => {
  const store = makeStore(t);
  const twenty = Array.from({ length: 20 }, () => step('wait', { seconds: 1 }));
  assert.equal(MAX_STEPS, 20);
  assert.equal(store.save({ name: 'Длинная', phrases: ['длинная'], steps: twenty }).steps.length, 20);
  assert.throws(
    () => store.save({ name: 'Слишком', phrases: ['слишком'], steps: [...twenty, step('wait', { seconds: 1 })] }),
    /шагов от 1 до 20/,
  );
});

test('опасные инструменты отклоняются и не попадают в файл', (t) => {
  const store = makeStore(t);
  for (const tool of ['mail_send', 'pc_shutdown', 'shell_run', 'app_close', 'forget']) {
    assert.throws(
      () => store.save({ name: 'Опасная', phrases: ['опасная'], steps: [step('wait'), step(tool)] }),
      /нельзя сохранить в команде/,
      tool,
    );
  }
  assert.throws(
    () => store.save({ name: 'Фон', phrases: ['фон'], steps: [step('mission_add')] }),
    /нельзя сохранить в команде/,
  );
  assert.equal(store.list().length, 0);
});

test('в редакторе нет опасных инструментов', () => {
  assert.deepEqual(EDITOR_STEP_TOOLS.filter((name) => DANGEROUS_TOOLS.has(name)), []);
  assert.ok(EDITOR_STEP_TOOLS.includes('app_open'));
  assert.ok(EDITOR_STEP_TOOLS.includes('ui_keys'));
});

test('порядок шагов меняется вверх и вниз, границы не ломаются', () => {
  const steps = [step('app_open'), step('wait'), step('speak')];
  assert.deepEqual(moveStep(steps, 2, -1).map((s) => s.tool), ['app_open', 'speak', 'wait']);
  assert.deepEqual(moveStep(steps, 0, 1).map((s) => s.tool), ['wait', 'app_open', 'speak']);
  assert.deepEqual(moveStep(steps, 0, -1).map((s) => s.tool), ['app_open', 'wait', 'speak']);
  assert.deepEqual(moveStep(steps, 2, 1).map((s) => s.tool), ['app_open', 'wait', 'speak']);
  assert.deepEqual(steps.map((s) => s.tool), ['app_open', 'wait', 'speak'], 'исходный массив не меняется');
});

test('после перестановки сохранённый порядок новый', (t) => {
  const store = makeStore(t);
  const saved = store.save({
    name: 'Порядок',
    phrases: ['порядок'],
    steps: [step('app_open', { name: 'calc' }), step('wait', { seconds: 1 }), step('speak', { text: 'Да' })],
  });
  const moved = moveStep(saved.steps, 0, 1);
  const again = store.save({ ...saved, steps: moved });
  assert.deepEqual(store.get(again.id).steps.map((s) => s.tool), ['wait', 'app_open', 'speak']);
});

test('текст для «Проверить» идёт по порядку и не запускает шаги', () => {
  const lines = describeSteps(
    [step('app_open', { name: 'notepad' }), step('speak', { text: 'Готово' })],
    (tool) => ({ app_open: 'Запуск программы', speak: 'Сказать вслух' })[tool],
    (args) => Object.values(args).join(', '),
  );
  assert.deepEqual(lines, ['1. Запуск программы: notepad', '2. Сказать вслух: Готово']);
});

// ── Запись, дерево и импорт: чистые помощники окна ──────────────

test('все действия редактора действительно есть в реестре инструментов', () => {
  const { systemTools } = require('../src/tools/system');
  const { desktopTools } = require('../src/tools/desktop');
  const { uiTools } = require('../src/tools/ui');
  const names = new Set([...systemTools, ...desktopTools].map((tool) => tool.name));
  for (const tool of uiTools({ selfPid: process.pid, runner: () => {} })) names.add(tool.name);
  assert.deepEqual(EDITOR_STEP_TOOLS.filter((name) => !names.has(name)), [], 'каталог не обещает несуществующих действий');
});

test('предупреждения о шагах: координаты, ввод и клавиши, без ложных срабатываний', () => {
  assert.match(stepWarning(step('desktop_click', { x: 10, y: 20 })), /координат/);
  assert.match(stepWarning(step('ui_click', { x: 1, y: 2 })), /координат/);
  assert.match(stepWarning(step('ui_type', { window: 'Блокнот', text: 'привет' })), /текст/);
  assert.match(stepWarning(step('ui_keys', { keys: 'CTRL+S' })), /активного окна/);
  assert.equal(stepWarning(step('wait', { ms: 10 })), null);
  assert.equal(stepWarning(step('app_open', { name: 'notepad' })), null);
  assert.deepEqual(warningsForSteps([step('wait'), step('ui_type', { window: 'Блокнот', text: 'x' })]), [
    '2. ввод текста при записи скрывается: добавьте текст вручную',
  ]);
  assert.deepEqual(warningsForSteps([]), []);
});

test('дерево команд: папки по алфавиту, «Без папки» в конце', () => {
  const list = [
    { name: 'Б', folder: 'Утро' },
    { name: 'А', folder: 'Утро' },
    { name: 'В', folder: null },
    { name: 'Г', folder: 'Игры' },
    { name: 'Д', folder: ' ' },
  ];
  assert.deepEqual(foldersOf(list), ['Игры', 'Утро']);
  const groups = groupCommands(list);
  assert.deepEqual(groups.map((g) => g.title), ['Игры', 'Утро', 'Без папки']);
  assert.deepEqual(groups[1].commands.map((c) => c.name), ['Б', 'А'], 'порядок внутри не меняем');
  assert.deepEqual(groups[2].commands.map((c) => c.name), ['В', 'Д']);
  assert.deepEqual(foldersOf([]), []);
});

test('строки предпросмотра импорта и сводка понятны владельцу', () => {
  const preview = {
    applicable: false,
    counts: { add: 1, update: 1, unchanged: 1, conflict: 1 },
    items: [
      { name: 'Новая', action: 'add' },
      { name: 'Старая', action: 'update', changes: [{ field: 'steps', label: 'шаги' }, { field: 'phrases', label: 'фразы' }] },
      { name: 'Та же', action: 'unchanged' },
      { name: 'Чужая', action: 'conflict', conflicts: ['фраза «кино» уже у команды «Кино»'] },
    ],
  };
  assert.deepEqual(diffLines(preview), [
    'Добавится: «Новая»',
    'Изменится: «Старая» — шаги, фразы',
    'Без изменений: «Та же»',
    'Конфликт: «Чужая» — фраза «кино» уже у команды «Кино»',
  ]);
  assert.equal(previewCountsLine(preview), 'Добавится: 1 · Изменится: 1 · Без изменений: 1 · Конфликтов: 1');
  assert.equal(previewCountsLine({ counts: {} }), 'Добавится: 0 · Изменится: 0 · Без изменений: 0');
  assert.equal(canApplyImport(preview), false);
  assert.equal(canApplyImport({ applicable: true }), true);
  assert.equal(canApplyImport(null), false);
  assert.deepEqual(diffLines(null), []);
});
