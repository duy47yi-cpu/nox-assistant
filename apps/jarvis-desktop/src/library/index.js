'use strict';

// Библиотека готовых команд: Python-скрипты из scripts/commands, описанные манифестами manifest-*.json.
// Скрипты локальные и без моделей. Их вызывают фразы в чате, редактор команд и инструменты модели.
const fs = require('fs');
const path = require('path');
const { spawn: defaultSpawn } = require('child_process');
const { ENABLED } = require('./access');

const RISKS = new Set(['T0', 'T1', 'T2']); // T3 в библиотеке не допускаем
const ID_RE = /^[a-z][a-z0-9_]{1,50}$/;
const ARG_RE = /^[a-z][a-z0-9_]{0,30}$/;
const MAX_OUTPUT = 4000;
// Библиотека — локальные файлы приложения, но и их читаем с пределами: огромный или чужой манифест
// не должен задерживать запуск и раздувать память. Те же пределы проверяет manifest-validator.
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_LIBRARY_ENTRIES = 512;

// Проверяет одну запись манифеста. Скрипт обязан лежать внутри папки библиотеки.
function validate(raw, commandsDir) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, title, category, phrases, script, args, risk, description } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof title !== 'string' || !title.trim()) return null;
  if (!RISKS.has(risk)) return null;
  if (typeof script !== 'string' || script.includes('..') || path.isAbsolute(script)) return null;
  const root = path.resolve(commandsDir);
  const abs = path.resolve(root, script);
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) return null;
  const argList = Array.isArray(args) ? args.filter((a) => typeof a === 'string' && ARG_RE.test(a)) : [];
  const phraseList = Array.isArray(phrases)
    ? phrases.filter((p) => typeof p === 'string' && p.trim()).slice(0, 4)
    : [];
  let source = '';
  try {
    if (fs.statSync(abs).size > MAX_SCRIPT_BYTES) return null;
    source = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  return {
    id,
    title: title.trim(),
    category: typeof category === 'string' && category.trim() ? category.trim() : 'прочее',
    phrases: phraseList,
    script: abs,
    args: argList,
    risk,
    description: typeof description === 'string' ? description : '',
    needsConfirm: source.includes('--confirm'),
  };
}

// Читает все manifest-*.json. Битые записи пропускает, дубли id отбрасывает,
// слишком большие файлы и лишние записи не читает (пределы — рядышком, в constants).
function loadLibrary(commandsDir, { enabled = ENABLED } = {}) {
  let files;
  try {
    files = fs.readdirSync(commandsDir).filter((f) => /^manifest-.*\.json$/.test(f));
  } catch {
    return [];
  }
  const items = [];
  const seen = new Set();
  outer: for (const file of files) {
    let list;
    try {
      const filePath = path.join(commandsDir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) continue;
      list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const entry = validate(raw, commandsDir);
      if (!entry || seen.has(entry.id)) continue;
      // В библиотеке только проверенные команды (см. access.js): остальные не попадают ни в фразы, ни в инструменты.
      if (enabled && !enabled.includes(entry.id)) continue;
      seen.add(entry.id);
      items.push(entry);
      if (items.length >= MAX_LIBRARY_ENTRIES) break outer;
    }
  }
  return items.sort((a, b) => a.category.localeCompare(b.category, 'ru') || a.title.localeCompare(b.title, 'ru'));
}

// Собирает аргументы командной строки. Значения передаются отдельными элементами, без shell.
function buildArgv(entry, values) {
  const argv = [entry.script];
  for (const name of entry.args) {
    const v = values ? values[name] : undefined;
    if (v === undefined || v === null || v === '') continue;
    argv.push(`--${name}`, String(v).slice(0, 500));
  }
  if (values && values.__confirm && entry.needsConfirm) argv.push('--confirm');
  return argv;
}

// Запускает скрипт. Возвращает {ok, code, output}. Таймаут 30 с.
function runEntry(entry, values, { signal, timeoutMs = 30000, spawnImpl = defaultSpawn, python = 'python' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(python, buildArgv(entry, values), {
        windowsHide: true,
        cwd: path.dirname(entry.script),
      });
    } catch (err) {
      resolve({ ok: false, code: -1, output: `не удалось запустить: ${err.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: -1, output: `таймаут ${timeoutMs} мс` });
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => child.kill(), { once: true });
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ ok: false, code: -1, output: err.message }));
    child.on('close', (code) => {
      const text = (stdout || stderr).trim().slice(0, MAX_OUTPUT);
      finish({ ok: code === 0, code, output: text });
    });
  });
}

// Инструменты для реестра: по одному на команду, риск берётся из манифеста.
function libraryTools(entries, runner = runEntry) {
  return entries.map((e) => ({
    name: `lib_${e.id}`,
    risk: e.risk,
    description: `${e.title}. ${e.description}`.trim(),
    parameters: {
      type: 'object',
      properties: Object.fromEntries(e.args.map((a) => [a, { type: 'string', maxLength: 500 }])),
    },
    async run(args, ctx) {
      const values = { ...(args || {}) };
      if (e.risk === 'T2') values.__confirm = true; // подтверждение уже получено у политики
      const res = await runner(e, values, { signal: ctx && ctx.signal });
      return { ok: res.ok, summary: res.output || (res.ok ? 'готово' : 'ошибка'), data: { output: res.output } };
    },
  }));
}

// Два инструмента для модели: список и запуск. Необратимые команды модели недоступны.
function libraryModelTools(entries, runner = runEntry) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return [
    {
      name: 'library_list',
      risk: 'T0',
      description: 'Список готовых команд библиотеки: id, название, категория, риск.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const list = entries.map((e) => ({ id: e.id, title: e.title, category: e.category, risk: e.risk }));
        return { ok: true, summary: `команд: ${list.length}`, data: { commands: list } };
      },
    },
    {
      name: 'library_run',
      risk: 'T1',
      description: 'Запустить готовую команду библиотеки по id. Необратимые команды здесь не запускаются.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 60 },
          args: { type: 'object' },
        },
        required: ['id'],
      },
      async run(args, ctx) {
        const entry = byId.get(String((args && args.id) || ''));
        if (!entry) return { ok: false, summary: 'такой команды нет в библиотеке', data: {} };
        if (entry.risk === 'T2') {
          return { ok: false, summary: 'необратимая команда: её запускает владелец из раздела «Команды»', data: {} };
        }
        const values = {};
        for (const [k, v] of Object.entries((args && args.args) || {})) {
          if (entry.args.includes(k)) values[k] = String(v);
        }
        const res = await runner(entry, values, { signal: ctx && ctx.signal });
        return { ok: res.ok, summary: res.output || (res.ok ? 'готово' : 'ошибка'), data: { output: res.output } };
      },
    },
  ];
}

module.exports = {
  loadLibrary, validate, buildArgv, runEntry, libraryTools, libraryModelTools,
  MAX_MANIFEST_BYTES, MAX_SCRIPT_BYTES, MAX_LIBRARY_ENTRIES,
};
