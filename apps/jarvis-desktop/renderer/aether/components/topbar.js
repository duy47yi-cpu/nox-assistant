/* Чистая шапка Nox Aether: 5 разделов (с адаптацией под узкое окно), история, режим доступа и управление окном.
 * Намеренно без прототипных пунктов «Разговор / Поровну / Присутствие / Демо-данные» и цифр 1–7. */
(() => {
  'use strict';

  const NAV_ITEMS = [
    { id: 'chat', label: 'Чат', icon: 'chat', primary: true },
    { id: 'commands', label: 'Готовые команды', icon: 'commands', primary: false },
    { id: 'mcp', label: 'MCP-подключения', icon: 'mcp', primary: false },
    { id: 'personal', label: 'Личное пространство', icon: 'personal', primary: false },
    { id: 'settings', label: 'Настройки', icon: 'settings', primary: true },
  ];

  const MODE_INFO = [
    { id: 'ask', label: 'Спрашиваю', desc: 'Подтверждать заметные или рискованные шаги' },
    { id: 'auto', label: 'Умный режим', desc: 'Внутри папки свободно, важные шаги спрашивает' },
    { id: 'full', label: 'Полный доступ', desc: 'Выполняет поручение сразу по вашей просьбе' },
  ];

  function createTopbar({ store, bridge }) {
    const { icon } = window.NoxAetherIcons;

    const header = document.createElement('header');
    header.className = 'ae-topbar';
    header.id = 'aeTopbar';

    // ── Левая зона: кнопка истории + сдержанное имя продукта ────
    const left = document.createElement('div');
    left.className = 'ae-top-left';

    const histBtn = document.createElement('button');
    histBtn.type = 'button';
    histBtn.id = 'aeHistoryToggle';
    histBtn.className = 'ae-icon-btn';
    histBtn.title = 'История чатов (Ctrl+B)';
    histBtn.setAttribute('aria-label', 'История чатов');
    histBtn.append(icon('panelLeft'));
    histBtn.addEventListener('click', () => {
      if (store.state.route !== 'chat') store.setRoute('chat');
      store.toggleHistory();
    });

    const brandBtn = document.createElement('button');
    brandBtn.type = 'button';
    brandBtn.className = 'ae-brand-mark';
    brandBtn.title = 'Вернуться в чат';
    brandBtn.textContent = 'Nox';
    brandBtn.addEventListener('click', () => store.setRoute('chat'));

    left.append(histBtn, brandBtn);

    // ── Центр: 5 разделов + выпадающее меню «Разделы» для узких окон ──
    const nav = document.createElement('nav');
    nav.className = 'ae-nav';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Основные разделы');

    const tabBtns = new Map();
    for (const item of NAV_ITEMS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = item.primary ? 'ae-nav-btn ae-nav-primary' : 'ae-nav-btn ae-nav-secondary';
      btn.id = `aeNav_${item.id}`;
      btn.dataset.route = item.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      btn.append(icon(item.icon, 'ae-nav-ico'));
      const txt = document.createElement('span');
      txt.textContent = item.label;
      btn.append(txt);
      btn.addEventListener('click', () => store.setRoute(item.id));
      nav.append(btn);
      tabBtns.set(item.id, btn);
    }

    // Меню «Разделы» появляется только при узком окне (<= 980px через CSS) вместо скрытия или наезда текста
    const overflowWrap = document.createElement('div');
    overflowWrap.className = 'ae-nav-overflow';

    const overflowBtn = document.createElement('button');
    overflowBtn.type = 'button';
    overflowBtn.className = 'ae-nav-btn ae-overflow-trigger';
    overflowBtn.setAttribute('aria-haspopup', 'menu');
    overflowBtn.setAttribute('aria-expanded', 'false');
    const overflowLabel = document.createElement('span');
    overflowLabel.textContent = 'Разделы';
    overflowBtn.append(icon('more', 'ae-nav-ico'), overflowLabel, icon('chevronDown', 'ae-chev-sm'));

    const overflowMenu = document.createElement('div');
    overflowMenu.className = 'ae-menu-pop ae-overflow-menu';
    overflowMenu.setAttribute('role', 'menu');
    overflowMenu.hidden = true;

    const overflowItems = new Map();
    for (const item of NAV_ITEMS.filter((i) => !i.primary)) {
      const mi = document.createElement('button');
      mi.type = 'button';
      mi.className = 'ae-menu-item';
      mi.setAttribute('role', 'menuitem');
      mi.dataset.route = item.id;
      mi.append(icon(item.icon, 'ae-nav-ico'));
      const sp = document.createElement('span');
      sp.textContent = item.label;
      mi.append(sp);
      mi.addEventListener('click', () => {
        closeMenus();
        store.setRoute(item.id);
      });
      overflowMenu.append(mi);
      overflowItems.set(item.id, mi);
    }

    overflowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = overflowMenu.hidden;
      closeMenus();
      if (open) {
        overflowMenu.hidden = false;
        overflowBtn.setAttribute('aria-expanded', 'true');
        const activeOrFirst = overflowMenu.querySelector('[aria-current="true"], button');
        if (activeOrFirst) activeOrFirst.focus();
      }
    });

    overflowWrap.append(overflowBtn, overflowMenu);
    nav.append(overflowWrap);

    // Стрелки клавиатуры между видимыми вкладками
    nav.addEventListener('keydown', (e) => {
      const visible = [...nav.querySelectorAll('.ae-nav-btn')].filter((b) => {
        const s = window.getComputedStyle(b);
        return s.display !== 'none' && !b.hidden;
      });
      const idx = visible.indexOf(document.activeElement);
      if (idx < 0) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        visible[(idx + 1) % visible.length].focus();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        visible[(idx - 1 + visible.length) % visible.length].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        visible[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        visible[visible.length - 1].focus();
      }
    });

    overflowMenu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenus();
        overflowBtn.focus();
      }
    });

    // ── Правая зона: важный алерт (если вне чата), режим доступа, кнопки окна ──
    const right = document.createElement('div');
    right.className = 'ae-top-right';

    const attentionBtn = document.createElement('button');
    attentionBtn.type = 'button';
    attentionBtn.className = 'ae-attention-pill';
    attentionBtn.hidden = true;
    attentionBtn.addEventListener('click', () => store.setRoute('chat'));

    const modeWrap = document.createElement('div');
    modeWrap.className = 'ae-mode-wrap';

    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.className = 'ae-mode-pill';
    modeBtn.id = 'aeModePill';
    modeBtn.setAttribute('aria-haspopup', 'menu');
    modeBtn.setAttribute('aria-expanded', 'false');
    const modeLabel = document.createElement('span');
    modeBtn.append(icon('shield', 'ae-mode-ico'), modeLabel, icon('chevronDown', 'ae-chev-sm'));

    const modeMenu = document.createElement('div');
    modeMenu.className = 'ae-menu-pop ae-mode-menu';
    modeMenu.setAttribute('role', 'menu');
    modeMenu.hidden = true;

    const modeBtns = new Map();
    for (const m of MODE_INFO) {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'ae-menu-item ae-menu-item-col';
      opt.setAttribute('role', 'menuitemradio');
      const titleRow = document.createElement('span');
      titleRow.className = 'ae-menu-title';
      titleRow.textContent = m.label;
      const descRow = document.createElement('span');
      descRow.className = 'ae-menu-desc';
      descRow.textContent = m.desc;
      opt.append(titleRow, descRow);
      opt.addEventListener('click', () => {
        closeMenus();
        store.setMode(m.id);
      });
      modeMenu.append(opt);
      modeBtns.set(m.id, opt);
    }

    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = modeMenu.hidden;
      closeMenus();
      if (open) {
        modeMenu.hidden = false;
        modeBtn.setAttribute('aria-expanded', 'true');
        const cur = modeMenu.querySelector('[aria-checked="true"], button');
        if (cur) cur.focus();
      }
    });

    modeMenu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenus();
        modeBtn.focus();
      }
    });

    modeWrap.append(modeBtn, modeMenu);

    // Кнопки управления безрамочным окном Windows
    const winControls = document.createElement('div');
    winControls.className = 'ae-win-controls';
    const winSpecs = [
      { act: 'minimize', ic: 'minus', title: 'Свернуть' },
      { act: 'maximize', ic: 'square', title: 'Развернуть' },
      { act: 'close', ic: 'x', title: 'Закрыть', danger: true },
    ];
    for (const ws of winSpecs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = ws.danger ? 'ae-win-btn is-close' : 'ae-win-btn';
      b.title = ws.title;
      b.setAttribute('aria-label', ws.title);
      b.append(icon(ws.ic));
      b.addEventListener('click', () => bridge.call('windowControl', ws.act).catch(() => {}));
      winControls.append(b);
    }

    right.append(attentionBtn, modeWrap, winControls);
    header.append(left, nav, right);

    function closeMenus() {
      overflowMenu.hidden = true;
      overflowBtn.setAttribute('aria-expanded', 'false');
      modeMenu.hidden = true;
      modeBtn.setAttribute('aria-expanded', 'false');
    }

    document.addEventListener('click', (e) => {
      if (!overflowWrap.contains(e.target) && !modeWrap.contains(e.target)) closeMenus();
    });

    function render(st) {
      histBtn.setAttribute('aria-expanded', String(Boolean(st.historyOpen && st.route === 'chat')));
      histBtn.dataset.active = st.historyOpen && st.route === 'chat' ? 'true' : 'false';

      for (const item of NAV_ITEMS) {
        const btn = tabBtns.get(item.id);
        const active = st.route === item.id;
        btn.setAttribute('aria-selected', String(active));
        btn.classList.toggle('is-active', active);
        btn.tabIndex = active ? 0 : -1;
      }

      const activeSec = NAV_ITEMS.find((i) => !i.primary && i.id === st.route);
      overflowLabel.textContent = activeSec ? activeSec.label : 'Разделы';
      overflowBtn.classList.toggle('is-active', Boolean(activeSec));
      for (const [id, mi] of overflowItems.entries()) {
        const active = st.route === id;
        mi.classList.toggle('is-active', active);
        if (active) mi.setAttribute('aria-current', 'true');
        else mi.removeAttribute('aria-current');
      }

      const mode = st.mode || 'ask';
      const curMode = MODE_INFO.find((m) => m.id === mode) || MODE_INFO[0];
      modeLabel.textContent = curMode.label;
      modeBtn.dataset.mode = mode;
      modeBtn.title = `Режим доступа: ${curMode.label} — ${curMode.desc}`;
      for (const [id, opt] of modeBtns.entries()) {
        const checked = id === mode;
        opt.setAttribute('aria-checked', String(checked));
        opt.classList.toggle('is-active', checked);
      }

      // Сдержанный индикатор внимания показывается только если ждут подтверждения вне вкладки «Чат»
      const urgentCount = (st.approvals.queue ? st.approvals.queue.length : 0);
      if (urgentCount > 0 && st.route !== 'chat') {
        attentionBtn.hidden = false;
        attentionBtn.textContent = `Ждёт решения: ${urgentCount}`;
      } else {
        attentionBtn.hidden = true;
      }
    }

    return { el: header, render, closeMenus };
  }

  window.NoxAetherTopbar = { createTopbar, NAV_ITEMS, MODE_INFO };
})();
