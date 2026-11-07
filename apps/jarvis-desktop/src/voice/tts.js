'use strict';

// Локальный голос Jarvis: синтез Silero в отдельном Python-процессе, проигрывание WAV через PowerShell.
// Облачных API нет. Процесс запускается при первом запросе и переиспользуется.
// Запросы идут строго по одному; ответы сопоставляются по id.
//
// Настройки голоса (голос, громкость, скорость) хранит settings.json, а применяет этот модуль:
//   speaker — имя голоса Silero (список даёт listVoices, когда модель загружена);
//   volume  — 0…1, по умолчанию 1;
//   rate    — 0,5…2, по умолчанию 1.
// При значениях по умолчанию проигрывание идёт прежним SoundPlayer (он проверен), иначе — WPF MediaPlayer,
// который умеет громкость и скорость. Ошибки — с причиной: нет python, нет файла сервера, нет модели, тайм-аут.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runPowerShell } = require('../tools/system');

const MAX_TEXT = 500;
const STDERR_TAIL = 1000;
// Проигрывание идёт до конца фразы, длинный текст может звучать минуты.
const PLAY_TIMEOUT_MS = 5 * 60 * 1000;
// Голос, громкость и скорость: пределы, чтобы настройка из settings.json не сломала звук.
const VOLUME_MIN = 0;
const VOLUME_MAX = 1;
const RATE_MIN = 0.5;
const RATE_MAX = 2;
// Путь к wav передаётся через переменную окружения, а не склейкой в скрипт.
const PLAY_SCRIPT = '(New-Object System.Media.SoundPlayer $env:JARVIS_WAV).PlaySync()';
// То же для настройки громкости и скорости: WPF MediaPlayer. Цикл сообщений нужен, чтобы пришли
// MediaOpened и MediaEnded; таймер — чтобы скрипт не ждал вечно. Пауза до конца фразы считается
// по длительности wav и делится на скорость.
const PLAY_WPF_SCRIPT = [
  'Add-Type -AssemblyName PresentationCore,WindowsBase',
  '$p = New-Object System.Windows.Media.MediaPlayer',
  '$ppVolume = 1.0; [void][double]::TryParse([string]$env:JARVIS_WAV_VOLUME, [ref]$ppVolume)',
  '$ppRate = 1.0; [void][double]::TryParse([string]$env:JARVIS_WAV_RATE, [ref]$ppRate)',
  'if ($ppVolume -lt 0) { $ppVolume = 0 }',
  'if ($ppVolume -gt 1) { $ppVolume = 1 }',
  'if ($ppRate -lt 0.5) { $ppRate = 0.5 }',
  'if ($ppRate -gt 2) { $ppRate = 2 }',
  '$script:ppOpened = $false',
  '$script:ppEnded = $false',
  '$script:ppOpenFrame = New-Object System.Windows.Threading.DispatcherFrame',
  '$p.add_MediaOpened({ $script:ppOpened = $true; if ($script:ppOpenFrame) { $script:ppOpenFrame.Continue = $false } })',
  '$p.add_MediaFailed({ $script:ppOpened = $false; if ($script:ppOpenFrame) { $script:ppOpenFrame.Continue = $false } })',
  '$openTimer = New-Object System.Windows.Threading.DispatcherTimer',
  '$openTimer.Interval = [TimeSpan]::FromMilliseconds(5000)',
  '$openTimer.add_Tick({ $openTimer.Stop(); if ($script:ppOpenFrame) { $script:ppOpenFrame.Continue = $false } })',
  '$openTimer.Start()',
  // Громкость и скорость ставим до открытия: свойства MediaPlayer не зависят от цикла сообщений.
  '$p.Volume = $ppVolume',
  '$p.SpeedRatio = $ppRate',
  '$p.Open([Uri]$env:JARVIS_WAV)',
  '[System.Windows.Threading.Dispatcher]::PushFrame($script:ppOpenFrame)',
  '$openTimer.Stop()',
  'if (-not $script:ppOpened) { $p.Stop(); $p.Close(); Write-Output "NO_OPEN"; exit 1 }',
  '$ms = 0; [void][int]::TryParse([string]$env:JARVIS_WAV_MS, [ref]$ms)',
  'if ($ms -le 0) { $ms = 15000 }',
  '$p.Play()',
  '$script:ppEndFrame = New-Object System.Windows.Threading.DispatcherFrame',
  '$endTimer = New-Object System.Windows.Threading.DispatcherTimer',
  '$endTimer.Interval = [TimeSpan]::FromMilliseconds($ms + 600)',
  '$endTimer.add_Tick({ $endTimer.Stop(); if ($script:ppEndFrame) { $script:ppEndFrame.Continue = $false } })',
  '$endTimer.Start()',
  '[System.Windows.Threading.Dispatcher]::PushFrame($script:ppEndFrame)',
  '$endTimer.Stop()',
  '$p.Stop(); $p.Close()',
].join('; ');
const { unpacked } = require('../config/paths');
const SERVER_SCRIPT = unpacked(path.join(__dirname, '..', '..', 'scripts', 'tts', 'silero_server.py'));
const DEFAULT_OUT_DIR = unpacked(path.join(__dirname, '..', '..', 'scripts', 'tts', 'voice-out'));

