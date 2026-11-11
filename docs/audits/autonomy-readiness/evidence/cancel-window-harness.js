'use strict';
// Стенд отмены (ZM-004) в настоящем окне Nox: временный профиль, фиктивная модель на 127.0.0.1,
// два пробных инструмента без побочных эффектов. Основа — стенд S0.3 из zero-mercy.
// Запуск из apps/jarvis-desktop:
//   node_modules/electron/dist/electron.exe ../../docs/audits/autonomy-readiness/evidence/cancel-window-harness.js --size 1200x720
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const electron = require('electron');
const { app, globalShortcut } = electron;

const APP = path.resolve(__dirname, '../../../../apps/jarvis-desktop');
const OUT = __dirname;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const [W, H] = arg('size', '1200x720').split('x').map(Number);
const tag = `${W}x${H}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-cancel-win-'));
const dataDir = path.join(root, 'data');
for (const d of [path.join(root, 'profile'), dataDir, path.join(root, 'workspace')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ voice: false, backgroundModelRuns: false, mode: 'ask', watchWindow: false, watchTelegram: false }));
app.setPath('userData', path.join(root, 'profile'));
for (const k of Object.keys(process.env)) if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(k)) delete process.env[k];
require(path.join(APP, 'src/config/paths')).projectRoot = () => root;
globalShortcut.register = () => true; globalShortcut.unregister = () => {}; globalShortcut.unregisterAll = () => {};
electron.Notification.isSupported = () => false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const rec = (o) => log.push({ t: Date.now(), ...o });

// Пробные инструменты: ничего не делают, только ждут. deaf не слушает отмену, polite слушает.
const DEAF_MS = 2500;
const probe = { deafFinishedAt: 0, politeAborted: false };
const probeTools = () => [
  { name: 'probe_deaf', description: 'проба: не слушает отмену', risk: 'T0', parameters: { type: 'object', properties: {} },
    run: () => new Promise((resolve) => setTimeout(() => { probe.deafFinishedAt = Date.now(); resolve({ ok: true, summary: 'проба завершилась сама' }); }, DEAF_MS)) },
  { name: 'probe_polite', description: 'проба: слушает отмену', risk: 'T0', parameters: { type: 'object', properties: {} },
    run: (a, ctx) => new Promise((resolve) => { const timer = setTimeout(() => resolve({ ok: true, summary: 'не должно случиться' }), 20000);
      ctx.signal.addEventListener('abort', () => { probe.politeAborted = true; clearTimeout(timer); resolve({ ok: false, summary: 'проба прервана по сигналу' }); }); }) },
  // hang отвечает через 9 с: дольше предела ожидания после стопа (5 с), но всё же отвечает.
  { name: 'probe_hang', description: 'проба: отвечает слишком поздно', risk: 'T0', parameters: { type: 'object', properties: {} },
    run: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, summary: 'проба ответила поздно' }), 9000)) },
];
const { ToolRegistry } = require(path.join(APP, 'src/tools/registry'));
const seeded = new WeakSet();
const origRegister = ToolRegistry.prototype.register;
ToolRegistry.prototype.register = function register(tool) {
  // Реестры копируют инструменты друг из друга: пробный инструмент второй раз не добавляем.
  if (tool && /^probe_/.test(tool.name) && this.get(tool.name)) return undefined;
  if (!seeded.has(this)) { seeded.add(this); for (const t of probeTools()) if (!this.get(t.name)) origRegister.call(this, t); }
  if (tool && /^probe_/.test(tool.name) && this.get(tool.name)) return undefined;
  return origRegister.call(this, tool);
};

// Фиктивная модель: «DEAF» и «POLITE» в сообщении — вызов пробного инструмента, иначе короткий текст.
let modelCalls = 0;
function brainReply(messages) {
  const user = [...messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
  const text = String((user && user.content) || '');
  const done = messages.slice(messages.lastIndexOf(user)).filter((m) => m.role === 'tool').length;
  const name = /DEAF/.test(text) ? 'probe_deaf' : /POLITE/.test(text) ? 'probe_polite' : /HANG/.test(text) ? 'probe_hang' : null;
  if (!name || done >= 1) return { content: 'Обычный ответ после проверки.' };
  return { tool: { id: 'call_0', name, args: {} } };
}
function startBrain() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch { /* пустой запрос */ }
        modelCalls += 1;
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
const events = []; // события ядра, дошедшие до окна
const js = (code) => win.webContents.executeJavaScript(code, true);
async function shot(name) {
  try { win.webContents.invalidate(); await sleep(150); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `cancel-${tag}-${name}.png`), img.toPNG()); } catch (e) { rec({ kind: 'shot-error', e: String(e) }); }
}
async function send(text) {
  await js(`(() => { const ta = document.querySelector('#chatInput'); ta.focus(); ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
}
// Что видит владелец: строки действий, сводка хода, уведомления, строка «Ход работы» экрана Nox.
const view = () => js(`(() => { const txt = (e) => (e ? e.innerText.replace(/\\s+/g, ' ').trim() : null); return {
  rows: [...document.querySelectorAll('.act-row')].map((r) => ({ text: txt(r), status: r.dataset.status || (r.querySelector('[data-status]') || {}).dataset?.status || null })),
  sums: [...document.querySelectorAll('.acts-sum')].map(txt),
  notices: [...document.querySelectorAll('.notice')].map(txt),
  working: [...document.querySelectorAll('.nox-working-text')].map(txt),
  spinners: document.querySelectorAll('.act-row .spinner, .act-row [data-icon="spinner"]').length,
  stopVisible: (() => { const b = document.querySelector('#chatStop'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !b.hidden && !b.disabled; })(),
}; })()`);
async function waitFor(pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(40); }
  return false;
}
async function clickStop() {
  const p = await js(`(() => { const b = document.querySelector('#chatStop'); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width }; })()`);
  if (!p.w) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); return 'esc'; }
  win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  return 'mouse';
}
const journal = () => {
  const file = path.join(dataDir, 'journal.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .map((j) => ({ tool: j.tool, ok: j.ok, status: j.status, decision: j.decision, afterStop: j.afterStop === true, summary: j.summary }));
};
const since = (i) => events.slice(i).map((e) => e.type + (e.state ? ':' + e.state : '') + (e.afterStop ? ':afterStop' : ''));

const results = [];
async function scenario(id, text, tool, body) {
  const from = events.length;
  const callsBefore = modelCalls;
  await send(text);
  const started = await waitFor(async () => events.slice(from).some((e) => e.type === 'tool_start' && e.name === tool), 20000);
  await sleep(300);
  const before = await view();
  await shot(`${id}-1-running`);
  const stopAt = Date.now();
  const how = started ? await clickStop() : 'not-started';
  const doneSeen = await waitFor(async () => events.slice(from).some((e) => e.type === 'done'), 5000);
  const doneAfterMs = Date.now() - stopAt;
  await sleep(250);
  const atStop = await view();
  await shot(`${id}-2-stopped`);
  const out = await body({ from, stopAt, before, atStop });
  results.push({ id, tool, started, stopBy: how, doneSeen, doneAfterMs, modelCallsInScenario: modelCalls - callsBefore,
    events: since(from), before, atStop, ...out });
}

async function mainPhase() {
  // S1. Действие не слушает отмену и завершается само через 2,5 с после начала.
  await scenario('S1', 'проверка DEAF', 'probe_deaf', async ({ from, stopAt, atStop }) => {
    const lateSeen = await waitFor(async () => events.slice(from).some((e) => e.type === 'tool_result' && e.afterStop), DEAF_MS + 3000);
    await sleep(400);
    const after = await view();
    await shot('S1-3-late-result');
    const ev = events.slice(from);
    const late = ev.find((e) => e.type === 'tool_result' && e.afterStop) || {};
    const j = journal().filter((x) => x.tool === 'probe_deaf');
    const pass = lateSeen && late.ok === true && /после запроса остановки/.test(String(late.summary))
      && ev.filter((e) => e.type === 'done').length === 1
      && atStop.notices.some((n) => /ещё завершается/.test(n || ''))
      && after.rows.some((r) => /после запроса остановки/.test(r.text || ''))
      && after.working.every((w) => !/Выполняется/.test(w || ''))
      && j.length === 1 && j[0].ok === true && j[0].afterStop === true;
    return { lateSeen, lateAfterStopMs: probe.deafFinishedAt ? probe.deafFinishedAt - stopAt : null, late: { ok: late.ok, status: late.status, summary: late.summary }, after, journal: j, pass };
  });

  // S2. Действие слушает отмену и прерывается.
  await scenario('S2', 'проверка POLITE', 'probe_polite', async ({ from }) => {
    const lateSeen = await waitFor(async () => events.slice(from).some((e) => e.type === 'tool_result'), 4000);
    await sleep(400);
    const after = await view();
    await shot('S2-3-aborted');
    const ev = events.slice(from);
    const late = ev.find((e) => e.type === 'tool_result') || {};
    const j = journal().filter((x) => x.tool === 'probe_polite');
    const pass = probe.politeAborted && lateSeen && late.ok === false && late.afterStop === true
      && ev.filter((e) => e.type === 'done').length === 1
      && after.working.every((w) => !/Выполняется/.test(w || ''))
      && j.length === 1 && j[0].ok === false;
    return { politeAborted: probe.politeAborted, late: { ok: late.ok, status: late.status, summary: late.summary, afterStop: late.afterStop === true }, after, journal: j, pass };
  });

  // S4. Действие не отвечает дольше предела: ход закрыт, строка «исход неизвестен», агент свободен, поздний итог дописан.
  await scenario('S4', 'проверка HANG', 'probe_hang', async ({ from }) => {
    const hungSeen = await waitFor(async () => events.slice(from).some((e) => e.type === 'tool_result' && e.hung), 8000);
    await sleep(300);
    const atHung = await view();
    await shot('S4-3-hung');
    // Пока действие ещё висит, новый ход должен пройти.
    const mid = events.length;
    await send('вопрос во время зависшего действия');
    const freeTurn = await waitFor(async () => events.slice(mid).some((e) => e.type === 'done' && e.status === 'succeeded'), 6000);
    const lateSeen = await waitFor(async () => events.slice(from).some((e) => e.type === 'tool_result' && e.late), 9000);
    await sleep(400);
    const after = await view();
    await shot('S4-4-late');
    const j = journal().filter((x) => x.tool === 'probe_hang');
    const pass = hungSeen && freeTurn && lateSeen
      && atHung.rows.some((r) => /не удалось остановить/.test(r.text || '') && r.status === 'unverified')
      && after.rows.some((r) => /после запроса остановки: проба ответила поздно/.test(r.text || ''))
      && j.length === 2 && j[0].ok === false && j[1].ok === true;
    return { hungSeen, freeTurn, lateSeen, atHung, after, journal: j, pass };
  });

  // S3. Следующий обычный ход после двух остановок работает и не тянет за собой прошлое.
  {
    const from = events.length;
    await send('обычный вопрос');
    const doneSeen = await waitFor(async () => events.slice(from).some((e) => e.type === 'done'), 15000);
    await sleep(400);
    const after = await view();
    await shot('S3-next-turn');
    const ev = events.slice(from);
    const done = ev.find((e) => e.type === 'done') || {};
    const answer = await js(`document.body.innerText.includes('Обычный ответ после проверки.')`);
    results.push({ id: 'S3', doneSeen, doneStatus: done.status, events: since(from), answerShown: answer, after,
      pass: doneSeen && done.status === 'succeeded' && answer && !ev.some((e) => e.afterStop) });
  }
}

function finish(code) {
  fs.writeFileSync(path.join(OUT, `cancel-window-${tag}.json`), JSON.stringify({ at: new Date().toISOString(), size: [W, H], electron: process.versions.electron, results, log }, null, 2));
  console.log(JSON.stringify(results.map((r) => ({ id: r.id, pass: r.pass })), null, 1));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* профиль занят: останется во временной папке */ }
  app.exit(code);
}

