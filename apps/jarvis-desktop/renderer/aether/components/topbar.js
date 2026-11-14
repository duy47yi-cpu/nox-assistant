/* Верхняя навигация, быстрые настройки и управление окном. */
(() => {
  'use strict';

  const NAV_ITEMS = [
    { id: 'chat', label: 'Чат', icon: 'chat' },
    { id: 'commands', label: 'Готовые команды', caption: 'Команды', icon: 'commands' },
    { id: 'mcp', label: 'MCP-подключения', caption: 'Подключения', icon: 'mcp' },
    { id: 'personal', label: 'Личное пространство', caption: 'Пространство', icon: 'personal' },
    { id: 'settings', label: 'Настройки', icon: 'settings' },
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

    const brandBtn = document.createElement('button');
    brandBtn.type = 'button';
    brandBtn.className = 'ae-brand-mark';
    brandBtn.title = 'Вернуться в чат';
    brandBtn.textContent = 'Nox';
    brandBtn.addEventListener('click', () => store.setRoute('chat'));

    // ── Разделы окна ──
    const nav = document.createElement('nav');
    nav.className = 'ae-nav';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Основные разделы');

    const tabBtns = new Map();
    for (const item of NAV_ITEMS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ae-nav-btn';
      btn.id = `aeNav_${item.id}`;
      btn.dataset.route = item.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      btn.setAttribute('aria-label', item.label);
      btn.title = item.label;
      btn.append(icon(item.icon, 'ae-nav-ico'));
      const txt = document.createElement('span');
      txt.textContent = item.caption || item.label;
      btn.append(txt);
      btn.addEventListener('click', () => store.setRoute(item.id));
      nav.append(btn);
      tabBtns.set(item.id, btn);
    }

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

    const quickWrap = document.createElement('div');
    quickWrap.className = 'ae-mode-wrap';
    const quickBtn = document.createElement('button');
    quickBtn.type = 'button';
    quickBtn.className = 'ae-icon-btn';
    quickBtn.title = 'Быстрые настройки';
    quickBtn.setAttribute('aria-label', quickBtn.title);
    quickBtn.setAttribute('aria-haspopup', 'dialog');
    quickBtn.setAttribute('aria-expanded', 'false');
    quickBtn.append(icon('sliders'));
    const quick = document.createElement('div');
    quick.id = 'aeQuickSettings';
    quickBtn.setAttribute('aria-controls', quick.id);
    quick.className = 'ae-menu-pop ae-quick-settings';
    quick.setAttribute('role', 'dialog');
    quick.setAttribute('aria-label', quickBtn.title);
    quick.hidden = true;
    function quickField(label, input) {
      const row = document.createElement('label');
      row.className = 'ae-quick-field';
      row.append(label, input);
      quick.append(row);
      return input;
    }
    function toggle(label, onChange) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => onChange(input.checked));
      return quickField(label, input);
    }
    const quiet = toggle('Тихий режим', (v) => store.setSetting('quiet', v));
    const named = toggle('Слушать имя «Джарвис»', (v) => store.setSetting('alwaysListen', v));
    const pinned = toggle('Поверх других окон', (v) => store.setSetting('alwaysOnTop', v));
    const volume = document.createElement('input');
    volume.type = 'range';
    volume.min = '0';
    volume.max = '100';
    volume.addEventListener('change', () => store.setSetting('voiceVolume', Number(volume.value) / 100));
    quickField('Громкость голоса', volume);
    const theme = window.JarvisTheme;
    function lookSelect(label, key, options) {
      const select = document.createElement('select');
      select.className = 'ae-select';
      for (const [id, [text]] of Object.entries(options)) select.add(new Option(text, id));
      select.addEventListener('change', () => theme.setLook({ [key]: select.value }));
      quickField(label, select);
      return select;
    }
    const blur = lookSelect('Размытие панелей', 'blur', theme.BLURS);
    const alpha = lookSelect('Прозрачность окна', 'winAlpha', theme.WIN_ALPHAS);
    quickWrap.append(quickBtn, quick);
    quickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = quick.hidden;
      closeMenus();
      if (!open) return;
      const look = theme.getLook();
      blur.value = look.blur;
      alpha.value = look.winAlpha;
      quick.hidden = false;
      quickBtn.setAttribute('aria-expanded', 'true');
      quiet.focus();
    });
    quick.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeMenus();
      quickBtn.focus();
    });

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

    right.append(attentionBtn, modeWrap, quickWrap, winControls);
    header.append(brandBtn, nav, right);

    function closeMenus() {
      quick.hidden = true;
      quickBtn.setAttribute('aria-expanded', 'false');
      modeMenu.hidden = true;
      modeBtn.setAttribute('aria-expanded', 'false');
    }

    document.addEventListener('click', (e) => {
      if (!quickWrap.contains(e.target) && !modeWrap.contains(e.target)) closeMenus();
    });

    function render(st) {
      for (const item of NAV_ITEMS) {
        const btn = tabBtns.get(item.id);
        const active = st.route === item.id;
        btn.setAttribute('aria-selected', String(active));
        btn.classList.toggle('is-active', active);
        btn.tabIndex = 0;
      }

      quiet.checked = Boolean(st.settings.quiet);
      named.checked = Boolean(st.settings.alwaysListen);
      pinned.checked = Boolean(st.settings.alwaysOnTop);
      if (document.activeElement !== volume) volume.value = String(Math.round((st.settings.voiceVolume ?? 1) * 100));

      const mode = st.mode || 'ask';
      const curMode = MODE_INFO.find((m) => m.id === mode) || MODE_INFO[0];
      modeLabel.textContent = curMode.label;
      modeBtn.dataset.mode = mode;
      modeBtn.title = `Режим доступа: ${curMode.label} — ${curMode.desc}`;
      modeBtn.setAttribute('aria-label', modeBtn.title);
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
