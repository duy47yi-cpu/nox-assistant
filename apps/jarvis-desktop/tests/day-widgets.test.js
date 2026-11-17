'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMusicHistoryState, musicSnapshot, clockSnapshot } = require('../src/widgets/day');
const { clockView, musicView, MUSIC_STALE_MS } = require('../renderer/aether/widgets-model');

const now = Date.parse('2026-11-16T16:07:00.000Z');

test('отсутствующая и пустая история отличается от испорченной и недоступной', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-day-widgets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'music-history.json');
  const read = () => musicSnapshot(readMusicHistoryState(file)).music;
  assert.equal(read().state, 'empty');
  for (const content of ['', '[]', '   ']) {
    fs.writeFileSync(file, content);
    assert.equal(read().state, 'empty');
  }
  for (const content of ['{сломано', '{}']) {
    fs.writeFileSync(file, content);
    const snapshot = read();
    assert.equal(snapshot.error, 'bad_history');
    assert.match(musicView(snapshot, now).detail, /повреждён/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
  assert.equal(readMusicHistoryState(dir).error, 'read_failed');
  assert.match(musicView({ state: 'error', error: 'read_failed' }, now).detail, /доступа/);
});

test('история показывает запрос и сервис, а давность считается по отметке записи', () => {
  const at = new Date(now - MUSIC_STALE_MS).toISOString();
  const { music } = musicSnapshot({ entries: [null, { query: 'Кино', service: 'yandex', at }], error: null });
  assert.equal(musicView(music, now).state, 'ok');
  const stale = musicView(music, now + 1);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.title, '«Кино»');
  assert.match(stale.detail, /^Яндекс Музыка · /);
  const old = musicSnapshot({ entries: [{ query: 'Кино', service: 'constructor' }], error: null }).music;
  assert.deepEqual(old.last, { query: 'Кино', service: null, at: null });
  assert.equal(musicView(old, now).detail, '');
  assert.equal(musicView({ state: 'hidden' }, now).state, 'hidden');
  assert.equal(musicView({ state: 'empty' }, now).title, 'Ещё не включали');
});

test('в окно передаются короткие строки, поиск сохраняет исходный музыкальный запрос', () => {
  const entry = { query: '🎵'.repeat(121), service: 'youtube_music', at: new Date(now).toISOString() };
  const { music, entry: original } = musicSnapshot({ entries: [entry], error: null });
  assert.equal(music.last.query, '🎵'.repeat(120));
  assert.equal(original.query, entry.query);
  assert.equal(music.serviceTitle, 'YouTube Music');
});

test('Далее выбирает просрочку раньше сегодняшнего срока и форматирует системное время', () => {
  const overdue = { text: 'Позвонить', dueAt: '2026-11-16T15:00:00.000Z' };
  const today = { text: 'Созвон', dueAt: '2026-11-16T16:47:00.000Z' };
  const tomorrow = { text: 'Отправить отчёт', dueAt: '2026-11-17T16:47:00.000Z' };
  const build = (items) => clockSnapshot(() => items, now, 'Asia/Oral');
  assert.equal(build([overdue, today]).next.overdue, true);
  const view = clockView(build([today, tomorrow]), now);
  assert.equal(view.time, '21:07');
  assert.equal(view.date, 'понедельник, 16 ноября');
  assert.equal(view.reminder.text, 'Далее · 21:47 · Созвон · через 40 мин');
  assert.match(clockView(build([today]), now + 41 * 60000).reminder.text, /^Просрочено/);
  assert.equal(build([tomorrow]).next, null);
  assert.equal(build([]).next, null);
});

test('ошибка напоминаний и нераспознанная зона оставляют системные часы без строки Далее', () => {
  const system = clockSnapshot(() => [], now);
  const fallback = clockSnapshot(() => { throw new Error('unavailable'); }, now, 'Bad/TimeZone');
  assert.equal(fallback.state, 'timezone_fallback');
  assert.equal(fallback.next, null);
  assert.deepEqual(clockView(fallback, now), clockView(system, now));
});
