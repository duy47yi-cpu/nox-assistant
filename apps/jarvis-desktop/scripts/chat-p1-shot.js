'use strict';

// Живая проверка P1 чата Nox Aether в настоящем Electron: колонка истории,
// сворачивание, выезд поверх на узком окне, время у реплик и перезапуск окна.
// Запуск из apps/jarvis-desktop (со снятым ELECTRON_RUN_AS_NODE):
//   .\node_modules\electron\dist\electron.exe scripts\chat-p1-shot.js --out-dir <папка> --state-dir <папка>
//   тот же вызов с --restart — второй запуск на тех же данных (проверка перезапуска).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let electron = null;
try { electron = require('electron'); } catch { electron = null; }
if (!electron || typeof electron !== 'object' || !electron.app || typeof electron.app.whenReady !== 'function') {
  console.error('chat-p1-shot: требуется запуск через electron.exe, а не node (снимите ELECTRON_RUN_AS_NODE)');
  process.exit(1);
}

const { app, globalShortcut, shell } = electron;

const OUT_DIR = path.resolve(arg('out-dir', path.join(os.tmpdir(), 'chat-p1-shots')));
const RESTART = has('restart');
const THEME = arg('theme', '');
const TIMEOUT_MS = 180000;

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}
function has(name) { return process.argv.includes(`--${name}`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ── Изолированный профиль и данные ────────────────────────────────────
const stateArg = arg('state-dir', '');
const stateRoot = stateArg ? path.resolve(stateArg) : fs.mkdtempSync(path.join(os.tmpdir(), 'nox-chat-p1-'));
const profileDir = path.join(stateRoot, 'profile');
const dataDir = path.join(stateRoot, 'data');
const workspaceDir = path.join(stateRoot, 'workspace');
for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });

const now = Date.now();
const day = 86400000;
const conversationFile = path.join(dataDir, 'conversation.json');
if (!fs.existsSync(conversationFile)) {
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    uiShell: 'aether', mode: 'ask', voice: false, backgroundModelRuns: false,
    alwaysListen: false, dictation: false, desktopOverlay: false, alwaysOnTop: false,
    motion: true, seededBrief: true, screenAuto: false,
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(workspaceDir, 'notes.md'), '# Заметки\n\nСтенд P1 чата.\n', 'utf8');
  fs.writeFileSync(conversationFile, JSON.stringify({
    activeId: 'p1-live',
    chats: [
      { id: 'p1-live', title: 'Новый чат', updatedAt: now, history: [] },
      {
        id: 'p1-today', title: 'Что по погоде?', updatedAt: now - 3 * 3600000,
        history: [
          { role: 'user', content: 'Что по погоде?' },
          { role: 'assistant', content: 'Сегодня ясно, около +12. Вечером прохладнее.' },
        ],
      },
      {
        id: 'p1-yesterday', title: 'Покажи план на неделю', updatedAt: now - day,
        history: [
          { role: 'user', content: 'Покажи план на неделю' },
          { role: 'assistant', content: 'Собрал ключевые задачи: обзор макетов, проверка сфер и тесты сборки.' },
        ],
      },
      {
        id: 'p1-old', title: 'Разбери макет интерфейса', updatedAt: now - 6 * day,
        history: [
          { role: 'user', content: 'Разбери макет интерфейса' },
          { role: 'assistant', content: 'В макете три колонки: история, лента и сцена сферы.' },
        ],
      },
    ],
  }, null, 2), 'utf8');
}

app.setPath('userData', profileDir);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = dataDir;
require('../src/config/paths').projectRoot = () => stateRoot;

globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
shell.openExternal = async () => {};

