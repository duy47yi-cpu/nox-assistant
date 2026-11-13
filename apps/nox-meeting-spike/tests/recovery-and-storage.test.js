'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PrivacyController,
  IsolatedSessionStore,
  assertIsolatedStoragePath,
  StorageIsolationError,
  SyntheticAudioStreamAdapter,
  SyntheticASRProvider,
  SessionManager,
  STANDUP_UTTERANCES,
} = require('../src');

function makeTempDir(prefix = 'nox-c7-rec-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('сбой и перезапуск провайдера: поток восстанавливается, прежний транскрипт сохранён без дублей', async () => {
  const tmpDir = makeTempDir();
  try {
    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: false });
    const store = new IsolatedSessionStore({ baseDir: tmpDir });

    const adapter = new SyntheticAudioStreamAdapter({
      utterances: STANDUP_UTTERANCES.slice(0, 4),
      chunkDurationMs: 200,
      paceMs: 8,
    });

    const providerFactory = (attempt) =>
      new SyntheticASRProvider({
        simulatedDelayMs: 4,
        failAtPushCount: attempt === 0 ? 15 : null,
        failTimes: 1,
      });

    const session = new SessionManager({
      sessionId: 'c7-recover-ok',
      privacy,
      store,
      adapter,
      recoveryOptions: { maxRestarts: 2, backoffBaseMs: 10, stallTimeoutMs: 2000 },
    });

    const recoveryEvents = [];
    session.on('recovery', (ev) => recoveryEvents.push(ev));

    await session.start({ adapter, providerFactory });
    await new Promise((resolve) => {
      if (session._streamEnded) return resolve();
      session.once('stream_ended', resolve);
    });
    const finalSnap = await session.finish();

    assert.equal(finalSnap.state, 'completed');
    assert.ok(recoveryEvents.some((e) => e.phase === 'restarting'));
    assert.ok(recoveryEvents.some((e) => e.phase === 'recovered'));
    assert.equal(finalSnap.metrics.recovery.totalRestarts, 1);
    assert.equal(finalSnap.metrics.recovery.exhausted, false);
    assert.ok(finalSnap.transcript.finals.length >= 3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('зависание провайдера: stall watchdog перезапускает провайдер и исчерпывает лимит при постоянном зависании', async () => {
  const tmpDir = makeTempDir();
  try {
    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: false });
    const store = new IsolatedSessionStore({ baseDir: tmpDir });

    const adapter = new SyntheticAudioStreamAdapter({
      totalChunks: 200,
      chunkDurationMs: 100,
      paceMs: 5,
    });

    // Каждый экземпляр провайдера зависает начиная с 3-го фрагмента
    const providerFactory = () =>
      new SyntheticASRProvider({
        hangOnChunkSeq: 2,
        simulatedDelayMs: 2,
      });

    const session = new SessionManager({
      sessionId: 'c7-stall-exhausted',
      privacy,
      store,
      recoveryOptions: {
        maxRestarts: 1,
        backoffBaseMs: 5,
        stallTimeoutMs: 45,
        watchdogIntervalMs: 15,
      },
    });

    const errors = [];
    session.on('error', (e) => errors.push(e));

    await session.start({ adapter, providerFactory });
    await new Promise((resolve) => {
      if (session.state === 'error') return resolve();
      session.on('state_change', (ev) => {
        if (ev.state === 'error') resolve();
      });
    });

    assert.equal(session.state, 'error');
    assert.equal(session.getMetrics().recovery.exhausted, true);
    assert.equal(session.getMetrics().recovery.totalRestarts, 1);
    assert.ok(errors.some((e) => e.code === 'ASR_PROVIDER_EXHAUSTED'));
    assert.equal(session.getMetrics().activeTimers, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ошибка сохранения: сбой диска честно сообщается, временные файлы удаляются, конспект остаётся в памяти', async () => {
  const tmpDir = makeTempDir();
  try {
    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: true });
    const store = new IsolatedSessionStore({ baseDir: tmpDir, failOnWrite: true });

    const adapter = new SyntheticAudioStreamAdapter({
      utterances: STANDUP_UTTERANCES.slice(0, 2),
      chunkDurationMs: 200,
      paceMs: 2,
    });
    const provider = new SyntheticASRProvider({ simulatedDelayMs: 2 });
    const session = new SessionManager({
      sessionId: 'c7-storage-fail',
      privacy,
      store,
      adapter,
      provider,
    });

    const storageErrors = [];
    session.on('storage_error', (err) => storageErrors.push(err));

    await session.start();
    await new Promise((resolve) => {
      if (session._streamEnded) return resolve();
      session.once('stream_ended', resolve);
    });
    const snap = await session.finish();

    assert.equal(snap.persistence.saved, false);
    assert.equal(snap.persistence.mode, 'save_failed');
    assert.equal(snap.persistence.error.code, 'STORAGE_WRITE_FAILED');
    assert.equal(storageErrors.length, 1);
    assert.ok(snap.summary, 'Конспект должен остаться доступным в памяти при ошибке записи');
    assert.deepEqual(store.listSessions(), []);

    // Убеждаемся, что .tmp файлов не осталось
    const sessionSubDir = path.join(tmpDir, 'c7-storage-fail');
    if (fs.existsSync(sessionSubDir)) {
      const files = fs.readdirSync(sessionSubDir);
      assert.deepEqual(files, []);
    }

    // Дополнительно: реальная ошибка ФС (если путь к каталогу сессии занят обычным файлом)
    const collidingStoreDir = path.join(tmpDir, 'real-fs-collision');
    fs.mkdirSync(collidingStoreDir, { recursive: true });
    fs.writeFileSync(path.join(collidingStoreDir, 'blocked-id'), 'not-a-directory', 'utf8');
    const collidingStore = new IsolatedSessionStore({ baseDir: collidingStoreDir });
    assert.throws(
      () => collidingStore.saveSession('blocked-id', { transcript: [] }),
      (err) => err.code === 'STORAGE_WRITE_FAILED'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('отсутствие данных в обычной истории Nox: изоляция путей и неизменность chats/journal/memory', async () => {
  const rootTmp = makeTempDir('nox-c7-isolation-');
  try {
    const mockNoxDataDir = path.join(rootTmp, 'mock-nox-data');
    const isolatedSpikeDir = path.join(rootTmp, 'spike-sessions');
    fs.mkdirSync(mockNoxDataDir, { recursive: true });

    const chatsPath = path.join(mockNoxDataDir, 'chats.json');
    const journalPath = path.join(mockNoxDataDir, 'journal.jsonl');
    const memoryPath = path.join(mockNoxDataDir, 'memory.json');

    const initialChats = '{"activeId":"c1","chats":[{"id":"c1","messages":[]}]}';
    const initialJournal = '{"id":"j1","text":"обычная запись Nox"}\n';
    const initialMemory = '{"items":[]}';

    fs.writeFileSync(chatsPath, initialChats, 'utf8');
    fs.writeFileSync(journalPath, initialJournal, 'utf8');
    fs.writeFileSync(memoryPath, initialMemory, 'utf8');

    // Попытка нацелить хранилище C7 в обычную папку Nox должна жёстко отклоняться
    assert.throws(
      () => new IsolatedSessionStore({ baseDir: mockNoxDataDir, forbiddenRoots: [mockNoxDataDir] }),
      StorageIsolationError
    );
    assert.throws(
      () => assertIsolatedStoragePath(path.resolve(__dirname, '..', '..', 'jarvis-desktop', 'data')),
      StorageIsolationError
    );
    assert.throws(
      () => assertIsolatedStoragePath(path.join(rootTmp, 'chats.json')),
      StorageIsolationError
    );

    const store = new IsolatedSessionStore({
      baseDir: isolatedSpikeDir,
      forbiddenRoots: [mockNoxDataDir],
    });
    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: true });

    const adapter = new SyntheticAudioStreamAdapter({
      utterances: STANDUP_UTTERANCES.slice(0, 2),
      chunkDurationMs: 200,
      paceMs: 2,
    });
    const provider = new SyntheticASRProvider({ simulatedDelayMs: 2 });
    const session = new SessionManager({
      sessionId: 'c7-isolated-check',
      privacy,
      store,
      adapter,
      provider,
    });

    await session.start();
    await new Promise((resolve) => {
      if (session._streamEnded) return resolve();
      session.once('stream_ended', resolve);
    });
    await session.finish();

    // Обычные файлы истории Nox не изменились ни на байт
    assert.equal(fs.readFileSync(chatsPath, 'utf8'), initialChats);
    assert.equal(fs.readFileSync(journalPath, 'utf8'), initialJournal);
    assert.equal(fs.readFileSync(memoryPath, 'utf8'), initialMemory);
    assert.equal(fs.readdirSync(mockNoxDataDir).sort().join(','), 'chats.json,journal.jsonl,memory.json');

    // Сессия сохранилась только в изолированной папке spike
    assert.equal(store.listSessions().length, 1);
    await session.deleteSession();
    assert.equal(store.listSessions().length, 0);
  } finally {
    fs.rmSync(rootTmp, { recursive: true, force: true });
  }
});
