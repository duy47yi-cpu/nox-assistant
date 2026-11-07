'use strict';

// Отдельный процесс Electron с временными настройками и заглушкой модели.
// Пользовательские настройки, данные и подключённые аккаунты не используются.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, globalShortcut } = require('electron');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-startup-check-'));
fs.mkdirSync(path.join(root, 'profile'));
fs.mkdirSync(path.join(root, 'data'));
fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ voice: false, backgroundModelRuns: false }));
app.setPath('userData', path.join(root, 'profile'));
for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
require('../src/config/paths').projectRoot = () => root;
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

let done = false;
const timeout = setTimeout(() => finish({ ok: false, error: 'startup timeout' }), 25000);
function finish(result) {
  if (done) return;
  done = true;
  clearTimeout(timeout);
  console.log(`NOX_STARTUP_RESULT ${JSON.stringify(result)}`);
  app.exit(result.ok ? 0 : 1);
}
process.on('exit', () => {
  try { fs.rmSync(root, { recursive: true, force: true }); }
  catch { console.error(`NOX_STARTUP_TEMP_REMAINS ${root}`); }
});

app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const state = await win.webContents.executeJavaScript(`(async () => {
        if (!window.jarvis || typeof window.jarvis.getState !== 'function') return { bridge: false };
        const value = await window.jarvis.getState();
        return { bridge: true, state: !!value };
      })()`);
      finish({ ok: state.bridge === true && state.state === true, ...state });
    } catch (err) { finish({ ok: false, error: err.message }); }
  });
});

require('../main');
