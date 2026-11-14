'use strict';

// Сборка сценария по описанию словами («собери сценарий, просто опиши словами»).
// Модуль чистый: модель, набор инструментов и само описание внедряются снаружи, сети,
// времени и случайности внутри нет — одинаковый вход даёт одинаковую команду.
// Результат — черновик схемы v2 для CommandStore.save: id и даты ставит хранилище, не этот модуль.
const {
  checkName,
  checkPhrases,
  checkSteps,
  checkHotkey,
  checkFolder,
  checkCollections,
  maskArgsForJournal,
  isSecretArgKey,
  DANGEROUS_TOOLS,
  MAX_NAME,
  MAX_PHRASES,
  MAX_STEPS,
  COMMAND_SCHEMA_VERSION,
} = require('./store');
const { looksSecret, looksSecretEgress } = require('../memory/store');

// Пределы черновика из текста: сценарий по фразе должен оставаться понятным человеку.
const MAX_STEPS_DRAFT = Math.min(12, MAX_STEPS);
const MAX_PHRASES_DRAFT = Math.min(5, MAX_PHRASES);
const MAX_TEXT = 4000;
const MAX_TOOL_LINE = 160;
const MAX_QUESTION = 300;
const MAX_QUESTIONS = 5;
const MAX_PROMPT_TOOLS = 120;
const MAX_DETAIL = 160;

// Служебные префиксы: сценарий не запускает другие сценарии и фоновые задачи (как в runner.js).
const FORBIDDEN_PREFIXES = ['mission_', 'command_'];

// Опасное в сценарии: общий список хранилища плюс то, что из описания словами не ставим никогда.
// mail_send, pc_shutdown, shell_run, app_close, ui_close_window, forget, deal_clear, cancel_reminder
// приходят из store.DANGEROUS_TOOLS, чтобы список не разошёлся с проверкой сохранения.
const DENY_TOOLS = new Set([
  ...DANGEROUS_TOOLS,
  'app_install', // установка — только с отдельным вопросом владельцу, не из сценария
  'windows_close_all', // закрыть все окна разом
  'window_close_active', // закрыть окно сверху: в сценарии не пишем, только по фразе владельца
]);

// Человеческие подписи инструментов для предпросмотра. Неизвестный инструмент показываем как есть.
const STEP_TITLES = {
  app_open: 'Открыть программу',
  app_close: 'Закрыть программу',
  app_search: 'Найти программу',
  app_install: 'Установить программу',
  url_open: 'Открыть ссылку',
  ui_click: 'Нажать элемент',
  ui_type: 'Ввести текст',
  ui_keys: 'Нажать клавиши',
  ui_focus: 'Переключить окно',
  ui_set_toggle: 'Переключить флажок',
  ui_wait: 'Дождаться элемента',
  ui_windows: 'Список окон',
  ui_elements: 'Элементы окна',
  desktop_observe: 'Посмотреть рабочий стол',
  desktop_click: 'Нажать на рабочем столе',
  desktop_type: 'Ввести текст на рабочем столе',
  windows_list: 'Список окон',
  windows_focus: 'Переключить окно',
  windows_arrange: 'Разложить окна',
  windows_minimize_all: 'Свернуть все окна',
  windows_restore_all: 'Вернуть окна',
  mouse_click: 'Клик мышью',
  mouse_scroll: 'Прокрутка',
  wait: 'Подождать',
  wait_for: 'Дождаться условия',
  speak: 'Сказать',
  volume_set: 'Задать громкость',
  media_control: 'Управлять плеером',
  browser_open: 'Открыть страницу',
  browser_read: 'Прочитать страницу',
  browser_scroll: 'Прокрутить страницу',
  browser_click: 'Нажать на странице',
  browser_type: 'Ввести текст на странице',
  web_search: 'Найти в интернете',
  web_wiki: 'Найти в Википедии',
  web_fetch: 'Прочитать страницу',
  web_research: 'Исследовать вопрос',
  clipboard_get: 'Прочитать буфер',
  clipboard_set: 'Положить в буфер',
  screen_look: 'Посмотреть экран',
  image_read_text: 'Прочитать текст с картинки',
  image_look: 'Посмотреть картинку',
  document_read: 'Прочитать документ',
  document_write: 'Записать документ',
  workspace_read: 'Прочитать файл',
  workspace_list: 'Список файлов',
  workspace_search: 'Поиск в файлах',
  project_brief: 'Разобрать проект',
  remember: 'Запомнить',
  recall: 'Вспомнить',
  memory_about: 'Вспомнить о человеке',
  disk_free_space: 'Свободное место',
  disk_cleanup_suggest: 'Предложить уборку',
  weather_now: 'Погода',
  currency_rate: 'Курс валют',
  youtube_play: 'Включить видео',
};

