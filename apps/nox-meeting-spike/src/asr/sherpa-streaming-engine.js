'use strict';

const { performance } = require('node:perf_hooks');
const {
  pcm16leToFloat32,
  resampleLinearFloat32,
  createSilenceTail,
} = require('./pcm-utils');

/**
 * Normalizes recognizer text output while preserving punctuation/casing from the model.
 *
 * @param {unknown} rawText
 * @returns {string}
 */
function normalizeDecodedText(rawText) {
  if (typeof rawText !== 'string') {
    return '';
  }
  return rawText.replace(/\s+/g, ' ').trim();
}

/**
 * Builds the native sherpa-onnx OnlineRecognizer config object from resolved ModelStore metadata.
 *
 * @param {object} resolvedModel
 * @param {object} [options]
 * @returns {object}
 */
function buildOnlineRecognizerConfig(resolvedModel, options = {}) {
  if (!resolvedModel || !resolvedModel.resolvedFiles) {
    throw new TypeError('buildOnlineRecognizerConfig: resolvedModel with resolvedFiles is required');
  }

  const files = resolvedModel.resolvedFiles;
  const numThreads = Number.isInteger(options.numThreads) && options.numThreads > 0
    ? options.numThreads
    : 2;
  const endpointing = options.endpointing || {};
  const enableEndpoint = endpointing.enabled === false ? 0 : 1;

  const baseConfig = {
    featConfig: {
      sampleRate: resolvedModel.sampleRate || 16000,
      featureDim: resolvedModel.featureDim || 80,
    },
    decodingMethod: resolvedModel.decodingMethod || 'greedy_search',
    maxActivePaths: Number.isInteger(options.maxActivePaths) ? options.maxActivePaths : 4,
    enableEndpoint,
    rule1MinTrailingSilence:
      typeof endpointing.rule1MinTrailingSilence === 'number' ? endpointing.rule1MinTrailingSilence : 2.4,
    rule2MinTrailingSilence:
      typeof endpointing.rule2MinTrailingSilence === 'number' ? endpointing.rule2MinTrailingSilence : 1.2,
    rule3MinUtteranceLength:
      typeof endpointing.rule3MinUtteranceLength === 'number' ? endpointing.rule3MinUtteranceLength : 20.0,
  };

  if (
    resolvedModel.recognizerKind === 'transducer' ||
    resolvedModel.recognizerKind === 'online_transducer'
  ) {
    if (!files.encoder || !files.decoder || !files.joiner || !files.tokens) {
      throw new Error(
        `Missing transducer files in resolvedModel (${resolvedModel.modelId})`
      );
    }
    baseConfig.modelConfig = {
      transducer: {
        encoder: files.encoder,
        decoder: files.decoder,
        joiner: files.joiner,
      },
      tokens: files.tokens,
      numThreads,
      provider: 'cpu',
      debug: 0,
      modelType: resolvedModel.modelType || 'zipformer2',
    };
    return baseConfig;
  }

  if (
    resolvedModel.recognizerKind === 'tone_ctc' ||
    resolvedModel.recognizerKind === 'online_tone_ctc'
  ) {
    if (!files.model || !files.tokens) {
      throw new Error(
        `Missing T-one CTC files in resolvedModel (${resolvedModel.modelId})`
      );
    }
    baseConfig.modelConfig = {
      toneCtc: {
        model: files.model,
      },
      tokens: files.tokens,
      numThreads,
      provider: 'cpu',
      debug: 0,
    };
    return baseConfig;
  }

  throw new Error(`Unsupported recognizerKind: ${resolvedModel.recognizerKind}`);
}

/**
 * Shared streaming decode engine over sherpa-onnx OnlineRecognizer + per-channel OnlineStreams.
 * Used cleanly in both in-process test mode and isolated child-process worker mode.
 */
class SherpaStreamingEngine {
  constructor(options = {}) {
    if (!options.binding || typeof options.binding.OnlineRecognizer !== 'function') {
      throw new TypeError('SherpaStreamingEngine requires a binding with OnlineRecognizer');
    }
    if (!options.resolvedModel) {
      throw new TypeError('SherpaStreamingEngine requires resolvedModel');
    }

    this._binding = options.binding;
    this._resolvedModel = options.resolvedModel;
    this._recognizerConfig = buildOnlineRecognizerConfig(options.resolvedModel, {
      numThreads: options.numThreads,
      endpointing: options.endpointing,
      maxActivePaths: options.maxActivePaths,
    });

    this._recognizer = new this._binding.OnlineRecognizer(this._recognizerConfig);
    this._modelSampleRate = this._recognizerConfig.featConfig.sampleRate;
    this._maxConcurrentChannels =
      Number.isInteger(options.maxConcurrentChannels) && options.maxConcurrentChannels > 0
        ? options.maxConcurrentChannels
        : 2;
    this._maxUtteranceDurationMs =
      Number.isFinite(options.maxUtteranceDurationMs) && options.maxUtteranceDurationMs > 0
        ? options.maxUtteranceDurationMs
        : 25000;
    this._tailPaddingMs =
      Number.isFinite(options.tailPaddingMs) && options.tailPaddingMs >= 0
        ? options.tailPaddingMs
        : 400;

    this._streams = new Map();
    this._disposed = false;
    this._totalDecodeTimeMs = 0;
    this._totalAudioDurationMs = 0;
    this._chunksDecoded = 0;
  }

