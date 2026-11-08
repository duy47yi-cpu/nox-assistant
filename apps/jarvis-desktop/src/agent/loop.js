'use strict';

const { randomUUID } = require('crypto');
const path = require('path');
const { decide: defaultDecide, allowKey, isOneShot } = require('../policy/modes');
const { isTaintSource, isForeignTextSource } = require('../policy/taint');
const { TurnLog } = require('./turnlog');
const { checkEffect } = require('./effects');
const { uniqueSearchMatch } = require('../tools/install');

// Лимит вызовов инструментов за один ход: защита от зацикливания модели.
const MAX_TOOL_STEPS = 12;
// Сколько раз за ход можно выполнить один и тот же вызов с теми же аргументами.
const MAX_REPEATS = 2;
// Чтение живого состояния рабочего стола: тот же вызов через шаг даёт другой ответ, это не зацикливание (предел — maxSteps).
const LIVE_STATE_READS = new Set(['ui_windows', 'ui_elements', 'windows_list', 'workspace_list', 'ui_wait', 'wait_for']);
// Прошлые ходы уходят в модель в сжатом виде: длинные ответы инструментов и размышления
// там уже не нужны целиком, а каждый символ замедляет запрос.
const OLD_TOOL_CHARS = 1500;
const OLD_REASONING_CHARS = 200;
// Ответ, если модель после зацикливания так и не дала текста.
const NEEDS_HUMAN_TEXT = 'Нужен человек: сайт просит подтверждение (капча или второй вход), сам я его не прохожу. Окно браузера показано на экране — разберись в нём и напиши мне, тогда продолжу.';
const LOOP_FALLBACK ='Не получилось довести дело до конца: инструмент возвращал один и тот же результат. Скажите, как поступить.';
// Чтение настоящего состояния. Успешный вызов снимает пометку «исход неизвестен», и действие можно повторить.
const STATE_READERS = new Set(['desktop_observe', 'screen_look', 'ui_elements', 'ui_windows', 'windows_list', 'browser_read', 'workspace_list', 'workspace_read']);

// ── Событие прогресса ────────────────────────────────────────────────────────
// Действующий протокол не переименовывается: тип события (status/tool_start/tool_result/approval_request/
// error/done) и поле state остаются прежними. События расширяются полями прогресса, которые окно может
// игнорировать: runId (один на запуск), step (порядковый номер шага), status (planning/running/
// awaiting_approval/verifying/succeeded/unverified/failed/cancelled), label (без текста модели и
// без секретов), target (только безопасные поля аргументов), verification (итог проверки инструмента).
// Итог всего запуска приходит в done: {runId, outcome, status, verification, history}.
const PROGRESS_STATUSES = new Set(['planning', 'running', 'awaiting_approval', 'verifying', 'succeeded', 'unverified', 'failed', 'cancelled']);
// Только эти аргументы попадают в событие как цель: текст, команды, содержимое и прочее не уходят.
const SAFE_TARGET_KEYS = ['path', 'url', 'file', 'name', 'window', 'app', 'query', 'id', 'to', 'minutes'];
const SAFE_TARGET_CHARS = 120;

// Безопасная цель шага: из аргументов берутся лишь явно разрешённые поля, длинные значения обрезаются.
function safeTarget(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const out = {};
  for (const key of SAFE_TARGET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.length > SAFE_TARGET_CHARS ? `${value.slice(0, SAFE_TARGET_CHARS - 1)}…` : value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// Что человекочитаемо сказать о шаге: только статус и имя инструмента, без summary и аргументов.
const STEP_WORDS = {
  running: 'выполняю действие',
  awaiting_approval: 'жду вашего решения',
  verifying: 'проверяю результат',
  succeeded: 'шаг выполнен',
  unverified: 'шаг выполнен, но не проверен',
  failed: 'шаг не выполнен',
  cancelled: 'шаг остановлен',
};

// Наблюдение должно относиться к области действия: просмотр другой папки или другого окна
// не позволяет повторить действие с неизвестным исходом.
function relevantObservation(reader, readArgs, action, actionArgs, workspace) {
  const r = readArgs || {};
  const a = actionArgs || {};
  if (reader === 'screen_look') return /^(ui_|mouse_|windows_|desktop_)/.test(action);
  // Снимок сцены снимает и неизвестность после составных рук: desktop_click/desktop_type.
  if (reader === 'desktop_observe') return /^(ui_|mouse_|windows_|desktop_)/.test(action);
  if (reader === 'ui_elements') {
    return /^ui_/.test(action) && typeof r.window === 'string' && typeof a.window === 'string'
      && r.window.trim().toLocaleLowerCase() === a.window.trim().toLocaleLowerCase();
  }
  if (reader === 'ui_windows' || reader === 'windows_list') return /^(windows_|ui_focus)/.test(action);
  if (reader === 'browser_read') return /^browser_/.test(action);
  if (!['workspace_read', 'workspace_list'].includes(reader)) return false;
  if (!/^(workspace_|document_)/.test(action)) return false;
  const targets = [a.path, a.from, a.to].filter((p) => typeof p === 'string' && p.trim());
  if (!targets.length || (reader === 'workspace_read' && targets.length !== 1)) return false;
  const key = (p) => {
    const resolved = path.resolve(workspace, p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (reader === 'workspace_read') return typeof r.path === 'string' && key(r.path) === key(targets[0]);
  const parent = key(typeof r.path === 'string' ? r.path : '.');
  return targets.every((target) => key(path.dirname(key(target))) === parent);
}

function errText(err) {
  return (err && err.message) || String(err);
}

// Метка ошибки для журнала ходов. Сетевой сбой приходит как TypeError «fetch failed»,
// а причина (ECONNRESET, UND_ERR_CONNECT_TIMEOUT и т.п.) лежит в err.cause.
function errLabel(err) {
  const base = (err && (err.code || err.name)) || 'error';
  const cause = err && err.cause && (err.cause.code || err.cause.name);
  return cause ? `${base}:${cause}` : base;
}

// Вызов инструмента без ответа (сбой посреди хода в прошлом запуске) ломает запрос к модели.
// Дописываем ответ-заглушку сразу после вызова, чтобы история снова была цельной.
function repairToolHistory(history) {
  const out = [];
  for (let i = 0; i < history.length; i += 1) {
    const m = history[i];
    out.push(m);
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    const answered = new Set();
    while (i + 1 < history.length && history[i + 1].role === 'tool') {
      i += 1;
      out.push(history[i]);
      answered.add(history[i].tool_call_id);
    }
    for (const call of m.tool_calls) {
      if (!answered.has(call.id)) {
        out.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, summary: 'нет ответа: ход прервался до записи результата' }) });
      }
    }
  }
  return out;
}

