'use strict';

// Данные виджетов столов. Только чистые функции: ни диска, ни сети, ни времени изнутри
// (текущее время и снимки источников передаются снаружи). Модуль ничего не выдумывает:
// каждый результат имеет вид {type, state, value, error}, где state:
//   ok    — настоящие данные источника;
//   empty — источник ответил, но данных нет (или владелец ещё ничего не задал);
//   error — источник недоступен или ответил мусором; error — код причины;
//   stale — данные есть, но они старше допустимого срока (показываем с пометкой).
//
// Источники (внедряются вызывающим, формы соответствуют настоящим модулям приложения):
//   os       — снимок require('os'): {cpus, totalmem, freemem, platform, arch, uptime};
//   tasks    — runtime.queue.list(): [{id, title, status, updatedAt}];
//   reminders/missions — list() хранилищ: [{id, text, dueAt, done, ...}] / [{id, goal, status, nextRunAt}];
//   music    — readMusicHistory(): [{query, service, at}] от новых к старым;
//   weather  — getCurrentWeather(city): {ok, temp, apparent, precipitation, fetchedAt} или {ok:false, reason};
//   currency — getRates(codes): {ok, date, rates:[{code,name,value,previous}], fetchedAt} или {ok:false, reason};
//   apps     — AppUsage: {apps: {name: {launches, seenRunning, last}}, services};
//   orb      — состояние шара из renderer/orb.js: 'idle' | {state: 'idle'};
//   goals    — GoalStore.list({status:'active'}): [{id, title, status, steps:[{status}], updatedAt}];
//   notes    — MemoryStore.list(): [{id, text, kind, about, sensitive, updatedAt}];
//   downloads — downloads-cleanup.analyze(folder) или список файлов [{name,size,mtimeMs}];
//   mcp      — mcpManager.state(): {servers: [{name, transport, status, toolCount, ...}]};
//   pet      — декоративная анимация: данных нет, источник не читается вообще.

const DATA_STATES = Object.freeze(['ok', 'empty', 'error', 'stale']);

// Пределы по умолчанию; рендерер может передать свои из config виджета.
const DEFAULTS = Object.freeze({
  weatherMaxAgeMs: 45 * 60 * 1000, // кэш open-meteo обновляется раз в 30 минут
  currencyMaxAgeMs: 20 * 60 * 1000, // кэш курса ЦБ — 15 минут
  tasksLimit: 10,
  todayLimit: 10,
  appsLimit: 6,
  musicLimit: 5,
  commandsLimit: 10,
  goalsLimit: 5,
  missionsLimit: 5,
  remindersLimit: 5,
  notesLimit: 5,
  downloadsLimit: 5,
  mcpLimit: 6,
});

// Настроения питомца — фиксированный набор. Это не данные источника и не «показания»:
// питомец декоративный, поэтому другого состояния у него быть не может.
const PET_MOODS = Object.freeze(['idle', 'curious', 'sleepy']);

const ACTIVE_TASK_STATUSES = Object.freeze(['queued', 'running', 'waiting_approval', 'paused', 'blocked']);
const FINAL_TASK_STATUSES = Object.freeze(['done', 'unverified', 'cancelled']);

