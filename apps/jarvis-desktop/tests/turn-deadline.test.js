'use strict';

// Потолок времени хода: длинная цепочка шагов останавливается между шагами с честным текстом,
// а не держит владельца молча. Без потолка поведение прежнее.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ deadline, toolMs = 0, callsNeeded = 1 } = {}) {
  const events = [];
  let modelCalls = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: 'slow_read', risk: 'T0', description: 'медленное чтение', parameters: { type: 'object', properties: {} },
    async run() { await sleep(toolMs); return { ok: true, summary: 'прочитано' }; },
  });
  const brain = {
    async chat() {
      modelCalls += 1;
      if (modelCalls <= callsNeeded) return { content: '', toolCalls: [{ id: `c${modelCalls}`, name: 'slow_read', args: {} }] };
      return { content: 'Готово', toolCalls: [] };
    },
  };
  const agent = new Agent({
    brain, tools: registry, policy: () => 'allow', journal: { append() {} },
    emit: (event) => events.push(event), turnDeadlineMs: deadline,
  });
  return { agent, events, modelCalls: () => modelCalls };
}

test('без потолка времени ход завершается ответом как раньше', async () => {
  const { agent, events, modelCalls } = setup({ deadline: 0 });
  const res = await agent.run('сделай');
  assert.equal(res.outcome, 'answer');
  assert.equal(modelCalls(), 2);
  assert.ok(events.some((e) => e.type === 'text' && e.delta === 'Готово'));
});

test('потолок времени останавливает ход между шагами и говорит об этом честно', async () => {
  const { agent, events, modelCalls } = setup({ deadline: 40, toolMs: 80 });
  const res = await agent.run('сделай');
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'timeout');
  assert.equal(modelCalls(), 1, 'второй вызов модели не делается: ход остановлен');
  const tail = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.match(tail, /остановил/);
  assert.match(tail, /Сделано шагов: 1/);
  assert.ok(events.some((e) => e.type === 'done'), 'ход закрыт событием done');
});
