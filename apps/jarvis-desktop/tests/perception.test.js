'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  buildScene, diffScene, sceneText, elementId, elementKey, redact, MAX_TEXT,
} = require('../src/perception/scene');
const { observeTools, findWindow } = require('../src/tools/observe');

const windowInfo = { title: 'Блокнот — привет.txt', process: 'notepad', handle: '42' };

function element(name, type, extra = {}) {
  return { name, type, enabled: true, value: '', ...extra };
}

function sceneOf(elements, extra = {}) {
  return buildScene({ window: windowInfo, elements, ...extra });
}

describe('снимок сцены', () => {
  test('id элемента устойчив между снимками, пока не меняется имя или automationId', () => {
    const a = sceneOf([element('Сохранить', 'Button')]);
    const b = sceneOf([element('Сохранить', 'Button')]);
    assert.match(a.elements[0].id, /^e[0-9a-f]{6}$/);
    assert.equal(a.elements[0].id, b.elements[0].id);
  });

  test('изменение значения не меняет id: у поля ввода имя остаётся прежним', () => {
    const a = sceneOf([element('Поиск', 'Edit', { value: 'старое' })]);
    const b = sceneOf([element('Поиск', 'Edit', { value: 'новое' })]);
    assert.equal(a.elements[0].id, b.elements[0].id);
    assert.notEqual(a.elements[0].value, b.elements[0].value);
  });

  test('automationId важнее имени: id переживает смену подписи', () => {
    const a = sceneOf([element('Было', 'Button', { automationId: 'save' })]);
    const b = sceneOf([element('Стало', 'Button', { automationId: 'save' })]);
    assert.equal(a.elements[0].id, b.elements[0].id);
  });

  test('одинаковые подписи в одном окне получают разные id', () => {
    const scene = sceneOf([element('ОК', 'Button'), element('ОК', 'Button')]);
    assert.equal(scene.elements.length, 2);
    assert.notEqual(scene.elements[0].id, scene.elements[1].id);
    assert.equal(scene.elements[0].occurrence, 1);
    assert.equal(scene.elements[1].occurrence, 2);
  });

  test('фокус находится по роли и имени и получает id элемента', () => {
    const scene = sceneOf([element('Поиск', 'Edit'), element('Найти', 'Button')], { focused: { name: 'Поиск', type: 'Edit' } });
    assert.equal(scene.focused.name, 'Поиск');
    assert.equal(scene.focused.id, scene.elements[0].id);
  });

  test('значения и адрес очищаются от секретов', () => {
    const scene = sceneOf([element('Ключ', 'Edit', { value: 'sk-abcdef0123456789' })], { url: 'https://example.com/?token=abcdef123' });
    assert.equal(scene.elements[0].value, '***');
    assert.equal(scene.url, 'https://example.com/?token=***');
  });

  test('элементы без имени и значения не попадают в сцену', () => {
    const scene = sceneOf([element('', 'Pane'), element('Кнопка', 'Button')]);
    assert.equal(scene.elements.length, 1);
  });

  test('безымянная кнопка с координатами остаётся: её можно нажать мышью', () => {
    const scene = sceneOf([
      element('', 'Button', { bounds: { x: 10, y: 20, w: 30, h: 40 } }),
      element('', 'Pane', { bounds: { x: 0, y: 0, w: 100, h: 100 } }),
    ]);
    assert.equal(scene.elements.length, 1);
    assert.deepEqual(scene.elements[0].bounds, { x: 10, y: 20, w: 30, h: 40 });
    assert.match(scene.text, /@10,20,30,40/);
  });

  test('в сцене сохраняется общее число элементов и признак обрезки', () => {
    const many = Array.from({ length: 5 }, (_, i) => element(`Кнопка ${i}`, 'Button'));
    const scene = sceneOf(many, { limit: 3 });
    assert.equal(scene.elements.length, 3);
    assert.equal(scene.total, 5);
    assert.equal(scene.truncated, true);
  });

  test('elementKey и elementId детерминированы', () => {
    const key = elementKey('Окно', element('ОК', 'Button'));
    assert.equal(key, elementKey('Окно', element('ОК', 'Button')));
    assert.equal(elementId(key), elementId(key));
    assert.match(elementId(key), /^e[0-9a-f]{6}$/);
  });

  test('redact не трогает обычный текст', () => {
    assert.equal(redact('Открыть папку Тест'), 'Открыть папку Тест');
  });
});

