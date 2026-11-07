'use strict';

// Страж бюджета вокруг мозга: каждая HTTP-попытка вызова модели проверяется до запроса и резервируется отдельно,
// а каждая попытка (повторы и неуспешные тоже) учитывается в Meter одним путём — через onUsage вызова.
//
// guard.chat(args) принимает то же, что brain.chat, и ещё taskId и taskBudgetUsd:
//   1. Оценка одной HTTP-попытки: вход — символы JSON {messages, tools} / 2 с округлением вверх,
//      весь вход по полной цене; выход — потолок min(maxTokens вызывающего, maxOutputTokens): он же уходит
//      в запрос полем max_tokens. estimate().usd — худший случай всего вызова (попытка × MAX_ATTEMPTS), для сведений.
//   2. Проверка попытки прямо перед её запросом (gate): учёт заблокирован (файл повреждён), цена неизвестна,
//      остаток дня меньше попытки, бюджет задачи исчерпан. Отказ — err.code = 'budget', причина в err.reason,
//      err.scope = 'meter' | 'price' | 'day' | 'task'. Решение о паузе принимает вызывающий код.
//   3. Резерв одной попытки пишется в файл учёта до её запроса и снимается после неё. Первая попытка
//      проверяется до вызова мозга; каждая повторная — через beforeAttempt клиента, перед своим запросом.
//      Если проверка повтора не прошла, запроса нет, и ошибка уходит наверх.
//   4. Каждая попытка записывается в Meter: точно по usage ответа или по верхней границе, если usage нет.
//      Если запись не удалась, резерв попытки не снимается: после перезапуска он станет расходом.
//   Ответ и ошибки brain.chat возвращаются без изменений.

const { priceFor } = require('./prices');
const { upperBound, REASON_UNKNOWN_PRICE } = require('./meter');
const { createResponseCache } = require('./response-cache');

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
// Больше HTTP-попыток DeepSeekClient.chat не делает: повтор при сбое сети (×2) в каждом из двух заходов —
// с полями отключения размышлений и без них после HTTP 400. Меняется логика повторов — меняется и это число.
const MAX_ATTEMPTS = 4;
const CHARS_PER_TOKEN = 2;
const DEFAULT_PURPOSE = 'chat';
const REASON_TASK = 'бюджет задачи исчерпан';
const METER_METHODS = ['blockedReason', 'enforceable', 'reserveWithin', 'release', 'record'];

function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// Сумма для сообщений: до 6 знаков после точки без хвостовых нулей, но не меньше двух.
function formatUsd(usd) {
  const [whole, frac = ''] = usd.toFixed(6).replace(/0+$/, '').split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
}

function budgetError(reason, extra) {
  return Object.assign(new Error(`Вызов модели не сделан: ${reason}`), { code: 'budget', reason }, extra);
}

function argsError(message) {
  return Object.assign(new Error(`Страж бюджета: ${message}`), { code: 'bad_args' });
}

function errText(err) {
  return err && err.message ? err.message : String(err);
}

