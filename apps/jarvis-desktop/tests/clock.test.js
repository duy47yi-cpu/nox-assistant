'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../src/agent/loop');

// Системное сообщение должно быть одинаковым от хода к ходу (кэш промпта), время — только в последнем сообщении пользователя.
test('время уходит в последнее сообщение пользователя, системный промпт не меняется, история не меняется', async () => {
  const calls = [];
  const brain = {
    async chat({ messages }) {
      calls.push(messages);
      return { content: 'ок', toolCalls: [] };
    },
  };
  let stamp = 'Сейчас: понедельник, 22:28';
  const agent = new Agent({
    brain, tools: { list: () => [], get: () => null }, journal: { append() {} }, emit() {},
    mode: 'full', systemPrompt: 'база промпта', clock: () => stamp,
  });
  await agent.run('который час?');
  stamp = 'Сейчас: понедельник, 22:31';
  await agent.run('а завтра?');

  const first = calls[0];
  const second = calls[1];
  assert.equal(first[0].content, 'база промпта');
  assert.equal(second[0].content, 'база промпта', 'системный промпт одинаков в обоих ходах');
  const lastUserFirst = first.filter((m) => m.role === 'user').pop();
  assert.equal(lastUserFirst.content, 'Сейчас: понедельник, 22:28\nкоторый час?');
  const lastUserSecond = second.filter((m) => m.role === 'user').pop();
  assert.equal(lastUserSecond.content, 'Сейчас: понедельник, 22:31\nа завтра?');
  assert.equal(agent.history.find((m) => m.content === 'который час?').content, 'который час?', 'в истории время не сохраняется');
});

test('без clock сообщение уходит как есть', async () => {
  let sent = null;
  const brain = { async chat({ messages }) { sent = messages; return { content: 'ок', toolCalls: [] }; } };
  const agent = new Agent({
    brain, tools: { list: () => [], get: () => null }, journal: { append() {} }, emit() {},
    mode: 'full', systemPrompt: 'база',
  });
  await agent.run('привет');
  assert.equal(sent.filter((m) => m.role === 'user').pop().content, 'привет');
});
