'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ASRProvider,
  RealASRProvider,
  AsrBackpressureError,
  AsrTimeoutError,
  AsrMemoryLimitError,
  ModelStore,
  SessionManager,
  PrivacyController,
  ConsentRequiredError,
  HardwareAccessForbiddenError,
  SyntheticAudioStreamAdapter,
  IsolatedSessionStore,
  pcm16leToFloat32,
  resampleLinearFloat32,
  parseWavBuffer,
  inspectRuntimeCompatibility,
  loadSherpaOnnx,
  isInsidePlainAsar,
  SherpaRuntimeNotInstalledError,
} = require('../src');

function createIsolatedFakeModelDir(modelId = 'ru-zipformer-vosk-int8') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-asr-contract-model-'));
  const dir = path.join(root, modelId);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt', 'NOTICE']) {
    fs.writeFileSync(path.join(dir, name), `stub:${name}\n`);
  }
  return {
    root,
    dir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function makePcmChunk({ seq, channel = 'microphone', durationMs = 100, sampleRate = 16000, startMs = 0 }) {
  const sampleCount = Math.round((sampleRate * durationMs) / 1000);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    const val = Math.round(Math.sin((2 * Math.PI * 300 * i) / sampleRate) * 6000);
    pcm.writeInt16LE(val, i * 2);
  }
  return {
    seq,
    channel,
    sampleRate,
    channels: 1,
    startMs,
    endMs: startMs + durationMs,
    durationMs,
    speakerHint: channel === 'microphone' ? 'local:mic' : 'remote:system',
    pcm,
  };
}

function createMockSherpaBinding({ endpointAtChunk = 3 } = {}) {
  const createdConfigs = [];
  const freedStreams = [];
  let recognizerFreed = 0;
  let streamSeq = 0;

  class MockStream {
    constructor() {
      this.id = ++streamSeq;
      this.chunks = 0;
      this.finished = false;
      this.pendingDecode = false;
      this.fedInputs = [];
    }

    acceptWaveform({ sampleRate, samples }) {
      assert.equal(samples instanceof Float32Array, true, 'Must pass plain Float32Array to acceptWaveform');
      this.chunks += 1;
      this.pendingDecode = true;
      this.fedInputs.push({ sampleRate, len: samples.length });
    }

    inputFinished() {
      this.finished = true;
    }

    free() {
      freedStreams.push(this.id);
    }
  }

  class MockOnlineRecognizer {
    constructor(config) {
      createdConfigs.push(config);
    }

    createStream() {
      return new MockStream();
    }

    isReady(stream) {
      return stream.pendingDecode;
    }

    decode(stream) {
      stream.pendingDecode = false;
    }

    getResult(stream) {
      const label = stream.id === 1 ? 'микрофон' : 'собеседник';
      const words = Array.from({ length: stream.chunks }, (_, idx) => `${label}${idx + 1}`);
      return { text: words.join(' '), confidence: 0.91 };
    }

    isEndpoint(stream) {
      return stream.chunks >= endpointAtChunk;
    }

    reset(stream) {
      stream.chunks = 0;
      stream.pendingDecode = false;
      stream.finished = false;
    }

    free() {
      recognizerFreed += 1;
    }
  }

  return {
    binding: { OnlineRecognizer: MockOnlineRecognizer },
    createdConfigs,
    freedStreams,
    getRecognizerFreed: () => recognizerFreed,
  };
}