  _getOrCreateChannelState(channel, startMs, speakerHint) {
    if (this._streams.has(channel)) {
      return this._streams.get(channel);
    }
    if (this._streams.size >= this._maxConcurrentChannels) {
      throw new RangeError(
        `Channel cap exceeded: maxConcurrentChannels=${this._maxConcurrentChannels}, attempted='${channel}'`
      );
    }
    const stream = this._recognizer.createStream();
    const state = {
      channel,
      stream,
      utteranceSeq: 1,
      revision: 0,
      lastEmittedText: '',
      utteranceStartMs: Number.isFinite(startMs) ? startMs : 0,
      lastEndMs: Number.isFinite(startMs) ? startMs : 0,
      utteranceAudioMs: 0,
      hasUnflushedAudio: false,
      speakerHint: speakerHint || (channel === 'microphone' ? 'local:mic' : 'remote:system'),
    };
    this._streams.set(channel, state);
    return state;
  }

  _decodeReadyFrames(stream) {
    while (this._recognizer.isReady(stream)) {
      this._recognizer.decode(stream);
    }
  }

  _extractConfidence(result) {
    if (result && Array.isArray(result.ysProbs) && result.ysProbs.length > 0) {
      const avg = result.ysProbs.reduce((acc, v) => acc + v, 0) / result.ysProbs.length;
      if (Number.isFinite(avg)) {
        return Math.max(0, Math.min(1, Number(avg.toFixed(3))));
      }
    }
    if (result && typeof result.confidence === 'number' && Number.isFinite(result.confidence)) {
      return Math.max(0, Math.min(1, Number(result.confidence.toFixed(3))));
    }
    return 0.9;
  }

  _resetUtteranceState(state, nextStartMs) {
    if (typeof this._recognizer.reset === 'function') {
      this._recognizer.reset(state.stream);
    } else {
      state.stream.free?.();
      state.stream = this._recognizer.createStream();
    }
    state.utteranceSeq += 1;
    state.revision = 0;
    state.lastEmittedText = '';
    state.utteranceStartMs = Number.isFinite(nextStartMs) ? nextStartMs : state.lastEndMs;
    state.utteranceAudioMs = 0;
    state.hasUnflushedAudio = false;
  }

  /**
   * Feeds a single validated audio chunk into its channel stream and returns zero or more events.
   *
   * @param {object} chunk
   * @returns {Array<{ type: 'partial'|'final', payload: object }>}
   */
  processChunk(chunk) {
    if (this._disposed) {
      throw new Error('SherpaStreamingEngine is disposed');
    }

    const channel = chunk.channel || chunk.streamKind || 'microphone';
    const inputRate = Number.isFinite(chunk.sampleRate) && chunk.sampleRate > 0
      ? chunk.sampleRate
      : this._modelSampleRate;
    const inputChannels = Number.isInteger(chunk.channels) && chunk.channels > 0 ? chunk.channels : 1;
    const startMs = Number.isFinite(chunk.startMs) ? chunk.startMs : 0;

    let samples = chunk.float32Samples instanceof Float32Array
      ? chunk.float32Samples
      : pcm16leToFloat32(chunk.pcm, inputChannels);

    const chunkDurationMs = Number.isFinite(chunk.durationMs)
      ? chunk.durationMs
      : Math.round((samples.length / inputRate) * 1000);
    const endMs = Number.isFinite(chunk.endMs) ? chunk.endMs : startMs + chunkDurationMs;

    if (inputRate !== this._modelSampleRate) {
      samples = resampleLinearFloat32(samples, inputRate, this._modelSampleRate);
    }

    const state = this._getOrCreateChannelState(channel, startMs, chunk.speakerHint);
    if (state.utteranceStartMs === null) {
      state.utteranceStartMs = startMs;
    }
    if (chunk.speakerHint) {
      state.speakerHint = chunk.speakerHint;
    }

    const t0 = performance.now();
    state.stream.acceptWaveform({
      sampleRate: this._modelSampleRate,
      samples,
    });
    this._decodeReadyFrames(state.stream);
    const result = this._recognizer.getResult(state.stream);
    const endpointHit = Boolean(
      typeof this._recognizer.isEndpoint === 'function' &&
      this._recognizer.isEndpoint(state.stream)
    );
    const decodeElapsedMs = performance.now() - t0;

    this._totalDecodeTimeMs += decodeElapsedMs;
    this._totalAudioDurationMs += chunkDurationMs;
    this._chunksDecoded += 1;
    state.hasUnflushedAudio = true;
    state.utteranceAudioMs += chunkDurationMs;
    state.lastEndMs = Math.max(state.lastEndMs, endMs);

    const text = normalizeDecodedText(result && result.text);
    const forceSegmentEnd = state.utteranceAudioMs >= this._maxUtteranceDurationMs;
    const events = [];

    if (endpointHit || forceSegmentEnd) {
      if (text.length > 0) {
        state.revision += 1;
        events.push({
          type: 'final',
          payload: {
            utteranceId: `${channel}-u${state.utteranceSeq}`,
            revision: state.revision,
            isFinal: true,
            text,
            startMs: state.utteranceStartMs,
            endMs: state.lastEndMs,
            channel,
            speakerHint: state.speakerHint,
            confidence: this._extractConfidence(result),
            isSynthetic: false,
            modelId: this._resolvedModel.modelId,
            decodeTimeMs: Number(decodeElapsedMs.toFixed(3)),
            forcedSegmentSplit: !endpointHit && forceSegmentEnd,
            emittedAtPerfMs: performance.now(),
          },
        });
      }
      this._resetUtteranceState(state, state.lastEndMs);
      return events;
    }

    if (text.length > 0 && text !== state.lastEmittedText) {
      state.lastEmittedText = text;
      state.revision += 1;
      events.push({
        type: 'partial',
        payload: {
          utteranceId: `${channel}-u${state.utteranceSeq}`,
          revision: state.revision,
          isFinal: false,
          text,
          startMs: state.utteranceStartMs,
          endMs: state.lastEndMs,
          channel,
          speakerHint: state.speakerHint,
          confidence: this._extractConfidence(result),
          isSynthetic: false,
          modelId: this._resolvedModel.modelId,
          decodeTimeMs: Number(decodeElapsedMs.toFixed(3)),
          emittedAtPerfMs: performance.now(),
        },
      });
    }

    return events;
  }

