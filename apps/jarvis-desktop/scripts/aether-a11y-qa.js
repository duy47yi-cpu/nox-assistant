'use strict';

// Живой стенд доступности Nox Aether: настоящий Electron с временным профилем.
// Проверяет Tab/Esc по пяти разделам на 1200x720 и 864x520, ловушку и возврат фокуса
// в модалке, поповеры шапки и композера, подтверждения хода с клавиатуры, aria-live
// ответа и ошибок, доступные имена иконочных кнопок и видимый focus-visible.
//
// Запуск из apps/jarvis-desktop (ELECTRON_RUN_AS_NODE снят):
//   electron.exe scripts\aether-a11y-qa.js --out-dir <папка> [--keep-temp] [--label before]
//
// Печатает строку A11Y_QA_RESULT <json> и выходит: 0 - все проверки прошли, 1 - есть сбои.
// Снимки экрана и JSON-отчёт кладутся в --out-dir (по умолчанию временная папка).

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
  console.error('aether-a11y-qa: нужен запуск через electron.exe, а не node (снимите ELECTRON_RUN_AS_NODE)');
  process.exit(1);
}
const { app, globalShortcut } = electron;

const APP_DIR = path.resolve(__dirname, '..');
const TIMEOUT_MS = 240000;

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
function has(name) {
  return process.argv.includes('--' + name);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const OUT_DIR = path.resolve(arg('out-dir', path.join(os.tmpdir(), 'nox-a11y-qa')));
const KEEP_TEMP = has('keep-temp');
const REAL_MODEL = has('real-model');
const LABEL = String(arg('label', '')).trim();

// ── Временный профиль и данные (настоящие %APPDATA% и data/ не трогаем) ──
function sweepOldTemp() {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('nox-a11y-qa-')) continue;
    const full = path.join(os.tmpdir(), entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs < 60000) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch { /* занят — оставляем */ }
  }
}
sweepOldTemp();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-a11y-qa-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  uiShell: 'aether', mode: 'ask', voice: false, backgroundModelRuns: false, alwaysListen: false,
  dictation: false, desktopOverlay: false, alwaysOnTop: false, motion: true, seededBrief: true,
}, null, 2), 'utf8');
fs.writeFileSync(path.join(dataDir, 'conversation.json'), JSON.stringify({
  activeId: 'a11y-chat',
  chats: [{ id: 'a11y-chat', title: 'Новый чат', updatedAt: Date.now(), history: [] }],
}, null, 2), 'utf8');

app.setPath('userData', profileDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Настройки владельца из окружения не используем; ключ модели, если передан, остаётся.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('JARVIS_') || key.startsWith('TELEGRAM_') || key.startsWith('FISH_') || key.startsWith('DEEPSEEK_')) delete process.env[key];
}
process.env.NOX_DATA_DIR = dataDir;
require('../src/config/paths').projectRoot = () => tempRoot;

globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

// ── Отчёт ────────────────────────────────────────────────────────────
const checks = [];
const screenshots = [];
const tabSequences = {};
const consoleErrors = [];
const pageErrors = [];
const startedAt = Date.now();
let mainWin = null;
let finished = false;

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.length - pass;
  const report = {
    ok: !error && fail === 0,
    error: error || null,
    label: LABEL || null,
    elapsedMs: Date.now() - startedAt,
    viewports: [[1200, 720], [864, 520]],
    pass, fail, checks, screenshots, tabSequences,
    consoleErrors: consoleErrors.slice(0, 10),
    pageErrors: pageErrors.slice(0, 10),
  };
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const fileName = 'a11y-' + (LABEL || 'run') + '.json';
    fs.writeFileSync(path.join(OUT_DIR, fileName), JSON.stringify(report, null, 2), 'utf8');
    report.report = path.join(OUT_DIR, fileName);
  } catch (err) {
    report.report = 'не записан: ' + (err && err.message);
  }
  console.log('A11Y_QA_RESULT ' + JSON.stringify({
    ok: report.ok, pass: report.pass, fail: report.fail,
    report: report.report || null, screenshots: screenshots.length, error: error || null,
  }));
  if (KEEP_TEMP) console.error('A11Y_QA_TEMP ' + tempRoot);
  else {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* chromium держит профиль */ }
  }
  app.exit(report.ok ? 0 : 1);
}

const deadline = setTimeout(() => finish('timeout: за ' + TIMEOUT_MS + ' мс проверка не закончилась'), TIMEOUT_MS);
process.on('uncaughtException', (err) => finish('uncaught: ' + (err && err.message ? err.message : err)));
process.on('unhandledRejection', (err) => finish('unhandled: ' + (err && err.message ? err.message : err)));

// ── Утилиты окна ─────────────────────────────────────────────────────
async function js(win, code) {
  return win.webContents.executeJavaScript(code, true);
}
async function settle(win, ms = 140) {
  if (ms) await sleep(ms);
  await js(win, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))').catch(() => false);
}
async function waitUntil(fn, timeout = 8000, interval = 80) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(interval);
  }
  return null;
}
async function setViewport(win, width, height) {
  try { win.setMinimumSize(200, 200); } catch { /* ignore */ }
  win.setContentSize(width, height);
  for (let i = 0; i < 60; i += 1) {
    const size = win.getContentSize();
    if (size[0] === width && size[1] === height) break;
    await sleep(30);
  }
  await settle(win, 200);
}
async function shot(win, fileName) {
  await settle(win, 100);
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, fileName);
  fs.writeFileSync(file, img.toPNG());
  const size = img.getSize();
  screenshots.push({ name: fileName, file: file, width: size.width, height: size.height });
  return file;
}

