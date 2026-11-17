'use strict';

/* Живая проверка восьми сфер Nox Aether в настоящем Electron и во временном профиле.
 *
 * Проверяет: все сферы библиотеки (nox:nox, nox:wire и шесть авторских), все состояния
 * помощника, голосовую реакцию, паузу в скрытом окне, «уменьшение движения» (два побитно
 * равных кадра), DPR, FPS, бюджет кадра, Мастерскую (пресеты и «Сбросить эту сферу»)
 * и сохранение выбранной сферы после перезапуска приложения.
 *
 * Запуск из apps/jarvis-desktop:
 *   node scripts\orbs-qa.js --out-dir <папка> [--only flux,comb] [--keep-temp]
 *   — сам поднимает Electron дважды (проверка и перезапуск) на одном временном профиле.
 *
 * Прямой запуск, как у scripts\aether-qa.js и scripts\chat-p1-shot.js:
 *   .\node_modules\electron\dist\electron.exe scripts\orbs-qa.js --out-dir <папка> --state-dir <папка>
 *   тот же вызов с --restart — второй запуск на тех же данных (проверка сохранения выбора).
 *
 * Параметры:
 *   --out-dir <папка>   куда класть снимки и JSON-отчёт (по умолчанию папка во временных файлах);
 *   --only <список>     только выбранные сферы: через запятую, полные id или короткие имена
 *                       (flux, membrane, resonance, crystal, plasma, comb, wire, nox);
 *   --state-dir <папка> профиль и данные стенда (для --restart обязателен тот же, что в первом запуске);
 *   --keep-temp         не удалять временный профиль после прогона через node.
 *
 * Настоящие %APPDATA%, data/ и .env не читаются: профиль, данные и рабочая папка — временные.
 * Модель не вызывается, внешняя сеть не нужна.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const ORB_ORDER = [
  'nox:nox', 'nox:wire',
  'aether:flux', 'aether:membrane', 'aether:resonance',
  'aether:crystal', 'aether:plasma', 'aether:comb',
];
const SHORT = {
  'nox:nox': 'nox',
  'nox:wire': 'wire',
  'aether:flux': 'flux',
  'aether:membrane': 'membrane',
  'aether:resonance': 'resonance',
  'aether:crystal': 'crystal',
  'aether:plasma': 'plasma',
  'aether:comb': 'comb',
};
const SHORT_TO_ID = Object.fromEntries(Object.entries(SHORT).map(([id, name]) => [name, id]));
const APP_STATES = [
  'idle', 'listening', 'thinking', 'searching', 'speaking', 'acting',
  'verifying', 'waiting_approval', 'success', 'partial', 'cancelled', 'error',
];
const ORB_STATES_ALL = ['idle', 'listening', 'thinking', 'speaking', 'waiting_approval', 'success', 'error'];
const VISIBLE_MIN = 220;
const PHASE_TIMEOUT_MS = 240000;

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}
function has(name) {
  return process.argv.includes('--' + name);
}
function log() {
  console.log.apply(console, ['[orbs-qa]'].concat(Array.from(arguments)));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOnly(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ids: null, error: '' };
  const parts = raw.split(/[,;\s]+/).filter(Boolean);
  const ids = [];
  const unknown = [];
  for (const part of parts) {
    const key = part.trim().toLowerCase();
    let id = '';
    if (ORB_ORDER.indexOf(key) >= 0) id = key;
    else if (SHORT_TO_ID[key]) id = SHORT_TO_ID[key];
    if (!id) { unknown.push(part); continue; }
    if (ids.indexOf(id) < 0) ids.push(id);
  }
  if (unknown.length) {
    return { ids: [], error: 'неизвестные сферы: ' + unknown.join(', ') + '. Доступны: ' + ORB_ORDER.join(', ') };
  }
  if (!ids.length) return { ids: null, error: '' };
  const ordered = ORB_ORDER.filter((id) => ids.indexOf(id) >= 0);
  return { ids: ordered, error: '' };
}

function readReport(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function cleanOldTemp() {
  const prefix = 'nox-orbs-qa-';
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.indexOf(prefix) !== 0) continue;
    const full = path.join(os.tmpdir(), entry.name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > 2 * 60 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true });
    } catch { /* чужой или занятый каталог пропускаем */ }
  }
}

let electronModule = null;
try { electronModule = require('electron'); } catch { electronModule = null; }
const ELECTRON_RUNTIME = Boolean(
  electronModule && typeof electronModule === 'object' && electronModule.app
  && typeof electronModule.app.whenReady === 'function',
);

if (!ELECTRON_RUNTIME) runNodeWrapper();
else startElectronPhase();

