'use strict';

// Наборы источников web_research для отдельной проверки утверждений.
// Живут только в памяти процесса: на диск ничего не пишется, перезапуск очищает.
// Проверка сравнивает утверждение с собранным материалом, а не истинность мира:
// supported значит «дословная цитата есть в прочитанном источнике», а не «это правда».

const TTL_MS = 30 * 60 * 1000; // набор живёт полчаса
const MAX_BUNDLES = 5; // последние пять наборов, старые вытесняются
const MAX_BUNDLE_CHARS = 2 * 1024 * 1024; // объём текстов одного набора
const MAX_TOTAL_CHARS = 5 * 1024 * 1024; // объём текстов всех наборов
const MAX_SOURCE_CHARS = 100 * 1000; // хвост одной страницы дальше не нужен
const MAX_SOURCE_ID = 16;
const MAX_SOURCE_URL = 2048;
const MAX_SOURCE_TITLE = 300;
const MAX_EVIDENCE_CHARS = 200;
const EVIDENCE_PAD = 60; // сколько символов текста показать вокруг цитаты

// researchId → { researchId, sources: [{ id, url, title, text, read }], at, chars }
const bundles = new Map();
let sequence = 0;

function cut(text, max) {
  return text.length > max ? text.slice(0, max) : text;
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// ID источника сравниваем без учёта регистра: S1 и s1 — один и тот же источник.
function sourceKey(id) {
  return asText(id).trim().toUpperCase();
}

function currentTime(opts) {
  if (opts && typeof opts.now === 'function') return opts.now();
  if (opts && Number.isFinite(opts.now)) return opts.now;
  return Date.now();
}

// Нормализация для сравнения: регистр, ё/е, пробелы и переводы строк.
// Слова не меняются: пунктуация и порядок букв должны совпасть дословно.
// Заодно возвращает карту «индекс в норме → индекс в исходном тексте»,
// чтобы показать в доказательстве настоящий фрагмент страницы.
function normalizeWithMap(text) {
  const source = asText(text);
  let norm = '';
  const map = [];
  let pendingSpace = -1;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      if (norm !== '' && pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0) {
      norm += ' ';
      map.push(pendingSpace);
      pendingSpace = -1;
    }
    const lower = ch.toLowerCase().replace(/ё/g, 'е');
    for (let k = 0; k < lower.length; k += 1) {
      norm += lower[k];
      map.push(i);
    }
  }
  return { norm, map };
}

function normalize(text) {
  return normalizeWithMap(text).norm;
}

// Копия источников с обрезанным текстом: набор не должен занимать всю память,
// даже если страница огромная. Пустой текст означает «страница не прочитана».
function sanitizeSources(rawSources) {
  const sources = [];
  const seen = new Set();
  let left = MAX_BUNDLE_CHARS;
  for (const raw of Array.isArray(rawSources) ? rawSources : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = cut(asText(raw.id).trim(), MAX_SOURCE_ID);
    if (!id) continue;
    const key = sourceKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const text = cut(asText(raw.text), Math.min(MAX_SOURCE_CHARS, Math.max(0, left)));
    left -= text.length;
    sources.push({
      id,
      url: cut(asText(raw.url), MAX_SOURCE_URL),
      title: cut(asText(raw.title), MAX_SOURCE_TITLE),
      text,
      read: text.length > 0,
    });
  }
  return sources;
}

function prune(now) {
  for (const [id, bundle] of bundles) {
    if (now - bundle.at >= TTL_MS) bundles.delete(id);
  }
}

function totalChars() {
  let total = 0;
  for (const bundle of bundles.values()) total += bundle.chars;
  return total;
}

// Держим не больше пяти наборов и общий объём: первыми уходят самые старые.
function enforceBudget() {
  while (bundles.size > MAX_BUNDLES) bundles.delete(bundles.keys().next().value);
  while (totalChars() > MAX_TOTAL_CHARS && bundles.size > 1) bundles.delete(bundles.keys().next().value);
}

// Запоминает набор источников и возвращает его ID. Ничего не пишет на диск.
// opts.now — подменяемые часы для тестов.
function registerBundle(bundle = {}, opts = {}) {
  const now = currentTime(opts);
  prune(now);
  const sources = sanitizeSources(bundle && bundle.sources);
  if (sources.length === 0) return null;
  const at = Number.isFinite(bundle.at) ? bundle.at : now;
  sequence += 1;
  const given = asText(bundle.researchId).trim();
  const researchId = given || `research_${now.toString(36)}_${sequence.toString(36)}`;
  // Повторная запись с тем же ID обновляет набор и делает его самым новым.
  bundles.delete(researchId);
  bundles.set(researchId, {
    researchId,
    sources,
    at,
    chars: sources.reduce((sum, source) => sum + source.text.length, 0),
  });
  enforceBudget();
  return researchId;
}

