'use strict';

// Документы и zip: DOCX, XLSX, CSV, PDF-запись. Всё во временной папке.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceIndex } = require('../src/rag/index');
const { readZip, writeZip } = require('../src/tools/zip');
const { documentTools, parseCsv } = require('../src/tools/documents');

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-docs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'ws');
}

function setup(t, opts) {
  const root = tempRoot(t);
  fs.mkdirSync(root, { recursive: true });
  const index = new WorkspaceIndex(root);
  const [read, write] = documentTools(index, opts);
  return { root, index, read, write };
}

test('zip: запись и чтение туда и обратно, имена в UTF-8, пустой файл', () => {
  const buf = writeZip([{ name: 'word/документ.xml', data: '<x>привет</x>' }, { name: 'пусто.txt', data: '' }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'сигнатура локального заголовка');
  const files = readZip(buf);
  assert.deepEqual([...files.keys()], ['word/документ.xml', 'пусто.txt']);
  assert.equal(files.get('word/документ.xml').toString('utf8'), '<x>привет</x>');
  assert.equal(files.get('пусто.txt').length, 0);
});

test('zip: распакованный размер сверх предела — ошибка, а не память', () => {
  const big = writeZip([{ name: 'bomb', data: Buffer.alloc(3 * 1024 * 1024) }]);
  assert.ok(big.length < 100 * 1024, 'сжатый архив маленький');
  assert.throws(() => readZip(big, { maxBytes: 1024 * 1024 }), /слишком большой/);
});

test('zip: не архив и повреждённый архив дают ошибку', () => {
  assert.throws(() => readZip(Buffer.from('это просто текст без оглавления')), /не zip-архив/);
  const good = writeZip([{ name: 'a.txt', data: 'данные данные данные' }]);
  const broken = Buffer.from(good);
  const cen = good.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  broken[cen + 16] ^= 0xff; // контрольная сумма в оглавлении не совпадёт с данными
  assert.throws(() => readZip(broken), /повреждён/);
});

test('docx: запись с кириллицей и спецсимволами читается обратно, verify подтверждает', async (t) => {
  const { root, read, write } = setup(t);
  const res = await write.run({ path: 'отчёт.docx', format: 'docx', title: 'Итоги & <план>', text: 'Привет, мир!\nСумма: 100 ₽ — "кавычки" & <>' });
  assert.equal(res.ok, true, res.summary);
  assert.equal(res.summary, 'записал');
  const back = await read.run({ path: 'отчёт.docx' });
  assert.equal(back.ok, true, back.summary);
  assert.equal(back.data.text, 'Итоги & <план>\nПривет, мир!\nСумма: 100 ₽ — "кавычки" & <>');
  const xml = readZip(fs.readFileSync(path.join(root, 'отчёт.docx'))).get('word/document.xml').toString('utf8');
  assert.match(xml, /&amp; &lt;план&gt;/, 'спецсимволы экранированы');
  assert.ok(xml.startsWith('<?xml'), 'есть объявление XML');
  const verdict = await write.verify({}, { ok: true, data: res.data });
  assert.equal(verdict.status, 'confirmed');
});

test('docx: читает абзацы, таблицы, табуляцию и перенос из чужого файла', async (t) => {
  const { root, read } = setup(t);
  const body = '<w:p><w:r><w:t>Первый</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">Ко</w:t><w:tab/><w:t>нец</w:t><w:br/><w:t>строка</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Имя</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Цена</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>Чай &amp; кофе</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>';
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
  fs.writeFileSync(path.join(root, 'чужой.docx'), writeZip([{ name: 'word/document.xml', data: xml }]));
  const res = await read.run({ path: 'чужой.docx' });
  assert.equal(res.ok, true, res.summary);
  assert.equal(res.data.text, 'Первый\nКо\tнец\nстрока\nИмя | Цена\nЧай & кофе | ');
});

test('xlsx: запись и чтение по листам, общие строки, числа, sheet выбирает лист', async (t) => {
  const { root, read, write } = setup(t);
  const res = await write.run({ path: 'таблица.xlsx', format: 'xlsx', title: 'Продажи', rows: [['Товар', 'Цена', 'Заметка'], ['Чай', 120.5, 'зелёный; «лучший» & <>']] });
  assert.equal(res.ok, true, res.summary);
  const all = await read.run({ path: 'таблица.xlsx' });
  assert.equal(all.ok, true, all.summary);
  assert.equal(all.data.text, '## Лист «Продажи»\nТовар | Цена | Заметка\nЧай | 120.5 | зелёный; «лучший» & <>');
  assert.equal((await write.verify({}, { ok: true, data: res.data })).status, 'confirmed');

  // Чужая книга: два листа, общие строки в sharedStrings, встроенная строка и логическое значение.
  const shared = '<sst><si><t>Лист Б</t></si><si><r><t>Раз</t></r><r><t>два</t></r></si></sst>';
  const wb = '<workbook><sheets><sheet name="Первый" sheetId="1" r:id="rId1"/><sheet name="Второй" sheetId="2" r:id="rId2"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>';
  const s1 = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>встроенная</t></is></c></row></sheetData></worksheet>';
  const s2 = '<worksheet><sheetData><row r="2"><c r="B2" t="b"><v>1</v></c><c r="A2" t="str"><v>формула</v></c></row></sheetData></worksheet>';
  fs.writeFileSync(path.join(root, 'чужая.xlsx'), writeZip([
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: shared },
    { name: 'xl/worksheets/sheet1.xml', data: s1 },
    { name: 'xl/worksheets/sheet2.xml', data: s2 },
  ]));
  const foreign = await read.run({ path: 'чужая.xlsx' });
  assert.equal(foreign.ok, true, foreign.summary);
  assert.equal(foreign.data.text, '## Лист «Первый»\nЛист Б |  | встроенная\n\n## Лист «Второй»\nформула | TRUE');
  const one = await read.run({ path: 'чужая.xlsx', sheet: 'Второй' });
  assert.equal(one.data.text, '## Лист «Второй»\nформула | TRUE');
  const byNumber = await read.run({ path: 'чужая.xlsx', sheet: '1' });
  assert.equal(byNumber.data.text, '## Лист «Первый»\nЛист Б |  | встроенная');
  const missing = await read.run({ path: 'чужая.xlsx', sheet: 'Нет' });
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /не найден; листы: Первый, Второй/);
});

