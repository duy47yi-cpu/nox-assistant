'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TranscriptAssembler,
  SpeakerTimeline,
  MeetingSummaryGenerator,
} = require('../src');

test('поздние результаты ASR: поздний partial игнорируется, поздний final встаёт в хронологическом порядке', () => {
  const assembler = new TranscriptAssembler();

  // Сначала приходит u2 (более поздняя по времени реплика)
  assembler.processEvent(
    {
      utteranceId: 'u2',
      isFinal: true,
      text: 'Вторая реплика пришла первой.',
      startMs: 3000,
      endMs: 4200,
      channel: 'microphone',
      speakerHint: 'local:mic',
    },
    { audioWatermarkMs: 4500 }
  );

  // Потом приходит опоздавший финал u1 (более ранний интервал)
  const lateRes = assembler.processEvent(
    {
      utteranceId: 'u1',
      isFinal: true,
      text: 'Первая реплика опоздала.',
      startMs: 400,
      endMs: 1800,
      channel: 'system_loopback',
      speakerHint: 'remote:S1',
    },
    { audioWatermarkMs: 4500 }
  );

  assert.equal(lateRes.action, 'final_added');
  assert.equal(lateRes.wasLate, true);

  // Поздний partial для уже финализированной u1 должен игнорироваться
  const latePartial = assembler.processEvent({
    utteranceId: 'u1',
    revision: 99,
    isFinal: false,
    text: 'Устаревший partial',
    startMs: 400,
    endMs: 1500,
  });

  assert.equal(latePartial.action, 'ignored_late_partial');

  const finals = assembler.getFinals();
  assert.equal(finals.length, 2);
  assert.equal(finals[0].utteranceId, 'u1');
  assert.equal(finals[1].utteranceId, 'u2');
  assert.equal(assembler.getStats().lateFinals, 1);
  assert.equal(assembler.getStats().ignoredLatePartials, 1);
});

test('дублирование сегментов: отсекаются точные повторы и пересекающиеся дубли после перезапуска', () => {
  const assembler = new TranscriptAssembler();

  const first = assembler.processEvent({
    utteranceId: 'u1',
    isFinal: true,
    text: 'Решили выпустить патч завтра утром.',
    startMs: 1000,
    endMs: 2800,
    channel: 'system_loopback',
  });
  assert.equal(first.action, 'final_added');

  // Точный дубль по utteranceId
  const exactDup = assembler.processEvent({
    utteranceId: 'u1',
    isFinal: true,
    text: 'Решили выпустить патч завтра утром.',
    startMs: 1000,
    endMs: 2800,
    channel: 'system_loopback',
  });
  assert.equal(exactDup.action, 'deduped_exact');

  // Дубль с новым utteranceId и слегка сдвинутым окном (например, replay после reconnect)
  const overlapDup = assembler.processEvent({
    utteranceId: 'u1-replay',
    isFinal: true,
    text: 'решили выпустить патч завтра утром',
    startMs: 1200,
    endMs: 2900,
    channel: 'system_loopback',
  });
  assert.equal(overlapDup.action, 'deduped_overlap');

  // Частичное перекрытие подстрокой на границе окна
  const subsetDup = assembler.processEvent({
    utteranceId: 'u1-subset',
    isFinal: true,
    text: 'выпустить патч завтра утром',
    startMs: 1400,
    endMs: 2800,
    channel: 'system_loopback',
  });
  assert.equal(subsetDup.action, 'deduped_overlap');

  assert.equal(assembler.getFinals().length, 1);
  assert.equal(assembler.getStats().dedupedExact, 1);
  assert.equal(assembler.getStats().dedupedOverlap, 2);
});

test('неправильные временные метки: отрицательные, NaN, обратный порядок и скачок в будущее чинятся безопасно', () => {
  const assembler = new TranscriptAssembler({ maxFutureDriftMs: 3000 });
  assembler.updateAudioWatermark(6000);

  // Отрицательные метки
  const neg = assembler.processEvent({
    utteranceId: 'bad-neg',
    isFinal: true,
    text: 'Сегмент с отрицательными метками',
    startMs: -500,
    endMs: -100,
  });
  assert.equal(neg.timestampRepaired, true);
  assert.ok(neg.segment.startMs >= 0);
  assert.ok(neg.segment.endMs >= neg.segment.startMs);

  // Перепутанные местами startMs > endMs
  const rev = assembler.processEvent({
    utteranceId: 'bad-rev',
    isFinal: true,
    text: 'Перепутанные метки времени',
    startMs: 3500,
    endMs: 2200,
  });
  assert.equal(rev.timestampRepaired, true);
  assert.equal(rev.segment.startMs, 2200);
  assert.equal(rev.segment.endMs, 3500);

  // NaN и огромный скачок в будущее
  const future = assembler.processEvent({
    utteranceId: 'bad-future',
    isFinal: true,
    text: 'Скачок в далёкое будущее',
    startMs: 99999999,
    endMs: Number.NaN,
  });
  assert.equal(future.timestampRepaired, true);
  assert.ok(future.segment.startMs <= 6000);
  assert.ok(future.segment.endMs >= future.segment.startMs);
  assert.equal(assembler.getStats().repairedTimestamps, 3);
});

