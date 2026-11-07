'use strict';

// Скорость и защита от зацикливания: размер контекста, повторы вызовов, журнал turns.jsonl,
// отключение размышлений в клиенте DeepSeek.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent, MAX_REPEATS } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { DeepSeekClient } = require('../src/brain/deepseek');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-speed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function registry(...tools) {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register(t);
  return reg;
}

function echoTool(onRun) {
  return {
    name: 'echo',
    risk: 'T0',
    description: 'echo',
    parameters: { type: 'object', properties: {} },
    async run(args) {
      onRun(args);
      return { ok: true, summary: 'ок', data: { text: 'x'.repeat(5000) } };
    },
  };
}

function agentWith(brain, extra = {}) {
  return new Agent({
    brain,
    tools: registry(echoTool(() => {})),
    journal: { append() {} },
    emit: () => {},
    mode: 'full',
    systemPrompt: 'система',
    ...extra,
  });
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('в запрос уходит не больше maxContext сообщений и на каждом шаге хода', async () => {
  const history = [];
  for (let i = 0; i < 30; i += 1) {
    history.push({ role: 'user', content: `вопрос ${i}` });
    history.push({ role: 'assistant', content: `ответ ${i}` });
  }
  const sizes = [];
  let n = 0;
  const brain = {
    async chat({ messages }) {
      sizes.push(messages.filter((m) => m.role !== 'system').length);
      n += 1;
      // Длинный ход: 11 шагов по инструменту, чтобы текущий ход сам перерос окно.
      if (n <= 11) return { content: '', toolCalls: [{ id: `c${n}`, name: 'echo', args: { i: n } }] };
      return { content: 'готово', toolCalls: [] };
    },
  };
  const agent = agentWith(brain, { history, maxContext: 8 });
  await agent.run('последний');
  assert.ok(sizes.length > 1);
  for (const s of sizes) assert.ok(s <= 8, `в запросе ${s} сообщений при maxContext 8`);
});

test('по умолчанию в запрос уходит до 60 сообщений разговора, а не 30', async () => {
  assert.equal(new Agent({}).maxContext, 60);
  const history = [];
  for (let i = 0; i < 50; i += 1) {
    history.push({ role: 'user', content: `вопрос ${i}` });
    history.push({ role: 'assistant', content: `ответ ${i}` });
  }
  let sent = 0;
  const brain = {
    async chat({ messages }) {
      sent = messages.filter((m) => m.role !== 'system').length;
      return { content: 'ок', toolCalls: [] };
    },
  };
  await agentWith(brain, { history }).run('последний');
  assert.ok(sent > 30, `в запросе ${sent} сообщений, ждали больше 30`);
  assert.ok(sent <= 60, `в запросе ${sent} сообщений, ждали не больше 60`);
});

test('ответ без модели (музыка) попадает в историю: на «да, поставь» модель видит название трека', async () => {
  let messages = [];
  const brain = {
    async chat(args) {
      messages = args.messages;
      return { content: 'ок', toolCalls: [] };
    },
  };
  const agent = agentWith(brain);
  agent.remember('поставь музыку "Ай балам"', 'Открыл поиск «ай балам» в YouTube.');
  await agent.run('да, поставь');
  const text = messages.map((m) => String(m.content || '')).join('\n');
  assert.ok(text.includes('Ай балам'), 'название трека должно быть в запросе модели');
});

test('если ход длиннее окна, в запросе остаётся вопрос пользователя и пары вызов-ответ не рвутся', async () => {
  let last = null;
  let n = 0;
  const brain = {
    async chat({ messages }) {
      last = messages;
      n += 1;
      if (n <= 10) return { content: '', toolCalls: [{ id: `c${n}`, name: 'echo', args: { i: n } }] };
      return { content: 'готово', toolCalls: [] };
    },
  };
  const agent = agentWith(brain, { maxContext: 6 });
  await agent.run('сделай много шагов');
  const body = last.filter((m) => m.role !== 'system');
  assert.ok(body.length <= 6);
  assert.equal(body[0].role, 'user');
  assert.equal(body[0].content, 'сделай много шагов');
  assert.equal(body[1].role, 'assistant');
  // каждый ответ инструмента идёт после своего вызова
  const known = new Set();
  for (const m of body) {
    if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls) known.add(c.id);
    if (m.role === 'tool') assert.ok(known.has(m.tool_call_id), `ответ ${m.tool_call_id} без вызова`);
  }
});

