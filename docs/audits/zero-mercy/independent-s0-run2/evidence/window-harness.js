'use strict';
// Независимый стенд run2: настоящее окно Nox во временном профиле, локальный фиктивный мозг,
// «действие» = workspace_write во временную рабочую папку (файл <метка>.txt). Реальных систем не трогаем.
// Запуск из apps/jarvis-desktop:  npx electron ../../docs/audits/zero-mercy/independent-s0-run2/evidence/window-harness.js --size 1200x720
//   повторный запуск того же профиля (проверка перезапуска): --phase restart --root <tempRoot>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const electron = require('electron');
const { app, ipcMain, globalShortcut } = electron;

const APP = path.resolve(__dirname, '../../../../../apps/jarvis-desktop');
const OUT = __dirname;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const [W, H] = arg('size', '1200x720').split('x').map(Number);
const PHASE = arg('phase', 'main');
const tag = `${PHASE}-${W}x${H}`;
const root = arg('root', null) || fs.mkdtempSync(path.join(os.tmpdir(), 'zm-run2-win-'));
const dataDir = path.join(root, 'data');
const wsDir = path.join(root, 'workspace');
for (const d of [path.join(root, 'profile'), dataDir, wsDir]) fs.mkdirSync(d, { recursive: true });
if (PHASE === 'main') fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ voice: false, backgroundModelRuns: false, mode: 'ask', watchWindow: false, watchTelegram: false }));
app.setPath('userData', path.join(root, 'profile'));
for (const k of Object.keys(process.env)) if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(k)) delete process.env[k];
require(path.join(APP, 'src/config/paths')).projectRoot = () => root;
globalShortcut.register = () => true; globalShortcut.unregister = () => {}; globalShortcut.unregisterAll = () => {};

