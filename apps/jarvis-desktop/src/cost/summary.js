'use strict';

// Сводка стоимости задачи для отчёта — только чтение журнала стоимости, который ведёт cost/meter.js (budget.json).
// Второго финансового учёта нет: файл не пишется, Meter не создаётся (новый Meter перевёл бы чужие резервы
// в расход). Файл читается так же, как Meter._load: синхронно, BOM срезается; запись в файл Meter делает
// атомарно (временный файл и rename), поэтому чтение без замка видит целое состояние.
//
// Что в журнале (см. meter.js):
//   byTask[taskId] — сумма задачи за всё время, USD: точные стоимости и верхние оценки; не обрезается;
//   calls          — последние MAX_CALLS попыток {ts, purpose, model, costUsd, known[, taskId][, interrupted]};
//                    старые записи вытесняются, поэтому число попыток задачи может быть потеряно;
//   pending        — резервы вызовов в полёте; blocked — файл был повреждён, прежний расход неизвестен.
//
// taskCostSummary({file, taskId, since, now}) → {
//   available,   — журнал прочитан;
//   usd,         — счёт задачи byTask (USD) или null, если журнал недоступен;
//   attempts,    — число попыток вызова модели по задаче; null, если записи могли быть вытеснены (не выдумываем);
//   attemptsSeen — сколько попыток задачи видно в журнале сейчас;
//   known,       — расход известен точно: данные полные, и у всех попыток точная стоимость (known: true);
//   knownNotes,  — почему расход не точный (верхние оценки, неизвестная цена, прерванные вызовы);
//   complete,    — данные полные; problems — почему нет («данные неполные»);
//   computedAt   — время расчёта, мс.
// }
const fs = require('fs');
const { MAX_CALLS } = require('./meter');

const MAX_LABEL = 128; // как label() в meter.js: длинный taskId хранится обрезанным
const EPS = 1e-9;

function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function readJournal(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { problem: 'файла учёта нет: расход по задаче не записан' };
    return { problem: `файл учёта не читается: ${(err && err.message) || err}` };
  }
  raw = raw.replace(/^﻿/, '');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { problem: 'файл учёта повреждён (не JSON)' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.calls)) {
    return { problem: 'файл учёта повреждён (не та структура)' };
  }
  const byTask = data.byTask && typeof data.byTask === 'object' && !Array.isArray(data.byTask) ? data.byTask : {};
  const pending = Array.isArray(data.pending) ? data.pending : [];
  return { data: { calls: data.calls, byTask, pending, blocked: data.blocked !== undefined && data.blocked !== null } };
}

function taskCostSummary({ file, taskId, since = null, now = Date.now() } = {}) {
  const computedAt = typeof now === 'function' ? now() : now;
  const base = { available: false, usd: null, attempts: null, attemptsSeen: 0, known: false, knownNotes: [], complete: false, problems: [], computedAt };
  if (typeof file !== 'string' || !file) return { ...base, problems: ['путь к журналу стоимости не задан'] };
  const id = typeof taskId === 'string' && taskId ? taskId.slice(0, MAX_LABEL) : null;
  if (!id) return { ...base, problems: ['нет id задачи'] };

  const read = readJournal(file);
  if (read.problem) return { ...base, problems: [read.problem] };
  const { calls, byTask, pending, blocked } = read.data;
  if (blocked) {
    return { ...base, problems: ['учёт расходов заблокирован (файл учёта был повреждён): прежний расход неизвестен'] };
  }

  const problems = [];
  const knownNotes = [];
  const mine = calls.filter((c) => c && typeof c === 'object' && c.taskId === id);
  const usd = isCount(byTask[id]) ? byTask[id] : 0;
  if (byTask[id] !== undefined && !isCount(byTask[id])) problems.push('счёт задачи в журнале повреждён');

  // Вытеснение: журнал полон, и самая старая уцелевшая запись не раньше начала задачи — записи задачи могли уйти.
  if (calls.length >= MAX_CALLS) {
    const oldest = Date.parse(calls[0] && calls[0].ts);
    const safe = Number.isFinite(since) && Number.isFinite(oldest) && oldest < since;
    if (!safe) problems.push(`журнал хранит только последние ${MAX_CALLS} вызовов: часть попыток по задаче могла быть вытеснена`);
  }
  // Сумма видимых записей задачи должна сойтись со счётом задачи (byTask не обрезается).
  const visibleUsd = mine.reduce((sum, c) => sum + (isCount(c.costUsd) ? c.costUsd : 0), 0);
  if (Math.abs(visibleUsd - usd) > EPS * Math.max(1, usd)) {
    problems.push('сумма видимых записей журнала не совпадает со счётом задачи: часть записей отсутствует');
  }
  const inFlight = pending.filter((p) => p && p.taskId === id).length;
  if (inFlight) problems.push(`вызовов в полёте (резервов): ${inFlight} — расход ещё не окончательный`);

  const unknownPrice = mine.filter((c) => c.costUsd === null || c.costUsd === undefined).length;
  const estimated = mine.filter((c) => isCount(c.costUsd) && c.known !== true).length;
  const interrupted = mine.filter((c) => c.interrupted === true).length;
  if (unknownPrice) knownNotes.push(`попыток с неизвестной ценой: ${unknownPrice} — в сумму не входят`);
  if (estimated) knownNotes.push(`попыток с верхней оценкой вместо точной стоимости: ${estimated}`);
  if (interrupted) knownNotes.push(`из них прерванных: ${interrupted}`);

  const complete = problems.length === 0;
  return {
    available: true,
    usd,
    attempts: complete ? mine.length : null,
    attemptsSeen: mine.length,
    known: complete && unknownPrice === 0 && estimated === 0,
    knownNotes,
    complete,
    problems,
    computedAt,
  };
}

module.exports = { taskCostSummary };
