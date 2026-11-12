'use strict';

// Живая проверка «Своя картинка» (Л3) на настоящем окне: большой файл у лимита 25 МБ и выше,
// не картинка, отмена выбора, повтор после ошибки, сохранение прежнего фона, отсутствие
// зависаний, потерь настроек и ошибок консоли.
//
// Из папки apps/jarvis-desktop (ELECTRON_RUN_AS_NODE снят):
//   electron scripts/backdrop-qa.js [--out <dir>] [--keep-temp]
//
// Печатает строку NOX_BACKDROP_QA_RESULT <json>, выходит 0, если все проверки прошли.
// Временный профиль, данные и картинки лежат на D: (D:/nox-l3-tmp), личные файлы не читаются.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let electron = null;
try { electron = require('electron'); } catch { electron = null; }
if (!electron || typeof electron !== 'object' || !electron.app || typeof electron.app.whenReady !== 'function') {
  console.error('backdrop-qa: нужен запуск через electron.exe, а не node');
  process.exit(1);
}
const { app, globalShortcut, dialog } = electron;

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_OUT = path.join(REPO_ROOT, 'docs', 'reconstruction', 'qa-l3-backdrop');
const TEMP_BASE = 'D:/nox-l3-tmp';
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 300000;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
function has(name) { return process.argv.includes(`--${name}`); }

const outDir = path.resolve(arg('out', DEFAULT_OUT));
const keepTemp = has('keep-temp');

// ── PNG своими руками: валидный файл ровно нужного размера ─────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([body, data])), 0);
  return Buffer.concat([len, body, data, crc]);
}
function makePng(width, height, pixel) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  const seed = 0x1234567;
  let state = seed;
  const rnd = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) & 0xff;
  };
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * 4;
      const rgba = pixel(x, y, rnd);
      raw[p] = rgba[0]; raw[p + 1] = rgba[1]; raw[p + 2] = rgba[2]; raw[p + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Дополнительный tEXt-чанк перед IEND доводит валидный PNG до точного размера.
function padPng(png, targetBytes) {
  const need = targetBytes - png.length - 12;
  if (need < 16) return png;
  const data = Buffer.alloc(need, 0x78);
  data.write('Comment\u0000', 0, 'ascii');
  return Buffer.concat([
    png.subarray(0, png.length - 12),
    chunk('tEXt', data),
    png.subarray(png.length - 12),
  ]);
}

// ── Временная папка на D: ──────────────────────────────────────────
fs.mkdirSync(TEMP_BASE, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'run-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
const imgDir = path.join(tempRoot, 'img');
for (const dir of [profileDir, dataDir, workspaceDir, imgDir]) fs.mkdirSync(dir, { recursive: true });

const files = {
  small: path.join(imgDir, 'small.png'),
  bigNear: path.join(imgDir, 'big-near-limit.png'),
  bigExact: path.join(imgDir, 'big-exact-limit.png'),
  bigOver: path.join(imgDir, 'big-over-limit.png'),
  bigOver5: path.join(imgDir, 'big-over-limit-5mb.png'),
  text: path.join(imgDir, 'note.txt'),
  fake: path.join(imgDir, 'fake-image.png'),
  truncated: path.join(imgDir, 'truncated.png'),
  empty: path.join(imgDir, 'empty.png'),
};
const fileMeta = {};

function prepareImages() {
  const small = makePng(320, 200, (x, y) => ((Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? [255, 210, 40] : [24, 70, 220]));
  fs.writeFileSync(files.small, small);
  fileMeta.small = small.length;

  const noise = makePng(2550, 2550, (_x, _y, rnd) => [rnd(), rnd(), rnd()]);
  const near = padPng(noise, MAX_BYTES - 64 * 1024);
  const exact = padPng(noise, MAX_BYTES);
  const over = padPng(noise, MAX_BYTES + 1);
  const over5 = padPng(noise, MAX_BYTES + 5 * 1024 * 1024);
  fs.writeFileSync(files.bigNear, near);
  fs.writeFileSync(files.bigExact, exact);
  fs.writeFileSync(files.bigOver, over);
  fs.writeFileSync(files.bigOver5, over5);
  fileMeta.bigNear = near.length;
  fileMeta.bigExact = exact.length;
  fileMeta.bigOver = over.length;
  fileMeta.bigOver5 = over5.length;

  fs.writeFileSync(files.text, 'Это обычный текст, а не картинка.\n', 'utf8');
  fs.writeFileSync(files.fake, 'PNG в названии, но внутри текст. Не картинка.\n', 'utf8');
  fs.writeFileSync(files.truncated, small.subarray(0, Math.floor(small.length / 3)));
  fs.writeFileSync(files.empty, Buffer.alloc(0));
}

prepareImages();

// ── Приложение во временном профиле ───────────────────────────────
app.setPath('userData', profileDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  voice: false,
  backgroundModelRuns: false,
  alwaysListen: false,
  dictation: false,
  desktopOverlay: false,
  alwaysOnTop: false,
  motion: false,
  seededBrief: true,
  modelTier: 'fast',
  thinking: 'low',
}), 'utf8');

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
let mainWin = null;
let currentStage = 'start';
const consoleErrors = [];
const startedAt = Date.now();

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const payload = { ...result, elapsedMs: Date.now() - startedAt };
  if (keepTemp) payload.tempRoot = tempRoot;
  const line = `NOX_BACKDROP_QA_RESULT ${JSON.stringify(payload)}\n`;
  const code = result && result.ok ? 0 : 1;
  let closed = false;
  const exit = () => { if (closed) return; closed = true; app.exit(code); };
  try { process.stdout.write(line, () => setTimeout(exit, 50)); } catch { exit(); return; }
  setTimeout(exit, 3000).unref();
}

