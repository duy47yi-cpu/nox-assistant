'use strict';

// Тесты модуля календаря С3: часовые пояса IANA, переходы на летнее и зимнее время (DST),
// пересекающиеся встречи (конфликты), утренняя сводка на сегодня, подпись источника,
// 5 честных состояний (ok, empty, not_connected, error, stale), дедупликация событий,
// защита от повторных уведомлений и интеграция с src/schedule/ и src/desks/data.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  CALENDAR_STATES,
  STATE_LABELS,
  sanitizeSourceText,
  formatSourceSignature,
  normalizeTimeZone,
  dayBoundsInZone,
  wallComponentsToUtcMs,
  parseIcsCalendar,
  normalizeEvent,
  dedupeEvents,
  detectConflicts,
  getUpcomingEvents,
  fetchCalendar,
  normalizeCalendarSnapshot,
  buildMorningBriefing,
  CalendarNotificationLedger,
  normalizeCalendarSetting,
  sanitizeCalendarSettingForUi,
} = require('../src/calendar');
const { calendarTools } = require('../src/tools/calendar');
const { ReminderStore } = require('../src/schedule/store');
const { Scheduler } = require('../src/schedule/scheduler');
const deskData = require('../src/desks/data');

function makeTempDir(t) {
  const base = path.parse(process.cwd()).root || 'D:\\';
  const dir = fs.mkdtempSync(path.join(base, 'nox-calendar-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('состояния календаря: фиксированный набор из 5 состояний, без подключённого источника — честный not_connected без выдуманных встреч', async () => {
  assert.deepEqual(CALENDAR_STATES, ['ok', 'empty', 'not_connected', 'error', 'stale']);
  assert.equal(STATE_LABELS.not_connected, 'Источник не подключён');

  const unconfigured = await fetchCalendar(null, { timeZone: 'Europe/Moscow' });
  assert.equal(unconfigured.state, 'not_connected');
  assert.equal(unconfigured.connected, false);
  assert.equal(unconfigured.source, null);
  assert.deepEqual(unconfigured.items, []);
  assert.deepEqual(unconfigured.conflicts, []);
  assert.equal(unconfigured.total, 0);

  const emptyConfig = await fetchCalendar({}, { timeZone: 'Europe/Moscow' });
  assert.equal(emptyConfig.state, 'not_connected');
  assert.deepEqual(emptyConfig.items, []);

  const mcpDisconnected = await fetchCalendar({
    mcp: { servers: [{ name: 'google-calendar', status: 'idle', disabled: false }] },
  }, { timeZone: 'Europe/Moscow' });
  assert.equal(mcpDisconnected.state, 'not_connected');
  assert.equal(mcpDisconnected.connected, false);
  assert.deepEqual(mcpDisconnected.items, []);
});

test('часовые пояса и DST: весенний прыжок, осенний повтор, межпоясной перевод и границы суток 23ч/25ч', () => {
  // В Europe/Berlin:
  // - 2026-03-29 в 02:00 часы переводятся вперёд на 03:00 (CET UTC+1 -> CEST UTC+2).
  //   Сутки длятся 23 часа, а настенное время 02:30 попадает в пропущенный час и сдвигается на 03:30 CEST (01:30 UTC).
  const springBounds = dayBoundsInZone('2026-03-29T12:00:00Z', 'Europe/Berlin');
  assert.equal((springBounds.endMs - springBounds.startMs) / (60 * 60 * 1000), 23);

  const springGapEvent = normalizeEvent({
    id: 'dst-spring',
    title: 'Ночное окно обслуживания',
    start: '2026-03-29T02:30:00',
    durationMs: 30 * 60 * 1000,
    timeZone: 'Europe/Berlin',
    source: 'Инфраструктура',
  }, { defaultTimeZone: 'Europe/Berlin' });
  assert.equal(springGapEvent.shiftedByDstGap, true);
  assert.equal(springGapEvent.startAt, '2026-03-29T01:30:00.000Z');
  assert.equal(springGapEvent.startLocal, '03:30');
  assert.equal(springGapEvent.endLocal, '04:00');

  // - 2026-10-25 в 03:00 часы переводятся назад на 02:00 (CEST UTC+2 -> CET UTC+1).
  //   Сутки длятся 25 часов, а 02:30 наступает дважды: 00:30 UTC (первое) и 01:30 UTC (второе).
  const fallBounds = dayBoundsInZone('2026-10-25T12:00:00Z', 'Europe/Berlin');
  assert.equal((fallBounds.endMs - fallBounds.startMs) / (60 * 60 * 1000), 25);

  const firstOcc = wallComponentsToUtcMs(
    { year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 },
    'Europe/Berlin',
    { occurrence: 'first' },
  );
  const secondOcc = wallComponentsToUtcMs(
    { year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 },
    'Europe/Berlin',
    { occurrence: 'second' },
  );
  assert.equal(firstOcc.ambiguous, true);
  assert.equal(new Date(firstOcc.utcMs).toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(new Date(secondOcc.utcMs).toISOString(), '2026-10-25T01:30:00.000Z');

  // Межпоясная встреча: создано в America/New_York (09:00 EDT = 13:00 UTC), просматривается в Europe/Moscow (16:00 MSK)
  const crossZone = normalizeEvent({
    uid: 'ny-sync',
    title: 'Созвон с Нью-Йорком',
    start: '2026-06-15T09:00:00',
    end: '2026-06-15T10:00:00',
    timeZone: 'Eastern Standard Time', // псевдоним Windows -> America/New_York
    source: 'Рабочий календарь',
  }, { defaultTimeZone: 'Europe/Moscow' });
  assert.equal(normalizeTimeZone('Eastern Standard Time'), 'America/New_York');
  assert.equal(crossZone.startAt, '2026-06-15T13:00:00.000Z');
  assert.equal(crossZone.startLocal, '16:00');
  assert.equal(crossZone.endLocal, '17:00');
  assert.equal(crossZone.timeLabel, '16:00–17:00');
  assert.equal(crossZone.source, 'Рабочий календарь');
});

test('разбор ICS и RRULE через границу перевода часов сохраняет настенное время и учитывает EXDATE/CANCELLED', async (t) => {
  const dir = makeTempDir(t);
  const icsFile = path.join(dir, 'team.ics');
  // Ежедневная планёрка в 09:00 Europe/Berlin с 28 по 30 марта 2026 (через переход на летнее время 29 марта),
  // причём 29 марта исключено через EXDATE.
  const icsText = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'X-WR-CALNAME:Командный',
    '  календарь', // проверка разворачивания перенесённой строки RFC 5545
    'BEGIN:VEVENT',
    'UID:standup-1',
    'SUMMARY:Утренняя планёрка',
    'DTSTART;TZID=Europe/Berlin:20260328T090000',
    'DTEND;TZID=Europe/Berlin:20260328T093000',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE;TZID=Europe/Berlin:20260329T090000',
    'LOCATION:Переговорная\\, 3 этаж',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:cancelled-1',
    'SUMMARY:Отменённая встреча',
    'STATUS:CANCELLED',
    'DTSTART:20260328T110000Z',
    'DTEND:20260328T120000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  fs.writeFileSync(icsFile, icsText, 'utf8');

  const parsed = parseIcsCalendar(icsText, { defaultTimeZone: 'Europe/Berlin' });
  assert.equal(parsed.calendarName, 'Командный календарь');

  const snap = await fetchCalendar({ filePath: icsFile }, {
    now: '2026-03-28T07:00:00Z',
    timeZone: 'Europe/Berlin',
    rangeStartMs: Date.parse('2026-03-28T00:00:00Z'),
    rangeEndMs: Date.parse('2026-03-31T00:00:00Z'),
  });

  assert.equal(snap.state, 'ok');
  assert.equal(snap.source, 'Файл: team.ics');
  // Должно остаться 2 вхождения: 28 марта (CET, 08:00 UTC) и 30 марта (CEST, 07:00 UTC);
  // 29 марта исключено EXDATE, а отменённая встреча отфильтрована.
  assert.equal(snap.items.length, 2);
  assert.equal(snap.items[0].startAt, '2026-03-28T08:00:00.000Z');
  assert.equal(snap.items[0].startLocal, '09:00');
  assert.equal(snap.items[0].location, 'Переговорная, 3 этаж');
  assert.equal(snap.items[1].startAt, '2026-03-30T07:00:00.000Z');
  assert.equal(snap.items[1].startLocal, '09:00');
});

test('обнаружение конфликтов: частичное и полное наложение, стык в стык без конфликта, игнор прозрачных и отменённых', () => {
  const raw = [
    {
      uid: 'm1',
      title: 'Архитектурный комитет',
      start: '2026-11-12T10:00:00Z',
      end: '2026-11-12T11:00:00Z',
      source: 'Рабочий календарь',
    },
    {
      uid: 'm2',
      title: 'Интервью кандидата',
      start: '2026-11-12T10:30:00Z',
      end: '2026-11-12T11:30:00Z',
      source: 'Личный календарь',
    },
    {
      uid: 'm3',
      title: 'Стык в стык после интервью',
      start: '2026-11-12T11:30:00Z',
      end: '2026-11-12T12:00:00Z',
      source: 'Рабочий календарь',
    },
    {
      uid: 'm4',
      title: 'Свободная памятка (transparent)',
      start: '2026-11-12T10:15:00Z',
      end: '2026-11-12T10:45:00Z',
      transparency: 'transparent',
      source: 'Рабочий календарь',
    },
  ];
  const normalized = raw.map((r) => normalizeEvent(r, { defaultTimeZone: 'UTC' }));
  const { events, conflicts } = detectConflicts(normalized);

  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].titles, ['Архитектурный комитет', 'Интервью кандидата']);
  assert.equal(conflicts[0].overlapMinutes, 30);

  const byUid = Object.fromEntries(events.map((e) => [e.uid, e]));
  assert.equal(byUid.m1.conflict, true);
  assert.equal(byUid.m2.conflict, true);
  assert.equal(byUid.m3.conflict, false, 'встреча стык в стык не является конфликтом');
  assert.equal(byUid.m4.conflict, false, 'прозрачное событие не создаёт конфликт');
});

