'use strict';

// Мост Telegram: вложения (голосовое, фото, видео, файл) и отправка фото/видео владельцу.
// Сеть подменена: проверяем разбор сообщений, скачивание через getFile, расшифровку-подсказку,
// деление длинного ответа и многочастную отправку файла.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TelegramBridge, MAX_REPLY, MEDIA_LIMIT, chunkText } = require('../src/telegram/bridge');

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value, arrayBuffer: async () => Buffer.from('') };
}

function fakeTelegram({ updates = [], files = {}, fileSize = 2048 } = {}) {
  const sent = [];
  const calls = [];
  const urls = [];
  const feed = updates.slice();
  async function fetchImpl(url, init = {}) {
    const method = String(url).split('?')[0].split('/').pop();
    calls.push(method);
    urls.push(String(url));
    if (method === 'getUpdates') return jsonResponse({ ok: true, result: feed.shift() || [] });
    if (method === 'getFile') {
      const body = init.body ? JSON.parse(init.body) : {};
      return jsonResponse({ ok: true, result: { file_path: files[body.file_id] || 'voice/file.ogg', file_size: fileSize, mime_type: 'audio/ogg' } });
    }
    if (String(url).includes('/file/bot')) {
      return {
        ok: true, status: 200, headers: { get: () => 'audio/ogg' },
        arrayBuffer: async () => Buffer.from('голосовые-байты'),
      };
    }
    if (init.body instanceof FormData) {
      sent.push({ method, form: init.body });
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    }
    sent.push({ method, body: init.body ? JSON.parse(init.body) : null });
    return jsonResponse({ ok: true, result: { message_id: 1 } });
  }
  return { fetchImpl, sent, calls, urls };
}

function bridgeWith(fake, extra = {}) {
  return new TelegramBridge({
    token: '123:SECRET',
    ownerChatId: '555',
    fetchImpl: fake.fetchImpl,
    handle: async () => 'ок',
    typing: false,
    api: undefined,
    ...extra,
  });
}

function tempMedia(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'now-tg-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('голосовое: скачивается, передаётся расшифровка, файл лежит во временной папке', async (t) => {
  const mediaDir = tempMedia(t);
  const fake = fakeTelegram({
    updates: [[{ update_id: 5, message: { chat: { id: 555 }, voice: { file_id: 'v1', duration: 7 } } }]],
  });
  const seen = [];
  const bridge = bridgeWith(fake, {
    mediaDir,
    transcribe: async (file) => { seen.push(path.basename(file)); return 'включи музыку'; },
    handle: async (text, media) => { seen.push({ text, media }); return 'включаю'; },
  });
  await bridge.pollOnce();
  const call = seen.find((x) => typeof x === 'object');
  assert.equal(call.text, 'включи музыку');
  assert.equal(call.media.kind, 'voice');
  assert.equal(call.media.files.length, 1);
  assert.equal(call.media.files[0].duration, 7);
  assert.ok(fs.existsSync(call.media.files[0].file), 'файл скачан');
  assert.equal(fs.readFileSync(call.media.files[0].file, 'utf8'), 'голосовые-байты');
  assert.ok(fake.calls.includes('getFile'));
  assert.ok(fake.sent.some((m) => m.body && m.body.text === 'включаю'));
});

test('голосовое без расшифровки: честный ответ вместо выдумки', async (t) => {
  const fake = fakeTelegram({
    updates: [[{ update_id: 6, message: { chat: { id: 555 }, voice: { file_id: 'v2', duration: 3 } } }]],
  });
  const bridge = bridgeWith(fake, { mediaDir: tempMedia(t), handle: async () => '' });
  await bridge.pollOnce();
  const sent = fake.sent.filter((m) => m.body && typeof m.body.text === 'string').map((m) => m.body.text);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /распознавание речи/);
  assert.match(sent[0], /напишите текстом/i);
});

