'use strict';

// Хранилище «Рабочих столов»: файл NOX_DATA_DIR/desks.json.
//
// Столы НЕ дублируют пространства (src/workspaces/book.js): пространство — контекст
// (файлы, память, команды), стол — раскладка виджетов внутри пространства. В этом файле
// хранятся только раскладки по пространствам; сами данные виджетов сюда не пишутся.
//
// Схема файла (версия 1):
// {
//   "version": 1,
//   "spaces": {
//     "default": {
//       "activeId": "<uuid стола>",
//       "desks": [
//         {
//           "id": "<uuid>", "name": "Работа", "template": "work", "version": 1,
//           "widgets": [{ "id": "<uuid>", "type": "tasks", "version": 1,
//                         "x": 1, "y": 1, "w": 4, "h": 5, "config": { } }]
//         }
//       ]
//     }
//   }
// }
// Порядок столов — порядок массива desks (он же порядок вкладок).
//
// Правила:
// - запись атомарная (src/config/atomic.js): временный файл рядом, затем переименование;
// - битый JSON или неверная структура → пустое состояние, исходные байты сохраняются
//   рядом как desks.json.corrupt (не теряем данные молча);
// - более новая версия схемы → отказ (файл не трогаем), чтобы новое приложение не
//   перезаписало данные будущего формата;
// - старая версия (без version или version 0) мигрирует в памяти и сохраняется в новом
//   виде при первой записи; данные столов при миграции сохраняются;
// - лимиты: <= 12 столов на пространство, <= 24 виджетов на стол, имя <= 40 символов;
// - id — только UUID v4, workspaceId — «default» или UUID v4; координаты — сетка 12×12,
//   виджеты не накладываются друг на друга (наложение отклоняется до записи).
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { writeFileAtomic } = require('../config/atomic');
const {
  GRID, LIMITS, CONFIG_SCHEMA, TEMPLATE_IDS, template, templateWidgets,
  isWidgetType, widgetType,
} = require('./templates');

const SCHEMA_VERSION = 1;
const DESK_VERSION = 1;
const WIDGET_VERSION = 1;
const MAX_DESKS = LIMITS.desksPerSpace;
const MAX_WIDGETS = LIMITS.widgetsPerDesk;
const MAX_NAME = LIMITS.nameLength;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_ID = /^(default|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readId(value, what) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${what}: неверный id`);
  return value;
}

function readWorkspaceId(value) {
  if (value === undefined || value === null) throw new Error('workspaceId: неверное пространство');
  if (typeof value !== 'string' || !WORKSPACE_ID.test(value)) throw new Error('workspaceId: неверное пространство');
  return value;
}

// Название стола: 1..40 символов, без управляющих символов, пробелы схлопнуты.
// Считаем кодовые точки, чтобы эмодзи не обрезался посередине.
function readName(value, what = 'название стола') {
  if (typeof value !== 'string') throw new Error(`нужно ${what}`);
  const name = value.trim().replace(/\s+/g, ' ');
  const length = Array.from(name).length;
  if (!length || length > MAX_NAME || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${what}: от 1 до ${MAX_NAME} символов`);
  }
  return name;
}

