'use strict';

// Учёт стоимости вызовов модели, дневной лимит и расходы задач.
// Состояние — один JSON-файл {date, timezone, spentUsd, unknownCalls, byTask, pending, calls[, blocked][, transition]}:
//   date         — дата дневных счётчиков (ГГГГ-ММ-ДД) в часовом поясе бюджета; с новой датой они обнуляются;
//   timezone     — часовой пояс бюджета IANA (настройка budgetTimezone, по умолчанию Asia/Dushanbe), в котором
//                  посчитана date. Файл прежней версии этого поля не имеет: его date — местная дата машины
//                  (legacyTimezone, по умолчанию пояс машины). Такой файл читается как раньше и мигрирует (ниже);
//   spentUsd     — сумма точных стоимостей и верхних оценок за эту дату;
//   unknownCalls — вызовы, стоимость которых посчитать нечем (цена неизвестна): в суммы не входят;
//   byTask       — {taskId: USD} за всё время задачи (точные стоимости и верхние оценки); со сменой даты
//                  не обнуляется: задача может идти несколько дней;
//   pending      — резервы вызовов в полёте [{id, usd, ts, purpose, model[, taskId]}]: пишутся до запроса,
//                  снимаются после него. Резерв, который застал новый экземпляр Meter (процесс упал посреди
//                  запроса), становится расходом по верхней границе: known: false, interrupted: true;
//   calls        — последние MAX_CALLS записей {ts, purpose, model, costUsd, known[, taskId][, interrupted]};
//                  при смене даты не чистятся;
//   blocked      — есть, если файл был повреждён: {reason, corruptFile, at}. Сколько потрачено до поломки,
//                  неизвестно, поэтому лимит не обеспечен: canSpend и cost/guard.js отказывают. Блок снимает
//                  только человек: удалить файл (счёт с нуля, осознанно) или убрать поле blocked, проверив копию;
//   transition   — есть только в переходный день после смены пояса: {fromTimezone, legacy, oldDate, oldSpentUsd,
//                  journalUsd, journalComplete, date, until}; со сменой даты пропадает.
//
// Смена пояса (в файле пояс A — старый файл без timezone считается в legacyTimezone, — в настройке пояс B):
//   1. Резервы pending, счета задач byTask, журнал calls и блок переносятся как есть: переход ничего не освобождает.
//   2. Текущий день — день момента загрузки в поясе B (окно [начало, конец) дня B).
//   3. Сумма старого дня spentUsd (день date в поясе A) переносится целиком, если старый день не закончился
//      раньше начала текущего дня B (окна пересекаются, либо старый день позже — часы шли назад). Окна дней A и B
//      смещены, поэтому точно разделить сумму старого дня нельзя: она остаётся целиком (верхняя оценка).
//   4. Пересчёт по журналу: сумма costUsd записей calls, чей ts попадает в текущий день B (и число записей
//      с costUsd: null — для unknownCalls). Журнал хранит только MAX_CALLS записей, часть дня могла быть вытеснена,
//      поэтому пересчёт — нижняя оценка дня B.
//   5. Переходный день консервативен: spentUsd = max(п. 3, п. 4), unknownCalls = max(старое, пересчёт);
//      сумма никогда не становится меньше перенесённой суммы старого дня.
//   6. Пока не кончился переходный день, accountingStatus().note и отказ reserveWithin по дню показывают:
//      «переходный день: учёт по консервативной оценке до ЧЧ:ММ по <поясу>» (и пометку, если журнал неполон).
//      С началом следующего дня в поясе B — обычный учёт с нуля, только в поясе B.
//   Новый Meter записывает миграцию в файл сразу (под замком), чтобы старый файл толковался один раз: смена
//   пояса машины потом его уже не переистолкует. До записи результат миграции одинаков при каждом чтении.
//   7. Признак миграции — поле timezone (и transition в переходный день): файл с поясом бюджета больше не мигрирует.
//   8. Перед первой записью миграции исходный файл копируется рядом: <file>.pre-tz-<время>-from-<старый пояс>.bak
//      (временный файл, затем rename; копия сверяется с исходным). Копии нет — основной файл не пишется.
//   9. Сбой копии или записи: исходный файл не изменён (запись атомарна), учёт этого экземпляра заблокирован
//      (blockedReason, reserveWithin, canSpend отказывают) с причиной: этап, код ошибки и путь к копии —
//      без содержимого файла. Следующий запуск пробует миграцию заново (снова с копией).
// Нет файла — пустой счёт: это осознанное состояние, а не поломка. Пустой или битый файл — поломка.
// Каждая операция читает файл заново, поэтому экземпляры на одном файле видят суммы и резервы друг друга,
// а экземпляр, созданный после перезапуска, видит те же суммы.
// Ввод-вывод синхронный: внутри процесса цикл чтение-изменение-запись не перемешивается.
// Каждое изменение (record, reserve, release) пишет файл атомарно: временный файл рядом, затем rename.
// На один файл в процессе — один Meter: новый экземпляр считает все незакрытые резервы прерванными.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { priceFor, isPrice } = require('./prices');

