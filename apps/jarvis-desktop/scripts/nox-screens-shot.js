'use strict';

// Снимки и живые проверки разделов Nox как самостоятельных экранов.
// Отдельный Electron с временным профилем и временными данными (настоящая папка data/ не читается).
//
// Из папки apps/jarvis-desktop (ELECTRON_RUN_AS_NODE должен быть снят):
//   electron scripts/nox-screens-shot.js --out <папка> [--sizes 1600x900,1200x720,864x520]
//     [--views nox,settings,commands,mcp,journal,account] [--no-qa] [--no-shots]
//
// Печатает одну строку NOX_SCREENS_RESULT <json>: снятые файлы и результаты проверок; код 0 — всё прошло.

const fs = require('fs');
const os = require('os');
const path = require('path');

let electron = null;
try { electron = require('electron'); } catch { electron = null; }
if (!electron || !electron.app || typeof electron.app.whenReady !== 'function') {
  console.error('nox-screens-shot: нужен запуск через electron.exe: снимите ELECTRON_RUN_AS_NODE');
  process.exit(1);
}
const { app, globalShortcut, dialog, ipcMain } = electron;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
const outDir = path.resolve(arg('out', path.join(os.tmpdir(), 'nox-screens')));
const sizes = String(arg('sizes', '1600x900,1200x720,864x520')).split(',').map((s) => s.split('x').map(Number));
const views = String(arg('views', 'nox,settings,commands,mcp,journal,account')).split(',');
const doQa = !has('no-qa');
const doShots = !has('no-shots');

// ── Временный профиль и данные ────────────────────────────────────
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-screens-shot-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
for (const dir of [profileDir, dataDir, path.join(tempRoot, 'workspace')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  voice: false, backgroundModelRuns: false, alwaysListen: false, dictation: false,
  desktopOverlay: false, alwaysOnTop: false, motion: true, seededBrief: true,
  // Снимки классических экранов Nox: оболочка legacy, а не Aether.
  uiShell: 'legacy',
}), 'utf8');
const now = Date.now();
const day = 86400000;
const longHistory = [];
for (let i = 1; i <= 12; i += 1) {
  longHistory.push({ role: 'user', content: `Реплика ${i}: проверка ленты при переходах между разделами.` });
  longHistory.push({ role: 'assistant', content: `Ответ ${i}: беседа должна остаться на месте после Настроек, Команд и Журнала.` });
}
fs.writeFileSync(path.join(dataDir, 'conversation.json'), JSON.stringify({
  activeId: 'chat-long',
  chats: [
    { id: 'chat-long', updatedAt: now, history: longHistory },
    { id: 'chat-plans', updatedAt: now - 2 * day, history: [{ role: 'user', content: 'Планы на сегодня' }, { role: 'assistant', content: 'Разобрать почту и подготовить отчёт.' }] },
    { id: 'chat-short', updatedAt: now - 3 * day, history: [{ role: 'user', content: 'Короткий чат' }, { role: 'assistant', content: 'Ответ короткого чата.' }] },
  ],
}, null, 2), 'utf8');

// Журнал: по одной записи на каждый честный статус, чтобы видеть таблицу, а не пустой экран.
const jts = (min) => new Date(now - min * 60000).toISOString();
fs.writeFileSync(path.join(dataDir, 'journal.jsonl'), [
  { ts: jts(42), tool: 'app_open', args: { name: 'Блокнот' }, risk: 'low', ok: true, verified: 'confirmed', summary: 'Блокнот открыт', evidence: 'окно «Блокнот» найдено' },
  { ts: jts(30), tool: 'volume_set', args: { level: 30 }, risk: 'low', ok: true, verified: 'unverified', summary: 'Громкость 30 %' },
  { ts: jts(18), tool: 'url_open', args: { url: 'https://example.org' }, risk: 'low', ok: true, verified: 'failed', summary: 'Страница не открылась за 10 секунд' },
  { ts: jts(6), tool: 'shell_run', args: { command: 'Get-Date' }, risk: 'high', ok: false, decision: 'reject', summary: 'Отклонено' },
].map((r) => JSON.stringify(r) + '\n').join(''), 'utf8');

