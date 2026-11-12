'use strict';

// Выбор модели и уровня мышления одним местом. Настоящие названия владельцу и пользователям не показываются: только «Быстрая» и «Умная».
const LEVELS = Object.freeze({
  fast: Object.freeze({ low: {}, medium: { reasoning_effort: 'medium' }, high: { reasoning_effort: 'high' } }),
  smart: Object.freeze({ low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' }, high: { reasoning_effort: 'high' } }),
});
const TIERS = Object.freeze(Object.keys(LEVELS));
const THINKING = Object.freeze(['low', 'medium', 'high']);

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

// clients = {fast, smart}; smart может не быть (нет ключа), тогда работает быстрая.
// В режиме аккаунтов клиент один, уровни понимает сервер (client.sendTier), свои поля не добавляем.
function createRouter({ clients, getSettings = () => ({}) }) {
  const clientIds = new WeakMap();
  let nextClientId = 1;
  const clientId = (client) => {
    if (!client || (typeof client !== 'object' && typeof client !== 'function')) return 'none';
    if (!clientIds.has(client)) clientIds.set(client, nextClientId++);
    return clientIds.get(client);
  };
  return {
    get model() {
      return clients.fast.model;
    },
    cacheScope(args = {}) {
      const s = getSettings();
      const tier = pick(args.tier || s.modelTier, TIERS, 'fast');
      const used = clients[tier] ? tier : 'fast';
      const client = clients[used] || clients.fast;
      return { client: clientId(client), model: client && client.model || '', tier: used };
    },
    chat(args = {}) {
      const s = getSettings();
      const tier = pick(args.tier || s.modelTier, TIERS, 'fast');
      const thinking = pick(args.thinking || s.thinking, THINKING, 'low');
      const used = clients[tier] ? tier : 'fast';
      const client = clients[tier] || clients.fast;
      return client.chat({ ...args, tier: used, thinking, levelFields: client.sendTier ? null : LEVELS[used][thinking] });
    },
  };
}

module.exports = { createRouter, LEVELS, TIERS, THINKING };
