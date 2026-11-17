'use strict';

// Сквозная проверка stdio-клиента MCP на нашем собственном тестовом сервере (tests/fixtures):
// подключение, initialize, список инструментов, вызов, тайм-аут, посторонний вывод, закрытие процесса.
// Никаких пакетов и настоящих серверов: только node из стандартной библиотеки.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { McpClient, McpManager, mcpTools } = require('../src/mcp/client');
const { decide } = require('../src/policy/modes');

const NODE = process.execPath;
const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
const PROTOCOL = '2025-06-18';

function startClient({ args = [FIXTURE, '--minimal'], env = { MCP_FIXTURE_MINIMAL: '1' }, timeoutMs = 8000 } = {}) {
  const children = [];
  const spawnImpl = (command, argv, options) => {
    const child = spawn(command, argv, options);
    children.push(child);
    return child;
  };
  const client = new McpClient({ name: 'echo', command: NODE, args, env, timeoutMs, spawnImpl });
  return { client, children };
}

function killChildren(children) {
  for (const child of children || []) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { child.kill(); } catch { /* уже завершился */ }
  }
}

function waitExit(child, timeout = 6000) {
  return new Promise((resolve, reject) => {
    if (!child) return reject(new Error('дочернего процесса нет'));
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    const timer = setTimeout(() => reject(new Error('дочерний процесс не завершился за ' + timeout + ' мс')), timeout);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Запуск фикстуры напрямую: проверка её собственного контракта закрытия.
function spawnFixture() {
  return spawn(NODE, [FIXTURE, '--minimal'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function nextMessage(child, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error('ответ сервера не пришёл'));
    }, timeout);
    rl.on('line', (line) => {
      let message = null;
      try { message = JSON.parse(line); } catch { return; }
      clearTimeout(timer);
      rl.close();
      resolve(message);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      rl.close();
      reject(new Error('сервер завершился, не ответив'));
    });
  });
}

function send(child, message) {
  child.stdin.write(JSON.stringify(message) + '\n');
}

test('stdio: initialize, ровно два инструмента, вызов и штатное закрытие без утечки процесса', async (t) => {
  const { client, children } = startClient();
  t.after(() => { try { client.close(); } catch { /* уже */ } killChildren(children); });

  const init = await client.connect();
  assert.equal(init.protocolVersion, PROTOCOL);
  assert.equal(init.serverInfo.name, 'echo-fixture');
  assert.equal(init.capabilities.tools !== undefined, true);
  assert.equal(client.protocol, PROTOCOL);

  const tools = await client.listTools();
  assert.equal(tools.length, 2, 'в минимальном режиме ровно два инструмента');
  assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'add']);
  assert.ok(tools.every((tool) => typeof tool.description === 'string' && tool.inputSchema));

  const echo = await client.callTool('echo', { text: 'привет' });
  assert.equal(echo.content[0].text, 'эхо: привет');
  const add = await client.callTool('add', { a: 2, b: 3 });
  assert.equal(add.content[0].text, '5');
  assert.equal(add.structuredContent.sum, 5);

  const child = children[0];
  assert.ok(child && child.pid > 0, 'сервер запущен дочерним процессом');
  client.close();
  await waitExit(child);
  assert.equal(alive(child.pid), false, 'после close() дочерний процесс не остаётся');
  assert.equal(client.child, null);
  await assert.rejects(client.request('tools/list', {}), /отключён/);
});

test('инструмент вне mcpAllow спрашивает разрешение и не исполняется молча', async (t) => {
  const { client, children } = startClient();
  t.after(() => { try { client.close(); } catch { /* уже */ } killChildren(children); });
  await client.connect();
  const list = await client.listTools();

  const tools = mcpTools(client, 'echo', list, { allowed: () => [] });
  assert.deepEqual(tools.map((tool) => tool.name), ['echo_echo', 'echo_add']);
  const echo = tools.find((tool) => tool.name === 'echo_echo');
  assert.equal(echo.source, 'mcp');
  assert.equal(echo.risk, 'T2');
  assert.equal(echo.ownerAllowed(), false, 'без mcpAllow внешний инструмент не разрешён');

  // Так же, как в цикле агента: решение политики до вызова инструмента.
  const verdictAsk = decide({ mode: 'full', name: echo.name, risk: echo.risk, args: {}, source: 'mcp', ownerAllowed: echo.ownerAllowed() });
  assert.equal(verdictAsk, 'ask', 'вне mcpAllow даже полный доступ спрашивает');

  // Пока вердикт — вопрос, инструмент не вызывается (никакого тихого исполнения).
  let calls = 0;
  const originalCall = client.callTool.bind(client);
  client.callTool = (...args) => { calls += 1; return originalCall(...args); };
  if (verdictAsk === 'allow') await echo.run({ text: 'не должно случиться' });
  assert.equal(calls, 0, 'при ask внешний инструмент не исполнился молча');

  // Полное имя в mcpAllow: полный доступ выполняет без вопроса.
  const allowedTools = mcpTools(client, 'echo', list, { allowed: () => ['echo_echo'] });
  const allowedEcho = allowedTools.find((tool) => tool.name === 'echo_echo');
  assert.equal(allowedEcho.ownerAllowed(), true);
  assert.equal(decide({ mode: 'full', name: allowedEcho.name, risk: allowedEcho.risk, args: {}, source: 'mcp', ownerAllowed: allowedEcho.ownerAllowed() }), 'allow');
  const result = await allowedEcho.run({ text: 'можно' });
  assert.equal(calls, 1);
  assert.equal(result.summary, 'эхо: можно');

  client.close();
  await waitExit(children[0]);
});

