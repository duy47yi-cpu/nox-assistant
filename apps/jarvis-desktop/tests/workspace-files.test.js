'use strict';

// Перенос, копия и папка в рабочей папке; проверка путей переноса в политике, мандате и фоновом наборе.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');
const { projectTools } = require('../src/tools/project');
const { withOwnWorkspace } = require('../src/tools/profiles');
const { documentTools } = require('../src/tools/documents');
const { decide } = require('../src/policy/modes');
const { checkTool } = require('../src/tasks/mandate');
const { checkEffect } = require('../src/agent/effects');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'ws');
  fs.mkdirSync(root, { recursive: true });
  const index = new WorkspaceIndex(root);
  const tools = workspaceTools(index);
  const by = (name) => tools.find((x) => x.name === name);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, 'utf8');
  };
  return { root, index, by, write, exists: (rel) => fs.existsSync(path.join(root, rel)) };
}

test('агент подтверждает содержимое файла после переноса через общий цикл', async (t) => {
  const { by, write, root } = setup(t);
  write('source.txt', 'данные');
  const tools = new ToolRegistry();
  tools.register(by('workspace_move'));
  let calls = 0;
  const brain = { async chat() {
    calls += 1;
    return calls === 1
      ? { toolCalls: [{ id: 'c1', name: 'workspace_move', args: { from: 'source.txt', to: 'archive/source.txt' } }] }
      : { content: 'Готово', toolCalls: [] };
  } };
  const records = [];
  const agent = new Agent({ brain, tools, workspace: root, policy: () => 'allow', journal: { append: (item) => records.push(item) } });
  await agent.run('Перенеси файл');
  assert.equal(records.find((item) => item.tool === 'workspace_move').verified, 'confirmed');
});

test('содержимое небольших файлов проверяется после копирования и переноса', async (t) => {
  const { by, write, root } = setup(t);
  write('a.md', 'оригинал');
  const copy = by('workspace_copy');
  const copied = await copy.run({ from: 'a.md', to: 'b.md' });
  const checkedCopy = await checkEffect(copy, {}, copied, {});
  assert.equal(checkedCopy.verified, 'confirmed');
  write('b.md', 'другое содержимое');
  assert.equal((await checkEffect(copy, {}, copied, {})).verified, 'unknown');
  fs.unlinkSync(path.join(root, 'b.md'));
  assert.equal((await checkEffect(copy, {}, copied, {})).verified, 'failed');
  const move = by('workspace_move');
  const moved = await move.run({ from: 'a.md', to: 'c.md' });
  assert.equal((await checkEffect(move, {}, moved, {})).verified, 'confirmed');
  write('c.md', 'изменено после переноса');
  assert.equal((await checkEffect(move, {}, moved, {})).verified, 'unknown');
  write('a.md', 'появился снова');
  assert.equal((await checkEffect(move, {}, moved, {})).verified, 'unknown');
});

test('проверка копии честно сообщает об ограничениях и отсутствии источника', async (t) => {
  const { by, write, root } = setup(t);
  const copy = by('workspace_copy');
  write('folder/a.txt', 'текст');
  const directory = await copy.run({ from: 'folder', to: 'folder-copy' });
  assert.equal((await checkEffect(copy, {}, directory, {})).verified, 'unknown');
  write('source.txt', 'текст');
  const file = await copy.run({ from: 'source.txt', to: 'target.txt' });
  fs.unlinkSync(path.join(root, 'source.txt'));
  assert.equal((await checkEffect(copy, {}, file, {})).verified, 'unknown');
  const large = path.join(root, 'large.txt');
  fs.writeFileSync(large, Buffer.alloc(8 * 1024 * 1024 + 1));
  const copied = await copy.run({ from: 'large.txt', to: 'large-copy.txt' });
  assert.equal((await checkEffect(copy, {}, copied, {})).verified, 'unknown');
});