test('дедупликация событий и защита от повторных уведомлений и утренних сводок', async (t) => {
  const dir = makeTempDir(t);
  const remindersFile = path.join(dir, 'reminders.json');
  const ledgerFile = path.join(dir, 'calendar-ledger.json');

  // 1. Дедупликация одинаковых событий и обновление по sequence
  const dupes = [
    normalizeEvent({
      uid: 'ev-1',
      title: 'Ревью релиза',
      start: '2026-11-12T09:00:00Z',
      end: '2026-11-12T10:00:00Z',
      sequence: 1,
      source: 'Рабочий',
    }, { defaultTimeZone: 'UTC' }),
    normalizeEvent({
      uid: 'ev-1',
      title: 'Ревью релиза (обновлено)',
      start: '2026-11-12T09:00:00Z',
      end: '2026-11-12T10:00:00Z',
      sequence: 2,
      source: 'Рабочий',
    }, { defaultTimeZone: 'UTC' }),
    // Полный дубликат с другим uid, но тем же заголовком и временем
    normalizeEvent({
      uid: 'ev-copy',
      title: 'ревью релиза (обновлено)',
      start: '2026-11-12T09:00:00Z',
      end: '2026-11-12T10:00:00Z',
      sequence: 0,
      source: 'Рабочий',
    }, { defaultTimeZone: 'UTC' }),
  ];
  const deduped = dedupeEvents(dupes);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].title, 'Ревью релиза (обновлено)');

  // 2. Интеграция с Scheduler: утренняя сводка и уведомление о встрече отправляются ровно один раз
  const store = new ReminderStore(remindersFile);
  store.add({ text: 'Проверить почту', dueAt: '2026-11-12T08:00:00Z' });

  const delivered = [];
  let currentNow = new Date('2026-11-12T08:50:00Z');
  const calendarSource = {
    source: 'Корпоративный ICS',
    events: [
      {
        uid: 'ev-100',
        title: 'Синхронизация команды',
        start: '2026-11-12T09:00:00Z',
        end: '2026-11-12T09:30:00Z',
      },
      // Дубликат в самом источнике
      {
        uid: 'ev-100',
        title: 'Синхронизация команды',
        start: '2026-11-12T09:00:00Z',
        end: '2026-11-12T09:30:00Z',
      },
    ],
  };

  const scheduler = new Scheduler({
    store,
    notify: async (payload) => { delivered.push(payload); },
    now: () => currentNow,
    calendar: {
      source: calendarSource,
      ledgerFile,
      timeZone: 'UTC',
      leadMinutes: 15,
      morningBriefingHour: 8,
    },
  });

  const firstCount = await scheduler.tick();
  // 1 обычное напоминание + 1 утренняя сводка + 1 предупреждение о встрече = 3
  assert.equal(firstCount, 3);
  assert.equal(delivered.filter((d) => d.kind === 'morning_briefing').length, 1);
  assert.equal(delivered.filter((d) => d.kind === 'calendar_event').length, 1);
  assert.match(delivered.find((d) => d.kind === 'calendar_event').text, /источник: Корпоративный ICS/);

  // Повторный проход через минуту и даже после пересоздания планировщика на том же файле журнала
  // не дублирует ни сводку, ни уведомление о встрече.
  currentNow = new Date('2026-11-12T08:55:00Z');
  assert.equal(await scheduler.tick(), 0);

  const restartedScheduler = new Scheduler({
    store,
    notify: async (payload) => { delivered.push(payload); },
    now: () => currentNow,
    calendar: {
      source: calendarSource,
      ledgerFile,
      timeZone: 'UTC',
      leadMinutes: 15,
      morningBriefingHour: 8,
    },
  });
  assert.equal(await restartedScheduler.tick(), 0);
  assert.equal(delivered.length, 3);
});

