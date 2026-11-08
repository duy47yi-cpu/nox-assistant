'use strict';

// Тесты слоя данных «Рабочих столов» и виджетов (этап 7).
// Проверяются: хранилище (создание/переименование/удаление/переключение/порядок),
// шаблоны, схема виджетов и сетка, лимиты, битый файл и миграция версии, атомарность,
// а также чистые функции данных виджетов (ok/empty/error/stale) без сети и без data/.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DesksStore, SCHEMA_VERSION, MAX_DESKS, MAX_WIDGETS, MAX_NAME, GRID,
  findFreeSpot, normalizeWidget, layoutWidgets,
} = require('../src/desks/store');
const {
  TEMPLATE_IDS, templateList, template, templateWidgets, isWidgetType, WIDGET_TYPES,
} = require('../src/desks/templates');
const data = require('../src/desks/data');

// --- вспомогательное ------------------------------------------------------

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-desks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let counter = 1;
  const newId = () => uuid(counter++);
  const store = new DesksStore({ dataDir: dir, newId, now: () => Date.parse('2026-11-07T10:00:00Z') });
  return {
    dir,
    file: path.join(dir, 'desks.json'),
    store,
    newId,
    reopen: () => new DesksStore({ dataDir: dir, newId, now: () => Date.parse('2026-11-07T10:00:00Z') }),
    ...options,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertWidgetResult(r) {
  assert.equal(typeof r, 'object');
  assert.ok(data.DATA_TYPES.includes(r.type), `тип ${r.type}`);
  assert.ok(data.DATA_STATES.includes(r.state), `состояние ${r.state}`);
  assert.ok('value' in r);
  assert.ok('error' in r);
  if (r.state === 'error') assert.equal(typeof r.error, 'string');
}

const PLACED = (x, y, w, h) => ({ type: 'tasks', x, y, w, h });

// --- хранилище: базовые операции -----------------------------------------

test('пустое пространство: list пуст, active null, ensure создаёт пустой стол один раз', (t) => {
  const { store } = setup(t);
  assert.deepEqual(store.list('default'), []);
  assert.equal(store.active('default'), null);
  assert.deepEqual(store.state('default'), { workspaceId: 'default', desks: [], activeId: null });

  const first = store.ensure('default');
  assert.equal(first.created, true);
  assert.equal(first.desks.length, 1);
  assert.equal(first.desks[0].name, 'Пустой');
  assert.equal(first.desks[0].template, 'empty');
  assert.deepEqual(first.desks[0].widgets, []);
  assert.equal(first.activeId, first.desks[0].id);

  const again = store.ensure('default');
  assert.equal(again.created, false);
  assert.equal(again.desks.length, 1);
});

test('создание, переключение, переименование, удаление и восстановление после перезапуска', (t) => {
  const { store, reopen, file } = setup(t);
  const work = store.create('default', { name: 'Работа', template: 'work' });
  assert.equal(work.name, 'Работа');
  assert.equal(work.template, 'work');
  assert.equal(work.widgets.length, 7, 'в «Работе» теперь есть виджет новостей');
  assert.equal(store.active('default').id, work.id, 'новый стол становится активным');

  const study = store.create('default', { name: 'Учёба', template: 'study' });
  assert.equal(store.active('default').id, study.id);

  store.select('default', work.id);
  assert.equal(store.active('default').id, work.id);

  const renamed = store.rename('default', study.id, '  Учёба   вечером ');
  assert.equal(renamed.name, 'Учёба вечером');

  const removed = store.remove('default', study.id);
  assert.equal(removed.removed, true);
  assert.equal(removed.activeId, work.id);
  assert.equal(store.list('default').length, 1);
  assert.throws(() => store.remove('default', work.id), /единственный/);

  // Второй экземпляр на той же папке видит сохранённое без перезапуска приложения.
  const restored = reopen();
  assert.equal(restored.list('default').length, 1);
  assert.equal(restored.list('default')[0].name, 'Работа');
  assert.equal(restored.active('default').id, work.id);
  assert.equal(readJson(file).version, SCHEMA_VERSION);
});

test('пространства не перемешивают столы: у каждого свои вкладки и активный стол', (t) => {
  const { store, reopen } = setup(t);
  const spaceB = uuid(900);
  const a = store.create('default', { name: 'Общий', template: 'media' });
  const b = store.create(spaceB, { name: 'Личный', template: 'games' });
  assert.equal(store.list('default').length, 1);
  assert.equal(store.list(spaceB).length, 1);
  assert.equal(store.active('default').id, a.id);
  assert.equal(store.active(spaceB).id, b.id);
  assert.equal(store.list('default')[0].template, 'media');
  assert.equal(store.list(spaceB)[0].template, 'games');
  assert.equal(store.get('default', b.id), null);
  // Повторное открытие не переносит столы между пространствами.
  const restored = reopen();
  assert.equal(restored.active('default').id, a.id);
  assert.equal(restored.active(spaceB).id, b.id);
});

test('порядок вкладок меняется через reorder и сохраняется', (t) => {
  const { store, reopen } = setup(t);
  const one = store.create('default', { name: 'Первый', template: 'empty' });
  const two = store.create('default', { name: 'Второй', template: 'empty' });
  const three = store.create('default', { name: 'Третий', template: 'empty' });
  store.reorder('default', three.id, 0);
  assert.deepEqual(store.list('default').map((d) => d.name), ['Третий', 'Первый', 'Второй']);
  assert.deepEqual(reopen().list('default').map((d) => d.name), ['Третий', 'Первый', 'Второй']);
  assert.equal(store.select('default', two.id).id, two.id);
  assert.equal(store.active('default').id, two.id);
  assert.throws(() => store.reorder('default', one.id, 9), /index/);
});

// --- хранилище: лимиты и безопасные id ------------------------------------

test('лимиты: не больше 12 столов, 24 виджетов, имя до 40 символов, без повторов и управляющих', (t) => {
  const { store } = setup(t);
  store.create('default', { name: 'Стол 1', template: 'empty' });
  assert.throws(() => store.create('default', { name: 'стол 1', template: 'empty' }), /уже есть/);
  assert.throws(() => store.create('default', { name: '  ', template: 'empty' }), /1 до 40/);
  assert.throws(() => store.create('default', { name: 'я'.repeat(MAX_NAME + 1), template: 'empty' }), /1 до 40/);
  assert.throws(() => store.create('default', { name: 'плохой\u0007стол', template: 'empty' }), /1 до 40/);
  assert.throws(() => store.create('default', { template: 'нет-такого' }), /неизвестный шаблон/);
  // Имя ровно в 40 символов допустимо.
  const exact = store.create('default', { name: 'я'.repeat(MAX_NAME), template: 'empty' });
  assert.equal(Array.from(exact.name).length, MAX_NAME);

  for (let i = 3; i <= MAX_DESKS; i += 1) store.create('default', { name: `Стол ${i}`, template: 'empty' });
  assert.equal(store.list('default').length, MAX_DESKS);
  assert.throws(() => store.create('default', { name: 'Тринадцатый', template: 'empty' }), /не больше 12 столов/);
});

test('лимит виджетов на стол — 24, и он проверяется до записи', (t) => {
  const { store, file } = setup(t);
  const desk = store.create('default', { name: 'Много', template: 'empty' });
  // 24 виджета 1×1 помещаются в сетку 12×12.
  const twentyFour = Array.from({ length: MAX_WIDGETS }, (_, i) => ({ type: 'tasks', w: 1, h: 1, x: (i % 12) + 1, y: Math.floor(i / 12) + 1 }));
  const saved = store.setWidgets('default', desk.id, twentyFour);
  assert.equal(saved.desk.widgets.length, MAX_WIDGETS);
  const before = fs.readFileSync(file, 'utf8');
  const twentyFive = [...twentyFour.map((w, i) => ({ ...w, x: (i % 12) + 1, y: Math.floor(i / 12) + 1 })), { type: 'tasks', w: 1, h: 1, x: 1, y: 3 }];
  assert.throws(() => store.setWidgets('default', desk.id, twentyFive), /не больше 24 виджетов/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'неудачная замена не пишет файл');
});

test('небезопасные id и workspaceId отклоняются до чтения и записи', (t) => {
  const { store, file } = setup(t);
  assert.throws(() => store.list('../outside'), /workspaceId/);
  assert.throws(() => store.list(''), /workspaceId/);
  assert.throws(() => store.list('DEFAULT'), /workspaceId/);
  assert.throws(() => store.active('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), /workspaceId/);
  store.create('default', { template: 'empty', name: 'Ок' });
  assert.throws(() => store.select('default', '../id'), /неверный id/);
  assert.throws(() => store.select('default', uuid(999)), /стол не найден/);
  assert.equal(fs.existsSync(file), true);
});

// --- шаблоны --------------------------------------------------------------

test('девять шаблонов: шесть прежних и ночь, разработка, стрим', (t) => {
  assert.deepEqual(TEMPLATE_IDS, ['empty', 'work', 'study', 'games', 'media', 'avatar', 'night', 'dev', 'stream']);
  assert.deepEqual(templateList().map((x) => x.title), ['Пустой', 'Работа', 'Учёба', 'Игры', 'Медиа', 'Только аватар', 'Ночь', 'Разработка', 'Стрим']);
  const { store } = setup(t);
  for (const id of TEMPLATE_IDS) {
    const spec = template(id);
    const desk = store.create('default', { name: `Шаблон ${id}`, template: id });
    assert.equal(desk.template, id);
    assert.equal(desk.widgets.length, spec.widgets.length);
    for (const widget of desk.widgets) {
      assert.ok(isWidgetType(widget.type), `тип ${widget.type} из каталога`);
      assert.equal(widget.version, 1);
      assert.ok(widget.x >= 1 && widget.y >= 1);
      assert.ok(widget.x + widget.w - 1 <= GRID.cols);
      assert.ok(widget.y + widget.h - 1 <= GRID.rows);
    }
  }
  const empty = store.get('default', store.list('default').find((d) => d.template === 'empty').id);
  assert.deepEqual(empty.widgets, []);
  const avatar = store.get('default', store.list('default').find((d) => d.template === 'avatar').id);
  assert.deepEqual(avatar.widgets.map((w) => w.type), ['orb']);
  assert.deepEqual(template('work').widgets.map((w) => w.type).sort(), ['commands', 'currency', 'news', 'system', 'tasks', 'today', 'weather']);
  // Новые шаблоны: только существующие типы, сетка 12×12, материализация даёт id.
  assert.deepEqual(template('night').widgets.map((w) => w.type).sort(), ['orb', 'reminders', 'system']);
  assert.deepEqual(template('dev').widgets.map((w) => w.type).sort(), ['commands', 'news', 'notes', 'system', 'tasks']);
  assert.deepEqual(template('stream').widgets.map((w) => w.type).sort(), ['apps', 'music', 'pet', 'system']);
  for (const id of ['night', 'dev', 'stream']) {
    const made = templateWidgets(id, { newId: () => uuid(70) });
    assert.equal(made.length, template(id).widgets.length);
    for (const widget of made) {
      assert.ok(isWidgetType(widget.type));
      assert.ok(widget.x + widget.w - 1 <= GRID.cols);
      assert.ok(widget.y + widget.h - 1 <= GRID.rows);
    }
  }
});

test('каталог: 17 типов, у каждого настоящий источник или честная пометка', () => {
  const ids = WIDGET_TYPES.map((w) => w.id).sort();
  assert.deepEqual(ids, [
    'apps', 'commands', 'currency', 'downloads', 'goals', 'mcp', 'missions',
    'music', 'news', 'notes', 'orb', 'pet', 'reminders', 'system', 'tasks', 'today', 'weather',
  ]);
  assert.equal(WIDGET_TYPES.length, 17);
  const newsType = WIDGET_TYPES.find((w) => w.id === 'news');
  assert.equal(newsType.title, 'Новости');
  assert.equal(newsType.defaultW, 4);
  assert.equal(newsType.defaultH, 3);
  for (const id of WIDGET_TYPES.map((w) => w.id)) assert.ok(isWidgetType(id));
  for (const banned of ['finance', 'home', 'calendar', 'files', 'holodeck']) assert.equal(isWidgetType(banned), false);
  // Каждый шаблон использует только типы из каталога — поймает опечатку в шаблоне.
  for (const id of TEMPLATE_IDS) {
    for (const widget of template(id).widgets) assert.ok(isWidgetType(widget.type), `${id}: ${widget.type}`);
  }
  // templateWidgets выдаёт id и не ломает исходный шаблон.
  const before = JSON.stringify(template('study'));
  const widgets = templateWidgets('study', { newId: () => uuid(1) });
  assert.equal(widgets.length, 4);
  assert.equal(typeof widgets[0].id, 'string');
  assert.equal(JSON.stringify(template('study')), before);
  assert.throws(() => templateWidgets('нет', { newId: () => uuid(1) }), /неизвестный шаблон/);
});

// --- схема виджетов, сетка, наложение -------------------------------------

test('сетка: координаты, ширина и высота проверяются, выход за край отклоняется', () => {
  const base = { id: uuid(1), type: 'tasks', x: 1, y: 1, w: 6, h: 4 };
  assert.equal(normalizeWidget(base).x, 1);
  assert.throws(() => normalizeWidget({ ...base, x: 0 }), /x: целое от 1 до 12/);
  assert.throws(() => normalizeWidget({ ...base, x: 13 }), /x: целое от 1 до 12/);
  assert.throws(() => normalizeWidget({ ...base, y: 0 }), /y: целое от 1 до 12/);
  assert.throws(() => normalizeWidget({ ...base, w: 0 }), /w: целое от 1 до 12/);
  assert.throws(() => normalizeWidget({ ...base, h: 7 }), /h: целое от 1 до 6/);
  assert.throws(() => normalizeWidget({ ...base, x: 10, w: 4 }), /правый край/);
  assert.throws(() => normalizeWidget({ ...base, y: 11, h: 4 }), /нижний край/);
  assert.throws(() => normalizeWidget({ ...base, x: undefined, y: 2 }), /x и y задаются вместе/);
  assert.throws(() => normalizeWidget({ ...base, type: 'holodeck' }), /неизвестный тип/);
  assert.throws(() => normalizeWidget({ ...base, version: 2 }), /версия/);
  assert.throws(() => normalizeWidget({ type: 'tasks', w: 1, h: 1 }), /нет id/);
});

test('config виджета: только известные ключи и простые значения', () => {
  const base = { id: uuid(1), type: 'tasks', x: 1, y: 1, w: 4, h: 3 };
  assert.deepEqual(normalizeWidget({ ...base, config: { filter: 'today', limit: 5 } }).config, { filter: 'today', limit: 5 });
  assert.throws(() => normalizeWidget({ ...base, config: { secret: 'x' } }), /неизвестный ключ/);
  assert.throws(() => normalizeWidget({ ...base, config: { limit: 999 } }), /limit/);
  assert.throws(() => normalizeWidget({ ...base, config: [] }), /нужен объект/);
  const money = { id: uuid(2), type: 'currency', x: 1, y: 1, w: 4, h: 3, config: { codes: ['usd', 'EUR', 'usd'] } };
  assert.deepEqual(normalizeWidget(money).config, { codes: ['USD', 'EUR'] });
  assert.throws(() => normalizeWidget({ ...money, config: { codes: ['US'] } }), /латинских букв/);
  assert.throws(() => normalizeWidget({ ...money, config: { codes: ['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'CHF'] } }), /от 1 до 5/);
});

test('виджеты не накладываются; первое свободное место ищется сверху вниз', () => {
  const widgets = [PLACED(1, 1, 6, 4), PLACED(7, 1, 6, 4)];
  assert.deepEqual(findFreeSpot(widgets, 4, 3), { x: 1, y: 5 });
  assert.deepEqual(findFreeSpot([], 12, 6), { x: 1, y: 1 });
  assert.equal(findFreeSpot([PLACED(1, 1, 12, 12)], 1, 1), null);
  let counter = 0;
  const ids = () => uuid(++counter);
  assert.throws(() => layoutWidgets([PLACED(1, 1, 6, 4), PLACED(1, 1, 6, 4)], { newId: ids }), /накладываются/);
  // Без координат виджет встаёт в свободное место сам.
  const placed = layoutWidgets([{ type: 'tasks', w: 6, h: 4 }, { type: 'system', w: 4, h: 3 }], { newId: ids });
  assert.deepEqual([placed[0].x, placed[0].y], [1, 1]);
  assert.deepEqual([placed[1].x, placed[1].y], [7, 1]);
});

// --- виджеты: добавление, перенос, размер, правка, удаление ---------------

test('виджет: добавление с авто-местом, перенос, размер, config и удаление', (t) => {
  const { store, reopen } = setup(t);
  const desk = store.create('default', { name: 'Проверка', template: 'empty' });
  const first = store.addWidget('default', desk.id, { type: 'tasks' });
  assert.equal(first.widget.type, 'tasks');
  assert.deepEqual([first.widget.x, first.widget.y, first.widget.w, first.widget.h], [1, 1, 6, 4]);
  const second = store.addWidget('default', desk.id, { type: 'system' });
  assert.deepEqual([second.widget.x, second.widget.y], [7, 1]);

  // Перенос на свободное место и отказ при наложении.
  const moved = store.moveWidget('default', desk.id, second.widget.id, 1, 7);
  assert.deepEqual([moved.widget.x, moved.widget.y], [1, 7]);
  assert.throws(() => store.moveWidget('default', desk.id, second.widget.id, 1, 1), /накладываются/);
  assert.throws(() => store.moveWidget('default', desk.id, second.widget.id, 13, 1), /x: целое/);

  // Размер: в пределах сетки — можно, за край и выше предела — нельзя.
  const resized = store.resizeWidget('default', desk.id, first.widget.id, 4, 3);
  assert.deepEqual([resized.widget.w, resized.widget.h], [4, 3]);
  assert.throws(() => store.resizeWidget('default', desk.id, first.widget.id, 4, 7), /h: целое от 1 до 6/);
  assert.throws(() => store.updateWidget('default', desk.id, first.widget.id, { x: 10, w: 4 }), /правый край/);

  // Правка config и запрет менять тип/id.
  const updated = store.updateWidget('default', desk.id, first.widget.id, { config: { filter: 'all', limit: 3 } });
  assert.deepEqual(updated.widget.config, { filter: 'all', limit: 3 });
  assert.throws(() => store.updateWidget('default', desk.id, first.widget.id, { type: 'orb' }), /нельзя менять/);
  assert.throws(() => store.updateWidget('default', desk.id, uuid(77), { x: 1 }), /виджет не найден/);

  const removed = store.removeWidget('default', desk.id, second.widget.id);
  assert.equal(removed.removedId, second.widget.id);
  assert.equal(removed.desk.widgets.length, 1);
  // Всё это лежит в файле и переживает перезапуск.
  const restored = reopen().get('default', desk.id);
  assert.equal(restored.widgets.length, 1);
  assert.deepEqual(restored.widgets[0].config, { filter: 'all', limit: 3 });
});

test('setWidgets: полная замена раскладки, авто-место и атомарность при ошибке', (t) => {
  const { store, file } = setup(t);
  const desk = store.create('default', { name: 'Замена', template: 'empty' });
  const replaced = store.setWidgets('default', desk.id, [
    { type: 'music' },
    { type: 'orb' },
  ]);
  assert.equal(replaced.desk.widgets.length, 2);
  assert.deepEqual([replaced.desk.widgets[0].x, replaced.desk.widgets[0].y], [1, 1]);
  assert.deepEqual([replaced.desk.widgets[1].x, replaced.desk.widgets[1].y], [1, 5], 'широкий аватар встаёт ниже');

  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.setWidgets('default', desk.id, [
    { type: 'tasks', x: 1, y: 1, w: 6, h: 4 },
    { type: 'tasks', x: 1, y: 1, w: 6, h: 4 },
  ]), /накладываются/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'неудачная замена не трогает файл');
});

// --- файл: атомарность, битый JSON, версия, миграция ----------------------

test('сохранение атомарное: файл — валидный JSON, временных файлов не остаётся', (t) => {
  const { store, dir, file } = setup(t);
  store.ensure('default', { template: 'work' });
  const parsed = readJson(file);
  assert.equal(parsed.version, SCHEMA_VERSION);
  assert.ok(parsed.spaces.default);
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(fs.readdirSync(dir), ['desks.json']);
});

test('битый JSON даёт пустое состояние, а исходные байты сохраняются рядом', (t) => {
  const { store, file } = setup(t);
  fs.writeFileSync(file, '{это не json', 'utf8');
  assert.deepEqual(store.list('default'), []);
  assert.equal(store.active('default'), null);
  // Чтение не перезаписывает повреждённый файл само по себе.
  assert.equal(fs.readFileSync(file, 'utf8'), '{это не json');
  // Первая запись начинает с чистого листа, но копия прежних байтов остаётся.
  const desk = store.create('default', { name: 'После сбоя', template: 'empty' });
  assert.equal(desk.name, 'После сбоя');
  assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), '{это не json');
  assert.equal(readJson(file).spaces.default.desks.length, 1);
});

test('неизвестная (более новая) версия схемы — отказ без перезаписи файла', (t) => {
  const { file } = setup(t);
  const future = `${JSON.stringify({ version: 99, spaces: { default: { activeId: null, desks: [] } } }, null, 2)}\n`;
  fs.writeFileSync(file, future, 'utf8');
  const store = new DesksStore({ dataDir: path.dirname(file), newId: () => uuid(1) });
  assert.throws(() => store.list('default'), /более новой версией схемы/);
  assert.throws(() => store.create('default', { name: 'Нельзя', template: 'empty' }), /более новой версией схемы/);
  assert.equal(fs.readFileSync(file, 'utf8'), future, 'файл будущего формата не изменён');
});

test('миграция старой версии: данные столов сохраняются, при записи ставится версия 1', (t) => {
  const { file } = setup(t);
  const deskId = uuid(11);
  const widgetId = uuid(12);
  const legacy = {
    spaces: {
      default: {
        activeId: deskId,
        desks: [{
          id: deskId,
          name: 'Старый стол',
          template: 'media',
          version: 1,
          widgets: [{ id: widgetId, type: 'music', version: 1, x: 1, y: 1, w: 6, h: 4, config: {} }],
        }],
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');
  const store = new DesksStore({ dataDir: path.dirname(file), newId: () => uuid(20) });
  const desks = store.list('default');
  assert.equal(desks.length, 1);
  assert.equal(desks[0].name, 'Старый стол');
  assert.deepEqual(desks[0].widgets.map((w) => w.type), ['music']);
  assert.equal(store.active('default').id, deskId);
  // Миграция не выдумывает данные: без новой записи файл остаётся в старом виде.
  assert.equal(readJson(file).version, undefined);
  // Первая мутация переносит данные в схему версии 1.
  store.create('default', { name: 'Новый стол', template: 'empty' });
  const migrated = readJson(file);
  assert.equal(migrated.version, SCHEMA_VERSION);
  assert.deepEqual(migrated.spaces.default.desks.map((d) => d.name), ['Старый стол', 'Новый стол']);
});

test('плоский старый формат { workspaceId: {desks} } тоже мигрирует', (t) => {
  const { file } = setup(t);
  const deskId = uuid(31);
  const legacy = {
    default: {
      activeId: deskId,
      desks: [{ id: deskId, name: 'Плоский', template: 'empty', version: 1, widgets: [] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(legacy), 'utf8');
  const store = new DesksStore({ dataDir: path.dirname(file), newId: () => uuid(32) });
  assert.equal(store.list('default')[0].name, 'Плоский');
  store.rename('default', deskId, 'Переименован');
  assert.equal(readJson(file).version, SCHEMA_VERSION);
  assert.equal(readJson(file).spaces.default.desks[0].name, 'Переименован');
});

test('структурно неверный файл даёт пустое состояние и копию повреждённого', (t) => {
  const { file } = setup(t);
  const bad = JSON.stringify({ version: 1, spaces: { default: { activeId: null, desks: [{ id: 'нет', name: 'X', template: 'empty', widgets: [] }] } } });
  fs.writeFileSync(file, bad, 'utf8');
  const store = new DesksStore({ dataDir: path.dirname(file), newId: () => uuid(1) });
  assert.deepEqual(store.list('default'), []);
  assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), bad);
});

test('конструктору нужна абсолютная папка данных или абсолютный файл', () => {
  assert.throws(() => new DesksStore({}), /абсолютная папка данных/);
  assert.throws(() => new DesksStore({ dataDir: 'relative' }), /абсолютная папка данных/);
  assert.throws(() => new DesksStore({ file: 'relative/desks.json' }), /абсолютный путь/);
  const file = path.join(os.tmpdir(), 'nox-desks-absolute', 'desks.json');
  const store = new DesksStore({ file });
  assert.equal(store.file, file);
});

// --- data.js: источники виджетов -----------------------------------------

test('system: снимок os даёт загрузку ЦП и память; нет снимка — empty, мусор — error', () => {
  const snapshot = {
    cpus: [{ times: { user: 300, nice: 0, sys: 100, irq: 0, idle: 600 } }],
    totalmem: 16 * 1024 ** 3,
    freemem: 8 * 1024 ** 3,
    platform: 'win32',
    arch: 'x64',
    uptime: 3600,
  };
  const ok = data.system(snapshot);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.value.cpuPercent, 40); // (300+100)/(300+100+600)
  assert.equal(ok.value.memPercent, 50);
  assert.equal(ok.value.memUsed, 8 * 1024 ** 3);
  assert.equal(data.system(undefined).state, 'empty');
  assert.equal(data.system({}).state, 'error');
  assert.equal(data.system({ cpus: [], totalmem: 1, freemem: 0 }).state, 'error');
  assert.equal(data.system({ cpus: [{ times: {} }], totalmem: 1, freemem: 0 }).state, 'error');
});

test('tasks: очередь задач, пустой список — empty, мусор — error, filter и limit работают', () => {
  const now = new Date(2026, 10, 7, 10, 0, 0).getTime();
  const list = [
    { id: 't1', title: 'Сделать отчёт', status: 'running', updatedAt: new Date(2026, 10, 7, 9, 0, 0).toISOString() },
    { id: 't2', title: 'Старая задача', status: 'done' },
    { id: 't3', title: 'Ждёт решения', status: 'waiting_approval' },
    { id: 't4', title: 'Без статуса' },
    { id: 5, title: 'Не задача' },
  ];
  const active = data.tasks(list, { now, limit: 2 });
  assert.equal(active.state, 'ok');
  assert.equal(active.value.counts.running, 1);
  assert.equal(active.value.counts.waiting, 1);
  assert.equal(active.value.items.length, 2, 'limit соблюдается');
  assert.ok(active.value.items.every((item) => item.status !== 'done'));
  assert.equal(data.tasks([]).state, 'empty');
  assert.equal(data.tasks(null).state, 'empty');
  assert.equal(data.tasks('мусор').state, 'error');
  const todayOnly = data.tasks(list, { now, filter: 'today' });
  assert.deepEqual(todayOnly.value.items.map((i) => i.id), ['t1']);
});

test('today: напоминания и миссии на сегодня, будущее и прошедшие дни не выдумываются', () => {
  // Время строим в локальной зоне, чтобы тест не зависел от часового пояса машины.
  const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute, 0).toISOString();
  const now = new Date(2026, 10, 7, 10, 0, 0).getTime();
  const sources = {
    reminders: [
      { id: 'r1', text: 'Позвонить', dueAt: at(7, 12) },
      { id: 'r2', text: 'Просрочено', dueAt: at(5, 9) },
      { id: 'r3', text: 'Завтра', dueAt: at(9, 9) },
      { id: 'r4', text: 'Уже сделано', dueAt: at(7, 9), done: true },
    ],
    missions: [
      { id: 'm1', goal: 'Утренняя сводка', status: 'active', nextRunAt: at(7, 18) },
      { id: 'm2', goal: 'Завтра', status: 'active', nextRunAt: at(8, 10) },
    ],
  };
  const today = data.today(sources, { now });
  assert.equal(today.state, 'ok');
  assert.equal(today.value.total, 3);
  assert.deepEqual(today.value.reminders.map((r) => r.id), ['r2', 'r1']);
  assert.equal(today.value.reminders[0].overdue, true);
  assert.deepEqual(today.value.missions.map((m) => m.id), ['m1']);
  assert.equal(data.today({ reminders: [], missions: [] }, { now }).state, 'empty');
  assert.equal(data.today({ reminders: 'мусор' }, { now }).state, 'error');
});

test('music: история — последний запрос; пустая история — empty', () => {
  const ok = data.music([
    { query: 'Мияги', service: 'yandex', at: '2026-11-07T09:00:00.000Z' },
    { query: 'Старое', service: 'spotify', at: '2026-11-01T09:00:00.000Z' },
  ]);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.value.last.query, 'Мияги');
  assert.equal(ok.value.items.length, 2);
  assert.equal(data.music([]).state, 'empty');
  assert.equal(data.music(null).state, 'empty');
  assert.equal(data.music([{ query: '   ' }]).state, 'empty');
  assert.equal(data.music('мусор').state, 'error');
});

test('weather: нет города — empty/no_city, сбой — error с причиной, старый кэш — stale', () => {
  const now = Date.parse('2026-11-07T10:00:00Z');
  assert.equal(data.weather(null).state, 'empty');
  const noCity = data.weather({ city: null });
  assert.equal(noCity.state, 'empty');
  assert.equal(noCity.error, 'no_city');
  const netErr = data.weather({ city: 'Москва', ok: false, reason: 'network' });
  assert.equal(netErr.state, 'error');
  assert.equal(netErr.error, 'network');
  const ok = data.weather({ city: 'Москва', temp: 3.4, apparent: 1, precipitation: 0.2, fetchedAt: now - 1000 }, { now });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.value.temp, 3.4);
  assert.equal(ok.value.apparent, 1);
  const stale = data.weather({ city: 'Москва', temp: 3.4, fetchedAt: now - 60 * 60 * 1000 }, { now, maxAgeMs: 30 * 60 * 1000 });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.value.temp, 3.4);
  const noData = data.weather({ city: 'Москва' });
  assert.equal(noData.state, 'empty');
  assert.equal(noData.error, 'no_data');
});

test('currency: настоящие строки ЦБ, сбой — error с причиной, старый кэш — stale', () => {
  const now = Date.parse('2026-11-07T10:00:00Z');
  assert.equal(data.currency(null).state, 'empty');
  const ok = data.currency({
    ok: true,
    date: '2026-11-07T00:00:00.000Z',
    rates: [{ code: 'USD', name: 'доллар', value: 82.1, previous: 81.9 }, { code: 'EUR', name: 'евро', value: 95.2 }],
    fetchedAt: now - 1000,
  }, { now });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.value.rates.length, 2);
  assert.equal(ok.value.rates[0].value, 82.1);
  const failed = data.currency({ ok: false, reason: 'network' });
  assert.equal(failed.state, 'error');
  assert.equal(failed.error, 'network');
  const stale = data.currency({ ok: true, rates: [{ code: 'USD', value: 82 }], fetchedAt: now - 60 * 60 * 1000 }, { now, maxAgeMs: 15 * 60 * 1000 });
  assert.equal(stale.state, 'stale');
  assert.equal(data.currency({ ok: true, rates: [] }).state, 'empty');
  assert.equal(data.currency('мусор').state, 'error');
});

test('apps: топ по настоящим запускам; пустая статистика — empty', () => {
  const usage = {
    apps: {
      steam: { launches: 3, seenRunning: 1, last: '2026-11-06T20:00:00.000Z' },
      code: { launches: 9, seenRunning: 2, last: '2026-11-07T08:00:00.000Z' },
      пусто: {},
    },
  };
  const ok = data.apps(usage, { limit: 2 });
  assert.equal(ok.state, 'ok');
  assert.deepEqual(ok.value.items.map((a) => a.name), ['code', 'steam']);
  assert.equal(ok.value.items[0].launches, 9);
  assert.equal(data.apps({ apps: {} }).state, 'empty');
  assert.equal(data.apps(null).state, 'empty');
  assert.equal(data.apps({ apps: 'мусор' }).state, 'error');
});

test('orb: только настоящие состояния шара; неизвестное — error', () => {
  assert.equal(data.orb(null).state, 'empty');
  assert.deepEqual(data.orb('thinking').value, { state: 'thinking', label: 'Думаю', steps: null });
  assert.equal(data.orb({ state: 'waiting_approval', steps: 3 }).value.label, 'Ждёт вас');
  assert.equal(data.orb({ state: 'waiting_approval', steps: 3 }).value.steps, 3);
  assert.equal(data.orb('pet').state, 'error');
  assert.equal(data.orb('pet').error, 'bad_state');
});

test('commands: список своих команд; пустой — empty', () => {
  const ok = data.commands([{ id: 'c1', name: 'Открыть почту', folder: 'Работа' }], { limit: 5 });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.value.items[0].name, 'Открыть почту');
  assert.equal(data.commands([]).state, 'empty');
  assert.equal(data.commands(null).state, 'empty');
  assert.equal(data.commands({ items: 'мусор' }).state, 'error');
});

test('новые типы: goals, missions, reminders — настоящие списки и честные состояния', () => {
  // goals: только активные, число шагов — из записи.
  const goals = data.goals([
    { id: 'g1', title: 'Выучить язык', status: 'active', steps: [{ status: 'done' }, { status: 'pending' }], updatedAt: '2026-11-07T09:00:00.000Z' },
    { id: 'g2', title: 'Готовая', status: 'done', steps: [] },
    { id: 'g3', title: 'Сломанная' },
    { title: 'Без id' },
  ]);
  assert.equal(goals.state, 'ok');
  assert.deepEqual(goals.value.items.map((g) => g.id), ['g1']);
  assert.equal(goals.value.items[0].stepsDone, 1);
  assert.equal(goals.value.items[0].stepsTotal, 2);
  assert.equal(data.goals([]).state, 'empty');
  assert.equal(data.goals(null).state, 'empty');
  assert.equal(data.goals('мусор').state, 'error');
  assert.equal(data.goals({ items: 5 }).state, 'error');

  // missions: выключенные видны, порядок по nextRunAt, running посчитан.
  const missions = data.missions([
    { id: 'm2', goal: 'Поздняя', enabled: true, status: 'idle', nextRunAt: '2026-11-07T18:00:00.000Z', runs: 2 },
    { id: 'm1', goal: 'Ранняя', enabled: false, status: 'running', nextRunAt: '2026-11-07T12:00:00.000Z', runs: 5 },
  ]);
  assert.equal(missions.state, 'ok');
  assert.deepEqual(missions.value.items.map((m) => m.id), ['m1', 'm2']);
  assert.equal(missions.value.items[0].enabled, false);
  assert.equal(missions.value.running, 1);
  assert.equal(missions.value.total, 2);
  assert.equal(data.missions([]).state, 'empty');
  assert.equal(data.missions(null).state, 'empty');
  assert.equal(data.missions({}).state, 'error');

  // reminders: выполненные и без даты пропускаются, просроченные помечены.
  const now = Date.parse('2026-11-07T10:00:00Z');
  const reminders = data.reminders([
    { id: 'r1', text: 'Позже', dueAt: '2026-11-07T12:00:00.000Z', done: false },
    { id: 'r2', text: 'Просрочено', dueAt: '2026-11-07T09:00:00.000Z', done: false },
    { id: 'r3', text: 'Сделано', dueAt: '2026-11-07T08:00:00.000Z', done: true },
    { id: 'r4', text: 'Без даты' },
  ], { now });
  assert.equal(reminders.state, 'ok');
  assert.deepEqual(reminders.value.items.map((r) => r.id), ['r2', 'r1']);
  assert.equal(reminders.value.items[0].overdue, true);
  assert.equal(reminders.value.overdue, 1);
  assert.equal(data.reminders([], { now }).state, 'empty');
  assert.equal(data.reminders(null, { now }).state, 'empty');
  assert.equal(data.reminders([{}], { now }).state, 'empty');
  assert.equal(data.reminders('мусор', { now }).state, 'error');
});

test('новые типы: notes скрывает личное, downloads читает отчёт, mcp без секретов', () => {
  // notes: sensitive по умолчанию скрыты, их число честно показано.
  const notes = data.notes([
    { id: 'n1', text: 'Купить корм', kind: 'note', updatedAt: '2026-11-07T09:00:00.000Z' },
    { id: 'n2', text: 'Личное', sensitive: true },
    { id: 'n3', text: '' },
  ]);
  assert.equal(notes.state, 'ok');
  assert.deepEqual(notes.value.items.map((n) => n.id), ['n1']);
  assert.equal(notes.value.hiddenSensitive, 1);
  assert.deepEqual(notes.value.items[0].text, 'Купить корм');
  const withSensitive = data.notes([{ id: 'n2', text: 'Личное', sensitive: true }], { includeSensitive: true });
  assert.equal(withSensitive.state, 'ok');
  assert.equal(withSensitive.value.hiddenSensitive, 0);
  assert.equal(data.notes([]).state, 'empty');
  assert.equal(data.notes(null).state, 'empty');
  assert.equal(data.notes(5).state, 'error');

  // downloads: отчёт analyze() — настоящие числа; ошибка папки — error с причиной.
  const report = {
    ok: true,
    status: 'ok',
    folder: 'C:\\Users\\me\\Downloads',
    scanned: { files: 12, totalBytes: 5000 },
    candidates: [{ name: 'old.zip', size: 3000, ageDays: 40, reason: 'старый файл: 40 дн.' }],
    candidatesTotal: 3,
    candidateBytes: 4200,
    candidatesTruncated: true,
  };
  const dl = data.downloads(report);
  assert.equal(dl.state, 'ok');
  assert.equal(dl.value.fileCount, 12);
  assert.equal(dl.value.candidateCount, 3);
  assert.equal(dl.value.candidateBytes, 4200);
  assert.equal(dl.value.truncated, true);
  assert.deepEqual(dl.value.items.map((f) => f.name), ['old.zip']);
  // Папка с файлами, но без кандидатов — ok без выдуманного списка.
  const clean = data.downloads({ ok: true, status: 'ok', folder: 'D:\\Загрузки', scanned: { files: 2, totalBytes: 10 }, candidates: [], candidatesTotal: 0 });
  assert.equal(clean.state, 'ok');
  assert.deepEqual(clean.value.items, []);
  assert.equal(clean.value.fileCount, 2);
  // Пустая папка — empty.
  assert.equal(data.downloads({ ok: true, status: 'empty', folder: 'D:\\Загрузки', scanned: { files: 0, totalBytes: 0 }, candidates: [], candidatesTotal: 0 }).state, 'empty');
  // Список файлов, переданный напрямую, тоже честен.
  const list = data.downloads([{ name: 'a.iso', size: 2048, mtimeMs: Date.parse('2026-11-06T10:00:00Z') }], { now: Date.parse('2026-11-07T10:00:00Z') });
  assert.equal(list.state, 'ok');
  assert.equal(list.value.totalBytes, 2048);
  assert.equal(list.value.items[0].ageDays, 1);
  assert.equal(data.downloads(null).state, 'empty');
  assert.equal(data.downloads(false).state, 'error', 'не источник — честная ошибка, а не пустая папка');
  assert.equal(data.downloads('мусор').state, 'error');
  const denied = data.downloads({ ok: false, reason: 'not_found' });
  assert.equal(denied.state, 'error');
  assert.equal(denied.error, 'not_found');

  // mcp: имена и состояния сервисов; секретов в state нет — и здесь их нет.
  const mcp = data.mcp({
    servers: [
      { name: 'files', transport: 'stdio', target: 'npx', status: 'connected', toolCount: 2 },
      { name: 'github', transport: 'http', status: 'error', error: 'unauthorized' },
      { name: 'old', transport: 'stdio', status: 'disabled', disabled: true, toolCount: 0 },
    ],
  });
  assert.equal(mcp.state, 'ok');
  assert.equal(mcp.value.total, 3);
  assert.equal(mcp.value.connected, 1);
  assert.equal(mcp.value.errors, 1);
  assert.equal(data.mcp({ servers: [] }).state, 'empty');
  assert.equal(data.mcp(null).state, 'empty');
  assert.equal(data.mcp('мусор').state, 'error');
});

test('новости: ok/stale/empty/error, только http(s), лимит и источники', () => {
  const now = Date.parse('2026-11-07T10:00:00Z');
  const base = {
    ok: true,
    items: [
      { title: 'Марс', link: 'https://example.com/mars', date: '2026-11-07T09:00:00.000Z', summary: 'Кратко', source: 'NASA' },
      { title: 'Вторая', link: 'https://example.com/second', date: '2026-11-06T09:00:00.000Z', summary: '', source: null },
      { title: 'Без ссылки', link: 'javascript:alert(1)' },
      { title: 'Относительная', link: '/news/1' },
      { title: '   ', link: 'https://example.com/blank' },
    ],
    fetchedAt: now - 60 * 1000,
    sources: [{ url: 'https://feed.example/a', title: 'NASA' }],
  };
  const ok = data.news(base, { now });
  assert.equal(ok.state, 'ok');
  assert.deepEqual(ok.value.items.map((i) => i.title), ['Марс', 'Вторая']);
  assert.equal(ok.value.items[0].link, 'https://example.com/mars');
  assert.equal(ok.value.items[0].date, '2026-11-07T09:00:00.000Z');
  assert.equal(ok.value.total, 2);
  assert.equal(ok.value.sources.length, 1);
  // Лимит из config виджета.
  assert.equal(data.news(base, { now, limit: 1 }).value.items.length, 1);
  // Старое время кэша — stale с прежними записями, а не пустота.
  const byAge = data.news({ ...base, fetchedAt: now - 60 * 60 * 1000 }, { now });
  assert.equal(byAge.state, 'stale');
  assert.equal(byAge.value.items.length, 2);
  // Прямая пометка от источника тоже даёт stale.
  assert.equal(data.news({ ...base, stale: true }, { now }).state, 'stale');
  assert.equal(data.news({ ok: true, items: [] }, { now }).state, 'empty');
  assert.equal(data.news(null).state, 'empty');
  assert.equal(data.news('мусор').state, 'error');
  const failed = data.news({ ok: false, reason: 'timeout' }, { now });
  assert.equal(failed.state, 'error');
  assert.equal(failed.error, 'timeout');
});

test('питомец: всегда ok, фиксированные настроения, данных не читает', () => {
  const idle = data.pet();
  assert.equal(idle.state, 'ok');
  assert.equal(idle.type, 'pet');
  assert.equal(idle.value.mood, 'idle');
  assert.equal(idle.value.decorative, true);
  assert.deepEqual(idle.value.moods, ['idle', 'curious', 'sleepy']);
  assert.equal(data.pet('curious').value.mood, 'curious');
  assert.equal(data.pet('что-то').value.mood, 'idle', 'неизвестное настроение не выдумывается');
  assert.equal(data.pet('спать').value.mood, 'idle');
  // Даже «битый» источник не даёт ошибку: питомец — украшение, а не показатель.
  assert.equal(data.pet({ mood: 'sleepy' }).state, 'ok');
  assert.equal(data.pet(false).state, 'ok');
});

test('buildWidget: сборка по типу, одинаковый формат у всех, неизвестный тип падает', () => {
  const sources = {
    os: { cpus: [{ times: { user: 1, nice: 0, sys: 1, irq: 0, idle: 2 } }], totalmem: 100, freemem: 50 },
    tasks: [{ id: 't1', title: 'Задача', status: 'queued' }],
    reminders: [{ id: 'r1', text: 'Напоминание', dueAt: '2026-11-07T12:00:00.000Z' }],
    missions: [{ id: 'm1', goal: 'Миссия', enabled: true, nextRunAt: '2026-11-07T18:00:00.000Z' }],
    music: [{ query: 'Трек' }],
    weather: null,
    currency: { ok: true, rates: [{ code: 'USD', value: 82 }] },
    apps: { apps: { code: { launches: 1 } } },
    orb: 'idle',
    commands: [{ id: 'c1', name: 'Команда' }],
    goals: [{ id: 'g1', title: 'Цель', status: 'active', steps: [{ status: 'done' }] }],
    notes: [{ id: 'n1', text: 'Запись', kind: 'note' }],
    downloads: [{ name: 'файл.zip', size: 1024, mtimeMs: Date.parse('2026-11-01T00:00:00Z') }],
    mcp: { servers: [{ name: 'files', transport: 'stdio', status: 'connected', toolCount: 2 }] },
    news: {
      ok: true,
      items: [{ title: 'Новость', link: 'https://example.com/news', date: '2026-11-07T09:00:00.000Z', summary: 'Кратко', source: 'NASA' }],
      fetchedAt: Date.parse('2026-11-07T10:00:00Z'),
    },
  };
  for (const type of data.DATA_TYPES) {
    const result = data.buildWidget(type, sources);
    assertWidgetResult(result);
    assert.equal(result.type, type);
    assert.notEqual(result.state, 'error', `${type} не должен ломаться на настоящих данных`);
    // Питомец — единственный виджет без источника: state всегда ok.
    if (type === 'pet') assert.equal(result.state, 'ok');
  }
  // Источники не переданного типа дают честный empty, а не выдуманные числа.
  for (const type of ['goals', 'missions', 'reminders', 'notes', 'downloads', 'mcp', 'news']) {
    assert.equal(data.buildWidget(type, {}).state, 'empty');
  }
  assert.throws(() => data.buildWidget('holodeck', sources), /неизвестный тип/);
});

test('buildDeskData: данные по id виджетов, ошибка одного типа не рушит остальные, источники не меняются', () => {
  const desk = {
    id: uuid(1),
    name: 'Проверка',
    template: 'empty',
    version: 1,
    widgets: [
      { id: uuid(2), type: 'tasks', version: 1, x: 1, y: 1, w: 6, h: 4, config: { limit: 2 } },
      { id: uuid(3), type: 'orb', version: 1, x: 7, y: 1, w: 6, h: 4, config: {} },
      { id: uuid(4), type: 'holodeck', version: 1, x: 1, y: 5, w: 4, h: 2, config: {} },
      { id: uuid(5), type: 'pet', version: 1, x: 5, y: 5, w: 4, h: 2, config: {} },
    ],
  };
  const sources = {
    tasks: [
      { id: 't1', title: 'Первая', status: 'queued' },
      { id: 't2', title: 'Вторая', status: 'running' },
      { id: 't3', title: 'Третья', status: 'paused' },
    ],
    orb: 'idle',
  };
  const snapshot = JSON.stringify(sources);
  const values = data.buildDeskData(desk, sources, { now: Date.parse('2026-11-07T10:00:00Z') });
  assert.deepEqual(Object.keys(values).sort(), [uuid(2), uuid(3), uuid(4), uuid(5)].sort());
  assert.equal(values[uuid(2)].state, 'ok');
  assert.equal(values[uuid(2)].value.items.length, 2, 'limit из config виджета применён');
  assert.equal(values[uuid(3)].state, 'ok');
  assert.equal(values[uuid(4)].state, 'error');
  assert.equal(values[uuid(4)].error, 'bad_type');
  assert.equal(values[uuid(5)].state, 'ok', 'питомец не зависит от источников');
  assert.equal(JSON.stringify(sources), snapshot, 'источники не изменены');
  assert.equal(desk.widgets.length, 4, 'стол не изменён');
  assert.throws(() => data.buildDeskData(null, sources), /нужен объект с виджетами/);
});
