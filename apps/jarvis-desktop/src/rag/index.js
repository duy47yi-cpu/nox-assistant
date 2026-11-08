'use strict';

// Индекс для поиска по словам: куски текста из рабочей папки и подключённых владельцем папок.
// Без нейросетей и эмбеддингов: совпадение — общая основа слова запроса и слова куска («отчёты» находит «отчётом»).
// Пути файлов рабочей папки — относительные, подключённых папок — абсолютные.
// Не индексируются: папка индекса, точечные имена (.env, .git), data, node_modules, dist, куски с похожим на ключ текстом.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stem, looksSecret } = require('../memory/store');

const INDEX_DIR = 'rag';
const INDEX_FILE = 'index.json';
const TEXT_EXTENSIONS = ['.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.xml', '.html', '.py', '.js', '.ts', '.tsx', '.jsx', '.sql', '.log'];
const CLOSED_DIRS = new Set(['data', 'node_modules', 'dist']);
// Папка без доступа или исчезнувшая во время обхода: пропускаем, а не роняем весь поиск.
const SKIP_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_CHUNK = 800;
const MIN_SENTENCE = 12; // короче — приклеиваем к соседнему предложению, а не делаем отдельный кусок
const MAX_SNIPPET = 300;
const MAX_AGE_MS = 60 * 1000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 30;
const WORD = /[\p{L}\p{N}]+/gu;

// Нормализация по кодовым точкам: нижний регистр, ё как е.
function normalizeChar(ch) {
  return ch.toLowerCase().replace(/ё/g, 'е');
}

function normalize(text) {
  return Array.from(String(text ?? ''), normalizeChar).join('');
}

