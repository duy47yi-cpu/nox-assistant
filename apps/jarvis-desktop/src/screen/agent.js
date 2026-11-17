'use strict';

const { randomUUID } = require('crypto');

// Агент экрана: снимок → модель выбирает один шаг → шаг → проверка (verify) → свежий снимок → следующий шаг.
// Цикл, политика (decide), журнал и стоп — общие из Agent. Своё здесь: до 40 шагов на ход и обязательное
// подтверждение опасного шага (отправка, оплата, удаление, установка, Enter после ввода текста) — через общий
// брокер подтверждений (ApprovalBroker). Отказ владельца = needs_human: шаг не выполняется и не повторяется.
const { Agent, coerceToolArgs } = require('../agent/loop');
const { createAgentLoop } = require('./agent-loop');
const { ToolRegistry } = require('../tools/registry');
const { resolveSceneTarget, POLICY_PATTERNS } = require('../policy/modes');
// Окна, которые нельзя показывать модели автоснимком: почта, мессенджеры, банки, менеджеры паролей (F-3).
const FORBIDDEN_SHOT_WINDOW = POLICY_PATTERNS.HARD_WINDOW;

const SCREEN_TOOL_NAMES = ['screen_look', 'ui_windows', 'ui_elements', 'ui_click', 'ui_type', 'ui_keys', 'ui_focus', 'app_open', 'ui_wait'];
const MAX_SCREEN_STEPS = 40;
// Потолок времени экранного хода: 8 минут — гипотеза из §9 спеки, до замера на живых окнах (E-1).
const SCREEN_TURN_DEADLINE_MS = 8 * 60 * 1000;
const TASK_PHRASE = /^сделай на экране[\s:,—-]*([\s\S]*)$/i;
// Подпись статуса, пока ждём подтверждения: та же, что в Agent, но здесь она своя, чтобы не менять loop.js.
const WAITING_WORDS = 'жду вашего решения';

const SCREEN_PROMPT = [
  'Ты — Джарвис в приложении Nox Assistant, выполняешь поручение владельца на экране Windows.',
  'Говори с владельцем простым русским языком. Никогда не называй владельцу внутренние имена инструментов (screen_look, ui_windows, ui_elements, ui_click и т. п.), моделей или провайдеров.',
  'Собственным окном Nox (Джарвиса) управлять и читать его элементы нельзя — работай только с другими программами. Если поручение не требует кликов по чужим окнам или владелец просто задал вопрос, ответь сразу после первого снимка.',
  'Начни со снимка экрана (screen_look). Потом за один ответ делай ровно один шаг: узнай список окон (ui_windows), найди элементы окна (ui_elements), нажми (ui_click), введи текст (ui_type), нажми клавиши (ui_keys), переключи окно (ui_focus), запусти программу (app_open) или подожди (ui_wait).',
  'После каждого действия ты получаешь свежий снимок экрана: сверь по нему, сработал ли шаг, прежде чем идти дальше. Если не уверен, что шаг сработал — не повторяй то же нажатие вслепую, попробуй другой способ или остановись и скажи владельцу.',
  'Если ты только что начал работу и не знаешь, что уже сделано, сначала посмотри состояние. Не жми Enter и не повторяй ввод в поле, где уже есть текст: прочитай поле и скажи владельцу, что там осталось.',
  'Оплату не делай: никогда не нажимай кнопки оплаты, перевода денег и оформления заказа. Перед отправкой сообщения, удалением, установкой или нажатием Enter после ввода текста система сама запросит подтверждение у владельца — после отказа не повторяй шаг и скажи, что остановился.',
  'Когда задача выполнена на экране — коротко скажи, что сделано и что видно.',
].join('\n');

const UNSURE_TEXT = 'Не уверен, что последний шаг сработал: проверка его не подтвердила. Дальше не иду, чтобы не повторить вслепую. Посмотрите на экран и скажите, продолжать ли.';
const NO_SCREEN_TEXT = 'Не удалось получить снимок экрана. Останавливаюсь: проверьте экран и скажите, как продолжить.';

