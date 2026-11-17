'use strict';

// P0-1 (A-1): устойчивость id элемента. Доказательства, что id больше не зависит от заголовка
// окна, различает экземпляры по handle, имеет длину 12 hex и сохраняет automationId как селектор.
// Юнит, без живого окна — по образцу tests/perception.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildScene, elementKey, elementId } = require('../src/perception/scene');
const { observeTools, findWindow, findWindows } = require('../src/tools/observe');

function element(name, type, extra = {}) {
  return { name, type, enabled: true, value: '', ...extra };
}

const notepad = (title, handle) => ({ title, handle, process: 'notepad' });

describe('A-1: id не зависит от заголовка окна', () => {
  test('смена заголовка («*», счётчик, вкладка) не меняет id', () => {
    const els = [element('Сохранить', 'Button', { bounds: { x: 10, y: 20, w: 30, h: 40 } })];
    const a = buildScene({ window: notepad('Безымянный — Блокнот', '11'), elements: els });
    const b = buildScene({ window: notepad('*Безымянный — Блокнот', '11'), elements: els });
    assert.deepEqual(a.elements.map((e) => e.id), b.elements.map((e) => e.id));
  });

  test('elementKey не содержит заголовка: ключи равны при разном title', () => {
    const el = element('ОК', 'Button');
    const k1 = elementKey(notepad('Первое', '7'), el);
    const k2 = elementKey(notepad('Второе', '7'), el);
    assert.equal(k1, k2);
    assert.equal(elementId(k1), elementId(k2));
  });
});

describe('A-1: id различает окна с одинаковым заголовком', () => {
  test('разные handle → разные id при том же title и элементах', () => {
    const els = [element('Сохранить', 'Button')];
    const a = buildScene({ window: notepad('Блокнот', '11'), elements: els });
    const b = buildScene({ window: notepad('Блокнот', '12'), elements: els });
    assert.notEqual(a.elements[0].id, b.elements[0].id);
  });

  test('разные процессы → разные id', () => {
    const els = [element('ОК', 'Button')];
    const a = buildScene({ window: { title: 'Окно', handle: '1', process: 'notepad' }, elements: els });
    const b = buildScene({ window: { title: 'Окно', handle: '1', process: 'explorer' }, elements: els });
    assert.notEqual(a.elements[0].id, b.elements[0].id);
  });
});

describe('A-1: длина id и дубли', () => {
  test('id — 12 hex у всех элементов', () => {
    const scene = buildScene({
      window: notepad('Окно', '1'),
      elements: [element('ОК', 'Button'), element('Поиск', 'Edit', { value: 'x' }), element('Ссылка', 'Hyperlink')],
    });
    assert.equal(scene.elements.length, 3);
    for (const e of scene.elements) assert.match(e.id, /^e[0-9a-f]{12}$/);
  });

  test('одинаковые элементы получают разные id через номер вхождения', () => {
    const box = { x: 1, y: 2, w: 3, h: 4 };
    const scene = buildScene({
      window: notepad('Окно', '1'),
      elements: [element('ОК', 'Button', { bounds: box }), element('ОК', 'Button', { bounds: box })],
    });
    assert.equal(scene.elements.length, 2);
    assert.notEqual(scene.elements[0].id, scene.elements[1].id);
    assert.equal(scene.elements[0].occurrence, 1);
    assert.equal(scene.elements[1].occurrence, 2);
  });
});

describe('A-1: automationId сохраняется как селектор', () => {
  test('элемент сцены несёт automationId из ui_elements', () => {
    const scene = buildScene({
      window: notepad('Окно', '1'),
      elements: [element('Кнопка', 'Button', { automationId: '1001' })],
    });
    assert.equal(scene.elements[0].automationId, '1001');
  });

  test('automationId важнее имени и координат: id переживает смену подписи и сдвиг', () => {
    const a = buildScene({ window: notepad('Окно', '1'), elements: [element('Было', 'Button', { automationId: 'save', bounds: { x: 0, y: 0, w: 10, h: 10 } })] });
    const b = buildScene({ window: notepad('Окно', '1'), elements: [element('Стало', 'Button', { automationId: 'save', bounds: { x: 50, y: 60, w: 10, h: 10 } })] });
    assert.equal(a.elements[0].id, b.elements[0].id);
  });
});

// --- A-2/A-3: селектор действия и идентичность окна (живые инструменты не нужны, ответы подставные) ---

function el(name, type, extra = {}) {
  return { name, type, enabled: true, value: '', ...extra };
}

