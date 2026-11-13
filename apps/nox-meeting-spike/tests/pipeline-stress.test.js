'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PrivacyController,
  IsolatedSessionStore,
  SyntheticAudioStreamAdapter,
  SyntheticASRProvider,
  BackpressureQueue,
  SessionManager,
  buildSyntheticPcm16,
} = require('../src');

function makeTempDir(prefix = 'nox-c7-stress-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('поток из 1000 фрагментов: обработка, очистка очереди и раздельный замер задержек', async () => {
  const tmpDir = makeTempDir();
  try {
    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: false });
    const store = new IsolatedSessionStore({ baseDir: tmpDir });

    const adapter = new SyntheticAudioStreamAdapter({
      totalChunks: 1000,
      chunkDurationMs: 40,
      paceMs: 0,
    });
    const provider = new SyntheticASRProvider({
      simulatedDelayMs: 0,
      chunksPerFinal: 20,
    });
    const session = new SessionManager({
      sessionId: 'c7-1000-chunks',
      privacy,
      store,
      adapter,
      provider,
      queueOptions: { maxChunks: 2048, maxBytes: 8 * 1024 * 1024 },
    });

    await session.start();
    await new Promise((resolve) => {
      if (session._streamEnded) return resolve();
      session.once('stream_ended', resolve);
    });
    const snap = await session.finish();

    assert.equal(snap.state, 'completed');
    assert.equal(snap.metrics.chunksReceived, 1000);
    assert.equal(snap.metrics.chunksProcessed, 1000);
    // При 80% активных речевых окон (800 из 1000 фрагментов) и chunksPerFinal=20 ожидается 40 финалов
    assert.equal(snap.transcript.finals.length, 40);
    assert.equal(snap.metrics.backpressure.depth, 0);
    assert.equal(snap.metrics.backpressure.bytes, 0);
    assert.equal(snap.metrics.activeTimers, 0);
    assert.ok(snap.summary);
    assert.equal(snap.persistence.saved, false);

    // Проверка разделения метрик задержки
    assert.equal(snap.metrics.latency.pipelineIngestMs.count, 1000);
    assert.ok(snap.metrics.latency.pipelineAssemblyMs.count >= 50);
    assert.equal(snap.metrics.latency.simulatedAsrDelayMs.isSynthetic, true);
    assert.equal(snap.metrics.latency.simulatedAsrDelayMs.avgMs, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('backpressure: строгий предел памяти и очереди при переполнении', () => {
  const queue = new BackpressureQueue({
    maxChunks: 6,
    maxBytes: 6 * 3200,
    policy: 'drop_oldest',
  });

  const pressureTransitions = [];
  queue.on('pressure_change', (ev) => pressureTransitions.push(ev.current));

  for (let i = 0; i < 120; i += 1) {
    const pcm = buildSyntheticPcm16({ durationMs: 100, activeSpeech: i % 2 === 0 });
    const res = queue.enqueue({
      seq: i,
      startMs: i * 100,
      endMs: (i + 1) * 100,
      pcm,
      isSpeechLikely: i % 2 === 0,
    });
    assert.equal(res.accepted, true);
    assert.ok(queue.size <= 6);
    assert.ok(queue.bytes <= 6 * 3200);
  }

  const metrics = queue.getMetrics();
  assert.equal(metrics.peakChunks, 6);
  assert.equal(metrics.peakBytes, 6 * 3200);
  assert.equal(metrics.droppedChunks, 114);
  assert.ok(pressureTransitions.includes('high'));
  assert.ok(pressureTransitions.includes('overflow'));

  while (queue.dequeue()) {
    // дренирование
  }
  assert.equal(queue.pressureState, 'normal');
  assert.equal(queue.bytes, 0);
});

test('backpressure с политикой coalesce_silence вытесняет тишину раньше речи', () => {
  const queue = new BackpressureQueue({
    maxChunks: 3,
    maxBytes: 64 * 1024,
    policy: 'coalesce_silence',
  });

  const speech1 = { seq: 0, startMs: 0, endMs: 100, pcm: buildSyntheticPcm16({ activeSpeech: true }), isSpeechLikely: true };
  const silence1 = { seq: 1, startMs: 100, endMs: 200, pcm: buildSyntheticPcm16({ activeSpeech: false }), isSpeechLikely: false };
  const speech2 = { seq: 2, startMs: 200, endMs: 300, pcm: buildSyntheticPcm16({ activeSpeech: true }), isSpeechLikely: true };
  const speech3 = { seq: 3, startMs: 300, endMs: 400, pcm: buildSyntheticPcm16({ activeSpeech: true }), isSpeechLikely: true };

  queue.enqueue(speech1);
  queue.enqueue(silence1);
  queue.enqueue(speech2);
  const res = queue.enqueue(speech3);

  assert.deepEqual(res.dropped, [1]);
  const keptSeqs = [];
  let item;
  while ((item = queue.dequeue())) keptSeqs.push(item.seq);
  assert.deepEqual(keptSeqs, [0, 2, 3]);
});

test('остановка посреди обработки при зависшем провайдере не блокирует процесс и обнуляет таймеры', async () => {
  const tmpDir = makeTempDir();
  try {
    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: false });
    const store = new IsolatedSessionStore({ baseDir: tmpDir });

    const adapter = new SyntheticAudioStreamAdapter({
      totalChunks: 500,
      chunkDurationMs: 50,
      paceMs: 2,
    });
    const hungProvider = new SyntheticASRProvider({
      hangOnChunkSeq: 4,
      hangOnCloseMs: 5000,
    });

    const session = new SessionManager({
      sessionId: 'c7-cancel-hung',
      privacy,
      store,
      adapter,
      provider: hungProvider,
      stopGraceMs: 80,
      recoveryOptions: { stallTimeoutMs: 5000 },
    });

    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 40));

    const t0 = Date.now();
    const res = await session.cancel('user_emergency_stop');
    const elapsedMs = Date.now() - t0;

    assert.equal(res.state, 'cancelled');
    assert.ok(elapsedMs < 400, `Отмена должна укладываться в таймаут, заняла ${elapsedMs}мс`);
    assert.equal(res.cancelReport.forcedTimeout, true);
    assert.equal(res.cancelReport.remainingTimers, 0);
    assert.equal(session.getMetrics().activeTimers, 0);
    assert.equal(session.getMetrics().backpressure.depth, 0);

    // Позднее событие от провайдера после отмены не проходит ни через отписанный провайдер, ни при прямой передаче
    const finalsBeforeLate = session.getSnapshot().transcript.finals.length;
    hungProvider.emit('final', {
      utteranceId: 'after-cancel',
      isFinal: true,
      text: 'Не должно попасть в транскрипт',
      startMs: 500,
      endMs: 1000,
    });
    session._onAsrEvent(
      {
        utteranceId: 'after-cancel-inflight',
        isFinal: true,
        text: 'Не должно попасть в транскрипт после отмены',
        startMs: 500,
        endMs: 1000,
      },
      true
    );
    assert.equal(session.getSnapshot().transcript.finals.length, finalsBeforeLate);
    assert.equal(session.getSnapshot().transcript.stats.droppedAfterCancel, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
