'use strict';

// Доставка ответа (идея JARVIS-OS): видимый успех — текстом без голоса, ошибка — всегда голосом,
// обычный ответ — как раньше. Флаг «тише» по умолчанию выключен: поведение сохраняется.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { classifyDelivery, selfEvident } = require('../src/voice/delivery');

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