test('RealASRProvider implements ASRProvider contract with separate streams per channel and proper cleanup', async () => {
  const model = createIsolatedFakeModelDir();
  const mock = createMockSherpaBinding({ endpointAtChunk: 2 });
  const store = new ModelStore({ modelsDir: model.root, requireAttributionNotice: true });

  const provider = new RealASRProvider({
    mode: 'inline',
    modelId: 'ru-zipformer-vosk-int8',
    modelDir: model.dir,
    modelStore: store,
    binding: mock.binding,
    numThreads: 2,
  });

  try {
    assert.equal(provider instanceof ASRProvider, true);

    const statuses = [];
    const partials = [];
    const finals = [];
    provider.on('status', (s) => statuses.push(s.status));
    provider.on('partial', (p) => partials.push(p));
    provider.on('final', (f) => finals.push(f));

    await provider.connect();
    assert.equal(provider.connected, true);
    assert.equal(provider.state, 'ready');
    assert.equal(mock.createdConfigs.length, 1);
    assert.equal(mock.createdConfigs[0].modelConfig.modelType, 'zipformer2');

    await provider.pushAudio(makePcmChunk({ seq: 1, channel: 'microphone', startMs: 0 }));
    await provider.pushAudio(makePcmChunk({ seq: 2, channel: 'system_loopback', startMs: 50 }));
    assert.equal(partials.length, 2);
    assert.equal(partials[0].isSynthetic, false);
    assert.notEqual(partials[0].utteranceId, partials[1].utteranceId);

    // Trigger endpoint on microphone channel at chunk 2 while loopback flushes on flush()
    await provider.pushAudio(makePcmChunk({ seq: 3, channel: 'microphone', startMs: 100 }));
    assert.equal(finals.length, 1);
    assert.equal(finals[0].channel, 'microphone');
    assert.equal(finals[0].isFinal, true);

    const flushed = await provider.flush();
    assert.equal(flushed.flushed, true);
    assert.equal(finals.length, 2);
    assert.equal(finals[1].channel, 'system_loopback');

    await provider.close();
    assert.equal(provider.connected, false);
    assert.equal(provider.state, 'closed');
    assert.equal(mock.freedStreams.length, 2);
    assert.equal(mock.getRecognizerFreed(), 1);
    assert.deepEqual(statuses, ['connected', 'closed']);
  } finally {
    await provider.close();
    model.cleanup();
  }
});

test('RealASRProvider enforces memory/channel/queue caps and aborts cleanly', async () => {
  const model = createIsolatedFakeModelDir();
  const mock = createMockSherpaBinding({ endpointAtChunk: 100 });
  const store = new ModelStore({ modelsDir: model.root, requireAttributionNotice: true });

  const provider = new RealASRProvider({
    mode: 'inline',
    modelId: 'ru-zipformer-vosk-int8',
    modelDir: model.dir,
    modelStore: store,
    binding: mock.binding,
    maxConcurrentChannels: 2,
    maxUtteranceDurationMs: 250,
    maxPendingAudioBytes: 1000,
  });

  try {
    await provider.connect();

    const finals = [];
    provider.on('final', (f) => finals.push(f));

    // Exceed maxPendingAudioBytes (3200 bytes > 1000) -> BackpressureError
    await assert.rejects(
      () => provider.pushAudio(makePcmChunk({ seq: 1, durationMs: 100 })),
      (err) => err instanceof AsrBackpressureError && err.code === 'ASR_BACKPRESSURE_LIMIT'
    );

    // Reconfigure within limit and test maxUtteranceDurationMs forced reset + channel cap
    provider._maxPendingAudioBytes = 1024 * 1024;
    await provider.pushAudio(makePcmChunk({ seq: 2, channel: 'microphone', durationMs: 100, startMs: 0 }));
    await provider.pushAudio(makePcmChunk({ seq: 3, channel: 'microphone', durationMs: 200, startMs: 100 }));
    assert.equal(finals.length, 1);
    assert.equal(finals[0].forcedSegmentSplit, true);

    await provider.pushAudio(makePcmChunk({ seq: 4, channel: 'system_loopback', durationMs: 100, startMs: 0 }));
    await assert.rejects(
      () => provider.pushAudio(makePcmChunk({ seq: 5, channel: 'extra_third_channel', durationMs: 100 })),
      /Channel cap exceeded/
    );

    // Abort must dispose immediately and prevent late pushes or recovery
    provider.abort();
    assert.equal(provider.state, 'aborted');
    assert.equal(provider.connected, false);
    const lateRes = await provider.pushAudio(makePcmChunk({ seq: 6 }));
    assert.equal(lateRes.accepted, false);
    await assert.rejects(() => provider.recover(), /terminal state/);
  } finally {
    await provider.close();
    model.cleanup();
  }
});

test('RealASRProvider rejects when RSS limit is exceeded', async () => {
  const model = createIsolatedFakeModelDir();
  const mock = createMockSherpaBinding();
  const store = new ModelStore({ modelsDir: model.root, requireAttributionNotice: true });

  const provider = new RealASRProvider({
    mode: 'inline',
    modelId: 'ru-zipformer-vosk-int8',
    modelDir: model.dir,
    modelStore: store,
    binding: mock.binding,
    maxRssBytes: 1024, // deliberately tiny threshold (< actual Node RSS)
  });

  try {
    await assert.rejects(
      () => provider.connect(),
      (err) => err instanceof AsrMemoryLimitError && err.code === 'ASR_MEMORY_LIMIT_EXCEEDED'
    );
    assert.equal(provider.state, 'failed');
  } finally {
    await provider.close();
    model.cleanup();
  }
});

