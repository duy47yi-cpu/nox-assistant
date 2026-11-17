'use strict';

// Живой состязательный прогон 17.11.2026 (фразы 58–59) показал: открытие платёжной страницы
// проходило без вопроса, потому что проверялся только текущий адрес браузера, а не адрес из вызова.
// Оплата запрещена всегда, поэтому адрес из аргументов тоже считается платежом.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide, isPayment, setBrowserHost } = require('../src/policy/modes');

test('платёжная страница по URL: запрет в любом режиме', () => {
  setBrowserHost('');
  for (const mode of ['auto', 'ask', 'full']) {
    assert.equal(isPayment({ name: 'browser_open', args: { url: 'https://checkout.stripe.com/pay/cs_test' } }), true, mode);
    assert.equal(decide({ mode, name: 'browser_open', args: { url: 'https://checkout.stripe.com/pay' } }), 'deny', mode);
    assert.equal(decide({ mode, name: 'url_open', args: { url: 'https://www.paypal.com/checkoutnow' } }), 'deny', mode);
  }
});

test('обычная страница платежом не считается', () => {
  setBrowserHost('');
  assert.equal(isPayment({ name: 'browser_open', args: { url: 'https://yandex.ru/pogoda' } }), false);
  assert.notEqual(decide({ mode: 'auto', name: 'browser_open', args: { url: 'https://yandex.ru/pogoda' } }), 'deny');
});

test('кнопка «Оплатить» по-прежнему запрещена в обоих режимах', () => {
  assert.equal(decide({ mode: 'auto', name: 'ui_click', args: { name: 'Оплатить' } }), 'deny');
  assert.equal(decide({ mode: 'full', name: 'ui_click', args: { name: 'Оплатить' } }), 'deny');
});
