'use strict';

// code_test запускает настоящие процессы на временных папках: падающий и проходящий тест.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { codeTools } = require('../src/tools/code');
const { checkEffect } = require('../src/agent/effects');
const { createMandate, checkTool, summarize, ALLOWED_TOOLS } = require('../src/tasks/mandate');
const { createRuntime } = require('../src/tasks/runtime');
const { ApprovalBroker } = require('../src/policy/approvals');
const { StopSwitch } = require('../src/control/stop');

const PASS = "require('node:test').test('да', () => {});\n";
const FAIL = "require('node:test').test('нет', () => { throw new Error('упал как надо'); });\n";

function setup(t, over = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-code-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const folder = path.join(base, 'proj');
  fs.mkdirSync(folder);
  const tool = codeTools({ roots: [folder], base, ...over }).find((x) => x.name === 'code_test');
  const write = (name, text) => fs.writeFileSync(path.join(folder, name), text);
  const run = async (args, ctx = {}) => checkEffect(tool, args, await tool.run(args, ctx), ctx);
  return { base, folder, tool, write, run };
}

test('проходящий тест — confirmed, падающий — failed с концом вывода', async (t) => {
  const h = setup(t);
  h.write('ok.test.js', PASS);
  h.write('bad.test.js', FAIL);
  const good = await h.run({ runner: 'node', path: 'proj/ok.test.js' });
  assert.equal(good.ok, true);
  assert.equal(good.verified, 'confirmed');
  assert.equal(good.data.exitCode, 0);
  assert.equal(good.data.cwd, h.folder);
  const bad = await h.run({ runner: 'node', path: 'proj/bad.test.js' });
  assert.equal(bad.ok, false);
  assert.equal(bad.verified, 'failed');
  assert.notEqual(bad.data.exitCode, 0);
  assert.match(bad.summary, /код выхода/);
  assert.ok(bad.data.output.length <= 1200);
  assert.match(bad.data.output, /fail 1/);
});

test('без path работает в папке мандата', async (t) => {
  const h = setup(t);
  h.write('ok.test.js', PASS);
  assert.equal((await h.run({ runner: 'node' })).verified, 'confirmed');
  h.write('bad.test.js', FAIL);
  assert.equal((await h.run({ runner: 'node' })).verified, 'failed');
});

