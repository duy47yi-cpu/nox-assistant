'use strict';

// Работа с исходниками внутри разрешённых папок: прочитать (T0), создать новый файл (T1), заменить один фрагмент (T1).
// Произвольный запуск кода — блокер. Единственное исключение — code_test: фиксированные команды тестов (белый список),
// shell: false, окружение без секретов. Это не песочница: тесты идут с правами владельца, о чём сказано в мандате.
//
// Граница — реальный путь. Относительный путь разрешается от базы (base — корень песочницы, как у workspace_* и проверок
// шагов; без base — от первой разрешённой папки), абсолютный — как есть. Затем
// через fs.realpathSync.native: у существующей части пути раскрываются symlink и junction, несуществующий хвост
// дописывается к ней. Результат должен лежать внутри реального пути одной из разрешённых папок (сравнение с
// разделителем: «папка2» не внутри «папка»). Ссылка, ведущая наружу, и ссылка в никуда — отказ.
// Это проверка путей в коде инструмента, а не изоляция ОС: процесс Джарвиса по-прежнему может больше.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CODE_EXTENSIONS = Object.freeze(['.js', '.ts', '.py', '.md', '.json', '.txt', '.css', '.html', '.yml', '.toml', '.rs']);
const MAX_PATH = 300;
const MAX_READ_BYTES = 20 * 1024;
const MAX_WRITE_BYTES = 200 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
// Служебные части пути, закрытые всегда: точечные (.env, .git, .claude) и node_modules.
const CLOSED_SEGMENT = (part) => part.startsWith('.') || part.toLowerCase() === 'node_modules';
// Данные Джарвиса (бюджет, задачи, журнал, память) закрыты всегда, даже если папка проекта указана в мандате:
// иначе задача могла бы поднять себе бюджет. Это папка по умолчанию (корень проекта\data); при NOX_DATA_DIR
// сборка передаёт свою папку в denyDirs.
// Корень считается как в main.js (paths.projectRoot): в установленном приложении — userData, в разработке — репозиторий.
// Вне Electron (тесты) require('electron') даёт строку, без app; тогда считается режим разработки.
const { projectRoot } = require('../config/paths');
const electronApp = (() => { try { return require('electron').app; } catch { return null; } })();
const PROJECT_ROOT = projectRoot(electronApp || { isPackaged: false }, path.resolve(__dirname, '..', '..'));
const BUILTIN_DENY_DIRS = Object.freeze([path.join(PROJECT_ROOT, 'data')]);
const EXEC_BLOCKER = 'Этот инструмент код не запускает; проверить его можно только тестами через code_test, если он есть в мандате.';
const TEST_TIMEOUT_MS = 120000;
const KILL_GRACE_MS = 3000;
// Наблюдение модели в исполнителе обрезается до 1500 символов с начала, а итог тестов — в конце вывода.
const MAX_TEST_OUTPUT = 1200;
// Только служебные пути: ни ключей, ни NOX_* дочерний процесс не получает.
const TEST_ENV_KEYS = ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'];
const TEST_RUNNERS = Object.freeze({
  node: { label: 'node --test', command: 'node', args: ['--test'] },
  npm: { label: 'npm test', noPath: true },
  pytest: { label: 'python -m pytest', command: 'python', args: ['-m', 'pytest'] },
  unittest: { label: 'python -m unittest', command: 'python', args: ['-m', 'unittest'] },
});
const CODE_APPROVAL_NOTE = 'Разрешение — мандат задачи, подтверждённый владельцем: только если инструмент есть в мандате и только в его папках.';

class CodePathError extends Error {
  constructor(message) {
    super(message);
    this.code = 'code_path_denied';
  }
}

const deny = (message) => { throw new CodePathError(message); };

const pathKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// abs совпадает с dir или лежит внутри. Префикс с разделителем: «ws2» не внутри «ws».
function isWithin(dir, abs) {
  const d = pathKey(path.resolve(dir));
  const a = pathKey(path.resolve(abs));
  if (a === d) return true;
  const prefix = d.endsWith(path.sep) ? d : d + path.sep;
  return a.startsWith(prefix);
}

