'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PrivacyController,
  IsolatedSessionStore,
  SyntheticAudioStreamAdapter,
  SyntheticASRProvider,
  SessionManager,
  STANDUP_UTTERANCES,
} = require('../src');

async function runDemo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-c7-demo-'));
  console.log('=== NOX C7 DEMO (СИНТЕТИЧЕСКИЕ ДАННЫЕ · БЕЗ МИКРОФОНА И СЕТИ) ===\n');

  try {
    const privacy = new PrivacyController();
    const store = new IsolatedSessionStore({ baseDir: tmpDir });

    const adapter = new SyntheticAudioStreamAdapter({
      utterances: STANDUP_UTTERANCES,
      chunkDurationMs: 250,
      paceMs: 20,
    });

    const providerFactory = (attempt) =>
      new SyntheticASRProvider({
        simulatedDelayMs: 12,
        // На первом подключении имитируем кратковременный обрыв после 18 фрагментов
        failAtPushCount: attempt === 0 ? 18 : null,
        failTimes: 1,
      });

    const session = new SessionManager({
      sessionId: 'demo-standup-01',
      privacy,
      store,
      recoveryOptions: { maxRestarts: 2, backoffBaseMs: 25, stallTimeoutMs: 2000 },
    });

    console.log(`[Состояние до запуска] ${session.state} (Не записывает)`);

    // Проверка защиты без согласия
    try {
      await session.start({ adapter, providerFactory });
    } catch (err) {
      console.log(`[Проверка согласия] Отказ без согласия: ${err.code} — ${err.message}`);
    }

    // Явное согласие пользователя
    privacy.grantConsent({
      captureConsent: true,
      storageConsent: true,
      actor: 'demo-script',
    });
    console.log('[Согласие] Получено явное согласие на синтетический поток и изолированное хранение.\n');

    session.on('partial_transcript', ({ partial }) => {
      process.stdout.write(`  [partial] (${partial.utteranceId}) ${partial.text}\n`);
    });
    session.on('final_transcript', ({ segment }) => {
      console.log(`  [FINAL]   [${segment.startMs}..${segment.endMs}мс] ${segment.text}`);
    });
    session.on('recovery', (ev) => {
      console.log(`  [RECOVERY] phase=${ev.phase} attempt=${ev.attempt || '-'}`);
    });

    await session.start({ adapter, providerFactory });

    await new Promise((resolve) => {
      if (session._streamEnded) return resolve();
      session.once('stream_ended', resolve);
    });

    const result = await session.finish();
    console.log('\n--- ИТОГОВЫЙ КОНСПЕКТ ---');
    console.log(result.summaryMarkdown);

    console.log('--- МЕТРИКИ КОНВЕЙЕРА (ОТДЕЛЬНО ОТ СИНТЕТИЧЕСКОГО ASR) ---');
    console.log(JSON.stringify(result.metrics.latency, null, 2));

    // Очистка после демо
    const del = await session.deleteSession();
    console.log(`\n[Удаление тестовой сессии] deleted=${del.deleted}, state=${del.state}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runDemo().catch((err) => {
  console.error('Ошибка демо-сценария C7:', err);
  process.exit(1);
});
