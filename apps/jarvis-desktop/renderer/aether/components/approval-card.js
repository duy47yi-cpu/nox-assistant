/* Карточка подтверждения опасных/заметных шагов (R3-01 инварианты безопасности):
 * - кнопки разрешения блокируются на 700 мс + до получения shownToken от ядра;
 * - кнопка «Отклонить» работает всегда и мгновенно;
 * - если предыдущий запрос закрылся, включается затвор (gate) вместо подмены под курсором;
 * - показывается обратный отсчёт автоотмены и читаемое превью параметров/diff без технических токенов. */
(() => {
  'use strict';

  function createApprovalCard({ store, getReturnFocus }) {
    const ui = window.JarvisUI || {};
    const { icon } = window.NoxAetherIcons;
    const scrub = typeof ui.scrub === 'function' ? ui.scrub : (s) => String(s || '');
    const toolTitle = typeof ui.toolTitle === 'function' ? ui.toolTitle : (t) => String(t || 'Действие');

    const root = document.createElement('section');
    root.className = 'ae-approval-dock';
    root.id = 'aeApprovalDock';
    root.hidden = true;

    let timerId = 0;
    let announcedSeq = 0;
    // Решение принято: после закрытия запроса фокус возвращается в поле ввода.
    let returnFocusToComposer = false;

    // Скрытая строка объявления: экранный диктор слышит запрос один раз, а не весь диалог.
    // .ae-day-sr-only — уже существующий в aether.css визуально-скрытый класс;
    // свой CSS по условию задачи не трогаем, а CSP окна запрещает inline-стили.
    function makeAnnouncer(text) {
      const el = document.createElement('div');
      el.className = 'ae-approval-announcer ae-day-sr-only';
      el.setAttribute('role', 'alert');
      el.setAttribute('aria-live', 'assertive');
      el.setAttribute('aria-atomic', 'true');
      el.textContent = text;
      return el;
    }

    function focusComposer() {
      const target = getReturnFocus?.() || document.getElementById('chatInput');
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }

    function focusSnapshot() {
      const el = document.activeElement;
      if (!el || !root.contains(el)) return '';
      return el.getAttribute('data-decision') || 'card';
    }

    function restoreFocus(snapshot, card) {
      if (!snapshot) return;
      const wanted = snapshot === 'card' ? card : root.querySelector(`[data-decision="${snapshot}"]`);
      const fallback = root.querySelector('[data-decision="reject"]');
      const target = wanted && !wanted.disabled ? wanted : (fallback && !fallback.disabled ? fallback : null);
      if (target) target.focus({ preventScroll: true });
    }

    // Забирать фокус можно, когда он нигде (body/лента), но не из поля ввода и не из модалки.
    function shouldTakeFocus() {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return true;
      return Boolean(el.closest && el.closest('#feed'));
    }

    // Esc на карточке отклоняет запрос (безопасное действие) и не запускает глобальный стоп.
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      const view = store.state.approvals.view;
      if (!view) {
        focusComposer();
        return;
      }
      if (store.state.approvals.sending.has(view.id)) return;
      returnFocusToComposer = true;
      store.respondApproval('reject', view.seq).catch(() => {});
    });

    function stopTimer() {
      if (timerId) {
        clearInterval(timerId);
        timerId = 0;
      }
    }

    function formatPreview(item) {
      const lines = [];
      if (item.path) lines.push(`Путь: ${scrub(item.path)}`);
      if (item.command) lines.push(`Команда: ${scrub(item.command)}`);
      if (item.diff || item.patch) {
        lines.push(scrub(String(item.diff || item.patch)).slice(0, 700));
      } else if (item.args && typeof ui.argsPretty === 'function') {
        const pretty = ui.argsPretty(item.args);
        if (pretty) lines.push(scrub(pretty).slice(0, 500));
      }
      return lines.join('\n').trim();
    }

    function renderCountdownEl(el, item) {
      if (!item || !item.autoCancelAt) {
        el.hidden = true;
        return;
      }
      const leftMs = Math.max(0, Number(item.autoCancelAt) - Date.now());
      const sec = Math.ceil(leftMs / 1000);
      el.hidden = false;
      el.textContent = sec > 0 ? `Автоотмена через ${sec} с` : 'Время ожидания истекло';
    }

    let lastRenderKey = '';

    function render(st) {
      stopTimer();
      const ap = st.approvals;
      const hasQueue = ap.queue && ap.queue.length > 0;
      if (!hasQueue && !ap.gate) {
        const hadFocus = root.contains(document.activeElement);
        const wasOpen = Boolean(lastRenderKey);
        root.hidden = true;
        root.replaceChildren();
        lastRenderKey = '';
        // Запрос закрыли решением или автоотменой: фокус не остаётся на body.
        if (hadFocus || returnFocusToComposer || (wasOpen && document.activeElement === document.body)) focusComposer();
        returnFocusToComposer = false;
        return;
      }

      root.hidden = false;

      // Состояние затвора (предыдущий запрос закрылся, пока пользователь решал)
      if (ap.gate && hasQueue) {
        const gateKey = `gate:${ap.queue.length}:${ap.queue[0].id}`;
        if (lastRenderKey === gateKey) return;
        lastRenderKey = gateKey;

        const focusBefore = focusSnapshot();
        const card = document.createElement('div');
        card.className = 'ae-approval-card is-gate';
        card.setAttribute('role', 'region');
        card.setAttribute('aria-label', 'Очередь запросов на подтверждение');
        const head = document.createElement('div');
        head.className = 'ae-approval-head';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'ae-approval-title-wrap';
        titleWrap.append(icon('shield', 'ae-approval-ico'));
        const h = document.createElement('strong');
        h.textContent = 'Предыдущий запрос уже закрыт';
        titleWrap.append(h);
        head.append(titleWrap);

        const body = document.createElement('p');
        body.className = 'ae-approval-summary';
        body.textContent = `В очереди ещё ожидает решений: ${ap.queue.length}. Открыть следующий запрос отдельно, чтобы не нажать случайно?`;

        const btns = document.createElement('div');
        btns.className = 'ae-approval-actions';
        const showNextBtn = document.createElement('button');
        showNextBtn.type = 'button';
        showNextBtn.className = 'ae-btn ae-btn-primary';
        showNextBtn.textContent = 'Показать следующий запрос';
        showNextBtn.addEventListener('click', () => store.showApprovalById(ap.queue[0].id));
        btns.append(showNextBtn);

        card.append(head, body, btns);
        root.replaceChildren(card);
        restoreFocus(focusBefore, card);
        return;
      }

      const view = ap.view;
      const item = view ? ap.queue.find((q) => q.id === view.id) : ap.queue[0];
      if (!item || !view) {
        root.hidden = true;
        root.replaceChildren();
        lastRenderKey = '';
        return;
      }

      const sending = ap.sending && ap.sending.has(item.id);
      const allowEnabled = Boolean(view.armed) && !sending;
      const highRisk = Boolean(item.highRisk || item.risk === 'high' || item.danger === 'high');
      const allowSession = item.allowSession !== false && !highRisk;

      const renderKey = `${view.seq}:${item.id}:${allowEnabled ? 1 : 0}:${sending ? 1 : 0}:${ap.queue.length}`;
      if (lastRenderKey === renderKey) {
        const cdExisting = root.querySelector('.ae-approval-countdown');
        if (cdExisting && item.autoCancelAt) {
          renderCountdownEl(cdExisting, item);
          timerId = setInterval(() => renderCountdownEl(cdExisting, item), 1000);
        }
        return;
      }
      lastRenderKey = renderKey;

      const focusBefore = focusSnapshot();
      const isNewRequest = Boolean(view.seq && view.seq !== announcedSeq);
      const card = document.createElement('div');
      card.className = highRisk ? 'ae-approval-card is-high-risk' : 'ae-approval-card';
      card.setAttribute('role', 'region');
      card.setAttribute('aria-labelledby', `aeApprovalTitle-${view.seq}`);
      card.setAttribute('aria-describedby', `aeApprovalSummary-${view.seq}`);
      card.tabIndex = -1;
      if (sending) card.setAttribute('aria-busy', 'true');

      const head = document.createElement('div');
      head.className = 'ae-approval-head';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'ae-approval-title-wrap';
      titleWrap.append(icon(highRisk ? 'alert' : 'shield', 'ae-approval-ico'));
      const titleEl = document.createElement('strong');
      titleEl.className = 'ae-approval-title';
      titleEl.id = `aeApprovalTitle-${view.seq}`;
      titleEl.textContent = scrub(item.actionTitle || toolTitle(item.tool || item.name) || 'Требуется подтверждение');
      titleWrap.append(titleEl);

      const meta = document.createElement('div');
      meta.className = 'ae-approval-meta';

      const riskTag = document.createElement('span');
      riskTag.className = highRisk ? 'ae-badge is-danger' : 'ae-badge is-warn';
      riskTag.textContent = highRisk ? 'Повышенный риск' : 'Нужно разрешение';
      meta.append(riskTag);

      if (ap.queue.length > 1) {
        const qTag = document.createElement('span');
        qTag.className = 'ae-badge';
        qTag.textContent = `1 из ${ap.queue.length}`;
        meta.append(qTag);
      }

      const countdown = document.createElement('span');
      countdown.className = 'ae-approval-countdown';
      countdown.setAttribute('aria-hidden', 'true');
      renderCountdownEl(countdown, item);
      meta.append(countdown);

      head.append(titleWrap, meta);

      const summary = document.createElement('p');
      summary.className = 'ae-approval-summary';
      summary.id = `aeApprovalSummary-${view.seq}`;
      summary.textContent = scrub(item.summary || item.reason || 'Ассистент запрашивает разрешение на выполнение этого шага.');

      card.append(head, summary);

      const previewTxt = formatPreview(item);
      if (previewTxt) {
        const pre = document.createElement('pre');
        pre.className = 'ae-approval-preview';
        pre.textContent = previewTxt;
        card.append(pre);
      }

      const actions = document.createElement('div');
      actions.className = 'ae-approval-actions';

      const rejectBtn = document.createElement('button');
      rejectBtn.type = 'button';
      rejectBtn.className = 'ae-btn ae-btn-ghost';
      rejectBtn.dataset.decision = 'reject';
      rejectBtn.disabled = Boolean(sending);
      rejectBtn.textContent = 'Отклонить';
      rejectBtn.title = 'Отклонить запрос (Esc)';
      rejectBtn.setAttribute('aria-keyshortcuts', 'Escape');
      rejectBtn.addEventListener('click', () => {
        returnFocusToComposer = true;
        store.respondApproval('reject', view.seq);
      });

      const onceBtn = document.createElement('button');
      onceBtn.type = 'button';
      onceBtn.className = highRisk ? 'ae-btn ae-btn-danger' : 'ae-btn ae-btn-primary';
      onceBtn.dataset.decision = 'once';
      onceBtn.disabled = !allowEnabled;
      onceBtn.textContent = view.armed ? 'Разрешить один раз' : 'Разрешить…';
      onceBtn.addEventListener('click', () => {
        returnFocusToComposer = true;
        store.respondApproval('once', view.seq);
      });

      actions.append(rejectBtn);

      if (allowSession) {
        const sessBtn = document.createElement('button');
        sessBtn.type = 'button';
        sessBtn.className = 'ae-btn ae-btn-secondary';
        sessBtn.dataset.decision = 'session';
        sessBtn.disabled = !allowEnabled;
        sessBtn.textContent = 'На этот чат';
        sessBtn.addEventListener('click', () => {
          returnFocusToComposer = true;
          store.respondApproval('session', view.seq);
        });
        actions.append(sessBtn);
      }

      actions.append(onceBtn);

      // Живая область живёт всё время запроса: при новой заявке она говорит текст,
      // при перерисовке (взвод кнопок) остаётся пустой и не повторяет объявление.
      if (isNewRequest) announcedSeq = view.seq;
      card.append(makeAnnouncer(isNewRequest
        ? `Требуется подтверждение: ${titleEl.textContent}. ${summary.textContent}`
        : ''));
      card.append(actions);
      root.replaceChildren(card);

      if (focusBefore) restoreFocus(focusBefore, card);
      else if (isNewRequest && shouldTakeFocus()) card.focus({ preventScroll: true });

      if (item.autoCancelAt) {
        timerId = setInterval(() => renderCountdownEl(countdown, item), 1000);
      }
    }

    return { el: root, render };
  }

  window.NoxAetherApprovalCard = { createApprovalCard };
})();