// Поле аргумента, которое лучше всего описывает шаг в предпросмотре.
const STEP_DETAIL_FIELDS = {
  app_open: 'name',
  app_close: 'name',
  app_search: 'query',
  app_install: 'name',
  url_open: 'url',
  ui_click: 'name',
  ui_type: 'text',
  ui_keys: 'keys',
  ui_focus: 'window',
  ui_wait: 'name',
  ui_elements: 'window',
  desktop_observe: '',
  desktop_click: 'name',
  desktop_type: 'text',
  windows_list: '',
  windows_focus: 'title',
  windows_arrange: 'layout',
  mouse_click: '',
  mouse_scroll: 'amount',
  wait: 'ms',
  wait_for: 'ms',
  speak: 'text',
  volume_set: 'percent',
  media_control: 'action',
  browser_open: 'url',
  browser_read: 'selector',
  browser_scroll: 'direction',
  browser_click: 'selector',
  browser_type: 'text',
  web_search: 'query',
  web_wiki: 'query',
  web_fetch: 'url',
  web_research: 'query',
  clipboard_get: '',
  clipboard_set: 'text',
  screen_look: '',
  image_read_text: 'path',
  image_look: 'path',
  document_read: 'path',
  document_write: 'path',
  workspace_read: 'path',
  workspace_list: 'path',
  workspace_search: 'query',
  project_brief: 'path',
  remember: 'text',
  recall: 'query',
  memory_about: 'query',
  disk_free_space: 'path',
  disk_cleanup_suggest: 'path',
  weather_now: 'city',
  currency_rate: 'currency',
  youtube_play: 'query',
};

const clip = (text, max) => {
  const chars = Array.from(String(text));
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
};

const quote = (value) => `«${clip(value, MAX_TOOL_LINE)}»`;

function briefJson(value) {
  if (!value || typeof value !== 'object') return '';
  try {
    const text = JSON.stringify(value);
    return text && text !== '{}' ? clip(text, MAX_DETAIL) : '';
  } catch {
    return '';
  }
}

// Набор инструментов снаружи может быть Set, массивом имён или описаний, Map или объектом-словарём,
// а также функцией, которая всё это возвращает (как knownTools в src/tools/commands.js).
function toolSourceOf(source) {
  if (source && source.names instanceof Set && source.defs instanceof Map) return source;
  const value = typeof source === 'function' ? source() : source;
  const names = new Set();
  const defs = new Map();
  const add = (name, def) => {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (!clean) return;
    names.add(clean);
    if (def && typeof def === 'object' && !Array.isArray(def)) defs.set(clean, def);
  };
  if (value instanceof Set) {
    for (const item of value) add(item);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') add(item);
      else if (item && typeof item === 'object') add(item.name, item);
    }
  } else if (value && typeof value.values === 'function') {
    for (const [name, def] of value) add(name, def);
  } else if (value && typeof value === 'object') {
    for (const [name, def] of Object.entries(value)) add(name, def);
  }
  return { names, defs };
}

// Почему инструмент нельзя ставить в сценарий, или null.
function deniedReason(tool) {
  if (DENY_TOOLS.has(tool)) return `«${tool}» — опасное действие, в сценарий не ставится`;
  const prefix = FORBIDDEN_PREFIXES.find((value) => tool.startsWith(value));
  if (prefix) return `«${tool}» — сценарий не запускает другие сценарии и фоновые задачи`;
  return null;
}

// Вопросы владельцу из ответа модели: короткие строки без дублей, иначе они разрастутся в окне.
function cleanQuestions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const clean = item.replace(/\s+/g, ' ').trim();
    if (!clean || out.includes(clean)) continue;
    out.push(clip(clean, MAX_QUESTION));
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

