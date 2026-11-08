'use strict';

// Минимальный клиент Telegram Bot API без внешних зависимостей.
// Только то, что нужно боту: приём сообщений, текст, фото, видео, действие «печатает».
// Токен никогда не попадает в тексты ошибок и журнал.

const fs = require('fs');
const path = require('path');

const API = 'https://api.telegram.org';
const TEXT_LIMIT = 4000; // предел Telegram — 4096 символов, оставляем запас
const CAPTION_LIMIT = 1000;

function chunkText(text, limit = TEXT_LIMIT) {
  const out = [];
  let rest = String(text == null ? '' : text);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.trim()) out.push(rest);
  return out.length ? out : [''];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TelegramClient {
  constructor(token, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    if (!token) throw new Error('нужен токен бота');
    this.token = String(token);
    this.fetch = fetchImpl;
    this.log = log;
    this.lastMediaAt = 0;
    this.lastEditAt = 0;
  }

  url(method) {
    return `${API}/bot${this.token}/${method}`;
  }

  sanitize(text) {
    return String(text == null ? '' : text).split(this.token).join('<token>');
  }

  // Один вызов API. При 429 — ждём retry_after и повторяем один раз.
  async call(method, payload, { signal, retry = true } = {}) {
    let res;
    try {
      res = await this.fetch(this.url(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal,
      });
    } catch (err) {
      throw new Error(this.sanitize(err.message));
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`telegram ${method}: ответ не разобран (${res.status})`);
    }
    if (data && data.ok) return data.result;
    const code = data && data.error_code;
    const retryAfter = data && data.parameters && data.parameters.retry_after;
    if (retry && code === 429 && Number.isFinite(retryAfter)) {
      await sleep(Math.min(retryAfter, 30) * 1000 + 250);
      return this.call(method, payload, { signal, retry: false });
    }
    throw new Error(`telegram ${method}: ${this.sanitize(data && data.description) || res.status}`);
  }

  // Забрать новые сообщения. timeout — длинный опрос в секундах.
  async getUpdates(offset, timeoutSec = 25, signal) {
    return this.call('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'edited_message'],
    }, { signal });
  }

  // Отправка текста с делением на части. Возвращает последнее сообщение.
  async sendMessage(chatId, text, { replyTo, signal } = {}) {
    const parts = chunkText(text);
    let last = null;
    for (const part of parts) {
      const payload = { chat_id: chatId, text: part || '…', disable_web_page_preview: true };
      if (replyTo && last === null) payload.reply_to_message_id = replyTo;
      last = await this.call('sendMessage', payload, { signal });
    }
    return last;
  }

  async sendChatAction(chatId, action = 'typing', signal) {
    return this.call('sendChatAction', { chat_id: chatId, action }, { signal });
  }

  // Правка уже отправленного текста (живой ответ, пока агент работает).
  // «message is not modified» — не ошибка: текст уже такой же.
  async editText(chatId, messageId, text, { signal } = {}) {
    const body = String(text == null ? '' : text).slice(0, TEXT_LIMIT) || '…';
    try {
      return await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: body,
        disable_web_page_preview: true,
      }, { signal });
    } catch (err) {
      if (/message is not modified/i.test(String(err && err.message))) return null;
      throw err;
    }
  }

  // Отправка формы в API с повтором при 429.
  async _post(method, form, { retry = true } = {}) {
    let res;
    try {
      res = await this.fetch(this.url(method), { method: 'POST', body: form });
    } catch (err) {
      throw new Error(this.sanitize(err.message));
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`telegram ${method}: ответ не разобран (${res.status})`);
    }
    if (data && data.ok) return data.result;
    const code = data && data.error_code;
    const retryAfter = data && data.parameters && data.parameters.retry_after;
    if (retry && code === 429 && Number.isFinite(retryAfter)) {
      await sleep(Math.min(retryAfter, 30) * 1000 + 250);
      return this._post(method, form, { retry: false });
    }
    throw new Error(`telegram ${method}: ${this.sanitize(data && data.description) || res.status}`);
  }

  // Отправка файла (фото/видео/документ) из буфера или пути. Медиа не чаще раза в секунду.
  async sendFile(method, chatId, source, { caption = '', fileName = '', signal } = {}) {
    const field = method === 'sendVideo' ? 'video' : method === 'sendDocument' ? 'document' : 'photo';
    let buf;
    let name;
    if (Buffer.isBuffer(source)) {
      buf = source;
      name = fileName || `${field}.bin`;
    } else {
      buf = fs.readFileSync(String(source));
      name = fileName || path.basename(String(source));
    }
    // Telegram: не больше ~1 сообщения с медиа в секунду в один чат.
    const wait = this.lastMediaAt + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastMediaAt = Date.now();
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', String(caption).slice(0, CAPTION_LIMIT));
    form.set(field, new Blob([buf]), name);
    return this._post(method, form);
  }

  sendPhoto(chatId, source, opts = {}) {
    return this.sendFile('sendPhoto', chatId, source, opts);
  }

  sendVideo(chatId, source, opts = {}) {
    return this.sendFile('sendVideo', chatId, source, opts);
  }

  sendDocument(chatId, source, opts = {}) {
    return this.sendFile('sendDocument', chatId, source, opts);
  }

  // Живая картинка: одно сообщение, которое обновляется на месте (без потока новых сообщений).
  // Отправляет кадр и возвращает id сообщения.
  async sendFrame(chatId, buffer, { caption = '', fileName = 'frame.jpg' } = {}) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', String(caption).slice(0, CAPTION_LIMIT));
    form.set('photo', new Blob([buffer]), fileName);
    const result = await this._post('sendPhoto', form);
    return result && result.message_id;
  }

  // Обновить кадр в том же сообщении. Между правками держим паузу: Telegram не любит частые правки.
  async editFrame(chatId, messageId, buffer, { caption = '', fileName = 'frame.jpg' } = {}) {
    const wait = this.lastEditAt + 1200 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastEditAt = Date.now();
    const media = { type: 'photo', media: 'attach://photo' };
    if (caption) media.caption = String(caption).slice(0, CAPTION_LIMIT);
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('message_id', String(messageId));
    form.set('media', JSON.stringify(media));
    form.set('photo', new Blob([buffer]), fileName);
    return this._post('editMessageMedia', form);
  }
}

module.exports = { TelegramClient, chunkText, sleep, TEXT_LIMIT };
