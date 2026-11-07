'use strict';

// P1: задачи — модель, план, статусы, очередь, проверка результата, инструменты, восстановление.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../src/tasks/model');
const { TaskQueue, recoverAfterRestart } = require('../src/tasks/queue');
const { verify, runCheck } = require('../src/tasks/verify');
const { taskTools } = require('../src/tasks/tools');
const { readTasks, writeTasks } = require('../src/tasks/store');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tasks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function planned(id, steps = [{ title: 'шаг' }], over = {}) {
  return model.setPlan(model.createTask({ id, title: `задача ${id}`, ...over }), steps);
}

test('статусы: допустимые переходы проходят, недопустимые — нет', () => {
  let t = model.createTask({ id: 'a', title: 'A' });
  assert.throws(() => model.transition(t, 'running'), /недопустим/);
  t = model.transition(t, 'queued');
  t = model.transition(t, 'running');
  t = model.transition(t, 'done');
  assert.throws(() => model.transition(t, 'running'), /недопустим/, 'done конечный');
});

test('план: нужны названия, id уникальны, до старта и не больше лимита', () => {
  const t = model.createTask({ id: 'a', title: 'A' });
  assert.throws(() => model.setPlan(t, []), /пустой/);
  assert.throws(() => model.setPlan(t, [{ title: '' }]), /без названия/);
  assert.throws(() => model.setPlan(t, [{ id: 'x', title: 'a' }, { id: 'x', title: 'b' }]), /уникальны/);
  assert.throws(() => model.setPlan(t, Array.from({ length: 101 }, (_, i) => ({ title: `s${i}` }))), /больше 100/);
  const running = model.transition(model.transition(planned('b'), 'queued'), 'running');
  assert.throws(() => model.setPlan(running, [{ title: 'новый' }]), /до старта/);
});

test('три неудачи подряд на одном шаге блокируют задачу, успех сбрасывает счётчик', () => {
  let t = model.transition(model.transition(planned('c', [{ id: 's1', title: 'шаг' }]), 'queued'), 'running');
  t = model.markStep(t, 's1', 'failed');
  t = model.markStep(t, 's1', 'failed');
  assert.equal(t.status, 'running', 'две неудачи — ещё работаем');
  t = model.markStep(t, 's1', 'done');
  assert.equal(t.failures.s1, undefined, 'успех сбрасывает счётчик');
  t = model.markStep(t, 's1', 'failed');
  t = model.markStep(t, 's1', 'failed');
  t = model.markStep(t, 's1', 'failed');
  assert.equal(t.status, 'blocked');
  assert.match(t.reason, /3 раза подряд/);
  assert.equal(model.humanStatus(t), 'заблокирована ошибкой');
});

test('лимит 4 часа активной работы ставит на паузу', () => {
  const t = model.transition(model.transition(planned('d'), 'queued'), 'running');
  const hour = 60 * 60 * 1000;
  const half = model.addActiveTime(t, 4 * hour - 1, { now: 1 });
  assert.equal(half.status, 'running');
  const over = model.addActiveTime(half, 2, { now: 2 });
  assert.equal(over.status, 'paused');
  assert.match(over.reason, /4 часа/);
});

test('очередь: одна задача за раз, приоритет и порядок создания', () => {
  let n = 0;
  const q = new TaskQueue({ now: () => (n += 1) });
  q.add(planned('low', [{ title: 'x' }], { priority: 0 }));
  q.add(planned('high', [{ title: 'x' }], { priority: 5 }));
  q.enqueue('low');
  q.enqueue('high');
  assert.equal(q.next().id, 'high', 'приоритетная первой');
  q.start('high');
  assert.throws(() => q.start('low'), /уже выполняется/);
  assert.equal(q.running().id, 'high');
});

test('аварийный стоп переводит выполняющуюся задачу на паузу и ничего не запускает', () => {
  const q = new TaskQueue({});
  q.add(planned('r'));
  q.add(planned('w'));
  q.enqueue('r');
  q.start('r');
  assert.deepEqual(q.stopAll(), ['r']);
  assert.equal(q.get('r').status, 'paused');
  assert.equal(q.get('r').reason, 'аварийный стоп');
  q.enqueue('w');
  assert.equal(q.next().id, 'w', 'после стопа очередь на месте, но сама ничего не стартует');
  assert.equal(q.running(), null);
});

