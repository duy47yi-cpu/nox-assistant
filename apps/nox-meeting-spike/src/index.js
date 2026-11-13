'use strict';

const {
  PrivacyController,
  ConsentRequiredError,
  HardwareAccessForbiddenError,
  StorageIsolationError,
  StorageWriteError,
} = require('./privacy/privacy-controller');
const { IsolatedSessionStore, assertIsolatedStoragePath } = require('./storage/session-store');
const {
  AudioStreamAdapter,
  SyntheticAudioStreamAdapter,
  validateAudioChunk,
  buildSyntheticPcm16,
} = require('./audio/audio-stream-adapter');
const { ASRProvider, SyntheticASRProvider } = require('./asr/asr-provider');
const {
  RealASRProvider,
  AsrBackpressureError,
  AsrTimeoutError,
  AsrMemoryLimitError,
} = require('./asr/real-asr-provider');
const {
  pcm16leToFloat32,
  resampleLinearFloat32,
  parseWavBuffer,
  readWavFile,
  computeRmsEnergy,
  createSilenceTail,
} = require('./asr/pcm-utils');
const {
  inspectRuntimeCompatibility,
  loadSherpaOnnx,
  isInsidePlainAsar,
  toUnpackedAsarPath,
  getPlatformBinaryPackage,
  prependDllSearchPath,
  SherpaRuntimeNotInstalledError,
  SherpaAsarError,
} = require('./asr/sherpa-loader');
const {
  normalizeDecodedText,
  buildOnlineRecognizerConfig,
  SherpaStreamingEngine,
} = require('./asr/sherpa-streaming-engine');
const {
  DEFAULT_RUSSIAN_MODEL_ID,
  RUSSIAN_STREAMING_MODELS,
  RUNTIME_COMPONENT_LICENSES,
  getModelSpec,
  listSupportedModels,
} = require('./models/model-catalog');
const {
  ModelStore,
  ModelStorageIsolationError,
  ModelNotInstalledError,
  ModelValidationError,
  getDefaultModelsDir,
  assertIsolatedModelPath,
} = require('./models/model-store');
const {
  normalizeTextForEval,
  wordErrorRate,
  characterErrorRate,
  summarizeLatencySamples,
  summarizeRtf,
} = require('./asr/benchmark-metrics');
const { BackpressureQueue } = require('./runtime/backpressure');
const { CancellationController } = require('./runtime/cancellation');
const { ErrorRecoverySupervisor } = require('./runtime/error-recovery');
const { TranscriptAssembler } = require('./transcript/transcript-assembler');
const { SpeakerTimeline } = require('./timeline/speaker-timeline');
const { MeetingSummaryGenerator } = require('./summary/meeting-summary');
const { SessionManager } = require('./core/session-manager');
const { buildScenarioConfig, STANDUP_UTTERANCES } = require('./core/synthetic-scenarios');

module.exports = {
  PrivacyController,
  ConsentRequiredError,
  HardwareAccessForbiddenError,
  StorageIsolationError,
  StorageWriteError,
  IsolatedSessionStore,
  assertIsolatedStoragePath,
  AudioStreamAdapter,
  SyntheticAudioStreamAdapter,
  validateAudioChunk,
  buildSyntheticPcm16,
  ASRProvider,
  SyntheticASRProvider,
  RealASRProvider,
  AsrBackpressureError,
  AsrTimeoutError,
  AsrMemoryLimitError,
  pcm16leToFloat32,
  resampleLinearFloat32,
  parseWavBuffer,
  readWavFile,
  computeRmsEnergy,
  createSilenceTail,
  inspectRuntimeCompatibility,
  loadSherpaOnnx,
  isInsidePlainAsar,
  toUnpackedAsarPath,
  getPlatformBinaryPackage,
  prependDllSearchPath,
  SherpaRuntimeNotInstalledError,
  SherpaAsarError,
  normalizeDecodedText,
  buildOnlineRecognizerConfig,
  SherpaStreamingEngine,
  DEFAULT_RUSSIAN_MODEL_ID,
  RUSSIAN_STREAMING_MODELS,
  RUNTIME_COMPONENT_LICENSES,
  getModelSpec,
  listSupportedModels,
  ModelStore,
  ModelStorageIsolationError,
  ModelNotInstalledError,
  ModelValidationError,
  getDefaultModelsDir,
  assertIsolatedModelPath,
  normalizeTextForEval,
  wordErrorRate,
  characterErrorRate,
  summarizeLatencySamples,
  summarizeRtf,
  BackpressureQueue,
  CancellationController,
  ErrorRecoverySupervisor,
  TranscriptAssembler,
  SpeakerTimeline,
  MeetingSummaryGenerator,
  SessionManager,
  buildScenarioConfig,
  STANDUP_UTTERANCES,
};
