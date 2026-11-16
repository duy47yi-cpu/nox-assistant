'use strict';

// Проигрывание облачного аудио и сообщения об ошибках диктовки.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  PLAY_SCRIPT, PLAY_WPF_SCRIPT, playScriptFor,
  clampVolume, clampRate, wavDurationMs, VOLUME_MIN, VOLUME_MAX, RATE_MIN, RATE_MAX,
} = require('../src/voice/tts');
const { FishSpeech, PLAY_SCRIPT: FISH_PLAY_SCRIPT } = require('../src/voice/fish');
const {
  describeError, dictationScript, dictationCulture,
  NO_AUDIO_MESSAGE, NO_ENGINE_MESSAGE, NO_LANGUAGE_MESSAGE,
} = require('../src/voice/dictation');

const win = process.platform === 'win32';

test('громкость и скорость ограничены разумными пределами', () => {
  assert.equal(clampVolume(0.4), 0.4);
  assert.equal(clampVolume(-1), VOLUME_MIN);
  assert.equal(clampVolume(5), VOLUME_MAX);
  assert.equal(clampVolume('нет', 0.7), 0.7);
  assert.equal(clampRate(1.5), 1.5);
  assert.equal(clampRate(0.1), RATE_MIN);
  assert.equal(clampRate(9), RATE_MAX);
  assert.equal(clampRate(undefined, 0.8), 0.8);
});

test('настройки по умолчанию играют прежним SoundPlayer, изменённые — WPF с громкостью и скоростью', () => {
  assert.equal(playScriptFor({}).script, PLAY_SCRIPT);
  assert.equal(playScriptFor({ volume: 1, rate: 1 }).script, PLAY_SCRIPT);
  assert.equal(playScriptFor({ volume: 0.5 }).script, PLAY_WPF_SCRIPT);
  assert.equal(playScriptFor({ rate: 1.4 }).script, PLAY_WPF_SCRIPT);
  for (const name of ['JARVIS_WAV_VOLUME', 'JARVIS_WAV_RATE', 'JARVIS_WAV_MS']) {
    assert.match(PLAY_WPF_SCRIPT, new RegExp(name), `скрипт громкости использует ${name}`);
  }
  assert.match(PLAY_WPF_SCRIPT, /SpeedRatio/);
  assert.match(FISH_PLAY_SCRIPT, /JARVIS_MP3_VOLUME/);
  assert.match(FISH_PLAY_SCRIPT, /JARVIS_MP3_RATE/);
  assert.match(FISH_PLAY_SCRIPT, /SpeedRatio/);
});

test('длительность wav считается по заголовку: нужна для остановки в конце фразы', () => {
  const sampleRate = 48000;
  const seconds = 2;
  const data = Buffer.alloc(sampleRate * 2 * seconds); // моно, 16 бит
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // моно
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  assert.equal(wavDurationMs(Buffer.concat([header, data])), 2000);
  assert.equal(wavDurationMs(Buffer.from('не wav')), 0);
  assert.equal(wavDurationMs(null), 0);
});

test('describeError: нет языка, нет микрофона, движок не запустился — свои слова', () => {
  assert.equal(describeError({ type: 'error', code: 'no_language' }), NO_LANGUAGE_MESSAGE);
  assert.equal(describeError({ type: 'error', code: 'no_audio', message: 'сырой текст' }), NO_AUDIO_MESSAGE);
  assert.equal(describeError({ type: 'error', code: 'no_engine' }), NO_ENGINE_MESSAGE);
  assert.equal(describeError({ type: 'error', code: 'mic_busy', message: 'микрофон занят' }), 'микрофон занят');
  assert.equal(describeError({ type: 'error', code: 'unknown' }), 'Распознавание не удалось');
  assert.equal(describeError({ type: 'error', code: 'no_audio', message: '' }), NO_AUDIO_MESSAGE);
});

test('скрипт раннера: исправленный LoadGrammar, JSON-события и безопасный язык', () => {
  const script = dictationScript();
  assert.match(script, /LoadGrammar\(\(New-Object System\.Speech\.Recognition\.DictationGrammar\)\)/);
  assert.doesNotMatch(script, /LoadGrammar\(New-Object/);
  assert.match(script, /SetInputToDefaultAudioDevice/);
  assert.match(script, /RecognizeAsync/);
  assert.match(script, /no_audio/);
  assert.match(script, /no_engine/);
  assert.match(script, /"code":"no_language"/);
  // Каждый JSON-литерал события разбирается: иначе главный процесс не увидит событие.
  const literals = [...script.matchAll(/'(\{"type":"[^']*\})'/g)].map((match) => match[1]);
  assert.ok(literals.length >= 2);
  for (const literal of literals) assert.doesNotThrow(() => JSON.parse(literal), literal);
  assert.equal(dictationCulture('ru'), 'ru');
  assert.equal(dictationCulture('en-US'), 'en-US');
  assert.equal(dictationCulture('ru"; calc; "'), 'ru', 'язык не подставляет произвольный текст');
  assert.equal(dictationCulture(undefined), 'ru');
});

test('скрипты PowerShell синтаксически верны: раннер диктовки и проигрыватели', { skip: !win, timeout: 60000 }, async () => {
  const scripts = { dictation: dictationScript(), wav: PLAY_WPF_SCRIPT, mp3: FISH_PLAY_SCRIPT };
  for (const [name, script] of Object.entries(scripts)) {
    const inner = "$s = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:NOX_PS_SYNTAX)); [void][scriptblock]::Create($s); Write-Output 'OK'";
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    const result = await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        env: { ...process.env, NOX_PS_SYNTAX: Buffer.from(script, 'utf16le').toString('base64') },
        timeout: 20000,
        windowsHide: true,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    assert.equal(result.error, null, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /OK/);
  }
});

// ── Fish Audio: громкость и скорость

test('Fish: громкость и скорость из настроек уходят в проигрывание, голос — в синтез', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-fish-voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const played = [];
  const speech = new FishSpeech({
    apiKey: 'k',
    voiceId: 'voice-7',
    tmpDir: dir,
    volume: 0.4,
    rate: 1.3,
    fetchImpl: async () => ({ ok: true, status: 200, async arrayBuffer() { return Buffer.from([0x49, 0x44, 0x33]); } }),
    playFn: async (file, options) => { played.push(options); return { ok: true, summary: 'ok' }; },
  });
  assert.deepEqual(speech.options(), { volume: 0.4, rate: 1.3 });
  speech.setOptions({ volume: 9, rate: 0.1 });
  assert.deepEqual(speech.options(), { volume: 1, rate: 0.5 });
  speech.setOptions({ volume: 0.5, rate: 1.5 });
  await speech.speak('текст');
  assert.equal(played[0].volume, 0.5);
  assert.equal(played[0].rate, 1.5);

  // Явный вызов важнее сохранённых настроек.
  const file = await speech.synthesize('ещё');
  await speech.play(file, { volume: 0.2, rate: 2 });
  assert.equal(played[1].volume, 0.2);
  assert.equal(played[1].rate, 2);
  fs.rmSync(file, { force: true });
});

test('Fish: без ключа причина отказа называет ключ, а не молчит', () => {
  const speech = new FishSpeech({ apiKey: '' });
  assert.deepEqual(speech.availability(), {
    available: false,
    provider: 'fish',
    reason: 'Облачный голос не настроен: нет ключа голоса. Впишите FISH_API_KEY в .env',
  });
  assert.equal(speech.isInstalled(), false);
  assert.equal(new FishSpeech({ apiKey: 'k' }).availability().available, true);
});
