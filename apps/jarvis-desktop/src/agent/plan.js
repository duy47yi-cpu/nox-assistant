'use strict';

// План хода: шаги, которые модель назвала сама, и их закрытие с доказательством.
// В памяти процесса план живёт по ключу хода (runId). На диск (plans.json в папке данных) сохраняется
// черновик для разговора — чат и пространство вместе: один план на активный разговор, чтобы «продолжай»
// поднимал именно его и после перезапуска. Это не долгие цели (src/goals/store.js): у плана один
// разговор, а шаг закрывается только проверкой, а не словами модели.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../config/atomic');
const { readDocx } = require('../tools/documents');

const MAX_STEPS = 20;
const MAX_TEXT = 300;
const MAX_EVIDENCE = 500;
const MAX_PLANS = 20; // планов в памяти процесса (по числу одновременных ходов)
const MAX_PLAN_ITEMS = 40; // планов на диске
const MAX_PLAN_AGE_MS = 30 * 24 * 60 * 60 * 1000; // старше 30 дней план с диска убирается
const MAX_REQUEST = 600;
const MAX_FILES = 10;
const MAX_PATH_TEXT = 300;
const MAX_OBSERVATIONS = 40;
const PLAN_VERSION = 1;
// Слова трёх честных остановок: их показывает и инструмент, и сам агент.
const STOP_WORDS = { impossible: 'Невозможно', needs_human: 'Нужен человек', unsure: 'Не уверен в результате' };

function cleanText(value, max, label, { required = true } = {}) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (required && !text) throw new Error(`${label}: пусто`);
  if (text.length > max) throw new Error(`${label}: не больше ${max} символов`);
  return text;
}