function getBundle(researchId, opts = {}) {
  const id = asText(researchId).trim();
  if (!id) return null;
  prune(currentTime(opts));
  return bundles.get(id) || null;
}

// Источники набора или null, если набор не найден или устарел.
function getSources(researchId, opts = {}) {
  const bundle = getBundle(researchId, opts);
  return bundle ? bundle.sources : null;
}

// Самый свежий набор по времени сбора или null.
function latestBundle(opts = {}) {
  prune(currentTime(opts));
  let latest = null;
  for (const bundle of bundles.values()) {
    if (!latest || bundle.at >= latest.at) latest = bundle;
  }
  return latest;
}

// Только для тестов: состояние модуля в памяти.
function resetStore() {
  bundles.clear();
  sequence = 0;
}

function isReadSource(source) {
  if (!source || source.read === false) return false;
  return asText(source.text).length > 0;
}

function sourceMap(bundle) {
  const map = new Map();
  for (const source of Array.isArray(bundle && bundle.sources) ? bundle.sources : []) {
    const key = sourceKey(source && source.id);
    if (!key || map.has(key)) continue;
    map.set(key, source);
  }
  return map;
}

// Уникальные ID источников утверждения; нестроковые и повторы отбрасываются.
function citedIds(claim) {
  const raw = Array.isArray(claim && claim.sources) ? claim.sources : [];
  const ids = [];
  const seen = new Set();
  for (const item of raw) {
    const key = sourceKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ids.push(key);
  }
  return ids;
}

// Настоящий фрагмент текста вокруг найденной цитаты: модель увидит, что именно совпало.
function fragmentAround(original, map, index, length) {
  const first = map[index];
  const last = map[index + length - 1];
  const from = Math.max(0, first - EVIDENCE_PAD);
  const to = Math.min(original.length, last + 1 + EVIDENCE_PAD);
  const fragment = cut(collapse(original.slice(from, to)), MAX_EVIDENCE_CHARS);
  return `${from > 0 ? '…' : ''}${fragment}${to < original.length ? '…' : ''}`;
}

// Чистая проверка: bundle не меняется, время и реестр не используются.
// Возвращает по каждому утверждению { text, status, source, evidence }.
// Статусы: supported | unsupported | no_quote | unknown_source.
function checkClaims(bundle, claims) {
  const sources = sourceMap(bundle);
  const normalized = new Map(); // ID источника → { source, norm, map }
  const pick = (key) => {
    if (!normalized.has(key)) {
      const source = sources.get(key);
      normalized.set(key, { source, ...normalizeWithMap(source.text) });
    }
    return normalized.get(key);
  };

  return (Array.isArray(claims) ? claims : []).map((claim) => {
    const text = asText(claim && claim.text).trim();
    const quote = normalize(claim && claim.quote);
    if (!quote) {
      return { text, status: 'no_quote', source: null, evidence: 'цитата не указана — подтвердить нельзя' };
    }
    const cited = citedIds(claim);
    if (cited.length === 0) {
      return { text, status: 'unknown_source', source: null, evidence: 'источники не указаны — сравнивать не с чем' };
    }
    const missing = cited.filter((key) => !sources.has(key));
    const unread = cited.filter((key) => sources.has(key) && !isReadSource(sources.get(key)));
    if (missing.length > 0 || unread.length > 0) {
      const parts = [];
      if (missing.length > 0) parts.push(`в наборе нет: ${missing.join(', ')}`);
      if (unread.length > 0) parts.push(`не прочитаны: ${unread.map((key) => sources.get(key).id).join(', ')}`);
      return { text, status: 'unknown_source', source: null, evidence: parts.join('; ') };
    }
    for (const key of cited) {
      const { source, norm, map } = pick(key);
      const index = norm.indexOf(quote);
      if (index < 0) continue;
      return {
        text,
        status: 'supported',
        source: source.id,
        evidence: `${source.id}: «${fragmentAround(source.text, map, index, quote.length)}»`,
      };
    }
    const listed = cited.map((key) => sources.get(key).id).join(', ');
    return { text, status: 'unsupported', source: null, evidence: `дословная цитата не найдена в ${listed}; возможно, это пересказ` };
  });
}

module.exports = {
  TTL_MS,
  MAX_BUNDLES,
  MAX_BUNDLE_CHARS,
  MAX_TOTAL_CHARS,
  MAX_SOURCE_CHARS,
  registerBundle,
  getBundle,
  getSources,
  latestBundle,
  checkClaims,
  normalize,
  resetStore,
};
