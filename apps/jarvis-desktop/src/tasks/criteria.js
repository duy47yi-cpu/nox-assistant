'use strict';

// Критерии приёмки задачи с мандатом: отдельный от шагов список того, что должно быть верно в конце.
// Критерий называет требование цели, которое он закрывает (requirement, свободный текст: цитата, пересказ или
// уточнение), и что именно проверяем (text). Соответствие requirement цели код НЕ проверяет: критерии формулирует
// планировщик, и их полнота не проверена (так и пишет отчёт). Исходная цель хранится дословно отдельно
// (task.goal, mandate.goal). Способ проверки — ровно один:
//   check  — объективная проверка из verify.js (file_exists, file_contains, file_absent, numbered_steps, sentence_count);
//            её выполняет код после всех шагов, модель на итог не влияет;
//   manual — {kind: 'model_only' | 'impossible', reason}: честная отметка, что доступна только оценка модели
//            или что проверить нельзя. Такой критерий итог «проверено» не даёт никогда.
// Чистые функции, без диска: проверку пути (песочница, папки мандата) делает переданный cleanCheck исполнителя.

const MANUAL_KINDS = ['model_only', 'impossible'];
const MANUAL_WORDS = { model_only: 'оценка модели', impossible: 'проверка невозможна' };
const MAX_CRITERIA = 20;
const MAX_REQUIREMENT = 300;
const MAX_TEXT = 300;
const MAX_REASON = 300;
const MAX_EVIDENCE = 500;
// Состояния критерия для отчёта и окна (task.verdict.criteria[].state).
const STATES = ['verified', 'model_only', 'impossible', 'failed'];

function clip(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Пробелы и переводы строк в requirement сводятся к одному пробелу: это подпись в отчёте, а не цитата.
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// Список критериев от модели → {value: [...]} или {error: 'понятный текст'}.
// cleanCheck(check) → {value} | {error} (проверка вида, пути и параметров).
// Пустой список — ошибка: новый план без критериев не принимается. requirement с целью не сверяется.
function cleanCriteria(list, { cleanCheck }) {
  if (list === undefined || list === null) {
    return { error: 'нужен список критериев приёмки criteria: хотя бы один критерий на явное требование цели' };
  }
  if (!Array.isArray(list)) return { error: 'criteria должен быть списком критериев {requirement, text, check | manual}' };
  if (list.length === 0) return { error: 'список критериев приёмки пуст: нужен хотя бы один критерий на явное требование цели' };
  if (list.length > MAX_CRITERIA) return { error: `критериев приёмки больше ${MAX_CRITERIA}` };
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const n = i + 1;
    const c = list[i];
    if (!isObject(c)) return { error: `критерий ${n}: нужен объект {requirement, text, check | manual}` };
    const requirement = typeof c.requirement === 'string' ? squash(c.requirement) : '';
    if (!requirement) return { error: `критерий ${n}: нет requirement — какое требование цели закрывает критерий` };
    if (requirement.length > MAX_REQUIREMENT) return { error: `критерий ${n}: requirement длиннее ${MAX_REQUIREMENT} символов` };
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    if (!text) return { error: `критерий ${n}: нет text — что именно проверяем` };
    const hasCheck = c.check !== undefined && c.check !== null;
    const hasManual = c.manual !== undefined && c.manual !== null;
    if (hasCheck === hasManual) {
      return {
        error: `критерий ${n}: нужно ровно одно из check (объективная проверка) или manual `
          + '{kind: "model_only" | "impossible", reason}',
      };
    }
    const item = { id: `c${n}`, requirement, text: clip(text, MAX_TEXT), check: null, manual: null };
    if (hasCheck) {
      const checked = cleanCheck(c.check);
      if (checked.error) return { error: `критерий ${n}: ${checked.error}` };
      item.check = checked.value;
    } else {
      if (!isObject(c.manual) || !MANUAL_KINDS.includes(c.manual.kind)) {
        return { error: `критерий ${n}: manual.kind — model_only (только оценка модели) или impossible (проверить нельзя)` };
      }
      const reason = typeof c.manual.reason === 'string' ? c.manual.reason.trim() : '';
      if (!reason) return { error: `критерий ${n}: у manual нужна причина reason — почему объективной проверки нет` };
      item.manual = { kind: c.manual.kind, reason: clip(reason, MAX_REASON) };
    }
    out.push(item);
  }
  return { value: out };
}

// Происхождение критериев для отчёта: их пишет планировщик (модель), код полноту не сверяет с целью.
const ORIGIN_NOTE = 'критерий сформулирован планировщиком, полнота не проверена';

// Способ проверки критерия словами для владельца: объективная проверка кодом, оценка модели или проверка невозможна.
function methodOf(c) {
  if (c && c.check) return 'объективная проверка';
  if (c && c.manual && MANUAL_KINDS.includes(c.manual.kind)) return MANUAL_WORDS[c.manual.kind];
  return 'способ не указан';
}

// Есть ли у задачи критерии приёмки. Нет поля или пустой список — легаси-задача: итог по старым правилам.
function hasCriteria(task) {
  return Boolean(task) && Array.isArray(task.criteria) && task.criteria.length > 0;
}

// Проверка критериев кодом. runCheck(check) → {status, evidence}: confirmed | failed | unknown.
// manual-критерии не проверяются: у них нет проверки. Возвращает новый список с result у каждого check-критерия.
function evaluate(criteria, runCheck) {
  return (Array.isArray(criteria) ? criteria : []).map((c) => {
    if (!c || !c.check) return c;
    let outcome;
    try {
      outcome = runCheck(c.check);
    } catch (err) {
      outcome = { status: 'unknown', evidence: `проверка не выполнена: ${(err && err.message) || err}` };
    }
    const status = ['confirmed', 'failed', 'unknown'].includes(outcome && outcome.status) ? outcome.status : 'unknown';
    return { ...c, result: { verification: status, evidence: clip(outcome && outcome.evidence, MAX_EVIDENCE) } };
  });
}

// Состояние критерия: verified — проверка подтвердила; failed — проверка не подтвердила, не удалась
// или не выполнялась; model_only / impossible — честная ручная отметка.
function stateOf(c) {
  if (c && c.manual && MANUAL_KINDS.includes(c.manual.kind)) return c.manual.kind;
  return c && c.result && c.result.verification === 'confirmed' ? 'verified' : 'failed';
}

function evidenceOf(c) {
  const state = stateOf(c);
  if (state === 'model_only' || state === 'impossible') return `${MANUAL_WORDS[state]}: ${c.manual.reason}`;
  if (!c.result) return 'проверка не выполнялась';
  const word = { confirmed: 'подтверждено', failed: 'не подтверждено', unknown: 'не удалось проверить' }[c.result.verification] || 'не подтверждено';
  return c.result.evidence ? `${word}: ${c.result.evidence}` : word;
}

// Строки для итога (task.verdict.criteria) и окна: {id, requirement, state, evidence}.
function rows(task) {
  return (hasCriteria(task) ? task.criteria : []).map((c) => ({
    id: c.id,
    requirement: c.requirement,
    state: stateOf(c),
    evidence: evidenceOf(c),
  }));
}

module.exports = {
  MANUAL_KINDS, MANUAL_WORDS, MAX_CRITERIA, STATES, ORIGIN_NOTE,
  cleanCriteria, hasCriteria, evaluate, stateOf, evidenceOf, rows, methodOf,
};
