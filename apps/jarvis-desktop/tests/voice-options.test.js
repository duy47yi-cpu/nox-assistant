'use strict';

// Голос: выбор голоса/громкости/скорости, честные причины отказа, остановка посреди фразы.
// Синтез не запускается: процесс подменён, Python и звук не нужны.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  SpeechClient, PLAY_SCRIPT, PLAY_WPF_SCRIPT, playScriptFor,
  clampVolume, clampRate, cleanSpeaker, wavDurationMs, VOLUME_MIN, VOLUME_MAX, RATE_MIN, RATE_MAX,
} = require('../src/voice/tts');
const { FishSpeech, PLAY_SCRIPT: FISH_PLAY_SCRIPT } = require('../src/voice/fish');
const {
  describeError, dictationScript, dictationCulture,
  NO_AUDIO_MESSAGE, NO_ENGINE_MESSAGE, NO_LANGUAGE_MESSAGE,
} = require('../src/voice/dictation');

const win = process.platform === 'win32';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── фейковый процесс синтеза

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.received = [];
    this.killed = false;
    this.onRequest = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new EventEmitter();
    this.stdin.write = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        this.received.push(request);
        if (this.onRequest) this.onRequest(request);
      }
      return true;
    };
  }

  reply(obj) {
    setImmediate(() => this.stdout.write(`${JSON.stringify(obj)}\n`));
  }

  kill() {
    this.killed = true;
    return true;
  }
}

function fakeSpawn(behavior) {
  const spawned = [];
  const spawnImpl = () => {
    const proc = new FakeProcess();
    proc.onRequest = (request) => behavior(proc, request);
    spawned.push(proc);
    return proc;
  };
  return { spawnImpl, spawned };
}

function clientWith(behavior, options = {}) {
  const fake = fakeSpawn(behavior);
  const client = new SpeechClient({ spawnImpl: fake.spawnImpl, timeoutMs: 1000, ...options });
  return { client, spawned: fake.spawned };
}

// ── настройки голоса