function failResult(errors, questions = []) {
  return {
    ok: false,
    command: null,
    questions,
    errors: errors.slice(),
    error: errors.join('; '),
  };
}

function normalMaxSteps(value) {
  if (!Number.isInteger(value) || value < 1) return MAX_STEPS_DRAFT;
  return Math.min(value, MAX_STEPS);
}

// Имя: та же проверка, что при сохранении (тип, пустота, длина).
function checkDraftName(draft, errors) {
  try {
    return checkName(draft.name);
  } catch (err) {
    errors.push(err.message);
    return null;
  }
}

// Фразы: 1..5, без дублей после нормализации. Нормализацию и лимиты делает store.
function checkDraftPhrases(draft, errors, questions) {
  const raw = draft.phrases;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`фразы: нужна хотя бы одна фраза (1..${MAX_PHRASES_DRAFT})`);
    questions.push('Какими словами запускать сценарий?');
    return [];
  }
  if (raw.length > MAX_PHRASES_DRAFT) {
    errors.push(`фраз не больше ${MAX_PHRASES_DRAFT}`);
    return [];
  }
  try {
    return checkPhrases(raw);
  } catch (err) {
    errors.push(err.message);
    return [];
  }
}

// Обязательные поля и лишние имена аргументов — только если снаружи переданы описания инструментов.
function checkStepAgainstDef(step, def, n, errors, warnings) {
  const parameters = def && def.parameters;
  if (!parameters || typeof parameters !== 'object') return;
  const props = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {};
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  for (const key of required) {
    const value = step.args[key];
    if (value === undefined || value === null || value === '') {
      errors.push(`шаг ${n}: «${key}» — обязательное поле у «${step.tool}»`);
    }
  }
  const described = Object.keys(props);
  if (described.length === 0) return;
  for (const key of Object.keys(step.args)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) {
      warnings.push(`шаг ${n}: «${key}» не описан у «${step.tool}»`);
    }
  }
}

// Один шаг: объект {tool, args}, известный и разрешённый инструмент, args — простой JSON-объект.
// Типы, длина и вложенность аргументов проверяются тем же кодом, что и сохранение сценария.
function checkDraftStep(step, n, { names, defs }, errors, questions, warnings) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    errors.push(`шаг ${n}: нужен объект {tool, args}`);
    questions.push('Какие действия должны быть в сценарии?');
    return null;
  }
  if (typeof step.tool !== 'string' || step.tool.trim() === '') {
    errors.push(`шаг ${n}: нужно имя инструмента`);
    questions.push('Какие действия должны быть в сценарии?');
    return null;
  }
  const tool = step.tool.trim();
  const denied = deniedReason(tool);
  if (denied) {
    errors.push(`шаг ${n}: ${denied}`);
    questions.push(`Чем заменить «${tool}»?`);
    return null;
  }
  if (!names.has(tool)) {
    const available = [...names]
      .filter((name) => !deniedReason(name))
      .sort()
      .slice(0, 8)
      .join(', ');
    errors.push(`шаг ${n}: нет такого инструмента «${tool}»${available ? `; доступны: ${available}` : ''}`);
    questions.push(`Действия «${tool}» нет — чем его заменить?`);
    return null;
  }
  try {
    const [checked] = checkSteps([{ tool, args: step.args }]);
    checkStepAgainstDef(checked, defs.get(tool), n, errors, warnings);
    return checked;
  } catch (err) {
    errors.push(String(err.message).replace(/^шаг 1:\s*/, `шаг ${n}: `));
    return null;
  }
}

// Шаги: 1..maxSteps, каждый проходит проверку инструмента и аргументов.
function checkDraftSteps(draft, source, maxSteps, errors, questions, warnings) {
  const raw = draft.steps;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`шаги: нужен хотя бы один шаг (1..${maxSteps})`);
    questions.push('Что должно происходить по шагам?');
    return [];
  }
  if (raw.length > maxSteps) {
    errors.push(`шагов не больше ${maxSteps}`);
    questions.push('Сценарий длиннее предела — какие шаги оставить?');
    return [];
  }
  const clean = [];
  raw.forEach((step, index) => {
    const checked = checkDraftStep(step, index + 1, source, errors, questions, warnings);
    if (checked) clean.push(checked);
  });
  return clean;
}

