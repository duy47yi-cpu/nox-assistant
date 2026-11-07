'use strict';

// Первое видео из результатов поиска YouTube. Страница результатов загружается обычным HTTP-запросом,
// без браузера и без UI Automation: это быстрее, и браузер открывается один раз — сразу на видео.
const SEARCH_URL = 'https://www.youtube.com/results?search_query=';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 4000;
const VIDEO_RE = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"/;
const TITLE_RE = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/;
// Хвост «40 seconds» и «4 minutes, 48 seconds» — на случай, если он попал в название.
const DURATION_RE = /\s*\d+ (?:minutes?|seconds?)(?:, \d+ seconds?)?\.?\s*$/i;
// Эмодзи по краям названия: в музыкальных названиях они только мешают.
const EDGE_EMOJI_RE = /^[\p{Extended_Pictographic}️\s]+|[\p{Extended_Pictographic}️\s]+$/gu;

// Название видео без эмодзи и хвоста с длительностью.
function cleanTitle(raw) {
  const t = String(raw || '').replace(DURATION_RE, '').replace(EDGE_EMOJI_RE, '').trim();
  return t || 'видео';
}

// Первое видео из HTML страницы результатов. null, если его нет.
function pickFromHtml(html) {
  const text = String(html || '');
  const m = VIDEO_RE.exec(text);
  if (!m) return null;
  const near = text.slice(m.index, m.index + 6000);
  const t = TITLE_RE.exec(near);
  let title = '';
  if (t) {
    try {
      title = JSON.parse(`"${t[1]}"`);
    } catch {
      title = t[1];
    }
  }
  return { id: m[1], title: cleanTitle(title), url: `https://www.youtube.com/watch?v=${m[1]}` };
}

// Ищет первое видео по запросу. Любая ошибка сети или таймаут — null: тогда откроется страница поиска.
async function findFirstYoutubeVideo(query, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${SEARCH_URL}${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ru-RU,ru;q=0.9' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return pickFromHtml(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Ссылка на видео с нужной секунды: YouTube понимает параметр t=16s.
function atSecond(url, seconds) {
  if (!(Number.isInteger(seconds) && seconds > 0)) return url;
  const u = new URL(url);
  u.searchParams.set('t', `${seconds}s`);
  return u.href;
}

module.exports = { findFirstYoutubeVideo, pickFromHtml, cleanTitle, atSecond };
