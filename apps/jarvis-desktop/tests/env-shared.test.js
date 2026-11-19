'use strict';

// Переезд ПК <-> ноутбук: общий .env.shared даёт ключи, но личный .env и
// переменные процесса важнее — локальные настройки не перебиваются.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeConfig } = require('../src/config/env');

test('ключи берутся из .env.shared, если нет .env и переменной', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-env-'));
  fs.writeFileSync(path.join(dir, '.env.shared'), 'NOX_BRAIN_KEY=shared-key\nNOX_BRAIN_MODEL=shared-model\n');
  const cfg = makeConfig(dir);
  assert.equal(cfg('NOX_BRAIN_KEY'), 'shared-key');
  assert.equal(cfg('NOX_BRAIN_MODEL'), 'shared-model');
});

test('личный .env важнее общего файла', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-env-'));
  fs.writeFileSync(path.join(dir, '.env.shared'), 'NOX_BRAIN_KEY=shared-key\n');
  fs.writeFileSync(path.join(dir, '.env'), 'NOX_BRAIN_KEY=local-key\n');
  assert.equal(makeConfig(dir)('NOX_BRAIN_KEY'), 'local-key');
});

test('переменная процесса важнее обоих файлов', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-env-'));
  fs.writeFileSync(path.join(dir, '.env.shared'), 'NOX_BRAIN_KEY=shared-key\n');
  fs.writeFileSync(path.join(dir, '.env'), 'NOX_BRAIN_KEY=local-key\n');
  process.env.NOX_BRAIN_KEY = 'process-key';
  try { assert.equal(makeConfig(dir)('NOX_BRAIN_KEY'), 'process-key'); }
  finally { delete process.env.NOX_BRAIN_KEY; }
});
