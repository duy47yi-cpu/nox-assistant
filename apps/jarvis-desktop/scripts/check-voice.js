'use strict';

// node scripts/check-voice.js [rev directory]
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cloudSpeech, voiceOutputMode, voiceOutputError } = require('../src/voice/output');
const { createSttRouter, cloudProvider, localGigaam, wavFromPcm } = require('../src/voice/stt');

async function main() {
  const rev = process.argv[2];
  const samples = rev
    ? execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(rev, '_probe', 'cmd', 's1.wav'), '-ac', '1', '-ar', '16000', '-f', 's16le', '-'])
    : Buffer.alloc(640);
  const local = rev
    ? localGigaam({ folder: () => path.join(rev, '_models', 'gigaam'), script: path.join(__dirname, 'tts', 'gigaam-worker.py') })
    : { name: 'локальный', isAvailable: () => true, transcribe: async () => ({ text: 'сверни все окна' }) };

  let cloudRequests = 0;
  let failCloud = false;
  const cloud = cloudProvider({
    url: 'https://example.invalid/asr',
    model: 'fixture',
    request: async (_url, { body }) => {
      cloudRequests++;
      assert.deepEqual(Buffer.from(await body.get('file').arrayBuffer()), wavFromPcm(samples));
      return failCloud ? { ok: false } : { ok: true, json: async () => ({ text: 'который час' }) };
    },
  });
  const router = createSttRouter({ local, cloud, online: () => true });
  try {
    const { text } = await router.transcribe(samples, { engine: 'auto', language: 'ru' });
    assert.match(text, /сверни все окна/u);
    assert.equal(cloudRequests, 0);
    assert.equal((await router.transcribe(samples, { engine: 'cloud' })).text, 'который час');
    failCloud = true;
    assert.match((await router.transcribe(samples, { engine: 'cloud', language: 'ru' })).text, /сверни все окна/u);
    assert.equal(cloudRequests, 2);

    const configured = cloudSpeech({ url: 'https://example.invalid/speak', model: 'fixture', voice: 'fixture' });
    for (const voiceEngine of ['system', 'local', 'realistic', 'cloud', undefined]) {
      const legacy = { voice: true, voiceEngine, voiceLatency: 'quality' };
      assert.equal(voiceOutputMode(legacy), 'off');
      assert.match(voiceOutputError(legacy, configured), /Озвучка выключена/u);
    }
    assert.equal(voiceOutputError({ voiceOutput: 'cloud' }, configured), null);
    assert.match(voiceOutputError({ voiceOutput: 'cloud' }, cloudSpeech({})), /не настроена/u);

    console.log(JSON.stringify({ ok: true, local: { text, fixture: !rev }, cloud: { requests: cloudRequests, fallback: true }, legacyOutput: 'off' }));
  } finally {
    local.stop?.();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
