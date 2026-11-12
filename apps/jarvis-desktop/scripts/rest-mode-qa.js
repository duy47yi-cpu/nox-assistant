'use strict';

// Electron: rest-mode-qa.js D:/nox-rest-qa save|restart
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, globalShortcut, Notification, powerMonitor } = require('electron');
const { WatchNotifier } = require('../src/notify/watch');
const { SpeechClient } = require('../src/voice/tts');
const { NotificationSpeech } = require('../src/voice/delivery');

const root = process.argv[2];
const stage = process.argv[3];
assert.match(root, /^D:[/\\]/i);
assert.ok(['save', 'restart'].includes(stage));
assert.ok(!fs.existsSync(root) || fs.existsSync(path.join(root, 'm6-fixture')), 'Нужна папка этой проверки');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'm6-fixture'), '');
for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
app.setPath('userData', path.join(root, 'profile'));
require('../src/config/paths').projectRoot = () => root;
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};

let watch;
let clock = new Date(2026, 10, 12, 10);
let idle = 0;
let drain;
const notices = [];
const spoken = [];
WatchNotifier.prototype.start = function () {
  watch = this;
  this.sources = { inbox: () => [], tasks: () => [], missions: () => [], apps: () => [], cost: () => null };
};
powerMonitor.getSystemIdleTime = () => idle;
const show = Notification.prototype.show;
Notification.prototype.show = function () {
  if (this.title === 'Режим отдыха') notices.push(this);
  return show.call(this);
};
SpeechClient.prototype.isInstalled = () => true;
SpeechClient.prototype.speak = async (text, opts) => { spoken.push({ text, volume: opts.volume }); };
const enqueue = NotificationSpeech.prototype.enqueue;
NotificationSpeech.prototype.enqueue = function (items) {
  this.now = () => clock;
  drain = enqueue.call(this, items);
  return drain;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timer = setTimeout(() => finish(new Error('таймаут проверки')), 35000);
function finish(error) {
  clearTimeout(timer);
  if (error) {
    console.error(error);
    app.exit(1);
  } else {
    console.log(`M6 ${stage} OK`, { notifications: notices.length, spoken: spoken.length });
    app.quit();
  }
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (!win.webContents.getURL().endsWith('/renderer/index.html')) return;
    try {
      const js = (code) => win.webContents.executeJavaScript(code);
      const settings = () => js('window.jarvis.getSettings()');
      const set = (key, value) => js(`window.jarvis.setSetting(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
      const toggle = () => js(`document.querySelector('[data-setting="restEnabled"]').click()`);
      const expectSettings = async (enabled, minutes) => {
        for (let i = 0; i < 20; i += 1) {
          const state = await settings();
          if (state.restEnabled === enabled && state.restInterval === minutes) return;
          await wait(50);
        }
        assert.fail(`Настройки не сохранились: ${enabled}, ${minutes}`);
      };
      await wait(800);
      await js("window.JarvisNox.show('settings')");
      if (stage === 'save') {
        await expectSettings(false, 50);
        await toggle();
        await js(`(() => {
          const input = document.querySelector('#restInterval');
          input.value = '5';
          input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await expectSettings(true, 5);
        assert.equal((await set('restInterval', 4)).ok, false);
        assert.equal((await set('notificationVoice', { ...(await settings()).notificationVoice, enabled: true, categories: ['breaks'], volume: 0.42 })).ok, true);
      } else {
        await expectSettings(true, 5);
        assert.deepEqual(await js(`[document.querySelector('[data-setting="restEnabled"]').checked, document.querySelector('#restInterval').value]`), [true, '5']);
        for (const [width, height] of [[1200, 720], [864, 520]]) {
          win.setContentSize(width, height);
          await wait(400);
          await js("document.querySelector('#restSettings').scrollIntoView({ block: 'start' })");
          await wait(350);
          const image = await win.webContents.capturePage();
          assert.deepEqual(win.getContentSize(), [width, height]);
          assert.ok(win.isVisible());
          assert.ok(await js(`(() => {
            const r = document.querySelector('#restInterval').getBoundingClientRect();
            return r.width > 0 && r.top >= 0 && r.bottom < innerHeight && r.right <= innerWidth;
          })()`));
          fs.writeFileSync(path.join(root, `rest-${width}x${height}.png`), image.toPNG());
        }

        const ticks = async (from, to, hour = 10) => {
          for (let minute = from; minute <= to; minute += 1) {
            clock = new Date(2026, 10, 12, hour, minute);
            await watch.tick(clock);
            await drain;
          }
        };
        await ticks(0, 4);
        powerMonitor.emit('suspend');
        await ticks(5, 5);
        powerMonitor.emit('resume');
        await ticks(30, 34);
        assert.equal(notices.length, 0);
        await ticks(35, 35);
        assert.equal(notices.length, 1);
        assert.equal(notices[0].silent, true);
        assert.equal(spoken[0].volume, 0.42);
        notices[0].close(); // закрытие не запускает новое напоминание и не переключает приложение
        await ticks(36, 38);
        idle = 180;
        await ticks(39, 39);
        idle = 0;
        await ticks(40, 44);
        assert.equal(notices.length, 1);
        await toggle();
        await expectSettings(false, 5);
        await ticks(45, 52);
        assert.equal(notices.length, 1);
        await toggle();
        await expectSettings(true, 5);
        await ticks(53, 60, 23);
        assert.equal(notices.length, 1, 'тихие часы подавляют плашку');
        assert.equal(spoken.length, 1, 'тихие часы подавляют голос');
      }
      finish();
    } catch (error) { finish(error); }
  });
});

require('../main');