// Состояния шара из renderer/orb.js. Новые имена здесь не появляются:
// неизвестное состояние — ошибка источника, а не придуманная подпись.
const ORB_WORDS = Object.freeze({
  idle: 'Жду',
  listening: 'Слушаю',
  thinking: 'Думаю',
  searching: 'Ищу',
  speaking: 'Говорю',
  acting: 'Работаю',
  waiting_approval: 'Ждёт вас',
  verifying: 'Проверяю',
  success: 'Готово',
  error: 'Ошибка',
  cancelled: 'Остановлено',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function result(type, state, value, error = null) {
  if (!DATA_STATES.includes(state)) throw new Error(`виджет ${type}: неверное состояние ${state}`);
  return { type, state, value: value === undefined ? null : value, error: error === null ? null : String(error) };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampLimit(value, fallback, max) {
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// --- отдельные источники -------------------------------------------------

// Снимок os: процент занятости ЦП с момента загрузки (по cumulative times ядер)
// и память. Нет снимка — empty; снимок неполный — error, но не выдуманные проценты.
function system(osSnapshot) {
  if (osSnapshot === undefined || osSnapshot === null) return result('system', 'empty', null);
  if (!isPlainObject(osSnapshot)) return result('system', 'error', null, 'bad_source');
  const cpus = osSnapshot.cpus;
  const totalmem = finite(osSnapshot.totalmem);
  const freemem = finite(osSnapshot.freemem);
  if (!Array.isArray(cpus) || !cpus.length || totalmem === null || totalmem <= 0 || freemem === null) {
    return result('system', 'error', null, 'bad_source');
  }
  let total = 0;
  let idle = 0;
  for (const cpu of cpus) {
    const times = cpu && cpu.times;
    if (!isPlainObject(times)) return result('system', 'error', null, 'bad_source');
    for (const key of ['user', 'nice', 'sys', 'irq', 'idle']) {
      const value = finite(times[key]);
      if (value === null) return result('system', 'error', null, 'bad_source');
      total += value;
      if (key === 'idle') idle += value;
    }
  }
  if (total <= 0) return result('system', 'error', null, 'bad_source');
  const cpuPercent = Math.round(((total - idle) / total) * 100);
  const memUsed = Math.max(0, totalmem - freemem);
  const value = {
    cpuPercent: Math.max(0, Math.min(100, cpuPercent)),
    memUsed,
    memTotal: totalmem,
    memPercent: Math.round((memUsed / totalmem) * 100),
    platform: typeof osSnapshot.platform === 'string' ? osSnapshot.platform : null,
    arch: typeof osSnapshot.arch === 'string' ? osSnapshot.arch : null,
    uptime: finite(osSnapshot.uptime),
  };
  return result('system', 'ok', value);
}

// Задачи: только настоящие строки очереди. Неизвестные записи пропускаются,
// а не превращаются в «задачу без названия».
function tasks(list, options = {}) {
  const { now = Date.now(), filter = 'active' } = options;
  const limit = clampLimit(options.limit, DEFAULTS.tasksLimit, 50);
  if (list === undefined || list === null) return result('tasks', 'empty', null);
  if (!Array.isArray(list)) return result('tasks', 'error', null, 'bad_source');
  const start = startOfDay(now);
  const end = start + 24 * 60 * 60 * 1000;
  const items = [];
  for (const raw of list) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string') continue;
    const status = typeof raw.status === 'string' ? raw.status : 'draft';
    if (!filter || filter === 'active') {
      if (FINAL_TASK_STATUSES.includes(status)) continue;
    } else if (filter === 'today') {
      const updated = raw.updatedAt === undefined ? NaN : new Date(raw.updatedAt).getTime();
      if (!Number.isFinite(updated) || updated < start || updated >= end) continue;
    }
    items.push({
      id: raw.id,
      title: raw.title.slice(0, 200),
      status,
      active: !FINAL_TASK_STATUSES.includes(status),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    });
  }
  if (!items.length) return result('tasks', 'empty', { items: [], total: 0 });
  return result('tasks', 'ok', {
    items: items.slice(0, limit),
    total: items.length,
    counts: {
      running: items.filter((item) => item.status === 'running').length,
      waiting: items.filter((item) => item.status === 'waiting_approval').length,
      active: items.length,
    },
  });
}

function startOfDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// «Сегодня»: напоминания на сегодня и просроченные (они всё ещё ждут владельца)
// и ближайшие миссии на сегодня. Пропущенные значения не выдумываются.
function today(sources = {}, options = {}) {
  const { now = Date.now() } = options;
  const limit = clampLimit(options.limit, DEFAULTS.todayLimit, 20);
  if (!isPlainObject(sources)) return result('today', 'error', null, 'bad_source');
  const reminders = sources.reminders === undefined ? [] : sources.reminders;
  const missions = sources.missions === undefined ? [] : sources.missions;
  if (!Array.isArray(reminders)) return result('today', 'error', null, 'bad_source');
  if (!Array.isArray(missions)) return result('today', 'error', null, 'bad_source');
  const start = startOfDay(now);
  const end = start + 24 * 60 * 60 * 1000;
  const dueReminders = [];
  for (const raw of reminders) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string' || raw.done) continue;
    const due = raw.dueAt === undefined ? NaN : new Date(raw.dueAt).getTime();
    if (!Number.isFinite(due)) continue;
    if (due >= end) continue; // будущее дальше сегодняшнего дня — не «сегодня»
    dueReminders.push({
      id: raw.id,
      text: raw.text.slice(0, 300),
      dueAt: new Date(due).toISOString(),
      overdue: due < start,
    });
  }
  dueReminders.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const scheduled = [];
  for (const raw of missions) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.goal !== 'string') continue;
    const next = raw.nextRunAt === undefined ? NaN : new Date(raw.nextRunAt).getTime();
    if (!Number.isFinite(next) || next < start || next >= end) continue;
    scheduled.push({
      id: raw.id,
      goal: raw.goal.slice(0, 300),
      nextRunAt: new Date(next).toISOString(),
      status: typeof raw.status === 'string' ? raw.status : null,
    });
  }
  scheduled.sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));
  const total = dueReminders.length + scheduled.length;
  if (!total) return result('today', 'empty', { reminders: [], missions: [], total: 0 });
  return result('today', 'ok', {
    reminders: dueReminders.slice(0, limit),
    missions: scheduled.slice(0, limit),
    total,
  });
}

