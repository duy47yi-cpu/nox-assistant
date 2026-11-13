'use strict';

const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');

const VALID_STREAM_KINDS = new Set(['system_loopback', 'microphone', 'synthetic_mixed']);

/**
 * Генерирует детерминированный синтетический PCM 16-bit LE буфер (без микрофона и системного звука).
 */
function buildSyntheticPcm16({
  sampleRate = 16000,
  durationMs = 100,
  frequencyHz = 220,
  amplitude = 0.25,
  activeSpeech = true,
} = {}) {
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const buf = Buffer.allocUnsafe(sampleCount * 2);
  if (!activeSpeech || amplitude <= 0) {
    buf.fill(0);
    return buf;
  }
  const maxVal = Math.min(1, Math.max(0, amplitude)) * 32767;
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const sample = Math.round(Math.sin(2 * Math.PI * frequencyHz * t) * maxVal);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/**
 * Проверяет и нормализует структуру входящего аудиофрагмента.
 */
function validateAudioChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') {
    throw new TypeError('AudioChunk должен быть объектом');
  }
  if (!Number.isInteger(chunk.seq) || chunk.seq < 0) {
    throw new RangeError(`Некорректный порядковый номер фрагмента: ${chunk.seq}`);
  }
  if (!Buffer.isBuffer(chunk.pcm) && !(chunk.pcm instanceof Uint8Array)) {
    throw new TypeError('Поле AudioChunk.pcm должно быть Buffer или Uint8Array');
  }
  if (chunk.pcm.byteLength <= 0) {
    throw new RangeError('AudioChunk.pcm не может быть пустым');
  }
  if (!Number.isFinite(chunk.sampleRate) || chunk.sampleRate <= 0) {
    throw new RangeError(`Некорректная частота дискретизации: ${chunk.sampleRate}`);
  }
  if (!Number.isFinite(chunk.startMs) || !Number.isFinite(chunk.endMs) || chunk.endMs < chunk.startMs) {
    throw new RangeError(`Некорректное окно фрагмента [${chunk.startMs}, ${chunk.endMs}]`);
  }
  const streamKind = VALID_STREAM_KINDS.has(chunk.streamKind) ? chunk.streamKind : 'synthetic_mixed';
  return {
    ...chunk,
    streamKind,
    channels: Number.isInteger(chunk.channels) && chunk.channels > 0 ? chunk.channels : 1,
    encoding: chunk.encoding || 'pcm_s16le',
    durationMs: Number.isFinite(chunk.durationMs) ? chunk.durationMs : chunk.endMs - chunk.startMs,
    isSynthetic: chunk.isSynthetic !== false,
    capturedAtPerfMs: Number.isFinite(chunk.capturedAtPerfMs) ? chunk.capturedAtPerfMs : performance.now(),
  };
}

/**
 * Базовый интерфейс источника аудиопотока для C7.
 * Реальные адаптеры (Windows WASAPI loopback, микрофон) подключаются на следующем этапе через этот контракт.
 */
class AudioStreamAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sampleRate = options.sampleRate || 16000;
    this.channels = options.channels || 1;
    this.chunkDurationMs = options.chunkDurationMs || 100;
    this.encoding = options.encoding || 'pcm_s16le';
    this.state = 'idle';
  }

  get sourceKind() {
    return 'abstract';
  }

  get metadata() {
    return {
      sourceKind: this.sourceKind,
      sampleRate: this.sampleRate,
      channels: this.channels,
      chunkDurationMs: this.chunkDurationMs,
      encoding: this.encoding,
      isSynthetic: true,
    };
  }

  async start() {
    throw new Error('AudioStreamAdapter.start() должен быть реализован в наследнике');
  }

  async pause() {
    this.state = 'paused';
    this.emit('state', this.state);
  }

  async resume() {
    this.state = 'running';
    this.emit('state', this.state);
  }

  async stop() {
    this.state = 'stopped';
    this.emit('state', this.state);
  }
}

/**
 * Синтетический адаптер аудиопотока: генерирует PCM-фрагменты и речевые окна без микрофона и WASAPI.
 */
class SyntheticAudioStreamAdapter extends AudioStreamAdapter {
  constructor(options = {}) {
    super(options);
    this.utterances = Array.isArray(options.utterances) ? options.utterances : [];
    this.totalChunks = Number.isInteger(options.totalChunks) ? options.totalChunks : null;
    this.paceMs = Number.isFinite(options.paceMs) ? Math.max(0, options.paceMs) : 50;
    this.defaultStreamKind = options.streamKind || 'system_loopback';
    this._timer = null;
    this._seq = 0;
    this._timelineMs = 0;
    this._running = false;
    this._paused = false;
    this._abortHandler = null;
    this._signal = null;
    this._activeUtteranceIndex = 0;
  }

