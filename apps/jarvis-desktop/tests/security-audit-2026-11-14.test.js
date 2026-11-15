'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const vm = require('vm');

const { decide, setSceneSource } = require('../src/policy/modes');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { ApprovalBroker, parseApprovalAnswer, voiceApprovalTarget } = require('../src/policy/approvals');
const { createPinnedLookup, webTools } = require('../src/tools/web');
const { McpClient, buildMcpEnv, MAX_STDIO_BUFFER, MAX_HTTP_BYTES } = require('../src/mcp/client');
const { createExecutor } = require('../src/tasks/executor');
const { TaskQueue } = require('../src/tasks/queue');
const { createMandate } = require('../src/tasks/mandate');
const taskModel = require('../src/tasks/model');
const { maskSecrets, maskEventForWindow } = require('../src/journal/journal');
const { MemoryStore, looksSecret } = require('../src/memory/store');
const { CommandStore } = require('../src/commands/store');
const { checkPlanSteps } = require('../src/tools/commands');
const { runCommand } = require('../src/commands/runner');
const { DesktopLock } = require('../src/control/desktop-lock');
const { createRouter } = require('../src/brain/tiers');
const { createGuard } = require('../src/cost/guard');
const { Meter, REASON_UNKNOWN_PRICE } = require('../src/cost/meter');
const { EscStop } = require('../src/control/esc-stop');
const { GmailAccount, mime } = require('../src/mail/gmail');
const { SNAPSHOT_SCRIPT, sanitizeSnapshotElements } = require('../src/tools/browser');

const WS = path.resolve('jarvis-workspace');

function makeRegistry(...tools) {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register(t);
  return reg;
}

function makeTool(name, risk = 'T1', run = async () => ({ ok: true, summary: 'ок', data: {} }), extra = {}) {
  return { name, description: name, risk, parameters: { type: 'object', properties: {} }, run, ...extra };
}

