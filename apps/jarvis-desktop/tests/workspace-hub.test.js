'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceBook } = require('../src/workspaces/book');
const { WorkspaceChat } = require('../src/workspaces/chat');
const { WorkspaceHub } = require('../src/workspaces/hub');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-hub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { defaultRoot: path.join(dir, 'workspace'), spacesRoot: path.join(dir, 'workspaces'), dataDir: path.join(dir, 'data') };
  fs.mkdirSync(opts.defaultRoot); fs.mkdirSync(opts.dataDir);
  return { dir, opts, book: new WorkspaceBook(opts) };
}

test('при возвращении в общее и повторном выборе не теряются новые сообщения общего чата', (t) => {
  const { opts, book } = setup(t);
  let defaultText = 'старое';
  const file = path.join(opts.dataDir, 'conversation.json');
  const saveDefault = () => fs.writeFileSync(file, JSON.stringify({ history: [{ role: 'user', content: defaultText }] }));
  const makeChat = () => new WorkspaceChat({ book, brain: { async chat() { return { content: 'ок', toolCalls: [] }; } }, journal: { append() {} } });
  const hub = new WorkspaceHub({ book, makeChat, saveDefault, isBusy: () => false });
  const item = hub.create('Работа');
  hub.select(item.id);
  assert.equal(hub.current().id, item.id);
  hub.select('default');
  defaultText = 'новое сообщение общего чата';
  hub.select(item.id);
  assert.match(fs.readFileSync(file, 'utf8'), /новое сообщение общего чата/);
  hub.select('default');
  assert.match(fs.readFileSync(file, 'utf8'), /новое сообщение общего чата/);
  assert.equal(hub.chat(), null);
});

test('запрет переключения во время хода и неудачный выбор не меняют активное пространство', (t) => {
  const { book } = setup(t);
  const item = book.create('Работа');
  let busy = true;
  const hub = new WorkspaceHub({ book, makeChat: () => new WorkspaceChat({ book, brain: {}, journal: { append() {} } }), saveDefault() {}, isBusy: () => busy });
  assert.throws(() => hub.select(item.id), /занят/);
  assert.equal(book.current().id, 'default');
  busy = false;
  assert.throws(() => hub.select('bad'), /пространств/);
  assert.equal(hub.current().id, 'default');
});

test('после перезапуска открывается сохранённое отдельное пространство', (t) => {
  const { opts, book } = setup(t);
  const item = book.create('Работа');
  book.select(item.id);
  const nextBook = new WorkspaceBook(opts);
  const hub = new WorkspaceHub({ book: nextBook, makeChat: () => new WorkspaceChat({ book: nextBook, brain: {}, journal: { append() {} } }), saveDefault() {}, isBusy: () => false });
  assert.equal(hub.current().id, item.id);
  assert.equal(hub.chat().current().id, item.id);
});

test('сбой сохранения общего чата не меняет выбранное пространство', (t) => {
  const { book } = setup(t);
  const item = book.create('Работа');
  let created = 0;
  const hub = new WorkspaceHub({ book, makeChat: () => { created += 1; throw new Error('не должен создаваться'); }, saveDefault: () => false, isBusy: () => false });
  assert.throws(() => hub.select(item.id), /сохранить/);
  assert.equal(created, 0);
  assert.equal(book.current().id, 'default');
});
