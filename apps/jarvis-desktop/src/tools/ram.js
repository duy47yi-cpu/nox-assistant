'use strict';

// Безопасная очистка неиспользуемой оперативной памяти (сжатие рабочих наборов процессов Windows).
// Не завершает процессы и не удаляет файлы; читает доступную память до и после, подтверждая итог в verify.
const { runPowerShell } = require('./system');

const TRIM_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NoxRamTrim {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public class MEMORYSTATUSEX {
    public uint dwLength;
    public uint dwMemoryLoad;
    public ulong ullTotalPhys;
    public ulong ullAvailPhys;
    public ulong ullTotalPageFile;
    public ulong ullAvailPageFile;
    public ulong ullTotalVirtual;
    public ulong ullAvailVirtual;
    public ulong ullAvailExtendedVirtual;
    public MEMORYSTATUSEX() {
      this.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
    }
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool EmptyWorkingSet(IntPtr hProcess);

  public static ulong[] ReadMemory() {
    MEMORYSTATUSEX mem = new MEMORYSTATUSEX();
    if (!GlobalMemoryStatusEx(mem)) return new ulong[] { 0UL, 0UL };
    return new ulong[] { mem.ullTotalPhys, mem.ullAvailPhys };
  }
}
"@ | Out-Null

$before = [NoxRamTrim]::ReadMemory()
[System.GC]::Collect()
[System.GC]::WaitForPendingFinalizers()

$trimmed = 0
foreach ($p in Get-Process) {
  if ($p.Id -eq 0 -or $p.Id -eq 4) { continue }
  try {
    $h = $p.Handle
    if ($h -ne [IntPtr]::Zero -and [NoxRamTrim]::EmptyWorkingSet($h)) {
      $trimmed++
    }
  } catch {}
}

Start-Sleep -Milliseconds 120
$after = [NoxRamTrim]::ReadMemory()

$totalMb = [int][math]::Round($after[0] / 1MB)
$beforeMb = [int][math]::Round($before[1] / 1MB)
$afterMb = [int][math]::Round($after[1] / 1MB)
$freedMb = $afterMb - $beforeMb

[PSCustomObject]@{
  totalMb = $totalMb
  availBeforeMb = $beforeMb
  availAfterMb = $afterMb
  freedMb = $freedMb
  trimmedCount = $trimmed
} | ConvertTo-Json -Compress
`.trim();

function parseRamOutput(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  const line = raw.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') return null;
    const totalMb = Number(parsed.totalMb);
    const availBeforeMb = Number(parsed.availBeforeMb);
    const availAfterMb = Number(parsed.availAfterMb);
    const trimmedCount = Number(parsed.trimmedCount) || 0;
    if (!Number.isFinite(availAfterMb) || !Number.isFinite(availBeforeMb)) return null;
    return {
      totalMb: Number.isFinite(totalMb) ? totalMb : 0,
      availBeforeMb,
      availAfterMb,
      freedMb: availAfterMb - availBeforeMb,
      trimmedCount,
    };
  } catch {
    return null;
  }
}

function ramTools({ runner = runPowerShell } = {}) {
  const ramTrim = {
    name: 'ram_trim',
    description: 'Безопасно очистить неиспользуемую оперативную память (сжатие рабочих наборов процессов Windows без закрытия программ). Возвращает объём памяти до и после.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async run(args, ctx = {}) {
      if (process.platform !== 'win32' && runner === runPowerShell) {
        return { ok: false, summary: 'очистка оперативной памяти доступна только на Windows', data: {} };
      }
      const res = await runner(TRIM_SCRIPT, {}, { signal: ctx.signal, timeoutMs: 25000 });
      if (!res || !res.ok) {
        return {
          ok: false,
          summary: (res && res.summary) || 'не удалось выполнить очистку памяти',
          data: {},
        };
      }
      const stats = parseRamOutput(res.data && res.data.stdout);
      if (!stats) {
        return { ok: false, summary: 'не удалось прочитать объём свободной памяти после очистки', data: {} };
      }
      const freedText = stats.freedMb > 0
        ? `освобождено ${stats.freedMb} МБ, `
        : '';
      const summary = `Оперативная память очищена (${freedText}свободно ${stats.availAfterMb} из ${stats.totalMb} МБ; обработано процессов: ${stats.trimmedCount})`;
      return { ok: true, summary, data: stats };
    },
    async verify(args, result) {
      if (!result || !result.ok) {
        return { status: 'failed', evidence: (result && result.summary) || 'очистка не выполнена' };
      }
      const d = result.data || {};
      if (!Number.isFinite(d.availAfterMb) || d.totalMb <= 0) {
        return { status: 'unknown', evidence: 'показатели памяти после очистки не получены' };
      }
      return {
        status: 'confirmed',
        evidence: `свободно ${d.availAfterMb} из ${d.totalMb} МБ (до: ${d.availBeforeMb} МБ, процессов: ${d.trimmedCount || 0})`,
      };
    },
  };

  return [ramTrim];
}

module.exports = { ramTools, parseRamOutput, TRIM_SCRIPT };
