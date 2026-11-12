'use strict';

// Independent live verification of ZM-001 / ZM-013 / ZM-018 in the real Nox Electron window.
// Usage (from apps/jarvis-desktop):
//   node_modules/.bin/electron <this file> main <WxH> <run-name>
//   node_modules/.bin/electron <this file> restart-write <WxH> <run-name>
//   node_modules/.bin/electron <this file> restart-read  <WxH> <run-name>
// All state lives in ./runs/<run-name>/ (temporary profile + NOX_DATA_DIR). Effects of fake agents are
// pushed into an in-memory array. The restart probe uses the real workspace_write inside the temp profile only.

const fs = require('node:fs');
const path = require('node:path');
const { app, globalShortcut, ipcMain } = require('electron');

const [mode, size, runName] = process.argv.slice(2);
if (!['main', 'restart-write', 'restart-read'].includes(mode) || !/^\d+x\d+$/.test(size || '') || !/^[a-z0-9-]+$/.test(runName || '')) {
  throw new Error('usage: <main|restart-write|restart-read> <WxH> <run-name>');
}
const [W, H] = size.split('x').map(Number);
const appRoot = path.resolve(__dirname, '../../../../../../apps/jarvis-desktop');
const workRoot = path.join(__dirname, 'runs', runName);
const data = path.join(workRoot, 'data');
const profile = path.join(workRoot, 'profile');
const out = path.join(workRoot, mode + '.json');
for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_|OPENAI_|ANTHROPIC_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = data;
if (mode !== 'restart-read') {
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    voice: false, backgroundModelRuns: false, alwaysListen: false, dictation: false, desktopOverlay: false,
    alwaysOnTop: false, motion: false, seededBrief: true, clipboardHistory: false, quiet: true, keepAwake: 'off', mode: 'ask',
  }));
}
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
require(path.join(appRoot, 'src/config/paths.js')).projectRoot = () => workRoot;

const T0 = Date.now();
const now = () => Date.now() - T0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const note = (what, extra = {}) => log.push({ t: now(), what, ...extra });

// ---- capture the application's broker
let broker = null;
{
  const mod = require(path.join(appRoot, 'src/policy/approvals.js'));
  mod.ApprovalBroker = class extends mod.ApprovalBroker {
    constructor(options) {
      super(options);
      if (typeof options?.onAutoCancel === 'function') broker = this;
    }
  };
}

// ---- fault injection on the real approval:respond handler
const faults = new Map(); // approvalId -> { kind, release }
const ipcCalls = [];
{
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => handle(channel, channel !== 'approval:respond' ? handler : async (event, id, decision) => {
    const f = faults.get(id);
    const rec = { t: now(), id, decision, fault: f ? f.kind : null };
    ipcCalls.push(rec);
    if (!f) { rec.result = handler(event, id, decision); return rec.result; }
    faults.delete(id); // a fault fires once
    if (f.kind === 'fail-before') { rec.result = 'threw-before'; throw new Error('synthetic IPC failure before core'); }
    if (f.kind === 'fail-after') { rec.result = handler(event, id, decision); rec.after = 'threw-after'; throw new Error('synthetic IPC failure after core'); }
    if (f.kind === 'hang-before') {
      return new Promise((resolve) => { f.release = () => { rec.lateResult = handler(event, id, decision); rec.released = now(); resolve(rec.lateResult); }; faults.set('__hung', f); });
    }
    if (f.kind === 'hang-after') {
      rec.result = handler(event, id, decision);
      return new Promise((resolve) => { f.release = () => { rec.released = now(); resolve(rec.result); }; faults.set('__hung', f); });
    }
    if (f.kind === 'late-after') {
      rec.result = handler(event, id, decision);
      await sleep(f.ms || 7000);
      rec.released = now();
      return rec.result;
    }
    return handler(event, id, decision);
  });
}