test('после перезапуска выполнявшаяся задача на паузе и не продолжается сама', () => {
  let t = model.transition(model.transition(planned('p'), 'queued'), 'running');
  t = model.transition(t, 'waiting_approval');
  const [after] = recoverAfterRestart([t]);
  assert.equal(after.status, 'paused');
  assert.match(after.reason, /перезапуск/);
  const done = model.transition(model.transition(planned('q'), 'queued'), 'running');
  assert.equal(recoverAfterRestart([{ ...done, status: 'done' }])[0].status, 'done', 'завершённые не трогаем');
});

test('проверка: файл есть или нет, текст есть или нет, путь вне песочницы — не проверено', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'привет мир');
  const resolve = (rel) => {
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir)) throw new Error('путь вне рабочей папки');
    return abs;
  };
  assert.equal(runCheck({ kind: 'file_exists', path: 'a.md' }, { resolve }).status, 'confirmed');
  assert.equal(runCheck({ kind: 'file_exists', path: 'b.md' }, { resolve }).status, 'failed');
  assert.equal(runCheck({ kind: 'file_contains', path: 'a.md', text: 'мир' }, { resolve }).status, 'confirmed');
  assert.equal(runCheck({ kind: 'file_contains', path: 'a.md', text: 'нет такого' }, { resolve }).status, 'failed');
  assert.equal(runCheck({ kind: 'file_exists', path: '../outside.md' }, { resolve }).status, 'unknown');
  assert.equal(runCheck({ kind: 'make_it_so' }, { resolve }).status, 'unknown');
});

test('file_absent: файла нет — подтверждено (шаг «убедиться, что файла ещё нет»); есть — не подтверждено', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'папка'));
  fs.writeFileSync(path.join(dir, 'есть.md'), 'x');
  const resolve = (rel) => path.resolve(dir, rel);
  assert.equal(runCheck({ kind: 'file_absent', path: 'нет.md' }, { resolve }).status, 'confirmed');
  // Отсутствующая папка — тоже отсутствующий файл: целевая папка ещё не создана, это штатно.
  assert.equal(runCheck({ kind: 'file_absent', path: 'новая/calculator-plan.md' }, { resolve }).status, 'confirmed');
  assert.equal(runCheck({ kind: 'file_absent', path: 'есть.md' }, { resolve }).status, 'failed');
  assert.match(runCheck({ kind: 'file_absent', path: 'есть.md' }, { resolve }).evidence, /уже есть/);
  assert.equal(verify([{ kind: 'file_absent', path: 'нет.md' }], { resolve }).status, 'confirmed');
});

test('file_exists на папке: не «нет файла», а «папка, а не файл»', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'папка'));
  const resolve = (rel) => path.resolve(dir, rel);
  const outcome = runCheck({ kind: 'file_exists', path: 'папка' }, { resolve });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.evidence, 'по пути папка, а не файл: папка');
  assert.equal(runCheck({ kind: 'file_exists', path: 'пусто' }, { resolve }).evidence, 'нет файла: пусто');
});

test('проверка без проверок — «не проверено», а не «выполнено»', () => {
  const outcome = verify([], { resolve: (x) => x });
  assert.equal(outcome.status, 'unverified');
  assert.match(outcome.note, /не проверен/);
});

test('инструменты: модель не может сама отметить шаг с проверкой, проверка решает', async (t) => {
  const dir = tmp(t);
  const q = new TaskQueue({});
  const resolve = (rel) => path.resolve(dir, rel);
  const tools = taskTools({ queue: q, save: () => {}, resolve });
  const call = (name, args) => tools.find((x) => x.name === name).run(args);
  const created = await call('task_create', { title: 'Заметка' });
  const id = created.data.id;
  assert.equal((await call('task_plan', { id, steps: [{ title: 'файл', check: { kind: 'file_exists', path: 'n.md' } }] })).ok, true);
  assert.equal((await call('task_enqueue', { id })).ok, true);
  assert.equal((await call('task_start', { id })).ok, true);
  assert.match((await call('task_step', { id, step_id: 's1', status: 'done' })).summary, /только через task_verify/);
  assert.equal((await call('task_verify', { id, step_id: 's1' })).ok, false, 'файла нет — не выполнено');
  fs.writeFileSync(path.join(dir, 'n.md'), 'x');
  const after = await call('task_verify', { id, step_id: 's1' });
  assert.equal(after.ok, true);
  assert.equal(after.data.task.plan[0].status, 'done');
});

