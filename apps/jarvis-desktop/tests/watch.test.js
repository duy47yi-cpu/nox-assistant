'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WatchNotifier, listInboxFiles, isNight, readConfig, mergeText } = require('../src/notify/watch');
const { TelegramBridge } = require('../src/telegram/bridge');
const { mayWriteTo } = require('../src/telegram/policy');

// Время местное: тесты не зависят от часового пояса машины.
const at = (h, m = 0, d = 2) => new Date(2026, 10, d, h, m);

function makeWatch({ settings = {}, telegram = true, telegramFail = 0 } = {}) {
  const state = { inbox: [], tasks: [], missions: [], cost: null, settings };
  const sent = { window: [], telegram: [] };
  let failures = telegramFail;
  const watch = new WatchNotifier({
    settings: () => state.settings,
    sources: {
      inbox: () => state.inbox,
      tasks: () => state.tasks,
      missions: () => state.missions,
      cost: () => state.cost,
    },
    channels: {
      window: { available: () => true, send: async (text) => { sent.window.push(text); } },
      telegram: {
        available: () => telegram,
        send: async (text) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('сеть');
          }
          sent.telegram.push(text);
        },
      },
    },
    log: () => {},
  });
  return { watch, state, sent };
}

test('ночная тишина: с 23:00 до 08:00 по местным часам', () => {
  assert.equal(isNight(at(22, 59)), false);
  assert.equal(isNight(at(23, 0)), true);
  assert.equal(isNight(at(3, 0)), true);
  assert.equal(isNight(at(7, 59)), true);
  assert.equal(isNight(at(8, 0)), false);
});

test('ночью Telegram молчит, окно показывает; очередь Telegram уходит утром', async () => {
  const { watch, state, sent } = makeWatch();
  await watch.tick(at(22, 0)); // первый проход запоминает пустую папку
  state.inbox = ['a.txt'];
  await watch.tick(at(23, 30));
  assert.equal(sent.window.length, 1);
  assert.deepEqual(sent.telegram, [], 'ночью в Telegram ничего');
  await watch.tick(at(7, 30));
  assert.deepEqual(sent.telegram, [], 'до 08:00 Telegram молчит');
  await watch.tick(at(8, 5));
  assert.equal(sent.telegram.length, 1);
  assert.match(sent.telegram[0], /a\.txt/);
  assert.equal(sent.window.length, 1, 'в окне повтора нет');
});

test('лимит в час: сверх watchPerHour поводы ждут, пока в часе освободится место', async () => {
  const { watch, state, sent } = makeWatch({ settings: { watchPerHour: 2 } });
  await watch.tick(at(10, 0));
  state.inbox = ['x.txt'];
  await watch.tick(at(10, 1));
  state.tasks = [{ id: 't1', title: 'Сверка', status: 'blocked', reason: 'нет доступа', updatedAt: '2026-11-02T09:00:00.000Z' }];
  await watch.tick(at(10, 2));
  state.missions = [{ id: 'm1', goal: 'Отчёт', lastVerdict: 'failed', lastRunAt: '2026-11-02T09:30:00.000Z', lastResult: 'ошибка' }];
  await watch.tick(at(10, 3));
  assert.equal(sent.window.length, 2, 'два сообщения в час, третье ждёт');
  await watch.tick(at(10, 59));
  assert.equal(sent.window.length, 2);
  await watch.tick(at(11, 3));
  assert.equal(sent.window.length, 3);
  assert.match(sent.window[2], /Отчёт/);
});

test('зависшее окно приложения даёт одно уведомление, а штатное состояние не шумит', async () => {
  const { watch, state, sent } = makeWatch();
  state.apps = [{ name: 'Браузер', pid: 42, hung: false }];
  watch.sources.apps = () => state.apps;
  await watch.tick(at(10, 0));
  state.apps = [{ name: 'Браузер', pid: 42, hung: true }];
  await watch.tick(at(10, 1));
  await watch.tick(at(10, 2));
  assert.equal(sent.window.length, 1);
  assert.match(sent.window[0], /Браузер/);
  assert.equal(sent.telegram.length, 1);
  assert.match(sent.telegram[0], /Браузер/);
});

test('однотипные поводы сводятся в одно сообщение', async () => {
  const { watch, state, sent } = makeWatch();
  await watch.tick(at(10, 0));
  state.inbox = ['a.txt', 'b.txt', 'c.txt'];
  await watch.tick(at(10, 1));
  assert.equal(sent.window.length, 1);
  assert.equal(sent.window[0], 'Новые файлы в inbox (3): a.txt; b.txt; c.txt');
});

test('однотипные поводы, накопившиеся в очереди, тоже сводятся в одно сообщение', async () => {
  const { watch, state, sent } = makeWatch({ settings: { watchPerHour: 1 } });
  await watch.tick(at(10, 0));
  state.inbox = ['first.txt'];
  await watch.tick(at(10, 1)); // уходит первое сообщение, лимит часа исчерпан
  state.inbox = ['first.txt', 'b.txt', 'c.txt'];
  await watch.tick(at(10, 2));
  state.inbox = ['first.txt', 'b.txt', 'c.txt', 'd.txt'];
  await watch.tick(at(10, 3));
  await watch.tick(at(11, 5));
  assert.equal(sent.window.length, 2);
  assert.equal(sent.window[1], 'Новые файлы в inbox (3): b.txt; c.txt; d.txt');
});

