'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const { commandReply } = require('../src/commands/runner');
const { TurnLog } = require('../src/agent/turnlog');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-chatmem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('commandReply: итог и строка на каждый шаг; длинный итог обрезается', () => {
  const cmd = { name: 'Громкость' };
  const ok = commandReply(cmd, { ok: true, results: [{ tool: 'set_volume', ok: true, summary: 'громкость 30' }] });
  assert.equal(ok, 'Команда «Громкость» выполнена.\n- set_volume: громкость 30');

  const failed = commandReply(cmd, {
    ok: false,
    results: [
      { tool: 'set_volume', ok: true, summary: 'громкость 30' },
      { tool: 'url_open', ok: false, summary: 'я'.repeat(500) },
    ],
  });
  const [head, first, second] = failed.split('\n');
  assert.equal(head, 'Команда «Громкость» остановлена на шаге с ошибкой.');
  assert.equal(first, '- set_volume: громкость 30');
  assert.equal(second, `- url_open: ${'я'.repeat(200)}`);

  assert.equal(commandReply({ name: 'Пусто' }, { ok: false, results: [] }), 'Команда «Пусто» остановлена на шаге с ошибкой.');
});

test('ярлык в истории: следующий ход видит, что команда уже выполнена', async (t) => {
  const dir = setup(t);
  const sent = [];
  const brain = {
    async chat({ messages }) {
      sent.push(messages);
      return { content: 'Ок', reasoningContent: null, toolCalls: [] };
    },
  };
  const agent = new Agent({
    brain,
    tools: new ToolRegistry(),
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: () => {},
    mode: 'full',
    workspace: dir,
  });

  // То же, что делает main.js при ярлыке: фраза и итог команды попадают в историю.
  agent.remember('громкость 30', commandReply({ name: 'Громкость' }, { ok: true, results: [{ tool: 'set_volume', ok: true, summary: 'громкость 30' }] }));
  await agent.run('а теперь 50');

  const texts = sent[0].map((m) => m.content);
  assert.ok(texts.includes('громкость 30'));
  assert.ok(texts.some((text) => text.includes('Команда «Громкость» выполнена.')));
});

test('turns.jsonl: ошибка сети записывается с причиной из err.cause', async (t) => {
  const dir = setup(t);
  const turnLog = new TurnLog(path.join(dir, 'turns.jsonl'));
  const brain = {
    async chat() {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    },
  };
  const agent = new Agent({
    brain,
    tools: new ToolRegistry(),
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: () => {},
    mode: 'full',
    workspace: dir,
    turnsLog: turnLog,
  });

  await agent.run('привет');

  const records = fs.readFileSync(path.join(dir, 'turns.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const model = records.find((e) => e.kind === 'model');
  assert.equal(model.ok, false);
  assert.equal(model.error, 'TypeError:ECONNRESET');
});
