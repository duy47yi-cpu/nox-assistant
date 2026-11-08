'use strict';

// AGC (автоматическая регулировка усиления) для PCM16: чистый модуль без ввода-вывода.
// Задел под собственный захват звука (Vosk/Whisper): сейчас распознавание системное
// (Windows System.Speech) и PCM-поток наружу не отдаёт, поэтому в горячем пути модуль не вызывается.
//
// Как работает:
//   • на куске считается RMS и пик входа; целевой гейн = targetRms / rms (не выше maxGain);
//   • вход ниже шумового пола (floor, дБFS) считается тишиной: гейн плавно возвращается к 1,
//     чтобы дыхание и шум не раздувались до предела;
//   • гейн меняется по одному отсчёту: вверх — attack, вниз — release, поэтому подъём быстрый,
//     а спад медленный; от размера куска поведение не зависит;
//   • антиклип: гейн не поднимается выше запаса до предела и мгновенно снижается, если отсчёт
//     упирается в ±32767; выход всё равно ограничен ±32767;
//   • длина куска любая, нечётный хвостовой байт отбрасывается, состояние между кусками хранится.
//
// stats() возвращает данные за последний кусок: rms и peak входа (0..1 от полной шкалы),
// текущий линейный gain и clipped — сколько отсчётов пришлось ограничить антиклипом.

const FULL = 32768; // полная шкала int16 по модулю
const LIMIT = 32767; // предел выхода: дальше int16 некуда
const HEADROOM = 0.98; // запас, чтобы округление не упиралось в предел
const DEFAULTS = Object.freeze({ targetRms: 0.06, maxGain: 8, attack: 0.02, release: 0.001, floor: -60 });

// Число из настроек: мусор и бесконечности заменяются значением по умолчанию, диапазон — границами.
function numberOr(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (number < min) return min;
  if (number > max) return max;
  return number;
}

// Тело буфера: Buffer или любой байтовый view (Uint8Array и родственники). Остальное — не звук.
function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value) && value.BYTES_PER_ELEMENT === 1) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

// 0..1 без NaN и бесконечностей.
function unit(value) {
  if (!(value > 0)) return 0;
  return value < 1 ? value : 1;
}

// Один AGC. Состояние живёт между вызовами processPcm16; reset() возвращает к началу.
function createAgc(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const targetRms = numberOr(opts.targetRms, DEFAULTS.targetRms, 1e-4, 0.9);
  const maxGain = numberOr(opts.maxGain, DEFAULTS.maxGain, 1, 100);
  const attack = numberOr(opts.attack, DEFAULTS.attack, 1e-6, 1);
  const release = numberOr(opts.release, DEFAULTS.release, 1e-6, 1);
  const floor = numberOr(opts.floor, DEFAULTS.floor, -120, 0);
  const minGain = 1 / maxGain;
  const targetRaw = targetRms * FULL;
  const floorRaw = Math.pow(10, floor / 20) * FULL;

  let gain = 1;
  let lastRms = 0;
  let lastPeak = 0;
  let lastClipped = 0;

  // Один кусок PCM16 little-endian. Не портит входной буфер, возвращает новый той же чётной длины.
  function processPcm16(buffer) {
    const bytes = asBytes(buffer);
    lastRms = 0;
    lastPeak = 0;
    lastClipped = 0;
    if (!bytes || bytes.length < 2) return Buffer.alloc(0);

    const usable = bytes.length - (bytes.length % 2); // нечётный хвост отбрасываем
    const count = usable / 2;

    // 1. Что пришло: RMS и пик входа.
    let sumSq = 0;
    let peakAbs = 0;
    for (let i = 0; i < count; i += 1) {
      const sample = bytes.readInt16LE(i * 2);
      sumSq += sample * sample;
      const abs = sample < 0 ? -sample : sample;
      if (abs > peakAbs) peakAbs = abs;
    }
    const rmsRaw = Math.sqrt(sumSq / count);
    lastRms = unit(rmsRaw / FULL);
    lastPeak = unit(peakAbs / FULL);

    // 2. Куда вести гейн. Тишина и шум ниже пола не усиливаются: цель — 1.
    let desired;
    if (peakAbs === 0 || rmsRaw < floorRaw) {
      desired = 1;
    } else {
      desired = targetRaw / rmsRaw;
    }
    // Антиклип по пику куска: не поднимаем так, чтобы даже пик вышел за предел.
    if (peakAbs > 0) desired = Math.min(desired, (LIMIT * HEADROOM) / peakAbs);
    if (desired < minGain) desired = minGain;
    if (desired > maxGain) desired = maxGain;

    // 3. Покадрово: плавный гейн, мгновенный предел по отсчёту, запись.
    const out = Buffer.allocUnsafe(usable);
    let current = gain;
    for (let i = 0; i < count; i += 1) {
      const sample = bytes.readInt16LE(i * 2);
      current += (desired - current) * (desired > current ? attack : release);
      if (current < minGain) current = minGain;
      if (current > maxGain) current = maxGain;
      if (sample !== 0) {
        // Мгновенный предел: этот отсчёт не должен упереться в ±32767 даже на всплеске.
        const abs = sample < 0 ? -sample : sample;
        const allowed = LIMIT / abs;
        if (current > allowed) {
          current = allowed;
          lastClipped += 1;
        }
      }
      let value = Math.round(sample * current);
      // Страховка на округлении: выход всегда в пределах int16.
      if (value > LIMIT) {
        value = LIMIT;
        lastClipped += 1;
      } else if (value < -LIMIT) {
        value = -LIMIT;
        lastClipped += 1;
      }
      out.writeInt16LE(value, i * 2);
    }
    gain = current;
    return out;
  }

  // Данные за последний кусок: вход до усиления, текущий гейн, сколько отсчётов ограничено.
  function stats() {
    return { rms: lastRms, peak: lastPeak, gain, clipped: lastClipped };
  }

  // Всё как в начале: гейн 1, статистика обнулена.
  function reset() {
    gain = 1;
    lastRms = 0;
    lastPeak = 0;
    lastClipped = 0;
  }

  return { processPcm16, stats, reset };
}

// Разовая нормализация целого буфера: свой AGC на один вызов, без хранения состояния.
function normalizePcm16(buffer, options = {}) {
  return createAgc(options).processPcm16(buffer);
}

module.exports = {
  createAgc,
  normalizePcm16,
  DEFAULTS,
};
