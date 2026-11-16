'use strict';

// Живая проверка «Уменьшение движения» (Л5) на настоящем окне: настройка Nox «Анимации» и
// настройка Windows. Из apps/jarvis-desktop (ELECTRON_RUN_AS_NODE снят):
//
//   electron scripts/motion-qa.js --motion on  --system reduce   # Windows просит уменьшить движение
//   electron scripts/motion-qa.js --motion on  --system free     # без ключа: как в этой Windows
//   electron scripts/motion-qa.js --motion off --system free
//   electron scripts/motion-qa.js --motion off --system reduce
//
// --system reduce — окно запускается с ключом Chromium --force-prefers-reduced-motion: это и есть
//   «Windows просит уменьшить». --system free — без ключа, значение берётся у самой Windows.
// Саму Windows скрипт не меняет: её ответ читается через SystemParametersInfo (только чтение).
//
// Что проверяем: какое значение у prefers-reduced-motion, что показывает matchMedia, гаснет ли
// движение у девяти эффектов фона, остаётся ли рисунок, и что переключатель в Настройках меняет
// картинку на месте. Окно 1200×720 и 864×520, временный профиль и данные на D:.
// Печатает строку NOX_MOTION_QA_RESULT <json>; выход 0 — все проверки прошли.

const fs = require('fs');
const path = require('path');

let electron = null;
try { electron = require('electron'); } catch { electron = null; }
if (!electron || typeof electron !== 'object' || !electron.app || typeof electron.app.whenReady !== 'function') {
  console.error('motion-qa: нужен запуск через electron.exe, а не node (снимите ELECTRON_RUN_AS_NODE)');
  process.exit(1);
}
const { app, BrowserWindow, globalShortcut, dialog } = electron;

const TEMP_BASE = 'D:/nox-l5-tmp';
const TIMEOUT_MS = 180000;
const FX_IDS = ['stars', 'waves', 'moon', 'dawn', 'snow', 'rain', 'pattern', 'grid', 'drift'];
// «Сетка» неподвижна по замыслу: движения у неё нет, гасить нечего.
const STATIC_FX = new Set(['grid']);

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
function has(name) { return process.argv.includes(`--${name}`); }

const motionArg = String(arg('motion', 'on')).toLowerCase();
const systemArg = String(arg('system', 'free')).toLowerCase();
const entryArg = String(arg('entry', 'auto')).toLowerCase();
if (motionArg !== 'on' && motionArg !== 'off') {
  console.error(`motion-qa: --motion on|off, получено «${arg('motion')}»`);
  process.exit(2);
}
if (systemArg !== 'free' && systemArg !== 'reduce') {
  console.error(`motion-qa: --system free|reduce, получено «${arg('system')}»`);
  process.exit(2);
}
if (!['auto', 'aether', 'classic'].includes(entryArg)) {
  console.error(`motion-qa: --entry auto|aether|classic, получено «${arg('entry')}»`);
  process.exit(2);
}
const motion = motionArg === 'on';
const forceReduce = systemArg === 'reduce';
const keepTemp = has('keep-temp');

// ── Что говорит сама Windows ────────────────────────────────────────────────────────────────
// Windows из скрипта не меняется: пустое окно на data: без нашей подмены показывает то же
// значение prefers-reduced-motion, что увидит и главное окно.
let osReducePromise = null;
function measureWindowsReduce() {
  if (!osReducePromise) {
    osReducePromise = (async () => {
      const probe = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { sandbox: true } });
      try {
        await probe.loadURL('data:text/html,<html><body>probe</body></html>');
        return await probe.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches", true);
      } catch { return null; } finally { try { probe.destroy(); } catch { /* уже закрыто */ } }
    })();
  }
  return osReducePromise;
}
let osReduce = null;
// Чего ждём от системы в этом прогоне: ключ Chromium сильнее, иначе — ответ Windows.
let systemReduce = forceReduce;

