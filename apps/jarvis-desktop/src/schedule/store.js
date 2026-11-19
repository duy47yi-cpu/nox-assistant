'use strict';

// Напоминания: один JSON-файл вида {"items": [...]}.
// Каждая операция читает файл заново, поэтому несколько экземпляров на одном файле видят друг друга.
// Ввод-вывод синхронный: внутри процесса цикл чтение-изменение-запись не перемешивается.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TEXT = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_REPEATS = Object.freeze(['weekdays', 'weekly', 'monthly']);
const REPEATS = [null, 'daily', ...CALENDAR_REPEATS];
const WORKSPACE_ID = /^(default|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function normalizeWorkspaceId(value = 'default') {
  if (typeof value !== 'string' || !WORKSPACE_ID.test(value)) throw new Error('workspaceId: неверное пространство');
  return value;
}

// Миллисекунды из строки ISO, Date или числа; NaN, если значение не дата.
function toMs(value) {
  if (value === undefined || value === null) return NaN;
  return new Date(value).getTime();
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function byDueAt(a, b) {
  return toMs(a.dueAt) - toMs(b.dueAt);
}

function validateRepeat(repeat) {
  if (!REPEATS.includes(repeat)) throw new Error('repeat: допустимо null, daily, weekdays, weekly или monthly');
  return repeat;
}

function zonedFormatter(timeZone) {
  if (timeZone !== undefined && (typeof timeZone !== 'string' || !timeZone || /^[+-]/.test(timeZone))) {
    throw new Error('timeZone: нужен часовой пояс IANA, например Europe/Berlin');
  }
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', fractionalSecondDigits: 3,
    });
  } catch (err) {
    if (err instanceof RangeError) throw new Error('timeZone: неизвестный часовой пояс IANA');
    throw err;
  }
}

// Местное время представлено на шкале UTC только для календарных вычислений.
function wallTime(ms, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.fractionalSecond);
  return date.getTime();
}

function resolveWallTime(wall, formatter) {
  // Смещения по обе стороны перехода дают оба варианта в повторяющийся час.
  const candidates = [...new Set([wall - DAY_MS, wall, wall + DAY_MS].map((probe) =>
    wall - (wallTime(probe, formatter) - probe)))].sort((a, b) => a - b);
  const matches = candidates.filter((ms) => wallTime(ms, formatter) === wall);
  return {
    matches,
    // В пропущенный час сдвигаем одно срабатывание на величину перевода часов.
    shifted: matches.length ? matches[0] : candidates.find((ms) => wallTime(ms, formatter) > wall),
  };
}

function isWeekend(date) {
  return date.getUTCDay() === 0 || date.getUTCDay() === 6;
}

function nextCalendarDue(item, afterMs) {
  const formatter = zonedFormatter(item.timeZone);
  const anchor = new Date(item.repeatAnchor);
  const afterWall = wallTime(afterMs, formatter);
  const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
  const timeOfDay = anchor.getTime() - dayStart(anchor.getTime());
  const candidate = new Date(dayStart(afterWall) + timeOfDay);

  if (item.repeat === 'monthly') {
    // Каждый месяц берём исходное число, даже если предыдущий месяц был короче.
    candidate.setUTCDate(1);
    while (true) {
      const end = new Date(candidate);
      end.setUTCMonth(end.getUTCMonth() + 1, 0);
      const wall = candidate.getTime() + (Math.min(anchor.getUTCDate(), end.getUTCDate()) - 1) * DAY_MS;
      const next = resolveWallTime(wall, formatter).shifted;
      if (next > afterMs) return next;
      candidate.setUTCMonth(candidate.getUTCMonth() + 1);
    }
  }

  const step = item.repeat === 'weekly' ? 7 : 1;
  if (step === 7) {
    candidate.setUTCDate(candidate.getUTCDate() + (anchor.getUTCDay() - candidate.getUTCDay() + 7) % 7);
  }
  while (true) {
    if (step === 7 || !isWeekend(candidate)) {
      const next = resolveWallTime(candidate.getTime(), formatter).shifted;
      if (next > afterMs) return next;
    }
    candidate.setUTCDate(candidate.getUTCDate() + step);
  }
}

function setCalendarSchedule(item, timeZone) {
  const formatter = zonedFormatter(timeZone);
  item.timeZone = formatter.resolvedOptions().timeZone;
  const dueMs = toMs(item.dueAt);
  item.repeatAnchor = toIso(wallTime(dueMs, formatter));
  if (item.repeat === 'weekdays' && isWeekend(new Date(item.repeatAnchor))) {
    item.dueAt = toIso(nextCalendarDue(item, dueMs));
  }
}

function sameOccurrence(item, expected) {
  return item && !item.done && item.dueAt === expected.dueAt && item.firedAt === expected.firedAt &&
    item.repeat === expected.repeat && item.repeatAnchor === expected.repeatAnchor && item.timeZone === expected.timeZone;
}

class ReminderStore {
  constructor(filePath) {
    if (!filePath) throw new Error('ReminderStore: нужен путь к файлу');
    this.filePath = filePath;
  }

