'use strict';

// Задача на диске: отметка до действия, лимиты, сверка с настоящим состоянием, никакого слепого повтора после падения.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MissionStore } = require('../src/missions/store');
const { MissionScheduler } = require('../src/missions/scheduler');
const { checkExpected, missionVerdict, runMission } = require('../src/missions/runner');
const { ToolRegistry } = require('../src/tools/registry');

function storeIn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-missions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new MissionStore(path.join(dir, 'missions.json')) };
}

const T0 = new Date('2026-11-01T10:00:00Z');
const later = (min) => new Date(T0.getTime() + min * 60000);
const schedule = { type: 'interval', minutes: 60 };

test('падение посреди задачи: отметка на диске, срок сдвинут, повторного запуска нет', async (t) => {
  const { store } = storeIn(t);
  const m = store.add({ goal: 'x', schedule }, T0);
  const sched = new MissionScheduler({ store, now: () => later(61), notify: () => {}, run: async () => { throw new Error('не должен доходить'); } });
  store.markStart(m.id, { now: later(61) });
  const saved = store.get(m.id);
  assert.equal(saved.status, 'running');
  assert.deepEqual(store.due(later(62)), []);
  assert.equal(sched.store.interrupted().length, 1);
});

test('сверка: результата нет — interrupted, уведомление, без запуска', async (t) => {
  const { store } = storeIn(t);
  const m = store.add({ goal: 'создай отчёт', schedule, expect: [{ kind: 'file', target: 'a.txt' }] }, T0);
  store.markStart(m.id, { now: later(61) });
  const notes = [];
  let runs = 0;
  const sched = new MissionScheduler({ store, now: () => later(70), notify: (n) => notes.push(n), probe: async () => false, run: async () => { runs += 1; return { report: 'r' }; } });
  await sched.reconcile();
  const item = store.get(m.id);
  assert.equal(item.lastVerdict, 'interrupted');
  assert.equal(item.status, 'idle');
  assert.match(item.lastResult, /повтора не было/);
  assert.equal(notes.length, 1);
  assert.equal(runs, 0);
});

test('сверка передаёт пространство миссии проверщику, чтобы читать его рабочую папку', async (t) => {
  const { store } = storeIn(t);
  const mission = store.add({ goal: 'проверь отчёт', schedule, workspaceId: 'work-1', expect: [{ kind: 'file', target: 'reports/out.md' }] }, T0);
  store.markStart(mission.id, { now: later(61) });
  let received;
  const scheduler = new MissionScheduler({ store, now: () => later(70), probe: async (_spec, _since, row) => { received = row; return false; }, run: async () => ({ report: '' }) });
  await scheduler.reconcile();
  assert.equal(received.workspaceId, 'work-1');
});

test('уведомление о запуске сохраняет метку пространства', async (t) => {
  const { store } = storeIn(t);
  store.add({ goal: 'собери отчёт', schedule, workspaceId: 'work-1' }, T0);
  const notes = [];
  const scheduler = new MissionScheduler({ store, now: () => later(61), notify: (item) => notes.push(item), run: async () => ({ report: 'готово', verdict: 'done', outcome: 'answer' }) });
  await scheduler.tick();
  assert.equal(notes[0].workspaceId, 'work-1');
});

test('сверка: результат на месте — done, владельца не дёргаем', async (t) => {
  const { store } = storeIn(t);
  const m = store.add({ goal: 'x', schedule, expect: [{ kind: 'file', target: 'a.txt' }] }, T0);
  store.markStart(m.id, { now: later(61) });
  const notes = [];
  const sched = new MissionScheduler({ store, now: () => later(70), notify: (n) => notes.push(n), probe: async () => true, run: async () => ({ report: 'r' }) });
  await sched.reconcile();
  assert.equal(store.get(m.id).lastVerdict, 'done');
  assert.equal(notes.length, 0);
});

test('итог «failed» не называется выполненной задачей', async (t) => {
  const { store } = storeIn(t);
  store.add({ goal: 'x', schedule }, T0);
  const notes = [];
  const sched = new MissionScheduler({ store, now: () => later(61), notify: (n) => notes.push(n), run: async () => ({ report: 'лимит', verdict: 'failed' }) });
  await sched.tick();
  assert.match(notes[0].title, /не выполнена/);
});

