'use strict';

// Единый контекст вызова инструмента (идея Pydantic AI): цикл передаёт инструменту
// неизменяемый набор полей прогона — режим, заражение, фон, ход, шаг, — а не собранный на месте объект.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeToolContext } = require('../src/agent/tool-context');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');

function scripted(steps) {
  let i = 0;
  return {
    async chat() {
      const step = steps[i++];
      if (!step) throw new Error('сценарий закончился');
      return { content: step.content || '', reasoningContent: null, toolCalls: step.toolCalls || [] };
    },
  };
}

test('контекст неизменяем и несёт поля прогона', () => {
  const controller = new AbortController();
  const ctx = makeToolContext({
    workspace: 'C:/ws', signal: controller.signal, mode: 'ask', tainted: true,
    handsTainted: false, background: true, runId: 'run-1', step: 3,
  });
  assert.equal(Object.isFrozen(ctx), true);
  assert.equal(ctx.workspace, 'C:/ws');
  assert.equal(ctx.signal, controller.signal);
  assert.equal(ctx.mode, 'ask');
  assert.equal(ctx.tainted, true);
  assert.equal(ctx.background, true);
  assert.equal(ctx.runId, 'run-1');
  assert.equal(ctx.step, 3);
  assert.equal(ctx.taskId, null);
  // Изменение полей не проходит: инструмент не может тайно поменять контекст соседнего вызова.
  assert.throws(() => { ctx.mode = 'full'; }, TypeError);
  assert.equal(ctx.mode, 'ask');
});

test('агент передаёт инструменту единый контекст с режимом и ходом', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ctx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let seen = null;
  const registry = new ToolRegistry();
  registry.register({
    name: 'demo_tool',
    description: 'демо',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run(args, ctx) {
      seen = ctx;
      return { ok: true, summary: 'готово' };
    },
  });
  const agent = new Agent({
    brain: scripted([
      { toolCalls: [{ id: 'c1', name: 'demo_tool', args: {} }] },
      { content: 'сделано' },
    ]),
    tools: registry,
    policy: () => 'allow',
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    mode: 'ask',
    workspace: dir,
  });
  await agent.run('проверь контекст');

  assert.ok(seen, 'инструмент получил контекст');
  assert.equal(Object.isFrozen(seen), true);
  assert.equal(seen.mode, 'ask');
  assert.equal(seen.workspace, dir);
  assert.equal(typeof seen.runId, 'string');
  assert.ok(seen.runId.length > 0);
  assert.equal(seen.background, false);
  assert.ok(seen.signal && typeof seen.signal.aborted === 'boolean');
});
