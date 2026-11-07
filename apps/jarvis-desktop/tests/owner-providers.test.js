'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readOwnerBuild } = require('../src/config/build');
const { OwnerProviders } = require('../src/brain/providers');
const { createRouter } = require('../src/brain/tiers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nox-owner-'));
// Подмена safeStorage: обратимо, но не открытым текстом.
const protect = {
  encrypt: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const local = { name: 'Дом', baseUrl: 'http://localhost:11434/v1/', model: 'my-model', key: 'sk-secret-123' };

test('флаг сборки только из build-info.json, без файла — обычная сборка', () => {
  const dir = tmp();
  const file = path.join(dir, 'build-info.json');
  assert.equal(readOwnerBuild(file), false);
  fs.writeFileSync(file, '{"OWNER_BUILD":"true"}');
  assert.equal(readOwnerBuild(file), false, 'только логическое true');
  fs.writeFileSync(file, '{"OWNER_BUILD":true}');
  assert.equal(readOwnerBuild(file), true);
  fs.writeFileSync(file, 'мусор');
  assert.equal(readOwnerBuild(file), false);
});

test('обычная сборка: провайдеры недоступны, ядро отказывает', () => {
  const file = path.join(tmp(), 'providers.json');
  const p = new OwnerProviders({ ownerBuild: false, file, protect });
  for (const call of [() => p.list(), () => p.save(local), () => p.select('Дом'), () => p.remove('Дом')]) {
    assert.throws(call, (e) => e.code === 'not_owner');
  }
  assert.equal(fs.existsSync(file), false);
  // Даже подложенный providers.json не включает провайдера.
  fs.writeFileSync(file, JSON.stringify({ selected: 'Дом', providers: [{ name: 'Дом', baseUrl: 'http://x', model: 'm', key: '' }] }));
  assert.equal(p.client(), null);
});

test('сборка владельца: провайдер сохраняется, выбирается и заменяет модели', async () => {
  const file = path.join(tmp(), 'providers.json');
  const p = new OwnerProviders({ ownerBuild: true, file, protect });
  assert.equal(p.client(), null);
  p.save(local);
  const r = p.select('Дом');
  assert.deepEqual(r, { selected: 'Дом', providers: [{ name: 'Дом', baseUrl: 'http://localhost:11434/v1', model: 'my-model', hasKey: true }] });
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /sk-secret-123/, 'ключ не в открытом виде');
  const client = p.client();
  assert.equal(client.apiKey, 'sk-secret-123');
  assert.equal(client.model, 'my-model');
  assert.equal(p.client(), client, 'тот же клиент, пока запись не менялась');

  const seen = [];
  client.fetchImpl = async (url, o) => { seen.push({ url, body: JSON.parse(o.body) }); return new Response('{"choices":[{"message":{"content":"свой"}}]}', { status: 200 }); };
  const fast = { model: 'f', async chat() { return { content: 'обычная' }; } };
  const router = createRouter({ clients: { fast }, getSettings: () => ({ thinking: 'high' }), override: () => p.client() });
  assert.equal((await router.chat({ messages: [] })).content, 'свой');
  assert.equal(seen[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(seen[0].body.reasoning_effort, undefined, 'поля уровня своему серверу не шлём');
  assert.equal(router.model, 'f', 'страж бюджета видит прежнюю модель');

  p.select('');
  assert.equal(p.client(), null);
  assert.equal((await router.chat({ messages: [] })).content, 'обычная');
});

test('без шифрования ключ не сохраняется; негодный адрес — отказ', () => {
  const file = path.join(tmp(), 'providers.json');
  const p = new OwnerProviders({ ownerBuild: true, file });
  assert.throws(() => p.save(local), /Шифрование/);
  assert.throws(() => p.save({ ...local, key: '', baseUrl: 'file:///c:/x' }), /http/);
  p.save({ ...local, key: '' });
  assert.equal(p.select('Дом').providers[0].hasKey, false);
  assert.equal(p.client().apiKey, 'none');
});

test('ядро создаёт провайдеров с флагом сборки, а не с настройкой', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /new OwnerProviders\(\{ ownerBuild: OWNER_BUILD,/);
  assert.match(main, /ipcMain\.handle\('owner:providers'[\s\S]{0,200}ownerProviders\[action\]/);
});
