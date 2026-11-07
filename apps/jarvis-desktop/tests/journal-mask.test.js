'use strict';

// Журнал не хранит набранный текст (ui_type, clipboard_set): в записи только его длина.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Journal, maskArgs } = require('../src/journal/journal');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { ApprovalBroker } = require('../src/policy/approvals');

// Фейковый мозг: отдаёт ответы по сценарию по одному на каждый вызов chat().
function scriptedBrain(steps) {
  let i = 0;
  return {
    async chat() {
      const s = steps[i++];
      if (!s) throw new Error('сценарий закончился');
      return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] };
    },
  };
}

test('maskArgs: текст ui_type и clipboard_set заменяется длиной, остальное без изменений', () => {
  const args = { window: 'Блокнот', name: 'Пароль', text: 'секрет-12345' };
  const masked = maskArgs('ui_type', args);
  assert.deepEqual(masked, { window: 'Блокнот', name: 'Пароль', text: '[скрыто, 12 симв.]' });
  assert.equal(args.text, 'секрет-12345', 'исходные аргументы не меняются');
  assert.deepEqual(maskArgs('clipboard_set', { text: 'abc' }), { text: '[скрыто, 3 симв.]' });
  assert.deepEqual(maskArgs('workspace_write', { path: 'a.md', content: 'текст' }), { path: 'a.md', content: 'текст' });
  assert.equal(maskArgs('ui_type', undefined), undefined);
  assert.equal(maskArgs('ui_type', 'строка'), 'строка');
});

test('журнал после вызова ui_type не содержит исходного текста', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mask-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.jsonl');
  const secret = 'пароль-XyZ-987';
  let typed = null;

  const tools = new ToolRegistry();
  tools.register({
    name: 'ui_type', risk: 'T0', description: 'ввод', parameters: { type: 'object', properties: {} },
    run: async (args) => {
      typed = args.text; // инструмент получает текст полностью
      return { ok: true, summary: 'введено', data: {} };
    },
  });
  const brain = scriptedBrain([
    { toolCalls: [{ id: 'u1', name: 'ui_type', args: { window: 'Вход', text: secret } }] },
    { content: 'Готово' },
  ]);
  const agent = new Agent({
    brain,
    tools,
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(file),
    emit: () => {},
    mode: 'auto',
    workspace: dir,
  });

  await agent.run('введи пароль');

  assert.equal(typed, secret);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(secret), 'в журнале нет набранного текста');
  const [entry] = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entry.tool, 'ui_type');
  assert.deepEqual(entry.args, { window: 'Вход', text: `[скрыто, ${secret.length} симв.]` });
});

test('id команды (UUID) не считается секретом и остаётся в журнале', () => {
  const { maskSecrets } = require('../src/journal/journal');
  const id = '2b1e6c2a-1111-4a2b-8c3d-0123456789ab';
  const masked = maskSecrets({ command: id, note: 'ключ a1b2c3d4e5f60718293a4b5c6d7e8f90 в тексте' });
  assert.equal(masked.command, id, 'UUID остаётся как есть: без него история теряет связь с делом');
  assert.match(masked.note, /\[скрыто, 32 симв\.\]/, 'длинный токен без метки по-прежнему скрыт');
});