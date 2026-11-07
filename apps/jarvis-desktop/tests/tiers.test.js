'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRouter } = require('../src/brain/tiers');
const { DeepSeekClient } = require('../src/brain/deepseek');

const fake = (name, extra = {}) => ({ model: name, calls: [], ...extra, async chat(a) { this.calls.push(a); return { content: name }; } });

test('выбор пользователя и явный уровень задачи', async () => {
  const fast = fake('f'); const smart = fake('s');
  const r = createRouter({ clients: { fast, smart }, getSettings: () => ({ modelTier: 'smart', thinking: 'high' }) });
  assert.equal((await r.chat({})).content, 's');
  assert.deepEqual(smart.calls[0].levelFields, { reasoning_effort: 'high' });
  assert.equal((await r.chat({ tier: 'fast', thinking: 'low' })).content, 'f');
  assert.deepEqual(fast.calls[0].levelFields, {});
  assert.equal(r.model, 'f');
});

test('область кеша различает модели, уровень и выбранный собственный провайдер', () => {
  const fast = fake('f'); const smart = fake('s'); const owner = fake('o');
  let selected = false;
  const r = createRouter({ clients: { fast, smart }, override: () => selected ? owner : null });
  assert.notDeepEqual(r.cacheScope({ tier: 'fast' }), r.cacheScope({ tier: 'smart' }));
  const previous = r.cacheScope({ tier: 'smart' });
  selected = true;
  assert.notDeepEqual(previous, r.cacheScope({ tier: 'smart' }));
});

test('нет умной или мусор в настройках: быстрая и низкий уровень', async () => {
  const fast = fake('f');
  const r = createRouter({ clients: { fast }, getSettings: () => ({ modelTier: 'smart', thinking: 'мусор' }) });
  await r.chat({});
  assert.equal(fast.calls[0].tier, 'fast');
  assert.equal(fast.calls[0].thinking, 'low');
});

test('клиент: поля уровня уходят провайдеру, а сервер Nox получает только уровень', async () => {
  const bodies = [];
  const fetchImpl = async (_u, o) => { bodies.push(JSON.parse(o.body)); return new Response('{"choices":[{"message":{"content":"ок"}}]}', { status: 200 }); };
  const direct = new DeepSeekClient({ baseUrl: 'http://x', apiKey: 'k', model: 'm', reasoning: 'off', fetchImpl });
  await direct.chat({ messages: [], levelFields: { reasoning_effort: 'high' }, tier: 'smart', thinking: 'high' });
  assert.equal(bodies[0].reasoning_effort, 'high');
  assert.equal(bodies[0].tier, undefined);
  const server = new DeepSeekClient({ baseUrl: 'http://x', apiKey: 'k', model: 'm', fetchImpl });
  server.sendTier = true;
  await server.chat({ messages: [], tier: 'smart', thinking: 'high', levelFields: null });
  assert.equal(bodies[1].tier, 'smart');
  assert.equal(bodies[1].level, 'high');
});

test('ошибка модели не называет поставщика', async () => {
  const c = new DeepSeekClient({ baseUrl: 'http://x', apiKey: 'k', model: 'm', fetchImpl: async () => new Response('{"error":{"message":"плохо"}}', { status: 500 }) });
  await assert.rejects(c.chat({ messages: [] }), (e) => !/deepseek/i.test(e.message));
});

test('в том, что видит пользователь, нет названий моделей', () => {
  const dir = path.join(__dirname, '..', 'renderer');
  for (const f of ['index.html', 'app.js', 'account.js', 'model-pick.js', 'mini.html']) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /deepseek|minimax|deepinfra|digitalocean/i, f);
  }
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /return \{ mode, model: '', hasKey/);
});