// Необязательные поля схемы v2: горячая клавиша, папка, коллекции, включённость.
function checkOptionalFields(draft, errors) {
  const out = { enabled: true, hotkey: null, folder: null, collections: [] };
  if (draft.enabled !== undefined) {
    if (typeof draft.enabled !== 'boolean') errors.push('enabled: нужно true или false');
    else out.enabled = draft.enabled;
  }
  if (draft.hotkey !== undefined && draft.hotkey !== null && draft.hotkey !== '') {
    try {
      out.hotkey = checkHotkey(draft.hotkey);
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (draft.folder !== undefined) {
    try {
      out.folder = checkFolder(draft.folder);
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (draft.collections !== undefined) {
    try {
      out.collections = checkCollections(draft.collections);
    } catch (err) {
      errors.push(err.message);
    }
  }
  return out;
}

// Проверка ответа модели и превращение его в команду схемы v2. Ничего не сохраняет и не запускает.
// tools — откуда брать имена (Set, массив, Map, объект или функция), maxSteps — предел шагов.
function validateDraft(draft, { tools, maxSteps = MAX_STEPS_DRAFT } = {}) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return failResult(['черновик: нужен объект с полями name, phrases, steps']);
  }
  // Терпим обёртку {"command": {...}} из чат-ответа модели, но не глубже одного уровня.
  const raw = draft.command
    && typeof draft.command === 'object'
    && !Array.isArray(draft.command)
    && draft.name === undefined
    && draft.steps === undefined
    ? draft.command
    : draft;
  const asked = cleanQuestions(raw.questions);
  const hasCore = raw.name !== undefined && raw.steps !== undefined;
  if (asked.length && !hasCore) {
    return {
      ok: false,
      command: null,
      questions: asked,
      errors: [],
      error: `нужно уточнить: ${asked.join('; ')}`,
    };
  }

  const limit = normalMaxSteps(maxSteps);
  const source = toolSourceOf(tools);
  const errors = [];
  const questions = [];
  const warnings = [];

  const name = checkDraftName(raw, errors);
  const phrases = checkDraftPhrases(raw, errors, questions);
  const steps = checkDraftSteps(raw, source, limit, errors, questions, warnings);
  const optional = checkOptionalFields(raw, errors);

  if (errors.length) return failResult(errors, questions);

  return {
    ok: true,
    command: {
      schemaVersion: COMMAND_SCHEMA_VERSION,
      name,
      phrases,
      steps,
      enabled: optional.enabled,
      hotkey: optional.hotkey,
      folder: optional.folder,
      collections: optional.collections,
      // Происхождение ставим сами: сценарий собран моделью по описанию, что бы она ни написала.
      origin: 'ai',
    },
    questions: [],
    errors: [],
    warnings,
    error: null,
  };
}

// ── Вызов модели ─────────────────────────────────────────────────

// Жёсткий контракт ответа: только JSON с name, phrases и steps (или questions, если описание неясное).
function buildPrompt(text, source, { maxSteps = MAX_STEPS_DRAFT } = {}) {
  const limit = normalMaxSteps(maxSteps);
  const allowed = [...source.names].filter((name) => !deniedReason(name)).sort();
  const lines = [
    'Ты помогаешь собрать сценарий Nox Assistant по описанию владельца словами.',
    'Сценарий — это последовательность шагов {tool, args}; потом он запускается по фразе без модели.',
    'Ответ — ТОЛЬКО JSON без пояснений, без разметки и без текста вокруг.',
    '',
    'Формат ответа:',
    '{"name":"краткое имя","phrases":["фраза запуска"],"steps":[{"tool":"имя_инструмента","args":{}}]}',
    '',
    `Правила: фраз от 1 до ${MAX_PHRASES_DRAFT}; шагов от 1 до ${limit}; имя до 80 символов;`,
    'инструменты — только из списка ниже, новые имена придумывать нельзя;',
    'опасные действия (удаление, отправка, оплата, установка, выключение, закрытие окон) запрещены;',
    'аргументы — только числа, строки и true/false, без лишних полей;',
    'если описание неясное — верни {"questions":["вопрос владельцу"]} без шагов.',
    '',
    `Доступные инструменты (${allowed.length}):`,
  ];
  const shown = allowed.slice(0, MAX_PROMPT_TOOLS).map((name) => {
    const def = source.defs.get(name);
    const note = def && typeof def.description === 'string' ? clip(def.description.replace(/\s+/g, ' '), 110) : '';
    const risk = def && typeof def.risk === 'string' ? ` (${def.risk})` : '';
    return `- ${name}${risk}${note ? `: ${note}` : ''}`;
  });
  lines.push(...shown);
  if (allowed.length > MAX_PROMPT_TOOLS) {
    lines.push(`- и ещё: ${allowed.slice(MAX_PROMPT_TOOLS).join(', ')}`);
  }
  lines.push('', 'Описание владельца:', clip(text, MAX_TEXT));
  return lines.join('\n');
}

// Ответ модели → объект черновика. Принимаем чистый JSON, JSON в ```-блоке и JSON с текстом вокруг.
function parseModelJson(response) {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    return { ok: true, draft: response };
  }
  if (typeof response !== 'string') return { ok: false, error: 'модель вернула не текст и не объект' };
  const text = response.replace(/^\uFEFF/, '').trim();
  if (text === '') return { ok: false, error: 'модель вернула пустой ответ' };
  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    if (candidate === '') continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, draft: parsed };
      }
    } catch {
      // Пробуем следующий вариант: модель могла добавить пояснение вокруг JSON.
    }
  }
  return { ok: false, error: 'ответ модели не JSON' };
}