app.setPath('userData', profileDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
for (const key of Object.keys(process.env)) {
  // NOX_UI оставляем: им задаётся оболочка (для этого стенда — legacy).
  if (key === 'NOX_UI') continue;
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
require('../src/config/paths').projectRoot = () => tempRoot;
try {
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  dialog.showMessageBoxSync = () => 0;
  dialog.showErrorBox = () => {};
} catch { /* старые версии Electron */ }
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

// Счётчик отправок в ядро: навигация не должна запускать ход повторно.
let sends = 0;
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => origHandle(channel, channel === 'chat:send' ? (...a) => { sends += 1; return fn(...a); } : fn);

let finished = false;
let mainWin = null;
const consoleErrors = [];
function finish(result) {
  if (finished) return;
  finished = true;
  process.stdout.write(`NOX_SCREENS_RESULT ${JSON.stringify(result)}\n`, () => setTimeout(() => app.exit(result.ok ? 0 : 1), 30));
  setTimeout(() => app.exit(1), 2000).unref();
}
process.on('exit', () => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* занято */ } });
process.on('uncaughtException', (err) => finish({ ok: false, error: `uncaught: ${err && err.message}` }));
const deadline = setTimeout(() => finish({ ok: false, error: 'timeout 240 с' }), 240000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (win, code) => win.webContents.executeJavaScript(code, true);
async function waitFor(win, code, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { const v = await js(win, code); if (v) return v; } catch { /* страница ещё грузится */ }
    await sleep(150);
  }
  throw new Error(`не дождались: ${label}`);
}
async function resize(win, w, h) {
  win.setContentSize(w, h);
  for (let i = 0; i < 40; i += 1) { const [cw, ch] = win.getContentSize(); if (cw === w && ch === h) break; await sleep(50); }
  await sleep(350);
}
async function show(win, view) {
  await js(win, `(() => { try { window.JarvisNox.show(${JSON.stringify(view)}); } catch (e) {} return true; })()`);
  await waitFor(win, `document.body.dataset.view === ${JSON.stringify(view)}`, `раздел ${view}`);
  await sleep(view === 'settings' ? 900 : 600);
}

// Видимые элементы, у которых центр перекрыт чужим элементом или которые вылезли за окно.
const LAYOUT_JS = `(() => {
  const doc = document.documentElement;
  const out = { view: document.body.dataset.view, hOverflow: doc.scrollWidth > innerWidth + 1, blocked: [], outside: [] };
  const sel = '.nox-topbar button, .rail button, .view:not([hidden]) button, .view:not([hidden]) input, .view:not([hidden]) textarea';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (el.closest('[hidden], dialog:not([open])')) continue;
    const name = (el.id ? '#' + el.id : el.className || el.tagName) + ' ' + (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24);
    if (r.right > innerWidth + 1 || r.left < -1) { out.outside.push(name); continue; }
    // Внутри прокручиваемой области кнопка может быть ниже края — это нормально.
    if (r.bottom > innerHeight || r.top < 0) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      // Прокручиваемый родитель обрезает строки списка — отличаем от настоящего перекрытия.
      let clip = el.parentElement, clipped = false;
      while (clip && clip !== document.body) {
        const cs = getComputedStyle(clip);
        if (/(auto|scroll|hidden|clip)/.test(cs.overflowY + cs.overflowX)) {
          const cr = clip.getBoundingClientRect();
          if (cy < cr.top || cy > cr.bottom || cx < cr.left || cx > cr.right) { clipped = true; break; }
        }
        clip = clip.parentElement;
      }
      if (!clipped) out.blocked.push(name + ' ← ' + (hit.id ? '#' + hit.id : hit.className || hit.tagName));
    }
  }
  out.blocked = out.blocked.slice(0, 12);
  out.outside = out.outside.slice(0, 12);
  return out;
})()`;

