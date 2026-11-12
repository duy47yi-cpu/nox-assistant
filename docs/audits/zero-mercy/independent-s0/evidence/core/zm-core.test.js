'use strict';

// Independent adversarial tests for ZM-001 / ZM-013 / ZM-018 (core side).
// Written from scratch for the independent S0 verification; not derived from tests/*.test.js.
// Effects are pushed into in-memory arrays only. No real tools, no network, no data/ folder.
// Run: node --test docs/audits/zero-mercy/independent-s0/evidence/core/

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '../../../../../../apps/jarvis-desktop');
const { Agent } = require(path.join(appRoot, 'src/agent/loop.js'));
const { ScreenAgent } = require(path.join(appRoot, 'src/screen/agent.js'));
const { ApprovalBroker } = require(path.join(appRoot, 'src/policy/approvals.js'));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// Fake agent: first model turn asks for one tool call with a fixed raw callId, then answers.
function fakeAgent({ broker, callId = 'call_0', toolName = 'zm_fake_effect', marker, effects, events, mode = 'ask', retryCalls = 0 }) {
  const tool = {
    name: toolName, risk: 'T2', description: 'in-memory fake',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    async run({ text }) { effects.push({ marker, text }); return { ok: true, summary: 'fake effect' }; },
  };
  let turn = 0;
  const agent = new Agent({
    brain: { async chat() {
      // retryCalls: the model repeats the same raw call id after a refusal.
      if (turn++ <= retryCalls) return { content: '', toolCalls: [{ id: callId, name: tool.name, args: { text: marker } }] };
      return { content: 'done', toolCalls: [] };
    } },
    tools: { get: (n) => (n === tool.name ? tool : null), list: () => [tool] },
    approvals: broker, policy: () => 'ask', mode,
    journal: { append() {} },
    emit: (ev) => events.push({ marker, ...ev }),
  });
  return agent;
}

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await tick(5); }
  throw new Error('waitFor timeout');
}

const reqOf = (events, marker, n = 0) => events.filter((e) => e.marker === marker && e.type === 'approval_request')[n];

test('ZM-001: two concurrent agents with identical raw callId get distinct approval ids; approving A runs only A', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const a = fakeAgent({ broker, marker: 'A', effects, events });
  const b = fakeAgent({ broker, marker: 'B', effects, events });
  const ra = a.run('go A');
  const ea = await waitFor(() => reqOf(events, 'A'));
  const rb = b.run('go B');
  const eb = await waitFor(() => reqOf(events, 'B'));
  assert.equal(ea.callId, 'call_0'); assert.equal(eb.callId, 'call_0');
  assert.notEqual(ea.id, eb.id, 'approval ids must differ');
  assert.notEqual(ea.agentId, eb.agentId);
  assert.equal(broker.list().length, 2, 'B must not silently replace A in the broker');
  assert.equal(broker.respond(ea.id, 'once'), true);
  await ra;
  assert.deepEqual(effects.map((e) => e.marker), ['A']);
  assert.equal(broker.list().length, 1);
  assert.equal(broker.respond(eb.id, 'reject'), true);
  await rb;
  assert.deepEqual(effects.map((e) => e.marker), ['A'], 'B must not run');
});

test('ZM-001: answering with the raw callId (old protocol) is refused by the core', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const a = fakeAgent({ broker, marker: 'A', effects, events });
  const ra = a.run('go');
  const ea = await waitFor(() => reqOf(events, 'A'));
  assert.equal(broker.respond('call_0', 'once'), false);
  assert.equal(broker.respond(ea.callId, 'once'), false);
  assert.equal(effects.length, 0);
  broker.respond(ea.id, 'reject');
  await ra;
  assert.equal(effects.length, 0);
});

test('ZM-001: reversed delivery order (B registered first) still binds each answer to its own action', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const b = fakeAgent({ broker, marker: 'B', effects, events });
  const a = fakeAgent({ broker, marker: 'A', effects, events });
  const rb = b.run('B'); const ra = a.run('A');
  const eb = await waitFor(() => reqOf(events, 'B'));
  const ea = await waitFor(() => reqOf(events, 'A'));
  broker.respond(eb.id, 'reject');
  broker.respond(ea.id, 'once');
  await Promise.all([ra, rb]);
  assert.deepEqual(effects.map((e) => e.marker), ['A']);
});

