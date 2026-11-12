'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ReminderStore } = require('../src/schedule/store');
const { Scheduler } = require('../src/schedule/scheduler');
const { remindersTools } = require('../src/tools/reminders');
const { ToolRegistry } = require('../src/tools/registry');

const NOW = new Date('2026-10-27T10:00:00Z');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-reminders-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function newStore(t) {
  return new ReminderStore(path.join(tempDir(t), 'reminders.json'));
}

function localHhmm(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

test('add, get, list и cancel', (t) => {
  const file = path.join(tempDir(t), 'nested', 'reminders.json');
  const store = new ReminderStore(file);
  assert.deepEqual(store.list(), [], 'до первой записи файла может не быть');

  const later = store.add({ text: 'позже', dueAt: '2026-10-27T12:00:00Z' });
  const sooner = store.add({ text: 'раньше', dueAt: '2026-10-27T11:00:00Z', repeat: 'daily' });

  assert.equal(typeof later.id, 'string');
  assert.notEqual(later.id, sooner.id);
  assert.deepEqual(Object.keys(later).sort(), ['createdAt', 'done', 'dueAt', 'firedAt', 'id', 'repeat', 'text']);
  assert.equal(later.dueAt, '2026-10-27T12:00:00.000Z');
  assert.equal(later.repeat, null);
  assert.equal(later.done, false);
  assert.equal(later.firedAt, null);
  assert.equal(sooner.repeat, 'daily');
  assert.equal(new Date(later.createdAt).toISOString(), later.createdAt);

  assert.deepEqual(store.list().map((r) => r.text), ['раньше', 'позже'], 'по dueAt по возрастанию');
  assert.equal(store.get(later.id).text, 'позже');
  assert.equal(store.get('нет-такого'), null);

  assert.equal(store.cancel('нет-такого'), false);
  assert.equal(store.cancel(later.id), true);
  assert.equal(store.get(later.id), null);
  assert.equal(store.cancel(later.id), false);
  assert.deepEqual(store.list().map((r) => r.text), ['раньше']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['reminders.json'], 'временных файлов не осталось');
});

test('напоминания можно разделить по рабочему пространству; старые записи остаются общими', (t) => {
  const store = newStore(t);
  const alphaId = '11111111-1111-4111-8111-111111111111';
  const betaId = '22222222-2222-4222-8222-222222222222';
  const common = store.add({ text: 'общее', dueAt: '2026-10-27T12:00:00Z' });
  const alpha = store.add({ text: 'альфа', dueAt: '2026-10-27T12:00:00Z', workspaceId: alphaId });
  const beta = store.add({ text: 'бета', dueAt: '2026-10-27T12:00:00Z', workspaceId: betaId });

  assert.deepEqual(store.list({ workspaceId: 'default' }).map((item) => item.text), ['общее']);
  assert.deepEqual(store.list({ workspaceId: alphaId }).map((item) => item.text), ['альфа']);
  assert.deepEqual(store.list({ workspaceId: betaId }).map((item) => item.text), ['бета']);
  assert.equal(store.get(beta.id, { workspaceId: alphaId }), null);
  assert.equal(store.cancel(beta.id, { workspaceId: alphaId }), false);
  assert.ok(store.get(beta.id, { workspaceId: betaId }));
  assert.ok(store.get(common.id, { workspaceId: 'default' }));
});

test('инструменты напоминаний используют только выбранное пространство', async (t) => {
  const store = newStore(t);
  const alphaId = '11111111-1111-4111-8111-111111111111';
  const betaId = '22222222-2222-4222-8222-222222222222';
  let selected = alphaId;
  const tools = Object.fromEntries(remindersTools(store, { now: () => NOW, workspaceId: () => selected }).map((tool) => [tool.name, tool]));
  const added = await tools.remind_in.run({ minutes: 5, text: 'задача альфы' });
  assert.equal(store.get(added.data.id).workspaceId, alphaId);
  assert.equal((await tools.remind_in.verify({}, added)).status, 'confirmed');
  assert.deepEqual((await tools.list_reminders.run()).data.map((item) => item.text), ['задача альфы']);
  const delivered = [];
  await new Scheduler({ store, notify: (item) => { delivered.push(item); }, now: () => new Date(NOW.getTime() + 6 * 60 * 1000) }).tick();
  assert.equal(delivered[0].workspaceId, alphaId);
  selected = betaId;
  assert.deepEqual((await tools.list_reminders.run()).data, []);
  assert.match((await tools.cancel_reminder.run({ id: added.data.id })).summary, /такого напоминания нет/);
});

test('местное время учитывает перевод часов и не угадывает неоднозначный момент', () => {
  const script = `const {resolveLocalTime} = require('./src/tools/reminders'); console.log(JSON.stringify(['2027-03-14T02:30','2027-11-07T01:30','2027-11-07T03:30'].map(resolveLocalTime)));`;
  const output = execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  const [gap, overlap, normal] = JSON.parse(output);
  assert.match(gap.error, /нет из-за перевода часов/);
  assert.match(overlap.error, /повторяется/);
  assert.equal(new Date(normal.ms).toISOString(), '2027-11-07T08:30:00.000Z');
});

test('remind_at сохраняет указанное местное время компьютера', async (t) => {
  const store = newStore(t);
  const remindAt = remindersTools(store, { now: () => NOW }).find((tool) => tool.name === 'remind_at');
  const result = await remindAt.run({ at: '2030-01-15T10:30', text: 'встреча' });
  assert.equal(result.ok, true);
  assert.equal(result.data.dueAt, new Date(2030, 0, 15, 10, 30).toISOString());
  assert.equal((await remindAt.verify({}, result)).status, 'confirmed');
});

test('проверка напоминания замечает изменение текста или статуса', async (t) => {
  const store = newStore(t);
  const [remindIn] = remindersTools(store, { now: () => NOW });
  const result = await remindIn.run({ minutes: 5, text: 'позвонить' });
  assert.equal((await remindIn.verify({}, result)).status, 'confirmed');
  const originalGet = store.get.bind(store);
  store.get = (id, options) => ({ ...originalGet(id, options), text: 'другое' });
  assert.equal((await remindIn.verify({}, result)).status, 'failed');
  store.get = (id, options) => ({ ...originalGet(id, options), done: true });
  assert.equal((await remindIn.verify({}, result)).status, 'failed');
});

test('add: пустой текст, плохая дата и repeat вне набора отклоняются без записи', (t) => {
  const file = path.join(tempDir(t), 'reminders.json');
  const store = new ReminderStore(file);
  const dueAt = '2026-10-27T12:00:00Z';

  assert.throws(() => store.add({ text: '   ', dueAt }), /пустой/);
  assert.throws(() => store.add({ dueAt }), /пустой/);
  assert.throws(() => store.add({ text: 'x', dueAt: 'не дата' }), /плохая дата/);
  assert.throws(() => store.add({ text: 'x' }), /дата/);
  assert.throws(() => store.add({ text: 'x', dueAt: 1234 }), /дата/);
  assert.throws(() => store.add({ text: 'x', dueAt, repeat: 'yearly' }), /repeat/);
  assert.throws(() => store.add({ text: 'x', dueAt, repeat: 'DAILY' }), /repeat/);
  assert.equal(fs.existsSync(file), false, 'при ошибке валидации файл не создаётся');

  const long = store.add({ text: 'я'.repeat(400), dueAt });
  assert.equal(long.text.length, 300);
  const emoji = store.add({ text: '😀'.repeat(400), dueAt });
  assert.equal(Array.from(emoji.text).length, 300);
  assert.equal(emoji.text, '😀'.repeat(300), 'эмодзи не рвутся');
});

test('повреждённый файл не перезаписывается', (t) => {
  const file = path.join(tempDir(t), 'reminders.json');
  fs.writeFileSync(file, '{не json', 'utf8');
  const store = new ReminderStore(file);

  assert.throws(() => store.add({ text: 'новая', dueAt: '2026-10-27T12:00:00Z' }), /повреждён/);
  assert.throws(() => store.list(), /повреждён/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{не json');
});

test('due: невыполненные напоминания, время которых наступило', (t) => {
  const store = newStore(t);
  store.add({ text: 'будущее', dueAt: '2026-10-27T11:00:00Z' });
  store.add({ text: 'ровно сейчас', dueAt: '2026-10-27T10:00:00Z' });
  const old = store.add({ text: 'давно', dueAt: '2026-10-27T09:00:00Z' });

  assert.deepEqual(store.due(NOW).map((r) => r.text), ['давно', 'ровно сейчас']);
  assert.equal(store.due(new Date('2026-10-27T08:59:59Z')).length, 0, 'до первого срабатывания ничего не созрело');

  store.markFired(old.id, NOW);
  assert.deepEqual(store.due(NOW).map((r) => r.text), ['ровно сейчас']);
  assert.deepEqual(store.list().map((r) => r.text), ['ровно сейчас', 'будущее']);
  assert.deepEqual(store.list({ includeDone: true }).map((r) => r.text), ['давно', 'ровно сейчас', 'будущее']);
});

test('markFired: разовое выполняется; ежедневное сдвигается на сутки, пока не станет позже now', (t) => {
  const store = newStore(t);
  const once = store.add({ text: 'разово', dueAt: '2026-10-27T09:00:00Z' });
  const daily = store.add({ text: 'каждый день', dueAt: '2026-10-27T09:00:00Z', repeat: 'daily' });
  const missed = store.add({ text: 'пропущено', dueAt: '2026-10-20T09:00:00Z', repeat: 'daily' });
  const edge = store.add({ text: 'ровно на границе', dueAt: '2026-10-26T10:00:00Z', repeat: 'daily' });

  const firedOnce = store.markFired(once.id, NOW);
  assert.equal(firedOnce.done, true);
  assert.equal(firedOnce.firedAt, NOW.toISOString());
  assert.equal(store.get(once.id).done, true);

  store.markFired(daily.id, NOW);
  assert.equal(store.get(daily.id).dueAt, '2026-10-28T09:00:00.000Z');
  assert.equal(store.get(daily.id).done, false, 'ежедневное не выполняется окончательно');
  assert.equal(store.get(daily.id).firedAt, NOW.toISOString());

  store.markFired(missed.id, NOW);
  assert.equal(store.get(missed.id).dueAt, '2026-10-28T09:00:00.000Z', 'пропущенные дни сдвигаются до ближайшего будущего');

  store.markFired(edge.id, NOW);
  assert.equal(store.get(edge.id).dueAt, '2026-10-28T10:00:00.000Z', 'dueAt равный now уже считается прошлым');

  assert.equal(store.markFired('нет-такого', NOW), null);
});

test('tick: notify один раз на напоминание, late только при просрочке больше 5 минут', async (t) => {
  const store = newStore(t);
  store.add({ text: 'вовремя', dueAt: '2026-10-27T09:58:00Z' });
  store.add({ text: 'ровно пять', dueAt: '2026-10-27T09:55:00Z' });
  store.add({ text: 'опоздал', dueAt: '2026-10-27T09:50:00Z' });
  store.add({ text: 'ещё рано', dueAt: '2026-10-27T10:01:00Z' });

  const calls = [];
  const scheduler = new Scheduler({ store, notify: (n) => { calls.push(n); }, now: () => NOW });

  assert.equal(await scheduler.tick(), 3);
  assert.deepEqual(calls.map((c) => [c.text, c.late]), [
    ['опоздал', true],
    ['ровно пять', false],
    ['вовремя', false],
  ]);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['id', 'late', 'text']);
  assert.equal(await scheduler.tick(), 0, 'второй проход в тот же момент ничего не шлёт');
  assert.equal(calls.length, 3);
  assert.deepEqual(store.due(NOW), []);
});

test('ошибка notify не останавливает остальные и не отмечает напоминание доставленным', async (t) => {
  const store = newStore(t);
  store.add({ text: 'первое', dueAt: '2026-10-27T09:00:00Z' });
  store.add({ text: 'второе', dueAt: '2026-10-27T09:30:00Z' });
  let failing = true;
  const seen = [];
  const scheduler = new Scheduler({
    store,
    now: () => NOW,
    notify: async ({ text }) => {
      seen.push(text);
      if (text === 'первое' && failing) throw new Error('окно недоступно');
    },
  });

  assert.equal(await scheduler.tick(), 1);
  assert.deepEqual(seen, ['первое', 'второе']);
  assert.deepEqual(store.due(NOW).map((r) => r.text), ['первое'], 'неотправленное остаётся в очереди');

  failing = false;
  assert.equal(await scheduler.tick(), 1);
  assert.deepEqual(store.due(NOW), []);
});

test('ежедневное: в один момент не уходит дважды, на следующие сутки приходит снова', async (t) => {
  const store = newStore(t);
  store.add({ text: 'зарядка', dueAt: '2026-10-27T09:00:00Z', repeat: 'daily' });
  let clock = new Date('2026-10-27T09:00:00Z');
  const late = [];
  const scheduler = new Scheduler({ store, notify: (n) => { late.push(n.late); }, now: () => clock });

  assert.equal(await scheduler.tick(), 1);
  assert.equal(await scheduler.tick(), 0);

  clock = new Date('2026-10-28T09:00:00Z');
  assert.equal(await scheduler.tick(), 1);
  assert.deepEqual(late, [false, false]);
});

test('параллельный tick не дублирует отправку', async (t) => {
  const store = newStore(t);
  store.add({ text: 'одно', dueAt: '2026-10-27T09:00:00Z' });
  const scheduler = new Scheduler({ store, notify: () => {}, now: () => NOW });

  const results = await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.deepEqual(results, [1, 0]);
});

test('start сразу отправляет созревшие напоминания', async (t) => {
  const store = newStore(t);
  store.add({ text: 'сразу', dueAt: '2026-10-27T09:00:00Z' });
  const sent = [];
  const scheduler = new Scheduler({
    store,
    notify: (n) => { sent.push(n.text); },
    now: () => NOW,
    intervalMs: 1e9,
  });

  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.stop();
  assert.deepEqual(sent, ['сразу']);
});

test('повторный start не создаёт второй таймер; stop его снимает', (t) => {
  const scheduler = new Scheduler({ store: newStore(t), notify: () => {}, now: () => NOW, intervalMs: 1e9 });
  const setSpy = t.mock.method(globalThis, 'setInterval');
  const clearSpy = t.mock.method(globalThis, 'clearInterval');

  scheduler.start();
  scheduler.start();
  assert.equal(setSpy.mock.callCount(), 1, 'второй start не заводит таймер');
  assert.equal(setSpy.mock.calls[0].result.hasRef(), false, 'таймер не держит процесс');

  scheduler.stop();
  scheduler.stop();
  assert.equal(clearSpy.mock.callCount(), 1);

  scheduler.start();
  assert.equal(setSpy.mock.callCount(), 2, 'после stop start снова заводит таймер');
  scheduler.stop();
});

test('remindersTools: четыре инструмента, риск T2 только у отмены', (t) => {
  const tools = remindersTools(newStore(t), { now: () => NOW });

  assert.deepEqual(tools.map((tool) => tool.name), ['remind_in', 'remind_at', 'list_reminders', 'cancel_reminder']);
  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.risk])),
    { remind_in: 'T0', remind_at: 'T0', list_reminders: 'T0', cancel_reminder: 'T2' }
  );
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.run, 'function');
    assert.equal(tool.parameters.type, 'object');
  }

  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  assert.equal(registry.list().length, 4);
});