// ── Запуск через node: два прогона Electron на одном временном профиле ──
function runNodeWrapper() {
  const only = parseOnly(arg('only', ''));
  if (only.error) {
    console.error('orbs-qa: ' + only.error);
    process.exit(1);
    return;
  }
  const outArg = arg('out-dir', '');
  const outDir = outArg ? path.resolve(outArg) : path.join(os.tmpdir(), 'nox-orbs-qa');
  const stateArg = arg('state-dir', '');
  const keepTemp = has('keep-temp');
  const electronPath = typeof electronModule === 'string' && electronModule
    ? electronModule
    : path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!electronPath || !fs.existsSync(electronPath)) {
    console.error('orbs-qa: не найден Electron. Запустите из apps/jarvis-desktop после установки зависимостей.');
    process.exit(1);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  cleanOldTemp();
  const stateRoot = stateArg ? path.resolve(stateArg) : fs.mkdtempSync(path.join(os.tmpdir(), 'nox-orbs-qa-'));
  fs.mkdirSync(stateRoot, { recursive: true });
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const baseArgs = [__filename, '--out-dir', outDir, '--state-dir', stateRoot];
  if (only.ids) baseArgs.push('--only', only.ids.join(','));

  function runPhase(extra) {
    return new Promise((resolve) => {
      log('запуск: ' + (extra.length ? extra.join(' ') : 'проверка сфер'));
      let settled = false;
      const child = spawn(electronPath, baseArgs.concat(extra), { env, stdio: 'inherit', windowsHide: false });
      const timer = setTimeout(() => {
        if (settled) return;
        log('прогон не уложился в ' + Math.round(PHASE_TIMEOUT_MS / 1000) + ' с, останавливаем');
        try { child.kill(); } catch { /* уже нет */ }
      }, PHASE_TIMEOUT_MS);
      const done = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      };
      child.on('error', (error) => { log('не удалось запустить Electron: ' + error.message); done(1); });
      child.on('exit', (code) => done(code === null ? 1 : code));
    });
  }

  (async () => {
    const recordCode = await runPhase([]);
    const record = readReport(path.join(outDir, 'orbs-qa-record.json'));
    let restartCode = 1;
    let restart = null;
    if (recordCode === 0 && record && record.ok) {
      restartCode = await runPhase(['--restart']);
      restart = readReport(path.join(outDir, 'orbs-qa-restart.json'));
    } else {
      log('основная проверка не прошла — перезапуск не проверялся');
    }
    const checks = [].concat(
      record && Array.isArray(record.checks) ? record.checks : [],
      restart && Array.isArray(restart.checks) ? restart.checks : [],
    );
    const pass = checks.filter((c) => c.ok).length;
    const fail = checks.length - pass;
    const report = {
      ok: Boolean(record && record.ok && restart && restart.ok && restartCode === 0),
      outDir,
      stateDir: stateRoot,
      savedAt: new Date().toISOString(),
      pass,
      fail,
      record,
      restart,
      checks,
    };
    fs.writeFileSync(path.join(outDir, 'orbs-qa-report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('ORBS_QA ' + JSON.stringify({ ok: report.ok, pass, fail, outDir }));
    if (!report.ok) {
      for (const item of checks.filter((c) => !c.ok)) {
        console.log('FAIL ' + item.name + (item.detail === undefined ? '' : ' ' + JSON.stringify(item.detail)));
      }
    }
    console.log(report.ok ? 'ORBS_QA_OK' : 'ORBS_QA_FAIL');
    if (!keepTemp && !stateArg) {
      try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch { /* не мешает итогу */ }
    } else {
      console.log('ORBS_QA_STATE_DIR ' + stateRoot);
    }
    process.exit(report.ok ? 0 : 1);
  })().catch((error) => {
    console.error('orbs-qa: ' + (error && error.stack ? error.stack : error));
    process.exit(1);
  });
}

// ── Прогон внутри Electron ─────────────────────────────────────────────
function startElectronPhase() {
  const { app, BrowserWindow, globalShortcut, shell } = electronModule;
  const restart = has('restart');
  const mode = restart ? 'restart' : 'record';
  const outArg = arg('out-dir', '');
  const outDir = outArg ? path.resolve(outArg) : path.join(os.tmpdir(), 'nox-orbs-qa');
  const only = parseOnly(arg('only', ''));
  const stateArg = arg('state-dir', '');
  fs.mkdirSync(outDir, { recursive: true });

  const stateRoot = stateArg ? path.resolve(stateArg) : fs.mkdtempSync(path.join(os.tmpdir(), 'nox-orbs-qa-'));
  const sessionFile = path.join(stateRoot, 'session.json');
  const profileDir = path.join(stateRoot, 'profile');
  const dataDir = path.join(stateRoot, 'data');
  const workspaceDir = path.join(stateRoot, 'workspace');
  for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });

  if (!restart) {
    const settingsFile = path.join(dataDir, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(settingsFile, JSON.stringify({
        uiShell: 'aether', mode: 'ask', voice: false, backgroundModelRuns: false,
        alwaysListen: false, dictation: false, desktopOverlay: false, alwaysOnTop: false,
        motion: true, seededBrief: true, screenAuto: false,
      }, null, 2), 'utf8');
    }
    const conversationFile = path.join(dataDir, 'conversation.json');
    if (!fs.existsSync(conversationFile)) {
      fs.writeFileSync(conversationFile, JSON.stringify({
        activeId: 'qa-orbs',
        chats: [{ id: 'qa-orbs', title: 'Новый чат', updatedAt: Date.now(), history: [] }],
      }, null, 2), 'utf8');
    }
  }

  app.setPath('userData', profileDir);
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  for (const key of Object.keys(process.env)) {
    if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
  }
  process.env.NOX_DATA_DIR = dataDir;
  require(path.join(APP_DIR, 'src', 'config', 'paths')).projectRoot = () => stateRoot;
  globalShortcut.register = () => true;
  globalShortcut.unregister = () => {};
  globalShortcut.unregisterAll = () => {};
  shell.openExternal = async () => '';

  const checks = [];
  const consoleErrors = [];
  const pageErrors = [];
  const screenshots = [];
  let mainWin = null;
  let finished = false;
  let session = null;
  if (restart) {
    session = readReport(sessionFile);
    if (!session || !session.selectedOrb) {
      checks.push({
        name: 'Перезапуск: есть данные первого запуска',
        ok: false,
        detail: 'нет ' + sessionFile + '; запустите основной прогон с тем же --state-dir',
      });
      finishPhase(mode, checks, { outDir, stateDir: stateRoot, screenshots, consoleErrors, pageErrors });
      return;
    }
  }

  function check(name, ok, detail) {
    checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
    console.log((ok ? 'OK ' : 'FAIL ') + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail)));
  }

  function finishPhase(phase, list, extra) {
    if (finished) return;
    finished = true;
    const ok = list.every((c) => c.ok);
    const pass = list.filter((c) => c.ok).length;
    const report = {
      ok,
      mode: phase,
      outDir,
      stateDir: stateRoot,
      savedAt: new Date().toISOString(),
      pass,
      fail: list.length - pass,
      checks: list,
      screenshots,
      consoleErrors,
      pageErrors,
      ...(extra || {}),
    };
    try {
      fs.writeFileSync(path.join(outDir, 'orbs-qa-' + phase + '.json'), JSON.stringify(report, null, 2), 'utf8');
    } catch (error) {
      console.error('orbs-qa: не удалось записать отчёт: ' + error.message);
    }
    console.log('ORBS_QA_PHASE ' + JSON.stringify({ mode: phase, ok, pass, fail: list.length - pass, outDir, stateDir: stateRoot }));
    console.log('ORBS_QA_' + (ok ? 'OK' : 'FAIL'));
    if (!stateArg) console.log('ORBS_QA_STATE_DIR ' + stateRoot);
    setTimeout(() => app.exit(ok ? 0 : 1), 150);
  }

  // ── Помощники страницы ────────────────────────────────────────────
  function js(code) {
    return mainWin.webContents.executeJavaScript(code);
  }
  function call(fn) {
    const args = Array.prototype.slice.call(arguments, 1);
    return js('(' + fn.toString() + ')(' + args.map((value) => JSON.stringify(value === undefined ? null : value)).join(',') + ')');
  }
  async function waitFor(code, timeoutMs, step) {
    const started = Date.now();
    const waitMs = step || 120;
    const limit = timeoutMs || 20000;
    for (;;) {
      try { if (await js(code)) return true; } catch { /* страница ещё грузится */ }
      if (Date.now() - started > limit) return false;
      await sleep(waitMs);
    }
  }
  async function shot(name) {
    const image = await mainWin.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name + '.png'), image.toPNG());
    screenshots.push(name + '.png');
    return image.getSize();
  }
  async function shotCrop(name, rect) {
    const image = await mainWin.webContents.capturePage({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)),
    });
    fs.writeFileSync(path.join(outDir, name + '.png'), image.toPNG());
    screenshots.push(name + '.png');
    return image;
  }
  async function cropImage(rect) {
    return mainWin.webContents.capturePage({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)),
    });
  }
  async function stageRect() {
    return call(readStageRect);
  }
  async function sizeTo(width, height) {
    mainWin.setContentSize(width, height);
    await sleep(650);
    return js('({ w: innerWidth, h: innerHeight })');
  }
  async function setMotionEmulation(value) {
    try {
      if (!mainWin.webContents.debugger.isAttached()) mainWin.webContents.debugger.attach('1.3');
      await mainWin.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: value }],
      });
      return true;
    } catch (error) {
      console.log('EMULATION_FAIL ' + error.message);
      return false;
    }
  }

  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') consoleErrors.push(String(event.message || '').slice(0, 400));
    });
    win.webContents.on('render-process-gone', (_event, details) => pageErrors.push(JSON.stringify(details)));
    win.webContents.once('did-finish-load', () => {
      if (mainWin) return;
      if (!/renderer[\\/]aether[\\/]index\.html/i.test(win.webContents.getURL())) return;
      mainWin = win;
      const run = restart ? runRestartPhase() : runRecordPhase();
      run.catch((error) => finishPhase(mode, checks, {
        error: error && error.stack ? error.stack : String(error),
        screenshots, consoleErrors, pageErrors,
      }));
    });
  });

  setTimeout(() => {
    if (finished) return;
    check('Прогон уложился в отведённое время', false, 'таймаут ' + Math.round(PHASE_TIMEOUT_MS / 1000) + ' с');
    finishPhase(mode, checks, { screenshots, consoleErrors, pageErrors });
  }, PHASE_TIMEOUT_MS);

  // ── Основная проверка ─────────────────────────────────────────────
  async function runRecordPhase() {
    const ready = await waitFor("Boolean(window.__noxAether && window.NoxOrbLibrary && window.NoxOrbsExtra)");
    check('Экран Aether загрузился, библиотека сфер на месте', ready);
    if (!ready) { finishPhase('record', checks, { error: 'страница не готова', screenshots, consoleErrors, pageErrors }); return; }
    await setMotionEmulation('no-preference');
    await sleep(400);

    const registry = await call(readRegistry);
    const ids = Array.isArray(registry.ids) ? registry.ids : [];
    const missing = ORB_ORDER.filter((id) => ids.indexOf(id) < 0);
    const extra = ids.filter((id) => ORB_ORDER.indexOf(id) < 0);
    check('В библиотеке ровно восемь сфер, лишних нет',
      ids.length === 8 && missing.length === 0 && extra.length === 0,
      { ids: ids, missing: missing, extra: extra });
    check('По умолчанию выбрана «Сетка Nox» (wire)', registry.active === 'nox:wire', { active: registry.active });
    check('Авторские сферы подключаются рядом с библиотекой',
      registry.companion >= 1 && registry.groups.indexOf('Авторские сферы') >= 0 && registry.groups.indexOf('Система Nox') >= 0,
      { companion: registry.companion, groups: registry.groups });
    check('Подписи сфер на русском', registry.names.every((name) => /[А-Яа-яЁё]/.test(String(name))), registry.names);

    const selected = only.error
      ? []
      : (only.ids ? only.ids.filter((id) => ids.indexOf(id) >= 0) : ids.slice());
    check('Параметр --only выбрал существующие сферы', selected.length > 0, { selected: selected, onlyError: only.error || '' });
    if (!selected.length) { finishPhase('record', checks, { error: only.error || 'пустой --only', screenshots, consoleErrors, pageErrors }); return; }
    const newOrb = selected.filter((id) => id.indexOf('aether:') === 0)[0] || '';
    const selectedOrb = newOrb || selected[0];

    await js("window.__noxAether.setRoute('chat')");
    await sleep(800);
    const size1200 = await sizeTo(1200, 720);
    check('Окно 1200×720', size1200.w === 1200 && size1200.h === 720, size1200);

    // 1. Каждая сфера на сцене: 1200×720 и вырезка сцены
    const stageInfo = {};
    for (const id of selected) {
      const short = SHORT[id];
      await js('window.NoxOrbLibrary.setActive(' + JSON.stringify(id) + ')');
      await sleep(950);
      const info = await call(readStageInfo);
      const rect = await stageRect();
      const full = await shot('orb-' + short + '-1200x720');
      const cropped = await shotCrop('orb-' + short + '-stage', rect);
      const visible = visiblePixels(cropped);
      stageInfo[id] = info;
      check('Сфера «' + info.title + '» на сцене 1200×720',
        info.activeId === id && info.stageOrbId === id && info.canvas.cssW > 100 && full.width === 1200 && full.height === 720,
        { stage: info, shot: full });
      check('Сфера «' + info.title + '» видна на сцене (непустые пиксели)', visible >= VISIBLE_MIN, { pixels: visible });
    }

    // 2. Те же сферы на узком окне 864×520
    const size864 = await sizeTo(864, 520);
    check('Окно 864×520', size864.w === 864 && size864.h === 520, size864);
    for (const id of selected) {
      const short = SHORT[id];
      await js('window.NoxOrbLibrary.setActive(' + JSON.stringify(id) + ')');
      await sleep(750);
      const info = await call(readStageInfo);
      const full = await shot('orb-' + short + '-864x520');
      check('Сфера «' + info.title + '» на узком окне 864×520',
        info.activeId === id && info.canvas.cssW > 60 && full.width === 864 && full.height === 520,
        { stage: info, shot: full });
    }
    await sizeTo(1200, 720);
    await js('window.NoxOrbLibrary.setActive(' + JSON.stringify(selectedOrb) + ')');
    await sleep(500);

    // 3. Все состояния помощника: каждая сфера через живой движок библиотеки
    const probe = await call(probeOrbStates, selected);
    for (const id of selected) {
      const row = probe[id];
      const title = stageInfo[id] ? stageInfo[id].title : id;
      check('Состояния: «' + title + '» принимает все рабочие статусы', Boolean(row) && row.mismatch.length === 0, row ? row.mismatch : null);
      if (!row) continue;
      const allDrawn = APP_STATES.every((state) => row.rows[state] && row.rows[state].lit > 0);
      check('Состояния: «' + title + '» рисуется в каждом статусе', allDrawn, row.rows);
      check('Состояния: «' + title + '» различает покой, успех и ошибку',
        row.contrast.idle.sum !== row.contrast.error.sum && row.contrast.idle.sum !== row.contrast.success.sum,
        { idle: row.contrast.idle.sum, success: row.contrast.success.sum, error: row.contrast.error.sum });
      check('Голос: «' + title + '» реагирует на уровень 0..1', row.voice > 0.05, { voice: row.voice });
    }

    // 4. Состояния на настоящей сцене по событиям ядра
    const pipeline = await call(driveStageStates);
    const expectedPipeline = [
      ['idle', 'Ждёт'], ['listening', 'Слушает'], ['thinking', 'Думает'],
      ['speaking', 'Отвечает'], ['waiting_approval', 'Ждёт решения'],
      ['error', 'Ошибка'], ['cancelled', 'Остановлено'], ['success', 'Готово'],
    ];
    const pipelineOk = pipeline.length === expectedPipeline.length && pipeline.every((row, index) => {
      const expected = expectedPipeline[index];
      return row.state === expected[0] && String(row.text || '').indexOf(expected[1]) === 0;
    });
    check('Сцена показывает все семь состояний и русскую подпись', pipelineOk, pipeline);
    if (pipelineOk) {
      await call(resetStageAfterPipeline);
      await sleep(400);
    } else {
      await call(resetStageAfterPipeline);
      await sleep(400);
    }

    // 5. Уменьшение движения: сфера стоит, но видна; без reduce — движется
    const motionOrb = newOrb || selected[0];
    await js('window.NoxOrbLibrary.setActive(' + JSON.stringify(motionOrb) + ')');
    await sleep(700);
    const reduceOk = await setMotionEmulation('reduce');
    await sleep(850);
    const reduceRect = await stageRect();
    const stillA = await cropImage(reduceRect);
    await sleep(800);
    const stillB = await cropImage(reduceRect);
    const stillSame = Buffer.compare(stillA.toPNG(), stillB.toPNG()) === 0;
    const stillVisible = visiblePixels(stillA);
    fs.writeFileSync(path.join(outDir, 'reduce-still-' + SHORT[motionOrb] + '.png'), stillA.toPNG());
    screenshots.push('reduce-still-' + SHORT[motionOrb] + '.png');
    check('Уменьшение движения: два кадра сцены побитно равны', reduceOk && stillSame, { same: stillSame });
    check('Уменьшение движения: сфера видна, а не исчезла', stillVisible >= VISIBLE_MIN, { pixels: stillVisible });
    await setMotionEmulation('no-preference');
    await sleep(750);
    const moveA = await cropImage(reduceRect);
    await sleep(650);
    const moveB = await cropImage(reduceRect);
    check('Обычный режим: сфера анимируется', Buffer.compare(moveA.toPNG(), moveB.toPNG()) !== 0, { differs: true });

    // 6. Пауза в скрытом окне
    await call(setupHiddenProbe);
    await sleep(1400);
    const beforeHide = await call(readHiddenProbe);
    mainWin.hide();
    await sleep(900);
    const hiddenState = await call(readHiddenProbe);
    const afterHide = await call(readHiddenProbe);
    mainWin.show();
    await sleep(900);
    const afterShow = await call(readHiddenProbe);
    await call(cleanupHiddenProbe);
    check('Скрытое окно: сфера не рисует лишние кадры',
      hiddenState.hidden === true && afterHide.frames - beforeHide.frames <= 2 && afterShow.frames > afterHide.frames,
      { beforeHide: beforeHide.frames, afterHide: afterHide.frames, afterShow: afterShow.frames, hidden: hiddenState.hidden });

    // 7. DPR и FPS
    const dprInfo = await call(dprProbe);
    check('DPR: backing store сцены = CSS × devicePixelRatio (не больше 2)',
      dprInfo.stage.backingW === dprInfo.stage.expectedW && dprInfo.stage.backingH === dprInfo.stage.expectedH,
      dprInfo.stage);
    check('DPR 2 в живом окне: backing store вдвое больше CSS',
      dprInfo.explicit.backingW === 400 && dprInfo.explicit.backingH === 400,
      dprInfo.explicit);
    const pageFps = await call(measurePageFps, 1500);
    check('FPS: страница с анимированной сферой не ниже 40 кадров/с', pageFps.fps >= 40, pageFps);

    // 8. Бюджет кадра авторских сфер
    const customVariants = selected
      .filter((id) => id.indexOf('aether:') === 0)
      .map((id) => id.split(':')[1]);
    const budget = customVariants.length ? await call(measureBudget, customVariants) : {};
    for (const variant of customVariants) {
      const stats = budget[variant] || {};
      check('Бюджет кадра «' + variant + '»: меньше 4 мс', stats.frameMs < 4 && stats.frames > 10, stats);
    }

    // 9. Мастерская: пресеты и сброс к дефолтам
    const workshop = await call(workshopFlow, newOrb || '');
    check('Мастерская: все восемь карточек сфер', workshop.cards.length === 8, workshop.cards);
    check('Мастерская: группа авторских сфер и русские подписи',
      workshop.groups.indexOf('Авторские сферы') >= 0, workshop.groups);
    if (newOrb) {
      const defaults = workshop.defaults || {};
      const reset = workshop.resetSettings || {};
      const defaultsMatch = Object.keys(defaults).every((key) => reset[key] === defaults[key]);
      check('Мастерская: «Сбросить эту сферу» возвращает дефолты',
        defaultsMatch && reset.presetId === 'default'
        && workshop.vividSettings && workshop.vividSettings.speed > 1,
        { defaults: defaults, afterVivid: workshop.vividSettings, afterReset: reset });
      check('Мастерская: у авторской сферы три пресета, четыре ползунка и два переключателя',
        workshop.presets.length >= 4 && workshop.ranges === 4 && workshop.switches === 2 && workshop.previewOk,
        { presets: workshop.presets, ranges: workshop.ranges, switches: workshop.switches, preview: workshop.previewOk });
    }

    // 10. Подготовка проверки перезапуска
    await js('window.__noxAether.setRoute("chat")');
    await sleep(600);
    const persist = await call(preparePersistence, selectedOrb);
    session = {
      selectedOrb: selectedOrb,
      selectedName: stageInfo[selectedOrb] ? stageInfo[selectedOrb].title : selectedOrb,
      settings: persist.settings,
      only: only.ids || null,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), 'utf8');
    check('Выбор новой сферы сохранён в библиотеке', persist.activeId === selectedOrb && persist.savedActive === selectedOrb, persist);
    await shot('selected-' + SHORT[selectedOrb] + '-1200x720');

    const errorsOk = consoleErrors.filter((line) => /orbs-extra|orb-library|Uncaught|TypeError|ReferenceError/.test(line)).length === 0;
    check('Ошибок в консоли страницы и падений рендерера нет', errorsOk && pageErrors.length === 0, { consoleErrors: consoleErrors, pageErrors: pageErrors });

    finishPhase('record', checks, { stageInfo: stageInfo, selectedOrb: selectedOrb, budget: budget });
  }

  // ── Проверка после перезапуска приложения ─────────────────────────
  async function runRestartPhase() {
    const ready = await waitFor("Boolean(window.__noxAether && window.NoxOrbLibrary && window.NoxOrbsExtra)");
    check('Перезапуск: экран Aether и библиотека сфер загрузились', ready);
    if (!ready) { finishPhase('restart', checks, { screenshots, consoleErrors, pageErrors }); return; }
    await js("window.__noxAether.setRoute('chat')");
    await sleep(900);
    const expected = session.selectedOrb;
    const state = await call(readRestartState, expected);
    const title = session.selectedName || SHORT[expected];
    check('Перезапуск: в библиотеке по-прежнему восемь сфер', state.count === 8, { count: state.count, ids: state.ids });
    check('Перезапуск: выбор сферы сохранён (' + title + ')',
      state.activeId === expected && state.savedActive === expected, { activeId: state.activeId, savedActive: state.savedActive, expected: expected });
    check('Перезапуск: сцена сразу показывает сохранённую сферу', state.stageOrbId === expected, { stageOrbId: state.stageOrbId });
    const settingsNow = state.settings || {};
    const settingsBefore = session.settings || {};
    const settingsSame = Object.keys(settingsBefore).every((key) => settingsNow[key] === settingsBefore[key]);
    check('Перезапуск: настройки сферы не потерялись', settingsSame, { before: settingsBefore, now: settingsNow });

    const rect = await stageRect();
    const cropped = await shotCrop('restart-' + SHORT[expected] + '-stage', rect);
    const visible = visiblePixels(cropped);
    const full = await shot('restart-' + SHORT[expected] + '-1200x720');
    check('Перезапуск: сохранённая сфера видна на сцене',
      visible >= VISIBLE_MIN && full.width === 1200 && full.height === 720, { pixels: visible, shot: full });
    const errorsOk = consoleErrors.filter((line) => /orbs-extra|orb-library|Uncaught|TypeError|ReferenceError/.test(line)).length === 0;
    check('Перезапуск: ошибок в консоли нет', errorsOk && pageErrors.length === 0, { consoleErrors: consoleErrors, pageErrors: pageErrors });
    finishPhase('restart', checks, { selectedOrb: expected, screenshots: screenshots });
  }

  require(path.join(APP_DIR, 'main.js'));
}

