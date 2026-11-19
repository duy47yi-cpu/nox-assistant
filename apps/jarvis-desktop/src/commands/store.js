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
// Необязательные стартовые глаголы команды («открой», «запусти», «зайди в»): их немного,
// и они короткие, иначе удобная подстановка превратится в угадывание.
const MAX_OPTIONAL_PHRASES = 10;
const MAX_OPTIONAL_PHRASE = 80;
const MAX_STEPS = 20;
const MAX_TOOL = 60;

// Версия схемы команды. 1 — старые записи без поля schemaVersion; 2 — плоские шаги с триггерами;
// 3 — текущая: дерево шагов ({id, type, params, children}), программа, confirm.
const { zonedFormatter, wallTime, resolveWallTime } = require('../schedule/store');

const COMMAND_SCHEMA_VERSION = 3;
const TRANSFER_FORMAT = 'nox.commands';
const TRANSFER_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_SCHEDULE_MS = 12 * 60 * 60 * 1000;
const MIN_SCHEDULE_MINUTES = 1;
const MAX_SCHEDULE_MINUTES = 10080;
const MAX_EVENT_NAME = 80;
const MAX_EVENT_MATCH = 120;
const MAX_COOLDOWN_SEC = 86400;
const DEFAULT_EVENT_COOLDOWN_SEC = 5;
const MAX_HOTKEY_COOLDOWN_MS = 60000;
const MAX_RECENT_OCCURRENCES = 40;
const MAX_RUN_LOG_ENTRIES = 500;
const TIME_HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

const SCHEDULE_TYPES = new Set(['interval', 'daily', 'weekdays', 'weekly']);
const EVENT_CATALOG = Object.freeze([
  Object.freeze({ type: 'app:startup', label: 'Запуск ассистента', description: 'Сразу после запуска Nox Assistant' }),
  Object.freeze({ type: 'system:unlock', label: 'Разблокировка экрана', description: 'Когда владелец возвращается за компьютер' }),
  Object.freeze({ type: 'system:lock', label: 'Блокировка экрана', description: 'Когда экран компьютера блокируется' }),
  Object.freeze({ type: 'system:resume', label: 'Выход из сна', description: 'После пробуждения компьютера' }),
  Object.freeze({ type: 'system:suspend', label: 'Перед уходом в сон', description: 'Когда система переходит в режим сна' }),
  Object.freeze({ type: 'workspace:inbox_added', label: 'Новый файл во входящих', description: 'При появлении файла в подключённой папке' }),
  Object.freeze({ type: 'app:hung', label: 'Зависшая программа', description: 'Если обнаружено не отвечающее окно' }),
  Object.freeze({ type: 'user:custom', label: 'Пользовательское событие', description: 'Именованное событие сценария или внешней кнопки' }),
]);
const SYSTEM_EVENT_TYPES = new Set(EVENT_CATALOG.map((e) => e.type));
const RUN_STATUSES = new Set(['started', 'succeeded', 'partial', 'skipped', 'failed', 'cancelled', 'blocked', 'interrupted']);
const TRIGGER_KINDS = new Set(['hotkey', 'schedule', 'event', 'manual', 'phrase']);
const STEP_TYPES = new Set([
  'app_start', 'url_open', 'hotkey', 'click', 'volume', 'type_text', 'wait', 'ai', 'shell', 'ram_trim', 'youtube', 'media',
]);
const TYPE_TO_TOOL = Object.freeze({
  app_start: 'app_open',
  url_open: 'url_open',
  hotkey: 'ui_keys',
  click: 'ui_click',
  volume: 'volume_set',
  type_text: 'ui_type',
  wait: 'wait',
  ai: 'ai',
  shell: 'shell_run',
  ram_trim: 'ram_trim',
  youtube: 'youtube_play',
  media: 'media_control',
});
const TOOL_TO_TYPE = Object.freeze({
  app_open: 'app_start',
  url_open: 'url_open',
  ui_keys: 'hotkey',
  ui_click: 'click',
  desktop_click: 'click',
  mouse_click: 'click',
  volume_set: 'volume',
  ui_type: 'type_text',
  desktop_type: 'type_text',
  wait: 'wait',
  ai: 'ai',
  shell_run: 'shell',
  ram_trim: 'ram_trim',
  youtube_play: 'youtube',
  media_control: 'media',
});
const MAX_STEP_ID = 80;
const MAX_PROGRAM = 200;
const MAX_TREE_DEPTH = 16;
const INVALID_PROGRAM_CHARS_RE = /[\x00-\x1f\x7f*?"<>|]/;

// Происхождение команды: кто её составил. Используется подписями в окне и при переносе.
const ORIGINS = new Set(['manual', 'recorded', 'ai', 'model', 'imported', 'sample']);

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
  optionalPhrases: 'стартовые глаголы',
  steps: 'шаги',
  enabled: 'включённость',
  hotkey: 'горячая клавиша',
  triggers: 'способы запуска',
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

// Необязательные фразы команды: стартовые глаголы вроде «открой», «запусти», «зайди в».
// Это не триггеры запуска, а оболочка просьбы перед фразой (см. src/commands/match.js),
// поэтому повторы между командами разрешены, а внутри одной команды — нет.
function checkOptionalPhrases(phrases) {
  if (phrases === undefined || phrases === null) return [];
  if (!Array.isArray(phrases)) throw new Error('стартовые глаголы: нужен массив строк');
  if (phrases.length > MAX_OPTIONAL_PHRASES) throw new Error(`стартовых глаголов не больше ${MAX_OPTIONAL_PHRASES}`);
  const seen = new Set();
  const out = [];
  for (const raw of phrases) {
    if (typeof raw !== 'string') throw new Error('стартовый глагол: нужна строка');
    const phrase = normalize(raw);
    if (phrase === '') throw new Error('стартовый глагол: пустая строка');
    if (len(phrase) > MAX_OPTIONAL_PHRASE) throw new Error(`стартовый глагол длиннее ${MAX_OPTIONAL_PHRASE} символов`);
    if (seen.has(phrase)) throw new Error(`стартовый глагол повторяется в команде: «${phrase}»`);
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

function checkProgramRef(raw, whereLabel = 'программа') {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error(`${whereLabel}: нужна строка`);
  const clean = raw.trim();
  if (clean === '') return null;
  if (len(clean) > MAX_PROGRAM) throw new Error(`${whereLabel}: не длиннее ${MAX_PROGRAM} символов`);
  if (INVALID_PROGRAM_CHARS_RE.test(clean) || SECRET_ARG_KEY.test(clean) || /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]/i.test(clean)) {
    throw new Error(`${whereLabel}: недопустимая ссылка на программу «${clean.slice(0, 40)}»`);
  }
  const hasExplicitPath = /[\\/]/.test(clean) || /^[a-zA-Z]:/.test(clean);
  if (hasExplicitPath) {
    if (/(?:^|[\\/])\.\.(?:$|[\\/])/.test(clean)) {
      throw new Error(`${whereLabel}: битая ссылка на программу «${clean}»`);
    }
    if (!fs.existsSync(clean)) {
      throw new Error(`${whereLabel}: битая ссылка на программу «${clean}» — файл не найден`);
    }
  }
  return clean;
}

function checkConfirm(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('confirm: нужен логический флаг (true или false)');
  return value;
}

function resolveStepTypeAndTool(step, label) {
  const hasTool = typeof step.tool === 'string' && step.tool.trim() !== '';
  const hasType = typeof step.type === 'string' && step.type.trim() !== '';
  if (!hasTool && !hasType) {
    throw new Error(`${label}: укажите имя инструмента (tool или type)`);
  }
  const rawType = hasType ? step.type.trim() : '';
  const rawTool = hasTool ? step.tool.trim() : '';
  let type = rawType;
  let tool = rawTool;

  if (!tool && type) {
    if (TYPE_TO_TOOL[type]) tool = TYPE_TO_TOOL[type];
    else tool = type;
  }
  if (!type && tool) {
    type = TOOL_TO_TYPE[tool] || tool;
  }
  if (type === 'click' && step.params && step.params.x !== undefined && step.params.y !== undefined
      && !step.params.window && !step.params.name && !step.params.automationId && !rawTool) {
    tool = 'desktop_click';
  }
  if (tool === '' || len(tool) > MAX_TOOL) {
    throw new Error(`${label}: имя инструмента от 1 до ${MAX_TOOL} символов`);
  }
  if (type === '' || len(type) > MAX_TOOL) {
    throw new Error(`${label}: тип шага от 1 до ${MAX_TOOL} символов`);
  }
  return { type, tool };
}

function checkSteps(steps, { strictArgs = false, warnings = [], prefix = '', blockShiftDelete = false } = {}) {
  if (!Array.isArray(steps)) throw new Error(`${prefix}шаги: нужен массив`);
  if (steps.length < 1 || steps.length > MAX_STEPS) throw new Error(`${prefix}шагов от 1 до ${MAX_STEPS}`);

  const usedIds = new Set();
  const seenObjects = new Set();
  let totalCount = 0;
  let autoSeq = 0;

  const nextAutoId = () => {
    let candidate;
    do {
      autoSeq += 1;
      candidate = `step-${autoSeq}`;
    } while (usedIds.has(candidate));
    return candidate;
  };

  const walk = (list, pathLabel, depth) => {
    if (depth > MAX_TREE_DEPTH) {
      throw new Error(`${prefix}дерево шагов вложено глубже ${MAX_TREE_DEPTH} уровней`);
    }
    if (!Array.isArray(list)) throw new Error(`${prefix}${pathLabel}: children должен быть массивом`);
    return list.map((step, i) => {
      const nLabel = pathLabel ? `${pathLabel}.${i + 1}` : `${i + 1}`;
      totalCount += 1;
      if (totalCount > MAX_STEPS) {
        throw new Error(`${prefix}шагов от 1 до ${MAX_STEPS}`);
      }
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new Error(`${prefix}шаг ${nLabel}: нужен объект шага`);
      }
      if (seenObjects.has(step)) {
        throw new Error(`${prefix}шаг ${nLabel}: циклическая ссылка в дереве шагов`);
      }
      seenObjects.add(step);

      const { type, tool } = resolveStepTypeAndTool(step, `${prefix}шаг ${nLabel}`);
      if (DANGEROUS_TOOLS.has(tool) || tool.startsWith('mission_') || tool.startsWith('command_')) {
        throw new Error(`${prefix}шаг ${nLabel}: «${tool}» нельзя сохранить в команде`);
      }

      let rawParams = step.args !== undefined ? step.args : (step.params !== undefined ? step.params : {});
      if (step.args === undefined && step.params !== undefined) rawParams = step.params;
      const args = checkArgs(rawParams, nLabel, { strictArgs, warnings, prefix });
      // Синхронизация параметров для app_start / volume / hotkey / type_text / click
      const hasExplicitProg = args.name !== undefined || args.program !== undefined;
      if ((type === 'app_start' || tool === 'app_open') && (step.type === 'app_start' || hasExplicitProg)) {
        const progVal = args.name !== undefined ? args.name : args.program;
        if (typeof progVal !== 'string' || progVal.trim() === '') {
          throw new Error(`${prefix}шаг ${nLabel}: не указана программа для запуска`);
        }
        const checkedProg = checkProgramRef(progVal, `${prefix}шаг ${nLabel}`);
        args.name = checkedProg;
      }
      if ((type === 'volume' || tool === 'volume_set') && args.percent === undefined && args.level !== undefined) {
        args.percent = args.level;
        delete args.level;
      }
      if (blockShiftDelete && tool === 'ui_keys' && /(?:^|\s)shift\s*\+\s*(?:delete|del)(?:\s|$)/i.test(String(args.keys || ''))) {
        throw new Error(`${prefix}шаг ${nLabel}: «ui_keys» с shift+delete нельзя сохранить в команде`);
      }

      let id;
      if (step.id !== undefined && step.id !== null) {
        if (typeof step.id !== 'string' || step.id.trim() === '') {
          throw new Error(`${prefix}шаг ${nLabel}: id шага должен быть непустой строкой`);
        }
        id = step.id.trim();
        if (len(id) > MAX_STEP_ID) {
          throw new Error(`${prefix}шаг ${nLabel}: id шага длиннее ${MAX_STEP_ID} символов`);
        }
        if (usedIds.has(id)) {
          throw new Error(`${prefix}шаг ${nLabel}: дубль id шага «${id}»`);
        }
      } else {
        id = nextAutoId();
      }
      usedIds.add(id);

      const rawChildren = step.children === undefined ? [] : step.children;
      const children = walk(rawChildren, nLabel, depth + 1);
      seenObjects.delete(step);

      const params = JSON.parse(JSON.stringify(args));
      if (type === 'app_start' && params.program === undefined && typeof params.name === 'string') {
        params.program = params.name;
      }
      const normalizedNode = { id, type, params, children, tool, args };
      if (typeof step.continueOnError === 'boolean') normalizedNode.continueOnError = step.continueOnError;
      if (typeof step.label === 'string' && step.label.trim()) normalizedNode.label = step.label.trim().slice(0, 80);
      return normalizedNode;
    });
  };

  return walk(steps, '', 0);
}

function flattenStepTreeWithDepth(steps) {
  const out = [];
  const walk = (list, depth = 0, parentId = null) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      out.push({ node, depth, parentId });
      if (Array.isArray(node.children) && node.children.length > 0) {
        walk(node.children, depth + 1, node.id || null);
      }
    }
  };
  walk(steps, 0, null);
  return out;
}