const vis = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`;

async function chatState(win) {
  return js(win, `(async () => {
    const list = await window.jarvis.chatList().catch(() => null);
    return {
      active: list && list.activeId,
      messages: document.querySelectorAll('#feed .msg-user, #feed .msg-reply, #feed .turn').length,
      draft: (document.querySelector('#chatInput') || {}).value || '',
      historyVisible: ${vis('#noxHistory')},
      composerVisible: ${vis('#chatInput')},
      sphereVisible: ${vis('#noxSphere')},
    };
  })()`);
}

async function snap(win, name) {
  if (!doShots) return;
  await sleep(250);
  fs.writeFileSync(path.join(outDir, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

async function runQa(win) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  await resize(win, 1200, 720);
  await show(win, 'nox');
  await js(win, `(() => { const i = document.querySelector('#chatInput'); i.value = 'черновик не теряется'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const base = await chatState(win);
  check('Чат: история, поле ввода и сфера видны', base.historyVisible && base.composerVisible && base.sphereVisible, base);
  const sendsBefore = sends;
  await js(win, `(() => {
    window.__noxHistoryCalls = 0;
    window.__noxHistoryObserver = new MutationObserver(() => { window.__noxHistoryCalls += 1; });
    window.__noxHistoryObserver.observe(document.querySelector('#noxHistSections'), { childList: true });
    return true;
  })()`);

  for (const [view, label] of [['settings', 'Настройки'], ['commands', 'Команды']]) {
    await show(win, view);
    const s = await chatState(win);
    check(`${label}: нет истории, поля ввода и сферы`, !s.historyVisible && !s.composerVisible && !s.sphereVisible, s);
    await show(win, 'nox');
    const back = await chatState(win);
    check(`Чат → ${label} → Чат: та же беседа и черновик`, back.active === base.active && back.messages === base.messages && back.draft === base.draft, back);
  }

  const historyBefore = await js(win, 'window.__noxHistoryCalls');
  await show(win, 'settings');
  await show(win, 'nox');
  const historyCalls = (await js(win, 'window.__noxHistoryCalls')) - historyBefore;
  check('Возврат в чат обновляет историю один раз', historyCalls === 1, `chatList: ${historyCalls}`);

  await show(win, 'mcp');
  const mcp = await chatState(win);
  check('Подключения: свой экран', !mcp.historyVisible && !mcp.composerVisible && !mcp.sphereVisible && await js(win, vis('#mcpPage')), mcp);
  await show(win, 'journal');
  const jr = await chatState(win);
  check('Подключения → Журнал: свой экран', !jr.historyVisible && !jr.composerVisible && await js(win, vis('.view-journal')), jr);

  // Общая шапка: бренд, настройки, профиль, кнопки окна — на каждом разделе.
  const top = [];
  for (const v of ['nox', 'settings', 'commands', 'mcp', 'journal', 'account']) {
    await show(win, v);
    top.push(await js(win, `(() => ({ v: ${JSON.stringify(v)},
      brand: ${vis('.nox-topbar .nox-top-brand')}, settings: ${vis('.nox-topbar [data-nav="settings"]')},
      account: ${vis('.nox-topbar [data-nav="account"]')}, win: document.querySelectorAll('.nox-topbar [data-act]').length,
      otherWin: [...document.querySelectorAll('[data-act="close"]')].filter((b) => !b.closest('.nox-topbar') && b.getBoundingClientRect().width > 0).length,
      current: (document.querySelector('[data-nav][aria-current="page"]') || {}).dataset?.nav || '' }))()`));
  }
  check('Общая шапка на всех разделах, одна кнопка «Закрыть»', top.every((t) => t.brand && t.settings && t.account && t.win === 3 && t.otherWin === 0), top);
  check('Активный раздел отмечен', top.every((t) => t.current === t.v), top.map((t) => `${t.v}:${t.current}`).join(' '));

  // Категория настроек сохраняется после ухода и возврата.
  await show(win, 'settings');
  await js(win, `(() => { document.querySelector('#setNavList button[data-cat="voice"]').click(); return true; })()`);
  await sleep(500);
  await show(win, 'nox');
  await show(win, 'settings');
  const cat = await js(win, `(document.querySelector('#setNavList button[aria-current="true"]') || {}).dataset?.cat || ''`);
  check('Категория настроек сохраняется', cat === 'voice', cat);

  // Сворачивание истории в чате.
  await show(win, 'nox');
  const folded = await js(win, `(async () => {
    const b = document.querySelector('#noxHistToggle');
    if (!b) return { ok: false, why: 'нет #noxHistToggle' };
    b.click(); await new Promise((r) => setTimeout(r, 400));
    const opener = document.querySelector('#noxHistOpen');
    return { ok: true, hidden: !${vis('#noxHistory')}, openerVisible: Boolean(opener && opener.getBoundingClientRect().width) };
  })()`);
  await snap(win, 'nox-1200x720-history-collapsed');
  const toggled = !folded.ok ? folded : await js(win, `(async () => {
    const hidden = ${folded.hidden}, openerVisible = ${folded.openerVisible};
    const opener = document.querySelector('#noxHistOpen');
    if (opener) opener.click(); await new Promise((r) => setTimeout(r, 400));
    return { ok: hidden && openerVisible && ${vis('#noxHistory')}, hidden, openerVisible };
  })()`);
  check('История сворачивается и открывается', toggled.ok, toggled);

  // Малое окно: история прячется, но открывается; главные кнопки доступны.
  await resize(win, 864, 520);
  await show(win, 'nox');
  const small = await js(win, `(async () => {
    const histHidden = !${vis('#noxHistory')};
    const opener = document.querySelector('#noxHistOpen');
    if (opener) opener.click(); await new Promise((r) => setTimeout(r, 400));
    return { histHidden, opened: ${vis('#noxHistory')} };
  })()`);
  await snap(win, 'nox-864x520-history-drawer');
  Object.assign(small, await js(win, `(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return { closedByEsc: !${vis('#noxHistory')}, input: ${vis('#chatInput')}, send: ${vis('#chatSend')} };
  })()`));
  check('864×520: история выезжает и закрывается Esc, ввод виден', small.histHidden && small.opened && small.closedByEsc && small.input, small);
  await resize(win, 1200, 720);

  // Клавиатура: Ctrl+1..5 по-прежнему переключают разделы.
  const keys = await js(win, `(async () => {
    const seen = [];
    for (const k of ['2', '4', '5', '1']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      seen.push(document.body.dataset.view);
    }
    return seen.join(',');
  })()`);
  check('Ctrl+2/4/5/1 переключают разделы', keys === 'commands,mcp,settings,nox', keys);

  const after = await chatState(win);
  check('Беседа и черновик на месте после всех переходов', after.active === base.active && after.messages === base.messages && after.draft === base.draft, after);
  const workingScans = await js(win, `(async () => {
    const list = document.querySelector('#feedList');
    let scans = 0;
    const original = list.querySelectorAll;
    list.querySelectorAll = function (selector) { if (selector === '.turn') scans += 1; return original.call(this, selector); };
    document.querySelector('#headerState').dataset.state = 'thinking';
    await new Promise((r) => setTimeout(r, 650));
    document.querySelector('#headerState').dataset.state = 'idle';
    return scans;
  })()`);
  check('Секундомер не обходит всю ленту', workingScans <= 1, `querySelectorAll(.turn): ${workingScans}`);
  check('Навигация ничего не отправила в ядро', sends === sendsBefore, `chat:send: ${sends - sendsBefore}`);
  check('Нет ошибок консоли', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 600));
  return checks;
}

