'use strict';

// Фоновые задачи (missions): один JSON-файл вида {"items": [...]}.
// Каждая операция читает файл заново, поэтому несколько экземпляров на одном файле видят друг друга.
// Повреждённый файл не перезаписываем; запись атомарная (временный файл рядом, затем переименование).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_GOAL = 500;
const MAX_RESULT = 2000;
const MIN_MINUTES = 5;
const MAX_MINUTES = 10080;
const MINUTE_MS = 60 * 1000;
// Daily-задача, просроченная дольше этого срока (компьютер был выключен), не запускается.
const STALE_DAILY_MS = 12 * 60 * MINUTE_MS;
const MAX_EXPECT = 5;
const MAX_STEPS_LIMIT = 60;
const MAX_MINUTES_LIMIT = 240;
// ЧЧ:ММ по локальным часам машины, от 00:00 до 23:59.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMs(value) {
  return new Date(value).getTime();
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function byNextRun(a, b) {
  return toMs(a.nextRunAt) - toMs(b.nextRunAt);
}

// Обрезка по кодовым точкам, чтобы пара-суррогат (эмодзи) не рвалась.
function truncate(text, max) {
  return Array.from(text).slice(0, max).join('');
}

function parseHhmm(value) {
  const m = typeof value === 'string' ? HHMM.exec(value) : null;
  if (!m) {
    throw new Error(`время: нужен формат ЧЧ:ММ от 00:00 до 23:59, получено ${JSON.stringify(value)}`);
  }
  return { hours: Number(m[1]), minutes: Number(m[2]) };
}

function normalizeGoal(goal) {
  if (typeof goal !== 'string') throw new Error('задача: нужна строка');
  const clean = goal.trim();
  if (!clean) throw new Error('задача: пустая строка');
  if (Array.from(clean).length > MAX_GOAL) throw new Error(`задача длиннее ${MAX_GOAL} символов`);
  return clean;
}

// Проверяет график и возвращает его копию только с известными полями.
function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new Error('график: нужен объект {type, ...}');
  if (schedule.type === 'interval') {
    const { minutes } = schedule;
    if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
      throw new Error(`минуты: целое от ${MIN_MINUTES} до ${MAX_MINUTES}`);
    }
    return { type: 'interval', minutes };
  }
  if (schedule.type === 'daily') {
    parseHhmm(schedule.at);
    return { type: 'daily', at: schedule.at };
  }
  throw new Error(`график: допустимо interval или daily, получено ${JSON.stringify(schedule.type)}`);
}

// Ближайший момент после nowMs, в который наступает запуск (миллисекунды).
// interval: now + minutes. daily: ближайший локальный HH:MM строго позже now (сегодня или завтра).
function nextRunMs(schedule, nowMs) {
  if (schedule.type === 'interval') return nowMs + schedule.minutes * MINUTE_MS;
  const { hours, minutes } = parseHhmm(schedule.at);
  const candidate = new Date(nowMs);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate.getTime() <= nowMs) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hours, minutes, 0, 0);
  }
  return candidate.getTime();
}

// Что должно быть правдой после задачи: файл, окно или процесс есть (или их нет). Проверяет код чтением.
function normalizeExpect(expect) {
  if (expect === undefined || expect === null) return [];
  if (!Array.isArray(expect) || expect.length > MAX_EXPECT) throw new Error(`ожидаемый результат: список до ${MAX_EXPECT} условий`);
  return expect.map((item) => {
    const kind = item && item.kind;
    const target = item && typeof item.target === 'string' ? item.target.trim() : '';
    if (!['file', 'window', 'process'].includes(kind)) throw new Error('ожидаемый результат: kind — file, window или process');
    if (!target || target.length > 260) throw new Error('ожидаемый результат: target от 1 до 260 символов');
    return { kind, target, ...(item.until === 'gone' ? { until: 'gone' } : {}) };
  });
}

