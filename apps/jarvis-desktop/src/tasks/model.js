'use strict';

// Задача: цель, план из шагов, статус, лимиты и журнал. Чистая модель без диска и без модели.
// Все переходы статуса проходят через transition(): недопустимый переход — ошибка.
//
// Статусы: draft (черновик), queued (в очереди), running (выполняется), waiting_approval (ждёт вашего решения),
// paused (на паузе: стоп, лимит времени или ваш запрос), blocked (заблокирована ошибкой), done (выполнено и проверено),
// unverified (выполнено, но не проверено: есть шаги без объективной проверки или проверять было нечего), cancelled.
// done, unverified и cancelled — конечные. Почему задача done или unverified — taskVerdict(); у задачи с мандатом
// итог записывается в поле verdict {code, status, reason, criteria} (queue.complete / queue.markUnverified, verdictRecord).
// Критерии приёмки (поле criteria, см. criteria.js) задаёт план исполнителя; у легаси-задач их нет.
//
// Задача с мандатом (поле mandate, см. mandate.js) ведётся исполнителем (executor.js), а не ходом чата.
// Её можно поставить в очередь и запустить без плана: план составит исполнитель после старта.
// Лимиты мандата действуют вместе с лимитами задачи: из двух значений берётся меньшее (limitsOf).

const criteriaLib = require('./criteria');

const STATUSES = ['draft', 'queued', 'running', 'waiting_approval', 'paused', 'blocked', 'done', 'unverified', 'cancelled'];

const TRANSITIONS = {
  draft: ['queued', 'cancelled'],
  queued: ['running', 'paused', 'cancelled'],
  running: ['waiting_approval', 'paused', 'blocked', 'done', 'unverified', 'cancelled'],
  waiting_approval: ['running', 'paused', 'cancelled'],
  paused: ['queued', 'cancelled'],
  blocked: ['queued', 'cancelled'],
  done: [],
  unverified: [],
  cancelled: [],
};

const FINAL_STATUSES = ['done', 'unverified', 'cancelled'];

// Лимиты по умолчанию (JARVIS-REQUIREMENTS C5). Бюджет денег и токены — в мандате (mandate.js).
const DEFAULT_LIMITS = {
  maxSteps: 100, // шагов в задаче (решение владельца 31.10.2026)
  maxFailuresPerStep: 3, // неудач подряд на одном шаге
  maxActiveMs: 4 * 60 * 60 * 1000, // 4 часа активной работы; ожидание подтверждения и пауза не входят
};

const STEP_STATUSES = ['todo', 'doing', 'done', 'failed', 'skipped'];

// Вид шага (поле kind). Нет поля — 'action': старые задачи ведут себя как раньше.
// action — действие: меняет что-то или даёт результат, который проверяется объективно (check);
// observation — наблюдение: только чтение (инструменты T0), проверки результата нет и не нужно;
// service — служебный шаг: итог или ответ в чате; действий с побочным эффектом в нём нет.
// Вид объявляет модель, но соблюдение проверяет исполнитель по фактам (executor.js: effects, отказ step_done).
const STEP_KINDS = ['action', 'observation', 'service'];
const KIND_WORDS = { action: 'действие', observation: 'наблюдение', service: 'служебный шаг' };
const MAX_STEP_FACTS = 20; // отказов и действий с побочным эффектом на шаг в записи задачи

function fail(message) {
  const err = new Error(message);
  err.code = 'task_error';
  throw err;
}

