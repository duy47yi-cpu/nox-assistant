'use strict';

// Этап 7: MCP и почта. Сеть подменена: локальный процесс node для stdio, локальный http-сервер, подменённый fetch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide } = require('../src/policy/modes');
const { Agent } = require('../src/agent/loop');
const { checkEffect } = require('../src/agent/effects');
const { McpClient, mcpTools, connectMcpServers } = require('../src/mcp/client');
const { GmailAccount, mime, READ_SCOPE } = require('../src/mail/gmail');
const { connectGmail } = require('../src/mail/oauth-loopback');
const { isForeignTextSource } = require('../src/policy/taint');
const { mailTools } = require('../src/tools/mail');

const WS = path.resolve('jarvis-workspace');

// Вердикт так, как его считает цикл агента: с источником и белым списком инструмента.
const verdict = (tool, args, mode = 'full') => Agent.prototype._verdict.call({ decide, mode, workspace: WS, sessionAllow: null }, tool, args);

const fakeTool = (name, allowed = []) => mcpTools({ callTool: async () => ({}) }, 'shop', [{ name }], { allowed: () => allowed })[0];

test('MCP вне белого списка спрашивает даже в «Полном доступе»', () => {
  const tool = fakeTool('list_items');
  assert.equal(tool.name, 'shop_list_items');
  assert.equal(verdict(tool, {}, 'full'), 'ask');
  assert.equal(verdict(tool, {}, 'auto'), 'ask');
  assert.equal(verdict(fakeTool('list_items', ['shop_list_items']), {}, 'full'), 'allow');
  // Без пометки источника политика прежняя: «Полный доступ» разрешает.
  assert.equal(decide({ mode: 'full', name: 'shop_list_items', risk: 'T2', args: {} }), 'allow');
});

test('оплата в имени MCP запрещена и с префиксом сервера, и в белом списке', () => {
  for (const name of ['pay', 'charge', 'chargeCard', 'create-payment', 'checkout.session', 'buy_now', 'placeOrder', 'subscribe']) {
    const tool = fakeTool(name, [`shop_${name}`]);
    tool.ownerAllowed = () => true;
    assert.equal(verdict(tool, {}, 'full'), 'deny', name);
  }
  // Сырое имя без приведения: camelCase и дефис тоже не прячут слово.
  assert.equal(decide({ mode: 'full', name: 'stripe-createPayment', risk: 'T2', args: {} }), 'deny');
  assert.equal(decide({ mode: 'full', name: 'shopPay', risk: 'T2', args: {} }), 'deny');
  assert.equal(decide({ mode: 'full', name: 'files_deleteFile', risk: 'T2', args: {} }), 'ask');
  // Слово внутри другого слова — не оплата.
  assert.equal(decide({ mode: 'full', name: 'shop_display_items', risk: 'T2', args: {} }), 'allow');
});

test('слишком длинное или пустое имя MCP не регистрируется', () => {
  const list = [{ name: 'x'.repeat(70) }, { name: '***' }, { name: 'ok' }];
  assert.deepEqual(mcpTools({}, 'srv', list).map((t) => t.name), ['srv_ok']);
});

