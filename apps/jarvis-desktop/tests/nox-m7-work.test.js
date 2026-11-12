'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWork, updateWork, currentWorkCall } = require('../renderer/nox-screen');
const { TurnPlans } = require('../src/agent/plan');
const { planTools } = require('../src/tools/plan');

function run() {
  const work = createWork('test');
  const emit = (type, fields) => updateWork(work, { type, runId: 'test', ...fields });
  return { work, emit };
}

test('план показывается только после принятия ядром, отметка шага не становится доказательством', () => {
  const { work, emit } = run();
  const [set, done] = planTools(new TurnPlans());
  const steps = ['Собрать задачи', 'Сохранить сводку'];
  emit('tool_start', { id: 'bad', name: set.name, args: { steps: ['Не принято'] } });
  emit('tool_result', { id: 'bad', ok: false, status: 'failed' });
  assert.deepEqual(work.steps, []);
  emit('tool_start', { id: 'set', name: set.name, args: { steps } });
  assert.deepEqual(work.steps, []);
  emit('tool_result', { id: 'set', ok: set.run({ steps }, { runId: 'test' }).ok, status: 'succeeded' });
  assert.deepEqual(work.steps.map((step) => step.text), steps);
  const args = { step: 1, evidence: 'Модель сказала, что готово' };
  emit('tool_start', { id: 'done', name: done.name, args });
  emit('tool_result', { id: 'done', ok: done.run(args, { runId: 'test' }).ok, status: 'succeeded' });
  assert.deepEqual(work.steps.map((step) => step.done), [true, false]);
  assert.equal(work.evidence, null);
  emit('done', { status: 'succeeded' });
  assert.equal(work.phase, 'incomplete');
});

test('ожидание и проверка привязаны к вызову; итог соседнего вызова их не сбрасывает', () => {
  const { work, emit } = run();
  emit('tool_start', { id: 'a', name: 'workspace_write', step: 3 });
  emit('tool_start', { id: 'b', name: 'workspace_read', step: 4 });
  emit('status', { status: 'awaiting_approval', step: 3 });
  assert.equal(currentWorkCall(work).phase, 'awaiting_approval');
  assert.equal(currentWorkCall(work).step, 3);
  emit('tool_result', { id: 'b', status: 'succeeded', ok: true, summary: 'Файл прочитан' });
  assert.equal(currentWorkCall(work).phase, 'awaiting_approval');
  assert.equal(work.evidence, null);
  emit('status', { status: 'verifying', step: 3 });
  assert.equal(currentWorkCall(work).phase, 'verifying');
  emit('tool_result', { id: 'a', ok: true, verified: 'confirmed', evidence: 'Текст совпадает с записью' });
  emit('done', { status: 'succeeded' });
  assert.equal(currentWorkCall(work), undefined);
  assert.equal(work.phase, 'succeeded');
  assert.deepEqual(work.evidence, { name: 'workspace_write', text: 'Текст совпадает с записью' });
});

test('неизвестная проверка, ошибка и отсутствие статуса не выдают успех', () => {
  const unknown = run();
  unknown.emit('tool_start', { id: 'write', name: 'workspace_write' });
  unknown.emit('tool_result', { id: 'write', ok: true, verified: 'unknown', evidence: 'Файл не удалось перечитать' });
  unknown.emit('done', { status: 'succeeded' });
  assert.equal(unknown.work.phase, 'unverified');
  assert.equal(unknown.work.evidence, null);

  const failed = run();
  failed.emit('error', { message: 'Нет доступа' });
  failed.emit('done', {});
  assert.equal(failed.work.phase, 'failed');
  assert.equal(failed.work.issue, 'Нет доступа');

  const missing = run();
  missing.emit('done', {});
  assert.equal(missing.work.phase, 'unverified');
});

test('чужие и поздние события не меняют ход, а отмена остаётся окончательной', () => {
  const { work, emit } = run();
  assert.equal(emit('approval_request', { taskId: 'background' }), false);
  assert.equal(emit('done', { runId: 'other', status: 'succeeded' }), false);
  emit('tool_start', { id: 'write', name: 'workspace_write' });
  emit('done', { status: 'cancelled' });
  assert.equal(emit('tool_result', { id: 'write', afterStop: true, ok: true, verified: 'confirmed', evidence: 'Поздний итог' }), false);
  assert.equal(emit('status', { status: 'running' }), false);
  assert.equal(work.phase, 'cancelled');
  assert.equal(work.evidence, null);
});

test('возобновлённый план может прийти только числами: сохраняем их без выдуманных шагов', () => {
  const { work, emit } = run();
  emit('done', { status: 'succeeded', plan: { total: 4, done: 2, unfinished: 2 } });
  assert.deepEqual(work.summary, { total: 4, done: 2 });
  assert.deepEqual(work.steps, []);
  assert.equal(work.phase, 'incomplete');
});
