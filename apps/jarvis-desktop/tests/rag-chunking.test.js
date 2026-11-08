'use strict';

// Нарезка текста для поиска: длинный абзац режется по границам предложений,
// слова не рвутся, короткие «Да.» не становятся отдельными кусками.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceIndex } = require('../src/rag/index');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rag-'));
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
const endsSentence = (text) => /[.!?…]$/u.test(text.trim());

test('длинный абзац режется по границам предложений, а не посреди слова', (t) => {
  const root = tempDir(t);
  const sentences = Array.from({ length: 18 }, (_, i) => `Это предложение номер ${i}, в нём достаточно слов для длины.`);
  const text = sentences.join(' ');
  writeFile(root, 'long.md', text);

  const chunks = chunksOf(root);
  assert.ok(chunks.length > 1, 'абзац разбит на несколько кусков');
  for (const chunk of chunks) {
    assert.ok(size(chunk.text) <= 800, `кусок не длиннее 800: ${size(chunk.text)}`);
  }
  // Ни один кусок (кроме последнего) не обрывается посреди предложения.
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(endsSentence(chunk.text), `кусок кончается знаком конца предложения: …${chunk.text.slice(-25)}`);
  }
  // Текст не потерян и не переставлен: склейка кусков даёт исходный абзац.
  assert.equal(chunks.map((c) => c.text).join(' '), text);

  const index = new WorkspaceIndex(root);
  index.build();
  assert.ok(index.search('предложение 3').length > 0, 'поиск по предложению работает');
});

test('слово на границе 800 символов остаётся целым и находится поиском', (t) => {
  const root = tempDir(t);
  // Ровно 780 символов «текст », затем слово, которое старый жёсткий срез разорвал бы на границе 800.
  const text = `${'текст '.repeat(130)}апельсиновый сок и ещё несколько слов в конце абзаца`;
  writeFile(root, 'fruit.md', text);

  const chunks = chunksOf(root);
  const prefix = 'апельсин';
  for (const chunk of chunks) {
    if (chunk.text.includes(prefix.slice(0, 5))) {
      assert.ok(chunk.text.includes(prefix), 'слово не разорвано между кусками');
    }
  }
  const index = new WorkspaceIndex(root);
  index.build();
  const found = index.search('апельсиновый');
  assert.ok(found.length > 0, 'слово находится поиском');
  assert.ok(found[0].snippet.includes('апельсиновый'), 'сниппет содержит слово целиком');
});

test('короткая фраза «Да.» не становится отдельным куском', (t) => {
  const root = tempDir(t);
  const long = `Это длинное предложение, в котором много слов. ${'слово '.repeat(90)}конец.`;
  writeFile(root, 'short.md', `Да. ${long}`);

  const chunks = chunksOf(root);
  assert.ok(chunks.every((chunk) => chunk.text !== 'Да.'), '«Да.» не отдельный кусок');
  assert.ok(chunks[0].text.startsWith('Да. '), '«Да.» осталось в начале текста');
});

test('пустые строки по-прежнему разделяют куски, длинный текст без пробелов режется по лимиту', (t) => {
  const root = tempDir(t);
  writeFile(root, 'mixed.md', `первый\n\nвторой\r\n\r\n${'я'.repeat(1700)}`);
  const chunks = chunksOf(root);
  assert.deepEqual(chunks.map((c) => size(c.text)), [6, 6, 800, 800, 100]);
});
