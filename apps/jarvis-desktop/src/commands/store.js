'use strict';

// Пользовательские команды: именованная последовательность шагов {tool, args},
// которую можно вызвать фразой. Один JSON-файл вида {"items": [...]}.
// Каждая операция читает файл заново; повреждённый файл не перезаписываем;
// запись атомарная (временный файл рядом, затем переименование).
//
// Здесь же — схема команды с версией и перенос между компьютерами (импорт/экспорт),
// чтобы у редактора, инструментов модели и окна была одна проверка, а не три разных.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { looksSecretEgress } = require('../memory/store');

const MAX_NAME = 80;
const MAX_PHRASES = 5;
const MAX_PHRASE = 120;
const MAX_STEPS = 20;
const MAX_TOOL = 60;

// Версия схемы команды. 1 — старые записи без поля schemaVersion; 2 — текущая (версия, дата изменения,
// происхождение, папка и коллекции). Файл обмена — отдельный формат со своей версией.
const COMMAND_SCHEMA_VERSION = 2;
const TRANSFER_FORMAT = 'nox.commands';
const TRANSFER_VERSION = 1;

// Происхождение команды: кто её составил. Используется подписями в окне и при переносе.
const ORIGINS = new Set(['manual', 'recorded', 'ai', 'imported', 'sample']);

// Лимиты импорта: файл, число команд и шагов, глубина JSON. Отказ — до любой записи.
const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_IMPORT_COMMANDS = 500;
const MAX_IMPORT_STEPS = 4000;
const MAX_IMPORT_DEPTH = 8;

// Лимиты аргументов одного шага. Не тесные для настоящих инструментов (самый длинный параметр — 4000),
// но не дают сохранить в команду мегабайтную строку или бездонную вложенность.
const MAX_ARGS = 40;
const MAX_ARG_KEY = 60;
const MAX_ARG_STRING = 8000;
const MAX_ARG_DEPTH = 4;
const MAX_COMMAND_BYTES = 64 * 1024;

// Папки и коллекции редактора команд (дерево в видео 4, 00:09–00:16).
const MAX_FOLDER = 60;
const MAX_COLLECTIONS = 5;
const MAX_COLLECTION = 40;

// Инструменты, которые редактор команд предлагает. Остальные в окне не выбираются, а сервер окна их не сохраняет.
const EDITOR_STEP_TOOLS = ['app_open', 'ui_keys', 'wait', 'speak', 'volume_set'];
// Опасное (удаление, отправка, оплата, выключение, закрытие окон с чужой работой): в сохранённой команде не бывает.
const DANGEROUS_TOOLS = new Set(['mail_send', 'pc_shutdown', 'shell_run', 'app_close', 'ui_close_window', 'forget', 'deal_clear', 'cancel_reminder']);

// Горячие клавиши команд. Зарезервированы клавиши самого приложения (окно и аварийный стоп).
const RESERVED_HOTKEYS = new Set(['CONTROL+ALT+J', 'CONTROL+ALT+SHIFT+K']);
const MODIFIER_ORDER = ['Control', 'Alt', 'Shift', 'Super'];
const MODIFIER_ALIASES = { ctrl: 'Control', control: 'Control', alt: 'Alt', shift: 'Shift', win: 'Super', super: 'Super', windows: 'Super' };
const KEY_PATTERN = /^([A-Z0-9]|F([1-9]|1[0-2]))$/;

// Поля аргумента, которые заведомо являются секретом: их не выгружаем и не записываем.
// «keys» у ui_keys сюда не попадает: это последовательность клавиш, а не ключ доступа.
const SECRET_ARG_KEY = /^(?:password|passwd|pwd|secret|token|api_?key|apikey|access_?token|refresh_?token|access_?key|private_?key|client_?secret|authorization|auth|cookie|cookies|otp|totp|one_?time_?code|credentials?)$/i;

// Поля, по которым при импорте показываем разницу.
const CHANGE_LABELS = {
  name: 'имя',
  phrases: 'фразы',
  steps: 'шаги',
  enabled: 'включённость',
  hotkey: 'горячая клавиша',
  folder: 'папка',
  collections: 'коллекции',
  origin: 'происхождение',
  createdAt: 'дата создания',
};