// Опасная подпись элемента: отправка, оплата, удаление, установка. Оплату и так запрещает политика (deny),
// остальные слова в «Полном доступе» политика пропустила бы молча — их ловит агент экрана.
const DANGER_ELEMENT = /отправ|пересл|ответ|\bsend\b|\bsubmit\b|\breply\b|подтверд|\bconfirm\b|удал|\bdelete\b|\bremove\b|установ|\binstall\b|оплат|\bpay\b|\bbuy\b|куп|покупк|оформить\s+(?:заказ|покупк)/i;
// Enter с любым модификатором — тоже отправка; разбираем сочетание по частям, а не по целому токену.
const DANGER_KEYS = new Set(['enter', 'return']);

// «сделай на экране: открой блокнот» → «открой блокнот»; иначе null.
function screenTask(text) {
  const m = TASK_PHRASE.exec(String(text || '').trim());
  return m && m[1].trim() ? m[1].trim() : null;
}

// Клавиши разбираются так же, как в src/tools/ui.js: через пробел, запятую или «+» внутри сочетания.
function keyTokens(keys) {
  return String(keys == null ? '' : keys)
    .toLowerCase()
    .replace(/\s*\+\s*/g, '+')
    .split(/[\s,;]+/)
    .filter(Boolean);
}

// Последняя клавиша сочетания — Enter: ctrl+enter, shift+enter, alt+enter в мессенджерах отправляют.
function isSendKey(token) {
  const parts = String(token || '').toLowerCase().split('+').filter(Boolean);
  return parts.length > 0 && DANGER_KEYS.has(parts[parts.length - 1]);
}

// Одна функция опасности для всех рук. Подпись элемента для desktop_* берётся из сцены
// (resolveSceneTarget в src/policy/modes.js), а не из аргументов: там только id.
// typed — в этом ходу уже был ввод текста. Проверка политики не заменяет: она спрашивает по режиму.
function isDangerousStep(name, args, { typed = false } = {}) {
  const n = String(name || '');
  const a = args || {};
  if (n === 'ui_click' || n === 'ui_type') {
    return typeof a.name === 'string' && DANGER_ELEMENT.test(a.name);
  }
  if (n === 'ui_keys') return Boolean(typed) && keyTokens(a.keys).some(isSendKey);
  if (n === 'desktop_click' || n === 'desktop_type' || n === 'mouse_click') {
    const hit = resolveSceneTarget(n, a);
    return Boolean(hit && hit.name && DANGER_ELEMENT.test(hit.name));
  }
  // Закрытие окна может потерять несохранённое: всегда вопрос (D-1).
  if (n === 'ui_close_window' || n === 'windows_close_all') return true;
  return false;
}

// Подпись шага для вопроса и отказа: имя элемента (экрана) в кавычках или понятное описание клавиш.
// Длина ограничена: подпись приходит с экрана, в текст владельцу она не должна попадать простынёй.
function dangerLabel(name, args) {
  const n = String(name || '');
  if (n === 'ui_keys') return 'Enter после ввода текста';
  const a = args || {};
  const label = typeof a.name === 'string' ? a.name.trim().slice(0, 120) : '';
  return label ? `«${label}»` : (n || 'шаг');
}

// Текст честного отказа: ход кончается вопросом к владельцу, шаг не выполнен и не повторяется.
function dangerDenyText(label) {
  return `Шаг не выполнен: ${label} — опасное действие (отправка, оплата, удаление или установка), а вы его не подтвердили. Останавливаюсь и не повторяю шаг. Скажите, если нужно попробовать снова.`;
}

// Автоотмена и стоп — не отказ владельца: у них свои честные тексты (D-2).
const NO_ANSWER_TEXT = 'Не дождался ответа на опасный шаг за отведённое время: шаг не выполнен. Скажите, если нужно спросить ещё раз.';
const STOPPED_TEXT = 'Остановлено до выполнения опасного шага: он не выполнен.';

const toWireToolCall = (call) => ({
  id: call.id,
  type: 'function',
  function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
});

// Только инструменты экрана. Снимок свой: владелец сам попросил работу на экране.
function screenRegistry(source, look) {
  const reg = new ToolRegistry();
  reg.register(look);
  for (const name of SCREEN_TOOL_NAMES) {
    if (name === 'screen_look') continue;
    const tool = source.get(name);
    if (tool) reg.register(tool);
  }
  return reg;
}

