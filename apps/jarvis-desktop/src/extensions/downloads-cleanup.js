'use strict';

// Уборка папки загрузок. Главное правило: анализ и предпросмотр ничего не удаляют.
// Удаление — отдельная функция remove(), только по confirm === true, только обычные файлы
// внутри указанной папки: абсолютные пути, «..», ссылки и junction за границу папки отклоняются.
// Пустая папка — не ошибка, а состояние empty. Любой отказ объясняется словами.
// Ввод-вывод синхронный, fs и часы внедряются: тесты идут на временных папках.
const nodeFs = require('fs');
const nodePath = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const GB = 1024 * MB;
const DEFAULT_MIN_AGE_DAYS = 30;
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_DEPTH = 3;
const MAX_CANDIDATES = 200;

// Временные и незавершённые загрузки: их можно предлагать к уборке независимо от возраста.
const TEMP_EXT = new Set(['.tmp', '.temp', '.part', '.crdownload', '.partial', '.download', '.incomplete']);

const TYPE_BY_EXT = new Map([
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

const TYPE_TITLES = {
  installers: 'установщики',
  archives: 'архивы',
  images: 'картинки',
  video: 'видео',
  audio: 'звук',
  documents: 'документы',
  temp: 'временные',
  other: 'другое',
};

const SIZE_TITLES = { small: 'маленькие', medium: 'средние', large: 'большие', huge: 'очень большие' };
const AGE_TITLES = { fresh: 'свежие', week: 'до месяца', month: 'до полугода', old: 'старше полугода' };

function humanBytes(n) {
  const size = Number(n) || 0;
  if (size >= GB) return `${(size / GB).toFixed(1)} ГБ`;
  if (size >= MB) return `${(size / MB).toFixed(1)} МБ`;
  if (size >= 1024) return `${Math.round(size / 1024)} КБ`;
  return `${size} Б`;
}

function classifyType(name, extname = nodePath.extname) {
  const ext = String(extname(name) || '').toLowerCase();
  if (TEMP_EXT.has(ext)) return 'temp';
  return TYPE_BY_EXT.get(ext) || 'other';
}

function sizeBucket(bytes) {
  const size = Number(bytes) || 0;
  if (size >= GB) return 'huge';
  if (size >= 100 * MB) return 'large';
  if (size >= MB) return 'medium';
  return 'small';
}

function ageBucket(days) {
  const value = Number(days) || 0;
  if (value >= 180) return 'old';
  if (value >= 30) return 'month';
  if (value >= 7) return 'week';
  return 'fresh';
}

function addToGroup(groups, key, item) {
  if (!groups[key]) groups[key] = { count: 0, bytes: 0 };
  groups[key].count += 1;
  groups[key].bytes += item.size;
}

function relativeInside(root, abs, path) {
  const rel = path.relative(root, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Обход папки только на чтение. Ссылки и junction не раскрываются: они пропускаются.
function walk(root, { fs, path, maxDepth, maxFiles }) {
  const files = [];
  const issues = [];
  const queue = [{ dir: root, depth: 0 }];
  let dirs = 0;
  let linksSkipped = 0;
  let dirsSkipped = 0;
  let truncated = false;

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      issues.push({ path: path.basename(dir), reason: `папка не прочитана: ${String((err && err.code) || 'ошибка')}` });
      continue;
    }
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        linksSkipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        dirs += 1;
        if (depth >= maxDepth) {
          dirsSkipped += 1;
          continue;
        }
        queue.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (err) {
        issues.push({ path: entry.name, reason: `файл не прочитан: ${String((err && err.code) || 'ошибка')}` });
        continue;
      }
      files.push({
        abs,
        path: path.relative(root, abs),
        name: entry.name,
        size: Number(stat.size) || 0,
        mtimeMs: Number(stat.mtimeMs) || 0,
      });
    }
    if (truncated) break;
  }
  return { files, issues, dirs, linksSkipped, dirsSkipped, truncated };
}

/**
 * Анализ папки загрузок. Только чтение: ни один файл не меняется и не удаляется.
 * folder — абсолютный путь к папке загрузок (интегратор берёт его у системы).
 * options: {fs, path, now, minAgeDays, maxFiles, maxDepth, maxCandidates}.
 */
function analyze(folder, options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const minAgeDays = Number.isInteger(options.minAgeDays) && options.minAgeDays >= 0
    ? options.minAgeDays
    : DEFAULT_MIN_AGE_DAYS;
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES;
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const maxCandidates = Number.isInteger(options.maxCandidates) && options.maxCandidates > 0
    ? options.maxCandidates
    : MAX_CANDIDATES;

  const folderText = String(folder ?? '').trim();
  if (!folderText) return { ok: false, reason: 'folder_required', message: 'не указана папка загрузок' };
  const root = path.resolve(folderText);
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return { ok: false, reason: 'not_found', message: `папки загрузок нет: ${root}` };
  }
  if (!stat.isDirectory()) return { ok: false, reason: 'not_directory', message: 'это не папка' };

  const walked = walk(root, { fs, path, maxDepth, maxFiles });
  const groups = { byAge: {}, byType: {}, bySize: {} };
  let totalBytes = 0;
  const candidates = [];
  let candidateBytes = 0;

  for (const file of walked.files) {
    const ageDays = Math.max(0, Math.floor((nowMs - file.mtimeMs) / DAY_MS));
    const type = classifyType(file.name, path.extname);
    const age = ageBucket(ageDays);
    const size = sizeBucket(file.size);
    totalBytes += file.size;
    addToGroup(groups.byAge, age, file);
    addToGroup(groups.byType, type, file);
    addToGroup(groups.bySize, size, file);

    const isTemp = TEMP_EXT.has(String(path.extname(file.name)).toLowerCase());
    const isOld = ageDays >= minAgeDays;
    if (!isTemp && !isOld) continue;
    const reason = isTemp
      ? 'временный или незавершённый файл'
      : `старый файл: ${ageDays} дн.`;
    candidateBytes += file.size;
    candidates.push({
      path: file.path,
      name: file.name,
      size: file.size,
      sizeText: humanBytes(file.size),
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      ageDays,
      type,
      typeTitle: TYPE_TITLES[type] || type,
      ageGroup: age,
      sizeGroup: size,
      reason,
    });
  }

  // Сначала самые крупные: уборка должна давать заметное место.
  candidates.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path, 'ru'));
  const listed = candidates.slice(0, maxCandidates);

  const scanned = {
    files: walked.files.length,
    dirs: walked.dirs,
    linksSkipped: walked.linksSkipped,
    dirsSkipped: walked.dirsSkipped,
    totalBytes,
    totalText: humanBytes(totalBytes),
    truncated: walked.truncated,
    maxFiles,
    maxDepth,
  };
  const status = walked.files.length === 0 ? 'empty' : 'ok';
  const message = status === 'empty'
    ? 'папка пуста: убирать нечего'
    : `файлов: ${walked.files.length} (${humanBytes(totalBytes)}); можно убрать: ${candidates.length} (${humanBytes(candidateBytes)})`;

  return {
    ok: true,
    status,
    folder: root,
    message,
    scanned,
    issues: walked.issues,
    groups,
    groupTitles: { types: TYPE_TITLES, sizes: SIZE_TITLES, ages: AGE_TITLES },
    candidates: listed,
    candidatesTotal: candidates.length,
    candidatesTruncated: candidates.length > listed.length,
    candidateBytes,
    candidateBytesText: humanBytes(candidateBytes),
    minAgeDays,
  };
}

