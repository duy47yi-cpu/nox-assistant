// Шаги для сценариев (команд по фразе): пауза, свернуть все окна, вернуть окна.
// Сочетания клавиш отправляем через keybd_event: SendKeys не умеет нажимать клавишу Win.
const { runPowerShell, probeProcess, pollUntil } = require('./system');
const { cannotVerify } = require('../agent/effects');
const { READ_SCRIPT: CLIPBOARD_READ } = require('./clipboard');

const MAX_WAIT_MS = 10000;

// Код PowerShell собирается из констант ниже, пользовательский текст в него не попадает.
const VK = { WIN: 0x5b, SHIFT: 0x10, D: 0x44, M: 0x4d };

function comboScript(keys) {
  const down = keys.map((k) => `[Nox.Keys]::keybd_event(${k}, 0, 0, [UIntPtr]::Zero)`);
  const up = [...keys].reverse().map((k) => `[Nox.Keys]::keybd_event(${k}, 0, 2, [UIntPtr]::Zero)`);
  return [
    '$sig = \'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);\'',
    'Add-Type -MemberDefinition $sig -Name Keys -Namespace Nox',
    ...down,
    ...up,
  ].join('\n');
}

// Свернуть все окна и вернуть их через оболочку Windows (COM Shell.Application). Не переключатель, как Win+D:
// повтор не возвращает окна обратно. Текст постоянный, пользовательских данных в нём нет.
const MINIMIZE_SCRIPT = '(New-Object -ComObject Shell.Application).MinimizeAll()';
const RESTORE_SCRIPT = '(New-Object -ComObject Shell.Application).UndoMinimizeALL()';

// Пауза между шагами сценария: например, чтобы программа успела открыться.
const wait = {
  name: 'wait',
  description: `Подождать указанное число миллисекунд (до ${MAX_WAIT_MS}). Нужно между шагами сценария, если программе нужно время.`,
  risk: 'T0',
  parameters: {
    type: 'object',
    properties: {
      ms: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS },
    },
    required: ['ms'],
  },
  async run(args, ctx) {
    const ms = Number(args.ms);
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_WAIT_MS) {
      return { ok: false, summary: `пауза от 0 до ${MAX_WAIT_MS} мс`, data: {} };
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (ctx && ctx.signal) {
        ctx.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      }
    });
    return { ok: !(ctx && ctx.signal && ctx.signal.aborted), summary: `пауза ${ms} мс`, data: {} };
  },
};

// Win+D: свернуть все окна (рабочий стол).
const windowsMinimizeAll = {
  name: 'windows_minimize_all',
  description: 'Свернуть все окна (Win+D), показать рабочий стол.',
  risk: 'T1',
  parameters: { type: 'object', properties: {} },
  async run(args, ctx) {
    const res = await runPowerShell(MINIMIZE_SCRIPT, {}, { signal: ctx.signal, timeoutMs: 15000 });
    return { ...res, summary: res.ok ? 'окна свёрнуты' : res.summary };
  },
  verify: cannotVerify('состояние окон после команды не считывается'),
};

// Win+Shift+M: вернуть свёрнутые окна.
const windowsRestoreAll = {
  name: 'windows_restore_all',
  description: 'Вернуть все свёрнутые окна (Win+Shift+M).',
  risk: 'T1',
  parameters: { type: 'object', properties: {} },
  async run(args, ctx) {
    const res = await runPowerShell(RESTORE_SCRIPT, {}, { signal: ctx.signal, timeoutMs: 15000 });
    return { ...res, summary: res.ok ? 'окна возвращены' : res.summary };
  },
  verify: cannotVerify('состояние окон после команды не считывается'),
};