function realpath(p) {
  return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

const clip = (s, n = 200) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

// Реальный путь abs: существующая часть — через realpath (раскрывает symlink и junction), несуществующий хвост
// дописывается. lstat не идёт по ссылке, поэтому битая ссылка считается существующей и realpath на ней падает.
function realOf(abs) {
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      fs.lstatSync(cur);
      break;
    } catch (err) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
      const parent = path.dirname(cur);
      if (parent === cur) deny('путь не найден ни на одном уровне');
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  let real;
  try {
    real = realpath(cur);
  } catch (err) {
    deny(`ссылка «${clip(cur)}» ведёт в несуществующее место`);
  }
  return { real: tail.length ? path.join(real, ...tail) : real, exists: tail.length === 0 };
}

function denyServiceDir(real, denyDirs, shown) {
  for (const d of [...BUILTIN_DENY_DIRS, ...denyDirs]) {
    if (typeof d !== 'string' || !d) continue;
    let realDeny = path.resolve(d);
    try { realDeny = realpath(d); } catch { /* нет папки — сравниваем как есть */ }
    if (isWithin(realDeny, real) || isWithin(path.resolve(d), real)) deny(`путь «${clip(shown)}» в служебной папке: закрыто`);
  }
}

// Проверка пути для инструментов кода. folders — разрешённые папки (абсолютные). base — от чего считается
// относительный путь: корень песочницы (так же считают workspace_*, проверки шагов и пути в поручениях);
// не передан — первая разрешённая папка. База прав не расширяет: путь всё равно должен лежать в одной из folders.
// denyDirs — служебные папки, закрытые даже внутри разрешённых (например, data Джарвиса).
// Возвращает {real, rel, folder, exists} или бросает CodePathError с понятной причиной.
// rel — путь от базы (как его пишет модель), если файл внутри базы; иначе — от разрешённой папки.
function resolveCodePath(folders, raw, { denyDirs = [], base } = {}) {
  if (!Array.isArray(folders) || folders.length === 0) deny('нет разрешённых папок для работы с кодом');
  for (const f of folders) {
    if (typeof f !== 'string' || !path.isAbsolute(f)) deny('разрешённая папка должна быть абсолютным путём');
  }
  if (base !== undefined && (typeof base !== 'string' || !path.isAbsolute(base))) {
    deny('база относительных путей должна быть абсолютным путём');
  }
  if (typeof raw !== 'string') deny('путь должен быть строкой');
  const rel = raw.trim();
  if (!rel) deny('пустой путь: укажите файл');
  if (rel.length > MAX_PATH) deny(`путь длиннее ${MAX_PATH} символов`);
  if (rel.includes('\0')) deny('в пути недопустимый символ');
  // Windows: «:» кроме буквы диска — альтернативный поток файла (a.txt:x.js); \\?\ и \\.\ — пространства устройств.
  if (process.platform === 'win32') {
    if (/^[\\/]{2}[?.][\\/]/.test(rel)) deny('пути устройств (\\\\?\\, \\\\.\\) не разрешены');
    if (rel.replace(/^[a-zA-Z]:/, '').includes(':')) deny('символ «:» в пути не разрешён (альтернативные потоки файла)');
  }
  const abs = path.resolve(base === undefined ? folders[0] : base, rel);
  if (!folders.some((f) => isWithin(f, abs))) deny(`путь «${clip(rel)}» вне разрешённых папок`);

  const realFolders = [];
  for (const f of folders) {
    try {
      realFolders.push(realpath(f));
    } catch {
      // Отсутствующая разрешённая папка ничего не разрешает.
    }
  }
  const { real, exists } = realOf(abs);
  const folder = realFolders.find((f) => isWithin(f, real));
  if (!folder) deny(`путь «${clip(rel)}» после раскрытия ссылок (symlink, junction) ведёт за пределы разрешённых папок`);

  denyServiceDir(real, denyDirs, rel);

  const relReal = path.relative(folder, real);
  const parts = relReal ? relReal.split(path.sep) : [];
  if (parts.some(CLOSED_SEGMENT)) deny('точечные папки и файлы (.env, .git) и node_modules закрыты');
  const ext = path.extname(real).toLowerCase();
  if (!CODE_EXTENSIONS.includes(ext) || path.extname(abs).toLowerCase() !== ext) {
    deny(`расширение «${path.extname(real) || 'нет'}» не разрешено; можно: ${CODE_EXTENSIONS.join(' ')}`);
  }
  let shown = parts.join('/');
  if (base !== undefined) {
    let realBase = path.resolve(base);
    try { realBase = realpath(base); } catch { /* нет базы — сравниваем как есть */ }
    if (isWithin(realBase, real)) shown = path.relative(realBase, real).split(path.sep).join('/');
  }
  return { real, rel: shown, folder, exists };
}

