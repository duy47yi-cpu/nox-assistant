'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GoalStore, MAX_ACTIVE, goalsBrief } = require('../src/goals/store');
const { goalTools } = require('../src/goals/tools');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-goals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new GoalStore(path.join(dir, 'goals.json'), { now: () => new Date('2026-11-05T10:00:00Z') });
}

describe('цели: хранилище', () => {
  test('создаёт цель с шагами и считает ход', (t) => {
    const store = tempStore(t);
    const goal = store.create({ title: 'Собрать отчёт', steps: ['найти данные', 'написать файл'], note: 'к пятнице' });
    assert.match(goal.id, /^[0-9a-f-]{36}$/);
    assert.equal(goal.status, 'active');
    assert.equal(goal.steps.length, 2);
    assert.deepEqual(store.progress(goal), { total: 2, done: 0, skipped: 0, failed: 0, left: 2 });
    assert.equal(store.list({ status: 'active' })[0].id, goal.id);
  });

  test('шаг done и failed требуют доказательство, skipped — нет', (t) => {
    const store = tempStore(t);
    const goal = store.create({ title: 'Проверка', steps: ['один', 'два'] });
    assert.throws(() => store.step(goal.id, { step: 1, status: 'done' }), /доказательство/);
    assert.throws(() => store.step(goal.id, { step: 1, status: 'failed' }), /доказательство/);
    store.step(goal.id, { step: 1, status: 'skipped' });
    const after = store.step(goal.id, { step: 2, status: 'done', evidence: 'файл открыт и проверен' });
    assert.equal(after.steps[0].status, 'skipped');
    assert.equal(after.steps[1].evidence, 'файл открыт и проверен');
  });

  test('закрыть done можно только когда не осталось открытых шагов', (t) => {
    const store = tempStore(t);
    const goal = store.create({ title: 'Дело', steps: ['раз', 'два'] });
    assert.throws(() => store.close(goal.id, { status: 'done', evidence: 'готово' }), /осталось шагов/);
    store.step(goal.id, { step: 1, status: 'done', evidence: 'сделано' });
    store.step(goal.id, { step: 2, status: 'skipped' });
    const closed = store.close(goal.id, { status: 'done', evidence: 'оба шага закрыты' });
    assert.equal(closed.status, 'done');
    assert.equal(closed.result, 'оба шага закрыты');
    assert.equal(store.progress(closed).left, 0);
  });

  test('отмена требует причину и закрывает цель', (t) => {
    const store = tempStore(t);
    const goal = store.create({ title: 'Дело', steps: ['раз'] });
    assert.throws(() => store.close(goal.id, { status: 'dropped', evidence: '' }), /итог/);
    const closed = store.close(goal.id, { status: 'dropped', evidence: 'владелец передумал' });
    assert.equal(closed.status, 'dropped');
    assert.throws(() => store.step(goal.id, { step: 1, status: 'done', evidence: 'поздно' }), /уже закрыта/);
  });

  test('цель и отметки переживают перезапуск', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-goals-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'goals.json');
    const first = new GoalStore(file);
    const goal = first.create({ title: 'Пережить перезапуск', steps: ['шаг'] });
    first.step(goal.id, { step: 1, status: 'done', evidence: 'проверено' });
    const second = new GoalStore(file);
    assert.equal(second.get(goal.id).steps[0].status, 'done');
    assert.equal(second.get(goal.id).steps[0].evidence, 'проверено');
  });

  test('проверки входа: пусто, много шагов, лимит активных', (t) => {
    const store = tempStore(t);
    assert.throws(() => store.create({ title: '', steps: ['раз'] }), /название/);
    assert.throws(() => store.create({ title: 'Цель', steps: [] }), /шаг/);
    assert.throws(() => store.create({ title: 'Цель', steps: new Array(21).fill('шаг') }), /не больше 20/);
    for (let i = 0; i < MAX_ACTIVE; i += 1) store.create({ title: `Цель ${i}`, steps: ['шаг'] });
    assert.throws(() => store.create({ title: 'Лишняя', steps: ['шаг'] }), new RegExp(String(MAX_ACTIVE)));
  });

  test('памятка показывает активные цели, следующий шаг и не шумит пустотой', (t) => {
    const store = tempStore(t);
    assert.equal(goalsBrief(store), '');
    const goal = store.create({ title: 'Собрать отчёт', steps: ['найти данные', 'написать'] });
    store.step(goal.id, { step: 1, status: 'done', evidence: 'данные есть' });
    const brief = goalsBrief(store);
    assert.match(brief, /Активные цели/);
    assert.match(brief, /Собрать отчёт/);
    assert.match(brief, /шагов 1\/2/);
    assert.match(brief, /написать/);
    store.close(goal.id, { status: 'dropped', evidence: 'не нужно' });
    assert.equal(goalsBrief(store), '');
  });
});

