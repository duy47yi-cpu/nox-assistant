'use strict';

// Рабочие столы: вкладки столов, сетка виджетов и их данные.
// Слой данных и проверки — src/desks (store/templates/data); здесь только окно.
(function () {
  const U = window.JarvisUI;
  if (!U) return;

  const DEPS = { toast: () => {}, ask: async () => false };
  const DESK = { open: false, loaded: false, loading: false, desks: [], activeId: null, templates: [], types: [], data: {}, now: 0, busy: false, timer: 0, dragId: null, dialogMode: 'create', editId: null, petTimers: [] };

  const $ = (sel, root = document) => (root || document).querySelector(sel);
  const el = (tag, attrs, ...children) => U.el(tag, attrs, ...children);

  const stateWords = {
    empty: 'нет данных',
    error: 'не удалось получить',
    stale: 'устарело',
  };

  const errorWords = {
    network: 'нет связи с источником',
    bad_data: 'источник вернул неполные данные',
    bad_source: 'источник недоступен',
    no_city: 'город не указан — добавьте его в настройках',
    no_data: 'данных пока нет',
    bad_state: 'состояние недоступно',
    bad_type: 'виджет неизвестного типа',
    folder_required: 'папка загрузок не указана',
    not_found: 'папки загрузок нет',
    not_directory: 'это не папка',
    timeout: 'источник не ответил вовремя',
    no_urls: 'источники новостей не заданы',
    no_fetch: 'загрузка сейчас недоступна',
    bad_xml: 'источник вернул неверный формат',
    bad_response: 'источник ответил непонятно',
    bad_input: 'источник прислал пустой ответ',
    bad_ics: 'файл календаря не удалось разобрать (.ics)',
    bad_json: 'данные календаря в неверном формате',
    bad_url: 'неверный адрес календарной ленты',
    too_large: 'данные календаря слишком большие',
    bad_redirect: 'небезопасная переадресация источника',
    mcp_error: 'подключённый сервис календаря вернул ошибку',
    source_error: 'источник календаря недоступен',
    calendar_error: 'ошибка чтения календаря',
  };

  const calendarErrorWords = {
    not_found: 'файл календаря не найден',
    network: 'нет связи с источником календаря',
    timeout: 'источник календаря не ответил вовремя',
    bad_source: 'источник календаря недоступен',
  };

  // Питомец — только украшение: фиксированные настроения, никаких «показаний».
  const PET_FACES = { idle: '😺', curious: '🐾', sleepy: '😴' };
  const PET_WORDS = { idle: 'спокойно сидит', curious: 'смотрит на вас', sleepy: 'дремлет' };
  const MCP_STATUS_WORDS = {
    connected: 'подключён', connecting: 'подключается', error: 'ошибка',
    disabled: 'выключен', idle: 'не подключён',
  };

  function errorText(code, isCalendar = false) {
    if (!code) return 'причина неизвестна';
    const raw = String(code);
    if (isCalendar && calendarErrorWords[raw]) return calendarErrorWords[raw];
    if (errorWords[raw]) return errorWords[raw];
    const http = /(?:^|\b)http_(\d+)/i.exec(raw);
    if (http) return `источник ответил ошибкой ${http[1]}`;
    if (isCalendar) {
      if (/\bENOENT\b|no such file/i.test(raw)) return calendarErrorWords.not_found;
      if (/\b(EACCES|EPERM)\b/i.test(raw)) return 'нет доступа к файлу календаря';
      if (/timed out|timeout|aborted|\bETIMEDOUT\b/i.test(raw)) return calendarErrorWords.timeout;
      if (/\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN)\b/i.test(raw)) return calendarErrorWords.network;
      if (/JSON|SyntaxError|Unexpected token/i.test(raw)) return errorWords.bad_json;
      if (/VCALENDAR|ICS/i.test(raw)) return errorWords.bad_ics;
    }
    return 'причина неизвестна';
  }

  const taskStatusWords = {
    draft: 'черновик', queued: 'в очереди', running: 'в работе', paused: 'на паузе',
    waiting_approval: 'ждёт решения', blocked: 'заблокировано', done: 'готово', failed: 'провалено',
    unverified: 'не проверено', cancelled: 'отменено',
  };

  const W = {};

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let v = Math.max(0, n);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function shortTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n)) return '';
    return new Date(n).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  // Дата новости без года: в маленьком виджете важнее «когда», а не полный штамп.
  function shortDate(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n)) return '';
    return new Date(n).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }

  function label(text) {
    return el('span', { class: 'desk-widget-label', text });
  }

  function widgetList(entries) {
    return el('ul', { class: 'desk-list' }, ...entries.map((entry) => el('li', { class: 'desk-list-item' },
      el('span', { class: 'desk-list-text', text: entry.text }),
      entry.note ? el('span', { class: 'desk-list-note', text: entry.note }) : null)));
  }

  function formatDateKeyLabel(dateKey, todayKey, tomorrowKey) {
    if (!dateKey || typeof dateKey !== 'string') return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
    let short = dateKey;
    if (m) {
      const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      short = dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    }
    if (todayKey && dateKey === todayKey) return `Сегодня · ${short}`;
    if (tomorrowKey && dateKey === tomorrowKey) return `Завтра · ${short}`;
    if (m) {
      const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      const wd = dt.toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' });
      return `${wd}, ${short}`;
    }
    return short;
  }

  function formatFetchedNote(fetchedAt) {
    if (!fetchedAt) return '';
    const ms = typeof fetchedAt === 'number' ? fetchedAt : Date.parse(fetchedAt);
    if (!Number.isFinite(ms)) return '';
    return `обновлено ${shortDate(ms)}, ${shortTime(ms)}`;
  }

  function formatStartsIn(mins) {
    if (!Number.isFinite(mins) || mins <= 0) return '';
    if (mins < 60) return `через ${mins} мин`;
    const h = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `через ${h} ч ${rem} мин` : `через ${h} ч`;
  }

  function appendCalendarConnectControls(container, calState, options = {}) {
    if (!U.has) return container;
    const connected = Boolean(calState && calState !== 'not_connected');
    const actions = el('div', { class: 'desk-cal-actions' });

    const pickBtn = el('button', {
      type: 'button',
      class: 'btn btn-secondary btn-sm desk-cal-pick',
      text: connected ? (options.compact ? 'Сменить' : 'Сменить календарь') : 'Подключить .ics/.json',
    });
    pickBtn.addEventListener('click', async () => {
      try {
        const r = await U.call('calendarPickFile');
        if (r && r.ok === false) { toastError(r); return; }
        if (r && !r.canceled) await refresh();
      } catch (err) { toastError({ error: err.message }); }
    });
    actions.appendChild(pickBtn);

    let urlWrap = null;
    if (U.has('calendarSetSource')) {
      const urlToggle = el('button', {
        type: 'button',
        class: 'btn btn-secondary btn-sm desk-cal-url-btn',
        'aria-expanded': 'false',
        text: 'По ссылке',
      });
      const urlErr = el('p', { class: 'desk-cal-url-err', hidden: true });
      const urlInput = el('input', {
        type: 'url',
        class: 'input desk-cal-url-input',
        placeholder: 'https://…/calendar.ics',
        'aria-label': 'Адрес календарной ленты (.ics или .json)',
      });
      const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-sm', text: 'Подключить' });
      const cancelBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm desk-cal-url-cancel', text: 'Отмена' });
      const urlForm = el('form', { class: 'desk-cal-url-form', hidden: true },
        urlInput,
        el('span', { class: 'desk-cal-url-btns' }, submitBtn, cancelBtn),
        urlErr);

      urlToggle.addEventListener('click', () => {
        const open = urlForm.hidden;
        urlForm.hidden = !open;
        urlToggle.setAttribute('aria-expanded', String(open));
        if (open) urlInput.focus();
      });
      cancelBtn.addEventListener('click', () => {
        urlForm.hidden = true;
        urlToggle.setAttribute('aria-expanded', 'false');
        urlErr.hidden = true;
        urlErr.textContent = '';
      });
      urlForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = urlInput.value.trim();
        if (!url) {
          urlErr.textContent = 'Укажите адрес ленты (http:// или https://).';
          urlErr.hidden = false;
          return;
        }
        submitBtn.disabled = true;
        urlErr.hidden = true;
        try {
          const r = await U.call('calendarSetSource', { type: 'url', url });
          if (r && r.ok === false) {
            urlErr.textContent = r.error || 'Не удалось подключить ссылку';
            urlErr.hidden = false;
            return;
          }
          await refresh();
        } catch (err) {
          urlErr.textContent = (err && err.message) || 'Не удалось подключить ссылку';
          urlErr.hidden = false;
        } finally {
          submitBtn.disabled = false;
        }
      });
      actions.appendChild(urlToggle);
      urlWrap = urlForm;
    }

    if (connected) {
      const clearBtn = el('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm desk-cal-clear',
        text: 'Отключить',
      });
      clearBtn.addEventListener('click', async () => {
        try {
          const r = await U.call('calendarSetSource', null);
          if (r && r.ok === false) { toastError(r); return; }
          await refresh();
        } catch (err) { toastError({ error: err.message }); }
      });
      actions.appendChild(clearBtn);
    }

    container.appendChild(actions);
    if (urlWrap) container.appendChild(urlWrap);
    return container;
  }

  function calendarFooter(calState, sourceLabel) {
    const statusText = calState === 'not_connected'
      ? 'Календарь не подключён'
      : calState === 'error'
        ? (sourceLabel ? `Ошибка календаря (${sourceLabel})` : 'Ошибка календаря')
        : calState === 'stale'
          ? (sourceLabel ? `Устаревшие данные · ${sourceLabel}` : 'Устаревшие данные календаря')
          : calState === 'empty'
            ? (sourceLabel ? `Встреч нет · ${sourceLabel}` : 'Встреч на сегодня нет')
            : (sourceLabel || 'Календарь подключён');
    const row = el('div', { class: 'desk-cal-bar' },
      el('span', { class: 'desk-widget-note desk-cal-status', 'data-cal-state': calState || 'not_connected', text: statusText }));
    return appendCalendarConnectControls(row, calState, { compact: false });
  }

  function calendarMetaStrip(value, state, extraParts = []) {
    const parts = [];
    if (state === 'stale') {
      const age = formatFetchedNote(value && value.fetchedAt);
      parts.push(el('span', { class: 'tag desk-stale', text: age ? `устарело · ${age}` : 'устарело' }));
    }
    const sourceText = value && (value.sourceLabel || (value.source ? `Источник: ${value.source}` : ''));
    if (sourceText) parts.push(el('span', { class: 'desk-cal-source-tag', text: sourceText }));
    if (value && value.timeZone) parts.push(el('span', { class: 'desk-cal-tz', text: value.timeZone }));
    for (const extra of extraParts) {
      if (extra) parts.push(el('span', { class: 'desk-cal-extra', text: extra }));
    }
    if (!parts.length) return null;
    return el('div', { class: 'desk-cal-meta' }, ...parts);
  }

  function calendarConflictsBanner(conflicts) {
    if (!Array.isArray(conflicts) || conflicts.length === 0) return null;
    const shown = conflicts.slice(0, 2).map((c) => {
      const a = c && Array.isArray(c.titles) ? c.titles[0] : 'Встреча';
      const b = c && Array.isArray(c.titles) ? c.titles[1] : 'Встреча';
      const mins = c && Number.isFinite(c.overlapMinutes) ? ` (${c.overlapMinutes} мин)` : '';
      return `«${a}» и «${b}»${mins}`;
    });
    if (conflicts.length > 2) shown.push(`и ещё ${conflicts.length - 2}`);
    return el('div', { class: 'desk-cal-conflicts-box', role: 'status' },
      el('span', { class: 'desk-pill desk-pill-conflict', text: `Пересечения: ${conflicts.length}` }),
      el('span', { class: 'desk-cal-conflicts-text', text: shown.join('; ') }));
  }

  function renderCalendarLoading(type) {
    return el('div', { class: 'desk-widget-body-inner desk-cal-loading', role: 'status', 'data-state': 'loading' },
      el('p', { class: 'desk-widget-state', text: type === 'meetings' ? 'Загружаем ближайшие встречи…' : 'Загружаем события календаря…' }),
      el('div', { class: 'desk-skeleton', 'aria-hidden': 'true' },
        el('span', { class: 'desk-skeleton-line' }),
        el('span', { class: 'desk-skeleton-line desk-skeleton-line-short' })));
  }

  function renderCalendarDisconnected(type) {
    const title = type === 'meetings' ? 'Источник встреч не подключён' : 'Календарь не подключён';
    const desc = type === 'meetings'
      ? 'Подключите файл .ics/.json или ссылку на календарь — покажем ближайшие встречи, локальное время и пересечения.'
      : 'Подключите файл .ics/.json или ссылку на ленту, чтобы видеть расписание в локальном времени.';
    const box = el('div', { class: 'desk-widget-body-inner desk-cal-connect', 'data-state': 'not_connected' },
      el('p', { class: 'desk-widget-state', 'data-state': 'not_connected', text: title }),
      el('p', { class: 'desk-widget-note', text: desc }));
    appendCalendarConnectControls(box, 'not_connected', { compact: false });
    box.appendChild(el('p', { class: 'desk-widget-note desk-cal-mcp-hint', text: 'Календарь из внешнего сервиса можно добавить в разделе «Подключения».' }));
    return box;
  }

  function renderCalendarEmpty(type, value, state) {
    const isMeetings = type === 'meetings';
    const wrap = el('div', { class: 'desk-widget-body-inner desk-cal-empty', 'data-state': state || 'empty' });
    const meta = calendarMetaStrip(value, state, isMeetings && value && value.windowDays ? [`Окно: ${value.windowDays} дн.`] : []);
    if (meta) wrap.appendChild(meta);
    let mainText = isMeetings ? 'Предстоящих встреч нет' : 'Событий в календаре нет';
    let subText = 'Источник подключён, но подходящих событий не найдено.';
    if (isMeetings && value && value.hasOtherEvents) {
      const days = value.windowDays || 7;
      mainText = `На ближайшие ${days} дн. встреч нет`;
      subText = `В календаре есть ещё ${value.totalInCalendar} прошедших или более поздних событий.`;
    }
    wrap.appendChild(el('p', { class: 'desk-widget-state', 'data-state': 'empty', text: mainText }));
    wrap.appendChild(el('p', { class: 'desk-widget-note', text: subText }));
    wrap.appendChild(appendCalendarConnectControls(el('div', { class: 'desk-cal-foot' }), 'empty', { compact: true }));
    return wrap;
  }

  function renderCalendarError(datum) {
    const value = datum && datum.value;
    const msg = errorText(datum && datum.error, true);
    const wrap = el('div', { class: 'desk-widget-body-inner desk-cal-error', 'data-state': 'error' });
    const meta = calendarMetaStrip(value, 'error');
    if (meta) wrap.appendChild(meta);
    wrap.appendChild(el('p', { class: 'desk-widget-state', 'data-state': 'error', text: `Не получилось: ${msg}` }));
    const calState = value && value.connected === false ? 'not_connected' : 'error';
    wrap.appendChild(appendCalendarConnectControls(el('div', { class: 'desk-cal-foot' }), calState, { compact: true }));
    return wrap;
  }

  function renderCalendarWidgetBody(datum) {
    const state = datum.state;
    const value = datum.value || {};
    const items = Array.isArray(value.items) ? value.items : [];
    const wrap = el('div', { class: 'desk-widget-body-inner desk-cal-widget', 'data-state': state });
    const countNote = value.total > items.length ? `Показано ${items.length} из ${value.total}` : (items.length ? `Событий: ${value.total || items.length}` : '');
    const meta = calendarMetaStrip(value, state, countNote ? [countNote] : []);
    if (meta) wrap.appendChild(meta);
    const conflictBanner = calendarConflictsBanner(value.conflicts);
    if (conflictBanner) wrap.appendChild(conflictBanner);

    const groups = new Map();
    for (const ev of items) {
      const key = ev.dateLocal || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    }

    const daysWrap = el('div', { class: 'desk-cal-days' });
    for (const [dateKey, dayEvents] of groups.entries()) {
      const dayLabel = dateKey ? formatDateKeyLabel(dateKey, value.todayDateKey, value.tomorrowDateKey) : 'Расписание';
      const listEl = el('ul', { class: 'desk-cal-list' }, ...dayEvents.map((ev) => {
        const badges = [];
        if (ev.ongoing) badges.push(el('span', { class: 'desk-pill desk-pill-live', text: 'сейчас' }));
        if (ev.conflict) badges.push(el('span', { class: 'desk-pill desk-pill-conflict', text: 'пересечение' }));
        const subParts = [ev.source || value.source || 'Календарь'];
        if (ev.location) subParts.push(ev.location);
        return el('li', { class: 'desk-cal-row' + (ev.conflict ? ' is-conflict' : '') + (ev.ongoing ? ' is-ongoing' : '') },
          el('span', { class: 'desk-cal-time', text: ev.timeLabel || ev.startLocal || '' }),
          el('div', { class: 'desk-cal-main' },
            el('div', { class: 'desk-cal-row-head' },
              el('span', { class: 'desk-cal-title', text: ev.title || 'Событие' }),
              ...badges),
            el('span', { class: 'desk-cal-sub', text: subParts.join(' · ') })));
      }));
      daysWrap.appendChild(el('div', { class: 'desk-cal-day' },
        el('div', { class: 'desk-cal-day-head', text: dayLabel }),
        listEl));
    }
    wrap.appendChild(daysWrap);

    if (typeof value.briefing === 'string' && value.briefing.trim()) {
      wrap.appendChild(el('details', { class: 'desk-cal-briefing' },
        el('summary', { class: 'desk-widget-note desk-cal-briefing-sum', text: 'Утренняя сводка' }),
        el('pre', { class: 'desk-widget-note desk-cal-briefing-text', text: value.briefing })));
    }
    wrap.appendChild(appendCalendarConnectControls(el('div', { class: 'desk-cal-foot' }), state, { compact: true }));
    return wrap;
  }

  function renderMeetingsWidgetBody(datum) {
    const state = datum.state;
    const value = datum.value || {};
    const items = Array.isArray(value.items) ? value.items : [];
    if (!items.length) return renderCalendarEmpty('meetings', value, state);

    const wrap = el('div', { class: 'desk-widget-body-inner desk-meet-widget', 'data-state': state });
    const conflicts = Array.isArray(value.conflicts) ? value.conflicts : [];
    const extras = [];
    if (value.windowDays) extras.push(`На ${value.windowDays} дн.`);
    extras.push(`Встреч: ${Number.isFinite(value.total) ? value.total : items.length}`);
    if (conflicts.length > 0) extras.push(`Пересечений: ${conflicts.length}`);
    const meta = calendarMetaStrip(value, state, extras);
    if (meta) wrap.appendChild(meta);

    const conflictBanner = calendarConflictsBanner(conflicts);
    if (conflictBanner) wrap.appendChild(conflictBanner);

    const listEl = el('ul', { class: 'desk-meet-list' }, ...items.map((ev) => {
      const badges = [];
      if (ev.ongoing) badges.push(el('span', { class: 'desk-pill desk-pill-live', text: 'идёт сейчас' }));
      else if (ev.isToday && Number.isFinite(ev.startsInMinutes) && ev.startsInMinutes > 0 && ev.startsInMinutes <= 240) {
        badges.push(el('span', { class: 'desk-pill desk-pill-soon', text: formatStartsIn(ev.startsInMinutes) }));
      }
      if (ev.conflict) badges.push(el('span', { class: 'desk-pill desk-pill-conflict', text: 'пересечение' }));

      const whenParts = [];
      if (ev.dateLocal) whenParts.push(formatDateKeyLabel(ev.dateLocal, value.todayDateKey, value.tomorrowDateKey));
      if (ev.timeLabel) whenParts.push(ev.timeLabel);
      const whenLine = whenParts.join(', ');
      const sourceText = `Источник: ${ev.source || value.source || 'Календарь'}`;
      const subParts = [sourceText];
      if (ev.location) subParts.push(ev.location);

      return el('li', { class: 'desk-meet-row' + (ev.conflict ? ' is-conflict' : '') + (ev.ongoing ? ' is-ongoing' : '') },
        el('div', { class: 'desk-cal-row-head' },
          el('span', { class: 'desk-cal-title', text: ev.title || 'Встреча' }),
          ...badges),
        whenLine ? el('span', { class: 'desk-meet-when', text: whenLine }) : null,
        el('span', { class: 'desk-cal-sub', text: subParts.join(' · ') }));
    }));
    wrap.appendChild(listEl);

    if (value.total > items.length) {
      wrap.appendChild(el('p', { class: 'desk-widget-note', text: `Показано ${items.length} из ${value.total}` }));
    }
    wrap.appendChild(appendCalendarConnectControls(el('div', { class: 'desk-cal-foot' }), state, { compact: true }));
    return wrap;
  }

  function renderBody(widget, datum) {
    const type = widget.type;
    const isCalType = type === 'calendar' || type === 'meetings';
    if ((DESK.loading && !datum) || (datum && datum.state === 'loading')) {
      if (isCalType) return renderCalendarLoading(type);
      return el('div', { class: 'desk-widget-body-inner', 'data-state': 'loading' },
        el('p', { class: 'desk-widget-state', text: 'Загружаем данные…' }));
    }
    const state = datum && datum.state ? datum.state : 'empty';
    const value = datum ? datum.value : null;
    // Питомец не зависит от состояния источника: это украшение, а не показатель.
    if (type === 'pet') {
      const mood = value && PET_FACES[value.mood] ? value.mood : 'idle';
      return el('div', { class: 'desk-widget-body-inner' },
        el('div', { class: 'desk-pet' },
          el('span', {
            class: 'desk-pet-face',
            'aria-hidden': 'true',
            text: PET_FACES[mood],
          }),
          el('span', { class: 'desk-pet-word', text: PET_WORDS[mood] })),
        el('p', { class: 'desk-widget-note', text: 'декоративная анимация — без данных и показаний' }));
    }
    if (state === 'not_connected') {
      if (isCalType) return renderCalendarDisconnected(type);
      return el('p', { class: 'desk-widget-state', 'data-state': 'not_connected', text: 'Источник не подключён' });
    }
    if (state === 'error') {
      if (isCalType) return renderCalendarError(datum);
      if (type === 'today') {
        return el('div', { class: 'desk-widget-body-inner' },
          el('p', { class: 'desk-widget-state', 'data-state': 'error', text: 'Не получилось: ' + errorText(datum && datum.error, true) }),
          calendarFooter('error', value && value.sourceLabel));
      }
      return el('p', { class: 'desk-widget-state', 'data-state': 'error', text: 'Не получилось: ' + errorText(datum && datum.error) });
    }
    if (state === 'empty') {
      if (isCalType) return renderCalendarEmpty(type, value, 'empty');
      const words = {
        tasks: 'Незавершённых задач нет',
        today: 'На сегодня ничего не ждёт',
        music: 'Ещё не просили музыку',
        weather: (datum && datum.error === 'no_city') || (value && value.city == null) ? 'Укажите город в настройках погоды' : 'Данных о погоде нет',
        currency: 'Курс пока не получен',
        system: 'Снимок компьютера недоступен',
        apps: 'Статистики программ пока нет',
        orb: 'Шар ждёт задачу',
        commands: 'Своих команд пока нет',
        goals: 'Активных целей нет',
        missions: 'Фоновых задач нет',
        reminders: 'Напоминаний нет',
        notes: 'Записей в памяти нет',
        downloads: 'Папка загрузок пуста или ещё не передана',
        mcp: 'MCP-сервисы не подключены',
        news: 'Новостей нет',
        calendar: 'Событий в календаре нет',
        meetings: 'Предстоящих встреч нет',
        pet: 'Питомец',
      };
      if (type === 'today') {
        return el('div', { class: 'desk-widget-body-inner' },
          el('p', { class: 'desk-widget-state', 'data-state': 'empty', text: words.today }),
          calendarFooter(value && value.calendarState ? value.calendarState : 'not_connected', value && value.sourceLabel));
      }
      return el('p', { class: 'desk-widget-state', 'data-state': 'empty', text: words[type] || stateWords.empty });
    }
    if (type === 'calendar') return renderCalendarWidgetBody(datum || { state: 'empty', value: null });
    if (type === 'meetings') return renderMeetingsWidgetBody(datum || { state: 'empty', value: null });
    const parts = [];
    if (state === 'stale') parts.push(el('span', { class: 'tag desk-stale', text: 'устарело' }));
    if (type === 'tasks') {
      const items = (value && Array.isArray(value.items)) ? value.items : [];
      parts.push(widgetList(items.map((item) => ({ text: item.title, note: taskStatusWords[item.status] || item.status }))));
    } else if (type === 'today') {
      const rows = [];
      for (const ev of (value && Array.isArray(value.events)) ? value.events : []) {
        const conflictMark = ev.conflict ? ' [Конфликт]' : '';
        rows.push({
          text: `${ev.title || 'Встреча'}${conflictMark}`,
          note: [ev.timeLabel || '', ev.source || ''].filter(Boolean).join(' · '),
        });
      }
      for (const rem of (value && Array.isArray(value.reminders)) ? value.reminders : []) {
        rows.push({ text: rem.text || 'Напоминание', note: rem.dueAt ? shortTime(new Date(rem.dueAt).getTime()) : '' });
      }
      for (const mission of (value && Array.isArray(value.missions)) ? value.missions : []) {
        rows.push({ text: String(mission.goal || mission.title || 'Миссия').slice(0, 120), note: mission.nextRun ? shortTime(new Date(mission.nextRun).getTime()) : 'миссия' });
      }
      parts.push(rows.length ? widgetList(rows) : el('p', { class: 'desk-widget-state', text: 'Пусто' }));
      if (value && Array.isArray(value.conflicts) && value.conflicts.length > 0) {
        const conflictText = value.conflicts.map((c) => `«${c.titles[0]}» и «${c.titles[1]}» (${c.overlapMinutes} мин)`).join('; ');
        parts.push(el('p', { class: 'desk-widget-note desk-cal-conflicts', text: `Пересечения встреч (${value.conflicts.length}): ${conflictText}` }));
      }
      if (value && typeof value.briefing === 'string' && value.briefing.trim()) {
        const details = el('details', { class: 'desk-cal-briefing' },
          el('summary', { class: 'desk-widget-note desk-cal-briefing-sum', text: 'Утренняя сводка' }),
          el('pre', { class: 'desk-widget-note desk-cal-briefing-text', text: value.briefing }));
        parts.push(details);
      }
      parts.push(calendarFooter(value && value.calendarState ? value.calendarState : 'not_connected', value && value.sourceLabel));
    } else if (type === 'music') {
      if (value && value.last && value.last.query) {
        parts.push(el('p', { class: 'desk-big', text: '«' + value.last.query + '»' }));
        parts.push(el('p', { class: 'desk-widget-note', text: [value.last.service, value.last.at ? shortTime(new Date(value.last.at).getTime()) : ''].filter(Boolean).join(' · ') }));
      } else {
        parts.push(el('p', { class: 'desk-widget-state', text: 'Ещё не просили музыку' }));
      }
    } else if (type === 'weather') {
      if (value && typeof value.temp === 'number') {
        parts.push(el('p', { class: 'desk-big', text: Math.round(value.temp) + '°' }));
        parts.push(el('p', { class: 'desk-widget-note', text: [value.city, typeof value.apparent === 'number' ? 'ощущается ' + Math.round(value.apparent) + '°' : '', typeof value.precipitation === 'number' ? 'осадки ' + value.precipitation.toFixed(1) + ' мм' : ''].filter(Boolean).join(' · ') }));
      } else {
        parts.push(el('p', { class: 'desk-widget-state', text: 'Данных о погоде нет' }));
      }
    } else if (type === 'currency') {
      const rates = (value && Array.isArray(value.rates)) ? value.rates : [];
      parts.push(widgetList(rates.map((rate) => ({
        text: `${rate.name || rate.code} ${Number(rate.value).toFixed(2).replace('.', ',')} ₽`,
        note: typeof rate.previous === 'number' && Math.abs(rate.value - rate.previous) >= 0.005
          ? (rate.value > rate.previous ? '+' : '−') + Math.abs(rate.value - rate.previous).toFixed(2).replace('.', ',')
          : '',
      }))));
      if (value && value.date) parts.push(el('p', { class: 'desk-widget-note', text: 'ЦБ на ' + new Date(value.date).toLocaleDateString('ru-RU') }));
    } else if (type === 'system') {
      if (value) {
        const bar = (name, percent) => el('div', { class: 'desk-meter' },
          el('span', { class: 'desk-meter-name', text: name }),
          el('span', { class: 'desk-meter-track' }, el('span', { class: 'desk-meter-fill', style: `width:${Math.max(0, Math.min(100, Math.round(percent)))}%` })),
          el('span', { class: 'desk-meter-value', text: Math.round(percent) + ' %' }));
        parts.push(bar('Процессор', value.cpuPercent));
        parts.push(bar('Память', value.memPercent));
        parts.push(el('p', { class: 'desk-widget-note', text: [value.memUsed && value.memTotal ? `${fmtBytes(value.memUsed)} из ${fmtBytes(value.memTotal)}` : '', value.platform || ''].filter(Boolean).join(' · ') }));
      }
    } else if (type === 'apps') {
      const items = (value && Array.isArray(value.items)) ? value.items : [];
      parts.push(widgetList(items.map((item) => ({
        text: item.name || item.title || 'программа',
        note: Number.isFinite(item.launches) ? 'запусков: ' + item.launches : '',
      }))));
    } else if (type === 'orb') {
      const word = (value && value.label) || 'Готов';
      parts.push(el('div', { class: 'desk-orb' }, el('span', { class: 'desk-orb-dot', 'data-state': value && value.state }), el('span', { class: 'desk-orb-word', text: word })));
    } else if (type === 'commands') {
      const items = (value && Array.isArray(value.items)) ? value.items : [];
      parts.push(widgetList(items.map((item) => ({
        text: item.name || 'команда',
        note: item.enabled === false ? 'выключена' : (item.lastRunAt ? 'запускалась' : ''),
      }))));
    } else if (type === 'goals') {
      const items = (value && Array.isArray(value.items)) ? value.items : [];
      parts.push(widgetList(items.map((item) => ({
        text: item.title || 'цель',
        note: Number.isInteger(item.stepsTotal) && item.stepsTotal > 0
          ? `шаги: ${item.stepsDone} из ${item.stepsTotal}` : '',
      }))));
    } else if (type === 'missions') {
      const items = (value && Array.isArray(value.items)) ? value.items : [];
      parts.push(widgetList(items.map((item) => ({
        text: String(item.goal || 'миссия').slice(0, 120),
        note: item.enabled === false ? 'выключена'
          : item.status === 'running' ? 'выполняется'
            : (item.nextRunAt ? shortTime(new Date(item.nextRunAt).getTime()) : ''),
      }))));
    } else if (type === 'reminders') {
      const items = (value && Array.isArray(value.items)) ? value.items : [];
      parts.push(widgetList(items.map((item) => ({
        text: String(item.text || 'напоминание').slice(0, 120),
        note: item.overdue ? 'просрочено' : (item.dueAt ? shortTime(new Date(item.dueAt).getTime()) : ''),
      }))));
    } else if (type === 'notes') {
      const items = (value && Array.isArray(value.items)) ? value.items : [];
      parts.push(widgetList(items.map((item) => ({
        text: String(item.text || 'запись').slice(0, 120),
        note: item.about || item.kind || '',
      }))));
      if (value && value.hiddenSensitive > 0) {
        parts.push(el('p', { class: 'desk-widget-note', text: `личных записей скрыто: ${value.hiddenSensitive}` }));
      }
    } else if (type === 'downloads') {
      if (value) {
        const items = Array.isArray(value.items) ? value.items : [];
        // Настоящая цифра уборки: candidateBytes из анализа папки (не весь размер папки); нет данных — строки нет.
        if (Number.isFinite(value.candidateBytes) && value.candidateBytes > 0) {
          parts.push(el('p', { class: 'desk-widget-note', text: `Можно освободить ~${fmtBytes(value.candidateBytes)}` }));
        }
        const parts2 = [];
        if (Number.isFinite(value.fileCount)) parts2.push(`файлов: ${value.fileCount}`);
        if (Number.isFinite(value.totalBytes)) parts2.push(fmtBytes(value.totalBytes));
        if (parts2.length) parts.push(el('p', { class: 'desk-widget-note', text: parts2.join(' · ') }));
        if (items.length) {
          parts.push(widgetList(items.map((item) => ({
            text: item.name,
            note: [Number.isFinite(item.size) ? fmtBytes(item.size) : '', Number.isFinite(item.ageDays) ? item.ageDays + ' дн.' : ''].filter(Boolean).join(' · '),
          }))));
        } else {
          parts.push(el('p', { class: 'desk-widget-state', text: Number.isFinite(value.candidateCount) && value.candidateCount === 0 ? 'Убирать нечего' : 'Крупных файлов нет' }));
        }
        if (Number.isFinite(value.candidateCount) && value.candidateCount > items.length) {
          parts.push(el('p', { class: 'desk-widget-note', text: `можно убрать: ${value.candidateCount} (${Number.isFinite(value.candidateBytes) ? fmtBytes(value.candidateBytes) : 'размер неизвестен'})` }));
        }
        if (value.truncated) parts.push(el('p', { class: 'desk-widget-note', text: 'список неполный: файлов слишком много' }));
      }
    } else if (type === 'mcp') {
      const items = (value && Array.isArray(value.items)) ? value.items : [];
      parts.push(widgetList(items.map((item) => ({
        text: item.name,
        note: [MCP_STATUS_WORDS[item.status] || item.status, item.toolCount ? 'инструментов: ' + item.toolCount : ''].filter(Boolean).join(' · '),
      }))));
      if (value && Number.isFinite(value.connected)) {
        parts.push(el('p', { class: 'desk-widget-note', text: `подключено: ${value.connected} из ${value.total}` }));
      }
    } else if (type === 'news') {
      const items = (value && Array.isArray(value.items)) ? value.items : [];
      // Только текст: без кликов и сети. Ссылка в записи есть, но виджет её не открывает.
      parts.push(el('ul', { class: 'desk-list' }, ...items.map((item) => el('li', { class: 'desk-list-item' },
        el('span', { class: 'desk-list-text' },
          el('span', { text: item.title }),
          item.summary ? el('span', { class: 'desk-widget-note', style: 'display:block;', text: item.summary }) : null),
        el('span', {
          class: 'desk-list-note',
          text: [item.source, item.date ? shortDate(item.date) : ''].filter(Boolean).join(' · '),
        })))));
      if (value && value.fetchedAt) {
        parts.push(el('p', { class: 'desk-widget-note', text: 'получено ' + shortDate(value.fetchedAt) }));
      }
    }
    if (!parts.length) parts.push(el('p', { class: 'desk-widget-state', text: 'Нет данных' }));
    return el('div', { class: 'desk-widget-body-inner' }, ...parts);
  }

  function widgetTitle(type) {
    const found = DESK.types.find((item) => item.id === type);
    return found ? found.title : 'Виджет';
  }

  function renderTabs() {
    if (!W.tabs) return;
    W.tabs.replaceChildren(...DESK.desks.map((desk) => el('button', {
      type: 'button',
      class: 'desk-tab' + (desk.id === DESK.activeId ? ' is-active' : ''),
      role: 'tab',
      'aria-selected': String(desk.id === DESK.activeId),
      'data-desk': desk.id,
      text: desk.name,
      onclick: () => selectDesk(desk.id),
    })));
    if (W.deleteBtn) W.deleteBtn.disabled = DESK.desks.length <= 1;
  }

  function activeDesk() {
    return DESK.desks.find((desk) => desk.id === DESK.activeId) || null;
  }

  // Питомец: простая анимация без картинок и сети — покачивание эмодзи. Таймеры
  // останавливаются перед перерисовкой и при закрытии, чтобы не копились.
  function stopPetTimers() {
    for (const timer of DESK.petTimers) clearInterval(timer);
    DESK.petTimers = [];
  }

  function startPet(article) {
    const face = article.querySelector('.desk-pet-face');
    if (!face) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let up = false;
    const timer = setInterval(() => {
      up = !up;
      face.style.transform = up ? 'translateY(-4px)' : 'translateY(0)';
    }, 1400);
    if (timer && typeof timer.unref === 'function') timer.unref();
    DESK.petTimers.push(timer);
  }

  function renderGrid() {
    if (!W.grid) return;
    stopPetTimers();
    const desk = activeDesk();
    const widgets = desk && Array.isArray(desk.widgets) ? desk.widgets : [];
    W.grid.replaceChildren(...widgets.map((widget) => renderWidget(widget)));
    if (W.empty) W.empty.hidden = widgets.length > 0;
    U.fillIcons(W.grid);
  }

  function renderWidget(widget) {
    const datum = DESK.data[widget.id] || null;
    const article = el('article', {
      class: 'desk-widget',
      role: 'group',
      tabindex: '0',
      draggable: 'true',
      'data-widget': widget.id,
      'aria-label': `${widgetTitle(widget.type)}: виджет ${widget.x}×${widget.y}, ${widget.w} на ${widget.h}`,
      style: `grid-column:${widget.x} / span ${widget.w};grid-row:${widget.y} / span ${widget.h}`,
    });
    const head = el('header', { class: 'desk-widget-head' },
      el('span', { class: 'desk-widget-title', text: widgetTitle(widget.type) }),
      el('span', { class: 'desk-widget-tools' },
        el('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `Влево: ${widgetTitle(widget.type)}`, title: 'Влево (Alt+←)', onclick: (e) => { e.stopPropagation(); moveBy(widget, -1, 0); } }, U.icon('left')),
        el('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `Вправо: ${widgetTitle(widget.type)}`, title: 'Вправо (Alt+→)', onclick: (e) => { e.stopPropagation(); moveBy(widget, 1, 0); } }, U.icon('right')),
        el('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `Вверх: ${widgetTitle(widget.type)}`, title: 'Вверх (Alt+↑)', onclick: (e) => { e.stopPropagation(); moveBy(widget, 0, -1); } }, U.icon('up')),
        el('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `Вниз: ${widgetTitle(widget.type)}`, title: 'Вниз (Alt+↓)', onclick: (e) => { e.stopPropagation(); moveBy(widget, 0, 1); } }, U.icon('down')),
        el('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `Шире: ${widgetTitle(widget.type)}`, title: 'Шире (Alt+Shift+→)', onclick: (e) => { e.stopPropagation(); resizeBy(widget, 1, 0); } }, U.icon('plus')),
        el('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `Ниже: ${widgetTitle(widget.type)}`, title: 'Ниже (Alt+Shift+↓)', onclick: (e) => { e.stopPropagation(); resizeBy(widget, 0, 1); } }, U.icon('down')),
        el('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `Удалить виджет ${widgetTitle(widget.type)}`, title: 'Удалить виджет', onclick: (e) => { e.stopPropagation(); removeWidget(widget); } }, U.icon('x'))));
    article.append(head, renderBody(widget, datum));
    if (widget.type === 'pet') startPet(article);
    article.addEventListener('keydown', (e) => {
      if (e.altKey) {
        const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const delta = map[e.key];
        if (!delta) return;
        e.preventDefault();
        if (e.shiftKey) resizeBy(widget, delta[0], delta[1]);
        else moveBy(widget, delta[0], delta[1]);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        removeWidget(widget);
      }
    });
    article.addEventListener('dragstart', (e) => {
      DESK.dragId = widget.id;
      article.classList.add('is-dragging');
      try { e.dataTransfer.setData('text/plain', widget.id); } catch { /* без dataTransfer тоже работает */ }
      e.dataTransfer.effectAllowed = 'move';
    });
    article.addEventListener('dragend', () => { DESK.dragId = null; article.classList.remove('is-dragging'); });
    return article;
  }

  function gridCell(event) {
    const grid = W.grid;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const cols = 12;
    const gap = parseFloat(style.columnGap || style.gap || '0') || 0;
    const cellW = (rect.width - gap * (cols - 1)) / cols;
    const rows = parseFloat(style.gridTemplateRows ? style.gridTemplateRows.split(' ').length : 12) || 12;
    const cellH = (rect.height - gap * (rows - 1)) / rows;
    const x = Math.floor((event.clientX - rect.left) / (cellW + gap)) + 1;
    const y = Math.floor((event.clientY - rect.top) / (cellH + gap)) + 1;
    return { x: Math.max(1, Math.min(cols, x)), y: Math.max(1, Math.min(rows, y)) };
  }

  function initGridDnd() {
    if (!W.grid) return;
    W.grid.addEventListener('dragover', (e) => {
      if (!DESK.dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    W.grid.addEventListener('drop', async (e) => {
      if (!DESK.dragId) return;
      e.preventDefault();
      const cell = gridCell(e);
      const id = DESK.dragId;
      DESK.dragId = null;
      if (!cell) return;
      const desk = activeDesk();
      if (!desk) return;
      await apply({ type: 'move', deskId: desk.id, widgetId: id, x: cell.x, y: cell.y });
    });
  }

  async function apply(action) {
    if (!U.has || !DESK.activeId) return;
    try {
      let r;
      if (action.type === 'move') r = await U.call('desksMoveWidget', action.deskId, action.widgetId, action.x, action.y);
      else if (action.type === 'resize') r = await U.call('desksResizeWidget', action.deskId, action.widgetId, action.w, action.h);
      else return;
      if (!r || r.ok === false) {
        DEPS.toast((r && r.error) || 'Не получилось изменить стол', 'error');
        await refresh();
        return;
      }
      await refresh();
    } catch (err) {
      DEPS.toast('Не получилось: ' + (err.message || err), 'error');
    }
  }

  function moveBy(widget, dx, dy) {
    const desk = activeDesk();
    if (!desk) return;
    const x = Math.max(1, Math.min(12, widget.x + dx));
    const y = Math.max(1, Math.min(12, widget.y + dy));
    apply({ type: 'move', deskId: desk.id, widgetId: widget.id, x, y });
  }

  function resizeBy(widget, dw, dh) {
    const desk = activeDesk();
    if (!desk) return;
    const w = Math.max(1, Math.min(12, widget.w + dw));
    const h = Math.max(1, Math.min(6, widget.h + dh));
    apply({ type: 'resize', deskId: desk.id, widgetId: widget.id, w, h });
  }

  async function removeWidget(widget) {
    const desk = activeDesk();
    if (!desk) return;
    const ok = await DEPS.ask('Удалить виджет?', widgetTitle(widget.type) + ' будет убран со стола; данные останутся.', 'Удалить', 'Оставить');
    if (!ok) return;
    try {
      const r = await U.call('desksRemoveWidget', desk.id, widget.id);
      if (!r || r.ok === false) { toastError(r); return; }
      await refresh();
    } catch (err) { toastError({ error: err.message }); }
  }

  function toastError(r) {
    DEPS.toast((r && r.error) || 'Не получилось', 'error');
  }

  async function selectDesk(id) {
    try {
      const r = await U.call('desksSelect', id);
      if (!r || r.ok === false) { toastError(r); return; }
      await refresh();
    } catch (err) { toastError({ error: err.message }); }
  }

  function renderAddRow() {
    if (!W.addRow) return;
    W.addRow.replaceChildren(...DESK.types.map((type) => el('button', {
      type: 'button', class: 'btn btn-secondary btn-sm', 'data-widget-type': type.id,
      text: '+ ' + type.title,
      onclick: () => addWidget(type.id),
    })));
  }

  async function addWidget(type) {
    const desk = activeDesk();
    if (!desk) return;
    try {
      const r = await U.call('desksAddWidget', desk.id, { type });
      if (!r || r.ok === false) { toastError(r); return; }
      await refresh();
    } catch (err) { toastError({ error: err.message }); }
  }

  function openDialog(mode) {
    DESK.dialogMode = mode;
    DESK.editId = mode === 'rename' && activeDesk() ? activeDesk().id : null;
    if (!W.dlg) return;
    if (W.title) W.title.textContent = mode === 'rename' ? 'Переименовать стол' : 'Новый стол';
    if (W.name) W.name.value = mode === 'rename' && activeDesk() ? activeDesk().name : '';
    if (W.template) {
      W.template.disabled = mode === 'rename';
      W.template.parentElement.hidden = mode === 'rename';
    }
    if (W.error) W.error.hidden = true;
    if (W.save) W.save.textContent = mode === 'rename' ? 'Переименовать' : 'Создать';
    if (!W.dlg.open) W.dlg.showModal();
    if (W.name) W.name.focus();
  }

  async function submitDialog() {
    if (!W.name) return;
    const name = W.name.value.trim();
    if (!name) { showDialogError('Укажите название'); return; }
    try {
      let r;
      if (DESK.dialogMode === 'rename') r = await U.call('desksRename', DESK.editId, name);
      else {
        const template = W.template ? W.template.value : 'empty';
        r = await U.call('desksCreate', { name, template });
      }
      if (!r || r.ok === false) { showDialogError((r && r.error) || 'Не получилось'); return; }
      if (W.dlg.open) W.dlg.close();
      await refresh();
    } catch (err) {
      showDialogError(err.message || String(err));
    }
  }

  function showDialogError(text) {
    if (!W.error) return;
    W.error.textContent = text;
    W.error.hidden = false;
  }

  async function removeDesk() {
    const desk = activeDesk();
    if (!desk) return;
    const ok = await DEPS.ask('Удалить стол?', `«${desk.name}» и его раскладка будут удалены. Данные задач и памяти остаются.`, 'Удалить', 'Оставить');
    if (!ok) return;
    try {
      const r = await U.call('desksRemove', desk.id);
      if (!r || r.ok === false) { toastError(r); return; }
      await refresh();
    } catch (err) { toastError({ error: err.message }); }
  }

  async function refresh() {
    if (!W.page || DESK.busy) return;
    if (!U.has || !U.has('desksState')) {
      setNote('Эта версия ядра ещё не хранит столы.');
      return;
    }
    DESK.busy = true;
    DESK.loading = true;
    if (W.grid) W.grid.setAttribute('aria-busy', 'true');
    if (W.refreshBtn) {
      W.refreshBtn.disabled = true;
      W.refreshBtn.textContent = 'Обновляем…';
    }
    if (!DESK.loaded && W.grid) {
      if (W.empty) W.empty.hidden = true;
      W.grid.replaceChildren(el('div', { class: 'desk-loading', role: 'status' },
        el('span', { class: 'desk-loading-dot', 'aria-hidden': 'true' }),
        el('span', { text: 'Загружаем виджеты и календарь…' })));
    }
    try {
      const r = await U.call('desksState');
      if (!r || r.ok === false) {
        DESK.loading = false;
        setNote('Столы не загрузились: ' + ((r && r.error) || 'причина неизвестна'));
        if (!DESK.loaded && W.grid) W.grid.replaceChildren();
        return;
      }
      DESK.loading = false;
      DESK.loaded = true;
      DESK.desks = Array.isArray(r.desks) ? r.desks : [];
      DESK.activeId = r.activeId || null;
      DESK.templates = Array.isArray(r.templates) ? r.templates : [];
      DESK.types = Array.isArray(r.types) ? r.types : [];
      DESK.data = r.data && typeof r.data === 'object' ? r.data : {};
      DESK.now = r.now || Date.now();
      if (W.template) {
        const keep = W.template.value;
        W.template.replaceChildren(...DESK.templates.map((tpl) => el('option', { value: tpl.id, text: tpl.title })));
        if (keep && DESK.templates.some((tpl) => tpl.id === keep)) W.template.value = keep;
      }
      setNote('');
      renderTabs();
      renderGrid();
      renderAddRow();
    } catch (err) {
      DESK.loading = false;
      setNote('Столы не загрузились: ' + (err.message || err));
      if (!DESK.loaded && W.grid) W.grid.replaceChildren();
    } finally {
      DESK.loading = false;
      DESK.busy = false;
      if (W.grid) W.grid.setAttribute('aria-busy', 'false');
      if (W.refreshBtn) {
        W.refreshBtn.disabled = false;
        W.refreshBtn.textContent = 'Обновить';
      }
    }
  }

  function setNote(text) {
    if (!W.note) return;
    W.note.textContent = text || '';
    W.note.hidden = !text;
  }

  function startTimer() {
    stopTimer();
    DESK.timer = setInterval(() => { if (DESK.open) refresh(); }, 60 * 1000);
    if (DESK.timer && typeof DESK.timer.unref === 'function') DESK.timer.unref();
  }

  function stopTimer() {
    if (DESK.timer) clearInterval(DESK.timer);
    DESK.timer = 0;
  }

  function open() {
    if (!W.page) return;
    DESK.open = true;
    W.page.hidden = false;
    const view = W.page.closest('.view-dialog');
    if (view) view.classList.add('desk-open');
    if (W.tabs) {
      // Шаблоны для мастера: список один раз.
      if (W.template) {
        W.template.replaceChildren(...DESK.templates.map((tpl) => el('option', { value: tpl.id, text: tpl.title })));
      }
    }
    refresh().then(() => { startTimer(); if (W.closeBtn) W.closeBtn.focus(); });
  }

  function close() {
    DESK.open = false;
    stopTimer();
    stopPetTimers();
    if (W.page) W.page.hidden = true;
    const view = W.page ? W.page.closest('.view-dialog') : null;
    if (view) view.classList.remove('desk-open');
    if (W.openBtn) W.openBtn.focus();
  }

  function init(deps) {
    if (deps && typeof deps === 'object') { if (typeof deps.toast === 'function') DEPS.toast = deps.toast; if (typeof deps.ask === 'function') DEPS.ask = deps.ask; }
    W.page = $('#deskPage');
    if (!W.page) return;
    W.tabs = $('#deskTabs');
    W.grid = $('#deskGrid');
    W.empty = $('#deskEmpty');
    W.note = $('#deskNote');
    W.addRow = $('#deskAddRow');
    W.openBtn = $('#deskOpen');
    W.closeBtn = $('#deskClose');
    W.addBtn = $('#deskAdd');
    W.renameBtn = $('#deskRename');
    W.deleteBtn = $('#deskDelete');
    W.refreshBtn = $('#deskRefresh');
    W.dlg = $('#deskDialog');
    W.form = $('#deskForm');
    W.name = $('#deskName');
    W.template = $('#deskTemplate');
    W.save = $('#deskSave');
    W.cancel = $('#deskCancel');
    W.error = $('#deskError');
    W.title = $('#deskDialogTitle');
    if (W.openBtn) W.openBtn.addEventListener('click', open);
    if (W.closeBtn) W.closeBtn.addEventListener('click', close);
    if (W.addBtn) W.addBtn.addEventListener('click', () => openDialog('create'));
    if (W.renameBtn) W.renameBtn.addEventListener('click', () => openDialog('rename'));
    if (W.deleteBtn) W.deleteBtn.addEventListener('click', removeDesk);
    if (W.refreshBtn) W.refreshBtn.addEventListener('click', refresh);
    if (W.cancel) W.cancel.addEventListener('click', () => { if (W.dlg && W.dlg.open) W.dlg.close(); });
    if (W.form) W.form.addEventListener('submit', (e) => { e.preventDefault(); submitDialog(); });
    initGridDnd();
    document.addEventListener('keydown', (e) => {
      if (!DESK.open || e.key !== 'Escape') return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      close();
    });
  }

  window.JarvisDesks = { init, open, close, refresh };
})();
