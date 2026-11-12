'use strict';

// Живая QA-проверка и снимки виджетов «Календарь» и «Встречи» в настоящем Electron.
// Использует изолированный временный профиль и временную папку данных (NOX_DATA_DIR).
//
// Запуск из apps/jarvis-desktop (со снятой ELECTRON_RUN_AS_NODE):
//   npx electron scripts/desks-calendar-qa.js --out <папка_снимков>

const fs = require('fs');
const os = require('os');
const path = require('path');

let electron = null;
try { electron = require('electron'); } catch { electron = null; }
if (!electron || !electron.app || typeof electron.app.whenReady !== 'function') {
  console.error('desks-calendar-qa: нужен запуск через electron (снимите ELECTRON_RUN_AS_NODE)');
  process.exit(1);
}

const { app, globalShortcut, dialog, ipcMain } = electron;

let delayDesksOnceMs = 0;
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => origHandle(channel, async (...args) => {
  if (channel === 'desks:state' && delayDesksOnceMs > 0) {
    const ms = delayDesksOnceMs;
    delayDesksOnceMs = 0;
    await new Promise((r) => setTimeout(r, ms));
  }
  return fn(...args);
});

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

const outDir = path.resolve(arg('out', path.join(os.tmpdir(), 'nox-m8-calendar-shots')));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-m8-desk-qa-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
for (const dir of [profileDir, dataDir, path.join(tempRoot, 'workspace')]) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  voice: false,
  backgroundModelRuns: false,
  alwaysListen: false,
  dictation: false,
  desktopOverlay: false,
  alwaysOnTop: false,
  motion: true,
  seededBrief: true,
}), 'utf8');

function fmtIcsUtc(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
}

const baseNow = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const workIcsPath = path.join(tempRoot, 'work-ok.ics');
const emptyIcsPath = path.join(tempRoot, 'empty.ics');
const brokenIcsPath = path.join(tempRoot, 'broken.ics');

