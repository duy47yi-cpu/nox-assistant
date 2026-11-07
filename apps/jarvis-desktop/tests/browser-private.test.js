'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const modes = require('../src/policy/modes');

test('почта и банк в браузере: спрашиваем, в обычном сайте нет', () => {
  const ask = (url) => modes.decide({ mode: 'auto', name: 'browser_open', risk: 'T0', args: { url } });
  assert.equal(ask('https://mail.google.com/mail/u/0'), 'ask');
  assert.equal(ask('https://online.sberbank.ru/'), 'ask');
  assert.equal(ask('https://web.telegram.org/'), 'ask');
  assert.equal(ask('https://www.storia.ro/ro/rezultate'), 'allow');
});

test('чтение уже открытой почты тоже спрашиваем', () => {
  modes.setBrowserHost(() => 'mail.google.com');
  assert.equal(modes.decide({ mode: 'auto', name: 'browser_read', risk: 'T0', args: {} }), 'ask');
  modes.setBrowserHost(() => 'example.com');
  assert.equal(modes.decide({ mode: 'auto', name: 'browser_read', risk: 'T0', args: {} }), 'allow');
  modes.setBrowserHost(() => '');
});
