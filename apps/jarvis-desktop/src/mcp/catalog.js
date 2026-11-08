'use strict';

// Курируемый каталог MCP-серверов: только статические данные, без сети и без установки серверов.
// Смысл: вместо «40 тысяч» случайных записей — короткий список реальных серверов, у которых
// известны пакет/адрес и понятно, что они делают.
//
// Поля записи:
//   id          — имя сервиса в mcpServers (латиница в нижнем регистре, цифры, «-», «_», до 40);
//   title       — короткое имя для окна;
//   description — что делает сервер; у verified:false в тексте есть «не проверено»;
//   category    — один из CATEGORIES;
//   transport   — 'stdio' (запуск командой) или 'http' (адрес сервиса);
//   command/args — для stdio; url — для http;
//   envKeys     — ТОЛЬКО имена переменных окружения (значений здесь нет: их подставляет владелец);
//   docs        — ссылка на официальную страницу, если она надёжна;
//   verified    — true: имя пакета/адрес известны и не выдуманы; false: запись не проверена.
//
// Важно: запуск ни одного сервера на этой машине не проверялся, пакеты не ставились.
// verified:true означает «запись достоверна», а не «сервер проверен в работе».

const CATEGORIES = Object.freeze([
  { id: 'files', title: 'Файлы и терминал' },
  { id: 'git', title: 'Git и код' },
  { id: 'dev', title: 'Разработка' },
  { id: 'browser', title: 'Браузер' },
  { id: 'data', title: 'Базы данных' },
  { id: 'web', title: 'Поиск и интернет' },
  { id: 'ai', title: 'Знания и ИИ' },
  { id: 'productivity', title: 'Работа и связь' },
  { id: 'docs', title: 'Документы' },
  { id: 'design', title: 'Дизайн' },
  { id: 'payments', title: 'Оплата' },
]);
const CATEGORY_IDS = new Set(CATEGORIES.map((category) => category.id));
const CATEGORY_TITLES = new Map(CATEGORIES.map((category) => [category.id, category.title]));

