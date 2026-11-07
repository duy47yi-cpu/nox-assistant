'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LongTasks, longPolicy, DONE_MARK } = require('../src/missions/long');
const { ToolRegistry } = require('../src/tools/registry');
const { mouseTools, SCRIPT } = require('../src/tools/mouse');
const { guardDesktopTools, DesktopLock } = require('../src/control/desktop-lock');

function setup(t, brain, { now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-long-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const notes = [];
  const tasks = new LongTasks({ file: path.join(dir, 'long.json'), reportsDir: path.join(dir, 'r'), brain, tools: new ToolRegistry(), journal: { append: () => {} }, workspace: dir, notify: (n) => notes.push(n), now: now || (() => new Date()), sleep: async () => {} });
  return { dir, tasks, notes };
}
const say = (content) => ({ content, toolCalls: [] });

test('работает блоками, записки переходят в следующий блок, ГОТОВО завершает', async (t) => {
  const seen = [];
  const replies = ['нашёл источник А', `${DONE_MARK}: отчёт собран`];
  const brain = { chat: async ({ messages }) => { seen.push(messages[messages.length - 1].content); return say(replies.shift()); } };
  const { tasks, notes } = setup(t, brain);
  const item = tasks.start({ goal: 'узнать', hours: 1 });
  await tasks.done;
  const saved = tasks.list()[0];
  assert.equal(saved.status, 'done');
  assert.equal(saved.blocks, 2);
  assert.match(seen[1], /нашёл источник А/);
  assert.match(fs.readFileSync(item.report, 'utf8'), /Итог: done/);
  assert.match(notes[0].title, /выполнено/);
});

test('шаги кончились: блок всё равно оставляет записки, а не пустое сообщение', async (t) => {
  const { ToolRegistry: Reg } = require('../src/tools/registry');
  const { Agent } = require('../src/agent/loop');
  const tools = new Reg();
  tools.register({ name: 'look', risk: 'T0', description: 'x', parameters: { type: 'object', properties: {} }, run: async () => ({ ok: true, summary: 'да' }) });
  let i = 0;
  const seen = [];
  const brain = { chat: async (a) => { seen.push(a.toolChoice); i += 1; return a.toolChoice === 'none' ? say('вот что нашёл') : { content: '', toolCalls: [{ id: `c${i}`, name: 'look', args: { n: i } }] }; } };
  const texts = [];
  const agent = new Agent({ brain, tools, policy: () => 'allow', journal: { append: () => {} }, maxSteps: 2, closeOnLimit: true, emit: (e) => { if (e.type === 'text') texts.push(e.delta); } });
  const { outcome } = await agent.run('x');
  assert.equal(outcome, 'loop');
  assert.equal(seen.at(-1), 'none');
  assert.equal(texts.join(''), 'вот что нашёл');
  t.diagnostic('ok');
});

test('срок выходит: остановка, собранное остаётся', async (t) => {
  let ms = Date.parse('2026-11-01T10:00:00Z');
  const brain = { chat: async () => { ms += 40 * 60000; return say('работаю'); } };
  const { tasks } = setup(t, brain, { now: () => new Date(ms) });
  tasks.start({ goal: 'x', hours: 1 });
  await tasks.done;
  assert.equal(tasks.list()[0].status, 'deadline');
  assert.equal(tasks.list()[0].blocks, 2);
});

test('кончился бюджет: сразу остановка, без цикла', async (t) => {
  let calls = 0;
  const brain = { chat: async () => { calls += 1; throw Object.assign(new Error('лимит'), { code: 'budget' }); } };
  const { tasks } = setup(t, brain);
  tasks.start({ goal: 'x', hours: 1 });
  await tasks.done;
  assert.equal(tasks.list()[0].status, 'budget');
  assert.equal(calls, 1);
});

test('три сбоя подряд: остановка', async (t) => {
  let calls = 0;
  const brain = { chat: async () => { calls += 1; throw new Error('сеть'); } };
  const { tasks } = setup(t, brain);
  tasks.start({ goal: 'x', hours: 1 });
  await tasks.done;
  assert.equal(tasks.list()[0].status, 'failed');
  assert.equal(calls, 3);
});

test('стоп владельца прерывает', async (t) => {
  const brain = { chat: ({ signal }) => new Promise((_, rej) => { signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))); }) };
  const { tasks } = setup(t, brain);
  const item = tasks.start({ goal: 'x', hours: 1 });
  await new Promise((r) => setImmediate(r));
  assert.equal(tasks.stop(item.id), true);
  await tasks.done;
  assert.equal(tasks.list()[0].status, 'stopped');
});