// Горячая клавиша в виде «Control+Alt+Y» (каноническая запись) или null. Нужен хотя бы один модификатор.
function checkHotkey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('горячая клавиша: нужна строка');
  const parts = value.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) throw new Error('горячая клавиша: нужен модификатор и клавиша, например Ctrl+Alt+Y');
  const key = parts[parts.length - 1].toUpperCase();
  if (!KEY_PATTERN.test(key)) throw new Error(`горячая клавиша: неизвестная клавиша «${parts[parts.length - 1]}»`);
  const mods = new Set();
  for (const raw of parts.slice(0, -1)) {
    const mod = MODIFIER_ALIASES[raw.toLowerCase()];
    if (!mod) throw new Error(`горячая клавиша: неизвестный модификатор «${raw}»`);
    mods.add(mod);
  }
  const canonical = [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
  if (RESERVED_HOTKEYS.has(canonical.toUpperCase())) throw new Error(`горячая клавиша ${canonical} занята самим ассистентом`);
  return canonical;
}

// Длина в кодовых точках, чтобы эмодзи считались одним символом.
const len = (text) => Array.from(text).length;

// Нормализация фразы: нижний регистр, ё→е, одиночные пробелы, без конечных . ! ? и пробелов.
function normalize(text) {
  if (typeof text !== 'string') throw new Error('фраза: нужна строка');
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.!?]+$/u, '');
}

function checkName(name) {
  if (typeof name !== 'string') throw new Error('имя команды: нужна строка');
  const clean = name.trim();
  if (clean === '') throw new Error('имя команды: пустое имя');
  if (len(clean) > MAX_NAME) throw new Error(`имя команды длиннее ${MAX_NAME} символов`);
  return clean;
}

function checkPhrases(phrases) {
  if (phrases === undefined) return [];
  if (!Array.isArray(phrases)) throw new Error('фразы: нужен массив строк');
  if (phrases.length > MAX_PHRASES) throw new Error(`фраз не больше ${MAX_PHRASES}`);
  const seen = new Set();
  const out = [];
  for (const raw of phrases) {
    if (typeof raw !== 'string') throw new Error('фраза: нужна строка');
    const phrase = normalize(raw);
    if (phrase === '') throw new Error('фраза: пустая строка');
    if (len(phrase) > MAX_PHRASE) throw new Error(`фраза длиннее ${MAX_PHRASE} символов`);
    if (seen.has(phrase)) throw new Error(`фраза повторяется в команде: «${phrase}»`);
    seen.add(phrase);
    out.push(phrase);
  }
  return out;
}

// Версия схемы: undefined и 1 — старые записи, читаем и при сохранении поднимаем до текущей;
// новее текущей — отказ, иначе новая сборка молча испортит команду при сохранении.
function checkSchemaVersion(value) {
  if (value === undefined || value === null) return COMMAND_SCHEMA_VERSION;
  if (!Number.isInteger(value) || value < 1) throw new Error('версия схемы команды: нужно целое число от 1');
  if (value > COMMAND_SCHEMA_VERSION) {
    throw new Error(`версия схемы команды ${value} не поддерживается: эта сборка понимает до ${COMMAND_SCHEMA_VERSION}`);
  }
  return COMMAND_SCHEMA_VERSION;
}

function checkEnabled(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('enabled: нужно true или false');
  return value;
}

