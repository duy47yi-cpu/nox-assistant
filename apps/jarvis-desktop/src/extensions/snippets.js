'use strict';

// Быстрые вставки: короткий триггер и готовый текст к нему (адрес, подпись, шаблон письма).
// Модуль САМ НИЧЕГО НЕ ВСТАВЛЯЕТ и не трогает буфер: он только хранит записи и по явному
// вызову отдаёт текст. Вставка требует confirm === true; без него текст не выдаётся.
// Пароли, ключи и номера карт в текстах не хранятся; в сообщениях об ошибках текста нет.
// Ввод-вывод синхронный, fs и часы внедряются: тесты идут на временных файлах.
const nodeFs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');
const { looksLikeCard } = require('./clipboard-history');

const VERSION = 1;
const MAX_ITEMS = 100;
const MAX_TRIGGER = 40;
const MAX_TEXT = 4000;

const SECRET_LABEL = /(парол\p{L}*|password|passwd|pwd|passphrase|токен\p{L}*|token|секрет\p{L}*|secret|api[\s_-]?key|private[\s_-]?key|client[\s_-]?secret|cvv|cvc|пин[\s-]?код|pin[\s-]?code)\s*(?:[:=—–-]|это|is)\s*\S{3,}/iu;
const CODE_LABEL = /(?:код подтверждения|смс[\s-]?код|одноразов\p{L}* код|one[\s-]?time[\s-]?code|otp|totp)[^\d\n]{0,24}\d{3,8}/iu;
const SECRET_KEY = /\b(?:sk|pk|ghp|xox[abp])[-_][\w-]{12,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

function looksSecret(text) {
  const value = String(text ?? '');
  return SECRET_LABEL.test(value) || CODE_LABEL.test(value) || SECRET_KEY.test(value) || looksLikeCard(value);
}

function clipText(text, max) {
  return Array.from(String(text ?? '')).slice(0, max).join('');
}

// Ключ уникальности триггера: без регистра, ё как е, лишние пробелы схлопнуты.
function triggerKey(trigger) {
  return String(trigger ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

function checkTrigger(trigger) {
  const clean = String(trigger ?? '').trim();
  const points = Array.from(clean).length;
  if (!clean) throw new Error('пустой триггер');
  if (points > MAX_TRIGGER) throw new Error(`триггер длиннее ${MAX_TRIGGER} символов`);
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new Error('в триггере есть управляющие символы');
  return clean;
}

function checkText(text) {
  const clean = String(text ?? '');
  if (!clean.trim()) throw new Error('пустой текст');
  if (looksSecret(clean)) throw new Error('текст похож на пароль, код или ключ: не сохраняю');
  const points = Array.from(clean).length;
  if (points > MAX_TEXT) throw new Error(`текст длиннее ${MAX_TEXT} символов`);
  return clean;
}

function emptyState() {
  return { version: VERSION, items: [] };
}

/**
 * Хранилище быстрых вставок. Каждая операция читает файл заново, поэтому два
 * экземпляра на одном файле видят друг друга.
 *
 * Ошибки проверки бросаются до записи: файл при отказе не меняется.
 */
class SnippetStore {
  constructor(filePath, options = {}) {
    if (!filePath) throw new Error('SnippetStore: нужен путь к файлу');
    this.filePath = filePath;
    this.fs = options.fs || nodeFs;
    this.path = options.path || nodePath;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : MAX_ITEMS;
  }

  add({ trigger, text } = {}) {
    const cleanTrigger = checkTrigger(trigger);
    const cleanText = checkText(text);
    const data = this._load();
    if (data.items.some((item) => triggerKey(item.trigger) === triggerKey(cleanTrigger))) {
      throw new Error(`триггер «${cleanTrigger}» уже занят`);
    }
    if (data.items.length >= this.maxItems) throw new Error(`вставок уже ${this.maxItems}: больше не храню`);
    const stamp = new Date(this.now()).toISOString();
    const record = {
      id: crypto.randomUUID(),
      trigger: cleanTrigger,
      text: cleanText,
      createdAt: stamp,
      updatedAt: stamp,
    };
    data.items.push(record);
    this._save(data);
    return { ...record };
  }

  // Правка: trigger и/или text. id, createdAt не меняются; updatedAt обновляется.
  // Возврат null, если такого id нет. Конфликт триггера — ошибка до записи.
  update(id, patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('правка: нужен объект полей');
    const data = this._load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item) return null;
    let nextTrigger = item.trigger;
    let nextText = item.text;
    if ('trigger' in patch) nextTrigger = checkTrigger(patch.trigger);
    if ('text' in patch) nextText = checkText(patch.text);
    if (triggerKey(nextTrigger) !== triggerKey(item.trigger)) {
      if (data.items.some((entry) => entry.id !== id && triggerKey(entry.trigger) === triggerKey(nextTrigger))) {
        throw new Error(`триггер «${nextTrigger}» уже занят`);
      }
    }
    item.trigger = nextTrigger;
    item.text = nextText;
    item.updatedAt = new Date(this.now()).toISOString();
    this._save(data);
    return { ...item };
  }

  // true — вставка была и удалена; false — такого id нет.
  remove(id) {
    const data = this._load();
    const kept = data.items.filter((item) => item.id !== id);
    if (kept.length === data.items.length) return false;
    this._save({ ...data, items: kept });
    return true;
  }

  // Список в порядке добавления. Тексты отдаются владельцу целиком.
  list() {
    return this._load().items.map((item) => ({ ...item }));
  }

  get(id) {
    const item = this._load().items.find((entry) => entry.id === id);
    return item ? { ...item } : null;
  }

  findByTrigger(trigger) {
    const key = triggerKey(trigger);
    const item = this._load().items.find((entry) => triggerKey(entry.trigger) === key);
    return item ? { ...item } : null;
  }

  // Только чтение: показать владельцу, что будет вставлено. Ничего не вставляет.
  preview(id) {
    const item = this._load().items.find((entry) => entry.id === id);
    if (!item) return { ok: false, reason: 'not_found', message: 'такой вставки нет' };
    return { ok: true, id: item.id, trigger: item.trigger, text: item.text };
  }

  // Явная вставка. Без confirm === true текст не выдаётся вообще.
  // writer (необязательный) — функция, которая вставляет текст: main.js передаёт запись в буфер.
  // Без writer модуль просто отдаёт текст вызывающему коду, сам ничего не делает.
  async insert(id, { confirm = false, writer = null } = {}) {
    const item = this._load().items.find((entry) => entry.id === id);
    if (!item) return { ok: false, reason: 'not_found', message: 'такой вставки нет' };
    if (confirm !== true) {
      return { ok: false, reason: 'confirm_required', message: 'вставка только по явному подтверждению владельца' };
    }
    if (typeof writer === 'function') {
      try {
        await writer(item.text, { trigger: item.trigger, id: item.id });
      } catch (err) {
        return { ok: false, reason: 'writer_failed', message: `не удалось вставить текст: ${String((err && err.message) || err)}` };
      }
      return { ok: true, inserted: true, id: item.id, trigger: item.trigger };
    }
    return { ok: true, inserted: false, id: item.id, trigger: item.trigger, text: item.text };
  }

  // Очистка — явное действие владельца; работает и с повреждённым файлом.
  clear() {
    let removed = 0;
    try {
      removed = this._load().items.length;
    } catch {
      removed = 0;
    }
    this._save(emptyState());
    return { ok: true, removed };
  }

  state() {
    const data = this._load();
    return { ok: true, count: data.items.length, maxItems: this.maxItems };
  }

  _load() {
    let raw;
    try {
      raw = this.fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return emptyState();
      throw err;
    }
    if (String(raw).trim() === '') return emptyState();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
      // Повреждённый файл не перезаписываем: иначе вставки молча пропадут.
      throw new Error(`файл быстрых вставок повреждён: ${this.filePath}`);
    }
    const items = data.items
      .filter((item) => item && typeof item === 'object'
        && typeof item.trigger === 'string' && item.trigger.trim() !== ''
        && typeof item.text === 'string' && item.text !== '')
      // Страховка: если файл правили руками и в нём оказался пароль, при чтении он отбрасывается.
      .filter((item) => !looksSecret(item.text))
      .map((item) => ({
        id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
        trigger: clipText(item.trigger.trim(), MAX_TRIGGER),
        text: clipText(item.text, MAX_TEXT),
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
        updatedAt: typeof item.updatedAt === 'string'
          ? item.updatedAt
          : (typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString()),
      }));
    return { version: VERSION, items };
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
  SnippetStore,
  looksSecret,
  triggerKey,
  MAX_ITEMS,
  MAX_TRIGGER,
  MAX_TEXT,
  VERSION,
};
