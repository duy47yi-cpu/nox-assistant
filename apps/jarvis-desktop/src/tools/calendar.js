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
const HOUR_MS = 60 * 60 * 1000;

function weekdayLabel(ev, timeZone) {
  try {
    const ms = Number.isFinite(ev && ev.startMs) ? ev.startMs : Date.parse(ev && ev.startAt);
    if (Number.isFinite(ms)) {
      return new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'long' }).format(new Date(ms));
    }
  } catch {
    // Игнорируем ошибку форматирования дня недели.
  }
  return '';
}

function groupEventsByDay(items, timeZone) {
  const map = new Map();
  for (const ev of items) {
    const date = ev.dateLocal || 'без даты';
    let group = map.get(date);
    if (!group) {
      const weekday = weekdayLabel(ev, timeZone);
      group = {
        date,
        weekday,
        label: weekday ? `${date} (${weekday})` : date,
        items: [],
      };
      map.set(date, group);
    }
    group.items.push(ev);
  }
  return [...map.values()];
}

function normalizeQueryText(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е').trim();
}

function scoreEventMatch(ev, query) {
  const q = normalizeQueryText(query);
  if (!q) return 1;
  const hay = normalizeQueryText([
    ev.title,
    ev.location,
    ev.description,
    ev.organizer,
    Array.isArray(ev.attendees) ? ev.attendees.join(' ') : '',
  ].filter(Boolean).join(' '));
  if (!hay) return 0;
  if (hay.includes(q)) return 100;
  const words = q.split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return 0;
  let hits = 0;
  for (const w of words) {
    if (hay.includes(w)) hits += 1;
  }
  return hits;
}

function normalizePrepNotes(rawNotes) {
  if (!Array.isArray(rawNotes)) return [];
  const out = [];
  for (const item of rawNotes.slice(0, 8)) {
    if (!item) continue;
    if (typeof item === 'string') {
      const text = item.trim().slice(0, 400);
      if (text) out.push({ text });
    } else if (typeof item === 'object') {
      const text = String(item.snippet || item.text || item.summary || '').trim().slice(0, 400);
      const source = item.path || item.source || item.about || undefined;
      if (text) out.push(source ? { source: String(source), text } : { text });
    }
  }
  return out;
}

