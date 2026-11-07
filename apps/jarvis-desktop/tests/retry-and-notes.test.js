'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { LongTasks, DONE_MARK } = require('../src/missions/long');

const obj = { type: 'object', properties: {} };
const say = (content) => ({ content, toolCalls: [] });
const call = (id, name, args = {}) => ({ content: '', toolCalls: [{ id, name, args }] });

// Модель по сценарию; возвращает и ответы инструментов, которые она видела.
function scripted(steps) {
  const seen = [];
  return {
    seen,
    chat: async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last.role === 'tool') seen.push(JSON.parse(last.content));
      return steps.shift() || say('всё');
    },
  };
}

function agentWith(tools, brain, extra = {}) {
  return new Agent({ brain, tools, policy: () => 'allow', journal: { append: () => {} }, mode: 'full', ...extra });
}

test('исход неизвестен: повтор только после чтения состояния', async () => {
  let runs = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'ui_click', risk: 'T1', description: 'x', parameters: obj, run: async () => { runs += 1; return { ok: true, summary: 'нажал', verified: 'unknown' }; } });
  tools.register({ name: 'ui_elements', risk: 'T0', description: 'x', parameters: obj, run: async () => ({ ok: true, summary: 'кнопка на месте' }) });
  const window = { window: 'Тестовое окно' };
  const brain = scripted([call('1', 'ui_click', window), call('2', 'ui_click', window), call('3', 'ui_elements', window), call('4', 'ui_click', window)]);
  await agentWith(tools, brain).run('нажми');
  assert.equal(runs, 2);
  assert.equal(brain.seen[1].ok, false);
  assert.match(brain.seen[1].summary, /исход этого действия неизвестен/);
  assert.equal(brain.seen[3].ok, true);
});

test('исход desktop_click неизвестен: снимок сцены снимает запрет на повтор', async () => {
  let runs = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'desktop_click', risk: 'T1', description: 'x', parameters: obj, run: async () => { runs += 1; return { ok: true, summary: 'нажал', verified: 'unknown' }; } });
  tools.register({ name: 'desktop_observe', risk: 'T0', description: 'x', parameters: obj, run: async () => ({ ok: true, summary: 'сцена' }) });
  const brain = scripted([
    call('1', 'desktop_click', { id: 'e12ab34' }),
    call('2', 'desktop_click', { id: 'e12ab34' }),
    call('3', 'desktop_observe', { window: 'Тестовое окно' }),
    call('4', 'desktop_click', { id: 'e12ab34' }),
  ]);
  await agentWith(tools, brain).run('нажми');
  assert.equal(runs, 2, 'вслепую не повторяем, после снимка — можно');
  assert.match(brain.seen[1].summary, /исход этого действия неизвестен/);
  assert.equal(brain.seen[3].ok, true);
});

test('сбой посреди действия — тоже неизвестный исход', async () => {
  let runs = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'ui_type', risk: 'T1', description: 'x', parameters: obj, run: async () => { runs += 1; throw new Error('таймаут'); } });
  const brain = scripted([call('1', 'ui_type'), call('2', 'ui_type')]);
  await agentWith(tools, brain).run('введи');
  assert.equal(runs, 1);
  assert.match(brain.seen[1].summary, /неизвестен/);
});

test('отправка без подтверждения не повторяется даже после чтения', async () => {
  let runs = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'mail_send', risk: 'T2', description: 'x', parameters: obj, run: async () => { runs += 1; return { ok: true, summary: 'ушло?', verified: 'unknown' }; } });
  tools.register({ name: 'browser_read', risk: 'T0', description: 'x', parameters: obj, run: async () => ({ ok: true, summary: 'страница' }) });
  const brain = scripted([call('1', 'mail_send'), call('2', 'browser_read'), call('3', 'mail_send')]);
  await agentWith(tools, brain).run('отправь');
  assert.equal(runs, 1);
  assert.match(brain.seen[2].summary, /без подтверждения не повторяют/);
});