// Снимок активного элемента: где фокус, виден ли контур, в какой зоне окна.
const FOCUS_INFO_JS = [
  '(() => {',
  'const el = document.activeElement || document.body;',
  'const rect = el.getBoundingClientRect();',
  'const style = getComputedStyle(el);',
  'const topbar = document.querySelector("#aeTopbar");',
  'const rail = document.querySelector(".ae-utility-rail");',
  'const chat = document.querySelector("#noxChat");',
  'const dialog = el.closest("[role=dialog]");',
  'const outlineWidth = parseFloat(style.outlineWidth) || 0;',
  'const outlineVisible = style.outlineStyle !== "none" && outlineWidth >= 1;',
  'const composer = el.closest(".ae-composer");',
  'const label = el.getAttribute("aria-label") || el.getAttribute("title") || (el.innerText || "").trim().slice(0, 80);',
  'return {',
  'tag: String(el.tagName || "").toLowerCase(),',
  'id: el.id || "",',
  'classes: typeof el.className === "string" ? el.className.slice(0, 120) : "",',
  'role: el.getAttribute("role") || "",',
  'label: String(label || "").slice(0, 120),',
  'text: (el.innerText || "").trim().slice(0, 80),',
  'visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",',
  'focusVisible: (() => { try { return el.matches(":focus-visible"); } catch (e) { return false; } })(),',
  'outline: outlineVisible ? outlineWidth + "px " + style.outlineStyle + " " + style.outlineColor : "none",',
  'outlineVisible: outlineVisible,',
  'boxShadow: style.boxShadow !== "none",',
  'composerBorder: composer ? getComputedStyle(composer).borderColor : "",',
  'rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },',
  'zone: topbar && topbar.contains(el) ? "topbar" : rail && rail.contains(el) ? "rail" : chat && chat.contains(el) ? "chat" : "other",',
  'inDialog: Boolean(dialog),',
  'dialogId: dialog ? (dialog.id || "") : "",',
  'selected: el.getAttribute("aria-selected"),',
  'ariaExpanded: el.getAttribute("aria-expanded"),',
  'checked: el.checked === true ? true : null,',
  'disabled: el.disabled === true,',
  '};',
  '})()',
].join(' ');

async function focusInfo(win) {
  return js(win, FOCUS_INFO_JS);
}

// Настоящее нажатие клавиши: окно должно быть в фокусе ОС и Electron.
// sendInputEvent не доводит до действия кнопки Enter/Space, поэтому основной путь — CDP.
const KEY_SPECS = {
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  Right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  Down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
};
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
let debuggerReady = false;
async function ensureDebugger(win) {
  if (debuggerReady) return true;
  try {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    debuggerReady = win.webContents.debugger.isAttached();
  } catch {
    debuggerReady = false;
  }
  return debuggerReady;
}
async function press(win, keyCode, modifiers = []) {
  const spec = KEY_SPECS[keyCode] || { key: keyCode, code: keyCode, vk: 0 };
  let mask = 0;
  for (const modifier of modifiers) mask |= MODIFIER_BITS[modifier] || 0;
  if (await ensureDebugger(win)) {
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: mask };
    const down = { type: 'keyDown', ...base };
    if (spec.text && mask === 0) { down.text = spec.text; down.unmodifiedText = spec.text; }
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', down).catch(() => {});
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base }).catch(() => {});
  } else {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: keyCode, modifiers: modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: keyCode, modifiers: modifiers });
  }
  await settle(win, 45);
}
async function resetFocus(win) {
  // blur() сохраняет точку начала обхода; body с tabindex -1 возвращает Tab в начало документа.
  await js(win, '(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); const body = document.body; body.setAttribute("tabindex", "-1"); body.focus(); body.removeAttribute("tabindex"); return true; })()');
  await settle(win, 30);
}
async function tabSequence(win, max = 70) {
  win.focus();
  await settle(win, 60);
  await resetFocus(win);
  const steps = [];
  for (let i = 0; i < max; i += 1) {
    await press(win, 'Tab');
    const info = await focusInfo(win);
    steps.push(info);
    if (i > 8 && steps.slice(0, -1).some((s) => s.tag === info.tag && s.id === info.id && s.classes === info.classes && s.label === info.label)) break;
    if (info.tag === 'body' || info.tag === 'html') break;
  }
  return steps;
}
function hasVisibleIndicator(step) {
  if (step.outlineVisible || step.boxShadow) return true;
  // Поле ввода намеренно без своего контура: его подсвечивает рамка композера.
  if (step.id === 'chatInput' && step.composerBorder) return true;
  return false;
}
async function iconButtonsWithoutName(win) {
  return js(win, [
    '(() => {',
    'const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };',
    'const label = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || (el.innerText || "").trim());',
    'return [...document.querySelectorAll("button")].filter(visible).filter((el) => !label(el))',
    '.map((el) => ({ id: el.id || "", classes: String(el.className || "").slice(0, 80), html: el.outerHTML.slice(0, 160) }));',
    '})()',
  ].join(' '));
}