test('перенос и копия файла внутри папки; перенос убирает источник, копия оставляет', async (t) => {
  const { root, by, write, exists } = setup(t);
  write('notes/a.md', 'заметка');
  const moved = await by('workspace_move').run({ from: 'notes/a.md', to: 'архив/a.md' });
  assert.equal(moved.ok, true, moved.summary);
  assert.equal(moved.summary, 'перенёс');
  assert.equal(fs.readFileSync(path.join(root, 'архив', 'a.md'), 'utf8'), 'заметка');
  assert.equal(exists('notes/a.md'), false);
  const copied = await by('workspace_copy').run({ from: 'архив/a.md', to: 'копия.md' });
  assert.equal(copied.ok, true, copied.summary);
  assert.equal(exists('архив/a.md'), true);
  assert.equal(exists('копия.md'), true);
});

test('перенос папки целиком; папку в неё саму не переносим', async (t) => {
  const { exists, by, write } = setup(t);
  write('проект/один.txt', '1');
  write('проект/под/два.txt', '2');
  assert.equal((await by('workspace_copy').run({ from: 'проект', to: 'копия-проекта' })).ok, true);
  assert.equal(exists('копия-проекта/под/два.txt'), true);
  assert.equal((await by('workspace_move').run({ from: 'проект', to: 'проект/внутри' })).ok, false);
  assert.equal(exists('проект/один.txt'), true, 'источник цел');
});

test('копия папки с не-ASCII путём: содержимое и вложенность на месте', async (t) => {
  const { root, by, write, exists } = setup(t);
  write('папка/один.txt', '1');
  write('папка/под/два.txt', '2');
  const res = await by('workspace_copy').run({ from: 'папка', to: 'копия папки' });
  assert.equal(res.ok, true, res.summary);
  assert.equal(fs.readFileSync(path.join(root, 'копия папки', 'один.txt'), 'utf8'), '1');
  assert.equal(fs.readFileSync(path.join(root, 'копия папки', 'под', 'два.txt'), 'utf8'), '2');
  assert.equal(exists('папка/один.txt'), true, 'источник цел');
});

test('назначение без overwrite не трогается; с overwrite — только в reports', async (t) => {
  const { root, by, write } = setup(t);
  write('a.md', 'новое');
  write('b.md', 'старое');
  const busy = await by('workspace_move').run({ from: 'a.md', to: 'b.md' });
  assert.equal(busy.ok, false);
  assert.match(busy.summary, /overwrite: true/);
  assert.equal(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), 'старое');
  const notReports = await by('workspace_copy').run({ from: 'a.md', to: 'b.md', overwrite: true });
  assert.equal(notReports.ok, false);
  assert.equal(notReports.summary, 'перезаписывать можно только в reports');
  write('reports/c.md', 'был');
  const ok = await by('workspace_copy').run({ from: 'a.md', to: 'reports/c.md', overwrite: true });
  assert.equal(ok.ok, true, ok.summary);
  assert.equal(fs.readFileSync(path.join(root, 'reports', 'c.md'), 'utf8'), 'новое');
});

test('тип файла при переносе не меняется; rag и точечные файлы не трогаем; выход за папку — единая ошибка', async (t) => {
  const { by, write, exists } = setup(t);
  write('x.md', 'текст');
  write('прог.exe', 'bin');
  assert.equal((await by('workspace_move').run({ from: 'x.md', to: 'x.exe' })).ok, false, 'md в exe нельзя');
  assert.equal((await by('workspace_move').run({ from: 'прог.exe', to: 'прог2.exe' })).ok, true, 'exe в exe можно');
  write('rag/index.json', '{}');
  write('.секрет.md', 's');
  for (const from of ['rag/index.json', '.секрет.md']) {
    const res = await by('workspace_move').run({ from, to: 'куда.md' });
    assert.equal(res.ok, false, from);
    assert.equal(exists(from), true, `${from} на месте`);
  }
  assert.equal((await by('workspace_move').run({ from: 'x.md', to: '.скрытый.md' })).ok, false);
  assert.equal((await by('workspace_move').run({ from: 'x.md', to: 'rag/x.md' })).ok, false);
  const out = await by('workspace_move').run({ from: 'x.md', to: '../наружу.md' });
  assert.equal(out.ok, false);
  assert.equal(out.summary, 'путь вне рабочей папки');
  assert.equal(exists('x.md'), true);
});

