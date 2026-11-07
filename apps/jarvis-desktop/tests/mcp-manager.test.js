'use strict';

// Живые подключения MCP: добавление без перезапуска, возможности и состояние для экрана,
// изоляция сбоя, снятие инструментов при отключении, валидация настроек и маскировка секретов.
// Тестовый сервер — собственный stdio JSON-RPC сервер из tests/fixtures: пакеты не нужны.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { decide } = require('../src/policy/modes');
const { Agent } = require('../src/agent/loop');
const {
  McpClient,
  McpManager,
  connectMcpServers,
  mcpTools,
  maskSecrets,
  configSecrets,
  validateName,
  validateArgs,
  validateEnv,
  validateUrl,
  validateCommand,
  splitArgs,
  normalizeServerConfig,
  configFromForm,
  publicTarget,
  publicCapabilities,
} = require('../src/mcp/client');

const WS = path.resolve('jarvis-workspace');
const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
const node = process.execPath;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Вердикт так, как его считает цикл агента: подключение сервиса не расширяет разрешения.
const verdict = (tool, args, mode = 'full') => Agent.prototype._verdict.call({ decide, mode, workspace: WS, sessionAllow: null }, tool, args);

// Настройки в памяти: load отдаёт копию, save запоминает — как настоящий settings.json, но без диска.
function memoryStore(initial = {}) {
  let store = JSON.parse(JSON.stringify(initial));
  const saved = [];
  return {
    load: () => JSON.parse(JSON.stringify(store)),
    save: (conf) => { store = JSON.parse(JSON.stringify(conf)); saved.push(store); },
    get store() { return store; },
    saved,
  };
}

// Реестр-двойник вместо ToolRegistry: у настоящего пока нет unregister, контракт передан интегратору.
function memoryRegistry() {
  const tools = new Map();
  return {
    tools,
    register: (tool) => { if (tools.has(tool.name)) throw new Error(`инструмент уже зарегистрирован: ${tool.name}`); tools.set(tool.name, tool); },
    unregister: (name) => { tools.delete(name); },
    names: () => [...tools.keys()],
  };
}

function makeManager({ initial = {}, registry = memoryRegistry(), logs = [], allowed = () => [] } = {}) {
  const store = memoryStore(initial);
  const manager = new McpManager({
    load: store.load,
    save: store.save,
    register: registry.register,
    unregister: registry.unregister,
    allowed,
    log: (line) => logs.push(line),
  });
  return { manager, store, registry, logs };
}

// ── валидация настроек

test('название сервиса: латиница, цифры, дефис и подчёркивание до 40 знаков', () => {
  assert.equal(validateName('echo').ok, true);
  assert.equal(validateName(' my-server_2 ').value, 'my-server_2');
  assert.equal(validateName('').ok, false);
  assert.equal(validateName('почта').ok, false);
  assert.equal(validateName('a b').ok, false);
  assert.equal(validateName('x'.repeat(41)).ok, false);
  assert.equal(validateName('x'.repeat(40)).ok, true);
});

test('адрес: только http/https, без логина и пароля в адресе', () => {
  assert.equal(validateUrl('https://example.com/mcp').ok, true);
  assert.equal(validateUrl('http://127.0.0.1:8931/mcp').ok, true);
  for (const bad of ['file:///c:/secret', 'ftp://example.com', 'javascript:alert(1)', 'https://user:pass@example.com/mcp', 'не адрес', '']) {
    assert.equal(validateUrl(bad).ok, false, bad);
  }
});

test('команда и аргументы: без управляющих символов, кавычек и знаков оболочки', () => {
  assert.equal(validateCommand('npx.cmd').ok, true);
  assert.equal(validateCommand('C:\\Program Files\\nodejs\\node.exe').ok, true);
  for (const bad of ['node & calc', 'node | more', 'node > файл', 'node `code`', 'node "%TEMP%"', 'node\ncalc', '']) {
    assert.equal(validateCommand(bad).ok, false, bad);
  }
  assert.deepEqual(validateArgs('--port 8931 --name echo').args, ['--port', '8931', '--name', 'echo']);
  assert.deepEqual(validateArgs('"C:\\Program Files\\echo server.js" --port 1').args, ['C:\\Program Files\\echo server.js', '--port', '1']);
  assert.equal(validateArgs('"не закрыто').ok, false);
  assert.equal(validateArgs(['ok', 5]).ok, false);
  assert.equal(validateArgs(['a&b']).ok, false);
  assert.equal(validateArgs(Array.from({ length: 41 }, () => 'x')).ok, false);
  assert.equal(validateArgs(undefined).ok, true);
  assert.deepEqual(splitArgs('').args, []);
});

