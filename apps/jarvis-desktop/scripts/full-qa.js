'use strict';

/* Единый ночной прогон живых проверок Nox: все стенды по очереди, каждый — на своём временном профиле.
 *
 * Запуск из apps/jarvis-desktop обычным Node (Electron внутри поднимают сами стенды):
 *   node scripts/full-qa.js [--out-dir <папка>] [--only <список>] [--skip <список>]
 *     [--continue-on-fail] [--json] [--with-model] [--rev <папка>] [--list]
 *
 * Параметры:
 *   --out-dir <папка>   куда писать артефакты стендов и отчёт full-qa.md
 *                       (по умолчанию папка во временных файлах);
 *   --only <список>     только перечисленные проверки (id через запятую);
 *   --skip <список>     исключить перечисленные проверки (id через запятую);
 *   --continue-on-fail  после упавшей проверки идти дальше (по умолчанию — стоп);
 *   --json              напечатать итог одной JSON-строкой (таблица не печатается);
 *   --with-model        разрешить проверки с настоящей моделью (aether-a11y-qa --real-model);
 *                       ключи должны быть в окружении вызывающего, платные вызовы по умолчанию запрещены;
 *   --rev <папка>       корень rev для голосового стенда: _probe/cmd/s1.wav и _models/gigaam
 *                       (можно переменной NOX_QA_REV);
 *   --list              показать id проверок и выйти.
 *
 * Id: voice, orbs, aether, a11y, commands, connections, motion, legacy-verify, legacy-screens.
 * Классическая оболочка проверяется с NOX_UI=legacy (стенды сами пишут временные настройки).
 *
 * Код выхода: 0 — все выбранные проверки прошли; 1 — есть сбой или ни одна не запускалась;
 * 2 — неверные параметры. Ничего не коммитит, пакеты не ставит, .env и настоящую data/ не читает.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const STARTED_AT = Date.now();

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
function has(name) {
  return process.argv.includes('--' + name);
}
function parseList(raw) {
  return String(raw || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}
function stamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate())
    + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

const OUT_ARG = String(arg('out-dir', '') || '').trim();
const OUT_DIR = path.resolve(OUT_ARG || path.join(os.tmpdir(), 'nox-full-qa', stamp()));
const WITH_MODEL = has('with-model');
const CONTINUE_ON_FAIL = has('continue-on-fail');
const JSON_MODE = has('json');
const REV = String(arg('rev', '') || process.env.NOX_QA_REV || '').trim();
const ONLY = parseList(arg('only', ''));
const SKIP = parseList(arg('skip', ''));

function findElectron() {
  const candidate = path.join(APP_DIR, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (fs.existsSync(candidate)) return candidate;
  try {
    const fromPackage = require('electron');
    if (typeof fromPackage === 'string' && fs.existsSync(fromPackage)) return fromPackage;
  } catch { /* пакет electron есть не всегда */ }
  return '';
}
const ELECTRON = findElectron();

function electronVersion() {
  try {
    return String(require(path.join(APP_DIR, 'node_modules', 'electron', 'package.json')).version);
  } catch {
    return 'неизвестна';
  }
}

function lastJsonLine(stdout, marker) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (marker) {
      const prefix = marker + ' ';
      if (!line.startsWith(prefix)) continue;
      try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
    }
    if (line.startsWith('{') && line.endsWith('}')) {
      try { return JSON.parse(line); } catch { return null; }
    }
  }
  return null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function countsOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const pick = (key) => {
    const value = payload[key];
    return num(value);
  };
  const passed = pick('pass') !== null ? pick('pass') : pick('passed');
  const failed = pick('fail') !== null ? pick('fail') : pick('failed');
  if (passed === null && failed === null) return null;
  return { passed: passed === null ? 0 : passed, failed: failed === null ? 0 : failed, skipped: 0 };
}

const VOICE_FLAGS = [
  'legacySettingsSilent', 'local', 'cloud', 'prefixRequired', 'noPrefix', 'silentReply',
  'cloudFailure', 'offlineFallback', 'micError', 'cloudOutput',
];

