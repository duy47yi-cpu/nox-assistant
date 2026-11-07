'use strict';

// Проверка результата действия. Инструмент может описать поле verify(args, result, ctx), которое
// проверяет, что эффект действительно есть (файл записан с нужным текстом и т.п.).
// Возвращает {status: 'confirmed' | 'failed' | 'unknown', evidence}.
// - confirmed: результат подтверждён, ответ не меняется, в поле verified пишем 'confirmed';
// - failed: эффекта нет, ok становится false: нельзя назвать действие выполненным;
// - unknown: проверить не удалось, ok сохраняется, но в ответе есть пометка «не проверено».
// Инструменты без verify ведут себя как раньше.

const STATUSES = new Set(['confirmed', 'failed', 'unknown']);

async function checkEffect(tool, args, result, ctx) {
  if (typeof tool.verify !== 'function' || !result || !result.ok) return result;

  let verdict;
  try {
    verdict = await tool.verify(args, result, ctx);
  } catch (err) {
    verdict = { status: 'unknown', evidence: `проверка упала: ${err && err.message ? err.message : err}` };
  }
  const status = verdict && STATUSES.has(verdict.status) ? verdict.status : 'unknown';
  const evidence = verdict && verdict.evidence ? String(verdict.evidence) : '';

  if (status === 'failed') {
    return { ...result, ok: false, summary: `не подтверждено: ${evidence || result.summary}`, verified: 'failed', evidence };
  }
  if (status === 'unknown') {
    const note = evidence ? `не проверено: ${evidence}` : 'не проверено';
    return { ...result, summary: `${result.summary} (${note})`, verified: 'unknown', evidence };
  }
  return { ...result, verified: 'confirmed', evidence };
}

// Для инструментов, у которых эффект снаружи не увидеть: честное «не проверено» вместо молчаливого успеха.
function cannotVerify(evidence) {
  return async () => ({ status: 'unknown', evidence });
}

module.exports = { checkEffect, cannotVerify, STATUSES };
