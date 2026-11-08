'use strict';

// Каталог виджетов и шаблоны столов для «Рабочих столов».
// Стол — это раскладка виджетов внутри пространства. Пространство (src/workspaces/) остаётся
// контекстом файлов, памяти и команд; здесь его данные не дублируются и не меняются.
//
// Модуль чистый: ни диска, ни сети. Шаблон — только описание раскладки; id виджетов выдаёт
// хранилище (store.js) при создании стола, чтобы шаблон можно было применить много раз.
//
// Сетка: 12 колонок и 12 рядов, координаты 1..12 (левый верхний угол — 1,1), ширина 1..12,
// высота 1..6, виджет обязан целиком лежать в сетке: x + w - 1 <= 12, y + h - 1 <= 12.

const GRID = Object.freeze({ cols: 12, rows: 12, maxH: 6, minH: 1 });

// Пределы, которые проверяет хранилище. Здесь они лежат рядом с каталогом, чтобы тесты
// и рендерер брали одни и те же числа, а не повторяли их.
const LIMITS = Object.freeze({
  desksPerSpace: 12,
  widgetsPerDesk: 24,
  nameLength: 40,
  configKeys: 12,
  configStringLength: 200,
  configDepth: 2,
});

// Типы виджетов. Источник данных у каждого — настоящий модуль приложения:
//   tasks    — очередь задач (src/tasks/queue.js, runtime.queue.list());
//   today    — напоминания и миссии на сегодня (src/schedule/store.js, src/missions/store.js);
//   music    — история музыки (data/music-history.json, readMusicHistory);
//   weather  — кэш open-meteo (src/weather/open-meteo.js), без города не показывает цифры;
//   currency — курс ЦБ (src/currency/rates.js, кэш 15 минут);
//   system   — снимок os (загрузка ЦП и память);
//   apps     — чем пользуется владелец (src/inventory/usage.js);
//   orb      — состояние шара/аватара (renderer/orb.js, состояния без выдуманных значений);
//   commands — список своих команд (src/commands/store.js) как быстрый запуск;
//   goals    — активные цели (src/goals/store.js, list({status:'active'}));
//   missions — фоновые задачи (src/missions/store.js, list());
//   reminders — невыполненные напоминания (src/schedule/store.js, list());
//   notes    — записи памяти (src/memory/store.js, list()), личные скрываются;
//   downloads — отчёт о папке загрузок (src/extensions/downloads-cleanup.js, analyze);
//   mcp      — подключённые MCP-сервисы (src/mcp/client.js, mcpManager.state());
//   news     — новости из RSS (src/news/rss.js, fetchNews; кэш 30 минут);
//   pet      — декоративная анимация: данных нет, «показаний» нет.
// Типов «финансы» и «умный дом» здесь нет: у них нет настоящих источников,
// а выдумывать данные запрещено продуктовыми правилами.
const WIDGET_TYPES = Object.freeze([
  Object.freeze({ id: 'tasks', title: 'Задачи', defaultW: 6, defaultH: 4 }),
  Object.freeze({ id: 'today', title: 'Сегодня', defaultW: 6, defaultH: 4 }),
  Object.freeze({ id: 'music', title: 'Музыка', defaultW: 6, defaultH: 4 }),
  Object.freeze({ id: 'weather', title: 'Погода', defaultW: 4, defaultH: 2 }),
  Object.freeze({ id: 'currency', title: 'Курсы валют', defaultW: 4, defaultH: 3 }),
  Object.freeze({ id: 'system', title: 'Компьютер', defaultW: 4, defaultH: 3 }),
  Object.freeze({ id: 'apps', title: 'Программы', defaultW: 4, defaultH: 3 }),
  Object.freeze({ id: 'orb', title: 'Аватар', defaultW: 12, defaultH: 6 }),
  Object.freeze({ id: 'commands', title: 'Команды', defaultW: 6, defaultH: 3 }),
  Object.freeze({ id: 'goals', title: 'Цели', defaultW: 6, defaultH: 4 }),
  Object.freeze({ id: 'missions', title: 'Миссии', defaultW: 6, defaultH: 4 }),
  Object.freeze({ id: 'reminders', title: 'Напоминания', defaultW: 6, defaultH: 4 }),
  Object.freeze({ id: 'notes', title: 'Заметки', defaultW: 6, defaultH: 4 }),
  Object.freeze({ id: 'downloads', title: 'Загрузки', defaultW: 6, defaultH: 4 }),
  Object.freeze({ id: 'mcp', title: 'MCP', defaultW: 6, defaultH: 4 }),
  Object.freeze({ id: 'news', title: 'Новости', defaultW: 4, defaultH: 3 }),
  Object.freeze({ id: 'pet', title: 'Питомец', defaultW: 4, defaultH: 3 }),
]);

