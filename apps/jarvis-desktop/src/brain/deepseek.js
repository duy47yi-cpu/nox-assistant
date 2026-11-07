'use strict';

// Клиент OpenAI-совместимого chat/completions (DeepSeek через DeepInfra).
// Возвращает {content, reasoningContent, toolCalls}. reasoningContent нужно
// сохранить в assistant-сообщении истории: при вызове инструментов DeepSeek
// в режиме размышлений требует его обратно, иначе HTTP 400 (см. agent/loop.js).
// Замеры вызова (мс, токены, размер запроса, число HTTP-попыток) лежат в неперечислимом поле result.stats.
// Необязательный onUsage(callInfo) вызывается после каждой HTTP-попытки, удачной или нет:
// по нему считается стоимость вызовов (см. cost/meter.js). Его можно задать в конструкторе
// или передать в chat() на один вызов (так делает cost/guard.js); переданный в chat() заменяет конструкторный.
// maxTokens в chat() уходит в запрос полем max_tokens: потолок выходных токенов, на нём держится оценка стоимости.
// beforeAttempt({attempt, purpose}) в chat() — необязательная проверка перед каждой HTTP-попыткой, в том числе повторной.
// Если она бросает ошибку, запроса не будет и ошибка уходит наверх (так страж проверяет бюджет на каждую попытку).

const DEFAULT_TIMEOUT_MS = 120000;
// Поток: нет первого байта или новой части столько времени — запрос завис. Без части текста повторяем один раз.
const FIRST_BYTE_MS = 20000;
const STREAM_IDLE_MS = 30000;
const DEFAULT_PURPOSE = 'chat';

function codedError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

function abortError() {
  const err = new Error('запрос отменён');
  err.name = 'AbortError';
  return err;
}

const ACCOUNT_CODES = new Set(['limit', 'trial_ended', 'unauthorized', 'capacity', 'too_many']);

function httpError(status, text) {
  let detail = text;
  try {
    const { error } = JSON.parse(text);
    detail = error.message || text;
    // Ответ сервера Nox о подписке: сообщение уже для человека, технических подробностей не нужно.
    if (ACCOUNT_CODES.has(error.code)) return codedError('http', detail, { status, accountCode: error.code, window: error.window, resetAt: error.resetAt, retryAfterMs: error.retryAfterMs });
  } catch {
    // тело не в JSON-формате ошибки: показываем как есть
  }
  return codedError('http', `Модель ответила ошибкой ${status}: ${String(detail).slice(0, 300)}`, { status });
}

// Аргументы приходят строкой JSON. Пустая строка означает «без параметров».
function parseArgs(raw) {
  const text = String(raw ?? '');
  const parsed = text.trim() === '' ? {} : JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('аргументы должны быть JSON-объектом');
  }
  return parsed;
}

function parseToolCall(tc) {
  const name = (tc.function && tc.function.name) || '';
  try {
    return { id: tc.id, name, args: parseArgs(tc.function && tc.function.arguments), argsError: null };
  } catch (err) {
    // Битый JSON не роняет ход: агент вернёт модели ошибку инструмента.
    return { id: tc.id, name, args: null, argsError: err.message };
  }
}

function num(v) {
  return Number.isFinite(v) ? v : null;
}

// Счётчики токенов из usage. Имена полей у провайдеров разные, берём что есть.
function usageStats(usage) {
  const u = usage || {};
  const prompt = u.prompt_tokens_details || {};
  const completion = u.completion_tokens_details || {};
  return {
    promptTokens: num(u.prompt_tokens),
    cachedTokens: num(prompt.cached_tokens) ?? num(u.prompt_cache_hit_tokens),
    completionTokens: num(u.completion_tokens),
    reasoningTokens: num(completion.reasoning_tokens),
  };
}

// Служебная разметка вызова инструмента у MiniMax: иногда приходит в текст ответа. Это не слова модели.
const MODEL_MARKUP = /\]?<?\]minimax\[>\[[\s\S]*?(?:\]?<?\]minimax\[>\[<\/tool_call>|$)/gi;
const cleanContent = (text) => String(text || '').replace(MODEL_MARKUP, '').trim();

function parseCompletion(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw codedError('bad_response', 'Ответ модели не JSON');
  }
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) throw codedError('bad_response', 'В ответе нет choices[0].message');
  return {
    result: {
      content: cleanContent(msg.content),
      reasoningContent: msg.reasoning_content || null,
      toolCalls: (msg.tool_calls || []).map(parseToolCall).map((c) => (c.argsError && data.choices[0].finish_reason === 'length'
        // Обрезано потолком длины, а не ошибка модели: повторять то же бесполезно, подсказываем выход.
        ? { ...c, argsError: 'ответ не поместился в предел длины и обрезан. Раздели содержимое на части и записывай по одной' }
        : c)),
    },
    usage: usageStats(data.usage),
  };
}

