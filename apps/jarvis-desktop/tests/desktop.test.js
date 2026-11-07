'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopTools, comboScript, MAX_WAIT_MS } = require('../src/tools/desktop');
const { decide } = require('../src/policy/modes');

const byName = (name) => desktopTools.find((t) => t.name === name);

test('инструменты сценария: пауза — T0, Win+D и Win+Shift+M — T1', () => {
  assert.equal(byName('wait').risk, 'T0');
  assert.equal(byName('windows_minimize_all').risk, 'T1');
  assert.equal(byName('windows_restore_all').risk, 'T1');
});

test('wait: ждёт заданное время и отказывает за пределами диапазона', async () => {
  const wait = byName('wait');
  const started = Date.now();
  const ok = await wait.run({ ms: 30 }, {});
  assert.equal(ok.ok, true);
  assert.ok(Date.now() - started >= 25);
  assert.equal((await wait.run({ ms: MAX_WAIT_MS + 1 }, {})).ok, false);
  assert.equal((await wait.run({ ms: -5 }, {})).ok, false);
  assert.equal((await wait.run({ ms: 1.5 }, {})).ok, false);
});

test('wait: отмена (аварийный стоп) прерывает паузу', async () => {
  const wait = byName('wait');
  const controller = new AbortController();
  const started = Date.now();
  const pending = wait.run({ ms: 5000 }, { signal: controller.signal });
  controller.abort();
  const res = await pending;
  assert.equal(res.ok, false);
  assert.ok(Date.now() - started < 2000);
});

test('Win+D: клавиши Win и D нажимаются и отпускаются в правильном порядке', () => {
  const script = comboScript([0x5b, 0x44]);
  const calls = [...script.matchAll(/keybd_event\((\d+), 0, (\d), /g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(calls, ['91:0', '68:0', '68:2', '91:2']);
});

test('Win+Shift+M: Shift и M нажимаются вместе с Win', () => {
  const script = comboScript([0x5b, 0x10, 0x4d]);
  const calls = [...script.matchAll(/keybd_event\((\d+), 0, (\d), /g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(calls, ['91:0', '16:0', '77:0', '77:2', '16:2', '91:2']);
});

test('в режиме «Спрашивать» шаги с клавишами спрашивают, в «Полном доступе» — нет', () => {
  assert.equal(decide({ mode: 'auto', name: 'windows_minimize_all', risk: 'T1', args: {} }), 'ask');
  assert.equal(decide({ mode: 'full', name: 'windows_minimize_all', risk: 'T1', args: {} }), 'allow');
  assert.equal(decide({ mode: 'ask', name: 'wait', risk: 'T0', args: { ms: 100 } }), 'allow');
});

test('свернуть и вернуть окна через Shell.Application, без переключателя Win+D', () => {
  const { MINIMIZE_SCRIPT, RESTORE_SCRIPT } = require('../src/tools/desktop');
  assert.match(MINIMIZE_SCRIPT, /Shell\.Application.*MinimizeAll\(\)/);
  assert.match(RESTORE_SCRIPT, /UndoMinimizeALL\(\)/);
});

test('выключение экрана использует PostMessage, а не блокирующий SendMessage', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'tools', 'desktop.js'), 'utf8');
  assert.match(src, /PostMessage\(IntPtr hWnd/);
  assert.doesNotMatch(src, /SendMessage\(/);
});

test('pc_shutdown: T3, задержка проверяется до запуска PowerShell; в «Спрашивать» спрашивает; в «Полном доступе» — только по прямой просьбе владельца (05.11.2026)', async () => {
  const tool = desktopTools.find((t) => t.name === 'pc_shutdown');
  assert.equal(tool.risk, 'T3');
  const bad = await tool.run({ delay_seconds: 9999 }, {});
  assert.equal(bad.ok, false);
  assert.equal(decide({ mode: 'ask', name: 'pc_shutdown', risk: 'T3', args: {} }), 'ask');
  assert.equal(decide({ mode: 'full', name: 'pc_shutdown', risk: 'T3', args: {} }), 'ask');
  assert.equal(decide({ mode: 'full', name: 'pc_shutdown', risk: 'T3', args: {}, ownerText: 'выключи компьютер' }), 'allow');
});
