'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-workspace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

// Рабочая папка: нужные файлы и файлы, которые индексироваться не должны.
function fixture(t) {
  const root = path.join(tempDir(t), 'ws');
  writeFile(root, 'notes/a.md', 'Любимый напиток — чай.\n\nКофе без сахара.');
  writeFile(root, 'inbox/b.txt', 'Ёлка стоит в углу.');
  writeFile(root, 'notes/tool.exe', 'чай');
  writeFile(root, 'notes/huge.md', 'x'.repeat(1024 * 1024 + 1));
  writeFile(root, 'rag/old.md', 'чай в старом индексе');
  writeFile(root, '.hidden/secret.md', 'чай секрет');
  writeFile(root, 'a/b/c/d/e/deep.md', 'глубоко чай');
  writeFile(root, 'a/b/c/d/e/f/g/h/i/toodeep.md', 'слишком глубоко чай');
  return root;
}

test('build индексирует текстовые типы, пропускает rag, точечные и закрытые папки, большие файлы и глубже 8 уровней', (t) => {
  const root = fixture(t);
  writeFile(root, 'a/b/c/d/e/f/g/h/eight.json', '{"x": "восемь"}');
  writeFile(root, 'data/x.md', 'данные');
  writeFile(root, 'node_modules/x/index.js', 'зависимость');
  writeFile(root, 'dist/app.js', 'сборка');
  writeFile(root, '.env', 'KEY=значение');
  const index = new WorkspaceIndex(root);
  const count = index.build();

  const data = JSON.parse(fs.readFileSync(path.join(root, 'rag', 'index.json'), 'utf8'));
  assert.equal(new Date(data.builtAt).toISOString(), data.builtAt);
  assert.equal(count, data.chunks.length);
  assert.equal(count, 5, 'a.md — 2 куска, b.txt, deep.md и eight.json — по одному');
  const paths = [...new Set(data.chunks.map((c) => c.path))].sort();
  assert.deepEqual(paths, ['a/b/c/d/e/deep.md', 'a/b/c/d/e/f/g/h/eight.json', 'inbox/b.txt', 'notes/a.md']);
});

test('build режет по пустым строкам, длинный абзац — по 800 символов', (t) => {
  const root = tempDir(t);
  writeFile(root, 'long.md', `первый\n\nвторой\r\n\r\n${'я'.repeat(1700)}`);
  const index = new WorkspaceIndex(root);
  assert.equal(index.build(), 5);

  const chunks = index.load().chunks;
  assert.deepEqual(chunks.map((c) => Array.from(c.text).length), [6, 6, 800, 800, 100]);
  assert.equal(chunks[1].text, 'второй');
  assert.equal(chunks[0].path, 'long.md');
});

test('search: находит слово, возвращает путь и сниппет; регистр и ё не важны', (t) => {
  const root = fixture(t);
  const index = new WorkspaceIndex(root);
  index.build();

  const found = index.search('ЧАЙ');
  assert.deepEqual(found.map((r) => r.path), ['a/b/c/d/e/deep.md', 'notes/a.md']);
  assert.deepEqual(found.map((r) => r.score), [1, 1]);
  assert.ok(found[1].snippet.includes('чай'));
  assert.ok(found.every((r) => r.snippet.length <= 300));

  const yo = index.search('елка');
  assert.deepEqual(yo.map((r) => r.path), ['inbox/b.txt']);
  assert.ok(yo[0].snippet.startsWith('Ёлка'));

  assert.deepEqual(index.search('космос'), []);
  assert.deepEqual(index.search('а'), [], 'слова короче двух букв не ищутся');
  assert.equal(index.search('чай', 1).length, 1);
});

test('search: больше совпавших слов выше, при равенстве — по пути', (t) => {
  const root = fixture(t);
  writeFile(root, 'notes/c.md', 'кофе с сахаром');
  const index = new WorkspaceIndex(root);
  index.build();

  const found = index.search('кофе сахар чай');
  assert.deepEqual(found.map((r) => [r.path, r.score]), [
    ['notes/a.md', 2],
    ['notes/c.md', 2],
    ['a/b/c/d/e/deep.md', 1],
    ['notes/a.md', 1],
  ]);
});

test('search перестраивает индекс старше 60 секунд', (t) => {
  const root = fixture(t);
  new WorkspaceIndex(root).build();
  writeFile(root, 'notes/later.md', 'самовар');
  const file = path.join(root, 'rag', 'index.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.builtAt = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');

  const index = new WorkspaceIndex(root);
  assert.deepEqual(index.search('самовар').map((r) => r.path), ['notes/later.md']);
});

