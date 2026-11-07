'use strict';

// История буфера обмена: удобно вернуться к недавно скопированному тексту.
// Это личные данные владельца, поэтому:
//   - пароли, одноразовые коды, токены и номера карт не сохраняются (ни в файл, ни в журнал);
//   - текст из защищённых полей не сохраняется, даже если эвристика его не узнала;
//   - текст никогда не попадает в сообщения об ошибках и не пишется в журнал;
//   - запись можно поставить на паузу, очистить историю и задать срок хранения.
// Ввод-вывод синхронный, fs и часы внедряются: тесты идут на временных файлах.
// Этот модуль ничего не вставляет в буфер и не читает буфер сам — только хранит то, что дали.
const nodeFs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

const VERSION = 1;
const MAX_ITEMS = 200;
// Предел одной записи в кодовых точках: Array.from не рвёт эмодзи пополам.
const MAX_TEXT = 4000;
// Предел суммарного текста в истории: файл не растёт без края.
const MAX_TOTAL_CHARS = 100000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// Явная метка секрета со значением: «пароль: …», «token=…», «api key — …».
// Голое слово без значения не считается секретом: в истории может быть слово «пароль» в тексте статьи.
const SECRET_LABEL = /(парол\p{L}*|password|passwd|pwd|passphrase|токен\p{L}*|token|секрет\p{L}*|secret|api[\s_-]?key|private[\s_-]?key|client[\s_-]?secret|otp|totp|one[\s-]?time[\s-]?code|cvv|cvc|пин[\s-]?код|pin[\s-]?code)\s*(?:[:=—–-]|это|is)\s*\S{3,}/iu;
// Код подтверждения: слово «код»/code и рядом 3–8 цифр.
const CODE_LABEL = /(?<![\p{L}])(?:код|code|otp|пароль|password)\p{L}*[^\d\n]{0,24}\d{3,8}(?!\d)/iu;
// Ключи известных сервисов и приватные ключи.
const SECRET_KEY = /\b(?:sk|pk|ghp|xox[abp])[-_][\w-]{12,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
// Номер карты: 13–19 цифр, обычно группами. Проверяем по Луну или по явной разбивке на 4.
const CARD_GROUPS = /\b\d{4}[ -]\d{4}[ -]\d{4}(?:[ -]\d{1,4})?\b/;
const CARD_DIGITS = /(?<![\d])\d{13,19}(?![\d])/g;

// Контрольная сумма Луна: у настоящих номеров карт сходится, у случайных чисел — нет.
function luhn(digits) {
  let sum = 0;
  let odd = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (odd) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    odd = !odd;
  }
  return sum % 10 === 0;
}

function looksLikeCard(text) {
  const value = String(text ?? '');
  if (CARD_GROUPS.test(value)) return true;
  for (const match of value.matchAll(CARD_DIGITS)) {
    if (luhn(match[0])) return true;
  }
  return false;
}

// Похоже ли на секрет. Проверка не защита: страховка от случайного сохранения.
// Экспортируется, чтобы интегратор мог спросить заранее и показать предупреждение.
function isPrivateText(text) {
  const value = String(text ?? '');
  return SECRET_LABEL.test(value)
    || CODE_LABEL.test(value)
    || SECRET_KEY.test(value)
    || looksLikeCard(value);
}

// Обрезка по кодовым точкам: emoji не рвётся.
function clipText(text, max) {
  return Array.from(String(text ?? '')).slice(0, max).join('');
}

function emptyState(ttlMs = DEFAULT_TTL_MS) {
  return { version: VERSION, paused: false, ttlMs, items: [] };
}

function normalizeTtl(value) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_MS) {
    throw new Error(`срок хранения: null (бессрочно) или целое число от 1 до ${MAX_TTL_MS} мс`);
  }
  return value;
}

/**
 * Хранилище истории буфера. Одна операция = чтение файла заново, поэтому два
 * экземпляра на одном файле видят друг друга.
 *
 * add() не бросает исключений: запись идёт на каждое копирование, а пауза,
 * защищённое поле и секрет — обычные отказы с понятной причиной.
 */
