'use strict';

// Миграция файла учёта на пояс бюджета: резервная копия до первой записи, один замок с остальными записями,
// признак миграции в файле, атомарность при сбое, суммы и резервы не уменьшаются, сбой блокирует платные вызовы,
// тело файла не уходит наружу. Все файлы — во временной папке: данные владельца (data\) не используются.

process.env.TZ = 'Asia/Bishkek';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Meter, MIGRATION_CODE } = require('../src/cost/meter');
const { createGuard } = require('../src/cost/guard');
const { taskCostSummary } = require('../src/cost/summary');

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const HOUR = 60 * 60 * 1000;
const USAGE = { promptTokens: 10000, cachedTokens: 0, completionTokens: 0 }; // $0.002
const METER_PATH = path.join(__dirname, '..', 'src', 'cost', 'meter.js');

// Момент по стенным часам Душанбе (UTC+5) и Бишкека (UTC+6).
const dsh = (y, m, d, h, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi) - 5 * HOUR);
const bsk = (y, m, d, h, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi) - 6 * HOUR);
const AT = dsh(2026, 10, 31, 23, 45); // = 00:45 Бишкека 1 ноября
const nowAt = (d) => () => new Date(d.getTime());

// Уникальные значения: по ним видно, утекло ли тело файла в текст ошибки.
const SECRET_TASK = 'zz-secret-task-91';
const SECRET_PURPOSE = 'zz-secret-purpose-77';
const SECRET_RESERVE = 'r-zz-live-5531';
const SECRET_SPENT = 0.123457;

function near(actual, expected, msg) {
  assert.equal(typeof actual, 'number', `ожидалось число, получено ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ? `${msg}: ` : ''}${actual} ≠ ${expected}`);
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-budget-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function call(at, costUsd, extra = {}) {
  return { ts: at.toISOString(), purpose: 'chat', model: MODEL, costUsd, known: costUsd !== null, ...extra };
}

// Файл прежней версии (без timezone): дата — местная дата Бишкека. Резерв живого процесса (этот тест-процесс
// для дочерних, родитель запускателя — для своего), который миграция не должна ни снять, ни перевести в расход.
function legacyState(pid = process.ppid) {
  return {
    date: '2026-11-01',
    spentUsd: SECRET_SPENT,
    unknownCalls: 1,
    byTask: { [SECRET_TASK]: 0.6 },
    pending: [{ id: SECRET_RESERVE, usd: 0.07, ts: bsk(2026, 11, 1, 0, 35).toISOString(), purpose: SECRET_PURPOSE, model: MODEL, pid, taskId: SECRET_TASK }],
    calls: [
      call(dsh(2026, 10, 31, 9, 0), 0.4, { taskId: SECRET_TASK, purpose: SECRET_PURPOSE }),
      call(bsk(2026, 11, 1, 0, 30), 0.2, { taskId: SECRET_TASK }),
    ],
  };
}

function writeLegacy(dir, state = legacyState()) {
  const file = path.join(dir, 'budget.json');
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  return { file, original: fs.readFileSync(file) };
}

const backups = (dir) => fs.readdirSync(dir).filter((n) => /^budget\.json\.pre-tz-.*\.bak$/.test(n)).sort();
const readState = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function quiet(t) {
  return { warn: t.mock.method(console, 'warn', () => {}), error: t.mock.method(console, 'error', () => {}) };
}

function assertNoLeak(text, what) {
  for (const secret of [SECRET_TASK, SECRET_PURPOSE, SECRET_RESERVE, String(SECRET_SPENT)]) {
    assert.equal(String(text).includes(secret), false, `${what} содержит значение из budget.json: ${secret}`);
  }
}

test('миграция: копия исходного файла создаётся до записи основного, под замком учёта; имя — время и старый пояс', (t) => {
  quiet(t);
  const dir = tmpDir(t);
  const { file, original } = writeLegacy(dir);
  const realRename = fs.renameSync;
  const realCopy = fs.copyFileSync;
  const seen = [];
  t.mock.method(fs, 'copyFileSync', (...args) => {
    seen.push({ op: 'copy', lock: fs.existsSync(`${file}.lock`), main: fs.readFileSync(file).equals(original) });
    return realCopy.apply(fs, args);
  });
  t.mock.method(fs, 'renameSync', (src, dest) => {
    if (path.resolve(dest) === path.resolve(file)) {
      seen.push({ op: 'main', lock: fs.existsSync(`${file}.lock`), backups: backups(dir).length });
    }
    return realRename.call(fs, src, dest);
  });

  new Meter({ file, dailyLimitUsd: 1, legacyTimezone: 'Asia/Bishkek', now: nowAt(AT) });

  assert.deepEqual(seen, [
    { op: 'copy', lock: true, main: true },
    { op: 'main', lock: true, backups: 1 },
  ], 'сначала копия нетронутого файла, затем запись основного; обе — под budget.json.lock');
  const [bak] = backups(dir);
  assert.equal(bak, `budget.json.pre-tz-${AT.toISOString().replace(/[:.]/g, '-')}-from-Asia_Bishkek.bak`);
  assert.ok(fs.readFileSync(path.join(dir, bak)).equals(original), 'копия байт в байт равна исходному файлу');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['budget.json', bak].sort(), 'временных файлов и замка не осталось');
  const state = readState(file);
  assert.equal(state.timezone, 'Asia/Dushanbe', 'признак миграции — пояс в файле');
  assert.equal(state.transition.fromTimezone, 'Asia/Bishkek');
});