const MAX_CALLS = 200;
const MAX_LABEL = 128;
const TOKENS_PER_PRICE = 1e6; // цены в таблице — за 1 млн токенов
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const REASON_UNKNOWN_PRICE = 'цена модели неизвестна — лимит не обеспечен';
const REASON_LIMIT = 'дневной лимит исчерпан';
const REASON_CORRUPT = 'файл учёта повреждён — лимит не обеспечен';
const MIGRATION_CODE = 'budget_migration';

function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// Точная стоимость вызова в USD по usage ответа {promptTokens, cachedTokens, completionTokens, reasoningTokens}.
// null — посчитать нельзя: нет цены или нет нужного счётчика. Ноль вместо неизвестного не возвращаем:
// он занизил бы расход. reasoningTokens уже входят в completionTokens и отдельно не добавляются.
function costOf(usage, price) {
  if (!isPrice(price) || !usage || typeof usage !== 'object') return null;
  const { promptTokens, cachedTokens, completionTokens } = usage;
  if (!isCount(promptTokens) || !isCount(cachedTokens) || !isCount(completionTokens)) return null;
  // Из кэша больше, чем всего на входе: счётчики противоречат друг другу.
  if (cachedTokens > promptTokens) return null;
  const usd = (promptTokens - cachedTokens) * price.inputPerM
    + cachedTokens * price.cachedPerM
    + completionTokens * price.outputPerM;
  return usd / TOKENS_PER_PRICE;
}

// Верхняя граница стоимости, когда точной нет: весь вход по цене без кэша (кэш не дороже),
// счётчики берутся из usage, а недостающие — из pessimisticTokens {inputTokens, outputTokens}.
// С usage === null это оценка запроса до отправки: по ней же резервирует cost/guard.js.
function upperBound(usage, pessimisticTokens, price) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const p = pessimisticTokens && typeof pessimisticTokens === 'object' ? pessimisticTokens : {};
  const input = isCount(u.promptTokens) ? u.promptTokens : p.inputTokens;
  const output = isCount(u.completionTokens) ? u.completionTokens : p.outputTokens;
  if (!isCount(input) || !isCount(output)) return null;
  return (input * Math.max(price.inputPerM, price.cachedPerM) + output * price.outputPerM) / TOKENS_PER_PRICE;
}

// Лимит в USD: число или строка с числом (так он приходит из .env). Пусто — лимит не задан.
// Мусор — ошибка: молча работать без лимита хуже, чем не запуститься.
function parseLimit(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new Error(`Meter: недопустимый дневной лимит: ${value}`);
  return n;
}

// ---- Часовой пояс бюджета ----
// Только Intl, без внешних библиотек. Пояс — имя IANA (Asia/Dushanbe); смещение вроде +05:00 Intl тоже
// принимает, но это не IANA: при смене правил пояса оно не поменяется, поэтому отклоняется.
const DEFAULT_BUDGET_TIMEZONE = 'Asia/Dushanbe';
const DAY_MS = 24 * 60 * 60 * 1000;
const formatters = new Map();

const pad2 = (n) => String(n).padStart(2, '0');

// Настройка не задана: нет значения или пустая строка (как пустой лимит в parseLimit).
function isUnset(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

// Пояс бюджета из настройки: не задан (нет, null или пустая строка) — Asia/Dushanbe; иначе имя IANA, приведённое
// Intl к каноническому виду. Негодный пояс — ошибка при старте: тихо считать день не в том поясе хуже.
function parseTimezone(value, what = 'часовой пояс бюджета budgetTimezone') {
  if (isUnset(value)) return DEFAULT_BUDGET_TIMEZONE;
  const bad = () => new Error(`Meter: недопустимый ${what}: «${value}» — нужно имя пояса IANA, например ${DEFAULT_BUDGET_TIMEZONE}`);
  if (typeof value !== 'string') throw bad();
  const name = value.trim();
  if (/^[+\-\d]/.test(name)) throw bad();
  let resolved;
  try {
    resolved = new Intl.DateTimeFormat('en-CA', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    throw bad();
  }
  if (typeof resolved !== 'string' || resolved === '') throw bad();
  return resolved;
}

// Пояс машины: так считал дату файл прежней версии (getFullYear/getMonth/getDate местного времени).
function machineTimezone() {
  const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof tz === 'string' && tz ? tz : 'UTC';
}

function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

// Часы на стене в поясе tz для момента t (мс): {y, m, d, h, mi, s}.
function wallClock(t, tz) {
  const parts = {};
  for (const p of formatterFor(tz).formatToParts(new Date(t))) parts[p.type] = p.value;
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute), s: Number(parts.second) };
}