// Слова запроса: от 2 символов, без повторов.
function queryWords(query) {
  const words = normalize(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  return [...new Set(words)];
}

function toLimit(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

// Основы слов куска строкой с пробелами по краям: поиск — includes(' основа '), без разбора текста на каждом запросе.
function stemsOf(text) {
  return ` ${[...new Set(Array.from(normalize(text).matchAll(WORD), (m) => stem(m[0])))].join(' ')} `;
}

// Закрыто всегда: точечные (.env, .git) и служебные папки.
function closedName(name, isDir) {
  return name.startsWith('.') || (isDir && CLOSED_DIRS.has(name.toLowerCase()));
}

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

// Предложения: делим после .!?… и по переводу строки; короткие обрывки («Да.») приклеиваем к соседнему.
function sentencePieces(text) {
  const parts = String(text ?? '')
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const merged = [];
  for (const part of parts) {
    const short = Array.from(part).length < MIN_SENTENCE;
    const prev = merged[merged.length - 1];
    if (short && prev) merged[merged.length - 1] = `${prev} ${part}`;
    else merged.push(part);
  }
  // Первый короткий обрывок приклеиваем к следующему предложению: отдельным куском он бесполезен.
  if (merged.length > 1 && Array.from(merged[0]).length < MIN_SENTENCE) {
    merged[1] = `${merged[0]} ${merged[1]}`;
    merged.shift();
  }
  return merged;
}

// Слишком длинное предложение режем по последнему пробелу в пределах лимита; без пробелов — по символу.
function splitLongPiece(piece) {
  const out = [];
  let rest = Array.from(piece);
  while (rest.length > MAX_CHUNK) {
    let cut = 0;
    for (let k = MAX_CHUNK; k > 0; k -= 1) {
      if (/\s/u.test(rest[k - 1])) { cut = k; break; }
    }
    if (!cut) cut = MAX_CHUNK;
    out.push(rest.slice(0, cut).join('').trimEnd());
    rest = rest.slice(cut);
    while (rest.length && /\s/u.test(rest[0])) rest.shift();
  }
  if (rest.length) out.push(rest.join('').trimEnd());
  return out.filter(Boolean);
}

// Упаковка предложений в куски не длиннее MAX_CHUNK: по одному предложению, между ними пробел.
function packPieces(pieces) {
  const chunks = [];
  let buf = '';
  let size = 0;
  for (const piece of pieces) {
    const len = Array.from(piece).length;
    if (!buf) {
      buf = piece;
      size = len;
    } else if (size + 1 + len <= MAX_CHUNK) {
      buf += ` ${piece}`;
      size += 1 + len;
    } else {
      chunks.push(buf);
      buf = piece;
      size = len;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// Markdown-разметка (идея Chonkie): блоки кода (``` или ~~~) и таблицы держим целиком, если помещаются.
// Иначе маркеры ``` в куски не тащим: половина блока бесполезна и путает поиск.
function markdownSegments(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const segments = [];
  let textLines = [];
  let tableLines = [];
  let fence = null;
  const flushTable = () => {
    if (tableLines.length) { segments.push({ kind: 'lines', text: tableLines.join('\n') }); tableLines = []; }
  };
  const flushText = () => {
    flushTable();
    if (textLines.length) { segments.push({ kind: 'text', text: textLines.join('\n') }); textLines = []; }
  };
  for (const line of lines) {
    if (fence) {
      fence.lines.push(line);
      if (line.trim() === fence.marker) {
        segments.push({ kind: 'lines', text: fence.lines.join('\n') });
        fence = null;
      }
      continue;
    }
    const marker = line.trim().startsWith('```') ? '```' : line.trim().startsWith('~~~') ? '~~~' : '';
    if (marker) {
      flushText();
      fence = { marker, lines: [line] };
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (textLines.length) { segments.push({ kind: 'text', text: textLines.join('\n') }); textLines = []; }
      tableLines.push(line);
      continue;
    }
    flushTable();
    textLines.push(line);
  }
  if (fence) segments.push({ kind: 'lines', text: fence.lines.join('\n') });
  flushText();
  return segments;
}

// Строки кода/таблицы в куски не длиннее MAX_CHUNK: строка целиком, слишком длинная — по слову.
function packLines(lines) {
  const chunks = [];
  let buf = [];
  let size = 0;
  for (const line of lines) {
    const cps = Array.from(line);
    if (cps.length > MAX_CHUNK) {
      if (buf.length) { chunks.push(buf.join('\n')); buf = []; size = 0; }
      chunks.push(...splitLongPiece(line));
      continue;
    }
    if (size + cps.length + (buf.length ? 1 : 0) > MAX_CHUNK) {
      chunks.push(buf.join('\n'));
      buf = [];
      size = 0;
    }
    buf.push(line);
    size += cps.length + (buf.length > 1 ? 1 : 0);
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks.filter(Boolean);
}

// Блок кода или таблица: целиком, если помещается; иначе по строкам, без половинок fence.
function splitMarkupSegment(segment) {
  const trimmed = segment.text.trim();
  if (!trimmed) return [];
  if (Array.from(trimmed).length <= MAX_CHUNK) return [trimmed];
  const lines = segment.text.split(/\r?\n/).filter((line) => {
    const marker = line.trim();
    return !marker.startsWith('```') && !marker.startsWith('~~~');
  });
  return packLines(lines);
}

// Режет текст по пустым строкам; длинный абзац — по границам предложений, а не посреди слова.
// Блоки кода и таблицы не рвутся между кусками (идея Chonkie).
function splitChunks(text) {
  const chunks = [];
  for (const segment of markdownSegments(text)) {
    if (segment.kind === 'lines') {
      chunks.push(...splitMarkupSegment(segment));
      continue;
    }
    for (const block of segment.text.split(/\r?\n[ \t]*\r?\n/)) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const pieces = sentencePieces(trimmed).flatMap((piece) => (
        Array.from(piece).length > MAX_CHUNK ? splitLongPiece(piece) : [piece]
      ));
      chunks.push(...packPieces(pieces));
    }
  }
  return chunks;
}

// Пути сравниваем без учёта регистра только в Windows.
function pathKey(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

// Есть ли запись по пути, включая битую ссылку (lstat не идёт по ссылке).
function entryExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Префикс с разделителем: папка 'ws-evil' не считается внутри 'ws'.
function isInside(root, abs) {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return pathKey(abs).startsWith(pathKey(prefix));
}

// Оценка куска: число разных основ запроса, которые есть среди основ его слов.
// Сниппет — до MAX_SNIPPET символов вокруг первого совпадения (позиции считаются по кодовым точкам).
function scoreChunk(chunk, stems) {
  const have = typeof chunk.stems === 'string' ? chunk.stems : '';
  const score = stems.filter((s) => have.includes(` ${s} `)).length;
  if (score === 0) return null;
  const cps = Array.from(chunk.text);
  const starts = [];
  let norm = '';
  for (const ch of cps) {
    starts.push(norm.length);
    norm += normalizeChar(ch);
  }
  let first = 0;
  for (const m of norm.matchAll(WORD)) {
    if (stems.includes(stem(m[0]))) {
      first = m.index;
      break;
    }
  }
  let at = 0;
  while (at + 1 < starts.length && starts[at + 1] <= first) at += 1;
  const from = Math.max(0, at - Math.floor(MAX_SNIPPET / 2));
  const snippet = cps.slice(from, from + MAX_SNIPPET).join('').replace(/\s+/g, ' ').trim();
  return { path: chunk.path, snippet, score };
}

class WorkspaceIndex {
  constructor(rootDir) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) {
      throw new Error('WorkspaceIndex: нужна папка');
    }
    this.rootDir = path.resolve(rootDir);
    this.indexDir = path.join(this.rootDir, INDEX_DIR);
    this.indexFile = path.join(this.indexDir, INDEX_FILE);
    this._cache = null;
    this._dirty = false;
    // Полный доступ (решение владельца 31.10.2026): файловые инструменты работают с любыми папками, как в Codex.
    // Включается и выключается из main.js вместе с режимом доступа.
    this.unrestricted = false;
    // Папки, куда файловые инструменты не пишут ни в каком режиме (папка данных). Папка программы закрыта всегда (src/tools/workspace.js).
    this.denyWrite = [];
    // Подключённые владельцем папки (абсолютные пути из настроек): поиск идёт и по ним.
    // Читать файл вне рабочей папки можно только в «Полном доступе» (см. workspace_read).
    this.folders = [];
    // Сколько файлов последняя сборка прочитала заново и сколько взяла из прошлого индекса.
    this.lastBuild = { read: 0, reused: 0 };
  }

  // Новый список подключённых папок; индекс перестроится при следующем поиске.
  setFolders(list) {
    this.folders = (Array.isArray(list) ? list : [])
      .filter((p) => typeof p === 'string' && path.isAbsolute(p))
      .map((p) => path.resolve(p));
    this.invalidate();
  }

  // Сканирует папки и сохраняет индекс в rag/index.json. Возвращает число кусков.
  // Файл с теми же датой изменения и размером не читается: его куски берутся из прошлого индекса.
  build() {
    const prev = this._previous();
    const files = {};
    const chunks = [];
    const stats = { read: 0, reused: 0 };
    for (const abs of this._allFiles()) {
      const rel = this._display(abs);
      let st;
      let pieces;
      try {
        st = fs.statSync(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        const old = prev.files[rel];
        if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) {
          pieces = prev.byPath.get(rel) || [];
          stats.reused += 1;
        } else {
          // Куски с похожим на пароль или ключ текстом в индекс не попадают: поиск не покажет их сниппетом.
          pieces = splitChunks(fs.readFileSync(abs, 'utf8'))
            .filter((text) => !looksSecret(text))
            .map((text) => ({ path: rel, text, stems: stemsOf(text) }));
          stats.read += 1;
        }
      } catch (err) {
        if (SKIP_CODES.has(err.code)) continue; // файл исчез или закрыт во время сканирования
        throw err;
      }
      files[rel] = { mtimeMs: st.mtimeMs, size: st.size };
      chunks.push(...pieces);
    }
    this.lastBuild = stats;
    const data = { builtAt: new Date().toISOString(), files, chunks };
    fs.mkdirSync(this.indexDir, { recursive: true });
    const tmp = path.join(this.indexDir, `.${INDEX_FILE}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, this.indexFile);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    this._cache = data;
    this._dirty = false;
    return chunks.length;
  }

  // Индекс из кэша или с диска. Если файла нет или он испорчен, строит заново.
  load() {
    if (this._dirty) {
      this.build();
      return this._cache;
    }
    if (this._cache) return this._cache;
    let raw;
    try {
      raw = fs.readFileSync(this.indexFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.build();
        return this._cache;
      }
      throw err;
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (!data || !Array.isArray(data.chunks) || !data.files || typeof data.files !== 'object') {
      // Индекс — производные данные, поэтому испорченный файл и старый формат без files просто перестраиваем.
      this.build();
      return this._cache;
    }
    this._cache = data;
    return data;
  }

  // Помечает индекс устаревшим: следующий поиск или load() перестроит его.
  invalidate() {
    this._cache = null;
    this._dirty = true;
  }

  // Поиск по основам слов, не больше MAX_LIMIT результатов. Выше куски с большим числом совпавших слов; при равенстве — по пути.
  search(query, limit = DEFAULT_LIMIT) {
    const stems = [...new Set(queryWords(query).map(stem))];
    if (stems.length === 0) return [];
    const index = this._fresh();
    const hits = [];
    for (const chunk of index.chunks) {
      const hit = scoreChunk(chunk, stems);
      if (hit) hits.push(hit);
    }
    hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return hits.slice(0, toLimit(limit));
  }

  // Абсолютный путь внутри rootDir; для любого другого пути — ошибка.
  // Сначала лексическая проверка, потом настоящий путь: симлинк или junction внутри папки не должен вести наружу.
  // Новый файл ещё не существует, поэтому настоящий путь берём у самого глубокого существующего предка.
  resolveInside(relPath) {
    if (typeof relPath !== 'string') throw new Error('путь должен быть строкой');
    const abs = path.resolve(this.rootDir, relPath);
    if (this.unrestricted) return abs;
    if (!isInside(this.rootDir, abs)) throw new Error('путь вне рабочей папки');
    const realRoot = fs.realpathSync(this.rootDir);
    let probe = abs;
    while (!entryExists(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    let real;
    try {
      real = fs.realpathSync(probe);
    } catch {
      // Битая ссылка или нечитаемый путь: без проверки не пускаем.
      throw new Error('путь ведёт за пределы рабочей папки (симлинк)');
    }
    if (real !== realRoot && !isInside(realRoot, real)) {
      throw new Error('путь ведёт за пределы рабочей папки (симлинк)');
    }
    return abs;
  }

  // Индекс не старше MAX_AGE_MS; устаревший перестраивается.
  _fresh() {
    const index = this.load();
    if (!(Date.now() - Date.parse(index.builtAt) <= MAX_AGE_MS)) {
      this.build();
      return this._cache;
    }
    return index;
  }

  // Прошлый индекс для повторного использования: даты и размеры файлов и их куски по путям.
  _previous() {
    let data = this._cache;
    if (!data) {
      try {
        data = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      } catch {
        data = null;
      }
    }
    const files = data && data.files && typeof data.files === 'object' ? data.files : {};
    const byPath = new Map();
    for (const chunk of data && Array.isArray(data.chunks) ? data.chunks : []) {
      if (!chunk || typeof chunk.text !== 'string' || typeof chunk.stems !== 'string') continue;
      if (!byPath.has(chunk.path)) byPath.set(chunk.path, []);
      byPath.get(chunk.path).push(chunk);
    }
    return { files, byPath };
  }

  // Файлы рабочей папки, затем подключённых, без повторов. Подключённая папка внутри закрытой (data, точечной) пропускается.
  _allFiles() {
    const seen = new Set();
    const out = [];
    for (const root of [this.rootDir, ...this.folders]) {
      if (root !== this.rootDir && root.split(path.sep).some((part) => closedName(part, true))) continue;
      for (const abs of this._collectFiles(root, 0, [])) {
        if (seen.has(pathKey(abs))) continue;
        seen.add(pathKey(abs));
        out.push(abs);
      }
    }
    return out;
  }

  // Путь в результатах: внутри рабочей папки относительный, как раньше; в подключённой — абсолютный.
  _display(abs) {
    return isInside(this.rootDir, abs) ? toPosix(path.relative(this.rootDir, abs)) : abs;
  }

  // Рекурсивный обход. depth — число уровней папок от корня: корень 0, его подпапки 1 и т. д.
  // Папки глубже MAX_DEPTH не заходим. Симлинки, закрытые имена и папку самого индекса пропускаем.
  _collectFiles(dir, depth, out) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (SKIP_CODES.has(err.code)) return out;
      throw err;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || closedName(entry.name, entry.isDirectory())) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && pathKey(abs) !== pathKey(this.indexDir)) this._collectFiles(abs, depth + 1, out);
      } else if (entry.isFile() && TEXT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        out.push(abs);
      }
    }
    return out;
  }
}

module.exports = { WorkspaceIndex, TEXT_EXTENSIONS, MAX_LIMIT };
