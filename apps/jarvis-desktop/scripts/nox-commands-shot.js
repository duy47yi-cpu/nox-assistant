'use strict';

// Скриншот настоящего окна Nox в разделе «Команды». Запускается отдельным процессом Electron
// с временным профилем и временными данными: настройки, команды и рабочая папка владельца не читаются.
//
// Из папки apps/jarvis-desktop (ELECTRON_RUN_AS_NODE должен быть снят):
//   electron scripts/nox-commands-shot.js --out <png> --mode catalog|editor|new|picker|record|chat|import|qa
//     [--width 1200] [--height 720] [--command <имя>] [--wait 2500] [--dump-geometry <json>]
//     [--install-packs <id,id>] [--keep-temp] [--keep-banner] [--keep-focus]
//
// --mode catalog — «Мои» с восемью временными командами и карточками готовых паков;
// --mode editor  — клик по первой строке #cmdList .cmd-name (или по --command), редактор команды;
// --mode new     — кнопка «Новая» (#cmdNew): редактор пустого черновика;
// --mode picker  — редактор, затем «Добавить действие» (#cmdStepAdd): диалог выбора действия
//                  (#cmdActionDialog) открыт в кадре;
// --mode record  — кнопка «Записать» (#cmdRecord): панель записи действий;
// --mode chat    — экран Nox (window.JarvisNox.show('nox')): проверка, что чат цел после «Команд»;
// Оболочка определяется по загруженному окну: Aether (renderer/aether/index.html) или старая
// (renderer/index.html). В --mode qa для Aether гоняются 15 живых проверок раздела «Команды»;
// то, чего в Aether нет (импорт, запись действий, старый выбор действия), — честный пропуск.
// --mode import  — кнопка «Импорт»: настоящий предпросмотр файла (диалог выбора файла подменён
//                  временным файлом в памяти процесса, чтобы проверка не открывала окно Windows).
// Печатает одну строку NOX_CMD_SHOT_RESULT <json> и выходит: 0 — снимок сохранён, 1 — ошибка.
// По умолчанию файл: docs/reconstruction/phase3/commands/commands-<W>x<H>-<mode>.png

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
  console.error('nox-commands-shot: нужен запуск через electron.exe, а не node: снимите ELECTRON_RUN_AS_NODE');
  process.exit(1);
}
const { app, globalShortcut, dialog } = electron;

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'docs', 'reconstruction', 'phase3', 'commands');
let TIMEOUT_MS = 30000;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}
function bad(message) {
  console.error(`nox-commands-shot: ${message}`);
  process.exit(2);
}

const width = Number.parseInt(arg('width', '1200'), 10) || 1200;
const height = Number.parseInt(arg('height', '720'), 10) || 720;
if (width < 420 || height < 480) bad('окно меньше минимального 420x480');
const MODES = ['catalog', 'editor', 'new', 'picker', 'record', 'import', 'qa', 'chat'];
const mode = String(arg('mode', 'catalog')).toLowerCase();
if (!MODES.includes(mode)) bad(`--mode: ${MODES.join('|')}, получено «${arg('mode')}»`);
// QA гоняет длинный сценарий по настоящему DOM: даём ему больше времени, чем одному кадру.
if (mode === 'qa') TIMEOUT_MS = 90000;
const waitMs = Math.min(20000, Math.max(0, Number.parseInt(arg('wait', '2500'), 10) || 2500));
const commandName = String(arg('command', '')).trim();
const outArg = arg('out', '');
const outPath = path.resolve(outArg || path.join(SHOTS_DIR, `commands-${width}x${height}-${mode}.png`));
const dumpArg = arg('dump-geometry', '');
const dumpPath = dumpArg ? path.resolve(dumpArg) : '';
const keepTemp = has('keep-temp');
const keepBanner = has('keep-banner');
const keepFocus = has('keep-focus');
const installPacks = String(arg('install-packs', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Временный профиль и данные ────────────────────────────────────
// Подчищаем только свои брошенные профили: свежие (возможно, идёт параллельный запуск) не трогаем.
function sweepOldTemp() {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^nox-commands-shot-/i.test(entry.name)) continue;
    const full = path.join(os.tmpdir(), entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs < 60000) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch { /* занят другим запуском — оставляем */ }
  }
}
sweepOldTemp();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-commands-shot-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });

// Настройки без голоса и фоновых запусков модели: первый запуск не должен ничего спрашивать.
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

// Временные команды «владельца». Схема v2: id, schemaVersion, name, phrases, optionalPhrases,
// steps[{tool,args}], enabled, createdAt, updatedAt, lastRunAt, hotkey, folder, collections, origin.
// Инструменты только из редакторского набора: app_open, ui_keys, wait, speak, volume_set.
function seededCommands() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const step = (tool, args) => ({ tool, args: args || {} });
  const base = (n) => ({ id: `cmd-shot-${String(n).padStart(2, '0')}`, schemaVersion: 2, createdAt: iso(30 * day), updatedAt: iso(2 * day) });
  return [
    {
      ...base(1), name: 'Кино', enabled: true,
      phrases: ['кино', 'включи кино'], optionalPhrases: ['включи', 'запусти'],
      steps: [step('volume_set', { percent: 30 }), step('app_open', { name: 'chrome' }), step('wait', { ms: 1200 }), step('ui_keys', { keys: 'f11', window: 'Chrome' })],
      lastRunAt: iso(3 * day), hotkey: null, folder: 'Медиа', collections: ['вечер'], origin: 'manual',
    },
    {
      ...base(2), name: 'Отбой', enabled: true,
      phrases: ['отбой', 'спокойной ночи'], optionalPhrases: ['включи'],
      steps: [step('volume_set', { percent: 5 }), step('speak', { text: 'Спокойной ночи' }), step('wait', { ms: 500 }), step('ui_keys', { keys: 'win+d' })],
      lastRunAt: iso(8 * day), hotkey: null, folder: 'Вечер', collections: ['вечер'], origin: 'recorded',
    },
    {
      ...base(3), name: 'Проверить почту', enabled: true,
      phrases: ['проверь почту', 'почта'], optionalPhrases: ['открой'],
      steps: [step('app_open', { name: 'chrome' }), step('wait', { ms: 1500 })],
      lastRunAt: iso(5 * 60 * 60 * 1000), hotkey: null, folder: 'Работа', collections: [], origin: 'manual',
    },
    {
      ...base(4), name: 'Рабочее утро', enabled: true,
      phrases: ['рабочее утро', 'начни работу', 'утро'], optionalPhrases: ['открой', 'запусти'],
      steps: [step('app_open', { name: 'code' }), step('app_open', { name: 'chrome' }), step('wait', { ms: 1500 }), step('speak', { text: 'Доброе утро' })],
      lastRunAt: iso(22 * 60 * 60 * 1000), hotkey: 'Ctrl+Alt+1', folder: 'Работа', collections: ['утро'], origin: 'manual',
    },
    {
      ...base(5), name: 'Созвон', enabled: true,
      phrases: ['созвон', 'начни созвон'], optionalPhrases: ['открой'],
      steps: [step('app_open', { name: 'zoom' }), step('wait', { ms: 1000 })],
      lastRunAt: null, hotkey: null, folder: 'Работа', collections: [], origin: 'ai',
    },
    {
      ...base(6), name: 'Тихий час', enabled: false,
      phrases: ['тихий час', 'не мешай'], optionalPhrases: [],
      steps: [step('volume_set', { percent: 10 }), step('ui_keys', { keys: 'win+d' })],
      lastRunAt: iso(12 * day), hotkey: null, folder: 'Вечер', collections: ['вечер'], origin: 'manual',
    },
    {
      ...base(7), name: 'Уборка', enabled: true,
      phrases: ['уборка', 'убери окна'], optionalPhrases: ['сверни'],
      steps: [step('ui_keys', { keys: 'win+d' }), step('wait', { ms: 300 })],
      lastRunAt: iso(6 * day), hotkey: null, folder: 'Порядок', collections: [], origin: 'recorded',
    },
    {
      ...base(8), name: 'Экран: только чат', enabled: true,
      phrases: ['режим только чат', 'только чат'], optionalPhrases: ['включи'],
      steps: [step('volume_set', { percent: 40 }), step('speak', { text: 'Включаю тихий режим' })],
      lastRunAt: null, hotkey: null, folder: 'Работа', collections: [], origin: 'manual',
    },
  ];
}

function writeCommandsFile(items) {
  fs.writeFileSync(path.join(dataDir, 'commands.json'), JSON.stringify({ items }, null, 2), 'utf8');
}

writeCommandsFile(seededCommands());

// Сессия, кэш и Chromium — во временном профиле, а не у владельца.
app.setPath('userData', profileDir);

// Пиксели 1:1 с CSS: сравнение с референсом не должно зависеть от масштаба экрана.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
// Скрытое/перекрытое окно не должно замирать: capturePage берёт кадр из отрисовки страницы.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Настройки владельца из окружения не используем.
for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}

// Корень данных — временная папка (та же подмена, что в scripts/check-app-startup.js и nox-shot.js).
require('../src/config/paths').projectRoot = () => tempRoot;

// Примерные сценарии при первом запуске не нужны: каталог должен содержать ровно временные команды.
// Подмена делается до require('../main'), поэтому main.js берёт уже подменённую функцию.
try {
  require('../src/commands/samples').seedSampleCommands = () => [];
} catch { /* если модуль переименуют, каталог просто окажется с примерами */ }

// Паки по просьбе (--install-packs): те же команды, что ставит канал packs:install, только заранее.
if (installPacks.length) {
  try {
    const { CommandStore } = require('../src/commands/store');
    const { seedPackCommands } = require('../src/commands/packs');
    const store = new CommandStore(path.join(dataDir, 'commands.json'));
    seedPackCommands(store, installPacks);
  } catch (err) {
    console.error(`nox-commands-shot: паки не поставлены: ${err && err.message ? err.message : err}`);
  }
}

// Файл для режима import. Формат обмена nox.commands собираем сами, чтобы не зависеть от импорта
// внутренних модулей до старта приложения.
function writeImportFile() {
  let existingNames = [];
  try {
    existingNames = JSON.parse(fs.readFileSync(path.join(dataDir, 'commands.json'), 'utf8')).items.map((c) => c.name);
  } catch { /* пусто */ }
  const nowIso = new Date().toISOString();
  const step = (tool, args) => ({ tool, args: args || {} });
  const commands = [
    {
      schemaVersion: 2, name: 'Пятничный отчёт', phrases: ['пятничный отчёт'], optionalPhrases: ['подготовь'],
      steps: [step('app_open', { name: 'excel' }), step('wait', { ms: 1000 }), step('speak', { text: 'Отчёт готов' })],
      enabled: true, hotkey: null, folder: 'Работа', collections: ['отчёты'], origin: 'imported',
    },
    {
      schemaVersion: 2, name: 'Встреча через час', phrases: ['напомни о встрече'], optionalPhrases: ['напомни'],
      steps: [step('speak', { text: 'Встреча через час' })],
      enabled: true, hotkey: null, folder: 'Работа', collections: [], origin: 'imported',
    },
  ];
  // Одна существующая команда — чтобы в предпросмотре показать строку «обновить».
  if (existingNames.includes('Созвон')) {
    commands.push({
      schemaVersion: 2, name: 'Созвон', phrases: ['созвон', 'начни созвон', 'видеозвонок'], optionalPhrases: ['открой', 'запусти'],
      steps: [step('app_open', { name: 'teams' }), step('wait', { ms: 1200 })],
      enabled: true, hotkey: null, folder: 'Работа', collections: [], origin: 'imported',
    });
  }
  const file = path.join(tempRoot, 'import-commands.json');
  fs.writeFileSync(file, JSON.stringify({
    format: 'nox.commands', version: 1, schemaVersion: 2, exportedAt: nowIso, commands,
  }, null, 2), 'utf8');
  return file;
}
const importFile = mode === 'import' ? writeImportFile() : '';

