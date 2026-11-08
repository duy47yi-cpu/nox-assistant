'use strict';

// Предпросмотр изменений перед подтверждением записи: владелец видит, что именно изменится,
// а отказ не трогает ни файл, ни резервные копии.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function toolsFor(root) {
  const index = new WorkspaceIndex(root);
  const tools = workspaceTools(index);
  const write = tools.find((tool) => tool.name === 'workspace_write');
  assert.ok(write, 'инструмент workspace_write найден');
  return { index, tools, write };
}

// Модель, которая делает ровно то, что записано в сценарии.
function scripted(steps) {
  let i = 0;
  return {
    async chat() {
      const step = steps[i++];
      if (!step) throw new Error('сценарий закончился');
      return { content: step.content || '', reasoningContent: null, toolCalls: step.toolCalls || [] };
    },
  };
}

test('workspace_write.preview показывает diff и ничего не записывает', (t) => {
  const root = tempDir(t);
  const file = writeFile(root, 'reports/a.md', 'один\nдва\n');
  const { write } = toolsFor(root);

  const preview = write.preview({ path: 'reports/a.md', content: 'один\nдва\nтри\n' });
  assert.ok(preview, 'предпросмотр построен');
  assert.equal(preview.created, false);
  assert.equal(preview.additions, 1);
  assert.equal(preview.deletions, 0);
  assert.match(preview.diff, /^--- a\/reports\/a\.md$/m);
  assert.match(preview.diff, /^\+\+\+ b\/reports\/a\.md$/m);
  assert.match(preview.diff, /^\+три$/m);
  assert.equal(fs.readFileSync(file, 'utf8'), 'один\nдва\n', 'файл не изменён предпросмотром');
  assert.equal(fs.existsSync(path.join(root, 'backups')), false, 'резервная копия не создана');

  const created = write.preview({ path: 'reports/b.md', content: 'новый файл\n' });
  assert.ok(created);
  assert.equal(created.created, true);
  assert.match(created.diff, /^\+новый файл$/m);
  assert.equal(fs.existsSync(path.join(root, 'reports', 'b.md')), false, 'новый файл не создан предпросмотром');
});

test('workspace_write.preview сжимает большой diff и помечает обрезку', (t) => {
  const root = tempDir(t);
  const before = Array.from({ length: 100 }, (_, i) => `строка ${i}`).join('\n') + '\n';
  writeFile(root, 'reports/big.md', before);
  const after = Array.from({ length: 100 }, (_, i) => (i >= 25 && i < 75 ? `строка ${i} изменена` : `строка ${i}`)).join('\n') + '\n';
  const { write } = toolsFor(root);

  const preview = write.preview({ path: 'reports/big.md', content: after });
  assert.ok(preview);
  assert.equal(preview.truncated, true, 'обрезка отмечена');
  assert.equal(preview.additions, 50);
  assert.equal(preview.deletions, 50);
  const changed = preview.diff.split('\n').filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line));
  assert.ok(changed.length <= 20, `в патче не больше 20 изменённых строк, а было ${changed.length}`);
  assert.ok(preview.diff.includes('…'), 'есть пометка, что показано не всё');
});

test('отказ владельца: в запросе есть предпросмотр, инструмент не запускается', async (t) => {
  const root = tempDir(t);
  const file = writeFile(root, 'reports/a.md', 'старое\n');
  const { write } = toolsFor(root);
  const registry = new ToolRegistry();
  registry.register(write);
  const approvals = new ApprovalBroker({ timeoutMs: null });
  const requests = [];
  const events = [];
  const agent = new Agent({
    brain: scripted([
      { toolCalls: [{ id: 'w1', name: 'workspace_write', args: { path: 'reports/a.md', content: 'новое\n' } }] },
      { content: 'готово' },
    ]),
    tools: registry,
    policy: () => 'ask',
    approvals,
    journal: new Journal(path.join(root, 'journal.jsonl')),
    emit: (event) => {
      events.push(event);
      if (event.type === 'approval_request') {
        requests.push(event);
        approvals.respond(event.id, 'reject');
      }
    },
    mode: 'ask',
    workspace: root,
  });

  await agent.run('перепиши файл');

  assert.equal(requests.length, 1);
  assert.ok(requests[0].preview, 'в запросе подтверждения есть предпросмотр');
  assert.match(requests[0].preview.diff, /^-старое$/m);
  assert.match(requests[0].preview.diff, /^\+новое$/m);
  assert.equal(fs.readFileSync(file, 'utf8'), 'старое\n', 'после отказа файл не изменён');
  assert.equal(fs.existsSync(path.join(root, 'backups')), false, 'после отказа копия не создана');
  assert.equal(events.some((e) => e.type === 'tool_result' && e.ok === false && e.summary === 'отклонено'), true);
});

