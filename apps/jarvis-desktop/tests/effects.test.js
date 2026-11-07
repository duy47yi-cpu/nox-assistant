'use strict';

// Проверка результата действия: confirmed / failed / unknown. Фейковые инструменты и настоящая запись в рабочую папку.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkEffect } = require('../src/agent/effects');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');
const { codeTools } = require('../src/tools/code');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const { runCommand } = require('../src/commands/runner');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-effects-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const OK = Object.freeze({ ok: true, summary: 'записал', data: { path: 'notes/a.md', created: true } });

test('инструмент без verify возвращает результат без изменений', async () => {
  const tool = { name: 'plain' };
  const out = await checkEffect(tool, {}, { ...OK }, {});
  assert.deepEqual(out, OK);
});

test('confirmed: ok сохраняется, summary не меняется, данные на месте', async () => {
  const tool = { name: 't', verify: async () => ({ status: 'confirmed', evidence: 'совпало' }) };
  const out = await checkEffect(tool, {}, { ...OK }, {});
  assert.equal(out.ok, true);
  assert.equal(out.summary, 'записал');
  assert.equal(out.verified, 'confirmed');
  assert.deepEqual(out.data, OK.data);
});

test('failed: ok становится false, данные сохраняются, причина в summary', async () => {
  const tool = { name: 't', verify: async () => ({ status: 'failed', evidence: 'файла нет' }) };
  const out = await checkEffect(tool, {}, { ...OK }, {});
  assert.equal(out.ok, false);
  assert.equal(out.verified, 'failed');
  assert.match(out.summary, /не подтверждено: файла нет/);
  assert.deepEqual(out.data, OK.data);
});

test('unknown: ok сохраняется, в summary пометка «не проверено»', async () => {
  const tool = { name: 't', verify: async () => ({ status: 'unknown', evidence: 'нет пути' }) };
  const out = await checkEffect(tool, {}, { ...OK }, {});
  assert.equal(out.ok, true);
  assert.equal(out.verified, 'unknown');
  assert.match(out.summary, /не проверено: нет пути/);
});

test('исключение в verify даёт unknown, а не failed и не подменяет результат', async () => {
  const tool = { name: 't', verify: async () => { throw new Error('упало'); } };
  const out = await checkEffect(tool, {}, { ...OK }, {});
  assert.equal(out.ok, true);
  assert.equal(out.verified, 'unknown');
  assert.match(out.summary, /проверка упала: упало/);
  assert.deepEqual(out.data, OK.data);
});

test('неизвестный статус из verify считается unknown', async () => {
  const tool = { name: 't', verify: async () => ({ status: 'maybe' }) };
  const out = await checkEffect(tool, {}, { ...OK }, {});
  assert.equal(out.verified, 'unknown');
});

test('если действие уже не удалось, verify не вызывается', async () => {
  let called = false;
  const tool = { name: 't', verify: async () => { called = true; return { status: 'confirmed' }; } };
  const fail = { ok: false, summary: 'нет', data: {} };
  const out = await checkEffect(tool, {}, fail, {});
  assert.equal(called, false);
  assert.deepEqual(out, fail);
});

test('workspace_write: записанный файл подтверждается, а после правки на диске — failed', async (t) => {
  const root = tmpDir(t);
  const index = new WorkspaceIndex(root);
  const write = workspaceTools(index).find((x) => x.name === 'workspace_write');
  const args = { path: 'notes/a.md', content: 'привет, мир' };
  const ctx = { workspace: root };

  const first = await checkEffect(write, args, await write.run(args, ctx), ctx);
  assert.equal(first.ok, true);
  assert.equal(first.verified, 'confirmed');

  fs.writeFileSync(path.join(root, 'notes', 'a.md'), 'другой текст', 'utf8');
  const verdict = await write.verify(args, { ok: true, data: { path: 'notes/a.md' } }, ctx);
  assert.equal(verdict.status, 'failed');
});

test('workspace_write: без пути в результате — unknown', async () => {
  const write = workspaceTools(new WorkspaceIndex(os.tmpdir())).find((x) => x.name === 'workspace_write');
  const verdict = await write.verify({ path: 'a.md', content: 'x' }, { ok: true, data: {} });
  assert.equal(verdict.status, 'unknown');
});

test('code_write и code_edit: совпадение подтверждается, подмена на диске — failed', async (t) => {
  const root = tmpDir(t);
  const [, write, edit] = codeTools({ roots: [root], base: root });
  const args = { path: 'a.js', content: 'const a = 1;\n' };
  const made = await checkEffect(write, args, await write.run(args, {}), {});
  assert.equal(made.verified, 'confirmed');

  const change = { path: 'a.js', old_string: 'a = 1', new_string: 'a = 2' };
  const changed = await checkEffect(edit, change, await edit.run(change, {}), {});
  assert.equal(changed.verified, 'confirmed');

  fs.writeFileSync(path.join(root, 'a.js'), 'другой текст');
  assert.equal((await write.verify(args, made, {})).status, 'failed');
  assert.equal((await edit.verify(change, changed, {})).status, 'failed');
});

test('проверка правки не принимает другой файл того же размера или случайный прежний фрагмент', async (t) => {
  const root = tmpDir(t);
  const [, , edit] = codeTools({ roots: [root], base: root });
  const file = path.join(root, 'a.js');
  fs.writeFileSync(file, 'AA old ZZ new');
  const args = { path: 'a.js', old_string: 'old', new_string: 'new' };
  const result = await edit.run(args, {});
  assert.equal((await edit.verify(args, result, {})).status, 'confirmed');
  fs.writeFileSync(file, 'BB old ZZ new');
  assert.equal((await edit.verify(args, result, {})).status, 'failed');
  assert.equal((await edit.verify(args, { ok: true, data: {} }, {})).status, 'unknown');

  fs.writeFileSync(file, 'keep remove');
  const deletion = { path: 'a.js', old_string: 'remove', new_string: '' };
  const removed = await edit.run(deletion, {});
  fs.writeFileSync(file, 'oops ');
  assert.equal((await edit.verify(deletion, removed, {})).status, 'failed');
});

test('Agent.run: ok только при ответе модели; ошибка модели — не успех', async (t) => {
  const dir = tmpDir(t);
  const make = (brain) => new Agent({
    brain,
    tools: new ToolRegistry(),
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: () => {},
    mode: 'auto',
    workspace: dir,
  });
  const good = await make({ chat: async () => ({ content: 'Готово', toolCalls: [] }) }).run('привет');
  assert.deepEqual(good, { ok: true, outcome: 'answer' });
  const bad = await make({ chat: async () => { throw new Error('сеть'); } }).run('привет');
  assert.deepEqual(bad, { ok: false, outcome: 'error' });
});

test('команда: провал проверки останавливает шаги и попадает в журнал', async () => {
  const entries = [];
  const tool = {
    name: 'x', risk: 'T0',
    run: async () => ({ ok: true, summary: 'сделано', data: {} }),
    verify: async () => ({ status: 'failed', evidence: 'эффекта нет' }),
  };
  const out = await runCommand({ id: 'c', name: 'c', steps: [{ tool: 'x' }, { tool: 'x' }] }, {
    tools: { get: () => tool },
    policy: { decide: () => 'allow' },
    journal: { append: (e) => entries.push(e) },
    workspace: os.tmpdir(),
    mode: 'full',
  });
  assert.equal(out.ok, false);
  assert.equal(out.results.length, 1);
  assert.equal(entries[0].verified, 'failed');
  assert.match(out.results[0].summary, /эффекта нет/);
});
