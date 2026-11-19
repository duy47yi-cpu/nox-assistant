'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeTarget } = require('../tools/workspace');

const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LIMIT = 8 * 1024 * 1024; // JSON с фото до 5 МБ в base64.

async function inboxJson(response) {
  if (!response.ok || !response.body) throw new Error('учебный приёмник недоступен');
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > LIMIT) throw new Error('ответ учебного приёмника слишком большой');
    parts.push(Buffer.from(part));
  }
  return JSON.parse(Buffer.concat(parts));
}

function createStudyInboxClient({ url, key, index, importPhoto, fetchImpl = globalThis.fetch, log = () => {} }) {
  const base = new URL(url);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) ||
      base.username || base.password || base.search || base.hash || typeof key !== 'string' || key.length < 32) {
    throw new Error('учебный приёмник требует HTTPS и отдельный ключ');
  }
  const route = base.pathname.replace(/\/$/, '') + '/v1/study-inbox';
  const controller = new AbortController();
  let timer;
  let running = false;
  const headers = { Authorization: `Bearer ${key}` };

  async function request(suffix, method) {
    const target = new URL(route + suffix, base);
    return inboxJson(await fetchImpl(target, {
      method, headers, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    }));
  }

  async function tick() {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      for (let count = 0; count < 4; count += 1) {
        const { item } = await request('', 'GET');
        if (!item) break;
        if (!ID.test(item.id || '') || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000) {
          throw new Error('учебная запись повреждена');
        }
        if (item.photo !== undefined) {
          if (typeof item.photo !== 'string' || !item.photo) throw new Error('учебное фото повреждено');
          const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-study-inbox-'));
          const file = path.join(folder, 'photo');
          fs.writeFileSync(file, Buffer.from(item.photo, 'base64'), { flag: 'wx' });
          try {
            const result = await importPhoto(item.text, { kind: 'photo', files: [{ file }], studyInboxId: item.id });
            if (result?.deferred) break;
            if (!result?.imported) throw new Error('не подтверждён импорт учебного фото');
          } finally {
            fs.rmSync(file, { force: true });
            fs.rmdirSync(folder);
          }
        } else {
          const note = writeTarget(index, `inbox/Учебная заметка ${item.id}.md`, ['.md']);
          try { fs.writeFileSync(note, item.text, { encoding: 'utf8', flag: 'wx' }); }
          catch (err) {
            if (err.code !== 'EEXIST' || !fs.lstatSync(note).isFile() || fs.readFileSync(note, 'utf8') !== item.text) throw err;
          }
        }
        const ack = await request(`/ack?id=${item.id}`, 'POST');
        if (ack.ok !== true) throw new Error('снятие записи с очереди не подтверждено');
      }
    } catch {
      if (!controller.signal.aborted) log('Учебный приёмник пока не синхронизирован, повторю позже.');
    } finally { running = false; }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(tick, 30000);
      timer.unref();
      void tick();
    },
    stop() { clearInterval(timer); controller.abort(); },
  };
}

module.exports = { createStudyInboxClient };
