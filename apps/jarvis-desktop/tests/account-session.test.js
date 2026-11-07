'use strict';

// Тесты этапа 8 сверх account.test.js: клиент аккаунта не висит, показывает отказ сервера
// без секретов, при выходе без связи всё равно стирает пропуск.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AccountSession } = require('../src/account/session');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-acc-extra-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'account.bin');
}

test('аккаунт: зависший сервер не держит вход, пропуск не сохраняется', async (t) => {
  const file = tempFile(t);
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const s = new AccountSession({ file, serverUrl: 'http://x', fetchImpl, timeoutMs: 20 });
  const r = await s.login('a@b.co', 'password1');
  assert.equal(r.ok, false);
  assert.equal(r.offline, true);
  assert.match(r.error, /Нет связи/);
  assert.equal(s.token, '');
  assert.equal(fs.existsSync(file), false);
});

test('аккаунт: отказ сервера показывается как есть, без секретов', async (t) => {
  const file = tempFile(t);
  const body = JSON.stringify({ error: { code: 'too_many', message: 'слишком много попыток, подождите 15 минут' } });
  const s = new AccountSession({ file, serverUrl: 'http://x', fetchImpl: async () => new Response(body, { status: 429 }) });
  const r = await s.login('a@b.co', 'password1');
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.code, 'too_many');
  assert.match(r.error, /подождите 15 минут/);
  assert.equal(s.token, '');
  assert.equal(fs.existsSync(file), false);
});

test('аккаунт: состояние посылает пропуск в Bearer; ответ не-JSON даёт понятный отказ', async (t) => {
  const file = tempFile(t);
  const seen = [];
  const s = new AccountSession({
    file,
    serverUrl: 'http://x',
    fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response('не json', { status: 500 }); },
  });
  s.token = 'nox_secret';
  const st = await s.state();
  assert.equal(st.signedIn, true);
  assert.equal(st.error, 'Сервер ответил ошибкой 500');
  assert.equal(seen[0].url, 'http://x/v1/me');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer nox_secret');
  assert.equal(s.token, 'nox_secret', 'сбой сервера не выкидывает из аккаунта');
});

test('аккаунт: выход без связи всё равно стирает пропуск на этом компьютере', async (t) => {
  const file = tempFile(t);
  const protect = { encrypt: (s) => Buffer.from(s, 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };
  const s = new AccountSession({ file, serverUrl: 'http://x', protect, fetchImpl: async () => { throw new Error('нет сети'); } });
  s._store('nox_secret');
  assert.ok(fs.existsSync(file));
  const r = await s.logout();
  assert.equal(r.ok, true);
  assert.equal(s.token, '');
  assert.equal(fs.existsSync(file), false);
});
