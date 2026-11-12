'use strict';

// Isolated probe: two fake agents share one approval broker and reuse a tool-call id.
// Both tools only append their names to an in-memory array; no system action is possible.
const fs = require('fs');
const path = require('path');
const repo = path.resolve(__dirname, '../../../../');
const { Agent } = require(path.join(repo, 'apps/jarvis-desktop/src/agent/loop.js'));
const { ApprovalBroker } = require(path.join(repo, 'apps/jarvis-desktop/src/policy/approvals.js'));

const broker = new ApprovalBroker({ timeoutMs: null, autoCancelMs: null });
const events = [];
const executed = [];
const callId = 'shared-provider-call-id';

function makeAgent(name, argument) {
  const tool = {
    name,
    risk: 'T2',
    description: `fake ${name}`,
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    async run(args) {
      executed.push({ tool: name, value: args.value });
      return { ok: true, summary: 'safe fake effect returned' };
    },
  };
  let first = true;
  return new Agent({
    brain: { async chat() {
      if (first) {
        first = false;
        return { content: '', toolCalls: [{ id: callId, name, args: { value: argument } }] };
      }
      return { content: 'fixture complete', toolCalls: [] };
    } },
    tools: { get: (toolName) => toolName === name ? tool : null, list: () => [tool] },
    policy: () => 'ask',
    approvals: broker,
    journal: { append() {} },
    emit: (event) => events.push({ ...event, agent: name }),
    mode: 'full',
  });
}

function waitForTwoRequests(timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const requests = events.filter((event) => event.type === 'approval_request');
      if (requests.length >= 2) return resolve(requests);
      if (Date.now() - started > timeoutMs) return reject(new Error(`only ${requests.length} approval request(s) observed`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

(async () => {
  const first = makeAgent('visible_fake_action', 'visible arguments');
  const second = makeAgent('unshown_fake_action', 'different arguments');
  const runs = [first.run('fixture one'), second.run('fixture two')];
  const requests = await waitForTwoRequests();

  // Mirrors renderer/app.js approvalPush: duplicate ids are ignored, leaving the first card visible.
  const visibleQueue = [];
  for (const request of requests) {
    if (!request.id || visibleQueue.some((item) => item.id === request.id)) continue;
    visibleQueue.push(request);
  }
  const visibleRequest = visibleQueue[0];
  const brokerPendingBeforeClick = broker.list().map(({ id, name, args }) => ({ id, name, args }));
  const brokerResponded = broker.respond(visibleRequest.id, 'once');
  const runResults = await Promise.all(runs);
  const result = {
    requests: requests.map(({ id, name, args }) => ({ id, name, args })),
    visibleRequest: visibleRequest && { id: visibleRequest.id, name: visibleRequest.name, args: visibleRequest.args },
    brokerPendingBeforeClick,
    userClickedVisibleId: visibleRequest && visibleRequest.id,
    brokerResponded,
    executed,
    runResults,
  };
  const out = path.join(__dirname, 'approval-misbinding-probe.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`NOX_APPROVAL_MISBINDING ${JSON.stringify({ out, result })}\n`);
})().catch((error) => {
  process.stderr.write(`NOX_APPROVAL_MISBINDING_ERROR ${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