test('Матрица раздела 3 + SEC-01/02/03/11/14: регрессионный эталон решений политики', async (t) => {
  t.after(() => setSceneSource(null));
  setSceneSource(() => ({
    window: 'Банк — Браузер',
    elements: [
      { id: 'pay1', name: 'Оплатить заказ', type: 'Button', bounds: { x: 600, y: 380, w: 100, h: 40 } },
      { id: 'u12', name: 'Удалить', type: 'Button', rect: { left: 100, top: 100, width: 80, height: 30 } },
      { id: 'ok1', name: 'Открыть меню', type: 'Button', bounds: { x: 10, y: 10, w: 30, h: 30 } },
    ],
  }));

  const full = { mode: 'full', workspace: WS, ownerText: '' };

  // 1a, 1b, 1c (SEC-01)
  assert.equal(decide({ ...full, name: 'ui_click', risk: 'T1', args: { name: 'Оплатить', window: 'Банк' } }), 'deny');
  assert.equal(decide({ ...full, name: 'mouse_click', risk: 'T1', args: { x: 640, y: 400 } }), 'deny');
  assert.equal(decide({ ...full, name: 'mouse_click', risk: 'T1', args: { x: 20, y: 20 } }), 'allow');
  assert.equal(decide({ ...full, name: 'desktop_click', risk: 'T1', args: { id: 'u12' } }), 'ask');

  // 2a, 2b (SEC-02), 2c
  assert.equal(decide({ ...full, name: 'shell_run', risk: 'T2', args: { command: 'Get-ChildItem' }, tainted: true }), 'ask');
  assert.equal(decide({ ...full, name: 'shell_run', risk: 'T2', args: { command: 'Get-ChildItem' }, browserTainted: true }), 'ask');

  let shellRan = 0;
  let step = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sec02-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });
  const events = [];
  const brain = {
    async chat() {
      step += 1;
      if (step === 1) return { toolCalls: [{ id: 'w1', name: 'web_fetch', args: { url: 'https://example.com/' } }] };
      if (step === 2) return { content: 'готово', toolCalls: [] };
      if (step === 3) return { toolCalls: [{ id: 's1', name: 'shell_run', args: { command: 'Get-ChildItem' } }] };
      return { content: 'выполнено', toolCalls: [] };
    },
  };
  const agent = new Agent({
    brain,
    tools: makeRegistry(
      makeTool('web_fetch', 'T0', async () => ({ ok: true, summary: 'прочитано', data: {} })),
      makeTool('shell_run', 'T2', async () => { shellRan += 1; return { ok: true, summary: 'ok', data: {} }; }),
    ),
    approvals,
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_request') approvals.respond(e.id, 'reject');
    },
    mode: 'full',
    workspace: dir,
  });
  await agent.run('прочитай страницу');
  await agent.run('проверь файлы');
  assert.equal(events.filter((e) => e.type === 'approval_request').length, 1, '2b: на втором ходу заражение сохраняется');
  assert.equal(shellRan, 0);

  // 3a, 3b, 3c (SEC-03)
  assert.equal(decide({ ...full, name: 'send_email', risk: 'T2', args: { to: 'x@y.z', body: '1' }, source: 'mcp', ownerAllowed: true, tainted: true, handsTainted: true }), 'ask');
  assert.equal(decide({ ...full, name: 'mail_send', risk: 'T2', args: { to: 'x@y.z' }, source: 'mail', tainted: true }), 'ask');
  assert.equal(decide({ ...full, name: 'post_comment', risk: 'T1', args: { text: '1' }, source: 'mcp', ownerAllowed: true, tainted: true }), 'ask');

  // 4a, 4b (SEC-14)
  assert.equal(decide({ ...full, name: 'browser_open', risk: 'T1', args: { url: 'https://user:token@evil.example/' } }), 'ask');
  assert.equal(decide({ ...full, name: 'browser_open', risk: 'T1', args: { url: 'https://evil.example/?api_key=abcdef123456' } }), 'ask');
  assert.equal(decide({ ...full, name: 'browser_open', risk: 'T1', args: { url: 'https://example.com/news' } }), 'allow');
  assert.equal(decide({ ...full, name: 'ui_type', risk: 'T1', args: { text: 'password=hunter22', window: 'Сайт' } }), 'ask');
  assert.equal(decide({ ...full, name: 'desktop_type', risk: 'T1', args: { id: 'f1', text: 'token=my_secret_1234' } }), 'ask');

  // 5 (SEC-11)
  assert.equal(decide({ ...full, name: 'ui_keys', risk: 'T1', args: { keys: 'shift+delete', window: 'Проводник' }, ownerCommand: true }), 'allow');
  assert.equal(decide({ ...full, name: 'ui_keys', risk: 'T1', args: { keys: 'shift+delete', window: 'Проводник' }, ownerCommand: false }), 'ask');

  // 6a, 6b (не менять)
  assert.equal(decide({ ...full, name: 'workspace_delete', risk: 'T2', args: { path: 'отчёт.txt' }, ownerText: 'удали отчёт.txt' }), 'allow');
  assert.equal(decide({ ...full, name: 'workspace_delete', risk: 'T2', args: { path: 'отчёт.txt' }, ownerText: 'посмотри отчёт' }), 'ask');
});

