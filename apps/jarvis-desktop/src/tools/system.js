// Инструменты первой очереди: громкость, запуск приложения, PowerShell, открытие URL.
// Аргументы в PowerShell передаются через переменные окружения, а не склейкой строк.
const childProcess = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { cannotVerify } = require('../agent/effects');

const MAX_OUTPUT = 8000;
// Windows ограничивает командную строку ~32 767 символами. Длинный скрипт (нажатие с большим текстом)
// передаём временным файлом, иначе spawn падает с ENAMETOOLONG ещё до запуска PowerShell.
const MAX_ENCODED = 30000;

// Браузер для открытия ссылок. null — использовать проводник Windows.
let browserExe = null;

function setBrowserExe(file) {
  browserExe = file || null;
}

// Первый найденный браузер из списка. exists — функция проверки файла (для тестов).
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\LibreWolf\\librewolf.exe',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowserExe(exists = require('fs').existsSync) {
  return BROWSER_CANDIDATES.find((p) => exists(p)) || null;
}

// Запуск PowerShell-скрипта без склейки пользовательского текста в код.
// env передаёт значения, script — постоянный текст. Длинный скрипт идёт файлом: командная строка Windows короче.
// maxOutput — предел прочитанного вывода: сцена окна с сотнями элементов не влезает в общий предел.
function runPowerShell(script, env, { timeoutMs = 30000, signal, cwd, maxOutput = MAX_OUTPUT } = {}) {
  return new Promise((resolve) => {
    // Уже остановлено: слушатель abort не сработал бы, и скрипт ушёл бы выполняться.
    if (signal && signal.aborted) {
      resolve({ ok: false, summary: 'остановлено', data: {} });
      return;
    }
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let scriptFile = null;
    let args;
    try {
      if (encoded.length <= MAX_ENCODED) {
        args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
      } else {
        scriptFile = path.join(os.tmpdir(), `nox-ps-${process.pid}-${crypto.randomUUID()}.ps1`);
        // BOM: PowerShell 5.1 без него читает файл как ANSI и может испортить русский текст.
        fs.writeFileSync(scriptFile, `\uFEFF${script}`, 'utf8');
        args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile];
      }
    } catch (err) {
      resolve({ ok: false, summary: `не удалось подготовить скрипт: ${err.message}`, data: {} });
      return;
    }
    const cleanup = () => {
      if (!scriptFile) return;
      try { fs.unlinkSync(scriptFile); } catch { /* файл уже удалён */ }
      scriptFile = null;
    };
    let child;
    try {
      child = childProcess.spawn('powershell.exe', args, { env: { ...process.env, ...env }, windowsHide: true, ...(cwd ? { cwd } : {}) });
    } catch (err) {
      cleanup();
      resolve({ ok: false, summary: err.message, data: {} });
      return;
    }
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, summary: `таймаут ${timeoutMs} мс`, data: { stdout, stderr } });
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => child.kill(), { once: true });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ ok: false, summary: err.message, data: {} }));
    child.on('close', (code) => {
      const out = stdout.slice(0, maxOutput);
      const err = stderr.slice(0, maxOutput);
      finish({
        ok: code === 0,
        summary: code === 0 ? 'готово' : `код выхода ${code}`,
        data: { stdout: out, stderr: err },
      });
    });
  });
}