const WIDGET_BY_ID = new Map(WIDGET_TYPES.map((item) => [item.id, item]));

// Схема параметров виджета: какие ключи допустимы и какого они вида.
// Неизвестный ключ отклоняется, а не сохраняется молча: иначе в config можно протащить
// произвольный JSON, который рендерер потом попытается показать.
const CONFIG_SCHEMA = Object.freeze({
  tasks: Object.freeze({
    filter: Object.freeze({ kind: 'enum', values: Object.freeze(['all', 'active', 'today']) }),
    limit: Object.freeze({ kind: 'int', min: 1, max: 50 }),
  }),
  today: Object.freeze({
    limit: Object.freeze({ kind: 'int', min: 1, max: 20 }),
  }),
  music: Object.freeze({}),
  weather: Object.freeze({}),
  currency: Object.freeze({
    codes: Object.freeze({ kind: 'codes', min: 1, max: 5 }),
  }),
  system: Object.freeze({}),
  apps: Object.freeze({
    limit: Object.freeze({ kind: 'int', min: 1, max: 30 }),
  }),
  orb: Object.freeze({}),
  commands: Object.freeze({
    limit: Object.freeze({ kind: 'int', min: 1, max: 20 }),
  }),
  goals: Object.freeze({
    limit: Object.freeze({ kind: 'int', min: 1, max: 20 }),
  }),
  missions: Object.freeze({
    limit: Object.freeze({ kind: 'int', min: 1, max: 20 }),
  }),
  reminders: Object.freeze({
    limit: Object.freeze({ kind: 'int', min: 1, max: 20 }),
  }),
  notes: Object.freeze({
    limit: Object.freeze({ kind: 'int', min: 1, max: 20 }),
  }),
  downloads: Object.freeze({
    limit: Object.freeze({ kind: 'int', min: 1, max: 10 }),
  }),
  mcp: Object.freeze({
    limit: Object.freeze({ kind: 'int', min: 1, max: 20 }),
  }),
  news: Object.freeze({
    limit: Object.freeze({ kind: 'int', min: 1, max: 20 }),
  }),
  pet: Object.freeze({}),
});

