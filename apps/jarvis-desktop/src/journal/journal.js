'use strict';

const fs = require('fs');
const path = require('path');

// Инструменты, у которых аргумент text — набранный текст (в том числе пароли). В журнал пишем только длину.
const TYPED_TEXT_TOOLS = new Set(['ui_type', 'clipboard_set', 'browser_type']);

// Ротация журнала (идея Hermes): живой файл не больше 10 МБ, прошлые — .1, .2, .3.
// Чтение и поиск идут по всей цепочке, поэтому история не теряется.
const JOURNAL_MAX_BYTES = 10 * 1024 * 1024;
const JOURNAL_BACKUPS = 3;
const MAX_ROTATED_FILES = 10;

// Копия аргументов для журнала: набранный текст заменяется на «[скрыто, N симв.]». Сами аргументы не меняются.
function maskArgs(tool, args) {
  if (tool === 'command_create' && args && Array.isArray(args.steps)) {
    return { ...args, steps: args.steps.map((s) => (s && s.args ? { ...s, args: maskArgs(s.tool, s.args) } : s)) };
  }
  if (!TYPED_TEXT_TOOLS.has(tool) || !args || typeof args !== 'object' || !('text' in args)) return args;
  const text = args.text == null ? '' : String(args.text);
  return { ...args, text: `[скрыто, ${text.length} симв.]` };
}

// Копия истории для файла разговора: без набранного текста и содержимого буфера.
function maskHistory(history) {
  const clipboardReads = new Set();
  return history.map((m) => {
    if (m.role === 'tool' && clipboardReads.has(m.tool_call_id)) return { ...m, content: JSON.stringify({ ok: true, summary: '[содержимое буфера скрыто]' }) };
    if (!Array.isArray(m.tool_calls)) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map((c) => {
        const name = c.function && c.function.name;
        if (name === 'clipboard_get') clipboardReads.add(c.id);
        try {
          return { ...c, function: { ...c.function, arguments: JSON.stringify(maskArgs(name, JSON.parse(c.function.arguments))) } };
        } catch {
          return c;
        }
      }),
    };
  });
}