// Сборка сценария из описания: один вызов модели и один повтор, если ответ не прошёл проверку.
// modelCall(prompt, { attempt }) — внедрённая функция: возвращает текст ответа модели (или объект).
// Возвращает { ok, command, questions, error, attempts }. Ничего не сохраняет и не запускает.
async function buildCommandFromText({ text, modelCall, tools, maxSteps = MAX_STEPS_DRAFT } = {}) {
  const ownerText = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (ownerText === '') {
    return {
      ok: false,
      command: null,
      questions: ['Опишите сценарий словами: что и в каком порядке делать?'],
      error: 'нужно описание сценария словами',
      attempts: 0,
    };
  }
  if (typeof modelCall !== 'function') {
    return { ok: false, command: null, questions: [], error: 'builder: не передана функция модели (modelCall)', attempts: 0 };
  }
  if (tools === undefined || tools === null) {
    return { ok: false, command: null, questions: [], error: 'builder: не передан набор инструментов', attempts: 0 };
  }

  const source = toolSourceOf(tools);
  const basePrompt = buildPrompt(ownerText, source, { maxSteps });
  const totalAttempts = 2; // одна попытка и один повтор: больше — лишние расходы владельца
  let lastError = '';
  let lastQuestions = [];
  let feedback = '';

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    let response;
    try {
      response = await modelCall(attempt === 1 ? basePrompt : `${basePrompt}${feedback}`, {
        attempt,
        errors: lastError ? [lastError] : [],
      });
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      return { ok: false, command: null, questions: lastQuestions, error: `модель не ответила: ${reason}`, attempts: attempt };
    }

    const parsed = parseModelJson(response);
    const checked = parsed.ok
      ? validateDraft(parsed.draft, { tools: source, maxSteps })
      : failResult([parsed.error]);

    if (checked.ok) {
      return { ok: true, command: checked.command, questions: [], error: null, attempts: attempt };
    }

    lastError = checked.error || 'ответ не подошёл';
    lastQuestions = checked.questions || [];
    // Модель задала вопросы владельцу — повтор не поможет, отдаём их честно.
    if (lastQuestions.length && checked.errors.length === 0) {
      return { ok: false, command: null, questions: lastQuestions, error: lastError, attempts: attempt };
    }
    feedback = `\n\nПрошлая попытка не подошла: ${lastError}.\nВерни исправленный JSON строго по контракту, без пояснений.`;
  }

  return {
    ok: false,
    command: null,
    questions: lastQuestions,
    error: `не удалось собрать сценарий: ${lastError}`,
    attempts: totalAttempts,
  };
}

// ── Предпросмотр ─────────────────────────────────────────────────

