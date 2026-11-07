'use strict';

// Мандат автономной задачи: цель, разрешённые инструменты и папки, срок действия, лимиты и бюджет.
// Мандат создаётся до старта и показывается владельцу (summarize). approvedBy ставит вызывающий код после подтверждения.
// Каждый вызов инструмента внутри задачи должен проходить checkTool: срок, имя, путь. Всё, что не разрешено явно, запрещено.
// Для workspace_* настоящий путь проверяет переданная функция resolve (см. WorkspaceIndex.resolveInside);
// для code_* — realpath папок мандата и файла (realFoldersProblem, resolveCodePath в tools/code.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveCodePath, CODE_TOOL_NAMES } = require('../tools/code');

// Белый список: файлы в песочнице, чтение интернета и исходники в папках мандата (code_*: запуск — только тесты из белого списка, code_test).
// Ничего другого автономная задача не получает.
const ALLOWED_TOOLS = Object.freeze([
  'workspace_list', 'workspace_read', 'workspace_search', 'workspace_write', 'document_read', 'document_write',
  'project_brief', 'project_diagnostics',
  'web_search', 'web_fetch', 'web_wiki', 'web_research', 'web_check_claims',
  'code_read', 'code_write', 'code_edit', 'code_test',
]);

// Подписи для владельца: что на деле разрешает инструмент.
const TOOL_LABELS = {
  workspace_list: 'список файлов',
  workspace_read: 'чтение файлов',
  workspace_search: 'поиск по файлам',
  workspace_write: 'запись файлов',
  document_read: 'чтение документов',
  document_write: 'запись документов',
  project_brief: 'разбор папки проекта',
  project_diagnostics: 'чтение ошибок из журнала проекта',
  web_search: 'поиск в интернете',
  web_fetch: 'чтение веб-страниц',
  web_wiki: 'справка из Википедии',
  web_research: 'поиск и чтение нескольких источников',
  web_check_claims: 'проверка утверждений по собранным источникам',
  code_read: 'чтение исходников',
  code_write: 'создание исходников',
  code_edit: 'правка исходников',
  code_test: 'запуск тестов',
};

const DEFAULTS = Object.freeze({
  maxSteps: 100, // шагов в задаче
  maxFailuresPerStep: 3, // неудач подряд на одном шаге
  maxActiveMs: 4 * 60 * 60 * 1000, // 4 часа активной работы
  maxTokens: 300000, // токенов модели на всю задачу
  budgetUsd: 0.25, // денег на всю задачу
  expiresInMs: 24 * 60 * 60 * 1000, // мандат действует сутки
});

const MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STEPS = 100;
const MAX_ACTIVE_MS = 4 * 60 * 60 * 1000;
const MAX_BUDGET_USD = 1;
const MAX_FAILURES_PER_STEP = 3;
const MAX_TOKENS = 1000000;
const MAX_GOAL = 2000;

// Лимиты: целое число в диапазоне [min, max]. Вне диапазона — ошибка, а не подмена.
const LIMITS = {
  maxSteps: { min: 1, max: MAX_STEPS, label: 'шагов' },
  maxFailuresPerStep: { min: 1, max: MAX_FAILURES_PER_STEP, label: 'неудач подряд на шаге' },
  maxActiveMs: { min: 1, max: MAX_ACTIVE_MS, label: 'активного времени в мс' },
  maxTokens: { min: 1, max: MAX_TOKENS, label: 'токенов' },
};

// Папки кода отдельно не задаются: code_* работают только в папках мандата (folders), а их без явного списка нет.
const OPTIONS = ['goal', 'tools', 'folders', 'sandboxRoot', 'now', 'expiresInMs', 'limits', 'budgetUsd', 'dailyBudgetUsd'];

// Жёсткий запрет: эти инструменты не попадают в мандат и не проходят checkTool, даже если их указали явно.
// shell_run и library_run выходят за песочницу; lib_* — скрипты библиотеки; task_* — управление задачами,
// это дело исполнителя, а не модели. Слова-действия необратимы или выходят за пределы владельца.
const BANNED_NAMES = ['shell_run', 'library_run'];
const BANNED_PREFIXES = ['lib_', 'task_'];
const BANNED_WORDS = /(?:^|_)(?:send|publish|delete|remove|post|upload|push|pay|transfer|purchase|buy)(?:_|$)/;

