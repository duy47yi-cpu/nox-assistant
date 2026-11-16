'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const { playWav } = require('./tts');

const VOICE_OUTPUTS = ['off', 'cloud'];

function voiceOutputMode(settings) {
  return settings.voiceOutput === 'cloud' ? 'cloud' : 'off';
}

function voiceOutputError(settings, provider) {
  if (voiceOutputMode(settings) === 'off') return 'Озвучка выключена. Включите облачную озвучку в настройках.';
  if (settings.quiet === true) return 'Включён тихий режим.';
  if (!provider.isInstalled()) return 'Облачная озвучка не настроена.';
  return null;
}

function cloudSpeech({ url, key, model, voice, play = playWav, fetchImpl = fetch }) {
  const isInstalled = () => Boolean(url && model && voice);
  return {
    isInstalled,
    async speak(text, { signal, volume } = {}) {
      if (!isInstalled()) throw new Error('Облачный голос не настроен.');
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers.Authorization = 'Bearer ' + key;
      const timeout = AbortSignal.timeout(15000);
      const response = await fetchImpl(url, {
        method: 'POST', headers, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        body: JSON.stringify({ input: text, model, voice, speed: 1, response_format: 'wav' }),
      });
      if (!response.ok) throw new Error('Облачный голос недоступен.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 44 || bytes.length > 8 * 1024 * 1024
        || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Не удалось получить звук.');
      }
      const file = path.join(os.tmpdir(), 'nox-voice-' + randomUUID() + '.wav');
      try {
        await fs.writeFile(file, bytes, { flag: 'wx', signal });
        await play(file, { signal, volume, rate: 1 });
      } finally {
        await fs.rm(file, { force: true });
      }
    },
  };
}

module.exports = { VOICE_OUTPUTS, voiceOutputMode, voiceOutputError, cloudSpeech };
