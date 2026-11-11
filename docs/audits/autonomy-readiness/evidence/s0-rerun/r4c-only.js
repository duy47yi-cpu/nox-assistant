'use strict';
// Независимый стенд прогона 3: настоящее окно Nox (main.js без изменений) во временном профиле.
// Фиктивный мозг на 127.0.0.1, «действие» = workspace_write во временную рабочую папку (файл <метка>.txt).
// Второй одновременный запрос (как от исполнителя задач) создаётся в НАСТОЯЩЕМ брокере main.js: стенд
// подменяет класс ApprovalBroker подклассом, который только запоминает экземпляр. Решения принимает брокер.
// Запуск из apps/jarvis-desktop:
//   node_modules/electron/dist/electron.exe ../../docs/audits/zero-mercy/independent-s0-run3/evidence/window-harness-run3.js --size 1200x720
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { randomUUID } = require('crypto');
const electron = require('electron');
const { app, globalShortcut } = electron;

const APP = path.resolve(__dirname, '../../../../../apps/jarvis-desktop');
const OUT = __dirname;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const [W, H] = arg('size', '1200x720').split('x').map(Number);
const tag = `${W}x${H}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-run3-win-'));
const dataDir = path.join(root, 'data');
const wsDir = path.join(root, 'workspace');
for (const d of [path.join(root, 'profile'), dataDir, wsDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ voice: false, backgroundModelRuns: false, mode: 'ask', watchWindow: false, watchTelegram: false }));
app.setPath('userData', path.join(root, 'profile'));
for (const k of Object.keys(process.env)) if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(k)) delete process.env[k];
require(path.join(APP, 'src/config/paths')).projectRoot = () => root;
globalShortcut.register = () => true; globalShortcut.unregister = () => {}; globalShortcut.unregisterAll = () => {};
electron.Notification.isSupported = () => false; // не засорять уведомления Windows владельца

// Запоминаем брокер main.js (тот, что с onAutoCancel). Поведение класса не меняется.
// Журнал ответов окна: обёртка вокруг настоящего обработчика approval:respond (логика не меняется).
const origHandle = electron.ipcMain.handle.bind(electron.ipcMain);
electron.ipcMain.handle = (ch, fn) => (ch !== 'approval:respond' ? origHandle(ch, fn)
  : origHandle(ch, async (event, id, decision, ...rest) => { rec({ kind: 'ipc-in', id, decision }); const r = await fn(event, id, decision, ...rest); rec({ kind: 'ipc-core', id, decision, result: r }); return r; }));
const AP = require(path.join(APP, 'src/policy/approvals'));
const brokers = [];
const Orig = AP.ApprovalBroker;
AP.ApprovalBroker = class extends Orig { constructor(o) { super(o); brokers.push({ b: this, auto: Boolean(o && o.onAutoCancel) }); } };
const broker = () => (brokers.find((x) => x.auto) || brokers[0]).b;

const log = [];
const rec = (o) => { log.push({ t: Date.now(), ...o }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Фиктивный мозг: сценарий по метке; всегда один и тот же сырой id "call_0" ──
const plans = { R1: ['R1-A'], R2: ['R2-A', 'R2-B'], R3: ['R3-A'], R4: ['R4-A'], R5: ['R5-A'] };
function brainReply(messages) {
  const user = [...messages].reverse().find((m) => m.role === 'user');
  const key = (String(user && user.content || '').match(/\bR\d+\b/) || [])[0];
  const done = messages.slice(messages.lastIndexOf(user)).filter((m) => m.role === 'tool').length;
  const plan = plans[key] || [];
  if (done >= plan.length) return { content: 'Готово.' };
  return { tool: { id: 'call_0', name: 'workspace_write', args: { path: plan[done] + '.txt', content: plan[done] } } };
}
function startBrain() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch { /* */ }
        const r = brainReply(body.messages || []);
        const model = body.model || 'm';
        const msg = r.tool
          ? { role: 'assistant', content: '', tool_calls: [{ index: 0, id: r.tool.id, type: 'function', function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] }
          : { role: 'assistant', content: r.content };
        const fin = r.tool ? 'tool_calls' : 'stop';
        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model, choices: [{ index: 0, message: msg, finish_reason: fin }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const w = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
        w({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: r.tool ? { role: 'assistant', tool_calls: msg.tool_calls } : { role: 'assistant', content: r.content }, finish_reason: null }] });
        w({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: fin }] });
        w({ id: 'x', object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        res.write('data: [DONE]\n\n'); res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

let win = null;
let sendRaw = null;
const drop = new Set(); // id, чьи approval_closed стенд «теряет» по пути в окно
const js = (code) => win.webContents.executeJavaScript(code, true);
const written = () => fs.readdirSync(wsDir).filter((f) => /^R\d+-/.test(f)).sort();
const dlg = () => js(`(() => { const d = document.querySelector('#approvalDialog'); return {
  open: d.open, current: d.dataset.current || null, question: document.querySelector('#apQuestion').textContent,
  args: document.querySelector('#apArgs').textContent, queue: document.querySelector('#apQueue').hidden ? '' : document.querySelector('#apQueue').textContent,
  disabled: [...d.querySelectorAll('[data-decision]')].filter((b) => !b.hidden).map((b) => b.dataset.decision + ':' + b.disabled) }; })()`);
async function waitDlg(pred, ms = 15000) {
  const end = Date.now() + ms; let s;
  while (Date.now() < end) { s = await dlg(); if (pred(s)) return s; await sleep(50); }
  return { timeout: true, ...s };
}
async function send(text) {
  await js(`(() => { const ta = document.querySelector('#chatInput'); ta.focus(); ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
}
// Настоящий клик мышью по кнопке (sendInputEvent), а не element.click().
async function btnRect(decision) {
  return js(`(() => { const r = document.querySelector('#approvalDialog [data-decision="${decision}"]').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height }; })()`);
}
function mouseClick({ x, y }) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}
const key = (k) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); };
async function shot(name) {
  try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `r4c-only-shot-${tag}-${name}.png`), img.toPNG()); } catch (e) { rec({ kind: 'shot-error', name, e: String(e) }); }
}
async function idle(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const last = log.filter((e) => e.kind === 'ev' && e.type === 'status').at(-1);
    if (last && last.state === 'idle') return true; await sleep(150);
  }
  return false;
}
// Второй одновременный запрос — такой же, какой шлёт исполнитель задач: id «задача:uuid», taskId, свой callId.
// agentLike: запрос второго агента чата (пространство, параллельный агент): без taskId, «На сессию» доступно.
function injectTaskApproval(label, { agentLike = false } = {}) {
  const id = agentLike ? randomUUID() : `mtest:${randomUUID()}`;
  const payload = agentLike
    ? { id, approvalId: id, agentId: randomUUID(), callId: 'call_0', name: 'workspace_write', args: { path: label + '.txt', content: label }, risk: 'T1', reason: 'режим «ask»; риск T1', allowSession: true }
    : { id, approvalId: id, taskId: 'mtest', callId: 'call_0', name: 'workspace_write', args: { path: label + '.txt', content: label }, risk: 'T1', reason: 'инструмент требует подтверждения владельца', allowSession: false };
  const out = { id, label, decision: null };
  broker().request(payload).then((d) => { out.decision = d; rec({ kind: 'synthetic-resolved', id, label, decision: d }); });
  sendRaw('agent:event', { type: 'approval_request', ...broker().list().find((p) => p.id === id) });
  return out;
}
const results = [];
function row(o) { results.push({ ...o, ranNow: written() }); }