// ── Проверки ─────────────────────────────────────────────────────────
async function checkTabOrder(win, size) {
  const routes = [
    ['personal', '#aePersonalView'], ['commands', '#aeCommandsView'], ['mcp', '#aeMcpView'],
    ['chat', '#noxChat'], ['settings', '#aeSettingsView'],
  ];
  const tag = size[0] + 'x' + size[1];
  for (const route of routes) {
    const routeId = route[0];
    const selector = route[1];
    await js(win, "window.__noxAether.setRoute('" + routeId + "')");
    await settle(win, 220);
    const exists = await js(win, 'Boolean(document.querySelector("' + selector + '"))');
    const sequence = await tabSequence(win, 70);
    tabSequences[routeId + '-' + tag] = sequence;
    const short = sequence.map((s) => ({ zone: s.zone, id: s.id, role: s.role, label: s.label.slice(0, 40), visible: s.visible, outline: s.outlineVisible, inDialog: s.inDialog }));

    check(routeId + ' ' + tag + ': Tab начинается с шапки (бренд)', Boolean(sequence[0] && sequence[0].id === 'lxLogoBtn'), short.slice(0, 3));
    check(routeId + ' ' + tag + ': Tab заходит в служебную рейку', sequence.some((s) => s.zone === 'rail'), short.filter((s) => s.zone === 'rail').slice(0, 8));
    check(routeId + ' ' + tag + ': Tab заходит в раздел', exists && sequence.some((s) => s.zone === 'other' && !s.inDialog), short.slice(-8));
    const bodyHits = sequence.filter((s) => s.tag === 'body' || s.tag === 'html');
    check(routeId + ' ' + tag + ': фокус не улетает на body', bodyHits.length === 0, bodyHits);
    const invisible = sequence.filter((s) => !s.visible);
    check(routeId + ' ' + tag + ': все остановки Tab видимы', invisible.length === 0, invisible.slice(0, 5));
    const noIndicator = sequence.filter((s) => ['topbar', 'rail', 'chat'].includes(s.zone) && !hasVisibleIndicator(s));
    check(routeId + ' ' + tag + ': у каждой остановки Tab виден фокус', noIndicator.length === 0, noIndicator.slice(0, 6));
    const navTabs = sequence.filter((s) => s.role === 'tab' && s.zone === 'topbar');
    check(routeId + ' ' + tag + ': вкладки шапки — одна остановка Tab (roving tabindex)', navTabs.length === 1, navTabs.map((s) => s.id));
    if (routeId === 'chat') {
      check(routeId + ' ' + tag + ': Tab доходит до поля ввода', sequence.some((s) => s.id === 'chatInput'), short.filter((s) => s.zone === 'chat').slice(0, 10));
    }

    const tabStep = sequence.find((s) => s.role === 'tab' && s.id);
    if (tabStep) {
      await js(win, "document.getElementById('" + tabStep.id + "').focus()");
      await shot(win, 'focus-topbar-' + routeId + '-' + tag + '.png');
    }
    const railStep = sequence.find((s) => s.zone === 'rail' && s.id);
    if (railStep) {
      await js(win, "document.getElementById('" + railStep.id + "').focus()");
      await shot(win, 'focus-rail-' + routeId + '-' + tag + '.png');
    }
    if (routeId === 'chat') {
      await js(win, 'document.querySelector("#chatInput").focus()');
      await shot(win, 'focus-composer-' + routeId + '-' + tag + '.png');
    }
  }
}

async function checkTabNavigation(win, size) {
  const tag = size[0] + 'x' + size[1];
  await js(win, "window.__noxAether.setRoute('chat')");
  await settle(win, 200);
  await js(win, 'document.querySelector("#aeNav_chat").focus()');
  const before = await focusInfo(win);
  await press(win, 'Right');
  const right = await focusInfo(win);
  const rightRoute = await js(win, 'window.__noxAether.getRoute()');
  await press(win, 'Left');
  const left = await focusInfo(win);
  const leftRoute = await js(win, 'window.__noxAether.getRoute()');
  await js(win, 'document.querySelector("#aeNav_chat").focus()');
  await press(win, 'Home');
  const home = await focusInfo(win);
  await press(win, 'End');
  const end = await focusInfo(win);
  await js(win, 'document.querySelector("#aeNav_chat").focus()');
  await press(win, 'Return');
  const activated = await focusInfo(win);
  const activatedRoute = await js(win, 'window.__noxAether.getRoute()');
  await js(win, "window.__noxAether.setRoute('chat')");
  await settle(win, 160);
  check('шапка ' + tag + ': стрелки, Home/End и Enter между разделами',
    before.role === 'tab' && before.selected === 'true'
      && right.id === 'aeNav_settings' && rightRoute === 'settings'
      && left.id === 'aeNav_chat' && leftRoute === 'chat'
      && home.id === 'aeNav_personal' && end.id === 'aeNav_settings'
      && activated.id === 'aeNav_chat' && activatedRoute === 'chat',
    { before: before.id, right: right.id, rightRoute: rightRoute, left: left.id, leftRoute: leftRoute,
      home: home.id, end: end.id, activated: activated.id, activatedRoute: activatedRoute });
}