// Проверка результата запуска: опрос до срока. Срок истёк — это не провал (лаунчеры, Store-программы
// и браузер с уже открытым окном не всегда дают признак сразу), поэтому вызывающий берёт «не проверено».
async function pollUntil(check, { timeoutMs, stepMs = 250, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return false;
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

// Есть ли процесс с таким именем (без .exe). Имя передаётся через переменную окружения.
// null — опрос не удался: это не то же, что «процесса нет».
async function probeProcess(proc, { signal, runner = runPowerShell } = {}) {
  const res = await runner(
    '(@(Get-Process -Name $env:JARVIS_PROC -ErrorAction SilentlyContinue)).Count -gt 0',
    { JARVIS_PROC: proc },
    { signal, timeoutMs: 5000 }
  );
  if (!res.ok) return null;
  return String(res.data.stdout || '').trim() === 'True';
}

// Есть ли у процесса видимое главное окно. Процесс без окна (фон, лаунчер) — false. null — опрос не удался.
async function probeProcessWindow(proc, { signal, runner = runPowerShell } = {}) {
  const res = await runner(
    '(@(Get-Process -Name $env:JARVIS_PROC -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })).Count -gt 0',
    { JARVIS_PROC: proc },
    { signal, timeoutMs: 5000 }
  );
  if (!res.ok) return null;
  return String(res.data.stdout || '').trim() === 'True';
}

// Окно браузера, у которого в заголовке название сайта («YouTube - Google Chrome»). Адреса в заголовке обычно нет,
// поэтому ищем по названию сайта. procs — процессы браузера через запятую.
const BROWSER_PROCS = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'librewolf', 'vivaldi'];
async function probeBrowserTitle(brand, { signal, browserExe: targetBrowser, runner = runPowerShell } = {}) {
  const procs = targetBrowser ? [String(targetBrowser).replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')] : BROWSER_PROCS;
  const res = await runner(
    '(@(Get-Process -Name ($env:JARVIS_PROCS -split \',\') -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like ("*" + $env:JARVIS_BRAND + "*") })).Count -gt 0',
    { JARVIS_PROCS: procs.join(','), JARVIS_BRAND: brand },
    { signal, timeoutMs: 5000 }
  );
  return res.ok && String(res.data.stdout || '').trim() === 'True';
}

// Название сайта для поиска в заголовке: youtube.com → youtube, music.yandex.ru → yandex.
function brandOf(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || '');
}

// Открыто ли окно Проводника именно с этой папкой (по пути, не по заголовку). Путь — через переменную окружения.
async function probeFolderWindow(dir, { signal, runner = runPowerShell } = {}) {
  const res = await runner(
    '$d = $env:JARVIS_DIR.TrimEnd([char]92); @((New-Object -ComObject Shell.Application).Windows() | Where-Object { try { $_.Document.Folder.Self.Path.TrimEnd([char]92) -eq $d } catch { $false } }).Count -gt 0',
    { JARVIS_DIR: dir },
    { signal, timeoutMs: 5000 }
  );
  return res.ok && String(res.data.stdout || '').trim() === 'True';
}

// Список установленных программ: по имени находит exe. Задаётся из main.js после согласия владельца.
let appResolver = null;

function setAppResolver(fn) {
  appResolver = typeof fn === 'function' ? fn : null;
}

// Вызывается после успешного запуска программы: для учёта, что владелец использует.
let appLaunchHook = null;

function setAppLaunchHook(fn) {
  appLaunchHook = typeof fn === 'function' ? fn : null;
}

// Запуск и ожидание нового видимого окна (до 6 с). Окна самого Джарвиса не считаются. Значения — только через env.
// Кроме заголовка окно отдаёт свой процесс (имя, путь, PID) и PID запущенного процесса: проверка сверяет их,
// а не считает подтверждением любое новое окно (уведомление или чужое окно в эти секунды).
const OPEN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false',
  "Add-Type -Namespace JarvisOpen -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc f, IntPtr l); public delegate bool EnumProc(IntPtr h, IntPtr l); [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h); [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();'",
  '$self = 0; [void][int]::TryParse([string]$env:JARVIS_SELF_PID, [ref]$self)',
  'function Tops {',
  '  $script:T = @{}',
  '  $cb = [JarvisOpen.W+EnumProc]{ param($h, $l)',
  '    if ([JarvisOpen.W]::IsWindowVisible($h)) {',
  '      $p = [uint32]0; [void][JarvisOpen.W]::GetWindowThreadProcessId($h, [ref]$p)',
  '      $b = New-Object System.Text.StringBuilder 256; [void][JarvisOpen.W]::GetWindowText($h, $b, 256)',
  '      if ($b.Length -gt 0 -and [int]$p -ne $self) { $script:T[[int64]$h] = $b.ToString() }',
  '    }',
  '    return $true',
  '  }',
  '  [void][JarvisOpen.W]::EnumWindows($cb, [IntPtr]::Zero)',
  '  return $script:T',
  '}',
  '$before = Tops',
  '$fg0 = [int64][JarvisOpen.W]::GetForegroundWindow()',
  '$sp = Start-Process -FilePath $env:JARVIS_APP -PassThru',
  '$startedPid = 0',
  'if ($sp) { try { $startedPid = [int]$sp.Id } catch { $startedPid = 0 } }',
  '$deadline = (Get-Date).AddMilliseconds(6000)',
  '$new = @()',
  // Программы Магазина (Калькулятор, Параметры) показывают уже существующее скрытое окно: тогда признак — новое активное окно.
  'do { Start-Sleep -Milliseconds 200; $now = Tops; $new = @($now.Keys | Where-Object { -not $before.ContainsKey($_) }); $fg = [int64][JarvisOpen.W]::GetForegroundWindow(); if ($new.Count -eq 0 -and $fg -ne $fg0 -and $now.ContainsKey($fg)) { $new = @($fg) } } while ($new.Count -eq 0 -and (Get-Date) -lt $deadline)',
  "$t = ''; $wpid = 0; $wname = ''; $wpath = ''",
  'if ($new.Count -gt 0) {',
  '  $h = [IntPtr][int64]$new[0]',
  '  $t = [string]$now[$new[0]]',
  '  $wp = [uint32]0; [void][JarvisOpen.W]::GetWindowThreadProcessId($h, [ref]$wp); $wpid = [int]$wp',
  '  $gp = Get-Process -Id $wpid -ErrorAction SilentlyContinue',
  '  if ($gp) { $wname = [string]$gp.ProcessName; try { $wpath = [string]$gp.Path } catch { $wpath = "" } }',
  '}',
  // pid, process и path — чьё окно нашли; startedPid — кого запустили. По ним проверка решает, своё ли окно.
  'ConvertTo-Json -Compress -InputObject @{ title = $t; pid = $wpid; process = $wname; path = $wpath; startedPid = $startedPid }',
].join('\n');

