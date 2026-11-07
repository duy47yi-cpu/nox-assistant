'use strict';

// Цены моделей в USD за 1 млн токенов. Поля записи цены:
//   modelId    — точный ID модели у провайдера; ключ таблицы обязан с ним совпадать;
//   inputPerM  — входные токены без кэша: та часть промпта, которую провайдер обработал заново, по полной цене;
//   cachedPerM — входные токены из кэша провайдера: начало промпта, совпавшее с прошлым запросом
//                (usage.prompt_tokens_details.cached_tokens), — дешевле;
//   outputPerM — выходные токены: ответ модели вместе с токенами размышлений (они входят в completion_tokens);
//   source     — где цена сверена;
//   checkedAt  — дата сверки (ГГГГ-ММ-ДД).
// Цена ищется только по точному ID: регистр, пробелы, префикс провайдера и суффиксы версии не сопоставляются.
// Модель вне таблицы или неполная запись — цена неизвестна. Тогда стоимость вызова не считается
// (costUsd: null), а дневной лимит для этой модели не обеспечен (Meter.enforceable → false).
// Цены не выдумываем: в таблицу попадает только цена, сверенная у провайдера.

const FLASH_1017 = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';

const PRICES = Object.freeze({
  // DeepInfra, списочная цена: вход 0.20, вход из кэша 0.006, выход 0.60.
  // На странице модели сейчас акция «51% off» (0.098 / 0.003 / 0.294), дата её окончания не указана,
  // поэтому на неё не опираемся. Списочная цена — консервативная верхняя граница:
  // учёт может переоценить расход, но не занизит его, и лимит не сломается, когда скидка кончится.
  [FLASH_1017]: Object.freeze({
    modelId: FLASH_1017,
    inputPerM: 0.20,
    cachedPerM: 0.006,
    outputPerM: 0.60,
    source: 'https://deepinfra.com/deepseek-ai/DeepSeek-V4.1-Flash-1017 — списочная цена, акционная скидка не учтена',
    checkedAt: '2026-10-30',
  }),
});

function isRate(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// Полная ли запись цены: все три ставки — конечные неотрицательные числа.
function isPrice(price) {
  return Boolean(price) && typeof price === 'object'
    && isRate(price.inputPerM) && isRate(price.cachedPerM) && isRate(price.outputPerM);
}

// Цена модели или null, если цена неизвестна или записана не полностью.
// Запись годится только для того ID, что указан в её modelId: опечатка в ключе таблицы не подставит цену
// другой модели, а запись без modelId ценой не считается.
// table — другая таблица цен (для проверок); по умолчанию PRICES.
function priceFor(model, table = PRICES) {
  if (typeof model !== 'string' || !table || !Object.hasOwn(table, model)) return null;
  const price = table[model];
  return isPrice(price) && price.modelId === model ? price : null;
}

module.exports = { PRICES, priceFor, isPrice };
