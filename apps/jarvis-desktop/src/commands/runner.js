'use strict';

// Исполнитель пользовательской команды: шаги {tool, args} по порядку через ту же политику,
// что и обычный агент. Команда не может запускать mission_* и command_* (фоновые задачи
// и управление самими командами доступны только из чата). Остановка на первом неуспешном шаге.
const { randomUUID } = require('crypto');
const path = require('path');
const { checkEffect } = require('../agent/effects');
const {
  maskArgsForJournal,
  checkSteps,
  flattenStepTree,
  hasTreeSteps,
  resolveStepTypeAndTool,
  MAX_STEPS,
  CommandRunLog,
  DANGEROUS_TOOLS,
  EVENT_CATALOG,
  TRIGGER_KINDS,
  checkHotkey,
  describeScheduleTrigger,
  eventLabel,
} = require('./store');
const { excludedFromAutonomy } = require('../tools/profiles');
const { looksSecretEgress } = require('../memory/store');

const FORBIDDEN_PREFIXES = ['mission_', 'command_'];
const FORBIDDEN_SUMMARY = 'нельзя запускать из команды';
const VERDICTS = new Set(['allow', 'ask', 'deny']);
const ANSWERS = new Set(['once', 'session']);
const LABEL_MAX = 80;

const noop = () => {};

// Человекочитаемое имя запуска для диалога разрешения. Офлайн-ярлыки («открой калькулятор»)
// приходят как {title, steps} без name/id: подставляем title, затем название инструмента,
// чтобы в reason не было литерала «undefined». Секрет в имени не показываем.
function safeLabel(value) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!clean) return '';
  const clipped = Array.from(clean).slice(0, LABEL_MAX).join('');
  return looksSecretEgress(clipped) ? '' : clipped;
}

function commandLabel(cmd, tool) {
  return safeLabel(cmd && cmd.name)
    || safeLabel(cmd && cmd.title)
    || safeLabel(tool && tool.title)
    || safeLabel(tool && tool.name)
    || 'действие';
}

function errText(err) {
  return err && err.message ? err.message : String(err);
}