function clip(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// mandate — необязательный мандат автономной задачи (см. mandate.js). Задача хранит свою копию.
function createTask({ id, title, goal, now = Date.now(), priority = 0, limits = {}, mandate = null }) {
  if (typeof id !== 'string' || !id) fail('нужен id задачи');
  if (typeof title !== 'string' || !title.trim()) fail('нужно название задачи');
  const task = {
    id,
    title: title.trim().slice(0, 200),
    goal: typeof goal === 'string' ? goal.slice(0, 2000) : '',
    status: 'draft',
    priority: Number.isFinite(priority) ? priority : 0,
    plan: [],
    limits: { ...DEFAULT_LIMITS, ...limits },
    activeMs: 0,
    stepsUsed: 0, // выполненных вызовов инструментов
    tokensUsed: 0, // токенов модели (запрос + ответ)
    unverifiedSteps: [], // id шагов, выполненных без объективной проверки
    failures: {}, // stepId -> подряд неудач
    reason: null, // почему на паузе или заблокирована
    createdAt: now,
    updatedAt: now,
    log: [],
  };
  if (mandate && typeof mandate === 'object') task.mandate = JSON.parse(JSON.stringify(mandate));
  return task;
}

// Задачу с мандатом ведёт исполнитель: план составляет он, ход чата её не меняет.
function hasMandate(task) {
  return Boolean(task && task.mandate && typeof task.mandate === 'object');
}

// Действующие лимиты задачи. Для задачи с мандатом по каждому общему лимиту берётся меньшее значение:
// мандат может только ужесточить лимиты задачи, но не ослабить. Неверное значение в мандате не учитывается.
function limitsOf(task) {
  const out = { ...DEFAULT_LIMITS, ...((task && task.limits) || {}) };
  const fromMandate = hasMandate(task) && task.mandate.limits && typeof task.mandate.limits === 'object'
    ? task.mandate.limits
    : {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const value = fromMandate[key];
    if (Number.isFinite(value) && value > 0) out[key] = Number.isFinite(out[key]) ? Math.min(out[key], value) : value;
  }
  return out;
}

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// Меняет статус, если переход допустим. Возвращает новую копию задачи.
function transition(task, to, { reason = null, now = Date.now() } = {}) {
  if (!STATUSES.includes(to)) fail(`неизвестный статус: ${to}`);
  if (!canTransition(task.status, to)) fail(`переход ${task.status} → ${to} недопустим`);
  return {
    ...task,
    status: to,
    reason: to === 'paused' || to === 'blocked' ? reason : null,
    updatedAt: now,
    log: [...task.log, { at: now, event: `статус: ${to}`, ...(reason ? { reason } : {}) }],
  };
}

// Вид шага: поле kind или 'action' по умолчанию (старые записи без поля).
function stepKind(step) {
  return step && STEP_KINDS.includes(step.kind) ? step.kind : 'action';
}

// План: список шагов {id, title, status, kind?, check?}. Заменяет план целиком, но только до старта.
// Исключение: задача с мандатом без плана — её первый план составляет исполнитель уже после старта.
// kind: неизвестный вид — ошибка плана (исполнитель переспросит план с этой причиной).
// Проверка check бывает только у действия: у наблюдения и служебного шага проверять нечего,
// а «убедиться, что файла нет» с проверкой file_absent — это действие с объективной проверкой.
// criteria — необязательный список критериев приёмки, уже проверенный criteria.cleanCriteria (его требует
// исполнитель для нового плана). Не передан — критерии задачи не меняются (задачи чата и легаси-задачи без них).
function setPlan(task, steps, { now = Date.now(), criteria } = {}) {
  const firstExecutorPlan = hasMandate(task) && task.status === 'running' && task.plan.length === 0;
  if (task.status !== 'draft' && task.status !== 'queued' && !firstExecutorPlan) fail('план меняется только до старта');
  if (!Array.isArray(steps) || steps.length === 0) fail('план пустой');
  const { maxSteps } = limitsOf(task);
  if (steps.length > maxSteps) fail(`в плане больше ${maxSteps} шагов`);
  const plan = steps.map((s, i) => {
    const title = s && typeof s.title === 'string' ? s.title.trim() : '';
    if (!title) fail(`шаг ${i + 1} без названия`);
    const step = {
      id: typeof s.id === 'string' && s.id ? s.id : `s${i + 1}`,
      title: title.slice(0, 300),
      status: 'todo',
      check: s.check || null,
    };
    if (s.kind !== undefined && s.kind !== null) {
      if (!STEP_KINDS.includes(s.kind)) {
        fail(`шаг ${i + 1}: неизвестный вид шага «${clip(s.kind, 50)}»; есть: action (действие), observation (наблюдение), service (служебный шаг)`);
      }
      if (s.kind !== 'action' && step.check) {
        fail(`шаг ${i + 1}: у шага вида ${s.kind} (${KIND_WORDS[s.kind]}) не бывает проверки check; шаг с проверкой — action`);
      }
      step.kind = s.kind;
    }
    return step;
  });
  const ids = new Set(plan.map((s) => s.id));
  if (ids.size !== plan.length) fail('id шагов должны быть уникальны');
  const next = { ...task, plan, updatedAt: now, log: [...task.log, { at: now, event: `план: ${plan.length} шагов` }] };
  if (criteria !== undefined) {
    if (!Array.isArray(criteria)) fail('критерии приёмки — список');
    next.criteria = JSON.parse(JSON.stringify(criteria));
    next.log = [...next.log, { at: now, event: `критерии приёмки: ${criteria.length}` }];
  }
  return next;
}

// Результаты проверки критериев (criteria.evaluate) записываются в задачу. Сами критерии не меняются:
// только поле result у критериев с проверкой.
function setCriteriaResults(task, evaluated, { now = Date.now() } = {}) {
  if (!criteriaLib.hasCriteria(task)) return task;
  const byId = new Map((Array.isArray(evaluated) ? evaluated : []).map((c) => [c && c.id, c]));
  const list = task.criteria.map((c) => {
    const e = byId.get(c.id);
    return e && e.result ? { ...c, result: { verification: e.result.verification, evidence: e.result.evidence } } : c;
  });
  const confirmed = list.filter((c) => c.result && c.result.verification === 'confirmed').length;
  const checked = list.filter((c) => c.check).length;
  return {
    ...task,
    criteria: list,
    updatedAt: now,
    log: [...task.log, { at: now, event: `критерии приёмки проверены: подтверждено ${confirmed} из ${checked}` }],
  };
}

// Факт шага: отказ ({tool, target, reason}) или действие с побочным эффектом ({tool, target, backup, exitCode}).
// backup — путь резервной копии прежней версии файла, если инструмент её снял: по нему отчёт показывает, откуда откатить.
// exitCode — код выхода запуска тестов: по нему видно, прошли тесты на самом деле или упали.
function cleanFact(fact) {
  const f = fact && typeof fact === 'object' ? fact : {};
  const out = { tool: clip(f.tool, 100), target: clip(f.target, 200) };
  if (f.reason !== undefined) out.reason = clip(f.reason, 300);
  if (typeof f.backup === 'string' && f.backup) out.backup = clip(f.backup, 300);
  if (Number.isFinite(f.exitCode)) out.exitCode = f.exitCode;
  return out;
}

function cleanFacts(list) {
  return (Array.isArray(list) ? list : []).slice(-MAX_STEP_FACTS).map(cleanFact);
}

// Итог шага для отчёта: verification — confirmed | failed | unknown (проверка), none (действие без проверки)
// или not_applicable (наблюдение и служебный шаг: проверка не применима, причина — в evidence);
// evidence — что показала проверка; summary — что сказал исполнитель. Длина ограничена.
// refusals — отказы мандата на этом шаге (что пыталась сделать модель и почему отклонено);
// effects — успешные вызовы инструментов с побочным эффектом (риск выше T0). Оба списка пишет исполнитель.
function cleanResult(result) {
  const out = {
    verification: result.verification == null ? null : clip(result.verification, 20),
    evidence: clip(result.evidence, 500),
    summary: clip(result.summary, 300),
  };
  if (Array.isArray(result.refusals) && result.refusals.length) out.refusals = cleanFacts(result.refusals);
  if (Array.isArray(result.effects) && result.effects.length) out.effects = cleanFacts(result.effects);
  return out;
}

// Новый итог шага не стирает накопленные факты: отказы и действия прошлых попыток остаются (это было).
function mergeResult(prev, result) {
  const before = prev && typeof prev === 'object' ? prev : {};
  const facts = (key) => [...(Array.isArray(before[key]) ? before[key] : []), ...(Array.isArray(result[key]) ? result[key] : [])];
  return cleanResult({ ...result, refusals: facts('refusals'), effects: facts('effects') });
}

// Отметка шага. Неудача увеличивает счётчик подряд; три подряд блокируют задачу (C5).
// Для задачи с мандатом порог — меньшее из лимитов задачи и мандата (limitsOf).
// result — необязательный итог шага (см. cleanResult); сохраняется в шаге, факты прежнего итога сохраняются.
function markStep(task, stepId, status, { now = Date.now(), summary = '', result = null } = {}) {
  if (!STEP_STATUSES.includes(status)) fail(`неизвестный статус шага: ${status}`);
  const step = task.plan.find((s) => s.id === stepId);
  if (!step) fail(`шага «${stepId}» нет в плане`);
  const plan = task.plan.map((s) => {
    if (s.id !== stepId) return s;
    return result && typeof result === 'object' ? { ...s, status, result: mergeResult(s.result, result) } : { ...s, status };
  });
  const failures = { ...task.failures };
  if (status === 'failed') failures[stepId] = (failures[stepId] || 0) + 1;
  if (status === 'done') delete failures[stepId];
  let next = {
    ...task,
    plan,
    failures,
    updatedAt: now,
    log: [...task.log, { at: now, event: `шаг ${stepId}: ${status}`, ...(summary ? { summary: String(summary).slice(0, 300) } : {}) }],
  };
  if (failures[stepId] >= limitsOf(task).maxFailuresPerStep && task.status === 'running') {
    next = transition(next, 'blocked', { reason: `шаг «${step.title}» не получился ${failures[stepId]} раза подряд`, now });
  }
  return next;
}

// Учёт активного времени: только пока задача выполняется. При превышении лимита — пауза.
function addActiveTime(task, ms, { now = Date.now() } = {}) {
  const activeMs = task.activeMs + Math.max(0, ms);
  let next = { ...task, activeMs, updatedAt: now };
  if (activeMs >= task.limits.maxActiveMs && task.status === 'running') {
    next = transition(next, 'paused', { reason: 'лимит 4 часа активной работы', now });
  }
  return next;
}

// Учёт расхода без смены статуса: активное время, выполненные инструменты, токены.
// Лимиты по этим счётчикам проверяет исполнитель (executor.js) перед каждым вызовом модели и инструмента.
function addUsage(task, { activeMs = 0, steps = 0, tokens = 0 } = {}, { now = Date.now() } = {}) {
  const add = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  return {
    ...task,
    activeMs: (task.activeMs || 0) + add(activeMs),
    stepsUsed: (task.stepsUsed || 0) + add(steps),
    tokensUsed: (task.tokensUsed || 0) + add(tokens),
    updatedAt: now,
  };
}

// Шаг выполнен без объективной проверки: он попадает в список непроверенных (в отчёте — явно).
function addUnverifiedStep(task, stepId, { now = Date.now() } = {}) {
  if (!task.plan.some((s) => s.id === stepId)) fail(`шага «${stepId}» нет в плане`);
  const list = Array.isArray(task.unverifiedSteps) ? task.unverifiedSteps : [];
  if (list.includes(stepId)) return task;
  return { ...task, unverifiedSteps: [...list, stepId], updatedAt: now };
}

// Факты шага по ходу выполнения (до итога шага): отказы мандата и действия с побочным эффектом.
// Статус шага и журнал не меняются; markStep потом сохранит факты в итоге шага.
function addStepFacts(task, stepId, { refusals = [], effects = [] } = {}, { now = Date.now() } = {}) {
  if (!task.plan.some((s) => s.id === stepId)) fail(`шага «${stepId}» нет в плане`);
  if (!refusals.length && !effects.length) return task;
  const plan = task.plan.map((s) => {
    if (s.id !== stepId) return s;
    const prev = s.result && typeof s.result === 'object' ? s.result : { verification: null, evidence: '', summary: '' };
    return { ...s, result: mergeResult(prev, { ...prev, refusals, effects }) };
  });
  return { ...task, plan, updatedAt: now };
}

// Наблюдение и служебный шаг непроверенными не считаются: им проверка не применима (см. taskVerdict).
// id непроверенных шагов-действий: отмеченные явно и выполненные без проверки (на случай старой записи без списка).
function unverifiedStepIds(task) {
  const ids = new Set(Array.isArray(task.unverifiedSteps) ? task.unverifiedSteps : []);
  for (const s of task.plan) if (s.status === 'done' && !s.check) ids.add(s.id);
  return task.plan.filter((s) => ids.has(s.id) && stepKind(s) === 'action').map((s) => s.id);
}

// Итог задачи по фактам шагов. Модель на него не влияет: только виды шагов, проверки и записанные факты.
// Возвращает {status, code, reason, verified, modelOnly, unconfirmed, observations, service, effects}:
// status — 'done' | 'unverified' (статус в очереди); code — 'verified' | 'unverified' | 'not_applicable'.
//
// Правила (почему так — docs-заметка в отчёте этапа 2):
// - «завершено» (done/verified) — есть хотя бы одно действие с подтверждённой проверкой, и все выполненные
//   действия подтверждены проверкой. Без единой объективной проверки «завершено» не ставится никогда:
//   статус done в этом коде значит «выполнено и проверено»;
// - «выполнено, но не проверено» (unverified/unverified) — есть действие без проверки (оценка модели)
//   или действие с проверкой, которая не подтверждена; либо действий с проверкой нет, а действия
//   с побочным эффектом были (план что-то менял, но проверить нечем);
// - «проверка не применима» (unverified/not_applicable) — задача только читала: шагов-действий нет,
//   действий с побочным эффектом не было. Отдельного статуса в очереди для этого нет (его пришлось бы
//   показывать в окне, а окно — не этот этап), поэтому статус остаётся «выполнено, но не проверено»:
//   это правда — ответ модели объективно не проверен. Отличие несёт code и reason, их показывает отчёт.
//
// Задача с критериями приёмки (task.criteria, этап 3) — итог по критериям и шагам (criteriaVerdict):
// - verified (статус done) — все критерии подтверждены проверкой (verification: confirmed), и нет шагов-действий
//   без проверки или с неподтверждённой проверкой;
// - failed (статус unverified) — есть критерий, проверка которого не подтвердила, не удалась или не выполнялась.
//   Статус в очереди не done; отдельного статуса «не принято» нет (окно показывает code и reason), а unverified —
//   конечный статус: повторить задачу можно только новым поручением, без молчаливого повтора старого плана;
// - unverified (статус unverified) — есть критерий manual (оценка модели или проверка невозможна) или шаг-действие
//   без подтверждённой проверки.
// not_applicable для задачи с критериями не бывает: задача на чтение или исследование проверяется по критериям.
// Легаси-задача без критериев (поле отсутствует или пусто) — итог по прежним правилам ниже.
function taskVerdict(task) {
  const plan = Array.isArray(task.plan) ? task.plan : [];
  const done = plan.filter((s) => s.status === 'done');
  const actions = done.filter((s) => stepKind(s) === 'action');
  // Подтверждено — только то, что записала проверка (verification: confirmed); слова модели не в счёт.
  const confirmed = (s) => Boolean(s.result) && s.result.verification === 'confirmed';
  const verified = actions.filter((s) => s.check && confirmed(s)).map((s) => s.id);
  const modelOnly = actions.filter((s) => !s.check).map((s) => s.id);
  const unconfirmed = actions.filter((s) => s.check && !confirmed(s)).map((s) => s.id);
  const observations = done.filter((s) => stepKind(s) === 'observation').map((s) => s.id);
  const service = done.filter((s) => stepKind(s) === 'service').map((s) => s.id);
  const effects = plan.reduce((n, s) => n + (s.result && Array.isArray(s.result.effects) ? s.result.effects.length : 0), 0);
  const out = { verified, modelOnly, unconfirmed, observations, service, effects, criteria: criteriaLib.rows(task) };
  const stepParts = [];
  if (modelOnly.length) stepParts.push(`без объективной проверки (оценка модели): ${modelOnly.join(', ')}`);
  if (unconfirmed.length) stepParts.push(`проверка не подтверждена: ${unconfirmed.join(', ')}`);
  if (criteriaLib.hasCriteria(task)) return criteriaVerdict(out, stepParts);
  if (modelOnly.length || unconfirmed.length) {
    return { ...out, status: 'unverified', code: 'unverified', reason: stepParts.join('; ') };
  }
  if (verified.length) {
    return { ...out, status: 'done', code: 'verified', reason: `все шаги-действия подтверждены проверкой: ${verified.length}` };
  }
  if (effects > 0) {
    return {
      ...out,
      status: 'unverified',
      code: 'unverified',
      reason: `план менял данные (действий с побочным эффектом: ${effects}), но ни одного шага-действия с подтверждённой проверкой нет`,
    };
  }
  return {
    ...out,
    status: 'unverified',
    code: 'not_applicable',
    reason: `задача только читала: шагов-действий нет, действий с побочным эффектом не было `
      + `(наблюдений: ${observations.length}, служебных шагов: ${service.length}); объективно проверять нечего, итог — оценка модели`,
  };
}

// Итог задачи с критериями приёмки. Причины по критериям идут первыми, причины по шагам — в конце (как у легаси).
function criteriaVerdict(out, stepParts) {
  const rows = out.criteria;
  const label = (r) => `${r.id} («${r.requirement}»)`;
  const failed = rows.filter((r) => r.state === 'failed');
  const manual = rows.filter((r) => r.state === 'model_only' || r.state === 'impossible');
  if (failed.length) {
    const parts = [`критерий приёмки не подтверждён: ${failed.map((r) => `${label(r)} — ${r.evidence}`).join('; ')}`];
    if (manual.length) parts.push(`без объективной проверки: ${manual.map((r) => `${label(r)} — ${criteriaLib.MANUAL_WORDS[r.state]}`).join(', ')}`);
    return { ...out, status: 'unverified', code: 'failed', reason: [...parts, ...stepParts].join('; ') };
  }
  if (manual.length || stepParts.length) {
    const parts = [];
    const only = manual.filter((r) => r.state === 'model_only');
    const impossible = manual.filter((r) => r.state === 'impossible');
    if (only.length) parts.push(`критерий проверен только оценкой модели: ${only.map(label).join(', ')}`);
    if (impossible.length) parts.push(`критерий проверить невозможно: ${impossible.map(label).join(', ')}`);
    return { ...out, status: 'unverified', code: 'unverified', reason: [...parts, ...stepParts].join('; ') };
  }
  return {
    ...out,
    status: 'done',
    code: 'verified',
    reason: `все критерии приёмки подтверждены проверкой: ${rows.length}; шагов-действий с подтверждённой проверкой: ${out.verified.length}`,
  };
}

// Запись итога в задачу (task.verdict) для отчёта и окна: {code, status, reason, criteria}.
// status — итоговый статус задачи в очереди; criteria — строки критериев {id, requirement, state, evidence} (пусто у легаси).
function verdictRecord(v, status) {
  return { code: v.code, status, reason: v.reason, criteria: Array.isArray(v.criteria) ? v.criteria : [] };
}

// Что делать дальше: первый шаг, который не выполнен и не пропущен. null — план исчерпан.
function nextStep(task) {
  return task.plan.find((s) => s.status === 'todo' || s.status === 'doing' || s.status === 'failed') || null;
}

// Статус для человека: см. JARVIS-REQUIREMENTS J1.
function humanStatus(task) {
  switch (task.status) {
    case 'running': return 'работает';
    case 'waiting_approval': return 'ждёт подтверждения';
    case 'blocked': return 'заблокирована ошибкой';
    case 'done': return 'завершено';
    case 'unverified': return 'выполнено, но не проверено';
    case 'paused': return 'на паузе';
    case 'queued': return 'в очереди';
    case 'cancelled': return 'отменена';
    default: return 'черновик';
  }
}

module.exports = {
  STATUSES, TRANSITIONS, FINAL_STATUSES, DEFAULT_LIMITS, STEP_STATUSES, STEP_KINDS, KIND_WORDS,
  createTask, hasMandate, limitsOf, canTransition, transition, setPlan, setCriteriaResults, markStep, addActiveTime,
  addUsage, addUnverifiedStep, addStepFacts, unverifiedStepIds, taskVerdict, verdictRecord, stepKind, nextStep, humanStatus,
};