// Строка ISO-даты; возвращает её в каноническом виде.
function checkIso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field}: нужна дата в формате ISO`);
  }
  return new Date(value).toISOString();
}

function checkNullableIso(value, field) {
  return value === null ? null : checkIso(value, field);
}

function checkFolder(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('папка: нужна строка');
  const clean = value.trim();
  if (clean === '') return null;
  if (len(clean) > MAX_FOLDER) throw new Error(`папка длиннее ${MAX_FOLDER} символов`);
  return clean;
}

function checkCollections(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('коллекции: нужен массив строк');
  if (value.length > MAX_COLLECTIONS) throw new Error(`коллекций не больше ${MAX_COLLECTIONS}`);
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new Error('коллекция: нужна строка');
    const clean = raw.trim();
    if (clean === '') throw new Error('коллекция: пустая строка');
    if (len(clean) > MAX_COLLECTION) throw new Error(`название коллекции длиннее ${MAX_COLLECTION} символов`);
    const key = clean.toLowerCase();
    if (seen.has(key)) throw new Error(`коллекция повторяется: «${clean}»`);
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function checkOrigin(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !ORIGINS.has(value)) {
    throw new Error(`происхождение команды: одно из ${[...ORIGINS].join(', ')}`);
  }
  return value;
}

function isSecretArgKey(key) {
  return SECRET_ARG_KEY.test(String(key).trim());
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Служебная метка «не переносить»: JSON-значения не могут её подделать, в отличие от обычного поля.
const DROP = Symbol('drop');

// Глубокая проверка значения аргумента. Возвращает копию без служебных типов.
// dropSecrets — для импорта и экспорта: секретные поля и значения не переносим (только предупреждение).
function walkArgValue(value, { where, dropSecrets = false, warnings = [] } = {}, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (len(value) > MAX_ARG_STRING) throw new Error(`${where} длиннее ${MAX_ARG_STRING} символов`);
    if (dropSecrets && looksSecretEgress(value)) {
      warnings.push(`${where}: значение не перенесено, похоже на секрет`);
      return DROP;
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${where}: нужно конечное число`);
    return value;
  }
  if (value === undefined) return DROP;
  if (typeof value !== 'object') throw new Error(`${where}: значение не переносится (${typeof value})`);
  if (depth >= MAX_ARG_DEPTH) throw new Error(`${where}: вложенность глубже ${MAX_ARG_DEPTH} уровней`);
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = walkArgValue(value[i], { where: `${where}[${i}]`, dropSecrets, warnings }, depth + 1);
      if (item === DROP) continue;
      out.push(item);
    }
    return out;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_ARGS) throw new Error(`${where}: больше ${MAX_ARGS} полей`);
  const out = {};
  for (const key of keys) {
    if (key.length > MAX_ARG_KEY) throw new Error(`${where}: имя поля «${String(key).slice(0, MAX_ARG_KEY)}…» длиннее ${MAX_ARG_KEY} символов`);
    if (dropSecrets && isSecretArgKey(key)) {
      warnings.push(`${where}: поле «${key}» не перенесено, похоже на секрет`);
      continue;
    }
    const item = walkArgValue(value[key], { where: `${where}.${key}`, dropSecrets, warnings }, depth + 1);
    if (item === DROP) continue;
    out[key] = item;
  }
  return out;
}

// Проверка аргументов шага. В обычном сохранении секреты не вырезаем (это выбор владельца),
// но типы, длина и вложенность проверяются всегда, чтобы команда не ломала исполнение.
function checkArgs(args, n, { strictArgs = false, warnings = [], prefix = '' } = {}) {
  if (!plainObject(args)) throw new Error(`${prefix}шаг ${n}: args должен быть объектом`);
  const where = `${prefix}шаг ${n}: args`;
  if (strictArgs) return walkArgValue(args, { where, dropSecrets: true, warnings });
  return walkArgValue(args, { where, dropSecrets: false });
}

function checkSteps(steps, { strictArgs = false, warnings = [], prefix = '' } = {}) {
  if (!Array.isArray(steps)) throw new Error(`${prefix}шаги: нужен массив`);
  if (steps.length < 1 || steps.length > MAX_STEPS) throw new Error(`${prefix}шагов от 1 до ${MAX_STEPS}`);
  return steps.map((step, i) => {
    const n = i + 1;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`${prefix}шаг ${n}: нужен объект {tool, args}`);
    }
    if (typeof step.tool !== 'string') throw new Error(`${prefix}шаг ${n}: нужно имя инструмента`);
    const tool = step.tool.trim();
    if (tool === '' || len(tool) > MAX_TOOL) {
      throw new Error(`${prefix}шаг ${n}: имя инструмента от 1 до ${MAX_TOOL} символов`);
    }
    if (DANGEROUS_TOOLS.has(tool) || tool.startsWith('mission_') || tool.startsWith('command_')) {
      throw new Error(`${prefix}шаг ${n}: «${tool}» нельзя сохранить в команде`);
    }
    const rawArgs = step.args === undefined ? {} : step.args;
    const args = checkArgs(rawArgs, n, { strictArgs, warnings, prefix });
    return { tool, args };
  });
}

// Служебная копия аргументов для журнала: секретные поля и значения заменяются пометкой, форма сохраняется.
function maskArgsForJournal(tool, args) {
  void tool;
  const mask = (value, depth) => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string' && looksSecretEgress(value)) return '[скрыто]';
      return value;
    }
    if (depth >= MAX_ARG_DEPTH) return '[скрыто: глубокая вложенность]';
    if (Array.isArray(value)) return value.map((item) => mask(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSecretArgKey(key) ? '[скрыто]' : mask(item, depth + 1);
    }
    return out;
  };
  return mask(args, 0);
}