function flattenStepTree(steps) {
  return flattenStepTreeWithDepth(steps).map((entry) => entry.node);
}

function countStepNodes(steps) {
  return flattenStepTree(steps).length;
}

function hasTreeSteps(steps) {
  return Array.isArray(steps) && steps.some((s) => s && Array.isArray(s.children) && s.children.length > 0);
}

function stepNeedsMigration(steps) {
  if (!Array.isArray(steps)) return true;
  for (const s of steps) {
    if (!s || typeof s !== 'object') return true;
    if (typeof s.id !== 'string' || !s.id || typeof s.type !== 'string' || !s.type) return true;
    if (!s.params || typeof s.params !== 'object' || Array.isArray(s.params)) return true;
    if (!Array.isArray(s.children)) return true;
    if (s.children.length > 0 && stepNeedsMigration(s.children)) return true;
  }
  return false;
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

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeLogText(value, maxLen = 300) {
  if (value === undefined || value === null) return null;
  const raw = String(value).replace(/\r?\n/g, ' ').trim();
  if (!raw) return null;
  if (looksSecretEgress(raw)) return '[скрыто]';
  const chars = Array.from(raw);
  return chars.length > maxLen ? `${chars.slice(0, maxLen - 1).join('')}…` : raw;
}

function checkTimeZone(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new Error('часовой пояс: нужна строка IANA');
  const trimmed = raw.trim();
  if (!trimmed) return null;
  zonedFormatter(trimmed);
  return trimmed;
}

function defaultTriggers(hotkey = null) {
  return {
    hotkey: { enabled: Boolean(hotkey), key: hotkey || null, cooldownMs: 0 },
    schedule: { enabled: false, type: 'interval', minutes: 60, at: null, weekday: null, timeZone: null },
    event: { enabled: false, eventType: null, eventName: null, match: null, cooldownSec: DEFAULT_EVENT_COOLDOWN_SEC },
  };
}

function defaultTriggerState() {
  return {
    status: 'idle',
    runStartedAt: null,
    activeTrigger: null,
    activeOccurrenceKey: null,
    nextRunAt: null,
    lastScheduledSlot: null,
    lastTrigger: null,
    lastTriggeredAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastReason: null,
    lastDurationMs: null,
    lastAttemptAtByTrigger: {},
    recentOccurrenceKeys: [],
  };
}

function checkCooldownMs(raw, fallback = 0) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_HOTKEY_COOLDOWN_MS) {
    throw new Error(`горячая клавиша: задержка повтора от 0 до ${MAX_HOTKEY_COOLDOWN_MS} мс`);
  }
  return raw;
}

