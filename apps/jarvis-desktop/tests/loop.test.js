'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent, MAX_TOOL_STEPS, coerceToolArgs } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const { StubBrain } = require('../src/brain/stub');

// Фейковый мозг: отдаёт ответы по сценарию по одному на каждый вызов chat().
function scriptedBrain(steps) {
  let i = 0;
  const brain = {
    calls: 0,
    async chat() {
      brain.calls += 1;
      const s = steps[i++];
      if (!s) throw new Error('сценарий закончился');
      return { content: s.content || '', reasoningContent: s.reasoningContent || null, toolCalls: s.toolCalls || [] };
    },
  };
  return brain;
}

function tool(name, risk, run) {
  return { name, risk, description: name, parameters: { type: 'object', properties: {} }, run };
}

function registry(...tools) {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register(t);
  return reg;
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJournal(dir) {
  const file = path.join(dir, 'journal.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

// Событие в коротком виде: 'status:thinking' или тип события.
const kind = (e) => (e.type === 'status' ? `status:${e.state}` : e.type);

test('инструмент, затем текст: события, журнал и история', async (t) => {
  const dir = setup(t);
  const events = [];
  let runs = 0;
  const brain = scriptedBrain([
    { reasoningContent: 'думаю', toolCalls: [{ id: 't1', name: 'echo', args: { text: 'hi' } }] },
    { content: 'Готово' },
  ]);
  const agent = new Agent({
    brain,
    tools: registry(tool('echo', 'T0', async (args) => {
      runs += 1;
      return { ok: true, summary: `эхо: ${args.text}`, data: args };
    })),
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'auto',
    workspace: dir,
  });

  await agent.run('привет');

  assert.equal(runs, 1);
  assert.deepEqual(events.map(kind), [
    'status:thinking', 'tool_start', 'status:acting', 'tool_result',
    'status:thinking', 'text', 'done', 'status:idle',
  ]);
  assert.equal(events.find((e) => e.type === 'text').delta, 'Готово');
  // Поля прогресса добавлены к действующему событию (подробный контракт — tests/progress-contract.test.js).
  const resultEvent = events.find((e) => e.type === 'tool_result');
  assert.equal(resultEvent.type, 'tool_result');
  assert.equal(resultEvent.id, 't1');
  assert.equal(resultEvent.ok, true);
  assert.equal(resultEvent.summary, 'эхо: hi');
  assert.equal(resultEvent.step, 1);
  assert.equal(resultEvent.status, 'succeeded');
  assert.equal(typeof resultEvent.runId, 'string');

  const [entry] = readJournal(dir);
  assert.equal(entry.tool, 'echo');
  assert.equal(entry.risk, 'T0');
  assert.equal(entry.mode, 'auto');
  assert.equal(entry.decision, 'allow');
  assert.equal(entry.ok, true);
  assert.equal(entry.summary, 'эхо: hi');
  assert.ok(entry.ts);

  // reasoning_content сохранён в assistant-сообщении, tool-ответ привязан к tool_call_id
  const [user, assistant, toolMsg] = agent.history;
  assert.equal(user.role, 'user');
  assert.equal(assistant.reasoning_content, 'думаю');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"text":"hi"}');
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 't1');
  assert.equal(JSON.parse(toolMsg.content).ok, true);
});

test('отказ по approval: инструмент не запускается, в журнале reject', async (t) => {
  const dir = setup(t);
  const events = [];
  let runs = 0;
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });
  const brain = scriptedBrain([
    { toolCalls: [{ id: 'w1', name: 'write', args: {} }] },
    { content: 'понял' },
  ]);
  const agent = new Agent({
    brain,
    tools: registry(tool('write', 'T2', async () => {
      runs += 1;
      return { ok: true, summary: 'записано' };
    })),
    approvals,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_request') approvals.respond(e.id, 'reject');
    },
    mode: 'auto',
    workspace: dir,
  });

  await agent.run('запиши');

  assert.equal(runs, 0);
  assert.ok(events.some((e) => e.type === 'approval_request' && e.name === 'write' && e.risk === 'T2'));
  assert.ok(events.some((e) => kind(e) === 'status:waiting_approval'));
  assert.deepEqual(
    events.filter((e) => e.type === 'tool_result').map((e) => [e.ok, e.summary]),
    [[false, 'отклонено']],
  );
  assert.equal(readJournal(dir)[0].decision, 'reject');
  assert.equal(events.at(-1).state, 'idle');
});

test('approval_request использует id вызова: UI не заводит вторую запись истории', async (t) => {
  const dir = setup(t);
  const events = [];
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });
  const brain = scriptedBrain([
    { toolCalls: [{ id: 'call-42', name: 'write', args: {} }] },
    { content: 'готово' },
  ]);
  const agent = new Agent({
    brain,
    tools: registry(tool('write', 'T2', async () => ({ ok: true, summary: 'записано' }))),
    approvals,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_request') approvals.respond(e.id, 'once');
    },
    mode: 'auto',
    workspace: dir,
  });

  await agent.run('запиши');

  const start = events.find((e) => e.type === 'tool_start');
  const request = events.find((e) => e.type === 'approval_request');
  assert.equal(start.id, 'call-42');
  assert.equal(request.id, 'call-42');
});

