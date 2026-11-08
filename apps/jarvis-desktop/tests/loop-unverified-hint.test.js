'use strict';

// Честная память шага (идея Browser Use): счётчик подряд неподтверждённых действий.
// После двух таких шагов в контекст текущего хода добавляется подсказка: не повторять вслепую.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

// Действие с настраиваемой проверкой: статус зависит от номера вызова.
function setup(statusForCall) {
  const tools = new ToolRegistry();
  let n = 0;
  tools.register({
    name: 'act',
    risk: 'T1',
    description: 'действие',
    parameters: { type: 'object', properties: { n: { type: 'number' } } },
    run: async () => ({ ok: true, summary: 'сделал', data: {} }),
    verify: async (args) => ({ status: statusForCall(args.n), evidence: 'проверка результата' }),
  });
  const seen = [];
  const brain = {
    chat: async ({ messages }) => {
      seen.push(messages);
      n += 1;
      if (n <= 2) return { content: '', toolCalls: [{ id: `c${n}`, name: 'act', args: { n } }] };
      return { content: 'готово', toolCalls: [] };
    },
  };
  const agent = new Agent({
    brain,
    tools,
    policy: () => 'allow',
    journal: { append: () => {} },
    emit: () => {},
    mode: 'full',
    workspace: process.cwd(),
  });
  return { agent, seen };
}

const lastUser = (messages) => messages.filter((m) => m.role === 'user').at(-1);
const textOf = (message) => String((message && message.content) || '');

test('два неподтверждённых действия подряд — в контексте подсказка не повторять вслепую', async () => {
  const { agent, seen } = setup(() => 'unknown');
  await agent.run('сделай');
  const context = textOf(lastUser(seen.at(-1)));
  assert.match(context, /не подтверждено шагов: 2/i);
  assert.match(context, /прочитай состояние/i);
  assert.match(context, /смени способ/i);
});

test('подтверждённые действия подсказку не включают', async () => {
  const { agent, seen } = setup(() => 'confirmed');
  await agent.run('сделай');
  assert.doesNotMatch(textOf(lastUser(seen.at(-1))), /не подтверждено шагов/i);
});

test('подтверждённое действие сбрасывает серию', async () => {
  const { agent, seen } = setup((n) => (n === 1 ? 'unknown' : 'confirmed'));
  await agent.run('сделай');
  assert.doesNotMatch(textOf(lastUser(seen.at(-1))), /не подтверждено шагов/i);
});
