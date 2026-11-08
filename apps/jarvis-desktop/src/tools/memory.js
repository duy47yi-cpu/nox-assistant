'use strict';

// Инструменты долговременной памяти: запомнить (T0), вспомнить (T0), всё про имя (T0), забыть (T2).
// Работают через MemoryStore; любая ошибка возвращается как {ok: false, summary}.
// Кроме текста запись может ссылаться на файл-источник: путь проверяется внутри рабочей папки,
// хранится sha256, а recall/memory_about каждый раз проверяют файл заново, а не верят записи.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MAX_TEXT, MAX_ABOUT, MAX_SOURCE_PATH, MAX_QUOTE, isExpired } = require('../memory/store');

// profile и agreement не протухают по давности: профиль читается всегда, договорённость — пока её не сняли или не вышел until.
const KINDS = ['note', 'preference', 'fact', 'task', 'agreement', 'contact', 'profile'];
const MAX_QUERY = 200;
const MAX_ID = 100;
const DEFAULT_RECALL_LIMIT = 5;
const MAX_RECALL_LIMIT = 20;
// Файл-источник: больше не читаем и ссылку не принимаем. Тот же предел у проверки в recall.
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const VIEW_FIELDS = ['text', 'kind', 'createdAt', 'about', 'links', 'until', 'sensitive', 'source'];

