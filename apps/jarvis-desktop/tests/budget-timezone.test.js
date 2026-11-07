'use strict';

// Часовой пояс бюджета budgetTimezone: день счётчиков — по поясу IANA (по умолчанию Asia/Dushanbe, UTC+5),
// а не по поясу машины. Миграция файла прежней версии (date — местная дата машины, Asia/Bishkek, UTC+6):
// расход не обнуляется, резервы не освобождаются, переходный день считается консервативно.
// Фикстуры budget.json собираются здесь, во временной папке: данные владельца (data\) не используются.

// Пояс машины владельца. Задаётся до первого обращения к датам: прежняя логика «местной даты» видна в тестах
// на любой машине. node --test запускает каждый файл в своём процессе, другим тестам это не мешает.
process.env.TZ = 'Asia/Bishkek';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Meter, parseTimezone, dateIn, MAX_CALLS, DEFAULT_BUDGET_TIMEZONE } = require('../src/cost/meter');
const { createGuard } = require('../src/cost/guard');
const { createRuntime } = require('../src/tasks/runtime');

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const HOUR = 60 * 60 * 1000;
// (10000 × 0.20 + 0 × 0.006 + 0 × 0.60) / 1e6 = 0.002 USD
const USAGE = { promptTokens: 10000, cachedTokens: 0, completionTokens: 0 };
const USAGE_COST = 0.002;

function near(actual, expected, msg) {
  assert.equal(typeof actual, 'number', `ожидалось число, получено ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ? `${msg}: ` : ''}${actual} ≠ ${expected}`);
}

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-budget-tz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'budget.json');
}

// Момент по стенным часам Душанбе (UTC+5) и Бишкека (UTC+6).
const dsh = (y, m, d, h, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi) - 5 * HOUR);
const bsk = (y, m, d, h, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi) - 6 * HOUR);

function clockAt(date) {
  const c = { at: date };
  c.now = () => new Date(c.at.getTime());
  return c;
}