// Дата момента d в поясе tz, ГГГГ-ММ-ДД.
function dateIn(d, tz) {
  const w = wallClock(d.getTime(), tz);
  return `${String(w.y).padStart(4, '0')}-${pad2(w.m)}-${pad2(w.d)}`;
}

// Смещение пояса tz в момент t, мс (стенное время минус UTC).
function offsetAt(t, tz) {
  const sec = Math.floor(t / 1000) * 1000;
  const w = wallClock(sec, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - sec;
}

// Начало дня date (ГГГГ-ММ-ДД) в поясе tz, мс. Две итерации по смещению: для поясов без перехода на летнее
// время (Asia/Dushanbe, Asia/Bishkek) точно; при переходе ровно в полночь — ближайший момент.
function dayStart(date, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  let t = base - offsetAt(base, tz);
  t = base - offsetAt(t, tz);
  return t;
}

function nextDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + DAY_MS).toISOString().slice(0, 10);
}

// Окно дня [start, end) в поясе tz, мс.
function dayWindow(date, tz) {
  return { start: dayStart(date, tz), end: dayStart(nextDate(date), tz) };
}

// Время конца переходного дня для сообщения: ЧЧ:ММ в поясе tz; полночь — «24:00» (конец этого же дня).
function untilLabel(untilIso, tz) {
  const w = wallClock(Date.parse(untilIso), tz);
  return w.h === 0 && w.mi === 0 ? '24:00' : `${pad2(w.h)}:${pad2(w.mi)}`;
}

function transitionNote(transition, tz) {
  let note = `переходный день: учёт по консервативной оценке до ${untilLabel(transition.until, tz)} по ${tz}`;
  if (!transition.journalComplete) {
    note += ' (журнал вызовов неполон: часть расхода дня могла не попасть в пересчёт; сумма прежнего дня сохранена целиком)';
  }
  return note;
}

// Метка «миграция только что посчитана» — не попадает в JSON файла. Значение — старый пояс файла.
const MIGRATED = Symbol('migrated');

function markMigrated(state, fromTz) {
  Object.defineProperty(state, MIGRATED, { value: fromTz, enumerable: false, configurable: true });
  return state;
}

// Ошибка миграции: только этап, код ошибки ввода-вывода и путь к копии — тело файла сюда не попадает.
function migrationError(stage, err, backupFile) {
  const cause = err && typeof err.code === 'string' && err.code ? err.code : String((err && err.message) || err).slice(0, 200);
  const reason = `миграция часового пояса учёта не записана (${stage}: ${cause}); исходный файл не изменён; `
    + `резервная копия: ${backupFile || 'не создана'} — лимит не обеспечен`;
  return Object.assign(new Error(`Meter: ${reason}`), { code: MIGRATION_CODE, reason, backupFile: backupFile || null });
}

// Метка для файла: непустая строка, обрезанная до MAX_LABEL; иначе null.
// taskId обрезается так же и в record, и в spentForTask, поэтому длинный ID попадает в один и тот же счёт.
function label(v) {
  return typeof v === 'string' && v ? v.slice(0, MAX_LABEL) : null;
}

// Счета задач хранятся в объекте без прототипа: ID вроде "__proto__" или "constructor" — обычные ключи.
function emptyByTask() {
  return Object.create(null);
}

function emptyState(date, timezone, { calls = [], byTask = emptyByTask(), pending = [], blocked = null } = {}) {
  const state = { date, timezone, spentUsd: 0, unknownCalls: 0, byTask, pending, calls };
  if (blocked) state.blocked = blocked;
  return state;
}

function sumPending(pending) {
  return pending.reduce((sum, p) => sum + p.usd, 0);
}

function trimCalls(calls) {
  if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS);
}

// byTask из файла; null — поле битое. Файл прежней версии без byTask — пустой учёт по задачам.
function parseByTask(value) {
  if (value === undefined) return emptyByTask();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const byTask = emptyByTask();
  for (const [taskId, usd] of Object.entries(value)) {
    if (!taskId || !isCount(usd)) return null;
    byTask[taskId] = usd;
  }
  return byTask;
}