test('папка: создаётся вместе с родительскими, существующая — не ошибка, файл — ошибка, rag закрыт', async (t) => {
  const { by, write, exists } = setup(t);
  const made = await by('workspace_mkdir').run({ path: 'отчёты/2026/ноябрь' });
  assert.equal(made.ok, true, made.summary);
  assert.equal(made.data.created, true);
  const again = await by('workspace_mkdir').run({ path: 'отчёты/2026' });
  assert.equal(again.ok, true);
  assert.equal(again.data.created, false);
  write('файл.md', 'x');
  assert.equal((await by('workspace_mkdir').run({ path: 'файл.md' })).ok, false);
  assert.equal((await by('workspace_mkdir').run({ path: 'rag/новая' })).ok, false);
  assert.equal(exists('rag/новая'), false);
  assert.equal((await by('workspace_mkdir').run({ path: '../наружу' })).ok, false);
});

test('фон: в полном доступе файловые инструменты (включая документы) берутся от своего индекса', (t) => {
  const { root, index } = setup(t);
  index.unrestricted = true;
  const shared = [...workspaceTools(index), ...documentTools(index, {}), ...projectTools(index)];
  const own = [...workspaceTools(new WorkspaceIndex(root)), ...documentTools(new WorkspaceIndex(root), {}), ...projectTools(new WorkspaceIndex(root))];
  const bg = withOwnWorkspace(shared, own);
  const names = bg.map((x) => x.name);
  assert.equal(names.filter((n) => n === 'workspace_move').length, 1, 'не дублируется');
  assert.equal(names.filter((n) => n === 'document_write').length, 1);
  assert.equal(names.filter((n) => n === 'project_brief').length, 1, 'разбор проекта тоже не дублируется');
  assert.equal(bg.find((x) => x.name === 'workspace_move'), own.find((x) => x.name === 'workspace_move'));
  assert.equal(bg.find((x) => x.name === 'document_write'), own.find((x) => x.name === 'document_write'));
  assert.equal(bg.find((x) => x.name === 'project_brief'), own.find((x) => x.name === 'project_brief'), 'разбор проекта в фоне — от песочного индекса');
});

test('инструменты кода чата не наследуются фоновыми задачами вместо их собственных', () => {
  const shared = [{ name: 'code_edit' }, { name: 'code_test' }, { name: 'web_search' }];
  const own = [{ name: 'workspace_read' }];
  assert.deepEqual(withOwnWorkspace(shared, own).map((tool) => tool.name), ['web_search', 'workspace_read']);
});

test('исполнитель выбирает собственный инструмент кода, а не одноимённый инструмент чата', () => {
  const { taskRegistryFor } = require('../src/tools/profiles');
  const chatCode = { name: 'code_edit', from: 'chat' };
  const taskCode = { name: 'code_edit', from: 'task' };
  const shared = { list: () => [chatCode, { name: 'code_write' }, { name: 'web_search' }], get: (name) => shared.list().find((item) => item.name === name) };
  const registry = taskRegistryFor(shared, [], [taskCode]);
  assert.equal(registry.get('code_edit'), taskCode);
  assert.equal(registry.get('code_write'), null);
  assert.equal(registry.get('web_search').name, 'web_search');
  assert.deepEqual(registry.list().map((item) => item.name), ['web_search', 'code_edit']);
});

test('инструмент кода исполнителя не выходит за папку мандата даже при доступном инструменте чата', async (t) => {
  const { root } = setup(t);
  const { codeTools, chatCodeTools } = require('../src/tools/code');
  const { taskRegistryFor } = require('../src/tools/profiles');
  fs.mkdirSync(path.join(root, 'allowed'));
  fs.mkdirSync(path.join(root, 'other'));
  fs.writeFileSync(path.join(root, 'other', 'app.js'), 'const n = 1;');
  const chat = chatCodeTools({ root });
  const shared = { list: () => chat, get: (name) => chat.find((tool) => tool.name === name) };
  const task = codeTools({ base: root, roots: [path.join(root, 'allowed')] });
  const registry = taskRegistryFor(shared, [], task);
  const out = await registry.get('code_edit').run({ path: 'other/app.js', old_string: 'n = 1', new_string: 'n = 2' });
  assert.equal(out.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'other', 'app.js'), 'utf8'), 'const n = 1;');
});

