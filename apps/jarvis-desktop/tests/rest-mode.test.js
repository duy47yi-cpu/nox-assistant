'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WatchNotifier, readRestSettings } = require('../src/notify/watch');
const { notificationVolume } = require('../src/voice/delivery');

function fixture(start = new Date(2026, 10, 12, 10)) {
  const settings = { restEnabled: true, restInterval: 15 };
  const notices = [];
  const speech = [];
  let idle = 0;
  const create = () => new WatchNotifier({
    settings: () => settings, idleSeconds: () => idle,
    showBreak: (text) => notices.push(text),
    speak: (items) => speech.push(...items),
  });
  let watch = create();
  return {
    settings, notices, speech,
    tick: (m) => watch.tick(new Date(start.getTime() + m * 60000)),
    reset: (state, paused) => watch.setRestPaused(state, paused),
    idle: (seconds) => { idle = seconds; },
    restart: () => { watch = create(); },
  };
}

async function through(f, from, to) {
  for (let m = from; m <= to; m += 1) await f.tick(m);
}

test('перерыв предлагается после полного интервала, игнорирование не блокирует работу и не повторяет сообщение сразу', async () => {
  const f = fixture();
  await through(f, 0, 14);
  assert.equal(f.notices.length, 0);
  await f.tick(15);
  assert.equal(f.notices.length, 1);
  assert.equal(f.speech[0].category, 'breaks');
  assert.equal(f.speech[0].important, false);
  assert.equal(f.speech[0].isCurrent(), true);
  await through(f, 16, 29);
  assert.equal(f.notices.length, 1);
  await f.tick(30);
  assert.equal(f.notices.length, 2);
  assert.equal(f.speech[0].isCurrent(), false, 'устаревшее напоминание не прозвучит из очереди');
  f.reset('sleep', true);
  assert.equal(f.speech[1].isCurrent(), false, 'сон снимает уже поставленную в очередь озвучку');
});

test('отключение, смена интервала и перезапуск начинают новый отсчёт', async () => {
  const f = fixture();
  await through(f, 0, 14);
  f.settings.restEnabled = false;
  await through(f, 15, 32);
  assert.equal(f.notices.length, 0);
  f.settings.restEnabled = true;
  f.settings.restInterval = 10;
  await through(f, 33, 40);
  f.restart();
  assert.deepEqual(readRestSettings(JSON.parse(JSON.stringify(f.settings))), { restEnabled: true, restInterval: 10 });
  await through(f, 41, 50);
  assert.equal(f.notices.length, 0);
  await f.tick(51);
  assert.equal(f.notices.length, 1);
});

test('простой, блокировка и сон не дают догоняющих уведомлений', async () => {
  const f = fixture();
  await through(f, 0, 14);
  f.idle(180);
  await f.tick(15);
  f.idle(0);
  await through(f, 16, 29);
  f.reset('lock', true);
  f.reset('sleep', true);
  await f.tick(30);
  f.reset('sleep', false);
  await f.tick(120);
  f.reset('lock', false);
  await through(f, 121, 134);
  assert.equal(f.notices.length, 0);
  await f.tick(135); // пропущен сигнал сна, но виден скачок между проверками
  await f.tick(180);
  await through(f, 181, 194);
  assert.equal(f.notices.length, 0);
  await f.tick(195);
  assert.equal(f.notices.length, 1);
});

test('тихие часы подавляют напоминание целиком, а голос перерыва включается отдельно', async () => {
  const f = fixture(new Date(2026, 10, 12, 7, 40));
  f.settings.notificationVoice = { enabled: true, importantAtNight: true, categories: ['breaks'] };
  await through(f, 0, 34);
  assert.equal(f.notices.length, 0);
  await f.tick(35);
  assert.equal(f.notices.length, 1);
  assert.equal(notificationVolume(f.speech[0], f.settings, new Date(2026, 10, 12, 8, 15)), 0.7);
  assert.equal(notificationVolume(f.speech[0], { notificationVoice: { enabled: true } }, new Date(2026, 10, 12, 8, 15)), null);
});
