'use strict';

// screen_brightness: яркость экрана. Два пути, по порядку:
// 1) внешний монитор: стандарт DDC/CI через dxva2.dll (его понимают большинство мониторов с HDMI/DP);
// 2) встроенный экран ноутбука: WMI (WmiMonitorBrightness).
// Если ни один путь не отвечает, инструмент честно говорит, что яркость не меняется, а не делает вид.
// Ниже MIN_PERCENT не опускаемся: экран почти гаснет и на нём ничего не разглядеть.
const { runPowerShell } = require('./system');

const MIN_PERCENT = 10;

// C#-код для dxva2: процент яркости монитора, без обращения к пользовательскому тексту.
const DDC_CSHARP = [
  'using System; using System.Collections.Generic; using System.Runtime.InteropServices;',
  'public static class JarvisDdc {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct PHYSICAL_MONITOR { public IntPtr hPhysicalMonitor; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription; }',
  '  delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);',
  '  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);',
  '  [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);',
  '  [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint count, [Out] PHYSICAL_MONITOR[] arr);',
  '  [DllImport("dxva2.dll")] static extern bool GetMonitorBrightness(IntPtr h, out uint min, out uint cur, out uint max);',
  '  [DllImport("dxva2.dll")] static extern bool SetMonitorBrightness(IntPtr h, uint value);',
  '  [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint count, [In] PHYSICAL_MONITOR[] arr);',
  '  static List<IntPtr> Monitors() { var l = new List<IntPtr>(); EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (h, dc, r, d) => { l.Add(h); return true; }, IntPtr.Zero); return l; }',
  // Проходит по физическим мониторам; на каждом вызывает action(handle) и возвращает true, если тот ответил.
  '  static int Each(Func<IntPtr, bool> action) {',
  '    int done = 0;',
  '    foreach (var hm in Monitors()) {',
  '      uint n; if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hm, out n) || n == 0) continue;',
  '      var arr = new PHYSICAL_MONITOR[n];',
  '      if (!GetPhysicalMonitorsFromHMONITOR(hm, n, arr)) continue;',
  '      try { foreach (var pm in arr) { if (action(pm.hPhysicalMonitor)) done++; } } finally { DestroyPhysicalMonitors(n, arr); }',
  '    }',
  '    return done;',
  '  }',
  // Текущая яркость первого ответившего монитора в процентах от его диапазона, или -1.
  '  public static int ReadPercent() {',
  '    int result = -1;',
  '    Each(h => { uint mn, cur, mx; if (!GetMonitorBrightness(h, out mn, out cur, out mx) || mx <= mn) return false; if (result < 0) result = (int)Math.Round((cur - mn) * 100.0 / (mx - mn)); return true; });',
  '    return result;',
  '  }',
  // Ставит процент всем мониторам, которые отвечают по DDC/CI. Возвращает число обработанных.',
  '  public static int SetPercent(int pct) {',
  '    return Each(h => { uint mn, cur, mx; if (!GetMonitorBrightness(h, out mn, out cur, out mx) || mx <= mn) return false; uint raw = (uint)Math.Round(mn + (mx - mn) * pct / 100.0); return SetMonitorBrightness(h, raw); });',
  '  }',
  '}',
].join('\n');

// Загрузка C#-кода: закрывающая кавычка here-string должна стоять в начале своей строки, поэтому строки собираем по отдельности.
const ADD_TYPE_LINES = ["if (-not ('JarvisDdc' -as [type])) { Add-Type -TypeDefinition @'", DDC_CSHARP, "'@", '}'].join('\n');

// Читает процент: сначала DDC/CI (внешний монитор), затем WMI (ноутбук). Пусто — «none».
const READ_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  ADD_TYPE_LINES,
  '$p = [JarvisDdc]::ReadPercent()',
  'if ($p -ge 0) { "$p" } else {',
  '  $b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1',
  '  if ($null -eq $b) { "none" } else { [string]$b.CurrentBrightness }',
  '}',
].join('\n');

// Ставит процент (env JARVIS_BRIGHT): DDC/CI, иначе WMI. Ответ «ok» или «none».
const SET_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  ADD_TYPE_LINES,
  '$pct = [int]$env:JARVIS_BRIGHT',
  '$n = [JarvisDdc]::SetPercent($pct)',
  'if ($n -gt 0) { "ok" } else {',
  '  $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue | Select-Object -First 1',
  '  if ($null -eq $m) { "none" } else {',
  '    Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$pct } | Out-Null',
  '    "ok"',
  '  }',
  '}',
].join('\n');

const NOT_SUPPORTED = 'яркость не меняется: ни внешний монитор (DDC/CI), ни экран ноутбука не отвечают';

// Текущая яркость в процентах или null, если ни один путь её не отдал.
function parsePercent(stdout) {
  const text = String(stdout || '').trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const value = Number(text);
  return value >= 0 && value <= 100 ? value : null;
}

function displayTools({ runner = runPowerShell } = {}) {
  async function read(signal) {
    const res = await runner(READ_SCRIPT, {}, { timeoutMs: 20000, signal });
    return res.ok ? parsePercent(res.data && res.data.stdout) : null;
  }

  const screenBrightness = {
    name: 'screen_brightness',
    description: 'Яркость экрана: внешний монитор (DDC/CI) или экран ноутбука. percent — установить от 0 до 100; change — изменить на столько процентов, например 20 или -20.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        percent: { type: 'integer', minimum: 0, maximum: 100 },
        change: { type: 'integer', minimum: -100, maximum: 100 },
      },
    },
    async run(args = {}, ctx = {}) {
      const hasPercent = args.percent !== undefined && args.percent !== null && args.percent !== '';
      const hasChange = args.change !== undefined && args.change !== null && args.change !== '';
      if (hasPercent === hasChange) return { ok: false, summary: 'укажи либо percent, либо change', data: {} };
      const before = await read(ctx.signal);
      if (before === null) return { ok: false, summary: NOT_SUPPORTED, data: {} };
      const raw = hasPercent ? Number(args.percent) : before + Number(args.change);
      if (!Number.isFinite(raw)) return { ok: false, summary: 'яркость должна быть числом', data: {} };
      const rounded = Math.round(raw);
      const target = Math.min(100, Math.max(MIN_PERCENT, rounded));
      const res = await runner(SET_SCRIPT, { JARVIS_BRIGHT: String(target) }, { timeoutMs: 20000, signal: ctx.signal });
      if (!res.ok) return { ok: false, summary: res.summary, data: {} };
      if (String((res.data && res.data.stdout) || '').trim() !== 'ok') return { ok: false, summary: NOT_SUPPORTED, data: {} };
      const note = target !== rounded ? `, меньше ${MIN_PERCENT}% не ставлю` : '';
      return { ok: true, summary: `яркость ${target}%${note}`, data: { before, percent: target } };
    },
    // Сверка чтением обратно: допуск в 2 пункта, потому что монитор округляет.
    async verify(args, result, ctx = {}) {
      const want = result && result.data && result.data.percent;
      if (!Number.isInteger(want)) return { status: 'unknown', evidence: 'цель яркости не запомнена' };
      const now = await read(ctx.signal);
      if (now === null) return { status: 'unknown', evidence: 'яркость не прочитана обратно' };
      return Math.abs(now - want) <= 2
        ? { status: 'confirmed', evidence: `яркость сейчас ${now}%` }
        : { status: 'failed', evidence: `яркость сейчас ${now}%, ждали ${want}%` };
    },
  };
  return [screenBrightness];
}

module.exports = { displayTools, parsePercent, READ_SCRIPT, SET_SCRIPT, MIN_PERCENT, DDC_CSHARP };
