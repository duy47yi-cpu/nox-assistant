'use strict';

// Чистый цикл агентного режима: наблюдение -> один шаг плана -> проверка опасности -> действие -> проверка -> свежее наблюдение.
// Модуль не зависит от Electron, сети, диска и моделей: все внешние операции приходят через инъекции.

const DEFAULT_MAX_STEPS = 40;
const STATUSES = new Set(['done', 'partial', 'failed', 'stopped', 'limit', 'timeout', 'needs_human']);
const STEP_STATUSES = new Set(['done', 'failed', 'skipped', 'pending']);
const VERIFY_STATUSES = new Set(['confirmed', 'failed', 'unknown']);

const DANGER_ELEMENT = /отправ|пересл|ответ|\bsend\b|\bsubmit\b|\breply\b|подтверд|\bconfirm\b|удал|\bdelete\b|\bremove\b|установ|\binstall\b|оплат|\bpay\b|\bbuy\b|куп|покупк|оформить\s+(?:заказ|покупк)/i;
const DANGER_ACTION = /^(?:send|submit|delete|remove|install|pay|buy|ui_close_window|windows_close_all)$/i;
const DANGER_KEYS = new Set(['enter', 'return']);
const TYPE_ACTION = /(?:^|_)(?:type|input|paste)$|ввод/i;
const KEYS_ACTION = /(?:^|_)(?:keys|key|hotkey|press)$/i;

