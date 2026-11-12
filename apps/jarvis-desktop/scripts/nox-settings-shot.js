'use strict';

// Снимок настоящего окна Nox в разделе «Настройки» + QA.
// Модель nox-connections-shot.js: отдельный процесс Electron с временным профилем и временными
// данными; настройки, память, сервисы и рабочая папка владельца не читаются.
//
// Из папки apps/jarvis-desktop (ELECTRON_RUN_AS_NODE должен быть снят):
//   electron scripts/nox-settings-shot.js --out <png> --mode catalog|category:<id>|search|empty-search|sphere|security|voice|look|chat|commands|connections|qa
//     [--query <текст>] [--width 1200] [--height 720] [--wait 2500] [--dump-geometry <json>]
//     [--keep-temp] [--keep-banner] [--keep-focus]
//
// Печатает одну строку NOX_SET_SHOT_RESULT <json> и выходит: 0 — успех, 1 — ошибка.
// По умолчанию файл: docs/reconstruction/phase3/settings/settings-<W>x<H>-<mode>.png

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
  console.error('nox-settings-shot: нужен запуск через electron.exe, а не node: снимите ELECTRON_RUN_AS_NODE');
  process.exit(1);
}
const { app, globalShortcut, dialog } = electron;

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'docs', 'reconstruction', 'phase3', 'settings');
let TIMEOUT_MS = 40000;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}
function bad(message) {
  console.error(`nox-settings-shot: ${message}`);
  process.exit(2);
}

const width = Number.parseInt(arg('width', '1200'), 10) || 1200;
const height = Number.parseInt(arg('height', '720'), 10) || 720;
if (width < 420 || height < 480) bad('окно меньше минимального 420x480');
const MODES = ['catalog', 'category', 'search', 'empty-search', 'sphere', 'security', 'voice', 'look', 'chat', 'commands', 'connections', 'qa'];
const rawMode = String(arg('mode', 'catalog')).toLowerCase();
const mode = rawMode.startsWith('category:') ? 'category' : rawMode;
const categoryId = rawMode.startsWith('category:') ? rawMode.slice('category:'.length) : String(arg('category', '')).trim();
if (!MODES.includes(mode)) bad(`--mode: ${MODES.join('|')}|category:<id>, получено «${arg('mode')}»`);
if (mode === 'qa') TIMEOUT_MS = 150000;
const waitMs = Math.min(20000, Math.max(0, Number.parseInt(arg('wait', '2500'), 10) || 2500));
const queryArg = String(arg('query', '')).trim();
const outArg = arg('out', '');
const outPath = path.resolve(outArg || path.join(SHOTS_DIR, `settings-${width}x${height}-${mode}.png`));
const dumpArg = arg('dump-geometry', '');
const dumpPath = dumpArg ? path.resolve(dumpArg) : '';
const keepTemp = has('keep-temp');
const keepBanner = has('keep-banner');
const keepFocus = has('keep-focus');

// ── Временный профиль и данные ────────────────────────────────────
function sweepOldTemp() {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^nox-settings-shot-/i.test(entry.name)) continue;
    const full = path.join(os.tmpdir(), entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs < 60000) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch { /* занят другим запуском */ }
  }
}
sweepOldTemp();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-settings-shot-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });

// Настройки по умолчанию без голоса, фонового ИИ и оверлеев: первый запуск ничего не спрашивает.
// Специально засеяны значения, которые проверяет QA: громкость/скорость голоса (доли 0..1),
// характер «Дворецкий», terseReplies=false, keepAwake=always, модель/мышление по умолчанию.
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  voice: false,
  backgroundModelRuns: false,
  alwaysListen: false,
  dictation: false,
  desktopOverlay: false,
  alwaysOnTop: false,
  motion: true,
  seededBrief: true,
  voiceVolume: 0.7,
  voiceRate: 1.1,
  voicePersona: 'butler',
  terseReplies: false,
  keepAwake: 'always',
  modelTier: 'fast',
  thinking: 'low',
}), 'utf8');

app.setPath('userData', profileDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}

require('../src/config/paths').projectRoot = () => tempRoot;

// Диалоги Windows в проверке не нужны и не должны перекрывать стол владельца.
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

let finished = false;
let currentStage = 'start';
let mainWin = null;
const consoleErrors = [];
const startedAt = Date.now();

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const payload = { ...result, elapsedMs: Date.now() - startedAt };
  if (keepTemp) payload.tempRoot = tempRoot;
  const line = `NOX_SET_SHOT_RESULT ${JSON.stringify(payload)}\n`;
  const exitCode = result && result.ok ? 0 : 1;
  let closed = false;
  const exit = () => { if (closed) return; closed = true; app.exit(exitCode); };
  try { process.stdout.write(line, () => setTimeout(exit, 30)); } catch { exit(); return; }
  setTimeout(exit, 2000).unref();
}

process.on('exit', () => {
  if (keepTemp) { console.error(`NOX_SET_SHOT_TEMP ${tempRoot}`); return; }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  catch { console.error(`NOX_SET_SHOT_TEMP_REMAINS ${tempRoot}`); }
});
process.on('uncaughtException', (err) => {
  finish({ ok: false, error: `uncaught: ${err && err.message ? err.message : err}` });
});

const deadline = setTimeout(() => {
  finish({ ok: false, error: `timeout: за ${TIMEOUT_MS} мс окно не было снято (окно ${mainWin ? 'найдено' : 'не найдено'})` });
}, TIMEOUT_MS);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function js(win, code) { return win.webContents.executeJavaScript(code, true); }

async function waitFor(win, code, { timeout = 15000, interval = 150, label = 'условие' } = {}) {
  const until = Date.now() + timeout;
  let lastError = '';
  while (Date.now() < until) {
    let value;
    try { value = await js(win, code); } catch (err) { lastError = err && err.message ? err.message : String(err); value = null; }
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`не дождались за ${timeout} мс: ${label}${lastError ? ` (${lastError})` : ''}`);
}

async function settle(win) {
  const page = await js(win, `(async () => {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
    return { innerWidth, innerHeight, dpr: window.devicePixelRatio || 1, title: document.title };
  })()`).catch(() => ({}));
  const cleaned = await js(win, `(() => {
    const out = { banner: false, blurred: false };
    if (!${keepBanner}) {
      const wrap = document.getElementById('bannerWrap');
      if (wrap && !wrap.hidden) { wrap.hidden = true; out.banner = true; }
    }
    if (!${keepFocus} && document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
      out.blurred = true;
    }
    return out;
  })()`).catch(() => ({}));
  if (cleaned && (cleaned.banner || cleaned.blurred)) await sleep(350);
  return { page, cleaned };
}

// ── Раздел «Настройки» ────────────────────────────────────────────
const READY_JS = `(() => {
  const view = document.querySelector('.view-settings');
  if (!view || view.hidden) return false;
  if (document.body.dataset.view !== 'settings') return false;
  const panel = document.querySelector('#setPanel');
  if (!panel) return false;
  const nav = document.querySelectorAll('#setNavList button[data-cat]');
  if (nav.length < 6) return false;
  const cards = document.querySelectorAll('#settingsPage > .set-section');
  if (cards.length < 10) return false;
  return { navItems: nav.length, cards: cards.length, main: Boolean(document.querySelector('#setMain')) };
})()`;

