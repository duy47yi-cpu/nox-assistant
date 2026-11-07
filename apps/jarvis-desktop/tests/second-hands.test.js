'use strict';

// Пункты «вторых рук»: проверка действий в окнах, ожидание, поток, ответ во время хода, стоп, дела на ход, память.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Agent } = require('../src/agent/loop');
const { checkEffect } = require('../src/agent/effects');
const { DeepSeekClient } = require('../src/brain/deepseek');
const { runCommand } = require('../src/commands/runner');
const { StopSwitch, busyRoute, isStopPhrase } = require('../src/control/stop');
const { DealStore, openTurn, closeTurn, closeOrphanTurns, syncDeals, hanging, hangingText, isHangingPhrase } = require('../src/deals/deals');
const { MemoryStore, stem, memoryContext } = require('../src/memory/store');
const { runMission } = require('../src/missions/runner');
const modes = require('../src/policy/modes');
const { ApprovalBroker } = require('../src/policy/approvals');
const { ToolRegistry } = require('../src/tools/registry');
const { runPowerShell } = require('../src/tools/system');
const { uiTools, clickVerdict, typeVerdict, keysVerdict, focusVerdict, SCRIPTS } = require('../src/tools/ui');
const { waitTools } = require('../src/tools/wait');
const { webTools } = require('../src/tools/web');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hands-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const noJournal = { append() {} };

function registry(...list) {
  const r = new ToolRegistry();
  for (const tool of list) r.register(tool);
  return r;
}

function scriptedBrain(replies) {
  const calls = [];
  return {
    calls,
    async chat(args) {
      calls.push(args);
      return replies.shift() || { content: 'готово', toolCalls: [] };
    },
  };
}

// --- 1. Проверка действий -------------------------------------------------

const win = (over = {}) => ({ alive: true, fg: 1, readable: true, title: 'Окно', count: 10, tops: 1, ...over });
const target = (over = {}) => ({ found: 'ok', name: 'Кнопка', enabled: true, toggle: null, selected: null, expand: null, ...over });

test('ui_click: подтверждается только изменением, без изменений — не проверено, а не провал', () => {
  const base = { before: win(), target: target(), noisy: false };
  assert.equal(clickVerdict({ ...base, after: win(), targetAfter: target() }, { method: 'invoke' }).status, 'unknown');
  assert.equal(clickVerdict({ ...base, after: win({ title: 'Новый' }), targetAfter: target() }, { method: 'invoke' }).status, 'confirmed');
  assert.equal(clickVerdict({ ...base, after: win({ alive: false, readable: false }), targetAfter: { found: 'error' } }, { method: 'invoke' }).status, 'confirmed');
  assert.equal(clickVerdict({ ...base, after: win({ count: 12 }), targetAfter: target() }, { method: 'invoke' }).status, 'confirmed');
  assert.equal(clickVerdict(null).status, 'unknown');
});

test('ui_click: окно, меняющееся само, и сбой чтения не дают ложного подтверждения', () => {
  const noisy = { before: win(), target: target(), noisy: true, after: win({ count: 12 }), targetAfter: target() };
  assert.equal(clickVerdict(noisy, { method: 'invoke' }).status, 'unknown');
  const broken = { before: win(), target: target(), noisy: false, after: win({ readable: false, title: null, count: null, tops: null }), targetAfter: { found: 'error' } };
  assert.equal(clickVerdict(broken, { method: 'invoke' }).status, 'unknown', 'сбой провайдера не значит, что окно или элемент исчезли');
  const ambiguous = { before: win(), target: target(), noisy: false, after: win(), targetAfter: { found: 'ambiguous' } };
  assert.equal(clickVerdict(ambiguous, { method: 'invoke' }).status, 'unknown');
});

test('ui_click: переключатель и выбор читаются прямо, провал виден', () => {
  const c = (tb, ta) => ({ before: win(), after: win(), target: target(tb), targetAfter: target(ta), noisy: false });
  assert.equal(clickVerdict(c({ toggle: 'Off' }, { toggle: 'On' }), { method: 'toggle' }).status, 'confirmed');
  assert.equal(clickVerdict(c({ toggle: 'Off' }, { toggle: 'Off' }), { method: 'toggle' }).status, 'failed');
  assert.equal(clickVerdict(c({ selected: false }, { selected: true }), { method: 'select' }).status, 'confirmed');
  assert.equal(clickVerdict(c({ selected: false }, { selected: false }), { method: 'select' }).status, 'failed');
});