// ── Функции страницы (исполняются в окне через executeJavaScript) ──────
function readStageRect() {
  const canvas = document.querySelector('#aeOrbCanvas');
  const stage = document.querySelector('#aeOrbStage');
  const node = canvas || stage;
  const rect = node.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function readRegistry() {
  const lib = window.NoxOrbLibrary;
  return {
    ids: lib.list().map((orb) => orb.id),
    names: lib.list().map((orb) => orb.name),
    groups: Array.from(new Set(lib.list().map((orb) => orb.systemLabel))),
    active: lib.getActiveId(),
    companion: Array.from(document.scripts).filter((script) => /orbs-extra\.js/.test(script.src)).length,
  };
}

function readStageInfo() {
  const stage = document.querySelector('#aeOrbStage');
  const canvas = document.querySelector('#aeOrbCanvas');
  const rect = canvas.getBoundingClientRect();
  const snap = window.NoxOrbLibrary.getSnapshot();
  return {
    activeId: window.NoxOrbLibrary.getActiveId(),
    stageOrbId: stage.dataset.orbId,
    stageEngine: stage.dataset.orbEngine,
    title: snap.activeSpec.name,
    subtitle: snap.activeSpec.subtitle,
    canvas: { cssW: Math.round(rect.width), cssH: Math.round(rect.height), w: canvas.width, h: canvas.height },
    dpr: window.devicePixelRatio,
  };
}

async function probeOrbStates(orbIds) {
  const lib = window.NoxOrbLibrary;
  const states = ['idle', 'listening', 'thinking', 'searching', 'speaking', 'acting', 'verifying', 'waiting_approval', 'success', 'partial', 'cancelled', 'error'];
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:6px;bottom:6px;width:220px;height:220px;opacity:0.02;pointer-events:none;z-index:9999';
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const sample = () => {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 28) {
      const value = data[i] + data[i + 1] + data[i + 2];
      if (value > 90) lit += 1;
      sum = (sum + value * ((i % 89) + 1)) % 1000000007;
    }
    return { lit: lit, sum: sum };
  };
  const result = {};
  for (const id of orbIds) {
    const handle = lib.mount(canvas, id, { globalAnimated: true, state: 'idle' });
    if (!handle || !handle.raw) {
      result[id] = { mismatch: ['движок не создался'], rows: {}, contrast: {}, voice: -1, rawState: '' };
      continue;
    }
    const rows = {};
    const mismatch = [];
    for (const state of states) {
      handle.setState(state);
      await frame();
      const expected = lib.mapState('nox', state);
      if (!handle.raw.state || handle.raw.state !== expected) {
        mismatch.push(state + ': ' + handle.raw.state + ' вместо ' + expected);
      }
      rows[state] = sample();
    }
    const contrast = {};
    for (const state of ['idle', 'success', 'error']) {
      handle.setState(state);
      await pause(360);
      contrast[state] = sample();
    }
    handle.setState('listening');
    handle.setVoice(1);
    await pause(400);
    const voice = typeof handle.raw.voice === 'number' ? handle.raw.voice : -1;
    const rawState = handle.raw.state;
    handle.setVoice(0);
    handle.destroy();
    result[id] = { mismatch: mismatch, rows: rows, contrast: contrast, voice: voice, rawState: rawState };
  }
  canvas.remove();
  return result;
}