const STDIO_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 't' } } });
  if (m.method === 'tools/list') {
    process.stdout.write('посторонний вывод\\n');
    return send({ jsonrpc: '2.0', id: m.id, result: m.params.cursor ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'echo', description: 'Повтор', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }], nextCursor: 'p2' } });
  }
  if (m.method === 'tools/call') {
    if (m.params.name === 'second') return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'сломано' }] } });
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'эхо: ' + m.params.arguments.text }] } });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'нет метода' } });
});
`;

test('stdio: initialize, tools/list с продолжением, tools/call и ошибка инструмента', async () => {
  const registered = [];
  const clients = await connectMcpServers({ local: { command: process.execPath, args: ['-e', STDIO_SERVER] }, off: { disabled: true, command: 'нет' } }, { register: (t) => registered.push(t), allowed: () => [] });
  try {
    assert.equal(clients.length, 1);
    assert.deepEqual(registered.map((t) => t.name), ['local_echo', 'local_second']);
    const echo = registered[0];
    assert.equal(echo.parameters.properties.text.type, 'string');
    const res = await checkEffect(echo, { text: 'привет' }, await echo.run({ text: 'привет' }), {});
    assert.equal(res.ok, true);
    assert.equal(res.verified, 'unknown');
    assert.match(res.summary, /^эхо: привет \(не проверено/);
    const bad = await registered[1].run({});
    assert.equal(bad.ok, false);
    assert.match(bad.summary, /сломано/);
    await assert.rejects(clients[0].request('nope', {}), /нет метода/);
  } finally {
    for (const c of clients) c.close();
  }
});

test('stdio: сервер, который не запускается, не роняет подключение остальных', async () => {
  const logs = [];
  const clients = await connectMcpServers({ broken: { command: path.join(os.tmpdir(), 'нет-такой-программы.exe') } }, { register: () => {}, log: (m) => logs.push(m) });
  assert.deepEqual(clients, []);
  assert.match(logs[0], /^MCP broken:/);
});

test('http: сессия, поток событий и tools/call', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = JSON.parse(body);
      seen.push({ method: m.method, session: req.headers['mcp-session-id'], version: req.headers['mcp-protocol-version'] });
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      if (m.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      }
      if (m.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'getWeather' }] } })}\n\n`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { structuredContent: { t: 5 } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new McpClient({ url: `http://127.0.0.1:${server.address().port}/mcp` });
    await client.connect();
    const [tool] = mcpTools(client, 'weather', await client.listTools());
    assert.equal(tool.name, 'weather_get_weather');
    assert.deepEqual(await tool.run({}), { ok: true, summary: '{"t":5}' });
    assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.equal(seen[0].session, undefined);
    assert.ok(seen.slice(1).every((s) => s.session === 's-1' && s.version === '2025-06-18'));
  } finally {
    server.close();
  }
});

test('http: ошибка сервера понятна', async () => {
  const client = new McpClient({ url: 'http://127.0.0.1:9/mcp', fetchImpl: async () => new Response('нет', { status: 500 }) });
  await assert.rejects(client.connect(), /ошибкой 500/);
});

// ── почта

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nox-mail-')), 'gmail.bin');

// Запрос к локальному callback с явным заголовком Host: так проверяем защиту от DNS-rebinding.
function callbackGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('вход через локальный callback отвергает чужой state и принимает ответ текущего входа', async () => {
  const tokenCalls = [];
  const gmail = new GmailAccount({ file: tmpFile(), clientId: 'id', fetchImpl: async (url, opts) => {
    tokenCalls.push({ url, opts });
    return Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: `https://www.googleapis.com/auth/gmail.send ${READ_SCOPE}` });
  } });
  let invalidStatus;
  const result = await connectGmail({ gmail, read: true, timeoutMs: 5000, openExternal: async (url) => {
    const auth = new URL(url);
    const redirect = auth.searchParams.get('redirect_uri');
    invalidStatus = (await fetch(`${redirect}?code=x&state=wrong`)).status;
    const reply = await fetch(`${redirect}?code=c&state=${encodeURIComponent(auth.searchParams.get('state'))}`);
    assert.equal(reply.status, 200);
  } });
  assert.equal(invalidStatus, 400);
  assert.equal(result.ok, true);
  assert.equal(gmail.canRead(), true);
  assert.equal(tokenCalls.length, 1);
  assert.match(new URLSearchParams(String(tokenCalls[0].opts.body)).get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/oauth$/);
});

