'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MissionStore } = require('../src/missions/store');
const { missionTools } = require('../src/tools/missions');
const { ToolRegistry } = require('../src/tools/registry');

const MIN = 60 * 1000;
// Локальные моменты: проверки HH:MM не зависят от часового пояса машины.
const NOW = new Date(2026, 9, 27, 10, 0, 0, 0);

function localAt(day, hours, minutes, seconds = 0) {
  return new Date(2026, 9, day, hours, minutes, seconds, 0);
}

function localHhmm(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-missions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function newStore(t) {
  return new MissionStore(path.join(tempDir(t), 'missions.json'));
}

test('add interval: nextRunAt = now + minutes, поля по умолчанию', (t) => {
  const store = newStore(t);
  const m = store.add({ goal: '  проверить почту  ', schedule: { type: 'interval', minutes: 30 } }, NOW);

  assert.equal(typeof m.id, 'string');
  assert.equal(m.goal, 'проверить почту');
  assert.deepEqual(m.schedule, { type: 'interval', minutes: 30 });
  assert.equal(m.enabled, true);
  assert.equal(m.createdAt, NOW.toISOString());
  assert.equal(m.nextRunAt, new Date(NOW.getTime() + 30 * MIN).toISOString());
  assert.equal(m.lastRunAt, null);
  assert.equal(m.runs, 0);
  assert.equal(m.lastResult, null);
  assert.equal(m.status, 'idle');
  assert.deepEqual(store.get(m.id), m);
});

test('инструменты миссий показывают и отменяют задачи только своего пространства', async (t) => {
  const store = newStore(t);
  const work = missionTools(store, { workspaceId: 'work-1', now: () => NOW });
  const study = missionTools(store, { workspaceId: 'study-2', now: () => NOW });
  const made = await work[0].run({ goal: 'Проверить рабочие файлы', every_minutes: 30 });
  await study[0].run({ goal: 'Проверить учебные файлы', every_minutes: 30 });
  const workList = await work[1].run();
  const studyList = await study[1].run();
  assert.equal(workList.data.length, 1);
  assert.equal(workList.data[0].goal, 'Проверить рабочие файлы');
  assert.equal(studyList.data.length, 1);
  assert.equal(studyList.data[0].goal, 'Проверить учебные файлы');
  assert.equal((await study[2].run({ id: made.data.id })).ok, false);
  assert.equal(store.get(made.data.id).goal, 'Проверить рабочие файлы');
});

test('add daily: ближайший HH:MM строго после now (сегодня или завтра)', (t) => {
  const store = newStore(t);
  const before = store.add({ goal: 'отчёт', schedule: { type: 'daily', at: '12:00' } }, NOW);
  assert.equal(before.nextRunAt, localAt(27, 12, 0).toISOString(), 'время ещё не наступило: сегодня');

  const after = store.add({ goal: 'утро', schedule: { type: 'daily', at: '09:00' } }, NOW);
  assert.equal(after.nextRunAt, localAt(28, 9, 0).toISOString(), 'время прошло: завтра');

  const exact = store.add({ goal: 'ровно', schedule: { type: 'daily', at: '10:00' } }, NOW);
  assert.equal(exact.nextRunAt, localAt(28, 10, 0).toISOString(), 'ровно сейчас уже не строго после now');

  const justBefore = store.add({ goal: 'секунда', schedule: { type: 'daily', at: '10:01' } }, localAt(27, 10, 0, 30));
  assert.equal(justBefore.nextRunAt, localAt(27, 10, 1).toISOString(), 'через 30 секунд ещё сегодня');

  const justAfter = store.add({ goal: 'секунда назад', schedule: { type: 'daily', at: '10:00' } }, localAt(27, 10, 0, 30));
  assert.equal(justAfter.nextRunAt, localAt(28, 10, 0).toISOString(), 'через 30 секунд уже завтра');

  const midnight = store.add({ goal: 'полночь', schedule: { type: 'daily', at: '00:00' } }, NOW);
  assert.equal(midnight.nextRunAt, localAt(28, 0, 0).toISOString());

  const lastMinute = store.add({ goal: 'конец дня', schedule: { type: 'daily', at: '23:59' } }, NOW);
  assert.equal(lastMinute.nextRunAt, localAt(27, 23, 59).toISOString());
});

test('add: границы интервала 5 и 10080 принимаются, строка из 500 символов тоже', (t) => {
  const store = newStore(t);
  const low = store.add({ goal: 'x', schedule: { type: 'interval', minutes: 5 } }, NOW);
  assert.equal(low.nextRunAt, new Date(NOW.getTime() + 5 * MIN).toISOString());
  const high = store.add({ goal: 'y'.repeat(500), schedule: { type: 'interval', minutes: 10080 } }, NOW);
  assert.equal(high.goal.length, 500);
  assert.equal(high.nextRunAt, new Date(NOW.getTime() + 10080 * MIN).toISOString());
});

test('add: валидация отклоняет плохие данные и не создаёт файл', (t) => {
  const file = path.join(tempDir(t), 'missions.json');
  const store = new MissionStore(file);
  const interval5 = { type: 'interval', minutes: 5 };

  assert.throws(() => store.add({ goal: '', schedule: interval5 }, NOW), /пуст/);
  assert.throws(() => store.add({ goal: '   ', schedule: interval5 }, NOW), /пуст/);
  assert.throws(() => store.add({ goal: 'я'.repeat(501), schedule: interval5 }, NOW), /500/);
  assert.throws(() => store.add({ goal: 42, schedule: interval5 }, NOW), /строка/);

  for (const at of ['24:00', '9:00', '12:60', 'ab:cd', '', undefined, 1000]) {
    assert.throws(() => store.add({ goal: 'x', schedule: { type: 'daily', at } }, NOW), /время/, `at=${String(at)}`);
  }
  for (const minutes of [4, 10081, 7.5, '10', undefined]) {
    assert.throws(() => store.add({ goal: 'x', schedule: { type: 'interval', minutes } }, NOW), /минуты/, `minutes=${String(minutes)}`);
  }
  assert.throws(() => store.add({ goal: 'x', schedule: { type: 'weekly' } }, NOW), /график/);
  assert.throws(() => store.add({ goal: 'x' }, NOW), /график/, 'без графика');
  assert.throws(() => store.add({ goal: 'x', schedule: null }, NOW), /график/);
  assert.equal(fs.existsSync(file), false, 'при ошибке валидации файл не создаётся');
});

test('повреждённый файл не перезаписывается', (t) => {
  const file = path.join(tempDir(t), 'missions.json');
  fs.writeFileSync(file, '{не json', 'utf8');
  const store = new MissionStore(file);

  assert.throws(() => store.add({ goal: 'новая', schedule: { type: 'interval', minutes: 5 } }, NOW), /повреждён/);
  assert.throws(() => store.list(), /повреждён/);
  assert.throws(() => store.setEnabled('любой', false), /повреждён/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{не json');
});

test('list сортирует по nextRunAt; get и cancel', (t) => {
  const store = newStore(t);
  const later = store.add({ goal: 'позже', schedule: { type: 'interval', minutes: 60 } }, NOW);
  const sooner = store.add({ goal: 'раньше', schedule: { type: 'interval', minutes: 5 } }, NOW);
  const daily = store.add({ goal: 'утром', schedule: { type: 'daily', at: '09:00' } }, NOW);

  // nextRunAt: раньше 10:05, позже 11:00, утром завтра 09:00.
  assert.deepEqual(store.list().map((m) => m.goal), ['раньше', 'позже', 'утром']);
  assert.deepEqual(store.list().map((m) => m.id), [sooner.id, later.id, daily.id]);

  assert.equal(store.get('нет-такого'), null);
  assert.equal(store.cancel('нет-такого'), false);
  assert.equal(store.cancel(later.id), true);
  assert.equal(store.get(later.id), null);
  assert.equal(store.cancel(later.id), false);
  assert.equal(store.list().length, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(store.filePath)), ['missions.json'], 'временных файлов не осталось');
});

test('due: только включённые и с nextRunAt <= now', (t) => {
  const store = newStore(t);
  store.add({ goal: 'a', schedule: { type: 'interval', minutes: 5 } }, NOW); // 10:05
  store.add({ goal: 'b', schedule: { type: 'interval', minutes: 60 } }, NOW); // 11:00
  const c = store.add({ goal: 'c', schedule: { type: 'interval', minutes: 5 } }, localAt(27, 9, 0)); // 09:05

  assert.deepEqual(store.due(NOW).map((m) => m.goal), ['c']);
  assert.deepEqual(store.due(store.get(c.id).nextRunAt).map((m) => m.goal), ['c'], 'момент равен nextRunAt: наступил');
  assert.deepEqual(store.due(localAt(27, 10, 5)).map((m) => m.goal), ['c', 'a']);
  assert.deepEqual(store.due(localAt(27, 11, 0)).map((m) => m.goal), ['c', 'a', 'b']);
  assert.equal(store.due(localAt(27, 8, 0)).length, 0);
});

test('markRun: пересчитывает nextRunAt и обрезает lastResult до 2000 символов', (t) => {
  const store = newStore(t);
  const m = store.add({ goal: 'проверка', schedule: { type: 'interval', minutes: 10 } }, NOW);

  const runAt = localAt(27, 10, 7);
  const first = store.markRun(m.id, { now: runAt, result: 'я'.repeat(2500) });
  assert.equal(first.runs, 1);
  assert.equal(first.lastRunAt, runAt.toISOString());
  assert.equal(first.nextRunAt, new Date(runAt.getTime() + 10 * MIN).toISOString(), 'interval: от момента запуска');
  assert.equal(Array.from(first.lastResult).length, 2000);
  assert.deepEqual(store.get(m.id), first, 'изменение записано в файл');

  const second = store.markRun(m.id, { now: localAt(27, 10, 20), result: 'второй раз' });
  assert.equal(second.runs, 2);
  assert.equal(second.lastResult, 'второй раз');

  assert.equal(store.markRun('нет-такого', { now: runAt, result: 'x' }), null);
});

test('markRun: daily пересчитывает на следующий день после запуска', (t) => {
  const store = newStore(t);
  const m = store.add({ goal: 'отчёт', schedule: { type: 'daily', at: '12:00' } }, NOW);
  assert.equal(m.nextRunAt, localAt(27, 12, 0).toISOString());

  const updated = store.markRun(m.id, { now: localAt(27, 12, 30), result: 'готово' });
  assert.equal(updated.nextRunAt, localAt(28, 12, 0).toISOString());
  assert.equal(updated.runs, 1);
  assert.equal(updated.enabled, true, 'задача не отключается после запуска');
});

test('setEnabled(false) скрывает из due, setEnabled(true) возвращает', (t) => {
  const store = newStore(t);
  const m = store.add({ goal: 'x', schedule: { type: 'interval', minutes: 5 } }, NOW);
  const runAt = localAt(27, 10, 5);

  assert.equal(store.due(runAt).length, 1);
  assert.equal(store.setEnabled(m.id, false), true);
  assert.equal(store.due(runAt).length, 0, 'отключённая задача не попадает в due');
  assert.equal(store.get(m.id).enabled, false);
  assert.equal(store.list().length, 1, 'отключённая остаётся в списке');

  assert.equal(store.setEnabled('нет-такого', true), false);
  assert.throws(() => store.setEnabled(m.id, 'да'), /true или false/);

  assert.equal(store.setEnabled(m.id, true), true);
  assert.equal(store.due(runAt).length, 1);
});

test('missionTools: три инструмента с нужными рисками, регистрируются', () => {
  const tools = missionTools(new MissionStore(path.join(os.tmpdir(), 'unused-missions.json')), { now: () => NOW });

  assert.deepEqual(tools.map((tool) => tool.name), ['mission_add', 'mission_list', 'mission_cancel']);
  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.risk])),
    { mission_add: 'T1', mission_list: 'T0', mission_cancel: 'T2' }
  );
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.run, 'function');
    assert.equal(tool.parameters.type, 'object');
  }

  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  assert.equal(registry.list().length, 3);
});

