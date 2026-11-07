'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webTools } = require('../src/tools/web');
const { ToolRegistry } = require('../src/tools/registry');
const claimsStore = require('../src/research/claims');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Jarvis/0.1';

// Ответ в форме, которую используют инструменты: ok, status, headers.get, text, body.
function response({ status = 200, body = '', contentType = 'text/html; charset=utf-8', location } = {}) {
  const headers = new Map();
  if (contentType) headers.set('content-type', contentType);
  if (location) headers.set('location', location);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => body,
    body: null,
  };
}

// Подменённый fetch: запоминает вызовы, ответ отдаёт handler.
function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { fetchImpl, calls };
}

// Подменённый резолвер: любое имя ведёт на публичный адрес, в сеть не ходим.
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function toolByName(tools, name) {
  return tools.find((tool) => tool.name === name);
}

const DDG_HTML = `
<div class="result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fru.wikipedia.org%2Fwiki%2FCats&amp;rut=abc">Кошки &amp; <b>котики</b></a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fru.wikipedia.org%2Fwiki%2FCats">Домашние <b>кошки</b> &quot;любят&quot; &#39;тепло&#39;.</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="https://example.com/direct">Прямая &lt;ссылка&gt;</a></h2>
  <div class="result__snippet">Второй <b>сниппет</b></div>
</div>`;

test('web_search: парсит результаты, uddg-редирект и сущности, шлёт User-Agent', async () => {
  const { fetchImpl, calls } = recordingFetch(() => response({ body: DDG_HTML }));
  const search = toolByName(webTools({ fetchImpl }), 'web_search');

  const res = await search.run({ query: 'кошки' });

  assert.equal(res.ok, true);
  assert.equal(res.summary, 'найдено: 2');
  assert.deepEqual(res.data.results, [
    {
      title: 'Кошки & котики',
      url: 'https://ru.wikipedia.org/wiki/Cats',
      snippet: 'Домашние кошки "любят" \'тепло\'.',
    },
    {
      title: 'Прямая <ссылка>',
      url: 'https://example.com/direct',
      snippet: 'Второй сниппет',
    },
  ]);
  assert.equal(calls[0].url, `https://html.duckduckgo.com/html/?q=${encodeURIComponent('кошки')}`);
  assert.equal(calls[0].options.headers['User-Agent'], UA);
});

test('web_search: не больше 5 результатов; пустая выдача — ok:true с пустым списком', async () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    `<a class="result__a" href="https://site${i}.example/">Результат ${i}</a>` +
    `<div class="result__snippet">текст ${i}</div>`
  ).join('\n');
  const { fetchImpl } = recordingFetch(() => response({ body: many }));
  const search = toolByName(webTools({ fetchImpl }), 'web_search');

  const res = await search.run({ query: 'что угодно' });
  assert.equal(res.data.results.length, 5);
  assert.equal(res.data.results[4].url, 'https://site4.example/');

  const empty = recordingFetch(() => response({ body: '<html><body>Ничего</body></html>' }));
  const none = await toolByName(webTools({ fetchImpl: empty.fetchImpl }), 'web_search').run({ query: 'зря' });
  assert.deepEqual(none, { ok: true, summary: 'ничего не найдено', data: { results: [] } });
});

test('web_search: пустой и слишком длинный запрос не уходят в сеть', async () => {
  const { fetchImpl, calls } = recordingFetch(() => response({ body: DDG_HTML }));
  const search = toolByName(webTools({ fetchImpl }), 'web_search');

  for (const query of ['', '   ']) {
    assert.equal((await search.run({ query })).ok, false);
  }
  const long = await search.run({ query: 'a'.repeat(201) });
  assert.equal(long.ok, false);
  assert.equal(calls.length, 0);
});