function safeJson(result) {
  try {
    return JSON.stringify(result);
  } catch {
    return JSON.stringify({ ok: Boolean(result.ok), summary: String(result.summary) });
  }
}

// JSON с отсортированными ключами: {a,b} и {b,a} считаются одним и тем же вызовом.
function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const declaresPath = (tool) => {
  const props = tool.parameters && tool.parameters.properties;
  return Boolean(props && (props.path || (props.from && props.to)));
};

function toWireToolCall(call) {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
  };
}

// Сообщение прошлого хода в сжатом виде. История в памяти не меняется, меняется только копия для запроса.
// reasoning_content у вызовов инструментов оставляем (коротким): часть провайдеров требует его наличия.
function compactOld(m) {
  if (m.role === 'assistant' && m.reasoning_content) {
    const copy = { ...m };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      copy.reasoning_content = String(m.reasoning_content).slice(0, OLD_REASONING_CHARS);
    } else {
      delete copy.reasoning_content;
    }
    return copy;
  }
  if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > OLD_TOOL_CHARS) {
    return { ...m, content: `${m.content.slice(0, OLD_TOOL_CHARS)} …(обрезано)` };
  }
  return m;
}

// Копия сообщения пользователя с пометкой времени в начале. В историю не попадает.
function stampMessage(m, stamp) {
  if (Array.isArray(m.content)) return { ...m, content: [{ type: 'text', text: stamp }, ...m.content] };
  return { ...m, content: `${stamp}\n${m.content}` };
}

// Сообщение для запроса. Картинка от инструмента (поле image) уходит модели только в текущем ходу,
// в прошлых ходах остаётся текстом. Поле image в запрос не попадает.
function wireMessage(m, current) {
  if (!m.image) return current ? m : compactOld(m);
  if (!current) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      { type: 'text', text: m.content },
      { type: 'image_url', image_url: { url: m.image } },
    ],
  };
}

class Agent {
  constructor({
    brain, tools, policy, approvals, journal, emit,
    mode = 'ask', workspace = process.cwd(), systemPrompt = '', history = [], maxContext = 60,
    turnsLog = null, clock = null, stop = null, maxSteps = MAX_TOOL_STEPS, stream = false, context = null, background = false, closeOnLimit = false, tier = null, thinking = null, lookFirst = false,
    // Потолок времени одного хода в чате: длинная цепочка шагов не должна держать владельца молча.
    // 0 — без потолка (фон, миссии и исполнитель считают время сами).
    turnDeadlineMs = 0,
  } = {}) {
    this.brain = brain;
    // После перезапуска неизвестно, что стало с окнами: действия запрещены, пока не сделан снимок экрана.
    this.lookFirst = Boolean(lookFirst);
    // Шаги кончились: не обрывать ход, а дать модели один ответ текстом с тем, что уже собрано.
    this.closeOnLimit = Boolean(closeOnLimit);
    this.tier = tier; // какая модель нужна этому агенту: уровень решает сервер Nox
    this.thinking = thinking; // null — берётся настройка владельца; фон задаёт низкое явно
    this.background = Boolean(background); // фоновая задача: уступает рабочий стол владельцу
    // Лимит вызовов инструментов за ход. Фоновые задачи получают больше: им не на кого отвлекаться.
    this.maxSteps = maxSteps > 0 ? maxSteps : MAX_TOOL_STEPS;
    // Потолок времени хода: проверяется между шагами, чтобы не оборвать действие на середине.
    this.turnDeadlineMs = Number.isFinite(turnDeadlineMs) && turnDeadlineMs > 0 ? turnDeadlineMs : 0;
    // Аварийный стоп (StopSwitch). Без него агент работает как раньше. Имя поля не stop: это метод агента.
    this.stopSwitch = stop;
    this.tools = tools;
    // policy может быть модулем с decide() или самой функцией
    this.policy = typeof policy === 'function' ? null : policy;
    this.decide = typeof policy === 'function' ? policy : (policy && policy.decide) || defaultDecide;
    this.approvals = approvals;
    this.journal = journal;
    this.mode = mode;
    this.workspace = workspace;
    this.systemPrompt = systemPrompt;
    // сообщения user/assistant/tool без system-промпта; history — сохранённый разговор с прошлого запуска
    this.history = Array.isArray(history) ? history : [];
    // В модель уходит только хвост разговора: короче запрос — быстрее ответ.
    this.maxContext = maxContext;
    // Время добавляется к последнему сообщению пользователя, а не к системному промпту: так кэш промпта не сбивается.
    this.clock = typeof clock === 'function' ? clock : null;
    // Показывать ответ модели по мере прихода. Фоновым агентам не нужно: их текст идёт в отчёт целиком.
    this.stream = Boolean(stream);
    // context(текст хода) → короткая справка к сообщению пользователя (память). Как и время, в историю не попадает.
    this.context = typeof context === 'function' ? context : null;
    this._turnContext = '';
    // Журнал скорости (turns.jsonl). Без пути выключен.
    this.turnLog = turnsLog instanceof TurnLog ? turnsLog : new TurnLog(turnsLog);
    this.sessionAllow = new Set(); // имена инструментов, одобренных «на сессию»
    // Аварийный стоп отзывает одобрения «на сессию»: после «Возобновить» всё спрашивается заново.
    if (stop && typeof stop.onTrigger === 'function') stop.onTrigger(() => this.sessionAllow.clear());
    this._turnCalls = new Map();
    this._unknownCalls = new Map(); // ключ вызова → имя: действия с неизвестным исходом в этом ходу, вслепую не повторяем
    this._turn = null; // замеры текущего хода
    this._emitFn = typeof emit === 'function' ? emit : () => {};
    this._controller = null; // AbortController идущего хода; null, если хода нет
    this._pendingImages = []; // снимки от инструментов, которые ещё не попали в историю
    // Прогресс запуска: runId = id хода (связывает turns.jsonl, журнал и события окна).
    this._runId = null;
    this._runClosed = false; // итог запуска отправлен: поздние события этого запуска окну не идут
    this._step = 0; // порядковый номер шага (вызова инструмента) в запуске
    this._startedAt = null; // ISO-время начала запуска
    this._calls = []; // безопасная сводка шагов запуска для done.history (без аргументов и текстов)
    this._verification = { confirmed: 0, unverified: 0, failed: 0, reads: 0 };
  }