// Громкость и скорость из настроек: числа в допустимых пределах, иначе значение по умолчанию.
function clampVolume(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, number));
}

function clampRate(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, number));
}

// Голос из настроек: пустая строка и пробелы — «голос по умолчанию модели».
function cleanSpeaker(value) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 100) : null;
}

// Текст для синтеза: обрезка по кодовым точкам, чтобы пара-суррогат не рвался.
function cleanText(text) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('пустой текст');
  return Array.from(clean).slice(0, MAX_TEXT).join('');
}

// Длительность wav по заголовку: нужна, чтобы остановить проигрывание в конце фразы.
// Не разобрали — 0 (тогда запасной таймер ограничен 15 секундами).
function wavDurationMs(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44) return 0;
    if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return 0;
    let offset = 12;
    let sampleRate = 0;
    let channels = 0;
    let bits = 0;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('latin1', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ' && body + 16 <= buffer.length) {
        channels = buffer.readUInt16LE(body + 2);
        sampleRate = buffer.readUInt32LE(body + 4);
        bits = buffer.readUInt16LE(body + 14);
      } else if (id === 'data') {
        const available = Math.min(size, buffer.length - body);
        if (sampleRate && channels && bits) {
          return Math.round((available / (sampleRate * channels * (bits / 8))) * 1000);
        }
        return 0;
      }
      if (size > buffer.length) break;
      offset = body + size + (size % 2); // чанки выровнены по 2 байта
    }
  } catch {
    return 0;
  }
  return 0;
}

// Есть ли команда: путь к файлу или имя из PATH. Программа не запускается.
function commandExists(command, fsImpl) {
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes('/')) {
    return fsImpl.existsSync(command);
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)]
    : [''];
  return dirs.some((dir) => exts.some((ext) => fsImpl.existsSync(path.join(dir, command + ext))));
}

// Какой скрипт проигрывания выбрать: при настройках по умолчанию остаётся проверенный SoundPlayer,
// с громкостью/скоростью — WPF MediaPlayer. Вынесено отдельно, чтобы проверить тестом.
function playScriptFor({ volume = 1, rate = 1 } = {}) {
  const safeVolume = clampVolume(volume);
  const safeRate = clampRate(rate);
  return { script: safeVolume !== 1 || safeRate !== 1 ? PLAY_WPF_SCRIPT : PLAY_SCRIPT, volume: safeVolume, rate: safeRate };
}

class SpeechClient {
  constructor({
    command = 'python',
    scriptPath = SERVER_SCRIPT,
    outDir = DEFAULT_OUT_DIR,
    args,
    spawnImpl = spawn,
    timeoutMs = 120000,
    speaker = null,
    volume = 1,
    rate = 1,
    // playFn(file, {signal, volume, rate}) -> Promise<{ok, summary}>, как у runPowerShell.
    // Тесты подменяют его, чтобы не играть звук.
    playFn = null,
  } = {}) {
    this.command = command;
    this.scriptPath = scriptPath;
    this.args = args || [scriptPath, '--out-dir', outDir];
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.speaker = cleanSpeaker(speaker);
    this.volume = clampVolume(volume);
    this.rate = clampRate(rate);
    this.playFn = playFn || ((file, options = {}) => this._playWav(file, options));
    this._child = null;
    this._buffer = '';
    this._stderrTail = '';
    this._pending = new Map(); // id запроса -> settle(err, value)
    this._queue = Promise.resolve();
    // Локальный синтез может «повиснуть» на загрузке модели (torch скачивает её из сети).
    // После таймаута не пробуем снова весь сеанс: иначе каждый ответ ждал бы те же секунды.
    this._disabledReason = null;
  }

