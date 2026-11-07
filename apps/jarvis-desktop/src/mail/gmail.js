'use strict';

// Почта Gmail: вход Google по OAuth с PKCE, доступ хранится зашифрованным так же, как пропуск аккаунта
// (protect = safeStorage Windows), отправка через Gmail API. Без учётных данных Google всё отвечает «почта не подключена».
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
// Значение по умолчанию для совместимости; приложение использует свободный loopback-порт.
const REDIRECT = 'http://127.0.0.1:53682/oauth';
const NOT_CONNECTED = 'почта не подключена';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Письмо в формате RFC 2822. Тема и текст в base64: перевод строки в них не станет новым заголовком.
function mime({ to, subject, text }) {
  return [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
}

class GmailAccount {
  constructor({ file, clientId = '', clientSecret = '', protect = null, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { file, clientId, clientSecret, protect, fetchImpl, now });
    this.token = null;
    this._pending = null;
  }

  // Шифрование доступно только после готовности приложения.
  load(protect = this.protect) {
    this.protect = protect;
    try {
      this.token = JSON.parse(this.protect.decrypt(fs.readFileSync(this.file)));
    } catch {
      this.token = null; // нет файла, другой пользователь Windows или мусор: войти заново
    }
  }

  _save(token) {
    this.token = token;
    if (!this.protect) return; // без шифрования доступ живёт только в памяти
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (token) fs.writeFileSync(this.file, this.protect.encrypt(JSON.stringify(token)));
    else fs.rmSync(this.file, { force: true });
  }

  hasCredentials() {
    return Boolean(this.clientId);
  }

  connected() {
    return this.hasCredentials() && Boolean(this.token && this.token.refresh_token);
  }

  canRead() {
    return this.connected() && String(this.token.scope || '').split(/\s+/).includes(READ_SCOPE);
  }

  state() {
    return { credentials: this.hasCredentials(), connected: this.connected() };
  }

  _notConnected() {
    return this.hasCredentials() ? `${NOT_CONNECTED}: владелец ещё не вошёл в Gmail` : `${NOT_CONNECTED}: нет учётных данных Google`;
  }

  // Начало входа: адрес страницы Google. Секрет PKCE и state остаются здесь до возврата.
  beginLogin({ read = false, redirect = REDIRECT } = {}) {
    if (!this.hasCredentials()) return { ok: false, error: this._notConnected() };
    let callback;
    try { callback = new URL(redirect); } catch { return { ok: false, error: 'неверный адрес возврата' }; }
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port || callback.pathname !== '/oauth' || callback.search || callback.hash || callback.username || callback.password) return { ok: false, error: 'неверный адрес возврата' };
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(16));
    const scope = read === true ? `${SCOPE} ${READ_SCOPE}` : SCOPE;
    this._pending = { verifier, state, scope, redirect: callback.href };
    const query = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: callback.href,
      response_type: 'code',
      scope,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return { ok: true, url: `${AUTH_URL}?${query}`, redirect: callback.href };
  }

  // Адрес, на который Google вернул окно входа: код меняем на доступ.
  async finishLogin(returnUrl) {
    const pending = this._pending;
    let u;
    try {
      u = new URL(String(returnUrl));
    } catch {
      return { ok: false, error: 'вход прерван' };
    }
    if (!pending || `${u.origin}${u.pathname}` !== pending.redirect || u.searchParams.get('state') !== pending.state) return { ok: false, error: 'вход прерван: ответ не от этого входа' };
    this._pending = null;
    if (u.searchParams.get('error')) return { ok: false, error: 'вход отменён' };
    const code = u.searchParams.get('code');
    if (!code) return { ok: false, error: 'вход прерван: Google не вернул код' };
    const r = await this._token({ grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: pending.redirect });
    if (!r.ok) return r;
    if (!r.data.refresh_token) return { ok: false, error: 'Google не выдал постоянный доступ' };
    this._save({ refresh_token: r.data.refresh_token, access_token: r.data.access_token, scope: typeof r.data.scope === 'string' ? r.data.scope : pending.scope, expires_at: this.now() + Number(r.data.expires_in || 0) * 1000 });
    return { ok: true };
  }

  logout() {
    this._save(null);
    return { ok: true };
  }

  cancelLogin() { this._pending = null; }

  async _token(params) {
    const body = new URLSearchParams({ client_id: this.clientId, ...(this.clientSecret ? { client_secret: this.clientSecret } : {}), ...params });
    let res;
    try {
      res = await this.fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20000) });
    } catch {
      return { ok: false, error: 'нет связи с Google' };
    }
    let json = null;
    try {
      json = await res.json();
    } catch { /* не JSON: сообщение ниже */ }
    if (!res.ok) return { ok: false, status: res.status, code: json && json.error, error: `Google отказал во входе (${res.status})` };
    return { ok: true, data: json || {} };
  }

  // Действующий доступ: старый, пока не истёк, иначе обновлённый.
  async accessToken() {
    if (!this.connected()) return { ok: false, error: this._notConnected() };
    if (this.token.access_token && Number(this.token.expires_at) - 60000 > this.now()) return { ok: true, token: this.token.access_token };
    const r = await this._token({ grant_type: 'refresh_token', refresh_token: this.token.refresh_token });
    if (!r.ok) {
      // Отозванный доступ снимаем, чтобы владелец вошёл заново. Сбой связи доступ не снимает.
      if (r.code === 'invalid_grant') {
        this._save(null);
        return { ok: false, error: `${NOT_CONNECTED}: доступ отозван, нужно войти заново` };
      }
      return r;
    }
    this._save({
      ...this.token,
      ...(r.data.refresh_token ? { refresh_token: r.data.refresh_token } : {}),
      ...(typeof r.data.scope === 'string' ? { scope: r.data.scope } : {}),
      access_token: r.data.access_token,
      expires_at: this.now() + Number(r.data.expires_in || 0) * 1000,
    });
    return { ok: true, token: r.data.access_token };
  }

  // Заголовки и короткие фрагменты непрочитанных входящих; без загрузки вложений.
  async listUnread(limit = 10) {
    if (!this.connected()) return { ok: false, error: this._notConnected() };
    if (!this.canRead()) return { ok: false, error: 'нужно заново подключить Gmail с разрешением на чтение' };
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return { ok: false, error: 'количество писем: от 1 до 20' };
    const auth = await this.accessToken();
    if (!auth.ok) return auth;
    if (!this.canRead()) return { ok: false, error: 'нужно заново подключить Gmail с разрешением на чтение' };
    const headers = { Authorization: `Bearer ${auth.token}` };
    const signal = AbortSignal.timeout(30000);
    const query = new URLSearchParams({ maxResults: String(limit), q: 'is:unread in:inbox', fields: 'messages/id,nextPageToken,resultSizeEstimate' });
    let list;
    try {
      const res = await this.fetchImpl(`${MESSAGES_URL}?${query}`, { headers, signal });
      if (!res.ok) return { ok: false, error: `Gmail не вернул список писем (${res.status})` };
      list = await res.json();
    } catch { return { ok: false, error: 'не удалось получить список писем Gmail' }; }
    const items = [];
    let failed = 0;
    for (const entry of (Array.isArray(list.messages) ? list.messages.slice(0, limit) : [])) {
      if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id)) { failed++; continue; }
      try {
        const params = new URLSearchParams({ format: 'full', fields: 'id,snippet,internalDate,labelIds,payload/headers' });
        const res = await this.fetchImpl(`${MESSAGES_URL}/${encodeURIComponent(entry.id)}?${params}`, { headers, signal });
        if (!res.ok) { failed++; continue; }
        const message = await res.json();
        const hs = Array.isArray(message.payload && message.payload.headers) ? message.payload.headers : [];
        const header = (name) => String((hs.find((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === name) || {}).value || '').slice(0, 500);
        items.push({ id: entry.id, from: header('from'), subject: header('subject'), date: header('date'), snippet: String(message.snippet || '').slice(0, 1000) });
      } catch { failed++; }
    }
    return { ok: true, items, failed, hasMore: Boolean(list.nextPageToken) };
  }

  async send({ to, subject, text }) {
    const t = await this.accessToken();
    if (!t.ok) return t;
    let res;
    try {
      res = await this.fetchImpl(SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: b64url(Buffer.from(mime({ to, subject, text }), 'utf8')) }),
      });
    } catch {
      return { ok: false, error: 'нет связи с Gmail' };
    }
    let json = null;
    try {
      json = await res.json();
    } catch { /* не JSON */ }
    if (!res.ok) return { ok: false, error: `Gmail не принял письмо (${res.status})` };
    return { ok: true, id: (json && json.id) || '', threadId: (json && json.threadId) || '' };
  }
}

module.exports = { GmailAccount, mime, NOT_CONNECTED, REDIRECT, READ_SCOPE };