function fakeUi(sequence, extra = [], windows) {
  const calls = { elements: 0, filters: [] };
  const win = windows || [
    { title: 'Блокнот — привет.txt', process: 'notepad', handle: 1 },
    { title: 'Проводник', process: 'explorer', handle: 2 },
  ];
  const windowsTool = {
    name: 'ui_windows',
    async run() {
      return { ok: true, summary: 'окна', data: { windows: typeof win === 'function' ? win() : win } };
    },
  };
  const elementsTool = {
    name: 'ui_elements',
    async run(args) {
      const items = sequence[Math.min(calls.elements, sequence.length - 1)];
      calls.filters.push(args.filter);
      calls.elements += 1;
      return { ok: true, summary: 'элементы', data: { window: args.window, total: items.length, elements: items } };
    },
  };
  return { ui: [windowsTool, elementsTool, ...extra], calls };
}

function fakeAction(name) {
  const calls = [];
  return {
    calls,
    tool: { name, async run(args) { calls.push(args); return { ok: true, summary: `${name}: ок`, data: {} }; } },
  };
}

describe('A-2: AutomationId — селектор, неоднозначное имя — отказ', () => {
  test('desktop_click передаёт AutomationId, occurrence 0', async () => {
    const frames = [[el('Кнопка', 'Button', { automationId: '1001' })], [el('Кнопка', 'Button', { automationId: '1001' })]];
    const click = fakeAction('ui_click');
    const { ui } = fakeUi(frames, [click.tool]);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const result = await tools.find((t) => t.name === 'desktop_click').run({ id: seen.data.scene.elements[0].id });
    assert.equal(result.ok, true, result.summary);
    assert.equal(click.calls.length, 1);
    assert.equal(click.calls[0].name, '1001');
    assert.equal(click.calls[0].occurrence, 0);
  });

  test('одинаковые подписи без AutomationId — отказ, ui_click не вызывался', async () => {
    const frames = [[el('ОК', 'Button'), el('ОК', 'Button')], [el('ОК', 'Button'), el('ОК', 'Button')]];
    const click = fakeAction('ui_click');
    const { ui } = fakeUi(frames, [click.tool]);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const result = await tools.find((t) => t.name === 'desktop_click').run({ id: seen.data.scene.elements[0].id });
    assert.equal(result.ok, false);
    assert.match(result.summary, /не одна/);
    assert.equal(click.calls.length, 0);
  });

  test('filter наблюдения сохраняется при перечитывании перед нажатием', async () => {
    const frames = [[el('Сохранить', 'Button')], [el('Сохранить', 'Button')], [el('Сохранить', 'Button')]];
    const click = fakeAction('ui_click');
    const { ui, calls } = fakeUi(frames, [click.tool]);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок', filter: 'Button' });
    await tools.find((t) => t.name === 'desktop_click').run({ id: seen.data.scene.elements[0].id });
    assert.equal(calls.filters[0], 'Button');
    assert.equal(calls.filters[1], 'Button', 'перечитывание перед нажатием — тем же filter');
  });
});

describe('A-3: окно по handle, одинаковые заголовки — отказ', () => {
  test('findWindows отдаёт оба точных совпадения, findWindow — null', () => {
    const list = [{ title: 'Блокнот' }, { title: 'Блокнот' }];
    assert.equal(findWindows(list, 'Блокнот').length, 2);
    assert.equal(findWindow(list, 'Блокнот'), null);
  });

  test('два окна с одинаковым заголовком — отказ, элементы не читаются', async () => {
    const dup = [{ title: 'Блокнот', process: 'notepad', handle: 1 }, { title: 'Блокнот', process: 'notepad', handle: 2 }];
    const { ui, calls } = fakeUi([[el('ОК', 'Button')]], [], dup);
    const [observe] = observeTools(ui);
    const result = await observe.run({ window: 'Блокнот' });
    assert.equal(result.ok, false);
    assert.match(result.summary, /подходят 2 окна/);
    assert.equal(calls.elements, 0);
  });

  test('handle сменился между наблюдением и нажатием — отказ, ui_click не вызывался', async () => {
    let n = 0;
    const win = () => { n += 1; return [{ title: 'Блокнот', process: 'notepad', handle: n === 1 ? '11' : '12', active: true }]; };
    const frames = [[el('Сохранить', 'Button')], [el('Сохранить', 'Button')]];
    const click = fakeAction('ui_click');
    const { ui } = fakeUi(frames, [click.tool], win);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блокнот' });
    const result = await tools.find((t) => t.name === 'desktop_click').run({ id: seen.data.scene.elements[0].id });
    assert.equal(result.ok, false);
    assert.match(result.summary, /handle/);
    assert.equal(click.calls.length, 0);
  });
});