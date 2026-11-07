'use strict';

// Ожидание условия вместо паузы вслепую: окно, файл или процесс появились. Общий срок на всю операцию.
// Различаем итоги: условие выполнено, срок истёк, опрос не удался (это не «нет окна»), остановлено.
const fs = require('fs');
const { runPowerShell, probeProcess } = require('./system');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;
const STEP_MS = 250;
const MAX_TARGET = 260;

const WINDOW_SCRIPT = [
  '$self = 0',
  '[void][int]::TryParse([string]$env:JARVIS_UI_SELF_PID, [ref]$self)',
  '$hit = @(Get-Process | Where-Object { $_.Id -ne $self -and $_.MainWindowTitle -and $_.MainWindowTitle.IndexOf($env:JARVIS_WAIT_TITLE, [StringComparison]::OrdinalIgnoreCase) -ge 0 })',
  '$hit.Count -gt 0',
].join('\n');

// true, false или null, если опрос не удался.
async function probeWindow(title, { signal, selfPid }) {
  const res = await runPowerShell(WINDOW_SCRIPT, { JARVIS_WAIT_TITLE: title, JARVIS_UI_SELF_PID: String(selfPid || '') }, { signal, timeoutMs: 5000 });
  if (!res.ok) return null;
  return String(res.data.stdout || '').trim() === 'True';
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

// resolveFile(path) → абсолютный путь или ошибка: те же границы папок, что у workspace_*.
function waitTools({ resolveFile, selfPid = process.pid, probes = {} } = {}) {
  const check = {
    window: probes.window || ((target, ctx) => probeWindow(target, { signal: ctx.signal, selfPid })),
    process: probes.process || ((target, ctx) => probeProcess(target, { signal: ctx.signal })),
    file: probes.file || ((target) => fs.existsSync(target)),
  };

  const waitFor = {
    name: 'wait_for',
    description: `Ждать, пока появится (until=appear, по умолчанию) или исчезнет (until=gone) условие: kind=window (часть заголовка окна), process (имя процесса без .exe) или file (путь). timeout_ms до ${MAX_TIMEOUT_MS}, по умолчанию ${DEFAULT_TIMEOUT_MS}. Использовать вместо wait, когда понятно, чего ждём: например, после app_open перед ui_click или после закрытия окна.`,
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['window', 'process', 'file'] },
        target: { type: 'string', minLength: 1, maxLength: MAX_TARGET },
        timeout_ms: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
        until: { type: 'string', enum: ['appear', 'gone'], default: 'appear' },
      },
      required: ['kind', 'target'],
    },
    async run(args = {}, ctx = {}) {
      const { kind } = args;
      if (!Object.prototype.hasOwnProperty.call(check, kind)) return { ok: false, summary: 'kind: window, process или file', data: {} };
      let target = String(args.target ?? '').trim();
      if (!target || target.length > MAX_TARGET) return { ok: false, summary: `target: от 1 до ${MAX_TARGET} символов`, data: {} };
      const timeoutMs = args.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeout_ms);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return { ok: false, summary: `timeout_ms от 1 до ${MAX_TIMEOUT_MS}`, data: {} };
      const until = args.until === undefined ? 'appear' : args.until;
      if (until !== 'appear' && until !== 'gone') return { ok: false, summary: 'until: appear или gone', data: {} };
      // Ждём значения «есть ли» (true) или «нет» (false); null от опроса означает «не знаю», ни то ни другое.
      const want = until === 'appear';
      if (kind === 'process') {
        target = target.replace(/\.exe$/i, '');
        if (!/^[\w .()-]{1,80}$/.test(target)) return { ok: false, summary: 'некорректное имя процесса', data: {} };
      }
      if (kind === 'file') {
        if (typeof resolveFile !== 'function') return { ok: false, summary: 'ожидание файла здесь недоступно', data: {} };
        try {
          target = resolveFile(target);
        } catch (err) {
          return { ok: false, summary: `файл: ${err.message}`, data: {} };
        }
      }

      const { signal } = ctx;
      const started = Date.now();
      let probeFailed = false;
      for (;;) {
        if (signal && signal.aborted) return { ok: false, summary: 'остановлено', data: { kind, stopped: true } };
        let seen = null;
        try {
          seen = await check[kind](target, ctx);
        } catch {
          seen = null;
        }
        if (signal && signal.aborted) return { ok: false, summary: 'остановлено', data: { kind, stopped: true } };
        const ms = Date.now() - started;
        if (seen === want) {
          const summary = want ? `дождался за ${ms} мс` : `исчезло за ${ms} мс`;
          return { ok: true, summary, data: { kind, until, seen, ms } };
        }
        probeFailed = seen === null;
        const left = timeoutMs - ms;
        if (left <= 0) {
          const what = want ? 'не появилось' : 'не исчезло';
          const unknown = probeFailed ? `опросить не удалось за ${timeoutMs} мс: ${want ? 'появилось ли' : 'исчезло ли'}, неизвестно` : `${what} за ${timeoutMs} мс`;
          return { ok: false, summary: unknown, data: { kind, until, seen: probeFailed ? null : !want, ms } };
        }
        await sleep(Math.min(STEP_MS, left), signal);
      }
    },
    // Итог уже получен чтением настоящего состояния.
    async verify() {
      return { status: 'confirmed', evidence: 'условие прочитано' };
    },
  };
  return [waitFor];
}

module.exports = { waitTools, MAX_TIMEOUT_MS, sleep };