test('миграция: повторный запуск не мигрирует второй раз — признак в файле, копия одна, файл тот же', (t) => {
  const { warn } = quiet(t);
  const dir = tmpDir(t);
  const { file } = writeLegacy(dir);
  const first = new Meter({ file, dailyLimitUsd: 1, legacyTimezone: 'Asia/Bishkek', now: nowAt(AT) });
  const afterFirst = fs.readFileSync(file, 'utf8');
  assert.equal(warn.mock.callCount(), 1, 'о переходе сказано один раз');
  near(first.spentToday(), 0.6);

  const second = new Meter({ file, dailyLimitUsd: 1, legacyTimezone: 'Asia/Bishkek', now: nowAt(AT) });
  // Даже если пояс машины потом сменится — файл с поясом бюджета уже не толкуется заново.
  const third = new Meter({ file, dailyLimitUsd: 1, legacyTimezone: 'UTC', now: nowAt(new Date(AT.getTime() + 60000)) });
  assert.equal(backups(dir).length, 1, 'вторая копия не создана');
  assert.equal(warn.mock.callCount(), 1, 'второй раз не мигрирует');
  assert.equal(fs.readFileSync(file, 'utf8'), afterFirst, 'файл после повторных запусков не изменился');
  const state = readState(file);
  assert.equal(state.timezone, 'Asia/Dushanbe');
  assert.equal(state.transition.oldDate, '2026-11-01');
  near(state.transition.oldSpentUsd, SECRET_SPENT);
  near(second.spentToday(), 0.6);
  near(third.spentToday(), 0.6);
});

test('миграция: копия не создана — основной файл не пишется, учёт заблокирован, вызова модели нет', async (t) => {
  const { warn, error } = quiet(t);
  const dir = tmpDir(t);
  const { file, original } = writeLegacy(dir);
  t.mock.method(fs, 'copyFileSync', () => {
    throw Object.assign(new Error('EACCES: permission denied, copyfile'), { code: 'EACCES' });
  });
  const meter = new Meter({ file, dailyLimitUsd: 1, legacyTimezone: 'Asia/Bishkek', now: nowAt(AT) });

  assert.ok(fs.readFileSync(file).equals(original), 'основной файл не изменён');
  assert.deepEqual(fs.readdirSync(dir), ['budget.json'], 'ни копии, ни временных файлов, ни замка');
  const reason = meter.blockedReason();
  assert.match(reason, /^миграция часового пояса учёта не записана \(резервная копия: EACCES\); исходный файл не изменён; резервная копия: не создана — лимит не обеспечен$/);
  assert.equal(meter.canSpend(MODEL, 0).ok, false);
  assert.equal(meter.enforceable(MODEL), false);
  assert.equal(meter.remainingToday(), 0);
  assert.deepEqual(meter.reserveWithin(0.001, { purpose: 'chat', model: MODEL }), { ok: false, scope: 'meter', reason });
  assert.throws(() => meter.record({ purpose: 'chat', model: MODEL, usage: USAGE }), (err) => err.code === MIGRATION_CODE);
  assert.ok(fs.readFileSync(file).equals(original), 'и после попытки записи файл не изменён');
  assert.equal(warn.mock.callCount(), 0, 'о переходе не сказано: он не записан');
  assert.equal(error.mock.callCount(), 1);
  assertNoLeak(error.mock.calls[0].arguments.join(' '), 'журнал запуска');

  let called = 0;
  const brain = { model: MODEL, async chat() { called += 1; return { content: 'x' }; } };
  await assert.rejects(createGuard({ brain, meter, model: MODEL }).chat({ messages: [{ role: 'user', content: 'привет' }] }), (err) => {
    assert.equal(err.code, 'budget');
    assert.equal(err.scope, 'meter');
    assert.equal(err.reason, reason);
    return true;
  });
  assert.equal(called, 0, 'модель не вызвана');
});