// Девять шаблонов: шесть прежних из видео 3 (00:34–00:50) и три новых — «Ночь»,
// «Разработка», «Стрим». Собраны только из существующих типов и настоящих источников.
// «Питомец» в шаблоне «Стрим» — декоративная анимация, а не показания прибора.
const TEMPLATES = Object.freeze({
  empty: Object.freeze({ id: 'empty', title: 'Пустой', widgets: Object.freeze([]) }),
  work: Object.freeze({
    id: 'work',
    title: 'Работа',
    widgets: Object.freeze([
      Object.freeze({ type: 'tasks', x: 1, y: 1, w: 4, h: 5, config: Object.freeze({ filter: 'active' }) }),
      Object.freeze({ type: 'today', x: 5, y: 1, w: 4, h: 5, config: Object.freeze({}) }),
      Object.freeze({ type: 'weather', x: 9, y: 1, w: 4, h: 2, config: Object.freeze({}) }),
      Object.freeze({ type: 'currency', x: 9, y: 3, w: 4, h: 3, config: Object.freeze({ codes: Object.freeze(['USD', 'EUR']) }) }),
      Object.freeze({ type: 'commands', x: 1, y: 6, w: 8, h: 3, config: Object.freeze({ limit: 10 }) }),
      Object.freeze({ type: 'system', x: 9, y: 6, w: 4, h: 3, config: Object.freeze({}) }),
      Object.freeze({ type: 'news', x: 9, y: 9, w: 4, h: 3, config: Object.freeze({ limit: 4 }) }),
    ]),
  }),
  study: Object.freeze({
    id: 'study',
    title: 'Учёба',
    widgets: Object.freeze([
      Object.freeze({ type: 'tasks', x: 1, y: 1, w: 6, h: 4, config: Object.freeze({ filter: 'active' }) }),
      Object.freeze({ type: 'today', x: 7, y: 1, w: 6, h: 4, config: Object.freeze({}) }),
      Object.freeze({ type: 'music', x: 1, y: 5, w: 6, h: 4, config: Object.freeze({}) }),
      Object.freeze({ type: 'apps', x: 7, y: 5, w: 6, h: 4, config: Object.freeze({ limit: 8 }) }),
    ]),
  }),
  games: Object.freeze({
    id: 'games',
    title: 'Игры',
    widgets: Object.freeze([
      Object.freeze({ type: 'system', x: 1, y: 1, w: 6, h: 3, config: Object.freeze({}) }),
      Object.freeze({ type: 'apps', x: 7, y: 1, w: 6, h: 3, config: Object.freeze({ limit: 8 }) }),
      Object.freeze({ type: 'music', x: 1, y: 4, w: 6, h: 4, config: Object.freeze({}) }),
    ]),
  }),
  media: Object.freeze({
    id: 'media',
    title: 'Медиа',
    widgets: Object.freeze([
      Object.freeze({ type: 'music', x: 1, y: 1, w: 8, h: 5, config: Object.freeze({}) }),
      Object.freeze({ type: 'apps', x: 9, y: 1, w: 4, h: 3, config: Object.freeze({ limit: 6 }) }),
      Object.freeze({ type: 'system', x: 9, y: 4, w: 4, h: 2, config: Object.freeze({}) }),
    ]),
  }),
  avatar: Object.freeze({
    id: 'avatar',
    title: 'Только аватар',
    widgets: Object.freeze([
      Object.freeze({ type: 'orb', x: 1, y: 1, w: 12, h: 6, config: Object.freeze({}) }),
    ]),
  }),
  // Тихий вечер: состояние компьютера, шар и ближайшие напоминания.
  night: Object.freeze({
    id: 'night',
    title: 'Ночь',
    widgets: Object.freeze([
      Object.freeze({ type: 'system', x: 1, y: 1, w: 6, h: 3, config: Object.freeze({}) }),
      Object.freeze({ type: 'orb', x: 7, y: 1, w: 6, h: 3, config: Object.freeze({}) }),
      Object.freeze({ type: 'reminders', x: 1, y: 4, w: 12, h: 4, config: Object.freeze({ limit: 8 }) }),
    ]),
  }),
  // Разработка: задачи, команды, снимок компьютера и записи памяти.
  dev: Object.freeze({
    id: 'dev',
    title: 'Разработка',
    widgets: Object.freeze([
      Object.freeze({ type: 'tasks', x: 1, y: 1, w: 6, h: 4, config: Object.freeze({ filter: 'active' }) }),
      Object.freeze({ type: 'commands', x: 7, y: 1, w: 6, h: 4, config: Object.freeze({ limit: 10 }) }),
      Object.freeze({ type: 'system', x: 1, y: 5, w: 6, h: 3, config: Object.freeze({}) }),
      Object.freeze({ type: 'notes', x: 7, y: 5, w: 6, h: 3, config: Object.freeze({ limit: 6 }) }),
      Object.freeze({ type: 'news', x: 1, y: 8, w: 4, h: 3, config: Object.freeze({ limit: 4 }) }),
    ]),
  }),
  // Стрим: музыка, программы, компьютер и питомец-анимация.
  stream: Object.freeze({
    id: 'stream',
    title: 'Стрим',
    widgets: Object.freeze([
      Object.freeze({ type: 'music', x: 1, y: 1, w: 8, h: 4, config: Object.freeze({}) }),
      Object.freeze({ type: 'apps', x: 9, y: 1, w: 4, h: 4, config: Object.freeze({ limit: 6 }) }),
      Object.freeze({ type: 'system', x: 1, y: 5, w: 8, h: 3, config: Object.freeze({}) }),
      Object.freeze({ type: 'pet', x: 9, y: 5, w: 4, h: 3, config: Object.freeze({}) }),
    ]),
  }),
});

const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

function isWidgetType(type) {
  return typeof type === 'string' && WIDGET_BY_ID.has(type);
}

function widgetType(type) {
  return WIDGET_BY_ID.get(type) || null;
}

// Список для мастера нового стола: id и название в порядке объявления.
function templateList() {
  return TEMPLATE_IDS.map((id) => ({ id, title: TEMPLATES[id].title }));
}

// Шаблон по id. Неизвестный id — ошибка, а не молчаливый пустой стол:
// иначе опечатка в IPC выглядела бы как «шаблон пустой, так и задумано».
function template(id) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(TEMPLATES, id)) {
    throw new Error('неизвестный шаблон стола');
  }
  return TEMPLATES[id];
}

// Материализует виджеты шаблона: выдаёт id и версию схемы, config копирует.
// newId — внедряемая функция (в тестах предсказуемые id, в приложении randomUUID).
function templateWidgets(id, { newId } = {}) {
  const source = template(id);
  if (typeof newId !== 'function') throw new Error('нужна функция выдачи id');
  return source.widgets.map((widget) => ({
    id: newId(),
    type: widget.type,
    version: 1,
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.h,
    config: JSON.parse(JSON.stringify(widget.config || {})),
  }));
}

module.exports = {
  GRID,
  LIMITS,
  WIDGET_TYPES,
  CONFIG_SCHEMA,
  TEMPLATES,
  TEMPLATE_IDS,
  isWidgetType,
  widgetType,
  templateList,
  template,
  templateWidgets,
};