function call(at, costUsd, extra = {}) {
  return { ts: at.toISOString(), purpose: 'chat', model: MODEL, costUsd, known: costUsd !== null, ...extra };
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Резерв живого чужого процесса (родитель — запускатель тестов): переводить в расход его нельзя, снимать — тоже.
function liveReserve(id, usd, at, extra = {}) {
  return { id, usd, ts: at.toISOString(), purpose: 'task', model: MODEL, pid: process.ppid, ...extra };
}

function quiet(t) {
  return t.mock.method(console, 'warn', () => {});
}

test('пояс машины в этом файле — Asia/Bishkek, а по умолчанию бюджет — Asia/Dushanbe', () => {
  assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Bishkek');
  assert.equal(DEFAULT_BUDGET_TIMEZONE, 'Asia/Dushanbe');
  // 23:30 Душанбе = 00:30 Бишкека следующего дня.
  const at = dsh(2026, 10, 31, 23, 30);
  assert.equal(dateIn(at, 'Asia/Dushanbe'), '2026-10-31');
  assert.equal(dateIn(at, 'Asia/Bishkek'), '2026-11-01');
  assert.equal(at.getDate(), 1, 'местная дата машины — уже 1-е');
});

test('budgetTimezone: по умолчанию Asia/Dushanbe; не IANA — понятная ошибка, а не тихое значение по умолчанию', (t) => {
  const file = tmpFile(t);
  assert.equal(new Meter({ file }).timezone, 'Asia/Dushanbe');
  assert.equal(new Meter({ file, timezone: null }).timezone, 'Asia/Dushanbe');
  // Пустая настройка — «не задана», как пустой лимит: Asia/Dushanbe.
  assert.equal(new Meter({ file, timezone: '' }).timezone, 'Asia/Dushanbe');
  assert.equal(new Meter({ file, timezone: '   ' }).timezone, 'Asia/Dushanbe');
  assert.equal(new Meter({ file, timezone: 'Asia/Dushanbe' }).timezone, 'Asia/Dushanbe');
  assert.equal(new Meter({ file, timezone: 'asia/dushanbe' }).timezone, 'Asia/Dushanbe', 'имя приводится к каноническому');
  assert.equal(parseTimezone('UTC'), 'UTC');
  fs.rmSync(file, { force: true });
  for (const bad of ['Foo/Bar', 'Dushanbe', '+05:00', '-0500', '5', 5, true, {}, []]) {
    assert.throws(() => new Meter({ file, timezone: bad }), /budgetTimezone.*IANA.*Asia\/Dushanbe/, String(bad));
  }
  assert.equal(fs.existsSync(file), false, 'при ошибке пояса файл учёта не создан');
});

test('budgetTimezone через createRuntime: передаётся в Meter; негодный пояс — ошибка при старте', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-budget-tz-rt-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const opts = {
    brain: { model: MODEL, async chat() { return { content: '' }; } },
    model: MODEL,
    tasksFile: path.join(base, 'data', 'tasks.json'),
    budgetFile: path.join(base, 'data', 'budget.json'),
    sandboxRoot: root,
    dailyLimitUsd: 1,
    toolRegistry: { get: () => undefined, list: () => [] },
    approvals: { request: async () => 'deny', respond: () => {} },
    stop: { isStopped: () => false, onTrigger: () => () => {} },
    resolve: (rel) => path.resolve(root, rel),
    now: () => dsh(2026, 10, 31, 12).getTime(),
  };
  assert.throws(() => createRuntime({ ...opts, budgetTimezone: 'Душанбе' }), /budgetTimezone.*IANA/);
  assert.throws(() => createRuntime({ ...opts, budgetTimezone: '+05:00' }), /budgetTimezone.*IANA/);

  const byDefault = createRuntime(opts);
  t.after(() => byDefault.close && byDefault.close());
  assert.equal(byDefault.meter.timezone, 'Asia/Dushanbe', 'настройки нет — Asia/Dushanbe');
  const set = createRuntime({ ...opts, budgetFile: path.join(base, 'data', 'budget-utc.json'), budgetTimezone: 'UTC' });
  t.after(() => set.close && set.close());
  assert.equal(set.meter.timezone, 'UTC');
});

test('новый файл: день считается по Asia/Dushanbe, а не по местной дате машины (Asia/Bishkek)', (t) => {
  const file = tmpFile(t);
  const c = clockAt(dsh(2026, 10, 31, 22, 0));
  const meter = new Meter({ file, dailyLimitUsd: 1, now: c.now });
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  assert.equal(readState(file).date, '2026-10-31');
  assert.equal(readState(file).timezone, 'Asia/Dushanbe');

  // 23:30 Душанбе: в Бишкеке уже 1 ноября, но день бюджета тот же — расход не обнулён.
  c.at = dsh(2026, 10, 31, 23, 30);
  near(meter.spentToday(), USAGE_COST, '23:30 Душанбе — тот же день');
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  near(meter.spentToday(), 2 * USAGE_COST);
  assert.equal(readState(file).date, '2026-10-31');

  // Полночь Душанбе — новый день.
  c.at = dsh(2026, 11, 1, 0, 5);
  assert.equal(meter.spentToday(), 0);
  assert.equal(meter.accountingStatus().transitional, false);
  assert.equal(meter.accountingStatus().note, null);
});