test('инструменты: план нельзя менять после старта, ошибки не роняют ход', async () => {
  const q = new TaskQueue({});
  const tools = taskTools({ queue: q, save: () => {}, resolve: (x) => x });
  const call = (name, args) => tools.find((x) => x.name === name).run(args);
  const created = await call('task_create', { title: 'T' });
  await call('task_plan', { id: created.data.id, steps: [{ title: 'a' }] });
  await call('task_enqueue', { id: created.data.id });
  await call('task_start', { id: created.data.id });
  const late = await call('task_plan', { id: created.data.id, steps: [{ title: 'b' }] });
  assert.equal(late.ok, false);
  assert.equal((await call('task_step', { id: 'нет такой', step_id: 's1', status: 'done' })).ok, false);
});

test('хранилище: запись атомарна, чтение возвращает то же, битый файл не теряется молча', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'tasks.json');
  assert.deepEqual(readTasks(file), []);
  writeTasks(file, [planned('s')]);
  assert.equal(readTasks(file)[0].id, 's');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'временных файлов не остаётся');
  fs.writeFileSync(file, '{битый');
  assert.throws(() => readTasks(file));
});

test('хранилище: файл без списка tasks повреждён — чтение бросает ошибку, а не пустой список', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'tasks.json');
  for (const body of ['{"version":1}', '{"tasks": 5}']) {
    fs.writeFileSync(file, body, 'utf8');
    assert.throws(() => readTasks(file), /нет списка tasks/, body);
  }
});

// numbered_steps: ровно count пронумерованных пунктов в разделе — по порядку, без шестого, без повторов.
test('numbered_steps: ровно пять пунктов 1–5 — подтверждено; четыре, шесть, дубликат и «5.» в постороннем тексте — нет', (t) => {
  const dir = tmp(t);
  const resolve = (rel) => path.resolve(dir, rel);
  const check = (body) => {
    fs.writeFileSync(path.join(dir, 'plan.md'), body, 'utf8');
    return runCheck({ kind: 'numbered_steps', path: 'plan.md', section: 'Этапы', count: 5 }, { resolve });
  };
  const items = (nums) => nums.map((n) => `${n}. Этап ${n}`).join('\n');
  const doc = (stepLines, extra = '') => `# План\n\n## Цель\n\nКалькулятор\n\n## Этапы разработки\n\n${stepLines}\n\n## Критерии готовности\n\n- тесты\n${extra}`;

  assert.equal(check(doc(items([1, 2, 3, 4, 5]))).status, 'confirmed');
  assert.match(check(doc(items([1, 2, 3, 4, 5]))).evidence, /ровно 5 пунктов: 1–5/);
  assert.equal(check(doc(items([1, 2, 3, 4]))).status, 'failed', 'четыре пункта');
  assert.equal(check(doc(items([1, 2, 3, 4, 5, 6]))).status, 'failed', 'шесть пунктов');
  assert.equal(check(doc(items([1, 2, 2, 3, 4]))).status, 'failed', 'дубликат номера');
  assert.match(check(doc(items([1, 2, 2, 3, 4]))).evidence, /пункты: 1, 2, 2, 3, 4/);
  assert.equal(check(doc(items([1, 2, 3, 3, 5, 6]))).status, 'failed', 'дубликат и лишний пункт');
  // «5.» в постороннем тексте вне раздела этапов не считается пунктом раздела.
  assert.equal(check(doc(items([1, 2, 3, 4]), '\n## Риски\n\n5. Срыв сроков\n')).status, 'failed', '5. в другом разделе');
  // Вложенный пункт с отступом — не верхний уровень раздела.
  assert.equal(check(doc(`${items([1, 2, 3, 4])}\n   5. вложенный`)).status, 'failed', 'вложенный пункт');
  // Нет раздела «Этапы» — проверка не угадывает.
  assert.match(check(`## Цель\n\n1. a\n2. b\n3. c\n4. d\n5. e\n`).evidence, /раздел «Этапы» не найден/);
  assert.equal(runCheck({ kind: 'numbered_steps', path: 'нет.md', section: 'Этапы', count: 5 }, { resolve }).status, 'failed');
  assert.equal(runCheck({ kind: 'numbered_steps', path: 'plan.md', section: '', count: 5 }, { resolve }).status, 'unknown');
  assert.equal(runCheck({ kind: 'numbered_steps', path: 'plan.md', section: 'Этапы', count: 0 }, { resolve }).status, 'unknown');
});