// ── Временная папка на D: ───────────────────────────────────────────────────────────────────
fs.mkdirSync(TEMP_BASE, { recursive: true });
// Прошлые прогоны могли не успеть убрать профиль: Chromium держит файлы до самого выхода.
for (const entry of fs.readdirSync(TEMP_BASE)) {
  if (!/^run-/.test(entry)) continue;
  const full = path.join(TEMP_BASE, entry);
  try {
    if (Date.now() - fs.statSync(full).mtimeMs > 2 * 60 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch { /* занято — уберёт следующий прогон */ }
}
const tempRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'run-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });

app.setPath('userData', profileDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (forceReduce) app.commandLine.appendSwitch('force-prefers-reduced-motion');

const settingsPath = path.join(dataDir, 'settings.json');
const initialSettings = {
  voice: false,
  backgroundModelRuns: false,
  alwaysListen: false,
  dictation: false,
  desktopOverlay: false,
  alwaysOnTop: false,
  motion,
  seededBrief: true,
  modelTier: 'fast',
  thinking: 'low',
};
if (entryArg === 'classic') initialSettings.uiShell = 'legacy';
else if (entryArg === 'aether') initialSettings.uiShell = 'aether';
fs.writeFileSync(settingsPath, JSON.stringify(initialSettings), 'utf8');

for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = dataDir;
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

let finished = false;
let currentStage = 'start';
const consoleErrors = [];
const startedAt = Date.now();

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const payload = {
    ...result,
    motion,
    forceReduce,
    windowsReduceMotion: osReduce,
    elapsedMs: Date.now() - startedAt,
    consoleErrors: consoleErrors.slice(),
  };
  if (keepTemp) payload.tempRoot = tempRoot;
  const code = result && result.ok ? 0 : 1;
  let closed = false;
  const exit = () => { if (closed) return; closed = true; app.exit(code); };
  try { process.stdout.write(`NOX_MOTION_QA_RESULT ${JSON.stringify(payload)}\n`, () => setTimeout(exit, 50)); } catch { exit(); return; }
  setTimeout(exit, 3000).unref();
}

process.on('exit', () => {
  if (keepTemp) { console.error(`NOX_MOTION_QA_TEMP ${tempRoot}`); return; }
  try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { console.error(`NOX_MOTION_QA_TEMP_REMAINS ${tempRoot}`); }
});
process.on('uncaughtException', (err) => finish({ ok: false, error: `uncaught: ${err && err.message ? err.message : err}`, stage: currentStage }));
process.on('unhandledRejection', (err) => finish({ ok: false, error: `unhandledRejection: ${err && err.message ? err.message : err}`, stage: currentStage }));

const deadline = setTimeout(() => finish({ ok: false, error: `timeout ${TIMEOUT_MS} мс`, stage: currentStage }), TIMEOUT_MS);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function js(win, code) { return win.webContents.executeJavaScript(code, true); }
async function waitFor(win, code, { timeout = 25000, interval = 100, label = 'условие' } = {}) {
  const until = Date.now() + timeout;
  let last = '';
  while (Date.now() < until) {
    let value;
    try { value = await js(win, code); } catch (err) { last = err && err.message ? err.message : String(err); value = null; }
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`не дождались ${timeout} мс: ${label}${last ? ` (${last})` : ''}`);
}

// ── Что показывает окно ─────────────────────────────────────────────────────────────────────
// Для classic (renderer/index.html) проверяем 9 эффектов .theme-fx;
// для aether (renderer/aether/index.html) — живые переходы интерфейса и орб/аватар.
const AETHER_SELECTORS = ['.ae-nav-btn', '.ae-rail-button', '.lx-toggle-track'];
const PROBE = `(async () => {
  const root = document.documentElement;
  const isAether = root.hasAttribute('data-aether');
  if (isAether) {
    const selectors = ${JSON.stringify(AETHER_SELECTORS)};
    const transitions = {};
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) return { error: 'нет элемента ' + sel };
      const st = getComputedStyle(el);
      const durs = String(st.transitionDuration || '0s').split(',').map((s) => parseFloat(s) || 0);
      const moving = st.transitionProperty !== 'none' && durs.some((d) => d > 0);
      transitions[sel] = { moving, duration: st.transitionDuration, prop: st.transitionProperty };
    }
    return {
      mode: 'aether',
      reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
      noPreference: matchMedia('(prefers-reduced-motion: no-preference)').matches,
      animations: root.dataset.animations || '',
      transitions,
    };
  }
  const layer = document.querySelector('.theme-fx');
  if (!layer) return { error: 'нет слоя .theme-fx' };
  const ids = ${JSON.stringify(FX_IDS)};
  const saved = root.dataset.fx || '';
  const effects = {};
  for (const id of ids) {
    root.dataset.fx = id;
    const before = getComputedStyle(layer, '::before');
    const after = getComputedStyle(layer, '::after');
    const moving = [before.animationName, after.animationName].filter((n) => n && n !== 'none');
    const paint = [before.backgroundImage, after.backgroundImage, before.maskImage, after.maskImage]
      .filter((v) => v && v !== 'none');
    effects[id] = { moving, painted: paint.length > 0, layerDisplay: getComputedStyle(layer).display };
  }
  if (saved) root.dataset.fx = saved; else root.removeAttribute('data-fx');
  return {
    mode: 'classic',
    reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    noPreference: matchMedia('(prefers-reduced-motion: no-preference)').matches,
    animations: root.dataset.animations || '',
    effects,
  };
})()`;

function readSettingsFile() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return {}; }
}

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail).slice(0, 300) });
}