async function driveStageStates() {
  const store = window.__noxAether.store;
  const stage = document.querySelector('#aeOrbStage');
  const badge = document.querySelector('#aeOrbStage .ae-orb-status');
  const text = document.querySelector('#aeOrbStage .ae-orb-status-text');
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = () => ({
    state: stage ? stage.dataset.state : '',
    badge: badge ? badge.dataset.state : '',
    text: text ? String(text.textContent || '') : '',
  });
  const steps = [
    { name: 'idle', agent: [], wait: 260 },
    { name: 'listening', dictation: [{ type: 'mode', recording: true }], wait: 320 },
    { name: 'thinking', dictation: [{ type: 'mode', recording: false }], agent: [{ type: 'status', status: 'planning' }], wait: 320 },
    { name: 'speaking', agent: [{ type: 'status', state: 'speaking' }], wait: 320 },
    { name: 'waiting_approval', agent: [{ type: 'status', status: 'awaiting_approval' }], wait: 320 },
    { name: 'error', agent: [{ type: 'status', status: 'failed' }], wait: 320 },
    { name: 'cancelled', agent: [{ type: 'status', status: 'cancelled' }], wait: 320 },
    {
      name: 'success',
      agent: [
        { type: 'status', status: 'planning' },
        { type: 'tool_start', id: 'qa-orb-step', name: 'file_exists', args: { path: 'qa.txt' }, step: 1 },
        { type: 'tool_result', id: 'qa-orb-step', name: 'file_exists', ok: true, summary: 'проверено', verified: 'confirmed' },
        { type: 'done', status: 'done', replyText: 'Проверка сферы завершена.' },
      ],
      wait: 420,
    },
  ];
  const rows = [];
  for (const step of steps) {
    if (step.dictation) for (const event of step.dictation) store.onDictationEvent(event);
    if (step.agent) for (const event of step.agent) store.onAgentEvent(event);
    await pause(step.wait);
    const current = read();
    rows.push({ expected: step.name, state: current.state, badge: current.badge, text: current.text });
  }
  return rows;
}