describe('разница снимков', () => {
  test('первый снимок помечается как первый', () => {
    const diff = diffScene(null, sceneOf([]));
    assert.equal(diff.first, true);
    assert.equal(diff.summary, 'первый снимок');
  });

  test('находит появление, изменение и исчезновение', () => {
    const before = sceneOf([element('Старая', 'Button'), element('Поле', 'Edit', { value: 'было' })]);
    const after = sceneOf([element('Новая', 'Button'), element('Поле', 'Edit', { value: 'стало' })]);
    const diff = diffScene(before, after);
    assert.equal(diff.first, false);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.removed.length, 1);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0].fields.includes('значение'), true);
  });

  test('сообщает о смене окна и фокуса', () => {
    const before = buildScene({ window: { title: 'Первое' }, elements: [element('Поле', 'Edit')], focused: { name: 'Поле', type: 'Edit' } });
    const after = buildScene({ window: { title: 'Второе' }, elements: [element('Поле', 'Edit')], focused: null });
    const diff = diffScene(before, after);
    assert.equal(diff.windowChanged, true);
    assert.equal(diff.focusChanged, true);
    assert.match(diff.summary, /окно/);
  });

  test('без изменений так и говорит', () => {
    const scene = sceneOf([element('ОК', 'Button')]);
    assert.equal(diffScene(scene, sceneOf([element('ОК', 'Button')])).summary, 'без изменений');
  });
});

describe('текст для модели', () => {
  test('интерактивные элементы идут раньше пассивных', () => {
    const scene = sceneOf([element('Текст', 'Text'), element('Кнопка', 'Button')]);
    const text = sceneText(scene);
    assert.ok(text.indexOf('Кнопка') < text.indexOf('Текст'));
  });

  test('текст укладывается в бюджет и помечает остаток', () => {
    const many = Array.from({ length: 60 }, (_, i) => element(`Очень длинная кнопка номер ${i}`, 'Button'));
    const scene = sceneOf(many);
    const text = sceneText(scene, { maxChars: 400 });
    assert.ok(text.length <= 420, `длина ${text.length}`);
    assert.match(text, /ещё/);
  });

  test('пустая сцена не падает', () => {
    const scene = buildScene({ window: null, elements: [] });
    assert.equal(scene.window.title, '');
    assert.equal(scene.counts.total, 0);
    assert.ok(scene.text.length > 0);
  });

  test('diff попадает в текст', () => {
    const before = sceneOf([element('ОК', 'Button')]);
    const after = sceneOf([element('Отмена', 'Button')]);
    const diff = diffScene(before, after);
    const text = sceneText(after, { diff });
    assert.match(text, /Изменения:/);
    assert.match(text, /исчезло/);
  });
});

