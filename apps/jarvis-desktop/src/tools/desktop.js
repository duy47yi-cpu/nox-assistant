// Шаги для сценариев (команд по фразе): пауза, свернуть все окна, вернуть окна.
// Сочетания клавиш отправляем через keybd_event: SendKeys не умеет нажимать клавишу Win.
const { runPowerShell, probeProcess, pollUntil } = require('./system');
const { cannotVerify } = require('../agent/effects');
const { READ_SCRIPT: CLIPBOARD_READ } = require('./clipboard');
const { createReader, MAX_READ } = require('../voice/reader');
const fs = require('fs');
const path = require('path');

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

// Отдельный кусок старого деления: им пользуются сценарии команд, трогать его не нужно.
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

// Выделенный текст: UIA TextPattern того элемента, где стоит курсор. Буфер обмена не трогаем —
// копирование затёрло бы то, что владелец там держит.
const SELECTION_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
  'try {',
  '  $el = [System.Windows.Automation.AutomationElement]::FocusedElement',
  '  if ($el) {',
  '    $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)',
  '    if ($tp) { $sel = $tp.GetSelection(); if ($sel -and $sel.Count -gt 0) { $t = ($sel | ForEach-Object { $_.GetText(-1) }) -join "`n"; [Console]::Out.Write($t) } }',
  '  }',
  '} catch { }',
].join('\n');

// Документ .docx — это zip с word/document.xml. Достаём XML и превращаем в текст в Node.
const DOCX_XML_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  'try {',
  '  $zip = [System.IO.Compression.ZipFile]::OpenRead($env:JARVIS_DOC)',
  '  try {',
  '    $entry = $zip.GetEntry("word/document.xml")',
  '    if ($entry) { $reader = New-Object System.IO.StreamReader($entry.Open()); [Console]::Out.Write($reader.ReadToEnd()) }',
  '  } finally { $zip.Dispose() }',
  '} catch { }',
].join('\n');

// Что читаем файлом: обычный текст и html как есть, docx — через xml. Прочее честно не читаем.
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.ini', '.cfg', '.yml', '.yaml', '.js', '.ts', '.py', '.ps1', '.sh', '.xml', '.sql']);
const HTML_EXT = new Set(['.html', '.htm']);
const DOC_EXT = new Set(['.docx']);
const FILE_BYTES_MAX = 4 * 1024 * 1024;

// Текст из html: без скриптов, стилей и разметки. Сущности — самые частые.
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

// Текст из word/document.xml: абзац — перевод строки, остальные теги прочь.
function docxXmlToText(xml) {
  return String(xml || '')
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Файл в текст: только поддерживаемые расширения, только обычный файл, не больше FILE_BYTES_MAX.
async function readDocumentText(file, { signal, runner = runPowerShell, fsImpl = fs } = {}) {
  const ext = path.extname(String(file)).toLowerCase();
  const name = path.basename(String(file));
  if (/^\.env/i.test(name)) return { ok: false, summary: 'файлы .env я не читаю' };
  if (!TEXT_EXT.has(ext) && !HTML_EXT.has(ext) && !DOC_EXT.has(ext)) {
    return { ok: false, summary: `такой файл вслух не читаю (${ext || 'без расширения'}): поддерживаю текст, html и docx` };
  }
  let stat = null;
  try {
    stat = fsImpl.statSync(file);
  } catch {
    return { ok: false, summary: 'файл не найден' };
  }
  if (!stat.isFile()) return { ok: false, summary: 'это не файл' };
  if (stat.size > FILE_BYTES_MAX) return { ok: false, summary: 'файл слишком большой для чтения вслух' };
  if (DOC_EXT.has(ext)) {
    const res = await runner(DOCX_XML_SCRIPT, { JARVIS_DOC: file }, { signal, timeoutMs: 20000 });
    if (!res.ok) return { ok: false, summary: res.summary };
    const text = docxXmlToText((res.data && res.data.stdout) || '');
    if (!text.trim()) return { ok: false, summary: 'в документе нет текста' };
    return { ok: true, text };
  }
  let raw = '';
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, summary: `не смог прочитать файл: ${err.message}` };
  }
  raw = raw.replace(/^\uFEFF/, '');
  const text = HTML_EXT.has(ext) ? htmlToText(raw) : raw;
  if (!text.trim()) return { ok: false, summary: 'в файле нет текста' };
  return { ok: true, text };
}

// Голос для чтения вслух. Он берётся в момент чтения, а не при сборке инструментов: голос
// подключается позже, а во время работы может смениться (локальный или облачный).
let reader = null;
function getReader() {
  if (!reader) {
    reader = createReader({
      speak: (text, signal) => {
        if (!speaker) throw new Error('голос не подключён');
        return speaker(text, signal);
      },
    });
  }
  return reader;
}