async function resetStageAfterPipeline() {
  const store = window.__noxAether.store;
  try { await store.createNewChat(); } catch (error) { /* пустой чат не обязателен */ }
  return true;
}

function setupHiddenProbe() {
  const canvas = document.createElement('canvas');
  canvas.id = 'qaOrbHiddenProbe';
  canvas.style.cssText = 'position:fixed;left:8px;bottom:8px;width:220px;height:220px;opacity:0.02;pointer-events:none;z-index:9999';
  document.body.append(canvas);
  const probe = window.NoxOrbsExtra.createOrb('flux')(canvas, { state: 'thinking' });
  window.__qaOrbHiddenProbe = probe;
  return true;
}

function readHiddenProbe() {
  const probe = window.__qaOrbHiddenProbe;
  return { frames: probe ? probe.getStats().frames : 0, hidden: document.hidden };
}

function cleanupHiddenProbe() {
  try { if (window.__qaOrbHiddenProbe) window.__qaOrbHiddenProbe.destroy(); } catch (error) { /* уже нет */ }
  const canvas = document.querySelector('#qaOrbHiddenProbe');
  if (canvas) canvas.remove();
  window.__qaOrbHiddenProbe = null;
  return true;
}

function dprProbe() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:6px;top:6px;width:200px;height:200px;opacity:0.02;pointer-events:none;z-index:9999';
  document.body.append(canvas);
  const probe = window.NoxOrbsExtra.createOrb('crystal')(canvas, { dpr: 2 });
  const explicit = { css: 200, backingW: canvas.width, backingH: canvas.height };
  probe.destroy();
  canvas.remove();
  const stage = document.querySelector('#aeOrbCanvas');
  const rect = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.round(rect.width);
  const cssH = Math.round(rect.height);
  return {
    explicit: explicit,
    stage: {
      cssW: cssW, cssH: cssH,
      backingW: stage.width, backingH: stage.height,
      expectedW: Math.round(cssW * dpr), expectedH: Math.round(cssH * dpr),
      dpr: window.devicePixelRatio,
    },
  };
}