// Музыка: последний настоящий запрос из истории. Нет истории — empty, а не «ничего не играет».
function music(history, options = {}) {
  const limit = clampLimit(options.limit, DEFAULTS.musicLimit, 20);
  if (history === undefined || history === null) return result('music', 'empty', null);
  if (!Array.isArray(history)) return result('music', 'error', null, 'bad_source');
  const items = [];
  for (const raw of history) {
    if (!isPlainObject(raw) || typeof raw.query !== 'string' || !raw.query.trim()) continue;
    items.push({
      query: raw.query.trim().slice(0, 200),
      service: typeof raw.service === 'string' ? raw.service : null,
      at: typeof raw.at === 'string' ? raw.at : null,
    });
  }
  if (!items.length) return result('music', 'empty', { items: [], last: null });
  return result('music', 'ok', { items: items.slice(0, limit), last: items[0] });
}

// Погода: город из настроек приходит снаружи. Нет города — empty (это не ошибка),
// есть ошибка сети — error, старый кэш — stale с прежними цифрами.
function weather(cached, options = {}) {
  const { now = Date.now() } = options;
  const maxAgeMs = Number.isInteger(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : DEFAULTS.weatherMaxAgeMs;
  if (cached === undefined || cached === null) return result('weather', 'empty', { city: null });
  if (!isPlainObject(cached)) return result('weather', 'error', { city: null }, 'bad_source');
  const city = typeof cached.city === 'string' && cached.city.trim() ? cached.city.trim().slice(0, 100) : null;
  if (cached.ok === false) {
    return result('weather', 'error', { city }, cached.reason || 'bad_data');
  }
  if (!city) return result('weather', 'empty', { city: null }, 'no_city');
  const temp = finite(cached.temp);
  if (temp === null) return result('weather', 'empty', { city }, 'no_data');
  const fetchedAt = finite(cached.fetchedAt);
  const stale = fetchedAt !== null && now - fetchedAt > maxAgeMs;
  const value = {
    city,
    temp,
    apparent: finite(cached.apparent),
    precipitation: finite(cached.precipitation),
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
  };
  return result('weather', stale ? 'stale' : 'ok', value);
}

// Курсы: настоящие строки ответа ЦБ. Ошибка источника — error с кодом, пустой ответ — empty.
function currency(cached, options = {}) {
  const { now = Date.now() } = options;
  const maxAgeMs = Number.isInteger(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : DEFAULTS.currencyMaxAgeMs;
  if (cached === undefined || cached === null) return result('currency', 'empty', null);
  if (!isPlainObject(cached)) return result('currency', 'error', null, 'bad_source');
  if (cached.ok === false) return result('currency', 'error', null, cached.reason || 'bad_data');
  const source = Array.isArray(cached.rates) ? cached.rates : [];
  const rates = [];
  for (const raw of source) {
    if (!isPlainObject(raw) || typeof raw.code !== 'string') continue;
    const value = finite(raw.value);
    if (value === null) continue;
    rates.push({
      code: raw.code,
      name: typeof raw.name === 'string' ? raw.name : raw.code,
      value,
      previous: finite(raw.previous),
    });
  }
  if (!rates.length) return result('currency', 'empty', { date: typeof cached.date === 'string' ? cached.date : null, rates: [] });
  const fetchedAt = finite(cached.fetchedAt);
  const stale = fetchedAt !== null && now - fetchedAt > maxAgeMs;
  return result('currency', stale ? 'stale' : 'ok', {
    date: typeof cached.date === 'string' ? cached.date : null,
    rates,
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
  });
}

// Программы: настоящая статистика запусков. Пустая статистика — empty, а не «топ программ» из воздуха.
function apps(usage, options = {}) {
  const limit = clampLimit(options.limit, DEFAULTS.appsLimit, 30);
  if (usage === undefined || usage === null) return result('apps', 'empty', null);
  if (!isPlainObject(usage)) return result('apps', 'error', null, 'bad_source');
  const source = usage.apps;
  if (source === undefined || source === null) return result('apps', 'empty', { items: [], total: 0 });
  if (!isPlainObject(source)) return result('apps', 'error', null, 'bad_source');
  const items = [];
  for (const name of Object.keys(source)) {
    const raw = source[name];
    if (!isPlainObject(raw)) continue;
    const launches = finite(raw.launches);
    const seenRunning = finite(raw.seenRunning);
    if (launches === null && seenRunning === null) continue;
    items.push({
      name,
      launches: launches === null ? 0 : launches,
      seenRunning: seenRunning === null ? 0 : seenRunning,
      last: typeof raw.last === 'string' ? raw.last : null,
    });
  }
  items.sort((a, b) => b.launches - a.launches || b.seenRunning - a.seenRunning || a.name.localeCompare(b.name));
  if (!items.length) return result('apps', 'empty', { items: [], total: 0 });
  return result('apps', 'ok', { items: items.slice(0, limit), total: items.length });
}

// Аватар/мини-шар: только состояния, которые действительно есть в orb.js.
function orb(source) {
  if (source === undefined || source === null) return result('orb', 'empty', null);
  const state = typeof source === 'string' ? source : isPlainObject(source) ? source.state : null;
  if (typeof state !== 'string' || !Object.prototype.hasOwnProperty.call(ORB_WORDS, state)) {
    return result('orb', 'error', null, 'bad_state');
  }
  const steps = isPlainObject(source) && Number.isInteger(source.steps) && source.steps > 0 ? source.steps : null;
  return result('orb', 'ok', { state, label: ORB_WORDS[state], steps });
}

// Команды: список своих команд, если рендерер передал его источником (main.js собирает
// через src/commands/store.js). Здесь только количество и подписи, без запуска.
function commands(source, options = {}) {
  const limit = clampLimit(options.limit, DEFAULTS.commandsLimit, 20);
  if (source === undefined || source === null) return result('commands', 'empty', null);
  const list = Array.isArray(source) ? source : isPlainObject(source) && Array.isArray(source.items) ? source.items : null;
  if (!list) return result('commands', 'error', null, 'bad_source');
  const items = [];
  for (const raw of list) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') continue;
    items.push({ id: raw.id, name: raw.name.slice(0, 120), folder: typeof raw.folder === 'string' ? raw.folder : null });
  }
  if (!items.length) return result('commands', 'empty', { items: [], total: 0 });
  return result('commands', 'ok', { items: items.slice(0, limit), total: items.length });
}

// Источник в виде массива или {items: [...]}: так отдают хранилища приложения.
// Всё остальное — не список, и это честная ошибка источника, а не пустой виджет.
function sourceList(source) {
  if (Array.isArray(source)) return source;
  if (isPlainObject(source) && Array.isArray(source.items)) return source.items;
  return null;
}

function shortText(value, max) {
  return Array.isArray(value) ? value.slice(0, max).join('') : String(value).slice(0, max);
}

// Цели: только активные, с числом выполненных шагов. Закрытые цели в виджет не попадают:
// они уже не «в работе», а переносить их в один список — путать владельца.
function goals(source, options = {}) {
  const limit = clampLimit(options.limit, DEFAULTS.goalsLimit, 20);
  if (source === undefined || source === null) return result('goals', 'empty', null);
  const list = sourceList(source);
  if (!list) return result('goals', 'error', null, 'bad_source');
  const items = [];
  for (const raw of list) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string') continue;
    // Статус обязателен: запись без него — не активная цель, и придумывать ей статус нельзя.
    if (raw.status !== 'active') continue;
    const steps = Array.isArray(raw.steps) ? raw.steps : [];
    let done = 0;
    for (const step of steps) {
      if (isPlainObject(step) && step.status === 'done') done += 1;
    }
    items.push({
      id: raw.id,
      title: shortText(raw.title, 200),
      stepsDone: done,
      stepsTotal: steps.length,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    });
  }
  if (!items.length) return result('goals', 'empty', { items: [], total: 0 });
  return result('goals', 'ok', { items: items.slice(0, limit), total: items.length });
}

