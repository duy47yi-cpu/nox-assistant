'use strict';

// Тарифы. Лимиты считаются в себестоимости (USD по цене провайдера), владельцу аккаунта показываются процентами.
// Числа — стартовые, из замера docs/business/plan.md; ключ NOX_PLANS_FILE заменяет их без правки кода.
const fs = require('fs');

const HOUR = 3600 * 1000;
const WINDOW_MS = { session: 5 * HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR };

const DEFAULT_PLANS = {
  trial: { title: 'Пробный', priceUsd: 0, sessionUsd: 0.03, weekUsd: 0.1, trialDays: 7 },
  pro: { title: 'Pro', priceUsd: 10, priceRub: 800, sessionUsd: 0.2, weekUsd: 1.1 },
  max: { title: 'Max', priceUsd: 25, priceRub: 2000, sessionUsd: 0.7, weekUsd: 3.35 },
};

function isLimit(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function loadPlans(file) {
  const source = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : DEFAULT_PLANS;
  const plans = Object.fromEntries(Object.entries(source).map(([id, plan]) => {
    if (!isLimit(plan.sessionUsd) || !isLimit(plan.weekUsd)) throw new Error(`тариф ${id}: нужны sessionUsd и weekUsd больше 0`);
    if (plan.dayUsd !== undefined && !isLimit(plan.dayUsd)) throw new Error(`тариф ${id}: нужен dayUsd больше 0`);
    return [id, { ...plan, dayUsd: plan.dayUsd ?? Math.min(plan.sessionUsd * 2, plan.weekUsd) }];
  }));
  if (!plans.trial) throw new Error('нужен тариф trial: с него начинается аккаунт');
  return plans;
}

module.exports = { loadPlans, DEFAULT_PLANS, WINDOW_MS };