// Ожидание Nox: «Анимации» выключены — reduce всегда; включены — как в системе.
const expectReduce = (m) => m === false || systemReduce;
// Ожидание с учётом подмены «система разрешает движение» из самого скрипта.
const expectReduceWith = (m, allow) => (m === false ? true : !allow);

function checkEffects(size, state, m, { allow = false } = {}) {
  const reduce = expectReduceWith(m, allow);
  const prefix = size ? `${size}: ` : '';
  check(`${prefix}prefers-reduced-motion ${reduce ? 'reduce' : 'no-preference'}`, state.reduce === reduce,
    JSON.stringify({ reduce: state.reduce, noPreference: state.noPreference, expected: reduce }));
  if (state.mode === 'aether') {
    const shouldMove = !reduce && m;
    for (const sel of AETHER_SELECTORS) {
      check(`${prefix}переход ${sel} — ${shouldMove ? 'движется' : 'стоит'}`,
        state.transitions[sel].moving === shouldMove, JSON.stringify(state.transitions[sel]));
    }
  } else {
    for (const id of FX_IDS) {
      const shouldMove = !reduce && !STATIC_FX.has(id);
      check(`${prefix}эффект ${id} — ${shouldMove ? 'движется' : 'стоит'}`, (state.effects[id].moving.length > 0) === shouldMove,
        JSON.stringify({ moving: state.effects[id].moving }));
      check(`${prefix}эффект ${id} нарисован`, state.effects[id].painted && state.effects[id].layerDisplay !== 'none');
    }
  }
  check(`${prefix}«Анимации» в окне: ${m ? 'включены' : 'выключены'}`, state.animations === (m ? 'on' : 'off'), state.animations);
}

app.on('browser-window-created', (_event, win) => {
  try {
    win.webContents.on('console-message', (_e, level, message) => {
      const noisy = typeof level === 'object' && level ? level : null;
      const severity = noisy ? noisy.level : level;
      const text = noisy ? noisy.message : message;
      if ((severity === 'error' || severity === 3) && consoleErrors.length < 20) consoleErrors.push(String(text || '').slice(0, 300));
    });
  } catch { /* старые версии Electron */ }
});

// Окно с той же сессией отладчика, что у main.js: подменяем prefers-reduced-motion на
// «движение разрешено», как будто Windows не просит уменьшить. Настройки Nox это не меняет.
async function emulateAllow(win) {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await sleep(250);
}