test('каждый канал выключается отдельно', async () => {
  const off = makeWatch({ settings: { watchWindow: false } });
  await off.watch.tick(at(10, 0));
  off.state.inbox = ['a.txt'];
  await off.watch.tick(at(10, 1));
  assert.deepEqual(off.sent.window, []);
  assert.equal(off.sent.telegram.length, 1, 'Telegram работает, когда отключено только окно');

  const noTg = makeWatch({ settings: { watchTelegram: false } });
  await noTg.watch.tick(at(10, 0));
  noTg.state.inbox = ['a.txt'];
  await noTg.watch.tick(at(10, 1));
  assert.equal(noTg.sent.window.length, 1);
  assert.deepEqual(noTg.sent.telegram, []);

  const both = makeWatch({ settings: { watchWindow: false, watchTelegram: false } });
  await both.watch.tick(at(10, 0));
  both.state.inbox = ['a.txt'];
  await both.watch.tick(at(10, 1));
  assert.deepEqual(both.sent.window, []);
  assert.deepEqual(both.sent.telegram, []);
});

test('Telegram недоступен (мост не запущен): окно работает, очередь Telegram не копится', async () => {
  const { watch, state, sent } = makeWatch({ telegram: false });
  await watch.tick(at(10, 0));
  state.inbox = ['a.txt'];
  await watch.tick(at(10, 1));
  assert.equal(sent.window.length, 1);
  assert.deepEqual(sent.telegram, []);
});

test('сбой отправки не теряет повод: уйдёт в следующем проходе', async () => {
  const { watch, state, sent } = makeWatch({ telegramFail: 1 });
  await watch.tick(at(10, 0));
  state.inbox = ['a.txt'];
  await watch.tick(at(10, 1));
  assert.deepEqual(sent.telegram, []);
  await watch.tick(at(10, 2));
  assert.equal(sent.telegram.length, 1);
  await watch.tick(at(10, 3));
  assert.equal(sent.telegram.length, 1, 'повтора уже отправленного нет');
});

test('первый проход запоминает существующее: старые провалы и файлы при запуске не объявляются', async () => {
  const { watch, state, sent } = makeWatch();
  state.inbox = ['old.txt'];
  state.tasks = [{ id: 't0', title: 'Старая', status: 'blocked', reason: 'x', updatedAt: '2026-11-01T10:00:00.000Z' }];
  await watch.tick(at(10, 0));
  await watch.tick(at(10, 1));
  assert.equal(sent.window.length, 0);
  assert.equal(sent.telegram.length, 0);
});

test('поводы, которые всё ещё есть, не объявляются снова через несколько дней', async () => {
  const { watch, state, sent } = makeWatch();
  await watch.tick(at(10, 0));
  state.tasks = [{ id: 't5', title: 'Упала', status: 'blocked', reason: 'ошибка', updatedAt: '2026-11-02T08:00:00.000Z' }];
  await watch.tick(at(10, 1));
  assert.equal(sent.window.length, 1);
  await watch.tick(at(10, 2, 5)); // через три дня задача всё ещё заблокирована
  await watch.tick(at(10, 3, 5));
  assert.equal(sent.window.length, 1, 'та же блокировка не повторяется');
});

test('задача и миссия зависли, миссия провалилась, расход у лимита', async () => {
  const { watch, state, sent } = makeWatch();
  const now = at(10, 0);
  await watch.tick(now);
  const ago = (ms) => new Date(now.getTime() - ms).toISOString(); // относительно теста, без часового пояса
  state.tasks = [{ id: 't2', title: 'Разбор', status: 'running', updatedAt: ago(2 * 60 * 60 * 1000) }];
  state.missions = [
    { id: 'm2', goal: 'Утро', status: 'running', runStartedAt: ago(5 * 60 * 60 * 1000), limits: null },
    { id: 'm3', goal: 'Сводка', status: 'idle', lastVerdict: 'failed', lastRunAt: ago(60 * 1000), lastResult: 'нет файла' },
  ];
  state.cost = { spentUsd: 0.85, limitUsd: 1 };
  await watch.tick(now);
  const text = sent.window.join('\n');
  assert.match(text, /Задача зависла: «Разбор»/);
  assert.match(text, /Фоновая задача зависла: «Утро»/);
  assert.match(text, /Фоновая задача не справилась: «Сводка» — нет файла/);
  assert.match(text, /85%/);
});

test('миссия в пределах своего лимита времени не считается зависшей', async () => {
  const { watch, state, sent } = makeWatch();
  const now = at(10, 0);
  await watch.tick(now);
  state.missions = [{ id: 'm4', goal: 'Долгая', status: 'running', runStartedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), limits: { maxMinutes: 120 } }];
  await watch.tick(now);
  assert.deepEqual(sent.window, []);
});