// ── Маскировка секретов до записи ───────────────────────────────────────────
// maskArgs выше знает только набранный текст. Здесь — общая страховка: пароли, ключи,
// токены и коды не должны попасть в файл ни в аргументах, ни в итоге вызова.
const MAX_MASK_DEPTH = 8;
// Имена полей, значение которых целиком является секретом.
const SECRET_FIELD = /^(?:парол\p{L}*|password|passwd|pass|api[\s_-]?key|token|access[\s_-]?token|refresh[\s_-]?token|токен\p{L}*|secret|секрет\p{L}*|pin|cvv|cvc|otp|код[\s_-]?подтверждения)$/iu;
// Метка секрета со значением: «пароль: hunter22», «"password":"…"», «api key = …».
const SECRET_LABEL = /((?:парол\p{L}*|password|passwd|api[\s_-]?key|токен\p{L}*|access[\s_-]?token|refresh[\s_-]?token|token|секрет\p{L}*|secret|пин[-\s]?код|pin|cvv|cvc|otp|код\s+подтверждения)\s*(?:[:=—–-]|это|is)\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu;
// Известные форматы ключей и длинные токены без метки.
const SECRET_KEY = /\b(?:sk|pk|ghp|xox[abp])[-_][A-Za-z0-9_-]{12,}\b/g;
const SECRET_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
// Длинные токены без метки прячем, но UUID (id команды/задачи/пространства) — не секрет:
// без него история теряет связь с делом, поэтому форму 8-4-4-4-12 исключаем.
const BARE_TOKEN = /\b(?![\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b)(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{32,}\b/gi;

function hiddenLength(value) {
  return Array.from(String(value)).length;
}

// Строка без секретов: метки «пароль: значение» и известные форматы ключей.
function maskSecretText(value) {
  if (typeof value !== 'string' || !value) return value;
  return value
    .replace(SECRET_BLOCK, '[скрыто: приватный ключ]')
    .replace(SECRET_LABEL, '$1[скрыто]')
    .replace(SECRET_KEY, '[скрыто: ключ]')
    .replace(BARE_TOKEN, (token) => `[скрыто, ${hiddenLength(token)} симв.]`);
}

// Глубокая копия значения без секретов. Неизвестные поля сохраняются, меняются только
// значения, которые выглядят секретом. Глубина ограничена, чтобы запись не зависла на цикле.
// Объекты с чужим прототипом (Date, Map и т.п.) не разбираем на поля — возвращаем как есть.
function maskSecrets(value, depth = 0) {
  if (depth > MAX_MASK_DEPTH) return '[скрыто: слишком глубоко]';
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, depth + 1));
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELD.test(key) && item !== null && item !== undefined && typeof item !== 'object') {
        out[key] = `[скрыто, ${hiddenLength(item)} симв.]`;
      } else {
        out[key] = maskSecrets(item, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string') return maskSecretText(value);
  return value;
}

// Журнал действий: одна JSON-строка на запись, только дописывание.
class Journal {
  // maxBytes/backups — для проверок; в приложении берутся значения по умолчанию.
  constructor(filePath, { maxBytes = JOURNAL_MAX_BYTES, backups = JOURNAL_BACKUPS } = {}) {
    if (!filePath) throw new Error('Journal: нужен путь к файлу');
    this.filePath = filePath;
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : JOURNAL_MAX_BYTES;
    this.backups = Number.isInteger(backups) && backups >= 1 ? backups : JOURNAL_BACKUPS;
  }

  // Сдвиг цепочки: .N удаляется, .N-1 → .N, живой файл → .1. Ошибка не теряет запись: файл остаётся на месте.
  _rotate() {
    const oldest = `${this.filePath}.${this.backups}`;
    fs.rmSync(oldest, { force: true });
    for (let i = this.backups - 1; i >= 1; i -= 1) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      if (!fs.existsSync(from)) continue;
      fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
    }
    fs.renameSync(this.filePath, `${this.filePath}.1`);
    return true;
  }

  append(entry = {}) {
    const ts = new Date().toISOString();
    // Маскировка здесь, а не в вызывающем коде: все места записи (чат, команды, задачи, миссии, Telegram) идут через этот метод.
    const safe = 'args' in entry ? { ...entry, args: maskArgs(entry.tool, entry.args) } : entry;
    const record = { ts, ...safe };
    record.ts = ts; // время ставит журнал, а не вызывающий код
    // Секреты маскируются до записи на диск: в файле их не должно быть ни в аргументах, ни в итоге.
    // Неизвестные поля записи сохраняются: связь хода и проверки (runId, step, callId) тоже.
    const stored = maskSecrets(record);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, JSON.stringify(stored) + '\n', 'utf8');
    // Рост ограничиваем после записи: запись уже сохранена, сбой ротации не теряет её.
    try {
      if (fs.statSync(this.filePath).size > this.maxBytes) this._rotate();
    } catch {
      // Не удалось повернуть (файл занят): журнал продолжает расти, данные на месте.
    }
    return stored;
  }
}

// ── Чтение и поиск истории ───────────────────────────────────────────────────
// Журнал только дописывается, поэтому чтение не меняет файл: битая строка пропускается,
// отсутствие файла — пустое состояние, а не исключение (экран «История» не должен падать).
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 500;
const HISTORY_STATUSES = ['confirmed', 'unverified', 'failed', 'refused', 'error', 'done'];
const REFUSED_SUMMARY = /^(отклонено|отказано|запрещено|остановлено)$/i;

// Статус записи для экрана истории. Не проверенный результат не выглядит выполненным:
// verified === 'unknown' — «не проверено», запись без итога — тоже не «выполнено».
// Остальные правила совпадают с renderer/shared.js statusOfRecord, чтобы история не спорила с экраном.
function historyStatus(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'error';
  if (record.decision === 'reject' || record.decision === 'deny') return 'refused';
  if (record.verified === 'failed') return 'failed';
  if (record.ok === true) {
    if (record.verified === 'unknown') return 'unverified';
    if (record.verified === 'confirmed') return 'confirmed';
    return 'done';
  }
  if (record.ok === false) {
    return REFUSED_SUMMARY.test(String(record.summary || '').trim()) ? 'refused' : 'error';
  }
  return 'unverified';
}