function checkScheduleTrigger(raw, existingSchedule = null) {
  const base = existingSchedule ? { ...defaultTriggers().schedule, ...existingSchedule } : defaultTriggers().schedule;
  if (raw === undefined) return { ...base };
  if (raw === null) return defaultTriggers().schedule;
  if (!isPlainObject(raw)) throw new Error('расписание: нужен объект');
  const enabled = raw.enabled === undefined ? base.enabled : checkEnabled(raw.enabled, false);
  const type = raw.type === undefined ? base.type : String(raw.type || '').trim();
  if (!SCHEDULE_TYPES.has(type)) {
    throw new Error('расписание: тип должен быть interval, daily, weekdays или weekly');
  }
  if (type === 'interval') {
    const rawMin = raw.minutes === undefined || raw.minutes === null
      ? (base.type === 'interval' && base.minutes ? base.minutes : 60)
      : raw.minutes;
    if (typeof rawMin !== 'number' || !Number.isInteger(rawMin) || rawMin < MIN_SCHEDULE_MINUTES || rawMin > MAX_SCHEDULE_MINUTES) {
      throw new Error(`расписание: интервал должен быть целым числом от ${MIN_SCHEDULE_MINUTES} до ${MAX_SCHEDULE_MINUTES} мин`);
    }
    const timeZone = raw.timeZone !== undefined ? checkTimeZone(raw.timeZone) : base.timeZone;
    return { enabled, type: 'interval', minutes: rawMin, at: null, weekday: null, timeZone };
  }
  const fallbackAt = base.at || (enabled ? null : '09:00');
  const rawAt = raw.at === undefined || raw.at === null || raw.at === '' ? fallbackAt : String(raw.at).trim();
  if (!rawAt || !TIME_HHMM_RE.test(rawAt)) {
    throw new Error('расписание: укажите время запуска в формате ЧЧ:ММ');
  }
  let weekday = null;
  if (type === 'weekly') {
    const rawDay = raw.weekday === undefined || raw.weekday === null ? (base.weekday ?? 1) : raw.weekday;
    if (typeof rawDay !== 'number' || !Number.isInteger(rawDay) || rawDay < 1 || rawDay > 7) {
      throw new Error('расписание: день недели от 1 (пн) до 7 (вс)');
    }
    weekday = rawDay;
  }
  const timeZone = raw.timeZone !== undefined ? checkTimeZone(raw.timeZone) : base.timeZone;
  return { enabled, type, minutes: null, at: rawAt, weekday, timeZone };
}

function parseEventTypeAndName(rawType, rawName) {
  let eventType = rawType === undefined || rawType === null || rawType === '' ? null : String(rawType).trim();
  let derivedName = null;
  if (eventType && eventType.startsWith('user:') && eventType !== 'user:custom') {
    derivedName = eventType.slice(5).trim();
    eventType = 'user:custom';
  }
  const eventName = rawName !== undefined ? rawName : derivedName;
  return { eventType, eventName };
}

function checkEventTrigger(raw, existingEvent = null) {
  const base = existingEvent ? { ...defaultTriggers().event, ...existingEvent } : defaultTriggers().event;
  if (raw === undefined) return { ...base };
  if (raw === null) return defaultTriggers().event;
  if (!isPlainObject(raw)) throw new Error('событие: нужен объект');
  const enabled = raw.enabled === undefined ? base.enabled : checkEnabled(raw.enabled, false);
  const hasType = raw.eventType !== undefined || raw.type !== undefined;
  const rawTypeVal = raw.eventType !== undefined ? raw.eventType : raw.type;
  const rawNameVal = raw.eventName !== undefined ? raw.eventName : raw.userEvent;
  const parsed = hasType
    ? parseEventTypeAndName(rawTypeVal, rawNameVal)
    : { eventType: base.eventType, eventName: rawNameVal !== undefined ? rawNameVal : base.eventName };

  if (parsed.eventType !== null && !SYSTEM_EVENT_TYPES.has(parsed.eventType)) {
    throw new Error(`событие: неизвестный тип «${parsed.eventType}»`);
  }
  if (enabled && !parsed.eventType) {
    throw new Error('событие: выберите системное или пользовательское событие');
  }

  let eventName = null;
  if (parsed.eventType === 'user:custom') {
    const candidate = parsed.eventName;
    if (candidate !== undefined && candidate !== null && candidate !== '') {
      if (typeof candidate !== 'string') throw new Error('событие: имя пользовательского события должно быть строкой');
      const clean = candidate.trim().replace(/\s+/g, ' ');
      if (CONTROL_CHARS_RE.test(clean)) throw new Error('событие: недопустимые символы в имени события');
      if (len(clean) > MAX_EVENT_NAME) throw new Error(`событие: имя события длиннее ${MAX_EVENT_NAME} символов`);
      eventName = clean || null;
    }
    if (enabled && !eventName) {
      throw new Error('событие: укажите имя пользовательского события');
    }
  }

  let match = base.match;
  if (raw.match !== undefined) {
    if (raw.match === null || raw.match === '') {
      match = null;
    } else if (typeof raw.match !== 'string') {
      throw new Error('событие: фильтр должен быть строкой');
    } else {
      const cleanMatch = raw.match.trim();
      if (CONTROL_CHARS_RE.test(cleanMatch)) throw new Error('событие: недопустимые символы в фильтре');
      if (len(cleanMatch) > MAX_EVENT_MATCH) throw new Error(`событие: фильтр длиннее ${MAX_EVENT_MATCH} символов`);
      match = cleanMatch || null;
    }
  }

  let cooldownSec = base.cooldownSec;
  if (raw.cooldownSec !== undefined && raw.cooldownSec !== null) {
    if (typeof raw.cooldownSec !== 'number' || !Number.isInteger(raw.cooldownSec) || raw.cooldownSec < 0 || raw.cooldownSec > MAX_COOLDOWN_SEC) {
      throw new Error(`событие: пауза должна быть целым числом от 0 до ${MAX_COOLDOWN_SEC} с`);
    }
    cooldownSec = raw.cooldownSec;
  }
  return {
    enabled,
    eventType: parsed.eventType,
    eventName,
    match,
    cooldownSec,
  };
}

function existingHotkeyConfig(existing) {
  const existingHt = existing && existing.triggers && isPlainObject(existing.triggers.hotkey)
    ? existing.triggers.hotkey
    : null;
  const existingTop = existing && existing.hotkey ? checkHotkey(existing.hotkey) : null;
  if (!existingHt) {
    return { enabled: Boolean(existingTop), key: existingTop, cooldownMs: 0 };
  }
  const key = existingHt.key ? checkHotkey(existingHt.key) : existingTop;
  const enabled = existingHt.enabled === undefined ? Boolean(key) : Boolean(existingHt.enabled && key);
  const cooldownMs = Number.isInteger(existingHt.cooldownMs) ? existingHt.cooldownMs : 0;
  return { enabled, key, cooldownMs };
}

function sameHotkeyTriggerConfig(rawHt, baseHt) {
  if (!isPlainObject(rawHt)) return false;
  const normKey = rawHt.key === undefined ? baseHt.key : checkHotkey(rawHt.key);
  const normEnabled = rawHt.enabled === undefined ? baseHt.enabled : Boolean(rawHt.enabled);
  const normCooldown = checkCooldownMs(rawHt.cooldownMs, baseHt.cooldownMs);
  return normEnabled === baseHt.enabled && normKey === baseHt.key && normCooldown === baseHt.cooldownMs;
}