// Разбор ответа скрипта: последняя непустая строка — JSON. Мусор в выводе не должен ломать запуск.
function parseOpenOutput(stdout) {
  const text = String(stdout || '').trim();
  const line = text.split(/\r?\n/).filter((part) => part.trim()).pop() || '';
  if (!line) return {};
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}


// Точная громкость через Windows Core Audio: интерфейс IAudioEndpointVolume читает и ставит уровень
// напрямую, без эмуляции клавиш. C# COM-interop компилируется внутри PowerShell (Add-Type).
// В C# нет одинарных кавычек — исходник вставляется в here-string PowerShell без экранирования.
const CORE_AUDIO_TYPE = String.raw`
using System;
using System.Runtime.InteropServices;

namespace NoxVolume
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    // Порядок методов в интерфейсах — это порядок слотов vtable: менять нельзя, лишние слоты обязательны.
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr store);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr notify);
        int UnregisterControlChangeNotify(IntPtr notify);
        int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid eventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid eventContext);
        int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
        int GetChannelVolumeLevel(uint channel, out float levelDb);
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        int GetVolumeStepInfo(out uint step, out uint stepCount);
        int VolumeStepUp(ref Guid eventContext);
        int VolumeStepDown(ref Guid eventContext);
        int QueryHardwareSupport(out uint mask);
        int GetVolumeRange(out float min, out float max, out float increment);
    }

    public static class Core
    {
        // Устройство воспроизведения по умолчанию (eRender = 0, eMultimedia = 1), затем его громкость.
        private static IAudioEndpointVolume Endpoint()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice device;
            int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out device);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object obj;
            hr = device.Activate(ref iid, 23, IntPtr.Zero, out obj);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            return (IAudioEndpointVolume)obj;
        }

        public static int GetPercent()
        {
            IAudioEndpointVolume volume = Endpoint();
            float scalar;
            int hr = volume.GetMasterVolumeLevelScalar(out scalar);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            int percent = (int)Math.Round(scalar * 100.0);
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;
            return percent;
        }

        public static bool GetMute()
        {
            IAudioEndpointVolume volume = Endpoint();
            bool mute;
            int hr = volume.GetMute(out mute);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            return mute;
        }

        public static void SetPercent(int percent)
        {
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;
            IAudioEndpointVolume volume = Endpoint();
            Guid context = Guid.Empty;
            int hr = volume.SetMasterVolumeLevelScalar(percent / 100f, ref context);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        }
    }
}
`;

