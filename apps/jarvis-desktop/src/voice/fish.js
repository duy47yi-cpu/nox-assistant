'use strict';

// Голос Fish Audio: облачный синтез в mp3 по HTTP. Ключ — FISH_API_KEY в .env; без ключа
// этот голос не включается, и приложение продолжает пользоваться локальным, если он есть.
// mp3 проигрывается WPF MediaPlayer в PowerShell: внешних программ не нужно.
// Синтез и проигрывание отменяются общим сигналом (остановка ответа, диктовка).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPowerShell } = require('../tools/system');
const { clampVolume, clampRate } = require('./tts');

const DEFAULT_URL = 'https://api.fish.audio/v1/tts';
// Модель по умолчанию — из документации Fish Audio; можно переопределить FISH_TTS_MODEL.
const DEFAULT_MODEL = 's2.1-pro-free';
const MAX_TEXT = 500;
const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const PLAY_TIMEOUT_MS = 2 * 60 * 1000;

// Проигрывание mp3 без внешних программ: WPF MediaPlayer. Ему нужен цикл сообщений, иначе он
// не сообщает MediaOpened: прокручиваем диспетчер, ждём открытия, затем ровно длительность песни.
// Длительность считает Node по кадрам mp3 и передаёт в JARVIS_MP3_MS.
const PLAY_SCRIPT = [
  'Add-Type -AssemblyName PresentationCore,WindowsBase',
  '$p = New-Object System.Windows.Media.MediaPlayer',
  '$ppVolume = 1.0; [void][double]::TryParse([string]$env:JARVIS_MP3_VOLUME, [ref]$ppVolume)',
  '$ppRate = 1.0; [void][double]::TryParse([string]$env:JARVIS_MP3_RATE, [ref]$ppRate)',
  'if ($ppVolume -lt 0) { $ppVolume = 0 }',
  'if ($ppVolume -gt 1) { $ppVolume = 1 }',
  'if ($ppRate -lt 0.5) { $ppRate = 0.5 }',
  'if ($ppRate -gt 2) { $ppRate = 2 }',
  '$script:opened = $false',
  '$script:openFrame = New-Object System.Windows.Threading.DispatcherFrame',
  '$p.add_MediaOpened({ $script:opened = $true; $script:openFrame.Continue = $false })',
  '$p.add_MediaFailed({ $script:opened = $false; $script:openFrame.Continue = $false })',
  '$openTimer = New-Object System.Windows.Threading.DispatcherTimer',
  '$openTimer.Interval = [TimeSpan]::FromMilliseconds(5000)',
  '$openTimer.add_Tick({ $openTimer.Stop(); $script:openFrame.Continue = $false })',
  '$openTimer.Start()',
  '$p.Open([Uri]$env:JARVIS_MP3)',
  '[System.Windows.Threading.Dispatcher]::PushFrame($script:openFrame)',
  '$openTimer.Stop()',
  'if (-not $script:opened) { $p.Stop(); $p.Close(); Write-Output "NO_OPEN"; exit 1 }',
  '$ms = 0; [void][int]::TryParse([string]$env:JARVIS_MP3_MS, [ref]$ms)',
  'if ($ms -le 0) { $ms = 15000 }',
  '$p.Volume = $ppVolume',
  '$p.SpeedRatio = $ppRate',
  '$p.Play()',
  '$script:endFrame = New-Object System.Windows.Threading.DispatcherFrame',
  '$endTimer = New-Object System.Windows.Threading.DispatcherTimer',
  // Конец фразы наступает раньше при скорости больше 1: длительность делим на скорость.
  '$endTimer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max(1000, [int]($ms / $ppRate) + 400))',
  '$endTimer.add_Tick({ $endTimer.Stop(); $script:endFrame.Continue = $false })',
  '$endTimer.Start()',
  '[System.Windows.Threading.Dispatcher]::PushFrame($script:endFrame)',
  '$endTimer.Stop()',
  '$p.Stop(); $p.Close()',
].join('; ');