// Сырые записи без значений секретов. Аргументы только простые: без кавычек и знаков оболочки,
// иначе клиент MCP (см. validateArgs в client.js) откажется их запускать.
const RAW = [
  {
    id: 'filesystem',
    title: 'Файлы',
    description: 'Чтение, запись и поиск файлов в разрешённой папке (официальный сервер MCP).',
    category: 'files',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    verified: true,
  },
  {
    id: 'desktop-commander',
    title: 'Командная строка',
    description: 'Терминал и файлы на компьютере: команды, чтение и правка (сторонний сервер Desktop Commander).',
    category: 'files',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@wonderwhy-er/desktop-commander@latest'],
    docs: 'https://www.npmjs.com/package/@wonderwhy-er/desktop-commander',
    verified: true,
  },
  {
    id: 'gdrive',
    title: 'Google Диск',
    description: 'Файлы Google Диска; запуск через uvx (Python), нужен вход в Google — не проверено.',
    category: 'files',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-gdrive'],
    verified: false,
  },
  {
    id: 'git',
    title: 'Git',
    description: 'Операции git в локальном репозитории: лог, diff, коммиты; запуск через uvx (Python).',
    category: 'git',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '.'],
    docs: 'https://pypi.org/project/mcp-server-git/',
    verified: true,
  },
  {
    id: 'github',
    title: 'GitHub',
    description: 'Задачи, пул-реквесты и код GitHub; облачный сервер, нужен токен GitHub — не проверено.',
    category: 'git',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    docs: 'https://github.com/github/github-mcp-server',
    verified: false,
  },
  {
    id: 'evidence-check',
    title: 'Проверочный сервер',
    description: 'Учебный сервер MCP со всеми типами возможностей: проверка подключения и инструментов (официальный).',
    category: 'dev',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    verified: true,
  },
  {
    id: 'kubernetes',
    title: 'Kubernetes',
    description: 'Кластер Kubernetes: pod, deployment, логи; нужен kubectl и права — не проверено.',
    category: 'dev',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'mcp-server-kubernetes'],
    verified: false,
  },
  {
    id: 'sentry',
    title: 'Sentry',
    description: 'Ошибки и релизы Sentry; нужен ключ SENTRY_AUTH_TOKEN, архивный сервер MCP.',
    category: 'dev',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-sentry'],
    envKeys: ['SENTRY_AUTH_TOKEN'],
    verified: true,
  },
  {
    id: 'time',
    title: 'Время',
    description: 'Текущее время и перевод между часовыми поясами (официальный сервер mcp-server-time); нужен uvx (Python).',
    category: 'dev',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    docs: 'https://pypi.org/project/mcp-server-time/',
    verified: true,
  },
  {
    id: 'playwright',
    title: 'Браузер Playwright',
    description: 'Управление настоящим браузером: страницы, клики, снимки экрана (официальный сервер Microsoft).',
    category: 'browser',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@playwright/mcp@latest'],
    docs: 'https://www.npmjs.com/package/@playwright/mcp',
    verified: true,
  },
  {
    id: 'puppeteer',
    title: 'Браузер Puppeteer',
    description: 'Браузер через Puppeteer: страницы и снимки; архивный сервер MCP.',
    category: 'browser',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
    verified: true,
  },
  {
    id: 'chrome-devtools',
    title: 'Chrome DevTools',
    description: 'Отладка сайта в Chrome: сеть, консоль, производительность (сервер Google).',
    category: 'browser',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    docs: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    verified: true,
  },
  {
    id: 'postgres',
    title: 'PostgreSQL',
    description: 'Запросы только на чтение к PostgreSQL; строка подключения — в аргументе, архивный сервер MCP.',
    category: 'data',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/postgres'],
    docs: 'https://www.npmjs.com/package/@modelcontextprotocol/server-postgres',
    verified: true,
  },
  {
    id: 'sqlite',
    title: 'SQLite',
    description: 'Запросы к файлу SQLite; путь к базе — в аргументе, запуск через uvx (Python).',
    category: 'data',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', './mcp-sqlite.db'],
    docs: 'https://pypi.org/project/mcp-server-sqlite/',
    verified: true,
  },
  {
    id: 'redis',
    title: 'Redis',
    description: 'Ключи Redis; адрес базы — в аргументе, запуск через uvx (Python) — не проверено.',
    category: 'data',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-redis', '--url', 'redis://localhost:6379'],
    verified: false,
  },
  {
    id: 'qdrant',
    title: 'Qdrant',
    description: 'Векторный поиск Qdrant; запуск через uvx (Python), официальный сервер Qdrant.',
    category: 'data',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-qdrant'],
    docs: 'https://pypi.org/project/mcp-server-qdrant/',
    verified: true,
  },
  {
    id: 'elasticsearch',
    title: 'Elasticsearch',
    description: 'Поиск и индексы Elasticsearch; адрес и ключ — в env ELASTICSEARCH_URL и ELASTICSEARCH_API_KEY — не проверено.',
    category: 'data',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@elastic/mcp-server-elasticsearch'],
    envKeys: ['ELASTICSEARCH_URL', 'ELASTICSEARCH_API_KEY'],
    verified: false,
  },
  {
    id: 'supabase',
    title: 'Supabase',
    description: 'Проект Supabase: таблицы, SQL, ветки; нужен ключ SUPABASE_ACCESS_TOKEN.',
    category: 'data',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@supabase/mcp-server-supabase@latest'],
    envKeys: ['SUPABASE_ACCESS_TOKEN'],
    docs: 'https://www.npmjs.com/package/@supabase/mcp-server-supabase',
    verified: true,
  },
  {
    id: 'fetch',
    title: 'Загрузка страниц',
    description: 'Загрузка веб-страниц и преобразование в текст; официальный сервер mcp-server-fetch, нужен uvx (Python).',
    category: 'web',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    docs: 'https://pypi.org/project/mcp-server-fetch/',
    verified: true,
  },
  {
    id: 'brave-search',
    title: 'Поиск Brave',
    description: 'Веб-поиск Brave; нужен ключ BRAVE_API_KEY, архивный сервер MCP.',
    category: 'web',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envKeys: ['BRAVE_API_KEY'],
    docs: 'https://www.npmjs.com/package/@modelcontextprotocol/server-brave-search',
    verified: true,
  },
  {
    id: 'exa',
    title: 'Поиск Exa',
    description: 'Поиск и чтение страниц через Exa; нужен ключ EXA_API_KEY.',
    category: 'web',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'exa-mcp-server'],
    envKeys: ['EXA_API_KEY'],
    docs: 'https://www.npmjs.com/package/exa-mcp-server',
    verified: true,
  },
  {
    id: 'firecrawl',
    title: 'Обход сайтов Firecrawl',
    description: 'Обход и разбор сайтов через Firecrawl; нужен ключ FIRECRAWL_API_KEY.',
    category: 'web',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'firecrawl-mcp'],
    envKeys: ['FIRECRAWL_API_KEY'],
    docs: 'https://www.npmjs.com/package/firecrawl-mcp',
    verified: true,
  },
  {
    id: 'tavily',
    title: 'Поиск Tavily',
    description: 'Веб-поиск Tavily; нужен ключ TAVILY_API_KEY.',
    category: 'web',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'tavily-mcp'],
    envKeys: ['TAVILY_API_KEY'],
    docs: 'https://www.npmjs.com/package/tavily-mcp',
    verified: true,
  },
  {
    id: 'google-maps',
    title: 'Google Карты',
    description: 'Места, адреса и маршруты Google Карт; нужен ключ GOOGLE_MAPS_API_KEY, архивный сервер MCP.',
    category: 'web',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    envKeys: ['GOOGLE_MAPS_API_KEY'],
    docs: 'https://www.npmjs.com/package/@modelcontextprotocol/server-google-maps',
    verified: true,
  },
  {
    id: 'memory',
    title: 'Память',
    description: 'Долгая память в виде графа знаний между запусками (официальный сервер MCP).',
    category: 'ai',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    verified: true,
  },
  {
    id: 'sequential-thinking',
    title: 'Рассуждения',
    description: 'Пошаговые рассуждения со структурой мыслей (официальный сервер MCP).',
    category: 'ai',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    verified: true,
  },
  {
    id: 'context7',
    title: 'Context7',
    description: 'Свежая документация библиотек и фреймворков для модели (сервер Upstash).',
    category: 'ai',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@upstash/context7-mcp'],
    docs: 'https://www.npmjs.com/package/@upstash/context7-mcp',
    verified: true,
  },
  {
    id: 'chart',
    title: 'Диаграммы',
    description: 'Построение диаграмм и графиков кода (сервер AntV).',
    category: 'ai',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@antv/mcp-server-chart'],
    docs: 'https://www.npmjs.com/package/@antv/mcp-server-chart',
    verified: true,
  },
  {
    id: 'notion',
    title: 'Notion',
    description: 'Страницы и базы Notion; облачный сервер, нужен вход в Notion — не проверено.',
    category: 'productivity',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    verified: false,
  },
  {
    id: 'linear',
    title: 'Linear',
    description: 'Задачи и проекты Linear; облачный сервер, нужен вход в Linear — не проверено.',
    category: 'productivity',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    verified: false,
  },
  {
    id: 'atlassian',
    title: 'Jira и Confluence',
    description: 'Задачи Jira и страницы Confluence; облачный сервер, нужен вход Atlassian — не проверено.',
    category: 'productivity',
    transport: 'http',
    url: 'https://mcp.atlassian.com/v1/sse',
    verified: false,
  },
  {
    id: 'slack',
    title: 'Slack',
    description: 'Сообщения и каналы Slack; нужны ключи SLACK_BOT_TOKEN и SLACK_TEAM_ID, архивный сервер MCP.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    docs: 'https://www.npmjs.com/package/@modelcontextprotocol/server-slack',
    verified: true,
  },
  {
    id: 'figma',
    title: 'Figma',
    description: 'Макеты Figma по ссылке; облачный сервер, нужен вход в Figma — не проверено.',
    category: 'design',
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
    verified: false,
  },
  {
    id: 'markitdown',
    title: 'Разбор документов',
    description: 'Преобразование PDF, Word и других файлов в текст (MarkItDown от Microsoft); нужен uvx (Python).',
    category: 'docs',
    transport: 'stdio',
    command: 'uvx',
    args: ['markitdown-mcp'],
    docs: 'https://pypi.org/project/markitdown-mcp/',
    verified: true,
  },
  {
    id: 'office-word',
    title: 'Word',
    description: 'Чтение и создание документов Word; сторонний сервер office-word-mcp-server — не проверено.',
    category: 'docs',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'office-word-mcp-server'],
    verified: false,
  },
  {
    id: 'stripe',
    title: 'Stripe',
    description: 'Платежи и клиенты Stripe; нужен ключ STRIPE_SECRET_KEY, режим проверки проверяйте сами.',
    category: 'payments',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@stripe/mcp'],
    envKeys: ['STRIPE_SECRET_KEY'],
    docs: 'https://www.npmjs.com/package/@stripe/mcp',
    verified: true,
  },
];