// Миссии: фоновые задачи по расписанию. Показываем и выключенные — рендерер пометит их,
// чтобы «выключено» не выглядело как «ничего нет».
function missions(source, options = {}) {
  const limit = clampLimit(options.limit, DEFAULTS.missionsLimit, 20);
  if (source === undefined || source === null) return result('missions', 'empty', null);
  const list = sourceList(source);
  if (!list) return result('missions', 'error', null, 'bad_source');
  const items = [];
  for (const raw of list) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.goal !== 'string') continue;
    const nextRunAt = typeof raw.nextRunAt === 'string' && Number.isFinite(new Date(raw.nextRunAt).getTime())
      ? new Date(raw.nextRunAt).toISOString() : null;
    items.push({
      id: raw.id,
      goal: shortText(raw.goal, 300),
      enabled: raw.enabled !== false,
      status: typeof raw.status === 'string' ? raw.status : null,
      nextRunAt,
      lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
      runs: finite(raw.runs) === null ? null : Math.max(0, Math.round(raw.runs)),
    });
  }
  items.sort((a, b) => {
    const at = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Infinity;
    const bt = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Infinity;
    return at - bt;
  });
  if (!items.length) return result('missions', 'empty', { items: [], total: 0 });
  return result('missions', 'ok', {
    items: items.slice(0, limit),
    total: items.length,
    running: items.filter((item) => item.status === 'running').length,
  });
}

