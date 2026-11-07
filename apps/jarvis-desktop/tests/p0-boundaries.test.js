'use strict';

// P0: границы доступа. Песочница — отдельная папка; выход за неё и через симлинк/junction запрещён.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');
const { sandboxRoot } = require('../src/config/sandbox');
const { decide } = require('../src/policy/modes');
const { autonomousTools, AUTONOMY_EXCLUDED } = require('../src/tools/profiles');

// Проектная папка с песочницей и соседним «проектом», который трогать нельзя.
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p0-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'apps', 'jarvis-desktop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'jarvis-desktop', 'main.js'), 'код проекта', 'utf8');
  const sandbox = sandboxRoot(root);
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'notes'), { recursive: true });
  return { root, sandbox };
}

function tools(sandbox) {
  return workspaceTools(new WorkspaceIndex(sandbox));
}

test('песочница — подпапка workspace внутри корня проекта', () => {
  assert.equal(sandboxRoot('D:\\nox-assistant'), path.join('D:\\nox-assistant', 'workspace'));
});

test('запись внутри песочницы разрешена', async (t) => {
  const { sandbox } = project(t);
  const [, , write] = tools(sandbox);
  const res = await write.run({ path: 'notes/ok.md', content: 'текст' });
  assert.equal(res.ok, true);
});

test('выход за песочницу через ../ отказывает для чтения и записи, файл проекта не меняется', async (t) => {
  const { root, sandbox } = project(t);
  const [, read, write] = tools(sandbox);
  const target = path.join(root, 'apps', 'jarvis-desktop', 'main.js');

  assert.equal((await read.run({ path: '../apps/jarvis-desktop/main.js' })).ok, false);
  assert.equal((await write.run({ path: '../apps/jarvis-desktop/main.js', content: 'подмена' })).ok, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'код проекта');
});

test('выход через обратный слеш Windows и через абсолютный путь отказывает', async (t) => {
  const { root, sandbox } = project(t);
  const [, , write] = tools(sandbox);
  assert.equal((await write.run({ path: '..\\apps\\x.md', content: 'x' })).ok, false);
  assert.equal((await write.run({ path: path.join(root, 'apps', 'evil.md'), content: 'x' })).ok, false);
  assert.equal(fs.existsSync(path.join(root, 'apps', 'evil.md')), false);
});

test('соседняя папка с похожим именем не считается песочницей', async (t) => {
  const { root, sandbox } = project(t);
  fs.mkdirSync(path.join(root, 'workspace2'), { recursive: true });
  const [, , write] = tools(sandbox);
  assert.equal((await write.run({ path: '../workspace2/x.md', content: 'x' })).ok, false);
  assert.equal(fs.existsSync(path.join(root, 'workspace2', 'x.md')), false);
});

test('симлинк или junction из песочницы наружу не даёт записи за её пределы', async (t) => {
  const { root, sandbox } = project(t);
  const link = path.join(sandbox, 'link');
  try {
    fs.symlinkSync(path.join(root, 'apps'), link, 'junction');
  } catch {
    t.skip('нельзя создать junction в этой системе');
    return;
  }
  const [, , write] = tools(sandbox);
  const res = await write.run({ path: 'link/jarvis-desktop/evil.md', content: 'x' });
  assert.equal(res.ok, false);
  assert.equal(fs.existsSync(path.join(root, 'apps', 'jarvis-desktop', 'evil.md')), false);
});

test('shell_run в полном доступе выполняется без вопросов, в режимах с вопросами требует подтверждения', () => {
  assert.equal(decide({ mode: 'full', name: 'shell_run', risk: 'T2', args: { command: 'Get-Date' } }), 'allow');
  assert.equal(decide({ mode: 'auto', name: 'shell_run', risk: 'T2', args: { command: 'Get-Date' } }), 'ask');
});

test('подтверждение shell_run «на сессию» действует только на те же аргументы', () => {
  const { allowKey } = require('../src/policy/modes');
  const sessionAllow = new Set([allowKey('shell_run', { command: 'Get-Date' })]);
  assert.equal(decide({ mode: 'auto', name: 'shell_run', risk: 'T2', args: { command: 'Get-Date' }, sessionAllow }), 'allow');
  assert.equal(decide({ mode: 'auto', name: 'shell_run', risk: 'T2', args: { command: 'Remove-Other' }, sessionAllow }), 'ask');
});

test('в автономном наборе нет shell_run, library_run и project_run', () => {
  const list = [{ name: 'shell_run' }, { name: 'workspace_read' }, { name: 'url_open' }];
  // project_run исполняет команды, заданные файлами проекта (npm test и подобные): без владельца рядом нельзя.
  assert.deepEqual(AUTONOMY_EXCLUDED, ['shell_run', 'library_run', 'project_run']);
  assert.deepEqual(autonomousTools(list).map((t) => t.name), ['workspace_read', 'url_open']);
});

test('project_run не попадает в автономный набор, но project_commands остаётся чтением', () => {
  const { excludedFromAutonomy } = require('../src/tools/profiles');
  assert.equal(excludedFromAutonomy('project_run'), true);
  assert.equal(excludedFromAutonomy('project_commands'), false);
  assert.equal(excludedFromAutonomy('project_brief'), false);
});

test('library_run и команды библиотеки (lib_*) не входят в автономный набор', () => {
  const { excludedFromAutonomy } = require('../src/tools/profiles');
  assert.equal(excludedFromAutonomy('library_run'), true);
  assert.equal(excludedFromAutonomy('lib_new_note'), true);
  assert.equal(excludedFromAutonomy('workspace_read'), false);
});

test('library_run подтверждается в режимах с вопросами и не спрашивает в полном доступе', () => {
  assert.equal(decide({ mode: 'full', name: 'library_run', risk: 'T1', args: { id: 'x' } }), 'allow');
  assert.equal(decide({ mode: 'auto', name: 'library_run', risk: 'T1', args: { id: 'x' } }), 'ask');
});
