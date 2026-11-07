'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Meter } = require('../src/cost/meter');
const { createGuard, DEFAULT_MAX_OUTPUT_TOKENS, MAX_ATTEMPTS } = require('../src/cost/guard');
const { DeepSeekClient } = require('../src/brain/deepseek');

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const UNPRICED = 'vendor/unpriced-model';
const IN_PER_M = 0.20;
const OUT_PER_M = 0.60;
const BLOCKED_REASON = 'файл учёта повреждён — лимит не обеспечен';

// Ответ провайдера: 10000 вход (4000 из кэша), 2000 выход →
// (6000 × 0.20 + 4000 × 0.006 + 2000 × 0.60) / 1e6 = 0.002424 USD.
const RAW_USAGE = {
  prompt_tokens: 10000,
  completion_tokens: 2000,
  prompt_tokens_details: { cached_tokens: 4000 },
  completion_tokens_details: { reasoning_tokens: 500 },
};
const USAGE = { promptTokens: 10000, cachedTokens: 4000, completionTokens: 2000, reasoningTokens: 500 };
const USAGE_COST = 0.002424;
const OK = { status: 200, body: { choices: [{ message: { content: 'готово' } }], usage: RAW_USAGE } };
const REJECTED = { status: 400, body: { error: { message: 'unknown field reasoning_effort' } } };
const MESSAGES = [{ role: 'user', content: 'привет' }];
const TOOLS = [{ type: 'function', function: { name: 'volume_set', parameters: { type: 'object' } } }];