test('сохранение и отправка по состоянию окна не подтверждаются', () => {
  const c = { before: win(), after: win({ title: 'Другое' }), target: target(), targetAfter: target(), noisy: false };
  assert.equal(clickVerdict(c, { method: 'invoke', name: 'Сохранить' }).status, 'unknown');
  assert.equal(clickVerdict(c, { method: 'invoke', name: 'Send' }).status, 'unknown');
  const k = { before: { fg: 1, title: 'a', focus: 'x' }, after: { fg: 1, title: 'b', focus: 'x' } };
  assert.equal(keysVerdict(k, ['enter']).status, 'unknown');
  assert.equal(keysVerdict(k, ['ctrl+s']).status, 'unknown');
  assert.equal(keysVerdict(k, ['tab']).status, 'confirmed');
});

test('ui_type: значение прочитано — да или нет; недоступное значение — не проверено', () => {
  assert.equal(typeVerdict({ found: 'ok', known: true, matches: true, length: 3 }, 3).status, 'confirmed');
  const wrong = typeVerdict({ found: 'ok', known: true, matches: false, length: 1 }, 3);
  assert.equal(wrong.status, 'failed');
  assert.match(wrong.evidence, /длина 1/);
  assert.equal(typeVerdict({ found: 'ok', known: false, matches: false, length: 0 }, 3).status, 'unknown');
  assert.equal(typeVerdict({ found: 'ambiguous', known: false }, 3).status, 'unknown');
  assert.equal(typeVerdict(null, 3).status, 'unknown');
});

test('ui_keys и ui_focus: чтение состояния', () => {
  const same = { fg: 1, title: 't', focus: 'Edit:', known: true, hash: 5, length: 1 };
  assert.equal(keysVerdict({ before: same, after: same }, ['tab']).status, 'unknown');
  assert.equal(keysVerdict({ before: same, after: { ...same, focus: 'Button:OK' } }, ['tab']).status, 'confirmed');
  assert.equal(keysVerdict({ before: same, after: { ...same, hash: 6 } }, ['ctrl+a']).status, 'confirmed');
  assert.equal(focusVerdict({ foreground: true }).status, 'confirmed');
  assert.equal(focusVerdict({ foreground: false }).status, 'failed');
  assert.equal(focusVerdict(null).status, 'unknown');
});

test('verify подключён к ui_*, служебные данные и текст не уходят модели', async () => {
  const check = { found: 'ok', known: true, matches: true, length: 6 };
  const runner = async () => ({ ok: true, data: { stdout: JSON.stringify({ status: 'ok', window: 'W', element: { name: 'Поле' }, method: 'value', check }) } });
  const tools = uiTools({ runner, selfPid: 1 });
  const type = tools.find((t) => t.name === 'ui_type');
  const out = await checkEffect(type, { window: 'W', text: 'секрет' }, await type.run({ window: 'W', text: 'секрет' }, {}), {});
  assert.equal(out.verified, 'confirmed');
  assert.equal(out.data.check, undefined);
  assert.ok(!JSON.stringify(out).includes('секрет'));
  for (const name of ['ui_click', 'ui_type', 'ui_keys', 'ui_focus']) {
    assert.equal(typeof tools.find((t) => t.name === name).verify, 'function', name);
    assert.match(SCRIPTS[name], /check = /, name);
  }
});

