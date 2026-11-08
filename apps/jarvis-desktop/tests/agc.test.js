'use strict';

// AGC микрофона: тихий сигнал усиливается, громкий не клиппится, тишина остаётся тишиной,
// статистика честная, мусор не роняет, reset возвращает к началу, гейн меняется плавно.
// Модуль чистый: процессы, звук и файлы не нужны.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAgc, normalizePcm16, DEFAULTS } = require('../src/voice/agc');

// ── помощники: PCM16 little-endian

function pcmConst(amplitude, count) {
  const buffer = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) buffer.writeInt16LE(amplitude, i * 2);
  return buffer;
}

function pcmFrom(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

function rmsOf(buffer) {
  const count = Math.floor(buffer.length / 2);
  if (!count) return 0;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = buffer.readInt16LE(i * 2);
    sum += sample * sample;
  }
  return Math.sqrt(sum / count) / 32768;
}

function maxAbsOf(buffer) {
  let peak = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const sample = Math.abs(buffer.readInt16LE(i));
    if (sample > peak) peak = sample;
  }
  return peak;
}

function assertFiniteStats(stats) {
  for (const key of ['rms', 'peak', 'gain', 'clipped']) {
    assert.equal(Number.isFinite(stats[key]), true, `stats.${key} не число: ${stats[key]}`);
  }
  assert.ok(stats.rms >= 0 && stats.rms <= 1, `stats.rms вне 0..1: ${stats.rms}`);
  assert.ok(stats.peak >= 0 && stats.peak <= 1, `stats.peak вне 0..1: ${stats.peak}`);
  assert.ok(stats.gain > 0 && stats.gain <= 100, `stats.gain вне разумного: ${stats.gain}`);
  assert.equal(Number.isInteger(stats.clipped) && stats.clipped >= 0, true, 'stats.clipped — счётчик ограниченных отсчётов');
}

// ── усиление и антиклип

test('тихий сигнал усиливается, гейн поднимается к максимуму', () => {
  const agc = createAgc();
  const quiet = pcmConst(200, 4000);
  const out = agc.processPcm16(quiet);
  assert.equal(out.length, quiet.length);
  const before = rmsOf(quiet);
  const after = rmsOf(out);
  assert.ok(before > 0);
  assert.ok(after > before * 3, `тихий сигнал почти не усилен: ${before} → ${after}`);
  assert.ok(agc.stats().gain > 4, `гейн ${agc.stats().gain} слишком мал`);
  assert.ok(maxAbsOf(out) <= 32767, 'выход вышел за int16');
});

test('громкий сигнал не клиппится: переходный процесс ограничен, дальше запаса хватает', () => {
  const agc = createAgc();
  agc.processPcm16(pcmConst(150, 4000)); // сначала набираем гейн на тихом
  const loud = pcmConst(20000, 4000);
  const first = agc.processPcm16(loud);
  assert.ok(maxAbsOf(first) <= 32767, 'выход на всплеске вышел за предел');
  assert.ok(agc.stats().clipped > 0, 'антиклип не сработал на всплеске при гейне 8');
  const second = agc.processPcm16(loud);
  assert.equal(agc.stats().clipped, 0, 'в установившемся режиме ограничение уже не нужно');
  assert.ok(maxAbsOf(second) < 32767, 'даже после спада выход упирается в предел');
  assertFiniteStats(agc.stats());
});

// ── тишина и шумовой пол

test('тишина остаётся тишиной, а шум ниже пола не раздувается', () => {
  const agc = createAgc();
  const silence = Buffer.alloc(3200);
  const out = agc.processPcm16(silence);
  assert.equal(out.length, silence.length);
  assert.equal(out.every((byte) => byte === 0), true, 'из тишины появился звук');
  assert.deepEqual(agc.stats(), { rms: 0, peak: 0, gain: 1, clipped: 0 });

  // Шум ниже пола (3 из 32768 при пороге -60 дБ) не усиливается: гейн остаётся 1.
  const noise = pcmConst(3, 4000);
  const noiseOut = agc.processPcm16(noise);
  assert.equal(agc.stats().gain, 1);
  assert.deepEqual(noiseOut, noise, 'шумовой пол не сработал');

  // После набранного гейна тишина не даёт скачка: спад медленный, но уверенный.
  const ramped = createAgc();
  ramped.processPcm16(pcmConst(200, 4000));
  const high = ramped.stats().gain;
  assert.ok(high > 4);
  ramped.processPcm16(Buffer.alloc(1000));
  const dropped = ramped.stats().gain;
  assert.ok(dropped < high, 'гейн не снижается на тишине');
  assert.ok(dropped > 1, 'гейн упал мгновенно, а спад должен быть медленным');
});

// ── статистика

test('stats осмысленны: вход до усиления, гейн в диапазоне, без NaN', () => {
  const agc = createAgc();
  assert.deepEqual(agc.stats(), { rms: 0, peak: 0, gain: 1, clipped: 0 });
  const input = pcmFrom([1000, -2000, 3000, -4000]);
  agc.processPcm16(input);
  const stats = agc.stats();
  assertFiniteStats(stats);
  assert.ok(Math.abs(stats.rms - rmsOf(input)) <= 0.001, 'rms не совпадает с входом');
  assert.ok(Math.abs(stats.peak - 4000 / 32768) <= 0.001, 'peak не совпадает с входом');
  assert.ok(stats.gain >= 1 / DEFAULTS.maxGain && stats.gain <= DEFAULTS.maxGain, `гейн вне диапазона: ${stats.gain}`);
  // stats — копия, а не внутренний объект: порча снаружи не меняет состояние.
  stats.gain = 999;
  assert.notEqual(agc.stats().gain, 999);
  assert.equal(agc.stats().clipped, 0);
});