async function run(win) {
  await waitFor(win, `Boolean(window.JarvisNox && document.querySelector('#chatInput'))`, 'интерфейс', 25000);
  try { win.showInactive(); } catch { win.show(); }
  try { win.setMinimumSize(200, 200); } catch { /* старый Electron */ }
  await sleep(1500);
  await js(win, `(() => { const w = document.getElementById('bannerWrap'); if (w) w.hidden = true; return true; })()`);
  const shots = [];
  const layout = [];
  if (doShots) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [w, h] of sizes) {
      await resize(win, w, h);
      for (const v of views) {
        await show(win, v);
        await js(win, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
        await sleep(300);
        layout.push({ size: `${w}x${h}`, ...(await js(win, LAYOUT_JS)) });
        const file = path.join(outDir, `${v}-${w}x${h}.png`);
        // Кадр иногда приходит со старым размером окна — сверяем и снимаем ещё раз.
        let img = await win.webContents.capturePage();
        for (let i = 0; i < 3 && img.getSize().width !== w; i += 1) { await resize(win, w, h); img = await win.webContents.capturePage(); }
        if (img.getSize().width !== w) throw new Error(`снимок ${v} ${w}x${h} вышел ${img.getSize().width}px`);
        fs.writeFileSync(file, img.toPNG());
        shots.push(file);
      }
    }
  }
  const checks = doQa ? await runQa(win) : [];
  const layoutBad = layout.filter((l) => l.hOverflow || l.blocked.length || l.outside.length);
  clearTimeout(deadline);
  finish({ ok: checks.every((c) => c.ok) && layoutBad.length === 0, shots: shots.length, outDir, checks, layoutBad });
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (...a) => {
    const ev = a[0] && typeof a[0] === 'object' && 'level' in a[0] ? a[0] : null;
    const level = ev ? ev.level : a[1];
    const text = ev ? ev.message : a[2];
    if ((level === 'error' || level === 3) && consoleErrors.length < 20) consoleErrors.push(String(text).slice(0, 300));
  });
  win.webContents.once('did-finish-load', () => {
    if (mainWin || !/renderer[\\/]index\.html/i.test(win.webContents.getURL())) return;
    mainWin = win;
    run(win).catch((err) => finish({ ok: false, error: err && err.message ? err.message : String(err), consoleErrors }));
  });
});

try { require('../main'); } catch (err) { finish({ ok: false, error: `main.js не загрузился: ${err && err.message}` }); }