test('таймаут действия — исход неизвестен, тот же вызов вслепую не повторяется', async () => {
  let runs = 0;
  const runner = async () => { runs += 1; return { ok: false, summary: 'таймаут 15000 мс', data: {} }; };
  const click = uiTools({ runner, selfPid: 1 }).find((t) => t.name === 'ui_click');
  const call = (id) => ({ id, name: 'ui_click', args: { window: 'W', name: 'Да' } });
  const brain = scriptedBrain([{ content: '', toolCalls: [call('1')] }, { content: '', toolCalls: [call('2')] }]);
  const results = [];
  const agent = new Agent({ brain, tools: registry(click), policy: () => 'allow', journal: noJournal, emit: (e) => { if (e.type === 'tool_result') results.push(e); } });
  await agent.run('нажми');
  assert.equal(runs, 1, 'второго нажатия нет');
  assert.equal(results[0].verified, 'unknown');
  assert.match(results[1].summary, /исход этого действия неизвестен/);
});

test('подтверждённое действие можно повторить: запрет только для неизвестного исхода', async () => {
  let runs = 0;
  const tool = { name: 'act', risk: 'T1', run: async () => { runs += 1; return { ok: true, summary: 'ок' }; }, verify: async () => ({ status: 'confirmed' }) };
  const call = (id) => ({ id, name: 'act', args: {} });
  const brain = scriptedBrain([{ content: '', toolCalls: [call('1')] }, { content: '', toolCalls: [call('2')] }]);
  await new Agent({ brain, tools: registry(tool), policy: () => 'allow', journal: noJournal }).run('x');
  assert.equal(runs, 2);
});

test('чтение другой папки или другого окна не разрешает повтор неподтверждённого нажатия', async () => {
  for (const [reader, args] of [['workspace_list', { path: 'notes' }], ['ui_elements', { window: 'Другое окно' }]]) {
    let clicks = 0;
    const click = { name: 'ui_click', risk: 'T1', run: async () => { clicks += 1; return { ok: true, summary: 'нажато' }; }, verify: async () => ({ status: 'unknown' }) };
    const inspect = { name: reader, risk: 'T0', run: async () => ({ ok: true, summary: 'прочитано' }) };
    const action = (id) => ({ id, name: 'ui_click', args: { window: 'Блокнот', name: 'Кнопка' } });
    const brain = scriptedBrain([{ toolCalls: [action('1')] }, { toolCalls: [{ id: '2', name: reader, args }] }, { toolCalls: [action('3')] }]);
    const agent = new Agent({ brain, tools: registry(click, inspect), policy: () => 'allow', journal: noJournal });
    await agent.run('Нажми кнопку');
    assert.equal(clicks, 1, reader);
  }
});

test('чтение элементов того же окна позволяет снова оценить неподтверждённое нажатие', async () => {
  let clicks = 0;
  const click = { name: 'ui_click', risk: 'T1', run: async () => { clicks += 1; return { ok: true, summary: 'нажато' }; }, verify: async () => ({ status: 'unknown' }) };
  const inspect = { name: 'ui_elements', risk: 'T0', run: async () => ({ ok: true, summary: 'прочитано' }) };
  const action = (id) => ({ id, name: 'ui_click', args: { window: 'Блокнот', name: 'Кнопка' } });
  const brain = scriptedBrain([{ toolCalls: [action('1')] }, { toolCalls: [{ id: '2', name: 'ui_elements', args: { window: 'Блокнот' } }] }, { toolCalls: [action('3')] }]);
  await new Agent({ brain, tools: registry(click, inspect), policy: () => 'allow', journal: noJournal }).run('Нажми кнопку');
  assert.equal(clicks, 2);
});

// --- 2. Ожидание ----------------------------------------------------------

const waiter = (probes, extra = {}) => waitTools({ probes, ...extra })[0];

test('wait_for: дожидается появления', async () => {
  let n = 0;
  const res = await waiter({ window: async () => { n += 1; return n >= 2; } }).run({ kind: 'window', target: 'Блокнот', timeout_ms: 2000 }, {});
  assert.equal(res.ok, true);
  assert.equal(n, 2);
});

test('wait_for: общий срок; «нет» и сбой опроса различаются', async () => {
  const started = Date.now();
  const no = await waiter({ process: async () => false }).run({ kind: 'process', target: 'x', timeout_ms: 300 }, {});
  assert.equal(no.ok, false);
  assert.equal(no.data.seen, false);
  assert.ok(Date.now() - started < 1500);
  const broken = await waiter({ window: async () => null }).run({ kind: 'window', target: 'x', timeout_ms: 100 }, {});
  assert.equal(broken.data.seen, null);
  assert.match(broken.summary, /неизвестно/);
});