// Общая обёртка скрипта: типы C# + тело. Пользовательские значения сюда не склеиваются.
function coreAudioScript(body) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false',
    "$src = @'",
    CORE_AUDIO_TYPE,
    "'@",
    ...body,
  ].join('\n');
}

// Чтение: процент и признак mute. Ответ — одна строка JSON, чтобы разбор не зависел от вывода Add-Type.
function coreAudioGetScript() {
  return coreAudioScript([
    'try {',
    '  Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop',
    '  $percent = [NoxVolume.Core]::GetPercent()',
    '  $mute = [NoxVolume.Core]::GetMute()',
    "  ConvertTo-Json -Compress -InputObject @{ ok = $true; mode = 'coreaudio'; percent = [int]$percent; mute = [bool]$mute }",
    '} catch {',
    "  ConvertTo-Json -Compress -InputObject @{ ok = $false; mode = 'unavailable'; error = [string]$_.Exception.Message }",
    '}',
  ]);
}

// Установка: сперва типы и чтение «до». Недоступность Core Audio — повод для старого пути SendKeys,
// а не для тихой ошибки. Процент подставляется числом: run уже проверил, что это целое 0–100.
function coreAudioSetScript(percent) {
  const ups = Math.round(percent / 2);
  return coreAudioScript([
    '$target = ' + percent,
    '$available = $false',
    "$errorText = ''",
    'try {',
    '  Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop',
    '  $before = [NoxVolume.Core]::GetPercent()',
    '  $available = $true',
    '} catch {',
    '  $errorText = [string]$_.Exception.Message',
    '}',
    'if ($available) {',
    '  try {',
    '    [NoxVolume.Core]::SetPercent($target)',
    '    Start-Sleep -Milliseconds 120',
    '    $after = [NoxVolume.Core]::GetPercent()',
    '    $mute = [NoxVolume.Core]::GetMute()',
    "    ConvertTo-Json -Compress -InputObject @{ ok = $true; mode = 'coreaudio'; percent = [int]$target; before = [int]$before; after = [int]$after; mute = [bool]$mute }",
    '  } catch {',
    "    ConvertTo-Json -Compress -InputObject @{ ok = $false; mode = 'coreaudio'; percent = [int]$target; error = [string]$_.Exception.Message }",
    '  }',
    '} else {',
    '  # Core Audio недоступен: старый путь нажатиями клавиш, шаг 2%.',
    '  $w = New-Object -ComObject WScript.Shell',
    '  for ($i = 0; $i -lt 50; $i++) { $w.SendKeys([char]174) }',
    '  for ($i = 0; $i -lt ' + ups + '; $i++) { $w.SendKeys([char]175) }',
    "  ConvertTo-Json -Compress -InputObject @{ ok = $true; mode = 'sendkeys'; percent = [int]$target; error = $errorText }",
    '}',
  ]);
}

