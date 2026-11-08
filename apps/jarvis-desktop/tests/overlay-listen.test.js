'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('«Джарвис на рабочем столе»: мини-окно открывается и закрывается из настроек и при старте', () => {
  const main = read('main.js');
  assert.match(main, /function openMini\(\)/);
  assert.match(main, /function closeMini\(\)/);
  assert.match(main, /renderer', 'mini\.html'/);
  assert.match(main, /key === 'desktopOverlay'\) \{ if \(value\) openMini\(\); else closeMini\(\); \}/);
  assert.match(main, /readSettings\(\)\.desktopOverlay === true\) openMini\(\)/);
  assert.match(main, /ipcMain\.handle\('mini:close'/);
  assert.match(main, /ipcMain\.handle\('window:showMain'/);
  // Мини-окно не должно получать чужие каналы: только своё отправляющее окно.
  assert.match(main, /function fromMini\(event\)/);
  assert.match(read('preload.js'), /showMain: \(\) => ipcRenderer\.invoke\('window:showMain'\)/);
  assert.match(read('preload.js'), /closeMini: \(\) => ipcRenderer\.invoke\('mini:close'\)/);
  assert.match(read('renderer', 'mini.html'), /id="miniHide"/);
  assert.match(read('renderer', 'mini.js'), /miniHide.*closeMini/);
  assert.match(read('renderer', 'index.html'), /data-setting="desktopOverlay"/);
});

test('«Слушать «Джарвис» всегда»: фоновое распознавание без кнопки, в поле ввода только обращения', () => {
  const main = read('main.js');
  assert.match(main, /function startDictation\(\{ uiRequested \}\)/);
  assert.match(main, /function stopDictation\(\)/);
  assert.match(main, /if \(!uiRequested && ev\.type === 'text'\) return;/);
  assert.match(main, /key === 'alwaysListen'\) \{ if \(value\) startDictation\(\{ uiRequested: false \}\); else stopDictation\(\); \}/);
  assert.match(main, /readSettings\(\)\.alwaysListen === true\) startDictation\(\{ uiRequested: false \}\)/);
  assert.match(main, /'desktopOverlay', 'alwaysListen'\]/);
  assert.match(read('renderer', 'index.html'), /data-setting="alwaysListen"/);
  assert.match(read('renderer', 'app.js'), /'alwaysListen'/);
});

test('шар реагирует на голос: без настоящего уровня — оценка по времени, пока отвечает или слушает', () => {
  const orb = read('renderer', 'orb.js');
  assert.match(orb, /this\.state === 'speaking' \|\| this\.state === 'listening'\)\) this\.voiceTarget = /);
});

test('сегодня показывает напоминания на сегодня', () => {
  const app = read('renderer', 'app.js');
  assert.match(app, /Напомнить: /);
  assert.match(app, /if \(has\('remindersList'\)\) loadReminders\(\)/);
});