test('SEC-04: createPinnedLookup фиксирует проверенный IP и web_fetch отклоняет DNS rebinding на 127.0.0.1', async () => {
  let dnsCalls = 0;
  const pinned = createPinnedLookup('example.com', [{ address: '93.184.216.34', family: 4 }]);
  await new Promise((resolve, reject) => {
    pinned('example.com', { all: true }, (err, addrs) => {
      if (err) return reject(err);
      dnsCalls += 1;
      assert.deepEqual(addrs, [{ address: '93.184.216.34', family: 4 }]);
      resolve();
    });
  });
  await new Promise((resolve, reject) => {
    pinned('example.com', {}, (err, addr, fam) => {
      if (err) return reject(err);
      assert.equal(addr, '93.184.216.34');
      assert.equal(fam, 4);
      resolve();
    });
  });
  assert.equal(dnsCalls, 1);

  let lookupSeq = 0;
  let fetchCalled = 0;
  const tools = webTools({
    lookup: async () => {
      lookupSeq += 1;
      return lookupSeq === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
    },
    fetchImpl: async (url, opts) => {
      fetchCalled += 1;
      const resolvedAddr = await new Promise((resolve, reject) => {
        opts.lookup('rebind.example', {}, (err, addr) => (err ? reject(err) : resolve(addr)));
      });
      assert.equal(resolvedAddr, '93.184.216.34');
      return new Response('', { status: 302, headers: { location: 'https://rebind.example/step2' } });
    },
  });
  const fetchTool = tools.find((t) => t.name === 'web_fetch');
  // Первый шаг резолвит внешний IP (mock fetchImpl проверяет закреплённый lookup и даёт редирект),
  // второй шаг (DNS rebinding -> 127.0.0.1) отклоняется до вызова fetchImpl:
  const blocked = await fetchTool.run({ url: 'https://rebind.example/secret' }, {});
  assert.equal(blocked.ok, false);
  assert.equal(fetchCalled, 1);

  const rebindTools = webTools({
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => { throw new Error('fetch не должен вызываться'); },
  });
  const blockedLocal = await rebindTools.find((t) => t.name === 'web_fetch').run({ url: 'https://rebind.example/' }, {});
  assert.equal(blockedLocal.ok, false);
  assert.match(blockedLocal.summary, /адрес не разрешён/i);
});

test('SEC-05 и SEC-06: buildMcpEnv очищает секреты процесса; переполнение stdio (>1MB) и http (>10MB) обрывается', async (t) => {
  const prevSecret = process.env.NOX_TEST_SECRET_KEY;
  const prevToken = process.env.MY_API_TOKEN;
  process.env.NOX_TEST_SECRET_KEY = 'top-secret-nox';
  process.env.MY_API_TOKEN = 'top-secret-token';
  t.after(() => {
    if (prevSecret === undefined) delete process.env.NOX_TEST_SECRET_KEY;
    else process.env.NOX_TEST_SECRET_KEY = prevSecret;
    if (prevToken === undefined) delete process.env.MY_API_TOKEN;
    else process.env.MY_API_TOKEN = prevToken;
  });

  const env = buildMcpEnv({ CUSTOM_FLAG: '1' });
  assert.equal(env.NOX_TEST_SECRET_KEY, undefined);
  assert.equal(env.MY_API_TOKEN, undefined);
  assert.equal(env.CUSTOM_FLAG, '1');

  // SEC-06 stdio overflow
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; };
  const stdioClient = new McpClient({
    name: 'big-stdio',
    command: 'node',
    spawnImpl: () => child,
  });
  const initPromise = stdioClient.connect();
  child.stdout.write('a'.repeat(MAX_STDIO_BUFFER + 16));
  await assert.rejects(initPromise, /превысил допустимый размер/i);
  assert.equal(killed, true);

  // SEC-06 HTTP overflow
  const httpClient = new McpClient({
    name: 'big-http',
    url: 'http://127.0.0.1:1/mcp',
    fetchImpl: async () => new Response('x'.repeat(1024), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_HTTP_BYTES + 1) },
    }),
  });
  await assert.rejects(httpClient.connect(), /превысил допустимый размер/i);
});