// Настоящий переключатель «Анимации» (в classic или в Aether).
async function flipSetting(win, next) {
  const ok = await js(win, `(() => {
    const inp = document.querySelector('[data-setting="motion"], #lxCtrlAvatarAnim');
    if (!inp) return false;
    inp.checked = ${next};
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error('переключатель анимаций не найден в DOM');
  await waitFor(win, `document.documentElement.dataset.animations === '${next ? 'on' : 'off'}'`, { label: 'переключатель сработал' });
  await sleep(400);
}

async function probeSize(win, w, h) {
  win.setContentSize(w, h);
  await sleep(400);
  const state = await js(win, PROBE);
  if (state.error) throw new Error(state.error);
  return state;
}

async function main(win) {
  currentStage = 'windows';
  osReduce = await measureWindowsReduce();
  systemReduce = forceReduce || osReduce === true;
  check('ответ Windows прочитан', osReduce === true || osReduce === false, JSON.stringify({ windowsReduceMotion: osReduce, forceReduce }));
  currentStage = 'ready';
  // Настройки приходят из ядра: пока html[data-animations] не встал, окно ещё грузится.
  await waitFor(win, 'Boolean(document.documentElement.dataset.animations)', { label: 'настройки загрузились' });

  currentStage = 'boot';
  check('ядро приняло «Анимации» как в настройке', readSettingsFile().motion === motion, JSON.stringify({ motion: readSettingsFile().motion }));
  const boot1200 = await probeSize(win, 1200, 720);
  checkEffects('1200x720', boot1200, motion);
  const boot864 = await probeSize(win, 864, 520);
  checkEffects('864x520', boot864, motion);

  // ── «Windows разрешает движение»: подмена в окне, настройки Nox не трогаем ──────────────
  currentStage = 'allow';
  await probeSize(win, 1200, 720);
  await emulateAllow(win);
  const allow = await js(win, PROBE);
  check('подмена «движение разрешено» подействовала', allow.noPreference === true && allow.reduce === false,
    JSON.stringify({ reduce: allow.reduce, noPreference: allow.noPreference }));
  check('1200x720 (движение разрешено): «Анимации» в окне не изменились', allow.animations === (motion ? 'on' : 'off'), allow.animations);
  if (allow.mode === 'aether') {
    for (const sel of AETHER_SELECTORS) {
      check(`1200x720 (движение разрешено): переход ${sel} — ${motion ? 'движется' : 'стоит'}`,
        allow.transitions[sel].moving === motion, JSON.stringify(allow.transitions[sel]));
    }
  } else {
    for (const id of FX_IDS) {
      // При включённых «Анимациях» окно молчит и движение идёт; при выключенных — держит
      // правило html[data-animations="off"] в themes.css, даже если окно разрешило движение.
      const shouldMove = motion && !STATIC_FX.has(id);
      check(`1200x720 (движение разрешено): эффект ${id} — ${shouldMove ? 'движется' : 'стоит'}`,
        (allow.effects[id].moving.length > 0) === shouldMove, JSON.stringify({ moving: allow.effects[id].moving }));
      check(`1200x720 (движение разрешено): эффект ${id} нарисован`, allow.effects[id].painted);
    }
  }

  // ── Переключатель вживую: в окне сейчас «движение разрешено» ────────────────────────────
  currentStage = 'toggle';
  const next = !motion;
  await flipSetting(win, next);
  await sleep(500);
  const after = await js(win, PROBE);
  check('переключатель поменял значение в ядре', readSettingsFile().motion === next, JSON.stringify({ motion: readSettingsFile().motion }));
  check('переключатель переставил подпись в окне', after.animations === (next ? 'on' : 'off'), after.animations);
  // «Анимации» выключены — окно само просит reduce; включены — снимает подмену вместе с нашей:
  // остаётся ответ системы, а не «движение разрешено».
  const afterReduce = expectReduce(next);
  check(`после переключения prefers-reduced-motion ${afterReduce ? 'reduce' : 'no-preference'}`, after.reduce === afterReduce,
    JSON.stringify({ reduce: after.reduce, noPreference: after.noPreference }));
  if (after.mode === 'aether') {
    const shouldMove = !afterReduce && next;
    for (const sel of AETHER_SELECTORS) {
      check(`после переключения переход ${sel} — ${shouldMove ? 'движется' : 'стоит'}`,
        after.transitions[sel].moving === shouldMove, JSON.stringify(after.transitions[sel]));
    }
  } else {
    for (const id of FX_IDS) {
      const shouldMove = !afterReduce && !STATIC_FX.has(id);
      check(`после переключения эффект ${id} — ${shouldMove ? 'движется' : 'стоит'}`,
        (after.effects[id].moving.length > 0) === shouldMove, JSON.stringify({ moving: after.effects[id].moving }));
    }
    check('после переключения эффекты нарисованы', FX_IDS.every((id) => after.effects[id].painted));
  }

  // ── И обратно: «Анимации» сказали выключить при разрешённом движении ───────────────────
  currentStage = 'toggle-back';
  await flipSetting(win, false);
  await sleep(500);
  const off = await js(win, PROBE);
  check('вернули «Анимации» выключенными', readSettingsFile().motion === false, JSON.stringify({ motion: readSettingsFile().motion }));
  check('при выключенных «Анимациях» окно просит reduce, даже если система разрешила движение', off.reduce === true,
    JSON.stringify({ reduce: off.reduce, noPreference: off.noPreference }));
  if (off.mode === 'aether') {
    for (const sel of AETHER_SELECTORS) {
      check(`с выключенными «Анимациями» переход ${sel} стоит`,
        off.transitions[sel].moving === false, JSON.stringify(off.transitions[sel]));
    }
  } else {
    for (const id of FX_IDS) {
      check(`с выключенными «Анимациями» эффект ${id} стоит`, off.effects[id].moving.length === 0, JSON.stringify({ moving: off.effects[id].moving }));
      check(`с выключенными «Анимациями» эффект ${id} нарисован`, off.effects[id].painted);
    }
  }

  // ── И снова включить: окно снимает подмену, движение возвращается ──────────────────────
  currentStage = 'toggle-on';
  await flipSetting(win, true);
  await sleep(400);
  const on = await js(win, PROBE);
  const restoreReduce = expectReduce(true);
  check(`с включёнными «Анимациями» окно снова как система (${restoreReduce ? 'reduce' : 'no-preference'})`, on.reduce === restoreReduce,
    JSON.stringify({ reduce: on.reduce, noPreference: on.noPreference }));
  if (on.mode === 'aether') {
    const shouldMove = !restoreReduce;
    for (const sel of AETHER_SELECTORS) {
      check(`с включёнными «Анимациями» переход ${sel} — ${shouldMove ? 'движется' : 'стоит'}`,
        on.transitions[sel].moving === shouldMove, JSON.stringify(on.transitions[sel]));
    }
  } else {
    for (const id of FX_IDS) {
      const shouldMove = !restoreReduce && !STATIC_FX.has(id);
      check(`с включёнными «Анимациями» эффект ${id} — ${shouldMove ? 'движется' : 'стоит'}`,
        (on.effects[id].moving.length > 0) === shouldMove, JSON.stringify({ moving: on.effects[id].moving }));
    }
  }

  currentStage = 'final';
  check('окно не упало и ошибок страницы нет', !win.webContents.isCrashed() && consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 5)));

  const passed = checks.filter((c) => c.ok).length;
  return { ok: passed === checks.length, entry: on.mode, passed, failed: checks.length - passed, checks };
}

let mainWin = null;
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => {
    if (mainWin) return;
    if (!/renderer[\\/](?:aether[\\/])?index\.html/i.test(win.webContents.getURL())) return;
    mainWin = win;
    main(win)
      .then((result) => finish({ ...result, profile: tempRoot }))
      .catch((err) => finish({ ok: false, stage: currentStage, error: err && err.message ? err.message : String(err) }));
  });
});

try {
  require('../main');
} catch (err) {
  finish({ ok: false, error: `main.js не загрузился: ${err && err.message ? err.message : err}` });
}