// ── Локальный OpenAI-совместимый SSE-сервер (без внешней сети) ────────
function startBrain() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
        const chunks = [
          { content: 'Стрелец A* — сверхмассивная чёрная дыра в центре Млечного Пути, ' },
          { content: 'около 4 миллионов масс Солнца. Расстояние до неё примерно 26 тысяч световых лет.' },
        ];
        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'p1', object: 'chat.completion', model: 'p1-local',
            choices: [{ index: 0, message: { role: 'assistant', content: chunks.map((c) => c.content).join('') }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
          }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
        });
        let closed = false;
        res.on('close', () => { closed = true; });
        let i = 0;
        const step = () => {
          if (closed) return;
          if (i < chunks.length) {
            res.write(`data: ${JSON.stringify({ id: 'p1', object: 'chat.completion.chunk', model: 'p1-local', choices: [{ index: 0, delta: chunks[i], finish_reason: null }] })}\n\n`);
            i += 1;
            setTimeout(step, 20);
            return;
          }
          res.write(`data: ${JSON.stringify({ id: 'p1', object: 'chat.completion.chunk', model: 'p1-local', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'p1', object: 'chat.completion.chunk', model: 'p1-local', choices: [], usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        };
        step();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ── Окно и снимки ─────────────────────────────────────────────────────
const consoleErrors = [];
const pageErrors = [];
const checks = [];
const screenshots = [];
const startedAt = Date.now();
let finished = false;
let brainSrv = null;

const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

async function js(win, code) { return win.webContents.executeJavaScript(code, true); }

async function settle(win, ms = 140) {
  if (ms) await sleep(ms);
  await js(win, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))').catch(() => false);
}

async function setViewport(win, width, height) {
  try { win.setMinimumSize(200, 200); } catch { /* ignore */ }
  win.setContentSize(width, height);
  for (let i = 0; i < 60; i += 1) {
    const [w, h] = win.getContentSize();
    if (w === width && h === height) break;
    await sleep(30);
  }
  await settle(win, 220);
}

async function shot(win, fileName) {
  try { win.showInactive(); } catch { /* visible */ }
  await settle(win, 140);
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, fileName);
  fs.writeFileSync(file, img.toPNG());
  const sz = img.getSize();
  screenshots.push({ name: fileName, file, width: sz.width, height: sz.height });
  return file;
}

async function waitUntil(fn, timeout = 15000, interval = 80) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => false);
    if (value) return value;
    if (Date.now() > end) return false;
    await sleep(interval);
  }
}

async function waitIdle(win, timeout = 25000) {
  const ok = await waitUntil(() => js(win, `(() => {
    const st = window.__noxAether?.store?.state;
    return Boolean(st && !st.trackerBusy && !st.sendingLock);
  })()`), timeout);
  if (!ok) throw new Error('waitIdle timeout');
  await settle(win, 200);
}

async function sendText(win, text) {
  await js(win, `(() => {
    const ta = document.querySelector('#chatInput');
    ta.focus();
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
}

const GEOMETRY = `(() => {
  const rail = document.querySelector('.ae-utility-rail');
  const wrap = document.querySelector('#aeHistoryWrap');
  const side = document.querySelector('.ae-sidebar');
  const chat = document.querySelector('#noxChat');
  const orb = document.querySelector('#aeOrbStage');
  const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) }; };
  return {
    rail: r(rail), side: r(side), chat: r(chat), orb: r(orb),
    open: wrap.classList.contains('is-open'),
    inert: wrap.inert,
    backdrop: getComputedStyle(document.querySelector('.ae-sidebar-backdrop')).display,
    position: getComputedStyle(wrap).position,
    groups: [...document.querySelectorAll('.ae-chat-group-title')].map((g) => g.textContent),
    rows: [...document.querySelectorAll('.ae-chat-row')].map((row) => ({
      title: row.querySelector('.ae-chat-title')?.textContent || '',
      time: row.querySelector('.ae-chat-time')?.textContent || '',
      active: row.classList.contains('is-active'),
    })),
    newChat: document.querySelector('#aeNewChatBtn')?.innerText.trim() || '',
    collapse: Boolean(document.querySelector('.ae-sidebar-collapse')),
    pref: localStorage.getItem('aether.historyOpen'),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    innerWidth: window.innerWidth,
  };
})()`;

const TIMES = `(() => {
  const pick = (sel) => [...document.querySelectorAll(sel)].map((m) => ({
    time: m.querySelector('.ae-msg-time')?.textContent || '',
    head: m.querySelector('.ae-reply-author')?.textContent || '',
  }));
  return { user: pick('#feed .ae-msg.is-user'), assistant: pick('#feed .ae-msg.is-assistant') };
})()`;

function finish(report, code = 0) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  try { if (brainSrv) brainSrv.server.close(); } catch { /* ignore */ }
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, RESTART ? 'p1-restart-report.json' : 'p1-report.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log('CHAT_P1_RESULT ' + JSON.stringify({
    ok: report.ok, pass: report.pass, fail: report.fail,
    mode: RESTART ? 'restart' : 'record',
    consoleErrors: consoleErrors.length, pageErrors: pageErrors.length,
    stateDir: stateRoot, outDir: OUT_DIR,
  }));
  if (!stateArg) { try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
  app.exit(code);
}

const deadline = setTimeout(() => finish({ ok: false, error: `Timeout ${TIMEOUT_MS}ms`, consoleErrors, pageErrors }, 1), TIMEOUT_MS);