function fail(message) {
  const err = new Error(message);
  err.code = 'mandate_error';
  throw err;
}

// Имя к одному виду, чтобы запрет не обходился написанием: sendMessage, Send-Message → send_message.
function normalizeName(name) {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isHardBanned(name) {
  if (typeof name !== 'string') return true;
  const n = normalizeName(name);
  if (!n) return true;
  return BANNED_NAMES.includes(n) || BANNED_PREFIXES.some((p) => n.startsWith(p)) || BANNED_WORDS.test(n);
}

const pathKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// abs совпадает с dir или лежит внутри. Префикс с разделителем: «workspace2» не внутри «workspace».
function isWithin(dir, abs) {
  if (typeof dir !== 'string' || !dir || typeof abs !== 'string' || !abs) return false;
  const d = pathKey(path.resolve(dir));
  const a = pathKey(path.resolve(abs));
  if (a === d) return true;
  const prefix = d.endsWith(path.sep) ? d : d + path.sep;
  return a.startsWith(prefix);
}

// Чужой текст в сообщениях об ошибках — не длиннее 200 символов.
function clip(value) {
  const s = String(value);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function checkTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) fail('нужен непустой список инструментов');
  const list = [];
  for (const name of tools) {
    if (typeof name !== 'string' || !name) fail('имя инструмента должно быть непустой строкой');
    if (isHardBanned(name)) fail(`инструмент «${clip(name)}» запрещён для автономных задач всегда`);
    if (!ALLOWED_TOOLS.includes(name)) {
      fail(`инструмент «${clip(name)}» не входит в разрешённые для автономных задач: ${ALLOWED_TOOLS.join(', ')}`);
    }
    if (!list.includes(name)) list.push(name);
  }
  return list;
}

// Папки — внутри песочницы или сама песочница. Относительные считаются от песочницы; «..» не выводит наружу.
function checkFolders(folders, root) {
  if (!Array.isArray(folders) || folders.length === 0) fail('нужна хотя бы одна папка');
  const list = [];
  const seen = new Set();
  for (const folder of folders) {
    if (typeof folder !== 'string' || !folder.trim()) fail('папка должна быть непустой строкой');
    const abs = path.resolve(root, folder);
    if (!isWithin(root, abs)) fail(`папка «${clip(folder)}» вне песочницы ${root}`);
    if (!seen.has(pathKey(abs))) {
      seen.add(pathKey(abs));
      list.push(abs);
    }
  }
  return list;
}

const hasCodeTools = (tools) => Array.isArray(tools) && tools.some((t) => CODE_TOOL_NAMES.includes(t));

function realpath(p) {
  return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

// Папки мандата после раскрытия ссылок (symlink, junction) — внутри реальной песочницы. null — всё в порядке,
// иначе причина. Несуществующая папка не проверяется: она ничего не разрешает (resolveCodePath её пропустит).
// Нужна инструментам кода: resolveCodePath доверяет реальному пути разрешённой папки, и junction «папка → проект»
// иначе открыл бы проект. Вызывается при поручении (runtime) и при каждом вызове code_* (checkTool).
function realFoldersProblem(mandate) {
  if (!mandate || typeof mandate.root !== 'string' || !mandate.root) return 'в мандате нет корня песочницы';
  const folders = Array.isArray(mandate.folders) ? mandate.folders : [];
  if (folders.length === 0) return 'в мандате нет папок';
  let realRoot;
  try {
    realRoot = realpath(mandate.root);
  } catch {
    return `песочница ${mandate.root} недоступна`;
  }
  for (const folder of folders) {
    if (typeof folder !== 'string' || !isWithin(mandate.root, folder)) return `папка мандата «${clip(folder)}» вне песочницы`;
    let real;
    try {
      real = realpath(folder);
    } catch {
      continue;
    }
    if (!isWithin(realRoot, real)) return `папка мандата «${clip(folder)}» после раскрытия ссылок (symlink, junction) ведёт за пределы песочницы`;
  }
  return null;
}

function checkLimits(limits) {
  if (typeof limits !== 'object' || Array.isArray(limits)) fail('limits должен быть объектом');
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(LIMITS, key)) fail(`неизвестный лимит «${clip(key)}»; есть: ${Object.keys(LIMITS).join(', ')}`);
  }
  const out = {};
  for (const [key, { min, max, label }] of Object.entries(LIMITS)) {
    const value = limits[key] ?? DEFAULTS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      fail(`лимит ${label} (${key}) должен быть целым числом от ${min} до ${max}, получено: ${clip(value)}`);
    }
    out[key] = value;
  }
  return out;
}