test('mission_add: ставит задачу по every_minutes и daily_at', async (t) => {
  const store = newStore(t);
  const [missionAdd, missionList] = missionTools(store, { now: () => NOW });

  const every = await missionAdd.run({ goal: 'проверить сайт', every_minutes: 15 });
  assert.equal(every.ok, true);
  assert.equal(every.summary, `задача добавлена, первый запуск ${localHhmm(new Date(NOW.getTime() + 15 * MIN))}`);
  assert.equal(store.get(every.data.id).nextRunAt, new Date(NOW.getTime() + 15 * MIN).toISOString());

  const daily = await missionAdd.run({ goal: 'отчёт', daily_at: '09:00' });
  assert.equal(daily.ok, true);
  assert.equal(daily.summary, `задача добавлена, первый запуск ${localHhmm(localAt(28, 9, 0))}`);
  assert.equal(store.get(daily.data.id).nextRunAt, localAt(28, 9, 0).toISOString());

  assert.equal((await missionList.run()).summary, 'задач: 2');
});

test('mission_add: без графика, с двумя графиками или с плохими данными отказывает', async (t) => {
  const file = path.join(tempDir(t), 'missions.json');
  const [missionAdd] = missionTools(new MissionStore(file), { now: () => NOW });
  const noSchedule = 'укажи every_minutes или daily_at';

  const none = await missionAdd.run({ goal: 'x' });
  assert.deepEqual({ ok: none.ok, summary: none.summary }, { ok: false, summary: noSchedule });
  const both = await missionAdd.run({ goal: 'x', every_minutes: 10, daily_at: '09:00' });
  assert.deepEqual({ ok: both.ok, summary: both.summary }, { ok: false, summary: noSchedule });

  assert.equal((await missionAdd.run({ goal: '', every_minutes: 10 })).ok, false);
  assert.equal((await missionAdd.run({ goal: 'x', every_minutes: 3 })).ok, false);
  assert.equal((await missionAdd.run({ goal: 'x', daily_at: '25:00' })).ok, false);
  assert.equal(fs.existsSync(file), false, 'отказы не создают файл');
});