function checkHotkeyTrigger(cmd, existing) {
  const baseHt = existingHotkeyConfig(existing);
  const existingTop = existing && existing.hotkey ? checkHotkey(existing.hotkey) : null;
  const topProvided = cmd && cmd.hotkey !== undefined;
  const normTop = topProvided ? checkHotkey(cmd.hotkey) : undefined;
  const hasTriggersObj = cmd && isPlainObject(cmd.triggers);
  if (cmd && cmd.triggers !== undefined && cmd.triggers !== null && !hasTriggersObj) {
    throw new Error('triggers: нужен объект');
  }
  const rawHt = hasTriggersObj && cmd.triggers.hotkey !== undefined ? cmd.triggers.hotkey : undefined;

  let enabled = baseHt.enabled;
  let key = baseHt.key;
  let cooldownMs = baseHt.cooldownMs;

  const topMutatedOnly = Boolean(
    existing
    && topProvided
    && normTop !== existingTop
    && (rawHt === undefined || sameHotkeyTriggerConfig(rawHt, baseHt)),
  );

  if (topMutatedOnly) {
    key = normTop;
    enabled = Boolean(normTop);
  } else if (rawHt !== undefined) {
    if (rawHt === null) {
      enabled = false;
      key = null;
      cooldownMs = 0;
    } else {
      if (!isPlainObject(rawHt)) throw new Error('горячая клавиша: нужен объект');
      enabled = rawHt.enabled === undefined ? baseHt.enabled : checkEnabled(rawHt.enabled, false);
      key = rawHt.key === undefined ? (topProvided ? normTop : baseHt.key) : checkHotkey(rawHt.key);
      cooldownMs = checkCooldownMs(rawHt.cooldownMs, baseHt.cooldownMs);
      if (enabled && !key) throw new Error('горячая клавиша: укажите сочетание клавиш для включения');
    }
  } else if (topProvided) {
    key = normTop;
    enabled = Boolean(normTop);
  }

  const hotkeyTrigger = { enabled, key, cooldownMs };
  const hotkey = enabled && key ? key : null;
  return { hotkeyTrigger, hotkey };
}

function normalizeTriggers(cmd, existing = null) {
  const base = existing && isPlainObject(existing.triggers) ? existing.triggers : defaultTriggers(existing ? existing.hotkey : null);
  const { hotkeyTrigger, hotkey } = checkHotkeyTrigger(cmd, existing);
  const rawTriggers = cmd && isPlainObject(cmd.triggers) ? cmd.triggers : {};
  const schedule = checkScheduleTrigger(rawTriggers.schedule, base.schedule);
  const event = checkEventTrigger(rawTriggers.event, base.event);
  return {
    triggers: { hotkey: hotkeyTrigger, schedule, event },
    hotkey,
  };
}

function normalizeTriggersLenient(cmd) {
  try {
    return normalizeTriggers(cmd || {}, null).triggers;
  } catch {
    return defaultTriggers(cmd && typeof cmd.hotkey === 'string' ? cmd.hotkey : null);
  }
}

function scheduleConfigEqual(a, b) {
  if (!a || !b) return false;
  return Boolean(a.enabled) === Boolean(b.enabled)
    && a.type === b.type
    && (a.minutes ?? null) === (b.minutes ?? null)
    && (a.at ?? null) === (b.at ?? null)
    && (a.weekday ?? null) === (b.weekday ?? null)
    && (a.timeZone ?? null) === (b.timeZone ?? null);
}

function nextScheduleIso(schedule, afterDate = new Date()) {
  if (!schedule || !schedule.enabled) return null;
  const after = afterDate instanceof Date ? afterDate : new Date(afterDate);
  const afterMs = Number.isNaN(after.getTime()) ? Date.now() : after.getTime();
  if (schedule.type === 'interval') {
    return new Date(afterMs + schedule.minutes * 60000).toISOString();
  }
  const [hh, mm] = String(schedule.at || '09:00').split(':').map(Number);
  const formatter = zonedFormatter(schedule.timeZone || undefined);
  const wallNow = wallTime(afterMs, formatter);
  const wallDate = new Date(wallNow);
  const baseY = wallDate.getUTCFullYear();
  const baseM = wallDate.getUTCMonth();
  const baseD = wallDate.getUTCDate();
  for (let offset = 0; offset <= 14; offset += 1) {
    const candidateWall = Date.UTC(baseY, baseM, baseD + offset, hh, mm, 0, 0);
    const isoDay = ((new Date(candidateWall).getUTCDay() + 6) % 7) + 1;
    const dayMatches = schedule.type === 'daily'
      || (schedule.type === 'weekdays' && isoDay >= 1 && isoDay <= 5)
      || (schedule.type === 'weekly' && isoDay === schedule.weekday);
    if (!dayMatches) continue;
    const { shifted } = resolveWallTime(candidateWall, formatter);
    if (shifted !== undefined && shifted > afterMs) {
      return new Date(shifted).toISOString();
    }
  }
  return null;
}

function sanitizeTriggerState(raw) {
  const base = defaultTriggerState();
  if (!isPlainObject(raw)) return base;
  base.status = raw.status === 'running' ? 'running' : 'idle';
  base.runStartedAt = typeof raw.runStartedAt === 'string' ? raw.runStartedAt : null;
  base.activeTrigger = TRIGGER_KINDS.has(raw.activeTrigger) ? raw.activeTrigger : null;
  base.activeOccurrenceKey = typeof raw.activeOccurrenceKey === 'string' ? raw.activeOccurrenceKey.slice(0, 200) : null;
  base.nextRunAt = typeof raw.nextRunAt === 'string' ? raw.nextRunAt : null;
  base.lastScheduledSlot = typeof raw.lastScheduledSlot === 'string' ? raw.lastScheduledSlot : null;
  base.lastTrigger = TRIGGER_KINDS.has(raw.lastTrigger) ? raw.lastTrigger : null;
  base.lastTriggeredAt = typeof raw.lastTriggeredAt === 'string' ? raw.lastTriggeredAt : null;
  base.lastFinishedAt = typeof raw.lastFinishedAt === 'string' ? raw.lastFinishedAt : null;
  base.lastStatus = RUN_STATUSES.has(raw.lastStatus) ? raw.lastStatus : null;
  base.lastReason = sanitizeLogText(raw.lastReason, 300);
  base.lastDurationMs = typeof raw.lastDurationMs === 'number' && Number.isFinite(raw.lastDurationMs) ? raw.lastDurationMs : null;
  if (isPlainObject(raw.lastAttemptAtByTrigger)) {
    for (const [k, v] of Object.entries(raw.lastAttemptAtByTrigger)) {
      if (TRIGGER_KINDS.has(k) && typeof v === 'string') base.lastAttemptAtByTrigger[k] = v;
    }
  }
  if (Array.isArray(raw.recentOccurrenceKeys)) {
    base.recentOccurrenceKeys = raw.recentOccurrenceKeys
      .filter((item) => item && typeof item.key === 'string' && typeof item.ts === 'string')
      .slice(-MAX_RECENT_OCCURRENCES)
      .map((item) => ({ key: item.key.slice(0, 200), ts: item.ts }));
  }
  return base;
}

function withNormalizedTriggers(record) {
  if (!record || typeof record !== 'object') return record;
  const { triggers, hotkey } = isPlainObject(record.triggers)
    ? { triggers: normalizeTriggersLenient(record), hotkey: record.hotkey ?? null }
    : { triggers: defaultTriggers(record.hotkey ?? null), hotkey: record.hotkey ?? null };
  const triggerState = sanitizeTriggerState(record.triggerState);
  return {
    ...record,
    hotkey,
    triggers,
    triggerState,
  };
}