class ScreenAgent extends Agent {
  // look — инструмент screen_look; tools — общий реестр, из него берутся только инструменты экрана.
  // maxSteps — предел шагов на ход; по умолчанию MAX_SCREEN_STEPS, тесты задают меньше.
  constructor({ look, tools, maxSteps = MAX_SCREEN_STEPS, ...opts } = {}) {
    super({
      ...opts,
      tools: screenRegistry(tools, look),
      systemPrompt: SCREEN_PROMPT,
      history: [],
      maxSteps: maxSteps > 0 ? maxSteps : MAX_SCREEN_STEPS,
      lookFirst: true,
      turnDeadlineMs: opts.turnDeadlineMs || SCREEN_TURN_DEADLINE_MS,
      // Потолок шага 30 с: у ui_* свои 15 с, запас на перечитывание окна (E-1).
      stepDeadlineMs: opts.stepDeadlineMs || 30000,
    });
    this.look = look;
    this._failed = false;
    this._noScreen = false;
    this._typed = false; // в этом ходу уже вводили текст: Enter после него спрашиваем
    this._denied = false; // владелец отказал в опасном шаге: ход кончается needs_human
    this._deniedLabel = '';
    this._timedOut = false; // автоотмена подтверждения: никто не ответил — это не отказ (D-2)
    this._stoppedBefore = false; // стоп до выполнения опасного шага (D-2)
    this._dangerApprovalId = '';
    this._preApproval = null; // кэш решения approve(), чтобы не спрашивать повторно в _runCall
  }

  run(text, options) {
    this._failed = false;
    this._noScreen = false;
    this._typed = false;
    this._denied = false;
    this._deniedLabel = '';
    this._timedOut = false;
    this._stoppedBefore = false;
    this._dangerApprovalId = '';
    this._preApproval = null;
    return super.run(text, options);
  }

  _unsureText() {
    return this._timedOut ? NO_ANSWER_TEXT
      : this._stoppedBefore ? STOPPED_TEXT
        : this._denied ? dangerDenyText(this._deniedLabel)
          : this._noScreen ? NO_SCREEN_TEXT : UNSURE_TEXT;
  }

  _status(state, extra = {}) {
    if (
      state !== 'idle'
      && state !== 'error'
      && state !== 'cancelled'
      && state !== 'waiting_approval'
      && Number.isInteger(extra.step)
      && extra.step > 0
      && !(typeof extra.label === 'string' && extra.label.startsWith('Шаг '))
    ) {
      const n = Math.min(extra.step, this.maxSteps);
      const label = extra.label ? `Шаг ${n} из ${this.maxSteps} · ${extra.label}` : `Шаг ${n} из ${this.maxSteps}`;
      return super._status(state, { ...extra, label });
    }
    return super._status(state, extra);
  }

  // Исход шага не подтверждён (готовая пометка «исход неизвестен», проверка сказала «нет») или владелец
  // отказал в опасном шаге: модель больше не зовём и шаг не повторяем.
  _unsure() {
    return this._failed || this._noScreen || this._denied || this._timedOut || this._stoppedBefore || this._unknownCalls.size > 0;
  }

  // Политика решает по режиму; опасный шаг агент экрана спрашивает всегда, даже в «Полном доступе».
  // Запрет политики (оплата, запреты modes.js) остаётся запретом: вопросом его не заменяем.
  _verdict(tool, args) {
    const verdict = super._verdict(tool, args);
    if (verdict !== 'allow') return verdict;
    return isDangerousStep(tool.name, args, { typed: this._typed }) ? 'ask' : verdict;
  }

  async _callModel(round, answerOnly, signal) {
    if (this._unsure()) {
      this._streamedChars = 0;
      return { content: this._unsureText(), toolCalls: [] };
    }
    const res = await super._callModel(round, answerOnly, signal);
    // Один шаг за раз: остальное модель решит заново по свежему снимку.
    if (res && Array.isArray(res.toolCalls) && res.toolCalls.length > 1) return { ...res, toolCalls: res.toolCalls.slice(0, 1) };
    return res;
  }