test('csv: кавычки, запятая и точка с запятой, BOM, запись и чтение туда и обратно', async (t) => {
  const { root, read, write } = setup(t);
  assert.deepEqual(parseCsv('a,"b, c",d\r\n1,"он ""да""",3\n'), [['a', 'b, c', 'd'], ['1', 'он "да"', '3']]);
  assert.deepEqual(parseCsv('﻿имя;сумма\n"Анна;Пётр";2,5\n'), [['имя', 'сумма'], ['Анна;Пётр', '2,5']]);
  assert.deepEqual(parseCsv('x,"многострочный\nтекст"\n'), [['x', 'многострочный\nтекст']]);

  const res = await write.run({ path: 'список.csv', format: 'csv', rows: [['имя', 'сумма'], ['Иван "Грозный"', 1500], ['Анна;Пётр', '2,5']] });
  assert.equal(res.ok, true, res.summary);
  const raw = fs.readFileSync(path.join(root, 'список.csv'));
  assert.equal(raw[0], 0xef, 'BOM для Excel');
  const back = await read.run({ path: 'список.csv' });
  assert.equal(back.data.text, 'имя | сумма\nИван "Грозный" | 1500\nАнна;Пётр | 2,5');
});

test('чтение: обрезка больших документов с сообщением о размере', async (t) => {
  const { root, read } = setup(t);
  const rows = Array.from({ length: 6000 }, (_, i) => `строка ${i} с текстом`).join('\n');
  fs.writeFileSync(path.join(root, 'big.csv'), rows, 'utf8');
  const res = await read.run({ path: 'big.csv' });
  assert.equal(res.ok, true);
  assert.equal(res.data.truncated, true);
  assert.equal(res.data.text.length, 50000);
  assert.match(res.summary, /обрезан: первые 50000 из \d+ символов/);
});

