'use strict';

// Единственное место, где сказано, какая модель у какого провайдера. Менять провайдера — только здесь или файлом NOX_MODELS_FILE.
// Ключи здесь не хранятся: keyEnv — имя переменной окружения с ключом.
const fs = require('fs');

// Уровень мышления: что уходит провайдеру и во сколько раз быстрее тратится лимит пользователя.
const THINKING_WEIGHT = { low: 1, medium: 1.5, high: 2.5 };

const DEFAULT_MODELS = {
  fast: {
    title: 'Быстрая',
    url: 'https://api.deepinfra.com/v1/openai',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    keyEnv: 'NOX_FAST_KEY',
    levels: { low: {}, medium: { reasoning_effort: 'medium' }, high: { reasoning_effort: 'high' } },
    price: { inputPerM: 0.2, cachedPerM: 0.006, outputPerM: 0.6 },
  },
  smart: {
    title: 'Умная',
    url: 'https://inference.do-ai.run/v1',
    model: 'minimax-m3.1-flash',
    keyEnv: 'NOX_SMART_KEY',
    levels: { low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' }, high: { reasoning_effort: 'high' } },
    price: { inputPerM: 0.15, cachedPerM: 0.015, outputPerM: 0.6 },
  },
};

const isRate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Что не так с настройкой, сообщаем при запуске: сервер без цены или ключа не должен принимать запросы.
function loadModels({ file = null, env = process.env } = {}) {
  const raw = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : DEFAULT_MODELS;
  const out = {};
  for (const [tier, m] of Object.entries(raw)) {
    if (!m.url || !m.model) throw new Error(`модель ${tier}: нужны url и model`);
    if (!m.price || !isRate(m.price.inputPerM) || !isRate(m.price.cachedPerM) || !isRate(m.price.outputPerM)) throw new Error(`модель ${tier}: нужна цена`);
    const key = env[m.keyEnv];
    if (!key) throw new Error(`модель ${tier}: не задан ключ ${m.keyEnv}`);
    out[tier] = { levels: m.levels || {}, title: m.title || tier, url: String(m.url).replace(/\/+$/, ''), model: m.model, key, price: m.price };
  }
  if (!out.fast) throw new Error('нужна модель fast: на неё идёт обычный чат');
  return out;
}

module.exports = { loadModels, DEFAULT_MODELS, THINKING_WEIGHT };
