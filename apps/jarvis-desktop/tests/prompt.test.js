'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withClock } = require('../src/agent/prompt');
const { Agent } = require('../src/agent/loop');

test('withClock добавляет текущее время к промпту', () => {
  const fixed = new Date('2026-10-27T09:15:00');
  const text = withClock('База', () => fixed)();
  assert.ok(text.startsWith('База'));
  assert.ok(text.includes('Сейчас:'));
  assert.ok(text.includes('2026'));
});

test('Agent вызывает функцию промпта на каждом ходу и передаёт текст мозгу', async () => {
  let calls = 0;
  const seen = [];
  const brain = {
    async chat({ messages }) {
      seen.push(messages[0]);
      return { content: 'ок', reasoningContent: null, toolCalls: [] };
    },
  };
  const agent = new Agent({
    brain,
    tools: { list: () => [], get: () => undefined },
    journal: { append() {} },
    emit: () => {},
    mode: 'auto',
    systemPrompt: () => {
      calls += 1;
      return `промпт ${calls}`;
    },
  });
  await agent.run('один');
  await agent.run('два');
  assert.equal(calls, 2);
  assert.deepEqual(seen.map((m) => m.content), ['промпт 1', 'промпт 2']);
});