test('предпросмотр переноса: видно, что изменится в файле назначения', (t) => {
  const root = tempDir(t);
  writeFile(root, 'reports/a.md', 'источник\n');
  writeFile(root, 'reports/b.md', 'старое\n');
  const { tools } = toolsFor(root);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  const preview = byName.workspace_move.preview({ from: 'reports/a.md', to: 'reports/b.md', overwrite: true });
  assert.ok(preview, 'предпросмотр переноса построен');
  assert.equal(preview.path, 'reports/b.md');
  assert.equal(preview.created, false);
  assert.match(preview.diff, /^-старое$/m);
  assert.match(preview.diff, /^\+источник$/m);
  assert.equal(fs.readFileSync(path.join(root, 'reports', 'b.md'), 'utf8'), 'старое\n', 'файл не тронут предпросмотром');

  const created = byName.workspace_copy.preview({ from: 'reports/a.md', to: 'reports/c.md' });
  assert.ok(created);
  assert.equal(created.created, true);
  assert.match(created.diff, /^\+источник$/m);
});

test('предпросмотр восстановления: видно возвращение к копии', async (t) => {
  const root = tempDir(t);
  writeFile(root, 'reports/c.md', 'версия 1\n');
  const { tools } = toolsFor(root);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  const written = await byName.workspace_write.run({ path: 'reports/c.md', content: 'версия 2\n' }, {});
  assert.equal(written.ok, true);
  assert.ok(written.data.backup, 'перед перезаписью сохранена копия');

  const preview = byName.workspace_restore.preview({ path: 'reports/c.md', backup: written.data.backup });
  assert.ok(preview, 'предпросмотр восстановления построен');
  assert.match(preview.diff, /^-версия 2$/m);
  assert.match(preview.diff, /^\+версия 1$/m);
  assert.equal(fs.readFileSync(path.join(root, 'reports', 'c.md'), 'utf8'), 'версия 2\n', 'файл не тронут предпросмотром');
});

test('разрешение владельца: предпросмотр не мешает записи', async (t) => {
  const root = tempDir(t);
  const file = writeFile(root, 'reports/a.md', 'старое\n');
  const { write } = toolsFor(root);
  const registry = new ToolRegistry();
  registry.register(write);
  const approvals = new ApprovalBroker({ timeoutMs: null });
  const agent = new Agent({
    brain: scripted([
      { toolCalls: [{ id: 'w2', name: 'workspace_write', args: { path: 'reports/a.md', content: 'новое\n' } }] },
      { content: 'готово' },
    ]),
    tools: registry,
    policy: () => 'ask',
    approvals,
    journal: new Journal(path.join(root, 'journal.jsonl')),
    emit: (event) => {
      if (event.type === 'approval_request') approvals.respond(event.id, 'once');
    },
    mode: 'ask',
    workspace: root,
  });

  await agent.run('перепиши файл');

  assert.equal(fs.readFileSync(file, 'utf8'), 'новое\n', 'после разрешения файл записан');
  const backups = fs.existsSync(path.join(root, 'backups'))
    ? fs.readdirSync(path.join(root, 'backups')).filter((name) => name.endsWith('.bak'))
    : [];
  assert.equal(backups.length, 1, 'прежняя версия сохранена в backups');
});
