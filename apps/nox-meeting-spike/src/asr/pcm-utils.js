'use strict';

const fs = require('node:fs');

/**
 * Normalizes PCM16LE bytes or Int16Array samples into a standard JS mono Float32Array [-1, 1].
 * Pure-JS allocation avoids Electron >=21 "External buffers are not allowed" V8 faults.
 *
 * @param {Buffer|Uint8Array|Int16Array|Float32Array} input
 * @param {number} [channels=1]
 * @returns {Float32Array}
 */
function pcm16leToFloat32(input, channels = 1) {
  if (!input) {
    throw new TypeError('pcm16leToFloat32: input buffer is required');
  }
  const channelCount = Number.isInteger(channels) && channels > 0 ? channels : 1;

  if (input instanceof Float32Array) {
    if (channelCount === 1) {
      return new Float32Array(input);
    }
    const frames = Math.floor(input.length / channelCount);
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      const base = i * channelCount;
      for (let ch = 0; ch < channelCount; ch += 1) {
        sum += input[base + ch];
      }
      out[i] = Math.max(-1, Math.min(1, sum / channelCount));
    }
    return out;
  }

  let sampleCount;
  let readSample;

  if (input instanceof Int16Array) {
    sampleCount = input.length;
    readSample = (idx) => input[idx];
  } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    if (input.byteLength % 2 !== 0) {
      throw new RangeError(
        `PCM16LE byteLength must be even, got ${input.byteLength}`
      );
    }
    sampleCount = input.byteLength / 2;
    readSample = (idx) => view.getInt16(idx * 2, true);
  } else {
    throw new TypeError(
      'pcm16leToFloat32: expected Buffer, Uint8Array, Int16Array, or Float32Array'
    );
  }

  if (channelCount === 1) {
    const out = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      const s = readSample(i);
      out[i] = s < 0 ? s / 32768 : s / 32767;
    }
    return out;
  }

  const frames = Math.floor(sampleCount / channelCount);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    const base = i * channelCount;
    for (let ch = 0; ch < channelCount; ch += 1) {
      const s = readSample(base + ch);
      sum += s < 0 ? s / 32768 : s / 32767;
    }
    out[i] = Math.max(-1, Math.min(1, sum / channelCount));
  }
  return out;
}

/**
 * Converts a Float32Array sample stream between sample rates using linear interpolation.
 * Intended for adapting 16 kHz chunks to 8 kHz telephony models (e.g., T-one) when needed.
 *
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
function resampleLinearFloat32(samples, fromRate, toRate) {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError('resampleLinearFloat32: samples must be a Float32Array');
  }
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    throw new RangeError(`Invalid sample rates: fromRate=${fromRate}, toRate=${toRate}`);
  }
  if (fromRate === toRate || samples.length === 0) {
    return new Float32Array(samples);
  }

  const ratio = fromRate / toRate;
  const targetLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(targetLength);
  const maxIndex = samples.length - 1;

  for (let i = 0; i < targetLength; i += 1) {
    const srcPos = i * ratio;
    const low = Math.floor(srcPos);
    const high = Math.min(maxIndex, low + 1);
    const frac = srcPos - low;
    out[i] = samples[low] * (1 - frac) + samples[high] * frac;
  }

  return out;
}

/**
 * Parses a RIFF/WAVE buffer purely in JS (avoiding native readWave external-buffer issues).
 * Supports uncompressed PCM (format=1, 16-bit) and IEEE Float (format=3, 32-bit), mono or multi-channel.
 *
 * @param {Buffer|Uint8Array} rawBuffer
 * @returns {{
 *   sampleRate: number,
 *   channels: number,
 *   bitsPerSample: number,
 *   audioFormat: number,
 *   samples: Float32Array,
 *   durationMs: number
 * }}
 */
