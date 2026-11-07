'use strict';

// Горячие клавиши сценариев, инструмент command_set_hotkey, удалённое управление через Telegram.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CommandStore, checkHotkey, RESERVED_HOTKEYS } = require('../src/commands/store');
const { commandModelTools } = require('../src/tools/commands');
const { TelegramBridge, sanitize, MAX_REPLY } = require('../src/telegram/bridge');
const { remoteAllowed, remoteRefusal } = require('../src/telegram/policy');

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new CommandStore(path.join(dir, 'commands.json'));
}

test('checkHotkey: каноническая запись, алиасы модификаторов, отказ без модификатора и для занятых клавиш', () => {
  assert.equal(checkHotkey('ctrl+alt+y'), 'Control+Alt+Y');
  assert.equal(checkHotkey('Win+Shift+F5'), 'Shift+Super+F5');
  assert.equal(checkHotkey(null), null);
  assert.throws(() => checkHotkey('Y'), /модификатор/);
  assert.throws(() => checkHotkey('Ctrl+Alt+J'), /занята/);
  assert.throws(() => checkHotkey('Control+Alt+Shift+K'), /занята/);
  assert.throws(() => checkHotkey('Ctrl+Alt+Ъ'), /неизвестная клавиша/);
  assert.ok(RESERVED_HOTKEYS.has('CONTROL+ALT+J'));
});

test('store: горячая клавиша сохраняется, не дублируется и снимается', (t) => {
  const store = tmpStore(t);
  const a = store.save({ name: 'Кино', phrases: ['кино'], steps: [{ tool: 'wait', args: { ms: 1 } }], hotkey: 'ctrl+alt+k' });
  assert.equal(a.hotkey, 'Control+Alt+K');
  assert.throws(
    () => store.save({ name: 'Другая', phrases: ['другая'], steps: [{ tool: 'wait', args: { ms: 1 } }], hotkey: 'Control+Alt+K' }),
    /уже у команды «Кино»/,
  );
  const cleared = store.save({ ...a, hotkey: null });
  assert.equal(cleared.hotkey, null);
  const again = store.save({ name: 'Другая', phrases: ['другая'], steps: [{ tool: 'wait', args: { ms: 1 } }], hotkey: 'Control+Alt+K' });
  assert.equal(again.hotkey, 'Control+Alt+K');
});

test('command_set_hotkey: вешает клавишу на существующий сценарий и сообщает об изменении', async (t) => {
  const store = tmpStore(t);
  store.save({ name: 'Отбой', phrases: ['отбой'], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  let changed = 0;
  const [, , setHotkey] = commandModelTools(store, () => new Set(['wait']), { onChange: () => { changed += 1; } });
  const res = await setHotkey.run({ name: 'отбой', hotkey: 'Win+Shift+O' });
  assert.equal(res.ok, true);
  assert.equal(store.list()[0].hotkey, 'Shift+Super+O');
  assert.equal(changed, 1);
  const missing = await setHotkey.run({ name: 'Нет такой', hotkey: 'Ctrl+Alt+Y' });
  assert.equal(missing.ok, false);
  const off = await setHotkey.run({ name: 'Отбой', hotkey: null });
  assert.equal(off.ok, true);
  assert.equal(store.list()[0].hotkey, null);
});

// Фейковый Telegram API: getUpdates отдаёт заранее заданные обновления, sendMessage записывается.
function fakeTelegram(updatesBatches) {
  const sent = [];
  const calls = [];
  let batch = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    const method = url.split('/').pop().split('?')[0];
    if (method === 'getUpdates') {
      const result = updatesBatches[batch] || [];
      batch += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }
    if (method === 'sendMessage') {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, description: 'not found' }) };
  };
  return { fetchImpl, sent, calls };
}

test('Telegram: отвечает только владельцу, чужой чат молча игнорируется, offset двигается', async () => {
  const tg = fakeTelegram([[
    { update_id: 10, message: { text: 'привет', chat: { id: 555 } } },
    { update_id: 11, message: { text: 'чужой', chat: { id: 999 } } },
    { update_id: 12, message: { text: 'громкость 30', chat: { id: 555 } } },
  ]]);
  const seen = [];
  const bridge = new TelegramBridge({
    token: '123:SECRET',
    ownerChatId: '555',
    fetchImpl: tg.fetchImpl,
    handle: async (text) => { seen.push(text); return `ок: ${text}`; },
  });
  const handled = await bridge.pollOnce();
  assert.equal(handled, 2);
  assert.deepEqual(seen, ['привет', 'громкость 30']);
  assert.deepEqual(tg.sent.map((m) => m.chat_id), ['555', '555']);
  assert.equal(tg.sent[0].text, 'ок: привет');
  assert.equal(bridge.offset, 13);
  assert.ok(tg.calls[0].includes('offset=0'));
});

