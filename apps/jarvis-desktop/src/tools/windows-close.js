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

// window_close_active: закрыть окно, которое сейчас сверху. JARVIS_CLOSE=0 — только проверить, что будет закрыто.
// Окно Джарвиса, оболочка Windows и диалог (не главное окно программы) не закрываются. Ответ — статус одной строкой.
const ACTIVE_SCRIPT = [
  "try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}",
  "if (-not ('Nox.JarvisFg' -as [type])) { Add-Type -Name JarvisFg -Namespace Nox -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);' }",
  '$h = [Nox.JarvisFg]::GetForegroundWindow()',
  '$fpid = [uint32]0',
  '[void][Nox.JarvisFg]::GetWindowThreadProcessId($h, [ref]$fpid)',
  '$keep = @($env:JARVIS_KEEP_PIDS -split "," | Where-Object { $_ } | ForEach-Object { [int]$_ })',
  '$names = @($env:JARVIS_KEEP_NAMES -split ",")',
  '$p = if ($h -ne [IntPtr]::Zero) { Get-Process -Id ([int]$fpid) -ErrorAction SilentlyContinue } else { $null }',
  '$status = "none"; $title = ""; $name = ""',
  'if ($null -ne $p) {',
  '  $title = [string]$p.MainWindowTitle; $name = [string]$p.ProcessName',
  '  if (($keep -contains $p.Id) -or ($names -contains $p.ProcessName) -or ($PID -eq $p.Id)) { $status = "protected" }',
  '  elseif ($p.MainWindowHandle -ne $h) { $status = "not_main" }',
  '  elseif ($env:JARVIS_CLOSE -ne "1") { $status = "would_close" }',
  '  else {',
  '    [void]$p.CloseMainWindow()',
  '    $deadline = (Get-Date).AddSeconds(3)',
  '    while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200; $p.Refresh(); if ($p.HasExited -or $p.MainWindowHandle -eq [IntPtr]::Zero) { break } }',
  '    $status = if ($p.HasExited -or $p.MainWindowHandle -eq [IntPtr]::Zero) { "closed" } else { "still_open" }',
  '  }',
  '}',
  '$title = $title.Substring(0, [Math]::Min(120, $title.Length))',
  'ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ status = $status; name = $name; title = $title })',
].join('\n');

function parseActive(stdout) {
  const text = String(stdout || '').trim();
  const parsed = text ? JSON.parse(text) : {};
  return { status: String(parsed.status || 'none'), name: String(parsed.name || ''), title: String(parsed.title || '') };
}

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
  const closeActive = {
    name: 'window_close_active',
    description: 'Закрыть окно, которое сейчас сверху: как по крестику, программа может спросить о сохранении. Окна Джарвиса и оболочки Windows не трогает.',
    risk: 'T2',
    parameters: { type: 'object', properties: {} },
    explain: () => 'закроет окно, которое сейчас сверху; несохранённое программа предложит сохранить',
    async run(args, ctx = {}) {
      const res = await runner(ACTIVE_SCRIPT, env(true), { timeoutMs: TIMEOUT_MS, signal: ctx.signal });
      if (!res.ok) return { ok: false, summary: res.summary, data: {} };
      let win;
      try { win = parseActive(res.data && res.data.stdout); } catch { return { ok: false, summary: 'не удалось прочитать активное окно', data: {} }; }
      const label = win.title ? `«${win.title}»` : 'окно';
      if (win.status === 'closed') return { ok: true, summary: `закрыто ${label}`, data: { status: win.status, title: win.title } };
      if (win.status === 'still_open') return { ok: false, summary: `${label} не закрылось: программа, возможно, ждёт ответа о сохранении`, data: { status: win.status, title: win.title } };
      if (win.status === 'protected') return { ok: false, summary: 'это окно Джарвиса или Windows, его не закрываю', data: { status: win.status } };
      if (win.status === 'not_main') return { ok: false, summary: 'сверху диалог, а не окно программы: закройте его сами', data: { status: win.status } };
      return { ok: false, summary: 'активного окна нет', data: { status: win.status } };
    },
    // Статус уже проверен самим скриптом после закрытия; здесь только сверка с ответом.
    async verify(args, result) {
      const status = result && result.data && result.data.status;
      if (status === 'closed') return { status: 'confirmed', evidence: 'окно пропало после команды закрыть' };
      if (status === 'still_open') return { status: 'failed', evidence: 'окно осталось открытым' };
      return { status: 'unknown', evidence: 'статус окна не получен' };
    },
  };
  return [closeAll, closeActive];
}

module.exports = { windowsCloseTools, parseList, parseActive, KEEP_NAMES, ACTIVE_SCRIPT };