// Поле команды в виде, пригодном для показа в diff: аргументы показываем только в замаскированном виде
// (в них может быть секрет), длинные значения обрезаем.
function displayValue(field, value) {
  if (field === 'steps') {
    const steps = Array.isArray(value) ? value : [];
    return steps.map((s) => {
      const tool = s && typeof s.tool === 'string' ? s.tool.trim() : '?';
      let brief = '';
      try {
        brief = JSON.stringify(maskArgsForJournal(tool, (s && s.args) || {}));
      } catch {
        brief = '';
      }
      if (!brief || brief === '{}') return tool;
      return `${tool} ${brief.length > 120 ? `${brief.slice(0, 117)}…` : brief}`;
    }).join(' → ') || '—';
  }
  if (field === 'phrases') return Array.isArray(value) && value.length ? value.join(' | ') : '—';
  if (field === 'collections') return Array.isArray(value) && value.length ? value.join(', ') : '—';
  if (field === 'enabled') return value ? 'включена' : 'выключена';
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'createdAt') return String(value);
  return String(value);
}

const STEP_FIELDS = ['name', 'phrases', 'steps', 'enabled', 'hotkey', 'folder', 'collections', 'origin', 'createdAt'];

// Отпечаток содержания: по нему видно, изменится команда при импорте или нет.
// Дата изменения (updatedAt) и последний запуск (lastRunAt) в содержание не входят: это не свойства команды.
function contentKey(cmd) {
  const object = {
    schemaVersion: COMMAND_SCHEMA_VERSION,
    name: typeof cmd.name === 'string' ? cmd.name.trim() : '',
    phrases: Array.isArray(cmd.phrases) ? cmd.phrases.map((p) => String(p)) : [],
    steps: Array.isArray(cmd.steps) ? cmd.steps.map((s) => ({ tool: String(s && s.tool), args: s && s.args ? s.args : {} })) : [],
    enabled: cmd.enabled !== false,
    hotkey: cmd.hotkey || null,
    folder: cmd.folder || null,
    collections: Array.isArray(cmd.collections) ? cmd.collections.map((c) => String(c)) : [],
    origin: ORIGINS.has(cmd.origin) ? cmd.origin : 'manual',
    createdAt: typeof cmd.createdAt === 'string' ? cmd.createdAt : null,
  };
  return JSON.stringify(object);
}

// что именно изменится: только названия полей и безопасные для показа значения.
function diffFields(before, after) {
  const changes = [];
  for (const field of STEP_FIELDS) {
    const left = field === 'steps' ? displayValue(field, before.steps) : displayValue(field, before[field]);
    const right = field === 'steps' ? displayValue(field, after.steps) : displayValue(field, after[field]);
    if (left === right) continue;
    changes.push({ field, label: CHANGE_LABELS[field] || field, before: left, after: right });
  }
  return changes;
}

function nameKeyOf(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

// Ищет, какую локальную команду заменит импортируемая: сначала по id, потом по имени.
function findExistingIndex(items, incoming) {
  if (incoming && typeof incoming.id === 'string' && incoming.id !== '') {
    const byId = items.findIndex((item) => item.id === incoming.id);
    if (byId >= 0) return byId;
  }
  const key = nameKeyOf(incoming && incoming.name);
  if (!key) return -1;
  return items.findIndex((item) => nameKeyOf(item.name) === key);
}

// Собирает запись команды из данных редактора/импорта. Ничего не пишет на диск.
function buildRecord(cmd, items, existing, { nowIso = new Date().toISOString(), strictArgs = false, warnings = [] } = {}) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) throw new Error('команда: нужен объект');
  const schemaVersion = checkSchemaVersion(cmd.schemaVersion);
  const name = checkName(cmd.name);
  const phrases = checkPhrases(cmd.phrases);
  const steps = checkSteps(cmd.steps, { strictArgs, warnings });
  const enabled = checkEnabled(cmd.enabled, existing ? existing.enabled : true);
  const createdAt = cmd.createdAt === undefined
    ? (existing && existing.createdAt ? existing.createdAt : nowIso)
    : checkIso(cmd.createdAt, 'createdAt');
  const hotkey = cmd.hotkey === undefined
    ? (existing && existing.hotkey ? existing.hotkey : null)
    : checkHotkey(cmd.hotkey);
  const lastRunAt = cmd.lastRunAt === undefined
    ? (existing ? existing.lastRunAt ?? null : null)
    : checkNullableIso(cmd.lastRunAt, 'lastRunAt');
  const folder = cmd.folder === undefined
    ? (existing ? existing.folder ?? null : null)
    : checkFolder(cmd.folder);
  const collections = cmd.collections === undefined
    ? (existing && Array.isArray(existing.collections) ? existing.collections.slice() : [])
    : checkCollections(cmd.collections);
  const origin = checkOrigin(cmd.origin, existing && ORIGINS.has(existing.origin) ? existing.origin : 'manual');

  const id = existing ? existing.id : crypto.randomUUID();
  for (const phrase of phrases) {
    const owner = items.find((item) => item.id !== id
      && (item.phrases || []).some((p) => normalize(p) === phrase));
    if (owner) throw new Error(`фраза уже используется в команде «${owner.name}»`);
  }
  if (hotkey) {
    const taken = items.find((item) => item.id !== id && item.hotkey && item.hotkey.toUpperCase() === hotkey.toUpperCase());
    if (taken) throw new Error(`горячая клавиша ${hotkey} уже у команды «${taken.name}»`);
  }

  const record = {
    id,
    schemaVersion,
    name,
    phrases,
    steps,
    enabled,
    createdAt,
    updatedAt: nowIso,
    lastRunAt,
    hotkey,
    folder,
    collections,
    origin,
  };
  const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  if (bytes > MAX_COMMAND_BYTES) {
    throw new Error(`команда «${name}» слишком большая: ${bytes} байт, предел ${MAX_COMMAND_BYTES}`);
  }
  return record;
}

