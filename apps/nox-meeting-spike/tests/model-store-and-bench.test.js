'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ModelStore,
  ModelStorageIsolationError,
  ModelNotInstalledError,
  ModelValidationError,
  RUSSIAN_STREAMING_MODELS,
  RUNTIME_COMPONENT_LICENSES,
  DEFAULT_RUSSIAN_MODEL_ID,
  getDefaultModelsDir,
  assertIsolatedModelPath,
  wordErrorRate,
  characterErrorRate,
  summarizeLatencySamples,
  summarizeRtf,
} = require('../src');

const { runBenchmark } = require('../scripts/benchmark-real-asr');
const { runOfflineVerification } = require('../scripts/verify-offline');

test('ModelStore isolates ASR weights from Nox source code and user conversations', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const forbiddenTargets = [
    path.join(repoRoot, 'apps', 'jarvis-desktop', 'data', 'models'),
    path.join(repoRoot, 'apps', 'jarvis-desktop', 'src', 'models'),
    path.join(repoRoot, 'apps', 'nox-server', 'models'),
    path.join(repoRoot, 'apps', 'nox-meeting-spike', 'src', 'weights'),
    path.join(repoRoot, 'apps', 'nox-meeting-spike', '.spike-sessions', 'weights'),
    path.join(repoRoot, 'data', 'asr'),
    path.join(os.tmpdir(), 'chats.json'),
    path.join(os.tmpdir(), '.env'),
  ];

  for (const target of forbiddenTargets) {
    assert.throws(
      () => assertIsolatedModelPath(target),
      ModelStorageIsolationError,
      `Expected isolation rejection for ${target}`
    );
  }

  const defaultWinPath = getDefaultModelsDir({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
  });
  assert.equal(defaultWinPath, path.join('C:\\Users\\demo\\AppData\\Local', 'NoxAssistant', 'models', 'asr'));
});

test('ModelStore enforces SHA-256 verification, commercial NOTICE/LICENSE presence, and zero auto-download', async () => {
  const tmpModelsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-model-store-test-'));

  try {
    const store = new ModelStore({
      modelsDir: tmpModelsRoot,
      requireManifestChecksums: true,
      requireAttributionNotice: true,
    });

    // Missing model fails closed without touching network
    const missingInspection = store.inspectModel(DEFAULT_RUSSIAN_MODEL_ID);
    assert.equal(missingInspection.installed, false);
    assert.equal(missingInspection.offlineReady, false);
    assert.throws(() => store.resolveRecognizerFiles(DEFAULT_RUSSIAN_MODEL_ID), ModelNotInstalledError);

    // Download path refuses without explicit consent or in offline mode
    await assert.rejects(
      () => store.installWithConsent({ userConfirmed: false, offlineOnly: false }),
      /ASR_DOWNLOAD_CONSENT_REQUIRED|подтверждения/
    );
    await assert.rejects(
      () => store.installWithConsent({ userConfirmed: true, offlineOnly: true }),
      /ASR_OFFLINE_MODE_BLOCKS_DOWNLOAD|автономном/
    );

    const modelDir = store.getModelDir(DEFAULT_RUSSIAN_MODEL_ID);
    fs.mkdirSync(modelDir, { recursive: true });
    const files = {
      'encoder.int8.onnx': Buffer.from('encoder-bytes-v1'),
      'decoder.int8.onnx': Buffer.from('decoder-bytes-v1'),
      'joiner.int8.onnx': Buffer.from('joiner-bytes-v1'),
      'tokens.txt': Buffer.from('<blk> 0\nа 1\n'),
    };
    const manifestFiles = {};
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(modelDir, name), content);
      manifestFiles[name] = crypto.createHash('sha256').update(content).digest('hex');
    }
    fs.writeFileSync(path.join(modelDir, 'nox-model-manifest.json'), JSON.stringify({ files: manifestFiles }));

    // Missing NOTICE/LICENSE fails attribution check for commercial compliance
    const withoutNotice = store.inspectModel(DEFAULT_RUSSIAN_MODEL_ID);
    assert.equal(withoutNotice.valid, false);
    assert.equal(withoutNotice.missingFiles.some((m) => m.role === 'license_notice'), true);

    // Adding NOTICE completes valid offline package
    fs.writeFileSync(path.join(modelDir, 'NOTICE'), 'Apache-2.0 alphacep/vosk-model-small-streaming-ru\n');
    const resolved = store.resolveRecognizerFiles(DEFAULT_RUSSIAN_MODEL_ID);
    assert.equal(resolved.offlineReady, true);
    assert.equal(resolved.manifestVerified, true);
    assert.equal(resolved.noticeFile, 'NOTICE');

    // Tampered weight file triggers SHA-256 mismatch error
    fs.writeFileSync(path.join(modelDir, 'encoder.int8.onnx'), Buffer.from('corrupted-encoder'));
    assert.throws(
      () => store.inspectModel(DEFAULT_RUSSIAN_MODEL_ID),
      (err) => err instanceof ModelValidationError && err.code === 'ASR_MODEL_CHECKSUM_MISMATCH'
    );
  } finally {
    fs.rmSync(tmpModelsRoot, { recursive: true, force: true });
  }
});

