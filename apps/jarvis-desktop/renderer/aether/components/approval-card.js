/* Карточка подтверждения опасных/заметных шагов (R3-01 инварианты безопасности):
 * - кнопки разрешения блокируются на 700 мс + до получения shownToken от ядра;
 * - кнопка «Отклонить» работает всегда и мгновенно;
 * - если предыдущий запрос закрылся, включается затвор (gate) вместо подмены под курсором;
 * - показывается обратный отсчёт автоотмены и читаемое превью параметров/diff без технических токенов. */
(() => {
  'use strict';

  function createApprovalCard({ store }) {
    const ui = window.JarvisUI || {};
    const { icon } = window.NoxAetherIcons;
    const scrub = typeof ui.scrub === 'function' ? ui.scrub : (s) => String(s || '');
    const toolTitle = typeof ui.toolTitle === 'function' ? ui.toolTitle : (t) => String(t || 'Действие');

    const root = document.createElement('section');
    root.className = 'ae-approval-dock';
    root.id = 'aeApprovalDock';
    root.setAttribute('aria-live', 'assertive');
    root.hidden = true;

    let timerId = 0;

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
        root.hidden = true;
        root.replaceChildren();
        lastRenderKey = '';
        return;
      }

      root.hidden = false;

      // Состояние затвора (предыдущий запрос закрылся, пока пользователь решал)
      if (ap.gate && hasQueue) {
        const gateKey = `gate:${ap.queue.length}:${ap.queue[0].id}`;
        if (lastRenderKey === gateKey) return;
        lastRenderKey = gateKey;

        const card = document.createElement('div');
        card.className = 'ae-approval-card is-gate';
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

      const card = document.createElement('div');
      card.className = highRisk ? 'ae-approval-card is-high-risk' : 'ae-approval-card';
      card.setAttribute('role', 'region');
      card.setAttribute('aria-label', 'Запрос подтверждения действия');

      const head = document.createElement('div');
      head.className = 'ae-approval-head';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'ae-approval-title-wrap';
      titleWrap.append(icon(highRisk ? 'alert' : 'shield', 'ae-approval-ico'));
      const titleEl = document.createElement('strong');
      titleEl.className = 'ae-approval-title';
      titleEl.textContent = scrub(item.actionTitle || toolTitle(item.tool) || 'Требуется подтверждение');
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
      renderCountdownEl(countdown, item);
      meta.append(countdown);

      head.append(titleWrap, meta);

      const summary = document.createElement('p');
      summary.className = 'ae-approval-summary';
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
      rejectBtn.addEventListener('click', () => store.respondApproval('reject', view.seq));

      const onceBtn = document.createElement('button');
      onceBtn.type = 'button';
      onceBtn.className = highRisk ? 'ae-btn ae-btn-danger' : 'ae-btn ae-btn-primary';
      onceBtn.dataset.decision = 'once';
      onceBtn.disabled = !allowEnabled;
      onceBtn.textContent = view.armed ? 'Разрешить один раз' : 'Разрешить…';
      onceBtn.addEventListener('click', () => store.respondApproval('once', view.seq));

      actions.append(rejectBtn);

      if (allowSession) {
        const sessBtn = document.createElement('button');
        sessBtn.type = 'button';
        sessBtn.className = 'ae-btn ae-btn-secondary';
        sessBtn.dataset.decision = 'session';
        sessBtn.disabled = !allowEnabled;
        sessBtn.textContent = 'На этот чат';
        sessBtn.addEventListener('click', () => store.respondApproval('session', view.seq));
        actions.append(sessBtn);
      }

      actions.append(onceBtn);
      card.append(actions);
      root.replaceChildren(card);

      if (item.autoCancelAt) {
        timerId = setInterval(() => renderCountdownEl(countdown, item), 1000);
      }
    }

    return { el: root, render };
  }

  window.NoxAetherApprovalCard = { createApprovalCard };
})();