test('npm test: идёт без shell, path не принимает', async (t) => {
  const h = setup(t);
  h.write('package.json', JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test' } }));
  h.write('ok.test.js', PASS);
  const res = await h.run({ runner: 'npm' });
  assert.equal(res.verified, 'confirmed', JSON.stringify(res));
  assert.match((await h.tool.run({ runner: 'npm', path: 'proj/ok.test.js' })).summary, /без файла/);
});

test('окружение без секретов: ключи и NOX_* ребёнок не видит', async (t) => {
  const h = setup(t);
  process.env.NOX_SECRET_FOR_TEST = 'секрет';
  process.env.DEEPSEEK_API_KEY_FOR_TEST = 'секрет';
  t.after(() => { delete process.env.NOX_SECRET_FOR_TEST; delete process.env.DEEPSEEK_API_KEY_FOR_TEST; });
  h.write('env.test.js', "const a = require('node:assert'); require('node:test').test('env', () => { a.equal(process.env.NOX_SECRET_FOR_TEST, undefined); a.equal(process.env.DEEPSEEK_API_KEY_FOR_TEST, undefined); a.ok(process.env.PATH); });\n");
  assert.equal((await h.run({ runner: 'node', path: 'proj/env.test.js' })).verified, 'confirmed');
});

test('белый список и границы: другой запуск, путь наружу, ключ вместо файла, нет папок — отказ', async (t) => {
  const h = setup(t);
  assert.match((await h.tool.run({ runner: 'powershell' })).summary, /неизвестный запуск/);
  assert.match((await h.tool.run({ runner: 'constructor' })).summary, /неизвестный запуск/);
  assert.match((await h.tool.run({ runner: 'node', path: '../../evil.js' })).summary, /отказ/);
  assert.match((await h.tool.run({ runner: 'node', path: 'proj/нет.test.js' })).summary, /не найден/);
  assert.match((await h.tool.run({ runner: 'node', path: 'proj/x.exe' })).summary, /расширение/);
  h.write('--import=x.js', PASS);
  assert.match((await h.tool.run({ runner: 'node', path: 'proj/--import=x.js' })).summary, /такое имя/);
  const none = codeTools({ roots: [], base: h.base }).find((x) => x.name === 'code_test');
  assert.match((await none.run({ runner: 'node' })).summary, /нет разрешённых папок/);
  const closed = setup(t);
  const denied = codeTools({ roots: [closed.folder], base: closed.base, denyDirs: [closed.folder] }).find((x) => x.name === 'code_test');
  assert.match((await denied.run({ runner: 'node' })).summary, /служебной папке/);
});

test('таймаут и стоп снимают процесс вместе с потомками', async (t) => {
  const h = setup(t, { testTimeoutMs: 1500 });
  h.write('hang.test.js', "require('node:test').test('виснет', () => new Promise(() => { setInterval(() => {}, 1000); }));\n");
  const slow = await h.tool.run({ runner: 'node', path: 'proj/hang.test.js' });
  assert.equal(slow.ok, false);
  assert.match(slow.summary, /время вышло/);
  const controller = new AbortController();
  const h2 = setup(t);
  h2.write('hang.test.js', "require('node:test').test('виснет', () => new Promise(() => { setInterval(() => {}, 1000); }));\n");
  const running = h2.tool.run({ runner: 'node', path: 'proj/hang.test.js' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 500);
  const stopped = await running;
  assert.equal(stopped.ok, false);
  assert.match(stopped.summary, /остановлено/);
});

test('исполнитель: модель видит падение, правит код и запускает тест снова; шаг подтверждён', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-code-test-x-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const folder = path.join(root, 'proj');
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'sum.test.js'), "const a = require('node:assert'); require('node:test').test('сумма', () => a.equal(1 + 1, 3));\n");
  const reply = (name, args) => ({ toolCalls: [{ name, args }] });
  const script = [
    reply('task_plan_submit', {
      steps: [{ title: 'Починить тест', check: { kind: 'file_contains', path: 'proj/sum.test.js', text: 'a.equal(1 + 1, 2)' } }],
      criteria: [{ requirement: 'тест проходит', text: 'в тесте верная сумма', check: { kind: 'file_contains', path: 'proj/sum.test.js', text: 'a.equal(1 + 1, 2)' } }],
    }),
    reply('code_test', { runner: 'node', path: 'proj/sum.test.js' }),
    reply('code_edit', { path: 'proj/sum.test.js', old_string: 'a.equal(1 + 1, 3)', new_string: 'a.equal(1 + 1, 2)' }),
    reply('code_test', { runner: 'node', path: 'proj/sum.test.js' }),
    reply('step_done', { summary: 'тест проходит' }),
  ];
  const requests = [];
  const usage = { promptTokens: 800, cachedTokens: 200, completionTokens: 100, reasoningTokens: 0 };
  const brain = {
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    async chat(args) {
      const step = script[requests.length];
      requests.push({ tools: (args.tools || []).map((x) => x.function.name), messages: (args.messages || []).slice() });
      args.onUsage({ model: brain.model, purpose: args.purpose, ok: true, usage, requestChars: 1, attempts: 1 });
      return { content: '', reasoningContent: null, toolCalls: step.toolCalls.map((c, k) => ({ id: `c${requests.length}_${k}`, name: c.name, args: c.args, argsError: null })), stats: usage };
    },
  };
  let runtime;
  const code = codeTools({ base: root, roots: (ctx) => { const task = ctx && ctx.taskId ? runtime.queue.get(ctx.taskId) : null; return task && task.mandate ? task.mandate.folders : []; } });
  const broker = new ApprovalBroker();
  const asks = [];
  const journal = [];
  runtime = createRuntime({
    brain,
    model: brain.model,
    tasksFile: path.join(base, 'data', 'tasks.json'),
    budgetFile: path.join(base, 'data', 'budget.json'),
    sandboxRoot: root,
    reportsDir: 'reports',
    dailyLimitUsd: 1,
    toolRegistry: { get: (name) => code.find((x) => x.name === name) || null, list: () => code.slice() },
    approvals: broker,
    stop: new StopSwitch(),
    journal: { append: (e) => journal.push(e) },
    emit: (ev) => { if (ev.type === 'approval_request') { asks.push(ev); broker.respond(ev.id, 'once'); } },
    resolve: (rel) => path.resolve(root, rel),
    now: () => Date.UTC(2026, 9, 31, 9, 0),
  });
  t.after(() => runtime.close());
  const res = await runtime.chatTools.find((x) => x.name === 'task_submit').run({ goal: 'Почини тест proj/sum.test.js', tools: ['code_read', 'code_edit', 'code_test'], folders: ['proj'], expiresInHours: 2, budgetUsd: 0.05 }, {});
  assert.equal(res.ok, true, res.summary);
  await runtime.whenIdle();
  assert.match(asks[0].args.мандат, /это не песочница/);
  assert.equal(asks.length, 1, 'вопрос только о мандате');
  assert.ok(requests[1].tools.includes('code_test'), 'модели предложен запуск тестов');
  const seen = JSON.stringify(requests[2].messages.at(-1));
  assert.match(seen, /тесты не прошли/);
  assert.match(seen, /fail 1/, 'модель видит итог упавшего теста');
  assert.deepEqual(journal.filter((e) => e.tool === 'code_test').map((e) => e.ok), [false, true]);
  assert.equal(runtime.queue.get(res.data.id).status, 'done');
});

test('мандат: только если указан явно и с папками; строка владельцу честная; папка проверяется', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-code-test-m-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'proj'));
  assert.ok(ALLOWED_TOOLS.includes('code_test'));
  const params = { goal: 'почини', sandboxRoot: base };
  assert.throws(() => createMandate({ ...params, tools: ['code_test'] }), /нужен явный непустой список папок/);
  const m = createMandate({ ...params, tools: ['code_edit', 'code_test'], folders: ['proj'] });
  const text = summarize(m);
  assert.match(text, /запускает тесты из папки с вашими правами на компьютере, это не песочница/);
  assert.doesNotMatch(text, /без запуска/);
  assert.match(text, /запуск тестов \(code_test\)/);
  assert.doesNotMatch(summarize(createMandate({ ...params, tools: ['code_edit'], folders: ['proj'] })), /code_test|не песочница/);
  assert.equal(checkTool(m, { name: 'code_test', args: { runner: 'node' } }).ok, true);
  assert.equal(checkTool(m, { name: 'code_test', args: { runner: 'node', path: 'proj/a.test.js' } }).ok, true);
  assert.equal(checkTool(m, { name: 'code_test', args: { runner: 'node', path: '../a.test.js' } }).ok, false);
  const plain = createMandate({ ...params, tools: ['code_edit'], folders: ['proj'] });
  assert.equal(checkTool(plain, { name: 'code_test', args: { runner: 'node' } }).ok, false, 'не указан — не запускается');
});
