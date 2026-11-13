'use strict';

const { performance } = require('node:perf_hooks');

const DECISION_CUES = [
  /(^|[^\p{L}\p{N}_])(решили|договорились|утвердили|фиксируем|согласовали|выбрали|бер[её]м в работу|итог такой)(?=[^\p{L}\p{N}_]|$)/iu,
  /(^|[^\p{L}\p{N}_])(decided|agreed|approved|let'?s go with)(?=[^\p{L}\p{N}_]|$)/iu,
];

const ACTION_CUES = [
  /(^|[^\p{L}\p{N}_])(нужно|надо|сделать|подготовить|проверить|отправить|настроить|обновить|запланировать|прислать|до\s+(?:понедельника|вторника|среды|четверга|пятницы|субботы|воскресенья|завтра|вечера|конца\s+дня))(?=[^\p{L}\p{N}_]|$)/iu,
  /(^|[^\p{L}\p{N}_])(todo|action item|follow up|will send|need to)(?=[^\p{L}\p{N}_]|$)/iu,
];

const QUESTION_CUES = [
  /\?$/,
  /^(кто|когда|почему|зачем|как|какой|какая|какие|сколько|нужно ли|стоит ли|успеем ли)(?=[^\p{L}\p{N}_]|$)/iu,
];

function formatClock(ms) {
  const safe = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(safe / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Готовит структурированный конспект строго из подтверждённых сегментов расшифровки
 * и временной шкалы спикеров (без додумывания фактов и имён).
 */
class MeetingSummaryGenerator {
  constructor(options = {}) {
    this.topicPauseThresholdMs = Number.isFinite(options.topicPauseThresholdMs)
      ? options.topicPauseThresholdMs
      : 4000;
    this.maxTurnsPerTopic = Number.isInteger(options.maxTurnsPerTopic) ? options.maxTurnsPerTopic : 4;
  }

  generate({
    sessionId,
    finals = [],
    timelineSnapshot = null,
    assemblerStats = null,
    isSynthetic = true,
    interrupted = false,
  } = {}) {
    const startedAtPerf = performance.now();
    const turns = timelineSnapshot?.turns || [];
    const speakers = timelineSnapshot?.speakers || [];
    const totalDurationMs =
      timelineSnapshot?.timelineEndMs ||
      finals.reduce((max, seg) => Math.max(max, seg.endMs || 0), 0);

    if (finals.length === 0) {
      const generationMs = Number((performance.now() - startedAtPerf).toFixed(3));
      const emptySummary = {
        meta: {
          sessionId: sessionId || null,
          status: interrupted ? 'interrupted_empty' : 'empty',
          isSyntheticInput: Boolean(isSynthetic),
          generatedAt: new Date().toISOString(),
          totalDurationMs,
          segmentCount: 0,
          turnCount: 0,
          speakerCount: 0,
          generationMs,
        },
        overview: 'Недостаточно данных: подтверждённых речевых фрагментов в сессии нет.',
        topics: [],
        decisions: [],
        actionItems: [],
        openQuestions: [],
        speakers: [],
        qualityNotes: {
          repairedTimestamps: assemblerStats?.repairedTimestamps || 0,
          dedupedSegments:
            (assemblerStats?.dedupedExact || 0) + (assemblerStats?.dedupedOverlap || 0),
          lateFinals: assemblerStats?.lateFinals || 0,
        },
      };
      return {
        summary: emptySummary,
        markdown: this.toMarkdown(emptySummary),
      };
    }

    // Группировка по темам на основе пауз и числа реплик
    const topicGroups = [];
    let currentGroup = [];
    for (const turn of turns) {
      const prev = currentGroup[currentGroup.length - 1];
      const largeGap = prev && turn.startMs - prev.endMs >= this.topicPauseThresholdMs;
      if (prev && (largeGap || currentGroup.length >= this.maxTurnsPerTopic)) {
        topicGroups.push(currentGroup);
        currentGroup = [];
      }
      currentGroup.push(turn);
    }
    if (currentGroup.length > 0) {
      topicGroups.push(currentGroup);
    }

    const topics = topicGroups.map((group, idx) => {
      const startMs = group[0].startMs;
      const endMs = group[group.length - 1].endMs;
      const firstSentence = splitSentences(group[0].text)[0] || group[0].text;
      const shortTitle =
        firstSentence.length > 72 ? `${firstSentence.slice(0, 69).trim()}...` : firstSentence;
      const sourceSegmentIds = group.flatMap((t) => t.segmentIds);
      const points = group.map((t) => `${t.speakerLabel}: ${t.text}`);
      return {
        topicId: `topic-${idx + 1}`,
        title: shortTitle,
        startMs,
        endMs,
        timeRange: `${formatClock(startMs)}–${formatClock(endMs)}`,
        points,
        sourceSegmentIds,
      };
    });

    const decisions = [];
    const actionItems = [];
    const openQuestions = [];
    const speakerLabelMap = new Map(speakers.map((s) => [s.speakerKey, s.label]));

    for (const seg of finals) {
      const speakerKey =
        seg.speakerHint ||
        (seg.channel === 'microphone' ? 'local:mic' : 'remote:unidentified');
      const speakerLabel =
        speakerLabelMap.get(speakerKey) ||
        (seg.channel === 'microphone'
          ? 'Участник (локальный канал)'
          : 'Собеседник (удалённый канал, имя не определено)');

      for (const sentence of splitSentences(seg.text)) {
        const isQuestion = QUESTION_CUES.some((re) => re.test(sentence));

        if (!isQuestion && DECISION_CUES.some((re) => re.test(sentence))) {
          decisions.push({
            text: sentence,
            speakerKey,
            speakerLabel,
            startMs: seg.startMs,
            endMs: seg.endMs,
            timecode: formatClock(seg.startMs),
            segmentId: seg.segmentId,
            groundedBy: 'transcript_cue_match',
          });
        }

        if (!isQuestion && ACTION_CUES.some((re) => re.test(sentence))) {
          actionItems.push({
            text: sentence,
            suggestedOwnerLabel: speakerLabel,
            ownerVerified: false,
            speakerKey,
            startMs: seg.startMs,
            timecode: formatClock(seg.startMs),
            segmentId: seg.segmentId,
            groundedBy: 'transcript_cue_match',
          });
        }

        if (isQuestion) {
          openQuestions.push({
            text: sentence,
            speakerKey,
            speakerLabel,
            startMs: seg.startMs,
            timecode: formatClock(seg.startMs),
            segmentId: seg.segmentId,
          });
        }
      }
    }

    const overviewSentences = finals
      .slice(0, 3)
      .map((seg) => splitSentences(seg.text)[0] || seg.text);
    const overviewPrefix = interrupted
      ? 'Сессия завершена досрочно; предварительный конспект по собранным фрагментам: '
      : 'Краткая выжимка по подтверждённой расшифровке: ';
    const overview = `${overviewPrefix}${overviewSentences.join(' ')}`.trim();

    const generationMs = Number((performance.now() - startedAtPerf).toFixed(3));
    const summary = {
      meta: {
        sessionId: sessionId || null,
        status: interrupted ? 'partial_interrupted' : 'ready',
        isSyntheticInput: Boolean(isSynthetic),
        generatedAt: new Date().toISOString(),
        totalDurationMs,
        segmentCount: finals.length,
        turnCount: turns.length,
        speakerCount: speakers.length,
        generationMs,
      },
      overview,
      topics,
      decisions,
      actionItems,
      openQuestions,
      speakers,
      qualityNotes: {
        repairedTimestamps: assemblerStats?.repairedTimestamps || 0,
        dedupedSegments:
          (assemblerStats?.dedupedExact || 0) + (assemblerStats?.dedupedOverlap || 0),
        lateFinals: assemblerStats?.lateFinals || 0,
      },
    };

    return {
      summary,
      markdown: this.toMarkdown(summary),
    };
  }

  toMarkdown(summary) {
    const lines = [];
    lines.push(`# Конспект встречи (${summary.meta.sessionId || 'без ID'})`);
    lines.push('');
    lines.push(
      `- Статус: \`${summary.meta.status}\` · Длительность шкалы: \`${formatClock(summary.meta.totalDurationMs)}\` · Сегментов: \`${summary.meta.segmentCount}\``
    );
    if (summary.meta.isSyntheticInput) {
      lines.push('- Источник данных: **синтетический поток (без микрофона и реального ASR)**');
    }
    lines.push('');
    lines.push('## Обзор');
    lines.push(summary.overview);
    lines.push('');

    if (summary.topics.length > 0) {
      lines.push('## Обсуждённые темы');
      for (const topic of summary.topics) {
        lines.push(`### [${topic.timeRange}] ${topic.title}`);
        for (const pt of topic.points) {
          lines.push(`- ${pt}`);
        }
        lines.push('');
      }
    }

    lines.push('## Решения');
    if (summary.decisions.length === 0) {
      lines.push('- Явно сформулированных решений в расшифровке не обнаружено.');
    } else {
      for (const d of summary.decisions) {
        lines.push(`- [${d.timecode}] ${d.text} *(${d.speakerLabel})*`);
      }
    }
    lines.push('');

    lines.push('## Следующие шаги');
    if (summary.actionItems.length === 0) {
      lines.push('- Задач с явными маркерами действия не обнаружено.');
    } else {
      for (const a of summary.actionItems) {
        lines.push(`- [${a.timecode}] ${a.text} *(озвучил: ${a.suggestedOwnerLabel}; ответственный не подтверждён)*`);
      }
    }
    lines.push('');

    lines.push('## Открытые вопросы');
    if (summary.openQuestions.length === 0) {
      lines.push('- Открытых вопросов не зафиксировано.');
    } else {
      for (const q of summary.openQuestions) {
        lines.push(`- [${q.timecode}] ${q.text} *(${q.speakerLabel})*`);
      }
    }
    lines.push('');

    if (summary.speakers.length > 0) {
      lines.push('## Участники (честные канальные метки)');
      for (const s of summary.speakers) {
        lines.push(
          `- ${s.label}: ${s.turnCount} репл., ${formatClock(s.speakingMs)}, доля ${Math.round(s.shareRatio * 100)}%`
        );
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

module.exports = {
  MeetingSummaryGenerator,
  formatClock,
};
