'use strict';

// Снимок блока долгого поручения (идея LangGraph): в записках остаётся явная машиночитаемая строка
// checkpoint, следующий блок видит её и не повторяет уже подтверждённые шаги.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LongTasks, DONE_MARK, checkpointLine, readCheckpoint } = require('../src/missions/long');
const { ToolRegistry } = require('../src/tools/registry');

function setup(t, brain, { now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-checkpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tasks = new LongTasks({
    file: path.join(dir, 'long.json'),
    reportsDir: path.join(dir, 'r'),
    brain,
    tools: new ToolRegistry(),
    journal: { append: () => {} },
    workspace: dir,
    notify: () => {},
    now: now || (() => new Date()),
    sleep: async () => {},
  });
  return { dir, tasks };
}

const say = (content) => ({ content, toolCalls: [] });

test('строка checkpoint пишется и разбирается обратно', () => {
  const line = checkpointLine({ block: 3, outcome: 'answer', done: ['app_open', 'workspace_read'], confirmed: 2, unverified: 1, at: '2026-11-08T10:00:00.000Z' });
  assert.match(line, /^checkpoint: block=3 /);
  assert.match(line, /done=\[app_open,workspace_read\]/);
  const parsed = readCheckpoint(`Сделано: что-то\n${line}\nОсталось: ещё`);
  assert.equal(parsed.block, 3);
  assert.equal(parsed.outcome, 'answer');
  assert.equal(parsed.confirmed, 2);
  assert.equal(parsed.unverified, 1);
  assert.deepEqual(parsed.done, ['app_open', 'workspace_read']);
  assert.equal(parsed.raw, line);
  assert.equal(readCheckpoint('без снимка'), null);
});

test('после блока в записках остаётся снимок, следующий блок видит его в подсказке', async (t) => {
  const seen = [];
  const replies = ['нашёл источник А', `${DONE_MARK}: отчёт собран`];
  const brain = { chat: async ({ messages }) => { seen.push(messages[messages.length - 1].content); return say(replies.shift()); } };
  const { tasks } = setup(t, brain);
  const item = tasks.start({ goal: 'узнать', hours: 1 });
  await tasks.done;

  const notes = fs.readFileSync(item.notes, 'utf8');
  assert.match(notes, /checkpoint: block=2/, 'в записках последний снимок блока');
  assert.match(notes, /outcome=answer/);
  assert.match(seen[1] || '', /Снимок прошлого блока: checkpoint: block=1/);
  assert.match(seen[1] || '', /не повторяй эти шаги/i);
});

test('блок без текста всё равно оставляет снимок', async (t) => {
  let ms = Date.parse('2026-11-01T10:00:00Z');
  const brain = { chat: async () => { ms += 40 * 60000; return say(''); } };
  const { tasks } = setup(t, brain, { now: () => new Date(ms) });
  const item = tasks.start({ goal: 'подождать', hours: 1 });
  await tasks.done;
  assert.equal(tasks.list()[0].status, 'deadline');
  assert.match(fs.readFileSync(item.notes, 'utf8'), /checkpoint: block=2/);
});
