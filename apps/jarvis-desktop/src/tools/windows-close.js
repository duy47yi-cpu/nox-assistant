'use strict';

// windows_close_all: закрыть окна программ вежливо, как по крестику (CloseMainWindow, WM_CLOSE).
// Процессы не убиваются: программа с несохранённым может спросить «Сохранить?» и остаться открытой.
// Не трогаем окна самого Джарвиса, процессы, от которых он запущен (терминал при npm start), и оболочку Windows.
const { runPowerShell, pollUntil } = require('./system');

const TIMEOUT_MS = 20000;
// Рабочий стол и панель задач: WM_CLOSE окну Program Manager открывает диалог выключения ПК.
const KEEP_NAMES = ['explorer', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'textinputhost', 'lockapp'];

// JARVIS_CLOSE=1 — закрыть, иначе только список. Список PID и имён приходит через env, в тексте скрипта их нет.
const SCRIPT = [
  "try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}",
  '$parent = @{}',
  'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $parent[[int]$_.ProcessId] = [int]$_.ParentProcessId }',
  '$keep = New-Object System.Collections.Generic.HashSet[int]',
  '[void]$keep.Add($PID)',
  'foreach ($k in @($env:JARVIS_KEEP_PIDS -split "," | Where-Object { $_ })) {',
  '  $cur = [int]$k',
  '  for ($i = 0; $i -lt 30 -and $cur -gt 0 -and $keep.Add($cur); $i++) { $cur = $parent[$cur] }',
  '}',
  '$names = @($env:JARVIS_KEEP_NAMES -split ",")',
  '$items = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {',
  '  -not $keep.Contains($_.Id) -and $names -notcontains $_.ProcessName -and',
  '  $_.MainWindowHandle -ne [IntPtr]::Zero -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) })',
  'if ($env:JARVIS_CLOSE -eq "1") { foreach ($p in $items) { try { [void]$p.CloseMainWindow() } catch {} } }',
  '$out = @($items | ForEach-Object { $t = [string]$_.MainWindowTitle; [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; title = $t.Substring(0, [Math]::Min(120, $t.Length)) } })',
  'ConvertTo-Json -Compress -InputObject $out',
].join('\n');

function parseList(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return items.map((w) => ({ pid: Number(w.pid), name: String(w.name || ''), title: String(w.title || '') }));
}

// keepPids — функция: PID процессов Джарвиса на момент вызова (главный, окна, помощники Electron).
function windowsCloseTools({ runner = runPowerShell, keepPids = () => [process.pid] } = {}) {
  const env = (close) => ({
    JARVIS_CLOSE: close ? '1' : '0',
    JARVIS_KEEP_PIDS: [...new Set(keepPids().map(Number).filter(Number.isInteger))].join(','),
    JARVIS_KEEP_NAMES: KEEP_NAMES.join(','),
  });
  async function list(close, signal) {
    const res = await runner(SCRIPT, env(close), { timeoutMs: TIMEOUT_MS, signal });
    if (!res.ok) return { ok: false, summary: res.summary };
    try {
      return { ok: true, windows: parseList(res.data && res.data.stdout) };
    } catch {
      return { ok: false, summary: 'не удалось разобрать список окон' };
    }
  }

  const closeAll = {
    name: 'windows_close_all',
    description: 'Закрыть все окна программ вежливо, как по крестику: программа может спросить о сохранении. Процессы не убивает, окна Джарвиса не трогает.',
    risk: 'T2',
    parameters: { type: 'object', properties: {} },
    explain: () => 'закроет окна всех программ; несохранённое программа предложит сохранить',
    async run(args, ctx = {}) {
      const res = await list(true, ctx.signal);
      if (!res.ok) return { ok: false, summary: res.summary, data: {} };
      const targets = res.windows;
      if (!targets.length) return { ok: true, summary: 'открытых окон нет', data: { targets } };
      return { ok: true, summary: `закрываю окон: ${targets.length}`, data: { targets } };
    },
    // Окно могло спросить «Сохранить?» и остаться: смотрим, у скольких процессов окно ещё открыто.
    async verify(args, result, ctx = {}) {
      const targets = (result && result.data && result.data.targets) || [];
      if (!targets.length) return { status: 'confirmed', evidence: 'закрывать было нечего' };
      const pids = new Set(targets.map((t) => t.pid));
      let left = null;
      await pollUntil(async () => {
        const res = await list(false, ctx.signal);
        if (res.ok) left = res.windows.filter((w) => pids.has(w.pid));
        return Array.isArray(left) && left.length === 0;
      }, { timeoutMs: ctx.pollTimeoutMs || 3000, stepMs: ctx.pollStepMs || 500, signal: ctx.signal });
      if (left === null) return { status: 'unknown', evidence: 'не удалось получить список окон после закрытия' };
      if (!left.length) return { status: 'confirmed', evidence: `закрыто окон: ${targets.length}` };
      const names = left.slice(0, 5).map((w) => `«${w.title}»`).join(', ');
      const closed = targets.length - left.length;
      return {
        status: 'failed',
        evidence: closed > 0
          ? `закрыто ${closed} из ${targets.length}; открыты: ${names} — возможно, ждут ответа о сохранении`
          : `ни одно окно не закрылось; открыты: ${names}`,
      };
    },
  };
  return [closeAll];
}

module.exports = { windowsCloseTools, parseList, KEEP_NAMES };
