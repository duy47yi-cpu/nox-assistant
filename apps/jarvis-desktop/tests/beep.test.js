'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { playBeep, makeWav } = require('../src/voice/beep');

const fake = (calls) => (cmd, args) => { calls.push({ cmd, args }); return { on() {}, unref() {} }; };

test('playBeep: вне Windows, при громкости 0 и в тихом режиме ничего не запускает', () => {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-beep-t-'));
  assert.strictEqual(playBeep({ platform: 'linux', run: fake(calls), dir }), false);
  assert.strictEqual(playBeep({ platform: 'win32', volume: 0, run: fake(calls), dir }), false);
  assert.strictEqual(playBeep({ platform: 'win32', quiet: true, run: fake(calls), dir }), false);
  assert.strictEqual(calls.length, 0);
});

test('playBeep: на Windows пишет WAV и запускает один процесс; сбой запуска не падает', () => {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-beep-t-'));
  assert.strictEqual(playBeep({ platform: 'win32', volume: 0.5, run: fake(calls), dir }), true);
  assert.strictEqual(calls.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'nox-beep-50.wav')));
  assert.strictEqual(playBeep({ platform: 'win32', run() { throw new Error('x'); }, dir }), false);
});

test('makeWav: корректный заголовок, около 0,18 с', () => {
  const w = makeWav(1);
  assert.strictEqual(w.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(w.length, 44 + Math.floor(22050 * 0.18) * 2);
});
