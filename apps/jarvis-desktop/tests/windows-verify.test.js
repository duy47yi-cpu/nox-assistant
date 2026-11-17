'use strict';

// Проверки инструментов окон: своё окно Nox не сворачивается, возврат окон подтверждается,
// необязательные глаголы («активируй») доводят фразу до команды. Живой прогон приёмки 17.11:
// «верни все окна» сворачивало окна и Nox исчезал; «активируй игровой режим» уходило в уточнение.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { desktopTools, desktopToolsFactory } = require('../src/tools/desktop');
const { matchCommand } = require('../src/commands/match');
const { SAMPLE_COMMANDS } = require('../src/commands/samples');

const byName = (tools, name) => tools.find((t) => t.name === name);

test('сворачивание окон исключает своё окно Nox и передаёт PID приложения', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'tools', 'desktop.js'), 'utf8');
  assert.match(source, /NOX_SELF_PID/, 'PID приложения передаётся в скрипт');
  assert.match(source, /Test-OwnProcess/, 'окна приложения и его дочерних процессов распознаются');
  assert.match(source, /ShowWindow\(\$h, 9\)/, 'своё свёрнутое окно возвращается на место');
  let env = null;
  const tools = desktopToolsFactory({
    runner: async (_script, captured) => { env = captured; return { ok: true, summary: 'готово', data: { stdout: JSON.stringify({ checked: 2, open: 0, own: 1, ownOpen: 0 }) } }; },
    speak: async () => {},
  });
  const res = await byName(tools, 'windows_minimize_all').run({});
  assert.equal(env.NOX_SELF_PID, String(process.pid));
  assert.equal(res.ok, true);
});

test('сворачивание подтверждается только когда окна свёрнуты и своё окно на месте', async () => {
  const min = byName(desktopTools, 'windows_minimize_all');
  const ok = await min.verify({}, { data: { stdout: JSON.stringify({ checked: 3, open: 0, own: 1, ownOpen: 0 }) } });
  assert.equal(ok.status, 'confirmed');
  assert.match(ok.evidence, /своё окно не тронуто/);
  const own = await min.verify({}, { data: { stdout: JSON.stringify({ checked: 3, open: 0, own: 1, ownOpen: 1 }) } });
  assert.equal(own.status, 'failed');
  const left = await min.verify({}, { data: { stdout: JSON.stringify({ checked: 3, open: 2, own: 0, ownOpen: 0 }) } });
  assert.equal(left.status, 'failed');
});

test('возврат окон подтверждается по счётчику свёрнутых до и после', async () => {
  const restore = byName(desktopTools, 'windows_restore_all');
  const all = await restore.verify({}, { data: { stdout: JSON.stringify({ before: 8, after: 0 }) } });
  assert.equal(all.status, 'confirmed');
  assert.match(all.evidence, /возвращено окон: 8/);
  const part = await restore.verify({}, { data: { stdout: JSON.stringify({ before: 8, after: 3 }) } });
  assert.equal(part.status, 'confirmed');
  assert.match(part.evidence, /возвращено 5 из 8/);
  const none = await restore.verify({}, { data: { stdout: JSON.stringify({ before: 0, after: 0 }) } });
  assert.equal(none.status, 'confirmed');
  assert.match(none.evidence, /свёрнутых окон не было/);
  const stuck = await restore.verify({}, { data: { stdout: JSON.stringify({ before: 8, after: 8 }) } });
  assert.equal(stuck.status, 'failed');
  const broken = await restore.verify({}, { data: { stdout: 'не json' } });
  assert.equal(broken.status, 'unknown');
});

test('«активируй игровой режим» находит команду «Игра», как «запусти»', () => {
  const hit = matchCommand('активируй игровой режим', SAMPLE_COMMANDS);
  assert.ok(hit && hit.command, 'команда найдена');
  assert.equal(hit.command.name, 'Игра');
  assert.equal(matchCommand('переключи игровой режим', SAMPLE_COMMANDS).command.name, 'Игра');
  assert.equal(matchCommand('включи игровой режим', SAMPLE_COMMANDS).command.name, 'Игра');
});

test('скрипт сворачивания реально исполняется в пробном режиме (без сворачивания окон)', { skip: process.platform !== 'win32' }, async () => {
  process.env.NOX_MINIMIZE_DRY = '1';
  try {
    const res = await byName(desktopTools, 'windows_minimize_all').run({});
    assert.equal(res.ok, true, res.summary);
    const probe = JSON.parse(res.data.stdout);
    assert.equal(probe.dry, true);
    assert.equal(typeof probe.checked, 'number');
    assert.equal(probe.open, 0);
  } finally {
    delete process.env.NOX_MINIMIZE_DRY;
  }
});