class ClipboardHistoryStore {
  constructor(filePath, options = {}) {
    if (!filePath) throw new Error('ClipboardHistoryStore: нужен путь к файлу');
    this.filePath = filePath;
    this.fs = options.fs || nodeFs;
    this.path = options.path || nodePath;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : MAX_ITEMS;
    this.maxText = Number.isInteger(options.maxText) && options.maxText > 0 ? options.maxText : MAX_TEXT;
    this.maxTotalChars = Number.isInteger(options.maxTotalChars) && options.maxTotalChars > 0
      ? options.maxTotalChars
      : MAX_TOTAL_CHARS;
    this.defaultTtlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : normalizeTtl(options.ttlMs);
  }

  // Добавить текст. protected — признак защищённого поля (пароль в окне входа).
  // Возврат: {ok, saved, reason?, duplicate?, item?}. Текст в reason/message не попадает.
  add({ text, protected: protectedField = false } = {}) {
    const clean = String(text ?? '');
    if (!clean.trim()) return { ok: false, saved: false, reason: 'empty', message: 'пустой текст' };
    if (protectedField === true) {
      return { ok: false, saved: false, reason: 'protected', message: 'защищённое поле: не сохраняю' };
    }
    if (isPrivateText(clean)) {
      return { ok: false, saved: false, reason: 'private', message: 'похоже на пароль, код или номер карты: не сохраняю' };
    }
    const data = this._load();
    if (data.paused) {
      return { ok: false, saved: false, reason: 'paused', message: 'запись истории буфера на паузе' };
    }
    const nowMs = this.now();
    this._prune(data, nowMs);
    const existing = data.items.find((item) => item.text === clean);
    if (existing) {
      // Дубликат не плодим: поднимаем запись наверх и обновляем время копирования.
      data.items = [existing, ...data.items.filter((item) => item !== existing)];
      existing.copiedAt = new Date(nowMs).toISOString();
      this._trim(data);
      this._save(data);
      return { ok: true, saved: true, duplicate: true, item: existing };
    }
    const full = Array.from(clean);
    const truncated = full.length > this.maxText;
    const record = {
      id: crypto.randomUUID(),
      text: truncated ? full.slice(0, this.maxText).join('') : clean,
      chars: Math.min(full.length, this.maxText),
      createdAt: new Date(nowMs).toISOString(),
      copiedAt: new Date(nowMs).toISOString(),
      truncated,
    };
    data.items = [record, ...data.items];
    this._trim(data);
    this._save(data);
    return { ok: true, saved: true, duplicate: false, item: record };
  }

  // Список, новые сверху. query — поиск по тексту без учёта регистра.
  // Заодно убирает записи старше срока хранения.
  list({ limit = 50, query = null } = {}) {
    const data = this._load();
    if (this._prune(data, this.now())) this._save(data);
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const items = needle
      ? data.items.filter((item) => item.text.toLowerCase().includes(needle))
      : data.items.slice();
    const max = Number.isInteger(limit) && limit > 0 ? limit : 50;
    return items.slice(0, max).map((item) => ({ ...item }));
  }

  get(id) {
    const data = this._load();
    if (this._prune(data, this.now())) this._save(data);
    const item = data.items.find((entry) => entry.id === id);
    return item ? { ...item } : null;
  }

  // true — запись была и удалена; false — такого id нет.
  remove(id) {
    const data = this._load();
    const kept = data.items.filter((item) => item.id !== id);
    if (kept.length === data.items.length) return false;
    this._save({ ...data, items: kept });
    return true;
  }

  // Очистка — явное действие владельца. Работает и с повреждённым файлом:
  // сбросить историю можно даже тогда, когда прочитать её нельзя.
  clear() {
    let removed = 0;
    try {
      removed = this._load().items.length;
    } catch {
      removed = 0;
    }
    this._save({ version: VERSION, paused: false, ttlMs: this.defaultTtlMs, items: [] });
    return { ok: true, removed };
  }

  pause() {
    const data = this._load();
    data.paused = true;
    this._save(data);
    return { ok: true, paused: true };
  }

  resume() {
    const data = this._load();
    data.paused = false;
    this._save(data);
    return { ok: true, paused: false };
  }