function byName(a, b) {
  return a.name.localeCompare(b.name, 'ru');
}

class CommandStore {
  constructor(filePath) {
    if (!filePath) throw new Error('CommandStore: нужен путь к файлу');
    this.filePath = filePath;
  }

  _checkPath() {
    const dir = path.dirname(this.filePath);
    try {
      const parent = fs.lstatSync(dir);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('папка команд должна быть настоящей папкой');
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    try {
      const file = fs.lstatSync(this.filePath);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('файл команд не должен быть ссылкой');
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }

  // Все команды по имени.
  list() {
    return this._load().items.sort(byName);
  }

  get(id) {
    return this._load().items.find((item) => item.id === id) ?? null;
  }

  // Создаёт команду или обновляет существующую с тем же id. Возвращает сохранённую запись.
  save(cmd) {
    if (!cmd || typeof cmd !== 'object') throw new Error('команда: нужен объект');
    const data = this._load();
    const existing = typeof cmd.id === 'string'
      ? data.items.find((item) => item.id === cmd.id)
      : undefined;
    const record = buildRecord(cmd, data.items, existing);
    const items = existing
      ? data.items.map((item) => (item.id === record.id ? record : item))
      : [...data.items, record];
    this._save({ items });
    return record;
  }

  // Импорт уже проверенных команд: одна загрузка файла, одна атомарная запись.
  // Любая ошибка (в том числе занятая фраза) — до записи, данные не меняются.
  importCommands(commands) {
    if (!Array.isArray(commands)) throw new Error('импорт: нужен массив команд');
    if (commands.length > MAX_IMPORT_COMMANDS) throw new Error(`импорт: команд не больше ${MAX_IMPORT_COMMANDS}`);
    if (commands.length === 0) return { added: 0, updated: 0, unchanged: 0 };
    const data = this._load();
    const items = data.items.slice();
    const nowIso = new Date().toISOString();
    const counts = { added: 0, updated: 0, unchanged: 0 };
    for (const incoming of commands) {
      const index = findExistingIndex(items, incoming);
      const existing = index >= 0 ? items[index] : undefined;
      const record = buildRecord(incoming, items, existing, { nowIso, strictArgs: true });
      if (existing) {
        if (contentKey(existing) === contentKey(record)) {
          counts.unchanged += 1;
          continue;
        }
        items[index] = record;
        counts.updated += 1;
      } else {
        items.push(record);
        counts.added += 1;
      }
    }
    if (counts.added > 0 || counts.updated > 0) this._save({ items });
    return counts;
  }

  // true, если команда была и удалена; false, если такого id нет.
  remove(id) {
    const data = this._load();
    const items = data.items.filter((item) => item.id !== id);
    if (items.length === data.items.length) return false;
    this._save({ items });
    return true;
  }

  // Включённая команда, у которой есть такая фраза (после нормализации), или null.
  findByPhrase(text) {
    if (typeof text !== 'string') return null;
    const wanted = normalize(text);
    if (wanted === '') return null;
    return this._load().items.find((item) => item.enabled
      && (item.phrases || []).some((p) => normalize(p) === wanted)) ?? null;
  }

  // Запоминает время последнего запуска. Возвращает команду или null, если id нет.
  markRun(id, when = new Date()) {
    const at = when instanceof Date ? when : new Date(when);
    if (Number.isNaN(at.getTime())) throw new Error('markRun: плохое время');
    const data = this._load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item) return null;
    item.lastRunAt = at.toISOString();
    this._save(data);
    return item;
  }

  _load() {
    this._checkPath();
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { items: [] };
      throw err;
    }
    if (raw.trim() === '') return { items: [] };
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (!data || !Array.isArray(data.items)) {
      // Повреждённый файл не перезаписываем: иначе команды молча пропадут.
      throw new Error('файл команд повреждён');
    }
    return data;
  }