async function run(win) {
  if (!await waitUntil(() => js(win, 'Boolean(window.__noxAether)'))) throw new Error('Окно чата не загрузилось');
  await js(win, "window.__noxAether.setRoute('chat')");
  await settle(win, 250);

  if (THEME) {
    const id = JSON.stringify(THEME);
    await js(win, `(() => {
      localStorage.setItem('aether.themeChosen', '1');
      localStorage.setItem('jarvis.theme', ${id});
      window.JarvisTheme.apply(${id});
      document.dispatchEvent(new Event('jarvis:themechange'));
      return document.documentElement.dataset.theme;
    })()`);
    await settle(win, 250);
  }

  if (RESTART) {
    await setViewport(win, 1200, 720);
    await js(win, "window.__noxAether.store.selectChat('p1-live')");
    await waitIdle(win);
    const expected = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'p1-times.json'), 'utf8'));
    const times = await js(win, TIMES);
    const geo = await js(win, GEOMETRY);
    check('После перезапуска история и время на месте',
      JSON.stringify(times) === JSON.stringify(expected.times)
      && times.assistant.every((m) => /^\d{2}:\d{2}$/.test(m.time))
      && geo.open && geo.side.width === 256 && geo.pref === '1',
      { times, expected: expected.times, geo });
    await shot(win, '08-после-перезапуска-1200x720.png');
    const pass = checks.filter((c) => c.ok).length;
    finish({ ok: pass === checks.length, pass, fail: checks.length - pass, elapsedMs: Date.now() - startedAt, checks, screenshots, consoleErrors, pageErrors }, pass === checks.length ? 0 : 1);
    return;
  }

  // 1. Постоянная колонка слева от ленты на 1200×720
  await setViewport(win, 1200, 720);
  await js(win, "window.__noxAether.store.selectChat('p1-live')");
  await waitIdle(win);
  const wide = await js(win, GEOMETRY);
  check('Колонка истории 256 px между рейкой и лентой, группы «Сегодня»/«Ранее»',
    wide.rail.width === 56 && wide.open && wide.side.width === 256
    && wide.side.left >= wide.rail.right && wide.chat.left >= wide.side.right
    && wide.orb.left >= wide.chat.right && wide.position === 'relative'
    && wide.groups.join(' · ') === 'Сегодня · Ранее' && wide.rows.length === 4
    && wide.rows.every((row) => row.time) && wide.rows.filter((row) => row.active).length === 1
    && /Новый чат/.test(wide.newChat) && wide.collapse && !wide.overflow,
    wide);
  await shot(win, '01-колонка-истории-1200x720.png');

  // 2. Живые ходы: время у вопроса и у ответа
  await sendText(win, 'Расскажи про Стрелец A*');
  await waitIdle(win);
  await sendText(win, 'А что ещё?');
  await waitIdle(win);
  const live = await js(win, TIMES);
  check('У каждой реплики подпись ЧЧ:ММ, у ответа — рядом с меткой Nox',
    live.user.length === 2 && live.assistant.length === 2
    && live.user.every((m) => /^\d{2}:\d{2}$/.test(m.time))
    && live.assistant.every((m) => /^\d{2}:\d{2}$/.test(m.time) && m.head === 'Nox'),
    live);
  await shot(win, '02-время-сообщений-1200x720.png');

  // 3. Возврат в чат из истории: время восстановлено, а не выдумано
  await js(win, "window.__noxAether.store.selectChat('p1-yesterday')");
  await waitIdle(win);
  const other = await js(win, TIMES);
  await js(win, "window.__noxAether.store.selectChat('p1-live')");
  await waitIdle(win);
  const restored = await js(win, TIMES);
  check('Время возвращается после переключения чатов; старая история без отметок — без времени',
    JSON.stringify(restored) === JSON.stringify(live)
    && other.user.length === 1 && other.assistant.length === 1
    && other.user[0].time === '' && other.assistant[0].time === '',
    { live, restored, other });
  await shot(win, '03-время-после-возврата-1200x720.png');
  fs.writeFileSync(path.join(OUT_DIR, 'p1-times.json'), JSON.stringify({ times: live }, null, 2), 'utf8');

  // 4. Сворачивание колонки: 0 px, лента шире, выбор в localStorage
  const beforeCollapse = await js(win, GEOMETRY);
  await js(win, "document.querySelector('.ae-sidebar-collapse').click()");
  await settle(win, 320);
  const collapsed = await js(win, GEOMETRY);
  check('Колонка сворачивается в 0 px, чат расширяется, состояние сохранено',
    !collapsed.open && collapsed.side.width === 0 && collapsed.inert
    && collapsed.chat.width > beforeCollapse.chat.width && collapsed.pref === '0'
    && !collapsed.overflow,
    { beforeCollapse, collapsed });
  await shot(win, '04-колонка-свёрнута-1200x720.png');

  await js(win, "document.querySelector('#aeHistoryToggle').click()");
  await settle(win, 320);
  const reopened = await js(win, GEOMETRY);
  check('Кнопка рейки возвращает колонку', reopened.open && reopened.side.width === 256 && reopened.pref === '1', reopened);

  // 5. Узкое окно: колонка сама уходит, выбор владельца не затирается
  await setViewport(win, 864, 520);
  const narrow = await js(win, GEOMETRY);
  check('На 864×520 колонка скрыта и не сжимает чат, выбор владельца сохранён',
    !narrow.open && narrow.side.width === 0 && narrow.pref === '1' && !narrow.overflow,
    narrow);
  await shot(win, '05-узкое-окно-864x520.png');

  // 6. Выезд поверх по кнопке, закрытие по Esc и по клику мимо
  await js(win, "document.querySelector('#aeHistoryToggle').click()");
  await settle(win, 320);
  const overlay = await js(win, GEOMETRY);
  const overlayChat = await js(win, "document.querySelector('#noxChat').getBoundingClientRect().width");
  check('На узком окне история выезжает поверх ленты',
    overlay.open && overlay.position === 'absolute' && overlay.backdrop === 'block'
    && overlay.side.width === 256 && Math.round(overlayChat) === narrow.chat.width,
    { overlay, narrowChat: narrow.chat.width, overlayChat });
  await shot(win, '06-история-поверх-864x520.png');

  await js(win, "document.querySelector('#aeNewChatBtn').focus()");
  await js(win, "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await settle(win, 300);
  const afterEsc = await js(win, `(() => ({
    open: document.querySelector('#aeHistoryWrap').classList.contains('is-open'),
    inert: document.querySelector('#aeHistoryWrap').inert,
    focusOnTrigger: document.activeElement === document.querySelector('#aeHistoryToggle'),
  }))()`);
  check('Esc закрывает историю и возвращает фокус на кнопку',
    !afterEsc.open && afterEsc.inert && afterEsc.focusOnTrigger, afterEsc);

  await js(win, "document.querySelector('#aeHistoryToggle').click()");
  await settle(win, 300);
  await js(win, "document.querySelector('.ae-sidebar-backdrop').click()");
  await settle(win, 300);
  const afterOutside = await js(win, "document.querySelector('#aeHistoryWrap').classList.contains('is-open')");
  check('Клик мимо колонки закрывает её', afterOutside === false, { afterOutside });
  await shot(win, '07-время-на-узком-окне-864x520.png');

  // 7. Возврат на широкое окно: колонка снова постоянная
  await setViewport(win, 1200, 720);
  await js(win, "window.__noxAether.store.toggleHistory(true)");
  await settle(win, 320);
  const backWide = await js(win, GEOMETRY);
  check('После расширения окна колонка возвращается', backWide.open && backWide.side.width === 256 && backWide.pref === '1', backWide);

  check('Нет ошибок окна и все снимки нужного размера',
    consoleErrors.length === 0 && pageErrors.length === 0
    && screenshots.every((s) => s.name.includes(`${s.width}x${s.height}`)),
    { consoleErrors, pageErrors, screenshots });

  const pass = checks.filter((c) => c.ok).length;
  finish({ ok: pass === checks.length, pass, fail: checks.length - pass, elapsedMs: Date.now() - startedAt, checks, screenshots, consoleErrors, pageErrors }, pass === checks.length ? 0 : 1);
}

app.on('browser-window-created', (_event, win) => {
  try { win.webContents.setBackgroundThrottling(false); } catch { /* ignore */ }
  win.webContents.on('console-message', (_ev, level, msg) => {
    if (level === 3 || level === 'error') consoleErrors.push(String(msg || '').slice(0, 400));
  });
  win.webContents.on('render-process-gone', (_ev, details) => pageErrors.push('render-process-gone: ' + JSON.stringify(details)));
  win.webContents.once('did-finish-load', () => {
    const url = win.webContents.getURL();
    if (!/renderer[\\/]aether[\\/]index\.html/i.test(url)) return;
    run(win).catch((err) => finish({ ok: false, error: err && err.stack ? err.stack : String(err), consoleErrors, pageErrors }, 1));
  });
});

startBrain()
  .then((srv) => {
    brainSrv = srv;
    process.env.NOX_BRAIN_KEY = 'p1-local-test-key';
    process.env.NOX_BRAIN_URL = `http://127.0.0.1:${srv.port}/v1`;
    require('../main');
  })
  .catch((err) => finish({ ok: false, error: err && err.stack ? err.stack : String(err) }, 1));