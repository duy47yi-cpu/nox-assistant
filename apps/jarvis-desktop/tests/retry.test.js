'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DeepSeekClient } = require('../src/brain/deepseek');

const OK_BODY = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ок' } }] });

test('сетевой сбой (fetch failed) повторяется один раз и запрос проходит', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return { ok: true, status: 200, text: async () => OK_BODY };
  };
  const client = new DeepSeekClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', fetchImpl, timeoutMs: 5000 });
  const res = await client.chat({ messages: [{ role: 'user', content: 'привет' }] });
  assert.equal(calls, 2);
  assert.equal(res.content, 'ок');
});

test('если сбой повторился, ошибка уходит наверх', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new TypeError('fetch failed'); };
  const client = new DeepSeekClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', fetchImpl, timeoutMs: 5000 });
  await assert.rejects(client.chat({ messages: [{ role: 'user', content: 'привет' }] }), /fetch failed/);
  assert.equal(calls, 2);
});