// ── строгая проверка: ошибка в данных должна падать при загрузке модуля, а не в окне владельца

const ALLOWED_KEYS = new Set(['id', 'title', 'description', 'category', 'transport', 'command', 'args', 'url', 'envKeys', 'docs', 'verified']);
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// Те же запреты, что у клиента MCP: иначе команда с аргументом не запустится.
const SHELL_META_RE = /[&|<>;`$%"'\r\n]/;
const TRANSPORTS = new Set(['stdio', 'http']);

function check(condition, message) {
  if (!condition) throw new Error(`каталог MCP: ${message}`);
}

function checkCommand(command, label) {
  check(typeof command === 'string' && command.trim() !== '', `${label}: нужна команда запуска`);
  check(command.length <= 400, `${label}: команда длиннее 400 знаков`);
  check(!CONTROL_RE.test(command), `${label}: в команде управляющий символ`);
  check(!SHELL_META_RE.test(command), `${label}: в команде недопустимый символ оболочки`);
}

function checkArgs(args, label) {
  check(Array.isArray(args), `${label}: args — список строк`);
  check(args.length <= 40, `${label}: аргументов больше 40`);
  let total = 0;
  for (const arg of args) {
    check(typeof arg === 'string' && arg !== '', `${label}: каждый аргумент — непустая строка`);
    check(arg.length <= 1000, `${label}: аргумент длиннее 1000 знаков`);
    check(!CONTROL_RE.test(arg), `${label}: в аргументе управляющий символ`);
    check(!SHELL_META_RE.test(arg), `${label}: в аргументе недопустимый символ оболочки`);
    total += arg.length;
  }
  check(total <= 4000, `${label}: аргументы длиннее 4000 знаков`);
}

function checkUrl(value, label) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 400, `${label}: нужен адрес до 400 знаков`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    check(false, `${label}: адрес не разобран`);
  }
  check(parsed.protocol === 'http:' || parsed.protocol === 'https:', `${label}: адрес только http:// или https://`);
  check(!parsed.username && !parsed.password, `${label}: в адресе не должно быть логина и пароля`);
}