const CHECKS = [
  {
    id: 'voice',
    title: 'Голосовой ввод и озвучка',
    model: () => 'без модели',
    timeoutMs: 300000,
    build(ctx) {
      const rev = ctx.rev;
      if (!rev) return { skip: 'нужен --rev или NOX_QA_REV: папка с _probe/cmd/s1.wav и _models/gigaam' };
      if (!fs.existsSync(path.join(rev, '_probe', 'cmd', 's1.wav'))) return { skip: 'в ' + rev + ' нет _probe/cmd/s1.wav' };
      if (!fs.existsSync(path.join(rev, '_models', 'gigaam'))) return { skip: 'в ' + rev + ' нет _models/gigaam (локальный движок распознавания)' };
      return { runs: [{ label: 'живой прогон', args: [path.join('scripts', 'voice-qa.js'), rev, path.join(ctx.outDir, 'voice'), '--live'] }] };
    },
    parse(run) {
      const payload = lastJsonLine(run.stdout, null);
      const filled = payload ? VOICE_FLAGS.filter((key) => payload[key]).length : 0;
      const ok = !run.timedOut && run.code === 0 && Boolean(payload) && !payload.error;
      return {
        ok,
        counts: { passed: filled, failed: ok ? 0 : Math.max(1, VOICE_FLAGS.length - filled), skipped: 0 },
        detail: payload && payload.error ? String(payload.error).split('\n')[0]
          : (ok ? 'локальное и облачное распознавание, отказ, потеря сети, микрофон, озвучка и чтение вслух'
            : 'нет итогового JSON или ненулевой код'),
      };
    },
  },
  {
    id: 'orbs',
    title: 'Сферы Nox Aether',
    model: () => 'без модели',
    timeoutMs: 360000,
    // orbs-qa сам поднимает Electron дважды (запись и перезапуск) и печатает ORBS_QA
    // только из node-обёртки, поэтому запускаем его обычным Node, а не Electron.
    runtime: 'node',
    build(ctx) {
      return { runs: [{ label: 'сферы (два запуска)', args: [path.join('scripts', 'orbs-qa.js'), '--out-dir', path.join(ctx.outDir, 'orbs')] }] };
    },
    parse(run) {
      const payload = lastJsonLine(run.stdout, 'ORBS_QA');
      return {
        ok: !run.timedOut && run.code === 0 && Boolean(payload) && payload.ok !== false,
        counts: countsOf(payload),
        detail: payload && payload.error ? String(payload.error) : (payload ? 'сферы, состояния, голос, пауза, DPR/FPS, мастерская и перезапуск' : 'нет строки ORBS_QA'),
      };
    },
  },
  {
    id: 'aether',
    title: 'Чат Aether и оформление',
    model: () => 'локальная заглушка',
    timeoutMs: 330000,
    build(ctx) {
      return {
        runs: [{
          label: 'chat-redesign',
          args: [path.join('scripts', 'aether-qa.js'), '--out-dir', path.join(ctx.outDir, 'aether'), '--chat-redesign'],
        }],
      };
    },
    parse(run) {
      const payload = lastJsonLine(run.stdout, 'AETHER_QA_RESULT');
      return {
        ok: !run.timedOut && run.code === 0 && Boolean(payload) && payload.ok !== false,
        counts: countsOf(payload),
        detail: payload && payload.error ? String(payload.error) : (payload ? 'рейка, сцена, карточки чата, настройки озвучки на 1200x720 и 864x520' : 'нет строки AETHER_QA_RESULT'),
      };
    },
  },
  {
    id: 'a11y',
    title: 'Доступность Aether',
    model: (ctx) => (ctx.withModel ? 'настоящая модель' : 'локальная заглушка'),
    timeoutMs: 330000,
    build(ctx) {
      const args = [path.join('scripts', 'aether-a11y-qa.js'), '--out-dir', path.join(ctx.outDir, 'a11y')];
      if (ctx.withModel) args.push('--real-model');
      return { runs: [{ label: ctx.withModel ? 'real-model' : 'стенд доступности', args }] };
    },
    parse(run) {
      const payload = lastJsonLine(run.stdout, 'A11Y_QA_RESULT');
      return {
        ok: !run.timedOut && run.code === 0 && Boolean(payload) && payload.ok !== false,
        counts: countsOf(payload),
        detail: payload && payload.error ? String(payload.error) : (payload ? 'Tab/Esc по разделам, фокус, модалки, aria-live, имена кнопок' : 'нет строки A11Y_QA_RESULT'),
      };
    },
  },
  {
    id: 'commands',
    title: 'Раздел «Команды»',
    model: () => 'без модели',
    timeoutMs: 240000,
    build(ctx) {
      return {
        runs: [{
          label: 'QA 15 проверок',
          args: [path.join('scripts', 'nox-commands-shot.js'), '--mode', 'qa', '--out', path.join(ctx.outDir, 'commands', 'commands-qa.png')],
        }],
      };
    },
    parse(run) {
      const payload = lastJsonLine(run.stdout, 'NOX_CMD_SHOT_RESULT');
      const counts = payload && payload.qa ? {
        passed: num(payload.qa.passed) || 0,
        failed: num(payload.qa.failed) || 0,
        skipped: num(payload.qa.skipped) || 0,
      } : null;
      return {
        ok: !run.timedOut && run.code === 0 && Boolean(payload) && payload.ok !== false && (!counts || counts.failed === 0),
        counts,
        detail: payload && payload.error ? String(payload.error) : (payload ? 'каталог, свойства, шаги, новая команда, паки, журнал, чат, 864x520, консоль' : 'нет строки NOX_CMD_SHOT_RESULT'),
      };
    },
  },
  {
    id: 'connections',
    title: 'Раздел «Подключения» (классическая оболочка)',
    model: () => 'без модели',
    timeoutMs: 240000,
    build(ctx) {
      return {
        runs: [{
          label: 'QA с живым MCP-сервером · NOX_UI=legacy',
          env: { NOX_UI: 'legacy' },
          args: [path.join('scripts', 'nox-connections-shot.js'), '--mode', 'qa', '--out', path.join(ctx.outDir, 'connections', 'connections-qa.png')],
        }],
      };
    },
    parse(run) {
      const payload = lastJsonLine(run.stdout, 'NOX_CONN_SHOT_RESULT');
      const counts = payload && payload.qa ? {
        passed: num(payload.qa.passed) || 0,
        failed: num(payload.qa.failed) || 0,
        skipped: 0,
      } : null;
      return {
        ok: !run.timedOut && run.code === 0 && Boolean(payload) && payload.ok !== false && (!counts || counts.failed === 0),
        counts,
        detail: payload && payload.error ? String(payload.error) : (payload ? 'список, состояния, поиск, детали, добавление, удаление, drift, ошибка, чат, 864x520' : 'нет строки NOX_CONN_SHOT_RESULT'),
      };
    },
  },
  {
    id: 'motion',
    title: 'Уменьшение движения',
    model: () => 'без модели',
    timeoutMs: 300000,
    build() {
      const variants = [
        ['Анимации вкл · Windows без ключа', ['--motion', 'on', '--system', 'free']],
        ['Анимации вкл · Windows просит reduce', ['--motion', 'on', '--system', 'reduce']],
        ['Анимации выкл · Windows без ключа', ['--motion', 'off', '--system', 'free']],
        ['Анимации выкл · Windows просит reduce', ['--motion', 'off', '--system', 'reduce']],
      ];
      return { runs: variants.map(([label, args]) => ({ label, args: [path.join('scripts', 'motion-qa.js')].concat(args) })) };
    },
    parse(run) {
      const payload = lastJsonLine(run.stdout, 'NOX_MOTION_QA_RESULT');
      return {
        ok: !run.timedOut && run.code === 0 && Boolean(payload) && payload.ok !== false,
        counts: countsOf(payload),
        detail: payload && payload.error ? String(payload.error) : (payload ? 'prefers-reduced-motion, девять эффектов фона, переключатель «Анимации»' : 'нет строки NOX_MOTION_QA_RESULT'),
      };
    },
  },
  {
    id: 'legacy-verify',
    title: 'Классический экран Nox (проверка)',
    model: () => 'локальная заглушка',
    timeoutMs: 360000,
    build(ctx) {
      return {
        runs: [{
          label: 'NOX_UI=legacy',
          env: { NOX_UI: 'legacy' },
          args: [path.join('scripts', 'nox-qa-verify.js'), '--out-dir', path.join(ctx.outDir, 'legacy-verify')],
        }],
      };
    },
    parse(run) {
      const payload = lastJsonLine(run.stdout, 'NOX_QA_RESULT');
      const checks = payload && Array.isArray(payload.checks) ? payload.checks : null;
      const counts = checks ? {
        passed: checks.filter((item) => item && item.ok).length,
        failed: checks.filter((item) => item && !item.ok).length,
        skipped: 0,
      } : countsOf(payload);
      return {
        ok: !run.timedOut && run.code === 0 && Boolean(payload) && payload.ok !== false,
        counts,
        detail: payload && payload.error ? String(payload.error) : (payload ? 'чат, отправка, отмена, прокрутка, resize, копирование, FPS' : 'нет строки NOX_QA_RESULT'),
      };
    },
  },
  {
    id: 'legacy-screens',
    title: 'Классические разделы Nox (снимки)',
    model: () => 'без модели',
    timeoutMs: 330000,
    build(ctx) {
      return {
        runs: [{
          label: 'NOX_UI=legacy',
          env: { NOX_UI: 'legacy' },
          args: [path.join('scripts', 'nox-screens-shot.js'), '--out', path.join(ctx.outDir, 'legacy-screens')],
        }],
      };
    },
    parse(run) {
      const payload = lastJsonLine(run.stdout, 'NOX_SCREENS_RESULT');
      const checks = payload && Array.isArray(payload.checks) ? payload.checks : null;
      const counts = checks ? {
        passed: checks.filter((item) => item && item.ok).length,
        failed: checks.filter((item) => item && !item.ok).length,
        skipped: 0,
      } : null;
      return {
        ok: !run.timedOut && run.code === 0 && Boolean(payload) && payload.ok !== false,
        counts,
        detail: payload && payload.error ? String(payload.error) : (payload ? 'шесть разделов на трёх размерах, навигация и отсутствие переполнения' : 'нет строки NOX_SCREENS_RESULT'),
      };
    },
  },
];

