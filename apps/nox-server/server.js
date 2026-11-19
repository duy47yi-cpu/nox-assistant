'use strict';

// Сервер Nox: аккаунты, лимиты и пересылка запросов к модели. Ключ провайдера только здесь, приложение его не видит.
// Текст переписки не сохраняется и не пишется в логи: хранится только расход. HTTPS даёт обратный прокси перед сервером.
const http = require('http');
const crypto = require('crypto');
const { Store } = require('./store');
const { loadPlans, WINDOW_MS } = require('./plans');
const { THINKING_WEIGHT } = require('./models');
const { createProxyResolver } = require('./proxy');
const { createLinkService } = require('./link-relay');
const { createStudyInbox } = require('./study-inbox');

const MAX_BODY = 12 * 1024 * 1024; // снимок экрана в base64 плюс история
const MAX_AUTH_BODY = 4096;
const MAX_OUTPUT_TOKENS = 8192;
const MAX_INFLIGHT = 3; // одновременных запросов одного аккаунта: перерасход окна не больше этих запросов
const CHARS_PER_TOKEN = 4; // оценка, когда провайдер не прислал расход (обрыв, отмена)
const DAY = 24 * 3600 * 1000;
const SESSION_TTL_MS = 30 * DAY;
const DEFAULT_BODY_TIMEOUT_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const FORWARD_FIELDS = ['messages', 'tools', 'tool_choice', 'stream', 'stream_options'];
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/;
const LOGIN_IP_PER_15MIN = 60; // общий предел попыток входа с адреса, чтобы перебор не шёл по разным почтам
const ADMIN_PER_15MIN = 20; // неудачные попытки со служебным ключом
const LIMIT_LABELS = { session: 'лимит на 5 часов', day: 'дневной лимит', week: 'лимит на неделю' };

function planWindows(plan) {
  return [['session', plan.sessionUsd], ['day', plan.dayUsd], ['week', plan.weekUsd]];
}

