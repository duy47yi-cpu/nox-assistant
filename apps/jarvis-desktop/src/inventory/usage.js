'use strict';

// Чем пользуется владелец: какие программы он запускает и видит запущенными, какой музыкальный сервис выбирает.
// Данные только локальные (data/app-usage.json). Наблюдение без вопросов; снимок запущенных программ
// делается один раз после первого скана или когда Джарвис сам решит, что нужно (не чаще раза в сутки).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const SNAPSHOT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MUSIC_SERVICES = ['youtube', 'yandex', 'spotify'];

// Список процессов фиксированный: пользовательский текст в него не подставляется.
const PROCESS_SCRIPT = 'Get-Process | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique | Set-Content -LiteralPath $env:JARVIS_INV_OUT -Encoding UTF8';

class AppUsage {
  constructor(file) {
    this.file = file;
    this.apps = {}; // имя программы -> {launches, seenRunning, last}
    this.services = {}; // сервис -> сколько раз открывали музыку
    this.lastSnapshot = null;
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.apps = data.apps && typeof data.apps === 'object' ? data.apps : {};
      this.services = data.services && typeof data.services === 'object' ? data.services : {};
      this.lastSnapshot = typeof data.lastSnapshot === 'string' ? data.lastSnapshot : null;
    } catch {
      // файла ещё нет или он битый: начинаем с пустого
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body = { apps: this.apps, services: this.services, lastSnapshot: this.lastSnapshot };
    fs.writeFileSync(this.file, JSON.stringify(body, null, 2), 'utf8');
  }

  _app(name) {
    if (!this.apps[name]) this.apps[name] = { launches: 0, seenRunning: 0, last: null };
    return this.apps[name];
  }

  recordLaunch(name) {
    const entry = this._app(name);
    entry.launches += 1;
    entry.last = new Date().toISOString();
    this.save();
  }

  recordService(service) {
    if (!MUSIC_SERVICES.includes(service)) return;
    this.services[service] = (this.services[service] || 0) + 1;
    this.save();
  }

  // Сколько раз пользователь открывал музыку в каждом сервисе — выбираем самый частый, без вопроса.
  topService(allowed = MUSIC_SERVICES) {
    const ranked = allowed
      .filter((s) => this.services[s] > 0)
      .sort((a, b) => this.services[b] - this.services[a]);
    return ranked[0] || null;
  }

  // Снимок запущенных процессов: совпадения с установленными программами записываем. runPS — как в apps.js.
  async snapshot(inventory, runPS, { now = Date.now(), force = false } = {}) {
    if (!force && this.lastSnapshot && now - Date.parse(this.lastSnapshot) < SNAPSHOT_MIN_INTERVAL_MS) {
      return { ok: false, skipped: true, summary: 'снимок делали меньше суток назад' };
    }
    const out = path.join(os.tmpdir(), `jarvis-proc-${randomUUID()}.txt`);
    const res = await runPS(PROCESS_SCRIPT, { JARVIS_INV_OUT: out }, { timeoutMs: 30000 });
    try {
      if (!res.ok) return { ok: false, summary: res.summary || 'не получилось прочитать процессы' };
      const running = new Set(fs.readFileSync(out, 'utf8').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean));
      const seen = [];
      for (const entry of inventory.entries) {
        if (!entry.path || !/\.exe$/i.test(entry.path)) continue;
        const exe = path.basename(entry.path, path.extname(entry.path)).toLowerCase();
        if (!running.has(exe)) continue;
        this._app(entry.name).seenRunning += 1;
        seen.push(entry.name);
      }
      this.lastSnapshot = new Date(now).toISOString();
      this.save();
      return { ok: true, summary: seen.length ? `запущены: ${[...new Set(seen)].join(', ')}` : 'из списка сейчас ничего не запущено', seen: [...new Set(seen)] };
    } catch (err) {
      return { ok: false, summary: err.message };
    } finally {
      fs.rmSync(out, { force: true });
    }
  }

  // Самые используемые программы (запуски и запущенные в снимках) для системного промпта.
  topApps(n = 6) {
    return Object.entries(this.apps)
      .map(([name, e]) => ({ name, score: (e.launches || 0) + (e.seenRunning || 0) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((e) => e.name);
  }

  clear() {
    this.apps = {};
    this.services = {};
    this.lastSnapshot = null;
    fs.rmSync(this.file, { force: true });
  }
}

module.exports = { AppUsage, PROCESS_SCRIPT, SNAPSHOT_MIN_INTERVAL_MS };