function normalizeLimits(limits) {
  if (limits === undefined || limits === null) return null;
  const out = {};
  for (const [key, max] of [['maxSteps', MAX_STEPS_LIMIT], ['maxMinutes', MAX_MINUTES_LIMIT]]) {
    const value = limits[key];
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${key}: целое от 1 до ${max}`);
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

class MissionStore {
  constructor(filePath) {
    if (!filePath) throw new Error('MissionStore: нужен путь к файлу');
    this.filePath = filePath;
  }

  // Добавляет задачу. Ошибка валидации бросается до записи, файл при этом не меняется.
  add({ goal, schedule, expect, limits, workspaceId } = {}, now = new Date()) {
    const text = normalizeGoal(goal);
    const sched = normalizeSchedule(schedule);
    const expected = normalizeExpect(expect);
    const bounds = normalizeLimits(limits);
    const nowMs = toMs(now);
    if (Number.isNaN(nowMs)) throw new Error('add: плохое время now');
    if (workspaceId !== undefined && (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 100)) throw new Error('workspaceId: неверный код пространства');
    const record = {
      id: crypto.randomUUID(),
      goal: text,
      schedule: sched,
      enabled: true,
      createdAt: toIso(nowMs),
      nextRunAt: toIso(nextRunMs(sched, nowMs)),
      lastRunAt: null,
      runs: 0,
      lastResult: null,
      status: 'idle',
      ...(workspaceId && workspaceId !== 'default' ? { workspaceId } : {}),
      ...(expected.length ? { expect: expected } : {}),
      ...(bounds ? { limits: bounds } : {}),
    };
    const data = this._load();
    data.items.push(record);
    this._save(data);
    return record;
  }

  // Все задачи (включая отключённые) по возрастанию nextRunAt.
  list() {
    return this._load().items.sort(byNextRun);
  }

  get(id) {
    return this._load().items.find((item) => item.id === id) ?? null;
  }

  // true, если задача была и удалена; false, если такого id нет.
  cancel(id) {
    const data = this._load();
    const kept = data.items.filter((item) => item.id !== id);
    if (kept.length === data.items.length) return false;
    this._save({ ...data, items: kept });
    return true;
  }

  // Пропуск устаревших daily-задач: срок сдвигается на следующий раз, запуска не будет, новых прав задача не получает.
  // Вызывает планировщик перед due(); сам due() остаётся чтением. Интервальные задачи не трогаем.
  skipStale(now = new Date()) {
    const nowMs = toMs(now);
    if (Number.isNaN(nowMs)) throw new Error('skipStale: плохое время now');
    const data = this._load();
    let changed = false;
    for (const item of data.items) {
      if (!item.enabled || item.schedule.type !== 'daily') continue;
      if (nowMs - toMs(item.nextRunAt) <= STALE_DAILY_MS) continue;
      item.nextRunAt = toIso(nextRunMs(item.schedule, nowMs));
      item.lastResult = 'пропущено: компьютер был выключен';
      item.lastVerdict = 'skipped';
      changed = true;
    }
    if (changed) this._save(data);
    return changed;
  }

  // Включённые задачи, время которых наступило (nextRunAt <= now).
  due(now = new Date()) {
    const nowMs = toMs(now);
    return this._load().items
      .filter((item) => item.enabled && toMs(item.nextRunAt) <= nowMs)
      .sort(byNextRun);
  }

  // Фиксирует запуск: lastRunAt = now, runs + 1, lastResult (обрезан до 2000 символов),
  // nextRunAt пересчитан от now. Возвращает задачу или null, если id нет.
  markRun(id, { now = new Date(), result, verdict } = {}) {
    const nowMs = toMs(now);
    if (Number.isNaN(nowMs)) throw new Error('markRun: плохое время now');
    const data = this._load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item) return null;
    item.lastRunAt = toIso(nowMs);
    item.runs += 1;
    item.lastResult = result === undefined || result === null ? null : truncate(String(result), MAX_RESULT);
    item.nextRunAt = toIso(nextRunMs(item.schedule, nowMs));
    item.status = 'idle';
    item.lastVerdict = verdict || null;
    delete item.runStartedAt;
    this._save(data);
    return item;
  }

  // Отметка на диске до первого действия. Срок запуска сдвигается сразу: падение посреди задачи не повторит её вслепую.
  markStart(id, { now = new Date() } = {}) {
    const nowMs = toMs(now);
    if (Number.isNaN(nowMs)) throw new Error('markStart: плохое время now');
    const data = this._load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item) return null;
    item.status = 'running';
    item.runStartedAt = toIso(nowMs);
    item.nextRunAt = toIso(nextRunMs(item.schedule, nowMs));
    this._save(data);
    return item;
  }

  // Задачи, которые начались и не закончились: приложение упало или выключилось посреди работы.
  interrupted() {
    return this._load().items.filter((item) => item.status === 'running');
  }

  // Прерванная задача: запись итога, запуск по расписанию остаётся уже сдвинутым.
  closeInterrupted(id, { now = new Date(), result, verdict } = {}) {
    const data = this._load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item) return null;
    item.status = 'idle';
    item.lastRunAt = toIso(toMs(now));
    item.runs += 1;
    item.lastVerdict = verdict;
    item.lastResult = truncate(String(result), MAX_RESULT);
    delete item.runStartedAt;
    this._save(data);
    return item;
  }

  // true, если задача найдена; false, если такого id нет.
  setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('enabled: нужно true или false');
    const data = this._load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item) return false;
    item.enabled = enabled;
    this._save(data);
    return true;
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { items: [] };
      throw err;
    }
    if (raw.trim() === '') return { items: [] };
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (!data || !Array.isArray(data.items)) {
      // Повреждённый файл не перезаписываем: иначе задачи молча пропадут.
      throw new Error(`файл задач повреждён: ${this.filePath}`);
    }
    return data;
  }

  // Атомарная запись: во временный файл рядом, затем переименование поверх основного.
  _save(data) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Важна исходная ошибка записи, а не неудача уборки временного файла.
      }
      throw err;
    }
  }
}

module.exports = { MissionStore, MAX_GOAL, MAX_RESULT };