  // Атомарная запись: во временный файл рядом, затем переименование поверх основного.
  _save(data) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    this._checkPath();
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Важна исходная ошибка записи, а не неудача уборки временного файла.
      }
      throw err;
    }
  }
}

// ── Экспорт и импорт ─────────────────────────────────────────────

// Глубина JSON в файле импорта. Циклическая ссылка в объекте (теоретически возможна из JS) — отказ.
function jsonDepth(value, depth = 0, path = []) {
  if (depth > MAX_IMPORT_DEPTH) return depth;
  if (!value || typeof value !== 'object') return depth;
  if (path.includes(value)) throw new Error('файл импорта: циклическая ссылка');
  path.push(value);
  let max = depth;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    max = Math.max(max, jsonDepth(item, depth + 1, path));
  }
  path.pop();
  return max;
}

// Проверка одной команды из файла: типы, лимиты, версия, вырезание секретов. Возвращает чистую команду.
function sanitizeImportedCommand(raw, label, warnings) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('нужен объект команды');
  const schemaVersion = checkSchemaVersion(raw.schemaVersion);
  const name = checkName(raw.name);
  const phrases = checkPhrases(raw.phrases);
  const steps = checkSteps(raw.steps, { strictArgs: true, warnings, prefix: `${label}, ` });
  const enabled = checkEnabled(raw.enabled, true);
  const hotkey = raw.hotkey === undefined ? null : checkHotkey(raw.hotkey);
  const folder = checkFolder(raw.folder);
  const collections = checkCollections(raw.collections);
  const origin = raw.origin === undefined
    ? 'imported'
    : checkOrigin(raw.origin, 'imported');
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' && len(raw.id.trim()) <= 80
    ? raw.id.trim()
    : undefined;
  const createdAt = raw.createdAt === undefined || raw.createdAt === null ? undefined : checkIso(raw.createdAt, 'createdAt');
  const command = { schemaVersion, name, phrases, steps, enabled, hotkey, folder, collections, origin };
  if (id) command.id = id;
  if (createdAt) command.createdAt = createdAt;
  return command;
}