// Сравнение без регистра, «ё», знаков препинания и лишних пробелов.
function normalizeWords(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Текст записи целиком есть в сообщении владельца этого хода (по словам, не по кускам слов).
// Текст со страниц и из файлов в сообщение владельца не входит, поэтому такая запись всегда с вопросом.
function saidByOwner(text, ownerText) {
  const t = normalizeWords(text);
  return Boolean(t) && ` ${normalizeWords(ownerText)} `.includes(` ${t} `);
}

function fail(err) {
  return { ok: false, summary: err && err.message ? err.message : String(err), data: {} };
}

// modes.js сам требует этот файл ради saidByOwner; require на загрузке дал бы цикл,
// поэтому проверку пути берём лениво, когда оба модуля уже загружены.
function pathInsideWorkspace(rel, workspace) {
  return require('../policy/modes').insideWorkspace({ path: rel }, workspace);
}

function workspaceOf(ctx) {
  return ctx && typeof ctx.workspace === 'string' ? ctx.workspace : '';
}

// Ссылка может стоять и в середине пути: lstat видит только последний компонент,
// а junction в папке уводит наружу. Раскрываем настоящий путь и проверяем его снова.
function leadsOutside(abs, workspace) {
  try {
    const realRoot = fs.realpathSync(path.resolve(workspace));
    return !pathInsideWorkspace(fs.realpathSync(abs), realRoot);
  } catch {
    return true;
  }
}

function sha256Of(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function tooBigError() {
  const err = new Error('файл больше лимита');
  err.code = 'TOO_BIG';
  return err;
}

// Читает файл не больше limit байт. Размер проверяется по открытому дескриптору, чтение ограничено:
// файл, выросший между lstat и чтением, не выделит памяти больше лимита.
function readCapped(abs, limit) {
  const fd = fs.openSync(abs, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('источник не обычный файл');
    if (st.size > limit) throw tooBigError();
    const buf = Buffer.allocUnsafe(st.size + 1);
    let used = 0;
    while (used < buf.length) {
      const n = fs.readSync(fd, buf, used, buf.length - used, null);
      if (!n) break;
      used += n;
    }
    if (used > limit) throw tooBigError();
    return buf.subarray(0, used);
  } finally {
    fs.closeSync(fd);
  }
}

// Относительный путь от рабочей папки через «/»: такой путь остаётся понятным и после переноса папки.
function relativePath(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

// Готовит проверяемую ссылку на файл-источник по ctx.workspace.
// Отказ честный и без записи: чужой путь, ссылка, папка, слишком большой или нечитаемый файл.
function prepareSource(rawSource, rawQuote, ctx) {
  if (typeof rawSource !== 'string') return { ok: false, summary: 'источник: нужен путь строкой' };
  const value = rawSource.trim();
  if (!value) return { ok: false, summary: 'пустой путь источника' };
  if (value.length > MAX_SOURCE_PATH) {
    return { ok: false, summary: `путь источника длиннее ${MAX_SOURCE_PATH} символов` };
  }
  const workspace = workspaceOf(ctx);
  if (!workspace) return { ok: false, summary: 'источник: не известна рабочая папка' };
  if (!pathInsideWorkspace(value, workspace)) return { ok: false, summary: `источник вне рабочей папки: ${value}` };
  const root = path.resolve(workspace);
  const abs = path.resolve(root, value);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, summary: `файла-источника нет: ${value}` };
    return { ok: false, summary: `источник не проверить: ${err.message}` };
  }
  // Ссылка может увести за пределы рабочей папки, поэтому источник — только настоящий файл.
  if (st.isSymbolicLink()) return { ok: false, summary: `источник — ссылка, а не обычный файл: ${value}` };
  if (!st.isFile()) return { ok: false, summary: `источник не обычный файл: ${value}` };
  if (leadsOutside(abs, workspace)) return { ok: false, summary: `источник ведёт за пределы рабочей папки: ${value}` };
  if (st.size > MAX_SOURCE_BYTES) return { ok: false, summary: `файл-источник больше 8 МБ: ${value}` };
  let bytes;
  try {
    bytes = readCapped(abs, MAX_SOURCE_BYTES);
  } catch (err) {
    if (err.code === 'TOO_BIG') return { ok: false, summary: `файл-источник больше 8 МБ: ${value}` };
    return { ok: false, summary: `источник не прочитать: ${err.message}` };
  }
  const source = {
    path: relativePath(root, abs),
    sha256: sha256Of(bytes),
    size: bytes.length,
    at: new Date().toISOString(),
  };
  if (rawQuote === undefined || rawQuote === null) return { ok: true, source };
  if (typeof rawQuote !== 'string') return { ok: false, summary: 'цитата: нужна строка' };
  const quote = rawQuote.trim();
  if (!quote) return { ok: true, source };
  if (Array.from(quote).length > MAX_QUOTE) {
    return { ok: false, summary: `цитата длиннее ${MAX_QUOTE} символов` };
  }
  source.quote = quote;
  return { ok: true, source };
}

// Проверяемое сейчас состояние источника: читаем файл заново и сравниваем с сохранённым sha256.
// Записи не доверяем: путь тоже проверяется на выход из рабочей папки.
function checkSource(source, ctx) {
  const checkedAt = new Date().toISOString();
  const unverified = (summary) => ({ state: 'unverified', summary, checkedAt });
  if (!source || typeof source !== 'object' || typeof source.path !== 'string' || !source.path) {
    return unverified('проверить не удалось: у записи нет пути источника');
  }
  const workspace = workspaceOf(ctx);
  if (!workspace) return unverified('проверить не удалось: нет рабочей папки');
  if (!pathInsideWorkspace(source.path, workspace)) {
    return unverified('проверить не удалось: путь источника вне рабочей папки');
  }
  const abs = path.resolve(path.resolve(workspace), source.path);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'missing', summary: 'файла нет', checkedAt };
    return unverified(`проверить не удалось: ${err.message}`);
  }
  if (st.isSymbolicLink() || !st.isFile()) return unverified('проверить не удалось: источник не обычный файл');
  if (leadsOutside(abs, workspace)) return unverified('проверить не удалось: путь источника ведёт за пределы рабочей папки');
  if (st.size > MAX_SOURCE_BYTES) return unverified('проверить не удалось: файл больше 8 МБ');
  let bytes;
  try {
    bytes = readCapped(abs, MAX_SOURCE_BYTES);
  } catch (err) {
    if (err.code === 'TOO_BIG') return unverified('проверить не удалось: файл больше 8 МБ');
    return unverified(`проверить не удалось: ${err.message}`);
  }
  if (sha256Of(bytes) !== source.sha256) return { state: 'changed', summary: 'файл изменился', checkedAt };
  return { state: 'unchanged', summary: 'файл на месте, не менялся', checkedAt };
}

// Поля записи для ответа: необязательные, которых нет в записи, не добавляем.
function view(record) {
  return Object.fromEntries(VIEW_FIELDS.filter((k) => record[k] !== undefined).map((k) => [k, record[k]]));
}

// Ответ с проверкой источника. Текст записи не подменяем: состояние файла — отдельное поле sourceState.
function viewWithSource(record, ctx) {
  const out = view(record);
  if (record.source) out.sourceState = checkSource(record.source, ctx);
  return out;
}