async function openSettings(win) {
  await waitFor(win, `Boolean(window.JarvisNox && typeof window.JarvisNox.show === 'function' && document.querySelector('#setPanel'))`, {
    timeout: 20000, label: 'window.JarvisNox и разметка настроек',
  });
  try { await js(win, `(() => { window.JarvisNox.show('settings'); return document.body.dataset.view; })()`); }
  catch (err) { /* show() может упасть на месте шара — раздел уже показан */ }
  const ready = await waitFor(win, READY_JS, { timeout: 20000, interval: 200, label: 'меню разделов и карточки настроек' });
  // Первое чтение настроек: ждём, пока #setMain перестанет быть data-loading.
  await waitFor(win, `Boolean(document.querySelector('#setMain') && !document.querySelector('#setMain').dataset.loading)`, { timeout: 15000, interval: 200, label: 'загрузка настроек' }).catch(() => null);
  await sleep(400);
  return ready;
}
// Действие режима.
async function applyMode(win) {
  if (mode === 'catalog' || mode === 'qa') return { ok: true };

  // category:<id> — клик по пункту nav.data-cat (general|ai|voice|look|sphere|security).
  if (mode === 'category' || mode === 'sphere' || mode === 'security' || mode === 'voice' || mode === 'look') {
    const cat = mode === 'category' ? (categoryId || 'general') : mode;

    const res = await js(win, `(async () => {
      const cat = ${JSON.stringify(cat)};
      const btn = document.querySelector('#setNavList button[data-cat="' + cat + '"]');
      if (!btn) return { ok: false, error: 'нет пункта nav[data-cat="' + cat + '"]' };
      btn.click();
      await new Promise((r) => setTimeout(r, 700));
      return { ok: true, current: btn.getAttribute('aria-current'), text: (btn.textContent || '').trim() };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!res || !res.ok) return res || { ok: false, error: 'клик по категории не выполнен' };
    if (cat === 'sphere') {
      await js(win, `(() => {
        const main = document.querySelector('#setMain');
        const card = document.querySelector('#settings-sphere');
        if (main && card) main.scrollTop = card.offsetTop - main.offsetTop - 8;
        return true;
      })()`).catch(() => null);
      await sleep(500);
    }
    return { ok: true, name: res.text };
  }

  if (mode === 'search' || mode === 'empty-search') {
    const q = mode === 'empty-search' ? (queryArg || 'фывапролдж') : (queryArg || 'громкость');
    const filled = await js(win, `(() => {
      const input = document.querySelector('#setSearch');
      if (!input) return { ok: false, error: 'нет #setSearch' };
      input.focus();
      input.value = ${JSON.stringify(q)};

      input.dispatchEvent(new Event('input', { bubbles: true }));
      const main = document.querySelector('#setMain');
      if (main) main.scrollTop = 0;
      return { ok: true, id: input.id, query: input.value };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!filled || !filled.ok) return filled || { ok: false, error: 'поиск не заполнен' };
    await sleep(600);
    return { ok: true, name: q };
  }

  if (mode === 'chat' || mode === 'commands' || mode === 'connections') {
    const view = mode === 'chat' ? 'nox' : mode === 'commands' ? 'commands' : 'mcp';
    const selector = mode === 'chat' ? '.nox-grid' : mode === 'commands' ? '#cmdCatalog' : '#mcpList';
    try { await js(win, `(() => { window.JarvisNox.show(${JSON.stringify(view)}); return true; })()`); } catch { /* раздел уже показан */ }
    await waitFor(win, `Boolean(document.body.dataset.view === ${JSON.stringify(view)} && document.querySelector(${JSON.stringify(selector)}))`, { timeout: 15000, label: 'раздел ' + view });
    await sleep(700);
    return { ok: true };
  }

  return { ok: false, error: `неизвестный режим ${rawMode}` };
}
// Геометрия для сравнения «до/после».
async function readGeometry(win, extra) {
  return js(win, `(() => { try {
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), hidden: el.hidden === true, display: cs.display, visibility: cs.visibility, position: cs.position };
    };
    const rectEl = (sel) => rectOf(document.querySelector(sel));
    const scrollOf = (el) => el ? { top: Math.round(el.scrollTop), height: Math.round(el.scrollHeight), client: Math.round(el.clientHeight) } : null;
    const els = {};
    const selectors = [
      '.app', '.rail', '.topbar', '.main', '.views', '.view-settings',
      '#setPanel', '#setHead', '#setStatus', '#setBody', '#setNav', '#setSearch', '#setChips',
      '#setNavList', '#setMain', '#settingsPage', '#setNoMatches', '#setError', '#setErrorText',
      '#setNavList button[data-cat]', '#setNavList button[aria-current="true"]',
      '#settings-ai', '#setModelTier', '#setThinking', '#setModelHint', '#setThinkingHint',
      '#settings-mode', '#modeOptions', '#mailSettings', '#mailStatus', '#mailConnect',
      '#voiceVolume', '#voiceRate', '#voicePersona', '#setKeepAwake', '#setDictation',
      '#memorySettings', '#memoryList', '#memoryEmpty', '#remindersSettings', '#remindersList',
      '#extensionsSettings', '#clipEnabled', '#snipForm', '#dlAnalyze', '#brainRecheck', '#chatClear',
      '#settings-sphere', '#sphereVariant', '#sphereSize', '#sphereGlow', '#spherePreview',
      '#sphereApply', '#sphereReset', '#sphereBadge', '#spherePreviewNote',
      '#settings-model', '#themeSeg', '#orbPick',
      '#toasts',
    ];
    for (const sel of selectors) els[sel] = rectEl(sel);
    const nav = Array.from(document.querySelectorAll('#setNavList > *')).map((el, i) => {
      const b = el.matches && el.matches('button') ? el : el.querySelector('button');
      return {
        i,
        cat: b ? (b.dataset.cat || '') : '',
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        current: b ? (b.getAttribute('aria-current') || '') : '',
        rect: rectOf(el),
      };
    });
    const cards = Array.from(document.querySelectorAll('#settingsPage > .set-section')).map((el, i) => {
      const titleEl = el.querySelector('h2, .set-title');
      return {
        i,
        id: el.id || '',
        cat: el.dataset.cat || 'general',
        title: titleEl ? (titleEl.textContent || '').trim() : '',
        hiddenAttr: el.hidden === true,
        catHidden: el.classList.contains('set-cat-hidden'),
        rect: rectOf(el),
      };
    });
    const chips = Array.from(document.querySelectorAll('#setChips [data-set-chip]')).map((b) => ({
      chip: b.dataset.setChip || '', pressed: b.getAttribute('aria-pressed') || '', text: (b.textContent || '').trim(),
    }));
    const sections = Array.from(document.querySelectorAll('.view-settings .set-section')).map((el, i) => {
      const titleEl = el.querySelector('h2, .set-title');
      return { i, id: el.id || '', title: titleEl ? (titleEl.textContent || '').trim() : '', rect: rectOf(el) };
    });
    return {
      inner: [innerWidth, innerHeight],
      dpr: window.devicePixelRatio || 1,
      view: document.body.dataset.view,
      title: document.title,
      crumb: (document.querySelector('#viewTitle') || {}).textContent || '',
      scroll: { viewSettings: scrollOf(document.querySelector('.view-settings')) },
      elements: els,
      nav,
      cards,
      chips,
      sections,
      mode: ${JSON.stringify(rawMode)},
      extra: ${JSON.stringify(extra || {})},
    };
  } catch (e) { return { __error: String((e && (e.stack || e.message)) || e) }; }
  })()`);
}

function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buf.subarray(0, 8).equals(sig)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

async function capture(win) {
  currentStage = 'capture:start';
  await waitFor(win, 'document.readyState === "complete"', { timeout: 15000, label: 'readyState complete' });
  try { win.showInactive(); } catch { try { win.show(); } catch { /* уже видимо */ } }
  try { win.setMinimumSize(200, 200); } catch { /* старые версии Electron */ }
  win.setContentSize(width, height);
  for (let i = 0; i < 40; i += 1) {
    const [w, h] = win.getContentSize();
    if (w === width && h === height) break;
    await sleep(50);
  }
  const contentSize = win.getContentSize();

  currentStage = 'capture:settle';
  const { page, cleaned } = await settle(win);
  currentStage = 'capture:open-settings';
  const ready = await openSettings(win);

  currentStage = 'capture:apply-mode';
  const action = await applyMode(win);
  if (action && action.ok === false) throw new Error(`режим ${rawMode}: ${action.error || 'не выполнен'}`);

  // Каталог и категории снимаем сверху; тематические режимы оставляют свою прокрутку.
  if (mode === 'catalog' || mode === 'search' || mode === 'empty-search') {
    await js(win, `(() => { const v = document.querySelector('.view-settings'); if (v) v.scrollTop = 0; window.scrollTo(0, 0); return true; })()`).catch(() => null);
  }
  currentStage = 'capture:wait';
  await sleep(waitMs);
  await waitFor(win, `document.querySelectorAll('#toasts .toast').length === 0`, { timeout: 5000, interval: 150, label: 'подсказки ушли' }).catch(() => null);
  if (!keepFocus) {
    await js(win, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`).catch(() => null);
  }
  await sleep(200);
  await settle(win).catch(() => null);

  currentStage = 'capture:geometry';
  const geometry = await readGeometry(win, { mode: rawMode, categoryId, query: queryArg });
  if (geometry && geometry.__error) throw new Error('geometry: ' + geometry.__error);
  const windows = electron.BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible(), bounds: w.getBounds() }));

  currentStage = 'capture:qa';
  if (mode === 'qa') {
    const qa = await runQa(win);
    finish({ ok: qa.failed === 0, mode: 'qa', qa, width, height, contentSize: { width: contentSize[0], height: contentSize[1] }, view: 'settings', page, cleaned, ready, consoleErrors: consoleErrors.slice(), windowsCount: windows.length });
    return;
  }

  const image = await win.webContents.capturePage();
  if (!image || image.isEmpty()) throw new Error('capturePage вернул пустой кадр');
  const size = image.getSize();
  const png = image.toPNG();
  const info = pngInfo(png);
  if (!info) throw new Error('capturePage вернул не PNG');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  if (geometry && dumpPath) {
    fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
    fs.writeFileSync(dumpPath, JSON.stringify(geometry, null, 2), 'utf8');
  }

  finish({
    ok: true,
    out: outPath,
    mode: rawMode,
    categoryId: categoryId || null,
    width,
    height,
    contentSize: { width: contentSize[0], height: contentSize[1] },
    imageWidth: size.width,
    imageHeight: size.height,
    png: info,
    view: geometry ? geometry.view : null,
    title: geometry ? geometry.title : null,
    page,
    cleaned,
    ready,
    geometryPath: dumpPath || null,
    geometry,
    nav: geometry ? geometry.nav : null,
    sections: geometry ? geometry.sections : null,
    rects: {
      '.app': geometry && geometry.elements['.app'] || null,
      '.rail': geometry && geometry.elements['.rail'] || null,
      '.view-settings': geometry && geometry.elements['.view-settings'] || null,
      '#setNav': geometry && geometry.elements['#setNav'] || null,
      '#setNavList': geometry && geometry.elements['#setNavList'] || null,
      '.page.settings': geometry && geometry.elements['.page.settings'] || null,
      '#settingsPage': geometry && geometry.elements['#settingsPage'] || null,
      '#settings-mode': geometry && geometry.elements['#settings-mode'] || null,
    },
    windows,
    consoleErrors,
  });
}

// ── QA: полный сценарий раздела «Настройки» ──────────────────────
async function qaSettingsPhase1Page() {
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, timeout, step) => {
    const end = Date.now() + (timeout || 8000);
    let last = null;
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v; } catch (err) { last = err; }
      await sleep(step || 100);
    }
    throw new Error('не дождались: ' + (last && last.message ? last.message : 'условие'));
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const bridge = (name, ...args) => window.jarvis[name](...args);
  const getSettings = () => bridge('getSettings');
  const getState = () => bridge('getState');
  const main = () => q('#setMain');
  const rectOf = (sel) => { const el = q(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  const cards = () => qa('#settingsPage > .set-section');
  const visibleCards = () => cards().filter((el) => !el.hidden && !el.classList.contains('set-cat-hidden'));
  const navBtn = (cat) => q('#setNavList button[data-cat="' + cat + '"]');
  const setSearch = async (value) => { const i = q('#setSearch'); if (!i) return false; i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300); return true; };
  const clickChip = async (chip) => { const b = q('#setChips [data-set-chip="' + chip + '"]'); if (!b) return false; b.click(); await sleep(350); return true; };

  const checks = [];
  const check = async (name, fn) => {
    try { const r = await fn(); checks.push({ name, ok: Boolean(r && r.ok), detail: (r && r.detail) || '' }); }
    catch (err) { checks.push({ name, ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) }); }
  };

  await check('1. Раскладка 1200: рейка 52, панель ~1122×660 под общей шапкой, шапка 72, nav 252, main ~824, поиск 40, чипы 32, без переполнения, порядок карточек', async () => {
    const innerW = innerWidth;
    const panel = rectOf('#setPanel');
    const head = rectOf('#setHead');
    const nav = rectOf('#setNav');
    const mainR = rectOf('#setMain');
    const search = rectOf('#setSearch');
    const chips = rectOf('#setChips');
    const rail = rectOf('.rail');
    const scrollWidth = document.documentElement.scrollWidth;
    const titles = cards().map((c) => ((c.querySelector('h2, .set-title') || {}).textContent || '').trim());
    const expected = ['Окно и уведомления', 'Рабочая папка', 'Разговор', 'ИИ и провайдеры', 'Модель и связь', 'Ответы', 'Память', 'Напоминания', 'Вид', 'Сфера Nox — предпросмотр', 'Режим доступа', 'Почта Gmail', 'Расширения'];
    const orderOk = titles.length === 13 && titles.join('|') === expected.join('|');
    const winControls = qa('#setHead .nox-win-controls [data-act]').length;
    const ok = Boolean(rail && Math.abs(rail.w - 52) <= 2
      && panel && Math.abs(panel.w - 1122) <= 14 && Math.abs(panel.h - 660) <= 14
      && head && Math.abs(head.h - 72) <= 4
      && nav && Math.abs(nav.w - 252) <= 8
      && mainR && Math.abs(mainR.w - 824) <= 24
      && search && Math.abs(search.h - 40) <= 8
      && chips && Math.abs(chips.h - 32) <= 10
      && scrollWidth <= innerW + 1
      && orderOk && winControls === 0); // кнопки окна — в общей шапке #noxTopbar
    return { ok, detail: 'rail=' + JSON.stringify(rail) + ' panel=' + JSON.stringify(panel) + ' head=' + JSON.stringify(head) + ' nav=' + JSON.stringify(nav) + ' main=' + JSON.stringify(mainR) + ' search=' + JSON.stringify(search) + ' chips=' + JSON.stringify(chips) + ' titles=' + titles.length + ' order=' + orderOk + ' controls=' + winControls + ' scrollWidth=' + scrollWidth };
  });

  await check('3. Категории: 6 пунктов, клик прокручивает и ставит aria-current, ручная прокрутка обновляет подсветку', async () => {
    const cats = ['general', 'ai', 'voice', 'look', 'sphere', 'security'];
    const buttons = qa('#setNavList button[data-cat]');
    const orderOk = buttons.length === 6 && buttons.map((b) => b.dataset.cat).join(',') === cats.join(',');
    const visited = [];
    for (const cat of cats) {
      const b = navBtn(cat);
      if (!b) return { ok: false, detail: 'нет пункта nav ' + cat };
      b.click();
      await sleep(700);
      visited.push({ cat, current: b.getAttribute('aria-current'), top: Math.round(main().scrollTop) });
    }
    const allCurrent = visited.every((v) => v.current === 'true');
    navBtn('general').click();
    await sleep(700);
    const generalTop = Math.round(main().scrollTop);
    const generalCurrent = navBtn('general').getAttribute('aria-current') === 'true';
    // Ручная прокрутка к «Безопасности» должна обновить подсветку.
    const sec = q('#settings-mode');
    const m = main();
    m.scrollTop = sec.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop - 4;
    await sleep(400);
    const manualCurrent = navBtn('security').getAttribute('aria-current') === 'true';
    navBtn('general').click();
    await sleep(500);
    const ok = orderOk && allCurrent && generalTop <= 40 && generalCurrent && manualCurrent;
    return { ok, detail: 'order=' + orderOk + ' current=' + JSON.stringify(visited) + ' общийTop=' + generalTop + ' ручнаяПодсветка=' + manualCurrent };
  });

  await check('4. Поиск: «громкость» сужает, контролы не удаляются, сброс, «фывапролдж» → заглушка, Escape очищает', async () => {
    const total = cards().length;
    const controlsBefore = qa('#setMain select, #setMain input, #setMain button').length;
    await setSearch('громкость');
    const narrowCards = visibleCards().length;
    const controlsAfter = qa('#setMain select, #setMain input, #setMain button').length;
    const narrowed = narrowCards < total;
    const controlsKept = controlsAfter === controlsBefore;
    await setSearch('');
    await sleep(300);
    const restored = visibleCards().length === total;
    await setSearch('фывапролдж');
    const emptyNode = q('#setNoMatches');
    const emptyVisible = Boolean(emptyNode && !emptyNode.classList.contains('is-hidden'));
    const zeroCards = visibleCards().length === 0;
    const input = q('#setSearch');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(350);
    const escaped = input.value === '' && visibleCards().length === total && Boolean(emptyNode && emptyNode.classList.contains('is-hidden'));
    const ok = narrowed && controlsKept && restored && emptyVisible && zeroCards && escaped;
    return { ok, detail: 'всего=' + total + ' после поиска=' + narrowCards + ' контролы ' + controlsBefore + '→' + controlsAfter + ' сброс=' + restored + ' заглушка=' + emptyVisible + ' 0карточек=' + zeroCards + ' Escape=' + escaped };
  });

  await check('5. Чипы: ИИ→ai, Вид→look+sphere, Голос→voice, Все→13; поиск сохраняется при смене чипа', async () => {
    const total = cards().length;
    const catsOf = () => [...new Set(visibleCards().map((c) => c.dataset.cat || 'general'))].sort();
    await clickChip('ai');
    const ai = catsOf();
    const aiPressed = q('#setChips [data-set-chip="ai"]').getAttribute('aria-pressed') === 'true';
    await clickChip('look');
    const look = catsOf();
    await clickChip('voice');
    const voice = catsOf();
    // Поиск не теряется при переключении чипа.
    await setSearch('модель');
    await clickChip('ai');
    const searchKept = q('#setSearch').value === 'модель';
    await setSearch('');
    await clickChip('all');
    const allRestored = visibleCards().length === total;
    const ok = aiPressed && ai.every((c) => c === 'ai') && look.length > 0 && look.every((c) => c === 'look' || c === 'sphere') && voice.length > 0 && voice.every((c) => c === 'voice') && searchKept && allRestored;
    return { ok, detail: 'ai=' + JSON.stringify(ai) + ' look=' + JSON.stringify(look) + ' voice=' + JSON.stringify(voice) + ' поискСохранён=' + searchKept + ' все=' + allRestored };
  });

  await check('6. Модель и мышление: селекты меняют настройки через мост и восстанавливаются', async () => {
    const s0 = await getSettings();
    const origTier = s0 && s0.modelTier === 'smart' ? 'smart' : 'fast';
    const origThink = s0 && ['low', 'medium', 'high'].includes(s0.thinking) ? s0.thinking : 'low';
    const targetTier = origTier === 'smart' ? 'fast' : 'smart';
    const tier = q('#setModelTier');
    tier.value = targetTier;
    tier.dispatchEvent(new Event('change', { bubbles: true }));
    await until(async () => { const s = await getSettings(); return s && s.modelTier === targetTier; }, 8000);
    const targetThink = origThink === 'high' ? 'low' : 'high';
    const thinking = q('#setThinking');
    thinking.value = targetThink;
    thinking.dispatchEvent(new Event('change', { bubbles: true }));
    await until(async () => { const s = await getSettings(); return s && s.thinking === targetThink; }, 8000);
    const hint = ((q('#setModelHint') || {}).textContent || '') + ((q('#setThinkingHint') || {}).textContent || '');
    tier.value = origTier;
    tier.dispatchEvent(new Event('change', { bubbles: true }));
    thinking.value = origThink;
    thinking.dispatchEvent(new Event('change', { bubbles: true }));
    await until(async () => { const s = await getSettings(); return s && s.modelTier === origTier && s.thinking === origThink; }, 8000);
    return { ok: hint.length > 0, detail: 'модель ' + origTier + '→' + targetTier + '→' + origTier + ', мышление ' + origThink + '→' + targetThink + '→' + origThink + '; подсказки=' + hint.length };
  });

  await check('7. Режим доступа: 3 варианта, «Спрашивать» через мост, возврат прежнего', async () => {
    const radios = qa('#modeOptions input[type="radio"]');
    const st = await getState();
    const orig = st && st.mode ? st.mode : 'full';
    const ask = radios.find((r) => r.value === 'ask');
    if (!ask) return { ok: false, detail: 'нет радио «Спрашивать»' };
    ask.click();
    await until(async () => { const x = await getState(); return x && x.mode === 'ask'; }, 8000);
    const back = radios.find((r) => r.value === orig);
    if (back) back.click();
    else await bridge('setMode', orig);
    await until(async () => { const x = await getState(); return x && x.mode === orig; }, 8000);
    return { ok: radios.length === 3, detail: 'вариантов=' + radios.length + ' режим ' + orig + '→ask→' + orig };
  });

  await check('8. Голос: seeded 0.7/1.1 и характер «Дворецкий», изменение громкости сохраняется', async () => {
    const vol = q('#voiceVolume');
    const rate = q('#voiceRate');
    const persona = q('#voicePersona');
    const s0 = await getSettings();
    const personaText = persona && persona.selectedOptions && persona.selectedOptions[0] ? persona.selectedOptions[0].textContent.trim() : '';
    // «Дворецкий» задаёт свой темп/громкость и перекрывает сохранённые доли — так устроен personas.js.
    // Поэтому сохранение 0.7/1.1 проверяем, временно переключив характер на «Как есть», затем вернём «Дворецкого».
    let personaNeutral = false;
    if (persona) {
      persona.value = 'neutral';
      persona.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(700);
      personaNeutral = persona.value === 'neutral';
      // Перечитываем карточку голоса: app.js обновляет ползунки при входе в раздел, не по смене характера.
      window.JarvisNox.show('settings');
      await sleep(900);
    }
    let volShown = null;
    let rateShown = null;
    try {
      await until(() => { const v = q('#voiceVolume'); const r = q('#voiceRate'); return Boolean(v && Number(v.value) === Math.round(Number(s0.voiceVolume || 0.7) * 100) && Math.abs(Number(r && r.value) - Number(s0.voiceRate || 1.1)) < 0.01); }, 8000);
      volShown = Number(q('#voiceVolume').value);
      rateShown = Number(q('#voiceRate').value);
    } catch (err) {
      volShown = vol ? Number(vol.value) : null;
      rateShown = rate ? Number(rate.value) : null;
    }
    let save55 = false;
    let restore70 = false;
    try {
      const v = q('#voiceVolume');
      v.value = '55';
      v.dispatchEvent(new Event('input', { bubbles: true }));
      v.dispatchEvent(new Event('change', { bubbles: true }));
      await until(async () => { const s = await getSettings(); return s && Math.abs(Number(s.voiceVolume) - 0.55) < 0.011; }, 8000);
      save55 = true;
    } catch (err) { save55 = false; }
    try {
      const v = q('#voiceVolume');
      v.value = '70';
      v.dispatchEvent(new Event('input', { bubbles: true }));
      v.dispatchEvent(new Event('change', { bubbles: true }));
      await until(async () => { const s = await getSettings(); return s && Math.abs(Number(s.voiceVolume) - 0.7) < 0.011; }, 8000);
      restore70 = true;
    } catch (err) { restore70 = false; }
    let personaRestored = false;
    if (persona) {
      persona.value = 'butler';
      persona.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(700);
      personaRestored = persona.value === 'butler';
    }
    const volOk = volShown === 70;
    const rateOk = rateShown !== null && Math.abs(rateShown - 1.1) < 0.001;
    const ok = Boolean(vol && rate && volOk && rateOk && personaText === 'Дворецкий' && personaNeutral && save55 && restore70 && personaRestored);
    return { ok, detail: 'характер="' + personaText + '"; при «Как есть» слайдеры показали ' + volShown + '/' + rateShown + '; 55→0.55=' + save55 + '; 70→0.7=' + restore70 + '; характер вернули=' + personaRestored + ' (persona перекрывает доли — это честное поведение)' };
  });
  await check('9. terseReplies: seeded false, переключатель включает и выключает настройку', async () => {
    const cb = q('[data-setting="terseReplies"]');
    if (!cb) return { ok: false, detail: 'нет переключателя terseReplies' };
    const seededOff = cb.checked === false;
    cb.click();
    await until(async () => { const s = await getSettings(); return s && s.terseReplies === true; }, 8000);
    cb.click();
    await until(async () => { const s = await getSettings(); return s && s.terseReplies === false; }, 8000);
    return { ok: seededOff, detail: 'был выключен=' + seededOff + ', включили и выключили через мост' };
  });

  await check('10. keepAwake: seeded always, смена на while-working сохраняется и возвращается', async () => {
    const sel = q('#setKeepAwake');
    if (!sel) return { ok: false, detail: 'нет #setKeepAwake' };
    const seeded = sel.value === 'always';
    sel.value = 'while-working';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await until(async () => { const s = await getSettings(); return s && s.keepAwake === 'while-working'; }, 8000);
    sel.value = 'always';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await until(async () => { const s = await getSettings(); return s && s.keepAwake === 'always'; }, 8000);
    return { ok: seeded, detail: 'seeded always=' + seeded + ', смена и возврат сохранены' };
  });

  await check('11. Внешний вид: 23 темы меняют вычисленные цвета и шрифты во всех панелях, акцент и HEX работают', async () => {
    const themeBtns = qa('#themeSeg [data-theme-opt]');
    // «Как в системе» — не палитра, а выбор одной из двух; в подсчёт разных видов не входит.
    const paletteBtns = themeBtns.filter((b) => b.dataset.themeOpt !== 'system');
    const T = window.JarvisTheme;
    const curTheme = document.documentElement.dataset.theme || '';
    const probe = (decl) => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:-10000px;top:0;' + decl;
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = { bg: cs.backgroundColor, color: cs.color, font: cs.fontFamily };
      el.remove();
      return out;
    };
    const bgToken = (name) => probe(`background-color:var(--${name})`).bg;
    const colorToken = (name) => probe(`color:var(--${name})`).color;
    const fontToken = (name) => probe(`font-family:var(--${name})`).font;
    const style = (sel, prop) => { const el = q(sel); return el ? getComputedStyle(el).getPropertyValue(prop).trim() : ''; };
    const signatures = new Set();
    const mismatches = [];
    const samples = [];
    for (const btn of paletteBtns) {
      const id = btn.dataset.themeOpt;
      btn.click();
      await sleep(110);
      const bg = bgToken('bg');
      const text = colorToken('text');
      const accent = colorToken('accent');
      const surface = bgToken('surface');
      const noxBg = bgToken('nox-bg');
      const noxSurface = bgToken('nox-surface-2');
      const noxText = colorToken('nox-text-1');
      const noxAccent = colorToken('nox-accent');
      const fonts = fontToken('font');
      const heads = fontToken('font-head');
      signatures.add([bg, surface, text, accent, fonts, heads].join('#'));
      if (document.documentElement.dataset.theme !== id) mismatches.push(id + ':root');
      if (noxBg !== bg || noxSurface !== surface || noxText !== text || noxAccent !== accent) mismatches.push(id + ':nox');
      // Панель, подпись и поле раздела обязаны реально получить цвета темы.
      const railBg = style('.rail', 'background-color');
      const nameColor = style('.set-name', 'color');
      const mainColor = style('#setMain', 'color');
      if (railBg !== surface) mismatches.push(id + ':rail=' + railBg + '≠' + surface);
      if (nameColor !== text) mismatches.push(id + ':text=' + nameColor + '≠' + text);
      if (mainColor !== text) mismatches.push(id + ':main=' + mainColor);
      const option = q('#setModelTier option');
      if (option && getComputedStyle(option).backgroundColor === 'rgba(0, 0, 0, 0)') mismatches.push(id + ':option');
      if (samples.length < 3) samples.push({ id, bg, text, accent, fonts, heads });
    }
    const back = themeBtns.find((b) => b.dataset.themeOpt === curTheme);
    if (back) { back.click(); await sleep(300); }
    const origAccent = T ? T.getAccent() : '';
    const swatches = qa('.accent-swatches .accent-opt');
    let accentChanged = false;
    const otherSwatch = swatches.find((b) => b.dataset.accentOpt !== origAccent);
    if (T && otherSwatch) {
      otherSwatch.click();
      await sleep(350);
      accentChanged = T.getAccent() !== origAccent;
      T.setAccent(origAccent);
      await sleep(250);
    }
    const hex = q('.accent-hex');
    let hexApplied = false;
    let hexInvalid = false;
    if (T && hex) {
      hex.value = '#3A7BD5';
      hex.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(350);
      hexApplied = T.getAccent() === '#3A7BD5' || String(T.getAccent()).toUpperCase() === '#3A7BD5';
      hex.value = 'мусор';
      hex.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      hexInvalid = hex.getAttribute('aria-invalid') === 'true';
      T.setAccent(origAccent);
      await sleep(200);
    }
    // Строка прозрачности: ползунок и значение в одной строке, текст не сжат в столбик.
    const transparencyRow = qa('.look-row').find((el) => (el.textContent || '').includes('Прозрачность окна'));
    let lookRow = null;
    let lookMetrics = null;
    if (transparencyRow) {
      const rowR = transparencyRow.getBoundingClientRect();
      const textEl = transparencyRow.querySelector('.set-text');
      const textR = textEl.getBoundingClientRect();
      const control = transparencyRow.querySelector('.look-alpha');
      const controlR = control ? control.getBoundingClientRect() : null;
      const slider = control && control.querySelector('input[type="range"]');
      const output = control && control.querySelector('output');
      const before = slider ? slider.value : '';
      if (slider) {
        slider.value = '35';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(80);
      }
      const outputOk = Boolean(output && /^35\s*%$/.test((output.textContent || '').trim()));
      if (slider) {
        slider.value = before;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const insideRow = Boolean(controlR && controlR.left >= rowR.left - 1 && controlR.right <= rowR.right + 1 && controlR.bottom <= rowR.bottom + 1);
      const separate = Boolean(controlR && controlR.left >= textR.right - 1);
      lookMetrics = { row: Math.round(rowR.width), text: Math.round(textR.width) + 'x' + Math.round(textR.height), control: controlR ? Math.round(controlR.width) + 'x' + Math.round(controlR.height) : 'нет', separate, insideRow, outputOk };
      lookRow = Boolean(controlR && textR.width >= 170 && textR.height <= 64 && separate && insideRow && outputOk);
    }
    const text = (q('#settingsPage') || {}).textContent || '';
    const rows = ['Шрифт интерфейса', 'Шрифт заголовков', 'Шрифт ответов', 'Размер текста', 'Прозрачность окна', 'Радиус окна', 'Сбросить к теме'].every((s) => text.includes(s));
    const ok = themeBtns.length === 23 && paletteBtns.length === 22 && signatures.size === 22 && mismatches.length === 0 && swatches.length > 0 && accentChanged && hexApplied && hexInvalid && rows && lookRow;
    return { ok, detail: 'кнопокТем=' + themeBtns.length + ' палитр=' + paletteBtns.length + ' разныхВид=' + signatures.size + ' расхождений=' + (mismatches.slice(0, 5).join('; ') || 'нет') + ' кружков=' + swatches.length + ' акцент=' + accentChanged + ' hex=' + hexApplied + ' hexНевалидный=' + hexInvalid + ' строкиВида=' + rows + ' строкаПрозрачности=' + lookRow + ' мерки=' + JSON.stringify(lookMetrics) + ' образцы=' + JSON.stringify(samples) };
  });

  await check('12. Сфера: вариант Wire/Nox реальный, ползунки preview-only, превью и сброс, живая сфера не меняется', async () => {
    const N = window.NoxScreen;
    if (!N || typeof N.getVariant !== 'function') return { ok: false, detail: 'нет window.NoxScreen.getVariant' };
    const initial = N.getVariant();
    const other = initial === 'wire' ? 'nox' : 'wire';
    const btn = q('#sphereVariant [data-sphere-variant="' + other + '"]');
    if (!btn) return { ok: false, detail: 'нет кнопки варианта ' + other };
    btn.click();
    await sleep(700);
    const after = N.getVariant();
    let stored = null;
    try { stored = localStorage.getItem('noxOrb'); } catch { stored = null; }
    const checked = btn.getAttribute('aria-checked') === 'true';
    const canvas = q('#spherePreview');
    const canvasOk = Boolean(canvas && canvas.width > 0 && canvas.height > 0);
    const sliders = [q('#sphereSize'), q('#sphereGlow')].filter(Boolean);
    const previewOnly = sliders.length === 2 && sliders.every((s) => s.getAttribute('data-preview-only') === 'true') && Boolean(q('#spherePreviewNote') && q('#spherePreviewNote').getAttribute('data-preview-only') === 'true');
    const apply = q('#sphereApply');
    const applyDisabled = Boolean(apply && apply.disabled && apply.title);
    const size = q('#sphereSize');
    size.value = '110';
    size.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(350);
    const sizeLabel = String((q('#sphereSizeValue') || {}).textContent || '').trim();
    let previewSaved = null;
    try { previewSaved = JSON.parse(localStorage.getItem('jarvis.spherePreview') || '{}'); } catch { previewSaved = null; }
    const sizeOk = sizeLabel.includes('110') && Boolean(previewSaved && Number(previewSaved.size) === 110);
    const reset = q('#sphereReset');
    if (reset) reset.click();
    await sleep(300);
    const resetOk = String((q('#sphereSize') || {}).value) === '100' && String((q('#sphereGlow') || {}).value) === '100';
    const restore = q('#sphereVariant [data-sphere-variant="' + initial + '"]');
    if (restore) restore.click();
    await sleep(500);
    const restored = N.getVariant() === initial;
    const ok = after === other && stored === other && checked && canvasOk && previewOnly && applyDisabled && sizeOk && resetOk && restored;
    return { ok, detail: 'вариант ' + initial + '→' + after + '→' + initial + ' localStorage=' + stored + ' отмечено=' + checked + ' canvas=' + canvasOk + ' previewOnly=' + previewOnly + ' Apply.disabled=' + applyDisabled + ' size=' + sizeLabel + ' reset=' + resetOk + ' вернули=' + restored };
  });

  await check('13. Память/напоминания/расширения: карточки, пустая память, три подкарточки расширений', async () => {
    const mem = q('#memorySettings');
    const memEmpty = q('#memoryEmpty');
    const memList = q('#memoryList');
    const memText = String((memEmpty || {}).textContent || '');
    const memOk = Boolean(mem && memText.includes('Записей пока нет') && (memList ? memList.children.length === 0 : false));
    const rem = q('#remindersSettings');
    const ext = q('#extensionsSettings');
    const extCards = qa('#extensionsSettings .ext-card');
    const extTitles = extCards.map((c) => ((c.querySelector('h3, .ext-title, .set-name') || {}).textContent || '').trim());
    const extText = String((ext || {}).textContent || '');
    const extOk = extCards.length >= 3 && ['История буфера', 'Быстрые вставки', 'Уборка загрузок'].every((s) => extText.includes(s));
    const controlsOk = Boolean(q('#clipEnabled') && q('#snipForm') && q('#dlAnalyze') && !q('#dlAnalyze').disabled);
    const ok = Boolean(memOk && rem && extOk && controlsOk);
    return { ok, detail: 'память=' + memOk + ' напоминания=' + Boolean(rem) + ' подкарточек=' + extCards.length + ' [' + extTitles.join(', ') + '] контролы=' + controlsOk };
  });
  await check('14. Безопасность: режим доступа, почта честно недоступна в этой сборке, расширения здесь же', async () => {
    const radios = qa('#modeOptions input[type="radio"]');
    const mail = q('#mailSettings');
    const mailStatus = String((q('#mailStatus') || {}).textContent || '');
    const mailVisible = visible(mail);
    const mailHonest = !mailVisible ? true : (/недоступн|нет доступа|не настроен/i.test(mailStatus) || Boolean(q('#mailConnect') && q('#mailConnect').disabled));
    const extInSecurity = Boolean(q('#extensionsSettings') && q('#extensionsSettings').dataset.cat === 'security');
    const ok = radios.length === 3 && mailHonest && extInSecurity;
    return { ok, detail: 'радио=' + radios.length + ' почта видна=' + mailVisible + ' статус="' + mailStatus.slice(0, 80) + '" расширенияВБезопасности=' + extInSecurity };
  });

  await check('15. Состояния: нет data-loading, #setStatus/#setError на месте, почта disabled', async () => {
    const mainEl = main();
    const loading = Boolean(mainEl && mainEl.dataset.loading);
    const status = q('#setStatus');
    const error = q('#setError');
    const mailBtn = q('#mailConnect');
    const mailDisabled = Boolean(mailBtn && mailBtn.disabled);
    const ok = !loading && Boolean(status) && Boolean(error) && error.hidden === true && mailDisabled;
    return { ok, detail: 'data-loading=' + loading + ' status=' + Boolean(status) + ' errorHidden=' + (error ? error.hidden : 'нет') + ' mailDisabled=' + mailDisabled };
  });

  await check('16. Кириллица: точные подписи «Настройки», «ИИ и провайдеры», «Сфера Nox», «Безопасность»', async () => {
    const text = document.body.textContent || '';
    const needles = ['Настройки', 'ИИ и провайдеры', 'Сфера Nox', 'Безопасность'];
    const missing = needles.filter((s) => !text.includes(s));
    return { ok: missing.length === 0, detail: missing.length ? 'нет: ' + missing.join(', ') : 'все подписи на месте' };
  });

  await check('17. Регрессии: чат, «Команды», «Подключения» открываются, возврат в настройки', async () => {
    const seq = [];
    window.JarvisNox.show('nox');
    await until(() => document.body.dataset.view === 'nox' && visible(q('.nox-grid')), 10000);
    seq.push('nox:' + visible(q('.nox-grid')));
    window.JarvisNox.show('commands');
    await until(() => document.body.dataset.view === 'commands' && visible(q('#cmdCatalog')), 10000);
    seq.push('commands:' + visible(q('#cmdCatalog')));
    window.JarvisNox.show('mcp');
    await until(() => document.body.dataset.view === 'mcp' && visible(q('#mcpPage')), 10000);
    seq.push('mcp:' + visible(q('#mcpPage')));
    window.JarvisNox.show('settings');
    await until(() => document.body.dataset.view === 'settings' && visible(q('#setPanel')), 10000);
    seq.push('settings:' + visible(q('#setPanel')));
    const ok = seq.every((s) => s.endsWith('true'));
    return { ok, detail: seq.join(', ') };
  });

  await check('19. Все разделы следуют теме: фон, панели, текст и шрифт меняются вместе с тёмной и светлой темой', async () => {
    const T = window.JarvisTheme;
    if (!T || typeof T.apply !== 'function') return { ok: false, detail: 'нет JarvisTheme.apply' };
    const original = document.documentElement.dataset.theme || 'dark';
    const views = ['settings', 'nox', 'commands', 'mcp'];
    const read = () => {
      const probe = (decl) => {
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;left:-10000px;top:0;' + decl;
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        const out = { bg: cs.backgroundColor, color: cs.color, font: cs.fontFamily };
        el.remove();
        return out;
      };
      const rail = q('.rail');
      const app = q('.app');
      return {
        bg: probe('background-color:var(--bg)').bg,
        text: probe('color:var(--text)').color,
        surface: probe('background-color:var(--surface)').bg,
        noxBg: probe('background-color:var(--nox-bg)').bg,
        noxText: probe('color:var(--nox-text-1)').color,
        railBg: rail ? getComputedStyle(rail).backgroundColor : '',
        railText: rail ? getComputedStyle(rail).color : '',
        railFont: rail ? getComputedStyle(rail).fontFamily : '',
        appBg: app ? getComputedStyle(app).backgroundColor : '',
        appImage: app ? getComputedStyle(app).backgroundImage : '',
      };
    };
    const seen = {};
    const mismatches = [];
    for (const theme of ['dark', 'light']) {
      T.apply(theme);
      await sleep(250);
      for (const view of views) {
        window.JarvisNox.show(view);
        await until(() => document.body.dataset.view === view && visible(q('.app')) && visible(q('.rail')), 10000);
        await sleep(250);
        const r = read();
        seen[theme + ':' + view] = r;
        if (r.noxBg !== r.bg || r.noxText !== r.text) mismatches.push(theme + ':' + view + ':nox');
        if (r.railBg !== r.surface) mismatches.push(theme + ':' + view + ':rail=' + r.railBg + '≠' + r.surface);
        if (r.railText !== r.text) mismatches.push(theme + ':' + view + ':text=' + r.railText + '≠' + r.text);
        if (!r.railFont || !r.railFont.toLowerCase().includes('aptos')) mismatches.push(theme + ':' + view + ':font=' + r.railFont);
      }
    }
    for (const view of views) {
      const dark = seen['dark:' + view];
      const light = seen['light:' + view];
      if (!dark || !light || dark.bg === light.bg || dark.railBg === light.railBg || dark.appBg === light.appBg) mismatches.push(view + ':темы не различаются');
    }
    T.apply(original);
    window.JarvisNox.show('settings');
    await until(() => document.body.dataset.view === 'settings' && visible(q('#setPanel')), 10000);
    await sleep(300);
    const ok = Object.keys(seen).length === 8 && mismatches.length === 0;
    return { ok, detail: 'разделов=' + Object.keys(seen).length + ' расхождений=' + (mismatches.slice(0, 6).join('; ') || 'нет') + ' шрифт=' + (seen['dark:settings'] || {}).railFont };
  });

  // Уборка состояния: поиск/чип/акцент/модель уже восстановлены внутри проверок.
  try { await setSearch(''); await clickChip('all'); } catch (err) { /* пусто */ }

  return { checks };
}

async function qaSettingsPhase864Page() {
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rectOf = (sel) => { const el = q(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const checks = [];
  const check = async (name, fn) => {
    try { const r = await fn(); checks.push({ name, ok: Boolean(r && r.ok), detail: (r && r.detail) || '' }); }
    catch (err) { checks.push({ name, ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) }); }
  };

  await check('2. 864×520: scrollWidth=864, nav полосой над main, main прокручивается, превью сферы в окне, без переполнения', async () => {
    const innerW = innerWidth;
    const innerH = innerHeight;
    const scrollWidth = document.documentElement.scrollWidth;
    const nav = rectOf('#setNav');
    const mainR = rectOf('#setMain');
    const search = rectOf('#setSearch');
    const chips = rectOf('#setChips');
    const samples = ['#setPanel', '#setHead', '#setBody', '#setNav', '#setMain'].map((sel) => ({ sel, rect: rectOf(sel) }));
    const noOverflow = samples.every((s) => !s.rect || s.rect.right <= innerW + 1);
    const navAboveMain = Boolean(nav && mainR && nav.y + nav.h <= mainR.y + 2);
    const navStrip = Boolean(nav && nav.w >= innerW - 120);
    const mainEl = q('#setMain');
    const scrollable = Boolean(mainEl && mainEl.scrollHeight > mainEl.clientHeight + 20);
    // Превью сферы: перейти к «Сфере Nox» и проверить, что превью целиком в окне.
    const sphereBtn = q('#setNavList button[data-cat="sphere"]');
    if (sphereBtn) { sphereBtn.click(); await sleep(900); }
    const canvas = rectOf('#spherePreview');
    const previewInside = Boolean(canvas && canvas.x >= -1 && canvas.y >= -1 && canvas.right <= innerW + 1 && canvas.bottom <= innerH + 1);
    const scrollWidth2 = document.documentElement.scrollWidth;
    const ok = innerW === 864 && innerH === 520 && scrollWidth <= innerW + 1 && scrollWidth2 <= innerW + 1 && noOverflow && navAboveMain && navStrip && scrollable && previewInside;
    return { ok, detail: 'inner=' + innerW + 'x' + innerH + ' scrollWidth=' + scrollWidth + '/' + scrollWidth2 + ' nav=' + JSON.stringify(nav) + ' main=' + JSON.stringify(mainR) + ' search=' + JSON.stringify(search) + ' chips=' + JSON.stringify(chips) + ' navНадMain=' + navAboveMain + ' полоса=' + navStrip + ' mainПрокручивается=' + scrollable + ' превью=' + JSON.stringify(canvas) + ' вОкне=' + previewInside };
  });

  await check('2b. 864×520: «Прозрачность окна» — текст и ползунок в одной строке, без вертикального разрыва', async () => {
    const lookBtn = q('#setNavList button[data-cat="look"]');
    if (lookBtn) { lookBtn.click(); await sleep(700); }
    const row = qa('.look-row').find((el) => (el.textContent || '').includes('Прозрачность окна'));
    if (!row) return { ok: false, detail: 'нет строки «Прозрачность окна»' };
    const rowR = row.getBoundingClientRect();
    const textEl = row.querySelector('.set-text');
    const textR = textEl.getBoundingClientRect();
    const control = row.querySelector('.look-alpha');
    const controlR = control.getBoundingClientRect();
    const slider = control.querySelector('input[type="range"]');
    const output = control.querySelector('output');
    const before = slider.value;
    slider.value = '35';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    const outputOk = /^35\s*%$/.test((output.textContent || '').trim());
    slider.value = before;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    const scrollWidth = document.documentElement.scrollWidth;
    const ok = textR.width >= 170 && textR.height <= 64
      && controlR.left >= rowR.left - 1 && controlR.right <= rowR.right + 1
      && controlR.bottom <= rowR.bottom + 1 && outputOk && scrollWidth <= innerWidth + 1;
    return { ok, detail: 'row=' + Math.round(rowR.width) + ' text=' + Math.round(textR.width) + 'x' + Math.round(textR.height) + ' control=' + Math.round(controlR.width) + 'x' + Math.round(controlR.height) + ' output=' + outputOk + ' scrollWidth=' + scrollWidth };
  });

  return { checks };
}

async function setContentSize(win, w, h) {
  try { win.setMinimumSize(200, 200); } catch { /* старые версии Electron */ }
  win.setContentSize(w, h);
  for (let i = 0; i < 40; i += 1) {
    const [cw, ch] = win.getContentSize();
    if (cw === w && ch === h) break;
    await sleep(50);
  }
  await sleep(250);
  await js(win, `(async () => {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
    return true;
  })()`).catch(() => null);
  await sleep(150);
}

async function runQa(win) {
  const checks = [];
  try {
    const phase1 = await js(win, `(async () => { try { return await (${qaSettingsPhase1Page.toString()})(); } catch (e) { return { __error: String((e && (e.stack || e.message)) || e) }; } })()`);
    if (phase1 && phase1.__error) checks.push({ name: 'qa: ошибка сценария', ok: false, detail: phase1.__error.slice(0, 900) });
    checks.push(...((phase1 && phase1.checks) || []));
  } catch (err) {
    checks.push({ name: 'qa: сценарий 1, 3–17', ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
  }

  try {
    await setContentSize(win, 864, 520);
    const phase2 = await js(win, `(async () => { try { return await (${qaSettingsPhase864Page.toString()})(); } catch (e) { return { __error: String((e && (e.stack || e.message)) || e) }; } })()`);
    if (phase2 && phase2.__error) checks.push({ name: 'qa: ошибка сценария 864', ok: false, detail: phase2.__error.slice(0, 900) });
    checks.push(...((phase2 && phase2.checks) || []));
  } catch (err) {
    checks.push({ name: 'qa: сценарий 2 (864x520)', ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
  }
  try { await setContentSize(win, width, height); } catch { /* окно могли закрыть */ }
  // Возвращаемся в настройки и снимаем верх.
  try {
    await js(win, `(() => { window.JarvisNox.show('settings'); const m = document.querySelector('#setMain'); if (m) m.scrollTop = 0; return true; })()`).catch(() => null);
  } catch { /* пусто */ }

  await sleep(400);
  const errors = consoleErrors.slice();
  checks.push({ name: '18. Ошибки консоли', ok: errors.length === 0, detail: errors.length ? errors.join(' | ').slice(0, 900) : 'нет' });

  const passed = checks.filter((c) => c.ok).length;
  return { passed, failed: checks.length - passed, checks };
}
let lastView = '';
app.on('browser-window-created', (_event, win) => {
  try {
    win.webContents.on('console-message', (_e, level, message) => {
      const noisy = typeof level === 'object' && level ? level : null;
      const severity = noisy ? noisy.level : level;
      const text = noisy ? noisy.message : message;
      if ((severity === 'error' || severity === 3) && consoleErrors.length < 20) consoleErrors.push(String(text || '').slice(0, 300));
    });
  } catch { /* старые версии Electron */ }

  win.webContents.once('did-finish-load', () => {
    if (mainWin) return;
    const url = win.webContents.getURL();
    if (!/renderer[\\/]index\.html/i.test(url)) return;
    mainWin = win;
    capture(win).catch((err) => finish({ ok: false, stage: currentStage, error: err && err.message ? err.message : String(err), consoleErrors: consoleErrors.slice() }));
  });
});

setInterval(() => {
  if (!mainWin || finished) return;
  mainWin.webContents.executeJavaScript('document.body.dataset.view || ""', true)
    .then((v) => { if (v) lastView = v; })
    .catch(() => {});
}, 500).unref();

try {
  require('../main');
} catch (err) {
  finish({ ok: false, error: `main.js не загрузился: ${err && err.message ? err.message : err}` });
}