'use strict';

// Модуль календаря (С3): интеграция с поддерживаемыми подключёнными источниками
// (локальные файлы .ics, ленты ICS по HTTPS с кэшем, подключённые MCP-серверы календаря,
// прямые снимки событий), часовые пояса IANA и переходы на летнее/зимнее время (DST),
// обнаружение конфликтов, утренняя сводка на сегодня, подпись источника и защита
// от дублирования событий и повторных уведомлений.
// Вымышленные встречи никогда не создаются: без подключённого источника возвращается
// честное состояние not_connected.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { zonedFormatter, wallTime, resolveWallTime } = require('../schedule/store');
const { maskSecrets } = require('../journal/journal');

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DEFAULT_DURATION_MS = 60 * MINUTE_MS;
const DEFAULT_MAX_AGE_MS = 30 * MINUTE_MS;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_ICS_BYTES = 2 * 1024 * 1024;
const DEFAULT_UPCOMING_WINDOW_MS = 7 * DAY_MS;
const DEFAULT_LEAD_MINUTES = 15;

const CALENDAR_STATES = Object.freeze(['ok', 'empty', 'not_connected', 'error', 'stale']);

const STATE_LABELS = Object.freeze({
  ok: 'Данные доступны',
  empty: 'Календарь пуст',
  not_connected: 'Источник не подключён',
  error: 'Ошибка источника',
  stale: 'Устаревшие данные',
});

// Частые псевдонимы TZID из Windows/Outlook/Exchange → стандартные зоны IANA.
const TZID_ALIASES = Object.freeze({
  UTC: 'UTC',
  GMT: 'UTC',
  'Etc/UTC': 'UTC',
  'Etc/GMT': 'UTC',
  'Russian Standard Time': 'Europe/Moscow',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'FLE Standard Time': 'Europe/Kyiv',
  'Turkey Standard Time': 'Europe/Istanbul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'China Standard Time': 'Asia/Shanghai',
  'India Standard Time': 'Asia/Kolkata',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Очищает URL и сообщения об ошибках от секретов, паролей и токенов в query/userinfo.
function sanitizeSourceText(value) {
  if (typeof value !== 'string' || !value) return '';
  let text = maskSecrets(value);
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.username || parsed.password) {
        parsed.username = '';
        parsed.password = '';
      }
      for (const key of [...parsed.searchParams.keys()]) {
        if (/^(token|key|secret|password|pass|auth|sig|signature|access_token|api_key|private_key)$/i.test(key)) {
          parsed.searchParams.set(key, '***');
        }
      }
      return parsed.toString();
    } catch {
      return rawUrl.replace(/([?&](?:token|key|secret|password|auth|sig|access_token|api_key)=)[^&\s]+/gi, '$1***');
    }
  });
  text = text.replace(/([?&](?:token|key|secret|password|auth|sig|access_token|api_key)=)[^&\s]+/gi, '$1***');
  return text;
}

// Подпись источника для отображения рядом с событиями и в сводке.
function formatSourceSignature(source) {
  if (!source) return null;
  if (typeof source === 'string') {
    const clean = sanitizeSourceText(source.trim()).slice(0, 100);
    return clean || null;
  }
  if (isPlainObject(source)) {
    const rawName = source.label || source.title || source.name || source.source || '';
    if (typeof rawName === 'string' && rawName.trim()) {
      return sanitizeSourceText(rawName.trim()).slice(0, 100);
    }
    if (typeof source.url === 'string' && source.url.trim()) {
      try {
        const u = new URL(source.url);
        return `Календарь (${u.hostname})`.slice(0, 100);
      } catch {
        return 'Календарь (ICS)';
      }
    }
    if (typeof source.filePath === 'string' && source.filePath.trim()) {
      return `Файл: ${path.basename(source.filePath.trim())}`.slice(0, 100);
    }
  }
  return null;
}

function normalizeTimeZone(timeZone) {
  if (timeZone === undefined || timeZone === null || timeZone === '') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  if (typeof timeZone !== 'string') throw new Error('timeZone: нужен часовой пояс IANA');
  const trimmed = timeZone.trim().replace(/^["']|["']$/g, '');
  const mapped = TZID_ALIASES[trimmed] || trimmed;
  const fmt = zonedFormatter(mapped);
  return fmt.resolvedOptions().timeZone;
}

// Разбирает части даты в указанном часовом поясе IANA.
function getZonedParts(ms, timeZone) {
  const formatter = zonedFormatter(normalizeTimeZone(timeZone));
  const parts = Object.fromEntries(formatter.formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: parts.fractionalSecond || 0,
  };
}

// Переводит настенное время (год, месяц 1..12, день, час, минута, секунда) в зоне timeZone в UTC мс.
// В пропущенный час (весенний переход DST) сдвигает вперёд на величину перевода часов (resolveWallTime.shifted).
// В повторяющийся час (осенний переход DST) по умолчанию выбирает первое наступление (occurrence = 'first'),
// либо второе при occurrence = 'second'.
function wallComponentsToUtcMs({ year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 }, timeZone, { occurrence = 'first' } = {}) {
  const formatter = zonedFormatter(normalizeTimeZone(timeZone));
  const wallDate = new Date(0);
  wallDate.setUTCFullYear(year, month - 1, day);
  wallDate.setUTCHours(hour, minute, second, millisecond);
  const wallMs = wallDate.getTime();
  if (Number.isNaN(wallMs)) return NaN;
  const resolved = resolveWallTime(wallMs, formatter);
  let utcMs = resolved.shifted;
  if (occurrence === 'second' && resolved.matches.length > 1) {
    utcMs = resolved.matches[resolved.matches.length - 1];
  }
  return {
    utcMs,
    ambiguous: resolved.matches.length > 1,
    shiftedByDstGap: resolved.matches.length === 0 && Number.isFinite(utcMs),
    matches: resolved.matches,
  };
}

// Границы календарного дня [startMs, endMs) в часовом поясе IANA.
// Учитывает дни длиной 23 часа (весенний переход) и 25 часов (осенний переход).
function dayBoundsInZone(now = Date.now(), timeZone) {
  const tz = normalizeTimeZone(timeZone);
  const nowMs = now instanceof Date ? now.getTime() : typeof now === 'string' ? new Date(now).getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error('now: некорректная дата');
  const parts = getZonedParts(nowMs, tz);
  const start = wallComponentsToUtcMs({ year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0, second: 0 }, tz).utcMs;
  const nextWall = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0));
  const end = wallComponentsToUtcMs({
    year: nextWall.getUTCFullYear(),
    month: nextWall.getUTCMonth() + 1,
    day: nextWall.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  }, tz).utcMs;
  const dateKey = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  return { startMs: start, endMs: end, dateKey, timeZone: tz };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTimeInZone(ms, timeZone) {
  const p = getZonedParts(ms, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function formatDateInZone(ms, timeZone) {
  const p = getZonedParts(ms, timeZone);
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
}

// Разбор даты/времени события: поддерживает ISO 8601 (UTC Z, со смещением +03:00, и без смещения),
// формат ICS (YYYYMMDD, YYYYMMDDTHHMMSS, YYYYMMDDTHHMMSSZ), и объекты {date, time, timeZone}.
function parseEventDateTime(raw, { eventTimeZone, defaultTimeZone } = {}) {
  const fallbackTz = normalizeTimeZone(eventTimeZone || defaultTimeZone);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { ms: raw, allDay: false, timeZone: fallbackTz, shiftedByDstGap: false, ambiguous: false };
  }
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? { ms, allDay: false, timeZone: fallbackTz, shiftedByDstGap: false, ambiguous: false } : null;
  }
  if (isPlainObject(raw)) {
    const tz = normalizeTimeZone(raw.timeZone || fallbackTz);
    if (typeof raw.dateTime === 'string') return parseEventDateTime(raw.dateTime, { eventTimeZone: tz, defaultTimeZone: fallbackTz });
    if (typeof raw.date === 'string') return parseEventDateTime(raw.date, { eventTimeZone: tz, defaultTimeZone: fallbackTz });
  }
  if (typeof raw !== 'string') return null;
  const str = raw.trim();
  if (!str) return null;

  // Только дата: YYYY-MM-DD или YYYYMMDD (событие на весь день в целевом поясе)
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/) || str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const resolved = wallComponentsToUtcMs({ year, month, day, hour: 0, minute: 0, second: 0 }, fallbackTz);
    if (!Number.isFinite(resolved.utcMs)) return null;
    return {
      ms: resolved.utcMs,
      allDay: true,
      dateOnly: `${m[1]}-${m[2]}-${m[3]}`,
      timeZone: fallbackTz,
      shiftedByDstGap: resolved.shiftedByDstGap,
      ambiguous: resolved.ambiguous,
    };
  }

  // Формат ICS: YYYYMMDDTHHMMSS[Z] или YYYYMMDDTHHMM[Z]
  m = str.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = m[6] ? Number(m[6]) : 0;
    if (m[7]) {
      const ms = Date.UTC(year, month - 1, day, hour, minute, second);
      return Number.isFinite(ms) ? { ms, allDay: false, timeZone: 'UTC', shiftedByDstGap: false, ambiguous: false } : null;
    }
    const resolved = wallComponentsToUtcMs({ year, month, day, hour, minute, second }, fallbackTz);
    if (!Number.isFinite(resolved.utcMs)) return null;
    return {
      ms: resolved.utcMs,
      allDay: false,
      timeZone: fallbackTz,
      shiftedByDstGap: resolved.shiftedByDstGap,
      ambiguous: resolved.ambiguous,
    };
  }

  // ISO без смещения (плавающее местное время в часовом поясе события): YYYY-MM-DDTHH:MM(:SS(.sss))
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = m[6] ? Number(m[6]) : 0;
    const millisecond = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
    const resolved = wallComponentsToUtcMs({ year, month, day, hour, minute, second, millisecond }, fallbackTz);
    if (!Number.isFinite(resolved.utcMs)) return null;
    return {
      ms: resolved.utcMs,
      allDay: false,
      timeZone: fallbackTz,
      shiftedByDstGap: resolved.shiftedByDstGap,
      ambiguous: resolved.ambiguous,
    };
  }

  // Стандартный ISO с Z или числовым смещением (+03:00, -0500 и т.д.)
  const ms = new Date(str).getTime();
  if (!Number.isFinite(ms)) return null;
  return { ms, allDay: false, timeZone: fallbackTz, shiftedByDstGap: false, ambiguous: false };
}

