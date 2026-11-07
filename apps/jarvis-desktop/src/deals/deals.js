'use strict';

// Память дел: то, что поручено или обещано и может повиснуть.
// Главный источник — задачи, напоминания, миссии и журнал; дело хранит только ссылку (ref) и состояние.
// deals.jsonl — события, только дописывание. deals.json — снимок с номером последнего события:
// при загрузке к нему применяются более новые события, битый снимок собирается из них заново.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TAIL_BYTES = 256 * 1024;
const STALE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATES = ['started', 'waiting', 'promised', 'failed', 'done', 'cleared'];
const HANGING_PHRASE = /^(что|чего|что у нас|что там)\s+(повисло|висит|зависло)[\s?!.]*$/i;

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return parseLines(raw);
}

// Битая строка (сбой на середине записи) не должна лишать остальных записей.
function parseLines(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // пропускаем
    }
  }
  return out;
}

// Хвост большого журнала. Первая строка хвоста обрезана, поэтому она отбрасывается.
function tailJsonl(file, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf8');
    return parseLines(size > length ? text.slice(text.indexOf('\n') + 1) : text);
  } finally {
    fs.closeSync(fd);
  }
}

class DealStore {
  constructor(eventsFile, snapshotFile, { now = () => Date.now() } = {}) {
    if (!eventsFile || !snapshotFile) throw new Error('DealStore: нужны пути к событиям и снимку');
    this.eventsFile = eventsFile;
    this.snapshotFile = snapshotFile;
    this.now = now;
    this.seq = 0;
    this.items = new Map(); // ref → дело
    this._load();
  }

  _load() {
    try {
      const snap = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
      if (Array.isArray(snap.items) && Number.isInteger(snap.seq)) {
        this.seq = snap.seq;
        for (const deal of snap.items) this.items.set(deal.ref, deal);
      }
    } catch {
      // снимка нет или он битый: всё соберётся из событий
    }
    for (const ev of readJsonl(this.eventsFile)) {
      if (ev.seq > this.seq) this._apply(ev);
    }
  }

  _apply(ev) {
    this.seq = ev.seq;
    if (ev.forget) {
      this.items.delete(ev.ref);
      return;
    }
    const { seq, ...fields } = ev;
    this.items.set(ev.ref, { ...this.items.get(ev.ref), ...fields });
  }

