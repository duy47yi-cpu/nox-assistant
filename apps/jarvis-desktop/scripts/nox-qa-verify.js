'use strict';

// Независимая проверка первого экрана Nox в изолированном профиле.
// Запуск (ELECTRON_RUN_AS_NODE снят), из apps/jarvis-desktop:
//   .\node_modules\electron\dist\electron.exe scripts\nox-qa-verify.js
//     [--out-dir <папка>] [--keep-temp]
//
// Что делает: поднимает НАСТОЯЩЕЕ приложение (require('../main')) с временными
// userData/data/workspace (как scripts/check-app-startup.js и scripts/nox-shot.js),
// прогоняет 9 проверок первого экрана и пишет verify-report.json + verify-*.png
// в docs/reconstruction/fixes-2026-11-10 (или --out-dir).
//
// Это измеритель, а не починка: UI-код не меняется. Реальный профиль владельца
// (%APPDATA%\jarvis-desktop) не используется и не трогается; single-instance
// lock у временного профиля свой. Приложение-владельца может быть запущено
// параллельно — это отмечено в отчёте (FPS снимается в нашем видимом окне).
//
// Итог: строка NOX_QA_RESULT <json> в stdout. Код выхода 0 — проверки прогнаны
// до конца (даже если отдельные check — fail), 1 — сам стенд упал/таймаут.

const fs = require('fs');
const os = require('os');
const path = require('path');

let electron = null;
try {
  electron = require('electron');
} catch {
  electron = null;
}
if (!electron || typeof electron !== 'object' || !electron.app || typeof electron.app.whenReady !== 'function') {
  console.error('nox-qa-verify: нужен запуск через electron.exe, а не node: снимите ELECTRON_RUN_AS_NODE');
  process.exit(1);
}
const { app, globalShortcut, clipboard, screen } = electron;

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.resolve(arg('out-dir', path.join(REPO_ROOT, 'docs', 'reconstruction', 'fixes-2026-11-10')));
const TIMEOUT_MS = 280000;
const LONG_CHAT_ID = 'qa-long';
const PLANS_CHAT_ID = 'qa-plans';
const SHORT_CHAT_ID = 'qa-short';

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
function has(name) {
  return process.argv.includes('--' + name);
}

// ── Временный профиль и данные ─────────────────────────────────────
function sweepOldTemp() {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^nox-qa-verify-/i.test(entry.name)) continue;
    const full = path.join(os.tmpdir(), entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs < 120000) continue; // возможно, идёт прямо сейчас
      fs.rmSync(full, { recursive: true, force: true });
    } catch { /* занят другим запуском — оставляем */ }
  }
}
sweepOldTemp();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-qa-verify-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });

const keepTemp = has('keep-temp');

// Настройки без голоса и фоновых запусков: стенд ничего не спрашивает и не говорит.
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  voice: false,
  backgroundModelRuns: false,
  alwaysListen: false,
  dictation: false,
  desktopOverlay: false,
  alwaysOnTop: false,
  motion: true,
  seededBrief: true,
  screenAuto: false,
  // Стенд проверяет классический первый экран Nox: оболочка выбирается до Aether.
  uiShell: 'legacy',
}), 'utf8');

// Разговор в формате ChatBook ({activeId, chats}) ДО старта приложения:
// 3 чата, один длинный (60 реплик) — для истории, переключения и прокрутки.
function seedConversation() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const longHistory = [
    { role: 'user', content: 'Длинный разговор для проверки прокрутки' },
    { role: 'assistant', content: 'Начинаем длинную историю: проверяем ленту, прокрутку и копирование ответа.' },
  ];
  for (let i = 2; i <= 30; i += 1) {
    longHistory.push({ role: 'user', content: `Реплика ${i} длинной истории: проверка прокрутки ленты Nox.` });
    longHistory.push({ role: 'assistant', content: `Ответ ${i}: строка длинной истории для проверки прокрутки и плотности ленты первого экрана. Финальный ответ этой истории — последний в чате.` });
  }
  return {
    activeId: LONG_CHAT_ID,
    chats: [
      { id: LONG_CHAT_ID, updatedAt: now, history: longHistory },
      {
        id: PLANS_CHAT_ID,
        updatedAt: now - 2 * day,
        history: [
          { role: 'user', content: 'Планы на сегодня' },
          { role: 'assistant', content: 'Сегодня: разобрать почту и подготовить отчёт.' },
        ],
      },
      {
        id: SHORT_CHAT_ID,
        updatedAt: now - 3 * day,
        history: [
          { role: 'user', content: 'Короткий чат' },
          { role: 'assistant', content: 'Ответ короткого чата.' },
        ],
      },
    ],
  };
}
fs.writeFileSync(path.join(dataDir, 'conversation.json'), JSON.stringify(seedConversation(), null, 2), 'utf8');

// Сессия, кэш и Chromium — во временном профиле.
app.setPath('userData', profileDir);
// Скрытое/перекрытое окно не должно замирать: capturePage и rAF берут кадры из отрисовки страницы.
// (FPS всё равно снимается после show()+focus(); флаги лишь убирают троттлинг перекрытия.)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Настройки владельца из окружения не используем.
for (const key of Object.keys(process.env)) {
  // NOX_UI оставляем: им задаётся оболочка (для этого стенда — legacy).
  if (key === 'NOX_UI') continue;
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}

// Корень данных — временная папка (та же подмена, что в check-app-startup.js/nox-shot.js).
require('../src/config/paths').projectRoot = () => tempRoot;

// ── Локальный OpenAI-совместимый мозг для настоящей проверки отмены ──
// Заглушка StubBrain отвечает за единицы мс, поэтому отмену на ней не воспроизвести.
// Поднимаем свой SSE-сервер ДО require('../main'): process.env важнее .env, а ROOT уже
// временный (реальный .env не читается). Обычный ответ — короткий (2 чанка), а на фразу
// со словом «отмен» — длинный поток ~4 с, чтобы успеть нажать стоп/вызвать jarvis.stop().
const http = require('http');
let qaBrain = null;

function startQaBrainServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
        const text = String((lastUser && lastUser.content) || '');
        const slow = /отмен/i.test(text);
        const model = body.model || 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
        if (!body.stream) {
          // Прогрев/непотоковый вызов: обычный JSON completion.
          const content = slow ? 'Долгий ответ локального тестового сервера.' : 'Ответ локального тестового сервера.';
          const payload = {
            id: 'qa-completion', object: 'chat.completion', model,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        let closed = false;
        let timer = null;
        req.on('close', () => { closed = true; if (timer) clearTimeout(timer); });
        const total = slow ? 26 : 1;
        const delay = slow ? 160 : 0;
        const piece = (n) => (slow
          ? `Часть ${n}: длинный потоковый ответ локального сервера для проверки отмены хода в Nox. `
          : 'Ответ локального тестового сервера.');
        const writeChunk = (delta, finish) => {
          const payload = {
            id: 'qa-stream', object: 'chat.completion.chunk', model,
            choices: [{ index: 0, delta, finish_reason: finish || null }],
          };
          res.write('data: ' + JSON.stringify(payload) + '\n\n');
        };
        const finish = () => {
          writeChunk({}, 'stop');
          res.write('data: ' + JSON.stringify({
            id: 'qa-stream', object: 'chat.completion.chunk', model,
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 },
          }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        };
        let n = 0;
        const tick = () => {
          if (closed) return;
          n += 1;
          writeChunk({ content: piece(n) }, null);
          if (n >= total) { finish(); return; }
          timer = setTimeout(tick, delay);
        };
        tick();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      qaBrain = { server, port: server.address().port, slowChunks: 26 };
      resolve(qaBrain);
    });
  });
}

// Глобальные горячие клавиши не должны занимать клавиши владельца.
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

// ── Служебное состояние стенда ─────────────────────────────────────
let mainWin = null;
let finished = false;
let deadline = 0;
const consoleErrors = [];
const consoleWarnings = [];
const startedAt = Date.now();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(value) {
  return JSON.stringify(value);
}

