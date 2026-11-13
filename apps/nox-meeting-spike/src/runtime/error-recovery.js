'use strict';

const { EventEmitter } = require('node:events');

/**
 * Контроллер устойчивости ASR-потока:
 * отслеживает зависание провайдера (stall watchdog), разрыв соединения
 * и выполняет ограниченный перезапуск с повтором последнего окна аудио.
 */
class ErrorRecoverySupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxRestarts = Number.isInteger(options.maxRestarts) ? Math.max(0, options.maxRestarts) : 3;
    this.restartWindowMs = Number.isFinite(options.restartWindowMs) ? options.restartWindowMs : 30000;
    this.backoffBaseMs = Number.isFinite(options.backoffBaseMs) ? Math.max(0, options.backoffBaseMs) : 25;
    this.stallTimeoutMs = Number.isFinite(options.stallTimeoutMs) ? Math.max(20, options.stallTimeoutMs) : 3000;
    this.watchdogIntervalMs = Number.isFinite(options.watchdogIntervalMs) ? Math.max(10, options.watchdogIntervalMs) : 100;
    this.maxReplayChunks = Number.isInteger(options.maxReplayChunks) ? Math.max(0, options.maxReplayChunks) : 12;

    this._restartTimestamps = [];
    this._totalRestarts = 0;
    this._totalFailures = 0;
    this._exhausted = false;
    this._recovering = null;
    this._watchdogTimer = null;
    this._lastAudioSentAt = 0;
    this._lastProviderActivityAt = 0;
    this._awaitingResponse = false;
    this._replayBuffer = [];
  }

  get isExhausted() {
    return this._exhausted;
  }

  get isRecovering() {
    return Boolean(this._recovering);
  }

  recordChunkDispatched(chunk) {
    this._lastAudioSentAt = Date.now();
    if (!this._awaitingResponse) {
      this._awaitingResponse = true;
      this._lastProviderActivityAt = this._lastAudioSentAt;
    }
    if (this.maxReplayChunks > 0 && chunk) {
      this._replayBuffer.push(chunk);
      if (this._replayBuffer.length > this.maxReplayChunks) {
        this._replayBuffer.shift();
      }
    }
  }

  recordProviderActivity() {
    this._lastProviderActivityAt = Date.now();
    this._awaitingResponse = false;
  }

  getReplayChunks() {
    return this._replayBuffer.slice();
  }

  startWatchdog(onStall, cancellation) {
    this.stopWatchdog();
    const tick = () => {
      if (cancellation?.isCancelled || this._recovering || this._exhausted) return;
      if (!this._awaitingResponse) return;
      const now = Date.now();
      const idleMs = now - this._lastProviderActivityAt;
      if (idleMs >= this.stallTimeoutMs) {
        this._awaitingResponse = false;
        const err = new Error(`ASR-провайдер не отвечает более ${this.stallTimeoutMs} мс`);
        err.code = 'ASR_STALL_TIMEOUT';
        onStall(err);
      }
    };
    this._cancellation = cancellation || null;
    this._watchdogTimer = this._cancellation
      ? this._cancellation.setInterval(tick, this.watchdogIntervalMs)
      : setInterval(tick, this.watchdogIntervalMs);
  }

  stopWatchdog() {
    if (this._watchdogTimer) {
      if (this._cancellation) {
        this._cancellation.clearTimer(this._watchdogTimer);
      } else {
        clearInterval(this._watchdogTimer);
      }
      this._watchdogTimer = null;
    }
    this._cancellation = null;
  }

  _pruneWindow(now) {
    this._restartTimestamps = this._restartTimestamps.filter((ts) => now - ts <= this.restartWindowMs);
  }

  /**
   * Пытается восстановить провайдер в пределах квоты перезапусков.
   */
  async handleFailure(error, { cancellation, restartFn }) {
    if (cancellation?.isCancelled) {
      return { recovered: false, reason: 'cancelled' };
    }
    if (this._recovering) {
      return this._recovering;
    }

    this._totalFailures += 1;
    const now = Date.now();
    this._pruneWindow(now);

    if (this._restartTimestamps.length >= this.maxRestarts) {
      this._exhausted = true;
      this.stopWatchdog();
      const exhaustion = {
        recovered: false,
        exhausted: true,
        totalFailures: this._totalFailures,
        totalRestarts: this._totalRestarts,
        errorMessage: error?.message || String(error),
        errorCode: error?.code || 'ASR_FAILURE',
      };
      this.emit('exhausted', exhaustion);
      return exhaustion;
    }

    const attempt = this._restartTimestamps.length + 1;
    this._restartTimestamps.push(now);
    this._totalRestarts += 1;
    const backoffMs = this.backoffBaseMs * attempt;

    this._recovering = (async () => {
      this.emit('recovery_started', {
        attempt,
        maxRestarts: this.maxRestarts,
        backoffMs,
        reason: error?.message || String(error),
        code: error?.code || 'ASR_FAILURE',
      });

      try {
        if (backoffMs > 0 && !cancellation?.isCancelled) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
        if (cancellation?.isCancelled) {
          return { recovered: false, reason: 'cancelled' };
        }
        await restartFn({ attempt, replayChunks: this.getReplayChunks() });
        this._lastProviderActivityAt = Date.now();
        this._awaitingResponse = false;

        const result = {
          recovered: true,
          attempt,
          replayedChunks: this._replayBuffer.length,
        };
        this.emit('recovery_succeeded', result);
        return result;
      } catch (restartErr) {
        const result = {
          recovered: false,
          attempt,
          errorMessage: restartErr?.message || String(restartErr),
        };
        this.emit('recovery_failed', result);
        return result;
      } finally {
        this._recovering = null;
      }
    })();

    return this._recovering;
  }

  clear() {
    this.stopWatchdog();
    this._replayBuffer = [];
    this._awaitingResponse = false;
  }

  getMetrics() {
    return {
      maxRestarts: this.maxRestarts,
      totalRestarts: this._totalRestarts,
      totalFailures: this._totalFailures,
      exhausted: this._exhausted,
      recovering: Boolean(this._recovering),
      replayBufferSize: this._replayBuffer.length,
    };
  }
}

module.exports = {
  ErrorRecoverySupervisor,
};
