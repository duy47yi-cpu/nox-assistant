'use strict';

// Сервер Nox: аккаунты, лимиты и пересылка запросов к модели. Ключ провайдера только здесь, приложение его не видит.
// Текст переписки не сохраняется и не пишется в логи: хранится только расход. HTTPS даёт обратный прокси перед сервером.
const http = require('http');
const crypto = require('crypto');
const { Store } = require('./store');
const { loadPlans, WINDOW_MS } = require('./plans');
const { THINKING_WEIGHT } = require('./models');

const MAX_BODY = 12 * 1024 * 1024; // снимок экрана в base64 плюс история
const MAX_AUTH_BODY = 4096;
const MAX_OUTPUT_TOKENS = 8192;
const MAX_INFLIGHT = 3; // одновременных запросов одного аккаунта: перерасход окна не больше этих запросов
const CHARS_PER_TOKEN = 4; // оценка, когда провайдер не прислал расход (обрыв, отмена)
const DAY = 24 * 3600 * 1000;
const SESSION_TTL_MS = 30 * DAY;
const FORWARD_FIELDS = ['messages', 'tools', 'tool_choice', 'stream', 'stream_options'];
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/;
const LOGIN_IP_PER_15MIN = 60; // общий предел попыток входа с адреса, чтобы перебор не шёл по разным почтам
const ADMIN_PER_15MIN = 20; // неудачные попытки со служебным ключом

// Маскировка секретов для журнала: пропуск, заголовок, почта и известные ключи не должны попасть в лог.
function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    const value = String(secret || '');
    if (value.length >= 8) out = out.split(value).join('***');
  }
  return out
    .replace(/nox_[A-Za-z0-9_-]{8,}/g, 'nox_***')
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***');
}

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, extra });
  }
}

function sendJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return; // клиент уже ушёл, писать некуда
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        // Не рвём соединение сразу: сначала нужно ответить 413, иначе клиент увидит только обрыв.
        req.pause();
        reject(new HttpError(413, 'too_large', 'запрос слишком большой'));
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function readJson(req, max) {
  const raw = await readBody(req, max);
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('не объект');
    return value;
  } catch {
    throw new HttpError(400, 'bad_json', 'тело запроса не JSON-объект');
  }
}

function usageOf(u) {
  if (!u || !Number.isFinite(u.prompt_tokens) || !Number.isFinite(u.completion_tokens)) return null;
  const details = u.prompt_tokens_details || {};
  return { prompt: u.prompt_tokens, cached: details.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0, completion: u.completion_tokens };
}

function costOf({ prompt, cached, completion }, price) {
  return ((prompt - cached) * price.inputPerM + cached * price.cachedPerM + completion * price.outputPerM) / 1e6;
}

// Из потока достаём только поле usage; содержимое идёт клиенту и нигде не остаётся.
function usageScanner() {
  const decoder = new TextDecoder();
  let buf = '';
  let usage = null;
  const line = (raw) => {
    const text = raw.trim();
    if (!text.startsWith('data:')) return;
    try {
      const data = JSON.parse(text.slice(5));
      if (data.usage) usage = usageOf(data.usage) || usage;
    } catch { /* [DONE] и служебные строки */ }
  };
  return {
    feed(chunk) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(line);
    },
    finish() {
      if (buf) line(buf);
      return usage;
    },
  };
}