  // Опасный шаг: то же подтверждение через брокер, но без «на сессию» — каждое такое действие отдельное.
  async _askDanger(tool, call, signal, info = {}) {
    if (!this.approvals) return 'reject';
    const label = dangerLabel(call.name, call.args);
    const approvalId = randomUUID();
    this._dangerApprovalId = approvalId;
    const callId = call.id;
    const payload = {
      // Разрешение имеет одноразовый ключ, отдельно связанный с действием, ходом и экземпляром агента.
      id: approvalId,
      approvalId,
      agentId: this._agentId,
      callId,
      ...(this._runId ? { runId: this._runId } : {}),
      name: tool.name,
      args: structuredClone(call.args),
      risk: tool.risk,
      reason: `опасный шаг на экране: ${label} — отправка, оплата, удаление или установка; такое действие подтверждается каждый раз`,
      allowSession: false,
    };
    this._status('waiting_approval', {
      status: 'awaiting_approval', step: info.step, label: WAITING_WORDS,
      ...(info.target ? { target: info.target } : {}), ...(info.startedAt ? { startedAt: info.startedAt } : {}),
    });
    // Сначала регистрируем запрос, потом сообщаем окну: быстрый ответ не потеряется.
    const waiting = this.approvals.request(payload);
    // Стоп — не отказ владельца: закрываем запрос с причиной, чтобы отчёт не врал (D-2).
    const onAbort = () => this.approvals.cancel(approvalId, 'остановлено');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    this._emit({
      type: 'approval_request', ...payload,
      ...(this._runId ? { runId: this._runId } : {}), step: info.step, status: 'awaiting_approval',
      label: WAITING_WORDS, ...(info.target ? { target: info.target } : {}), ...(info.startedAt ? { startedAt: info.startedAt } : {}),
    });
    try {
      return await waiting;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  // Отказ владельца на опасном шаге: запоминаем и завершаем ход, шаг не выполняется и не повторяется.
  async _askApproval(tool, call, signal, info = {}) {
    if (this._preApproval && this._preApproval.callId === call.id) {
      const { decision, outcome } = this._preApproval;
      this._preApproval = null;
      this._approvalOutcome = outcome || '';
      return decision;
    }
    const danger = isDangerousStep(tool.name, call.args, { typed: this._typed });
    const decision = danger
      ? await this._askDanger(tool, call, signal, info)
      : await super._askApproval(tool, call, signal, info);
    if (danger && decision === 'reject') {
      const why = this.approvals && typeof this.approvals.closedReason === 'function'
        ? String(this.approvals.closedReason(this._dangerApprovalId) || '')
        : '';
      this._deniedLabel = dangerLabel(call.name, call.args);
      if (/время/i.test(why)) { this._timedOut = true; this._approvalOutcome = 'timeout'; }          // никто не отвечал — это не отказ
      else if (/останов/i.test(why) || (signal && signal.aborted)) { this._stoppedBefore = true; this._approvalOutcome = 'stop'; }
      else { this._denied = true; this._approvalOutcome = 'reject'; }                                // только явное «нет»
    }
    return decision;
  }

  // Интеграция шага 2: ScreenAgent подключает цикл observe -> plan -> approve -> act -> verify
  // из agent-loop.js через адаптеры поверх существующего _runCall (без правки src/agent/loop.js).
  async _loop(signal) {
    if (signal.aborted) {
      if (this._turn && !this._turn.outcome) this._turn.outcome = 'stopped';
      return this._endTurn();
    }
    if (this._stopped()) {
      this._turn.outcome = 'stopped';
      this._emit({ type: 'text', delta: 'Аварийный стоп включён: новые действия не запускаю. Возобновите в трее.', ...(this._runId ? { runId: this._runId } : {}) });
      return this._endTurn();
    }

    let round = 0;
    let finalAnswer = null;
    let pendingCall = null;
    let pendingApprovalPromise = null;
    let rejectedCall = null;
    let lastCallResult = null;
    this._preApproval = null;

    const loop = createAgentLoop({
      resolveTarget: (step) => resolveSceneTarget(step.action, step.target),
      observe: async ({ phase, stepIndex }) => {
        if (phase === 'after_step' && this._noScreen) {
          return { ok: false, error: NO_SCREEN_TEXT };
        }
        return {
          ok: true,
          phase,
          state: phase === 'initial' ? 'initial' : `step-${stepIndex}-${this._step}`,
        };
      },
      plan: async ({ stepIndex, signal: loopSignal }) => {
        if (loopSignal.aborted || this._stopped()) return { done: true };
        if (this._unsure()) return { needsHuman: true, reason: this._unsureText() };
        round += 1;
        const shownStep = Math.min(stepIndex, this.maxSteps);
        this._status('thinking', {
          status: round === 1 ? 'planning' : 'running',
          step: shownStep,
          label: `Шаг ${shownStep} из ${this.maxSteps}`,
          startedAt: this._startedAt,
        });
        const res = await this._callModel(round, false, loopSignal);
        if (loopSignal.aborted || this._stopped()) return { done: true };
        const calls = (res.toolCalls || []).map((c) => {
          const tool = c && c.name ? this.tools.get(c.name) : null;
          const args = !c.argsError && tool ? coerceToolArgs(tool, c.args) : c.args;
          return { ...c, id: c.id || randomUUID(), args };
        });
        const text = res.content || '';
        const assistant = { role: 'assistant', content: text || (calls.length ? null : '') };
        if (res.reasoningContent) assistant.reasoning_content = res.reasoningContent;
        if (calls.length) {
          assistant.tool_calls = calls.map(toWireToolCall);
          if (this._tainted === true || this._foreign === true || this._hasBrowserContext()) {
            assistant.provenance = { untrusted: true };
          }
        }
        this._pendingCallIds = new Set(calls.map((c) => c.id).filter(Boolean));
        this.history.push(assistant);

        if (calls.length && this._streamedChars) {
          this._emit({ type: 'text', delta: '\n\n', ...(this._runId ? { runId: this._runId } : {}) });
        }
        if (calls.length === 0) {
          finalAnswer = text;
          return { done: true };
        }
        const call = calls[0];
        pendingCall = call;
        const tool = this.tools.get(call.name);
        return {
          id: call.id,
          action: call.name,
          target: call.args,
          expect: (call.args && call.args.expect) || call.name,
          risk: tool ? tool.risk : null,
        };
      },
      approve: async (stepPayload, ctx) => {
        const call = pendingCall;
        const tool = call && call.name ? this.tools.get(call.name) : null;
        if (!tool) {
          this._preApproval = { callId: call && call.id, decision: 'deny', outcome: '' };
          return true;
        }
        const baseVerdict = Agent.prototype._verdict.call(this, tool, call.args);
        if (baseVerdict === 'deny') {
          this._preApproval = { callId: call.id, decision: 'deny', outcome: '' };
          return true;
        }
        pendingApprovalPromise = this._askApproval(tool, call, ctx.signal, {
          step: stepPayload.index,
          target: stepPayload.target,
          startedAt: this._startedAt,
        });
        const decision = await pendingApprovalPromise;
        pendingApprovalPromise = null;
        this._preApproval = { callId: call.id, decision, outcome: this._approvalOutcome };
        if (decision === 'reject') {
          rejectedCall = { call, tool, step: stepPayload.index };
          return false;
        }
        return true;
      },
      act: async (step, ctx) => {
        const call = pendingCall;
        pendingCall = null;
        const roundStarted = Date.now();
        this._status('acting', {
          status: 'running',
          step: step.index,
          label: `Шаг ${step.index} из ${this.maxSteps} · Выполняется`,
          startedAt: this._startedAt,
        });
        const result = await this._runCall(call, ctx.signal, round);
        this._pushToolResult(call.id, result);
        this._pendingCallIds.delete(call.id);
        this._flushImages();
        if (this._turn) this._turn.toolWallMs += Date.now() - roundStarted;
        lastCallResult = { call, result, tool: this.tools.get(call.name) };
        if (!result.ok && !this._unsure() && !result.repeat && result.verified !== 'failed') {
          const isLookFirstDeny = Boolean(result.summary && /сначала сверь экран снимком/i.test(result.summary));
          return { ...result, ok: false, recoverable: true, uncounted: isLookFirstDeny };
        }
        return result;
      },
      verify: async (_step, actResult) => {
        const info = lastCallResult;
        const tool = info && info.tool;
        const res = (info && info.result) || actResult;
        if (!res || !res.ok) {
          return { status: 'failed', evidence: (res && res.summary) || 'действие не выполнено' };
        }
        if (tool && (tool.name === 'screen_look' || tool.risk === 'T0')) {
          return { status: 'confirmed', evidence: res.summary || 'состояние прочитано' };
        }
        return {
          status: res.verified || 'unknown',
          evidence: res.evidence || res.summary || 'результат не проверен',
        };
      },
    });

    const loopResult = await loop.run({
      goal: this._planRequest || '',
      maxSteps: this.maxSteps,
      deadlineMs: this.turnDeadlineMs,
      signal,
    });

    if (pendingApprovalPromise) {
      const dec = await pendingApprovalPromise;
      pendingApprovalPromise = null;
      if (dec === 'reject' && !rejectedCall && pendingCall) {
        rejectedCall = { call: pendingCall, tool: this.tools.get(pendingCall.name), step: this._step + 1 };
      }
    }

    if (rejectedCall) {
      if (!signal.aborted && !this._runClosed) {
        const res = await this._runCall(rejectedCall.call, signal, round);
        this._pushToolResult(rejectedCall.call.id, res);
        this._pendingCallIds.delete(rejectedCall.call.id);
      } else {
        try {
          this.journal.append({
            tool: rejectedCall.call.name,
            args: rejectedCall.call.args,
            risk: rejectedCall.tool ? rejectedCall.tool.risk : null,
            mode: this.mode,
            decision: this._approvalOutcome || 'stop',
            ok: false,
            summary: 'отклонено',
            callId: rejectedCall.call.id,
            ...(this._runId ? { runId: this._runId } : {}),
            step: rejectedCall.step,
            status: 'failed',
            verified: null,
            verifiedStatus: null,
          });
        } catch {
          // сбой журнала не должен ломать остановку хода
        }
        this._pendingCallIds.delete(rejectedCall.call.id);
      }
    }

    if (this._pendingCallIds && this._pendingCallIds.size > 0) {
      const reason = loopResult.status === 'limit'
        ? `лимит шагов (${this.maxSteps}) исчерпан`
        : 'ход прерван';
      for (const id of this._pendingCallIds) {
        this._pushToolResult(id, { ok: false, summary: reason });
      }
      this._pendingCallIds.clear();
    }

    if (signal.aborted) {
      if (this._turn && !this._turn.outcome) this._turn.outcome = 'stopped';
      return this._endTurn();
    }
    if (this._stopped()) {
      this._turn.outcome = 'stopped';
      return this._endTurn();
    }
    if (this._unsure()) {
      const content = this._unsureText();
      this.history.push({ role: 'assistant', content });
      this._turn.answerChars = content.length;
      this._turn.outcome = 'needs_human';
      this._emit({ type: 'text', delta: content, ...(this._runId ? { runId: this._runId } : {}) });
      return this._endTurn();
    }
    if (loopResult.status === 'timeout') {
      const minutes = Math.max(1, Math.round((this.turnDeadlineMs || SCREEN_TURN_DEADLINE_MS) / 60000));
      const stepsDone = this._turn ? this._turn.toolCalls : 0;
      const text = `Ход занял больше ${minutes} мин — остановил, чтобы не держать вас. Сделано шагов: ${stepsDone}; что успел, видно выше. Если нужно, скажите «продолжай» — доделаю.`;
      this.history.push({ role: 'assistant', content: text });
      this._turn.answerChars = text.length;
      this._turn.outcome = 'timeout';
      this._emit({ type: 'text', delta: text, ...(this._runId ? { runId: this._runId } : {}) });
      return this._endTurn();
    }
    if (loopResult.status === 'limit') {
      this._turn.outcome = 'limit';
      this._emit({ type: 'text', delta: `Достигнут лимит шагов инструментов (${this.maxSteps}) за один ход.`, ...(this._runId ? { runId: this._runId } : {}) });
      return this._endTurn();
    }
    if (finalAnswer !== null) {
      if (finalAnswer && !this._streamedChars) {
        this._emit({ type: 'text', delta: finalAnswer, ...(this._runId ? { runId: this._runId } : {}) });
      }
      this._turn.answerChars = finalAnswer.length;
      this._turn.outcome = 'answer';
      return this._endTurn();
    }
    const fallback = loopResult.message || UNSURE_TEXT;
    this.history.push({ role: 'assistant', content: fallback });
    this._turn.answerChars = fallback.length;
    this._turn.outcome = loopResult.status === 'needs_human' ? 'needs_human' : 'error';
    this._emit({ type: 'text', delta: fallback, ...(this._runId ? { runId: this._runId } : {}) });
    return this._endTurn();
  }

  async _execute(tool, args, signal, info = {}) {
    const out = await super._execute(tool, args, signal, info);
    if (tool.name === 'screen_look') {
      if (!out.ok || !out.image) {
        this._noScreen = true;
        return { ...out, ok: false, summary: 'не удалось получить снимок экрана' };
      }
      return out;
    }
    // Ввод текста в этом ходу: Enter после него может отправить сообщение — дальше такой шаг спрашивается.
    // unknown тоже считается: частично введённый текст уже стоит в поле, и Enter после него опасен.
    if ((tool.name === 'ui_type' || tool.name === 'desktop_type') && (out.ok || out.verified === 'unknown')) this._typed = true;
    if (tool.risk === 'T0') return out;
    if (out.verified === 'failed') this._failed = true;
    if (signal.aborted || this._unsure() || out.verified === 'unknown' || out.thrown) return out;
    // Свежий снимок после действия: по нему модель сверяет результат и выбирает следующий шаг.
    // Автоснимок идёт мимо политики, поэтому проверяем сами: впереди не должно быть окна,
    // которое нельзя показывать модели (почта, мессенджер, банк, менеджер паролей) (F-3).
    const front = await this._frontWindow();
    const forbidden = front ? FORBIDDEN_SHOT_WINDOW.test(String(front.title || '')) : true;
    try {
      // В журнал — запись без картинки: владелец видит, что снимок был и почему не ушёл.
      this.journal.append({
        tool: 'screen_look', args: { auto: true, window: front ? front.title : '' }, risk: 'T1',
        mode: this.mode, decision: forbidden ? 'deny' : 'allow', ok: !forbidden,
        summary: forbidden ? 'автоснимок не сделан: поверх окно, которое нельзя показывать модели' : 'автоснимок после действия',
        verified: null, step: info && info.step,
      });
    } catch {
      // сбой журнала не должен ломать ход
    }
    if (forbidden) return out; // модель получает результат действия без картинки и знает, что снимка нет
    try {
      const shot = await this.look.run({}, { workspace: this.workspace, signal });
      if (shot && shot.ok && shot.image) out.image = shot.image;
      else this._noScreen = true;
    } catch {
      this._noScreen = true;
    }
    return out;
  }

  // Переднее окно: автоснимок не должен показывать модели чужую почту или банк (F-3).
  async _frontWindow() {
    const tool = this.tools.get('ui_windows');
    if (!tool) return null;
    try {
      const res = await tool.run({}, { workspace: this.workspace });
      const list = (res && res.data && res.data.windows) || [];
      return list.find((w) => w && w.active === true) || null;
    } catch {
      return null;
    }
  }

  _endTurn() {
    if (this._turn && this._turn.outcome === 'answer' && this._unsure()) this._turn.outcome = 'needs_human';
    super._endTurn();
  }
}

module.exports = {
  ScreenAgent, screenTask, SCREEN_TOOL_NAMES, SCREEN_PROMPT, MAX_SCREEN_STEPS, UNSURE_TEXT,
  NO_ANSWER_TEXT, STOPPED_TEXT, SCREEN_TURN_DEADLINE_MS,
  isDangerousStep, dangerLabel,
};