test('политика: в авто перенос и копия разрешаются, только если оба пути внутри папки', (t) => {
  const { root } = setup(t);
  const base = { mode: 'auto', risk: 'T1', workspace: root, hasPathParam: true };
  assert.equal(decide({ ...base, name: 'workspace_move', args: { from: 'a.md', to: 'b/c.md' } }), 'allow');
  assert.equal(decide({ ...base, name: 'workspace_copy', args: { from: 'a.md', to: '../наружу.md' } }), 'ask', 'назначение вне папки');
  assert.equal(decide({ ...base, name: 'workspace_move', args: { from: '../чужой.md', to: 'b.md' } }), 'ask', 'источник вне папки');
  assert.equal(decide({ ...base, name: 'workspace_move', args: { from: 'a.md' } }), 'ask', 'без назначения — спросить');
  assert.equal(decide({ ...base, name: 'workspace_mkdir', args: { path: 'новая' } }), 'allow');
  assert.equal(decide({ ...base, name: 'document_write', args: { path: 'отчёт.docx', format: 'docx' } }), 'allow');
  assert.equal(decide({ ...base, name: 'document_write', args: { path: 'C:/Windows/x.docx', format: 'docx' } }), 'ask');
});

test('мандат: документы проверяются по путям папки так же, как workspace_*', (t) => {
  const { root, index } = setup(t);
  const mandate = { tools: ['document_read', 'document_write'], folders: [root], root, expiresAt: Date.now() + 60000 };
  const resolve = (raw) => index.resolveInside(raw);
  assert.equal(checkTool(mandate, { name: 'document_write', args: { path: 'отчёт.docx', format: 'docx' }, resolve }).ok, true);
  assert.equal(checkTool(mandate, { name: 'document_read', args: { path: '../чужой.docx' }, resolve }).ok, false);
  assert.equal(checkTool(mandate, { name: 'document_write', args: { path: '../чужой.docx', format: 'docx' }, resolve }).ok, false);
});

// ---- Безопасная отмена действий: копия перед перезаписью и восстановление.

test('перезапись в reports снимает резервную копию, создание файла — нет', async (t) => {
  const { by, write, root } = setup(t);
  const writeTool = by('workspace_write');
  write('reports/r.md', 'прежняя версия');
  const again = await writeTool.run({ path: 'reports/r.md', content: 'новая версия' });
  assert.equal(again.ok, true);
  assert.match(again.data.backup, /^backups\/.*\.bak$/, 'копия создана и названа');
  assert.equal(fs.readFileSync(path.join(root, again.data.backup), 'utf8'), 'прежняя версия', 'в копии прежнее содержимое');
  assert.equal(fs.readFileSync(path.join(root, 'reports/r.md'), 'utf8'), 'новая версия');

  const fresh = await writeTool.run({ path: 'reports/new.md', content: 'первый раз' });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.data.backup, null, 'новому файлу копия не нужна');
  assert.equal(fs.existsSync(path.join(root, 'backups')), true);
  assert.equal(fs.readdirSync(path.join(root, 'backups')).length, 1, 'одна копия, за созданием не появилось');
});

test('перезапись вне reports по-прежнему запрещена, даже с копией', async (t) => {
  const { by, write, root } = setup(t);
  write('notes/old.md', 'старое');
  const res = await by('workspace_write').run({ path: 'notes/old.md', content: 'новое' });
  assert.equal(res.ok, false);
  assert.match(res.summary, /перезаписывать можно только в reports/);
  assert.equal(fs.existsSync(path.join(root, 'notes/old.md')), true);
  assert.equal(fs.readFileSync(path.join(root, 'notes/old.md'), 'utf8'), 'старое', 'файл не тронут');
});

