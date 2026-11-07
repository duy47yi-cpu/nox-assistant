'use strict';

// Список установленных программ владельца. Читает реестр «Программы и компоненты» и ярлыки меню «Пуск».
// Ничего не запускает и не меняет. Вызывается только после согласия владельца (см. main.js).
// Список хранится локально в data/apps.json; в запрос к модели уходят только короткие сводки по категориям.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const MAX_ENTRIES = 2000;
const SCAN_TIMEOUT_MS = 90000;
const SUMMARY_LIMIT = 8;

// Скрипт фиксированный: пользовательский текст в него не подставляется. Результат пишет в файл из переменной
// окружения JARVIS_INV_OUT, потому что вывод PowerShell обрезается до 8000 символов.
const SCAN_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$items = New-Object System.Collections.ArrayList',
  '$roots = @(',
  '  "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",',
  '  "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",',
  '  "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"',
  ')',
  'foreach ($root in $roots) {',
  '  Get-ChildItem -Path $root | ForEach-Object {',
  '    $p = Get-ItemProperty -Path $_.PSPath',
  '    if ($p.DisplayName) {',
  '      [void]$items.Add([pscustomobject]@{ name = [string]$p.DisplayName; path = [string]$p.InstallLocation; source = "uninstall" })',
  '    }',
  '  }',
  '}',
  '$shell = New-Object -ComObject WScript.Shell',
  '$menus = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")',
  'foreach ($menu in $menus) {',
  '  Get-ChildItem -Path $menu -Filter "*.lnk" -Recurse | ForEach-Object {',
  '    $target = $shell.CreateShortcut($_.FullName).TargetPath',
  '    [void]$items.Add([pscustomobject]@{ name = $_.BaseName; path = [string]$target; source = "startmenu" })',
  '  }',
  '}',
  'ConvertTo-Json -InputObject @($items) -Depth 3 -Compress | Set-Content -LiteralPath $env:JARVIS_INV_OUT -Encoding UTF8',
].join('\n');

// Категории для сводки. Порядок важен: первое совпадение побеждает.
const CATEGORIES = [
  ['browser', /librewolf|firefox|chrome|msedge|microsoft edge|opera|vivaldi|brave|tor browser|venator|яндекс\.?\s*браузер/i],
  ['music', /spotify|aimp|foobar|winamp|vlc|musicbee|yandex music|яндекс\.?\s*музык|youtube music|deezer/i],
  ['messenger', /telegram|ayugram|discord|whatsapp|viber|signal|skype/i],
  ['game', /steam|epic games|battle\.net|riot|league of legends|counter-strike|\bcs2\b/i],
  ['creative', /davinci|premiere|obs studio|handbrake|blender|photoshop|audacity/i],
];

function category(name) {
  const hit = CATEGORIES.find(([, re]) => re.test(name));
  return hit ? hit[0] : null;
}

// Приводит запись к виду {name, path, source}. Пустые и битые записи отбрасываются.
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;
  const target = String(raw.path || '').trim();
  return { name, path: target || null, source: raw.source === 'startmenu' ? 'startmenu' : 'uninstall' };
}

// Разбирает JSON из файла. ConvertTo-Json для одного элемента даёт объект, а не массив: приводим к массиву.
function parseScan(text) {
  let data;
  try {
    data = JSON.parse(String(text || '').replace(/^﻿/, '') || '[]');
  } catch {
    return null;
  }
  const list = Array.isArray(data) ? data : [data];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const item = normalizeItem(raw);
    if (!item) continue;
    const key = `${item.name.toLowerCase()}|${(item.path || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

class AppInventory {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.scannedAt = null;
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.entries = (Array.isArray(data.items) ? data.items : []).map(normalizeItem).filter(Boolean);
      this.scannedAt = typeof data.scannedAt === 'string' ? data.scannedAt : null;
    } catch {
      this.entries = [];
      this.scannedAt = null;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body = { scannedAt: this.scannedAt, items: this.entries };
    fs.writeFileSync(this.file, JSON.stringify(body, null, 2), 'utf8');
  }

  // Читает список через runPS (runPowerShell из tools/system.js). Возвращает {ok, count} или {ok:false, error}.
  async scan(runPS) {
    const out = path.join(os.tmpdir(), `jarvis-apps-${randomUUID()}.json`);
    const res = await runPS(SCAN_SCRIPT, { JARVIS_INV_OUT: out }, { timeoutMs: SCAN_TIMEOUT_MS });
    try {
      if (!res.ok) return { ok: false, error: res.summary || 'неизвестная ошибка' };
      const items = parseScan(fs.readFileSync(out, 'utf8'));
      if (!items) return { ok: false, error: 'не разобрал результат' };
      this.entries = items;
      this.scannedAt = new Date().toISOString();
      this.save();
      return { ok: true, count: items.length };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      fs.rmSync(out, { force: true });
    }
  }

  clear() {
    this.entries = [];
    this.scannedAt = null;
    fs.rmSync(this.file, { force: true });
  }

  // Программы, в названии которых есть запрос (без учёта регистра). Точное совпадение идёт первым.
  find(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return this.entries
      .filter((e) => e.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q));
  }

  // Путь к exe для запуска по имени или null: если у записи есть .exe, запускаем его напрямую.
  resolveExe(query) {
    const hit = this.find(query).find((e) => e.path && /\.exe$/i.test(e.path));
    return hit ? hit.path : null;
  }

  has(pattern) {
    return this.entries.some((e) => pattern.test(e.name));
  }

  // Сводка по категориям для системного промпта: какие браузеры, музыка, мессенджеры и игры есть.
  summary() {
    if (!this.scannedAt) return null;
    const groups = {};
    for (const e of this.entries) {
      const cat = category(e.name);
      if (!cat) continue;
      (groups[cat] = groups[cat] || new Set()).add(e.name);
    }
    const pick = (cat) => [...(groups[cat] || [])].slice(0, SUMMARY_LIMIT);
    return {
      browser: pick('browser'),
      music: pick('music'),
      messenger: pick('messenger'),
      game: pick('game'),
      creative: pick('creative'),
      total: this.entries.length,
    };
  }
}

module.exports = { AppInventory, SCAN_SCRIPT, parseScan, category, normalizeItem };
