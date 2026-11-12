'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STYLES, styleId, replyStyleNote, forSpeech } = require('../src/agent/reply-style');
const { parse, textOf } = require('../renderer/math.js');

const tex = String.raw;

test('оформление ответов: три стиля, неизвестный открывает простой, простой ничего не дописывает', () => {
  assert.deepEqual(Object.keys(STYLES), ['plain', 'rich', 'notes']);
  assert.equal(styleId('что-то'), 'plain');
  assert.equal(styleId('toString'), 'plain');
  assert.equal(replyStyleNote('plain'), '');
  assert.match(replyStyleNote('rich'), /LaTeX/);
  assert.match(replyStyleNote('notes'), /Итог/);
});

test('голос не читает разметку и формулы, суммы в долларах остаются', () => {
  assert.equal(forSpeech(tex`Масса **больше** в $\frac{a}{b}$ раз, цена $5 и $10.`), 'Масса больше в формула раз, цена $5 и $10.');
  assert.equal(forSpeech('$$\nx^2\n$$\n* оговорка'), 'формула \nоговорка');
});

test('формулы: дробь, индексы, степени, символы, неизвестная команда остаётся текстом', () => {
  const frac = parse(tex`\frac{M_\odot}{M_J} \approx 1048`);
  assert.equal(frac[0].t, 'frac');
  assert.deepEqual(frac[0].num, [{ t: 'text', v: 'M' }, { t: 'sub', body: [{ t: 'text', v: '⊙' }] }]);
  assert.deepEqual(frac[1], { t: 'text', v: ' ≈ 1048' });
  assert.deepEqual(parse('x^{10}'), [{ t: 'text', v: 'x' }, { t: 'sup', body: [{ t: 'text', v: '10' }] }]);
  assert.equal(textOf(parse(tex`8{,}58 \times 10^{30}\ \text{кг}`)), '8,58 × 1030 кг');
  assert.equal(textOf(parse(tex`\sqrt{2}\,\bar{\rho}`)), '2 ρ');
  assert.equal(textOf(parse(tex`\unknowncmd x`)), tex`\unknowncmd x`);
  assert.deepEqual(parse(''), []);
  assert.doesNotThrow(() => parse(tex`\frac{1}{`));
});
