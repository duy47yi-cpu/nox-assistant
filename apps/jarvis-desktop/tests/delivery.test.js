'use strict';

// Доставка ответа (идея JARVIS-OS): видимый успех — текстом без голоса, ошибка — всегда голосом,
// обычный ответ — как раньше. Флаг «тише» по умолчанию выключен: поведение сохраняется.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { classifyDelivery, selfEvident } = require('../src/voice/delivery');
const { notificationVolume, readNotificationVoice, validNotificationVoice, NotificationSpeech } = require('../src/voice/delivery');

const at = (h, m = 0) => new Date(2026, 10, 12, h, m);
const settings = (patch = {}) => ({ notificationVoice: { ...readNotificationVoice(), enabled: true, ...patch } });
const ordinary = { category: 'reminders', text: 'Напоминание' };
const important = { category: 'tasks', important: true, text: 'Задача зависла' };

test('тихие часы через полночь; исключение не отменяет категорию, общий тихий режим или нулевую громкость', () => {
  assert.equal(notificationVolume(ordinary, {}, at(12)), null);
  for (const now of [at(23), at(0), at(7, 59)]) {
    assert.equal(notificationVolume(ordinary, settings(), now), null);
    assert.equal(notificationVolume(important, settings(), now), null);
    assert.equal(notificationVolume(important, settings({ importantAtNight: true, volume: 0.35 }), now), 0.35);
    assert.equal(notificationVolume(important, settings({ importantAtNight: true, categories: ['reminders'] }), now), null);
  }
  for (const now of [at(8), at(22, 59)]) assert.equal(notificationVolume(ordinary, settings(), now), 0.7);
  assert.equal(notificationVolume(ordinary, { ...settings(), quiet: true }, at(12)), null);
  assert.equal(notificationVolume(ordinary, settings({ volume: 0 }), at(12)), null);
  assert.equal(notificationVolume(ordinary, settings({ quietFrom: '10:30', quietTo: '12:00' }), at(11)), null);
  assert.equal(notificationVolume(ordinary, settings({ quietFrom: '10:30', quietTo: '12:00' }), at(12)), 0.7);
  assert.equal(notificationVolume(ordinary, settings({ quietFrom: '10:30', quietTo: '10:30' }), at(12)), null);
  assert.equal(notificationVolume(ordinary, settings({ quietEnabled: false }), at(0)), 0.7);
  assert.equal(validNotificationVoice(settings().notificationVoice), true);
  assert.equal(validNotificationVoice(settings({ quietFrom: '25:00' }).notificationVoice), false);
  assert.equal(validNotificationVoice(settings({ categories: ['unknown'] }).notificationVoice), false);
});

test('голос идёт по очереди; перед следующей фразой проверяются время и громкость', async () => {
  const calls = [];
  let cfg = settings();
  let now = at(22, 59);
  let release;
  const voice = new NotificationSpeech({
    settings: () => cfg, now: () => now,
    speak: (text, { volume }) => {
      calls.push([text, volume]);
      if (text === ordinary.text) return new Promise((resolve) => { release = resolve; });
    },
  });
  const done = voice.enqueue([ordinary, ordinary, important]);
  await Promise.resolve();
  assert.deepEqual(calls, [[ordinary.text, 0.7]]);
  now = at(23);
  cfg = settings({ volume: 0.4, importantAtNight: true });
  release();
  await done;
  assert.deepEqual(calls, [[ordinary.text, 0.7], [important.text, 0.4]]);
});

test('диктовка и чтение имеют приоритет; явная речь ждёт завершения отмены уведомления', async () => {
  let busy = true;
  let finish;
  let signal;
  let foreground = false;
  const voice = new NotificationSpeech({
    settings: () => settings(), now: () => at(12), isBusy: () => busy,
    speak: (_text, opts) => { signal = opts.signal; return new Promise((resolve) => { finish = resolve; }); },
  });
  await voice.enqueue([ordinary]);
  assert.equal(signal, undefined);
  busy = false;
  const done = voice.enqueue([ordinary, important]);
  await Promise.resolve();
  const explicit = voice.foreground(() => { foreground = true; });
  assert.equal(signal.aborted, true);
  assert.equal(foreground, false);
  finish();
  await Promise.all([done, explicit]);
  assert.equal(foreground, true);
});

test('без флага всё как раньше: ответ звучит целиком', () => {
  const out = classifyDelivery({ text: 'Открыл Блокнот.', tools: ['app_open'], failed: false, terse: false });
  assert.equal(out.mode, 'full');
});

test('ошибка слышна всегда, даже при включённом «тише»', () => {
  const out = classifyDelivery({ text: 'Не получилось открыть.', tools: ['app_open'], failed: true, terse: true });
  assert.equal(out.mode, 'full');
  assert.match(out.reason, /ошибка/i);
});

test('видимый успех при «тише»: текст в окне, без голоса', () => {
  const out = classifyDelivery({ text: 'Открыл Блокнот.', tools: ['app_open'], failed: false, terse: true });
  assert.equal(out.mode, 'brief');

  const clicked = classifyDelivery({ text: 'Нажал «Сохранить».', tools: ['ui_click'], failed: false, terse: true });
  assert.equal(clicked.mode, 'brief');

  const browser = classifyDelivery({ text: 'Открыл вкладку.', tools: ['browser_click'], failed: false, terse: true });
  assert.equal(browser.mode, 'brief');
});

test('ответ с пояснением или чтением звучит', () => {
  assert.equal(classifyDelivery({ text: 'Сейчас в Москве +3.', tools: ['weather_now'], failed: false, terse: true }).mode, 'full');
  assert.equal(classifyDelivery({ text: 'В файле три пункта.', tools: ['workspace_read'], failed: false, terse: true }).mode, 'full');
});

test('«тише» включено по умолчанию и выключается только явным false', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /terseReplies: s\.terseReplies !== false/, 'окно получает включённое по умолчанию');
  assert.match(main, /terse: readSettings\(\)\.terseReplies !== false/, 'ядро считает выключенным только явный false');
});

test('пустой ответ молчит; selfEvident знает видимые действия', () => {
  assert.equal(classifyDelivery({ text: '   ', tools: [], failed: false, terse: true }).mode, 'silent');
  assert.equal(selfEvident('app_open'), true);
  assert.equal(selfEvident('browser_type'), true);
  assert.equal(selfEvident('workspace_read'), false);
  assert.equal(selfEvident('weather_now'), false);
});
