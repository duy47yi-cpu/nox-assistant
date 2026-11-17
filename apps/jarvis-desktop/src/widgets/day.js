'use strict';

const fs = require('node:fs');
const { SERVICES } = require('../music/intent');

function readMusicHistoryState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    return { entries: [], error: err.code === 'ENOENT' ? null : 'read_failed' };
  }
  if (!raw) return { entries: [], error: null };
  try {
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) return { entries, error: null };
  } catch { /* Повреждённая история остаётся на диске. */ }
  return { entries: [], error: 'bad_history' };
}

function musicSnapshot({ entries, error }) {
  for (const entry of entries) {
    if (typeof entry?.query !== 'string' || !entry.query.trim()) continue;
    const service = typeof entry.service === 'string' && Object.hasOwn(SERVICES, entry.service) ? entry.service : null;
    const at = Date.parse(entry.at);
    const last = {
      query: Array.from(entry.query.trim()).slice(0, 120).join(''),
      service,
      at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    };
    return {
      music: { state: 'ok', error: null, last, serviceTitle: service ? SERVICES[service].title : null },
      entry,
    };
  }
  return { music: { state: error ? 'error' : 'empty', error, last: null }, entry: null };
}

function clockSnapshot(readReminders, now, timeZone) {
  let state = 'ok';
  let dates;
  try {
    dates = new Intl.DateTimeFormat('ru-RU', { timeZone });
  } catch {
    state = 'timezone_fallback';
    dates = new Intl.DateTimeFormat('ru-RU');
    timeZone = undefined;
  }
  const clock = { state, timeZone: timeZone || null, next: null };
  const today = dates.format(now);
  try {
    // RemindersStore уже отдаёт невыполненные напоминания по сроку.
    for (const item of readReminders()) {
      const at = Date.parse(item?.dueAt);
      const text = typeof item?.text === 'string' ? item.text.trim() : '';
      if (!text || !Number.isFinite(at) || (at >= now && dates.format(at) !== today)) continue;
      clock.next = {
        kind: 'reminder',
        state: 'ok',
        text: Array.from(text).slice(0, 200).join(''),
        at: new Date(at).toISOString(),
        overdue: at < now,
        source: 'Напоминания',
      };
      break;
    }
  } catch { /* Нарушение чтения напоминаний не отключает часы. */ }
  return clock;
}

module.exports = { readMusicHistoryState, musicSnapshot, clockSnapshot };