test('чтение: битые и неподдерживаемые файлы — ошибка без падения', async (t) => {
  const { root, read } = setup(t);
  fs.writeFileSync(path.join(root, 'битый.docx'), 'не архив вообще');
  fs.writeFileSync(path.join(root, 'зашифр.xlsx'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  fs.writeFileSync(path.join(root, 'старый.doc'), 'x');
  for (const p of ['битый.docx', 'зашифр.xlsx']) {
    const res = await read.run({ path: p });
    assert.equal(res.ok, false, p);
    assert.match(res.summary, /не zip-архив|зашифрован|повреждён/, p);
  }
  assert.equal((await read.run({ path: 'старый.doc' })).ok, false);
  const pdf = await read.run({ path: 'любой.pdf' });
  assert.equal(pdf.summary, 'файл не найден');
  assert.equal((await read.run({ path: '../outside.docx' })).ok, false, 'вне папки — отказ');
});

test('запись: без overwrite существующий файл не трогается; с overwrite заменяется', async (t) => {
  const { root, write } = setup(t);
  await write.run({ path: 'a.csv', format: 'csv', rows: [['первый']] });
  const again = await write.run({ path: 'a.csv', format: 'csv', rows: [['второй']] });
  assert.equal(again.ok, false);
  assert.match(again.summary, /overwrite: true/);
  assert.match(fs.readFileSync(path.join(root, 'a.csv'), 'utf8'), /первый/);
  const over = await write.run({ path: 'a.csv', format: 'csv', rows: [['второй']] , overwrite: true });
  assert.equal(over.ok, false, 'вне reports перезапись не даёт и с overwrite');
  assert.equal(over.summary, 'перезаписывать можно только в reports');
  await write.run({ path: 'reports/a.csv', format: 'csv', rows: [['один']] });
  const inReports = await write.run({ path: 'reports/a.csv', format: 'csv', rows: [['два']], overwrite: true });
  assert.equal(inReports.ok, true, inReports.summary);
  assert.equal(inReports.summary, 'перезаписал');
});

test('запись: расширение должно совпадать с форматом; нет содержимого — отказ; имя с запрещёнными символами — отказ', async (t) => {
  const { write } = setup(t);
  assert.equal((await write.run({ path: 'a.txt', format: 'docx', text: 'x' })).ok, false);
  assert.equal((await write.run({ path: 'a.docx', format: 'docx' })).ok, false);
  assert.equal((await write.run({ path: 'a?.docx', format: 'docx', text: 'x' })).ok, false);
  assert.equal((await write.run({ path: 'rag/a.csv', format: 'csv', rows: [['x']] })).ok, false, 'rag закрыт');
  assert.equal((await write.run({ path: '.скрытый.csv', format: 'csv', rows: [['x']] })).ok, false, 'точка закрыта');
});

test('pdf: без движка печати честный отказ; с ним получает экранированный html и файл проверяется по %PDF', async (t) => {
  const none = setup(t);
  const refused = await none.write.run({ path: 'a.pdf', format: 'pdf', text: 'x' });
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /нет движка печати/);

  let seen = '';
  const withPdf = setup(t, { renderPdf: async (html) => { seen = html; return Buffer.from('%PDF-1.4\n%%EOF'); } });
  const res = await withPdf.write.run({ path: 'отчёт.pdf', format: 'pdf', title: 'Заголовок <b>', text: 'Текст & <script>alert(1)</script>' });
  assert.equal(res.ok, true, res.summary);
  assert.match(seen, /<h1>Заголовок &lt;b&gt;<\/h1>/);
  assert.match(seen, /Текст &amp; &lt;script&gt;/);
  assert.doesNotMatch(seen, /<script>/);
  assert.equal((await withPdf.write.verify({}, { ok: true, data: res.data })).status, 'confirmed');
});

// Настоящий маленький PDF с текстом: таблицу смещений pdf.js восстанавливает сам.
const tinyPdf = (body) => Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ' + body.length + '>>stream\n' + body + '\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

test('PDF: текст читается, скан и битый файл дают понятный отказ', async (t) => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-pdf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { WorkspaceIndex } = require('../src/rag/index');
  const read = documentTools(new WorkspaceIndex(dir)).find((x) => x.name === 'document_read');
  fs.writeFileSync(path.join(dir, 'a.pdf'), tinyPdf('BT /F1 18 Tf 20 100 Td (Hello Nox) Tj ET'));
  const ok = await read.run({ path: 'a.pdf' });
  assert.equal(ok.ok, true, ok.summary);
  assert.match(ok.data.text, /Hello Nox/);
  fs.writeFileSync(path.join(dir, 'scan.pdf'), tinyPdf('0 0 m 10 10 l S'));
  assert.match((await read.run({ path: 'scan.pdf' })).summary, /скан/);
  fs.writeFileSync(path.join(dir, 'bad.pdf'), 'это не pdf');
  const bad = await read.run({ path: 'bad.pdf' });
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /повреждён/);
});
