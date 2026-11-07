'use strict';

// Исполнитель пользовательской команды: шаги {tool, args} по порядку через ту же политику,
// что и обычный агент. Команда не может запускать mission_* и command_* (фоновые задачи
// и управление самими командами доступны только из чата). Остановка на первом неуспешном шаге.
const { randomUUID } = require('crypto');
const { checkEffect } = require('../agent/effects');
const { maskArgsForJournal, checkSteps, MAX_STEPS } = require('./store');
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
  let waiting;
  try {
    // Сначала регистрируем запрос, потом сообщаем UI: быстрый ответ не потеряется.
    waiting = Promise.resolve(approvals.request(payload));
  } catch {
    return 'reject';
  }
  const onAbort = () => approvals.respond(payload.id, 'reject');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  emit({ type: 'approval_request', ...payload });
  try {
    return await waiting;
  } catch {
    return 'reject';
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Выполняет один шаг. Всегда пишет журнал и tool_result, ровно один раз.
async function runStep(cmd, step, deps) {
  const { tools, policy, journal, workspace, mode, signal, approvals } = deps;
  const emit = typeof deps.emit === 'function' ? deps.emit : noop;
  const id = randomUUID();
  const name = typeof step?.tool === 'string' ? step.tool : '';
  const args = step?.args ?? {};
  let risk = null;
  let verified = null;
  let evidence = null;

  const finish = (decision, ok, summary) => {
    // В журнал — копия аргументов без секретов (пароль, токен, ключ), форма и длины сохраняются.
    journal.append({ tool: name, args: maskArgsForJournal(name, args), risk, mode, decision, ok, summary, source: 'command', command: cmd.id, verified, evidence });
    const check = verified ? { verified, evidence: evidence || '' } : {};
    emit({ type: 'tool_result', id, ok, summary, ...check });
    return { tool: name, ok, summary, ...check };
  };

  if (signal && signal.aborted) return finish('reject', false, 'отменено');
  if (isForbidden(name)) return finish('deny', false, FORBIDDEN_SUMMARY);

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
      ownerCommand: deps.ownerCommand === true,
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
  if (verdict === 'deny') return finish('deny', false, 'отклонено');
  if (verdict === 'ask') {
    const payload = {
      id,
      name: tool.name,
      args,
      risk: tool.risk,
      reason: `команда «${commandLabel(cmd, tool)}»`,
    };
    const answer = await askApproval(approvals, emit, payload, signal);
    if (!ANSWERS.has(answer)) return finish('reject', false, 'отклонено');
    decision = answer;
  }

  emit({ type: 'tool_start', id, name: tool.name, args, risk: tool.risk });
  let ok = false;
  let summary;
  try {
    const ctx = { workspace, signal };
    const r = await checkEffect(tool, args, await tool.run(args, ctx), ctx);
    ok = Boolean(r && r.ok);
    summary = String(r && r.summary != null ? r.summary : '');
    verified = (r && r.verified) || null;
    evidence = (r && r.evidence) || null;
  } catch (err) {
    ok = false;
    summary = `ошибка: ${errText(err)}`;
  }
  return finish(decision, ok, summary);
}

// Запускает команду. Возвращает {ok, results}, где results = [{tool, ok, summary}].
// ok = true только если выполнены все шаги; пустая команда ok = false.
async function runCommand(cmd, deps = {}) {
  // Зафиксировать выбранную команду: последующие изменения редактора не должны
  // подменять шаги уже запущенного исполнения.
  cmd = cmd ? structuredClone(cmd) : cmd;
  // Выключенная команда не выполняется, даже если её вызвали в обход выключенной кнопки в окне.
  if (cmd && cmd.enabled === false) {
    return { ok: false, error: 'команда выключена', results: [{ tool: '', ok: false, summary: 'команда выключена' }] };
  }
  const steps = cmd && Array.isArray(cmd.steps) ? cmd.steps : [];
  const results = [];
  if (steps.length === 0) return { ok: false, results };
  // Аварийный стоп обрывает и идущий шаг, а не только следующий.
  const stopped = new AbortController();
  const off = deps.stop ? deps.stop.onTrigger(() => stopped.abort()) : null;
  const signal = deps.signal ? AbortSignal.any([deps.signal, stopped.signal]) : stopped.signal;
  try {
    for (const step of steps) {
      if (deps.stop && deps.stop.isStopped()) {
        results.push({ tool: step.tool, ok: false, summary: 'остановлено: аварийный стоп' });
        return { ok: false, results };
      }
      const result = await runStep(cmd, structuredClone(step), { ...deps, signal });
      results.push(result);
      if (!result.ok) return { ok: false, results };
    }
    return { ok: true, results };
  } finally {
    if (off) off();
  }
}

// Текст о запуске ярлыка для истории чата: модель видит, что уже сделано, и не путает это с новой просьбой.
function commandReply(cmd, out) {
  const head = out.ok ? `Команда «${cmd.name}» выполнена.` : `Команда «${cmd.name}» остановлена на шаге с ошибкой.`;
  const lines = (out.results || []).map((r) => `- ${r.tool}: ${String(r.summary || (r.ok ? 'готово' : 'ошибка')).slice(0, 200)}`);
  return [head, ...lines].join('\n');
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
      [clean] = checkSteps([{ tool, args }], { strictArgs: true, warnings: strictWarnings });
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

module.exports = {
  runCommand, commandReply, commandLabel, CommandRecorder, recordOverview, FORBIDDEN_PREFIXES,
};
