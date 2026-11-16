'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const RELEASE = 'https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/322c3b29492673eb7d0b434bfa9dfb8653e34d02';
const MODEL_FILES = {
  'v3_ctc.int8.onnx': [224721181, 'ceb61454e2e1a2dec5872cbac1de0fe0a4271d1148f6b26b5bda53ff30a12acd'],
  'v3_vocab.txt': [null, 'a9143c30844d3c0bee3e9e927e4084774eb1b9eeaafc473b2c4521e4911a7c07'],
};
const MODEL_MISSING = 'Скачайте локальный движок в настройках голосового ввода.';
const LOCAL_FAILED = 'Локальный движок не запустился. Проверьте файлы модели и окружение Python.';
const CLOUD_FAILED = 'Облачное распознавание недоступно.';
const REPEAT = 'Не удалось разобрать фразу. Повторите её.';

function modelAvailable(folder) {
  try {
    return Object.entries(MODEL_FILES).every(([file, [size]]) => {
      const stat = fs.statSync(path.join(folder, file), { throwIfNoEntry: false });
      return stat?.isFile() && (size === null ? stat.size > 0 : stat.size === size);
    });
  } catch {
    return false;
  }
}

async function downloadModel(folder, { signal, progress = () => {} } = {}) {
  await fsp.mkdir(folder, { recursive: true });
  for (const [file, [size, checksum]] of Object.entries(MODEL_FILES).reverse()) {
    const target = path.join(folder, file);
    const tmp = target + '.' + randomUUID() + '.part';
    try {
      const response = await fetch(RELEASE + '/' + file, { signal });
      if (!response.ok || !response.body) throw new Error('Загрузка не удалась');
      const hash = createHash('sha256');
      let total = 0;
      let reported = -1;
      await pipeline(Readable.fromWeb(response.body), new Transform({
        transform(chunk, encoding, callback) {
          hash.update(chunk);
          total += chunk.length;
          if (total > (size || 4096)) return callback(new Error('Неверный размер файла'));
          const percent = size ? Math.floor(100 * total / size) : -1;
          if (percent !== reported) { reported = percent; progress(percent); }
          callback(null, chunk);
        },
      }), fs.createWriteStream(tmp, { flags: 'wx' }), { signal });
      if (hash.digest('hex') !== checksum) throw new Error('Файл повреждён');
      await fsp.rename(tmp, target);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }
}

function wavFromPcm(pcm) {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

function localGigaam({ folder, script, python = 'python' }) {
  let worker;
  function stop() { worker?.close(); }
  function warmup({ signal } = {}) {
    signal?.throwIfAborted();
    if (worker) return worker.ready;
    if (!modelAvailable(folder())) return Promise.reject(new Error(MODEL_MISSING));
    const child = spawn(python, [script, folder()], {
      windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', OPENBLAS_NUM_THREADS: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map();
    let onReady;
    let onError;
    const ready = new Promise((resolve, reject) => { onReady = resolve; onError = reject; });
    const close = () => {
      if (worker?.child !== child) return;
      worker = null;
      clearTimeout(timer);
      lines.close();
      child.kill();
      const error = new Error(LOCAL_FAILED);
      onError(error);
      for (const settle of pending.values()) settle(error);
    };
    const timer = setTimeout(close, 30000);
    worker = { child, ready, close, pending };
    child.on('error', close);
    child.on('exit', close);
    child.stdin.on('error', close);
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { close(); return; }
      if (message.ready) { clearTimeout(timer); onReady(); }
      else pending.get(message.id)?.(message.error ? new Error(LOCAL_FAILED) : null, message);
    });
    return ready;
  }
  async function transcribe(samples, { signal, language } = {}) {
    if (language === 'en') throw new Error('Локальный движок распознаёт только русский.');
    signal?.throwIfAborted();
    const abort = () => stop();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await warmup({ signal });
      signal?.throwIfAborted();
      const active = worker;
      if (!active) throw new Error(LOCAL_FAILED);
      const id = randomUUID();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(active.close, 10000);
        active.pending.set(id, (err, result) => {
          clearTimeout(timer);
          active.pending.delete(id);
          if (err) reject(err);
          else resolve({ text: result.text, confidence: result.confidence, peakMiB: result.peakMiB });
        });
        active.child.stdin.write(JSON.stringify({ id, pcm: samples.toString('base64') }) + '\n');
      });
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  return { name: 'локальный', isAvailable: () => modelAvailable(folder()), warmup, transcribe, stop };
}

function cloudProvider({ url, key, model, request = fetch }) {
  const isAvailable = () => Boolean(url && model);
  return {
    name: 'облачный',
    isAvailable,
    async warmup() { if (!isAvailable()) throw new Error(CLOUD_FAILED); },
    async transcribe(samples, { signal, language } = {}) {
      signal?.throwIfAborted();
      if (!isAvailable()) throw new Error(CLOUD_FAILED);
      const form = new FormData();
      form.append('file', new Blob([wavFromPcm(samples)], { type: 'audio/wav' }), 'speech.wav');
      form.append('model', model);
      if (language && language !== 'auto') form.append('language', language);
      const timeout = AbortSignal.timeout(4500);
      const headers = key ? { Authorization: 'Bearer ' + key } : {};
      const response = await request(url, { method: 'POST', headers, body: form, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new Error(CLOUD_FAILED);
      const data = await response.json();
      if (typeof data.text !== 'string') throw new Error(CLOUD_FAILED);
      return { text: data.text };
    },
  };
}

function createSttRouter({ local, cloud, online, log = () => {} }) {
  async function transcribe(samples, config, signal) {
    signal?.throwIfAborted();
    const cloudAllowed = config.engine === 'cloud' || (config.engine === 'auto' && config.allowCloud === true);
    const cloudReady = cloudAllowed && online() && cloud.isAvailable();
    const engines = cloudReady ? [cloud, local] : [local];
    if (cloudAllowed && !cloudReady) {
      log({ name: cloud.name, ok: false, fallback: local.name, message: CLOUD_FAILED });
    }
    let failure;
    for (const [index, provider] of engines.entries()) {
      const start = performance.now();
      try {
        const result = await provider.transcribe(samples, { signal, language: config.language });
        signal?.throwIfAborted();
        if (!result.text?.trim() || (result.confidence != null && result.confidence < 0.45)) throw new Error(REPEAT);
        log({ name: provider.name, ok: true, text: result.text, ms: Math.round(performance.now() - start) });
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        failure = provider === cloud && error.message !== REPEAT ? new Error(CLOUD_FAILED) : error;
        log({ name: provider.name, ok: false, fallback: engines[index + 1]?.name, message: failure.message,
          ms: Math.round(performance.now() - start) });
      }
    }
    throw failure;
  }
  return { transcribe };
}

module.exports = { modelAvailable, downloadModel, localGigaam, cloudProvider, createSttRouter, wavFromPcm };
