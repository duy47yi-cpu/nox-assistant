'use strict';

// Electron: notification-voice-qa.js D:/nox-m4-qa save|restart
// Синтез — локальный системный голос Windows; проигрывание — штатный код Nox.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, globalShortcut } = require('electron');
const { WatchNotifier } = require('../src/notify/watch');
const { NotificationSpeech } = require('../src/voice/delivery');
const { SpeechClient } = require('../src/voice/tts');

const root = process.argv[2];
const stage = process.argv[3];
assert.match(root, /^D:[/\\]/i);
assert.ok(['save', 'restart'].includes(stage));
assert.ok(!fs.existsSync(root) || fs.existsSync(path.join(root, 'm4-fixture')), 'Нужна новая папка или папка этой проверки');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'm4-fixture'), '');
for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
app.setPath('userData', path.join(root, 'profile'));
require('../src/config/paths').projectRoot = () => root;
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};

let watch;
let clock = new Date(2026, 10, 12, 1);
let drain;
const played = [];
const attempted = [];
let parallel = 0;
let maxParallel = 0;
WatchNotifier.prototype.start = function () {
  watch = this;
  this.sources = { inbox: () => [], tasks: () => [], missions: () => [], apps: () => [], cost: () => null };
};
const enqueue = NotificationSpeech.prototype.enqueue;
NotificationSpeech.prototype.enqueue = function (items) {
  this.now = () => clock;
  drain = enqueue.call(this, items);
  return drain;
};
const wav = path.join(root, 'fixture.wav');
SpeechClient.prototype.isInstalled = () => true;
SpeechClient.prototype.synthesize = async (text) => {
  attempted.push(text);
  return wav;
};
const play = SpeechClient.prototype.play;
SpeechClient.prototype.play = async function (file, opts) {
  maxParallel = Math.max(maxParallel, ++parallel);
  try {
    await play.call(this, file, opts);
    played.push(opts.volume);
  } finally {
    parallel -= 1;
  }
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => finish(new Error('таймаут проверки')), 50000);
function finish(err) {
  clearTimeout(timeout);
  if (err) {
    console.error(err);
    app.exit(1);
    return;
  }
  console.log(`M4 ${stage} OK`, { played, maxParallel });
  app.quit();
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (!win.webContents.getURL().endsWith('/renderer/index.html')) return;
    try {
      const js = (code) => win.webContents.executeJavaScript(code);
      await pause(900);
      await js(`window.JarvisNox.show('settings'); document.querySelector('[data-set-chip="voice"]').click()`);
      const state = async () => js('window.jarvis.getSettings().then((s) => s.notificationVoice)');
      const wanted = {
        enabled: true, categories: ['reminders', 'tasks'], volume: 0.35,
        quietEnabled: true, quietFrom: '22:30', quietTo: '07:15', importantAtNight: true,
      };
      if (stage === 'save') {
        assert.equal((await state()).enabled, false);
        await js(`(() => {
          const cfg = ${JSON.stringify(wanted)};
          for (const el of document.querySelectorAll('[data-notice-option], [data-notice-category]')) {
            const key = el.dataset.noticeOption;
            if (el.type === 'checkbox') el.checked = key ? cfg[key] : cfg.categories.includes(el.dataset.noticeCategory);
            else el.value = key === 'volume' ? cfg.volume * 100 : cfg[key];
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          document.querySelector('#saveNotificationVoice').click();
        })()`);
        for (let i = 0; i < 30 && !(await state()).enabled; i += 1) await pause(100);
      }
      assert.deepEqual(await state(), wanted);
      assert.deepEqual(await js(`(() => {
        const checked = (key) => document.querySelector('[data-notice-option="' + key + '"]').checked;
        const value = (key) => document.querySelector('[data-notice-option="' + key + '"]').value;
        return [checked('enabled'), checked('importantAtNight'), value('volume'), value('quietFrom'), value('quietTo'),
          ...[...document.querySelectorAll('[data-notice-category]:checked')].map((el) => el.dataset.noticeCategory)];
      })()`), [true, true, '35', '22:30', '07:15', 'reminders', 'tasks']);
      await js("document.querySelector('#notificationVoiceSettings').scrollIntoView({block:'start'})");
      await pause(300);
      assert.equal(win.isVisible(), true);
      fs.writeFileSync(path.join(root, `${stage}.png`), (await win.webContents.capturePage()).toPNG());
      await js("document.querySelector('#saveNotificationVoice').scrollIntoView({block:'end'})");
      await pause(300);
      fs.writeFileSync(path.join(root, `${stage}-quiet-hours.png`), (await win.webContents.capturePage()).toPNG());

      if (stage === 'restart') {
        const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
          'Add-Type -AssemblyName System.Speech',
          '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
          '$s.SetOutputToWaveFile($env:NOX_WAV)',
          '$s.Speak("Nox notification test.")',
          '$s.Dispose()',
        ].join('; ')], { env: { ...process.env, NOX_WAV: wav }, timeout: 10000 });
        assert.equal(out.status, 0, out.stderr?.toString());
        assert.ok(fs.statSync(wav).size > 1000);
        const reminder = (key) => watch.add({ kind: 'reminder', key: `reminder:${key}`, detail: 'Reminder', channels: [] });
        const task = (key) => watch.add({ kind: 'task-failed', key, detail: 'Task', channels: [] });
        const tick = async () => { await watch.tick(clock); await drain; };
        await tick();
        reminder('night');
        task('night-task');
        await tick();
        assert.equal(attempted.length, 1, 'ночью звучит только важное');
        assert.deepEqual(played, [0.35]);
        clock = new Date(2026, 10, 12, 7, 15);
        reminder('morning');
        task('morning-task');
        watch.add({ kind: 'inbox', key: 'file', detail: 'file.txt', channels: [] });
        await tick();
        assert.equal(attempted.length, 3, 'утром звучат только две включённые категории');
        assert.deepEqual(played, [0.35, 0.35, 0.35]);
        assert.equal(maxParallel, 1);
      }
      finish();
    } catch (err) { finish(err); }
  });
});

require('../main');
