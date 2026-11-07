'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResponseCache } = require('../src/cost/response-cache');

const args = { purpose: 'chat', toolChoice: 'none', messages: [{ role: 'user', content: 'Объясни закон сохранения энергии' }] };
const result = { content: 'Энергия не возникает из ничего.', reasoningContent: 'секретное рассуждение', toolCalls: [] };

test('кеширует точный текстовый ответ только короткое время', () => {
  let now = 1000;
  const cache = createResponseCache({ now: () => now, ttlMs: 2000 });
  assert.equal(cache.get(args, 'model-a'), null);
  assert.equal(cache.set(args, result, 'model-a'), true);
  assert.equal(cache.get(args, 'model-a').content, result.content);
  assert.equal(cache.get(args, 'model-b'), null);
  assert.equal(cache.get({ ...args, maxTokens: 100 }, 'model-a'), null);
  now += 2001;
  assert.equal(cache.get(args, 'model-a'), null);
});

test('не кеширует инструменты, потоковые или задачные запросы, картинки и отменённый ход', () => {
  const cache = createResponseCache();
  const excluded = [
    { ...args, toolChoice: 'auto' },
    { ...args, onDelta() {} },
    { ...args, purpose: 'task', taskId: 't1' },
    { ...args, taskBudgetUsd: 0.1, taskId: 't1' },
    { ...args, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] },
    { ...args, signal: AbortSignal.abort() },
  ];
  for (const request of excluded) assert.equal(cache.set(request, result, 'model-a'), false);
  assert.equal(cache.size, 0);
});

test('не кеширует пустой ответ, ответ с вызовом инструмента и ограничивает размер', () => {
  const cache = createResponseCache({ maxEntries: 2 });
  assert.equal(cache.set(args, { content: '', toolCalls: [] }, 'model-a'), false);
  assert.equal(cache.set(args, { content: 'идти', toolCalls: [{ name: 'app_open' }] }, 'model-a'), false);
  for (const text of ['один', 'два', 'три']) {
    const request = { ...args, messages: [{ role: 'user', content: text }] };
    cache.set(request, { content: text, toolCalls: [] }, 'model-a');
  }
  assert.equal(cache.size, 2);
  assert.equal(cache.get({ ...args, messages: [{ role: 'user', content: 'один' }] }, 'model-a'), null);
});
