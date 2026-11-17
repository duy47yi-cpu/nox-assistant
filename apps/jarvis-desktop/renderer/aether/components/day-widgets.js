(() => {
  'use strict';

  const { icon } = window.NoxAetherIcons;
  const { fingerprint } = window.NoxAetherTime;
  const { clockView, musicView } = window.NoxDayWidgetsModel;
  const LOW_WINDOW_HINT = 'Разверните окно по высоте, чтобы увидеть музыку.';

  function element(tag, className) {
    const node = document.createElement(tag);
    node.className = `ae-day-${className}`;
    return node;
  }

  function action(name, label, glyph) {
    const button = element('button', `action ae-day-${name}`);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(glyph));
    return button;
  }

  function write(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function createDayWidgets({ bridge, choose, reportError }) {
    const el = element('section', 'widgets');
    el.setAttribute('aria-label', 'Часы и музыка');
    el.hidden = true;
    const header = element('div', 'header');
    const clock = element('time', 'time');
    clock.setAttribute('aria-live', 'off');
    const date = element('div', 'date');
    const state = element('span', 'state');
    header.append(clock, date, state);

    const reminder = element('div', 'reminder');
    const music = element('div', 'music');
    music.setAttribute('role', 'group');
    music.setAttribute('aria-label', 'Последняя музыка');
    const cover = element('span', 'cover');
    cover.setAttribute('aria-hidden', 'true');
    cover.append(icon('music'));
    const copy = element('div', 'copy');
    const title = element('div', 'title');
    const detail = element('div', 'detail');
    copy.append(title, detail);
    const status = element('span', 'sr-only');
    status.setAttribute('role', 'status');
    const open = action('open', 'Открыть снова', 'refresh');
    const pick = action('pick', 'Подобрать музыку', 'music');
    const retry = action('retry', 'Повторить чтение истории', 'refresh');
    music.append(cover, copy, open, pick, retry, status);
    el.append(header, reminder, music);

    const narrow = matchMedia('(max-width: 679px)');
    const compact = matchMedia('(max-width: 960px), (max-height: 580px)');
    const low = matchMedia('(max-height: 479px)');
    let context = {};
    let snapshot = { music: { state: 'loading' } };
    let supported = true;
    let clockTimer = null;
    let pollTimer = null;
    let timeout = null;
    let revision = 0;
    let opening = false;

    function render() {
      const now = Date.now();
      const view = clockView(snapshot.clock, now);
      const row = musicView(snapshot.music, now);
      const isCompact = el.classList.contains('is-compact');
      const minute = view.time;
      write(clock, minute);
      clock.dateTime = minute;
      write(date, isCompact ? view.shortDate : view.date);
      date.title = view.date;
      header.title = [
        low.matches && LOW_WINDOW_HINT,
        snapshot.clock?.state === 'timezone_fallback' && 'Часовой пояс в настройках не распознан. Показано системное время.',
        isCompact && view.reminder?.text,
      ].filter(Boolean).join('\n');
      reminder.hidden = !view.reminder;
      if (view.reminder) {
        write(reminder, view.reminder.text);
        reminder.title = view.reminder.text;
        reminder.classList.toggle('is-overdue', view.reminder.overdue);
      }
      el.dataset.music = row.state;
      music.hidden = low.matches || row.state === 'hidden';
      cover.hidden = !row.last;
      if (row.last) cover.style.setProperty('--ae-cover-angle', `${fingerprint(row.last.query) % 360}deg`);
      write(state, row.status || '');
      state.hidden = music.hidden || !row.status;
      write(title, row.title || '');
      title.title = row.title || '';
      write(detail, (isCompact ? row.shortDetail : row.detail) ?? row.detail ?? '');
      detail.title = row.detail || '';
      write(status, !music.hidden && row.state === 'error' ? `${row.title}. ${row.detail}` : '');
      open.hidden = !row.last?.service || !bridge.has('widgetsOpenMusic');
      if (!open.hidden) {
        open.setAttribute('aria-label', `Открыть снова: ${row.last.query}`);
        open.title = open.getAttribute('aria-label');
      }
      pick.hidden = !row.last && row.state !== 'empty';
      const retryFocused = document.activeElement === retry;
      retry.hidden = row.state !== 'error';
      if (retryFocused && retry.hidden) {
        if (!open.hidden) open.focus();
        else if (!pick.hidden) pick.focus();
      }
    }

    function cancelRequest() {
      revision += 1;
      clearTimeout(timeout);
      timeout = null;
    }

    function refresh() {
      if (!pollTimer || timeout) return;
      const current = ++revision;
      const fail = () => {
        if (revision !== current) return;
        cancelRequest();
        snapshot = { ...snapshot, music: { state: 'error' } };
        render();
      };
      timeout = setTimeout(fail, 800);
      bridge.call('widgetsData', { view: 'day' }).then((data) => {
        if (revision !== current) return;
        if (!data) return fail();
        cancelRequest();
        if (data.version !== 2) {
          supported = false;
          sync();
          return;
        }
        snapshot = data;
        render();
      }, fail);
    }

    function sync() {
      const active = supported && context.active && !narrow.matches && bridge.has('widgetsData');
      el.hidden = !active;
      if (active) {
        if (el.parentNode !== context.host) {
          if (context.docked) context.host.prepend(el);
          else context.host.append(el);
        }
        el.classList.toggle('is-docked', context.docked);
        el.classList.toggle('is-compact', context.docked || compact.matches);
        render();
      }
      if (active && !document.hidden) {
        clockTimer ??= setInterval(render, 10000);
        if (!low.matches && !pollTimer) {
          pollTimer = setInterval(refresh, 60000);
          refresh();
        }
      } else {
        clearInterval(clockTimer);
        clockTimer = null;
      }
      if (!active || document.hidden || low.matches) {
        clearInterval(pollTimer);
        pollTimer = null;
        cancelRequest();
      }
    }

    open.addEventListener('click', async () => {
      const last = snapshot.music.last;
      if (opening || !last?.service) return;
      opening = true;
      open.setAttribute('aria-busy', 'true');
      try {
        const result = await bridge.call('widgetsOpenMusic', last);
        if (!result?.ok) {
          reportError(result?.error || 'Не удалось открыть музыку.');
          refresh();
        }
      } catch {
        reportError('Не удалось открыть музыку.');
      } finally {
        opening = false;
        open.removeAttribute('aria-busy');
      }
    });
    pick.addEventListener('click', () => choose('включи музыку'));
    retry.addEventListener('click', refresh);
    for (const media of [narrow, compact, low]) media.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', () => {
      clearInterval(clockTimer);
      clearInterval(pollTimer);
      clockTimer = pollTimer = null;
      cancelRequest();
    });
    window.addEventListener('pageshow', sync);
    return {
      place(next) {
        const workspaceChanged = next.workspace !== context.workspace;
        const changed = workspaceChanged || next.active !== context.active || next.host !== context.host;
        context = next;
        if (workspaceChanged) {
          snapshot = { ...snapshot, clock: null };
          cancelRequest();
        }
        if (changed || (el.hidden && next.active && bridge.has('widgetsData'))) sync();
        if (workspaceChanged) refresh();
      },
    };
  }

  window.NoxAetherDayWidgets = { createDayWidgets };
})();