test('env: имена переменных безопасны, значения — строки без управляющих символов', () => {
  assert.deepEqual(validateEnv({ FISH_API_KEY: 'k' }).value, { FISH_API_KEY: 'k' });
  assert.deepEqual(validateEnv(undefined).value, {});
  assert.equal(validateEnv({ 'плохое имя': 'x' }).ok, false);
  assert.equal(validateEnv({ KEY: 5 }).ok, false);
  assert.equal(validateEnv({ KEY: 'a\nb' }).ok, false);
  assert.equal(validateEnv({ KEY: 'x'.repeat(2001) }).ok, false);
});

test('настройка сервера нормализуется: нельзя одновременно адрес и команду, timeout в разумных пределах', () => {
  const command = normalizeServerConfig({ command: node, args: ['-e', 'x'], env: { A: 'b' }, disabled: true });
  assert.equal(command.ok, true);
  assert.equal(command.config.disabled, true);
  assert.deepEqual(command.config.args, ['-e', 'x']);
  assert.deepEqual(command.config.env, { A: 'b' });
  const url = normalizeServerConfig({ url: 'http://127.0.0.1:8931/mcp', headers: { Authorization: 'Bearer token' } });
  assert.equal(url.ok, true);
  assert.equal(url.config.url, 'http://127.0.0.1:8931/mcp');
  assert.equal(normalizeServerConfig({}).ok, false);
  assert.equal(normalizeServerConfig({ command: node, url: 'https://example.com' }).ok, false);
  assert.equal(normalizeServerConfig({ command: node, timeoutMs: 10 }).ok, false);
  assert.equal(normalizeServerConfig(null).ok, false);
  assert.equal(configFromForm('https://example.com/mcp', '').config.url, 'https://example.com/mcp');
  assert.equal(configFromForm('https://example.com/mcp', '--flag').ok, false);
  assert.equal(configFromForm(node, `"${FIXTURE}"`).config.args[0], FIXTURE);
});

test('адрес без секретов: строка запроса и якорь в окне не показываются', () => {
  assert.equal(publicTarget({ url: 'https://example.com/mcp?token=super-secret#frag' }), 'https://example.com/mcp');
  assert.equal(publicTarget({ command: 'C:\\jx\\echo.cmd', args: ['--token', 'super-secret'] }), 'C:\\jx\\echo.cmd');
  assert.deepEqual(publicCapabilities({ tools: {}, resources: {}, prompts: {} }), { tools: true, resources: true, prompts: true });
  assert.equal(publicCapabilities(null), null);
});

test('секреты из env и заголовков вырезаются из текста, журнал их не показывает', () => {
  const conf = { env: { MCP_TEST_SECRET: 'super-secret-key-123' }, headers: { Authorization: 'Bearer header-token-abcd' } };
  const secrets = configSecrets(conf);
  assert.match(maskSecrets('ошибка: super-secret-key-123', secrets), /•••/);
  assert.doesNotMatch(maskSecrets('ошибка: super-secret-key-123', secrets), /super-secret-key-123/);
  assert.doesNotMatch(maskSecrets('запрос Bearer abcdefgh12345 отклонён'), /abcdefgh12345/);
  assert.doesNotMatch(maskSecrets('api_key=abcdef12345'), /abcdef12345/);
  assert.equal(maskSecrets('обычный текст', []), 'обычный текст');
});

// ── живая вертикаль