// ---- restart probe: real app agent through the real chat, StubBrain asks for a workspace_write
const restartPrompt = 'zm-restart: подготовь пробную запись';
const restartFile = path.join(workRoot, 'workspace', 'reports', 'zm-restart-marker.txt');
let restartModelCalls = 0;
if (mode !== 'main') {
  const { StubBrain } = require(path.join(appRoot, 'src/brain/stub.js'));
  const original = StubBrain.prototype.chat;
  StubBrain.prototype.chat = async function (request) {
    const msgs = request.messages || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (!text.includes(restartPrompt)) return original.call(this, request);
    restartModelCalls += 1;
    note('stub-model-call', { n: restartModelCalls });
    if (msgs.at(-1)?.role === 'tool') return { content: 'готово', toolCalls: [] };
    return { content: '', toolCalls: [{ id: 'call_0', name: 'workspace_write', args: { path: 'reports/zm-restart-marker.txt', content: 'must never be written without approval\n' } }] };
  };
}

// ---- fake agents sharing the application broker
const effects = [];
const seenApprovalIds = new Set();
function fakeAgent(wc, { marker, callId = 'call_0', forward = 'all', retryCalls = 0, onEvent = null }) {
  const { Agent } = require(path.join(appRoot, 'src/agent/loop.js'));
  const tool = {
    name: 'zm_fake_effect', risk: 'T2', description: 'in-memory fake effect',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    async run({ text }) { effects.push({ t: now(), marker, text }); note('EFFECT', { marker, text }); return { ok: true, summary: 'in-memory' }; },
  };
  let turn = 0;
  const events = [];
  const agent = new Agent({
    brain: { async chat() {
      if (turn++ <= retryCalls) return { content: '', toolCalls: [{ id: callId, name: tool.name, args: { text: marker } }] };
      return { content: 'fake finished', toolCalls: [] };
    } },
    tools: { get: (n) => (n === tool.name ? tool : null), list: () => [tool] },
    approvals: broker, policy: () => 'ask', mode: 'ask', journal: { append() {} },
    emit(ev) {
      events.push(ev);
      if (ev.type === 'approval_request') seenApprovalIds.add(ev.id);
      if (ev.type === 'approval_request') note('approval_request', { marker, approvalId: ev.id, callId: ev.callId, agentId: ev.agentId });
      if (onEvent) onEvent(ev);
      // worker-style forwarding (src/tools/agents.js): only approval_request/tool_start/tool_result reach the window
      if (forward === 'worker' && !['approval_request', 'tool_start', 'tool_result'].includes(ev.type)) return;
      if (!wc.isDestroyed()) wc.send('agent:event', ev);
    },
  });
  return { agent, events, run: (t) => agent.run(t || 'zm ' + marker), req: (n = 0) => events.filter((e) => e.type === 'approval_request')[n] };
}

