'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');

const ROUTE = '/v1/study-inbox';
const PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_ITEMS = 20;
const ID = /^[0-9a-f-]{36}$/;
const digest = (value) => createHash('sha256').update(value).digest();

async function photoBytes(response) {
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > PHOTO_BYTES) return null;
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

function createStudyInbox({ file, key, token, owner, fetchImpl = globalThis.fetch }) {
  if (!file || typeof key !== 'string' || key.length < 32 || !token || !/^\d+$/.test(owner)) {
    throw new Error('для учебного приёмника нужны файл очереди, отдельный бот, чат владельца и ключ длиной от 32 символов');
  }
  const expected = digest(key);
  const controller = new AbortController();
  const load = () => {
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error('неверный файл очереди');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(value.items) || !Number.isInteger(value.offset)) throw new Error('очередь повреждена');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { offset: 0, items: [] };
      throw error;
    }
  };
  const save = (state) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally { fs.rmSync(tmp, { force: true }); }
  };
  const telegram = async (method, args) => {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(32000)]),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error('Telegram не ответил на запрос учебного приёмника');
    return payload.result;
  };
  const download = async (photo) => {
    if (photo.file_size > PHOTO_BYTES) return null;
    const info = await telegram('getFile', { file_id: photo.file_id });
    if (!info || info.file_size > PHOTO_BYTES || !/^[\w/-]+\.(?:jpe?g|png)$/i.test(info.file_path || '') ||
        info.file_path.split('/').includes('..')) return null;
    const response = await fetchImpl(`https://api.telegram.org/file/bot${token}/${info.file_path}`, {
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok || !response.body) throw new Error('фото из Telegram временно недоступно');
    const bytes = await photoBytes(response);
    if (!bytes) return null;
    const valid = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return valid ? bytes.toString('base64') : null;
  };

  async function pollOnce() {
    const updates = await telegram('getUpdates', { offset: load().offset, timeout: 20, allowed_updates: ['message'] });
    for (const update of Array.isArray(updates) ? updates : []) {
      if (!Number.isInteger(update.update_id) || update.update_id < load().offset) continue;
      const msg = update.message;
      const authorised = msg?.chat?.type === 'private' && String(msg.chat.id) === owner && String(msg.from?.id) === owner;
      let reply = '';
      let item;
      if (authorised) {
        const text = String(msg.caption || msg.text || '').trim();
        const photo = Array.isArray(msg.photo) ? msg.photo.at(-1) : null;
        const note = /^на уч[её]бу\s*:\s*(\S[\s\S]*)$/iu.exec(text)?.[1];
        const studyPhoto = photo && (/^на уч[её]бу[.!?]*$/iu.test(text) || note);
        if ((!studyPhoto && !note) || text.length > 2000 || (studyPhoto && (note || '').length > 160)) {
          reply = 'Пришлите текст «На учёбу: …» или фото с такой подписью.';
        } else if (load().items.length >= MAX_ITEMS) {
          reply = 'Очередь заполнена. Откройте Nox на ПК, чтобы он забрал материалы.';
        } else {
          const image = studyPhoto ? await download(photo) : null;
          if (studyPhoto && !image) reply = 'Принимаются фото JPG и PNG до 5 МБ.';
          else {
            item = { id: randomUUID(), text: studyPhoto ? text : note, ...(image ? { photo: image } : {}) };
            reply = 'Сохранено в очереди. Nox заберёт материал после запуска на ПК.';
          }
        }
      }
      // Между загрузкой фото и записью ПК мог забрать старую запись. Читаем очередь заново.
      const state = load();
      save({ offset: update.update_id + 1, items: item ? [...state.items, item] : state.items });
      if (reply) await telegram('sendMessage', { chat_id: owner, text: reply }).catch(() => {});
    }
  }

  async function start() {
    while (!controller.signal.aborted) {
      try { await pollOnce(); }
      catch {
        if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5000).unref());
      }
    }
  }

  function handle(req, res, send) {
    const given = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1] || '';
    if (!timingSafeEqual(digest(given), expected)) return send(res, 401, { error: 'unauthorized' });
    try {
      const url = new URL(req.url, 'http://localhost');
      const state = load();
      const headers = { 'Cache-Control': 'no-store' };
      if (req.method === 'GET' && url.pathname === ROUTE) return send(res, 200, { item: state.items[0] || null }, headers);
      const id = url.searchParams.get('id');
      if (req.method === 'POST' && url.pathname === ROUTE + '/ack' && ID.test(id || '')) {
        const items = state.items.filter((item) => item.id !== id);
        if (items.length !== state.items.length) save({ ...state, items });
        return send(res, 200, { ok: true }, headers);
      }
      return send(res, 404, { error: 'not_found' }, headers);
    } catch {
      return send(res, 503, { error: 'inbox_unavailable' });
    }
  }

  return {
    matches: (req) => [ROUTE, ROUTE + '/ack'].includes(String(req.url).split('?')[0]),
    handle, start, pollOnce, stop: () => controller.abort(),
  };
}

module.exports = { createStudyInbox };