// Выключение монитора: WM_SYSCOMMAND с SC_MONITORPOWER, значение 2 — выключить. Монитор включается движением мыши.
const monitorOff = {
  name: 'monitor_off',
  description: 'Выключить экран (монитор). Компьютер не выключается, экран гаснет; включается движением мыши.',
  risk: 'T1',
  parameters: { type: 'object', properties: {} },
  async run(args, ctx) {
    const script = [
      '$sig = \'[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam);\'',
      'Add-Type -MemberDefinition $sig -Name Monitor -Namespace Nox',
      // PostMessage, а не SendMessage: вызов не блокирует поток, стоп остаётся отзывчивым.
      '[Nox.Monitor]::PostMessage([IntPtr]0xffff, 0x0112, [UIntPtr]0xF170, [IntPtr]2) | Out-Null',
    ].join('\n');
    const res = await runPowerShell(script, {}, { signal: ctx.signal, timeoutMs: 15000 });
    return { ...res, summary: res.ok ? 'экран выключен' : res.summary };
  },
  verify: cannotVerify('состояние монитора Windows не сообщает'),
};

// Закрыть программу по имени процесса, мягко: окно получает команду закрыться, как по крестику.
// Несохранённое сохранит сама программа или спросит; принудительного завершения нет.
const appClose = {
  name: 'app_close',
  description: 'Закрыть программу по имени процесса (например, Steam, chrome). Закрывает окна мягко, как по крестику; принудительно не убивает.',
  risk: 'T2',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
    },
    required: ['name'],
  },
  async run(args, ctx) {
    const name = String(args.name || '').trim().replace(/\.exe$/i, '');
    if (!/^[\w .()-]{1,80}$/.test(name)) return { ok: false, summary: 'некорректное имя процесса', data: {} };
    const script = [
      '$procs = Get-Process -Name $env:JARVIS_PROC -ErrorAction SilentlyContinue',
      'if (-not $procs) { Write-Output "none"; exit 0 }',
      'foreach ($p in $procs) { [void]$p.CloseMainWindow() }',
      'Write-Output "closed"',
    ].join('\n');
    const res = await runPowerShell(script, { JARVIS_PROC: name }, { signal: ctx.signal, timeoutMs: 15000 });
    if (!res.ok) return { ...res, summary: res.summary };
    const out = String((res.data && res.data.stdout) || '').trim();
    return { ok: true, summary: out === 'closed' ? `закрываю: ${name}` : `${name} не запущена`, data: { process: name } };
  },
  // Закрытие мягкое, программа может спросить о сохранении или уйти в трей: ждём, пока процесс исчезнет.
  async verify(args, result, ctx = {}) {
    const proc = result.data && result.data.process;
    if (!proc) return { status: 'unknown', evidence: 'не знаю имя процесса' };
    const probe = ctx.probeProcess || ((p) => probeProcess(p, ctx));
    let last = null;
    const gone = await pollUntil(async () => { last = await probe(proc); return last === false; }, { timeoutMs: ctx.pollTimeoutMs || 5000, signal: ctx.signal });
    if (gone) return { status: 'confirmed', evidence: `процесса ${proc} нет` };
    if (last === true) return { status: 'failed', evidence: `процесс ${proc} ещё работает: программа могла спросить о сохранении или уйти в трей` };
    return { status: 'unknown', evidence: 'не удалось опросить процессы' };
  },
};

// Произнести фразу голосом. Сам синтез подключает main.js (SpeechClient); без установленного голоса шаг не выполняется.
let speaker = null;

function setSpeaker(fn) {
  speaker = typeof fn === 'function' ? fn : null;
}

const speak = {
  name: 'speak',
  description: 'Сказать фразу вслух голосом ассистента (например, «Спокойной ночи»). Короткие фразы, до 300 символов.',
  risk: 'T0',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 300 },
    },
    required: ['text'],
  },
  async run(args, ctx = {}) {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, summary: 'пустая фраза', data: {} };
    if (!speaker) return { ok: false, summary: 'голос не подключён', data: {} };
    try {
      await speaker(text, ctx.signal);
      return { ok: true, summary: 'сказано', data: {} };
    } catch (err) {
      return { ok: false, summary: `голос: ${err.message}`, data: {} };
    }
  },
  verify: cannotVerify('синтез отработал, но услышан ли звук, узнать нельзя'),
};

