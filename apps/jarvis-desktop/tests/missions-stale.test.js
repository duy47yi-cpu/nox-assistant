'use strict';

// Сон компьютера: daily запускается один раз (если опоздание до 12 часов), устаревшая daily пропускается, interval не трогаем.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MissionStore } = require('../src/missions/store');
const { MissionScheduler } = require('../src/missions/scheduler');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function storeIn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { file: path.join(dir, 'missions.json'), store: new MissionStore(path.join(dir, 'missions.json')) };
}

// Задача 09:00 каждый день; создана за день до первого срабатывания.
function dailyAt9(store) {
  return store.add({ goal: 'брифинг', schedule: { type: 'daily', at: '09:00' } }, new Date(2026, 10, 1, 8, 0));
}

function schedulerFor(store, now, counter) {
  return new MissionScheduler({
    store,
    now: () => now,
    notify: () => {},
    run: async () => {
      counter.runs += 1;
      return { report: 'отчёт', verdict: 'done' };
    },
  });
}

test('сон до 12 часов: daily запускается один раз, срок в будущем', async (t) => {
  const { store } = storeIn(t);
  const m = dailyAt9(store);
  const due = new Date(m.nextRunAt);
  const wake = new Date(due.getTime() + 2 * HOUR); // проснулся через 2 часа после срока
  const counter = { runs: 0 };
  const sched = schedulerFor(store, wake, counter);

  assert.equal(await sched.tick(), 1);
  assert.equal(await sched.tick(), 0, 'второй проход не запускает ещё раз');
  assert.equal(counter.runs, 1);
  const after = store.get(m.id);
  assert.ok(new Date(after.nextRunAt).getTime() > wake.getTime(), 'nextRunAt в будущем');
  assert.equal(after.runs, 1);
});

test('сон 3 суток: устаревшая daily не запускается, срок сдвигается, итог skipped', async (t) => {
  const { store } = storeIn(t);
  const m = dailyAt9(store);
  const wake = new Date(new Date(m.nextRunAt).getTime() + 3 * DAY);
  const counter = { runs: 0 };
  const sched = schedulerFor(store, wake, counter);

  assert.equal(await sched.tick(), 0);
  assert.equal(await sched.tick(), 0);
  assert.equal(counter.runs, 0, 'после сна не запускается');
  const after = store.get(m.id);
  assert.ok(new Date(after.nextRunAt).getTime() > wake.getTime(), 'nextRunAt в будущем');
  assert.equal(after.lastVerdict, 'skipped');
  assert.equal(after.lastResult, 'пропущено: компьютер был выключен');
  assert.equal(after.runs, 0);
  assert.equal(after.enabled, true, 'права и включённость не меняются');
  assert.deepEqual(store.due(wake), [], 'due пусто, пока срок в будущем');
});

test('interval после сна 3 суток запускается один раз (правило про daily не касается)', async (t) => {
  const { store } = storeIn(t);
  const m = store.add({ goal: 'проверка', schedule: { type: 'interval', minutes: 60 } }, new Date(2026, 10, 1, 8, 0));
  const wake = new Date(new Date(m.nextRunAt).getTime() + 3 * DAY);
  const counter = { runs: 0 };
  const sched = schedulerFor(store, wake, counter);

  assert.equal(await sched.tick(), 1);
  assert.equal(await sched.tick(), 0);
  assert.equal(counter.runs, 1);
  assert.notEqual(store.get(m.id).lastVerdict, 'skipped');
});

test('due остаётся чтением: файл не меняется', (t) => {
  const { file, store } = storeIn(t);
  const m = dailyAt9(store);
  const before = fs.readFileSync(file, 'utf8');
  store.due(new Date(new Date(m.nextRunAt).getTime() + 3 * DAY));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('skipStale: без устаревших задач файл не переписывается', (t) => {
  const { file, store } = storeIn(t);
  const m = dailyAt9(store);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(store.skipStale(new Date(new Date(m.nextRunAt).getTime() - HOUR)), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