test('миграция старого файла (без timezone): записи 23:00–24:00 Душанбе = 00:00–01:00 Бишкека; день пересчитан консервативно', (t) => {
  const warns = quiet(t);
  const file = tmpFile(t);
  // Старый код (местная дата Бишкека) в 00:40 Бишкека 1 ноября обнулил день и записал один вызов в 00:30.
  // Вызов днём 31-го (09:00 Душанбе) в его сумму 1 ноября не входит, но по Душанбе это тот же день, что и 00:30 Бишкека.
  const legacy = {
    date: '2026-11-01',
    spentUsd: 0.02,
    unknownCalls: 0,
    byTask: { t1: 0.52 },
    pending: [liveReserve('r-live', 0.07, bsk(2026, 11, 1, 0, 35), { taskId: 't1' })],
    calls: [
      call(dsh(2026, 10, 31, 9, 0), 0.5, { taskId: 't1' }),
      call(bsk(2026, 11, 1, 0, 30), 0.02, { taskId: 't1' }), // = 23:30 Душанбе 31-го
    ],
  };
  writeJson(file, legacy);
  const before = fs.readFileSync(file, 'utf8');

  const c = clockAt(dsh(2026, 10, 31, 23, 45)); // = 00:45 Бишкека 1 ноября
  const meter = new Meter({ file, dailyLimitUsd: 1, now: c.now });

  // Расход не обнулён и не занижен: по старому дню 0.02, по новому (пересчёт журнала) 0.52 → берётся 0.52.
  near(meter.spentToday(), 0.52, 'переходный день — большая из сумм');
  // Резерв живого процесса не освобождён и по-прежнему уменьшает остаток.
  near(meter.reservedUsd, 0.07, 'резерв на месте');
  near(meter.remainingToday(), 1 - 0.52 - 0.07);
  near(meter.spentForTask('t1'), 0.52, 'счёт задачи не тронут');

  // Миграция записана сразу; формат прежний плюс поля timezone и transition; журнал и резерв — как были.
  assert.notEqual(fs.readFileSync(file, 'utf8'), before);
  const state = readState(file);
  assert.equal(state.timezone, 'Asia/Dushanbe');
  assert.equal(state.date, '2026-10-31');
  near(state.spentUsd, 0.52);
  assert.deepEqual(state.pending, legacy.pending);
  assert.deepEqual(state.calls, legacy.calls);
  assert.deepEqual(state.byTask, legacy.byTask);
  assert.deepEqual(state.transition, {
    fromTimezone: 'Asia/Bishkek',
    legacy: true,
    oldDate: '2026-11-01',
    oldSpentUsd: 0.02,
    journalUsd: 0.52,
    journalComplete: true,
    date: '2026-10-31',
    until: dsh(2026, 11, 1, 0, 0).toISOString(),
  });

  // Ограничение показано явно — и в статусе, и в журнале запуска.
  const status = meter.accountingStatus();
  assert.equal(status.transitional, true);
  assert.equal(status.timezone, 'Asia/Dushanbe');
  assert.equal(status.until, dsh(2026, 11, 1, 0, 0).toISOString());
  assert.equal(status.note, 'переходный день: учёт по консервативной оценке до 24:00 по Asia/Dushanbe');
  assert.equal(warns.mock.callCount(), 1);
  assert.match(warns.mock.calls[0].arguments[0], /переходный день: учёт по консервативной оценке до 24:00 по Asia\/Dushanbe/);

  // Перезапуск: миграция не повторяется и сумму не меняет.
  near(new Meter({ file, dailyLimitUsd: 1, now: c.now }).spentToday(), 0.52);
  assert.equal(warns.mock.callCount(), 1, 'второй раз не мигрирует');
  near(meter.reservedUsd, 0.07);

  // Новый расход в переходный день добавляется к консервативной сумме.
  c.at = dsh(2026, 10, 31, 23, 50);
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  near(meter.spentToday(), 0.52 + USAGE_COST);
  assert.equal(meter.release('r-live'), true, 'резерв снимается только своим release');

  // После перехода — обычный учёт в новом поясе: полночь Душанбе (01:00 Бишкека) — новый день, пометки нет.
  c.at = dsh(2026, 11, 1, 0, 10);
  assert.equal(meter.spentToday(), 0);
  assert.equal(meter.accountingStatus().transitional, false);
  meter.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  assert.equal(readState(file).date, '2026-11-01');
  assert.equal('transition' in readState(file), false);
  // 23:30 Душанбе 1-го = 00:30 Бишкека 2-го: день тот же, расход дня на месте.
  c.at = dsh(2026, 11, 1, 23, 30);
  near(meter.spentToday(), USAGE_COST);
  near(meter.spentForTask('t1'), 0.52, 'счёт задачи пережил смену дня');
});