function selectedChecks() {
  const allIds = CHECKS.map((item) => item.id);
  const unknown = ONLY.concat(SKIP).filter((id) => allIds.indexOf(id) < 0);
  if (unknown.length) {
    console.error('full-qa: неизвестные id проверок: ' + unknown.join(', '));
    console.error('full-qa: доступны: ' + allIds.join(', '));
    process.exit(2);
  }
  let list = CHECKS;
  if (ONLY.length) list = list.filter((item) => ONLY.indexOf(item.id) >= 0);
  if (SKIP.length) list = list.filter((item) => SKIP.indexOf(item.id) < 0);
  if (!list.length) {
    console.error('full-qa: после --only/--skip не осталось ни одной проверки');
    process.exit(2);
  }
  return list;
}

function execRun(def, run) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, run.env || {});
    delete env.ELECTRON_RUN_AS_NODE;
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = '';
    let child;
    const runtime = def.runtime === 'node' ? process.execPath : ELECTRON;
    try {
      child = spawn(runtime, run.args, { cwd: APP_DIR, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: String(err && err.message ? err.message : err), elapsedMs: Date.now() - started });
      return;
    }
    const limit = 8 * 1024 * 1024;
    child.stdout.on('data', (chunk) => { if (stdout.length < limit) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { if (stderr.length < limit) stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* уже вышел */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* уже вышел */ } }, 5000).unref();
    }, def.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      spawnError = String(err && err.message ? err.message : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, error: spawnError, elapsedMs: Date.now() - started });
    });
  });
}

