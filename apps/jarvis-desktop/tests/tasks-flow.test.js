'use strict';

// P1: завершение задачи и связь с подтверждениями.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskQueue } = require('../src/tasks/queue');
const { taskTools } = require('../src/tasks/tools');
const { requestedApproval, resolvedApproval } = require('../src/tasks/link');
const { readTasks, writeTasks } = require('../src/tasks/store');
const { recoverAfterRestart } = require('../src/tasks/queue');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');
const { checkEffect } = require('../src/agent/effects');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-flow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t) {
  const dir = tmp(t);
  const q = new TaskQueue({});
  const tools = taskTools({ queue: q, save: () => {}, resolve: (rel) => path.resolve(dir, rel) });
  const call = (name, args) => tools.find((x) => x.name === name).run(args);
  return { dir, q, call };
}

test('поиск незавершённых дел показывает свежие первыми и время изменения', async () => {
  const q = new TaskQueue({ tasks: [
    { id: 'old', title: 'Старое', status: 'paused', plan: [], updatedAt: 10 },
    { id: 'done', title: 'Готово', status: 'done', plan: [], updatedAt: 30 },
    { id: 'new', title: 'Новое', status: 'blocked', plan: [], updatedAt: 20 },
    { id: 'unknown', title: 'Без даты', status: 'draft', plan: [] },
    { id: 'unverified', title: 'Без проверки', status: 'unverified', plan: [], updatedAt: 40 },
  ] });
  const list = taskTools({ queue: q, save: () => {}, resolve: (p) => p }).find((tool) => tool.name === 'task_list');
  const result = await list.run({ unfinished: true });
  assert.deepEqual(result.data.tasks.map((task) => task.id), ['new', 'old', 'unknown']);
  assert.equal(result.data.tasks[0].updatedAt, 20);
  assert.equal(result.data.tasks[2].updatedAt, null);
  assert.equal((await list.run({ unfinished: 'yes' })).ok, false);
});

test('список задач сохраняет цель и результат проверки для продолжения работы', async (t) => {
  const { dir, call } = setup(t);
  const { data } = await call('task_create', { title: 'Отчёт', goal: 'Подготовить отчёт в файле' });
  const id = data.id;
  await call('task_plan', { id, steps: [
    { title: 'Создать файл', check: { kind: 'file_exists', path: 'report.md' } },
    { title: 'Проверить содержание', check: { kind: 'file_contains', path: 'report.md', text: 'Итог' } },
  ] });
  await call('task_enqueue', { id });
  await call('task_start', { id });
  fs.writeFileSync(path.join(dir, 'report.md'), 'Черновик');
  await call('task_verify', { id, step_id: 's1' });
  await call('task_verify', { id, step_id: 's2' });
  const task = (await call('task_list')).data.tasks.find((item) => item.id === id);
  assert.equal(task.goal, 'Подготовить отчёт в файле');
  assert.equal(task.plan[0].status, 'done');
  assert.match(task.plan[0].summary, /report\.md/);
  assert.equal(task.plan[1].status, 'failed');
  assert.match(task.plan[1].summary, /report\.md/);
});

test('после перезапуска можно получить отдельную задачу с проверкой и незавершённым шагом', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'tasks.json');
  const resolve = (rel) => path.resolve(dir, rel);
  const q = new TaskQueue({});
  const call = (queue, name, args) => taskTools({ queue, save: (items) => writeTasks(file, items), resolve })
    .find((tool) => tool.name === name).run(args);
  const id = (await call(q, 'task_create', { title: 'Дело', goal: 'Подготовить отчёт' })).data.id;
  await call(q, 'task_plan', { id, steps: [{ title: 'Создать', check: { kind: 'file_exists', path: 'report.md' } }, { title: 'Проверить итог', check: { kind: 'file_contains', path: 'report.md', text: 'Итог' } }] });
  await call(q, 'task_enqueue', { id });
  await call(q, 'task_start', { id });
  fs.writeFileSync(resolve('report.md'), 'Черновик');
  await call(q, 'task_verify', { id, step_id: 's1' });
  const restarted = new TaskQueue({ tasks: recoverAfterRestart(readTasks(file)) });
  const response = await call(restarted, 'task_list', { id });
  assert.equal(response.ok, true);
  assert.equal(response.data.tasks.length, 1);
  const task = response.data.tasks[0];
  assert.equal(task.status, 'paused');
  assert.equal(task.goal, 'Подготовить отчёт');
  assert.equal(task.plan[0].status, 'done');
  assert.match(task.plan[0].summary, /report\.md/);
  assert.deepEqual(task.plan[1].check, { kind: 'file_contains', path: 'report.md', text: 'Итог' });
  assert.equal(task.plan[1].status, 'todo');
  assert.equal((await call(restarted, 'task_list', { id: 'missing' })).ok, false);
});