test('wait_for: стоп прерывает меньше чем за 300 мс', async () => {
  const ac = new AbortController();
  const tool = waiter({ window: async () => false });
  const started = Date.now();
  setTimeout(() => ac.abort(), 50);
  const res = await tool.run({ kind: 'window', target: 'x', timeout_ms: 60000 }, { signal: ac.signal });
  assert.equal(res.summary, 'остановлено');
  assert.ok(Date.now() - started < 350);
});

test('wait_for: файл и границы папок', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a.txt');
  const resolveFile = (p) => {
    const abs = path.resolve(dir, p);
    if (!abs.startsWith(dir)) throw new Error('путь вне рабочей папки');
    return abs;
  };
  const tool = waitTools({ resolveFile })[0];
  setTimeout(() => fs.writeFileSync(file, 'x'), 80);
  assert.equal((await tool.run({ kind: 'file', target: 'a.txt', timeout_ms: 2000 }, {})).ok, true);
  const out = await tool.run({ kind: 'file', target: path.join(os.homedir(), 'x.txt'), timeout_ms: 100 }, {});
  assert.match(out.summary, /вне рабочей папки/);
  assert.equal(tool.risk, 'T0');
  assert.equal((await tool.run({ kind: 'мусор', target: 'a' }, {})).ok, false);
  assert.equal((await tool.run({ kind: 'process', target: 'a;rm', timeout_ms: 1 }, {})).ok, false);
  assert.equal((await waitTools({})[0].run({ kind: 'file', target: 'a', timeout_ms: 1 }, {})).ok, false, 'без границ файл не проверяем');
});

test('wait_for until=gone: ждёт исчезновения окна, процесса и файла', async (t) => {
  let n = 0;
  const gone = await waiter({ window: async () => { n += 1; return n < 3; } }).run({ kind: 'window', target: 'Блокнот', timeout_ms: 2000, until: 'gone' }, {});
  assert.equal(gone.ok, true);
  assert.equal(gone.data.until, 'gone');
  assert.equal(n, 3);

  const stillThere = await waiter({ process: async () => true }).run({ kind: 'process', target: 'calc', timeout_ms: 300, until: 'gone' }, {});
  assert.equal(stillThere.ok, false);
  assert.equal(stillThere.data.seen, true, 'процесс всё ещё есть');
  assert.match(stillThere.summary, /не исчезло/);

  const dir = tmp(t);
  const file = path.join(dir, 'lock.txt');
  fs.writeFileSync(file, 'x');
  setTimeout(() => fs.rmSync(file), 80);
  const resolveFile = (p) => path.resolve(dir, p);
  const fileGone = await waitTools({ resolveFile })[0].run({ kind: 'file', target: 'lock.txt', timeout_ms: 2000, until: 'gone' }, {});
  assert.equal(fileGone.ok, true);
});

test('wait_for until=gone: сбой опроса не считается исчезновением', async () => {
  const broken = await waiter({ window: async () => null }).run({ kind: 'window', target: 'x', timeout_ms: 100, until: 'gone' }, {});
  assert.equal(broken.ok, false, 'неизвестно — не успех');
  assert.equal(broken.data.seen, null);
  assert.match(broken.summary, /неизвестно/);
});

test('wait_for: until со значением не из списка отклоняется', async () => {
  const res = await waiter({}).run({ kind: 'window', target: 'x', until: 'почти' }, {});
  assert.equal(res.ok, false);
});

// --- 3. Поток -------------------------------------------------------------