function statusWord(status) {
  if (status === 'ok') return 'OK';
  if (status === 'fail') return 'ПРОВАЛ';
  if (status === 'skip') return 'ПРОПУСК';
  return 'НЕ ЗАПУСКАЛАСЬ';
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(1) + ' с';
}

function countText(counts) {
  if (!counts) return '—';
  const total = counts.passed + counts.failed;
  const base = String(counts.passed) + '/' + String(total);
  return counts.skipped ? base + ' (пропущено ' + String(counts.skipped) + ')' : base;
}

function truncate(text, limit) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(0, Math.floor(limit / 2)) + '\n… [сокращено ' + String(value.length - limit) + ' символов] …\n' + value.slice(-Math.floor(limit / 2));
}

function runLogSection(def, run, result, parsed) {
  const lines = [];
  lines.push('Команда: ' + [def.runtime === 'node' ? process.execPath : ELECTRON].concat(run.args).join(' '));
  if (run.env) lines.push('Окружение: ' + Object.keys(run.env).map((key) => key + '=' + run.env[key]).join(', '));
  lines.push('Код выхода: ' + String(result.code) + (result.timedOut ? ' (таймаут)' : '') + '; время: ' + formatSeconds(result.elapsedMs));
  lines.push('Итог: ' + (parsed.ok ? 'OK' : 'ПРОВАЛ') + (parsed.detail ? ' — ' + parsed.detail : ''));
  lines.push('');
  lines.push('stdout:');
  lines.push(truncate(result.stdout, 240000));
  if (result.stderr) {
    lines.push('');
    lines.push('stderr:');
    lines.push(truncate(result.stderr, 60000));
  }
  return lines.join('\n');
}