function readInt(value, what, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${what}: целое от ${min} до ${max}`);
  }
  return value;
}

// Параметры виджета: только известные типу ключи, только простые значения.
// Неизвестный ключ — ошибка: config не должен становиться свалкой произвольного JSON.
function normalizeConfig(type, config) {
  const schema = CONFIG_SCHEMA[type];
  if (!schema) throw new Error(`неизвестный тип виджета: ${type}`);
  const source = config === undefined || config === null ? {} : config;
  if (!isPlainObject(source)) throw new Error('config виджета: нужен объект');
  const keys = Object.keys(source);
  if (keys.length > LIMITS.configKeys) throw new Error(`config виджета: не больше ${LIMITS.configKeys} ключей`);
  const out = {};
  for (const key of keys) {
    const rule = schema[key];
    if (!rule) throw new Error(`config виджета «${type}»: неизвестный ключ «${key}»`);
    const value = source[key];
    if (rule.kind === 'enum') {
      if (!rule.values.includes(value)) throw new Error(`config «${type}.${key}»: допустимо ${rule.values.join(', ')}`);
      out[key] = value;
    } else if (rule.kind === 'int') {
      out[key] = readInt(value, `config «${type}.${key}»`, rule.min, rule.max);
    } else if (rule.kind === 'codes') {
      if (!Array.isArray(value) || value.length < rule.min || value.length > rule.max) {
        throw new Error(`config «${type}.${key}»: от ${rule.min} до ${rule.max} кодов`);
      }
      const codes = [];
      for (const raw of value) {
        if (typeof raw !== 'string') throw new Error(`config «${type}.${key}»: код валюты — строка`);
        const code = raw.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(code)) throw new Error(`config «${type}.${key}»: код валюты из трёх латинских букв`);
        if (!codes.includes(code)) codes.push(code);
      }
      if (!codes.length) throw new Error(`config «${type}.${key}»: нужен хотя бы один код`);
      out[key] = codes;
    }
  }
  return out;
}

// Пределы одного виджета: прямоугольник обязан целиком лежать в сетке.
function checkRect({ x, y, w, h }) {
  readInt(x, 'x', 1, GRID.cols);
  readInt(y, 'y', 1, GRID.rows);
  readInt(w, 'w', 1, GRID.cols);
  readInt(h, 'h', GRID.minH, GRID.maxH);
  if (x + w - 1 > GRID.cols) throw new Error('виджет выходит за правый край сетки');
  if (y + h - 1 > GRID.rows) throw new Error('виджет выходит за нижний край сетки');
  return { x, y, w, h };
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Первое свободное место для виджета w×h: сверху вниз, слева направо.
// null — места нет; вызывающий решает, ошибка это или нет.
function findFreeSpot(widgets, w, h) {
  readInt(w, 'w', 1, GRID.cols);
  readInt(h, 'h', GRID.minH, GRID.maxH);
  const placed = Array.isArray(widgets) ? widgets : [];
  for (let y = 1; y + h - 1 <= GRID.rows; y += 1) {
    for (let x = 1; x + w - 1 <= GRID.cols; x += 1) {
      const probe = { x, y, w, h };
      if (placed.every((item) => !overlaps(probe, item))) return { x, y };
    }
  }
  return null;
}

// Приводит виджет к схеме {id,type,version,x,y,w,h,config}.
// assignId — выдать id, если его нет (добавление из сетки); stored — id обязателен.
// x/y могут отсутствовать: тогда место подберёт раскладка (auto).
function normalizeWidget(input, { newId, assignId = false } = {}) {
  if (!isPlainObject(input)) throw new Error('виджет: нужен объект');
  const type = input.type;
  if (!isWidgetType(type)) throw new Error(`неизвестный тип виджета: ${JSON.stringify(type)}`);
  const defaults = widgetType(type);
  let id;
  if (input.id === undefined || input.id === null) {
    if (!assignId) throw new Error('виджет: нет id');
    if (typeof newId !== 'function') throw new Error('нужна функция выдачи id');
    id = readId(newId(), 'виджет');
  } else {
    id = readId(input.id, 'виджет');
  }
  const version = input.version === undefined ? WIDGET_VERSION : input.version;
  if (version !== WIDGET_VERSION) throw new Error(`виджет: неподдерживаемая версия схемы ${JSON.stringify(version)}`);
  const w = input.w === undefined ? defaults.defaultW : readInt(input.w, 'w', 1, GRID.cols);
  const h = input.h === undefined ? defaults.defaultH : readInt(input.h, 'h', GRID.minH, GRID.maxH);
  const x = input.x === undefined || input.x === null ? null : readInt(input.x, 'x', 1, GRID.cols);
  const y = input.y === undefined || input.y === null ? null : readInt(input.y, 'y', 1, GRID.rows);
  if ((x === null) !== (y === null)) throw new Error('виджет: x и y задаются вместе');
  if (x !== null) checkRect({ x, y, w, h });
  return { id, type, version, x, y, w, h, config: normalizeConfig(type, input.config) };
}

// Раскладка: проверяет все прямоугольники и не даёт виджетам накладываться.
// Порядок массива сохраняется; виджет без координат ставится в первое свободное место.
function layoutWidgets(input, { newId, assignId = true, requireRect = false } = {}) {
  if (!Array.isArray(input)) throw new Error('виджеты: нужен массив');
  if (input.length > MAX_WIDGETS) throw new Error(`на столе не больше ${MAX_WIDGETS} виджетов`);
  const placed = [];
  const ids = new Set();
  for (const raw of input) {
    const widget = normalizeWidget(raw, { newId, assignId });
    if (ids.has(widget.id)) throw new Error('виджет с таким id уже есть на столе');
    ids.add(widget.id);
    if (requireRect && (widget.x === null || widget.y === null)) throw new Error('виджет: нет координат');
    if (widget.x === null) {
      const spot = findFreeSpot(placed, widget.w, widget.h);
      if (!spot) throw new Error('в сетке стола нет свободного места');
      widget.x = spot.x;
      widget.y = spot.y;
    }
    for (const other of placed) {
      if (overlaps(widget, other)) throw new Error('виджеты накладываются друг на друга');
    }
    placed.push(widget);
  }
  return placed;
}

// --- чтение файла ---------------------------------------------------------

function emptyState() {
  return { version: SCHEMA_VERSION, spaces: {} };
}

// Проверка загруженного стола. Неверные данные — ошибка структуры: файл будет
// отложен как повреждённый, а состояние станет пустым (раскладка не стоит того,
// чтобы падать в цикле загрузки).
function readDesk(raw) {
  if (!isPlainObject(raw)) throw new Error('стол: нужен объект');
  const id = readId(raw.id, 'стол');
  const name = readName(raw.name);
  const templateId = raw.template;
  if (typeof templateId !== 'string' || !TEMPLATE_IDS.includes(templateId)) {
    throw new Error('стол: неизвестный шаблон');
  }
  const version = raw.version === undefined ? DESK_VERSION : raw.version;
  if (version !== DESK_VERSION) throw new Error('стол: неподдерживаемая версия схемы');
  const widgets = layoutWidgets(raw.widgets, { newId: null, assignId: false, requireRect: true });
  return { id, name, template: templateId, version, widgets };
}

function readSpace(raw) {
  if (!isPlainObject(raw)) throw new Error('пространство столов: нужен объект');
  const desks = raw.desks;
  if (!Array.isArray(desks) || desks.length > MAX_DESKS) throw new Error('столы: неверный список');
  const ids = new Set();
  const names = new Set();
  const out = [];
  for (const item of desks) {
    const desk = readDesk(item);
    if (ids.has(desk.id)) throw new Error('столы: повторяющийся id');
    const lower = desk.name.toLocaleLowerCase();
    if (names.has(lower)) throw new Error('столы: повторяющееся название');
    ids.add(desk.id);
    names.add(lower);
    out.push(desk);
  }
  let activeId = raw.activeId === undefined ? (out[0] ? out[0].id : null) : raw.activeId;
  if (activeId === null && out.length) activeId = out[0].id;
  if (activeId !== null && !ids.has(activeId)) throw new Error('activeId: стол не найден');
  return { activeId, desks: out };
}

class DesksStore {
  // dataDir — абсолютный путь к папке данных (NOX_DATA_DIR), file — прямой путь к desks.json.
  // now и newId внедряются в тестах; по умолчанию Date.now и randomUUID.
  constructor({ dataDir, file, now = Date.now, newId = randomUUID } = {}) {
    let target;
    if (file !== undefined) {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('нужен абсолютный путь к файлу столов');
      target = path.resolve(file);
    } else {
      if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('нужна абсолютная папка данных');
      target = path.join(path.resolve(dataDir), 'desks.json');
    }
    if (typeof now !== 'function') throw new Error('now: нужна функция времени');
    if (typeof newId !== 'function') throw new Error('newId: нужна функция выдачи id');
    this.file = target;
    this.dir = path.dirname(target);
    this.now = now;
    this.newId = newId;
  }

  // --- служебное ---------------------------------------------------------

  _empty() {
    return emptyState();
  }

  // Битый/непонятный файл: сохраняем исходные байты рядом (один раз) и отдаём пустое
  // состояние. Так владелец может вручную достать старую раскладку, а приложение не падает.
  _quarantine() {
    const backup = `${this.file}.corrupt`;
    try {
      if (fs.existsSync(this.file) && !fs.existsSync(backup)) fs.copyFileSync(this.file, backup);
    } catch {
      // Копия — удобство, а не условие работы: без неё просто начинаем с пустого стола.
    }
    return this._empty();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return this._empty();
      throw err;
    }
    if (raw.trim() === '') return this._empty();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return this._quarantine();
    }
    if (!isPlainObject(data)) return this._quarantine();
    const version = data.version;
    if (version !== undefined) {
      if (!Number.isInteger(version) || version < 0) throw new Error('файл столов: версия схемы не распознана');
      if (version > SCHEMA_VERSION) {
        throw new Error(`файл столов создан более новой версией схемы (${version}); обновите приложение`);
      }
    }
    try {
      return this._normalize(data);
    } catch {
      return this._quarantine();
    }
  }

  // Миграция: версия 1 — как есть; версия 0 или без version — та же структура либо
  // старый «плоский» вид { workspaceId: {activeId, desks} }. Новые данные при миграции
  // не придумываются: переносим только то, что было, и проверяем схему.
  _normalize(data) {
    let spaces = null;
    if (isPlainObject(data.spaces)) spaces = data.spaces;
    else if (data.version === undefined && isPlainObject(data) && !('spaces' in data)) spaces = data;
    if (!spaces) throw new Error('файл столов: неизвестный формат');
    const out = {};
    for (const spaceId of Object.keys(spaces)) {
      readWorkspaceId(spaceId);
      out[spaceId] = readSpace(spaces[spaceId]);
    }
    return { version: SCHEMA_VERSION, spaces: out };
  }

  _save(state) {
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }

  _entry(state, workspaceId) {
    const space = readWorkspaceId(workspaceId);
    return { state, space, entry: isPlainObject(state.spaces[space]) ? state.spaces[space] : null };
  }

  _deskOf(entry, deskId) {
    const id = readId(deskId, 'стол');
    if (!entry) return null;
    return entry.desks.find((item) => item.id === id) || null;
  }

  _widgetOf(desk, widgetId) {
    const id = readId(widgetId, 'виджет');
    return desk.widgets.find((item) => item.id === id) || null;
  }

  // --- чтение ------------------------------------------------------------

  list(workspaceId) {
    const { entry } = this._entry(this._load(), workspaceId);
    return entry ? entry.desks.map(clone) : [];
  }

  active(workspaceId) {
    const { entry } = this._entry(this._load(), workspaceId);
    if (!entry || !entry.desks.length) return null;
    return entry.desks.find((item) => item.id === entry.activeId) || null;
  }

  // Состояние пространства для IPC: список столов и активный стол.
  state(workspaceId) {
    const { entry } = this._entry(this._load(), workspaceId);
    return {
      workspaceId,
      desks: entry ? entry.desks.map(clone) : [],
      activeId: entry ? entry.activeId : null,
    };
  }

  get(workspaceId, deskId) {
    const { entry } = this._entry(this._load(), workspaceId);
    const desk = this._deskOf(entry, deskId);
    return desk ? clone(desk) : null;
  }

  // Первый стол пространства, если его ещё нет: пустой шаблон, чтобы экран не был
  // «пустым навсегда». Возвращает {desks, activeId, created}.
  ensure(workspaceId, { template: templateId = 'empty', name } = {}) {
    const data = this._load();
    const { state, space, entry } = this._entry(data, workspaceId);
    if (entry && entry.desks.length) {
      const active = entry.desks.find((item) => item.id === entry.activeId) || entry.desks[0];
      if (entry.activeId !== active.id) {
        entry.activeId = active.id;
        this._save(state);
      }
      return { workspaceId: space, desks: entry.desks.map(clone), activeId: entry.activeId, created: false };
    }
    const desk = this._createDesk(state, space, { name, template: templateId });
    this._save(state);
    return { workspaceId: space, desks: [clone(desk)], activeId: desk.id, created: true };
  }

  // --- столы -------------------------------------------------------------

  _checkName(entry, name, skipId = null) {
    const lower = name.toLocaleLowerCase();
    if (entry && entry.desks.some((item) => item.id !== skipId && item.name.toLocaleLowerCase() === lower)) {
      throw new Error('стол с таким названием уже есть');
    }
    return name;
  }

  _createDesk(state, space, { name, template: templateId = 'empty' } = {}) {
    const spec = template(templateId);
    const entry = isPlainObject(state.spaces[space]) ? state.spaces[space] : { activeId: null, desks: [] };
    if (entry.desks.length >= MAX_DESKS) throw new Error(`в пространстве не больше ${MAX_DESKS} столов`);
    const clean = this._checkName(entry, name === undefined || name === null ? spec.title : readName(name));
    const widgets = layoutWidgets(templateWidgets(templateId, { newId: this.newId }), { newId: this.newId });
    const desk = { id: readId(this.newId(), 'стол'), name: clean, template: spec.id, version: DESK_VERSION, widgets };
    state.spaces[space] = { activeId: desk.id, desks: [...entry.desks, desk] };
    return desk;
  }

  create(workspaceId, { name, template: templateId = 'empty' } = {}) {
    const data = this._load();
    const { state, space } = this._entry(data, workspaceId);
    const desk = this._createDesk(state, space, { name, template: templateId });
    this._save(state);
    return clone(desk);
  }

  rename(workspaceId, deskId, name) {
    const data = this._load();
    const { state, entry } = this._entry(data, workspaceId);
    const desk = this._deskOf(entry, deskId);
    if (!desk) throw new Error('стол не найден');
    desk.name = this._checkName(entry, readName(name), desk.id);
    this._save(state);
    return clone(desk);
  }

  // Удаление последнего стола запрещено: вкладок не должно стать ноль.
  // Если удалили активный — активным становится соседний (предыдущий, иначе следующий).
  remove(workspaceId, deskId) {
    const data = this._load();
    const { state, entry } = this._entry(data, workspaceId);
    const desk = this._deskOf(entry, deskId);
    if (!desk) throw new Error('стол не найден');
    if (entry.desks.length <= 1) throw new Error('нельзя удалить единственный стол');
    const index = entry.desks.findIndex((item) => item.id === desk.id);
    entry.desks = entry.desks.filter((item) => item.id !== desk.id);
    if (entry.activeId === desk.id) {
      entry.activeId = entry.desks[Math.max(0, index - 1)].id;
    }
    this._save(state);
    return { removed: true, activeId: entry.activeId };
  }

  select(workspaceId, deskId) {
    const data = this._load();
    const { state, entry } = this._entry(data, workspaceId);
    const desk = this._deskOf(entry, deskId);
    if (!desk) throw new Error('стол не найден');
    entry.activeId = desk.id;
    this._save(state);
    return clone(desk);
  }

  // Порядок вкладок: index — новое место 0..len-1.
  reorder(workspaceId, deskId, index) {
    const data = this._load();
    const { state, entry } = this._entry(data, workspaceId);
    const desk = this._deskOf(entry, deskId);
    if (!desk) throw new Error('стол не найден');
    const from = entry.desks.findIndex((item) => item.id === desk.id);
    const to = readInt(index, 'index', 0, entry.desks.length - 1);
    const [moved] = entry.desks.splice(from, 1);
    entry.desks.splice(to, 0, moved);
    this._save(state);
    return entry.desks.map(clone);
  }

  // --- виджеты -----------------------------------------------------------

  _deskForWrite(data, workspaceId, deskId) {
    const { state, entry } = this._entry(data, workspaceId);
    const desk = this._deskOf(entry, deskId);
    if (!desk) throw new Error('стол не найден');
    return { state, entry, desk };
  }

  // Полная замена раскладки: используется восстановлением/отменой и сохранением из рендерера.
  setWidgets(workspaceId, deskId, widgets) {
    const data = this._load();
    const { state, desk } = this._deskForWrite(data, workspaceId, deskId);
    desk.widgets = layoutWidgets(widgets, { newId: this.newId });
    this._save(state);
    return { desk: clone(desk) };
  }

  // Добавление из сетки: без x/y место подбирается автоматически.
  addWidget(workspaceId, deskId, input) {
    const data = this._load();
    const { state, desk } = this._deskForWrite(data, workspaceId, deskId);
    if (desk.widgets.length >= MAX_WIDGETS) throw new Error(`на столе не больше ${MAX_WIDGETS} виджетов`);
    let placed;
    try {
      placed = layoutWidgets([...desk.widgets, input], { newId: this.newId });
    } catch (err) {
      // Добавляли один виджет: если места нет, сообщаем это понятной фразой.
      if (/свободного места/.test(err.message)) throw new Error('в сетке стола нет свободного места для виджета такого размера');
      throw err;
    }
    // layoutWidgets сохраняет порядок и не трогает старые прямоугольники,
    // поэтому новый виджет — последний в списке.
    desk.widgets = placed;
    const widget = placed[placed.length - 1];
    this._save(state);
    return { desk: clone(desk), widget: clone(widget) };
  }

  _replaceWidget(state, desk, widgetId, patch, { rect = false, config = false } = {}) {
    const current = this._widgetOf(desk, widgetId);
    if (!current) throw new Error('виджет не найден');
    const next = clone(current);
    if (rect) {
      if (patch.x !== undefined) next.x = readInt(patch.x, 'x', 1, GRID.cols);
      if (patch.y !== undefined) next.y = readInt(patch.y, 'y', 1, GRID.rows);
      if (patch.w !== undefined) next.w = readInt(patch.w, 'w', 1, GRID.cols);
      if (patch.h !== undefined) next.h = readInt(patch.h, 'h', GRID.minH, GRID.maxH);
      checkRect(next);
      for (const other of desk.widgets) {
        if (other.id !== next.id && overlaps(next, other)) throw new Error('место занято: виджеты накладываются');
      }
    }
    if (config) next.config = normalizeConfig(next.type, patch.config);
    desk.widgets = desk.widgets.map((item) => (item.id === next.id ? next : item));
    this._save(state);
    return { desk: clone(desk), widget: clone(next) };
  }

  moveWidget(workspaceId, deskId, widgetId, x, y) {
    const data = this._load();
    const { state, desk } = this._deskForWrite(data, workspaceId, deskId);
    return this._replaceWidget(state, desk, widgetId, { x, y }, { rect: true });
  }

  resizeWidget(workspaceId, deskId, widgetId, w, h) {
    const data = this._load();
    const { state, desk } = this._deskForWrite(data, workspaceId, deskId);
    return this._replaceWidget(state, desk, widgetId, { w, h }, { rect: true });
  }

  // patch: {x?, y?, w?, h?, config?}. Тип и id виджета не меняются.
  updateWidget(workspaceId, deskId, widgetId, patch = {}) {
    if (!isPlainObject(patch)) throw new Error('правка виджета: нужен объект полей');
    const allowed = ['x', 'y', 'w', 'h', 'config'];
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) throw new Error(`правка виджета: нельзя менять «${key}»`);
    }
    const data = this._load();
    const { state, desk } = this._deskForWrite(data, workspaceId, deskId);
    const rect = ['x', 'y', 'w', 'h'].some((key) => patch[key] !== undefined);
    return this._replaceWidget(state, desk, widgetId, patch, { rect, config: 'config' in patch });
  }

  removeWidget(workspaceId, deskId, widgetId) {
    const data = this._load();
    const { state, desk } = this._deskForWrite(data, workspaceId, deskId);
    const widget = this._widgetOf(desk, widgetId);
    if (!widget) throw new Error('виджет не найден');
    desk.widgets = desk.widgets.filter((item) => item.id !== widget.id);
    this._save(state);
    return { desk: clone(desk), removedId: widget.id };
  }
}

module.exports = {
  DesksStore,
  SCHEMA_VERSION,
  DESK_VERSION,
  WIDGET_VERSION,
  MAX_DESKS,
  MAX_WIDGETS,
  MAX_NAME,
  GRID,
  LIMITS,
  normalizeWidget,
  normalizeConfig,
  layoutWidgets,
  checkRect,
  overlaps,
  findFreeSpot,
  readName,
  readWorkspaceId,
  emptyState,
};