test('добавление сервера без перезапуска: имя, возможности, инструменты и состояние', async (t) => {
  const registry = memoryRegistry();
  const { manager, store } = makeManager({ registry });
  t.after(() => manager.close());

  const added = await manager.add('echo', node, `"${FIXTURE}"`);
  assert.equal(added.ok, true, added.error);
  assert.equal(added.error, undefined);
  const [server] = added.servers;
  assert.deepEqual(server, {
    name: 'echo',
    transport: 'stdio',
    target: node,
    disabled: false,
    status: 'connected',
    error: null,
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'echo-fixture', version: '1.0.0' },
    capabilities: { tools: true, resources: true, prompts: true },
    tools: server.tools,
    toolCount: 5,
  });
  assert.deepEqual(server.tools.map((tool) => tool.title), ['Повтор', 'Сложить', 'Медленный ответ', 'Сломать сервер', 'Секрет в ошибке']);
  assert.deepEqual(registry.names().sort(), ['echo_add', 'echo_crash', 'echo_echo', 'echo_secret', 'echo_slow']);
  // Настройка сохранена, как её увидит следующий запуск.
  assert.equal(store.store.echo.command, node);
  assert.deepEqual(store.store.echo.args, [FIXTURE]);

  // Вызов инструмента: результат приходит от сервера, политика всё равно спрашивает.
  const echoTool = registry.tools.get('echo_echo');
  assert.equal(echoTool.source, 'mcp');
  assert.equal(verdict(echoTool, { text: 'привет' }, 'full'), 'ask');
  const result = await echoTool.run({ text: 'привет' });
  assert.deepEqual(result, { ok: true, summary: 'эхо: привет' });
  const sum = await registry.tools.get('echo_add').run({ a: 2, b: 3 });
  assert.equal(sum.ok, true);
  assert.equal(sum.summary, '5');
});

test('вызов инструмента разрешён только по белому списку mcpAllow', async (t) => {
  const registry = memoryRegistry();
  const { manager } = makeManager({ registry, allowed: () => ['echo_echo'] });
  t.after(() => manager.close());
  await manager.add('echo', node, `"${FIXTURE}"`);
  assert.equal(verdict(registry.tools.get('echo_echo'), {}, 'full'), 'allow');
  assert.equal(verdict(registry.tools.get('echo_add'), {}, 'full'), 'ask');
});

test('отключение убирает инструменты, включение подключает заново', async (t) => {
  const registry = memoryRegistry();
  const { manager } = makeManager({ registry });
  t.after(() => manager.close());
  await manager.add('echo', node, `"${FIXTURE}"`);
  assert.equal(registry.names().length, 5);

  const off = await manager.toggle('echo', true);
  assert.equal(off.ok, true);
  assert.deepEqual(registry.names(), [], 'инструменты отключённого сервиса недоступны');
  assert.equal(off.servers[0].status, 'disabled');
  assert.equal(off.servers[0].disabled, true);

  const on = await manager.toggle('echo', false);
  assert.equal(on.ok, true);
  assert.equal(on.error, undefined);
  assert.equal(on.servers[0].status, 'connected');
  assert.equal(registry.names().length, 5, 'инструменты вернулись без перезапуска');
  assert.equal((await registry.tools.get('echo_echo').run({ text: 'снова' })).summary, 'эхо: снова');
});

test('сбой одного сервера изолирован: второй работает, окно не падает, секрет не утекает', async (t) => {
  const registry = memoryRegistry();
  const logs = [];
  const { manager } = makeManager({
    registry,
    logs,
    initial: {
      echo: { command: node, args: [FIXTURE] },
      echo2: { command: node, args: [FIXTURE] },
      broken: { command: node, args: [FIXTURE], env: { MCP_FIXTURE_FAIL: 'stderr-secret', MCP_TEST_SECRET: 'super-secret-key-123' } },
    },
  });
  t.after(() => manager.close());
  const state = await manager.startAll();
  const byName = Object.fromEntries(state.servers.map((server) => [server.name, server]));
  assert.equal(byName.echo.status, 'connected');
  assert.equal(byName.echo2.status, 'connected');
  assert.equal(byName.broken.status, 'error');
  assert.match(byName.broken.error, /тестовый сервер не поднялся/);
  assert.doesNotMatch(byName.broken.error, /super-secret-key-123/, 'секрет из env не попал в состояние');
  assert.ok(logs.every((line) => !line.includes('super-secret-key-123')), 'секрет не попал в журнал');

  // Нарочный сбой первого сервера: его инструменты снимаются, второй продолжает работать.
  const crashed = await registry.tools.get('echo_crash').run({});
  assert.equal(crashed.ok, false);
  await wait(150);
  const after = manager.state().servers;
  const echoState = after.find((server) => server.name === 'echo');
  const echo2State = after.find((server) => server.name === 'echo2');
  assert.equal(echoState.status, 'error');
  assert.match(echoState.error, /завершился/);
  assert.equal(echoState.toolCount, 0);
  assert.ok(registry.names().every((name) => !name.startsWith('echo_')), 'инструменты упавшего сервера сняты');
  assert.equal(echo2State.status, 'connected');
  assert.equal((await registry.tools.get('echo2_echo').run({ text: 'жив' })).summary, 'эхо: жив');
});

