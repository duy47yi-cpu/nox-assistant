'use strict';
// node summarize.js runs/<name>/main.json  -> compact table of scenario outcomes
const r = require(require('path').resolve(process.argv[2]));
console.log('size', r.size, 'consoleErrors', r.consoleErrors.length);
const ids = (s) => [s.approvalId, s.approvalA, s.approvalB, s.approval1, s.approval2].filter(Boolean);
for (const s of r.results) {
  const sh = s.shown || s.shownA || s.shownBeforeClick || s.first || {};
  console.log(JSON.stringify({ id: s.id, verdict: s.verdict || `binding=${s.verdictBinding} next=${s.verdictNextUsable}`,
    shownCurrent: sh.current ? sh.current.slice(0, 8) : null, shownQ: sh.question, approvalIds: ids(s).map((x) => x.slice(0, 8)),
    ipc: s.ipcCalls.map((c) => `${c.id.slice(0, 8)}:${c.decision}:${c.fault || '-'}:${JSON.stringify(c.result)}${c.lateResult !== undefined ? ':late=' + JSON.stringify(c.lateResult) : ''}`),
    effects: s.effects, pendingAfter: s.pendingAfter.length, err: s.error ? s.error.slice(0, 160) : undefined }));
}