// Проверка всего списка. Принимает произвольный массив — удобно проверять испорченные данные в тестах.
function validateCatalog(entries) {
  check(Array.isArray(entries) && entries.length > 0, 'нужен непустой список записей');
  const seenIds = new Set();
  const seenLaunch = new Set();
  entries.forEach((entry, index) => {
    const where = `запись №${index + 1}`;
    check(entry && typeof entry === 'object' && !Array.isArray(entry), `${where}: нужен объект`);
    // Неизвестное поле — ошибка: так опечатка не пронесёт мимо проверки значения секрета.
    for (const key of Object.keys(entry)) check(ALLOWED_KEYS.has(key), `${where}: неизвестное поле «${key}»`);
    const id = entry.id;
    check(typeof id === 'string' && ID_RE.test(id), `${where}: id — строчная латиница, цифры, «-» и «_», до 40 знаков`);
    check(!seenIds.has(id), `id «${id}» повторяется`);
    seenIds.add(id);
    check(typeof entry.title === 'string' && entry.title.trim() !== '' && entry.title.length <= 60, `${id}: title — непустая строка до 60 знаков`);
    check(typeof entry.description === 'string' && entry.description.trim() !== '' && entry.description.length <= 400, `${id}: description — непустая строка до 400 знаков`);
    check(CATEGORY_IDS.has(entry.category), `${id}: неизвестная категория «${entry.category}»`);
    check(TRANSPORTS.has(entry.transport), `${id}: transport — только stdio или http`);
    check(typeof entry.verified === 'boolean', `${id}: verified — true или false`);
    if (entry.docs !== undefined) checkUrl(entry.docs, `${id}.docs`);
    const args = entry.args === undefined ? [] : entry.args;
    const envKeys = entry.envKeys === undefined ? [] : entry.envKeys;

    if (entry.transport === 'stdio') {
      check(entry.url === undefined, `${id}: для stdio адрес не нужен`);
      checkCommand(entry.command, `${id}.command`);
      checkArgs(args, `${id}.args`);
    } else {
      check(entry.command === undefined, `${id}: для http команда не нужна`);
      check(entry.args === undefined || (Array.isArray(entry.args) && entry.args.length === 0), `${id}: для http аргументы не нужны`);
      check(entry.url !== undefined, `${id}: для http нужен адрес`);
      checkUrl(entry.url, `${id}.url`);
      check(envKeys.length === 0, `${id}: для http ключи окружения не задаются`);
    }
    check(Array.isArray(envKeys) && envKeys.length <= 16, `${id}: envKeys — список до 16 имён`);
    const envSeen = new Set();
    for (const key of envKeys) {
      check(typeof key === 'string' && ENV_KEY_RE.test(key), `${id}: недопустимое имя переменной окружения «${key}»`);
      check(!envSeen.has(key), `${id}: имя «${key}» повторяется`);
      envSeen.add(key);
      // Пометка для владельца: имя ключа должно быть видно в описании.
      check(entry.description.includes(key), `${id}: имя ключа ${key} не упомянуто в description`);
    }

    const launch = entry.transport === 'stdio'
      ? `stdio:${entry.command} ${args.join(' ')}`
      : `http:${entry.url}`;
    check(!seenLaunch.has(launch), `${id}: такой же запуск уже есть у другой записи`);
    seenLaunch.add(launch);
  });
  return true;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const normalized = RAW.map((entry) => ({
  ...entry,
  args: entry.args === undefined ? [] : entry.args,
  envKeys: entry.envKeys === undefined ? [] : entry.envKeys,
}));
validateCatalog(normalized);
const CATALOG = deepFreeze(normalized);
const BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));

