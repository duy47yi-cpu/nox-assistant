'use strict';

// Usage: node scripts/voice-bench.js <rev directory> <output directory>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { localGigaam } = require('../src/voice/stt');
const { voicePhrase } = require('../src/voice/input');

function normalized(text) {
  return (voicePhrase(text)?.command || '').toLowerCase().replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\b30\b/g, 'тридцать')
    .replace(/youtube/g, 'ютуб').replace(/dota 2/g, 'дота два')
    .replace(/(?:^| )пожалуйста(?= |$)/g, '').replace(/\s+/g, ' ').trim();
}

async function main() {
  const [rev, out] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-voice-bench-'));
  const from = path.join(rev, '_models', 'gigaam');
  const worker = localGigaam({ folder: () => from, script: path.join(__dirname, 'tts', 'gigaam-worker.py') });
  try {
    const source = fs.readFileSync(path.join(rev, 'COMMAND_PHRASES.md'), 'utf8').split('## 2.')[0];
    const phrases = [...source.matchAll(/^\| \*\*(.*?)\*\* \| (.*?) \|/gm)]
      .map(([, command, spoken]) => ({ command, spoken: spoken.split(' / ')[0] }));
    const items = [...new Map(phrases.map((row) => [row.spoken, row])).values()].slice(0, 30);
    fs.writeFileSync(path.join(temp, 'phrases.json'), JSON.stringify(items));
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$s.SelectVoice("Microsoft Irina Desktop")',
      '$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo (16000, 16, 1)',
      '$items = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $env:NOX_BENCH_TMP "phrases.json") | ConvertFrom-Json',
      'for ($i=0; $i -lt $items.Count; $i++) { $s.SetOutputToWaveFile((Join-Path $env:NOX_BENCH_TMP "$i.wav"), $format); $s.Speak($items[$i].spoken); $s.SetOutputToNull() }',
    ].join('; ')], { env: { ...process.env, NOX_BENCH_TMP: temp } });
    const start = performance.now();
    await worker.warmup();
    const warmup = Math.round(performance.now() - start);
    const result = [];
    for (const [index, item] of items.entries()) {
      const file = fs.readFileSync(path.join(temp, index + '.wav'));
      const data = file.indexOf('data', 12);
      const pcm = file.subarray(data + 8, data + 8 + file.readUInt32LE(data + 4));
      const begin = performance.now();
      const decoded = await worker.transcribe(pcm);
      result.push({ ...item, ...decoded, correct: normalized(item.spoken) === normalized(decoded.text),
        ms: Math.round(performance.now() - begin), seconds: Number((pcm.length / 32000).toFixed(2)),
        peakMiB: decoded.peakMiB });
    }
    const clip = path.join(rev, '_probe', 'v3s.wav');
    if (fs.existsSync(clip)) {
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
      const begin = performance.now();
      const decoded = await worker.transcribe(pcm);
      result.push({ spoken: 'Отрывок из ролика, начало обрезано', ...decoded, ms: Math.round(performance.now() - begin),
        seconds: Number((pcm.length / 32000).toFixed(2)), peakMiB: decoded.peakMiB });
    }
    fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify({ warmup, result }, null, 2));
  } finally {
    worker.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