test('восстановление: список копий, прежнее содержимое и подтверждение проверкой', async (t) => {
  const { by, write, root } = setup(t);
  const writeTool = by('workspace_write');
  const restore = by('workspace_restore');
  write('reports/r.md', 'версия 1');
  const w2 = await writeTool.run({ path: 'reports/r.md', content: 'версия 2' });
  const w3 = await writeTool.run({ path: 'reports/r.md', content: 'версия 3' });

  const list = await restore.run({ path: 'reports/r.md', list: true });
  assert.equal(list.ok, true);
  assert.equal(list.data.copies.length, 2, 'две копии: версия 1 и версия 2');
  assert.deepEqual(list.data.copies.map((c) => c.backup), [w3.data.backup, w2.data.backup], 'от новых к старым');

  const back = await restore.run({ path: 'reports/r.md', backup: w3.data.backup });
  assert.equal(back.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'reports/r.md'), 'utf8'), 'версия 2', 'вернулась вторая версия');
  const checked = await restore.verify({ path: 'reports/r.md', backup: w3.data.backup }, back);
  assert.equal(checked.status, 'confirmed');

  const noBackup = await restore.run({ path: 'reports/r.md' });
  assert.equal(noBackup.ok, false);
  assert.match(noBackup.summary, /укажите backup/);
  assert.match(noBackup.summary, /backups\//, 'подсказка перечисляет доступные копии');
});

test('восстановление: копия вне backups и не .bak отклоняется', async (t) => {
  const { by, write } = setup(t);
  write('reports/r.md', 'v1');
  await by('workspace_write').run({ path: 'reports/r.md', content: 'v2' });
  const restore = by('workspace_restore');
  const outside = await restore.run({ path: 'reports/r.md', backup: 'reports/r.md' });
  assert.equal(outside.ok, false);
  assert.match(outside.summary, /backups/);
  const traversal = await restore.run({ path: 'reports/r.md', backup: 'backups/../../secret.bak' });
  assert.equal(traversal.ok, false);
  assert.match(traversal.summary, /backups/);
  assert.equal(fs.existsSync('secret.bak'), false);
});

test('старые копии подчищаются: на один файл не больше 20 копий', async (t) => {
  const { by, write, root } = setup(t);
  write('reports/r.md', '0');
  for (let i = 1; i <= 55; i += 1) {
    const res = await by('workspace_write').run({ path: 'reports/r.md', content: `версия ${i}` });
    assert.equal(res.ok, true);
  }
  const files = fs.readdirSync(path.join(root, 'backups')).filter((f) => f.endsWith('.bak'));
  assert.equal(files.length, 20, 'на один файл держим не больше 20 копий');
  const list = await by('workspace_restore').run({ path: 'reports/r.md', list: true });
  assert.equal(list.data.copies.length, 10, 'в списке не больше десяти копий');
  assert.match(list.data.copies[0].backup, /^backups\/.*\.bak$/);
});

test('подчистка копий не стирает единственную копию другого файла', async (t) => {
  const { by, write, root } = setup(t);
  write('reports/hot.md', '0');
  write('reports/rare.md', 'редкая версия');
  await by('workspace_write').run({ path: 'reports/rare.md', content: 'новое' });
  for (let i = 1; i <= 60; i += 1) {
    await by('workspace_write').run({ path: 'reports/hot.md', content: `версия ${i}` });
  }
  const names = fs.readdirSync(path.join(root, 'backups')).filter((f) => f.endsWith('.bak'));
  assert.ok(names.length <= 50, `всего копий не больше 50, а не ${names.length}`);
  const rare = await by('workspace_restore').run({ path: 'reports/rare.md', list: true });
  assert.equal(rare.ok, true, 'копия редкого файла осталась');
  assert.equal(rare.data.copies.length, 1);
  const back = await by('workspace_restore').run({ path: 'reports/rare.md', backup: rare.data.copies[0].backup });
  assert.equal(back.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'reports/rare.md'), 'utf8'), 'редкая версия');
});

test('восстановление: чужой файл не подменяется копией другого файла', async (t) => {
  const { by, write, root } = setup(t);
  write('reports/a.md', 'версия A1');
  await by('workspace_write').run({ path: 'reports/a.md', content: 'версия A2' });
  write('reports/b.md', 'версия B1');
  await by('workspace_write').run({ path: 'reports/b.md', content: 'версия B2' });
  const listA = await by('workspace_restore').run({ path: 'reports/a.md', list: true });
  const other = await by('workspace_restore').run({ path: 'reports/b.md', backup: listA.data.copies[0].backup });
  assert.equal(other.ok, false);
  assert.match(other.summary, /другого файла/);
  assert.equal(fs.readFileSync(path.join(root, 'reports/b.md'), 'utf8'), 'версия B2', 'файл не тронут');
});