// Диалоги Windows в проверке не нужны и не должны перекрывать стол владельца. Методы подменяются
// до require('../main'), поэтому main.js получает тот же объект dialog с уже подменёнными методами.
// Это не имитация экрана: окно «Импорт» показывает настоящий предпросмотр настоящего файла.
try {
  dialog.showOpenDialog = async () => (importFile
    ? { canceled: false, filePaths: [importFile] }
    : { canceled: true, filePaths: [] });
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  dialog.showMessageBoxSync = () => 0;
  dialog.showErrorBox = () => {};
} catch (err) {
  console.error(`nox-commands-shot: диалоги не подменены: ${err && err.message ? err.message : err}`);
}

// Глобальные горячие клавиши в проверке не нужны и не должны занимать клавиши владельца.
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

let finished = false;
let mainWin = null;
let mainShell = 'legacy';
const consoleErrors = [];
const startedAt = Date.now();

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const payload = { ...result, shell: result.shell || mainShell, elapsedMs: Date.now() - startedAt };
  if (keepTemp) payload.tempRoot = tempRoot;
  const line = `NOX_CMD_SHOT_RESULT ${JSON.stringify(payload)}\n`;
  const exitCode = result && result.ok ? 0 : 1;
  // Строка результата должна дойти до родителя целиком: процесс завершаем после записи в stdout,
  // а не сразу после console.log (на Windows пайп иначе теряет хвост).
  let closed = false;
  const exit = () => {
    if (closed) return;
    closed = true;
    app.exit(exitCode);
  };
  try {
    process.stdout.write(line, () => setTimeout(exit, 30));
  } catch {
    exit();
    return;
  }
  setTimeout(exit, 2000).unref();
}

process.on('exit', () => {
  if (keepTemp) {
    console.error(`NOX_CMD_SHOT_TEMP ${tempRoot}`);
    return;
  }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  catch { console.error(`NOX_CMD_SHOT_TEMP_REMAINS ${tempRoot}`); }
});
process.on('uncaughtException', (err) => {
  finish({ ok: false, error: `uncaught: ${err && err.message ? err.message : err}` });
});