test('Model catalog documents Russian streaming candidates and separates runtime vs weights licenses cleanly', () => {
  const primary = RUSSIAN_STREAMING_MODELS['ru-zipformer-vosk-int8'];
  assert.equal(primary.sampleRate, 16000);
  assert.equal(primary.recognizerKind, 'transducer');
  assert.equal(primary.weightsLicense.spdx, 'Apache-2.0');
  assert.equal(primary.weightsLicense.commercialUseAllowed, true);

  const tone = RUSSIAN_STREAMING_MODELS['ru-tone-ctc-8k'];
  assert.equal(tone.sampleRate, 8000);
  assert.equal(tone.recognizerKind, 'tone_ctc');
  assert.equal(tone.weightsLicense.spdx, 'Apache-2.0');

  assert.equal(Array.isArray(RUNTIME_COMPONENT_LICENSES), true);
  const byId = Object.fromEntries(RUNTIME_COMPONENT_LICENSES.map((item) => [item.id, item]));
  assert.equal(byId['sherpa-onnx-node'].license, 'Apache-2.0');
  assert.equal(byId['sherpa-onnx-win-x64'].license, 'Apache-2.0');
  assert.equal(byId.onnxruntime.license, 'MIT');
  assert.equal(byId['kaldi-native-fbank'].license, 'Apache-2.0');
});

test('Benchmark metrics compute Russian WER/CER, latency percentiles, and RTF accurately', () => {
  const werPerfect = wordErrorRate('Ежик в тумане, сказал он!', 'ёжик в тумане сказал он');
  assert.equal(werPerfect.wer, 0);
  assert.equal(werPerfect.werPercent, 0);

  const werEdit = wordErrorRate('один два три четыре', 'один пять три');
  assert.equal(werEdit.wordErrors, 2);
  assert.equal(werEdit.substitutions, 1);
  assert.equal(werEdit.deletions, 1);
  assert.equal(werEdit.werPercent, 50);

  const cerEdit = characterErrorRate('привет', 'приет');
  assert.equal(cerEdit.charErrors, 1);

  const latencies = summarizeLatencySamples([10, 20, 30, 40, 100]);
  assert.equal(latencies.minMs, 10);
  assert.equal(latencies.p50Ms, 30);
  assert.equal(latencies.maxMs, 100);

  const rtf = summarizeRtf({
    audioDurationMs: 2000,
    wallTimeMs: 400,
    decodeTimeMs: 250,
    cpuTimeMs: 300,
  });
  assert.equal(rtf.decodeRtf, 0.125);
  assert.equal(rtf.wallRtf, 0.2);
  assert.equal(rtf.cpuRtf, 0.15);
  assert.equal(rtf.fasterThanRealtime, true);
});

test('Isolated ASR benchmark (--mock) and zero-network offline verification both pass cleanly', async () => {
  const benchReport = await runBenchmark({ mock: true });
  assert.equal(benchReport.ok, true);
  assert.equal(benchReport.syntheticHarness, true);
  assert.equal(benchReport.timings.firstPartialMs.count, 1);
  assert.equal(benchReport.timings.finalFlushMs.count, 1);
  assert.equal(benchReport.accuracy.wer.werPercent, 0);
  assert.equal(typeof benchReport.memory.deltaRssMb, 'number');

  const offlineReport = await runOfflineVerification();
  assert.equal(offlineReport.ok, true);
  assert.equal(offlineReport.attemptedNetworkCalls, 0);
  assert.equal(offlineReport.checks.missingModelRejectedOffline, true);
  assert.equal(offlineReport.checks.localModelResolvedOffline, true);
  assert.equal(offlineReport.checks.sessionCompletedOffline, true);
  assert.equal(offlineReport.checks.mockBenchmarkOk, true);
});