test('инструмент, который не отвечает, получает тайм-аут и не ломает сервер', async (t) => {
  const registry = memoryRegistry();
  const { manager } = makeManager({ registry, initial: { echo: { command: node, args: [FIXTURE], timeoutMs: 1200 } } });
  t.after(() => manager.close());
  await manager.startAll();
  const slow = registry.tools.get('echo_slow');
  const started = Date.now();
  const result = await slow.run({ ms: 3000 });
  assert.equal(result.ok, false);
  assert.match(result.summary, /не ответил за 1 с/);
  assert.ok(Date.now() - started < 2900, 'ждали тайм-аут, а не ответ');
  // Сервер не убит: обычный инструмент по-прежнему отвечает.
  assert.equal((await registry.tools.get('echo_echo').run({ text: 'после' })).summary, 'эхо: после');
});

test('удаление сервиса: настройки и инструменты убираются', async (t) => {
  const registry = memoryRegistry();
  const { manager, store } = makeManager({ registry });
  t.after(() => manager.close());
  await manager.add('echo', node, `"${FIXTURE}"`);
  const removed = manager.remove('echo');
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.servers, []);
  assert.deepEqual(registry.names(), []);
  assert.equal(store.store.echo, undefined);
});

test('ошибки добавления понятны: занятое имя, плохая команда, плохая настройка', async (t) => {
  const { manager } = makeManager();
  t.after(() => manager.close());
  await manager.add('echo', node, `"${FIXTURE}"`);
  assert.match((await manager.add('echo', node, `"${FIXTURE}"`)).error, /уже есть/);
  assert.match((await manager.add('другое', node, `"${FIXTURE}"`)).error, /Название/);
  assert.match((await manager.add('bad', 'node & calc', '')).error, /символ оболочки/);
  assert.match((await manager.add('bad2', '', '')).error, /Укажите адрес или команду/);
  assert.match((await manager.add('bad3', 'node', '"не закрыто')).error, /кавычка/);
});

test('ошибка подключения сохраняет сервис со статусом и причиной, а не роняет список', async (t) => {
  const registry = memoryRegistry();
  const { manager, store } = makeManager({ registry });
  t.after(() => manager.close());
  const added = await manager.add('missing', path.join(os.tmpdir(), 'нет-такой-программы-987.exe'), '');
  assert.equal(added.ok, true, 'настройка сохранена, чтобы владелец видел сервис и мог исправить');
  assert.match(added.error, /программа не найдена/);
  assert.equal(added.servers[0].status, 'error');
  assert.match(added.servers[0].error, /программа не найдена/);
  assert.equal(store.store.missing.command.includes('нет-такой-программы-987.exe'), true);
  assert.deepEqual(registry.names(), []);
});

test('испорченная настройка в settings.json показывается ошибкой, а не падением', async (t) => {
  const { manager } = makeManager({ initial: { bad: { command: '' }, good: { command: node, args: [FIXTURE] } } });
  t.after(() => manager.close());
  const state = await manager.startAll();
  const byName = Object.fromEntries(state.servers.map((server) => [server.name, server]));
  assert.equal(byName.bad.status, 'error');
  assert.match(byName.bad.error, /команд/i);
  assert.equal(byName.good.status, 'connected');
});

test('http-сервер: недоступность видна с понятной причиной', async (t) => {
  const { manager } = makeManager({ initial: { remote: { url: 'http://127.0.0.1:9/mcp' } } });
  t.after(() => manager.close());
  const state = await manager.startAll();
  assert.equal(state.servers[0].status, 'error');
  assert.match(state.servers[0].error, /нет связи с сервисом/);
  assert.equal(state.servers[0].target, 'http://127.0.0.1:9/mcp');
});

test('прежний connectMcpServers не сломан и функции модуля на месте', async (t) => {
  const registered = [];
  const clients = await connectMcpServers({ local: { command: node, args: [FIXTURE] } }, { register: (tool) => registered.push(tool), allowed: () => [] });
  t.after(() => clients.forEach((client) => client.close()));
  assert.equal(clients.length, 1);
  assert.equal(registered.length, 5);
  assert.ok(new McpClient({ command: node, args: [FIXTURE] }) instanceof McpClient);
  const [tool] = mcpTools({ callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }, 's', [{ name: 'ping' }]);
  assert.equal(tool.source, 'mcp');
});