test('миграция: сбой записи (rename бросает) — исходный файл и копия целы, причина без тела файла, модель не вызвана', async (t) => {
  const { warn, error } = quiet(t);
  const dir = tmpDir(t);
  const { file, original } = writeLegacy(dir);
  const realRename = fs.renameSync;
  const rename = t.mock.method(fs, 'renameSync', (src, dest) => {
    if (path.resolve(dest) === path.resolve(file)) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return realRename.call(fs, src, dest);
  });
  const meter = new Meter({ file, dailyLimitUsd: 1, legacyTimezone: 'Asia/Bishkek', now: nowAt(AT) });

  assert.ok(fs.readFileSync(file).equals(original), 'основной файл не изменён');
  const [bak] = backups(dir);
  assert.ok(bak, 'копия создана до записи');
  assert.ok(fs.readFileSync(path.join(dir, bak)).equals(original), 'копия цела');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['budget.json', bak].sort(), 'временный файл убран');
  const reason = meter.blockedReason();
  assert.equal(reason, `миграция часового пояса учёта не записана (запись учёта: EPERM); исходный файл не изменён; `
    + `резервная копия: ${path.join(dir, bak)} — лимит не обеспечен`);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 1);

  let called = 0;
  const brain = { model: MODEL, async chat() { called += 1; return { content: 'x' }; } };
  let failure;
  await assert.rejects(createGuard({ brain, meter, model: MODEL }).chat({ messages: [{ role: 'user', content: 'привет' }] }), (err) => {
    failure = err;
    return err.code === 'budget' && err.scope === 'meter';
  });
  assert.equal(called, 0, 'модель не вызвана');
  // Тело файла не попадает ни в ошибку стража (она уходит в ответ и память), ни в журнал запуска.
  assertNoLeak(failure.message, 'ошибка стража');
  assertNoLeak(failure.reason, 'причина');
  assertNoLeak(error.mock.calls[0].arguments.join(' '), 'журнал запуска');
  assert.equal(failure.message.includes(original.toString('utf8')), false);

  // Запись снова работает: следующий запуск мигрирует (с новой копией), суммы не потеряны.
  rename.mock.restore();
  const next = new Meter({ file, dailyLimitUsd: 1, legacyTimezone: 'Asia/Bishkek', now: nowAt(new Date(AT.getTime() + 1000)) });
  assert.equal(next.blockedReason(), null);
  assert.equal(readState(file).timezone, 'Asia/Dushanbe');
  assert.equal(backups(dir).length, 2);
  near(next.spentToday(), 0.6);
  near(next.reservedUsd, 0.07);
});

test('миграция: учтённый расход не уменьшается, счета задач и журнал те же, резерв живого процесса остаётся резервом', (t) => {
  quiet(t);
  // Обе стороны: файл прежней версии (Бишкек) → Душанбе и файл в поясе Душанбе → Бишкек; моменты по всему дню.
  const cases = [];
  for (let h = 0; h < 24; h += 3) cases.push({ name: `legacy Бишкек → Душанбе, ${h}:20 Бишкека`, at: bsk(2026, 11, 1, h, 20), tz: 'Asia/Dushanbe', fileTz: undefined, date: '2026-11-01' });
  for (let h = 0; h < 24; h += 3) cases.push({ name: `Душанбе → Бишкек, ${h}:20 Душанбе`, at: dsh(2026, 10, 31, h, 20), tz: 'Asia/Bishkek', fileTz: 'Asia/Dushanbe', date: '2026-10-31' });
  for (const c of cases) {
    const dir = tmpDir(t);
    const before = { ...legacyState(), date: c.date, calls: [call(new Date(c.at.getTime() - 10 * 60000), 0.05, { taskId: SECRET_TASK })] };
    if (c.fileTz) before.timezone = c.fileTz;
    const { file } = writeLegacy(dir, before);
    const meter = new Meter({ file, dailyLimitUsd: 1, timezone: c.tz, legacyTimezone: 'Asia/Bishkek', now: nowAt(c.at) });
    const after = readState(file);
    assert.equal(after.timezone, c.tz, c.name);
    // Старый день ещё идёт (момент внутри него) — сумма старого дня переносится целиком, не меньше.
    assert.ok(meter.spentToday() >= before.spentUsd - 1e-12, `${c.name}: расход ${meter.spentToday()} < ${before.spentUsd}`);
    assert.ok(meter.unknownCallsToday() >= before.unknownCalls, `${c.name}: неизвестных вызовов меньше`);
    assert.deepEqual(after.byTask, before.byTask, `${c.name}: счета задач`);
    assert.deepEqual(after.calls, before.calls, `${c.name}: журнал`);
    assert.deepEqual(after.pending, before.pending, `${c.name}: резерв живого процесса не снят и не переведён в расход`);
    near(meter.reservedUsd, 0.07, c.name);
    assert.ok(meter.remainingToday() <= 1 - before.spentUsd - 0.07 + 1e-12, `${c.name}: остаток вырос`);
    assert.equal(meter.accountingStatus().transitional, true, c.name);
  }
});