function checkBudget(budgetUsd, dailyBudgetUsd) {
  if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > MAX_BUDGET_USD) {
    fail(`бюджет задачи должен быть больше $0 и не больше $${MAX_BUDGET_USD}, получено: ${clip(budgetUsd)}`);
  }
  if (dailyBudgetUsd === undefined || dailyBudgetUsd === null) return false;
  if (typeof dailyBudgetUsd !== 'number' || !Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0) {
    fail(`дневной бюджет должен быть числом не меньше 0, получено: ${clip(dailyBudgetUsd)}`);
  }
  if (budgetUsd > dailyBudgetUsd) {
    fail(`бюджет задачи $${formatUsd(budgetUsd)} больше дневного бюджета $${formatUsd(dailyBudgetUsd)}`);
  }
  return true;
}

// Новый мандат или ошибка с причиной. Ничего не подменяется молча: неизвестный параметр или лимит — тоже ошибка.
// null и отсутствие значения равнозначны: берётся значение по умолчанию (для goal, tools и sandboxRoot его нет).
function createMandate(options = {}) {
  if (!options || typeof options !== 'object') fail('нужны параметры мандата');
  for (const key of Object.keys(options)) {
    if (!OPTIONS.includes(key)) fail(`неизвестный параметр мандата «${clip(key)}»`);
  }
  const { goal, tools, sandboxRoot } = options;
  const now = options.now ?? Date.now();
  const expiresInMs = options.expiresInMs ?? DEFAULTS.expiresInMs;
  const budgetUsd = options.budgetUsd ?? DEFAULTS.budgetUsd;

  if (typeof goal !== 'string' || !goal.trim()) fail('нужна цель задачи: непустая строка');
  const cleanGoal = goal.trim();
  if (cleanGoal.length > MAX_GOAL) fail(`цель длиннее ${MAX_GOAL} символов`);

  if (typeof sandboxRoot !== 'string' || !path.isAbsolute(sandboxRoot)) fail('нужен абсолютный путь к песочнице (sandboxRoot)');
  const root = path.resolve(sandboxRoot);

  const toolList = checkTools(tools);
  // Инструменты кода — только с явным списком папок: песочница целиком по умолчанию им не достаётся.
  // Папки — те же folders мандата, внутри песочницы; другого способа дать коду папку нет.
  if (hasCodeTools(toolList) && (options.folders === undefined || options.folders === null)) {
    fail(`для инструментов кода (${CODE_TOOL_NAMES.join(', ')}) нужен явный непустой список папок folders `
      + 'внутри песочницы: код читается и меняется только в них');
  }
  const folderList = checkFolders(options.folders ?? [root], root);

  if (typeof now !== 'number' || !Number.isFinite(now)) fail('now должно быть временем в мс');
  if (typeof expiresInMs !== 'number' || !Number.isFinite(expiresInMs) || expiresInMs <= 0 || expiresInMs > MAX_EXPIRY_MS) {
    const got = Number.isFinite(expiresInMs) && expiresInMs > 0 ? ` (${formatDuration(expiresInMs)})` : '';
    fail(`срок мандата должен быть больше 0 и не больше 7 дней, получено: ${clip(expiresInMs)} мс${got}`);
  }

  const limits = checkLimits(options.limits ?? {});
  const budgetCheckedAgainstDaily = checkBudget(budgetUsd, options.dailyBudgetUsd);

  const mandate = {
    id: `m-${crypto.randomUUID()}`,
    goal: cleanGoal,
    tools: toolList,
    folders: folderList,
    root, // корень песочницы: путь без path (список, поиск) — это он, и проверяется по папкам
    expiresAt: now + expiresInMs,
    createdAt: now,
    limits,
    budgetUsd,
    budgetCheckedAgainstDaily,
    approvedBy: null,
  };
  return mandate;
}