// Короткий и честный рассказ о том, где чтение: «3 из 12», «дальше не читаю» и так далее.
function readerSummary(snapshot) {
  const at = `${Math.min(snapshot.index + (snapshot.state === 'done' ? 0 : 1), snapshot.total)} из ${snapshot.total}`;
  switch (snapshot.state) {
    case 'playing': return `читаю: ${at}${snapshot.label ? ` (${snapshot.label})` : ''}`;
    case 'paused': return `пауза на ${at}`;
    case 'stopped': return `остановлено на ${at}`;
    case 'done': return `дочитано: ${snapshot.total} из ${snapshot.total}`;
    case 'error': return `чтение прервалось на ${at}: ${snapshot.error || 'голос не ответил'}`;
    default: return 'сейчас ничего не читаю';
  }
}

const READ_ACTIONS = ['start', 'pause', 'resume', 'stop', 'status'];
const READ_SOURCES = ['clipboard', 'selection', 'file'];

const readClipboardAloud = {
  name: 'read_clipboard_aloud',
  description: `Прочитать вслух текст: из буфера обмена, выделенное сейчас или файл (txt, md, html, docx, json, csv, log). Читаю кусками по предложениям, в фоне, до ${MAX_READ} символов. Управление: action "pause" — пауза, "resume" — продолжить с того же места, "stop" — остановить, "status" — где сейчас. Для файла укажи path.`,
  risk: 'T1',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: READ_ACTIONS, description: 'start (по умолчанию), pause, resume, stop, status' },
      source: { type: 'string', enum: READ_SOURCES, description: 'clipboard (по умолчанию), selection или file' },
      path: { type: 'string', description: 'путь к файлу, когда source = file' },
    },
  },
  async run(args = {}, ctx = {}) {
    const action = String(args.action || 'start');
    if (!READ_ACTIONS.includes(action)) return { ok: false, summary: `не знаю действие «${action}»`, data: {} };
    const book = getReader();
    if (action === 'status') return { ok: true, summary: readerSummary(book.snapshot()), data: book.snapshot() };
    if (action === 'pause' || action === 'resume' || action === 'stop') {
      const before = book.snapshot();
      const after = action === 'pause' ? book.pause() : action === 'resume' ? book.resume() : book.stop();
      // Ничего не делали — так и говорим, без выдумки.
      if (before.state === after.state) return { ok: true, summary: readerSummary(after), data: after };
      return { ok: true, summary: readerSummary(after), data: after };
    }

    const source = String(args.source || 'clipboard');
    if (!READ_SOURCES.includes(source)) return { ok: false, summary: `не знаю источник «${source}»`, data: {} };
    if (!speaker) return { ok: false, summary: 'голос не подключён', data: {} };

    let text = '';
    let label = null;
    if (source === 'file') {
      const file = String(args.path || '').trim();
      if (!file) return { ok: false, summary: 'не указан файл', data: {} };
      const doc = await readDocumentText(file, { signal: ctx.signal });
      if (!doc.ok) return { ok: false, summary: doc.summary, data: {} };
      text = doc.text;
      label = path.basename(file);
    } else if (source === 'selection') {
      const res = await runPowerShell(SELECTION_SCRIPT, {}, { signal: ctx.signal, timeoutMs: 15000 });
      if (!res.ok) return { ok: false, summary: res.summary, data: {} };
      text = String((res.data && res.data.stdout) || '').trim();
      if (!text) return { ok: false, summary: 'выделенного текста не видно: выделите фрагмент и попросите снова', data: {} };
      label = 'выделенное';
    } else {
      const res = await runPowerShell(CLIPBOARD_READ, {}, { signal: ctx.signal, timeoutMs: 10000 });
      if (!res.ok) return { ok: false, summary: res.summary, data: {} };
      text = String((res.data && res.data.stdout) || '').trim();
      if (!text) return { ok: false, summary: 'буфер пуст: скопируйте текст и попросите снова', data: {} };
      label = 'буфер обмена';
    }

    const started = book.start(text, { label });
    if (!started.total) return { ok: false, summary: 'нечего читать: текста нет', data: started };
    // Чтение идёт в фоне: ход не занимается на минуты, пауза и стоп приходят следующим поручением.
    return {
      ok: true,
      summary: `${readerSummary(started)}${started.truncated ? `, дальше не читаю (всего ${started.chars} символов)` : ''}`,
      data: started,
    };
  },
  verify: cannotVerify('голос отработал, но услышан ли звук, узнать нельзя'),
};

const desktopTools = [wait, windowsMinimizeAll, windowsRestoreAll, monitorOff, appClose, speak, pcShutdown, readClipboardAloud];

// Чтение вслух нужно и снаружи инструментов: окно и аварийный стоп спрашивают, читает ли Джарвис,
// и могут остановить чтение, не дожидаясь нового поручения.
function readAloudBusy() {
  return Boolean(reader && reader.busy);
}

function stopReading() {
  if (reader) reader.stop();
}

module.exports = {
  desktopTools,
  comboScript,
  setSpeaker,
  MAX_WAIT_MS,
  MINIMIZE_SCRIPT,
  RESTORE_SCRIPT,
  splitForSpeech,
  speakChunks,
  READ_LIMIT,
  READ_CHUNK,
  getReader,
  readAloudBusy,
  stopReading,
  readDocumentText,
  htmlToText,
  docxXmlToText,
  SELECTION_SCRIPT,
  DOCX_XML_SCRIPT,
  FILE_BYTES_MAX,
  TEXT_EXT,
  HTML_EXT,
  DOC_EXT,
};
