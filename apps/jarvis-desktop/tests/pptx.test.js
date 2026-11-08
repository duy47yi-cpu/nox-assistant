'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readZip } = require('../src/tools/zip');
const { pptxBuffer, pptxCheck, normalizeSlides } = require('../src/tools/pptx');

test('презентация собирается без установки программ: обложка и слайды', () => {
  const buf = pptxBuffer({ title: 'Python', slides: [{ title: 'Что такое Python', bullets: ['Язык', 'Простой'] }, { title: 'Переменные', bullets: [] }] });
  const files = readZip(buf);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide3.xml']) {
    assert.ok(files.has(name), name);
  }
  assert.equal(files.has('ppt/slides/slide4.xml'), false, 'обложка и два слайда');
  assert.equal(pptxCheck(buf, 3).ok, true);
  assert.equal(pptxCheck(buf, 2).ok, false);
});

test('текст экранируется, пустые пункты отбрасываются, лишние обрезаются', () => {
  const buf = pptxBuffer({ slides: [{ title: 'A < B & "C"', bullets: ['x', '', '  ', 'y'] }] });
  const xml = readZip(buf).get('ppt/slides/slide1.xml').toString('utf8');
  assert.match(xml, /A &lt; B &amp; &quot;C&quot;/);
  assert.equal((xml.match(/<a:buChar/g) || []).length, 2);
  const many = normalizeSlides([{ title: 't', bullets: Array.from({ length: 30 }, (_, i) => `п${i}`) }]);
  assert.equal(many[0].bullets.length, 12);
});

test('без содержимого презентацию не собираем', () => {
  assert.throws(() => pptxBuffer({ slides: [] }), /нет слайдов/);
  assert.deepEqual(normalizeSlides([{ title: '', bullets: [] }, null]), []);
});

test('проверка не принимает не-архив', () => {
  assert.equal(pptxCheck(Buffer.from('не презентация'), 1).ok, false);
});
