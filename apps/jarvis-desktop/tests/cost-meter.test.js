'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PRICES, priceFor } = require('../src/cost/prices');
const { Meter, costOf, MAX_CALLS } = require('../src/cost/meter');
const { DeepSeekClient } = require('../src/brain/deepseek');

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const UNPRICED = 'vendor/unpriced-model';
const PRICE = { inputPerM: 0.20, cachedPerM: 0.006, outputPerM: 0.60 };

// 6000 вход без кэша, 4000 из кэша, 2000 выход (500 из них — размышления):
// (6000 × 0.20 + 4000 × 0.006 + 2000 × 0.60) / 1e6 = 0.002424 USD.
const USAGE = { promptTokens: 10000, cachedTokens: 4000, completionTokens: 2000, reasoningTokens: 500 };
const USAGE_COST = 0.002424;

function near(actual, expected) {
  assert.equal(typeof actual, 'number', `ожидалось число, получено ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cost-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Часы по стенному времени пояса бюджета по умолчанию (Asia/Dushanbe, UTC+5, без летнего времени):
// дата счётчиков не зависит от часового пояса машины.
const DUSHANBE_OFFSET_MS = 5 * 60 * 60 * 1000;
function clock(y, m, d, h = 12, min = 0) {
  const c = {};
  c.set = (y2, m2, d2, h2 = 12, min2 = 0) => { c.at = new Date(Date.UTC(y2, m2 - 1, d2, h2, min2, 0) - DUSHANBE_OFFSET_MS); };
  c.now = () => new Date(c.at.getTime());
  c.set(y, m, d, h, min);
  return c;
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Только ставки записи цены: кроме них в записи есть modelId, source и checkedAt.
function rates(price) {
  return { inputPerM: price.inputPerM, cachedPerM: price.cachedPerM, outputPerM: price.outputPerM };
}

test('цены: у модели по умолчанию списочная цена DeepInfra, неизвестная модель → null', () => {
  assert.deepEqual(rates(priceFor(MODEL)), PRICE);
  assert.equal(PRICES[MODEL], priceFor(MODEL));
  assert.equal(priceFor(UNPRICED), null);
  assert.equal(priceFor(undefined), null);
  // Запись null и неполная запись — цена неизвестна.
  assert.equal(priceFor('x', { x: null }), null);
  assert.equal(priceFor('x', { x: { inputPerM: 1, outputPerM: 2 } }), null);
  assert.equal(priceFor('x', { x: { inputPerM: 1, cachedPerM: -1, outputPerM: 2 } }), null);
  // Ключи прототипа ценой не считаются.
  assert.equal(priceFor('constructor'), null);
  assert.equal(priceFor('__proto__'), null);
});

test('цены: в записи modelId, source и checkedAt; цена только для точного ID', (t) => {
  const price = priceFor(MODEL);
  assert.deepEqual(Object.keys(price).sort(), ['cachedPerM', 'checkedAt', 'inputPerM', 'modelId', 'outputPerM', 'source']);
  assert.equal(price.modelId, MODEL);
  assert.equal(price.checkedAt, '2026-10-30');
  assert.match(price.source, /^https:\/\/deepinfra\.com\/deepseek-ai\/DeepSeek-V4\.1-Flash-1017 /);
  assert.ok(Object.isFrozen(price));

  // Похожие ID ценой не считаются: лимит для них не обеспечен.
  const meter = new Meter({ file: path.join(tmpDir(t), 'cost.json') });
  for (const id of [
    'deepseek-ai/deepseek-v4.1-flash-1017',
    ` ${MODEL}`,
    `${MODEL} `,
    'DeepSeek-V4.1-Flash-1017',
    'deepseek-ai/DeepSeek-V4.1-Flash',
    `${MODEL}:free`,
    'deepseek-ai/DeepSeek-V4.1-Pro-1017',
  ]) {
    assert.equal(priceFor(id), null, id);
    assert.equal(meter.enforceable(id), false, id);
  }

  // Ключ таблицы и modelId записи обязаны совпадать; запись без modelId ценой не считается.
  const rate = { inputPerM: 1, cachedPerM: 0.5, outputPerM: 2 };
  assert.deepEqual(priceFor('x', { x: { ...rate, modelId: 'x' } }), { ...rate, modelId: 'x' });
  assert.equal(priceFor('x', { x: { ...rate, modelId: 'y' } }), null);
  assert.equal(priceFor('x', { x: rate }), null);
});

test('costOf считает по цене модели; reasoningTokens повторно не добавляются', () => {
  near(costOf(USAGE, priceFor(MODEL)), USAGE_COST);
  near(costOf({ ...USAGE, reasoningTokens: 0 }, priceFor(MODEL)), USAGE_COST);
  // Без кэша весь вход по полной цене: (10000 × 0.20 + 2000 × 0.60) / 1e6.
  near(costOf({ ...USAGE, cachedTokens: 0 }, PRICE), 0.0032);
  // Настоящий ноль токенов — ноль долларов, а не «неизвестно».
  assert.equal(costOf({ promptTokens: 0, cachedTokens: 0, completionTokens: 0 }, PRICE), 0);
});

test('costOf без цены или без нужного поля → null, а не ноль', () => {
  assert.equal(costOf(USAGE, null), null);
  assert.equal(costOf(USAGE, priceFor(UNPRICED)), null);
  assert.equal(costOf(USAGE, { inputPerM: 0.2, outputPerM: 0.6 }), null);
  assert.equal(costOf(null, PRICE), null);
  assert.equal(costOf({ ...USAGE, cachedTokens: null }, PRICE), null);
  assert.equal(costOf({ ...USAGE, cachedTokens: undefined }, PRICE), null);
  assert.equal(costOf({ cachedTokens: 0, completionTokens: 10 }, PRICE), null);
  assert.equal(costOf({ promptTokens: 10, cachedTokens: 0, completionTokens: null }, PRICE), null);
  // Из кэша больше, чем всего на входе, — данные противоречивы.
  assert.equal(costOf({ promptTokens: 10, cachedTokens: 11, completionTokens: 0 }, PRICE), null);
});

test('учёт за день: точные стоимости суммируются, неизвестные считаются отдельно', (t) => {
  const file = path.join(tmpDir(t), 'cost.json');
  const c = clock(2026, 10, 30);
  const meter = new Meter({ file, now: c.now });
  assert.equal(meter.spentToday(), 0);
  assert.equal(fs.existsSync(file), false, 'чтение файл не создаёт');

  const first = meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  assert.equal(first.known, true);
  near(first.costUsd, USAGE_COST);
  meter.record({ purpose: 'task', model: MODEL, usage: USAGE });
  const unknown = meter.record({ purpose: 'chat', model: UNPRICED, usage: USAGE });
  assert.deepEqual(unknown, { costUsd: null, known: false });

  near(meter.spentToday(), 2 * USAGE_COST);
  assert.equal(meter.unknownCallsToday(), 1);

  const state = readState(file);
  assert.equal(state.date, '2026-10-30');
  near(state.spentUsd, 2 * USAGE_COST);
  assert.equal(state.unknownCalls, 1);
  assert.equal(state.calls.length, 3);
  assert.deepEqual(Object.keys(state.calls[0]).sort(), ['costUsd', 'known', 'model', 'purpose', 'ts']);
  assert.deepEqual(state.calls.map((x) => x.purpose), ['chat', 'task', 'chat']);
  assert.deepEqual(state.calls[2], { ts: c.at.toISOString(), purpose: 'chat', model: UNPRICED, costUsd: null, known: false });

  // Другой экземпляр на том же файле видит те же суммы.
  near(new Meter({ file, now: c.now }).spentToday(), 2 * USAGE_COST);
});

test('смена даты в поясе бюджета обнуляет счётчики, журнал вызовов остаётся', (t) => {
  const file = path.join(tmpDir(t), 'cost.json');
  const c = clock(2026, 10, 30, 23, 50);
  const meter = new Meter({ file, dailyLimitUsd: 0.004, now: c.now });
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  meter.record({ purpose: 'chat', model: UNPRICED, usage: USAGE });
  near(meter.spentToday(), USAGE_COST);
  assert.equal(meter.unknownCallsToday(), 1);

  c.set(2026, 10, 31, 0, 5);
  assert.equal(meter.spentToday(), 0);
  assert.equal(meter.unknownCallsToday(), 0);
  assert.equal(meter.remainingToday(), 0.004);

  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  const state = readState(file);
  assert.equal(state.date, '2026-10-31');
  near(state.spentUsd, USAGE_COST);
  assert.equal(state.unknownCalls, 0);
  assert.equal(state.calls.length, 3);
});

test('canSpend: цена неизвестна → лимит не обеспечен; лимит не задан → можно', (t) => {
  const file = path.join(tmpDir(t), 'cost.json');
  const meter = new Meter({ file, dailyLimitUsd: 10 });
  assert.equal(meter.enforceable(UNPRICED), false);
  assert.deepEqual(meter.canSpend(UNPRICED, 0.001), { ok: false, reason: 'цена модели неизвестна — лимит не обеспечен' });
  assert.equal(meter.enforceable(MODEL), true);
  assert.deepEqual(meter.canSpend(MODEL, 0.001), { ok: true, reason: null });

  const unlimited = new Meter({ file });
  assert.equal(unlimited.remainingToday(), null);
  assert.deepEqual(unlimited.canSpend(MODEL, 1000), { ok: true, reason: null });
  assert.equal(unlimited.canSpend(UNPRICED, 0).ok, false);
});

test('canSpend: дневной лимит исчерпан', (t) => {
  const file = path.join(tmpDir(t), 'cost.json');
  const meter = new Meter({ file, dailyLimitUsd: 0.003 });
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  near(meter.remainingToday(), 0.003 - USAGE_COST);
  assert.deepEqual(meter.canSpend(MODEL, 0.0005), { ok: true, reason: null });
  assert.deepEqual(meter.canSpend(MODEL, 0.001), { ok: false, reason: 'дневной лимит исчерпан' });

  // Перерасход: остаток не уходит в минус, и даже вызов без оценки запрещён.
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  assert.equal(meter.remainingToday(), 0);
  assert.deepEqual(meter.canSpend(MODEL, 0), { ok: false, reason: 'дневной лимит исчерпан' });
  assert.equal(meter.canSpend(MODEL).ok, false);
});

test('лимит: строка из .env читается, пустая строка — без лимита, мусор — ошибка', (t) => {
  const file = path.join(tmpDir(t), 'cost.json');
  assert.equal(new Meter({ file, dailyLimitUsd: '0.5' }).dailyLimitUsd, 0.5);
  assert.equal(new Meter({ file, dailyLimitUsd: '' }).remainingToday(), null);
  assert.throws(() => new Meter({ file, dailyLimitUsd: 'много' }), /дневной лимит/);
  assert.throws(() => new Meter({ file, dailyLimitUsd: -1 }), /дневной лимит/);
  assert.throws(() => new Meter({}), /путь к файлу/);
});

test('usage: null → верхняя граница по pessimisticTokens, known: false', (t) => {
  const file = path.join(tmpDir(t), 'cost.json');
  const meter = new Meter({ file });
  const pessimisticTokens = { inputTokens: 10000, outputTokens: 2000 };
  const failed = meter.record({ purpose: 'chat', model: MODEL, usage: null, pessimisticTokens });
  assert.equal(failed.known, false);
  // Весь вход по цене без кэша: (10000 × 0.20 + 2000 × 0.60) / 1e6.
  near(failed.costUsd, 0.0032);
  // Граница не ниже стоимости любого настоящего ответа в этих пределах.
  assert.ok(failed.costUsd >= costOf(USAGE, PRICE));
  assert.ok(failed.costUsd >= costOf({ promptTokens: 10000, cachedTokens: 0, completionTokens: 2000 }, PRICE));
  near(meter.spentToday(), 0.0032);
  assert.equal(meter.unknownCallsToday(), 0);

  // Неполный usage (нет cachedTokens): граница по его же счётчикам, а не по пессимистичной оценке.
  const partial = meter.record({
    purpose: 'chat',
    model: MODEL,
    usage: { ...USAGE, cachedTokens: null },
    pessimisticTokens: { inputTokens: 50000, outputTokens: 8000 },
  });
  assert.equal(partial.known, false);
  near(partial.costUsd, 0.0032);

  // Оценить не по чему или цена неизвестна — costUsd: null, растёт unknownCalls.
  assert.deepEqual(meter.record({ purpose: 'chat', model: MODEL, usage: null }), { costUsd: null, known: false });
  assert.deepEqual(meter.record({ purpose: 'chat', model: UNPRICED, usage: null, pessimisticTokens }), { costUsd: null, known: false });
  near(meter.spentToday(), 0.0064);
  assert.equal(meter.unknownCallsToday(), 2);
  assert.deepEqual(readState(file).calls.map((x) => x.known), [false, false, false, false]);
});

test('запись атомарная: временных файлов не остаётся, журнал ограничен MAX_CALLS', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'cost.json');
  const meter = new Meter({ file });
  for (let i = 0; i < MAX_CALLS + 5; i += 1) {
    meter.record({ purpose: `call-${i}`, model: MODEL, usage: USAGE });
  }
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  const state = readState(file);
  assert.equal(state.calls.length, MAX_CALLS);
  assert.equal(state.calls[0].purpose, 'call-5');
  assert.equal(state.calls[MAX_CALLS - 1].purpose, `call-${MAX_CALLS + 4}`);
  near(state.spentUsd, (MAX_CALLS + 5) * USAGE_COST);
});

test('сбой rename: исходный файл цел, временный файл удалён', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'cost.json');
  const meter = new Meter({ file });
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  const before = fs.readFileSync(file, 'utf8');

  t.mock.method(fs, 'renameSync', () => { throw new Error('диск занят'); });
  assert.throws(() => meter.record({ purpose: 'chat', model: MODEL, usage: USAGE }), /диск занят/);
  t.mock.restoreAll();

  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('битый файл не сбрасывает счёт: копия в .corrupt-<время>, учёт заблокирован до решения человека', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'cost.json');
  const errors = t.mock.method(console, 'error', () => {});
  const c = clock(2026, 10, 30);
  const meter = new Meter({ file, dailyLimitUsd: 1, now: c.now });
  const corrupt = () => fs.readdirSync(dir).filter((name) => name.startsWith('cost.json.corrupt-')).sort();
  const BLOCKED = { ok: false, reason: 'файл учёта повреждён — лимит не обеспечен' };

  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  const broken = '{"date":"2026-10-30","spentUsd":0.9,';
  fs.writeFileSync(file, broken, 'utf8');
  assert.deepEqual(meter.canSpend(MODEL, 0.001), BLOCKED);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(errors.mock.calls[0].arguments[0], /повреждён.*заблокирован/);
  assert.equal(corrupt().length, 1);
  assert.equal(fs.readFileSync(path.join(dir, corrupt()[0]), 'utf8'), broken);
  // На месте основного файла — пометка блокировки, а не «осознанный ноль».
  assert.equal(readState(file).blocked.corruptFile, corrupt()[0]);
  assert.equal(meter.blockedReason(), BLOCKED.reason);
  assert.equal(meter.enforceable(MODEL), false);
  assert.equal(meter.remainingToday(), 0);

  // Расход после поломки всё равно пишется, а блок остаётся.
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  near(meter.spentToday(), USAGE_COST);
  assert.deepEqual(meter.canSpend(MODEL, 0), BLOCKED);
  // Ни перезапуск, ни новая дата блок не снимают.
  assert.deepEqual(new Meter({ file, dailyLimitUsd: 1, now: c.now }).canSpend(MODEL, 0), BLOCKED);
  c.set(2026, 10, 31);
  assert.deepEqual(meter.canSpend(MODEL, 0), BLOCKED);

  // JSON верный, структура нет: тоже поломка; прежняя копия не перезаписывается.
  fs.writeFileSync(file, '{"date":"2026-10-31","spentUsd":"много"}', 'utf8');
  assert.deepEqual(meter.canSpend(MODEL, 0), BLOCKED);
  assert.equal(corrupt().length, 2);
  assert.equal(fs.readFileSync(path.join(dir, corrupt()[0]), 'utf8'), broken);

  // Пустой файл — тоже поломка: счёт потерян, а не равен нулю.
  fs.writeFileSync(file, '', 'utf8');
  assert.deepEqual(meter.canSpend(MODEL, 0), BLOCKED);
  assert.equal(corrupt().length, 3);
  assert.equal(errors.mock.callCount(), 3);

  // Файла нет — осознанный ноль: человек проверил копию и удалил файл.
  fs.rmSync(file);
  assert.equal(meter.blockedReason(), null);
  assert.equal(meter.spentToday(), 0);
  assert.deepEqual(meter.canSpend(MODEL, 0.001), { ok: true, reason: null });
  assert.equal(errors.mock.callCount(), 3);
});

// ---- Резервы вызовов в полёте ----

test('резерв: пишется в pending файла, снимается по id; остаток = лимит − потрачено − резервы', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'cost.json');
  const meter = new Meter({ file, dailyLimitUsd: 0.01, now: clock(2026, 10, 30).now });
  assert.equal(meter.reservedUsd, 0);

  const a = meter.reserve(0.003, { purpose: 'task', model: MODEL, taskId: 't1' });
  const b = meter.reserve(0.0011);
  assert.equal(typeof a, 'string');
  assert.notEqual(a, b);
  // Резерв уже в файле: он переживёт падение процесса.
  assert.deepEqual(readState(file).pending.map((p) => [p.id, p.usd, p.purpose, p.taskId]), [[a, 0.003, 'task', 't1'], [b, 0.0011, null, undefined]]);
  near(meter.reservedUsd, 0.0041);
  near(meter.remainingToday(), 0.01 - 0.0041);
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  near(meter.spentToday(), USAGE_COST);
  near(meter.remainingToday(), 0.01 - USAGE_COST - 0.0041);
  // canSpend тоже видит резервы: 0.004 уже не помещается.
  assert.equal(meter.canSpend(MODEL, 0.004).ok, false);

  assert.equal(meter.release(a), true);
  assert.equal(meter.release(b), true);
  assert.equal(meter.reservedUsd, 0);
  assert.deepEqual(readState(file).pending, []);
  near(meter.remainingToday(), 0.01 - USAGE_COST);
  assert.equal(meter.release(a), false, 'повторно снимать нечего');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);

  // Резерв больше остатка: остаток не уходит в минус.
  const big = meter.reserve(1);
  assert.equal(meter.remainingToday(), 0);
  meter.release(big);

  // Лимит не задан: остатка нет, резерв всё равно виден.
  const unlimited = new Meter({ file });
  const half = unlimited.reserve(0.5);
  assert.equal(unlimited.remainingToday(), null);
  assert.equal(unlimited.reservedUsd, 0.5);
  unlimited.release(half);
});

test('резерв: негодная сумма или id — ошибка', (t) => {
  const meter = new Meter({ file: path.join(tmpDir(t), 'cost.json') });
  for (const bad of [-1, Number.NaN, Infinity, '0.1', null, undefined]) {
    assert.throws(() => meter.reserve(bad), /резерв/, String(bad));
  }
  for (const bad of [undefined, null, 0.001, '']) {
    assert.throws(() => meter.release(bad), /id резерва/, String(bad));
  }
  assert.equal(meter.reservedUsd, 0);
});

test('незакрытый резерв после перезапуска — расход по верхней границе, known: false, в счёт задачи', (t) => {
  const file = path.join(tmpDir(t), 'cost.json');
  const c = clock(2026, 10, 30);
  const meter = new Meter({ file, dailyLimitUsd: 1, now: c.now });
  meter.record({ purpose: 'task', model: MODEL, usage: USAGE, taskId: 't1' });
  const id = meter.reserve(0.01, { purpose: 'task', model: MODEL, taskId: 't1' });
  near(meter.remainingToday(), 1 - USAGE_COST - 0.01);

  // Процесс упал посреди запроса: release не случился. Новый Meter на том же файле.
  const restarted = new Meter({ file, dailyLimitUsd: 1, now: c.now });
  near(restarted.spentToday(), USAGE_COST + 0.01);
  near(restarted.spentForTask('t1'), USAGE_COST + 0.01);
  assert.equal(restarted.reservedUsd, 0);
  near(restarted.remainingToday(), 1 - USAGE_COST - 0.01);
  const state = readState(file);
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.calls.at(-1), {
    ts: c.at.toISOString(), purpose: 'task', model: MODEL, costUsd: 0.01, known: false, taskId: 't1', interrupted: true,
  });

  // Старому экземпляру снимать уже нечего: release не падает и сумму не уменьшает.
  assert.equal(meter.release(id), false);
  near(restarted.spentToday(), USAGE_COST + 0.01);
  // Следующий перезапуск ничего не добавляет.
  near(new Meter({ file, now: c.now }).spentToday(), USAGE_COST + 0.01);
});

// ---- Учёт по задачам ----

test('учёт по задаче: суммы в byTask, переживают перезапуск и смену даты', (t) => {
  const file = path.join(tmpDir(t), 'cost.json');
  const c = clock(2026, 10, 30, 23, 50);
  const meter = new Meter({ file, now: c.now });
  const BOUND = 0.0032; // (10000 × 0.20 + 2000 × 0.60) / 1e6
  assert.equal(meter.spentForTask('t1'), 0);

  meter.record({ purpose: 'task', model: MODEL, usage: USAGE, taskId: 't1' });
  meter.record({ purpose: 'task', model: MODEL, usage: null, pessimisticTokens: { inputTokens: 10000, outputTokens: 2000 }, taskId: 't1' });
  meter.record({ purpose: 'task', model: MODEL, usage: USAGE, taskId: 't2' });
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  // Неизвестная стоимость в счёт задачи не входит: её отмечает unknownCalls.
  meter.record({ purpose: 'task', model: UNPRICED, usage: USAGE, taskId: 't1' });

  near(meter.spentForTask('t1'), USAGE_COST + BOUND);
  near(meter.spentForTask('t2'), USAGE_COST);
  assert.equal(meter.spentForTask('t3'), 0);
  assert.equal(meter.spentForTask(undefined), 0);
  assert.equal(meter.unknownCallsToday(), 1);
  near(meter.spentToday(), 3 * USAGE_COST + BOUND);

  const state = readState(file);
  assert.deepEqual(Object.keys(state.byTask).sort(), ['t1', 't2']);
  near(state.byTask.t1, USAGE_COST + BOUND);
  assert.deepEqual(state.calls.map((x) => x.taskId), ['t1', 't1', 't2', undefined, 't1']);
  assert.equal('taskId' in state.calls[3], false, 'без задачи поля нет');

  // Перезапуск: новый экземпляр на том же файле видит те же суммы.
  near(new Meter({ file, now: c.now }).spentForTask('t1'), USAGE_COST + BOUND);

  // Новая дата: дневной счёт с нуля, счёт задачи остаётся и растёт дальше.
  c.set(2026, 10, 31, 0, 5);
  assert.equal(meter.spentToday(), 0);
  near(meter.spentForTask('t1'), USAGE_COST + BOUND);
  meter.record({ purpose: 'task', model: MODEL, usage: USAGE, taskId: 't1' });
  near(new Meter({ file, now: c.now }).spentForTask('t1'), 2 * USAGE_COST + BOUND);
  near(meter.spentToday(), USAGE_COST);
});

test('учёт по задаче: ID вроде __proto__ — обычный ключ; длинный ID везде обрезается одинаково', (t) => {
  const file = path.join(tmpDir(t), 'cost.json');
  const meter = new Meter({ file });
  meter.record({ purpose: 'task', model: MODEL, usage: USAGE, taskId: '__proto__' });
  meter.record({ purpose: 'task', model: MODEL, usage: USAGE, taskId: 'constructor' });
  near(meter.spentForTask('__proto__'), USAGE_COST);
  near(meter.spentForTask('constructor'), USAGE_COST);
  assert.equal(meter.spentForTask('toString'), 0);
  near(new Meter({ file }).spentForTask('__proto__'), USAGE_COST);

  const long = 'x'.repeat(300);
  meter.record({ purpose: 'task', model: MODEL, usage: USAGE, taskId: long });
  near(meter.spentForTask(long), USAGE_COST);
  assert.equal(readState(file).calls[2].taskId.length, 128);
});

test('файл прежней версии без byTask и pending читается; битые byTask или pending — поломка с блоком', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'cost.json');
  const c = clock(2026, 10, 30);
  fs.writeFileSync(file, JSON.stringify({ date: '2026-10-30', spentUsd: 0.5, unknownCalls: 2, calls: [] }), 'utf8');
  const meter = new Meter({ file, now: c.now });
  assert.equal(meter.spentToday(), 0.5);
  assert.equal(meter.unknownCallsToday(), 2);
  assert.equal(meter.spentForTask('t1'), 0);
  assert.equal(meter.reservedUsd, 0);
  assert.equal(meter.blockedReason(), null);
  meter.record({ purpose: 'task', model: MODEL, usage: USAGE, taskId: 't1' });
  near(readState(file).byTask.t1, USAGE_COST);
  near(meter.spentToday(), 0.5 + USAGE_COST);

  const errors = t.mock.method(console, 'error', () => {});
  const corrupt = () => fs.readdirSync(dir).filter((name) => name.startsWith('cost.json.corrupt-'));
  const broken = [
    { byTask: { t1: 'много' } }, { byTask: { t1: -1 } }, { byTask: [1] }, { byTask: null },
    { pending: {} }, { pending: [{ id: 'r1', usd: -1 }] }, { pending: [{ usd: 0.1 }] },
  ];
  for (const extra of broken) {
    fs.writeFileSync(file, JSON.stringify({ date: '2026-10-30', spentUsd: 0.5, unknownCalls: 0, calls: [], ...extra }), 'utf8');
    assert.equal(meter.blockedReason(), 'файл учёта повреждён — лимит не обеспечен', JSON.stringify(extra));
  }
  assert.equal(errors.mock.callCount(), broken.length);
  assert.equal(corrupt().length, broken.length);
});

// ---- Хук onUsage в DeepSeekClient ----

const RAW_USAGE = {
  prompt_tokens: 10000,
  completion_tokens: 2000,
  prompt_tokens_details: { cached_tokens: 4000 },
  completion_tokens_details: { reasoning_tokens: 500 },
};
const OK = { status: 200, body: { choices: [{ message: { content: 'готово' } }], usage: RAW_USAGE } };

// Фейковый fetch по сценарию: Error — сбой сети, {status, body} — ответ сервера.
function scriptedFetch(steps) {
  const bodies = [];
  const fn = async (url, init) => {
    bodies.push(init.body);
    const step = steps[Math.min(bodies.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    const text = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
    return { ok: step.status >= 200 && step.status < 300, status: step.status, text: async () => text };
  };
  fn.bodies = bodies;
  return fn;
}

function hookedClient(fetchImpl, extra = {}) {
  const infos = [];
  const client = new DeepSeekClient({
    baseUrl: 'https://api.example/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl,
    timeoutMs: 5000,
    onUsage: (info) => infos.push(info),
    ...extra,
  });
  return { client, infos };
}

test('onUsage: успешный ответ даёт usage, purpose и номер попытки; purpose не уходит в запрос', async () => {
  const fetchImpl = scriptedFetch([OK]);
  const { client, infos } = hookedClient(fetchImpl);
  const res = await client.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'task' });
  assert.equal(res.content, 'готово');
  assert.deepEqual(infos, [{
    model: 'm',
    purpose: 'task',
    ok: true,
    usage: { promptTokens: 10000, cachedTokens: 4000, completionTokens: 2000, reasoningTokens: 500 },
    requestChars: fetchImpl.bodies[0].length,
    attempts: 1,
  }]);
  assert.equal(res.stats.attempts, 1);
  assert.equal(res.stats.promptTokens, 10000);
  assert.equal('purpose' in JSON.parse(fetchImpl.bodies[0]), false);

  await client.chat({ messages: [] });
  assert.equal(infos[1].purpose, 'chat', 'метка по умолчанию');
});

test('onUsage: ответ 500 без usage → ok: false, usage: null, без повтора', async () => {
  const fetchImpl = scriptedFetch([{ status: 500, body: { error: { message: 'boom' } } }]);
  const { client, infos } = hookedClient(fetchImpl);
  await assert.rejects(client.chat({ messages: [] }), (err) => err.code === 'http' && err.status === 500);
  assert.equal(fetchImpl.bodies.length, 1);
  assert.deepEqual(infos, [{ model: 'm', purpose: 'chat', ok: false, usage: null, requestChars: fetchImpl.bodies[0].length, attempts: 1 }]);
});

test('onUsage: сетевая ошибка и повтор — по вызову на каждую попытку', async () => {
  const fetchImpl = scriptedFetch([new TypeError('fetch failed'), OK]);
  const { client, infos } = hookedClient(fetchImpl);
  const res = await client.chat({ messages: [{ role: 'user', content: 'привет' }] });
  assert.equal(res.content, 'готово');
  assert.equal(res.stats.attempts, 2);
  assert.deepEqual(infos.map((x) => [x.ok, x.usage === null, x.attempts]), [[false, true, 1], [true, false, 2]]);
  assert.equal(infos[1].usage.completionTokens, 2000);

  // Оба раза сеть упала: обе попытки учтены, ошибка уходит наверх.
  const failing = scriptedFetch([new TypeError('fetch failed')]);
  const second = hookedClient(failing);
  await assert.rejects(second.client.chat({ messages: [] }), /fetch failed/);
  assert.deepEqual(second.infos.map((x) => [x.ok, x.usage, x.attempts]), [[false, null, 1], [false, null, 2]]);
});

test('onUsage: таймаут учитывается как попытка без usage', async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const { client, infos } = hookedClient(hang, { timeoutMs: 20 });
  await assert.rejects(client.chat({ messages: [] }), (err) => err.code === 'timeout');
  assert.deepEqual(infos.map((x) => [x.ok, x.usage, x.attempts]), [[false, null, 1]]);
});

test('отмена во время паузы перед повтором: второй запрос не отправляется', async () => {
  const fetchImpl = scriptedFetch([new TypeError('fetch failed')]);
  const { client, infos } = hookedClient(fetchImpl);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(client.chat({ messages: [], signal: controller.signal }), (err) => err.name === 'AbortError');
  assert.equal(fetchImpl.bodies.length, 1);
  assert.equal(infos.length, 1);
});

test('ошибка в onUsage не ломает вызов модели', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const client = new DeepSeekClient({
    baseUrl: 'https://api.example/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: scriptedFetch([OK]),
    onUsage: () => { throw new Error('учёт сломан'); },
  });
  const res = await client.chat({ messages: [] });
  assert.equal(res.content, 'готово');
  assert.equal(errors.mock.callCount(), 1);
  assert.match(errors.mock.calls[0].arguments[0], /учёт сломан/);
});

test('onUsage → Meter: отвергнутая попытка по верхней границе, успешная точно', async (t) => {
  const file = path.join(tmpDir(t), 'cost.json');
  const meter = new Meter({ file, dailyLimitUsd: 1, now: clock(2026, 10, 30).now });
  const OUTPUT_CAP = 4000;
  const fetchImpl = scriptedFetch([{ status: 400, body: { error: { message: 'unknown field reasoning_effort' } } }, OK]);
  const client = new DeepSeekClient({
    baseUrl: 'https://api.example/v1',
    apiKey: 'k',
    model: MODEL,
    fetchImpl,
    reasoning: 'off',
    onUsage: (info) => meter.record({
      purpose: info.purpose,
      model: info.model,
      usage: info.usage,
      pessimisticTokens: { inputTokens: info.requestChars, outputTokens: OUTPUT_CAP },
    }),
  });

  // Повтор без полей размышлений — тоже отдельная платная попытка.
  const res = await client.chat({ messages: [{ role: 'user', content: 'привет' }], purpose: 'mission' });
  assert.equal(res.stats.reasoning, 'off-rejected');
  assert.equal(res.stats.attempts, 2);

  const bound = (fetchImpl.bodies[0].length * 0.20 + OUTPUT_CAP * 0.60) / 1e6;
  const calls = readState(file).calls;
  assert.deepEqual(calls.map((x) => [x.purpose, x.model, x.known]), [['mission', MODEL, false], ['mission', MODEL, true]]);
  near(calls[0].costUsd, bound);
  near(calls[1].costUsd, USAGE_COST);
  near(meter.spentToday(), bound + USAGE_COST);
  near(meter.remainingToday(), 1 - bound - USAGE_COST);
});

// ---- Два процесса на одном файле учёта ----

test('два процесса на одном файле: остаток дня не занимается дважды, записи расхода не теряются', { timeout: 60000 }, async (t) => {
  const { execFile, spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-meter-proc-'));
  const children = [];
  t.after(() => {
    for (const c of children) c.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'budget.json');
  const meterPath = path.join(__dirname, '..', 'src', 'cost', 'meter.js');
  const MODEL_ID = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
  const script = (mode) => `
    const { Meter } = require(${JSON.stringify(meterPath)});
    const m = new Meter({ file: ${JSON.stringify(file)}, dailyLimitUsd: 0.035 });
    let granted = 0;
    if (${JSON.stringify(mode)} === 'reserve') {
      for (let i = 0; i < 60; i += 1) if (m.reserveWithin(0.01, { purpose: 'test' }).ok) granted += 1;
      // Процесс остаётся живым, пока родитель не закроет stdin: иначе завершившийся процесс считается упавшим,
      // и его резервы становятся расходом раньше, чем второй процесс успел зарезервировать.
      process.stdout.write(JSON.stringify({ granted }) + '\\n');
      process.stdin.resume();
    } else {
      for (let i = 0; i < 120; i += 1) {
        m.record({ purpose: 'test', model: ${JSON.stringify(MODEL_ID)}, usage: { promptTokens: 1000, cachedTokens: 0, completionTokens: 0 } });
      }
      process.stdout.write(JSON.stringify({ granted }));
    }
  `;
  const run = (mode) => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script(mode)], (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
  const reserver = () => {
    const child = spawn(process.execPath, ['-e', script('reserve')]);
    children.push(child);
    const ready = new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
        if (out.includes('\n')) resolve(JSON.parse(out));
      });
      child.on('exit', (code) => reject(new Error(`процесс резерва завершился раньше времени, код ${code}`)));
    });
    return { child, ready };
  };

  // Фаза 1: оба процесса резервируют и живы, пока оба не закончат. Лимит 0.035 — ровно три резерва по 0.01, не четыре.
  const first = reserver();
  const second = reserver();
  const [a, b] = await Promise.all([first.ready, second.ready]);
  assert.equal(a.granted + b.granted, 3, `резервов всего ${a.granted + b.granted}, должно быть 3`);
  const afterReserve = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(afterReserve.pending.length, 3, 'ни один резерв не потерян');
  // Только теперь процессы завершаются: их резервы станут расходом при следующем запуске.
  const exited = (child) => new Promise((resolve) => child.once('exit', resolve));
  const done = Promise.all([exited(first.child), exited(second.child)]);
  first.child.stdin.end();
  second.child.stdin.end();
  await done;
  assert.equal(fs.existsSync(`${file}.lock`), false, 'замок снят');

  // Фаза 2: оба процесса пишут записи расхода одновременно. Каждая запись — 1000 входных токенов по $0.20/млн = $0.0002.
  // Новый процесс переводит прежние незакрытые резервы в расход (по $0.01 каждый). Итог — точная сумма.
  await Promise.all([run('record'), run('record')]);
  const total = new Meter({ file, dailyLimitUsd: 0.035 });
  const expected = 0.03 + 240 * 0.0002;
  assert.ok(Math.abs(total.spentToday() - expected) < 1e-9, `расход ${total.spentToday()} ≠ ${expected}: запись потеряна`);
  assert.equal(total.reservedUsd, 0);
});
