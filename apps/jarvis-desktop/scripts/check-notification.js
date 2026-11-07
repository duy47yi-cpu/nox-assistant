'use strict';

// Ручная проверка нативного уведомления: запускается отдельно через Electron,
// использует временный профиль и никогда не читает данные владельца.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, Notification } = require('electron');
const { showNotification } = require('../src/schedule/scheduler');

const tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-notification-check-'));
app.setPath('userData', tempProfile);
app.setAppUserModelId('ai.nox.assistant');
function report(result) {
  const value = JSON.stringify({ ...result, tempProfile });
  fs.writeFileSync(path.join(tempProfile, 'result.json'), value, { flag: 'wx' });
  console.log(value);
}

app.whenReady().then(async () => {
  const supported = Notification.isSupported();
  if (!supported) {
    report({ supported, status: 'unsupported' });
    app.exit(1);
    return;
  }
  const note = new Notification({ title: 'Nox: проверка', body: 'Тестовое напоминание' });
  try {
    await showNotification(note);
    report({ supported, status: 'show' });
    app.quit();
  } catch (err) {
    report({ supported, status: 'error', error: err.message });
    app.exit(1);
  }
}).catch((err) => {
  report({ status: 'startup-error', error: err.message });
  app.exit(1);
});
