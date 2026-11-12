'use strict';

const { sameOccurrence } = require('./store');
const {
  fetchCalendar,
  buildMorningBriefing,
  dayBoundsInZone,
  getZonedParts,
  CalendarNotificationLedger,
  DEFAULT_LEAD_MINUTES,
} = require('../calendar');

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
  constructor({ store, notify, now = () => new Date(), intervalMs = 30000, calendar = null } = {}) {
    if (!store || typeof store.due !== 'function') throw new Error('Scheduler: нужен ReminderStore');
    if (typeof notify !== 'function') throw new Error('Scheduler: нужна функция notify');
    this.store = store;
    this.notify = notify;
    this.now = now;
    this.intervalMs = intervalMs;
    this.calendar = calendar;
    this._calendarLedger = calendar && calendar.ledger instanceof CalendarNotificationLedger
      ? calendar.ledger
      : new CalendarNotificationLedger(calendar && calendar.ledgerFile ? calendar.ledgerFile : null);
    this._timer = null;
    this._busy = false;
    this._failures = new Map(); // id -> {attempts, nextAt}; само напоминание остаётся в хранилище
    this._delivered = new Map(); // Уведомление показано, но запись результата могла не удаться.
  }

  // Отправляет созревшие напоминания (и при подключённом календаре — утреннюю сводку и
  // предупреждения о предстоящих встречах без дублирования) и возвращает их число.
  // Напоминание помечается сработавшим только после успешного notify: если доставка
  // не удалась, оно останется в очереди и уйдёт на следующем проходе.
  async tick() {
    // Пока предыдущий проход ждёт notify, новый не запускаем: иначе напоминание уйдёт дважды.
    if (this._busy) return 0;
    this._busy = true;
    try {
      for (const [id, { item, firedAt }] of this._delivered) {
        this.store.markFired(id, firedAt, item);
        this._delivered.delete(id);
      }
      const current = this.now();
      const nowMs = new Date(current).getTime();
      let sent = 0;
      const due = this.store.due(current);
      const dueIds = new Set(due.map((item) => item.id));
      for (const id of this._failures.keys()) if (!dueIds.has(id)) this._failures.delete(id);
      for (const expected of due) {
        // За время доставки предыдущего уведомления срок могли изменить или отменить.
        const item = this.store.get(expected.id);
        if (!sameOccurrence(item, expected)) continue;
        const failure = this._failures.get(item.id);
        const previous = failure && sameOccurrence(item, failure.item) ? failure : null;
        if (previous && previous.nextAt > nowMs) continue;
        const late = nowMs - new Date(item.dueAt).getTime() > LATE_MS;
        try {
          await this.notify({ id: item.id, text: item.text, late, ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}) });
        } catch (err) {
          // Ошибку доставки одного напоминания гасим: остальные от неё не должны зависеть.
          const attempts = (previous ? previous.attempts : 0) + 1;
          const delay = attempts < MAX_ATTEMPTS ? 0 : Math.min(MAX_BACKOFF_MS, RETRY_BACKOFF_MS * (2 ** Math.min(attempts - MAX_ATTEMPTS, 10)));
          this._failures.set(item.id, { item, attempts, nextAt: nowMs + delay });
          if (attempts >= MAX_ATTEMPTS) console.error(`напоминание не доставлено после ${attempts} попыток; повтор через ${delay / 60000} мин: ${err && err.message}`);
          continue;
        }
        this._failures.delete(item.id);
        const firedAt = Math.max(nowMs, new Date(this.now()).getTime());
        this._delivered.set(item.id, { item, firedAt });
        this.store.markFired(item.id, firedAt, item);
        this._delivered.delete(item.id);
        sent += 1;
      }
      if (this.calendar) {
        sent += await this._tickCalendar(current, nowMs);
      }
      return sent;
    } finally {
      this._busy = false;
    }
  }

  async _tickCalendar(current, nowMs) {
    const cfg = typeof this.calendar === 'function' ? this.calendar() : this.calendar;
    if (!cfg) return 0;
    const timeZone = cfg.timeZone;
    const bounds = dayBoundsInZone(nowMs, timeZone);
    const sourceCfg = cfg.source !== undefined ? cfg.source : cfg;
    const snapshot = await fetchCalendar(sourceCfg, {
      now: nowMs,
      timeZone: bounds.timeZone,
      rangeStartMs: bounds.startMs,
      rangeEndMs: bounds.endMs + 24 * 60 * 60 * 1000,
    });

    let sent = 0;
    const briefingHour = Number.isInteger(cfg.morningBriefingHour) ? cfg.morningBriefingHour : 8;
    const enableBriefing = cfg.morningBriefing !== false;
    const localParts = getZonedParts(nowMs, bounds.timeZone);

    if (
      enableBriefing &&
      snapshot.connected &&
      snapshot.state !== 'error' &&
      localParts.hour >= briefingHour &&
      !this._calendarLedger.hasBriefingSent(bounds.dateKey, bounds.timeZone)
    ) {
      const remindersList = typeof this.store.list === 'function' ? this.store.list() : [];
      const missionsList = typeof cfg.missions === 'function' ? cfg.missions() : (Array.isArray(cfg.missions) ? cfg.missions : []);
      const briefing = buildMorningBriefing({
        calendar: snapshot,
        reminders: remindersList,
        missions: missionsList,
        now: nowMs,
        timeZone: bounds.timeZone,
      });
      try {
        await this.notify({
          id: `briefing:${bounds.dateKey}:${bounds.timeZone}`,
          kind: 'morning_briefing',
          text: briefing.text,
          source: briefing.source,
          briefing,
          late: false,
        });
        this._calendarLedger.markBriefingSent(bounds.dateKey, bounds.timeZone, current);
        sent += 1;
      } catch {
        // Повторим на следующем проходе, не помечая сводку отправленной.
      }
    }

    if (snapshot.state === 'ok' || snapshot.state === 'stale') {
      const leadMs = (Number.isFinite(cfg.leadMinutes) && cfg.leadMinutes >= 0 ? cfg.leadMinutes : DEFAULT_LEAD_MINUTES) * 60 * 1000;
      for (const ev of snapshot.items) {
        if (ev.allDay || ev.status === 'cancelled') continue;
        if (ev.startMs > nowMs + leadMs || ev.endMs <= nowMs) continue;
        if (this._calendarLedger.hasEventNotified(ev)) continue;
        const conflictNote = ev.conflict ? ' [Конфликт в расписании]' : '';
        const text = `Встреча: ${ev.title} (${ev.timeLabel}, источник: ${ev.source})${conflictNote}`;
        try {
          await this.notify({
            id: `calendar:${ev.id}`,
            kind: 'calendar_event',
            text,
            source: ev.source,
            event: ev,
            late: nowMs - ev.startMs > LATE_MS,
          });
          this._calendarLedger.markEventNotified(ev, current);
          sent += 1;
        } catch {
          // Если уведомление не доставлено, запись в ledger не ставится — уйдёт на следующем проходе.
        }
      }
    }
    return sent;
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
