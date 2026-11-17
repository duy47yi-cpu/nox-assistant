/* Представление локальных данных панели без привязки к DOM. */
(function (root) {
  'use strict';

  const { formatClock, formatChatStamp } = typeof module !== 'undefined' && module.exports
    ? require('./time') : root.NoxAetherTime;
  const MUSIC_STALE_MS = 12 * 60 * 60 * 1000;

  function clockView(clock, now) {
    const timeZone = clock?.timeZone || undefined;
    const longDate = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone });
    const shortDate = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone });
    const time = timeZone
      ? new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone }).format(now)
      : formatClock(now);
    const next = clock?.next;
    let reminder = null;
    if (next?.kind === 'reminder' && next.state === 'ok') {
      const at = Date.parse(next.at);
      const due = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone }).format(at);
      const overdue = at < now;
      const label = overdue ? 'Просрочено' : 'Далее';
      const relative = !overdue && at > now
        ? ` · через ${Math.ceil((at - now) / 60000)} мин` : '';
      reminder = { text: `${label} · ${due} · ${next.text}${relative}`, overdue };
    }
    return { time, date: longDate.format(now), shortDate: shortDate.format(now), reminder };
  }

  function musicView(music, now) {
    const last = music.last;
    if (music.state === 'ok' && last?.query) {
      const at = Date.parse(last.at);
      const stale = Number.isFinite(at) && now - at > MUSIC_STALE_MS;
      const stamp = formatChatStamp(at, now);
      const when = stamp === 'вчера' ? `вчера в ${formatClock(at)}` : stamp;
      return {
        state: stale ? 'stale' : 'ok',
        title: `«${last.query}»`,
        detail: [music.serviceTitle, when].filter(Boolean).join(' · '),
        shortDetail: [music.serviceTitle, stamp].filter(Boolean).join(' · '),
        status: stale ? 'Давняя запись' : 'Последняя музыка',
        last,
      };
    }
    if (music.state === 'error') {
      const errors = { bad_history: 'Файл истории повреждён', read_failed: 'Нет доступа к истории' };
      return {
        state: 'error',
        title: 'История музыки недоступна',
        detail: errors[music.error] || 'Не удалось прочитать историю',
        status: 'Ошибка',
      };
    }
    if (music.state === 'empty') {
      return { state: 'empty', title: 'Ещё не включали', detail: 'Скажите Nox «включи музыку»', status: 'История пуста' };
    }
    return { state: music.state };
  }

  const exported = { clockView, musicView, MUSIC_STALE_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.NoxDayWidgetsModel = exported;
})(typeof window !== 'undefined' ? window : globalThis);