test('session: второй вызов того же инструмента не спрашивает снова', async (t) => {
  const dir = setup(t);
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });
  let asks = 0;
  let runs = 0;
  const brain = scriptedBrain([
    { toolCalls: [{ id: 'a', name: 'write', args: {} }] },
    { content: 'первый' },
    { toolCalls: [{ id: 'b', name: 'write', args: {} }] },
    { content: 'второй' },
  ]);
  const agent = new Agent({
    brain,
    tools: registry(tool('write', 'T2', async () => {
      runs += 1;
      return { ok: true, summary: 'записано' };
    })),
    approvals,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      if (e.type === 'approval_request') {
        asks += 1;
        approvals.respond(e.id, 'session');
      }
    },
    mode: 'auto',
    workspace: dir,
  });

  await agent.run('один');
  await agent.run('два');

  assert.equal(asks, 1);
  assert.equal(runs, 2);
  assert.deepEqual(readJournal(dir).map((e) => e.decision), ['session', 'allow']);
});

test('ошибка инструмента и неизвестный инструмент не роняют цикл', async (t) => {
  const dir = setup(t);
  const events = [];
  const brain = scriptedBrain([
    {
      toolCalls: [
        { id: 'e1', name: 'boom', args: {} },
        { id: 'e2', name: 'nope', args: {} },
      ],
    },
    { content: 'держусь' },
  ]);
  const agent = new Agent({
    brain,
    tools: registry(tool('boom', 'T0', async () => { throw new Error('упал'); })),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'auto',
    workspace: dir,
  });

  await agent.run('проверка');

  const results = events.filter((e) => e.type === 'tool_result');
  assert.deepEqual(results.map((r) => [r.id, r.ok, r.summary]), [
    ['e1', false, 'ошибка: упал'],
    ['e2', false, 'неизвестный инструмент: nope'],
  ]);
  assert.equal(events.at(-2).type, 'done');
  assert.deepEqual(readJournal(dir).map((e) => e.ok), [false, false]);
  assert.equal(agent.history.filter((m) => m.role === 'tool').length, 2);
});

test('лимит шагов: цикл останавливается, все tool_call получают ответ', async (t) => {
  const dir = setup(t);
  const events = [];
  let runs = 0;
  let n = 0;
  const brain = {
    calls: 0,
    async chat() {
      brain.calls += 1;
      n += 1;
      return { content: '', reasoningContent: null, toolCalls: [{ id: `s${n}`, name: 'echo', args: { i: n } }] };
    },
  };
  const agent = new Agent({
    brain,
    tools: registry(tool('echo', 'T0', async () => {
      runs += 1;
      return { ok: true, summary: 'ок' };
    })),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'full',
    workspace: dir,
  });

  await agent.run('бесконечно');

  assert.equal(runs, MAX_TOOL_STEPS);
  assert.equal(brain.calls, MAX_TOOL_STEPS + 1);
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.match(text, new RegExp(`лимит шагов инструментов \\(${MAX_TOOL_STEPS}\\)`));
  assert.equal(events.at(-2).type, 'done');
  // на каждый tool_call в истории есть ответ role 'tool'
  const assistants = agent.history.filter((m) => m.role === 'assistant');
  assert.equal(agent.history.filter((m) => m.role === 'tool').length, assistants.length);
});

test('stop(): прерывает signal, отправляет done и не даёт ошибку', async (t) => {
  const dir = setup(t);
  const events = [];
  let seenSignal = null;
  const brain = {
    chat({ signal }) {
      seenSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
  };
  const agent = new Agent({
    brain,
    tools: registry(),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'auto',
    workspace: dir,
  });

  const pending = agent.run('долгий ход');
  agent.stop();
  await pending;

  assert.equal(seenSignal.aborted, true);
  assert.deepEqual(events.map(kind), ['status:thinking', 'done', 'status:idle']);
});

test('ошибка мозга → error с сообщением, статус error, done', async (t) => {
  const dir = setup(t);
  const events = [];
  const brain = { async chat() { throw new Error('сеть недоступна'); } };
  const agent = new Agent({
    brain,
    tools: registry(),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'auto',
    workspace: dir,
  });

  await agent.run('привет');

  assert.deepEqual(events.map(kind), ['status:thinking', 'error', 'status:error', 'done']);
  assert.equal(events[1].message, 'сеть недоступна');
});

test('заглушка без ключа отвечает текстом без инструментов', async (t) => {
  const dir = setup(t);
  const events = [];
  const agent = new Agent({
    brain: new StubBrain(),
    tools: registry(tool('echo', 'T0', async () => ({ ok: true, summary: '' }))),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'auto',
    workspace: dir,
  });

  await agent.run('привет');

  assert.deepEqual(events.map(kind), ['status:thinking', 'text', 'done', 'status:idle']);
  assert.match(events[1].delta, /не подключён к модели/);
});

test('coerceToolArgs: приводит типы по схеме инструмента и обрезает пробелы в путях', async (t) => {
  assert.equal(typeof coerceToolArgs, 'function');
  const dir = setup(t);
  let receivedArgs = null;
  const customTool = {
    name: 'custom_write',
    risk: 'T0',
    description: 'test',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        minutes: { type: 'integer' },
        ratio: { type: 'number' },
        overwrite: { type: 'boolean' },
        content: { type: 'string' },
      },
    },
    async run(args) {
      receivedArgs = args;
      return { ok: true, summary: 'записано' };
    },
  };
  const brain = scriptedBrain([
    {
      toolCalls: [{
        id: 'cw1',
        name: 'custom_write',
        args: {
          path: ['  notes/todo.md  '],
          minutes: '15',
          ratio: '2.5',
          overwrite: 'true',
          content: '  сохранить пробелы  ',
        },
      }],
    },
    { content: 'Готово' },
  ]);
  const agent = new Agent({
    brain,
    tools: registry(customTool),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    mode: 'auto',
    workspace: dir,
  });

  await agent.run('запиши');

  assert.deepEqual(receivedArgs, {
    path: 'notes/todo.md',
    minutes: 15,
    ratio: 2.5,
    overwrite: true,
    content: '  сохранить пробелы  ',
  });
});
