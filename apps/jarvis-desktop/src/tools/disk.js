'use strict';

// Инструменты диска: свободное место и советы по очистке (только чтение, без удаления).
// disk_cleanup_suggest показывает большие файлы только внутри разрешённых папок: рабочая папка,
// но никогда — папка данных и папка программы. Имена и размеры чужих файлов наружу не уходят.
const fs = require('fs');
const path = require('path');
const { runPowerShell } = require('./system');

const TIMEOUT_MS = 15000;
const MAX_FILES = 10;

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Категории для итога «по категориям»: только группы расширений, без догадок о содержимом.
const CATEGORY_BY_EXT = new Map([
  ['.exe', 'installers'], ['.msi', 'installers'], ['.msix', 'installers'], ['.appx', 'installers'],
  ['.iso', 'installers'], ['.dmg', 'installers'], ['.pkg', 'installers'],
  ['.zip', 'archives'], ['.rar', 'archives'], ['.7z', 'archives'], ['.tar', 'archives'],
  ['.gz', 'archives'], ['.bz2', 'archives'], ['.xz', 'archives'],
  ['.png', 'images'], ['.jpg', 'images'], ['.jpeg', 'images'], ['.gif', 'images'],
  ['.webp', 'images'], ['.bmp', 'images'], ['.svg', 'images'], ['.heic', 'images'], ['.tiff', 'images'],
  ['.mp4', 'video'], ['.mkv', 'video'], ['.avi', 'video'], ['.mov', 'video'],
  ['.webm', 'video'], ['.wmv', 'video'], ['.m4v', 'video'],
  ['.mp3', 'audio'], ['.wav', 'audio'], ['.flac', 'audio'], ['.aac', 'audio'], ['.ogg', 'audio'], ['.m4a', 'audio'],
  ['.pdf', 'documents'], ['.doc', 'documents'], ['.docx', 'documents'], ['.xls', 'documents'],
  ['.xlsx', 'documents'], ['.ppt', 'documents'], ['.pptx', 'documents'], ['.txt', 'documents'],
  ['.csv', 'documents'], ['.rtf', 'documents'], ['.md', 'documents'], ['.epub', 'documents'],
]);

const CATEGORY_TITLES = {
  installers: 'установщики',
  archives: 'архивы',
  images: 'картинки',
  video: 'видео',
  audio: 'звук',
  documents: 'документы',
  other: 'другое',
};

// Байты в понятный текст. Округление одно: десятые доли для МБ и ГБ.
function humanBytes(n) {
  const size = Number(n);
  if (!Number.isFinite(size) || size <= 0) return '0 Б';
  if (size >= GB) return `${(size / GB).toFixed(1)} ГБ`;
  if (size >= MB) return `${(size / MB).toFixed(1)} МБ`;
  if (size >= 1024) return `${Math.round(size / 1024)} КБ`;
  return `${Math.round(size)} Б`;
}

function categoryOf(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return CATEGORY_BY_EXT.get(ext) || 'other';
}

// Чистое суммирование ответа disk_cleanup_suggest: [{ path, sizeMB }] → байты, категории, крупные сверху.
// Ничего не читает и не удаляет. Мусорные входы (не массив, null, пустой путь, NaN/отрицательный размер)
// не ломают счёт: неизвестный размер считается нулём, а не выдуманной цифрой.
function summarizeCleanup(files) {
  const items = Array.isArray(files) ? files : [];
  const clean = [];
  let totalBytes = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const filePath = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!filePath) continue;
    const sizeMB = Number(raw.sizeMB);
    const sizeBytes = Number.isFinite(sizeMB) && sizeMB > 0 ? Math.round(sizeMB * MB) : 0;
    const category = categoryOf(filePath);
    totalBytes += sizeBytes;
    clean.push({
      path: filePath,
      sizeMB: sizeBytes / MB,
      sizeBytes,
      category,
      categoryTitle: CATEGORY_TITLES[category],
    });
  }
  clean.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path, 'ru'));
  const sums = new Map();
  for (const file of clean) {
    const group = sums.get(file.category) || { key: file.category, title: file.categoryTitle, count: 0, bytes: 0 };
    group.count += 1;
    group.bytes += file.sizeBytes;
    sums.set(file.category, group);
  }
  const categories = [...sums.values()]
    .sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key))
    .map((group) => ({ ...group, text: humanBytes(group.bytes) }));
  return {
    count: clean.length,
    totalBytes,
    totalMB: totalBytes / MB,
    totalGB: totalBytes / GB,
    totalText: humanBytes(totalBytes),
    categories,
    files: clean,
  };
}