// usage из тела ответа (в виде usageStats) или null: тело не JSON либо usage в нём нет.
function responseUsage(text) {
  try {
    const data = JSON.parse(text);
    const usage = data && data.usage;
    return usage && typeof usage === 'object' ? usageStats(usage) : null;
  } catch {
    return null;
  }
}

// Читает SSE и собирает то же тело, что вернул бы запрос без потока: разбор и учёт токенов дальше общие.
// Поток, оборвавшийся без конца, — ошибка: частичный ответ нельзя принять за полный.
async function readStream(res, onDelta, call) {
  const decoder = new TextDecoder();
  const msg = { content: '', reasoning_content: '', tool_calls: [] };
  let usage;
  let finish = null;
  let buf = '';
  let ended = false;
  const line = (raw) => {
    if (!raw.startsWith('data:')) return;
    const data = raw.slice(5).trim();
    if (data === '[DONE]') { ended = true; return; }
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.error) throw codedError('bad_response', `Ошибка в потоке модели: ${String(json.error.message || json.error).slice(0, 300)}`);
    if (json.usage) usage = json.usage;
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) { ended = true; finish = choice.finish_reason; }
    const d = choice.delta || {};
    if (d.reasoning_content) msg.reasoning_content += d.reasoning_content;
    if (d.content) {
      msg.content += d.content;
      call.emitted = true;
      onDelta(d.content);
    }
    for (const tc of d.tool_calls || []) {
      const slot = msg.tool_calls[tc.index || 0] || (msg.tool_calls[tc.index || 0] = { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) slot.id = tc.id;
      if (tc.function && tc.function.name) slot.function.name += tc.function.name;
      if (tc.function && tc.function.arguments) slot.function.arguments += tc.function.arguments;
    }
  };
  for await (const chunk of res.body) {
    call.onChunk();
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) line(l.trim());
  }
  if (buf.trim()) line(buf.trim());
  if (!ended) {
    call.emitted = true; // запрос уже оплачен: повторять автоматически нельзя
    throw codedError('stream_cut', 'Поток ответа модели оборвался');
  }
  return JSON.stringify({ choices: [{ finish_reason: finish, message: { ...msg, reasoning_content: msg.reasoning_content || null } }], usage });
}

function normalizePurpose(purpose) {
  return typeof purpose === 'string' && purpose.trim() ? purpose.trim() : DEFAULT_PURPOSE;
}

function reportHookError(err) {
  console.error(`DeepSeek onUsage: ${err && err.message ? err.message : err}`);
}

// Режим размышлений. По умолчанию ('', 'default', 'on') запрос не меняется.
// 'off' просит провайдера не размышлять. Поля зависят от провайдера:
// у api.deepseek.com это thinking:{type:'disabled'}, у DeepInfra и других
// OpenAI-совместимых — reasoning_effort:'none' и chat_template_kwargs.thinking=false.
function normalizeReasoning(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'off' || v === 'none' || v === 'false' || v === '0' ? 'off' : 'default';
}

function reasoningFields(baseUrl) {
  if (/api\.deepseek\.com/i.test(baseUrl)) return { thinking: { type: 'disabled' } };
  return { reasoning_effort: 'none', chat_template_kwargs: { thinking: false } };
}

class DeepSeekClient {
  // onUsage(callInfo) — необязательный учёт попыток. callInfo = {model, purpose, ok, usage, requestChars, attempts}:
  // ok — HTTP-ответ 2xx; usage — счётчики токенов из ответа (как в stats) или null, если ответа нет
  // (сеть, таймаут, отмена) или в нём нет usage; attempts — номер попытки в этом вызове chat.
  // chat({ onUsage }) заменяет этот хук на один вызов. Ошибка в onUsage пишется в консоль и не ломает вызов модели.
  constructor({ baseUrl, apiKey, model, fetchImpl, timeoutMs, reasoning, onUsage, firstByteMs, streamIdleMs } = {}) {
    this.firstByteMs = firstByteMs || FIRST_BYTE_MS;
    this.streamIdleMs = streamIdleMs || STREAM_IDLE_MS;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || '';
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this.reasoning = normalizeReasoning(reasoning);
    // Провайдер отверг поля отключения размышлений (HTTP 400): дальше их не шлём.
    this.reasoningRejected = false;
    // Провайдер отверг потоковый запрос (HTTP 400): дальше идём без потока.
    this.streamRejected = false;
    this.onUsage = typeof onUsage === 'function' ? onUsage : null;
  }