function assertSafeFilePath(filePath, dirLabel = 'папка', fileLabel = 'файл') {
  const dir = path.dirname(filePath);
  try {
    const parent = fs.lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(`${dirLabel} должна быть настоящей папкой`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    const file = fs.lstatSync(filePath);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error(`${fileLabel} не должен быть ссылкой`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function atomicWriteJson(filePath, data, dirLabel = 'папка', fileLabel = 'файл') {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  assertSafeFilePath(filePath, dirLabel, fileLabel);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Важна исходная ошибка записи, а не неудача уборки временного файла.
    }
    throw err;
  }
}

function describeScheduleTrigger(schedule) {
  if (!schedule) return 'выключено';
  const stateLabel = schedule.enabled ? 'вкл' : 'выкл';
  let when;
  if (schedule.type === 'interval') {
    when = `каждые ${schedule.minutes} мин`;
  } else if (schedule.type === 'weekdays') {
    when = `по будням в ${schedule.at}`;
  } else if (schedule.type === 'weekly') {
    const days = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
    when = `каждую ${days[schedule.weekday] || schedule.weekday} в ${schedule.at}`;
  } else {
    when = `ежедневно в ${schedule.at}`;
  }
  const tz = schedule.timeZone ? ` (${schedule.timeZone})` : '';
  return `${when}${tz} · ${stateLabel}`;
}

function eventLabel(event) {
  if (!event || !event.eventType) return 'не выбрано';
  if (event.eventType === 'user:custom') {
    return event.eventName ? `своё «${event.eventName}»` : 'пользовательское событие';
  }
  const found = EVENT_CATALOG.find((item) => item.type === event.eventType);
  return found ? found.label : event.eventType;
}

function formatTriggersSummary(rawTriggers) {
  const triggers = normalizeTriggersLenient({ triggers: rawTriggers, hotkey: rawTriggers && rawTriggers.hotkey ? rawTriggers.hotkey.key : null });
  const hk = triggers.hotkey.key
    ? `клавиша ${triggers.hotkey.key} (${triggers.hotkey.enabled ? 'вкл' : 'выкл'})`
    : 'клавиша —';
  const sch = triggers.schedule.enabled || triggers.schedule.at || triggers.schedule.minutes !== 60 || triggers.schedule.type !== 'interval'
    ? `время: ${describeScheduleTrigger(triggers.schedule)}`
    : 'время —';
  const ev = triggers.event.eventType
    ? `событие: ${eventLabel(triggers.event)}${triggers.event.match ? ` [${triggers.event.match}]` : ''} (${triggers.event.enabled ? 'вкл' : 'выкл'}, пауза ${triggers.event.cooldownSec} с)`
    : 'событие —';
  return `${hk}; ${sch}; ${ev}`;
}

// Поле команды в виде, пригодном для показа в diff: аргументы показываем только в замаскированном виде
// (в них может быть секрет), длинные значения обрезаем.
function displayValue(field, value) {
  if (field === 'steps') {
    const flat = flattenStepTreeWithDepth(Array.isArray(value) ? value : []);
    return flat.map(({ node: s, depth }) => {
      const tool = s && typeof (s.tool || s.type) === 'string' ? String(s.tool || s.type).trim() : '?';
      let brief = '';
      try {
        brief = JSON.stringify(maskArgsForJournal(tool, (s && (s.args || s.params)) || {}));
      } catch {
        brief = '';
      }
      const indent = depth > 0 ? `${'  '.repeat(depth)}↳ ` : '';
      if (!brief || brief === '{}') return `${indent}${tool}`;
      return `${indent}${tool} ${brief.length > 120 ? `${brief.slice(0, 117)}…` : brief}`;
    }).join(' → ') || '—';
  }
  if (field === 'triggers') return formatTriggersSummary(value);
  if (field === 'phrases' || field === 'optionalPhrases') {
    return Array.isArray(value) && value.length ? value.join(' | ') : '—';
  }
  if (field === 'collections') return Array.isArray(value) && value.length ? value.join(', ') : '—';
  if (field === 'enabled' || field === 'confirm') return value ? 'да' : 'нет';
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'createdAt') return String(value);
  return String(value);
}

const STEP_FIELDS = ['name', 'program', 'phrases', 'optionalPhrases', 'steps', 'confirm', 'enabled', 'hotkey', 'triggers', 'folder', 'collections', 'origin', 'createdAt'];

function stepContentTree(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => ({
    type: String((s && (s.type || TOOL_TO_TYPE[s.tool] || s.tool)) || ''),
    tool: String((s && (s.tool || TYPE_TO_TOOL[s.type] || s.type)) || ''),
    args: s && (s.args || s.params) ? (s.args || s.params) : {},
    children: stepContentTree(s && s.children),
  }));
}

