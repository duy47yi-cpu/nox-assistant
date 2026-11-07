'use strict';

// Волна 2 проверок: действие подтверждается отдельным наблюдением, а не словами самого инструмента.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkEffect } = require('../src/agent/effects');
const { desktopTools } = require('../src/tools/desktop');
const { systemTools } = require('../src/tools/system');
const { windowsTools } = require('../src/tools/windows');
const { clipboardTools } = require('../src/tools/clipboard');
const { commandModelTools } = require('../src/tools/commands');
const { memoryTools } = require('../src/tools/memory');
const { remindersTools } = require('../src/tools/reminders');
const { missionTools } = require('../src/tools/missions');
const { uiTools } = require('../src/tools/ui');
const { MemoryStore } = require('../src/memory/store');
const { ReminderStore } = require('../src/schedule/store');
const { MissionStore } = require('../src/missions/store');
const { CommandStore } = require('../src/commands/store');

const find = (list, name) => list.find((t) => t.name === name);
const okStdout = (stdout) => ({ ok: true, summary: 'готово', data: { stdout } });

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-wave2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function appClose(probe) {
  const tool = find(desktopTools, 'app_close');
  return checkEffect(tool, { name: 'x' }, { ok: true, summary: 'закрываю: x', data: { process: 'x' } }, { probeProcess: probe, pollTimeoutMs: 30 });
}

test('app_close: процесс исчез — подтверждено, остался — провалено, опрос не удался — не проверено', async () => {
  assert.equal((await appClose(async () => false)).verified, 'confirmed');
  const left = await appClose(async () => true);
  assert.equal(left.verified, 'failed');
  assert.equal(left.ok, false);
  assert.equal((await appClose(async () => null)).verified, 'unknown');
});

test('windows_focus: сверяется с окном на переднем плане', async () => {
  const check = (runner) => {
    const tool = find(windowsTools(runner), 'windows_focus');
    return checkEffect(tool, { title: 'Блокнот' }, { ok: true, summary: 'окно активировано', data: {} }, { pollTimeoutMs: 30 });
  };
  assert.equal((await check(async () => okStdout('Заметки — блокнот'))).verified, 'confirmed');
  assert.equal((await check(async () => okStdout('Другая программа'))).verified, 'failed');
  assert.equal((await check(async () => ({ ok: false, summary: 'сбой', data: {} }))).verified, 'unknown');
});

test('clipboard_set: читает буфер обратно', async () => {
  const check = (runner) => {
    const tool = find(clipboardTools({ runner }), 'clipboard_set');
    return checkEffect(tool, { text: 'а\nб' }, { ok: true, summary: 'в буфере', data: {} }, {});
  };
  assert.equal((await check(async () => okStdout('а\r\nб\r\n'))).verified, 'confirmed');
  assert.equal((await check(async () => okStdout('чужое'))).verified, 'failed');
  assert.equal((await check(async () => ({ ok: false, summary: 'сбой', data: {} }))).verified, 'unknown');
});

test('ui_close_window: окно закрылось — подтверждено, осталось — провалено', async () => {
  const tool = find(uiTools({ runner: async () => okStdout('{}') }), 'ui_close_window');
  const run = (closed) => checkEffect(tool, { window: 'Б' }, { ok: true, summary: 'с', data: { window: 'Б', closed } }, {});
  assert.equal((await run(true)).verified, 'confirmed');
  assert.equal((await run(false)).verified, 'failed');
});

test('хранилища: запись сверяется с файлом, подмена файла даёт провал', async (t) => {
  const dir = tmp(t);
  const memFile = path.join(dir, 'm.json');
  const mem = memoryTools(new MemoryStore(memFile));
  const remember = find(mem, 'remember');
  const r = await remember.run({ text: 'купить чай' });
  assert.equal((await checkEffect(remember, {}, r, {})).verified, 'confirmed');
  fs.writeFileSync(memFile, JSON.stringify({ items: [] }));
  assert.equal((await checkEffect(remember, {}, r, {})).verified, 'failed');

  const reminders = remindersTools(new ReminderStore(path.join(dir, 'r.json')));
  const remind = find(reminders, 'remind_in');
  const made = await remind.run({ minutes: 5, text: 'чай' });
  assert.equal((await checkEffect(remind, {}, made, {})).verified, 'confirmed');
  const cancel = find(reminders, 'cancel_reminder');
  const args = { id: made.data.id };
  assert.equal((await checkEffect(cancel, args, await cancel.run(args), {})).verified, 'confirmed');

  const missions = missionTools(new MissionStore(path.join(dir, 'g.json')));
  const add = find(missions, 'mission_add');
  const mission = await add.run({ goal: 'цель', every_minutes: 60 });
  assert.equal((await checkEffect(add, {}, mission, {})).verified, 'confirmed');
});

test('command_set_hotkey: занятая клавиша — не успех и прежняя настройка остаётся', async (t) => {
  const store = new CommandStore(path.join(tmp(t), 'c.json'));
  store.save({ name: 'Утро', phrases: ['утро'], steps: [{ tool: 'wait', args: { ms: 1 } }], enabled: true, hotkey: 'Control+Alt+U' });
  const free = new Set(['Control+Alt+U', 'Control+Alt+Y']);
  let registered = new Set();
  const onChange = () => { registered = new Set(store.list().map((c) => c.hotkey).filter((k) => free.has(k))); };
  onChange();
  const tool = find(commandModelTools(store, () => new Set(['wait']), { onChange, hotkeyActive: (k) => registered.has(k) }), 'command_set_hotkey');

  const busy = await tool.run({ name: 'Утро', hotkey: 'Ctrl+Alt+B' });
  assert.equal(busy.ok, false);
  assert.match(busy.summary, /занята/);
  assert.equal(store.list()[0].hotkey, 'Control+Alt+U');
  assert.ok(registered.has('Control+Alt+U'));

  const args = { name: 'Утро', hotkey: 'Ctrl+Alt+Y' };
  const good = await checkEffect(tool, args, await tool.run(args), {});
  assert.equal(good.ok, true);
  assert.equal(good.verified, 'confirmed');
});

test('то, что проверить нельзя, честно даёт «не проверено»', async () => {
  const all = [...desktopTools, ...systemTools];
  for (const name of ['speak', 'monitor_off', 'pc_shutdown', 'volume_set', 'shell_run', 'windows_minimize_all', 'windows_restore_all']) {
    const out = await checkEffect(find(all, name), {}, { ok: true, summary: 'готово', data: {} }, {});
    assert.equal(out.verified, 'unknown', name);
    assert.equal(out.ok, true, name);
    assert.match(out.summary, /не проверено/, name);
  }
});