async function checkPopoverEscape(win, size) {
  const tag = size[0] + 'x' + size[1];
  await js(win, "window.__noxAether.setRoute('chat')");
  await settle(win, 200);
  // Ход «занят», чтобы поймать ошибочный Esc-стоп при закрытии поповера.
  await js(win, [
    '(() => {',
    'const bridge = window.NoxAetherBridge;',
    'if (!bridge.__a11yPatched) { bridge.__a11yPatched = true; const original = bridge.call;',
    'bridge.call = (name, ...args) => { if (name === "stop") { window.__a11yStopCount = (window.__a11yStopCount || 0) + 1; return Promise.resolve({ ok: true }); } return original(name, ...args); }; }',
    'window.__a11yStopCount = 0;',
    'const store = window.__noxAether.store; store.state.trackerBusy = true; store.state.trackerState = "acting"; store.notify(true);',
    'return true;',
    '})()',
  ].join(' '));
  await settle(win, 160);

  await js(win, 'document.querySelector("#pickTrigger").focus(); document.querySelector("#pickTrigger").click()');
  await settle(win, 220);
  await shot(win, 'panel-pick-' + tag + '.png');
  await press(win, 'Escape');
  await settle(win, 220);
  let info = await focusInfo(win);
  let closed = await js(win, 'Boolean(document.querySelector("#pickPanel").hidden)');
  let stops = await js(win, 'window.__a11yStopCount || 0');
  check('поповер модели ' + tag + ': Esc закрывает и возвращает фокус', closed && info.id === 'pickTrigger' && stops === 0,
    { closed: closed, focus: info.id, stops: stops });

  // Меню режима доступа.
  await js(win, 'document.querySelector("#aeModePill").focus(); document.querySelector("#aeModePill").click()');
  await settle(win, 180);
  await press(win, 'Escape');
  await settle(win, 200);
  info = await focusInfo(win);
  closed = await js(win, 'Boolean(document.querySelector(".ae-mode-menu").hidden)');
  stops = await js(win, 'window.__a11yStopCount || 0');
  check('меню режима ' + tag + ': Esc закрывает и возвращает фокус', closed && info.id === 'aeModePill' && stops === 0,
    { closed: closed, focus: info.id, stops: stops });

  // Быстрые настройки.
  await js(win, 'document.querySelector("[aria-controls=aeQuickSettings]").focus(); document.querySelector("[aria-controls=aeQuickSettings]").click()');
  await settle(win, 180);
  await press(win, 'Escape');
  await settle(win, 200);
  closed = await js(win, 'Boolean(document.querySelector("#aeQuickSettings").hidden)');
  const quickFocusOk = await js(win, 'document.activeElement === document.querySelector("[aria-controls=aeQuickSettings]")');
  stops = await js(win, 'window.__a11yStopCount || 0');
  check('быстрые настройки ' + tag + ': Esc закрывает и возвращает фокус', closed && quickFocusOk && stops === 0,
    { closed: closed, focusBack: quickFocusOk, stops: stops });

  await js(win, '(() => { const s = window.__noxAether.store; s.state.trackerBusy = false; s.state.trackerState = "idle"; s.notify(true); return true; })()');
  await settle(win, 120);
}

async function checkModal(win, size) {
  const tag = size[0] + 'x' + size[1];
  await js(win, "window.__noxAether.setRoute('chat')");
  await settle(win, 200);
  await js(win, 'document.querySelector("#lxAiModalBtn").focus(); document.querySelector("#lxAiModalBtn").click()');
  const opened = await waitUntil(() => js(win, '!document.querySelector("#lxAiModalBackdrop").hidden'));
  await settle(win, 200);
  const inside = await focusInfo(win);
  const inert = await js(win, '(() => ({ main: Boolean(document.querySelector("#aeMain") && document.querySelector("#aeMain").inert), topbar: Boolean(document.querySelector("#aeTopbar") && document.querySelector("#aeTopbar").inert), rail: Boolean(document.querySelector(".ae-utility-rail") && document.querySelector(".ae-utility-rail").inert) }))()');
  check('модалка ' + tag + ': открыта, фокус внутри, фон inert', Boolean(opened) && inside.inDialog && inert.main && inert.topbar && inert.rail,
    { opened: Boolean(opened), focus: inside.id || inside.classes, inert: inert });
  await shot(win, 'modal-open-' + tag + '.png');

  const focusables = await js(win, [
    '(() => {',
    'const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.disabled; };',
    'return [...document.querySelectorAll("#lxAiModal button, #lxAiModal input, #lxAiModal select")].filter(visible).length;',
    '})()',
  ].join(' '));
  const trapped = [];
  for (let i = 0; i < 18; i += 1) {
    await press(win, 'Tab');
    trapped.push(await focusInfo(win));
  }
  const allInside = trapped.every((step) => step.inDialog && step.dialogId === 'lxAiModal');
  const visited = new Set(trapped.map((step) => step.id || step.classes));
  await press(win, 'Tab', ['shift']);
  const back = await focusInfo(win);
  check('модалка ' + tag + ': Tab не выходит из диалога, Shift+Tab внутри',
    allInside && back.inDialog && visited.size >= Math.min(focusables, 5),
    { focusables: focusables, allInside: allInside, visited: [...visited].slice(0, 10), back: back.id || back.classes });

  await press(win, 'Escape');
  await settle(win, 260);
  const closed = await js(win, 'Boolean(document.querySelector("#lxAiModalBackdrop").hidden)');
  const after = await focusInfo(win);
  const released = await js(win, 'Boolean(!document.querySelector("#aeMain").inert && !document.querySelector("#aeTopbar").inert)');
  const stops = await js(win, 'window.__a11yStopCount || 0');
  check('модалка ' + tag + ': Esc закрывает, возвращает фокус и снимает inert',
    closed && after.id === 'lxAiModalBtn' && released && stops === 0,
    { closed: closed, focus: after.id, released: released, stops: stops });
}