async function probeMain(win) {
  const wc = win.webContents;
  const js = (src) => wc.executeJavaScript(src, true);
  const when = async (src, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await js(src);
      if (v) return v;
      if (Date.now() > end) throw new Error('timeout: ' + src);
      await sleep(25);
    }
  };
  const consoleErrors = [];
  wc.on('console-message', (d) => { if (d.level === 'error') consoleErrors.push(d.message); });
  win.setContentSize(W, H);
  await sleep(300);
  await js(`window.__zm = []; window.jarvis.onEvent((ev) => { if (/approval|done/.test(ev.type)) window.__zm.push({ t: Date.now(), type: ev.type, id: ev.id, callId: ev.callId || null }); }); true`);
  const snap = () => js(`(() => {
    const d = document.querySelector('#approvalDialog');
    const btn = (k) => d.querySelector('[data-decision="' + k + '"]');
    return { open: d.open, current: d.dataset.current || null, question: document.querySelector('#apQuestion').innerText,
      queueLabel: document.querySelector('#apQueue').hidden ? null : document.querySelector('#apQueue').innerText,
      buttonsDisabled: ['reject','session','once'].map((k) => btn(k).disabled),
      focus: document.activeElement?.getAttribute('data-decision') || document.activeElement?.id || document.activeElement?.tagName,
      pendingBadge: document.querySelector('#pendingCount').hidden ? 0 : Number(document.querySelector('#pendingCount').innerText),
      toasts: [...document.querySelectorAll('#toasts .toast')].map((e) => e.innerText) };
  })()`);
  const btnCenter = (k) => js(`(() => { const r = document.querySelector('#approvalDialog [data-decision="${k}"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width }; })()`);
  // Real OS-level-like input through Chromium's input pipeline (not element.click()).
  const mouseClick = ({ x, y }, clickCount = 1) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount });
  };
  const key = (keyCode) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); wc.sendInputEvent({ type: 'keyUp', keyCode }); };
  const pending = () => broker.list().map((p) => ({ id: p.id, text: p.args && p.args.text }));
  const shot = async (name) => fs.writeFileSync(path.join(workRoot, `${name}-${W}x${H}.png`), (await wc.capturePage()).toPNG());
  // Clean up between scenarios: cancel everything in the core and tell the window like main.js onAutoCancel does.
  const reset = async () => {
    for (const p of broker.list()) { broker.cancel(p.id, 'zm cleanup'); wc.send('agent:event', { type: 'approval_closed', id: p.id, decision: 'reject', cancelled: true }); }
    broker.timeoutMs = null;
    // Harness hygiene: drop ghost cards left in the window by scenarios that do not emit approval_closed.
    for (const aid of seenApprovalIds) wc.send('agent:event', { type: 'approval_closed', id: aid, decision: 'reject', cancelled: true, reason: 'zm harness reset' });
    seenApprovalIds.clear();
    await sleep(150);
    await js(`(() => { const d = document.querySelector('#approvalDialog'); if (d.open) d.close(); document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()); return true; })()`);
    await sleep(50);
  };
  const results = [];
  const scenario = async (id, title, fn) => {
    const e0 = effects.length; const c0 = ipcCalls.length;
    const r = { id, title, startedAt: now() };
    try { Object.assign(r, await fn()); } catch (err) { r.error = String(err && err.stack || err); }
    r.effects = effects.slice(e0).map((e) => e.marker);
    r.ipcCalls = ipcCalls.slice(c0).map(({ id: aid, decision, fault, result, after, lateResult }) => ({ id: aid, decision, fault, result, after, lateResult }));
    r.pendingAfter = pending();
    results.push(r);
    note('scenario-done', { id, effects: r.effects, verdict: r.verdict });
    await reset();
  };
  const markerQ = (m) => `[contains ${m}]`;

  // S01 — ZM-013 auto open + allow
  await scenario('S01', 'новый запрос открывает диалог сам; «Разрешить» выполняет показанное', async () => {
    const a = fakeAgent(wc, { marker: 'ZM-ALPHA-1' });
    const ra = a.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const shown = await snap();
    await shot('S01-open');
    mouseClick(await btnCenter('once'));
    await ra;
    await sleep(200);
    const after = await snap();
    return { shown, approvalId: a.req().id, callId: a.req().callId, after,
      verdict: shown.open && shown.current === a.req().id && shown.question.includes('ZM-ALPHA-1') && effects.at(-1)?.marker === 'ZM-ALPHA-1' && !after.open ? 'PASS' : 'FAIL' };
  });

  // S02 — ZM-013 Escape rejects and closes
  await scenario('S02', 'Escape отклоняет запрос, закрывает диалог и возвращает фокус', async () => {
    await js('document.querySelector("#chatInput")?.focus(); true');
    const a = fakeAgent(wc, { marker: 'ZM-ALPHA-2' });
    const ra = a.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const shown = await snap();
    key('Escape');
    await ra;
    await sleep(200);
    const after = await snap();
    return { shown, approvalId: a.req().id, after, brokerEmpty: broker.list().length === 0,
      verdict: !after.open && broker.list().length === 0 && !effects.some((e) => e.marker === 'ZM-ALPHA-2') ? 'PASS' : 'FAIL' };
  });

  // S03 — ZM-001 collision, real click synchronised with the arrival of B (two variants)
  for (const variant of ['click-then-B', 'B-then-click']) {
    await scenario('S03-' + variant, 'одинаковый callId у двух агентов, нажатие синхронно с приходом B (' + variant + ')', async () => {
      const a = fakeAgent(wc, { marker: 'ZM-VISIBLE-A' });
      const ra = a.run();
      await when('document.querySelector("#approvalDialog").open', 3000);
      const shown = await snap();
      const at = await btnCenter('once');
      const b = fakeAgent(wc, {
        marker: 'ZM-HIDDEN-B',
        onEvent: (ev) => { if (ev.type === 'approval_request' && variant === 'click-then-B') mouseClick(at); },
      });
      const rb = b.run();
      if (variant === 'B-then-click') { await new Promise((r) => setImmediate(r)); mouseClick(at); }
      await ra;
      await sleep(300);
      const afterA = await snap();
      broker.respond(b.req().id, 'reject');
      await rb;
      return { shown, approvalA: a.req().id, approvalB: b.req().id, callIdA: a.req().callId, callIdB: b.req().callId, afterA,
        verdict: effects.length && effects.at(-1).marker === 'ZM-VISIBLE-A' && !effects.some((e) => e.marker === 'ZM-HIDDEN-B') ? 'PASS' : 'FAIL' };
    });
  }

  // S04 — "user sees A while B is queued", delayed click, then can the user act on B?
  await scenario('S04', 'видно A, B уже в очереди; позднее нажатие; затем ответ на B', async () => {
    const a = fakeAgent(wc, { marker: 'ZM-QUEUE-A1', forward: 'worker' });
    const b = fakeAgent(wc, { marker: 'ZM-QUEUE-B1', forward: 'worker' });
    const ra = a.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const rb = b.run();
    await when('document.querySelector("#apQueue").hidden === false', 3000);
    await sleep(500);
    const shownA = await snap();
    await shot('S04-A-with-B-queued');
    mouseClick(await btnCenter('once'));
    await ra;
    await sleep(400);
    const shownB = await snap();
    await shot('S04-B-after-A');
    // try to approve B by a real click 0.4 s after it appeared
    mouseClick(await btnCenter('once'));
    await sleep(600);
    const bRanByClick = effects.some((e) => e.marker === 'ZM-QUEUE-B1');
    const afterClickB = await snap();
    // try Escape on B
    let escWorked = null;
    if (!bRanByClick && afterClickB.open) { key('Escape'); await sleep(400); escWorked = broker.list().length === 0; }
    if (broker.list().length) broker.respond(b.req().id, 'reject');
    await rb;
    return { shownA, shownB, afterClickB, bRanByClick, escWorked, approvalA: a.req().id, approvalB: b.req().id,
      verdictBinding: effects.some((e) => e.marker === 'ZM-QUEUE-A1') && shownA.current === a.req().id ? 'PASS' : 'FAIL',
      verdictNextUsable: !shownB.buttonsDisabled.some(Boolean) && bRanByClick ? 'PASS' : 'FAIL' };
  });

  // S05 — double click on «Разрешить» while B is queued
  await scenario('S05', 'двойное нажатие «Разрешить», B в очереди', async () => {
    const a = fakeAgent(wc, { marker: 'ZM-DOUBLE-A1', forward: 'worker' });
    const b = fakeAgent(wc, { marker: 'ZM-DOUBLE-B1', forward: 'worker' });
    const ra = a.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const rb = b.run();
    await when('document.querySelector("#apQueue").hidden === false', 3000);
    await sleep(300);
    const shown = await snap();
    const at = await btnCenter('once');
    mouseClick(at, 1);
    await sleep(60);
    mouseClick(at, 2);
    await ra;
    await sleep(500);
    const after = await snap();
    const bRan = effects.some((e) => e.marker === 'ZM-DOUBLE-B1');
    if (broker.list().length) broker.respond(b.req().id, 'reject');
    await rb;
    return { shown, after, bRan, verdict: !bRan && effects.filter((e) => e.marker === 'ZM-DOUBLE-A1').length === 1 ? 'PASS' : 'FAIL' };
  });

  // S06 — swap under the cursor: A closes in the core (auto-cancel path) right when the owner clicks
  for (const [fw, delay] of [['all', 0], ['worker', 0], ['worker', 40], ['worker', 120], ['worker', 250]]) {
    const am = `ZM-SWAP-A-${fw}-${String(delay).padStart(3, '0')}`;
    const bm = `ZM-SWAP-B-${fw}-${String(delay).padStart(3, '0')}`;
    await scenario('S06-' + fw + '-' + delay, `A истекает в ядре, нажатие через ${delay} мс (${fw}): что одобрено`, async () => {
      const a = fakeAgent(wc, { marker: am, forward: fw });
      const b = fakeAgent(wc, { marker: bm, forward: fw });
      const ra = a.run();
      await when('document.querySelector("#approvalDialog").open', 3000);
      const rb = b.run();
      await when('document.querySelector("#apQueue").hidden === false', 3000);
      await sleep(300);
      const shown = await snap();
      const at = await btnCenter('once');
      broker._autoCancel(a.req().id); // the same path as the 30 s timer: core rejects A, main.js emits approval_closed
      if (delay) await sleep(delay);
      mouseClick(at);
      await ra;
      await sleep(400);
      const bRan = effects.some((e) => e.marker === bm);
      const after = await snap();
      if (broker.list().length) broker.respond(b.req().id, 'reject');
      await rb;
      return { shownBeforeClick: shown, after, approvalA: a.req().id, approvalB: b.req().id, bRan,
        verdict: bRan ? 'VULNERABLE: B approved by a click aimed at A' : 'SAFE' };
    });
  }

  // S07 — expired approval
  await scenario('S07', 'истёкший запрос: диалог закрывается, позднее нажатие ничего не делает', async () => {
    broker.timeoutMs = 1500;
    const a = fakeAgent(wc, { marker: 'ZM-EXPIRE-1' });
    const ra = a.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const shown = await snap();
    const at = await btnCenter('once');
    await ra;
    await sleep(300);
    const after = await snap();
    mouseClick(at);
    await sleep(300);
    const late = await js(`window.jarvis.respondApproval(${JSON.stringify(a.req().id)}, 'once')`);
    return { shown, after, lateIpc: late, reason: broker.closedReason(a.req().id),
      verdict: !after.open && late && late.ok === false && !effects.some((e) => e.marker === 'ZM-EXPIRE-1') ? 'PASS' : 'FAIL' };
  });

  // S08 — denial, then immediately a new request with the same raw callId
  await scenario('S08', 'отказ и сразу новый запрос с тем же callId', async () => {
    const a = fakeAgent(wc, { marker: 'ZM-RETRY-1', retryCalls: 1 });
    const ra = a.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const first = await snap();
    mouseClick(await btnCenter('reject'));
    for (let i = 0; i < 100 && !a.req(1); i++) await sleep(20);
    await when(`document.querySelector("#approvalDialog").dataset.current === ${JSON.stringify(a.req(1) && a.req(1).id)}`, 3000);
    await sleep(100);
    const second = await snap();
    const staleIpc = await js(`window.jarvis.respondApproval(${JSON.stringify(a.req(0).id)}, 'once')`);
    mouseClick(await btnCenter('once'));
    await ra;
    return { first, second, approval1: a.req(0).id, approval2: a.req(1).id, staleIpc,
      verdict: staleIpc.ok === false && effects.filter((e) => e.marker === 'ZM-RETRY-1').length === 1 && !second.buttonsDisabled.some(Boolean) ? 'PASS' : 'FAIL' };
  });

  // S09 — approval after the task was cancelled
  await scenario('S09', 'ход остановлен во время ожидания; поздний ответ', async () => {
    const a = fakeAgent(wc, { marker: 'ZM-CANCEL-1' });
    const ra = a.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const shown = await snap();
    const at = await btnCenter('once');
    a.agent.stop();
    await ra;
    await sleep(300);
    const after = await snap();
    mouseClick(at);
    const lateIpc = await js(`window.jarvis.respondApproval(${JSON.stringify(a.req().id)}, 'once')`);
    await sleep(200);
    return { shown, after, lateIpc, verdict: !after.open && lateIpc.ok === false && !effects.some((e) => e.marker === 'ZM-CANCEL-1') ? 'PASS' : 'FAIL' };
  });

  // S10..S14 — IPC faults (ZM-018)
  const ipcCase = async (id, title, kind, extra = {}) => scenario(id, title, async () => {
    const a = fakeAgent(wc, { marker: 'ZM-IPC-' + id, forward: extra.withB ? 'worker' : 'all' });
    const b = extra.withB ? fakeAgent(wc, { marker: 'ZM-IPCB-' + id, forward: 'worker' }) : null;
    const ra = a.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const rb = b ? b.run() : null;
    if (b) await when('document.querySelector("#apQueue").hidden === false', 3000);
    faults.set(a.req().id, { kind, ms: extra.ms });
    const shown = await snap();
    mouseClick(await btnCenter('once'));
    await sleep(250);
    const during = await snap();
    const brokerDuring = pending();
    let atTimeout = null;
    if (extra.waitMs) {
      await sleep(extra.waitMs); atTimeout = await snap();
      // wait (max 4 s more) until the window re-enables something, then record when
      const t1 = Date.now();
      await when('![...document.querySelectorAll("#approvalDialog [data-decision]")].every((b) => b.disabled)', 4000).catch(() => {});
      atTimeout.reenabledAfterExtraMs = Date.now() - t1;
    }
    let retried = false;
    if (broker.list().some((p) => p.id === a.req().id) && (await snap()).current === a.req().id) {
      mouseClick(await btnCenter('once')); retried = true; await sleep(300);
    }
    const afterRetry = await snap();
    const hung = faults.get('__hung');
    if (hung && hung.release) { faults.delete('__hung'); hung.release(); await sleep(300); }
    const afterRelease = await snap();
    let bResult = null;
    if (b) {
      await sleep(200);
      const bSnap = await snap();
      if (bSnap.current === b.req().id) { mouseClick(await btnCenter('once')); await sleep(500); }
      bResult = { snapBeforeClick: bSnap, ran: effects.some((e) => e.marker === 'ZM-IPCB-' + id) };
      if (broker.list().length) broker.respond(b.req().id, 'reject');
    }
    if (broker.list().some((p) => p.id === a.req().id)) broker.respond(a.req().id, 'reject');
    await ra; if (rb) await rb;
    const aRuns = effects.filter((e) => e.marker === 'ZM-IPC-' + id).length;
    return { kind, approvalId: a.req().id, shown, during, brokerDuring, atTimeout, retried, afterRetry, afterRelease, bResult, aRuns,
      verdict: aRuns === 1 && (!b || bResult.ran) ? 'PASS' : `CHECK (aRuns=${aRuns}${b ? ', bRan=' + bResult.ran : ''})` };
  });
  await ipcCase('S10', 'IPC падает до ядра: запрос остаётся, повтор работает', 'fail-before');
  await ipcCase('S11', 'IPC падает после решения ядра', 'fail-after', { withB: true });
  await ipcCase('S12', 'ответ IPC завис до ядра: через 5 с кнопки снова активны, повтор работает', 'hang-before', { waitMs: 5200 });
  await ipcCase('S13', 'ответ IPC завис после решения ядра, B в очереди', 'hang-after', { withB: true, waitMs: 5200 });
  await ipcCase('S14', 'поздний ответ IPC (7 с) после решения ядра, B в очереди', 'late-after', { withB: true, ms: 7000, waitMs: 5200 });

  // S15 — worker stopped during approval (src/tools/agents.js forwarding: no done, no approval_closed)
  await scenario('S15', 'рабочий агент остановлен во время ожидания: карточка-призрак', async () => {
    const w = fakeAgent(wc, { marker: 'ZM-WORKER-1', forward: 'worker' });
    const rw = w.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const shown = await snap();
    w.agent.stop();
    await rw;
    await sleep(400);
    const afterStop = await snap();
    mouseClick(await btnCenter('once'));
    await sleep(600);
    const afterClick = await snap();
    return { shown, afterStop, afterClick, brokerPending: pending().length,
      verdict: afterStop.open ? 'DESYNC: window shows a request the core already closed' : 'SYNCED' };
  });

  // S16 — another agent's "done" clears this agent's card while the core still waits
  await scenario('S16', 'done другого агента убирает чужую карточку, ядро ещё ждёт', async () => {
    const x = fakeAgent(wc, { marker: 'ZM-CROSS-X' });
    const rx = x.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const shown = await snap();
    wc.send('agent:event', { type: 'done', runId: 'zm-other-agent-run', status: 'done' });
    await sleep(400);
    const after = await snap();
    const corePending = pending();
    broker.respond(x.req().id, 'reject');
    await rx;
    return { shown, after, corePending, verdict: !after.open && corePending.length ? 'DESYNC: core waits, window shows nothing' : 'SYNCED' };
  });

  // S17 — window closed (hidden to tray) during approval
  await scenario('S17', 'окно закрыто крестиком во время ожидания', async () => {
    broker.timeoutMs = 2500;
    const a = fakeAgent(wc, { marker: 'ZM-CLOSE-1' });
    const ra = a.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const shown = await snap();
    win.close(); // main.js hides to tray unless quitting
    await sleep(300);
    const visibleAfterClose = win.isVisible();
    const pendingWhileHidden = pending();
    await ra;
    win.show();
    await sleep(300);
    const afterShow = await snap();
    return { shown, visibleAfterClose, pendingWhileHidden, afterShow, reason: broker.closedReason(a.req().id),
      verdict: !effects.some((e) => e.marker === 'ZM-CLOSE-1') && !afterShow.open ? 'PASS' : 'FAIL' };
  });

  // S18 — renderer reload during approval
  await scenario('S18', 'перезагрузка окна (renderer) во время ожидания', async () => {
    broker.timeoutMs = 4000;
    const a = fakeAgent(wc, { marker: 'ZM-RELOAD-1' });
    const ra = a.run();
    await when('document.querySelector("#approvalDialog").open', 3000);
    const shown = await snap();
    wc.reload();
    await new Promise((r) => wc.once('did-finish-load', r));
    await sleep(800);
    const afterReload = await snap();
    const corePending = pending();
    await ra;
    await sleep(200);
    return { shown, afterReload, corePending, reason: broker.closedReason(a.req().id),
      verdict: !effects.some((e) => e.marker === 'ZM-RELOAD-1')
        ? (corePending.length && !afterReload.open ? 'SAFE but DESYNC: pending request invisible after reload until auto-cancel' : 'PASS')
        : 'FAIL' };
  });

  const rendererEvents = await js('window.__zm || []').catch(() => []);
  return { size, results, effects, ipcCalls, consoleErrors, rendererEvents, log };
}