test('миграция: старый день включал 23:00–24:00 Душанбе прошлого дня — сумма старого дня сохраняется целиком', (t) => {
  quiet(t);
  const file = tmpFile(t);
  // День Бишкека 31-го = с 23:00 Душанбе 30-го. Вызовы 23:20 и 23:40 Душанбе 30-го — в старой сумме.
  writeJson(file, {
    date: '2026-10-31',
    spentUsd: 0.4,
    unknownCalls: 1,
    byTask: {},
    pending: [
      liveReserve('r-live', 0.05, dsh(2026, 10, 31, 11, 0)),
      // Резерв без pid (процесс упал): становится расходом, а не исчезает.
      { id: 'r-dead', usd: 0.03, ts: dsh(2026, 10, 31, 11, 30).toISOString(), purpose: 'task', model: MODEL },
    ],
    calls: [
      call(dsh(2026, 10, 30, 23, 20), 0.3),
      call(dsh(2026, 10, 30, 23, 40), null),
      call(dsh(2026, 10, 31, 10, 0), 0.1),
    ],
  });
  const c = clockAt(dsh(2026, 10, 31, 12, 0));
  const meter = new Meter({ file, dailyLimitUsd: 1, legacyTimezone: 'Asia/Bishkek', now: c.now });

  // Пересчёт по Душанбе дал бы 0.10, старый день — 0.40: берётся 0.40; плюс упавший резерв 0.03 как расход.
  near(meter.spentToday(), 0.4 + 0.03, 'большая из сумм + прерванный резерв');
  assert.equal(meter.unknownCallsToday(), 1, 'неизвестные вызовы тоже по большей оценке');
  near(meter.reservedUsd, 0.05, 'живой резерв не освобождён');
  near(meter.remainingToday(), 1 - 0.43 - 0.05);
  assert.deepEqual(readState(file).pending.map((p) => p.id), ['r-live']);
  const settled = readState(file).calls.at(-1);
  assert.equal(settled.interrupted, true);
  assert.equal(settled.costUsd, 0.03);
  assert.equal(meter.accountingStatus().note, 'переходный день: учёт по консервативной оценке до 24:00 по Asia/Dushanbe');

  // Отказ по дню в переходный день говорит об ограничении.
  const r = meter.reserveWithin(0.6, { purpose: 'chat', model: MODEL });
  assert.equal(r.ok, false);
  assert.equal(r.scope, 'day');
  assert.match(r.note, /переходный день: учёт по консервативной оценке до 24:00 по Asia\/Dushanbe/);
});

