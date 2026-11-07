'use strict';

// Показ экрана в Telegram «живой картинкой»: одно сообщение, которое обновляется на месте.
// Никакого потока новых видео: кадр меняется в том же сообщении, как трансляция в окне.
// Захват через ffmpeg (gdigrab): дешёвый JPEG-кадр, сравнение по хешу, пропуск пустых кадров.

const { spawn } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

function runCapture(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* уже умер */ }
      finish(-1);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); if (err.length > 8000) err = err.slice(-8000); });
    child.on('error', (e) => { err += e.message; clearTimeout(timer); finish(-1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code); });
  });
}

class ScreenStreamer {
  constructor({ ffmpeg = 'ffmpeg', tmpDir, log = () => {}, onLive = null } = {}) {
    this.ffmpeg = ffmpeg;
    this.tmpDir = tmpDir;
    this.log = log;
    this.onLive = onLive; // async (jpegBuffer, meta) => void
    this.running = false;
    this.intervalMs = 1500;
    this.idleResendMs = 12000;
    this.width = 1280;
    this.quality = 6;
    this.lastHash = null;
    this.lastSentAt = 0;
  }

  // Один кадр рабочего стола в JPEG — дешёвый путь для живой картинки.
  async frameJpeg({ width = this.width, quality = this.quality } = {}) {
    const res = await runCapture(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab', '-framerate', '1', '-i', 'desktop',
      '-frames:v', '1', '-vf', `scale=${width}:-2`,
      '-q:v', String(quality),
      '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], { timeoutMs: 15000 });
    if (!res.stdout || !res.stdout.length) {
      throw new Error(`кадр не получен (ffmpeg ${res.code}): ${res.stderr.slice(-300)}`);
    }
    return res.stdout;
  }

  // Кадр в PNG — для одиночного снимка /shot (чётче).
  async shot({ width = 1600 } = {}) {
    const res = await runCapture(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab', '-framerate', '1', '-i', 'desktop',
      '-frames:v', '1', '-vf', `scale=${width}:-2`,
      '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ], { timeoutMs: 20000 });
    if (!res.stdout || !res.stdout.length) {
      throw new Error(`снимок не получен (ffmpeg ${res.code}): ${res.stderr.slice(-300)}`);
    }
    return res.stdout;
  }

  start({ intervalMs = 1500, idleResendMs = 12000, width = 1280, quality = 6 } = {}) {
    this.stop();
    this.running = true;
    this.intervalMs = Math.min(Math.max(Number(intervalMs) || 1500, 1000), 10000);
    this.idleResendMs = Math.max(Number(idleResendMs) || 12000, 3000);
    this.width = Math.min(Math.max(Number(width) || 1280, 640), 1920);
    this.quality = Math.min(Math.max(Number(quality) || 6, 2), 20);
    this.lastHash = null;
    this.lastSentAt = 0;
    this._loop();
  }

  stop() {
    this.running = false;
  }

  async _tick() {
    const frame = await this.frameJpeg();
    const hash = createHash('md5').update(frame).digest('hex');
    const now = Date.now();
    const changed = hash !== this.lastHash;
    const due = now - this.lastSentAt >= this.idleResendMs;
    if (!changed && !due) return;
    if (this.onLive) {
      await this.onLive(frame, { changed, caption: '' });
      this.lastHash = hash;
      this.lastSentAt = Date.now();
    }
  }

  async _loop() {
    let failures = 0;
    while (this.running) {
      try {
        await this._tick();
        failures = 0;
      } catch (err) {
        if (!this.running) break;
        failures += 1;
        this.log(`экран: ${err.message}`);
        if (failures >= 5) {
          this.running = false;
          break;
        }
      }
      if (!this.running) break;
      await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
    }
  }
}

module.exports = { ScreenStreamer };