function near(actual, expected) {
  assert.equal(typeof actual, 'number', `ожидалось число, получено ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Часы в местном времени: дата счётчиков не зависит от часового пояса машины.
function clock(y, m, d, h = 12) {
  const at = new Date(y, m - 1, d, h, 0, 0);
  return () => new Date(at.getTime());
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function newMeter(t, opts = {}) {
  const file = path.join(tmpDir(t), 'cost.json');
  return { file, meter: new Meter({ file, now: clock(2026, 10, 30), ...opts }) };
}

// Оценка по формуле задачи: вход — символы JSON {messages, tools} / 2 вверх, выход — потолок,
// весь вход по полной цене. attempt — одна HTTP-попытка, worst — весь вызов: attempt × 4.
function expected(messages, tools, maxOutputTokens = 4096) {
  const inputTokens = Math.ceil(JSON.stringify({ messages, tools }).length / 2);
  const attempt = (inputTokens * IN_PER_M) / 1e6 + (maxOutputTokens * OUT_PER_M) / 1e6;
  return { inputTokens, attempt, worst: attempt * 4 };
}

// Подделка мозга: считает вызовы, запоминает аргументы. По умолчанию сообщает onUsage об одной
// успешной попытке с usage; reply(args) заменяет поведение целиком.
function fakeBrain({ model = MODEL, reply } = {}) {
  const brain = {
    model,
    calls: 0,
    args: [],
    async chat(args) {
      brain.calls += 1;
      brain.args.push(args);
      if (reply) return reply(args);
      args.onUsage({ model, purpose: args.purpose, ok: true, usage: USAGE, requestChars: 0, attempts: 1 });
      return { content: 'ok', reasoningContent: null, toolCalls: [] };
    },
  };
  return brain;
}

// Фейковый fetch по сценарию: Error — сбой сети, {status, body} — ответ сервера.
// onAttempt() вызывается в начале каждой попытки: можно посмотреть на учёт в этот момент.
function scriptedFetch(steps, onAttempt) {
  const bodies = [];
  const fn = async (url, init) => {
    bodies.push(init.body);
    if (onAttempt) onAttempt(bodies.length);
    const step = steps[Math.min(bodies.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    const text = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
    return { ok: step.status >= 200 && step.status < 300, status: step.status, text: async () => text };
  };
  fn.bodies = bodies;
  return fn;
}

function client(fetchImpl, extra = {}) {
  return new DeepSeekClient({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: MODEL, fetchImpl, timeoutMs: 5000, ...extra });
}

// ---- Отказ до запроса ----

test('цена модели неизвестна: вызова нет, code = budget', async (t) => {
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  const brain = fakeBrain({ model: UNPRICED });
  const guard = createGuard({ brain, meter, model: UNPRICED });
  await assert.rejects(guard.chat({ messages: MESSAGES }), (err) => {
    assert.equal(err.code, 'budget');
    assert.equal(err.reason, 'цена модели неизвестна — лимит не обеспечен');
    assert.equal(err.scope, 'price');
    return true;
  });
  assert.equal(brain.calls, 0);
  assert.equal(meter.reservedUsd, 0);
  assert.equal(fs.existsSync(file), false, 'запроса не было — учитывать нечего');

  // Без дневного лимита — тоже отказ: без цены не посчитать ни день, ни задачу.
  const unlimited = createGuard({ brain, meter: new Meter({ file }), model: UNPRICED });
  await assert.rejects(unlimited.chat({ messages: MESSAGES }), (err) => err.code === 'budget');
  // Похожий, но не точный ID.
  const lower = MODEL.toLowerCase();
  const similar = createGuard({ brain: fakeBrain({ model: lower }), meter, model: lower });
  await assert.rejects(similar.chat({ messages: MESSAGES }), (err) => err.code === 'budget' && err.scope === 'price');
  assert.equal(brain.calls, 0);
});

test('страж спрашивает meter.enforceable: «не обеспечен» — вызова нет даже при известной цене', async (t) => {
  const { meter } = newMeter(t, { dailyLimitUsd: 1 });
  meter.enforceable = () => false;
  const brain = fakeBrain();
  const guard = createGuard({ brain, meter, model: MODEL });
  await assert.rejects(guard.chat({ messages: MESSAGES }), (err) => err.code === 'budget' && err.scope === 'price');
  assert.equal(brain.calls, 0);
});

test('мозг работает с другой моделью, чем цена стража: вызова нет', async (t) => {
  const { meter } = newMeter(t, { dailyLimitUsd: 1 });
  const brain = fakeBrain({ model: UNPRICED });
  const guard = createGuard({ brain, meter, model: MODEL });
  await assert.rejects(guard.chat({ messages: MESSAGES }), (err) => {
    assert.equal(err.code, 'budget');
    assert.equal(err.scope, 'price');
    assert.match(err.reason, /vendor\/unpriced-model.*лимит не обеспечен/);
    return true;
  });
  assert.equal(brain.calls, 0);
});

test('файл учёта повреждён: вызова нет, причина — «файл учёта повреждён», и после перезапуска тоже', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  fs.writeFileSync(file, '{"date":"2026-10-30","spentUsd":0.9,', 'utf8');
  const brain = fakeBrain();
  const guard = createGuard({ brain, meter, model: MODEL });
  await assert.rejects(guard.chat({ messages: MESSAGES }), (err) => {
    assert.equal(err.code, 'budget');
    assert.equal(err.scope, 'meter');
    assert.equal(err.reason, BLOCKED_REASON);
    return true;
  });
  assert.equal(errors.mock.callCount(), 1);
  // Файл не обнулён: прежнее содержимое лежит копией, а остаток дня на время блока — ноль.
  const dir = path.dirname(file);
  const copies = fs.readdirSync(dir).filter((f) => f.startsWith('cost.json.corrupt-'));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), '{"date":"2026-10-30","spentUsd":0.9,');
  assert.equal(meter.remainingToday(), 0);

  const restarted = createGuard({ brain, meter: new Meter({ file, dailyLimitUsd: 1, now: clock(2026, 10, 30) }), model: MODEL });
  await assert.rejects(restarted.chat({ messages: MESSAGES }), (err) => err.code === 'budget' && err.reason === BLOCKED_REASON);
  assert.equal(brain.calls, 0);
  assert.deepEqual(readState(file).pending, [], 'резерва под отклонённый вызов нет');
});

test('остаток дня меньше худшего случая: вызова нет, причина — «дневной лимит»', async (t) => {
  const { meter } = newMeter(t, { dailyLimitUsd: 0.001 });
  const brain = fakeBrain();
  const guard = createGuard({ brain, meter, model: MODEL });
  const { attempt } = expected(MESSAGES);
  await assert.rejects(guard.chat({ messages: MESSAGES }), (err) => {
    assert.equal(err.code, 'budget');
    assert.equal(err.scope, 'day');
    assert.match(err.reason, /дневной лимит/);
    // 49 символов JSON → 25 токенов входа; попытка (25 × 0.20 + 4096 × 0.60) / 1e6 = 0.0024626.
    assert.equal(err.reason, 'дневной лимит: остаток $0.001, следующая попытка до $0.002463');
    near(err.attemptUsd, attempt);
    assert.equal(err.remainingUsd, 0.001);
    return true;
  });
  assert.equal(brain.calls, 0);
  assert.equal(meter.reservedUsd, 0);
});

test('каждая HTTP-попытка проверяется до запроса и резервируется отдельно: повтор без остатка не уходит', { timeout: 10000 }, async (t) => {
  const { attempt } = expected(MESSAGES);
  assert.equal(MAX_ATTEMPTS, 4);

  // На одну попытку места нет — вызова нет совсем.
  const tight = newMeter(t, { dailyLimitUsd: 0.5 * attempt });
  const none = scriptedFetch([OK]);
  await assert.rejects(
    createGuard({ brain: client(none), meter: tight.meter, model: MODEL }).chat({ messages: MESSAGES }),
    (err) => err.code === 'budget' && err.scope === 'day',
  );
  assert.equal(none.bodies.length, 0);

  // На первую попытку места хватает, на повтор — нет: первая даёт сбой сети, повтор проверяется и не уходит.
  const once = newMeter(t, { dailyLimitUsd: 1.5 * attempt });
  const reserves = t.mock.method(once.meter, 'reserveWithin');
  const fetchImpl = scriptedFetch([new TypeError('fetch failed'), OK]);
  await assert.rejects(
    createGuard({ brain: client(fetchImpl), meter: once.meter, model: MODEL }).chat({ messages: MESSAGES }),
    (err) => {
      near(err.attemptUsd, attempt);
      return err.code === 'budget' && err.scope === 'day';
    },
  );
  assert.equal(fetchImpl.bodies.length, 1, 'повтор без остатка не отправлен');
  assert.equal(reserves.mock.callCount(), 2, 'первая попытка и проверка повтора');
  assert.deepEqual(reserves.mock.calls.map((c) => c.result.ok), [true, false], 'повтор отказан, резерва нет');
  near(reserves.mock.calls[0].arguments[0], attempt);
  near(once.meter.spentToday(), attempt);
  assert.equal(once.meter.reservedUsd, 0);

  // Места хватает на все попытки — каждая получает свой резерв, и после вызова резервов нет.
  const enough = newMeter(t, { dailyLimitUsd: 4.01 * attempt });
  const seen = [];
  const guard = createGuard({
    brain: fakeBrain({ reply: async () => { seen.push(enough.meter.reservedUsd); return { content: 'ok', reasoningContent: null, toolCalls: [] }; } }),
    meter: enough.meter,
    model: MODEL,
  });
  await guard.chat({ messages: MESSAGES });
  near(seen[0], attempt);
  assert.equal(enough.meter.reservedUsd, 0);
});

test('остаток дня: вычитаются и потраченное, и резерв попытки в полёте', { timeout: 10000 }, async (t) => {
  const { attempt } = expected(MESSAGES);
  // Лимит: уже потрачено USAGE_COST, остаётся полторы попытки — второй параллельный вызов не помещается.
  const { meter } = newMeter(t, { dailyLimitUsd: USAGE_COST + 1.5 * attempt });
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  // Ждёт только первый вызов: если страж ошибочно пропустит второй, тест упадёт, а не повиснет.
  const brain = fakeBrain({
    reply: async () => {
      if (brain.calls === 1) await gate;
      return { content: 'ok', reasoningContent: null, toolCalls: [] };
    },
  });
  const guard = createGuard({ brain, meter, model: MODEL });

  const first = guard.chat({ messages: MESSAGES });
  assert.equal(brain.calls, 1);
  near(meter.reservedUsd, attempt);
  near(meter.remainingToday(), 0.5 * attempt);
  await assert.rejects(guard.chat({ messages: MESSAGES }), (err) => err.code === 'budget' && err.scope === 'day');
  assert.equal(brain.calls, 1, 'второй запрос не отправлен');

  open();
  await first;
  assert.equal(meter.reservedUsd, 0);
  // Резерв снят: теперь вызов помещается.
  await guard.chat({ messages: MESSAGES });
  assert.equal(brain.calls, 2);
});

test('дневной лимит не задан: вызов идёт, расход всё равно записан', async (t) => {
  const { meter } = newMeter(t);
  const brain = fakeBrain();
  const guard = createGuard({ brain, meter, model: MODEL });
  await guard.chat({ messages: MESSAGES });
  assert.equal(brain.calls, 1);
  near(meter.spentToday(), USAGE_COST);
});

test('бюджет задачи исчерпан: вызова нет; другая задача и бюджет с запасом проходят', async (t) => {
  const { meter } = newMeter(t, { dailyLimitUsd: 1 });
  const brain = fakeBrain();
  const guard = createGuard({ brain, meter, model: MODEL });
  const { attempt } = expected(MESSAGES);
  meter.record({ purpose: 'task', model: MODEL, usage: USAGE, taskId: 't1' });

  const budget = USAGE_COST + 0.9 * attempt; // потрачено + следующая попытка больше бюджета
  await assert.rejects(guard.chat({ messages: MESSAGES, taskId: 't1', taskBudgetUsd: budget }), (err) => {
    assert.equal(err.code, 'budget');
    assert.equal(err.scope, 'task');
    assert.equal(err.reason, 'бюджет задачи исчерпан');
    near(err.spentUsd, USAGE_COST);
    near(err.attemptUsd, attempt);
    assert.equal(err.budgetUsd, budget);
    return true;
  });
  assert.equal(brain.calls, 0);
  assert.equal(meter.reservedUsd, 0);

  await guard.chat({ messages: MESSAGES, taskId: 't2', taskBudgetUsd: budget });
  await guard.chat({ messages: MESSAGES, taskId: 't1', taskBudgetUsd: USAGE_COST + 1.1 * attempt });
  assert.equal(brain.calls, 2);
  near(meter.spentForTask('t1'), 2 * USAGE_COST);
  near(meter.spentForTask('t2'), USAGE_COST);
});

test('ошибки аргументов задачи — до запроса, code = bad_args', async (t) => {
  const { meter } = newMeter(t, { dailyLimitUsd: 1 });
  const brain = fakeBrain();
  const guard = createGuard({ brain, meter, model: MODEL });
  for (const args of [
    { taskBudgetUsd: 0.1 }, // бюджет без задачи проверить не по чему
    { taskId: 't1', taskBudgetUsd: -1 },
    { taskId: 't1', taskBudgetUsd: Number.NaN },
    { taskId: 't1', taskBudgetUsd: '0.1' },
    { taskId: 42 },
    { taskId: '' },
  ]) {
    await assert.rejects(guard.chat({ messages: MESSAGES, ...args }), (err) => err.code === 'bad_args', String(Object.values(args)));
  }
  assert.equal(brain.calls, 0);
  assert.equal(meter.reservedUsd, 0);
});

// ---- Резерв, аргументы, ответ ----

test('резерв в файле на время вызова; снимается и при успехе, и при ошибке', async (t) => {
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  const { attempt } = expected(MESSAGES);
  const result = { content: 'ok', reasoningContent: null, toolCalls: [] };
  const boom = Object.assign(new Error('сбой модели'), { code: 'http', status: 503 });
  const seen = [];
  let fail = false;
  const brain = fakeBrain({
    reply: async () => {
      seen.push(readState(file).pending);
      if (fail) throw boom;
      return result;
    },
  });
  const guard = createGuard({ brain, meter, model: MODEL });

  assert.equal(await guard.chat({ messages: MESSAGES, purpose: 'task', taskId: 't1' }), result);
  assert.deepEqual(readState(file).pending, []);
  fail = true;
  await assert.rejects(guard.chat({ messages: MESSAGES }), (err) => err === boom);
  assert.deepEqual(readState(file).pending, []);
  assert.equal(meter.reservedUsd, 0);

  // Во время вызова резерв попытки уже лежал в файле — с её суммой и счётом задачи.
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((p) => p.length), [1, 1]);
  near(seen[0][0].usd, attempt);
  assert.deepEqual([seen[0][0].purpose, seen[0][0].model, seen[0][0].taskId], ['task', MODEL, 't1']);
  near(seen[1][0].usd, attempt);
});

test('мозгу уходят аргументы вызова без taskBudgetUsd; maxTokens не выше maxOutputTokens; ответ без изменений', async (t) => {
  const { meter } = newMeter(t, { dailyLimitUsd: 1 });
  const result = { content: 'ok', reasoningContent: null, toolCalls: [] };
  Object.defineProperty(result, 'stats', { value: { attempts: 1 }, enumerable: false });
  const brain = fakeBrain({ reply: async () => result });
  const guard = createGuard({ brain, meter, model: MODEL });
  const signal = new AbortController().signal;

  const res = await guard.chat({
    messages: MESSAGES, tools: TOOLS, toolChoice: 'none', signal, purpose: 'mission', taskId: 't1', taskBudgetUsd: 0.25,
    maxTokens: 999999, // потолок вызывающего выше maxOutputTokens урезается до него
  });
  assert.equal(res, result);
  assert.equal(res.stats.attempts, 1);
  const args = brain.args[0];
  assert.equal(args.messages, MESSAGES);
  assert.equal(args.tools, TOOLS);
  assert.equal(args.toolChoice, 'none');
  assert.equal(args.signal, signal);
  assert.equal(args.purpose, 'mission');
  assert.equal(args.taskId, 't1');
  assert.equal('taskBudgetUsd' in args, false);
  assert.equal(args.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 4096);
  assert.equal(typeof args.onUsage, 'function');

  await guard.chat({ messages: MESSAGES });
  assert.equal(brain.args[1].purpose, 'chat', 'метка по умолчанию');
});

test('оценка: попытка — символы JSON {messages, tools} / 2 вверх и потолок выхода; вызов — попытка × 4', (t) => {
  const { meter } = newMeter(t);
  const guard = createGuard({ brain: fakeBrain(), meter, model: MODEL, maxOutputTokens: 1000 });
  const e = guard.estimate({ messages: MESSAGES, tools: TOOLS });
  assert.equal(e.inputTokens, Math.ceil(JSON.stringify({ messages: MESSAGES, tools: TOOLS }).length / 2));
  assert.equal(e.outputTokens, 1000);
  near(e.attemptUsd, expected(MESSAGES, TOOLS, 1000).attempt);
  near(e.usd, expected(MESSAGES, TOOLS, 1000).worst);
  const unpriced = createGuard({ brain: fakeBrain(), meter, model: UNPRICED }).estimate({ messages: MESSAGES });
  assert.deepEqual([unpriced.attemptUsd, unpriced.usd], [null, null]);
});

test('createGuard: без мозга, без счётчика или с негодным потолком — ошибка', (t) => {
  const { meter } = newMeter(t);
  assert.throws(() => createGuard({ meter, model: MODEL }), /brain/);
  assert.throws(() => createGuard({ brain: fakeBrain(), model: MODEL }), /meter/);
  assert.throws(() => createGuard({ brain: fakeBrain(), meter: { record() {} }, model: MODEL }), /meter/);
  for (const bad of [0, -1, 1.5, '4096', null]) {
    assert.throws(() => createGuard({ brain: fakeBrain(), meter, model: MODEL, maxOutputTokens: bad }), /maxOutputTokens/, String(bad));
  }
});

// ---- DeepSeekClient: maxTokens и onUsage на вызов ----

test('DeepSeekClient: maxTokens уходит полем max_tokens; без него поля нет; негодный — bad_args без запроса', async () => {
  const fetchImpl = scriptedFetch([OK]);
  const brain = client(fetchImpl);
  await brain.chat({ messages: MESSAGES, maxTokens: 512 });
  const body = JSON.parse(fetchImpl.bodies[0]);
  assert.equal(body.max_tokens, 512);
  assert.equal('maxTokens' in body, false);
  await brain.chat({ messages: MESSAGES });
  assert.equal('max_tokens' in JSON.parse(fetchImpl.bodies[1]), false);
  for (const bad of [0, -1, 1.5, '512', Number.NaN]) {
    await assert.rejects(brain.chat({ messages: MESSAGES, maxTokens: bad }), (err) => err.code === 'bad_args', String(bad));
  }
  assert.equal(fetchImpl.bodies.length, 2, 'с негодным потолком запросов нет');

  // Повтор без полей размышлений сохраняет потолок.
  const retry = scriptedFetch([REJECTED, OK]);
  await client(retry, { reasoning: 'off' }).chat({ messages: MESSAGES, maxTokens: 256 });
  assert.deepEqual(retry.bodies.map((b) => JSON.parse(b).max_tokens), [256, 256]);
});

test('DeepSeekClient: onUsage вызова заменяет конструкторный и получает usage', async () => {
  const fromCtor = [];
  const own = [];
  const fetchImpl = scriptedFetch([OK]);
  const brain = client(fetchImpl, { onUsage: (info) => fromCtor.push(info) });
  await brain.chat({ messages: MESSAGES, purpose: 'task', onUsage: (info) => own.push(info) });
  assert.equal(fromCtor.length, 0);
  assert.deepEqual(own, [{ model: MODEL, purpose: 'task', ok: true, usage: USAGE, requestChars: fetchImpl.bodies[0].length, attempts: 1 }]);
  assert.equal('onUsage' in JSON.parse(fetchImpl.bodies[0]), false);

  // Без хука вызова — конструкторный, как раньше. Не функция — не замена: учёт так не отключить.
  await brain.chat({ messages: MESSAGES });
  await brain.chat({ messages: MESSAGES, onUsage: null });
  assert.equal(fromCtor.length, 2);
  assert.equal(own.length, 1);
});

// ---- Страж + настоящий клиент: учёт каждой попытки ----

test('max_tokens от стража в теле запроса равен maxOutputTokens', async (t) => {
  const { meter } = newMeter(t, { dailyLimitUsd: 1 });
  const fetchImpl = scriptedFetch([OK]);
  const guard = createGuard({ brain: client(fetchImpl), meter, model: MODEL, maxOutputTokens: 1234 });
  await guard.chat({ messages: MESSAGES, tools: TOOLS, taskId: 't1', taskBudgetUsd: 0.25 });
  const body = JSON.parse(fetchImpl.bodies[0]);
  assert.equal(body.max_tokens, 1234);
  for (const key of ['maxTokens', 'onUsage', 'purpose', 'taskId', 'taskBudgetUsd']) assert.equal(key in body, false, key);
});

test('maxTokens вызывающего: потолок min(maxTokens, maxOutputTokens) — и в max_tokens, и в оценке, и в резерве', async (t) => {
  const cases = [
    { maxTokens: 1000, cap: 1000 },
    { maxTokens: 8192, cap: 4096 },
    { maxTokens: undefined, cap: 4096 },
  ];
  for (const { maxTokens, cap } of cases) {
    const label = `maxTokens ${maxTokens}`;
    const { attempt, worst } = expected(MESSAGES, undefined, cap);
    const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
    const reserved = [];
    const fetchImpl = scriptedFetch([{ status: 500, body: { error: { message: 'boom' } } }], () => reserved.push(meter.reservedUsd));
    const guard = createGuard({ brain: client(fetchImpl), meter, model: MODEL });
    const args = maxTokens === undefined ? { messages: MESSAGES } : { messages: MESSAGES, maxTokens };

    const e = guard.estimate(args);
    assert.equal(e.outputTokens, cap, label);
    near(e.attemptUsd, attempt);
    near(e.usd, worst);

    await assert.rejects(guard.chat(args), (err) => err.code === 'http' && err.status === 500);
    assert.equal(JSON.parse(fetchImpl.bodies[0]).max_tokens, cap, label);
    // Резерв попытки считан по этому потолку; неудачная попытка записана по нему же.
    near(reserved[0], attempt);
    near(readState(file).calls[0].costUsd, attempt);
  }

  // Проверка попытки — тоже по потолку вызывающего: с 1000 попытка помещается в остаток, с 4096 — нет.
  const { meter } = newMeter(t, { dailyLimitUsd: 0.001 });
  const brain = fakeBrain();
  const guard = createGuard({ brain, meter, model: MODEL });
  assert.ok(expected(MESSAGES, undefined, 1000).attempt < 0.001 && expected(MESSAGES).attempt > 0.001);
  await assert.rejects(guard.chat({ messages: MESSAGES }), (err) => err.code === 'budget' && err.scope === 'day');
  await guard.chat({ messages: MESSAGES, maxTokens: 1000 });
  assert.equal(brain.calls, 1);
  assert.equal(brain.args[0].maxTokens, 1000);
});

test('негодный maxTokens вызывающего — bad_args до запроса и резерва', async (t) => {
  const { meter } = newMeter(t, { dailyLimitUsd: 1 });
  const brain = fakeBrain();
  const guard = createGuard({ brain, meter, model: MODEL });
  for (const bad of [0, -1, 1.5, '1000', Number.NaN]) {
    await assert.rejects(guard.chat({ messages: MESSAGES, maxTokens: bad }), (err) => err.code === 'bad_args', String(bad));
  }
  assert.equal(brain.calls, 0);
  assert.equal(meter.reservedUsd, 0);
  // null — как «не передан»: потолок стража.
  await guard.chat({ messages: MESSAGES, maxTokens: null });
  assert.equal(brain.args[0].maxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
});

test('успешный ответ: onUsage стража получает usage, запись точная, конструкторный хук молчит', async (t) => {
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  const fromCtor = [];
  const fetchImpl = scriptedFetch([OK]);
  const guard = createGuard({ brain: client(fetchImpl, { onUsage: (info) => fromCtor.push(info) }), meter, model: MODEL });
  const res = await guard.chat({ messages: MESSAGES, purpose: 'mission' });
  assert.equal(res.content, 'готово');
  assert.equal(res.stats.attempts, 1, 'замеры клиента на месте');
  assert.equal(fromCtor.length, 0, 'учёт идёт одним путём — через стража');
  const calls = readState(file).calls;
  assert.deepEqual(calls.map((x) => [x.purpose, x.model, x.known]), [['mission', MODEL, true]]);
  near(calls[0].costUsd, USAGE_COST);
  near(meter.spentToday(), USAGE_COST);
  assert.equal(meter.reservedUsd, 0);
});

test('сеть падает дважды: две записи по верхней границе, резерв покрывает все попытки', async (t) => {
  const { attempt } = expected(MESSAGES);
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  const seen = [];
  const fetchImpl = scriptedFetch([new TypeError('fetch failed')], (n) => {
    seen.push({ n, reserved: meter.reservedUsd, spent: meter.spentToday(), pending: readState(file).pending.length });
  });
  const guard = createGuard({ brain: client(fetchImpl), meter, model: MODEL });
  await assert.rejects(guard.chat({ messages: MESSAGES, taskId: 't1' }), /fetch failed/);
  assert.equal(fetchImpl.bodies.length, 2);
  const calls = readState(file).calls;
  assert.deepEqual(calls.map((x) => [x.known, x.taskId]), [[false, 't1'], [false, 't1']]);
  near(calls[0].costUsd, attempt);
  near(calls[1].costUsd, attempt);
  near(meter.spentToday(), 2 * attempt);
  near(meter.spentForTask('t1'), 2 * attempt);
  assert.equal(meter.reservedUsd, 0);

  // На каждой попытке в файле ровно один резерв — её собственная сумма; записанное раньше в него не входит.
  assert.deepEqual(seen.map((s) => [s.n, s.pending]), [[1, 1], [2, 1]]);
  for (const s of seen) near(s.reserved, attempt);
  near(seen[1].spent, attempt);

  // Сбой, затем успех: первая попытка — по верхней границе, вторая — точно.
  const second = newMeter(t, { dailyLimitUsd: 1 });
  const flaky = scriptedFetch([new TypeError('fetch failed'), OK]);
  const res = await createGuard({ brain: client(flaky), meter: second.meter, model: MODEL }).chat({ messages: MESSAGES });
  assert.equal(res.stats.attempts, 2);
  const calls2 = readState(second.file).calls;
  assert.deepEqual(calls2.map((x) => x.known), [false, true]);
  near(calls2[0].costUsd, attempt);
  near(calls2[1].costUsd, USAGE_COST);
  near(second.meter.spentToday(), attempt + USAGE_COST);
});

test('худший случай DeepSeekClient — 4 HTTP-попытки: каждая проверена и зарезервирована отдельно, все записаны', async (t) => {
  const { attempt, worst } = expected(MESSAGES);
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  const net = new TypeError('fetch failed');
  const seen = [];
  // Сбой сети, отказ полей размышлений (400), затем без них — снова сбой и повтор. Пятой попытки нет.
  const fetchImpl = scriptedFetch([net, REJECTED, net, net], () => seen.push(meter.reservedUsd));
  const reserves = t.mock.method(meter, 'reserveWithin');
  const guard = createGuard({ brain: client(fetchImpl, { reasoning: 'off' }), meter, model: MODEL });
  await assert.rejects(guard.chat({ messages: MESSAGES }), /fetch failed/);
  assert.equal(fetchImpl.bodies.length, MAX_ATTEMPTS);
  assert.equal(reserves.mock.callCount(), MAX_ATTEMPTS, 'на каждую HTTP-попытку — своя проверка и резерв');
  for (const call of reserves.mock.calls) near(call.arguments[0], attempt);
  const calls = readState(file).calls;
  assert.deepEqual(calls.map((x) => x.known), [false, false, false, false]);
  near(meter.spentToday(), 4 * attempt);
  assert.ok(meter.spentToday() <= worst + 1e-12, 'записанное не больше худшего случая');
  for (const reserved of seen) near(reserved, attempt);
  assert.equal(meter.reservedUsd, 0);
});

test('ответ 500 без usage: запись по верхней границе, ошибка уходит наверх', async (t) => {
  const { attempt } = expected(MESSAGES);
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  const fetchImpl = scriptedFetch([{ status: 500, body: { error: { message: 'boom' } } }]);
  const guard = createGuard({ brain: client(fetchImpl), meter, model: MODEL });
  await assert.rejects(guard.chat({ messages: MESSAGES }), (err) => err.code === 'http' && err.status === 500);
  assert.equal(fetchImpl.bodies.length, 1);
  const calls = readState(file).calls;
  assert.deepEqual(calls.map((x) => [x.purpose, x.known]), [['chat', false]]);
  near(calls[0].costUsd, attempt);
  near(meter.spentToday(), attempt);
  assert.equal(meter.reservedUsd, 0);
});

test('отмена во время запроса: попытка записана по верхней границе, резерв снят', async (t) => {
  const { attempt } = expected(MESSAGES);
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const guard = createGuard({ brain: client(hang), meter, model: MODEL });
  const controller = new AbortController();
  const pending = guard.chat({ messages: MESSAGES, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  const calls = readState(file).calls;
  assert.deepEqual(calls.map((x) => x.known), [false]);
  near(calls[0].costUsd, attempt);
  assert.equal(meter.reservedUsd, 0);
});

test('процесс упал посреди вызова: новый Meter переводит резерв в расход дня и задачи', async (t) => {
  const { attempt } = expected(MESSAGES);
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const controller = new AbortController();
  const guard = createGuard({ brain: client(hang), meter, model: MODEL });
  const inFlight = guard.chat({ messages: MESSAGES, purpose: 'task', taskId: 't1', signal: controller.signal });
  assert.equal(readState(file).pending.length, 1, 'резерв записан до запроса');

  // «Перезапуск»: новый Meter на том же файле, старый вызов так и не закончился.
  const restarted = new Meter({ file, dailyLimitUsd: 1, now: clock(2026, 10, 30) });
  near(restarted.spentToday(), attempt);
  near(restarted.spentForTask('t1'), attempt);
  assert.equal(restarted.reservedUsd, 0);
  const last = readState(file).calls.at(-1);
  assert.deepEqual([last.known, last.interrupted, last.taskId, last.purpose], [false, true, 't1', 'task']);

  // Старый вызов доживает: его release ничего не ломает.
  controller.abort();
  await assert.rejects(inFlight, (err) => err.name === 'AbortError');
  assert.equal(restarted.reservedUsd, 0);
});

test('учёт по задаче через стража: в файле и виден новому Meter после перезапуска', async (t) => {
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  const guard = createGuard({ brain: client(scriptedFetch([OK])), meter, model: MODEL });
  await guard.chat({ messages: MESSAGES, purpose: 'task', taskId: 't1', taskBudgetUsd: 0.25 });
  await guard.chat({ messages: MESSAGES, purpose: 'task', taskId: 't1', taskBudgetUsd: 0.25 });

  const state = readState(file);
  near(state.byTask.t1, 2 * USAGE_COST);
  assert.deepEqual(state.calls.map((x) => [x.purpose, x.taskId, x.known]), [['task', 't1', true], ['task', 't1', true]]);

  // Новый процесс — новый Meter на том же файле: суммы те же, бюджет задачи считается от них.
  const restarted = new Meter({ file, dailyLimitUsd: 1, now: clock(2026, 10, 30) });
  near(restarted.spentForTask('t1'), 2 * USAGE_COST);
  near(restarted.spentToday(), 2 * USAGE_COST);
  const brain = fakeBrain();
  const again = createGuard({ brain, meter: restarted, model: MODEL });
  const { attempt } = expected(MESSAGES);
  await assert.rejects(
    again.chat({ messages: MESSAGES, taskId: 't1', taskBudgetUsd: 2 * USAGE_COST + 0.5 * attempt }),
    (err) => err.code === 'budget' && err.scope === 'task',
  );
  assert.equal(brain.calls, 0);
});

test('точный повтор текстового ответа чата берётся из краткого кеша без второго расхода', async (t) => {
  const { meter } = newMeter(t, { dailyLimitUsd: 1 });
  const brain = fakeBrain();
  const guard = createGuard({ brain, meter, model: MODEL });
  const request = { messages: MESSAGES, tools: [], toolChoice: 'none' };
  const first = await guard.chat(request);
  const spent = meter.spentToday();
  const second = await guard.chat(request);
  assert.equal(first.content, second.content);
  assert.equal(brain.calls, 1);
  assert.equal(meter.spentToday(), spent);
  assert.equal(meter.reservedUsd, 0);
});

test('запись учёта не удалась: резерв остаётся в файле и после перезапуска становится расходом', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { attempt } = expected(MESSAGES);
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  meter.record = () => { throw new Error('диск занят'); };
  const guard = createGuard({ brain: client(scriptedFetch([OK])), meter, model: MODEL });
  const res = await guard.chat({ messages: MESSAGES, taskId: 't1' });
  assert.equal(res.content, 'готово');
  near(meter.reservedUsd, attempt);
  near(meter.remainingToday(), 1 - attempt);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(errors.mock.calls[0].arguments[0], /не записана.*диск занят/);

  const restarted = new Meter({ file, dailyLimitUsd: 1, now: clock(2026, 10, 30) });
  near(restarted.spentToday(), attempt);
  near(restarted.spentForTask('t1'), attempt);
  assert.equal(restarted.reservedUsd, 0);
});

// ---- Проверка перед каждой HTTP-попыткой ----

test('beforeAttempt: вызывается перед каждой HTTP-попыткой; бросок — запроса нет, ошибка наверх', async () => {
  const seen = [];
  const fetchImpl = scriptedFetch([new TypeError('fetch failed'), OK]);
  const ok = await client(fetchImpl).chat({ messages: MESSAGES, beforeAttempt: (info) => seen.push(info) });
  assert.equal(ok.stats.attempts, 2);
  assert.deepEqual(seen, [{ attempt: 1, purpose: 'chat' }, { attempt: 2, purpose: 'chat' }]);

  const boom = Object.assign(new Error('нет бюджета'), { code: 'budget' });
  const refused = scriptedFetch([OK]);
  await assert.rejects(
    client(refused).chat({ messages: MESSAGES, beforeAttempt: () => { throw boom; } }),
    (err) => err === boom,
  );
  assert.equal(refused.bodies.length, 0, 'запроса не было');

  // Сбой и повтор: проверка повтора бросает — в сеть повтор не уходит.
  const failing = scriptedFetch([new TypeError('fetch failed'), OK]);
  let n = 0;
  await assert.rejects(
    client(failing).chat({ messages: MESSAGES, beforeAttempt: () => { n += 1; if (n === 2) throw boom; } }),
    (err) => err === boom,
  );
  assert.equal(failing.bodies.length, 1, 'повтор без проверки не отправлен');
});

// Стоп во время запроса: запрос прерван, попытка записана по верхней границе, резерв снят, повтора нет.
test('стоп во время запроса: новых HTTP-попыток нет, стоимость попытки записана, резерв закрыт', async (t) => {
  const { file, meter } = newMeter(t, { dailyLimitUsd: 1 });
  const controller = new AbortController();
  const fetchImpl = async (url, init) => {
    fetchImpl.bodies.push(init.body);
    controller.abort(); // стоп пришёл, пока запрос в полёте
    throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' });
  };
  fetchImpl.bodies = [];
  const { attempt } = expected(MESSAGES);
  const guard = createGuard({ brain: client(fetchImpl), meter, model: MODEL });
  await assert.rejects(guard.chat({ messages: MESSAGES, signal: controller.signal, taskId: 't1' }), /fetch failed/);
  assert.equal(fetchImpl.bodies.length, 1, 'повтор после стопа не отправлен: одна HTTP-попытка');
  const calls = readState(file).calls;
  assert.deepEqual(calls.map((x) => [x.known, x.taskId]), [[false, 't1']], 'попытка записана по верхней границе');
  near(calls[0].costUsd, attempt);
  assert.equal(meter.reservedUsd, 0, 'резерв закрыт');
});