// brain — клиент с chat() (DeepSeekClient); meter — Meter; model — ID модели, по цене которой считается бюджет;
// maxOutputTokens — предел потолка выхода одного запроса: maxTokens вызывающего выше него урезается.
function createGuard({ brain, meter, model, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS, responseCache = createResponseCache() } = {}) {
  if (!brain || typeof brain.chat !== 'function') throw new Error('createGuard: нужен brain с методом chat');
  if (!meter || METER_METHODS.some((name) => typeof meter[name] !== 'function')) {
    throw new Error(`createGuard: нужен meter с методами ${METER_METHODS.join(', ')}`);
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error(`createGuard: maxOutputTokens должен быть целым числом больше 0, получено: ${maxOutputTokens}`);
  }

  // Потолок выхода запроса: maxTokens вызывающего (например, остаток токенов задачи), но не выше maxOutputTokens.
  // Один и тот же потолок уходит в max_tokens и в оценку: иначе оценка не была бы верхней границей.
  function outputCap(maxTokens) {
    return Math.min(maxTokens ?? maxOutputTokens, maxOutputTokens);
  }

  // Верхние границы: {inputTokens, outputTokens, attemptUsd, usd}. attemptUsd — одна HTTP-попытка,
  // usd — весь вызов в худшем случае (attemptUsd × MAX_ATTEMPTS). null — цена модели неизвестна.
  // maxTokens — потолок вызывающего, как в chat().
  function estimate({ messages, tools, maxTokens } = {}) {
    const inputTokens = Math.ceil(JSON.stringify({ messages, tools }).length / CHARS_PER_TOKEN);
    const outputTokens = outputCap(maxTokens);
    const price = priceFor(model);
    const attemptUsd = price ? upperBound(null, { inputTokens, outputTokens }, price) : null;
    const usd = attemptUsd === null ? null : attemptUsd * MAX_ATTEMPTS;
    return { inputTokens, outputTokens, attemptUsd, usd };
  }

  function releaseReservation(id) {
    try {
      meter.release(id);
    } catch (err) {
      // Резерв остался в файле: лишний учёт лучше, чем ошибка вместо готового ответа.
      console.error(`Учёт расходов: резерв не снят (${errText(err)}); после перезапуска он станет расходом`);
    }
  }

  async function chat(args = {}) {
    const { taskBudgetUsd, ...rest } = args;
    const { taskId } = args;
    const purpose = args.purpose || DEFAULT_PURPOSE;
    const hasTask = taskId !== undefined && taskId !== null;
    const hasTaskBudget = taskBudgetUsd !== undefined && taskBudgetUsd !== null;
    // Ошибки вызывающего кода — до всякого расхода: иначе бюджет задачи тихо не проверился бы.
    if (hasTask && (typeof taskId !== 'string' || taskId === '')) {
      throw argsError(`taskId должен быть непустой строкой, получено: ${taskId}`);
    }
    if (hasTaskBudget && !isCount(taskBudgetUsd)) {
      throw argsError(`taskBudgetUsd должен быть числом не меньше 0, получено: ${taskBudgetUsd}`);
    }
    if (hasTaskBudget && !hasTask) throw argsError('taskBudgetUsd передан без taskId: бюджет задачи не проверить');
    const { maxTokens } = args;
    if (maxTokens !== undefined && maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      throw argsError(`maxTokens должен быть целым числом больше 0, получено: ${maxTokens}`);
    }

    const blocked = meter.blockedReason();
    if (blocked) throw budgetError(blocked, { scope: 'meter' });
    if (!meter.enforceable(model)) throw budgetError(REASON_UNKNOWN_PRICE, { scope: 'price' });
    // Мозг шлёт запросы от имени другой модели: проверка по цене model ничего бы не гарантировала.
    if (typeof brain.model === 'string' && brain.model !== model) {
      throw budgetError(`мозг работает с моделью ${brain.model}, а цена взята для ${model} — лимит не обеспечен`,
        { scope: 'price' });
    }

    // Ответ из ограниченного кеша не обращается к модели и не создаёт фиктивный расход.
    // Но ошибки учёта, цены и маршрута остаются выше этого раннего возврата.
    const cacheScope = typeof brain.cacheScope === 'function' ? brain.cacheScope(args) : brain.model || model;
    const cached = responseCache && typeof responseCache.get === 'function' ? responseCache.get(args, cacheScope) : null;
    if (cached) return cached;
    const { inputTokens, outputTokens, attemptUsd } = estimate(args);
    if (attemptUsd === null) throw budgetError(REASON_UNKNOWN_PRICE, { scope: 'price' });

    // Проверка одной попытки и её резерв — одна операция на учёте (reserveWithin, под замком файла):
    // остаток дня и бюджет задачи не могут быть проверены и заняты двумя процессами по одному и тому же остатку.
    // Возвращает id резерва; если проверка не прошла — бросает budgetError, резерва нет.
    const gate = () => {
      const reason = meter.blockedReason();
      if (reason) throw budgetError(reason, { scope: 'meter' });
      if (!meter.enforceable(model)) throw budgetError(REASON_UNKNOWN_PRICE, { scope: 'price' });
      const r = meter.reserveWithin(attemptUsd, { purpose, model, taskId, taskBudgetUsd: hasTaskBudget ? taskBudgetUsd : undefined });
      if (r.ok) return r.id;
      if (r.scope === 'meter') throw budgetError(r.reason, { scope: 'meter' });
      if (r.scope === 'day') {
        // В переходный день после смены пояса бюджета остаток посчитан консервативно — об этом говорит r.note.
        const note = typeof r.note === 'string' && r.note ? `; ${r.note}` : '';
        throw budgetError(`дневной лимит: остаток $${formatUsd(r.remainingUsd)}, следующая попытка до $${formatUsd(attemptUsd)}${note}`,
          { scope: 'day', attemptUsd, remainingUsd: r.remainingUsd });
      }
      throw budgetError(REASON_TASK, { scope: 'task', attemptUsd, spentUsd: r.spentUsd, budgetUsd: taskBudgetUsd });
    };

    const pessimisticTokens = { inputTokens, outputTokens };
    let current = gate(); // резерв попытки в полёте: null, когда её учёт уже записан или резерв оставлен в файле
    let unrecorded = null;
    let firstChecked = true; // первая попытка проверена выше, до вызова мозга
    const beforeAttempt = () => {
      if (firstChecked) {
        firstChecked = false;
        return;
      }
      current = gate();
    };
    const onUsage = (info) => {
      try {
        meter.record({ purpose, taskId, model, usage: info && info.usage ? info.usage : null, pessimisticTokens });
      } catch (err) {
        // Попытка, возможно, оплачена, но не записана: её резерв остаётся в файле, неизвестный расход не бесплатен.
        unrecorded = err;
        current = null;
        return;
      }
      if (current !== null) {
        const id = current;
        current = null;
        releaseReservation(id);
      }
    };

    try {
      const result = await brain.chat({ ...rest, maxTokens: outputTokens, purpose, onUsage, beforeAttempt });
      if (responseCache && typeof responseCache.set === 'function') responseCache.set(args, result, cacheScope);
      return result;
    } finally {
      if (unrecorded) {
        console.error(`Учёт расходов: попытка не записана (${errText(unrecorded)}); резерв оставлен в файле `
          + 'и после перезапуска станет расходом');
      }
      // Резерв, которому не нашлось попытки (отмена до отправки), снимаем: расхода не было.
      if (current !== null) releaseReservation(current);
    }
  }

  return { chat, estimate };
}

module.exports = { createGuard, DEFAULT_MAX_OUTPUT_TOKENS, MAX_ATTEMPTS };
