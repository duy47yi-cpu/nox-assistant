'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DealStore, syncDeals, markInterrupted, hanging, hangingText, isHangingPhrase, tailJsonl } = require('../src/deals/deals');
const { dealTools } = require('../src/tools/deals');

const NOW = Date.parse('2026-10-31T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

function open(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-deals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = path.join(dir, 'deals.jsonl');
  const snapshot = path.join(dir, 'deals.json');
  return { dir, events, snapshot, store: new DealStore(events, snapshot, { now: () => NOW }) };
}

test('снимок и события: перезапуск, отставший снимок, битый снимок, битая строка', (t) => {
  const { events, snapshot, store } = open(t);
  store.upsert({ ref: 'a', title: 'A', source: 'task', state: 'waiting', reason: 'r' });
  const fresh = () => new DealStore(events, snapshot, { now: () => NOW });
  assert.equal(fresh().get('a').title, 'A');

  // Снимок отстал: сбой между записью события и снимком.
  const old = fs.readFileSync(snapshot, 'utf8');
  store.upsert({ ref: 'a', title: 'A', source: 'task', state: 'failed', reason: 'x' });
  fs.writeFileSync(snapshot, old);
  assert.equal(fresh().get('a').state, 'failed');

  fs.writeFileSync(snapshot, '{битый');
  fs.appendFileSync(events, '{обрыв\n');
  const rebuilt = fresh();
  assert.equal(rebuilt.get('a').state, 'failed');
  assert.equal(rebuilt.get('a').title, 'A');
});

test('повторная сверка без изменений не пишет новых событий', (t) => {
  const { events, store } = open(t);
  const sources = { reminders: [{ id: 'r', text: 'чай', dueAt: ago(-5) }], now: NOW };
  syncDeals(store, sources);
  syncDeals(store, sources);
  assert.equal(fs.readFileSync(events, 'utf8').trim().split('\n').length, 1);
});

test('сверка: задачи по статусам, напоминание исчезло — дело закрыто, источник главнее', (t) => {
  const { store } = open(t);
  syncDeals(store, {
    tasks: [
      { id: '1', title: 'т1', status: 'blocked', reason: 'лимит' },
      { id: '2', title: 'т2', status: 'unverified', verdict: { code: 'failed', reason: 'нет файла' } },
      { id: '3', title: 'т3', status: 'unverified', verdict: { code: 'unverified' } },
      { id: '4', title: 'т4', status: 'done' },
      { id: '5', title: 'т5', status: 'draft' },
    ],
    reminders: [{ id: 'r', text: 'чай', dueAt: ago(5) }],
    now: NOW,
  });
  assert.equal(store.get('task:1').state, 'waiting');
  assert.equal(store.get('task:2').state, 'failed');
  assert.equal(store.get('task:3').reason, 'unknown');
  assert.equal(store.get('task:4').state, 'done');
  assert.equal(store.get('task:5'), null);
  assert.equal(hanging(store, { now: NOW }).overdue[0].title, 'чай');

  syncDeals(store, { now: NOW });
  assert.equal(store.get('reminder:r').cleared, true);
  assert.equal(hanging(store, { now: NOW }).overdue.length, 0);
});

test('разобранное не воскресает от сверки, но новое состояние возвращает его', (t) => {
  const { store } = open(t);
  const tasks = (status) => ({ tasks: [{ id: '1', title: 'т', status, reason: 'р' }], now: NOW });
  syncDeals(store, tasks('blocked'));
  store.clear('task:1');
  syncDeals(store, tasks('blocked'));
  assert.equal(hanging(store, { now: NOW }).waiting.length, 0);
  syncDeals(store, tasks('running'));
  assert.equal(store.get('task:1').cleared, false);
});

test('журнал: провал висит до разбора, не проверенное старше суток не появляется', (t) => {
  const { store } = open(t);
  syncDeals(store, {
    journal: [
      { ts: ago(90), tool: 'app_close', callId: 'c1', verified: 'failed', evidence: 'процесс работает' },
      { ts: ago(30), tool: 'speak', callId: 'c2', verified: 'unknown' },
      { ts: ago(3000), tool: 'volume_set', callId: 'c3', verified: 'unknown' },
      { ts: ago(10), tool: 'workspace_write', callId: 'c4', verified: 'confirmed' },
    ],
    now: NOW,
  });
  const g = hanging(store, { now: NOW });
  assert.deepEqual(g.failed.map((d) => d.title), ['app_close']);
  assert.deepEqual(g.unverified.map((d) => d.title), ['speak']);
  assert.equal(store.get('call:c3'), null);
  assert.equal(store.get('call:c4'), null);
});

test('старт без конца после перезапуска — вызов прерван и ждёт владельца', (t) => {
  const { store } = open(t);
  const made = markInterrupted(store, [
    { kind: 'tool_start', callId: 'a', name: 'app_open', ts: ago(5) },
    { kind: 'tool', callId: 'a', name: 'app_open' },
    { kind: 'tool_start', callId: 'b', name: 'shell_run', ts: ago(3) },
  ]);
  assert.deepEqual(made.map((d) => d.ref), ['call:b']);
  const g = hanging(store, { now: NOW });
  assert.equal(g.waiting[0].title, 'shell_run');
  assert.match(g.waiting[0].reason, /прерван/);
});

test('застрявшее и текст ответа; пусто — одна строка', (t) => {
  const { store } = open(t);
  assert.equal(hangingText(hanging(store, { now: NOW }), { now: NOW }), 'Ничего не висит.');
  store.upsert({ ref: 'task:1', title: 'старая', source: 'task', state: 'started', since: ago(11) });
  store.upsert({ ref: 'task:2', title: 'свежая', source: 'task', state: 'started', since: ago(2) });
  const text = hangingText(hanging(store, { now: NOW }), { now: NOW });
  assert.match(text, /Идёт дольше 10 минут/);
  assert.match(text, /старая/);
  assert.doesNotMatch(text, /свежая/);
});

test('фраза распознаётся строго: обычная просьба к модели не уходит в дела', () => {
  for (const p of ['что повисло', 'Что висит?', 'что у нас висит', 'что зависло.']) assert.ok(isHangingPhrase(p), p);
  for (const p of ['что повисло в браузере и почему', 'почини то что висит', '']) assert.ok(!isHangingPhrase(p), p);
});

test('хвост журнала отбрасывает обрезанную первую строку', (t) => {
  const { dir } = open(t);
  const file = path.join(dir, 'j.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ a: 'x'.repeat(100) })}\n${JSON.stringify({ a: 1 })}\n`);
  assert.deepEqual(tailJsonl(file, 20), [{ a: 1 }]);
  assert.deepEqual(tailJsonl(path.join(dir, 'нет.jsonl')), []);
});

test('инструменты: deals_hanging отвечает, deal_clear убирает с подтверждением', async (t) => {
  const { store } = open(t);
  store.upsert({ ref: 'task:1', title: 'т', source: 'task', state: 'failed', reason: 'р' });
  const [list, clear] = dealTools(store);
  const out = await list.run();
  assert.equal(out.data.items[0].ref, 'task:1');
  const cleared = await clear.run({ ref: 'task:1' });
  assert.equal((await clear.verify({}, cleared)).status, 'confirmed');
  assert.equal((await clear.run({ ref: 'нет' })).ok, false);
});

test('deal_add: обещание с сроком записано, читается обратно и просрочивается в «что повисло»', async (t) => {
  const { store } = open(t);
  const [, clear, add] = dealTools(store);
  const dueIso = ago(5);
  const out = await add.run({ text: '  отправить отчёт  ', due: dueIso });
  assert.equal(out.ok, true);
  assert.equal(out.data.title, 'отправить отчёт');
  assert.equal((await add.verify({}, out)).status, 'confirmed');
  assert.equal(store.get(out.data.ref).state, 'promised');
  assert.equal(hanging(store, { now: NOW }).overdue[0].title, 'отправить отчёт');

  // Сверка с источниками не трогает обещание: его снимает только владелец.
  syncDeals(store, { now: NOW });
  assert.equal(store.get(out.data.ref).cleared, false);
  assert.equal(hanging(store, { now: NOW }).overdue.length, 1);

  await clear.run({ ref: out.data.ref });
  assert.equal((await add.verify({}, out)).status, 'failed');
});

test('deal_add: без срока, пустой текст и плохой срок отклоняются', async (t) => {
  const { store } = open(t);
  const [, , add] = dealTools(store);
  const plain = await add.run({ text: 'позвонить' });
  assert.equal(plain.ok, true);
  assert.equal(store.get(plain.data.ref).due, null);
  assert.equal((await add.run({ text: '   ' })).ok, false);
  assert.equal((await add.run({ text: 'x'.repeat(301) })).ok, false);
  assert.equal((await add.run({ text: 'а', due: 'когда-нибудь' })).ok, false);
});

test('журнал скорости не принимает объект вместо пути и не создаёт файл «[object Object]»', () => {
  const { TurnLog } = require('../src/agent/turnlog');
  const log = new TurnLog({ path: 'x' });
  assert.equal(log.enabled, false);
  log.write({ kind: 'turn' });
  assert.equal(new TurnLog('a.jsonl').enabled, true);
});

test('в ответе «что повисло» действие названо словами', (t) => {
  const { store } = open(t);
  store.upsert({ ref: 'call:a', title: 'shell_run', source: 'interrupted', state: 'waiting', reason: 'прервано', since: ago(1) });
  assert.match(hangingText(hanging(store, { now: NOW }), { now: NOW }), /Команда PowerShell: прервано/);
});