// Напоминания: невыполненные, ближайшие первыми. Просроченные не прячем — они ждут владельца.
function reminders(source, options = {}) {
  const { now = Date.now() } = options;
  const limit = clampLimit(options.limit, DEFAULTS.remindersLimit, 20);
  if (source === undefined || source === null) return result('reminders', 'empty', null);
  const list = sourceList(source);
  if (!list) return result('reminders', 'error', null, 'bad_source');
  const items = [];
  for (const raw of list) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string' || raw.done) continue;
    const due = raw.dueAt === undefined ? NaN : new Date(raw.dueAt).getTime();
    if (!Number.isFinite(due)) continue;
    items.push({
      id: raw.id,
      text: shortText(raw.text, 300),
      dueAt: new Date(due).toISOString(),
      repeat: typeof raw.repeat === 'string' ? raw.repeat : null,
      overdue: due < now,
    });
  }
  items.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  if (!items.length) return result('reminders', 'empty', { items: [], total: 0 });
  return result('reminders', 'ok', {
    items: items.slice(0, limit),
    total: items.length,
    overdue: items.filter((item) => item.overdue).length,
  });
}

// Заметки: записи памяти, новые сверху. Личные (sensitive) по умолчанию скрыты:
// на столе их может увидеть кто угодно. Число скрытых честно показываем.
function notes(source, options = {}) {
  const limit = clampLimit(options.limit, DEFAULTS.notesLimit, 20);
  const includeSensitive = options.includeSensitive === true;
  if (source === undefined || source === null) return result('notes', 'empty', null);
  const list = sourceList(source);
  if (!list) return result('notes', 'error', null, 'bad_source');
  const items = [];
  let hiddenSensitive = 0;
  for (const raw of list) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string') continue;
    const text = raw.text.trim();
    if (!text) continue;
    if (raw.sensitive === true) {
      if (!includeSensitive) {
        hiddenSensitive += 1;
        continue;
      }
    }
    items.push({
      id: raw.id,
      text: shortText(text, 200),
      kind: typeof raw.kind === 'string' ? raw.kind : null,
      about: typeof raw.about === 'string' ? raw.about : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    });
  }
  if (!items.length) return result('notes', 'empty', { items: [], total: 0, hiddenSensitive });
  return result('notes', 'ok', { items: items.slice(0, limit), total: items.length, hiddenSensitive });
}