function parseWavBuffer(rawBuffer) {
  if (!Buffer.isBuffer(rawBuffer) && !(rawBuffer instanceof Uint8Array)) {
    throw new TypeError('parseWavBuffer: expected Buffer or Uint8Array');
  }
  const buf = Buffer.isBuffer(rawBuffer)
    ? rawBuffer
    : Buffer.from(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);

  if (buf.byteLength < 44) {
    throw new RangeError(`WAV buffer too small (${buf.byteLength} bytes)`);
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV header: missing RIFF/WAVE signature');
  }

  let offset = 12;
  let fmt = null;
  let dataSlice = null;

  while (offset + 8 <= buf.byteLength) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(buf.byteLength, chunkStart + chunkSize);

    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || chunkStart + 16 > buf.byteLength) {
        throw new Error('Truncated WAV fmt chunk');
      }
      fmt = {
        audioFormat: buf.readUInt16LE(chunkStart),
        channels: buf.readUInt16LE(chunkStart + 2),
        sampleRate: buf.readUInt32LE(chunkStart + 4),
        bitsPerSample: buf.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      dataSlice = buf.subarray(chunkStart, chunkEnd);
    }

    // RIFF chunks are word-aligned (padded to even byte boundaries).
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt) {
    throw new Error('Invalid WAV file: missing fmt chunk');
  }
  if (!dataSlice) {
    throw new Error('Invalid WAV file: missing data chunk');
  }
  if (fmt.channels < 1 || fmt.sampleRate < 1) {
    throw new Error(`Invalid WAV stream geometry: channels=${fmt.channels}, sampleRate=${fmt.sampleRate}`);
  }

  let samples;
  if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
    const evenLength = dataSlice.byteLength - (dataSlice.byteLength % (2 * fmt.channels));
    samples = pcm16leToFloat32(dataSlice.subarray(0, evenLength), fmt.channels);
  } else if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
    const frameBytes = 4 * fmt.channels;
    const frames = Math.floor(dataSlice.byteLength / frameBytes);
    const view = new DataView(dataSlice.buffer, dataSlice.byteOffset, frames * frameBytes);
    const interleaved = new Float32Array(frames * fmt.channels);
    for (let i = 0; i < interleaved.length; i += 1) {
      interleaved[i] = view.getFloat32(i * 4, true);
    }
    samples = fmt.channels === 1 ? interleaved : pcm16leToFloat32(interleaved, fmt.channels);
  } else {
    throw new Error(
      `Unsupported WAV encoding (audioFormat=${fmt.audioFormat}, bitsPerSample=${fmt.bitsPerSample}); expected PCM16LE or IEEE Float32`
    );
  }

  const durationMs = Math.round((samples.length / fmt.sampleRate) * 1000);
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    audioFormat: fmt.audioFormat,
    samples,
    durationMs,
  };
}

/**
 * Reads and parses a local WAV file into normalized mono Float32Array samples.
 *
 * @param {string} filePath
 * @returns {Promise<ReturnType<typeof parseWavBuffer>>}
 */
async function readWavFile(filePath) {
  const buf = await fs.promises.readFile(filePath);
  return parseWavBuffer(buf);
}

/**
 * Computes normalized RMS energy [0, 1] for VAD / silence diagnostics.
 *
 * @param {Float32Array} samples
 * @returns {number}
 */
function computeRmsEnergy(samples) {
  if (!samples || samples.length === 0) {
    return 0;
  }
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Allocates zero-filled tail padding used before sherpa-onnx stream.inputFinished()
 * so final phonemes are flushed cleanly without dropping trailing words.
 *
 * @param {number} sampleRate
 * @param {number} [durationMs=400]
 * @returns {Float32Array}
 */
function createSilenceTail(sampleRate, durationMs = 400) {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 16000;
  const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const count = Math.round((rate * ms) / 1000);
  return new Float32Array(count);
}

module.exports = {
  pcm16leToFloat32,
  resampleLinearFloat32,
  parseWavBuffer,
  readWavFile,
  computeRmsEnergy,
  createSilenceTail,
};
