'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const { PrivacyController, StorageWriteError } = require('../privacy/privacy-controller');
const { IsolatedSessionStore } = require('../storage/session-store');
const { validateAudioChunk } = require('../audio/audio-stream-adapter');
const { BackpressureQueue } = require('../runtime/backpressure');
const { CancellationController } = require('../runtime/cancellation');
const { ErrorRecoverySupervisor } = require('../runtime/error-recovery');
const { TranscriptAssembler } = require('../transcript/transcript-assembler');
const { SpeakerTimeline } = require('../timeline/speaker-timeline');
const { MeetingSummaryGenerator } = require('../summary/meeting-summary');

function summarizeLatencySamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { count: 0, minMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pct = (q) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
    return Number(sorted[idx].toFixed(4));
  };
  return {
    count: sorted.length,
    minMs: Number(sorted[0].toFixed(4)),
    avgMs: Number((sum / sorted.length).toFixed(4)),
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    p99Ms: pct(0.99),
    maxMs: Number(sorted[sorted.length - 1].toFixed(4)),
  };
}

class BoundedLatencyRecorder {
  constructor(maxSamples = 5000) {
    this.maxSamples = maxSamples;
    this.samples = [];
  }

  record(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (this.samples.length >= this.maxSamples) {
      this.samples.shift();
    }
    this.samples.push(ms);
  }

  summarize() {
    return summarizeLatencySamples(this.samples);
  }

  clear() {
    this.samples = [];
  }
}

/**
 * Центральный координатор сессии C7: связывает согласие, источник звука, backpressure,
 * потоковый ASR, сборку расшифровки, шкалу спикеров, устойчивость, отмену и конспект.
 */
class SessionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId || `c7-${crypto.randomBytes(4).toString('hex')}`;
    this.privacy = options.privacy || new PrivacyController();
    this.store = options.store || new IsolatedSessionStore();
    this.assembler = options.assembler || new TranscriptAssembler(options.assemblerOptions);
    this.timeline = options.timeline || new SpeakerTimeline(options.timelineOptions);
    this.summaryGenerator = options.summaryGenerator || new MeetingSummaryGenerator(options.summaryOptions);
    this.queue = options.queue || new BackpressureQueue(options.queueOptions);
    this.recovery = options.recovery || new ErrorRecoverySupervisor(options.recoveryOptions);
    this.stopGraceMs = Number.isFinite(options.stopGraceMs) ? options.stopGraceMs : 500;
    this.autoFinishOnStreamEnd = Boolean(options.autoFinishOnStreamEnd);

    this._adapter = options.adapter || null;
    this._providerFactory =
      typeof options.providerFactory === 'function'
        ? options.providerFactory
        : () => options.provider;
    this._provider = null;

    this._state = 'idle';
    this._startedAt = null;
    this._endedAt = null;
    this._chunksReceived = 0;
    this._chunksProcessed = 0;
    this._lastError = null;
    this._persistence = { saved: false, mode: 'none', error: null, files: [] };
    this._summary = null;
    this._summaryMarkdown = '';
    this._cancellation = null;
    this._revokeUnsub = null;
    this._pauseIntervals = [];
    this._activePauseStart = null;
    this._streamEnded = false;

    this._pumpRunning = false;
    this._pumpWake = null;
    this._pumpIdleResolvers = [];

    this._adapterListeners = [];
    this._providerListeners = [];

    this._latency = {
      ingest: new BoundedLatencyRecorder(),
      assembly: new BoundedLatencyRecorder(),
      totalOverhead: new BoundedLatencyRecorder(),
      simulatedAsr: new BoundedLatencyRecorder(),
      summaryMs: 0,
    };

    this._wireInternalTelemetry();
  }

  get state() {
    return this._state;
  }

  _wireInternalTelemetry() {
    this.queue.on('backpressure', (info) => {
      this.emit('backpressure', info);
    });
    this.queue.on('pressure_change', (info) => {
      this.emit('pressure_change', info);
    });
    this.recovery.on('recovery_started', (info) => {
      this.emit('recovery', { phase: 'restarting', ...info });
    });
    this.recovery.on('recovery_succeeded', (info) => {
      this.emit('recovery', { phase: 'recovered', ...info });
    });
    this.recovery.on('recovery_failed', (info) => {
      this.emit('recovery', { phase: 'failed', ...info });
    });
    this.recovery.on('exhausted', (info) => {
      this._handleExhaustedRecovery(info);
    });
  }

  _emitErrorSafe(payload) {
    this.emit('session_error', payload);
    if (this.listenerCount('error') > 0) {
      this.emit('error', payload);
    }
  }

  _setState(nextState, extra = {}) {
    const previous = this._state;
    if (previous === nextState && Object.keys(extra).length === 0) return;
    this._state = nextState;
    this.emit('state_change', {
      sessionId: this.sessionId,
      previous,
      state: nextState,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }

  _detachAdapterListeners() {
    for (const { target, event, fn } of this._adapterListeners) {
      target.removeListener(event, fn);
    }
    this._adapterListeners = [];
  }

  _detachProviderListeners() {
    for (const { target, event, fn } of this._providerListeners) {
      target.removeListener(event, fn);
    }
    this._providerListeners = [];
  }

  _bindAdapter(adapter) {
    this._detachAdapterListeners();
    const onChunk = (chunk) => this._onAdapterChunk(chunk);
    const onError = (err) => this._onAdapterError(err);
    const onEnd = (info) => this._onAdapterEnd(info);

    adapter.on('chunk', onChunk);
    adapter.on('error', onError);
    adapter.on('end', onEnd);

    this._adapterListeners.push(
      { target: adapter, event: 'chunk', fn: onChunk },
      { target: adapter, event: 'error', fn: onError },
      { target: adapter, event: 'end', fn: onEnd }
    );
  }

  _bindProvider(provider) {
    this._detachProviderListeners();
    const onPartial = (ev) => this._onAsrEvent(ev, false);
    const onFinal = (ev) => this._onAsrEvent(ev, true);
    const onError = (err) => this._onProviderError(err);
    const onStatus = (st) => this.emit('provider_status', st);

    provider.on('partial', onPartial);
    provider.on('final', onFinal);
    provider.on('error', onError);
    provider.on('status', onStatus);

    this._providerListeners.push(
      { target: provider, event: 'partial', fn: onPartial },
      { target: provider, event: 'final', fn: onFinal },
      { target: provider, event: 'error', fn: onError },
      { target: provider, event: 'status', fn: onStatus }
    );
  }

  _onAdapterChunk(rawChunk) {
    if (this._state !== 'recording' || this._cancellation?.isCancelled) {
      return;
    }

    const t0 = performance.now();
    try {
      const chunk = validateAudioChunk(rawChunk);
      this._chunksReceived += 1;
      this.assembler.updateAudioWatermark(chunk.endMs);

      const enqueueResult = this.queue.enqueue(chunk);
      const t1 = performance.now();
      this._latency.ingest.record(t1 - t0);

      if (enqueueResult.accepted) {
        this.emit('audio_chunk', {
          seq: chunk.seq,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          streamKind: chunk.streamKind,
          isSpeechLikely: chunk.isSpeechLikely,
          queueDepth: this.queue.size,
          queueBytes: this.queue.bytes,
        });
        this._wakePump();
      }
    } catch (err) {
      this._lastError = { code: 'INVALID_AUDIO_CHUNK', message: err.message };
      this._emitErrorSafe(this._lastError);
    }
  }

  _onAdapterError(err) {
    if (this._cancellation?.isCancelled) return;
    this._lastError = { code: err?.code || 'ADAPTER_ERROR', message: err?.message || String(err) };
    this._emitErrorSafe(this._lastError);
  }

  _onAdapterEnd(info) {
    this._streamEnded = true;
    this.emit('stream_ended', info || {});
    if (this.autoFinishOnStreamEnd && (this._state === 'recording' || this._state === 'paused')) {
      void this.finish({ reason: 'stream_completed' });
    }
  }

  _onAsrEvent(rawEvent, isFinal) {
    const cancelled = Boolean(this._cancellation?.isCancelled);
    if (cancelled) {
      this.assembler.processEvent({ ...rawEvent, isFinal }, { cancelled: true });
      return;
    }

    this.recovery.recordProviderActivity();

    if (Number.isFinite(rawEvent?.simulatedAsrDelayMs)) {
      this._latency.simulatedAsr.record(rawEvent.simulatedAsrDelayMs);
    }

    const t0 = performance.now();
    const res = this.assembler.processEvent(
      { ...rawEvent, isFinal },
      { cancelled: false, audioWatermarkMs: this.assembler._audioWatermarkMs }
    );
    let timelineSnap = null;
    if (res.action === 'final_added') {
      timelineSnap = this.timeline.rebuild(res.snapshot.finals);
    }
    const t1 = performance.now();

    const assemblyCost = t1 - t0;
    this._latency.assembly.record(assemblyCost);
    const eventDeliveryMs = Number.isFinite(rawEvent?.emittedAtPerfMs)
      ? Math.max(0, t0 - rawEvent.emittedAtPerfMs)
      : 0;
    this._latency.totalOverhead.record(assemblyCost + eventDeliveryMs);

    if (res.action === 'partial_updated') {
      this.emit('partial_transcript', { partial: res.partial, snapshot: res.snapshot });
    } else if (res.action === 'final_added') {
      this.emit('final_transcript', {
        segment: res.segment,
        wasLate: res.wasLate,
        timestampRepaired: res.timestampRepaired,
        snapshot: res.snapshot,
        timeline: timelineSnap,
      });
      this.emit('timeline_updated', timelineSnap);
    }
  }

  _onProviderError(err) {
    if (this._cancellation?.isCancelled || this._state === 'stopping' || this._state === 'completed') {
      return;
    }
    this._lastError = {
      code: err?.code || 'ASR_PROVIDER_ERROR',
      message: err?.message || String(err),
    };
    this._emitErrorSafe({ ...this._lastError, recoverable: !this.recovery.isExhausted });
    void this._triggerRecovery(err);
  }

  async _triggerRecovery(err) {
    if (!this._cancellation || this._cancellation.isCancelled) return;
    if (this._state === 'stopping' || this._state === 'completed' || this._state === 'cancelled') return;

    const outcome = await this.recovery.handleFailure(err, {
      cancellation: this._cancellation,
      restartFn: async ({ attempt, replayChunks }) => {
        if (this._cancellation.isCancelled) return;
        const oldProvider = this._provider;
        this._detachProviderListeners();
        if (oldProvider) {
          try {
            oldProvider.abort();
          } catch {
            // Игнорируем ошибку принудительного закрытия сломанного провайдера.
          }
        }

        const nextProvider = this._providerFactory(attempt);
        if (!nextProvider) {
          throw new Error('Фабрика ASR-провайдеров не вернула экземпляр при восстановлении');
        }
        this._provider = nextProvider;
        this._bindProvider(nextProvider);
        await nextProvider.connect({ sessionId: this.sessionId, attempt }, this._cancellation.signal);

        for (const chunk of replayChunks) {
          if (this._cancellation.isCancelled) break;
          await nextProvider.pushAudio(chunk, this._cancellation.signal);
        }
      },
    });

    if (outcome?.recovered) {
      this._lastError = null;
      this._wakePump();
    }
  }

  async _handleExhaustedRecovery(info) {
    if (this._state === 'cancelled' || this._state === 'completed') return;
    this._lastError = {
      code: 'ASR_PROVIDER_EXHAUSTED',
      message: `Провайдер ASR не восстановился после ${info.totalRestarts} попыток: ${info.errorMessage}`,
    };
    this.recovery.stopWatchdog();
    try {
      if (this._adapter) await this._adapter.stop();
    } catch {
      // ignore
    }
    this._detachAdapterListeners();
    this._detachProviderListeners();
    try {
      if (this._provider) this._provider.abort();
    } catch {
      // ignore
    }
    this.queue.clear({ wipeBuffers: true });
    this._setState('error', { error: this._lastError });
    this._emitErrorSafe({ ...this._lastError, recoverable: false });
  }

  _wakePump() {
    if (this._pumpWake) {
      const wake = this._pumpWake;
      this._pumpWake = null;
      wake();
    }
    if (!this._pumpRunning && (this._state === 'recording' || this._state === 'stopping')) {
      void this._runPump();
    }
  }

  async _waitPumpIdle(timeoutMs = 300) {
    if (!this._pumpRunning && this.queue.size === 0) return;
    await Promise.race([
      new Promise((resolve) => {
        this._pumpIdleResolvers.push(resolve);
      }),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  _notifyPumpIdle() {
    const waiters = this._pumpIdleResolvers.splice(0, this._pumpIdleResolvers.length);
    for (const resolve of waiters) resolve();
  }

  async _runPump() {
    if (this._pumpRunning) return;
    this._pumpRunning = true;

    try {
      while (!this._cancellation?.isCancelled) {
        if (this._state === 'error' || this._state === 'cancelled' || this._state === 'completed') {
          break;
        }
        if (this._state === 'paused' || this.recovery.isRecovering) {
          await new Promise((resolve) => {
            this._pumpWake = resolve;
          });
          continue;
        }

        const chunk = this.queue.dequeue();
        if (!chunk) {
          if (this._state === 'stopping') break;
          this._notifyPumpIdle();
          await new Promise((resolve) => {
            this._pumpWake = resolve;
          });
          continue;
        }

        if (!this._provider || !this._provider.connected) {
          continue;
        }

        this.recovery.recordChunkDispatched(chunk);
        try {
          await this._provider.pushAudio(chunk, this._cancellation.signal);
          this._chunksProcessed += 1;
        } catch (err) {
          if (!this._cancellation?.isCancelled && this._state !== 'stopping') {
            await this._triggerRecovery(err);
          }
        } finally {
          if (Buffer.isBuffer(chunk.pcm)) {
            chunk.pcm.fill(0);
          }
        }
      }
    } finally {
      this._pumpRunning = false;
      this._notifyPumpIdle();
    }
  }

  /**
   * Запускает сессию после проверки явного согласия и запрета на доступ к микрофону/внешним API.
   */
  async start({ adapter, providerFactory, provider } = {}) {
    if (this._state !== 'idle') {
      throw new Error(`Нельзя запустить сессию из состояния "${this._state}"`);
    }

    const activeAdapter = adapter || this._adapter;
    if (!activeAdapter) {
      throw new Error('Не передан AudioStreamAdapter для запуска сессии');
    }

    this.privacy.assertExternalNetworkBlocked();
    this.privacy.assertCanCapture(activeAdapter.sourceKind);

    if (typeof providerFactory === 'function') {
      this._providerFactory = providerFactory;
    } else if (provider) {
      this._providerFactory = () => provider;
    }

    this._adapter = activeAdapter;
    this._provider = this._providerFactory(0);
    if (!this._provider) {
      throw new Error('Не передан ASRProvider для запуска сессии');
    }

    this._cancellation = new CancellationController({ stopGraceMs: this.stopGraceMs });
    this._cancellation.registerDisposer(() => {
      this.recovery.stopWatchdog();
      this._detachAdapterListeners();
      this._detachProviderListeners();
      this.queue.clear({ wipeBuffers: true });
      this.recovery.clear();
    });

    if (this._revokeUnsub) this._revokeUnsub();
    this._revokeUnsub = this.privacy.onRevoke(async (reason) => {
      await this.cancel(`privacy_${reason}`, { purgeMemory: true });
    });

    this._setState('starting');
    this._startedAt = new Date().toISOString();
    this._endedAt = null;
    this._lastError = null;
    this._streamEnded = false;
    this._summary = null;
    this._summaryMarkdown = '';
    this._persistence = {
      saved: false,
      mode: this.privacy.canPersist() ? 'pending_isolated' : 'memory_only',
      error: null,
      files: [],
    };

    this._bindAdapter(this._adapter);
    this._bindProvider(this._provider);

    try {
      await this._provider.connect({ sessionId: this.sessionId, attempt: 0 }, this._cancellation.signal);
      this.recovery.startWatchdog((stallErr) => {
        this._onProviderError(stallErr);
      }, this._cancellation);

      this._setState('recording');
      void this._runPump();
      await this._adapter.start(this._cancellation.signal);
      return this.getSnapshot();
    } catch (err) {
      await this.cancel('start_failed');
      this._lastError = { code: err?.code || 'START_FAILED', message: err?.message || String(err) };
      this._setState('error', { error: this._lastError });
      throw err;
    }
  }

  async pause() {
    if (this._state !== 'recording') {
      return this.getSnapshot();
    }
    this.recovery.stopWatchdog();
    this._activePauseStart = new Date().toISOString();
    if (this._adapter) {
      await this._adapter.pause();
    }
    this._setState('paused');
    this._wakePump();
    return this.getSnapshot();
  }

  async resume() {
    if (this._state !== 'paused') {
      return this.getSnapshot();
    }
    this.privacy.assertCanCapture(this._adapter.sourceKind);
    if (this._activePauseStart) {
      this._pauseIntervals.push({
        pausedAt: this._activePauseStart,
        resumedAt: new Date().toISOString(),
      });
      this._activePauseStart = null;
    }
    this._setState('recording');
    this.recovery.startWatchdog((stallErr) => {
      this._onProviderError(stallErr);
    }, this._cancellation);
    if (this._adapter) {
      await this._adapter.resume();
    }
    this._wakePump();
    return this.getSnapshot();
  }

  /**
   * Завершает сессию, собирает конспект и сохраняет итоги только при наличии storageConsent.
   */
  async finish({ reason = 'user_finished' } = {}) {
    if (this._state === 'completed' || this._state === 'cancelled') {
      return this.getSnapshot();
    }
    if (this._state === 'idle') {
      return this.getSnapshot();
    }

    const wasErrorState = this._state === 'error';
    if (!wasErrorState) {
      this._setState('stopping', { reason });
    }

    this.recovery.stopWatchdog();
    if (this._adapter) {
      try {
        await this._adapter.stop();
      } catch {
        // ignore
      }
    }

    this._wakePump();
    await this._waitPumpIdle(Math.min(this.stopGraceMs, 350));

    if (this._provider && !wasErrorState) {
      let graceTimer = null;
      try {
        await Promise.race([
          (async () => {
            await this._provider.flush();
            await this._provider.close();
          })(),
          new Promise((resolve) => {
            graceTimer = setTimeout(() => {
              try {
                this._provider.abort();
              } catch {
                // ignore
              }
              resolve();
            }, this.stopGraceMs);
          }),
        ]);
      } catch {
        try {
          this._provider.abort();
        } catch {
          // ignore
        }
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
      }
    }

    if (this._cancellation) {
      await this._cancellation.cancel(`finish:${reason}`);
    }

    this.assembler.clearPartials();
    const transcriptSnap = this.assembler.getSnapshot();
    const timelineSnap = this.timeline.rebuild(transcriptSnap.finals);
    const summaryResult = this.summaryGenerator.generate({
      sessionId: this.sessionId,
      finals: transcriptSnap.finals,
      timelineSnapshot: timelineSnap,
      assemblerStats: transcriptSnap.stats,
      isSynthetic: true,
      interrupted: wasErrorState,
    });

    this._summary = summaryResult.summary;
    this._summaryMarkdown = summaryResult.markdown;
    this._latency.summaryMs = summaryResult.summary.meta.generationMs;
    this._endedAt = new Date().toISOString();

    if (this.privacy.canPersist()) {
      try {
        const saved = this.store.saveSession(this.sessionId, {
          status: wasErrorState ? 'completed_with_errors' : 'completed',
          startedAt: this._startedAt,
          endedAt: this._endedAt,
          privacyPolicy: this.privacy.getPolicySnapshot(),
          transcript: transcriptSnap.finals,
          timeline: timelineSnap,
          summary: this._summary,
          summaryMarkdown: this._summaryMarkdown,
          metrics: this.getMetrics(),
        });
        this._persistence = {
          saved: true,
          mode: 'isolated_local_only',
          error: null,
          files: saved.files,
        };
      } catch (err) {
        const writeErr =
          err instanceof StorageWriteError
            ? err
            : new StorageWriteError(err?.message || String(err), { sessionId: this.sessionId });
        this._persistence = {
          saved: false,
          mode: 'save_failed',
          error: { code: writeErr.code, message: writeErr.message },
          files: [],
        };
        this._lastError = { code: writeErr.code, message: writeErr.message };
        this.emit('storage_error', this._persistence.error);
        this._emitErrorSafe({ ...this._lastError, recoverable: false });
      }
    } else {
      this._persistence = {
        saved: false,
        mode: 'memory_only_no_storage_consent',
        error: null,
        files: [],
      };
    }

    this._setState(wasErrorState ? 'error' : 'completed', { reason });
    this.emit('summary_ready', {
      sessionId: this.sessionId,
      summary: this._summary,
      markdown: this._summaryMarkdown,
      persistence: this._persistence,
    });

    return this.getSnapshot();
  }

  /**
   * Надёжная экстренная остановка посреди обработки с гарантированной очисткой таймеров и буферов.
   */
  async cancel(reason = 'user_cancelled', { purgeMemory = false } = {}) {
    if (this._state === 'cancelled') {
      if (purgeMemory) this._purgeInMemoryData();
      return this.getSnapshot();
    }

    this._setState('stopping', { reason, cancelling: true });
    this.recovery.stopWatchdog();

    if (this._adapter) {
      try {
        await this._adapter.stop();
      } catch {
        // ignore
      }
    }

    const cancelReport = this._cancellation
      ? await this._cancellation.cancel(reason, {
          stopGraceMs: this.stopGraceMs,
          shutdownTask: async () => {
            if (this._provider) {
              try {
                this._provider.abort();
                await this._provider.close();
              } catch {
                // ignore
              }
            }
          },
        })
      : { cancelled: true, reason, forcedTimeout: false, remainingTimers: 0 };

    this._wakePump();
    await this._waitPumpIdle(100);

    this.assembler.clearPartials();
    this._endedAt = new Date().toISOString();

    if (purgeMemory) {
      this._purgeInMemoryData();
    } else {
      const finals = this.assembler.getFinals();
      const timelineSnap = this.timeline.rebuild(finals);
      const summaryResult = this.summaryGenerator.generate({
        sessionId: this.sessionId,
        finals,
        timelineSnapshot: timelineSnap,
        assemblerStats: this.assembler.getStats(),
        isSynthetic: true,
        interrupted: true,
      });
      this._summary = summaryResult.summary;
      this._summaryMarkdown = summaryResult.markdown;
    }

    this._persistence = {
      saved: false,
      mode: purgeMemory ? 'purged' : 'cancelled_not_saved',
      error: null,
      files: [],
    };

    this._setState('cancelled', { reason, cancelReport });
    return { ...this.getSnapshot(), cancelReport };
  }

  _purgeInMemoryData() {
    this.assembler.reset();
    this.timeline.reset();
    this.queue.clear({ wipeBuffers: true });
    this.recovery.clear();
    this._summary = null;
    this._summaryMarkdown = '';
    this._pauseIntervals = [];
    this._activePauseStart = null;
  }

  /**
   * Полное удаление тестовой сессии: остановка, очистка памяти и удаление файлов с диска.
   */
  async deleteSession() {
    if (this._state === 'recording' || this._state === 'paused' || this._state === 'starting') {
      await this.cancel('session_deleted', { purgeMemory: true });
    }
    const diskResult = this.store.deleteSession(this.sessionId);
    this._purgeInMemoryData();
    this._chunksReceived = 0;
    this._chunksProcessed = 0;
    this._startedAt = null;
    this._endedAt = null;
    this._lastError = null;
    this._persistence = { saved: false, mode: 'deleted', error: null, files: [] };
    this._setState('idle', { deleted: true });
    this.emit('session_deleted', { sessionId: this.sessionId, ...diskResult });
    return { sessionId: this.sessionId, ...diskResult, state: this._state };
  }

  getMetrics() {
    return {
      sessionId: this.sessionId,
      state: this._state,
      chunksReceived: this._chunksReceived,
      chunksProcessed: this._chunksProcessed,
      backpressure: this.queue.getMetrics(),
      assembler: this.assembler.getStats(),
      recovery: this.recovery.getMetrics(),
      activeTimers: this._cancellation ? this._cancellation.activeTimerCount : 0,
      latency: {
        note: 'Внутренняя задержка конвейера отделена от фиктивного времени распознавания (isSynthetic: true)',
        pipelineIngestMs: this._latency.ingest.summarize(),
        pipelineAssemblyMs: this._latency.assembly.summarize(),
        pipelineOverheadMs: this._latency.totalOverhead.summarize(),
        simulatedAsrDelayMs: {
          isSynthetic: true,
          ...this._latency.simulatedAsr.summarize(),
        },
        summaryGenerationMs: this._latency.summaryMs,
      },
    };
  }

  getSnapshot() {
    const transcript = this.assembler.getSnapshot();
    const timeline = this.timeline.getSnapshot();
    return {
      sessionId: this.sessionId,
      state: this._state,
      isRecording: this._state === 'recording',
      startedAt: this._startedAt,
      endedAt: this._endedAt,
      privacy: this.privacy.getPolicySnapshot(),
      transcript,
      timeline,
      summary: this._summary,
      summaryMarkdown: this._summaryMarkdown,
      persistence: this._persistence,
      lastError: this._lastError,
      metrics: this.getMetrics(),
      honesty: {
        isSyntheticOnly: true,
        realMicrophoneActive: false,
        realSystemAudioActive: false,
        realAsrModelLoaded: false,
      },
    };
  }
}

module.exports = {
  SessionManager,
  summarizeLatencySamples,
};