const deadline = setTimeout(() => {
  finish({
    ok: false,
    error: `timeout: за ${TIMEOUT_MS} мс окно не было снято (окно ${mainWin ? 'найдено' : 'не найдено'}, раздел ${lastView || 'неизвестен'})`,
  });
}, TIMEOUT_MS);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function js(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

async function waitFor(win, code, { timeout = 15000, interval = 120, label = 'условие' } = {}) {
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

// Шрифты и два кадра отрисовки: после этого текст не перескакивает.
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

// Пока раздел «Команды» не отрисовал строки каталога, снимать нечего. Карточки паков — необязательные:
// в новой разметке #cmdPacks — своя колонка, и её наполнение может прийти позже строк (или не прийти,
// если ядро не отдаёт паки). Ждём их отдельно и не роняем снимок.
const READY_COMMANDS_JS = `(() => {
  const view = document.querySelector('.view-commands');
  const list = document.querySelector('#cmdList');
  const rows = list ? list.querySelectorAll('.cmd-item').length : 0;
  if (!view || view.hidden) return false;
  if (document.body.dataset.view !== 'commands') return false;
  if (!rows) return false;
  const packs = document.querySelector('#cmdPacks');
  const cards = packs ? packs.querySelectorAll('.pack-card').length : 0;
  return { rows, cards: cards || 0, packsVisible: Boolean(packs && !packs.hidden) };
})()`;

const READY_PACKS_JS = `(() => {
  const packs = document.querySelector('#cmdPacks');
  if (!packs) return { present: false, cards: 0, visible: false };
  const cards = packs.querySelectorAll('.pack-card').length;
  return { present: true, cards, visible: !packs.hidden };
})()`;

async function openCommands(win) {
  if (mainShell === 'aether') return openCommandsAether(win);
  await waitFor(win, `Boolean(window.JarvisNox && typeof window.JarvisNox.show === 'function' && document.querySelector('#cmdList'))`, {
    timeout: 15000, label: 'window.JarvisNox и разметка команд',
  });
  await js(win, `(() => { window.JarvisNox.show('commands'); return document.body.dataset.view; })()`);
  const ready = await waitFor(win, READY_COMMANDS_JS, { timeout: 15000, label: 'строки каталога команд' });
  // Паки: до 4 с на появление карточек, но без отказа — у старой сборки их может не быть вовсе.
  const packs = await waitFor(win, `(() => {
    const info = ${READY_PACKS_JS};
    return info.present && (info.cards > 0 || !info.visible) ? info : false;
  })()`, { timeout: 4000, interval: 120, label: 'карточки паков' }).catch(() => null);
  return { ...ready, packs: packs || { present: false, cards: 0, visible: false } };
}

// ── Aether: раздел «Команды» ──────────────────────────────────────
// В Aether маршрут хранит store (window.__noxAether), разметка другая: #aeCommandsView,
// дерево .lx-tree-row, свойства .lx-cmd-inspector, паки .lx-cmd-pack-card.
async function openCommandsAether(win) {
  await waitFor(win, `Boolean(window.__noxAether && typeof window.__noxAether.setRoute === 'function' && document.querySelector('#aeCommandsView'))`, {
    timeout: 15000, label: 'мост Aether и разметка команд',
  });
  await js(win, `(() => { window.__noxAether.setRoute('commands'); return true; })()`);
  const ready = await waitFor(win, `(() => {
    const view = document.querySelector('#aeCommandsView');
    if (!view || view.hidden) return false;
    const rows = view.querySelectorAll('.lx-tree-row').length;
    if (!rows) return false;
    const toolbar = view.querySelectorAll('.lx-cmd-toolbar [id]').length;
    return { rows, toolbar, shell: 'aether', route: window.__noxAether.getRoute() };
  })()`, { timeout: 15000, label: 'строки каталога команд Aether' });
  return { ...ready, packs: { present: false, cards: 0, visible: false } };
}

// Действия режимов снимков в Aether. Каталог, редактор, новая команда и чат поддержаны;
// старого выбора действия, панели записи и импорта в Aether нет — честный пропуск.
async function applyModeAether(win) {
  if (mode === 'catalog') return { ok: true };
  if (mode === 'chat') {
    await js(win, `(() => { window.__noxAether.setRoute('chat'); return true; })()`);
    await waitFor(win, `Boolean(window.__noxAether.getRoute() === 'chat' && document.querySelector('#aeChatWorkspace') && !document.querySelector('#aeChatWorkspace').hidden)`, {
      timeout: 10000, label: 'чат Aether',
    });
    await sleep(600);
    return { ok: true };
  }
  if (mode === 'editor') {
    const opened = await openAetherInspector(win, commandName);
    await sleep(600);
    return opened;
  }
  if (mode === 'new') {
    const clicked = await js(win, `(() => {
      const btn = document.querySelector('#lxCmdTabNew');
      if (!btn) return { ok: false, error: 'нет кнопки #lxCmdTabNew' };
      btn.click();
      return { ok: true };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!clicked || !clicked.ok) return clicked || { ok: false, error: 'клик по #lxCmdTabNew не выполнен' };
    await waitFor(win, `Boolean(document.querySelector('.lx-new-shell'))`, { timeout: 10000, label: 'новая команда Aether' });
    await sleep(600);
    return { ok: true };
  }
  const names = { picker: 'выбор действия', record: 'запись действий', import: 'импорт команд' };
  return { ok: false, unsupported: true, error: 'режим «' + (names[mode] || mode) + '» в оболочке Aether не поддержан' };
}

// Открыть панель свойств команды в Aether: строка команды → действие «Редактировать команду».
async function openAetherInspector(win, wanted) {
  const clicked = await js(win, `(() => {
    const wanted = ${JSON.stringify(wanted || '')};
    const rows = Array.from(document.querySelectorAll('#aeCommandsView .lx-tree-row'));
    const isCommand = (row) => {
      const item = row.parentElement;
      const depth = Number.parseInt(item ? item.style.getPropertyValue('--depth') : '', 10) || 0;
      return depth === 2;
    };
    const labelOf = (row) => ((row.querySelector('.lx-tree-row-label') || {}).textContent || '').trim();
    const commands = rows.filter(isCommand);
    const row = wanted ? commands.find((item) => labelOf(item) === wanted) : commands[0];
    if (!row) return { ok: false, error: wanted ? 'команда «' + wanted + '» не найдена' : 'в каталоге нет команд', names: commands.map(labelOf) };
    row.click();
    return { ok: true, name: labelOf(row) };
  })()`).catch((err) => ({ ok: false, error: err.message }));
  if (!clicked || !clicked.ok) return clicked || { ok: false, error: 'клик по строке команды не выполнен' };
  await waitFor(win, `(() => {
    const rows = Array.from(document.querySelectorAll('#aeCommandsView .lx-tree-row.is-selected'));
    for (const row of rows) {
      const wrap = row.parentElement;
      const btn = Array.from(wrap ? wrap.querySelectorAll('.lx-tree-act-btn') : [])
        .find((item) => (item.getAttribute('aria-label') || '') === 'Редактировать команду');
      if (btn) { btn.click(); return { ok: true }; }
    }
    return false;
  })()`, { timeout: 8000, interval: 100, label: 'действие «Редактировать команду»' });
  await waitFor(win, `Boolean(document.querySelector('.lx-cmd-inspector') && document.querySelector('.lx-cmd-inspector').getBoundingClientRect().width > 0)`, {
    timeout: 10000, label: 'панель свойств команды Aether',
  });
  return { ok: true, name: clicked.name };
}

// Геометрия раздела «Команды» Aether — те же числа для сравнения кадров, что и в старой оболочке.
async function readGeometryAether(win, extra) {
  return js(win, `(() => {
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), hidden: el.hidden === true, display: cs.display, visibility: cs.visibility, position: cs.position };
    };
    const rectSel = (sel) => rectOf(document.querySelector(sel));
    const rowInfo = (row) => {
      const item = row.parentElement;
      const depth = Number.parseInt(item ? item.style.getPropertyValue('--depth') : '', 10) || 0;
      return { depth, label: ((row.querySelector('.lx-tree-row-label') || {}).textContent || '').trim(), meta: ((row.querySelector('.lx-tree-row-meta') || {}).textContent || '').trim(), selected: row.classList.contains('is-selected') };
    };
    const elements = {};
    for (const sel of ['#aeCommandsView', '.lx-cmd-toolbar', '.lx-cmd-tree-scroll', '.lx-cmd-workspace', '.lx-cmd-inspector', '#lxCmdSave', '.ae-nav', '#aeMain', '#aeAppRoot']) elements[sel] = rectSel(sel);
    const rows = Array.from(document.querySelectorAll('#aeCommandsView .lx-tree-row')).map(rowInfo);
    const treeScroll = document.querySelector('#aeCommandsView .lx-cmd-tree-scroll');
    return {
      inner: [innerWidth, innerHeight],
      dpr: window.devicePixelRatio || 1,
      shell: 'aether',
      view: window.__noxAether && window.__noxAether.getRoute ? window.__noxAether.getRoute() : '',
      title: document.title,
      scroll: { document: { top: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), client: Math.round(document.documentElement.clientHeight) } },
      elements,
      cmdList: { count: rows.length, rows, totalHeight: treeScroll ? Math.round(treeScroll.getBoundingClientRect().height) : 0 },
      packs: { cards: document.querySelectorAll('#aeCommandsView .lx-cmd-pack-card').length },
      editor: { open: Boolean(document.querySelector('.lx-cmd-inspector')) },
      modal: { pickerOpen: false, importOpen: false },
      recording: { panelOpen: false },
      mode: ${JSON.stringify(mode)},
      extra: ${JSON.stringify(extra || {})},
    };
  })()`);
}

// Действие выбранного режима. Возвращает {ok, name?, error?} — ошибки не глотаем.
// Открыть редактор кликом по строке каталога (первой или по имени из --command).
// Класс .commands.is-editing может исчезнуть в новой разметке, поэтому ждём сам #cmdEditor.
async function openEditorRow(win) {
  const clicked = await js(win, `(() => {
    const wanted = ${JSON.stringify(commandName)};
    const buttons = Array.from(document.querySelectorAll('#cmdList .cmd-name'));
    const btn = wanted ? buttons.find((b) => b.textContent.trim() === wanted) : buttons[0];
    if (!btn) return { ok: false, error: wanted ? 'команда «' + wanted + '» не найдена в каталоге' : 'строк .cmd-name нет' };
    btn.click();
    return { ok: true, name: btn.textContent.trim() };
  })()`).catch((err) => ({ ok: false, error: err.message }));
  if (!clicked || !clicked.ok) return clicked || { ok: false, error: 'клик по .cmd-name не выполнен' };
  await waitFor(win, `Boolean(document.querySelector('#cmdEditor') && !document.querySelector('#cmdEditor').hidden && document.querySelector('#cmdName') && document.querySelector('#cmdName').value.trim())`, {
    timeout: 10000, label: 'редактор команды открылся',
  });
  // Каталог действий приходит из ядра отдельным запросом: ждём, пока в шагах появятся варианты.
  const catalog = await waitFor(win, `document.querySelectorAll('#cmdSteps select option').length > 5`, {
    timeout: 8000, interval: 100, label: 'каталог инструментов в шагах',
  }).then(() => true).catch(() => false);
  await sleep(600);
  return { ok: true, name: clicked.name, catalogLoaded: catalog };
}

// Действие выбранного режима. Возвращает {ok, name?, error?} — ошибки не глотаем.
async function applyMode(win) {
  if (mainShell === 'aether') return applyModeAether(win);
  if (mode === 'catalog') return { ok: true };
  if (mode === 'chat') {
    // Проверка целостности чата после «Команд»: показываем экран Nox и ждём его сетку.
    await js(win, `(() => { window.JarvisNox.show('nox'); return true; })()`);
    await waitFor(win, `Boolean(document.body.dataset.view === 'nox' && document.querySelector('.nox-grid') && !document.querySelector('.view-nox').hidden && document.querySelector('#noxChat'))`, {
      timeout: 10000, label: 'экран Nox с .nox-grid',
    });
    await sleep(600);
    return { ok: true };
  }
  if (mode === 'editor' || mode === 'picker') {
    const opened = await openEditorRow(win);
    if (!opened.ok || mode === 'editor') return opened;
    // Режим picker: «Добавить действие» открывает диалог выбора действия #cmdActionDialog.
    const clicked = await js(win, `(() => {
      const btn = document.querySelector('#cmdStepAdd');
      if (!btn) return { ok: false, error: 'кнопки «Добавить действие» (#cmdStepAdd) нет' };
      if (btn.disabled) return { ok: false, error: 'кнопка #cmdStepAdd недоступна' };
      btn.click();
      return { ok: true };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!clicked || !clicked.ok) return clicked || { ok: false, error: 'клик по #cmdStepAdd не выполнен' };
    await waitFor(win, `(() => {
      const dlg = document.querySelector('#cmdActionDialog');
      if (!dlg) return false;
      const r = dlg.getBoundingClientRect();
      return (dlg.open === true || dlg.hasAttribute('open')) && r.width > 0 && r.height > 0;
    })()`, { timeout: 10000, interval: 120, label: 'диалог выбора действия (#cmdActionDialog)' });
    await sleep(600);
    return { ok: true, name: opened.name, catalogLoaded: opened.catalogLoaded, pickerOpen: true };
  }
  if (mode === 'new') {
    const clicked = await js(win, `(() => {
      const btn = document.querySelector('#cmdNew');
      if (!btn) return { ok: false, error: 'кнопки «Новая» нет' };
      if (btn.disabled) return { ok: false, error: 'кнопка «Новая» недоступна: ядро не умеет сохранять команды' };
      btn.click();
      return { ok: true };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!clicked || !clicked.ok) return clicked || { ok: false, error: 'клик по «Новая» не выполнен' };
    await waitFor(win, `Boolean(document.querySelector('#cmdEditor') && !document.querySelector('#cmdEditor').hidden && document.querySelector('#cmdName') && document.querySelector('#cmdName').value === '')`, {
      timeout: 10000, label: 'редактор нового черновика',
    });
    await sleep(600);
    return { ok: true };
  }
  if (mode === 'record') {
    const clicked = await js(win, `(() => {
      const btn = document.querySelector('#cmdRecord');
      if (!btn) return { ok: false, error: 'кнопки «Записать» нет' };
      btn.click();
      return { ok: true };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!clicked || !clicked.ok) return clicked || { ok: false, error: 'клик по «Записать» не выполнен' };
    await waitFor(win, `Boolean(document.querySelector('#cmdRecordPanel') && !document.querySelector('#cmdRecordPanel').hidden)`, {
      timeout: 10000, label: 'панель записи действий',
    });
    await sleep(600);
    return { ok: true };
  }
  if (mode === 'import') {
    const clicked = await js(win, `(() => {
      const btn = document.querySelector('#cmdImport');
      if (!btn) return { ok: false, error: 'кнопки «Импорт» нет' };
      btn.click();
      return { ok: true };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!clicked || !clicked.ok) return clicked || { ok: false, error: 'клик по «Импорт» не выполнен' };
    await waitFor(win, `Boolean(document.querySelector('#cmdImportDialog') && document.querySelector('#cmdImportDialog').open)`, {
      timeout: 10000, label: 'диалог предпросмотра импорта',
    });
    await sleep(600);
    return { ok: true };
  }
  return { ok: false, error: `неизвестный режим ${mode}` };
}
// Полная геометрия для сравнения «до/после». Только числа, строки и простые объекты.
async function readGeometry(win, extra) {
  if (mainShell === 'aether') return readGeometryAether(win, extra);
  return js(win, `(() => {
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        hidden: el.hidden === true, display: cs.display, visibility: cs.visibility, position: cs.position,
      };
    };
    const rectEl = (sel) => rectOf(document.querySelector(sel));
    const scrollOf = (el) => el ? { top: Math.round(el.scrollTop), height: Math.round(el.scrollHeight), client: Math.round(el.clientHeight) } : null;
    const els = {};
    const selectors = [
      '.app', '.rail', '.rail-item[data-nav="commands"]', '.topbar', '.main', '.views',
      '.view-commands', '#commands', '#cmdLists', '.cmd-toolbar', '#panelMine', '#cmdList',
      '#cmdPacks', '#cmdPacks .pack-grid', '#cmdPacks .pack-card', '#cmdEditor', '#cmdEditor .editor-main',
      '#cmdEditor .editor-foot', '#cmdEditorTitle', '#cmdName', '#cmdPhrases', '#cmdSteps', '#cmdRunResult',
      '#cmdRun', '#cmdSave', '#cmdDelete', '#cmdNew', '#cmdImport', '#cmdExport', '#cmdRecord',
      '#cmdRecordPanel', '#cmdImportDialog', '#toasts',
      // Новая разметка «Команд» (nox-commands.css / nox-commands.js).
      '#cmdCatalog', '.nox-cmd-head', '.nox-cmd-toolbar', '.nox-cmd-body', '.nox-cmd-list',
      '#cmdList .cmd-item:first-child', '.nox-packs', '#cmdPacksList', '.nox-tabs', '.nox-cmd-tools',
      '.nox-editor-main', '.nox-editor-side', '.nox-editor-foot', '.nox-editor-head',
      '#cmdBack', '#cmdSideSub', '#cmdSideReady', '#cmdLoading',
      '#cmdActionDialog', '.nox-picker', '#npList', '#npCats',
      // Экран Nox (режим chat): доказательство, что чат цел после «Команд».
      '.view-nox', '.nox-grid', '#noxHistory', '#noxChat', '#noxSphere', '#feed', '#composer', '#chatInput', '#noxComposerSlot',
    ];
    for (const sel of selectors) els[sel] = rectEl(sel);

    const rows = Array.from(document.querySelectorAll('#cmdList .cmd-item')).map((li, i) => {
      const nameEl = li.querySelector('.cmd-name');
      const sw = li.querySelector('.switch');
      return {
        i,
        name: nameEl ? nameEl.textContent.trim() : '',
        enabled: sw ? sw.checked : !li.classList.contains('is-off'),
        off: li.classList.contains('is-off'),
        selected: li.classList.contains('is-selected'),
        open: li.classList.contains('is-open'),
        rect: rectOf(li),
      };
    });
    const cards = Array.from(document.querySelectorAll('#cmdPacks .pack-card')).map((card, i) => ({
      i, id: card.dataset.pack || '', state: card.dataset.state || 'default', rect: rectOf(card),
    }));
    const current = document.querySelector('[data-nav][aria-current="page"]');
    return {
      inner: [innerWidth, innerHeight],
      dpr: window.devicePixelRatio || 1,
      view: document.body.dataset.view,
      title: document.title,
      crumb: (document.querySelector('#viewTitle') || {}).textContent || '',
      railCurrent: current ? current.dataset.nav : null,
      scroll: {
        viewCommands: scrollOf(document.querySelector('.view-commands')),
        document: { top: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), client: Math.round(document.documentElement.clientHeight) },
      },
      elements: els,
      cmdList: {
        count: rows.length,
        counterText: (document.querySelector('#cmdCount') || {}).textContent || '',
        rows,
        totalHeight: Math.round(document.querySelector('#cmdList') ? document.querySelector('#cmdList').getBoundingClientRect().height : 0),
      },
      packs: {
        cards: cards.length,
        first: cards[0] || null,
        last: cards[cards.length - 1] || null,
        consts: cards.map((c) => c.id),
      },
      editor: {
        // Новая разметка не обязана ставить .commands.is-editing: признак открытия — сам #cmdEditor.
        open: Boolean(document.querySelector('#cmdEditor') && !document.querySelector('#cmdEditor').hidden),
        isEditingClass: Boolean(document.querySelector('#commands') && document.querySelector('#commands').classList.contains('is-editing')),
        title: (document.querySelector('#cmdEditorTitle') || {}).textContent || '',
        nameValue: (document.querySelector('#cmdName') || {}).value || '',
        phrases: document.querySelectorAll('#cmdPhrases .chip').length,
        steps: document.querySelectorAll('#cmdSteps .cmd-step').length,
        stepOptions: document.querySelectorAll('#cmdSteps select option').length,
        runDisabled: Boolean(document.querySelector('#cmdRun') && document.querySelector('#cmdRun').disabled),
        saveDisabled: Boolean(document.querySelector('#cmdSave') && document.querySelector('#cmdSave').disabled),
        deleteHidden: Boolean(document.querySelector('#cmdDelete') && document.querySelector('#cmdDelete').hidden),
        dirty: !Boolean(document.querySelector('#cmdDirty') && document.querySelector('#cmdDirty').hidden),
        sideSub: (document.querySelector('#cmdSideSub') || {}).textContent || '',
        sideReady: document.querySelectorAll('#cmdSideReady li').length,
        backVisible: Boolean(document.querySelector('#cmdBack') && document.querySelector('#cmdBack').getBoundingClientRect().width > 0),
      },
      modal: {
        importOpen: Boolean(document.querySelector('#cmdImportDialog') && document.querySelector('#cmdImportDialog').open),
        importCount: (document.querySelector('#ciCount') || {}).textContent || '',
        importSummary: (document.querySelector('#ciSummary') || {}).textContent || '',
        importItems: document.querySelectorAll('#cmdImportDialog .imp-item').length,
        pickerOpen: Boolean(document.querySelector('#cmdActionDialog') && (document.querySelector('#cmdActionDialog').open || document.querySelector('#cmdActionDialog').hasAttribute('open'))),
        pickerCats: document.querySelectorAll('#npCats [role="tab"], #npCats button').length,
        pickerItems: document.querySelectorAll('#npList [role="option"], #npList li, #npList button').length,
      },
      recording: {
        panelOpen: Boolean(document.querySelector('#cmdRecordPanel') && !document.querySelector('#cmdRecordPanel').hidden),
        steps: document.querySelectorAll('#cmdRecordSteps .cmd-step').length,
      },
      toasts: document.querySelectorAll('#toasts .toast').length,
      mode: ${JSON.stringify(mode)},
      extra: ${JSON.stringify(extra || {})},
    };
  })()`);
}

// Проверка, что это настоящий PNG, и его размеры из IHDR.
function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buf.subarray(0, 8).equals(sig)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

// ── QA: сценарий по настоящему DOM ───────────────────────────────
// Ниже две функции целиком уезжают в окно через toString(): они не должны ссылаться на Node.
// Первая — проверки 1–12, вторая — проверка 864x520 (её вызывает главный процесс после resize).
// Внутри используются только window.jarvis (настоящий мост) и DOM.

async function qaPhase1Page() {
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, timeout, step) => {
    const end = Date.now() + (timeout || 8000);
    let lastError = null;
    while (Date.now() < end) {
      try { const value = await fn(); if (value) return value; } catch (err) { lastError = err; }
      await sleep(step || 100);
    }
    throw new Error('не дождались: ' + (lastError && lastError.message ? lastError.message : 'условие'));
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const bridge = (name, ...args) => window.jarvis[name](...args);
  const list = () => bridge('listCommands');
  const rowByName = (name) => qa('#cmdList .cmd-item').find((li) => {
    const n = li.querySelector('.cmd-name');
    return Boolean(n) && n.textContent.trim() === name;
  });
  const reload = async () => {
    window.JarvisNox.show('commands');
    await until(() => document.body.dataset.view === 'commands' && qa('#cmdList .cmd-item').length > 0, 8000);
    await sleep(250);
  };
  // Закрыть редактор, согласившись с возможным вопросом о несохранённых изменениях.
  const closeEditorYes = async () => {
    if (!visible(q('#cmdEditor'))) return;
    const back = q('#cmdBack');
    if (!back) throw new Error('нет кнопки #cmdBack');
    back.click();
    await until(() => !visible(q('#cmdEditor')) || (q('#confirmDialog') && q('#confirmDialog').open), 5000);
    const dlg = q('#confirmDialog');
    if (dlg && dlg.open) q('#cfYes').click();
    await until(() => !visible(q('#cmdEditor')), 8000);
  };

  const checks = [];
  const check = async (name, fn) => {
    try {
      const r = await fn();
      checks.push({ name, ok: Boolean(r && r.ok), detail: (r && r.detail) || '' });
    } catch (err) {
      checks.push({ name, ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
    }
  };

  const cmds0 = await list();
  const firstName = cmds0.length ? cmds0[0].name : '';

  await check('1. Каталог: #cmdCatalog виден, строк = ядру, счётчик, паки', async () => {
    const cmds = await list();
    const rows = qa('#cmdList .cmd-item');
    const countText = ((q('#cmdCount') || {}).textContent || '').trim();
    const cards = qa('#cmdPacks .pack-card').length;
    const catalogVisible = visible(q('#cmdCatalog'));
    const ok = catalogVisible && rows.length === cmds.length && countText === String(cmds.length) && cards >= 1;
    return { ok, detail: 'виден=' + catalogVisible + ' строк=' + rows.length + ' ядро=' + cmds.length + ' счётчик="' + countText + '" паков=' + cards };
  });

  await check('2. Поиск: строки сузились, совпадение по имени/чипам/мете, сброс', async () => {
    const cmds = await list();
    const needle = (cmds[0] && cmds[0].name) || firstName;
    const before = qa('#cmdList .cmd-item').length;
    const input = q('#cmdSearch');
    if (!input) return { ok: false, detail: 'нет поля #cmdSearch' };
    input.value = needle;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    const rows = qa('#cmdList .cmd-item');
    const lower = needle.toLowerCase();
    const texts = rows.map((li) => li.textContent.toLowerCase());
    const every = texts.length > 0 && texts.every((t) => t.includes(lower));
    const decreased = rows.length < before || before <= 1;
    const reset = q('#cmdResetSearch');
    if (!reset) return { ok: false, detail: 'нет кнопки #cmdResetSearch' };
    reset.click();
    await sleep(150);
    const restored = qa('#cmdList .cmd-item').length === before;
    const ok = decreased && every && restored;
    return { ok, detail: 'до=' + before + ' после=' + rows.length + ' сузились=' + decreased + ' все совпали=' + every + ' сброс=' + restored };
  });

  await check('3. Вкладки: Библиотека и обратно, поля поиска', async () => {
    const tabLib = q('#tabLib');
    const tabMine = q('#tabMine');
    if (!tabLib || !tabMine) return { ok: false, detail: 'нет вкладок #tabLib/#tabMine' };
    tabLib.click();
    await sleep(200);
    const libPanel = visible(q('#panelLib'));
    const libSearch = visible(q('#libSearchWrap'));
    const libSel = tabLib.getAttribute('aria-selected') === 'true';
    const mineSearchHidden = !visible(q('#cmdSearchWrap'));
    tabMine.click();
    await sleep(200);
    const minePanel = visible(q('#panelMine'));
    const mineSearch = visible(q('#cmdSearchWrap'));
    const libHidden = !visible(q('#libSearchWrap'));
    const mineSel = tabMine.getAttribute('aria-selected') === 'true';
    const ok = libPanel && libSearch && libSel && mineSearchHidden && minePanel && mineSearch && libHidden && mineSel;
    return { ok, detail: 'libPanel=' + libPanel + ' libSearch=' + libSearch + ' libSel=' + libSel + ' mineSearch=' + mineSearch + ' minePanel=' + minePanel + ' libHidden=' + libHidden };
  });

  await check('4. Раскрытие строки: .cmd-steps-preview со шагами и обратно', async () => {
    const toggle = q('#cmdList .cmd-toggle');
    if (!toggle) return { ok: false, detail: 'нет .cmd-toggle' };
    toggle.click();
    await sleep(200);
    const preview = q('.cmd-steps-preview');
    const steps = preview ? preview.querySelectorAll('.cmd-step').length : 0;
    const opened = Boolean(preview && steps >= 1);
    const toggle2 = q('#cmdList .cmd-toggle');
    if (toggle2) toggle2.click();
    await sleep(200);
    const closed = !q('.cmd-steps-preview');
    const ok = opened && closed;
    return { ok, detail: 'превью=' + Boolean(preview) + ' шагов=' + steps + ' закрылось=' + closed };
  });

  await check('5. Переключатель: сохранение включённости через ядро и возврат', async () => {
    const cmds = await list();
    const target = cmds[0];
    if (!target) return { ok: false, detail: 'в ядре нет команд' };
    const before = target.enabled !== false;
    const row = rowByName(target.name);
    const sw = row && row.querySelector('.switch');
    if (!sw) return { ok: false, detail: 'нет .switch у первой строки' };
    sw.click();
    await until(async () => {
      const now = (await list()).find((c) => c.name === target.name);
      return now && (now.enabled !== false) === !before;
    }, 8000);
    await sleep(200);
    const row2 = rowByName(target.name);
    const sw2 = row2 && row2.querySelector('.switch');
    if (sw2) sw2.click();
    await until(async () => {
      const now = (await list()).find((c) => c.name === target.name);
      return now && (now.enabled !== false) === before;
    }, 8000);
    return { ok: true, detail: 'было=' + before + ' переключили и вернули' };
  });

  await check('6. Редактор: открывается по .cmd-name, имя и «Результат проверки»', async () => {
    const cmds = await list();
    const target = cmds[0];
    const row = rowByName(target.name);
    const nameBtn = row && row.querySelector('.cmd-name');
    if (!nameBtn) return { ok: false, detail: 'нет .cmd-name у первой строки' };
    nameBtn.click();
    await until(() => visible(q('#cmdEditor')), 8000);
    await until(() => q('#cmdName') && q('#cmdName').value.trim() === target.name, 8000);
    const steps = Array.isArray(target.steps) ? target.steps.length : 0;
    const sideRows = qa('#cmdSideReady > li').length;
    await until(() => qa('#cmdSideReady > li').length === (steps || 1), 8000);
    const ok = visible(q('#cmdEditor')) && q('#cmdName').value.trim() === target.name && sideRows === (steps || 1);
    return { ok, detail: 'имя="' + q('#cmdName').value.trim() + '" шагов=' + steps + ' строк результата=' + qa('#cmdSideReady > li').length };
  });

  await check('7. Защита несохранённого: #confirmDialog, Отмена и Выйти', async () => {
    const cmds = await list();
    const original = cmds[0].name;
    const input = q('#cmdName');
    input.value = original + ' QA';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    q('#cmdBack').click();
    await until(() => q('#confirmDialog') && q('#confirmDialog').open, 5000);
    const dialogOpen = Boolean(q('#confirmDialog') && q('#confirmDialog').open);
    q('#cfNo').click();
    await until(() => !(q('#confirmDialog') && q('#confirmDialog').open), 5000);
    const editorStillOpen = visible(q('#cmdEditor'));
    q('#cmdBack').click();
    await until(() => q('#confirmDialog') && q('#confirmDialog').open, 5000);
    q('#cfYes').click();
    await until(() => !visible(q('#cmdEditor')), 8000);
    const after = await list();
    const unchanged = after.some((c) => c.name === original) && !after.some((c) => c.name === original + ' QA');
    const ok = dialogOpen && editorStillOpen && unchanged;
    return { ok, detail: 'диалог=' + dialogOpen + ' остались в редакторе=' + editorStillOpen + ' имя в ядре не изменилось=' + unchanged };
  });

  await check('8. Сохранение: новое имя в ядре, затем возврат имени', async () => {
    const cmds = await list();
    const original = cmds[0].name;
    const newName = original + ' QA';
    await reload();
    const row = rowByName(original);
    const nameBtn = row && row.querySelector('.cmd-name');
    if (!nameBtn) return { ok: false, detail: 'нет строки «' + original + '»' };
    nameBtn.click();
    await until(() => visible(q('#cmdEditor')), 8000);
    const input = q('#cmdName');
    input.value = newName;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    q('#cmdSave').click();
    let saved = null;
    try {
      saved = await until(async () => {
        const found = (await list()).find((c) => c.name === newName);
        if (found) return found;
        const box = q('#cmdError');
        if (box && !box.hidden && (box.textContent || '').trim()) return { __error: (box.textContent || '').trim() };
        return null;
      }, 12000);
    } catch (err) {
      const arr = await list();
      const box = q('#cmdError');
      const toastText = qa('#toasts .toast').map((t) => (t.textContent || '').trim()).join(' | ');
      return {
        ok: false,
        detail: 'сохранение не подтвердилось: имена в ядре=' + arr.map((c) => c.name).join(', ')
          + '; #cmdError=' + (box && !box.hidden ? (box.textContent || '').trim() : 'скрыт')
          + '; toast=' + (toastText || 'нет'),
      };
    }
    if (saved && saved.__error) {
      await reload().catch(() => null);
      return { ok: false, detail: 'ошибка сохранения: ' + saved.__error };
    }
    const errorBox = q('#cmdError');
    const noError = !errorBox || errorBox.hidden || !(errorBox.textContent || '').trim();
    // Возврат исходного имени: тем же id, через настоящее ядро.
    await bridge('saveCommand', Object.assign({}, saved, { name: original }));
    await until(async () => {
      const arr = await list();
      return arr.some((c) => c.name === original) && !arr.some((c) => c.name === newName);
    }, 8000);
    await reload();
    const ok = Boolean(saved) && noError;
    return { ok, detail: 'новое имя в ядре=' + Boolean(saved) + ' ошибки нет=' + noError };
  });

  await check('9. Выбор действия: #cmdActionDialog, добавление и удаление шага', async () => {
    await reload();
    await closeEditorYes();
    const cmds = await list();
    const target = cmds[0];
    const row = rowByName(target.name);
    const nameBtn = row && row.querySelector('.cmd-name');
    if (!nameBtn) return { ok: false, detail: 'нет строки «' + target.name + '»' };
    nameBtn.click();
    await until(() => visible(q('#cmdEditor')), 8000);
    await sleep(200);
    const stepsBefore = qa('#cmdSteps .step').length;
    q('#cmdStepAdd').click();
    await until(() => {
      const dlg = q('#cmdActionDialog');
      return Boolean(dlg && dlg.open && qa('#npCats button').length > 0 && qa('#npList .nox-picker-item').length > 0);
    }, 8000);
    const cats = qa('#npCats button').length;
    const items = qa('#npList .nox-picker-item').length;
    q('#npList .nox-picker-item').click();
    await sleep(150);
    const add = q('#npAdd');
    const addEnabled = Boolean(add && !add.disabled);
    add.click();
    await until(() => !(q('#cmdActionDialog') && q('#cmdActionDialog').open), 5000);
    await until(() => qa('#cmdSteps .step').length === stepsBefore + 1, 5000);
    const added = qa('#cmdSteps .step').length === stepsBefore + 1;
    const delButtons = qa('[aria-label^="Удалить шаг"]');
    const lastDelete = delButtons[delButtons.length - 1];
    const removed = Boolean(lastDelete);
    if (lastDelete) lastDelete.click();
    await sleep(250);
    const backTo = qa('#cmdSteps .step').length === stepsBefore;
    const ok = cats > 0 && items > 0 && addEnabled && added && removed && backTo;
    return { ok, detail: 'категорий=' + cats + ' действий=' + items + ' #npAdd=' + addEnabled + ' шагов было=' + stepsBefore + ' добавили=' + added + ' удалили=' + backTo };
  });

  await check('10. Безопасный запуск: «QA пауза» через .cmd-run, lastRunAt, удаление', async () => {
    await closeEditorYes();
    await reload();
    const QA_NAME = 'QA пауза';
    let created = null;
    let saveReply = null;
    try {
      saveReply = await bridge('saveCommand', {
        name: QA_NAME,
        phrases: ['qa пауза'],
        steps: [{ tool: 'wait', args: { ms: 50 } }],
        enabled: true,
        origin: 'manual',
      });
      created = saveReply && saveReply.command ? saveReply.command : null;
    } catch (err) {
      return { ok: false, detail: 'saveCommand бросил: ' + String(err && err.message ? err.message : err) };
    }
    if (!created || !created.id) {
      return { ok: false, detail: 'ядро не создало временную команду: ' + JSON.stringify(saveReply).slice(0, 400) };
    }
    await reload();
    const row = await until(() => rowByName(QA_NAME), 8000);
    const runBtn = row.querySelector('.cmd-run');
    if (!runBtn) return { ok: false, detail: 'нет .cmd-run у «' + QA_NAME + '»' };
    runBtn.click();
    let finished = null;
    try {
      finished = await until(async () => {
        const c = (await list()).find((x) => x.id === created.id);
        return c && c.lastRunAt ? c : null;
      }, 15000);
    } catch (err) {
      // Допускаем вариант, когда ядро не ставит lastRunAt, но показывает toast с итогом.
      const toast = q('#toasts .toast');
      if (!toast) throw err;
      finished = { lastRunAt: null, enabled: true };
    }
    const errorBox = q('#cmdError');
    const noError = !errorBox || errorBox.hidden || !(errorBox.textContent || '').trim();
    const stillEnabled = finished.enabled !== false;
    await bridge('deleteCommand', created.id);
    await until(async () => !(await list()).some((x) => x.id === created.id), 8000);
    await reload();
    const ok = Boolean(finished) && noError && stillEnabled;
    return { ok, detail: 'lastRunAt=' + Boolean(finished && finished.lastRunAt) + ' ошибки нет=' + noError + ' включена=' + stillEnabled };
  });

  await check('11. Запись: панель и #commands.is-recording, отмена', async () => {
    const btn = q('#cmdRecord');
    if (!btn) return { ok: false, detail: 'нет кнопки #cmdRecord' };
    btn.click();
    await until(() => {
      const panel = q('#cmdRecordPanel');
      const root = q('#commands');
      return Boolean(panel && !panel.hidden && root && root.classList.contains('is-recording'));
    }, 8000);
    const shown = visible(q('#cmdRecordPanel')) && q('#commands').classList.contains('is-recording');
    const cancel = q('#cmdRecordCancel');
    if (!cancel) return { ok: false, detail: 'нет кнопки отмены записи' };
    cancel.click();
    await until(() => {
      const panel = q('#cmdRecordPanel');
      const root = q('#commands');
      return Boolean(panel && panel.hidden && root && !root.classList.contains('is-recording'));
    }, 8000);
    const hidden = !visible(q('#cmdRecordPanel')) && !q('#commands').classList.contains('is-recording');
    const ok = shown && hidden;
    return { ok, detail: 'показана=' + shown + ' убрана=' + hidden };
  });

  await check('12. Чат цел: .nox-grid, #noxChat, #feed, #composer и возврат', async () => {
    window.JarvisNox.show('nox');
    await until(() => document.body.dataset.view === 'nox' && visible(q('.nox-grid')), 8000);
    const grid = visible(q('.nox-grid'));
    const noxChat = visible(q('#noxChat'));
    const feed = Boolean(q('#feed'));
    const composer = Boolean(q('#composer'));
    window.JarvisNox.show('commands');
    await until(() => document.body.dataset.view === 'commands' && visible(q('#cmdCatalog')) && qa('#cmdList .cmd-item').length > 0, 8000);
    const catalogBack = visible(q('#cmdCatalog'));
    const ok = grid && noxChat && feed && composer && catalogBack;
    return { ok, detail: '.nox-grid=' + grid + ' #noxChat=' + noxChat + ' #feed=' + feed + ' #composer=' + composer + ' каталог вернулся=' + catalogBack };
  });

  return { checks, firstName };
}

async function qaPhase13Page() {
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, timeout, step) => {
    const end = Date.now() + (timeout || 8000);
    while (Date.now() < end) {
      try { const value = await fn(); if (value) return value; } catch (err) { /* ждём */ }
      await sleep(step || 100);
    }
    throw new Error('не дождались условия 864x520');
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const rowByName = (name) => qa('#cmdList .cmd-item').find((li) => {
    const n = li.querySelector('.cmd-name');
    return Boolean(n) && n.textContent.trim() === name;
  });
  const reload = async () => {
    window.JarvisNox.show('commands');
    await until(() => document.body.dataset.view === 'commands' && qa('#cmdList .cmd-item').length > 0, 8000);
    await sleep(250);
  };
  const closeEditorYes = async () => {
    if (!visible(q('#cmdEditor'))) return;
    q('#cmdBack').click();
    await until(() => !visible(q('#cmdEditor')) || (q('#confirmDialog') && q('#confirmDialog').open), 5000);
    const dlg = q('#confirmDialog');
    if (dlg && dlg.open) q('#cfYes').click();
    await until(() => !visible(q('#cmdEditor')), 8000);
  };

  const checks = [];
  const check = async (name, fn) => {
    try {
      const r = await fn();
      checks.push({ name, ok: Boolean(r && r.ok), detail: (r && r.detail) || '' });
    } catch (err) {
      checks.push({ name, ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
    }
  };

  await closeEditorYes();
  await reload();
  const cmds = await window.jarvis.listCommands();
  const firstName = cmds.length ? cmds[0].name : '';
  const innerW = innerWidth;
  const innerH = innerHeight;

  await check('13a. 864x520: нет горизонтального переполнения каталога', async () => {
    const scrollWidth = document.documentElement.scrollWidth;
    const docOk = scrollWidth <= innerW + 1;
    const samples = ['.nox-cmd-toolbar', '#cmdList', '#cmdPacks'].map((sel) => {
      const el = q(sel);
      if (!el) return { sel, rect: null };
      const r = el.getBoundingClientRect();
      return { sel, rect: { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width) } };
    });
    const noOverflow = samples.every((s) => !s.rect || s.rect.right <= innerW + 1);
    const ok = docOk && noOverflow;
    return { ok, detail: 'inner=' + innerW + 'x' + innerH + ' scrollWidth=' + scrollWidth + ' образцы=' + JSON.stringify(samples) };
  });

  await check('13b. 864x520: кнопки нижней панели редактора внутри окна', async () => {
    const row = rowByName(firstName);
    const nameBtn = row && row.querySelector('.cmd-name');
    if (!nameBtn) return { ok: false, detail: 'нет строки «' + firstName + '»' };
    nameBtn.click();
    await until(() => visible(q('#cmdEditor')), 8000);
    await sleep(300);
    const buttons = qa('#cmdEditor .nox-editor-foot button').map((b) => {
      const r = b.getBoundingClientRect();
      return { text: (b.textContent || '').trim().slice(0, 24), x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
    });
    const visibleButtons = buttons.filter((b) => b.visible);
    const allInside = visibleButtons.length > 0 && visibleButtons.every((b) => b.x >= -1 && b.right <= innerW + 1);
    const scrollWidth = document.documentElement.scrollWidth;
    const docOk = scrollWidth <= innerW + 1;
    const ok = allInside && docOk;
    return { ok, detail: 'innerW=' + innerW + ' scrollWidth=' + scrollWidth + ' кнопки=' + JSON.stringify(buttons) };
  });

  await closeEditorYes();
  return { checks };
}

// ── QA раздела «Команды» в Aether: 15 живых проверок по настоящему DOM ─────────
// Две функции целиком уезжают в окно через toString(): только window.jarvis, window.__noxAether и DOM.
// Первая — проверки 1–13 при запрошенном размере, вторая — 14 при 864x520; 15 — консоль (главный процесс).

async function qaAetherPhase1Page() {
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, timeout, step) => {
    const end = Date.now() + (timeout || 8000);
    let lastError = null;
    while (Date.now() < end) {
      try { const value = await fn(); if (value) return value; } catch (err) { lastError = err; }
      await sleep(step || 100);
    }
    throw new Error('не дождались: ' + (lastError && lastError.message ? lastError.message : 'условие'));
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const commandsView = () => q('#aeCommandsView');
  const rows = () => qa('#aeCommandsView .lx-tree-row');
  const rowLabel = (row) => ((q('.lx-tree-row-label', row) || {}).textContent || '').trim();
  const rowMeta = (row) => ((q('.lx-tree-row-meta', row) || {}).textContent || '').trim();
  const depthOf = (row) => {
    const item = row.parentElement;
    return Number.parseInt(item ? item.style.getPropertyValue('--depth') : '', 10) || 0;
  };
  const rowByName = (name) => rows().find((row) => rowLabel(row) === name);
  const list = () => window.jarvis.listCommands().then((r) => (Array.isArray(r) ? r : (r && Array.isArray(r.commands) ? r.commands : [])));
  const countSteps = (steps) => (Array.isArray(steps) ? steps : []).reduce((n, step) => n + 1 + countSteps(step && step.children), 0);
  const route = () => (window.__noxAether && typeof window.__noxAether.getRoute === 'function' ? window.__noxAether.getRoute() : '');
  const debugApi = () => (window.__noxAether && window.__noxAether.commandsDebug ? window.__noxAether.commandsDebug : null);
  const openRoute = async () => {
    window.__noxAether.setRoute('commands');
    await until(() => route() === 'commands' && visible(commandsView()) && rows().length > 0, 8000);
    await sleep(250);
  };
  const resetToCommand = async (id) => {
    const debug = debugApi();
    if (debug && id) debug.selectCommand(id, false);
    window.__noxAether.setRoute('commands');
    await sleep(300);
  };
  const clickRow = async (name) => {
    const row = rowByName(name);
    if (!row) throw new Error('нет строки «' + name + '»');
    row.click();
    await sleep(220);
  };
  const openInspector = async (name) => {
    await clickRow(name);
    // Кнопка «Редактировать команду» — переключатель: если панель уже открыта, клик её закроет.
    // После выбора строки выбранная команда уже в черновике, поэтому открытую панель просто проверяем.
    const shownAside = q('.lx-cmd-inspector');
    const shownName = shownAside ? q('input', shownAside) : null;
    if (visible(shownAside) && shownName && shownName.value === name) return;
    const row = rowByName(name);
    if (!row) throw new Error('строка «' + name + '» исчезла после выбора');
    const wrap = row.parentElement;
    const btn = qa('.lx-tree-act-btn', wrap).find((item) => (item.getAttribute('aria-label') || '') === 'Редактировать команду');
    if (!btn) throw new Error('нет действия «Редактировать команду» у «' + name + '»');
    btn.click();
    await until(() => visible(q('.lx-cmd-inspector')), 8000);
    await sleep(200);
    const after = q('.lx-cmd-inspector input');
    if (!after || after.value !== name) throw new Error('панель свойств показывает не «' + name + '»');
  };
  const closeInspector = async () => {
    const aside = q('.lx-cmd-inspector');
    if (!aside) return;
    const btn = qa('.lx-cmd-mini-btn', aside).find((item) => (item.getAttribute('title') || '') === 'Свернуть панель');
    if (btn) btn.click();
    await sleep(200);
  };

  const checks = [];
  const check = async (name, fn) => {
    try {
      const result = await fn();
      checks.push({ name, ok: Boolean(result && result.ok), skipped: Boolean(result && result.skipped), detail: (result && result.detail) || '' });
    } catch (err) {
      checks.push({ name, ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
    }
  };

  await openRoute();
  const cmds = await list();
  const first = cmds[0];

  await check('1. Раздел открыт: #aeCommandsView, дерево и панель инструментов', async () => {
    const view = commandsView();
    const toolbarIds = qa('.lx-cmd-toolbar [id]').map((item) => item.id);
    const ok = route() === 'commands' && visible(view) && Boolean(q('.lx-cmd-tree-scroll')) && rows().length >= cmds.length && toolbarIds.length >= 7;
    return { ok, detail: 'маршрут=' + route() + ' виден=' + visible(view) + ' строк=' + rows().length + ' инструментов=' + toolbarIds.length };
  });

  await check('2. Дерево соответствует ядру: команды, корень, фразы и шаги', async () => {
    const current = await list();
    const depth = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const row of rows()) {
      const d = depthOf(row);
      depth[d] = (depth[d] || 0) + 1;
    }
    const rootRow = rows().find((row) => rowLabel(row) === 'Мои команды');
    const rootMeta = rootRow ? rowMeta(rootRow) : '';
    const names = current.map((cmd) => cmd.name);
    const found = names.filter((name) => Boolean(rowByName(name))).length;
    const stepTotal = current.reduce((sum, cmd) => sum + countSteps(cmd.steps), 0);
    const folders = new Set(current.map((cmd) => cmd.folder).filter(Boolean));
    const folderExpected = folders.size + (current.some((cmd) => !cmd.folder) ? 1 : 0);
    const deepExpected = current.length + stepTotal;
    const ok = depth[0] === 1 && depth[1] === folderExpected && depth[2] === current.length
      && (depth[3] || 0) === deepExpected && found === names.length && rootMeta.indexOf(String(current.length)) >= 0;
    return { ok, detail: 'команд=' + current.length + ' папок=' + folderExpected + ' глубина=' + JSON.stringify(depth) + ' корень="' + rootMeta + '" шагов=' + stepTotal };
  });

  await check('3. Поиск: строки сужаются по имени и возвращаются', async () => {
    const before = rows().length;
    const needle = first ? first.name : '';
    const input = q('#lxCmdSearch');
    if (!input) return { ok: false, detail: 'нет поля #lxCmdSearch' };
    input.value = needle;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => rows().length < before || before <= 1, 8000);
    const after = rows().length;
    const lower = needle.toLowerCase();
    const commandNames = rows().filter((row) => depthOf(row) === 2).map(rowLabel);
    const every = commandNames.length > 0 && commandNames.every((name) => name.toLowerCase().indexOf(lower) >= 0);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => rows().length === before, 8000);
    const restored = rows().length === before;
    return { ok: every && restored, detail: 'до=' + before + ' после=' + after + ' совпали=' + every + ' сброс=' + restored };
  });

  await check('4. Свернуть и развернуть команду: шаги скрываются и возвращаются', async () => {
    const target = first;
    if (!target) return { ok: false, detail: 'в ядре нет команд' };
    const row = rowByName(target.name);
    if (!row) return { ok: false, detail: 'нет строки «' + target.name + '»' };
    const chev = q('.lx-tree-row-chev', row);
    if (!chev) return { ok: false, detail: 'нет кнопки сворачивания' };
    const before = rows().length;
    chev.click();
    await sleep(280);
    const collapsed = rows().length;
    const stillNamed = Boolean(rowByName(target.name));
    const afterRow = rowByName(target.name);
    const expand = afterRow ? q('.lx-tree-row-chev', afterRow) : null;
    if (expand) expand.click();
    await sleep(280);
    const steps = countSteps(target.steps);
    const expected = before - (1 + steps);
    const restored = rows().length === before;
    const ok = collapsed === expected && stillNamed && restored;
    return { ok, detail: 'до=' + before + ' свёрнуто=' + collapsed + ' ожидали=' + expected + ' вернули=' + restored };
  });

  await check('5. Выбор команды и панель свойств: название, фразы, флаги', async () => {
    const target = first;
    if (!target) return { ok: false, detail: 'в ядре нет команд' };
    await openInspector(target.name);
    const aside = q('.lx-cmd-inspector');
    const labels = qa('.lx-cmd-field-label', aside).map((item) => item.textContent);
    const nameInput = q('input', aside);
    const phraseRows = qa('.lx-cmd-phrase-row', aside).length;
    const flags = qa('input[type=checkbox]', aside);
    const expectedPhrases = Math.max(1, (target.phrases || []).length);
    const ok = visible(aside) && Boolean(nameInput) && nameInput.value === target.name
      && labels.indexOf('Название') >= 0 && labels.indexOf('Фразы для запуска') >= 0
      && phraseRows === expectedPhrases && flags.length === 2 && flags[0].checked === (target.enabled !== false);
    await closeInspector();
    return { ok, detail: 'поля=' + labels.join('|') + ' фраз=' + phraseRows + '/' + expectedPhrases + ' флагов=' + flags.length };
  });

  await check('6. Правка черновика не меняет ядро; выбор строки сбрасывает черновик', async () => {
    const target = first;
    if (!target) return { ok: false, detail: 'в ядре нет команд' };
    const debug = debugApi();
    if (!debug) return { ok: true, skipped: true, detail: 'window.__noxAether.commandsDebug нет: сброс черновика недоступен этой сборке' };
    await openInspector(target.name);
    const nameInput = q('.lx-cmd-inspector input');
    if (!nameInput) return { ok: false, detail: 'нет поля названия' };
    nameInput.value = target.name + ' QA';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    const after = await list();
    const coreSame = after.some((cmd) => cmd.name === target.name) && !after.some((cmd) => cmd.name === target.name + ' QA');
    const saveReady = !q('#lxCmdSave').disabled;
    debug.selectCommand(target.id, false);
    await sleep(350);
    const rowRestored = Boolean(rowByName(target.name));
    const ok = coreSame && saveReady && rowRestored;
    return { ok, detail: 'ядро без изменений=' + coreSame + ' сохранение доступно=' + saveReady + ' строка вернулась=' + rowRestored };
  });

  await check('7. Сохранение имени доходит до ядра и возвращается обратно', async () => {
    const target = first;
    if (!target) return { ok: false, detail: 'в ядре нет команд' };
    await resetToCommand(target.id);
    await openInspector(target.name);
    const nameInput = q('.lx-cmd-inspector input');
    if (!nameInput) return { ok: false, detail: 'нет поля названия' };
    nameInput.value = target.name + ' QA';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    q('#lxCmdSave').click();
    const saved = await until(async () => (await list()).find((cmd) => cmd.name === target.name + ' QA'), 12000);
    await window.jarvis.saveCommand(Object.assign({}, saved, { name: target.name }));
    window.dispatchEvent(new CustomEvent('nox:commands-updated'));
    await until(async () => {
      const now = await list();
      return now.some((cmd) => cmd.name === target.name) && !now.some((cmd) => cmd.name === target.name + ' QA');
    }, 8000);
    await sleep(350);
    const restored = Boolean(rowByName(target.name));
    await closeInspector();
    const ok = Boolean(saved) && restored;
    return { ok, detail: 'новое имя в ядре=' + Boolean(saved) + ' исходное вернулось=' + restored };
  });

  await check('8. Добавление и удаление шага черновика', async () => {
    const target = first;
    if (!target) return { ok: false, detail: 'в ядре нет команд' };
    await resetToCommand(target.id);
    await openInspector(target.name);
    const before = rows().length;
    const labelsBefore = rows().map(rowLabel);
    q('#lxCmdBtnAddStep').click();
    await until(() => rows().length === before + 1, 8000);
    const labelsAfter = rows().map(rowLabel);
    let addedIndex = -1;
    for (let index = 0; index < labelsAfter.length; index += 1) {
      if (index >= labelsBefore.length || labelsAfter[index] !== labelsBefore[index]) { addedIndex = index; break; }
    }
    const addedRow = addedIndex >= 0 ? rows()[addedIndex] : null;
    const dirty = q('#lxCmdSave').classList.contains('is-dirty');
    if (!addedRow) return { ok: false, detail: 'не нашли добавленную строку шага (до=' + before + ', после=' + rows().length + ')' };
    addedRow.click();
    await sleep(300);
    const delAct = qa('#aeCommandsView .lx-tree-act-btn').find((item) => (item.getAttribute('aria-label') || '') === 'Удалить шаг');
    if (!delAct) return { ok: false, detail: 'нет действия «Удалить шаг» у выбранного шага' };
    delAct.click();
    await until(() => rows().length === before, 8000);
    const restored = rows().length === before;
    const ok = rows().length === before && dirty && restored && Boolean(addedRow);
    await resetToCommand(target.id);
    return { ok, detail: 'строк было=' + before + ' добавили=' + addedIndex + ' черновик изменён=' + dirty + ' удалили=' + restored };
  });

  await check('9. Редактор шага: свойства, тип и параметры', async () => {
    const target = first;
    if (!target) return { ok: false, detail: 'в ядре нет команд' };
    await resetToCommand(target.id);
    await openInspector(target.name);
    const pauseRow = rows().find((row) => rowLabel(row) === 'Пауза · 1200');
    if (!pauseRow) return { ok: false, detail: 'нет строки шага «Пауза · 1200»' };
    pauseRow.click();
    await sleep(350);
    const aside = q('.lx-cmd-inspector');
    const titles = qa('.lx-cmd-insp-title', aside).map((item) => item.textContent);
    const select = q('select', aside);
    const options = select ? qa('option', select).map((item) => item.value) : [];
    const labels = qa('.lx-cmd-field-label', aside).map((item) => item.textContent);
    const stepTitle = titles.find((title) => title.indexOf('Шаг (') === 0);
    const wasWait = Boolean(select) && select.value === 'wait';
    if (select) {
      select.value = 'volume';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(350);
    const volumeLabels = qa('.lx-cmd-field-label', q('.lx-cmd-inspector')).map((item) => item.textContent);
    const volumeInput = q('.lx-cmd-inspector input[type=number]');
    const volumeOk = volumeLabels.indexOf('Громкость (%)') >= 0 && Boolean(volumeInput);
    const back = q('.lx-cmd-inspector select');
    if (back) {
      back.value = 'wait';
      back.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(250);
    const ok = Boolean(stepTitle) && wasWait && options.length >= 6 && labels.indexOf('Тип шага') >= 0 && volumeOk;
    await closeInspector();
    await resetToCommand(target.id);
    return { ok, detail: 'заголовок=' + (stepTitle || 'нет') + ' тип=' + (select ? select.value : 'нет') + ' опций=' + options.length + ' громкость=' + volumeOk };
  });

  await check('10. Новая команда «Напишите»: создаётся в ядре и убирается', async () => {
    q('#lxCmdTabNew').click();
    await until(() => visible(q('.lx-new-shell')), 8000);
    const tabs = qa('.lx-new-tab').map((item) => item.textContent.trim());
    const writeTab = q('#lxNewTab_write');
    if (!writeTab) return { ok: false, detail: 'нет вкладки «Напишите»; вкладки=' + tabs.join('/') };
    writeTab.click();
    await until(() => qa('.lx-cmd-workspace input').length >= 3, 8000);
    const inputs = qa('.lx-cmd-workspace input');
    inputs[0].value = 'QA новая';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = 'qa новая';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    // Шаг «Запуск программы» по умолчанию пустой: ядро не сохранит команду без программы.
    inputs[2].value = 'notepad';
    inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(250);
    const save = qa('.lx-cmd-workspace button').find((item) => item.textContent.trim() === 'Сохранить команду');
    if (!save) return { ok: false, detail: 'нет кнопки «Сохранить команду»' };
    save.click();
    let created = null;
    try {
      created = await until(async () => (await list()).find((cmd) => cmd.name === 'QA новая'), 12000);
    } catch (err) {
      const names = (await list()).map((cmd) => cmd.name);
      const toasts = qa('.ae-toast').map((item) => item.textContent.trim());
      const errors = qa('.lx-error-box').map((item) => item.textContent.trim());
      return {
        ok: false,
        detail: 'сохранение не подтвердилось: имена в ядре=' + names.join(',')
          + '; ошибки=' + (errors.join(' | ') || 'нет') + '; сообщения=' + (toasts.join(' | ') || 'нет')
          + '; поля=' + qa('.lx-cmd-workspace input').map((item) => item.value).join('|'),
      };
    }
    if (created) await window.jarvis.deleteCommand(created.id);
    window.dispatchEvent(new CustomEvent('nox:commands-updated'));
    await sleep(400);
    const gone = !(await list()).some((cmd) => cmd.name === 'QA новая');
    const ok = Boolean(created) && gone && tabs.length === 3;
    await openRoute();
    return { ok, detail: 'вкладки=' + tabs.join('/') + ' создана=' + Boolean(created) + ' убрана=' + gone };
  });

  await check('11. Паки: карточки и кнопки установки', async () => {
    q('#lxCmdBtnPacks').click();
    await until(() => qa('#aeCommandsView .lx-cmd-pack-card').length > 0, 12000);
    const cards = qa('#aeCommandsView .lx-cmd-pack-card');
    const grid = q('.lx-cmd-packs-grid');
    const withButton = cards.filter((card) => qa('button', card).some((item) => {
      const text = item.textContent.trim();
      return text === 'Установить' || text === 'Установлено';
    })).length;
    const ids = cards.map((card) => card.dataset.packId).filter(Boolean);
    const ok = cards.length >= 8 && visible(grid) && withButton === cards.length && ids.length === cards.length;
    q('#lxCmdBtnPacks').click();
    await sleep(350);
    return { ok, detail: 'карточек=' + cards.length + ' с кнопкой=' + withButton + ' паки=' + ids.slice(0, 5).join(',') };
  });

  await check('12. Журнал запусков: безопасная команда и запись в журнале', async () => {
    let created = null;
    try {
      const reply = await window.jarvis.saveCommand({ name: 'QA пауза', phrases: ['qa пауза'], steps: [{ tool: 'wait', args: { ms: 50 } }], enabled: true, origin: 'manual' });
      created = reply && reply.command ? reply.command : null;
    } catch (err) {
      return { ok: false, detail: 'saveCommand бросил: ' + String(err && err.message ? err.message : err) };
    }
    if (!created || !created.id) return { ok: false, detail: 'ядро не создало временную команду' };
    window.dispatchEvent(new CustomEvent('nox:commands-updated'));
    try {
      await until(() => Boolean(rowByName('QA пауза')), 10000);
    } catch (err) {
      const names = rows().filter((row) => depthOf(row) === 2).map(rowLabel);
      const mode = q('.lx-new-shell') ? 'новая команда' : (q('.lx-cmd-packs-grid') ? 'паки' : 'дерево');
      return { ok: false, detail: 'строка «QA пауза» не появилась: команды в дереве=' + names.join(',') + '; режим=' + mode };
    }
    try {
      await openInspector('QA пауза');
    } catch (err) {
      return { ok: false, detail: 'свойства «QA пауза» не открылись: ' + String(err && err.message ? err.message : err) };
    }
    const runBtn = qa('.lx-cmd-inspector button').find((item) => item.textContent.trim() === 'Запустить');
    if (!runBtn) return { ok: false, detail: 'нет кнопки «Запустить» в свойствах команды' };
    runBtn.click();
    const ran = await until(async () => {
      const current = (await list()).find((cmd) => cmd.id === created.id);
      return current && current.lastRunAt ? current : null;
    }, 15000).catch(() => null);
    q('#lxCmdBtnLaunches').click();
    let launchesVisible = false;
    try {
      await until(() => visible(q('.lx-launch-table')), 10000);
      launchesVisible = true;
    } catch (err) { /* итог проверки ниже честно скажет, что журнал не открылся */ }
    const logRows = qa('.lx-launch-row').map((row) => row.textContent);
    const ours = logRows.some((text) => text.indexOf('QA пауза') >= 0);
    if (launchesVisible) {
      q('#lxCmdBtnLaunches').click();
      await sleep(300);
    }
    await window.jarvis.deleteCommand(created.id);
    window.dispatchEvent(new CustomEvent('nox:commands-updated'));
    await sleep(400);
    const ok = Boolean(ran) && ours && launchesVisible;
    await openRoute();
    return { ok, detail: 'lastRunAt=' + Boolean(ran) + ' журнал виден=' + launchesVisible + ' строк=' + logRows.length + ' наша=' + ours };
  });

  await check('13. Чат цел: переход в чат и возврат в «Команды»', async () => {
    window.__noxAether.setRoute('chat');
    await until(() => route() === 'chat' && visible(q('#aeChatWorkspace')), 8000);
    const workspace = visible(q('#aeChatWorkspace'));
    const composer = Boolean(q('.ae-composer, textarea'));
    window.__noxAether.setRoute('commands');
    await until(() => route() === 'commands' && visible(commandsView()) && rows().length > 0, 8000);
    const back = visible(commandsView()) && rows().length > 0;
    const ok = workspace && composer && back;
    return { ok, detail: 'чат=' + workspace + ' поле=' + composer + ' вернулись=' + back };
  });

  return { checks, firstName: first ? first.name : '' };
}

async function qaAetherPhase2Page() {
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, timeout) => {
    const end = Date.now() + (timeout || 8000);
    while (Date.now() < end) {
      try { const value = await fn(); if (value) return value; } catch (err) { /* ждём */ }
      await sleep(100);
    }
    throw new Error('не дождались условия 864x520');
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const depthOf = (row) => {
    const item = row.parentElement;
    return Number.parseInt(item ? item.style.getPropertyValue('--depth') : '', 10) || 0;
  };
  const checks = [];
  const check = async (name, fn) => {
    try {
      const result = await fn();
      checks.push({ name, ok: Boolean(result && result.ok), skipped: Boolean(result && result.skipped), detail: (result && result.detail) || '' });
    } catch (err) {
      checks.push({ name, ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
    }
  };

  await check('14. 864x520: каталог и свойства команды внутри окна', async () => {
    const innerW = innerWidth;
    const innerH = innerHeight;
    const docOk = document.documentElement.scrollWidth <= innerW + 1;
    const toolbar = q('.lx-cmd-toolbar');
    const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null;
    const workspace = q('.lx-cmd-workspace');
    const workspaceRect = workspace ? workspace.getBoundingClientRect() : null;
    let inspectorOk = false;
    let footButtons = [];
    const commandRows = () => qa('#aeCommandsView .lx-tree-row').filter((row) => depthOf(row) === 2);
    const firstRow = commandRows()[0];
    let clickedName = '';
    if (firstRow) {
      clickedName = ((firstRow.querySelector('.lx-tree-row-label') || {}).textContent || '').trim();
      firstRow.click();
      await sleep(300);
      // После клика строку перерисовали: действие «Редактировать команду» есть только у новой выбранной строки.
      const selectedRow = qa('#aeCommandsView .lx-tree-row.is-selected').find((row) => depthOf(row) === 2)
        || commandRows().find((row) => ((row.querySelector('.lx-tree-row-label') || {}).textContent || '').trim() === clickedName);
      // Кнопка «Редактировать команду» — переключатель: если панель уже открыта, клик её закроет.
      let aside = q('.lx-cmd-inspector');
      if (!visible(aside)) {
        const wrap = selectedRow ? selectedRow.parentElement : null;
        const act = wrap ? qa('.lx-tree-act-btn', wrap).find((item) => (item.getAttribute('aria-label') || '') === 'Редактировать команду') : null;
        if (act) {
          act.click();
          await until(() => visible(q('.lx-cmd-inspector')), 8000);
        }
        aside = q('.lx-cmd-inspector');
      }
      if (visible(aside)) {
        const rect = aside.getBoundingClientRect();
        footButtons = qa('.lx-cmd-insp-footer button').map((item) => {
          const r = item.getBoundingClientRect();
          return { text: item.textContent.trim(), x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
        });
        const shown = footButtons.filter((item) => item.visible);
        inspectorOk = rect.right <= innerW + 1 && rect.left >= -1 && shown.length >= 2 && shown.every((item) => item.x >= -1 && item.right <= innerW + 1);
        const closeBtn = qa('.lx-cmd-mini-btn', aside).find((item) => (item.getAttribute('title') || '') === 'Свернуть панель');
        if (closeBtn) closeBtn.click();
        await sleep(200);
      }
    }
    const ok = docOk && Boolean(toolbarRect) && toolbarRect.right <= innerW + 1
      && Boolean(workspaceRect) && workspaceRect.width > 0 && inspectorOk && innerW === 864 && innerH === 520;
    return { ok, detail: 'окно=' + innerW + 'x' + innerH + ' scrollWidth=' + document.documentElement.scrollWidth + ' панель=' + inspectorOk + ' строка=' + (clickedName || 'нет') + ' кнопки=' + JSON.stringify(footButtons) };
  });

  return { checks };
}

// Прогон QA для Aether: сценарий 1–13, resize 864x520 (14), консоль (15).
async function runQaAether(win) {
  const checks = [];
  try {
    const phase1 = await js(win, '(' + qaAetherPhase1Page.toString() + ')()');
    checks.push(...((phase1 && phase1.checks) || []));
  } catch (err) {
    checks.push({ name: 'qa Aether: сценарий 1–13', ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
  }
  try {
    await setContentSize(win, 864, 520);
    const phase2 = await js(win, '(' + qaAetherPhase2Page.toString() + ')()');
    checks.push(...((phase2 && phase2.checks) || []));
  } catch (err) {
    checks.push({ name: 'qa Aether: сценарий 14 (864x520)', ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
  }
  try { await setContentSize(win, width, height); } catch { /* окно могли закрыть */ }
  await sleep(400);
  const errors = consoleErrors.slice();
  // Дерево Aether ставит inline-стили (--depth, отступы), и при CSP style-src 'self' Chromium пишет
  // предупреждение. Это не ошибка проверки и не наша правка: считаем такие строки отдельно.
  const cspStyle = errors.filter((text) => text.indexOf("Content Security Policy directive 'style-src 'self''") >= 0);
  const meaningful = errors.filter((text) => cspStyle.indexOf(text) < 0);
  checks.push({
    name: '15. Ошибки консоли',
    ok: meaningful.length === 0,
    detail: (meaningful.length ? meaningful.join(' | ').slice(0, 800) : 'нет ошибок')
      + (cspStyle.length ? '; предупреждений CSP style-src у дерева Aether: ' + cspStyle.length : ''),
  });
  const skipped = checks.filter((item) => item.skipped).length;
  const passed = checks.filter((item) => item.ok && !item.skipped).length;
  return { passed, failed: checks.length - passed - skipped, skipped, checks };
}

// Один прогон QA в главном процессе: сценарий 1–12, resize 864x520 и сценарий 13, потом консоль.
async function runQa(win) {
  if (mainShell === 'aether') return runQaAether(win);
  const checks = [];
  try {
    const phase1 = await js(win, `(${qaPhase1Page.toString()})()`);
    checks.push(...((phase1 && phase1.checks) || []));
  } catch (err) {
    checks.push({ name: 'qa: сценарий 1–12', ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
  }

  try {
    await setContentSize(win, 864, 520);
    const phase13 = await js(win, `(${qaPhase13Page.toString()})()`);
    checks.push(...((phase13 && phase13.checks) || []));
  } catch (err) {
    checks.push({ name: 'qa: сценарий 13 (864x520)', ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
  }
  // Возвращаем запрошенный размер, чтобы окно осталось в предсказуемом состоянии.
  try { await setContentSize(win, width, height); } catch { /* окно могли закрыть */ }

  // Дать консоли досказать последние ошибки.
  await sleep(400);
  const errors = consoleErrors.slice();
  checks.push({ name: '14. Ошибки консоли', ok: errors.length === 0, detail: errors.length ? errors.join(' | ').slice(0, 900) : 'нет' });

  const passed = checks.filter((c) => c.ok).length;
  return { passed, failed: checks.length - passed, checks };
}

// Привести содержимое окна к нужному размеру (мин. границы окна временно снимаются).
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

async function capture(win) {
  await waitFor(win, 'document.readyState === "complete"', { timeout: 15000, label: 'readyState complete' });

  // Окно создано скрытым и показывается без захвата фокуса, чтобы не мешать живому окну.
  try { win.showInactive(); } catch { try { win.show(); } catch { /* уже видимо */ } }
  // У окна minWidth/minHeight 960x640, а нужен и кадр 864x520: временно снимаем нижнюю границу.
  try { win.setMinimumSize(200, 200); } catch { /* старые версии Electron */ }
  win.setContentSize(width, height);
  for (let i = 0; i < 40; i += 1) {
    const [w, h] = win.getContentSize();
    if (w === width && h === height) break;
    await sleep(50);
  }
  const contentSize = win.getContentSize();

  const { page, cleaned } = await settle(win);
  const ready = await openCommands(win);

  // QA — отдельный путь: кадр не снимаем, гоняем проверки и выходим по их итогу.
  if (mode === 'qa') {
    const qa = await runQa(win);
    finish({
      ok: qa.failed === 0,
      mode: 'qa',
      qa,
      width,
      height,
      contentSize: { width: contentSize[0], height: contentSize[1] },
      view: lastView || null,
      page,
      cleaned,
      ready,
      viewTrace,
      consoleErrors: consoleErrors.slice(),
      windowsCount: electron.BrowserWindow.getAllWindows().length,
    });
    return;
  }

  const action = await applyMode(win);
  if (action && action.ok === false) {
    if (action.unsupported) {
      finish({ ok: true, skipped: true, mode, shell: mainShell, reason: action.error || 'режим не поддержан в этой оболочке', width, height, view: lastView || null, ready });
      return;
    }
    throw new Error(`режим ${mode}: ${action.error || 'не выполнен'}`);
  }

  // Прокрутка к началу раздела: каталог и редактор снимаем сверху.
  await js(win, `(() => {
    const view = document.querySelector('.view-commands');
    if (view) view.scrollTop = 0;
    window.scrollTo(0, 0);
    return true;
  })()`).catch(() => null);
  await sleep(waitMs);
  // Всплывающие подсказки живут 3,5 с: для чистого кадра ждём, пока они уйдут.
  await waitFor(win, `document.querySelectorAll('#toasts .toast').length === 0`, {
    timeout: 5000, interval: 150, label: 'всплывающие подсказки ушли',
  }).catch(() => null);
  if (!keepFocus) {
    await js(win, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`).catch(() => null);
  }
  await sleep(200);
  await settle(win).catch(() => null);

  const geometry = await readGeometry(win, { mode, command: commandName || null, actionName: action && action.name ? action.name : null, ready, cleaned, requested: { width, height } });
  const windows = electron.BrowserWindow.getAllWindows().map((w) => ({
    title: w.getTitle(), visible: w.isVisible(), bounds: w.getBounds(), focused: w.isFocused(),
    url: (() => { try { return w.webContents.getURL(); } catch { return ''; } })(),
  }));

  const image = await win.webContents.capturePage();
  if (!image || image.isEmpty()) throw new Error('capturePage вернул пустой кадр');
  const size = image.getSize();
  const png = image.toPNG();
  const info = pngInfo(png);
  if (!info) throw new Error('capturePage вернул не PNG');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);

  const els = geometry && geometry.elements ? geometry.elements : {};
  const rects = {
    '.app': els['.app'] || null,
    '.rail': els['.rail'] || null,
    '#cmdCatalog': els['#cmdCatalog'] || null,
    '.nox-cmd-head': els['.nox-cmd-head'] || null,
    '#cmdList .cmd-item:first-child': els['#cmdList .cmd-item:first-child'] || null,
    '#cmdPacks': els['#cmdPacks'] || null,
    '#cmdEditor': els['#cmdEditor'] || null,
    '.nox-editor-main': els['.nox-editor-main'] || null,
    '.nox-editor-side': els['.nox-editor-side'] || null,
    '.nox-editor-foot': els['.nox-editor-foot'] || null,
  };
  const rail = rects['.rail'];
  const commandsPage = els['#commands'] || null;
  const editorCard = rects['#cmdEditor'];
  const packsBox = rects['#cmdPacks'];

  // Геометрия пишется до finish: finish сразу завершает процесс.
  if (geometry && dumpPath) {
    fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
    fs.writeFileSync(dumpPath, JSON.stringify(geometry, null, 2), 'utf8');
  }

  finish({
    ok: true,
    out: outPath,
    mode,
    shell: mainShell,
    command: action && action.name ? action.name : null,
    width,
    height,
    contentSize: { width: contentSize[0], height: contentSize[1] },
    imageWidth: size.width,
    imageHeight: size.height,
    png: info,
    view: geometry ? geometry.view : null,
    page,
    cleaned,
    ready,
    catalogLoaded: action && action.catalogLoaded === true,
    geometryPath: dumpPath || null,
    geometry,
    rects,
    summary: {
      rail,
      commandsPage,
      cmdRows: geometry && geometry.cmdList ? geometry.cmdList.count : null,
      cmdListTotalHeight: geometry && geometry.cmdList ? geometry.cmdList.totalHeight : null,
      packs: packsBox,
      packCards: geometry && geometry.packs ? geometry.packs.cards : null,
      packConsts: geometry && geometry.packs ? geometry.packs.consts : null,
      editorCard,
      editorOpen: geometry && geometry.editor ? geometry.editor.open : null,
      editorSide: rects['.nox-editor-side'],
      editorMain: rects['.nox-editor-main'],
      editorFoot: rects['.nox-editor-foot'],
      pickerOpen: geometry && geometry.modal ? geometry.modal.pickerOpen : null,
      scroll: geometry ? geometry.scroll : null,
    },
    windows,
    viewTrace,
    consoleErrors,
  });
}

