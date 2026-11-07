'use strict';

// Запуск: все настройки из окружения, ключ провайдера в файле не хранится.
const path = require('path');
const { createServer } = require('./server');
const { loadModels } = require('./models');

const env = process.env;
const DAY = 24 * 3600 * 1000;
const num = (name, def) => (env[name] === undefined ? def : Number(env[name]));
// Некорректное число не должно превращаться в 0 или NaN: берём значение по умолчанию.
const positive = (name, def) => {
  const value = num(name, def);
  return Number.isFinite(value) && value > 0 ? value : def;
};

const { server } = createServer({
  dbFile: env.NOX_DB || path.join(__dirname, 'nox.db'),
  models: loadModels({ file: env.NOX_MODELS_FILE || null }),
  plansFile: env.NOX_PLANS_FILE || null,
  adminKey: env.NOX_ADMIN_KEY || '',
  globalDailyUsd: num('NOX_GLOBAL_DAILY_USD', 20),
  sessionTtlMs: positive('NOX_SESSION_TTL_DAYS', 30) * DAY,
  upstreamTimeoutMs: positive('NOX_UPSTREAM_TIMEOUT_MS', 120000),
  trustProxy: env.NOX_TRUST_PROXY === '1',
});

const port = num('PORT', 8787);
// По умолчанию только локально: наружу сервер выходит через прокси с HTTPS.
server.listen(port, env.HOST || '127.0.0.1', () => console.log(`Nox server: ${port}`));
