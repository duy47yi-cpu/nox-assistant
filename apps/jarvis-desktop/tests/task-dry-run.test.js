'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('сквозной тест поручения проходит с текущими критериями приёмки', () => {
  const script = path.join(__dirname, '..', 'scripts', 'task-dry-run.js');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Итог прогона: УСПЕХ/);
});
