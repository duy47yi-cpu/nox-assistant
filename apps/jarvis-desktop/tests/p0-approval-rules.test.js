'use strict';

// P0: правила подтверждений. Отправка и публикация — каждое действие отдельно; стоп не даёт выполнить
// старое подтверждённое действие; возобновление не запускает прерванное.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, allowKey, isOneShot } = require('../src/policy/modes');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const { StopSwitch } = require('../src/control/stop');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p0-rules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scripted(steps) {
  let i = 0;
  const brain = {
    calls: 0,
    async chat() {
      brain.calls += 1;
      const s = steps[i++];
      if (!s) throw new Error('сценарий закончился');
      return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] };
    },
  };
  return brain;
}

function publishTool(run) {
  return { name: 'publish_post', risk: 'T2', description: 'публикация', parameters: { type: 'object', properties: {} }, run };
}

test('отправка и публикация спрашивают в режимах с вопросами и при одобрении «на сессию»', () => {
  assert.equal(isOneShot('publish_post'), true);
  assert.equal(isOneShot('send_reply'), true);
  assert.equal(isOneShot('delete_draft'), true);
  assert.equal(isOneShot('workspace_read'), false);
  assert.equal(decide({ mode: 'auto', name: 'publish_post', risk: 'T2', args: { text: 'a' } }), 'ask');
  const sessionAllow = new Set([allowKey('publish_post', { text: 'a' })]);
  assert.equal(decide({ mode: 'auto', name: 'publish_post', risk: 'T2', args: { text: 'a' }, sessionAllow }), 'ask');
});

test('в полном доступе публикация и отправка идут без вопросов, удаление спрашивает', () => {
  assert.equal(decide({ mode: 'full', name: 'publish_post', risk: 'T2', args: { text: 'a' } }), 'allow');
  assert.equal(decide({ mode: 'full', name: 'send_reply', risk: 'T2', args: {} }), 'allow');
  assert.equal(decide({ mode: 'full', name: 'delete_draft', risk: 'T2', args: {} }), 'ask');
});

test('одобрение «на сессию» для публикации не переносится: одинаковый вызов спрашивает снова', async (t) => {
  const dir = setup(t);
  const approvals = new ApprovalBroker({ timeoutMs: null });
  const asked = [];
  let ran = 0;
  const reg = new ToolRegistry();
  reg.register(publishTool(async () => { ran += 1; return { ok: true, summary: 'опубликовано' }; }));
  const brain = scripted([
    { toolCalls: [{ id: 'p1', name: 'publish_post', args: { text: 'привет' } }] },
    { toolCalls: [{ id: 'p2', name: 'publish_post', args: { text: 'привет' } }] },
    { content: 'готово' },
  ]);
  const agent = new Agent({
    brain,
    tools: reg,
    approvals,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      if (e.type !== 'approval_request') return;
      asked.push(e.id);
      approvals.respond(e.id, 'session');
    },
    mode: 'auto',
    workspace: dir,
  });
  await agent.run('опубликуй');
  assert.equal(asked.length, 2, 'каждая публикация — отдельное согласие');
  assert.equal(ran, 2);
});

test('подтверждение, пришедшее уже после стопа, не даёт выполнить действие', async (t) => {
  const dir = setup(t);
  const stop = new StopSwitch();
  const approvals = new ApprovalBroker({ timeoutMs: null });
  let ran = 0;
  const reg = new ToolRegistry();
  reg.register({
    name: 'ui_click', risk: 'T1', description: 'клик', parameters: { type: 'object', properties: {} },
    run: async () => { ran += 1; return { ok: true, summary: 'нажато' }; },
  });
  const brain = scripted([{ toolCalls: [{ id: 'c1', name: 'ui_click', args: { name: 'Play' } }] }]);
  const agent = new Agent({
    brain,
    tools: reg,
    approvals,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      if (e.type !== 'approval_request') return;
      // Владелец ответил «разрешить», а стоп пришёл в ту же долю секунды, до продолжения хода.
      approvals.respond(e.id, 'once');
      stop.trigger('тест');
      agent.stop();
    },
    mode: 'auto',
    workspace: dir,
    stop,
  });
  await agent.run('нажми');
  assert.equal(ran, 0, 'старое согласие после стопа не выполняет действие');
});

test('после возобновления прерванное действие не запускается само', async (t) => {
  const dir = setup(t);
  const stop = new StopSwitch();
  const approvals = new ApprovalBroker({ timeoutMs: null });
  let ran = 0;
  const reg = new ToolRegistry();
  reg.register({
    name: 'ui_click', risk: 'T1', description: 'клик', parameters: { type: 'object', properties: {} },
    run: async () => { ran += 1; return { ok: true, summary: 'нажато' }; },
  });
  const brain = scripted([
    { toolCalls: [{ id: 'c1', name: 'ui_click', args: { name: 'Play' } }] },
    { content: 'Жду указаний.' },
  ]);
  const agent = new Agent({
    brain,
    tools: reg,
    approvals,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      if (e.type !== 'approval_request') return;
      stop.trigger('тест');
      agent.stop();
      approvals.cancelAll();
    },
    mode: 'auto',
    workspace: dir,
    stop,
  });
  await agent.run('нажми');
  assert.equal(ran, 0);
  stop.reset();
  await agent.run('что дальше?');
  assert.equal(ran, 0, 'возобновление не повторяет прерванный клик');
  assert.equal(approvals.list().length, 0);
});

test('поздний ответ на отменённое подтверждение ничего не запускает', async () => {
  const approvals = new ApprovalBroker({ timeoutMs: null });
  const p = approvals.request({ id: 'late', name: 'publish_post' });
  assert.equal(approvals.cancelAll(), 1);
  assert.equal(await p, 'reject');
  assert.equal(approvals.respond('late', 'once'), false, 'ответ после отмены не принимается');
});