test('5 состояний (ok, empty, not_connected, error, stale), кэш при сбое сети и маскирование секретов', async (t) => {
  const dir = makeTempDir(t);
  const cacheFile = path.join(dir, 'cal-cache.json');
  const now = Date.parse('2026-11-12T09:00:00Z');

  // Секрет в URL и тексте ошибки должен маскироваться
  const dirtyUrl = 'https://user:superSecretPass@calendar.example.com/feed.ics?token=secretToken123&cal=work';
  const cleanText = sanitizeSourceText(`Ошибка загрузки ${dirtyUrl}: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb`);
  assert.ok(!cleanText.includes('superSecretPass'));
  assert.ok(!cleanText.includes('secretToken123'));
  assert.ok(!cleanText.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  assert.equal(formatSourceSignature({ url: dirtyUrl }), 'Календарь (calendar.example.com)');

  // 1) empty: источник ответил валидным пустым ICS
  const emptySnap = await fetchCalendar({
    url: dirtyUrl,
    label: 'Рабочий ICS',
    httpGet: async () => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR',
  }, { now, timeZone: 'UTC' });
  assert.equal(emptySnap.state, 'empty');
  assert.equal(emptySnap.source, 'Рабочий ICS');
  assert.equal(emptySnap.sourceLabel, 'Источник: Рабочий ICS');

  // 2) error без кэша: сбой сети и секрет в ошибке не утекает
  const errSnap = await fetchCalendar({
    url: dirtyUrl,
    label: 'Рабочий ICS',
    cacheFile,
    httpGet: async () => { throw new Error(` failed for ${dirtyUrl}`); },
  }, { now, timeZone: 'UTC' });
  assert.equal(errSnap.state, 'error');
  assert.ok(!errSnap.reason.includes('secretToken123'));
  assert.ok(!errSnap.reason.includes('superSecretPass'));

  // 3) ok: успешная загрузка сохраняет кэш и отдаёт предстоящие встречи
  const validIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:live-1',
    'SUMMARY:Демо продукта',
    'DTSTART:20261112T100000Z',
    'DTEND:20261112T110000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const okSnap = await fetchCalendar({
    url: dirtyUrl,
    label: 'Рабочий ICS',
    cacheFile,
    httpGet: async () => validIcs,
  }, { now, timeZone: 'UTC' });
  assert.equal(okSnap.state, 'ok');
  assert.equal(okSnap.items.length, 1);
  assert.equal(okSnap.items[0].source, 'Рабочий ICS');

  const upcoming = getUpcomingEvents(okSnap, { now, timeZone: 'UTC' });
  assert.equal(upcoming.total, 1);
  assert.equal(upcoming.items[0].title, 'Демо продукта');

  // 4) stale: при следующем сбое сети возвращаются данные из кэша с состоянием stale
  const staleOnError = await fetchCalendar({
    url: dirtyUrl,
    label: 'Рабочий ICS',
    cacheFile,
    httpGet: async () => { throw new Error('timeout'); },
  }, { now: now + 5 * 60 * 1000, timeZone: 'UTC' });
  assert.equal(staleOnError.state, 'stale');
  assert.equal(staleOnError.stale, true);
  assert.equal(staleOnError.items.length, 1);
  assert.equal(staleOnError.reason, 'timeout');
});

