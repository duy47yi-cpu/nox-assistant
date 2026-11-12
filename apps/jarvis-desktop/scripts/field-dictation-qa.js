'use strict';
// Живая проверка диктовки в поле другой программы на настоящих окнах: Блокнот и поле в браузере.
// Временный профиль и данные. Микрофона нет: вместо раннера распознавания подставляется поток с готовым текстом,
// поэтому живой голос этим сценарием НЕ проверяется. Запуск: electron scripts/field-dictation-qa.js <папка снимков> [--busy]
//
// Отказ определения поля не обрывает прогон: он записывается вместе с диагностикой (что было в фокусе),
// чтобы причина была видна, а не угадывалась. Своё окно Блокнота называется с pid прогона: повторные
// прогоны не путают старое окно с новым.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const cp = require('child_process');
const { app, globalShortcut, BrowserWindow, clipboard, Menu } = require('electron');

// Меню трея: перехватываем собранные шаблоны, чтобы проверить переключатель диктовки в поле так же,
// как его нажимает владелец, — без живого трея и без мыши.
const trayTemplates = [];
const buildTemplate = Menu.buildFromTemplate;
Menu.buildFromTemplate = (template) => { trayTemplates.push(template); return buildTemplate.call(Menu, template); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-dictate-qa-'));
const profile = path.join(root, 'profile');
const data = path.join(root, 'data');
fs.mkdirSync(profile); fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ voice: false, backgroundModelRuns: false, desktopOverlay: false, mode: 'ask' }));
app.setPath('userData', profile);
for (const key of Object.keys(process.env)) if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
process.env.NOX_DATA_DIR = data;
require('../src/config/paths').projectRoot = () => root;

const shortcuts = new Map();
globalShortcut.register = (key, cb) => { if (shortcuts.has(key)) return false; shortcuts.set(key, cb); return true; };
globalShortcut.unregister = (key) => shortcuts.delete(key);
globalShortcut.unregisterAll = () => shortcuts.clear();
const KEY = 'Control+Alt+D';
const busyStart = process.argv.includes('--busy');
const busyFn = () => {};
if (busyStart) shortcuts.set(KEY, busyFn);

// Подставной раннер распознавания: настоящий powershell с System.Speech не запускается.
let runner = null;
const realSpawn = cp.spawn;
cp.spawn = (cmd, args, opts) => {
  const at = Array.isArray(args) ? args.indexOf('-EncodedCommand') : -1;
  if (at < 0 || !Buffer.from(String(args[at + 1]), 'base64').toString('utf16le').includes('System.Speech.Recognition')) return realSpawn(cmd, args, opts);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write: (line) => { if (String(line).trim() === 'stop') child.kill(); } };
  child.kill = () => { if (runner === child) runner = null; setImmediate(() => child.emit('close', 0)); };
  runner = child;
  setTimeout(() => child.stdout.write('{"type":"state","state":"listening"}\n'), 150);
  return child;
};
let lastDom = null;
// Голос владельца. Без запущенного раннера сказать некуда — вызывающий это видит по false.
const say = (text) => { if (!runner) return false; runner.stdout.write(JSON.stringify({ type: 'text', text }) + '\n'); return true; };

const { createPsHost } = require('../src/tools/ps-host');
const { SCRIPTS, PS, parseJsonOutput } = require('../src/tools/ui');
const ps = createPsHost();
const READ_SCRIPT = [PS.HEAD, PS.USER32, PS.UIA, PS.CHECK, 'function Main { $r = Read-JValue ($AE::FocusedElement); $script:R = @{ known = [bool]$r.known; value = [string]$r.value } }', PS.TAIL].join('\n');
// Диагностика отказа: что было передним окном и что стояло в фокусе. Только чтение, ничего не меняет.
const DIAG_SCRIPT = [PS.HEAD, PS.USER32, PS.UIA, PS.CHECK, [
  'function Main {',
  '  $fg = [JarvisUi.User32]::GetForegroundWindow()',
  '  $p = [uint32]0',
  '  [void][JarvisUi.User32]::GetWindowThreadProcessId($fg, [ref]$p)',
  '  $e = $AE::FocusedElement',
  "  $d = [ordered]@{ fg = $fg.ToInt64(); fgPid = [int]$p; selfPid = $selfPid; focusNull = ($null -eq $e) }",
  '  if ($null -ne $e) {',
  '    $d.type = (TypeOf $e.Current.ControlType); $d.name = (Cut $e.Current.Name 60)',
  '    try { $d.password = [bool]$e.Current.IsPassword } catch { $d.password = $null }',
  '    try { $d.rid = ($e.GetRuntimeId() -join ".") } catch { $d.rid = "?" }',
  '  }',
  '  try { $d.fgTitle = Cut ($AE::FromHandle($fg).Current.Name) 70 } catch { $d.fgTitle = "?" }',
  '  $script:R = $d',
  '}'].join('\n'), PS.TAIL].join('\n');
