'use strict';

// Полоса «нужно внимание»: какие задачи показать, скрытие строки и открытие отчёта.
// Скрытие — только отображение: задача и её данные не меняются.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const attention = require('../src/tasks/attention');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'attention-'));
}

const task = (over) => ({ id: 'tmvv1', title: 'Задача', status: 'unverified', reason: '', updatedAt: 100, ...over });

test('показываем только задачи, которым нужно внимание', () => {
  const tasks = [
    task({ id: 'a1', status: 'done' }),
    task({ id: 'a2', status: 'running' }),
    task({ id: 'a3', status: 'blocked', reason: 'шаг не получился' }),
    task({ id: 'a4', status: 'unverified' }),
    task({ id: 'a5', status: 'cancelled' }),
  ];
  const rows = attention.attentionRows(tasks, {}, tmpDir());
  assert.deepEqual(rows.map((r) => r.id), ['a3', 'a4']);
  assert.equal(rows[0].reason, 'шаг не получился');
});

test('отчёт есть только если файл task-<id>.md существует в папке отчётов', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'task-a4.md'), '# отчёт');
  const rows = attention.attentionRows([task({ id: 'a4' }), task({ id: 'a3', status: 'blocked' })], {}, dir);
  assert.equal(rows[0].report, path.join(dir, 'task-a4.md'));
  assert.equal(rows[1].report, null);
});

test('отчёт для каждой строки берётся из её пространства', () => {
  const a = tmpDir();
  const b = tmpDir();
  fs.writeFileSync(path.join(a, 'task-a.md'), 'a');
  fs.writeFileSync(path.join(b, 'task-b.md'), 'b');
  const rows = attention.attentionRows([task({ id: 'a', workspaceId: 'a' }), task({ id: 'b', workspaceId: 'b' })], {},
    (item) => attention.reportPathFor(item.workspaceId === 'a' ? a : b, item.id));
  assert.deepEqual(rows.map((row) => row.report), [path.join(a, 'task-a.md'), path.join(b, 'task-b.md')]);
});

test('id с разделителями пути или точками не даёт путь к отчёту', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'task-x.md'), 'x');
  assert.equal(attention.reportPathFor(dir, '../x'), null);
  assert.equal(attention.reportPathFor(dir, 'x/../x'), null);
  assert.equal(attention.reportPathFor(dir, ''), null);
  assert.equal(attention.reportPathFor(dir, undefined), null);
  assert.equal(attention.isTaskId('tmvvbdz1p7fd80f'), true);
  assert.equal(attention.isTaskId('a b'), false);
});

test('скрытая строка не показывается, пока статус и время задачи прежние', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'attention-hidden.json');
  const t = task({ id: 'a4', status: 'unverified', updatedAt: 100 });
  attention.writeHidden(file, attention.withHidden(attention.readHidden(file), t));
  assert.deepEqual(attention.attentionRows([t], attention.readHidden(file), dir), []);
});

test('скрытие не возвращает строку при сбросе; новый статус или новое время — возвращают', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'attention-hidden.json');
  const t = task({ id: 'a4', status: 'unverified', updatedAt: 100 });
  attention.writeHidden(file, attention.withHidden({}, t));
  // Та же задача в том же состоянии — по-прежнему скрыта.
  assert.equal(attention.attentionRows([{ ...t }], attention.readHidden(file), dir).length, 0);
  // Задача снова выполнялась и попала в тот же статус с другим временем: строка возвращается.
  const later = { ...t, updatedAt: 200 };
  assert.equal(attention.attentionRows([later], attention.readHidden(file), dir).length, 1);
  // Другой статус: тоже возвращается.
  const blocked = { ...t, status: 'blocked' };
  assert.equal(attention.attentionRows([blocked], attention.readHidden(file), dir).length, 1);
});

test('скрытие не меняет данные задачи: входной объект и список не мутируются', () => {
  const t = task({ id: 'a4' });
  const before = JSON.stringify(t);
  const hidden = { other: { status: 'blocked', updatedAt: 1 } };
  const next = attention.withHidden(hidden, t);
  assert.equal(JSON.stringify(t), before);
  assert.deepEqual(hidden, { other: { status: 'blocked', updatedAt: 1 } });
  assert.deepEqual(next.a4, { status: 'unverified', updatedAt: 100 });
  assert.notEqual(next, hidden);
});

test('битый файл скрытых строк не теряет задачи: всё показывается', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'attention-hidden.json');
  fs.writeFileSync(file, '{ битый json');
  assert.deepEqual(attention.readHidden(file), {});
  assert.deepEqual(attention.readHidden(path.join(dir, 'нет-такого.json')), {});
  fs.writeFileSync(file, '[1,2]');
  assert.deepEqual(attention.readHidden(file), {});
  const rows = attention.attentionRows([task({ id: 'a4' })], attention.readHidden(file), dir);
  assert.equal(rows.length, 1);
});

test('запись скрытых строк атомарна: временного файла не остаётся', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'attention-hidden.json');
  attention.writeHidden(file, { a4: { status: 'unverified', updatedAt: 100 } });
  assert.deepEqual(attention.readHidden(file), { a4: { status: 'unverified', updatedAt: 100 } });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('строка несёт код и причину вердикта; без вердикта — null', () => {
  const dir = tmpDir();
  const rows = attention.attentionRows([
    task({ id: 'v1', verdict: { code: 'not_applicable', reason: 'задача только читала' } }),
    task({ id: 'v2' }),
  ], {}, dir);
  assert.deepEqual(rows[0].verdict, { code: 'not_applicable', reason: 'задача только читала' });
  assert.equal(rows[1].verdict, null);
});