test('миграция: журнал полон (MAX_CALLS) и начинается внутри дня — пересчёт ненадёжен, это видно в статусе', (t) => {
  quiet(t);
  const file = tmpFile(t);
  const calls = [];
  for (let i = 0; i < MAX_CALLS; i += 1) calls.push(call(new Date(dsh(2026, 10, 31, 1, 0).getTime() + i * 60000), 0.001));
  writeJson(file, { date: '2026-10-31', spentUsd: 0.05, unknownCalls: 0, calls });
  const meter = new Meter({ file, legacyTimezone: 'Asia/Bishkek', now: clockAt(dsh(2026, 10, 31, 12, 0)).now });
  near(meter.spentToday(), MAX_CALLS * 0.001, 'по журналу больше — берётся журнал');
  const status = meter.accountingStatus();
  assert.equal(status.transitional, true);
  assert.match(status.note, /^переходный день: учёт по консервативной оценке до 24:00 по Asia\/Dushanbe \(журнал вызовов неполон/);
  assert.equal(readState(file).transition.journalComplete, false);
});

test('миграция: старый день давно закончился — день с нуля, но резервы и счета задач переносятся', (t) => {
  quiet(t);
  const file = tmpFile(t);
  writeJson(file, {
    date: '2026-10-29',
    spentUsd: 0.9,
    unknownCalls: 3,
    byTask: { t1: 0.9 },
    pending: [liveReserve('r-live', 0.04, dsh(2026, 10, 29, 12, 0))],
    calls: [call(dsh(2026, 10, 29, 12, 0), 0.9, { taskId: 't1' })],
  });
  const meter = new Meter({ file, dailyLimitUsd: 1, legacyTimezone: 'Asia/Bishkek', now: clockAt(dsh(2026, 10, 31, 12, 0)).now });
  assert.equal(meter.spentToday(), 0);
  assert.equal(meter.unknownCallsToday(), 0);
  near(meter.reservedUsd, 0.04);
  near(meter.spentForTask('t1'), 0.9);
  assert.equal(meter.accountingStatus().transitional, false);
  assert.equal(readState(file).timezone, 'Asia/Dushanbe');
});

test('старый файл без timezone, пояс машины совпал с поясом бюджета: считается как раньше, пояс дописан', (t) => {
  const warns = quiet(t);
  const file = tmpFile(t);
  writeJson(file, { date: '2026-10-31', spentUsd: 0.5, unknownCalls: 2, calls: [] });
  const meter = new Meter({ file, legacyTimezone: 'Asia/Dushanbe', now: clockAt(dsh(2026, 10, 31, 12, 0)).now });
  assert.equal(meter.spentToday(), 0.5);
  assert.equal(meter.unknownCallsToday(), 2);
  assert.equal(meter.accountingStatus().transitional, false);
  assert.equal(readState(file).timezone, 'Asia/Dushanbe');
  assert.equal(warns.mock.callCount(), 0);
});

test('смена пояса в новом файле (timezone: Asia/Bishkek → Asia/Dushanbe) — те же правила, legacy: false', (t) => {
  quiet(t);
  const file = tmpFile(t);
  const c = clockAt(bsk(2026, 10, 31, 12, 0));
  const old = new Meter({ file, timezone: 'Asia/Bishkek', now: c.now });
  old.record({ purpose: 'chat', model: MODEL, usage: USAGE });
  assert.equal(readState(file).timezone, 'Asia/Bishkek');
  const meter = new Meter({ file, timezone: 'Asia/Dushanbe', now: c.now });
  near(meter.spentToday(), USAGE_COST);
  assert.equal(readState(file).transition.legacy, false);
  assert.equal(readState(file).transition.fromTimezone, 'Asia/Bishkek');
});

test('битый пояс в файле — поломка с блоком, а не тихий пересчёт', (t) => {
  t.mock.method(console, 'error', () => {});
  // Пустой пояс в файле — тоже поломка: «по умолчанию» бывает только у настройки, не у записанного учёта.
  for (const timezone of ['Foo/Bar', '', '  ', null, 5]) {
    const file = tmpFile(t);
    writeJson(file, { date: '2026-10-31', timezone, spentUsd: 0.5, unknownCalls: 0, calls: [] });
    const meter = new Meter({ file, now: clockAt(dsh(2026, 10, 31, 12, 0)).now });
    assert.equal(meter.blockedReason(), 'файл учёта повреждён — лимит не обеспечен', String(timezone));
  }
});

test('страж: отказ по дневному лимиту в переходный день называет ограничение', async (t) => {
  quiet(t);
  const file = tmpFile(t);
  writeJson(file, { date: '2026-11-01', spentUsd: 0.02, unknownCalls: 0, calls: [call(dsh(2026, 10, 31, 9, 0), 0.999)] });
  const meter = new Meter({ file, dailyLimitUsd: 1, legacyTimezone: 'Asia/Bishkek', now: clockAt(dsh(2026, 10, 31, 23, 45)).now });
  const brain = { model: MODEL, async chat() { throw new Error('вызова быть не должно'); } };
  const guard = createGuard({ brain, meter, model: MODEL });
  await assert.rejects(guard.chat({ messages: [{ role: 'user', content: 'привет' }] }), (err) => {
    assert.equal(err.code, 'budget');
    assert.equal(err.scope, 'day');
    assert.match(err.reason, /^дневной лимит: остаток \$0\.001, .*; переходный день: учёт по консервативной оценке до 24:00 по Asia\/Dushanbe$/);
    return true;
  });
});
