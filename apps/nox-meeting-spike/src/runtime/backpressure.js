'use strict';

const { EventEmitter } = require('node:events');

const VALID_POLICIES = new Set(['drop_oldest', 'drop_newest', 'coalesce_silence']);

/**
 * Ограниченная очередь аудиофрагментов с контролем памяти, уровнями заполнения и политикой сброса.
 */
class BackpressureQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxChunks = Number.isInteger(options.maxChunks) && options.maxChunks > 0 ? options.maxChunks : 64;
    this.maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 512 * 1024;
    this.highWatermarkRatio = Number.isFinite(options.highWatermarkRatio) ? options.highWatermarkRatio : 0.75;
    this.lowWatermarkRatio = Number.isFinite(options.lowWatermarkRatio) ? options.lowWatermarkRatio : 0.4;
    this.policy = VALID_POLICIES.has(options.policy) ? options.policy : 'drop_oldest';
    this.maxDropHistory = Number.isInteger(options.maxDropHistory) ? options.maxDropHistory : 200;

    this._items = [];
    this._currentBytes = 0;
    this._pressureState = 'normal';
    this._stats = {
      enqueued: 0,
      dequeued: 0,
      droppedChunks: 0,
      droppedBytes: 0,
      coalescedSilenceChunks: 0,
      peakChunks: 0,
      peakBytes: 0,
      highPressureTransitions: 0,
      overflowTransitions: 0,
    };
    this._dropHistory = [];
  }

  get size() {
    return this._items.length;
  }

  get bytes() {
    return this._currentBytes;
  }

  get pressureState() {
    return this._pressureState;
  }

  _recordDrop(chunk, reason) {
    const byteLength = chunk?.pcm?.byteLength || 0;
    this._stats.droppedChunks += 1;
    this._stats.droppedBytes += byteLength;
    if (reason === 'coalesce_silence') {
      this._stats.coalescedSilenceChunks += 1;
    }
    if (this._dropHistory.length >= this.maxDropHistory) {
      this._dropHistory.shift();
    }
    this._dropHistory.push({
      seq: chunk?.seq ?? null,
      startMs: chunk?.startMs ?? null,
      endMs: chunk?.endMs ?? null,
      bytes: byteLength,
      reason,
    });
    if (Buffer.isBuffer(chunk?.pcm)) {
      chunk.pcm.fill(0);
    }
  }

  _updatePressureState() {
    const chunkRatio = this._items.length / this.maxChunks;
    const byteRatio = this._currentBytes / this.maxBytes;
    const ratio = Math.max(chunkRatio, byteRatio);

    let nextState = this._pressureState;
    if (ratio >= 1) {
      nextState = 'overflow';
    } else if (ratio >= this.highWatermarkRatio) {
      nextState = 'high';
    } else if (ratio <= this.lowWatermarkRatio) {
      nextState = 'normal';
    }

    if (nextState !== this._pressureState) {
      const previous = this._pressureState;
      this._pressureState = nextState;
      if (nextState === 'high') this._stats.highPressureTransitions += 1;
      if (nextState === 'overflow') this._stats.overflowTransitions += 1;
      this.emit('pressure_change', {
        previous,
        current: nextState,
        depth: this._items.length,
        bytes: this._currentBytes,
        maxChunks: this.maxChunks,
        maxBytes: this.maxBytes,
      });
    }
  }

  _evictOne() {
    if (this._items.length === 0) return null;

    if (this.policy === 'coalesce_silence') {
      const silentIdx = this._items.findIndex((item) => item.isSpeechLikely === false);
      if (silentIdx >= 0) {
        const [removed] = this._items.splice(silentIdx, 1);
        this._currentBytes -= removed.pcm.byteLength;
        this._recordDrop(removed, 'coalesce_silence');
        return removed;
      }
    }

    const removed = this._items.shift();
    this._currentBytes -= removed.pcm.byteLength;
    this._recordDrop(removed, 'overflow_drop_oldest');
    return removed;
  }

  /**
   * Помещает фрагмент в очередь с жёстким соблюдением лимитов памяти и длины.
   */
  enqueue(chunk) {
    const chunkBytes = chunk?.pcm?.byteLength || 0;
    if (chunkBytes > this.maxBytes) {
      this._recordDrop(chunk, 'chunk_exceeds_max_bytes');
      this._updatePressureState();
      return { accepted: false, dropped: [chunk.seq], reason: 'chunk_exceeds_max_bytes' };
    }

    const droppedSeqs = [];
    if (
      this.policy === 'drop_newest' &&
      (this._items.length >= this.maxChunks || this._currentBytes + chunkBytes > this.maxBytes)
    ) {
      this._recordDrop(chunk, 'overflow_drop_newest');
      this._pressureState = 'overflow';
      this._stats.overflowTransitions += 1;
      this.emit('backpressure', {
        policy: this.policy,
        droppedSeq: chunk.seq,
        depth: this._items.length,
        bytes: this._currentBytes,
      });
      return { accepted: false, dropped: [chunk.seq], reason: 'overflow_drop_newest' };
    }

    while (
      this._items.length >= this.maxChunks ||
      this._currentBytes + chunkBytes > this.maxBytes
    ) {
      const evicted = this._evictOne();
      if (!evicted) break;
      droppedSeqs.push(evicted.seq);
    }

    this._items.push(chunk);
    this._currentBytes += chunkBytes;
    this._stats.enqueued += 1;
    if (this._items.length > this._stats.peakChunks) {
      this._stats.peakChunks = this._items.length;
    }
    if (this._currentBytes > this._stats.peakBytes) {
      this._stats.peakBytes = this._currentBytes;
    }

    this._updatePressureState();

    if (droppedSeqs.length > 0) {
      this.emit('backpressure', {
        policy: this.policy,
        droppedSeqs,
        depth: this._items.length,
        bytes: this._currentBytes,
      });
    }

    return { accepted: true, dropped: droppedSeqs };
  }

  dequeue() {
    if (this._items.length === 0) return null;
    const item = this._items.shift();
    this._currentBytes -= item.pcm.byteLength;
    this._stats.dequeued += 1;
    this._updatePressureState();
    return item;
  }

  clear({ wipeBuffers = true } = {}) {
    let clearedCount = 0;
    while (this._items.length > 0) {
      const item = this._items.shift();
      clearedCount += 1;
      if (wipeBuffers && Buffer.isBuffer(item?.pcm)) {
        item.pcm.fill(0);
      }
    }
    this._currentBytes = 0;
    this._pressureState = 'normal';
    return clearedCount;
  }

  getMetrics() {
    return {
      depth: this._items.length,
      bytes: this._currentBytes,
      maxChunks: this.maxChunks,
      maxBytes: this.maxBytes,
      policy: this.policy,
      pressureState: this._pressureState,
      ...this._stats,
      dropHistory: this._dropHistory.slice(-20),
    };
  }
}

module.exports = {
  BackpressureQueue,
  VALID_POLICIES,
};
