'use strict';

// Живая проверка чтения вслух на настоящем звуке.
//
// Речь синтезирует системный голос Windows (SAPI) в wav — без интернета, моделей и установок.
// Проигрывает её тот же код, что и в продукте: SpeechClient.play → PowerShell (SoundPlayer).
// Проверяется управление: пауза обрывает звук, продолжение начинает тот же кусок, стоп прекращает чтение.
//
// Запуск: node scripts/read-aloud-check.js [папка для wav]
// Без звуковой карты проверка честно скажет, что играть некуда.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SpeechClient } = require('../src/voice/tts');
const { createReader } = require('../src/voice/reader');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'nox-read-aloud-check');
const SENTENCES = [
  'Первое предложение читается спокойно и не спеша, чтобы его можно было прервать на середине.',
  'Второе предложение нужно для проверки продолжения с того же места после паузы.',
  'Третье предложение закрывает проверку, и после него чтение должно закончиться.',
];

// Системный голос Windows в wav. Ничего не скачивает и не ставит.
function synthesize(text, file) {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SetOutputToWaveFile($env:NOX_WAV)`,
    `$s.Speak($env:NOX_TEXT)`,
    '$s.Dispose()',
    'if (Test-Path $env:NOX_WAV) { "OK" } else { "NO_FILE" }',
  ].join('; ');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, NOX_WAV: file, NOX_TEXT: text },
    encoding: 'utf8',
    timeout: 60000,
  });
  const out = String((res.stdout || '') + (res.stderr || '')).trim();
  return { ok: fs.existsSync(file) && fs.statSync(file).size > 1000, out: out.slice(-200) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { out: OUT, device: null, synth: [], played: [], ok: false };

  // Куда играть: если устройств вывода нет, SoundPlayer вернёт ошибку — это честный результат.
  const dev = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Voice.Name'],
  { encoding: 'utf8', timeout: 30000 });
  report.systemVoice = String(dev.stdout || '').trim();

  const files = SENTENCES.map((text, i) => {
    const file = path.join(OUT, `fragment-${i + 1}.wav`);
    const res = synthesize(text, file);
    report.synth.push({ file: path.basename(file), ok: res.ok, note: res.ok ? null : res.out });
    return file;
  });
  if (!report.synth.every((s) => s.ok)) {
    report.note = 'системный голос не смог сделать wav — проверять нечего';
    return report;
  }

  const client = new SpeechClient();
  const said = [];
  const playedAt = [];
  let currentNote = null;

  const reader = createReader({
    speak: async (text, signal) => {
      const index = SENTENCES.indexOf(text);
      said.push({ text: text.slice(0, 20), at: Date.now() });
      playedAt.push(Date.now());
      if (index < 0) return;
      currentNote = path.basename(files[index]);
      const started = Date.now();
      await client.play(files[index], { signal });
      report.played.push({ file: currentNote, ms: Date.now() - started });
    },
  });

  reader.start(SENTENCES.join(' '), { label: 'проверка' });
  report.parts = reader.snapshot().total;
  // Ждём, пока первый кусок прозвучит целиком: так видно, что звук действительно играет.
  const waitFor = async (check, ms = 20000) => {
    const t0 = Date.now();
    while (!check() && Date.now() - t0 < ms) await sleep(50);
    return check();
  };
  await waitFor(() => report.played.length >= 1);
  report.firstPartMs = report.played[0] ? report.played[0].ms : 0;
  // Пауза приходится на второй кусок.

  // Пауза посреди первого предложения: звук должен оборваться сразу.
  await sleep(300);
  const beforePause = reader.snapshot();
  const pauseAt = Date.now();
  const paused = reader.pause();
  await sleep(400);
  const pauseLatencyMs = Date.now() - pauseAt;
  report.pause = {
    state: paused.state,
    index: paused.index,
    wasPlayingIndex: beforePause.index,
    latencyMs: pauseLatencyMs,
    soundStopped: reader.snapshot().state === 'paused',
  };
  await sleep(600);
  report.silenceWhilePaused = said.length;

  // Продолжение: тот же кусок, а не следующий и не начало текста.
  const resumed = reader.resume();
  await sleep(600);
  report.resume = {
    state: resumed.state,
    index: resumed.index,
    // Кусок, который звучал до паузы, должен зазвучать снова — тот же, а не следующий.
    repeatedSamePart: said.length > report.silenceWhilePaused
      && said[said.length - 1].text === said[report.silenceWhilePaused - 1].text,
    said: said.map((s) => s.text),
  };

  // Стоп: звук прекращается, новых кусков нет.
  const stopped = reader.stop();
  const countAtStop = said.length;
  await sleep(700);
  report.stop = { state: stopped.state, saidAfterStop: said.length - countAtStop, busy: reader.busy };
  await reader.finished().catch(() => {});
  report.finalState = reader.snapshot().state;
  report.said = said.map((s) => s.text);
  report.ok = report.pause.state === 'paused'
    && report.pause.soundStopped
    && report.resume.state === 'playing'
    && report.resume.repeatedSamePart
    && report.stop.state === 'stopped'
    && report.stop.saidAfterStop === 0
    && report.played.some((p) => p.ms > 300);
  return report;
}

main()
  .then((report) => {
    console.log('READ_ALOUD_CHECK ' + JSON.stringify(report));
    process.exit(report.ok ? 0 : 1);
  })
  .catch((err) => {
    console.log('READ_ALOUD_CHECK ' + JSON.stringify({ ok: false, error: err.message, out: OUT }));
    process.exit(1);
  });
