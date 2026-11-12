'use strict';

// Инструменты календаря для чата (T0, только чтение):
// - calendar_upcoming: предстоящие встречи с учётом часового пояса, пересечений и подписи источника;
// - calendar_briefing: утренняя сводка на сегодня (встречи, конфликты, напоминания, миссии).
// Вымышленные встречи никогда не создаются: при отсутствии источника возвращается честное состояние.

const {
  CALENDAR_STATES,
  fetchCalendar,
  getUpcomingEvents,
  buildMorningBriefing,
  normalizeTimeZone,
  sanitizeSourceText,
} = require('../calendar');

const DAY_MS = 24 * 60 * 60 * 1000;

function calendarTools({
  getSource = () => null,
  getReminders = () => [],
  getMissions = () => [],
  getTimeZone = () => undefined,
  now = () => new Date(),
} = {}) {
  const calendarUpcoming = {
    name: 'calendar_upcoming',
    description: 'Показать предстоящие встречи и события из подключённого календаря с учётом часового пояса, конфликтов и подписи источника.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 30 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        timeZone: { type: 'string', maxLength: 80 },
      },
    },
    async run(args = {}) {
      try {
        const nowMs = new Date(now()).getTime();
        const days = Number.isInteger(args.days) && args.days >= 1 && args.days <= 30 ? args.days : 7;
        const limit = Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 50 ? args.limit : 15;
        let tz;
        try {
          tz = normalizeTimeZone(args.timeZone || (typeof getTimeZone === 'function' ? getTimeZone() : undefined));
        } catch (err) {
          return { ok: false, summary: err && err.message ? err.message : 'Неизвестный часовой пояс', data: { state: 'error', items: [] } };
        }

        const sourceCfg = typeof getSource === 'function' ? getSource() : null;
        const snap = await fetchCalendar(sourceCfg, { now: nowMs, timeZone: tz });

        if (snap.state === 'not_connected') {
          return {
            ok: true,
            summary: 'Календарь не подключён. Подключите файл .ics/.json или ленту календаря, чтобы видеть встречи.',
            data: {
              state: 'not_connected',
              stateLabel: snap.stateLabel,
              source: null,
              sourceLabel: null,
              timeZone: tz,
              items: [],
              conflicts: [],
              total: 0,
            },
          };
        }

        if (snap.state === 'error') {
          return {
            ok: false,
            summary: `Не удалось прочитать календарь${snap.source ? ` (${snap.source})` : ''}: ${snap.reason || 'ошибка источника'}`,
            data: {
              state: 'error',
              stateLabel: snap.stateLabel,
              source: snap.source,
              sourceLabel: snap.sourceLabel,
              reason: snap.reason || 'source_error',
              timeZone: tz,
              items: [],
              conflicts: [],
              total: 0,
            },
          };
        }

        const upcoming = getUpcomingEvents(snap, {
          now: nowMs,
          windowMs: days * DAY_MS,
          limit,
          timeZone: tz,
        });

        if (!upcoming.total) {
          return {
            ok: true,
            summary: `На ближайшие ${days} дн. встреч нет (${snap.sourceLabel || 'источник подключён'}).`,
            data: {
              state: snap.stale ? 'stale' : 'empty',
              stateLabel: snap.stale ? snap.stateLabel : 'Календарь пуст',
              source: snap.source,
              sourceLabel: snap.sourceLabel,
              timeZone: tz,
              items: [],
              conflicts: [],
              total: 0,
            },
          };
        }

        const lines = upcoming.items.map((ev) => {
          const conflictMark = ev.conflict ? ' [КОНФЛИКТ]' : '';
          return `${ev.dateLocal} ${ev.timeLabel} — ${ev.title} (источник: ${ev.source})${conflictMark}`;
        });
        if (upcoming.conflicts.length > 0) {
          lines.push(`Пересечений встреч: ${upcoming.conflicts.length}.`);
        }

        return {
          ok: true,
          summary: `${snap.stale ? '[Устаревшие данные] ' : ''}Встречи (${upcoming.total}):\n${lines.join('\n')}`,
          data: {
            state: snap.state,
            stateLabel: snap.stateLabel,
            source: snap.source,
            sourceLabel: snap.sourceLabel,
            stale: snap.stale,
            timeZone: tz,
            items: upcoming.items,
            conflicts: upcoming.conflicts,
            total: upcoming.total,
          },
        };
      } catch (err) {
        return {
          ok: false,
          summary: `Ошибка календаря: ${sanitizeSourceText(err && err.message ? err.message : 'source_error')}`,
          data: { state: 'error', items: [], conflicts: [], total: 0 },
        };
      }
    },
    async verify(_args, result) {
      if (result && result.data && CALENDAR_STATES.includes(result.data.state) && Array.isArray(result.data.items)) {
        return { status: 'confirmed', evidence: `состояние календаря: ${result.data.state}, встреч: ${result.data.items.length}` };
      }
      return { status: 'unknown', evidence: 'данные календаря не подтверждены' };
    },
  };

  const calendarBriefing = {
    name: 'calendar_briefing',
    description: 'Собрать утреннюю сводку на сегодня: встречи календаря с подписью источника, пересечения встреч, напоминания и миссии.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        timeZone: { type: 'string', maxLength: 80 },
      },
    },
    async run(args = {}) {
      try {
        const nowMs = new Date(now()).getTime();
        let tz;
        try {
          tz = normalizeTimeZone(args.timeZone || (typeof getTimeZone === 'function' ? getTimeZone() : undefined));
        } catch (err) {
          return { ok: false, summary: err && err.message ? err.message : 'Неизвестный часовой пояс', data: { calendarState: 'error' } };
        }
        const sourceCfg = typeof getSource === 'function' ? getSource() : null;
        const snap = await fetchCalendar(sourceCfg, { now: nowMs, timeZone: tz });
        const remindersList = typeof getReminders === 'function' ? getReminders() : [];
        const missionsList = typeof getMissions === 'function' ? getMissions() : [];
        const briefing = buildMorningBriefing({
          calendar: snap,
          reminders: remindersList,
          missions: missionsList,
          now: nowMs,
          timeZone: tz,
        });
        return {
          ok: true,
          summary: briefing.text,
          data: briefing,
        };
      } catch (err) {
        return {
          ok: false,
          summary: `Ошибка сводки: ${sanitizeSourceText(err && err.message ? err.message : 'source_error')}`,
          data: { calendarState: 'error' },
        };
      }
    },
    async verify(_args, result) {
      if (result && result.ok && result.data && typeof result.data.text === 'string' && CALENDAR_STATES.includes(result.data.calendarState)) {
        return { status: 'confirmed', evidence: `сводка на ${result.data.date}: ${result.data.calendarState}` };
      }
      return { status: 'unknown', evidence: 'сводку подтвердить не удалось' };
    },
  };

  return [calendarUpcoming, calendarBriefing];
}

module.exports = { calendarTools };
