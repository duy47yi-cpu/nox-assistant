'use strict';
// Стенд S0.3: настоящее окно Nox во временном профиле, проверка исправления R3-01 и R3-02.
// Основа — стенд прогона 3 (фиктивный мозг на 127.0.0.1, workspace_write во временную папку,
// второй запрос в НАСТОЯЩЕМ брокере main.js). Обёртка approval:respond передаёт все аргументы (токен показа).
// Запуск из apps/jarvis-desktop:
//   node_modules/electron/dist/electron.exe ../../docs/audits/zero-mercy/remediation-s0.3/evidence/window-harness-s03.js --size 1200x720
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-s03-win-'));
const dataDir = path.join(root, 'data');
const wsDir = path.join(root, 'workspace');
for (const d of [path.join(root, 'profile'), dataDir, wsDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ voice: false, backgroundModelRuns: false, mode: 'ask', watchWindow: false, watchTelegram: false }));
app.setPath('userData', path.join(root, 'profile'));
for (const k of Object.keys(process.env)) if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(k)) delete process.env[k];
require(path.join(APP, 'src/config/paths')).projectRoot = () => root;
globalShortcut.register = () => true; globalShortcut.unregister = () => {}; globalShortcut.unregisterAll = () => {};
electron.Notification.isSupported = () => false;

const origHandle = electron.ipcMain.handle.bind(electron.ipcMain);
electron.ipcMain.handle = (ch, fn) => (ch !== 'approval:respond' ? origHandle(ch, fn)
  : origHandle(ch, async (event, id, decision, ...rest) => { rec({ kind: 'ipc-in', id, decision, token: Boolean(rest[0]) }); const r = await fn(event, id, decision, ...rest); rec({ kind: 'ipc-core', id, decision, result: r }); return r; }));
const AP = require(path.join(APP, 'src/policy/approvals'));
const brokers = [];
const Orig = AP.ApprovalBroker;
AP.ApprovalBroker = class extends Orig { constructor(o) { super(o); brokers.push({ b: this, auto: Boolean(o && o.onAutoCancel) }); } };
const broker = () => (brokers.find((x) => x.auto) || brokers[0]).b;

