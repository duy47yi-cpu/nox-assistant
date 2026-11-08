'use strict';

// Целостность markdown при нарезке (идея Chonkie): блок кода и таблица не рвутся между кусками,
// маркеры ``` не остаются «половинками», а обычный текст режется как раньше.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceIndex } = require('../src/rag/index');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-md-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function chunksOf(root) {
  const index = new WorkspaceIndex(root);
  index.build();
  return index.load().chunks;
}
const size = (text) => Array.from(text).length;

test('длинный блок кода не рвётся половинками маркеров', (t) => {
  const root = tempDir(t);
  const code = ['```js', ...Array.from({ length: 60 }, (_, i) => `const value${i} = ${i};`), '', '// пустая строка внутри блока', '```'].join('\n');
  writeFile(root, 'doc.md', `Вступление про апельсин.\n\n${code}\n\nПосле блока: мандарин.`);

  const chunks = chunksOf(root);
  for (const chunk of chunks) {
    assert.ok(size(chunk.text) <= 800, `кусок не длиннее 800: ${size(chunk.text)}`);
    const fences = (chunk.text.match(/```/g) || []).length;
    assert.equal(fences % 2, 0, `без половинок fence: ${JSON.stringify(chunk.text.slice(0, 40))}`);
  }
  const index = new WorkspaceIndex(root);
  index.build();
  assert.ok(index.search('value42').length > 0, 'слово из кода находится');
  assert.ok(index.search('мандарин').length > 0, 'текст после блока находится');
});

test('короткий блок кода остаётся одним куском целиком', (t) => {
  const root = tempDir(t);
  const code = '```python\nprint("апельсин")\n```';
  writeFile(root, 'short.md', `До.\n\n${code}\n\nПосле.`);
  const chunks = chunksOf(root);
  const withFence = chunks.filter((chunk) => chunk.text.includes('```'));
  assert.ok(withFence.length > 0, 'блок кода попал в куски');
  assert.ok(withFence.some((chunk) => chunk.text.includes('print("апельсин")')), 'код не разорван');
});

test('таблица не разрывается между кусками', (t) => {
  const root = tempDir(t);
  const table = ['| Фрукт | Цена |', '| --- | --- |', '| Апельсин | 5 |', '| Мандарин | 7 |'].join('\n');
  writeFile(root, 'table.md', `Список покупок.\n\n${table}\n\nКонец.`);
  const chunks = chunksOf(root);
  const withTable = chunks.filter((chunk) => chunk.text.includes('Апельсин'));
  assert.ok(withTable.length > 0, 'строка таблицы попала в кусок');
  assert.ok(withTable.some((chunk) => chunk.text.includes('| --- | --- |')), 'шапка таблицы в том же куске');
});

test('обычный текст по-прежнему режется по границам предложений', (t) => {
  const root = tempDir(t);
  const text = Array.from({ length: 18 }, (_, i) => `Это предложение номер ${i}, в нём достаточно слов для длины.`).join(' ');
  writeFile(root, 'plain.md', text);
  const chunks = chunksOf(root);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(0, -1)) assert.match(chunk.text.trim(), /[.!?…]$/);
  assert.equal(chunks.map((chunk) => chunk.text).join(' '), text);
});
