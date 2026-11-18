'use strict';

// Решение владельца 18.11.2026: в выпуске одна оболочка — Aether.
// Классический экран остаётся только скрытой отладочной опцией (NOX_UI=legacy),
// переключателя в интерфейсе нет, настройки на выбор оболочки не влияют.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chooseShell } = require('../src/config/shell');

test('обычный запуск всегда открывает Aether', () => {
  assert.equal(chooseShell({}), 'aether');
  assert.equal(chooseShell({ NOX_UI: 'aether' }), 'aether');
  assert.equal(chooseShell(undefined), 'aether');
});

test('прежний вид — только скрытая отладка через NOX_UI=legacy', () => {
  assert.equal(chooseShell({ NOX_UI: 'legacy' }), 'legacy');
});

test('старые настройки оболочки не возвращают классический экран', () => {
  assert.equal(chooseShell({}, { uiShell: 'legacy' }), 'aether');
  assert.equal(chooseShell({ uiShell: 'legacy' }), 'aether');
});
