'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DeepSeekClient, repairJsonStringLiterals } = require('../src/brain/deepseek');

// Фейковый fetch: записывает вызовы и отдаёт заданный статус и тело.
function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

const VOLUME_TOOL = { type: 'function', function: { name: 'volume_set', parameters: { type: 'object' } } };

test('без ключа сетевой запрос не делается, code=no_key', async () => {
  let called = false;
  const client = new DeepSeekClient({
    baseUrl: 'https://api.example/v1',
    apiKey: '',
    model: 'm',
    fetchImpl: async () => { called = true; },
  });
  await assert.rejects(client.chat({ messages: [] }), (err) => err.code === 'no_key');
  assert.equal(called, false);
});

test('разбор tool_calls и reasoning_content; tools и tool_choice уходят в запросе', async () => {
  const fetchImpl = fakeFetch(200, {
    choices: [{
      message: {
        content: null,
        reasoning_content: 'думаю',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'volume_set', arguments: '{"level":30}' } }],
      },
    }],
  });
  const client = new DeepSeekClient({ baseUrl: 'https://api.example/v1/', apiKey: 'k', model: 'm', fetchImpl });

  const res = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [VOLUME_TOOL] });

  assert.equal(fetchImpl.calls[0].url, 'https://api.example/v1/chat/completions');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.model, 'm');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.tools.length, 1);
  assert.deepEqual(res, {
    content: '',
    reasoningContent: 'думаю',
    toolCalls: [{ id: 'c1', name: 'volume_set', args: { level: 30 }, argsError: null }],
  });
});

test('пустой список инструментов не отправляется', async () => {
  const fetchImpl = fakeFetch(200, { choices: [{ message: { content: 'ok' } }] });
  const client = new DeepSeekClient({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm', fetchImpl });
  const res = await client.chat({ messages: [], tools: [] });
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal('tools' in body, false);
  assert.equal(res.content, 'ok');
  assert.equal(res.reasoningContent, null);
});

test('битый JSON в аргументах даёт argsError, а не исключение', async () => {
  const fetchImpl = fakeFetch(200, {
    choices: [{ message: { content: '', tool_calls: [{ id: 'c2', function: { name: 'volume_set', arguments: '{bad' } }] } }],
  });
  const client = new DeepSeekClient({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm', fetchImpl });
  const res = await client.chat({ messages: [] });
  assert.equal(res.toolCalls[0].args, null);
  assert.ok(res.toolCalls[0].argsError);
});

test('repairJsonStringLiterals: чинит пути Windows, переводы строк и неэкранированные кавычки в аргументах', async () => {
  assert.equal(typeof repairJsonStringLiterals, 'function');
  const rawWinPath = '{"path":"C:\\Users\\admin\\todo.md","text":"первая строка\nвторая"}';
  const rawInnerQuotes = '{"window":"Блокнот","name":"кнопка "Сохранить" сейчас"}';
  const fetchImpl = fakeFetch(200, {
    choices: [{
      message: {
        content: '',
        tool_calls: [
          { id: 'c_win', function: { name: 'workspace_write', arguments: rawWinPath } },
          { id: 'c_q', function: { name: 'ui_click', arguments: rawInnerQuotes } },
        ],
      },
    }],
  });
  const client = new DeepSeekClient({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm', fetchImpl });
  const res = await client.chat({ messages: [] });
  assert.equal(res.toolCalls[0].argsError, null);
  assert.deepEqual(res.toolCalls[0].args, {
    path: 'C:\\Users\\admin\\todo.md',
    text: 'первая строка\nвторая',
  });
  assert.equal(res.toolCalls[1].argsError, null);
  assert.deepEqual(res.toolCalls[1].args, {
    window: 'Блокнот',
    name: 'кнопка "Сохранить" сейчас',
  });
});

test('HTTP-ошибка → code=http и статус', async () => {
  const fetchImpl = fakeFetch(400, { error: { message: 'bad request' } });
  const client = new DeepSeekClient({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm', fetchImpl });
  await assert.rejects(client.chat({ messages: [] }), (err) => err.code === 'http' && err.status === 400);
});

test('таймаут → code=timeout', async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const client = new DeepSeekClient({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm', timeoutMs: 20, fetchImpl: hang });
  await assert.rejects(client.chat({ messages: [] }), (err) => err.code === 'timeout');
});

test('отмена через signal → AbortError', async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const controller = new AbortController();
  const client = new DeepSeekClient({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm', fetchImpl: hang });
  const pending = client.chat({ messages: [], signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
});