function createServer(config) {
  const {
    dbFile, models, plansFile = null, adminKey = '', globalDailyUsd = 20,
    registerPerDay = 5, loginPer15Min = 10, loginIpPer15Min = LOGIN_IP_PER_15MIN, adminPer15Min = ADMIN_PER_15MIN,
    sessionTtlMs = SESSION_TTL_MS, upstreamTimeoutMs = 120000,
    fetchImpl = globalThis.fetch, now = () => Date.now(), trustProxy = false,
  } = config;
  if (!models || !models.fast) throw new Error('нужна настройка моделей');
  const store = new Store(dbFile, { sessionTtlMs });
  const plans = loadPlans(plansFile);
  const inflight = new Map();
  const secrets = [adminKey, ...Object.values(models).map((m) => m.key).filter(Boolean)];
  const logError = (err) => console.error(redact(`сервер: ${err && err.message ? err.message : err}`, secrets));

  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
  const bearer = (req) => (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '') || [])[1] || '';

  function authed(req) {
    const account = store.accountByToken(bearer(req), now());
    if (!account) throw new HttpError(401, 'unauthorized', 'нужно войти в аккаунт');
    return account;
  }

  function planOf(account) {
    const plan = plans[account.plan];
    if (!plan) throw new HttpError(500, 'bad_plan', 'тариф аккаунта неизвестен');
    return plan;
  }

  function limitsView(account) {
    const t = now();
    const plan = planOf(account);
    const view = {};
    for (const [kind, limit] of [['session', plan.sessionUsd], ['week', plan.weekUsd]]) {
      const w = store.window(account.id, kind, t);
      view[kind] = { percent: Math.min(100, Math.round((w.usedUsd / limit) * 100)), resetAt: w.resetAt };
    }
    return view;
  }

  function checkAllowed(account) {
    const t = now();
    if (account.plan === 'trial' && account.trial_until && t >= account.trial_until) {
      throw new HttpError(402, 'trial_ended', 'пробный период закончился, нужна подписка');
    }
    const plan = planOf(account);
    // Сначала самое позднее время: нельзя обещать продолжение в момент, когда второе окно всё ещё закрыто.
    let resetAt = null;
    let hit = null;
    for (const [kind, limit] of [['session', plan.sessionUsd], ['week', plan.weekUsd]]) {
      const w = store.window(account.id, kind, t);
      if (w.active && w.usedUsd >= limit && (!resetAt || w.resetAt > resetAt)) {
        resetAt = w.resetAt;
        hit = kind;
      }
    }
    if (hit) {
      throw new HttpError(429, 'limit', hit === 'session' ? 'лимит на 5 часов исчерпан' : 'лимит на неделю исчерпан', { window: hit, resetAt, retryAfterMs: resetAt - t });
    }
    if (store.spentSince(t - DAY) >= globalDailyUsd) {
      throw new HttpError(503, 'capacity', 'сервис временно перегружен, попробуйте позже');
    }
  }

  function issue(account) {
    const token = store.issueToken(account.id, now());
    return { token, account: publicAccount(account) };
  }

  function publicAccount(account) {
    const plan = planOf(account);
    return { id: account.id, email: account.email, plan: account.plan, planTitle: plan.title, trialUntil: account.trial_until, limits: limitsView(account) };
  }

  function credentials(body) {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!EMAIL.test(email)) throw new HttpError(400, 'bad_email', 'неверная почта');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'bad_password', 'пароль: от 8 до 200 символов');
    return { email, password };
  }

  async function register(req, res) {
    const { email, password } = credentials(await readJson(req, MAX_AUTH_BODY));
    const t = now();
    if (!store.allowAttempt(`reg:${clientIp(req)}`, { max: registerPerDay, perMs: DAY, now: t })) {
      throw new HttpError(429, 'too_many', 'слишком много регистраций с этого адреса');
    }
    if (store.accountByEmail(email)) throw new HttpError(409, 'exists', 'такой аккаунт уже есть');
    const days = plans.trial.trialDays || 7;
    let account;
    try {
      account = store.createAccount({ email, password, plan: 'trial', trialUntil: t + days * DAY, now: t });
    } catch (err) {
      // Две регистрации одной почты одновременно: UNIQUE — это тоже «уже есть», а не 500.
      if (/UNIQUE|constraint/i.test(String(err && err.message))) throw new HttpError(409, 'exists', 'такой аккаунт уже есть');
      throw err;
    }
    sendJson(res, 201, issue(account));
  }

  async function login(req, res) {
    const { email, password } = credentials(await readJson(req, MAX_AUTH_BODY));
    const ip = clientIp(req);
    // Два предела: по адресу в целом (перебор по разным почтам) и по адресу с почтой.
    if (!store.allowAttempt(`login-ip:${ip}`, { max: loginIpPer15Min, perMs: 15 * 60000, now: now() })) {
      throw new HttpError(429, 'too_many', 'слишком много попыток, подождите 15 минут');
    }
    if (!store.allowAttempt(`login:${ip}:${email}`, { max: loginPer15Min, perMs: 15 * 60000, now: now() })) {
      throw new HttpError(429, 'too_many', 'слишком много попыток, подождите 15 минут');
    }
    const account = store.accountByEmail(email);
    // Один ответ на «нет аккаунта» и «неверный пароль»: нельзя проверять, чья почта зарегистрирована.
    // checkPassword считает scrypt и для несуществующей почты, чтобы ответ не отличался по времени.
    const passwordOk = store.checkPassword(account, password);
    if (!account || account.disabled || !passwordOk) throw new HttpError(401, 'bad_credentials', 'неверная почта или пароль');
    store.upgradePassword(account, password); // старый пароль переписывается с версией алгоритма
    sendJson(res, 200, issue(account));
  }

  async function completions(req, res) {
    const account = authed(req);
    checkAllowed(account);
    const body = await readJson(req, MAX_BODY);
    if (!Array.isArray(body.messages)) throw new HttpError(400, 'bad_request', 'нужен messages');
    // Приложение просит уровень, а не имя модели: неизвестный уровень не должен молча стать дорогим.
    const tier = body.tier === undefined ? 'fast' : body.tier;
    const target = Object.hasOwn(models, tier) ? models[tier] : null;
    if (!target) throw new HttpError(400, 'bad_tier', 'нет такой модели');
    const level = body.level === undefined ? 'low' : body.level;
    if (!Object.hasOwn(THINKING_WEIGHT, level)) throw new HttpError(400, 'bad_level', 'нет такого уровня мышления');
    const running = inflight.get(account.id) || 0;
    if (running >= MAX_INFLIGHT) throw new HttpError(429, 'too_many', 'слишком много запросов одновременно');
    inflight.set(account.id, running + 1);

    // Модель и потолок выхода решает сервер, а не приложение: иначе дорогая модель обошла бы тарифы.
    const out = { model: target.model, max_tokens: Math.min(Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS) };
    for (const key of FORWARD_FIELDS) if (body[key] !== undefined) out[key] = body[key];
    if (out.stream) out.stream_options = { include_usage: true };
    Object.assign(out, target.levels && target.levels[level]);
    const payload = JSON.stringify(out);

    const controller = new AbortController();
    // Медленный провайдер не должен держать слот аккаунта вечно: по сроку отвечаем 504 и освобождаем место.
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, upstreamTimeoutMs);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    const scan = usageScanner();
    let sentBytes = 0;
    store.openWindows(account.id, now());
    try {
      const upstream = await fetchImpl(`${target.url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.key}` },
        body: payload,
        signal: controller.signal,
      });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
      if (upstream.ok) {
        let whole = '';
        for await (const chunk of upstream.body) {
          sentBytes += chunk.length;
          if (out.stream) scan.feed(chunk);
          else if (whole.length < 16 * 1024 * 1024) whole += Buffer.from(chunk).toString('utf8');
          res.write(chunk);
        }
        res.end();
        if (!out.stream) {
          try {
            scan.direct = usageOf(JSON.parse(whole).usage);
          } catch { /* оценка ниже */ }
        }
      } else {
        // Ошибку провайдера не списываем с пользователя; его тело клиенту не отдаём: там могут быть детали нашего счёта.
        for await (const _ of upstream.body) { /* дочитать */ }
        res.end(JSON.stringify({ error: { code: 'upstream', message: `модель ответила ошибкой ${upstream.status}` } }));
        return;
      }
    } catch (err) {
      if (!res.headersSent) {
        if (timedOut) sendJson(res, 504, { error: { code: 'upstream_timeout', message: 'модель не ответила вовремя' } });
        else if (!controller.signal.aborted) sendJson(res, 502, { error: { code: 'upstream', message: 'модель недоступна' } });
      } else if (!res.writableEnded) {
        res.destroy(err);
      }
    } finally {
      clearTimeout(timeout);
      res.off('close', onClose);
      inflight.set(account.id, (inflight.get(account.id) || 1) - 1);
      if (sentBytes > 0 || controller.signal.aborted) chargeFor(account.id, target.price, THINKING_WEIGHT[level], scan.direct || scan.finish(), payload.length, sentBytes);
    }
  }

  // Расход без данных провайдера считаем по верхней оценке: оплата уже могла случиться.
  function chargeFor(accountId, price, weight, usage, requestChars, sentBytes) {
    const estimated = !usage;
    const u = usage || { prompt: Math.ceil(requestChars / CHARS_PER_TOKEN), cached: 0, completion: Math.ceil(sentBytes / CHARS_PER_TOKEN) };
    store.charge(accountId, { usd: costOf(u, price), weight, ...u, estimated, now: now() });
  }

  function admin(req) {
    const limitKey = `admin:${clientIp(req)}`;
    if (store.tooMany(limitKey, { max: adminPer15Min, perMs: 15 * 60000, now: now() })) {
      throw new HttpError(429, 'too_many', 'слишком много служебных запросов, подождите 15 минут');
    }
    const given = Buffer.from(bearer(req));
    const want = Buffer.from(adminKey);
    if (!adminKey || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      store.recordAttempt(limitKey, now()); // считаем только неудачные попытки: рабочие вызовы не блокируются
      throw new HttpError(403, 'forbidden', 'нет доступа');
    }
  }

  async function route(req, res) {
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://x'));
    } catch {
      throw new HttpError(400, 'bad_request', 'неверный адрес');
    }
    const key = `${req.method} ${pathname}`;
    switch (key) {
      case 'GET /health': return sendJson(res, 200, { ok: true });
      case 'POST /v1/auth/register': return register(req, res);
      case 'POST /v1/auth/login': return login(req, res);
      case 'POST /v1/auth/logout': {
        authed(req);
        store.revokeToken(bearer(req));
        return sendJson(res, 200, { ok: true });
      }
      case 'GET /v1/me': return sendJson(res, 200, publicAccount(authed(req)));
      case 'GET /v1/plans': return sendJson(res, 200, Object.entries(plans).map(([id, p]) => ({ id, title: p.title, priceUsd: p.priceUsd })));
      case 'POST /v1/chat/completions': return completions(req, res);
      case 'POST /v1/admin/plan': {
        // Сюда позже придёт оповещение платёжной системы.
        admin(req);
        const body = await readJson(req, MAX_AUTH_BODY);
        if (!plans[body.plan]) throw new HttpError(400, 'bad_plan', 'нет такого тарифа');
        const target = store.accountByEmail(String(body.email || '').toLowerCase());
        if (!target) throw new HttpError(404, 'not_found', 'нет такого аккаунта');
        store.setPlan(target.id, body.plan);
        return sendJson(res, 200, publicAccount(store.account(target.id)));
      }
      case 'POST /v1/admin/disable': {
        admin(req);
        const body = await readJson(req, MAX_AUTH_BODY);
        const target = store.accountByEmail(String(body.email || '').toLowerCase());
        if (!target) throw new HttpError(404, 'not_found', 'нет такого аккаунта');
        store.setDisabled(target.id, body.disabled !== false);
        return sendJson(res, 200, { ok: true });
      }
      default: throw new HttpError(404, 'not_found', 'нет такого адреса');
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent || res.destroyed || res.writableEnded) return;
      if (err instanceof HttpError) {
        const headers = err.extra.resetAt ? { 'Retry-After': String(Math.max(1, Math.ceil((err.extra.resetAt - now()) / 1000))) } : {};
        // Тело не дочитано: ответ отдаём и закрываем соединение, иначе запрос будет висеть.
        if (err.status === 413) {
          headers.Connection = 'close';
          res.once('finish', () => req.destroy());
        }
        sendJson(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } }, headers);
        return;
      }
      logError(err); // в журнал — только с маскировкой: пропуска, почта и ключи туда не попадают
      sendJson(res, 500, { error: { code: 'internal', message: 'внутренняя ошибка' } });
    });
  });
  // Слоу-клиент не должен держать соединение бесконечно.
  server.requestTimeout = 60 * 1000;
  server.headersTimeout = 30 * 1000;
  server.on('close', () => store.close());
  return { server, store, plans, WINDOW_MS };
}

module.exports = { createServer, redact };
