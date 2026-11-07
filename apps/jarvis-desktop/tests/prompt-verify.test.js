'use strict';

// main.js нельзя загрузить без Electron, поэтому проверяем текст подсказки модели в исходнике.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const rule = source.split('\n').find((line) => line.includes('Ответ инструмента с ok:true'));

test('подсказка не велит верить ok:true без подтверждения', () => {
  assert.ok(rule, 'правило про ответ инструмента должно быть в подсказке');
  assert.match(rule, /verified:"confirmed"/);
  assert.match(rule, /«сделал, но не проверил»/);
  assert.doesNotMatch(rule, /это успех/);
  assert.doesNotMatch(rule, /Независимые вызовы делай одним шагом/);
});