test('напоминание из планировщика уходит только в Telegram', async () => {
  const { watch, sent } = makeWatch();
  await watch.tick(at(10, 0));
  watch.add({ kind: 'reminder', key: 'reminder:r1:1', detail: 'выпить воды', channels: ['telegram'] });
  await watch.tick(at(10, 1));
  assert.deepEqual(sent.window, []);
  assert.equal(sent.telegram[0], 'Напоминание: выпить воды');
});

test('настройки: неверный watchPerHour возвращается к значению по умолчанию', () => {
  assert.equal(readConfig({}).perHour, 6);
  assert.equal(readConfig({ watchPerHour: 0 }).perHour, 6);
  assert.equal(readConfig({ watchPerHour: '3' }).perHour, 6);
  assert.equal(readConfig({ watchPerHour: 3 }).perHour, 3);
  assert.deepEqual(readConfig({}).enabled, { window: true, telegram: true });
});

test('текст сведённого сообщения: один повод как есть, много — с числом и «и ещё»', () => {
  assert.equal(mergeText([{ kind: 'inbox', detail: 'a.txt' }]), 'Новые файлы в inbox: a.txt');
  const many = Array.from({ length: 7 }, (_, i) => ({ kind: 'inbox', detail: `f${i}.txt` }));
  assert.equal(mergeText(many), 'Новые файлы в inbox (7): f0.txt; f1.txt; f2.txt; f3.txt; f4.txt; и ещё 2');
});

test('папка inbox: нет папки — пусто, скрытые и временные файлы пропускаются', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-inbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(listInboxFiles(path.join(dir, 'нет')), []);
  fs.writeFileSync(path.join(dir, 'материал.txt'), 'x');
  fs.writeFileSync(path.join(dir, '.скрытый'), 'x');
  fs.writeFileSync(path.join(dir, 'черновик.tmp'), 'x');
  fs.mkdirSync(path.join(dir, 'папка'));
  assert.deepEqual(listInboxFiles(dir), ['материал.txt']);
});

test('Telegram уходит только владельцу: чужой адресат отклоняется до запроса к API', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init && init.body });
    return { status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const bridge = new TelegramBridge({ token: '1:SECRET', ownerChatId: '555', fetchImpl, handle: async () => '' });
  await bridge.notify('привет владельцу');
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].body).chat_id, '555');
  await assert.rejects(() => bridge.send('чужому', undefined, '999'), /не владелец/);
  assert.equal(calls.length, 1, 'запрос к API для чужого адресата не делается');

  // Через наблюдателя: его сообщения в Telegram тоже уходят только владельцу.
  let files = [];
  const watch = new WatchNotifier({
    sources: { inbox: () => files },
    channels: { telegram: { available: () => true, send: (text) => bridge.notify(text) } },
  });
  await watch.tick(at(10, 0));
  files = ['a.txt'];
  await watch.tick(at(10, 1));
  const chats = calls.slice(1).map((c) => JSON.parse(c.body).chat_id);
  assert.equal(chats.length, 1);
  assert.equal(chats[0], '555');
});

test('mayWriteTo: только совпадение с chat id владельца', () => {
  assert.equal(mayWriteTo('555', '555'), true);
  assert.equal(mayWriteTo(555, '555'), true);
  assert.equal(mayWriteTo('999', '555'), false);
  assert.equal(mayWriteTo(undefined, '555'), false);
  assert.equal(mayWriteTo('555', ''), false, 'без владельца не пишем никому');
});

test('асинхронный источник (зависшие программы) дожидается, а не роняет проход', async () => {
  const sent = [];
  let apps = [];
  const watch = new WatchNotifier({
    sources: {
      inbox: () => [],
      apps: async () => apps,
      tasks: () => [],
      missions: () => [],
    },
    channels: { window: { available: () => true, send: async (text) => { sent.push(text); } }, telegram: { available: () => false, send: async () => {} } },
    log: () => {},
  });
  await watch.tick(at(10, 0)); // первый проход запоминает пустое состояние
  apps = [{ name: 'Браузер', pid: 42, hung: true }];
  await watch.tick(at(10, 1));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Браузер.*не отвечает/);
});

test('сбой одного асинхронного источника не теряет поводы остальных', async () => {
  const sent = [];
  let missions = [];
  const watch = new WatchNotifier({
    sources: {
      inbox: () => [],
      tasks: async () => { throw new Error('нет доступа'); },
      missions: async () => missions,
    },
    channels: { window: { available: () => true, send: async (text) => { sent.push(text); } }, telegram: { available: () => false, send: async () => {} } },
    log: () => {},
  });
  await watch.tick(at(10, 0));
  missions = [{ id: 'm1', goal: 'Сборка', lastVerdict: 'failed', lastRunAt: '2026-11-02T10:00:00Z', lastResult: 'код 1' }];
  await watch.tick(at(10, 1));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Сборка/);
});

test('таймер: start и stop не оставляют работающий интервал', () => {
  const watch = new WatchNotifier({ intervalMs: 1e9 });
  watch.start();
  assert.ok(watch._timer);
  watch.start();
  watch.stop();
  assert.equal(watch._timer, null);
});
