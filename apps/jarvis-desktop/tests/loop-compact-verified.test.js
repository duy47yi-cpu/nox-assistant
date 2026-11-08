'use strict';

// Сжатие старых ответов инструментов не должно прятать честную пометку проверки:
// иначе в следующем ходе модель увидит «обрезано» и решит, что шаг подтверждён.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

test('в сжатом старом ответе остаётся verified, а огромные данные не тащатся', async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: 'big',
    risk: 'T1',
    description: 'большой ответ',
    parameters: { type: 'object', properties: {} },
    run: async () => ({ ok: true, summary: 'сделал много', data: { blob: 'x'.repeat(5000) } }),
    verify: async () => ({ status: 'unknown', evidence: 'проверить не удалось' }),
  });

  const seen = [];
  let asked = false;
  const brain = {
    chat: async ({ messages }) => {
      seen.push(messages);
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (!asked && String(lastUser && lastUser.content).includes('первый')) {
        asked = true;
        return { content: '', toolCalls: [{ id: 'c1', name: 'big', args: {} }] };
      }
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

  await agent.run('первый ход');
  await agent.run('второй ход');

  const second = seen.at(-1);
  const toolMessage = second.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
  assert.ok(toolMessage, 'ответ инструмента есть в истории второго хода');
  assert.match(toolMessage.content, /"verified":"unknown"/, 'пометка проверки сохранена');
  assert.match(toolMessage.content, /"ok":true/);
  assert.ok(toolMessage.content.length < 600, `сжатый ответ короткий: ${toolMessage.content.length}`);
  assert.doesNotMatch(toolMessage.content, /x{1000}/, 'огромные данные не тащатся в контекст');
});
