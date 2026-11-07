'use strict';

// Голос Fish Audio: запрос к API, сохранение mp3, проигрывание через подмену и удаление файла.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FishSpeech, DEFAULT_MODEL, DEFAULT_URL } = require('../src/voice/fish');

const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-fish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function okFetch(calls, bytes = MP3) {
  return async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, async arrayBuffer() { return bytes; } };
  };
}

test('синтез: ключ уходит в Authorization, модель в заголовке, текст и mp3 в теле', async (t) => {
  const dir = tempDir(t);
  const calls = [];
  const speech = new FishSpeech({ apiKey: 'fish-test-key', tmpDir: dir, fetchImpl: okFetch(calls), playFn: async () => ({ ok: true }) });
  const file = await speech.synthesize('Привет, владелец');
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, DEFAULT_URL);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer fish-test-key');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers.model, DEFAULT_MODEL);
  const body = JSON.parse(options.body);
  assert.equal(body.text, 'Привет, владелец');
  assert.equal(body.format, 'mp3');
  assert.equal(body.reference_id, undefined);
  assert.deepEqual(fs.readFileSync(file), MP3);
  fs.rmSync(file, { force: true });
});

test('голос из настроек (reference_id) и своя модель', async (t) => {
  const dir = tempDir(t);
  const calls = [];
  const speech = new FishSpeech({ apiKey: 'k', voiceId: 'voice-7', model: 's2.1-pro', tmpDir: dir, fetchImpl: okFetch(calls), playFn: async () => ({ ok: true }) });
  await speech.synthesize('текст');
  assert.equal(calls[0].options.headers.model, 's2.1-pro');
  assert.equal(JSON.parse(calls[0].options.body).reference_id, 'voice-7');
});

test('speak: проигрывает файл и удаляет его; ошибка проигрывания тоже убирает файл', async (t) => {
  const dir = tempDir(t);
  let played = null;
  const speech = new FishSpeech({ apiKey: 'k', tmpDir: dir, fetchImpl: okFetch([]), playFn: async (file) => { played = file; assert.equal(fs.existsSync(file), true); return { ok: true, summary: 'играет' }; } });
  const file = await speech.speak('раз');
  assert.ok(played && played.endsWith('.mp3'));
  assert.equal(fs.existsSync(file), false, 'временный mp3 удалён');

  const failing = new FishSpeech({ apiKey: 'k', tmpDir: dir, fetchImpl: okFetch([]), playFn: async () => ({ ok: false, summary: 'нет кодеков' }) });
  await assert.rejects(() => failing.speak('два'), /проигрывание не удалось.*нет кодеков/);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.mp3')).length, 0);
});

test('ошибки API, пустой звук и отсутствие ключа — понятные отказы', async (t) => {
  const dir = tempDir(t);
  const status = new FishSpeech({ apiKey: 'k', tmpDir: dir, fetchImpl: async () => ({ ok: false, status: 401, async text() { return 'Unauthorized'; } }) });
  await assert.rejects(() => status.synthesize('текст'), /ответил ошибкой \(код 401\)/);

  const empty = new FishSpeech({ apiKey: 'k', tmpDir: dir, fetchImpl: okFetch([], Buffer.alloc(0)) });
  await assert.rejects(() => empty.synthesize('текст'), /пустой звук/);

  const noKey = new FishSpeech({ tmpDir: dir, fetchImpl: okFetch([]) });
  assert.equal(noKey.isInstalled(), false);
  await assert.rejects(() => noKey.synthesize('текст'), /ключ Fish Audio не задан/);
});

test('таймаут и отмена: запрос не висит, ошибка честная', async (t) => {
  const dir = tempDir(t);
  const hangs = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const timed = new FishSpeech({ apiKey: 'k', tmpDir: dir, timeoutMs: 30, fetchImpl: hangs });
  await assert.rejects(() => timed.synthesize('текст'), /не ответил за 1 с/);

  const aborted = new FishSpeech({ apiKey: 'k', tmpDir: dir, fetchImpl: hangs });
  const controller = new AbortController();
  const pending = aborted.synthesize('текст', { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, /синтез отменён/);
});

test('текст обрезается по кодовым точкам, пустой отклоняется', async (t) => {
  const dir = tempDir(t);
  const calls = [];
  const speech = new FishSpeech({ apiKey: 'k', tmpDir: dir, fetchImpl: okFetch(calls), playFn: async () => ({ ok: true }) });
  await speech.synthesize('😀'.repeat(600));
  const sent = JSON.parse(calls[0].options.body).text;
  assert.equal(Array.from(sent).length, 500);
  await assert.rejects(() => speech.synthesize('   '), /пустой текст/);
});
