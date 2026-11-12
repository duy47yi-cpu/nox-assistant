'use strict';
// Собирает diag-n3-n8.js из window-harness-s03.js: только N3 (4 повтора) и N8, с записью вызовов dialog.close().
const fs = require('fs');
const path = require('path');
const s = fs.readFileSync(path.join(__dirname, 'window-harness-s03.js'), 'utf8');
const a = s.indexOf('  // N3 —'); const b = s.indexOf('  // N4 —');
const c = s.indexOf('  // N8 —'); const d = s.indexOf('\nfunction finish');
const n3 = s.slice(a, b);
let n8 = s.slice(c, s.lastIndexOf('}', d - 1));
n8 = n8.replace('    const restored = await waitDlg((x) => x.open && x.current === idA, 12000);',
  `    const t0 = Date.now(); const trace = [];
    const restored = await waitDlg((x) => { trace.push({ dt: Date.now() - t0, open: x.open, cur: x.current && x.current.slice(0, 8), gate: x.gate }); return x.open && x.current === idA; }, 20000);
    results.push({ id: 'N8trace', idA: idA && idA.slice(0, 8), restoreMs: Date.now() - t0, trace: trace.filter((_, i) => i % 5 === 0).slice(0, 60) });`);
const hook = `(() => { window.__closes = []; const o = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.close = function (...x) { if (this.id === 'approvalDialog') window.__closes.push({ t: Date.now(), stack: String(new Error().stack).split(String.fromCharCode(10)).slice(1, 6).join(' | ') }); return o.apply(this, x); };
  document.querySelector('#approvalDialog').addEventListener('close', () => window.__closes.push({ t: Date.now(), ev: 'close' })); return true; })()`;
const head = s.slice(0, s.indexOf('async function mainPhase() {')).replace('shot-${tag}-${name}.png', 'diag-shot-${tag}-${name}.png');
const body = `
async function mainPhase() {
  await js(HOOK);
  for (let rep = 0; rep < 8; rep++) {
${n3}
  }
${n8}  results.at(-1).closes = await js('(window.__closes || []).splice(0)');
}
`;
const tail = s.slice(d).replace('window-s03-${tag}.json', 'diag-${tag}.json');
fs.writeFileSync(path.join(__dirname, 'diag-n3-n8.js'), head + body + tail);