function hasNul(buf, limit = buf.length) {
  return buf.subarray(0, Math.min(limit, buf.length)).includes(0);
}

function fmtSize(bytes) {
  return bytes < 1024 ? `${bytes} байт` : `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} КБ`;
}

function lineCount(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function notOk(summary) {
  return { ok: false, summary, data: {} };
}

function errSummary(err) {
  if (err instanceof CodePathError) return `отказ: ${err.message}`;
  const code = err && err.code ? ` (${err.code})` : '';
  return `ошибка: ${err && err.message ? clip(err.message) : String(err)}${code}`;
}

// Существующий обычный файл без жёстких ссылок: правка файла с nlink > 1 изменила бы и другое имя этого файла,
// которое может лежать вне разрешённых папок.
function statFile(real) {
  const st = fs.statSync(real);
  if (!st.isFile()) return { error: 'это не файл' };
  if (st.nlink > 1) return { error: 'у файла несколько жёстких ссылок (hard link): закрыто' };
  return { st };
}

function testEnv() {
  const env = {};
  for (const key of TEST_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

// shortcut: npm ищется только рядом с node (установка Windows и nvm), при другой раскладке честный отказ.
// npm.cmd без shell на Windows не запустить, поэтому идём прямо в его npm-cli.js.
function npmCli(env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (dir && fs.existsSync(cli)) return cli;
  }
  return null;
}

// Windows не убивает потомков вместе с родителем, а node --test и npm их запускают.
function killTree(child) {
  if (process.platform !== 'win32' || !child.pid) {
    child.kill('SIGKILL');
    return;
  }
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, shell: false });
  killer.on('error', () => child.kill('SIGKILL'));
}

function runTests(command, args, { cwd, env, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let output = '';
    let stoppedBy = null;
    let child;
    let settled = false;
    const collect = (chunk) => { output = (output + chunk.toString('utf8')).slice(-MAX_TEST_OUTPUT * 2); };
    const finish = (exitCode, startError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ exitCode, stoppedBy, startError, output: output.slice(-MAX_TEST_OUTPUT), truncated: output.length > MAX_TEST_OUTPUT });
    };
    const halt = (why) => {
      stoppedBy = why;
      killTree(child);
      // Внук мог удержать вывод, и close тогда не придёт.
      setTimeout(() => finish(null), KILL_GRACE_MS);
    };
    const onAbort = () => halt('остановлено');
    const timer = setTimeout(() => halt('время вышло'), timeoutMs);
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish(null, err);
      return;
    }
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal && signal.aborted) onAbort();
  });
}

