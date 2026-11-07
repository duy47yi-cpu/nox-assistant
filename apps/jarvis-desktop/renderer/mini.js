/* Джарвис — мини-режим: сфера, короткий статус и последнее действие.
 * Требует от ядра (необязательно): showMain() — развернуть главное окно.
 * Без него в браузере переходим на index.html. */
(() => {
  'use strict';

  const U = window.JarvisUI;
  const $ = (id) => document.getElementById(id);
  let orb = null;
  const approvals = []; // ожидающие решения запросы

  const tracker = new U.StatusTracker(render, () => { if (orb) orb.pulse(1); });

  function render() {
    if (orb) orb.setState(tracker.state);
    const st = $('miniStatus');
    st.textContent = tracker.phrase;
    st.dataset.state = tracker.state;
    const last = tracker.last;
    let line = '';
    if (tracker.state === 'error' && tracker.errorText) line = tracker.errorText;
    else if (last && last.tool) {
      line = U.toolTitle(last.tool);
      const brief = U.argsBrief(last.args, 32);
      if (brief) line += ' · ' + brief;
      if (last.status && last.status !== 'running' && U.STATUS_TEXT[last.status]) line += ' — ' + U.STATUS_TEXT[last.status].toLowerCase();
    }
    $('miniLastText').textContent = line;
    $('miniLast').title = line;
    $('miniLast').hidden = !line;
    $('miniStop').hidden = !tracker.busy || !U.has('stop');
    $('miniApproval').hidden = approvals.length === 0;
  }

  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'approval_request' && ev.id) approvals.push(ev.id);
    if (ev.type === 'tool_result' || ev.type === 'done' || ev.type === 'approval_closed') {
      const i = approvals.indexOf(ev.id);
      if (i >= 0) approvals.splice(i, 1);
      if (ev.type === 'done') approvals.length = 0;
    }
    tracker.handle(ev);
  }

  async function answer(decision) {
    const id = approvals[0];
    if (!id) return;
    if (decision === 'reject') tracker.markRejected(id);
    approvals.shift();
    try { await U.call('respondApproval', id, decision); } catch { /* уже неактуально */ }
    render();
  }

  async function boot() {
    U.fillIcons(document);
    await U.ensureBridge();
    if (typeof window.JarvisOrb === 'function') {
      orb = new window.JarvisOrb($('miniOrb'), { density: 0.85 });
      let anim = true;
      try { anim = JSON.parse(localStorage.getItem('jarvis.orbAnim') ?? 'true') !== false; } catch { /* нет хранилища */ }
      orb.setAnimated(anim);
    }
    $('miniExpand').addEventListener('click', async () => {
      if (U.has('showMain')) {
        try { await U.call('showMain'); return; } catch { /* ниже запасной путь */ }
      }
      location.href = 'index.html' + location.search;
    });
    $('miniStop').addEventListener('click', () => U.call('stop').catch(() => {}));
    for (const b of document.querySelectorAll('[data-decision]')) b.addEventListener('click', () => answer(b.dataset.decision));
    if (U.has('onEvent')) window.jarvis.onEvent(onEvent);

    // Последнее действие из журнала, чтобы строка не пустовала после запуска.
    try {
      const recs = await U.call('recentJournal', 1);
      const r = Array.isArray(recs) && recs[0];
      if (r && !tracker.last) tracker.last = { tool: r.tool, args: r.args, status: U.statusOfRecord(r), summary: U.cleanSummary(r.summary), ts: U.toMs(r.ts) };
    } catch { /* журнал недоступен */ }
    render();
  }

  boot().catch((e) => console.error('[jarvis-mini] запуск не удался', e));
})();
