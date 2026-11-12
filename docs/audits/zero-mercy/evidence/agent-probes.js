'use strict';

// Isolated, non-system-action probes for documented audit risks.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const repo = path.resolve(__dirname, '../../../../');
const { Agent } = require(path.join(repo, 'apps/jarvis-desktop/src/agent/loop.js'));
const { Journal, historyStatus } = require(path.join(repo, 'apps/jarvis-desktop/src/journal/journal.js'));
const { ApprovalBroker } = require(path.join(repo, 'apps/jarvis-desktop/src/policy/approvals.js'));

const windowStub = { addEventListener() {} };
vm.runInNewContext(fs.readFileSync(path.join(repo, 'apps/jarvis-desktop/renderer/shared.js'), 'utf8'), {
  window: windowStub, document: {}, Set, Map, Date, console,
});
const ui = windowStub.JarvisUI;

const samples = [
  { label: 'risk-T2 success without verification', record: { ok: true, risk: 'T2', decision: 'allow', status: 'unverified', verifiedStatus: 'unverified', verified: null } },
  { label: 'stopped tool with long stop summary', record: { ok: false, risk: 'T2', decision: 'stop', status: 'failed', summary: 'остановлено: ответ инструмента пришёл после остановки хода' } },
  { label: 'stop marker with ok true', record: { ok: true, decision: 'stop', status: 'failed', summary: 'остановлено' } },
];
const statusResults = samples.map(({ label, record }) => ({
  label,
  storedStatus: record.status,
  rendererStatus: ui.statusOfRecord(record),
  searchStatus: historyStatus(record),
}));

async function stopDuringFakeTool() {
  const root = path.join(__dirname, 'test-data');
  fs.mkdirSync(root, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(root, 'agent-stop-probe-'));
  const journalPath = path.join(runDir, 'journal.jsonl');
  const events = [];
  let toolStartedAt = null;
  let toolFinishedAt = null;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const tool = {
    name: 'audit_fake_action', risk: 'T2', description: 'внутренняя фиктивная проверка',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    async run() {
      toolStartedAt = Date.now();
      startedResolve();
      await new Promise((resolve) => setTimeout(resolve, 120)); // намеренно игнорирует AbortSignal
      toolFinishedAt = Date.now();
      return { ok: true, summary: 'fixture effect returned success' };
    },
  };
  const brain = { async chat() {
    return { content: '', toolCalls: [{ id: 'probe-call-1', name: tool.name, args: { value: 'safe fixture' } }] };
  } };
  const agent = new Agent({
    brain,
    tools: { get: (name) => name === tool.name ? tool : null, list: () => [tool] },
    policy: () => 'allow',
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(journalPath),
    emit: (event) => events.push({ ...event, at: Date.now() }),
    mode: 'full', workspace: runDir,
  });
  const runPromise = agent.run('run isolated fake action');
  await started;
  const stopRequestedAt = Date.now();
  agent.stop();
  const doneEvent = events.find((event) => event.type === 'done');
  const runResult = await runPromise;
  const journalEntry = fs.readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.tool === tool.name);
  return {
    stopRequestedAt, toolStartedAt, doneAt: doneEvent && doneEvent.at, toolFinishedAt,
    doneBeforeToolFinished: Boolean(doneEvent && toolFinishedAt && doneEvent.at < toolFinishedAt),
    toolResultEmitted: events.some((event) => event.type === 'tool_result'),
    runResult,
    journalEntry: journalEntry && { ok: journalEntry.ok, status: journalEntry.status, decision: journalEntry.decision, summary: journalEntry.summary },
    events: events.map((event) => event.type),
    journalPath,
  };
}

async function duplicateApprovalId() {
  const broker = new ApprovalBroker({ timeoutMs: null });
  const first = broker.request({ id: 'duplicate-fixture-id', name: 'first_fake_action' });
  const second = broker.request({ id: 'duplicate-fixture-id', name: 'second_fake_action' });
  const firstDecision = await first;
  const pendingAfterDuplicate = broker.list().map((entry) => entry.name);
  const responded = broker.respond('duplicate-fixture-id', 'once');
  const secondDecision = await second;
  return { firstDecision, pendingAfterDuplicate, responded, secondDecision };
}

(async () => {
  const result = {
    statuses: statusResults,
    stopRace: await stopDuringFakeTool(),
    duplicateApprovalId: await duplicateApprovalId(),
  };
  const out = path.join(__dirname, 'agent-probes.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`NOX_AGENT_PROBES ${JSON.stringify({ out, ...result })}\n`);
})().catch((err) => {
  process.stderr.write(`NOX_AGENT_PROBES_ERROR ${err && err.stack ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
