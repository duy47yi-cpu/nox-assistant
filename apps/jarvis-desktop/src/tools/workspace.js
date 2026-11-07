'use strict';

// Инструменты рабочей папки: найти (T0), список файлов (T0), прочитать (T0), записать (T1).
// Пути проверяет WorkspaceIndex.resolveInside; любая ошибка возвращается как {ok: false, summary}.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { insideWorkspace } = require('../policy/modes');
const { TEXT_EXTENSIONS: READ_EXTENSIONS, MAX_LIMIT: MAX_SEARCH_LIMIT } = require('../rag/index');

const TEXT_EXTENSIONS = ['.md', '.txt'];
const MAX_PATH = 300;
const MAX_QUERY = 200;
const MAX_CONTENT = 50000;
const MAX_READ_BYTES = 20 * 1024;
const MAX_LIST = 100;
const MAX_COPY_VERIFY_BYTES = 8 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 5;
const REPORTS_DIR = 'reports';
const RAG_DIR = 'rag';
const BACKUPS_DIR = 'backups';
const MAX_BACKUPS = 50;
const PER_FILE_BACKUPS = 20;
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

function fail(err) {
  return { ok: false, summary: err && err.message ? err.message : String(err), data: {} };
}

function notOk(summary) {
  return { ok: false, summary, data: {} };
}

// Читать можно все типы, которые ищет индекс; писать — только .md и .txt.
function isTextFile(p) {
  return READ_EXTENSIONS.includes(path.extname(p).toLowerCase());
}

