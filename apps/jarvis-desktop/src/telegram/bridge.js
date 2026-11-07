'use strict';

// Удалённое управление через Telegram-бота владельца: приём сообщений из одного чата и ответы в него.
// Бот создаёт сам владелец, токен и номер его чата лежат в .env (NOX_TELEGRAM_TOKEN, NOX_TELEGRAM_OWNER_CHAT).
// Чужие чаты игнорируются молча. Сам по себе мост ничего не выполняет: команды передаются в handle(text, media).
//
// Что умеет:
// - текст: как раньше (handle получает текст);
// - голосовое/аудио: скачивает файл и, если передан transcribe, отдаёт расшифровку; без неё — честно говорит, что
//   расшифровки нет (в Windows без языкового пакета распознавание речи недоступно);
// - фото/видео/документ: скачивает во временную папку (mediaDir) и передаёт путь в media.files;
// - ответы как в мессенджере: «печатает», длинный ответ делится на несколько сообщений (предел Telegram 4096);
// - отправка фото и видео владельцу по файлу (sendPhoto/sendVideo), если файл уже есть на диске.
// Токен никогда не пишется в журнал и в текст ошибок. Адресат — только владелец.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { mayWriteTo } = require('./policy');

const API = 'https://api.telegram.org';
const MAX_REPLY = 4000; // предел Telegram — 4096 символов, оставляем запас
const POLL_TIMEOUT_S = 25;
const MEDIA_LIMIT = 20 * 1024 * 1024; // больше не скачиваем: бот не отдаёт файлы крупнее 20 МБ
const PHOTO_CAPTION = 1000;

function sanitize(text, token) {
  return String(text || '').split(token).join('<token>');
}

const KINDS = ['voice', 'audio', 'photo', 'video', 'video_note', 'document', 'sticker', 'location'];

// Какие вложения есть в сообщении. Порядок важен: у фото может быть ещё подпись, у файла — тоже.
function mediaOf(msg) {
  if (!msg || typeof msg !== 'object') return null;
  for (const kind of KINDS) if (msg[kind]) return { kind, raw: msg[kind] };
  return null;
}

function textOf(msg) {
  if (typeof msg.text === 'string' && msg.text.trim()) return msg.text.trim();
  if (typeof msg.caption === 'string' && msg.caption.trim()) return msg.caption.trim();
  return '';
}

function humanKind(kind) {
  return { voice: 'голосовое', audio: 'аудио', photo: 'фото', video: 'видео', video_note: 'видеозаметку', document: 'файл', sticker: 'стикер', location: 'геометку' }[kind] || 'вложение';
}