// Разбор длительности RFC 5545: PT1H30M, P1D, PT45M.
function parseIcsDurationMs(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return null;
  if (m[1] === '-') return null;
  const weeks = Number(m[2] || 0);
  const days = Number(m[3] || 0);
  const hours = Number(m[4] || 0);
  const minutes = Number(m[5] || 0);
  const seconds = Number(m[6] || 0);
  const total = (((weeks * 7 + days) * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
  return total > 0 ? total : null;
}

function unescapeIcsText(value = '') {
  return String(value)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

// Разворачивает перенесённые строки RFC 5545 (CRLF + пробел или табуляция).
function unfoldIcsLines(text) {
  return String(text || '')
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/);
}

function parseIcsProperty(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx <= 0) return null;
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = left.split(';');
  const name = parts[0].trim().toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i += 1) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) {
      const k = parts[i].slice(0, eq).trim().toUpperCase();
      const v = parts[i].slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      params[k] = v;
    }
  }
  return { name, params, value };
}

const ICS_WEEKDAYS = Object.freeze({ SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 });

// Разворачивает базовые правила повторения RRULE (DAILY, WEEKLY, MONTHLY) в окне [rangeStartMs, rangeEndMs]
// с сохранением настенного времени в часовом поясе события (корректно перешагивает переходы DST).
function expandRruleOccurrences(rawEvent, { rangeStartMs, rangeEndMs, defaultTimeZone }) {
  const rruleStr = rawEvent.rrule;
  if (typeof rruleStr !== 'string' || !rruleStr.trim()) return [rawEvent];
  const rules = {};
  for (const token of rruleStr.split(';')) {
    const [k, v] = token.split('=');
    if (k && v) rules[k.trim().toUpperCase()] = v.trim().toUpperCase();
  }
  const freq = rules.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return [rawEvent];

  const interval = Math.max(1, Number.parseInt(rules.INTERVAL || '1', 10) || 1);
  const maxCount = rules.COUNT ? Math.min(500, Math.max(1, Number.parseInt(rules.COUNT, 10) || 1)) : 366;
  const eventTz = normalizeTimeZone(rawEvent.timeZone || defaultTimeZone);
  const startParsed = parseEventDateTime(rawEvent.start, { eventTimeZone: eventTz, defaultTimeZone });
  if (!startParsed) return [];

  const endParsed = rawEvent.end ? parseEventDateTime(rawEvent.end, { eventTimeZone: eventTz, defaultTimeZone }) : null;
  const durationMs = endParsed && endParsed.ms > startParsed.ms
    ? endParsed.ms - startParsed.ms
    : (Number.isFinite(rawEvent.durationMs) && rawEvent.durationMs > 0 ? rawEvent.durationMs : (startParsed.allDay ? DAY_MS : DEFAULT_DURATION_MS));

  const untilParsed = rules.UNTIL ? parseEventDateTime(rules.UNTIL, { eventTimeZone: eventTz, defaultTimeZone }) : null;
  const untilMs = untilParsed ? untilParsed.ms : Infinity;

  const exdates = new Set();
  if (Array.isArray(rawEvent.exdates)) {
    for (const ex of rawEvent.exdates) {
      const p = parseEventDateTime(ex, { eventTimeZone: eventTz, defaultTimeZone });
      if (p) {
        exdates.add(p.ms);
        exdates.add(formatDateInZone(p.ms, eventTz));
      }
    }
  }

  const anchorParts = getZonedParts(startParsed.ms, eventTz);
  const byDayList = rules.BYDAY
    ? rules.BYDAY.split(',').map((d) => ICS_WEEKDAYS[d.trim().slice(-2)]).filter((d) => d !== undefined)
    : [];

  const out = [];
  let generated = 0;
  const baseDateUtc = new Date(Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day));

  for (let step = 0; step < 400 && generated < maxCount; step += 1) {
    const candidateDates = [];
    if (freq === 'DAILY') {
      const d = new Date(baseDateUtc.getTime() + step * interval * DAY_MS);
      candidateDates.push(d);
    } else if (freq === 'WEEKLY') {
      const weekBase = new Date(baseDateUtc.getTime() + step * interval * 7 * DAY_MS);
      if (byDayList.length) {
        const baseDow = weekBase.getUTCDay();
        for (const targetDow of byDayList) {
          const offset = (targetDow - baseDow + 7) % 7;
          candidateDates.push(new Date(weekBase.getTime() + offset * DAY_MS));
        }
        candidateDates.sort((a, b) => a.getTime() - b.getTime());
      } else {
        candidateDates.push(weekBase);
      }
    } else if (freq === 'MONTHLY') {
      const d = new Date(Date.UTC(anchorParts.year, anchorParts.month - 1 + step * interval, 1));
      const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(anchorParts.day, daysInMonth));
      candidateDates.push(d);
    }

    for (const d of candidateDates) {
      if (generated >= maxCount) break;
      const resolved = wallComponentsToUtcMs({
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: anchorParts.hour,
        minute: anchorParts.minute,
        second: anchorParts.second,
      }, eventTz);
      const occStartMs = resolved.utcMs;
      if (!Number.isFinite(occStartMs) || occStartMs < startParsed.ms) continue;
      if (occStartMs > untilMs) return out;
      generated += 1;

      const occDateKey = formatDateInZone(occStartMs, eventTz);
      if (exdates.has(occStartMs) || exdates.has(occDateKey)) continue;

      let occEndMs = occStartMs + durationMs;
      if (startParsed.allDay) {
        const daysSpan = Math.max(1, Math.round(durationMs / DAY_MS));
        const endWall = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1 - 1, d.getUTCDate() + daysSpan));
        const resolvedEnd = wallComponentsToUtcMs({
          year: endWall.getUTCFullYear(),
          month: endWall.getUTCMonth() + 1,
          day: endWall.getUTCDate(),
          hour: 0,
          minute: 0,
          second: 0,
        }, eventTz);
        if (Number.isFinite(resolvedEnd.utcMs)) occEndMs = resolvedEnd.utcMs;
      }

      if (Number.isFinite(rangeEndMs) && occStartMs >= rangeEndMs) {
        if (occStartMs > rangeEndMs + DAY_MS) return out;
        continue;
      }
      if (Number.isFinite(rangeStartMs) && occEndMs <= rangeStartMs) continue;

      out.push({
        ...rawEvent,
        rrule: null,
        recurrenceId: new Date(occStartMs).toISOString(),
        start: occStartMs,
        end: occEndMs,
        allDay: startParsed.allDay,
        timeZone: eventTz,
      });
    }
  }
  return out;
}