test('одинаковый вызов подряд выполняется не больше двух раз, потом модель отвечает без инструментов', async () => {
  let runs = 0;
  const choices = [];
  const brain = {
    calls: 0,
    async chat({ toolChoice }) {
      brain.calls += 1;
      choices.push(toolChoice || 'auto');
      if (toolChoice === 'none') return { content: 'Сделал что мог.', toolCalls: [] };
      // модель упорно повторяет один и тот же вызов (ключи в разном порядке — это тот же вызов)
      const args = brain.calls % 2 ? { a: 1, b: 2 } : { b: 2, a: 1 };
      return { content: '', toolCalls: [{ id: `r${brain.calls}`, name: 'echo', args }] };
    },
  };
  const events = [];
  const agent = new Agent({
    brain,
    tools: registry(echoTool(() => { runs += 1; })),
    journal: { append() {} },
    emit: (e) => events.push(e),
    mode: 'full',
  });
  await agent.run('зациклись');
  assert.equal(runs, MAX_REPEATS);
  assert.equal(MAX_REPEATS, 2);
  // 2 выполнения + 1 отказ-повтор, затем один запрос без инструментов
  assert.equal(brain.calls, 4);
  assert.deepEqual(choices, ['auto', 'auto', 'auto', 'none']);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Сделал что мог.');
  assert.equal(events.at(-2).type, 'done');
});