async function probeRestart(win) {
  const wc = win.webContents;
  const js = (src) => wc.executeJavaScript(src, true);
  win.setContentSize(W, H);
  await sleep(500);
  if (mode === 'restart-write') {
    await js(`(() => { const i = document.querySelector('#chatInput'); i.value = ${JSON.stringify(restartPrompt)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#chatSend').click(); return true; })()`);
    for (let i = 0; i < 200 && !broker.list().length; i++) await sleep(25);
    await sleep(300);
    const dialog = await js(`({ open: document.querySelector('#approvalDialog').open, q: document.querySelector('#apQuestion').innerText })`);
    fs.writeFileSync(path.join(workRoot, `restart-pending-${W}x${H}.png`), (await wc.capturePage()).toPNG());
    const res = { mode, pending: broker.list().map((p) => ({ id: p.id, name: p.name, callId: p.callId, agentId: p.agentId })), dialog,
      fileExistsBeforeExit: fs.existsSync(restartFile), restartModelCalls, log };
    fs.writeFileSync(out, JSON.stringify(res, null, 2));
    app.exit(0); // abrupt: no before-quit handlers
    return null;
  }
  // restart-read: same profile, give the app time to resume anything it would resume
  await sleep(4000);
  const res = { mode, pendingAfterRestart: broker ? broker.list().length : null,
    dialog: await js(`({ open: document.querySelector('#approvalDialog').open, q: document.querySelector('#apQuestion').innerText, badge: document.querySelector('#pendingCount').hidden ? 0 : document.querySelector('#pendingCount').innerText })`),
    fileExists: fs.existsSync(restartFile), restartModelCalls, log };
  fs.writeFileSync(path.join(workRoot, `restart-after-${W}x${H}.png`), (await wc.capturePage()).toPNG());
  return res;
}

const fail = (err) => { console.error(err && err.stack || err); try { fs.writeFileSync(out, JSON.stringify({ fatal: String(err && err.stack || err), log }, null, 2)); } catch {} app.exit(1); };
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return;
  started = true;
  win.webContents.once('did-finish-load', async () => {
    try {
      await sleep(800);
      const res = mode === 'main' ? await probeMain(win) : await probeRestart(win);
      if (res) fs.writeFileSync(out, JSON.stringify(res, null, 2));
      process.stdout.write(JSON.stringify({ mode, out }) + '\n');
      app.exit(0);
    } catch (err) { fail(err); }
  });
});
app.whenReady().then(() => require(path.join(appRoot, 'main.js'))).catch(fail);
setTimeout(() => fail(new Error('zm-live global timeout')), 300000).unref();