test('checkExpected: сбой чтения — неизвестно, а не успех и не провал', async () => {
  const e = [{ kind: 'file', target: 'a' }];
  assert.equal((await checkExpected(e, async () => null)).met, null);
  assert.equal((await checkExpected(e, async () => { throw new Error('x'); })).met, null);
  assert.equal((await checkExpected(e, async () => true)).met, true);
  assert.equal((await checkExpected(e, async () => false)).met, false);
  assert.equal((await checkExpected([], async () => true)).met, null);
  assert.equal((await checkExpected([{ kind: 'window', target: 'a', until: 'gone' }], async () => false)).met, true);
});

test('missionVerdict: слова модели не доказывают результат', () => {
  const v = (outcome, met, blockedDesktop = false) => missionVerdict({ outcome, blockedDesktop, check: { met } });
  assert.equal(v('answer', true), 'done');
  assert.equal(v('answer', null), 'unverified');
  assert.equal(v('answer', false), 'failed');
  assert.equal(v('limit', true), 'failed');
  assert.equal(v('stopped', null), 'stopped');
  assert.equal(v('answer', true, true), 'blocked_desktop');
});

test('в делах у задачи первая фраза, а не инструкция для модели', () => {
  const { missionTitle } = require('../src/deals/deals');
  assert.equal(missionTitle('Утренний брифинг. Вызови skill_read с именем briefing.'), 'Утренний брифинг');
  assert.equal(missionTitle('Проверить папку v1.2 загрузок'), 'Проверить папку v1.2 загрузок');
});

test('add: проверяет ожидания и лимиты до записи', (t) => {
  const { store } = storeIn(t);
  assert.throws(() => store.add({ goal: 'x', schedule, expect: [{ kind: 'bad', target: 'a' }] }, T0), /kind/);
  assert.throws(() => store.add({ goal: 'x', schedule, limits: { maxSteps: 1000 } }, T0), /maxSteps/);
  assert.equal(store.list().length, 0);
  const ok = store.add({ goal: 'x', schedule, limits: { maxSteps: 5, maxMinutes: 2 } }, T0);
  assert.deepEqual(ok.limits, { maxSteps: 5, maxMinutes: 2 });
});

test('runMission: лимит шагов из задачи и итог с проверкой в отчёте', async (t) => {
  const { dir } = storeIn(t);
  const tools = new ToolRegistry();
  let calls = 0;
  tools.register({ name: 'look', risk: 'T0', description: 'x', parameters: { type: 'object', properties: {} }, run: async () => { calls += 1; return { ok: true, summary: String(calls) }; } });
  let step = 0;
  const brain = { chat: async () => {
    step += 1;
    if (step > 10) return { content: 'конец', toolCalls: [] };
    return { content: '', toolCalls: [{ id: `c${step}`, name: 'look', args: { n: step } }] };
  } };
  const mission = { id: 'm1', goal: 'смотри', limits: { maxSteps: 2 }, expect: [{ kind: 'file', target: 'a' }] };
  const out = await runMission(mission, { brain, tools, journal: { append: () => {} }, workspace: dir, reportsDir: path.join(dir, 'r'), probe: async () => true });
  assert.ok(calls <= 2, `вызовов ${calls}`);
  assert.match(fs.readFileSync(out.file, 'utf8'), /Итог:/);
});

test('runMission: занятый стол даёт blocked_desktop', async (t) => {
  const { dir } = storeIn(t);
  const { DesktopLock, guardDesktopTools } = require('../src/control/desktop-lock');
  const lock = new DesktopLock({ idleSeconds: () => 1 });
  const tools = new ToolRegistry();
  for (const tool of guardDesktopTools([{ name: 'ui_focus', risk: 'T0', description: 'x', parameters: { type: 'object', properties: {} }, run: async () => ({ ok: true, summary: 'нажал' }) }], lock)) tools.register(tool);
  let step = 0;
  const brain = { chat: async () => { step += 1; return step === 1 ? { content: '', toolCalls: [{ id: 'c1', name: 'ui_focus', args: {} }] } : { content: 'всё', toolCalls: [] }; } };
  const out = await runMission({ id: 'm2', goal: 'x' }, { brain, tools, journal: { append: () => {} }, workspace: dir, reportsDir: path.join(dir, 'r') });
  assert.equal(out.verdict, 'blocked_desktop');
});
