'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer, redact: serverRedact } = require('../server');
const { Store } = require('../store');
const { rateLimitIpKey } = require('../proxy');
const { redact: relayRedact } = require('../link-relay');

const PRICE = { inputPerM: 1, cachedPerM: 0.1, outputPerM: 2 };

async function startServer(t, { fetchImpl, trustProxy = false, trustedProxies, loginIpPer15Min } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-sec-srv-'));
  const plansFile = path.join(dir, 'plans.json');
  fs.writeFileSync(plansFile, JSON.stringify({
    trial: { title: 'Пробный', priceUsd: 0, sessionUsd: 1, weekUsd: 5, trialDays: 7 },
    pro: { title: 'Pro', priceUsd: 10, sessionUsd: 2, weekUsd: 10 },
  }));
  const clock = { ms: Date.parse('2026-11-14T10:00:00Z') };
  const srv = createServer({
    dbFile: path.join(dir, 'sec.db'),
    models: {
      fast: { url: 'http://provider.invalid', key: 'PROV-KEY-1234', model: 'm1', price: PRICE },
      smart: { url: 'http://smart.invalid', key: 'SMART-KEY-1234', model: 'm2', price: { inputPerM: 10, cachedPerM: 1, outputPerM: 20 } },
    },
    plansFile,
    adminKey: 'admin-key-12345',
    fetchImpl,
    now: () => clock.ms,
    trustProxy,
    trustedProxies,
    ...(loginIpPer15Min !== undefined ? { loginIpPer15Min } : {}),
  });
  await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  t.after(async () => {
    await new Promise((r) => srv.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ...srv, base, clock };
}

test('SEC-08: отрицательные prompt/completion tokens, завышенный cached_tokens и отрицательный charge не уменьшают расход', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-sec08-'));
  const directStore = new Store(path.join(dir, 'direct.db'));
  t.after(() => {
    directStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const acc = directStore.createAccount({ email: 'neg@example.com', password: 'password123', plan: 'trial', trialUntil: 9999999, now: 1000 });
  assert.throws(() => directStore.charge(acc.id, { usd: -0.5, now: 1000 }));
  assert.throws(() => directStore.charge(acc.id, { usd: 0.1, weight: -2, now: 1000 }));
  assert.throws(() => directStore.charge(acc.id, { usd: NaN, now: 1000 }));
  directStore.close();

  const responses = [
    { prompt_tokens: -1000000, completion_tokens: -500000, prompt_tokens_details: { cached_tokens: -10 } },
    { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 99999999 } },
  ];
  let idx = 0;
  const { base, store } = await startServer(t, {
    fetchImpl: async () => {
      const usage = responses[idx++];
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ок' } }],
        usage,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const reg = await fetch(`${base}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'u1@example.com', password: 'password123' }),
  });
  assert.equal(reg.status, 201);
  const { token, account } = await reg.json();

  const r1 = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello world' }], stream: false }),
  });
  const r1Text = await r1.text();
  assert.equal(r1.status, 200, r1Text);
  const spendAfterNeg = store.spentSince(0);
  assert.ok(spendAfterNeg > 0, 'отрицательный usage отклонён и заменён неотрицательной оценкой');

  const r2 = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello world' }], stream: false }),
  });
  const r2Text = await r2.text();
  assert.equal(r2.status, 200, r2Text);
  const spendAfterClamp = store.spentSince(0);
  assert.ok(spendAfterClamp >= spendAfterNeg, 'cached_tokens не должен давать отрицательную стоимость');
});

test('SEC-09: rateLimitIpKey сводит IPv6 в /64 и оставляет IPv4 в /32; перебор с ротацией внутри /64 упирается в 429', async (t) => {
  assert.equal(rateLimitIpKey('2001:db8:1:2::1'), '2001:db8:1:2::');
  assert.equal(rateLimitIpKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::');
  assert.equal(rateLimitIpKey('2001:db8:1:3::1'), '2001:db8:1:3::');
  assert.equal(rateLimitIpKey('::ffff:192.0.2.10'), '192.0.2.10');
  assert.equal(rateLimitIpKey('192.0.2.11'), '192.0.2.11');

  const { base } = await startServer(t, {
    trustProxy: true,
    trustedProxies: ['127.0.0.1'],
    loginIpPer15Min: 10,
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });

  const reg2 = await fetch(`${base}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
    body: JSON.stringify({ email: 'target@example.com', password: 'right-password' }),
  });
  await reg2.text();

  let got429 = false;
  for (let i = 1; i <= 25; i += 1) {
    const res = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': `2001:db8:cafe:1::${i.toString(16)}`,
      },
      body: JSON.stringify({ email: `other${i}@example.com`, password: 'wrong-password' }),
    });
    await res.text();
    if (res.status === 429) {
      got429 = true;
      break;
    }
  }
  assert.equal(got429, true, 'ротация адресов одной /64 должна упираться в лимит IP');
});

test('SEC-21: redact в server.js и link-relay.js маскирует x-api-key, apiKey и api_key', () => {
  for (const fn of [serverRedact, relayRedact]) {
    const out1 = fn('x-api-key: ABCDEF1234567890');
    assert.ok(!out1.includes('ABCDEF1234567890'), out1);
    const out2 = fn('{"apiKey":"SECRET999888777","api_key":"XYZ123456789"}');
    assert.ok(!out2.includes('SECRET999888777'), out2);
    assert.ok(!out2.includes('XYZ123456789'), out2);
  }
});