// pending из файла; null — поле битое. Файл прежней версии без pending — резервов нет.
function parsePending(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const ok = value.every((p) => Boolean(p) && typeof p === 'object' && typeof p.id === 'string' && p.id && isCount(p.usd));
  return ok ? value : null;
}

// Пометка блокировки. Любое значение, кроме отсутствующего или null, — блок: лишний отказ лучше лимита без учёта.
function parseBlocked(value) {
  if (value === undefined || value === null) return null;
  const v = typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    reason: typeof v.reason === 'string' ? v.reason : 'файл учёта повреждён',
    corruptFile: typeof v.corruptFile === 'string' ? v.corruptFile : null,
    at: typeof v.at === 'string' ? v.at : null,
  };
}

// Пояс из файла: нет поля (файл прежней версии) — undefined; не строка или не пояс IANA — false (поломка).
function parseFileTimezone(value) {
  if (value === undefined) return undefined;
  // В файле пустой пояс — поломка, а не «по умолчанию».
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    return parseTimezone(value, 'пояс в файле учёта');
  } catch {
    return false;
  }
}

// Пометка переходного дня — только для сообщения: сумма дня уже консервативна. Негодная пометка
// или пометка другого дня отбрасывается.
function parseTransition(value, date) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ok = value.date === date && typeof value.until === 'string' && Number.isFinite(Date.parse(value.until))
    && typeof value.fromTimezone === 'string';
  return ok ? value : null;
}

// Разбор файла состояния; null — файл битый: не JSON или не та структура.
function parseState(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const ok = Boolean(data) && typeof data === 'object' && !Array.isArray(data)
    && typeof data.date === 'string' && DATE_RE.test(data.date)
    && isCount(data.spentUsd)
    && Number.isInteger(data.unknownCalls) && data.unknownCalls >= 0
    && Array.isArray(data.calls);
  if (!ok) return null;
  const byTask = parseByTask(data.byTask);
  const pending = parsePending(data.pending);
  if (!byTask || !pending) return null;
  const timezone = parseFileTimezone(data.timezone);
  if (timezone === false) return null;
  const state = { date: data.date, timezone, spentUsd: data.spentUsd, unknownCalls: data.unknownCalls, byTask, pending, calls: data.calls };
  const blocked = parseBlocked(data.blocked);
  if (blocked) state.blocked = blocked;
  const transition = parseTransition(data.transition, data.date);
  if (transition) state.transition = transition;
  return state;
}