test('web_wiki: статья найдена; пробелы в названии становятся _; extract обрезается до 1500', async () => {
  const json = {
    title: 'Кошка домашняя',
    extract: 'я'.repeat(2000),
    content_urls: { desktop: { page: 'https://ru.wikipedia.org/wiki/Кошка_домашняя' } },
  };
  const { fetchImpl, calls } = recordingFetch(() => response({
    contentType: 'application/json',
    body: JSON.stringify(json),
  }));
  const wiki = toolByName(webTools({ fetchImpl }), 'web_wiki');

  const res = await wiki.run({ title: '  Кошка   домашняя ' });

  assert.equal(res.ok, true);
  assert.equal(
    calls[0].url,
    `https://ru.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent('Кошка_домашняя')}`
  );
  assert.equal(res.data.title, 'Кошка домашняя');
  assert.equal(res.data.extract.length, 1500);
  assert.equal(res.data.url, 'https://ru.wikipedia.org/wiki/Кошка_домашняя');
});

test('web_wiki: 404 даёт "статья не найдена"; язык по умолчанию ru, en работает; другой язык отклоняется', async () => {
  const notFound = recordingFetch(() => response({ status: 404, contentType: 'application/json', body: '{}' }));
  const missing = await toolByName(webTools({ fetchImpl: notFound.fetchImpl }), 'web_wiki')
    .run({ title: 'Нет такой' });
  assert.equal(missing.ok, false);
  assert.equal(missing.summary, 'статья не найдена');

  const english = recordingFetch(() => response({
    contentType: 'application/json',
    body: JSON.stringify({ title: 'Cat', extract: 'A cat.' }),
  }));
  const wiki = toolByName(webTools({ fetchImpl: english.fetchImpl }), 'web_wiki');
  await wiki.run({ title: 'Cat' });
  assert.ok(english.calls[0].url.startsWith('https://ru.wikipedia.org/'));
  await wiki.run({ title: 'Cat', lang: 'en' });
  assert.ok(english.calls[1].url.startsWith('https://en.wikipedia.org/'));

  const bad = await wiki.run({ title: 'Cat', lang: 'de' });
  assert.equal(bad.ok, false);
  assert.equal(english.calls.length, 2, 'неверный язык до сети не доходит');
});

test('web_fetch: убирает script, style, noscript и теги, декодирует сущности', async () => {
  const html = `<!doctype html><html><head><title>Тест</title>
<style>body { color: red; }</style>
<script>alert('взлом');</script></head>
<body><noscript>Включите JS</noscript>
<h1>Заголовок</h1><p>Первый &amp; абзац</p>
<div>Второй   абзац<br>с переносом</div>
<script type="text/javascript">var x = "<b>";</script></body></html>`;
  const { fetchImpl } = recordingFetch(() => response({ body: html }));
  const fetchTool = toolByName(webTools({ fetchImpl, lookup: publicLookup }), 'web_fetch');

  const res = await fetchTool.run({ url: 'https://example.com/article' });

  assert.equal(res.ok, true);
  assert.match(res.summary, /^страница: \d+ симв\.$/);
  const { text } = res.data;
  for (const junk of ['alert', 'color', 'Включите', 'var x']) {
    assert.ok(!text.includes(junk), `в тексте не должно быть «${junk}»`);
  }
  assert.ok(!/[<>]/.test(text), 'теги удалены');
  assert.ok(text.includes('Заголовок'));
  assert.ok(text.includes('Первый & абзац'));
  assert.ok(text.includes('Второй абзац'));
  assert.ok(text.includes('с переносом'));
  assert.equal(res.data.url, 'https://example.com/article');
});

test('web_fetch: тело читается не больше 500 КБ, длинный хвост обрывается', async () => {
  const chunks = [];
  for (let i = 0; i < 5; i++) chunks.push(Buffer.from('a'.repeat(100000)));
  // Шестой кусок пересекает лимит 512000 байт; маркер стоит за ним.
  chunks.push(Buffer.concat([Buffer.from('a'.repeat(99990)), Buffer.from('МАРКЕР')]));
  chunks.push(Buffer.from('b'.repeat(100000)));

  let chunksRead = 0;
  let cancelled = false;
  const reader = {
    read: async () => {
      if (chunksRead >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: chunks[chunksRead++] };
    },
    cancel: async () => {
      cancelled = true;
    },
  };
  const streaming = {
    ...response({ body: '' }),
    body: { getReader: () => reader },
    text: async () => {
      throw new Error('при наличии потока text() не должен вызываться');
    },
  };
  const { fetchImpl } = recordingFetch(() => streaming);
  const fetchTool = toolByName(webTools({ fetchImpl, lookup: publicLookup }), 'web_fetch');

  const res = await fetchTool.run({ url: 'https://example.com/big' });

  assert.equal(res.ok, true);
  assert.equal(res.data.text, 'a'.repeat(6000), 'текст обрезан до 6000 символов');
  assert.ok(!res.data.text.includes('МАРКЕР'), 'хвост за лимитом не попал в ответ');
  assert.equal(chunksRead, 6, 'дальше лимита поток не читается');
  assert.ok(chunksRead < chunks.length);
  assert.equal(cancelled, true, 'поток отменён на лимите');
});

