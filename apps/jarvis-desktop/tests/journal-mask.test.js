'use strict';

// Журнал не хранит набранный текст (ui_type, clipboard_set): в записи только его длина.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Journal, maskArgs, maskEventForWindow, maskHistory } = require('../src/journal/journal');
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
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });
  const agent = new Agent({
    brain,
    tools,
    approvals,
    journal: new Journal(file),
    emit: (e) => { if (e.type === 'approval_request') approvals.respond(e.id, 'once'); },
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

// ── F-1: набранный текст desktop_type и будущих инструментов ввода не утекает ──

test('F-1: desktop_type — набранный текст не попадает в журнал, только длина', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-f1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.jsonl');
  const phrase = 'уникальная фраза 12345';
  const journal = new Journal(file);
  journal.append({ tool: 'desktop_type', risk: 'T1', args: { id: 'eabcdef012345', text: phrase }, ok: true, summary: 'введено' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(phrase), 'в журнале нет набранного текста');
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.args.text, `[скрыто, ${Array.from(phrase).length} симв.]`);
  assert.equal(entry.args.id, 'eabcdef012345', 'id элемента остаётся: без него журнал теряет связь с действием');
});

test('F-1: будущий инструмент ввода маскируется по имени, а не по списку', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-f1-name-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.jsonl');
  const journal = new Journal(file);
  journal.append({ tool: 'future_input', args: { text: 'секрет' }, ok: true });
  journal.append({ tool: 'field_paste', args: { value: 'ещё секрет' }, ok: true });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('секрет'), 'текст ввода скрыт по смыслу аргумента и имени инструмента');
  assert.match(raw, /\[скрыто, 6 симв\.\]/);
  // Не-ввод остаётся как есть: путь и обычное содержимое файла владельцу видны.
  assert.deepEqual(maskArgs('workspace_write', { path: 'a.md', content: 'текст' }), { path: 'a.md', content: 'текст' });
});

test('F-1: maskEventForWindow скрывает args.text у desktop_type и не теряет маскировку секретов', () => {
  const ev = { type: 'tool_start', name: 'desktop_type', args: { id: 'eabcdef012345', text: 'фраза владельцу не видна' } };
  const out = maskEventForWindow(ev);
  assert.ok(!JSON.stringify(out).includes('фраза владельцу не видна'), 'набранный текст не уходит в окно вторым экземпляром');
  assert.match(out.args.text, /^\[скрыто, \d+ симв\.\]$/);
  assert.equal(ev.args.text, 'фраза владельцу не видна', 'ядро получает исходные аргументы');
  // Регрессия ZM-008/SEC-19: секрет в аргументах не-ввода по-прежнему скрыт (maskSecrets не потерян).
  const secretEv = { type: 'approval_request', name: 'mail_send', args: { to: 'ivan@example.com', password: 'hunter22' } };
  const secretOut = maskEventForWindow(secretEv);
  assert.equal(secretOut.args.to, 'ivan@example.com');
  assert.ok(!JSON.stringify(secretOut).includes('hunter22'));
});

test('F-1: maskHistory скрывает tool_calls desktop_type в файле чата', () => {
  const phrase = 'секретное сообщение 999';
  const history = [
    { role: 'user', content: 'напиши' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: { name: 'desktop_type', arguments: JSON.stringify({ id: 'eabcdef012345', text: phrase }) } }] },
    { role: 'tool', tool_call_id: 'd1', content: JSON.stringify({ ok: true, summary: 'введено' }) },
  ];
  const saved = maskHistory(history);
  assert.ok(!JSON.stringify(saved).includes(phrase), 'в сохранённой истории нет набранного текста');
  const call = saved[1].tool_calls[0];
  assert.match(JSON.parse(call.function.arguments).text, /^\[скрыто, \d+ симв\.\]$/);
});

test('F-1 маркер: ход с desktop_type — фразы нет ни в журнале, ни в истории чата', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-f1-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.jsonl');
  const phrase = 'маркер-УтЕчКа-777';
  let typed = null;
  const tools = new ToolRegistry();
  tools.register({
    name: 'desktop_type', risk: 'T0', description: 'ввод', parameters: { type: 'object', properties: {} },
    run: async (args) => { typed = args.text; return { ok: true, summary: 'введено', data: {} }; },
  });
  const brain = scriptedBrain([
    { toolCalls: [{ id: 'd1', name: 'desktop_type', args: { id: 'eabcdef012345', text: phrase } }] },
    { content: 'Готово' },
  ]);
  const agent = new Agent({
    brain, tools, approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(file), emit: () => {}, mode: 'auto', workspace: dir,
  });
  await agent.run('введи сообщение');
  assert.equal(typed, phrase, 'инструмент получает текст полностью');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(phrase), 'в journal.jsonl нет фразы');
  assert.ok(!JSON.stringify(maskHistory(agent.history)).includes(phrase), 'в файле чата (maskHistory) нет фразы');
});