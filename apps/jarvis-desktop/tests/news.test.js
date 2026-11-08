'use strict';

// Тесты источника новостей для столов: разбор RSS/Atom без пакетов, обрезка и очистка
// текста, только http(s)-ссылки, дедупликация, лимиты, а также fetchNews с кэшем,
// таймаутом и честными ошибками. Сеть не используется: fetchImpl всегда подменяется,
// кэш лежит во временной папке os.tmpdir().

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rss = require('../src/news/rss');

function tmpCache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-news-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'news-cache.json');
}

function xmlItem(title, link, pubDate = '', description = '') {
  return `<item><title>${title}</title><link>${link}</link>`
    + `${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}`
    + `${description ? `<description>${description}</description>` : ''}</item>`;
}

function rssDoc(items) {
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Лента</title>${items.join('')}</channel></rss>`;
}

const SAMPLE = rssDoc([
  xmlItem('<![CDATA[<b>Марс</b> &amp; Луна]]>', 'https://example.com/mars', 'Fri, 07 Nov 2026 10:00:00 GMT', '<![CDATA[<p>Текст &amp; ещё</p>]]>'),
  xmlItem('Вторая новость', 'https://example.com/second', 'Thu, 06 Nov 2026 10:00:00 GMT', 'Просто текст'),
]);

// --- разбор ---------------------------------------------------------------

test('parseRss: RSS 2.0, поля, CDATA, дата в ISO, HTML вычищен', () => {
  const parsed = rss.parseRss(SAMPLE);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items.length, 2);
  const first = parsed.items[0];
  assert.equal(first.title, 'Марс & Луна');
  assert.equal(first.link, 'https://example.com/mars');
  assert.equal(first.date, '2026-11-07T10:00:00.000Z');
  assert.equal(first.summary, 'Текст & ещё');
  assert.equal(first.source, null);
  assert.equal(parsed.items[1].title, 'Вторая новость');
  assert.equal(parsed.items[1].summary, 'Просто текст');
});

test('parseRss: HTML в title и summary удаляется, сущности раскрываются', () => {
  const doc = rssDoc([xmlItem('Новость <b>важная</b>&nbsp;сегодня', 'https://example.com/a', '', '<p>Первый</p><p>Второй</p>')]);
  const parsed = rss.parseRss(doc);
  assert.equal(parsed.items[0].title, 'Новость важная сегодня');
  assert.equal(parsed.items[0].summary, 'Первый Второй');
  // script/style вырезаются целиком, а не только теги.
  const doc2 = rssDoc([xmlItem('Тема<script>alert(1)</script>', 'https://example.com/b', '', '')]);
  assert.equal(rss.parseRss(doc2).items[0].title, 'Тема');
  assert.equal(rss.stripHtml('&lt;тег&gt; &quot;x&quot;'), '<тег> "x"');
  assert.equal(rss.decodeEntities('a&#33;b&#x21;c'), 'a!b!c');
});

test('parseRss: битый XML — честная ошибка, пустая лента — ok без записей', () => {
  assert.deepEqual(rss.parseRss('<rss><channel><item><title>x</title>'), { ok: false, reason: 'bad_xml' });
  assert.deepEqual(rss.parseRss('<rss version="2.0"><channel></channel></rss>'), { ok: true, items: [] });
  assert.deepEqual(rss.parseRss(rssDoc([])), { ok: true, items: [] });
  assert.deepEqual(rss.parseRss('не xml'), { ok: false, reason: 'bad_xml' });
  assert.deepEqual(rss.parseRss(''), { ok: false, reason: 'bad_input' });
  assert.deepEqual(rss.parseRss(null), { ok: false, reason: 'bad_input' });
  assert.deepEqual(rss.parseRss(42), { ok: false, reason: 'bad_input' });
});

test('parseRss: только http(s)-ссылки, запись без адреса или с javascript: пропускается', () => {
  const doc = rssDoc([
    xmlItem('Плохая', 'javascript:alert(1)'),
    xmlItem('Относительная', '/news/2026/11/07/item'),
    xmlItem('Хорошая', 'https://example.com/good'),
    '<item><title>Совсем без ссылки</title></item>',
  ]);
  const parsed = rss.parseRss(doc);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].link, 'https://example.com/good');
});

test('parseRss: дубликаты склеиваются по ссылке', () => {
  const doc = rssDoc([
    xmlItem('Первая', 'https://example.com/same'),
    xmlItem('Первая (копия)', 'https://example.com/same'),
    xmlItem('Другая', 'https://example.com/other'),
  ]);
  const parsed = rss.parseRss(doc);
  assert.equal(parsed.items.length, 2);
  assert.deepEqual(parsed.items.map((i) => i.link), ['https://example.com/same', 'https://example.com/other']);
});

test('parseRss: лимит соблюдается, title <= 200 и summary <= 300', () => {
  const items = Array.from({ length: 6 }, (_, i) => xmlItem(`Новость ${i}`, `https://example.com/${i}`));
  assert.equal(rss.parseRss(rssDoc(items), { limit: 2 }).items.length, 2);
  assert.equal(rss.parseRss(rssDoc(items), { limit: 1 }).items.length, 1);
  assert.equal(rss.parseRss(rssDoc(items)).items.length, 6);
  const longTitle = 'я'.repeat(500);
  const longSummary = 'ж'.repeat(600);
  const parsed = rss.parseRss(rssDoc([xmlItem(longTitle, 'https://example.com/long', '', longSummary)]));
  assert.equal(Array.from(parsed.items[0].title).length, rss.MAX_TITLE);
  assert.equal(Array.from(parsed.items[0].summary).length, rss.MAX_SUMMARY);
});

