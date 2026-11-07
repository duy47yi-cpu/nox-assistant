'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceBook } = require('../src/workspaces/book');
const { WorkspaceCommandStores, toolsForWorkspaceCommands } = require('../src/workspaces/commands');
const { CommandStore } = require('../src/commands/store');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-workspace-commands-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { defaultRoot: path.join(dir, 'workspace'), spacesRoot: path.join(dir, 'workspaces'), dataDir: path.join(dir, 'data') };
  fs.mkdirSync(opts.defaultRoot, { recursive: true });
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const book = new WorkspaceBook(opts);
  const common = new CommandStore(path.join(opts.dataDir, 'commands.json'));
  return { opts, book, stores: new WorkspaceCommandStores({ book, defaultStore: common }), common };
}

function command(name, phrase) {
  return { name, phrases: [phrase], steps: [{ tool: 'app_open', args: { name: 'Notepad' } }], enabled: true };
}

test('команды пространств разделены, старые команды остаются только в Общем', (t) => {
  const { book, stores, common } = setup(t);
  common.save(command('Общая', 'открой общий блокнот'));
  const work = book.create('Работа');
  const study = book.create('Учёба');
  const workCommands = stores.store(work.id);
  const studyCommands = stores.store(study.id);
  workCommands.save(command('Рабочая', 'запусти мой блокнот'));
  studyCommands.save(command('Учебная', 'запусти мой блокнот'));
  assert.equal(workCommands.findByPhrase('запусти мой блокнот').name, 'Рабочая');
  assert.equal(studyCommands.findByPhrase('запусти мой блокнот').name, 'Учебная');
  assert.equal(stores.store('default').findByPhrase('открой общий блокнот').name, 'Общая');
  assert.equal(stores.store('default').findByPhrase('запусти мой блокнот'), null);
  assert.equal(workCommands.findByPhrase('открой общий блокнот'), null);
});

test('путь команд нельзя подменить ссылкой', (t) => {
  const { book, stores } = setup(t);
  const work = book.create('Работа');
  const file = path.join(path.dirname(book.open(work.id).memory.filePath), 'commands.json');
  const outside = path.join(path.dirname(file), 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ items: [] }));
  try { fs.symlinkSync(outside, file, 'file'); }
  catch (err) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) return t.skip(`создание ссылки недоступно: ${err.code}`);
    throw err;
  }
  assert.throws(() => stores.store(work.id).list(), /ссылк/);
});

test('набор команды пространства исключает общий инструменты памяти, напоминаний и файлов', () => {
  const tool = (name) => ({ name, run: async () => ({ ok: true }) });
  const shared = ['remind_in', 'remind_at', 'list_reminders', 'cancel_reminder', 'workspace_read', 'memory_about', 'app_open'];
  const scoped = toolsForWorkspaceCommands(shared.map(tool));
  assert.deepEqual(scoped.map((x) => x.name), ['app_open']);
});