// Поручение с руками теперь продолжается после перезапуска: первым шагом снимок экрана (retry-and-notes.test.js).
test('после падения: продолжаются и поиск, и поручение с руками', async (t) => {
  const { tasks, dir } = setup(t, { chat: async () => say(DONE_MARK) });
  const report = path.join(dir, 'rep.md');
  fs.writeFileSync(report, '# цель\n');
  const later = new Date(Date.now() + 3600000).toISOString();
  fs.writeFileSync(tasks.file, JSON.stringify({ items: [
    { id: 'a', goal: 'поиск', useDesktop: false, status: 'running', deadline: later, report },
    { id: 'b', goal: 'руки', useDesktop: true, status: 'running', deadline: later, report },
  ] }));
  tasks.resume();
  await tasks.done;
  const [a, b] = tasks.list();
  assert.equal(a.status, 'done');
  assert.equal(b.status, 'done');
});

test('права: руки только по разрешению, чувствительное запрещено всегда', () => {
  const plain = longPolicy({ useDesktop: false });
  const hands = longPolicy({ useDesktop: true });
  const ws = 'D:\\ws';
  assert.equal(plain({ name: 'web_search', risk: 'T0' }), 'allow');
  assert.equal(plain({ name: 'ui_click', risk: 'T1', args: { window: 'x' }, workspace: ws }), 'deny');
  assert.equal(hands({ name: 'ui_click', risk: 'T1', args: { window: 'Блокнот' }, workspace: ws }), 'allow');
  assert.equal(hands({ name: 'mouse_click', risk: 'T1', args: { window: 'AyuGram', x: 1, y: 1 }, workspace: ws }), 'deny');
  assert.equal(hands({ name: 'ui_type', risk: 'T1', args: { window: 'Сбербанк' }, workspace: ws }), 'deny');
  assert.equal(hands({ name: 'shell_run', risk: 'T3', args: {}, workspace: ws }), 'deny');
  assert.equal(hands({ name: 'pc_shutdown', risk: 'T2', args: {}, workspace: ws }), 'deny');
  assert.equal(plain({ name: 'workspace_write', risk: 'T1', args: { path: 'a.md' }, workspace: ws, hasPathParam: true }), 'allow');
  assert.equal(plain({ name: 'app_open', risk: 'T1', args: { path: 'a.md' }, workspace: ws, hasPathParam: false }), 'deny');
  // После недоверенного текста в фоне исходящее не выполняется: спросить некого.
  const full = longPolicy({ mode: 'full', useDesktop: false });
  assert.equal(full({ name: 'web_search', risk: 'T0', args: {}, workspace: ws, tainted: true }), 'allow');
  assert.equal(full({ name: 'mail_send', risk: 'T2', args: {}, workspace: ws, tainted: true }), 'deny');
  assert.equal(full({ name: 'mail_send', risk: 'T2', args: {}, workspace: ws, tainted: false }), 'allow');
  // После чужого текста руками в фоне тоже не действуем: спросить некого.
  const desktopFull = longPolicy({ mode: 'full', useDesktop: true });
  assert.equal(desktopFull({ name: 'ui_click', risk: 'T1', args: { window: 'Блокнот' }, workspace: ws, handsTainted: false }), 'allow');
  assert.equal(desktopFull({ name: 'ui_click', risk: 'T1', args: { window: 'Блокнот' }, workspace: ws, handsTainted: true }), 'deny');
});

test('мышь: значения проверяются, отказы понятные, замок надет', async () => {
  const calls = [];
  const runner = async (_s, env) => { calls.push(env); return { ok: true, data: { stdout: '{"status":"occluded","title":"t"}' } }; };
  const [click, scroll] = mouseTools({ runner });
  assert.equal((await click.run({ window: 'x', x: -1, y: 0 })).ok, false);
  assert.equal(calls.length, 0);
  assert.match((await click.run({ window: 'x', x: 1, y: 2 })).summary, /закрывает другое окно/);
  assert.equal(calls[0].JARVIS_MOUSE_X, '1');
  assert.equal((await scroll.run({ window: 'x', x: 1, y: 2, lines: 0 })).ok, false);
  const lock = new DesktopLock();
  lock.setLocked(true);
  const [guarded] = guardDesktopTools([click], lock);
  assert.equal((await guarded.run({ window: 'x', x: 1, y: 2 }, {})).data.state, 'blocked_desktop');
});