// Отпечаток содержания: по нему видно, изменится команда при импорте или нет.
// Дата изменения (updatedAt), последний запуск (lastRunAt) и состояние расписания в содержание не входят.
function contentKey(cmd) {
  const object = {
    schemaVersion: COMMAND_SCHEMA_VERSION,
    name: typeof cmd.name === 'string' ? cmd.name.trim() : '',
    program: typeof cmd.program === 'string' && cmd.program.trim() ? cmd.program.trim() : null,
    confirm: cmd.confirm === true,
    phrases: Array.isArray(cmd.phrases) ? cmd.phrases.map((p) => String(p)) : [],
    optionalPhrases: Array.isArray(cmd.optionalPhrases) ? cmd.optionalPhrases.map((p) => String(p)) : [],
    steps: stepContentTree(cmd.steps),
    enabled: cmd.enabled !== false,
    hotkey: cmd.hotkey || null,
    triggers: normalizeTriggersLenient(cmd),
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
  checkSchemaVersion(cmd.schemaVersion);
  const schemaVersion = COMMAND_SCHEMA_VERSION;
  const name = checkName(cmd.name);
  const program = cmd.program === undefined
    ? (existing ? existing.program ?? null : null)
    : checkProgramRef(cmd.program, 'программа команды');
  const confirm = cmd.confirm === undefined
    ? (existing ? existing.confirm === true : false)
    : checkConfirm(cmd.confirm, false);
  const phrases = checkPhrases(cmd.phrases);
  // Старые записи без поля сохраняют пустой список: правка в редакторе его не теряет.
  const optionalPhrases = cmd.optionalPhrases === undefined
    ? (existing && Array.isArray(existing.optionalPhrases) ? existing.optionalPhrases.slice() : [])
    : checkOptionalPhrases(cmd.optionalPhrases);
  const origin = checkOrigin(cmd.origin, existing && ORIGINS.has(existing.origin) ? existing.origin : 'manual');
  const steps = checkSteps(cmd.steps, { strictArgs, warnings, blockShiftDelete: origin === 'ai' || origin === 'model' });
  const enabled = checkEnabled(cmd.enabled, existing ? existing.enabled : true);
  const createdAt = cmd.createdAt === undefined
    ? (existing && existing.createdAt ? existing.createdAt : nowIso)
    : checkIso(cmd.createdAt, 'createdAt');
  const { triggers, hotkey } = normalizeTriggers(cmd, existing);
  const existingTriggers = existing ? normalizeTriggersLenient(existing) : null;
  const triggerState = existing ? sanitizeTriggerState(existing.triggerState) : defaultTriggerState();
  if (!triggers.schedule.enabled) {
    triggerState.nextRunAt = null;
  } else if (!existingTriggers || !scheduleConfigEqual(existingTriggers.schedule, triggers.schedule) || !triggerState.nextRunAt) {
    triggerState.nextRunAt = nextScheduleIso(triggers.schedule, new Date(nowIso));
  }
  const lastRunAt = cmd.lastRunAt === undefined
    ? (existing ? existing.lastRunAt ?? null : null)
    : checkNullableIso(cmd.lastRunAt, 'lastRunAt');
  const folder = cmd.folder === undefined
    ? (existing ? existing.folder ?? null : null)
    : checkFolder(cmd.folder);
  const collections = cmd.collections === undefined
    ? (existing && Array.isArray(existing.collections) ? existing.collections.slice() : [])
    : checkCollections(cmd.collections);

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
    program,
    confirm,
    phrases,
    optionalPhrases,
    steps,
    enabled,
    createdAt,
    updatedAt: nowIso,
    lastRunAt,
    hotkey,
    triggers,
    triggerState,
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
    assertSafeFilePath(this.filePath, 'папка команд', 'файл команд');
  }

  // Все команды по имени.
  list() {
    return this._load().items.map(withNormalizedTriggers).sort(byName);
  }

  get(id) {
    const found = this._load().items.find((item) => item.id === id);
    return found ? withNormalizedTriggers(found) : null;
  }

  // Создаёт команду или обновляет существующую с тем же id. Возвращает сохранённую запись.
  save(cmd, options = {}) {
    if (!cmd || typeof cmd !== 'object') throw new Error('команда: нужен объект');
    const data = this._load();
    const existing = typeof cmd.id === 'string'
      ? data.items.find((item) => item.id === cmd.id)
      : undefined;
    const nowAt = options && options.now !== undefined
      ? (options.now instanceof Date ? options.now : new Date(options.now))
      : new Date();
    if (Number.isNaN(nowAt.getTime())) throw new Error('save: плохое время');
    const record = buildRecord(cmd, data.items, existing, { nowIso: nowAt.toISOString() });
    const items = existing
      ? data.items.map((item) => (item.id === record.id ? record : item))
      : [...data.items, record];
    this._save({ items });
    return withNormalizedTriggers(record);
  }

  // Точечно обновляет настройки способов запуска команды без сброса шагов или состояния.
  updateTriggers(id, patch = {}, options = {}) {
    if (!patch || !isPlainObject(patch)) throw new Error('способы запуска: нужен объект');
    const existing = this.get(id);
    if (!existing) throw new Error('команда не найдена');
    const nextTriggers = {
      hotkey: patch.hotkey !== undefined ? { ...existing.triggers.hotkey, ...patch.hotkey } : existing.triggers.hotkey,
      schedule: patch.schedule !== undefined ? { ...existing.triggers.schedule, ...patch.schedule } : existing.triggers.schedule,
      event: patch.event !== undefined ? { ...existing.triggers.event, ...patch.event } : existing.triggers.event,
    };
    const nextTopHotkey = patch.hotkey && patch.hotkey.key !== undefined
      ? patch.hotkey.key
      : existing.hotkey;
    return this.save({
      ...existing,
      hotkey: nextTriggers.hotkey.enabled ? (nextTriggers.hotkey.key ?? nextTopHotkey) : null,
      triggers: nextTriggers,
    }, options);
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
    const found = this._load().items.find((item) => item.enabled
      && (item.phrases || []).some((p) => normalize(p) === wanted));
    return found ? withNormalizedTriggers(found) : null;
  }

  // Находит команду по горячей клавише (приоритет у включённой; выключенную тоже возвращает, чтобы показать причину пропуска).
  findByHotkey(hotkey) {
    let canonical;
    try {
      canonical = checkHotkey(hotkey);
    } catch {
      return null;
    }
    if (!canonical) return null;
    const wanted = canonical.toUpperCase();
    const all = this._load().items.map(withNormalizedTriggers);
    const active = all.find((item) => item.enabled !== false
      && item.triggers.hotkey.enabled
      && item.triggers.hotkey.key
      && item.triggers.hotkey.key.toUpperCase() === wanted);
    if (active) return active;
    return all.find((item) => item.triggers.hotkey.key
      && item.triggers.hotkey.key.toUpperCase() === wanted) ?? null;
  }

  // Все команды, подписанные на событие (включённые и выключенные — чтобы журнал фиксировал понятный пропуск).
  findByEvent(eventType, payload = {}) {
    if (typeof eventType !== 'string' || !eventType.trim()) return [];
    const parsed = parseEventTypeAndName(eventType, payload && (payload.eventName ?? payload.userEvent));
    if (!parsed.eventType) return [];
    const textFields = [];
    if (payload && typeof payload === 'object') {
      for (const key of ['target', 'detail', 'name', 'label', 'path', 'app', 'text', 'window', 'title']) {
        if (typeof payload[key] === 'string' && payload[key].trim()) textFields.push(payload[key].toLowerCase());
      }
    }
    const haystack = textFields.join(' ');
    return this._load().items
      .map(withNormalizedTriggers)
      .filter((item) => {
        const ev = item.triggers.event;
        if (!ev || ev.eventType !== parsed.eventType) return false;
        if (ev.eventType === 'user:custom') {
          if (normalize(ev.eventName || '') !== normalize(parsed.eventName || '')) return false;
        }
        if (ev.match && !haystack.includes(ev.match.toLowerCase())) return false;
        return true;
      })
      .sort(byName);
  }

  // Только чтение: команды с включённым расписанием, срок которых наступил (включая отложенные на <=12 ч).
  dueScheduledCommands(now = new Date()) {
    const at = now instanceof Date ? now : new Date(now);
    const nowMs = at.getTime();
    if (Number.isNaN(nowMs)) throw new Error('dueScheduledCommands: плохое время');
    return this._load().items
      .map(withNormalizedTriggers)
      .filter((item) => item.enabled !== false
        && item.triggers.schedule.enabled === true
        && item.triggerState.status !== 'running'
        && item.triggerState.nextRunAt !== null
        && new Date(item.triggerState.nextRunAt).getTime() <= nowMs)
      .sort((a, b) => new Date(a.triggerState.nextRunAt).getTime() - new Date(b.triggerState.nextRunAt).getTime());
  }

  // Календарные расписания, просроченные более чем на 12 ч (компьютер был выключен), переводим в будущее без запуска.
  skipStaleSchedules(now = new Date()) {
    const at = now instanceof Date ? now : new Date(now);
    const nowMs = at.getTime();
    if (Number.isNaN(nowMs)) throw new Error('skipStaleSchedules: плохое время');
    const data = this._load();
    const skipped = [];
    let dirty = false;
    const nextItems = data.items.map((rawItem) => {
      const item = withNormalizedTriggers(rawItem);
      const sch = item.triggers.schedule;
      const st = item.triggerState;
      if (item.enabled === false || !sch.enabled || sch.type === 'interval' || st.status === 'running' || !st.nextRunAt) {
        return rawItem;
      }
      const dueMs = new Date(st.nextRunAt).getTime();
      if (!Number.isFinite(dueMs) || nowMs - dueMs <= STALE_SCHEDULE_MS) return rawItem;

      const scheduledFor = st.nextRunAt;
      const occurrenceKey = `schedule:${item.id}:${scheduledFor}`;
      const nextRunAt = nextScheduleIso(sch, at);
      const reason = 'пропущено: компьютер был выключен или окно запуска прошло';
      const nowIso = at.toISOString();
      const recent = Array.isArray(st.recentOccurrenceKeys) ? st.recentOccurrenceKeys.slice() : [];
      if (!recent.some((entry) => entry.key === occurrenceKey)) {
        recent.push({ key: occurrenceKey, ts: nowIso });
      }
      item.triggerState = {
        ...st,
        nextRunAt,
        lastScheduledSlot: scheduledFor,
        lastTrigger: 'schedule',
        lastTriggeredAt: nowIso,
        lastFinishedAt: nowIso,
        lastStatus: 'skipped',
        lastReason: reason,
        recentOccurrenceKeys: recent.slice(-MAX_RECENT_OCCURRENCES),
      };
      dirty = true;
      skipped.push({ command: item, scheduledFor, nextRunAt, occurrenceKey, reason });
      return item;
    });
    if (dirty) this._save({ items: nextItems });
    return skipped;
  }

  // Фиксирует старт запуска на диске ДО выполнения шагов (и сдвигает расписание, чтобы падение не дало слепой повтор).
  markTriggerStart(id, { trigger = 'manual', scheduledFor = null, occurrenceKey = null, now = new Date() } = {}) {
    const at = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(at.getTime())) throw new Error('markTriggerStart: плохое время');
    if (!TRIGGER_KINDS.has(trigger)) throw new Error(`markTriggerStart: неизвестный способ запуска «${trigger}»`);
    const data = this._load();
    const idx = data.items.findIndex((entry) => entry.id === id);
    if (idx < 0) return null;
    const item = withNormalizedTriggers(data.items[idx]);
    if (item.triggerState.status === 'running') return null;

    const nowIso = at.toISOString();
    const st = item.triggerState;
    const recent = Array.isArray(st.recentOccurrenceKeys) ? st.recentOccurrenceKeys.slice() : [];
    if (occurrenceKey && !recent.some((entry) => entry.key === occurrenceKey)) {
      recent.push({ key: occurrenceKey.slice(0, 200), ts: nowIso });
    }
    const attempts = { ...(st.lastAttemptAtByTrigger || {}), [trigger]: nowIso };
    let nextRunAt = st.nextRunAt;
    let lastScheduledSlot = st.lastScheduledSlot;
    if (trigger === 'schedule' && item.triggers.schedule.enabled) {
      const slotIso = scheduledFor || st.nextRunAt;
      const slotMs = slotIso ? Date.parse(slotIso) : 0;
      const anchor = new Date(Math.max(at.getTime(), Number.isFinite(slotMs) ? slotMs : 0));
      nextRunAt = nextScheduleIso(item.triggers.schedule, anchor);
      lastScheduledSlot = slotIso || lastScheduledSlot;
    }

    item.triggerState = {
      ...st,
      status: 'running',
      runStartedAt: nowIso,
      activeTrigger: trigger,
      activeOccurrenceKey: occurrenceKey ? occurrenceKey.slice(0, 200) : null,
      nextRunAt,
      lastScheduledSlot,
      lastTrigger: trigger,
      lastTriggeredAt: nowIso,
      lastAttemptAtByTrigger: attempts,
      recentOccurrenceKeys: recent.slice(-MAX_RECENT_OCCURRENCES),
    };
    const nextItems = data.items.slice();
    nextItems[idx] = item;
    this._save({ items: nextItems });
    return withNormalizedTriggers(item);
  }

  // Завершает запуск, снимает блокировку выполнения и сохраняет итог и понятную причину.
  markTriggerFinish(id, { trigger = null, status = 'succeeded', reason = null, durationMs = null, now = new Date() } = {}) {
    const at = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(at.getTime())) throw new Error('markTriggerFinish: плохое время');
    const safeStatus = RUN_STATUSES.has(status) ? status : 'failed';
    const data = this._load();
    const idx = data.items.findIndex((entry) => entry.id === id);
    if (idx < 0) return null;
    const item = withNormalizedTriggers(data.items[idx]);
    const st = item.triggerState;
    const nowIso = at.toISOString();
    const usedTrigger = TRIGGER_KINDS.has(trigger) ? trigger : st.activeTrigger || st.lastTrigger;
    item.triggerState = {
      ...st,
      status: 'idle',
      runStartedAt: null,
      activeTrigger: null,
      activeOccurrenceKey: null,
      lastTrigger: usedTrigger,
      lastTriggeredAt: st.lastTriggeredAt || nowIso,
      lastFinishedAt: nowIso,
      lastStatus: safeStatus,
      lastReason: sanitizeLogText(reason, 300),
      lastDurationMs: typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
    };
    if (safeStatus === 'succeeded') item.lastRunAt = nowIso;
    const nextItems = data.items.slice();
    nextItems[idx] = item;
    this._save({ items: nextItems });
    return withNormalizedTriggers(item);
  }

  // Восстановление после падения/перезапуска: незавершённые запуски закрываются без слепого повтора.
  reconcileInterrupted(now = new Date()) {
    const at = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(at.getTime())) throw new Error('reconcileInterrupted: плохое время');
    const data = this._load();
    const reconciled = [];
    let dirty = false;
    const nowIso = at.toISOString();
    const reason = 'прервано при перезапуске: повторного запуска не было';
    const nextItems = data.items.map((rawItem) => {
      const item = withNormalizedTriggers(rawItem);
      if (item.triggerState.status !== 'running') return rawItem;
      const interruptedTrigger = item.triggerState.activeTrigger || item.triggerState.lastTrigger || 'manual';
      const interruptedOccurrence = item.triggerState.activeOccurrenceKey || null;
      item.triggerState = {
        ...item.triggerState,
        status: 'idle',
        runStartedAt: null,
        activeTrigger: null,
        activeOccurrenceKey: null,
        lastTrigger: interruptedTrigger,
        lastFinishedAt: nowIso,
        lastStatus: 'interrupted',
        lastReason: reason,
        lastDurationMs: null,
      };
      dirty = true;
      reconciled.push({ command: item, trigger: interruptedTrigger, occurrenceKey: interruptedOccurrence, reason });
      return item;
    });
    if (dirty) this._save({ items: nextItems });
    return reconciled;
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

  _migrateItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { item, changed: false };
    const oldVer = Number.isInteger(item.schemaVersion) ? item.schemaVersion : 1;
    const needsStepUpgrade = stepNeedsMigration(item.steps);
    const needsHeaderUpgrade = oldVer < COMMAND_SCHEMA_VERSION
      || !Object.prototype.hasOwnProperty.call(item, 'program')
      || !Object.prototype.hasOwnProperty.call(item, 'confirm');
    if (!needsStepUpgrade && !needsHeaderUpgrade) {
      return { item, changed: false };
    }
    const usedIds = new Set();
    let seq = 0;
    const nextId = () => {
      let c;
      do { seq += 1; c = `step-${seq}`; } while (usedIds.has(c));
      return c;
    };
    const upgradeSteps = (list) => {
      if (!Array.isArray(list)) return [];
      return list.map((s) => {
        if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
        const tool = typeof s.tool === 'string' && s.tool.trim()
          ? s.tool.trim()
          : (typeof s.type === 'string' && s.type.trim()
            ? (TYPE_TO_TOOL[s.type.trim()] || s.type.trim())
            : '');
        const type = typeof s.type === 'string' && s.type.trim()
          ? s.type.trim()
          : (TOOL_TO_TYPE[tool] || tool);
        const args = (s.args && typeof s.args === 'object' && !Array.isArray(s.args))
          ? s.args
          : ((s.params && typeof s.params === 'object' && !Array.isArray(s.params)) ? s.params : {});
        const params = (s.params && typeof s.params === 'object' && !Array.isArray(s.params))
          ? s.params
          : JSON.parse(JSON.stringify(args));
        if (type === 'app_start' && params.program === undefined && typeof params.name === 'string') {
          params.program = params.name;
        }
        let id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : '';
        if (!id || usedIds.has(id)) id = nextId();
        usedIds.add(id);
        const children = upgradeSteps(s.children);
        const out = { id, type, params, children, tool, args };
        if (typeof s.continueOnError === 'boolean') out.continueOnError = s.continueOnError;
        if (typeof s.label === 'string' && s.label.trim()) out.label = s.label.trim();
        return out;
      });
    };
    const upgraded = {
      ...item,
      schemaVersion: COMMAND_SCHEMA_VERSION,
      program: typeof item.program === 'string' && item.program.trim() ? item.program.trim() : null,
      confirm: item.confirm === true,
      steps: upgradeSteps(item.steps),
    };
    return { item: upgraded, changed: true };
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
    let migratedAny = false;
    const items = data.items.map((item) => {
      const res = this._migrateItem(item);
      if (res.changed) migratedAny = true;
      return res.item;
    });
    const fileVer = Number.isInteger(data.schemaVersion) ? data.schemaVersion : 1;
    const out = { ...data, schemaVersion: COMMAND_SCHEMA_VERSION, items };
    if (migratedAny || fileVer < COMMAND_SCHEMA_VERSION) {
      try {
        this._save(out);
      } catch {
        // Если файл открыт только для чтения — не падаем при миграции в памяти.
      }
    }
    return out;
  }

  // Атомарная запись: во временный файл рядом, затем переименование поверх основного.
  _save(data) {
    const payload = { ...data, schemaVersion: COMMAND_SCHEMA_VERSION };
    atomicWriteJson(this.filePath, payload, 'папка команд', 'файл команд');
  }
}