test('remind_in и remind_at ставят напоминания, list показывает, cancel удаляет', async (t) => {
  const store = newStore(t);
  const [remindIn, remindAt, listReminders, cancelReminder] = remindersTools(store, { now: () => NOW });

  const inTen = await remindIn.run({ minutes: 10, text: 'чай' });
  assert.equal(inTen.ok, true);
  assert.equal(inTen.summary, 'напомню через 10 мин');
  assert.equal(store.get(inTen.data.id).dueAt, '2026-10-27T10:10:00.000Z');

  // +03:00 это 10:30 UTC; в ответе время по локальным часам машины.
  const at = await remindAt.run({ at: '2026-10-27T13:30:00+03:00', text: 'звонок' });
  assert.equal(at.ok, true);
  const local = new Date('2026-10-27T10:30:00Z');
  const date = `${String(local.getDate()).padStart(2, '0')}.${String(local.getMonth() + 1).padStart(2, '0')}.${local.getFullYear()}`;
  assert.equal(at.summary, `напомню ${date} в ${localHhmm(local)} (местное время)`);
  assert.equal(store.get(at.data.id).dueAt, '2026-10-27T10:30:00.000Z');

  const listed = await listReminders.run({});
  assert.equal(listed.ok, true);
  assert.equal(listed.summary, 'напоминаний: 2');
  assert.deepEqual(listed.data.map((r) => r.text), ['чай', 'звонок']);
  assert.deepEqual(Object.keys(listed.data[0]).sort(), ['dueAt', 'id', 'repeat', 'text']);

  const gone = await cancelReminder.run({ id: inTen.data.id });
  assert.equal(gone.ok, true);
  assert.equal(gone.summary, 'отменил');
  const again = await cancelReminder.run({ id: inTen.data.id });
  assert.equal(again.ok, false);
  assert.equal(again.summary, 'такого напоминания нет');
  assert.equal((await listReminders.run({})).summary, 'напоминаний: 1');
});