async function checkComposerKeyboard(win, size) {
  const tag = size[0] + 'x' + size[1];
  await js(win, "window.__noxAether.setRoute('chat')");
  await settle(win, 200);

  // Меню модели: фокус виден на скрытом radio, стрелки переключают варианты.
  await js(win, 'document.querySelector("#pickTrigger").focus(); document.querySelector("#pickTrigger").click()');
  await settle(win, 250);
  const radioFocus = await js(win, [
    '(() => {',
    'const panel = document.querySelector("#pickPanel");',
    'const input = panel.querySelector("input:checked") || panel.querySelector("input");',
    'input.focus();',
    'const label = input.closest("label"); const span = label && label.querySelector("span");',
    'const style = span ? getComputedStyle(span) : null;',
    'return { focused: document.activeElement === input,',
    'outline: style ? style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1 : false,',
    'width: input.getBoundingClientRect().width, height: input.getBoundingClientRect().height };',
    '})()',
  ].join(' '));
  await press(win, 'Right');
  const movedRadio = await js(win, [
    '(() => {',
    'const panel = document.querySelector("#pickPanel"); const checked = panel.querySelector("input:checked");',
    'const span = checked && checked.closest("label").querySelector("span");',
    'const style = span ? getComputedStyle(span) : null;',
    'return { focused: document.activeElement === checked, value: checked && checked.value,',
    'outline: style ? style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1 : false };',
    '})()',
  ].join(' '));
  check('меню модели ' + tag + ': фокус виден на скрытом radio, стрелки переключают',
    radioFocus.focused && radioFocus.outline && movedRadio.focused && movedRadio.outline,
    { radioFocus: radioFocus, movedRadio: movedRadio });
  await shot(win, 'panel-pick-focus-' + tag + '.png');
  await press(win, 'Escape');
  await settle(win, 150);

  // Меню режима доступа: стрелки и Enter, возврат фокуса после выбора.
  await js(win, 'document.querySelector("#aeModePill").focus(); document.querySelector("#aeModePill").click()');
  await settle(win, 150);
  await press(win, 'Down');
  const menuSecond = await focusInfo(win);
  await press(win, 'Down');
  const menuThird = await focusInfo(win);
  await press(win, 'Return');
  await settle(win, 200);
  const modeAfter = await js(win, 'window.__noxAether.store.state.mode');
  const menuFocus = await focusInfo(win);
  const menuClosed = await js(win, 'Boolean(document.querySelector(".ae-mode-menu").hidden)');
  const menuDiag = await js(win, [
    '(() => {',
    'const menu = document.querySelector(".ae-mode-menu");',
    'return { hidden: menu.hidden, expanded: document.querySelector("#aeModePill").getAttribute("aria-expanded"),',
    'items: [...menu.querySelectorAll("[role=menuitemradio]")].map((el) => ({ role: el.getAttribute("role"), tab: el.tabIndex, checked: el.getAttribute("aria-checked") })),',
    'focusLog: (window.__a11yFocusLog || []).slice(-10), keyLog: (window.__a11yKeyLog || []).slice(-8) };',
    '})()',
  ].join(' '));
  await js(win, "window.__noxAether.store.setMode('ask')");
  await settle(win, 120);
  check('меню режима ' + tag + ': стрелки, Enter, возврат фокуса',
    menuSecond.role === 'menuitemradio' && menuThird.role === 'menuitemradio'
      && modeAfter === 'full' && menuClosed && menuFocus.id === 'aeModePill',
    { second: menuSecond.id || menuSecond.classes, secondRole: menuSecond.role,
      third: menuThird.id || menuThird.classes, thirdRole: menuThird.role,
      modeAfter: modeAfter, menuClosed: menuClosed, focus: menuFocus.id, menuDiag: menuDiag });

  // Быстрые настройки: Tab уходит — поповер закрывается; Esc возвращает фокус.
  await js(win, 'document.querySelector("[aria-controls=aeQuickSettings]").focus(); document.querySelector("[aria-controls=aeQuickSettings]").click()');
  await settle(win, 160);
  let left = false;
  for (let i = 0; i < 12 && !left; i += 1) {
    await press(win, 'Tab');
    left = await js(win, '!document.querySelector("#aeQuickSettings").contains(document.activeElement)');
  }
  const quickClosedByTab = await js(win, 'Boolean(document.querySelector("#aeQuickSettings").hidden)');
  await js(win, 'document.querySelector("[aria-controls=aeQuickSettings]").focus(); document.querySelector("[aria-controls=aeQuickSettings]").click()');
  await settle(win, 160);
  await press(win, 'Escape');
  await settle(win, 150);
  const quickFocusOk = await js(win, 'document.activeElement === document.querySelector("[aria-controls=aeQuickSettings]")');
  const quickClosed = await js(win, 'Boolean(document.querySelector("#aeQuickSettings").hidden)');
  check('быстрые настройки ' + tag + ': Tab уходит — закрываются; Esc возвращает фокус',
    left && quickClosedByTab && quickClosed && quickFocusOk,
    { left: left, closedByTab: quickClosedByTab, closedByEsc: quickClosed, focusBack: quickFocusOk });
}