const log = [];
const rec = (o) => { log.push({ t: Date.now(), ...o }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Фиктивный мозг: на сообщение с меткой N<число> — один workspace_write «<метка>-A», id всегда call_0.
function brainReply(messages) {
  const user = [...messages].reverse().find((m) => m.role === 'user');
  const key = (String(user && user.content || '').match(/\bN\d+\b/) || [])[0];
  const done = messages.slice(messages.lastIndexOf(user)).filter((m) => m.role === 'tool').length;
  if (!key || done >= 1) return { content: 'Готово.' };
  const label = key + '-A';
  return { tool: { id: 'call_0', name: 'workspace_write', args: { path: label + '.txt', content: label } } };
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
const js = (code) => win.webContents.executeJavaScript(code, true);
const written = () => fs.readdirSync(wsDir).filter((f) => /^N\d+-/.test(f)).sort();
const dlg = () => js(`(() => { const d = document.querySelector('#approvalDialog'); const nx = document.querySelector('#apNext'); return {
  open: d.open, current: d.dataset.current || null, question: document.querySelector('#apQuestion').textContent,
  args: document.querySelector('#apArgs').textContent, queue: document.querySelector('#apQueue').hidden ? '' : document.querySelector('#apQueue').textContent,
  gate: Boolean(nx && !nx.hidden),
  buttons: [...d.querySelectorAll('[data-decision]')].filter((b) => !b.hidden).map((b) => b.dataset.decision + ':' + (b.disabled ? 'off' : 'on')) }; })()`);
async function waitDlg(pred, ms = 15000) {
  const end = Date.now() + ms; let s;
  while (Date.now() < end) { s = await dlg(); if (pred(s)) return s; await sleep(40); }
  return { timeout: true, ...s };
}
const armed = (x) => x.open && x.buttons.includes('once:on');
async function send(text) {
  await js(`(() => { const ta = document.querySelector('#chatInput'); ta.focus(); ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
}
async function rect(sel) {
  return js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height }; })()`);
}
const onceSel = '#approvalDialog [data-decision="once"]';
const under = (p) => js(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e ? (e.dataset.decision || e.id || e.tagName) : null; })()`);
const down = ({ x, y }, n = 1) => { win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: n }); };
const up = ({ x, y }, n = 1) => win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: n });
const click = (p, n = 1) => { down(p, n); up(p, n); };
const key = (k) => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
  if (k === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k });
};
async function shot(name) {
  try { win.webContents.invalidate(); await sleep(120); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `shot-${tag}-${name}.png`), img.toPNG()); } catch (e) { rec({ kind: 'shot-error', name, e: String(e) }); }
}
async function idle(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const last = log.filter((e) => e.kind === 'ev' && e.type === 'status').at(-1);
    if (last && last.state === 'idle') return true; await sleep(150);
  }
  return false;
}
// Второй запрос того же вида, что запрос чата A (второй агент): та же раскладка кнопок.
function injectClone(label) {
  const id = randomUUID();
  const payload = { id, approvalId: id, agentId: randomUUID(), callId: 'call_0', name: 'workspace_write', args: { path: label + '.txt', content: label }, risk: 'T1', reason: 'режим «ask»; риск T1', allowSession: true };
  const out = { id, label, decision: null };
  broker().request(payload).then((d) => { out.decision = d; rec({ kind: 'synthetic-resolved', id, label, decision: d }); });
  sendRaw('agent:event', { type: 'approval_request', ...broker().list().find((p) => p.id === id) });
  return out;
}
// Синтетический B исполняет «своё действие» только при once/session: пишет файл, как сделал бы инструмент.
function runIfApproved(B) { if (B.decision === 'once' || B.decision === 'session') fs.writeFileSync(path.join(wsDir, B.label + '.txt'), B.label); }
const ipcFor = (id) => log.filter((e) => e.kind === 'ipc-in' && e.id === id).map((e) => e.decision);
const results = [];
const HOOK = "(() => { window.__closes = []; const o = HTMLDialogElement.prototype.close;\n  HTMLDialogElement.prototype.close = function (...x) { if (this.id === 'approvalDialog') window.__closes.push({ t: Date.now(), stack: String(new Error().stack).split(String.fromCharCode(10)).slice(1, 6).join(' | ') }); return o.apply(this, x); };\n  document.querySelector('#approvalDialog').addEventListener('close', () => window.__closes.push({ t: Date.now(), ev: 'close' })); return true; })()";
async function row(o) { let closes = []; try { closes = await js('(window.__closes || []).splice(0)'); } catch { /* перезагрузка */ } results.push({ ...o, ranNow: written(), closes }); rec({ kind: 'row', id: o.id, pass: o.pass }); }

async function startA(n) {
  await send(`${n} проверка`);
  const s = await waitDlg((x) => x.open && new RegExp(`${n}-A`).test(x.args));
  const idA = s.current;
  const pa = broker().list().find((p) => p.id === idA);
  return { idA, pa };
}
async function cleanup() {
  for (let i = 0; i < 4; i++) { const s = await dlg(); if (!s.open) break; key('Escape'); await sleep(900); }
  await idle();
  // Оставшиеся в очереди синтетические запросы снимаем, как исполнитель задач: отказ + approval_closed окну.
  // Иначе следующий сценарий откроет диалог на старом запросе (он раньше в очереди).
  for (const p of broker().list()) {
    broker().respond(p.id, 'reject');
    sendRaw('agent:event', { type: 'approval_closed', id: p.id, approvalId: p.id, decision: 'reject', cancelled: true });
    rec({ kind: 'cleanup-reject', id: p.id });
  }
  await sleep(300);
}
// Явно открыть B и подтвердить его осознанно: «Показать следующий», ждать включения, «Разрешить».
async function approveBDeliberately(B) {
  const s = await dlg();
  if (s.gate) click(await rect('#apNext'));
  const shown = await waitDlg((x) => x.open && x.current === B.id && !x.gate, 4000);
  const early = await dlg();
  const ready = await waitDlg(armed, 4000);
  click(await rect(onceSel));
  await sleep(1200);
  runIfApproved(B);
  return { shownB: !shown.timeout, buttonsRightAfterOpen: early.buttons, armedLater: !ready.timeout, decision: B.decision };
}

async function mainPhase() {
  await js(HOOK);
  // N1 — исходный R4c: A истекает, B того же вида ждёт; клик мышью «Разрешить», нацеленный на A, через ~60 мс.
  {
    const { idA, pa } = await startA('N1');
    await sleep(10000);
    const B = injectClone('N1-X');
    await waitDlg((x) => x.queue === '1 из 2', 3000);
    const stayedOnA = (await dlg()).current === idA;
    const pos = await rect(onceSel);
    await sleep(Math.max(0, pa.autoCancelAt - Date.now() - 300));
    await shot('N1-A-before-expiry');
    await sleep(Math.max(0, pa.autoCancelAt - Date.now() + 60));
    const closed = log.find((e) => e.kind === 'ev' && e.type === 'approval_closed' && e.id === idA);
    const atClick = await dlg();
    const u = await under(pos);
    const clickAt = Date.now();
    click(pos);
    await sleep(1200);
    await shot('N1-after-click');
    const byClick = B.decision;
    const ipcB = ipcFor(B.id);
    const after = await dlg();
    // Затем B отдельно и осознанно.
    const later = await approveBDeliberately(B);
    await shot('N1-B-approved');
    await cleanup();
    await row({ id: 'N1', scenario: 'R4c: A истёк, B того же вида в очереди; клик «Разрешить», нацеленный на A; потом B открыт и подтверждён отдельно',
      newRequestKeptOffA: stayedOnA, closedEventToClickMs: closed ? clickAt - closed.t : null, dialogAtClick: atClick.gate ? 'закрыт (gate)' : (atClick.current === B.id ? 'B' : atClick.current),
      elementUnderCursor: u, ipcForBFromClick: ipcB, bDecisionByClick: byClick, dialogAfterClick: { gate: after.gate, current: after.current },
      later, pass: byClick === null && !ipcB.includes('once') && later.decision === 'once' && written().includes('N1-X.txt') && !written().includes('N1-A.txt') });
  }

  // N2 — Enter: фокус на «Разрешить» у A, A истекает, Enter через ~60 мс.
  {
    const { pa } = await startA('N2');
    await sleep(10000);
    const B = injectClone('N2-X');
    await waitDlg(armed, 3000);
    await js(`document.querySelector(${JSON.stringify(onceSel)}).focus()`);
    await sleep(Math.max(0, pa.autoCancelAt - Date.now() + 60));
    const atKey = await dlg();
    key('Enter');
    await sleep(1200);
    const afterEnter = await dlg();
    await shot('N2-after-enter');
    const byEnter = B.decision;
    const ipcB = ipcFor(B.id);
    await cleanup();
    runIfApproved(B);
    await row({ id: 'N2', scenario: 'фокус на «Разрешить» у A, A истёк, Enter; B не должен быть одобрен',
      dialogAtKey: atKey.gate ? 'закрыт (gate)' : atKey.current, afterEnter: { gate: afterEnter.gate, current: afterEnter.current === B.id ? 'B' : afterEnter.current, buttons: afterEnter.buttons },
      ipcForB: ipcB, bDecisionByEnter: byEnter, bFinal: B.decision, pass: byEnter === null && !ipcB.includes('once') && !written().includes('N2-X.txt') });
  }

  // N3 — двойной клик «Разрешить» у A при ждущем B: A — один раз, B не тронут; затем B кнопки работают (R3-02).
  {
    const { idA } = await startA('N3');
    const B = injectClone('N3-X');
    await waitDlg((x) => x.queue === '1 из 2', 3000);
    await waitDlg(armed, 3000);
    const pos = await rect(onceSel);
    click(pos, 1); await sleep(40); click(pos, 2);
    await sleep(1200);
    const afterDbl = await dlg();
    await shot('N3-after-double');
    const ipcA = ipcFor(idA);
    const byDbl = B.decision;
    await idle();
    const later = await approveBDeliberately(B);
    await cleanup();
    await row({ id: 'N3', scenario: 'двойной клик «Разрешить» у A при ждущем B; потом B отдельно',
      ipcForA: ipcA, afterDouble: { gate: afterDbl.gate, current: afterDbl.current === B.id ? 'B' : afterDbl.current, buttons: afterDbl.buttons },
      bDecisionByDouble: byDbl, later,
      pass: byDbl === null && ipcA.filter((d) => d === 'once').length === 1 && written().includes('N3-A.txt') && later.decision === 'once' && later.buttonsRightAfterOpen.includes('reject:on') && written().includes('N3-X.txt') });
  }

  // N4 — нажатие начато на A (mouseDown), A истекает, отпускание (mouseUp) уже после.
  {
    const { pa } = await startA('N4');
    await sleep(10000);
    const B = injectClone('N4-X');
    await waitDlg(armed, 3000);
    const pos = await rect(onceSel);
    await sleep(Math.max(0, pa.autoCancelAt - Date.now() - 200));
    down(pos);
    await sleep(Math.max(0, pa.autoCancelAt - Date.now() + 80));
    const atUp = await dlg();
    up(pos);
    await sleep(1200);
    const ipcB = ipcFor(B.id);
    const byUp = B.decision;
    await cleanup();
    runIfApproved(B);
    await row({ id: 'N4', scenario: 'нажатие мыши начато на A, отпущено после истечения A',
      dialogAtUp: atUp.gate ? 'закрыт (gate)' : atUp.current, ipcForB: ipcB, bDecisionByRelease: byUp, pass: byUp === null && !ipcB.includes('once') && !written().includes('N4-X.txt') });
  }

  // N5 — отмена и таймаут: Escape у A (отказ), Escape в «закрыт» (диалог закрыт, B ждёт), B истекает сам.
  {
    const { idA } = await startA('N5');
    const B = injectClone('N5-X');
    await waitDlg((x) => x.queue === '1 из 2', 3000);
    key('Escape');
    // Esc с недавним действием пользователя приходит событием cancel → «закрыт»; без него браузер закрывает диалог сам.
    const afterEsc = await waitDlg((x) => x.gate || !x.open, 4000);
    await shot('N5-after-escape');
    const gate = { timeout: !afterEsc.gate };
    if (afterEsc.gate) key('Escape');
    const closed = await waitDlg((x) => !x.open, 4000);
    await sleep(500);
    const aRejected = ipcFor(idA).includes('reject');
    const bPendingAfterClose = broker().list().some((p) => p.id === B.id);
    const bAfterClose = B.decision;
    await idle();
    const endAt = (broker().list().find((p) => p.id === B.id) || {}).autoCancelAt || Date.now();
    await sleep(Math.max(0, endAt - Date.now() + 1500));
    const ipcB = ipcFor(B.id);
    runIfApproved(B);
    await row({ id: 'N5', scenario: 'Escape у A → отказ A («закрыт» или закрытый диалог); диалог закрыт, B ждёт; B истекает без ответа',
      ipcForA: ipcFor(idA), gateShown: !gate.timeout, closedByEscape: !closed.timeout, bPendingAfterClose, bAfterClose, bFinal: B.decision, ipcForB: ipcB,
      aRejected, pass: aRejected && !closed.timeout && bPendingAfterClose && bAfterClose === null && B.decision === 'reject' && ipcB.length === 0 && !written().some((f) => f.startsWith('N5')) });
  }

  // N6 — смена очереди: A показан и включён, приходит B, клик «Разрешить» через ~30 мс — одобрен A, не B.
  {
    const { idA } = await startA('N6');
    await waitDlg(armed, 3000);
    const pos = await rect(onceSel);
    const B = injectClone('N6-X');
    await sleep(30);
    const atClick = await dlg();
    click(pos);
    await sleep(1200);
    const afterA = await dlg();
    const ipcA = ipcFor(idA);
    const byClick = B.decision;
    await idle();
    // B открыт явно и отклонён мышью: кнопки B живые (R3-02).
    if ((await dlg()).gate) click(await rect('#apNext'));
    await waitDlg((x) => x.current === B.id, 4000);
    const bButtons = (await dlg()).buttons;
    click(await rect('#approvalDialog [data-decision="reject"]'));
    await sleep(1200);
    await cleanup();
    runIfApproved(B);
    await row({ id: 'N6', scenario: 'B пришёл, когда A уже на экране; клик через 30 мс одобряет A; затем B открыт и отклонён мышью',
      dialogAtClick: atClick.current === idA ? 'A' : atClick.current, queueAtClick: atClick.queue, ipcForA: ipcA, bDecisionByClick: byClick,
      afterA: { gate: afterA.gate }, bButtons, bFinal: B.decision,
      pass: atClick.current === idA && ipcA.includes('once') && byClick === null && written().includes('N6-A.txt') && B.decision === 'reject' && bButtons.includes('reject:on') });
  }

  // N7 — проверка ядра: согласие мимо интерфейса без токена, с чужим токеном, после закрытия показа.
  {
    const A = injectClone('N7-A');
    const B = injectClone('N7-B');
    await waitDlg((x) => x.open && x.current === A.id, 4000);
    await waitDlg(armed, 3000);
    const r = await js(`(async () => {
      const j = window.jarvis;
      const noToken = await j.respondApproval(${JSON.stringify(B.id)}, 'once');
      const ta = await j.markApprovalShown(${JSON.stringify(A.id)});
      const foreign = await j.respondApproval(${JSON.stringify(B.id)}, 'once', ta.token);
      const sessionForeign = await j.respondApproval(${JSON.stringify(B.id)}, 'session', ta.token);
      return { noToken, foreign, sessionForeign };
    })()`);
    await sleep(300);
    const byCore = B.decision;
    await cleanup();
    // Как исполнитель задач: снятый запрос сообщается окну событием approval_closed (иначе остаётся устаревшая карточка, R3-03).
    for (const x of [A, B]) {
      if (x.decision === null) { broker().respond(x.id, 'reject'); sendRaw('agent:event', { type: 'approval_closed', id: x.id, approvalId: x.id, decision: 'reject', cancelled: true }); }
      runIfApproved(x);
    }
    await sleep(300);
    await row({ id: 'N7', scenario: 'ядро: «once»/«session» для B без токена и с токеном показа A', core: r, bDecisionByCore: byCore,
      pass: r.noToken.ok === false && r.foreign.ok === false && r.sessionForeign.ok === false && byCore === null && !written().includes('N7-B.txt') });
  }

  // N8 — восстановление после перезагрузки окна и подтверждение восстановленной карточки (R1 прогона 3).
  {
    const { idA } = await startA('N8');
    win.webContents.reload();
    const restored = await waitDlg((x) => x.open && x.current === idA, 12000);
    const ready = await waitDlg(armed, 4000);
    click(await rect(onceSel));
    await waitDlg((x) => !x.open, 5000); await idle();
    await row({ id: 'N8', scenario: 'перезагрузка окна, восстановленная карточка, «Разрешить»', restored: !restored.timeout, armed: !ready.timeout,
      pass: !restored.timeout && written().includes('N8-A.txt') });
  }
}

function finish(code) {
  fs.writeFileSync(path.join(OUT, `window-s03-${tag}.json`), JSON.stringify({ root, size: [W, H], results, log }, null, 2));
  console.log(JSON.stringify(results, null, 1));
  app.exit(code);
}

app.on('browser-window-created', (_e, w) => {
  if (win) return; win = w;
  sendRaw = w.webContents.send.bind(w.webContents);
  // Окно стенда может быть закрыто другими окнами: без этого Chromium замедляет таймеры и не перерисовывает кадр.
  w.webContents.setBackgroundThrottling(false);
  w.webContents.send = (ch, ev, ...rest) => {
    if (ch === 'agent:event' && ev && /approval|status/.test(ev.type)) rec({ kind: 'ev', type: ev.type, state: ev.state, id: ev.id, decision: ev.decision });
    return sendRaw(ch, ev, ...rest);
  };
  w.webContents.once('did-finish-load', async () => {
    try {
      await sleep(2500); w.setContentSize(W, H); w.show(); w.focus(); await sleep(500);
      rec({ kind: 'env', visible: w.isVisible(), focused: w.isFocused(), throttling: false });
      await mainPhase();
      finish(results.every((x) => x.pass) ? 0 : 3);
    } catch (e) { rec({ kind: 'fatal', e: String(e && e.stack || e) }); finish(1); }
  });
});
setTimeout(() => { rec({ kind: 'fatal', e: 'global timeout' }); finish(2); }, 600000).unref();

startBrain().then((port) => {
  process.env.NOX_BRAIN_KEY = 's03-local-fake-key';
  process.env.NOX_BRAIN_URL = `http://127.0.0.1:${port}/v1`;
  require(path.join(APP, 'main.js'));
});