function describeValue(field, value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'number') {
    if (field === 'percent') return `${value}%`;
    if (field === 'ms') return `${value} мс`;
    return String(value);
  }
  return briefJson(value);
}

// Человеческая подпись шага: название действия и понятная часть аргументов. Ничего не выполняет.
function describeStep(step, n, { names }) {
  const tool = step && typeof step.tool === 'string' ? step.tool.trim() : '';
  const rawArgs = step && step.args && typeof step.args === 'object' && !Array.isArray(step.args) ? step.args : {};
  const args = maskArgsForJournal(tool, rawArgs);
  const notes = [];
  if (!tool) {
    notes.push('шаг без имени инструмента');
  } else {
    const denied = deniedReason(tool);
    if (denied) notes.push(denied);
    else if (names.size > 0 && !names.has(tool)) notes.push(`инструмента «${tool}» нет в текущем наборе`);
  }
  const title = STEP_TITLES[tool] || tool || 'Шаг';
  const field = typeof STEP_DETAIL_FIELDS[tool] === 'string' ? STEP_DETAIL_FIELDS[tool] : '';
  const parts = [];
  if (field) {
    const detail = describeValue(field, args[field]);
    if (detail) parts.push(detail);
  }
  if (args.window !== undefined && field !== 'window') {
    const window = describeValue('window', args.window);
    if (window) parts.push(`окно ${window}`);
  }
  if (parts.length === 0) {
    const brief = briefJson(args);
    if (brief) parts.push(brief);
  }
  const detail = clip(parts.join(', '), MAX_DETAIL);
  const text = `${n}. ${title}${detail ? `: ${detail}` : ''}`;
  return { n, tool: tool || null, title, detail, text, notes };
}

// Предпросмотр сценария: подписи шагов для окна и владельца. Никакого запуска и сохранения.
// tools необязательны: с ними шаги, которых нет в наборе, помечаются предупреждением.
function dryRunCommand(command, { tools } = {}) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return { ok: false, error: 'показывать нечего: нужен объект сценария', steps: [], warnings: [], text: '', saved: false, executed: false };
  }
  const steps = Array.isArray(command.steps) ? command.steps : [];
  if (steps.length === 0) {
    return { ok: false, error: 'у сценария нет шагов', steps: [], warnings: [], text: '', saved: false, executed: false };
  }

  const names = toolSourceOf(tools).names;
  const warnings = [];
  const described = steps.map((step, index) => {
    const item = describeStep(step, index + 1, { names });
    for (const note of item.notes) warnings.push(`шаг ${index + 1}: ${note}`);
    return { n: item.n, tool: item.tool, title: item.title, detail: item.detail, text: item.text, warnings: item.notes.slice() };
  });

  const name = typeof command.name === 'string' ? command.name.trim() : '';
  const phrases = Array.isArray(command.phrases) ? command.phrases.map((p) => String(p)).filter(Boolean) : [];
  const head = [
    name ? `Сценарий «${clip(name, MAX_TOOL_LINE)}»` : 'Сценарий',
    phrases.length ? `фразы: ${phrases.map((p) => quote(p)).join(', ')}` : '',
    `шагов: ${described.length}`,
  ].filter(Boolean).join('. ');
  const lines = [`${head}.`];
  for (const item of described) lines.push(item.text);
  if (warnings.length) lines.push(`Замечания: ${warnings.join('; ')}.`);

  return {
    ok: true,
    name: name || null,
    phrases,
    steps: described,
    warnings,
    text: lines.join('\n'),
    saved: false,
    executed: false,
  };
}