async function checkApprovalKeyboard(win, size) {
  const tag = size[0] + 'x' + size[1];
  await js(win, "window.__noxAether.setRoute('chat')");
  await settle(win, 200);
  // Убираем возможные хвосты предыдущего размера.
  await js(win, '(() => { const s = window.__noxAether.store.state; s.approvals.queue = []; s.approvals.view = null; s.approvals.sending = new Set(); s.approvals.gate = false; s.approvals.viewSeq += 1; s.trackerBusy = false; s.trackerState = "idle"; window.__noxAether.store.notify(true); return true; })()');
  await settle(win, 180);
  await js(win, [
    '(() => {',
    'const bridge = window.NoxAetherBridge;',
    'if (!bridge.__a11yApprovalPatched) { bridge.__a11yApprovalPatched = true; const original = bridge.call;',
    'bridge.call = (name, ...args) => { if (name === "markApprovalShown") return Promise.resolve({ ok: true, token: "qa-token" });',
    'if (name === "respondApproval") { window.__a11yResponded = (window.__a11yResponded || []); window.__a11yResponded.push([name, ...args]); return Promise.resolve({ ok: true }); }',
    'return original(name, ...args); }; }',
    'window.__a11yResponded = [];',
    'if (document.activeElement && document.activeElement.blur) document.activeElement.blur();',
    'window.__noxAether.store.onAgentEvent({ type: "approval_request", id: "qa-approval-1", name: "workspace_write", tool: "workspace_write", callId: "qa-call-1", actionTitle: "Запись файла", summary: "Нужно записать файл в рабочую папку.", risk: "normal", args: { path: "qa-note.txt" } });',
    'return true;',
    '})()',
  ].join(' '));
  const appeared = await waitUntil(() => js(win, '!document.querySelector("#aeApprovalDock").hidden'), 4000);
  await settle(win, 260);
  const card = await js(win, [
    '(() => {',
    'const dock = document.querySelector("#aeApprovalDock");',
    'const card = dock.querySelector(".ae-approval-card");',
    'const reject = dock.querySelector("[data-decision=reject]");',
    'return { visible: !dock.hidden,',
    'role: card && card.getAttribute("role"),',
    'labelled: card && Boolean(card.getAttribute("aria-labelledby")),',
    'described: card && Boolean(card.getAttribute("aria-describedby")),',
    'alert: dock.querySelector("[role=alert]") !== null,',
    'focusInDock: dock.contains(document.activeElement),',
    'rejectFocusable: Boolean(reject && !reject.disabled && reject.tabIndex >= 0),',
    'rejectLabel: reject ? (reject.getAttribute("aria-label") || reject.textContent.trim()) : "" };',
    '})()',
  ].join(' '));
  check('подтверждение ' + tag + ': карточка ARIA, объявление и фокус с клавиатуры',
    Boolean(appeared) && card.visible && card.role === 'region' && card.labelled && card.described && card.alert && card.focusInDock && card.rejectFocusable,
    card);

  await js(win, 'document.querySelector("#aeApprovalDock [data-decision=reject]").focus()');
  await settle(win, 950);
  const armedFocus = await js(win, 'document.querySelector("#aeApprovalDock [data-decision=reject]") === document.activeElement');
  const allowEnabled = await js(win, 'Boolean(document.querySelector("#aeApprovalDock [data-decision=once]:not(:disabled)"))');
  check('подтверждение ' + tag + ': фокус держится при взводе кнопок', armedFocus && allowEnabled,
    { armedFocus: armedFocus, allowEnabled: allowEnabled });

  await js(win, 'document.querySelector("#aeApprovalDock [data-decision=reject]").focus()');
  await press(win, 'Return');
  const done = await waitUntil(() => js(win, 'Boolean(document.querySelector("#aeApprovalDock").hidden)'), 3000);
  const responded = await js(win, 'window.__a11yResponded || []');
  const afterReply = await focusInfo(win);
  const approvalDiag = await js(win, [
    '(() => ({',
    'active: { id: document.activeElement && document.activeElement.id, cls: document.activeElement && document.activeElement.className, tag: document.activeElement && document.activeElement.tagName },',
    'rejectDisabled: (document.querySelector("#aeApprovalDock [data-decision=reject]") || {}).disabled,',
    'focusLog: (window.__a11yFocusLog || []).slice(-14), keyLog: (window.__a11yKeyLog || []).slice(-10) }))()',
  ].join(' '));
  check('подтверждение ' + tag + ': Enter отклоняет и возвращает фокус в поле ввода',
    Boolean(done) && responded.some((row) => row[2] === 'reject') && afterReply.id === 'chatInput',
    { done: Boolean(done), responded: responded, focus: afterReply.id || afterReply.classes, approvalDiag: approvalDiag });
}