// Строки журнала: [{entry, index}], число битых строк. Ни одна битая строка не лишает остальных.
function parseJournalLines(raw) {
  const entries = [];
  let skipped = 0;
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

function limitOf(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(n, MAX_HISTORY_LIMIT);
}

function offsetOf(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function msOf(value) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Дата фильтра: null — фильтра нет; исключение — вызывающий передал неверную дату.
function dateFilter(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const ms = msOf(value);
  if (ms === null) throw new Error(`${label}: нужна дата, например 2026-11-07`);
  return ms;
}

// Файлы журнала от новых к старым: живой, .1, .2 … Пропуск в цепочке останавливает обход.
function journalChain(file) {
  const files = [file];
  for (let i = 1; i <= MAX_ROTATED_FILES; i += 1) {
    const part = `${file}.${i}`;
    if (!fs.existsSync(part)) break;
    files.push(part);
  }
  return files;
}

// Содержимое всей цепочки в хронологическом порядке: старые файлы сначала, живой — последним.
// Отсутствующий живой файл — не ошибка: после ротации записей в нём ещё может не быть.
function readJournalChain(file) {
  const files = journalChain(file).reverse();
  let raw = '';
  for (const part of files) {
    let text;
    try {
      text = fs.readFileSync(part, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      return { problem: `журнал не прочитан: ${err && err.message ? err.message : err}` };
    }
    raw += `${text.replace(/^\uFEFF/, '')}\n`;
  }
  return { raw };
}

// Все записи цепочки журнала, новые сверху, с вычисленным статусом.
function loadHistory(file) {
  const empty = { items: [], total: 0, skipped: 0, problem: null };
  if (typeof file !== 'string' || !file) return { ...empty, problem: 'журнал: не задан путь к файлу' };
  const chain = readJournalChain(file);
  if (chain.problem) return { ...empty, problem: chain.problem };
  const parsed = parseJournalLines(chain.raw);
  const rows = parsed.entries.map((entry, index) => {
    const ms = msOf(entry.ts);
    return { entry, index, ms: ms === null ? 0 : ms };
  });
  rows.sort((a, b) => b.ms - a.ms || b.index - a.index);
  return {
    items: rows.map(({ entry }) => ({ ...entry, status: historyStatus(entry) })),
    total: rows.length,
    skipped: parsed.skipped,
    problem: null,
  };
}

// Последние записи истории (новые сверху). Страницы: offset и limit в записях.
function readJournal(file, { limit = DEFAULT_HISTORY_LIMIT, offset = 0 } = {}) {
  const loaded = loadHistory(file);
  const start = offsetOf(offset);
  const n = limitOf(limit);
  return { ...loaded, items: loaded.items.slice(start, start + n) };
}

// Поиск и фильтры истории: подстрока (действие, итог, проверка, аргументы, источник),
// точный тип (tool/source), пространство (workspaceId), связанное задание (taskId), итог, диапазон дат.
// Фильтры применяются до страницы.
function searchJournal(file, { query = '', status = null, tool = null, source = null, workspaceId = null, taskId = null, from = null, to = null, limit = DEFAULT_HISTORY_LIMIT, offset = 0 } = {}) {
  if (status !== null && status !== undefined && status !== '' && status !== 'all' && !HISTORY_STATUSES.includes(status)) {
    throw new Error(`статус: ${HISTORY_STATUSES.join(', ')}`);
  }
  const fromMs = dateFilter(from, 'с даты');
  const toMs = dateFilter(to, 'по дату');
  if (fromMs !== null && toMs !== null && fromMs > toMs) throw new Error('диапазон дат: «с» позже «по»');
  const needle = String(query ?? '').trim().toLowerCase();
  const toolName = typeof tool === 'string' && tool.trim() ? tool.trim() : null;
  const sourceName = typeof source === 'string' && source.trim() ? source.trim() : null;
  const taskName = typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
  const spaceName = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : null;
  const wantStatus = typeof status === 'string' && status && status !== 'all' ? status : null;

  const loaded = loadHistory(file);
  if (loaded.problem) return loaded;
  const items = loaded.items.filter((entry) => {
    if (wantStatus !== null && entry.status !== wantStatus) return false;
    if (toolName !== null && entry.tool !== toolName) return false;
    if (sourceName !== null && entry.source !== sourceName) return false;
    if (taskName !== null && entry.taskId !== taskName) return false;
    if (spaceName !== null && (entry.workspaceId || 'default') !== spaceName) return false;
    const ms = msOf(entry.ts);
    if (fromMs !== null && (ms === null || ms < fromMs)) return false;
    if (toMs !== null && (ms === null || ms > toMs)) return false;
    if (!needle) return true;
    const parts = [entry.tool, entry.source, entry.summary, entry.evidence, entry.args, entry.taskId, entry.mission, entry.long, entry.command, entry.workspaceId];
    const hay = parts
      .filter((part) => part !== undefined && part !== null)
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join(' ')
      .toLowerCase();
    return hay.includes(needle);
  });
  const start = offsetOf(offset);
  return {
    items: items.slice(start, start + limitOf(limit)),
    total: items.length,
    skipped: loaded.skipped,
    problem: null,
  };
}

module.exports = {
  Journal,
  maskArgs,
  maskHistory,
  maskSecrets,
  maskSecretText,
  historyStatus,
  readJournal,
  searchJournal,
  HISTORY_STATUSES,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
};