function sseResponse(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const client = (fetchImpl, extra = {}) => new DeepSeekClient({ baseUrl: 'http://x', apiKey: 'k', model: 'm', fetchImpl, ...extra });

test('поток: части текста, разорванные чанки, итог как без потока, usage на месте', async () => {
  const full = sse({ choices: [{ delta: { content: 'При' } }] }) + sse({ choices: [{ delta: { content: 'вет' } }] });
  const bodies = [];
  const usages = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return sseResponse([full.slice(0, 20), full.slice(20), sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }), sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }), 'data: [DONE]\n\n']);
  };
  const deltas = [];
  const res = await client(fetchImpl).chat({ messages: [], onDelta: (d) => deltas.push(d), onUsage: (i) => usages.push(i) });
  assert.deepEqual(deltas, ['При', 'вет']);
  assert.equal(res.content, 'Привет');
  assert.equal(bodies[0].stream, true);
  assert.equal(usages[0].usage.promptTokens, 5);
  assert.equal(res.stats.completionTokens, 2);
});

test('поток: вызовы инструментов собираются из частей', async () => {
  const fetchImpl = async () => sseResponse([
    sse({ choices: [{ delta: { reasoning_content: 'думаю' } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ui_', arguments: '{"a"' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'click', arguments: ':1}' } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]);
  const res = await client(fetchImpl).chat({ messages: [], onDelta: () => {} });
  assert.deepEqual(res.toolCalls, [{ id: 'c1', name: 'ui_click', args: { a: 1 }, argsError: null }]);
  assert.equal(res.reasoningContent, 'думаю');
});

test('поток: обрыв — ошибка без повтора, usage не притворяется точным', async () => {
  let posts = 0;
  const usages = [];
  const fetchImpl = async () => { posts += 1; return sseResponse([sse({ choices: [{ delta: { content: 'час' } }] })]); };
  await assert.rejects(client(fetchImpl).chat({ messages: [], onDelta: () => {}, onUsage: (i) => usages.push(i) }), /оборвался/);
  assert.equal(posts, 1);
  assert.equal(usages[0].usage, null);
});

test('поток: провайдер отверг или не умеет — обычный ответ', async () => {
  const json = JSON.stringify({ choices: [{ message: { content: 'целиком' } }] });
  const bodies = [];
  const fetchImpl = async (u, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.at(-1).stream) return new Response('{"error":{"message":"bad"}}', { status: 400 });
    return new Response(json, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const c = client(fetchImpl);
  assert.equal((await c.chat({ messages: [], onDelta: () => {} })).content, 'целиком');
  assert.equal(c.streamRejected, true);
  await c.chat({ messages: [], onDelta: () => {} });
  assert.equal(bodies.at(-1).stream, undefined);
  assert.equal(bodies.length, 3);
  // Без onDelta запрос прежний.
  await client(fetchImpl).chat({ messages: [] });
  assert.equal(bodies.at(-1).stream, undefined);
});

test('агент: поток не дублирует текст, без потока текст целиком; первый символ раньше конца запроса', async () => {
  const events = [];
  let resolveChat;
  const brain = {
    chat: ({ onDelta }) => new Promise((resolve) => {
      onDelta('Пер');
      onDelta('вый');
      resolveChat = () => resolve({ content: 'Первый', toolCalls: [] });
    }),
  };
  const agent = new Agent({ brain, tools: registry(), policy: () => 'allow', journal: noJournal, emit: (e) => events.push(e), stream: true });
  const run = agent.run('x');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.delta), ['Пер', 'вый'], 'текст пришёл до конца запроса');
  assert.equal(events.find((e) => e.type === 'status').state, 'thinking', 'статус раньше текста');
  resolveChat();
  await run;
  assert.equal(events.filter((e) => e.type === 'text').length, 2);
  assert.equal(events.at(-2).type, 'done');

  const plain = [];
  const a2 = new Agent({ brain: scriptedBrain([{ content: 'целиком', toolCalls: [] }]), tools: registry(), policy: () => 'allow', journal: noJournal, emit: (e) => plain.push(e) });
  await a2.run('x');
  assert.deepEqual(plain.filter((e) => e.type === 'text').map((e) => e.delta), ['целиком']);
});

test('агент: фоновый агент без stream не просит поток', async () => {
  const brain = scriptedBrain([{ content: 'a', toolCalls: [] }]);
  await new Agent({ brain, tools: registry(), policy: () => 'allow', journal: noJournal }).run('x');
  assert.equal(brain.calls[0].onDelta, undefined);
});

// --- 4. Ответ во время хода ----------------------------------------------

test('во время хода отвечают «что повисло» и «стоп», остальное занято, история не меняется', () => {
  let stopped = 0;
  const deps = { isHanging: isHangingPhrase, hangingNow: () => 'Ничего не висит.', stopTurn: () => { stopped += 1; } };
  assert.deepEqual(busyRoute('что повисло?', deps), { ok: true, side: true, command: 'дела', reply: 'Ничего не висит.' });
  assert.equal(stopped, 0);
  assert.equal(busyRoute('Стоп!', deps).side, true);
  assert.equal(stopped, 1);
  assert.deepEqual(busyRoute('открой почту', deps), { ok: false, error: 'busy' });
  assert.equal(isStopPhrase('стоп машина'), false);
});

test('main.js: разбор во время хода стоит раньше ответа busy, окно умеет показать ответ', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf("ipcMain.handle('chat:send'"), main.indexOf('busy = true;', main.indexOf("ipcMain.handle('chat:send'")));
  assert.match(block, /if \(busy\) return routeBusy\(text\)/);
  assert.doesNotMatch(block, /error: 'busy'/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(app, /side\.reply/);
});

test('фон окна: только проверенный цвет из настроек, окно сообщает цвет темы', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /WINDOW_BG\.test\(readSettings\(\)\.windowBg\)/);
  assert.match(main, /!WINDOW_BG\.test\(String\(color\)\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8'), /setWindowBackground/);
});

// --- 5. Аварийный стоп ----------------------------------------------------

function hangingFetch() {
  const seen = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    seen.push(init.signal);
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  return { fetchImpl, seen };
}

test('стоп обрывает web_* сразу, а не по таймауту, и говорит «остановлено»', async () => {
  for (const [name, args] of [['web_search', { query: 'a' }], ['web_wiki', { title: 'a' }], ['web_fetch', { url: 'https://example.com/' }]]) {
    const { fetchImpl } = hangingFetch();
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }]; // без настоящего DNS
    const tool = webTools({ fetchImpl, timeoutMs: 60000, lookup }).find((t) => t.name === name);
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 20);
    const res = await tool.run(args, { signal: ac.signal });
    assert.equal(res.summary, 'остановлено', name);
    assert.ok(Date.now() - started < 1000, name);
  }
});

test('web_*: таймаут без стопа по-прежнему таймаут', async () => {
  const { fetchImpl } = hangingFetch();
  const tool = webTools({ fetchImpl, timeoutMs: 20 }).find((t) => t.name === 'web_search');
  assert.equal((await tool.run({ query: 'a' })).summary, 'время ожидания истекло');
});

test('стоп прерывает миссию посреди инструмента и посреди запроса к модели', async (t) => {
  const dir = tmp(t);
  const stop = new StopSwitch();
  const { fetchImpl } = hangingFetch();
  const web = webTools({ fetchImpl, timeoutMs: 60000 }).find((x) => x.name === 'web_search');
  const brain = scriptedBrain([{ content: '', toolCalls: [{ id: '1', name: 'web_search', args: { query: 'a' } }] }]);
  const started = Date.now();
  const run = runMission({ id: 'm', goal: 'g' }, { brain, tools: registry(web), journal: noJournal, workspace: dir, reportsDir: dir, stop });
  setTimeout(() => stop.trigger(), 30);
  const out = await run;
  assert.equal(out.outcome, 'stopped');
  assert.ok(Date.now() - started < 1000);

  stop.reset();
  const slow = { chat: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) };
  const run2 = runMission({ id: 'm2', goal: 'g' }, { brain: slow, tools: registry(), journal: noJournal, workspace: dir, reportsDir: dir, stop });
  setTimeout(() => stop.trigger(), 30);
  assert.equal((await run2).outcome, 'stopped');
});