// Инструменты только чтения/наблюдения: сами по себе повторяемой командой не считаются,
// но если в ходе есть хотя бы одно реальное действие, вспомогательный осмотр просто отсеиваем.
const READ_ONLY_INSPECTION_TOOLS = new Set([
  'ui_windows',
  'ui_elements',
  'desktop_observe',
  'windows_list',
  'screen_look',
  'screen_region_look',
  'image_look',
  'image_read_text',
  'clipboard_get',
  'workspace_read',
  'workspace_list',
  'workspace_search',
  'document_read',
  'document_batch',
  'project_brief',
  'project_diagnostics',
  'project_commands',
  'code_read',
  'web_search',
  'web_wiki',
  'web_fetch',
  'web_research',
  'web_check_claims',
  'browser_read',
  'browser_tab_read',
  'browser_tabs',
  'browser_snapshot',
  'recall',
  'memory_about',
  'disk_free_space',
  'disk_cleanup_suggest',
  'weather_now',
  'currency_rate',
  'calendar_upcoming',
  'calendar_briefing',
  'calendar_prep',
  'mail_unread',
  'apps_find',
  'apps_scan',
  'apps_usage',
  'app_search',
  'deals_hanging',
  'list_reminders',
  'library_list',
  'skills_list',
  'skill_read',
  'goal_list',
  'long_task_list',
  'task_list',
  'command_list',
]);

const MAX_TURN_PHRASE = 200;
const MAX_COMMAND_PHRASE = 120;
const URL_CRED_RE = /^[a-z]+:\/\/[^/@\s]+:[^/@\s]*@/i;
const URL_SECRET_QUERY_RE = /[?&#](?:password|passwd|pwd|secret|token|api_?key|apikey|access_?token|refresh_?token|auth|otp|totp|code)=[^&#\s]+/i;
const FAILED_TURN_STATUSES = new Set(['error', 'failed', 'refused', 'unverified', 'cancelled', 'canceled', 'pending', 'running', 'skipped']);

function clipWords(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  const sliced = chars.slice(0, maxChars).join('');
  const lastSpace = sliced.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(maxChars * 0.5) ? sliced.slice(0, lastSpace) : sliced;
  return cut.replace(/[\s,.;:!?-]+$/u, '').trim() || sliced.trim();
}

function normalizeDraftPhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.!?]+$/u, '');
}

function stringLooksSecret(value, keyName = '') {
  const s = String(value ?? '');
  if (!s) return false;
  if (keyName === 'url' && /^https?:\/\//i.test(s)) {
    return URL_CRED_RE.test(s) || URL_SECRET_QUERY_RE.test(s) || looksSecretEgress(s);
  }
  return looksSecret(s) || looksSecretEgress(s);
}

function argsContainSecret(value, keyName = '', depth = 0) {
  if (depth > 10 || value === null || value === undefined) return false;
  if (typeof value === 'string') return stringLooksSecret(value, keyName);
  if (Array.isArray(value)) return value.some((item) => argsContainSecret(item, keyName, depth + 1));
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (isSecretArgKey(k)) return true;
      if (argsContainSecret(v, k, depth + 1)) return true;
    }
  }
  return false;
}