test('web_fetch: localhost, частные адреса, ftp, file и адреса без точки отклоняются без запроса в сеть', async () => {
  const { fetchImpl, calls } = recordingFetch(() => response({ body: '<p>x</p>' }));
  const fetchTool = toolByName(webTools({ fetchImpl, lookup: publicLookup }), 'web_fetch');

  const blocked = [
    'http://localhost/',
    'http://foo.localhost/',
    'http://127.0.0.1:8080/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://172.31.255.1/',
    'http://169.254.10.10/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://intranet/',
    'ftp://example.com/file.txt',
    'file:///etc/passwd',
  ];
  for (const url of blocked) {
    const res = await fetchTool.run({ url });
    assert.equal(res.ok, false, url);
    assert.equal(res.summary, 'адрес не разрешён', url);
  }
  const garbage = await fetchTool.run({ url: 'not a url' });
  assert.equal(garbage.ok, false);
  assert.equal(garbage.summary, 'некорректный адрес');
  assert.equal(calls.length, 0);
});

test('web_fetch: редирект на закрытый адрес тоже отклоняется', async () => {
  const { fetchImpl, calls } = recordingFetch((url) => {
    if (url === 'https://example.com/go') {
      return response({ status: 302, location: 'http://192.168.1.1/admin', contentType: null });
    }
    return response({ body: '<p>секрет</p>' });
  });
  const fetchTool = toolByName(webTools({ fetchImpl, lookup: publicLookup }), 'web_fetch');

  const res = await fetchTool.run({ url: 'https://example.com/go' });

  assert.equal(res.ok, false);
  assert.equal(res.summary, 'адрес не разрешён');
  assert.equal(calls.length, 1, 'по закрытому адресу запрос не делается');
});

test('web_fetch: имя, которое ведёт на частный или локальный адрес, отклоняется без запроса', async () => {
  const privateAddrs = [
    ['127.0.0.1', 4], ['10.1.2.3', 4], ['172.20.0.1', 4], ['192.168.0.10', 4], ['169.254.169.254', 4], ['0.0.0.0', 4],
    ['::1', 6], ['::', 6], ['fe80::1', 6], ['fd12:3456::1', 6], ['::ffff:127.0.0.1', 6], ['::ffff:192.168.1.1', 6],
  ];
  for (const [address, family] of privateAddrs) {
    const { fetchImpl, calls } = recordingFetch(() => response({ body: '<p>секрет</p>' }));
    const asked = [];
    const lookup = async (host, opts) => {
      asked.push({ host, opts });
      return [{ address: '93.184.216.34', family: 4 }, { address, family }];
    };
    const res = await toolByName(webTools({ fetchImpl, lookup }), 'web_fetch').run({ url: 'https://evil.example/x' });
    assert.equal(res.ok, false, address);
    assert.equal(res.summary, 'адрес не разрешён', address);
    assert.equal(calls.length, 0, address);
    assert.deepEqual(asked, [{ host: 'evil.example', opts: { all: true } }]);
  }
});

test('web_fetch: публичный IPv6 проходит; имя не нашлось — понятная ошибка без запроса', async () => {
  const ok = recordingFetch(() => response({ body: '<p>текст</p>' }));
  const v6 = async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }];
  assert.equal((await toolByName(webTools({ fetchImpl: ok.fetchImpl, lookup: v6 }), 'web_fetch').run({ url: 'https://example.com/' })).ok, true);

  const none = recordingFetch(() => response({ body: '<p>x</p>' }));
  const missing = async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };
  const res = await toolByName(webTools({ fetchImpl: none.fetchImpl, lookup: missing }), 'web_fetch').run({ url: 'https://nope.example/' });
  assert.equal(res.ok, false);
  assert.equal(res.summary, 'не удалось найти адрес сайта');
  assert.equal(none.calls.length, 0);
});