// roots — массив абсолютных папок или функция (ctx) → массив (папки мандата задачи по ctx.taskId).
// base — корень песочницы (абсолютный): от него считаются относительные пути, как у workspace_* и проверок шагов.
// denyDirs — служебные папки внутри разрешённых, которые закрыты всегда (data Джарвиса и т. п.).
function codeTools({ roots, denyDirs = [], base, backupRoot = null, testTimeoutMs = TEST_TIMEOUT_MS } = {}) {
  if (!Array.isArray(roots) && typeof roots !== 'function') {
    throw new Error('codeTools: нужны разрешённые папки (roots) — массив или функция (ctx) → массив');
  }
  if (typeof base !== 'string' || !path.isAbsolute(base)) {
    throw new Error('codeTools: нужна база относительных путей (base) — абсолютный путь корня песочницы');
  }
  const foldersFor = (ctx) => {
    const list = typeof roots === 'function' ? roots(ctx || {}) : roots;
    return Array.isArray(list) ? list : [];
  };
  const locate = (args, ctx) => resolveCodePath(foldersFor(ctx), args && args.path, { denyDirs, base });

  const read = {
    name: 'code_read',
    description: 'Прочитать текстовый исходник (.js .ts .py .md .json .txt .css .html .yml .toml .rs) внутри разрешённых папок. '
      + `Путь — относительно песочницы, как у workspace_*. Больше 20 КБ обрезается, бинарные файлы не читаются. ${EXEC_BLOCKER}`,
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1, maxLength: MAX_PATH } },
      required: ['path'],
    },
    async run(args = {}, ctx = {}) {
      try {
        const loc = locate(args, ctx);
        if (!loc.exists) return notOk(`файл «${loc.rel}» не найден`);
        const { st, error } = statFile(loc.real);
        if (error) return notOk(`${loc.rel}: ${error}`);
        const want = Math.min(st.size, MAX_READ_BYTES);
        const buf = Buffer.alloc(want);
        const fd = fs.openSync(loc.real, 'r');
        let got = 0;
        try {
          got = fs.readSync(fd, buf, 0, want, 0);
        } finally {
          fs.closeSync(fd);
        }
        const bytes = buf.subarray(0, got);
        if (hasNul(bytes, BINARY_SNIFF_BYTES)) return notOk(`${loc.rel}: бинарный файл (NUL в первых 8 КБ), не читаю`);
        const truncated = st.size > MAX_READ_BYTES;
        let text = bytes.toString('utf8');
        if (truncated) text = text.replace(/\uFFFD+$/, ''); // обрезка могла разорвать многобайтовый символ
        const summary = truncated
          ? `${loc.rel}: показаны первые 20 КБ из ${fmtSize(st.size)} (обрезано)`
          : `${loc.rel}: прочитано ${fmtSize(st.size)}, строк ${lineCount(text)}`;
        return { ok: true, summary, data: { path: loc.rel, folder: loc.folder, text, size: st.size, truncated } };
      } catch (err) {
        return notOk(errSummary(err));
      }
    },
  };

  const write = {
    name: 'code_write',
    description: 'Создать НОВЫЙ текстовый исходник внутри разрешённых папок (папки по пути создаются). Путь — относительно '
      + 'песочницы, как у workspace_*. Существующий файл не перезаписывается — его меняют через code_edit. До 200 КБ, без NUL. '
      + `${CODE_APPROVAL_NOTE} ${EXEC_BLOCKER}`,
    risk: 'T1',
    // Подтверждение — мандатом задачи (его подтверждает владелец): инструмент доступен, только если он назван в мандате,
    // и только в папках мандата (checkTool и resolveCodePath). Отдельного вопроса на каждый вызов нет.
    requiresApproval: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        content: { type: 'string', maxLength: MAX_WRITE_BYTES },
      },
      required: ['path', 'content'],
    },
    async run(args = {}, ctx = {}) {
      try {
        if (typeof args.content !== 'string') return notOk('содержимое должно быть строкой');
        const data = Buffer.from(args.content, 'utf8');
        if (data.length > MAX_WRITE_BYTES) return notOk(`содержимое ${fmtSize(data.length)}: больше 200 КБ не пишу`);
        if (hasNul(data)) return notOk('содержимое с NUL — бинарные данные не пишу');
        const loc = locate(args, ctx);
        if (loc.exists) return notOk(`файл «${loc.rel}» уже есть: не перезаписываю, меняйте его через code_edit`);
        const dir = path.dirname(loc.real);
        fs.mkdirSync(dir, { recursive: true });
        // Повторная проверка после создания папок: реальный путь папки по-прежнему внутри разрешённой.
        if (!isWithin(loc.folder, realpath(dir))) return notOk('отказ: папка назначения после создания ведёт за пределы разрешённой');
        // wx: файл только создаётся; если он (или ссылка с таким именем) появился между проверкой и записью — ошибка.
        fs.writeFileSync(loc.real, data, { flag: 'wx' });
        const summary = `создан ${loc.rel}: ${fmtSize(data.length)}, строк ${lineCount(args.content)}`;
        return { ok: true, summary, data: { path: loc.rel, folder: loc.folder, bytes: data.length, created: true } };
      } catch (err) {
        if (err && err.code === 'EEXIST') return notOk('файл уже есть: не перезаписываю, меняйте его через code_edit');
        return notOk(errSummary(err));
      }
    },
    // Проверка: на диске именно те байты, что записаны.
    async verify(args = {}, result = {}, ctx = {}) {
      const loc = locate(args, ctx);
      if (!loc.exists) return { status: 'failed', evidence: `файла ${loc.rel} нет на диске` };
      if (fs.readFileSync(loc.real).equals(Buffer.from(args.content, 'utf8'))) {
        return { status: 'confirmed', evidence: `файл ${loc.rel} совпадает с записью` };
      }
      return { status: 'failed', evidence: `файл ${loc.rel} на диске отличается от записи` };
    },
  };

  const edit = {
    name: 'code_edit',
    description: 'Заменить в существующем текстовом исходнике ровно один фрагмент: old_string должен встречаться в файле ровно '
      + 'один раз (иначе отказ — уточните фрагмент), new_string ставится вместо него. Путь — относительно песочницы, как у '
      + `workspace_*. Файл и результат до 200 КБ. ${CODE_APPROVAL_NOTE} ${EXEC_BLOCKER}`,
    risk: 'T1',
    requiresApproval: false, // как у code_write: подтверждение — мандатом задачи
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        old_string: { type: 'string', minLength: 1, maxLength: MAX_WRITE_BYTES },
        new_string: { type: 'string', maxLength: MAX_WRITE_BYTES },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async run(args = {}, ctx = {}) {
      try {
        const oldS = args.old_string;
        const newS = args.new_string;
        if (typeof oldS !== 'string' || oldS === '') return notOk('old_string — непустая строка');
        if (typeof newS !== 'string') return notOk('new_string должен быть строкой');
        if (oldS === newS) return notOk('old_string и new_string совпадают: менять нечего');
        if (newS.includes('\0')) return notOk('new_string с NUL — бинарные данные не пишу');
        const loc = locate(args, ctx);
        if (!loc.exists) return notOk(`файл «${loc.rel}» не найден: новый файл создаётся через code_write`);
        const { st, error } = statFile(loc.real);
        if (error) return notOk(`${loc.rel}: ${error}`);
        if (st.size > MAX_WRITE_BYTES) return notOk(`${loc.rel}: файл ${fmtSize(st.size)}, правлю только до 200 КБ`);
        const before = fs.readFileSync(loc.real);
        if (hasNul(before, BINARY_SNIFF_BYTES)) return notOk(`${loc.rel}: бинарный файл (NUL в первых 8 КБ), не правлю`);
        const text = before.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(before)) return notOk(`${loc.rel}: файл не в UTF-8, правка исказила бы его`);
        // Все вхождения, включая перекрывающиеся: «ровно один раз» без исключений.
        let count = 0;
        let at = -1;
        for (let i = text.indexOf(oldS); i !== -1; i = text.indexOf(oldS, i + 1)) {
          count += 1;
          if (at === -1) at = i;
          if (count > 1) break;
        }
        if (count === 0) {
          const crlf = text.includes('\r\n') && oldS.includes('\n') && !oldS.includes('\r\n');
          return notOk(`${loc.rel}: фрагмент old_string не найден${crlf ? ' (в файле переводы строк CRLF, во фрагменте — LF)' : ''}; файл не изменён`);
        }
        if (count > 1) {
          return notOk(`${loc.rel}: фрагмент old_string встречается больше одного раза; нужно ровно одно вхождение — добавьте окружающий текст; файл не изменён`);
        }
        // Склейка, а не String.replace: «$&» и «$1» в new_string остаются как есть.
        const result = text.slice(0, at) + newS + text.slice(at + oldS.length);
        const after = Buffer.from(result, 'utf8');
        if (after.length > MAX_WRITE_BYTES) return notOk(`${loc.rel}: после правки ${fmtSize(after.length)}, больше 200 КБ не пишу`);
        let backup = null;
        if (backupRoot) {
          backup = require('./workspace').saveBackup(backupRoot, loc.real).rel;
          if (!fs.readFileSync(path.join(backupRoot, backup)).equals(before) || !fs.readFileSync(loc.real).equals(before)) {
            return notOk(`${loc.rel}: файл изменился во время подготовки правки; попробуйте снова`);
          }
        }
        const dir = path.dirname(loc.real);
        const tmp = path.join(dir, `.${path.basename(loc.real)}.${crypto.randomUUID()}.tmp`);
        try {
          fs.writeFileSync(tmp, after, { flag: 'wx' });
          fs.renameSync(tmp, loc.real);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        const line = text.slice(0, at).split('\n').length;
        const summary = `изменён ${loc.rel}: 1 замена (строка ${line}), было ${fmtSize(before.length)}, стало ${fmtSize(after.length)}`;
        return {
          ok: true,
          summary,
          data: { path: loc.rel, folder: loc.folder, replacements: 1, line, bytesBefore: before.length, bytesAfter: after.length,
            sha256After: crypto.createHash('sha256').update(after).digest('hex'), ...(backup ? { backup } : {}) },
        };
      } catch (err) {
        return notOk(errSummary(err));
      }
    },
    // Подтверждаем точные байты результата, а не случайное совпадение фрагмента.
    async verify(args = {}, result = {}, ctx = {}) {
      const loc = locate(args, ctx);
      if (!loc.exists) return { status: 'failed', evidence: `файла ${loc.rel} нет на диске` };
      const want = result.data && result.data.bytesAfter;
      const expectedHash = result.data && result.data.sha256After;
      if (!Number.isInteger(want) || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) return { status: 'unknown', evidence: 'нет данных для проверки содержимого' };
      const stat = fs.statSync(loc.real);
      if (stat.size !== want) return { status: 'failed', evidence: `${loc.rel}: размер ${stat.size} байт, ожидалось ${want}` };
      const now = fs.readFileSync(loc.real);
      if (now.length !== want || crypto.createHash('sha256').update(now).digest('hex') !== expectedHash) return { status: 'failed', evidence: `${loc.rel}: содержимое отличается от результата правки` };
      return { status: 'confirmed', evidence: `${loc.rel}: правка на месте` };
    },
  };

  const test = {
    name: 'code_test',
    description: 'Запустить тесты: runner node (node --test), npm (npm test), pytest (python -m pytest) или unittest (python -m unittest). '
      + 'Других команд и аргументов нет. path — необязательный файл теста внутри папок мандата (кроме npm), относительно песочницы; '
      + 'без него — вся первая папка мандата. Рабочая папка — папка мандата, до 120 с. Итог — код выхода и конец вывода; '
      + `после падения поправь код через code_edit и запусти снова. Запускает код с правами владельца, это не песочница. ${CODE_APPROVAL_NOTE}`,
    risk: 'T2',
    requiresApproval: false, // как у code_write: подтверждение — мандатом задачи
    parameters: {
      type: 'object',
      properties: {
        runner: { type: 'string', enum: Object.keys(TEST_RUNNERS) },
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
      },
      required: ['runner'],
    },
    async run(args = {}, ctx = {}) {
      try {
        const runner = Object.hasOwn(TEST_RUNNERS, args.runner) ? TEST_RUNNERS[args.runner] : null;
        if (!runner) return notOk(`неизвестный запуск тестов; можно: ${Object.keys(TEST_RUNNERS).join(', ')}`);
        if (args.path !== undefined && runner.noPath) return notOk(`${runner.label} запускается без файла: уберите path`);
        const extra = [];
        let cwd;
        if (args.path !== undefined) {
          const loc = locate(args, ctx);
          if (!loc.exists) return notOk(`файл «${loc.rel}» не найден`);
          const rel = path.relative(loc.folder, loc.real);
          // Имя с минусом запускалось бы как ключ команды.
          if (!rel || rel.startsWith('-')) return notOk(`файл «${loc.rel}»: такое имя не запускаю`);
          cwd = loc.folder;
          extra.push(rel);
        } else {
          const [first] = foldersFor(ctx);
          if (!first) deny('нет разрешённых папок для работы с кодом');
          if (!fs.existsSync(first)) return notOk('папки мандата нет на диске');
          cwd = realpath(first);
          denyServiceDir(cwd, denyDirs, first);
        }
        const env = testEnv();
        let { command, args: fixed } = runner;
        if (args.runner === 'npm') {
          const cli = npmCli(env);
          if (!cli) return notOk('npm не найден рядом с node');
          command = 'node';
          fixed = [cli, 'test'];
        }
        const out = await runTests(command, [...fixed, ...extra], { cwd, env, timeoutMs: testTimeoutMs, signal: ctx.signal });
        if (out.startError) return notOk(`${runner.label}: не удалось запустить (${out.startError.code || out.startError.message})`);
        if (out.stoppedBy) return { ok: false, summary: `${runner.label}: ${out.stoppedBy}, процесс снят`, data: { exitCode: null, output: out.output, truncated: out.truncated } };
        return {
          ok: true,
          summary: `${runner.label}: код выхода ${out.exitCode}`,
          data: { command: runner.label, cwd, exitCode: out.exitCode, output: out.output, truncated: out.truncated },
        };
      } catch (err) {
        return notOk(errSummary(err));
      }
    },
    async verify(args = {}, result = {}) {
      const code = result.data && result.data.exitCode;
      return code === 0
        ? { status: 'confirmed', evidence: 'код выхода 0' }
        : { status: 'failed', evidence: `тесты не прошли: код выхода ${code}` };
    },
  };

  return [read, write, edit, test];
}