test('если модель и без инструментов просит вызов, он не выполняется, а владелец получает ответ', async () => {
  let runs = 0;
  const brain = {
    async chat() {
      return { content: '', toolCalls: [{ id: `x${Math.random()}`, name: 'echo', args: {} }] };
    },
  };
  const events = [];
  const agent = new Agent({
    brain,
    tools: registry(echoTool(() => { runs += 1; })),
    journal: { append() {} },
    emit: (e) => events.push(e),
    mode: 'full',
  });
  await agent.run('зациклись');
  assert.equal(runs, 2);
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.match(text, /Не получилось/);
  // в истории нет вызова без ответа
  const ids = agent.history.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
  const answered = new Set(agent.history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (const id of ids) assert.ok(answered.has(id));
});

test('прошлые ходы уходят сжатыми: без размышлений ответа и без длинных выводов инструментов', async () => {
  const history = [
    { role: 'user', content: 'раньше' },
    { role: 'assistant', content: null, reasoning_content: 'р'.repeat(3000), tool_calls: [{ id: 'o1', type: 'function', function: { name: 'echo', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'o1', content: 'y'.repeat(5000) },
    { role: 'assistant', content: 'было', reasoning_content: 'долгие мысли' },
  ];
  let sent = null;
  const brain = { async chat({ messages }) { sent = messages; return { content: 'ок', toolCalls: [] }; } };
  const agent = agentWith(brain, { history });
  await agent.run('сейчас');
  const [, oldCall, oldTool, oldAnswer] = sent.filter((m) => m.role !== 'system');
  assert.ok(oldCall.reasoning_content.length <= 200, 'у вызова размышления укорочены, но есть');
  assert.ok(oldTool.content.length < 1600);
  assert.equal('reasoning_content' in oldAnswer, false);
  // история в памяти не меняется
  assert.equal(agent.history[1].reasoning_content.length, 3000);
  assert.equal(agent.history[2].content.length, 5000);
});

test('журнал turns.jsonl пишется, если указан путь: модель, инструменты, итог хода', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data', 'turns.jsonl');
  let n = 0;
  const brain = {
    async chat() {
      n += 1;
      if (n === 1) {
        const res = { content: '', reasoningContent: 'думаю', toolCalls: [{ id: 'a', name: 'echo', args: { q: 1 } }, { id: 'b', name: 'echo', args: { q: 2 } }] };
        Object.defineProperty(res, 'stats', { value: { ms: 5, promptTokens: 100, completionTokens: 10, requestChars: 999 }, enumerable: false });
        return res;
      }
      return { content: 'готово', toolCalls: [] };
    },
  };
  const agent = agentWith(brain, { turnsLog: file });
  await agent.run('привет');

  const lines = readLines(file);
  const models = lines.filter((l) => l.kind === 'model');
  const tools = lines.filter((l) => l.kind === 'tool');
  const turns = lines.filter((l) => l.kind === 'turn');
  assert.equal(models.length, 2);
  assert.equal(tools.length, 2);
  assert.equal(turns.length, 1);
  assert.ok(lines.every((l) => l.ts && l.turn === turns[0].turn));
  assert.equal(models[0].messages, 2); // system + user
  assert.equal(models[0].tools, 1);
  assert.equal(models[0].promptTokens, 100);
  assert.equal(models[0].requestChars, 999);
  assert.equal(models[0].reasoningChars, 5);
  assert.deepEqual(models[0].toolCalls, ['echo', 'echo']);
  assert.ok(Number.isFinite(models[0].ms));
  assert.ok(tools.every((x) => x.name === 'echo' && x.ok === true && Number.isFinite(x.ms)));
  const turn = turns[0];
  assert.equal(turn.outcome, 'answer');
  assert.equal(turn.modelCalls, 2);
  assert.equal(turn.toolCalls, 2);
  assert.equal(turn.promptTokens, 100);
  assert.equal(turn.answerChars, 'готово'.length);
  assert.ok(Number.isFinite(turn.ms) && turn.ms >= 0);
  // в журнал не попадают тексты сообщений и аргументы
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('привет'));
  assert.ok(!raw.includes('"q"'));
});

test('без пути журнал не пишется', async (t) => {
  const dir = tmpDir(t);
  const brain = { async chat() { return { content: 'ок', toolCalls: [] }; } };
  const agent = agentWith(brain);
  await agent.run('привет');
  assert.equal(agent.turnLog.enabled, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ошибка модели тоже попадает в журнал с итогом error', async (t) => {
  const file = path.join(tmpDir(t), 'turns.jsonl');
  const brain = { async chat() { throw Object.assign(new Error('сеть'), { code: 'timeout' }); } };
  const agent = agentWith(brain, { turnsLog: file });
  await agent.run('привет');
  const lines = readLines(file);
  assert.equal(lines[0].kind, 'model');
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].error, 'timeout');
  assert.equal(lines[1].outcome, 'error');
});

// --- клиент DeepSeek ---

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    const text = JSON.stringify(r.body);
    return { ok: r.status < 300, status: r.status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

const OK = {
  status: 200,
  body: {
    choices: [{ message: { content: 'готов', reasoning_content: 'мысль' } }],
    usage: { prompt_tokens: 42, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } },
  },
};

test('DeepSeek: по умолчанию поля размышлений не отправляются, замеры есть в stats', async () => {
  const fetchImpl = fakeFetch([OK]);
  const client = new DeepSeekClient({ baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'k', model: 'm', fetchImpl });
  const res = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
  const body = fetchImpl.calls[0];
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model']);
  assert.equal(res.stats.reasoning, 'default');
  assert.equal(res.stats.promptTokens, 42);
  assert.equal(res.stats.reasoningTokens, 2);
  assert.equal(res.stats.reasoningChars, 'мысль'.length);
  assert.equal(res.stats.messages, 1);
  assert.ok(Number.isFinite(res.stats.ms));
  assert.equal(Object.keys(res).includes('stats'), false, 'stats не перечисляется');
});

test('DeepSeek: reasoning=off отправляет поля отключения; tool_choice none передаётся', async () => {
  const fetchImpl = fakeFetch([OK]);
  const client = new DeepSeekClient({ baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'k', model: 'm', fetchImpl, reasoning: 'off' });
  const tools = [{ type: 'function', function: { name: 'x', parameters: { type: 'object' } } }];
  const res = await client.chat({ messages: [], tools, toolChoice: 'none' });
  const body = fetchImpl.calls[0];
  assert.equal(body.reasoning_effort, 'none');
  assert.deepEqual(body.chat_template_kwargs, { thinking: false });
  assert.equal(body.tool_choice, 'none');
  assert.equal(res.stats.reasoning, 'off');

  const official = fakeFetch([OK]);
  await new DeepSeekClient({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm', fetchImpl: official, reasoning: 'off' })
    .chat({ messages: [] });
  assert.deepEqual(official.calls[0].thinking, { type: 'disabled' });
});

test('DeepSeek: если провайдер отверг отключение размышлений (400), повтор без полей и больше их не шлём', async () => {
  const fetchImpl = fakeFetch([{ status: 400, body: { error: { message: 'unknown field' } } }, OK, OK]);
  const client = new DeepSeekClient({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm', fetchImpl, reasoning: 'off' });
  const first = await client.chat({ messages: [] });
  assert.equal(first.content, 'готов');
  assert.equal(first.stats.reasoning, 'off-rejected');
  assert.equal('reasoning_effort' in fetchImpl.calls[1], false);
  await client.chat({ messages: [] });
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal('reasoning_effort' in fetchImpl.calls[2], false);
});

test('NOX_BRAIN_REASONING читается через makeConfig и включает режим off', () => {
  const { makeConfig } = require('../src/config/env');
  const before = process.env.NOX_BRAIN_REASONING;
  process.env.NOX_BRAIN_REASONING = 'off';
  try {
    // папка без .env: значение берётся из переменной окружения
    const cfg = makeConfig(os.tmpdir());
    const client = new DeepSeekClient({ apiKey: 'k', reasoning: cfg('NOX_BRAIN_REASONING') });
    assert.equal(client.reasoning, 'off');
  } finally {
    if (before === undefined) delete process.env.NOX_BRAIN_REASONING;
    else process.env.NOX_BRAIN_REASONING = before;
  }
  assert.equal(new DeepSeekClient({ apiKey: 'k' }).reasoning, 'default');
});