// Разбор ответа скрипта громкости: последняя непустая строка — JSON. Мусор и пустой вывод — null.
function parseCoreAudio(stdout) {
  const text = String(stdout || '').trim();
  const line = text.split(/\r?\n/).filter((part) => part.trim()).pop() || '';
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
// Имя процесса без пути и .exe, в нижнем регистре.
function processNameOf(value) {
  return String(value || '').trim().toLowerCase().replace(/\.exe$/i, '');
}

// Окно принадлежит запущенной программе, если совпало имя процесса, путь exe или PID запуска.
// Раньше подтверждением считалось любое новое окно — уведомление в эти секунды давало ложное «запущено».
function windowMatches(window, expected = {}) {
  if (!window || typeof window !== 'object' || !window.title) return false;
  const gotName = processNameOf(window.process);
  const wantName = processNameOf(expected.process);
  if (gotName && wantName && gotName === wantName) return true;
  const gotPath = String(window.path || '').trim().toLowerCase();
  const wantPath = String(expected.path || '').trim().toLowerCase();
  if (gotPath && wantPath && gotPath === wantPath) return true;
  const gotPid = Number(window.pid);
  const startedPid = Number(window.startedPid);
  return Number.isInteger(gotPid) && gotPid > 0 && gotPid === startedPid;
}

function resolveAppTarget(getAppResolver, name) {
  if (typeof getAppResolver !== 'function') return name;
  const resolved = getAppResolver(name);
  const pathOrNull = typeof resolved === 'function' ? resolved(name) : resolved;
  return pathOrNull || name;
}

// Фабрика инструментов первой очереди: в тестах позволяет подменить runner, spawn и настройки без запуска реальных программ.
function systemToolsFactory({
  runner = runPowerShell,
  spawn = childProcess.spawn,
  getAppResolver = () => appResolver,
  getBrowserExe = () => browserExe,
  getAppLaunchHook = () => appLaunchHook,
  fsImpl = fs,
} = {}) {
  // Громкость: точная установка через Windows Core Audio и проверка чтением обратно (verify).
  // Если Core Audio недоступен — старый путь SendKeys (шаг 2%); тогда verify честно «не проверено».
  const volumeSet = {
    name: 'volume_set',
    description: 'Установить громкость системы точно в процентах (0–100) через Windows Core Audio, с чтением обратно. Если Core Audio недоступен — приближённо, шагом 2%.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        percent: { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['percent'],
    },
    async run(args, ctx = {}) {
      const percent = Number(args.percent);
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
        return { ok: false, summary: 'громкость от 0 до 100', data: {} };
      }
      const res = await runner(coreAudioSetScript(percent), {}, { signal: ctx.signal, timeoutMs: 20000 });
      const got = parseCoreAudio(res.data && res.data.stdout);
      if (got && got.mode === 'coreaudio' && got.ok === false) {
        // Core Audio есть, но установка не удалась: подменять ошибку нажатиями нельзя.
        return {
          ok: false,
          summary: `не удалось установить громкость: ${String(got.error || 'ошибка Core Audio')}`,
          data: { mode: 'coreaudio', percent, error: String(got.error || '') },
        };
      }
      if (got && got.mode === 'coreaudio') {
        const before = Math.round(Number(got.before));
        const after = Math.round(Number(got.after));
        const mute = Boolean(got.mute);
        return {
          ...res,
          summary: `громкость ${Number.isFinite(after) ? after : percent}%${mute ? ', звук выключен' : ''}`,
          data: {
            ...res.data,
            mode: 'coreaudio',
            percent,
            before: Number.isFinite(before) ? before : null,
            after: Number.isFinite(after) ? after : null,
            mute,
          },
        };
      }
      // Core Audio недоступен: скрипт уже нажал клавиши. Это успех «примерно», точность не проверена.
      return {
        ...res,
        summary: res.ok ? `громкость ~${percent}%` : res.summary,
        data: {
          ...res.data,
          mode: got && got.mode === 'sendkeys' ? 'sendkeys' : 'unknown',
          percent,
          ...(got && got.error ? { error: String(got.error) } : {}),
        },
      };
    },
    async verify(args, result, ctx = {}) {
      const data = (result && result.data) || {};
      if (data.mode !== 'coreaudio') {
        return { status: 'unknown', evidence: 'Core Audio недоступен, громкость выставлена нажатиями клавиш: точный уровень не считывался' };
      }
      const target = Number(data.percent);
      if (!Number.isFinite(target)) return { status: 'unknown', evidence: 'в результате нет целевого процента' };
      const res = await runner(coreAudioGetScript(), {}, { signal: ctx.signal, timeoutMs: 15000 });
      const got = parseCoreAudio(res.data && res.data.stdout);
      if (!got || got.mode !== 'coreaudio' || !Number.isFinite(Number(got.percent))) {
        const why = String((got && got.error) || res.summary || 'нет ответа');
        return { status: 'unknown', evidence: `не удалось прочитать громкость обратно через Core Audio (${why})` };
      }
      const now = Math.round(Number(got.percent));
      if (Math.abs(now - target) <= 2) {
        return { status: 'confirmed', evidence: `прочитал ${now}% (цель ${target}%, допуск ±2%)` };
      }
      return { status: 'failed', evidence: `прочитал ${now}%, а цель ${target}% (допуск ±2%)` };
    },
  };

  // Точное чтение громкости: процент и признак выключенного звука. Без Core Audio — честный отказ.
  const volumeGet = {
    name: 'volume_get',
    description: 'Узнать текущую громкость системы точно: процент 0–100 и выключен ли звук. Чтение через Windows Core Audio.',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx = {}) {
      const res = await runner(coreAudioGetScript(), {}, { signal: ctx.signal, timeoutMs: 15000 });
      const got = parseCoreAudio(res.data && res.data.stdout);
      if (!got || got.mode !== 'coreaudio' || !Number.isFinite(Number(got.percent))) {
        const why = String((got && got.error) || res.summary || 'нет ответа');
        return {
          ok: false,
          summary: `не удалось узнать громкость: Windows Core Audio недоступен (${why})`,
          data: { mode: 'unavailable' },
        };
      }
      const percent = Math.max(0, Math.min(100, Math.round(Number(got.percent))));
      const mute = Boolean(got.mute);
      return {
        ok: true,
        summary: `громкость ${percent}%${mute ? ', звук выключен' : ''}`,
        data: { mode: 'coreaudio', percent, mute },
      };
    },
  };
  // Запуск программы по имени или пути. Имя передаётся через переменную окружения.
  const appOpen = {
    name: 'app_open',
    description: 'Запустить программу по имени (например, spotify) или по полному пути к exe. Имена из списка установленных находятся сами. Полный путь к папке открывает её в Проводнике.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 260 },
      },
      required: ['name'],
    },
    async run(args, ctx = {}) {
      const name = String(args.name || '').trim();
      if (!name) return { ok: false, summary: 'пустое имя', data: {} };
      const target = resolveAppTarget(getAppResolver, name);
      const res = await runner(OPEN_SCRIPT, { JARVIS_APP: target, JARVIS_SELF_PID: String(process.pid) }, { signal: ctx.signal, timeoutMs: 15000 });
      const open = parseOpenOutput(res.data && res.data.stdout);
      const newWindow = typeof open.title === 'string' ? open.title : '';
      // Папка открывается в Проводнике: проверяем окно с её именем в заголовке, а не процесс.
      let folder = null;
      try { if (path.isAbsolute(target) && fsImpl.statSync(target).isDirectory()) folder = path.basename(target); } catch {}
      const launchHook = typeof getAppLaunchHook === 'function' ? getAppLaunchHook() : null;
      if (res.ok && launchHook && !folder) launchHook(name);
      // Имя процесса для проверки: путь без папки и без .exe. Для имени без пути — само имя.
      const proc = path.basename(target).replace(/\.exe$/i, '');
      let targetPath = '';
      try { if (path.isAbsolute(target) && fsImpl.statSync(target).isFile()) targetPath = target; } catch {}
      // Окно запоминаем вместе с его процессом: проверка сверит его с запущенным, а не поверит любому окну.
      const window = newWindow
        ? { title: newWindow, process: String(open.process || ''), path: String(open.path || ''), pid: open.pid, startedPid: open.startedPid }
        : null;
      const own = window ? windowMatches(window, { process: proc, path: targetPath }) : false;
      let shown = '';
      if (window) {
        shown = own
          ? `, окно «${newWindow.slice(0, 80)}»`
          : `, но новое окно «${newWindow.slice(0, 80)}» не от этой программы`;
      }
      return {
        ...res,
        summary: res.ok
          ? `${folder ? 'открыта папка' : 'запущено'}: ${name}${shown}`
          : res.summary,
        data: {
          ...res.data,
          process: proc,
          ...(targetPath ? { targetPath } : {}),
          ...(window ? { newWindow, window } : {}),
          ...(folder ? { folder, target } : {}),
        },
      };
    },
    // Проверка: новое окно принадлежит запущенному процессу (имя процесса, путь exe или PID), либо у процесса
    // есть своё видимое окно. Чужое окно и уведомление подтверждением не считаются: тогда unknown с честным текстом.
    async verify(args, result, ctx = {}) {
      const folder = result.data && result.data.folder;
      if (folder) {
        const probe = ctx.probeFolderWindow || ((p) => probeFolderWindow(p, { signal: ctx.signal, runner }));
        const seen = await pollUntil(() => probe(result.data.target), { timeoutMs: ctx.pollTimeoutMs || 4000, signal: ctx.signal });
        return seen ? { status: 'confirmed', evidence: `Проводник показывает папку «${folder}»` } : { status: 'unknown', evidence: `окно Проводника с папкой «${folder}» не найдено за срок` };
      }
      const proc = result.data && result.data.process;
      const expectedPath = result.data && result.data.targetPath;
      const window = result.data && result.data.window;
      const windowTitle = window && window.title ? String(window.title).slice(0, 80) : '';
      if (window && windowTitle) {
        if (windowMatches(window, { process: proc, path: expectedPath })) {
          const owner = window.process ? `процессу «${window.process}»` : 'запущенному процессу';
          return { status: 'confirmed', evidence: `новое окно «${windowTitle}» принадлежит ${owner}` };
        }
        // Окно чужое: процесс мог открыться без окна (лаунчер, фон) или окно ещё открывается — тогда short-добор.
        const probe = ctx.probeProcessWindow || ((p) => probeProcessWindow(p, { signal: ctx.signal, runner }));
        const seen = proc ? await pollUntil(() => probe(proc), { timeoutMs: ctx.pollTimeoutMs || 2000, signal: ctx.signal }) : false;
        if (seen) return { status: 'confirmed', evidence: `у процесса ${proc} есть видимое окно` };
        const who = window.process ? `процессу «${window.process}»` : 'другому процессу';
        return { status: 'unknown', evidence: `новое окно «${windowTitle}» принадлежит ${who}, а не запущенной программе${proc ? ` ${proc}` : ''}: запуск не подтверждён` };
      }
      if (!proc) return { status: 'unknown', evidence: 'не знаю имя процесса' };
      const probe = ctx.probeProcessWindow || ((p) => probeProcessWindow(p, { signal: ctx.signal, runner }));
      // Новое окно скрипт уже ждал до 6 с: здесь короткий добор для программ, что открылись в уже открытом окне.
      const seen = await pollUntil(() => probe(proc), { timeoutMs: ctx.pollTimeoutMs || 2000, signal: ctx.signal });
      if (seen) return { status: 'confirmed', evidence: `у процесса ${proc} есть видимое окно` };
      return { status: 'unknown', evidence: `у процесса ${proc} видимое окно не появилось за срок (лаунчер, фоновый запуск или окно ещё открывается)` };
    },
  };

  // Произвольная команда PowerShell. Риск T2: внешнее действие, в «Авто» спрашивает.
  const shellRun = {
    name: 'shell_run',
    description: 'Команда PowerShell (медленно, таймаут 30 с). Только когда нет готового инструмента; не для ссылок и интернета (url_open, web_*).',
    risk: 'T2',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['command'],
    },
    async run(args, ctx = {}) {
      const command = String(args.command || '');
      if (!command.trim()) return { ok: false, summary: 'пустая команда', data: {} };
      // Ссылки и интернет — только через url_open и web_*: PowerShell тут медленный и ненадёжный.
      if (/https?:\/\/|Invoke-(Web|Rest)Request|explorer(\.exe)?\s+https?/i.test(command)) {
        return { ok: false, summary: 'для ссылок и интернета используй url_open, web_search или web_fetch', data: {} };
      }
      const res = await runner(command, {}, { signal: ctx.signal, timeoutMs: 30000, cwd: ctx.workspace });
      return { ...res, summary: res.ok ? 'команда выполнена' : res.summary };
    },
    verify: cannotVerify('известен только код выхода, эффект команды не проверялся'),
  };

  // Открыть http или https адрес в браузере по умолчанию.
  const urlOpen = {
    name: 'url_open',
    description: 'Открыть ссылку или сайт (http/https) в браузере по умолчанию. Для любых ссылок — этот инструмент.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 2048 },
      },
      required: ['url'],
    },
    async run(args, ctx = {}) {
      let url;
      try {
        url = new URL(String(args.url || ''));
      } catch {
        return { ok: false, summary: 'некорректный адрес', data: {} };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, summary: 'разрешены только http и https', data: {} };
      }
      if (url.username || url.password) {
        return { ok: false, summary: 'адреса с учётными данными не разрешены', data: {} };
      }
      // explorer.exe открывает адрес в браузере по умолчанию. Его код выхода не означает ошибку,
      // поэтому смотрим только на то, запустился ли процесс. Без PowerShell: это быстро.
      return new Promise((resolve) => {
        const activeBrowser = typeof getBrowserExe === 'function' ? (getBrowserExe() || null) : null;
        let child;
        try {
          // Браузер запускаем напрямую: обработчик https в Windows у некоторых систем не настроен.
          // Firefox и LibreWolf без флага открывают ссылку в новом окне; -new-tab открывает вкладку в текущем.
          const firefoxLike = Boolean(activeBrowser) && /(firefox|librewolf)\.exe$/i.test(activeBrowser);
          const spawnArgs = firefoxLike ? ['-new-tab', url.href] : [url.href];
          child = spawn(activeBrowser || 'explorer.exe', spawnArgs, { windowsHide: true, detached: true, stdio: 'ignore' });
        } catch (err) {
          resolve({ ok: false, summary: err.message, data: {} });
          return;
        }
        child.once('spawn', () => {
          if (typeof child.unref === 'function') child.unref();
          resolve({ ok: true, summary: `открыто: ${url.host}`, data: { host: url.host } });
        });
        child.once('error', (err) => resolve({ ok: false, summary: err.message, data: {} }));
      });
    },
    // Проверка: окно браузера со страницей сайта. Заголовок называет сайт, а не адрес, поэтому ищем название сайта.
    // Без совпадения — unknown с пояснением, не failed: страница могла ещё грузиться.
    async verify(args, result, ctx = {}) {
      const host = result.data && result.data.host;
      if (!host) return { status: 'unknown', evidence: 'нет адреса для проверки' };
      const brand = brandOf(host);
      if (brand.length < 3) return { status: 'unknown', evidence: `страница ${host} открыта; по заголовку окна проверить нельзя: название сайта слишком короткое` };
      const activeBrowser = typeof getBrowserExe === 'function' ? (getBrowserExe() || null) : null;
      const probe = ctx.probeWindowTitle || ((b) => probeBrowserTitle(b, { signal: ctx.signal, browserExe: activeBrowser, runner }));
      const seen = await pollUntil(() => probe(brand), { timeoutMs: ctx.pollTimeoutMs || 3000, signal: ctx.signal });
      if (seen) return { status: 'confirmed', evidence: `окно браузера со страницей ${host} найдено по заголовку («${brand}»)` };
      return { status: 'unknown', evidence: `браузер открыт, но в заголовках его окон нет «${brand}»: страница ещё грузится или сайт назван иначе` };
    },
  };

  return [volumeSet, volumeGet, appOpen, shellRun, urlOpen];
}

const systemTools = systemToolsFactory();

module.exports = { systemTools, systemToolsFactory, runPowerShell, probeProcess, probeProcessWindow, probeBrowserTitle, probeFolderWindow, brandOf, pollUntil, setBrowserExe, findBrowserExe, setAppResolver, setAppLaunchHook, parseOpenOutput, windowMatches, MAX_ENCODED };