// Папка программы: здесь main.js и src/. Смотреть её большие файлы нельзя ни в каком режиме.
const APP_DIR = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = path.resolve(APP_DIR, '..', '..');

function keyOf(p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p);
}

function isUnder(dir, abs) {
  const rel = path.relative(keyOf(dir), keyOf(abs));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Настоящий путь: у самого глубокого существующего предка раскрываем ссылки и junction, хвост добавляем как есть.
function realish(abs) {
  let probe = abs;
  const rest = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    rest.unshift(path.basename(probe));
    probe = parent;
  }
  try {
    return path.join(fs.realpathSync(probe), ...rest);
  } catch {
    return abs;
  }
}

// Папка данных по умолчанию — та же, что у приложения: NOX_DATA_DIR или <корень>/data.
function defaultDataDir() {
  return process.env.NOX_DATA_DIR || path.join(PROJECT_ROOT, 'data');
}

// Закрытые папки: папка программы и данные. Их пути не читаем — только сравниваем строки путей.
function denyDirs(options = {}) {
  const extra = Array.isArray(options.denyWrite) ? options.denyWrite : [defaultDataDir()];
  return [APP_DIR, ...extra]
    .filter((dir) => typeof dir === 'string' && dir.trim())
    .map((dir) => path.resolve(dir));
}

function boundsError(text) {
  const err = new Error(text);
  err.code = 'OUT_OF_BOUNDS';
  return err;
}

// Разрешённая папка для обзора: относительная — от рабочей папки, абсолютная — только внутри неё.
// Ссылки и junction раскрываются: папка внутри рабочей не должна вести наружу.
// «Полный доступ» (options.unrestricted или ctx.unrestricted/ctx.mode === 'full') шире, но папка данных
// и папка программы закрыты всегда.
function cleanupFolder(folder, ctx = {}, options = {}) {
  const unrestricted = options.unrestricted === true
    || (ctx && (ctx.unrestricted === true || ctx.mode === 'full'));
  const folderText = String(folder || '').trim();
  const base = typeof options.root === 'string' && options.root.trim()
    ? options.root
    : ctx && typeof ctx.workspace === 'string' ? ctx.workspace : '';
  let rootDir = '';
  let abs;
  if (unrestricted && path.isAbsolute(folderText)) {
    // Полный доступ: абсолютный путь можно указать прямо; закрытые папки проверяются ниже.
    abs = path.resolve(folderText);
    rootDir = base && String(base).trim() ? path.resolve(base) : abs;
  } else {
    if (!base || !String(base).trim()) throw boundsError('не знаю рабочую папку: смотрю большие файлы только внутри неё');
    rootDir = path.resolve(base);
    abs = path.resolve(rootDir, folderText);
  }
  if (!unrestricted) {
    if (!isUnder(rootDir, abs)) throw boundsError('папка вне рабочей: смотреть большие файлы можно только внутри рабочей папки');
    let realRoot;
    try {
      realRoot = fs.realpathSync(rootDir);
    } catch {
      throw boundsError('рабочая папка недоступна');
    }
    if (!isUnder(realRoot, realish(abs))) throw boundsError('путь ведёт за пределы рабочей папки (ссылка)');
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw boundsError('папки нет: смотреть нечего');
  }
  if (!stat.isDirectory()) throw boundsError('это не папка');
  // Папка данных и папка программы закрыты даже в полном доступе: заодно нельзя смотреть их предка
  // (иначе обзор корня показал бы и .env, и data, и исходники).
  const targets = [abs, realish(abs)];
  for (const dir of denyDirs(options)) {
    for (const target of targets) {
      if (isUnder(dir, target) || isUnder(target, dir)) throw boundsError('нельзя смотреть папку программы и её данные');
    }
  }
  return abs;
}

// Файл из ответа PowerShell оставляем, только если он действительно внутри разрешённой папки
// и не попал туда через ссылку или junction.
function fileAllowed(file, root, options = {}) {
  const abs = path.isAbsolute(String(file || '')) ? path.resolve(String(file)) : '';
  if (!abs) return false;
  const realRoot = realish(root);
  const realFile = realish(abs);
  if (!isUnder(realRoot, realFile)) return false;
  for (const dir of denyDirs(options)) {
    if (isUnder(dir, realFile) || isUnder(realFile, dir)) return false;
  }
  return true;
}