test('фото: подпись и размер передаются обработчику, файл сохраняется', async (t) => {
  const fake = fakeTelegram({
    updates: [[{
      update_id: 7,
      message: {
        chat: { id: 555 },
        caption: 'что на фото?',
        photo: [{ file_id: 's', width: 100, height: 50 }, { file_id: 'big', width: 1280, height: 720 }],
      },
    }]],
  });
  const seen = [];
  const bridge = bridgeWith(fake, { mediaDir: tempMedia(t), handle: async (text, media) => { seen.push({ text, media }); return 'смотрю'; } });
  await bridge.pollOnce();
  assert.equal(seen[0].text, 'что на фото?');
  assert.equal(seen[0].media.kind, 'photo');
  assert.equal(seen[0].media.files.length, 1);
  assert.equal(seen[0].media.files[0].width, 1280, 'берём самое большое фото');
  assert.ok(fs.existsSync(seen[0].media.files[0].file));
});

test('большой файл не скачивается и это сказано в замечаниях', async (t) => {
  const fake = fakeTelegram({
    files: { huge: 'video/big.mp4' },
    fileSize: MEDIA_LIMIT + 1,
    updates: [[{ update_id: 8, message: { chat: { id: 555 }, video: { file_id: 'huge', duration: 30 } } }]],
  });
  const seen = [];
  const bridge = bridgeWith(fake, { mediaDir: tempMedia(t), handle: async (text, media) => { seen.push(media); return 'принял'; } });
  await bridge.pollOnce();
  assert.equal(seen[0].files.length, 0);
  assert.match(seen[0].notes[0], /больше/);
  // Размер узнаём через getFile, но сам файл по адресу /file/bot не запрашиваем.
  assert.ok(fake.calls.includes('getFile'), 'размер берётся из ответа getFile');
  assert.ok(!fake.urls.some((url) => url.includes('/file/bot')), 'большой файл не скачивается');
});

test('отправка фото: многочастная форма с chat_id и файлом', async (t) => {
  const dir = tempMedia(t);
  const file = path.join(dir, 'photo.jpg');
  fs.writeFileSync(file, Buffer.from('jpeg-байты'));
  const fake = fakeTelegram();
  const bridge = bridgeWith(fake);
  await bridge.sendPhoto(file, { caption: 'отчёт' });
  const sent = fake.sent.find((m) => m.method === 'sendPhoto');
  assert.ok(sent, 'вызван sendPhoto');
  assert.ok(sent.form instanceof FormData);
  assert.equal(sent.form.get('chat_id'), '555');
  assert.equal(sent.form.get('caption'), 'отчёт');
  const blob = sent.form.get('photo');
  assert.ok(blob instanceof Blob);
  assert.equal(blob.size, Buffer.byteLength('jpeg-байты'));
});

test('отправка видео: sendVideo, чужой путь и не файл отклоняются', async (t) => {
  const dir = tempMedia(t);
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, Buffer.from('mp4-байты'));
  const fake = fakeTelegram();
  const bridge = bridgeWith(fake);
  await bridge.sendVideo(file, { caption: '' });
  assert.ok(fake.sent.some((m) => m.method === 'sendVideo'));
  await assert.rejects(() => bridge.sendPhoto(path.join(dir, 'нет-такого.jpg')), /файла нет/);
  await assert.rejects(() => bridge.sendPhoto(dir), /не файл/);
});

test('длинный ответ делится на части, ничего не теряется', async () => {
  const text = 'слово '.repeat(2000).trim();
  const parts = chunkText(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= MAX_REPLY));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('чужой чат с вложением игнорируется молча и не скачивается', async (t) => {
  const fake = fakeTelegram({
    updates: [[{ update_id: 9, message: { chat: { id: 999 }, photo: [{ file_id: 'x', width: 10, height: 10 }] } }]],
  });
  const bridge = bridgeWith(fake, { mediaDir: tempMedia(t) });
  const handled = await bridge.pollOnce();
  assert.equal(handled, 0);
  assert.equal(fake.sent.length, 0);
  assert.ok(!fake.calls.includes('getFile'));
});
