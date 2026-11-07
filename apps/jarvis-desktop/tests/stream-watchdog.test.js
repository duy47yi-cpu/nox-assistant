'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DeepSeekClient } = require('../src/brain/deepseek');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

const hang = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
const sse = (parts) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'text/event-stream' },
  body: parts,
});
const chunk = (text) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
const end = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
const client = (fetchImpl) => new DeepSeekClient({ baseUrl: 'http://x', apiKey: 'k', model: 'm', fetchImpl, firstByteMs: 30, streamIdleMs: 40 });
const ask = (c, deltas) => c.chat({ messages: [], onDelta: (d) => deltas.push(d) });

test('зависший запрос повторяется один раз и отвечает', async () => {
  let calls = 0;
  const deltas = [];
  const c = client(async (_u, o) => {
    calls += 1;
    if (calls === 1) return hang(o.signal);
    return sse((async function* () { yield chunk('привет'); yield end; })());
  });
  const res = await ask(c, deltas);
  assert.equal(calls, 2);
  assert.equal(res.content, 'привет');
});

test('поток встал посреди текста: ошибка, без повтора и дубля', async () => {
  let calls = 0;
  let aborted;
  const c = client(async (_u, o) => {
    calls += 1;
    return sse((async function* () { yield chunk('нача'); await hang(o.signal).catch((e) => { aborted = e; throw e; }); })());
  });
  await assert.rejects(ask(c, []), /перестала отвечать/);
  assert.equal(calls, 1);
  assert.ok(aborted);
});

test('длинный поток не обрывается, пока части идут', async () => {
  const c = client(async () => sse((async function* () {
    for (let i = 0; i < 6; i += 1) { await new Promise((r) => setTimeout(r, 15)); yield chunk('я'); }
    yield end;
  })()));
  const res = await ask(c, []);
  assert.equal(res.content, 'яяяяяя');
});

test('прогрев: один токен, без следа в истории, ход не мешает', async () => {
  const seen = [];
  const agent = new Agent({ brain: { chat: async (a) => { seen.push(a); return { content: '', toolCalls: [] }; } }, tools: new ToolRegistry(), journal: { append: () => {} }, systemPrompt: () => 'промпт' });
  assert.equal(await agent.warm(), true);
  assert.equal(seen[0].maxTokens, 1);
  assert.equal(seen[0].messages[0].content, 'промпт');
  assert.equal(agent.history.length, 0);
});

test('сбой прогрева не роняет ничего', async () => {
  const agent = new Agent({ brain: { chat: async () => { throw new Error('нет сети'); } }, tools: new ToolRegistry(), journal: { append: () => {} } });
  assert.equal(await agent.warm(), false);
});

test('служебная разметка модели не попадает в ответ', async () => {
  const body = JSON.stringify({ choices: [{ message: { content: 'Пишу файл.\n]<]minimax[>[<tool_call>\n]<]minimax[>[<invoke_x>\n<]minimax[>[<query>секретный запрос]<]minimax[>[</query>\n]<]minimax[>[</tool_call>\nГотово.' } }] });
  const c = new DeepSeekClient({ baseUrl: 'http://x', apiKey: 'k', model: 'm', fetchImpl: async () => new Response(body, { status: 200 }) });
  const res = await c.chat({ messages: [] });
  assert.doesNotMatch(res.content, /minimax|запрос/);
  assert.match(res.content, /Готово/);
  assert.match(res.content, /Пишу файл/);
});

test('обрезанный потолком вызов объясняет, что делать', async () => {
  const body = JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '', tool_calls: [{ id: '1', function: { name: 'workspace_write', arguments: '{"path":"a.md","content":"длинн' } }] } }] });
  const c = new DeepSeekClient({ baseUrl: 'http://x', apiKey: 'k', model: 'm', fetchImpl: async () => new Response(body, { status: 200 }) });
  const res = await c.chat({ messages: [] });
  assert.match(res.toolCalls[0].argsError, /на части/);
});