/**
 * Удаление файлов-кандидатов. Ничего не делает без confirm === true.
 * candidates — массив путей из analyze (относительные) или объектов {path}.
 * options: {folder, fs, path}. folder — та же папка, что анализировалась.
 * Возврат: {ok, removed, refused, failed, bytesFreed, bytesFreedText, message}.
 *   refused — защита (путь вне папки, ссылка, папка): эти файлы не тронуты;
 *   failed  — обычная ошибка удаления (файла уже нет, нет прав).
 */
function remove(candidates, confirm, options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  if (confirm !== true) {
    return {
      ok: false,
      reason: 'confirm_required',
      message: 'удаление только по явному подтверждению владельца (confirm: true)',
      removed: [],
      refused: [],
      failed: [],
      bytesFreed: 0,
    };
  }
  const folderText = String(options.folder ?? '').trim();
  if (!folderText) {
    return { ok: false, reason: 'folder_required', message: 'не указана папка загрузок', removed: [], refused: [], failed: [], bytesFreed: 0 };
  }
  const root = path.resolve(folderText);
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return { ok: false, reason: 'not_found', message: `папки загрузок нет: ${root}`, removed: [], refused: [], failed: [], bytesFreed: 0 };
  }
  if (!rootStat.isDirectory()) {
    return { ok: false, reason: 'not_directory', message: 'это не папка', removed: [], refused: [], failed: [], bytesFreed: 0 };
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { ok: false, reason: 'not_found', message: `папка загрузок недоступна: ${root}`, removed: [], refused: [], failed: [], bytesFreed: 0 };
  }
  if (!Array.isArray(candidates)) {
    return { ok: false, reason: 'candidates_required', message: 'нужен список файлов из анализа', removed: [], refused: [], failed: [], bytesFreed: 0 };
  }

  const removed = [];
  const refused = [];
  const failed = [];
  const seen = new Set();
  let bytesFreed = 0;

  for (const raw of candidates) {
    const rel = typeof raw === 'string' ? raw : String((raw && raw.path) || '');
    const clean = rel.trim();
    if (!clean) {
      refused.push({ path: '', reason: 'не указан путь' });
      continue;
    }
    if (seen.has(clean)) continue;
    seen.add(clean);
    if (path.isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || clean.startsWith('\\\\') || clean.startsWith('//')) {
      refused.push({ path: clean, reason: 'абсолютный путь: удаляю только внутри папки загрузок' });
      continue;
    }
    if (clean.split(/[\\/]+/).some((part) => part === '..')) {
      refused.push({ path: clean, reason: 'путь с «..» выводит за папку загрузок' });
      continue;
    }
    const abs = path.resolve(root, clean);
    if (!relativeInside(root, abs, path) || abs === root) {
      refused.push({ path: clean, reason: 'путь вне папки загрузок' });
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch (err) {
      const code = String((err && err.code) || '');
      failed.push({ path: clean, reason: code === 'ENOENT' ? 'файла уже нет' : `не удалось проверить: ${code || 'ошибка'}` });
      continue;
    }
    if (stat.isSymbolicLink()) {
      refused.push({ path: clean, reason: 'это ссылка: по ссылкам не удаляю' });
      continue;
    }
    if (!stat.isFile()) {
      refused.push({ path: clean, reason: 'это не обычный файл: папка или другое' });
      continue;
    }
    // Junction в середине пути не виден ни проверке строки, ни lstat: сверяем настоящий путь.
    try {
      const realFile = fs.realpathSync(abs);
      if (realFile !== realRoot && !relativeInside(realRoot, realFile, path)) {
        refused.push({ path: clean, reason: 'путь уводит за папку загрузок через ссылку' });
        continue;
      }
      if (realFile === realRoot) {
        refused.push({ path: clean, reason: 'это сама папка загрузок' });
        continue;
      }
    } catch {
      failed.push({ path: clean, reason: 'файл исчез до удаления' });
      continue;
    }
    try {
      const size = Number(stat.size) || 0;
      fs.unlinkSync(abs);
      bytesFreed += size;
      removed.push(clean);
    } catch (err) {
      failed.push({ path: clean, reason: `не удалось удалить: ${String((err && err.code) || 'ошибка')}` });
    }
  }

  const ok = refused.length === 0 && failed.length === 0;
  const message = removed.length === 0
    ? (refused.length || failed.length ? 'ничего не удалено: есть отказы' : 'нечего удалять')
    : `удалено файлов: ${removed.length}, освобождено ${humanBytes(bytesFreed)}`;
  return {
    ok,
    removed,
    refused,
    failed,
    bytesFreed,
    bytesFreedText: humanBytes(bytesFreed),
    message,
  };
}

module.exports = {
  analyze,
  remove,
  humanBytes,
  classifyType,
  sizeBucket,
  ageBucket,
  TEMP_EXT,
  DEFAULT_MIN_AGE_DAYS,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_DEPTH,
  MAX_CANDIDATES,
  DAY_MS,
};
