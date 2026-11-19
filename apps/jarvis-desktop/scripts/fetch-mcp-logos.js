'use strict';

// Скачивает открытые значки Simple Icons (CC0 1.0) с CDN и собирает renderer/aether/mcp-logos.js:
// многоцветные слои SVG, палитры брендов, наши монограммы для утилит без значка и безопасный снимок каталога.
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
const ICON_VERSION = {
  slack: '15.0.0',
  heroku: '11.4.0',
  canva: '11.4.0',
  playwright: '11.4.0',
  microsoftazure: '11.4.0',
  microsoftexcel: '11.4.0',
  microsoftword: '11.4.0',
  microsoftpowerpoint: '11.4.0',
  amazonwebservices: '14.0.0',
};

// service id -> slug Simple Icons.
const BRAND_SLUGS = {
  gdrive: 'googledrive',
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

// Дополнительные значки для карточек вне каталога (почта, встроенный YouTube).
const EXTRA_SERVICES = [
  { id: 'gmail', slug: 'gmail' },
  { id: 'youtube', slug: 'youtube' },
];

// Векторные значки брендов, которых нет в нашем наборе Simple Icons.
const CUSTOM_VECTORS = {
  youtube: {
    slug: 'youtube',
    version: '16.0.0',
    path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814Z',
    bg: '#FFFFFF',
    layers: [
      { d: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814Z', fill: '#FF0000' },
      { d: 'M9.545 15.568V8.432L15.818 12l-6.273 3.568Z', fill: '#FFFFFF' },
    ],
  },
  qdrant: {
    slug: 'qdrant',
    version: '16.0.0',
    path: 'M12 1.5 21.1 6.75v10.5L12 22.5 2.9 17.25V6.75L12 1.5Zm0 4.2L6.5 8.88v6.24L12 18.3l5.5-3.18V8.88L12 5.7Z',
    bg: '#FFFFFF',
    layers: [
      { d: 'M12 1.5 21.1 6.75v10.5L12 22.5 2.9 17.25V6.75L12 1.5Zm0 4.2L6.5 8.88v6.24L12 18.3l5.5-3.18V8.88L12 5.7Z', fill: '#DC244C' },
      { d: 'M14.5 13.8 20.5 19.8 18 22.3 12 16.3Z', fill: '#9F1239' },
    ],
  },
  neon: {
    slug: 'neon-tech',
    version: '16.0.0',
    path: 'M5 4h3.4l6.2 8.8V4H18v16h-3.4L8.4 11.2V20H5V4Z',
    bg: '#0D1117',
    fg: '#00E599',
  },
  motherduck: {
    slug: 'motherduck',
    version: '16.0.0',
    path: 'M12.5 5a4.5 4.5 0 0 0-4.4 5.4c.1.6-.2 1.2-.8 1.5l-1.9.8c-1.1.5-1.6 1.8-1.1 2.9.6 1.5 2.2 2.4 4.7 2.4h6.2c2.8 0 4.8-1.9 4.8-4.5 0-2.1-1.3-3.7-3.2-4.2A4.5 4.5 0 0 0 12.5 5Z',
    bg: '#FFDE00',
    layers: [
      { d: 'M12.5 5a4.5 4.5 0 0 0-4.4 5.4c.1.6-.2 1.2-.8 1.5l-1.9.8c-1.1.5-1.6 1.8-1.1 2.9.6 1.5 2.2 2.4 4.7 2.4h6.2c2.8 0 4.8-1.9 4.8-4.5 0-2.1-1.3-3.7-3.2-4.2A4.5 4.5 0 0 0 12.5 5Z', fill: '#18181B' },
      { d: 'M5.4 10.6 2 11.5c-.5.1-.5.8 0 1l3.6.7.8-1.6-.9-1Z', fill: '#F97316' },
    ],
  },
  browserbase: {
    slug: 'browserbase',
    version: '16.0.0',
    path: 'M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 4v12h16V7H4Z',
    bg: '#FFFFFF',
    layers: [
      { d: 'M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 4v12h16V7H4Zm2-2.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Zm3 0a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z', fill: '#F93F2D' },
      { d: 'M7.5 11h9v2h-9v-2Zm0 3.5h6v2h-6v-2Z', fill: '#1F2937' },
    ],
  },
  exa: {
    slug: 'exa-ai',
    version: '16.0.0',
    path: 'M5 5h14v3.2H8.6v2.3h8.4v3H8.6v2.3H19V19H5V5Z',
    bg: '#1F40FF',
    fg: '#FFFFFF',
  },
  firecrawl: {
    slug: 'firecrawl',
    version: '16.0.0',
    path: 'M12 22c-4.4 0-8-3.4-8-7.8 0-3.2 1.8-5.7 4-7.8 1.5-1.4 2.7-2.8 2.9-4.4 2.8 1.5 4.9 4.1 5.6 7.4.9-.8 1.5-1.8 1.8-3 1.4 1.8 2.2 4 2.2 6.6 0 5-3.8 9-8.5 9Z',
    bg: '#FFF4ED',
    layers: [
      { d: 'M12 22c-4.4 0-8-3.4-8-7.8 0-3.2 1.8-5.7 4-7.8 1.5-1.4 2.7-2.8 2.9-4.4 2.8 1.5 4.9 4.1 5.6 7.4.9-.8 1.5-1.8 1.8-3 1.4 1.8 2.2 4 2.2 6.6 0 5-3.8 9-8.5 9Z', fill: '#FF4D00' },
      { d: 'M12 11.5c1.8 1.4 2.6 2.8 2.6 4.4a2.6 2.6 0 1 1-5.2 0c0-1.6.9-3 2.6-4.4Z', fill: '#FFB000' },
    ],
  },
  tavily: {
    slug: 'tavily',
    version: '16.0.0',
    path: 'M12 2 14.5 9.5 22 12 14.5 14.5 12 22 9.5 14.5 2 12 9.5 9.5Z',
    bg: '#FFFFFF',
    layers: [
      { d: 'M12 2 14.5 9.5 22 12 14.5 14.5 12 22 9.5 14.5 2 12 9.5 9.5Z', fill: '#0099FF' },
      { d: 'M18.5 4.5 19.6 7.4 22.5 8.5 19.6 9.6 18.5 12.5 17.4 9.6 14.5 8.5 17.4 7.4Z', fill: '#F59E0B' },
    ],
  },
  hackernews: {
    slug: 'ycombinator',
    version: '16.0.0',
    path: 'M6.5 4h2.9l2.6 5.6L14.6 4h2.9l-4.2 8.2V20h-2.6v-7.8L6.5 4Z',
    bg: '#FF6600',
    fg: '#FFFFFF',
  },
  context7: {
    slug: 'context7',
    version: '16.0.0',
    path: 'M7.2 6H12v2.4H8.8a2.2 2.2 0 0 0-2.2 2.2v2.8a2.2 2.2 0 0 0 2.2 2.2H12V18H7.2A4.6 4.6 0 0 1 2.6 13.4v-2.8A4.6 4.6 0 0 1 7.2 6Z',
    bg: '#0F172A',
    layers: [
      { d: 'M7.2 6H12v2.4H8.8a2.2 2.2 0 0 0-2.2 2.2v2.8a2.2 2.2 0 0 0 2.2 2.2H12V18H7.2A4.6 4.6 0 0 1 2.6 13.4v-2.8A4.6 4.6 0 0 1 7.2 6Z', fill: '#10B981' },
      { d: 'M13.5 6h8v2.4L17 18h-2.8l4.2-9.6h-4.9V6Z', fill: '#34D399' },
    ],
  },
  deepwiki: {
    slug: 'deepwiki',
    version: '16.0.0',
    path: 'M12 2.5 3.5 7.2v9.6L12 21.5l8.5-4.7V7.2L12 2.5Zm0 2.6 5.7 3.1L12 11.4 6.3 8.2 12 5.1Z',
    bg: '#FFFFFF',
    layers: [
      { d: 'M12 2.5 3.5 7.2v9.6L12 21.5l8.5-4.7V7.2L12 2.5Zm0 2.6 5.7 3.1L12 11.4 6.3 8.2 12 5.1Z', fill: '#0EA5E9' },
      { d: 'M5.5 10.1 11 13.1v5.9l-5.5-3.1v-5.8Zm13 0v5.8L13 19v-5.9l5.5-3Z', fill: '#0284C7' },
    ],
  },
  pandoc: {
    slug: 'pandoc',
    version: '16.0.0',
    path: 'M4 5h8v14H4V5Zm2 3v8h4V8H6Z',
    bg: '#FFFFFF',
    layers: [
      { d: 'M4 5h8v14H4V5Zm2 3v8h4V8H6Z', fill: '#2563EB' },
      { d: 'M14 5h6v14h-6v-3h3V8h-3V5Zm1.5 6.5-3.5 3v-2H9v-2h3v-2l3.5 3Z', fill: '#0D9488' },
    ],
  },
};

// Официальные палитры для одиночных и многослойных значков.
const BRAND_STYLES = {
  gdrive: { bg: '#FFFFFF', splitColors: ['#FFBA00', '#00AC47', '#2684FC'] },
  git: { bg: '#FFFFFF', fg: '#F05032' },
  github: { bg: '#181717', fg: '#FFFFFF', ring: 'dark' },
  'github-local': { bg: '#181717', fg: '#FFFFFF', ring: 'dark' },
  gitlab: {
    bg: '#FFFFFF',
    customLayers: (fullPath) => [
      { d: fullPath, fill: '#FCA326' },
      { d: 'M12 22.98 7.54 7.82H1.08L12 22.98ZM12 22.98l4.46-15.16h6.46L12 22.98Z', fill: '#FC6D26' },
      { d: 'M12 22.98 7.54 7.82h8.92L12 22.98ZM7.54 7.82 5.33 1.07a.86.86 0 0 0-1.62 0L1.08 7.82h6.46ZM16.46 7.82h6.46L20.3 1.07a.86.86 0 0 0-1.62 0l-2.22 6.75Z', fill: '#E24329' },
    ],
  },
  figma: {
    bg: '#1E1F26',
    ring: 'dark',
    customLayers: () => [
      { d: 'M8 0h4v8H8a4 4 0 1 1 0-8Z', fill: '#F24E1E' },
      { d: 'M12 0h4a4 4 0 1 1 0 8h-4V0Z', fill: '#FF7262' },
      { d: 'M8 8h4v8H8a4 4 0 1 1 0-8Z', fill: '#A259FF' },
      { d: 'M16 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z', fill: '#1ABCFE' },
      { d: 'M8 16h4v4a4 4 0 1 1-4-4Z', fill: '#0ACF83' },
    ],
  },
  gmail: {
    bg: '#FFFFFF',
    customLayers: () => [
      { d: 'M0 9.55v9.82C0 20.27.73 21 1.64 21h3.82v-9.27L0 7.64Z', fill: '#4285F4' },
      { d: 'M18.55 21h3.81c.91 0 1.64-.73 1.64-1.64V7.64l-5.45 4.09V21Z', fill: '#34A853' },
      { d: 'M5.45 11.73 12 16.64l6.55-4.91V4.64L12 9.55 5.45 4.64v7.09Z', fill: '#EA4335' },
      { d: 'M0 5.46v2.18l5.45 4.09V4.64L3.93 3.49C2.31 2.28 0 3.43 0 5.46Z', fill: '#C5221F' },
      { d: 'M18.55 4.64v7.09L24 7.64V5.46c0-2.02-2.31-3.18-3.93-1.96l-1.52 1.14Z', fill: '#FBBC04' },
    ],
  },
  sentry: { bg: '#362D59', fg: '#FFFFFF', ring: 'dark' },
  kubernetes: { bg: '#FFFFFF', fg: '#326CE5' },
  docker: { bg: '#FFFFFF', fg: '#1D63ED' },
  terraform: { bg: '#FFFFFF', fg: '#7B42BC' },
  azure: { bg: '#FFFFFF', fg: '#0078D4' },
  'aws-docs': { bg: '#232F3E', fg: '#FF9900', ring: 'dark' },
  netlify: { bg: '#FFFFFF', fg: '#00AD9F' },
  heroku: { bg: '#430098', fg: '#FFFFFF', ring: 'dark' },
  postman: { bg: '#FFFFFF', fg: '#FF6C37' },
  playwright: { bg: '#FFFFFF', splitMode: 'upperM', splitColors: ['#2EAD33', '#D65348'] },
  puppeteer: { bg: '#FFFFFF', fg: '#00B88C' },
  'chrome-devtools': { bg: '#FFFFFF', splitColors: ['#EA4335', '#34A853', '#FBBC05', '#4285F4'] },
  postgres: { bg: '#FFFFFF', fg: '#336791' },
  sqlite: { bg: '#FFFFFF', fg: '#003B57' },
  redis: { bg: '#FFFFFF', fg: '#DC382D' },
  elasticsearch: { bg: '#FFFFFF', splitColors: ['#FEC514', '#00BFB3', '#0077CC'] },
  supabase: { bg: '#18181B', fg: '#3ECF8E', ring: 'dark' },
  'supabase-remote': { bg: '#18181B', fg: '#3ECF8E', ring: 'dark' },
  mongodb: { bg: '#FFFFFF', fg: '#13AA52' },
  mysql: { bg: '#FFFFFF', fg: '#4479A1' },
  clickhouse: {
    bg: '#171717',
    ring: 'dark',
    customLayers: () => [
      { d: 'M0 22.67V1.33h2.67v21.34ZM5.33 1.33H8v21.34H5.33ZM10.67 1.33h2.66v21.34h-2.66ZM16 1.33h2.67v21.34H16Z', fill: '#FFCC01' },
      { d: 'M21.33 10H24v4h-2.67Z', fill: '#FF0000' },
    ],
  },
  neo4j: { bg: '#FFFFFF', fg: '#008CC1' },
  'brave-search': { bg: '#FFFFFF', fg: '#FB542B' },
  'google-maps': { bg: '#FFFFFF', splitMode: 'upperM', splitColors: ['#34A853', '#FBBC04', '#4285F4', '#1A73E8', '#EA4335'] },
  duckduckgo: { bg: '#FFFFFF', fg: '#DE5833' },
  arxiv: { bg: '#FFFFFF', fg: '#B31B1B' },
  wikipedia: { bg: '#FFFFFF', fg: '#18181B' },
  notion: { bg: '#FFFFFF', fg: '#111111' },
  'notion-local': { bg: '#FFFFFF', fg: '#111111' },
  linear: { bg: '#FFFFFF', fg: '#5E6AD2' },
  atlassian: { bg: '#FFFFFF', splitMode: 'upperM', splitColors: ['#2684FF', '#0052CC'] },
  'atlassian-local': { bg: '#FFFFFF', splitMode: 'upperM', splitColors: ['#2684FF', '#0052CC'] },
  slack: { bg: '#FFFFFF', splitMode: 'upperM', splitColors: ['#E01E5A', '#E01E5A', '#36C5F0', '#36C5F0', '#2EB67D', '#2EB67D', '#ECB22E', '#ECB22E'] },
  'slack-local': { bg: '#FFFFFF', splitMode: 'upperM', splitColors: ['#E01E5A', '#E01E5A', '#36C5F0', '#36C5F0', '#2EB67D', '#2EB67D', '#ECB22E', '#ECB22E'] },
  airtable: { bg: '#FFFFFF', splitMode: 'upperM', splitColors: ['#FCB400', '#18BFFF', '#F82B60'] },
  todoist: { bg: '#FFFFFF', fg: '#E44332' },
  asana: { bg: '#FFFFFF', fg: '#F06A6A' },
  'office-word': { bg: '#185ABD', fg: '#FFFFFF', ring: 'dark' },
  'office-powerpoint': { bg: '#C43E1C', fg: '#FFFFFF', ring: 'dark' },
  excel: { bg: '#107C41', fg: '#FFFFFF', ring: 'dark' },
  obsidian: { bg: '#1E1633', ring: 'dark', splitMode: 'upperM', splitColors: ['#A88BFA', '#7C3AED', '#5B21B6', '#C4B5FD'] },
  blender: {
    bg: '#FFFFFF',
    splitColors: ['#265787', '#EA7600', '#FFFFFF'],
  },
  canva: { bg: '#00C4CC', fg: '#FFFFFF', ring: 'dark' },
  stripe: { bg: '#635BFF', fg: '#FFFFFF', ring: 'dark' },
  'stripe-remote': { bg: '#635BFF', fg: '#FFFFFF', ring: 'dark' },
  paypal: { bg: '#FFFFFF', splitColors: ['#003087', '#0079C1', '#001C64'] },
  'cloudflare-docs': { bg: '#FFFFFF', splitColors: ['#F38020', '#FAAE40'] },
  'cloudflare-observability': { bg: '#FFFFFF', splitColors: ['#F38020', '#FAAE40'] },
  'cloudflare-radar': { bg: '#FFFFFF', splitColors: ['#F38020', '#FAAE40'] },
  discord: { bg: '#5865F2', fg: '#FFFFFF', ring: 'dark' },
  resend: { bg: '#09090B', fg: '#FFFFFF', ring: 'dark' },
};

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

function splitAbsoluteSubpaths(d, upperOnly) {
  const regex = upperOnly ? /(?=M)/ : /(?=[Mm])/;
  const parts = d.trim().split(regex).filter(Boolean);
  if (upperOnly) return parts.map((p) => p.trim());
  const out = [];
  let sx = 0;
  let sy = 0;
  for (const raw of parts) {
    const p = raw.trim();
    const m = p.match(/^([Mm])\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)[,\s]*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)(.*)$/);
    if (!m) { out.push(p); continue; }
    const x = parseFloat(m[2]);
    const y = parseFloat(m[3]);
    let rest = m[4].trim();
    if (m[1] === 'M') {
      sx = x;
      sy = y;
      out.push(p);
    } else {
      sx = +(sx + x).toFixed(4);
      sy = +(sy + y).toFixed(4);
      if (rest && /^[-+.\d]/.test(rest)) rest = 'l' + rest;
      out.push('M' + sx + ' ' + sy + (rest ? ' ' + rest : ''));
    }
  }
  return out;
}

