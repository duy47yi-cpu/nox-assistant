'use strict';

// Тесты этапа 8 сверх server.test.js: срок сессий, отзыв, изоляция двух пользователей,
// лимиты входа и служебных запросов, маскирование, миграции, резервная копия, битая база.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { DatabaseSync } = require('node:sqlite');
const { createServer, redact } = require('./server');
const { Store, hashPassword, sha256, SCHEMA_VERSION } = require('./store');

const PRICE = { inputPerM: 1, cachedPerM: 0.1, outputPerM: 2 };
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-01T10:00:00Z');

// Поддельный провайдер: запоминает запросы, отвечает потоком с расходом.
function provider({ status = 200, handler = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body || '{}'), headers: init.headers });
    if (handler) return handler(url, init, calls);
    const usage = { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 0 } };
    if (status !== 200) return new Response('секрет счёта', { status });
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'привет' } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { calls, fetchImpl };
}

async function start(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-acc-srv-'));
  const plansFile = path.join(dir, 'plans.json');
  fs.writeFileSync(plansFile, JSON.stringify({
    trial: { title: 'Пробный', priceUsd: 0, sessionUsd: 0.05, weekUsd: 0.25, trialDays: 7 },
    pro: { title: 'Pro', priceUsd: 10, sessionUsd: 1, weekUsd: 5 },
  }));
  const clock = { ms: overrides.now || NOW };
  const prov = overrides.provider || provider();
  const dbFile = overrides.dbFile || path.join(dir, 'x.db');
  if (overrides.prepareDb) overrides.prepareDb(dbFile);
  const { server, store } = createServer({
    dbFile,
    models: {
      fast: { url: 'http://provider', key: 'PROVIDER-SECRET', model: 'm1', price: PRICE },
      smart: { url: 'http://smart', key: 'SMART-SECRET', model: 'm2', price: PRICE },
    },
    plansFile,
    adminKey: 'admin-key-12345',
    fetchImpl: prov.fetchImpl,
    now: () => clock.ms,
    ...overrides.config,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method, url, { token, body, raw } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* поток */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const user = async (email = 'a@b.co', password = 'password1') => (await call('POST', '/v1/auth/register', { body: { email, password } })).json;
  const login = (email, password) => call('POST', '/v1/auth/login', { body: { email, password } });
  const ask = (token, extra = {}) => call('POST', '/v1/chat/completions', { token, body: { messages: [{ role: 'user', content: 'x' }], stream: true, ...extra } });
  const me = (token) => call('GET', '/v1/me', { token });
  return { dir, dbFile, base, port: server.address().port, call, user, login, ask, me, clock, prov, store, server };
}

test('срок сессии: истёкший пропуск отвечает 401, повторный вход даёт новый', async (t) => {
  const h = await start(t, { config: { sessionTtlMs: 1000 } });
  const a = await h.user();
  assert.equal((await h.me(a.token)).status, 200);
  const row = h.store.db.prepare('SELECT created_at, expires_at FROM tokens WHERE hash = ?').get(sha256(a.token));
  assert.equal(row.expires_at - row.created_at, 1000);
  h.clock.ms += 1500;
  const expired = await h.me(a.token);
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error.code, 'unauthorized');
  assert.equal((await h.ask(a.token)).status, 401);
  const again = await h.login('a@b.co', 'password1');
  assert.equal(again.status, 200);
  assert.equal((await h.me(again.json.token)).status, 200);
});

test('отзыв: выход снимает только этот пропуск; отключение — все; чужой аккаунт не задет', async (t) => {
  const h = await start(t);
  const a = await h.user('a@b.co');
  const second = (await h.login('a@b.co', 'password1')).json.token;
  const b = await h.user('b@b.co');
  assert.equal((await h.call('POST', '/v1/auth/logout', { token: a.token })).status, 200);
  assert.equal((await h.me(a.token)).status, 401);
  assert.equal((await h.me(second)).status, 200, 'вторая сессия того же человека жива');
  assert.equal((await h.call('POST', '/v1/admin/disable', { token: 'admin-key-12345', body: { email: 'a@b.co' } })).status, 200);
  assert.equal((await h.me(second)).status, 401, 'отключение отзывает все пропуска');
  assert.equal((await h.me(b.token)).status, 200, 'второго пользователя это не касается');
});

test('изоляция двух пользователей: свой аккаунт, свои лимиты, свой тариф, чужой пропуск не служебный', async (t) => {
  const h = await start(t);
  const a = await h.user('a@b.co');
  const b = await h.user('b@b.co');
  const meA = (await h.me(a.token)).json;
  const meB = (await h.me(b.token)).json;
  assert.equal(meA.email, 'a@b.co');
  assert.equal(meB.email, 'b@b.co');
  assert.notEqual(meA.id, meB.id);

  // Расход и лимиты одного не меняют другого.
  assert.equal((await h.ask(a.token)).status, 200);
  assert.ok((await h.me(a.token)).json.limits.session.percent > 0);
  assert.equal((await h.me(b.token)).json.limits.session.percent, 0);

  // Пользовательский пропуск не даёт служебных прав; смена тарифа одного не трогает второго.
  assert.equal((await h.call('POST', '/v1/admin/plan', { token: a.token, body: { email: 'a@b.co', plan: 'pro' } })).status, 403);
  assert.equal((await h.call('POST', '/v1/admin/plan', { token: 'admin-key-12345', body: { email: 'a@b.co', plan: 'pro' } })).json.plan, 'pro');
  assert.equal((await h.me(b.token)).json.plan, 'trial');

  // Выход одного не выкидывает другого.
  await h.call('POST', '/v1/auth/logout', { token: a.token });
  assert.equal((await h.me(b.token)).status, 200);
  assert.equal((await h.me('')).status, 401);
});

test('пропуска: мусор, обрезанный и поддельный не проходят и не выдают причину', async (t) => {
  const h = await start(t);
  const a = await h.user();
  const wrong = await h.me('nox_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'unauthorized');
  assert.ok(!wrong.text.includes('a@b.co'));
  assert.equal((await h.call('GET', '/v1/me', { token: 'Bearer ' + a.token })).status, 401); // заголовок уже с Bearer
});

test('пароль: версия алгоритма, старая запись обновляется при входе, битая запись — 401 а не 500', async (t) => {
  const h = await start(t);
  await h.user('new@b.co');
  const row = h.store.db.prepare('SELECT pass_algo, pass_hash FROM accounts WHERE email = ?').get('new@b.co');
  assert.match(row.pass_algo, /^scrypt\$16384\$8\$1\$64$/);
  assert.ok(!row.pass_hash.includes('password1'));

  // Старая запись без версии алгоритма (как после прежней версии сервера).
  const { salt, hash } = hashPassword('password1');
  h.store.db.prepare("UPDATE accounts SET pass_salt = ?, pass_hash = ?, pass_algo = '' WHERE email = ?").run(salt, hash, 'new@b.co');
  assert.equal((await h.login('new@b.co', 'password1')).status, 200);
  assert.equal(h.store.db.prepare('SELECT pass_algo FROM accounts WHERE email = ?').get('new@b.co').pass_algo, 'scrypt$16384$8$1$64');

  // Испорченная запись пароля: отказ, а не внутренняя ошибка.
  h.store.db.prepare("UPDATE accounts SET pass_hash = 'не-хеш' WHERE email = ?").run('new@b.co');
  const broken = await h.login('new@b.co', 'password1');
  assert.equal(broken.status, 401);
  const none = await h.login('nobody@b.co', 'password1');
  assert.equal(none.status, 401);
  assert.equal(broken.text, none.text, 'вид отказа одинаковый');
  assert.equal(h.store.checkPassword(null, 'password1'), false);
});

test('перебор входа ограничен по адресу в целом, а не только по паре адрес+почта', async (t) => {
  const h = await start(t, { config: { loginIpPer15Min: 3 } });
  await h.user('real@b.co');
  for (const email of ['u1@b.co', 'u2@b.co', 'u3@b.co']) {
    assert.equal((await h.login(email, 'password1')).status, 401);
  }
  const stopped = await h.login('real@b.co', 'password1');
  assert.equal(stopped.status, 429);
  assert.equal(stopped.json.error.code, 'too_many');
  h.clock.ms += 15 * 60000 + 1;
  assert.equal((await h.login('real@b.co', 'password1')).status, 200);
});

test('служебный ключ: неудачные попытки учитываются, рабочие вызовы не блокируются', async (t) => {
  const h = await start(t, { config: { adminPer15Min: 2 } });
  const body = { email: 'nobody@b.co', plan: 'pro' };
  assert.equal((await h.call('POST', '/v1/admin/plan', { token: 'wrong-1', body })).status, 403);
  assert.equal((await h.call('POST', '/v1/admin/plan', { token: 'wrong-2', body })).status, 403);
  const blocked = await h.call('POST', '/v1/admin/plan', { token: 'admin-key-12345', body });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'too_many');
  h.clock.ms += 15 * 60000 + 1;
  assert.equal((await h.call('POST', '/v1/admin/plan', { token: 'admin-key-12345', body })).status, 404);
});

test('журнал и ответы не содержат секретов: маскировка, понятная 500, заголовки', async (t) => {
  const washed = redact('Bearer nox_abcdefgh123456 и почта a@b.co, ключи PROVIDER-SECRET admin-key-12345', ['PROVIDER-SECRET', 'admin-key-12345']);
  assert.ok(!washed.includes('nox_abcdefgh'), washed);
  assert.ok(!washed.includes('a@b.co'));
  assert.ok(!washed.includes('PROVIDER-SECRET'));
  assert.ok(!washed.includes('admin-key-12345'));

  const h = await start(t);
  const a = await h.user();
  // Искусственный внутренний сбой с секретом в тексте: наружу — обезличенная 500, в журнал — без секретов.
  h.store.spentSince = () => { throw new Error(`сбой у a@b.co, пропуск ${a.token}, ключ PROVIDER-SECRET`); };
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const r = await h.ask(a.token);
    assert.equal(r.status, 500);
    assert.equal(r.json.error.code, 'internal');
    assert.ok(!r.text.includes(a.token));
    assert.ok(!r.text.includes('PROVIDER-SECRET'));
  } finally {
    console.error = original;
  }
  const log = lines.join('\n');
  assert.ok(log.length > 0, 'сбой попал в журнал');
  assert.ok(!log.includes(a.token), 'пропуск замаскирован');
  assert.ok(!log.includes('a@b.co'), 'почта замаскирована');
  assert.ok(!log.includes('PROVIDER-SECRET'), 'ключ провайдера замаскирован');

  // Успешные ответы: только свои данные, никаких ключей и пароля.
  const bad = await h.call('POST', '/v1/auth/login', { body: { email: 'a@b.co', password: 'супер-пароль-123' } });
  assert.ok(!bad.text.includes('супер-пароль-123'));
  assert.ok(!bad.text.includes('PROVIDER-SECRET'));
  assert.ok(!bad.text.includes('admin-key-12345'));
  const ok = await h.me(a.token);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
});