test('после перезапуска снимок сцены тоже снимает запрет', async () => {
  const done = [];
  const tools = new ToolRegistry();
  tools.register({ name: 'ui_click', risk: 'T1', description: 'x', parameters: obj, run: async () => { done.push('click'); return { ok: true, summary: 'нажал' }; } });
  tools.register({ name: 'desktop_observe', risk: 'T0', description: 'x', parameters: obj, run: async () => { done.push('observe'); return { ok: true, summary: 'сцена' }; } });
  const brain = scripted([call('1', 'ui_click'), call('2', 'desktop_observe'), call('3', 'ui_click')]);
  const agent = agentWith(tools, brain, { lookFirst: true });
  await agent.run('продолжай');
  assert.deepEqual(done, ['observe', 'click'], 'снимок сцены заменил снимок экрана');
  assert.equal(agent.lookFirst, false);
});

test('после перезапуска действия ждут снимка экрана', async () => {
  const done = [];
  const tools = new ToolRegistry();
  tools.register({ name: 'ui_click', risk: 'T1', description: 'x', parameters: obj, run: async () => { done.push('click'); return { ok: true, summary: 'нажал' }; } });
  tools.register({ name: 'screen_look', risk: 'T1', description: 'x', parameters: obj, run: async () => { done.push('look'); return { ok: true, summary: 'снимок' }; } });
  const brain = scripted([call('1', 'ui_click'), call('2', 'screen_look'), call('3', 'ui_click')]);
  const agent = agentWith(tools, brain, { lookFirst: true });
  await agent.run('продолжай');
  assert.deepEqual(done, ['look', 'click']);
  assert.match(brain.seen[0].summary, /screen_look/);
  assert.equal(agent.lookFirst, false);
});

function longSetup(t, brain, tools = new ToolRegistry()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tasks = new LongTasks({ file: path.join(dir, 'long.json'), reportsDir: path.join(dir, 'r'), brain, tools, journal: { append: () => {} }, workspace: dir, notify: () => {}, sleep: async () => {} });
  return { dir, tasks };
}

test('следующий блок начинается с записок, а не с сырого отчёта', async (t) => {
  const seen = [];
  const replies = ['долгий черновой поиск\nЗАПИСКИ:\nСделано: нашёл А\nОсталось: Б\nСсылки: https://a.example', `${DONE_MARK}: готово`];
  const brain = { chat: async ({ messages }) => { seen.push(messages[messages.length - 1].content); return say(replies.shift()); } };
  const { tasks } = longSetup(t, brain);
  const item = tasks.start({ goal: 'узнать', hours: 1 });
  await tasks.done;
  assert.match(seen[0], /Сделано: пока ничего/);
  assert.match(seen[1], /Сделано: нашёл А/);
  assert.match(seen[1], /https:\/\/a\.example/);
  assert.doesNotMatch(seen[1], /черновой поиск/);
  assert.match(fs.readFileSync(item.report, 'utf8'), /черновой поиск/);
  assert.match(fs.readFileSync(item.notes, 'utf8'), /^# Цель\nузнать/);
});

test('перезапуск поручения с руками: продолжает со сверки экрана', async (t) => {
  const seen = [];
  const brain = { chat: async ({ messages }) => { seen.push(messages[messages.length - 1].content); return say(DONE_MARK); } };
  const { tasks, dir } = longSetup(t, brain);
  const report = path.join(dir, 'rep.md');
  fs.writeFileSync(report, '# руки\n');
  const later = new Date(Date.now() + 3600000).toISOString();
  fs.writeFileSync(tasks.file, JSON.stringify({ items: [{ id: 'b', goal: 'руки', useDesktop: true, status: 'running', deadline: later, report }] }));
  tasks.resume();
  await tasks.done;
  assert.equal(tasks.list()[0].status, 'done');
  assert.match(seen[0], /Первым шагом сделай снимок экрана/);
  assert.match(seen[0], /# руки/); // старое поручение без файла записок читает хвост отчёта
});
