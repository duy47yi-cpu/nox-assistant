'use strict';

// Автономность: лимит шагов фоновой задачи, примерные сценарии, новые шаги (монитор, закрытие, голос).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent, MAX_TOOL_STEPS } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { CommandStore } = require('../src/commands/store');
const { SAMPLE_COMMANDS, seedSampleCommands } = require('../src/commands/samples');
const { desktopTools, setSpeaker } = require('../src/tools/desktop');
const { systemTools } = require('../src/tools/system');
const { runCommand } = require('../src/commands/runner');
const { decide } = require('../src/policy/modes');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-auto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Мозг, который всё время просит один и тот же инструмент с разными аргументами (не повтор).
function endlessBrain() {
  let n = 0;
  return {
    calls: 0,
    async chat() {
      this.calls += 1;
      n += 1;
      return { content: '', toolCalls: [{ id: `c${n}`, name: 'echo', args: { n } }] };
    },
  };
}

test('лимит шагов задаётся на агента: фоновой задаче можно больше, чем чату', async (t) => {
  const dir = tmpDir(t);
  const registry = new ToolRegistry();
  let runs = 0;
  registry.register({ name: 'echo', risk: 'T0', description: 'echo', parameters: { type: 'object', properties: {} }, run: async () => { runs += 1; return { ok: true, summary: 'ок' }; } });
  const agent = new Agent({
    brain: endlessBrain(),
    tools: registry,
    journal: new Journal(path.join(dir, 'j.jsonl')),
    emit: () => {},
    mode: 'full',
    workspace: dir,
    maxSteps: 20,
  });
  await agent.run('задача');
  assert.equal(runs, 20);
  assert.equal(agent.maxSteps, 20);
  assert.equal(new Agent({ brain: endlessBrain(), tools: registry, journal: new Journal(path.join(dir, 'j2.jsonl')) }).maxSteps, MAX_TOOL_STEPS);
});

test('примерные сценарии: три штуки, фразы уникальны, все шаги — известные инструменты', () => {
  assert.deepEqual(SAMPLE_COMMANDS.map((c) => c.name), ['Работа', 'Игра', 'Отбой']);
  const phrases = SAMPLE_COMMANDS.flatMap((c) => c.phrases);
  assert.equal(new Set(phrases).size, phrases.length);
  const known = new Set([...systemTools, ...desktopTools].map((t) => t.name));
  for (const cmd of SAMPLE_COMMANDS) {
    for (const step of cmd.steps) assert.ok(known.has(step.tool), `${cmd.name}: нет инструмента ${step.tool}`);
  }
});

test('seedSampleCommands: добавляет один раз и не трогает существующие команды', (t) => {
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));
  assert.deepEqual(seedSampleCommands(store), ['Работа', 'Игра', 'Отбой']);
  assert.deepEqual(seedSampleCommands(store), [], 'повторный запуск ничего не добавляет');
  assert.equal(store.findByPhrase('отбой').name, 'Отбой');
  assert.equal(store.findByPhrase('Начинаем работу').name, 'Работа');
  // Владелец поменял «Игра»: при следующем старте её не перезаписываем.
  const game = store.list().find((c) => c.name === 'Игра');
  store.save({ ...game, steps: [{ tool: 'wait', args: { ms: 1 } }] });
  seedSampleCommands(store);
  assert.equal(store.list().find((c) => c.name === 'Игра').steps.length, 1);
});

test('сценарий «Отбой» выполняется по порядку и останавливается на ошибке шага', async (t) => {
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));
  seedSampleCommands(store);
  const cmd = store.findByPhrase('спокойной ночи');
  const ran = [];
  const fake = (name, ok = true) => ({ name, risk: 'T0', description: name, parameters: { type: 'object', properties: {} }, run: async () => { ran.push(name); return { ok, summary: name }; } });
  const tools = new ToolRegistry();
  for (const n of ['speak', 'volume_set', 'wait', 'monitor_off']) tools.register(fake(n, n !== 'volume_set'));
  const out = await runCommand(cmd, { tools, policy: { decide }, journal: new Journal(path.join(dir, 'j.jsonl')), mode: 'full', workspace: dir });
  assert.deepEqual(ran, ['speak', 'volume_set'], 'после неудачного шага monitor_off не запускается');
  assert.equal(out.ok, false);
});

test('monitor_off: T1 (в режимах с вопросами спрашивает), в полном доступе — без вопросов', () => {
  const tool = desktopTools.find((t) => t.name === 'monitor_off');
  assert.equal(tool.risk, 'T1');
  assert.equal(decide({ mode: 'auto', name: 'monitor_off', risk: 'T1', args: {} }), 'ask');
  assert.equal(decide({ mode: 'full', name: 'monitor_off', risk: 'T1', args: {} }), 'allow');
});

test('app_close: T2, некорректное имя процесса отклоняется до запуска PowerShell', async () => {
  const tool = desktopTools.find((t) => t.name === 'app_close');
  assert.equal(tool.risk, 'T2');
  const bad = await tool.run({ name: 'x; Remove-Item C:\\' }, {});
  assert.equal(bad.ok, false);
  assert.equal(decide({ mode: 'auto', name: 'app_close', risk: 'T2', args: { name: 'steam' } }), 'ask');
});

test('speak: без подключённого голоса шаг падает, с голосом — говорит', async () => {
  const speak = desktopTools.find((t) => t.name === 'speak');
  assert.equal((await speak.run({ text: 'привет' }, {})).ok, false);
  const said = [];
  setSpeaker(async (text) => { said.push(text); });
  try {
    assert.equal((await speak.run({ text: 'спокойной ночи' }, {})).ok, true);
    assert.deepEqual(said, ['спокойной ночи']);
    assert.equal((await speak.run({ text: '   ' }, {})).ok, false);
  } finally {
    setSpeaker(null);
  }
});
