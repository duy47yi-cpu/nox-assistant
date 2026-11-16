'use strict';

// Проигрывание облачного WAV и отменяемая озвучка ответа.
const fs = require('node:fs');
const { runPowerShell } = require('../tools/system');

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
  '$culture = [System.Globalization.CultureInfo]::InvariantCulture',
  '$number = [System.Globalization.NumberStyles]::Float',
  '$ppVolume = 1.0; [void][double]::TryParse([string]$env:JARVIS_WAV_VOLUME, $number, $culture, [ref]$ppVolume)',
  '$ppRate = 1.0; [void][double]::TryParse([string]$env:JARVIS_WAV_RATE, $number, $culture, [ref]$ppRate)',
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

// Какой скрипт проигрывания выбрать: при настройках по умолчанию остаётся проверенный SoundPlayer,
// с громкостью/скоростью — WPF MediaPlayer. Вынесено отдельно, чтобы проверить тестом.
function playScriptFor({ volume = 1, rate = 1 } = {}) {
  const safeVolume = clampVolume(volume);
  const safeRate = clampRate(rate);
  return { script: safeVolume !== 1 || safeRate !== 1 ? PLAY_WPF_SCRIPT : PLAY_SCRIPT, volume: safeVolume, rate: safeRate };
}

async function playWav(file, { signal, volume = 1, rate = 1 } = {}) {
  const plan = playScriptFor({ volume, rate });
  const env = { JARVIS_WAV: file };
  if (plan.script === PLAY_WPF_SCRIPT) {
    let duration = 0;
    try {
      duration = wavDurationMs(fs.readFileSync(file));
    } catch { /* сработает запасной таймер */ }
    env.JARVIS_WAV_VOLUME = String(plan.volume);
    env.JARVIS_WAV_RATE = String(plan.rate);
    env.JARVIS_WAV_MS = String(Math.max(1000, Math.round(duration / plan.rate) + 600));
  }
  const result = await runPowerShell(plan.script, env, { timeoutMs: PLAY_TIMEOUT_MS, signal });
  signal?.throwIfAborted();
  if (!result.ok) throw new Error('Не удалось воспроизвести звук.');
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
  playWav,
  ReplySpeech,
  PLAY_SCRIPT,
  PLAY_WPF_SCRIPT,
  playScriptFor,
  clampVolume,
  clampRate,
  wavDurationMs,
  VOLUME_MIN,
  VOLUME_MAX,
  RATE_MIN,
  RATE_MAX,
};
