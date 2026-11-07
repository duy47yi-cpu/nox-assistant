'use strict';

// Проверка напоминаний по расписанию. Состояние во времени не хранит: всё берёт из ReminderStore.
const LATE_MS = 5 * 60 * 1000;
// После нескольких ошибок повторяем реже, но не отмечаем недоставленное выполненным.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

function showNotification(note, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      note.removeListener('show', onShow);
      note.removeListener('failed', onFailed);
      if (error) reject(error); else resolve();
    };
    const onShow = () => finish();
    const onFailed = (_event, error) => finish(new Error(String(error || 'системное уведомление не показано')));
    note.once('show', onShow);
    note.once('failed', onFailed);
    timer = setTimeout(() => finish(new Error('система не подтвердила показ уведомления')), timeoutMs);
    try { note.show(); } catch (err) { finish(err); }
  });
}

// Тихий режим сохраняет напоминание в журнале. Отсутствие системных
// уведомлений — ошибка доставки, а не успешный показ.
async function deliverReminder(item, { quiet, record, supported, show }) {
  if (quiet()) {
    await record(item);
    return 'journal';
  }
  if (!supported()) throw new Error('системные уведомления недоступны');
  await show(item);
  return 'notification';
}

class Scheduler {
  constructor({ store, notify, now = () => new Date(), intervalMs = 30000 } = {}) {
    if (!store || typeof store.due !== 'function') throw new Error('Scheduler: нужен ReminderStore');
    if (typeof notify !== 'function') throw new Error('Scheduler: нужна функция notify');
    this.store = store;
    this.notify = notify;
    this.now = now;
    this.intervalMs = intervalMs;
    this._timer = null;
    this._busy = false;
    this._failures = new Map(); // id -> {attempts, nextAt}; само напоминание остаётся в хранилище
  }

  // Отправляет созревшие напоминания и возвращает их число.
  // Напоминание помечается сработавшим только после успешного notify: если доставка
  // не удалась, оно останется в очереди и уйдёт на следующем проходе.
  async tick() {
    // Пока предыдущий проход ждёт notify, новый не запускаем: иначе напоминание уйдёт дважды.
    if (this._busy) return 0;
    this._busy = true;
    try {
      const current = this.now();
      const nowMs = new Date(current).getTime();
      let sent = 0;
      const due = this.store.due(current);
      const dueIds = new Set(due.map((item) => item.id));
      for (const id of this._failures.keys()) if (!dueIds.has(id)) this._failures.delete(id);
      for (const item of due) {
        const previous = this._failures.get(item.id);
        if (previous && previous.nextAt > nowMs) continue;
        const late = nowMs - new Date(item.dueAt).getTime() > LATE_MS;
        try {
          await this.notify({ id: item.id, text: item.text, late, ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}) });
        } catch (err) {
          // Ошибку доставки одного напоминания гасим: остальные от неё не должны зависеть.
          const attempts = (previous ? previous.attempts : 0) + 1;
          const delay = attempts < MAX_ATTEMPTS ? 0 : Math.min(MAX_BACKOFF_MS, RETRY_BACKOFF_MS * (2 ** Math.min(attempts - MAX_ATTEMPTS, 10)));
          this._failures.set(item.id, { attempts, nextAt: nowMs + delay });
          if (attempts >= MAX_ATTEMPTS) console.error(`напоминание не доставлено после ${attempts} попыток; повтор через ${delay / 60000} мин: ${err && err.message}`);
          continue;
        }
        this._failures.delete(item.id);
        this.store.markFired(item.id, current);
        sent += 1;
      }
      return sent;
    } finally {
      this._busy = false;
    }
  }

  // Сразу проверяет напоминания, затем раз в intervalMs. Повторный вызов ничего не делает.
  start() {
    if (this._timer) return;
    this._background();
    this._timer = setInterval(() => this._background(), this.intervalMs);
    // Таймер не должен удерживать процесс.
    this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // Фоновый проход: ошибка хранилища не должна стать unhandled rejection.
  _background() {
    this.tick().catch((err) => {
      console.error(`напоминания: ${err && err.message ? err.message : err}`);
    });
  }
}

module.exports = { Scheduler, deliverReminder, showNotification };
