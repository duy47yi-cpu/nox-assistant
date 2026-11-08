'use strict';

// Новости для виджета «Новости»: разбор RSS 2.0 / Atom без внешних пакетов и один
// честный источник с кэшем. Ничего не придумываем: если сеть или разбор не удались,
// наружу уходит {ok:false, reason}; если данные есть, но из старого кэша — stale:true.
//
// parseRss(xml, {limit}) — чистый разбор строки: {ok:true, items:[{title, link, date, summary}]}
//   или {ok:false, reason}. Ссылки только http(s), title <= 200, summary <= 300, без HTML.
// fetchNews({urls, timeoutMs, fetchImpl, cachePath, cacheTtlMs, now, limit}) — загрузка
//   с таймаутом и кэшем по каждому URL в news-cache.json (путь передаёт вызывающий).
//   fetchImpl подменяется в тестах: настоящая сеть в тестах не нужна.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../config/atomic');

const MAX_TITLE = 200;
const MAX_SUMMARY = 300;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_VERSION = 1;
const CACHE_FILE = 'news-cache.json';

// Надёжные RSS без мостов и политики: официальный канал NASA и научные ленты.
// Если лента временно недоступна, честно сообщаем причину, а не подставляем текст.
const DEFAULT_FEEDS = Object.freeze([
  Object.freeze({ id: 'nasa', title: 'NASA', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss' }),
  Object.freeze({ id: 'universetoday', title: 'Universe Today', url: 'https://www.universetoday.com/feed/' }),
  Object.freeze({ id: 'sciencedaily', title: 'ScienceDaily: космос', url: 'https://www.sciencedaily.com/rss/space_time.xml' }),
]);

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
});