// Замок между процессами: файл <учёт>.lock создаётся флагом «только если его нет» (wx).
// Ожидание дольше LOCK_WAIT_MS — ошибка; замок старше LOCK_STALE_MS — след упавшего процесса, его снимаем.
// Внутри одного процесса замок не берётся повторно: см. _locked.
const LOCK_WAIT_MS = 15000;
const LOCK_STALE_MS = 10000;
const LOCK_POLL_MS = 10;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function acquireLock(lockFile) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return fs.openSync(lockFile, 'wx');
    } catch (err) {
      // На Windows файл, который другой процесс только что удаляет, даёт EPERM/EBUSY: это «замок занят», ждём.
      if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
    }
    let age;
    try {
      age = Date.now() - fs.statSync(lockFile).mtimeMs;
    } catch (err) {
      if (err.code === 'ENOENT') continue; // отпустили между попытками
      throw err;
    }
    if (age > LOCK_STALE_MS) {
      fs.rmSync(lockFile, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Meter: учёт занят другим процессом дольше ${LOCK_WAIT_MS / 1000} с; повторите позже`);
    }
    Atomics.wait(sleepCell, 0, 0, LOCK_POLL_MS);
  }
}

// Резерв чужого живого процесса трогать нельзя: это его вызов в полёте. Переводим в расход резервы, у которых
// процесс-владелец умер (или резерв старого формата без pid, или резерв этого же процесса — прежний экземпляр Meter).
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function isSettleable(p) {
  return p.pid === undefined || p.pid === process.pid || !processAlive(p.pid);
}

class Meter {
  // timezone — пояс бюджета IANA (настройка budgetTimezone); не задан — Asia/Dushanbe, негодный — ошибка.
  // legacyTimezone — в каком поясе считана date файла прежней версии (без поля timezone); по умолчанию пояс машины.
  constructor({ file, dailyLimitUsd, timezone, legacyTimezone, now = () => new Date() } = {}) {
    if (!file) throw new Error('Meter: нужен путь к файлу');
    this.file = file;
    this.dailyLimitUsd = parseLimit(dailyLimitUsd);
    this.timezone = parseTimezone(timezone);
    this.legacyTimezone = isUnset(legacyTimezone)
      ? machineTimezone()
      : parseTimezone(legacyTimezone, 'пояс файла прежней версии legacyTimezone');
    this.now = now;
    this._held = false;
    this._migrationBlock = null; // ошибка миграции (см. шапку, п. 9): учёт этого экземпляра заблокирован
    this._settleInterrupted();
  }

  // Учитывает одну HTTP-попытку вызова модели. Возвращает {costUsd, known}:
  //   usage полный и цена есть — точная стоимость, known: true;
  //   usage === null (сеть, таймаут, ответ без usage) или неполный — верхняя граница, known: false;
  //   цены нет или оценить не по чему — costUsd: null, растёт unknownCalls.
  // taskId (необязательный) — стоимость добавляется и в счёт задачи byTask[taskId].
  record({ purpose, model, usage = null, pessimisticTokens = null, taskId } = {}) {
    const price = priceFor(model);
    let costUsd = null;
    let known = false;
    if (price) {
      costUsd = usage ? costOf(usage, price) : null;
      known = costUsd !== null;
      if (!known) costUsd = upperBound(usage, pessimisticTokens, price);
    }
    const task = label(taskId);
    return this._locked(() => {
      const at = this.now();
      const state = this._load(at);
      if (costUsd === null) {
        state.unknownCalls += 1;
      } else {
        state.spentUsd += costUsd;
        if (task) state.byTask[task] = (state.byTask[task] || 0) + costUsd;
      }
      const entry = { ts: at.toISOString(), purpose: label(purpose), model: label(model), costUsd, known };
      if (task) entry.taskId = task;
      state.calls.push(entry);
      trimCalls(state.calls);
      this._save(state);
      return { costUsd, known };
    });
  }

  // Все изменения файла идут под замком: между процессами цикл «чтение → изменение → запись» не перемешивается.
  // Внутри процесса вложенный вызов проходит без повторного замка (this._held).
  _locked(fn) {
    if (this._held) return fn();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lockFile = `${this.file}.lock`;
    const fd = acquireLock(lockFile);
    this._held = true;
    try {
      return fn();
    } finally {
      this._held = false;
      fs.closeSync(fd);
      fs.rmSync(lockFile, { force: true });
    }
  }

  // Потрачено за текущую локальную дату, USD. Вызовы с неизвестной стоимостью сюда не входят.
  spentToday() {
    return this._load(this.now()).spentUsd;
  }

  // Сколько вызовов за текущую дату не удалось оценить (цена неизвестна).
  unknownCallsToday() {
    return this._load(this.now()).unknownCalls;
  }

  // Потрачено задачей за всё время, USD; 0 — записей по ней нет.
  // Входят точные стоимости и верхние оценки; вызовы с неизвестной стоимостью не входят — их считает unknownCalls.
  spentForTask(taskId) {
    const task = label(taskId);
    if (!task) return 0;
    const usd = this._load(this.now()).byTask[task];
    return usd === undefined ? 0 : usd;
  }

  // Резерв под вызов в полёте: запись в pending файла, синхронно и атомарно — до запроса в сеть.
  // Сразу уменьшает остаток дня. meta {purpose, model, taskId} нужна, чтобы прерванный резерв лёг в те же счета.
  // Возвращает id резерва для release.
  reserve(usd, { purpose, model, taskId } = {}) {
    if (!isCount(usd)) throw new Error(`Meter: недопустимая сумма резерва: ${usd}`);
    return this._locked(() => this._pushPending(this._load(this.now()), usd, { purpose, model, taskId }));
  }

  // Записывает резерв в state и в файл; возвращает id. Вызывается только под замком.
  _pushPending(state, usd, { purpose, model, taskId } = {}) {
    const at = this.now();
    const id = crypto.randomUUID();
    const entry = { id, usd, ts: at.toISOString(), purpose: label(purpose), model: label(model), pid: process.pid };
    const task = label(taskId);
    if (task) entry.taskId = task;
    state.pending.push(entry);
    this._save(state);
    return id;
  }

  // Резерв с проверкой в одном замке: остаток дня и бюджет задачи проверяются и резервируются разом,
  // поэтому два процесса не видят один и тот же остаток. Возвращает {ok: true, id} либо
  // {ok: false, scope: 'meter' | 'day' | 'task', ...}; при отказе резерва нет.
  reserveWithin(usd, { purpose, model, taskId, taskBudgetUsd } = {}) {
    if (!isCount(usd)) throw new Error(`Meter: недопустимая сумма резерва: ${usd}`);
    if (this._migrationBlock) return { ok: false, scope: 'meter', reason: this._migrationBlock.reason };
    return this._locked(() => {
      const state = this._load(this.now());
      if (state.blocked) return { ok: false, scope: 'meter', reason: REASON_CORRUPT };
      if (this.dailyLimitUsd !== null) {
        const remainingUsd = Math.max(0, this.dailyLimitUsd - state.spentUsd - sumPending(state.pending));
        if (remainingUsd - usd < 0) {
          const t = this._transitionOf(state);
          return t ? { ok: false, scope: 'day', remainingUsd, note: transitionNote(t, this.timezone) } : { ok: false, scope: 'day', remainingUsd };
        }
      }
      const task = label(taskId);
      if (task && taskBudgetUsd !== undefined && taskBudgetUsd !== null) {
        const spentUsd = state.byTask[task] || 0;
        if (spentUsd + usd > taskBudgetUsd) return { ok: false, scope: 'task', spentUsd };
      }
      return { ok: true, id: this._pushPending(state, usd, { purpose, model, taskId }) };
    });
  }

  // Снимает резерв по id. true — снят; false — его уже нет: например, экземпляр, созданный после падения,
  // перевёл его в расход. Чужие резервы этим не задеть: id уникален.
  release(id) {
    if (typeof id !== 'string' || !id) throw new Error(`Meter: нужен id резерва, получено: ${id}`);
    return this._locked(() => {
      const state = this._load(this.now());
      const i = state.pending.findIndex((p) => p.id === id);
      if (i === -1) return false;
      state.pending.splice(i, 1);
      this._save(state);
      return true;
    });
  }

  // Сумма резервов вызовов в полёте по файлу (всех экземпляров), USD; без резервов — 0.
  get reservedUsd() {
    return sumPending(this._load(this.now()).pending);
  }

  // Причина блокировки или null. Блок — файл учёта был повреждён (прежний расход неизвестен)
  // или миграция пояса не записалась (см. шапку, п. 9).
  blockedReason() {
    if (this._migrationBlock) return this._migrationBlock.reason;
    return this._load(this.now()).blocked ? REASON_CORRUPT : null;
  }

  // Остаток дневного лимита, USD: лимит − потрачено за день − резервы вызовов в полёте; не меньше нуля.
  // null — лимит не задан. Учёт заблокирован — 0: остаток неизвестен.
  remainingToday() {
    if (this.dailyLimitUsd === null) return null;
    if (this._migrationBlock) return 0;
    const state = this._load(this.now());
    if (state.blocked) return 0;
    return Math.max(0, this.dailyLimitUsd - state.spentUsd - sumPending(state.pending));
  }

  // Статус дневного учёта: {timezone, date, transitional, until, note}. transitional — идёт переходный день после
  // смены пояса: сумма дня — консервативная оценка (см. шапку), note — текст ограничения для владельца, until — ISO
  // конца переходного дня. Вне переходного дня note и until — null.
  accountingStatus() {
    const state = this._load(this.now());
    const t = this._transitionOf(state);
    return {
      timezone: this.timezone,
      date: state.date,
      transitional: Boolean(t),
      until: t ? t.until : null,
      note: t ? transitionNote(t, this.timezone) : null,
    };
  }

  _transitionOf(state) {
    const t = state.transition;
    return t && t.date === state.date ? t : null;
  }

  // Лимит для модели обеспечить можно, только если известна её цена и учёт не заблокирован.
  enforceable(model) {
    return priceFor(model) !== null && this.blockedReason() === null;
  }

  // Можно ли потратить ещё estimateUsd на вызов модели: {ok, reason}.
  // Учёт заблокирован или цены нет — лимит проверить нечем: отказ. Лимит не задан — можно.
  // Оценку не передали — проверяется только, что лимит ещё не исчерпан.
  canSpend(model, estimateUsd) {
    const blocked = this.blockedReason();
    if (blocked) return { ok: false, reason: blocked };
    if (priceFor(model) === null) return { ok: false, reason: REASON_UNKNOWN_PRICE };
    const remaining = this.remainingToday();
    if (remaining === null) return { ok: true, reason: null };
    const estimate = isCount(estimateUsd) ? estimateUsd : 0;
    if (remaining <= 0 || remaining < estimate) return { ok: false, reason: REASON_LIMIT };
    return { ok: true, reason: null };
  }

  // Резервы, которые застал новый экземпляр, остались от процесса, упавшего посреди запроса.
  // Сколько стоили те попытки, неизвестно, поэтому каждый резерв становится расходом по своей сумме —
  // верхней границе вызова: в день, в счёт задачи и в журнал (known: false, interrupted: true).
  _settleInterrupted() {
    this._locked(() => this._settleLocked());
  }

  // Заодно записывает миграцию пояса, если файл был в другом поясе (или прежней версии без поля timezone).
  // Сбой записи миграции не роняет конструктор: учёт блокируется (п. 9 шапки), сообщение — после неудачи,
  // о переходе — только после удачной записи.
  _settleLocked() {
    const at = this.now();
    const state = this._load(at);
    const migrated = Boolean(state[MIGRATED]);
    let notice = null;
    if (migrated) {
      const t = this._transitionOf(state);
      if (t) {
        notice = `Учёт расходов: день бюджета считается по ${this.timezone} (было: ${t.fromTimezone}${t.legacy ? ', местное время машины' : ''}); `
          + `${transitionNote(t, this.timezone)}. Расход дня $${Number(state.spentUsd.toFixed(6))} и резервы перенесены без обнуления`;
      }
    }
    try {
      this._settlePending(state, at, migrated);
    } catch (err) {
      if (err.code !== MIGRATION_CODE) throw err;
      console.error(`Учёт расходов: ${err.reason}. Учёт заблокирован: вызовы модели отклоняются до перезапуска`);
      return;
    }
    if (notice) console.warn(notice);
  }

  _settlePending(state, at, migrated) {
    if (state.pending.length === 0) {
      if (migrated) this._save(state);
      return;
    }
    const settle = state.pending.filter(isSettleable);
    if (settle.length === 0 && !migrated) return;
    for (const p of settle) {
      state.spentUsd += p.usd;
      const task = label(p.taskId);
      if (task) state.byTask[task] = (state.byTask[task] || 0) + p.usd;
      const ts = typeof p.ts === 'string' ? p.ts : at.toISOString();
      const entry = { ts, purpose: label(p.purpose), model: label(p.model), costUsd: p.usd, known: false };
      if (task) entry.taskId = task;
      entry.interrupted = true;
      state.calls.push(entry);
    }
    state.pending = state.pending.filter((p) => !isSettleable(p));
    trimCalls(state.calls);
    this._save(state);
  }

  // Состояние на дату момента at. Файла нет — пустое состояние.
  // Пустой или битый файл — поломка: копия откладывается, учёт блокируется (см. _quarantine).
  _load(at) {
    const today = dateIn(at, this.timezone);
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return emptyState(today, this.timezone);
      throw err;
    }
    // BOM появляется после правки файла в Блокноте.
    raw = raw.replace(/^﻿/, '');
    const state = raw.trim() === '' ? null : parseState(raw);
    if (!state) return this._locked(() => this._quarantine(at));
    const fromTz = state.timezone === undefined ? this.legacyTimezone : state.timezone;
    if (fromTz !== this.timezone) return this._migrate(state, fromTz, at, today);
    // Файл прежней версии, а пояс машины совпал с поясом бюджета: перехода нет, но пояс записывается в файл
    // (см. _settleLocked), чтобы смена пояса машины потом не переистолковала date.
    const legacy = state.timezone === undefined;
    state.timezone = this.timezone;
    // Новая дата: дневные счётчики с нуля; журнал, счета задач, резервы и блок остаются; пометка перехода — нет.
    const result = state.date === today ? state
      : emptyState(today, this.timezone, { calls: state.calls, byTask: state.byTask, pending: state.pending, blocked: state.blocked });
    if (legacy) markMigrated(result, fromTz);
    return result;
  }

  // Смена пояса: правила — в шапке файла (пп. 1–6). Ничего не пишет: запись — в конструкторе или при следующем изменении.
  _migrate(state, fromTz, at, today) {
    const day = dayWindow(today, this.timezone);
    const old = dayWindow(state.date, fromTz);
    // п. 3: сумма старого дня отпадает, только если старый день закончился до начала текущего дня.
    const oldCounts = old.end > day.start;
    // п. 4: пересчёт текущего дня по журналу.
    let journalUsd = 0;
    let journalUnknown = 0;
    for (const c of state.calls) {
      const ts = c && typeof c === 'object' ? Date.parse(c.ts) : NaN;
      if (!Number.isFinite(ts) || ts < day.start || ts >= day.end) continue;
      if (isCount(c.costUsd)) journalUsd += c.costUsd;
      else if (c.costUsd === null) journalUnknown += 1;
    }
    // Журнал полон, и самая старая запись не раньше начала дня — записи этого дня могли быть вытеснены.
    const oldestTs = state.calls.length > 0 && state.calls[0] ? Date.parse(state.calls[0].ts) : NaN;
    const journalComplete = state.calls.length < MAX_CALLS || (Number.isFinite(oldestTs) && oldestTs < day.start);

    const next = emptyState(today, this.timezone, { calls: state.calls, byTask: state.byTask, pending: state.pending, blocked: state.blocked });
    // п. 5: консервативно — большая из сумм.
    next.spentUsd = Math.max(oldCounts ? state.spentUsd : 0, journalUsd);
    next.unknownCalls = Math.max(oldCounts ? state.unknownCalls : 0, journalUnknown);
    if (oldCounts || journalUsd > 0 || journalUnknown > 0) {
      next.transition = {
        fromTimezone: fromTz,
        legacy: state.timezone === undefined,
        oldDate: state.date,
        oldSpentUsd: state.spentUsd,
        journalUsd,
        journalComplete,
        date: today,
        until: new Date(day.end).toISOString(),
      };
    }
    return markMigrated(next, fromTz);
  }

  // Битый файл не затирается: копия уходит в <file>.corrupt-<время>, а на месте основного — пустой счёт
  // с пометкой blocked. Сначала копия, затем атомарная замена: основной файл не пропадает ни на миг,
  // иначе следующая загрузка приняла бы «файла нет» за осознанный ноль.
  _quarantine(at) {
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    let target = `${this.file}.corrupt-${stamp}`;
    // Отложенную ранее копию не перезаписываем.
    for (let i = 2; fs.existsSync(target); i += 1) target = `${this.file}.corrupt-${stamp}-${i}`;
    fs.copyFileSync(this.file, target, fs.constants.COPYFILE_EXCL);
    const state = emptyState(dateIn(at, this.timezone), this.timezone, {
      blocked: { reason: 'файл учёта повреждён', corruptFile: path.basename(target), at: at.toISOString() },
    });
    this._save(state);
    console.error(`Учёт расходов: файл ${this.file} повреждён, копия — ${target}. Учёт заблокирован: `
      + `вызовы модели отклоняются, пока человек не проверит копию (удалить ${this.file} — начать счёт с нуля)`);
    return state;
  }

  // Копия исходного файла перед первой записью миграции (п. 8 шапки): временный файл рядом, затем rename,
  // затем сверка с исходным. Возвращает путь копии; сбой — ошибка миграции. Вызывается только под замком.
  _backupOriginal(fromTz) {
    const dir = path.dirname(this.file);
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const from = String(fromTz).replace(/[^A-Za-z0-9_+-]/g, '_');
    const name = (i) => `${this.file}.pre-tz-${stamp}-from-${from}${i > 1 ? `-${i}` : ''}.bak`;
    let target = name(1);
    // Прежнюю копию не перезаписываем.
    for (let i = 2; fs.existsSync(target); i += 1) target = name(i);
    const tmp = path.join(dir, `.${path.basename(this.file)}.${crypto.randomUUID()}.bak.tmp`);
    try {
      fs.copyFileSync(this.file, tmp, fs.constants.COPYFILE_EXCL);
      fs.renameSync(tmp, target);
    } catch (err) {
      throw migrationError('резервная копия', err, null);
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Важна исходная ошибка.
      }
    }
    let same = false;
    try {
      same = fs.readFileSync(target).equals(fs.readFileSync(this.file));
    } catch (err) {
      throw migrationError('сверка резервной копии', err, target);
    }
    if (!same) throw migrationError('сверка резервной копии', new Error('копия не совпала с исходным файлом'), target);
    return target;
  }

  // Атомарная запись: во временный файл рядом, затем переименование поверх основного.
  // Состояние после миграции пишется только после резервной копии исходного файла; сбой — блок учёта.
  _save(state) {
    const fromTz = state[MIGRATED];
    if (fromTz && this._migrationBlock) throw this._migrationBlock;
    let backupFile = null;
    if (fromTz && fs.existsSync(this.file)) {
      try {
        backupFile = this._backupOriginal(fromTz);
      } catch (err) {
        this._migrationBlock = err;
        throw err;
      }
    }
    try {
      this._write(state);
    } catch (err) {
      if (!fromTz) throw err;
      this._migrationBlock = migrationError('запись учёта', err, backupFile);
      throw this._migrationBlock;
    }
    if (fromTz) delete state[MIGRATED];
  }

  _write(state) {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.file)}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } finally {
      // После удачного rename временного файла уже нет; после сбоя убираем остаток.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Важна исходная ошибка записи, а не неудача уборки.
      }
    }
  }
}

module.exports = {
  Meter, costOf, upperBound, parseTimezone, dateIn, MAX_CALLS, DEFAULT_BUDGET_TIMEZONE, REASON_UNKNOWN_PRICE, REASON_CORRUPT, MIGRATION_CODE,
};