const DISK_FREE_SCRIPT = [
  "try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}",
  "$d = Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{n='FreeGB';e={[math]::Round($_.Free/1GB,2)}}, @{n='UsedGB';e={[math]::Round($_.Used/1GB,2)}}",
  "ConvertTo-Json -Compress -InputObject $d",
].join('\n');

function parseDrives(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((d) => ({
    drive: String(d.Name || ''),
    freeGB: Number(d.FreeGB) || 0,
    usedGB: Number(d.UsedGB) || 0,
  }));
}

const diskFreeSpace = {
  name: 'disk_free_space',
  description: 'Показать свободное место на дисках (только чтение).',
  risk: 'T0',
  parameters: { type: 'object', properties: {} },
  async run(args, ctx) {
    const signal = ctx && ctx.signal;
    const res = await runPowerShell(DISK_FREE_SCRIPT, {}, { timeoutMs: TIMEOUT_MS, signal });
    if (!res.ok) return { ok: false, summary: res.summary, data: {} };
    let drives;
    try { drives = parseDrives(res.data && res.data.stdout); }
    catch { return { ok: false, summary: 'не удалось разобрать диски', data: {} }; }
    const summary = drives.map((d) => `${d.drive}: ${d.freeGB} ГБ свободно`).join(', ');
    return { ok: true, summary: summary || 'нет данных', data: { drives } };
  },
};

// -LiteralPath: имя папки с [ ] или * не должно читаться как шаблон. Ссылки-файлы пропускаем.
const LARGE_FILES_SCRIPT = [
  "try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}",
  "$root = $env:JARVIS_ROOT",
  "Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |",
  "  Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |",
  "  Sort-Object Length -Descending | Select-Object -First 10 |",
  "  ForEach-Object { [pscustomobject]@{ path = $_.FullName; sizeMB = [math]::Round($_.Length/1MB,2) } } |",
  "  ConvertTo-Json -Compress",
].join('\n');

function diskCleanupSuggest(options = {}) {
  return {
    name: 'disk_cleanup_suggest',
    description: 'Показать 10 самых больших файлов в папке рабочей папки (только советы, без удаления). Папка данных и папка программы закрыты.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', minLength: 1, maxLength: 260 },
      },
      required: ['folder'],
    },
    async run(args = {}, ctx = {}) {
      const folder = String((args && args.folder) || '').trim();
      if (!folder) return { ok: false, summary: 'пустая папка', data: {} };
      let root;
      try {
        root = cleanupFolder(folder, ctx, options);
      } catch (err) {
        return { ok: false, summary: err.message, data: {} };
      }
      const signal = ctx && ctx.signal;
      const runner = typeof options.run === 'function' ? options.run : runPowerShell;
      const res = await runner(LARGE_FILES_SCRIPT, { JARVIS_ROOT: root }, { timeoutMs: TIMEOUT_MS, signal });
      if (!res.ok) return { ok: false, summary: res.summary, data: {} };
      let files;
      try {
        const text = String((res.data && res.data.stdout) || '').trim();
        const parsed = text ? JSON.parse(text) : [];
        files = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return { ok: false, summary: 'не удалось разобрать файлы', data: {} };
      }
      const listed = files
        .filter((f) => f && typeof f.path === 'string')
        .map((f) => ({ path: String(f.path), sizeMB: Number(f.sizeMB) || 0 }));
      const visible = listed.filter((f) => fileAllowed(f.path, root, options));
      const hidden = listed.length - visible.length;
      const top = visible.slice(0, MAX_FILES);
      const list = top.map((f) => `${f.path} (${f.sizeMB} МБ)`).join('; ');
      const note = hidden ? `; скрыто файлов вне разрешённых папок: ${hidden}` : '';
      // Итог для карточки: реальные байты и категории, без удаления и без догадок.
      const totals = summarizeCleanup(top);
      return {
        ok: true,
        summary: `найдено ${top.length} больших файлов${note}`,
        data: {
          folder: root,
          files: top,
          list,
          hidden,
          totalBytes: totals.totalBytes,
          totalText: totals.totalText,
          categories: totals.categories,
        },
      };
    },
  };
}

function diskTools(options = {}) {
  return [diskFreeSpace, diskCleanupSuggest(options)];
}

module.exports = {
  diskTools,
  parseDrives,
  cleanupFolder,
  fileAllowed,
  summarizeCleanup,
  humanBytes,
  categoryOf,
  LARGE_FILES_SCRIPT,
  CATEGORY_TITLES,
  MB,
  GB,
};