test('мышь: распознанный платёж отклоняется; обычное нажатие и прокрутка доступны', async () => {
  let response = 'payment';
  const runner = async () => ({ ok: true, data: { stdout: JSON.stringify({ status: response, title: 'Окно' }) } });
  const [click, scroll] = mouseTools({ runner });
  const blocked = await click.run({ window: 'Окно', x: 20, y: 30 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.summary, /оплату выполняет владелец/);
  response = 'ok';
  assert.equal((await click.run({ window: 'Окно', x: 20, y: 30 })).ok, true);
  assert.equal((await scroll.run({ window: 'Окно', x: 20, y: 30, lines: 1 })).ok, true);
});

test('мышь: опасная подпись под точкой — отказ без нажатия', async () => {
  for (const [kind, label] of [['delete', /удаление/], ['install', /установка/], ['power', /выключение/]]) {
    // PowerShell сообщает вид опасной подписи, JS обязан отказать и не считать исход нажатием.
    const runner = async () => ({ ok: true, data: { stdout: JSON.stringify({ status: 'danger', kind, title: 'Окно' }) } });
    const [click] = mouseTools({ runner });
    const refused = await click.run({ window: 'Окно', x: 20, y: 30 });
    assert.equal(refused.ok, false, kind);
    assert.match(refused.summary, label, kind);
    assert.match(refused.summary, /мышью не нажимаю/);
    assert.deepEqual(refused.data, { status: 'danger', kind });
  }
  // Признак опасной подписи определяется в той же петле по родителям, но до событий мыши:
  // до нажатия проверка успевает отказать. Признак оплаты остаётся с прежним текстом.
  assert.match(SCRIPT, /function Test-JDangerAtPoint/);
  assert.ok(SCRIPT.indexOf('Test-JPaymentAtPoint $x $y') < SCRIPT.indexOf('Test-JDangerAtPoint $x $y'));
  assert.ok(SCRIPT.indexOf('Test-JDangerAtPoint $x $y') < SCRIPT.indexOf('mouse_event($down'));
});

test('капча в фоне: поручение на паузе «нужен человек» с уведомлением, long_task_resume продолжает с записок', async (t) => {
  const { longTools } = require('../src/missions/long');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-long-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tools = new ToolRegistry();
  tools.register({ name: 'site', risk: 'T0', description: 'x', parameters: { type: 'object', properties: {} }, run: async () => ({ ok: false, summary: 'сайт просит подтверждение, нужен человек', data: { needsHuman: true } }) });
  let calls = 0;
  const brain = { chat: async () => { calls += 1; return calls === 1 ? { content: '', toolCalls: [{ id: 'c1', name: 'site', args: {} }] } : say(`${DONE_MARK}: готово`); } };
  const notes = [];
  const tasks = new LongTasks({ file: path.join(dir, 'long.json'), reportsDir: path.join(dir, 'r'), brain, tools, journal: { append: () => {} }, workspace: dir, notify: (n) => notes.push(n), mode: 'full', sleep: async () => {} });
  const item = tasks.start({ goal: 'зайти на сайт', hours: 1 });
  await tasks.done;
  assert.equal(tasks.list()[0].status, 'needs_human');
  assert.equal(calls, 1, 'после капчи модель не идёт дальше');
  assert.match(notes[0].title, /нужен человек/);
  assert.match(notes[0].body, /разберись/);

  const resume = longTools(tasks).find((x) => x.name === 'long_task_resume');
  assert.equal((await resume.run({ id: 'нет-такого' })).ok, false);
  assert.equal((await resume.run({ id: item.id })).ok, true);
  await tasks.done;
  assert.equal(tasks.list()[0].status, 'done');
  assert.equal((await resume.run({ id: item.id })).ok, false, 'выполненное не перезапускается');
});
