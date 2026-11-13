'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const { ASRProvider } = require('./asr-provider');
const { ModelStore } = require('../models/model-store');
const { pcm16leToFloat32 } = require('./pcm-utils');
const {
  loadSherpaOnnx,
  resolveWorkerRuntimeExecutable,
} = require('./sherpa-loader');
const { SherpaStreamingEngine } = require('./sherpa-streaming-engine');

const DEFAULT_WORKER_SCRIPT = path.join(__dirname, 'real-asr-worker.js');

class AsrBackpressureError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AsrBackpressureError';
    this.code = 'ASR_BACKPRESSURE_LIMIT';
    this.details = details;
  }
}

class AsrTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AsrTimeoutError';
    this.code = 'ASR_DECODE_TIMEOUT';
    this.details = details;
  }
}

class AsrMemoryLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ASR_MEMORY_LIMIT_EXCEEDED';
    this.code = 'ASR_MEMORY_LIMIT_EXCEEDED';
    this.details = details;
  }
}

function createAbortError(message = 'Operation aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

function copyPcmBytes(pcm) {
  if (Buffer.isBuffer(pcm)) {
    return Buffer.from(pcm);
  }
  if (pcm instanceof Uint8Array || pcm instanceof Int16Array) {
    return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  }
  throw new TypeError('RealASRProvider.pushAudio expects Buffer, Uint8Array, or Int16Array chunk.pcm');
}

/**
 * Production-structured real streaming ASR adapter over sherpa-onnx implementing ASRProvider.
 * Supports:
 * - 'worker' mode (default for native runtime): isolated child process over stdio NDJSON
 *   so synchronous C++/ONNX work and crashes stay out of Electron Main Process.
 * - 'inline' mode (for deterministic contract tests with injected binding or direct CLI bench).
 *
 * Strictly zero-network at runtime: refuses missing local weights instead of downloading.
 */
class RealASRProvider extends ASRProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'real-sherpa-onnx',
      ...options,
    });

    this._mode = options.mode || (options.binding ? 'inline' : 'worker');
    if (this._mode !== 'inline' && this._mode !== 'worker') {
      throw new TypeError(`Invalid RealASRProvider mode '${this._mode}'; expected 'inline' or 'worker'`);
    }

    this._modelId = options.modelId || 'ru-zipformer-vosk-int8';
    this._modelDir = options.modelDir || null;
    this._modelStore = options.modelStore || new ModelStore(options.modelStoreOptions || {});
    this._binding = options.binding || null;
    this._loaderOptions = options.loaderOptions || {};
    this._workerScript = options.workerScript || DEFAULT_WORKER_SCRIPT;
    this._workerExecPath = options.workerExecPath || null;

    this._engineOptions = {
      numThreads: Number.isInteger(options.numThreads) && options.numThreads > 0 ? options.numThreads : 2,
      endpointing: options.endpointing || {},
      maxActivePaths: Number.isInteger(options.maxActivePaths) ? options.maxActivePaths : 4,
      maxConcurrentChannels:
        Number.isInteger(options.maxConcurrentChannels) && options.maxConcurrentChannels > 0
          ? options.maxConcurrentChannels
          : 2,
      maxUtteranceDurationMs:
        Number.isFinite(options.maxUtteranceDurationMs) && options.maxUtteranceDurationMs > 0
          ? options.maxUtteranceDurationMs
          : 25000,
      tailPaddingMs:
        Number.isFinite(options.tailPaddingMs) && options.tailPaddingMs >= 0
          ? options.tailPaddingMs
          : 400,
    };

    this._maxPendingAudioBytes =
      Number.isFinite(options.maxPendingAudioBytes) && options.maxPendingAudioBytes > 0
        ? options.maxPendingAudioBytes
        : 4 * 1024 * 1024;
    this._maxPendingChunks =
      Number.isInteger(options.maxPendingChunks) && options.maxPendingChunks > 0
        ? options.maxPendingChunks
        : 256;
    this._maxReplayBufferBytes =
      Number.isFinite(options.maxReplayBufferBytes) && options.maxReplayBufferBytes >= 0
        ? options.maxReplayBufferBytes
        : 1024 * 1024;
    this._maxRssBytes =
      Number.isFinite(options.maxRssBytes) && options.maxRssBytes > 0
        ? options.maxRssBytes
        : 768 * 1024 * 1024;
    this._connectTimeoutMs =
      Number.isFinite(options.connectTimeoutMs) && options.connectTimeoutMs > 0
        ? options.connectTimeoutMs
        : 15000;
    this._decodeTimeoutMs =
      Number.isFinite(options.decodeTimeoutMs) && options.decodeTimeoutMs > 0
        ? options.decodeTimeoutMs
        : 5000;
    this._flushTimeoutMs =
      Number.isFinite(options.flushTimeoutMs) && options.flushTimeoutMs > 0
        ? options.flushTimeoutMs
        : 8000;
    this._maxRestarts =
      Number.isInteger(options.maxRestarts) && options.maxRestarts >= 0 ? options.maxRestarts : 2;
    this._recoverBackoffMs =
      Number.isFinite(options.recoverBackoffMs) && options.recoverBackoffMs >= 0
        ? options.recoverBackoffMs
        : 50;

    this._state = 'idle';
    this._resolvedModel = null;
    this._lastSessionConfig = null;
    this._engine = null;

    this._child = null;
    this._childRl = null;
    this._rpcSeq = 0;
    this._pendingRpc = new Map();
    this._pendingBytes = 0;
    this._pendingChunkCount = 0;

    this._replayBuffer = [];
    this._replayBytes = 0;
    this._restartCount = 0;

    this._metrics = this._createEmptyMetrics();
  }

  _createEmptyMetrics() {
    return {
      mode: this._mode,
      modelId: this._modelId,
      chunksAccepted: 0,
      chunksRejected: 0,
      partialsEmitted: 0,
      finalsEmitted: 0,
      audioBytesProcessed: 0,
      audioDurationMs: 0,
      totalDecodeTimeMs: 0,
      totalWorkerCpuTimeMs: 0,
      firstAudioAtPerfMs: null,
      firstPartialAtMs: null,
      firstFinalAtMs: null,
      peakRssBytes: 0,
      latestRssBytes: 0,
      restartCount: this._restartCount,
      lastError: null,
    };
  }

  get state() {
    return this._state;
  }

  get mode() {
    return this._mode;
  }

  _emitTransition(status, extra = {}) {
    this.emit('status', {
      status,
      provider: this.name,
      mode: this._mode,
      modelId: this._resolvedModel ? this._resolvedModel.modelId : this._modelId,
      state: this._state,
      ...extra,
    });
  }

  _clearReplayBuffer() {
    for (const item of this._replayBuffer) {
      if (item && Buffer.isBuffer(item.pcm)) {
        item.pcm.fill(0);
      }
    }
    this._replayBuffer = [];
    this._replayBytes = 0;
  }

  _appendReplayChunk(chunk, pcmCopy) {
    if (this._maxReplayBufferBytes <= 0) {
      return;
    }
    if (pcmCopy.byteLength > this._maxReplayBufferBytes) {
      return;
    }
    while (
      this._replayBuffer.length > 0 &&
      this._replayBytes + pcmCopy.byteLength > this._maxReplayBufferBytes
    ) {
      const dropped = this._replayBuffer.shift();
      this._replayBytes -= dropped.pcm.byteLength;
      dropped.pcm.fill(0);
    }
    this._replayBuffer.push({
      seq: chunk.seq,
      channel: chunk.channel || chunk.streamKind || 'microphone',
      streamKind: chunk.streamKind || chunk.channel || 'microphone',
      sampleRate: chunk.sampleRate || 16000,
      channels: chunk.channels || 1,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      durationMs: chunk.durationMs,
      speakerHint: chunk.speakerHint,
      pcm: pcmCopy,
    });
    this._replayBytes += pcmCopy.byteLength;
  }

  _recordRss(rssBytes) {
    if (Number.isFinite(rssBytes) && rssBytes > 0) {
      this._metrics.latestRssBytes = rssBytes;
      if (rssBytes > this._metrics.peakRssBytes) {
        this._metrics.peakRssBytes = rssBytes;
      }
    }
  }

  _assertLocalMemoryCap() {
    const rss = process.memoryUsage().rss;
    this._recordRss(rss);
    if (rss > this._maxRssBytes) {
      throw new AsrMemoryLimitError(
        `Process RSS exceeded configured limit (${rss} > ${this._maxRssBytes} bytes)`,
        { rssBytes: rss, maxRssBytes: this._maxRssBytes }
      );
    }
  }

  _recordDecodedEvents(events) {
    const now = performance.now();
    for (const ev of events) {
      if (ev.type === 'partial') {
        this._metrics.partialsEmitted += 1;
        if (this._metrics.firstPartialAtMs === null && this._metrics.firstAudioAtPerfMs !== null) {
          this._metrics.firstPartialAtMs = Number((now - this._metrics.firstAudioAtPerfMs).toFixed(3));
        }
        this.emit('partial', ev.payload);
      } else if (ev.type === 'final') {
        this._metrics.finalsEmitted += 1;
        if (this._metrics.firstFinalAtMs === null && this._metrics.firstAudioAtPerfMs !== null) {
          this._metrics.firstFinalAtMs = Number((now - this._metrics.firstAudioAtPerfMs).toFixed(3));
        }
        this.emit('final', ev.payload);
      }
    }
  }

  async connect(sessionConfig = {}, signal) {
    if (signal && signal.aborted) {
      throw createAbortError('RealASRProvider.connect aborted before start');
    }
    if (this._state === 'connecting') {
      throw new Error('RealASRProvider.connect already in progress');
    }
    if (this._state === 'ready' && this.connected) {
      return;
    }

    this._state = 'connecting';
    this._lastSessionConfig = { ...sessionConfig };
    const targetModelId = sessionConfig.modelId || this._modelId;
    const targetModelDir = sessionConfig.modelDir || this._modelDir;
    this._modelId = targetModelId;

    if (this._metrics.chunksAccepted === 0 && this._metrics.restartCount === 0) {
      this._metrics = this._createEmptyMetrics();
    }

    try {
      this._resolvedModel = await this._modelStore.resolveRecognizerFiles(targetModelId, {
        modelDir: targetModelDir,
      });

      if (this._mode === 'inline') {
        this._assertLocalMemoryCap();
        const { binding, mode: loaderMode } = loadSherpaOnnx({
          binding: this._binding,
          ...this._loaderOptions,
        });
        this._engine = new SherpaStreamingEngine({
          binding,
          resolvedModel: this._resolvedModel,
          ...this._engineOptions,
        });
        this._recordRss(process.memoryUsage().rss);
        this.connected = true;
        this._state = 'ready';
        this._emitTransition('connected', { loaderMode });
        return;
      }

      await this._connectWorker(signal);
      this.connected = true;
      this._state = 'ready';
      this._emitTransition('connected', { pid: this._child ? this._child.pid : null });
    } catch (err) {
      this._state = err.name === 'AbortError' ? 'aborted' : 'failed';
      this.connected = false;
      this._metrics.lastError = err.message;
      this._teardownWorkerSync();
      if (this._engine) {
        this._engine.dispose();
        this._engine = null;
      }
      this._emitTransition(this._state === 'aborted' ? 'aborted' : 'error', { error: err.message });
      throw err;
    }
  }

  async _connectWorker(signal) {
    if (!fs.existsSync(this._workerScript)) {
      throw new Error(`Real ASR worker script not found: ${this._workerScript}`);
    }

    const { execPath, env } = resolveWorkerRuntimeExecutable({
      execPath: this._workerExecPath,
    });

    const child = spawn(execPath, [this._workerScript], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._child = child;

    let stderrTail = '';
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-2000);
      });
    }

    const rl = readline.createInterface({ input: child.stdout });
    this._childRl = rl;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new AsrTimeoutError(`Worker startup exceeded ${this._connectTimeoutMs}ms`));
        }
      }, this._connectTimeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      const onAbort = () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(createAbortError('Worker startup aborted'));
        }
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const onExitBeforeReady = (code, sig) => {
        if (!settled) {
          settled = true;
          cleanup();
          const detail = stderrTail ? ` (${stderrTail.trim()})` : '';
          reject(new Error(`ASR worker exited during startup (code=${code}, signal=${sig})${detail}`));
        }
      };

      const onError = (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      const onFirstLine = (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_err) {
          return;
        }
        if (msg && msg.type === 'ready') {
          if (!settled) {
            settled = true;
            cleanup();
            resolve();
          }
        } else if (msg && msg.type === 'fatal') {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error((msg.error && msg.error.message) || 'Worker fatal startup error'));
          }
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        rl.removeListener('line', onFirstLine);
        child.removeListener('exit', onExitBeforeReady);
        child.removeListener('error', onError);
      };

      rl.on('line', onFirstLine);
      child.once('exit', onExitBeforeReady);
      child.once('error', onError);
    });

    this._bindWorkerRuntimeHandlers(child, rl, () => stderrTail);

    const initReply = await this._sendWorkerRpc(
      {
        cmd: 'init',
        resolvedModel: this._resolvedModel,
        engineOptions: this._engineOptions,
        loaderOptions: this._loaderOptions,
        maxRssBytes: this._maxRssBytes,
      },
      this._connectTimeoutMs,
      signal
    );

    if (initReply && initReply.resources) {
      this._recordRss(initReply.resources.rssBytes);
    }
  }

  _bindWorkerRuntimeHandlers(child, rl, getStderrTail) {
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (_err) {
        return;
      }

      if (msg.type === 'fatal') {
        const fatalErr = new Error((msg.error && msg.error.message) || 'ASR worker fatal error');
        fatalErr.code = (msg.error && msg.error.code) || 'ASR_WORKER_FATAL';
        this._handleUnexpectedWorkerFailure(fatalErr);
        return;
      }

      if (msg.id && this._pendingRpc.has(msg.id)) {
        const entry = this._pendingRpc.get(msg.id);
        this._pendingRpc.delete(msg.id);
        entry.cleanup();
        if (msg.ok) {
          entry.resolve(msg);
        } else {
          const rpcErr = new Error((msg.error && msg.error.message) || 'Worker RPC failed');
          rpcErr.code = (msg.error && msg.error.code) || 'ASR_WORKER_ERROR';
          if (msg.error && msg.error.name) {
            rpcErr.name = msg.error.name;
          }
          entry.reject(rpcErr);
        }
      }
    });

    child.on('exit', (code, sig) => {
      if (this._child !== child) {
        return;
      }
      if (this._state === 'stopping' || this._state === 'closed' || this._state === 'aborted') {
        return;
      }
      const stderrNote = getStderrTail();
      const suffix = stderrNote ? `: ${stderrNote.trim()}` : '';
      const err = new Error(
        `ASR worker process exited unexpectedly (code=${code}, signal=${sig})${suffix}`
      );
      err.code = 'ASR_WORKER_CRASHED';
      this._handleUnexpectedWorkerFailure(err);
    });

    child.on('error', (err) => {
      if (this._child !== child) {
        return;
      }
      if (this._state === 'stopping' || this._state === 'closed' || this._state === 'aborted') {
        return;
      }
      this._handleUnexpectedWorkerFailure(err);
    });
  }

  _handleUnexpectedWorkerFailure(err) {
    this._state = 'failed';
    this.connected = false;
    this._metrics.lastError = err.message;
    this._rejectPendingRpcs(err);
    this._teardownWorkerSync();
    this._emitTransition('error', { error: err.message, code: err.code });
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  _rejectPendingRpcs(err) {
    for (const entry of this._pendingRpc.values()) {
      entry.cleanup();
      entry.reject(err);
    }
    this._pendingRpc.clear();
    this._pendingBytes = 0;
    this._pendingChunkCount = 0;
  }

  _sendWorkerRpc(payload, timeoutMs, signal) {
    if (!this._child || !this._child.stdin || this._child.killed || !this._child.stdin.writable) {
      return Promise.reject(new Error('ASR worker process is not running'));
    }

    const id = `rpc-${++this._rpcSeq}`;
    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => {
        if (this._pendingRpc.has(id)) {
          this._pendingRpc.delete(id);
          cleanup();
          reject(createAbortError('ASR worker request aborted'));
        }
      };

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this._pendingRpc.has(id)) {
            this._pendingRpc.delete(id);
            cleanup();
            const timeoutErr = new AsrTimeoutError(
              `ASR worker command '${payload.cmd}' timed out after ${timeoutMs}ms`,
              { cmd: payload.cmd, timeoutMs }
            );
            this._handleUnexpectedWorkerFailure(timeoutErr);
            reject(timeoutErr);
          }
        }, timeoutMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      }

      if (signal) {
        if (signal.aborted) {
          cleanup();
          reject(createAbortError('ASR worker request aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this._pendingRpc.set(id, { resolve, reject, cleanup });
      try {
        this._child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (writeErr) {
        this._pendingRpc.delete(id);
        cleanup();
        reject(writeErr);
      }
    });
  }

  _teardownWorkerSync() {
    const child = this._child;
    const rl = this._childRl;
    this._child = null;
    this._childRl = null;

    if (rl) {
      try {
        rl.close();
      } catch (_err) {
        // Ignore readline close error.
      }
    }
    if (child) {
      try {
        child.stdin?.end();
      } catch (_err) {
        // Ignore stdin end error.
      }
      if (!child.killed) {
        try {
          child.kill('SIGKILL');
        } catch (_err) {
          // Ignore kill error on already exited worker.
        }
      }
    }
  }

  async pushAudio(chunk, signal) {
    if (signal && signal.aborted) {
      this._metrics.chunksRejected += 1;
      return { accepted: false, reason: 'aborted' };
    }
    if (this._state === 'aborted' || this._state === 'closed' || this._state === 'stopping') {
      this._metrics.chunksRejected += 1;
      return { accepted: false, reason: this._state };
    }
    if (this._state !== 'ready' || !this.connected) {
      this._metrics.chunksRejected += 1;
      throw new Error(`RealASRProvider.pushAudio called while in state '${this._state}'`);
    }
    if (!chunk || !chunk.pcm) {
      throw new TypeError('RealASRProvider.pushAudio requires chunk.pcm');
    }

    // SessionManager zeroes chunk.pcm right after awaiting pushAudio(); copy synchronously now.
    const pcmCopy = copyPcmBytes(chunk.pcm);
    const byteLength = pcmCopy.byteLength;

    if (
      this._pendingBytes + byteLength > this._maxPendingAudioBytes ||
      this._pendingChunkCount + 1 > this._maxPendingChunks
    ) {
      this._metrics.chunksRejected += 1;
      throw new AsrBackpressureError(
        `RealASRProvider pending buffer cap reached (pendingBytes=${this._pendingBytes}, max=${this._maxPendingAudioBytes}, pendingChunks=${this._pendingChunkCount})`,
        {
          pendingBytes: this._pendingBytes,
          maxPendingAudioBytes: this._maxPendingAudioBytes,
          pendingChunks: this._pendingChunkCount,
          maxPendingChunks: this._maxPendingChunks,
        }
      );
    }

    if (this._metrics.firstAudioAtPerfMs === null) {
      this._metrics.firstAudioAtPerfMs = performance.now();
    }

    this._pendingBytes += byteLength;
    this._pendingChunkCount += 1;
    this._appendReplayChunk(chunk, Buffer.from(pcmCopy));

    try {
      const sampleRate = Number.isFinite(chunk.sampleRate) ? chunk.sampleRate : 16000;
      const channels = Number.isInteger(chunk.channels) && chunk.channels > 0 ? chunk.channels : 1;
      const durationMs = Number.isFinite(chunk.durationMs)
        ? chunk.durationMs
        : Math.round((byteLength / (2 * channels * sampleRate)) * 1000);

      let events = [];

      const channel = chunk.channel || chunk.streamKind || 'microphone';
      const speakerHint =
        chunk.speakerHint ||
        (chunk.syntheticCue && chunk.syntheticCue.speakerHint) ||
        (channel === 'microphone' ? 'local:mic' : 'remote:system');

      if (this._mode === 'inline') {
        this._assertLocalMemoryCap();
        const float32Samples = pcm16leToFloat32(pcmCopy, channels);
        pcmCopy.fill(0);

        events = this._engine.processChunk({
          seq: chunk.seq,
          channel,
          sampleRate,
          channels: 1,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          durationMs,
          speakerHint,
          float32Samples,
        });
        const stats = this._engine.getStats();
        this._metrics.totalDecodeTimeMs = stats.totalDecodeTimeMs;
        this._recordRss(stats.rssBytes);
      } else {
        const pcmBase64 = pcmCopy.toString('base64');
        pcmCopy.fill(0);

        const reply = await this._sendWorkerRpc(
          {
            cmd: 'push',
            chunk: {
              seq: chunk.seq,
              channel,
              sampleRate,
              channels,
              startMs: chunk.startMs,
              endMs: chunk.endMs,
              durationMs,
              speakerHint,
              pcmBase64,
            },
          },
          this._decodeTimeoutMs,
          signal
        );
        events = Array.isArray(reply.events) ? reply.events : [];
        if (reply.stats) {
          this._metrics.totalDecodeTimeMs = reply.stats.totalDecodeTimeMs || this._metrics.totalDecodeTimeMs;
        }
        if (reply.resources) {
          this._recordRss(reply.resources.rssBytes);
          this._metrics.totalWorkerCpuTimeMs += reply.resources.cpuTimeMs || 0;
        }
      }

      this._metrics.chunksAccepted += 1;
      this._metrics.audioBytesProcessed += byteLength;
      this._metrics.audioDurationMs += durationMs;
      this._recordDecodedEvents(events);

      return {
        accepted: true,
        seq: chunk.seq,
        emitted: events.length,
      };
    } catch (err) {
      pcmCopy.fill(0);
      this._metrics.lastError = err.message;
      if (err.code === 'ASR_MEMORY_LIMIT_EXCEEDED') {
        this._state = 'failed';
        this.connected = false;
        this._emitTransition('error', { error: err.message, code: err.code });
      }
      throw err;
    } finally {
      this._pendingBytes = Math.max(0, this._pendingBytes - byteLength);
      this._pendingChunkCount = Math.max(0, this._pendingChunkCount - 1);
    }
  }

  async flush() {
    if (this._state === 'aborted' || this._state === 'closed') {
      return { flushed: false, reason: this._state };
    }
    if (this._state === 'failed' || !this.connected) {
      return { flushed: false, reason: this._state };
    }

    const prevState = this._state;
    this._state = 'flushing';
    try {
      let events = [];
      if (this._mode === 'inline') {
        events = this._engine ? this._engine.flushAll() : [];
        if (this._engine) {
          const stats = this._engine.getStats();
          this._metrics.totalDecodeTimeMs = stats.totalDecodeTimeMs;
          this._recordRss(stats.rssBytes);
        }
      } else {
        const reply = await this._sendWorkerRpc({ cmd: 'flush' }, this._flushTimeoutMs);
        events = Array.isArray(reply.events) ? reply.events : [];
        if (reply.stats) {
          this._metrics.totalDecodeTimeMs = reply.stats.totalDecodeTimeMs || this._metrics.totalDecodeTimeMs;
        }
        if (reply.resources) {
          this._recordRss(reply.resources.rssBytes);
          this._metrics.totalWorkerCpuTimeMs += reply.resources.cpuTimeMs || 0;
        }
      }

      this._recordDecodedEvents(events);
      this._clearReplayBuffer();
      if (this._state === 'flushing') {
        this._state = prevState;
      }
      return { flushed: true, emitted: events.length };
    } catch (err) {
      if (this._state === 'flushing') {
        this._state = 'failed';
        this.connected = false;
      }
      this._metrics.lastError = err.message;
      throw err;
    }
  }

  /**
   * Safely recovers the provider after a worker crash, memory-limit abort, or timeout.
   * Restarts the recognizer cleanly and optionally replays the bounded un-flushed PCM buffer.
   *
   * @param {object} [options]
   * @returns {Promise<{ recovered: boolean, attempt: number, replayedChunks: number }>}
   */
  async recover(options = {}) {
    if (this._state === 'aborted' || this._state === 'closed') {
      throw new Error(`Cannot recover RealASRProvider from terminal state '${this._state}'`);
    }
    if (this._restartCount >= this._maxRestarts) {
      const err = new Error(
        `RealASRProvider recovery budget exhausted (restartCount=${this._restartCount}, maxRestarts=${this._maxRestarts})`
      );
      err.code = 'ASR_RECOVERY_EXHAUSTED';
      throw err;
    }

    this._restartCount += 1;
    this._metrics.restartCount = this._restartCount;

    const replaySnapshots = options.replay !== false
      ? this._replayBuffer.map((item) => ({ ...item, pcm: Buffer.from(item.pcm) }))
      : [];

    this._rejectPendingRpcs(new Error('ASR provider resetting for recovery'));
    this._teardownWorkerSync();
    if (this._engine) {
      this._engine.dispose();
      this._engine = null;
    }
    this.connected = false;
    this._state = 'idle';

    if (this._recoverBackoffMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this._recoverBackoffMs));
    }

    await this.connect(options.sessionConfig || this._lastSessionConfig || {}, options.signal);

    let replayedChunks = 0;
    for (const chunk of replaySnapshots) {
      try {
        await this.pushAudio(chunk, options.signal);
        replayedChunks += 1;
      } finally {
        chunk.pcm.fill(0);
      }
    }

    this._emitTransition('recovered', {
      attempt: this._restartCount,
      replayedChunks,
    });

    return {
      recovered: true,
      attempt: this._restartCount,
      replayedChunks,
    };
  }

  async close() {
    if (this._state === 'closed' || this._state === 'aborted') {
      return;
    }
    this._state = 'stopping';
    this.connected = false;

    try {
      if (this._mode === 'worker' && this._child && !this._child.killed) {
        try {
          await this._sendWorkerRpc({ cmd: 'shutdown' }, 1000);
        } catch (_err) {
          // Force teardown below if shutdown RPC didn't finish in grace window.
        }
      }
    } finally {
      this._rejectPendingRpcs(new Error('ASR provider closed'));
      this._teardownWorkerSync();
      if (this._engine) {
        this._engine.dispose();
        this._engine = null;
      }
      this._clearReplayBuffer();
      this._state = 'closed';
      this._emitTransition('closed');
    }
  }

  abort() {
    if (this._state === 'aborted') {
      return;
    }
    this._state = 'aborted';
    this.connected = false;
    this._rejectPendingRpcs(createAbortError('ASR provider aborted'));
    this._teardownWorkerSync();
    if (this._engine) {
      this._engine.dispose();
      this._engine = null;
    }
    this._clearReplayBuffer();
    this._emitTransition('aborted');
  }

  getMetrics() {
    const rtf = this._metrics.audioDurationMs > 0
      ? Number((this._metrics.totalDecodeTimeMs / this._metrics.audioDurationMs).toFixed(4))
      : 0;
    return {
      ...this._metrics,
      state: this._state,
      connected: this.connected,
      pendingBytes: this._pendingBytes,
      pendingChunks: this._pendingChunkCount,
      replayBufferedBytes: this._replayBytes,
      decodeRtf: rtf,
      resolvedModelId: this._resolvedModel ? this._resolvedModel.modelId : null,
    };
  }
}

module.exports = {
  DEFAULT_WORKER_SCRIPT,
  AsrBackpressureError,
  AsrTimeoutError,
  AsrMemoryLimitError,
  RealASRProvider,
};
