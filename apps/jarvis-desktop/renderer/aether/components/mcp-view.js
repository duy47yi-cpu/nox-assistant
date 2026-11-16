/* Раздел «Дополнения» (маршрут mcp):
 * - Вкладки «Плагины», «Команды» и «Озвучка» + переключатель «Только установленные» и счётчик;
 * - Каталог дополнений и команд с категориями справа, поиском и сортировкой;
 * - Библиотека голосов Nox (под Озвучкой): 2-колоночная сетка карточек голосов, фильтр языка/порядка справа и настройки синтеза;
 * - Сохраняет реальное подключение MCP-серверов, approve при drift и настройку голоса. */
(() => {
  'use strict';

  const ADDON_CATEGORIES = [
    { id: 'popular', label: 'Популярное' },
    { id: 'social', label: 'Соцсети и общение' },
    { id: 'browsers', label: 'Браузеры' },
    { id: 'design', label: 'Дизайн и творчество' },
    { id: 'media', label: 'Видео, музыка и стриминг' },
    { id: 'dev', label: 'Работа и разработка' },
    { id: 'games', label: 'Игровые сервисы' },
    { id: 'default', label: 'Команды по умолчанию' },
  ];

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
    id: `pack-${packId}`,
    packId,
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

  const PLUGIN_ADDONS = [
    {
      id: 'plugin-web-search',
      title: 'Веб-поиск и чтение страниц',
      desc: 'Безопасный поиск актуальных фактов и проверка источников прямо в ответе ассистента.',
      category: 'browsers',
      popular: true,
      icon: 'search',
      tint: '#2559E8',
      installed: true,
    },
    {
      id: 'plugin-files-index',
      title: 'Поиск по локальным папкам',
      desc: 'Индексация выбранных документов и проектов на компьютере с быстрым чтением нужных фрагментов.',
      category: 'dev',
      popular: true,
      icon: 'folder',
      tint: '#3D59D7',
      installed: true,
    },
    {
      id: 'plugin-calendar',
      title: 'Календарь и встречи',
      desc: 'Просмотр расписания дня, предупреждения о пересечениях и утренняя сводка дел.',
      category: 'default',
      popular: true,
      icon: 'checkCircle',
      tint: '#2E7CF6',
      installed: true,
    },
    {
      id: 'plugin-mail',
      title: 'Почта и черновики',
      desc: 'Подготовка вежливых писем и сводка непрочитанных сообщений с вашим подтверждением.',
      category: 'social',
      popular: true,
      icon: 'chat',
      tint: '#5070DD',
      installed: false,
    },
    {
      id: 'plugin-media',
      title: 'Медиа-мост',
      desc: 'Поиск видеороликов и фоновой музыки под текущую задачу или настроение.',
      category: 'media',
      popular: false,
      icon: 'music',
      tint: '#346CDB',
      installed: true,
    },
  ];

  function createMcpView({ store, bridge }) {
    const { icon } = window.NoxAetherIcons;

    const root = document.createElement('section');
    root.id = 'aeMcpView';
    root.className = 'ae-page lx-addons-page';
    root.hidden = true;
    root.setAttribute('aria-label', 'Дополнения');

    let activeTab = 'commands'; // 'plugins' | 'commands' | 'voices'
    let onlyInstalled = false;
    let searchQuery = '';
    let activeCategory = 'popular';
    let sortMode = 'popular'; // 'popular' | 'alpha' | 'installed'
    let mcpServers = [];
    let serverPacks = [];
    let showMcpForm = false;
    let groupCollapsed = false;

    // Состояние голосов
    let voiceSubTab = 'list'; // 'list' | 'synth'

    // ── Верхняя панель вкладок и счётчика ────────────────────────
    const topBar = document.createElement('div');
    topBar.className = 'lx-addons-topbar';

    const tabsWrap = document.createElement('div');
    tabsWrap.className = 'lx-pill-tabs';
    tabsWrap.setAttribute('role', 'tablist');

    const tabBtns = {};
    for (const [id, text] of [
      ['plugins', 'Плагины'],
      ['commands', 'Команды'],
      ['voices', 'Озвучка'],
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = `lxAddonsTab_${id}`;
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
      installedCount.textContent = `Установлено: ${installedN}/${totalN}`;
    }

    // ── Отрисовка «Плагины» и «Команды» ─────────────────────────
    function renderCatalogTab() {
      const commandPackItems = serverPacks.length
        ? serverPacks.map((p) => {
            const meta = PACK_UI_META[p.id] || {};
            const totalCount = Number(p.total) || 0;
            const installedCount = Number(p.installed) || 0;
            const isFull = totalCount > 0 && installedCount >= totalCount;
            const partialText = installedCount > 0 && installedCount < totalCount
              ? ` (установлено ${installedCount}/${totalCount})`
              : (totalCount ? ` (${totalCount} команд)` : '');
            return {
              id: `pack-${p.id}`,
              packId: p.id,
              title: p.title || meta.title || p.id,
              desc: `${p.hint || meta.desc || ''}${partialText}`,
              category: meta.category || 'default',
              popular: meta.popular !== undefined ? meta.popular : true,
              icon: meta.icon || 'archive',
              tint: meta.tint || '#2559E8',
              installed: isFull,
              installedCount,
              totalCount,
            };
          })
        : COMMAND_ADDONS;

      const sourceItems = activeTab === 'plugins'
        ? [
            ...PLUGIN_ADDONS,
            ...mcpServers.map((s) => ({
              id: `mcp_${s.name}`,
              mcpName: s.name,
              title: s.name,
              desc: `${s.transport || 'stdio'} · ${s.status || 'подключение'}${s.drift ? ' · требует подтверждения изменений' : ''}`,
              category: 'dev',
              popular: true,
              icon: 'mcp',
              tint: '#2559E8',
              installed: s.enabled !== false,
              drift: Boolean(s.drift),
            })),
          ]
        : commandPackItems;

      const installedN = sourceItems.filter((x) => x.installed).length;
      syncTabsHeader(installedN, sourceItems.length);

      const layout = document.createElement('div');
      layout.className = 'lx-addons-grid';

      // Левая колонка: поиск + карточки
      const mainCol = document.createElement('div');
      mainCol.className = 'lx-addons-main';

      const filterRow = document.createElement('div');
      filterRow.className = 'lx-search-row';

      const searchBox = document.createElement('div');
      searchBox.className = 'lx-search-box';
      const searchIco = icon('search', 'lx-search-ico');
      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'lx-search-input';
      searchInput.value = searchQuery;
      searchInput.placeholder = activeTab === 'plugins' ? 'Поиск плагинов…' : 'Поиск команд…';
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        renderCards();
      });
      searchBox.append(searchIco, searchInput);

      const sortBtn = document.createElement('button');
      sortBtn.type = 'button';
      sortBtn.className = 'lx-pill-btn lx-pill-secondary lx-sort-btn';
      const SORT_LABELS = { popular: 'Сортировка', alpha: 'По алфавиту', installed: 'Установленные' };
      sortBtn.append(icon('sort'), document.createTextNode(SORT_LABELS[sortMode]));
      sortBtn.addEventListener('click', () => {
        const order = ['popular', 'alpha', 'installed'];
        sortMode = order[(order.indexOf(sortMode) + 1) % order.length];
        renderBody();
      });

      filterRow.append(searchBox, sortBtn);

      if (activeTab === 'plugins') {
        const addMcpBtn = document.createElement('button');
        addMcpBtn.type = 'button';
        addMcpBtn.className = 'lx-pill-btn lx-pill-primary';
        addMcpBtn.textContent = showMcpForm ? 'Скрыть форму' : '+ Свой MCP';
        addMcpBtn.addEventListener('click', () => {
          showMcpForm = !showMcpForm;
          renderBody();
        });
        filterRow.append(addMcpBtn);
      }

      mainCol.append(filterRow);

      // Форма добавления своего MCP при нажатии
      if (activeTab === 'plugins' && showMcpForm) {
        const form = document.createElement('form');
        form.className = 'lx-card lx-mcp-form';
        const fTitle = document.createElement('div');
        fTitle.className = 'lx-card-subtitle';
        fTitle.textContent = 'Подключить свой MCP-сервер';

        const row = document.createElement('div');
        row.className = 'lx-mcp-form-row';
        const nameIn = document.createElement('input');
        nameIn.className = 'lx-input';
        nameIn.placeholder = 'Имя сервиса';
        const cmdIn = document.createElement('input');
        cmdIn.className = 'lx-input';
        cmdIn.placeholder = 'Команда или адрес (http://...)';
        const addSubmit = document.createElement('button');
        addSubmit.type = 'submit';
        addSubmit.className = 'lx-pill-btn lx-pill-primary';
        addSubmit.textContent = 'Добавить';
        row.append(nameIn, cmdIn, addSubmit);

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const name = nameIn.value.trim();
          const cmd = cmdIn.value.trim();
          if (!name || !cmd) {
            store.toast('Укажите имя и команду или адрес', 'error');
            return;
          }
          if (bridge.has('mcpAdd')) {
            try {
              const res = await bridge.call('mcpAdd', {
                name,
                transport: /^https?:\/\//i.test(cmd) ? 'http' : 'stdio',
                command: /^https?:\/\//i.test(cmd) ? '' : cmd,
                url: /^https?:\/\//i.test(cmd) ? cmd : '',
              });
              if (res?.ok === false) throw new Error(res.error || 'Не удалось добавить');
              showMcpForm = false;
              await load();
            } catch (err) {
              store.toast(bridge.errText(err), 'error');
            }
          }
        });
        form.append(fTitle, row);
        mainCol.append(form);
      }

      const groupHead = document.createElement('button');
      groupHead.type = 'button';
      groupHead.className = groupCollapsed ? 'lx-group-head is-collapsed' : 'lx-group-head';
      groupHead.setAttribute('aria-expanded', String(!groupCollapsed));
      const groupTitleEl = document.createElement('span');
      const groupChevronEl = document.createElement('span');
      groupChevronEl.className = 'lx-group-chevron';
      groupChevronEl.append(icon('chevronDown'));
      groupHead.append(groupTitleEl, groupChevronEl);

      const cardsHost = document.createElement('div');
      cardsHost.className = 'lx-addon-cards';
      cardsHost.hidden = groupCollapsed;

      groupHead.addEventListener('click', () => {
        groupCollapsed = !groupCollapsed;
        groupHead.classList.toggle('is-collapsed', groupCollapsed);
        groupHead.setAttribute('aria-expanded', String(!groupCollapsed));
        cardsHost.hidden = groupCollapsed;
      });

      mainCol.append(groupHead, cardsHost);

      function renderCards() {
        const q = searchQuery.trim().toLowerCase();
        let list = sourceItems.filter((item) => {
          if (onlyInstalled && !item.installed) return false;
          if (activeCategory === 'popular' && !item.popular && !q) return false;
          if (activeCategory !== 'popular' && item.category !== activeCategory) return false;
          if (q && !`${item.title} ${item.desc}`.toLowerCase().includes(q)) return false;
          return true;
        });

        if (sortMode === 'alpha') {
          list = [...list].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
        } else if (sortMode === 'installed') {
          list = [...list].sort((a, b) => Number(b.installed) - Number(a.installed));
        }

        const catLabel = (ADDON_CATEGORIES.find((c) => c.id === activeCategory) || ADDON_CATEGORIES[0]).label;
        groupTitleEl.textContent = `${catLabel} (${list.length})`;

        if (!list.length) {
          const empty = document.createElement('div');
          empty.className = 'lx-empty-box';
          empty.textContent = 'По выбранным фильтрам ничего не найдено.';
          cardsHost.replaceChildren(empty);
          return;
        }

        const activateCard = async (item) => {
          if (item.mcpName && bridge.has('mcpToggle')) {
            await bridge.call('mcpToggle', item.mcpName, !item.installed);
            await load();
            return;
          }
          if (item.packId && bridge.has('installPack')) {
            try {
              const r = await bridge.call('installPack', item.packId);
              if (r && r.ok === false) throw new Error(r.error || 'Не удалось установить пак');
              await refreshPacks();
              if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                window.dispatchEvent(new CustomEvent('nox:commands-updated'));
              }
              store.toast(
                r && r.added
                  ? `Пак «${item.title}» установлен (+${r.added})`
                  : `Пак «${item.title}» уже установлен`,
                'ok'
              );
              return;
            } catch (err) {
              store.toast(bridge.errText(err), 'error');
              return;
            }
          }
          item.installed = !item.installed;
          renderBody();
        };

        cardsHost.replaceChildren(...list.map((item) => {
          const card = document.createElement('div');
          card.className = 'lx-addon-card';
          card.setAttribute('role', 'button');
          card.tabIndex = 0;
          card.dataset.installed = String(Boolean(item.installed));
          card.title = item.installed ? 'Нажмите для настройки или переключения' : 'Нажмите для подключения';

          const badge = document.createElement('div');
          badge.className = 'lx-addon-ico-box';
          badge.append(icon(item.icon || 'personal'));

          const info = document.createElement('div');
          info.className = 'lx-addon-info';
          const titleRow = document.createElement('div');
          titleRow.className = 'lx-addon-title-row';
          const titleEl = document.createElement('span');
          titleEl.className = 'lx-addon-title';
          titleEl.textContent = item.title;
          titleRow.append(titleEl);

          const descEl = document.createElement('p');
          descEl.className = 'lx-addon-desc';
          descEl.textContent = item.desc;
          info.append(titleRow, descEl);

          card.append(badge, info);

          if (item.drift && bridge.has('mcpApprove')) {
            const right = document.createElement('div');
            right.className = 'lx-addon-act';
            const approveBtn = document.createElement('button');
            approveBtn.type = 'button';
            approveBtn.className = 'lx-pill-btn lx-pill-primary';
            approveBtn.textContent = 'Подтвердить';
            approveBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              await bridge.call('mcpApprove', item.mcpName);
              await load();
            });
            right.append(approveBtn);
            card.append(right);
          }

          card.addEventListener('click', () => activateCard(item));
          card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activateCard(item);
            }
          });

          return card;
        }));
      }

      renderCards();

      // Правая колонка категорий
      const sideCol = document.createElement('aside');
      sideCol.className = 'lx-cat-col';
      sideCol.setAttribute('aria-label', 'Категории дополнений');

      for (const cat of ADDON_CATEGORIES) {
        const catBtn = document.createElement('button');
        catBtn.type = 'button';
        catBtn.className = cat.id === activeCategory ? 'lx-cat-btn is-active' : 'lx-cat-btn';
        catBtn.textContent = cat.label;
        catBtn.addEventListener('click', () => {
          activeCategory = cat.id;
          renderBody();
        });
        sideCol.append(catBtn);
      }

      layout.append(mainCol, sideCol);
      contentHost.replaceChildren(layout);
    }

    // ── Отрисовка «Озвучка → Голоса / Синтез голоса» ─────────────
    function renderVoicesTab() {
      syncTabsHeader(0, 0);

      const wrap = document.createElement('div');
      wrap.className = 'lx-voices-wrap';

      // Подвкладки: Голоса / Синтез голоса
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
        status.textContent = result?.ok ? 'Прослушивание завершилось.' : result?.error || 'Не удалось воспроизвести голос.';
        preview.disabled = false;
      });
      card.append(status, preview);
      wrap.append(card);
      contentHost.replaceChildren(wrap);
    }

    function renderBody() {
      if (activeTab === 'voices') renderVoicesTab();
      else renderCatalogTab();
    }

    async function refreshPacks() {
      if (!bridge.has('installPack')) return;
      try {
        const packsRes = await bridge.call('installPack');
        if (packsRes && packsRes.ok && Array.isArray(packsRes.packs)) {
          serverPacks = packsRes.packs;
          renderBody();
        }
      } catch { /* ignore */ }
    }

    async function load() {
      const [mcpRes, packsRes] = await Promise.all([
        bridge.has('mcpState') ? bridge.call('mcpState').catch(() => null) : null,
        bridge.has('installPack') ? bridge.call('installPack').catch(() => null) : null,
      ]);
      if (mcpRes && Array.isArray(mcpRes.servers)) mcpServers = mcpRes.servers;
      if (packsRes && packsRes.ok && Array.isArray(packsRes.packs)) serverPacks = packsRes.packs;
      renderBody();
    }

    let dirtyPacksReload = false;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('nox:commands-updated', () => {
        if (!root.hidden) refreshPacks();
        else dirtyPacksReload = true;
      });
    }

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

  window.NoxAetherMcpView = { createMcpView };
})();