test('RealASRProvider worker mode isolates crashes, recovers with buffered replay, and times out hung decodes', async () => {
  const model = createIsolatedFakeModelDir();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-asr-worker-test-'));
  const flagFile = path.join(tmpDir, 'crashed-once.flag');
  const stubWorker = path.join(tmpDir, 'stub-worker.js');

  fs.writeFileSync(
    stubWorker,
    `'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const flagFile = ${JSON.stringify(flagFile)};
const hangFlag = ${JSON.stringify(path.join(tmpDir, 'hang.flag'))};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chunks = 0;

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.cmd === 'init') {
    send({ id: msg.id, ok: true, resources: { rssBytes: process.memoryUsage().rss, cpuTimeMs: 1 } });
  } else if (msg.cmd === 'push') {
    if (fs.existsSync(hangFlag)) {
      return; // deliberately never reply to trigger decodeTimeoutMs
    }
    chunks += 1;
    if (chunks === 2 && !fs.existsSync(flagFile)) {
      fs.writeFileSync(flagFile, String(process.pid));
      process.exit(139); // simulate native segfault exit
    }
    send({
      id: msg.id,
      ok: true,
      events: [{
        type: 'partial',
        payload: {
          utteranceId: msg.chunk.channel + '-u1',
          revision: chunks,
          isFinal: false,
          text: 'рабочий процесс ' + chunks,
          startMs: msg.chunk.startMs,
          endMs: msg.chunk.endMs,
          channel: msg.chunk.channel,
          speakerHint: msg.chunk.speakerHint,
          confidence: 0.9,
          isSynthetic: false,
        }
      }],
      resources: { rssBytes: process.memoryUsage().rss, cpuTimeMs: 0.5 },
      stats: { totalDecodeTimeMs: chunks * 2 }
    });
  } else if (msg.cmd === 'flush') {
    send({
      id: msg.id,
      ok: true,
      events: [{
        type: 'final',
        payload: {
          utteranceId: 'microphone-u1',
          revision: chunks + 1,
          isFinal: true,
          text: 'рабочий процесс финал',
          startMs: 0,
          endMs: 200,
          channel: 'microphone',
          speakerHint: 'local:mic',
          confidence: 0.95,
          isSynthetic: false,
        }
      }],
      resources: { rssBytes: process.memoryUsage().rss, cpuTimeMs: 0.5 }
    });
  } else if (msg.cmd === 'shutdown') {
    send({ id: msg.id, ok: true });
    process.nextTick(() => process.exit(0));
  }
});

send({ type: 'ready', pid: process.pid });
`
  );

  const store = new ModelStore({ modelsDir: model.root, requireAttributionNotice: true });
  const provider = new RealASRProvider({
    mode: 'worker',
    workerScript: stubWorker,
    modelId: 'ru-zipformer-vosk-int8',
    modelDir: model.dir,
    modelStore: store,
    decodeTimeoutMs: 250,
    recoverBackoffMs: 10,
    maxRestarts: 2,
  });

  const errorEvents = [];
  provider.on('error', (e) => errorEvents.push(e.message));

  try {
    await provider.connect();
    assert.equal(provider.state, 'ready');
    const firstChunk = makePcmChunk({ seq: 1, startMs: 0 });
    await provider.pushAudio(firstChunk);

    // Chunk 2 triggers simulated native exit(139) -> host survives cleanly
    await assert.rejects(
      () => provider.pushAudio(makePcmChunk({ seq: 2, startMs: 100 })),
      /exited unexpectedly/
    );
    assert.equal(provider.state, 'failed');
    assert.equal(errorEvents.length >= 1, true);

    // Recover restarts worker cleanly & replays buffered chunks
    const recovered = await provider.recover();
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.attempt, 1);
    assert.equal(recovered.replayedChunks, 2);
    assert.equal(provider.state, 'ready');

    const flushed = await provider.flush();
    assert.equal(flushed.flushed, true);

    // Trigger timeout stall watchdog
    fs.writeFileSync(path.join(tmpDir, 'hang.flag'), '1');
    await assert.rejects(
      () => provider.pushAudio(makePcmChunk({ seq: 3, startMs: 200 })),
      (err) => err instanceof AsrTimeoutError && err.code === 'ASR_DECODE_TIMEOUT'
    );
    assert.equal(provider.state, 'failed');
  } finally {
    await provider.close();
    model.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SessionManager integrates RealASRProvider and keeps strict prohibition on automatic mic/WASAPI capture', async () => {
  const model = createIsolatedFakeModelDir();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-asr-session-store-'));
  const mock = createMockSherpaBinding({ endpointAtChunk: 3 });
  const store = new ModelStore({ modelsDir: model.root, requireAttributionNotice: true });

  const provider = new RealASRProvider({
    mode: 'inline',
    modelId: 'ru-zipformer-vosk-int8',
    modelDir: model.dir,
    modelStore: store,
    binding: mock.binding,
  });

  const privacy = new PrivacyController();
  const adapter = new SyntheticAudioStreamAdapter({
    utterances: [
      { channel: 'microphone', speakerHint: 'local:mic', text: 'первая реплика', startMs: 0, endMs: 300 },
      { channel: 'system_loopback', speakerHint: 'remote:S1', text: 'ответ системы', startMs: 400, endMs: 600 },
    ],
    sampleRate: 16000,
    chunkDurationMs: 100,
    paceMs: 0,
  });
  const sessionStore = new IsolatedSessionStore({ baseDir: storageRoot });
  const manager = new SessionManager({
    privacy,
    store: sessionStore,
    adapter,
    provider,
    recoveryOptions: { stallTimeoutMs: 15000, maxRetries: 1 },
  });

  try {
    // Missing consent must still be blocked even with RealASRProvider
    await assert.rejects(
      () => manager.start(),
      ConsentRequiredError
    );

    privacy.grantConsent({ captureConsent: true, storageConsent: true, actor: 'contract-test' });

    // Real mic / WASAPI capture must remain strictly forbidden
    const fakeMicAdapter = {
      sourceKind: 'microphone',
      on() {},
      removeListener() {},
      async start() {},
      async stop() {},
    };
    const fakeWasapiAdapter = {
      sourceKind: 'wasapi_loopback',
      on() {},
      removeListener() {},
      async start() {},
      async stop() {},
    };
    await assert.rejects(
      () => manager.start({ adapter: fakeMicAdapter }),
      HardwareAccessForbiddenError
    );
    await assert.rejects(
      () => manager.start({ adapter: fakeWasapiAdapter }),
      HardwareAccessForbiddenError
    );

    // Approved synthetic_stream session runs end-to-end through RealASRProvider
    await manager.start({ adapter });
    await new Promise((resolve) => {
      if (manager._streamEnded) return resolve();
      manager.once('stream_ended', resolve);
    });

    const summary = await manager.finish();
    assert.equal(summary.state, 'completed');
    assert.equal(summary.transcript.finals.length >= 2, true);
    assert.equal(
      summary.transcript.finals.every((seg) => seg.isSynthetic === false),
      true
    );
    assert.equal(summary.timeline.turns.length >= 2, true);
    assert.equal(summary.timeline.speakers.length >= 2, true);
  } finally {
    await provider.close();
    model.cleanup();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('pcm-utils and sherpa-loader report compatibility and convert PCM/WAV safely in pure JS', () => {
  const compat = inspectRuntimeCompatibility();
  assert.equal(typeof compat.nodeVersion, 'string');
  assert.equal(typeof compat.nodeModuleAbi, 'string');
  assert.equal(compat.platform, process.platform);
  if (process.platform === 'win32' && process.arch === 'x64') {
    assert.equal(compat.binaryPackage.packageName, 'sherpa-onnx-win-x64');
  }
  assert.equal(isInsidePlainAsar('C:\\app\\resources\\app.asar\\node_modules\\sherpa-onnx-win-x64'), true);
  assert.equal(isInsidePlainAsar('C:\\app\\resources\\app.asar.unpacked\\node_modules\\sherpa-onnx-win-x64'), false);

  assert.throws(
    () => loadSherpaOnnx({ allowNativeLoad: false }),
    SherpaRuntimeNotInstalledError
  );

  // Build valid stereo PCM16 WAV buffer -> parseWavBuffer -> mono Float32Array (standard JS buffer)
  const sampleRate = 16000;
  const channels = 2;
  const frames = 160;
  const dataBytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 4, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 4, 'ascii');
  wav.write('fmt ', 12, 4, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 4, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  wav.writeInt16LE(16384, 44);
  wav.writeInt16LE(16384, 46);

  const parsed = parseWavBuffer(wav);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.samples instanceof Float32Array, true);
  assert.equal(parsed.samples.length, frames);
  assert.equal(Math.abs(parsed.samples[0] - 0.5) < 0.01, true);

  const downsampled = resampleLinearFloat32(parsed.samples, 16000, 8000);
  assert.equal(downsampled.length, 80);

  const monoInt16 = new Int16Array([32767, -32768]);
  const norm = pcm16leToFloat32(monoInt16, 1);
  assert.equal(Math.abs(norm[0] - 1) < 1e-4, true);
  assert.equal(Math.abs(norm[1] + 1) < 1e-4, true);
});
