'use strict';

const { EventEmitter } = require('node:events');

/**
 * Надёжное управление отменой сессии: AbortSignal, ограниченный таймаут завершения,
 * очистка таймеров и освобождение буферов без зависших промисов.
 */
class CancellationController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.stopGraceMs = Number.isFinite(options.stopGraceMs) ? Math.max(10, options.stopGraceMs) : 500;
    this._abortController = new AbortController();
    this._disposers = new Set();
    this._timers = new Set();
    this._cancelPromise = null;
    this._cancelledAt = null;
    this._reason = null;
  }

  get signal() {
    return this._abortController.signal;
  }

  get isCancelled() {
    return this._abortController.signal.aborted;
  }

  get reason() {
    return this._reason;
  }

  get activeTimerCount() {
    return this._timers.size;
  }

  registerDisposer(fn) {
    if (typeof fn !== 'function') return () => {};
    this._disposers.add(fn);
    return () => this._disposers.delete(fn);
  }

  setTimeout(fn, delayMs) {
    if (this.isCancelled) return null;
    const handle = setTimeout(() => {
      this._timers.delete(handle);
      if (!this.isCancelled) fn();
    }, delayMs);
    this._timers.add(handle);
    return handle;
  }

  setInterval(fn, intervalMs) {
    if (this.isCancelled) return null;
    const handle = setInterval(() => {
      if (!this.isCancelled) fn();
    }, intervalMs);
    this._timers.add(handle);
    return handle;
  }

  clearTimer(handle) {
    if (!handle) return;
    clearTimeout(handle);
    clearInterval(handle);
    this._timers.delete(handle);
  }

  clearAllTimers() {
    for (const handle of this._timers) {
      clearTimeout(handle);
      clearInterval(handle);
    }
    this._timers.clear();
  }

  /**
   * Запускает остановку всех ресурсов и ограничивает ожидание закрытия таймаутом stopGraceMs.
   */
  async cancel(reason = 'user_cancelled', { shutdownTask = null, stopGraceMs = this.stopGraceMs } = {}) {
    if (this._cancelPromise) {
      return this._cancelPromise;
    }

    this._reason = reason;
    this._cancelledAt = new Date().toISOString();
    this._abortController.abort(reason);
    this.clearAllTimers();

    this._cancelPromise = (async () => {
      let forcedTimeout = false;
      const errors = [];

      if (typeof shutdownTask === 'function') {
        let graceTimer = null;
        try {
          await Promise.race([
            Promise.resolve().then(() => shutdownTask()),
            new Promise((resolve) => {
              graceTimer = setTimeout(() => {
                forcedTimeout = true;
                resolve();
              }, stopGraceMs);
            }),
          ]);
        } catch (err) {
          errors.push(err);
        } finally {
          if (graceTimer) clearTimeout(graceTimer);
        }
      }

      const disposers = Array.from(this._disposers);
      this._disposers.clear();
      const results = await Promise.allSettled(disposers.map((fn) => Promise.resolve().then(() => fn(reason))));
      for (const res of results) {
        if (res.status === 'rejected') {
          errors.push(res.reason);
        }
      }

      this.clearAllTimers();
      const report = {
        cancelled: true,
        reason,
        cancelledAt: this._cancelledAt,
        forcedTimeout,
        remainingTimers: this._timers.size,
        disposerErrors: errors.map((e) => (e && e.message) || String(e)),
      };
      this.emit('cancelled', report);
      return report;
    })();

    return this._cancelPromise;
  }
}

module.exports = {
  CancellationController,
};