function isMandate(m) {
  return Boolean(m) && typeof m === 'object' && Array.isArray(m.tools) && Array.isArray(m.folders);
}

// Истёк: now не раньше expiresAt. Повреждённый мандат или время не числом — тоже истёк.
function isExpired(mandate, now = Date.now()) {
  if (!mandate || typeof mandate !== 'object' || !Number.isFinite(mandate.expiresAt)) return true;
  return !(Number.isFinite(now) && now < mandate.expiresAt);
}

function deny(reason) {
  return { ok: false, reason };
}

// Можно ли вызвать инструмент по мандату. Проверки: срок, имя (запрет, белый список, список мандата),
// для workspace_* — путь: resolve(path) бросает ошибку за песочницей, результат должен лежать в папке мандата.
// Путь обрезается по краям, как это делает сам инструмент: проверяется тот путь, который он откроет.
// Подтверждение владельцем (approvedBy) здесь не проверяется: это делает исполнитель до старта.
function checkTool(mandate, { name, args, resolve, now = Date.now() } = {}) {
  if (!isMandate(mandate)) return deny('мандата нет или он повреждён');
  if (isExpired(mandate, now)) return deny(`срок мандата истёк: ${formatDate(mandate.expiresAt)}`);
  if (typeof name !== 'string' || !name) return deny('не указано имя инструмента');
  if (isHardBanned(name) || !ALLOWED_TOOLS.includes(name)) {
    return deny(`инструмент «${clip(name)}» запрещён для автономных задач`);
  }
  if (!mandate.tools.includes(name)) return deny(`инструмента «${name}» нет в мандате`);
  if (CODE_TOOL_NAMES.includes(name)) return checkCodePath(mandate, args, name);
  if (!/^(workspace|document|project)_/.test(name)) return { ok: true };

  // Без пути инструмент работает с корнем песочницы (список, поиск): его тоже проверяем по папкам мандата,
  // иначе список всей песочницы или поиск по ней обходил бы мандат.
  const raw = args && typeof args === 'object' && args.path !== undefined && args.path !== null ? args.path : '';
  if (typeof raw !== 'string') return deny('путь должен быть строкой');
  if (raw.trim() === '') {
    const rootOk = typeof mandate.root === 'string' && mandate.folders.some((dir) => pathKey(path.resolve(dir)) === pathKey(path.resolve(mandate.root)));
    return rootOk ? { ok: true } : deny('корень песочницы вне папок мандата: укажите путь к папке мандата');
  }
  if (typeof resolve !== 'function') return deny('путь нечем проверить: не передана функция resolve');
  let abs;
  try {
    abs = resolve(raw.trim());
  } catch (err) {
    return deny(`путь «${clip(raw)}» не разрешён: ${err && err.message ? err.message : String(err)}`);
  }
  if (typeof abs !== 'string' || !abs) return deny(`путь «${clip(raw)}» не разрешён: проверка не вернула путь`);
  if (!mandate.folders.some((dir) => isWithin(dir, abs))) return deny(`путь «${clip(raw) || 'корень песочницы'}» вне папок мандата`);
  // Для разбора проекта проверяем и настоящий путь: junction внутри разрешённой папки может вести в соседний проект.
  if (name.startsWith('project_')) {
    try {
      const actual = realpath(abs);
      const allowed = mandate.folders.some((folder) => {
        try { return isWithin(realpath(folder), actual); } catch { return false; }
      });
      if (!allowed) return deny('путь проекта после раскрытия ссылок вне папок мандата');
    } catch {
      return deny('не удалось проверить настоящий путь проекта');
    }
  }
  return { ok: true };
}

