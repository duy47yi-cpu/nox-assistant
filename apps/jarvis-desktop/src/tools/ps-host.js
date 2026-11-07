'use strict';

// Один живой PowerShell для скриптов рук (ui_*): новый powershell.exe стоит ~0,4 с, запрос в живой процесс — ~10 мс.
// Тот же вызов, что runPowerShell(script, env, opts): скрипт — постоянный текст из кода, значения — только через env.
// В stdin пишет только этот процесс. Запросы идут строго по одному. Сбой запуска — обычный runPowerShell.
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { runPowerShell } = require('./system');

const MAX_OUTPUT = 8000;
const IDLE_MS = 10 * 60 * 1000;

// Цикл хоста. Переменные прошлого запроса стираются, чтобы значения не протекали в следующий.
const HOST_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false',
  '$prev = @()',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  $req = ConvertFrom-Json -InputObject $line',
  '  foreach ($n in $prev) { [Environment]::SetEnvironmentVariable($n, $null) }',
  '  $prev = @()',
  '  foreach ($p in $req.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value); $prev += $p.Name }',
  "  $ok = '1'",
  "  $out = ''",
  '  try { $out = (& ([ScriptBlock]::Create([string]$req.script)) | Out-String) } catch { $ok = \'0\'; $out = [string]$_.Exception.Message }',
  '  [Console]::Out.Write($out)',
  "  [Console]::Out.WriteLine('')",
  "  [Console]::Out.WriteLine('<<' + $req.id + ':' + $ok + '>>')",
  '}',
].join('\n');

// Не-ASCII как \uXXXX: кодировка stdin консоли не UTF-8, а ConvertFrom-Json разбирает такие escape-коды.
const asciiJson = (value) => JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function createPsHost({ spawnFn = spawn, fallback = runPowerShell, idleMs = IDLE_MS } = {}) {
  let child = null;
  let buf = '';
  let pending = null; // { id, resolve }
  let chain = Promise.resolve();
  let idle = null;

  function kill() {
    const c = child;
    child = null;
    buf = '';
    if (c) try { c.kill(); } catch {}
  }

  function start() {
    const c = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(HOST_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true });
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
      if (c !== child) return;
      buf += d;
      if (!pending) return;
      const m = buf.match(new RegExp(`<<${pending.id}:([01])>>`));
      if (!m) return;
      const text = buf.slice(0, m.index).replace(/\r?\n$/, '');
      buf = '';
      const p = pending;
      pending = null;
      p.resolve({ ok: m[1] === '1', summary: m[1] === '1' ? 'готово' : 'ошибка скрипта', data: { stdout: text.slice(0, MAX_OUTPUT), stderr: '' } });
    });
    const gone = (summary) => {
      if (c !== child) return;
      child = null;
      if (pending) { const p = pending; pending = null; p.resolve({ ok: false, summary, data: {}, hostDied: true }); }
    };
    c.on('error', (err) => gone(err.message));
    c.on('close', () => gone('PowerShell закрылся'));
    if (c.stdin && c.stdin.on) c.stdin.on('error', () => {});
    child = c;
  }

  function once(script, env, { timeoutMs = 30000, signal } = {}) {
    if (signal && signal.aborted) return Promise.resolve({ ok: false, summary: 'остановлено', data: {} });
    try {
      if (!child) start();
    } catch {
      return fallback(script, env, { timeoutMs, signal });
    }
    clearTimeout(idle);
    return new Promise((resolve) => {
      const id = randomUUID().replace(/-/g, '');
      let timer = null;
      const onAbort = () => finish({ ok: false, summary: 'остановлено', data: {} }, true);
      function finish(res, restart) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (pending && pending.id === id) pending = null;
        if (restart) kill(); // зависший или прерванный скрипт: процесс заменяется новым при следующем вызове
        if (idleMs > 0) { idle = setTimeout(kill, idleMs); if (idle.unref) idle.unref(); }
        resolve(res);
      }
      pending = { id, resolve: (res) => finish(res, false) };
      timer = setTimeout(() => finish({ ok: false, summary: `таймаут ${timeoutMs} мс`, data: {} }, true), timeoutMs);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.stdin.write(`${asciiJson({ id, script, env: env || {} })}\n`);
    });
  }

  // Очередь: в одном процессе одновременно идёт один скрипт.
  function run(script, env, opts) {
    const next = chain.then(() => once(script, env, opts));
    chain = next.catch(() => {});
    return next;
  }

  return { run, close: kill };
}

module.exports = { createPsHost, HOST_SCRIPT, asciiJson };