  /**
   * Flushes all open channel streams (with trailing zero-padding + inputFinished)
   * and returns any pending final utterances.
   *
   * @returns {Array<{ type: 'final', payload: object }>}
   */
  flushAll() {
    if (this._disposed) {
      return [];
    }
    const events = [];
    const silenceTail = this._tailPaddingMs > 0
      ? createSilenceTail(this._modelSampleRate, this._tailPaddingMs)
      : null;

    for (const state of this._streams.values()) {
      if (!state.hasUnflushedAudio) {
        continue;
      }
      const t0 = performance.now();
      if (silenceTail && silenceTail.length > 0) {
        state.stream.acceptWaveform({
          sampleRate: this._modelSampleRate,
          samples: silenceTail,
        });
      }
      if (typeof state.stream.inputFinished === 'function') {
        state.stream.inputFinished();
      }
      this._decodeReadyFrames(state.stream);
      const result = this._recognizer.getResult(state.stream);
      const decodeElapsedMs = performance.now() - t0;
      this._totalDecodeTimeMs += decodeElapsedMs;

      const text = normalizeDecodedText(result && result.text);
      if (text.length > 0) {
        state.revision += 1;
        events.push({
          type: 'final',
          payload: {
            utteranceId: `${state.channel}-u${state.utteranceSeq}`,
            revision: state.revision,
            isFinal: true,
            text,
            startMs: state.utteranceStartMs ?? 0,
            endMs: state.lastEndMs,
            channel: state.channel,
            speakerHint: state.speakerHint,
            confidence: this._extractConfidence(result),
            isSynthetic: false,
            modelId: this._resolvedModel.modelId,
            decodeTimeMs: Number(decodeElapsedMs.toFixed(3)),
            emittedAtPerfMs: performance.now(),
          },
        });
      }
      this._resetUtteranceState(state, state.lastEndMs);
    }

    return events;
  }

  getStats() {
    const wallRtf = this._totalAudioDurationMs > 0
      ? Number((this._totalDecodeTimeMs / this._totalAudioDurationMs).toFixed(4))
      : 0;
    return {
      modelId: this._resolvedModel.modelId,
      modelSampleRate: this._modelSampleRate,
      activeChannels: this._streams.size,
      maxConcurrentChannels: this._maxConcurrentChannels,
      chunksDecoded: this._chunksDecoded,
      totalAudioDurationMs: this._totalAudioDurationMs,
      totalDecodeTimeMs: Number(this._totalDecodeTimeMs.toFixed(3)),
      decodeRtf: wallRtf,
      rssBytes: process.memoryUsage().rss,
    };
  }

  dispose() {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    for (const state of this._streams.values()) {
      try {
        state.stream.free?.();
      } catch (_err) {
        // Ignore duplicate native dispose errors during shutdown.
      }
    }
    this._streams.clear();
    try {
      this._recognizer.free?.();
    } catch (_err) {
      // Ignore recognizer cleanup errors on teardown.
    }
  }
}

module.exports = {
  normalizeDecodedText,
  buildOnlineRecognizerConfig,
  SherpaStreamingEngine,
};