  // Срок хранения: null — бессрочно, число мс — старше этого не храним.
  // Уменьшение срока сразу убирает лишние записи.
  setTtl(ms) {
    const ttlMs = normalizeTtl(ms);
    const data = this._load();
    data.ttlMs = ttlMs;
    if (ttlMs !== null) this._prune(data, this.now());
    this._save(data);
    return { ok: true, ttlMs };
  }

  // Состояние без текстов: пауза, срок, количество и объём.
  state() {
    const data = this._load();
    if (this._prune(data, this.now())) this._save(data);
    return {
      ok: true,
      paused: data.paused === true,
      ttlMs: data.ttlMs === undefined ? this.defaultTtlMs : data.ttlMs,
      count: data.items.length,
      chars: data.items.reduce((sum, item) => sum + String(item.text || '').length, 0),
      maxItems: this.maxItems,
    };
  }

  // Убрать просроченное; возвращает число удалённых записей.
  cleanup() {
    const data = this._load();
    const removed = this._prune(data, this.now());
    if (removed) this._save(data);
    return { ok: true, removed };
  }

  _prune(data, nowMs) {
    const ttl = data.ttlMs === undefined ? this.defaultTtlMs : data.ttlMs;
    let removed = 0;
    if (ttl !== null) {
      const before = data.items.length;
      data.items = data.items.filter((item) => {
        const copied = Date.parse(item.copiedAt || item.createdAt || '');
        // Запись с нечитаемой датой не удаляем молча: пусть владелец увидит её и решит сам.
        return Number.isNaN(copied) || nowMs - copied <= ttl;
      });
      removed += before - data.items.length;
    }
    const beforeTrim = data.items.length;
    this._trim(data);
    return removed + (beforeTrim - data.items.length);
  }

  // Пределы: число записей и суммарный объём текста. Старые уходят первыми.
  _trim(data) {
    if (data.items.length > this.maxItems) data.items = data.items.slice(0, this.maxItems);
    let total = data.items.reduce((sum, item) => sum + Array.from(String(item.text || '')).length, 0);
    while (data.items.length > 0 && total > this.maxTotalChars) {
      const dropped = data.items.pop();
      total -= Array.from(String(dropped.text || '')).length;
    }
  }

  _load() {
    let raw;
    try {
      raw = this.fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return emptyState(this.defaultTtlMs);
      throw err;
    }
    if (String(raw).trim() === '') return emptyState(this.defaultTtlMs);
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
      // Повреждённый файл не перезаписываем: иначе история молча пропадёт.
      throw new Error(`файл истории буфера повреждён: ${this.filePath}`);
    }
    const items = data.items
      .filter((item) => item && typeof item === 'object' && typeof item.text === 'string' && item.text !== '')
      // Страховка: если файл правили руками и в нём оказался пароль, при чтении он отбрасывается.
      .filter((item) => !isPrivateText(item.text))
      .map((item) => ({
        id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
        text: clipText(item.text, MAX_TEXT),
        chars: Number.isInteger(item.chars) ? item.chars : Array.from(item.text).length,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
        copiedAt: typeof item.copiedAt === 'string' ? item.copiedAt : (typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString()),
        truncated: item.truncated === true,
      }));
    return {
      version: VERSION,
      paused: data.paused === true,
      ttlMs: data.ttlMs === null ? null : (Number.isInteger(data.ttlMs) ? data.ttlMs : this.defaultTtlMs),
      items,
    };
  }

  // Атомарная запись: временный файл рядом, затем переименование поверх.
  _save(data) {
    const dir = this.path.dirname(this.filePath);
    this.fs.mkdirSync(dir, { recursive: true });
    const tmp = this.path.join(dir, `.${this.path.basename(this.filePath)}.${crypto.randomUUID()}.tmp`);
    try {
      this.fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      this.fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        this.fs.rmSync(tmp, { force: true });
      } catch {
        // Важна исходная ошибка записи, а не неудача уборки временного файла.
      }
      throw err;
    }
  }
}

module.exports = {
  ClipboardHistoryStore,
  isPrivateText,
  looksLikeCard,
  luhn,
  MAX_ITEMS,
  MAX_TEXT,
  MAX_TOTAL_CHARS,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  VERSION,
};