let lastView = '';
const viewTrace = [];
app.on('browser-window-created', (_event, win) => {
  try {
    win.webContents.on('console-message', (_e, level, message) => {
      const noisy = typeof level === 'object' && level ? level : null;
      const severity = noisy ? noisy.level : level;
      const text = noisy ? noisy.message : message;
      if ((severity === 'error' || severity === 3) && consoleErrors.length < 20) {
        consoleErrors.push(String(text || '').slice(0, 300));
      }
    });
  } catch { /* старые версии Electron: подписка не критична */ }

  win.webContents.once('did-finish-load', () => {
    if (mainWin) return;
    const url = win.webContents.getURL();
    // Aether грузит renderer/aether/index.html, старая оболочка — renderer/index.html.
    const aether = /renderer[\\/]aether[\\/]index\.html/i.test(url);
    const legacy = /renderer[\\/]index\.html/i.test(url);
    if (!aether && !legacy) return;
    mainWin = win;
    mainShell = aether ? 'aether' : 'legacy';
    capture(win).catch((err) => finish({ ok: false, error: err && err.message ? err.message : String(err), shell: mainShell }));
  });
});

// Раздел для сообщения о таймауте: раз в 500 мс смотрим, что уже открыто, и запоминаем переходы разделов
// (диагностика: если раздел кто-то переключил после показа «Команд», это видно в результате).
setInterval(() => {
  if (!mainWin || finished) return;
  mainWin.webContents.executeJavaScript('document.body.dataset.view || (window.__noxAether && window.__noxAether.getRoute ? window.__noxAether.getRoute() : "")', true)
    .then((v) => {
      if (!v) return;
      lastView = v;
      if (viewTrace[viewTrace.length - 1] !== v) viewTrace.push(v);
    })
    .catch(() => {});
}, 500).unref();

try {
  require('../main');
} catch (err) {
  finish({ ok: false, error: `main.js не загрузился: ${err && err.message ? err.message : err}` });
}
