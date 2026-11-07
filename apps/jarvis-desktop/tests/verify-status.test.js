'use strict';

// Статус проверки от ядра до окна: событие tool_result несёт verified, окно различает итоги.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { Agent } = require('../src/agent/loop');
const { Journal } = require('../src/journal/journal');
const { runCommand } = require('../src/commands/runner');

// shared.js рассчитан на браузер: для чистых функций статуса хватает пустых window и document.
function loadUi() {
  const window = { addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/shared.js'), 'utf8'), { window, document: {}, Set, Map, Date, console });
  return window.JarvisUI;
}

test('окно различает подтверждено, не проверено, провалено и выполнено без проверки', () => {
  const U = loadUi();
  assert.equal(U.statusOfResult(true, 'x', false, 'confirmed'), 'confirmed');
  assert.equal(U.statusOfResult(true, 'x', false, 'unknown'), 'unverified');
  assert.equal(U.statusOfResult(false, 'x', false, 'failed'), 'failed');
  assert.equal(U.statusOfResult(true, 'x', false), 'done');
  assert.equal(U.statusOfResult(false, 'x', false), 'error');
  assert.equal(U.statusOfResult(false, 'отклонено', false), 'refused');
  assert.equal(U.statusOfRecord({ ok: true, verified: 'unknown' }), 'unverified');
  assert.equal(U.statusOfRecord({ ok: false, verified: 'failed' }), 'failed');
  assert.equal(U.statusOfRecord({ ok: true, verified: 'confirmed' }), 'confirmed');
  assert.equal(U.statusOfRecord({ ok: true, verified: null }), 'done');
  for (const s of ['confirmed', 'unverified', 'failed']) assert.ok(U.STATUS_TEXT[s]);
});

function toolWith(verify) {
  return { name: 't', risk: 'T0', async run() { return { ok: true, summary: 'сделано' }; }, verify };
}

test('tool_result из чата несёт verified и evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  let round = 0;
  const brain = { async chat() {
    round += 1;
    return round === 1 ? { content: '', toolCalls: [{ id: 'c1', name: 't', args: {} }] } : { content: 'ок', toolCalls: [] };
  } };
  const tool = toolWith(async () => ({ status: 'confirmed', evidence: 'файл на месте' }));
  const agent = new Agent({
    brain, tools: { get: () => tool, list: () => [tool] }, policy: () => 'allow',
    journal: new Journal(path.join(dir, 'j.jsonl')), emit: (e) => events.push(e),
  });
  await agent.run('сделай');
  const r = events.find((e) => e.type === 'tool_result');
  assert.equal(r.verified, 'confirmed');
  assert.equal(r.evidence, 'файл на месте');
});

test('шаг команды отдаёт verified в событии и в итоге', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const tool = toolWith(async () => ({ status: 'unknown', evidence: 'нечем проверить' }));
  const out = await runCommand({ id: 'c', name: 'к', steps: [{ tool: 't', args: {} }] }, {
    tools: { get: () => tool }, policy: { decide: () => 'allow' },
    journal: new Journal(path.join(dir, 'j.jsonl')), workspace: dir, mode: 'full', emit: (e) => events.push(e),
  });
  assert.equal(out.results[0].verified, 'unknown');
  assert.equal(events.find((e) => e.type === 'tool_result').verified, 'unknown');
});
