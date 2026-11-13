'use strict';

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Формирует временную шкалу реплик по участникам и каналам.
 * Никогда не выдумывает личность говорящего из текста — использует только честные метки каналов/кластеров
 * или явно заданное пользователем имя слота.
 */
class SpeakerTimeline {
  constructor(options = {}) {
    this.mergeGapMs = Number.isFinite(options.mergeGapMs) ? Math.max(0, options.mergeGapMs) : 1200;
    this._speakerDirectory = new Map();
    this._remoteOrdinalMap = new Map();
    this._turns = [];
    this._lastFinals = [];
  }

  _deriveSpeakerKey(segment) {
    if (segment.speakerHint && String(segment.speakerHint).trim()) {
      return String(segment.speakerHint).trim();
    }
    if (segment.channel === 'microphone') return 'local:mic';
    if (segment.channel === 'system_loopback') return 'remote:unidentified';
    return 'channel:unknown';
  }

  _buildNeutralDescriptor(speakerKey, channel) {
    if (speakerKey.startsWith('local:')) {
      return {
        speakerKey,
        label: 'Участник (локальный канал)',
        channel: channel || 'microphone',
        identityVerified: false,
        attributionKind: 'channel_only',
      };
    }

    if (speakerKey.startsWith('remote:')) {
      const suffix = speakerKey.slice('remote:'.length);
      if (!suffix || suffix === 'unidentified') {
        return {
          speakerKey,
          label: 'Собеседник (удалённый канал, личность не определена)',
          channel: channel || 'system_loopback',
          identityVerified: false,
          attributionKind: 'channel_only',
        };
      }
      if (!this._remoteOrdinalMap.has(speakerKey)) {
        this._remoteOrdinalMap.set(speakerKey, this._remoteOrdinalMap.size + 1);
      }
      const ordinal = this._remoteOrdinalMap.get(speakerKey);
      return {
        speakerKey,
        label: `Участник ${ordinal} (канал созвона, имя не определено)`,
        channel: channel || 'system_loopback',
        identityVerified: false,
        attributionKind: 'acoustic_cluster_only',
      };
    }

    return {
      speakerKey,
      label: 'Неопределённый участник',
      channel: channel || 'synthetic_mixed',
      identityVerified: false,
      attributionKind: 'unverified',
    };
  }

  _ensureSpeaker(segment) {
    const speakerKey = this._deriveSpeakerKey(segment);
    if (!this._speakerDirectory.has(speakerKey)) {
      this._speakerDirectory.set(speakerKey, this._buildNeutralDescriptor(speakerKey, segment.channel));
    }
    return this._speakerDirectory.get(speakerKey);
  }

  /**
   * Позволяет пользователю вручную переименовать слот участника (не авто-угадывание).
   */
  setUserAssignedLabel(speakerKey, label, { userConfirmed = false } = {}) {
    if (!userConfirmed) {
      throw new Error('Назначение имени участника допустимо только при явном действии пользователя');
    }
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel) {
      throw new Error('Метка участника не может быть пустой');
    }
    const current = this._speakerDirectory.get(speakerKey) || this._buildNeutralDescriptor(speakerKey, 'unknown');
    const updated = {
      ...current,
      label: cleanLabel,
      identityVerified: true,
      attributionKind: 'user_labeled',
    };
    this._speakerDirectory.set(speakerKey, updated);
    this.rebuild(this._lastFinals);
    return updated;
  }

  /**
   * Перестраивает шкалу времени по актуальному списку финальных сегментов.
   */
  rebuild(finalSegments = []) {
    this._lastFinals = Array.isArray(finalSegments) ? finalSegments.slice() : [];
    const sorted = this._lastFinals.slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    const turns = [];
    for (const seg of sorted) {
      const speaker = this._ensureSpeaker(seg);
      const prev = turns[turns.length - 1];
      const canMerge =
        prev &&
        prev.speakerKey === speaker.speakerKey &&
        seg.startMs - prev.endMs <= this.mergeGapMs &&
        seg.startMs >= prev.startMs;

      if (canMerge) {
        prev.endMs = Math.max(prev.endMs, seg.endMs);
        prev.text = `${prev.text} ${seg.text}`.trim();
        prev.segmentIds.push(seg.segmentId);
        prev.wordCount += countWords(seg.text);
      } else {
        turns.push({
          turnId: `turn-${turns.length + 1}`,
          speakerKey: speaker.speakerKey,
          speakerLabel: speaker.label,
          identityVerified: speaker.identityVerified,
          attributionKind: speaker.attributionKind,
          channel: seg.channel,
          startMs: seg.startMs,
          endMs: seg.endMs,
          text: seg.text,
          segmentIds: [seg.segmentId],
          wordCount: countWords(seg.text),
          overlapsWithTurnIds: [],
        });
      }
    }

    // Детекция пересечений речи разных участников
    for (let i = 0; i < turns.length; i += 1) {
      for (let j = i + 1; j < turns.length; j += 1) {
        if (turns[j].startMs >= turns[i].endMs) break;
        if (turns[i].speakerKey !== turns[j].speakerKey) {
          turns[i].overlapsWithTurnIds.push(turns[j].turnId);
          turns[j].overlapsWithTurnIds.push(turns[i].turnId);
        }
      }
    }

    this._turns = turns;
    return this.getSnapshot();
  }

  getSnapshot() {
    const speakerStatsMap = new Map();
    let totalSpeakingMs = 0;

    for (const [key, desc] of this._speakerDirectory.entries()) {
      speakerStatsMap.set(key, {
        ...desc,
        turnCount: 0,
        segmentCount: 0,
        speakingMs: 0,
        wordCount: 0,
        shareRatio: 0,
      });
    }

    for (const turn of this._turns) {
      const entry = speakerStatsMap.get(turn.speakerKey);
      if (!entry) continue;
      const dur = Math.max(0, turn.endMs - turn.startMs);
      entry.turnCount += 1;
      entry.segmentCount += turn.segmentIds.length;
      entry.speakingMs += dur;
      entry.wordCount += turn.wordCount;
      totalSpeakingMs += dur;
    }

    const speakers = Array.from(speakerStatsMap.values()).map((entry) => ({
      ...entry,
      shareRatio: totalSpeakingMs > 0 ? Number((entry.speakingMs / totalSpeakingMs).toFixed(3)) : 0,
    }));

    const maxEndMs = this._turns.reduce((acc, t) => Math.max(acc, t.endMs), 0);

    return {
      turns: this._turns.map((t) => ({ ...t })),
      speakers,
      totalTurns: this._turns.length,
      totalSpeakingMs,
      timelineEndMs: maxEndMs,
    };
  }

  reset() {
    this._speakerDirectory.clear();
    this._remoteOrdinalMap.clear();
    this._turns = [];
    this._lastFinals = [];
  }
}

module.exports = {
  SpeakerTimeline,
};