  // tools — список в формате OpenAI: [{type:'function', function:{name, description, parameters}}].
  // toolChoice: 'auto' (по умолчанию) или 'none' — ответить текстом, не вызывая инструменты.
  // purpose — метка вызова для учёта стоимости ('chat' по умолчанию); в запрос не уходит.
  // maxTokens — необязательный потолок выходных токенов (целое > 0), в запросе — max_tokens.
  // onUsage — необязательный учёт попыток только этого вызова, вместо конструкторного; в запрос не уходит.
  // beforeAttempt — проверка перед каждой HTTP-попыткой этого вызова (см. шапку файла); в запрос не уходит.
  // onDelta(text) — части текста ответа по мере прихода (поток). Без него запрос прежний. Провайдер без потока: части не придут, итог тот же.
  // У результата есть неперечислимое поле stats: замеры вызова для журнала ходов.
  async chat({ messages, tools, signal, toolChoice, purpose, maxTokens, onUsage, beforeAttempt, onDelta, tier, thinking, levelFields } = {}) {
    if (!this.apiKey) throw codedError('no_key', 'Не задан ключ мозга (NOX_BRAIN_KEY)');
    if (signal && signal.aborted) throw abortError();
    const hasMaxTokens = maxTokens !== undefined && maxTokens !== null;
    // Негодный потолок не отбрасываем молча: без него выход ничем не ограничен и оценка стоимости неверна.
    if (hasMaxTokens && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      throw codedError('bad_args', `maxTokens должен быть целым числом больше 0, получено: ${maxTokens}`);
    }

    // Счётчик HTTP-попыток этого вызова: повтор при сбое сети и повтор без полей размышлений.
    const call = {
      purpose: normalizePurpose(purpose),
      attempts: 0,
      onUsage: typeof onUsage === 'function' ? onUsage : null,
      beforeAttempt: typeof beforeAttempt === 'function' ? beforeAttempt : null,
      onDelta: typeof onDelta === 'function' ? onDelta : null,
      emitted: false,
    };
    const body = { model: this.model, messages };
    // Уровень модели понимает только сервер Nox; провайдеру напрямую его не шлём.
    if (this.sendTier) {
      if (tier) body.tier = tier;
      if (thinking) body.level = thinking;
    } else if (levelFields) Object.assign(body, levelFields);
    // Пустой список инструментов не отправляем: часть провайдеров отвергает tools: [].
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice === 'none' ? 'none' : 'auto';
    }
    if (hasMaxTokens) body.max_tokens = maxTokens;
    const wantOff = !levelFields && !this.sendTier && this.reasoning === 'off' && !this.reasoningRejected;
    if (wantOff) Object.assign(body, reasoningFields(this.baseUrl));

    const streaming = Boolean(call.onDelta) && !this.streamRejected;
    if (streaming) Object.assign(body, { stream: true, stream_options: { include_usage: true } });