test('запуск с живым резервом не переписывает неизменённый учёт', (t) => {
  const dir = tmpDir(t);
  const state = { ...legacyState(process.ppid), timezone: 'Asia/Dushanbe', date: '2026-10-31' };
  const { file, original } = writeLegacy(dir, state);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('лишняя запись'); });
  const meter = new Meter({ file, dailyLimitUsd: 1, now: nowAt(AT) });
  assert.equal(rename.mock.callCount(), 0);
  assert.ok(fs.readFileSync(file).equals(original));
  near(meter.reservedUsd, 0.07);
});

test('миграция: два процесса одновременно на одном файле — одна копия, одна миграция (замок budget.json.lock)', { timeout: 60000 }, async (t) => {
  const dir = tmpDir(t);
  // Резерв этого тест-процесса: для дочерних он — живой чужой процесс.
  const { file, original } = writeLegacy(dir, legacyState(process.pid));
  // Копия в каждом процессе медленная (400 мс): без общего замка второй процесс успел бы прочесть старый файл.
  const script = `
    const fs = require('fs');
    const copy = fs.copyFileSync;
    const cell = new Int32Array(new SharedArrayBuffer(4));
    fs.copyFileSync = (...a) => { Atomics.wait(cell, 0, 0, 400); return copy.apply(fs, a); };
    let migrations = 0;
    console.warn = (m) => { if (/день бюджета считается по/.test(m)) migrations += 1; };
    const { Meter } = require(${JSON.stringify(METER_PATH)});
    const at = ${AT.getTime()} + Number(process.argv[1]); // у процессов разное время: разные имена копий
    const m = new Meter({ file: ${JSON.stringify(file)}, dailyLimitUsd: 1, legacyTimezone: 'Asia/Bishkek', now: () => new Date(at) });
    process.stdout.write(JSON.stringify({ migrations, spent: m.spentToday(), reserved: m.reservedUsd, blocked: m.blockedReason() }));
  `;
  const run = (shift) => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script, String(shift)], (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
  const [a, b] = await Promise.all([run(0), run(1)]);
  for (const r of [a, b]) {
    assert.equal(r.blocked, null);
    near(r.spent, 0.6);
    near(r.reserved, 0.07);
  }
  assert.equal(a.migrations + b.migrations, 1, `миграций ${a.migrations + b.migrations}: должна быть одна`);
  const list = backups(dir);
  assert.equal(list.length, 1, `копий ${list.length}: миграция выполнена дважды`);
  assert.ok(fs.readFileSync(path.join(dir, list[0])).equals(original), 'копия — исходный файл, а не уже мигрированный');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'замок снят');
  const state = readState(file);
  assert.equal(state.timezone, 'Asia/Dushanbe');
  assert.deepEqual(state.pending.map((p) => p.id), [SECRET_RESERVE]);
});

test('costSummary читает budget.json и не пишет: ни миграции, ни копий, ни второго учёта', (t) => {
  const dir = tmpDir(t);
  const { file, original } = writeLegacy(dir);
  const s = taskCostSummary({ file, taskId: SECRET_TASK, since: dsh(2026, 10, 31, 0, 0).getTime(), now: AT.getTime() });
  assert.equal(s.available, true);
  near(s.usd, 0.6);
  assert.equal(s.complete, false, 'резерв в полёте — данные неполные');
  assert.match(s.problems.join('; '), /вызовов в полёте \(резервов\): 1/);
  assert.ok(fs.readFileSync(file).equals(original), 'файл учёта не изменён (старый формат не мигрирован сводкой)');
  assert.deepEqual(fs.readdirSync(dir), ['budget.json'], 'сводка не создаёт файлов');
});
