'use strict';

// Находки независимой проверки: каждая с поломкой, которую она описывала.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const modes = require('../src/policy/modes');
const { MissionStore } = require('../src/missions/store');
const { MissionScheduler } = require('../src/missions/scheduler');
const { checkExpected } = require('../src/missions/runner');
const { maskArgs, maskHistory } = require('../src/journal/journal');
const { guardDesktopTools, DesktopLock, BLOCKED_DESKTOP } = require('../src/control/desktop-lock');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('лишний path не открывает инструмент без пути в фоне', async (t) => {
  const dir = tempDir(t);
  const tools = new ToolRegistry();
  let opened = 0;
  tools.register({ name: 'app_open', risk: 'T1', description: 'x', parameters: { type: 'object', properties: { name: { type: 'string' } } }, run: async () => { opened += 1; return { ok: true, summary: 'открыто' }; } });
  let step = 0;
  const brain = { chat: async () => { step += 1; return step === 1 ? { content: '', toolCalls: [{ id: 'c1', name: 'app_open', args: { name: 'x', path: 'a.txt' } }] } : { content: 'всё', toolCalls: [] }; } };
  const agent = new Agent({ brain, tools, policy: modes, approvals: { request: async () => 'reject', respond: () => false }, journal: { append: () => {} }, mode: 'auto', workspace: dir, emit: () => {} });
  await agent.run('x');
  assert.equal(opened, 0);
});

test('путь внутри рабочей папки по-прежнему работает у инструмента с path', () => {
  const v = modes.decide({ mode: 'auto', name: 'workspace_write', risk: 'T1', args: { path: 'a.txt' }, workspace: 'D:\\ws', hasPathParam: true });
  assert.equal(v, 'allow');
});

test('AyuGram считается мессенджером', () => {
  assert.equal(modes.isSensitive({ name: 'ui_type', args: { window: 'AyuGram Desktop' } }), true);
});

test('отменённая во время другой задачи не запускается', async (t) => {
  const store = new MissionStore(path.join(tempDir(t), 'm.json'));
  const T0 = new Date('2026-11-01T10:00:00Z');
  const a = store.add({ goal: 'a', schedule: { type: 'interval', minutes: 60 } }, T0);
  const b = store.add({ goal: 'b', schedule: { type: 'interval', minutes: 60 } }, T0);
  const ran = [];
  const sched = new MissionScheduler({ store, now: () => new Date(T0.getTime() + 3700000), notify: () => {}, run: async (m) => { ran.push(m.goal); store.cancel(m.id === a.id ? b.id : a.id); return { report: 'r' }; } });
  await sched.tick();
  assert.equal(ran.length, 1);
});

test('непроверенный итог не называется выполненным', async (t) => {
  const store = new MissionStore(path.join(tempDir(t), 'm.json'));
  const T0 = new Date('2026-11-01T10:00:00Z');
  store.add({ goal: 'a', schedule: { type: 'interval', minutes: 60 } }, T0);
  const notes = [];
  const sched = new MissionScheduler({ store, now: () => new Date(T0.getTime() + 3700000), notify: (n) => notes.push(n), run: async () => ({ report: 'r', verdict: 'unverified' }) });
  await sched.tick();
  assert.match(notes[0].title, /не проверен/);
});

test('сверка передаёт момент запуска: старый результат можно отличить', async () => {
  let got;
  await checkExpected([{ kind: 'file', target: 'a' }], async (_i, since) => { got = since; return true; }, 'момент');
  assert.equal(got, 'момент');
});

test('в файл разговора не уходят пароль и содержимое буфера', () => {
  const history = [
    { role: 'assistant', tool_calls: [
      { id: '1', function: { name: 'ui_type', arguments: JSON.stringify({ window: 'w', text: 'секрет123' }) } },
      { id: '2', function: { name: 'clipboard_get', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: '1', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: '2', content: '{"data":{"text":"буфер456"}}' },
  ];
  const saved = JSON.stringify(maskHistory(history));
  assert.doesNotMatch(saved, /секрет123|буфер456/);
  assert.match(history[0].tool_calls[0].function.arguments, /секрет123/); // в памяти без изменений
});

test('шаги новой команды в журнале тоже без текста', () => {
  const out = maskArgs('command_create', { steps: [{ tool: 'ui_type', args: { text: 'секрет' } }] });
  assert.doesNotMatch(JSON.stringify(out), /секрет/);
});

test('окна и монитор закрыты замком', async () => {
  const lock = new DesktopLock();
  lock.setLocked(true);
  for (const name of ['windows_focus', 'windows_minimize_all', 'windows_restore_all', 'monitor_off']) {
    const [tool] = guardDesktopTools([{ name, run: async () => ({ ok: true }) }], lock);
    assert.equal((await tool.run({}, {})).data.state, BLOCKED_DESKTOP);
  }
});