const CODE_TOOL_NAMES = Object.freeze(['code_read', 'code_write', 'code_edit', 'code_test']);

// Чат использует ту же проверку путей, но разрешение на каждый вызов
// определяется выбранным режимом, а не мандатом фоновой задачи.
function chatCodeTools({ root, denyDirs = [], index = null } = {}) {
  const descriptions = {
    code_read: 'Прочитать текст исходника в рабочей папке; большие файлы обрезаются.',
    code_write: 'Создать новый текстовый исходник в рабочей папке. Существующий файл меняй через code_edit.',
    code_edit: 'Изменить единственное точное вхождение old_string в существующем исходнике внутри рабочей папки.',
    code_test: 'Запустить тесты рабочей папки через node, npm, pytest или unittest. Тесты выполняются с правами владельца; результат показывает код выхода.',
  };
  return codeTools({ roots: [root], base: root, backupRoot: root, denyDirs }).map((tool) => ({
    ...tool, description: descriptions[tool.name], requiresApproval: true,
    async run(args, ctx) {
      const result = await tool.run(args, ctx);
      if (result.ok && (tool.name === 'code_write' || tool.name === 'code_edit') && index) index.invalidate();
      return result;
    },
  }));
}

module.exports = {
  codeTools, chatCodeTools, resolveCodePath, CodePathError, CODE_TOOL_NAMES, CODE_EXTENSIONS,
  MAX_READ_BYTES, MAX_WRITE_BYTES, BINARY_SNIFF_BYTES, EXEC_BLOCKER, BUILTIN_DENY_DIRS,
};