test('индекс старого формата без files перестраивается', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'rag'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rag', 'index.json'), JSON.stringify({ builtAt: new Date().toISOString(), chunks: [{ path: 'notes/a.md', text: 'чай' }] }), 'utf8');
  assert.deepEqual(new WorkspaceIndex(root).search('чай').map((r) => r.path), ['a/b/c/d/e/deep.md', 'notes/a.md']);
});

test('resolveInside пускает только пути внутри рабочей папки', (t) => {
  const base = tempDir(t);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const index = new WorkspaceIndex(root);

  assert.equal(index.resolveInside('notes/a.md'), path.join(root, 'notes', 'a.md'));
  assert.equal(index.resolveInside(path.join(root, 'notes', 'a.md')), path.join(root, 'notes', 'a.md'));
  assert.throws(() => index.resolveInside('../x.md'), /путь вне рабочей папки/);
  assert.throws(() => index.resolveInside('notes/../../x.md'), /путь вне рабочей папки/);
  assert.throws(() => index.resolveInside(path.join(base, 'x.md')), /путь вне рабочей папки/);
  assert.throws(() => index.resolveInside('../ws-evil/a.md'), /путь вне рабочей папки/, 'соседняя папка с похожим именем');
  assert.throws(() => index.resolveInside(''), /путь вне рабочей папки/);
});

test('workspace_search: T0, пустой запрос отклоняется, результат в data', async (t) => {
  const root = fixture(t);
  const [search] = workspaceTools(new WorkspaceIndex(root));

  const res = await search.run({ query: 'чай' });
  assert.equal(res.ok, true);
  assert.equal(res.summary, 'найдено: 2');
  assert.deepEqual(res.data.map((r) => r.path), ['a/b/c/d/e/deep.md', 'notes/a.md']);

  assert.equal((await search.run({ query: '   ' })).ok, false);
  assert.equal((await search.run({})).ok, false);
  assert.equal((await search.run({ query: 'чай', limit: 0 })).ok, false);
  assert.equal((await search.run({ query: 'чай', limit: 30 })).ok, true);
  assert.equal((await search.run({ query: 'чай', limit: 31 })).ok, false);
});

test('workspace_read: читает .md, отказывает для .exe, для пути вне папки и для отсутствующего файла', async (t) => {
  const root = fixture(t);
  writeFile(path.dirname(root), 'outside.md', 'снаружи');
  const [, read] = workspaceTools(new WorkspaceIndex(root));

  const ok = await read.run({ path: 'notes/a.md' });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.text, 'Любимый напиток — чай.\n\nКофе без сахара.');
  assert.equal(ok.data.truncated, false);

  assert.equal((await read.run({ path: 'notes/tool.exe' })).ok, false);
  assert.equal((await read.run({ path: '../outside.md' })).ok, false);
  assert.equal((await read.run({ path: path.join(path.dirname(root), 'outside.md') })).ok, false);
  assert.equal((await read.run({ path: 'notes/none.md' })).ok, false);
  assert.equal((await read.run({})).ok, false);
});

test('workspace_read: файл больше 20 КБ обрезается и это сказано в summary', async (t) => {
  const root = tempDir(t);
  writeFile(root, 'big.txt', 'a'.repeat(25 * 1024));
  const [, read] = workspaceTools(new WorkspaceIndex(root));

  const res = await read.run({ path: 'big.txt' });
  assert.equal(res.ok, true);
  assert.equal(res.data.truncated, true);
  assert.equal(res.data.text.length, 20 * 1024);
  assert.match(res.summary, /обрезан/);
});