function enrichBrand(id, baseBrand) {
  const art = BRAND_STYLES[id];
  if (!art) return baseBrand;
  const enriched = {
    slug: baseBrand.slug,
    version: baseBrand.version,
    path: baseBrand.path,
    bg: art.bg,
  };
  if (art.ring) enriched.ring = art.ring;
  if (typeof art.customLayers === 'function') {
    enriched.layers = art.customLayers(baseBrand.path);
  } else if (Array.isArray(art.splitColors)) {
    const parts = splitAbsoluteSubpaths(baseBrand.path, art.splitMode === 'upperM');
    if (parts.length === art.splitColors.length) {
      enriched.layers = parts.map((d, idx) => ({ d, fill: art.splitColors[idx] }));
    } else {
      enriched.fg = art.splitColors[0];
    }
  } else if (art.fg) {
    enriched.fg = art.fg;
  }
  return enriched;
}

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
      if (safePathData(data)) result.set(item.id, enrichBrand(item.id, { slug: item.slug, version, path: data }));
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
      : { url: entry.url.replace(/^https?:\/\//i, '') }),
    envKeys: entry.envKeys.slice(),
    ...(entry.docs ? { docs: entry.docs.replace(/^https?:\/\//i, '') } : {}),
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
  for (const [id, brand] of Array.from(brands.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    brandsObject[id] = brand;
  }
  const today = new Date().toISOString().slice(0, 10);
  const iconVersions = Array.from(new Set([DEFAULT_ICON_VERSION, ...Object.values(ICON_VERSION)])).sort();
  const header = [
    '/* Сгенерировано scripts/fetch-mcp-logos.js — вручную не править.',
    ' *',
    ' * Значки: Simple Icons, лицензия CC0 1.0 Universal (общественное достояние);',
    ' *   файл LICENSE.md лежит в репозитории Simple Icons.',
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
  const offlineCache = process.argv.includes('--offline') && fs.existsSync(OUT_FILE);
  const brands = new Map();
  if (offlineCache) {
    const existing = require(OUT_FILE);
    for (const [id, item] of Object.entries((existing && existing.brands) || {})) {
      if (id === 'windows-cli') continue;
      if (!CATALOG.some((e) => e.id === id) && !EXTRA_SERVICES.some((e) => e.id === id)) continue;
      brands.set(id, enrichBrand(id, item));
    }
    for (const [id, custom] of Object.entries(CUSTOM_VECTORS)) {
      brands.set(id, custom);
    }
  } else {
    const wanted = [];
    for (const entry of CATALOG) {
      if (BRAND_SLUGS[entry.id]) wanted.push({ id: entry.id, slug: BRAND_SLUGS[entry.id] });
    }
    for (const extra of EXTRA_SERVICES) {
      if (!CUSTOM_VECTORS[extra.id]) wanted.push(extra);
    }
    const downloaded = await fetchBrands(wanted);
    if (!downloaded.size) {
      console.error('fetch-mcp-logos: CDN недоступен, ни один значок не скачан. Файл не изменён.');
      process.exitCode = 1;
      return;
    }
    for (const [k, v] of downloaded) brands.set(k, v);
    for (const [id, custom] of Object.entries(CUSTOM_VECTORS)) brands.set(id, custom);
  }
  const catalogBrands = CATALOG.filter((entry) => brands.has(entry.id)).length;
  const text = buildFile(brands);
  const temp = OUT_FILE + '.tmp';
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, OUT_FILE);
  console.log('fetch-mcp-logos: значков ' + brands.size + ', в каталоге ' + catalogBrands + '/' + CATALOG.length
    + ', монограмм ' + (CATALOG.length - catalogBrands));
}

main().catch((err) => {
  console.error('fetch-mcp-logos: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
