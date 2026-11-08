'use strict';

// Свои звуковые паки: короткие тональные мотивы синтезируются кодом (WAV 16 бит 22050 Гц),
// чужих MP3 в поставке нет. Встроенный пак «nox» пишется в папку данных один раз.
// Владелец может подключить свою папку: файлы сопоставляются по именам состояний.
// Сеть не используется. Ввод-вывод — только по переданным путям.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RATE = 22050;
const MIN_SECONDS = 0.15;
const MAX_SECONDS = 0.5;
const ATTACK_SECONDS = 0.006;
const RELEASE_SECONDS = 0.03;
const DEFAULT_PACK_ID = 'nox';

// Состояния хода, для которых есть звук. Подписи — для будущего окна настроек.
const STATES = ['start', 'done', 'error', 'waiting', 'cancel'];
const STATE_TITLES = {
  start: 'Выполняю',
  done: 'Готово',
  error: 'Ошибка',
  waiting: 'Подождите',
  cancel: 'Отмена',
};

// Встроенные мотивы: частоты (Гц) и длительности (с). Сумма 0,15–0,5 с.
// volume — своя громкость мотива, чтобы «ожидание» и «отмена» были мягче.
const BUILTIN_MOTIFS = Object.freeze({
  start: Object.freeze({ freqs: [523.25, 659.25], durations: [0.09, 0.11] }),
  done: Object.freeze({ freqs: [659.25, 880], durations: [0.1, 0.14] }),
  error: Object.freeze({ freqs: [196, 164.81], durations: [0.14, 0.2] }),
  waiting: Object.freeze({ freqs: [587.33, 587.33], durations: [0.12, 0.12], volume: 0.75 }),
  cancel: Object.freeze({ freqs: [311.13], durations: [0.22], volume: 0.85 }),
});

// Имена файлов, которые считаются состоянием. Без регистра и ё; лишнее игнорируется.
const STATE_ALIASES = {
  start: ['start', 'старт', 'выполняю'],
  done: ['done', 'готово'],
  error: ['error', 'ошибка'],
  waiting: ['waiting', 'жд', 'жду', 'ждем', 'ждём', 'ожидание', 'подожди'],
  cancel: ['cancel', 'отмена'],
};

const SUPPORTED_EXT = new Set(['.wav', '.mp3']);