function writeWorkIcs() {
  fs.writeFileSync(workIcsPath, [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nox//M8 QA//RU',
    'BEGIN:VEVENT',
    'UID:qa-meet-1',
    'SUMMARY:Планирование продукта',
    `DTSTART:${fmtIcsUtc(baseNow + 45 * MIN)}`,
    `DTEND:${fmtIcsUtc(baseNow + 105 * MIN)}`,
    'LOCATION:Переговорная А',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:qa-meet-2',
    'SUMMARY:Созвон по дизайну (пересечение)',
    `DTSTART:${fmtIcsUtc(baseNow + 75 * MIN)}`,
    `DTEND:${fmtIcsUtc(baseNow + 135 * MIN)}`,
    'LOCATION:Онлайн',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:qa-meet-3',
    'SUMMARY:Ревью задач',
    `DTSTART:${fmtIcsUtc(baseNow + 25 * HOUR)}`,
    `DTEND:${fmtIcsUtc(baseNow + 26 * HOUR)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'), 'utf8');
}

writeWorkIcs();
fs.writeFileSync(emptyIcsPath, [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Nox//M8 Empty//RU',
  'END:VCALENDAR',
].join('\r\n'), 'utf8');
fs.writeFileSync(brokenIcsPath, 'broken-ics-content-without-vcalendar', 'utf8');

app.setPath('userData', profileDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
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
const consoleErrors = [];

function finish(result) {
  if (finished) return;
  finished = true;
  process.stdout.write(`DESKS_CALENDAR_QA ${JSON.stringify(result)}\n`, () => {
    setTimeout(() => app.exit(result.ok ? 0 : 1), 30);
  });
  setTimeout(() => app.exit(1), 2000).unref();
}

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* занято */ }
});
process.on('uncaughtException', (err) => finish({ ok: false, error: `uncaught: ${err && err.message}` }));
const deadline = setTimeout(() => finish({ ok: false, error: 'timeout 120s' }), 120000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (win, code) => win.webContents.executeJavaScript(code, true);

async function waitFor(win, code, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { const v = await js(win, code); if (v) return v; } catch { /* загрузка */ }
    await sleep(120);
  }
  throw new Error(`не дождались: ${label}`);
}

async function resize(win, w, h) {
  win.setContentSize(w, h);
  for (let i = 0; i < 40; i += 1) {
    const [cw, ch] = win.getContentSize();
    if (cw === w && ch === h) break;
    await sleep(40);
  }
  await sleep(300);
}

const LAYOUT_JS = `(() => {
  const doc = document.documentElement;
  const out = { hOverflow: doc.scrollWidth > innerWidth + 1, widgetHOverflow: [], blocked: [], outside: [] };
  for (const body of document.querySelectorAll('.desk-widget-body-inner')) {
    if (body.scrollWidth > body.clientWidth + 2) {
      out.widgetHOverflow.push(body.className + ':' + body.scrollWidth + '>' + body.clientWidth);
    }
  }
  for (const el of document.querySelectorAll('#deskPage button, #deskPage input')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest('[hidden]')) continue;
    const name = (el.id ? '#' + el.id : el.className || el.tagName) + ' ' + (el.textContent || '').trim().slice(0, 20);
    if (r.right > innerWidth + 1 || r.left < -1) { out.outside.push(name); continue; }
    if (r.bottom > innerHeight || r.top < 0) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      let clip = el.parentElement;
      let clipped = false;
      while (clip && clip !== document.body) {
        const cs = getComputedStyle(clip);
        if (/(auto|scroll|hidden|clip)/.test(cs.overflowY + cs.overflowX)) {
          const cr = clip.getBoundingClientRect();
          if (cy < cr.top || cy > cr.bottom || cx < cr.left || cx > cr.right) { clipped = true; break; }
        }
        clip = clip.parentElement;
      }
      if (!clipped) out.blocked.push(name + ' <- ' + (hit.className || hit.tagName));
    }
  }
  return out;
})()`;

async function snap(win, name) {
  fs.mkdirSync(outDir, { recursive: true });
  await js(win, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  await sleep(250);
  const img = await win.webContents.capturePage();
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  return { name, file, size: img.getSize() };
}

async function run(win) {
  const checks = [];
  const shots = [];
  const layoutIssues = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });

  await waitFor(win, `Boolean(window.JarvisNox && window.JarvisDesks && document.querySelector('#deskOpen'))`, 'интерфейс', 25000);
  try { win.showInactive(); } catch { win.show(); }
  try { win.setMinimumSize(200, 200); } catch { /* игнор */ }
  await sleep(1000);
  await resize(win, 1200, 720);

  // Открываем экран «Столы» и добавляем виджеты «Календарь» и «Встречи»
  await js(win, `(() => { window.JarvisNox.show('dialog'); document.querySelector('#deskOpen').click(); return true; })()`);
  await waitFor(win, `(() => {
    const p = document.querySelector('#deskPage');
    return p && !p.hidden && document.querySelector('[data-widget-type="calendar"]') && document.querySelector('[data-widget-type="meetings"]');
  })()`, 'кнопки каталога на столе');

  check('Каталог содержит Календарь и Встречи', true);

  await js(win, `(() => { document.querySelector('[data-widget-type="calendar"]').click(); return true; })()`);
  await waitFor(win, `document.querySelectorAll('.desk-cal-connect').length >= 1`, 'виджет Календарь добавлен');
  await js(win, `(() => { document.querySelector('[data-widget-type="meetings"]').click(); return true; })()`);
  await waitFor(win, `document.querySelectorAll('.desk-cal-connect').length >= 2`, 'виджет Встречи добавлен');

  // 1. Состояние not_connected
  const notConnInfo = await js(win, `(() => ({
    text: document.querySelector('#deskGrid').textContent,
    layout: ${LAYOUT_JS}
  }))()`);
  check('not_connected: честное предложение подключения',
    notConnInfo.text.includes('Календарь не подключён') && notConnInfo.text.includes('Источник встреч не подключён'),
    notConnInfo.text.slice(0, 120));
  if (notConnInfo.layout.hOverflow || notConnInfo.layout.blocked.length || notConnInfo.layout.outside.length || notConnInfo.layout.widgetHOverflow.length) {
    layoutIssues.push({ step: 'not_connected-1200', ...notConnInfo.layout });
  }
  shots.push(await snap(win, 'm8-not-connected-1200x720'));

  // 2. Состояние ok (данные + пересечения + локальное время + источник) на 1200x720 и 864x520
  await js(win, `(async () => {
    await window.jarvis.calendarSetSource({ type: 'file', filePath: ${JSON.stringify(workIcsPath)}, label: 'Яндекс Календарь', timeZone: 'Europe/Moscow' });
    document.querySelector('#deskRefresh').click();
    return true;
  })()`);
  await waitFor(win, `Boolean(document.querySelector('.desk-cal-widget') && document.querySelector('.desk-meet-widget'))`, 'виджеты с данными');

  const ok1200 = await js(win, `(() => ({
    calText: document.querySelector('.desk-cal-widget').textContent,
    meetText: document.querySelector('.desk-meet-widget').textContent,
    conflicts: document.querySelectorAll('.is-conflict').length,
    layout: ${LAYOUT_JS}
  }))()`);
  check('ok 1200x720: источник, пояс и пересечения',
    ok1200.calText.includes('Яндекс Календарь') && ok1200.calText.includes('Europe/Moscow') && ok1200.conflicts >= 4 && ok1200.meetText.includes('пересечение'),
    `conflicts=${ok1200.conflicts}`);
  if (ok1200.layout.hOverflow || ok1200.layout.blocked.length || ok1200.layout.outside.length || ok1200.layout.widgetHOverflow.length) {
    layoutIssues.push({ step: 'ok-1200', ...ok1200.layout });
  }
  shots.push(await snap(win, 'm8-ok-1200x720'));

  // Адаптивность 864x520 + проверка раскрытия формы URL
  await resize(win, 864, 520);
  const ok864 = await js(win, `(() => ({ layout: ${LAYOUT_JS} }))()`);
  check('ok 864x520: без горизонтального скролла и наложений',
    !ok864.layout.hOverflow && !ok864.layout.blocked.length && !ok864.layout.outside.length && !ok864.layout.widgetHOverflow.length,
    JSON.stringify(ok864.layout));
  if (ok864.layout.hOverflow || ok864.layout.blocked.length || ok864.layout.outside.length || ok864.layout.widgetHOverflow.length) {
    layoutIssues.push({ step: 'ok-864', ...ok864.layout });
  }
  shots.push(await snap(win, 'm8-ok-864x520'));

  await js(win, `(() => {
    const btn = document.querySelector('.desk-meet-widget .desk-cal-url-btn');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(150);
  const url864 = await js(win, `(() => ({
    open: !document.querySelector('.desk-meet-widget .desk-cal-url-form').hidden,
    layout: ${LAYOUT_JS}
  }))()`);
  check('URL форма на 864x520 помещается без переполнения и перекрытий',
    url864.open && !url864.layout.hOverflow && !url864.layout.widgetHOverflow.length && !url864.layout.blocked.length,
    JSON.stringify(url864.layout));
  await js(win, `(() => {
    const c = document.querySelector('.desk-meet-widget .desk-cal-url-cancel');
    if (c) c.click();
    return true;
  })()`);

  // Возвращаемся к 1200x720 для остальных состояний
  await resize(win, 1200, 720);

  // 3. Состояние empty
  await js(win, `(async () => {
    await window.jarvis.calendarSetSource({ type: 'file', filePath: ${JSON.stringify(emptyIcsPath)}, label: 'Пустой ICS', timeZone: 'Europe/Moscow' });
    document.querySelector('#deskRefresh').click();
    return true;
  })()`);
  await waitFor(win, `document.querySelectorAll('.desk-cal-empty').length === 2`, 'состояние empty');
  const emptyText = await js(win, `document.querySelector('#deskGrid').textContent`);
  check('empty: явное сообщение об отсутствии событий и встреч',
    emptyText.includes('Событий в календаре нет') && emptyText.includes('Предстоящих встреч нет'),
    emptyText.slice(0, 120));
  shots.push(await snap(win, 'm8-empty-1200x720'));

  // 4. Состояние stale (настоящий кэш С3 при пропавшем файле)
  writeWorkIcs();
  await js(win, `(async () => {
    await window.jarvis.calendarSetSource({ type: 'file', filePath: ${JSON.stringify(workIcsPath)}, label: 'Рабочий кэш', timeZone: 'Europe/Moscow' });
    document.querySelector('#deskRefresh').click();
    return true;
  })()`);
  await waitFor(win, `document.querySelectorAll('.desk-cal-widget').length === 1`, 'подготовка кэша для stale');
  fs.unlinkSync(workIcsPath);
  await js(win, `(() => { document.querySelector('#deskRefresh').click(); return true; })()`);
  await waitFor(win, `document.querySelectorAll('.desk-stale').length >= 2`, 'состояние stale');
  const staleText = await js(win, `document.querySelector('#deskGrid').textContent`);
  check('stale: пометка устарело и кэшированные встречи видны',
    staleText.includes('устарело') && staleText.includes('Планирование продукта'),
    staleText.slice(0, 120));
  shots.push(await snap(win, 'm8-stale-1200x720'));

  // 5. Состояние error (сломанный ICS при отсутствии кэша)
  const cacheFile = path.join(dataDir, 'calendar-cache.json');
  if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
  await js(win, `(async () => {
    await window.jarvis.calendarSetSource({ type: 'file', filePath: ${JSON.stringify(brokenIcsPath)}, label: 'Битый ICS', timeZone: 'Europe/Moscow' });
    document.querySelector('#deskRefresh').click();
    return true;
  })()`);
  await waitFor(win, `document.querySelectorAll('.desk-cal-error').length === 2`, 'состояние error');
  const errText = await js(win, `document.querySelector('#deskGrid').textContent`);
  check('error: понятное сообщение ошибки календаря',
    errText.includes('Не получилось:') && errText.includes('файл календаря не удалось разобрать'),
    errText.slice(0, 160));
  shots.push(await snap(win, 'm8-error-1200x720'));

  // 6. Состояние загрузки (реальная задержка desks:state в ядре)
  delayDesksOnceMs = 550;
  await js(win, `(() => { document.querySelector('#deskRefresh').click(); return true; })()`);
  await sleep(80);
  const busyWhile = await js(win, `(() => ({
    ariaBusy: document.querySelector('#deskGrid').getAttribute('aria-busy'),
    btnDisabled: document.querySelector('#deskRefresh').disabled,
    btnText: document.querySelector('#deskRefresh').textContent,
  }))()`);
  await waitFor(win, `document.querySelector('#deskGrid').getAttribute('aria-busy') === 'false' && document.querySelector('#deskRefresh').disabled === false`, 'завершение загрузки');
  check('loading: aria-busy и кнопка в состоянии загрузки и сброса',
    busyWhile.ariaBusy === 'true' && busyWhile.btnDisabled === true && busyWhile.btnText === 'Обновляем…',
    JSON.stringify(busyWhile));

  check('Нет ошибок консоли (включая CSP)', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 500));

  clearTimeout(deadline);
  finish({
    ok: checks.every((c) => c.ok) && layoutIssues.length === 0,
    outDir,
    checks,
    layoutIssues,
    shots,
    consoleErrors,
  });
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

try {
  require('../main');
} catch (err) {
  finish({ ok: false, error: `main.js: ${err && err.message}` });
}
