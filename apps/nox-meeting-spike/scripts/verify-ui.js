'use strict';

/**
 * Живая проверка изолированного интерфейса C7 в настоящем окне Chromium/Electron.
 * Запуск: node scripts/verify-ui.js [--out-dir <папка для снимков>]
 * Микрофон и медиа-разрешения принудительно заблокированы на уровне сессии браузера.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

let electron = null;
try {
  electron = require('electron');
} catch {
  electron = null;
}

if (!electron || typeof electron !== 'object' || !electron.app) {
  const electronBin = path.resolve(
    __dirname,
    '..',
    '..',
    'jarvis-desktop',
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  );
  if (!fs.existsSync(electronBin)) {
    console.error('Electron binary not found at:', electronBin);
    process.exit(1);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const res = spawnSync(electronBin, [__filename, ...process.argv.slice(2)], {
    env,
    stdio: 'inherit',
  });
  process.exit(res.status === null ? 1 : res.status);
}

const { app, BrowserWindow, session } = electron;
const { createSpikeServer } = require('../src/server/spike-server');

const outDir = getArg('out-dir', null);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-c7-ui-qa-'));
const userDataDir = path.join(tempRoot, 'profile');
const storageDir = path.join(tempRoot, 'spike-sessions');
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(storageDir, { recursive: true });

app.setPath('userData', userDataDir);
app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

async function waitFor(win, predicateJs, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await win.webContents.executeJavaScript(predicateJs);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`Timeout waiting for UI condition: ${predicateJs}`);
}

async function capture(win, fileName) {
  if (!outDir) return null;
  fs.mkdirSync(outDir, { recursive: true });
  await win.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
  );
  const img = await win.webContents.capturePage();
  const target = path.join(outDir, fileName);
  fs.writeFileSync(target, img.toPNG());
  return target;
}

async function run() {
  await app.whenReady();

  // Жёсткий запрет любых медиа-разрешений (микрофон, камера и т.д.)
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  const spike = createSpikeServer({ storageDir });
  const { url } = await spike.listen(0, '127.0.0.1');

  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: false,
    backgroundColor: '#14120e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (outDir) {
    win.showInactive();
  }
  win.webContents.setAudioMuted(true);

  const consoleErrors = [];
  win.webContents.on('console-message', (ev) => {
    if (ev && ev.level >= 3) consoleErrors.push(ev.message);
  });

  const checks = [];
  try {
    await win.loadURL(url);
    await waitFor(win, `document.getElementById('statusText')?.textContent === 'Не записывает'`);
    await capture(win, '01-idle.png');
    checks.push({ name: 'idle_state_not_recording', ok: true });

    // 1. Попытка старта без согласия
    await win.webContents.executeJavaScript(`document.getElementById('btnStart').click()`);
    await waitFor(
      win,
      `document.getElementById('alertBanner')?.textContent.includes('требуется явное согласие')`
    );
    await capture(win, '02-consent-denied.png');
    checks.push({ name: 'consent_refusal_banner', ok: true });

    // 2. Явное согласие + сценарий со сбоем и восстановлением
    await win.webContents.executeJavaScript(`
      document.getElementById('scenarioSelect').value = 'fault_recovery';
      document.getElementById('captureConsentCheck').checked = true;
      document.getElementById('storageConsentCheck').checked = true;
      document.getElementById('btnStart').click();
    `);
    await waitFor(
      win,
      `document.querySelectorAll('#finalsList .segment-card').length >= 1 && !document.getElementById('partialBox').classList.contains('partial-idle')`
    );
    await capture(win, '03-live-captions.png');
    checks.push({ name: 'live_stream_and_recovery', ok: true });

    // 3. Пауза и возобновление
    await win.webContents.executeJavaScript(`document.getElementById('btnPause').click()`);
    await waitFor(win, `document.getElementById('statusText')?.textContent === 'Пауза'`);
    checks.push({ name: 'pause_state_visible', ok: true });

    await win.webContents.executeJavaScript(`document.getElementById('btnResume').click()`);
    await waitFor(
      win,
      `['Идёт синтетический поток', 'Завершено'].includes(document.getElementById('statusText')?.textContent)`
    );

    // 4. Завершение и просмотр конспекта + вкладок
    await win.webContents.executeJavaScript(`
      if (!document.getElementById('btnFinish').disabled) document.getElementById('btnFinish').click();
    `);
    await waitFor(
      win,
      `document.getElementById('statusText')?.textContent === 'Завершено' && document.getElementById('summaryContent')?.textContent.includes('Темы')`
    );
    await capture(win, '04-summary.png');
    checks.push({ name: 'summary_view_ready', ok: true });

    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="metrics"]').click()`);
    await waitFor(
      win,
      `document.getElementById('metricsContent')?.textContent.includes('Ingest + очередь')`
    );
    await capture(win, '05-metrics.png');
    checks.push({ name: 'latency_metrics_separated', ok: true });

    // 5. Удаление тестовой сессии
    await win.webContents.executeJavaScript(`document.getElementById('btnDelete').click()`);
    await waitFor(
      win,
      `document.getElementById('statusText')?.textContent === 'Не записывает' && document.querySelectorAll('#finalsList .segment-card').length === 0`
    );
    await capture(win, '06-deleted-reset.png');
    checks.push({ name: 'delete_session_resets_state', ok: true });

    if (consoleErrors.length > 0) {
      throw new Error(`Browser console errors: ${consoleErrors.join('; ')}`);
    }

    console.log('UI_QA_PASS', JSON.stringify({ checks, outDir }));
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await spike.close();
    try {
      fs.rmSync(storageDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Профиль Electron может удерживать блокировку до завершения процесса
    }
    app.quit();
  }
}

run().catch((err) => {
  console.error('UI_QA_FAIL:', err);
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
  app.exit(1);
});