const ALIAS_TO_STATE = new Map();
for (const [state, aliases] of Object.entries(STATE_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_STATE.set(normalizeName(alias), state);
}

function normalizeName(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').trim();
}

function stateForName(name) {
  return ALIAS_TO_STATE.get(normalizeName(name)) || null;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// WAV 16 бит моно 22050 Гц из последовательности тонов. Частоты в герцах, длительности в секундах.
// Огибающая (мягкий вход и выход каждого тона) убирает щелчки; амплитуда ниже 0,5 шкалы — без клиппинга.
// Короткий мотив добивается тишиной до 0,15 с, длинный обрезается до 0,5 с.
function toneWav({ freqs, durations, volume = 1 } = {}) {
  const tones = Array.isArray(freqs) ? freqs.map(Number) : [];
  const times = Array.isArray(durations) ? durations.map(Number) : [];
  if (tones.length === 0 || tones.length !== times.length) {
    throw new Error('toneWav: частоты и длительности должны быть непустыми массивами одной длины');
  }
  for (let i = 0; i < tones.length; i += 1) {
    if (!Number.isFinite(tones[i]) || tones[i] <= 0) throw new Error(`toneWav: частота ${i + 1} должна быть больше нуля`);
    if (!Number.isFinite(times[i]) || times[i] <= 0) throw new Error(`toneWav: длительность ${i + 1} должна быть больше нуля`);
  }
  const rawVolume = Number(volume);
  const level = Number.isFinite(rawVolume) ? Math.max(0, Math.min(1, rawVolume)) : 1;
  const maxSamples = Math.round(MAX_SECONDS * RATE);
  const minSamples = Math.round(MIN_SECONDS * RATE);

  const notes = [];
  let cursor = 0;
  for (let i = 0; i < tones.length; i += 1) {
    const start = cursor;
    const end = Math.min(maxSamples, cursor + Math.max(1, Math.round(times[i] * RATE)));
    if (end > start) notes.push({ freq: tones[i], start, end });
    cursor = end;
    if (cursor >= maxSamples) break;
  }
  const totalSamples = Math.max(minSamples, cursor);
  const buf = Buffer.alloc(44 + totalSamples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + totalSamples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // моно
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(totalSamples * 2, 40);

  const attack = Math.max(1, Math.round(ATTACK_SECONDS * RATE));
  const release = Math.max(1, Math.round(RELEASE_SECONDS * RATE));
  for (const note of notes) {
    const length = note.end - note.start;
    const rampIn = Math.min(attack, Math.max(1, Math.floor(length / 3)));
    const rampOut = Math.min(release, Math.max(1, Math.floor(length / 3)));
    for (let i = 0; i < length; i += 1) {
      const attackEnv = Math.min(1, i / rampIn);
      const releaseEnv = Math.min(1, (length - 1 - i) / rampOut);
      const decay = Math.exp(-2 * i / length);
      const value = Math.sin(2 * Math.PI * note.freq * i / RATE)
        * attackEnv * releaseEnv * decay * level * 0.5 * 32767;
      // Ограничение на всякий случай: амплитуда и так ниже половины шкалы.
      buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(value))), 44 + (note.start + i) * 2);
    }
  }
  return buf;
}

// Запись через временный файл и переименование: недописанный WAV не остаётся под рабочим именем.
function writeWavAtomic(file, buffer) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buffer);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* временный файл мог не создаться */ }
    throw err;
  }
}

// Один раз создаёт встроенный пак в указанной папке: отсутствующие WAV пишет, существующие не трогает.
function ensureBuiltinPack(packDir) {
  const text = String(packDir || '').trim();
  if (!text) throw new Error('ensureBuiltinPack: нужна папка для встроенного пака');
  const dir = path.resolve(text);
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  const sounds = {};
  for (const state of STATES) {
    const file = path.join(dir, `${state}.wav`);
    sounds[state] = file;
    if (fs.existsSync(file)) continue;
    writeWavAtomic(file, toneWav(BUILTIN_MOTIFS[state]));
    created.push(file);
  }
  return { ok: true, dir, created, sounds };
}

// Разбор папки пака: только обычные файлы WAV/MP3 с именами состояний, без ссылок и путей наружу.
// При нескольких файлах на состояние WAV важнее MP3; внутри одного расширения — по алфавиту.
function scanPackFolder(folder) {
  const result = { ok: false, reason: 'folder_required', dir: '', sounds: {}, ignored: [] };
  const text = String(folder || '').trim();
  if (!text) return result;
  const root = path.resolve(text);
  result.dir = root;
  let stat;
  try { stat = fs.lstatSync(root); } catch { result.reason = 'not_found'; return result; }
  if (stat.isSymbolicLink()) { result.reason = 'unsafe_path'; return result; }
  if (!stat.isDirectory()) { result.reason = 'not_directory'; return result; }
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { result.reason = 'unreadable'; return result; }
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { result.reason = 'unreadable'; return result; }

  const chosen = new Map();
  const ignored = [];
  for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
    if (!entry.isFile()) { ignored.push({ name: entry.name, reason: 'не обычный файл' }); continue; }
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXT.has(ext)) { ignored.push({ name: entry.name, reason: 'не WAV и не MP3' }); continue; }
    const state = stateForName(path.basename(entry.name, path.extname(entry.name)));
    if (!state) { ignored.push({ name: entry.name, reason: 'имя не из пака' }); continue; }
    const abs = path.join(root, entry.name);
    let realFile;
    try { realFile = fs.realpathSync(abs); } catch { ignored.push({ name: entry.name, reason: 'путь не проверен' }); continue; }
    if (!isInside(realRoot, realFile)) { ignored.push({ name: entry.name, reason: 'путь вне папки' }); continue; }
    const score = ext === '.wav' ? 2 : 1;
    const prev = chosen.get(state);
    if (!prev || score > prev.score || (score === prev.score && entry.name.localeCompare(prev.name, 'ru') < 0)) {
      chosen.set(state, { path: abs, name: entry.name, ext, score });
    }
  }
  const sounds = {};
  for (const [state, item] of chosen) sounds[state] = item.path;
  return { ok: true, reason: null, dir: root, sounds, ignored };
}