test('workspace_write: пишет в notes, создаёт папки, отказывает для .exe, rag, точки и перезаписи вне reports', async (t) => {
  const root = fixture(t);
  const index = new WorkspaceIndex(root);
  const [search, , write] = workspaceTools(index);

  assert.equal((await search.run({ query: 'чай' })).ok, true, 'индекс построен до записи');

  const created = await write.run({ path: 'notes/new.md', content: 'Новая заметка про велосипед' });
  assert.equal(created.ok, true);
  assert.equal(created.summary, 'записал');
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'new.md'), 'utf8'), 'Новая заметка про велосипед');
  const found = await search.run({ query: 'велосипед' });
  assert.deepEqual(found.data.map((r) => r.path), ['notes/new.md'], 'после записи индекс обновлён');

  const deep = await write.run({ path: 'created/deep/dirs/x.txt', content: 'текст' });
  assert.equal(deep.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'created', 'deep', 'dirs', 'x.txt')), true);

  const exe = await write.run({ path: 'notes/new.exe', content: 'MZ' });
  assert.equal(exe.ok, false);
  assert.equal(fs.existsSync(path.join(root, 'notes', 'new.exe')), false);

  for (const rel of ['rag/evil.md', '.hidden/new.md', '.secret.md']) {
    const res = await write.run({ path: rel, content: 'x' });
    assert.equal(res.ok, false, rel);
    assert.equal(fs.existsSync(path.join(root, ...rel.split('/'))), false, rel);
  }

  const over = await write.run({ path: 'notes/a.md', content: 'подмена' });
  assert.equal(over.ok, false);
  assert.equal(over.summary, 'перезаписывать можно только в reports');
  assert.match(fs.readFileSync(path.join(root, 'notes', 'a.md'), 'utf8'), /Любимый/);

  const outside = await write.run({ path: '../evil.md', content: 'x' });
  assert.equal(outside.ok, false);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'evil.md')), false);

  const first = await write.run({ path: 'reports/r.md', content: 'v1' });
  assert.equal(first.ok, true);
  const second = await write.run({ path: 'reports/r.md', content: 'v2' });
  assert.equal(second.ok, true, 'в reports перезапись разрешена');
  assert.equal(second.summary, 'перезаписал');
  assert.equal(fs.readFileSync(path.join(root, 'reports', 'r.md'), 'utf8'), 'v2');

  assert.equal((await write.run({ path: 'notes/empty.md', content: '' })).ok, false);
});

test('инструменты: workspace_search, workspace_read, workspace_list — T0, workspace_write — T1', (t) => {
  const root = tempDir(t);
  const list = workspaceTools(new WorkspaceIndex(root));

  assert.deepEqual(list.map((tool) => tool.name), ['workspace_search', 'workspace_read', 'workspace_write', 'workspace_list', 'workspace_move', 'workspace_copy', 'workspace_mkdir', 'workspace_restore']);
  assert.deepEqual(list.map((tool) => tool.risk), ['T0', 'T0', 'T1', 'T0', 'T1', 'T1', 'T1', 'T1']);
  for (const tool of list) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.run, 'function');
    assert.equal(tool.parameters.type, 'object');
  }
});

test('workspace_list: показывает папки и файлы без содержимого, скрывает точечные и rag в корне', async (t) => {
  const root = fixture(t);
  writeFile(root, '.secret/x.md', 'тайна');
  writeFile(root, 'rag/index.json', '{}');
  const list = workspaceTools(new WorkspaceIndex(root)).find((tool) => tool.name === 'workspace_list');

  const top = await list.run({});
  assert.equal(top.ok, true);
  assert.deepEqual(top.data.items.map((item) => item.name), ['a', 'inbox', 'notes']);
  assert.equal(top.data.items[1].type, 'папка');
  assert.equal(top.data.items[1].size, null);

  const notes = await list.run({ path: 'notes' });
  assert.equal(notes.ok, true);
  const names = notes.data.items.map((item) => item.name);
  assert.deepEqual(names, ['a.md', 'huge.md', 'tool.exe']);
  const a = notes.data.items.find((item) => item.name === 'a.md');
  assert.equal(a.type, 'файл');
  assert.equal(a.path, 'notes/a.md');
  assert.equal(a.size, Buffer.byteLength('Любимый напиток — чай.\n\nКофе без сахара.'));

  assert.equal((await list.run({ path: 'notes/a.md' })).ok, false, 'файл — не папка');
  // Отсутствующая папка — не ошибка: исполнитель видит «папки нет» и может создать её записью файла.
  const absent = await list.run({ path: 'missing' });
  assert.equal(absent.ok, true, 'папки нет — наблюдение, а не ошибка');
  assert.deepEqual(absent.data, { exists: false, items: [] });
  assert.match(absent.summary, /папки «missing» пока нет/);
  assert.equal((await list.run({ path: '../' })).ok, false, 'вне рабочей папки');
  assert.equal((await list.run({ path: '.secret' })).ok, false, 'точечные папки не показываем, даже по прямому пути');
  assert.equal((await list.run({ path: 'rag' })).ok, false, 'rag не показываем');
});