app.on('browser-window-created', (_e, w) => {
  if (win) return; win = w;
  const sendRaw = w.webContents.send.bind(w.webContents);
  // Окно стенда может быть закрыто другими окнами: без этого Chromium замедляет таймеры и не перерисовывает кадр.
  w.webContents.setBackgroundThrottling(false);
  w.webContents.send = (ch, ev, ...rest) => {
    if (ch === 'agent:event' && ev && ev.type !== 'text') events.push({ t: Date.now(), type: ev.type, state: ev.state, name: ev.name, ok: ev.ok, status: ev.status, summary: ev.summary, afterStop: ev.afterStop === true, hung: ev.hung === true, late: ev.late === true });
    return sendRaw(ch, ev, ...rest);
  };
  w.webContents.on('console-message', (_ev, level, message) => { if (level >= 3) rec({ kind: 'console-error', message: String(message).slice(0, 300) }); });
  w.webContents.once('did-finish-load', async () => {
    try {
      await sleep(2500); w.setContentSize(W, H); w.show(); w.focus(); await sleep(500);
      rec({ kind: 'env', visible: w.isVisible(), focused: w.isFocused() });
      await mainPhase();
      finish(results.every((x) => x.pass) ? 0 : 3);
    } catch (e) { rec({ kind: 'fatal', e: String((e && e.stack) || e) }); finish(1); }
  });
});
setTimeout(() => { rec({ kind: 'fatal', e: 'global timeout' }); finish(2); }, 180000).unref();

startBrain().then((port) => {
  process.env.NOX_BRAIN_KEY = 'cancel-local-fake-key';
  process.env.NOX_BRAIN_URL = `http://127.0.0.1:${port}/v1`;
  require(path.join(APP, 'main.js'));
});