test('ZM-001: three agents, same raw callId, two of them approved — exactly those two run once each', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const ags = ['X', 'Y', 'Z'].map((m) => fakeAgent({ broker, marker: m, effects, events }));
  const runs = ags.map((ag, i) => ag.run('go ' + i));
  const reqs = await Promise.all(['X', 'Y', 'Z'].map((m) => waitFor(() => reqOf(events, m))));
  assert.equal(new Set(reqs.map((r) => r.id)).size, 3);
  broker.respond(reqs[2].id, 'once');
  broker.respond(reqs[0].id, 'once');
  broker.respond(reqs[1].id, 'reject');
  await Promise.all(runs);
  assert.deepEqual(effects.map((e) => e.marker).sort(), ['X', 'Z']);
});

test('Repeat answer (double click reaching the core twice): second answer refused, effect exactly once', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const a = fakeAgent({ broker, marker: 'A', effects, events });
  const ra = a.run('go');
  const ea = await waitFor(() => reqOf(events, 'A'));
  assert.equal(broker.respond(ea.id, 'once'), true);
  assert.equal(broker.respond(ea.id, 'once'), false);
  assert.equal(broker.respond(ea.id, 'session'), false);
  await ra;
  assert.equal(effects.length, 1);
});

test('Denial followed immediately by a new request with the same raw callId: old id cannot approve the new request', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const a = fakeAgent({ broker, marker: 'A', effects, events, retryCalls: 1 });
  const ra = a.run('go');
  const first = await waitFor(() => reqOf(events, 'A', 0));
  broker.respond(first.id, 'reject');
  const second = await waitFor(() => reqOf(events, 'A', 1));
  assert.equal(second.callId, first.callId, 'model reused its raw id');
  assert.notEqual(second.id, first.id);
  assert.equal(broker.respond(first.id, 'once'), false, 'stale id must not approve the new request');
  assert.equal(effects.length, 0);
  broker.respond(second.id, 'reject');
  await ra;
  assert.equal(effects.length, 0);
});

test('Expired approval: answer after auto-cancel is refused with a reason, no effect', async () => {
  const closed = [];
  const broker = new ApprovalBroker({ autoCancelMs: 60, onAutoCancel: (id, reason) => closed.push({ id, reason }) });
  const effects = []; const events = [];
  const a = fakeAgent({ broker, marker: 'A', effects, events });
  const ra = a.run('go');
  const ea = await waitFor(() => reqOf(events, 'A'));
  assert.ok(ea.autoCancelAt > Date.now() - 5);
  await ra;
  assert.equal(closed.length, 1); assert.equal(closed[0].id, ea.id);
  assert.equal(broker.respond(ea.id, 'once'), false);
  assert.match(broker.closedReason(ea.id), /время/);
  assert.equal(effects.length, 0);
});

test('Approval after the task was cancelled (stop during wait): answer refused, effect never runs', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const a = fakeAgent({ broker, marker: 'A', effects, events });
  const ra = a.run('go');
  const ea = await waitFor(() => reqOf(events, 'A'));
  a.stop();
  assert.equal(broker.respond(ea.id, 'once'), false);
  await ra;
  await tick(20);
  assert.equal(effects.length, 0);
  assert.equal(broker.list().length, 0);
});

test('Stop in the same tick right after "once" was accepted: gate after approval blocks execution', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const a = fakeAgent({ broker, marker: 'A', effects, events });
  const ra = a.run('go');
  const ea = await waitFor(() => reqOf(events, 'A'));
  assert.equal(broker.respond(ea.id, 'once'), true);
  a.stop(); // before the awaiting microtask resumes
  await ra;
  await tick(20);
  assert.equal(effects.length, 0, 'approved-then-stopped action must not run');
});

test('Core enforces one-shot: a forged "session" answer for a *_send tool runs once and is not remembered', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const a = fakeAgent({ broker, marker: 'S', effects, events, toolName: 'zm_fake_send', retryCalls: 1 });
  const ra = a.run('go');
  const ea = await waitFor(() => reqOf(events, 'S', 0));
  assert.equal(ea.allowSession, false);
  broker.respond(ea.id, 'session'); // UI hides this button; simulate a buggy/forged renderer
  const second = await waitFor(() => reqOf(events, 'S', 1));
  assert.ok(second, 'second identical send must ask again');
  assert.equal(a.sessionAllow.size, 0);
  broker.respond(second.id, 'reject');
  await ra;
  assert.equal(effects.length, 1);
});