test('восстановление сохраняет текущую версию: само восстановление можно отменить', async (t) => {
  const { by, write, root } = setup(t);
  write('reports/r.md', 'версия 1');
  await by('workspace_write').run({ path: 'reports/r.md', content: 'версия 2' });
  const list1 = await by('workspace_restore').run({ path: 'reports/r.md', list: true });
  const back = await by('workspace_restore').run({ path: 'reports/r.md', backup: list1.data.copies[0].backup });
  assert.equal(back.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'reports/r.md'), 'utf8'), 'версия 1');
  // Текущая версия «версия 2» тоже стала копией — её видно в списке и можно вернуть.
  const list2 = await by('workspace_restore').run({ path: 'reports/r.md', list: true });
  assert.ok(list2.data.copies.length >= 2, 'появилась копия текущей версии');
  const undo = await by('workspace_restore').run({ path: 'reports/r.md', backup: list2.data.copies[0].backup });
  assert.equal(undo.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'reports/r.md'), 'utf8'), 'версия 2', 'восстановление отменяется');
});

test('восстановление: копия-ссылка не читается', async (t) => {
  const { by, write, root } = setup(t);
  write('reports/r.md', 'версия 1');
  await by('workspace_write').run({ path: 'reports/r.md', content: 'версия 2' });
  const list = await by('workspace_restore').run({ path: 'reports/r.md', list: true });
  const name = path.basename(list.data.copies[0].backup);
  const dir = path.join(root, 'backups');
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-outside-')), 'outside.bak');
  fs.writeFileSync(outside, 'чужие данные');
  fs.rmSync(path.join(dir, name));
  let linked = true;
  try {
    fs.symlinkSync(outside, path.join(dir, name), 'file');
  } catch {
    linked = false;
  }
  if (!linked) return t.skip('ссылки на этой машине не создаются');
  const res = await by('workspace_restore').run({ path: 'reports/r.md', backup: `backups/${name}` });
  assert.equal(res.ok, false);
  assert.match(res.summary, /обычный файл|пределы/);
});

test('запись файла больше 8 МБ отменяется без копии и без изменения файла', async (t) => {
  const { by, write, root } = setup(t);
  const big = 'x'.repeat(8 * 1024 * 1024 + 1);
  write('reports/big.md', big);
  const res = await by('workspace_write').run({ path: 'reports/big.md', content: 'маленькая версия' });
  assert.equal(res.ok, false);
  assert.match(res.summary, /8 МБ/);
  assert.equal(fs.readFileSync(path.join(root, 'reports/big.md'), 'utf8').length, big.length, 'файл не тронут');
  assert.equal(fs.existsSync(path.join(root, 'backups')) ? fs.readdirSync(path.join(root, 'backups')).filter((f) => f.endsWith('.bak')).length : 0, 0, 'копий нет');
});

test('папка backups не показывается в списке рабочей папки', async (t) => {
  const { by, write } = setup(t);
  write('reports/r.md', 'версия 1');
  await by('workspace_write').run({ path: 'reports/r.md', content: 'версия 2' });
  const list = await by('workspace_list').run({});
  assert.equal(list.ok, true);
  assert.equal(list.data.items.some((item) => item.name === 'backups'), false, 'папка копий скрыта');
  assert.equal(list.data.items.some((item) => item.name === 'reports'), true, 'остальные папки на месте');
});