test('утренняя сводка и интеграция с src/desks/data.js (calendar и today)', () => {
  const now = Date.parse('2026-11-12T07:00:00Z'); // 10:00 в Europe/Moscow

  // 1. Сводка без подключённого источника
  const disconnectedBriefing = buildMorningBriefing({
    calendar: null,
    reminders: [],
    missions: [],
    now,
    timeZone: 'Europe/Moscow',
  });
  assert.equal(disconnectedBriefing.calendarState, 'not_connected');
  assert.match(disconnectedBriefing.text, /Календарь: источник не подключён/);

  // 2. Сводка с пересекающимися встречами, напоминаниями и миссиями
  const calendarSnapshot = {
    source: 'Яндекс Календарь',
    fetchedAt: now - 60 * 1000,
    items: [
      {
        uid: 'c1',
        title: 'Планирование спринта',
        start: '2026-11-12T08:00:00Z', // 11:00 MSK
        end: '2026-11-12T09:00:00Z',   // 12:00 MSK
      },
      {
        uid: 'c2',
        title: 'Звонок с заказчиком',
        start: '2026-11-12T08:30:00Z', // 11:30 MSK
        end: '2026-11-12T09:30:00Z',   // 12:30 MSK
      },
    ],
  };
  const reminders = [{ id: 'r1', text: 'Отправить отчёт', dueAt: '2026-11-12T12:00:00Z', done: false }];
  const missions = [{ id: 'm1', goal: 'Собрать дайджест', enabled: true, nextRunAt: '2026-11-12T15:00:00Z' }];

  const briefing = buildMorningBriefing({
    calendar: calendarSnapshot,
    reminders,
    missions,
    now,
    timeZone: 'Europe/Moscow',
  });
  assert.equal(briefing.calendarState, 'ok');
  assert.equal(briefing.source, 'Яндекс Календарь');
  assert.equal(briefing.totalEvents, 2);
  assert.equal(briefing.totalConflicts, 1);
  assert.match(briefing.text, /11:00–12:00 — Планирование спринта \(источник: Яндекс Календарь\) \[КОНФЛИКТ\]/);
  assert.match(briefing.text, /Пересечения встреч \(1\)/);
  assert.match(briefing.text, /Отправить отчёт/);
  assert.match(briefing.text, /Собрать дайджест/);

  // 3. Проверка deskData.calendar и deskData.today
  assert.equal(deskData.calendar(null, { now, timeZone: 'Europe/Moscow' }).state, 'not_connected');
  assert.equal(deskData.calendar({ connected: true, source: 'Тест', items: [] }, { now }).state, 'empty');
  assert.equal(deskData.calendar('мусор', { now }).state, 'error');
  assert.equal(
    deskData.calendar({ ...calendarSnapshot, fetchedAt: now - 3 * 60 * 60 * 1000 }, { now, timeZone: 'Europe/Moscow' }).state,
    'stale',
  );

  const calWidget = deskData.calendar(calendarSnapshot, { now, timeZone: 'Europe/Moscow' });
  assert.equal(calWidget.state, 'ok');
  assert.equal(calWidget.value.source, 'Яндекс Календарь');
  assert.equal(calWidget.value.sourceLabel, 'Источник: Яндекс Календарь');
  assert.equal(calWidget.value.conflicts.length, 1);

  const todayWidget = deskData.today(
    { reminders, missions, calendar: calendarSnapshot },
    { now, timeZone: 'Europe/Moscow' },
  );
  assert.equal(todayWidget.state, 'ok');
  assert.equal(todayWidget.value.events.length, 2);
  assert.equal(todayWidget.value.conflicts.length, 1);
  assert.equal(todayWidget.value.source, 'Яндекс Календарь');
  assert.match(todayWidget.value.briefing, /Утренняя сводка/);
});

