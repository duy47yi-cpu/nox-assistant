'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceBook } = require('../src/workspaces/book');
const { workspaceTools } = require('../src/tools/workspace');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-workspaces-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { defaultRoot: path.join(dir, 'workspace'), spacesRoot: path.join(dir, 'workspaces'), dataDir: path.join(dir, 'data') };
  fs.mkdirSync(opts.defaultRoot, { recursive: true });
  fs.mkdirSync(opts.dataDir, { recursive: true });
  return { dir, opts, book: new WorkspaceBook(opts) };
}

test('сохранённые пространства разделяют настоящие файлы, поиск и память', async (t) => {
  const { opts, book } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  const a = book.open(work.id);
  const b = book.open(study.id);
  const write = (space) => workspaceTools(space.index).find((tool) => tool.name === 'workspace_write');
  assert.equal((await write(a).run({ path: 'notes/plan.md', content: 'рабочий план' })).ok, true);
  assert.equal((await write(b).run({ path: 'notes/plan.md', content: 'учебный план' })).ok, true);
  a.memory.add({ text: 'рабочее решение' });
  b.memory.add({ text: 'учебное решение' });
  assert.equal(fs.readFileSync(path.join(a.root, 'notes/plan.md'), 'utf8'), 'рабочий план');
  assert.equal(fs.readFileSync(path.join(b.root, 'notes/plan.md'), 'utf8'), 'учебный план');
  assert.deepEqual(a.memory.search('учебное'), []);
  assert.deepEqual(b.memory.search('рабочее'), []);
  assert.equal(a.index.search('учебный').length, 0);
  assert.equal(b.index.search('рабочий').length, 0);
  assert.throws(() => a.index.resolveInside(path.relative(a.root, path.join(b.root, 'notes/plan.md'))), /вне/);
  book.select(study.id);
  const restored = new WorkspaceBook(opts);
  assert.equal(restored.current().id, study.id);
  assert.equal(restored.open(study.id).memory.search('учебное').length, 1);
  assert.equal(restored.open(work.id).memory.search('рабочее').length, 1);
});

test('общее пространство использует старую папку и старый файл памяти без переноса', (t) => {
  const { opts, book } = setup(t);
  fs.writeFileSync(path.join(opts.defaultRoot, 'old.txt'), 'сохранённый файл');
  const common = book.open('default');
  assert.equal(common.root, opts.defaultRoot);
  assert.equal(common.memory.filePath, path.join(opts.dataDir, 'memory.json'));
  assert.equal(fs.readFileSync(path.join(common.root, 'old.txt'), 'utf8'), 'сохранённый файл');
  assert.equal(book.current().id, 'default');
});

test('неизвестные, повреждённые и небезопасные идентификаторы отклоняются без записи поверх реестра', (t) => {
  const { opts, book } = setup(t);
  assert.throws(() => book.select('../outside'), /пространств/);
  assert.throws(() => book.open('../outside'), /пространств/);
  assert.throws(() => book.create('  '), /назван/);
  book.create('Работа');
  assert.throws(() => book.create('работа'), /существует/);
  const file = path.join(opts.dataDir, 'workspaces.json');
  fs.writeFileSync(file, '{broken', 'utf8');
  assert.throws(() => new WorkspaceBook(opts), /поврежд/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('ссылка вместо папки пространства отклоняется при открытии', (t) => {
  const { dir, opts, book } = setup(t);
  const space = book.create('Работа');
  const root = path.join(opts.spacesRoot, space.id);
  fs.rmdirSync(root);
  const other = path.join(dir, 'outside');
  fs.mkdirSync(other);
  try { fs.symlinkSync(other, root, 'junction'); } catch { return t.skip('junction недоступен'); }
  assert.throws(() => book.open(space.id), /ссылк|папк/);
});

test('каталог пространств не может оказаться внутри старой рабочей папки через ссылку', (t) => {
  const { dir, opts } = setup(t);
  const alias = path.join(dir, 'alias');
  try { fs.symlinkSync(opts.defaultRoot, alias, 'junction'); } catch { return t.skip('junction недоступен'); }
  const unsafe = { ...opts, spacesRoot: path.join(alias, 'hidden-spaces') };
  assert.throws(() => new WorkspaceBook(unsafe), /раздельн/);
  assert.equal(fs.existsSync(path.join(opts.defaultRoot, 'hidden-spaces')), false);
});

test('повреждённый реестр с посторонним путём или повторным id не открывается', (t) => {
  const { opts, book } = setup(t);
  const created = book.create('Работа');
  const file = path.join(opts.dataDir, 'workspaces.json');
  for (const data of [
    { version: 1, selected: '../other', spaces: [{ id: '../other', name: 'Чужое' }] },
    { version: 1, selected: created.id, spaces: [created, created] },
    { version: 1, selected: 'missing', spaces: [created] },
  ]) {
    const raw = JSON.stringify(data);
    fs.writeFileSync(file, raw);
    assert.throws(() => new WorkspaceBook(opts), /поврежд/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});
