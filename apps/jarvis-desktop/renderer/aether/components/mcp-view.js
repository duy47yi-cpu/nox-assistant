/* Раздел «Дополнения» (маршрут mcp):
 * - Вкладки «Плагины», «Команды» и «Озвучка» + переключатель «Только установленные» и счётчик;
 * - Плагины: короткий список внешних сервисов (вход в аккаунт) и каталог из 80 MCP-серверов
 *   с категориями, поиском, сортировкой и подключением через существующий мост mcpAdd;
 * - Команды: паки и установка; Озвучка: настройка облачного голоса;
 * - Значки сервисов: настоящие Simple Icons (CC0 1.0) из сгенерированного mcp-logos.js,
 *   для остальных — наши монограммы. Знаки сервисов — товарные знаки их владельцев и
 *   используются только как обозначения в каталоге.
 * - Сохраняет реальное подключение MCP-серверов, подтверждение изменений (mcpApprove) и
 *   настройку голоса. Никаких новых каналов ядра не добавляет. */
(() => {
  'use strict';

  const PACK_UI_META = {
    browser: { title: 'Браузер', desc: 'Вкладки, история, обновления страниц и переключение окон.', category: 'browsers', popular: true, icon: 'globe', tint: '#2559E8' },
    windows: { title: 'Окна', desc: 'Сворачивание, развёртывание и распределение окон по экрану.', category: 'default', popular: true, icon: 'layers', tint: '#3D59D7' },
    media: { title: 'Музыка и звук', desc: 'Пауза, переключение треков и быстрая регулировка громкости.', category: 'media', popular: true, icon: 'music', tint: '#5070DD' },
    montage: { title: 'Монтаж', desc: 'Разрезание клипов, отмена, воспроизведение и рендер на таймлайне.', category: 'design', popular: true, icon: 'play', tint: '#346CDB' },
    games: { title: 'Игры', desc: 'Оверлей, скриншоты и игровые функции без отвлечения от процесса.', category: 'games', popular: true, icon: 'gamepad', tint: '#3B66E8' },
    photoshop: { title: 'Photoshop', desc: 'Слои, масштабирование, трансформация, экспорт и отмена в Photoshop.', category: 'design', popular: true, icon: 'palette', tint: '#4B6FEA' },
    minecraft: { title: 'Minecraft', desc: 'Чат, координаты, инвентарь, быстрый бег и пауза в Minecraft.', category: 'games', popular: true, icon: 'gamepad', tint: '#2E7CF6' },
    explorer: { title: 'Проводник', desc: 'Новая папка, переименование, поиск файлов и обновление.', category: 'default', popular: true, icon: 'folder', tint: '#2D5EE0' },
    text: { title: 'Текст', desc: 'Копирование, вставка, выделение, поиск и сохранение в документах.', category: 'default', popular: false, icon: 'pencil', tint: '#2559E8' },
    sites: { title: 'Сайты', desc: 'Быстрое открытие почты, музыки, видео и любимых веб-сервисов.', category: 'browsers', popular: false, icon: 'globe', tint: '#3D59D7' },
    apps: { title: 'Программы', desc: 'Быстрый запуск редакторов, терминала и рабочих утилит.', category: 'dev', popular: true, icon: 'terminal', tint: '#235AE9' },
  };

  const COMMAND_ADDONS = Object.entries(PACK_UI_META).map(([packId, meta]) => ({
    id: 'pack-' + packId,
    packId: packId,
    title: meta.title,
    desc: meta.desc,
    category: meta.category,
    popular: meta.popular,
    icon: meta.icon,
    tint: meta.tint,
    installed: false,
    installedCount: 0,
    totalCount: 0,
  }));

  // Категории паков команд: у каждой вкладки свои подписи.
  const PACK_CATEGORIES = [
    { id: 'popular', label: 'Популярное' },
    { id: 'social', label: 'Соцсети и общение' },
    { id: 'browsers', label: 'Браузеры' },
    { id: 'design', label: 'Дизайн и творчество' },
    { id: 'media', label: 'Видео, музыка и стриминг' },
    { id: 'dev', label: 'Работа и разработка' },
    { id: 'games', label: 'Игровые сервисы' },
    { id: 'default', label: 'Команды по умолчанию' },
  ];

  const TRANSPORT_LABELS = { stdio: 'на компьютере', http: 'через интернет' };
  const SORT_LABELS_PLUGINS = { category: 'По категориям', alpha: 'По алфавиту', verified: 'Сначала проверенные' };
  const SORT_LABELS_COMMANDS = { popular: 'Сортировка', alpha: 'По алфавиту', installed: 'Установленные' };

  // ── Значки и снимок каталога для окна ───────────────────────────
  // mcp-logos.js генерируется scripts/fetch-mcp-logos.js и подключается скриптом из этого
  // компонента: окно не читает node-модули, а прямой тег в index.html чужой файл не меняет.
  // Сеть нужна только генератору; здесь данные уже внутри файла.
  let LOGOS = (typeof window !== 'undefined' && window.NoxMcpLogos) || null;
  let logosRequested = false;
  const logoWaiters = [];

  function loadLogos() {
    if (LOGOS || logosRequested || typeof document === 'undefined') return;
    logosRequested = true;
    const script = document.createElement('script');
    script.src = 'mcp-logos.js';
    script.async = true;
    script.onload = () => {
      LOGOS = (typeof window !== 'undefined' && window.NoxMcpLogos) || null;
      const waiters = logoWaiters.splice(0, logoWaiters.length);
      for (const callback of waiters) {
        try { callback(); } catch (err) { /* чужой сбой не должен ломать раздел */ }
      }
    };
    script.onerror = () => { logosRequested = false; };
    (document.head || document.documentElement).append(script);
  }

  function withLogos(callback) {
    if (LOGOS) { callback(); return; }
    logoWaiters.push(callback);
    loadLogos();
  }

  // В снимке mcp-logos.js адреса хранятся без схемы: в рантайме файл не ходит в сеть,
  // а https:// добавляется только при явном действии владельца (добавить / инструкция).
  function withHttps(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return 'https://' + raw.replace(/^\/+/, '');
  }

  // Только имена переменных окружения, без значений: значения в каталоге не живут.
  function envKeyNames(envKeys) {
    return (Array.isArray(envKeys) ? envKeys : [])
      .filter((key) => typeof key === 'string' && key.trim() !== '')
      .join(', ');
  }

  function needsKey(service) {
    return Boolean(service && Array.isArray(service.envKeys) && service.envKeys.length > 0);
  }

  function verificationMark(verified) {
    return verified === true ? '' : 'не проверено';
  }

  function hexToRgba(hex, alpha) {
    const value = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(value)) return 'rgba(37, 89, 232, ' + alpha + ')';
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function createMcpView({ store, bridge }) {
    const { icon } = window.NoxAetherIcons;

    const root = document.createElement('section');
    root.id = 'aeMcpView';
    root.className = 'ae-page lx-addons-page';
    root.hidden = true;
    root.setAttribute('aria-label', 'Дополнения');

    let activeTab = 'plugins'; // 'plugins' | 'commands' | 'voices'
    let onlyInstalled = false;
    let pluginQuery = '';
    let commandQuery = '';
    let pluginCategory = 'all';
    let commandCategory = 'popular';
    let pluginSort = 'category';
    let commandSort = 'popular';
    let pluginCollapsed = false;
    let commandCollapsed = false;
    let mcpServers = [];
    let featuredCatalog = [];
    let serverPacks = [];
    let mail = null;
    let showMcpForm = false;
    let voiceSubTab = 'list'; // 'list' | 'synth';

    // ── Верхняя панель вкладок и счётчика ────────────────────────
    const topBar = document.createElement('div');
    topBar.className = 'lx-addons-topbar';

    const tabsWrap = document.createElement('div');
    tabsWrap.className = 'lx-pill-tabs';
    tabsWrap.setAttribute('role', 'tablist');
    tabsWrap.setAttribute('aria-label', 'Разделы дополнений');

    const tabBtns = {};
    for (const [id, text] of [
      ['plugins', 'Плагины'],
      ['commands', 'Команды'],
      ['voices', 'Озвучка'],
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'lxAddonsTab_' + id;
      btn.className = 'lx-pill-tab';
      btn.setAttribute('role', 'tab');
      btn.textContent = text;
      btn.addEventListener('click', () => setTab(id));
      tabBtns[id] = btn;
      tabsWrap.append(btn);
    }

    const topRight = document.createElement('div');
    topRight.className = 'lx-addons-top-right';

    const instToggleLabel = document.createElement('label');
    instToggleLabel.className = 'lx-inline-check';
    instToggleLabel.htmlFor = 'lxOnlyInstalledChk';
    const instChk = document.createElement('input');
    instChk.type = 'checkbox';
    instChk.id = 'lxOnlyInstalledChk';
    instChk.className = 'lx-checkbox-input';
    instChk.addEventListener('change', () => {
      onlyInstalled = instChk.checked;
      renderBody();
    });
    const instTxt = document.createElement('span');
    instTxt.textContent = 'Только установленные';
    instToggleLabel.append(instChk, instTxt);

    const installedCount = document.createElement('span');
    installedCount.id = 'lxInstalledCount';
    installedCount.className = 'lx-installed-count';

    topRight.append(installedCount, instToggleLabel);
    topBar.append(tabsWrap, topRight);

    const contentHost = document.createElement('div');
    contentHost.className = 'lx-addons-content';

    root.append(topBar, contentHost);

    function setTab(nextTab) {
      if (!['plugins', 'commands', 'voices'].includes(nextTab)) return;
      activeTab = nextTab;
      renderBody();
    }

    function syncTabsHeader(installedN, totalN) {
      for (const [id, btn] of Object.entries(tabBtns)) {
        const active = id === activeTab;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
      }
      instToggleLabel.hidden = activeTab === 'voices';
      installedCount.hidden = activeTab === 'voices';
      installedCount.textContent = 'Установлено: ' + installedN + '/' + totalN;
    }

    // ── Общие элементы ───────────────────────────────────────────
    function brandIcon(id) {
      if (!LOGOS) return null;
      return LOGOS.brand(id);
    }

    function iconBox(id, title, size) {
      const box = document.createElement('span');
      box.setAttribute('aria-hidden', 'true');
      box.style.width = size + 'px';
      box.style.height = size + 'px';
      box.style.flex = '0 0 ' + size + 'px';
      box.style.borderRadius = Math.max(8, Math.round(size * 0.22)) + 'px';
      box.style.display = 'grid';
      box.style.placeItems = 'center';
      box.style.position = 'relative';
      box.style.color = 'var(--lx-text, var(--text))';
      const brand = brandIcon(id);
      if (brand && brand.path) {
        box.style.background = 'rgba(37, 89, 232, 0.20)';
        box.style.boxShadow = 'inset 0 0 0 1px rgba(80, 112, 221, 0.30)';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(Math.round(size * 0.58)));
        svg.setAttribute('height', String(Math.round(size * 0.58)));
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', brand.path);
        svg.append(path);
        box.append(svg);
        return box;
      }
      const mono = LOGOS && LOGOS.monogram(id);
      if (mono) {
        box.style.background = hexToRgba(mono.color, 0.22);
        box.style.boxShadow = 'inset 0 0 0 1px ' + hexToRgba(mono.color, 0.44);
        const letter = document.createElement('span');
        letter.textContent = mono.letter || '?';
        letter.style.fontWeight = '700';
        letter.style.fontSize = Math.round(size * 0.46) + 'px';
        letter.style.lineHeight = '1';
        box.append(letter);
        const glyph = icon(mono.glyph || 'mcp');
        glyph.style.position = 'absolute';
        glyph.style.right = Math.round(size * 0.08) + 'px';
        glyph.style.bottom = Math.round(size * 0.08) + 'px';
        glyph.style.width = Math.round(size * 0.32) + 'px';
        glyph.style.height = Math.round(size * 0.32) + 'px';
        glyph.style.opacity = '0.72';
        box.append(glyph);
        return box;
      }
      box.style.background = 'rgba(37, 89, 232, 0.20)';
      box.append(icon('mcp', ''));
      return box;
    }

    function badge(text, tone) {
      const span = document.createElement('span');
      span.className = tone ? 'ae-badge is-' + tone : 'ae-badge';
      span.textContent = text;
      return span;
    }

    function sectionHeading(text) {
      const h = document.createElement('h2');
      h.className = 'ae-section-heading';
      h.textContent = text;
      return h;
    }

    function emptyBox(text) {
      const box = document.createElement('div');
      box.className = 'lx-empty-box';
      box.textContent = text;
      return box;
    }

    function installPackItem(item) {
      if (!bridge.has('installPack')) {
        store.toast('Установка паков недоступна в этой сборке', 'error');
        return;
      }
      const found = serverPacks.find((pack) => pack && pack.id === item.packId);
      const ready = found ? Number(found.installed) || 0 : item.installedCount || 0;
      const total = found ? Number(found.total) || 0 : item.totalCount || 0;
      if (total > 0 && ready >= total) {
        store.toast('Пак «' + item.title + '» уже установлен', 'ok');
        return;
      }
      Promise.resolve(bridge.call('installPack', item.packId))
        .then(async (result) => {
          if (result && result.ok === false) throw new Error(result.error || 'Не удалось установить пак');
          await refreshPacks();
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('nox:commands-updated'));
          }
          store.toast(result && result.added
            ? 'Пак «' + item.title + '» установлен (+' + result.added + ')'
            : 'Пак «' + item.title + '» уже установлен', 'ok');
        })
        .catch((err) => store.toast(bridge.errText(err), 'error'));
    }

    async function connectService(name, target, argsText) {
      if (!bridge.has('mcpAdd')) {
        store.toast('Подключение сервисов недоступно в этой сборке', 'error');
        return;
      }
      try {
        const result = await bridge.call('mcpAdd', name, target, argsText || '');
        if (result && result.ok === false) throw new Error(result.error || 'Не удалось подключить сервис');
        if (result && result.error) {
          store.toast('Сервис сохранён, но не подключился: ' + bridge.errText(result.error), 'error');
        } else {
          store.toast('Сервис «' + name + '» добавлен', 'ok');
        }
        await load();
      } catch (err) {
        store.toast(bridge.errText(err), 'error');
      }
    }

    // Кнопка «Инструкция»: видимая стрелка скрыта от диктора, имя говорит, куда ведёт.
    function buildGuideButton(service, visibleLabel = 'Инструкция ↗', fallbackText = 'Инструкция для этого сервиса недоступна') {
      const guide = document.createElement('button');
      guide.type = 'button';
      guide.className = 'ae-btn ae-btn-ghost ae-btn-sm';
      const hasDocs = Boolean(service && service.docs);
      const title = service && service.title ? service.title : 'сервиса';
      guide.setAttribute('aria-label', hasDocs
        ? 'Инструкция по подключению: ' + title
        : fallbackText + ': ' + title);
      const [wordText, ...arrowParts] = String(visibleLabel || 'Инструкция').split(' ');
      const word = document.createElement('span');
      word.textContent = wordText || 'Инструкция';
      const arrow = document.createElement('span');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = arrowParts.length ? ' ' + arrowParts.join(' ') : '';
      guide.append(word, arrow);
      guide.title = hasDocs ? 'Открыть инструкцию' : fallbackText;
      guide.addEventListener('click', () => {
        if (hasDocs) openDocs(service);
        else store.toast(fallbackText, 'error');
      });
      return guide;
    }

    function openDocs(entry) {
      if (!entry || !entry.docs) {
        store.toast('Инструкция для этого сервиса недоступна', 'error');
        return;
      }
      if (!bridge.has('openSource')) {
        store.toast('Открытие ссылок недоступно в этой сборке', 'error');
        return;
      }
      Promise.resolve(bridge.call('openSource', withHttps(entry.docs)))
        .then((result) => { if (!result || result.ok === false) throw new Error('Не удалось открыть инструкцию'); })
        .catch((err) => store.toast(bridge.errText(err), 'error'));
    }

    // ── «Плагины»: внешние сервисы и каталог MCP ──────────────────
    function featuredStatus(item) {
      if (item.integration === 'mail') {
        if (mail && mail.connected) return { text: 'подключена', installed: true, action: 'mail' };
        return { text: 'вход в почту', installed: false, action: 'mail' };
      }
      if (mcpServers.some((server) => server.name === item.id)) return { text: 'добавлен', installed: true, action: 'installed' };
      if (item.ready) return { text: 'можно добавить', installed: false, action: 'add' };
      return { text: 'нужна настройка', installed: false, action: 'docs' };
    }

    function activateFeatured(item) {
      const status = featuredStatus(item);
      if (status.action === 'mail') {
        if (mail && mail.connected) {
          store.toast('Почта уже подключена', 'ok');
          return;
        }
        if (!bridge.has('mailConnect')) {
          store.toast('Вход в почту не настроен в этой сборке', 'error');
          return;
        }
        store.toast('Открываю вход в почту в браузере', 'ok');
        Promise.resolve(bridge.call('mailConnect', false))
          .then((result) => {
            if (result && result.ok === false) throw new Error(result.error || 'Не удалось войти в почту');
            store.toast('Почта подключена', 'ok');
            return load();
          })
          .catch((err) => store.toast(bridge.errText(err), 'error'));
        return;
      }
      if (status.action === 'installed') {
        store.toast('Сервис уже добавлен: управляйте им в списке «Мои подключения»', 'ok');
        return;
      }
      if (status.action === 'docs') {
        openDocs(item);
        return;
      }
      if (item.integration === 'mail') return;
      const target = item.url || item.command || '';
      if (!target) {
        store.toast('У сервиса не указан адрес подключения', 'error');
        return;
      }
      const argsText = Array.isArray(item.args) ? item.args.join(' ') : '';
      connectService(item.id, target, argsText);
    }

    function renderPlugins() {
      const services = LOGOS && Array.isArray(LOGOS.services) ? LOGOS.services.slice() : [];
      const categories = LOGOS && Array.isArray(LOGOS.categories) ? LOGOS.categories : [];
      const installedNames = new Set(mcpServers.map((server) => server.name));
      const totals = { installed: mcpServers.length, total: services.length };
      syncTabsHeader(totals.installed, totals.total || (featuredCatalog.length + services.length));

      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '12px';

      // Строка поиска и кнопка своего сервера
      const searchRow = document.createElement('div');
      searchRow.className = 'lx-search-row';

      const searchBox = document.createElement('div');
      searchBox.className = 'lx-search-box';
      const searchIco = icon('search', 'lx-search-ico');
      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'lx-search-input';
      searchInput.value = pluginQuery;
      searchInput.placeholder = 'Поиск дополнений…';
      searchInput.setAttribute('aria-label', 'Поиск дополнений');
      searchBox.append(searchIco, searchInput);

      const sortBtn = document.createElement('button');
      sortBtn.type = 'button';
      sortBtn.className = 'lx-pill-btn lx-pill-secondary lx-sort-btn';
      sortBtn.append(icon('sort'), document.createTextNode(SORT_LABELS_PLUGINS[pluginSort]));

      const addMcpBtn = document.createElement('button');
      addMcpBtn.type = 'button';
      addMcpBtn.className = 'lx-pill-btn lx-pill-primary';
      addMcpBtn.textContent = showMcpForm ? 'Скрыть форму' : '+ Свой MCP';

      searchRow.append(searchBox, sortBtn, addMcpBtn);
      wrap.append(searchRow);

      if (showMcpForm) wrap.append(buildMcpForm());

      // Внешние сервисы: короткие карточки с входом в аккаунт, data-service для проверок окна.
      if (featuredCatalog.length) {
        const featuredSection = document.createElement('section');
        featuredSection.style.display = 'flex';
        featuredSection.style.flexDirection = 'column';
        featuredSection.style.gap = '8px';
        const featuredHead = document.createElement('div');
        featuredHead.style.display = 'flex';
        featuredHead.style.alignItems = 'baseline';
        featuredHead.style.justifyContent = 'space-between';
        featuredHead.append(sectionHeading('Внешние сервисы'));
        const note = document.createElement('span');
        note.style.fontSize = '12px';
        note.style.color = 'var(--lx-text-3, var(--text-3))';
        note.textContent = 'вход в аккаунт';
        featuredHead.append(note);
        featuredSection.append(featuredHead);

        const chips = document.createElement('div');
        chips.style.display = 'flex';
        chips.style.flexWrap = 'wrap';
        chips.style.gap = '8px';
        for (const item of featuredCatalog) {
          if (onlyInstalled && !featuredStatus(item).installed) continue;
          const status = featuredStatus(item);
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'ae-subtab';
          chip.dataset.service = item.id;
          chip.title = (item.description || item.title || '') + ' — ' + status.text;
          chip.style.display = 'inline-flex';
          chip.style.alignItems = 'center';
          chip.style.gap = '8px';
          chip.append(iconBox(item.id, item.title, 22));
          const name = document.createElement('span');
          name.textContent = item.title || item.id;
          chip.append(name);
          const state = document.createElement('span');
          state.style.fontSize = '11.5px';
          state.style.color = 'var(--lx-text-3, var(--text-3))';
          state.textContent = status.text;
          chip.append(state);
          chip.addEventListener('click', () => activateFeatured(item));
          chips.append(chip);
        }
        if (chips.childElementCount) featuredSection.append(chips);
        wrap.append(featuredSection);
      }

      // Мои подключения: живые серверы из настроек, состояние честное.
      if (mcpServers.length) {
        const mine = document.createElement('section');
        mine.style.display = 'flex';
        mine.style.flexDirection = 'column';
        mine.style.gap = '8px';
        mine.append(sectionHeading('Мои подключения'));
        for (const server of mcpServers) {
          const row = document.createElement('div');
          row.className = 'lx-addon-card';
          row.style.minHeight = '0';
          row.style.padding = '12px 14px';
          row.style.gap = '12px';
          row.append(iconBox(server.name, server.name, 38));
          const info = document.createElement('div');
          info.className = 'lx-addon-info';
          const titleRow = document.createElement('div');
          titleRow.className = 'lx-addon-title-row';
          const title = document.createElement('span');
          title.className = 'lx-addon-title';
          title.textContent = server.name;
          titleRow.append(title);
          const catalogEntry = LOGOS && LOGOS.service(server.name);
          const statusText = serverStatus(server);
          titleRow.append(badge(statusText.label, statusText.tone));
          if (catalogEntry && catalogEntry.verified === false) titleRow.append(badge('не проверено', 'warn'));
          if (server.drift) titleRow.append(badge('набор действий изменился', 'warn'));
          const meta = document.createElement('p');
          meta.className = 'lx-addon-desc';
          meta.textContent = describeServer(server, catalogEntry);
          info.append(titleRow, meta);
          row.append(info);

          const actions = document.createElement('div');
          actions.className = 'lx-addon-act';
          actions.style.display = 'flex';
          actions.style.gap = '6px';
          if (server.drift && bridge.has('mcpApprove')) {
            const approve = document.createElement('button');
            approve.type = 'button';
            approve.className = 'lx-pill-btn lx-pill-primary';
            approve.textContent = 'Подтвердить';
            approve.addEventListener('click', () => {
              Promise.resolve(bridge.call('mcpApprove', server.name))
                .then(() => load())
                .catch((err) => store.toast(bridge.errText(err), 'error'));
            });
            actions.append(approve);
          }
          if (bridge.has('mcpToggle')) {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'lx-pill-btn lx-pill-secondary';
            toggle.textContent = server.disabled ? 'Включить' : 'Выключить';
            toggle.addEventListener('click', () => {
              Promise.resolve(bridge.call('mcpToggle', server.name, !server.disabled))
                .then(() => load())
                .catch((err) => store.toast(bridge.errText(err), 'error'));
            });
            actions.append(toggle);
          }
          if (bridge.has('mcpRemove')) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'lx-pill-btn lx-pill-secondary';
            remove.textContent = 'Убрать';
            remove.addEventListener('click', () => {
              Promise.resolve(bridge.call('mcpRemove', server.name))
                .then(() => load())
                .catch((err) => store.toast(bridge.errText(err), 'error'));
            });
            actions.append(remove);
          }
          row.append(actions);
          mine.append(row);
        }
        wrap.append(mine);
      }

      // Каталог: сетка карточек, справа категории
      const layout = document.createElement('div');
      layout.className = 'lx-addons-grid';
      const mainCol = document.createElement('div');
      mainCol.className = 'lx-addons-main';

      const groupHead = document.createElement('button');
      groupHead.type = 'button';
      groupHead.className = pluginCollapsed ? 'lx-group-head is-collapsed' : 'lx-group-head';
      groupHead.setAttribute('aria-expanded', String(!pluginCollapsed));
      groupHead.setAttribute('aria-controls', 'mcpAddonCards');
      const groupTitle = document.createElement('span');
      const groupChevron = document.createElement('span');
      groupChevron.className = 'lx-group-chevron';
      groupChevron.append(icon('chevronDown'));
      groupHead.append(groupTitle, groupChevron);
      groupHead.addEventListener('click', () => {
        pluginCollapsed = !pluginCollapsed;
        groupHead.classList.toggle('is-collapsed', pluginCollapsed);
        groupHead.setAttribute('aria-expanded', String(!pluginCollapsed));
        cardsHost.hidden = pluginCollapsed;
      });

      const cardsHost = document.createElement('div');
      cardsHost.id = 'mcpAddonCards';
      cardsHost.className = 'ae-cards-grid';
      cardsHost.hidden = pluginCollapsed;
      mainCol.append(groupHead, cardsHost);

      const sideCol = document.createElement('aside');
      sideCol.className = 'lx-cat-col';
      sideCol.setAttribute('aria-label', 'Категории дополнений');

      function categoryTitle(id) {
        const found = categories.find((category) => category.id === id);
        return found ? found.title : 'Все';
      }

      function matchesFilter(service) {
        if (onlyInstalled && !installedNames.has(service.id)) return false;
        if (pluginCategory !== 'all' && service.category !== pluginCategory) return false;
        const query = pluginQuery.trim().toLowerCase();
        if (!query) return true;
        const haystack = [
          service.id,
          service.title,
          service.description,
          categoryTitle(service.category),
          TRANSPORT_LABELS[service.transport] || '',
        ].join(' ').toLowerCase();
        return haystack.includes(query);
      }

      function paint() {
        const list = services
          .filter(matchesFilter)
          .sort((a, b) => {
            if (pluginSort === 'alpha') return String(a.title).localeCompare(String(b.title), 'ru');
            if (pluginSort === 'verified') return Number(b.verified) - Number(a.verified) || String(a.title).localeCompare(String(b.title), 'ru');
            return 0;
          });
        groupTitle.textContent = (pluginCategory === 'all' ? 'Каталог сервисов' : categoryTitle(pluginCategory)) + ' (' + list.length + ')';
        if (!services.length) {
          cardsHost.replaceChildren(emptyBox('Каталог дополнений загружается…'));
          return;
        }
        if (!list.length) {
          cardsHost.replaceChildren(emptyBox('По выбранным фильтрам ничего не найдено.'));
          return;
        }
        cardsHost.replaceChildren(...list.map((service) => buildServiceCard(service)));
      }

      function buildServiceCard(service) {
        const card = document.createElement('div');
        card.className = 'ae-grid-card';
        card.dataset.addon = service.id;
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-expanded', 'false');
        card.setAttribute('aria-label', 'Открыть карточку: ' + service.title);
        card.setAttribute('aria-controls', 'mcpAddonDetails-' + service.id);
        card.style.cursor = 'pointer';
        // У .ae-grid-card нет своего focus-visible в CSS: контур повторяем из токена темы
        // (правильное место — правило в aether.css, оно описано в отчёте).
        const syncCardRing = () => {
          if (card.matches(':focus-visible')) {
            card.style.outline = '2px solid var(--focus, var(--accent, #5070DD))';
            card.style.outlineOffset = '2px';
          } else {
            card.style.outline = '';
          }
        };
        card.addEventListener('focus', syncCardRing);
        card.addEventListener('blur', () => { card.style.outline = ''; });

        const head = document.createElement('div');
        head.className = 'ae-grid-card-head';
        const headLeft = document.createElement('div');
        headLeft.style.display = 'flex';
        headLeft.style.alignItems = 'center';
        headLeft.style.gap = '9px';
        headLeft.style.minWidth = '0';
        headLeft.append(iconBox(service.id, service.title, 34));
        const titleWrap = document.createElement('div');
        titleWrap.style.display = 'flex';
        titleWrap.style.flexDirection = 'column';
        titleWrap.style.minWidth = '0';
        const title = document.createElement('strong');
        title.textContent = service.title;
        title.style.fontSize = '13.5px';
        title.style.lineHeight = '1.25';
        const sub = document.createElement('span');
        sub.style.fontSize = '11.5px';
        sub.style.color = 'var(--lx-text-3, var(--text-3))';
        sub.textContent = categoryTitle(service.category) + ' · ' + (TRANSPORT_LABELS[service.transport] || '');
        titleWrap.append(title, sub);
        headLeft.append(titleWrap);
        head.append(headLeft);
        const verifiedMark = verificationMark(service.verified);
        if (verifiedMark) head.append(badge(verifiedMark, 'warn'));
        card.append(head);

        const desc = document.createElement('p');
        desc.className = 'ae-grid-card-desc';
        desc.textContent = service.description;
        desc.style.display = '-webkit-box';
        desc.style.webkitLineClamp = '3';
        desc.style.webkitBoxOrient = 'vertical';
        desc.style.overflow = 'hidden';
        card.append(desc);

        const footer = document.createElement('div');
        footer.style.display = 'flex';
        footer.style.alignItems = 'center';
        footer.style.gap = '8px';
        footer.style.flexWrap = 'wrap';

        if (installedNames.has(service.id)) {
          const done = document.createElement('span');
          done.className = 'ae-badge is-ok';
          done.textContent = 'Добавлен';
          footer.append(done);
        } else if (needsKey(service)) {
          const keyNote = document.createElement('span');
          keyNote.className = 'ae-badge';
          keyNote.textContent = 'нужен ключ';
          keyNote.title = 'Переменные окружения: ' + envKeyNames(service.envKeys);
          footer.append(keyNote);
          // У сервиса с ключами «Инструкция» есть всегда: без ссылки честно говорим, что её нет.
          footer.append(buildGuideButton(service, 'Инструкция ↗', 'Инструкция для этого сервиса недоступна'));
        } else {
          const addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
          addBtn.textContent = service.transport === 'http' ? 'Подключить' : 'Добавить';
          addBtn.title = service.transport === 'http'
            ? 'Добавить облачный сервер: ' + withHttps(service.url)
            : 'Добавить локальный сервер: ' + service.command;
          addBtn.addEventListener('click', () => {
            addBtn.disabled = true;
            const target = service.transport === 'http' ? withHttps(service.url) : service.command;
            const argsText = service.transport === 'http' ? '' : (service.args || []).join(' ');
            connectService(service.id, target, argsText);
          });
          footer.append(addBtn);
          if (service.docs) {
            footer.append(buildGuideButton(service, 'Инструкция ↗'));
          }
        }
        card.append(footer);

        // Карточка раскрывается: видно подключение, имена переменных (не значения)
        // и честное объяснение, что без ключа сервис не добавляется молча.
        const details = document.createElement('div');
        details.id = 'mcpAddonDetails-' + service.id;
        details.className = 'ae-grid-card-details';
        details.hidden = true;
        details.style.marginTop = '8px';
        details.style.paddingTop = '8px';
        details.style.borderTop = '1px solid rgba(255, 255, 255, 0.10)';
        details.style.display = 'none';
        details.style.flexDirection = 'column';
        details.style.gap = '5px';
        details.style.fontSize = '12px';
        details.style.lineHeight = '1.4';
        details.style.color = 'var(--lx-text-2, var(--text-2))';

        const transportLine = document.createElement('span');
        transportLine.textContent = service.transport === 'http'
          ? 'Подключение: через интернет · ' + withHttps(service.url)
          : 'Подключение: на компьютере · ' + service.command;
        details.append(transportLine);

        const keysLine = document.createElement('span');
        if (needsKey(service)) {
          keysLine.textContent = 'Нужны ключи (только имена): ' + envKeyNames(service.envKeys)
            + '. Значения в каталоге не хранятся — их задаёт владелец в настройках сборки.';
          keysLine.style.color = 'var(--lx-warn, var(--warn, inherit))';
        } else {
          keysLine.textContent = 'Отдельные ключи не нужны.';
        }
        details.append(keysLine);

        const verifiedLine = document.createElement('span');
        verifiedLine.textContent = service.verified
          ? 'Запись проверена в реестрах npm/PyPI и по HTTP-статусу.'
          : 'Запись ещё не проверена — доверять ей как проверенной нельзя.';
        details.append(verifiedLine);

        card.append(details);

        const toggleDetails = () => {
          const open = details.hidden;
          details.hidden = !open;
          details.style.display = open ? 'flex' : 'none';
          card.setAttribute('aria-expanded', String(open));
          card.setAttribute('aria-label', (open ? 'Свернуть карточку: ' : 'Открыть карточку: ') + service.title);
          card.style.boxShadow = open ? 'inset 0 0 0 1px rgba(80, 112, 221, 0.55)' : '';
        };
        card.addEventListener('click', (event) => {
          if (event.target.closest('button')) return;
          if (details.contains(event.target)) return;
          toggleDetails();
        });
        card.addEventListener('keydown', (event) => {
          // Esc закрывает раскрытые подробности из любого элемента карточки.
          if (event.key === 'Escape' && !details.hidden) {
            event.preventDefault();
            event.stopPropagation();
            toggleDetails();
            card.focus({ preventScroll: true });
            return;
          }
          if (event.target !== card) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleDetails();
          }
        });

        return card;
      }

      searchInput.addEventListener('input', () => {
        pluginQuery = searchInput.value;
        paint();
      });
      sortBtn.addEventListener('click', () => {
        const order = ['category', 'alpha', 'verified'];
        pluginSort = order[(order.indexOf(pluginSort) + 1) % order.length];
        sortBtn.replaceChildren(icon('sort'), document.createTextNode(SORT_LABELS_PLUGINS[pluginSort]));
        paint();
      });
      addMcpBtn.addEventListener('click', () => {
        showMcpForm = !showMcpForm;
        renderBody();
      });

      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = pluginCategory === 'all' ? 'lx-cat-btn is-active' : 'lx-cat-btn';
      allBtn.textContent = 'Все (' + services.length + ')';
      allBtn.addEventListener('click', () => {
        pluginCategory = 'all';
        renderBody();
      });
      sideCol.append(allBtn);
      for (const category of categories) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = pluginCategory === category.id ? 'lx-cat-btn is-active' : 'lx-cat-btn';
        const count = services.filter((service) => service.category === category.id).length;
        btn.textContent = category.title + ' (' + count + ')';
        btn.addEventListener('click', () => {
          pluginCategory = category.id;
          renderBody();
        });
        sideCol.append(btn);
      }

      layout.append(mainCol, sideCol);
      wrap.append(layout);

      const legal = document.createElement('p');
      legal.className = 'ae-muted';
      legal.style.margin = '0';
      legal.textContent = 'Значки: Simple Icons (CC0 1.0); названия сервисов — товарные знаки их владельцев. Монограммы нарисованы для Nox.';
      wrap.append(legal);

      contentHost.replaceChildren(wrap);
      paint();
    }

    function serverStatus(server) {
      if (!server) return { label: 'нет данных', tone: 'muted' };
      if (server.disabled) return { label: 'выключен', tone: 'muted' };
      if (server.drift) return { label: 'изменился', tone: 'warn' };
      if (server.error || server.status === 'error') return { label: 'ошибка', tone: 'danger' };
      if (server.status === 'connecting' || server.connecting) return { label: 'подключается', tone: 'info' };
      if (server.connected || server.status === 'connected') {
        const count = Number(server.toolCount) || (Array.isArray(server.tools) ? server.tools.length : 0);
        return { label: 'подключён · ' + count + ' действ.', tone: 'ok' };
      }
      if (server.status === 'legacy') return { label: 'при запуске', tone: 'muted' };
      return { label: 'не подключён', tone: 'muted' };
    }

    function describeServer(server, entry) {
      if (server.error) return String(server.error).slice(0, 240);
      const transport = server.transport === 'http' ? 'через интернет' : 'на компьютере';
      const address = server.target ? ' · ' + server.target : '';
      const title = entry ? entry.title : server.name;
      return title + ' · ' + transport + address;
    }

    function buildMcpForm() {
      const form = document.createElement('form');
      form.className = 'lx-card lx-mcp-form';
      const heading = document.createElement('div');
      heading.className = 'lx-card-subtitle';
      heading.textContent = 'Подключить свой MCP-сервер';
      const row = document.createElement('div');
      row.className = 'lx-mcp-form-row';
      const nameIn = document.createElement('input');
      nameIn.className = 'lx-input';
      nameIn.placeholder = 'Имя сервиса';
      nameIn.setAttribute('aria-label', 'Имя сервиса');
      const targetIn = document.createElement('input');
      targetIn.className = 'lx-input';
      targetIn.placeholder = 'Команда или адрес (https://…)';
      targetIn.setAttribute('aria-label', 'Команда или адрес');
      const argsIn = document.createElement('input');
      argsIn.className = 'lx-input';
      argsIn.placeholder = 'Аргументы через пробел (необязательно)';
      argsIn.setAttribute('aria-label', 'Аргументы команды');
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'lx-pill-btn lx-pill-primary';
      submit.textContent = 'Добавить';
      row.append(nameIn, targetIn, argsIn, submit);

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = nameIn.value.trim();
        const target = targetIn.value.trim();
        const argsText = argsIn.value.trim();
        if (!name || !target) {
          store.toast('Укажите имя и команду или адрес', 'error');
          return;
        }
        submit.disabled = true;
        connectService(name, target, argsText).finally(() => { submit.disabled = false; });
      });
      form.append(heading, row);
      return form;
    }

    // ── «Команды»: паки команд ───────────────────────────────────
    function renderCommands() {
      const packItems = serverPacks.length
        ? serverPacks.map((pack) => {
            const meta = PACK_UI_META[pack.id] || {};
            const totalCount = Number(pack.total) || 0;
            const installed = Number(pack.installed) || 0;
            const isFull = totalCount > 0 && installed >= totalCount;
            const partial = installed > 0 && installed < totalCount
              ? ' (установлено ' + installed + '/' + totalCount + ')'
              : (totalCount ? ' (' + totalCount + ' команд)' : '');
            return {
              id: 'pack-' + pack.id,
              packId: pack.id,
              title: pack.title || meta.title || pack.id,
              desc: (pack.hint || meta.desc || '') + partial,
              category: meta.category || 'default',
              popular: meta.popular !== undefined ? meta.popular : true,
              icon: meta.icon || 'archive',
              tint: meta.tint || '#2559E8',
              installed: isFull,
              installedCount: installed,
              totalCount: totalCount,
            };
          })
        : COMMAND_ADDONS;

      const installedN = packItems.filter((item) => item.installed).length;
      syncTabsHeader(installedN, packItems.length);

      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '12px';

      const searchRow = document.createElement('div');
      searchRow.className = 'lx-search-row';
      const searchBox = document.createElement('div');
      searchBox.className = 'lx-search-box';
      const searchIco = icon('search', 'lx-search-ico');
      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'lx-search-input';
      searchInput.value = commandQuery;
      searchInput.placeholder = 'Поиск команд…';
      searchInput.setAttribute('aria-label', 'Поиск команд');
      searchBox.append(searchIco, searchInput);

      const sortBtn = document.createElement('button');
      sortBtn.type = 'button';
      sortBtn.className = 'lx-pill-btn lx-pill-secondary lx-sort-btn';
      sortBtn.append(icon('sort'), document.createTextNode(SORT_LABELS_COMMANDS[commandSort]));
      sortBtn.addEventListener('click', () => {
        const order = ['popular', 'alpha', 'installed'];
        commandSort = order[(order.indexOf(commandSort) + 1) % order.length];
        sortBtn.replaceChildren(icon('sort'), document.createTextNode(SORT_LABELS_COMMANDS[commandSort]));
        paint();
      });
      searchRow.append(searchBox, sortBtn);
      wrap.append(searchRow);

      const layout = document.createElement('div');
      layout.className = 'lx-addons-grid';
      const mainCol = document.createElement('div');
      mainCol.className = 'lx-addons-main';

      const groupHead = document.createElement('button');
      groupHead.type = 'button';
      groupHead.className = commandCollapsed ? 'lx-group-head is-collapsed' : 'lx-group-head';
      groupHead.setAttribute('aria-expanded', String(!commandCollapsed));
      const groupTitle = document.createElement('span');
      const groupChevron = document.createElement('span');
      groupChevron.className = 'lx-group-chevron';
      groupChevron.append(icon('chevronDown'));
      groupHead.append(groupTitle, groupChevron);

      const cardsHost = document.createElement('div');
      cardsHost.className = 'lx-addon-cards';
      cardsHost.hidden = commandCollapsed;
      groupHead.addEventListener('click', () => {
        commandCollapsed = !commandCollapsed;
        groupHead.classList.toggle('is-collapsed', commandCollapsed);
        groupHead.setAttribute('aria-expanded', String(!commandCollapsed));
        cardsHost.hidden = commandCollapsed;
      });
      mainCol.append(groupHead, cardsHost);

      const sideCol = document.createElement('aside');
      sideCol.className = 'lx-cat-col';
      sideCol.setAttribute('aria-label', 'Категории команд');

      function categoryLabel(id) {
        const found = PACK_CATEGORIES.find((category) => category.id === id);
        return found ? found.label : 'Все';
      }

      function paint() {
        const query = commandQuery.trim().toLowerCase();
        let list = packItems.filter((item) => {
          if (onlyInstalled && !item.installed) return false;
          if (commandCategory === 'popular' && !item.popular && !query) return false;
          if (commandCategory !== 'popular' && item.category !== commandCategory) return false;
          if (query && !(String(item.title) + ' ' + String(item.desc)).toLowerCase().includes(query)) return false;
          return true;
        });
        if (commandSort === 'alpha') list = list.slice().sort((a, b) => String(a.title).localeCompare(String(b.title), 'ru'));
        else if (commandSort === 'installed') list = list.slice().sort((a, b) => Number(b.installed) - Number(a.installed));
        groupTitle.textContent = categoryLabel(commandCategory) + ' (' + list.length + ')';
        if (!list.length) {
          cardsHost.replaceChildren(emptyBox('По выбранным фильтрам ничего не найдено.'));
          return;
        }
        cardsHost.replaceChildren(...list.map((item) => buildCommandCard(item)));
      }

      function buildCommandCard(item) {
        const card = document.createElement('div');
        card.className = 'lx-addon-card';
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        card.dataset.installed = String(Boolean(item.installed));
        card.title = item.installed ? 'Нажмите для настройки или переключения' : 'Нажмите для установки';
        const box = document.createElement('div');
        box.className = 'lx-addon-ico-box';
        box.append(icon(item.icon || 'archive'));
        const info = document.createElement('div');
        info.className = 'lx-addon-info';
        const titleRow = document.createElement('div');
        titleRow.className = 'lx-addon-title-row';
        const title = document.createElement('span');
        title.className = 'lx-addon-title';
        title.textContent = item.title;
        titleRow.append(title);
        if (item.installed) titleRow.append(badge('установлен', 'ok'));
        const desc = document.createElement('p');
        desc.className = 'lx-addon-desc';
        desc.textContent = item.desc;
        info.append(titleRow, desc);
        card.append(box, info);
        if (!item.installed) {
          const act = document.createElement('div');
          act.className = 'lx-addon-act';
          const install = document.createElement('button');
          install.type = 'button';
          install.className = 'lx-pill-btn lx-pill-primary';
          install.textContent = 'Установить';
          install.addEventListener('click', (event) => {
            event.stopPropagation();
            installPackItem(item);
          });
          act.append(install);
          card.append(act);
        }
        const activate = () => { if (!item.installed) installPackItem(item); };
        card.addEventListener('click', activate);
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
          }
        });
        return card;
      }

      searchInput.addEventListener('input', () => {
        commandQuery = searchInput.value;
        paint();
      });

      for (const category of PACK_CATEGORIES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = category.id === commandCategory ? 'lx-cat-btn is-active' : 'lx-cat-btn';
        btn.textContent = category.label;
        btn.addEventListener('click', () => {
          commandCategory = category.id;
          renderBody();
        });
        sideCol.append(btn);
      }

      layout.append(mainCol, sideCol);
      wrap.append(layout);
      contentHost.replaceChildren(wrap);
      paint();
    }

    // ── «Озвучка»: голоса и синтез ───────────────────────────────
    function renderVoices() {
      syncTabsHeader(0, 0);
      const wrap = document.createElement('div');
      wrap.className = 'lx-voices-wrap';

      const subTabs = document.createElement('div');
      subTabs.className = 'lx-subtabs';
      for (const [id, text] of [['list', 'Голоса'], ['synth', 'Синтез голоса']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = voiceSubTab === id ? 'lx-pill-tab is-active' : 'lx-pill-tab';
        b.textContent = text;
        b.addEventListener('click', () => {
          voiceSubTab = id;
          renderBody();
        });
        subTabs.append(b);
      }
      wrap.append(subTabs);

      const settings = store.state.settings;
      const cloud = settings.voiceOutput === 'cloud';
      const available = settings.voiceCloudAvailable === true;
      const card = document.createElement('div');
      card.className = 'lx-card lx-synth-card';
      const heading = document.createElement('h3');
      heading.className = 'lx-section-title';
      heading.textContent = voiceSubTab === 'synth' ? 'Настройки синтеза голоса Nox' : 'Облачный голос';
      const status = document.createElement('p');
      status.className = 'lx-hint';
      status.setAttribute('role', 'status');
      if (!available) status.textContent = 'Облачная озвучка не настроена.';
      else if (!cloud) status.textContent = 'Озвучка выключена.';
      else if (settings.quiet) status.textContent = 'Включён тихий режим.';
      else status.textContent = 'Облачная озвучка включена.';
      card.append(heading);

      if (voiceSubTab === 'synth') {
        const field = document.createElement('label');
        field.className = 'ae-field';
        field.textContent = 'Режим озвучки';
        const select = document.createElement('select');
        select.className = 'ae-select';
        select.add(new Option('Выключена (по умолчанию)', 'off'));
        select.add(new Option('Облачная', 'cloud'));
        select.value = cloud ? 'cloud' : 'off';
        select.addEventListener('change', async () => {
          select.disabled = true;
          await store.setSetting('voiceOutput', select.value);
          renderBody();
          contentHost.querySelector('.ae-select')?.focus();
        });
        field.append(select);
        card.append(field);
      }

      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'lx-pill-btn lx-pill-primary';
      preview.append(icon('play'), document.createTextNode(voiceSubTab === 'synth' ? 'Проверить озвучку' : 'Прослушать'));
      preview.disabled = !cloud || !available || settings.quiet === true;
      preview.addEventListener('click', async () => {
        preview.disabled = true;
        status.textContent = 'Воспроизводится…';
        const result = await bridge.call('voiceTest').catch(() => null);
        status.textContent = result && result.ok ? 'Прослушивание завершилось.' : (result && result.error) || 'Не удалось воспроизвести голос.';
        preview.disabled = false;
      });
      card.append(status, preview);
      wrap.append(card);
      contentHost.replaceChildren(wrap);
    }

    function renderBody() {
      if (activeTab === 'voices') renderVoices();
      else if (activeTab === 'commands') renderCommands();
      else renderPlugins();
    }

    async function refreshPacks() {
      if (!bridge.has('installPack')) return;
      try {
        const packsRes = await bridge.call('installPack');
        if (packsRes && packsRes.ok && Array.isArray(packsRes.packs)) {
          serverPacks = packsRes.packs;
          renderBody();
        }
      } catch (err) { /* сбой паков не ломает раздел */ }
    }

    async function load() {
      const [mcpRes, packsRes, mailRes] = await Promise.all([
        bridge.has('mcpState') ? bridge.call('mcpState').catch(() => null) : null,
        bridge.has('installPack') ? bridge.call('installPack').catch(() => null) : null,
        bridge.has('mailState') ? bridge.call('mailState').catch(() => null) : null,
      ]);
      if (mcpRes && Array.isArray(mcpRes.servers)) mcpServers = mcpRes.servers;
      if (mcpRes && Array.isArray(mcpRes.catalog)) featuredCatalog = mcpRes.catalog;
      if (packsRes && packsRes.ok && Array.isArray(packsRes.packs)) serverPacks = packsRes.packs;
      if (mailRes) mail = mailRes;
      renderBody();
    }

    let dirtyPacksReload = false;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('nox:commands-updated', () => {
        if (!root.hidden) refreshPacks();
        else dirtyPacksReload = true;
      });
    }

    // Значки и снимок каталога подгружаются один раз; когда готовы — перерисовываем раздел.
    withLogos(() => {
      if (!root.hidden) renderBody();
    });
    load();

    let wasActive = false;
    function render(st) {
      const active = st.route === 'mcp';
      root.hidden = !active;
      if (active && (!wasActive || dirtyPacksReload)) {
        dirtyPacksReload = false;
        load();
      }
      wasActive = active;
    }

    function onEvent(ev) {
      if (ev && ev.type === 'commands:changed') {
        if (!root.hidden) refreshPacks();
        else dirtyPacksReload = true;
      }
    }

    return {
      el: root,
      load,
      onEvent,
      setTab,
      render,
    };
  }

  window.NoxAetherMcpView = { createMcpView, withHttps, envKeyNames, needsKey, verificationMark };
})();