function calendarTools({
  getSource = () => null,
  getReminders = () => [],
  getMissions = () => [],
  getTimeZone = () => undefined,
  now = () => new Date(),
  searchNotes = null,
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

        const byDay = days >= 5 ? groupEventsByDay(upcoming.items, tz) : undefined;
        let lines;
        if (byDay) {
          lines = [];
          for (const day of byDay) {
            lines.push(`${day.label}:`);
            for (const ev of day.items) {
              const conflictMark = ev.conflict ? ' [КОНФЛИКТ]' : '';
              lines.push(`  ${ev.timeLabel} — ${ev.title} (источник: ${ev.source})${conflictMark}`);
            }
          }
        } else {
          lines = upcoming.items.map((ev) => {
            const conflictMark = ev.conflict ? ' [КОНФЛИКТ]' : '';
            return `${ev.dateLocal} ${ev.timeLabel} — ${ev.title} (источник: ${ev.source})${conflictMark}`;
          });
        }
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
            ...(byDay ? { byDay } : {}),
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

  const calendarPrep = {
    name: 'calendar_prep',
    description: 'Подготовиться к ближайшей или выбранной встрече из подключённого календаря: реальные детали события, конфликты времени, подходящие локальные заметки и чек-лист подготовки.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 300 },
        hoursAhead: { type: 'integer', minimum: 1, maximum: 168, default: 48 },
        timeZone: { type: 'string', maxLength: 80 },
      },
    },
    async run(args = {}) {
      try {
        const nowMs = new Date(now()).getTime();
        const hoursAhead = Number.isInteger(args.hoursAhead) && args.hoursAhead >= 1 && args.hoursAhead <= 168
          ? args.hoursAhead
          : 48;
        let tz;
        try {
          tz = normalizeTimeZone(args.timeZone || (typeof getTimeZone === 'function' ? getTimeZone() : undefined));
        } catch (err) {
          return { ok: false, summary: err && err.message ? err.message : 'Неизвестный часовой пояс', data: { state: 'error', meeting: null, notes: [], checklist: [] } };
        }

        const sourceCfg = typeof getSource === 'function' ? getSource() : null;
        const snap = await fetchCalendar(sourceCfg, { now: nowMs, timeZone: tz });

        if (snap.state === 'not_connected') {
          return {
            ok: true,
            summary: 'Календарь не подключён: без источника невозможно подготовиться к реальной встрече.',
            data: {
              state: 'not_connected',
              stateLabel: snap.stateLabel,
              source: null,
              sourceLabel: null,
              timeZone: tz,
              meeting: null,
              notes: [],
              checklist: [],
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
              meeting: null,
              notes: [],
              checklist: [],
            },
          };
        }

        const upcoming = getUpcomingEvents(snap, {
          now: nowMs,
          windowMs: hoursAhead * HOUR_MS,
          limit: 50,
          timeZone: tz,
        });

        if (!upcoming.total) {
          return {
            ok: true,
            summary: `На ближайшие ${hoursAhead} ч встреч в календаре нет (${snap.sourceLabel || 'источник подключён'}).`,
            data: {
              state: snap.stale ? 'stale' : 'empty',
              stateLabel: snap.stale ? snap.stateLabel : 'Календарь пуст',
              source: snap.source,
              sourceLabel: snap.sourceLabel,
              timeZone: tz,
              meeting: null,
              notes: [],
              checklist: [],
            },
          };
        }

        const query = typeof args.query === 'string' ? args.query.trim() : '';
        let chosen = upcoming.items[0];
        if (query) {
          let bestScore = 0;
          let best = null;
          for (const item of upcoming.items) {
            const sc = scoreEventMatch(item, query);
            if (sc > bestScore) {
              bestScore = sc;
              best = item;
            }
          }
          if (!best) {
            return {
              ok: true,
              summary: `По запросу «${query}» в ближайшие ${hoursAhead} ч подходящих встреч не найдено (всего предстоящих: ${upcoming.total}).`,
              data: {
                state: snap.state,
                stateLabel: snap.stateLabel,
                source: snap.source,
                sourceLabel: snap.sourceLabel,
                stale: snap.stale,
                timeZone: tz,
                meeting: null,
                upcomingTitles: upcoming.items.slice(0, 5).map((e) => e.title),
                notes: [],
                checklist: [],
              },
            };
          }
          chosen = best;
        }

        const attendees = Array.isArray(chosen.attendees) ? chosen.attendees.filter(Boolean) : [];
        const organizer = chosen.organizer ? String(chosen.organizer) : null;
        const meeting = {
          id: chosen.id,
          title: chosen.title,
          dateLocal: chosen.dateLocal,
          timeLabel: chosen.timeLabel,
          timeZone: tz,
          startAt: chosen.startAt,
          endAt: chosen.endAt,
          allDay: Boolean(chosen.allDay),
          location: chosen.location || null,
          organizer,
          attendees,
          description: chosen.description || null,
          source: chosen.source,
          conflict: Boolean(chosen.conflict),
          conflictsWith: Array.isArray(chosen.conflictsWith) ? chosen.conflictsWith : [],
        };

        const conflictWarning = meeting.conflict
          ? `Пересечение по времени (${meeting.dateLocal} ${meeting.timeLabel})`
          : null;

        let notes = [];
        if (typeof searchNotes === 'function') {
          const topicQuery = [query, chosen.title]
            .filter(Boolean)
            .join(' ')
            .trim();
          try {
            const rawNotes = await searchNotes(topicQuery || chosen.title);
            notes = normalizePrepNotes(rawNotes);
          } catch {
            notes = [];
          }
        }

        const checklist = [
          `Проверить время: ${meeting.dateLocal} ${meeting.timeLabel} (${tz})`,
        ];
        if (meeting.conflict) checklist.push('Уточнить накладку по времени с другими встречами');
        if (meeting.location) checklist.push(`Подготовить подключение / место: ${meeting.location}`);
        if (meeting.description) checklist.push('Просмотреть описание и повестку события');
        if (notes.length > 0) checklist.push(`Просмотреть найденные заметки по теме (${notes.length})`);
        if (attendees.length > 0 || organizer) {
          checklist.push(`Уточнить состав участников (${[organizer, ...attendees].filter(Boolean).length})`);
        }

        const summaryLines = [
          `${snap.stale ? '[Устаревшие данные] ' : ''}Подготовка к встрече: ${meeting.title}`,
          `Время: ${meeting.dateLocal} ${meeting.timeLabel} (${tz}) · источник: ${meeting.source}`,
        ];
        if (meeting.location) summaryLines.push(`Место/ссылка: ${meeting.location}`);
        if (organizer) summaryLines.push(`Организатор: ${organizer}`);
        if (attendees.length > 0) summaryLines.push(`Участники: ${attendees.join(', ')}`);
        if (meeting.description) summaryLines.push(`Описание: ${meeting.description}`);
        if (conflictWarning) summaryLines.push(`Внимание: ${conflictWarning}`);
        if (notes.length > 0) {
          summaryLines.push(`Заметки по теме (${notes.length}):`);
          for (const n of notes) {
            summaryLines.push(`- ${n.source ? `[${n.source}] ` : ''}${n.text}`);
          }
        }
        summaryLines.push('Чек-лист:');
        for (const step of checklist) summaryLines.push(`- ${step}`);

        return {
          ok: true,
          summary: summaryLines.join('\n'),
          data: {
            state: snap.state,
            stateLabel: snap.stateLabel,
            source: snap.source,
            sourceLabel: snap.sourceLabel,
            stale: snap.stale,
            timeZone: tz,
            meeting,
            conflictWarning,
            notes,
            checklist,
          },
        };
      } catch (err) {
        return {
          ok: false,
          summary: `Ошибка подготовки ко встрече: ${sanitizeSourceText(err && err.message ? err.message : 'source_error')}`,
          data: { state: 'error', meeting: null, notes: [], checklist: [] },
        };
      }
    },
    async verify(_args, result) {
      if (result && result.ok && result.data && CALENDAR_STATES.includes(result.data.state)) {
        const who = result.data.meeting ? `встреча «${result.data.meeting.title}»` : `состояние: ${result.data.state}`;
        return { status: 'confirmed', evidence: who };
      }
      return { status: 'unknown', evidence: 'подготовку к встрече подтвердить не удалось' };
    },
  };

  return [calendarUpcoming, calendarBriefing, calendarPrep];
}

module.exports = { calendarTools };