async function mainPhase() {
  // R4 — подмена содержимого под курсором: A истекает (автоотмена 30 с), в тот же диалог встаёт B.
  // B появляется через 10 с после A, поэтому у него ещё ~20 с. Клик «Разрешить», нацеленный на A,
  // приходит через ~60 мс после истечения A (владелец торопится из-за отсчёта).
  //   kind 'task'  — B как от исполнителя задач (без «На сессию»: кнопки сдвигаются);
  //   kind 'clone' — B второго агента того же вида, что A (та же раскладка).
  async function swapCase(rid, kind) {
    await send('R4 подмена под курсором');
    const s0 = await waitDlg((x) => x.open && /R4-A/.test(x.args));
    const idA = s0.current;
    const pa = broker().list().find((p) => p.id === idA);
    await sleep(10000);
    let B;
    if (kind === 'task') B = injectTaskApproval(`${rid}-B`);
    else {
      const id = randomUUID();
      const pb = { ...structuredClone(pa), id, approvalId: id, agentId: randomUUID(), args: { path: 'R4-X.txt', content: 'R4-X' } };
      delete pb.autoCancelAt; delete pb.runId; delete pb.preview;
      if (pa.preview) pb.preview = { ...structuredClone(pa.preview), path: 'R4-X.txt', diff: String(pa.preview.diff).replace(/R4-A/g, 'R4-X') };
      B = { id, decision: null };
      broker().request(pb).then((d) => { B.decision = d; rec({ kind: 'synthetic-resolved', id, decision: d }); });
      sendRaw('agent:event', { type: 'approval_request', ...broker().list().find((p) => p.id === id) });
    }
    await waitDlg((x) => x.queue === '1 из 2', 3000);
    const pos = await btnRect('once');
    await sleep(Math.max(0, pa.autoCancelAt - Date.now() - 300));
    await shot(`${rid}-A-before-expiry`);
    await sleep(Math.max(0, pa.autoCancelAt - Date.now() + 60));
    const clickAt = Date.now();
    const atClick = await dlg();
    const under = await js(`(() => { const e = document.elementFromPoint(${pos.x}, ${pos.y}); return e ? (e.dataset.decision || e.tagName) : null; })()`);
    mouseClick(pos);
    await sleep(1500);
    await shot(`${rid}-after-click`);
    const swapEv = log.find((e) => e.kind === 'ev' && e.type === 'approval_closed' && e.id === idA);
    const ipc = log.filter((e) => e.kind === 'ipc-in' && e.id === B.id).map((e) => e.decision);
    const decidedByClick = B.decision;
    if (B.decision === null) { key('Escape'); await sleep(1500); }
    await idle();
    row({ id: rid, scenario: `A истёк, B (${kind === 'task' ? 'задача, без «На сессию»' : 'второй агент, тот же вид'}) занял диалог; клик «Разрешить», нацеленный на A`,
      closedEventToClickMs: swapEv ? clickAt - swapEv.t : null, dialogAtClick: atClick.current === B.id ? 'B' : atClick.current === idA ? 'A' : atClick.current,
      elementUnderCursor: under, ipcForB: ipc, bDecisionByClick: decidedByClick, bDecisionFinal: B.decision,
      aRan: written().includes('R4-A.txt'), bRanWouldBe: decidedByClick === 'once', pass: decidedByClick !== 'once' });
  }
  await swapCase('R4c', 'clone');

}