// Длительность mp3 по кадрам: ID3v2 пропускаем, дальше читаем заголовки MPEG и складываем сэмплы.
// Нужна, чтобы остановить проигрывание точно в конце: WPF в этом окружении не сообщает длительность
// без цикла сообщений. Не получилось разобрать — 0 (тогда проигрывание ограничено 15 секундами).
const MP3_BITRATES = {
  1: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};
const MP3_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

function mp3DurationMs(buffer) {
  let offset = 0;
  if (buffer.length >= 10 && buffer.toString('latin1', 0, 3) === 'ID3') {
    // Размер ID3v2 — четыре байта по 7 бит в конце заголовка.
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size + ((buffer[5] & 0x10) ? 10 : 0);
  }
  let samples = 0;
  let rate = 0;
  let frames = 0;
  while (offset + 4 <= buffer.length && frames < 20000) {
    const b1 = buffer[offset + 1];
    if (buffer[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) break;
    const versionBits = (b1 >> 3) & 0x03; // 3 — MPEG1, 2 — MPEG2, 0 — MPEG2.5
    const layerBits = (b1 >> 1) & 0x03; // 1 — Layer III
    if (versionBits === 1 || layerBits === 0) break;
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
    const b2 = buffer[offset + 2];
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const rateIndex = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;
    if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) break;
    // Биты слоя: 1 — Layer III, 2 — Layer II, 3 — Layer I. В таблицах ключи как у слоя.
    const layerKey = layerBits === 1 ? 3 : layerBits === 2 ? 2 : 1;
    const table = MP3_BITRATES[version === 1 ? 1 : 2][layerKey];
    const bitrate = (table[bitrateIndex] || 0) * 1000;
    const frameRate = MP3_RATES[version][rateIndex];
    if (!bitrate || !frameRate) break;
    const perFrame = version === 1 ? 1152 : 576;
    // Layer III: длина кадра = (сэмплы / 8) * битрейт / частота + padding.
    const length = Math.floor((perFrame / 8) * bitrate / frameRate) + padding;
    if (!length) break;
    rate = frameRate;
    samples += perFrame;
    frames += 1;
    offset += length;
  }
  if (!frames || !rate) return 0;
  return Math.round((samples / rate) * 1000);
}

// Текст для синтеза: обрезка по кодовым точкам, чтобы пара-суррогат не рвался.
function cleanText(text) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('пустой текст');
  return Array.from(clean).slice(0, MAX_TEXT).join('');
}

function abortError() {
  const err = new Error('синтез отменён');
  err.name = 'AbortError';
  return err;
}

class FishSpeech {
  constructor({
    apiKey = '',
    voiceId = null,
    url = DEFAULT_URL,
    model = DEFAULT_MODEL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    tmpDir = os.tmpdir(),
    volume = 1,
    rate = 1,
    // playFn(file, {signal, ms, volume, rate}) -> Promise<{ok, summary}>, как у runPowerShell.
    // Тесты подменяют его, чтобы не играть звук.
    playFn = null,
  } = {}) {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    this.voiceId = typeof voiceId === 'string' && voiceId.trim() ? voiceId.trim() : null;
    this.url = url;
    this.model = model || DEFAULT_MODEL;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.tmpDir = tmpDir;
    this.volume = clampVolume(volume);
    this.rate = clampRate(rate);
    this.playFn = playFn || ((file, options = {}) => this._playMp3(file, options));
    this._controller = null;
    this._durations = new Map(); // путь к mp3 -> длительность в мс: нужна проигрыванию
  }

  // Ключ есть — голос можно включать. Сеть здесь не проверяется.
  availability() {
    if (this.apiKey !== '') return { available: true, provider: 'fish', reason: null };
    return { available: false, provider: 'fish', reason: 'Облачный голос не настроен: нет ключа голоса. Впишите FISH_API_KEY в .env' };
  }

  isInstalled() {
    return this.apiKey !== '';
  }

  // Настройки голоса: громкость 0…1 и скорость 0,5…2. Голос Fish задаётся ключом и voiceId, здесь — игра.
  options() {
    return { volume: this.volume, rate: this.rate };
  }

  setOptions({ volume, rate } = {}) {
    if (volume !== undefined) this.volume = clampVolume(volume, this.volume);
    if (rate !== undefined) this.rate = clampRate(rate, this.rate);
    return this.options();
  }

