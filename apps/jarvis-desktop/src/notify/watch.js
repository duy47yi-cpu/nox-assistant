'use strict';

// Джарвис сам сообщает о поводах, не дожидаясь вопроса: новые файлы в папке inbox, задача не выполнена или зависла,
// фоновая задача не справилась или зависла, подошёл срок напоминания, дневной расход близок к лимиту.
// tick(now) собирает поводы из переданных источников и отправляет их по каналам (окно, Telegram).
// Таймер отдельно: start() и stop(). Логика проверяется без таймера: tick получает время и состояние.
//
// Правило тишины:
// - каждый канал выключается своей настройкой: watchWindow, watchTelegram (по умолчанию включены);
// - ночью (с 23:00 до 08:00 по локальным часам) Telegram молчит, окно — нет; очередь Telegram уходит утром;
// - не чаще watchPerHour сообщений в час на канал (по умолчанию 6); сверх лимита поводы ждут в очереди;
// - однотипные поводы в очереди сводятся в одно сообщение;
// - первый проход только запоминает уже существующее (старые провалы и файлы не объявляются при запуске).

const fs = require('fs');

const DEFAULT_PER_HOUR = 6;
const QUIET_FROM = 23;
const QUIET_TO = 8;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RUN_LIMIT_MIN = 240; // фоновая задача без своего лимита времени считается зависшей через 4 часа
const RUN_GRACE_MIN = 15;
const TASK_STUCK_MS = HOUR_MS; // задача без движения дольше часа
const SEEN_TTL_MS = 2 * 24 * HOUR_MS;
const COST_WARN = 0.8; // доля дневного лимита, с которой предупреждаем
const CHANNELS = ['window', 'telegram'];
const SHOW_MAX = 5; // сколько деталей перечислять в одном сообщении
const CLIP = 160;

const TITLES = {
  inbox: 'Новые файлы в inbox',
  'task-failed': 'Задача не выполнена',
  'task-stuck': 'Задача зависла',
  'mission-failed': 'Фоновая задача не справилась',
  'mission-stuck': 'Фоновая задача зависла',
  reminder: 'Напоминание',
  cost: 'Расход за день',
  'app-hung': 'Программа не отвечает',
};

function clip(text) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return chars.length > CLIP ? `${chars.slice(0, CLIP).join('')}…` : chars.join('');
}

// Имена обычных файлов в папке. Скрытые и временные пропускаются. Папки нет — пусто.
function listInboxFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.endsWith('.tmp'))
    .map((e) => e.name);
}

// Ночная тишина по локальным часам машины: 23:00–07:59.
function isNight(now) {
  const h = now.getHours();
  return h >= QUIET_FROM || h < QUIET_TO;
}