test('SEC-07: заражённая внешним источником задача спрашивает перед code_test и записью package.json, локальная — нет', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sec07-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'ws');
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes.txt'), 'локальный файл', 'utf8');

  const toolsAllow = ['web_fetch', 'workspace_read', 'code_test', 'code_write'];
  const specs = [
    { name: 'web_fetch', risk: 'T0', description: 'web', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
    { name: 'workspace_read', risk: 'T0', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'code_test', risk: 'T1', description: 'test', parameters: { type: 'object', properties: {} } },
    { name: 'code_write', risk: 'T1', description: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  ];

  // Сценарий 1: внешнее заражение через web_fetch -> code_test и package.json требуют подтверждения.
  const asked = [];
  let s1 = 0;
  const q1 = new TaskQueue({ now: () => 1000 });
  const m1 = createMandate({ goal: 'test', tools: toolsAllow, sandboxRoot: root, folders: [root], now: 1000 });
  m1.approvedBy = 'владелец';
  q1.add(taskModel.createTask({ id: 't-ext', title: 'ext', goal: 'ext', now: 1000, mandate: m1 }));
  const exec1 = createExecutor({
    queue: q1,
    saveTasks: () => {},
    brain: {
      async chat() {
        s1 += 1;
        if (s1 === 1) return { toolCalls: [{ id: 'p1', name: 'task_plan_submit', args: { steps: [{ title: 'шаг', kind: 'action' }], criteria: [{ requirement: 'ext', text: 'ок', manual: { kind: 'model_only', reason: 'test' } }] } }] };
        if (s1 === 2) return { toolCalls: [{ id: 'c1', name: 'web_fetch', args: { url: 'https://example.com' } }] };
        if (s1 === 3) return { toolCalls: [{ id: 'c2', name: 'code_write', args: { path: 'package.json', content: '{}' } }] };
        if (s1 === 4) return { toolCalls: [{ id: 'c3', name: 'code_test', args: {} }] };
        return { toolCalls: [{ id: 'd1', name: 'step_done', args: { summary: 'done' } }] };
      },
    },
    runTool: async () => ({ ok: true, summary: 'ok', data: {} }),
    toolSpecs: specs,
    stop: { isStopped: () => false },
    approvals: {
      request: async (p) => { asked.push(p.name); return 'once'; },
    },
    journal: { append() {} },
    resolve: (rel) => path.resolve(root, rel),
    emit: () => {},
    costOf: () => null,
    now: () => 1000,
    sandboxReportsDir: 'reports',
  });
  await exec1.submit('t-ext');
  assert.deepEqual(asked, ['code_write', 'code_test']);

  // Сценарий 2: только локальное чтение workspace_read -> code_test идёт без вопроса.
  const askedLocal = [];
  let s2 = 0;
  const q2 = new TaskQueue({ now: () => 1000 });
  const m2 = createMandate({ goal: 'local', tools: toolsAllow, sandboxRoot: root, folders: [root], now: 1000 });
  m2.approvedBy = 'владелец';
  q2.add(taskModel.createTask({ id: 't-loc', title: 'loc', goal: 'loc', now: 1000, mandate: m2 }));
  const exec2 = createExecutor({
    queue: q2,
    saveTasks: () => {},
    brain: {
      async chat() {
        s2 += 1;
        if (s2 === 1) return { toolCalls: [{ id: 'p1', name: 'task_plan_submit', args: { steps: [{ title: 'шаг', kind: 'action' }], criteria: [{ requirement: 'local', text: 'ок', manual: { kind: 'model_only', reason: 'test' } }] } }] };
        if (s2 === 2) return { toolCalls: [{ id: 'c1', name: 'workspace_read', args: { path: 'notes.txt' } }] };
        if (s2 === 3) return { toolCalls: [{ id: 'c2', name: 'code_test', args: {} }] };
        return { toolCalls: [{ id: 'd1', name: 'step_done', args: { summary: 'done' } }] };
      },
    },
    runTool: async () => ({ ok: true, summary: 'ok', data: {} }),
    toolSpecs: specs,
    stop: { isStopped: () => false },
    approvals: {
      request: async (p) => { askedLocal.push(p.name); return 'once'; },
    },
    journal: { append() {} },
    resolve: (rel) => path.resolve(root, rel),
    emit: () => {},
    costOf: () => null,
    now: () => 1000,
    sandboxReportsDir: 'reports',
  });
  await exec2.submit('t-loc');
  assert.deepEqual(askedLocal, []);
});