// Разбор текста iCalendar (.ics) без сторонних библиотек.
function parseIcsCalendar(text, { source = null, defaultTimeZone } = {}) {
  if (typeof text !== 'string' || !text.includes('BEGIN:VCALENDAR') || !text.includes('END:VCALENDAR')) {
    throw new Error('bad_ics');
  }
  const lines = unfoldIcsLines(text);
  let calendarName = null;
  let calendarTimeZone = null;
  let inEvent = false;
  let inAlarm = false;
  let current = null;
  const rawEvents = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VALARM') {
      inAlarm = true;
      continue;
    }
    if (upper === 'END:VALARM') {
      inAlarm = false;
      continue;
    }
    if (inAlarm) continue;

    if (upper === 'BEGIN:VEVENT') {
      inEvent = true;
      current = { exdates: [] };
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (inEvent && current && current.start) {
        rawEvents.push(current);
      }
      inEvent = false;
      current = null;
      continue;
    }

    const prop = parseIcsProperty(line);
    if (!prop) continue;

    if (!inEvent) {
      if (prop.name === 'X-WR-CALNAME' && prop.value.trim()) {
        calendarName = unescapeIcsText(prop.value).slice(0, 100);
      } else if (prop.name === 'X-WR-TIMEZONE' && prop.value.trim()) {
        calendarTimeZone = unescapeIcsText(prop.value);
      }
      continue;
    }

    switch (prop.name) {
      case 'UID':
        current.uid = unescapeIcsText(prop.value);
        break;
      case 'SUMMARY':
        current.title = unescapeIcsText(prop.value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeIcsText(prop.value);
        break;
      case 'LOCATION':
        current.location = unescapeIcsText(prop.value);
        break;
      case 'STATUS':
        current.status = unescapeIcsText(prop.value).toLowerCase();
        break;
      case 'TRANSP':
        current.transparency = unescapeIcsText(prop.value).toLowerCase();
        break;
      case 'SEQUENCE': {
        const seq = Number.parseInt(prop.value, 10);
        if (Number.isFinite(seq)) current.sequence = seq;
        break;
      }
      case 'DTSTART':
        current.start = prop.value.trim();
        if (prop.params.TZID) current.timeZone = prop.params.TZID;
        if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(current.start)) current.allDay = true;
        break;
      case 'DTEND':
        current.end = prop.value.trim();
        if (prop.params.TZID && !current.timeZone) current.timeZone = prop.params.TZID;
        break;
      case 'DURATION':
        current.durationMs = parseIcsDurationMs(prop.value);
        break;
      case 'RRULE':
        current.rrule = prop.value.trim();
        break;
      case 'RECURRENCE-ID':
        current.recurrenceId = prop.value.trim();
        break;
      case 'EXDATE':
        for (const item of prop.value.split(',')) {
          if (item.trim()) current.exdates.push(item.trim());
        }
        break;
      case 'LAST-MODIFIED':
      case 'DTSTAMP':
        if (!current.updatedAt) current.updatedAt = prop.value.trim();
        break;
      default:
        break;
    }
  }

  const effectiveSource = formatSourceSignature(source) || calendarName || 'Календарь (ICS)';
  let effectiveTz = defaultTimeZone;
  if (calendarTimeZone) {
    try {
      effectiveTz = normalizeTimeZone(calendarTimeZone);
    } catch {
      effectiveTz = defaultTimeZone;
    }
  }

  return {
    calendarName: effectiveSource,
    timeZone: effectiveTz,
    events: rawEvents.map((ev) => ({
      ...ev,
      timeZone: ev.timeZone || effectiveTz,
      source: effectiveSource,
      sourceType: 'ics',
    })),
  };
}

// Нормализует отдельное событие в целевом часовом поясе пользователя.
function normalizeEvent(raw, { defaultTimeZone, defaultSource = null, defaultSourceType = 'custom' } = {}) {
  if (!isPlainObject(raw)) return null;
  const title = typeof raw.title === 'string' && raw.title.trim()
    ? raw.title.trim().slice(0, 200)
    : typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim().slice(0, 200)
      : '';
  if (!title) return null;

  const status = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : 'confirmed';
  const viewerTz = normalizeTimeZone(defaultTimeZone);
  let eventTz = viewerTz;
  if (typeof raw.timeZone === 'string' && raw.timeZone.trim()) {
    try {
      eventTz = normalizeTimeZone(raw.timeZone);
    } catch {
      eventTz = viewerTz;
    }
  }

  const rawStart = raw.start !== undefined ? raw.start : (raw.startAt !== undefined ? raw.startAt : raw.startTime);
  const rawEnd = raw.end !== undefined ? raw.end : (raw.endAt !== undefined ? raw.endAt : raw.endTime);

  // Для событий на весь день (только дата YYYY-MM-DD / YYYYMMDD без времени) границы суток считаем в поясе пользователя (viewerTz).
  const isDateOnlyStart = typeof rawStart === 'string' && (/^\d{4}-\d{2}-\d{2}$/.test(rawStart.trim()) || /^\d{8}$/.test(rawStart.trim()));
  const startZone = isDateOnlyStart ? viewerTz : eventTz;
  const startParsed = parseEventDateTime(rawStart, { eventTimeZone: startZone, defaultTimeZone: viewerTz });
  if (!startParsed || !Number.isFinite(startParsed.ms)) return null;

  const allDay = raw.allDay === true || startParsed.allDay === true;
  let endMs = NaN;
  if (rawEnd !== undefined && rawEnd !== null && rawEnd !== '') {
    const isDateOnlyEnd = typeof rawEnd === 'string' && (/^\d{4}-\d{2}-\d{2}$/.test(rawEnd.trim()) || /^\d{8}$/.test(rawEnd.trim()));
    const endParsed = parseEventDateTime(rawEnd, { eventTimeZone: isDateOnlyEnd ? viewerTz : eventTz, defaultTimeZone: viewerTz });
    if (endParsed && Number.isFinite(endParsed.ms)) endMs = endParsed.ms;
  }

  if (!Number.isFinite(endMs) || endMs <= startParsed.ms) {
    const duration = Number.isFinite(raw.durationMs) && raw.durationMs > 0
      ? raw.durationMs
      : (allDay ? DAY_MS : DEFAULT_DURATION_MS);
    if (allDay && startParsed.dateOnly) {
      const [y, m, d] = startParsed.dateOnly.split('-').map(Number);
      const nextDay = new Date(Date.UTC(y, m - 1, d + Math.max(1, Math.round(duration / DAY_MS))));
      const nextWall = wallComponentsToUtcMs({
        year: nextDay.getUTCFullYear(),
        month: nextDay.getUTCMonth() + 1,
        day: nextDay.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      }, viewerTz);
      endMs = Number.isFinite(nextWall.utcMs) ? nextWall.utcMs : startParsed.ms + duration;
    } else {
      endMs = startParsed.ms + duration;
    }
  }

  const source = formatSourceSignature(raw.source) || formatSourceSignature(defaultSource) || 'Календарь';
  const sourceType = typeof raw.sourceType === 'string' ? raw.sourceType : defaultSourceType;
  const uid = typeof raw.uid === 'string' && raw.uid.trim()
    ? raw.uid.trim().slice(0, 200)
    : typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim().slice(0, 200)
      : null;

  const startIso = new Date(startParsed.ms).toISOString();
  const endIso = new Date(endMs).toISOString();
  const recurrenceKey = typeof raw.recurrenceId === 'string' && raw.recurrenceId.trim()
    ? raw.recurrenceId.trim()
    : startIso;
  const id = uid ? `${uid}::${recurrenceKey}` : crypto.createHash('sha1').update(`${source}|${title}|${startIso}|${endIso}`).digest('hex').slice(0, 16);

  const transparency = typeof raw.transparency === 'string' ? raw.transparency.toLowerCase() : 'opaque';
  const busy = raw.busy !== undefined
    ? Boolean(raw.busy)
    : (transparency !== 'transparent' && status !== 'cancelled' && (!allDay || raw.allDayBusy === true));

  const startLocal = formatTimeInZone(startParsed.ms, viewerTz);
  const endLocal = formatTimeInZone(endMs, viewerTz);
  const dateLocal = formatDateInZone(startParsed.ms, viewerTz);
  const timeLabel = allDay ? 'Весь день' : `${startLocal}–${endLocal}`;

  return {
    id,
    uid: uid || id,
    title,
    startAt: startIso,
    endAt: endIso,
    startMs: startParsed.ms,
    endMs,
    allDay,
    status,
    busy,
    timeZone: viewerTz,
    eventTimeZone: eventTz,
    dateLocal,
    startLocal,
    endLocal,
    timeLabel,
    shiftedByDstGap: Boolean(startParsed.shiftedByDstGap),
    ambiguousWallTime: Boolean(startParsed.ambiguous),
    location: typeof raw.location === 'string' && raw.location.trim() ? sanitizeSourceText(raw.location.trim()).slice(0, 200) : null,
    description: typeof raw.description === 'string' && raw.description.trim() ? sanitizeSourceText(raw.description.trim()).slice(0, 400) : null,
    source,
    sourceType,
    sequence: Number.isInteger(raw.sequence) ? raw.sequence : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    recurrenceId: typeof raw.recurrenceId === 'string' ? raw.recurrenceId : null,
    conflict: false,
    conflictsWith: [],
  };
}