const SECRET_PAIR = /(?:^|[\s,;({[])(?:password|passwd|pwd|token|secret|api[_-]?key|cookie|auth(?:orization)?|парол[ьяюе]?|секрет|токен|ключ)\s*[:=]\s*\S+/gi;
const SECRET_TOKEN = /\b(?:sk|pk|ghp|xox[abp]|eyJ)[-_A-Za-z0-9.]{10,}\b/g;
const SAFE_TARGET_KEYS = ['id', 'name', 'role', 'window', 'app', 'url', 'path', 'file', 'query', 'to', 'keys', 'key', 'occurrence', 'minutes'];
const SCENE_STATE_KEYS = ['diff', 'signature', 'window', 'title', 'activeWindow', 'elements', 'text', 'focused', 'state', 'screen', 'hash', 'url', 'snapshot'];

function clip(value, max = 200) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

function redactText(value, max = 200) {
  if (value === undefined || value === null) return '';
  const cleaned = String(value)
    .replace(SECRET_PAIR, (m) => `${m.split(/[:=]/)[0]}=***`)
    .replace(SECRET_TOKEN, '***');
  return clip(cleaned, max);
}

function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function keyTokens(keys) {
  return String(keys ?? '')
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

// Опасный ли шаг: явный флаг, кнопка отправки/удаления/установки/оплаты или Enter после ввода текста.
// resolveTarget(step) — подпись элемента по id из сцены: desktop_click по одному id имени не имеет.
function isDangerousStep(step, { typed = false, resolveTarget = null } = {}) {
  if (!step || typeof step !== 'object') return false;
  if (step.dangerous === true || step.requiresApproval === true) return true;
  if (step.risk === 'T2' || step.risk === 'T3') return true;

  const action = String(step.action ?? step.name ?? step.tool ?? '').trim();
  if (DANGER_ACTION.test(action)) return true;

  const target = step.target ?? step.args;
  if (KEYS_ACTION.test(action)) {
    const rawKeys = typeof target === 'string' ? target : (target && (target.keys ?? target.key));
    return Boolean(typed) && keyTokens(rawKeys).some(isSendKey);
  }

  if (TYPE_ACTION.test(action)) {
    const label = target && typeof target === 'object' ? (target.name ?? target.label) : '';
    return typeof label === 'string' && DANGER_ELEMENT.test(label);
  }

  const resolved = typeof resolveTarget === 'function' ? resolveTarget(step) : null;
  const candidates = [
    step.label,
    typeof target === 'string' ? target : null,
    target && typeof target === 'object' ? target.name : null,
    target && typeof target === 'object' ? target.label : null,
    resolved && resolved.name,
  ];
  return candidates.some((c) => typeof c === 'string' && DANGER_ELEMENT.test(c));
}

function stepDisplayLabel(step) {
  if (!step) return 'шаг';
  const target = step.rawTarget;
  const label = step.description
    || (target && typeof target === 'object' ? (target.name || target.label || target.keys || target.id) : '')
    || (typeof target === 'string' && !TYPE_ACTION.test(step.action) ? target : '')
    || step.action;
  return label ? `«${redactText(label, 80)}»` : 'шаг';
}

function sanitizeTarget(action, target) {
  if (target === undefined || target === null) return null;
  if (typeof target === 'string') {
    if (TYPE_ACTION.test(action)) return `[скрыто, ${Array.from(target).length} симв.]`;
    return redactText(target, 120);
  }
  if (typeof target !== 'object' || Array.isArray(target)) return null;
  const safe = {};
  for (const key of SAFE_TARGET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) continue;
    const val = target[key];
    if (typeof val === 'string' && val.trim()) safe[key] = redactText(val, 120);
    else if (typeof val === 'number' && Number.isFinite(val)) safe[key] = val;
    else if (typeof val === 'boolean') safe[key] = val;
  }
  if (typeof target.text === 'string' || typeof target.message === 'string' || typeof target.body === 'string') {
    const raw = target.text ?? target.message ?? target.body;
    safe.text = `[скрыто, ${Array.from(String(raw)).length} симв.]`;
  }
  return Object.keys(safe).length ? safe : null;
}

function normalizeStep(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError(`agent-loop: шаг ${index} должен быть объектом`);
  }
  const action = String(raw.action ?? raw.name ?? raw.tool ?? '').trim();
  if (!action) {
    throw new Error(`agent-loop: у шага ${index} не задано действие`);
  }
  const rawTarget = raw.target !== undefined ? raw.target : (raw.args !== undefined ? raw.args : null);
  return {
    id: raw.id ? String(raw.id) : `s${index}`,
    index,
    action,
    target: sanitizeTarget(action, rawTarget),
    rawTarget,
    expect: redactText(raw.expect ?? '', 200),
    dangerous: Boolean(raw.dangerous || raw.requiresApproval || raw.risk === 'T2' || raw.risk === 'T3'),
    risk: raw.risk || null,
    label: raw.label ? redactText(raw.label, 120) : '',
    description: redactText(raw.description ?? raw.text ?? '', 200),
    optional: Boolean(raw.optional || raw.continueOnError),
    status: 'pending',
    verified: null,
    evidence: null,
    reason: null,
    durationMs: 0,
    obsChanged: null,
  };
}

// Безопасная копия шага для внешней памяти, одобрения и результата (без сырых секретов/сообщений).
function publicStep(step) {
  return {
    id: step.id,
    index: step.index,
    action: step.action,
    target: step.target,
    expect: step.expect,
    dangerous: step.dangerous,
    description: step.description,
    status: step.status,
    verified: step.verified,
    evidence: step.evidence,
    reason: step.reason,
    durationMs: step.durationMs,
  };
}

function stepSignature(step) {
  return `${step.action}|${stableKey(step.rawTarget)}`;
}

function hasSceneState(obs) {
  if (!obs) return false;
  if (typeof obs === 'string') return obs.length > 0;
  if (typeof obs !== 'object') return false;
  return SCENE_STATE_KEYS.some((k) => obs[k] !== undefined);
}

function obsFingerprint(obs) {
  if (obs === undefined || obs === null) return '';
  if (typeof obs === 'string') return obs;
  if (obs.signature !== undefined && obs.signature !== null) return String(obs.signature);
  return stableKey({
    window: obs.window,
    title: obs.title,
    activeWindow: obs.activeWindow,
    focused: obs.focused,
    url: obs.url,
    text: obs.text,
    state: obs.state,
    screen: obs.screen,
    hash: obs.hash,
    snapshot: obs.snapshot,
    elements: obs.elements,
  });
}

// Сравнение наблюдений: false — экран гарантированно не изменился; null — данных о сцене недостаточно.
function compareObservations(beforeObs, afterObs) {
  if (afterObs && afterObs.stalled === true) return false;
  const diff = afterObs && afterObs.diff;
  if (diff && typeof diff === 'object' && diff.first === false) {
    return Boolean(
      diff.windowChanged
      || diff.focusChanged
      || (Array.isArray(diff.added) && diff.added.length > 0)
      || (Array.isArray(diff.removed) && diff.removed.length > 0)
      || (Array.isArray(diff.changed) && diff.changed.length > 0)
    );
  }
  if (!hasSceneState(beforeObs) || !hasSceneState(afterObs)) return null;
  return obsFingerprint(beforeObs) !== obsFingerprint(afterObs);
}

function summarizeObservation(obs) {
  if (!obs || typeof obs !== 'object') return '';
  if (typeof obs.summary === 'string' && obs.summary.trim()) return redactText(obs.summary, 160);
  if (obs.diff && typeof obs.diff.summary === 'string') return redactText(obs.diff.summary, 160);
  const title = (obs.window && obs.window.title) || obs.title || (typeof obs.window === 'string' ? obs.window : '');
  return title ? redactText(`окно «${title}»`, 160) : '';
}

function isApproved(decision) {
  if (decision === true) return true;
  if (typeof decision === 'string') {
    return ['once', 'allow', 'approved', 'yes', 'да'].includes(decision.toLowerCase());
  }
  if (decision && typeof decision === 'object') {
    if (decision.approved === true) return true;
    const d = String(decision.decision || '').toLowerCase();
    return ['once', 'allow', 'approved', 'yes'].includes(d);
  }
  return false;
}

function normalizeVerify(verdict) {
  if (!verdict || typeof verdict !== 'object') {
    return { status: 'unknown', evidence: 'проверка не вернула результат' };
  }
  const status = VERIFY_STATUSES.has(verdict.status) ? verdict.status : 'unknown';
  const evidence = redactText(verdict.evidence ?? verdict.reason ?? verdict.summary ?? '', 240);
  return { status, evidence };
}

function stripDoneWord(text) {
  return String(text || '').replace(/готово/gi, 'выполнено');
}

function buildMessage(status, { steps, reason, maxSteps, emptyPlan }) {
  const total = steps.length;
  const doneCount = steps.filter((s) => s.status === 'done' && s.verified === 'confirmed').length;

  if (status === 'done') {
    return `Готово: выполнено и подтверждено шагов ${doneCount} из ${total}.`;
  }
  if (emptyPlan) {
    return 'План пуст: ни одного шага не задано, ничего не выполнено.';
  }

  let msg;
  const progress = total > 0 ? ` Подтверждено шагов: ${doneCount} из ${total}.` : '';
  switch (status) {
    case 'stopped':
      msg = doneCount > 0
        ? `Остановлено по запросу. Подтверждено шагов: ${doneCount} из ${total}.`
        : 'Остановлено по запросу: ни один шаг не завершён.';
      break;
    case 'timeout':
      msg = `Превышен лимит времени — останавливаюсь.${progress}`;
      break;
    case 'limit':
      msg = `Достигнут лимит шагов (${maxSteps}) — останавливаюсь.${progress}`;
      break;
    case 'needs_human':
      msg = reason ? `${reason}${doneCount > 0 ? progress : ''}` : `Нужен человек: не могу продолжить без проверки.${progress}`;
      break;
    case 'partial':
      msg = `Выполнено частично: подтверждено ${doneCount} из ${total}${reason ? ` (${reason})` : ''}.`;
      break;
    default:
      msg = reason ? `${reason}${doneCount > 0 ? progress : ''}` : `Не удалось выполнить задачу.${progress}`;
      break;
  }
  return stripDoneWord(msg);
}

// Ожидает approve(step), но немедленно прерывается при отмене AbortSignal.
async function waitApproval(approve, stepPayload, ctx) {
  const { signal } = ctx;
  if (signal && signal.aborted) return { aborted: true, approved: false };

  let onAbort;
  const abortPromise = signal
    ? new Promise((resolve) => {
      onAbort = () => resolve({ aborted: true, approved: false });
      signal.addEventListener('abort', onAbort, { once: true });
    })
    : null;

  const decisionPromise = Promise.resolve()
    .then(() => approve(stepPayload, ctx))
    .then((res) => ({ aborted: false, approved: isApproved(res) }))
    .catch(() => ({ aborted: Boolean(signal && signal.aborted), approved: false }));

  try {
    return abortPromise ? await Promise.race([decisionPromise, abortPromise]) : await decisionPromise;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Создаёт изолированный цикл агентного режима (observe -> plan -> act -> verify).
 * @param {object} deps
 */
function createAgentLoop({ observe, plan: defaultPlan, act, verify, approve, now, log, resolveTarget = null } = {}) {
  if (typeof observe !== 'function') throw new TypeError('agent-loop: observe должен быть функцией');
  if (typeof act !== 'function') throw new TypeError('agent-loop: act должен быть функцией');
  if (verify !== undefined && typeof verify !== 'function') throw new TypeError('agent-loop: verify должен быть функцией');

  const verifyFn = verify || (async () => ({ status: 'unknown', evidence: 'проверка не настроена' }));
  const approveFn = typeof approve === 'function' ? approve : async () => false;
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  const logFn = typeof log === 'function' ? log : () => {};

  const readNow = () => {
    const value = nowFn();
    return value instanceof Date ? value.getTime() : Number(value);
  };

  const emitLog = (entry) => {
    try {
      logFn(entry);
    } catch {
      // ошибки внешнего логгера не ломают цикл
    }
  };

  async function run({ goal = '', maxSteps = DEFAULT_MAX_STEPS, deadlineMs = 0, signal = null, steps: inputSteps, plan: runPlan } = {}) {
    const limit = maxSteps === undefined || maxSteps === null
      ? DEFAULT_MAX_STEPS
      : (Number.isFinite(Number(maxSteps)) && Number(maxSteps) >= 0 ? Math.floor(Number(maxSteps)) : DEFAULT_MAX_STEPS);
    const startMs = readNow();
    const deadlineAt = deadlineMs && Number(deadlineMs) > 0 ? startMs + Number(deadlineMs) : null;
    const isTimedOut = () => deadlineAt !== null && readNow() >= deadlineAt;
    const isAborted = () => Boolean(signal && signal.aborted);

    const planner = runPlan !== undefined ? runPlan : (inputSteps !== undefined ? inputSteps : defaultPlan);
    const steps = [];
    const evidence = [];

    let staticQueue = null;
    if (Array.isArray(planner)) {
      staticQueue = planner.map((item, i) => normalizeStep(item, i + 1));
      steps.push(...staticQueue);
    }

    const finalize = (status, reason = '', { emptyPlan = false } = {}) => {
      let finalStatus = STATUSES.has(status) ? status : 'failed';
      const allConfirmed = steps.length > 0 && steps.every((s) => s.status === 'done' && s.verified === 'confirmed');
      if (finalStatus === 'done' && !allConfirmed) {
        const anyDone = steps.some((s) => s.status === 'done' && s.verified === 'confirmed');
        finalStatus = anyDone ? 'partial' : 'failed';
      }
      const message = buildMessage(finalStatus, { steps, reason, maxSteps: limit, emptyPlan });
      return {
        status: finalStatus,
        steps: steps.map(publicStep),
        evidence: evidence.map((e) => ({ ...e })),
        message,
      };
    };

    const stopReasonStatus = () => (isAborted() ? 'stopped' : 'timeout');

    const safeObserve = async (phase, stepIndex, step = null, previousObservation = null) => {
      try {
        const obs = await observe({
          goal,
          phase,
          stepIndex,
          ...(step ? { step: publicStep(step) } : {}),
          ...(previousObservation ? { previousObservation } : {}),
          signal,
        });
        if (!obs || (typeof obs === 'object' && obs.ok === false)) {
          const err = obs && (obs.error || obs.reason || obs.summary);
          return { ok: false, error: err ? redactText(err, 160) : 'снимок недоступен' };
        }
        return { ok: true, value: obs };
      } catch (err) {
        return { ok: false, error: redactText(err && err.message ? err.message : err, 160) };
      }
    };

    const recordStep = (step, {
      status,
      verified = null,
      fact = '',
      obsSummary = '',
      obsChanged = null,
      startMs = readNow(),
      recordEvidence = true,
      markExecuted = true,
    }) => {
      step.status = status;
      step.verified = verified;
      step.obsChanged = obsChanged;
      if (status === 'done') step.evidence = fact;
      else {
        step.reason = fact;
        if (verified) step.evidence = fact;
      }
      step.durationMs = Math.max(0, readNow() - startMs);
      if (markExecuted) lastExecuted = step;
      if (recordEvidence && verified) {
        evidence.push({
          stepId: step.id,
          stepIndex: step.index,
          action: step.action,
          verified,
          evidence: fact,
          observationSummary: obsSummary,
          durationMs: step.durationMs,
        });
      }
      emitLog({
        stepIndex: step.index,
        stepId: step.id,
        action: step.action,
        target: step.target,
        expect: step.expect,
        status: step.status,
        verified: verified || 'skipped',
        verificationFact: fact,
        durationMs: step.durationMs,
      });
    };

    if (isAborted()) return finalize('stopped');
    if (isTimedOut()) return finalize('timeout');
    if (staticQueue && staticQueue.length === 0) return finalize('failed', '', { emptyPlan: true });
    if (!staticQueue && typeof planner !== 'function') return finalize('failed', '', { emptyPlan: true });

    // Начальное наблюдение до первого шага.
    const initialObs = await safeObserve('initial', 0);
    if (isAborted()) return finalize('stopped');
    if (isTimedOut()) return finalize('timeout');
    if (!initialObs.ok) {
      return finalize('needs_human', 'Не удалось получить снимок экрана. Останавливаюсь: проверьте экран и скажите, как продолжить.');
    }

    let observation = initialObs.value;
    let executedCount = 0;
    let cursor = 0;
    let typed = false;
    let lastExecuted = null;

    while (true) {
      if (isAborted()) return finalize('stopped');
      if (isTimedOut()) return finalize('timeout');

      // 1. Получаем ровно один следующий шаг плана.
      let step = null;
      if (staticQueue) {
        if (cursor >= staticQueue.length) break;
        step = staticQueue[cursor];
        cursor += 1;
      } else {
        let planned;
        try {
          planned = await planner({
            goal,
            observation,
            stepIndex: steps.length + 1,
            steps: steps.map(publicStep),
            evidence: evidence.map((e) => ({ ...e })),
            lastStep: lastExecuted ? publicStep(lastExecuted) : null,
            signal,
          });
        } catch (err) {
          if (isAborted() || isTimedOut()) return finalize(stopReasonStatus());
          const doneAny = steps.some((s) => s.status === 'done' && s.verified === 'confirmed');
          return finalize(doneAny ? 'partial' : 'failed', `Сбой планирования: ${redactText(err && err.message ? err.message : err, 140)}`);
        }

        if (isAborted()) return finalize('stopped');
        if (isTimedOut()) return finalize('timeout');

        if (Array.isArray(planned)) {
          if (planned.length === 0 && steps.length === 0) {
            return finalize('failed', '', { emptyPlan: true });
          }
          if (planned.length === 0) break;
          staticQueue = planned.map((item, i) => normalizeStep(item, steps.length + i + 1));
          steps.push(...staticQueue);
          step = staticQueue[0];
          cursor = 1;
        } else if (!planned || planned.done === true) {
          if (steps.length === 0) return finalize('failed', '', { emptyPlan: true });
          break;
        } else if (planned.needsHuman === true) {
          return finalize('needs_human', redactText(planned.reason || 'Нужно участие человека для продолжения.', 180));
        } else {
          step = normalizeStep(planned, steps.length + 1);
          steps.push(step);
        }
      }

      // Лимит шагов проверяется перед выполнением следующего действия.
      if (executedCount >= limit) {
        return finalize('limit');
      }

      // 2. Защита от зацикливания: два одинаковых шага подряд без эффекта — не долбить.
      if (lastExecuted && stepSignature(lastExecuted) === stepSignature(step)) {
        const noEffect = lastExecuted.obsChanged === false || lastExecuted.verified !== 'confirmed';
        if (noEffect) {
          recordStep(step, {
            status: 'skipped',
            fact: 'повтор того же шага без изменения состояния',
            startMs: readNow(),
            recordEvidence: false,
            markExecuted: false,
          });
          const realProgress = steps.some((s) => s !== lastExecuted && s.status === 'done' && s.verified === 'confirmed');
          return finalize(realProgress ? 'partial' : 'failed', 'Остановлено из-за зацикливания: два шага подряд одинаковы и эффекта нет.');
        }
      }

      // 3. Проверка опасности и запрос подтверждения.
      const stepStartMs = readNow();
      const dangerous = isDangerousStep(step, { typed, resolveTarget }) || step.dangerous;
      if (dangerous) {
        step.dangerous = true;
        const approval = await waitApproval(approveFn, {
          ...publicStep(step),
          dangerous: true,
        }, { goal, observation, signal });

        if (approval.aborted || isAborted()) {
          recordStep(step, {
            status: 'pending',
            fact: 'отменено до подтверждения',
            startMs: stepStartMs,
            recordEvidence: false,
            markExecuted: false,
          });
          return finalize('stopped');
        }
        if (isTimedOut()) return finalize('timeout');

        if (!approval.approved) {
          recordStep(step, {
            status: 'skipped',
            fact: 'опасное действие не подтверждено владельцем',
            startMs: stepStartMs,
            recordEvidence: false,
            markExecuted: false,
          });
          return finalize('needs_human', `Шаг ${stepDisplayLabel(step)} не выполнен: опасное действие не подтверждено, останавливаюсь без повтора.`);
        }
      }

      if (isAborted()) return finalize('stopped');
      if (isTimedOut()) return finalize('timeout');

      // 4. Выполнение одного действия.
      executedCount += 1;
      let actResult = null;
      let actErrMsg = '';
      try {
        actResult = await act(
          { id: step.id, index: step.index, action: step.action, target: step.rawTarget, expect: step.expect, dangerous: step.dangerous },
          { goal, observation, signal },
        );
      } catch (err) {
        actErrMsg = redactText(err && err.message ? err.message : err, 200) || 'ошибка выполнения шага';
      }

      if (actErrMsg || !actResult || actResult.ok === false) {
        const failMsg = actErrMsg || redactText((actResult && (actResult.error || actResult.summary)) || 'действие не выполнено', 200);
        if (!actErrMsg && actResult && actResult.recoverable === true) {
          recordStep(step, { status: 'skipped', verified: null, fact: failMsg, startMs: stepStartMs, recordEvidence: false, markExecuted: false });
          if (isAborted()) return finalize('stopped');
          if (isTimedOut()) return finalize('timeout');
          if (actResult.uncounted) executedCount = Math.max(0, executedCount - 1);
          continue;
        }
        recordStep(step, { status: 'failed', verified: 'failed', fact: failMsg, startMs: stepStartMs });
        if (isAborted()) return finalize('stopped');
        if (isTimedOut()) return finalize('timeout');
        if (step.optional) continue;
        const doneAny = steps.some((s) => s.status === 'done' && s.verified === 'confirmed');
        const prefix = actErrMsg ? `Шаг ${stepDisplayLabel(step)} завершился сбоем` : `Не удалось выполнить шаг ${stepDisplayLabel(step)}`;
        return finalize(doneAny ? 'partial' : 'failed', `${prefix}: ${failMsg}.`);
      }

      if (isAborted()) {
        recordStep(step, {
          status: 'failed',
          verified: 'unknown',
          fact: 'остановлено после запуска действия: результат не проверен',
          startMs: stepStartMs,
          recordEvidence: false,
        });
        return finalize('stopped');
      }

      // 5. Проверка эффекта шага.
      let verdict;
      try {
        verdict = normalizeVerify(await verifyFn(
          { id: step.id, index: step.index, action: step.action, target: step.rawTarget, expect: step.expect },
          actResult,
          { goal, before: observation, expect: step.expect, signal },
        ));
      } catch (err) {
        verdict = { status: 'unknown', evidence: redactText(`ошибка проверки: ${err && err.message ? err.message : err}`, 200) };
      }

      if (verdict.status !== 'confirmed') {
        const fact = verdict.evidence || (verdict.status === 'unknown' ? 'результат не проверен' : 'проверка не подтвердила эффект');
        recordStep(step, { status: 'failed', verified: verdict.status, fact, startMs: stepStartMs });
        if (isAborted()) return finalize('stopped');
        if (isTimedOut()) return finalize('timeout');
        if (step.optional) continue;

        const doneAny = steps.some((s) => s.status === 'done' && s.verified === 'confirmed');
        if (doneAny) return finalize('partial', `шаг ${stepDisplayLabel(step)} не подтверждён`);
        if (verdict.status === 'unknown') {
          return finalize('needs_human', `Не уверен, что шаг ${stepDisplayLabel(step)} сработал: проверка не дала подтверждения. Останавливаюсь, чтобы не повторять вслепую.`);
        }
        return finalize('failed', `Проверка не подтвердила шаг ${stepDisplayLabel(step)}: ${fact}.`);
      }

      // 6. Свежее наблюдение после шага.
      const freshObs = await safeObserve('after_step', step.index, step, observation);
      if (isAborted()) {
        recordStep(step, { status: 'done', verified: 'confirmed', fact: verdict.evidence || 'подтверждено проверкой', startMs: stepStartMs });
        return finalize('stopped');
      }

      if (!freshObs.ok) {
        recordStep(step, { status: 'done', verified: 'confirmed', fact: verdict.evidence || 'подтверждено проверкой', startMs: stepStartMs });
        return finalize('needs_human', 'Не удалось получить свежий снимок экрана после шага. Останавливаюсь: проверьте экран и скажите, как продолжить.');
      }

      const afterObs = freshObs.value;
      const obsChanged = compareObservations(observation, afterObs);
      const obsSummary = summarizeObservation(afterObs);
      observation = afterObs;

      if (TYPE_ACTION.test(step.action)) typed = true;

      recordStep(step, {
        status: 'done',
        verified: 'confirmed',
        fact: verdict.evidence || obsSummary || 'подтверждено проверкой',
        obsSummary,
        obsChanged,
        startMs: stepStartMs,
      });

      if (afterObs.stalled === true) {
        const realProgress = steps.some((s) => s !== step && s.status === 'done' && s.verified === 'confirmed');
        return finalize(realProgress ? 'partial' : 'failed', 'Остановлено: состояние экрана не меняется.');
      }

      if (isTimedOut()) {
        // Если это был последний шаг статического плана, фиксируем честный успех, иначе таймаут.
        if (staticQueue && cursor >= staticQueue.length) break;
        return finalize('timeout');
      }
    }

    const doneCount = steps.filter((s) => s.status === 'done' && s.verified === 'confirmed').length;
    const allDone = steps.length > 0 && doneCount === steps.length;
    if (allDone) return finalize('done');
    if (doneCount > 0) return finalize('partial', 'часть шагов не выполнена');
    return finalize('failed', 'Ни один шаг не подтверждён.');
  }

  return { run };
}

module.exports = {
  createAgentLoop,
  DEFAULT_MAX_STEPS,
  STATUSES,
  STEP_STATUSES,
  VERIFY_STATUSES,
  isDangerousStep,
  redactText,
};