function normText(value) {
  return String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function js(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

async function shot(win, name) {
  try {
    try { win.showInactive(); } catch { /* окно уже видимо */ }
    const image = await win.webContents.capturePage();
    if (!image || image.isEmpty()) return { name, error: 'capturePage вернул пустой кадр' };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, image.toPNG());
    const size = image.getSize();
    return {
      name,
      file,
      width: size.width,
      height: size.height,
      bytes: fs.statSync(file).size,
    };
  } catch (err) {
    return { name, error: err && err.message ? err.message : String(err) };
  }
}

function screenshotNames(list) {
  return (list || []).filter(Boolean).map((item) => item.name);
}

// Уборка временной папки. Chromium держит profile-файлы до самого выхода процесса,
// поэтому синхронное удаление пробуем сразу, а остаток добивает отдельный cmd после app.exit.
function cleanupTemp() {
  if (keepTemp) {
    console.error('NOX_QA_TEMP ' + tempRoot);
    return;
  }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* профиль ещё заперт */ }
  if (process.platform === 'win32') {
    try {
      const child = require('child_process').spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${tempRoot}"`],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
    } catch { /* не критично */ }
  }
}

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const payload = {
    ok: Boolean(result && result.ok),
    out: OUT_DIR,
    elapsedMs: Date.now() - startedAt,
    ...result,
  };
  console.log('NOX_QA_RESULT ' + JSON.stringify(payload));
  try { if (qaBrain && qaBrain.server) qaBrain.server.close(); } catch { /* сервер уже закрыт */ }
  cleanupTemp();
  app.exit(result && result.ok ? 0 : 1);
}

process.on('exit', () => {
  if (keepTemp) return;
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* уже удалён */ }
});

function fail(error) {
  const payload = { ok: false, error: String(error && error.message ? error.message : error) };
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'verify-report.json'), JSON.stringify({ startedAt, finishedAt: Date.now(), fatal: payload, consoleErrors }, null, 2), 'utf8');
  } catch { /* отчёт не критичен для кода выхода */ }
  finish(payload);
}

process.on('uncaughtException', (err) => fail(err));
process.on('unhandledRejection', (err) => fail(err));

deadline = setTimeout(() => {
  fail('timeout: стенд не уложился в ' + TIMEOUT_MS + ' мс (окно ' + (mainWin ? 'найдено' : 'не найдено') + ')');
}, TIMEOUT_MS);

// ── Страница: помощники и сбор событий ─────────────────────────────
const PAGE_INIT = `(() => {
  if (window.__qaInit) return { already: true };
  window.__qaInit = true;
  window.__qaErrors = [];
  window.addEventListener('error', (e) => {
    try { window.__qaErrors.push({ kind: 'error', message: String(e.message || '').slice(0, 300) }); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = e.reason;
      window.__qaErrors.push({ kind: 'rejection', message: String((r && r.message) || r || '').slice(0, 300) });
    } catch (_) {}
  });
  window.__qaEvents = [];
  try {
    window.jarvis.onEvent((ev) => {
      try {
        window.__qaEvents.push({
          at: Date.now(),
          type: ev.type || null,
          state: ev.state || null,
          status: ev.status || null,
          outcome: ev.outcome || null,
          cancelled: ev.cancelled === true,
          message: String(ev.message || '').slice(0, 240),
          runId: ev.runId || null,
        });
        if (window.__qaEvents.length > 800) window.__qaEvents.splice(0, 200);
      } catch (_) {}
    });
  } catch (_) {}
  window.__qa = {
    norm(s) { return String(s == null ? '' : s).replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim(); },
    lastTurn() {
      const turns = [...document.querySelectorAll('#feedList .turn')].filter((t) => t.querySelector('.md') && !t.querySelector('.md.is-streaming'));
      return turns.length ? turns[turns.length - 1] : null;
    },
    feed() {
      const list = document.querySelector('#feedList');
      const feed = document.querySelector('#feed');
      if (!list || !feed) return null;
      const lastUserNode = [...list.querySelectorAll('.msg-user-text')].pop();
      const lastTurn = window.__qa.lastTurn();
      const md = lastTurn ? lastTurn.querySelector('.md') : null;
      return {
        children: list.childElementCount,
        turns: list.querySelectorAll('.turn').length,
        users: list.querySelectorAll('.msg-user').length,
        notices: list.querySelectorAll('.notice').length,
        copies: list.querySelectorAll('.nox-copy').length,
        scrollTop: Math.round(feed.scrollTop),
        scrollHeight: feed.scrollHeight,
        clientHeight: feed.clientHeight,
        atBottom: feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 4,
        gapToBottom: Math.max(0, feed.scrollHeight - feed.scrollTop - feed.clientHeight),
        lastUser: lastUserNode ? lastUserNode.innerText.trim().slice(0, 240) : null,
        lastAnswer: md ? md.innerText.trim().slice(0, 400) : null,
      };
    },
    geom() {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        const cs = getComputedStyle(node);
        const shown = !node.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), shown };
      };
      const legacy = window.NoxScreen && typeof window.NoxScreen.geometry === 'function' ? window.NoxScreen.geometry() : null;
      return {
        window: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        topbar: box('#noxTopbar'),
        nav: box('#noxTopbar .rail') || box('.rail'),
        rail: box('#noxRail'),
        history: box('#noxHistory'),
        chat: box('#noxChat'),
        sphere: box('#noxSphere'),
        orb: box('#noxOrb'),
        composer: box('#composer'),
        variant: legacy ? legacy.variant : null,
      };
    },
    state() {
      const h = document.querySelector('#headerState');
      const stage = document.querySelector('#stage');
      const busyBox = document.querySelector('#composerBusy');
      const stopBtn = document.querySelector('#chatStop');
      const working = document.querySelector('.nox-working');
      return {
        header: h ? h.dataset.state || null : null,
        headerText: h ? h.textContent.trim() : null,
        stage: stage ? stage.dataset.state || null : null,
        busy: busyBox ? !busyBox.hidden : null,
        stopVisible: stopBtn ? !stopBtn.hidden : null,
        working: working ? working.textContent.trim() : null,
      };
    },
  };
  return { ok: true };
})()`;

// ── Ожидания ───────────────────────────────────────────────────────
async function waitVisible(win) {
  for (let i = 0; i < 200; i += 1) {
    if (win.isDestroyed()) throw new Error('окно уничтожено до показа');
    if (win.isVisible()) return true;
    await sleep(50);
  }
  return false;
}

async function waitPageReady(win) {
  for (let i = 0; i < 240; i += 1) {
    const info = await js(win, `(() => {
      const list = document.querySelector('#feedList');
      return {
        view: document.body ? document.body.dataset.view || null : null,
        feed: list ? list.childElementCount : -1,
        hist: document.querySelectorAll('#noxHistSections .nox-hist-item').length,
        apis: {
          jarvis: !!(window.jarvis && typeof window.jarvis.getState === 'function'),
          NoxScreen: !!(window.NoxScreen && typeof window.NoxScreen.geometry === 'function'),
          NoxOrb: typeof window.NoxOrb === 'function',
          JarvisNox: !!(window.JarvisNox && typeof window.JarvisNox.changeChat === 'function'),
        },
        ready: document.readyState,
      };
    })()`).catch(() => null);
    if (info && info.view === 'nox' && info.feed >= 3 && info.hist >= 3
      && info.apis.jarvis && info.apis.NoxScreen && info.apis.NoxOrb && info.apis.JarvisNox) {
      return info;
    }
    await sleep(100);
  }
  const last = await js(win, `(() => ({ view: document.body && document.body.dataset.view, ready: document.readyState, feed: document.querySelector('#feedList') ? document.querySelector('#feedList').childElementCount : null, hist: document.querySelectorAll('#noxHistSections .nox-hist-item').length }))()`).catch(() => null);
  throw new Error('страница не готова за 24 с: ' + json(last));
}

