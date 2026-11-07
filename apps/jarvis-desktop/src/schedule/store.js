'use strict';

// Напоминания: один JSON-файл вида {"items": [...]}.
// Каждая операция читает файл заново, поэтому несколько экземпляров на одном файле видят друг друга.
// Ввод-вывод синхронный: внутри процесса цикл чтение-изменение-запись не перемешивается.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TEXT = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
const REPEATS = [null, 'daily'];
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

class ReminderStore {
  constructor(filePath) {
    if (!filePath) throw new Error('ReminderStore: нужен путь к файлу');
    this.filePath = filePath;
  }

  // Добавляет напоминание. dueAt: строка ISO 8601 или Date; в файл пишется как ISO (UTC).
  // Любая ошибка валидации бросается до записи, файл при этом не меняется.
  add({ text, dueAt, repeat, workspaceId = 'default' } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('пустой текст');
    if (typeof dueAt !== 'string' && !(dueAt instanceof Date)) {
      throw new Error('дата: нужна строка ISO 8601');
    }
    const dueMs = toMs(dueAt);
    if (Number.isNaN(dueMs)) throw new Error(`плохая дата: ${String(dueAt)}`);
    const rep = repeat === undefined ? null : repeat;
    if (!REPEATS.includes(rep)) {
      throw new Error(`repeat: допустимо null или 'daily', получено ${JSON.stringify(rep)}`);
    }
    const space = normalizeWorkspaceId(workspaceId);
    const record = {
      id: crypto.randomUUID(),
      // Array.from режет по кодовым точкам, поэтому пара-суррогат (эмодзи) не рвётся.
      text: Array.from(clean).slice(0, MAX_TEXT).join(''),
      dueAt: toIso(dueMs),
      repeat: rep,
      done: false,
      createdAt: new Date().toISOString(),
      firedAt: null,
      ...(space !== 'default' ? { workspaceId: space } : {}),
    };
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

  // Правка напоминания: text, dueAt, repeat. id, createdAt и пространство не меняются.
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
    if ('repeat' in patch) {
      const rep = patch.repeat === undefined ? null : patch.repeat;
      if (!REPEATS.includes(rep)) {
        throw new Error(`repeat: допустимо null или 'daily', получено ${JSON.stringify(rep)}`);
      }
      item.repeat = rep;
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

  // Ежедневное: dueAt сдвигается на сутки от прежнего и дальше, пока не станет позже now.
  // Разовое: помечается выполненным. firedAt = now. Возвращает запись или null, если id нет.
  markFired(id, now = new Date()) {
    const data = this._load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item) return null;
    const nowMs = toMs(now);
    if (item.repeat === 'daily') {
      let next = toMs(item.dueAt) + DAY_MS;
      if (next <= nowMs) {
        // Пропущенные сутки перешагиваем сразу, без цикла по каждому дню.
        next += (Math.floor((nowMs - next) / DAY_MS) + 1) * DAY_MS;
      }
      item.dueAt = toIso(next);
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

module.exports = { ReminderStore, MAX_TEXT };