function finish(code) {
  fs.writeFileSync(path.join(OUT, `r4c-only-${tag}.json`), JSON.stringify({ root, size: [W, H], results, log }, null, 2));
  console.log(JSON.stringify(results, null, 1));
  app.exit(code);
}

app.on('browser-window-created', (_e, w) => {
  if (win) return; win = w;
  sendRaw = w.webContents.send.bind(w.webContents);
  w.webContents.send = (ch, ev, ...rest) => {
    if (ch === 'agent:event' && ev && /approval|status/.test(ev.type)) rec({ kind: 'ev', type: ev.type, state: ev.state, id: ev.id, callId: ev.callId, path: ev.args && ev.args.path, decision: ev.decision });
    if (ch === 'agent:event' && ev && ev.type === 'approval_closed' && drop.has(ev.id)) { rec({ kind: 'dropped', id: ev.id }); return undefined; }
    return sendRaw(ch, ev, ...rest);
  };
  w.webContents.once('did-finish-load', async () => {
    try {
      await sleep(2500); w.setContentSize(W, H); w.show(); await sleep(500);
      await mainPhase();
      finish(0);
    } catch (e) { rec({ kind: 'fatal', e: String(e && e.stack || e) }); finish(1); }
  });
});
setTimeout(() => { rec({ kind: "fatal", e: "global timeout" }); finish(2); }, 400000).unref();

startBrain().then((port) => {
  process.env.NOX_BRAIN_KEY = 'run3-local-fake-key';
  process.env.NOX_BRAIN_URL = `http://127.0.0.1:${port}/v1`;
  require(path.join(APP, 'main.js'));
});