  _write(fields) {
    const ev = { seq: this.seq + 1, ts: new Date(this.now()).toISOString(), ...fields };
    fs.mkdirSync(path.dirname(this.eventsFile), { recursive: true });
    fs.appendFileSync(this.eventsFile, `${JSON.stringify(ev)}\n`, 'utf8');
    this._apply(ev);
    const tmp = `${this.snapshotFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ seq: this.seq, items: this.list() }), 'utf8');
    fs.renameSync(tmp, this.snapshotFile);
    return this.items.get(fields.ref) || null;
  }

  list() {
    return [...this.items.values()];
  }

  get(ref) {
    return this.items.get(ref) || null;
  }

  // Записывает дело, если что-то изменилось. Разобранное владельцем возвращается в список,
  // только когда источник перешёл в другое состояние: иначе каждая сверка воскрешала бы его.
  upsert({ ref, title, source, state, reason = '', due = null, since = null }) {
    if (!STATES.includes(state)) throw new Error(`дело: неизвестное состояние ${state}`);
    const old = this.items.get(ref);
    if (!old) return this._write({ ref, title, source, state, reason, due, since: since || new Date(this.now()).toISOString(), cleared: false });
    if (old.cleared && old.clearedFrom === state) return old;
    if (!old.cleared && old.state === state && old.reason === reason && old.due === due) return old;
    return this._write({ ref, title, state, reason, due, since: old.state === state ? old.since : new Date(this.now()).toISOString(), cleared: false });
  }

  // Дело исчерпано и в истории не нужно (ход с ответом, решённое подтверждение): иначе снимок рос бы с каждым ходом.
  forget(ref) {
    if (!this.items.has(ref)) return false;
    this._write({ ref, forget: true });
    return true;
  }

  // Владелец видел: убрать из «что повисло». Источник (задача, напоминание) не меняется.
  clear(ref) {
    const old = this.items.get(ref);
    if (!old) return null;
    if (old.cleared) return old;
    return this._write({ ref, cleared: true, clearedFrom: old.state });
  }
}

function taskDeal(task) {
  const code = task.verdict && task.verdict.code;
  switch (task.status) {
    case 'running': return { state: 'started' };
    case 'queued': return { state: 'promised' };
    case 'waiting_approval': return { state: 'waiting', reason: 'ждёт вашего решения' };
    case 'paused': return { state: 'waiting', reason: task.reason || 'на паузе' };
    case 'blocked': return { state: 'waiting', reason: task.reason || 'заблокирована' };
    case 'done': return { state: 'done', reason: 'confirmed' };
    case 'unverified':
      return code === 'failed'
        ? { state: 'failed', reason: (task.verdict && task.verdict.reason) || 'проверка не подтвердила' }
        : { state: 'done', reason: 'unknown' };
    case 'cancelled': return { state: 'cleared' };
    default: return null; // черновик ещё ничего не обещает
  }
}

// Сверка с источниками. Что исчезло из источника (напоминание сработало или отменено), закрывается.
// Цель задачи бывает инструкцией для модели; владельцу показываем первую фразу.
function missionTitle(goal) {
  const text = String(goal);
  return (text.match(/^.{3,}?[.!?](?=\s|$)/) || [text])[0].replace(/\.$/, '').slice(0, 120);
}

function syncDeals(store, { tasks = [], reminders = [], missions = [], journal = [], approvals = [], now = Date.now() } = {}) {
  const alive = new Set();
  const put = (deal) => {
    alive.add(deal.ref);
    store.upsert(deal);
  };
  for (const t of tasks) {
    const d = taskDeal(t);
    if (d) put({ ref: `task:${t.id}`, title: String(t.title || t.id), source: 'task', ...d, since: t.updatedAt ? new Date(t.updatedAt).toISOString() : null });
  }
  for (const r of reminders) put({ ref: `reminder:${r.id}`, title: String(r.text), source: 'reminder', state: 'promised', due: r.dueAt });
  for (const m of missions) {
    if (m.enabled !== false) put({ ref: `mission:${m.id}`, title: missionTitle(m.goal), source: 'mission', state: 'promised', due: m.nextRunAt || null });
  }
  for (const a of approvals) put({ ref: `approval:${a.id}`, title: String(a.name || 'действие'), source: 'approval', state: 'waiting', reason: 'ждёт вашего решения' });
  for (const e of journal) {
    if (e.verified !== 'failed' && e.verified !== 'unknown') continue;
    // Журнал только дописывается: такие дела живут, пока владелец их не разберёт, а unknown скрывается по сроку.
    if (now - Date.parse(e.ts) > DAY_MS && e.verified === 'unknown') continue;
    store.upsert({
      ref: `call:${e.callId || `${e.ts}:${e.tool}`}`,
      title: String(e.tool),
      source: 'journal',
      state: e.verified === 'failed' ? 'failed' : 'done',
      reason: e.verified === 'failed' ? String(e.evidence || e.summary || '') : 'unknown',
      since: e.ts,
    });
  }
  for (const deal of store.list()) {
    if (deal.source === 'approval' && !alive.has(deal.ref)) store.forget(deal.ref);
    if (['task', 'reminder', 'mission'].includes(deal.source) && !alive.has(deal.ref) && !deal.cleared) store.clear(deal.ref);
  }
}

// Дело на ход: открывается до работы, поэтому падение процесса тоже оставит след. Возвращает ref.
function openTurn(store, title) {
  const ref = `turn:${crypto.randomUUID().slice(0, 8)}`;
  store.upsert({ ref, title: String(title || 'ход').slice(0, 120), source: 'turn', state: 'started' });
  return ref;
}

const TURN_FAILURES = {
  error: 'ход упал с ошибкой',
  limit: 'закончился лимит шагов, дело могло остаться незавершённым',
  loop: 'инструмент возвращал одно и то же, дело не доведено',
  stopped: 'ход остановлен, часть действий могла выполниться',
  needs_human: 'сайт просит подтверждение, нужен человек',
};

// Ход с ответом снимается с учёта: о нём всё сказано в чате. Остальное остаётся провалом с причиной.
function closeTurn(store, ref, outcome, error) {
  if (outcome === 'answer') return store.forget(ref);
  const old = store.get(ref);
  if (!old) return false;
  const base = TURN_FAILURES[outcome] || 'ход завершился без ответа';
  store.upsert({ ref, title: old.title, source: 'turn', state: 'failed', reason: error ? `${base}: ${String(error).slice(0, 200)}` : base });
  return true;
}

// Запускать только при старте приложения: незакрытый ход значит, что прошлый запуск оборвался посреди него.
function closeOrphanTurns(store) {
  for (const d of store.list()) {
    if (d.source === 'turn' && d.state === 'started') store.upsert({ ref: d.ref, title: d.title, source: 'turn', state: 'failed', reason: 'ход прерван перезапуском, результат неизвестен' });
  }
}

// Вызовы со стартом, но без конца в журнале скорости: процесс упал или перезапустился посреди действия.
// Запускать только при старте приложения, пока ни один вызов не идёт.
function markInterrupted(store, turnRecords) {
  const ended = new Set(turnRecords.filter((r) => r.kind === 'tool').map((r) => r.callId));
  const out = [];
  for (const r of turnRecords) {
    if (r.kind !== 'tool_start' || !r.callId || ended.has(r.callId)) continue;
    out.push(store.upsert({
      ref: `call:${r.callId}`,
      title: String(r.name),
      source: 'interrupted',
      state: 'waiting',
      reason: 'вызов прерван перезапуском, результат неизвестен',
      since: r.ts,
    }));
  }
  return out;
}

// Ответ на «что повисло»: сначала то, что ждёт владельца, потом провалы, просрочка, застрявшее и не проверенное.
function hanging(store, { now = Date.now() } = {}) {
  const open = store.list().filter((d) => !d.cleared);
  const byTime = (a, b) => String(a.since).localeCompare(String(b.since));
  const waiting = open.filter((d) => d.state === 'waiting').sort(byTime);
  const failed = open.filter((d) => d.state === 'failed').sort(byTime);
  const overdue = open.filter((d) => d.state === 'promised' && d.due && Date.parse(d.due) < now).sort(byTime);
  const stale = open.filter((d) => d.state === 'started' && now - Date.parse(d.since) > STALE_MS).sort(byTime);
  const unverified = open.filter((d) => d.state === 'done' && d.reason === 'unknown' && now - Date.parse(d.since) < DAY_MS);
  return { waiting, failed, overdue, stale, unverified };
}

// shortcut: подписи только для действий с эффектом, полный список живёт в renderer/shared.js; общий модуль, если подписей станет больше.
const TOOL_WORDS = {
  agents_parallel: 'Параллельная работа ролей',
  shell_run: 'Команда PowerShell', app_open: 'Запуск программы', app_install: 'Установка программы', app_close: 'Закрытие программы', url_open: 'Открыть адрес',
  windows_focus: 'Переключение окна', windows_arrange: 'Раскладка окон', windows_close_all: 'Закрытие всех окон', youtube_play: 'Видео на YouTube', ui_close_window: 'Закрытие окна', desktop_observe: 'Снимок рабочего стола', desktop_click: 'Нажатие по id', desktop_type: 'Ввод по id', ui_click: 'Нажатие в окне', ui_set_toggle: 'Переключение флажка', ui_type: 'Ввод текста',
  ui_keys: 'Нажатие клавиш', clipboard_set: 'Запись в буфер', media_control: 'плеер', image_read_text: 'картинка', volume_set: 'Громкость', speak: 'Сказать вслух',
  image_look: 'просмотр картинки', project_commands: 'команды проекта', project_run: 'запуск команды проекта', web_check_claims: 'проверка утверждений по источникам', currency_rate: 'курс валют',
  monitor_off: 'Выключить экран', pc_shutdown: 'Выключить компьютер', workspace_write: 'Запись файла', workspace_move: 'Перенос файла', workspace_copy: 'Копия файла', workspace_mkdir: 'Создание папки', workspace_restore: 'Возврат прежней версии файла', project_brief: 'Разбор папки проекта', document_write: 'Запись документа', code_write: 'Запись кода', code_edit: 'Правка кода',
  code_read: 'Чтение кода', library_run: 'Готовая команда', library_list: 'Список готовых команд', skill_read: 'Чтение навыка', skills_list: 'Список навыков',
  task_create: 'Новая задача', task_plan: 'План задачи', task_enqueue: 'Задача в очередь', task_start: 'Запуск задачи', task_step: 'Шаг задачи',
  task_verify: 'Проверка задачи', task_list: 'Список задач исполнителя', task_submit: 'Поручение исполнителю', task_resume: 'Продолжение задачи',
  task_note: 'Запись к делу',
  goal_create: 'План цели', goal_list: 'Цели', goal_next: 'Следующий шаг цели', goal_step: 'Шаг цели', goal_close: 'Закрытие цели',
  workspace_list: 'Список файлов', workspace_read: 'Чтение файла', workspace_search: 'Поиск в папке', project_diagnostics: 'Разбор журнала проекта', web_search: 'Поиск в интернете', web_fetch: 'Чтение страницы', web_research: 'Сбор и чтение источников', weather_now: 'погода', browser_open: 'Открыть страницу', browser_read: 'Чтение страницы в браузере', browser_scroll: 'Прокрутка страницы', browser_click: 'Нажатие на странице', browser_type: 'Ввод на странице', code_test: 'Запуск тестов', memory_about: 'Память о человеке или деле', mail_send: 'Отправка письма', mail_unread: 'Непрочитанные письма',
};
// Имя инструмента без подписи — «действие»; обычный текст (название дела, цели) остаётся как есть.
const word = (title) => TOOL_WORDS[title] || (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(String(title)) ? 'действие' : title);

function clock(iso, now) {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${hm}`;
}

function hangingText(groups, { now = Date.now() } = {}) {
  const lines = [];
  const add = (head, items, line) => {
    if (!items.length) return;
    lines.push(head, ...items.map((d) => `- ${line(d)}`));
  };
  add('Ждёт вас:', groups.waiting, (d) => `${word(d.title)}: ${d.reason} (с ${clock(d.since, now)})`);
  add('Не получилось:', groups.failed, (d) => `${word(d.title)}: ${d.reason || 'причина неизвестна'} (${clock(d.since, now)}). Повторить или разобрать`);
  add('Срок прошёл:', groups.overdue, (d) => `${d.title} (срок ${clock(d.due, now)})`);
  add('Идёт дольше 10 минут:', groups.stale, (d) => `${d.title} (с ${clock(d.since, now)})`);
  if (groups.unverified.length) lines.push(`Не проверено за сутки: ${groups.unverified.length} (${groups.unverified.map((d) => word(d.title)).join(', ')})`);
  return lines.length ? lines.join('\n') : 'Ничего не висит.';
}

function isHangingPhrase(text) {
  return HANGING_PHRASE.test(String(text || '').trim());
}

module.exports = { missionTitle, DealStore, openTurn, closeTurn, closeOrphanTurns, syncDeals, markInterrupted, hanging, hangingText, isHangingPhrase, tailJsonl, taskDeal, toolWord: word };