test('заметки к делу сохраняются после перезапуска и повтор не создаёт дубликат', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'tasks.json');
  const resolve = (rel) => path.resolve(dir, rel);
  const q = new TaskQueue({});
  const tools = taskTools({ queue: q, save: (items) => writeTasks(file, items), load: () => readTasks(file), resolve });
  const by = (name) => tools.find((tool) => tool.name === name);
  const id = (await by('task_create').run({ title: 'Отчёт', goal: 'Собрать отчёт' })).data.id;
  const note = by('task_note');
  const args = { id, kind: 'next', text: 'Проверить таблицу перед отправкой' };
  const first = await note.run(args);
  assert.equal(first.ok, true);
  assert.equal((await note.verify(args, first)).status, 'confirmed');
  assert.equal((await note.run(args)).ok, true);
  const restarted = new TaskQueue({ tasks: readTasks(file) });
  const list = taskTools({ queue: restarted, save: () => {}, resolve }).find((tool) => tool.name === 'task_list');
  const task = (await list.run({ id })).data.tasks[0];
  assert.equal(task.notes.length, 1);
  assert.equal(task.notes[0].text, args.text);
  assert.equal(task.notes[0].kind, 'next');
  assert.equal((await note.run({ id, kind: 'bad', text: 'x' })).ok, false);
  assert.equal((await note.run({ id: 'missing', kind: 'next', text: 'x' })).ok, false);
});

test('задача и заметка пишутся на диск одним сохранением', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'tasks.json');
  let saves = 0;
  const queue = new TaskQueue({});
  const tools = taskTools({ queue, save: (items) => { saves += 1; writeTasks(file, items); }, load: () => readTasks(file), resolve: (rel) => path.resolve(dir, rel) });
  const by = (name) => tools.find((tool) => tool.name === name);
  const created = await by('task_create').run({ title: 'Дело', goal: 'Цель' });
  assert.equal(created.ok, true);
  assert.equal(saves, 1, 'создание задачи — одно сохранение');
  assert.deepEqual(readTasks(file).map((item) => item.id), [created.data.id]);
  const noted = await by('task_note').run({ id: created.data.id, kind: 'next', text: 'Проверить таблицу' });
  assert.equal(noted.ok, true);
  assert.equal(saves, 2, 'заметка — одно сохранение');
  const saved = readTasks(file).find((item) => item.id === created.data.id);
  assert.equal(saved.notes.length, 1);
  assert.equal(saved.notes[0].text, 'Проверить таблицу');
});

test('создание задачи подтверждается перечитыванием сохранённой цели', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'tasks.json');
  const queue = new TaskQueue({});
  const create = taskTools({ queue, save: (items) => writeTasks(file, items), load: () => readTasks(file), resolve: (p) => p })
    .find((tool) => tool.name === 'task_create');
  const args = { title: 'Тестовое дело', goal: 'Подготовить отчёт' };
  const out = await create.run(args);
  assert.equal((await checkEffect(create, args, out, {})).verified, 'confirmed');
  const saved = readTasks(file);
  saved[0].goal = 'другая цель';
  writeTasks(file, saved);
  assert.equal((await checkEffect(create, args, out, {})).verified, 'failed');
});

test('если задача не записана на диск, она не остаётся только в очереди', async (t) => {
  const queue = new TaskQueue({});
  const create = taskTools({ queue, save: () => { throw new Error('диск недоступен'); }, resolve: (p) => p })
    .find((tool) => tool.name === 'task_create');
  const out = await create.run({ title: 'Дело' });
  assert.equal(out.ok, false);
  assert.equal(queue.list().length, 0);
});

test('ошибка сохранения не оставляет запись только в памяти', async (t) => {
  const { q } = setup(t);
  const model = require('../src/tasks/model');
  q.add(model.createTask({ id: 't1', title: 'Дело' }));
  const note = taskTools({ queue: q, save: () => { throw new Error('диск недоступен'); }, resolve: (p) => p })
    .find((tool) => tool.name === 'task_note');
  const out = await note.run({ id: 't1', kind: 'decision', text: 'Новая запись' });
  assert.equal(out.ok, false);
  assert.equal(q.get('t1').notes, undefined);
});