test('стоп прерывает команду посреди шага и её подтверждение', async () => {
  const stop = new StopSwitch();
  let after = 0;
  const hang = { name: 'hang', risk: 'T1', run: (a, ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: false, summary: 'оборвано' }))) };
  const next = { name: 'next', risk: 'T1', run: async () => { after += 1; return { ok: true, summary: '' }; } };
  const cmd = { id: 'c', name: 'к', steps: [{ tool: 'hang', args: {} }, { tool: 'next', args: {} }] };
  const run = runCommand(cmd, { tools: registry(hang, next), policy: { decide: () => 'allow' }, journal: noJournal, mode: 'full', stop });
  setTimeout(() => stop.trigger(), 20);
  const out = await run;
  assert.equal(out.ok, false);
  assert.equal(after, 0);

  stop.reset();
  const approvals = new ApprovalBroker();
  const run2 = runCommand({ id: 'c', name: 'к', steps: [{ tool: 'next', args: {} }] }, { tools: registry(next), policy: { decide: () => 'ask' }, journal: noJournal, mode: 'ask', stop, approvals });
  setTimeout(() => stop.trigger(), 20);
  assert.equal((await run2).ok, false);
  assert.equal(after, 0);
});

test('сигнал владельца тоже прерывает команду', async () => {
  const ac = new AbortController();
  const hang = { name: 'hang', risk: 'T1', run: (a, ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: false, summary: 'оборвано' }))) };
  const run = runCommand({ id: 'c', name: 'к', steps: [{ tool: 'hang', args: {} }] }, { tools: registry(hang), policy: { decide: () => 'allow' }, journal: noJournal, mode: 'full', stop: new StopSwitch(), signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  assert.equal((await run).ok, false);
});