const log = [];
const rec = (o) => { log.push({ t: Date.now(), ...o }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Сбои IPC: обёртка вокруг настоящего обработчика approval:respond ──
const fault = { mode: null }; // 'throw-before' | 'hang-after' | 'hang-before'
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (ch, fn) => {
  if (ch !== 'approval:respond') return origHandle(ch, fn);
  return origHandle(ch, async (event, id, decision) => {
    const m = fault.mode; fault.mode = null;
    rec({ kind: 'ipc-in', id, decision, fault: m });
    if (m === 'throw-before') throw new Error('synthetic IPC failure');
    if (m === 'hang-before') await sleep(8000);
    const r = await fn(event, id, decision);
    rec({ kind: 'ipc-core', id, decision, result: r });
    if (m === 'hang-after') await sleep(8000);
    return r;
  });
};

// ── Фиктивный мозг: сценарий по метке в сообщении; всегда один и тот же сырой id "call_0" ──
const plans = {
  W1: ['W1-A', 'W1-B'], W2: ['W2-C', 'W2-D'], W3: ['W3-E'], W4: ['W4-F'], W5: ['W5-G'],
  W6: ['W6-H'], W7: ['W7-I'], W8: ['W8-J'], W9: ['W9-K'], W10: ['W10-L'],
};
function brainReply(messages) {
  const user = [...messages].reverse().find((m) => m.role === 'user');
  const key = (String(user && user.content || '').match(/\bW\d+\b/) || [])[0];
  const lastUserIdx = messages.lastIndexOf(user);
  const done = messages.slice(lastUserIdx).filter((m) => m.role === 'tool').length;
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
const js = (code) => win.webContents.executeJavaScript(code, true);
const written = () => fs.readdirSync(wsDir).filter((f) => /^W\d+-/.test(f)).sort();
const dlg = () => js(`(() => { const d = document.querySelector('#approvalDialog'); return {
  open: d.open, current: d.dataset.current || null, question: document.querySelector('#apQuestion').textContent,
  args: document.querySelector('#apArgs').textContent, queue: document.querySelector('#apQueue').textContent,
  disabled: [...d.querySelectorAll('[data-decision]')].map((b) => b.disabled) }; })()`);
async function waitDlg(pred, ms = 15000) {
  const end = Date.now() + ms; let s;
  while (Date.now() < end) { s = await dlg(); if (pred(s)) return s; await sleep(100); }
  return { timeout: true, ...s };
}
const reqEvents = () => log.filter((e) => e.kind === 'ev' && e.type === 'approval_request');
async function send(text) {
  await js(`(() => { const ta = document.querySelector('#chatInput'); ta.focus(); ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
}
const click = (d) => js(`document.querySelector('#approvalDialog [data-decision="${d}"]').click()`);
async function shot(name) {
  try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `shot-${tag}-${name}.png`), img.toPNG()); } catch (e) { rec({ kind: 'shot-error', name, e: String(e) }); }
}
async function idle(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const last = log.filter((e) => e.kind === 'ev' && e.type === 'status').at(-1);
    if (last && last.state === 'idle') return true; await sleep(150);
  }
  return false;
}
const results = [];
function row(id, scenario, shown, permissionId, decision, expected) {
  const files = written();
  const match = JSON.stringify(expected) === JSON.stringify(files);
  results.push({ id, scenario, shown, permissionId, decision, ran: files, expectedRan: expected, match });
}

async function mainPhase() {
  // W1 ZM-001: одинаковый сырой id в двух шагах; одобряем A, Escape на B.
  await send('W1 одинаковые id');
  let s = await waitDlg((x) => x.open && /W1-A/.test(x.args));
  await shot('W1-dialog-A');
  const idA = s.current; await click('once');
  s = await waitDlg((x) => x.open && /W1-B/.test(x.args));
  const idB = s.current; await shot('W1-dialog-B');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  const afterEsc = await waitDlg((x) => !x.open, 5000);
  await idle();
  const ev = reqEvents();
  row('W1', 'ZM-001: тот же callId=call_0, A разрешено, B — Escape', `A: ${idA}; B: ${idB}; callId A/B: ${ev.map((e) => e.callId).join('/')}`, `${idA} ≠ ${idB}: ${idA !== idB}`, 'A=once, B=Escape(reject)', ['W1-A.txt']);
  results.at(-1).dialogClosedAfterEsc = !afterEsc.open;

  // W2 двойной клик: два click подряд на C; следующий D не должен одобриться вторым кликом.
  await send('W2 двойной клик');
  s = await waitDlg((x) => x.open && /W2-C/.test(x.args));
  const idC = s.current;
  await js(`(() => { const b = document.querySelector('#approvalDialog [data-decision="once"]'); b.click(); b.click(); })()`);
  s = await waitDlg((x) => x.open && /W2-D/.test(x.args));
  const filesBeforeD = written();
  const idD = s.current; await click('reject'); await idle();
  row('W2', 'двойной клик «Разрешить» на C, затем показан D', `C ${idC}, D ${idD}`, idC, 'C=once×2 (один дошёл), D=reject', ['W1-A.txt', 'W2-C.txt']);
  results.at(-1).dWrittenBeforeDecision = filesBeforeD.includes('W2-D.txt');
  results.at(-1).ipcCallsForC = log.filter((e) => e.kind === 'ipc-in' && e.id === idC).length;

  // W3 сбой IPC до решения: карточка остаётся, повторное «Разрешить» срабатывает один раз.
  await send('W3 сбой IPC');
  s = await waitDlg((x) => x.open && /W3-E/.test(x.args));
  const idE = s.current; fault.mode = 'throw-before'; await click('once');
  const afterFail = await waitDlg((x) => x.open && x.disabled.every((d) => !d), 7000);
  await shot('W3-after-ipc-fail');
  const filesAfterFail = written();
  await click('once'); await idle();
  row('W3', 'IPC упал до решения, затем повтор «Разрешить»', idE, idE, 'once (сбой) → once', ['W1-A.txt', 'W2-C.txt', 'W3-E.txt']);
  Object.assign(results.at(-1), { stillShownAfterFail: afterFail.open && afterFail.current === idE, ranAfterFail: filesAfterFail.includes('W3-E.txt') });

  // W4 ответ IPC завис после решения ядра: окно должно закрыть карточку по событию approval_closed.
  await send('W4 зависание после решения');
  s = await waitDlg((x) => x.open && /W4-F/.test(x.args));
  const idF = s.current; fault.mode = 'hang-after'; await click('once');
  const closed = await waitDlg((x) => !x.open, 4000);
  await idle(); await sleep(9000); // дождаться позднего ответа IPC
  const ghost = await dlg();
  row('W4', 'ядро приняло решение, ответ IPC пришёл через 8 с', idF, idF, 'once', ['W1-A.txt', 'W2-C.txt', 'W3-E.txt', 'W4-F.txt']);
  Object.assign(results.at(-1), { closedBeforeIpcReply: !closed.open, ghostAfterLateReply: ghost.open });

  // W5 зависание до решения: окно через 5 с снова даёт кнопки, владелец жмёт «Отклонить»; поздний once не должен сработать.
  await send('W5 зависание до решения');
  s = await waitDlg((x) => x.open && /W5-G/.test(x.args));
  const idG = s.current; fault.mode = 'hang-before'; await click('once');
  const reenabled = await waitDlg((x) => x.open && x.disabled.every((d) => !d), 7000);
  await click('reject'); await idle(); await sleep(4000);
  row('W5', 'once завис 8 с, через 5 с владелец передумал — reject', idG, idG, 'once (завис) → reject', ['W1-A.txt', 'W2-C.txt', 'W3-E.txt', 'W4-F.txt']);
  Object.assign(results.at(-1), { reenabledAfter5s: !reenabled.timeout, ipc: log.filter((e) => e.id === idG && e.kind !== 'ev').map((e) => `${e.kind}:${e.decision}:${e.result ? JSON.stringify(e.result) : ''}`) });

  // W6 стоп во время подтверждения.
  await send('W6 стоп');
  s = await waitDlg((x) => x.open && /W6-H/.test(x.args));
  const idH = s.current; await js('window.jarvis.stop()');
  const afterStop = await waitDlg((x) => !x.open, 5000); await idle();
  const late = await js(`window.jarvis.respondApproval(${JSON.stringify(idH)}, 'once')`);
  row('W6', 'стоп хода во время подтверждения, потом поздний once', idH, idH, 'stop → once (поздний)', ['W1-A.txt', 'W2-C.txt', 'W3-E.txt', 'W4-F.txt']);
  Object.assign(results.at(-1), { dialogClosed: !afterStop.open, lateAnswer: late });

  // W7 закрытие окна (скрытие в трей) во время подтверждения, ждём автоотмену 30 с.
  await send('W7 закрытие окна');
  s = await waitDlg((x) => x.open && /W7-I/.test(x.args));
  const idI = s.current; win.close(); await sleep(32000); win.show(); await idle(5000);
  const afterReopen = await dlg();
  row('W7', 'окно закрыто (в трей) во время подтверждения, 32 с', idI, idI, 'нет ответа → автоотмена', ['W1-A.txt', 'W2-C.txt', 'W3-E.txt', 'W4-F.txt']);
  Object.assign(results.at(-1), { dialogOpenAfterReopen: afterReopen.open, closedEvent: log.some((e) => e.kind === 'ev' && e.type === 'approval_closed' && e.id === idI) });

  // W8 перезагрузка окна (renderer) во время подтверждения.
  await send('W8 перезагрузка окна');
  s = await waitDlg((x) => x.open && /W8-J/.test(x.args));
  const idJ = s.current; win.webContents.reload(); await sleep(4000);
  const afterReload = await dlg();
  await sleep(30000);
  const lateJ = await js(`window.jarvis.respondApproval(${JSON.stringify(idJ)}, 'once')`);
  await sleep(1500);
  row('W8', 'перезагрузка окна во время подтверждения', idJ, idJ, 'нет кнопок после перезагрузки → автоотмена → поздний once', ['W1-A.txt', 'W2-C.txt', 'W3-E.txt', 'W4-F.txt']);
  Object.assign(results.at(-1), { cardRestoredAfterReload: afterReload.open, lateAnswer: lateJ });

  // W9 выход из приложения с открытым подтверждением (продолжение — фаза restart).
  await send('W9 перезапуск');
  s = await waitDlg((x) => x.open && /W9-K/.test(x.args));
  await shot('W9-pending-before-quit');
  results.push({ id: 'W9-pre', scenario: 'выход с ожидающим подтверждением', shown: s.current, ran: written() });
}

async function restartPhase() {
  await sleep(8000);
  const s = await dlg();
  results.push({ id: 'W9', scenario: 'перезапуск того же профиля после выхода с открытым подтверждением W9-K', dialogOpen: s.open, ran: written(), match: !written().includes('W9-K.txt') });
}

function finish(code) {
  fs.writeFileSync(path.join(OUT, `window-${tag}.json`), JSON.stringify({ root, size: [W, H], results, log }, null, 2));
  console.log(JSON.stringify(results, null, 1));
  console.log('ROOT=' + root);
  app.exit(code);
}

app.on('browser-window-created', (_e, w) => {
  if (win) return; win = w;
  const send0 = w.webContents.send.bind(w.webContents);
  w.webContents.send = (ch, ev, ...rest) => {
    if (ch === 'agent:event' && ev && /approval|status/.test(ev.type)) rec({ kind: 'ev', type: ev.type, state: ev.state, id: ev.id, callId: ev.callId, agentId: ev.agentId, path: ev.args && ev.args.path, decision: ev.decision });
    return send0(ch, ev, ...rest);
  };
  w.webContents.once('did-finish-load', async () => {
    try {
      await sleep(2500); w.setContentSize(W, H); w.show(); await sleep(500);
      if (PHASE === 'restart') await restartPhase(); else await mainPhase();
      finish(0);
    } catch (e) { rec({ kind: 'fatal', e: String(e && e.stack || e) }); finish(1); }
  });
});
setTimeout(() => { rec({ kind: 'fatal', e: 'global timeout' }); finish(2); }, 300000).unref();

startBrain().then((port) => {
  process.env.NOX_BRAIN_KEY = 'run2-local-fake-key';
  process.env.NOX_BRAIN_URL = `http://127.0.0.1:${port}/v1`;
  require(path.join(APP, 'main.js'));
});