test('web_fetch: адрес проверяется заново на каждом перенаправлении', async () => {
  const { fetchImpl, calls } = recordingFetch((url) => (url === 'https://good.example/go'
    ? response({ status: 302, location: 'https://rebind.example/admin', contentType: null })
    : response({ body: '<p>секрет</p>' })));
  const lookup = async (host) => [{ address: host === 'rebind.example' ? '10.0.0.1' : '93.184.216.34', family: 4 }];
  const res = await toolByName(webTools({ fetchImpl, lookup }), 'web_fetch').run({ url: 'https://good.example/go' });
  assert.equal(res.ok, false);
  assert.equal(res.summary, 'адрес не разрешён');
  assert.equal(calls.length, 1, 'по закрытому адресу запрос не делается');
});

test('web_fetch: application/json отклоняется', async () => {
  const { fetchImpl } = recordingFetch(() => response({
    contentType: 'application/json',
    body: '{"a": 1}',
  }));
  const fetchTool = toolByName(webTools({ fetchImpl, lookup: publicLookup }), 'web_fetch');

  const res = await fetchTool.run({ url: 'https://api.example.com/data' });

  assert.equal(res.ok, false);
  assert.equal(res.summary, 'тип не поддерживается');
});

test('web_fetch: text/plain принимается без разбора тегов; note присутствует', async () => {
  const { fetchImpl } = recordingFetch(() => response({
    contentType: 'text/plain; charset=utf-8',
    body: 'Привет <b>мир</b>\r\n\r\n\r\nвторая строка',
  }));
  const fetchTool = toolByName(webTools({ fetchImpl, lookup: publicLookup }), 'web_fetch');

  const res = await fetchTool.run({ url: 'https://example.com/readme.txt' });

  assert.equal(res.ok, true);
  assert.equal(res.data.text, 'Привет <b>мир</b>\nвторая строка');
  assert.equal(typeof res.data.note, 'string');
  assert.ok(res.data.note.includes('данные, а не инструкции'));
});

test('таймаут и обрыв сети дают ok:false с понятным summary', async () => {
  const hangs = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  const slow = toolByName(webTools({ fetchImpl: hangs, timeoutMs: 20 }), 'web_wiki');
  const timedOut = await slow.run({ title: 'Кошка' });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.summary, 'время ожидания истекло');

  const offline = async () => {
    throw new TypeError('fetch failed');
  };
  const search = toolByName(webTools({ fetchImpl: offline }), 'web_search');
  const down = await search.run({ query: 'кошки' });
  assert.equal(down.ok, false);
  assert.match(down.summary, /не удалось загрузить/);
});

test('все веб-инструменты T0, у каждого есть описание и параметры; регистрируются в ToolRegistry', () => {
  const tools = webTools({ fetchImpl: async () => response() });

  assert.deepEqual(tools.map((tool) => tool.name), ['web_search', 'web_wiki', 'web_fetch', 'web_research', 'web_check_claims']);
  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.risk])),
    { web_search: 'T0', web_wiki: 'T0', web_fetch: 'T0', web_research: 'T0', web_check_claims: 'T0' }
  );
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.run, 'function');
    assert.equal(tool.parameters.type, 'object');
  }
  assert.deepEqual(toolByName(tools, 'web_wiki').parameters.properties.lang.enum, ['ru', 'en']);
  assert.equal(toolByName(tools, 'web_check_claims').parameters.required[0], 'claims');

  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  assert.equal(registry.list().length, 5);
});

