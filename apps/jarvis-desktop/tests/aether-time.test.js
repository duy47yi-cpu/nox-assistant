'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const time = require('../renderer/aether/time');
const { createStore } = require('../renderer/aether/store');

const AETHER_DIR = path.join(__dirname, '..', 'renderer', 'aether');

function makeMemStorage() {
  const m = new Map();
  return {
    dump: () => [...m.entries()],
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function makeFakeBridge(rows = []) {
  const state = {
    chats: [{ id: 'c1', title: 'Первый чат', updatedAt: Date.now() }],
    activeId: 'c1',
  };
  const api = {
    getState: async () => ({ mode: 'ask', hasKey: true, stopped: false }),
    getSettings: async () => ({ motion: true, dictation: true, modelTier: 'fast', thinking: 'low' }),
    workspacesList: async () => ({ ok: true, workspaces: [{ id: 'default', name: 'Основное' }], currentId: 'default' }),
    chatList: async () => ({ ok: true, chats: state.chats, activeId: state.activeId }),
    chatHistory: async () => rows,
    chatSelect: async (id) => { state.activeId = id; return { ok: true }; },
    chatNew: async () => ({ ok: true, id: 'c2' }),
    chatClose: async () => ({ ok: true }),
    send: async () => ({ ok: true }),
    listApprovals: async () => [],
    accountState: async () => ({ enabled: false }),
    dictationState: async () => ({ ok: true, mode: 'listening', full: false, recording: false }),
    tasksAttention: async () => [],
  };
  return {
    ensureBridge: async () => 'electron',
    has: (name) => typeof api[name] === 'function',
    call: async (name, ...args) => api[name](...args),
    errText: (e) => (e && e.message) || String(e),
  };
}

const makeStore = (bridge, storage) => createStore({
  bridge, storage, ui: { scrub: (s) => s, toolTitle: (t) => t },
});

// Отметки внутри календарных суток: «сегодня» и «вчера» не зависят от часа запуска.
function dayAt(offsetDays, hours = 12, minutes = 30) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

test('Время: ЧЧ:ММ у реплики и честная пустая подпись без отметки', () => {
  const at = dayAt(0, 9, 5);
  assert.equal(time.formatClock(at), '09:05');
  assert.equal(time.formatClock(dayAt(0, 23, 59)), '23:59');
  for (const bad of [undefined, null, NaN, 0, -1, 'вчера']) {
    assert.equal(time.formatClock(bad), '');
  }
});

test('Время: в списке чатов сегодня — ЧЧ:ММ, вчера — «вчера», раньше — дата', () => {
  const now = dayAt(0, 18, 0);
  assert.equal(time.formatChatStamp(dayAt(0, 7, 4), now), '07:04');
  assert.equal(time.formatChatStamp(dayAt(-1, 23, 50), now), 'вчера');

  const older = dayAt(-6, 10, 0);
  const d = new Date(older);
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(time.formatChatStamp(older, now), `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`);

  const lastYear = new Date(older);
  lastYear.setFullYear(lastYear.getFullYear() - 1);
  assert.equal(
    time.formatChatStamp(lastYear.getTime(), now),
    `${pad(lastYear.getDate())}.${pad(lastYear.getMonth() + 1)}.${lastYear.getFullYear()}`,
  );
  assert.equal(time.formatChatStamp(undefined, now), '');
  assert.equal(time.formatChatStamp(0, now), '');
});

test('Время: группы «Сегодня» и «Ранее», чат без отметки не выдумывается', () => {
  const now = dayAt(0, 18, 0);
  const today = { id: 'a', updatedAt: dayAt(0, 0, 1) };
  const yesterday = { id: 'b', updatedAt: dayAt(-1, 23, 59) };
  const undated = { id: 'c' };
  const { today: t, earlier } = time.splitChats([today, yesterday, undated], now);
  assert.deepEqual(t, [today]);
  assert.deepEqual(earlier, [yesterday, undated]);
  assert.deepEqual(time.splitChats(null, now), { today: [], earlier: [] });
});

test('Время: отпечаток реплики стабилен, различает текст и режется по 2000 символов', () => {
  assert.equal(time.fingerprint('Открой блокнот'), time.fingerprint('Открой блокнот'));
  assert.notEqual(time.fingerprint('Открой блокнот'), time.fingerprint('Открой браузер'));
  assert.equal(time.fingerprint(null), time.fingerprint(''));
  const long = 'я'.repeat(2500);
  assert.equal(time.fingerprint(long), time.fingerprint(`${long.slice(0, 2000)}хвост`));
  assert.ok(Number.isInteger(time.fingerprint('текст')));
});

test('Время: история без отметок остаётся без времени, совпавший ход получает своё', () => {
  const rows = [
    { kind: 'user', text: 'Привет' },
    { kind: 'assistant', text: 'Здравствуйте!' },
  ];
  assert.deepEqual(time.withTurnTimes(rows, []), rows);
  assert.deepEqual(time.withTurnTimes(rows, undefined), rows);

  const u = dayAt(0, 10, 0);
  const a = dayAt(0, 10, 1);
  const turns = [{ h: time.fingerprint('Привет'), u, a }];
  const stamped = time.withTurnTimes(rows, turns);
  assert.equal(stamped[0].at, u);
  assert.equal(stamped[1].at, a);
  // Исходные строки истории не мутируются.
  assert.equal(rows[0].at, undefined);
  assert.equal(rows[1].at, undefined);

  const unknown = time.withTurnTimes(rows, [{ h: time.fingerprint('Другой вопрос'), u, a }]);
  assert.equal(unknown[0].at, undefined);
  assert.equal(unknown[1].at, undefined);

  const noReply = time.withTurnTimes(rows, [{ h: time.fingerprint('Привет'), u, a: null }]);
  assert.equal(noReply[0].at, u);
  assert.equal(noReply[1].at, undefined);
});

test('Время: несколько реплик ассистента на ход — подпись только у последней', () => {
  const rows = [
    { kind: 'user', text: 'Сделай презентацию' },
    { kind: 'assistant', text: 'Готовлю слайды' },
    { kind: 'assistant', text: 'Презентация готова' },
    { kind: 'user', text: 'Открой её' },
    { kind: 'assistant', text: 'Открыл' },
  ];
  const u1 = dayAt(0, 10, 0);
  const a1 = dayAt(0, 10, 4);
  const u2 = dayAt(0, 10, 5);
  const a2 = dayAt(0, 10, 6);
  const out = time.withTurnTimes(rows, [
    { h: time.fingerprint('Сделай презентацию'), u: u1, a: a1 },
    { h: time.fingerprint('Открой её'), u: u2, a: a2 },
  ]);
  assert.deepEqual(out.map((r) => r.at), [u1, undefined, a1, u2, a2]);
});

test('Время: одинаковые вопросы идут по порядку, лишний ход не подставляется', () => {
  const rows = [
    { kind: 'user', text: 'Ещё раз' },
    { kind: 'assistant', text: 'Первый ответ' },
    { kind: 'user', text: 'Ещё раз' },
    { kind: 'assistant', text: 'Второй ответ' },
  ];
  const h = time.fingerprint('Ещё раз');
  const out = time.withTurnTimes(rows, [
    { h, u: 1000, a: 2000 },
    { h, u: 3000, a: 4000 },
  ]);
  assert.deepEqual(out.map((r) => r.at), [1000, 2000, 3000, 4000]);

  const single = time.withTurnTimes(rows, [{ h, u: 1000, a: 2000 }]);
  assert.deepEqual(single.map((r) => r.at), [1000, 2000, undefined, undefined]);
});

test('Store: колонка истории открыта по умолчанию и переживает перезапуск', async () => {
  const storage = makeMemStorage();
  const store = makeStore(makeFakeBridge(), storage);
  await store.loadInitial();
  assert.equal(store.state.historyOpen, true);

  store.toggleHistory(false);
  assert.equal(store.state.historyOpen, false);
  assert.equal(storage.getItem('aether.historyOpen'), '0');

  const reopened = makeStore(makeFakeBridge(), storage);
  await reopened.loadInitial();
  assert.equal(reopened.state.historyOpen, false);

  reopened.toggleHistory();
  assert.equal(reopened.state.historyOpen, true);
  assert.equal(storage.getItem('aether.historyOpen'), '1');
});

test('Store: узкое окно прячет колонку, не затирая выбор владельца', async () => {
  const storage = makeMemStorage();
  const store = makeStore(makeFakeBridge(), storage);
  global.window = { innerWidth: 864 };
  try {
    await store.loadInitial();
    assert.equal(store.state.historyOpen, false);
    assert.equal(storage.getItem('aether.historyOpen'), null);

    global.window.innerWidth = 1200;
    store.syncHistoryViewport();
    assert.equal(store.state.historyOpen, true);

    // Владелец свернул сам — это решение сохраняется и после сужения/расширения.
    store.toggleHistory(false);
    global.window.innerWidth = 864;
    store.syncHistoryViewport();
    global.window.innerWidth = 1200;
    store.syncHistoryViewport();
    assert.equal(store.state.historyOpen, false);
    assert.equal(storage.getItem('aether.historyOpen'), '0');

    // На узком окне колонка выезжает поверх по кнопке и закрывается ею же.
    global.window.innerWidth = 864;
    store.toggleHistory(true);
    assert.equal(store.state.historyOpen, true);
    store.toggleHistory(false);
    assert.equal(store.state.historyOpen, false);
  } finally {
    delete global.window;
  }
});

test('Store: время хода пишется при отправке и возвращается после перезапуска', async () => {
  const storage = makeMemStorage();
  const live = makeStore(makeFakeBridge(), storage);
  await live.loadInitial();

  live.onAgentEvent({ type: 'quick_user', text: 'Привет' });
  live.onAgentEvent({ type: 'text', delta: 'Здравствуйте!' });
  live.onAgentEvent({ type: 'done', status: 'done' });

  const userAt = live.state.feedItems.find((i) => i.kind === 'user').at;
  const replyAt = live.state.feedItems.find((i) => i.kind === 'assistant').at;
  assert.ok(Number.isFinite(userAt) && userAt > 0);
  assert.ok(Number.isFinite(replyAt) && replyAt >= userAt);

  // В хранилище нет текста переписки — только отпечатки и отметки.
  const dumped = JSON.stringify(storage.dump());
  assert.ok(!dumped.includes('Привет'));
  assert.ok(!dumped.includes('Здравствуйте'));

  const rows = [
    { role: 'user', text: 'Привет' },
    { role: 'assistant', text: 'Здравствуйте!' },
  ];
  const restarted = makeStore(makeFakeBridge(rows), storage);
  await restarted.loadInitial();
  assert.equal(restarted.state.feedItems[0].at, userAt);
  assert.equal(restarted.state.feedItems[1].at, replyAt);
});

test('Store: старая история без отметок открывается без времени и не ломается', async () => {
  const rows = [
    { role: 'user', text: 'Давний вопрос' },
    { role: 'assistant', text: 'Давний ответ' },
  ];
  const store = makeStore(makeFakeBridge(rows), makeMemStorage());
  await store.loadInitial();
  assert.equal(store.state.feedItems.length, 2);
  assert.ok(store.state.feedItems.every((i) => i.at === undefined));
  assert.equal(store.state.feedItems[1].text, 'Давний ответ');
});

test('Store: закрытие чата убирает его отметки времени', async () => {
  const storage = makeMemStorage();
  const store = makeStore(makeFakeBridge(), storage);
  await store.loadInitial();
  store.onAgentEvent({ type: 'quick_user', text: 'Временный чат' });
  store.onAgentEvent({ type: 'done', replyText: 'Ответ', status: 'done' });
  assert.ok(storage.getItem('aether.messageTimes').includes('"u"'));

  await store.closeChat('c1');
  const left = JSON.parse(storage.getItem('aether.messageTimes') || '{}');
  assert.deepEqual(left.c1, undefined);
});

test('Оболочка: time.js подключён до store.js, колонка и подписи времени на месте', () => {
  const html = fs.readFileSync(path.join(AETHER_DIR, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="time.js"') > 0);
  assert.ok(html.indexOf('src="time.js"') < html.indexOf('src="store.js"'));

  const drawer = fs.readFileSync(path.join(AETHER_DIR, 'components', 'history-drawer.js'), 'utf8');
  assert.match(drawer, /ae-sidebar-collapse/);
  assert.match(drawer, /store\.toggleHistory\(false\)/);
  assert.match(drawer, /time\.formatChatStamp/);
  assert.match(drawer, /time\.splitChats/);
  assert.ok(drawer.includes("'Сегодня'") && drawer.includes("'Ранее'"));
  assert.ok(!drawer.includes('ae-history-title'));

  const view = fs.readFileSync(path.join(AETHER_DIR, 'components', 'chat-view.js'), 'utf8');
  assert.match(view, /ae-msg-time/);
  assert.match(view, /ae-reply-head/);
  // Подпись Nox остаётся отдельным элементом: время не должно попадать в её текст.
  assert.match(view, /author\.textContent = 'Nox';/);

  const css = fs.readFileSync(path.join(AETHER_DIR, 'aether.css'), 'utf8');
  assert.match(css, /\.ae-sidebar-wrap\.is-open \.ae-sidebar \{\s*width: 256px;/);
  assert.match(css, /\.ae-msg-time \{/);
  assert.match(css, /\.ae-chat-time \{/);

  const shell = fs.readFileSync(path.join(AETHER_DIR, 'aether.js'), 'utf8');
  assert.match(shell, /store\.syncHistoryViewport\(\)/);
});

test('splitChats сортирует «Сегодня» и «Ранее» от новых к старым по updatedAt', () => {
  const now = dayAt(0, 14, 0);
  const res = time.splitChats([
    { id: 'old-1', updatedAt: dayAt(-5, 9, 0) },
    { id: 'today-early', updatedAt: dayAt(0, 8, 0) },
    { id: 'old-newer', updatedAt: dayAt(-1, 20, 0) },
    { id: 'today-late', updatedAt: dayAt(0, 13, 30) },
  ], now);
  assert.deepEqual(res.today.map((c) => c.id), ['today-late', 'today-early']);
  assert.deepEqual(res.earlier.map((c) => c.id), ['old-newer', 'old-1']);
});