function pathKey(s) {
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

// Читает файл не больше max байт. Размер проверяется по открытому дескриптору, чтение ограничено порциями:
// рост файла между проверкой и чтением не может выделить память больше лимита.
function readCapped(abs, max) {
  const fd = fs.openSync(abs, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('это не файл');
    const over = () => {
      const err = new Error('файл больше лимита');
      err.code = 'TOO_BIG';
      return err;
    };
    if (st.size > max) throw over();
    const buf = Buffer.allocUnsafe(max + 1);
    let read = 0;
    while (read <= max) {
      const n = fs.readSync(fd, buf, read, Math.min(max + 1 - read, 1024 * 1024), read);
      if (n === 0) break;
      read += n;
    }
    if (read > max) throw over();
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// Папка копий должна быть настоящей папкой: ссылка или junction увели бы копии за пределы рабочей папки.
function backupsDirChecked(root) {
  const dir = backupsDirOf(root);
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error('папка backups не настоящая папка: копии не сохраняю');
  }
  return dir;
}

// Ключ пути из имени копии: по нему видно, какому файлу принадлежит копия.
function copyKeyOf(name) {
  const match = /__([0-9a-f]{10})(?:-\d+)?\.bak$/.exec(String(name));
  return match ? match[1] : null;
}

function cleanPath(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Не читаем больше лимита даже если файл вырастет после stat.
function readBounded(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size + 1);
    let used = 0;
    while (used < buf.length) {
      const n = fs.readSync(fd, buf, used, buf.length - used, null);
      if (!n) break;
      used += n;
    }
    return buf.subarray(0, used);
  } finally {
    fs.closeSync(fd);
  }
}

function stableStat(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

function fileDigest(file) {
  const before = fs.statSync(file);
  if (!before.isFile() || before.size > MAX_COPY_VERIFY_BYTES) return null;
  const bytes = readBounded(file, before.size);
  const after = fs.statSync(file);
  if (bytes.length !== before.size || !stableStat(before, after)) return null;
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Целое от 1 до max; undefined возвращает fallback; иное значение возвращает null (ошибка).
function readLimit(value, fallback, max) {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

// Папка программы: здесь main.js и src/. Писать сюда нельзя ни в каком режиме.
const APP_DIR = path.resolve(__dirname, '..', '..');

function isUnder(dir, abs) {
  const rel = path.relative(pathKey(dir), pathKey(abs));
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

// true, если путь внутри папки программы или папок index.denyWrite (данные). Проверяем и путь, и куда он ведёт на самом деле.
function isProtected(index, abs) {
  const dirs = [APP_DIR, ...(Array.isArray(index.denyWrite) ? index.denyWrite : [])].map((d) => path.resolve(d));
  const targets = [abs, realish(abs)];
  return dirs.some((d) => [d, realish(d)].some((dir) => targets.some((t) => isUnder(dir, t))));
}

const PROTECTED_TEXT = 'нельзя менять папку программы и её данные';

// Путь для записи: граница папки (resolveInside), в обычных режимах тип файла (exts, null — любой), точка и rag запрещены.
// Папка программы и данных закрыта в любом режиме, в том числе в «Полном доступе».
// Бросает ошибку с понятным текстом; общая проверка для workspace_* и document_write.
function writeTarget(index, rel, exts) {
  const abs = index.resolveInside(rel);
  if (isProtected(index, abs)) throw new Error(PROTECTED_TEXT);
  if (index.unrestricted) return abs;
  const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  if (exts && !isDir && !exts.includes(path.extname(abs).toLowerCase())) throw new Error(`пишу только ${exts.map((e) => e || 'без расширения').join(' и ')}`);
  const parts = path.relative(index.rootDir, abs).split(path.sep);
  if (parts.some((part) => part.startsWith('.'))) throw new Error('нельзя писать в папки и файлы с точкой в имени');
  if (pathKey(parts[0]) === RAG_DIR) throw new Error('нельзя писать в папку rag');
  return abs;
}

// Перезапись существующего файла: в обычных режимах только внутри reports. Текст отказа или null.
function reportsOnly(index, abs) {
  if (index.unrestricted) return null;
  const top = path.relative(index.rootDir, abs).split(path.sep)[0];
  return pathKey(top) === REPORTS_DIR ? null : 'перезаписывать можно только в reports';
}

// ---- Резервные копии перед изменением файла: «Безопасная отмена действий».

// Ключ файла для поиска его копий: короткий хеш относительного пути (имя копии выходит компактным).
function backupKey(abs, root) {
  return crypto.createHash('sha1').update(pathKey(path.resolve(abs))).digest('hex').slice(0, 10);
}

function backupsDirOf(root) {
  return path.join(root, BACKUPS_DIR);
}

// Имя копии: время (по алфавиту = по порядку) + читаемое имя файла + ключ пути. Одно имя — один файл.
function backupName(abs, root, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-`
    + `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, '0')}`;
  const base = path.basename(abs).replace(/[^A-Za-zа-яА-Я0-9._-]/g, '_').slice(-40) || 'file';
  return `${stamp}__${base}__${backupKey(abs, root)}.bak`;
}

// Оставляет не больше PER_FILE_BACKUPS копий каждого файла и не больше MAX_BACKUPS всего,
// но самую новую копию каждого файла не удаляет: иначе часто меняемый файл стёр бы единственную копию другого.
function pruneBackups(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.bak')).sort();
    if (!files.length) return;
    const byKey = new Map();
    for (const name of files) {
      const key = copyKeyOf(name) || 'other';
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(name);
    }
    const remove = new Set();
    for (const list of byKey.values()) {
      // Имена начинаются со времени: по алфавиту старые идут первыми.
      for (const old of list.slice(0, Math.max(0, list.length - PER_FILE_BACKUPS))) remove.add(old);
    }
    const newest = new Set([...byKey.values()].map((list) => list[list.length - 1]));
    for (const name of files) {
      if (files.length - remove.size <= MAX_BACKUPS) break;
      if (remove.has(name) || newest.has(name)) continue;
      remove.add(name);
    }
    for (const name of remove) fs.rmSync(path.join(dir, name), { force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Сохраняет текущее содержимое файла в backups/ атомарно. Возвращает {rel} или бросает ошибку:
// без копии перезапись не делается, чтобы изменение можно было отменить.
// now — только для проверок: так можно воспроизвести две копии в одну миллисекунду.
function saveBackup(root, abs, now = new Date()) {
  const dir = backupsDirChecked(root);
  const tooBig = 'файл больше 8 МБ: резервную копию не снимаю, перезапись отменена';
  let bytes;
  try {
    bytes = readCapped(abs, MAX_BACKUP_BYTES);
  } catch (err) {
    if (err && err.code === 'TOO_BIG') throw new Error(tooBig);
    throw err;
  }
  const base = backupName(abs, root, now);
  // Две перезаписи одного файла в одну миллисекунду дали бы одно имя: добавляем счётчик и не затираем копию.
  let name = base;
  for (let n = 1; n < 1000 && fs.existsSync(path.join(dir, name)); n += 1) {
    name = base.replace(/\.bak$/, `-${n}.bak`);
  }
  const tmp = path.join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, path.join(dir, name));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  pruneBackups(dir);
  return { rel: `${BACKUPS_DIR}/${name}`, bytes: bytes.length };
}

// Порядок копий от старых к новым: время в имени, затем счётчик коллизии (-1, -2… новее базовой),
// затем имя. Так копии одной миллисекунды не теряют порядок.
function backupOrderKey(name) {
  const text = String(name);
  const match = /^(.*?)__.*__([0-9a-f]{10})(?:-(\d+))?\.bak$/.exec(text);
  return { stamp: match ? match[1] : text, collision: match ? Number(match[3] || 0) : 0, name: text };
}

function compareBackups(a, b) {
  const left = backupOrderKey(a);
  const right = backupOrderKey(b);
  if (left.stamp !== right.stamp) return left.stamp < right.stamp ? -1 : 1;
  if (left.collision !== right.collision) return left.collision - right.collision;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

// Копии конкретного файла: от новых к старым. Ключ пути понимает и суффикс коллизии `__ключ-1.bak`:
// без этого копии, созданные в одну миллисекунду, не показывались бы в списке и не восстанавливались.
function backupsFor(root, abs, limit = 10) {
  const dir = backupsDirOf(root);
  const key = backupKey(abs, root);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.bak') && copyKeyOf(f) === key);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return names.sort(compareBackups).reverse().slice(0, limit).map((name) => {
    const full = path.join(dir, name);
    let at = null;
    let bytes = null;
    try {
      const st = fs.lstatSync(full);
      if (st.isFile() && !st.isSymbolicLink()) {
        at = st.mtimeMs;
        bytes = st.size;
      }
    } catch {
      // файл мог исчезнуть между чтением списка и проверкой — показываем как есть
    }
    return { backup: `${BACKUPS_DIR}/${name}`, at, bytes };
  });
}

// Путь копии из аргумента: только внутри backups/ рабочей папки, без выхода за его границы.
// Проверка не только по строке: ссылки и junction раскрываются, копия должна быть настоящим файлом внутри backups.
function backupPathInside(root, rel) {
  const dir = path.resolve(backupsDirOf(root));
  const abs = path.resolve(root, rel);
  const insideDir = pathKey(abs.slice(0, dir.length)) === pathKey(dir);
  const rest = abs.slice(dir.length);
  if (!insideDir || (!rest.startsWith(path.sep) && rest !== '')) {
    throw new Error('копия должна лежать в папке backups рабочей папки');
  }
  if (!abs.toLowerCase().endsWith('.bak')) throw new Error('это не файл резервной копии');
  const st = fs.lstatSync(abs);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('копия не обычный файл');
  const realDir = fs.realpathSync(dir);
  const realAbs = fs.realpathSync(abs);
  const realRest = path.relative(realDir, realAbs);
  if (!realRest || realRest.startsWith('..') || path.isAbsolute(realRest) || realRest.includes(path.sep)) {
    throw new Error('копия ведёт за пределы папки backups');
  }
  return abs;
}

// ---- Копирование папки целиком.
//
// fs.cpSync на Windows валит процесс нативно (код 0xC0000409) на не-ASCII путях:
// падает внутренняя функция Node, до нашего кода дело не доходит. Поэтому копируем обходным
// путём — mkdirSync/copyFileSync/symlinkSync. Содержимое и права те же, что у fs.cp:
// ссылки копируются ссылками (цель не раскрывается), права файла переносятся.

// Ссылка копируется ссылкой: цель не раскрываем, иначе копия утащила бы наружу данные.
// Относительную цель делаем абсолютной — как это делает fs.cp: ссылка в копии указывает туда же.
function copyLink(src, dst) {
  const raw = fs.readlinkSync(src);
  const target = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(src), raw);
  if (process.platform === 'win32') {
    // На Windows папку копируем junction'ом: он создаётся без прав администратора,
    // обычная ссылка на папку требует режима разработчика.
    let isDir = false;
    try { isDir = fs.statSync(target).isDirectory(); } catch { /* цели нет: считаем файлом */ }
    fs.symlinkSync(target, dst, isDir ? 'junction' : 'file');
    return;
  }
  fs.symlinkSync(target, dst);
}

// Копия дерева: папка — рекурсивно, файл — содержимое и права, ссылка — ссылкой.
function copyTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    copyLink(src, dst);
    return;
  }
  if (st.isDirectory()) {
    // Папку в саму себя не копируем: пути сравниваем настоящие (ссылки и junction раскрыты).
    const realSrc = fs.realpathSync(src);
    const realDst = realish(dst);
    if (isUnder(realSrc, realDst)) throw new Error('нельзя положить папку внутрь неё самой');
    // Назначение-файл на месте папки — копия невозможна, как и у fs.cp.
    if (fs.existsSync(dst) && !fs.statSync(dst).isDirectory()) {
      throw new Error('назначение уже есть как файл: папку туда не положить');
    }
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyTree(path.join(src, name), path.join(dst, name));
    }
    // Права папки — после содержимого: иначе в папку без прав не удалось бы положить файлы.
    fs.chmodSync(dst, st.mode);
    return;
  }
  if (!st.isFile()) throw new Error('копирую только обычные файлы, папки и ссылки');
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, st.mode);
}

function workspaceTools(index) {
  if (!index || typeof index.search !== 'function' || typeof index.resolveInside !== 'function'
      || typeof index.invalidate !== 'function') {
    throw new Error('workspaceTools: нужен экземпляр WorkspaceIndex');
  }
  const root = index.rootDir;
  const relOf = (abs) => path.relative(root, abs).split(path.sep).join('/');

  const search = {
    name: 'workspace_search',
    description: 'Найти по словам запроса (с учётом склонения) куски текстовых файлов в рабочей папке и подключённых владельцем папках. PDF, DOCX и XLSX в этот поиск не входят; отсутствие результата не означает, что сведений нет в документах. Индекс пропускает файлы больше 1 МБ и папки глубже 8 уровней. Абсолютный путь в результате — файл подключённой папки: workspace_read читает его только в «Полном доступе».',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT },
      },
      required: ['query'],
    },
    async run(args = {}) {
      try {
        const query = String(args.query ?? '').trim();
        if (!query) return notOk('пустой запрос');
        if (query.length > MAX_QUERY) return notOk(`запрос длиннее ${MAX_QUERY} символов`);
        const limit = readLimit(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        if (limit === null) return notOk(`limit от 1 до ${MAX_SEARCH_LIMIT}`);
        const results = index.search(query, limit);
        return { ok: true, summary: `найдено: ${results.length}`, data: results };
      } catch (err) {
        return fail(err);
      }
    },
  };

  const read = {
    name: 'workspace_read',
    description: 'Прочитать текстовый файл (.md, .txt, .json, .csv, код и другие) из рабочей папки; в «Полном доступе» — и найденный в подключённой папке. Больше 20 КБ обрезается.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
      },
      required: ['path'],
    },
    async run(args = {}) {
      try {
        const rel = cleanPath(args.path);
        if (!rel) return notOk('пустой путь');
        if (rel.length > MAX_PATH) return notOk(`путь длиннее ${MAX_PATH} символов`);
        // Искать в подключённых папках можно в любом режиме, читать вне рабочей папки — только в «Полном доступе».
        if (!index.unrestricted && !insideWorkspace({ path: rel }, root)) return notOk('файл вне рабочей папки: прочитать его можно только в «Полном доступе»');
        const abs = index.resolveInside(rel);
        if (!index.unrestricted && !isTextFile(abs)) return notOk('читаю только текстовые файлы');
        if (!fs.existsSync(abs)) return notOk('файл не найден');
        const st = fs.statSync(abs);
        if (!st.isFile()) return notOk('это не файл');
        const want = Math.min(st.size, MAX_READ_BYTES);
        const buf = Buffer.alloc(want);
        const fd = fs.openSync(abs, 'r');
        let got = 0;
        try {
          got = fs.readSync(fd, buf, 0, want, 0);
        } finally {
          fs.closeSync(fd);
        }
        const truncated = st.size > MAX_READ_BYTES;
        let text = buf.subarray(0, got).toString('utf8');
        // Обрезка могла разорвать многобайтовый символ в конце.
        if (truncated) text = text.replace(/�$/, '');
        const summary = truncated
          ? `файл обрезан: первые 20 КБ из ${Math.ceil(st.size / 1024)} КБ`
          : `прочитано: ${st.size} байт`;
        return { ok: true, summary, data: { path: relOf(abs), text, truncated, size: st.size } };
      } catch (err) {
        return fail(err);
      }
    },
  };

  const write = {
    name: 'workspace_write',
    description: 'Записать текст в файл. В полном доступе доступны другие типы и пути и перезапись существующего файла; в остальных режимах — .md и .txt в рабочей папке, перезапись только в reports/. Перед перезаписью сохраняется копия.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        content: { type: 'string', minLength: 1, maxLength: MAX_CONTENT },
      },
      required: ['path', 'content'],
    },
    async run(args = {}) {
      try {
        const rel = cleanPath(args.path);
        if (!rel) return notOk('пустой путь');
        if (rel.length > MAX_PATH) return notOk(`путь длиннее ${MAX_PATH} символов`);
        const content = typeof args.content === 'string' ? args.content : '';
        if (!content) return notOk('пустое содержимое');
        if (content.length > MAX_CONTENT) return notOk(`содержимое длиннее ${MAX_CONTENT} символов`);
        // В полном доступе ограничений по типу и месту нет (решение владельца): как в Codex.
        const abs = writeTarget(index, rel, TEXT_EXTENSIONS);
        const exists = fs.existsSync(abs);
        let backup = null;
        if (exists) {
          if (fs.statSync(abs).isDirectory()) return notOk('это папка');
          const denied = reportsOnly(index, abs);
          if (denied) return notOk(denied);
          // Прежняя версия сохраняется до перезаписи: без копии изменение нельзя отменить, поэтому и записи не будет.
          backup = saveBackup(root, abs);
        }
        const dir = path.dirname(abs);
        fs.mkdirSync(dir, { recursive: true });
        // Атомарная запись: временный файл рядом, затем переименование.
        const tmp = path.join(dir, `.${path.basename(abs)}.${crypto.randomUUID()}.tmp`);
        try {
          fs.writeFileSync(tmp, content, 'utf8');
          fs.renameSync(tmp, abs);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        index.invalidate();
        return {
          ok: true,
          summary: exists ? 'перезаписал' : 'записал',
          data: { path: relOf(abs), created: !exists, backup: backup ? backup.rel : null },
        };
      } catch (err) {
        return fail(err);
      }
    },
    // Проверка эффекта: файл на диске существует и содержит именно записанный текст.
    async verify(args = {}, result = {}) {
      if (!result.data || !result.data.path) return { status: 'unknown', evidence: 'нет пути результата' };
      const abs = index.resolveInside(result.data.path);
      try {
        const onDisk = fs.readFileSync(abs, 'utf8');
        if (onDisk === args.content) return { status: 'confirmed', evidence: `файл ${result.data.path} совпадает с записью` };
        return { status: 'failed', evidence: `файл ${result.data.path} на диске отличается от записи` };
      } catch (err) {
        return { status: 'failed', evidence: `файла ${result.data.path} нет на диске` };
      }
    },
  };

  // Список без содержимого: поиск по словам не находит файлы по имени и папке, а угадывать имена модель начинает впустую.
  const list = {
    name: 'workspace_list',
    description: 'Показать файлы и папки внутри папки рабочей папки (без содержимого). Без пути — корень. Точечные папки и rag не показываются.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: MAX_PATH },
      },
    },
    async run(args = {}) {
      try {
        const rel = cleanPath(args.path);
        if (rel.length > MAX_PATH) return notOk(`путь длиннее ${MAX_PATH} символов`);
        const parts = rel ? rel.split(/[\\/]+/) : [];
        if (parts.some((part) => part.startsWith('.')) || (parts.length && pathKey(parts[0]) === RAG_DIR)) {
          return notOk('точечные папки и rag не показываю');
        }
        const abs = rel ? index.resolveInside(rel) : root;
        // Отсутствующая папка — не ошибка инструмента: отсутствие целевой папки — нормальное состояние перед созданием.
        if (!fs.existsSync(abs)) return { ok: true, summary: `папки «${rel}» пока нет`, data: { exists: false, items: [] } };
        if (!fs.statSync(abs).isDirectory()) return notOk('это не папка');
        const atRoot = abs === root;
        const items = fs.readdirSync(abs, { withFileTypes: true })
          .filter((e) => !e.name.startsWith('.') && !(atRoot && (pathKey(e.name) === RAG_DIR || pathKey(e.name) === BACKUPS_DIR)))
          .sort((a, b) => (a.isDirectory() === b.isDirectory()
            ? a.name.localeCompare(b.name, 'ru')
            : a.isDirectory() ? -1 : 1))
          .slice(0, MAX_LIST)
          .map((e) => {
            const full = path.join(abs, e.name);
            const dir = e.isDirectory();
            return { name: e.name, type: dir ? 'папка' : 'файл', size: dir ? null : fs.statSync(full).size, path: relOf(full) };
          });
        return { ok: true, summary: `в «${relOf(abs) || '.'}»: ${items.length}`, data: { items } };
      } catch (err) {
        return fail(err);
      }
    },
  };

  // Перенос и копия. Источник — в рабочей папке и не в rag/точечных; назначение проверяется как запись.
  // Удаления нет: перенос только переименовывает, копия не трогает источник.
  // Заменяемый файл перед заменой сохраняется в backups/ (как workspace_write): без копии замены нет.
  const transfer = (name, move) => {
    const proofs = new WeakMap();
    return {
    name,
    description: move
      ? 'Перенести файл или папку внутри рабочей папки (from → to). Существующее назначение заменяется только с overwrite: true и только в reports/, прежняя версия файла сохраняется в backups/. В «Полном доступе» папки любые, иначе — внутри рабочей папки.'
      : 'Копировать файл или папку внутри рабочей папки (from → to). Существующее назначение заменяется только с overwrite: true и только в reports/, прежняя версия файла сохраняется в backups/. В «Полном доступе» папки любые, иначе — внутри рабочей папки.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        to: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        overwrite: { type: 'boolean' },
      },
      required: ['from', 'to'],
    },
    async run(args = {}) {
      try {
        const from = cleanPath(args.from);
        const to = cleanPath(args.to);
        if (!from || !to) return notOk('нужны пути from и to');
        if (from.length > MAX_PATH || to.length > MAX_PATH) return notOk(`путь длиннее ${MAX_PATH} символов`);
        const src = index.resolveInside(from);
        if (!fs.existsSync(src)) return notOk('источник не найден');
        // Перенос убирает файл из старого места: из папки программы и данных — нельзя. Копия только читает.
        if (move && isProtected(index, src)) return notOk(PROTECTED_TEXT);
        if (!index.unrestricted) {
          const parts = path.relative(root, src).split(path.sep);
          if (parts.some((part) => part.startsWith('.')) || pathKey(parts[0]) === RAG_DIR) {
            return notOk('нельзя трогать папки и файлы с точкой в имени и папку rag');
          }
        }
        const isDir = fs.statSync(src).isDirectory();
        // Тип файла при переносе и копии не меняется: назначение с тем же расширением, что у источника.
        const dst = writeTarget(index, to, isDir ? null : [path.extname(src).toLowerCase()]);
        if (pathKey(dst) === pathKey(src)) return notOk('источник и назначение совпадают');
        if (isDir && pathKey(dst).startsWith(pathKey(src) + path.sep)) return notOk('нельзя положить папку внутрь неё самой');
        // Прежняя версия заменяемого файла: снимаем копию до операции. Копия папки в обещание не входит,
        // поэтому папку заменять по-прежнему нельзя — честный отказ вместо тихой потери.
        let backup = null;
        if (fs.existsSync(dst)) {
          if (!args.overwrite) return notOk('файл назначения уже есть: укажите overwrite: true');
          if (fs.statSync(dst).isDirectory()) return notOk('назначение уже есть как папка');
          if (isDir) return notOk('назначение уже есть как файл: папку туда не положить');
          const denied = reportsOnly(index, dst);
          if (denied) return notOk(denied);
          // saveBackup бросает ошибку, если копию снять нельзя: тогда операция отменяется, файл не меняется.
          backup = saveBackup(root, dst);
        }
        let original = null;
        if (move && !isDir) {
          try { original = fileDigest(src); } catch { /* Перенос возможен, но проверка останется неизвестной. */ }
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (move) fs.renameSync(src, dst);
        else if (isDir) copyTree(src, dst);
        else fs.copyFileSync(src, dst);
        index.invalidate();
        const result = {
          ok: true,
          summary: `${move ? 'перенёс' : 'скопировал'}${backup ? `, прежняя версия в ${backup.rel}` : ''}`,
          data: { from: relOf(src), to: relOf(dst), ...(backup ? { backup: backup.rel } : {}) },
        };
        if (original) proofs.set(result.data, original);
        return result;
      } catch (err) {
        return fail(err);
      }
    },
    // Сверка небольших файлов: для папок и переноса источник до операции не сохранён.
    async verify(_args, result = {}) {
      if (!result.data || !result.data.to) return { status: 'unknown', evidence: 'нет пути назначения' };
      let dst;
      let dstBefore;
      try {
        dst = index.resolveInside(result.data.to);
        dstBefore = fs.statSync(dst);
      } catch (err) {
        if (err && err.code === 'ENOENT') return { status: 'failed', evidence: 'назначение не найдено' };
        return { status: 'unknown', evidence: 'не удалось проверить назначение' };
      }
      try {
        if (move && result.data.from && proofs.has(result.data)) {
          const src = index.resolveInside(result.data.from);
          try {
            fs.lstatSync(src);
            return { status: 'unknown', evidence: 'источник снова существует; исход переноса неясен' };
          } catch (err) {
            if (err.code !== 'ENOENT') return { status: 'unknown', evidence: 'не удалось проверить исходный путь' };
          }
          const digest = fileDigest(dst);
          if (digest && digest === proofs.get(result.data)) return { status: 'confirmed', evidence: 'содержимое совпадает с исходным, прежний путь отсутствует' };
          return { status: 'unknown', evidence: 'не удалось подтвердить сохранность содержимого при переносе' };
        }
        if (!move && result.data.from) {
          const src = index.resolveInside(result.data.from);
          const srcBefore = fs.statSync(src);
          if (srcBefore.isFile() && dstBefore.isFile() && srcBefore.size <= MAX_COPY_VERIFY_BYTES && dstBefore.size <= MAX_COPY_VERIFY_BYTES) {
            const srcBytes = readBounded(src, srcBefore.size);
            const dstBytes = readBounded(dst, dstBefore.size);
            const same = srcBytes.length === srcBefore.size && dstBytes.length === dstBefore.size && srcBytes.equals(dstBytes);
            const srcAfter = fs.statSync(src);
            const dstAfter = fs.statSync(dst);
            if (!stableStat(srcBefore, srcAfter) || !stableStat(dstBefore, dstAfter)) return { status: 'unknown', evidence: 'файл изменился во время проверки' };
            if (same) return { status: 'confirmed', evidence: 'содержимое копии совпадает с текущим источником' };
            return { status: 'unknown', evidence: 'копия отличается от текущего источника; неизвестно, когда он изменился' };
          }
        }
        return { status: 'unknown', evidence: 'назначение существует, но содержимое не сверено с исходным' };
      } catch (err) {
        return { status: 'unknown', evidence: 'не удалось сверить содержимое файлов' };
      }
    },
    };
  };

  const move = transfer('workspace_move', true);
  const copy = transfer('workspace_copy', false);

  const mkdir = {
    name: 'workspace_mkdir',
    description: 'Создать папку в рабочей папке, вместе с недостающими родительскими. Если папка уже есть, это не ошибка. В «Полном доступе» папки любые, иначе — внутри рабочей папки.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
      },
      required: ['path'],
    },
    async run(args = {}) {
      try {
        const rel = cleanPath(args.path);
        if (!rel) return notOk('пустой путь');
        if (rel.length > MAX_PATH) return notOk(`путь длиннее ${MAX_PATH} символов`);
        const abs = writeTarget(index, rel, null);
        if (fs.existsSync(abs)) {
          if (!fs.statSync(abs).isDirectory()) return notOk('это файл');
          return { ok: true, summary: 'папка уже есть', data: { path: relOf(abs), created: false } };
        }
        fs.mkdirSync(abs, { recursive: true });
        return { ok: true, summary: 'создал папку', data: { path: relOf(abs), created: true } };
      } catch (err) {
        return fail(err);
      }
    },
    // Папка есть на диске и это действительно папка.
    async verify(args = {}, result = {}) {
      if (!result.data || !result.data.path) return { status: 'unknown', evidence: 'нет пути результата' };
      try {
        const isDir = fs.statSync(index.resolveInside(result.data.path)).isDirectory();
        return isDir ? { status: 'confirmed', evidence: `папка ${result.data.path} есть` } : { status: 'failed', evidence: `${result.data.path} не папка` };
      } catch (err) {
        return { status: 'failed', evidence: `папки ${result.data.path} нет на диске` };
      }
    },
  };

  const restore = {
    name: 'workspace_restore',
    description: 'Вернуть прежнюю версию файла из резервной копии. list: true — показать доступные копии файла. Восстановление использует копию именно этого файла и проходит проверку выбранного режима.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        backup: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        list: { type: 'boolean' },
      },
      required: ['path'],
    },
    async run(args = {}) {
      try {
        const rel = cleanPath(args.path);
        if (!rel) return notOk('пустой путь');
        if (rel.length > MAX_PATH) return notOk(`путь длиннее ${MAX_PATH} символов`);
        const abs = writeTarget(index, rel, null);
        const copies = backupsFor(root, abs);
        if (args.list === true) {
          if (!copies.length) return notOk('резервных копий для этого файла нет');
          return { ok: true, summary: `копий: ${copies.length}`, data: { path: relOf(abs), copies } };
        }
        const backupRel = cleanPath(args.backup);
        if (!backupRel) {
          return notOk(copies.length
            ? `укажите backup; доступны: ${copies.map((c) => c.backup).join(', ')}`
            : 'резервных копий для этого файла нет');
        }
        const src = backupPathInside(root, backupRel);
        // Копия принадлежит этому файлу: чужая копия не должна незаметно подменить содержимое.
        if (copyKeyOf(path.basename(src)) !== backupKey(abs, root)) {
          return notOk('эта копия от другого файла: восстановление отменено');
        }
        let bytes;
        try {
          bytes = readCapped(src, MAX_BACKUP_BYTES);
        } catch (err) {
          return notOk(err && err.code === 'TOO_BIG' ? 'копия больше 8 МБ: не читаю' : `копию не прочитать: ${err.message}`);
        }
        // Текущую версию тоже сохраняем: само восстановление должно быть отменяемым.
        if (fs.existsSync(abs)) {
          try {
            saveBackup(root, abs);
          } catch (err) {
            return notOk(`текущую версию не удалось сохранить, восстановление отменено: ${err.message}`);
          }
        }
        const dir = path.dirname(abs);
        fs.mkdirSync(dir, { recursive: true });
        // Атомарная запись, как у workspace_write: временный файл рядом, затем переименование.
        const tmp = path.join(dir, `.${path.basename(abs)}.${crypto.randomUUID()}.tmp`);
        try {
          fs.writeFileSync(tmp, bytes);
          fs.renameSync(tmp, abs);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        index.invalidate();
        return {
          ok: true,
          summary: 'восстановил из резервной копии',
          data: { path: relOf(abs), backup: backupRel, restored: true },
        };
      } catch (err) {
        return fail(err);
      }
    },
    // Проверка эффекта: файл на диске побайтно совпадает с восстановленной копией.
    async verify(args = {}, result = {}) {
      if (!result.data || !result.data.path || !result.data.backup) return { status: 'unknown', evidence: 'нет пути результата' };
      try {
        const abs = index.resolveInside(result.data.path);
        const src = backupPathInside(root, result.data.backup);
        const onDisk = fs.readFileSync(abs);
        const copy = fs.readFileSync(src);
        if (onDisk.equals(copy)) return { status: 'confirmed', evidence: `файл ${result.data.path} совпадает с копией` };
        return { status: 'failed', evidence: `файл ${result.data.path} отличается от копии` };
      } catch (err) {
        return { status: 'failed', evidence: 'не удалось сверить файл с копией' };
      }
    },
  };

  return [search, read, write, list, move, copy, mkdir, restore];
}

module.exports = { workspaceTools, writeTarget, reportsOnly, saveBackup, backupsFor, backupPathInside, backupName, BACKUPS_DIR };