  // Причина, по которой локальный голос выключен до перезапуска, или null.
  disabledReason() {
    return this._disabledReason;
  }

  // Можно ли включить локальный голос и, если нет, что именно отсутствует. Python не запускается.
  availability(fsImpl = fs) {
    if (this._disabledReason) return { available: false, provider: 'local', reason: this._disabledReason };
    let script = false;
    let python = false;
    try {
      script = fsImpl.existsSync(this.scriptPath);
      python = commandExists(this.command, fsImpl);
    } catch {
      script = false;
      python = false;
    }
    if (!script) return { available: false, provider: 'local', reason: 'Локальный голос не установлен: нет файла синтеза Silero' };
    if (!python) return { available: false, provider: 'local', reason: 'Локальный голос не установлен: не найден Python' };
    return { available: true, provider: 'local', reason: null };
  }

  // Текущие настройки голоса: их пишет main.js в settings.json и передаёт сюда.
  options() {
    return { speaker: this.speaker, volume: this.volume, rate: this.rate };
  }

  // Смена голоса/громкости/скорости без перезапуска приложения.
  setOptions({ speaker, volume, rate } = {}) {
    if (speaker !== undefined) this.speaker = cleanSpeaker(speaker);
    if (volume !== undefined) this.volume = clampVolume(volume, this.volume);
    if (rate !== undefined) this.rate = clampRate(rate, this.rate);
    return this.options();
  }

  // Синтез одной фразы в wav. Вызовы выстраиваются в очередь: в процессе одновременно только один запрос.
  async synthesize(text, { signal, speaker } = {}) {
    if (this._disabledReason) throw new Error(this._disabledReason);
    const clean = cleanText(text);
    const voice = speaker === undefined ? this.speaker : cleanSpeaker(speaker);
    const run = this._queue.then(() => this._request({ ...(voice ? { speaker: voice } : {}), text: clean }, signal));
    this._queue = run.catch(() => {});
    try {
      return await run;
    } catch (err) {
      // Таймаут — признак, что локальный голос не поднимется за разумное время: отключаем до перезапуска.
      if (/таймаут/i.test(err.message)) this._disabledReason = `локальный голос не отвечает: ${err.message}`;
      throw err;
    }
  }

  // Список голосов модели: нужен, чтобы владелец выбрал голос, а не пользовался первым.
  // Модель загружается при первом запросе, поэтому первый вызов может быть долгим — это честно.
  async listVoices({ signal } = {}) {
    if (this._disabledReason) throw new Error(this._disabledReason);
    const run = this._queue.then(() => this._request({ op: 'voices' }, signal));
    this._queue = run.catch(() => {});
    const voices = await run;
    return (Array.isArray(voices) ? voices : []).map((voice) => String(voice)).filter(Boolean);
  }

  // Проигрывание wav. Ошибка, если PowerShell не справился.
  async play(file, { signal, volume, rate } = {}) {
    const res = await this.playFn(file, {
      signal,
      volume: volume === undefined ? this.volume : clampVolume(volume, this.volume),
      rate: rate === undefined ? this.rate : clampRate(rate, this.rate),
    });
    if (!res || res.ok !== true) throw new Error(`проигрывание не удалось: ${(res && res.summary) || 'нет ответа'}`);
  }

  // Синтез и проигрывание. Возвращает путь к wav.
  async speak(text, opts = {}) {
    const file = await this.synthesize(text, { signal: opts.signal, speaker: opts.speaker });
    await this.play(file, { signal: opts.signal, volume: opts.volume, rate: opts.rate });
    return file;
  }

  stop() {
    if (this._child) this._drop(this._child, new Error('голос остановлен'), true);
  }

  // Только проверка файлов: есть ли скрипт сервера и команда python. Python не запускается.
  isInstalled(fsImpl = fs) {
    return this.availability(fsImpl).available;
  }

