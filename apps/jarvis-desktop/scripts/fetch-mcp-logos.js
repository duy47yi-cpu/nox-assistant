'use strict';

// Скачивает открытые значки Simple Icons (CC0 1.0) с CDN и собирает renderer/aether/mcp-logos.js:
// пути SVG, наши монограммы для сервисов без значка и безопасный снимок каталога для окна.
// Запуск:  node scripts/fetch-mcp-logos.js   (из apps/jarvis-desktop, без npm-зависимостей)
//
// Сеть нужна только этому скрипту. Сгенерированный mcp-logos.js работает без сети:
// окно не имеет nodeIntegration и не может прочитать src/mcp/catalog.js, поэтому список
// сервисов для раздела «Дополнения» кладётся в снимок рядом со значками.
//
// Правовая пометка:
// - Значки Simple Icons распространяются по CC0 1.0 Universal (общественное достояние).
// - Названия и логотипы сервисов — товарные знаки их владельцев; здесь они используются
//   только как обозначения сервисов в каталоге, без намёка на партнёрство.
// - Монограммы (буква, глиф, цвет) нарисованы для Nox и не копируют чужие знаки.

const fs = require('fs');
const path = require('path');
const https = require('https');

const { CATALOG, CATEGORIES } = require('../src/mcp/catalog');

const OUT_FILE = path.join(__dirname, '..', 'renderer', 'aether', 'mcp-logos.js');
const DEFAULT_ICON_VERSION = '16.0.0';
// Некоторые знаки убрали из новых выпусков Simple Icons; берём последнюю версию, где они есть.
const ICON_VERSION = {
  slack: '15.0.0',
  heroku: '11.4.0',
  canva: '11.4.0',
  playwright: '11.4.0',
  microsoftazure: '11.4.0',
  windows: '11.4.0',
  microsoftexcel: '11.4.0',
  microsoftword: '11.4.0',
  microsoftpowerpoint: '11.4.0',
  amazonwebservices: '14.0.0',
};

// service id -> slug Simple Icons. Нет записи — значит значка нет, будет наша монограмма.
const BRAND_SLUGS = {
  gdrive: 'googledrive',
  'windows-cli': 'windows',
  git: 'git',
  github: 'github',
  'github-local': 'github',
  gitlab: 'gitlab',
  sentry: 'sentry',
  kubernetes: 'kubernetes',
  docker: 'docker',
  terraform: 'terraform',
  azure: 'microsoftazure',
  'aws-docs': 'amazonwebservices',
  netlify: 'netlify',
  heroku: 'heroku',
  postman: 'postman',
  playwright: 'playwright',
  puppeteer: 'puppeteer',
  'chrome-devtools': 'googlechrome',
  postgres: 'postgresql',
  sqlite: 'sqlite',
  redis: 'redis',
  elasticsearch: 'elasticsearch',
  supabase: 'supabase',
  mongodb: 'mongodb',
  mysql: 'mysql',
  clickhouse: 'clickhouse',
  neo4j: 'neo4j',
  'brave-search': 'brave',
  'google-maps': 'googlemaps',
  duckduckgo: 'duckduckgo',
  arxiv: 'arxiv',
  wikipedia: 'wikipedia',
  notion: 'notion',
  'notion-local': 'notion',
  linear: 'linear',
  atlassian: 'atlassian',
  'atlassian-local': 'atlassian',
  slack: 'slack',
  'slack-local': 'slack',
  airtable: 'airtable',
  todoist: 'todoist',
  asana: 'asana',
  'office-word': 'microsoftword',
  'office-powerpoint': 'microsoftpowerpoint',
  excel: 'microsoftexcel',
  obsidian: 'obsidian',
  figma: 'figma',
  blender: 'blender',
  canva: 'canva',
  stripe: 'stripe',
  'stripe-remote': 'stripe',
  paypal: 'paypal',
  'cloudflare-docs': 'cloudflare',
  'cloudflare-observability': 'cloudflare',
  'cloudflare-radar': 'cloudflare',
  'supabase-remote': 'supabase',
  discord: 'discord',
  resend: 'resend',
};

