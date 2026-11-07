'use strict';

// Сбор исследования через SerpApi: YouTube, Google, Google Scholar, транскрипты видео.
// Ключ берётся только из process.env.SERP_KEY и на диск не пишется.
// Запуск: node run.js run [limit]   — выполнить следующие запросы из queries.json
//         node run.js transcript <videoId> [...] — сохранить транскрипты
// Учёт израсходованных поисков: used.json. Всего разрешено не больше 98.

const fs = require('fs');
const path = require('path');

const KEY = process.env.SERP_KEY;
if (!KEY) {
  console.error('нет SERP_KEY');
  process.exit(1);
}

const ROOT = __dirname;
const RAW = path.join(ROOT, 'raw');
const QUERIES = path.join(ROOT, 'queries.json');
const USED = path.join(ROOT, 'used.json');
const COMPACT = path.join(ROOT, 'compact.jsonl');
const LIMIT = 98;

fs.mkdirSync(RAW, { recursive: true });

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const used = readJson(USED, { queries: [], transcripts: [] });

const writeUsed = () => fs.writeFileSync(USED, JSON.stringify(used, null, 1));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const paramName = (engine) => (engine === 'youtube' ? 'search_query' : 'q');

const buildUrl = (engine, q) => {
  const params = new URLSearchParams({ engine, api_key: KEY });
  params.set(paramName(engine), q);
  if (engine === 'google' || engine === 'google_scholar') {
    params.set('num', '20');
    params.set('hl', 'en');
    params.set('gl', 'us');
  }
  return `https://serpapi.com/search.json?${params}`;
};

const compactYouTube = (data) => (data.video_results || []).map((v) => ({
  title: v.title,
  link: v.link,
  channel: v.channel && v.channel.name,
  published: v.published_date,
  views: v.views,
  length: v.length,
  description: String(v.description || '').slice(0, 400),
}));

const compactGoogle = (data) => (data.organic_results || []).map((r) => ({
  title: r.title,
  link: r.link,
  source: (r.source && (r.source.name || r.source)) || r.displayed_link,
  snippet: String(r.snippet || r.description || '').slice(0, 500),
}));

const compactScholar = (data) => (data.organic_results || []).map((r) => ({
  title: r.title,
  link: r.link,
  publication: (r.publication_info && r.publication_info.summary) || '',
  snippet: String(r.snippet || '').slice(0, 500),
}));

async function fetchQuery(engine, q, id) {
  const url = buildUrl(engine, q);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
      const data = await res.json();
      if (res.status === 429) {
        console.log(`429 ${id}, ждём 8 с (попытка ${attempt})`);
        await sleep(8000);
        continue;
      }
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      console.log(`ошибка ${id}: ${err.message} (попытка ${attempt})`);
      await sleep(2000 * attempt);
    }
  }
  return null;
}

function record(engine, tag, q, id, results) {
  const entry = { id, engine, tag, q, count: results.length, results };
  fs.appendFileSync(COMPACT, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function run(limit) {
  const queries = readJson(QUERIES, []);
  const done = new Set(used.queries.map((x) => x.id));
  const todo = queries.filter((x) => !done.has(x.id));
  const take = todo.slice(0, limit);
  let spent = 0;
  for (const item of take) {
    if (used.queries.length + used.transcripts.length >= LIMIT) {
      console.log('лимит поисков исчерпан');
      break;
    }
    const data = await fetchQuery(item.engine, item.q, item.id);
    if (!data) continue;
    fs.writeFileSync(path.join(RAW, `${item.id}.json`), JSON.stringify(data, null, 1));
    const results = item.engine === 'youtube'
      ? compactYouTube(data)
      : item.engine === 'google_scholar' ? compactScholar(data) : compactGoogle(data);
    record(item.engine, item.tag, item.q, item.id, results);
    used.queries.push({ id: item.id, engine: item.engine, at: new Date().toISOString() });
    spent += 1;
    writeUsed();
    console.log(`${item.id}: ${results.length} результатов (${results.slice(0, 2).map((r) => r.title).join(' | ')})`);
    await sleep(400);
  }
  console.log(`сделано ${spent}; всего поисков ${used.queries.length + used.transcripts.length}/${LIMIT}`);
}

async function transcripts(ids) {
  for (const v of ids) {
    const id = `tr-${v}`;
    if (used.transcripts.some((x) => x.v === v)) continue;
    if (used.queries.length + used.transcripts.length >= LIMIT) {
      console.log('лимит поисков исчерпан');
      break;
    }
    const url = `https://serpapi.com/search.json?engine=youtube_video_transcript&v=${encodeURIComponent(v)}&api_key=${KEY}`;
    let data = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
        data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        break;
      } catch (err) {
        console.log(`ошибка транскрипта ${v}: ${err.message}`);
        await sleep(2000 * attempt);
        data = null;
      }
    }
    if (!data) continue;
    fs.writeFileSync(path.join(RAW, `${id}.json`), JSON.stringify(data, null, 1));
    const text = (data.transcript || []).map((x) => x.snippet).join(' ');
    fs.writeFileSync(path.join(ROOT, `${id}.txt`), text, 'utf8');
    used.transcripts.push({ v, at: new Date().toISOString() });
    writeUsed();
    console.log(`транскрипт ${v}: ${text.length} символов`);
    await sleep(400);
  }
  console.log(`всего поисков ${used.queries.length + used.transcripts.length}/${LIMIT}`);
}

const mode = process.argv[2] || 'run';
if (mode === 'transcript') {
  transcripts(process.argv.slice(3)).catch((err) => { console.error(err); process.exit(1); });
} else {
  run(Number(process.argv[3]) || 20).catch((err) => { console.error(err); process.exit(1); });
}
