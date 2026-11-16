'use strict';

// node scripts/read-aloud-check.js [--audio]
// Стенд облачной озвучки возвращает WAV с контрольным тоном. --audio включает штатное проигрывание.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { desktopTools, getReader, setSpeaker } = require('../src/tools/desktop');
const { cloudSpeech, voiceOutputError } = require('../src/voice/output');
const { playWav } = require('../src/voice/tts');
const { wavFromPcm } = require('../src/voice/stt');

const parts = ['Первый фрагмент.', 'Второй фрагмент.', 'Третий фрагмент.'];

function waitForPlayback(signal, start) {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, 200);
    signal.addEventListener('abort', stop, { once: true });
    start();
  });
}

async function main() {
  const audio = process.argv.includes('--audio');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nox-read-aloud-check-'));
  const fixture = path.join(root, 'document.txt');
  const pcm = Buffer.alloc(16000 * 2 * 2);
  for (let sample = 0; sample < pcm.length / 2; sample++) {
    pcm.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 440 / 16000) * 1200), sample * 2);
  }
  const wav = wavFromPcm(pcm);
  const requests = [];
  const played = [];
  let playback = Promise.withResolvers();
  let settings = {};
  const provider = cloudSpeech({
    url: 'https://example.invalid/speak',
    model: 'fixture',
    voice: 'fixture',
    fetchImpl: async (_url, { body }) => {
      requests.push(JSON.parse(body).input);
      return new Response(wav);
    },
    play: async (file, opts) => {
      assert.deepEqual(await fs.readFile(file), wav);
      const start = () => playback.resolve(requests.at(-1));
      if (audio) {
        const playing = playWav(file, opts);
        start();
        await playing;
      } else {
        await waitForPlayback(opts.signal, start);
      }
      played.push(requests.at(-1));
    },
  });
  const speak = (text, signal) => provider.speak(text, { signal, volume: 0.5 });
  setSpeaker(speak, () => voiceOutputError(settings, provider));
  const reader = getReader();
  const tool = desktopTools.find(({ name }) => name === 'read_clipboard_aloud');
  try {
    await fs.writeFile(fixture, parts.join(' '));
    assert.deepEqual(await tool.run({ source: 'file', path: fixture }), {
      ok: false, summary: 'Озвучка выключена. Включите облачную озвучку в настройках.', data: {},
    });
    assert.equal(requests.length, 0);
    settings = { voiceOutput: 'cloud' };
    const read = await tool.run({ source: 'file', path: fixture });
    assert.equal(read.data.total, 3);
    assert.equal(await playback.promise, parts[0]);
    playback = Promise.withResolvers();
    assert.equal(await playback.promise, parts[1]);
    assert.deepEqual(played, [parts[0]]);
    assert.equal((await tool.run({ action: 'pause' })).data.state, 'paused');
    playback = Promise.withResolvers();
    assert.equal((await tool.run({ action: 'resume' })).data.state, 'playing');
    assert.equal(await playback.promise, parts[1]);
    assert.equal((await tool.run({ action: 'stop' })).data.state, 'stopped');
    await reader.finished();
    assert.deepEqual(requests, [parts[0], parts[1], parts[1]]);
    assert.deepEqual(played, [parts[0]]);
    assert.equal(reader.busy, false);
    console.log('READ_ALOUD_CHECK ' + JSON.stringify({ ok: true, parts: read.data.total, resumedSamePart: true, stopped: true, silenceByDefault: true, audio }));
  } finally {
    reader.stop();
    await reader.finished();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const timeout = setTimeout(() => {
  console.error('Не дождались чтения вслух.');
  process.exit(1);
}, 15000);
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
