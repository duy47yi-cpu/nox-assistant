'use strict';

const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');

/**
 * Базовый контракт потокового распознавания речи для C7.
 * Не привязан к конкретному движку (faster-whisper, whisper.cpp, sherpa-onnx и др.).
 */
class ASRProvider extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name || 'abstract-asr';
    this.connected = false;
  }

  async connect() {
    this.connected = true;
    this.emit('status', { status: 'connected', provider: this.name });
  }

  async pushAudio() {
    throw new Error('ASRProvider.pushAudio() должен быть реализован в наследнике');
  }

  async flush() {}

  async close() {
    this.connected = false;
    this.emit('status', { status: 'closed', provider: this.name });
  }

  abort() {
    this.connected = false;
    this.emit('status', { status: 'aborted', provider: this.name });
  }
}

/**
 * Фиктивный потоковый ASR-провайдер на синтетических данных.
 * Имитирует частичные гипотезы, финальные сегменты, а также сбои, задержки, дубли и битые метки времени для тестов.
 * НЕ является реальным распознаванием речи.
 */
class SyntheticASRProvider extends ASRProvider {
  constructor(options = {}) {
    super({ name: options.name || 'synthetic-asr-mock' });
    this.simulatedDelayMs = Number.isFinite(options.simulatedDelayMs) ? Math.max(0, options.simulatedDelayMs) : 0;
    this.hangOnCloseMs = Number.isFinite(options.hangOnCloseMs) ? Math.max(0, options.hangOnCloseMs) : 0;
    this.hangOnChunkSeq = Number.isInteger(options.hangOnChunkSeq) ? options.hangOnChunkSeq : null;
    this.failAtPushCount = Number.isInteger(options.failAtPushCount) ? options.failAtPushCount : null;
    this.failTimes = Number.isInteger(options.failTimes) ? options.failTimes : 1;
    this.emitDuplicates = Boolean(options.emitDuplicates);
    this.emitLateResult = Boolean(options.emitLateResult);
    this.emitBadTimestamps = Boolean(options.emitBadTimestamps);
    this.chunksPerFinal = Number.isInteger(options.chunksPerFinal) ? Math.max(1, options.chunksPerFinal) : 5;
    this.autoSyntheticText = options.autoSyntheticText !== false;

    this._pushCount = 0;
    this._failuresTriggered = 0;
    this._pendingTimers = new Map();
    this._activeUtterances = new Map();
    this._finalizedIds = new Set();
    this._delayedOutOfOrderQueue = [];
    this._windowChunks = [];
    this._autoSeq = 0;
    this._aborted = false;
  }

  _trackTimer(fn, delayMs) {
    if (this._aborted) return null;
    if (delayMs <= 0) {
      fn();
      return null;
    }
    const entry = { fn };
    const timer = setTimeout(() => {
      this._pendingTimers.delete(timer);
      if (!this._aborted) fn();
    }, delayMs);
    this._pendingTimers.set(timer, entry);
    return timer;
  }

  _flushPendingTimers() {
    const entries = Array.from(this._pendingTimers.entries());
    this._pendingTimers.clear();
    for (const [timer, entry] of entries) {
      clearTimeout(timer);
      if (!this._aborted && typeof entry?.fn === 'function') {
        entry.fn();
      }
    }
  }

  _clearTimers() {
    for (const timer of this._pendingTimers.keys()) {
      clearTimeout(timer);
    }
    this._pendingTimers.clear();
  }

  async connect(sessionConfig = {}, signal) {
    this._aborted = false;
    if (signal?.aborted) {
      throw new Error('Подключение ASR отменено до старта');
    }
    if (this.simulatedDelayMs > 0) {
      await new Promise((resolve) => this._trackTimer(resolve, Math.min(this.simulatedDelayMs, 25)));
    }
    this.connected = true;
    this.emit('status', {
      status: 'connected',
      provider: this.name,
      isSynthetic: true,
      language: sessionConfig.language || 'ru',
    });
  }

