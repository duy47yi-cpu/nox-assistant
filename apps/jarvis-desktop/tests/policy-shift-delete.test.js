'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { decide, hardDeny, isShiftDelete } = require('../src/policy/modes');

const WS = path.resolve('jarvis-workspace');
const KEYS = (keys) => ({ name: 'ui_keys', risk: 'T1', args: { keys }, workspace: WS });

// Shift+Delete удаляет мимо корзины: в «Полном доступе» только по прямой просьбе удалить в этом ходе.
describe('Shift+Delete через ui_keys', () => {
  test('распознаёт клавишу среди других и без учёта регистра', () => {
    assert.equal(isShiftDelete({ name: 'ui_keys', args: { keys: 'shift+delete' } }), true);
    assert.equal(isShiftDelete({ name: 'ui_keys', args: { keys: 'tab Shift+Delete enter' } }), true);
    assert.equal(isShiftDelete({ name: 'ui_keys', args: { keys: 'ctrl+k' } }), false);
    assert.equal(isShiftDelete({ name: 'shell_run', args: { keys: 'shift+delete' } }), false);
  });

  test('в «Полном доступе» без просьбы владельца спрашивает', () => {
    assert.equal(decide({ mode: 'full', ...KEYS('shift+delete'), ownerText: 'нажми клавиши' }), 'ask');
    assert.equal(decide({ mode: 'full', ...KEYS('shift+delete') }), 'ask');
  });

  test('в «Полном доступе» по прямой просьбе удалить в этом ходе разрешает', () => {
    assert.equal(decide({ mode: 'full', ...KEYS('shift+delete'), ownerText: 'удали выбранное' }), 'allow');
  });

  test('выбранная владельцем команда разрешает', () => {
    assert.equal(decide({ mode: 'full', ...KEYS('shift+delete'), ownerCommand: true }), 'allow');
  });

  test('обычные клавиши в «Полном доступе» не затронуты', () => {
    assert.equal(decide({ mode: 'full', ...KEYS('ctrl+k') }), 'allow');
  });

  test('вне «Полного доступа» всегда спрашивает', () => {
    assert.equal(decide({ mode: 'ask', ...KEYS('shift+delete'), ownerText: 'удали выбранное' }), 'ask');
    assert.equal(decide({ mode: 'auto', ...KEYS('shift+delete'), ownerText: 'удали выбранное' }), 'ask');
  });

  test('в фоне запрещён (hardDeny)', () => {
    assert.ok(hardDeny({ name: 'ui_keys', args: { keys: 'shift+delete' } }));
    assert.equal(hardDeny({ name: 'ui_keys', args: { keys: 'ctrl+k' } }), null);
  });
});