async function settle(win, waitMs) {
  if (waitMs) await sleep(waitMs);
  await js(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`).catch(() => null);
}

async function setContentSize(win, width, height) {
  try { win.setMinimumSize(200, 200); } catch { /* старый Electron */ }
  win.setContentSize(width, height);
  for (let i = 0; i < 80; i += 1) {
    const [w, h] = win.getContentSize();
    if (w === width && h === height) break;
    await sleep(40);
  }
  await sleep(150);
}

// Отправка сообщения через настоящую форму и ожидание конца хода.
async function submitAndWait(win, text, timeoutMs) {
  const limit = Number.isFinite(timeoutMs) ? timeoutMs : 20000;
  const before = await js(win, `(() => ({ feed: window.__qa.feed(), state: window.__qa.state(), events: (window.__qaEvents || []).length }))()`);
  const mark = before.events;
  const submitted = await js(win, `(() => {
    const ta = document.querySelector('#chatInput');
    if (!ta) return { error: 'нет #chatInput' };
    ta.focus();
    ta.value = ${json(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const send = document.querySelector('#chatSend');
    const enabled = send ? !send.disabled : null;
    const form = document.querySelector('#composer');
    if (!form) return { error: 'нет #composer' };
    form.requestSubmit();
    return { enabled, value: ta.value };
  })()`);
  const t0 = Date.now();
  const poll = await js(win, `(async () => {
    const mark = ${mark};
    const beforeChildren = ${before.feed ? before.feed.children : 0};
    const needle = ${json(text.slice(0, 24))};
    const t0 = performance.now();
    for (;;) {
      const feed = window.__qa.feed();
      const state = window.__qa.state();
      const events = (window.__qaEvents || []).slice(mark);
      const done = events.find((e) => e.type === 'done');
      const userOk = feed && feed.lastUser && feed.lastUser.indexOf(needle) >= 0;
      const turnOk = feed && feed.children >= beforeChildren + 2 && feed.lastAnswer;
      if (done && userOk && turnOk && state.stopVisible === false) {
        return {
          ok: true,
          ms: Math.round(performance.now() - t0),
          feed,
          state,
          done: { status: done.status || null, outcome: done.outcome || null, cancelled: done.cancelled === true },
          events: events.slice(-12),
        };
      }
      if (performance.now() - t0 > ${limit}) {
        return { ok: false, timeout: true, ms: Math.round(performance.now() - t0), feed, state, events: events.slice(-14) };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })()`);
  return { text, before, submitted, elapsedMs: Date.now() - t0, poll };
}

// ── Проверки ───────────────────────────────────────────────────────
async function checkNewChat(win) {
  const evidence = {};
  const before = await js(win, `(async () => ({ list: await window.jarvis.chatList(), history: await window.jarvis.chatHistory(), feed: window.__qa.feed(), geom: window.__qa.geom() }))()`);
  evidence.before = {
    chats: before.list ? before.list.chats.length : null,
    activeId: before.list ? before.list.activeId : null,
    activeTitle: before.list && before.list.chats ? ((before.list.chats.find((c) => c.id === before.list.activeId) || {}).title || null) : null,
    feedChildren: before.feed ? before.feed.children : null,
    activeHistory: Array.isArray(before.history) ? before.history.length : null,
  };
  const nav = await js(win, `(async () => {
    try { await window.JarvisNox.changeChat('chatNew'); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  })()`);
  await settle(win, 900);
  const after = await js(win, `(async () => {
    const grid = document.querySelector('#noxGrid');
    const empty = document.querySelector('#chatEmpty');
    return {
      list: await window.jarvis.chatList(),
      history: await window.jarvis.chatHistory(),
      feed: window.__qa.feed(),
      geom: window.__qa.geom(),
      empty: {
        feedChildren: document.querySelector('#feedList') ? document.querySelector('#feedList').childElementCount : null,
        chatEmptyHidden: empty ? empty.hidden : null,
        gridIsEmpty: grid ? grid.classList.contains('is-empty') : null,
        histRows: document.querySelectorAll('#noxHistSections .nox-hist-item').length,
        historyDisplay: document.querySelector('#noxHistory') ? getComputedStyle(document.querySelector('#noxHistory')).display : null,
      },
    };
  })()`);
  evidence.nav = nav;
  evidence.after = {
    chats: after.list ? after.list.chats.length : null,
    activeId: after.list ? after.list.activeId : null,
    activeTitle: after.list && after.list.chats ? ((after.list.chats.find((c) => c.id === after.list.activeId) || {}).title || null) : null,
    feedChildren: after.feed ? after.feed.children : null,
    activeHistory: Array.isArray(after.history) ? after.history.length : null,
    empty: after.empty,
    geometry: after.geom,
  };
  const grew = before.list && after.list && after.list.chats.length > before.list.chats.length;
  const emptyActive = Boolean(after.list && before.list && after.list.activeId !== before.list.activeId
    && Array.isArray(after.history) && after.history.length === 0
    && after.feed && after.feed.children === 0);
  evidence.grew = grew;
  evidence.emptyChatActive = emptyActive;
  evidence.note = 'Фактический пустой чат: 0 сообщений в ленте; is-empty не включается, пока в истории больше одного чата (S.chatCount).';
  const screenshots = [await shot(win, 'verify-new-chat-1.png')];
  return { ok: Boolean(nav.ok && (grew || emptyActive)), evidence, screenshots };
}

async function checkSwitchChat(win) {
  const evidence = {};
  const before = await js(win, `(async () => ({ list: await window.jarvis.chatList(), feed: window.__qa.feed() }))()`);
  evidence.before = {
    activeId: before.list ? before.list.activeId : null,
    feedChildren: before.feed ? before.feed.children : null,
    lastUser: before.feed ? before.feed.lastUser : null,
  };
  const clicked = await js(win, `(() => {
    const rows = [...document.querySelectorAll('#noxHistSections .nox-hist-item')];
    const row = rows.find((r) => {
      const open = r.querySelector('.nox-hist-open');
      return open && /Планы на сегодня/.test(open.textContent || '');
    });
    if (!row) return { clicked: false, titles: rows.map((r) => (r.querySelector('.nox-hist-open') || {}).textContent || '') };
    const open = row.querySelector('.nox-hist-open');
    const title = open.textContent.trim();
    open.click();
    return { clicked: true, title };
  })()`);
  await settle(win, 1000);
  const after = await js(win, `(async () => ({ list: await window.jarvis.chatList(), history: await window.jarvis.chatHistory(), feed: window.__qa.feed(), geom: window.__qa.geom() }))()`);
  evidence.clicked = clicked;
  evidence.after = {
    activeId: after.list ? after.list.activeId : null,
    activeTitle: after.list && after.list.chats ? ((after.list.chats.find((c) => c.id === after.list.activeId) || {}).title || null) : null,
    feedChildren: after.feed ? after.feed.children : null,
    historyMessages: Array.isArray(after.history) ? after.history.length : null,
    lastUser: after.feed ? after.feed.lastUser : null,
    lastAnswer: after.feed ? after.feed.lastAnswer : null,
    geometry: after.geom,
  };
  const contentChanged = Boolean(before.feed && after.feed
    && (after.feed.children !== before.feed.children || after.feed.lastUser !== before.feed.lastUser));
  evidence.contentChanged = contentChanged;
  const ok = Boolean(clicked.clicked
    && after.list && after.list.activeId === PLANS_CHAT_ID
    && Array.isArray(after.history) && after.history.length === 2
    && after.feed && after.feed.children === 2
    && typeof after.feed.lastUser === 'string' && after.feed.lastUser.indexOf('Планы на сегодня') >= 0
    && contentChanged);
  const screenshots = [await shot(win, 'verify-switch-chat-1.png')];
  return { ok, evidence, screenshots };
}

async function checkSend(win) {
  const text = 'Проверка интерфейса Nox: ответь, пожалуйста, одной короткой строкой.';
  const run = await submitAndWait(win, text, 20000);
  const feed = run.poll ? run.poll.feed : null;
  const events = run.poll ? run.poll.events || [] : [];
  const evidence = {
    text,
    submitted: run.submitted,
    elapsedMs: run.elapsedMs,
    pollMs: run.poll ? run.poll.ms : null,
    timeout: Boolean(run.poll && run.poll.timeout),
    userBubble: feed ? feed.lastUser : null,
    assistantTurn: feed ? feed.lastAnswer : null,
    feedBeforeChildren: run.before.feed ? run.before.feed.children : null,
    feedAfterChildren: feed ? feed.children : null,
    stateAfter: run.poll ? run.poll.state : null,
    done: run.poll ? run.poll.done : null,
    lastEvents: events.map((e) => ({ type: e.type, state: e.state, status: e.status, cancelled: e.cancelled })),
  };
  const ok = Boolean(run.poll && run.poll.ok
    && feed && typeof feed.lastUser === 'string' && feed.lastUser.indexOf(text.slice(0, 20)) >= 0
    && typeof feed.lastAnswer === 'string' && feed.lastAnswer.length > 0
    && feed.children >= (run.before.feed ? run.before.feed.children : 0) + 2);
  const screenshots = [await shot(win, 'verify-send-1.png')];
  return { ok, evidence, screenshots };
}

async function checkCancel(win) {
  const text = 'Проверка отмены хода Nox.';
  const run = await js(win, `(async () => {
    const mark = (window.__qaEvents || []).length;
    const ta = document.querySelector('#chatInput');
    if (!ta) return { error: 'нет #chatInput' };
    ta.focus();
    ta.value = ${json(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const form = document.querySelector('#composer');
    if (!form) return { error: 'нет #composer' };
    const t0 = performance.now();
    window.__qaCancelT0 = Date.now();
    form.requestSubmit();
    let busySeen = false;
    let busyAt = null;
    let firstTextAt = null;
    let stopAt = null;
    let stopVia = null;
    let stopResult = null;
    let doneEvent = null;
    for (;;) {
      const elapsed = performance.now() - t0;
      const events = (window.__qaEvents || []).slice(mark);
      const state = window.__qa.state();
      const feed = window.__qa.feed();
      if (!busySeen && (state.stopVisible || state.busy)) {
        busySeen = true;
        busyAt = Math.round(elapsed);
      }
      const hasText = (feed && feed.lastAnswer && feed.lastAnswer.length > 0)
        || events.some((e) => e.type === 'text');
      if (firstTextAt === null && hasText) firstTextAt = Math.round(elapsed);
      const done = events.find((e) => e.type === 'done');
      // Ждём реальный поток (текст виден) ~400-600 мс, затем настоящий стоп.
      if (firstTextAt !== null && stopAt === null && elapsed - firstTextAt >= 350) {
        stopAt = Math.round(elapsed);
        const btn = document.querySelector('#chatStop');
        if (btn && !btn.hidden) {
          btn.click();
          stopVia = 'click #chatStop';
        } else {
          stopVia = 'window.jarvis.stop()';
        }
        try {
          stopResult = await window.jarvis.stop();
        } catch (e) {
          stopResult = { error: String((e && e.message) || e) };
        }
      }
      if (done && stopAt !== null) { doneEvent = done; break; }
      if (elapsed > 20000) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      mark,
      busySeen,
      busyAt,
      firstTextAt,
      stopAt,
      stopVia,
      stopResultOk: !!(stopResult && stopResult.ok === true),
      doneEvent: doneEvent ? { type: doneEvent.type, status: doneEvent.status, outcome: doneEvent.outcome, cancelled: doneEvent.cancelled === true } : null,
    };
  })()`);
  // «Остановлено» StatusTracker держит 2.6 с, затем возвращается в idle — ждём это окно.
  await settle(win, 3300);
  const after = await js(win, `(() => {
    const mark = ${Number.isFinite(run.mark) ? run.mark : 0};
    const t0 = window.__qaCancelT0 || Date.now();
    const events = (window.__qaEvents || []).slice(mark);
    const notices = [...document.querySelectorAll('#feedList .notice')].map((n) => n.innerText.trim()).filter(Boolean);
    const workingRows = [...document.querySelectorAll('.nox-working')].map((n) => n.textContent.trim());
    const live = document.querySelector('#doneLive');
    const streaming = document.querySelector('#feedList .md.is-streaming');
    return {
      events: events.map((e) => ({ type: e.type, state: e.state, status: e.status, outcome: e.outcome, cancelled: e.cancelled, message: e.message, atMs: typeof e.at === 'number' ? Math.round(e.at - t0) : null })),
      notices,
      doneEvents: events.filter((e) => e.type === 'done').map((e) => ({ type: e.type, status: e.status, outcome: e.outcome, cancelled: e.cancelled, atMs: typeof e.at === 'number' ? Math.round(e.at - t0) : null })),
      feed: window.__qa.feed(),
      state: window.__qa.state(),
      workingRows,
      stillStreaming: Boolean(streaming),
      doneLive: live ? live.textContent.trim() : null,
    };
  })()`);
  const cancelNotice = (after.notices || []).find((t) => /Ход остановлен/.test(t)) || null;
  const doneCancelled = Boolean(run.doneEvent && (run.doneEvent.cancelled === true || run.doneEvent.status === 'cancelled'))
    || (after.doneEvents || []).some((e) => e.cancelled === true || e.status === 'cancelled');
  const lastWorking = (after.workingRows || []).length ? after.workingRows[after.workingRows.length - 1] : null;
  const workingStopped = Boolean(lastWorking && /Остановлено/.test(lastWorking));
  const noFalseReady = after.doneLive !== 'Ответ готов' || doneCancelled;
  const partial = after.feed && after.feed.lastAnswer ? after.feed.lastAnswer.length : 0;
  const fullExpected = qaBrain ? (qaBrain.slowChunks * 78) : 0;
  const visibleAnswerTruncated = partial > 0 && fullExpected > 0 && partial < fullExpected - 50;
  const cancelledPhaseSeen = (after.events || []).some((e) => e.type === 'status' && (e.state === 'cancelled' || e.status === 'cancelled'));
  const evidence = {
    text,
    brain: { url: process.env.NOX_BRAIN_URL || null, slowChunks: qaBrain ? qaBrain.slowChunks : null },
    busySeen: Boolean(run.busySeen),
    busyAtMs: run.busyAt,
    firstTextAtMs: run.firstTextAt,
    stopAtMs: run.stopAt,
    stopVia: run.stopVia,
    stopResultOk: Boolean(run.stopResultOk),
    doneEvent: run.doneEvent,
    doneCancelled,
    cancelledPhaseSeen,
    cancelNotice,
    workingRows: after.workingRows,
    workingStopped,
    stillStreaming: after.stillStreaming,
    stateAfter: after.state,
    doneLive: after.doneLive,
    noFalseReady,
    visibleAnswerChars: partial,
    fullAnswerApproxChars: fullExpected,
    visibleAnswerTruncated,
    noticesInFeed: after.notices,
    feedAfter: after.feed,
    note: 'Настоящий поток локального OpenAI-совместимого сервера (~4 с); стоп нажат по видимому тексту. «Остановлено» держится 2.6 с, затем StatusTracker возвращает idle.',
  };
  const ok = Boolean(run.stopAt !== null
    && (cancelNotice || doneCancelled)
    && doneCancelled
    && after.state && after.state.header === 'idle'
    && !after.stillStreaming
    && (workingStopped || Boolean(cancelNotice))
    && noFalseReady
    && visibleAnswerTruncated);
  const screenshots = [await shot(win, 'verify-cancel-1.png')];
  return { ok, evidence, screenshots };
}

async function checkScroll(win) {
  const evidence = {};
  const switched = await js(win, `(async () => {
    try { await window.JarvisNox.changeChat('chatSelect', ${json(LONG_CHAT_ID)}); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  })()`);
  await settle(win, 1500);
  const initial = await js(win, `(() => {
    const feed = document.querySelector('#feed');
    const info = window.__qa.feed();
    const toBottom = document.querySelector('#toBottom');
    return {
      feed: info,
      atBottom: info ? info.atBottom : false,
      hasOverflow: feed ? feed.scrollHeight > feed.clientHeight : false,
      scrollHeight: feed ? feed.scrollHeight : null,
      clientHeight: feed ? feed.clientHeight : null,
      toBottomHidden: toBottom ? toBottom.hidden : null,
      toBottomLabel: toBottom ? toBottom.textContent.trim() : null,
      histRows: document.querySelectorAll('#noxHistSections .nox-hist-item').length,
      geom: window.__qa.geom(),
    };
  })()`);
  evidence.switched = switched;
  evidence.initial = initial;
  await js(win, `(() => { const feed = document.querySelector('#feed'); if (feed) feed.scrollTop = 0; return true; })()`);
  await settle(win, 200);
  const atTop = await js(win, `(() => {
    const feed = document.querySelector('#feed');
    const geom = window.__qa.geom();
    const toBottom = document.querySelector('#toBottom');
    return {
      scrollTop: feed ? Math.round(feed.scrollTop) : null,
      atTop: feed ? feed.scrollTop <= 1 : false,
      scrollHeight: feed ? feed.scrollHeight : null,
      clientHeight: feed ? feed.clientHeight : null,
      toBottomHidden: toBottom ? toBottom.hidden : null,
      geom,
    };
  })()`);
  evidence.atTop = atTop;
  const screenshots = [await shot(win, 'verify-scroll-1.png')];
  await js(win, `(() => { const feed = document.querySelector('#feed'); if (feed) feed.scrollTop = feed.scrollHeight; return true; })()`);
  await settle(win, 250);
  const atBottom = await js(win, `(() => {
    const feed = document.querySelector('#feed');
    const info = window.__qa.feed();
    const toBottom = document.querySelector('#toBottom');
    return {
      scrollTop: feed ? Math.round(feed.scrollTop) : null,
      atBottom: info ? info.atBottom : false,
      gapToBottom: info ? info.gapToBottom : null,
      scrollHeight: feed ? feed.scrollHeight : null,
      clientHeight: feed ? feed.clientHeight : null,
      toBottomHidden: toBottom ? toBottom.hidden : null,
      geom: window.__qa.geom(),
    };
  })()`);
  evidence.atBottom = atBottom;
  evidence.toBottom = {
    label: initial.toBottomLabel,
    initialHidden: initial.toBottomHidden,
    atTopHidden: atTop.toBottomHidden,
    atBottomHidden: atBottom.toBottomHidden,
  };
  screenshots.push(await shot(win, 'verify-scroll-2.png'));

  // Автопрокрутка: стоим внизу, отправляем сообщение — лента должна остаться внизу.
  const sent = await submitAndWait(win, 'Проверка автопрокрутки Nox.', 20000);
  await settle(win, 300);
  const auto = await js(win, `(() => {
    const feed = document.querySelector('#feed');
    const info = window.__qa.feed();
    const toBottom = document.querySelector('#toBottom');
    return {
      atBottom: info ? info.atBottom : false,
      scrollTop: feed ? Math.round(feed.scrollTop) : null,
      scrollHeight: feed ? feed.scrollHeight : null,
      toBottomHidden: toBottom ? toBottom.hidden : null,
      feed: info,
    };
  })()`);
  evidence.autoScroll = {
    sent: { ok: Boolean(sent.poll && sent.poll.ok), elapsedMs: sent.elapsedMs },
    after: auto,
    gapToBottomPx: auto && auto.feed ? auto.feed.gapToBottom : null,
    toBottomHidden: auto ? auto.toBottomHidden : null,
  };
  evidence.initialGapToBottomPx = initial.feed ? initial.feed.gapToBottom : null;
  // Под ответом живёт кнопка «Скопировать» (её высота ~28-30 px), поэтому «прижато к низу» —
  // с допуском на неё, а не впритык. «Вниз ↓» — кнопка старого экрана: её состояние пишем
  // в отчёт, но провалом не считаем (в текущей оболочке её может не быть вовсе).
  const pinnedTolerancePx = 48;
  evidence.pinnedTolerancePx = pinnedTolerancePx;
  evidence.legacyToBottomNote = 'кнопка «Вниз ↓» старого экрана: состояние записано, в приговоре не участвует';
  const autoGapToBottom = auto && auto.feed ? auto.feed.gapToBottom : null;
  const autoPinned = autoGapToBottom !== null && autoGapToBottom <= pinnedTolerancePx;
  evidence.autoPinned = autoPinned;
  evidence.finding = (initial.atBottom && autoPinned)
    ? null
    : 'Лента не прижата к низу там, где ожидается (старт чата или после ответа).';
  const noJump = Boolean(atTop.scrollHeight && atBottom.scrollHeight && Math.abs(atBottom.scrollHeight - atTop.scrollHeight) <= 1);
  evidence.noLayoutJump = noJump;
  const ok = Boolean(switched.ok
    && initial.hasOverflow
    && initial.atBottom
    && atTop.atTop
    && atBottom.atBottom
    && noJump
    && autoPinned
    && sent.poll && sent.poll.ok);
  screenshots.push(await shot(win, 'verify-scroll-3.png'));
  return { ok, evidence, screenshots };
}

function geometrySnapshotScript() {
  return `(() => {
    const geom = window.__qa.geom();
    const canvas = document.querySelector('#noxOrb');
    const canvasRect = canvas ? canvas.getBoundingClientRect() : null;
    const composer = document.querySelector('#composer');
    const composerRect = composer ? composer.getBoundingClientRect() : null;
    const bodyScrollWidth = Math.max(document.body ? document.body.scrollWidth : 0, document.documentElement ? document.documentElement.scrollWidth : 0);
    const dpr = window.devicePixelRatio || 1;
    const dprUsed = Math.min(dpr, 2);
    const round = (v) => Math.round(v * 10) / 10;
    const box = (r) => r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
    const expected = ${json({})};
    return {
      inner: [window.innerWidth, window.innerHeight],
      dpr,
      bodyScrollWidth,
      docScrollWidth: document.documentElement ? document.documentElement.scrollWidth : null,
      overflowX: bodyScrollWidth > window.innerWidth,
      geom,
      composer: box(composerRect),
      orb: canvas && canvasRect ? {
        cssW: Math.round(canvasRect.width),
        cssH: Math.round(canvasRect.height),
        attrW: canvas.width,
        attrH: canvas.height,
        dprUsed,
        cssSquare: Math.abs(canvasRect.width - canvasRect.height) <= 1,
        cssMatchesAttr: Math.abs(canvas.width - Math.round(canvasRect.width * dprUsed)) <= 1
          && Math.abs(canvas.height - Math.round(canvasRect.height * dprUsed)) <= 1,
        backdrop: canvas.width > 0 && canvas.height > 0,
      } : null,
      computed: {
        railW: getComputedStyle(document.body).getPropertyValue('--rail-w').trim(),
        historyW: getComputedStyle(document.body).getPropertyValue('--nox-history-w').trim(),
        sphereW: getComputedStyle(document.body).getPropertyValue('--nox-sphere-w').trim(),
        orbSize: getComputedStyle(document.body).getPropertyValue('--nox-orb-size').trim(),
      },
      historyDisplay: document.querySelector('#noxHistory') ? getComputedStyle(document.querySelector('#noxHistory')).display : null,
      view: document.body ? document.body.dataset.view : null,
      expected,
    };
  })()`;
}

async function checkResize(win) {
  const sizes = [[864, 520], [960, 640], [1200, 720]];
  const expected = {
    // До 1000 px история выезжает по кнопке (nox-shell.js) и по умолчанию скрыта: чат примыкает к рейке.
    '864x520': { rail: 46, history: 0, sphere: 278, orb: 240 },
    '960x640': { rail: 46, history: 0, sphere: 278, orb: 240 },
    '1200x720': { rail: 52, history: 244, sphere: 360, orb: 332 },
  };
  const results = [];
  const shots = [];
  for (let i = 0; i < sizes.length; i += 1) {
    const [w, h] = sizes[i];
    await setContentSize(win, w, h);
    await settle(win, 600);
    const snap = await js(win, geometrySnapshotScript());
    const key = `${w}x${h}`;
    const exp = expected[key];
    const g = snap.geom || {};
    const rail = g.rail || null;
    const history = g.history || null;
    const chat = g.chat || null;
    const sphere = g.sphere || null;
    const orbRect = g.orb || null;
    const orbCanvas = snap.orb || null;
    const innerOk = Array.isArray(snap.inner) && Math.abs(snap.inner[0] - w) <= 1 && Math.abs(snap.inner[1] - h) <= 1;
    const topbar = g.topbar || null;
    const nav = g.nav || g.rail || null;
    const historyShown = Boolean(history && history.shown !== false && history.w > 0);
    // История на окне уже 1000 px выезжает по кнопке: в обычной раскладке её нет.
    const historyShouldShow = w >= 1000;
    const historyOk = historyShouldShow ? historyShown : !historyShown;
    const topbarOk = Boolean(topbar && topbar.y <= 1 && topbar.w >= w - 2 && topbar.h >= 28 && topbar.h <= 90);
    const navOk = Boolean(nav && nav.w > 0 && nav.h > 0 && nav.x >= 0 && nav.x + nav.w <= w + 1);
    const panelsOk = Boolean(chat && sphere
      && chat.w > 0 && sphere.w > 0
      && chat.x >= -0.5 && chat.x + chat.w <= w + 1
      && sphere.x >= chat.x + chat.w - 1 && sphere.x + sphere.w <= w + 1
      && chat.y >= 0 && chat.y + chat.h <= h + 1
      && sphere.y >= 0 && sphere.y + sphere.h <= h + 1
      && (!historyShouldShow || (history && chat.x >= history.x + history.w - 1)));
    const sphereShare = sphere ? Math.round((sphere.w / w) * 1000) / 1000 : null;
    const sphereOk = sphereShare !== null && sphereShare >= 0.18 && sphereShare <= 0.42 && Boolean(chat && chat.w > sphere.w);
    const orbSquare = Boolean(orbRect && orbCanvas && orbRect.w === orbRect.h && orbCanvas.cssSquare);
    const orbFits = Boolean(orbRect && sphere && orbRect.w > 0 && orbRect.w <= sphere.w - 6);
    const orbRatio = orbRect && sphere && sphere.w ? Math.round((orbRect.w / sphere.w) * 100) / 100 : null;
    const orbSizeOk = orbSquare && orbFits && orbRatio !== null && orbRatio >= 0.6 && orbRatio <= 0.98;
    const composerOk = Boolean(snap.composer && snap.composer.w > 0
      && snap.composer.h >= 56 && snap.composer.h <= 120
      && snap.composer.x >= 0 && snap.composer.x + snap.composer.w <= w + 1
      && snap.composer.y >= 0 && snap.composer.y + snap.composer.h <= h + 1);
    const tokens = snap.computed || null;
    const shotInfo = await shot(win, 'verify-resize-' + (i + 1) + '.png');
    shots.push(shotInfo);
    results.push({
      size: key,
      inner: snap.inner,
      innerOk,
      overflowX: snap.overflowX,
      bodyScrollWidth: snap.bodyScrollWidth,
      topbar, nav, history, chat, sphere, orb: orbRect, orbRect, canvas: orbCanvas, composer: snap.composer,
      at: {
        historyW: history ? history.w : null,
        chatW: chat ? chat.w : null,
        sphereW: sphere ? sphere.w : null,
        sphereShare,
      },
      expected: { historyShouldShow, sphereShare: '0.18..0.42', orbRatio: '0.6..0.98', composerHeight: '56..120' },
      historyShouldShow, historyShown, historyOk,
      topbarOk, navOk, panelsOk, sphereOk, orbSquare, orbFits, orbRatio, orbSizeOk, composerOk,
      tokens,
      composerWidth: snap.composer ? snap.composer.w : null,
      canvasMatch: Boolean(orbCanvas && orbCanvas.cssMatchesAttr),
      view: snap.view,
      screenshot: shotInfo.name,
      screenshotError: shotInfo.error || null,
    });
  }
  const ok = results.every((r) => r.innerOk && !r.overflowX && r.topbarOk && r.navOk && r.panelsOk
    && r.sphereOk && r.orbSizeOk && r.composerOk && r.canvasMatch && r.historyOk);
  return {
    ok,
    evidence: {
      sizes: results,
      note: 'Проверка описывает текущую оболочку Nox: верхняя шапка, история/чат/сфера на широком окне, история по кнопке на узком. Старые точные размеры токенов оставлены справочно в tokens.',
    },
    screenshots: shots,
  };
}

async function checkCopy(win) {
  const evidence = {};
  try { win.show(); win.focus(); } catch { /* окно уже видимо */ }
  await settle(win, 300);
  evidence.windowFocused = win.isFocused();
  evidence.windowVisible = win.isVisible();

  // Кнопка может быть ниже вьюпорта в длинной ленте: подводим её к центру, чтобы клик/наведение были настоящими.
  await js(win, `(() => {
    const turn = window.__qa.lastTurn();
    if (turn && typeof turn.scrollIntoView === 'function') turn.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  })()`);
  await settle(win, 250);

  const info = await js(win, `(() => {
    const turn = window.__qa.lastTurn();
    if (!turn) return { error: 'нет готового ответа ассистента' };
    const md = turn.querySelector('.md');
    const btn = turn.querySelector(':scope > .nox-copy');
    if (!md) return { error: 'у ответа нет .md' };
    if (!btn) return { error: 'нет кнопки .nox-copy', answer: md.innerText.slice(0, 160) };
    const rect = btn.getBoundingClientRect();
    const styles = getComputedStyle(btn);
    return {
      expectedRaw: md.innerText,
      expectedNorm: window.__qa.norm(md.innerText),
      labelBefore: btn.getAttribute('aria-label'),
      titleBefore: btn.title,
      visible: btn.offsetParent !== null && rect.width > 0 && rect.height > 0,
      onScreen: rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
      baseStyle: {
        color: styles.color,
        background: styles.backgroundColor,
        border: styles.borderTopColor,
        outline: styles.outlineStyle + ' ' + styles.outlineWidth + ' ' + styles.outlineColor,
      },
      focusable: btn.tabIndex >= 0,
      cheapChecks: {
        isButton: btn.tagName === 'BUTTON',
        type: btn.type || null,
      },
    };
  })()`);
  evidence.button = info;
  if (info.error) {
    return { ok: false, evidence, screenshots: [await shot(win, 'verify-copy-1.png')] };
  }

  // Реальный hover: двигаем настоящий указатель окна на центр кнопки.
  let hover = null;
  try {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: info.center.x, y: info.center.y });
    await sleep(180);
    hover = await js(win, `(() => {
      const turn = window.__qa.lastTurn();
      const btn = turn && turn.querySelector(':scope > .nox-copy');
      if (!btn) return null;
      const styles = getComputedStyle(btn);
      return {
        hoverRulePresent: (() => {
          try {
            for (const sheet of document.styleSheets) {
              let rules = [];
              try { rules = sheet.cssRules || []; } catch (_) { continue; }
              for (const rule of rules) {
                if (rule.selectorText && rule.selectorText.indexOf('.nox-copy:hover') >= 0) return true;
              }
            }
          } catch (_) {}
          return false;
        })(),
        color: styles.color,
        background: styles.backgroundColor,
        border: styles.borderTopColor,
      };
    })()`);
  } catch (err) {
    hover = { error: err && err.message ? err.message : String(err) };
  }
  evidence.hover = hover;
  evidence.hoverChanged = Boolean(hover && !hover.error && info.baseStyle
    && (hover.color !== info.baseStyle.color || hover.background !== info.baseStyle.background || hover.border !== info.baseStyle.border));

  // Клавиатурная модальность + focus(): какое состояние outline видит страница.
  try {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await sleep(80);
  } catch { /* не критично */ }
  const focus = await js(win, `(() => {
    const turn = window.__qa.lastTurn();
    const btn = turn && turn.querySelector(':scope > .nox-copy');
    if (!btn) return { error: 'кнопка исчезла' };
    btn.focus();
    const styles = getComputedStyle(btn);
    return {
      activeIsButton: document.activeElement === btn,
      focusVisible: btn.matches(':focus-visible'),
      outline: styles.outlineStyle + ' ' + styles.outlineWidth + ' ' + styles.outlineColor,
      activeTag: document.activeElement ? document.activeElement.tagName : null,
    };
  })()`);
  evidence.focus = focus;

  // Клик: состояние «Скопировано» и реальный буфер обмена.
  const click = await js(win, `(() => {
    const turn = window.__qa.lastTurn();
    const btn = turn && turn.querySelector(':scope > .nox-copy');
    if (!btn) return { error: 'кнопка исчезла' };
    const labelBefore = btn.getAttribute('aria-label');
    btn.click();
    return { labelBefore, clicked: true };
  })()`);
  await sleep(250);
  const afterClick = await js(win, `(() => {
    const turn = window.__qa.lastTurn();
    const btn = turn && turn.querySelector(':scope > .nox-copy');
    if (!btn) return { error: 'кнопка исчезла' };
    const styles = getComputedStyle(btn);
    return {
      label: btn.getAttribute('aria-label'),
      title: btn.title,
      copiedFlag: btn.dataset.copied || null,
      checkGlyph: btn.querySelectorAll('path').length > 0,
      color: styles.color,
      border: styles.borderTopColor,
      rect: (() => { const r = btn.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    };
  })()`);
  let clipboardText = '';
  let clipboardError = null;
  // Electron 44: модуль clipboard() отдаёт асинхронный Clipboard.readText(): Promise<string>.
  try {
    const raw = clipboard.readText();
    const value = raw && typeof raw.then === 'function' ? await raw : raw;
    clipboardText = typeof value === 'string' ? value : String(value == null ? '' : value);
  } catch (err) {
    clipboardError = err && err.message ? err.message : String(err);
  }
  evidence.click = click;
  evidence.afterClick = afterClick;
  evidence.clipboard = {
    error: clipboardError,
    api: 'clipboard.readText() main process (Electron 44, Promise)',
    length: clipboardText.length,
    preview: clipboardText.slice(0, 160),
    expectedLength: info.expectedRaw.length,
    expectedPreview: String(info.expectedRaw).slice(0, 160),
    exactMatch: clipboardText === info.expectedRaw,
    normalizedMatch: normText(clipboardText) === info.expectedNorm,
    normalizedClipboard: normText(clipboardText).slice(0, 200),
  };
  const screenshots = [await shot(win, 'verify-copy-1.png')];

  // Сброс состояния «Скопировано» через 1.4 с.
  await settle(win, 1500);
  const reverted = await js(win, `(() => {
    const turn = window.__qa.lastTurn();
    const btn = turn && turn.querySelector(':scope > .nox-copy');
    if (!btn) return { error: 'кнопка исчезла' };
    return { label: btn.getAttribute('aria-label'), copiedFlag: btn.dataset.copied || null, title: btn.title };
  })()`);
  evidence.reverted = reverted;

  // Сдвиг соседей: синхронно снимаем кнопку ТОЛЬКО у последнего ответа и сравниваем offsetTop
  // всех предыдущих реплик. Предыдущие сообщения не должны поехать от появления кнопки.
  const shift = await js(win, `(() => {
    const list = document.querySelector('#feedList');
    if (!list) return { error: 'нет #feedList' };
    const kids = [...list.children];
    const lastKid = kids.length ? kids[kids.length - 1] : null;
    const snap = () => kids.map((k) => ({ top: k.offsetTop, height: k.offsetHeight, cls: (k.className || '').slice(0, 40) }));
    const before = snap();
    const buttons = lastKid ? [...lastKid.querySelectorAll('.nox-copy')] : [];
    for (const b of buttons) b.remove();
    const after = snap();
    let maxPrevOffsetDelta = 0;
    let changedPrev = 0;
    for (let i = 0; i < Math.max(0, kids.length - 1); i += 1) {
      const delta = Math.abs(after[i].top - before[i].top);
      if (delta > maxPrevOffsetDelta) maxPrevOffsetDelta = delta;
      if (delta > 0.5) changedPrev += 1;
    }
    const last = before.length ? before[before.length - 1] : null;
    const lastNo = after.length ? after[after.length - 1] : null;
    return {
      feedChildren: kids.length,
      removedButtons: buttons.length,
      totalButtons: list.querySelectorAll('.nox-copy').length + buttons.length,
      maxPrevOffsetDelta,
      changedPrev,
      lastTurnHeightWith: last ? last.height : null,
      lastTurnHeightWithout: lastNo ? lastNo.height : null,
      ownHeightDelta: last && lastNo ? last.height - lastNo.height : null,
    };
  })()`);
  await settle(win, 450);
  // Кнопки возвращает ensureCopyButtons при появлении нового хода: на голое удаление
  // наблюдатель ленты не срабатывает. Контрольное сообщение добавляет новый ход и тем
  // самым возвращает недостающую кнопку — проверяем это по числу кнопок.
  const restoreProbe = await submitAndWait(win, 'Проверка кнопки копирования Nox.', 20000);
  await settle(win, 700);
  const restored = await js(win, `(() => ({
    copies: document.querySelectorAll('#feedList .nox-copy').length,
    turns: document.querySelectorAll('#feedList .turn').length,
    answers: document.querySelectorAll('#feedList .md').length,
  }))()`);
  evidence.layoutShift = {
    ...shift,
    restoredCopies: restored.copies,
    restoredTurns: restored.turns,
    restoredAnswers: restored.answers,
    restoredExpected: shift.totalButtons + 1,
    restoreSentOk: Boolean(restoreProbe.poll && restoreProbe.poll.ok),
    note: 'Снята одна кнопка последнего ответа: offsetTop предыдущих реплик не меняется. Кнопки возвращает ensureCopyButtons при появлении нового хода; после контрольного сообщения кнопок ровно на одну больше.',
  };

  const ok = Boolean(info.visible && info.onScreen
    && info.labelBefore === 'Скопировать ответ'
    && click && click.clicked
    && afterClick && afterClick.label === 'Скопировано'
    && afterClick.copiedFlag === 'true'
    && (evidence.clipboard.exactMatch || evidence.clipboard.normalizedMatch)
    && reverted && reverted.label === 'Скопировать ответ'
    && focus && focus.activeIsButton
    && (evidence.hoverChanged || (hover && hover.hoverRulePresent))
    && shift && !shift.error && shift.changedPrev === 0
    && evidence.layoutShift.restoreSentOk
    && restored.copies === shift.totalButtons + 1);
  return { ok, evidence, screenshots };
}

async function checkFps(win) {
  const evidence = { window: {}, screen: {}, runs: [] };
  try { win.show(); win.focus(); } catch { /* не критично */ }
  await sleep(500);
  evidence.window = {
    visible: win.isVisible(),
    focused: win.isFocused(),
    contentSize: win.getContentSize(),
    bounds: win.getBounds(),
  };
  try {
    const display = screen.getPrimaryDisplay();
    evidence.screen = { scaleFactor: display.scaleFactor, size: display.size, workAreaSize: display.workAreaSize };
  } catch (err) {
    evidence.screen = { error: err && err.message ? err.message : String(err) };
  }
  const seq = ['wire', 'wire', 'nox'];
  const shots = [];
  for (let i = 0; i < seq.length; i += 1) {
    const variant = seq[i];
    const snap = await js(win, `(async () => {
      const proto = window.NoxOrb && window.NoxOrb.prototype;
      if (proto && !proto.__qaWrapped) {
        const orig = proto.setVariant;
        proto.setVariant = function (...args) {
          window.__qaOrb = this;
          return orig.apply(this, args);
        };
        proto.__qaWrapped = true;
      }
      window.NoxScreen.setVariant(${json(variant)});
      await new Promise((resolve) => setTimeout(resolve, 600));
      const raf = await new Promise((resolve) => {
        const start = performance.now();
        let frames = 0;
        function frame(t) {
          frames += 1;
          if (t - start >= 3000) {
            const ms = t - start;
            resolve({ frames, ms: Math.round(ms * 10) / 10, fps: Math.round((frames * 10000) / ms) / 10 });
            return;
          }
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
      const orb = window.__qaOrb || null;
      const stats = orb && typeof orb.getStats === 'function' ? orb.getStats() : null;
      return {
        requested: ${json(variant)},
        applied: window.NoxScreen.getVariant(),
        dpr: window.devicePixelRatio || 1,
        innerWidth,
        innerHeight,
        visibility: document.visibilityState,
        raf,
        orb: orb ? { found: true, stats } : { found: false, stats: null },
        orbCanvas: (() => {
          const c = document.querySelector('#noxOrb');
          if (!c) return null;
          const r = c.getBoundingClientRect();
          return { cssW: Math.round(r.width), cssH: Math.round(r.height), attrW: c.width, attrH: c.height };
        })(),
      };
    })()`);
    evidence.runs.push(snap);
    if (i === 0 || i === seq.length - 1) shots.push(await shot(win, `verify-fps-${i === 0 ? 'wire-1' : 'nox-1'}.png`));
  }
  const wireRuns = evidence.runs.filter((r) => r.requested === 'wire');
  const noxRun = evidence.runs.find((r) => r.requested === 'nox');
  evidence.summary = {
    wire: wireRuns.map((r) => ({ fps: r.raf.fps, frames: r.raf.frames, ms: r.raf.ms, orbFps: r.orb && r.orb.stats ? Math.round(r.orb.stats.fps * 10) / 10 : null, dpr: r.dpr, size: [r.innerWidth, r.innerHeight], visibility: r.visibility })),
    wireVarianceFps: wireRuns.length === 2 ? Math.round(Math.abs(wireRuns[0].raf.fps - wireRuns[1].raf.fps) * 10) / 10 : null,
    nox: noxRun ? { fps: noxRun.raf.fps, frames: noxRun.raf.frames, ms: noxRun.raf.ms, orbFps: noxRun.orb && noxRun.orb.stats ? Math.round(noxRun.orb.stats.fps * 10) / 10 : null, dpr: noxRun.dpr, size: [noxRun.innerWidth, noxRun.innerHeight], visibility: noxRun.visibility } : null,
    note: 'Замер rAF в видимом окне, variant через window.NoxScreen.setVariant; orb.getStats() снят через обёртку прототипа класса (инстанс не выставлен наружу).',
  };
  const ok = Boolean(evidence.runs.length === 3
    && evidence.runs.every((r) => r.raf && r.raf.frames > 0 && r.raf.ms >= 2900)
    && wireRuns.length === 2 && noxRun);
  return { ok, evidence, screenshots: shots };
}

async function checkConsole(win) {
  const page = await js(win, `(() => ({
    errors: window.__qaErrors || [],
    events: (window.__qaEvents || []).length,
    visibility: document.visibilityState,
    state: window.__qa.state(),
  }))()`);
  const consoleErr = consoleErrors.slice();
  const evidence = {
    consoleErrors: consoleErr,
    consoleWarningsCount: consoleWarnings.length,
    consoleWarnings: consoleWarnings.slice(0, 10),
    pageErrors: page.errors,
    pageEvents: page.events,
    visibility: page.visibility,
    finalState: page.state,
  };
  const ok = consoleErrors.length === 0 && page.errors.length === 0;
  const screenshots = [await shot(win, 'verify-console-1.png')];
  return { ok, evidence, screenshots };
}

// ── Окружение и отчёт ──────────────────────────────────────────────
async function collectEnvironment(win) {
  const page = await js(win, `(() => {
    const style = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight };
    };
    const tokens = getComputedStyle(document.body);
    const bannerWrap = document.getElementById('bannerWrap');
    const bannerText = document.getElementById('bannerText');
    return {
      title: document.title,
      bodyView: document.body ? document.body.dataset.view : null,
      dpr: window.devicePixelRatio || 1,
      inner: [window.innerWidth, window.innerHeight],
      visibility: document.visibilityState,
      banner: {
        visible: bannerWrap ? !bannerWrap.hidden : null,
        text: bannerText ? bannerText.textContent.trim().slice(0, 300) : null,
        kind: document.getElementById('banner') ? document.getElementById('banner').dataset.kind : null,
      },
      typography: {
        historyTitle: style('#noxHistTitle'),
        historyRow: style('.nox-hist-open'),
        message: style('#feedList .md'),
        userMessage: style('#feedList .msg-user-text'),
        input: style('#chatInput'),
        composerPick: style('#composer .pick-trigger'),
      },
      fonts: {
        installedInterCyrillic: document.fonts ? document.fonts.check('14px Inter', 'Привет') : null,
        status: document.fonts ? document.fonts.status : null,
      },
      tokens: {
        font: tokens.getPropertyValue('--font').trim().slice(0, 200),
        rail: tokens.getPropertyValue('--rail-w').trim(),
        history: tokens.getPropertyValue('--nox-history-w').trim(),
        sphere: tokens.getPropertyValue('--nox-sphere-w').trim(),
        orb: tokens.getPropertyValue('--nox-orb-size').trim(),
      },
      api: {
        NoxScreen: !!(window.NoxScreen && window.NoxScreen.geometry),
        NoxOrb: typeof window.NoxOrb,
        JarvisNox: !!(window.JarvisNox && window.JarvisNox.changeChat),
        jarvis: !!(window.jarvis && window.jarvis.send),
      },
      initialVariant: window.NoxScreen && typeof window.NoxScreen.getVariant === 'function' ? window.NoxScreen.getVariant() : null,
      chatEmptyHidden: document.querySelector('#chatEmpty') ? document.querySelector('#chatEmpty').hidden : null,
    };
  })()`);
  return {
    ...page,
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      pid: process.pid,
      appDir: APP_DIR,
      tempProfile: profileDir,
      tempData: dataDir,
      repoRoot: REPO_ROOT,
      outDir: OUT_DIR,
    },
  };
}

async function hideBannerForLayout(win) {
  const res = await js(win, `(() => {
    window.__qaHideBanner = true;
    const wrap = document.getElementById('bannerWrap');
    if (!wrap) return { hidden: false };
    const hide = () => { if (window.__qaHideBanner && wrap && !wrap.hidden) wrap.hidden = true; };
    hide();
    const mo = new MutationObserver(hide);
    mo.observe(wrap, { attributes: true, attributeFilter: ['hidden'] });
    window.__qaBannerObserver = mo;
    return { hidden: wrap.hidden };
  })()`);
  await sleep(300);
  return res;
}

function recordCheck(checks, name, result) {
  const entry = {
    check: name,
    ok: Boolean(result && result.ok),
    evidence: result ? result.evidence : null,
    screenshot: result && result.screenshots && result.screenshots[0] ? result.screenshots[0].name : null,
    screenshots: result ? screenshotNames(result.screenshots) : [],
  };
  checks.push(entry);
  console.log(`NOX_QA_CHECK ${name} ${entry.ok ? 'PASS' : 'FAIL'}` + (entry.ok ? '' : ' ' + json(entry.evidence).slice(0, 900)));
  return entry;
}

async function runChecks(win) {
  const checks = [];
  const started = Date.now();
  await waitVisible(win);
  await waitPageReady(win);
  await js(win, PAGE_INIT);
  const environment = await collectEnvironment(win);
  const bannerHidden = await hideBannerForLayout(win);
  environment.layoutPrep = { bannerVisibleAtLoad: environment.banner ? environment.banner.visible : null, bannerHiddenForLayout: bannerHidden };
  await setContentSize(win, 1200, 720);
  await settle(win, 500);

  const runner = async (name, fn) => {
    try {
      recordCheck(checks, name, await fn(win));
    } catch (err) {
      recordCheck(checks, name, {
        ok: false,
        evidence: { error: err && err.message ? err.message : String(err), stack: String(err && err.stack || '').slice(0, 800) },
        screenshots: [],
      });
    }
  };

  await runner('new-chat', checkNewChat);
  await runner('switch-chat', checkSwitchChat);
  await runner('send-message', checkSend);
  await runner('cancel-generation', checkCancel);
  await runner('long-scroll', checkScroll);
  await runner('resize', checkResize);
  await runner('copy-button', checkCopy);
  await runner('fps', checkFps);
  await runner('console-errors', checkConsole);

  const finishedAt = Date.now();
  const pass = checks.filter((c) => c.ok).length;
  const report = {
    startedAt,
    finishedAt,
    elapsedMs: finishedAt - started,
    appDir: APP_DIR,
    outDir: OUT_DIR,
    environment,
    checks,
    consoleErrors,
    consoleWarnings,
    summary: { total: checks.length, pass, fail: checks.length - pass, ok: checks.length === 9 && pass === checks.length },
    limits: [
      'Проверка шла во временном профиле/данных; реальный профиль владельца (%APPDATA%\\jarvis-desktop) не использовался. Запущенный экземпляр владельца не трогали.',
      'Мозг — локальный OpenAI-совместимый SSE-сервер внутри стенда (NOX_BRAIN_KEY/NOX_BRAIN_URL, 127.0.0.1): обычный ответ короткий, а на фразу «отмена» — поток ~4 с, чтобы отмену можно было реально нажать. Внешняя сеть и реальные модели не используются.',
      'Баннер «нет модели» снят с отображения после фиксации его состояния: это окружение временного профиля, а не предмет проверки (как в scripts/nox-shot.js).',
      'Минимальный размер окна временно снижен (960x640 -> 200x200), иначе 864x520 недостижим; это только на время стенда.',
      'Флаги CalculateNativeWinOcclusion/disable-backgrounding-occluded-windows включены для стабильного capturePage; FPS снимался после show()+focus(), состояние окна зафиксировано в отчёте.',
      'Реальный тест шрифтов пользовательского профиля (Sitka/Georgia) — зона Lead; здесь фиксируются computed font-family Nox в чистом профиле.',
      'Приложение не проверялось на реальных системных командах: отправляемые сообщения безвредны и уходят только на локальный QA-сервер в этом же процессе.',
    ],
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = path.join(OUT_DIR, 'verify-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  const summary = {
    ok: report.summary.ok,
    report: reportPath,
    outDir: OUT_DIR,
    elapsedMs: report.elapsedMs,
    pass,
    fail: report.summary.fail,
    checks: checks.map((c) => ({ check: c.check, ok: c.ok })),
    screenshots: checks.flatMap((c) => c.screenshots),
  };
  console.log('NOX_QA_REPORT ' + reportPath);
  finish(summary);
}

// ── Запуск настоящего приложения ───────────────────────────────────
function attachWindow(win) {
  try {
    win.webContents.setBackgroundThrottling(false);
  } catch { /* старые версии Electron */ }
  try {
    win.webContents.on('console-message', (event, level, message) => {
      try {
        const details = event && typeof event === 'object' && (event.message !== undefined || event.level !== undefined)
          ? event
          : (typeof level === 'object' && level ? level : null);
        const severity = details ? details.level : level;
        const text = details ? details.message : message;
        const clean = String(text == null ? '' : text).slice(0, 400);
        if (severity === 'error' || severity === 3) {
          if (consoleErrors.length < 50) consoleErrors.push(clean);
        } else if (severity === 'warning' || severity === 2) {
          if (consoleWarnings.length < 50) consoleWarnings.push(clean);
        }
      } catch { /* подписка не критична */ }
    });
  } catch { /* старые версии Electron */ }
  try {
    win.webContents.on('render-process-gone', (_event, details) => {
      consoleErrors.push('render-process-gone: ' + json(details));
    });
  } catch { /* не критично */ }

  win.webContents.once('did-finish-load', () => {
    if (mainWin) return;
    let url = '';
    try { url = win.webContents.getURL(); } catch { url = ''; }
    if (!/renderer[\\/]index\.html/i.test(url)) return;
    mainWin = win;
    runChecks(win).catch((err) => fail(err));
  });

  win.once('closed', () => {
    if (!finished && win === mainWin) fail('окно закрылось до конца проверки');
  });
}

app.on('browser-window-created', (_event, win) => attachWindow(win));

// Свой мозг поднимаем раньше main.js: он читает process.env при загрузке.
startQaBrainServer().then((brain) => {
  process.env.NOX_BRAIN_KEY = 'qa-local-test-key';
  process.env.NOX_BRAIN_URL = `http://127.0.0.1:${brain.port}/v1`;
  try {
    require('../main');
  } catch (err) {
    fail('main.js не загрузился: ' + (err && err.message ? err.message : String(err)));
  }
}).catch((err) => fail('QA-мозг не поднялся: ' + (err && err.message ? err.message : String(err))));