// ── устойчивость

test('пустой, нечётный и мусорный буфер не падают', () => {
  const agc = createAgc();
  const bad = [null, undefined, 'строка', 42, {}, [], Buffer.alloc(0), Buffer.alloc(1), () => {}];
  for (const value of bad) {
    let out;
    assert.doesNotThrow(() => { out = agc.processPcm16(value); }, `упало на ${String(value)}`);
    assert.equal(Buffer.isBuffer(out), true);
    assert.equal(out.length, 0);
  }
  assertFiniteStats(agc.stats());

  // Нечётный хвостовой байт отбрасывается; чётная часть обрабатывается как обычно.
  const odd = Buffer.from([1, 0, 2, 0, 3]);
  const evenPart = Buffer.from([1, 0, 2, 0]);
  const outOdd = agc.processPcm16(odd);
  assert.equal(outOdd.length, 4);
  assert.deepEqual(outOdd, createAgc().processPcm16(evenPart));

  // Байтовый view тоже принимается (Buffer — его частный случай).
  const view = new Uint8Array([10, 0, 20, 0]);
  assert.deepEqual(agc.processPcm16(view), createAgc().processPcm16(Buffer.from(view)));

  // Крайние значения int16 и случайные байты не дают NaN и выходят в пределах int16.
  const extremes = Buffer.alloc(64 * 2);
  for (let i = 0; i < 64; i += 1) extremes.writeInt16LE(i % 2 ? -32768 : 32767, i * 2);
  const extremesCopy = Buffer.from(extremes);
  const extremeOut = agc.processPcm16(extremes);
  assert.equal(extremeOut.length, extremes.length);
  assert.ok(maxAbsOf(extremeOut) <= 32767);
  assertFiniteStats(agc.stats());
  const garbage = Buffer.from(Array.from({ length: 500 }, (_, index) => (index * 37) % 256));
  const garbageOut = agc.processPcm16(garbage);
  assert.equal(garbageOut.length, garbage.length);
  assert.ok(maxAbsOf(garbageOut) <= 32767);
  assertFiniteStats(agc.stats());
  // Вход не испорчен обработкой.
  assert.deepEqual(extremes, extremesCopy);
});

// ── сброс

test('reset сбрасывает гейн, статистику и обрабатывает как новый', () => {
  const agc = createAgc();
  const quiet = pcmConst(200, 4000);
  agc.processPcm16(quiet);
  assert.ok(agc.stats().gain > 2);
  agc.reset();
  assert.deepEqual(agc.stats(), { rms: 0, peak: 0, gain: 1, clipped: 0 });
  const afterReset = agc.processPcm16(quiet);
  const fresh = createAgc().processPcm16(quiet);
  assert.deepEqual(afterReset, fresh, 'после reset обработка отличается от нового AGC');
});

// ── плавность

test('гейн меняется плавно: подъём быстрый, спад медленный, без скачков', () => {
  const agc = createAgc();
  const oneQuietSample = pcmConst(200, 1);
  let previous = agc.stats().gain;
  const rises = [];
  for (let i = 0; i < 50; i += 1) {
    agc.processPcm16(oneQuietSample);
    const current = agc.stats().gain;
    rises.push(current - previous);
    previous = current;
  }
  assert.ok(rises.every((delta) => delta > 0), 'на тихом гейн должен только расти');
  const maxRise = Math.max(...rises);
  assert.ok(maxRise <= (DEFAULTS.maxGain - 1) * DEFAULTS.attack + 1e-9, `скачок вверх ${maxRise}`);

  const oneSilentSample = Buffer.alloc(2);
  const falls = [];
  for (let i = 0; i < 200; i += 1) {
    agc.processPcm16(oneSilentSample);
    const current = agc.stats().gain;
    falls.push(previous - current);
    previous = current;
  }
  assert.ok(falls.every((delta) => delta >= 0), 'на тишине гейн должен только снижаться');
  const maxFall = Math.max(...falls);
  assert.ok(maxFall <= (DEFAULTS.maxGain - 1) * DEFAULTS.release + 1e-9, `скачок вниз ${maxFall}`);
  assert.ok(maxRise > maxFall * 5, `подъём ${maxRise} не быстрее спада ${maxFall}`);
});

// ── потоковость

test('результат не зависит от размера куска: состояние сохраняется между вызовами', () => {
  const whole = createAgc();
  const chopped = createAgc();
  const signal = pcmConst(200, 4000);
  const wholeOut = whole.processPcm16(signal);
  const pieces = [];
  for (let offset = 0; offset < signal.length; offset += 200) {
    pieces.push(chopped.processPcm16(signal.subarray(offset, offset + 200)));
  }
  const choppedOut = Buffer.concat(pieces);
  assert.deepEqual(choppedOut, wholeOut);
  assert.ok(Math.abs(whole.stats().gain - chopped.stats().gain) < 1e-9);
});

// ── разовая обёртка

test('normalizePcm16 — разовая обёртка без состояния', () => {
  const quiet = pcmConst(200, 8000);
  const out = normalizePcm16(quiet);
  assert.equal(Buffer.isBuffer(out), true);
  assert.equal(out.length, quiet.length);
  assert.ok(rmsOf(out) > rmsOf(quiet) * 3, 'normalizePcm16 не усилил тихий сигнал');
  const limited = normalizePcm16(quiet, { maxGain: 2 });
  assert.ok(rmsOf(limited) < rmsOf(out), 'пониженный maxGain не подействовал');
  assert.equal(normalizePcm16(null).length, 0);
  assert.equal(normalizePcm16(Buffer.alloc(0)).length, 0);
});