// Загрузки: отчёт настоящего анализа папки (downloads-cleanup.analyze) или список файлов,
// переданный вызывающим. Ничего не дочитываем и не досчитываем сами.
function downloads(source, options = {}) {
  const { now = Date.now() } = options;
  const limit = clampLimit(options.limit, DEFAULTS.downloadsLimit, 10);
  if (source === undefined || source === null) return result('downloads', 'empty', null);
  if (Array.isArray(source)) {
    const items = [];
    let totalBytes = 0;
    for (const raw of source) {
      if (!isPlainObject(raw) || typeof raw.name !== 'string' || !raw.name.trim()) continue;
      const size = finite(raw.size);
      const mtimeMs = finite(raw.mtimeMs);
      if (size !== null && size > 0) totalBytes += size;
      items.push({
        name: shortText(raw.name.trim(), 120),
        size: size === null ? null : Math.max(0, Math.round(size)),
        ageDays: mtimeMs === null ? null : Math.max(0, Math.floor((now - mtimeMs) / (24 * 60 * 60 * 1000))),
        reason: typeof raw.reason === 'string' ? shortText(raw.reason, 120) : null,
      });
    }
    if (!items.length) return result('downloads', 'empty', { items: [], total: 0 });
    return result('downloads', 'ok', {
      folder: null,
      fileCount: items.length,
      totalBytes,
      candidateCount: null,
      candidateBytes: null,
      items: items.slice(0, limit),
      truncated: false,
    });
  }
  if (!isPlainObject(source)) return result('downloads', 'error', null, 'bad_source');
  if (source.ok === false) {
    return result('downloads', 'error', null, typeof source.reason === 'string' ? source.reason : 'bad_data');
  }
  if (source.ok !== true) return result('downloads', 'error', null, 'bad_source');
  const folder = typeof source.folder === 'string' && source.folder.trim() ? shortText(source.folder.trim(), 300) : null;
  const scanned = isPlainObject(source.scanned) ? source.scanned : {};
  const fileCount = finite(scanned.files);
  const totalBytes = finite(scanned.totalBytes);
  const candidates = Array.isArray(source.candidates) ? source.candidates : [];
  const items = [];
  for (const raw of candidates) {
    if (!isPlainObject(raw) || typeof raw.name !== 'string' || !raw.name.trim()) continue;
    const size = finite(raw.size);
    items.push({
      name: shortText(raw.name.trim(), 120),
      size: size === null ? null : Math.max(0, Math.round(size)),
      ageDays: finite(raw.ageDays) === null ? null : Math.max(0, Math.round(raw.ageDays)),
      reason: typeof raw.reason === 'string' ? shortText(raw.reason, 120) : null,
    });
  }
  const candidateCount = finite(source.candidatesTotal);
  const candidateBytes = finite(source.candidateBytes);
  // Пустая папка — пусто; папка с файлами, но без кандидатов на уборку — честный ok без списка.
  if (fileCount === 0 && !items.length) {
    return result('downloads', 'empty', {
      folder, fileCount: 0, totalBytes: totalBytes === null ? 0 : totalBytes,
      candidateCount: 0, candidateBytes: 0, items: [], truncated: false,
    });
  }
  return result('downloads', 'ok', {
    folder,
    fileCount: fileCount === null ? null : Math.max(0, Math.round(fileCount)),
    totalBytes: totalBytes === null ? null : Math.max(0, Math.round(totalBytes)),
    candidateCount: candidateCount === null ? (items.length || null) : Math.max(0, Math.round(candidateCount)),
    candidateBytes: candidateBytes === null ? null : Math.max(0, Math.round(candidateBytes)),
    items: items.slice(0, limit),
    truncated: source.candidatesTruncated === true,
  });
}