function isForbidden(name) {
  return FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// Ждёт решения пользователя. Отмена сигнала переводит запрос в 'reject'.
// Возвращает 'once' | 'session' | 'reject'.
async function askApproval(approvals, emit, payload, signal) {
  if (!approvals) return 'reject';
  const reqId = payload && payload.id ? payload.id : randomUUID();
  const requestPayload = {
    ...payload,
    id: reqId,
    approvalId: reqId,
    allowSession: false,
  };
  let waiting;
  try {
    // Сначала регистрируем запрос, потом сообщаем UI: быстрый ответ не потеряется.
    waiting = Promise.resolve(approvals.request(requestPayload));
  } catch {
    return 'reject';
  }
  let settled = false;
  const onAbort = () => {
    if (settled) return;
    settled = true;
    try {
      approvals.respond(reqId, 'reject');
    } catch {
      // Уже закрытый запрос повторно не ломает отмену.
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  emit(structuredClone({ type: 'approval_request', ...requestPayload }));
  try {
    const answer = await waiting;
    settled = true;
    return answer;
  } catch {
    settled = true;
    return 'reject';
  } finally {
    settled = true;
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function resolveRunnableStep(step) {
  if (!step || typeof step !== 'object') return { name: '', args: {} };
  let name = typeof step.tool === 'string' ? step.tool.trim() : '';
  if (!name && typeof step.type === 'string' && step.type.trim()) {
    try {
      name = resolveStepTypeAndTool(step, 'шаг').tool;
    } catch {
      name = '';
    }
  }
  const rawArgs = step.args !== undefined ? step.args : (step.params !== undefined ? step.params : {});
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? { ...rawArgs } : {};
  if ((name === 'app_open' || step.type === 'app_start') && args.name === undefined && typeof args.program === 'string') {
    args.name = args.program;
  }
  if ((name === 'volume_set' || step.type === 'volume') && args.percent === undefined && args.level !== undefined) {
    args.percent = args.level;
  }
  return { name, args };
}

// Выполняет один шаг. Всегда пишет журнал и tool_result, ровно один раз.
async function runStep(cmd, step, deps) {
  const { tools, policy, journal, workspace, mode, signal, approvals } = deps;
  const emit = typeof deps.emit === 'function' ? deps.emit : noop;
  const id = randomUUID();
  const { name, args } = resolveRunnableStep(step);
  let risk = null;
  let verified = null;
  let evidence = null;
  let verifiedEffect = null;
  let finished = false;
  let started = false;

  const finish = (decision, ok, summary, verdictUsed = null) => {
    if (finished) return { tool: name, ok, summary, ...(verified ? { verified, evidence: evidence || '' } : {}) };
    finished = true;
    // В журнал — копия аргументов без секретов (пароль, токен, ключ), форма и длины сохраняются.
    if (journal && typeof journal.append === 'function') {
      journal.append({ tool: name, args: maskArgsForJournal(name, args), risk, mode, decision, ok, summary, source: 'command', command: cmd.id, verified, evidence });
    }
    const check = verified ? { verified, evidence: evidence || '' } : {};
    emit({ type: 'tool_result', id, name, ok, summary, ...check });
    if (typeof deps.onStepOutcome === 'function') {
      deps.onStepOutcome({ tool: name, risk, verdict: verdictUsed, decision, ok, summary, verified, evidence }, { args, verifiedEffect });
    }
    return { tool: name, ok, summary, ...check };
  };

  if (signal && signal.aborted) return finish('reject', false, 'отменено');
  if (isForbidden(name)) return finish('deny', false, FORBIDDEN_SUMMARY);
  if (deps.blockAutonomyTools && (DANGEROUS_TOOLS.has(name) || excludedFromAutonomy(name))) {
    return finish('deny', false, 'недоступно для автоматического запуска', 'deny');
  }

  const tool = tools.get(name);
  if (!tool) return finish('deny', false, `неизвестный инструмент: ${name}`);
  risk = tool.risk;

  let verdict;
  try {
    verdict = policy.decide({
      mode,
      name: tool.name,
      risk: tool.risk,
      args,
      workspace,
      ownerText: typeof deps.ownerText === 'string' ? deps.ownerText : '',
      ownerCommand: (deps.forceOwnerFalse === true || Boolean(cmd && (cmd.origin === 'ai' || cmd.origin === 'model'))) ? false : deps.ownerCommand === true,
      source: tool.source,
      ownerAllowed: typeof tool.ownerAllowed === 'function' && tool.ownerAllowed(args) === true,
      sessionAllow: new Set(),
      hasPathParam: Boolean(tool.parameters && tool.parameters.properties && tool.parameters.properties.path),
    });
  } catch {
    verdict = 'deny'; // сбой политики = отказ по умолчанию
  }
  if (!VERDICTS.has(verdict)) verdict = 'deny';

  let decision = verdict;
  if (verdict === 'deny') return finish('deny', false, 'отклонено', verdict);
  if (verdict === 'ask') {
    const payload = {
      id,
      name: tool.name,
      args,
      risk: tool.risk,
      reason: `команда «${commandLabel(cmd, tool)}»`,
    };
    const answer = await askApproval(approvals, emit, payload, signal);
    if (signal && signal.aborted) return finish('reject', false, 'отменено', verdict);
    if (!ANSWERS.has(answer)) return finish('reject', false, 'отклонено', verdict);
    decision = answer;
  }

  if (signal && signal.aborted) return finish('reject', false, 'отменено', verdict);
  if (started) return finish('reject', false, 'дублирующий запуск шага', verdict);
  started = true;
  emit({ type: 'tool_start', id, name: tool.name, args: structuredClone(args), risk: tool.risk });
  let ok = false;
  let summary;
  try {
    const ctx = { workspace, signal };
    const result = await tool.run(args, ctx);
    if (signal?.aborted) return finish('reject', false, 'остановлено', verdict);
    if (deps.reportVerification && result?.ok && typeof tool.verify === 'function') {
      emit({ type: 'status', state: 'verifying', status: 'verifying' });
    }
    const r = await checkEffect(tool, args, result, ctx);
    if (signal?.aborted) return finish('reject', false, 'остановлено', verdict);
    verified = (r && r.verified) || null;
    if (verified === 'confirmed' && typeof tool.verify === 'function') verifiedEffect = r;
    evidence = (r && r.evidence) || null;
    ok = Boolean(r && r.ok) && verified !== 'failed';
    summary = String(r && r.summary != null ? r.summary : '');
  } catch (err) {
    if (signal?.aborted) return finish('reject', false, 'остановлено', verdict);
    ok = false;
    summary = `ошибка: ${errText(err)}`;
  }
  return finish(decision, ok, summary, verdict);
}

const CANCELLED_SUMMARIES = new Set([
  'остановлено: аварийный стоп',
  'отменено',
  'остановлено',
]);

function isCancelledSummary(summary) {
  return CANCELLED_SUMMARIES.has(String(summary || '').trim());
}

// Дополнительные поля метаданных держим неперечислимыми, чтобы старые deepEqual-проверки
// { ok, results } не ломались, а вызывающий код читал cancelled/partial/executedCount/totalSteps.
function buildRunResult(base, meta) {
  const out = { ...base };
  Object.defineProperties(out, {
    cancelled: { value: Boolean(meta.cancelled), enumerable: false, configurable: true },
    partial: { value: Boolean(meta.partial), enumerable: false, configurable: true },
    executedCount: { value: Number(meta.executedCount || 0), enumerable: false, configurable: true },
    totalSteps: { value: Number(meta.totalSteps || 0), enumerable: false, configurable: true },
  });
  return out;
}

// Запускает команду (в том числе вложенное дерево шагов pre-order). Возвращает {ok, results}
// (+ неперечислимые cancelled, partial, executedCount, totalSteps).
// ok = true только если выполнены и не провалены все узлы; при сбое родителя его children пропускаются.
async function runCommand(cmd, deps = {}) {
  // Зафиксировать выбранную команду: последующие изменения редактора не должны
  // подменять шаги уже запущенного исполнения.
  cmd = cmd ? structuredClone(cmd) : cmd;
  const steps = cmd && Array.isArray(cmd.steps) ? cmd.steps : [];
  const flatNodes = flattenStepTree(steps);
  const totalSteps = flatNodes.length;
  // Выключенная команда не выполняется, даже если её вызвали в обход выключенной кнопки в окне.
  if (cmd && cmd.enabled === false) {
    return buildRunResult(
      { ok: false, error: 'команда выключена', results: [{ tool: '', ok: false, summary: 'команда выключена' }] },
      { cancelled: false, partial: false, executedCount: 0, totalSteps },
    );
  }
  const results = [];
  if (steps.length === 0) {
    return buildRunResult({ ok: false, results }, { cancelled: false, partial: false, executedCount: 0, totalSteps: 0 });
  }
  // Аварийный стоп обрывает и идущий шаг, а не только следующий.
  const stopped = new AbortController();
  const off = deps.stop ? deps.stop.onTrigger(() => stopped.abort()) : null;
  const signal = deps.signal ? AbortSignal.any([deps.signal, stopped.signal]) : stopped.signal;
  const isStoppedNow = () => Boolean(deps.stop && deps.stop.isStopped());
  const wasCancelled = () => Boolean(signal.aborted || isStoppedNow());
  const emit = typeof deps.emit === 'function' ? deps.emit : noop;

  try {
    if (cmd.confirm === true && deps.approvals && typeof deps.approvals.ask === 'function') {
      const answer = await askApproval(deps.approvals, emit, {
        id: randomUUID(),
        name: 'command_confirm',
        args: { command: commandLabel(cmd, null) },
        risk: 'T1',
        reason: `команда «${commandLabel(cmd, null)}» требует подтверждения`,
      }, signal);
      if (wasCancelled() || !ANSWERS.has(answer)) {
        return buildRunResult(
          { ok: false, results: [{ tool: 'command_confirm', ok: false, summary: 'отменено владельцем' }] },
          { cancelled: true, partial: false, executedCount: 0, totalSteps },
        );
      }
    }

    const allowSiblingContinue = hasTreeSteps(steps) || cmd.allowPartial === true;
    let criticalAbort = false;

    const recordAbortStep = (step) => {
      const { name: stepName, args: stepArgs } = resolveRunnableStep(step);
      const stepTool = deps.tools && typeof deps.tools.get === 'function' ? deps.tools.get(stepName) : null;
      const stopId = randomUUID();
      const stopSummary = isStoppedNow() ? 'остановлено: аварийный стоп' : 'отменено';
      if (deps.journal && typeof deps.journal.append === 'function') {
        deps.journal.append({
          tool: stepName,
          args: maskArgsForJournal(stepName, stepArgs),
          risk: stepTool ? stepTool.risk : null,
          mode: deps.mode,
          decision: 'reject',
          ok: false,
          summary: stopSummary,
          source: 'command',
          command: cmd.id,
          verified: null,
          evidence: null,
        });
      }
      emit({ type: 'tool_result', id: stopId, name: stepName, ok: false, summary: stopSummary });
      if (typeof deps.onStepOutcome === 'function') {
        deps.onStepOutcome({
          tool: stepName,
          risk: stepTool ? stepTool.risk : null,
          verdict: null,
          decision: 'reject',
          ok: false,
          summary: stopSummary,
          verified: null,
          evidence: null,
        });
      }
      results.push({ tool: stepName, ok: false, summary: stopSummary });
    };

    const runBranch = async (list) => {
      for (const step of list) {
        if (criticalAbort) break;
        if (isStoppedNow() || signal.aborted) {
          recordAbortStep(step);
          criticalAbort = true;
          return;
        }
        let stepOutcomeMeta = null;
        const stepDeps = {
          ...deps,
          signal,
          onStepOutcome: (meta, details) => {
            stepOutcomeMeta = meta;
            if (typeof deps.onStepOutcome === 'function') deps.onStepOutcome(meta, { ...details, step });
          },
        };
        const result = await runStep(cmd, structuredClone(step), stepDeps);
        results.push(result);
        const stepOk = result.ok && result.verified !== 'failed';
        if (!stepOk) {
          const cancelled = wasCancelled() || isCancelledSummary(result.summary);
          const policyBlocked = Boolean(stepOutcomeMeta && (stepOutcomeMeta.decision === 'deny' || stepOutcomeMeta.decision === 'reject' || stepOutcomeMeta.verdict === 'deny'));
          const shouldContinueSiblings = !cancelled && !policyBlocked
            && (step.continueOnError === true || allowSiblingContinue)
            && step.continueOnError !== false;
          if (!shouldContinueSiblings) {
            criticalAbort = true;
            return;
          }
          // Не запускаем вложенные шаги children, если родительский шаг не выполнился.
          continue;
        }
        if (Array.isArray(step.children) && step.children.length > 0) {
          await runBranch(step.children);
        }
      }
    };

    await runBranch(steps);

    const cancelled = wasCancelled() || results.some((r) => isCancelledSummary(r?.summary));
    const okCount = results.filter((r) => r && r.ok === true && r.verified !== 'failed').length;
    const allOk = !cancelled && results.length === totalSteps && okCount === totalSteps;
    const partial = !cancelled && !allOk && okCount > 0;
    return buildRunResult(
      { ok: allOk, results },
      { cancelled, partial, executedCount: results.length, totalSteps },
    );
  } finally {
    if (off) off();
  }
}

// Честный отчёт о выполнении цепочки по всем шагам: без «Готово» при отмене или провале,
// с перечислением выполненных, непроверенных и пропущенных шагов.
function summarizeChainResult(plan = {}, out = {}) {
  const flatSteps = flattenStepTree(plan?.steps);
  const steps = flatSteps.length ? flatSteps : (Array.isArray(plan?.steps) ? plan.steps : []);
  const results = Array.isArray(out?.results) ? out.results : [];
  const totalSteps = steps.length || results.length;
  const executedCount = typeof out?.executedCount === 'number' ? out.executedCount : results.length;
  const notes = Array.isArray(plan?.notes)
    ? plan.notes.map((n) => String(n || '').trim()).filter(Boolean)
    : [];

  const anyCancelled = out?.cancelled === true || results.some((r) => isCancelledSummary(r?.summary));
  const anyFailed = !out?.ok
    || results.some((r) => !r || r.ok !== true || r.verified === 'failed')
    || (steps.length > 0 && results.length < steps.length);
  const anyUnverified = results.some((r) => r && r.verified === 'unknown');
  const okCount = results.filter((r) => r && r.ok === true && r.verified !== 'failed').length;
  const partial = !anyCancelled && anyFailed && (out?.partial === true || okCount > 0);

  let status;
  if (anyCancelled) status = 'cancelled';
  else if (anyFailed) status = 'failed';
  else if (anyUnverified) status = 'unverified';
  else status = 'succeeded';

  const title = safeLabel(plan?.title) || safeLabel(plan?.name) || '';
  const stepLines = [];
  const count = Math.max(steps.length, results.length);
  const stopStepNum = results.length > 0 ? results.length : 1;

  for (let i = 0; i < count; i += 1) {
    const step = steps[i];
    const r = results[i];
    const name = safeLabel(step?.label) || safeLabel(step?.title) || String(r?.tool || step?.tool || `шаг ${i + 1}`);
    if (!r) {
      stepLines.push(`- Шаг ${i + 1} (${name}): не выполнено (шаг ${stopStepNum} остановлен)`);
      continue;
    }
    const summary = String(r.summary || '').trim();
    if (isCancelledSummary(summary)) {
      stepLines.push(`- Шаг ${i + 1} (${name}): остановлено${summary ? ` — ${summary}` : ''}`);
    } else if (!r.ok || r.verified === 'failed') {
      stepLines.push(`- Шаг ${i + 1} (${name}): не выполнено${summary ? ` — ${summary}` : ''}`);
    } else if (r.verified === 'unknown') {
      stepLines.push(`- Шаг ${i + 1} (${name}): выполнено без проверки${summary ? ` — ${summary}` : ''}`);
    } else if (r.verified === 'confirmed' || r.verified === 'ok') {
      stepLines.push(`- Шаг ${i + 1} (${name}): подтверждено${summary ? ` — ${summary}` : ''}`);
    } else {
      stepLines.push(`- Шаг ${i + 1} (${name}): выполнено${summary ? ` — ${summary}` : ''}`);
    }
  }

  let head;
  if (status === 'cancelled') {
    head = title ? `Выполнение остановлено: ${title}.` : 'Выполнение остановлено.';
  } else if (status === 'failed') {
    head = title ? `Не удалось завершить: ${title}.` : 'Не удалось завершить цепочку действий.';
  } else if (status === 'unverified') {
    head = title
      ? `Действия для «${title}» запущены, но часть шагов без проверки результата.`
      : 'Действия запущены, но часть шагов без проверки результата.';
  } else {
    head = title ? `Готово: ${title}.` : 'Готово.';
  }

  const lines = [head, ...stepLines];
  if (notes.length > 0) {
    lines.push(...notes.map((n) => `- ${n}`));
  }

  return {
    ok: status === 'succeeded' || status === 'unverified',
    status,
    partial,
    cancelled: status === 'cancelled',
    executedCount,
    totalSteps,
    skippedCount: Math.max(0, steps.length - results.length),
    text: lines.join('\n'),
  };
}

// Текст о запуске ярлыка для истории чата: модель видит, что уже сделано, и не путает это с новой просьбой.
function commandReply(cmd, out) {
  const head = out.ok ? `Команда «${cmd.name}» выполнена.` : `Команда «${cmd.name}» остановлена на шаге с ошибкой.`;
  const lines = (out.results || []).map((r) => `- ${r.tool}: ${String(r.summary || (r.ok ? 'готово' : 'ошибка')).slice(0, 200)}`);
  return [head, ...lines].join('\n');
}

function summarizeStepFact(r) {
  if (!r) return '';
  const summary = String(r.summary || '').trim();
  if (summary && !/^готово$/i.test(summary)) return summary;
  return String(r.tool || 'действие').trim();
}

// Честный частичный отказ (1–2 коротких предложения без выдуманного «готово»).
function formatPartialCommandReport(cmd, out) {
  const results = Array.isArray(out && out.results) ? out.results : [];
  const okItems = results.filter((r) => r && r.ok === true && r.verified !== 'failed');
  const failItems = results.filter((r) => !r || r.ok !== true || r.verified === 'failed');
  const firstFail = failItems[0];
  const failMsg = firstFail ? summarizeStepFact(firstFail) : (out && out.error) || 'ошибка выполнения шага';

  if (okItems.length > 0 && failItems.length > 0) {
    const donePart = okItems.map(summarizeStepFact).filter(Boolean).slice(0, 4).join(', ');
    const notFound = String(failMsg).match(/программа не найдена:\s*(.+)$/i);
    if (notFound) {
      return `Выполнено частично: ${donePart || 'часть шагов выполнена'}. ${notFound[1].trim()} не найден, поэтому связанные действия выполнить не удалось.`;
    }
    return `Выполнено частично: ${donePart || 'часть шагов выполнена'}. Не удалось: ${failMsg}.`;
  }
  if (failItems.length > 0) {
    return `Не удалось выполнить: ${failMsg}.`;
  }
  const title = safeLabel(cmd && cmd.name);
  return title ? `Команда «${title}» выполнена.` : 'Команда выполнена.';
}

// Короткая квитанция в 1–2 предложения для чата и уведомлений (успех / частичный отказ / ошибка).
function shortCommandReceipt(cmd, out) {
  const results = Array.isArray(out && out.results) ? out.results : [];
  const okCount = results.filter((r) => r && r.ok === true && r.verified !== 'failed').length;
  const cancelled = Boolean(out && out.cancelled);
  if (cancelled) return 'Выполнение команды остановлено.';
  if (out && out.ok) {
    const title = safeLabel(cmd && cmd.name);
    return title ? `Команда «${title}» выполнена.` : 'Команда выполнена.';
  }
  if ((out && out.partial) || (okCount > 0 && results.some((r) => !r || !r.ok || r.verified === 'failed'))) {
    return formatPartialCommandReport(cmd, out);
  }
  const failed = results.find((r) => !r || !r.ok || r.verified === 'failed');
  const reason = (failed && failed.summary) || (out && out.reason) || (out && out.error) || 'не удалось выполнить шаг';
  const title = safeLabel(cmd && cmd.name);
  return title ? `Команда «${title}» не выполнена: ${reason}.` : `Не удалось выполнить: ${reason}.`;
}

// ── Запись действий ────────────────────────────────────────────
// Пишет только то, что ей явно передали между start() и stop(): окно решает, какие события
// превращать в шаги. Секреты и набранный текст не записываются, шаги, зависящие от координат
// или активного окна, получают предупреждение. Запись ничего не сохраняет и не запускает:
// возвращённый черновик владелец правит и сохраняет сам (store.save).
const TYPED_TOOLS = new Set(['ui_type', 'desktop_type', 'clipboard_set', 'browser_type']);
const WINDOW_TOOLS = new Set(['ui_click', 'ui_keys', 'desktop_click', 'desktop_type']);
const COORDINATE_WARNING = 'зависит от координат окна: после смены окна шаг может нажать не туда';
const WINDOW_WARNING = 'зависит от активного окна и раскладки клавиатуры';
const TYPED_WARNING = 'набранный текст не записывается: добавьте его вручную';

function recordOverview(steps, { titleOf = (tool) => tool, briefOf = null } = {}) {
  return steps.map((s, i) => {
    let brief = '';
    try {
      brief = briefOf ? briefOf(s.args) : JSON.stringify(maskArgsForJournal(s.tool, s.args || {}));
    } catch {
      brief = '';
    }
    if (brief === '{}' || brief === '""') brief = '';
    return `${i + 1}. ${titleOf(s.tool)}${brief ? `: ${brief}` : ''}`;
  });
}

class CommandRecorder {
  constructor({ maxSteps = MAX_STEPS } = {}) {
    this.maxSteps = maxSteps;
    this.state = 'idle'; // idle | recording | stopped
    this.steps = [];
    this.warnings = [];
    this.startedAt = null;
    this.stoppedAt = null;
  }

  // Явный старт записи. Повторный старт без остановки — отказ, чтобы не потерять уже записанное.
  start() {
    if (this.state === 'recording') return { ok: false, error: 'запись уже идёт' };
    this.state = 'recording';
    this.steps = [];
    this.warnings = [];
    this.startedAt = new Date().toISOString();
    this.stoppedAt = null;
    return { ok: true, recording: true, startedAt: this.startedAt };
  }

  // Один шаг во время записи. args проверяются тем же кодом, что и сохранение команды;
  // секретные поля вырезаются, набранный текст не пишется, опасные и фоновые действия отклоняются.
  capture(step) {
    if (this.state !== 'recording') return { ok: false, error: 'запись не идёт: сначала start()' };
    if (this.steps.length >= this.maxSteps) return { ok: false, error: `шагов не больше ${this.maxSteps}` };
    const tool = step && typeof step.tool === 'string' ? step.tool.trim() : '';
    if (!tool) return { ok: false, error: 'шаг: нужно имя инструмента' };
    if (isForbidden(tool)) return { ok: false, error: `«${tool}» ${FORBIDDEN_SUMMARY}` };
    let args = step && step.args && typeof step.args === 'object' && !Array.isArray(step.args) ? { ...step.args } : {};
    const n = this.steps.length + 1;
    const notes = [];
    if (TYPED_TOOLS.has(tool)) {
      if ('text' in args) {
        delete args.text;
        notes.push(TYPED_WARNING);
      }
      if ('keys' in args) {
        delete args.keys;
        notes.push('нажатия клавиш не записываются: добавьте их вручную');
      }
    }
    let clean;
    const strictWarnings = [];
    try {
      [clean] = checkSteps([{ id: `step-${n}`, tool, args }], { strictArgs: true, warnings: strictWarnings });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    for (const warning of strictWarnings) notes.push(warning.replace(/^шаг 1:\s*/, ''));
    if (WINDOW_TOOLS.has(tool)) {
      const coordinate = tool === 'desktop_click' || tool === 'desktop_type'
        || ('x' in clean.args && 'y' in clean.args);
      notes.push(coordinate ? COORDINATE_WARNING : WINDOW_WARNING);
    }
    this.steps.push(clean);
    for (const note of notes) this.warnings.push(`шаг ${n}: ${note}`);
    return { ok: true, index: n - 1, step: clean, warnings: notes };
  }

  // Явная остановка: возвращает черновик, но ничего не сохраняет и не запускает.
  stop() {
    if (this.state !== 'recording') return { ok: false, error: 'запись не идёт' };
    this.state = 'stopped';
    this.stoppedAt = new Date().toISOString();
    return { ok: true, draft: this.draft() };
  }

  cancel() {
    this.state = 'idle';
    this.steps = [];
    this.warnings = [];
    this.startedAt = null;
    this.stoppedAt = null;
    return { ok: true };
  }

  status() {
    return {
      state: this.state,
      recording: this.state === 'recording',
      steps: this.steps.length,
      warnings: this.warnings.slice(),
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
    };
  }

  // Черновик для редактора: без имени и фраз (их задаёт владелец) и без сохранения.
  draft() {
    return {
      id: null,
      schemaVersion: undefined,
      name: '',
      phrases: [],
      steps: structuredClone(this.steps),
      enabled: true,
      origin: 'recorded',
      warnings: this.warnings.slice(),
      overview: this.overview(),
      saved: false,
    };
  }

  overview({ titleOf, briefOf } = {}) {
    return recordOverview(this.steps, { titleOf, briefOf });
  }

  // План команды из записи: сохранение — отдельный явный шаг через store.save.
  toCommand({ name, phrases, hotkey = null, folder = null, enabled = true } = {}) {
    return {
      name,
      phrases: Array.isArray(phrases) ? phrases.slice() : [],
      steps: structuredClone(this.steps),
      enabled,
      hotkey,
      folder,
      origin: 'recorded',
    };
  }
}

const AUTO_TRIGGERS = new Set(['schedule', 'event']);

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date() : value;
  if (value !== undefined && value !== null) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function defaultTriggerDetail(cmd, trigger) {
  if (trigger === 'hotkey') return (cmd.triggers && cmd.triggers.hotkey && cmd.triggers.hotkey.key) || cmd.hotkey || 'горячая клавиша';
  if (trigger === 'schedule') return describeScheduleTrigger(cmd.triggers && cmd.triggers.schedule);
  if (trigger === 'event') return eventLabel(cmd.triggers && cmd.triggers.event);
  if (trigger === 'phrase') return 'голосовая фраза';
  return 'ручной запуск';
}

function pluralSteps(n) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'шагов';
  if (mod10 === 1) return 'шаг';
  if (mod10 >= 2 && mod10 <= 4) return 'шага';
  return 'шагов';
}

function describeLaunchFailure({ cmd, trigger, isAutomatic, out, stepOutcomes, sawAutoAskBlock, stopSwitch, signal, thrownErr }) {
  if (thrownErr) {
    const msg = errText(thrownErr);
    return { status: 'failed', error: msg, reason: `ошибка выполнения: ${msg}` };
  }
  const results = out && Array.isArray(out.results) ? out.results : [];
  const aborted = Boolean((stopSwitch && stopSwitch.isStopped()) || (signal && signal.aborted)
    || results.some((r) => r.summary === 'остановлено: аварийный стоп' || r.summary === 'отменено'));
  if (aborted) {
    return { status: 'cancelled', error: null, reason: 'отменено: выполнение остановлено' };
  }
  if (out && out.ok) {
    const count = results.length;
    return { status: 'succeeded', error: null, reason: `выполнена успешно (${count} ${pluralSteps(count)})` };
  }
  const failedOutcome = [...stepOutcomes].reverse().find((o) => !o.ok) || null;
  const failedStep = [...results].reverse().find((r) => !r.ok) || null;
  if (sawAutoAskBlock || (isAutomatic && failedOutcome && failedOutcome.verdict === 'ask')) {
    const toolName = (failedOutcome && failedOutcome.tool) || (failedStep && failedStep.tool) || 'действие';
    return {
      status: 'blocked',
      error: 'требуется подтверждение владельца',
      reason: `заблокировано: шаг «${toolName}» требует подтверждения владельца; автоматический запуск не может обойти подтверждение`,
    };
  }
  if (failedOutcome && (failedOutcome.decision === 'deny' || failedOutcome.verdict === 'deny')) {
    const msg = failedOutcome.summary || 'запрещено политикой';
    return {
      status: 'blocked',
      error: msg,
      reason: `заблокировано политикой безопасности: ${msg}`,
    };
  }
  if (failedOutcome && failedOutcome.verdict === 'ask' && failedOutcome.decision === 'reject') {
    return {
      status: 'cancelled',
      error: 'отклонено владельцем',
      reason: `отменено: действие «${failedOutcome.tool || 'шаг'}» не получило подтверждения`,
    };
  }
  const errMsg = (failedStep && failedStep.summary) || (out && out.error) || 'ошибка выполнения шага';
  const stepLabel = failedStep && failedStep.tool ? `«${failedStep.tool}»: ` : '';
  const okCount = results.filter((r) => r && r.ok === true && r.verified !== 'failed').length;
  if (okCount > 0 || (out && out.partial)) {
    return {
      status: 'partial',
      error: errMsg,
      reason: formatPartialCommandReport(null, out),
    };
  }
  return {
    status: 'failed',
    error: errMsg,
    reason: `ошибка: ${stepLabel}${errMsg}`,
  };
}

class UnifiedCommandLauncher {
  constructor({
    store,
    runLog = null,
    depsProvider = null,
    stop = null,
    now = () => new Date(),
    notify = null,
    isBusy = null,
    hotkeyDebounceMs = 0,
    allowInteractiveApprovalForAuto = false,
  } = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.markTriggerStart !== 'function') {
      throw new Error('UnifiedCommandLauncher: нужен экземпляр CommandStore');
    }
    this.store = store;
    this.runLog = runLog || new CommandRunLog(path.join(path.dirname(store.filePath), 'command-runs.json'));
    this.depsProvider = depsProvider;
    this.stop = stop;
    this.now = now;
    this.notify = typeof notify === 'function' ? notify : null;
    this.isBusy = typeof isBusy === 'function' ? isBusy : null;
    this.hotkeyDebounceMs = Number.isInteger(hotkeyDebounceMs) && hotkeyDebounceMs >= 0 ? hotkeyDebounceMs : 0;
    this.allowInteractiveApprovalForAuto = allowInteractiveApprovalForAuto === true;
    this._inFlight = new Set();
    this._seenOccurrences = new Set();
    this._loggedSkips = new Set();
    this._tickBusy = false;
  }

  _safeNotify(payload) {
    if (!this.notify) return;
    try {
      this.notify(payload);
    } catch {
      // Сбой уведомления не должен срывать запуск или журнал.
    }
  }

  _rememberSeen(set, key, limit = 1000) {
    if (!key) return;
    if (set.size >= limit) set.clear();
    set.add(key);
  }

  _hasSeenOccurrence(cmd, occurrenceKey) {
    if (!occurrenceKey) return false;
    const scoped = `${cmd.id}:${occurrenceKey}`;
    if (this._seenOccurrences.has(scoped)) return true;
    const recent = cmd.triggerState && Array.isArray(cmd.triggerState.recentOccurrenceKeys)
      ? cmd.triggerState.recentOccurrenceKeys
      : [];
    return recent.some((entry) => entry && entry.key === occurrenceKey);
  }

  _checkCooldown(cmd, trigger, nowMs) {
    const st = cmd.triggerState || {};
    const attempts = st.lastAttemptAtByTrigger || {};
    const lastIso = attempts[trigger];
    if (!lastIso) return null;
    const lastMs = Date.parse(lastIso);
    if (!Number.isFinite(lastMs)) return null;
    const elapsed = nowMs - lastMs;
    if (elapsed < 0) return null;

    if (trigger === 'hotkey') {
      const htMs = cmd.triggers && cmd.triggers.hotkey && Number.isInteger(cmd.triggers.hotkey.cooldownMs)
        ? cmd.triggers.hotkey.cooldownMs
        : 0;
      const limit = Math.max(htMs, this.hotkeyDebounceMs);
      if (limit > 0 && elapsed < limit) {
        return 'защита от повторного запуска: слишком частое нажатие горячей клавиши';
      }
    }
    if (trigger === 'event') {
      const sec = cmd.triggers && cmd.triggers.event && Number.isInteger(cmd.triggers.event.cooldownSec)
        ? cmd.triggers.event.cooldownSec
        : 0;
      const limit = sec * 1000;
      if (limit > 0 && elapsed < limit) {
        const leftSec = Math.max(1, Math.ceil((limit - elapsed) / 1000));
        return `защита от повторного запуска: пауза после прошлого срабатывания (осталось ${leftSec} с)`;
      }
    }
    return null;
  }

  _resolveDeps(cmd, trigger, eventPayload, extraDeps) {
    let base = {};
    if (typeof this.depsProvider === 'function') {
      base = this.depsProvider({ command: cmd, trigger, eventPayload }) || {};
    } else if (this.depsProvider && typeof this.depsProvider === 'object') {
      base = this.depsProvider;
    }
    return { ...base, ...(extraDeps || {}) };
  }

  async launch({
    commandId,
    commandName = null,
    trigger = 'manual',
    triggerDetail = null,
    occurrenceKey = null,
    scheduledFor = null,
    eventPayload = null,
    ownerCommand,
    interactive = false,
    deps = null,
    now = null,
  } = {}) {
    if (!TRIGGER_KINDS.has(trigger)) {
      throw new Error(`неизвестный способ запуска: ${trigger}`);
    }
    const at = toDate(now ?? this.now());
    const nowMs = at.getTime();
    const isAutomatic = AUTO_TRIGGERS.has(trigger);

    const cmd = commandId ? this.store.get(commandId) : null;
    if (!cmd) {
      const reason = 'ошибка: команда не найдена';
      const logEntry = this.runLog.append({
        ts: at,
        commandId: commandId || null,
        commandName: commandName || 'неизвестная команда',
        trigger,
        triggerDetail: triggerDetail || trigger,
        status: 'failed',
        reason,
        error: reason,
        occurrenceKey,
      });
      return { ok: false, status: 'failed', reason, error: reason, results: [], logEntry };
    }

    const detail = triggerDetail || defaultTriggerDetail(cmd, trigger);
    const resolvedDeps = this._resolveDeps(cmd, trigger, eventPayload, deps);
    const stopSwitch = resolvedDeps.stop || this.stop;
    const workspaceId = resolvedDeps.workspaceId || 'default';

    const finishEarly = (status, reason, { dedupKey = null } = {}) => {
      if (dedupKey) {
        const scopedSkip = `${cmd.id}:${status}:${dedupKey}`;
        if (this._loggedSkips.has(scopedSkip)) {
          return {
            ok: false,
            skipped: status === 'skipped',
            blocked: status === 'blocked',
            cancelled: status === 'cancelled',
            status,
            reason,
            deduped: true,
            results: [],
            command: cmd,
          };
        }
        this._rememberSeen(this._loggedSkips, scopedSkip);
      }
      const logEntry = this.runLog.append({
        ts: at,
        commandId: cmd.id,
        commandName: cmd.name,
        trigger,
        triggerDetail: detail,
        status,
        reason,
        error: status === 'failed' || status === 'blocked' ? reason : null,
        stepsOk: 0,
        stepsTotal: Array.isArray(cmd.steps) ? cmd.steps.length : 0,
        occurrenceKey,
        workspaceId,
      });
      if (isAutomatic && (status === 'blocked' || status === 'failed')) {
        this._safeNotify({ title: 'Джарвис: команда не запущена', body: `${cmd.name}: ${reason}`, workspaceId });
      }
      return {
        ok: false,
        skipped: status === 'skipped',
        blocked: status === 'blocked',
        cancelled: status === 'cancelled',
        status,
        reason,
        results: [],
        command: cmd,
        logEntry,
      };
    };

    if (stopSwitch && typeof stopSwitch.isStopped === 'function' && stopSwitch.isStopped()) {
      return finishEarly('cancelled', 'отменено: включён аварийный стоп', {
        dedupKey: trigger === 'schedule' ? (occurrenceKey || `schedule-stop:${cmd.id}`) : null,
      });
    }
    if (cmd.enabled === false) {
      return finishEarly('skipped', 'пропущено: команда выключена');
    }

    if (trigger === 'hotkey') {
      const ht = cmd.triggers && cmd.triggers.hotkey;
      if (!ht || !ht.key) return finishEarly('skipped', 'пропущено: горячая клавиша не назначена');
      if (!ht.enabled) return finishEarly('skipped', 'пропущено: запуск по горячей клавише выключен');
    } else if (trigger === 'schedule') {
      const sch = cmd.triggers && cmd.triggers.schedule;
      if (!sch || !sch.enabled) return finishEarly('skipped', 'пропущено: запуск по расписанию выключен');
    } else if (trigger === 'event') {
      const ev = cmd.triggers && cmd.triggers.event;
      if (!ev || !ev.eventType) return finishEarly('skipped', 'пропущено: событие не выбрано');
      if (!ev.enabled) return finishEarly('skipped', 'пропущено: запуск по событию выключен');
    }

    if (this._inFlight.has(cmd.id) || (cmd.triggerState && cmd.triggerState.status === 'running')) {
      return finishEarly('skipped', 'защита от повторного запуска: команда уже выполняется');
    }
    if (this.isBusy) {
      const busy = this.isBusy({ command: cmd, trigger });
      if (busy) {
        const busyReason = typeof busy === 'string' && busy.trim()
          ? busy.trim()
          : 'защита от повторного запуска: сейчас выполняется другая команда';
        return finishEarly('skipped', busyReason);
      }
    }
    if (this._hasSeenOccurrence(cmd, occurrenceKey)) {
      return finishEarly('skipped', 'защита от повторного запуска: это срабатывание уже обработано');
    }
    const cooldownReason = this._checkCooldown(cmd, trigger, nowMs);
    if (cooldownReason) {
      return finishEarly('skipped', cooldownReason);
    }
    if (!Array.isArray(cmd.steps) || cmd.steps.length === 0) {
      return finishEarly('failed', 'ошибка: в команде нет ни одного шага');
    }

    if (isAutomatic) {
      for (const step of flattenStepTree(cmd.steps)) {
        const toolName = step && typeof step.tool === 'string' ? step.tool : '';
        if (DANGEROUS_TOOLS.has(toolName) || isForbidden(toolName) || excludedFromAutonomy(toolName)) {
          return finishEarly('blocked', `заблокировано: действие «${toolName}» недоступно при автоматическом запуске`);
        }
      }
    }
    if (!resolvedDeps.tools || !resolvedDeps.policy || !resolvedDeps.journal) {
      return finishEarly('failed', 'ошибка запуска: не подключены инструменты или правила доступа');
    }

    this._inFlight.add(cmd.id);
    const started = this.store.markTriggerStart(cmd.id, { trigger, scheduledFor, occurrenceKey, now: at });
    if (!started) {
      this._inFlight.delete(cmd.id);
      return finishEarly('skipped', 'защита от повторного запуска: команда уже выполняется');
    }
    if (occurrenceKey) this._rememberSeen(this._seenOccurrences, `${cmd.id}:${occurrenceKey}`);

    let sawAutoAskBlock = false;
    const stepOutcomes = [];
    const safeApprovals = isAutomatic && !(interactive === true && this.allowInteractiveApprovalForAuto && resolvedDeps.approvals)
      ? {
          request: async () => {
            sawAutoAskBlock = true;
            return 'reject';
          },
          respond: () => false,
        }
      : resolvedDeps.approvals;

    const isModelOrigin = Boolean(cmd && (cmd.origin === 'ai' || cmd.origin === 'model'));
    const runDeps = {
      ...resolvedDeps,
      stop: stopSwitch,
      approvals: safeApprovals,
      ownerCommand: (isAutomatic || isModelOrigin) ? false : (ownerCommand === true || (ownerCommand === undefined && resolvedDeps.ownerCommand === true)),
      forceOwnerFalse: isAutomatic || isModelOrigin,
      blockAutonomyTools: isAutomatic,
      onStepOutcome: (info) => stepOutcomes.push(info),
    };

    const startedMs = Date.now();
    let out = null;
    let thrownErr = null;
    try {
      out = await runCommand(started, runDeps);
    } catch (err) {
      thrownErr = err;
    } finally {
      this._inFlight.delete(cmd.id);
    }

    const durationMs = Math.max(0, Date.now() - startedMs);
    const finishedAt = toDate(this.now());
    const outcome = describeLaunchFailure({
      cmd: started,
      trigger,
      isAutomatic,
      out,
      stepOutcomes,
      sawAutoAskBlock,
      stopSwitch,
      signal: runDeps.signal,
      thrownErr,
    });
    const updatedCmd = this.store.markTriggerFinish(cmd.id, {
      trigger,
      status: outcome.status,
      reason: outcome.reason,
      durationMs,
      now: finishedAt,
    });
    const results = out && Array.isArray(out.results) ? out.results : [];
    const logEntry = this.runLog.append({
      ts: finishedAt,
      commandId: cmd.id,
      commandName: cmd.name,
      trigger,
      triggerDetail: detail,
      status: outcome.status,
      reason: outcome.reason,
      error: outcome.error,
      durationMs,
      stepsOk: results.filter((r) => r && r.ok).length,
      stepsTotal: flattenStepTree(cmd.steps).length,
      occurrenceKey,
      workspaceId,
    });
    if (isAutomatic && outcome.status !== 'succeeded') {
      this._safeNotify({ title: 'Джарвис: команда не запущена', body: `${cmd.name}: ${outcome.reason}`, workspaceId });
    }
    return {
      ok: outcome.status === 'succeeded',
      partial: outcome.status === 'partial',
      blocked: outcome.status === 'blocked',
      cancelled: outcome.status === 'cancelled',
      status: outcome.status,
      reason: outcome.reason,
      error: outcome.error,
      durationMs,
      results,
      command: updatedCmd || started,
      logEntry,
    };
  }

  triggerCommand(commandId, trigger = 'manual', opts = {}) {
    return this.launch({ ...opts, commandId, trigger });
  }

  async fireHotkey(hotkey, opts = {}) {
    let canonical = null;
    try {
      canonical = checkHotkey(hotkey);
    } catch {
      return { ok: false, skipped: true, status: 'skipped', reason: 'горячая клавиша задана неверно', results: [] };
    }
    if (!canonical) {
      return { ok: false, skipped: true, status: 'skipped', reason: 'горячая клавиша не задана', results: [] };
    }
    const cmd = this.store.findByHotkey(canonical);
    if (!cmd) {
      return { ok: false, skipped: true, status: 'skipped', reason: `горячая клавиша ${canonical} не назначена ни одной команде`, results: [] };
    }
    return this.launch({
      ...opts,
      commandId: cmd.id,
      trigger: 'hotkey',
      triggerDetail: canonical,
      ownerCommand: opts.ownerCommand !== false,
    });
  }

  async fireEvent(eventType, payload = {}, opts = {}) {
    const at = toDate(opts.now ?? this.now());
    const matched = this.store.findByEvent(eventType, payload);
    const eventId = (payload && typeof payload.eventId === 'string' && payload.eventId.trim())
      ? payload.eventId.trim()
      : (typeof opts.occurrenceKey === 'string' && opts.occurrenceKey.trim() ? opts.occurrenceKey.trim() : null);
    const results = [];
    let ran = 0;
    for (const cmd of matched) {
      const occurrenceKey = eventId ? `event:${eventId}` : null;
      const out = await this.launch({
        commandId: cmd.id,
        trigger: 'event',
        triggerDetail: eventLabel(cmd.triggers && cmd.triggers.event),
        occurrenceKey,
        eventPayload: payload,
        interactive: opts.interactive === true,
        deps: opts.deps,
        now: at,
      });
      results.push({ commandId: cmd.id, commandName: cmd.name, ...out });
      if (!out.skipped && !out.blocked && !out.cancelled) ran += 1;
    }
    return { matched: matched.length, ran, results };
  }

  noteStopped(now = this.now()) {
    const at = toDate(now);
    const due = this.store.dueScheduledCommands(at);
    let noted = 0;
    for (const cmd of due) {
      const slot = cmd.triggerState && cmd.triggerState.nextRunAt;
      const key = slot ? `schedule:${cmd.id}:${slot}` : `schedule-stop:${cmd.id}`;
      const scopedSkip = `${cmd.id}:cancelled:${key}`;
      if (this._loggedSkips.has(scopedSkip)) continue;
      this._rememberSeen(this._loggedSkips, scopedSkip);
      this.runLog.append({
        ts: at,
        commandId: cmd.id,
        commandName: cmd.name,
        trigger: 'schedule',
        triggerDetail: describeScheduleTrigger(cmd.triggers && cmd.triggers.schedule),
        status: 'cancelled',
        reason: 'отменено: включён аварийный стоп',
        stepsOk: 0,
        stepsTotal: Array.isArray(cmd.steps) ? cmd.steps.length : 0,
        occurrenceKey: key,
      });
      noted += 1;
    }
    return noted;
  }

  _skipStaleAndLog(at) {
    const stale = this.store.skipStaleSchedules(at);
    for (const item of stale) {
      this.runLog.append({
        ts: at,
        commandId: item.command.id,
        commandName: item.command.name,
        trigger: 'schedule',
        triggerDetail: describeScheduleTrigger(item.command.triggers && item.command.triggers.schedule),
        status: 'skipped',
        reason: item.reason,
        stepsOk: 0,
        stepsTotal: Array.isArray(item.command.steps) ? item.command.steps.length : 0,
        occurrenceKey: item.occurrenceKey,
      });
    }
    return stale;
  }

  async tickScheduled(now = this.now()) {
    if (this._tickBusy) return { ran: 0, skipped: 0, staleSkipped: 0, results: [] };
    this._tickBusy = true;
    try {
      const at = toDate(now);
      const stale = this._skipStaleAndLog(at);
      if (this.stop && typeof this.stop.isStopped === 'function' && this.stop.isStopped()) {
        const skipped = this.noteStopped(at);
        return { ran: 0, skipped, staleSkipped: stale.length, results: [] };
      }
      const due = this.store.dueScheduledCommands(at);
      const results = [];
      let ran = 0;
      for (const cmd of due) {
        if (this.stop && typeof this.stop.isStopped === 'function' && this.stop.isStopped()) {
          this.noteStopped(at);
          break;
        }
        const slot = cmd.triggerState && cmd.triggerState.nextRunAt;
        const occurrenceKey = slot ? `schedule:${cmd.id}:${slot}` : null;
        const out = await this.launch({
          commandId: cmd.id,
          trigger: 'schedule',
          triggerDetail: describeScheduleTrigger(cmd.triggers && cmd.triggers.schedule),
          occurrenceKey,
          scheduledFor: slot,
          now: at,
        });
        results.push({ commandId: cmd.id, commandName: cmd.name, ...out });
        if (!out.skipped && !out.blocked && !out.cancelled) ran += 1;
      }
      return { ran, skipped: results.length - ran, staleSkipped: stale.length, results };
    } finally {
      this._tickBusy = false;
    }
  }

  async reconcile({ now = this.now() } = {}) {
    const at = toDate(now);
    const interrupted = this.store.reconcileInterrupted(at);
    for (const item of interrupted) {
      this.runLog.append({
        ts: at,
        commandId: item.command.id,
        commandName: item.command.name,
        trigger: item.trigger,
        triggerDetail: defaultTriggerDetail(item.command, item.trigger),
        status: 'interrupted',
        reason: item.reason,
        stepsOk: 0,
        stepsTotal: Array.isArray(item.command.steps) ? item.command.steps.length : 0,
        occurrenceKey: item.occurrenceKey,
      });
      this._safeNotify({ title: 'Джарвис: запуск команды прервался', body: `${item.command.name}: ${item.reason}` });
    }
    const stale = this._skipStaleAndLog(at);
    return { interrupted, staleSkipped: stale };
  }

  launchOverview({ limit = 100, commandId = null, trigger = null, status = null } = {}) {
    const commands = this.store.list().map((cmd) => ({
      id: cmd.id,
      name: cmd.name,
      enabled: cmd.enabled !== false,
      folder: cmd.folder || null,
      stepsCount: flattenStepTree(cmd.steps).length,
      triggers: cmd.triggers,
      triggerState: cmd.triggerState,
      lastRunAt: cmd.lastRunAt || null,
    }));
    return {
      commands,
      log: this.runLog.list({ limit, commandId, trigger, status }),
      stats: this.runLog.stats(),
      events: EVENT_CATALOG,
    };
  }
}

module.exports = {
  runCommand,
  summarizeChainResult,
  commandReply,
  formatPartialCommandReport,
  shortCommandReceipt,
  commandLabel,
  CommandRecorder,
  recordOverview,
  UnifiedCommandLauncher,
  FORBIDDEN_PREFIXES,
};
