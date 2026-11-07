'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('./server');

const PRICE = { inputPerM: 1, cachedPerM: 0.1, outputPerM: 2 };
const HOUR = 3600000;

// Поддельный провайдер: запоминает запросы, отвечает потоком с расходом.
function provider({ prompt = 1000, completion = 500, status = 200, stream = true, withUsage = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const enc = new TextEncoder();
    const usage = { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: 0 } };
    if (status !== 200) return new Response('секрет счёта', { status });
    if (!stream) return new Response(JSON.stringify({ choices: [{ message: { content: 'ок' } }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'привет' } }] })}\n\n${withUsage ? `data: ${JSON.stringify({ choices: [], usage })}\n\n` : ''}data: [DONE]\n\n`;
    return new Response(enc.encode(sse), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { calls, fetchImpl };
}

async function start(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-srv-'));
  const plansFile = path.join(dir, 'plans.json');
  fs.writeFileSync(plansFile, JSON.stringify({ trial: { title: 'Пробный', priceUsd: 0, sessionUsd: 0.05, weekUsd: 0.25, trialDays: 7 }, pro: { title: 'Pro', priceUsd: 10, sessionUsd: 1, weekUsd: 5 } }));
  const clock = { ms: Date.parse('2026-11-01T10:00:00Z') };
  const prov = overrides.provider || provider();
  const { server, store } = createServer({ dbFile: path.join(dir, 'x.db'), models: { fast: { url: 'http://provider', key: 'PROVIDER-SECRET', model: 'm1', price: PRICE }, smart: { url: 'http://smart', key: 'SMART-SECRET', model: 'm2', price: { inputPerM: 10, cachedPerM: 1, outputPerM: 20 } } }, plansFile, adminKey: 'admin-key-12345', fetchImpl: prov.fetchImpl, now: () => clock.ms, ...overrides.config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* поток */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const user = async (email = 'a@b.co') => (await call('POST', '/v1/auth/register', { body: { email, password: 'password1' } })).json;
  const ask = (token, extra = {}) => call('POST', '/v1/chat/completions', { token, body: { messages: [{ role: 'user', content: 'x' }], stream: true, ...extra } });
  return { call, user, ask, clock, prov, store };
}

test('регистрация, вход, неверный пароль и чужая почта отвечают одинаково', async (t) => {
  const { call, user } = await start(t);
  const a = await user();
  assert.equal(a.account.plan, 'trial');
  assert.match(a.token, /^nox_/);
  assert.equal((await call('POST', '/v1/auth/register', { body: { email: 'A@b.co', password: 'password1' } })).status, 409);
  assert.equal((await call('POST', '/v1/auth/login', { body: { email: 'a@b.co', password: 'password1' } })).status, 200);
  const wrong = await call('POST', '/v1/auth/login', { body: { email: 'a@b.co', password: 'password2' } });
  const none = await call('POST', '/v1/auth/login', { body: { email: 'n@b.co', password: 'password2' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.text, none.text);
  assert.equal((await call('POST', '/v1/auth/register', { body: { email: 'плохо', password: 'password1' } })).status, 400);
  assert.equal((await call('POST', '/v1/auth/register', { body: { email: 'c@b.co', password: 'короткий' } })).status, 201);
});

test('в базе нет пропуска и пароля открытым текстом', async (t) => {
  const { user, store } = await start(t);
  const a = await user();
  const dump = JSON.stringify([store.db.prepare('SELECT * FROM tokens').all(), store.db.prepare('SELECT * FROM accounts').all()]);
  assert.ok(!dump.includes(a.token));
  assert.ok(!dump.includes('password1'));
});

test('без пропуска и с отозванным пропуском запрос не проходит и провайдера не трогает', async (t) => {
  const { call, user, ask, prov } = await start(t);
  assert.equal((await ask('')).status, 401);
  const a = await user();
  assert.equal((await call('POST', '/v1/auth/logout', { token: a.token })).status, 200);
  assert.equal((await ask(a.token)).status, 401);
  assert.equal(prov.calls.length, 0);
});

test('пересылка: ключ сервера, модель сервера, потолок выхода, чужие поля отброшены', async (t) => {
  const { user, ask, prov } = await start(t);
  const a = await user();
  const res = await ask(a.token, { model: 'дорогая', max_tokens: 999999, logit_bias: { 1: 1 } });
  assert.equal(res.status, 200);
  assert.match(res.text, /привет/);
  const sent = prov.calls[0];
  assert.equal(sent.headers.Authorization, 'Bearer PROVIDER-SECRET');
  assert.equal(sent.body.model, 'm1');
  assert.equal(sent.body.max_tokens, 8192);
  assert.equal(sent.body.logit_bias, undefined);
  assert.deepEqual(sent.body.stream_options, { include_usage: true });
  assert.ok(!res.text.includes('PROVIDER-SECRET'));
});

test('лимит 5 часов: стоп с временем сброса, после сброса снова работает', async (t) => {
  const prov = provider({ prompt: 20000, completion: 10000 }); // $0.04 за запрос, у пробного окно $0.05
  const { user, ask, clock, call } = await start(t, { provider: prov });
  const a = await user();
  const started = clock.ms;
  assert.equal((await ask(a.token)).status, 200);
  clock.ms += HOUR;
  assert.equal((await ask(a.token)).status, 200);
  const me = (await call('GET', '/v1/me', { token: a.token })).json;
  assert.equal(me.limits.session.percent, 100);
  clock.ms += HOUR;
  const n = prov.calls.length;
  const stopped = await ask(a.token);
  assert.equal(stopped.status, 429);
  assert.equal(stopped.json.error.code, 'limit');
  assert.equal(stopped.json.error.window, 'session');
  assert.equal(stopped.json.error.resetAt, started + 5 * HOUR);
  assert.ok(Number(stopped.headers.get('retry-after')) > 0);
  assert.equal(prov.calls.length, n);
  clock.ms = started + 5 * HOUR;
  assert.equal((await ask(a.token)).status, 200);
});

test('неделя держит и после сброса 5 часов; сообщается поздний срок', async (t) => {
  const prov = provider({ prompt: 20000, completion: 10000 });
  const { user, ask, clock } = await start(t, { provider: prov }); // неделя у пробного $0.25
  const a = await user();
  const started = clock.ms;
  for (let i = 0; i < 7; i++) {
    assert.equal((await ask(a.token)).status, 200, `запрос ${i}`);
    clock.ms += 3 * HOUR;
  }
  const r = await ask(a.token);
  assert.equal(r.status, 429);
  assert.equal(r.json.error.window, 'week');
  assert.equal(r.json.error.resetAt, started + 7 * 24 * HOUR);
});

test('пробный период кончился: 402, тариф открывает доступ', async (t) => {
  const { user, ask, clock, call } = await start(t);
  const a = await user();
  clock.ms += 8 * 24 * HOUR;
  assert.equal((await ask(a.token)).json.error.code, 'trial_ended');
  assert.equal((await call('POST', '/v1/admin/plan', { token: 'wrong', body: { email: 'a@b.co', plan: 'pro' } })).status, 403);
  assert.equal((await call('POST', '/v1/admin/plan', { token: a.token, body: { email: 'a@b.co', plan: 'pro' } })).status, 403);
  assert.equal((await call('POST', '/v1/admin/plan', { token: 'admin-key-12345', body: { email: 'a@b.co', plan: 'pro' } })).json.plan, 'pro');
  assert.equal((await ask(a.token)).status, 200);
});

test('ошибка провайдера не списывается и не показывает его ответ', async (t) => {
  const { user, ask, call } = await start(t, { provider: provider({ status: 500 }) });
  const a = await user();
  const r = await ask(a.token);
  assert.equal(r.status, 500);
  assert.ok(!r.text.includes('секрет счёта'));
  assert.equal((await call('GET', '/v1/me', { token: a.token })).json.limits.session.percent, 0);
});

test('нет данных о расходе: списывается оценка, а не ноль', async (t) => {
  const { user, ask, store } = await start(t, { provider: provider({ withUsage: false }) });
  const a = await user();
  await ask(a.token);
  const row = store.db.prepare('SELECT usd, estimated FROM usage').get();
  assert.equal(row.estimated, 1);
  assert.ok(row.usd > 0);
});

test('запрос без потока тоже списывается', async (t) => {
  const { user, ask, store } = await start(t, { provider: provider({ stream: false }) });
  const a = await user();
  assert.equal((await ask(a.token, { stream: false })).status, 200);
  const row = store.db.prepare('SELECT estimated, prompt FROM usage').get();
  assert.equal(row.estimated, 0);
  assert.equal(row.prompt, 1000);
});

test('предохранитель кошелька: общий расход за сутки останавливает всех', async (t) => {
  const prov = provider({ prompt: 1000000, completion: 0 }); // $1
  const { user, ask } = await start(t, { provider: prov, config: { globalDailyUsd: 0.5 } });
  const a = await user('a@b.co');
  const b = await user('b@b.co');
  await ask(a.token);
  assert.equal((await ask(b.token)).json.error.code, 'capacity');
});

test('подбор пароля и массовая регистрация ограничены', async (t) => {
  const { call, user } = await start(t);
  await user();
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/v1/auth/login', { body: { email: 'a@b.co', password: 'неверный1' } });
  assert.equal(last.status, 429);
  for (let i = 0; i < 4; i++) await user(`u${i}@b.co`);
  assert.equal((await call('POST', '/v1/auth/register', { body: { email: 'z@b.co', password: 'password1' } })).status, 429);
});

test('отключённый аккаунт не работает', async (t) => {
  const { call, user, ask } = await start(t);
  const a = await user();
  assert.equal((await call('POST', '/v1/admin/disable', { token: 'admin-key-12345', body: { email: 'a@b.co' } })).status, 200);
  assert.equal((await ask(a.token)).status, 401);
  assert.equal((await call('POST', '/v1/auth/login', { body: { email: 'a@b.co', password: 'password1' } })).status, 401);
});

test('умная модель: свой адрес, ключ и цена; неизвестный уровень отклонён; имя модели от приложения не работает', async (t) => {
  const { user, ask, prov, store } = await start(t);
  const a = await user();
  assert.equal((await ask(a.token, { tier: 'smart', model: 'другая' })).status, 200);
  const sent = prov.calls[0];
  assert.match(sent.url, /^http:\/\/smart\//);
  assert.equal(sent.headers.Authorization, 'Bearer SMART-SECRET');
  assert.equal(sent.body.model, 'm2');
  assert.equal(sent.body.tier, undefined);
  assert.ok(Math.abs(store.db.prepare('SELECT usd FROM usage').get().usd - 0.02) < 1e-9); // 1000 × $10 + 500 × $20 за млн
  assert.equal((await ask(a.token, { tier: 'дорогая' })).status, 400);
  assert.equal((await ask(a.token, { tier: 'constructor' })).status, 400);
  assert.equal(prov.calls.length, 1);
});

test('настройка моделей: без ключа и цены сервер не стартует', () => {
  const { loadModels, DEFAULT_MODELS } = require('./models');
  assert.throws(() => loadModels({ env: {} }), /ключ/);
  const ok = loadModels({ env: { NOX_FAST_KEY: 'a', NOX_SMART_KEY: 'b' } });
  assert.equal(ok.smart.model, DEFAULT_MODELS.smart.model);
  assert.equal(ok.smart.key, 'b');
});

test('уровень мышления: поля провайдеру, лимит тратится быстрее, настоящая цена в учёте прежняя', async (t) => {
  const prov = provider({ prompt: 1000, completion: 500 }); // $0.002
  const { user, ask, store, call } = await start(t, { provider: prov, config: { models: { fast: { url: 'http://provider', key: 'K', model: 'm1', price: PRICE, levels: { low: {}, high: { reasoning_effort: 'high' } } } } } });
  const a = await user();
  await ask(a.token, { level: 'high', reasoning_effort: 'none' });
  assert.equal(prov.calls[0].body.reasoning_effort, 'high');
  assert.equal(prov.calls[0].body.level, undefined);
  assert.ok(Math.abs(store.db.prepare('SELECT usd FROM usage').get().usd - 0.002) < 1e-9);
  assert.equal((await call('GET', '/v1/me', { token: a.token })).json.limits.session.percent, 10); // 0.002 × 2.5 из 0.05
  assert.equal((await ask(a.token, { level: 'максимум' })).status, 400);
});