// Защита от дублирования событий:
// 1) по ключу (source, uid, recurrenceId || startMs) — если пришло обновление с большим sequence, заменяет старое;
//    если статус cancelled, удаляет вхождение;
// 2) по совпадению (нормализованный заголовок, startMs, endMs) — склеивает полные дубликаты.
function dedupeEvents(events) {
  if (!Array.isArray(events)) return [];
  const byUidOccurrence = new Map();
  const withoutUid = [];

  for (const ev of events) {
    if (!ev || typeof ev.title !== 'string') continue;
    if (ev.uid) {
      const occKey = `${ev.source || ''}::${ev.uid}::${ev.recurrenceId || ev.startAt}`;
      const prev = byUidOccurrence.get(occKey);
      if (!prev) {
        byUidOccurrence.set(occKey, ev);
      } else {
        const prevSeq = Number.isInteger(prev.sequence) ? prev.sequence : 0;
        const nextSeq = Number.isInteger(ev.sequence) ? ev.sequence : 0;
        if (nextSeq > prevSeq || (nextSeq === prevSeq && ev.status === 'cancelled')) {
          byUidOccurrence.set(occKey, ev);
        }
      }
    } else {
      withoutUid.push(ev);
    }
  }

  const combined = [...byUidOccurrence.values(), ...withoutUid].filter((ev) => ev.status !== 'cancelled');
  const bySignature = new Map();
  for (const ev of combined) {
    const sig = `${ev.title.trim().toLowerCase()}|${ev.startMs}|${ev.endMs}|${ev.allDay ? '1' : '0'}`;
    const existing = bySignature.get(sig);
    if (!existing) {
      bySignature.set(sig, ev);
    } else if ((ev.sequence || 0) > (existing.sequence || 0)) {
      bySignature.set(sig, ev);
    }
  }

  return [...bySignature.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.title.localeCompare(b.title, 'ru'));
}

// Обнаружение пересекающихся встреч.
// Стык в стык (endMs === startMs) конфликтом не считается.
// Возвращает список конфликтов и проставляет поля conflict / conflictsWith у событий.
function detectConflicts(events, { includeAllDay = false } = {}) {
  if (!Array.isArray(events) || !events.length) return { events: [], conflicts: [] };
  const cloned = events.map((ev) => ({
    ...ev,
    conflict: false,
    conflictsWith: [],
  }));
  cloned.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.title.localeCompare(b.title, 'ru'));

  const conflicts = [];
  for (let i = 0; i < cloned.length; i += 1) {
    const a = cloned[i];
    if (a.status === 'cancelled') continue;
    const aBusy = includeAllDay && a.allDay ? true : a.busy !== false;
    if (!aBusy) continue;

    for (let j = i + 1; j < cloned.length; j += 1) {
      const b = cloned[j];
      if (b.status === 'cancelled') continue;
      if (b.startMs >= a.endMs) break; // список отсортирован по startMs
      const bBusy = includeAllDay && b.allDay ? true : b.busy !== false;
      if (!bBusy) continue;

      const overlapStartMs = Math.max(a.startMs, b.startMs);
      const overlapEndMs = Math.min(a.endMs, b.endMs);
      if (overlapStartMs < overlapEndMs) {
        a.conflict = true;
        b.conflict = true;
        if (!a.conflictsWith.includes(b.id)) a.conflictsWith.push(b.id);
        if (!b.conflictsWith.includes(a.id)) b.conflictsWith.push(a.id);
        conflicts.push({
          ids: [a.id, b.id],
          titles: [a.title, b.title],
          sources: [a.source, b.source],
          overlapStart: new Date(overlapStartMs).toISOString(),
          overlapEnd: new Date(overlapEndMs).toISOString(),
          overlapMinutes: Math.max(1, Math.round((overlapEndMs - overlapStartMs) / MINUTE_MS)),
        });
      }
    }
  }
  return { events: cloned, conflicts };
}

// Нормализует и дедуплицирует список сырых событий (с разворачиванием RRULE при наличии).
function normalizeAndAnalyzeEvents(rawEvents, options = {}) {
  const {
    timeZone,
    source = null,
    sourceType = 'custom',
    rangeStartMs,
    rangeEndMs,
    includeAllDayConflicts = false,
  } = options;
  const tz = normalizeTimeZone(timeZone);
  if (!Array.isArray(rawEvents)) return { events: [], conflicts: [], timeZone: tz };

  const expanded = [];
  for (const raw of rawEvents) {
    if (!isPlainObject(raw)) continue;
    if (raw.rrule) {
      expanded.push(...expandRruleOccurrences(raw, { rangeStartMs, rangeEndMs, defaultTimeZone: tz }));
    } else {
      expanded.push(raw);
    }
  }

  const normalized = [];
  for (const item of expanded) {
    const ev = normalizeEvent(item, { defaultTimeZone: tz, defaultSource: source, defaultSourceType: sourceType });
    if (!ev) continue;
    if (Number.isFinite(rangeStartMs) && ev.endMs <= rangeStartMs) continue;
    if (Number.isFinite(rangeEndMs) && ev.startMs >= rangeEndMs) continue;
    normalized.push(ev);
  }

  const deduped = dedupeEvents(normalized);
  return {
    ...detectConflicts(deduped, { includeAllDay: includeAllDayConflicts }),
    timeZone: tz,
  };
}

// Выбирает предстоящие (и текущие незавершённые) встречи в заданном окне.
function getUpcomingEvents(snapshotOrEvents, options = {}) {
  const nowMs = options.now instanceof Date ? options.now.getTime() : (typeof options.now === 'string' ? new Date(options.now).getTime() : (Number.isFinite(options.now) ? options.now : Date.now()));
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : DEFAULT_UPCOMING_WINDOW_MS;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : 20;
  const tz = normalizeTimeZone(options.timeZone);

  const rawList = Array.isArray(snapshotOrEvents)
    ? snapshotOrEvents
    : (isPlainObject(snapshotOrEvents) && Array.isArray(snapshotOrEvents.items)
      ? snapshotOrEvents.items
      : (isPlainObject(snapshotOrEvents) && Array.isArray(snapshotOrEvents.events) ? snapshotOrEvents.events : []));

  const defaultSource = isPlainObject(snapshotOrEvents) ? snapshotOrEvents.source : options.source;
  const { events } = normalizeAndAnalyzeEvents(rawList, {
    timeZone: tz,
    source: defaultSource,
    rangeStartMs: nowMs,
    rangeEndMs: nowMs + windowMs,
  });

  const upcoming = events.filter((ev) => ev.endMs > nowMs && ev.startMs <= nowMs + windowMs);
  const { events: annotated, conflicts } = detectConflicts(upcoming);
  return {
    items: annotated.slice(0, limit),
    total: annotated.length,
    conflicts,
    timeZone: tz,
    source: formatSourceSignature(defaultSource) || (annotated[0] ? annotated[0].source : null),
  };
}

