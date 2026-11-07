'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

function slowTool(name) {
  return {
    name,
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    run: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, summary: `${name} готово` }), 150)),
  };
}

test('безопасные вызовы выполняются одновременно и ответы идут в исходном порядке', async () => {
  const registry = new ToolRegistry();
  registry.register(slowTool('a'));
  registry.register(slowTool('b'));
  let turn = 0;
  const brain = {
    async chat() {
      turn += 1;
      if (turn === 1) {
        return {
          content: '',
          reasoningContent: null,
          toolCalls: [
            { id: 'x1', name: 'a', args: {} },
            { id: 'x2', name: 'b', args: {} },
          ],
        };
      }
      return { content: 'готово', reasoningContent: null, toolCalls: [] };
    },
  };
  const agent = new Agent({
    brain,
    tools: registry,
    journal: { append() {} },
    emit: () => {},
    mode: 'full',
  });

  const started = Date.now();
  await agent.run('сделай два шага');
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 280, `два шага по 150 мс должны идти параллельно, заняло ${elapsed} мс`);
  const toolMsgs = agent.history.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['x1', 'x2']);
});

test('действия с эффектом (не T0) выполняются по очереди, даже если разрешены без вопроса', async () => {
  const registry = new ToolRegistry();
  const log = [];
  const act = (name) => ({
    name,
    risk: 'T1',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      log.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 80));
      log.push(`${name}:end`);
      return { ok: true, summary: `${name} готово` };
    },
  });
  registry.register(act('press'));
  registry.register(act('type'));
  let turn = 0;
  const brain = {
    async chat() {
      turn += 1;
      if (turn === 1) {
        return {
          content: '',
          reasoningContent: null,
          toolCalls: [
            { id: 'y1', name: 'press', args: {} },
            { id: 'y2', name: 'type', args: {} },
          ],
        };
      }
      return { content: 'готово', reasoningContent: null, toolCalls: [] };
    },
  };
  const agent = new Agent({
    brain,
    tools: registry,
    journal: { append() {} },
    emit: () => {},
    mode: 'full',
  });

  await agent.run('сделай два действия');

  assert.deepEqual(log, ['press:start', 'press:end', 'type:start', 'type:end']);
  const toolMsgs = agent.history.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['y1', 'y2']);
});
