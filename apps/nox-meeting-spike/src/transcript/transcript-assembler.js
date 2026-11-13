'use strict';

function normalizeTextForDedup(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function intervalsOverlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Собирает потоковые частичные и финальные результаты ASR:
 * удаляет дубли, упорядочивает поздние сегменты и чинит битые временные метки.
 */
class TranscriptAssembler {
  constructor(options = {}) {
    this.maxFutureDriftMs = Number.isFinite(options.maxFutureDriftMs) ? options.maxFutureDriftMs : 5000;
    this.defaultDurationMs = Number.isFinite(options.defaultDurationMs) ? options.defaultDurationMs : 500;
    this.duplicateWindowMs = Number.isFinite(options.duplicateWindowMs) ? options.duplicateWindowMs : 2000;
    this.maxPartials = Number.isInteger(options.maxPartials) ? options.maxPartials : 50;

    this._partials = new Map();
    this._finals = [];
    this._finalizedIds = new Set();
    this._arrivalCounter = 0;
    this._lastValidEndMs = 0;
    this._audioWatermarkMs = 0;

    this._stats = {
      partialsReceived: 0,
      finalsReceived: 0,
      finalsAccepted: 0,
      dedupedExact: 0,
      dedupedOverlap: 0,
      ignoredLatePartials: 0,
      ignoredEmpty: 0,
      lateFinals: 0,
      repairedTimestamps: 0,
      droppedAfterCancel: 0,
    };
  }

  updateAudioWatermark(watermarkMs) {
    if (Number.isFinite(watermarkMs) && watermarkMs > this._audioWatermarkMs) {
      this._audioWatermarkMs = watermarkMs;
    }
  }

  _sanitizeTimestamps(rawStartMs, rawEndMs, contextWatermarkMs) {
    const watermark = Math.max(
      this._audioWatermarkMs,
      Number.isFinite(contextWatermarkMs) ? contextWatermarkMs : 0
    );
    const reasons = [];

    let startMs = rawStartMs;
    let endMs = rawEndMs;

    if (!Number.isFinite(startMs) || startMs < 0) {
      reasons.push(!Number.isFinite(startMs) ? 'nan_start' : 'negative_start');
      startMs = Number.isFinite(endMs) && endMs > 0 ? 0 : this._lastValidEndMs;
    }

    if (watermark > 0 && startMs > watermark + this.maxFutureDriftMs) {
      reasons.push('future_start_clamped');
      startMs = Math.min(watermark, this._lastValidEndMs);
    }

    if (!Number.isFinite(endMs) || endMs < 0) {
      reasons.push(!Number.isFinite(endMs) ? 'nan_end' : 'negative_end');
      endMs = startMs + this.defaultDurationMs;
    } else if (endMs < startMs) {
      const span = startMs - endMs;
      if (span <= 10000 && endMs >= 0 && (watermark === 0 || startMs <= watermark + this.maxFutureDriftMs)) {
        reasons.push('reversed_interval_swapped');
        const tmp = startMs;
        startMs = endMs;
        endMs = tmp;
      } else {
        reasons.push('end_before_start_clamped');
        endMs = startMs + this.defaultDurationMs;
      }
    }

    if (watermark > 0 && endMs > watermark + this.maxFutureDriftMs) {
      reasons.push('future_end_clamped');
      endMs = Math.max(startMs, watermark);
    }

    if (startMs < 0) {
      reasons.push('start_clamped_zero');
      startMs = 0;
    }
    if (endMs < startMs) {
      reasons.push('end_aligned_to_start');
      endMs = startMs;
    }

    return {
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      timestampRepaired: reasons.length > 0,
      repairReasons: reasons,
    };
  }

  _isDuplicateByContentAndTime(candidate) {
    const norm = normalizeTextForDedup(candidate.text);
    if (!norm) return false;

    for (let i = this._finals.length - 1; i >= 0; i -= 1) {
      const existing = this._finals[i];
      if (candidate.startMs - existing.endMs > this.duplicateWindowMs * 4) {
        // Поскольку финалы отсортированы, далеко ушедшие в прошлое сегменты можно пропустить при линейном проходе.
        if (existing.endMs < candidate.startMs - this.duplicateWindowMs * 4) {
          continue;
        }
      }

      const sameChannel =
        !candidate.channel || !existing.channel || candidate.channel === existing.channel;
      if (!sameChannel) continue;

      const existingNorm = existing._normText;
      const overlap = intervalsOverlapMs(
        existing.startMs,
        existing.endMs,
        candidate.startMs,
        candidate.endMs
      );
      const nearStart = Math.abs(existing.startMs - candidate.startMs) <= this.duplicateWindowMs;
      const minDur = Math.max(1, Math.min(existing.endMs - existing.startMs, candidate.endMs - candidate.startMs));
      const overlapRatio = overlap / minDur;

      if (norm === existingNorm && (overlap > 0 || nearStart)) {
        return { reason: 'text_and_window_match', duplicateOf: existing.segmentId };
      }

      if (
        overlapRatio >= 0.75 &&
        existingNorm.length >= norm.length &&
        existingNorm.includes(norm) &&
        norm.split(' ').length >= 2
      ) {
        return { reason: 'overlapping_subset_match', duplicateOf: existing.segmentId };
      }
    }
    return null;
  }

  _sortFinals() {
    this._finals.sort((a, b) => {
      if (a.startMs !== b.startMs) return a.startMs - b.startMs;
      if (a.endMs !== b.endMs) return a.endMs - b.endMs;
      return a._arrivalSeq - b._arrivalSeq;
    });
  }

  /**
   * Обрабатывает одно событие ASR (partial или final) с защитой от дублей, опозданий и битых меток.
   */
  processEvent(rawEvent, context = {}) {
    if (context.cancelled) {
      this._stats.droppedAfterCancel += 1;
      return { action: 'dropped_after_cancel', snapshot: this.getSnapshot() };
    }

    if (!rawEvent || typeof rawEvent !== 'object') {
      this._stats.ignoredEmpty += 1;
      return { action: 'ignored_empty', snapshot: this.getSnapshot() };
    }

    const text = String(rawEvent.text || '').trim();
    if (!text) {
      this._stats.ignoredEmpty += 1;
      return { action: 'ignored_empty', snapshot: this.getSnapshot() };
    }

    if (Number.isFinite(context.audioWatermarkMs)) {
      this.updateAudioWatermark(context.audioWatermarkMs);
    }

    const isFinal = Boolean(rawEvent.isFinal);
    const utteranceId = String(
      rawEvent.utteranceId || `${rawEvent.channel || 'ch'}:${rawEvent.startMs ?? 'na'}:${this._arrivalCounter + 1}`
    );

    const timing = this._sanitizeTimestamps(rawEvent.startMs, rawEvent.endMs, context.audioWatermarkMs);
    if (timing.timestampRepaired) {
      this._stats.repairedTimestamps += 1;
    }

    if (!isFinal) {
      this._stats.partialsReceived += 1;
      if (this._finalizedIds.has(utteranceId)) {
        this._stats.ignoredLatePartials += 1;
        return { action: 'ignored_late_partial', utteranceId, snapshot: this.getSnapshot() };
      }

      const existing = this._partials.get(utteranceId);
      const revision = Number.isFinite(rawEvent.revision) ? rawEvent.revision : (existing?.revision || 0) + 1;
      if (existing && revision < existing.revision) {
        this._stats.ignoredLatePartials += 1;
        return { action: 'ignored_stale_partial', utteranceId, snapshot: this.getSnapshot() };
      }

      const partial = {
        utteranceId,
        revision,
        isFinal: false,
        text,
        startMs: timing.startMs,
        endMs: timing.endMs,
        channel: rawEvent.channel || 'system_loopback',
        speakerHint: rawEvent.speakerHint || null,
        confidence: Number.isFinite(rawEvent.confidence) ? rawEvent.confidence : null,
        timestampRepaired: timing.timestampRepaired,
        repairReasons: timing.repairReasons,
        isSynthetic: rawEvent.isSynthetic !== false,
      };

      if (!this._partials.has(utteranceId) && this._partials.size >= this.maxPartials) {
        const oldestKey = this._partials.keys().next().value;
        this._partials.delete(oldestKey);
      }
      this._partials.set(utteranceId, partial);

      return { action: 'partial_updated', partial, snapshot: this.getSnapshot() };
    }

    // Обработка финального сегмента
    this._stats.finalsReceived += 1;
    this._partials.delete(utteranceId);

    if (this._finalizedIds.has(utteranceId)) {
      this._stats.dedupedExact += 1;
      return { action: 'deduped_exact', utteranceId, snapshot: this.getSnapshot() };
    }

    const candidate = {
      segmentId: `seg-${this._finals.length + 1}-${utteranceId}`,
      utteranceId,
      revision: Number.isFinite(rawEvent.revision) ? rawEvent.revision : 1,
      isFinal: true,
      text,
      startMs: timing.startMs,
      endMs: timing.endMs,
      channel: rawEvent.channel || 'system_loopback',
      speakerHint: rawEvent.speakerHint || null,
      confidence: Number.isFinite(rawEvent.confidence) ? rawEvent.confidence : null,
      timestampRepaired: timing.timestampRepaired,
      repairReasons: timing.repairReasons,
      originalStartMs: rawEvent.startMs,
      originalEndMs: rawEvent.endMs,
      isSynthetic: rawEvent.isSynthetic !== false,
    };

    const dup = this._isDuplicateByContentAndTime(candidate);
    if (dup) {
      this._finalizedIds.add(utteranceId);
      this._stats.dedupedOverlap += 1;
      return {
        action: 'deduped_overlap',
        utteranceId,
        duplicateOf: dup.duplicateOf,
        reason: dup.reason,
        snapshot: this.getSnapshot(),
      };
    }

    const latestFinalStart = this._finals.length > 0 ? this._finals[this._finals.length - 1].startMs : -1;
    const wasLate = latestFinalStart >= 0 && candidate.startMs < latestFinalStart;
    if (wasLate) {
      this._stats.lateFinals += 1;
    }

    this._arrivalCounter += 1;
    const storedSegment = {
      ...candidate,
      wasLate,
      _normText: normalizeTextForDedup(candidate.text),
      _arrivalSeq: this._arrivalCounter,
    };

    this._finalizedIds.add(utteranceId);
    this._finals.push(storedSegment);
    this._sortFinals();
    this._lastValidEndMs = Math.max(this._lastValidEndMs, candidate.endMs);
    this._stats.finalsAccepted += 1;

    return {
      action: 'final_added',
      segment: this._publicSegment(storedSegment),
      wasLate,
      timestampRepaired: timing.timestampRepaired,
      snapshot: this.getSnapshot(),
    };
  }

  _publicSegment(seg) {
    const { _normText, _arrivalSeq, ...pub } = seg;
    return pub;
  }

  clearPartials() {
    this._partials.clear();
  }

  getFinals() {
    return this._finals.map((seg) => this._publicSegment(seg));
  }

  getPartials() {
    return Array.from(this._partials.values()).sort((a, b) => a.startMs - b.startMs);
  }

  getSnapshot() {
    return {
      finals: this.getFinals(),
      partials: this.getPartials(),
      stats: this.getStats(),
    };
  }

  getStats() {
    return {
      ...this._stats,
      activePartials: this._partials.size,
      finalCount: this._finals.length,
    };
  }

  reset() {
    this._partials.clear();
    this._finals = [];
    this._finalizedIds.clear();
    this._arrivalCounter = 0;
    this._lastValidEndMs = 0;
    this._audioWatermarkMs = 0;
    this._stats = {
      partialsReceived: 0,
      finalsReceived: 0,
      finalsAccepted: 0,
      dedupedExact: 0,
      dedupedOverlap: 0,
      ignoredLatePartials: 0,
      ignoredEmpty: 0,
      lateFinals: 0,
      repairedTimestamps: 0,
      droppedAfterCancel: 0,
    };
  }
}

module.exports = {
  TranscriptAssembler,
  normalizeTextForDedup,
};
