'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ReminderStore } = require('../src/schedule/store');
const { Scheduler, deliverReminder, showNotification } = require('../src/schedule/scheduler');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('показ уведомления подтверждается событием, сбой и таймаут не считаются успехом', async () => {
  const shown = new EventEmitter();
  shown.show = () => shown.emit('show');
  await showNotification(shown, 50);
  assert.equal(shown.listenerCount('show'), 0);
  const failed = new EventEmitter();
  failed.show = () => failed.emit('failed', {}, 'ошибка системы');
  await assert.rejects(showNotification(failed, 50), /ошибка системы/);
  const silent = new EventEmitter();
  silent.show = () => {};
  await assert.rejects(showNotification(silent, 5), /не подтвердила/);
  assert.equal(silent.listenerCount('failed'), 0);
});

test('одиночный сбой доставки оставляет напоминание в очереди', async (t) => {
  const dir = setup(t);
  const store = new ReminderStore(path.join(dir, 'reminders.json'));
  const due = '2026-10-27T10:00:00.000Z';
  const item = store.add({ text: 'выпить воды', dueAt: due });
  let calls = 0;
  const scheduler = new Scheduler({
    store,
    notify: async () => {
      calls += 1;
      throw new Error('уведомления недоступны');
    },
    now: () => new Date('2026-10-27T10:01:00.000Z'),
  });

  assert.equal(await scheduler.tick(), 0);
  assert.equal(calls, 1);
  assert.equal(store.get(item.id).done, false);
});

test('тихий режим записывает в журнал; недоступное уведомление не считается доставленным', async (t) => {
  const dir = setup(t);
  const store = new ReminderStore(path.join(dir, 'reminders.json'));
  const item = store.add({ text: 'встреча', dueAt: '2026-10-27T10:00:00.000Z' });
  let quiet = false;
  const entries = [];
  let shown = 0;
  const delivery = (value) => deliverReminder(value, {
    quiet: () => quiet,
    record: (entry) => entries.push(entry.text),
    supported: () => false,
    show: () => { shown += 1; },
  });
  const scheduler = new Scheduler({ store, notify: delivery, now: () => new Date('2026-10-27T10:01:00.000Z') });
  assert.equal(await scheduler.tick(), 0);
  assert.equal(store.get(item.id).done, false);
  quiet = true;
  assert.equal(await scheduler.tick(), 1);
  assert.deepEqual(entries, ['встреча']);
  assert.equal(shown, 0);
  assert.equal(store.get(item.id).done, true);
});

test('после трёх ошибок напоминание остаётся и повторяется после паузы', async (t) => {
  const dir = setup(t);
  const store = new ReminderStore(path.join(dir, 'reminders.json'));
  const item = store.add({ text: 'проверить почту', dueAt: '2026-10-27T10:00:00.000Z' });
  let calls = 0;
  let current = new Date('2026-10-27T10:01:00.000Z');
  let failing = true;
  const scheduler = new Scheduler({
    store,
    notify: async () => {
      calls += 1;
      if (failing) throw new Error('постоянный сбой');
    },
    now: () => current,
  });

  await scheduler.tick();
  await scheduler.tick();
  await scheduler.tick();
  await scheduler.tick();

  assert.equal(calls, 3);
  assert.equal(store.get(item.id).done, false);
  current = new Date('2026-10-27T10:05:59.000Z');
  await scheduler.tick();
  assert.equal(calls, 3);
  current = new Date('2026-10-27T10:06:00.000Z');
  failing = false;
  assert.equal(await scheduler.tick(), 1);
  assert.equal(calls, 4);
  assert.equal(store.get(item.id).done, true);
});