test('SpeakerTimeline не выдумывает личность говорящего из текста, пока пользователь не задаст метку явно', () => {
  const assembler = new TranscriptAssembler();
  assembler.processEvent({
    utteranceId: 's1',
    isFinal: true,
    text: 'Всем привет, меня зовут Алексей Петров, я директор продукта.',
    startMs: 100,
    endMs: 2500,
    channel: 'system_loopback',
    speakerHint: 'remote:S1',
  });
  assembler.processEvent({
    utteranceId: 's2',
    isFinal: true,
    text: 'Привет, принято! Нужно подготовить план запуска до пятницы.',
    startMs: 2600,
    endMs: 4800,
    channel: 'microphone',
    speakerHint: 'local:mic',
  });

  const timeline = new SpeakerTimeline();
  const snap = timeline.rebuild(assembler.getFinals());

  assert.equal(snap.speakers.length, 2);
  const remoteSpeaker = snap.speakers.find((s) => s.speakerKey === 'remote:S1');
  assert.ok(remoteSpeaker);
  assert.equal(remoteSpeaker.identityVerified, false);
  assert.equal(remoteSpeaker.label.includes('Алексей'), false);
  assert.equal(remoteSpeaker.label.includes('Петров'), false);

  // Явное подтверждённое пользователем переименование разрешено
  assert.throws(
    () => timeline.setUserAssignedLabel('remote:S1', 'Алексей', { userConfirmed: false }),
    /явном действии пользователя/
  );
  const renamed = timeline.setUserAssignedLabel('remote:S1', 'Алексей (собеседник)', {
    userConfirmed: true,
  });
  assert.equal(renamed.identityVerified, true);
  assert.equal(renamed.attributionKind, 'user_labeled');
});

test('MeetingSummary формирует честный конспект со ссылками на сегменты и обрабатывает пустую расшифровку', () => {
  const generator = new MeetingSummaryGenerator();

  const empty = generator.generate({ sessionId: 'empty-1', finals: [] });
  assert.equal(empty.summary.meta.status, 'empty');
  assert.match(empty.summary.overview, /Недостаточно данных/);

  const assembler = new TranscriptAssembler();
  assembler.processEvent({
    utteranceId: 'm1',
    isFinal: true,
    text: 'Решили перенести интеграцию реального звука во второй этап.',
    startMs: 500,
    endMs: 3000,
    channel: 'microphone',
    speakerHint: 'local:mic',
  });
  assembler.processEvent({
    utteranceId: 'm2',
    isFinal: true,
    text: 'Нужно подготовить сравнение лицензий к завтрашнему дню. Кто возьмёт эту задачу?',
    startMs: 3200,
    endMs: 6100,
    channel: 'system_loopback',
    speakerHint: 'remote:S1',
  });

  const timeline = new SpeakerTimeline();
  const tlSnap = timeline.rebuild(assembler.getFinals());
  const built = generator.generate({
    sessionId: 'summary-1',
    finals: assembler.getFinals(),
    timelineSnapshot: tlSnap,
    assemblerStats: assembler.getStats(),
    isSynthetic: true,
  });

  assert.equal(built.summary.meta.status, 'ready');
  assert.equal(built.summary.decisions.length, 1);
  assert.equal(built.summary.decisions[0].segmentId, built.summary.topics[0].sourceSegmentIds[0]);
  assert.equal(built.summary.actionItems.length, 1);
  assert.equal(built.summary.openQuestions.length, 1);
  assert.match(built.markdown, /синтетический поток/i);
});

test('SpeakerTimeline фиксирует пересечение одновременной речи разных каналов', () => {
  const timeline = new SpeakerTimeline();
  const snap = timeline.rebuild([
    {
      segmentId: 'seg-1',
      utteranceId: 'o1',
      text: 'Я сейчас открою график нагрузки.',
      startMs: 1000,
      endMs: 3200,
      channel: 'system_loopback',
      speakerHint: 'remote:S1',
    },
    {
      segmentId: 'seg-2',
      utteranceId: 'o2',
      text: 'Да, видно пик на графике.',
      startMs: 2400,
      endMs: 4100,
      channel: 'microphone',
      speakerHint: 'local:mic',
    },
  ]);

  assert.equal(snap.turns.length, 2);
  assert.deepEqual(snap.turns[0].overlapsWithTurnIds, ['turn-2']);
  assert.deepEqual(snap.turns[1].overlapsWithTurnIds, ['turn-1']);
});