async function measurePageFps(ms) {
  const started = performance.now();
  let frames = 0;
  await new Promise((resolve) => {
    function tick() {
      frames += 1;
      if (performance.now() - started < ms) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });
  const elapsed = Math.max(1, performance.now() - started);
  return { frames: frames, ms: Math.round(elapsed), fps: Math.round((frames * 1000) / elapsed) };
}

async function measureBudget(variants) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:6px;top:6px;width:280px;height:280px;opacity:0.02;pointer-events:none;z-index:9999';
  document.body.append(canvas);
  const api = window.NoxOrbsExtra;
  const out = {};
  for (const variant of variants) {
    const orb = api.createOrb(variant)(canvas, { state: 'thinking', dpr: Math.min(window.devicePixelRatio || 1, 2) });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const stats = orb.getStats();
    out[variant] = { frameMs: stats.frameMs, drawMs: stats.drawMs, fps: Math.round(stats.fps), frames: stats.frames, dpr: stats.dpr };
    orb.destroy();
  }
  canvas.remove();
  return out;
}

async function workshopFlow(orbId) {
  if (window.__noxAether) window.__noxAether.setRoute('settings');
  await new Promise((resolve) => setTimeout(resolve, 800));
  const cards = Array.from(document.querySelectorAll('#aeSettingsView .ae-orb-choice')).map((el) => el.id);
  const groups = Array.from(document.querySelectorAll('#aeSettingsView .ae-group-label')).map((el) => String(el.textContent || '').trim());
  const card = orbId ? document.querySelector('#aeOrbCard_' + orbId.replace(':', '_')) : null;
  if (card) card.click();
  await new Promise((resolve) => setTimeout(resolve, 650));
  const presets = Array.from(document.querySelectorAll('#aeSettingsView .ae-preset-row button')).map((b) => String(b.textContent || '').trim());
  const ranges = document.querySelectorAll('#aeSettingsView .ae-orb-controls-col input[type="range"]').length;
  const switches = document.querySelectorAll('#aeSettingsView .ae-orb-controls-col input[type="checkbox"]').length;
  const preview = document.querySelector('#aeSettingsView .ae-orb-preview-canvas');
  const lib = window.NoxOrbLibrary;
  const vivid = Array.from(document.querySelectorAll('#aeSettingsView .ae-preset-row button')).find((b) => /Выразительная/.test(String(b.textContent || '')));
  if (vivid) vivid.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const vividSettings = orbId ? lib.getSettings(orbId) : null;
  const reset = Array.from(document.querySelectorAll('#aeSettingsView button')).find((b) => /Сбросить эту сферу/i.test(String(b.textContent || '')));
  if (reset) reset.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const resetSettings = orbId ? lib.getSettings(orbId) : null;
  const defaults = orbId ? lib.get(orbId).defaults : null;
  const previewOk = Boolean(preview && preview.width > 40);
  if (window.__noxAether) window.__noxAether.setRoute('chat');
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    cards: cards, groups: groups, presets: presets, ranges: ranges, switches: switches,
    previewOk: previewOk, vividSettings: vividSettings, resetSettings: resetSettings,
    defaults: defaults, active: lib.getActiveId(),
  };
}