test('mission_list: summary, пустой список и обрезка lastResult до 200 символов', async (t) => {
  const store = newStore(t);
  const [, missionList] = missionTools(store, { now: () => NOW });

  const empty = await missionList.run();
  assert.deepEqual({ ok: empty.ok, summary: empty.summary, data: empty.data }, { ok: true, summary: 'задач: 0', data: [] });

  const m = store.add({ goal: 'длинная', schedule: { type: 'interval', minutes: 5 } }, NOW);
  store.markRun(m.id, { now: localAt(27, 10, 5), result: 'ответ '.repeat(100) });

  const listed = await missionList.run();
  assert.equal(listed.ok, true);
  assert.equal(listed.summary, 'задач: 1');
  assert.deepEqual(Object.keys(listed.data[0]).sort(), ['goal', 'id', 'lastResult', 'lastVerdict', 'nextRunAt', 'runs', 'schedule']);
  assert.equal(listed.data[0].runs, 1);
  assert.equal(Array.from(listed.data[0].lastResult).length, 200);
  assert.equal(listed.data[0].lastResult, 'ответ '.repeat(100).slice(0, 200));
});

test('mission_cancel: отменяет, повтор и пустой id отказывают', async (t) => {
  const store = newStore(t);
  const [, , missionCancel] = missionTools(store, { now: () => NOW });
  const m = store.add({ goal: 'x', schedule: { type: 'interval', minutes: 5 } }, NOW);

  const gone = await missionCancel.run({ id: m.id });
  assert.deepEqual({ ok: gone.ok, summary: gone.summary }, { ok: true, summary: 'отменил' });
  assert.equal(store.get(m.id), null);

  const again = await missionCancel.run({ id: m.id });
  assert.deepEqual({ ok: again.ok, summary: again.summary }, { ok: false, summary: 'такой задачи нет' });
  const empty = await missionCancel.run({});
  assert.equal(empty.ok, false);
});

test('инструменты возвращают {ok: false}, если файл задач повреждён, и не перезаписывают его', async (t) => {
  const file = path.join(tempDir(t), 'missions.json');
  fs.writeFileSync(file, '{не json', 'utf8');
  const [missionAdd, missionList, missionCancel] = missionTools(new MissionStore(file), { now: () => NOW });

  const listed = await missionList.run();
  assert.equal(listed.ok, false);
  assert.match(listed.summary, /повреждён/);

  const added = await missionAdd.run({ goal: 'x', every_minutes: 10 });
  assert.equal(added.ok, false);

  const cancelled = await missionCancel.run({ id: 'любой' });
  assert.equal(cancelled.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{не json');
});