test('агент отписывается от стопа по концу хода и не шлёт лишний done', async () => {
  const stop = new StopSwitch();
  const events = [];
  const agent = new Agent({ brain: scriptedBrain([{ content: 'a', toolCalls: [] }]), tools: registry(), policy: () => 'allow', journal: noJournal, stop, emit: (e) => events.push(e) });
  await agent.run('x');
  const before = events.length;
  stop.trigger();
  assert.equal(events.length, before);
});

test('runPowerShell при уже остановленном сигнале не запускает скрипт', async () => {
  const ac = new AbortController();
  ac.abort();
  const res = await runPowerShell('exit 0', {}, { signal: ac.signal });
  assert.equal(res.ok, false);
  assert.equal(res.summary, 'остановлено');
});

// --- 6. Дела на ход -------------------------------------------------------

function dealStore(t) {
  const dir = tmp(t);
  return { store: new DealStore(path.join(dir, 'd.jsonl'), path.join(dir, 'd.json')), dir };
}

test('упавший ход виден в делах с причиной, ход с ответом не копится', (t) => {
  const { store } = dealStore(t);
  const ok = openTurn(store, 'открой почту');
  assert.equal(store.get(ok).state, 'started');
  closeTurn(store, ok, 'answer');
  assert.equal(store.get(ok), null);

  const bad = openTurn(store, 'длинное дело');
  closeTurn(store, bad, 'error', 'HTTP 500');
  const lim = openTurn(store, 'ещё дело');
  closeTurn(store, lim, 'limit');
  const stopped = openTurn(store, 'третье');
  closeTurn(store, stopped, 'stopped');
  const failed = hanging(store).failed;
  assert.equal(failed.length, 3);
  assert.match(store.get(bad).reason, /HTTP 500/);
  assert.match(hangingText(hanging(store)), /длинное дело/);
});

test('ход, оборванный падением процесса, становится провалом после запуска; forget переживает перезагрузку', (t) => {
  const { store, dir } = dealStore(t);
  const ref = openTurn(store, 'x');
  const gone = openTurn(store, 'y');
  closeTurn(store, gone, 'answer');
  const again = new DealStore(path.join(dir, 'd.jsonl'), path.join(dir, 'd.json'));
  assert.equal(again.get(gone), null);
  closeOrphanTurns(again);
  assert.equal(again.get(ref).state, 'failed');
  assert.match(again.get(ref).reason, /прерван/);
  fs.rmSync(path.join(dir, 'd.json'));
  const fromEvents = new DealStore(path.join(dir, 'd.jsonl'), path.join(dir, 'd.json'));
  assert.equal(fromEvents.get(gone), null, 'и при сборке из событий');
});