// Дополнительные значки для карточек, которых нет в каталоге (вход в почту).
const EXTRA_SERVICES = [{ id: 'gmail', slug: 'gmail' }];

// Монограмма: буква, глиф из icons.js и цвет по категории. Наши, не чужие знаки.
const CATEGORY_STYLE = {
  files: { glyph: 'folder', color: '#2D5EE0' },
  git: { glyph: 'cornerDownRight', color: '#3D59D7' },
  dev: { glyph: 'terminal', color: '#235AE9' },
  browser: { glyph: 'globe', color: '#2559E8' },
  data: { glyph: 'layers', color: '#346CDB' },
  web: { glyph: 'search', color: '#2E7CF6' },
  ai: { glyph: 'sparkles', color: '#5070DD' },
  productivity: { glyph: 'checkCircle', color: '#3B66E8' },
  docs: { glyph: 'file', color: '#4B6FEA' },
  design: { glyph: 'palette', color: '#4B6FEA' },
  payments: { glyph: 'shield', color: '#2E7CF6' },
  cloud: { glyph: 'globe', color: '#3D59D7' },
  social: { glyph: 'chat', color: '#5070DD' },
};

const FALLBACK_STYLE = { glyph: 'mcp', color: '#2559E8' };

function cdnUrl(slug, version) {
  return 'https://cdn.jsdelivr.net/npm/simple-icons@' + version + '/icons/' + slug + '.svg';
}

function fetchText(url, redirectsLeft) {
  const left = redirectsLeft === undefined ? 5 : redirectsLeft;
  return new Promise((resolve) => {
    const request = https.get(url, { timeout: 20000 }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location && left > 0) {
        response.resume();
        let next = response.headers.location;
        if (next.startsWith('/')) {
          const parsed = new URL(url);
          next = parsed.origin + next;
        }
        resolve(fetchText(next, left - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('timeout', () => { request.destroy(new Error('таймаут')); });
    request.on('error', () => resolve(null));
  });
}

// Из SVG берём только d-атрибуты путей: в окне они собираются в один <path>.
function svgPaths(svg) {
  const found = [];
  const pattern = /<path\b[^>]*\sd="([^"]+)"/g;
  let match = pattern.exec(svg);
  while (match) {
    found.push(match[1]);
    match = pattern.exec(svg);
  }
  return found.join(' ').replace(/\s+/g, ' ').trim();
}

function safePathData(data) {
  return typeof data === 'string' && data.length > 0 && data.length < 12000
    && /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\-\s]+$/.test(data);
}

// Параллельные загрузки небольшими партиями, чтобы не засыпать CDN.
async function fetchBrands(wanted) {
  const result = new Map();
  const queue = wanted.slice();
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const version = ICON_VERSION[item.slug] || DEFAULT_ICON_VERSION;
      const svg = await fetchText(cdnUrl(item.slug, version));
      if (!svg) continue;
      const data = svgPaths(svg);
      if (safePathData(data)) result.set(item.id, { slug: item.slug, version, path: data });
    }
  });
  await Promise.all(workers);
  return result;
}

function monogramFor(service) {
  const style = CATEGORY_STYLE[service.category] || FALLBACK_STYLE;
  const first = String(service.title || service.id || '?').trim().charAt(0);
  return {
    letter: first ? first.toUpperCase() : '?',
    glyph: style.glyph,
    color: style.color,
  };
}

function buildServices() {
  return CATALOG.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    category: entry.category,
    transport: entry.transport,
    ...(entry.transport === 'stdio'
      ? { command: entry.command, args: entry.args.slice() }
      : { url: entry.url }),
    envKeys: entry.envKeys.slice(),
    ...(entry.docs ? { docs: entry.docs } : {}),
    verified: entry.verified,
  }));
}