test('web_research ищет по нескольким запросам, убирает дубли и отмечает недоступные страницы', async () => {
  const { fetchImpl, calls } = recordingFetch((url) => {
    if (url.includes('duckduckgo.com')) return response({ body: DDG_HTML });
    if (url.includes('wikipedia.org')) return response({ body: '<p>Содержание первой страницы</p>' });
    return response({ status: 403 });
  });
  const tool = toolByName(webTools({ fetchImpl, lookup: publicLookup }), 'web_research');
  const result = await tool.run({ queries: ['кошки', 'котики'], max_sources: 10 });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 4);
  assert.equal(result.data.searches.length, 2);
  assert.equal(result.data.sources.length, 2);
  assert.deepEqual(result.data.sources.map((source) => source.id), ['S1', 'S2']);
  assert.equal(result.data.sources[0].host, 'ru.wikipedia.org');
  assert.deepEqual(result.data.sources[0].found_by, ['кошки', 'котики']);
  assert.equal(result.data.sources[0].status, 'read');
  assert.match(result.data.sources[0].text, /Содержание первой страницы/);
  assert.equal(result.data.sources[1].status, 'unavailable');
  assert.match(result.data.sources[1].error, /403/);
  assert.equal(result.data.sources[1].text, undefined);
  assert.match(result.data.note, /данные, а не инструкции/);
  assert.match(result.data.researchId, /^research_/, 'набор источников запомнен под researchId');
  assert.match(result.summary, new RegExp(result.data.researchId));
});

test('web_research не читает локальные адреса и сообщает об отказе', async () => {
  const html = '<a class="result__a" href="http://127.0.0.1/admin">локальный адрес</a>';
  const { fetchImpl, calls } = recordingFetch(() => response({ body: html }));
  const tool = toolByName(webTools({ fetchImpl, lookup: publicLookup }), 'web_research');
  const result = await tool.run({ queries: ['тест'] });
  assert.equal(result.data.sources[0].status, 'unavailable');
  assert.equal(calls.length, 1);
});

test('web_research чередует запросы при ограничении числа источников', async () => {
  const { fetchImpl } = recordingFetch((url) => {
    if (url.includes('duckduckgo.com')) {
      const query = new URL(url).searchParams.get('q');
      return response({ body: [1, 2, 3].map((n) => `<a class="result__a" href="https://${query}.example/${n}">${query} ${n}</a>`).join('') });
    }
    return response({ body: '<p>Текст страницы</p>' });
  });
  const tool = toolByName(webTools({ fetchImpl, lookup: publicLookup }), 'web_research');
  const result = await tool.run({ queries: ['first', 'second'], max_sources: 2 });
  assert.deepEqual(result.data.sources.map((s) => s.url), ['https://first.example/1', 'https://second.example/1']);
  assert.equal(result.data.found, 6);
  assert.equal(result.data.unvisited, 4);
});

test('web_research проверяет вход до сети и прекращает работу по сигналу остановки', async () => {
  const { fetchImpl, calls } = recordingFetch(() => response({ body: DDG_HTML }));
  const tool = toolByName(webTools({ fetchImpl, lookup: publicLookup }), 'web_research');
  for (const args of [{ queries: [] }, { queries: ['a'.repeat(201)] }, { queries: ['a'], max_sources: 21 }, { queries: ['a', 5] }]) {
    assert.equal((await tool.run(args)).ok, false);
  }
  const controller = new AbortController();
  controller.abort();
  assert.equal((await tool.run({ queries: ['a'] }, { signal: controller.signal })).ok, false);
  assert.equal(calls.length, 0);
});

