'use strict';

// Короткий «дзинь» после успешной команды окон. В главном процессе Electron нет Web Audio,
// поэтому тон 880 Гц (0,18 с, с затуханием) пишется в WAV и играется системным SoundPlayer.
// Без сети; процесс PowerShell отдельный, ответ инструмента не ждёт.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RATE = 22050;
const SECONDS = 0.18;
const FREQ = 880;

// WAV 16 бит моно; volume 0..1 масштабирует громкость.
function makeWav(volume) {
  const n = Math.floor(RATE * SECONDS);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.exp(-5 * i / n) * Math.min(1, i / 100); // затухание и мягкий старт без щелчка
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * FREQ * i / RATE) * env * volume * 0.5 * 32767), 44 + i * 2);
  }
  return buf;
}

// Возвращает true, если проигрывание запущено. Любая ошибка — молча false.
function playBeep({ volume = 1, quiet = false, platform = process.platform, run = spawn, dir = os.tmpdir() } = {}) {
  try {
    if (platform !== 'win32' || quiet || !(volume > 0)) return false;
    const file = path.join(dir, `nox-beep-${Math.round(Math.min(volume, 1) * 100)}.wav`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, makeWav(Math.min(volume, 1)));
    const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    if (child.unref) child.unref();
    return true;
  } catch { return false; }
}

module.exports = { playBeep, makeWav };