  get sourceKind() {
    return 'synthetic';
  }

  _plannedMaxChunks() {
    if (this.totalChunks !== null) return this.totalChunks;
    if (this.utterances.length === 0) return 20;
    const last = this.utterances[this.utterances.length - 1];
    const maxEndMs = Math.max(last.endMs || 0, this.utterances.length * 1500);
    return Math.ceil((maxEndMs + this.chunkDurationMs) / this.chunkDurationMs);
  }

  _findUtteranceForWindow(startMs, endMs) {
    for (let i = 0; i < this.utterances.length; i += 1) {
      const u = this.utterances[i];
      if (endMs > u.startMs && startMs < u.endMs) {
        return { utterance: u, index: i };
      }
    }
    return null;
  }

  _buildNextChunk() {
    const seq = this._seq;
    const startMs = this._timelineMs;
    const endMs = startMs + this.chunkDurationMs;
    this._seq += 1;
    this._timelineMs = endMs;

    const match = this._findUtteranceForWindow(startMs, endMs);
    const activeSpeech =
      this.utterances.length > 0 ? Boolean(match) : seq % 25 < 20;
    const streamKind = match?.utterance?.channel || this.defaultStreamKind;
    const freq = streamKind === 'microphone' ? 290 : 210;

    const pcm = buildSyntheticPcm16({
      sampleRate: this.sampleRate,
      durationMs: this.chunkDurationMs,
      frequencyHz: freq,
      amplitude: activeSpeech ? 0.28 : 0,
      activeSpeech,
    });

    const chunk = validateAudioChunk({
      seq,
      streamKind,
      sourceId: `synthetic:${streamKind}`,
      sampleRate: this.sampleRate,
      channels: this.channels,
      encoding: this.encoding,
      startMs,
      endMs,
      durationMs: this.chunkDurationMs,
      pcm,
      rmsEnergy: activeSpeech ? 0.28 : 0,
      isSpeechLikely: activeSpeech,
      isSynthetic: true,
      syntheticCue: match ? { ...match.utterance, utteranceIndex: match.index } : null,
      capturedAtPerfMs: performance.now(),
    });

    return chunk;
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _scheduleNextTick(maxChunks) {
    if (!this._running || this._paused) return;
    if (this._seq >= maxChunks) {
      this._running = false;
      this.state = 'completed';
      this.emit('state', this.state);
      this.emit('end', { totalChunksEmitted: this._seq, timelineMs: this._timelineMs });
      return;
    }

    const emitOne = () => {
      if (!this._running || this._paused) return;
      try {
        const chunk = this._buildNextChunk();
        this.emit('chunk', chunk);
      } catch (err) {
        this.emit('error', err);
        this.stop();
        return;
      }
      this._scheduleNextTick(maxChunks);
    };

    if (this.paceMs === 0) {
      this._timer = setImmediate(emitOne);
    } else {
      this._timer = setTimeout(emitOne, this.paceMs);
    }
  }

  async start(signal) {
    if (this._running) return;
    this._running = true;
    this._paused = false;
    this._seq = 0;
    this._timelineMs = 0;
    this.state = 'running';
    this.emit('state', this.state);

    if (signal) {
      this._signal = signal;
      this._abortHandler = () => {
        this.stop();
      };
      if (signal.aborted) {
        await this.stop();
        return;
      }
      signal.addEventListener('abort', this._abortHandler, { once: true });
    }

    const maxChunks = this._plannedMaxChunks();
    this._scheduleNextTick(maxChunks);
  }

  async pause() {
    if (!this._running || this._paused) return;
    this._paused = true;
    this._clearTimer();
    this.state = 'paused';
    this.emit('state', this.state);
  }

  async resume() {
    if (!this._running || !this._paused) return;
    this._paused = false;
    this.state = 'running';
    this.emit('state', this.state);
    this._scheduleNextTick(this._plannedMaxChunks());
  }

  async stop() {
    this._running = false;
    this._paused = false;
    this._clearTimer();
    if (this._signal && this._abortHandler) {
      this._signal.removeEventListener('abort', this._abortHandler);
    }
    this._signal = null;
    this._abortHandler = null;
    if (this.state !== 'completed') {
      this.state = 'stopped';
      this.emit('state', this.state);
    }
  }
}

module.exports = {
  AudioStreamAdapter,
  SyntheticAudioStreamAdapter,
  validateAudioChunk,
  buildSyntheticPcm16,
  VALID_STREAM_KINDS,
};
