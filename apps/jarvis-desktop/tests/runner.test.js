'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runMission } = require('../src/missions/runner');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scriptedBrain(steps) {
  let i = 0;
  return {
    async chat() {
      const step = steps[i] || { content: '' };
      i += 1;
      return { content: step.content || '', reasoningContent: null, toolCalls: step.toolCalls || [] };
    },
  };
}

test('фоновая задача: T2-инструмент отклоняется, отчёт пишется в файл, журнал помечен задачей', async (t) => {
  const dir = setup(t);
  let shellRuns = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: 'shell_run', risk: 'T2', parameters: { type: 'object', properties: {} },
    run: async () => { shellRuns += 1; return { ok: true, summary: 'выполнено' }; },
  });
  tools.register({
    name: 'windows_list', risk: 'T0', parameters: { type: 'object', properties: {} },
    run: async () => ({ ok: true, summary: 'окон: 2', data: {} }),
  });
  const brain = scriptedBrain([
    { toolCalls: [{ id: 'a', name: 'shell_run', args: { command: 'rm -rf x' } }] },
    { toolCalls: [{ id: 'b', name: 'windows_list', args: {} }] },
    { content: 'Открыто два окна. Ничего не менял.' },
  ]);
  const journal = new Journal(path.join(dir, 'journal.jsonl'));

  const { report, file } = await runMission(
    { id: 'm1', goal: 'посмотреть окна' },
    { brain, tools, journal, workspace: dir, reportsDir: path.join(dir, 'reports'), now: () => new Date('2026-10-27T09:00:00Z') },
  );

  assert.equal(shellRuns, 0, 'T2 не должен выполняться без владельца');
  assert.match(report, /Ничего не менял/);
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf8'), /посмотреть окна/);

  const lines = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].decision, 'reject');
  assert.equal(lines[0].source, 'mission');
  assert.equal(lines[0].mission, 'm1');
  assert.equal(lines[1].decision, 'allow');
});