describe('desktop_observe', () => {
  function fakeUi(sequence, extra = [], title = 'Блокнот — привет.txt') {
    const calls = { elements: 0 };
    const windows = {
      name: 'ui_windows',
      async run() {
        return { ok: true, summary: 'окон: 2', data: { windows: [{ title, process: 'notepad', handle: 1 }, { title: 'Проводник', process: 'explorer', handle: 2 }] } };
      },
    };
    const elements = {
      name: 'ui_elements',
      async run(args) {
        const items = sequence[Math.min(calls.elements, sequence.length - 1)];
        calls.elements += 1;
        return { ok: true, summary: `окно «${args.window}»: элементов ${items.length}`, data: { window: args.window, total: items.length, elements: items } };
      },
    };
    return { ui: [windows, elements, ...extra], calls };
  }

  function fakeAction(name) {
    const calls = [];
    return {
      calls,
      tool: {
        name,
        async run(args) {
          calls.push(args);
          return { ok: true, summary: `${name}: ок`, data: {} };
        },
      },
    };
  }

  test('первый вызов отдаёт сцену, второй — дельту', async () => {
    const { ui, calls } = fakeUi([[element('ОК', 'Button')], [element('ОК', 'Button'), element('Отмена', 'Button')]]);
    const [tool] = observeTools(ui);
    const first = await tool.run({ window: 'Блок' }, {});
    assert.equal(first.ok, true);
    assert.equal(first.data.diff.first, true);
    assert.equal(first.data.scene.elements.length, 1);
    const second = await tool.run({ window: 'Блок' }, {});
    assert.equal(calls.elements, 2);
    assert.equal(second.data.diff.first, false);
    assert.equal(second.data.diff.added.length, 1);
    assert.match(second.summary, /появилось/);
  });

  test('без window берёт верхнее окно, с частью заголовка — подходящее', async () => {
    const { ui } = fakeUi([[element('ОК', 'Button')]]);
    const [tool] = observeTools(ui);
    const top = await tool.run({}, {});
    assert.equal(top.data.scene.window.title, 'Блокнот — привет.txt');
    const explorer = await tool.run({ window: 'Провод' }, {});
    assert.equal(explorer.data.scene.window.title, 'Проводник');
  });

  test('неизвестное окно — отказ со списком, без чтения элементов', async () => {
    const { ui, calls } = fakeUi([[element('ОК', 'Button')]]);
    const [tool] = observeTools(ui);
    const result = await tool.run({ window: 'Нет такого' }, {});
    assert.equal(result.ok, false);
    assert.match(result.summary, /не найдено/);
    assert.equal(calls.elements, 0);
  });

  test('неверный limit отклоняется до вызова инструментов', async () => {
    const { ui } = fakeUi([[]]);
    const [tool] = observeTools(ui);
    const result = await tool.run({ limit: 0 }, {});
    assert.equal(result.ok, false);
    assert.match(result.summary, /limit/);
  });

  test('ошибка ui_windows возвращается как есть', async () => {
    const broken = { name: 'ui_windows', async run() { return { ok: false, summary: 'PowerShell не ответил', data: {} }; } };
    const elements = { name: 'ui_elements', async run() { return { ok: true, data: { elements: [] } }; } };
    const [tool] = observeTools([broken, elements]);
    const result = await tool.run({}, {});
    assert.equal(result.ok, false);
    assert.match(result.summary, /PowerShell/);
  });

  test('verify подтверждает только полученный снимок', async () => {
    const { ui } = fakeUi([[element('ОК', 'Button')]]);
    const [tool] = observeTools(ui);
    assert.equal((await tool.verify({}, { ok: true, summary: 'сцена' })).status, 'confirmed');
    assert.equal((await tool.verify({}, { ok: false })).status, 'failed');
  });

  test('нажатие по id: проверяет элемент, нажимает по имени и возвращает дельту', async () => {
    const frames = [
      [element('Сохранить', 'Button')],
      [element('Сохранить', 'Button')],
      [element('Сохранить', 'Button'), element('Готово', 'Text')],
    ];
    const click = fakeAction('ui_click');
    const { ui } = fakeUi(frames, [click.tool]);
    const tools = observeTools(ui);
    const observe = tools.find((t) => t.name === 'desktop_observe');
    const byId = tools.find((t) => t.name === 'desktop_click');
    const seen = await observe.run({ window: 'Блок' }, {});
    const id = seen.data.scene.elements[0].id;
    const result = await byId.run({ id }, {});
    assert.equal(result.ok, true);
    assert.equal(click.calls.length, 1);
    assert.equal(click.calls[0].name, 'Сохранить');
    assert.equal(click.calls[0].occurrence, 1);
    assert.equal(result.data.diff.added.length, 1);
    assert.match(result.summary, /нажал «Сохранить»/);
    assert.equal((await byId.verify({ id }, result)).status, 'confirmed');
  });

  test('нажатие по id не выполняет платёж через вложенный ui_click', async () => {
    const frames = [[element('Оплатить', 'Button')], [element('Оплатить', 'Button')]];
    const click = fakeAction('ui_click');
    const { ui } = fakeUi(frames, [click.tool]);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' }, {});
    const result = await tools.find((t) => t.name === 'desktop_click').run({ id: seen.data.scene.elements[0].id }, {});
    assert.equal(result.ok, false);
    assert.match(result.summary, /оплату/);
    assert.equal(click.calls.length, 0);
  });

  test('отказ или неопределённый результат ui_click не повторяется мышью', async () => {
    const btn = element('Продолжить', 'Button', { bounds: { x: 10, y: 20, w: 30, h: 40 } });
    let mouseCalls = 0;
    const click = { name: 'ui_click', async run() { return { ok: false, summary: 'оплату выполняет владелец самостоятельно', data: {} }; } };
    const mouse = { name: 'mouse_click', async run() { mouseCalls++; return { ok: true }; } };
    const { ui } = fakeUi([[btn], [btn]], [click]);
    const tools = observeTools(ui, { mouse: [mouse] });
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const result = await tools.find((t) => t.name === 'desktop_click').run({ id: seen.data.scene.elements[0].id });
    assert.equal(result.ok, false);
    assert.match(result.summary, /оплату/);
    assert.equal(mouseCalls, 0);
  });

  test('изменение окна не подтверждает отправку без проверки результата', async () => {
    const click = fakeAction('ui_click');
    click.tool.verify = async () => ({ status: 'unknown', evidence: 'доставку не проверить по окну' });
    const btn = element('Отправить', 'Button');
    const { ui } = fakeUi([[btn], [btn], [element('Готово', 'Text')]], [click.tool]);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const tool = tools.find((t) => t.name === 'desktop_click');
    const result = await tool.run({ id: seen.data.scene.elements[0].id });
    assert.equal(result.ok, true);
    assert.equal((await tool.verify({}, result)).status, 'unknown');
  });

  test('удаление, установку и выключение desktop_click не нажимает: режим решает по имени', async () => {
    for (const name of ['Удалить', 'Установить программу', 'Перезагрузить']) {
      const btn = element(name, 'Button', { bounds: { x: 1, y: 2, w: 3, h: 4 } });
      const click = fakeAction('ui_click');
      const { ui } = fakeUi([[btn], [btn]], [click.tool]);
      const tools = observeTools(ui);
      const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
      const result = await tools.find((t) => t.name === 'desktop_click').run({ id: seen.data.scene.elements[0].id });
      assert.equal(result.ok, false, name);
      assert.match(result.summary, /ui_click/, `${name}: должен указать путь с подтверждением`);
      assert.equal(click.calls.length, 0, `${name}: нажатие не выполнялось`);
    }
  });

  test('пустой ответ ui_click не повторяется мышью по координатам', async () => {
    const btn = element('Продолжить', 'Button', { bounds: { x: 0, y: 0, w: 10, h: 10 } });
    let mouseCalls = 0;
    const click = { name: 'ui_click', async run() { return null; } };
    const mouse = { name: 'mouse_click', async run() { mouseCalls += 1; return { ok: true }; } };
    const { ui } = fakeUi([[btn], [btn]], [click]);
    const tools = observeTools(ui, { mouse: [mouse] });
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const result = await tools.find((t) => t.name === 'desktop_click').run({ id: seen.data.scene.elements[0].id });
    assert.equal(result.ok, false);
    assert.match(result.summary, /неизвестен/);
    assert.equal(mouseCalls, 0, 'первое действие начиналось: мышью не повторяем');
  });

  test('жёсткий запрет окон действует и на desktop_click: почта и банк', async () => {
    const btn = element('Продолжить', 'Button');
    const click = fakeAction('ui_click');
    const { ui } = fakeUi([[btn], [btn]], [click.tool], 'Gmail — Входящие');
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Gmail' });
    const result = await tools.find((t) => t.name === 'desktop_click').run({ id: seen.data.scene.elements[0].id });
    assert.equal(result.ok, false);
    assert.match(result.summary, /запрет/);
    assert.equal(click.calls.length, 0, 'в запрещённом окне ui_click не вызывался');
  });

  test('жёсткий запрет окон действует и на desktop_type', async () => {
    const field = element('Поле', 'Edit', { value: '' });
    const type = fakeAction('ui_type');
    const { ui } = fakeUi([[field], [field]], [type.tool], 'Сбербанк Онлайн');
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Сбер' });
    const result = await tools.find((t) => t.name === 'desktop_type').run({ id: seen.data.scene.elements[0].id, text: 'привет' });
    assert.equal(result.ok, false);
    assert.match(result.summary, /запрет/);
    assert.equal(type.calls.length, 0, 'в запрещённом окне ui_type не вызывался');
  });

  test('номер вхождения пересчитывается по имени: у пункта меню и его надписи одна подпись', async () => {
    const frames = [
      [element('Папку', 'Text'), element('Папку', 'MenuItem')],
      [element('Папку', 'Text'), element('Папку', 'MenuItem')],
    ];
    const click = fakeAction('ui_click');
    const { ui } = fakeUi(frames, [click.tool]);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const menu = seen.data.scene.elements.find((e) => e.role === 'MenuItem');
    assert.equal(seen.data.scene.elements.find((e) => e.role === 'Text').occurrence, 1, 'у сцены свой номер по роли');
    const result = await tools.find((t) => t.name === 'desktop_click').run({ id: menu.id });
    assert.equal(result.ok, true, result.summary);
    // ui_click считает совпадения по имени без учёта роли: надпись идёт первой, пункт меню — вторым.
    assert.equal(click.calls[0].occurrence, 2);
  });

  test('нажатие по id отказывает, если элемент исчез', async () => {
    const frames = [[element('ОК', 'Button')], [element('Отмена', 'Button')]];
    const click = fakeAction('ui_click');
    const { ui } = fakeUi(frames, [click.tool]);
    const tools = observeTools(ui);
    const observe = tools.find((t) => t.name === 'desktop_observe');
    const byId = tools.find((t) => t.name === 'desktop_click');
    const seen = await observe.run({ window: 'Блок' }, {});
    const id = seen.data.scene.elements[0].id;
    const result = await byId.run({ id }, {});
    assert.equal(result.ok, false);
    assert.match(result.summary, /исчез/);
    assert.equal(click.calls.length, 0);
  });

  test('нажатие по id без снимка не выполняется', async () => {
    const click = fakeAction('ui_click');
    const { ui } = fakeUi([[]], [click.tool]);
    const byId = observeTools(ui).find((t) => t.name === 'desktop_click');
    const result = await byId.run({ id: 'e12ab34' }, {});
    assert.equal(result.ok, false);
    assert.match(result.summary, /сначала/);
    assert.equal(click.calls.length, 0);
  });

  test('безымянная кнопка: desktop_click жмёт мышью по центру координат', async () => {
    const nameless = element('', 'Button', { bounds: { x: 10, y: 20, w: 30, h: 40 } });
    const frames = [
      [nameless],
      [nameless],
      [nameless, element('Готово', 'Text')],
    ];
    const mouseCalls = [];
    const mouse = {
      name: 'mouse_click',
      async run(args) {
        mouseCalls.push(args);
        return { ok: true, summary: 'нажатие', data: {} };
      },
    };
    const { ui } = fakeUi(frames);
    const tools = observeTools(ui, { mouse: [mouse] });
    const observe = tools.find((t) => t.name === 'desktop_observe');
    const byId = tools.find((t) => t.name === 'desktop_click');
    const seen = await observe.run({ window: 'Блок' }, {});
    const id = seen.data.scene.elements[0].id;
    const result = await byId.run({ id }, {});
    assert.equal(result.ok, true);
    assert.equal(mouseCalls.length, 1);
    assert.deepEqual(mouseCalls[0], { window: 'Блокнот — привет.txt', x: 25, y: 40, button: 'left', units: 'physical' });
    assert.equal(result.data.fallback, true);
    assert.match(result.summary, /по координатам 25, 40/);
    assert.equal((await byId.verify({ id }, result)).status, 'confirmed');
  });

  test('безымянная кнопка без mouse_click: понятный отказ, а не молчание', async () => {
    const nameless = element('', 'Button', { bounds: { x: 1, y: 2, w: 3, h: 4 } });
    const { ui } = fakeUi([[nameless], [nameless]]);
    const tools = observeTools(ui);
    const observe = tools.find((t) => t.name === 'desktop_observe');
    const byId = tools.find((t) => t.name === 'desktop_click');
    assert.equal(byId, undefined);
    const seen = await observe.run({ window: 'Блок' }, {});
    assert.equal(seen.data.scene.elements.length, 1);
    assert.match(seen.data.scene.text, /без имени/);
  });

  test('ввод по id: перечитывает поле, вводит и подтверждает изменение', async () => {
    const frames = [
      [element('Поиск', 'Edit', { value: '' })],
      [element('Поиск', 'Edit', { value: '' })],
      [element('Поиск', 'Edit', { value: 'привет' })],
    ];
    const type = fakeAction('ui_type');
    const { ui } = fakeUi(frames, [type.tool]);
    const tools = observeTools(ui);
    const observe = tools.find((t) => t.name === 'desktop_observe');
    const byId = tools.find((t) => t.name === 'desktop_type');
    const seen = await observe.run({ window: 'Блок' }, {});
    const id = seen.data.scene.elements[0].id;
    const result = await byId.run({ id, text: 'привет' }, {});
    assert.equal(result.ok, true);
    assert.equal(type.calls[0].name, 'Поиск');
    assert.equal(type.calls[0].text, 'привет');
    assert.equal(result.data.diff.changed.length, 1);
    assert.match(result.summary, /ввёл 6 симв/);
    assert.equal((await byId.verify({ id, text: 'привет' }, result)).status, 'confirmed');
  });

  test('неизвестный результат ui_type не превращается в успех по изменению поля', async () => {
    const frames = [
      [element('Поиск', 'Edit', { value: '' })],
      [element('Поиск', 'Edit', { value: '' })],
      [element('Поиск', 'Edit', { value: 'привет' })],
    ];
    const type = fakeAction('ui_type');
    type.tool.verify = async () => ({ status: 'unknown', evidence: 'поле перечитано, но текст не сверен' });
    const { ui } = fakeUi(frames, [type.tool]);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const id = seen.data.scene.elements[0].id;
    const byId = tools.find((t) => t.name === 'desktop_type');
    const result = await byId.run({ id, text: 'привет' });
    assert.equal(result.ok, true);
    assert.equal(result.data.diff.changed.length, 1, 'по снимку поле видно изменившимся');
    const verdict = await byId.verify({ id, text: 'привет' }, result);
    assert.equal(verdict.status, 'unknown', 'вердикт вложенной проверки важнее смены экрана');
    assert.equal(verdict.evidence, 'поле перечитано, но текст не сверен');
  });

  test('отказ проверки ui_type тоже остаётся «неизвестно», а не успехом по диффу', async () => {
    const frames = [
      [element('Поиск', 'Edit', { value: '' })],
      [element('Поиск', 'Edit', { value: '' })],
      [element('Поиск', 'Edit', { value: 'привет' })],
    ];
    const type = fakeAction('ui_type');
    type.tool.verify = async () => ({ status: 'failed', evidence: 'поле не приняло текст' });
    const { ui } = fakeUi(frames, [type.tool]);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const id = seen.data.scene.elements[0].id;
    const byId = tools.find((t) => t.name === 'desktop_type');
    const result = await byId.run({ id, text: 'привет' });
    assert.equal(result.ok, true);
    assert.equal(result.data.diff.changed.length, 1, 'по снимку поле видно изменившимся');
    const verdict = await byId.verify({ id, text: 'привет' }, result);
    assert.equal(verdict.status, 'unknown');
    assert.equal(verdict.evidence, 'поле не приняло текст');
  });

  test('ввод без id идёт в текущий фокус последнего окна', async () => {
    const frames = [
      [element('Поле', 'Edit', { value: '' })],
      [element('Поле', 'Edit', { value: 'да' })],
    ];
    const type = fakeAction('ui_type');
    const { ui } = fakeUi(frames, [type.tool]);
    const tools = observeTools(ui);
    await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' }, {});
    const result = await tools.find((t) => t.name === 'desktop_type').run({ text: 'да' }, {});
    assert.equal(result.ok, true);
    assert.equal(type.calls[0].name, undefined);
    assert.equal(type.calls[0].window, 'Блокнот — привет.txt');
  });

  test('findWindow: точное совпадение важнее частичного', () => {
    const list = [{ title: 'Блокнот — привет.txt' }, { title: 'Блокнот' }];
    assert.equal(findWindow(list, 'Блокнот').title, 'Блокнот');
    assert.equal(findWindow(list, '').title, 'Блокнот — привет.txt');
  });

  test('инструмент подключён к main.js и описан в промпте', () => {
    const app = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(app, 'main.js'), 'utf8');
    assert.match(main, /require\('\.\/src\/tools\/observe'\)/);
    assert.match(main, /observeTools\(uiToolset, \{ mouse: mouseToolset \}\)/);
    assert.match(main, /const mouseToolset = mouseTools/);
    assert.match(main, /начни с desktop_observe/);
    assert.match(main, /desktop_click, desktop_type/);
    const loop = fs.readFileSync(path.join(app, 'src', 'agent', 'loop.js'), 'utf8');
    assert.match(loop, /'desktop_observe'/);
  });
});