test('инструменты отказывают на плохом вводе и не создают файл', async (t) => {
  const file = path.join(tempDir(t), 'reminders.json');
  const [remindIn, remindAt, , cancelReminder] = remindersTools(new ReminderStore(file), { now: () => NOW });

  for (const minutes of [0, 10081, 1.5, 'abc', undefined]) {
    const res = await remindIn.run({ minutes, text: 'x' });
    assert.equal(res.ok, false, `minutes=${String(minutes)} должно отклоняться`);
    assert.equal(typeof res.summary, 'string');
  }
  assert.equal((await remindIn.run({ minutes: 5, text: '   ' })).ok, false);

  const past = await remindAt.run({ at: '2026-10-27T09:59:00Z', text: 'поздно' });
  assert.deepEqual({ ok: past.ok, summary: past.summary }, { ok: false, summary: 'время уже прошло' });
  for (const at of ['завтра', '2026-13-45T10:00:00Z', '2027-02-29T10:00:00Z', '2027-02-30T10:00:00Z', '2027-01-01T24:00:00Z']) {
    const res = await remindAt.run({ at, text: 'x' });
    assert.equal(res.ok, false, `at=${at} должно отклоняться`);
  }

  const noId = await cancelReminder.run({});
  assert.deepEqual({ ok: noId.ok, summary: noId.summary }, { ok: false, summary: 'пустой id' });
  assert.equal(fs.existsSync(file), false);
});

