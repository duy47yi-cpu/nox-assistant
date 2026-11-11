'use strict';

// Снимок настоящего окна Nox в разделе «Подключения» (MCP) + QA.
// Модель scripts/nox-commands-shot.js: отдельный процесс Electron с временным профилем и
// временными данными; настройки, сервисы и рабочая папка владельца не читаются.
//
// Из папки apps/jarvis-desktop (ELECTRON_RUN_AS_NODE должен быть снят):
//   electron scripts/nox-connections-shot.js --out <png> --mode catalog|details|add|delete|drift|error|chat|commands|empty|qa
//     [--width 1200] [--height 720] [--wait 2500] [--dump-geometry <json>]
//     [--keep-temp] [--keep-banner] [--keep-focus]
//
// Временные сервисы (всё локально, без ключей и без внешней сети):
//   echo-check   — настоящий MCP-сервер по stdio: node + временный файл echo-server.js
//                  (initialize, notifications/initialized, tools/list с двумя действиями) → connected;
//   drift-check  — тот же сервер плюс отпечаток mcpToolSnapshots с другим hash → drift;
//   bad-path     — command: nox-no-such-command → error (ENOENT);
//   off-service  — {url:'https://example.com/mcp', disabled:true} → disabled (сеть не трогается).
// --mode empty — пустое состояние: mcpServers и mcpToolSnapshots пустые (фикстуры не сеются).
// Печатает одну строку NOX_CONN_SHOT_RESULT <json> и выходит: 0 — успех, 1 — ошибка.
// По умолчанию файл: docs/reconstruction/phase3/connections/connections-<W>x<H>-<mode>.png

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
  console.error('nox-connections-shot: нужен запуск через electron.exe, а не node: снимите ELECTRON_RUN_AS_NODE');
  process.exit(1);
}
const { app, globalShortcut, dialog } = electron;

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'docs', 'reconstruction', 'phase3', 'connections');
let TIMEOUT_MS = 40000;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}
function bad(message) {
  console.error(`nox-connections-shot: ${message}`);
  process.exit(2);
}

const width = Number.parseInt(arg('width', '1200'), 10) || 1200;
const height = Number.parseInt(arg('height', '720'), 10) || 720;
if (width < 420 || height < 480) bad('окно меньше минимального 420x480');
const MODES = ['catalog', 'details', 'add', 'delete', 'drift', 'error', 'chat', 'commands', 'empty', 'qa'];
const mode = String(arg('mode', 'catalog')).toLowerCase();
if (!MODES.includes(mode)) bad(`--mode: ${MODES.join('|')}, получено «${arg('mode')}»`);
if (mode === 'qa') TIMEOUT_MS = 120000;
const waitMs = Math.min(20000, Math.max(0, Number.parseInt(arg('wait', '2500'), 10) || 2500));
const outArg = arg('out', '');
const outPath = path.resolve(outArg || path.join(SHOTS_DIR, `connections-${width}x${height}-${mode}.png`));
const dumpArg = arg('dump-geometry', '');
const dumpPath = dumpArg ? path.resolve(dumpArg) : '';
const keepTemp = has('keep-temp');
const keepBanner = has('keep-banner');
const keepFocus = has('keep-focus');
const seedSet = String(arg('fixtures', 'all')).toLowerCase();

// ── Временный профиль и данные ────────────────────────────────────
function sweepOldTemp() {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^nox-connections-shot-/i.test(entry.name)) continue;
    const full = path.join(os.tmpdir(), entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs < 60000) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch { /* занят другим запуском */ }
  }
}
sweepOldTemp();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-connections-shot-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });

// Настоящий MCP-сервер по stdio: построчный JSON-RPC 2.0, как ждёт src/mcp/client.js.
// Запускается отдельным файлом (аргументы настройки MCP не пропускают кавычки/$/братья оболочки,
// поэтому inline `node -e "..."` невозможен). Node берём явным путём, если он есть.
const NODE_CANDIDATES = [
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
];
let nodeCommand = 'node';
for (const candidate of NODE_CANDIDATES) {
  try { if (fs.existsSync(candidate)) { nodeCommand = candidate; break; } } catch { /* нет доступа — оставляем PATH */ }
}
const ECHO_SERVER = [
  "'use strict';",
  "const readline = require('readline');",
  "const TOOLS = [",
  "  { name: 'repeat', title: 'Повтор', description: 'Повторить текст', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },",
  "  { name: 'sum', title: 'Сложить', description: 'Сложить два числа', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },",
  "];",
  "const rl = readline.createInterface({ input: process.stdin });",
  "function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }",
  "rl.on('line', (line) => {",
  "  const text = String(line || '').trim();",
  "  if (!text) return;",
  "  let msg;",
  "  try { msg = JSON.parse(text); } catch { return; }",
  "  if (!msg || typeof msg !== 'object') return;",
  "  if (msg.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo-fixture', version: '1.0.0' } } });",
  "    return;",
  "  }",
  "  if (msg.method === 'notifications/initialized') return;",
  "  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }); return; }",
  "  if (msg.method === 'tools/call') {",
  "    const name = msg.params && msg.params.name;",
  "    const args = (msg.params && msg.params.arguments) || {};",
  "    const out = name === 'repeat' ? String(args.text || '') : String((Number(args.a) || 0) + (Number(args.b) || 0));",
  "    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: out }] } });",
  "    return;",
  "  }",
  "  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'метод не поддерживается' } });",
  "});",
  "process.stdin.on('end', () => process.exit(0));",
  '',
].join('\n');
const echoPath = path.join(tempRoot, 'echo-server.js');
fs.writeFileSync(echoPath, ECHO_SERVER, 'utf8');

// Временные сервисы. Сеть не используется: connected — локальный node-процесс,
// disabled — адрес example.com, который менеджер даже не пытается открыть.
const nowIso = new Date().toISOString();
const mcpServers = {};
if (seedSet === 'all' || seedSet === 'base') {
  mcpServers['echo-check'] = { command: nodeCommand, args: [echoPath] };
  mcpServers['bad-path'] = { command: 'nox-no-such-command' };
  mcpServers['off-service'] = { url: 'https://example.com/mcp', disabled: true };
}
if (seedSet === 'all' || seedSet === 'drift') {
  mcpServers['drift-check'] = { command: nodeCommand, args: [echoPath] };
}
if (seedSet === 'drift') {
  delete mcpServers['bad-path'];
  delete mcpServers['off-service'];
}
if (seedSet === 'error') {
  for (const key of Object.keys(mcpServers)) delete mcpServers[key];
  mcpServers['bad-path'] = { command: 'nox-no-such-command' };
}
// Отпечаток намеренно не совпадает: менеджер увидит «набор действий изменился» и не зарегистрирует действия.
const OLD_ACTION = { name: 'old_action', title: 'Старое действие', description: '' };
const mcpToolSnapshots = seedSet === 'all' || seedSet === 'drift'
  ? { 'drift-check': { hash: '0000000000000000000000000000000000000000000000000000000000000000', at: nowIso, tools: [OLD_ACTION] } }
  : {};