function clonePlainArgs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  try {
    const parsed = JSON.parse(JSON.stringify(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nameKey(name) {
  return String(name || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

function buildHumanCommandName(rawPhrase, firstStep, existingCommands) {
  let candidate = String(rawPhrase || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:джарвис|nox)[,:\s]+/iu, '')
    .replace(/[.!?]+$/u, '')
    .trim();
  if (!candidate) {
    candidate = STEP_TITLES[firstStep.tool] || 'Быстрая команда';
  }
  const chars = Array.from(candidate);
  candidate = `${chars[0].toUpperCase()}${chars.slice(1).join('')}`;
  candidate = clipWords(candidate, Math.min(64, MAX_NAME - 8));
  if (!candidate) candidate = STEP_TITLES[firstStep.tool] || 'Быстрая команда';

  const used = new Set();
  if (Array.isArray(existingCommands)) {
    for (const cmd of existingCommands) {
      const k = nameKey(cmd && cmd.name);
      if (k) used.add(k);
    }
  }
  if (!used.has(nameKey(candidate))) return candidate;

  let n = 2;
  while (n < 1000) {
    const suffix = ` (${n})`;
    const base = clipWords(candidate, MAX_NAME - Array.from(suffix).length);
    const next = `${base}${suffix}`;
    if (!used.has(nameKey(next))) return next;
    n += 1;
  }
  return candidate;
}

/**
 * Собирает черновик команды (схема v2) из успешных повторяемых шагов завершённого хода.
 * Чистая функция: не пишет на диск, отбрасывает ошибки, опасные шаги, чистый просмотр и секреты.
 */
function draftCommandFromTurn({ phrase, actions, existingCommands } = {}) {
  if (typeof phrase !== 'string') {
    return { ok: false, reason: 'Нужна фраза запуска команды' };
  }
  const rawPhrase = phrase.trim();
  if (!rawPhrase) {
    return { ok: false, reason: 'Нужна фраза запуска команды' };
  }
  if (Array.from(rawPhrase).length > MAX_TURN_PHRASE) {
    return { ok: false, reason: `Фраза слишком длинная (не больше ${MAX_TURN_PHRASE} символов)` };
  }
  if (looksSecret(rawPhrase) || looksSecretEgress(rawPhrase)) {
    return { ok: false, reason: 'В фразе обнаружены пароль или секретный ключ — команду не создаём' };
  }

  let normalizedPhrase = normalizeDraftPhrase(rawPhrase);
  if (!normalizedPhrase) {
    return { ok: false, reason: 'Нужна фраза запуска команды' };
  }
  if (Array.from(normalizedPhrase).length > MAX_COMMAND_PHRASE) {
    normalizedPhrase = clipWords(normalizedPhrase, MAX_COMMAND_PHRASE);
  }
  let phrases;
  try {
    phrases = checkPhrases([normalizedPhrase]);
  } catch (err) {
    return { ok: false, reason: err.message || 'Неподходящая фраза запуска' };
  }

  if (!Array.isArray(actions) || actions.length === 0) {
    return { ok: false, reason: 'В этом ответе нет выполненных шагов для команды' };
  }

  let sawSecret = false;
  let sawDenied = false;
  let sawReadOnly = false;
  let sawFailed = false;
  const candidateSteps = [];

  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const tool = typeof action.tool === 'string' ? action.tool.trim() : '';
    if (!tool) continue;

    const st = typeof action.status === 'string' ? action.status.trim().toLowerCase() : '';
    if (action.ok === false || FAILED_TURN_STATUSES.has(st)) {
      sawFailed = true;
      continue;
    }
    if (st !== 'confirmed' && st !== 'done' && !(st === '' && action.ok === true)) {
      continue;
    }

    const denied = deniedReason(tool);
    if (denied) {
      sawDenied = true;
      continue;
    }
    if (READ_ONLY_INSPECTION_TOOLS.has(tool)) {
      sawReadOnly = true;
      continue;
    }

    const cleanArgs = clonePlainArgs(action.args);
    if (argsContainSecret(cleanArgs)) {
      sawSecret = true;
      continue;
    }
    candidateSteps.push({ tool, args: cleanArgs });
  }

  if (candidateSteps.length === 0) {
    if (sawSecret) return { ok: false, reason: 'В шагах обнаружен пароль или ключ — такую команду не сохраняем' };
    if (sawDenied) return { ok: false, reason: 'Опасные или разовые шаги в повторяемую команду не сохраняются' };
    if (sawReadOnly) return { ok: false, reason: 'В ходе был только просмотр без повторяемого действия' };
    if (sawFailed) return { ok: false, reason: 'Неподтверждённые или неудавшиеся шаги нельзя сохранить как команду' };
    return { ok: false, reason: 'Нет подходящих повторяемых действий для сохранения' };
  }

  let steps;
  try {
    steps = checkSteps(candidateSteps.slice(0, MAX_STEPS));
  } catch (err) {
    return { ok: false, reason: err.message || 'Шаги не прошли проверку безопасности' };
  }

  let name;
  try {
    name = checkName(buildHumanCommandName(rawPhrase, steps[0], existingCommands));
  } catch (err) {
    return { ok: false, reason: err.message || 'Некорректное имя команды' };
  }

  return {
    ok: true,
    draft: {
      schemaVersion: COMMAND_SCHEMA_VERSION,
      version: COMMAND_SCHEMA_VERSION,
      kind: 'sequence',
      name,
      phrases,
      steps,
      enabled: true,
      hotkey: null,
      folder: null,
      collections: [],
      origin: 'ai',
    },
  };
}

module.exports = {
  validateDraft,
  buildCommandFromText,
  dryRunCommand,
  draftCommandFromTurn,
  buildPrompt,
  parseModelJson,
  toolSourceOf,
  DENY_TOOLS,
  MAX_STEPS_DRAFT,
  MAX_PHRASES_DRAFT,
};
