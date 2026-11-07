'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent, repairToolHistory } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

function oneTool() {
  const registry = new ToolRegistry();
  registry.register({
    name: 'ping',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    run: async () => ({ ok: true, summary: 'pong' }),
  });
  return registry;
}

test('сбой журнала не оставляет вызов без ответа в истории', async () => {
  let turn = 0;
  const brain = {
    async chat() {
      turn += 1;
      if (turn === 1) return { content: '', reasoningContent: null, toolCalls: [{ id: 'j1', name: 'ping', args: {} }] };
      return { content: 'готово', reasoningContent: null, toolCalls: [] };
    },
  };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const agent = new Agent({
      brain,
      tools: oneTool(),
      journal: { append() { throw new Error('диск занят'); } },
      emit: () => {},
      mode: 'full',
    });
    const res = await agent.run('проверь');
    assert.equal(res.ok, true);
    const tool = agent.history.find((m) => m.role === 'tool');
    assert.ok(tool, 'ответ инструмента должен попасть в историю');
    assert.equal(tool.tool_call_id, 'j1');
    assert.equal(JSON.parse(tool.content).ok, true);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /журнал/);
});

test('repairToolHistory дописывает ответ к вызову без ответа и не трогает полные', () => {
  const history = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'k1' }, { id: 'k2' }] },
    { role: 'tool', tool_call_id: 'k1', content: '{"ok":true}' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'k3' }] },
    { role: 'tool', tool_call_id: 'k3', content: '{"ok":true}' },
  ];
  const fixed = repairToolHistory(history);
  const ids = fixed.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(ids, ['k1', 'k2', 'k3']);
  // заглушка идёт сразу за ответами своего вызова
  assert.equal(fixed[2].tool_call_id, 'k1');
  assert.equal(fixed[3].tool_call_id, 'k2');
  assert.equal(fixed[3].role, 'tool');
  assert.equal(fixed[4].role, 'user');
  assert.equal(fixed.length, history.length + 1);
});