    const started = Date.now();
    try {
      let out = await this._postRetry(body, signal, call);
      let reasoning = wantOff ? 'off' : 'default';
      // Поля отключения размышлений провайдер может не знать: один повтор без них.
      // Поток тоже: один общий повтор без необязательных полей, чтобы попыток оставалось не больше MAX_ATTEMPTS стража.
      if ((wantOff || streaming) && out.status === 400) {
        for (const key of Object.keys(reasoningFields(this.baseUrl))) delete body[key];
        delete body.stream;
        delete body.stream_options;
        out = await this._postRetry(body, signal, call);
        // Запоминаем отказ, только если без этих полей запрос прошёл. Если слали и то и другое, сначала считаем виновным поток:
        // на следующем вызове поля размышлений проверятся отдельно.
        if (out.ok && streaming) this.streamRejected = true;
        else if (out.ok) this.reasoningRejected = true;
        if (out.ok && wantOff) reasoning = 'off-rejected';
      }
      if (!out.ok) throw httpError(out.status, out.text);
      const { result, usage } = parseCompletion(out.text);
      const stats = {
        ms: Date.now() - started,
        status: out.status,
        reasoning,
        messages: Array.isArray(messages) ? messages.length : 0,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        requestChars: out.requestChars,
        responseChars: out.text.length,
        ...usage,
        reasoningChars: result.reasoningContent ? result.reasoningContent.length : 0,
        toolCalls: result.toolCalls.length,
        attempts: call.attempts,
      };
      Object.defineProperty(result, 'stats', { value: stats, enumerable: false });
      return result;
    } catch (err) {
      if (err && typeof err === 'object' && !('ms' in err)) err.ms = Date.now() - started;
      throw err;
    }
  }

  // Сетевой сбой (fetch failed) — один повтор через короткую паузу. Таймаут, отмена и ответ сервера не повторяем.
  // Перед каждой попыткой — _beforeAttempt: ошибка проверки выходит наружу, и повторная попытка не уходит.
  async _postRetry(body, signal, call) {
    await this._beforeAttempt(call, signal);
    try {
      return await this._post(body, signal, call);
    } catch (err) {
      // Часть ответа уже показана: повтор задублировал бы текст.
      if (call.emitted || (signal && signal.aborted) || (err && err.code === 'timeout') || (err && err.name === 'AbortError')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 700));
      await this._beforeAttempt(call, signal);
      return this._post(body, signal, call);
    }
  }

  // Проверка перед HTTP-попыткой: уже отменено — запроса нет; хук call.beforeAttempt бросил — запроса нет.
  async _beforeAttempt(call, signal) {
    if (signal && signal.aborted) throw abortError();
    if (call.beforeAttempt) await call.beforeAttempt({ attempt: call.attempts + 1, purpose: call.purpose });
  }

  // Один HTTP-запрос с таймаутом. Возвращает {ok, status, text, requestChars}.
  // Каждая начатая попытка (ответ, сбой сети, таймаут, отмена) считается в call.attempts и уходит в onUsage.
  async _post(body, signal, call = { purpose: DEFAULT_PURPOSE, attempts: 0 }) {
    // Отменили до отправки (например, во время паузы перед повтором): платный запрос не нужен.
    if (signal && signal.aborted) throw abortError();
    const payload = JSON.stringify(body);
    // Один контроллер на отмену извне и на таймаут.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    let stalled = false;
    const onTimer = () => {
      timedOut = !body.stream;
      stalled = Boolean(body.stream);
      controller.abort();
    };
    // Длинный ответ по потоку не ограничен общим сроком: важно только, что части идут.
    let timer = setTimeout(onTimer, body.stream ? this.firstByteMs : this.timeoutMs);
    call.onChunk = () => {
      clearTimeout(timer);
      timer = setTimeout(onTimer, this.streamIdleMs);
    };

    call.attempts += 1;
    let out = null;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: payload,
        signal: controller.signal,
      });
      const isStream = body.stream && res.ok && res.body && call.onDelta
        && /event-stream/i.test((res.headers && res.headers.get && res.headers.get('content-type')) || '');
      const text = isStream ? await readStream(res, call.onDelta, call) : await res.text();
      out = { ok: res.ok, status: res.status, text, requestChars: payload.length };
      return out;
    } catch (err) {
      if (timedOut) throw codedError('timeout', `Модель не ответила за ${this.timeoutMs} мс`);
      if (stalled) throw codedError('stalled', 'Модель перестала отвечать');
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      this._reportUsage(call, out, payload.length);
    }
  }

  // Сообщает onUsage о завершённой HTTP-попытке; out === null — ответа не было.
  // Хук этого вызова (call.onUsage) важнее конструкторного.
  _reportUsage(call, out, requestChars) {
    const hook = typeof call.onUsage === 'function' ? call.onUsage : this.onUsage;
    if (!hook) return;
    const info = {
      model: this.model,
      purpose: call.purpose,
      ok: Boolean(out && out.ok),
      usage: out ? responseUsage(out.text) : null,
      requestChars,
      attempts: call.attempts,
    };
    try {
      const pending = hook.call(this, info);
      if (pending && typeof pending.then === 'function') pending.then(undefined, reportHookError);
    } catch (err) {
      reportHookError(err);
    }
  }
}

module.exports = { DeepSeekClient, normalizeReasoning };
