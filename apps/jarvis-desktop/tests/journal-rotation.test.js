'use strict';

// Ротация журнала действий (идея Hermes): файл не растёт бесконечно, старые записи
// переезжают в .1/.2/.3, история и поиск читают всю цепочку, ничего не теряя.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Journal, readJournal, searchJournal } = require('../src/journal/journal');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'journal.jsonl');
}

test('журнал делится на файлы и не растёт бесконечно', (t) => {
  const file = tempFile(t);
  const journal = new Journal(file, { maxBytes: 300, backups: 2 });
  for (let i = 0; i < 20; i += 1) journal.append({ tool: 'app_open', summary: `действие номер ${i}`, ok: true });

  assert.ok(fs.existsSync(`${file}.1`), 'появился прошлый файл .1');
  assert.ok(fs.existsSync(`${file}.2`), 'появился файл .2');
  assert.equal(fs.existsSync(`${file}.3`), false, 'файлов больше, чем backups, нет');
  assert.ok(fs.statSync(file).size <= 600, 'живой файл ограничен по размеру');
});

test('история и поиск читают всю цепочку: старые записи не теряются', (t) => {
  const file = tempFile(t);
  const journal = new Journal(file, { maxBytes: 300, backups: 4 });
  journal.append({ tool: 'app_open', summary: 'самое первое действие', ok: true });
  // Записей немного меньше ёмкости цепочки: при переполнении старейшие по правилу удаляются, это проверено выше.
  for (let i = 0; i < 9; i += 1) journal.append({ tool: 'app_open', summary: `действие номер ${i}`, ok: true });

  const all = readJournal(file, { limit: 500 });
  assert.equal(all.problem, null);
  assert.ok(all.total >= 10, `в истории все записи, а не только последний файл: ${all.total}`);
  assert.ok(all.items.some((item) => /самое первое/.test(item.summary)), 'первая запись доступна из .N');
  // Новые записи сверху.
  assert.ok(all.items[0].ts >= all.items[all.items.length - 1].ts);

  const found = searchJournal(file, { query: 'самое первое', limit: 10 });
  assert.equal(found.problem, null);
  assert.equal(found.total, 1, 'поиск видит старый файл');
  assert.match(found.items[0].summary, /самое первое/);
});

test('пустой журнал и отсутствие файла — безопасное пустое состояние', (t) => {
  const file = tempFile(t);
  const journal = new Journal(file, { maxBytes: 10 * 1024 * 1024, backups: 3 });
  assert.deepEqual(readJournal(file).items, []);
  journal.append({ tool: 'app_open', summary: 'одно действие', ok: true });
  assert.equal(readJournal(file).total, 1);
});