test('папка backups-ссылка наружу: запись отменяется, наружу ничего не пишется', async (t) => {
  const { by, write, root } = setup(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-backups-link-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try {
    fs.symlinkSync(outside, path.join(root, 'backups'), 'junction');
  } catch {
    return t.skip('junction на этой машине не создаётся');
  }
  write('reports/r.md', 'версия 1');
  const res = await by('workspace_write').run({ path: 'reports/r.md', content: 'версия 2' });
  assert.equal(res.ok, false, 'перезапись через ссылку не проходит');
  assert.match(res.summary, /backups/);
  assert.equal(fs.readdirSync(outside).length, 0, 'за пределы рабочей папки копия не попала');
});

test('перенос и копия с overwrite сохраняют заменяемый файл в backups, копию можно вернуть', async (t) => {
  const { by, write, root } = setup(t);
  const move = by('workspace_move');
  const copy = by('workspace_copy');

  write('reports/отчёт.md', 'прежний отчёт');
  write('новый.md', 'новое для отчёта');
  const copied = await copy.run({ from: 'новый.md', to: 'reports/отчёт.md', overwrite: true });
  assert.equal(copied.ok, true, copied.summary);
  assert.match(copied.data.backup, /^backups\/.*\.bak$/, 'копия прежнего отчёта создана');
  assert.equal(fs.readFileSync(path.join(root, copied.data.backup), 'utf8'), 'прежний отчёт');
  assert.equal(fs.readFileSync(path.join(root, 'reports/отчёт.md'), 'utf8'), 'новое для отчёта');

  write('reports/перенос.md', 'старый перенос');
  write('источник.md', 'новый перенос');
  const moved = await move.run({ from: 'источник.md', to: 'reports/перенос.md', overwrite: true });
  assert.equal(moved.ok, true, moved.summary);
  assert.match(moved.data.backup, /^backups\/.*\.bak$/, 'копия заменяемого файла при переносе есть');
  assert.equal(fs.readFileSync(path.join(root, moved.data.backup), 'utf8'), 'старый перенос');
  assert.equal(fs.readFileSync(path.join(root, 'reports/перенос.md'), 'utf8'), 'новый перенос');
  assert.equal(fs.existsSync(path.join(root, 'источник.md')), false, 'перенос убрал источник');

  // Копия замены видна в списке восстановления: отмену обещает описание инструмента.
  const listed = await by('workspace_restore').run({ path: 'reports/перенос.md', list: true });
  assert.equal(listed.ok, true, listed.summary);
  assert.ok(listed.data.copies.some((copy) => copy.backup === moved.data.backup), 'копия замены в списке');
  const restored = await by('workspace_restore').run({ path: 'reports/перенос.md', backup: moved.data.backup });
  assert.equal(restored.ok, true, restored.summary);
  assert.equal(fs.readFileSync(path.join(root, 'reports/перенос.md'), 'utf8'), 'старый перенос', 'прежняя версия возвращается');
});

test('копию заменяемого файла снять нельзя — перенос и копия отменяются, файл не меняется', async (t) => {
  const { by, write, root } = setup(t);
  const big = 'x'.repeat(8 * 1024 * 1024 + 1);
  write('reports/большой.md', big);
  write('новый.md', 'новое');
  for (const name of ['workspace_move', 'workspace_copy']) {
    const res = await by(name).run({ from: 'новый.md', to: 'reports/большой.md', overwrite: true });
    assert.equal(res.ok, false, name);
    assert.match(res.summary, /8 МБ/, name);
    assert.equal(fs.readFileSync(path.join(root, 'reports/большой.md'), 'utf8').length, big.length, `${name}: файл не тронут`);
    assert.equal(fs.existsSync(path.join(root, 'новый.md')), true, `${name}: источник на месте`);
  }
});

test('копии с суффиксом коллизии `__ключ-1.bak` видны в списке и восстанавливаются', async (t) => {
  const { by, write, root } = setup(t);
  const { saveBackup } = require('../src/tools/workspace');
  write('reports/коллизия.md', 'версия 1');
  const abs = path.join(root, 'reports', 'коллизия.md');
  // Одно и то же время: saveBackup не затирает копию, а добавляет счётчик коллизии.
  const at = new Date(2026, 0, 2, 3, 4, 5, 678);
  const first = saveBackup(root, abs, at);
  const second = saveBackup(root, abs, at);
  assert.match(first.rel, /\.bak$/);
  assert.match(second.rel, /-1\.bak$/, 'второй файл одного времени получил суффикс');
  fs.writeFileSync(abs, 'версия 2', 'utf8');
  const list = await by('workspace_restore').run({ path: 'reports/коллизия.md', list: true });
  assert.equal(list.ok, true, list.summary);
  assert.deepEqual(list.data.copies.map((c) => c.backup), [second.rel, first.rel], 'обе копии, от новой к старой');
  const back = await by('workspace_restore').run({ path: 'reports/коллизия.md', backup: first.rel });
  assert.equal(back.ok, true, back.summary);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'версия 1', 'копия с суффиксом и базовая восстанавливаются');
});