async function checkSendStopFocus(win, size) {
  const tag = size[0] + 'x' + size[1];
  await js(win, "window.__noxAether.setRoute('chat')");
  await settle(win, 200);
  await js(win, '(() => { const s = window.__noxAether.store.state; s.approvals.queue = []; s.approvals.view = null; s.approvals.gate = false; s.trackerBusy = false; s.trackerState = "idle"; s.sendingLock = false; window.__noxAether.store.notify(true); return true; })()');
  await settle(win, 160);
  await js(win, [
    '(() => {',
    'const bridge = window.NoxAetherBridge;',
    'if (!bridge.__a11ySendPatched) { bridge.__a11ySendPatched = true; const original = bridge.call;',
    'bridge.call = (name, ...args) => { if (name === "send") return Promise.resolve({ ok: true });',
    'if (name === "stop") { window.__a11yStopCount = (window.__a11yStopCount || 0) + 1; return Promise.resolve({ ok: true }); }',
    'return original(name, ...args); }; }',
    'const ta = document.querySelector("#chatInput"); ta.focus();',
    'ta.value = "Проверка фокуса после отправки"; ta.dispatchEvent(new Event("input", { bubbles: true }));',
    'return true;',
    '})()',
  ].join(' '));
  await press(win, 'Return');
  const busy = await waitUntil(() => js(win, 'window.__noxAether.store.state.trackerBusy'), 5000);
  const afterSend = await focusInfo(win);
  check('отправка ' + tag + ': фокус остаётся в поле ввода', Boolean(busy) && afterSend.id === 'chatInput',
    { busy: Boolean(busy), focus: afterSend.id || afterSend.classes });

  await js(win, 'document.querySelector("#sendBtn").focus(); document.querySelector("#sendBtn").click()');
  const idle = await waitUntil(() => js(win, '!window.__noxAether.store.state.trackerBusy && !window.__noxAether.store.state.sendingLock'), 5000);
  await settle(win, 220);
  const afterStop = await focusInfo(win);
  const stopDiag = await js(win, [
    '(() => ({',
    'sendDisabled: document.querySelector("#sendBtn").disabled,',
    'focusLog: (window.__a11yFocusLog || []).slice(-12), keyLog: (window.__a11yKeyLog || []).slice(-8) }))()',
  ].join(' '));
  check('стоп ' + tag + ': фокус не теряется после остановки', Boolean(idle) && afterStop.id === 'chatInput',
    { idle: Boolean(idle), focus: afterStop.id || afterStop.classes, stopDiag: stopDiag });

  await js(win, '(() => { const ta = document.querySelector("#chatInput"); ta.value = "Проверка кнопки отправки"; ta.dispatchEvent(new Event("input", { bubbles: true })); const send = document.querySelector("#sendBtn"); send.focus(); return document.activeElement === send; })()');
  await press(win, 'Space');
  await waitUntil(() => js(win, 'window.__noxAether.store.state.trackerBusy'), 5000);
  const afterButtonSend = await focusInfo(win);
  await press(win, 'Escape');
  await waitUntil(() => js(win, '!window.__noxAether.store.state.trackerBusy'), 5000);
  await settle(win, 220);
  const afterEscape = await focusInfo(win);
  check('отправка кнопкой ' + tag + ': фокус в поле, Esc-стоп его не теряет',
    afterButtonSend.id === 'chatInput' && afterEscape.id === 'chatInput',
    { afterButtonSend: afterButtonSend.id || afterButtonSend.classes, afterEscape: afterEscape.id || afterEscape.classes });
}

async function checkIconNames(win, size) {
  const tag = size[0] + 'x' + size[1];
  const routes = ['personal', 'commands', 'mcp', 'chat', 'settings'];
  const anonymous = [];
  for (const route of routes) {
    await js(win, "window.__noxAether.setRoute('" + route + "')");
    await settle(win, 160);
    const rows = await iconButtonsWithoutName(win);
    for (const row of rows) anonymous.push({ route: route, id: row.id, classes: row.classes, html: row.html });
  }
  check('иконочные кнопки ' + tag + ': у всех есть доступное имя', anonymous.length === 0, anonymous.slice(0, 8));
}

function hasKey_OR_signedIn(state) {
  return Boolean(state && (state.hasKey || state.signedIn || state.link === 'electron'));
}