// code_*: путь обязателен и после раскрытия ссылок (realpath) лежит внутри папки мандата (folders), а сами папки
// после раскрытия ссылок — внутри песочницы. Поле codeFolders старых мандатов не читается: только folders.
// Относительный путь — от корня песочницы (mandate.root), как у инструмента (codeTools с base) и проверок шагов.
function checkCodePath(mandate, args, name) {
  const folders = mandate.folders;
  if (!Array.isArray(folders) || folders.length === 0) return deny('в мандате нет папок');
  const problem = realFoldersProblem(mandate);
  if (problem) return deny(problem);
  const raw = args && typeof args === 'object' ? args.path : undefined;
  // Без файла code_test работает в папке мандата, и она только что проверена.
  if (name === 'code_test' && raw === undefined) return { ok: true };
  if (typeof raw !== 'string' || !raw.trim()) return deny('нужен путь к файлу');
  try {
    resolveCodePath(folders, raw, { base: mandate.root });
  } catch (err) {
    return deny(`путь «${clip(raw)}» не разрешён: ${err && err.message ? err.message : String(err)}`);
  }
  return { ok: true };
}

// Местное время: 31.10.2026 14:05.
function formatDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'неизвестно';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 45 мин, 2 ч, 1 ч 30 мин, 7 сут.
function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (!(minutes >= 1)) return 'меньше минуты';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 48) return restMinutes ? `${hours} ч ${restMinutes} мин` : `${hours} ч`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} сут. ${restHours} ч` : `${days} сут.`;
}

// 300000 → «300 000».
function formatNumber(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Целые центы — два знака (0.30), иначе без округления до центов (0.005).
function formatUsd(x) {
  const cents = x * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6 ? x.toFixed(2) : String(Number(x.toPrecision(6)));
}

// Короткий текст для владельца перед подтверждением: что, чем, где, до какого срока и за сколько.
function summarize(mandate) {
  if (!isMandate(mandate)) return 'Мандата нет или он повреждён.';
  const l = mandate.limits || {};
  const tools = mandate.tools.map((t) => (Object.hasOwn(TOOL_LABELS, t) ? `${TOOL_LABELS[t]} (${t})` : String(t)));
  // Код: какие инструменты что разрешают и где. Папки — те же, что в строке «Папки»: других у кода нет.
  const codeLine = [];
  if (hasCodeTools(mandate.tools)) {
    const reading = mandate.tools.includes('code_read') ? ['чтение — code_read'] : [];
    const changing = ['code_write', 'code_edit'].filter((t) => mandate.tools.includes(t));
    const parts = [
      ...reading,
      // Отдельного вопроса на каждый вызов нет: это подтверждение мандата и есть разрешение (только в этих папках).
      ...(changing.length ? [`изменение — ${changing.join(', ')}, без отдельного подтверждения каждого вызова: разрешение — этот мандат`] : []),
    ];
    const runs = mandate.tools.includes('code_test');
    if (runs) parts.push('запуск тестов — code_test');
    codeLine.push(`Код (${runs ? '' : 'без запуска, '}только в папках мандата: ${mandate.folders.join('; ')}): ${parts.join('; ')}`);
    if (runs) codeLine.push('Тесты: code_test запускает тесты из папки с вашими правами на компьютере, это не песочница');
  }
  return [
    `Цель: ${mandate.goal}`,
    `Инструменты: ${tools.join(', ')}`,
    `Папки: ${mandate.folders.join('; ')}`,
    ...codeLine,
    `Срок: до ${formatDate(mandate.expiresAt)} (${formatDuration(mandate.expiresAt - mandate.createdAt)})`,
    `Лимиты: шагов до ${l.maxSteps}, неудач подряд на шаге до ${l.maxFailuresPerStep}, `
      + `активной работы до ${formatDuration(l.maxActiveMs)}, токенов до ${formatNumber(l.maxTokens)}`,
    `Бюджет: до $${formatUsd(mandate.budgetUsd)}, `
      + `${mandate.budgetCheckedAgainstDaily ? 'сверен с дневным бюджетом' : 'с дневным бюджетом не сверен'}`,
  ].join('\n');
}

module.exports = {
  ALLOWED_TOOLS, DEFAULTS, MAX_EXPIRY_MS, MAX_STEPS, MAX_ACTIVE_MS, MAX_BUDGET_USD,
  createMandate, checkTool, isExpired, summarize, isHardBanned, hasCodeTools, realFoldersProblem,
};
