'use strict';

// Свои звуковые паки: мотивы синтезируются кодом, WAV 16 бит 22050 Гц, без щелчков и клиппинга.
// Встроенный пак пишется один раз; папку владельца разбираем по именам; тихий режим и громкость 0 не играют.
// Всё на временных папках (%TEMP%); настоящая data/ не читается.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RATE,
  DEFAULT_PACK_ID,
  STATES,
  BUILTIN_MOTIFS,
  toneWav,
  ensureBuiltinPack,
  listPacks,
  scanPackFolder,
  playSound,
} = require('../src/voice/packs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-sound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function wavInfo(buf) {
  return {
    riff: buf.toString('ascii', 0, 4),
    wave: buf.toString('ascii', 8, 12),
    fmt: buf.toString('ascii', 12, 16),
    format: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    rate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bits: buf.readUInt16LE(34),
    dataTag: buf.toString('ascii', 36, 40),
    dataSize: buf.readUInt32LE(40),
    samples: buf.readUInt32LE(40) / 2,
  };
}

function pcmOf(buf) {
  const count = buf.readUInt32LE(40) / 2;
  const out = new Int16Array(count);
  for (let i = 0; i < count; i += 1) out[i] = buf.readInt16LE(44 + i * 2);
  return out;
}

const fakeRun = (calls) => (cmd, args, opts) => {
  calls.push({ cmd, args, opts });
  return { on() {}, unref() {} };
};

test('toneWav: заголовок WAV 16 бит 22050 моно и длина по длительностям', () => {
  const buf = toneWav({ freqs: [440, 660], durations: [0.1, 0.15] });
  const info = wavInfo(buf);
  assert.equal(info.riff, 'RIFF');
  assert.equal(info.wave, 'WAVE');
  assert.equal(info.fmt, 'fmt ');
  assert.equal(info.format, 1, 'PCM');
  assert.equal(info.channels, 1, 'моно');
  assert.equal(info.rate, RATE);
  assert.equal(info.byteRate, RATE * 2);
  assert.equal(info.blockAlign, 2);
  assert.equal(info.bits, 16);
  assert.equal(info.dataTag, 'data');
  const expected = Math.round(0.1 * RATE) + Math.round(0.15 * RATE);
  assert.equal(info.samples, expected);
  assert.equal(info.dataSize, expected * 2);
  assert.equal(buf.length, 44 + expected * 2);
  const seconds = info.samples / RATE;
  assert.ok(seconds >= 0.15 && seconds <= 0.5, String(seconds));
});

test('toneWav: огибающая без щелчков и клиппинга', () => {
  const pcm = pcmOf(toneWav({ freqs: [880], durations: [0.3] }));
  assert.ok(pcm.length > 0);
  let peak = 0;
  for (const value of pcm) peak = Math.max(peak, Math.abs(value));
  assert.ok(peak > 1000, `тон слышен, пик ${peak}`);
  assert.ok(peak <= 16384, `пик ${peak} ниже половины шкалы`);
  for (const value of pcm) {
    assert.notEqual(value, -32768);
    assert.notEqual(value, 32767);
  }
  // Края у нуля: без шага в начале и обрыва в конце (то есть без щелчка).
  for (const value of pcm.slice(0, 4)) assert.ok(Math.abs(value) < 300, String(value));
  for (const value of pcm.slice(-4)) assert.ok(Math.abs(value) < 300, String(value));
});

test('toneWav: короткий мотив добивается тишиной до 0,15 с, длинный обрезается до 0,5 с', () => {
  const short = toneWav({ freqs: [440], durations: [0.05] });
  assert.equal(wavInfo(short).samples, Math.round(0.15 * RATE));
  assert.ok(pcmOf(short).slice(-100).every((value) => value === 0), 'хвост тишины');
  const long = toneWav({ freqs: [440], durations: [0.9] });
  assert.equal(wavInfo(long).samples, Math.round(0.5 * RATE));
  assert.throws(() => toneWav({ freqs: [], durations: [] }));
  assert.throws(() => toneWav({ freqs: [440, 660], durations: [0.1] }), 'длины массивов не совпали');
  assert.throws(() => toneWav({ freqs: [0], durations: [0.2] }), 'нулевая частота');
  assert.throws(() => toneWav({ freqs: [440], durations: [0] }), 'нулевая длительность');
});