test('слишком большое тело: 413 без падения сервера', async (t) => {
  const h = await start(t);
  const r = await h.call('POST', '/v1/auth/register', { raw: 'x'.repeat(5000) });
  assert.equal(r.status, 413);
  assert.equal((await h.call('GET', '/health')).status, 200, 'сервер жив');
});

test('регистрация одной почты одновременно: один 201, остальные 409, без 500', async (t) => {
  const h = await start(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => h.call('POST', '/v1/auth/register', { body: { email: 'race@b.co', password: 'password1' } })));
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 409, 409, 409]);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE email = ?').get('race@b.co').n, 1);
});

test('миграция старой базы: вход работает, пропуска получают срок, схема доведена до текущей', async (t) => {
  const legacyNow = NOW - 40 * DAY;
  const h = await start(t, {
    prepareDb(dbFile) {
      const legacy = new DatabaseSync(dbFile);
      legacy.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL,
          plan TEXT NOT NULL, trial_until INTEGER, created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE tokens (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE windows (account_id TEXT NOT NULL REFERENCES accounts(id), kind TEXT NOT NULL, started_at INTEGER NOT NULL, used_usd REAL NOT NULL, PRIMARY KEY (account_id, kind));
        CREATE TABLE usage (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), at INTEGER NOT NULL, usd REAL NOT NULL, prompt INTEGER, cached INTEGER, completion INTEGER, estimated INTEGER NOT NULL);
        CREATE TABLE attempts (key TEXT NOT NULL, at INTEGER NOT NULL);
      `);
      const { salt, hash } = hashPassword('password1'); // прежний формат: без версии алгоритма
      legacy.prepare('INSERT INTO accounts (id, email, pass_hash, pass_salt, plan, trial_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('id-old', 'old@b.co', hash, salt, 'pro', null, legacyNow);
      // Свежий старый пропуск — после миграции должен ещё работать.
      legacy.prepare('INSERT INTO tokens (hash, account_id, created_at) VALUES (?, ?, ?)')
        .run(sha256('nox_legacy-token-123456'), 'id-old', NOW - 1000);
      // Пропуск 40-дневной давности — после миграции уже просрочен.
      legacy.prepare('INSERT INTO tokens (hash, account_id, created_at) VALUES (?, ?, ?)')
        .run(sha256('nox_old-token-123456'), 'id-old', legacyNow);
      legacy.close();
    },
  });
  assert.equal(h.store.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(h.store.db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name).filter((n) => n === 'pass_algo'), ['pass_algo']);
  assert.deepEqual(h.store.db.prepare('PRAGMA table_info(tokens)').all().map((c) => c.name).filter((n) => n === 'expires_at'), ['expires_at']);
  assert.equal((await h.me('nox_legacy-token-123456')).status, 200, 'свежий старый пропуск жив');
  assert.equal((await h.me('nox_old-token-123456')).status, 401, 'старый пропуск получил срок и истёк');
  assert.equal((await h.login('old@b.co', 'password1')).status, 200);
  assert.notEqual(h.store.db.prepare('SELECT pass_algo FROM accounts WHERE email = ?').get('old@b.co').pass_algo, '');
});

test('битая база: понятный отказ при запуске без содержимого базы', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-acc-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbFile = path.join(dir, 'broken.db');
  fs.writeFileSync(dbFile, 'это точно не база SQLite');
  assert.throws(() => createServer({
    dbFile,
    models: { fast: { url: 'http://x', key: 'K', model: 'm', price: PRICE } },
    fetchImpl: async () => new Response(''),
  }), (err) => /база Nox не открылась/.test(err.message) && /резервной копии/.test(err.message) && !err.message.includes('это точно не база'));
});

test('резервная копия: цельный снимок открывается, данные на месте, существующая копия не перезаписывается', async (t) => {
  const h = await start(t);
  const a = await h.user();
  const copy = path.join(h.dir, 'backup.db');
  const done = h.store.backupTo(copy);
  assert.ok(done.bytes > 0);
  assert.ok(fs.existsSync(copy));
  assert.throws(() => h.store.backupTo(copy), /уже существует/);

  const restored = new Store(copy);
  try {
    assert.equal(restored.schemaVersion, SCHEMA_VERSION);
    assert.equal(restored.accountByEmail('a@b.co').email, 'a@b.co');
    assert.equal(restored.accountByToken(a.token, h.clock.ms).email, 'a@b.co', 'пропуск из копии действует');
  } finally {
    restored.close();
  }
  assert.equal((await h.me(a.token)).status, 200, 'исходная база не изменилась');
});

test('таймаут провайдера: 504, слот не залипает, следующие запросы обрабатываются', async (t) => {
  const prov = provider({
    handler: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const h = await start(t, { provider: prov, config: { upstreamTimeoutMs: 30 } });
  const a = await h.user();
  // Больше, чем одновременных слотов (3): если слот залип, был бы 429.
  for (let i = 0; i < 4; i++) {
    const r = await h.ask(a.token);
    assert.equal(r.status, 504, `запрос ${i}`);
    assert.equal(r.json.error.code, 'upstream_timeout');
  }
});

test('неверный адрес: 400, а не 500', async (t) => {
  const h = await start(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method: 'GET', path: '//%%%bad' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
});