test('инструменты возвращают {ok: false}, если файл напоминаний повреждён', async (t) => {
  const file = path.join(tempDir(t), 'reminders.json');
  fs.writeFileSync(file, '{не json', 'utf8');
  const [, , listReminders, cancelReminder] = remindersTools(new ReminderStore(file), { now: () => NOW });

  const listed = await listReminders.run({});
  assert.equal(listed.ok, false);
  assert.match(listed.summary, /повреждён/);

  const gone = await cancelReminder.run({ id: 'любой' });
  assert.equal(gone.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{не json');
});

// ── Правка, повтор, просрочка и перезапуск (этап 3) ──────────────────────────

test('update: текст и время меняются, id/createdAt целы; перенесённое разовое снова ждёт срабатывания', (t) => {
  const file = path.join(tempDir(t), 'reminders.json');
  const store = new ReminderStore(file);
  const created = store.add({ text: 'позвонить', dueAt: '2026-10-27T09:00:00Z' });
  store.markFired(created.id, NOW);
  assert.equal(store.get(created.id).done, true);

  const updated = store.update(created.id, { text: 'позвонить маме', dueAt: '2026-10-28T09:00:00Z' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.text, 'позвонить маме');
  assert.equal(updated.dueAt, '2026-10-28T09:00:00.000Z');
  assert.equal(updated.done, false, 'перенесённое разовое не остаётся выполненным');
  assert.equal(updated.firedAt, null);

  const restarted = new ReminderStore(file);
  assert.equal(restarted.get(created.id).text, 'позвонить маме', 'правка переживает перезапуск');
  assert.equal(restarted.update('нет-такого', { text: 'x' }), null);
});

test('update: пустой текст, плохая дата и repeat вне набора отклоняются без записи', (t) => {
  const file = path.join(tempDir(t), 'reminders.json');
  const store = new ReminderStore(file);
  const created = store.add({ text: 'чай', dueAt: '2026-10-27T12:00:00Z' });
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(() => store.update(created.id, { text: '   ' }), /пустой/);
  assert.throws(() => store.update(created.id, { dueAt: 'завтра' }), /плохая дата/);
  assert.throws(() => store.update(created.id, { repeat: 'hourly' }), /repeat/);
  assert.throws(() => store.update(created.id, null), /объект/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'после отказа файл не переписан');

  store.update(created.id, { repeat: 'daily' });
  assert.equal(store.get(created.id).repeat, 'daily');
  store.update(created.id, { repeat: null });
  assert.equal(store.get(created.id).repeat, null);

  // Чужое пространство не правится: id тот же, но пространство другое.
  const alpha = '11111111-1111-4111-8111-111111111111';
  const foreign = store.add({ text: 'чужое', dueAt: '2026-10-28T12:00:00Z', workspaceId: alpha });
  assert.equal(store.update(foreign.id, { text: 'подмена' }, { workspaceId: 'default' }), null);
  assert.equal(store.get(foreign.id).text, 'чужое');
  assert.equal(store.update(foreign.id, { text: 'своё' }, { workspaceId: alpha }).text, 'своё');
});

test('повтор и часовой пояс: daily переживает перезапуск и не дублируется после рестарта', async (t) => {
  const file = path.join(tempDir(t), 'reminders.json');
  const store = new ReminderStore(file);
  // Один и тот же момент, заданный с разными поясами, хранится как UTC ISO — без сдвига.
  const daily = store.add({ text: 'зарядка', dueAt: '2026-10-27T09:00:00+03:00', repeat: 'daily' });
  assert.equal(daily.dueAt, '2026-10-27T06:00:00.000Z');

  let clock = new Date('2026-10-27T06:00:00Z');
  const sent = [];
  let scheduler = new Scheduler({ store, notify: (n) => { sent.push(n.late); }, now: () => clock });
  assert.equal(await scheduler.tick(), 1);
  assert.deepEqual(sent, [false]);

  // Перезапуск: новый экземпляр видит сдвинутый срок и отметку срабатывания.
  const restarted = new ReminderStore(file);
  const saved = restarted.get(daily.id);
  assert.equal(saved.repeat, 'daily');
  assert.equal(saved.dueAt, '2026-10-28T06:00:00.000Z');
  assert.equal(saved.firedAt, clock.toISOString());
  assert.equal(await new Scheduler({ store: restarted, notify: () => { throw new Error('не должно звонить'); }, now: () => clock }).tick(), 0, 'повторно в тот же момент не приходит');

  clock = new Date('2026-10-28T06:00:00Z');
  scheduler = new Scheduler({ store: restarted, notify: (n) => { sent.push(n.late); }, now: () => clock });
  assert.equal(await scheduler.tick(), 1, 'на следующий день ежедневное приходит снова');
});

test('просрочка и отмена переживают перезапуск: недоставленное ждёт, отменённое не возвращается', async (t) => {
  const file = path.join(tempDir(t), 'reminders.json');
  const first = new ReminderStore(file);
  const overdue = first.add({ text: 'просроченное', dueAt: '2026-10-27T09:00:00Z' });

  const restarted = new ReminderStore(file);
  assert.deepEqual(restarted.due(NOW).map((r) => r.text), ['просроченное'], 'после рестарта просрочка в очереди');
  const calls = [];
  assert.equal(await new Scheduler({ store: restarted, notify: (n) => { calls.push(n); }, now: () => NOW }).tick(), 1);
  assert.equal(calls[0].late, true, 'просрочка больше 5 минут отмечена честно');

  const second = restarted.add({ text: 'отменить', dueAt: '2026-10-27T12:00:00Z' });
  assert.equal(new ReminderStore(file).cancel(second.id), true);
  const afterCancel = new ReminderStore(file);
  assert.equal(afterCancel.get(second.id), null, 'отмена переживает перезапуск');
  assert.deepEqual(afterCancel.list({ includeDone: true }).map((r) => r.text), ['просроченное']);
  assert.equal(new ReminderStore(file).get(overdue.id).done, true, 'доставленное разовое закрыто');
});

test('по будням: пропуск выходных, один показ после простоя, отмена всей серии', async (t) => {
  const store = newStore(t);
  let clock = new Date('2027-01-01T00:00:00Z');
  const [, remindAt, list, cancel] = remindersTools(store, { now: () => clock });
  const added = await remindAt.run({
    text: 'план на день', at: '2027-01-02T09:00', repeat: 'weekdays', timeZone: 'Asia/Tokyo',
  });
  assert.equal(added.ok, true);
  assert.equal(added.data.dueAt, '2027-01-04T00:00:00.000Z');
  assert.equal((await remindAt.verify({}, added)).status, 'confirmed');
  assert.equal((await list.run()).data[0].repeat, 'weekdays');

  clock = new Date('2027-01-09T01:00:00Z');
  const reopened = new ReminderStore(store.filePath);
  const calls = [];
  const scheduler = new Scheduler({ store: reopened, now: () => clock, notify: (item) => calls.push(item) });
  assert.equal(await scheduler.tick(), 1);
  assert.equal(await scheduler.tick(), 0);
  assert.equal(calls[0].late, true);
  assert.equal(reopened.get(added.data.id).dueAt, '2027-01-11T00:00:00.000Z');
  const cancelled = await cancel.run({ id: added.data.id });
  assert.equal(cancelled.ok, true);
  assert.equal((await cancel.verify({}, cancelled)).status, 'confirmed');
  clock = new Date('2027-01-11T00:00:00Z');
  assert.equal(await scheduler.tick(), 0);
});

test('еженедельно: перевод часов весной сдвигает только одно срабатывание', async (t) => {
  const store = newStore(t);
  const [, remindAt] = remindersTools(store, { now: () => NOW });
  const args = { text: 'отчёт', repeat: 'weekly', timeZone: 'America/New_York' };
  assert.match((await remindAt.run({ ...args, at: '2027-03-14T02:30' })).summary, /нет из-за перевода часов/);
  assert.match((await remindAt.run({ ...args, at: '2027-11-07T01:30' })).summary, /повторяется/);
  assert.match((await remindAt.run({ ...args, at: '2027-03-07T02:30', timeZone: 'Unknown/Zone' })).summary, /timeZone/);
  const { data } = await remindAt.run({ ...args, at: '2027-03-07T02:30' });
  let clock = new Date('2027-03-07T07:30:00Z');
  const scheduler = new Scheduler({ store, now: () => clock, notify: () => {} });
  assert.equal(await scheduler.tick(), 1);
  assert.equal(store.get(data.id).dueAt, '2027-03-14T07:30:00.000Z'); // 03:30 после перевода
  clock = new Date('2027-03-14T07:29:59Z');
  assert.equal(await scheduler.tick(), 0);
  clock = new Date('2027-03-14T07:30:00Z');
  assert.equal(await scheduler.tick(), 1);
  assert.equal(store.get(data.id).dueAt, '2027-03-21T06:30:00.000Z'); // снова 02:30
});

test('еженедельно: повторяющийся осенью час даёт один показ даже после перезапуска', async (t) => {
  const store = newStore(t);
  const record = store.add({ text: 'отчёт', dueAt: '2027-10-31T01:30:00-04:00', repeat: 'weekly', timeZone: 'America/New_York' });
  let clock = new Date(record.dueAt);
  const scheduler = new Scheduler({ store, now: () => clock, notify: () => {} });
  assert.equal(await scheduler.tick(), 1);
  assert.equal(store.get(record.id).dueAt, '2027-11-07T05:30:00.000Z');
  clock = new Date('2027-11-07T05:30:00Z');
  assert.equal(await scheduler.tick(), 1);
  clock = new Date('2027-11-07T06:30:00Z');
  const reopened = new ReminderStore(store.filePath);
  assert.equal(await new Scheduler({ store: reopened, now: () => clock, notify: () => {} }).tick(), 0);
  assert.equal(reopened.get(record.id).dueAt, '2027-11-14T06:30:00.000Z');
});

test('ежемесячно: високосный февраль, возврат к 31 числу и перенос серии', (t) => {
  const store = newStore(t);
  const { id } = store.add({ text: 'счёт', dueAt: '2027-12-31T23:45:00-05:00', repeat: 'monthly', timeZone: 'America/New_York' });
  for (const [fired, next] of [
    ['2028-01-01T04:45:00Z', '2028-02-01T04:45:00.000Z'],
    ['2028-02-01T04:45:00Z', '2028-03-01T04:45:00.000Z'],
    ['2028-03-01T04:45:00Z', '2028-04-01T03:45:00.000Z'],
    ['2028-04-01T03:45:00Z', '2028-05-01T03:45:00.000Z'],
    ['2028-05-01T03:45:00Z', '2028-06-01T03:45:00.000Z'],
  ]) {
    store.update(id, { text: 'оплатить счёт', repeat: 'monthly' });
    assert.equal(store.markFired(id, fired).dueAt, next);
  }
  const moved = store.update(id, { dueAt: '2029-01-31T10:00:00Z', timeZone: 'UTC' });
  assert.equal(store.markFired(id, moved.dueAt).dueAt, '2029-02-28T10:00:00.000Z');
  assert.equal(store.markFired(id, '2029-02-28T10:00:00Z').dueAt, '2029-03-31T10:00:00.000Z');
});

test('отмена и перенос во время доставки не дают завершить устаревшие сроки', async (t) => {
  const store = newStore(t);
  const { id } = store.add({ text: 'перенос', dueAt: '2026-10-27T09:00:00Z', repeat: 'weekly', timeZone: 'UTC' });
  const cancelled = store.add({ text: 'отмена', dueAt: '2026-10-27T09:10:00Z', repeat: 'monthly', timeZone: 'UTC' });
  const calls = [];
  const movedTo = '2026-10-28T09:00:00.000Z';
  const scheduler = new Scheduler({
    store, now: () => NOW,
    notify: async (item) => {
      calls.push(item.id);
      store.update(id, { dueAt: movedTo });
      store.cancel(cancelled.id);
    },
  });
  assert.equal(await scheduler.tick(), 1);
  assert.deepEqual(calls, [id]);
  assert.equal(store.get(id).dueAt, movedTo);
  assert.equal(store.get(id).firedAt, null);
  assert.equal(store.get(cancelled.id), null);
});

test('сбой сохранения после доставки повторяет запись без второго уведомления', async (t) => {
  const store = newStore(t);
  const record = store.add({ text: 'еженедельно', dueAt: NOW, repeat: 'weekly', timeZone: 'UTC' });
  const markFired = store.markFired.bind(store);
  let fail = true;
  t.mock.method(store, 'markFired', (...args) => {
    if (fail) throw new Error('сбой записи');
    return markFired(...args);
  });
  const calls = [];
  const scheduler = new Scheduler({ store, now: () => NOW, notify: (item) => calls.push(item.id) });
  await assert.rejects(scheduler.tick(), /сбой записи/);
  fail = false;
  assert.equal(await scheduler.tick(), 0);
  assert.deepEqual(calls, [record.id]);
  assert.equal(store.get(record.id).dueAt, '2026-11-03T10:00:00.000Z');
});