const psJson = async (script, env = {}) => parseJsonOutput((await ps.run(script, { JARVIS_UI_SELF_PID: String(process.pid), ...env }, { timeoutMs: 30000 })).data.stdout) || {};
const focusWindow = (title) => psJson(SCRIPTS.ui_focus, { JARVIS_UI_WINDOW: title });
const fieldValue = async () => (await psJson(READ_SCRIPT)).value || '';
const diag = async () => { try { return await psJson(DIAG_SCRIPT); } catch (err) { return { error: String((err && err.message) || err) }; } };

const out = path.resolve(process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || path.join(root, 'shots'));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('FIELD_QA timeout'); finish(1); }, 300000);
const edgeProfile = path.join(root, 'edge');
const noteName = `nox-dictation-qa-${process.pid}`;
// Уборка не держит выход: закрываем свои окна отдельным процессом и сразу выходим.
const runDetached = (args, env) => { try { cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ...args], { env: { ...process.env, ...env }, windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch {} };
function finish(code) {
  clearTimeout(deadline);
  ps.close();
  // Закрываем только свои окна: этот Блокнот и свой Edge с временным профилем.
  // Закрываем только окна этой проверки, включая оставшиеся от прерванных прогонов: у Блокнота окна
  // одной программы делят процесс и вкладки, и чужой файл в соседней вкладке сбивает чтение поля.
  runDetached(['Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*nox-dictation-qa-*" } | ForEach-Object { $_.CloseMainWindow() | Out-Null }'], {});
  runDetached(['Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq "msedge.exe" -or $_.Name -eq "chrome.exe") -and $_.CommandLine -like ("*" + $env:NOX_QA_EDGE + "*") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'], { NOX_QA_EDGE: edgeProfile });
  app.exit(code);
}

async function trayCheck() {
  const settings = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')); } catch { return {}; } };
  const find = () => {
    for (let i = trayTemplates.length - 1; i >= 0; i--) {
      const item = (trayTemplates[i] || []).find((x) => /Диктовка в любое поле/.test(String((x && x.label) || '')));
      if (item) return item;
    }
    return null;
  };
  const r = { found: false };
  const first = find();
  if (!first) return r;
  r.found = true;
  r.checkedAtStart = first.checked === true;
  r.hotkeyAtStart = shortcuts.has(KEY);
  first.checked = false;
  first.click(first);
  await sleep(250);
  const off = find();
  r.offSaved = settings().fieldDictation === false;
  r.offHotkey = !shortcuts.has(KEY);
  r.offUnchecked = Boolean(off) && off.checked === false;
  if (off) { off.checked = true; off.click(off); }
  await sleep(250);
  const on = find();
  r.onSaved = settings().fieldDictation !== false;
  r.onHotkey = shortcuts.has(KEY);
  r.onChecked = Boolean(on) && on.checked === true;
  return r;
}

async function run() {
  let main;
  for (let i = 0; i < 100 && !main; i++) { await sleep(400); main = BrowserWindow.getAllWindows().find((w) => /index\.html/.test(w.webContents.getURL())); }
  if (!main) throw new Error('Главное окно не создано');
  await sleep(1500);
  if (busyStart) {
    const ok = !main.isDestroyed() && shortcuts.get(KEY) === busyFn && !BrowserWindow.getAllWindows().some((w) => /dictate\.html/.test(w.webContents.getURL()));
    console.log('FIELD_QA_BUSY ' + JSON.stringify({ ok }));
    finish(ok ? 0 : 1); return;
  }
  const hotkey = shortcuts.get(KEY);
  if (!hotkey) throw new Error('Клавиша диктовки не зарегистрирована');
  const clipState = () => JSON.stringify([clipboard.readText(), typeof clipboard.readHTML === 'function' ? clipboard.readHTML() : '', typeof clipboard.readImage === 'function' ? clipboard.readImage().toPNG().length : 0]);
  const clipBefore = clipState();
  const win = () => BrowserWindow.getAllWindows().find((w) => /dictate\.html/.test(w.webContents.getURL()));
  const dom = async () => {
    const w = win();
    if (!w) return { visible: false };
    const d = await w.webContents.executeJavaScript(`(() => { const t = (id) => document.getElementById(id); return { mic: t('micLabel').textContent, target: t('target').textContent, text: t('text').textContent, message: t('message').textContent, insert: !t('insert').hidden && !t('insert').disabled, copy: !t('copy').hidden }; })()`).catch(() => ({}));
    lastDom = { ...d, visible: w.isVisible(), focused: w.isFocused() };
    return lastDom;
  };
  const until = async (check, seconds = 12) => { for (let i = 0; i < seconds * 5; i++) { const d = await dom(); if (check(d)) return d; await sleep(200); } return dom(); };
  const shot = async (name) => { await sleep(400); const w = win(); if (w) fs.writeFileSync(path.join(out, name), (await w.webContents.capturePage()).toPNG()); };
  const click = (id) => {
    const w = win();
    if (!w) return Promise.reject(new Error('окна диктовки нет'));
    return w.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`);
  };

// Нажатие клавиши диктовки с проверкой предусловия: наше окно действительно впереди.
// Если поле не определилось, а впереди было чужое окно — возвращаем своё и повторяем (до 3 раз).
// Если впереди было наше окно, а поле всё равно не определилось — это настоящий отказ, он и записывается.
async function dictateIn(title) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const focus = await focusWindow(title);
    await sleep(400);
    await hotkey();
    const d = await until((x) => x.mic === 'Слушаю' || !!x.message, 6);
    if (d.mic === 'Слушаю') return { ok: true, dom: d, attempt, focused: focus.status === 'ok' };
    const info = await diag();
    last = { ok: false, dom: d, diag: info, attempt, focused: focus.status === 'ok' };
    if (String(info.fgTitle || '').includes(title)) return last; // впереди было наше окно: отказ настоящий
    await click('cancel').catch(() => {});
    await until((x) => !x.visible, 5);
  }
  return last || { ok: false, dom: await dom(), diag: await diag() };
}

// Проверяем то, что видно снаружи: файл настроек, регистрацию клавиши и перестроенное меню.
  const r = {};

  // 1. Блокнот: окно-подсказка видно до вставки и не берёт фокус, по «Вставить» текст в поле.
  const note = path.join(root, `${noteName}.txt`);
  fs.writeFileSync(note, '');
  cp.spawn('notepad.exe', [note], { detached: true, stdio: 'ignore' }).unref();
  await sleep(3500);
  r.notepadFocus = (await focusWindow(noteName)).status === 'ok';
  await sleep(500);
  const t0 = Date.now();
  let start = await dictateIn(noteName);
  let d = start.dom;
  if (!start.ok) {
    r.notepadRefused = { message: d.message || '', attempt: start.attempt, diag: start.diag };
  } else {
    // Окно обязано появиться само: ждём его не дольше 8 с и записываем, сколько это заняло.
    d = await until((x) => x.visible === true, 8);
    r.notepadVisibleMs = d.visible === true ? Date.now() - t0 : -1;
    if (say('Проверка диктовки в Блокнот')) {
    d = await until((x) => x.insert && x.visible === true, 6);
    await shot('dictate-recording.png');
    r.notepadShown = d.visible === true && d.focused === false && d.mic === 'Слушаю' && new RegExp(noteName).test(d.target || '') && d.text === 'Проверка диктовки в Блокнот';
    if (!r.notepadShown) r.notepadDom = d;
    r.notepadBeforeInsert = !(await fieldValue()).includes('Проверка диктовки'); // до подтверждения в поле ничего нет
    await click('insert');
    d = await until((x) => /Вставлено|не вставлен|не появился|не получилось/.test(x.message || ''));
    await shot('dictate-done.png');
    r.notepadInserted = d.message === 'Вставлено.' && (await fieldValue()).includes('Проверка диктовки в Блокнот');
    r.notepadMessage = d.message;
    await until((x) => !x.visible, 5);
    }
  }

  // 2. Отмена по Esc: ничего не вставлено, микрофон остановлен. Заодно окно второго сеанса — уже созданное.
  start = await dictateIn(noteName);
  d = start.dom;
  if (!start.ok) {
    r.cancelRefused = { message: d.message || '', attempt: start.attempt, diag: start.diag };
  } else if (say('Этот текст отменён')) {
    r.secondVisible = (await until((x) => x.visible === true, 5)).visible === true; // окно переиспользовано и снова видно
    d = await until((x) => x.insert, 6);
    r.escRegistered = shortcuts.has('Escape');
    if (r.escRegistered) shortcuts.get('Escape')();
    d = await until((x) => !x.visible, 5);
    r.cancelled = !d.visible && runner === null && !shortcuts.has('Escape') && !(await fieldValue()).includes('отменён');
  }

  // 3. Браузер: поле ввода на странице.
  const edge = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
  if (edge) {
    const page = (name, title, input) => { const file = path.join(root, name); fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:20px sans-serif;padding:40px"><p>${title}</p>${input}`); return file; };
    const fieldPage = page('field.html', `Nox QA поле ${process.pid}`, '<input id="t" aria-label="Комментарий" autofocus style="font:inherit;width:600px">');
    const pwPage = page('pw.html', `Nox QA вход ${process.pid}`, '<input id="p" type="password" aria-label="Код входа" autofocus style="font:inherit">');
    const openEdge = (file) => cp.spawn(edge, [`--user-data-dir=${edgeProfile}`, '--no-first-run', '--no-default-browser-check', '--new-window', file], { detached: true, stdio: 'ignore' }).unref();
    openEdge(fieldPage);
    await sleep(6000);
    r.browserFocus = (await focusWindow(`Nox QA поле ${process.pid}`)).status === 'ok';
    await sleep(800);
    start = await dictateIn(`Nox QA поле ${process.pid}`);
    d = start.dom;
    r.browserTarget = d.target || d.message;
    if (!start.ok) {
      r.browserRefused = { message: d.message || '', attempt: start.attempt, diag: start.diag };
    } else if (say('Проверка диктовки в браузер')) {
      await until((x) => x.insert && x.visible === true, 6);
      await shot('dictate-browser.png');
      await click('insert');
      d = await until((x) => /Вставлено|не вставлен|не появился|не получилось|не удалось/.test(x.message || ''));
      r.browserMessage = d.message;
      r.browserInserted = d.message === 'Вставлено.' && (await fieldValue()).includes('Проверка диктовки в браузер');
      await until((x) => !x.visible, 5);

      // 4. Фокус ушёл: диктовали в браузер, перешли в Блокнот — не вставлять, текст оставить.
      start = await dictateIn(`Nox QA поле ${process.pid}`);
      d = start.dom;
      if (!start.ok) {
        r.movedRefused = { message: d.message || '', attempt: start.attempt, diag: start.diag };
      } else if (say('Текст для другого окна')) {
        await until((x) => x.insert, 6);
        await focusWindow(noteName);
        await sleep(500);
        await click('insert');
        d = await until((x) => /не вставлен|Вставлено/.test(x.message || ''));
        await shot('dictate-kept.png');
        r.movedMessage = d.message;
        r.movedKept = /другое окно/.test(d.message || '') && d.text === 'Текст для другого окна' && d.copy && !(await fieldValue()).includes('Текст для другого окна');
        await click('cancel');
        await until((x) => !x.visible, 5);
      }
    }

    // 5. Поле пароля: отказ с объяснением.
    openEdge(pwPage);
    await sleep(4000);
    await focusWindow(`Nox QA вход ${process.pid}`);
    await sleep(800);
    start = await dictateIn(`Nox QA вход ${process.pid}`);
    d = start.dom;
    await shot('dictate-password.png');
    r.passwordMessage = d.message;
    r.passwordRefused = /поле для пароля/.test(d.message || '') && !d.insert && runner === null;
    await click('cancel');
  } else r.browser = 'браузер не найден';

  // 6. Переключатель в трее.
  r.tray = await trayCheck();

  r.clipboardSame = clipState() === clipBefore;
  const ok = r.notepadFocus && r.notepadShown === true && r.notepadVisibleMs >= 0 && r.notepadBeforeInsert && r.notepadInserted === true
    && r.secondVisible === true && r.cancelled === true
    && r.browserInserted === true && r.movedKept === true && r.passwordRefused === true
    && r.clipboardSame === true
    && Boolean(r.tray && r.tray.found && r.tray.offSaved && r.tray.offHotkey && r.tray.offUnchecked && r.tray.onSaved && r.tray.onHotkey && r.tray.onChecked);
  console.log('FIELD_QA ' + JSON.stringify({ ok, ...r, out }));
  finish(ok ? 0 : 1);
}

app.whenReady().then(() => run().catch((err) => { console.error(err.stack); finish(1); }));
require('../main');