test('громкость и скорость ограничены разумными пределами', () => {
  assert.equal(clampVolume(0.4), 0.4);
  assert.equal(clampVolume(-1), VOLUME_MIN);
  assert.equal(clampVolume(5), VOLUME_MAX);
  assert.equal(clampVolume('нет', 0.7), 0.7);
  assert.equal(clampRate(1.5), 1.5);
  assert.equal(clampRate(0.1), RATE_MIN);
  assert.equal(clampRate(9), RATE_MAX);
  assert.equal(clampRate(undefined, 0.8), 0.8);
  assert.equal(cleanSpeaker('  aidar '), 'aidar');
  assert.equal(cleanSpeaker('   '), null);
  assert.equal(cleanSpeaker(undefined), null);
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

test('клиент хранит голос, громкость и скорость и отдаёт их в синтез и проигрывание', async (t) => {
  const played = [];
  const { client, spawned } = clientWith((proc, request) => proc.reply({ id: request.id, ok: true, file: 'C:\\out\\a.wav' }), {
    speaker: ' aidar ',
    volume: 0.6,
    rate: 1.25,
    playFn: async (file, options) => { played.push({ file, options }); return { ok: true, summary: 'ok' }; },
  });
  t.after(() => client.stop());
  assert.deepEqual(client.options(), { speaker: 'aidar', volume: 0.6, rate: 1.25 });
  assert.deepEqual(client.setOptions({ volume: 2 }), { speaker: 'aidar', volume: 1, rate: 1.25 }, 'громкость не выше 1');
  assert.deepEqual(client.options(), { speaker: 'aidar', volume: 1, rate: 1.25 });
  client.setOptions({ volume: 0.5, rate: 0.75 });

  await client.speak('привет');
  assert.equal(spawned[0].received[0].speaker, 'aidar', 'голос уходит в запрос синтеза');
  assert.equal(played.length, 1);
  assert.equal(played[0].options.volume, 0.5);
  assert.equal(played[0].options.rate, 0.75);

  // Явные настройки вызова важнее сохранённых.
  await client.play('C:\\out\\b.wav', { volume: 0.2, rate: 1.5 });
  assert.equal(played[1].options.volume, 0.2);
  assert.equal(played[1].options.rate, 1.5);
});

test('голос по умолчанию: speaker в запрос не добавляется, проигрывание получает 1 и 1', async (t) => {
  const played = [];
  const { client, spawned } = clientWith((proc, request) => proc.reply({ id: request.id, ok: true, file: 'C:\\out\\a.wav' }), {
    playFn: async (file, options) => { played.push(options); return { ok: true, summary: 'ok' }; },
  });
  t.after(() => client.stop());
  await client.speak('текст');
  assert.equal('speaker' in spawned[0].received[0], false);
  assert.equal(played[0].volume, 1);
  assert.equal(played[0].rate, 1);
});

test('список голосов: сервер отвечает voices, клиент разбирает и не смешивает с синтезом', async (t) => {
  const { client, spawned } = clientWith((proc, request) => {
    if (request.op === 'voices') proc.reply({ id: request.id, ok: true, voices: ['aidar', 'baya', 'kseniya'] });
  });
  t.after(() => client.stop());
  assert.deepEqual(await client.listVoices(), ['aidar', 'baya', 'kseniya']);
  assert.equal(spawned[0].received[0].op, 'voices');
});

test('голос не установлен: причина называет, чего нет — модели или Python', () => {
  const missingDir = path.join(__dirname, 'no-such-dir-voice');
  const noScript = new SpeechClient({ command: process.execPath, scriptPath: path.join(missingDir, 'silero_server.py') });
  const scriptState = noScript.availability();
  assert.equal(scriptState.available, false);
  assert.match(scriptState.reason, /Silero/);

  const noPython = new SpeechClient({ command: path.join(missingDir, 'python.exe'), scriptPath: __filename });
  const pythonState = noPython.availability();
  assert.equal(pythonState.available, false);
  assert.match(pythonState.reason, /Python/);

  const present = new SpeechClient({ command: process.execPath, scriptPath: __filename });
  assert.deepEqual(present.availability(), { available: true, provider: 'local', reason: null });
  assert.equal(present.isInstalled(), true);

  const disabled = new SpeechClient({ command: process.execPath, scriptPath: __filename });
  disabled._disabledReason = 'локальный голос не отвечает';
  assert.match(disabled.availability().reason, /не отвечает/);
});

test('остановка посреди фразы: ожидание синтеза завершается причиной, процесс убит', async (t) => {
  const { client, spawned } = clientWith(() => {});
  t.after(() => client.stop());
  const pending = client.synthesize('длинная фраза');
  await wait(10);
  client.stop();
  await assert.rejects(pending, /голос остановлен/);
  assert.equal(spawned[0].killed, true);
});

// ── диктовка: скрипт и честные причины

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

// ── протокол Silero-сервера (модель не грузится: синтез подменён)

function hasPython() {
  try {
    execFileSync('python', ['--version'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

const python = hasPython();

test('Silero-сервер: список голосов, синтез выбранным голосом и отказ на чужой', { skip: !python, timeout: 30000 }, () => {
  const serverDir = path.join(__dirname, '..', 'scripts', 'tts');
  const program = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(serverDir)})`,
    'import silero_server',
    'class FakeSynth:',
    "    speakers = ['aidar', 'baya']",
    "    default_speaker = 'aidar'",
    '    def voices(self):',
    '        return list(self.speakers)',
    '    def synthesize(self, req_id, text, speaker):',
    '        if self.speakers and speaker not in self.speakers:',
    "            raise RuntimeError('голос «%s» не найден. Доступны: %s' % (speaker, ', '.join(self.speakers)))",
    "        return 'C:/out/%s.wav' % req_id",
    'synth = FakeSynth()',
    'def call(payload):',
    "    return silero_server.handle_request(synth, json.dumps(payload, ensure_ascii=False))",
    "print(json.dumps([",
    "    call({'id': 'v1', 'op': 'voices'}),",
    "    call({'id': 'v2', 'text': 'привет', 'speaker': 'baya'}),",
    "    call({'id': 'v3', 'text': 'привет', 'speaker': 'чужой'}),",
    "    call({'id': 'плохой', 'text': 'привет'}),",
    '], ensure_ascii=False))',
  ].join('\n');
  const result = execFileSync('python', ['-'], {
    input: program,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  const [voices, synth, wrongVoice, badId] = JSON.parse(result);
  assert.deepEqual(voices, { id: 'v1', ok: true, voices: ['aidar', 'baya'] });
  assert.equal(synth.ok, true);
  assert.equal(synth.file, 'C:/out/v2.wav');
  assert.equal(wrongVoice.ok, false);
  assert.match(wrongVoice.error, /не найден. Доступны: aidar, baya/);
  assert.equal(badId.ok, false);
  assert.match(badId.error, /id:/);
});
