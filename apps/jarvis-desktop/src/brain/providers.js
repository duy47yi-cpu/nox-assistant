'use strict';

// Провайдеры владельца: свои локальные ИИ и любые совместимые адреса (base URL /chat/completions).
// Работает только в сборке владельца (src/config/build.js): иначе каждый вызов отказывает, а client() — null.
// Список — providers.json в папке данных. Ключ в нём только зашифрованным (protect = safeStorage, как account.bin и gmail.bin);
// без шифрования ключ не сохраняется. Подключение — обычный DeepSeekClient: инструменты идут через decide как всегда.
const fs = require('fs');
const path = require('path');
const { DeepSeekClient } = require('./deepseek');
const { writeFileAtomic } = require('../config/atomic');

const NOT_OWNER = 'Доступно только в сборке владельца';

const fail = (message, code = 'bad_args') => Object.assign(new Error(message), { code });
const text = (v) => (typeof v === 'string' ? v.trim() : '');

class OwnerProviders {
  constructor({ ownerBuild, file, protect = null }) {
    this.ownerBuild = ownerBuild === true;
    this.file = file;
    this.protect = protect;
    this._cache = { sig: '', client: null };
  }

  _check() {
    if (!this.ownerBuild) throw fail(NOT_OWNER, 'not_owner');
  }

  _read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { selected: text(d.selected), providers: Array.isArray(d.providers) ? d.providers.filter((p) => p && text(p.name)) : [] };
    } catch {
      return { selected: '', providers: [] };
    }
  }

  _write(d) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(d, null, 2));
  }

  // Ключ наружу не отдаём даже зашифрованным: окну хватает «есть ключ».
  list() {
    this._check();
    const d = this._read();
    return { selected: d.selected, providers: d.providers.map((p) => ({ name: p.name, baseUrl: p.baseUrl, model: p.model, hasKey: Boolean(p.key) })) };
  }

  // Новый или с тем же именем — замена. Пустой ключ у существующего оставляет прежний.
  save({ name, baseUrl, model, key } = {}) {
    this._check();
    const entry = { name: text(name), baseUrl: text(baseUrl).replace(/\/+$/, ''), model: text(model) };
    if (!entry.name || entry.name.length > 60) throw fail('Нужно имя до 60 знаков');
    if (!/^https?:\/\/[^\s/]+/i.test(entry.baseUrl)) throw fail('Адрес должен начинаться с http:// или https://');
    if (!entry.model) throw fail('Нужна модель');
    const secret = text(key);
    if (secret && !this.protect) throw fail('Шифрование Windows недоступно: ключ не сохранён');
    const d = this._read();
    const old = d.providers.find((p) => p.name === entry.name);
    entry.key = secret ? this.protect.encrypt(secret).toString('base64') : (old && old.key) || '';
    d.providers = old ? d.providers.map((p) => (p === old ? entry : p)) : [...d.providers, entry];
    this._write(d);
    return this.list();
  }

  remove(name) {
    this._check();
    const d = this._read();
    d.providers = d.providers.filter((p) => p.name !== name);
    if (d.selected === name) d.selected = '';
    this._write(d);
    return this.list();
  }

  // Пустое имя — снова обычные «Быстрая» и «Умная».
  select(name) {
    this._check();
    const d = this._read();
    const pick = text(name);
    if (pick && !d.providers.some((p) => p.name === pick)) throw fail('Такого провайдера нет');
    d.selected = pick;
    this._write(d);
    return this.list();
  }

  // Клиент выбранного провайдера или null. Тот же клиент, пока запись не менялась: он помнит отказы провайдера от потока.
  client() {
    if (!this.ownerBuild) return null;
    const d = this._read();
    const p = d.providers.find((x) => x.name === d.selected);
    if (!p || !text(p.baseUrl) || !text(p.model)) return null;
    const sig = JSON.stringify([p.baseUrl, p.model, p.key, Boolean(this.protect)]);
    if (this._cache.sig === sig) return this._cache.client;
    let apiKey = 'none'; // локальному серверу ключ не нужен, а клиент без ключа не шлёт запрос
    if (p.key && this.protect) {
      try {
        apiKey = this.protect.decrypt(Buffer.from(p.key, 'base64'));
      } catch { /* другой пользователь Windows: ключ не прочитать, провайдер ответит отказом */ }
    }
    this._cache = { sig, client: new DeepSeekClient({ baseUrl: p.baseUrl, apiKey, model: p.model }) };
    return this._cache.client;
  }
}

module.exports = { OwnerProviders, NOT_OWNER };
