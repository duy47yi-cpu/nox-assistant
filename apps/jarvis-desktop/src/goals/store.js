'use strict';

// Цель на несколько ходов: название, шаги, доказательства. Это план, а не разрешение действовать:
// каждый шаг всё равно идёт через обычную политику инструментов. Файл goals.json в папке данных.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('../config/atomic');

const MAX_ACTIVE = 10;
const MAX_TITLE = 200;
const MAX_STEPS = 20;
const MAX_STEP_TEXT = 300;
const MAX_NOTE = 1000;
const MAX_EVIDENCE = 500;
const MAX_ITEMS = 200;

const STATUSES = new Set(['active', 'done', 'dropped']);
const STEP_STATUSES = new Set(['pending', 'done', 'failed', 'skipped']);

const text = (value, max, label, { required = true } = {}) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (required && !s) throw new Error(`${label}: пусто`);
  if (s.length > max) throw new Error(`${label}: не больше ${max} символов`);
  return s;
};

function normalizeSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) throw new Error('шаги: нужен хотя бы один');
  if (list.length > MAX_STEPS) throw new Error(`шаги: не больше ${MAX_STEPS}`);
  return list.map((item, i) => {
    const raw = typeof item === 'string' ? item : item && item.text;
    return { id: `s${i + 1}`, text: text(raw, MAX_STEP_TEXT, `шаг ${i + 1}`), status: 'pending', evidence: null, doneAt: null };
  });
}

class GoalStore {
  constructor(file, { now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || !Array.isArray(data.items)) return { items: [] };
      return data;
    } catch (err) {
      if (err.code === 'ENOENT') return { items: [] };
      throw new Error(`файл целей повреждён: ${this.file}`);
    }
  }

  _save(data) {
    data.items = data.items.slice(0, MAX_ITEMS);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(data, null, 2));
  }

  list({ status = null, limit = 20 } = {}) {
    let items = this._load().items;
    if (status) {
      if (!STATUSES.has(status)) throw new Error('статус: active, done или dropped');
      items = items.filter((x) => x.status === status);
    }
    return items.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  get(id) {
    return this._load().items.find((x) => x.id === String(id || '')) || null;
  }

  create({ title, steps, note = '' } = {}) {
    const cleanTitle = text(title, MAX_TITLE, 'название');
    const plan = normalizeSteps(steps);
    const cleanNote = text(note, MAX_NOTE, 'заметка', { required: false });
    const data = this._load();
    const active = data.items.filter((x) => x.status === 'active').length;
    if (active >= MAX_ACTIVE) throw new Error(`активных целей уже ${MAX_ACTIVE}: закрой лишние`);
    const at = this.now().toISOString();
    const item = {
      id: crypto.randomUUID(),
      title: cleanTitle,
      note: cleanNote,
      status: 'active',
      steps: plan,
      createdAt: at,
      updatedAt: at,
      endedAt: null,
      result: null,
    };
    data.items.unshift(item);
    this._save(data);
    return item;
  }

  _patch(id, fn) {
    const data = this._load();
    const item = data.items.find((x) => x.id === String(id || ''));
    if (!item) throw new Error(`цель не найдена: ${id}`);
    fn(item, data);
    item.updatedAt = this.now().toISOString();
    this._save(data);
    return item;
  }

  // Отметить шаг. done и failed требуют доказательства: без него это только обещание.
  step(id, { step, status, evidence = '' } = {}) {
    if (!STEP_STATUSES.has(status) || status === 'pending') throw new Error('шаг: статус done, failed или skipped');
    const index = Number(step);
    if (!Number.isInteger(index) || index < 1) throw new Error('шаг: номер с 1');
    const clean = text(evidence, MAX_EVIDENCE, 'доказательство', { required: status === 'done' || status === 'failed' });
    return this._patch(id, (item) => {
      if (item.status !== 'active') throw new Error('цель уже закрыта');
      const target = item.steps[index - 1];
      if (!target) throw new Error(`шага ${index} нет: всего ${item.steps.length}`);
      target.status = status;
      target.evidence = clean || null;
      target.doneAt = status === 'done' ? this.now().toISOString() : null;
    });
  }

  next(id) {
    const item = this.get(id);
    if (!item) throw new Error(`цель не найдена: ${id}`);
    const index = item.steps.findIndex((x) => x.status === 'pending');
    return { goal: item, index: index < 0 ? null : index + 1, step: index < 0 ? null : item.steps[index] };
  }

  // Закрыть цель. done — только когда все шаги done или skipped и есть итог.
  close(id, { status = 'done', evidence = '' } = {}) {
    if (status !== 'done' && status !== 'dropped') throw new Error('закрытие: done или dropped');
    const clean = text(evidence, MAX_EVIDENCE, 'итог', { required: true });
    return this._patch(id, (item) => {
      if (item.status !== 'active') throw new Error('цель уже закрыта');
      if (status === 'done') {
        const left = item.steps.filter((x) => x.status === 'pending' || x.status === 'failed');
        if (left.length) throw new Error(`осталось шагов: ${left.length}; сначала закрой их`);
      }
      item.status = status;
      item.result = clean;
      item.endedAt = this.now().toISOString();
    });
  }

  progress(item) {
    const done = item.steps.filter((x) => x.status === 'done').length;
    const skipped = item.steps.filter((x) => x.status === 'skipped').length;
    const failed = item.steps.filter((x) => x.status === 'failed').length;
    return { total: item.steps.length, done, skipped, failed, left: item.steps.filter((x) => x.status === 'pending').length };
  }
}

// Короткая памятка активных целей для системного промпта: чтобы после перезапуска и через много
// ходов Джарвис видел, что не закрыто. Без неё — пустая строка. Ошибка файла не должна ломать чат.
function goalsBrief(store, { limit = 3 } = {}) {
  try {
    const items = store.list({ status: 'active', limit });
    if (!items.length) return '';
    const lines = items.map((item) => {
      const p = store.progress(item);
      const next = item.steps.find((s) => s.status === 'pending');
      return `- ${item.title} (id ${item.id}, шагов ${p.done}/${p.total}): дальше ${next ? next.text : 'закрыть через goal_close'}`;
    });
    return ['Активные цели:', ...lines].join('\n').slice(0, 800);
  } catch {
    return '';
  }
}

module.exports = { GoalStore, MAX_ACTIVE, MAX_STEPS, MAX_STEP_TEXT, MAX_EVIDENCE, STATUSES, STEP_STATUSES, goalsBrief };
