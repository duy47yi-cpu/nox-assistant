'use strict';

// Живой блокер 17.11.2026: stripServiceTokens схлопывал пустые строки (\s{2,}) и ломал Markdown
// длинного ответа — таблицы, блоки кода и формулы превращались в склеенный текст.
// Чистка служебных слов не должна трогать переводы строк и пустые строки.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripServiceTokens } = require('../src/agent/chat-reply');

const MARKDOWN = [
  '## Итоги',
  '',
  'Вступление: напоминание (remind_in) и Шаг 1 (remind_in): служебные следы.',
  '',
  '| Колонка | Значение |',
  '| --- | --- |',
  '| A | 1 |',
  '',
  '```js',
  'const x = 1;',
  '',
  'const y = 2;',
  '```',
  '',
  'Формула: $E = mc^2$',
  '',
  '### Ключевые принципы',
  '',
  '- один',
  '- два',
].join('\n');

test('чистка служебных слов сохраняет Markdown: таблицу, код, формулу, заголовки и пустые строки', () => {
  const out = stripServiceTokens(MARKDOWN, ['remind_in']);
  assert.doesNotMatch(out, /remind_in/);
  assert.doesNotMatch(out, /Шаг 1/);
  assert.ok(out.includes('\n\n'), 'пустые строки между блоками сохранены');
  assert.ok(out.includes('| Колонка | Значение |'), 'таблица цела');
  assert.ok(out.includes('| --- | --- |'), 'разделитель таблицы цел');
  assert.ok(out.includes('```js'), 'блок кода открыт');
  assert.ok(out.includes('const x = 1;\n\nconst y = 2;'), 'пустая строка внутри блока кода сохранена');
  assert.ok(out.includes('$E = mc^2$'), 'формула цела');
  assert.ok(out.includes('### Ключевые принципы'), 'заголовок не склеился с абзацем');
  assert.ok(out.split('\n').length >= MARKDOWN.split('\n').length - 2, 'строк стало не меньше');
});

test('в одной строке лишние пробелы схлопываются, а текст остаётся человеческим', () => {
  const out = stripServiceTokens('Открыл   терминал   (shell_run).  ', ['shell_run']);
  assert.equal(out, 'Открыл терминал.');
});
