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
//
// Каталог намеренно ограничен 80 записями: окно показывает их в «Дополнениях», а тест
// tests/mcp-catalog.test.js следит за размером, уникальностью и отсутствием значений секретов.

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
  { id: 'cloud', title: 'Облака и инфраструктура' },
  { id: 'social', title: 'Общение и рассылки' },
]);
const CATEGORY_IDS = new Set(CATEGORIES.map((category) => category.id));
const CATEGORY_TITLES = new Map(CATEGORIES.map((category) => [category.id, category.title]));

// Сырые записи без значений секретов. Аргументы только простые: без кавычек и знаков оболочки,
// иначе клиент MCP (см. validateArgs в client.js) откажется их запускать.
const RAW = [
  // ── files: файлы и терминал ─────────────────────────────────────
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
    id: 'commands',
    title: 'Команды терминала',
    description: 'Обычные команды терминала на компьютере с ограничением по папкам (сторонний сервер).',
    category: 'files',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'mcp-server-commands'],
    docs: 'https://github.com/g0t4/mcp-server-commands',
    verified: true,
  },
  {
    id: 'windows-cli',
    title: 'Команды Windows',
    description: 'Команды cmd и PowerShell с белым списком программ и рабочими папками — не проверено.',
    category: 'files',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@simonb97/server-win-cli'],
    verified: false,
  },

  // ── git: git и код ──────────────────────────────────────────────
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
    description: 'Задачи, пул-реквесты и код GitHub; облачный сервер, нужен вход в GitHub.',
    category: 'git',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    docs: 'https://github.com/github/github-mcp-server',
    verified: true,
  },
  {
    id: 'gitlab',
    title: 'GitLab',
    description: 'Проекты и merge request GitLab; нужен ключ GITLAB_PERSONAL_ACCESS_TOKEN, архивный сервер MCP.',
    category: 'git',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-gitlab'],
    envKeys: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab',
    verified: true,
  },
  {
    id: 'github-local',
    title: 'GitHub на компьютере',
    description: 'Репозитории и задачи GitHub с локальным запуском; нужен токен GITHUB_PERSONAL_ACCESS_TOKEN, архивный сервер MCP.',
    category: 'git',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    verified: true,
  },

  // ── dev: разработка ─────────────────────────────────────────────
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
    id: 'sentry',
    title: 'Sentry',
    description: 'Ошибки и релизы приложений; облачный сервер, нужен вход в Sentry.',
    category: 'dev',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    docs: 'https://mcp.sentry.dev/',
    verified: true,
  },
  {
    id: 'kubernetes',
    title: 'Kubernetes',
    description: 'Кластер Kubernetes: pod, deployment, логи; нужен kubectl и права (сторонний сервер).',
    category: 'dev',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'mcp-server-kubernetes'],
    docs: 'https://github.com/Flux159/mcp-server-kubernetes',
    verified: true,
  },
  {
    id: 'docker',
    title: 'Docker',
    description: 'Контейнеры Docker: список, запуск и логи; запуск через uvx (Python).',
    category: 'dev',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-docker'],
    docs: 'https://github.com/ckreiling/mcp-server-docker',
    verified: true,
  },
  {
    id: 'terraform',
    title: 'Terraform',
    description: 'Провайдеры и состояние Terraform (официальный сервер HashiCorp).',
    category: 'dev',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@hashicorp/terraform-mcp-server'],
    docs: 'https://github.com/hashicorp/terraform-mcp-server',
    verified: true,
  },
  {
    id: 'azure',
    title: 'Azure',
    description: 'Ресурсы Azure и справка по ним (сервер Microsoft).',
    category: 'dev',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@azure/mcp@latest', 'server', 'start'],
    docs: 'https://github.com/microsoft/mcp',
    verified: true,
  },
  {
    id: 'aws-docs',
    title: 'Документация AWS',
    description: 'Поиск по документации AWS (сервер AWS Labs); запуск через uvx (Python).',
    category: 'dev',
    transport: 'stdio',
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
    docs: 'https://github.com/awslabs/mcp',
    verified: true,
  },
  {
    id: 'netlify',
    title: 'Netlify',
    description: 'Сайты и деплои Netlify; нужен вход в Netlify — не проверено.',
    category: 'dev',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@netlify/mcp'],
    verified: false,
  },
  {
    id: 'heroku',
    title: 'Heroku',
    description: 'Приложения и базы Heroku; нужен вход в Heroku — не проверено.',
    category: 'dev',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@heroku/mcp-server'],
    verified: false,
  },
  {
    id: 'postman',
    title: 'Postman',
    description: 'Коллекции и запросы Postman; нужен ключ доступа — не проверено.',
    category: 'dev',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@postman/postman-mcp-server'],
    verified: false,
  },

  // ── browser: браузер ────────────────────────────────────────────
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
    id: 'browserbase',
    title: 'Облачный браузер Browserbase',
    description: 'Браузер в облаке Browserbase; нужны ключ BROWSERBASE_API_KEY и проект BROWSERBASE_PROJECT_ID — не проверено.',
    category: 'browser',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@browserbasehq/mcp'],
    envKeys: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
    verified: false,
  },
  {
    id: 'browser-tools',
    title: 'Наблюдение за вкладкой',
    description: 'Наблюдение за открытой вкладкой браузера и проверка вёрстки — не проверено.',
    category: 'browser',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@agentdeskai/browser-tools-mcp@latest'],
    verified: false,
  },

  // ── data: базы данных ───────────────────────────────────────────
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
    description: 'Векторный поиск Qdrant; адрес в QDRANT_URL, ключ в QDRANT_API_KEY, запуск через uvx (Python).',
    category: 'data',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-qdrant'],
    envKeys: ['QDRANT_URL', 'QDRANT_API_KEY'],
    docs: 'https://pypi.org/project/mcp-server-qdrant/',
    verified: true,
  },
  {
    id: 'elasticsearch',
    title: 'Elasticsearch',
    description: 'Поиск и индексы Elasticsearch; адрес в ELASTICSEARCH_URL, ключ в ELASTICSEARCH_API_KEY.',
    category: 'data',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@elastic/mcp-server-elasticsearch'],
    envKeys: ['ELASTICSEARCH_URL', 'ELASTICSEARCH_API_KEY'],
    docs: 'https://www.npmjs.com/package/@elastic/mcp-server-elasticsearch',
    verified: true,
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
    id: 'mongodb',
    title: 'MongoDB',
    description: 'Коллекции и документы MongoDB; строка подключения в MONGODB_URI (сервер MongoDB).',
    category: 'data',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'mongodb-mcp-server@latest'],
    envKeys: ['MONGODB_URI'],
    docs: 'https://github.com/mongodb-js/mongodb-mcp-server',
    verified: true,
  },
  {
    id: 'mysql',
    title: 'MySQL',
    description: 'Запросы к MySQL; имена подключения — MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE; через uvx (Python) — не проверено.',
    category: 'data',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-mysql'],
    envKeys: ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'],
    verified: false,
  },
  {
    id: 'clickhouse',
    title: 'ClickHouse',
    description: 'Аналитические запросы ClickHouse; адрес в CLICKHOUSE_HOST, логин в CLICKHOUSE_USER, пароль в CLICKHOUSE_PASSWORD.',
    category: 'data',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@clickhouse/mcp-clickhouse'],
    envKeys: ['CLICKHOUSE_HOST', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD'],
    docs: 'https://github.com/ClickHouse/mcp-clickhouse',
    verified: true,
  },
  {
    id: 'neon',
    title: 'Neon',
    description: 'Проекты и ветки Neon: база PostgreSQL в облаке; нужен ключ NEON_API_KEY.',
    category: 'data',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@neondatabase/mcp-server-neon'],
    envKeys: ['NEON_API_KEY'],
    docs: 'https://github.com/neondatabase/mcp-server-neon',
    verified: true,
  },
  {
    id: 'motherduck',
    title: 'MotherDuck',
    description: 'Аналитика DuckDB в MotherDuck; нужен токен MOTHERDUCK_TOKEN — не проверено.',
    category: 'data',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-motherduck'],
    envKeys: ['MOTHERDUCK_TOKEN'],
    verified: false,
  },
  {
    id: 'neo4j',
    title: 'Neo4j',
    description: 'Запросы к графовой базе Neo4j; адрес в NEO4J_URL, логин в NEO4J_USERNAME, пароль в NEO4J_PASSWORD — не проверено.',
    category: 'data',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-neo4j-cypher'],
    envKeys: ['NEO4J_URL', 'NEO4J_USERNAME', 'NEO4J_PASSWORD'],
    verified: false,
  },

  // ── web: поиск и интернет ───────────────────────────────────────
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
    id: 'duckduckgo',
    title: 'Поиск DuckDuckGo',
    description: 'Веб-поиск и новости DuckDuckGo без ключа; запуск через uvx (Python) — не проверено.',
    category: 'web',
    transport: 'stdio',
    command: 'uvx',
    args: ['duckduckgo-mcp-server'],
    verified: false,
  },
  {
    id: 'hackernews',
    title: 'Hacker News',
    description: 'Лента и обсуждения Hacker News — не проверено.',
    category: 'web',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'mcp-hn'],
    verified: false,
  },

  // ── ai: знания и ИИ ─────────────────────────────────────────────
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
    id: 'arxiv',
    title: 'Статьи arXiv',
    description: 'Поиск статей arXiv и чтение аннотаций; запуск через uvx (Python) — не проверено.',
    category: 'ai',
    transport: 'stdio',
    command: 'uvx',
    args: ['arxiv-mcp-server'],
    verified: false,
  },
  {
    id: 'wikipedia',
    title: 'Wikipedia',
    description: 'Статьи Wikipedia на разных языках; запуск через uvx (Python) — не проверено.',
    category: 'ai',
    transport: 'stdio',
    command: 'uvx',
    args: ['wikipedia-mcp'],
    verified: false,
  },
  {
    id: 'deepwiki',
    title: 'DeepWiki',
    description: 'Ответы по репозиториям на основе DeepWiki; облачный сервер — не проверено.',
    category: 'ai',
    transport: 'http',
    url: 'https://mcp.deepwiki.com/mcp',
    verified: false,
  },

  // ── productivity: работа и связь ────────────────────────────────
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
    id: 'notion-local',
    title: 'Notion на компьютере',
    description: 'Страницы и базы Notion с локальным запуском; нужен ключ NOTION_TOKEN.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@notionhq/notion-mcp-server'],
    envKeys: ['NOTION_TOKEN'],
    docs: 'https://github.com/makenotion/notion-mcp-server',
    verified: true,
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
    id: 'atlassian-local',
    title: 'Jira на компьютере',
    description: 'Jira с локальным запуском через uvx (Python): адрес JIRA_URL, логин JIRA_USERNAME, ключ JIRA_API_TOKEN.',
    category: 'productivity',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-atlassian'],
    envKeys: ['JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN'],
    docs: 'https://github.com/sooperset/mcp-atlassian',
    verified: true,
  },
  {
    id: 'slack',
    title: 'Slack',
    description: 'Каналы и сообщения Slack; облачный сервер, нужен вход в Slack — не проверено.',
    category: 'productivity',
    transport: 'http',
    url: 'https://mcp.slack.com/mcp',
    verified: false,
  },
  {
    id: 'slack-local',
    title: 'Slack на компьютере',
    description: 'Сообщения и каналы Slack с локальным запуском; нужны ключи SLACK_BOT_TOKEN и SLACK_TEAM_ID, архивный сервер MCP.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    docs: 'https://www.npmjs.com/package/@modelcontextprotocol/server-slack',
    verified: true,
  },
  {
    id: 'airtable',
    title: 'Airtable',
    description: 'Таблицы Airtable; нужен ключ AIRTABLE_API_KEY — не проверено.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'airtable-mcp-server'],
    envKeys: ['AIRTABLE_API_KEY'],
    verified: false,
  },
  {
    id: 'todoist',
    title: 'Todoist',
    description: 'Задачи и проекты Todoist; нужен ключ TODOIST_API_TOKEN — не проверено.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@doist/todoist-mcp'],
    envKeys: ['TODOIST_API_TOKEN'],
    verified: false,
  },
  {
    id: 'asana',
    title: 'Asana',
    description: 'Задачи и проекты Asana; облачный сервер, нужен вход в Asana — не проверено.',
    category: 'productivity',
    transport: 'http',
    url: 'https://mcp.asana.com/sse',
    verified: false,
  },

  // ── docs: документы ─────────────────────────────────────────────
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
    id: 'office-powerpoint',
    title: 'PowerPoint',
    description: 'Чтение и создание презентаций PowerPoint; сторонний сервер — не проверено.',
    category: 'docs',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'office-powerpoint-mcp-server'],
    verified: false,
  },
  {
    id: 'excel',
    title: 'Excel',
    description: 'Таблицы Excel: чтение и запись листов; сторонний сервер — не проверено.',
    category: 'docs',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'excel-mcp-server'],
    verified: false,
  },
  {
    id: 'pandoc',
    title: 'Pandoc',
    description: 'Преобразование документов между форматами через Pandoc; запуск через uvx (Python).',
    category: 'docs',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-pandoc'],
    docs: 'https://github.com/vivekVells/mcp-pandoc',
    verified: true,
  },
  {
    id: 'obsidian',
    title: 'Заметки Obsidian',
    description: 'Заметки Obsidian через локальный API; нужен ключ OBSIDIAN_API_KEY — не проверено.',
    category: 'docs',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-obsidian'],
    envKeys: ['OBSIDIAN_API_KEY'],
    verified: false,
  },

  // ── design: дизайн ──────────────────────────────────────────────
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
    id: 'blender',
    title: 'Blender',
    description: 'Управление Blender через локальное дополнение; запуск через uvx (Python).',
    category: 'design',
    transport: 'stdio',
    command: 'uvx',
    args: ['blender-mcp'],
    docs: 'https://github.com/ahujasid/blender-mcp',
    verified: true,
  },
  {
    id: 'canva',
    title: 'Canva',
    description: 'Макеты и шаблоны Canva; облачный сервер, нужен вход в Canva — не проверено.',
    category: 'design',
    transport: 'http',
    url: 'https://mcp.canva.com/mcp',
    verified: false,
  },

  // ── payments: оплата ────────────────────────────────────────────
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
  {
    id: 'stripe-remote',
    title: 'Stripe в облаке',
    description: 'Платежи Stripe через облачный сервер; нужен вход в Stripe — не проверено.',
    category: 'payments',
    transport: 'http',
    url: 'https://mcp.stripe.com',
    verified: false,
  },
  {
    id: 'paypal',
    title: 'PayPal',
    description: 'Платежи PayPal; ключи PAYPAL_CLIENT_ID и PAYPAL_CLIENT_SECRET — не проверено.',
    category: 'payments',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@paypal/mcp'],
    envKeys: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
    verified: false,
  },

  // ── cloud: облака и инфраструктура ──────────────────────────────
  {
    id: 'cloudflare-docs',
    title: 'Документация Cloudflare',
    description: 'Поиск по документации Cloudflare; публичный облачный сервер — не проверено.',
    category: 'cloud',
    transport: 'http',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    verified: false,
  },
  {
    id: 'cloudflare-observability',
    title: 'Наблюдение Cloudflare',
    description: 'Логи и метрики Cloudflare через облачный сервер — не проверено.',
    category: 'cloud',
    transport: 'http',
    url: 'https://observability.mcp.cloudflare.com/mcp',
    verified: false,
  },
  {
    id: 'cloudflare-radar',
    title: 'Данные Cloudflare Radar',
    description: 'Публичные данные Cloudflare Radar через облачный сервер — не проверено.',
    category: 'cloud',
    transport: 'http',
    url: 'https://radar.mcp.cloudflare.com/mcp',
    verified: false,
  },
  {
    id: 'supabase-remote',
    title: 'Supabase в облаке',
    description: 'Проект Supabase через облачный сервер; нужен вход в Supabase — не проверено.',
    category: 'cloud',
    transport: 'http',
    url: 'https://mcp.supabase.com/mcp',
    verified: false,
  },

  // ── social: общение и рассылки ──────────────────────────────────
  {
    id: 'discord',
    title: 'Discord',
    description: 'Каналы и сообщения Discord; нужен токен DISCORD_TOKEN — не проверено.',
    category: 'social',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'mcp-discord'],
    envKeys: ['DISCORD_TOKEN'],
    verified: false,
  },
  {
    id: 'resend',
    title: 'Письма Resend',
    description: 'Отправка писем через Resend; нужен ключ RESEND_API_KEY — не проверено.',
    category: 'social',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'resend-mcp'],
    envKeys: ['RESEND_API_KEY'],
    verified: false,
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
const MAX_ENTRIES = 80;

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
  check(entries.length <= MAX_ENTRIES, `записей ${entries.length}, допустимо не больше ${MAX_ENTRIES}`);
  const seenIds = new Set();
  const seenLaunch = new Set();
  entries.forEach((entry, index) => {
    const where = `запись №${index + 1}`;
    check(entry && typeof entry === 'object' && !Array.isArray(entry), `${where}: нужен объект`);
    // Неизвестное поле — ошибка: так опечатка не пронесёт мимо проверки значение секрета.
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
      // Команда запуска — только те установщики, которые есть у нас без отдельных пакетов.
      check(['npx.cmd', 'uvx'].includes(entry.command), `${id}: команда запуска только npx.cmd или uvx`);
      if (entry.command === 'npx.cmd') check(args[0] === '-y', `${id}: для npx первым аргументом должно быть -y`);
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

// Короткий список «Популярных» для окна подключений: внешние сервисы, с которыми владелец
// будет входить в аккаунт. Остальные записи каталога окно показывает в общем списке.
const FEATURED = deepFreeze([
  { ...BY_ID.get('github'), description: 'Репозитории, задачи и pull request.', accountKey: 'NOX_GITHUB_TOKEN' },
  { id: 'gmail', title: 'Gmail', description: 'Почта Google через вход в браузере.', integration: 'mail', category: 'productivity', envKeys: [] },
  { ...BY_ID.get('linear'), description: 'Задачи и проекты команды.', docs: 'https://linear.app/docs/mcp', accountKey: 'NOX_LINEAR_TOKEN' },
  { ...BY_ID.get('notion'), description: 'Страницы и базы рабочего пространства.', docs: 'https://www.notion.com/help/notion-mcp' },
  { ...BY_ID.get('figma'), description: 'Макеты и компоненты Figma.', docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/' },
  { ...BY_ID.get('slack'), title: 'Slack', description: 'Каналы и сообщения Slack.', docs: 'https://docs.slack.dev/ai/slack-mcp-server' },
  { ...BY_ID.get('sentry'), title: 'Sentry', description: 'Ошибки и релизы приложений.', docs: 'https://mcp.sentry.dev/' },
]);

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
  FEATURED,
  MAX_ENTRIES,
  validateCatalog,
  listCatalog,
  catalogCategories,
  getCatalogEntry,
  toServerConfig,
};