test('SEC-10 и SEC-19: маскировка 16-символьных токенов и camelCase полей, сохранение UUID и Win32_OperatingSystem', (t) => {
  const token16 = 'aB3k9Lm2Pq7Xr4Zw';
  const masked = maskSecrets(`токен ${token16}, apiKey=secretVal1234, Win32_OperatingSystem, 550e8400-e29b-41d4-a716-446655440000`);
  assert.ok(!masked.includes(token16), masked);
  assert.ok(!masked.includes('secretVal1234'), masked);
  assert.ok(masked.includes('Win32_OperatingSystem'), masked);
  assert.ok(masked.includes('550e8400-e29b-41d4-a716-446655440000'), masked);

  const ev = { type: 'tool_start', args: { accessToken: 'tok123456', key: 'ctrl+c' }, summary: `err ${token16}` };
  const evMasked = maskEventForWindow(ev);
  assert.equal(evMasked.args.key, 'ctrl+c');
  assert.ok(!JSON.stringify(evMasked).includes('tok123456'));
  assert.ok(!JSON.stringify(evMasked).includes(token16));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sec19-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mem = new MemoryStore(path.join(dir, 'mem.json'));
  assert.equal(looksSecret(token16), true);
  assert.equal(looksSecret('550e8400-e29b-41d4-a716-446655440000'), false);
  assert.equal(looksSecret('Win32_OperatingSystem'), false);
  assert.throws(() => mem.add({ text: `Мой код ${token16}` }), /пароль|секрет|токен|ключ/i);
  assert.ok(mem.add({ text: 'Win32_OperatingSystem работает стабильно' }).id);
});

test('SEC-11: CommandStore отклоняет shift+delete и модельные команды не получают ownerCommand=true', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sec11-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CommandStore(path.join(dir, 'commands.json'));

  assert.throws(() => store.save({
    name: 'Опасная клавиша',
    origin: 'model',
    steps: [{ tool: 'ui_keys', args: { keys: 'shift+delete', window: 'Проводник' } }],
  }), /shift\+delete/i);

  const savedModel = store.save({
    name: 'Команда модели',
    origin: 'model',
    steps: [{ tool: 'workspace_delete', args: { path: 'temp.txt' } }],
  });
  assert.equal(savedModel.origin, 'model');

  const planCheck = checkPlanSteps(
    [{ tool: 'ui_keys', args: { keys: 'Shift+Delete' } }],
    new Set(['ui_keys']),
    new Map(),
  );
  assert.ok(planCheck.errors.some((e) => /shift\+delete/i.test(e)));

  let gotOwnerCommand = null;
  const reg = makeRegistry(makeTool('workspace_delete', 'T2', async () => ({ ok: true, summary: 'ok', data: {} })));
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });
  const events = [];
  const res = await runCommand(savedModel, {
    tools: reg,
    policy: {
      decide(ctx) {
        gotOwnerCommand = ctx.ownerCommand;
        return decide(ctx);
      },
    },
    approvals,
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_request') approvals.respond(e.id, 'reject');
    },
    workspace: WS,
    mode: 'full',
    ownerCommand: true,
    ownerText: 'выполни команду',
  });
  assert.equal(gotOwnerCommand, false, 'runCommand с origin=model обязан сбрасывать ownerCommand в false');
  assert.equal(res.ok, false);
});

test('SEC-12: DesktopLock повторно проверяет блокировку экрана после ожидания очереди', async () => {
  const lock = new DesktopLock();
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = lock.run(() => gate);
  await new Promise((r) => setImmediate(r));
  let secondRan = false;
  const second = lock.run(async () => { secondRan = true; return { ok: true }; });
  lock.setLocked(true);
  release();
  await first;
  const out = await second;
  assert.equal(secondRan, false);
  assert.match(out.summary, /заблокирован/);
});