function memoryTools(store) {
  if (!store || typeof store.add !== 'function') {
    throw new Error('memoryTools: нужен экземпляр MemoryStore');
  }

  const remember = {
    name: 'remember',
    description: 'Запомнить заметку, предпочтение, факт или задачу для последующего поиска. Вид profile — профиль владельца: как к нему обращаться, чем занимается; такая запись читается всегда и не протухает. Запись profile и agreement без вопроса, только если text — слова владельца из его сообщения («зови меня Абду»); иначе с подтверждением владельца. Можно приложить source — путь к файлу-источнику внутри рабочей папки: сохранится sha256, размер и время, а recall и memory_about потом покажут, на месте ли файл и не изменился ли он. quote — необязательная дословная цитата из этого файла.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: MAX_TEXT },
        kind: { type: 'string', enum: KINDS },
        about: { type: 'string', maxLength: MAX_ABOUT, description: 'о ком или о чём: человек, проект, адрес' },
        links: { type: 'array', items: { type: 'string', maxLength: MAX_ABOUT }, description: 'about других записей, связи' },
        until: { type: 'string', description: 'дата, после которой запись устаревает, например 2026-12-31' },
        sensitive: { type: 'boolean', description: 'паспорт, деньги, здоровье' },
        source: { type: 'string', maxLength: MAX_SOURCE_PATH, description: 'путь к файлу-источнику внутри рабочей папки; запись будет ссылаться на него с проверкой sha256' },
        quote: { type: 'string', maxLength: MAX_QUOTE, description: 'дословная цитата из файла-источника (необязательно)' },
      },
      required: ['text'],
    },
    async run(args = {}, ctx) {
      try {
        if (args.kind !== undefined && !KINDS.includes(args.kind)) {
          return { ok: false, summary: `вид записи: ${KINDS.join(', ')}`, data: {} };
        }
        let source;
        if (args.source !== undefined && args.source !== null && String(args.source).trim() !== '') {
          const prepared = prepareSource(args.source, args.quote, ctx);
          if (!prepared.ok) return { ok: false, summary: prepared.summary, data: {} };
          source = prepared.source;
        } else if (args.quote !== undefined && args.quote !== null && String(args.quote).trim() !== '') {
          // Цитата без источника ничего не подтверждает: принимаем только вместе с файлом.
          return { ok: false, summary: 'цитата допустима только вместе с источником', data: {} };
        }
        const conflicts = store.conflicts({ text: args.text, about: args.about });
        const record = store.add({
          text: args.text,
          kind: args.kind,
          about: args.about,
          links: args.links,
          until: args.until,
          sensitive: args.sensitive === true,
          source,
        });
        const data = { id: record.id, kind: record.kind };
        if (record.source) data.source = record.source;
        if (conflicts.length) {
          // Старую запись не трогаем: решает владелец.
          data.warning = `возможно противоречит записи ${conflicts.map((c) => c.id).join(', ')}; старая не удалена`;
          return { ok: true, summary: `запомнил; ${data.warning}`, data };
        }
        return { ok: true, summary: 'запомнил', data };
      } catch (err) {
        return fail(err);
      }
    },
    // Хранилища читают файл при каждом обращении, поэтому повторное чтение — настоящая сверка с диском.
    // Если была ссылка на файл, сверяем ещё и sha256: изменившийся или пропавший источник не подтверждаем.
    async verify(args, result, ctx) {
      const id = result && result.data ? result.data.id : undefined;
      const record = id ? store.get(id) : null;
      if (!record) return { status: 'failed', evidence: 'записи нет в файле памяти' };
      if (!record.source) return { status: 'confirmed', evidence: 'запись есть в файле памяти' };
      const state = checkSource(record.source, ctx);
      if (state.state === 'unchanged') {
        return { status: 'confirmed', evidence: `запись есть в файле памяти; ${state.summary}: ${record.source.path}, sha256 сходится` };
      }
      if (state.state === 'changed') {
        return { status: 'failed', evidence: `запись есть, но файл-источник изменился: ${record.source.path}` };
      }
      if (state.state === 'missing') {
        return { status: 'failed', evidence: `запись есть, но файла-источника нет: ${record.source.path}` };
      }
      return { status: 'unknown', evidence: `запись есть, но источник проверить не удалось: ${state.summary}` };
    },
  };

  const recall = {
    name: 'recall',
    description: 'Найти в памяти записи о владельце и его делах по словам запроса. У записей с файлом-источником поле sourceState — проверка прямо сейчас: файл на месте, изменился или пропал; ссылайся на источник по полю source.path.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RECALL_LIMIT },
        includeExpired: { type: 'boolean', description: 'показать просроченные записи, только если владелец попросил' },
        includeSensitive: { type: 'boolean', description: 'показать паспорт, деньги, здоровье, только если владелец попросил' },
      },
      required: ['query'],
    },
    async run(args = {}, ctx) {
      try {
        const query = String(args.query ?? '').trim();
        if (!query) return { ok: false, summary: 'пустой запрос', data: {} };
        if (query.length > MAX_QUERY) {
          return { ok: false, summary: `запрос длиннее ${MAX_QUERY} символов`, data: {} };
        }
        let limit = DEFAULT_RECALL_LIMIT;
        if (args.limit !== undefined) {
          limit = Number(args.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECALL_LIMIT) {
            return { ok: false, summary: `limit от 1 до ${MAX_RECALL_LIMIT}`, data: {} };
          }
        }
        const opts = { includeExpired: args.includeExpired === true, includeSensitive: args.includeSensitive === true };
        const found = store.search(query, limit, opts);
        return {
          ok: true,
          summary: `найдено записей: ${found.length}`,
          data: found.map((record) => viewWithSource(record, ctx)),
        };
      } catch (err) {
        return fail(err);
      }
    },
  };

  const about = {
    name: 'memory_about',
    description: 'Записи памяти про человека, проект или вещь и явно связанные записи; устаревшие отмечены expired, чувствительные скрыты. У записей с файлом-источником поле sourceState — проверка прямо сейчас: файл на месте, изменился или пропал.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: MAX_ABOUT },
      },
      required: ['name'],
    },
    async run(args = {}, ctx) {
      try {
        const name = String(args.name ?? '').trim();
        if (!name) return { ok: false, summary: 'пустое имя', data: {} };
        const found = store.about(name);
        return {
          ok: true,
          summary: `записей: ${found.length}`,
          data: found.map((record) => {
            const item = { id: record.id, ...view(record), expired: isExpired(record) };
            if (record.source) item.sourceState = checkSource(record.source, ctx);
            return item;
          }),
        };
      } catch (err) {
        return fail(err);
      }
    },
  };

  const forget = {
    name: 'forget',
    description: 'Убрать запись из текущей памяти по id. Запись не стирается безвозвратно: помечается забытой с причиной и остаётся в истории, но recall, memory_about и профиль её больше не показывают.',
    risk: 'T2',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: MAX_ID },
        reason: { type: 'string', maxLength: 200, description: 'почему забыть (необязательно, остаётся в истории)' },
      },
      required: ['id'],
    },
    async run(args = {}) {
      try {
        const id = String(args.id ?? '').trim();
        if (!id) return { ok: false, summary: 'пустой id', data: {} };
        const record = store.get(id);
        if (!record) return { ok: false, summary: 'такой записи нет', data: { forgotten: false } };
        if (record.forgottenAt) {
          return { ok: true, summary: 'уже забыто (осталось в истории)', data: { forgotten: true, at: record.forgottenAt } };
        }
        const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 200) : '';
        const at = new Date().toISOString();
        store.update(id, { forgottenAt: at, ...(reason ? { forgetReason: reason } : {}) });
        return {
          ok: true,
          summary: reason ? `забыл (в истории, причина: ${reason})` : 'забыл (осталось в истории)',
          data: { forgotten: true, at, ...(reason ? { reason } : {}) },
        };
      } catch (err) {
        return fail(err);
      }
    },
    // Проверка: запись не удалена, но помечена забытой и больше не попадает в текущую память.
    async verify(args) {
      const record = store.get(String(args.id).trim());
      if (!record) return { status: 'confirmed', evidence: 'записи нет в файле памяти' };
      if (record.forgottenAt) return { status: 'confirmed', evidence: `запись помечена забытой (${record.forgottenAt}), осталась в истории` };
      return { status: 'failed', evidence: 'запись всё ещё считается текущей' };
    },
  };

  return [remember, recall, forget, about];
}

module.exports = { memoryTools, saidByOwner };
