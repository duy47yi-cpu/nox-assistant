'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQuickHotkey, normalizeQuickHotkey } = require('../src/control/quick-hotkey');
test('сочетание с пробелом приводится к формату Electron', () => {
  assert.equal(normalizeQuickHotkey('ctrl+alt+space'), 'Control+Alt+Space');
  assert.throws(() => normalizeQuickHotkey('Ctrl+Alt+M'));
  assert.throws(() => normalizeQuickHotkey('Space'));
});
test('занятое сочетание не выключает прежнее', () => {
  const keys = new Set();
  const hotkey = createQuickHotkey({ register: (key) => key === 'Control+Alt+X' ? false : (keys.add(key), true), unregister: (key) => keys.delete(key), activate() {} });
  assert.equal(hotkey.set('Control+Alt+Space').ok, true);
  assert.equal(hotkey.set('Control+Alt+X').ok, false);
  assert.deepEqual([...keys], ['Control+Alt+Space']);
  assert.equal(hotkey.state().key, 'Control+Alt+Space');
});
test('ошибка регистрации не приводит к падению', () => {
  const hotkey = createQuickHotkey({ register() { throw new Error('failed'); }, unregister() {}, activate() {} });
  assert.equal(hotkey.set('Control+Alt+Space').ok, false);
  assert.equal(hotkey.state().registered, false);
});
test('успешная замена освобождает старую клавишу', () => {
  const keys = new Set();
  const hotkey = createQuickHotkey({ register: (key) => (keys.add(key), true), unregister: (key) => keys.delete(key), activate() {} });
  hotkey.set('Control+Alt+Space');
  hotkey.set('Control+Alt+X');
  assert.deepEqual([...keys], ['Control+Alt+X']);
});