async function runCheck(def, ctx) {
  const dir = path.join(ctx.outDir, def.id);
  fs.mkdirSync(dir, { recursive: true });
  let built;
  try {
    built = def.build(ctx);
  } catch (err) {
    return { id: def.id, title: def.title, mode: def.model(ctx), status: 'fail', counts: null, elapsedMs: 0, dir, reason: 'сборка команды: ' + String(err && err.message ? err.message : err), logs: '' };
  }
  if (built.skip) {
    return { id: def.id, title: def.title, mode: def.model(ctx), status: 'skip', counts: null, elapsedMs: 0, dir, reason: built.skip, logs: '' };
  }
  const runs = built.runs;
  const results = [];
  const logs = [];
  let elapsedMs = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (!JSON_MODE) process.stdout.write('    ' + (run.label || ('запуск ' + String(index + 1))) + ' … ');
    const result = await execRun(def, run);
    let parsed;
    try {
      parsed = def.parse(result) || { ok: false };
    } catch (err) {
      parsed = { ok: false, counts: null, detail: 'разбор итога: ' + String(err && err.message ? err.message : err) };
    }
    if (result.timedOut) {
      parsed.ok = false;
      parsed.detail = 'таймаут ' + formatSeconds(def.timeoutMs) + (parsed.detail ? ' · ' + parsed.detail : '');
    } else if (result.code !== 0) {
      parsed.ok = false;
    }
    if (result.error) {
      parsed.ok = false;
      parsed.detail = 'запуск: ' + result.error;
    }
    results.push({ run, result, parsed });
    elapsedMs += result.elapsedMs;
    logs.push(runLogSection(def, run, result, parsed));
    if (!JSON_MODE) console.log(parsed.ok ? 'OK' : 'ПРОВАЛ');
    if (!parsed.ok && !CONTINUE_ON_FAIL) break;
  }
  const failedRun = results.find((item) => !item.parsed.ok);
  let counts = null;
  for (const item of results) {
    if (!item.parsed.counts) continue;
    if (!counts) counts = { passed: 0, failed: 0, skipped: 0 };
    counts.passed += item.parsed.counts.passed;
    counts.failed += item.parsed.counts.failed;
    counts.skipped += item.parsed.counts.skipped;
  }
  const status = results.length === runs.length && !failedRun ? 'ok' : 'fail';
  const checkResult = {
    id: def.id,
    title: def.title,
    mode: def.model(ctx),
    status,
    counts,
    elapsedMs,
    dir,
    reason: failedRun ? (failedRun.parsed.detail || '') : '',
    logs: logs.join('\n\n---\n\n'),
  };
  try {
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
      id: checkResult.id,
      status: checkResult.status,
      counts: checkResult.counts,
      elapsedMs: checkResult.elapsedMs,
      reason: checkResult.reason,
      runs: results.map((item) => ({
        label: item.run.label || null,
        command: [def.runtime === 'node' ? process.execPath : ELECTRON].concat(item.run.args),
        code: item.result.code,
        timedOut: item.result.timedOut,
        ok: item.parsed.ok,
        detail: item.parsed.detail || null,
        elapsedMs: item.result.elapsedMs,
      })),
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'run.log'), checkResult.logs, 'utf8');
  } catch { /* артефакты не критичны для итога */ }
  return checkResult;
}

