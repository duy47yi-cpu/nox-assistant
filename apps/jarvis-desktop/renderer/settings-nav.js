/* Nox — «Настройки»: навигация по категориям, поиск и фильтры.
 *
 * Шесть категорий (Общие, ИИ и провайдеры, Голос и память, Внешний вид, Сфера Nox,
 * Безопасность) собираются из существующих карточек `.page.settings > .set-section`
 * по атрибуту data-cat. Скрипт только раскладывает и фильтрует уже готовые карточки:
 * контролы не пересоздаются, значения не читаются и не меняются, IPC не вызывается.
 * Данные и сохранение остаются в app.js и профильных модулях. */
(() => {
  'use strict';

  const view = document.querySelector('.view-settings');
  const nav = document.getElementById('setNav');
  const list = document.getElementById('setNavList');
  const search = document.getElementById('setSearch');
  const chipsBox = document.getElementById('setChips');
  const main = document.getElementById('setMain');
  const page = document.getElementById('settingsPage');
  const noMatches = document.getElementById('setNoMatches');
  const navNote = document.getElementById('setNavNote');
  if (!view || !nav || !list || !main || !page) return;

  const CATS = [
    { id: 'general', title: 'Общие', icon: 'sliders' },
    { id: 'ai', title: 'ИИ и провайдеры', icon: 'bolt' },
    { id: 'voice', title: 'Голос и память', icon: 'mic' },
    { id: 'look', title: 'Внешний вид', icon: 'panel' },
    { id: 'sphere', title: 'Сфера Nox', icon: 'orb' },
    { id: 'security', title: 'Безопасность', icon: 'shield' },
  ];
  const ORDER = CATS.map((c) => c.id);
  // Быстрые фильтры из макета: ИИ, Вид (вид + сфера), Голос (голос + память).
  const CHIP_CATS = { all: null, ai: ['ai'], look: ['look', 'sphere'], voice: ['voice'] };

  const state = { q: '', chip: 'all' };
  let items = [];

  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const catOf = (section) => {
    const id = section.dataset.cat;
    return ORDER.includes(id) ? id : 'general';
  };
  const sections = () => [...page.querySelectorAll(':scope > .set-section')];

  // Порядок карточек совпадает с порядком категорий: навигация и подсветка считают
  // разделы подряд, без прыжков по всему экрану.
  function orderSections() {
    const all = sections();
    const ranked = all
      .map((section, index) => ({ section, index, rank: ORDER.indexOf(catOf(section)) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index);
    for (const { section } of ranked) page.append(section);
  }

  // Текст заголовка карточки — для поиска по названию настройки. Строки подписей
  // проверяются отдельно: так поиск «громкость» показывает только строку громкости,
  // а не всю карточку целиком, и не читает личные записи памяти/буфера/папок.
  function headText(section) {
    const parts = [];
    for (const node of section.querySelectorAll(':scope > .set-title, :scope > .set-subtitle, :scope > .set-sub, :scope > .set-hint, :scope > .set-title-row, :scope > .hint')) {
      parts.push(node.textContent || '');
    }
    for (const btn of section.querySelectorAll('.editor-foot button, .set-sphere-foot button')) parts.push(btn.textContent || '');
    return parts.join(' ').toLowerCase();
  }

  const chipCats = () => (state.chip === 'all' ? null : CHIP_CATS[state.chip] || null);
  const catAllowed = (cat) => {
    const allowed = chipCats();
    return !allowed || allowed.includes(cat);
  };

  // Только статические подписи строки: имя, подсказка, подзаголовок. Без списков памяти,
  // напоминаний, буфера, вставок, загрузок, папок и провайдеров — это личные данные.
  function rowMatches(row, q) {
    if (!q) return true;
    const text = [...row.querySelectorAll('.set-name, .set-subtitle, .set-hint')]
      .map((n) => n.textContent || '')
      .join(' ')
      .toLowerCase();
    return text.includes(q);
  }

  // Показывает/прячет карточки и строки классами — атрибут hidden не трогаем:
  // его использует ядро для почты и провайдеров владельца.
  function apply() {
    const q = state.q.trim().toLowerCase();
    let visible = 0;
    for (const section of sections()) {
      const catOk = catAllowed(catOf(section));
      const titleMatch = !q || headText(section).includes(q);
      let sectionVisible = titleMatch;
      if (catOk && q) {
        const rows = [...section.querySelectorAll('.set-row, .ext-card')];
        let any = false;
        for (const row of rows) {
          const on = rowMatches(row, q);
          if (on) any = true;
          row.classList.toggle('set-filtered', !on);
        }
        sectionVisible = titleMatch || any;
        if (titleMatch) for (const row of rows) row.classList.remove('set-filtered');
      } else {
        for (const row of section.querySelectorAll('.set-filtered')) row.classList.remove('set-filtered');
      }
      section.classList.toggle('set-cat-hidden', !(catOk && sectionVisible));
      if (catOk && sectionVisible) visible += 1;
    }
    const showEmpty = visible === 0 && (Boolean(q) || state.chip !== 'all');
    if (noMatches) noMatches.classList.toggle('is-hidden', !showEmpty);
    if (navNote) navNote.hidden = true;
    markActive();
  }

  function firstVisibleSection(cat) {
    return sections().find((s) => catOf(s) === cat && !s.classList.contains('set-cat-hidden'));
  }

  function scrollToCat(cat, focusFirst) {
    if (!catAllowed(cat)) {
      state.chip = 'all';
      paintChips();
    }
    if (state.q) {
      state.q = '';
      if (search) search.value = '';
      apply();
    }
    const section = firstVisibleSection(cat);
    if (!section) return;
    // Координаты считаем относительно области прокрутки: offsetTop у карточки считался бы
    // от body и уводил прокрутку далеко вниз.
    const top = section.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 4;
    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    main.scrollTo({ top: Math.max(0, top), behavior: calm ? 'auto' : 'smooth' });
    setActive(cat);
    if (focusFirst !== false) {
      const target = section.querySelector('button, input, select');
      if (target) target.focus({ preventScroll: true });
    }
  }

  function setActive(cat) {
    for (const item of items) {
      if (item.b.dataset.cat === cat) item.b.setAttribute('aria-current', 'true');
      else item.b.removeAttribute('aria-current');
    }
  }

  // Активная категория — раздел, верх которого ближе всего к верху области прокрутки.
  function markActive() {
    if (!items.length) return;
    const mainRect = main.getBoundingClientRect();
    const anchor = mainRect.top + 32;
    let best = null;
    for (const section of sections()) {
      if (section.classList.contains('set-cat-hidden')) continue;
      if (section.getBoundingClientRect().top - anchor <= 8) best = catOf(section);
    }
    if (!best) {
      const first = sections().find((s) => !s.classList.contains('set-cat-hidden'));
      best = first ? catOf(first) : null;
    }
    if (best) setActive(best);
  }

  function buildNav() {
    orderSections();
    list.replaceChildren();
    items = [];
    for (const cat of CATS) {
      const li = make('li');
      const b = make('button', 'set-nav-item nox-set-item');
      b.type = 'button';
      b.dataset.cat = cat.id;
      b.setAttribute('aria-label', cat.title);
      const icon = make('span', 'nox-set-item-icon');
      icon.dataset.icon = cat.icon;
      icon.setAttribute('aria-hidden', 'true');
      const text = make('span', 'nox-set-item-text', cat.title);
      const chev = make('span', 'nox-set-item-chev');
      chev.dataset.icon = 'chevron';
      chev.setAttribute('aria-hidden', 'true');
      b.append(icon, text, chev);
      b.addEventListener('click', () => scrollToCat(cat.id));
      li.append(b);
      list.append(li);
      items.push({ cat: cat.id, b });
    }
    if (window.JarvisUI && typeof window.JarvisUI.fillIcons === 'function') window.JarvisUI.fillIcons(list);
    markActive();
  }

  function paintChips() {
    if (!chipsBox) return;
    for (const b of chipsBox.querySelectorAll('[data-set-chip]')) {
      b.setAttribute('aria-pressed', String(b.dataset.setChip === state.chip));
    }
  }

  function initControls() {
    if (chipsBox) {
      chipsBox.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('[data-set-chip]') : null;
        if (!b) return;
        const next = b.dataset.setChip;
        if (!Object.prototype.hasOwnProperty.call(CHIP_CATS, next)) return;
        state.chip = next;
        paintChips();
        apply();
        if (next !== 'all') main.scrollTo({ top: 0, behavior: 'auto' });
      });
    }
    if (search) {
      search.addEventListener('input', () => {
        state.q = String(search.value || '');
        apply();
        // При поиске показываем результат с начала списка.
        if (state.q.trim()) main.scrollTo({ top: 0, behavior: 'auto' });
      });
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        search.value = '';
        state.q = '';
        apply();
      });
    }
    main.addEventListener('scroll', markActive, { passive: true });
  }

  // Почта и провайдеры владельца появляются позже: категория «Безопасность»/«ИИ» должна
  // сразу подхватить новую карточку, а фильтр — не потерять её.
  let observer = null;
  function observe() {
    if (typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(() => {
      apply();
    });
    observer.observe(view, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }

  buildNav();
  initControls();
  paintChips();
  observe();
  apply();
  // Активность после первой прокрутки и после подгрузки значений.
  requestAnimationFrame(markActive);

  window.NoxSettingsNav = {
    refresh() { buildNav(); apply(); },
    setCategory(cat) { scrollToCat(cat); },
    getState() { return { ...state }; },
  };
})();