test('дело с переносом файла: проверка результата и заметка доступны после перезапуска', async (t) => {
  const dir = tmp(t);
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'report.txt'), 'Отчёт: готовый черновик');
  const file = path.join(dir, 'tasks.json');
  const index = new WorkspaceIndex(workspace);
  const resolve = (rel) => index.resolveInside(rel);
  const q = new TaskQueue({});
  const tools = taskTools({ queue: q, save: (items) => writeTasks(file, items), load: () => readTasks(file), resolve });
  const by = (name) => tools.find((item) => item.name === name);
  const id = (await by('task_create').run({ title: 'Разобрать отчёт', goal: 'Перенести отчёт в архив' })).data.id;
  await by('task_plan').run({ id, steps: [{ title: 'Перенести отчёт', check: { kind: 'file_exists', path: 'archive/report.txt' } }] });
  await by('task_enqueue').run({ id });
  await by('task_start').run({ id });
  const move = workspaceTools(index).find((item) => item.name === 'workspace_move');
  const args = { from: 'report.txt', to: 'archive/report.txt' };
  const moved = await checkEffect(move, args, await move.run(args), {});
  assert.equal(moved.verified, 'confirmed');
  const outcome = await by('task_verify').run({ id, step_id: 's1' });
  assert.equal(outcome.ok, true);
  const note = by('task_note');
  const noteArgs = { id, kind: 'material', text: 'Архив: archive/report.txt' };
  const saved = await note.run(noteArgs);
  assert.equal((await note.verify(noteArgs, saved)).status, 'confirmed');
  const restarted = new TaskQueue({ tasks: readTasks(file) });
  const listed = taskTools({ queue: restarted, save: () => {}, resolve }).find((tool) => tool.name === 'task_list');
  const task = (await listed.run({ id })).data.tasks[0];
  assert.equal(task.status, 'done');
  assert.equal(task.notes[0].text, noteArgs.text);
  assert.equal(fs.existsSync(path.join(workspace, 'report.txt')), false);
  assert.equal(fs.readFileSync(path.join(workspace, 'archive/report.txt'), 'utf8'), 'Отчёт: готовый черновик');
});

test('задача завершается, когда все шаги с проверкой подтверждены', async (t) => {
  const { dir, q, call } = setup(t);
  const { data } = await call('task_create', { title: 'Файл' });
  const id = data.id;
  await call('task_plan', { id, steps: [{ title: 'первый', check: { kind: 'file_exists', path: 'a.md' } }, { title: 'второй', check: { kind: 'file_exists', path: 'b.md' } }] });
  await call('task_enqueue', { id });
  await call('task_start', { id });
  fs.writeFileSync(path.join(dir, 'a.md'), 'x');
  await call('task_verify', { id, step_id: 's1' });
  assert.equal(q.get(id).status, 'running', 'один шаг из двух — ещё в работе');
  fs.writeFileSync(path.join(dir, 'b.md'), 'y');
  const last = await call('task_verify', { id, step_id: 's2' });
  assert.equal(last.ok, true);
  assert.equal(q.get(id).status, 'done');
  assert.equal(q.running(), null, 'после завершения очередь свободна');
});

test('завершить задачу с невыполненным шагом нельзя', () => {
  const q = new TaskQueue({});
  q.add(require('../src/tasks/model').setPlan(require('../src/tasks/model').createTask({ id: 'x', title: 'X' }), [{ title: 'a' }]));
  q.enqueue('x');
  q.start('x');
  assert.throws(() => q.complete('x'), /не все шаги/);
});

test('статус «ждёт подтверждения» ставится на выполняющуюся задачу и снимается после ответа', () => {
  const model = require('../src/tasks/model');
  const q = new TaskQueue({});
  q.add(model.setPlan(model.createTask({ id: 'a', title: 'A' }), [{ title: 'шаг' }]));
  q.enqueue('a');
  q.start('a');
  assert.equal(requestedApproval(q), true);
  assert.equal(q.get('a').status, 'waiting_approval');
  assert.equal(model.humanStatus(q.get('a')), 'ждёт подтверждения');
  assert.equal(resolvedApproval(q), true);
  assert.equal(q.get('a').status, 'running');
});

test('подтверждение без выполняющейся задачи ничего не меняет', () => {
  const q = new TaskQueue({});
  assert.equal(requestedApproval(q), false);
  assert.equal(resolvedApproval(q), false);
});