test('зависший сервер: честный тайм-аут, процесс не остаётся без ручного close()', async (t) => {
  const { client, children } = startClient({ env: { MCP_FIXTURE_HANG_INIT: '1' }, timeoutMs: 600 });
  t.after(() => { try { client.close(); } catch { /* уже */ } killChildren(children); });

  const started = Date.now();
  await assert.rejects(client.connect(), /сервис не ответил за \d+ с/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 500, 'ждали тайм-аут, а не мгновенную ошибку: ' + elapsed + ' мс');
  assert.ok(elapsed < 5000, 'тайм-аут не должен растягиваться: ' + elapsed + ' мс');

  const child = children[0];
  await waitExit(child, 5000);
  assert.equal(alive(child.pid), false, 'после ошибки подключения дочерний процесс не остаётся');
  assert.equal(client.child, null);
});

test('посторонний вывод сервера не попадает в инструменты и состояние окна', async (t) => {
  const noiseEnv = { MCP_FIXTURE_MINIMAL: '1', MCP_FIXTURE_NOISE: '1' };
  const { client, children } = startClient({ env: noiseEnv });
  t.after(() => { try { client.close(); } catch { /* уже */ } killChildren(children); });

  const init = await client.connect();
  assert.doesNotMatch(JSON.stringify(init), /MCP_FIXTURE_NOISE/, 'шум stdout не попал в initialize');
  const tools = await client.listTools();
  assert.equal(tools.length, 2, 'шум не сломал список инструментов');
  assert.doesNotMatch(JSON.stringify(tools), /MCP_FIXTURE_NOISE/);
  const raw = await client.callTool('echo', { text: 'тишина' });
  assert.doesNotMatch(JSON.stringify(raw), /MCP_FIXTURE_NOISE/, 'шум не попал в ответ инструмента');
  const tool = mcpTools(client, 'echo', tools, { allowed: () => ['echo_echo'] }).find((item) => item.name === 'echo_echo');
  const result = await tool.run({ text: 'тишина' });
  assert.equal(result.summary, 'эхо: тишина');
  assert.doesNotMatch(JSON.stringify(result), /MCP_FIXTURE_NOISE/, 'шум не попал в результат для окна');
  client.close();
  await waitExit(children[0]);

  // Состояние, которое получает окно от менеджера, тоже без вывода сервера.
  const manager = new McpManager({
    load: () => ({ echo: { command: NODE, args: [FIXTURE, '--minimal'], env: noiseEnv } }),
    save: () => {},
    register: () => {},
    unregister: () => {},
    log: () => {},
    snapshotLoad: () => ({}),
    snapshotSave: () => {},
  });
  t.after(() => manager.close());
  await manager.startAll();
  const state = JSON.stringify(manager.state());
  assert.equal(state.includes('echo'), true);
  assert.doesNotMatch(state, /MCP_FIXTURE_NOISE/, 'вывод сервера не попал в состояние окна');
});

test('тестовый сервер корректно закрывается по stdin и по запросу shutdown', async (t) => {
  const first = spawnFixture();
  t.after(() => { try { first.kill(); } catch { /* уже */ } });
  send(first, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const init = await nextMessage(first);
  assert.equal(init.id, 1);
  first.stdin.end();
  const closedByStdin = await waitExit(first);
  assert.equal(closedByStdin.code, 0, 'по закрытию stdin сервер выходит с кодом 0');

  const second = spawnFixture();
  t.after(() => { try { second.kill(); } catch { /* уже */ } });
  send(second, { jsonrpc: '2.0', id: 2, method: 'shutdown' });
  const shutdown = await nextMessage(second);
  assert.equal(shutdown.id, 2);
  const closedByShutdown = await waitExit(second);
  assert.equal(closedByShutdown.code, 0, 'по shutdown сервер отвечает и выходит с кодом 0');
});