  // Ключ можно вписать в .env уже после запуска приложения: перечитываем значения перед проверкой голоса.
  configure({ apiKey, voiceId, model } = {}) {
    if (typeof apiKey === 'string' && apiKey.trim()) this.apiKey = apiKey.trim();
    if (voiceId !== undefined) this.voiceId = typeof voiceId === 'string' && voiceId.trim() ? voiceId.trim() : null;
    if (typeof model === 'string' && model.trim()) this.model = model.trim();
  }

  // Синтез в mp3. Возвращает путь к временному файлу; удалить его — забота speak().
  async synthesize(text, { signal } = {}) {
    if (!this.isInstalled()) throw new Error('ключ Fish Audio не задан: впишите FISH_API_KEY в .env');
    const clean = cleanText(text);
    if (signal && signal.aborted) throw abortError();

    const controller = new AbortController();
    this._controller = controller;
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let bytes;
    try {
      let res;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            model: this.model,
          },
          body: JSON.stringify({ text: clean, format: 'mp3', ...(this.voiceId ? { reference_id: this.voiceId } : {}) }),
          signal: controller.signal,
        });
      } catch (err) {
        if ((signal && signal.aborted) || (err && err.name === 'AbortError')) {
          throw signal && signal.aborted ? abortError() : new Error(`голос не ответил за ${Math.max(1, Math.round(this.timeoutMs / 1000))} с`);
        }
        throw new Error('нет связи с голосом Fish Audio');
      }
      if (!res || !res.ok) {
        const status = res && res.status ? `код ${res.status}` : 'без ответа';
        throw new Error(`голос Fish Audio ответил ошибкой (${status})`);
      }
      bytes = Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (this._controller === controller) this._controller = null;
    }
    if (!bytes || !bytes.length) throw new Error('голос Fish Audio вернул пустой звук');
    if (bytes.length > MAX_BYTES) throw new Error('звук от Fish Audio больше 8 МБ');

    const file = path.join(this.tmpDir, `nox-fish-${crypto.randomUUID()}.mp3`);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    this._durations.set(file, mp3DurationMs(bytes));
    return file;
  }

  // Проигрывание mp3. Ошибка, если PowerShell не справился.
  async play(file, { signal, volume, rate } = {}) {
    const ms = this._durations.get(file) || 0;
    this._durations.delete(file);
    const res = await this.playFn(file, {
      signal,
      ms,
      volume: volume === undefined ? this.volume : clampVolume(volume, this.volume),
      rate: rate === undefined ? this.rate : clampRate(rate, this.rate),
    });
    if (!res || !res.ok) throw new Error(`проигрывание не удалось: ${(res && res.summary) || 'нет ответа'}`);
  }

  // Синтез и проигрывание. Временный mp3 удаляется в любом случае.
  async speak(text, opts = {}) {
    const file = await this.synthesize(text, { signal: opts.signal });
    try {
      await this.play(file, { signal: opts.signal, volume: opts.volume, rate: opts.rate });
      return file;
    } finally {
      this._durations.delete(file);
      try { fs.rmSync(file, { force: true }); } catch { /* файл мог не создаться */ }
    }
  }

  // Проигрывание mp3 без подмены: WPF MediaPlayer с громкостью и скоростью.
  _playMp3(file, { signal, ms, volume = this.volume, rate = this.rate } = {}) {
    return runPowerShell(PLAY_SCRIPT, {
      JARVIS_MP3: file,
      JARVIS_MP3_MS: String(ms || 0),
      JARVIS_MP3_VOLUME: String(volume),
      JARVIS_MP3_RATE: String(rate),
    }, { timeoutMs: PLAY_TIMEOUT_MS, signal });
  }

  // Остановка озвучки: отменяет синтез; проигрывание отменяется сигналом снаружи.
  stop() {
    const controller = this._controller;
    this._controller = null;
    if (controller) controller.abort();
  }
}

module.exports = { FishSpeech, PLAY_SCRIPT, MAX_TEXT, MAX_BYTES, DEFAULT_MODEL, DEFAULT_URL, mp3DurationMs };
