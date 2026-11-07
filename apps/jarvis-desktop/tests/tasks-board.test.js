'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boardRows, boardSummary, STATUS_WORDS, rowOf } = require('../src/tasks/board');

test('переводит все предусмотренные статусы и сохраняет неизвестный', () => {
  for (const [status, human] of Object.entries(STATUS_WORDS)) {
    assert.equal(rowOf({ status }).statusHuman, human);
  }
  assert.equal(rowOf({ status: 'custom' }).statusHuman, 'custom');
});

test('running и waiting_approval активны', () => {
  assert.equal(rowOf({ status: 'running' }).active, true);
  assert.equal(rowOf({ status: 'waiting_approval' }).active, true);
});

test('blocked, cancelled и причина незавершённой задачи отмечаются как ошибки', () => {
  assert.equal(rowOf({ status: 'blocked' }).error, true);
  assert.equal(rowOf({ status: 'cancelled' }).error, true);
  assert.equal(rowOf({ status: 'running', reason: 'сбой' }).error, true);
  assert.equal(rowOf({ status: 'paused', reason: 'жду' }).error, true);
});

test('сохраняет непустую причину, пустую нормализует в null', () => {
  assert.equal(rowOf({ reason: '  ошибка  ' }).reason, '  ошибка  ');
  assert.equal(rowOf({ reason: '  ' }).reason, null);
});

test('отчёт готов только для done или unverified с путём/отчётом', () => {
  assert.equal(rowOf({ status: 'done' }).reportReady, false);
  assert.equal(rowOf({ status: 'running', report: 'out.md' }).reportReady, false);
  assert.equal(rowOf({ status: 'done', report: 'out.md' }).reportReady, true);
  const fromAttention = rowOf({ id: 'a', status: 'unverified' }, { attention: [{ taskId: 'a', reportPath: 'report.md' }] });
  assert.equal(fromAttention.reportReady, true, 'путь из строк внимания тоже считается');
  assert.equal('reportPath' in fromAttention, false, 'путь отчёта в окно не отдаём: кнопка открывает отчёт по id');
});

test('сводка не считает повреждённые элементы', () => {
  const summary = boardSummary([null, 42, 'текст', { id: 'a', status: 'queued' }]);
  assert.equal(summary.total, 1);
  assert.equal(summary.queued, 1);
  assert.equal(boardSummary([null]).total, 0, 'битые строки не попадают в «всего»');
});

test('сортирует активные задачи первыми, далее ошибки, готовые и остальные', () => {
  const rows = boardRows([
    { id: 'other', status: 'queued', updatedAt: 100 },
    { id: 'ready', status: 'done', report: 'r.md', updatedAt: 1 },
    { id: 'error', status: 'blocked', updatedAt: 5 },
    { id: 'active-old', status: 'running', updatedAt: 2 },
    { id: 'active-new', status: 'waiting_approval', updatedAt: 8 },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ['active-new', 'active-old', 'error', 'ready', 'other']);
});

test('сводка считает категории и пустой список', () => {
  const rows = boardRows([
    { status: 'running' }, { status: 'queued' }, { status: 'blocked' },
    { status: 'done', report: 'r.md' },
  ]);
  assert.deepEqual(boardSummary(rows), {
    total: 4, working: 1, queued: 1, errors: 1, ready: 1,
    line: 'в работе 1, в очереди 1, ошибок 1, готово 1',
  });
  assert.equal(boardSummary([]).line, 'задач нет');
});

test('принимает некорректные коллекции и неизвестный статус без падения', () => {
  assert.deepEqual(boardRows(null), []);
  assert.equal(boardSummary(null).total, 0);
  assert.equal(rowOf(null).statusHuman, '');
});

test('не мутирует входные задачи или порядок исходного массива', () => {
  const tasks = [{ id: 'b', status: 'queued', updatedAt: 1 }, { id: 'a', status: 'running', updatedAt: 2 }];
  const before = structuredClone(tasks);
  boardRows(tasks);
  assert.deepEqual(tasks, before);
  assert.equal(tasks[0].id, 'b');
});