test('локальный callback отвергает чужой Host (DNS-rebinding) и не запускает обмен токена', async () => {
  let redirect = '';
  const finished = [];
  const gmail = {
    beginLogin: ({ redirect: target }) => { redirect = target; return { ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?state=host-state' }; },
    finishLogin: async (href) => { finished.push(href); return { ok: true }; },
    cancelLogin: () => {},
  };
  let badStatus;
  let goodStatus;
  let openDone;
  const openFinished = new Promise((resolve) => { openDone = resolve; });
  const result = await connectGmail({ gmail, timeoutMs: 5000, openExternal: async () => {
    try {
      const bad = await callbackGet(`${redirect}?code=x&state=host-state`, { Host: 'evil.example' });
      badStatus = bad.status;
      const good = await callbackGet(`${redirect}?code=c&state=host-state`);
      goodStatus = good.status;
    } finally {
      openDone();
    }
  } });
  await openFinished;
  assert.equal(badStatus, 400, 'чужой Host отклонён');
  assert.equal(goodStatus, 200, 'свой Host принят, state не потрачен зря');
  assert.equal(finished.length, 1);
  assert.equal(result.ok, true);
});

test('срок входа действует и во время обмена токена', async () => {
  let redirect = '';
  let cancelled = 0;
  const gmail = {
    beginLogin: ({ redirect: target }) => { redirect = target; return { ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?state=slow-state' }; },
    finishLogin: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 300)),
    cancelLogin: () => { cancelled += 1; },
  };
  const result = await connectGmail({ gmail, timeoutMs: 60, openExternal: async () => {
    await callbackGet(`${redirect}?code=c&state=slow-state`).catch(() => {});
  } });
  assert.equal(result.ok, false);
  assert.match(result.error, /истекло/);
  assert.equal(cancelled, 1);
});

test('после успешного обмена таймер входа снимается', async () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const TIMEOUT_MS = 7777;
  const created = new Set();
  let cleared = 0;
  global.setTimeout = function patchedSetTimeout(fn, ms, ...rest) {
    const handle = realSetTimeout(fn, ms, ...rest);
    if (ms === TIMEOUT_MS) created.add(handle);
    return handle;
  };
  global.clearTimeout = function patchedClearTimeout(handle) {
    if (created.delete(handle)) cleared += 1;
    return realClearTimeout(handle);
  };
  try {
    let redirect = '';
    const gmail = {
      beginLogin: ({ redirect: target }) => { redirect = target; return { ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?state=timer-state' }; },
      finishLogin: async () => ({ ok: true }),
      cancelLogin: () => {},
    };
    const result = await connectGmail({ gmail, timeoutMs: TIMEOUT_MS, openExternal: async () => {
      await callbackGet(`${redirect}?code=c&state=timer-state`);
    } });
    assert.equal(result.ok, true);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
  assert.equal(cleared, 1, 'таймер входа снят без просрочки');
  assert.equal(created.size, 0, 'незакрытых таймеров входа не осталось');
});

test('таймаут входа снимает временный запрос и не подключает почту', async () => {
  const gmail = new GmailAccount({ file: tmpFile(), clientId: 'id' });
  const result = await connectGmail({ gmail, openExternal: async () => {}, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error, /истекло/);
  assert.equal(gmail.connected(), false);
  assert.equal(gmail._pending, null);
});

test('ошибка браузера и ответ на неправильный адрес не подключают Gmail', async () => {
  const gmail = new GmailAccount({ file: tmpFile(), clientId: 'id' });
  const failed = await connectGmail({ gmail, openExternal: async () => { throw new Error('браузер недоступен'); }, timeoutMs: 1000 });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /браузер/);
  assert.equal(gmail._pending, null);
  const begin = gmail.beginLogin({ redirect: 'http://127.0.0.1:50000/oauth' });
  const state = new URL(begin.url).searchParams.get('state');
  const wrong = await gmail.finishLogin(`http://127.0.0.1:50000/oauth-fake?code=x&state=${state}`);
  assert.equal(wrong.ok, false);
  assert.equal(gmail.connected(), false);
});

test('чтение почты требует отдельного разрешения и возвращает ограниченные фрагменты', async () => {
  const requests = [];
  const gmail = new GmailAccount({ file: tmpFile(), clientId: 'id', now: () => 0, fetchImpl: async (url, opts) => {
    requests.push({ url: String(url), opts });
    if (!String(url).includes('/messages/')) return Response.json({ messages: [{ id: 'one' }, { id: 'two' }], nextPageToken: 'next' });
    if (String(url).includes('/two?')) return new Response('', { status: 503 });
    return Response.json({ snippet: 'Короткий текст', payload: { headers: [{ name: 'From', value: 'a@example.com' }, { name: 'Subject', value: 'Отчёт' }] } });
  } });
  gmail.token = { refresh_token: 'r', access_token: 'a', expires_at: 3600000 };
  assert.match((await gmail.listUnread()).error, /разрешением на чтение/);
  assert.equal(requests.length, 0);
  assert.ok(new URL(gmail.beginLogin({ read: true }).url).searchParams.get('scope').includes(READ_SCOPE));
  gmail.token.scope = READ_SCOPE;
  const read = mailTools(gmail).find((tool) => tool.name === 'mail_unread');
  const result = await read.run({ limit: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items.map((item) => [item.id, item.from, item.subject, item.snippet]), [['one', 'a@example.com', 'Отчёт', 'Короткий текст']]);
  assert.equal(result.data.failed, 1);
  assert.equal(result.data.hasMore, true);
  assert.match(result.summary, /не удалось прочитать: 1/);
  assert.equal(isForeignTextSource('mail_unread', 'mail'), true);
  assert.equal((await read.run({ limit: 21 })).ok, false);
});

test('учитывается фактически выданное Google разрешение на чтение', async () => {
  let scope = 'https://www.googleapis.com/auth/gmail.send';
  const gmail = new GmailAccount({ file: tmpFile(), clientId: 'id', fetchImpl: async () => Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope }) });
  const sendOnly = gmail.beginLogin();
  assert.equal(new URL(sendOnly.url).searchParams.get('scope').includes(READ_SCOPE), false);
  const first = gmail.beginLogin({ read: true });
  await gmail.finishLogin(`${first.redirect}?code=c&state=${new URL(first.url).searchParams.get('state')}`);
  assert.equal(gmail.canRead(), false);
  scope += ` ${READ_SCOPE}`;
  const second = gmail.beginLogin({ read: true });
  await gmail.finishLogin(`${second.redirect}?code=c&state=${new URL(second.url).searchParams.get('state')}`);
  assert.equal(gmail.canRead(), true);
});

test('после обновления с урезанными правами письма не запрашиваются', async () => {
  const calls = [];
  const gmail = new GmailAccount({ file: tmpFile(), clientId: 'id', now: () => 1000000, fetchImpl: async (url) => {
    calls.push(String(url));
    return Response.json({ access_token: 'new', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.send' });
  } });
  gmail.token = { refresh_token: 'r', access_token: 'expired', expires_at: 0, scope: READ_SCOPE };
  const result = await gmail.listUnread();
  assert.equal(result.ok, false);
  assert.match(result.error, /разрешением на чтение/);
  assert.equal(gmail.canRead(), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /oauth2\.googleapis\.com\/token/);
});
const protect = { encrypt: (s) => Buffer.from(`enc:${s}`), decrypt: (b) => String(b).replace(/^enc:/, '') };

test('письмо на новый адрес спрашивает, на известный в «Полном доступе» — нет', () => {
  const [tool] = mailTools(new GmailAccount({ file: tmpFile() }), { knownRecipients: () => ['Boss@Example.com'] });
  assert.equal(verdict(tool, { to: 'stranger@example.com', subject: 'a', body: 'b' }, 'full'), 'ask');
  assert.equal(verdict(tool, { to: ' boss@example.com ', subject: 'a', body: 'b' }, 'full'), 'allow');
  assert.equal(verdict(tool, { to: 'boss@example.com\r\nBcc: x@evil.com', subject: 'a', body: 'b' }, 'full'), 'ask');
  // В остальных режимах отправка спрашивает всегда.
  assert.equal(verdict(tool, { to: 'boss@example.com', subject: 'a', body: 'b' }, 'auto'), 'ask');
});

test('прямая просьба отправить письмо на указанный адрес проходит в полном доступе', () => {
  const args = { to: 'new@example.com', subject: 'Встреча', body: 'Привет' };
  const request = { name: 'mail_send', source: 'mail', risk: 'T2', args, ownerAllowed: false };
  assert.equal(decide({ ...request, mode: 'full', ownerText: 'Отправь письмо на new@example.com: Привет' }), 'allow');
  assert.equal(decide({ ...request, mode: 'auto', ownerText: 'Отправь письмо на new@example.com: Привет' }), 'ask');
  assert.equal(decide({ ...request, mode: 'ask', ownerText: 'Отправь письмо на new@example.com: Привет' }), 'ask');
  for (const ownerText of ['Не отправляй письмо на new@example.com', 'Отправь письмо на other@example.com', 'Посмотри письмо от new@example.com', 'Если попрошу, отправь письмо на new@example.com', 'Отправь письмо на new@example.com.evil']) {
    assert.equal(decide({ ...request, mode: 'full', ownerText }), 'ask', ownerText);
  }
  assert.equal(decide({ ...request, mode: 'full', ownerText: 'Отправь письмо на new@example.com', tainted: true }), 'ask');
});

test('цикл агента передаёт прямую просьбу политике и отправляет через Gmail без дополнительного вопроса', async () => {
  const { ToolRegistry } = require('../src/tools/registry');
  const sent = [];
  const [tool] = mailTools({ async send(message) { sent.push(message); return { ok: true, id: 'test-message' }; } });
  const tools = new ToolRegistry();
  tools.register(tool);
  let step = 0;
  const brain = { async chat() {
    if (step++ === 0) return { toolCalls: [{ id: 'mail-1', name: 'mail_send', args: { to: 'new@example.com', subject: 'Встреча', body: 'Привет' } }] };
    return { content: 'Письмо отправлено', toolCalls: [] };
  } };
  const events = [];
  const agent = new Agent({ brain, tools, policy: decide, mode: 'full', workspace: WS, journal: { append() {} }, emit: (event) => events.push(event) });
  const phrase = 'Отправь письмо на new@example.com: Привет';
  await agent.run(phrase, { ownerText: phrase });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'new@example.com');
  assert.equal(events.some((event) => event.type === 'approval_request'), false);
});

test('без учётных данных почта сообщает «не подключена»', async () => {
  const gmail = new GmailAccount({ file: tmpFile(), fetchImpl: () => { throw new Error('сети быть не должно'); } });
  const [tool] = mailTools(gmail);
  const res = await tool.run({ to: 'a@example.com', subject: 'т', body: 'т' });
  assert.equal(res.ok, false);
  assert.match(res.summary, /^почта не подключена/);
  assert.match(gmail.beginLogin().error, /^почта не подключена/);
  assert.deepEqual(gmail.state(), { credentials: false, connected: false });
  // Учётные данные есть, входа не было.
  const noLogin = new GmailAccount({ file: tmpFile(), clientId: 'id' });
  assert.match((await mailTools(noLogin)[0].run({ to: 'a@example.com', subject: '', body: '' })).summary, /^почта не подключена/);
});

test('вход, зашифрованный доступ, обновление и отправка с id в отчёте', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(String(opts.body));
      if (p.get('grant_type') === 'authorization_code') return Response.json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 });
      return Response.json({ access_token: 'a2', expires_in: 3600 });
    }
    return Response.json({ id: 'msg-42', threadId: 't1' });
  };
  let now = 1_000_000;
  const file = tmpFile();
  const gmail = new GmailAccount({ file, clientId: 'id', protect, fetchImpl, now: () => now });
  const begin = gmail.beginLogin();
  const state = new URL(begin.url).searchParams.get('state');
  assert.equal(new URL(begin.url).searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(await gmail.finishLogin(`${begin.redirect}?code=c1&state=${state}`), { ok: true });
  assert.match(fs.readFileSync(file, 'utf8'), /^enc:/);

  // Доступ переживает перезапуск; истёкший обновляется.
  const again = new GmailAccount({ file, clientId: 'id', fetchImpl, now: () => now });
  again.load(protect);
  assert.equal(again.connected(), true);
  now += 2 * 3600 * 1000;
  const [tool] = mailTools(again, { knownRecipients: () => ['boss@example.com'] });
  const args = { to: 'boss@example.com', subject: 'Отчёт', body: 'Готово.' };
  const res = await checkEffect(tool, args, await tool.run(args), {});
  assert.equal(res.ok, true);
  assert.equal(res.summary, 'отправлено, id=msg-42');
  assert.equal(res.verified, 'confirmed');
  const send = calls.at(-1);
  assert.equal(send.opts.headers.Authorization, 'Bearer a2');
  const raw = Buffer.from(JSON.parse(send.opts.body).raw, 'base64url').toString('utf8');
  assert.match(raw, /^To: boss@example.com\r\n/);
});

test('ответ Google не от этого входа не принимается; отозванный доступ снимается', async () => {
  const gmail = new GmailAccount({ file: tmpFile(), clientId: 'id', protect, fetchImpl: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
  gmail.beginLogin();
  assert.equal((await gmail.finishLogin('http://127.0.0.1:53682/oauth?code=c&state=чужой')).ok, false);
  gmail.token = { refresh_token: 'r', access_token: '', expires_at: 0 };
  const r = await gmail.accessToken();
  assert.match(r.error, /^почта не подключена: доступ отозван/);
  assert.equal(gmail.connected(), false);
});

test('письмо без id — «не проверено»; тема в base64 не создаёт заголовков', async () => {
  const gmail = { send: async () => ({ ok: true, id: '' }) };
  const [tool] = mailTools(gmail);
  const args = { to: 'a@example.com', subject: 's', body: 'b' };
  const res = await checkEffect(tool, args, await tool.run(args), {});
  assert.equal(res.verified, 'unknown');
  assert.doesNotMatch(mime({ to: 'a@example.com', subject: 'x\r\nBcc: e@evil.com', text: 't' }), /\r\nBcc:/);
});