// Пустое состояние: сервисов нет вовсе (проверка #mcpEmpty и панели популярных).
if (mode === 'empty') {
  for (const key of Object.keys(mcpServers)) delete mcpServers[key];
  for (const key of Object.keys(mcpToolSnapshots)) delete mcpToolSnapshots[key];
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
  mcpServers,
  mcpToolSnapshots,
}), 'utf8');
app.setPath('userData', profileDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Настройки владельца из окружения не используем.
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
let mainWin = null;
const consoleErrors = [];
const startedAt = Date.now();

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const payload = { ...result, elapsedMs: Date.now() - startedAt };
  if (keepTemp) payload.tempRoot = tempRoot;
  const line = `NOX_CONN_SHOT_RESULT ${JSON.stringify(payload)}\n`;
  const exitCode = result && result.ok ? 0 : 1;
  let closed = false;
  const exit = () => { if (closed) return; closed = true; app.exit(exitCode); };
  try { process.stdout.write(line, () => setTimeout(exit, 30)); } catch { exit(); return; }
  setTimeout(exit, 2000).unref();
}

process.on('exit', () => {
  if (keepTemp) { console.error(`NOX_CONN_SHOT_TEMP ${tempRoot}`); return; }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  catch { console.error(`NOX_CONN_SHOT_TEMP_REMAINS ${tempRoot}`); }
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

// ── Мост к настоящему ядру ────────────────────────────────────────
async function bridgeCall(win, method, ...args) {
  const exprArgs = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(',');
  return js(win, `(async () => {
    try { return { ok: true, value: await window.jarvis[${JSON.stringify(method)}](${exprArgs}) }; }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  })()`);
}

// ── Раздел «Подключения» ──────────────────────────────────────────
// Готовность: раздел виден, список существует, а ядро уже ответило на mcpState.
const READY_JS = `(async () => {
  const view = document.querySelector('.view-mcp');
  const list = document.querySelector('#mcpList');
  if (!view || view.hidden) return false;
  if (document.body.dataset.view !== 'mcp') return false;
  if (!list) return false;
  let state = null;
  try { state = await window.jarvis.mcpState(); } catch (e) { state = null; }
  if (!state || !Array.isArray(state.servers)) return false;
  return { rows: list.children.length, servers: state.servers.length };
})()`;

async function openConnections(win) {
  await waitFor(win, `Boolean(window.JarvisNox && typeof window.JarvisNox.show === 'function' && document.querySelector('#mcpList'))`, {
    timeout: 20000, label: 'window.JarvisNox и разметка подключений',
  });
  try { await js(win, `(() => { window.JarvisNox.show('mcp'); return document.body.dataset.view; })()`); }
  catch (err) { /* show() может упасть на месте шара в старой разметке — раздел уже показан */ }
  const ready = await waitFor(win, READY_JS, { timeout: 20000, interval: 200, label: 'список подключений' });
  return ready;
}

// Ждём, пока ядро реально подключит локальный echo-сервер (startAll асинхронный).
async function waitForStatus(win, statusName, timeout = 20000) {
  return waitFor(win, `(async () => {
    try {
      const state = await window.jarvis.mcpState();
      if (!state || !Array.isArray(state.servers)) return false;
      return state.servers.some((s) => s && s.status === ${JSON.stringify(statusName)});
    } catch (e) { return false; }
  })()`, { timeout, interval: 250, label: `статус ${statusName}` });
}

// Действие режима (details/add/delete/drift/error дополняются после готовности нового UI).
async function applyMode(win) {
  if (mode === 'catalog' || mode === 'empty') return { ok: true };
  if (mode === 'qa') return { ok: true };
  if (mode === 'chat') {
    try { await js(win, `(() => { window.JarvisNox.show('nox'); return true; })()`); } catch { /* раздел уже показан */ }
    await waitFor(win, `Boolean(document.body.dataset.view === 'nox' && document.querySelector('.nox-grid'))`, { timeout: 12000, label: 'экран Nox' });
    await sleep(600);
    return { ok: true };
  }
  if (mode === 'commands') {
    try { await js(win, `(() => { window.JarvisNox.show('commands'); return true; })()`); } catch { /* раздел уже показан */ }
    await waitFor(win, `Boolean(document.body.dataset.view === 'commands' && document.querySelector('#cmdList'))`, { timeout: 12000, label: 'раздел «Команды»' });
    await sleep(800);
    return { ok: true };
  }
  // Детали: карточка подключённого echo-check → #mcpDetailsDialog.
  if (mode === 'details' || mode === 'delete') {
    const opened = await js(win, `(() => {
      const btn = document.querySelector('#mcpList .mcp-card[data-name="echo-check"] .mcp-card-action');
      if (!btn) return { ok: false, error: 'нет карточки echo-check с действием «Детали»' };
      btn.click();
      return { ok: true };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!opened || !opened.ok) return opened || { ok: false, error: 'клик по «Детали» не выполнен' };
    await waitFor(win, `Boolean(document.querySelector('#mcpDetailsDialog') && document.querySelector('#mcpDetailsDialog').open)`, { timeout: 8000, label: 'диалог деталей' });
    if (mode === 'details') { await sleep(500); return { ok: true }; }
    const del = await js(win, `(() => {
      const btn = document.querySelector('#mcpDetailsDelete');
      if (!btn) return { ok: false, error: 'нет кнопки «Удалить» в деталях' };
      btn.click();
      return { ok: true };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!del || !del.ok) return del || { ok: false, error: 'клик по удалению не выполнен' };
    await waitFor(win, `Boolean(document.querySelector('#mcpDeleteDialog') && document.querySelector('#mcpDeleteDialog').open)`, { timeout: 8000, label: 'диалог удаления' });
    await sleep(500);
    return { ok: true };
  }
  // Добавление: #mcpAddBtn → #mcpAddDialog (пустая форма).
  if (mode === 'add') {
    const opened = await js(win, `(() => {
      const btn = document.querySelector('#mcpAddBtn');
      if (!btn) return { ok: false, error: 'нет кнопки #mcpAddBtn' };
      btn.click();
      return { ok: true };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!opened || !opened.ok) return opened || { ok: false, error: 'клик по «Добавить сервис» не выполнен' };
    await waitFor(win, `Boolean(document.querySelector('#mcpAddDialog') && document.querySelector('#mcpAddDialog').open)`, { timeout: 8000, label: 'диалог добавления' });
    await sleep(500);
    return { ok: true };
  }
  // Изменения набора действий: карточка drift-check → #mcpDriftDialog.
  if (mode === 'drift') {
    const opened = await js(win, `(() => {
      const card = document.querySelector('#mcpList .mcp-card[data-name="drift-check"]');
      if (!card) return { ok: false, error: 'нет карточки drift-check' };
      const btn = card.querySelector('.mcp-card-action-warn, .mcp-card-action');
      if (!btn) return { ok: false, error: 'у drift-check нет действия подтверждения' };
      btn.click();
      return { ok: true };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!opened || !opened.ok) return opened || { ok: false, error: 'клик по «Подтвердить изменения» не выполнен' };
    await waitFor(win, `Boolean(document.querySelector('#mcpDriftDialog') && document.querySelector('#mcpDriftDialog').open)`, { timeout: 8000, label: 'диалог изменений набора действий' });
    await sleep(500);
    return { ok: true };
  }
  // Ошибка: карточка bad-path, «Повторить» → реальная попытка переподключения открывает #mcpErrorDialog.
  if (mode === 'error') {
    const opened = await js(win, `(() => {
      const card = document.querySelector('#mcpList .mcp-card[data-name="bad-path"]');
      if (!card) return { ok: false, error: 'нет карточки bad-path' };
      const btn = card.querySelector('.mcp-card-action-err, .mcp-card-action');
      if (!btn) return { ok: false, error: 'у bad-path нет действия «Повторить»' };
      btn.click();
      return { ok: true };
    })()`).catch((err) => ({ ok: false, error: err.message }));
    if (!opened || !opened.ok) return opened || { ok: false, error: 'клик по «Повторить» не выполнен' };
    await waitFor(win, `Boolean(document.querySelector('#mcpErrorDialog') && document.querySelector('#mcpErrorDialog').open)`, { timeout: 10000, label: 'диалог ошибки подключения' });
    await sleep(500);
    return { ok: true };
  }
  return { ok: false, error: `неизвестный режим ${mode}` };
}
// Геометрия для сравнения «до/после».
async function readGeometry(win, extra) {
  return js(win, `(() => {
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
      '.app', '.rail', '.topbar', '.main', '.views', '.view-mcp', '#mcpPage', '#mcpPanel',
      '#mcpHead', '#mcpToolbar', '#mcpFilters', '#mcpSearchWrap', '#mcpSearch', '#mcpReload',
      '#mcpListWrap', '#mcpList', '#mcpList > *', '#mcpEmpty', '#mcpNoResults', '#mcpLoading',
      '#mcpPopular', '#mcpPopularList', '#mcpPopularCats', '#mcpAddBtn', '#mcpEmptyAdd',
      '#mcpForm', '#mcpAddDialog', '#mcpAddTitle', '#mcpAddError', '#mcpFormNote',
      '#mcpName', '#mcpTarget', '#mcpArgs', '#mcpAddSubmit',
      '#mcpDetailsDialog', '#mcpDetailsBody', '#mcpDetailsDelete', '#mcpDetailsClose', '#mcpDetailsToggle',
      '#mcpDeleteDialog', '#mcpDeleteText', '#mcpDeleteInput', '#mcpDeleteConfirm', '#mcpDeleteCancel',
      '#mcpDriftDialog', '#mcpDriftBody', '#mcpDriftConfirm', '#mcpDriftCancel',
      '#mcpErrorDialog', '#mcpConnErrReason', '#mcpConnErrClose', '#mcpFilters button',
      '#mcpResetFilters', '#toasts',
      // Контракт Phase 3.2 (renderer/connections.js).
      '.mcp-card', '.mcp-card .mcp-name', '.mcp-card .mcp-pill', '.mcp-card .mcp-target',
      '.mcp-card .mcp-line', '.mcp-card .mcp-caps', '.mcp-card .mcp-card-action',
      '#mcpPopularCats .nox-chip-filter', '#mcpPopularList', '.mcp-popular-row',
      '.mcp-popular-row .mcp-popular-name', '.mcp-popular-row .mcp-popular-add', '#mcpPopularNote',
      '#mcpDetailsDialog .dialog-body', '#mcpDetailsBody input.switch',
      '#mcpAddDialog .dialog-body', '#mcpDeleteDialog .dialog-body', '#mcpDriftDialog .dialog-body',
    ];
    for (const sel of selectors) els[sel] = rectEl(sel);
    const rows = Array.from(document.querySelectorAll('#mcpList .mcp-card, #mcpList > *')).map((li, i) => {
      const nameEl = li.querySelector('.mcp-name, .set-name, .nox-conn-name');
      const pillEl = li.querySelector('.mcp-pill');
      const lineEl = li.querySelector('.mcp-line');
      const actionEl = li.querySelector('.mcp-card-action, button');
      return {
        i,
        name: nameEl ? nameEl.textContent.trim() : '',
        status: li.getAttribute('data-status') || '',
        pill: pillEl ? pillEl.textContent.trim() : '',
        tone: pillEl ? (pillEl.getAttribute('data-tone') || '') : '',
        line: lineEl ? lineEl.textContent.trim() : '',
        action: actionEl ? actionEl.textContent.trim() : '',
        rect: rectOf(li),
      };
    });
    return {
      inner: [innerWidth, innerHeight],
      dpr: window.devicePixelRatio || 1,
      view: document.body.dataset.view,
      title: document.title,
      crumb: (document.querySelector('#viewTitle') || {}).textContent || '',
      railCurrent: (document.querySelector('[data-nav][aria-current="page"]') || {}).dataset ? (document.querySelector('[data-nav][aria-current="page"]') || {}).dataset.nav : null,
      scroll: { viewMcp: scrollOf(document.querySelector('.view-mcp')) },
      elements: els,
      rows,
      filters: Array.from(document.querySelectorAll('#mcpFilters button')).map((b) => ({ text: (b.textContent || '').trim(), pressed: b.getAttribute('aria-pressed') })),
      mode: ${JSON.stringify(mode)},
      extra: ${JSON.stringify(extra || {})},
    };
  })()`);
}

function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buf.subarray(0, 8).equals(sig)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

// Состояние сервисов для отчёта: что реально наблюдаем в настоящем ядре.
async function readMcpState(win) {
  const r = await bridgeCall(win, 'mcpState');
  return r && r.ok ? r.value : null;
}

async function capture(win) {
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

  const { page, cleaned } = await settle(win);
  const ready = await openConnections(win);
  // Для снимка каталога с живым сервисом ждём подключения echo-check (в пустом состоянии ждать нечего).
  let connected = false;
  if (mode === 'empty') {
    await waitFor(win, `Boolean(document.querySelector('#mcpEmpty') && !document.querySelector('#mcpEmpty').hidden)`, { timeout: 15000, label: 'пустое состояние подключений' });
  } else {
    try { await waitForStatus(win, 'connected', 20000); connected = true; } catch { connected = false; }
  }
  // Режимам нужны конкретные состояния: детали/удаление — подключённый, drift — расхождение, ошибка — ошибка.
  if (mode === 'details' || mode === 'delete') { try { await waitForStatus(win, 'connected', 20000); } catch { /* снимок всё равно снимаем */ } }
  if (mode === 'drift') { try { await waitForStatus(win, 'drift', 20000); } catch { /* снимок всё равно снимаем */ } }
  if (mode === 'error') { try { await waitForStatus(win, 'error', 10000); } catch { /* останется каталог */ } }
  if (mode === 'qa') {
    // QA проверяет все четыре временных состояния — ждём, пока настоящий менеджер их установит.
    await waitFor(win, `(async () => {
      try {
        const st = await window.jarvis.mcpState();
        const s = (st && Array.isArray(st.servers)) ? st.servers : [];
        const has = (name, status) => s.some((x) => x && x.name === name && x.status === status);
        return has('echo-check', 'connected') && has('bad-path', 'error') && has('off-service', 'disabled') && has('drift-check', 'drift');
      } catch (e) { return false; }
    })()`, { timeout: 25000, interval: 250, label: 'четыре состояния временных сервисов' });
  }

  const action = await applyMode(win);
  if (action && action.ok === false) throw new Error(`режим ${mode}: ${action.error || 'не выполнен'}`);

  await js(win, `(() => { const v = document.querySelector('.view-mcp'); if (v) v.scrollTop = 0; window.scrollTo(0, 0); return true; })()`).catch(() => null);
  await sleep(waitMs);
  await waitFor(win, `document.querySelectorAll('#toasts .toast').length === 0`, { timeout: 5000, interval: 150, label: 'подсказки ушли' }).catch(() => null);
  if (!keepFocus) {
    await js(win, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`).catch(() => null);
  }
  await sleep(200);
  await settle(win).catch(() => null);

  const state = await readMcpState(win);
  const geometry = await readGeometry(win, { mode, connected });
  const windows = electron.BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible(), bounds: w.getBounds() }));

  if (mode === 'qa') {
    const qa = await runQa(win, { state, connected });
    finish({ ok: qa.failed === 0, mode: 'qa', qa, width, height, contentSize: { width: contentSize[0], height: contentSize[1] }, view: 'mcp', page, cleaned, ready, state, consoleErrors: consoleErrors.slice(), windowsCount: windows.length });
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
    mode,
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
    connected,
    state,
    geometryPath: dumpPath || null,
    geometry,
    rects: {
      '.app': geometry && geometry.elements['.app'] || null,
      '.rail': geometry && geometry.elements['.rail'] || null,
      '#mcpPage': geometry && geometry.elements['#mcpPage'] || null,
      '#mcpHead': geometry && geometry.elements['#mcpHead'] || null,
      '#mcpToolbar': geometry && geometry.elements['#mcpToolbar'] || null,
      '#mcpList .mcp-card:first-child': geometry && geometry.elements['#mcpList > *'] || null,
      '#mcpPopular': geometry && geometry.elements['#mcpPopular'] || null,
      '#mcpForm': geometry && geometry.elements['#mcpForm'] || null,
      '#mcpAddDialog': geometry && geometry.elements['#mcpAddDialog'] || null,
      '#mcpDetailsDialog': geometry && geometry.elements['#mcpDetailsDialog'] || null,
      '#mcpDeleteDialog': geometry && geometry.elements['#mcpDeleteDialog'] || null,
      '#mcpDriftDialog': geometry && geometry.elements['#mcpDriftDialog'] || null,
      '#mcpErrorDialog': geometry && geometry.elements['#mcpErrorDialog'] || null,
      '#mcpFilters .nox-chip-filter:first-child': geometry && geometry.elements['#mcpFilters button'] || null,
      '#mcpSearch': geometry && geometry.elements['#mcpSearch'] || null,
    },
    rows: geometry ? geometry.rows : null,
    windows,
    consoleErrors,
  });
}

// ── QA: сценарий по настоящему DOM и настоящему мосту ────────────
// Функции уезжают в окно через toString(): только DOM + window.jarvis, без Node.
async function qaConnPhase1Page(cfg) {
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
  const state = () => bridge('mcpState');
  const serverByName = (arr, name) => (arr || []).find((s) => s && s.name === name) || null;
  const cardByName = (name) => q('#mcpList .mcp-card[data-name="' + name + '"]');
  const closeDialog = (id) => { const d = q('#' + id); if (d && d.open && typeof d.close === 'function') d.close(); };
  const cancelDialog = (id) => { const d = q('#' + id); if (d) d.dispatchEvent(new Event('cancel', { cancelable: true })); };
  const reload = async () => { const b = q('#mcpReload'); if (b) b.click(); await sleep(450); };
  const rectOf = (sel) => { const el = q(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  const toastText = () => qa('#toasts .toast').map((t) => String(t.textContent || '')).join(' | ');
  const waitToast = (re, timeout) => until(() => re.test(toastText()) || window.__qaToasts.some((t) => re.test(String(t && t.text || ''))), timeout || 8000);

  // Собираем исходящие toast-события (и DOM-подсказки): по ним видно успех/ошибку действий.
  window.__qaToasts = [];
  document.addEventListener('jarvis:toast', (e) => { try { window.__qaToasts.push((e && e.detail) || {}); } catch (err) { /* пусто */ } });

  const checks = [];
  const check = async (name, fn) => {
    try { const r = await fn(); checks.push({ name, ok: Boolean(r && r.ok), detail: (r && r.detail) || '' }); }
    catch (err) { checks.push({ name, ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) }); }
  };

  await check('1. Раскладка 1200: рейка 52, панель ~1122×660 под общей шапкой, шапка 72, поиск 360, панель популярных 348, без переполнения', async () => {
    const innerW = innerWidth;
    const rail = rectOf('.rail');
    const panel = rectOf('#mcpPanel');
    const head = rectOf('#mcpHead');
    const search = rectOf('#mcpSearchWrap');
    const popular = rectOf('#mcpPopular');
    const listWrap = rectOf('#mcpListWrap');
    const scrollWidth = document.documentElement.scrollWidth;
    const ok = Boolean(rail && Math.abs(rail.w - 52) <= 2
      && panel && Math.abs(panel.w - 1122) <= 12 && Math.abs(panel.h - 660) <= 12
      && head && Math.abs(head.h - 72) <= 4
      && search && Math.abs(search.w - 360) <= 30
      && popular && Math.abs(popular.w - 348) <= 14
      && listWrap && listWrap.right <= innerW + 1
      && scrollWidth <= innerW + 1);
    return { ok, detail: 'rail=' + JSON.stringify(rail) + ' panel=' + JSON.stringify(panel) + ' head=' + JSON.stringify(head) + ' search=' + JSON.stringify(search) + ' popular=' + JSON.stringify(popular) + ' scrollWidth=' + scrollWidth };
  });

  await check('3. Четыре состояния: пилюли, строки и действия у всех временных сервисов', async () => {
    const st = await state();
    const servers = st && Array.isArray(st.servers) ? st.servers : [];
    const expect = {
      'echo-check': { status: 'connected', action: /Детали/i, pillNotConnectedIfBad: false },
      'drift-check': { status: 'drift', action: /Подтвердить изменения/i },
      'bad-path': { status: 'error', action: /Повторить/i },
      'off-service': { status: 'disabled', action: /Включить/i },
    };
    const parts = [];
    let ok = true;
    for (const [name, exp] of Object.entries(expect)) {
      const card = cardByName(name);
      const live = serverByName(servers, name);
      const pill = card ? String((card.querySelector('.mcp-pill') || {}).textContent || '').trim() : '';
      const line = card ? String((card.querySelector('.mcp-line') || {}).textContent || '').trim() : '';
      const action = card ? String((card.querySelector('.mcp-card-action, button') || {}).textContent || '').trim() : '';
      const status = card ? card.getAttribute('data-status') : '';
      const good = Boolean(card && live && live.status === exp.status && status === exp.status && exp.action.test(action) && line.length > 0);
      if (!good) ok = false;
      parts.push(name + ': status=' + status + ' pill="' + pill + '" line="' + line.slice(0, 60) + '" action="' + action + '"');
      if ((exp.status === 'error' || exp.status === 'disabled') && /Подключ[её]н/.test(pill)) ok = false;
    }
    return { ok, detail: parts.join(' || ') };
  });

  await check('4. Поиск «echo» сужает карточки и популярные, сброс возвращает', async () => {
    const st = await state();
    const totalCards = st && Array.isArray(st.servers) ? st.servers.length : 0;
    const beforePopular = qa('#mcpPopularList .mcp-popular-row').length;
    const input = q('#mcpSearch');
    if (!input) return { ok: false, detail: 'нет #mcpSearch' };
    input.value = 'echo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    const cards = qa('#mcpList .mcp-card');
    const popular = qa('#mcpPopularList .mcp-popular-row');
    const narrowCards = cards.length > 0 && cards.length < totalCards;
    const narrowPopular = popular.length < beforePopular;
    const reset = q('#mcpResetFilters');
    reset.click();
    await sleep(350);
    // Список популярных перерисовывается общим опросом (до 3 с): ждём восстановления, а не только синхронного сброса.
    let restoredCards = qa('#mcpList .mcp-card').length === totalCards;
    let restoredPopular = qa('#mcpPopularList .mcp-popular-row').length === beforePopular;
    for (let i = 0; i < 20 && !(restoredCards && restoredPopular); i += 1) {
      await sleep(250);
      restoredCards = qa('#mcpList .mcp-card').length === totalCards;
      restoredPopular = qa('#mcpPopularList .mcp-popular-row').length === beforePopular;
    }
    return { ok: narrowCards && narrowPopular && restoredCards && restoredPopular, detail: 'карточек ' + totalCards + '→' + cards.length + ' популярных ' + beforePopular + '→' + popular.length + ' сброс карточек=' + restoredCards + ' сброс популярных=' + restoredPopular + ' (популярные обновляет опрос до 3 с)' };
  });

  await check('5. Фильтры: каждый чип сужает правильно, счётчики обновляются, «Все» возвращает', async () => {
    const st = await state();
    const servers = st && Array.isArray(st.servers) ? st.servers : [];
    const clickFilter = async (f) => {
      const chip = q('#mcpFilters [data-filter="' + f + '"]');
      if (!chip) throw new Error('нет чипа ' + f);
      chip.click();
      await sleep(280);
      return {
        statuses: qa('#mcpList .mcp-card').map((c) => c.getAttribute('data-status')),
        pressed: chip.getAttribute('aria-pressed'),
        countText: String((chip.querySelector('.mcp-filter-count') || {}).textContent || '').trim(),
      };
    };
    const conn = await clickFilter('connected');
    const off = await clickFilter('disabled');
    const err = await clickFilter('error');
    const all = await clickFilter('all');
    const expectConnected = servers.filter((s) => ['connected', 'connecting', 'drift'].includes(s.status)).length;
    const expectOff = servers.filter((s) => s.status === 'disabled').length;
    const expectErr = servers.filter((s) => s.status === 'error').length;
    const ok = conn.pressed === 'true' && conn.statuses.every((s) => ['connected', 'connecting', 'drift'].includes(s))
      && off.statuses.every((s) => s === 'disabled')
      && err.statuses.every((s) => s === 'error')
      && all.statuses.length === servers.length
      && conn.countText === String(expectConnected)
      && off.countText === String(expectOff)
      && err.countText === String(expectErr);
    return { ok, detail: 'connected=' + conn.statuses.length + '/' + expectConnected + ' disabled=' + off.statuses.length + '/' + expectOff + ' error=' + err.statuses.length + '/' + expectErr + ' all=' + all.statuses.length };
  });

  await check('17. Поиск не теряется при переключении фильтра', async () => {
    const input = q('#mcpSearch');
    if (!input) return { ok: false, detail: 'нет #mcpSearch' };
    input.value = 'echo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(250);
    const before = q('#mcpSearch').value;
    const chip = q('#mcpFilters [data-filter="connected"]');
    if (!chip) return { ok: false, detail: 'нет чипа connected' };
    chip.click();
    await sleep(300);
    const after = q('#mcpSearch').value;
    const cards = qa('#mcpList .mcp-card');
    const reset = q('#mcpResetFilters');
    reset.click();
    await sleep(500);
    return { ok: before === 'echo' && after === 'echo' && cards.length > 0, detail: 'до фильтра="' + before + '" после="' + after + '" карточек при поиске+фильтре=' + cards.length };
  });

  await check('6. Детали: клик по карточке открывает диалог, «Действия сервиса (2)», разрешения, переключатель отражает состояние, Escape закрывает и возвращает фокус', async () => {
    const card = cardByName('echo-check');
    if (!card) return { ok: false, detail: 'нет карточки echo-check' };
    card.click();
    await until(() => visible(q('#mcpDetailsDialog')), 8000);
    const body = q('#mcpDetailsBody');
    const text = body ? String(body.textContent || '') : '';
    const hasName = text.includes('echo-check');
    const hasTarget = /node/i.test(text);
    const hasTools = /Действия сервиса \(2\)/.test(text);
    const hasPerms = /Разрешения/.test(text);
    const sw = q('#mcpDetailsBody input.switch');
    const toggleOn = Boolean(sw && sw.checked);
    cancelDialog('mcpDetailsDialog');
    await until(() => !(q('#mcpDetailsDialog') && q('#mcpDetailsDialog').open), 5000);
    await sleep(200);
    const focusBack = document.activeElement === card;
    return { ok: hasName && hasTarget && hasTools && hasPerms && toggleOn && focusBack, detail: 'имя=' + hasName + ' цель=' + hasTarget + ' действия(2)=' + hasTools + ' разрешения=' + hasPerms + ' switch=' + toggleOn + ' фокусНаКарточке=' + focusBack };
  });

  await check('7. Переключатель в деталях: выключение отражается в пилюле/строке/действии, включение возвращает', async () => {
    const st0 = await state();
    const before = serverByName(st0.servers, 'echo-check');
    if (!before) return { ok: false, detail: 'нет echo-check в ядре' };
    const card = cardByName('echo-check');
    card.click();
    await until(() => visible(q('#mcpDetailsDialog')), 8000);
    q('#mcpDetailsBody input.switch').click();
    await until(async () => {
      const st = await state();
      const s = serverByName(st.servers, 'echo-check');
      return s && s.status === 'disabled';
    }, 12000);
    await sleep(350);
    const offCard = cardByName('echo-check');
    const offPill = offCard ? String((offCard.querySelector('.mcp-pill') || {}).textContent || '').trim() : '';
    const offLine = offCard ? String((offCard.querySelector('.mcp-line') || {}).textContent || '').trim() : '';
    const offAction = offCard ? String((offCard.querySelector('.mcp-card-action, button') || {}).textContent || '').trim() : '';
    const offOk = offPill === 'Выключен' && /выключ/i.test(offLine) && /Включить/i.test(offAction);
    // Вернуть включённым: переключатель в открытых деталях в состоянии "выключен" — щёлкаем ещё раз.
    const sw = q('#mcpDetailsBody input.switch');
    if (sw) sw.click();
    else {
      const cardAgain = cardByName('echo-check');
      if (cardAgain) { cardAgain.click(); await until(() => visible(q('#mcpDetailsDialog')), 6000); q('#mcpDetailsBody input.switch').click(); }
    }
    await until(async () => {
      const st = await state();
      const s = serverByName(st.servers, 'echo-check');
      return s && s.status === 'connected';
    }, 15000);
    closeDialog('mcpDetailsDialog');
    await sleep(300);
    const onCard = cardByName('echo-check');
    const onAction = onCard ? String((onCard.querySelector('.mcp-card-action, button') || {}).textContent || '').trim() : '';
    return { ok: offOk && /Детали/i.test(onAction), detail: 'выкл: pill="' + offPill + '" line="' + offLine.slice(0, 60) + '" action="' + offAction + '"; вернули action="' + onAction + '"' };
  });

  await check('8. Добавление: #mcpAddSubmit заблокирован до валидных данных, затем реальный qa-service подключается и удаляется через детали', async () => {
    const addBtn = q('#mcpAddBtn');
    if (!addBtn) return { ok: false, detail: 'нет #mcpAddBtn' };
    addBtn.click();
    await until(() => visible(q('#mcpAddDialog')), 8000);
    const disabledEmpty = Boolean(q('#mcpAddSubmit') && q('#mcpAddSubmit').disabled);
    const name = q('#mcpName');
    const target = q('#mcpTarget');
    const args = q('#mcpArgs');
    name.value = 'плохое имя!';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    target.value = cfg.nodeCommand;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    const disabledBad = Boolean(q('#mcpAddSubmit') && q('#mcpAddSubmit').disabled);
    name.value = 'qa-service';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    args.value = cfg.echoPath;
    args.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => q('#mcpAddSubmit') && !q('#mcpAddSubmit').disabled, 5000);
    q('#mcpAddSubmit').click();
    await until(() => !(q('#mcpAddDialog') && q('#mcpAddDialog').open), 15000);
    await until(async () => {
      const st = await state();
      const s = serverByName(st.servers, 'qa-service');
      return s && s.status === 'connected';
    }, 15000);
    await waitToast(/подключ[её]н/i, 8000).catch(() => null);
    await reload();
    const card = await until(() => cardByName('qa-service'), 8000);
    const connectedCard = card.getAttribute('data-status') === 'connected';
    // Удаление через детали: ввод точного имени, подтверждение.
    card.click();
    await until(() => visible(q('#mcpDetailsDialog')), 8000);
    q('#mcpDetailsDelete').click();
    await until(() => visible(q('#mcpDeleteDialog')), 8000);
    const input = q('#mcpDeleteInput');
    input.value = 'qa-service';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => q('#mcpDeleteConfirm') && !q('#mcpDeleteConfirm').disabled, 5000);
    q('#mcpDeleteConfirm').click();
    await until(() => !(q('#mcpDeleteDialog') && q('#mcpDeleteDialog').open), 10000);
    await sleep(400);
    const goneFromDom = !cardByName('qa-service');
    const st = await state();
    const goneFromBridge = !serverByName(st.servers, 'qa-service');
    return { ok: disabledEmpty && disabledBad && connectedCard && goneFromDom && goneFromBridge, detail: 'пусто=' + disabledEmpty + ' невалид=' + disabledBad + ' connected=' + connectedCard + ' удалён из DOM=' + goneFromDom + ' из ядра=' + goneFromBridge + ' toast="' + toastText().slice(0, 100) + '"' };
  });

  await check('9. Удаление: подтверждение заблокировано до точного имени, Escape закрывает без удаления', async () => {
    await bridge('mcpAdd', 'qa-del', cfg.nodeCommand, cfg.echoPath);
    await sleep(400);
    await reload();
    const card = await until(() => cardByName('qa-del'), 8000);
    card.click();
    await until(() => visible(q('#mcpDetailsDialog')), 8000);
    q('#mcpDetailsDelete').click();
    await until(() => visible(q('#mcpDeleteDialog')), 8000);
    const input = q('#mcpDeleteInput');
    input.value = 'wrong-name';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    const blockedWrong = Boolean(q('#mcpDeleteConfirm') && q('#mcpDeleteConfirm').disabled);
    input.value = 'qa-del';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    const enabledRight = Boolean(q('#mcpDeleteConfirm') && !q('#mcpDeleteConfirm').disabled);
    cancelDialog('mcpDeleteDialog');
    await until(() => !(q('#mcpDeleteDialog') && q('#mcpDeleteDialog').open), 5000);
    closeDialog('mcpDetailsDialog');
    await sleep(250);
    const st = await state();
    const stillThere = Boolean(serverByName(st.servers, 'qa-del'));
    try { await bridge('mcpRemove', 'qa-del'); } catch (err) { /* уборка */ }
    await reload();
    return { ok: blockedWrong && enabledRight && stillThere, detail: 'чужое имя блокирует=' + blockedWrong + ' своё разрешает=' + enabledRight + ' после Escape сервис на месте=' + stillThere };
  });

  await check('10. Изменения набора действий: чипы +/− в карточке и диалоге, подтверждение переводит в connected с toast', async () => {
    const card = cardByName('drift-check');
    if (!card) return { ok: false, detail: 'нет карточки drift-check' };
    const kinds = qa('#mcpList .mcp-card[data-name="drift-check"] .mcp-diff-chip').map((c) => c.getAttribute('data-kind'));
    const hasPlus = kinds.includes('+') || kinds.some((k) => /add|\+/i.test(String(k)));
    const hasMinus = kinds.includes('−') || kinds.includes('-') || kinds.some((k) => /remove|−|-/i.test(String(k)));
    const btn = card.querySelector('.mcp-card-action-warn') || card.querySelector('.mcp-card-action');
    if (!btn) return { ok: false, detail: 'нет кнопки «Подтвердить изменения»' };
    btn.click();
    await until(() => visible(q('#mcpDriftDialog')), 8000);
    const dialogChips = qa('#mcpDriftBody .mcp-diff-chip').length;
    q('#mcpDriftConfirm').click();
    await until(async () => {
      const st = await state();
      const s = serverByName(st.servers, 'drift-check');
      return s && s.status === 'connected';
    }, 12000);
    await sleep(350);
    const closed = !(q('#mcpDriftDialog') && q('#mcpDriftDialog').open);
    const toast = /подтвержд/i.test(toastText());
    return { ok: hasPlus && hasMinus && dialogChips > 0 && closed && toast, detail: 'kinds=' + JSON.stringify(kinds) + ' чипов в диалоге=' + dialogChips + ' закрыт=' + closed + ' toast=' + toast };
  });

  await check('11. Ошибка: «Повторить» у bad-path остаётся ошибкой и показывает честную причину в #mcpErrorDialog', async () => {
    const card = cardByName('bad-path');
    if (!card) return { ok: false, detail: 'нет карточки bad-path' };
    const btn = card.querySelector('.mcp-card-action-err') || card.querySelector('.mcp-card-action');
    if (!btn) return { ok: false, detail: 'нет кнопки «Повторить»' };
    btn.click();
    await until(() => visible(q('#mcpErrorDialog')), 12000);
    const reason = String((q('#mcpConnErrReason') || {}).textContent || '');
    const st = await state();
    const live = serverByName(st.servers, 'bad-path');
    const stillError = Boolean(live && live.status === 'error');
    q('#mcpConnErrClose').click();
    await until(() => !(q('#mcpErrorDialog') && q('#mcpErrorDialog').open), 5000);
    await sleep(600);
    const active = document.activeElement;
    const activeDesc = active ? ((active.id ? '#' + active.id : '') + (active.className ? '.' + String(active.className).split(/\s+/).slice(0, 2).join('.') : '') || active.tagName) : 'null';
    // После перерисовки карточек прежняя кнопка может стать отсоединённой: фокус обязан вернуться в список.
    const focusBack = Boolean(active && (active === btn || (card.contains && card.contains(active)) || q('#mcpList') && q('#mcpList').contains(active)));
    return { ok: stillError && /ENOENT|не найдена|не запустил/i.test(reason) && focusBack, detail: 'статус=' + (live ? live.status : 'нет') + ' причина="' + reason.slice(0, 120) + '" фокус=' + activeDesc + ' вернулся=' + focusBack };
  });

  await check('12. Популярные: 10 строк, 7 доступны с «+ Добавить», 3 требуют настройки (не нажимаем)', async () => {
    const rows = qa('#mcpPopularList .mcp-popular-row');
    const addButtons = qa('#mcpPopularList .mcp-popular-add');
    const available = addButtons.filter((b) => !b.disabled && /добав/i.test(String(b.textContent || '')));
    const unavailable = addButtons.filter((b) => b.disabled && /настроен|не настроено|нужен/i.test(String(b.textContent || '')));
    const ok = rows.length === 10 && available.length === 7 && unavailable.length === 3;
    return { ok, detail: 'строк=' + rows.length + ' доступны=' + available.length + ' не настроены=' + unavailable.length + ' (кликов не было)' };
  });

  await check('13. Escape в диалоге добавления: закрывает и возвращает фокус на #mcpAddBtn', async () => {
    const addBtn = q('#mcpAddBtn');
    const focusedBefore = document.activeElement;
    addBtn.click();
    await until(() => visible(q('#mcpAddDialog')), 8000);
    cancelDialog('mcpAddDialog');
    await until(() => !(q('#mcpAddDialog') && q('#mcpAddDialog').open), 5000);
    await sleep(250);
    const focusBack = document.activeElement === addBtn;
    return { ok: focusBack, detail: 'фокус на #mcpAddBtn=' + focusBack + ' (до открытия=' + Boolean(focusedBefore) + ')' };
  });

  await check('15. Чат и «Команды» целы, возврат в «Подключения» без ошибок', async () => {
    window.JarvisNox.show('nox');
    await until(() => document.body.dataset.view === 'nox' && visible(q('.nox-grid')), 10000);
    const grid = visible(q('.nox-grid'));
    const noxChat = visible(q('#noxChat'));
    const feed = Boolean(q('#feed'));
    const composer = Boolean(q('#composer'));
    window.JarvisNox.show('commands');
    await until(() => document.body.dataset.view === 'commands' && visible(q('#cmdCatalog')), 10000);
    const cmdCatalog = visible(q('#cmdCatalog'));
    window.JarvisNox.show('mcp');
    await until(() => document.body.dataset.view === 'mcp' && visible(q('#mcpPage')) && qa('#mcpList .mcp-card').length > 0, 10000);
    const back = visible(q('#mcpPage'));
    return { ok: grid && noxChat && feed && composer && cmdCatalog && back, detail: '.nox-grid=' + grid + ' #noxChat=' + noxChat + ' #feed=' + feed + ' #composer=' + composer + ' #cmdCatalog=' + cmdCatalog + ' назад=' + back };
  });

  // Уборка временных сервисов, созданных проверками.
  try {
    const st = await state();
    for (const s of st.servers || []) {
      if (/^qa-/.test(s.name)) { try { await bridge('mcpRemove', s.name); } catch (err) { /* пусто */ } }
    }
    await reload();
  } catch (err) { /* уборка не критична */ }

  return { checks };
}

async function qaConnPhase2Page() {
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, timeout, step) => {
    const end = Date.now() + (timeout || 8000);
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v; } catch (err) { /* ждём */ }
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
  const closeDialog = (id) => { const d = q('#' + id); if (d && d.open && typeof d.close === 'function') d.close(); };
  const rectOf = (sel) => { const el = q(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  const checks = [];
  const innerW = innerWidth;
  const innerH = innerHeight;
  const check = async (name, fn) => {
    try { const r = await fn(); checks.push({ name, ok: Boolean(r && r.ok), detail: (r && r.detail) || '' }); }
    catch (err) { checks.push({ name, ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) }); }
  };

  for (const id of ['mcpAddDialog', 'mcpDetailsDialog', 'mcpDeleteDialog', 'mcpDriftDialog', 'mcpErrorDialog']) closeDialog(id);
  await sleep(250);

  await check('2. 864×520: scrollWidth=864, популярные под списком, нет переполнения', async () => {
    const scrollWidth = document.documentElement.scrollWidth;
    const listWrap = rectOf('#mcpListWrap');
    const popular = rectOf('#mcpPopular');
    const samples = ['#mcpPage', '#mcpPanel', '#mcpToolbar', '#mcpList'].map((sel) => ({ sel, rect: rectOf(sel) }));
    const noOverflow = samples.every((s) => !s.rect || s.rect.right <= innerW + 1);
    const underList = Boolean(listWrap && popular && popular.y >= listWrap.bottom - 1);
    const ok = scrollWidth <= innerW + 1 && innerW === 864 && innerH === 520 && noOverflow && underList;
    return { ok, detail: 'inner=' + innerW + 'x' + innerH + ' scrollWidth=' + scrollWidth + ' listBottom=' + (listWrap ? listWrap.bottom : 'null') + ' popularY=' + (popular ? popular.y : 'null') + ' popularW=' + (popular ? popular.w : 'null') + ' образцы=' + JSON.stringify(samples) };
  });

  await check('2b. 864×520: диалог деталей 480×520 внутри окна', async () => {
    const card = q('#mcpList .mcp-card[data-name="echo-check"]');
    if (!card) return { ok: false, detail: 'нет карточки echo-check' };
    card.click();
    await until(() => visible(q('#mcpDetailsDialog')), 8000);
    await sleep(250);
    const dlg = q('#mcpDetailsDialog');
    const r = dlg.getBoundingClientRect();
    const rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    const ok = rect.x >= -1 && rect.y >= -1 && rect.right <= innerW + 1 && rect.bottom <= innerH + 1 && Math.abs(rect.w - 480) <= 20;
    closeDialog('mcpDetailsDialog');
    await sleep(200);
    return { ok, detail: 'диалог=' + JSON.stringify(rect) };
  });

  return { checks };
}

// Пустое состояние на 1200: сервисов нет, видна заглушка #mcpEmpty, популярные на месте.
async function qaConnEmptyPage() {
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, timeout, step) => {
    const end = Date.now() + (timeout || 10000);
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v; } catch (err) { /* ждём */ }
      await sleep(step || 120);
    }
    throw new Error('не дождались пустого состояния');
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const bridge = (name, ...args) => window.jarvis[name](...args);
  const state = () => bridge('mcpState');
  const checks = [];
  const check = async (name, fn) => {
    try { const r = await fn(); checks.push({ name, ok: Boolean(r && r.ok), detail: (r && r.detail) || '' }); }
    catch (err) { checks.push({ name, ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) }); }
  };

  await check('16. Пустое состояние: #mcpEmpty виден, 0 карточек, популярные с «+ Добавить»', async () => {
    // Убираем все временные сервисы через настоящее ядро: получаем то же, что при пустых настройках.
    const st0 = await state();
    for (const s of st0.servers || []) {
      try { await bridge('mcpRemove', s.name); } catch (err) { /* уже удалён */ }
    }
    await until(async () => { const st = await state(); return st && Array.isArray(st.servers) && st.servers.length === 0; }, 12000);
    const reload = q('#mcpReload');
    if (reload) reload.click();
    await sleep(700);
    await until(() => visible(q('#mcpEmpty')), 8000);
    const emptyVisible = visible(q('#mcpEmpty'));
    const cards = qa('#mcpList .mcp-card').length;
    const popularRows = qa('#mcpPopularList .mcp-popular-row').length;
    const addButtons = qa('#mcpPopularList .mcp-popular-add');
    const available = addButtons.filter((b) => !b.disabled && /добав/i.test(String(b.textContent || ''))).length;
    const unavailable = addButtons.filter((b) => b.disabled).length;
    return { ok: emptyVisible && cards === 0 && popularRows === 10 && available === 7 && unavailable === 3, detail: 'заглушка=' + emptyVisible + ' карточек=' + cards + ' популярных=' + popularRows + ' доступны=' + available + ' не настроены=' + unavailable };
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

async function runQa(win, ctx) {
  const checks = [];
  try {
    const phase1 = await js(win, `(${qaConnPhase1Page.toString()})(${JSON.stringify({ nodeCommand, echoPath })})`);
    checks.push(...((phase1 && phase1.checks) || []));
  } catch (err) {
    checks.push({ name: 'qa: сценарий 1–13, 15', ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
  }

  try {
    await setContentSize(win, 864, 520);
    const phase2 = await js(win, `(${qaConnPhase2Page.toString()})()`);
    checks.push(...((phase2 && phase2.checks) || []));
  } catch (err) {
    checks.push({ name: 'qa: сценарий 2 (864x520)', ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
  }
  try { await setContentSize(win, width, height); } catch { /* окно могли закрыть */ }

  // Пустое состояние проверяем на 1200, когда геометрия и данные уже стабильны.
  try {
    const empty = await js(win, `(${qaConnEmptyPage.toString()})()`);
    checks.push(...((empty && empty.checks) || []));
  } catch (err) {
    checks.push({ name: '16. Пустое состояние', ok: false, detail: 'ошибка: ' + String(err && err.message ? err.message : err) });
  }

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
    capture(win).catch((err) => finish({ ok: false, error: err && err.message ? err.message : String(err) }));
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