// Список паков в корневой папке звуков: подпапки с файлами, встроенный «nox» первым.
function listPacks(rootDir) {
  const text = String(rootDir || '').trim();
  if (!text) return [];
  const root = path.resolve(text);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const packs = [];
  for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    const scan = scanPackFolder(dir);
    packs.push({
      id: entry.name,
      name: entry.name === DEFAULT_PACK_ID ? 'Nox' : entry.name,
      builtin: entry.name === DEFAULT_PACK_ID,
      dir,
      sounds: scan.ok ? scan.sounds : {},
      ignored: scan.ok ? scan.ignored : [],
    });
  }
  packs.sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.id.localeCompare(b.id, 'ru'));
  return packs;
}

// Проигрывание WAV через PowerShell SoundPlayer — тот же подход, что в src/voice/beep.js.
// Тихий режим, громкость 0 и не-Windows — не играют; ошибки молча. MP3 честно не обещаем.
function playSound(state, options = {}) {
  try {
    const packId = options.packId ? String(options.packId) : DEFAULT_PACK_ID;
    const quiet = options.quiet === true;
    const volume = options.volume === undefined ? 1 : Number(options.volume);
    const platform = options.platform || process.platform;
    const run = typeof options.run === 'function' ? options.run : spawn;
    if (quiet) return { ok: false, played: false, reason: 'quiet' };
    if (!Number.isFinite(volume) || volume <= 0) return { ok: false, played: false, reason: 'volume' };
    if (platform !== 'win32') return { ok: false, played: false, reason: 'platform' };
    const rootText = String(options.dir || '').trim();
    if (!rootText) return { ok: false, played: false, reason: 'dir_required' };
    if (!/^[\w.-]+$/.test(packId) || packId === '.' || packId === '..') {
      return { ok: false, played: false, reason: 'bad_pack_id' };
    }
    const root = path.resolve(rootText);
    const packDir = path.join(root, packId);
    if (!isInside(root, packDir)) return { ok: false, played: false, reason: 'bad_pack_id' };
    const scan = scanPackFolder(packDir);
    if (!scan.ok) {
      return { ok: false, played: false, reason: scan.reason === 'not_found' ? 'pack_not_found' : scan.reason };
    }
    const file = scan.sounds[String(state || '')];
    if (!file) return { ok: false, played: false, reason: 'sound_not_found' };
    if (path.extname(file).toLowerCase() !== '.wav') {
      return { ok: false, played: false, reason: 'mp3 нужен проигрыватель WPF', path: file };
    }
    const command = `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`;
    const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'ignore', windowsHide: true });
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return { ok: true, played: true, state: String(state || ''), packId, path: file };
  } catch {
    return { ok: false, played: false, reason: 'error' };
  }
}

module.exports = {
  RATE,
  MIN_SECONDS,
  MAX_SECONDS,
  DEFAULT_PACK_ID,
  STATES,
  STATE_TITLES,
  BUILTIN_MOTIFS,
  STATE_ALIASES,
  toneWav,
  ensureBuiltinPack,
  listPacks,
  scanPackFolder,
  playSound,
  stateForName,
};