  _emitPartial(utterance, chunk) {
    const words = String(utterance.text || '').trim().split(/\s+/).filter(Boolean);
    const totalSpan = Math.max(1, utterance.endMs - utterance.startMs);
    const progress = Math.min(1, Math.max(0.15, (chunk.endMs - utterance.startMs) / totalSpan));
    const visibleWords = Math.max(1, Math.ceil(words.length * progress));
    const partialText = words.slice(0, visibleWords).join(' ');

    const payload = {
      utteranceId: utterance.id,
      revision: (this._activeUtterances.get(utterance.id)?.revision || 0) + 1,
      isFinal: false,
      text: partialText,
      startMs: utterance.startMs,
      endMs: Math.min(utterance.endMs, chunk.endMs),
      channel: utterance.channel || chunk.streamKind,
      speakerHint: utterance.speakerHint || null,
      confidence: 0.72,
      isSynthetic: true,
      simulatedAsrDelayMs: this.simulatedDelayMs,
      emittedAtPerfMs: performance.now(),
    };

    this._activeUtterances.set(utterance.id, { utterance, revision: payload.revision });
    this.emit('partial', payload);
  }

  _emitFinalFromUtterance(utterance, channel, opts = {}) {
    let startMs = utterance.startMs;
    let endMs = utterance.endMs;
    if (opts.corruptTimestamps) {
      startMs = -420;
      endMs = -900;
    }

    const finalPayload = {
      utteranceId: utterance.id,
      revision: (this._activeUtterances.get(utterance.id)?.revision || 0) + 1,
      isFinal: true,
      text: utterance.text,
      startMs,
      endMs,
      channel: utterance.channel || channel || 'system_loopback',
      speakerHint: utterance.speakerHint || null,
      confidence: utterance.confidence ?? 0.94,
      isSynthetic: true,
      simulatedAsrDelayMs: this.simulatedDelayMs,
      emittedAtPerfMs: performance.now(),
    };

    this._finalizedIds.add(utterance.id);
    this._activeUtterances.delete(utterance.id);
    this.emit('final', finalPayload);

    if (opts.duplicate) {
      // Имитация повторного прихода того же сегмента (например, при перекрытии окна ASR).
      this.emit('final', { ...finalPayload });
      this.emit('final', {
        ...finalPayload,
        utteranceId: `${utterance.id}-replay`,
        revision: 1,
      });
    }
  }

  _emitUtteranceComplete(utterance, chunk) {
    if (this._finalizedIds.has(utterance.id)) return;

    if (this.emitLateResult && utterance.id === 'u1' && this._delayedOutOfOrderQueue.length === 0) {
      this._delayedOutOfOrderQueue.push({ utterance, channel: chunk.streamKind });
      this._finalizedIds.add(utterance.id);
      this._activeUtterances.delete(utterance.id);
      return;
    }

    const shouldCorrupt = this.emitBadTimestamps && (utterance.id === 'u2' || this._autoSeq === 1);
    const shouldDuplicate = this.emitDuplicates && (utterance.id === 'u1' || this._autoSeq === 0);

    this._emitFinalFromUtterance(utterance, chunk.streamKind, {
      corruptTimestamps: shouldCorrupt,
      duplicate: shouldDuplicate,
    });

    if (this._delayedOutOfOrderQueue.length > 0) {
      const delayed = this._delayedOutOfOrderQueue.shift();
      this._trackTimer(() => {
        this._emitFinalFromUtterance(delayed.utterance, delayed.channel);
      }, Math.max(5, this.simulatedDelayMs));
    }
  }