test('безопасная настройка источника и инструменты чата calendar_upcoming / calendar_briefing', async (t) => {
  const dir = makeTempDir(t);
  const icsPath = path.join(dir, 'work.ics');
  const now = Date.parse('2026-11-12T07:00:00Z');
  fs.writeFileSync(icsPath, [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:t-1',
    'SUMMARY:Встреча с командой',
    'DTSTART:20261112T090000Z',
    'DTEND:20261112T100000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:t-2',
    'SUMMARY:Параллельный звонок',
    'DTSTART:20261112T093000Z',
    'DTEND:20261112T103000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'), 'utf8');

  // Проверка валидации настроек
  assert.equal(normalizeCalendarSetting(null), null);
  assert.throws(() => normalizeCalendarSetting({ type: 'file', filePath: 'relative.ics' }), /абсолютный/);
  assert.throws(() => normalizeCalendarSetting({ type: 'file', filePath: path.join(dir, '.env') }), /недопустимый/);
  assert.throws(() => normalizeCalendarSetting({ type: 'url', url: 'ftp://example.com/a.ics' }), /http/);

  const urlSetting = normalizeCalendarSetting({
    type: 'url',
    url: 'https://cal.example.com/feed.ics?token=topSecret123',
    timeZone: 'Europe/Moscow',
  });
  const uiSetting = sanitizeCalendarSettingForUi(urlSetting);
  assert.equal(uiSetting.connected, true);
  assert.ok(!uiSetting.urlMasked.includes('topSecret123'));

  const fileSetting = normalizeCalendarSetting({ type: 'file', filePath: icsPath, label: 'Рабочий ICS', timeZone: 'Europe/Moscow' });
  assert.equal(fileSetting.type, 'file');

  // Инструменты без источника -> честный not_connected
  let activeSource = null;
  const [upcomingTool, briefingTool] = calendarTools({
    getSource: () => activeSource,
    getReminders: () => [{ id: 'r1', text: 'Проверить задачи', dueAt: '2026-11-12T12:00:00Z', done: false }],
    getMissions: () => [],
    getTimeZone: () => 'Europe/Moscow',
    now: () => now,
  });

  const noSrcRes = await upcomingTool.run({});
  assert.equal(noSrcRes.ok, true);
  assert.equal(noSrcRes.data.state, 'not_connected');
  assert.deepEqual(noSrcRes.data.items, []);
  assert.equal((await upcomingTool.verify({}, noSrcRes)).status, 'confirmed');

  // Подключаем реальный .ics файл
  activeSource = { filePath: fileSetting.filePath, label: fileSetting.label, timeZone: fileSetting.timeZone };
  const okRes = await upcomingTool.run({ days: 3 });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.data.state, 'ok');
  assert.equal(okRes.data.source, 'Рабочий ICS');
  assert.equal(okRes.data.total, 2);
  assert.equal(okRes.data.conflicts.length, 1);
  assert.match(okRes.summary, /Встреча с командой.*\[КОНФЛИКТ\]/);
  assert.equal((await upcomingTool.verify({}, okRes)).status, 'confirmed');

  const briefRes = await briefingTool.run({});
  assert.equal(briefRes.ok, true);
  assert.equal(briefRes.data.calendarState, 'ok');
  assert.match(briefRes.summary, /12:00–13:00 — Встреча с командой \(источник: Рабочий ICS\) \[КОНФЛИКТ\]/);
  assert.match(briefRes.summary, /Проверить задачи/);
  assert.equal((await briefingTool.verify({}, briefRes)).status, 'confirmed');
});