function dayKey(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Настройки из settings.json. Неверное число в watchPerHour — значение по умолчанию.
function readConfig(raw = {}) {
  const perHour = Number.isInteger(raw.watchPerHour) && raw.watchPerHour >= 1 ? raw.watchPerHour : DEFAULT_PER_HOUR;
  return { perHour, enabled: { window: raw.watchWindow !== false, telegram: raw.watchTelegram !== false } };
}

// Однотипные поводы в один блок, по порядку первого появления.
function groupByKind(list) {
  const groups = new Map();
  for (const item of list) {
    if (!groups.has(item.kind)) groups.set(item.kind, []);
    groups.get(item.kind).push(item);
  }
  return [...groups.values()];
}

// Текст одного сообщения: один повод — как есть; несколько — заголовок с числом и перечень.
function mergeText(items) {
  const title = TITLES[items[0].kind];
  if (items.length === 1) return `${title}: ${items[0].detail}`;
  const shown = items.slice(0, SHOW_MAX).map((i) => i.detail);
  const rest = items.length - shown.length;
  return `${title} (${items.length}): ${shown.join('; ')}${rest > 0 ? `; и ещё ${rest}` : ''}`;
}

class WatchNotifier {
  // settings() — объект настроек; sources — функции чтения: inbox (имена файлов), tasks, missions (списки),
  // cost ({spentUsd, limitUsd} или null); channels — {window, telegram}: {available(): bool, send(text): Promise}.
  constructor({ now = () => new Date(), settings = () => ({}), sources = {}, channels = {}, log = () => {}, intervalMs = 60000 } = {}) {
    this.now = now;
    this.settings = settings;
    this.sources = { inbox: () => [], tasks: () => [], missions: () => [], apps: () => [], cost: () => null, ...sources };
    this.channels = channels;
    this.log = log;
    this.intervalMs = intervalMs;
    this._timer = null;
    this._busy = false;
    this._primed = false;
    this._inbox = null; // имена файлов, виденные в прошлый раз; null — ещё не смотрели
    this._seen = new Map(); // ключ повода -> время, когда он впервые увиден
    this._incoming = []; // поводы извне (напоминания, которые уже показал планировщик)
    this._queue = { window: [], telegram: [] };
    this._sent = { window: [], telegram: [] }; // времена отправок (мс) за последний час
  }

  // Повод извне. Попадает в ближайший проход; повтор с тем же key не выводится.
  add({ kind, key, detail, channels = CHANNELS }) {
    this._incoming.push({ kind, key, detail: clip(detail), channels });
  }

  // Один проход: собрать поводы, поставить в очередь каналов, отправить с учётом тишины и лимита.
  // Возвращает число отправленных сообщений.
  async tick(now = this.now()) {
    if (this._busy) return 0;
    this._busy = true;
    try {
      const { found: scanned, active } = await this._scan(now);
      const incoming = this._incoming.splice(0).filter((c) => this._markSeen(c, now));
      const cfg = readConfig(this.settings());
      // Первый проход только запоминает уже существующее: при запуске старые поводы не объявляются.
      const fresh = this._primed ? [...scanned, ...incoming] : incoming;
      this._primed = true;
      for (const c of fresh) {
        for (const ch of c.channels) if (this._open(ch, cfg)) this._queue[ch].push(c);
      }
      const sent = await this._deliver(now, cfg);
      this._prune(now, active);
      return sent;
    } finally {
      this._busy = false;
    }
  }

  // Канал открыт, если его включили в настройках и он доступен (Telegram — только когда мост запущен).
  _open(ch, cfg) {
    const channel = this.channels[ch];
    return Boolean(cfg.enabled[ch] && channel && channel.available());
  }

  async _deliver(now, cfg) {
    let sent = 0;
    const ts = now.getTime();
    for (const ch of CHANNELS) {
      if (!this._open(ch, cfg)) {
        this._queue[ch] = [];
        continue;
      }
      if (ch === 'telegram' && isNight(now)) continue; // ночью Telegram молчит, очередь ждёт утра
      this._sent[ch] = this._sent[ch].filter((t) => ts - t < HOUR_MS);
      for (const group of groupByKind(this._queue[ch])) {
        if (this._sent[ch].length >= cfg.perHour) break;
        try {
          await this.channels[ch].send(mergeText(group));
        } catch (err) {
          this.log(`${ch}: ${err && err.message ? err.message : err}`);
          break; // неудачу не повторяем в этом проходе: следующий проход попробует снова
        }
        this._sent[ch].push(ts);
        this._queue[ch] = this._queue[ch].filter((c) => !group.includes(c));
        sent += 1;
      }
    }
    return sent;
  }

  _markSeen(c, now) {
    if (this._seen.has(c.key)) return false;
    this._seen.set(c.key, now.getTime());
    return true;
  }

  // Чтение источника: ошибка одного источника не должна останавливать остальные.
  // Источник может быть асинхронным (опрос зависших программ идёт через PowerShell):
  // результат всегда дожидаемся, иначе Promise попадёт в for..of и проход упадёт.
  async _readSource(name, fn) {
    try {
      return await fn();
    } catch (err) {
      this.log(`${name}: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  // Поводы из папок и хранилищ, которые отметились с прошлого прохода.
  async _scan(now) {
    const out = [];
    const active = new Set(); // ключи поводов, которые есть сейчас (новые и уже известные)
    const take = (c) => {
      active.add(c.key);
      if (this._markSeen(c, now)) out.push(c);
    };
    const t = now.getTime();

    const files = await this._readSource('inbox', this.sources.inbox);
    if (files) {
      for (const name of files) active.add(`inbox:${name}`);
      if (this._inbox) {
        for (const name of files) {
          if (!this._inbox.has(name)) take({ kind: 'inbox', key: `inbox:${name}`, detail: clip(name), channels: CHANNELS });
        }
      }
      this._inbox = new Set(files);
    }

    for (const task of (await this._readSource('tasks', this.sources.tasks)) || []) {
      const label = `«${task.title || task.id}»`;
      if (task.status === 'blocked') {
        const why = task.reason ? ` — ${task.reason}` : '';
        take({ kind: 'task-failed', key: `task-failed:${task.id}:${task.updatedAt}`, detail: `${label}${why}`, channels: CHANNELS });
      } else if (task.status === 'running') {
        const at = Date.parse(task.updatedAt);
        if (Number.isFinite(at) && t - at > TASK_STUCK_MS) {
          take({ kind: 'task-stuck', key: `task-stuck:${task.id}:${task.updatedAt}`, detail: `${label}, нет движения больше часа`, channels: CHANNELS });
        }
      }
    }

    for (const app of (await this._readSource('apps', this.sources.apps)) || []) {
      if (app && app.hung === true && Number.isInteger(app.pid)) {
        take({ kind: 'app-hung', key: `app-hung:${app.pid}`, detail: `${clip(app.name || 'Программа')} не отвечает`, channels: CHANNELS });
      }
    }

    for (const m of (await this._readSource('missions', this.sources.missions)) || []) {
      const label = `«${m.goal || m.id}»`;
      if (m.lastVerdict === 'failed' && m.lastRunAt) {
        const why = m.lastResult ? ` — ${m.lastResult}` : '';
        take({ kind: 'mission-failed', key: `mission-failed:${m.id}:${m.lastRunAt}`, detail: `${label}${why}`, channels: CHANNELS });
      }
      const started = Date.parse(m.runStartedAt);
      const limitMin = (m.limits && m.limits.maxMinutes) || DEFAULT_RUN_LIMIT_MIN;
      if (m.status === 'running' && Number.isFinite(started) && t - started > (limitMin + RUN_GRACE_MIN) * 60000) {
        take({ kind: 'mission-stuck', key: `mission-stuck:${m.id}:${m.runStartedAt}`, detail: `${label}, идёт дольше своего лимита`, channels: CHANNELS });
      }
    }

    const cost = await this._readSource('cost', this.sources.cost);
    if (cost && cost.limitUsd > 0) {
      const ratio = cost.spentUsd / cost.limitUsd;
      const level = ratio >= 1 ? 100 : ratio >= COST_WARN ? 80 : 0;
      if (level) {
        const detail = `потрачено $${cost.spentUsd.toFixed(2)} из $${cost.limitUsd.toFixed(2)} (${Math.floor(ratio * 100)}%)`;
        take({ kind: 'cost', key: `cost:${dayKey(now)}:${level}`, detail, channels: CHANNELS });
      }
    }
    return { found: out, active };
  }

  // Поводы из папок и хранилищ помнятся, пока они есть в очереди состояния: исчезли — забываем, и при появлении снова объявим.
  // Напоминания (извне) помнятся сутки-двое, им этого хватает.
  _prune(now, active) {
    for (const [key, at] of this._seen) {
      const fromScan = !key.startsWith('reminder:');
      const expired = fromScan ? !active.has(key) : now.getTime() - at > SEEN_TTL_MS;
      if (expired) this._seen.delete(key);
    }
  }

  // Проход по таймеру раз в intervalMs. Повторный start ничего не делает. Таймер не держит процесс.
  start() {
    if (this._timer) return;
    this._background();
    this._timer = setInterval(() => this._background(), this.intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _background() {
    this.tick().catch((err) => {
      this.log(`уведомления: ${err && err.message ? err.message : err}`);
    });
  }
}

module.exports = { WatchNotifier, listInboxFiles, isNight, readConfig, mergeText, DEFAULT_PER_HOUR };