test('встроенные мотивы: пять состояний, длительность 0,15–0,5 с, частоты положительны', () => {
  assert.deepEqual(STATES, ['start', 'done', 'error', 'waiting', 'cancel']);
  for (const state of STATES) {
    const motif = BUILTIN_MOTIFS[state];
    const total = motif.durations.reduce((sum, item) => sum + item, 0);
    assert.ok(total >= 0.15 && total <= 0.5, `${state}: ${total}`);
    assert.equal(motif.freqs.length, motif.durations.length, state);
    for (const freq of motif.freqs) assert.ok(freq > 0, state);
  }
  const keys = new Set(STATES.map((state) => JSON.stringify(BUILTIN_MOTIFS[state])));
  assert.equal(keys.size, STATES.length, 'мотивы не повторяют друг друга');
});

test('ensureBuiltinPack: создаёт пять WAV один раз и не перезаписывает', (t) => {
  const base = tempDir(t);
  const dir = path.join(base, 'sound-packs', DEFAULT_PACK_ID);
  const first = ensureBuiltinPack(dir);
  assert.equal(first.ok, true);
  assert.equal(first.created.length, STATES.length);
  for (const state of STATES) {
    const file = path.join(dir, `${state}.wav`);
    assert.equal(first.sounds[state], file);
    assert.ok(fs.existsSync(file));
    const buf = fs.readFileSync(file);
    const info = wavInfo(buf);
    assert.equal(info.rate, RATE);
    assert.equal(info.bits, 16);
    assert.equal(buf.length, 44 + info.samples * 2);
    const seconds = info.samples / RATE;
    assert.ok(seconds >= 0.15 && seconds <= 0.5, `${state}: ${seconds}`);
  }
  const before = fs.readFileSync(path.join(dir, 'done.wav'));
  const second = ensureBuiltinPack(dir);
  assert.equal(second.created.length, 0, 'повторно ничего не создаётся');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'done.wav')), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), STATES.map((state) => `${state}.wav`).sort());
});

test('scanPackFolder: имена без регистра и ё, MP3 виден, мусор игнорируется', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'Старт.WAV'), 'x');
  fs.writeFileSync(path.join(dir, 'Готово.MP3'), 'x');
  fs.writeFileSync(path.join(dir, 'ОШИБКА.wav'), 'x');
  fs.writeFileSync(path.join(dir, 'ЖДЁМ.wav'), 'x');
  fs.writeFileSync(path.join(dir, 'отмена.Wav'), 'x');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'cover.png'), 'x');
  fs.writeFileSync(path.join(dir, 'неизвестно.wav'), 'x');
  const scan = scanPackFolder(dir);
  assert.equal(scan.ok, true, scan.reason);
  assert.deepEqual(Object.keys(scan.sounds).sort(), ['cancel', 'done', 'error', 'start', 'waiting']);
  assert.equal(path.basename(scan.sounds.start), 'Старт.WAV');
  assert.equal(path.basename(scan.sounds.done), 'Готово.MP3');
  assert.equal(path.basename(scan.sounds.waiting), 'ЖДЁМ.wav');
  assert.ok(scan.ignored.some((item) => item.name === 'readme.txt'));
  assert.ok(scan.ignored.some((item) => item.name === 'неизвестно.wav'));
});

test('scanPackFolder: при двух файлах одного состояния WAV важнее MP3', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'Готово.MP3'), 'x');
  fs.writeFileSync(path.join(dir, 'done.wav'), 'x');
  const scan = scanPackFolder(dir);
  assert.equal(scan.ok, true, scan.reason);
  assert.equal(path.basename(scan.sounds.done), 'done.wav');
});

test('scanPackFolder: нет папки, это файл или пустой путь — честный отказ', (t) => {
  const base = tempDir(t);
  assert.equal(scanPackFolder('').ok, false);
  assert.equal(scanPackFolder('').reason, 'folder_required');
  assert.equal(scanPackFolder(path.join(base, 'нет-такой')).reason, 'not_found');
  const file = path.join(base, 'файл.wav');
  fs.writeFileSync(file, 'x');
  assert.equal(scanPackFolder(file).reason, 'not_directory');
});