// Выключение компьютера: отдельный инструмент, а не общая команда PowerShell. Задержка в секундах (0 — сразу).
// Уровень T3 — необратимо. По решению владельца (31.10.2026) в режиме «Спрашивать» не спрашивается.
const pcShutdown = {
  name: 'pc_shutdown',
  description: 'Выключить компьютер. delay_seconds — через сколько секунд (0–600, по умолчанию 0). Необратимо.',
  risk: 'T3',
  parameters: {
    type: 'object',
    properties: {
      delay_seconds: { type: 'integer', minimum: 0, maximum: 600 },
    },
  },
  async run(args, ctx) {
    const raw = args.delay_seconds === undefined ? 0 : Number(args.delay_seconds);
    if (!Number.isInteger(raw) || raw < 0 || raw > 600) {
      return { ok: false, summary: 'задержка от 0 до 600 секунд', data: {} };
    }
    const res = await runPowerShell('shutdown.exe /s /t $env:JARVIS_DELAY', { JARVIS_DELAY: String(raw) }, { signal: ctx.signal, timeoutMs: 15000 });
    return { ...res, summary: res.ok ? `выключение через ${raw} с` : res.summary };
  },
  verify: cannotVerify('система приняла команду, само выключение после него не проверить'),
};

// Чтение вслух: буфер обмена (текст, который владелец скопировал). Длинный текст режем по предложениям:
// голос говорит короткими кусками, а не одним куском на минуту. Больше READ_LIMIT символов не читаем.
const READ_CHUNK = 220;
const READ_LIMIT = 1500;

function splitForSpeech(text) {
  let rest = String(text || '').replace(/\s+/g, ' ').trim().slice(0, READ_LIMIT);
  const parts = [];
  while (rest) {
    if (rest.length <= READ_CHUNK) { parts.push(rest); break; }
    let cut = rest.lastIndexOf('. ', READ_CHUNK);
    if (cut < 80) cut = rest.lastIndexOf(' ', READ_CHUNK);
    if (cut <= 0) cut = READ_CHUNK;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  return parts.filter(Boolean);
}

// Говорит куски по очереди; остановка — через signal (кнопка «Стоп» или аварийный стоп).
async function speakChunks(parts, say, signal) {
  for (const part of parts) {
    if (signal && signal.aborted) break;
    await say(part, signal);
  }
}

const readClipboardAloud = {
  name: 'read_clipboard_aloud',
  description: `Прочитать вслух текст из буфера обмена (до ${READ_LIMIT} символов). Сначала скопируйте нужный текст; если буфер пуст, так и скажу.`,
  risk: 'T1',
  parameters: { type: 'object', properties: {} },
  async run(args, ctx = {}) {
    if (!speaker) return { ok: false, summary: 'голос не подключён', data: {} };
    const res = await runPowerShell(CLIPBOARD_READ, {}, { signal: ctx.signal, timeoutMs: 10000 });
    if (!res.ok) return { ok: false, summary: res.summary, data: {} };
    const text = String((res.data && res.data.stdout) || '').trim();
    if (!text) return { ok: false, summary: 'буфер пуст: скопируйте текст и попросите снова', data: {} };
    const parts = splitForSpeech(text);
    try {
      await speakChunks(parts, speaker, ctx.signal);
    } catch (err) {
      return { ok: false, summary: `голос: ${err.message}`, data: {} };
    }
    const truncated = text.length > READ_LIMIT;
    return {
      ok: true,
      summary: `прочитано ${Math.min(text.length, READ_LIMIT)} символов${truncated ? ', дальше не читаю' : ''}`,
      data: { chars: text.length, parts: parts.length, truncated },
    };
  },
  verify: cannotVerify('голос отработал, но услышан ли звук, узнать нельзя'),
};

const desktopTools = [wait, windowsMinimizeAll, windowsRestoreAll, monitorOff, appClose, speak, pcShutdown, readClipboardAloud];

module.exports = { desktopTools, comboScript, setSpeaker, MAX_WAIT_MS, MINIMIZE_SCRIPT, RESTORE_SCRIPT, splitForSpeech, speakChunks, READ_LIMIT, READ_CHUNK };
