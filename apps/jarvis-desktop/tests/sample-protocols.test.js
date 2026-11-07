'use strict';

// Протоколы «Работа», «Игра», «Отбой»: фразы, порядок шагов, отсутствие опасных шагов, решения политики.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CommandStore } = require('../src/commands/store');
const { SAMPLE_COMMANDS, seedSampleCommands } = require('../src/commands/samples');
const { desktopTools } = require('../src/tools/desktop');
const { systemTools } = require('../src/tools/system');
const { decide } = require('../src/policy/modes');

const DANGEROUS = new Set(['pc_shutdown', 'shell_run', 'app_close']);

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-proto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new CommandStore(path.join(dir, 'commands.json'));
}

const tools = new Map([...systemTools, ...desktopTools].map((tool) => [tool.name, tool]));
const sample = (name) => SAMPLE_COMMANDS.find((c) => c.name === name);

test('фраза «игровой режим» находит «Игра», «режим работы» — «Работа»', (t) => {
  const store = tmpStore(t);
  seedSampleCommands(store);
  assert.equal(store.findByPhrase('игровой режим').name, 'Игра');
  assert.equal(store.findByPhrase('Режим работы.').name, 'Работа');
  assert.equal(store.findByPhrase('спокойной ночи').name, 'Отбой');
});

test('шаги идут в заданном порядке', () => {
  assert.deepEqual(sample('Работа').steps.map((s) => s.tool), ['windows_minimize_all', 'url_open', 'volume_set', 'speak']);
  assert.deepEqual(sample('Работа').steps[2].args, { percent: 30 });
  assert.deepEqual(sample('Игра').steps.map((s) => s.tool), ['windows_minimize_all', 'wait', 'volume_set']);
  assert.deepEqual(sample('Игра').steps[2].args, { percent: 70 });
  assert.deepEqual(sample('Отбой').steps.map((s) => s.tool), ['speak', 'volume_set', 'monitor_off']);
  assert.deepEqual(sample('Отбой').steps[1].args, { percent: 0 });
});

test('опасные инструменты не входят в образцы', () => {
  for (const cmd of SAMPLE_COMMANDS) {
    for (const step of cmd.steps) assert.equal(DANGEROUS.has(step.tool), false, `${cmd.name}: ${step.tool}`);
  }
});

test('все образцы сохраняются без ошибок (store.js не принимает опасные шаги)', (t) => {
  const store = tmpStore(t);
  assert.deepEqual(seedSampleCommands(store), ['Работа', 'Игра', 'Отбой']);
});

test('каждый шаг известен и проходит политику в режиме «Спрашивать» без отказа', () => {
  for (const cmd of SAMPLE_COMMANDS) {
    for (const step of cmd.steps) {
      const tool = tools.get(step.tool);
      assert.ok(tool, `${cmd.name}: нет инструмента ${step.tool}`);
      const verdict = decide({
        mode: 'ask',
        name: tool.name,
        risk: tool.risk,
        args: step.args,
        workspace: os.tmpdir(),
        sessionAllow: new Set(),
        hasPathParam: false,
      });
      assert.notEqual(verdict, 'deny', `${cmd.name}: ${step.tool} отклонён политикой`);
      if (tool.risk === 'T0') assert.equal(verdict, 'allow', `${cmd.name}: ${step.tool} должен идти без вопроса`);
    }
  }
});

test('фразы образцов уникальны', () => {
  const phrases = SAMPLE_COMMANDS.flatMap((c) => c.phrases);
  assert.equal(new Set(phrases).size, phrases.length);
});

test('образцы: происхождение sample и версия схемы, перенос без потерь', (t) => {
  const { exportCommandJson, previewCommandImport, applyCommandImport } = require('../src/commands/store');
  const store = tmpStore(t);
  seedSampleCommands(store);
  for (const saved of store.list()) {
    assert.equal(saved.origin, 'sample');
    assert.equal(saved.schemaVersion, 2);
  }
  const text = exportCommandJson(store.list());
  const target = tmpStore(t);
  const preview = previewCommandImport(text, target);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.preview.counts.add, 3);
  const applied = applyCommandImport(text, target, { confirm: true });
  assert.equal(applied.ok, true, applied.error);
  assert.deepEqual(target.list().map((c) => [c.name, c.steps.map((s) => s.tool), c.origin]), store.list().map((c) => [c.name, c.steps.map((s) => s.tool), c.origin]));
  assert.equal(target.findByPhrase('игровой режим').name, 'Игра');
});