// MCP: подключённые сервисы и их состояние. Секретов в state() нет — и здесь их быть не должно.
function mcp(source, options = {}) {
  const limit = clampLimit(options.limit, DEFAULTS.mcpLimit, 20);
  if (source === undefined || source === null) return result('mcp', 'empty', null);
  // mcpManager.state() отдаёт {servers: [...]}, поэтому принимаем и такую форму.
  const list = Array.isArray(source) ? source
    : isPlainObject(source) && Array.isArray(source.servers) ? source.servers
      : sourceList(source);
  if (!list) return result('mcp', 'error', null, 'bad_source');
  const items = [];
  for (const raw of list) {
    if (!isPlainObject(raw) || typeof raw.name !== 'string' || !raw.name.trim()) continue;
    const toolCount = finite(raw.toolCount);
    items.push({
      name: shortText(raw.name.trim(), 80),
      transport: typeof raw.transport === 'string' ? raw.transport : null,
      target: typeof raw.target === 'string' ? shortText(raw.target, 120) : null,
      status: typeof raw.status === 'string' ? raw.status : (raw.disabled === true ? 'disabled' : 'idle'),
      disabled: raw.disabled === true,
      toolCount: toolCount === null ? 0 : Math.max(0, Math.round(toolCount)),
    });
  }
  if (!items.length) return result('mcp', 'empty', { items: [], total: 0 });
  return result('mcp', 'ok', {
    items: items.slice(0, limit),
    total: items.length,
    connected: items.filter((item) => item.status === 'connected').length,
    errors: items.filter((item) => item.status === 'error').length,
  });
}

// Питомец: декоративная анимация. Данных нет и не читается, поэтому state всегда ok;
// настроение — только из фиксированного набора, иначе спокойное.
function pet(source) {
  const mood = typeof source === 'string' ? source : isPlainObject(source) ? source.mood : null;
  const safeMood = typeof mood === 'string' && PET_MOODS.includes(mood) ? mood : 'idle';
  return result('pet', 'ok', { mood: safeMood, moods: PET_MOODS.slice(), decorative: true });
}

// --- сборка ---------------------------------------------------------------

const BUILDERS = Object.freeze({
  system: (sources) => system(sources.os),
  tasks: (sources, options) => tasks(sources.tasks, options),
  today: (sources, options) => today({ reminders: sources.reminders, missions: sources.missions }, options),
  music: (sources, options) => music(sources.music, options),
  weather: (sources, options) => weather(sources.weather, options),
  currency: (sources, options) => currency(sources.currency, options),
  apps: (sources, options) => apps(sources.apps, options),
  orb: (sources) => orb(sources.orb),
  commands: (sources, options) => commands(sources.commands, options),
  goals: (sources, options) => goals(sources.goals, options),
  missions: (sources, options) => missions(sources.missions, options),
  reminders: (sources, options) => reminders(sources.reminders, options),
  notes: (sources, options) => notes(sources.notes, options),
  downloads: (sources, options) => downloads(sources.downloads, options),
  mcp: (sources, options) => mcp(sources.mcp, options),
  pet: () => pet(null),
});

const DATA_TYPES = Object.freeze(Object.keys(BUILDERS));

// Данные одного виджета. Неизвестный тип — ошибка программиста: лучше упасть в тесте,
// чем показать на столе пустую плашку без объяснения.
function buildWidget(type, sources = {}, options = {}) {
  const build = BUILDERS[type];
  if (!build) throw new Error(`неизвестный тип виджета: ${JSON.stringify(type)}`);
  const safe = isPlainObject(sources) ? sources : {};
  return build(safe, options);
}

// Данные всех виджетов стола: {widgetId: {type,state,value,error}}. Ошибка одного
// источника не лишает данные остальные виджеты; тип из сохранённого стола проверяется.
function buildDeskData(desk, sources = {}, options = {}) {
  if (!isPlainObject(desk) || !Array.isArray(desk.widgets)) throw new Error('стол: нужен объект с виджетами');
  const safe = isPlainObject(sources) ? sources : {};
  const out = {};
  for (const widget of desk.widgets) {
    if (!isPlainObject(widget) || typeof widget.id !== 'string' || typeof widget.type !== 'string') continue;
    const config = isPlainObject(widget.config) ? widget.config : {};
    const local = { ...options };
    if (Number.isInteger(config.limit)) local.limit = config.limit;
    if (typeof config.filter === 'string') local.filter = config.filter;
    try {
      out[widget.id] = buildWidget(widget.type, safe, local);
    } catch {
      out[widget.id] = result(widget.type, 'error', null, 'bad_type');
    }
  }
  return out;
}

module.exports = {
  DATA_STATES,
  DATA_TYPES,
  DEFAULTS,
  ACTIVE_TASK_STATUSES,
  ORB_WORDS,
  PET_MOODS,
  system,
  tasks,
  today,
  music,
  weather,
  currency,
  apps,
  orb,
  commands,
  goals,
  missions,
  reminders,
  notes,
  downloads,
  mcp,
  pet,
  buildWidget,
  buildDeskData,
  startOfDay,
  clone,
};