  // Проигрывание wav без подмены: по умолчанию прежний проверенный SoundPlayer, с настройками — WPF.
  _playWav(file, { signal, volume = this.volume, rate = this.rate } = {}) {
    const plan = playScriptFor({ volume, rate });
    if (plan.script === PLAY_SCRIPT) {
      return runPowerShell(PLAY_SCRIPT, { JARVIS_WAV: file }, { timeoutMs: PLAY_TIMEOUT_MS, signal });
    }
    let duration = 0;
    try {
      duration = wavDurationMs(fs.readFileSync(file));
    } catch { /* длительность неизвестна — сработает запасной таймер */ }
    const ms = Math.max(1000, Math.round(duration / plan.rate) + 600);
    return runPowerShell(plan.script, {
      JARVIS_WAV: file,
      JARVIS_WAV_VOLUME: String(plan.volume),
      JARVIS_WAV_RATE: String(plan.rate),
      JARVIS_WAV_MS: String(ms),
    }, { timeoutMs: PLAY_TIMEOUT_MS, signal });
  }

  _request(payload, signal) {
    if (signal?.aborted) return Promise.reject(new Error('синтез отменён'));
    const child = this._ensureChild();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => this._drop(child, new Error('синтез отменён'), true);
      const timer = setTimeout(() => {
        this._drop(child, new Error(`синтез: таймаут ${this.timeoutMs} мс`), true);
      }, this.timeoutMs);
      const settle = (err, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this._pending.delete(id);
        if (err) reject(err);
        else resolve(value);
      };
      this._pending.set(id, settle);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  // Запускает процесс, если его нет. После падения следующий вызов поднимает его заново.
  _ensureChild() {
    if (this._child) return this._child;
    const child = this.spawnImpl(this.command, this.args, {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    this._child = child;
    this._buffer = '';
    this._stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(child, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this._stderrTail = (this._stderrTail + chunk).slice(-STDERR_TAIL);
    });
    child.stdin.on('error', (err) => this._onExit(child, err));
    child.on('error', (err) => this._onExit(child, err));
    child.on('exit', (code) => this._onExit(child, new Error(`процесс синтеза остановился, код ${code}`)));
    return child;
  }

  _onExit(child, err) {
    const tail = this._stderrTail.trim();
    const reason = tail ? `${err.message}; stderr: ${tail.slice(-300)}` : err.message;
    this._drop(child, new Error(`голос: ${reason}`), false);
  }

  // Отцепляет процесс и отклоняет все ожидающие ответы. Если процесс ещё жив, убивает его.
  _drop(child, err, kill) {
    if (this._child !== child) return;
    this._child = null;
    this._buffer = '';
    if (kill) {
      try {
        child.kill();
      } catch {
        // процесс уже мог завершиться; важна исходная причина
      }
    }
    const waiting = [...this._pending.values()];
    this._pending.clear();
    for (const settle of waiting) settle(err);
  }

  _onData(child, chunk) {
    if (this._child !== child) return;
    this._buffer += chunk;
    let idx = this._buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (line) this._onLine(line);
      idx = this._buffer.indexOf('\n');
    }
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // посторонняя строка в stdout: сервер пишет только JSON, такое пропускаем
    }
    const settle = this._pending.get(msg?.id);
    if (!settle) return;
    if (msg.ok === true && typeof msg.file === 'string') {
      settle(null, msg.file);
    } else if (msg.ok === true && Array.isArray(msg.voices)) {
      settle(null, msg.voices);
    } else {
      settle(new Error(`синтез: ${msg?.error || 'сервер вернул ошибку без текста'}`));
    }
  }
}

// Только озвучка ответа чата: у неё свой сигнал, чтобы диктовка не отменяла чужие сценарии с speak.
class ReplySpeech {
  constructor({ voice, isListening = () => false, onError = () => {} } = {}) {
    this.voice = voice;
    this.isListening = isListening;
    this.onError = onError;
    this.current = null;
  }

  async speak(text) {
    if (!String(text || '').trim() || this.isListening()) return;
    this.stop();
    const controller = new AbortController();
    this.current = controller;
    try {
      await this.voice.speak(text, { signal: controller.signal });
    } catch (err) {
      if (!controller.signal.aborted) this.onError(err);
    } finally {
      if (this.current === controller) this.current = null;
    }
  }

  stop() {
    const controller = this.current;
    this.current = null;
    if (controller) controller.abort();
  }
}

module.exports = {
  SpeechClient,
  ReplySpeech,
  MAX_TEXT,
  SERVER_SCRIPT,
  DEFAULT_OUT_DIR,
  PLAY_SCRIPT,
  PLAY_WPF_SCRIPT,
  playScriptFor,
  clampVolume,
  clampRate,
  cleanSpeaker,
  wavDurationMs,
  VOLUME_MIN,
  VOLUME_MAX,
  RATE_MIN,
  RATE_MAX,
};
