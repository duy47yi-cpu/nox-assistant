'use strict';

// Журнал v2 и проверка запуска: callId и итог проверки попадают в журнал; app_open и url_open проверяются опросом
// с подменяемой проверкой (без PowerShell). Срок истёк — unknown, не failed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const { systemTools } = require('../src/tools/system');
const { checkEffect } = require('../src/agent/effects');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-journal-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJournal(dir) {
  return fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

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

const byName = (name) => systemTools.find((x) => x.name === name);

test('журнал: у вызова есть callId и итог проверки', async (t) => {
  const dir = setup(t);
  const reg = new ToolRegistry();
  reg.register({
    name: 'check', risk: 'T0', description: 'x', parameters: { type: 'object', properties: {} },
    run: async () => ({ ok: true, summary: 'сделано', data: {} }),
    verify: async () => ({ status: 'unknown', evidence: 'нет признака' }),
  });
  const agent = new Agent({
    brain: scriptedBrain([
      { toolCalls: [{ id: 'call-42', name: 'check', args: {} }] },
      { content: 'Готово' },
    ]),
    tools: reg,
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: () => {},
    mode: 'auto',
    workspace: dir,
  });
  await agent.run('проверь');
  const entry = readJournal(dir).find((e) => e.tool === 'check');
  assert.equal(entry.callId, 'call-42');
  assert.equal(entry.verified, 'unknown');
  assert.equal(entry.evidence, 'нет признака');
  assert.equal(entry.ok, true);
});

test('app_open: процесс появился — confirmed', async () => {
  const tool = byName('app_open');
  const res = { ok: true, summary: 'запущено: calc', data: { process: 'calc' } };
  const v = await tool.verify({ name: 'calc' }, res, { probeProcessWindow: async (p) => p === 'calc', pollTimeoutMs: 500 });
  assert.equal(v.status, 'confirmed');
});

test('app_open: процесс не появился за срок — unknown, не failed', async () => {
  const tool = byName('app_open');
  const res = { ok: true, summary: 'запущено: steam', data: { process: 'steam' } };
  const v = await tool.verify({ name: 'steam' }, res, { probeProcessWindow: async () => false, pollTimeoutMs: 300 });
  assert.equal(v.status, 'unknown');
  assert.match(v.evidence, /окно не появилось/);
});

test('app_open: процесс есть, но окна нет — unknown, процесс сам по себе не подтверждает', async () => {
  const tool = byName('app_open');
  const res = { ok: true, summary: 'запущено: steam', data: { process: 'steam' } };
  const v = await tool.verify({ name: 'steam' }, res, { probeProcess: async () => true, probeProcessWindow: async () => false, pollTimeoutMs: 200 });
  assert.equal(v.status, 'unknown');
});

test('app_open: без имени процесса — unknown', async () => {
  const tool = byName('app_open');
  const v = await tool.verify({}, { ok: true, data: {} }, {});
  assert.equal(v.status, 'unknown');
});

// Ответ скрипта открытия: заголовок и процесс окна, плюс PID запущенного процесса.
function openOutput(fields) {
  return `шум\n${JSON.stringify({ title: '', pid: 0, process: '', path: '', startedPid: 0, ...fields })}`;
}

test('app_open: чужое новое окно (уведомление, другая программа) не подтверждает запуск', async () => {
  const { parseOpenOutput } = require('../src/tools/system');
  const tool = byName('app_open');
  const open = parseOpenOutput(openOutput({ title: 'Новое уведомление', process: 'chrome', pid: 44, startedPid: 9 }));
  const res = { ok: true, summary: 'запущено: notepad', data: { process: 'notepad', newWindow: open.title, window: open } };
  const v = await tool.verify({ name: 'notepad' }, res, { probeProcessWindow: async () => false, pollTimeoutMs: 50 });
  assert.equal(v.status, 'unknown', 'любое новое окно — не подтверждение');
  assert.match(v.evidence, /принадлежит/);
  assert.match(v.evidence, /не подтверждён/);
  const checked = await checkEffect(tool, { name: 'notepad' }, res, { probeProcessWindow: async () => false, pollTimeoutMs: 50 });
  assert.equal(checked.verified, 'unknown');
  assert.match(checked.summary, /не проверено/);
});

test('app_open: своё окно подтверждает запуск по имени процесса, пути exe или PID', async () => {
  const { parseOpenOutput } = require('../src/tools/system');
  const tool = byName('app_open');
  const nameCase = parseOpenOutput(openOutput({ title: 'Блокнот', process: 'Notepad', pid: 5, startedPid: 7 }));
  const named = await tool.verify({ name: 'notepad' }, { ok: true, data: { process: 'notepad', newWindow: nameCase.title, window: nameCase } }, {});
  assert.equal(named.status, 'confirmed');
  assert.match(named.evidence, /Notepad/);
  const pathCase = parseOpenOutput(openOutput({ title: 'Программа', process: 'other', path: 'C:\\Apps\\cool.exe', pid: 8, startedPid: 7 }));
  const byPath = await tool.verify({ name: 'C:\\Apps\\cool.exe' }, { ok: true, data: { process: 'cool', targetPath: 'C:\\Apps\\cool.exe', newWindow: pathCase.title, window: pathCase } }, {});
  assert.equal(byPath.status, 'confirmed', 'совпал путь exe');
  const pidCase = parseOpenOutput(openOutput({ title: 'Ещё окно', process: 'launcher-child', pid: 12, startedPid: 12 }));
  const byPid = await tool.verify({ name: 'launcher' }, { ok: true, data: { process: 'launcher', newWindow: pidCase.title, window: pidCase } }, {});
  assert.equal(byPid.status, 'confirmed', 'окно того же PID запуска');
  assert.deepEqual(parseOpenOutput('совсем не json'), {});
});

test('url_open: окно браузера с названием сайта найдено — confirmed', async () => {
  const tool = byName('url_open');
  const res = { ok: true, summary: 'открыто: www.example.com', data: { host: 'www.example.com' } };
  // Проверка идёт по названию сайта («example»), а не по адресу: заголовок окна адреса не содержит.
  const v = await tool.verify({ url: 'https://www.example.com' }, res, { probeWindowTitle: async (b) => b === 'example', pollTimeoutMs: 300 });
  assert.equal(v.status, 'confirmed');
});

test('url_open: в заголовках нет названия сайта — unknown с пояснением', async () => {
  const tool = byName('url_open');
  const res = { ok: true, data: { host: 'example.com' } };
  const v = await tool.verify({}, res, { probeWindowTitle: async () => false, pollTimeoutMs: 200 });
  assert.equal(v.status, 'unknown');
  assert.match(v.evidence, /example/);
});

test('checkEffect: unknown от app_open сохраняет ok и добавляет пометку', async () => {
  const tool = byName('app_open');
  const res = { ok: true, summary: 'запущено: steam', data: { process: 'steam' } };
  const out = await checkEffect(tool, { name: 'steam' }, res, { probeProcessWindow: async () => false, pollTimeoutMs: 200 });
  assert.equal(out.ok, true);
  assert.equal(out.verified, 'unknown');
  assert.match(out.summary, /не проверено/);
});
