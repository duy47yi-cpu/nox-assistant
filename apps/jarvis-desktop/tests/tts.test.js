'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { ReplySpeech } = require('../src/voice/tts');
const { cloudSpeech, voiceOutputMode, voiceOutputError } = require('../src/voice/output');
const { wavFromPcm } = require('../src/voice/stt');

test('настройки старого синтеза не включают озвучку, даже при настроенном облаке', () => {
  const provider = { isInstalled: () => true };
  for (const voiceEngine of [undefined, 'local', 'system', 'realistic', 'cloud']) {
    const settings = { voice: true, voiceEngine, voiceLatency: 'low', speechSpeakers: { system: 'Windows' } };
    assert.equal(voiceOutputMode(settings), 'off');
    assert.match(voiceOutputError(settings, provider), /Озвучка выключена/u);
  }
  for (const voiceOutput of ['local', 'system', 'realistic', true, false]) {
    assert.equal(voiceOutputMode({ voiceOutput }), 'off');
  }
  assert.equal(voiceOutputError({ voiceOutput: 'cloud' }, provider), null);
  assert.match(voiceOutputError({ voiceOutput: 'cloud', quiet: true }, provider), /тихий режим/u);
  assert.match(voiceOutputError({ voiceOutput: 'cloud' }, { isInstalled: () => false }), /не настроена/u);
});

function fixtureSpeech(play, fetchImpl = async () => new Response(wavFromPcm(Buffer.alloc(640)))) {
  return cloudSpeech({ url: 'https://example.invalid/voice', model: 'test', voice: 'cloud', fetchImpl, play });
}

test('облачный WAV воспроизводится с заданной громкостью, временный файл удаляется', async () => {
  let played;
  const voice = fixtureSpeech(async (file, opts) => {
    played = file;
    assert.equal(opts.volume, 0.55);
    assert.deepEqual(await fs.readFile(file), wavFromPcm(Buffer.alloc(640)));
  }, async (url, options) => {
    assert.equal(url, 'https://example.invalid/voice');
    assert.deepEqual(JSON.parse(options.body), { input: 'ответ', model: 'test', voice: 'cloud', speed: 1, response_format: 'wav' });
    return new Response(wavFromPcm(Buffer.alloc(640)));
  });
  await voice.speak('ответ', { volume: 0.55, speaker: 'system', rate: 2 });
  assert.ok(played);
  await assert.rejects(fs.stat(played), { code: 'ENOENT' });
});

test('ошибка облака не запускает воспроизведение', async () => {
  const cannotPlay = () => assert.fail('playback called for malformed audio');
  const failed = fixtureSpeech(cannotPlay, async () => new Response('', { status: 503 }));
  await assert.rejects(failed.speak('ответ'), /недоступен/u);
  const nonWav = fixtureSpeech(cannotPlay, async () => new Response('RIFFinvalid'));
  await assert.rejects(nonWav.speak('ответ'), /получить звук/u);
});

test('начало диктовки прерывает озвучку ответа, включая воспроизведение облачного WAV', async () => {
  let started;
  const playing = new Promise((resolve) => { started = resolve; });
  const voice = fixtureSpeech((file, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started(file);
  }));
  const errors = [];
  const reply = new ReplySpeech({ voice, onError: (error) => errors.push(error) });
  const talking = reply.speak('ответ');
  const file = await playing;
  reply.stop();
  await talking;
  assert.deepEqual(errors, []);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('новый ответ заменяет старый, а при включённом микрофоне ответ не озвучивается', async () => {
  const signals = [];
  let listening = false;
  const voice = { speak(_text, { signal }) {
    signals.push(signal);
    return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  } };
  const reply = new ReplySpeech({ voice, isListening: () => listening });
  const first = reply.speak('первый');
  const second = reply.speak('второй');
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  await first;
  listening = true;
  await reply.speak('третий');
  assert.equal(signals.length, 2);
  reply.stop();
  await second;
  assert.equal(signals[1].aborted, true);
});
