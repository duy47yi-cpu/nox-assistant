'use strict';

// Аккаунт Nox в приложении: вход на сервере и пропуск на этом компьютере. Пароль не хранится нигде, пропуск — зашифрованным.
const fs = require('fs');
const path = require('path');

class AccountSession {
  // protect = {encrypt(text) → Buffer, decrypt(Buffer) → text}: шифрование Windows (safeStorage). Без него пропуск живёт только в памяти.
  // timeoutMs — сколько ждать ответа сервера: зависший запрос не должен держать экран входа.
  constructor({ file, serverUrl, protect = null, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    this.file = file;
    this.serverUrl = String(serverUrl).replace(/\/+$/, '');
    this.protect = protect;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.token = '';
    this.onToken = () => {};
  }

  // Шифрование доступно только после готовности приложения.
  load(protect = this.protect) {
    this.protect = protect;
    try {
      this.token = this.protect.decrypt(fs.readFileSync(this.file));
    } catch {
      this.token = ''; // нет файла, другой пользователь Windows или мусор: просто войти заново
    }
    this.onToken(this.token);
    return Boolean(this.token);
  }

  _store(token) {
    this.token = token;
    this.onToken(token);
    if (!this.protect) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (token) fs.writeFileSync(this.file, this.protect.encrypt(token));
    else fs.rmSync(this.file, { force: true });
  }

  async _call(method, url, body) {
    let res;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      res = await this.fetchImpl(this.serverUrl + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch {
      return { ok: false, offline: true, error: 'Нет связи с сервером Nox' };
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try {
      json = await res.json();
    } catch { /* ответ не JSON: сообщение ниже */ }
    if (!res.ok) return { ok: false, status: res.status, code: json && json.error && json.error.code, error: (json && json.error && json.error.message) || `Сервер ответил ошибкой ${res.status}` };
    return { ok: true, data: json };
  }

  async _enter(url, email, password) {
    const r = await this._call('POST', url, { email, password });
    if (!r.ok) return r;
    this._store(r.data.token);
    return { ok: true, account: r.data.account };
  }

  register(email, password) {
    return this._enter('/v1/auth/register', email, password);
  }

  login(email, password) {
    return this._enter('/v1/auth/login', email, password);
  }

  async logout() {
    if (this.token) await this._call('POST', '/v1/auth/logout');
    this._store('');
    return { ok: true };
  }

  // Что сейчас показывать: вошёл ли, тариф, расход окон. Отозванный пропуск снимаем, сбой связи — нет.
  async state() {
    if (!this.token) return { enabled: true, signedIn: false };
    const r = await this._call('GET', '/v1/me');
    if (r.ok) return { enabled: true, signedIn: true, account: r.data };
    if (r.status === 401) {
      this._store('');
      return { enabled: true, signedIn: false };
    }
    return { enabled: true, signedIn: true, offline: true, error: r.error };
  }
}

module.exports = { AccountSession };
