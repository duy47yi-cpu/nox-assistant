#!/usr/bin/env node
'use strict';

// Проверка голоса без окна: читает .env, синтезирует пробную фразу и проигрывает её.
//   node scripts/check-voice.js
//   node scripts/check-voice.js "Своя фраза"
//   node scripts/check-voice.js --no-play "Только синтез"
// Ключ и модель нигде не печатаются: только результат и время.
const fs = require('fs');
const path = require('path');
const { loadEnvFile } = require('../src/config/env');
const { FishSpeech } = require('../src/voice/fish');
const { SpeechClient } = require('../src/voice/tts');

const ROOT = path.join(__dirname, '..', '..', '..');
const args = process.argv.slice(2);
const noPlay = args.includes('--no-play');
const text = args.find((arg) => !arg.startsWith('--')) || 'Привет! Это проверка голоса. Слышно хорошо?';

function report(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function envFile() {
  try { return loadEnvFile(path.join(ROOT, '.env')); } catch { return {}; }
}

(async () => {
  const env = envFile();
  const fish = new FishSpeech({
    apiKey: env.FISH_API_KEY || '',
    voiceId: env.FISH_VOICE_ID || null,
    model: env.FISH_TTS_MODEL || undefined,
  });
  if (fish.isInstalled()) {
    const started = Date.now();
    try {
      if (noPlay) {
        const file = await fish.synthesize(text);
        const bytes = fs.statSync(file).size;
        fs.rmSync(file, { force: true });
        report({ ok: true, provider: 'облачный', mode: 'синтез', ms: Date.now() - started, bytes });
      } else {
        await fish.speak(text);
        report({ ok: true, provider: 'облачный', mode: 'синтез и проигрывание', ms: Date.now() - started });
      }
      return;
    } catch (err) {
      report({ ok: false, provider: 'облачный', error: String((err && err.message) || err) });
      process.exitCode = 2;
      return;
    }
  }

  const local = new SpeechClient({ timeoutMs: 20000 });
  if (!local.isInstalled()) {
    report({ ok: false, error: 'Голос не настроен: впишите ключ в .env (FISH_API_KEY=).' });
    process.exitCode = 3;
    return;
  }
  const started = Date.now();
  try {
    if (noPlay) {
      const file = await local.synthesize(text);
      report({ ok: true, provider: 'локальный', mode: 'синтез', ms: Date.now() - started, file });
    } else {
      await local.speak(text);
      report({ ok: true, provider: 'локальный', mode: 'синтез и проигрывание', ms: Date.now() - started });
    }
  } catch (err) {
    report({ ok: false, provider: 'локальный', error: String((err && err.message) || err) });
    process.exitCode = 2;
  } finally {
    local.stop();
  }
})();
