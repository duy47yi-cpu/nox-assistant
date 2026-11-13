'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PrivacyController,
  ConsentRequiredError,
  HardwareAccessForbiddenError,
  IsolatedSessionStore,
  SyntheticAudioStreamAdapter,
  SyntheticASRProvider,
  SessionManager,
  STANDUP_UTTERANCES,
} = require('../src');

function makeTempDir(prefix = 'nox-c7-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('отсутствие согласия: старт без captureConsent блокируется с ConsentRequiredError', async () => {
  const tmpDir = makeTempDir();
  try {
    const privacy = new PrivacyController();
    const store = new IsolatedSessionStore({ baseDir: tmpDir });
    const adapter = new SyntheticAudioStreamAdapter({ totalChunks: 5, paceMs: 0 });
    const provider = new SyntheticASRProvider();
    const session = new SessionManager({ privacy, store, adapter, provider });

    await assert.rejects(
      () => session.start(),
      (err) => err instanceof ConsentRequiredError && err.code === 'CONSENT_REQUIRED'
    );

    assert.equal(session.state, 'idle');
    assert.equal(session.getMetrics().chunksReceived, 0);
    assert.deepEqual(store.listSessions(), []);
    assert.throws(() => privacy.grantConsent({ captureConsent: false }), ConsentRequiredError);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('запрет реального микрофона и системного звука на этапе прототипа', async () => {
  const tmpDir = makeTempDir();
  try {
    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: false });
    const store = new IsolatedSessionStore({ baseDir: tmpDir });

    const fakeHardwareAdapter = {
      sourceKind: 'wasapi_loopback',
      on() {},
      removeListener() {},
      async start() {},
      async stop() {},
    };
    const provider = new SyntheticASRProvider();
    const session = new SessionManager({ privacy, store, adapter: fakeHardwareAdapter, provider });

    await assert.rejects(
      () => session.start(),
      (err) => err instanceof HardwareAccessForbiddenError && err.code === 'HARDWARE_CAPTURE_FORBIDDEN'
    );
    assert.equal(privacy.getPolicySnapshot().microphoneAccessAllowed, false);
    assert.equal(privacy.getPolicySnapshot().systemAudioAccessAllowed, false);
    assert.equal(privacy.getPolicySnapshot().externalNetworkAllowed, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('корректная работа без доступа к микрофону: полный жизненный цикл, пауза, завершение и очистка', async () => {
  const tmpDir = makeTempDir();
  try {
    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: true, actor: 'qa-owner' });
    const store = new IsolatedSessionStore({ baseDir: tmpDir });

    const adapter = new SyntheticAudioStreamAdapter({
      utterances: STANDUP_UTTERANCES.slice(0, 3),
      chunkDurationMs: 200,
      paceMs: 8,
    });
    const provider = new SyntheticASRProvider({ simulatedDelayMs: 4 });
    const session = new SessionManager({
      sessionId: 'c7-lifecycle-1',
      privacy,
      store,
      adapter,
      provider,
    });

    const states = [];
    session.on('state_change', (ev) => states.push(ev.state));

    await session.start();
    assert.equal(session.state, 'recording');

    await new Promise((resolve) => setTimeout(resolve, 60));
    await session.pause();
    assert.equal(session.state, 'paused');

    const countDuringPause = session.getMetrics().chunksReceived;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(session.getMetrics().chunksReceived, countDuringPause);

    await session.resume();
    assert.equal(session.state, 'recording');

    await new Promise((resolve) => {
      if (session._streamEnded) return resolve();
      session.once('stream_ended', resolve);
    });

    const finished = await session.finish();
    assert.equal(finished.state, 'completed');
    assert.ok(finished.transcript.finals.length >= 2);
    assert.ok(finished.summary);
    assert.equal(finished.summary.meta.isSyntheticInput, true);
    assert.equal(finished.persistence.saved, true);
    assert.equal(finished.metrics.activeTimers, 0);
    assert.equal(finished.metrics.backpressure.depth, 0);
    assert.equal(finished.metrics.backpressure.bytes, 0);
    assert.equal(store.listSessions().length, 1);

    assert.ok(states.includes('starting'));
    assert.ok(states.includes('recording'));
    assert.ok(states.includes('paused'));
    assert.ok(states.includes('stopping'));
    assert.ok(states.includes('completed'));

    // Очистка и удаление тестовой сессии
    const delResult = await session.deleteSession();
    assert.equal(delResult.deleted, true);
    assert.equal(session.state, 'idle');
    assert.equal(session.getSnapshot().transcript.finals.length, 0);
    assert.equal(session.getSnapshot().summary, null);
    assert.equal(store.listSessions().length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('отзыв согласия посреди сессии немедленно останавливает поток и очищает память', async () => {
  const tmpDir = makeTempDir();
  try {
    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: false });
    const store = new IsolatedSessionStore({ baseDir: tmpDir });
    const adapter = new SyntheticAudioStreamAdapter({
      utterances: STANDUP_UTTERANCES,
      chunkDurationMs: 200,
      paceMs: 10,
    });
    const provider = new SyntheticASRProvider({ simulatedDelayMs: 5 });
    const session = new SessionManager({ privacy, store, adapter, provider });

    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 45));

    await privacy.revokeConsent('user_clicked_revoke');
    assert.equal(session.state, 'cancelled');
    assert.equal(session.getSnapshot().transcript.finals.length, 0);
    assert.equal(session.getSnapshot().summary, null);
    assert.equal(session.getMetrics().activeTimers, 0);
    assert.deepEqual(store.listSessions(), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