function chunkText(text, limit = MAX_REPLY) {
  const out = [];
  let rest = String(text || '');
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

class TelegramBridge {
  constructor({
    token, ownerChatId, handle, fetchImpl = globalThis.fetch, log = () => {}, retryMs = 5000,
    mediaDir = path.join(os.tmpdir(), 'nox-telegram-media'), transcribe = null, typing = true,
  } = {}) {
    if (!token) throw new Error('нужен токен бота');
    if (!ownerChatId) throw new Error('нужен номер чата владельца');
    if (typeof handle !== 'function') throw new Error('нужен обработчик сообщений');
    this.token = String(token);
    this.ownerChatId = String(ownerChatId);
    this.handle = handle;
    this.fetch = fetchImpl;
    this.log = log;
    this.retryMs = retryMs;
    this.mediaDir = mediaDir ? String(mediaDir) : null;
    this.transcribe = typeof transcribe === 'function' ? transcribe : null;
    this.typing = typing !== false;
    this.offset = 0;
    this.running = false;
    this.controller = null;
  }

  // Адрес метода API. Адрес содержит токен: его нельзя печатать.
  url(method, query = '') {
    return `${API}/bot${this.token}/${method}${query}`;
  }

  // Адрес файла тоже содержит токен — наружу не печатаем.
  fileUrl(filePath) {
    return `${API}/file/bot${this.token}/${String(filePath).replace(/^\/+/, '')}`;
  }

  async call(method, { body = null, query = '', signal } = {}) {
    const init = { method: body ? 'POST' : 'GET', signal };
    if (body) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await this.fetch(this.url(method, query), init);
    } catch (err) {
      throw new Error(sanitize(err.message, this.token));
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`telegram ${method}: ответ не разобран (${res.status})`);
    }
    if (!data || !data.ok) throw new Error(`telegram ${method}: ${sanitize(data && data.description, this.token) || res.status}`);
    return data.result;
  }

  // Скачивание вложения по file_id во временную папку. Возвращает {file, size, mime} или null, если нельзя.
  async download(fileId, fallbackExt = '.bin', signal) {
    if (!this.mediaDir) return null;
    const info = await this.call('getFile', { body: { file_id: String(fileId) }, signal });
    if (!info || typeof info.file_path !== 'string') return null;
    if (Number.isFinite(info.file_size) && info.file_size > MEDIA_LIMIT) {
      return { tooBig: true, size: info.file_size };
    }
    let res;
    try {
      res = await this.fetch(this.fileUrl(info.file_path), { signal });
    } catch (err) {
      throw new Error(sanitize(err.message, this.token));
    }
    if (!res || res.ok === false) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MEDIA_LIMIT) return { tooBig: true, size: buf.length };
    const ext = path.extname(String(info.file_path)).toLowerCase() || fallbackExt;
    fs.mkdirSync(this.mediaDir, { recursive: true });
    const file = path.join(this.mediaDir, `${Date.now()}-${String(fileId).slice(-8)}${ext}`);
    fs.writeFileSync(file, buf);
    return { file, size: buf.length, mime: String(info.mime_type || (res.headers && res.headers.get && res.headers.get('content-type')) || '') };
  }

  // Вложение из сообщения -> media для handle. Ошибка скачивания не роняет мост: она уходит в media.notes.
  async attachment(msg, signal) {
    const found = mediaOf(msg);
    if (!found) return null;
    const { kind, raw } = found;
    const media = { kind, files: [], notes: [], transcript: null, caption: typeof msg.caption === 'string' ? msg.caption : '' };
    const add = (extra) => Object.assign(media.files[media.files.length - 1], extra);
    try {
      if (kind === 'voice' || kind === 'audio') {
        const fileId = raw.file_id;
        const got = await this.download(fileId, kind === 'voice' ? '.ogg' : '.mp3', signal);
        if (got && got.tooBig) media.notes.push(`файл больше ${Math.round(MEDIA_LIMIT / 1048576)} МБ — не скачан`);
        else if (got) {
          media.files.push({ kind, file: got.file, size: got.size });
          add({ duration: raw.duration || 0 });
          if (this.transcribe) {
            try {
              const text = await this.transcribe(got.file, { kind, duration: raw.duration || 0 });
              if (typeof text === 'string' && text.trim()) media.transcript = text.trim();
            } catch (err) {
              media.notes.push(`расшифровка не удалась: ${sanitize(err.message, this.token)}`);
            }
          }
        } else media.notes.push('файл не скачан');
      } else if (kind === 'photo') {
        const sizes = Array.isArray(raw) ? raw : [];
        const big = sizes[sizes.length - 1];
        if (!big) return media;
        const got = await this.download(big.file_id, '.jpg', signal);
        if (got && got.tooBig) media.notes.push(`файл больше ${Math.round(MEDIA_LIMIT / 1048576)} МБ — не скачан`);
        else if (got) media.files.push({ kind, file: got.file, size: got.size, width: big.width, height: big.height });
        else media.notes.push('файл не скачан');
      } else if (kind === 'video' || kind === 'video_note') {
        const got = await this.download(raw.file_id, '.mp4', signal);
        if (got && got.tooBig) media.notes.push(`файл больше ${Math.round(MEDIA_LIMIT / 1048576)} МБ — не скачан`);
        else if (got) media.files.push({ kind: 'video', file: got.file, size: got.size, duration: raw.duration || 0, width: raw.width || 0, height: raw.height || 0 });
        else media.notes.push('файл не скачан');
      } else if (kind === 'document') {
        const got = await this.download(raw.file_id, path.extname(String(raw.file_name || '')) || '.bin', signal);
        if (got && got.tooBig) media.notes.push(`файл больше ${Math.round(MEDIA_LIMIT / 1048576)} МБ — не скачан`);
        else if (got) media.files.push({ kind, file: got.file, size: got.size, name: raw.file_name || path.basename(got.file) });
        else media.notes.push('файл не скачан');
      } else if (kind === 'sticker') {
        media.kind = 'sticker';
        media.notes.push(raw.emoji ? `стикер ${raw.emoji}` : 'стикер');
      } else if (kind === 'location') {
        media.kind = 'location';
        media.files.push({ kind: 'location', latitude: raw.latitude, longitude: raw.longitude });
      }
    } catch (err) {
      media.notes.push(`скачивание не удалось: ${sanitize(err.message, this.token)}`);
    }
    return media;
  }

  // Что сказать владельцу, если вложение не удалось понять (без выдумок).
  mediaFallback(media) {
    if (!media) return '';
    const kind = humanKind(media.kind);
    if (media.kind === 'voice' || media.kind === 'audio') {
      return `Получил ${kind}, но расшифровать не получилось: на этом компьютере не установлено распознавание речи. Напишите текстом — сделаю.`;
    }
    const saved = media.files.find((f) => f.file);
    const word = saved ? `Файл сохранён: ${path.basename(saved.file)}.` : '';
    return `Получил ${kind}. ${word} Что с этим сделать?`.replace(/\s+/g, ' ').trim();
  }

  // «Печатает…» — необязательная мелочь, её сбой не мешает ответу.
  async typingOn(signal) {
    if (!this.typing) return;
    try {
      await this.call('sendChatAction', { body: { chat_id: this.ownerChatId, action: 'typing' }, signal });
    } catch {
      // сеть или лимит Telegram: просто без индикатора
    }
  }

  // Одна итерация: забрать новые сообщения, обработать сообщение владельца, ответить. Возвращает число обработанных.
  async pollOnce(signal) {
    const updates = await this.call('getUpdates', {
      query: `?timeout=${POLL_TIMEOUT_S}&offset=${this.offset}&allowed_updates=${encodeURIComponent('["message"]')}`,
      signal,
    });
    let handled = 0;
    for (const update of Array.isArray(updates) ? updates : []) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      const msg = update.message;
      if (!msg) continue;
      if (!msg.chat || String(msg.chat.id) !== this.ownerChatId) {
        this.log('чужой чат проигнорирован');
        continue;
      }
      const media = await this.attachment(msg, signal);
      const text = media ? (media.transcript || textOf(msg)) : textOf(msg);
      if (!text && !media) continue; // текст не нужен: пустое сообщение, эхо и прочее
      let reply;
      try {
        await this.typingOn(signal);
        reply = await this.handle(text, media);
      } catch (err) {
        reply = `Не получилось: ${sanitize(err.message, this.token)}`;
      }
      // Мост не выдумывает ответ за модель: пустой ответ на вложение — честная фраза о том, что было принято.
      const outgoing = reply && String(reply).trim() ? String(reply) : (media ? this.mediaFallback(media) : 'Готово.');
      await this.send(outgoing, signal);
      handled += 1;
    }
    return handled;
  }

  // Отправка текста. Длинный текст делится на несколько сообщений, чтобы ничего не терялось.
  // Адресат — только владелец: чужой chat id отклоняется до запроса к API.
  async send(text, signal, to = this.ownerChatId) {
    if (!mayWriteTo(to, this.ownerChatId)) throw new Error('адресат не владелец: сообщение не отправлено');
    const clean = String(text || '').trim();
    const parts = chunkText(clean || 'Готово.');
    for (const part of parts) await this.call('sendMessage', { body: { chat_id: this.ownerChatId, text: part }, signal });
  }

  // Отправка файла: фото и видео. Файл читается с диска, поэтому только после проверки, что это правда файл.
  async sendMedia(kind, file, { caption = '', signal } = {}) {
    const method = kind === 'video' ? 'sendVideo' : 'sendPhoto';
    const field = kind === 'video' ? 'video' : 'photo';
    if (typeof file !== 'string' || !file.trim()) throw new Error(`нет файла для отправки (${kind})`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`файла нет: ${path.basename(String(file))}`);
    }
    if (!stat.isFile()) throw new Error('это не файл');
    if (stat.size > MEDIA_LIMIT) throw new Error(`файл больше ${Math.round(MEDIA_LIMIT / 1048576)} МБ`);
    const bytes = fs.readFileSync(file);
    const form = new FormData();
    form.set('chat_id', this.ownerChatId);
    if (caption) form.set('caption', String(caption).slice(0, PHOTO_CAPTION));
    form.set(field, new Blob([bytes]), path.basename(String(file)));
    let res;
    try {
      res = await this.fetch(this.url(method), { method: 'POST', body: form, signal });
    } catch (err) {
      throw new Error(sanitize(err.message, this.token));
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`telegram ${method}: ответ не разобран (${res.status})`);
    }
    if (!data || !data.ok) throw new Error(`telegram ${method}: ${sanitize(data && data.description, this.token) || res.status}`);
    return data.result;
  }

  sendPhoto(file, opts = {}) {
    return this.sendMedia('photo', file, opts);
  }

  sendVideo(file, opts = {}) {
    return this.sendMedia('video', file, opts);
  }

  // Сообщение от Джарвиса владельцу по собственной инициативе (не ответ на входящее).
  notify(text) {
    return this.send(text, undefined, this.ownerChatId);
  }

  // Цикл опроса. Ошибка сети не останавливает мост: через retryMs пробуем снова.
  async start() {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    while (this.running) {
      try {
        await this.pollOnce(this.controller.signal);
      } catch (err) {
        if (!this.running) break;
        this.log(`telegram: ${sanitize(err.message, this.token)}`);
        await new Promise((resolve) => setTimeout(resolve, this.retryMs));
      }
    }
  }

  stop() {
    this.running = false;
    if (this.controller) this.controller.abort();
  }
}

module.exports = { TelegramBridge, MAX_REPLY, MEDIA_LIMIT, sanitize, chunkText, mediaOf, humanKind };
