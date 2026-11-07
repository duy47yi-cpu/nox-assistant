'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitOnLimit } = require('../src/account/limit-wait');
const { AccountSession } = require('../src/account/session');
const { DeepSeekClient } = require('../src/brain/deepseek');

const limitErr = (resetAt) => Object.assign(new Error('лимит'), { accountCode: 'limit', resetAt, window: 'session' });

test('лимит: пауза до сброса, затем тот же запрос продолжается', async () => {
  let calls = 0;
  const events = [];
  const waits = [];
  const brain = waitOnLimit({ model: 'm', chat: async () => { calls += 1; if (calls === 1) throw limitErr(5000); return { content: 'готово' }; } }, {
    now: () => 1000, sleep: async (ms) => { waits.push(ms); }, onPause: (p) => events.push(p), onResume: () => events.push('дальше'),
  });
  assert.equal(brain.model, 'm');
  assert.equal((await brain.chat({})).content, 'готово');
  assert.equal(calls, 2);
  assert.ok(waits[0] >= 4000);
  assert.deepEqual(events, [{ window: 'session', resetAt: 5000 }, 'дальше']);
});

test('часы врут: ждём сколько сказал сервер, не долбим его, сообщаем один раз', async () => {
  let calls = 0;
  const events = [];
  const waits = [];
  const skewed = Object.assign(new Error('лимит'), { accountCode: 'limit', resetAt: 10, retryAfterMs: 60000, window: 'session' });
  const again = Object.assign(new Error('лимит'), { accountCode: 'limit', resetAt: 10, retryAfterMs: 0, window: 'session' });
  const brain = waitOnLimit({ chat: async () => { calls += 1; if (calls === 1) throw skewed; if (calls < 4) throw again; return { content: 'да' }; } }, {
    now: () => 999999, sleep: async (ms) => { waits.push(ms); }, onPause: (p) => events.push(p.resetAt), onResume: () => events.push('дальше'),
  });
  await brain.chat({});
  assert.ok(waits[0] >= 60000);
  assert.ok(waits[1] >= 5000 && waits[2] >= 5000);
  assert.deepEqual(events, [999999 + 60000, 'дальше']);
});

test('стоп во время паузы: запрос не повторяется', async () => {
  let calls = 0;
  const ac = new AbortController();
  const brain = waitOnLimit({ chat: async () => { calls += 1; throw limitErr(Date.now() + 3600000); } });
  const p = brain.chat({ signal: ac.signal });
  setImmediate(() => ac.abort());
  await assert.rejects(p);
  assert.equal(calls, 1);
});

test('другие ошибки и прогрев не ждут', async () => {
  const other = waitOnLimit({ chat: async () => { throw new Error('сеть'); } });
  await assert.rejects(other.chat({}), /сеть/);
  const warm = waitOnLimit({ chat: async () => { throw limitErr(Date.now() + 3600000); } });
  await assert.rejects(warm.chat({ purpose: 'warmup' }));
});

test('клиент модели понимает ответ сервера Nox о лимите', async () => {
  const body = JSON.stringify({ error: { code: 'limit', message: 'лимит на 5 часов исчерпан', window: 'session', resetAt: 123456 } });
  const c = new DeepSeekClient({ baseUrl: 'http://x', apiKey: 'k', model: 'm', fetchImpl: async () => new Response(body, { status: 429 }) });
  await assert.rejects(c.chat({ messages: [] }), (err) => err.accountCode === 'limit' && err.resetAt === 123456 && err.window === 'session' && err.message === 'лимит на 5 часов исчерпан');
});

test('аккаунт: вход хранит пропуск зашифрованным, выход стирает', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-acc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'account.bin');
  const protect = { encrypt: (s) => Buffer.from(s, 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };
  const fetchImpl = async (url) => {
    if (url.endsWith('/login')) return new Response(JSON.stringify({ token: 'nox_abc', account: { email: 'a@b.co' } }), { status: 200 });
    if (url.endsWith('/me')) return new Response('{"error":{"code":"unauthorized","message":"нет"}}', { status: 401 });
    return new Response('{}', { status: 200 });
  };
  const s = new AccountSession({ file, serverUrl: 'http://x/', protect, fetchImpl });
  const seen = [];
  s.onToken = (tok) => seen.push(tok);
  assert.equal((await s.login('a@b.co', 'password1')).ok, true);
  assert.equal(seen.at(-1), 'nox_abc');
  assert.ok(!fs.readFileSync(file).includes('nox_abc'));
  const again = new AccountSession({ file, serverUrl: 'http://x', protect, fetchImpl });
  assert.equal(again.load(), true);
  assert.equal(again.token, 'nox_abc');
  assert.deepEqual(await again.state(), { enabled: true, signedIn: false }); // сервер отозвал пропуск
  assert.equal(fs.existsSync(file), false);
});

test('аккаунт: нет связи не выкидывает из аккаунта', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-acc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new AccountSession({ file: path.join(dir, 'a'), serverUrl: 'http://x', fetchImpl: async () => { throw new Error('нет сети'); } });
  s.token = 'nox_abc';
  const st = await s.state();
  assert.equal(st.signedIn, true);
  assert.equal(st.offline, true);
  assert.equal(s.token, 'nox_abc');
});