  // Добавляет напоминание. dueAt: строка ISO 8601 или Date; в файл пишется как ISO (UTC).
  // Любая ошибка валидации бросается до записи, файл при этом не меняется.
  add({ text, dueAt, repeat = null, timeZone, workspaceId = 'default', studyExam } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('пустой текст');
    if (typeof dueAt !== 'string' && !(dueAt instanceof Date)) {
      throw new Error('дата: нужна строка ISO 8601');
    }
    const dueMs = toMs(dueAt);
    if (Number.isNaN(dueMs)) throw new Error(`плохая дата: ${String(dueAt)}`);
    validateRepeat(repeat);
    const space = normalizeWorkspaceId(workspaceId);
    if (studyExam && (repeat || typeof studyExam.topic !== 'string' || !studyExam.topic.trim() ||
        studyExam.topic.length > 160 || !(Date.parse(studyExam.at) > dueMs))) {
      throw new Error('неверные данные учебной проверки');
    }
    const record = {
      id: crypto.randomUUID(),
      // Array.from режет по кодовым точкам, поэтому пара-суррогат (эмодзи) не рвётся.
      text: Array.from(clean).slice(0, MAX_TEXT).join(''),
      dueAt: toIso(dueMs),
      repeat,
      done: false,
      createdAt: new Date().toISOString(),
      firedAt: null,
      ...(space !== 'default' ? { workspaceId: space } : {}),
      ...(studyExam ? { studyExam: { topic: studyExam.topic, at: toIso(Date.parse(studyExam.at)) } } : {}),
    };
    if (CALENDAR_REPEATS.includes(repeat)) setCalendarSchedule(record, timeZone);
    const data = this._load();
    data.items.push(record);
    this._save(data);
    return record;
  }

  // Невыполненные напоминания по возрастанию dueAt; выполненные только при includeDone.
  list({ includeDone = false, workspaceId } = {}) {
    const space = workspaceId === undefined ? null : normalizeWorkspaceId(workspaceId);
    return this._load().items
      .filter((item) => (space === null || (item.workspaceId || 'default') === space) && (includeDone || !item.done))
      .sort(byDueAt);
  }

  get(id, { workspaceId } = {}) {
    const space = workspaceId === undefined ? null : normalizeWorkspaceId(workspaceId);
    return this._load().items.find((item) => item.id === id && (space === null || (item.workspaceId || 'default') === space)) ?? null;
  }

  // true, если запись была и удалена; false, если такого id нет.
  cancel(id, { workspaceId } = {}) {
    const data = this._load();
    const space = workspaceId === undefined ? null : normalizeWorkspaceId(workspaceId);
    const kept = data.items.filter((item) => item.id !== id || (space !== null && (item.workspaceId || 'default') !== space));
    if (kept.length === data.items.length) return false;
    this._save({ ...data, items: kept });
    return true;
  }

  // Правка напоминания: text, dueAt, repeat, timeZone. id, createdAt и пространство не меняются.
  // Если время изменили, напоминание снова ждёт срабатывания (done=false, firedAt=null):
  // иначе перенесённое разовое напоминание осталось бы выполненным и не пришло.
  // Возвращает запись или null, если такого id нет (или оно в другом пространстве).
  update(id, patch = {}, { workspaceId } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('правка: нужен объект полей');
    const space = workspaceId === undefined ? null : normalizeWorkspaceId(workspaceId);
    const data = this._load();
    const item = data.items.find((entry) => entry.id === id && (space === null || (entry.workspaceId || 'default') === space));
    if (!item) return null;
    let dueChanged = false;
    if ('text' in patch) {
      const clean = String(patch.text ?? '').trim();
      if (!clean) throw new Error('пустой текст');
      item.text = Array.from(clean).slice(0, MAX_TEXT).join('');
    }
    if ('dueAt' in patch) {
      if (typeof patch.dueAt !== 'string' && !(patch.dueAt instanceof Date)) {
        throw new Error('дата: нужна строка ISO 8601');
      }
      const dueMs = toMs(patch.dueAt);
      if (Number.isNaN(dueMs)) throw new Error(`плохая дата: ${String(patch.dueAt)}`);
      dueChanged = item.dueAt !== toIso(dueMs);
      item.dueAt = toIso(dueMs);
    }
    const previousRepeat = item.repeat;
    if ('repeat' in patch) item.repeat = validateRepeat(patch.repeat ?? null);
    if (CALENDAR_REPEATS.includes(item.repeat)) {
      if (dueChanged || item.repeat !== previousRepeat || (patch.timeZone !== undefined && patch.timeZone !== item.timeZone)) {
        setCalendarSchedule(item, patch.timeZone === undefined ? item.timeZone : patch.timeZone);
      }
    } else {
      delete item.repeatAnchor;
      delete item.timeZone;
    }
    if (dueChanged) {
      item.done = false;
      item.firedAt = null;
    }
    this._save(data);
    return item;
  }

  // Невыполненные напоминания, время которых наступило (dueAt <= now).
  due(now = new Date()) {
    const nowMs = toMs(now);
    return this._load().items
      .filter((item) => !item.done && toMs(item.dueAt) <= nowMs)
      .sort(byDueAt);
  }

  // Повтор переносится в будущее, разовое помечается выполненным.
  // expected защищает новый срок от завершения доставки старого.
  markFired(id, now = new Date(), expected) {
    const data = this._load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item || (expected && !sameOccurrence(item, expected))) return null;
    const nowMs = toMs(now);
    if (item.repeat === 'daily') {
      let next = toMs(item.dueAt) + DAY_MS;
      if (next <= nowMs) {
        // Пропущенные сутки перешагиваем сразу, без цикла по каждому дню.
        next += (Math.floor((nowMs - next) / DAY_MS) + 1) * DAY_MS;
      }
      item.dueAt = toIso(next);
    } else if (CALENDAR_REPEATS.includes(item.repeat)) {
      item.dueAt = toIso(nextCalendarDue(item, Math.max(toMs(item.dueAt), nowMs)));
    } else {
      item.done = true;
    }
    item.firedAt = toIso(nowMs);
    this._save(data);
    return item;
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
      // Повреждённый файл не перезаписываем: иначе напоминания молча пропадут.
      throw new Error(`файл напоминаний повреждён: ${this.filePath}`);
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

module.exports = { ReminderStore, MAX_TEXT, CALENDAR_REPEATS, zonedFormatter, wallTime, resolveWallTime, sameOccurrence };