test('Telegram: ошибка обработчика уходит ответом, а не роняет мост; длинный ответ обрезается', async () => {
  const tg = fakeTelegram([[{ update_id: 1, message: { text: 'x', chat: { id: 555 } } }]]);
  const bridge = new TelegramBridge({
    token: 'T',
    ownerChatId: '555',
    fetchImpl: tg.fetchImpl,
    handle: async () => { throw new Error('сбой'); },
  });
  await bridge.pollOnce();
  assert.equal(tg.sent[0].text, 'Не получилось: сбой');
  const long = fakeTelegram([[{ update_id: 1, message: { text: 'y', chat: { id: 555 } } }]]);
  const bridge2 = new TelegramBridge({ token: 'T', ownerChatId: '555', fetchImpl: long.fetchImpl, handle: async () => 'я'.repeat(9000) });
  await bridge2.pollOnce();
  assert.equal(long.sent[0].text.length, MAX_REPLY);
});

test('Telegram: токен не попадает в текст ошибок сети', async () => {
  const failing = async () => { throw new Error('connect failed to https://api.telegram.org/bot123:SECRET/getUpdates'); };
  const bridge = new TelegramBridge({ token: '123:SECRET', ownerChatId: '555', fetchImpl: failing, handle: async () => '' });
  await assert.rejects(() => bridge.pollOnce(), (err) => {
    assert.equal(err.message.includes('SECRET'), false);
    assert.match(err.message, /<token>/);
    return true;
  });
  assert.equal(sanitize('a 123:SECRET b', '123:SECRET'), 'a <token> b');
});

test('Telegram: без токена или без чата владельца мост не создаётся', () => {
  assert.throws(() => new TelegramBridge({ ownerChatId: '1', handle: async () => '' }), /токен/);
  assert.throws(() => new TelegramBridge({ token: 'T', handle: async () => '' }), /чата владельца/);
});

test('удалённо доступны только T0 и T1, и ничего, что меняет сценарии, задачи или экран', () => {
  assert.equal(remoteAllowed({ name: 'volume_set', risk: 'T0' }), true);
  assert.equal(remoteAllowed({ name: 'app_open', risk: 'T1' }), true);
  assert.equal(remoteAllowed({ name: 'url_open', risk: 'T1' }), true);
  assert.equal(remoteAllowed({ name: 'shell_run', risk: 'T2' }), false, 'оболочка — только с ПК');
  assert.equal(remoteAllowed({ name: 'monitor_off', risk: 'T1' }), true);
  assert.equal(remoteAllowed({ name: 'command_create', risk: 'T1' }), false);
  assert.equal(remoteAllowed({ name: 'mission_add', risk: 'T1' }), false);
  assert.equal(remoteAllowed({ name: 'task_submit', risk: 'T1' }), false);
  assert.equal(remoteAllowed({ name: 'ui_type', risk: 'T1' }), false);
  assert.equal(remoteAllowed({ name: 'screen_look', risk: 'T0' }), false);
  assert.equal(remoteAllowed({ name: 'send_message', risk: 'T1' }), false);
  assert.equal(remoteAllowed({ name: 'delete_file', risk: 'T1' }), false);
  assert.equal(remoteAllowed({ name: 'x', risk: 'T3' }), false);
  assert.match(remoteRefusal('Очистка'), /только с ПК/);
});

test('горячая клавиша во время хода не запускает второй ход и говорит то же, что окно', async () => {
  const { runHotkey, BUSY_TEXT } = require('../src/control/stop');
  let busy = true;
  let ran = 0;
  const reports = [];
  const run = async () => { ran += 1; };
  const refused = await runHotkey({ isBusy: () => busy, setBusy: (v) => { busy = v; }, run, report: (t) => reports.push(t) });
  assert.equal(refused, false);
  assert.equal(ran, 0);
  assert.deepEqual(reports, [BUSY_TEXT]);
  assert.equal(busy, true, 'чужой ход не сбрасываем');

  busy = false;
  const started = await runHotkey({ isBusy: () => busy, setBusy: (v) => { busy = v; }, run, report: (t) => reports.push(t) });
  assert.equal(started, true);
  assert.equal(ran, 1);
  assert.equal(busy, false, 'после команды занятость снимается, даже при ошибке');

  await assert.rejects(runHotkey({ isBusy: () => false, setBusy: (v) => { busy = v; }, run: async () => { throw new Error('сбой'); }, report: () => {} }), /сбой/);
  assert.equal(busy, false);
});