describe('цели: инструменты', () => {
  test('create → next → step → close и проверки результата', async (t) => {
    const store = tempStore(t);
    const tools = goalTools(store);
    const create = tools.find((x) => x.name === 'goal_create');
    const next = tools.find((x) => x.name === 'goal_next');
    const step = tools.find((x) => x.name === 'goal_step');
    const close = tools.find((x) => x.name === 'goal_close');
    const list = tools.find((x) => x.name === 'goal_list');

    const created = await create.run({ title: 'Найти и записать', steps: ['поиск', 'файл'] });
    assert.equal(created.ok, true);
    const id = created.data.goal.id;
    assert.deepEqual(await create.verify({}, created), { status: 'confirmed', evidence: 'цель записана на диск' });

    const first = await next.run({ id });
    assert.equal(first.ok, true);
    assert.equal(first.data.step.text, 'поиск');

    const bad = await step.run({ id, step: 1, status: 'done' });
    assert.equal(bad.ok, false);
    assert.match(bad.summary, /доказательство/);

    const done = await step.run({ id, step: 1, status: 'done', evidence: 'нашёл источник' });
    assert.equal(done.ok, true);
    assert.equal((await step.verify({ id, step: 1, status: 'done' }, done)).status, 'confirmed');

    const early = await close.run({ id, status: 'done', evidence: 'итог' });
    assert.equal(early.ok, false);
    assert.match(early.summary, /осталось/);

    await step.run({ id, step: 2, status: 'skipped' });
    const closed = await close.run({ id, status: 'done', evidence: 'всё закрыто' });
    assert.equal(closed.ok, true);
    assert.equal((await close.verify({ id, status: 'done' }, closed)).status, 'confirmed');

    const listed = await list.run({ status: 'done' });
    assert.equal(listed.data.goals[0].id, id);
  });

  test('goal_next на закрытой цели отвечает, что она закрыта', async (t) => {
    const store = tempStore(t);
    const goal = store.create({ title: 'Короткая', steps: ['раз'] });
    store.close(goal.id, { status: 'dropped', evidence: 'не нужно' });
    const next = goalTools(store).find((x) => x.name === 'goal_next');
    const result = await next.run({ id: goal.id });
    assert.equal(result.ok, false);
    assert.match(result.summary, /dropped/);
  });
});

describe('цели: подключение к приложению', () => {
  test('main.js знает хранилище, инструменты и правило в промпте', () => {
    const app = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(app, 'main.js'), 'utf8');
    assert.match(main, /new GoalStore\(path\.join\(DATA_DIR, 'goals\.json'\)\)/);
    assert.match(main, /\.\.\.goalTools\(goals\)/);
    assert.match(main, /goal_create.*goal_step.*goal_close/);
    assert.match(main, /goalsBrief\(goals\)/);
    const shared = fs.readFileSync(path.join(app, 'renderer', 'shared.js'), 'utf8');
    for (const name of ['goal_create', 'goal_list', 'goal_next', 'goal_step', 'goal_close']) {
      assert.match(shared, new RegExp(`${name}:`));
    }
  });
});