test('parseRss: Atom entry тоже понимается (href в link)', () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <title>Лента</title>
    <entry><title>Атомная новость</title><link href="https://example.com/atom"/><updated>2026-11-07T09:00:00Z</updated><summary>Кратко</summary></entry>
  </feed>`;
  const parsed = rss.parseRss(atom);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, 'Атомная новость');
  assert.equal(parsed.items[0].link, 'https://example.com/atom');
  assert.equal(parsed.items[0].date, '2026-11-07T09:00:00.000Z');
  assert.equal(parsed.items[0].summary, 'Кратко');
  assert.equal(rss.parseRss('<feed><title>x</title>').ok, false, 'обрезанный Atom = bad_xml');
});

// --- загрузка, кэш, ошибки ------------------------------------------------

test('fetchNews: загружает ленты, кэширует по URL, второй вызов берёт кэш без сети', async (t) => {
  const cachePath = tmpCache(t);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => SAMPLE };
  };
  const first = await rss.fetchNews({
    urls: ['https://feed.example/a', 'https://feed.example/b'],
    fetchImpl,
    cachePath,
    now: () => Date.parse('2026-11-07T10:00:00Z'),
  });
  assert.equal(first.ok, true);
  assert.equal(first.items.length, 2);
  assert.equal(first.cached, false);
  assert.equal(first.stale, false);
  assert.equal(calls.length, 2);
  assert.equal(first.errors.length, 0);
  assert.ok(fs.existsSync(cachePath), 'кэш записан');
  const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(saved.version, rss.CACHE_VERSION);
  assert.ok(saved.feeds['https://feed.example/a']);

  const second = await rss.fetchNews({
    urls: ['https://feed.example/a', 'https://feed.example/b'],
    fetchImpl,
    cachePath,
    now: () => Date.parse('2026-11-07T10:05:00Z'),
  });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(second.stale, false);
  assert.equal(calls.length, 2, 'в пределах 30 минут в сеть не ходим');
});

test('fetchNews: сеть упала, но старый кэш есть — данные со stale и причиной', async (t) => {
  const cachePath = tmpCache(t);
  const start = Date.parse('2026-11-07T10:00:00Z');
  await rss.fetchNews({
    urls: ['https://feed.example/a'],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => SAMPLE }),
    cachePath,
    now: () => start,
  });
  const later = start + 2 * 60 * 60 * 1000; // кэш старше 30 минут
  const result = await rss.fetchNews({
    urls: ['https://feed.example/a'],
    fetchImpl: async () => { throw new Error('нет сети'); },
    cachePath,
    now: () => later,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stale, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].reason, 'network');
  assert.equal(result.fetchedAt, start);
});

test('fetchNews: все ленты упали и кэша нет — честный {ok:false, reason}', async () => {
  const result = await rss.fetchNews({
    urls: ['https://feed.example/a'],
    fetchImpl: async () => { throw new Error('boom'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network');
  assert.equal(Array.isArray(result.errors), true);
});

test('fetchNews: таймаут даёт reason timeout, HTTP-ошибка — http_код', async (t) => {
  const slow = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const timed = await rss.fetchNews({ urls: ['https://feed.example/slow'], fetchImpl: slow, timeoutMs: 20 });
  assert.equal(timed.ok, false);
  assert.equal(timed.reason, 'timeout');
  assert.equal(timed.errors[0].reason, 'timeout');

  const http = await rss.fetchNews({
    urls: ['https://feed.example/broken'],
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
  });
  assert.equal(http.ok, false);
  assert.equal(http.reason, 'http_503');
});

test('fetchNews: без адресов и с неверными адресами — no_urls, сеть не трогаем', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return { ok: true, text: async () => SAMPLE }; };
  assert.deepEqual(await rss.fetchNews({ urls: [], fetchImpl }), { ok: false, reason: 'no_urls' });
  assert.deepEqual(await rss.fetchNews({ urls: ['ftp://example.com/feed', 'javascript:x'], fetchImpl }), { ok: false, reason: 'no_urls' });
  assert.equal(called, 0);
});

test('fetchNews: одна лента ответила, другая нет — данные есть, ошибка записана', async (t) => {
  const cachePath = tmpCache(t);
  const fetchImpl = async (url) => {
    if (url.includes('good')) return { ok: true, status: 200, text: async () => SAMPLE };
    throw new Error('offline');
  };
  const result = await rss.fetchNews({
    urls: ['https://feed.example/good', 'https://feed.example/bad'],
    fetchImpl,
    cachePath,
    now: () => Date.parse('2026-11-07T10:00:00Z'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].url, 'https://feed.example/bad');
});

test('fetchNews: битый XML из сети — error без подстановки новостей', async () => {
  const result = await rss.fetchNews({
    urls: ['https://feed.example/broken'],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<rss><channel>' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_xml');
});

test('fetchNews: битый кэш игнорируется, данные грузятся заново', async (t) => {
  const cachePath = tmpCache(t);
  fs.writeFileSync(cachePath, '{это не json', 'utf8');
  const result = await rss.fetchNews({
    urls: ['https://feed.example/a'],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => SAMPLE }),
    cachePath,
    now: () => Date.parse('2026-11-07T10:00:00Z'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.ok(saved.feeds['https://feed.example/a'], 'кэш перезаписан валидным');
});

test('fetchNews: пустые ленты — ok с пустым списком, а не выдумка', async (t) => {
  const result = await rss.fetchNews({
    urls: ['https://feed.example/empty'],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => rssDoc([]) }),
    cachePath: tmpCache(t),
    now: () => Date.parse('2026-11-07T10:00:00Z'),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, []);
});

test('источники по умолчанию: 2–3 настоящих RSS без мостов и политики', () => {
  assert.ok(rss.DEFAULT_FEEDS.length >= 2 && rss.DEFAULT_FEEDS.length <= 3);
  for (const feed of rss.DEFAULT_FEEDS) {
    assert.equal(/^https:\/\//.test(feed.url), true, feed.url);
    assert.equal(typeof feed.title, 'string');
    assert.equal(/telegram|t\.me/i.test(feed.url), false);
  }
  assert.ok(rss.DEFAULT_FEEDS.some((feed) => /nasa\.gov/.test(feed.url)));
  assert.ok(rss.DEFAULT_FEEDS.every((feed) => rss.httpLink(feed.url) === feed.url || rss.httpLink(feed.url) !== null));
});