function clampLimit(value) {
  if (!Number.isInteger(value) || value < 1) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

function cut(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

// Сущности XML/HTML: именованные из таблицы и числовые (десятичные и hex).
function decodeEntities(text) {
  if (!text) return '';
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const value = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
      if (Number.isInteger(value) && value > 0 && value <= 0x10ffff) {
        try { return String.fromCodePoint(value); } catch { return ''; }
      }
      return '';
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// Без HTML: убираем script/style целиком, затем теги, затем раскрываем сущности
// и схлопываем пробелы. Так в заголовке не остаётся «<b>» и «&nbsp;».
function stripHtml(text) {
  if (typeof text !== 'string') return '';
  const withoutBlocks = text
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const withoutTags = withoutBlocks.replace(/<[^>]*>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

function cdata(text) {
  const source = typeof text === 'string' ? text : '';
  return source.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// Содержимое первого тега с таким именем; CDATA сохраняется как текст.
function tagText(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
    const found = re.exec(block);
    if (found) return cdata(found[1]);
  }
  return '';
}

// Atom-ссылка лежит в атрибуте href, у RSS — в тексте <link>.
function linkText(block) {
  const plain = tagText(block, ['link']);
  if (plain) return plain;
  const atom = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(block);
  return atom ? cdata(atom[1]) : '';
}

function httpLink(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  let parsed;
  try { parsed = new URL(text); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString().slice(0, 2000);
}

function isoDate(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const ms = new Date(text).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function looksLikeXml(raw) {
  if (!raw) return { ok: false, reason: 'bad_xml' };
  const kind = /<rss\b/i.test(raw) ? 'rss'
    : /<feed\b/i.test(raw) ? 'atom'
      : /<rdf:RDF\b/i.test(raw) ? 'rdf' : null;
  if (!kind) return { ok: false, reason: 'bad_xml' };
  // Обрезанный документ (нет закрывающего корневого тега) — честная ошибка разбора,
  // а не «новостей нет»: иначе половина ленты выглядела бы пустотой.
  if (kind === 'rss' && !/<\/rss>\s*$/i.test(raw)) return { ok: false, reason: 'bad_xml' };
  if (kind === 'atom' && !/<\/feed>\s*$/i.test(raw)) return { ok: false, reason: 'bad_xml' };
  if (kind === 'rdf' && !/<\/rdf:RDF>\s*$/i.test(raw)) return { ok: false, reason: 'bad_xml' };
  return { ok: true, kind };
}

// Разбор одной записи. Запись без заголовка или без http(s) ссылки не показываем:
// заголовок «Новость» и пустой адрес — это не новость, а мусор ленты.
function parseItem(block, source) {
  const title = cut(stripHtml(tagText(block, ['title'])), MAX_TITLE);
  if (!title) return null;
  const link = httpLink(decodeEntities(linkText(block)));
  if (!link) return null;
  const date = isoDate(tagText(block, ['pubDate', 'published', 'updated', 'dc:date']));
  const summary = cut(stripHtml(tagText(block, ['description', 'summary', 'content:encoded', 'content'])), MAX_SUMMARY);
  return { title, link, date, summary, source: source || null };
}

// Чистый разбор ленты. Дубликаты склеиваем по ссылке: одна новость в двух лентах
// не должна занимать два места в маленьком виджете.
function parseRss(xml, options = {}) {
  if (typeof xml !== 'string') return { ok: false, reason: 'bad_input' };
  const raw = xml.trim();
  if (!raw) return { ok: false, reason: 'bad_input' };
  const checked = looksLikeXml(raw);
  if (!checked.ok) return checked;
  const limit = clampLimit(options.limit);
  const source = typeof options.source === 'string' && options.source.trim() ? options.source.trim().slice(0, 60) : null;
  const blocks = [];
  if (checked.kind === 'atom') {
    const entry = /<entry\b[\s\S]*?<\/entry>/gi;
    let found = entry.exec(raw);
    while (found) { blocks.push(found[0]); found = entry.exec(raw); }
  } else {
    const item = /<item\b[\s\S]*?<\/item>/gi;
    let found = item.exec(raw);
    while (found) { blocks.push(found[0]); found = item.exec(raw); }
  }
  const items = [];
  const seen = new Set();
  for (const block of blocks) {
    const item = parseItem(block, source);
    if (!item) continue;
    const key = item.link.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= limit) break;
  }
  return { ok: true, items };
}

// --- кэш и сеть -----------------------------------------------------------

function emptyCache() {
  return { version: CACHE_VERSION, feeds: {} };
}

// Битый или чужой кэш — не ошибка: просто начинаем с пустого, в сеть всё равно пойдём.
function readCache(cachePath) {
  if (typeof cachePath !== 'string' || !cachePath) return emptyCache();
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!data || typeof data !== 'object' || data.version !== CACHE_VERSION || !data.feeds || typeof data.feeds !== 'object') {
      return emptyCache();
    }
    const feeds = {};
    for (const [url, entry] of Object.entries(data.feeds)) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.items)) continue;
      const fetchedAt = Number(entry.fetchedAt);
      if (!Number.isFinite(fetchedAt)) continue;
      feeds[url] = { fetchedAt, items: entry.items.filter((item) => item && typeof item.title === 'string' && typeof item.link === 'string') };
    }
    return { version: CACHE_VERSION, feeds };
  } catch {
    return emptyCache();
  }
}

function writeCache(cachePath, cache) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileAtomic(cachePath, JSON.stringify(cache));
    return null;
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

// Нормализуем вход: строки или {url, title/id}. Не-http(s) адреса отбрасываем.
function readUrls(urls) {
  const list = Array.isArray(urls) ? urls : typeof urls === 'string' ? [urls] : [];
  const out = [];
  for (const raw of list) {
    const url = httpLink(typeof raw === 'string' ? raw : raw && raw.url);
    if (!url) continue;
    const title = raw && typeof raw === 'object' && typeof raw.title === 'string' ? raw.title.slice(0, 60) : null;
    const id = raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id.slice(0, 40) : null;
    if (out.some((item) => item.url === url)) continue;
    out.push({ url, title, id });
  }
  return out;
}

// Загрузка одной ленты с таймаутом. Ошибки возвращаем причиной, не бросаем наружу.
async function fetchFeed(feed, { fetchImpl, timeoutMs }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const work = (async () => {
    const init = controller ? { signal: controller.signal, redirect: 'follow' } : { redirect: 'follow' };
    const response = await fetchImpl(feed.url, init);
    if (!response || typeof response.text !== 'function') return { ok: false, reason: 'bad_response' };
    if (response.ok === false) return { ok: false, reason: `http_${Number(response.status) || 0}` };
    const text = await response.text();
    return parseRss(text, { limit: MAX_LIMIT, source: feed.title || feed.id || feed.url });
  })();
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  try {
    return await work;
  } catch (err) {
    const name = err && err.name ? String(err.name) : '';
    return { ok: false, reason: name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.link.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function byDate(a, b) {
  const at = a.date ? new Date(a.date).getTime() : -Infinity;
  const bt = b.date ? new Date(b.date).getTime() : -Infinity;
  return bt - at;
}

// Загрузка новостей: кэш 30 минут по каждому URL, таймаут на запрос, честные ошибки.
// cachePath — путь к news-cache.json; передаёт вызывающий (сам DATA_DIR модуль не знает).
// fetchImpl и now внедряются в тестах; без них — обычный fetch и Date.now.
async function fetchNews(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const ttl = Number.isInteger(options.cacheTtlMs) && options.cacheTtlMs >= 0 ? options.cacheTtlMs : CACHE_TTL_MS;
  const limit = clampLimit(options.limit);
  const cachePath = typeof options.cachePath === 'string' && options.cachePath ? path.resolve(options.cachePath) : null;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const urls = options.urls === undefined || options.urls === null ? DEFAULT_FEEDS : options.urls;
  const feeds = readUrls(urls);
  if (!feeds.length) return { ok: false, reason: 'no_urls' };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no_fetch' };

  const cache = readCache(cachePath);
  const errors = [];
  const collected = [];
  let newest = 0;
  let anyStale = false;
  let anyCache = false;

  // Свежие записи кэша берём сразу, остальные ленты качаем параллельно: таймаут
  // одного источника не складывается с таймаутами остальных.
  const pending = [];
  for (const feed of feeds) {
    const cached = cache.feeds[feed.url];
    const fresh = cached && now - cached.fetchedAt <= ttl;
    if (fresh) {
      anyCache = true;
      newest = Math.max(newest, cached.fetchedAt);
      collected.push(...cached.items);
      continue;
    }
    pending.push({ feed, cached });
  }
  const usedNetwork = pending.length > 0;
  const results = await Promise.all(pending.map(({ feed }) => fetchFeed(feed, { fetchImpl, timeoutMs })));
  for (let i = 0; i < pending.length; i += 1) {
    const { feed, cached } = pending[i];
    const result = results[i];
    if (result.ok) {
      cache.feeds[feed.url] = { fetchedAt: now, items: result.items };
      newest = Math.max(newest, now);
      collected.push(...result.items);
      continue;
    }
    errors.push({ url: feed.url, reason: result.reason });
    // Сеть не ответила, но прежний кэш есть — показываем его с пометкой «устарело».
    if (cached) {
      anyCache = true;
      anyStale = true;
      newest = Math.max(newest, cached.fetchedAt);
      collected.push(...cached.items);
    }
  }

  if (cachePath && usedNetwork) writeCache(cachePath, cache);
  const items = dedupe(collected).sort(byDate).slice(0, limit);
  if (!items.length && errors.length) {
    return { ok: false, reason: errors[0].reason || 'network', errors, stale: false };
  }
  return {
    ok: true,
    items,
    fetchedAt: newest || now,
    cached: anyCache && !usedNetwork,
    stale: anyStale,
    errors,
    sources: feeds.map((feed) => ({ url: feed.url, title: feed.title, id: feed.id })),
  };
}

module.exports = {
  MAX_TITLE,
  MAX_SUMMARY,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  CACHE_TTL_MS,
  CACHE_FILE,
  CACHE_VERSION,
  DEFAULT_FEEDS,
  parseRss,
  fetchNews,
  stripHtml,
  decodeEntities,
  httpLink,
  readCache,
  readUrls,
};