function buildMarkdown(summary) {
  const lines = [];
  lines.push('# Единый прогон Nox — ' + summary.dateLocal);
  lines.push('');
  lines.push('- Начат: ' + summary.startedAt + '; закончен: ' + summary.finishedAt + '; всего: ' + formatSeconds(summary.elapsedMs));
  lines.push('- Electron: ' + summary.electronPath + ' (v' + summary.electronVersion + ')');
  lines.push('- Режим модели: ' + (summary.withModel ? 'разрешены проверки с настоящей моделью (--with-model)' : 'без платных вызовов (--with-model не задан)'));
  lines.push('- Параметры: only=' + (summary.only.length ? summary.only.join(',') : '—') + '; skip=' + (summary.skip.length ? summary.skip.join(',') : '—') + '; продолжать после сбоя: ' + (summary.continueOnFail ? 'да' : 'нет'));
  lines.push('- Артефакты: ' + summary.outDir);
  lines.push('');
  lines.push('## Итог: ' + (summary.ok ? 'OK' : 'FAIL'));
  lines.push('');
  lines.push('| проверка | режим | статус | проверок | время | папка артефактов |');
  lines.push('|---|---|---|---|---|---|');
  for (const check of summary.checks) {
    const status = statusWord(check.status);
    const extra = check.reason && (check.status === 'fail' || check.status === 'skip') ? ' — ' + String(check.reason).split('\n')[0].slice(0, 180) : '';
    lines.push('| ' + check.id + ' — ' + check.title + ' | ' + check.mode + ' | ' + status + extra + ' | ' + countText(check.counts) + ' | ' + (check.elapsedMs ? formatSeconds(check.elapsedMs) : '—') + ' | ' + check.dir + ' |');
  }
  lines.push('');
  lines.push('## Подробности');
  for (const check of summary.checks) {
    lines.push('');
    lines.push('### ' + check.id + ' — ' + check.title);
    lines.push('');
    lines.push('- Статус: ' + statusWord(check.status) + (check.reason ? ' — ' + check.reason : ''));
    lines.push('- Режим: ' + check.mode);
    lines.push('- Проверок: ' + countText(check.counts));
    lines.push('- Время: ' + (check.elapsedMs ? formatSeconds(check.elapsedMs) : '—'));
    lines.push('- Артефакты: ' + check.dir);
    if (check.logs) {
      lines.push('');
      lines.push('~~~');
      lines.push(check.logs);
      lines.push('~~~');
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  if (has('list')) {
    console.log(CHECKS.map((item) => item.id).join('\n'));
    return 0;
  }
  if (!ELECTRON) {
    console.error('full-qa: не найден electron.exe в node_modules/electron/dist');
    return 2;
  }
  const list = selectedChecks();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ctx = { outDir: OUT_DIR, rev: REV, withModel: WITH_MODEL };
  if (!JSON_MODE) {
    console.log('Единый прогон Nox: ' + String(list.length) + ' проверок по очереди');
    console.log('Модель: ' + (WITH_MODEL ? 'разрешены проверки с настоящей моделью (--with-model)' : 'без платных вызовов (--with-model не задан)'));
    console.log('Артефакты и отчёт: ' + OUT_DIR);
    console.log('');
  }
  const results = [];
  let stopped = false;
  for (let index = 0; index < list.length; index += 1) {
    const def = list[index];
    if (stopped) {
      results.push({ id: def.id, title: def.title, mode: def.model(ctx), status: 'not-run', counts: null, elapsedMs: 0, dir: path.join(OUT_DIR, def.id), reason: 'не запускалась: прогон остановлен после сбоя', logs: '' });
      continue;
    }
    if (!JSON_MODE) console.log('[' + String(index + 1) + '/' + String(list.length) + '] ' + def.title + ' (' + def.model(ctx) + ')');
    const result = await runCheck(def, ctx);
    results.push(result);
    if (!JSON_MODE) {
      const extra = result.reason ? ' — ' + String(result.reason).split('\n')[0] : '';
      console.log('    итог: ' + statusWord(result.status) + ' · ' + countText(result.counts) + ' · ' + (result.elapsedMs ? formatSeconds(result.elapsedMs) : '—') + extra);
      console.log('');
    }
    if (result.status === 'fail' && !CONTINUE_ON_FAIL) stopped = true;
  }
  const okCount = results.filter((item) => item.status === 'ok').length;
  const failCount = results.filter((item) => item.status === 'fail').length;
  const skipCount = results.filter((item) => item.status === 'skip').length;
  const notRunCount = results.filter((item) => item.status === 'not-run').length;
  const ok = failCount === 0 && okCount > 0;
  const summary = {
    ok,
    outDir: OUT_DIR,
    startedAt: new Date(STARTED_AT).toISOString(),
    finishedAt: new Date().toISOString(),
    dateLocal: new Date().toLocaleString('ru-RU'),
    elapsedMs: Date.now() - STARTED_AT,
    withModel: WITH_MODEL,
    only: ONLY,
    skip: SKIP,
    continueOnFail: CONTINUE_ON_FAIL,
    electronPath: ELECTRON,
    electronVersion: electronVersion(),
    counts: { ok: okCount, fail: failCount, skip: skipCount, notRun: notRunCount, ran: results.length - skipCount - notRunCount },
    checks: results.map((item) => ({
      id: item.id,
      title: item.title,
      mode: item.mode,
      status: item.status,
      counts: item.counts || null,
      elapsedMs: item.elapsedMs,
      dir: item.dir,
      reason: item.reason || '',
    })),
  };
  try {
    fs.writeFileSync(path.join(OUT_DIR, 'full-qa.json'), JSON.stringify(summary, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'full-qa.md'), buildMarkdown(Object.assign({}, summary, { checks: results })), 'utf8');
  } catch (err) {
    console.error('full-qa: отчёт не записан: ' + String(err && err.message ? err.message : err));
  }
  if (JSON_MODE) {
    console.log(JSON.stringify(summary));
  } else {
    console.log('Итог: ' + (ok ? 'OK' : 'FAIL')
      + ' — зелёных ' + String(okCount) + ', сбоев ' + String(failCount)
      + ', пропусков ' + String(skipCount) + (notRunCount ? ', не запускалось ' + String(notRunCount) : '')
      + '; всего ' + formatSeconds(summary.elapsedMs));
    console.log('Отчёт: ' + path.join(OUT_DIR, 'full-qa.md'));
  }
  return ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('full-qa: ' + String(err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