// Сколько записей в каждой категории — для фильтра в окне.
const CATEGORY_COUNTS = new Map(CATEGORIES.map((category) => [category.id, 0]));
for (const entry of CATALOG) CATEGORY_COUNTS.set(entry.category, CATEGORY_COUNTS.get(entry.category) + 1);

// Список записей: без аргументов — все; {query, category} — фильтр по имени, описанию, категории,
// команде, аргументам и адресу. Регистр не важен, пустой результат — не ошибка.
function listCatalog(filter = {}) {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error('каталог MCP: фильтр — объект {query, category}');
  }
  const { query, category } = filter;
  if (query !== undefined && query !== null && typeof query !== 'string') {
    throw new Error('каталог MCP: query — строка');
  }
  if (category !== undefined && category !== null && typeof category !== 'string') {
    throw new Error('каталог MCP: category — строка');
  }
  const text = String(query || '').trim().toLowerCase();
  const cat = String(category || '').trim();
  const result = CATALOG.filter((entry) => {
    if (cat && cat !== 'all' && entry.category !== cat) return false;
    if (!text) return true;
    const haystack = [
      entry.id,
      entry.title,
      entry.description,
      CATEGORY_TITLES.get(entry.category) || '',
      entry.command || '',
      entry.args.join(' '),
      entry.url || '',
      entry.docs || '',
    ].join(' ').toLowerCase();
    return haystack.includes(text);
  });
  return Object.freeze(result);
}

// Категории для фильтра: id, подпись и число записей (пустых категорий нет).
function catalogCategories() {
  return Object.freeze(CATEGORIES.map((category) => Object.freeze({
    id: category.id,
    title: category.title,
    count: CATEGORY_COUNTS.get(category.id) || 0,
  })));
}

// Одна запись по id или null: окно не должно падать из-за неизвестного id.
function getCatalogEntry(id) {
  return typeof id === 'string' ? BY_ID.get(id) || null : null;
}

// Конфиг для mcpServers. Значения секретов не подставляются: env-ключи — пустые заглушки,
// которые владелец заполняет сам. Для http-серверов только адрес: токены — в заголовках при настройке.
function toServerConfig(entryOrId) {
  const id = typeof entryOrId === 'string' ? entryOrId : entryOrId && entryOrId.id;
  const entry = typeof id === 'string' ? BY_ID.get(id) : null;
  if (!entry) throw new Error('каталог MCP: неизвестная запись');
  if (entry.transport === 'stdio') {
    const config = { command: entry.command, args: entry.args.slice() };
    if (entry.envKeys.length) config.env = Object.fromEntries(entry.envKeys.map((key) => [key, '']));
    return config;
  }
  return { url: entry.url };
}

module.exports = {
  CATALOG,
  CATEGORIES,
  validateCatalog,
  listCatalog,
  catalogCategories,
  getCatalogEntry,
  toServerConfig,
};