// Загрузка текста по HTTP(S) с ограничением размера и без утечки секретов в ошибках.
function defaultHttpGet(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('bad_url'));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error('bad_url'));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'NoxAssistant/1.0',
        Accept: 'text/calendar, text/plain, */*',
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let nextUrl;
        try {
          nextUrl = new URL(res.headers.location, parsed).toString();
        } catch {
          reject(new Error('bad_redirect'));
          return;
        }
        defaultHttpGet(nextUrl, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`http_${res.statusCode || 0}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_ICS_BYTES) {
          req.destroy(new Error('too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', (err) => reject(new Error(sanitizeSourceText(err && err.message ? err.message : 'network'))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => reject(new Error(sanitizeSourceText(err && err.message ? err.message : 'network'))));
  });
}

function readCache(cacheFile) {
  if (!cacheFile) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!raw || !Array.isArray(raw.events) || typeof raw.fetchedAt !== 'number') return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(cacheFile, payload) {
  if (!cacheFile) return;
  try {
    const dir = path.dirname(cacheFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${cacheFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, cacheFile);
  } catch {
    // Ошибка кэша не должна ронять основной ответ.
  }
}

// Проверяет подключённые MCP-серверы на наличие календарного источника.
function inspectMcpCalendarSource(mcpSource) {
  if (!mcpSource) return { connected: false, server: null, reason: 'not_connected' };
  const servers = Array.isArray(mcpSource)
    ? mcpSource
    : (isPlainObject(mcpSource) && Array.isArray(mcpSource.servers)
      ? mcpSource.servers
      : (typeof mcpSource.state === 'function' ? (mcpSource.state().servers || []) : []));
  const calendarServer = servers.find((srv) => isPlainObject(srv) && typeof srv.name === 'string' && /calendar|gcal|caldav|outlook/i.test(srv.name));
  if (!calendarServer) return { connected: false, server: null, reason: 'not_connected' };
  if (calendarServer.disabled === true || calendarServer.status === 'disabled' || calendarServer.status === 'idle') {
    return { connected: false, server: calendarServer, reason: 'not_connected' };
  }
  if (calendarServer.status === 'error') {
    return {
      connected: true,
      server: calendarServer,
      error: sanitizeSourceText(calendarServer.error || 'mcp_error'),
    };
  }
  return { connected: calendarServer.status === 'connected', server: calendarServer, reason: calendarServer.status === 'connected' ? null : 'not_connected' };
}

// Сбор данных календаря из поддерживаемых подключённых источников.
// Возвращает объект состояния со строго одним из CALENDAR_STATES:
//   ok | empty | not_connected | error | stale
async function fetchCalendar(sourceConfig, options = {}) {
  const nowMs = options.now instanceof Date ? options.now.getTime() : (typeof options.now === 'string' ? new Date(options.now).getTime() : (Number.isFinite(options.now) ? options.now : Date.now()));
  const tz = normalizeTimeZone(options.timeZone);
  const maxAgeMs = Number.isInteger(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const rangeStartMs = options.rangeStartMs !== undefined ? options.rangeStartMs : undefined;
  const rangeEndMs = options.rangeEndMs !== undefined ? options.rangeEndMs : undefined;

  if (sourceConfig === undefined || sourceConfig === null || sourceConfig === false) {
    return {
      ok: true,
      connected: false,
      state: 'not_connected',
      stateLabel: STATE_LABELS.not_connected,
      source: null,
      sourceLabel: null,
      sources: [],
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: null,
      stale: false,
      reason: 'not_connected',
    };
  }

  if (!isPlainObject(sourceConfig) && !Array.isArray(sourceConfig)) {
    return {
      ok: false,
      connected: true,
      state: 'error',
      stateLabel: STATE_LABELS.error,
      source: null,
      sourceLabel: null,
      sources: [],
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: null,
      stale: false,
      reason: 'bad_source',
    };
  }

  // Если передан массив событий напрямую
  if (Array.isArray(sourceConfig)) {
    const label = formatSourceSignature(options.source) || 'Локальный календарь';
    const { events, conflicts } = normalizeAndAnalyzeEvents(sourceConfig, {
      timeZone: tz,
      source: label,
      sourceType: 'local',
      rangeStartMs,
      rangeEndMs,
    });
    const state = events.length ? 'ok' : 'empty';
    return {
      ok: true,
      connected: true,
      state,
      stateLabel: STATE_LABELS[state],
      source: label,
      sourceLabel: `Источник: ${label}`,
      sources: [label],
      timeZone: tz,
      items: events,
      conflicts,
      total: events.length,
      fetchedAt: new Date(nowMs).toISOString(),
      stale: false,
      reason: null,
    };
  }

  // Явно неподключённый источник
  if (sourceConfig.connected === false || sourceConfig.state === 'not_connected') {
    const label = formatSourceSignature(sourceConfig);
    return {
      ok: true,
      connected: false,
      state: 'not_connected',
      stateLabel: STATE_LABELS.not_connected,
      source: label,
      sourceLabel: label ? `Источник: ${label}` : null,
      sources: label ? [label] : [],
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: null,
      stale: false,
      reason: 'not_connected',
    };
  }

  // Источник через подключённый MCP-сервер
  if (sourceConfig.mcp !== undefined && !sourceConfig.url && !sourceConfig.filePath && !sourceConfig.icsText && !sourceConfig.events && !sourceConfig.items && typeof sourceConfig.fetchEvents !== 'function') {
    const mcpCheck = inspectMcpCalendarSource(sourceConfig.mcp);
    const srvLabel = mcpCheck.server ? `MCP: ${mcpCheck.server.name}` : null;
    if (mcpCheck.error) {
      return {
        ok: false,
        connected: true,
        state: 'error',
        stateLabel: STATE_LABELS.error,
        source: srvLabel,
        sourceLabel: srvLabel ? `Источник: ${srvLabel}` : null,
        sources: srvLabel ? [srvLabel] : [],
        timeZone: tz,
        items: [],
        conflicts: [],
        total: 0,
        fetchedAt: null,
        stale: false,
        reason: mcpCheck.error,
      };
    }
    if (!mcpCheck.connected) {
      return {
        ok: true,
        connected: false,
        state: 'not_connected',
        stateLabel: STATE_LABELS.not_connected,
        source: srvLabel,
        sourceLabel: srvLabel ? `Источник: ${srvLabel}` : null,
        sources: srvLabel ? [srvLabel] : [],
        timeZone: tz,
        items: [],
        conflicts: [],
        total: 0,
        fetchedAt: null,
        stale: false,
        reason: 'not_connected',
      };
    }
    const mcpEvents = Array.isArray(mcpCheck.server.events) ? mcpCheck.server.events : [];
    const { events, conflicts } = normalizeAndAnalyzeEvents(mcpEvents, {
      timeZone: tz,
      source: srvLabel,
      sourceType: 'mcp',
      rangeStartMs,
      rangeEndMs,
    });
    const state = events.length ? 'ok' : 'empty';
    return {
      ok: true,
      connected: true,
      state,
      stateLabel: STATE_LABELS[state],
      source: srvLabel,
      sourceLabel: `Источник: ${srvLabel}`,
      sources: [srvLabel],
      timeZone: tz,
      items: events,
      conflicts,
      total: events.length,
      fetchedAt: new Date(nowMs).toISOString(),
      stale: false,
      reason: null,
    };
  }

  const cacheFile = sourceConfig.cacheFile || options.cacheFile || null;
  let label = formatSourceSignature(sourceConfig) || formatSourceSignature(options.source);

  // Явная ошибка от внешнего источника — проверяем, нет ли сохранённого кэша для возврата stale
  if (sourceConfig.ok === false || sourceConfig.state === 'error') {
    const cached = readCache(cacheFile);
    const reason = sanitizeSourceText(typeof sourceConfig.reason === 'string' && sourceConfig.reason ? sourceConfig.reason : (typeof sourceConfig.error === 'string' ? sourceConfig.error : 'source_error'));
    if (cached && cached.events.length) {
      const cachedLabel = label || cached.source || 'Календарь';
      const { events, conflicts } = normalizeAndAnalyzeEvents(cached.events, {
        timeZone: tz,
        source: cachedLabel,
        rangeStartMs,
        rangeEndMs,
      });
      if (events.length) {
        return {
          ok: true,
          connected: true,
          state: 'stale',
          stateLabel: STATE_LABELS.stale,
          source: cachedLabel,
          sourceLabel: `Источник: ${cachedLabel}`,
          sources: [cachedLabel],
          timeZone: tz,
          items: events,
          conflicts,
          total: events.length,
          fetchedAt: new Date(cached.fetchedAt).toISOString(),
          stale: true,
          reason,
        };
      }
    }
    return {
      ok: false,
      connected: true,
      state: 'error',
      stateLabel: STATE_LABELS.error,
      source: label,
      sourceLabel: label ? `Источник: ${label}` : null,
      sources: label ? [label] : [],
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: null,
      stale: false,
      reason,
    };
  }

  let rawEvents = null;
  let fetchedAtMs = typeof sourceConfig.fetchedAt === 'number'
    ? sourceConfig.fetchedAt
    : (typeof sourceConfig.fetchedAt === 'string' ? new Date(sourceConfig.fetchedAt).getTime() : nowMs);
  let forcedStale = sourceConfig.stale === true || sourceConfig.state === 'stale';
  let staleReason = null;
  let sourceType = sourceConfig.sourceType || 'custom';

  try {
    if (typeof sourceConfig.fetchEvents === 'function') {
      const res = await sourceConfig.fetchEvents({ now: nowMs, timeZone: tz });
      if (Array.isArray(res)) {
        rawEvents = res;
      } else if (isPlainObject(res) && Array.isArray(res.events || res.items)) {
        rawEvents = res.events || res.items;
        if (res.source && !label) label = formatSourceSignature(res.source);
        if (typeof res.fetchedAt === 'number') fetchedAtMs = res.fetchedAt;
      } else {
        throw new Error('bad_source');
      }
    } else if (typeof sourceConfig.icsText === 'string') {
      const parsed = parseIcsCalendar(sourceConfig.icsText, { source: label, defaultTimeZone: tz });
      rawEvents = parsed.events;
      label = label || parsed.calendarName;
      sourceType = 'ics';
    } else if (typeof sourceConfig.filePath === 'string' && sourceConfig.filePath.trim()) {
      const file = sourceConfig.filePath.trim();
      const content = fs.readFileSync(file, 'utf8');
      if (file.toLowerCase().endsWith('.json')) {
        const parsedJson = JSON.parse(content);
        rawEvents = Array.isArray(parsedJson) ? parsedJson : (parsedJson && Array.isArray(parsedJson.events || parsedJson.items) ? (parsedJson.events || parsedJson.items) : null);
        if (!rawEvents) throw new Error('bad_json');
        sourceType = 'local';
      } else {
        const parsed = parseIcsCalendar(content, { source: label || `Файл: ${path.basename(file)}`, defaultTimeZone: tz });
        rawEvents = parsed.events;
        label = label || parsed.calendarName;
        sourceType = 'ics';
      }
    } else if (typeof sourceConfig.url === 'string' && sourceConfig.url.trim()) {
      const getFn = typeof options.httpGet === 'function' ? options.httpGet : (typeof sourceConfig.httpGet === 'function' ? sourceConfig.httpGet : defaultHttpGet);
      const text = await getFn(sourceConfig.url.trim(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
      const parsed = parseIcsCalendar(text, { source: label || sourceConfig, defaultTimeZone: tz });
      rawEvents = parsed.events;
      label = label || parsed.calendarName;
      sourceType = 'ics';
      fetchedAtMs = nowMs;
    } else if (Array.isArray(sourceConfig.events) || Array.isArray(sourceConfig.items)) {
      rawEvents = sourceConfig.events || sourceConfig.items;
      sourceType = sourceConfig.sourceType || 'local';
    } else {
      // Пустой конфиг без подключённых полей — источник не подключён
      return {
        ok: true,
        connected: false,
        state: 'not_connected',
        stateLabel: STATE_LABELS.not_connected,
        source: null,
        sourceLabel: null,
        sources: [],
        timeZone: tz,
        items: [],
        conflicts: [],
        total: 0,
        fetchedAt: null,
        stale: false,
        reason: 'not_connected',
      };
    }
  } catch (err) {
    const cleanReason = sanitizeSourceText(err && err.message ? err.message : 'source_error') || 'source_error';
    const cached = readCache(cacheFile);
    if (cached && Array.isArray(cached.events) && cached.events.length) {
      rawEvents = cached.events;
      fetchedAtMs = cached.fetchedAt;
      label = label || cached.source || 'Календарь';
      forcedStale = true;
      staleReason = cleanReason;
    } else {
      return {
        ok: false,
        connected: true,
        state: 'error',
        stateLabel: STATE_LABELS.error,
        source: label,
        sourceLabel: label ? `Источник: ${label}` : null,
        sources: label ? [label] : [],
        timeZone: tz,
        items: [],
        conflicts: [],
        total: 0,
        fetchedAt: null,
        stale: false,
        reason: cleanReason,
      };
    }
  }

  const finalLabel = label || 'Календарь';
  if (!forcedStale && cacheFile && Array.isArray(rawEvents)) {
    writeCache(cacheFile, {
      fetchedAt: Number.isFinite(fetchedAtMs) ? fetchedAtMs : nowMs,
      source: finalLabel,
      events: rawEvents,
    });
  }

  const { events, conflicts } = normalizeAndAnalyzeEvents(rawEvents, {
    timeZone: tz,
    source: finalLabel,
    sourceType,
    rangeStartMs,
    rangeEndMs,
  });

  const isStale = forcedStale || (Number.isFinite(fetchedAtMs) && nowMs - fetchedAtMs > maxAgeMs);
  const sources = [...new Set(events.map((e) => e.source).filter(Boolean))];
  if (!sources.length && finalLabel) sources.push(finalLabel);

  if (!events.length) {
    return {
      ok: true,
      connected: true,
      state: 'empty',
      stateLabel: STATE_LABELS.empty,
      source: finalLabel,
      sourceLabel: `Источник: ${finalLabel}`,
      sources,
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs).toISOString() : null,
      stale: isStale,
      reason: staleReason,
    };
  }

  const state = isStale ? 'stale' : 'ok';
  return {
    ok: true,
    connected: true,
    state,
    stateLabel: STATE_LABELS[state],
    source: finalLabel,
    sourceLabel: `Источник: ${finalLabel}`,
    sources,
    timeZone: tz,
    items: events,
    conflicts,
    total: events.length,
    fetchedAt: Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs).toISOString() : null,
    stale: isStale,
    reason: staleReason,
  };
}

// Синхронное приведение уже полученного снимка календаря к 5 состояниям (для data.js и сводок).
function normalizeCalendarSnapshot(snapshot, options = {}) {
  const nowMs = options.now instanceof Date ? options.now.getTime() : (typeof options.now === 'string' ? new Date(options.now).getTime() : (Number.isFinite(options.now) ? options.now : Date.now()));
  const tz = normalizeTimeZone(options.timeZone || (isPlainObject(snapshot) && snapshot.timeZone ? snapshot.timeZone : undefined));
  const maxAgeMs = Number.isInteger(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;

  if (snapshot === undefined || snapshot === null || snapshot === false) {
    return {
      connected: false,
      state: 'not_connected',
      stateLabel: STATE_LABELS.not_connected,
      source: null,
      sourceLabel: null,
      sources: [],
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: null,
      stale: false,
      reason: 'not_connected',
    };
  }

  if (Array.isArray(snapshot)) {
    const label = formatSourceSignature(options.source) || 'Календарь';
    const { events, conflicts } = normalizeAndAnalyzeEvents(snapshot, {
      timeZone: tz,
      source: label,
      rangeStartMs: options.rangeStartMs,
      rangeEndMs: options.rangeEndMs,
    });
    const state = events.length ? 'ok' : 'empty';
    return {
      connected: true,
      state,
      stateLabel: STATE_LABELS[state],
      source: label,
      sourceLabel: `Источник: ${label}`,
      sources: [label],
      timeZone: tz,
      items: events,
      conflicts,
      total: events.length,
      fetchedAt: null,
      stale: false,
      reason: null,
    };
  }

  if (!isPlainObject(snapshot)) {
    return {
      connected: true,
      state: 'error',
      stateLabel: STATE_LABELS.error,
      source: null,
      sourceLabel: null,
      sources: [],
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: null,
      stale: false,
      reason: 'bad_source',
    };
  }

  const label = formatSourceSignature(snapshot.source || snapshot) || formatSourceSignature(options.source);

  if (snapshot.connected === false || snapshot.state === 'not_connected' || snapshot.reason === 'not_connected') {
    return {
      connected: false,
      state: 'not_connected',
      stateLabel: STATE_LABELS.not_connected,
      source: label,
      sourceLabel: label ? `Источник: ${label}` : null,
      sources: label ? [label] : [],
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: null,
      stale: false,
      reason: 'not_connected',
    };
  }

  const fetchedAtMs = typeof snapshot.fetchedAt === 'number'
    ? snapshot.fetchedAt
    : (typeof snapshot.fetchedAt === 'string' ? new Date(snapshot.fetchedAt).getTime() : NaN);

  const rawList = Array.isArray(snapshot.items) ? snapshot.items : (Array.isArray(snapshot.events) ? snapshot.events : null);

  if (snapshot.ok === false || snapshot.state === 'error') {
    const errReason = sanitizeSourceText(snapshot.reason || snapshot.error || 'source_error');
    if (rawList && rawList.length) {
      const effectiveLabel = label || 'Календарь';
      const { events, conflicts } = normalizeAndAnalyzeEvents(rawList, {
        timeZone: tz,
        source: effectiveLabel,
        rangeStartMs: options.rangeStartMs,
        rangeEndMs: options.rangeEndMs,
      });
      if (events.length) {
        return {
          connected: true,
          state: 'stale',
          stateLabel: STATE_LABELS.stale,
          source: effectiveLabel,
          sourceLabel: `Источник: ${effectiveLabel}`,
          sources: [...new Set(events.map((e) => e.source).filter(Boolean))],
          timeZone: tz,
          items: events,
          conflicts,
          total: events.length,
          fetchedAt: Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs).toISOString() : null,
          stale: true,
          reason: errReason,
        };
      }
    }
    return {
      connected: true,
      state: 'error',
      stateLabel: STATE_LABELS.error,
      source: label,
      sourceLabel: label ? `Источник: ${label}` : null,
      sources: label ? [label] : [],
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: null,
      stale: false,
      reason: errReason,
    };
  }

  if (typeof snapshot.icsText === 'string') {
    try {
      const parsed = parseIcsCalendar(snapshot.icsText, { source: label, defaultTimeZone: tz });
      return normalizeCalendarSnapshot({
        connected: true,
        ok: true,
        source: label || parsed.calendarName,
        items: parsed.events,
        fetchedAt: snapshot.fetchedAt,
        stale: snapshot.stale,
      }, options);
    } catch {
      return {
        connected: true,
        state: 'error',
        stateLabel: STATE_LABELS.error,
        source: label,
        sourceLabel: label ? `Источник: ${label}` : null,
        sources: label ? [label] : [],
        timeZone: tz,
        items: [],
        conflicts: [],
        total: 0,
        fetchedAt: null,
        stale: false,
        reason: 'bad_ics',
      };
    }
  }

  if (!rawList) {
    return {
      connected: true,
      state: 'error',
      stateLabel: STATE_LABELS.error,
      source: label,
      sourceLabel: label ? `Источник: ${label}` : null,
      sources: label ? [label] : [],
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: null,
      stale: false,
      reason: 'bad_source',
    };
  }

  const effectiveLabel = label || 'Календарь';
  const { events, conflicts } = normalizeAndAnalyzeEvents(rawList, {
    timeZone: tz,
    source: effectiveLabel,
    rangeStartMs: options.rangeStartMs,
    rangeEndMs: options.rangeEndMs,
  });

  const isStale = snapshot.stale === true || snapshot.state === 'stale' || (Number.isFinite(fetchedAtMs) && nowMs - fetchedAtMs > maxAgeMs);
  const sources = [...new Set(events.map((e) => e.source).filter(Boolean))];
  if (!sources.length && effectiveLabel) sources.push(effectiveLabel);

  if (!events.length) {
    return {
      connected: true,
      state: 'empty',
      stateLabel: STATE_LABELS.empty,
      source: effectiveLabel,
      sourceLabel: `Источник: ${effectiveLabel}`,
      sources,
      timeZone: tz,
      items: [],
      conflicts: [],
      total: 0,
      fetchedAt: Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs).toISOString() : null,
      stale: isStale,
      reason: snapshot.reason ? sanitizeSourceText(snapshot.reason) : null,
    };
  }

  const state = isStale ? 'stale' : 'ok';
  return {
    connected: true,
    state,
    stateLabel: STATE_LABELS[state],
    source: effectiveLabel,
    sourceLabel: `Источник: ${effectiveLabel}`,
    sources,
    timeZone: tz,
    items: events,
    conflicts,
    total: events.length,
    fetchedAt: Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs).toISOString() : null,
    stale: isStale,
    reason: snapshot.reason ? sanitizeSourceText(snapshot.reason) : null,
  };
}

// Утренняя сводка на сегодня: события календаря в часовом поясе владельца,
// пересекающиеся встречи, напоминания и задачи по расписанию, с подписями источников.
function buildMorningBriefing(inputs = {}) {
  const {
    calendar = null,
    reminders = [],
    missions = [],
    now = Date.now(),
    timeZone,
    maxAgeMs,
  } = inputs;

  const bounds = dayBoundsInZone(now, timeZone);
  const cal = normalizeCalendarSnapshot(calendar, {
    now,
    timeZone: bounds.timeZone,
    maxAgeMs,
    rangeStartMs: bounds.startMs,
    rangeEndMs: bounds.endMs,
  });

  const dueReminders = [];
  if (Array.isArray(reminders)) {
    for (const raw of reminders) {
      if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string' || raw.done) continue;
      const dueMs = raw.dueAt === undefined ? NaN : new Date(raw.dueAt).getTime();
      if (!Number.isFinite(dueMs) || dueMs >= bounds.endMs) continue;
      dueReminders.push({
        id: raw.id,
        text: raw.text.trim().slice(0, 300),
        dueAt: new Date(dueMs).toISOString(),
        timeLocal: formatTimeInZone(dueMs, bounds.timeZone),
        overdue: dueMs < bounds.startMs,
        source: 'Напоминания',
      });
    }
    dueReminders.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  }

  const todayMissions = [];
  if (Array.isArray(missions)) {
    for (const raw of missions) {
      if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.goal !== 'string' || raw.enabled === false) continue;
      const nextMs = raw.nextRunAt === undefined ? NaN : new Date(raw.nextRunAt).getTime();
      if (!Number.isFinite(nextMs) || nextMs < bounds.startMs || nextMs >= bounds.endMs) continue;
      todayMissions.push({
        id: raw.id,
        goal: raw.goal.trim().slice(0, 300),
        nextRunAt: new Date(nextMs).toISOString(),
        timeLocal: formatTimeInZone(nextMs, bounds.timeZone),
        source: 'Расписание миссий',
      });
    }
    todayMissions.sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));
  }

  const lines = [`Утренняя сводка на ${bounds.dateKey} (${bounds.timeZone}):`];

  if (cal.state === 'not_connected') {
    lines.push('• Календарь: источник не подключён.');
  } else if (cal.state === 'error') {
    const src = cal.source ? ` (${cal.source})` : '';
    lines.push(`• Календарь${src}: ошибка источника (${cal.reason || 'недоступен'}).`);
  } else if (cal.state === 'empty') {
    const src = cal.source ? ` (источник: ${cal.source})` : '';
    lines.push(`• Встреч в календаре на сегодня нет${src}.`);
  } else {
    const staleNote = cal.state === 'stale' ? ' [данные устарели]' : '';
    lines.push(`• Встречи на сегодня (${cal.items.length}, источник: ${cal.source || 'Календарь'})${staleNote}:`);
    for (const ev of cal.items) {
      const conflictNote = ev.conflict ? ' [КОНФЛИКТ]' : '';
      const locNote = ev.location ? `, ${ev.location}` : '';
      lines.push(`  - ${ev.timeLabel} — ${ev.title}${locNote} (источник: ${ev.source})${conflictNote}`);
    }
  }

  if (cal.conflicts.length > 0) {
    lines.push(`• Пересечения встреч (${cal.conflicts.length}):`);
    for (const c of cal.conflicts) {
      lines.push(`  - «${c.titles[0]}» и «${c.titles[1]}» (${c.overlapMinutes} мин)`);
    }
  }

  if (dueReminders.length > 0) {
    lines.push(`• Напоминания (${dueReminders.length}, источник: Напоминания):`);
    for (const r of dueReminders) {
      const mark = r.overdue ? 'просрочено' : r.timeLocal;
      lines.push(`  - ${mark} — ${r.text}`);
    }
  }

  if (todayMissions.length > 0) {
    lines.push(`• Поручения по расписанию (${todayMissions.length}, источник: Расписание миссий):`);
    for (const m of todayMissions) {
      lines.push(`  - ${m.timeLocal} — ${m.goal}`);
    }
  }

  return {
    date: bounds.dateKey,
    timeZone: bounds.timeZone,
    calendarState: cal.state,
    calendarStateLabel: cal.stateLabel,
    source: cal.source,
    sourceLabel: cal.sourceLabel,
    sources: cal.sources,
    stale: cal.stale,
    reason: cal.reason,
    events: cal.items,
    conflicts: cal.conflicts,
    reminders: dueReminders,
    missions: todayMissions,
    totalEvents: cal.items.length,
    totalConflicts: cal.conflicts.length,
    text: lines.join('\n'),
  };
}

// Журнал отправленных уведомлений календаря и утренних сводок:
// предотвращает повторные уведомления об одной и той же встрече и повторную утреннюю сводку за день.
class CalendarNotificationLedger {
  constructor(filePath = null) {
    this.filePath = filePath;
    this._memory = { events: {}, briefings: {} };
    if (this.filePath) {
      this._memory = this._load();
    }
  }

  static eventKey(event) {
    if (!isPlainObject(event)) return '';
    const id = event.uid || event.id || event.title || '';
    const start = event.recurrenceId || event.startAt || String(event.startMs || '');
    return `${ event.source || 'calendar' }::${id}::${start}`;
  }

  static briefingKey(dateKey, timeZone = 'UTC', workspaceId = 'default') {
    return `${workspaceId}::${dateKey}::${timeZone}`;
  }

  hasEventNotified(event) {
    const key = typeof event === 'string' ? event : CalendarNotificationLedger.eventKey(event);
    if (!key) return false;
    const state = this.filePath ? this._load() : this._memory;
    return Boolean(state.events[key]);
  }

  markEventNotified(event, now = new Date()) {
    const key = typeof event === 'string' ? event : CalendarNotificationLedger.eventKey(event);
    if (!key) return false;
    const state = this.filePath ? this._load() : this._memory;
    if (state.events[key]) return false;
    state.events[key] = new Date(now).toISOString();
    this._save(state);
    return true;
  }

  hasBriefingSent(dateKey, timeZone = 'UTC', workspaceId = 'default') {
    const key = CalendarNotificationLedger.briefingKey(dateKey, timeZone, workspaceId);
    const state = this.filePath ? this._load() : this._memory;
    return Boolean(state.briefings[key]);
  }

  markBriefingSent(dateKey, timeZone = 'UTC', now = new Date(), workspaceId = 'default') {
    const key = CalendarNotificationLedger.briefingKey(dateKey, timeZone, workspaceId);
    const state = this.filePath ? this._load() : this._memory;
    if (state.briefings[key]) return false;
    state.briefings[key] = new Date(now).toISOString();
    this._save(state);
    return true;
  }

  _load() {
    if (!this.filePath) return this._memory;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return { events: {}, briefings: {} };
      const parsed = JSON.parse(raw);
      return {
        events: isPlainObject(parsed && parsed.events) ? parsed.events : {},
        briefings: isPlainObject(parsed && parsed.briefings) ? parsed.briefings : {},
      };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { events: {}, briefings: {} };
      return { events: {}, briefings: {} };
    }
  }

  _save(state) {
    this._memory = state;
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw err;
    }
  }
}

// Безопасная нормализация настройки календарного источника для хранения в settings.json.
// Разрешены только локальные файлы (.ics/.json), адреса http(s) или подключённый MCP-сервер.
function normalizeCalendarSetting(raw) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (!isPlainObject(raw)) throw new Error('календарь: нужен объект настройки или null');
  if (raw.type === 'none' || raw.connected === false) return null;

  let type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  if (!type) {
    if (typeof raw.filePath === 'string' && raw.filePath.trim()) type = 'file';
    else if (typeof raw.url === 'string' && raw.url.trim()) type = 'url';
    else if (raw.mcp || typeof raw.server === 'string') type = 'mcp';
  }
  if (!['file', 'url', 'mcp'].includes(type)) {
    throw new Error('календарь: укажите тип file, url или mcp');
  }

  const out = { type };
  if (typeof raw.label === 'string' && raw.label.trim()) {
    out.label = sanitizeSourceText(raw.label.trim()).slice(0, 100);
  }
  if (typeof raw.timeZone === 'string' && raw.timeZone.trim()) {
    out.timeZone = normalizeTimeZone(raw.timeZone);
  }
  if (raw.leadMinutes !== undefined) {
    const lead = Number(raw.leadMinutes);
    if (!Number.isInteger(lead) || lead < 0 || lead > 180) {
      throw new Error('календарь: leadMinutes должно быть целым от 0 до 180');
    }
    out.leadMinutes = lead;
  }
  if (raw.morningBriefing !== undefined) {
    out.morningBriefing = Boolean(raw.morningBriefing);
  }
  if (raw.morningBriefingHour !== undefined) {
    const hour = Number(raw.morningBriefingHour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error('календарь: morningBriefingHour должно быть целым от 0 до 23');
    }
    out.morningBriefingHour = hour;
  }

  if (type === 'file') {
    const fp = typeof raw.filePath === 'string' ? raw.filePath.trim() : '';
    if (!fp) throw new Error('календарь: укажите путь к файлу .ics или .json');
    if (!path.isAbsolute(fp)) throw new Error('календарь: нужен абсолютный путь к файлу');
    if (/(^|[\\/])\.env(\.|$)/i.test(fp) || /\.(bin|key|pem)$/i.test(fp)) {
      throw new Error('календарь: недопустимый файл источника');
    }
    if (!/\.(ics|ical|json)$/i.test(fp)) {
      throw new Error('календарь: поддерживаются только файлы .ics и .json');
    }
    out.filePath = path.resolve(fp);
    if (!out.label) out.label = `Файл: ${path.basename(out.filePath)}`.slice(0, 100);
  } else if (type === 'url') {
    const rawUrl = typeof raw.url === 'string' ? raw.url.trim() : '';
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('календарь: некорректный адрес ленты');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('календарь: адрес ленты должен начинаться с http:// или https://');
    }
    out.url = parsed.toString();
    if (!out.label) out.label = `Календарь (${parsed.hostname})`.slice(0, 100);
  } else if (type === 'mcp') {
    if (typeof raw.server === 'string' && raw.server.trim()) {
      out.server = raw.server.trim().slice(0, 80);
    }
    if (!out.label) out.label = out.server ? `MCP: ${out.server}` : 'MCP-календарь';
  }

  return out;
}

// Безопасное представление настройки для окна интерфейса (без секретов и токенов в URL).
function sanitizeCalendarSettingForUi(setting) {
  let normalized = null;
  try {
    normalized = normalizeCalendarSetting(setting);
  } catch {
    normalized = null;
  }
  if (!normalized) {
    return { connected: false, type: null, label: null };
  }
  return {
    connected: true,
    type: normalized.type,
    label: normalized.label || formatSourceSignature(normalized) || 'Календарь',
    ...(normalized.filePath ? { filePath: normalized.filePath } : {}),
    ...(normalized.url ? { urlMasked: sanitizeSourceText(normalized.url) } : {}),
    ...(normalized.server ? { server: normalized.server } : {}),
    ...(normalized.timeZone ? { timeZone: normalized.timeZone } : {}),
    leadMinutes: Number.isInteger(normalized.leadMinutes) ? normalized.leadMinutes : DEFAULT_LEAD_MINUTES,
    morningBriefing: normalized.morningBriefing !== false,
    morningBriefingHour: Number.isInteger(normalized.morningBriefingHour) ? normalized.morningBriefingHour : 8,
  };
}

module.exports = {
  CALENDAR_STATES,
  STATE_LABELS,
  TZID_ALIASES,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_LEAD_MINUTES,
  sanitizeSourceText,
  formatSourceSignature,
  normalizeTimeZone,
  getZonedParts,
  wallComponentsToUtcMs,
  dayBoundsInZone,
  formatTimeInZone,
  formatDateInZone,
  parseEventDateTime,
  parseIcsDurationMs,
  parseIcsCalendar,
  normalizeEvent,
  dedupeEvents,
  detectConflicts,
  normalizeAndAnalyzeEvents,
  getUpcomingEvents,
  fetchCalendar,
  normalizeCalendarSnapshot,
  buildMorningBriefing,
  CalendarNotificationLedger,
  normalizeCalendarSetting,
  sanitizeCalendarSettingForUi,
};