test('listPacks: встроенный «nox» первым, папка владельца видна, пустой корень — пусто', (t) => {
  const root = tempDir(t);
  ensureBuiltinPack(path.join(root, DEFAULT_PACK_ID));
  const custom = path.join(root, 'мои');
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, 'выполняю.wav'), 'x');
  fs.writeFileSync(path.join(custom, 'готово.mp3'), 'x');
  const packs = listPacks(root);
  assert.equal(packs.length, 2);
  assert.equal(packs[0].id, DEFAULT_PACK_ID);
  assert.equal(packs[0].builtin, true);
  assert.equal(packs[0].name, 'Nox');
  assert.equal(Object.keys(packs[0].sounds).length, STATES.length);
  const mine = packs.find((pack) => pack.id === 'мои');
  assert.ok(mine);
  assert.equal(mine.builtin, false);
  assert.equal(path.basename(mine.sounds.start), 'выполняю.wav');
  assert.equal(path.basename(mine.sounds.done), 'готово.mp3');
  assert.deepEqual(listPacks(path.join(root, 'нет-такой')), []);
});

test('playSound: тихий режим и громкость 0 не играют, процесс не запускается', (t) => {
  const root = tempDir(t);
  ensureBuiltinPack(path.join(root, DEFAULT_PACK_ID));
  const calls = [];
  const run = fakeRun(calls);
  const quiet = playSound('done', { dir: root, quiet: true, run, platform: 'win32' });
  assert.equal(quiet.ok, false);
  assert.equal(quiet.played, false);
  assert.equal(quiet.reason, 'quiet');
  const zero = playSound('done', { dir: root, volume: 0, run, platform: 'win32' });
  assert.equal(zero.ok, false);
  assert.equal(zero.played, false);
  assert.equal(zero.reason, 'volume');
  assert.equal(calls.length, 0);
});

test('playSound: не-Windows, нет пака, нет состояния — отказ без процесса', (t) => {
  const root = tempDir(t);
  const calls = [];
  const run = fakeRun(calls);
  assert.equal(playSound('done', { dir: root, run, platform: 'linux' }).reason, 'platform');
  const noPack = playSound('done', { dir: root, run, platform: 'win32' });
  assert.equal(noPack.ok, false);
  assert.equal(noPack.reason, 'pack_not_found');
  ensureBuiltinPack(path.join(root, DEFAULT_PACK_ID));
  const noState = playSound('нет-такого', { dir: root, run, platform: 'win32' });
  assert.equal(noState.ok, false);
  assert.equal(noState.reason, 'sound_not_found');
  const bad = playSound('done', { dir: root, packId: '..', run, platform: 'win32' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_pack_id');
  assert.equal(calls.length, 0);
});

test('playSound: MP3 честно не обещаем — reason про WPF, без запуска', (t) => {
  const root = tempDir(t);
  const pack = path.join(root, DEFAULT_PACK_ID);
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, 'готово.mp3'), 'ID3');
  const calls = [];
  const res = playSound('done', { dir: root, run: fakeRun(calls), platform: 'win32' });
  assert.equal(res.ok, false);
  assert.equal(res.played, false);
  assert.equal(res.reason, 'mp3 нужен проигрыватель WPF');
  assert.match(res.path, /готово\.mp3$/);
  assert.equal(calls.length, 0);
});

test('playSound: WAV играет одним процессом PowerShell; сбой запуска не врёт', (t) => {
  const root = tempDir(t);
  ensureBuiltinPack(path.join(root, DEFAULT_PACK_ID));
  const calls = [];
  const res = playSound('done', { dir: root, run: fakeRun(calls), platform: 'win32', volume: 0.7 });
  assert.equal(res.ok, true);
  assert.equal(res.played, true);
  assert.equal(res.state, 'done');
  assert.equal(res.packId, DEFAULT_PACK_ID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');
  const command = calls[0].args.join(' ');
  assert.match(command, /SoundPlayer/);
  assert.match(command, /done\.wav/);
  const broken = playSound('done', { dir: root, platform: 'win32', run() { throw new Error('нет powershell'); } });
  assert.equal(broken.ok, false);
  assert.equal(broken.played, false);
  assert.equal(broken.reason, 'error');
});