// Разбор файла обмена (строка JSON или уже разобранный объект). Ничего не пишет.
function parseCommandPack(input) {
  let raw = input;
  if (Buffer.isBuffer(input)) raw = input.toString('utf8');
  if (typeof raw === 'string') {
    if (raw.trim() === '') throw new Error('файл импорта пуст');
    if (Buffer.byteLength(raw, 'utf8') > MAX_IMPORT_BYTES) {
      throw new Error(`файл импорта больше ${Math.round(MAX_IMPORT_BYTES / 1024)} КБ`);
    }
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('файл импорта не читается как JSON');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('файл импорта: нужен объект с командами');
  }
  if (jsonDepth(raw) > MAX_IMPORT_DEPTH) throw new Error(`файл импорта вложен глубже ${MAX_IMPORT_DEPTH} уровней`);
  let serialized;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new Error('файл импорта: значения не переводятся в JSON');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_IMPORT_BYTES) {
    throw new Error(`файл импорта больше ${Math.round(MAX_IMPORT_BYTES / 1024)} КБ`);
  }
  if (raw.format !== TRANSFER_FORMAT) throw new Error('это не файл команд Nox: нет заголовка формата');
  if (!Number.isInteger(raw.version) || raw.version < 1) throw new Error('в файле импорта нет версии формата');
  if (raw.version > TRANSFER_VERSION) {
    throw new Error(`версия файла команд ${raw.version} не поддерживается: эта сборка понимает версию ${TRANSFER_VERSION}`);
  }
  const fileSchema = raw.schemaVersion === undefined ? 1 : raw.schemaVersion;
  if (!Number.isInteger(fileSchema) || fileSchema < 1) throw new Error('в файле импорта неверная версия схемы команд');
  if (fileSchema > COMMAND_SCHEMA_VERSION) {
    throw new Error(`версия схемы команд ${fileSchema} не поддерживается: эта сборка понимает до ${COMMAND_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.commands)) throw new Error('в файле импорта нет списка команд');
  if (raw.commands.length > MAX_IMPORT_COMMANDS) throw new Error(`в файле импорта больше ${MAX_IMPORT_COMMANDS} команд`);

  const warnings = [];
  const commands = [];
  const names = new Map();
  const phrases = new Map();
  const hotkeys = new Map();
  let totalSteps = 0;
  raw.commands.forEach((item, i) => {
    const label = `команда ${i + 1}`;
    let command;
    try {
      command = sanitizeImportedCommand(item, label, warnings);
    } catch (err) {
      throw new Error(`${label}: ${err.message}`);
    }
    const nameKey = nameKeyOf(command.name);
    if (names.has(nameKey)) throw new Error(`${label}: имя «${command.name}» повторяется в файле`);
    names.set(nameKey, command.name);
    totalSteps += command.steps.length;
    if (totalSteps > MAX_IMPORT_STEPS) throw new Error(`в файле импорта больше ${MAX_IMPORT_STEPS} шагов`);
    for (const phrase of command.phrases) {
      const key = normalize(phrase);
      if (phrases.has(key)) throw new Error(`${label}: фраза «${phrase}» повторяется в файле (у «${phrases.get(key)}»)`);
      phrases.set(key, command.name);
    }
    if (command.hotkey) {
      const key = command.hotkey.toUpperCase();
      if (hotkeys.has(key)) throw new Error(`${label}: горячая клавиша ${command.hotkey} повторяется в файле`);
      hotkeys.set(key, command.name);
    }
    commands.push(command);
  });
  return {
    pack: {
      format: TRANSFER_FORMAT,
      version: raw.version,
      schemaVersion: fileSchema,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
    },
    commands,
    warnings,
  };
}

// Собирает файл обмена из команд. Секреты не выгружаются: поля с секретными именами и значения
// с явными метками секрета пропускаются, в warnings остаётся только факт пропуска без значения.
function exportCommandPack(commands, { now = new Date() } = {}) {
  if (!Array.isArray(commands)) throw new Error('экспорт: нужен массив команд');
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const warnings = [];
  const list = [];
  commands.forEach((cmd, i) => {
    const label = `команда ${i + 1}`;
    try {
      const name = checkName(cmd && cmd.name);
      const phrases = checkPhrases(cmd && cmd.phrases);
      const rawSteps = Array.isArray(cmd.steps) ? cmd.steps : [];
      const steps = checkSteps(rawSteps, { strictArgs: true, warnings, prefix: `${label}, ` });
      const enabled = checkEnabled(cmd.enabled, true);
      const hotkey = cmd.hotkey === undefined || cmd.hotkey === null ? null : checkHotkey(cmd.hotkey);
      const folder = checkFolder(cmd.folder);
      const collections = checkCollections(cmd.collections);
      const origin = checkOrigin(cmd.origin, 'manual');
      const createdAt = typeof cmd.createdAt === 'string' && !Number.isNaN(Date.parse(cmd.createdAt))
        ? new Date(cmd.createdAt).toISOString()
        : null;
      const packed = {
        schemaVersion: COMMAND_SCHEMA_VERSION,
        name,
        phrases,
        steps,
        enabled,
        hotkey,
        folder,
        collections,
        origin,
        createdAt,
      };
      if (typeof cmd.id === 'string' && cmd.id !== '') packed.id = cmd.id;
      list.push(packed);
    } catch (err) {
      warnings.push(`${label}: не выгружена (${err.message})`);
    }
  });
  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    schemaVersion: COMMAND_SCHEMA_VERSION,
    exportedAt: at.toISOString(),
    commands: list,
    warnings,
  };
}

function exportCommandJson(commands, options = {}) {
  return JSON.stringify(exportCommandPack(commands, options), null, 2);
}

// Предпросмотр импорта: что добавится, что изменится, что совпадёт, где конфликты.
// Ничего не пишет и не меняет. applicable = false, если есть конфликты или файл не разобрался.
function previewCommandImport(input, store) {
  if (!store || typeof store.list !== 'function') return { ok: false, error: 'нет хранилища команд' };
  let parsed;
  try {
    parsed = parseCommandPack(input);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  let items;
  try {
    items = store.list();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const localPhrases = new Map();
  const localHotkeys = new Map();
  for (const local of items) {
    for (const phrase of local.phrases || []) {
      const key = normalize(String(phrase));
      if (!localPhrases.has(key)) localPhrases.set(key, local);
    }
    if (local.hotkey) localHotkeys.set(String(local.hotkey).toUpperCase(), local);
  }

  const counts = { add: 0, update: 0, unchanged: 0, conflict: 0 };
  const previewItems = [];
  for (const incoming of parsed.commands) {
    const index = findExistingIndex(items, incoming);
    const existing = index >= 0 ? items[index] : undefined;
    const conflicts = [];
    for (const phrase of incoming.phrases) {
      const owner = localPhrases.get(normalize(phrase));
      if (owner && (!existing || owner.id !== existing.id)) {
        conflicts.push(`фраза «${phrase}» уже у команды «${owner.name}»`);
      }
    }
    if (incoming.hotkey) {
      const owner = localHotkeys.get(incoming.hotkey.toUpperCase());
      if (owner && (!existing || owner.id !== existing.id)) {
        conflicts.push(`горячая клавиша ${incoming.hotkey} уже у команды «${owner.name}»`);
      }
    }
    let action;
    let changes = [];
    if (conflicts.length) action = 'conflict';
    else if (!existing) action = 'add';
    else if (contentKey(existing) === contentKey(incoming)) action = 'unchanged';
    else {
      action = 'update';
      changes = diffFields(existing, incoming);
    }
    counts[action] += 1;
    previewItems.push({
      name: incoming.name,
      action,
      localId: existing ? existing.id : null,
      changes,
      conflicts,
    });
    for (const phrase of incoming.phrases) {
      const key = normalize(phrase);
      if (!localPhrases.has(key)) localPhrases.set(key, { id: incoming.id || null, name: incoming.name });
    }
    if (incoming.hotkey && countOwners(localHotkeys, incoming.hotkey) === 0) {
      localHotkeys.set(incoming.hotkey.toUpperCase(), { id: incoming.id || null, name: incoming.name });
    }
  }
  return {
    ok: true,
    preview: {
      format: parsed.pack.format,
      version: parsed.pack.version,
      schemaVersion: parsed.pack.schemaVersion,
      exportedAt: parsed.pack.exportedAt,
      commandCount: parsed.commands.length,
      items: previewItems,
      counts,
      warnings: parsed.warnings,
      applicable: counts.conflict === 0,
    },
  };
}

// При импорте занятые фразы внутри самого файла уже проверены; здесь считаем только локальных владельцев.
function countOwners(map, key) {
  return map.has(String(key).toUpperCase()) ? 1 : 0;
}

// Применение импорта: только после явного подтверждения (confirm === true).
// Файл проверяется заново (между предпросмотром и импортом могли измениться команды),
// запись атомарная: при любом отказе данные остаются как были.
function applyCommandImport(input, store, { confirm = false } = {}) {
  if (confirm !== true) return { ok: false, error: 'импорт не подтверждён' };
  if (!store || typeof store.importCommands !== 'function') return { ok: false, error: 'нет хранилища команд' };
  let parsed;
  try {
    parsed = parseCommandPack(input);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const preview = previewCommandImport(input, store);
  if (!preview.ok) return { ok: false, error: preview.error };
  if (!preview.preview.applicable) {
    const conflicts = preview.preview.items.flatMap((item) => item.conflicts);
    return { ok: false, error: `импорт отклонён: ${conflicts.join('; ')}` };
  }
  try {
    const result = store.importCommands(parsed.commands);
    return { ok: true, ...result, warnings: parsed.warnings };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  CommandStore,
  normalize,
  checkHotkey,
  checkName,
  checkPhrases,
  checkSteps,
  checkFolder,
  checkCollections,
  checkSchemaVersion,
  RESERVED_HOTKEYS,
  EDITOR_STEP_TOOLS,
  DANGEROUS_TOOLS,
  MAX_STEPS,
  MAX_NAME,
  MAX_PHRASES,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COMMANDS,
  MAX_IMPORT_STEPS,
  MAX_IMPORT_DEPTH,
  MAX_COMMAND_BYTES,
  COMMAND_SCHEMA_VERSION,
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  ORIGINS,
  maskArgsForJournal,
  exportCommandPack,
  exportCommandJson,
  parseCommandPack,
  previewCommandImport,
  applyCommandImport,
  isSecretArgKey,
};