function scheduleBoundedTimer(delayMs, fn) {
  if (!Number.isFinite(delayMs)) return { clear() {} };
  let timer = null;
  let cancelled = false;
  const arm = (remaining) => {
    if (cancelled) return;
    const step = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(remaining)));
    timer = setTimeout(() => {
      if (cancelled) return;
      const left = remaining - step;
      if (left > 0) arm(left);
      else fn();
    }, step);
    if (typeof timer.unref === 'function') timer.unref();
  };
  arm(delayMs);
  return {
    clear() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// Маскировка секретов для журнала: пропуск, заголовок, почта, билеты и известные ключи не должны попасть в лог.
function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    const value = String(secret || '');
    if (value.length >= 6) out = out.split(value).join('***');
  }
  return out
    .replace(/nox_[A-Za-z0-9_-]{8,}/g, 'nox_***')
    .replace(/((?:Bearer|Basic)\s+)\S+/gi, '$1***')
    .replace(/(x-nox-join-ticket\s*[:=]\s*)[^\s,;'"}\]]+/gi, '$1***')
    .replace(/("(?:hostTicket|clientTicket|joinTicket|ticket|token|accessToken|refreshToken|password|pass|secret|adminKey|authorization|api[_-]?key|x-api-key)"\s*:\s*")([^"]*)(")/gi, '$1***$3')
    .replace(/(\b(?:hostTicket|clientTicket|joinTicket|ticket|token|password|secret|adminKey|x-api-key|api[_-]?key)\s*[=:]\s*)([^\s&;,'"\n\r]+)/gi, '$1***')
    .replace(/([?&](?:token|ticket|joinTicket|hostTicket|clientTicket|key|secret|password|api[_-]?key|x-api-key)=)([^&#\s]+)/gi, '$1***')
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '***')
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

function readBody(req, max, timeoutMs = DEFAULT_BODY_TIMEOUT_MS, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new HttpError(503, 'server_closing', 'сервер завершает работу'));
      return;
    }
    if (req.aborted || req.destroyed) {
      reject(new HttpError(499, 'request_aborted', 'запрос прерван клиентом'));
      return;
    }
    const parts = [];
    let size = 0;
    let settled = false;
    let timer = null;

    const onSignalAbort = () => {
      fail(new HttpError(503, 'server_closing', 'сервер завершает работу'));
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onSignalAbort);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('close', onClose);
      req.off('error', onError);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > max) {
        // Не рвём соединение сразу: сначала нужно ответить 413, иначе клиент увидит только обрыв.
        req.pause();
        fail(new HttpError(413, 'too_large', 'запрос слишком большой'));
        return;
      }
      parts.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(parts));
    };

    const onAborted = () => {
      fail(new HttpError(499, 'request_aborted', 'запрос прерван клиентом'));
    };

    const onClose = () => {
      if (!req.complete) {
        fail(new HttpError(499, 'request_aborted', 'соединение прервано до завершения запроса'));
      }
    };

    const onError = (err) => {
      if (err && (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'EPIPE')) {
        fail(new HttpError(499, 'request_aborted', 'соединение прервано'));
        return;
      }
      fail(err);
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (typeof req.pause === 'function') req.pause();
        fail(new HttpError(408, 'request_timeout', 'превышено время чтения тела запроса'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    if (signal) signal.addEventListener('abort', onSignalAbort, { once: true });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('close', onClose);
    req.on('error', onError);
  });
}

async function readJson(req, max, timeoutMs = DEFAULT_BODY_TIMEOUT_MS, signal = null) {
  const raw = await readBody(req, max, timeoutMs, signal);
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('не объект');
    return value;
  } catch {
    throw new HttpError(400, 'bad_json', 'тело запроса не JSON-объект');
  }
}

function usageOf(u) {
  const ok = (v) => Number.isFinite(v) && v >= 0 && v < 1e9;
  if (!u || !ok(u.prompt_tokens) || !ok(u.completion_tokens)) return null;
  const details = u.prompt_tokens_details || {};
  const rawCached = details.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const cached = ok(rawCached) ? Math.min(rawCached, u.prompt_tokens) : 0;
  return { prompt: u.prompt_tokens, cached, completion: u.completion_tokens };
}

function costOf({ prompt, cached, completion }, price) {
  const billable = Math.max(0, prompt - cached);
  const raw = (billable * price.inputPerM + Math.max(0, cached) * price.cachedPerM + Math.max(0, completion) * price.outputPerM) / 1e6;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
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
    sessionTtlMs = SESSION_TTL_MS, upstreamTimeoutMs = 120000, bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS,
    fetchImpl = globalThis.fetch, now = () => Date.now(), trustProxy = false, trustedProxies,
    link = false, studyInbox = null,
  } = config;
  if (!models || !models.fast) throw new Error('нужна настройка моделей');
  const effectiveBodyTimeoutMs = Number.isInteger(bodyTimeoutMs) && bodyTimeoutMs >= 0 ? bodyTimeoutMs : DEFAULT_BODY_TIMEOUT_MS;
  const store = new Store(dbFile, { sessionTtlMs });
  const inflight = new Map();
  const activeStreams = new Set();
  const activeHttpRequests = new Set();
  const closeAbortController = new AbortController();
  let closing = false;
  const readBodyJson = (req, max) => readJson(req, max, effectiveBodyTimeoutMs, closeAbortController.signal);
  const plans = loadPlans(plansFile);
  const proxy = createProxyResolver({ trustProxy, trustedProxies });
  const inbox = studyInbox ? createStudyInbox(studyInbox) : null;
  const linkService = link
    ? createLinkService({
        ...(typeof link === 'object' ? link : {}),
        store,
        now,
        trustProxy,
        trustedProxies,
      })
    : null;
  const secrets = [adminKey, ...Object.values(models).map((m) => m.key).filter(Boolean)];
  const logError = (err, extraSecrets = []) => console.error(redact(`сервер: ${err && err.message ? err.message : err}`, [...secrets, ...extraSecrets]));

  const clientIp = (req) => proxy.clientIp(req);
  const bearer = (req) => (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '') || [])[1] || '';

  const unsubTokenRevoked = store.onTokenRevoked((tokenHash) => {
    for (const stream of [...activeStreams]) {
      if (stream.tokenHash === tokenHash) stream.abort();
    }
  });
  const unsubAccountDisabled = store.onAccountDisabled((accountId) => {
    for (const stream of [...activeStreams]) {
      if (stream.accountId === accountId) stream.abort();
    }
  });

  function authedSession(req) {
    const session = store.sessionByToken(bearer(req), now());
    if (!session) throw new HttpError(401, 'unauthorized', 'нужно войти в аккаунт');
    return session;
  }

  function authed(req) {
    return authedSession(req).account;
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
    for (const [kind, limit] of planWindows(plan)) {
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
    for (const [kind, limit] of planWindows(plan)) {
      const w = store.window(account.id, kind, t);
      if (w.active && w.usedUsd >= limit && (!resetAt || w.resetAt > resetAt)) {
        resetAt = w.resetAt;
        hit = kind;
      }
    }
    if (hit) {
      throw new HttpError(429, 'limit', `${LIMIT_LABELS[hit]} исчерпан`, { window: hit, resetAt, retryAfterMs: resetAt - t });
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

  const rateIp = (req) => proxy.rateLimitIpKey(clientIp(req));

  async function register(req, res) {
    const { email, password } = credentials(await readBodyJson(req, MAX_AUTH_BODY));
    const t = now();
    if (!store.allowAttempt(`reg:${rateIp(req)}`, { max: registerPerDay, perMs: DAY, now: t })) {
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
    const { email, password } = credentials(await readBodyJson(req, MAX_AUTH_BODY));
    const ip = rateIp(req);
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
    if (closing) throw new HttpError(503, 'server_closing', 'сервер завершает работу');
    const initialSession = authedSession(req);
    checkAllowed(initialSession.account);
    const body = await readBodyJson(req, MAX_BODY);
    if (closing) throw new HttpError(503, 'server_closing', 'сервер завершает работу');
    if (req.aborted || !req.complete || res.destroyed || res.writableEnded) throw new HttpError(499, 'request_aborted', 'запрос прерван клиентом');
    const { account, tokenHash, expiresAt } = authedSession(req);
    if (account.id !== initialSession.account.id || tokenHash !== initialSession.tokenHash) {
      throw new HttpError(401, 'unauthorized', 'нужно войти в аккаунт');
    }
    checkAllowed(account);
    if (!Array.isArray(body.messages)) throw new HttpError(400, 'bad_request', 'нужен messages');
    // Приложение просит уровень, а не имя модели: неизвестный уровень не должен молча стать дорогим.
    const tier = body.tier === undefined ? 'fast' : body.tier;
    const target = Object.hasOwn(models, tier) ? models[tier] : null;
    if (!target) throw new HttpError(400, 'bad_tier', 'нет такой модели');
    const level = body.level === undefined ? 'low' : body.level;
    if (!Object.hasOwn(THINKING_WEIGHT, level)) throw new HttpError(400, 'bad_level', 'нет такого уровня мышления');
    const running = inflight.get(account.id) || 0;
    if (running >= MAX_INFLIGHT) throw new HttpError(429, 'too_many', 'слишком много запросов одновременно');
    if (closing) throw new HttpError(503, 'server_closing', 'сервер завершает работу');
    if (!store.isTokenActive(tokenHash, now())) throw new HttpError(401, 'unauthorized', 'сеанс завершён');
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
    let sessionInvalidated = false;
    let upstreamCalled = false;
    let expiryTimer = null;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, upstreamTimeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    const streamHandle = {
      accountId: account.id,
      tokenHash,
      abort() {
        sessionInvalidated = true;
        controller.abort();
      },
    };
    activeStreams.add(streamHandle);
    const scan = usageScanner();
    let sentBytes = 0;
    try {
      if (Number.isFinite(expiresAt)) {
        const armExpiry = () => {
          const left = expiresAt - now();
          if (left <= 0 || !store.isTokenActive(tokenHash, now())) {
            streamHandle.abort();
            return;
          }
          expiryTimer = scheduleBoundedTimer(left, armExpiry);
        };
        armExpiry();
      }
      if (sessionInvalidated || closing || !store.isTokenActive(tokenHash, now())) {
        sessionInvalidated = !closing;
        throw new Error(closing ? 'server_closing' : 'session_invalidated');
      }
      store.openWindows(account.id, now());
      if (sessionInvalidated || closing || !store.isTokenActive(tokenHash, now())) {
        sessionInvalidated = !closing;
        throw new Error(closing ? 'server_closing' : 'session_invalidated');
      }
      upstreamCalled = true;
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
          if (sessionInvalidated || !store.isTokenActive(tokenHash, now())) {
            streamHandle.abort();
            break;
          }
          sentBytes += chunk.length;
          if (out.stream) scan.feed(chunk);
          else if (whole.length < 16 * 1024 * 1024) whole += Buffer.from(chunk).toString('utf8');
          res.write(chunk);
        }
        if (sessionInvalidated) {
          if (!res.destroyed) res.destroy();
          return;
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
        if (sessionInvalidated) sendJson(res, 401, { error: { code: 'unauthorized', message: 'сеанс завершён' } });
        else if (closing) sendJson(res, 503, { error: { code: 'server_closing', message: 'сервер завершает работу' } });
        else if (timedOut) sendJson(res, 504, { error: { code: 'upstream_timeout', message: 'модель не ответила вовремя' } });
        else if (!controller.signal.aborted) sendJson(res, 502, { error: { code: 'upstream', message: 'модель недоступна' } });
      } else if (!res.writableEnded) {
        res.destroy(err);
      }
    } finally {
      activeStreams.delete(streamHandle);
      if (expiryTimer) expiryTimer.clear();
      clearTimeout(timeout);
      res.off('close', onClose);
      inflight.set(account.id, (inflight.get(account.id) || 1) - 1);
      if (sentBytes > 0 || (upstreamCalled && controller.signal.aborted)) chargeFor(account.id, target.price, THINKING_WEIGHT[level], scan.direct || scan.finish(), payload.length, sentBytes);
    }
  }

  // Расход без данных провайдера считаем по верхней оценке: оплата уже могла случиться.
  function chargeFor(accountId, price, weight, usage, requestChars, sentBytes) {
    const estimated = !usage;
    const u = usage || { prompt: Math.ceil(requestChars / CHARS_PER_TOKEN), cached: 0, completion: Math.ceil(sentBytes / CHARS_PER_TOKEN) };
    const usd = Math.max(0, costOf(u, price));
    store.charge(accountId, { usd, weight: Math.max(0, weight || 0), ...u, estimated, now: now() });
  }

  function admin(req) {
    const limitKey = `admin:${rateIp(req)}`;
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
        const body = await readBodyJson(req, MAX_AUTH_BODY);
        if (closing) throw new HttpError(503, 'server_closing', 'сервер завершает работу');
        if (!plans[body.plan]) throw new HttpError(400, 'bad_plan', 'нет такого тарифа');
        const target = store.accountByEmail(String(body.email || '').toLowerCase());
        if (!target) throw new HttpError(404, 'not_found', 'нет такого аккаунта');
        store.setPlan(target.id, body.plan);
        return sendJson(res, 200, publicAccount(store.account(target.id)));
      }
      case 'POST /v1/admin/disable': {
        admin(req);
        const body = await readBodyJson(req, MAX_AUTH_BODY);
        if (closing) throw new HttpError(503, 'server_closing', 'сервер завершает работу');
        const target = store.accountByEmail(String(body.email || '').toLowerCase());
        if (!target) throw new HttpError(404, 'not_found', 'нет такого аккаунта');
        store.setDisabled(target.id, body.disabled !== false);
        return sendJson(res, 200, { ok: true });
      }
      default: throw new HttpError(404, 'not_found', 'нет такого адреса');
    }
  }

  const server = http.createServer((req, res) => {
    if (closing) {
      sendJson(res, 503, { error: { code: 'server_closing', message: 'сервер завершает работу' } }, { Connection: 'close' });
      return;
    }
    if (inbox?.matches(req)) return inbox.handle(req, res, sendJson);
    if (linkService && linkService.matchesHttp(req)) {
      linkService.handleHttp(req, res);
      return;
    }
    const reqSecrets = [];
    const tok = bearer(req);
    if (tok) reqSecrets.push(tok);
    const jt = req?.headers?.['x-nox-join-ticket'];
    if (jt) reqSecrets.push(String(jt));

    const reqHandle = {
      abort() {
        if (req.socket && !req.socket.destroyed) {
          try { req.socket.destroy(); } catch { /* ignore */ }
        }
        if (typeof req.destroy === 'function' && !req.destroyed) {
          try { req.destroy(); } catch { /* ignore */ }
        }
        if (typeof res.destroy === 'function' && !res.destroyed && !res.writableEnded) {
          try { res.destroy(); } catch { /* ignore */ }
        }
      },
    };
    activeHttpRequests.add(reqHandle);

    route(req, res)
      .catch((err) => {
        if (err instanceof HttpError && err.code === 'request_aborted') {
          if (!res.headersSent && !res.destroyed && !res.writableEnded) {
            try { sendJson(res, 499, { error: { code: err.code, message: err.message } }, { Connection: 'close' }); } catch { /* ignore */ }
          }
          return;
        }
        if (res.headersSent || res.destroyed || res.writableEnded) return;
        if (err instanceof HttpError) {
          const headers = err.extra.resetAt ? { 'Retry-After': String(Math.max(1, Math.ceil((err.extra.resetAt - now()) / 1000))) } : {};
          // Тело не дочитано: ответ отдаём и закрываем соединение, иначе запрос будет висеть.
          if (err.status === 413 || err.status === 408) {
            headers.Connection = 'close';
            res.once('finish', () => req.destroy());
          }
          sendJson(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } }, headers);
          return;
        }
        logError(err, reqSecrets); // в журнал — только с маскировкой: пропуска, почта и ключи туда не попадают
        sendJson(res, 500, { error: { code: 'internal', message: 'внутренняя ошибка' } });
      })
      .finally(() => {
        activeHttpRequests.delete(reqHandle);
      });
  });
  if (linkService) {
    server.on('upgrade', (req, socket, head) => {
      if (linkService.matchesUpgrade(req)) {
        linkService.handleUpgrade(req, socket, head);
      } else {
        if (socket && !socket.destroyed) socket.destroy();
      }
    });
  }
  // Слоу-клиент не должен держать соединение бесконечно.
  server.requestTimeout = 60 * 1000;
  server.headersTimeout = 30 * 1000;
  const origClose = server.close.bind(server);
  server.once('listening', () => { if (inbox && studyInbox.poll !== false) inbox.start(); });
  server.close = (cb) => {
    closing = true;
    closeAbortController.abort();
    inbox?.stop();
    if (linkService) linkService.close();
    for (const s of [...activeStreams]) s.abort();
    for (const r of [...activeHttpRequests]) r.abort();
    activeHttpRequests.clear();
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return origClose(cb);
  };
  server.on('close', () => {
    unsubTokenRevoked();
    unsubAccountDisabled();
    if (linkService) linkService.close();
    store.close();
  });
  return { server, store, plans, WINDOW_MS, link: linkService, studyInbox: inbox };
}

module.exports = { createServer, redact };