function buildFile(brands) {
  const services = buildServices();
  const monograms = {};
  for (const service of services) {
    if (!brands.has(service.id)) monograms[service.id] = monogramFor(service);
  }
  const brandsObject = {};
  // Порядок ключей фиксируем: повторная генерация не должна менять файл из-за гонки загрузок.
  for (const [id, brand] of Array.from(brands.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    brandsObject[id] = brand;
  }
  const today = new Date().toISOString().slice(0, 10);
  const iconVersions = Array.from(new Set([DEFAULT_ICON_VERSION, ...Object.values(ICON_VERSION)])).sort();
  const header = [
    '/* Сгенерировано scripts/fetch-mcp-logos.js — вручную не править.',
    ' *',
    ' * Значки: Simple Icons, лицензия CC0 1.0 Universal (общественное достояние):',
    ' *   https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md',
    ' * Названия и логотипы сервисов — товарные знаки их владельцев; в каталоге они обозначают',
    ' * сервис и не означают партнёрства. Монограммы (буква + глиф + цвет) нарисованы для Nox.',
    ' * В рантайме сеть не нужна: окно берёт путь значка или монограмму из этого файла.',
    ' */',
  ].join('\n');
  const body = [
    '(function () {',
    "  'use strict';",
    '',
    "  var GENERATED = '" + today + "';",
    "  var SOURCE = { package: 'simple-icons', versions: '" + iconVersions.join(', ') + "' };",
    "  var LICENSE = 'Simple Icons — CC0 1.0 Universal; знаки сервисов — товарные знаки их владельцев';",
    '  var CATEGORIES = ' + JSON.stringify(CATEGORIES.map((c) => ({ id: c.id, title: c.title }))) + ';',
    '  var SERVICES = ' + JSON.stringify(services) + ';',
    '  var BRANDS = ' + JSON.stringify(brandsObject) + ';',
    '  var MONOGRAMS = ' + JSON.stringify(monograms) + ';',
    '  var BY_ID = {};',
    '  for (var i = 0; i < SERVICES.length; i += 1) BY_ID[SERVICES[i].id] = SERVICES[i];',
    '  function service(id) { return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : null; }',
    '  function brand(id) { return Object.prototype.hasOwnProperty.call(BRANDS, id) ? BRANDS[id] : null; }',
    '  function monogram(id) { return Object.prototype.hasOwnProperty.call(MONOGRAMS, id) ? MONOGRAMS[id] : null; }',
    '  var api = {',
    '    generated: GENERATED,',
    '    source: SOURCE,',
    '    license: LICENSE,',
    '    categories: CATEGORIES,',
    '    services: SERVICES,',
    '    brands: BRANDS,',
    '    monograms: MONOGRAMS,',
    '    service: service,',
    '    brand: brand,',
    '    monogram: monogram,',
    '  };',
    "  if (typeof window !== 'undefined') window.NoxMcpLogos = api;",
    "  if (typeof module === 'object' && module.exports) module.exports = api;",
    '})();',
    '',
  ].join('\n');
  return header + '\n' + body;
}

async function main() {
  const wanted = [];
  for (const entry of CATALOG) {
    if (BRAND_SLUGS[entry.id]) wanted.push({ id: entry.id, slug: BRAND_SLUGS[entry.id] });
  }
  for (const extra of EXTRA_SERVICES) wanted.push(extra);
  const brands = await fetchBrands(wanted);
  const missing = wanted.filter((item) => !brands.has(item.id)).map((item) => item.id);
  if (missing.length === wanted.length) {
    console.error('fetch-mcp-logos: CDN недоступен, ни один значок не скачан. Файл не изменён.');
    process.exitCode = 1;
    return;
  }
  const catalogBrands = CATALOG.filter((entry) => brands.has(entry.id)).length;
  const text = buildFile(brands);
  const temp = OUT_FILE + '.tmp';
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, OUT_FILE);
  console.log('fetch-mcp-logos: значков ' + brands.size + ' из ' + wanted.length
    + ', монограмм ' + (CATALOG.length - catalogBrands));
  console.log('fetch-mcp-logos: записан ' + path.relative(process.cwd(), OUT_FILE));
  if (missing.length) console.log('fetch-mcp-logos: без значка (монограмма): ' + missing.join(', '));
}

main().catch((err) => {
  console.error('fetch-mcp-logos: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
