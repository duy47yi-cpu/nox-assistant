'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../src/agent/loop');

test('в модель уходит только хвост разговора и он начинается с сообщения пользователя', async () => {
  const history = [];
  for (let i = 0; i < 40; i += 1) {
    history.push({ role: 'user', content: `вопрос ${i}` });
    history.push({ role: 'assistant', content: `ответ ${i}` });
  }
  let sent = null;
  const brain = {
    async chat({ messages }) {
      sent = messages;
      return { content: 'ок', reasoningContent: null, toolCalls: [] };
    },
  };
  const agent = new Agent({
    brain,
    tools: { list: () => [], get: () => undefined },
    journal: { append() {} },
    emit: () => {},
    mode: 'auto',
    systemPrompt: 'система',
    history,
    maxContext: 10,
  });
  await agent.run('последний');
  const nonSystem = sent.filter((m) => m.role !== 'system');
  assert.ok(nonSystem.length <= 11, `в запросе ${nonSystem.length} сообщений`);
  assert.equal(nonSystem[0].role, 'user');
  assert.equal(nonSystem[nonSystem.length - 1].content, 'последний');
});