  async pushAudio(chunk, signal) {
    if (this._aborted || signal?.aborted) {
      return { accepted: false, reason: 'aborted' };
    }
    if (!this.connected) {
      throw new Error('ASR-провайдер не подключён');
    }

    this._pushCount += 1;

    if (this.hangOnChunkSeq !== null && chunk.seq >= this.hangOnChunkSeq) {
      // Имитируем зависание провайдера без ответов до отмены/перезапуска.
      return { accepted: true, stalled: true };
    }

    if (
      this.failAtPushCount !== null &&
      this._pushCount >= this.failAtPushCount &&
      this._failuresTriggered < this.failTimes
    ) {
      this._failuresTriggered += 1;
      const err = new Error(`Синтетический сбой потока ASR на фрагменте #${chunk.seq}`);
      err.code = 'ASR_STREAM_DROPPED';
      err.retryable = true;
      this.emit('error', err);
      throw err;
    }

    const work = () => {
      if (this._aborted || signal?.aborted) return;

      const cue = chunk.syntheticCue;
      if (cue) {
        if (!this._finalizedIds.has(cue.id)) {
          this._emitPartial(cue, chunk);
          if (chunk.endMs >= cue.endMs) {
            this._emitUtteranceComplete(cue, chunk);
          }
        }
        return;
      }

      if (!this.autoSyntheticText || chunk.isSpeechLikely === false) return;

      this._windowChunks.push(chunk);
      if (this._windowChunks.length < this.chunksPerFinal) {
        const partialId = `auto-${this._autoSeq}`;
        const first = this._windowChunks[0];
        this.emit('partial', {
          utteranceId: partialId,
          revision: this._windowChunks.length,
          isFinal: false,
          text: `Синтетическая реплика ${this._autoSeq + 1}`,
          startMs: first.startMs,
          endMs: chunk.endMs,
          channel: chunk.streamKind,
          speakerHint: chunk.streamKind === 'microphone' ? 'local:mic' : 'remote:S1',
          confidence: 0.7,
          isSynthetic: true,
          simulatedAsrDelayMs: this.simulatedDelayMs,
          emittedAtPerfMs: performance.now(),
        });
        return;
      }

      const first = this._windowChunks[0];
      const last = this._windowChunks[this._windowChunks.length - 1];
      this._windowChunks = [];
      const uttId = `auto-${this._autoSeq}`;
      this._autoSeq += 1;
      const utterance = {
        id: uttId,
        text: `Синтетическая реплика ${this._autoSeq}: фрагменты ${first.seq}-${last.seq}.`,
        startMs: first.startMs,
        endMs: last.endMs,
        channel: last.streamKind,
        speakerHint: last.streamKind === 'microphone' ? 'local:mic' : 'remote:S1',
      };
      this._emitFinalFromUtterance(utterance, last.streamKind, {
        corruptTimestamps: this.emitBadTimestamps && this._autoSeq === 2,
        duplicate: this.emitDuplicates && this._autoSeq === 1,
      });
    };

    if (this.simulatedDelayMs > 0) {
      this._trackTimer(work, this.simulatedDelayMs);
    } else {
      work();
    }

    return { accepted: true, stalled: false };
  }

  async flush() {
    if (this._aborted) return;

    this._flushPendingTimers();

    while (this._delayedOutOfOrderQueue.length > 0) {
      const delayed = this._delayedOutOfOrderQueue.shift();
      this._emitFinalFromUtterance(delayed.utterance, delayed.channel);
    }

    if (this._windowChunks.length > 0 && this.autoSyntheticText) {
      const first = this._windowChunks[0];
      const last = this._windowChunks[this._windowChunks.length - 1];
      this._windowChunks = [];
      const uttId = `auto-${this._autoSeq}`;
      this._autoSeq += 1;
      this._emitFinalFromUtterance(
        {
          id: uttId,
          text: `Синтетическая реплика ${this._autoSeq}: фрагменты ${first.seq}-${last.seq}.`,
          startMs: first.startMs,
          endMs: last.endMs,
          channel: last.streamKind,
          speakerHint: last.streamKind === 'microphone' ? 'local:mic' : 'remote:S1',
        },
        last.streamKind
      );
    }

    for (const [id, entry] of this._activeUtterances.entries()) {
      if (!this._finalizedIds.has(id)) {
        this._emitFinalFromUtterance(entry.utterance, entry.utterance.channel);
      }
    }
  }

  async close() {
    this._clearTimers();
    if (this.hangOnCloseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.hangOnCloseMs));
    }
    this.connected = false;
    this.emit('status', { status: 'closed', provider: this.name });
  }

  abort() {
    this._aborted = true;
    this._clearTimers();
    this._activeUtterances.clear();
    this._windowChunks = [];
    this._delayedOutOfOrderQueue = [];
    this.connected = false;
    this.emit('status', { status: 'aborted', provider: this.name });
  }
}

module.exports = {
  ASRProvider,
  SyntheticASRProvider,
};
