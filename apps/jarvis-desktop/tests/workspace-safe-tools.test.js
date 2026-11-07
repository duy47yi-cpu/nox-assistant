'use strict';

// Общие действия компьютера доступны через политику текущего режима;
// файлы и память при этом берутся из выбранного пространства.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceBook } = require('../src/workspaces/book');
const { WorkspaceChat } = require('../src/workspaces/chat');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-space-safe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { defaultRoot: path.join(dir, 'workspace'), spacesRoot: path.join(dir, 'workspaces'), dataDir: path.join(dir, 'data') };
  fs.mkdirSync(opts.defaultRoot); fs.mkdirSync(opts.dataDir);
  return { dir, book: new WorkspaceBook(opts) };
}

function fake(name) {
  return { name, risk: 'T0', parameters: { type: 'object', properties: {} }, async run() { return { ok: true, summary: 'fake' }; } };
}

function chatFor(book, commonTools) {
  return new WorkspaceChat({ book, commonTools, brain: { async chat() { return { content: 'ok', toolCalls: [] }; } }, journal: { append() {} } });
}

test('общие действия доступны в пространстве, а задачи остаются привязаны к пространству', (t) => {
  const { book } = setup(t);
  book.create('Работа');
  const safe = ['screen_look', 'desktop_observe', 'windows_list', 'wait_for', 'web_search', 'weather_now', 'web_check_claims'];
  const actions = [
    'desktop_click', 'desktop_type', 'ui_click', 'ui_type', 'ui_keys', 'mouse_click',
    'shell_run', 'app_install', 'mail_send', 'browser_open', 'browser_click',
    'youtube_play', 'windows_close_all', 'clipboard_set',
  ];
  const commonTools = [...safe.map(fake), ...actions.map(fake), fake('task_submit'), fake('image_read_text')];
  const session = chatFor(book, commonTools);
  const names = session.tools().list().map((tool) => tool.name);

  for (const name of safe) assert.equal(names.includes(name), true, `нет безопасного инструмента ${name}`);
  for (const name of actions) assert.equal(names.includes(name), true, `нет действия ${name}`);
  assert.equal(names.includes('task_submit'), false);

  // Взгляд и ожидание берутся из общего реестра как есть.
  assert.equal(session.tools().get('screen_look'), commonTools.find((tool) => tool.name === 'screen_look'));
  assert.equal(session.tools().get('web_search'), commonTools.find((tool) => tool.name === 'web_search'));

  // Картинки — свои, с корнем пространства: общий image_read_text не подменяет инструмент пространства.
  assert.notEqual(session.tools().get('image_read_text'), commonTools.find((tool) => tool.name === 'image_read_text'));
  assert.equal(names.includes('image_look'), true);
  assert.equal(names.includes('image_read_text'), true);

  // Файлы, память, цели и навыки пространства на месте.
  for (const name of ['workspace_read', 'workspace_write', 'document_read', 'remember', 'recall', 'goal_create', 'skills_list']) {
    assert.equal(names.includes(name), true, `нет инструмента пространства ${name}`);
  }
});

test('команды пространства не регистрируют инструменты картинок дважды', (t) => {
  const { ToolRegistry } = require('../src/tools/registry');
  const { toolsForWorkspaceCommands } = require('../src/workspaces/commands');
  const { imageTools } = require('../src/tools/ocr');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-space-cmd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // В общем наборе команд лежат инструменты картинок от общей рабочей папки: их надо отфильтровать,
  // иначе при добавлении своих imageTools реестр упадёт «Инструмент уже зарегистрирован».
  const common = [...imageTools({ workspace: root }), fake('workspace_read'), fake('workspace_write')];
  const filtered = toolsForWorkspaceCommands(common);
  assert.deepEqual(filtered.filter((tool) => String(tool.name).startsWith('image_')), []);
  const registry = new ToolRegistry();
  for (const tool of [...filtered, ...imageTools({ workspace: root })]) registry.register(tool);
  const names = registry.list().map((tool) => tool.name);
  assert.equal(names.filter((name) => name === 'image_read_text').length, 1);
  assert.equal(names.filter((name) => name === 'image_look').length, 1);
});

test('ожидание файла использует выбранное пространство, а не общую папку', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  const common = book.open('default');
  const workRoot = book.open(work.id).root;
  const studyRoot = book.open(study.id).root;
  fs.writeFileSync(path.join(common.root, 'ready.txt'), 'общий');
  fs.writeFileSync(path.join(studyRoot, 'ready.txt'), 'учёба');
  const { waitTools } = require('../src/tools/wait');
  const commonWait = waitTools({ resolveFile: (p) => common.index.resolveInside(p) });
  const session = chatFor(book, commonWait);
  session.select(work.id);
  const args = { kind: 'file', target: 'ready.txt', timeout_ms: 1 };
  assert.equal((await session.tools().get('wait_for').run(args)).ok, false);
  fs.writeFileSync(path.join(workRoot, 'ready.txt'), 'работа');
  assert.equal((await session.tools().get('wait_for').run(args)).ok, true);
  session.select(study.id);
  assert.equal((await session.tools().get('wait_for').run(args)).ok, true);
});

test('картинка читается из папки своего пространства, а не из общей рабочей папки', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  const workSpace = book.open(work.id);
  const studySpace = book.open(study.id);
  // Картинка лежит только в папке учёбы. В «Работе» её не должно быть видно.
  fs.mkdirSync(path.join(studySpace.root, 'pics'), { recursive: true });
  fs.writeFileSync(path.join(studySpace.root, 'pics', 'схема.png'), PNG);

  const session = chatFor(book, []);
  session.select(work.id);
  const look = session.tools().get('image_look');
  const missing = await look.run({ path: 'pics/схема.png' });
  assert.equal(missing.ok, false, 'картинка чужого пространства не должна открываться');
  assert.match(missing.summary, /не найдена|вне рабочей папки/);

  const read = session.tools().get('image_read_text');
  const readMissing = await read.run({ path: 'pics/схема.png' });
  assert.equal(readMissing.ok, false);

  // После переключения в «Учёбу» картинка открывается как изображение для модели.
  session.select(study.id);
  const opened = await session.tools().get('image_look').run({ path: 'pics/схема.png' });
  assert.equal(opened.ok, true);
  assert.match(opened.image, /^data:image\/png;base64,/);
  assert.equal(fs.readFileSync(path.join(studySpace.root, 'pics', 'схема.png')).equals(PNG), true, 'инструмент не меняет файл');
  session.select(work.id);
});
