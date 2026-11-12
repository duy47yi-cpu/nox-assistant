'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRouter } = require('../src/brain/tiers');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('свои провайдеры и ключи удалены из окна, моста и ядра', () => {
  for (const file of ['renderer/index.html', 'renderer/app.js', 'preload.js', 'main.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /ownerProviders|owner:providers|OwnerProviders|OWNER_BUILD|ownerProv/i, file);
  }
  for (const file of ['src/brain/providers.js', 'src/config/build.js', 'scripts/build-owner.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), false, `${file} удалён`);
  }
});

test('маршрут модели не содержит обхода через своего провайдера', async () => {
  const source = read('src/brain/tiers.js');
  assert.doesNotMatch(source, /override|owner|провайдер владельца/i);
  const fast = { model: 'f', calls: [], async chat(args) { this.calls.push(args); return { content: 'fast' }; } };
  const smart = { model: 's', calls: [], async chat(args) { this.calls.push(args); return { content: 'smart' }; } };
  const router = createRouter({ clients: { fast, smart }, getSettings: () => ({ modelTier: 'smart', thinking: 'high' }) });
  assert.equal((await router.chat({})).content, 'smart');
  assert.equal(smart.calls[0].levelFields.reasoning_effort, 'high');
  assert.notDeepEqual(router.cacheScope({ tier: 'fast' }), router.cacheScope({ tier: 'smart' }));
});
