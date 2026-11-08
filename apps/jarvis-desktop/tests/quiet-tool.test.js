'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const modes = require('../src/policy/modes');
const { ApprovalBroker } = require('../src/policy/approvals');
const { Journal } = require('../src/journal/journal');

test('служебный результат (quiet) уходит в события без карточки-ошибки и модель его видит', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-quiet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reg = new ToolRegistry();
  reg.register({
    name: 'ask_pick', risk: 'T0', description: 'варианты', parameters: { type: 'object', properties: {} },
    async run() { return { ok: true, quiet: true, summary: 'не открыл: не уверен', data: {} }; },
  });
  const steps = [
    { toolCalls: [{ id: 'q1', name: 'ask_pick', args: {} }] },
    { content: 'Какой вариант включить?' },
  ];
  let i = 0;
  const seenByModel = [];
  const brain = { async chat(messages) { seenByModel.push(messages); const s = steps[i++]; return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] }; } };
  const events = [];
  const agent = new Agent({
    brain, tools: reg, policy: modes, approvals: new ApprovalBroker({ timeoutMs: 1000 }), mode: 'full', workspace: dir,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
  });
  await agent.run('поставь что-нибудь');
  const result = events.find((e) => e.type === 'tool_result' && e.id === 'q1');
  assert.ok(result, 'результат есть');
  assert.equal(result.quiet, true);
  assert.equal(result.ok, true);
  const toolMsg = JSON.stringify(seenByModel[1] || []);
  assert.match(toolMsg, /не открыл: не уверен/);
});