// Пути в доказательстве и артефактах: только строки, без повторов, не больше MAX_FILES.
function cleanFiles(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of list) {
    const file = String(item ?? '').trim();
    if (!file || file.length > MAX_PATH_TEXT || out.includes(file)) continue;
    out.push(file);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function cleanStep(item, i, { keepStatus = false } = {}) {
  const raw = typeof item === 'string' ? item : item && item.text;
  const status = keepStatus && item && item.status === 'done' ? 'done' : 'pending';
  return {
    id: `s${i + 1}`,
    text: cleanText(raw, MAX_TEXT, `шаг ${i + 1}`),
    status,
    evidence: status === 'done' && item && item.evidence ? String(item.evidence).slice(0, MAX_EVIDENCE) : null,
    doneAt: status === 'done' && item && typeof item.doneAt === 'string' ? item.doneAt : null,
    files: cleanFiles(item && item.files),
  };
}

function copyPlan(plan) {
  return {
    ...plan,
    steps: plan.steps.map((s) => ({ ...s, files: Array.isArray(s.files) ? s.files.slice() : [] })),
    ...(Array.isArray(plan.artifacts) ? { artifacts: plan.artifacts.slice() } : {}),
  };
}

// ── Шаг с наблюдаемым результатом ──────────────────────────────────────────
// Шаг с результатом закрывает подтверждённое действие с подходящим объектом.
const RESULT_VERB = /(созда|запиш|записа|записыва|сохран|скача|сформир|сгенерир|напиш|дописа|допиш|перепиш|выгруз|экспортир|отправ|отосл|опублик|закача|загруз|распечата|скопир|перенес|перемест|запомн|напомн|установ|удал|восстанов)/i;
const FILE_WORD = /(файл|документ|конспект|отчёт|отчет|таблиц|презентац|архив|изображени|картинк|скриншот|pdf|docx|xlsx|pptx|csv|\btxt\b|\bmd\b)/i;
// Чтение, поиск и обдумывание сами по себе результата не создают — их закрывает текст.
const LOOK_VERB = /(найти|найди|найдём|найдем|прочит|прочти|читать|посмотр|посмотри|провер|открыть|открой|покаж|искать|глян|сверь|сверить|изуч|проанализир|обдумать|решить|спланир)/i;
const SEND = /отправ|отосл/i;
const ADDRESS = /[\w.!#$%&'*+/=?^\x60{|}~-]+@[\w-]+(?:\.[\w-]+)+/gi;
const REQUIRED_TEXT = /(?:с текстом|содержит)\s+[«"`]([^»"`]+)[»"`]/iu;
const FILE_WRITERS = new Set(['workspace_write', 'workspace_copy', 'workspace_move', 'workspace_restore',
  'document_write', 'document_fill', 'code_write', 'code_edit']);

function observableResult(text) {
  const value = String(text || '').toLowerCase();
  const file = FILE_WORD.test(value);
  if (RESULT_VERB.test(value)) return { needed: true, file };
  if (file && !LOOK_VERB.test(value)) return { needed: true, file: true };
  return { needed: false, file: false };
}

// ── Пути из доказательства ────────────────────────────────────────────────
function cleanCandidate(value) {
  return String(value || '').trim().replace(/[.,;:!?]+$/u, '').replace(/^[«»"'`]+|[«»"'`]+$/gu, '').trim();
}

function looksLikePath(value) {
  if (!value || value.length > MAX_PATH_TEXT) return false;
  if (/[<>|?*\u0000]/u.test(value)) return false;
  if (/[\\/]/.test(value)) return true;
  return /\.[A-Za-z0-9]{1,8}$/u.test(value);
}

function pathCandidates(text) {
  const raw = String(text || '');
  const out = [];
  const push = (value) => {
    const clean = cleanCandidate(value);
    if (looksLikePath(clean) && !out.includes(clean)) out.push(clean);
  };
  for (const match of raw.matchAll(/[«"'`]([^«»"'`\n]{1,300})[»"'`]|[^\s,;()[\]{}<>"«»`']+/g)) push(match[1] || match[0]);
  return out;
}

function isInside(rootAbs, target) {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const base = fold(rootAbs);
  const full = fold(path.resolve(target));
  return full === base || full.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

// Существующий непустой файл (или папка) по пути. Ссылки не принимаем: путь должен быть настоящим.
function pathInfo(candidate, root, { insideOnly = false } = {}) {
  const value = cleanCandidate(candidate);
  if (!value || value.length > MAX_PATH_TEXT) return null;
  if (/[<>|?*"\u0000]/u.test(value)) return null;
  let abs;
  if (path.isAbsolute(value)) abs = value;
  else if (root) abs = path.resolve(root, value);
  else return null;
  let stat;
  try {
    stat = fs.lstatSync(abs, { bigint: true });
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return null;
  const directory = stat.isDirectory();
  if (!directory && (!stat.isFile() || stat.size <= 0)) return null;
  const rootAbs = root ? path.resolve(root) : '';
  const inside = rootAbs ? isInside(rootAbs, abs) : false;
  if (insideOnly && rootAbs && !inside) return null;
  return {
    path: abs,
    directory,
    display: inside ? path.relative(rootAbs, abs).split(path.sep).join('/') : abs,
    stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
  };
}

function planPath(root, candidate) {
  if (!root && !path.isAbsolute(candidate)) return '';
  const abs = path.resolve(root || '.', candidate);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function fileTargets(text, root) {
  const copy = /скопир|перенес|перемест/i.test(text);
  const candidates = pathCandidates(text.replace(REQUIRED_TEXT, '').split(/\s+из\s+/iu)[0])
    .filter((value) => !value.includes('@') && !/^https?:/i.test(value));
  return [...new Set((copy ? candidates.slice(-1) : candidates).map((value) => planPath(root, value)).filter(Boolean))];
}

function containsRequiredText(info, snippet) {
  if (!snippet) return true;
  if (!/\.(?:txt|md|csv|json|html|log|docx)$/i.test(info.path)) return false;
  try {
    if (fs.statSync(info.path).size > 1024 * 1024) return false;
    const bytes = fs.readFileSync(info.path);
    const text = /\.docx$/i.test(info.path) ? readDocx(bytes) : bytes.toString('utf8');
    return text.includes(snippet);
  } catch {
    return false;
  }
}

function resultProof(observations, target, request, root, evidence) {
  const text = target.text;
  const unused = observations.filter((item) => !item.used);
  if (SEND.test(text)) {
    const addresses = [...new Set((text.match(ADDRESS) || request.match(ADDRESS) || []).map((value) => value.toLowerCase()))];
    const sent = unused.filter((item) => item.name === 'mail_send' && item.recipient);
    const matches = addresses.length ? addresses.map((address) => sent.find((item) => item.recipient === address)) : sent.slice(0, 1);
    if (!matches.length || matches.some((item) => !item)) throw new Error('нужна подтверждённая отправка письма нужному адресату');
    return { used: matches, files: [] };
  }
  if (observableResult(text).file || fileTargets(text, root).length) {
    const named = fileTargets(text, root);
    const requested = fileTargets(request, root);
    const expected = named.length ? named : requested.length === 1 ? requested : [];
    const stated = fileTargets(evidence, root);
    const snippet = REQUIRED_TEXT.exec(text)?.[1] ||
      (expected.length === 1 && requested.length === 1 && expected[0] === requested[0] ? REQUIRED_TEXT.exec(request)?.[1] : '');
    const operation = /скопир/i.test(text) ? 'workspace_copy'
      : /перенес|перемест/i.test(text) ? 'workspace_move'
        : /восстанов/i.test(text) ? 'workspace_restore' : '';
    const files = unused.flatMap((item) => {
      if (!item.file || (operation && item.name !== operation)) return [];
      const info = pathInfo(item.file.path, root);
      return info && !info.directory && info.stamp === item.file.stamp && containsRequiredText(info, snippet) ? [{ info, item }] : [];
    });
    const names = expected.length ? expected : stated;
    const matches = names.length
      ? names.map((name) => files.find(({ info }) => planPath(root, info.path) === name))
      : files.length === 1 ? files : [];
    if (!matches.length || matches.some((item) => !item) ||
      (expected.length && stated.length && expected.some((name) => !stated.includes(name)))) {
      throw new Error('нужна подтверждённая запись именно запрошенного файла с нужным содержимым');
    }
    return { used: matches.map(({ item }) => item), files: matches.map(({ info }) => info.display) };
  }
  const toolPattern = /памят|запомн/i.test(text) ? /^remember$/
    : /напомн/i.test(text) ? /^remind_(?:in|at)$/
      : /установ/i.test(text) ? /^app_install$/ : null;
  const action = toolPattern && unused.find((item) => toolPattern.test(item.name));
  if (!action) throw new Error('нужна подтверждённая проверка результата именно этого шага');
  return { used: [action], files: [] };
}

// ── Хранилище планов на диске ─────────────────────────────────────────────
// Ключ — пространство и чат. Один план на активный разговор; старые планы убираются по возрасту
// и по числу. Запись атомарная: сбой посреди записи оставляет прежний файл целым.
function scopeKey(chatId, workspaceId) {
  const chat = String(chatId ?? '').trim();
  const space = String(workspaceId ?? '').trim() || 'default';
  if (!chat || chat.length > 200 || space.length > 200) return null;
  return { chatId: chat, workspaceId: space, key: `${space}\u0000${chat}` };
}

function planFromItem(item) {
  const steps = (Array.isArray(item.steps) ? item.steps : []).slice(0, MAX_STEPS).map((step, i) => cleanStep(step, i, { keepStatus: true }));
  if (!steps.length) return null;
  return {
    chatId: String(item.chatId || ''),
    workspaceId: String(item.workspaceId || ''),
    request: String(item.request || ''),
    steps,
    artifacts: cleanFiles(item.artifacts),
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

class PlanStore {
  constructor(file, { now = () => new Date(), maxItems = MAX_PLAN_ITEMS, maxAgeMs = MAX_PLAN_AGE_MS } = {}) {
    this.file = file;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.maxItems = Math.max(1, Number(maxItems) || MAX_PLAN_ITEMS);
    this.maxAgeMs = Math.max(0, Number(maxAgeMs) || MAX_PLAN_AGE_MS);
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return { version: PLAN_VERSION, items: [] };
      throw new Error(`файл планов не прочитан: ${this.file}`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`файл планов повреждён: ${this.file}`);
    }
    if (!data || !Array.isArray(data.items)) throw new Error(`файл планов повреждён: ${this.file}`);
    return data;
  }

  _save(data) {
    const now = this.now().getTime();
    data.version = PLAN_VERSION;
    data.items = data.items
      .filter((item) => {
        const at = Number(item && item.updatedAt);
        return Number.isFinite(at) && now - at <= this.maxAgeMs;
      })
      .slice(0, this.maxItems);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(data, null, 2));
  }

  get({ chatId, workspaceId } = {}) {
    const scope = scopeKey(chatId, workspaceId);
    if (!scope) return null;
    const data = this._load();
    const item = data.items.find((x) => {
      const own = scopeKey(x && x.chatId, x && x.workspaceId);
      return own && own.key === scope.key;
    });
    return item ? planFromItem(item) : null;
  }

  put({ chatId, workspaceId, request = '', steps = [], artifacts = [] } = {}) {
    const scope = scopeKey(chatId, workspaceId);
    if (!scope) throw new Error('план: нужен чат и пространство');
    if (!Array.isArray(steps) || !steps.length) throw new Error('план: нужен хотя бы один шаг');
    if (steps.length > MAX_STEPS) throw new Error(`план: не больше ${MAX_STEPS} шагов`);
    const cleanSteps = steps.map((item, i) => cleanStep(item, i, { keepStatus: true }));
    const data = this._load();
    const previous = data.items.find((x) => {
      const own = scopeKey(x && x.chatId, x && x.workspaceId);
      return own && own.key === scope.key;
    });
    const at = this.now().getTime();
    const item = {
      chatId: scope.chatId,
      workspaceId: scope.workspaceId,
      request: cleanText(request, MAX_REQUEST, 'просьба', { required: false }),
      steps: cleanSteps,
      artifacts: cleanFiles(artifacts),
      createdAt: previous && previous.createdAt ? previous.createdAt : at,
      updatedAt: at,
    };
    data.items = data.items.filter((x) => {
      const own = scopeKey(x && x.chatId, x && x.workspaceId);
      return !own || own.key !== scope.key;
    });
    data.items.unshift(item);
    this._save(data);
    return planFromItem(item);
  }

  remove({ chatId, workspaceId } = {}) {
    const scope = scopeKey(chatId, workspaceId);
    if (!scope) return false;
    const data = this._load();
    const before = data.items.length;
    data.items = data.items.filter((x) => {
      const own = scopeKey(x && x.chatId, x && x.workspaceId);
      return !own || own.key !== scope.key;
    });
    if (data.items.length === before) return false;
    this._save(data);
    return true;
  }

  list({ workspaceId = null, limit = 20 } = {}) {
    const data = this._load();
    const space = workspaceId == null ? null : String(workspaceId || 'default');
    return data.items
      .filter((item) => !space || String(item.workspaceId || 'default') === space)
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(planFromItem)
      .filter(Boolean);
  }
}

// ── Планы хода ────────────────────────────────────────────────────────────
class TurnPlans {
  constructor({ maxPlans = MAX_PLANS, store = null, now = () => new Date(), retainCompleted = false } = {}) {
    this.maxPlans = Math.max(1, Number(maxPlans) || MAX_PLANS);
    this.retainCompleted = retainCompleted;
    this.store = store && typeof store.get === 'function' ? store : null;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.byRun = new Map();
    this.lastError = ''; // последняя причина, по которой план не прочитан или не сохранён
  }

  _key(runId) {
    const key = String(runId || '').trim();
    if (!key) throw new Error('план доступен только внутри хода');
    return key;
  }

  _record(runId) {
    const key = this._key(runId);
    let record = this.byRun.get(key);
    if (!record) {
      record = { runId: key, chatId: '', workspaceId: '', request: '', root: '', plan: null, observations: [] };
      this.byRun.set(key, record);
      while (this.byRun.size > this.maxPlans) this.byRun.delete(this.byRun.keys().next().value);
    }
    return record;
  }

  // Начало хода: запомнить разговор и вернуть сохранённый план этого разговора (или null).
  // План не поднимается сам: это делает агент по «продолжай» и показывает модели заметку.
  start(runId, { chatId = '', workspaceId = '', request = '', root = '' } = {}) {
    const record = this._record(runId);
    record.chatId = String(chatId ?? '').trim();
    record.workspaceId = String(workspaceId ?? '').trim();
    record.request = String(request ?? '').slice(0, MAX_REQUEST);
    record.root = String(root ?? '');
    record.plan = null;
    record.observations = [];
    return this.load({ chatId: record.chatId, workspaceId: record.workspaceId });
  }

  load({ chatId, workspaceId } = {}) {
    if (!this.store) return null;
    try {
      const plan = this.store.get({ chatId, workspaceId });
      this.lastError = '';
      return plan;
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err);
      return null;
    }
  }

  set(runId, steps) {
    const list = Array.isArray(steps) ? steps : [];
    if (!list.length) throw new Error('план: нужен хотя бы один шаг');
    if (list.length > MAX_STEPS) throw new Error(`план: не больше ${MAX_STEPS} шагов`);
    const record = this._record(runId);
    const plan = {
      runId: record.runId,
      request: record.request,
      steps: list.map((item, i) => cleanStep(item, i)),
      artifacts: [],
      createdAt: this.now().toISOString(),
    };
    record.plan = plan;
    record.observations = [];
    this._persist(record);
    return copyPlan(plan);
  }

  // «Продолжай»: тот же план переходит в новый ход. Закрытые шаги остаются закрытыми.
  seed(runId, previous) {
    const source = previous && Array.isArray(previous.steps) ? previous.steps : [];
    if (!source.length) throw new Error('план: нужен хотя бы один шаг');
    const record = this._record(runId);
    const plan = {
      runId: record.runId,
      request: String((previous && previous.request) || record.request || '').slice(0, MAX_REQUEST),
      steps: source.slice(0, MAX_STEPS).map((item, i) => cleanStep(item, i, { keepStatus: true })),
      artifacts: cleanFiles(previous && previous.artifacts),
      createdAt: (previous && previous.createdAt) || this.now().toISOString(),
    };
    record.plan = plan;
    if (plan.request) record.request = plan.request;
    this._persist(record);
    return copyPlan(plan);
  }

  // Подтверждённое действие используется только для одного подходящего шага.
  done(runId, step, evidence, { root = '' } = {}) {
    const record = this._record(runId);
    const plan = record.plan;
    if (!plan) throw new Error('план не задан: сначала plan_set');
    const index = Number(step);
    if (!Number.isInteger(index) || index < 1 || index > plan.steps.length) {
      throw new Error(`шага ${step} нет: всего ${plan.steps.length}`);
    }
    const clean = cleanText(evidence, MAX_EVIDENCE, 'доказательство');
    if (root) record.root = String(root);
    const target = plan.steps[index - 1];
    if (target.status === 'done') return copyPlan(plan);
    const need = observableResult(target.text);
    if (need.needed) {
      const proof = resultProof(record.observations, target, plan.request, record.root, clean);
      for (const item of proof.used) item.used = true;
      target.files = proof.files.slice(0, MAX_FILES);
    }
    target.status = 'done';
    target.evidence = clean;
    target.doneAt = this.now().toISOString();
    this._persist(record);
    return copyPlan(plan);
  }

  // Наблюдение за завершённым инструментом: им шаг подтверждается, а не текстом модели.
  observe(runId, observation) {
    if (!observation || typeof observation !== 'object') return;
    const name = String(observation.name || '').slice(0, 60);
    if (!name || observation.verified !== 'confirmed') return;
    const record = this._record(runId);
    const file = FILE_WRITERS.has(name) && typeof observation.path === 'string' ? pathInfo(observation.path, record.root) : null;
    record.observations.push({
      name,
      file,
      recipient: typeof observation.recipient === 'string' ? observation.recipient.trim().toLowerCase() : '',
    });
    if (record.observations.length > MAX_OBSERVATIONS) {
      record.observations.splice(0, record.observations.length - MAX_OBSERVATIONS);
    }
  }

  _files(record) {
    const out = [];
    const add = (info) => {
      if (info && !out.includes(info.display)) out.push(info.display);
    };
    for (const step of record.plan ? record.plan.steps : []) {
      for (const file of step.files || []) add(pathInfo(file, record.root, { insideOnly: false }));
    }
    for (const observation of record.observations) {
      if (observation.file) add(pathInfo(observation.file.path, record.root));
    }
    return out.slice(0, MAX_FILES);
  }

  _persist(record) {
    if (!this.store || !record || !record.plan) return false;
    const scope = scopeKey(record.chatId, record.workspaceId);
    if (!scope) return false;
    try {
      const unfinished = record.plan.steps.some((step) => step.status !== 'done');
      if (!unfinished && !this.retainCompleted) {
        // План закрыт: «продолжай» не должен поднимать его снова.
        this.store.remove({ chatId: scope.chatId, workspaceId: scope.workspaceId });
        this.lastError = '';
        return true;
      }
      const artifacts = this._files(record);
      record.plan.artifacts = artifacts;
      this.store.put({
        chatId: scope.chatId,
        workspaceId: scope.workspaceId,
        createdAt: record.plan.createdAt,
        request: record.plan.request,
        steps: record.plan.steps,
        artifacts,
      });
      this.lastError = '';
      return true;
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err);
      console.warn(`план не сохранён: ${this.lastError}`);
      return false;
    }
  }

  // Конец хода: черновик с незакрытыми шагами остаётся на диске, закрытый план убирается.
  finish(runId) {
    const record = this.byRun.get(String(runId || ''));
    if (!record || !record.plan) return null;
    this._persist(record);
    return copyPlan(record.plan);
  }

  // План отдан в фон: убираем и из памяти, и с диска, чтобы «продолжай» не начал его заново.
  drop({ chatId, workspaceId } = {}) {
    const scope = scopeKey(chatId, workspaceId);
    if (!scope) return false;
    for (const [key, record] of this.byRun) {
      const own = scopeKey(record.chatId, record.workspaceId);
      if (own && own.key === scope.key) this.byRun.delete(key);
    }
    if (!this.store) return false;
    try {
      return this.store.remove({ chatId: scope.chatId, workspaceId: scope.workspaceId });
    } catch {
      return false;
    }
  }

  get(runId) {
    const record = this.byRun.get(String(runId || ''));
    return record && record.plan ? copyPlan(record.plan) : null;
  }

  // Сколько шагов закрыто и какие остались. Осталось — то, что ещё не сделано.
  summary(plan) {
    const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
    const done = steps.filter((s) => s.status === 'done').length;
    return {
      total: steps.length,
      done,
      unfinished: steps.length - done,
      left: steps.map((s, i) => ({ step: i + 1, status: s.status, text: s.text })).filter((s) => s.status !== 'done'),
    };
  }
}

// Строка для ответа: что осталось. Код дописывает её сам, чтобы «готово» не прятало незакрытое.
function planNote(summary, { maxItems = 3, maxText = 80 } = {}) {
  const left = summary && Array.isArray(summary.left) ? summary.left : [];
  if (!left.length) return '';
  const shown = left.slice(0, maxItems).map((item) => `шаг ${item.step} — ${String(item.text).slice(0, maxText)}`);
  const more = left.length > maxItems ? `; ещё ${left.length - maxItems}` : '';
  return `Не закрыто: ${shown.join('; ')}${more}`;
}

// Памятка для «продолжай»: весь план с состоянием шагов, чтобы модель не начинала заново.
function planBrief(plan, { maxItems = 10, maxText = 120 } = {}) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) return '';
  const lines = steps.slice(0, maxItems).map((s, i) => {
    const state = s.status === 'done' ? `сделано${s.evidence ? ` (${String(s.evidence).slice(0, 60)})` : ''}` : 'осталось';
    return `${i + 1}) ${String(s.text).slice(0, maxText)} — ${state}`;
  });
  return ['План прошлого хода, продолжай с незакрытого:', ...lines].join('\n');
}

function planFilesOf(plan) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const out = [];
  for (const step of steps) {
    for (const file of Array.isArray(step.files) ? step.files : []) {
      if (!out.includes(file)) out.push(file);
    }
  }
  for (const file of plan && Array.isArray(plan.artifacts) ? plan.artifacts : []) {
    if (!out.includes(file)) out.push(file);
  }
  return out.slice(0, MAX_FILES);
}

// Заметка модели после перезапуска: что сделано, какие файлы получились и какой шаг следующий.
function planResumeNote(plan, { maxItems = 10, maxText = 120 } = {}) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) return '';
  const done = [];
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].status !== 'done') continue;
    const files = Array.isArray(steps[i].files) && steps[i].files.length
      ? `, файл: ${steps[i].files.slice(0, 3).join(', ')}` : '';
    done.push(`${i + 1}) ${String(steps[i].text).slice(0, maxText)}${files}`);
  }
  const files = planFilesOf(plan);
  const nextIndex = steps.findIndex((step) => step.status !== 'done');
  return [
    'Продолжаем прошлый план этого разговора: он сохранён на диск и пережил перезапуск.',
    done.length ? `Сделано: ${done.slice(0, maxItems).join('; ')}` : 'Сделано: пока ничего',
    files.length ? `Файлы: ${files.join(', ')}` : '',
    nextIndex >= 0 ? `Следующий шаг: ${nextIndex + 1}) ${String(steps[nextIndex].text).slice(0, maxText)}` : '',
    'Не начинай заново. В ответе назови: что уже сделано, какие файлы получились и какой шаг следующий.',
  ].filter(Boolean).join('\n');
}

function planWord(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
}

// Дописываемая строка к ответу после «продолжай»: только то, чего в ответе модели нет.
// Так владелец видит сделанное, файл и следующий шаг, даже если модель ответила общими словами.
function planResumeAnswer(plan, answerText = '', { maxText = 100 } = {}) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) return '';
  const answer = planWord(answerText);
  const mentions = (value) => {
    const key = planWord(value).slice(0, 24);
    return Boolean(key) && answer.includes(key);
  };
  const done = [];
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].status === 'done') done.push({ index: i + 1, text: steps[i].text });
  }
  const files = planFilesOf(plan).filter((file) => !answer.includes(planWord(file)));
  const nextIndex = steps.findIndex((step) => step.status !== 'done');
  const parts = [];
  if (done.length && !done.some((item) => mentions(item.text))) {
    parts.push(`сделано — ${done.map((item) => `${item.index}) ${String(item.text).slice(0, maxText)}`).join('; ')}`);
  }
  if (files.length) parts.push(`файл: ${files.join(', ')}`);
  if (nextIndex >= 0 && !mentions(steps[nextIndex].text)) {
    parts.push(`следующий шаг — ${nextIndex + 1}) ${String(steps[nextIndex].text).slice(0, maxText)}`);
  }
  return parts.length ? `Продолжаем: ${parts.join('; ')}.` : '';
}

// «Продолжай/продолжим/где остановились/вернёмся» — просьба вернуться к сохранённому плану.
const RESUME_PHRASE = /(?:^|[^\p{L}\p{N}])(?:продолжай|продолжим|продолжаем|продолжите|продолжить|continue|где\s+(?:мы\s+)?остановились|верн[её]мся)(?=$|[^\p{L}\p{N}])/iu;

function isResumePhrase(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  return RESUME_PHRASE.test(value.slice(0, 200));
}

module.exports = {
  TurnPlans, PlanStore, planNote, planBrief, planResumeNote, planResumeAnswer, planFilesOf,
  isResumePhrase, observableResult, STOP_WORDS,
  MAX_STEPS, MAX_TEXT, MAX_EVIDENCE, MAX_PLANS, MAX_PLAN_ITEMS, MAX_PLAN_AGE_MS, MAX_REQUEST,
};