function preparePersistence(orbId) {
  const lib = window.NoxOrbLibrary;
  lib.setActive(orbId);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('aether.orbLibrary') || 'null'); } catch (error) { saved = null; }
  return { activeId: lib.getActiveId(), savedActive: saved && saved.activeId, settings: lib.getSettings(orbId) };
}

function readRestartState(orbId) {
  const lib = window.NoxOrbLibrary;
  const stage = document.querySelector('#aeOrbStage');
  const canvas = document.querySelector('#aeOrbCanvas');
  const rect = canvas ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('aether.orbLibrary') || 'null'); } catch (error) { saved = null; }
  return {
    count: lib ? lib.list().length : 0,
    ids: lib ? lib.list().map((orb) => orb.id) : [],
    activeId: lib ? lib.getActiveId() : '',
    savedActive: saved && saved.activeId,
    stageOrbId: stage ? stage.dataset.orbId : '',
    canvas: { cssW: Math.round(rect.width), cssH: Math.round(rect.height) },
    settings: lib && orbId ? lib.getSettings(orbId) : null,
  };
}

function visiblePixels(image) {
  try {
    const size = image.getSize();
    const width = size.width;
    const height = size.height;
    const bitmap = image.toBitmap();
    const corners = [[2, 2], [width - 3, 2], [2, height - 3], [width - 3, height - 3]];
    let baseB = 0;
    let baseG = 0;
    let baseR = 0;
    for (const point of corners) {
      const index = (point[1] * width + point[0]) * 4;
      baseB += bitmap[index];
      baseG += bitmap[index + 1];
      baseR += bitmap[index + 2];
    }
    baseB /= corners.length;
    baseG /= corners.length;
    baseR /= corners.length;
    let count = 0;
    for (let index = 0; index < bitmap.length; index += 4) {
      const db = bitmap[index] - baseB;
      const dg = bitmap[index + 1] - baseG;
      const dr = bitmap[index + 2] - baseR;
      if (db * db + dg * dg + dr * dr > 900) count += 1;
    }
    return count;
  } catch (error) {
    return 0;
  }
}
