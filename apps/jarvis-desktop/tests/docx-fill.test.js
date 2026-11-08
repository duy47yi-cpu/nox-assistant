'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readZip, writeZip } = require('../src/tools/zip');
const { fillDocx, placeholdersIn } = require('../src/tools/docx-fill');

const DOC = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
  + '<w:p><w:r><w:t>Диплом</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t xml:space="preserve">Награждается </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>{{ФИО}}</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>Дата: {{Дата}} · {{ Курс }}</w:t></w:r></w:p>'
  + '</w:body></w:document>';

function template() {
  return writeZip([{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'word/document.xml', data: DOC }]);
}

test('ключи шаблона находятся в тексте, в том числе с пробелами внутри скобок', () => {
  assert.deepEqual(placeholdersIn(template()), ['ФИО', 'Дата', 'Курс']);
});

test('значения подставляются и экранируются, незаполненные ключи остаются и названы', () => {
  const r = fillDocx(template(), { ФИО: 'Иванов & Co <тест>', Дата: '08.11.2026' });
  assert.deepEqual(r.filled.sort(), ['Дата', 'ФИО']);
  assert.deepEqual(r.missing, ['Курс']);
  const xml = readZip(r.buffer).get('word/document.xml').toString('utf8');
  assert.match(xml, /Иванов &amp; Co &lt;тест&gt;/);
  assert.match(xml, /08\.11\.2026/);
  assert.match(xml, /\{\{ Курс \}\}/);
  assert.doesNotMatch(xml, /\{\{ФИО\}\}/);
  // Остальная часть архива не меняется.
  assert.equal(readZip(r.buffer).get('[Content_Types].xml').toString('utf8'), '<x/>');
});

test('не Word-документ отклоняется', () => {
  assert.throws(() => fillDocx(writeZip([{ name: 'a.txt', data: 'x' }]), {}), /не документ Word/);
});
