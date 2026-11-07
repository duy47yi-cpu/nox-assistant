'use strict';

// P0: подтверждение «на сессию» привязано к аргументам. Изменились параметры — нужно новое подтверждение.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');

function scripted(steps) {
  let i = 0;
  return {
    calls: 0,
    async chat() {
      this.calls += 1;
      const s = steps[i++];
      if (!s) throw new Error('сценарий закончился');
      return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] };
    },
  };
}

test('одобрение «на сессию» не переносится на другие аргументы', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p0-args-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const approvals = new ApprovalBroker({ timeoutMs: null });
  const asked = [];
  const reg = new ToolRegistry();
  reg.register({
    name: 'ui_click', risk: 'T1', description: 'клик', parameters: { type: 'object', properties: {} },
    run: async (args) => ({ ok: true, summary: `клик ${args.name}` }),
  });
  const brain = scripted([
    { toolCalls: [{ id: 'c1', name: 'ui_click', args: { name: 'Play' } }] },
    { toolCalls: [{ id: 'c2', name: 'ui_click', args: { name: 'Play' } }] },
    { toolCalls: [{ id: 'c3', name: 'ui_click', args: { name: 'Delete all' } }] },
    { content: 'готово' },
  ]);
  const agent = new Agent({
    brain,
    tools: reg,
    approvals,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      if (e.type !== 'approval_request') return;
      asked.push(e.args.name);
      // Владелец одобряет «на сессию» только первый раз.
      approvals.respond(e.id, 'session');
    },
    mode: 'auto',
    workspace: dir,
  });
  await agent.run('нажми');
  // Play спрашивали один раз; «Delete all» — отдельный вопрос, даже в той же сессии.
  assert.deepEqual(asked, ['Play', 'Delete all']);
});