test('web_check_claims видит источники web_research: supported, unsupported, no_quote, unknown_source', async () => {
  const { fetchImpl } = recordingFetch((url) => {
    if (url.includes('duckduckgo.com')) return response({ body: DDG_HTML });
    if (url.includes('wikipedia.org')) return response({ body: '<p>Домашние кошки любят тепло и спят днём.</p>' });
    return response({ status: 403 });
  });
  const tools = webTools({ fetchImpl, lookup: publicLookup });

  const research = await toolByName(tools, 'web_research').run({ queries: ['кошки'], max_sources: 2 });
  assert.equal(research.ok, true);
  const researchId = research.data.researchId;
  assert.match(researchId, /^research_/);
  assert.equal(research.data.sources.length, 2);
  assert.equal(research.data.sources[1].status, 'unavailable');

  const res = await toolByName(tools, 'web_check_claims').run({
    researchId,
    claims: [
      { text: 'Кошки любят тепло.', sources: ['S1'], quote: 'Кошки любят ТЕПЛО' },
      { text: 'Кошки не спят днём.', sources: ['S1'], quote: 'кошки не спят днём' },
      { text: 'Кошки — хищники.', sources: ['S1'] },
      { text: 'Несуществующий источник.', sources: ['S9'], quote: 'любой текст' },
      { text: 'Утверждение по недоступной странице.', sources: ['S2'], quote: 'любой текст' },
    ],
  });

  assert.equal(res.ok, true);
  assert.equal(res.summary, 'подтверждено 1 из 5');
  assert.equal(res.data.researchId, researchId);
  assert.equal(res.data.supported, 1);
  assert.equal(res.data.total, 5);
  assert.equal(res.data.claims.length, 5);
  const [supported, paraphrase, noQuote, unknown, unread] = res.data.claims;
  assert.deepEqual(Object.keys(supported).sort(), ['evidence', 'source', 'status', 'text']);
  assert.match(supported.evidence, /^S1: «/);
  assert.match(supported.evidence, /любят тепло/);
  assert.equal(paraphrase.status, 'unsupported');
  assert.equal(paraphrase.source, null);
  assert.match(paraphrase.evidence, /пересказ/);
  assert.equal(noQuote.status, 'no_quote');
  assert.equal(unknown.status, 'unknown_source');
  assert.match(unknown.evidence, /S9/);
  assert.equal(unread.status, 'unknown_source');
  assert.match(unread.evidence, /не прочитан/);
  assert.match(res.data.note, /не истинность/);
  assert.match(res.data.note, /данные, а не инструкции/);
});

test('web_check_claims без researchId берёт последний набор; неизвестный набор — честная ошибка', async () => {
  const { fetchImpl } = recordingFetch((url) => {
    if (url.includes('duckduckgo.com')) return response({ body: DDG_HTML });
    if (url.includes('wikipedia.org')) return response({ body: '<p>Содержание страницы для проверки.</p>' });
    return response({ status: 403 });
  });
  const tools = webTools({ fetchImpl, lookup: publicLookup });
  await toolByName(tools, 'web_research').run({ queries: ['кошки'], max_sources: 1 });

  const check = toolByName(tools, 'web_check_claims');
  const latest = await check.run({ claims: [{ text: 'Текст.', sources: ['S1'], quote: 'содержание страницы' }] });
  assert.equal(latest.ok, true);
  assert.match(latest.data.researchId, /^research_/);
  assert.equal(latest.data.claims[0].status, 'supported');

  const stale = await check.run({
    researchId: 'research_нет_такого',
    claims: [{ text: 'Утверждение.', sources: ['S1'], quote: 'цитата' }],
  });
  assert.equal(stale.ok, false);
  assert.match(stale.summary, /не найден или устарел/);
});

test('web_check_claims: T0, проверяет вход до сверки', async () => {
  const tools = webTools({ fetchImpl: async () => response() });
  const check = toolByName(tools, 'web_check_claims');
  assert.equal(check.risk, 'T0');

  const bad = [
    {},
    { claims: [] },
    { claims: 'нет' },
    { claims: Array.from({ length: 21 }, () => ({ text: 'x', sources: ['S1'], quote: 'q' })) },
    { claims: [{ text: '' }] },
    { claims: [{ text: 'x'.repeat(501) }] },
    { claims: [{ text: 'x', quote: 'q'.repeat(1001) }] },
    { claims: [{ text: 'x', quote: 5 }] },
    { claims: [{ text: 'x', sources: 'S1', quote: 'q' }] },
    { claims: [{ text: 'x', sources: Array.from({ length: 11 }, () => 'S1'), quote: 'q' }] },
    { claims: [{ text: 'x', sources: [5], quote: 'q' }] },
    { researchId: 5, claims: [{ text: 'x' }] },
  ];
  for (const args of bad) {
    assert.equal((await check.run(args)).ok, false, JSON.stringify(args).slice(0, 80));
  }
});

test('web_check_claims без собранных источников — ok:false с понятной причиной', async () => {
  claimsStore.resetStore();
  const check = toolByName(webTools({ fetchImpl: async () => response() }), 'web_check_claims');
  const res = await check.run({ claims: [{ text: 'Утверждение.', sources: ['S1'], quote: 'цитата' }] });
  assert.equal(res.ok, false);
  assert.match(res.summary, /сначала вызовите web_research/);
  assert.deepEqual(res.data, {});
});

