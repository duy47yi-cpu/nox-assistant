/* Nox — общая оболочка разделов: кнопки окна в шапке, точка у «Настроек»,
 * сворачивание истории чата и выезжающая история в узком окне.
 * Переходы между разделами по-прежнему делает show() в app.js по [data-nav]; здесь их нет. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const NARROW = window.matchMedia ? window.matchMedia('(max-width: 1000px)') : { matches: false, addEventListener() {} };
  const KEY = 'noxHistCollapsed';

  // ── Кнопки окна ────────────────────────────────────────────────
  function initWindowButtons() {
    for (const btn of document.querySelectorAll('#noxTopbar [data-act]')) {
      btn.addEventListener('click', () => {
        const api = window.jarvis;
        if (api && typeof api.windowControl === 'function') api.windowControl(btn.dataset.act).catch(() => {});
      });
    }
  }

  // ── Точка «нужна настройка»: app.js ведёт #settingsDot в рейке, шапка повторяет её ──
  function initDot() {
    const src = $('#settingsDot');
    const dot = $('#noxTopDot');
    if (!src || !dot) return;
    const sync = () => { dot.hidden = src.hidden; };
    sync();
    new MutationObserver(sync).observe(src, { attributes: true, attributeFilter: ['hidden'] });
  }

  // ── История чата ───────────────────────────────────────────────
  const H = { collapsed: false, drawer: false };
  function readPref() {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  }
  function writePref(on) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* приватный профиль */ }
  }

  function applyHistory() {
    const grid = $('#noxGrid');
    const open = $('#noxHistOpen');
    const toggle = $('#noxHistToggle');
    if (!grid || !open || !toggle) return;
    const narrow = NARROW.matches;
    if (!narrow) H.drawer = false;
    const off = narrow ? !H.drawer : H.collapsed;
    grid.classList.toggle('hist-off', off);
    grid.classList.toggle('hist-drawer', narrow && H.drawer);
    open.hidden = !off;
    open.setAttribute('aria-expanded', String(!off));
    const label = narrow ? 'Закрыть историю' : 'Свернуть историю';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  }

  function openHistory() {
    if (NARROW.matches) H.drawer = true;
    else { H.collapsed = false; writePref(false); }
    applyHistory();
    const first = document.querySelector('#noxHistSections .nox-hist-open') || $('#noxHistToggle');
    if (first) first.focus();
  }

  function closeHistory({ focus = true } = {}) {
    if (NARROW.matches) H.drawer = false;
    else { H.collapsed = true; writePref(true); }
    applyHistory();
    const open = $('#noxHistOpen');
    if (focus && open && !open.hidden) open.focus();
  }

  function initHistory() {
    H.collapsed = readPref();
    $('#noxHistOpen')?.addEventListener('click', openHistory);
    $('#noxHistToggle')?.addEventListener('click', () => closeHistory());
    // Выбор чата в выезжающей истории закрывает её.
    $('#noxHistSections')?.addEventListener('click', (e) => {
      if (H.drawer && e.target.closest('.nox-hist-open')) closeHistory({ focus: false });
    });
    // Щелчок мимо выезжающей истории закрывает её.
    document.addEventListener('pointerdown', (e) => {
      if (!H.drawer) return;
      if (e.target.closest('#noxHistory, #noxHistOpen')) return;
      H.drawer = false;
      applyHistory();
    });
    // Esc закрывает выезжающую историю и не доходит до «стопа» хода.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !H.drawer) return;
      e.stopPropagation();
      e.preventDefault();
      closeHistory();
    }, true);
    NARROW.addEventListener('change', applyHistory);
    document.addEventListener('jarvis:view', () => { if (H.drawer) { H.drawer = false; applyHistory(); } });
    applyHistory();
  }

  function init() {
    initWindowButtons();
    initDot();
    initHistory();
  }

  window.NoxShell = { openHistory, closeHistory };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
