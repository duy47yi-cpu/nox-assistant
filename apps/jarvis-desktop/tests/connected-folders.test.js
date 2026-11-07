'use strict';

// Подключённые папки: что индексируется, склонение, инкрементальная сборка, лимит, чтение по режиму.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-folders-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

// Рабочая папка и отдельная папка проекта владельца.
function setup(t) {
  const base = tempDir(t);
  const ws = path.join(base, 'ws');
  const proj = path.join(base, 'proj');
  fs.mkdirSync(ws);
  fs.mkdirSync(proj);
  const index = new WorkspaceIndex(ws);
  index.setFolders([proj]);
  return { ws, proj, index };
}

test('подключённая папка: data, .env, node_modules, .git, dist и строки с ключами не индексируются', (t) => {
  const { proj, index } = setup(t);
  const notes = writeFile(proj, 'notes.md', 'Купить чайник');
  writeFile(proj, 'data/settings.json', '{"note": "чайник"}');
  writeFile(proj, 'src/data/x.js', '// чайник');
  writeFile(proj, '.env', 'NOTE=чайник');
  writeFile(proj, '.git/config.txt', 'чайник');
  writeFile(proj, 'node_modules/x/index.js', 'чайник');
  writeFile(proj, 'dist/app.js', 'чайник');
  writeFile(proj, 'keys.txt', 'чайник\n\nпароль: qwerty123');
  writeFile(proj, 'token.md', 'чайник sk-abcdefghijklmnop');

  const found = index.search('чайник', 30);
  assert.deepEqual(found.map((r) => r.path).sort(), [path.join(proj, 'keys.txt'), notes].sort(),
    'из keys.txt остался только кусок без пароля');
  assert.equal(index.search('qwerty123').length, 0);

  // Подключённая папка сама внутри data — тоже закрыта.
  const inside = new WorkspaceIndex(path.join(path.dirname(proj), 'ws'));
  inside.setFolders([path.join(proj, 'data')]);
  assert.deepEqual(inside.search('чайник'), []);
});

test('поиск с учётом склонения: разные формы слова находят друг друга', (t) => {
  const { ws, proj, index } = setup(t);
  writeFile(ws, 'notes/a.md', 'Отправил отчётом всё, что было.');
  writeFile(proj, 'b.md', 'Подписали два договора.');
  writeFile(proj, 'c.md', 'Над рекой стоял дым.');

  assert.deepEqual(index.search('отчёты').map((r) => r.path), ['notes/a.md']);
  assert.deepEqual(index.search('договоров').map((r) => r.path), [path.join(proj, 'b.md')]);
  assert.deepEqual(index.search('договор').map((r) => r.path), [path.join(proj, 'b.md')]);
  assert.deepEqual(index.search('дом'), [], '«дом» не находит «дым»');
  assert.ok(index.search('договоров')[0].snippet.includes('договора'));
});

test('индекс инкрементальный: заново читается только файл с другой датой или размером', (t) => {
  const { ws, proj, index } = setup(t);
  writeFile(ws, 'notes/a.md', 'яблоко');
  const b = writeFile(proj, 'b.md', 'груша');
  const gone = writeFile(proj, 'gone.md', 'слива');
  // Целые миллисекунды: utimes точнее не восстановит.
  const when = new Date('2026-01-01T00:00:00.000Z');
  fs.utimesSync(b, when, when);

  index.build();
  assert.deepEqual(index.lastBuild, { read: 3, reused: 0 });
  index.build();
  assert.deepEqual(index.lastBuild, { read: 0, reused: 3 });

  // Тот же размер и та же дата: файл не перечитывается, в индексе старый текст.
  const size = fs.statSync(b).size;
  fs.writeFileSync(b, 'вишня', 'utf8');
  assert.equal(fs.statSync(b).size, size);
  fs.utimesSync(b, when, when);
  fs.rmSync(gone);
  index.build();
  assert.deepEqual(index.lastBuild, { read: 0, reused: 2 });
  assert.equal(index.search('вишня').length, 0);
  assert.equal(index.search('слива').length, 0, 'удалённый файл ушёл из индекса');

  // Другая дата: файл перечитан, остальные взяты из прошлого индекса, в том числе после перезапуска.
  fs.utimesSync(b, when, new Date(when.getTime() + 5000));
  const restarted = new WorkspaceIndex(ws);
  restarted.setFolders([proj]);
  restarted.build();
  assert.deepEqual(restarted.lastBuild, { read: 1, reused: 1 });
  assert.deepEqual(restarted.search('вишня').map((r) => r.path), [b]);
});

test('не больше 30 результатов, даже если просят больше', async (t) => {
  const { proj, index } = setup(t);
  for (let i = 0; i < 40; i += 1) writeFile(proj, `n${String(i).padStart(2, '0')}.md`, `заметка про ежа ${i}`);

  assert.equal(index.search('ёжик ежи', 100).length, 30);
  const [search] = workspaceTools(index);
  assert.equal((await search.run({ query: 'ежа', limit: 30 })).data.length, 30);
  assert.equal((await search.run({ query: 'ежа', limit: 31 })).ok, false);
});

test('чтение найденного: в «Авто» только рабочая папка, в «Полном доступе» и подключённая', async (t) => {
  const { ws, proj, index } = setup(t);
  writeFile(ws, 'notes/a.json', '{"фрукт": "манго"}');
  const outside = writeFile(proj, 'src/app.py', 'print("манго")');
  const [search, read] = workspaceTools(index);

  const found = (await search.run({ query: 'манго' })).data.map((r) => r.path).sort();
  assert.deepEqual(found, [outside, 'notes/a.json'].sort(), 'поиск видит обе папки в любом режиме');

  assert.equal((await read.run({ path: 'notes/a.json' })).ok, true, 'json в рабочей папке читается');
  const denied = await read.run({ path: outside });
  assert.equal(denied.ok, false);
  assert.match(denied.summary, /Полном доступе/);

  index.unrestricted = true;
  const allowed = await read.run({ path: outside });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.data.text, 'print("манго")');
});