test('SEC-13: createRouter.modelFor и createGuard проверяют фактическую модель уровня smart и её цену', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sec13-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const router = createRouter({
    clients: {
      fast: { model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', async chat() { return { content: 'fast' }; } },
      smart: { model: 'vendor/unknown-smart-model', async chat() { return { content: 'smart' }; } },
    },
    getSettings: () => ({ modelTier: 'fast', thinking: 'medium' }),
  });
  assert.equal(router.modelFor({ tier: 'smart' }), 'vendor/unknown-smart-model');
  assert.equal(router.modelFor({ tier: 'fast' }), 'deepseek-ai/DeepSeek-V4.1-Flash-1017');

  const meter = new Meter({ file: path.join(dir, 'cost.json'), dailyLimitUsd: 5 });
  const guard = createGuard({ brain: router, meter, model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' });
  await assert.rejects(
    guard.chat({ messages: [{ role: 'user', content: 'hi' }], tier: 'smart' }),
    (err) => err && err.reason === REASON_UNKNOWN_PRICE,
  );
  const fastOut = await guard.chat({ messages: [{ role: 'user', content: 'hi' }], tier: 'fast' });
  assert.equal(fastOut.content, 'fast');
});

test('SEC-15 и SEC-18: EscStop держит Esc между параллельными держателями и не глушит реальный Esc владельца внутри ui_keys', () => {
  const keys = new Map();
  let stops = 0;
  const esc = new EscStop({
    register: (k, fn) => { keys.set(k, fn); return true; },
    unregister: (k) => keys.delete(k),
    onStop: () => { stops += 1; },
    setTimer: (fn) => fn(),
  });

  esc.action('ui_click', {}, { runId: 'run-1' });
  esc.action('ui_click', {}, { runId: 'run-2' });
  assert.equal(esc.armed, true);
  assert.equal(esc.disarm('run-1'), false, 'пока run-2 работает, Esc не снимается');
  assert.equal(esc.armed, true);
  assert.equal(esc.disarm('run-2'), true);
  assert.equal(esc.armed, false);

  const after = esc.action('ui_keys', { keys: 'escape' }, { runId: 'run-3' });
  assert.equal(esc.press(), false, 'один собственный Esc поглощается');
  assert.equal(esc.press(), true, 'последующее нажатие Esc владельца сразу останавливает ход');
  assert.equal(stops, 1);
  after();
});

test('SEC-16 и SEC-17: ApprovalBroker поддерживает два одновременных показа и голосовую цель при одном показе', () => {
  const broker = new ApprovalBroker({ timeoutMs: 1000 });
  const p1 = broker.request({ id: 'a', name: 't1' });
  const p2 = broker.request({ id: 'b', name: 't2' });
  const tok1 = broker.markShown('a');
  const tok2 = broker.markShown('b');
  assert.equal(broker.isShown('a', tok1), true);
  assert.equal(broker.isShown('b', tok2), true);
  assert.equal(broker.isShown('a', tok2), false);
  assert.equal(voiceApprovalTarget(broker.list(), broker), null, 'два активных запроса неоднозначны');

  broker.respond('b', 'reject');
  assert.equal(parseApprovalAnswer('да'), 'once');
  assert.equal(voiceApprovalTarget(broker.list(), broker), 'a');
  assert.equal(broker.isShown('a', tok1), true);
  broker.respond('a', 'once');
  assert.equal(broker.isShown('a', tok1), false);
  return Promise.all([p1, p2]);
});

test('SEC-20: mime и GmailAccount.send отвергают перенос строки и лишние заголовки в поле To', async () => {
  assert.throws(() => mime({ to: 'a@b.cc\r\nBcc: evil@y.z', subject: 's', text: 't' }), /Некорректный адрес/);
  let fetched = 0;
  const gmail = new GmailAccount({
    file: path.join(os.tmpdir(), 'unused-gmail.json'),
    clientId: 'id',
    fetchImpl: async () => { fetched += 1; return Response.json({}); },
  });
  const res = await gmail.send({ to: 'a@b.cc\nBcc: evil@y.z', subject: 's', text: 't' });
  assert.equal(res.ok, false);
  assert.equal(fetched, 0);
});

test('SEC-22: снимок браузера и sanitizeSnapshotElements скрывают карты и OTP, сохраняя обычный ввод', () => {
  // Проверка JS-синтаксиса SNAPSHOT_SCRIPT в vm (без реального Electron):
  new vm.Script(SNAPSHOT_SCRIPT);

  const sanitized = sanitizeSnapshotElements([
    { index: 1, kind: 'field', autocomplete: 'cc-number', value: '4111222233334444' },
    { index: 2, kind: 'field', autocomplete: 'one-time-code', value: '482910' },
    { index: 3, kind: 'field', name: 'search', value: 'погода в Алматы' },
    { index: 4, kind: 'field', name: 'note', value: '4111-2222-3333-4444' },
  ]);
  assert.equal(sanitized[0].value, undefined);
  assert.equal(sanitized[1].value, undefined);
  assert.equal(sanitized[2].value, 'погода в Алматы');
  assert.equal(sanitized[3].value, undefined);
});