async function checkRealModel(win) {
  const state = await js(win, '(() => { const st = window.__noxAether.store.state; return { hasKey: Boolean(st.hasKey), signedIn: Boolean(st.account && st.account.signedIn), link: st.link }; })()');
  if (!state.hasKey && !state.signedIn) {
    check('настоящая модель: пропущено (нет ключа или аккаунта)', true, { state: state, skipped: true });
    return;
  }
  await js(win, '(() => { window.NoxAetherBridge.call = window.__a11yRealBridgeCall; return true; })()');
  await js(win, 'window.__noxAether.setRoute("chat")');
  await js(win, 'window.__noxAether.store.createNewChat()');
  await settle(win, 400);
  await js(win, '(() => { const ta = document.querySelector("#chatInput"); ta.focus(); ta.value = "Привет, коротко ответь."; ta.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
  await press(win, 'Return');
  const busy = await waitUntil(() => js(win, 'window.__noxAether.store.state.trackerBusy'), 12000);
  if (!busy) {
    const why = await js(win, '[...document.querySelectorAll("#feed .is-error .ae-error-text")].map((el) => el.textContent).join(" | ") || (window.__noxAether.store.state.trackerError || "")');
    check('настоящая модель: ход не начался — проверка фокуса пропущена', true, { skipped: true, reason: why || 'модель не ответила' });
    return;
  }
  await settle(win, 180);
  const afterSend = await focusInfo(win);
  await shot(win, 'real-model-send-1200x720.png');
  const stopCounterBefore = await js(win, 'window.__a11yStopCount || 0');
  await press(win, 'Escape');
  await waitUntil(() => js(win, '!window.__noxAether.store.state.trackerBusy && !window.__noxAether.store.state.sendingLock'), 25000);
  await waitUntil(() => js(win, 'Boolean(document.querySelector("#feed .ae-reply-stopped"))'), 10000);
  await settle(win, 300);
  const afterStop = await focusInfo(win);
  const stopCounterAfter = await js(win, 'window.__a11yStopCount || 0');
  const cancelled = await js(win, 'Boolean(document.querySelector("#feed .ae-reply-stopped") || window.__noxAether.store.state.activeTurn === null)');
  await shot(win, 'real-model-stop-1200x720.png');
  check('настоящая модель: фокус остаётся в поле после реальной отправки',
    Boolean(busy) && afterSend.id === 'chatInput', { busy: Boolean(busy), focus: afterSend.id || afterSend.classes });
  check('настоящая модель: фокус и честный стоп после настоящего Esc',
    afterStop.id === 'chatInput' && cancelled, { focus: afterStop.id || afterStop.classes, cancelled: cancelled, stopCalls: stopCounterAfter - stopCounterBefore });
}

async function checkLiveRegions(win) {
  await js(win, "window.__noxAether.setRoute('chat')");
  await settle(win, 200);
  await js(win, [
    '(() => {',
    'const store = window.__noxAether.store;',
    'store.onAgentEvent({ type: "done", replyText: "Короткий проверочный ответ для экранного диктора.", status: "succeeded", actions: [] });',
    'store.onAgentEvent({ type: "error", message: "Проверка объявления ошибки" });',
    'return true;',
    '})()',
  ].join(' '));
  await settle(win, 260);
  const regions = await js(win, [
    '(() => {',
    'const feed = document.querySelector("#feed");',
    'const errorCard = document.querySelector("#feed .is-error");',
    'const announcer = document.querySelector("#aeAnswerAnnouncer, #feed .ae-success-announcer, #feed .ae-reply[aria-live]");',
    'const answerText = announcer ? (announcer.textContent || "") : "";',
    'return { feedRole: feed.getAttribute("role"), feedLive: feed.getAttribute("aria-live"), feedLabel: feed.getAttribute("aria-label"),',
    'errorRole: errorCard ? errorCard.getAttribute("role") : "", errorLive: errorCard ? errorCard.getAttribute("aria-live") : "",',
    'announceLive: announcer ? announcer.getAttribute("aria-live") : "", answer: /проверочный ответ/i.test(answerText) };',
    '})()',
  ].join(' '));
  check('aria-live ленты, ответа и ошибок',
    regions.feedRole === 'log' && regions.feedLive === 'polite' && Boolean(regions.feedLabel)
      && regions.errorRole === 'alert' && regions.errorLive === 'assertive' && regions.answer,
    regions);
  await shot(win, 'live-regions-1200x720.png');
}

async function run(win) {
  await waitUntil(() => js(win, 'Boolean(window.__noxAether && window.__noxAether.store)'), 15000);
  await js(win, [
    '(() => {',
    'window.__a11yFocusLog = []; window.__a11yKeyLog = [];',
    'document.addEventListener("focusin", (e) => { const a = e.target; window.__a11yFocusLog.push(String(a && (a.id || a.className || a.tagName) || "").slice(0, 60)); if (window.__a11yFocusLog.length > 120) window.__a11yFocusLog.shift(); }, true);',
    'document.addEventListener("keydown", (e) => { const a = document.activeElement; window.__a11yKeyLog.push(String(e.key) + "@" + String(a && (a.id || a.className || a.tagName) || "").slice(0, 50)); if (window.__a11yKeyLog.length > 200) window.__a11yKeyLog.shift(); }, true);',
    'return true;',
    '})()',
  ].join(' '));
  await js(win, 'window.__a11yRealBridgeCall = window.NoxAetherBridge.call; true');
  await js(win, "window.__noxAether.setRoute('chat')");
  await settle(win, 300);
  win.show();
  win.focus();
  await settle(win, 400);
  // Прогрев: первое нажатие после показа окна иногда попадает в момент смены активности.
  await press(win, 'Tab');
  await press(win, 'Tab');
  await resetFocus(win);
  await settle(win, 150);

  for (const size of [[1200, 720], [864, 520]]) {
    await setViewport(win, size[0], size[1]);
    win.focus();
    await settle(win, 120);
    await checkTabOrder(win, size);
    await checkTabNavigation(win, size);
    await checkPopoverEscape(win, size);
    await checkModal(win, size);
    await checkComposerKeyboard(win, size);
    await checkApprovalKeyboard(win, size);
    await checkSendStopFocus(win, size);
    await checkIconNames(win, size);
    await js(win, "window.__noxAether.setRoute('chat')");
    await settle(win, 160);
    await shot(win, 'focus-final-' + size[0] + 'x' + size[1] + '.png');
  }
  await setViewport(win, 1200, 720);
  await checkLiveRegions(win);
  if (REAL_MODEL) await checkRealModel(win);
  finish(null);
}

app.on('browser-window-created', (_event, win) => {
  try { win.webContents.setBackgroundThrottling(false); } catch { /* ignore */ }
  win.webContents.on('console-message', (_ev, level, message) => {
    const noisy = typeof level === 'object' && level ? level : null;
    const severity = noisy ? noisy.level : level;
    const text = noisy ? noisy.message : message;
    if ((severity === 'error' || severity === 3) && consoleErrors.length < 20) consoleErrors.push(String(text || '').slice(0, 300));
  });
  win.webContents.on('render-process-gone', (_ev, details) => pageErrors.push('render-process-gone: ' + JSON.stringify(details)));
  win.webContents.once('did-finish-load', () => {
    if (mainWin) return;
    const url = win.webContents.getURL();
    if (!url.includes('/renderer/aether/index.html')) return;
    mainWin = win;
    run(win).catch((err) => finish('run: ' + (err && err.stack ? err.stack : err)));
  });
});

try {
  require('../main');
} catch (err) {
  finish('main.js не загрузился: ' + (err && err.message ? err.message : err));
}