  // Первый запрос после простоя в разы медленнее: соединение и кэш промпта холодные. Прогрев тем же началом запроса, один токен ответа.
  async warm() {
    if (this._controller) return false;
    try {
      const system = typeof this.systemPrompt === 'function' ? this.systemPrompt() : this.systemPrompt;
      await this.brain.chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: '.' }], tools: this._toolSpecs(), maxTokens: 1, purpose: 'warmup' });
      return true;
    } catch (err) {
      console.warn(`Прогрев не удался: ${errText(err)}`);
      return false;
    }
  }

  // Смена режима отзывает одобрения «на сессию»: они давались при другом режиме.
  setMode(mode) {
    this.mode = mode;
    this.sessionAllow.clear();
  }

  // Ответы, которые дали без модели (музыка), тоже попадают в историю: иначе на следующей реплике модель их не видит.
  remember(userText, assistantText) {
    this.history.push({ role: 'user', content: String(userText) }, { role: 'assistant', content: String(assistantText) });
  }

  // ownerText — то, что владелец сам написал в чате (без приложенных файлов). Только по нему политика узнаёт его слова;
  // у фоновых агентов его нет, и запись профиля там всегда с вопросом.
  async run(userText, { ownerText = '' } = {}) {
    if (this._controller) throw new Error('ход уже выполняется');
    const controller = new AbortController();
    this._controller = controller;
    this._ownerText = String(ownerText || '');
    this._installEvidence = null;
    this._tainted = false; // в этом ходу уже был недоверенный текст (страница, экран, файл, MCP)
    this._foreign = false; // а это — именно чужой текст (страница, файл, буфер, MCP), после которого руки идут с вопросом
    this._turnCalls = new Map(); // повторы вызовов считаем в пределах одного хода
    this._unknownCalls = new Map();
    // Новый запуск: снимаем признак «итог отправлен» и обнуляем прогресс предыдущего запуска.
    this._runClosed = false;
    this._step = 0;
    this._calls = [];
    this._verification = { confirmed: 0, unverified: 0, failed: 0, reads: 0 };
    const text = userText == null ? '' : String(userText);
    this._turn = {
      id: randomUUID().slice(0, 8),
      started: Date.now(),
      userChars: text.length,
      modelCalls: 0,
      modelMs: 0,
      toolCalls: 0,
      toolWallMs: 0,
      waitMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      reasoningChars: 0,
      answerChars: 0,
      outcome: null,
    };
    // runId связан с ходом: тот же id пишется в turns.jsonl, события окна и журнал действий.
    this._runId = this._turn.id;
    this._startedAt = new Date(this._turn.started).toISOString();
    this.history.push({ role: 'user', content: text });
    this._turnContext = '';
    if (this.context) {
      try {
        this._turnContext = String(this.context(text) || '');
      } catch (err) {
        console.warn(`Справка к ходу не собрана: ${errText(err)}`);
      }
    }
    let finalOutcome = null;
    this.lastError = null; // текст ошибки хода для дел: итог run() остаётся {ok, outcome}
    // Аварийный стоп прерывает идущий запрос и инструмент у любого агента (чат, миссия, Telegram), а не только между шагами.
    const offStop = this.stopSwitch ? this.stopSwitch.onTrigger(() => { if (!controller.signal.aborted) this.stop(); }) : null;
    try {
      await this._loop(controller.signal);
    } catch (err) {
      this._turn.outcome = controller.signal.aborted ? 'stopped' : 'error';
      this.lastError = errText(err);
      // При отмене done уже отправлен из stop(), поэтому молчим.
      if (!controller.signal.aborted) {
        this._emit({ type: 'error', message: errText(err), ...(this._runId ? { runId: this._runId } : {}), status: 'failed' });
        this._status('error');
        // done с честным итогом: ошибка — не успех. Статус ошибки уже показан, idle не перебиваем.
        this._endTurn({ idle: false });
      }
    } finally {
      if (controller.signal.aborted && !this._turn.outcome) this._turn.outcome = 'stopped';
      finalOutcome = this._turn.outcome;
      if (offStop) offStop();
      this._logTurn();
      this._installEvidence = null;
      this._controller = null;
    }
    // Честный итог хода: ok только если модель дала ответ. Лимит, зацикливание, ошибка и стоп — не успех.
    return { ok: finalOutcome === 'answer', outcome: finalOutcome };
  }

  // Остановка идущего хода. Вызов без хода ничего не шлёт в окно: лишний done не должен появляться.
  stop() {
    if (!this._controller) return;
    if (this._turn && !this._turn.outcome) this._turn.outcome = 'stopped';
    try {
      this._controller.abort();
    } catch {
      // AbortController.abort() не бросает; страховка на случай подменённого контроллера.
    }
    this._endTurn();
  }

  // true, если включён аварийный стоп: новых действий и вызовов модели быть не должно.
  _stopped() {
    return Boolean(this.stopSwitch && this.stopSwitch.isStopped());
  }

  async _loop(signal) {
    let steps = 0;
    let round = 0;
    // true после зацикливания: следующий запрос просит ответ текстом, без инструментов.
    let answerOnly = false;
    for (;;) {
      // Ход уже отменён (stop/cancel): поздний ответ модели не возобновляет запуск и не идёт в окно.
      if (signal.aborted) {
        if (this._turn && !this._turn.outcome) this._turn.outcome = 'stopped';
        return this._endTurn();
      }
      if (this._stopped()) {
        this._turn.outcome = 'stopped';
        this._emit({ type: 'text', delta: 'Аварийный стоп включён: новые действия не запускаю. Возобновите в трее.', ...(this._runId ? { runId: this._runId } : {}) });
        return this._endTurn();
      }
      // Потолок времени: проверяем перед новым шагом, а не посреди действия. Владелец не должен
      // молча ждать, пока модель ходит кругами; ход честно останавливается с тем, что уже сделано.
      if (this.turnDeadlineMs && Date.now() - this._turn.started > this.turnDeadlineMs) {
        const minutes = Math.max(1, Math.round(this.turnDeadlineMs / 60000));
        const steps = this._turn.toolCalls;
        const text = `Ход занял больше ${minutes} мин — остановил, чтобы не держать вас. Сделано шагов: ${steps}; что успел, видно выше. Если нужно, скажите «продолжай» — доделаю.`;
        this.history.push({ role: 'assistant', content: text });
        this._turn.outcome = 'timeout';
        this._emit({ type: 'text', delta: text, ...(this._runId ? { runId: this._runId } : {}) });
        return this._endTurn();
      }
      round += 1;
      // Первый круг — это планирование, следующие — выполнение/обдумывание следующего шага.
      this._status('thinking', {
        status: round === 1 ? 'planning' : 'running',
        step: this._step,
        label: round === 1 ? 'принял просьбу, планирую шаги' : 'обдумываю следующий шаг',
        startedAt: this._startedAt,
      });
      const res = await this._callModel(round, answerOnly, signal);
      if (signal.aborted) {
        if (!this._turn.outcome) this._turn.outcome = 'stopped';
        return this._endTurn();
      }
      if (this._stopped()) {
        this._turn.outcome = 'stopped';
        return this._endTurn();
      }

      let calls = (res.toolCalls || []).map((c) => ({ ...c, id: c.id || randomUUID() }));
      // Инструменты на этом шаге запрещены: вызовы, если модель их всё же прислала, не выполняем.
      if (answerOnly) calls = [];
      const text = res.content || (answerOnly && calls.length === 0 ? LOOP_FALLBACK : '');
      const assistant = {
        role: 'assistant',
        content: text || (calls.length ? null : ''),
      };
      // DeepSeek в режиме размышлений с вызовом инструментов требует reasoning_content обратно.
      if (res.reasoningContent) assistant.reasoning_content = res.reasoningContent;
      if (calls.length) assistant.tool_calls = calls.map(toWireToolCall);
      this.history.push(assistant);

      // Текст перед вызовом инструмента уже показан потоком: следующий текст начнётся с новой строки.
      if (calls.length && this._streamedChars) this._emit({ type: 'text', delta: '\n\n', ...(this._runId ? { runId: this._runId } : {}) });
      if (calls.length === 0) {
        if (text && !this._streamedChars) this._emit({ type: 'text', delta: text, ...(this._runId ? { runId: this._runId } : {}) });
        this._turn.answerChars = text.length;
        this._turn.outcome = answerOnly ? 'loop' : 'answer';
        return this._endTurn();
      }

      // Каждому tool_call должен соответствовать ответ role 'tool', даже если вызов не выполнен.
      let limitHit = false;
      const roundStarted = Date.now();
      let repeatsDenied = 0;
      let humanNeeded = false;
      const run = async (call) => {
        const result = await this._runCall(call, signal, round);
        if (result.repeat) repeatsDenied += 1;
        if (result.data && result.data.needsHuman === true) humanNeeded = true;
        return result;
      };
      // Одновременно идут только вызовы чтения (T0), разрешённые без вопроса. Действия с эффектом (ввод, клавиши, запуск) — по очереди.
      if (!signal.aborted && calls.every((call) => this._canRunWithoutAsk(call) && this.tools.get(call.name).risk === 'T0')) {
        // Все вызовы — чтение без вопросов: выполняем их одновременно, порядок ответов сохраняем.
        const room = Math.max(0, this.maxSteps - steps);
        const runNow = calls.slice(0, room);
        steps += runNow.length;
        const results = await Promise.all(runNow.map(run));
        runNow.forEach((call, i) => this._pushToolResult(call.id, results[i]));
        for (const call of calls.slice(room)) {
          limitHit = true;
          this._pushToolResult(call.id, { ok: false, summary: `лимит шагов (${this.maxSteps}) исчерпан` });
        }
      } else {
        // Серия действий одним ответом идёт подряд без модели; после неудачного шага остальные действия не выполняются.
        let broken = false;
        for (const call of calls) {
          const tool = this.tools.get(call.name);
          if (signal.aborted) {
            this._pushToolResult(call.id, { ok: false, summary: 'остановлено' });
          } else if (broken && tool && tool.risk !== 'T0') {
            const skipped = { ...(this._runId ? { runId: this._runId } : {}), step: this._step + 1, status: 'cancelled', target: safeTarget(call.args) };
            this._emit({ type: 'tool_start', id: call.id, name: call.name, args: call.args, risk: tool.risk, ...skipped });
            this._emit({ type: 'tool_result', id: call.id, ok: false, summary: 'пропущено: предыдущий шаг серии не удался', decision: 'skip', ...skipped });
            this._pushToolResult(call.id, { ok: false, summary: 'не выполнено: предыдущий шаг серии не удался. Сверь состояние чтением и реши заново' });
          } else if (steps >= this.maxSteps) {
            limitHit = true;
            this._pushToolResult(call.id, { ok: false, summary: `лимит шагов (${this.maxSteps}) исчерпан` });
          } else {
            steps += 1;
            const result = await run(call);
            if (!result.ok) broken = true;
            this._pushToolResult(call.id, result);
          }
        }
      }
      this._flushImages();
      this._turn.toolWallMs += Date.now() - roundStarted;
      if (signal.aborted) {
        if (!this._turn.outcome) this._turn.outcome = 'stopped';
        return this._endTurn();
      }
      // Капча или второй вход: дальше без человека нельзя. Ход кончается, продолжение — после ответа владельца.
      if (humanNeeded) {
        this.history.push({ role: 'assistant', content: NEEDS_HUMAN_TEXT });
        this._emit({ type: 'text', delta: NEEDS_HUMAN_TEXT, ...(this._runId ? { runId: this._runId } : {}) });
        this._turn.outcome = 'needs_human';
        return this._endTurn();
      }
      if (this.closeOnLimit && steps >= this.maxSteps) {
        answerOnly = true;
        continue;
      }
      if (limitHit) {
        this._turn.outcome = 'limit';
        this._emit({ type: 'text', delta: `Достигнут лимит шагов инструментов (${this.maxSteps}) за один ход.`, ...(this._runId ? { runId: this._runId } : {}) });
        return this._endTurn();
      }
      // Все вызовы шага — повторы: модель ходит по кругу. Дальше просим ответить по уже полученным данным.
      if (repeatsDenied > 0 && repeatsDenied === calls.length) answerOnly = true;
    }
  }

  // Вызов модели с замером. answerOnly — ответить текстом, без вызова инструментов.
  async _callModel(round, answerOnly, signal) {
    const messages = this._messages();
    const tools = this._toolSpecs();
    const started = Date.now();
    const base = { kind: 'model', turn: this._turn.id, round, messages: messages.length, tools: tools.length };
    if (answerOnly) base.toolChoice = 'none';
    let res;
    try {
      this._streamedChars = 0;
      const onDelta = (delta) => {
        if (signal.aborted) return;
        if (this._turn.firstTextMs === undefined) this._turn.firstTextMs = Date.now() - this._turn.started;
        this._streamedChars += delta.length;
        this._emit({ type: 'text', delta, ...(this._runId ? { runId: this._runId } : {}) });
      };
      res = await this.brain.chat({ messages, tools, signal, ...(this.tier ? { tier: this.tier } : {}), ...(this.thinking ? { thinking: this.thinking } : {}), ...(answerOnly ? { toolChoice: 'none' } : {}), ...(this.stream ? { onDelta } : {}) });
    } catch (err) {
      const ms = Date.now() - started;
      this._turn.modelCalls += 1;
      this._turn.modelMs += ms;
      this.turnLog.write({ ...base, ms, ok: false, error: errLabel(err) });
      throw err;
    }
    const ms = Date.now() - started;
    const stats = (res && res.stats) || {};
    const t = this._turn;
    t.modelCalls += 1;
    t.modelMs += ms;
    t.promptTokens += stats.promptTokens || 0;
    t.completionTokens += stats.completionTokens || 0;
    t.reasoningTokens += stats.reasoningTokens || 0;
    const reasoningChars = res && res.reasoningContent ? String(res.reasoningContent).length : 0;
    t.reasoningChars += reasoningChars;
    if (this.turnLog.enabled) {
      this.turnLog.write({
        ...base,
        ms,
        ok: true,
        requestChars: stats.requestChars != null ? stats.requestChars : JSON.stringify({ messages, tools }).length,
        promptTokens: stats.promptTokens ?? null,
        cachedTokens: stats.cachedTokens ?? null,
        completionTokens: stats.completionTokens ?? null,
        reasoningTokens: stats.reasoningTokens ?? null,
        reasoningChars,
        reasoning: stats.reasoning || null,
        toolCalls: (res && res.toolCalls ? res.toolCalls : []).map((c) => c.name),
        answerChars: res && res.content ? String(res.content).length : 0,
      });
    }
    return res;
  }

  async _runCall(call, signal, round) {
    // Ход уже остановлен: поздний вызов не начинается и поздний ответ не оживляет запуск.
    if (signal.aborted || this._runClosed) {
      return { ok: false, summary: 'остановлено: ход прерван', cancelled: true };
    }
    if (call.name === 'app_search') this._installEvidence = null;
    const tool = this.tools.get(call.name);
    const risk = tool ? tool.risk : null;
    const started = Date.now();
    let waitMs = 0;
    let execMs = 0;
    // Порядковый номер шага в запуске: им окно и журнал связывают событие с записью истории.
    const step = (this._step += 1);
    const target = safeTarget(call.args);
    const stepStartedAt = new Date(started).toISOString();
    this._emit({
      type: 'tool_start', id: call.id, name: call.name, args: call.args, risk,
      ...(this._runId ? { runId: this._runId } : {}), step, status: 'running',
      label: STEP_WORDS.running, ...(target ? { target } : {}), startedAt: stepStartedAt,
    });
    // Старт вызова пишем до выполнения: если конец не появится (перезапуск, сбой), вызов был прерван.
    if (this._turn) this.turnLog.write({ kind: 'tool_start', turn: this._turn.id, round, callId: call.id, name: call.name, risk });

    // Один и тот же вызов с теми же аргументами больше двух раз за ход — это зацикливание.
    const key = `${call.name}:${stableKey(call.args || {})}`;
    const repeats = (this._turnCalls.get(key) || 0) + 1;
    this._turnCalls.set(key, repeats);

    // resolution — итог для журнала: allow | once | session | reject | deny
    let resolution;
    let result;
    let repeat = false;
    if (!tool) {
      resolution = 'deny';
      result = { ok: false, summary: `неизвестный инструмент: ${call.name}` };
    } else if (this._unknownCalls.has(key)) {
      resolution = 'deny';
      // Первый отказ — не зацикливание: модель должна успеть прочитать состояние на следующем шаге.
      repeat = repeats > MAX_REPEATS;
      result = {
        ok: false,
        summary: isOneShot(call.name)
          ? 'повтор не выполнен: подтверждения результата нет, отправка могла уже пройти. Такое действие без подтверждения не повторяют: сверь состояние чтением и скажи владельцу'
          : 'повтор не выполнен: исход этого действия неизвестен, оно могло уже сработать. Сначала прочитай настоящее состояние (screen_look, ui_elements, browser_read, workspace_list), потом решай',
      };
    } else if (this.lookFirst && tool.risk !== 'T0' && call.name !== 'screen_look') {
      resolution = 'deny';
      this._turnCalls.set(key, repeats - 1); // действие не выполнялось: после снимка его можно сделать
      result = { ok: false, summary: 'действие не выполнено: после перезапуска сначала сверь экран снимком (screen_look), затем продолжай. Что не подтверждено в записках, не повторяй вслепую' };
    } else if (repeats > MAX_REPEATS && !LIVE_STATE_READS.has(call.name)) {
      resolution = 'deny';
      repeat = true;
      result = { ok: false, summary: 'повтор: этот вызов уже выполнялся, его результат выше. Ответь по нему или скажи владельцу, что не получилось' };
    } else if (call.argsError) {
      resolution = 'deny';
      result = { ok: false, summary: `некорректные аргументы: ${call.argsError}` };
    } else if (this._stopped()) {
      // Стоп не даёт начать новое действие: ни сразу, ни после подтверждения.
      resolution = 'stop';
      result = { ok: false, summary: 'остановлено: аварийный стоп' };
    } else {
      resolution = this._verdict(tool, call.args);
      if (resolution === 'ask') {
        const askStarted = Date.now();
        resolution = await this._askApproval(tool, call, signal, { step, target, startedAt: stepStartedAt });
        waitMs = Date.now() - askStarted;
        // Отправка, публикация и удаление: «на сессию» не выдаём, каждое действие — отдельное согласие.
        if (resolution === 'session' && isOneShot(tool.name)) resolution = 'once';
        // Стоп пришёл, пока ждали ответ: одобрение «на сессию» не сохраняем, стоп его уже отозвал.
        if (resolution === 'session' && !this._stopped() && !signal.aborted && !this._runClosed) {
          this.sessionAllow.add(allowKey(tool.name, call.args));
        }
      }
      if (resolution === 'deny' || resolution === 'reject') {
        result = { ok: false, summary: this._denyText(call, resolution) };
      } else if (this._stopped() || signal.aborted || this._runClosed) {
        // Стоп пришёл, пока ждали подтверждение, или отказ/закрытие окна: действие не выполняем.
        resolution = 'stop';
        result = { ok: false, summary: 'остановлено: аварийный стоп или отмена' };
      } else {
        this._status('acting', { status: 'running', step, label: STEP_WORDS.running, ...(target ? { target } : {}), startedAt: stepStartedAt });
        const execStarted = Date.now();
        result = await this._execute(tool, call.args, signal, { step, target, startedAt: stepStartedAt });
        execMs = Date.now() - execStarted;
        // Инструмент ответил уже после остановки хода: это не успех и не повод продолжать запуск.
        if (signal.aborted || this._runClosed) {
          resolution = 'stop';
          result = { ok: false, summary: 'остановлено: ответ инструмента пришёл после остановки хода' };
        } else {
          if (tool.name === 'app_search' && result.ok) {
            const query = String((call.args && call.args.query) || '').trim();
            const id = uniqueSearchMatch(query, result.data && result.data.text);
            if (id) this._installEvidence = { query, id };
          }
          const reader = STATE_READERS.has(call.name);
          // Сбой посреди действия (таймаут, обрыв) — тоже неизвестный исход: оно могло успеть сработать.
          if ((result.verified === 'unknown' || result.thrown) && risk !== 'T0' && !reader) this._unknownCalls.set(key, { name: call.name, args: call.args });
          if (reader && result.ok) this._stateRead(call.name, call.args);
          // Дальше в этом ходу исходящие действия спрашиваем: текст извне мог содержать чужие указания.
          // Руки (клики, ввод, клавиши) — только после именно чужого текста: свой снимок экрана чужим не считаем.
          if (result.ok && isTaintSource(call.name, tool.source)) this._tainted = true;
          if (result.ok && isForeignTextSource(call.name, tool.source)) this._foreign = true;
        }
      }
    }

    // Честный статус шага: успех — только когда инструмент подтвердил результат; чтение без проверки
    // считается выполненным, а действие без подтверждения — «не проверено», а не успехом.
    const stopped = resolution === 'deny' || resolution === 'reject' || resolution === 'stop';
    let callStatus = 'succeeded';
    if (stopped || !result.ok || result.verified === 'failed') callStatus = 'failed';
    else if (result.verified === 'unknown' || (risk !== 'T0' && result.verified !== 'confirmed')) callStatus = 'unverified';
    // Нормализованный итог проверки: unverified — не «подтверждено». null — проверка не предусмотрена (чтение).
    const verifiedStatus = result.verified === 'confirmed' ? 'confirmed'
      : result.verified === 'failed' ? 'failed'
        : result.verified === 'unknown' ? 'unverified'
          : risk !== 'T0' && !stopped ? 'unverified' : null;
    if (callStatus === 'failed') this._verification.failed += 1;
    else if (callStatus === 'unverified') this._verification.unverified += 1;
    else if (result.verified === 'confirmed') this._verification.confirmed += 1;
    else this._verification.reads += 1;
    if (this._calls.length < 200) {
      this._calls.push({
        callId: call.id, step, tool: call.name, risk, status: callStatus,
        verified: result.verified || null, decision: resolution,
      });
    }

    // Журнал владельца: итог вызова вместе с проверкой результата. callId связывает запись со стартом в turnLog,
    // runId и step — с ходом и событием окна. Сбой записи не должен оставить вызов без ответа в истории.
    try {
      this.journal.append({
        tool: call.name,
        args: call.args,
        risk,
        mode: this.mode,
        decision: resolution,
        ok: result.ok,
        summary: result.summary,
        callId: call.id,
        ...(this._runId ? { runId: this._runId } : {}),
        step,
        status: callStatus,
        verified: result.verified || null,
        verifiedStatus,
        evidence: result.evidence || null,
      });
    } catch (err) {
      console.warn(`Не удалось записать в журнал: ${errText(err)}`);
    }
    if (this._turn) {
      this._turn.toolCalls += 1;
      this._turn.waitMs += waitMs;
      this.turnLog.write({
        kind: 'tool',
        turn: this._turn.id,
        round,
        callId: call.id,
        name: call.name,
        ms: execMs,
        waitMs,
        totalMs: Date.now() - started,
        decision: resolution,
        ok: result.ok,
        verified: result.verified || null,
        ...(repeat ? { repeat: true } : {}),
      });
    }
    this._emit({
      type: 'tool_result', id: call.id, ok: result.ok, summary: result.summary,
      ...(this._runId ? { runId: this._runId } : {}), step, status: callStatus,
      verifiedStatus, decision: resolution, ...(target ? { target } : {}), startedAt: stepStartedAt,
      label: stopped ? STEP_WORDS.failed : STEP_WORDS[callStatus],
      ...(result.verified ? { verified: result.verified, evidence: result.evidence || '' } : {}),
      ...(result.quiet ? { quiet: true } : {}),
    });
    // repeat — служебная пометка для цикла, в историю не попадает.
    return repeat ? Object.defineProperty(result, 'repeat', { value: true, enumerable: false }) : result;
  }

  // true, если вызов можно выполнить сразу: инструмент есть, аргументы верные и политика разрешает без вопроса.
  _canRunWithoutAsk(call) {
    if (call.argsError) return false;
    const tool = this.tools.get(call.name);
    if (!tool) return false;
    return this._verdict(tool, call.args) === 'allow';
  }

  _verdict(tool, args) {
    let verdict;
    try {
      verdict = this.decide({
        mode: this.mode,
        name: tool.name,
        risk: tool.risk,
        args,
        workspace: this.workspace,
        sessionAllow: this.sessionAllow,
        hasPathParam: declaresPath(tool),
        source: tool.source,
        ownerAllowed: typeof tool.ownerAllowed === 'function' && tool.ownerAllowed(args) === true,
        ownerText: this._ownerText || '',
        installEvidence: this._installEvidence,
        tainted: this._tainted === true,
        handsTainted: this._foreign === true,
      });
    } catch {
      verdict = 'deny'; // сбой политики = отказ по умолчанию
    }
    // Открыть доступ можно только явным 'allow' или 'ask'.
    return verdict === 'allow' || verdict === 'ask' ? verdict : 'deny';
  }

  // Причина ограничения от политики: «отклонено» без причины владельцу ничего не говорит.
  _policyNote(call) {
    const policy = this.policy;
    if (!policy || typeof policy.describe !== 'function') return null;
    try {
      return policy.describe({ name: call.name, args: call.args }) || null;
    } catch {
      return null;
    }
  }

  // Текст отказа: отказ владельца и запрет политики — разные вещи.
  _denyText(call, resolution) {
    if (resolution === 'reject') return 'отклонено';
    const note = this._policyNote(call);
    return note ? `отклонено: ${note}` : 'отклонено';
  }

  async _askApproval(tool, call, signal, info = {}) {
    if (!this.approvals) return 'reject';
    // id совпадает с id вызова: интерфейс сводит approval_request и tool_start в одну запись истории.
    const note = this._policyNote(call);
    // Причина без «undefined»: пустые части отбрасываются, а не склеиваются в текст с дырами.
    const safeWords = (value) => (typeof value === 'string' && value.trim() && !/\bundefined\b/i.test(value) ? value.trim() : '');
    let explain = '';
    try {
      explain = tool.explain ? safeWords(tool.explain(call.args)) : '';
    } catch {
      explain = ''; // пояснение инструмента упало: причина всё равно должна быть понятной
    }
    const reasonParts = [safeWords(`режим «${this.mode}»`), safeWords(`риск ${tool.risk || 'не указан'}`), explain, safeWords(note)].filter(Boolean);
    const payload = {
      id: call.id,
      name: tool.name,
      args: call.args,
      risk: tool.risk,
      reason: reasonParts.join('; ') || 'действие требует вашего разрешения',
      // Для отправки, публикации и удаления «до перезапуска» не предлагаем: каждое действие — отдельное согласие.
      allowSession: !isOneShot(tool.name),
    };
    this._status('waiting_approval', {
      status: 'awaiting_approval', step: info.step, label: STEP_WORDS.awaiting_approval,
      ...(info.target ? { target: info.target } : {}), startedAt: info.startedAt,
    });
    // Сначала регистрируем запрос, потом сообщаем UI: быстрый ответ не потеряется.
    const waiting = this.approvals.request(payload);
    // Отказ, тайм-аут и закрытие диалога приходят сюда как reject: действие не выполняется.
    const onAbort = () => this.approvals.respond(payload.id, 'reject');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    this._emit({
      type: 'approval_request', ...payload,
      ...(this._runId ? { runId: this._runId } : {}), step: info.step, status: 'awaiting_approval',
      label: STEP_WORDS.awaiting_approval, ...(info.target ? { target: info.target } : {}), startedAt: info.startedAt,
    });
    try {
      return await waiting;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async _execute(tool, args, signal, info = {}) {
    try {
      const ctx = { workspace: this.workspace, signal, background: this.background };
      const r = await tool.run(args, ctx);
      const out = {
        ok: Boolean(r && r.ok),
        summary: String(r && r.summary != null ? r.summary : ''),
        data: r ? r.data : undefined,
        image: r && r.image ? String(r.image) : undefined,
        // Подпись для модели: снимок экрана и картинка из файла — разные вещи, пусть видит, что именно.
        imageLabel: r && r.image ? (tool.name === 'screen_look' ? 'Снимок экрана' : 'Картинка') : undefined,
        ...(r && r.verified ? { verified: r.verified, evidence: r.evidence || '' } : {}),
        // quiet — вызов был служебным (например, варианты без открытия): в чате карточку действия не показываем.
        ...(r && r.quiet ? { quiet: true } : {}),
      };
      // Перед проверкой результата окно честно показывает, что идёт проверка, а не выполнение.
      // Если действие уже не удалось, проверять нечего и «проверяю» не показываем.
      if (out.ok && typeof tool.verify === 'function' && !signal.aborted && !this._runClosed) {
        this._status('acting', {
          status: 'verifying', step: info.step, label: STEP_WORDS.verifying,
          ...(info.target ? { target: info.target } : {}), startedAt: info.startedAt,
        });
      }
      return await checkEffect(tool, args, out, ctx);
    } catch (err) {
      // thrown — служебная пометка для _runCall, в историю и журнал не попадает.
      return Object.defineProperty({ ok: false, summary: `ошибка: ${errText(err)}` }, 'thrown', { value: true });
    }
  }

  // Состояние прочитано: пометки «исход неизвестен» снимаются, кроме отправки и удаления — их повторяют только по подтверждению.
  // Счёт повторов сбрасываем к одному выполнению, иначе отказ до чтения съел бы разрешённый повтор.
  _stateRead(name, args) {
    if (name === 'screen_look' || name === 'desktop_observe') this.lookFirst = false;
    for (const [key, call] of this._unknownCalls) {
      if (isOneShot(call.name) || !relevantObservation(name, args, call.name, call.args, this.workspace)) continue;
      this._unknownCalls.delete(key);
      this._turnCalls.set(key, 1);
    }
  }

  _pushToolResult(id, result) {
    const { image, imageLabel, ...rest } = result;
    this.history.push({ role: 'tool', tool_call_id: id, content: safeJson(rest) });
    if (image) this._pendingImages.push({ id, image, summary: rest.summary, label: imageLabel || 'Картинка' });
  }

  // Картинки кладём после всех ответов инструментов шага: ответы role 'tool' должны идти подряд.
  _flushImages() {
    for (const p of this._pendingImages) {
      this.history.push({ role: 'user', content: `${p.label} (результат ${p.id}): ${p.summary}`, image: p.image, fromTool: true });
    }
    this._pendingImages = [];
  }

  _messages() {
    // systemPrompt может быть строкой или функцией: функция вызывается на каждом ходу (нужно для времени).
    const text = typeof this.systemPrompt === 'function' ? this.systemPrompt() : this.systemPrompt;
    const head = text ? [{ role: 'system', content: text }] : [];
    const recent = this._recentHistory();
    // Всё, что до последнего сообщения пользователя, — прошлые ходы: их отправляем сжатыми.
    let lastUser = recent.length - 1;
    while (lastUser >= 0 && (recent[lastUser].role !== 'user' || recent[lastUser].fromTool)) lastUser -= 1;
    const stamp = [this.clock ? this.clock() : '', this._turnContext].filter(Boolean).join('\n');
    return head.concat(recent.map((m, i) => {
      const msg = stamp && i === lastUser ? stampMessage(m, stamp) : m;
      return wireMessage(msg, i >= lastUser);
    }));
  }

  // Хвост истории (не длиннее maxContext) начинается с сообщения пользователя,
  // чтобы ответы инструментов не остались без вызова.
  _recentHistory() {
    const h = this.history;
    const max = this.maxContext;
    if (!(max > 0) || h.length <= max) return h;
    let start = h.length - max;
    while (start < h.length && h[start].role !== 'user') start += 1;
    if (start < h.length) return h.slice(start);
    // Текущий ход сам длиннее окна: вопрос пользователя плюс хвост, начинающийся с ответа ассистента.
    let lastUser = h.length - 1;
    while (lastUser >= 0 && h[lastUser].role !== 'user') lastUser -= 1;
    let from = h.length - (max - 1);
    while (from < h.length && h[from].role !== 'assistant') from += 1;
    const tail = h.slice(from);
    return lastUser >= 0 ? [h[lastUser], ...tail] : tail;
  }

  _toolSpecs() {
    return this.tools.list().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
  }

  _logTurn() {
    const t = this._turn;
    if (!t) return;
    this.turnLog.write({
      kind: 'turn',
      turn: t.id,
      ms: Date.now() - t.started,
      outcome: t.outcome || 'unknown',
      modelCalls: t.modelCalls,
      modelMs: t.modelMs,
      toolCalls: t.toolCalls,
      toolWallMs: t.toolWallMs,
      waitMs: t.waitMs,
      promptTokens: t.promptTokens,
      completionTokens: t.completionTokens,
      reasoningTokens: t.reasoningTokens,
      reasoningChars: t.reasoningChars,
      userChars: t.userChars,
      answerChars: t.answerChars,
      firstTextMs: t.firstTextMs ?? null,
      historyMessages: this.history.length,
      mode: this.mode,
    });
  }

  // Итог запуска. Успех — только когда модель ответила, провалов нет и непроверенных действий нет.
  // Отказ или провал шага делает итог failed, остановка — cancelled. Ответ модели сам по себе не доказательство.
  _runStatus() {
    const outcome = (this._turn && this._turn.outcome) || 'unknown';
    if ((this._controller && this._controller.signal.aborted) || outcome === 'stopped') return 'cancelled';
    if (outcome !== 'answer') return 'failed';
    const v = this._verification || {};
    if ((v.failed || 0) > 0) return 'failed';
    if ((v.unverified || 0) > 0) return 'unverified';
    return 'succeeded';
  }

  // Сколько действий подтверждено, не проверено и провалено: безопасная сводка для окна и отчёта.
  _verificationSummary() {
    const v = this._verification || {};
    const confirmed = v.confirmed || 0;
    const unverified = v.unverified || 0;
    const failed = v.failed || 0;
    return { confirmed, unverified, failed, reads: v.reads || 0, total: confirmed + unverified + failed };
  }

  // Конец запуска: ровно один done и один idle. Повторный stop/cancel их не дублирует, и после
  // итога события этого запуска окну не идут — отменённый ход не воскресает поздним ответом.
  _endTurn({ idle = true } = {}) {
    if (this._runClosed) return;
    this._runClosed = true;
    const status = this._runStatus();
    this._emitRaw({
      type: 'done',
      ...(this._runId ? { runId: this._runId } : {}),
      outcome: (this._turn && this._turn.outcome) || 'unknown',
      status: PROGRESS_STATUSES.has(status) ? status : 'failed',
      // Явный признак отмены: окно не должно показывать «Ответ готов» после стопа.
      ...(status === 'cancelled' ? { cancelled: true } : {}),
      ...(this._startedAt ? { startedAt: this._startedAt } : {}),
      verification: this._verificationSummary(),
      ...(this._turn ? { steps: this._turn.toolCalls } : {}),
      history: this._calls.slice(),
    });
    if (idle) this._emitRaw({ type: 'status', state: 'idle', ...(this._runId ? { runId: this._runId } : {}) });
  }

  _status(state, extra = {}) {
    this._emit({ type: 'status', state, ...(this._runId ? { runId: this._runId } : {}), ...extra });
  }

  // Обычное событие запуска. После итога события не отправляются: поздний ответ модели или инструмента
  // не должен выглядеть новым шагом уже отменённого или завершённого хода.
  _emit(event) {
    if (this._runClosed) return;
    this._emitFn(event);
  }

  // Служебное событие конца запуска (done/idle) — в обход защиты от поздних событий.
  _emitRaw(event) {
    this._emitFn(event);
  }
}

module.exports = { Agent, MAX_TOOL_STEPS, MAX_REPEATS, repairToolHistory, PROGRESS_STATUSES, safeTarget };
