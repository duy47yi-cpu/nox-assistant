'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { readWavFile, resampleLinearFloat32 } = require('../src/asr/pcm-utils');
const { RealASRProvider } = require('../src/asr/real-asr-provider');
const { ModelStore } = require('../src/models/model-store');
const { RUSSIAN_STREAMING_MODELS } = require('../src/models/model-catalog');
const { inspectRuntimeCompatibility } = require('../src/asr/sherpa-loader');
const {
  wordErrorRate,
  characterErrorRate,
  summarizeLatencySamples,
  summarizeRtf,
} = require('../src/asr/benchmark-metrics');

function parseCliArgs(argv) {
  const args = {
    mock: false,
    mode: null,
    modelId: 'ru-zipformer-vosk-int8',
    modelsDir: null,
    modelDir: null,
    wav: null,
    ref: null,
    refFile: null,
    manifest: null,
    chunkMs: 100,
    numThreads: 2,
    pace: 'fast',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--mock') {
      args.mock = true;
    } else if (token === '--mode' && argv[i + 1]) {
      args.mode = argv[++i];
    } else if (token === '--model' && argv[i + 1]) {
      args.modelId = argv[++i];
    } else if (token === '--models-dir' && argv[i + 1]) {
      args.modelsDir = argv[++i];
    } else if (token === '--model-dir' && argv[i + 1]) {
      args.modelDir = argv[++i];
    } else if (token === '--wav' && argv[i + 1]) {
      args.wav = argv[++i];
    } else if (token === '--ref' && argv[i + 1]) {
      args.ref = argv[++i];
    } else if (token === '--ref-file' && argv[i + 1]) {
      args.refFile = argv[++i];
    } else if (token === '--manifest' && argv[i + 1]) {
      args.manifest = argv[++i];
    } else if (token === '--chunk-ms' && argv[i + 1]) {
      args.chunkMs = Number.parseInt(argv[++i], 10) || 100;
    } else if (token === '--threads' && argv[i + 1]) {
      args.numThreads = Number.parseInt(argv[++i], 10) || 2;
    } else if (token === '--pace' && argv[i + 1]) {
      args.pace = argv[++i] === 'realtime' ? 'realtime' : 'fast';
    }
  }
  return args;
}

function bytesToMb(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function float32ToPcm16Buffer(float32Slice) {
  const buf = Buffer.alloc(float32Slice.length * 2);
  for (let i = 0; i < float32Slice.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, float32Slice[i]));
    buf.writeInt16LE(clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), i * 2);
  }
  return buf;
}

/**
 * Builds deterministic synthetic PCM16 audio + mock sherpa-onnx binding for zero-model dry-run bench.
 */
function createMockBenchmarkHarness(modelId) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-asr-bench-mock-'));
  const modelDir = path.join(tempRoot, modelId);
  fs.mkdirSync(modelDir, { recursive: true });

  const spec = RUSSIAN_STREAMING_MODELS[modelId] || RUSSIAN_STREAMING_MODELS['ru-zipformer-vosk-int8'];
  for (const candidates of Object.values(spec.files)) {
    const relPath = Array.isArray(candidates) ? candidates[0] : candidates;
    fs.writeFileSync(path.join(modelDir, relPath), `mock-weight:${relPath}\n`);
  }
  fs.writeFileSync(path.join(modelDir, 'NOTICE'), `${spec.weightsLicense.complianceNote}\n`);

  const scriptWords = ['привет', 'команда', 'проверяем', 'потоковый', 'распознаватель', 'речи'];
  class MockStream {
    constructor() {
      this.chunksFed = 0;
      this.finished = false;
    }

    acceptWaveform({ samples }) {
      if (samples && samples.length > 0 && !this.finished) {
        this.chunksFed += 1;
      }
    }

    inputFinished() {
      this.finished = true;
    }

    free() {}
  }

  class MockOnlineRecognizer {
    constructor() {
      this.decodeSteps = 0;
    }

    createStream() {
      return new MockStream();
    }

    isReady(stream) {
      return stream.chunksFed > this.decodeSteps && !stream._drainedThisStep;
    }

    decode(stream) {
      this.decodeSteps += 1;
      stream._drainedThisStep = true;
    }

    getResult(stream) {
      stream._drainedThisStep = false;
      const wordCount = Math.min(scriptWords.length, Math.max(1, Math.ceil(stream.chunksFed / 2)));
      return {
        text: scriptWords.slice(0, wordCount).join(' '),
        confidence: 0.94,
      };
    }

    isEndpoint(stream) {
      return Boolean(stream.finished);
    }

    reset(stream) {
      stream.chunksFed = 0;
      stream.finished = false;
      this.decodeSteps = 0;
    }

    free() {}
  }

  const totalSamples = 16000 * 1.2; // 1.2s at 16 kHz
  const floatSamples = new Float32Array(totalSamples);
  for (let i = 0; i < floatSamples.length; i += 1) {
    floatSamples[i] = Math.sin((2 * Math.PI * 220 * i) / 16000) * 0.15;
  }

  return {
    tempRoot,
    modelsDir: tempRoot,
    modelDir,
    binding: { OnlineRecognizer: MockOnlineRecognizer },
    samples: [
      {
        id: 'mock-ru-sample',
        sampleRate: 16000,
        floatSamples,
        reference: scriptWords.join(' '),
      },
    ],
    cleanup() {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

async function loadDatasetSamples(args) {
  if (args.manifest) {
    const manifestPath = path.resolve(args.manifest);
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`Manifest must be a non-empty JSON array: ${manifestPath}`);
    }
    const items = [];
    for (let i = 0; i < raw.length; i += 1) {
      const row = raw[i];
      const wavPath = path.resolve(path.dirname(manifestPath), row.wavPath || row.wav);
      const parsed = await readWavFile(wavPath);
      items.push({
        id: row.id || path.basename(wavPath),
        wavPath,
        sampleRate: parsed.sampleRate,
        floatSamples: parsed.samples,
        reference: row.reference || row.ref || '',
      });
    }
    return items;
  }

  if (args.wav) {
    const wavPath = path.resolve(args.wav);
    const parsed = await readWavFile(wavPath);
    let reference = args.ref || '';
    if (!reference && args.refFile) {
      reference = fs.readFileSync(path.resolve(args.refFile), 'utf8').trim();
    }
    return [
      {
        id: path.basename(wavPath),
        wavPath,
        sampleRate: parsed.sampleRate,
        floatSamples: parsed.samples,
        reference,
      },
    ];
  }

  throw new Error(
    'Real benchmark requires --wav <file.wav> or --manifest <manifest.json> (or run with --mock for weight-free verification).'
  );
}