test('Core rejects unknown decisions (forged IPC payload) without settling the request', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const a = fakeAgent({ broker, marker: 'A', effects, events });
  const ra = a.run('go');
  const ea = await waitFor(() => reqOf(events, 'A'));
  for (const bad of ['allow', 'ONCE', '', null, undefined, { toString: () => 'once' }]) {
    assert.throws(() => broker.respond(ea.id, bad), TypeError);
  }
  assert.equal(broker.list().length, 1, 'still pending');
  broker.respond(ea.id, 'reject');
  await ra;
  assert.equal(effects.length, 0);
});

test('ScreenAgent dangerous step: two screen agents, same raw callId, distinct approval ids', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const mk = (marker, events) => {
    const s = Object.create(ScreenAgent.prototype);
    s.approvals = broker; s._agentId = 'agent-' + marker; s._runId = 'run-' + marker;
    s._status = () => {}; s._emit = (ev) => events.push({ marker, ...ev });
    return s;
  };
  const events = [];
  const tool = { name: 'ui_click', risk: 'T2' };
  const call = { id: 'call_0', name: 'ui_click', args: { name: 'Отправить' } };
  const ac1 = new AbortController(); const ac2 = new AbortController();
  const p1 = mk('A', events)._askDanger(tool, call, ac1.signal);
  const p2 = mk('B', events)._askDanger(tool, { ...call, args: { name: 'Удалить' } }, ac2.signal);
  const ea = reqOf(events, 'A'); const eb = reqOf(events, 'B');
  assert.notEqual(ea.id, eb.id);
  assert.equal(ea.callId, eb.callId);
  assert.equal(ea.allowSession, false);
  broker.respond(eb.id, 'reject');
  broker.respond(ea.id, 'once');
  assert.deepEqual(await Promise.all([p1, p2]), ['once', 'reject']);
  ac2.abort(); // abort after settle is harmless
});

// ---- Residual / regression probes (expected to document behaviour, not to pass a fix) ----

test('RESIDUAL: broker still silently replaces a pending request with the same explicit id (defence-in-depth not fixed)', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const p1 = broker.request({ id: 'task-1:call_0', name: 'shown_first', args: { n: 1 } });
  const p2 = broker.request({ id: 'task-1:call_0', name: 'hidden_second', args: { n: 2 } });
  assert.equal(await p1, 'reject', 'first was silently rejected');
  assert.equal(broker.list().length, 1);
  assert.equal(broker.list()[0].name, 'hidden_second');
  // The answer the owner intended for "shown_first" now approves "hidden_second".
  assert.equal(broker.respond('task-1:call_0', 'once'), true);
  assert.equal(await p2, 'once');
});

test('REGRESSION: stopping a worker agent during approval emits no approval_closed and tool_result id != approval id', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const effects = []; const events = [];
  const w = fakeAgent({ broker, marker: 'W', effects, events });
  const rw = w.run('worker');
  const ew = await waitFor(() => reqOf(events, 'W'));
  w.stop(); // e.g. src/tools/agents.js MAX_AGENT_MS timeout or parent abort
  await rw;
  const types = events.map((e) => e.type);
  assert.ok(!types.includes('approval_closed'), 'agent emits no approval_closed on its own cancellation');
  const tr = events.find((e) => e.type === 'tool_result');
  // Renderer drops cards on tool_result by ev.id (renderer/app.js approvalDrop(ev.id)); with split ids it no longer matches.
  if (tr) assert.notEqual(tr.id, ew.id);
  assert.equal(broker.respond(ew.id, 'once'), false, 'core already closed it');
  assert.equal(broker.closedReason(ew.id), null, 'and gives no reason -> UI says "уже неактуален" but keeps the card');
  assert.equal(effects.length, 0);
});

test('INFO: broker.list() order is registration order (used by voice "да" in main.js answerApprovalsByVoice)', async () => {
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  broker.request({ id: 'first' }); broker.request({ id: 'second' });
  assert.deepEqual(broker.list().map((x) => x.id), ['first', 'second']);
  broker.cancelAll();
});
