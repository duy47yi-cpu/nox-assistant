'use strict';

// Режимы микрофона: чистые переходы и фразы (src/voice/modes.js).
const { handlePhrase, normalizeState, DEFAULT_STATE } = require('./modes');

// Разбор потока событий раннера диктовки: встроенное распознавание Windows, без облака.
// Раннер (PowerShell) печатает в stdout по одной JSON-строке на событие:
//   {"type":"text","text":"сказанное"} — распознанная фраза;
//   {"type":"error","code":"no_language"} — нет русского языка распознавания;
//   {"type":"error","code":"no_audio","message":"..."} — микрофон не найден или занят;
//   {"type":"error","code":"no_engine","message":"..."} — распознавание не запустилось;
//   {"type":"state","state":"listening"|"stopped"} — что делает раннер.
// Посторонние строки в stdout (логи, пустые строки) разбор не роняют — они пропускаются.
//
// Сам скрипт раннера живёт здесь, а не в main.js: его проверяет тест синтаксиса PowerShell,
// и сломанная строка не может тихо выключить диктовку (так было до 07.11.2026: вызов
// LoadGrammar(New-Object …) давал синтаксическую ошибку, ни одного события не приходило).

// Предел сказанного: как maxlength поля ввода чата.
const MAX_TEXT = 8000;

// Что говорить владельцу, когда в Windows не включён русский язык распознавания.
const NO_LANGUAGE_MESSAGE = 'Включите русский язык распознавания в Windows. Настройки → Время и язык → Речь.';
// Микрофона нет или его заняли: это не сбой программы, а состояние устройства.
const NO_AUDIO_MESSAGE = 'Микрофон не найден или занят другой программой';
// Распознавание не поднялось: честно говорим, что диктовка не работает.
const NO_ENGINE_MESSAGE = 'Распознавание речи Windows не запустилось';

const CODE_MESSAGES = {
  no_language: NO_LANGUAGE_MESSAGE,
  no_audio: NO_AUDIO_MESSAGE,
  no_engine: NO_ENGINE_MESSAGE,
};

// Код языка распознавания: только безопасная форма, без подстановки в скрипт произвольного текста.
function dictationCulture(value) {
  const text = String(value ?? '').trim();
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(text) ? text : 'ru';
}

// Скрипт раннера для PowerShell 5.1. Все ошибки видимы: каждое событие — JSON в stdout,
// stderr остаётся для диагностики. Аудио никуда не пишется и не отправляется в сеть.
function dictationScript({ culture = 'ru' } = {}) {
  const safeCulture = dictationCulture(culture);
  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "try {",
    'Add-Type -AssemblyName System.Speech',
    // Распознаватель нужного языка; его нет — понятный отказ, а не тишина.
    `$rec = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -like "${safeCulture}*" } | Select-Object -First 1`,
    `if (-not $rec) { '{"type":"error","code":"no_language"}'; exit 0 }`,
    '$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine $rec',
    // Микрофон по умолчанию недоступен — отказ с причиной.
    `try { $engine.SetInputToDefaultAudioDevice() } catch { (@{type="error";code="no_audio";message=[string]$_.Exception.Message} | ConvertTo-Json -Compress); exit 0 }`,
    // Скобки обязательны: без них PowerShell не разбирает выражение New-Object как аргумент.
    '$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
    `'{"type":"state","state":"listening"}'`,
    // Каждая распознанная фраза — отдельная строка в stdout, только непустой текст.
    '$engine.add_SpeechRecognized({ param($s, $e) if ($e.Result.Text) { [Console]::Out.WriteLine((@{type="text";text=$e.Result.Text} | ConvertTo-Json -Compress)) } })',
    '$engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)',
    // Стоим на строке «stop» из stdin (или до конца потока, если родитель умер), затем вежливо останавливаемся.
    `while ($null -ne ($line = [Console]::In.ReadLine())) { if ($line.Trim() -eq 'stop') { break } }`,
    '$engine.RecognizeAsyncStop()',
    `'{"type":"state","state":"stopped"}'`,
    'exit 0',
    '} catch {',
    // Сюда попадает всё, что не удалось: нет сборки, нет прав, движок упал. Причина — владельцу.
    '(@{type="error";code="no_engine";message=[string]$_.Exception.Message} | ConvertTo-Json -Compress)',
    'exit 1',
    '}',
  ].join('\n');
}

// Строка stdout -> событие { type, ... } или null, если это не событие раннера.
function parseRunnerLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return null; // не JSON: посторонняя строка, пропускаем
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const { type } = msg;
  if (type === 'text') {
    if (typeof msg.text !== 'string') return null;
    return { type, text: msg.text };
  }
  if (type === 'error') {
    const event = { type, code: typeof msg.code === 'string' ? msg.code : 'unknown' };
    // message передаём дальше: describeError покажет его владельцу, если код неизвестен.
    if (typeof msg.message === 'string') event.message = msg.message;
    return event;
  }
  if (type === 'state') {
    if (typeof msg.state !== 'string') return null;
    return { type, state: msg.state };
  }
  return null; // неизвестный тип события
}

// Сказанное годится для поля ввода: это строка, не пустая после обрезки
// пробелов и не длиннее предела поля.
function validText(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_TEXT;
}

// Человекочитаемая причина отказа: для известного кода — свои слова,
// иначе текст от раннера, иначе общая фраза.
function describeError(event) {
  if (event && CODE_MESSAGES[event.code]) return CODE_MESSAGES[event.code];
  if (event && typeof event.message === 'string' && event.message.trim()) return event.message;
  return 'Распознавание не удалось';
}

// Одна сессия диктовки может остановить ход только один раз. Слова попадают в поле ввода,
// но не отправляются сами: владелец видит, что именно распознано.
//
// Режим микрофона (src/voice/modes.js) решает, что делать со сказанным:
// - фразы «тихий режим», «слушай меня», «хватит слушать» перехватываются (onMode) и в поле не печатаются;
// - в quiet в поле и в чат уходит только фраза с обращением «Джарвис» (hasWake), остальное молча пропускается;
// - в off поздние строки раннера игнорируются: распознавание уже остановлено.
function createDictationRouter({ isBusy, interrupt, emit, getMode = () => DEFAULT_STATE, onMode = null, hasWake = null } = {}) {
  let interrupted = false;
  let closed = false;
  const currentMode = () => normalizeState(getMode());
  const wakeSpoken = (text) => typeof hasWake === 'function' && hasWake(text) === true;
  const route = (event) => {
    if (closed || !event) return;
    if (event.type === 'text') {
      if (!validText(event.text)) return;
      const modeResult = handlePhrase(event.text, currentMode());
      if (modeResult.action !== 'none') {
        if (typeof onMode === 'function') {
          try {
            onMode(modeResult, event);
          } catch {
            // сбой обработчика не должен останавливать распознавание
          }
        }
        return;
      }
      const mode = currentMode();
      if (mode === 'off') return; // распознавание остановлено, поздняя строка не нужна
      if (mode === 'quiet' && !wakeSpoken(event.text)) return; // тихий режим: только имя
      if (!interrupted && isBusy()) {
        interrupted = true;
        interrupt();
      }
    }
    emit(event);
  };
  route.close = () => { closed = true; };
  return route;
}

module.exports = {
  parseRunnerLine,
  validText,
  describeError,
  createDictationRouter,
  dictationScript,
  dictationCulture,
  NO_LANGUAGE_MESSAGE,
  NO_AUDIO_MESSAGE,
  NO_ENGINE_MESSAGE,
  MAX_TEXT,
};