async function runBenchmark(options = {}) {
  const args = { ...parseCliArgs([]), ...options };
  const mockHarness = args.mock ? createMockBenchmarkHarness(args.modelId) : null;

  try {
    const modelsDir = mockHarness ? mockHarness.modelsDir : args.modelsDir;
    const modelDir = mockHarness ? mockHarness.modelDir : args.modelDir;
    const store = new ModelStore({
      modelsDir: modelsDir || undefined,
      requireManifestChecksums: false,
      requireAttributionNotice: false,
    });

    const resolved = await store.resolveRecognizerFiles(args.modelId, { modelDir });
    const samplesList = mockHarness ? mockHarness.samples : await loadDatasetSamples(args);
    const targetRate = resolved.sampleRate || 16000;

    const providerMode = args.mode || (mockHarness ? 'inline' : 'worker');
    const provider = new RealASRProvider({
      mode: providerMode,
      modelId: args.modelId,
      modelDir: resolved.modelDir,
      modelStore: store,
      binding: mockHarness ? mockHarness.binding : undefined,
      numThreads: args.numThreads,
    });

    const baselineRssBytes = process.memoryUsage().rss;
    const connectStartMs = performance.now();
    await provider.connect({ modelId: args.modelId, modelDir: resolved.modelDir });
    const modelLoadMs = Number((performance.now() - connectStartMs).toFixed(3));
    const postLoadRssBytes = Math.max(
      process.memoryUsage().rss,
      provider.getMetrics().latestRssBytes || 0
    );

    const perItemReports = [];
    const allChunkLatenciesMs = [];
    const allFinalLatenciesMs = [];
    const allFirstPartialMs = [];
    let totalAudioMs = 0;
    let totalWallDecodeMs = 0;

    const cpuStart = process.cpuUsage();

    for (const item of samplesList) {
      const resampled = item.sampleRate === targetRate
        ? item.floatSamples
        : resampleLinearFloat32(item.floatSamples, item.sampleRate, targetRate);

      const chunkSamplesCount = Math.max(1, Math.round((targetRate * args.chunkMs) / 1000));
      const finals = [];
      let itemFirstChunkAt = null;
      let itemFirstPartialMs = null;

      const onPartial = (ev) => {
        if (itemFirstPartialMs === null && itemFirstChunkAt !== null) {
          itemFirstPartialMs = Number((performance.now() - itemFirstChunkAt).toFixed(3));
        }
      };
      const onFinal = (ev) => {
        finals.push(ev);
      };

      provider.on('partial', onPartial);
      provider.on('final', onFinal);

      const itemStartWallMs = performance.now();
      let offset = 0;
      let seq = 0;
      let cursorMs = 0;

      while (offset < resampled.length) {
        const end = Math.min(resampled.length, offset + chunkSamplesCount);
        const slice = resampled.subarray(offset, end);
        const pcm = float32ToPcm16Buffer(slice);
        const durationMs = Math.round((slice.length / targetRate) * 1000);

        if (itemFirstChunkAt === null) {
          itemFirstChunkAt = performance.now();
        }

        const c0 = performance.now();
        await provider.pushAudio({
          seq: ++seq,
          channel: 'microphone',
          sampleRate: targetRate,
          channels: 1,
          startMs: cursorMs,
          endMs: cursorMs + durationMs,
          durationMs,
          speakerHint: 'local:mic',
          pcm,
        });
        pcm.fill(0);
        allChunkLatenciesMs.push(performance.now() - c0);

        offset = end;
        cursorMs += durationMs;

        if (args.pace === 'realtime' && durationMs > 0 && offset < resampled.length) {
          await new Promise((r) => setTimeout(r, durationMs));
        }
      }

      const flushStartMs = performance.now();
      await provider.flush();
      const finalFlushLatencyMs = Number((performance.now() - flushStartMs).toFixed(3));
      allFinalLatenciesMs.push(finalFlushLatencyMs);
      if (itemFirstPartialMs !== null) {
        allFirstPartialMs.push(itemFirstPartialMs);
      }

      const itemWallMs = performance.now() - itemStartWallMs;
      const itemAudioMs = Math.round((resampled.length / targetRate) * 1000);
      totalAudioMs += itemAudioMs;
      totalWallDecodeMs += itemWallMs;

      provider.removeListener('partial', onPartial);
      provider.removeListener('final', onFinal);

      const hypothesis = finals.map((f) => f.text).filter(Boolean).join(' ').trim();
      const accuracy = item.reference
        ? {
            wer: wordErrorRate(item.reference, hypothesis),
            cer: characterErrorRate(item.reference, hypothesis),
          }
        : null;

      perItemReports.push({
        id: item.id,
        audioDurationMs: itemAudioMs,
        chunks: seq,
        firstPartialLatencyMs: itemFirstPartialMs,
        finalFlushLatencyMs,
        hypothesis,
        reference: item.reference || null,
        accuracy,
      });
    }

    const cpuDelta = process.cpuUsage(cpuStart);
    const parentCpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
    const providerMetrics = provider.getMetrics();
    const totalCpuMs = parentCpuMs + (providerMetrics.totalWorkerCpuTimeMs || 0);
    const peakRssBytes = Math.max(process.memoryUsage().rss, providerMetrics.peakRssBytes || 0);

    await provider.close();

    const references = perItemReports.map((r) => r.reference).filter((v) => typeof v === 'string' && v.length > 0);
    const aggregateAccuracy = references.length === perItemReports.length && references.length > 0
      ? {
          wer: wordErrorRate(
            perItemReports.map((r) => r.reference).join(' '),
            perItemReports.map((r) => r.hypothesis).join(' ')
          ),
          cer: characterErrorRate(
            perItemReports.map((r) => r.reference).join(' '),
            perItemReports.map((r) => r.hypothesis).join(' ')
          ),
        }
      : null;

    return {
      ok: true,
      syntheticHarness: Boolean(mockHarness),
      modelId: resolved.modelId,
      mode: providerMode,
      pace: args.pace,
      chunkMs: args.chunkMs,
      numThreads: args.numThreads,
      runtimeCompatibility: inspectRuntimeCompatibility(),
      timings: {
        modelLoadMs,
        firstPartialMs: summarizeLatencySamples(allFirstPartialMs),
        finalFlushMs: summarizeLatencySamples(allFinalLatenciesMs),
        perChunkRoundtripMs: summarizeLatencySamples(allChunkLatenciesMs),
      },
      rtf: summarizeRtf({
        wallTimeMs: totalWallDecodeMs,
        decodeTimeMs: providerMetrics.totalDecodeTimeMs,
        cpuTimeMs: totalCpuMs,
        audioDurationMs: totalAudioMs,
      }),
      memory: {
        baselineRssMb: bytesToMb(baselineRssBytes),
        postLoadRssMb: bytesToMb(postLoadRssBytes),
        peakRssMb: bytesToMb(peakRssBytes),
        deltaRssMb: bytesToMb(Math.max(0, peakRssBytes - baselineRssBytes)),
      },
      accuracy: aggregateAccuracy,
      samples: perItemReports,
    };
  } finally {
    if (mockHarness) {
      mockHarness.cleanup();
    }
  }
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  runBenchmark(args)
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`benchmark-real-asr error [${err.code || 'ERR'}]: ${err.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  parseCliArgs,
  runBenchmark,
  createMockBenchmarkHarness,
};