test('подтверждение видно в делах, пока ждёт, и уходит после решения', (t) => {
  const { store } = dealStore(t);
  syncDeals(store, { approvals: [{ id: 'a1', name: 'ui_click' }] });
  syncDeals(store, { approvals: [{ id: 'a1', name: 'ui_click' }] });
  assert.equal(hanging(store).waiting.length, 1);
  assert.match(hangingText(hanging(store)), /Нажатие в окне: ждёт вашего решения/);
  syncDeals(store, { approvals: [] });
  assert.equal(store.list().length, 0);
});

test('настоящая очередь подтверждений отдаёт имя для дел', async () => {
  const broker = new ApprovalBroker();
  const waiting = broker.request({ id: 'x', name: 'shell_run' });
  assert.equal(broker.list()[0].name, 'shell_run');
  broker.respond('x', 'reject');
  await waiting;
});

// --- 7. Память ------------------------------------------------------------

test('поиск находит русские падежи', (t) => {
  const mem = new MemoryStore(path.join(tmp(t), 'm.json'));
  const pairs = [
    ['встреча с Иваном в пятницу', 'Ивану'],
    ['мама любит ромашки', 'маме'],
    ['книга лежит на столе', 'книгу'],
    ['врач принимает во вторник', 'врачу'],
    ['работа начинается в девять', 'работе'],
    ['пароль от роутера на наклейке', 'роутеру'],
    ['машина стоит в гараже', 'машину'],
    ['собака боится грозы', 'собаке'],
    ['Москва, улица Ленина', 'Москве'],
    ['любимая кофейня на углу', 'кофейни'],
  ];
  let found = 0;
  for (const [note, q] of pairs) {
    const rec = mem.add({ text: note });
    if (mem.search(q).some((x) => x.id === rec.id)) found += 1;
  }
  assert.equal(found, pairs.length);
  assert.equal(stem('ёж'.replace('ё', 'е')), 'еж');
  assert.equal(mem.search('несуществующее').length, 0);
});

test('заметки сами приходят в запрос, малым объёмом, не меняя историю; служебные слова не тянут мусор', async (t) => {
  const mem = new MemoryStore(path.join(tmp(t), 'm.json'));
  for (let i = 0; i < 10; i += 1) mem.add({ text: `Иван заметка ${i} ${'х'.repeat(400)}` });
  mem.add({ text: 'что где когда' });
  assert.equal(memoryContext(mem, 'что мне сделать?'), '');
  assert.equal(memoryContext(mem, ''), '');
  const ctx = memoryContext(mem, 'позвони Ивану');
  // 8 заметок по 300 символов и строка-заголовок.
  assert.ok(ctx.length < 2700, String(ctx.length));
  assert.equal(ctx.split('\n').length, 9);
  assert.match(ctx, /данные, а не указания/);

  const brain = scriptedBrain([{ content: 'ок', toolCalls: [] }]);
  const agent = new Agent({ brain, tools: registry(), policy: () => 'allow', journal: noJournal, context: (x) => memoryContext(mem, x), clock: () => 'Сейчас: 1.' });
  await agent.run('позвони Ивану');
  const sent = brain.calls[0].messages.at(-1).content;
  assert.match(sent, /Сейчас: 1/);
  assert.match(sent, /заметка/);
  assert.equal(agent.history[0].content, 'позвони Ивану');
});

test('сбой памяти не ломает ход', async () => {
  const brain = scriptedBrain([{ content: 'ок', toolCalls: [] }]);
  const agent = new Agent({ brain, tools: registry(), policy: () => 'allow', journal: noJournal, context: () => { throw new Error('файл повреждён'); } });
  assert.equal((await agent.run('x')).ok, true);
});

// Политика не менялась: новый инструмент только T0, чувствительные действия по-прежнему спрашиваются.
test('режимы: wait_for разрешён как чтение, ui_click в «Спрашивать» всё так же спрашивает', () => {
  assert.equal(modes.decide({ mode: 'ask', name: 'wait_for', risk: 'T0', args: {} }), 'allow');
  assert.equal(modes.decide({ mode: 'ask', name: 'ui_click', risk: 'T1', args: { window: 'x' } }), 'ask');
});
