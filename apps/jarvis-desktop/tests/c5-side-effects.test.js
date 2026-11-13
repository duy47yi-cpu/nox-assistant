'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../src/policy/modes');
const { Agent } = require('../src/agent/loop');

test('browser-derived memory always requires separate approval', () => {
  for (const mode of ['ask', 'auto', 'full']) {
    for (const kind of ['note', 'fact', 'preference', 'task', 'contact', 'profile', 'agreement']) {
      assert.equal(decide({ mode, name: 'remember', risk: 'T0', args: { kind, text: 'PAGE_CANARY' }, browserTainted: true }), 'ask', `${mode} ${kind}`);
    }
  }
});

test('restored browser call prompts for memory, clean history keeps ordinary note behavior', () => {
  const tool = { name: 'remember', risk: 'T0' };
  const args = { kind: 'note', text: 'PAGE_CANARY' };
  const options = { brain: {}, tools: {}, journal: {}, mode: 'full' };
  const history = [{ role: 'assistant', tool_calls: [{ id: 'read', function: { name: 'browser_tab_read', arguments: '{}' } }] }];
  const restored = new Agent({ ...options, history: JSON.parse(JSON.stringify(history)) });
  assert.equal(restored._verdict(tool, args), 'ask');
  assert.equal(new Agent(options)._verdict(tool, args), 'allow');
});