process.on('exit', () => {
  if (keepTemp) { console.error(`NOX_BACKDROP_QA_TEMP ${tempRoot}`); return; }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  catch { console.error(`NOX_BACKDROP_QA_TEMP_REMAINS ${tempRoot}`); }
});
process.on('uncaughtException', (err) => {
  finish({ ok: false, error: `uncaught: ${err && err.message ? err.message : err}`, stage: currentStage });
});
process.on('unhandledRejection', (err) => {
  finish({ ok: false, error: `unhandledRejection: ${err && err.message ? err.message : err}`, stage: currentStage });
});

const deadline = setTimeout(() => {
  finish({ ok: false, error: `timeout ${TIMEOUT_MS} мс`, stage: currentStage, consoleErrors: consoleErrors.slice() });
}, TIMEOUT_MS);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function js(win, code) { return win.webContents.executeJavaScript(code, true); }
async function waitFor(win, code, { timeout = 15000, interval = 100, label = 'условие' } = {}) {
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

// CDP: кладём настоящий файл в скрытый input и даём странице обычный change.
async function cdp(win, method, params) {
  return win.webContents.debugger.sendCommand(method, params || {});
}
async function fileInputNode(win) {
  const doc = await cdp(win, 'DOM.getDocument', { depth: 2 });
  const found = await cdp(win, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.look-own input[type=file]' });
  if (!found || !found.nodeId) throw new Error('в окне нет поля выбора картинки .look-own input[type=file]');
  return found.nodeId;
}

const INSTALL_JS = `(() => {
  const Q = window.__qa = window.__qa || {};
  Q.errs = Q.errs || [];
  Q.setCount = Q.setCount || 0;
  if (!Q.listeners) {
    Q.listeners = true;
    window.addEventListener('unhandledrejection', (e) => Q.errs.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason)));
    window.addEventListener('error', (e) => Q.errs.push('error: ' + String(e.message || e)));
  }
  const B = window.NoxBackdrop;
  if (B && !B.__qaWrapped) {
    const origSet = B.set.bind(B);
    const origClear = B.clear.bind(B);
    B.set = async (f) => {
      const t = performance.now();
      try {
        const r = await origSet(f);
        Q.setCount += 1;
        Q.lastSet = { ok: true, ms: Math.round(performance.now() - t), size: f && f.size, name: f && f.name, type: f && f.type };
        return r;
      } catch (e) {
        Q.setCount += 1;
        Q.lastSet = { ok: false, ms: Math.round(performance.now() - t), size: f && f.size, name: f && f.name, type: f && f.type, error: String((e && e.message) || e) };
        throw e;
      }
    };
    B.clear = async () => {
      const t = performance.now();
      const r = await origClear();
      Q.lastClear = { ok: true, ms: Math.round(performance.now() - t) };
      return r;
    };
    B.__qaWrapped = true;
  }
  Q.frames = Q.frames || { max: 0, running: false, count: 0, last: 0 };
  Q.framesStart = () => {
    Q.frames = { max: 0, running: true, count: 0, last: performance.now() };
    const tick = () => {
      if (!Q.frames.running) return;
      const n = performance.now();
      const d = n - Q.frames.last;
      if (d > Q.frames.max) Q.frames.max = d;
      Q.frames.last = n;
      Q.frames.count += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  };
  Q.framesStop = () => { Q.frames.running = false; return { maxGap: Math.round(Q.frames.max), frames: Q.frames.count }; };
  Q.state = () => {
    const q = (s) => document.querySelector(s);
    const r = document.documentElement;
    const T = window.JarvisTheme;
    const note = q('.look-own-note');
    const bgEl = q('.theme-bg');
    const pick = q('#lookOwnPick');
    const drop = q('#lookOwnDrop');
    const file = q('.look-own input[type=file]');
    const bgSelect = q('select[data-look-key="bg"]');
    const bgSeg = q('.look-seg[data-look-key="bg"] button[aria-checked="true"]');
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('jarvis.look') || 'null'); } catch { saved = null; }
    return {
      view: document.body.dataset.view || null,
      has: window.NoxBackdrop ? window.NoxBackdrop.has() : null,
      url: (r.style.getPropertyValue('--own-bg') || '').trim(),
      dataOwn: r.dataset.ownBg || null,
      dataBg: r.dataset.bg || null,
      lookBg: T ? T.getLook().bg : null,
      savedBg: saved ? saved.bg : null,
      savedDim: saved ? saved.bgDim : null,
      bgSelect: bgSeg ? bgSeg.dataset.id : (bgSelect ? bgSelect.value : null),
      note: note ? (note.textContent || '') : 'нет строки',
      noteErr: note ? (note.dataset.err || null) : null,
      pickVisible: !!pick && !!(pick.offsetWidth || pick.offsetHeight),
      pickText: pick ? (pick.textContent || '').trim() : '',
      dropHidden: drop ? drop.hidden : null,
      inputFiles: file ? file.files.length : null,
      inputAccept: file ? file.accept : null,
      bgDisplay: bgEl ? getComputedStyle(bgEl).display : null,
      bgImage: bgEl ? getComputedStyle(bgEl, '::before').backgroundImage : null,
      dimVar: (r.style.getPropertyValue('--own-bg-dim') || '').trim(),
      errs: Q.errs.slice(-5),
    };
  };
  Q.stored = () => new Promise((resolve) => {
    let open;
    try { open = indexedDB.open('nox-backdrop', 1); } catch (e) { resolve({ error: String(e.message || e) }); return; }
    open.onerror = () => resolve({ error: String((open.error && open.error.message) || open.error) });
    open.onupgradeneeded = () => { try { open.result.createObjectStore('files'); } catch (e) { /* уже есть */ } };
    open.onsuccess = () => {
      const db = open.result;
      let req;
      try { req = db.transaction('files', 'readonly').objectStore('files').get('own-bg'); }
      catch (e) { db.close(); resolve({ error: String(e.message || e) }); return; }
      req.onsuccess = () => { const b = req.result; db.close(); resolve(b ? { size: b.size, type: b.type, name: b.name || '' } : { empty: true }); };
      req.onerror = () => { db.close(); resolve({ error: String((req.error && req.error.message) || req.error) }); };
    };
  });
  Q.decodeStored = () => new Promise((resolve) => {
    let open;
    try { open = indexedDB.open('nox-backdrop', 1); } catch (e) { resolve({ ok: false, error: String(e.message || e) }); return; }
    open.onerror = () => resolve({ ok: false, error: String((open.error && open.error.message) || open.error) });
    open.onupgradeneeded = () => { try { open.result.createObjectStore('files'); } catch (e) { /* уже есть */ } };
    open.onsuccess = () => {
      const db = open.result;
      let req;
      try { req = db.transaction('files', 'readonly').objectStore('files').get('own-bg'); }
      catch (e) { db.close(); resolve({ ok: false, error: String(e.message || e) }); return; }
      req.onsuccess = async () => {
        const blob = req.result;
        db.close();
        if (!blob) { resolve({ ok: false, error: 'в хранилище нет картинки' }); return; }
        try {
          const bmp = await createImageBitmap(blob);
          const out = { ok: true, width: bmp.width, height: bmp.height, size: blob.size };
          if (bmp.close) bmp.close();
          resolve(out);
        } catch (e) { resolve({ ok: false, error: String((e && e.message) || e), size: blob.size }); }
      };
      req.onerror = () => { db.close(); resolve({ ok: false, error: String((req.error && req.error.message) || req.error) }); };
    };
  });
  Q.spyPick = () => {
    const proto = HTMLInputElement.prototype;
    const orig = proto.click;
    let called = 0;
    proto.click = function patched() { called += 1; };
    try { document.getElementById('lookOwnPick').click(); } finally { proto.click = orig; }
    return called;
  };
  return true;
})()`;

async function install(win) {
  await waitFor(win, `Boolean(window.NoxBackdrop && window.JarvisTheme && document.getElementById('lookOwnPick'))`, {
    timeout: 25000, label: 'backdrop.js, theme-boot.js и строка «Своя картинка»',
  });
  await js(win, INSTALL_JS);
}

async function openLookSettings(win) {
  try { await js(win, `window.JarvisNox && window.JarvisNox.show('settings'); true`); } catch { /* раздел уже показан */ }
  await waitFor(win, `document.body.dataset.view === 'settings' && Boolean(document.getElementById('lookOwnPick'))`, {
    timeout: 20000, label: 'раздел «Настройки»',
  });
  await js(win, `(() => {
    const row = Array.from(document.querySelectorAll('.look-row')).find((r) => (r.textContent || '').includes('Своя картинка'));
    const main = document.querySelector('#setMain');
    if (row && main) main.scrollTop = Math.max(0, row.offsetTop - main.offsetTop - 120);
    const pick = document.getElementById('lookOwnPick');
    if (pick && pick.scrollIntoView) pick.scrollIntoView({ block: 'center' });
    return true;
  })()`).catch(() => null);
  await sleep(350);
}

async function chooseFile(win, filePath) {
  await js(win, `window.__qa.lastSet = null; true`);
  const before = await js(win, 'window.__qa.setCount');
  const nodeId = await fileInputNode(win);
  await cdp(win, 'DOM.setFileInputFiles', { files: [filePath], nodeId });
  await sleep(450);
  const count = await js(win, 'window.__qa.setCount');
  if (count === before) {
    await js(win, `(() => {
      const f = document.querySelector('.look-own input[type=file]');
      f.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }
  return waitFor(win, 'window.__qa.lastSet', { timeout: 120000, interval: 100, label: `итог выбора ${path.basename(filePath)}` }).catch(() => null);
}

async function snapshot(win) {
  const state = await js(win, 'window.__qa.state()');
  const stored = await js(win, 'window.__qa.stored()');
  const decode = await js(win, 'window.__qa.decodeStored()');
  return { state, stored, decode };
}

async function shot(win, name) {
  try {
    const image = await win.webContents.capturePage();
    if (!image || image.isEmpty()) return null;
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, name);
    fs.writeFileSync(file, image.toPNG());
    return file;
  } catch { return null; }
}

async function main(win) {
  const checks = [];
  const shots = {};
  const metrics = {};
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : detail });

  currentStage = 'window';
  try { win.showInactive(); } catch { try { win.show(); } catch { /* окно уже видимо */ } }
  try { win.setMinimumSize(200, 200); } catch { /* старые версии Electron */ }
  win.setContentSize(1200, 720);
  await sleep(600);
  // main.js уже держит отладочный протокол для prefers-reduced-motion: не переподключаемся.
  try {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  } catch (err) { currentStage = 'debugger'; throw new Error(`CDP: ${err.message}`); }
  await cdp(win, 'DOM.enable');
  await install(win);
  await openLookSettings(win);

  // 1. Исходное состояние.
  currentStage = 'start-state';
  {
    const s0 = await snapshot(win);
    shots['01-start'] = await shot(win, '01-start.png');
    check('1. Исходно: строка выбора на месте, картинки нет, фон темы',
      s0.state.pickVisible && s0.state.pickText === 'Выбрать картинку'
        && s0.state.has === false && s0.state.dataOwn === null && s0.state.dataBg === null
        && s0.state.lookBg === 'theme' && s0.state.dropHidden === true && s0.state.note === ''
        && s0.stored.empty === true
        && /image\/png/.test(s0.state.inputAccept || '') && /image\/jpeg/.test(s0.state.inputAccept || ''),
      JSON.stringify({ pick: s0.state.pickText, has: s0.state.has, bg: s0.state.lookBg, dropHidden: s0.state.dropHidden, note: s0.state.note, stored: s0.stored }));
  }

  // 2. Обычная картинка: всё включается и рисуется.
  currentStage = 'small';
  {
    await js(win, 'window.__qa.framesStart()');
    const res = await chooseFile(win, files.small);
    const frames = await js(win, 'window.__qa.framesStop()');
    const s = await snapshot(win);
    shots['02-small'] = await shot(win, '02-small.png');
    metrics.small = { set: res, frames, stored: s.stored, decode: s.decode };
    check('2. Маленькая картинка: сохранена, показана, «Убрать» появилась, фон image',
      res && res.ok === true && s.state.has === true && /^url\("blob:/.test(s.state.url)
        && s.state.dataOwn === 'on' && s.state.dataBg === 'image' && s.state.lookBg === 'image'
        && s.state.note === '' && s.state.dropHidden === false
        && s.stored.size === fileMeta.small && s.decode.ok === true && s.decode.width === 320 && s.decode.height === 200
        && s.state.bgDisplay === 'block' && /blob:/.test(s.state.bgImage),
      JSON.stringify({ set: res, has: s.state.has, url: s.state.url.slice(0, 60), note: s.state.note, dropHidden: s.state.dropHidden, stored: s.stored, decode: s.decode, frames }));
  }

  // 2б. Второй выбор подряд: отличаем первую инициализацию хранилища от обычной работы.
  currentStage = 'small-again';
  {
    await js(win, 'window.__qa.framesStart()');
    const res = await chooseFile(win, files.small);
    const frames = await js(win, 'window.__qa.framesStop()');
    const s = await snapshot(win);
    metrics.smallAgain = { set: res, frames, decode: s.decode };
    check('2б. Повторное сохранение подряд: без заметного зависания (обычная работа)',
      res && res.ok === true && frames.maxGap < 1000 && s.state.has === true,
      JSON.stringify({ set: res, frames }));
  }

  // 3. Большой файл около лимита 25 МБ.
  currentStage = 'big-near';
  {
    const t0 = Date.now();
    await js(win, 'window.__qa.framesStart()');
    const res = await chooseFile(win, files.bigNear);
    const frames = await js(win, 'window.__qa.framesStop()');
    const roundtrip = Date.now() - t0;
    const s = await snapshot(win);
    shots['03-near-limit'] = await shot(win, '03-near-limit.png');
    metrics.bigNear = { set: res, frames, roundtripMs: roundtrip, stored: s.stored, decode: s.decode };
    check('3. Большой файл 24,94 МБ (у лимита): принят, сохранён целиком, показан, интерфейс жив',
      res && res.ok === true && res.size === fileMeta.bigNear && s.state.has === true
        && s.stored.size === fileMeta.bigNear && s.decode.ok === true && s.decode.width === 2550 && s.decode.height === 2550
        && frames.maxGap < 2000,
      JSON.stringify({ res, frames, stored: s.stored, decode: s.decode }));
  }

  // 4. Ровно 25 МБ.
  currentStage = 'big-exact';
  {
    await js(win, 'window.__qa.framesStart()');
    const res = await chooseFile(win, files.bigExact);
    const frames = await js(win, 'window.__qa.framesStop()');
    const s = await snapshot(win);
    metrics.bigExact = { set: res, frames, stored: s.stored, decode: s.decode };
    check('4. Ровно 25 МБ: граница включительная (не больше — значит можно)',
      res && res.ok === true && res.size === MAX_BYTES && s.stored.size === MAX_BYTES && s.decode.ok === true,
      JSON.stringify({ res, stored: s.stored, decode: s.decode, frames }));
  }

  // 5. Выше лимита: отказ и сохранение прежнего фона.
  currentStage = 'big-over';
  {
    const before = await snapshot(win);
    await js(win, 'window.__qa.lastSet = null; true');
    const res = await chooseFile(win, files.bigOver);
    const after = await snapshot(win);
    shots['05-over-limit'] = await shot(win, '05-over-limit.png');
    const res5 = await chooseFile(win, files.bigOver5);
    const after5 = await snapshot(win);
    metrics.over = { oneByte: res, fiveMb: res5, before: before.state, after: after.state, after5: after5.state };
    check('5. Файл выше 25 МБ: ясный отказ, прежняя картинка и настройки целы',
      res && res.ok === false && /25 МБ/.test(res.error)
        && res5 && res5.ok === false && /25 МБ/.test(res5.error)
        && after.state.has === true && after.state.url === before.state.url
        && after.state.lookBg === 'image' && after.state.savedBg === 'image'
        && after.state.noteErr === '1' && /25 МБ/.test(after.state.note)
        && after.stored.size === before.stored.size && after.decode.ok === true
        && after5.state.url === before.state.url && after5.stored.size === before.stored.size,
      JSON.stringify({ oneByte: res, fiveMb: res5, urlKept: after.state.url === before.state.url, note: after.state.note, storedKept: after.stored.size === before.stored.size }));
  }

  // 6. Не картинка: текстовый файл.
  currentStage = 'text-file';
  {
    const before = await snapshot(win);
    const res = await chooseFile(win, files.text);
    const after = await snapshot(win);
    shots['06-not-image'] = await shot(win, '06-not-image.png');
    metrics.text = { set: res, after: after.state };
    check('6. Текстовый файл: отказ словами, прежняя картинка цела, поле выбора очищено',
      res && res.ok === false && /Нужна картинка/.test(res.error)
        && after.state.has === true && after.state.url === before.state.url
        && after.state.noteErr === '1' && /Нужна картинка/.test(after.state.note)
        && after.state.inputFiles === 0 && after.stored.size === before.stored.size && after.decode.ok === true,
      JSON.stringify({ set: res, note: after.state.note, urlKept: after.state.url === before.state.url, storedKept: after.stored.size === before.stored.size, inputFiles: after.state.inputFiles }));
  }

  // 7. Пустой файл и обрезанная картинка.
  currentStage = 'empty';
  {
    const before = await snapshot(win);
    const empty = await chooseFile(win, files.empty);
    const afterEmpty = await snapshot(win);
    const truncated = await chooseFile(win, files.truncated);
    const afterTrunc = await snapshot(win);
    metrics.empty = { empty, truncated, afterEmpty: afterEmpty.state, afterTruncated: afterTrunc.state };
    check('7. Пустой файл: отказ «Файл пустой», прежняя картинка цела',
      empty && empty.ok === false && /пустой/.test(empty.error)
        && afterEmpty.state.url === before.state.url && afterEmpty.stored.size === before.stored.size,
      JSON.stringify({ empty, urlKept: afterEmpty.state.url === before.state.url }));
    check('7б. Обрезанная картинка (битый PNG): не должна приниматься молча',
      truncated && truncated.ok === false && afterTrunc.state.url === before.state.url,
      JSON.stringify({ truncated, urlKept: afterTrunc.state.url === before.state.url, note: afterTrunc.state.note }));
  }

  // 8. Файл с картинкой только в названии: текстовые байты с расширением .png.
  currentStage = 'fake-image';
  {
    const before = await snapshot(win);
    const res = await chooseFile(win, files.fake);
    const after = await snapshot(win);
    shots['08-fake-png'] = await shot(win, '08-fake-png.png');
    metrics.fake = { set: res, before: before.state, after: after.state, decodeStored: after.decode };
    check('8. «Картинка» с текстом внутри: отказ, а не тихий успех с пустым фоном',
      res && res.ok === false && /не читается|картинк/i.test(res.error)
        && after.state.url === before.state.url && after.state.has === true
        && after.decode.ok === true,
      JSON.stringify({ set: res, urlKept: after.state.url === before.state.url, note: after.state.note, decodeStored: after.decode }));
  }

  // 9. Повторный выбор после ошибки.
  currentStage = 'reselect';
  {
    const res = await chooseFile(win, files.small);
    const after = await snapshot(win);
    shots['09-reselect'] = await shot(win, '09-reselect.png');
    metrics.reselect = { set: res, after: after.state, stored: after.stored, decode: after.decode };
    check('9. Повторный выбор после ошибки: принимается, сообщение об ошибке уходит',
      res && res.ok === true && after.state.has === true && after.state.note === ''
        && after.state.noteErr === null && after.state.dropHidden === false
        && after.state.savedBg === 'image' && after.stored.size === fileMeta.small && after.decode.ok === true,
      JSON.stringify({ set: res, note: after.state.note, noteErr: after.state.noteErr, stored: after.stored, decode: after.decode }));
  }

  // 10. Отмена выбора: кнопка зовёт поле, пустой выбор ничего не меняет.
  currentStage = 'cancel';
  {
    const before = await snapshot(win);
    const clicked = await js(win, 'window.__qa.spyPick()');
    const setBefore = await js(win, 'window.__qa.setCount');
    const nodeId = await fileInputNode(win);
    await cdp(win, 'DOM.setFileInputFiles', { files: [], nodeId });
    await sleep(300);
    await js(win, `(() => {
      const f = document.querySelector('.look-own input[type=file]');
      f.dispatchEvent(new Event('cancel', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const after = await snapshot(win);
    const setAfter = await js(win, 'window.__qa.setCount');
    shots['10-cancel'] = await shot(win, '10-cancel.png');
    metrics.cancel = { clicked, before: before.state, after: after.state, setBefore, setAfter };
    check('10. Отмена выбора: кнопка открывает поле, пустой выбор ничего не ломает',
      clicked === 1 && after.state.has === true && after.state.url === before.state.url
        && after.state.lookBg === 'image' && after.state.note === before.state.note
        && after.state.inputFiles === 0 && setAfter === setBefore,
      JSON.stringify({ clicked, urlKept: after.state.url === before.state.url, note: after.state.note, inputFiles: after.state.inputFiles, setCalls: setAfter - setBefore }));
  }

  // 11. Перезагрузка окна: картинка и настройка переживают закрытие.
  currentStage = 'reload';
  {
    const before = await snapshot(win);
    const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await Promise.race([loaded, sleep(30000)]);
    await waitFor(win, `Boolean(window.NoxBackdrop && window.JarvisTheme && document.getElementById('lookOwnPick'))`, {
      timeout: 30000, label: 'перезагрузка окна',
    });
    await install(win);
    await sleep(900);
    await openLookSettings(win);
    const after = await snapshot(win);
    shots['11-after-reload'] = await shot(win, '11-after-reload.png');
    await sleep(1500);
    shots['11b-after-reload-late'] = await shot(win, '11b-after-reload-late.png');
    metrics.reload = { before: before.state, after: after.state, stored: after.stored, decode: after.decode };
    check('11. Перезагрузка: картинка и фон «image» вернулись, настройка не потеряна',
      after.state.has === true && after.state.dataOwn === 'on' && after.state.dataBg === 'image'
        && after.state.lookBg === 'image' && after.state.savedBg === 'image'
        && after.state.note === '' && after.state.dropHidden === false
        && after.state.bgSelect === 'image' && after.state.bgDisplay === 'block'
        && after.stored.size === fileMeta.small && after.decode.ok === true && after.decode.width === 320,
      JSON.stringify({ has: after.state.has, dataBg: after.state.dataBg, lookBg: after.state.lookBg, savedBg: after.state.savedBg, note: after.state.note, stored: after.stored, decode: after.decode }));
  }

  // 11б. Первый выбор картинки после перезапуска окна: сколько длится и не замирает ли экран.
  currentStage = 'first-save-after-reload';
  {
    await js(win, 'window.__qa.framesStart()');
    const res = await chooseFile(win, files.small);
    const frames = await js(win, 'window.__qa.framesStop()');
    const s = await snapshot(win);
    metrics.firstSaveAfterReload = { set: res, frames, decode: s.decode };
    check('11б. Первый выбор после перезапуска: укладывается в разумное время, окно отвечает',
      res && res.ok === true && frames.maxGap < 2000 && s.state.has === true && s.decode.ok === true,
      JSON.stringify({ set: res, frames }));
  }

  // 12. «Убрать»: фон возвращается к теме, хранилище пустое.
  currentStage = 'drop';
  {
    await js(win, `document.getElementById('lookOwnDrop').click(); true`);
    await waitFor(win, 'window.__qa.lastClear', { timeout: 15000, label: 'итог «Убрать»' }).catch(() => null);
    await sleep(600);
    const after = await snapshot(win);
    shots['12-drop'] = await shot(win, '12-drop.png');
    metrics.drop = { after: after.state, stored: after.stored };
    check('12. «Убрать»: картинка удалена, фон снова тема, хранилище пустое',
      after.state.has === false && after.state.url === '' && after.state.dataOwn === null
        && after.state.lookBg === 'theme' && after.state.savedBg === 'theme'
        && after.state.dropHidden === true && after.state.note === ''
        && after.stored.empty === true,
      JSON.stringify({ has: after.state.has, url: after.state.url, dataOwn: after.state.dataOwn, lookBg: after.state.lookBg, note: after.state.note, stored: after.stored }));
  }

  // 13. Целостность окна после всех сценариев.
  currentStage = 'final';
  {
    const s = await snapshot(win);
    const responsiveMs = await (async () => { const t = Date.now(); await js(win, '1 + 1'); return Date.now() - t; })();
    const crashed = win.webContents.isCrashed();
    const all = checks.length;
    check('13. Итог: окно отвечает, не упало, ошибок консоли и страницы нет',
      !crashed && responsiveMs < 1000 && s.state.errs.length === 0 && consoleErrors.length === 0,
      JSON.stringify({ crashed, responsiveMs, pageErrors: s.state.errs, consoleErrors: consoleErrors.slice(0, 8) }));
    metrics.final = { responsiveMs, all };
  }

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  return { ok: failed === 0, passed, failed, checks, metrics, shots, files: fileMeta, outDir: outDir };
}

app.on('browser-window-created', (_event, win) => {
  try {
    win.webContents.on('console-message', (_e, level, message) => {
      const noisy = typeof level === 'object' && level ? level : null;
      const severity = noisy ? noisy.level : level;
      const text = noisy ? noisy.message : message;
      if ((severity === 'error' || severity === 3) && consoleErrors.length < 30) consoleErrors.push(String(text || '').slice(0, 300));
    });
  } catch { /* старые версии Electron */ }

  win.webContents.once('did-finish-load', () => {
    if (mainWin) return;
    if (!/renderer[\\/]index\.html/i.test(win.webContents.getURL())) return;
    mainWin = win;
    main(win)
      .then((result) => finish({ ...result, consoleErrors: consoleErrors.slice(), profile: tempRoot }))
      .catch((err) => finish({ ok: false, stage: currentStage, error: err && err.message ? err.message : String(err), consoleErrors: consoleErrors.slice() }));
  });
});

try {
  require('../main');
} catch (err) {
  finish({ ok: false, error: `main.js не загрузился: ${err && err.message ? err.message : err}` });
}