class CommandRunLog {
  constructor(filePath, { maxEntries = MAX_RUN_LOG_ENTRIES } = {}) {
    if (!filePath) throw new Error('CommandRunLog: нужен путь к файлу');
    this.filePath = filePath;
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : MAX_RUN_LOG_ENTRIES;
  }

  _checkPath() {
    assertSafeFilePath(this.filePath, 'папка журнала запусков', 'журнал запусков');
  }

  _load() {
    this._checkPath();
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { entries: [] };
      throw err;
    }
    if (raw.trim() === '') return { entries: [] };
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (!data || !Array.isArray(data.entries)) {
      throw new Error('журнал запусков команд повреждён');
    }
    return data;
  }

  append(entry = {}) {
    if (!entry || typeof entry !== 'object') throw new Error('запись журнала: нужен объект');
    const at = entry.ts instanceof Date
      ? entry.ts
      : (typeof entry.ts === 'string' && !Number.isNaN(Date.parse(entry.ts)) ? new Date(entry.ts) : new Date());
    const status = RUN_STATUSES.has(entry.status) ? entry.status : 'failed';
    const trigger = TRIGGER_KINDS.has(entry.trigger) ? entry.trigger : 'manual';
    const clean = {
      id: typeof entry.id === 'string' && entry.id ? entry.id : crypto.randomUUID(),
      ts: at.toISOString(),
      commandId: typeof entry.commandId === 'string' ? entry.commandId : null,
      commandName: sanitizeLogText(entry.commandName, 100) || 'без имени',
      trigger,
      triggerDetail: sanitizeLogText(entry.triggerDetail, 160),
      status,
      reason: sanitizeLogText(entry.reason, 300),
      error: sanitizeLogText(entry.error, 300),
      durationMs: typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
        ? Math.max(0, Math.round(entry.durationMs))
        : null,
      stepsOk: Number.isInteger(entry.stepsOk) ? entry.stepsOk : 0,
      stepsTotal: Number.isInteger(entry.stepsTotal) ? entry.stepsTotal : 0,
      occurrenceKey: typeof entry.occurrenceKey === 'string' ? entry.occurrenceKey.slice(0, 200) : null,
      workspaceId: typeof entry.workspaceId === 'string' && entry.workspaceId ? entry.workspaceId : 'default',
    };
    const data = this._load();
    const next = [...data.entries, clean];
    const trimmed = next.length > this.maxEntries ? next.slice(-this.maxEntries) : next;
    atomicWriteJson(this.filePath, { entries: trimmed }, 'папка журнала запусков', 'журнал запусков');
    return clean;
  }

  list({ limit = 100, commandId = null, trigger = null, status = null } = {}) {
    const entries = this._load().entries.filter((item) => {
      if (commandId && item.commandId !== commandId) return false;
      if (trigger && item.trigger !== trigger) return false;
      if (status && item.status !== status) return false;
      return true;
    });
    const newestFirst = entries.slice().reverse();
    const max = Number.isInteger(limit) && limit > 0 ? limit : newestFirst.length;
    return newestFirst.slice(0, max);
  }

  stats() {
    const entries = this._load().entries;
    const byStatus = {};
    const byTrigger = {};
    for (const item of entries) {
      byStatus[item.status] = (byStatus[item.status] || 0) + 1;
      byTrigger[item.trigger] = (byTrigger[item.trigger] || 0) + 1;
    }
    return { total: entries.length, byStatus, byTrigger };
  }

  clear({ commandId = null } = {}) {
    const data = this._load();
    const kept = commandId ? data.entries.filter((item) => item.commandId !== commandId) : [];
    atomicWriteJson(this.filePath, { entries: kept }, 'папка журнала запусков', 'журнал запусков');
    return data.entries.length - kept.length;
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
  checkSchemaVersion(raw.schemaVersion);
  const schemaVersion = COMMAND_SCHEMA_VERSION;
  const name = checkName(raw.name);
  const program = checkProgramRef(raw.program, `${label}, программа команды`);
  const confirm = checkConfirm(raw.confirm, false);
  const phrases = checkPhrases(raw.phrases);
  // Старый файл без поля читается как команда без стартовых глаголов.
  const optionalPhrases = checkOptionalPhrases(raw.optionalPhrases);
  const origin = raw.origin === undefined
    ? 'imported'
    : checkOrigin(raw.origin, 'imported');
  const steps = checkSteps(raw.steps, { strictArgs: true, warnings, prefix: `${label}, `, blockShiftDelete: origin === 'ai' || origin === 'model' });
  const enabled = checkEnabled(raw.enabled, true);
  const { triggers, hotkey } = normalizeTriggers({ hotkey: raw.hotkey, triggers: raw.triggers }, null);
  const folder = checkFolder(raw.folder);
  const collections = checkCollections(raw.collections);
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' && len(raw.id.trim()) <= 80
    ? raw.id.trim()
    : undefined;
  const createdAt = raw.createdAt === undefined || raw.createdAt === null ? undefined : checkIso(raw.createdAt, 'createdAt');
  const command = { schemaVersion, name, program, confirm, phrases, optionalPhrases, steps, enabled, hotkey, triggers, folder, collections, origin };
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
    totalSteps += countStepNodes(command.steps);
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
      const program = checkProgramRef(cmd && cmd.program, `${label}, программа команды`);
      const confirm = checkConfirm(cmd && cmd.confirm, false);
      const phrases = checkPhrases(cmd && cmd.phrases);
      const optionalPhrases = checkOptionalPhrases(cmd && cmd.optionalPhrases);
      const rawSteps = Array.isArray(cmd.steps) ? cmd.steps : [];
      const steps = checkSteps(rawSteps, { strictArgs: true, warnings, prefix: `${label}, ` });
      const enabled = checkEnabled(cmd.enabled, true);
      const { triggers, hotkey } = normalizeTriggers({ hotkey: cmd.hotkey, triggers: cmd.triggers }, null);
      const folder = checkFolder(cmd.folder);
      const collections = checkCollections(cmd.collections);
      const origin = checkOrigin(cmd.origin, 'manual');
      const createdAt = typeof cmd.createdAt === 'string' && !Number.isNaN(Date.parse(cmd.createdAt))
        ? new Date(cmd.createdAt).toISOString()
        : null;
      const packed = {
        schemaVersion: COMMAND_SCHEMA_VERSION,
        name,
        program,
        confirm,
        phrases,
        optionalPhrases,
        steps,
        enabled,
        hotkey,
        triggers,
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
  CommandRunLog,
  normalize,
  checkHotkey,
  checkName,
  checkPhrases,
  checkOptionalPhrases,
  checkSteps,
  checkFolder,
  checkCollections,
  checkProgramRef,
  checkConfirm,
  flattenStepTree,
  flattenStepTreeWithDepth,
  countStepNodes,
  hasTreeSteps,
  resolveStepTypeAndTool,
  STEP_TYPES,
  TYPE_TO_TOOL,
  TOOL_TO_TYPE,
  MAX_TREE_DEPTH,
  checkSchemaVersion,
  normalizeTriggers,
  checkScheduleTrigger,
  checkEventTrigger,
  nextScheduleIso,
  describeScheduleTrigger,
  eventLabel,
  sanitizeLogText,
  RESERVED_HOTKEYS,
  EDITOR_STEP_TOOLS,
  DANGEROUS_TOOLS,
  EVENT_CATALOG,
  SYSTEM_EVENT_TYPES,
  SCHEDULE_TYPES,
  RUN_STATUSES,
  TRIGGER_KINDS,
  STALE_SCHEDULE_MS,
  MIN_SCHEDULE_MINUTES,
  MAX_SCHEDULE_MINUTES,
  DEFAULT_EVENT_COOLDOWN_SEC,
  MAX_COOLDOWN_SEC,
  MAX_STEPS,
  MAX_NAME,
  MAX_PHRASES,
  MAX_OPTIONAL_PHRASES,
  MAX_OPTIONAL_PHRASE,
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
