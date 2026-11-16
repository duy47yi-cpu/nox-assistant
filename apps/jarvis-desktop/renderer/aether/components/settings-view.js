/* Раздел «Настройки» и «Мастерская Nox» Nox Aether:
 * - поиск по всем категориям и отдельные страницы сферы, окна, оформления, доступа и голоса;
 * - единая «Библиотека сфер» (сохраняет обе существующие системы NoxOrb и JarvisOrb и все их варианты без визуальных правок);
 * - независимые настройки для каждой сферы, пресеты и сброс без потери параметров при переключении;
 * - шрифт подписи «The Nox» (IBM Plex Serif, Times New Roman, Georgia, Sitka), темы, акцент, свой фон и 9 эффектов;
 * - временная кнопка безопасного отката на прошлый интерфейс (uiShell: 'legacy'). */
(() => {
  'use strict';

  const THEME_LABELS = {
    dark: 'Тёмная (Nox)',
    signal: 'Ночь',
    light: 'Светлая',
    graphite: 'Графит',
    lime: 'Лайм',
    paper: 'Бумага',
    forest: 'Лес',
    wine: 'Вино',
    cobalt: 'Кобальт',
    aurora: 'Аврора',
    ember: 'Угли',
    dawn: 'Рассвет',
    glass: 'Стекло',
    liquid: 'Жидкая ночь',
    liquidday: 'Жидкий день',
    frost: 'Иней',
    gradient: 'Градиент ночь',
    gradientday: 'Градиент день',
    midnight: 'Полночь',
    neon: 'Неон',
    starry: 'Звёзды',
    moonlight: 'Лунный свет',
    sunrise: 'Восход',
    'blue-hour': 'Синий час',
    eclipse: 'Затмение',
    malachite: 'Малахит',
    copper: 'Медь',
    porcelain: 'Фарфор',
    system: 'Как в системе',
  };

  function createSettingsView({ store, bridge }) {
    const lib = window.NoxOrbLibrary;
    const boot = window.NoxAetherBoot;
    const T = window.JarvisTheme;
    const { icon } = window.NoxAetherIcons;

    const root = document.createElement('section');
    root.className = 'ae-page ae-settings-page';
    root.id = 'aeSettingsView';
    root.hidden = true;
    root.setAttribute('aria-label', 'Настройки');

    let section = 'workshop';
    let searchQuery = '';
    let modelBusy = false;
    let modelMessage;
    const unsubModelProgress = window.jarvis?.onVoiceModelProgress?.((percent) => {
      if (modelMessage?.isConnected) modelMessage.textContent = `Загрузка · ${percent}%`;
    });
    let quickHotkeyText = '';
    let previewHandle = null;
    let previewOrbId = null;

    const head = document.createElement('div');
    head.className = 'ae-page-head';
    const tw = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.className = 'ae-page-title';
    h1.textContent = 'Настройки';
    tw.append(h1);

    const searchInp = document.createElement('input');
    searchInp.type = 'search';
    searchInp.className = 'ae-input ae-search-wide';
    searchInp.placeholder = 'Поиск в настройках';
    searchInp.setAttribute('aria-label', 'Поиск по всем настройкам');
    const searchWrap = document.createElement('label');
    searchWrap.className = 'ae-page-search';
    searchWrap.append(icon('search'), searchInp);
    searchInp.addEventListener('input', () => {
      searchQuery = searchInp.value.trim().toLowerCase();
      render(store.state);
    });
    head.append(tw);

    const tabs = document.createElement('nav');
    tabs.className = 'ae-settings-nav';
    tabs.setAttribute('aria-label', 'Разделы настроек');
    tabs.append(searchWrap);
    const SEC_DEFS = [
      ['workshop', 'Сфера', 'orb'],
      ['window', 'Окно и чат', 'panelLeft'],
      ['appearance', 'Оформление', 'palette'],
      ['general', 'Основные и доступ', 'settings'],
      ['voice', 'Голосовой ввод', 'mic'],
      ['speech', 'Озвучка', 'volume'],
    ];
    const tabBtns = new Map();
    for (const [id, label, glyph] of SEC_DEFS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ae-settings-nav-btn';
      b.dataset.section = id;
      b.append(icon(glyph), label);
      b.addEventListener('click', () => {
        section = id;
        clearSearch();
        root.scrollTop = 0;
        render(store.state);
      });
      tabs.append(b);
      tabBtns.set(id, b);
    }

    const body = document.createElement('div');
    body.className = 'ae-settings-body';

    const layout = document.createElement('div');
    layout.className = 'ae-settings-layout';
    layout.append(tabs, body);
    root.append(head, layout);

    function clearSearch() {
      searchInp.value = '';
      searchQuery = '';
    }

    function updateWorkshop(patch) {
      if (!boot) return;
      const next = { ...boot.readWorkshop(), ...patch };
      try { localStorage.setItem(boot.WORKSHOP_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      boot.applyWorkshopToDom(next);
      store.notify(true);
    }

    function destroyPreview() {
      if (previewHandle) {
        previewHandle.destroy();
        previewHandle = null;
        previewOrbId = null;
      }
    }

    // Синхронизируем предпросмотр в Мастерской при изменениях, не перестраивая форму при плавном перетаскивании ползунков
    let lastSig = '';
    const unsubLib = lib ? lib.subscribe((snap) => {
      if (root.hidden || (!searchQuery && section !== 'workshop')) return;
      const activeInput = document.activeElement;
      const isSliderActive = Boolean(activeInput && root.contains(activeInput) && activeInput.tagName === 'INPUT' && activeInput.type === 'range');
      if (((previewHandle && previewOrbId === snap.activeId) || isSliderActive) && !snap.activeSettings.presetId) {
        if (previewHandle) {
          previewHandle.applySettings(snap.activeSettings, document.documentElement.dataset.animations !== 'off');
        }
        const cards = root.querySelectorAll('.ae-orb-choice');
        for (const c of cards) {
          const isAct = c.id === `aeOrbCard_${snap.activeId.replace(':', '_')}`;
          c.classList.toggle('is-active', isAct);
          c.setAttribute('aria-pressed', String(isAct));
        }
        const presets = root.querySelectorAll('.ae-preset-row .ae-subtab');
        for (const p of presets) {
          p.classList.remove('is-active');
          p.setAttribute('aria-pressed', 'false');
        }
      } else {
        lastSig = '';
        renderBody();
      }
    }) : () => {};

    function matchesSearch(title, desc = '') {
      if (!searchQuery) return true;
      const normalize = (text) => text.toLowerCase().replaceAll('ё', 'е');
      const haystack = normalize(`${title} ${desc}`);
      return normalize(searchQuery).split(/\s+/).every((word) => haystack.includes(word));
    }

    function makePanel(title, desc = '') {
      const panel = document.createElement('div');
      panel.className = 'ae-panel ae-settings-group';
      const th = document.createElement('h2');
      th.textContent = title;
      panel.append(th);
      if (desc) {
        const dp = document.createElement('p');
        dp.className = 'ae-muted';
        dp.textContent = desc;
        panel.append(dp);
      }
      return panel;
    }

    function makeToggleRow(title, hint, checked, onChange) {
      const row = document.createElement('label');
      row.className = 'ae-set-row';
      const txt = document.createElement('div');
      txt.className = 'ae-set-text';
      const nm = document.createElement('strong');
      nm.textContent = title;
      txt.append(nm);
      if (hint) {
        const h = document.createElement('span');
        h.className = 'ae-item-meta';
        h.textContent = hint;
        txt.append(h);
      }
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.className = 'ae-checkbox';
      inp.setAttribute('role', 'switch');
      inp.checked = Boolean(checked);
      inp.addEventListener('change', () => onChange(inp.checked));
      row.append(txt, inp);
      return row;
    }

    function renderWorkshop(group) {
      const wrap = document.createElement('div');
      wrap.className = 'ae-stack';

      // ── 1. Библиотека сфер + Живой предпросмотр ────────────────
      if ((group === 'workshop' || searchQuery) && lib && matchesSearch(
        'Сфера Библиотека сфер вариант пресет Nox Jarvis Контур Точечный Ядро Диафрагма масштаб движение реакция на голос прозрачность ореол свечение скорость плотность',
        lib.getSnapshot().orbs.map((orb) => orb.name).join(' ')
      )) {
        const snap = lib.getSnapshot();
        const activeSpec = snap.activeSpec;
        const activeCfg = snap.activeSettings;

        const panel = makePanel('Библиотека сфер');
        panel.classList.add('ae-workshop-orbs');

        const split = document.createElement('div');
        split.className = 'ae-orb-workshop-split';

        // Живой стенд текущей сферы
        const previewCard = document.createElement('div');
        previewCard.className = 'ae-orb-preview-card';
        const pStage = document.createElement('div');
        pStage.className = 'ae-orb-preview-stage';
        const pCanvas = document.createElement('canvas');
        pCanvas.className = 'ae-orb-preview-canvas';
        pCanvas.style.opacity = String(Number.isFinite(Number(activeCfg.opacity)) ? activeCfg.opacity : 1);
        pStage.append(pCanvas);

        const pCaption = document.createElement('div');
        pCaption.className = 'ae-orb-preview-cap';
        const pSig = document.createElement('div');
        pSig.className = 'ae-orb-signature';
        pSig.textContent = 'The Nox';
        const pSys = document.createElement('div');
        pSys.className = 'ae-item-meta';
        pSys.textContent = `${activeSpec.name} · ${activeSpec.systemLabel}`;
        pCaption.append(pSig, pSys);

        previewCard.append(pStage, pCaption);

        requestAnimationFrame(() => {
          if (root.hidden || !pCanvas.isConnected) return;
          destroyPreview();
          previewOrbId = snap.activeId;
          previewHandle = lib.mount(pCanvas, snap.activeId, {
            globalAnimated: document.documentElement.dataset.animations !== 'off',
            state: 'idle',
            stageEl: pStage,
          });
        });

        // Правая колонка: карточки выбора + пресеты + параметры выбранной сферы
        const rightCol = document.createElement('div');
        rightCol.className = 'ae-orb-controls-col';

        // Группировка по системам без путаницы
        const bySys = new Map();
        for (const orb of snap.orbs) {
          const g = orb.systemLabel || 'Другие';
          if (!bySys.has(g)) bySys.set(g, []);
          bySys.get(g).push(orb);
        }

        for (const [sysName, orbs] of bySys.entries()) {
          const gHead = document.createElement('div');
          gHead.className = 'ae-group-label';
          gHead.textContent = sysName;
          const cardsRow = document.createElement('div');
          cardsRow.className = 'ae-orb-cards-grid';
          for (const o of orbs) {
            const c = document.createElement('button');
            c.type = 'button';
            c.id = `aeOrbCard_${o.id.replace(':', '_')}`;
            c.className = o.id === snap.activeId ? 'ae-orb-choice is-active' : 'ae-orb-choice';
            c.setAttribute('aria-pressed', String(o.id === snap.activeId));
            const nm = document.createElement('strong');
            nm.textContent = o.name;
            const ds = document.createElement('span');
            ds.className = 'ae-orb-choice-desc';
            ds.textContent = o.subtitle || o.desc || '';
            c.append(nm, ds);
            c.addEventListener('click', () => lib.setActive(o.id));
            cardsRow.append(c);
          }
          rightCol.append(gHead, cardsRow);
        }

        // Пресеты активной сферы
        if (activeSpec.presets && Object.keys(activeSpec.presets).length) {
          const prRow = document.createElement('div');
          prRow.className = 'ae-preset-row';
          const prLbl = document.createElement('span');
          prLbl.className = 'ae-group-label';
          prLbl.textContent = 'Быстрые пресеты сферы:';
          const prBtns = document.createElement('div');
          prBtns.className = 'ae-chips-row';
          for (const [pk, pv] of Object.entries(activeSpec.presets)) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = activeCfg.presetId === pk ? 'ae-subtab is-active' : 'ae-subtab';
            b.textContent = pv.name || pv.label || pk;
            b.addEventListener('click', () => lib.applyPreset(snap.activeId, pk));
            prBtns.append(b);
          }
          const rstB = document.createElement('button');
          rstB.type = 'button';
          rstB.className = 'ae-btn ae-btn-ghost ae-btn-xs';
          rstB.textContent = 'Сбросить эту сферу';
          rstB.addEventListener('click', () => lib.resetOrb(snap.activeId));
          prBtns.append(rstB);
          prRow.append(prLbl, prBtns);
          rightCol.append(prRow);
        }

        // Параметры конкретной сферы
        const fieldsWrap = document.createElement('div');
        fieldsWrap.className = 'ae-orb-fields';
        for (const f of activeSpec.fields || []) {
          const kind = f.kind || f.type;
          if (kind === 'switch' || kind === 'toggle') {
            fieldsWrap.append(makeToggleRow(f.label, '', activeCfg[f.key] !== false, (val) => {
              lib.updateSettings(snap.activeId, { [f.key]: val });
            }));
          } else if (kind === 'range') {
            const row = document.createElement('div');
            row.className = 'ae-range-row';
            const hdr = document.createElement('div');
            hdr.className = 'ae-range-head';
            const lbl = document.createElement('span');
            lbl.textContent = f.label;
            const valEl = document.createElement('span');
            valEl.className = 'ae-range-val';
            valEl.textContent = Number(activeCfg[f.key] ?? f.min).toFixed(2);
            hdr.append(lbl, valEl);
            const rng = document.createElement('input');
            rng.type = 'range';
            rng.setAttribute('aria-label', f.label);
            rng.min = String(f.min);
            rng.max = String(f.max);
            rng.step = String(f.step || 0.05);
            rng.value = String(activeCfg[f.key] ?? f.min);
            rng.addEventListener('input', () => {
              valEl.textContent = Number(rng.value).toFixed(2);
              lib.updateSettings(snap.activeId, { [f.key]: Number(rng.value) });
            });
            row.append(hdr, rng);
            fieldsWrap.append(row);
          }
        }
        rightCol.append(fieldsWrap);

        split.append(previewCard, rightCol);
        panel.append(split);
        wrap.append(panel);
      }

      // ── 2. Подпись «The Nox», композиция и шрифт ────────────────
      if ((group === 'window' || searchQuery) && boot && matchesSearch('Окно чат The Nox подпись шрифт Times New Roman IBM Plex Serif композиция ширина сфера положение плотность свечение')) {
        const curW = boot.readWorkshop();
        const panel = makePanel('Композиция и подпись «The Nox»', 'Подпись под сферой и распределение пространства чата.');

        const grid = document.createElement('div');
        grid.className = 'ae-workshop-grid';

        const mkSelect = (label, value, options, onChange) => {
          const box = document.createElement('label');
          box.className = 'ae-field';
          const sp = document.createElement('span');
          sp.textContent = label;
          const sel = document.createElement('select');
          sel.className = 'ae-select';
          for (const [k, t] of options) {
            const o = document.createElement('option');
            o.value = k;
            o.textContent = t;
            if (k === value) o.selected = true;
            sel.append(o);
          }
          sel.addEventListener('change', () => onChange(sel.value));
          box.append(sp, sel);
          return box;
        };

        grid.append(
          mkSelect('Шрифт подписи «The Nox»', curW.signatureFont, [
            ['plex', 'IBM Plex Serif (книжный)'],
            ['times', 'Классический (Times New Roman)'],
            ['georgia', 'Georgia'],
            ['sitka', 'Sitka'],
          ], (v) => updateWorkshop({ signatureFont: v })),

          mkSelect('Положение сферы в чате', curW.orbPosition, [
            ['right', 'Справа от диалога'],
            ['left', 'Слева от диалога'],
            ['top', 'Компактно сверху'],
            ['hidden', 'Скрыть сферу'],
          ], (v) => updateWorkshop({ orbPosition: v })),

          mkSelect('Ширина колонки чата', curW.chatWidth, [
            ['narrow', 'Сдержанная (узкая)'],
            ['medium', 'Сбалансированная'],
            ['wide', 'Широкая'],
          ], (v) => updateWorkshop({ chatWidth: v })),

          mkSelect('Плотность интерфейса', curW.density, [
            ['calm', 'Спокойная'],
            ['compact', 'Компактная'],
          ], (v) => updateWorkshop({ density: v }))
        );

        const splitRow = document.createElement('div');
        splitRow.className = 'ae-range-row ae-mt-sm';
        const splitHdr = document.createElement('div');
        splitHdr.className = 'ae-range-head';
        const splitLbl = document.createElement('span');
        splitLbl.textContent = 'Ширина сцены сферы';
        const splitVal = document.createElement('span');
        splitVal.className = 'ae-range-val';
        const curSplit = Math.max(260, Math.min(540, Number(curW.orbSplitPx) || 400));
        splitVal.textContent = `${curSplit} px`;
        splitHdr.append(splitLbl, splitVal);
        const splitRng = document.createElement('input');
        splitRng.type = 'range';
        splitRng.min = '260';
        splitRng.max = '540';
        splitRng.step = '10';
        splitRng.value = String(curSplit);
        splitRng.addEventListener('input', () => {
          const px = Number(splitRng.value);
          splitVal.textContent = `${px} px`;
          updateWorkshop({ orbSplitPx: px });
        });
        splitRow.append(splitHdr, splitRng);

        panel.append(
          grid,
          splitRow,
          makeToggleRow(
            'Мягкое свечение вокруг сферы',
            'Лёгкий цветовой ореол сцены в цвет активной темы.',
            curW.accentGlow !== false,
            (v) => updateWorkshop({ accentGlow: v })
          )
        );
        wrap.append(panel);
      }

      // ── 3. Тема, акцент и фон окна ──────────────────────────────
      if ((group === 'appearance' || searchQuery) && T && matchesSearch('Оформление Тема палитра цвет акцент HEX фон эффект звёзды дождь снег своя картинка размытие панели',
        [...Object.values(THEME_LABELS), ...T.ACCENTS.map((a) => a.name)].join(' '))) {
        const panel = makePanel('Темы');

        const themeGrid = document.createElement('label');
        themeGrid.className = 'ae-field';
        const themeSelect = document.createElement('select');
        themeSelect.className = 'ae-select';
        let curTheme = document.documentElement.dataset.theme || 'dark';
        try { curTheme = localStorage.getItem('jarvis.theme') || curTheme; } catch { /* без хранилища */ }
        for (const id of T.IDS) {
          themeSelect.add(new Option(THEME_LABELS[id] || id, id));
        }
        themeSelect.value = T.IDS.includes(curTheme) ? curTheme : 'dark';
        themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
        function applyTheme(id) {
          themeSelect.value = id;
          try {
            if (boot) localStorage.setItem(boot.THEME_CHOSEN_KEY, '1');
            localStorage.setItem('jarvis.theme', themeSelect.value);
          } catch { /* без хранилища */ }
          T.apply(themeSelect.value);
          document.dispatchEvent(new Event('jarvis:themechange'));
          syncAppearance();
        }
        themeSelect.id = 'aeThemeSelect';
        themeGrid.append('Все темы', themeSelect);
        const gallery = document.createElement('div');
        gallery.className = 'ae-theme-gallery';
        for (const id of ['dark', 'malachite', 'blue-hour', 'eclipse', 'copper', 'porcelain']) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'ae-theme-card';
          button.dataset.themeId = id;
          button.setAttribute('aria-pressed', 'false');
          const sample = document.createElement('span');
          sample.className = 'ae-theme-sample';
          sample.dataset.theme = id;
          sample.setAttribute('aria-hidden', 'true');
          sample.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
          const title = document.createElement('span');
          title.textContent = THEME_LABELS[id];
          button.append(sample, title);
          button.addEventListener('click', () => applyTheme(id));
          gallery.append(button);
        }
        panel.append(gallery, themeGrid);
        wrap.append(panel);
        const colorPanel = makePanel('Акцент и фон');

        // Акцент
        const accRow = document.createElement('div');
        accRow.className = 'ae-chips-row ae-accent-options';
        accRow.setAttribute('role', 'group');
        accRow.setAttribute('aria-label', 'Цвет акцента');
        for (const a of T.ACCENTS) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ae-accent-choice';
          b.title = a.name;
          b.setAttribute('aria-label', a.name);
          b.dataset.accentId = a.id;
          const dot = document.createElement('span');
          dot.className = 'ae-accent-dot';
          b.append(dot);
          b.addEventListener('click', () => {
            applyAccent(a.id);
          });
          accRow.append(b);
        }
        const accent = document.createElement('div');
        accent.className = 'ae-field';
        accent.append('Цвет акцента', accRow);
        const hexForm = document.createElement('form');
        hexForm.className = 'ae-hex-form';
        const hex = document.createElement('input');
        hex.id = 'aeAccentHex';
        hex.className = 'ae-input';
        hex.placeholder = '#89DAB1';
        hex.maxLength = 7;
        hex.spellcheck = false;
        hex.setAttribute('aria-label', 'Свой цвет HEX');
        const hexApply = document.createElement('button');
        hexApply.className = 'ae-btn ae-btn-secondary ae-btn-sm';
        hexApply.textContent = 'Применить';
        const hexStatus = document.createElement('span');
        hexStatus.className = 'ae-hex-status';
        hexStatus.setAttribute('role', 'status');
        const colorPicker = document.createElement('input');
        colorPicker.type = 'color';
        colorPicker.className = 'ae-accent-picker';
        colorPicker.setAttribute('aria-label', 'Выбрать свой цвет');
        colorPicker.addEventListener('change', () => applyAccent(colorPicker.value));
        const hexLabel = document.createElement('label');
        hexLabel.className = 'ae-hex-label';
        hexLabel.htmlFor = hex.id;
        hexLabel.textContent = 'HEX';
        hexForm.append(colorPicker, hexLabel, hex, hexApply, hexStatus);
        hexForm.addEventListener('submit', (event) => {
          event.preventDefault();
          const color = T.normHex(hex.value);
          if (!color) {
            hex.setAttribute('aria-invalid', 'true');
            hexStatus.textContent = 'Введите HEX, например #89DAB1.';
            return;
          }
          applyAccent(color);
        });
        accent.append(hexForm);

        function applyAccent(value) {
          T.setAccent(value);
          document.dispatchEvent(new Event('jarvis:themechange'));
          syncAppearance();
        }
        function syncAppearance() {
          for (const button of gallery.children) button.setAttribute('aria-pressed', String(button.dataset.themeId === themeSelect.value));
          const current = T.getAccent();
          const light = getComputedStyle(document.documentElement).colorScheme === 'light';
          T.ACCENTS.forEach((a, i) => {
            const option = accRow.children[i];
            option.setAttribute('aria-pressed', String(current === a.id));
            option.firstElementChild.style.backgroundColor = (light ? a.light : a.dark) || '';
          });
          const info = T.getAccentInfo();
          colorPicker.value = info.applied || T.normHex(getComputedStyle(document.documentElement).getPropertyValue('--hue')) || '#808080';
          hex.removeAttribute('aria-invalid');
          hex.value = T.normHex(current) || '';
          hexStatus.textContent = hex.value && info.adjusted ? `С учётом контраста применён ${info.applied}` : '';
        }
        syncAppearance();

        // Эффект фона и своя картинка
        const look = typeof T.getLook === 'function' ? T.getLook() : {};
        const lookGrid = document.createElement('div');
        lookGrid.className = 'ae-workshop-grid ae-mt-sm';

        const fxSel = document.createElement('select');
        fxSel.className = 'ae-select';
        for (const [k, [lbl]] of Object.entries(T.FXS || {})) {
          const o = document.createElement('option');
          o.value = k;
          o.textContent = lbl;
          if (k === look.fx) o.selected = true;
          fxSel.append(o);
        }
        fxSel.addEventListener('change', () => {
          T.setLook({ fx: fxSel.value });
        });

        const blurSel = document.createElement('select');
        blurSel.className = 'ae-select';
        for (const [k, [lbl]] of Object.entries(T.BLURS || {})) {
          const o = document.createElement('option');
          o.value = k;
          o.textContent = lbl;
          if (k === look.blur) o.selected = true;
          blurSel.append(o);
        }
        blurSel.addEventListener('change', () => {
          T.setLook({ blur: blurSel.value });
        });

        function lookField(text, field) {
          const label = document.createElement('label');
          label.className = 'ae-field';
          label.append(text, field);
          return label;
        }
        const hasBackdrop = Boolean(window.NoxBackdrop?.has());
        const backgrounds = hasBackdrop ? T.BGS : { theme: T.BGS.theme, solid: T.BGS.solid };
        const background = makeLookSelect('bg', backgrounds, backgrounds[look.bg] ? look.bg : 'theme');
        const panels = makeLookSelect('panel', T.PANELS, look.panel);
        lookGrid.append(accent, lookField('Фон окна', background), lookField('Эффект фона', fxSel),
          lookField('Размытие панелей', blurSel), lookField('Плотность панелей', panels));
        lookGrid.append(lookField('Прозрачность окна', makeLookSelect('winAlpha', T.WIN_ALPHAS, look.winAlpha)));
        if (hasBackdrop) {
          lookGrid.append(lookField('Затемнение картинки', makeLookSelect('bgDim', T.BG_DIMS, look.bgDim)),
            lookField('Размытие картинки', makeLookSelect('bgBlur', T.BG_BLURS, look.bgBlur)));
        }
        colorPanel.append(lookGrid);

        // Своя картинка через NoxBackdrop
        if (window.NoxBackdrop) {
          const bgRow = document.createElement('div');
          bgRow.className = 'ae-head-actions ae-mt-sm';
          const fileInp = document.createElement('input');
          fileInp.type = 'file';
          fileInp.accept = 'image/png,image/jpeg,image/webp,image/gif';
          fileInp.hidden = true;
          fileInp.addEventListener('change', async () => {
            const f = fileInp.files && fileInp.files[0];
            if (!f) return;
            try {
              await window.NoxBackdrop.set(f);
              T.setLook({ bg: 'image' });
              store.toast('Фоновая картинка применена', 'ok');
              renderBody();
            } catch (err) {
              store.toast(err.message || 'Не удалось применить картинку', 'error');
            }
          });
          const pickBgBtn = document.createElement('button');
          pickBgBtn.type = 'button';
          pickBgBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
          pickBgBtn.textContent = 'Выбрать свою картинку фона…';
          pickBgBtn.addEventListener('click', () => fileInp.click());

          const clrBgBtn = document.createElement('button');
          clrBgBtn.type = 'button';
          clrBgBtn.className = 'ae-btn ae-btn-ghost ae-btn-sm';
          clrBgBtn.textContent = 'Убрать картинку';
          clrBgBtn.disabled = !window.NoxBackdrop.has();
          clrBgBtn.addEventListener('click', async () => {
            await window.NoxBackdrop.clear();
            T.setLook({ bg: 'theme' });
            renderBody();
          });

          const rstAllBtn = document.createElement('button');
          rstAllBtn.type = 'button';
          rstAllBtn.className = 'ae-btn ae-btn-ghost ae-btn-sm';
          rstAllBtn.textContent = 'Сбросить вид к теме';
          rstAllBtn.addEventListener('click', () => {
            T.resetToTheme();
            document.dispatchEvent(new Event('jarvis:themechange'));
            renderBody();
          });

          bgRow.append(fileInp, pickBgBtn, clrBgBtn, rstAllBtn);
          colorPanel.append(bgRow);
        }

        wrap.append(colorPanel);
      }

      function makeLookSelect(key, options, value) {
        const select = document.createElement('select');
        select.className = 'ae-select';
        select.dataset.look = key;
        for (const [id, [label, stack]] of Object.entries(options)) {
          const option = new Option(label, id);
          if ((key === 'ui' || key === 'head') && stack && stack !== 'ui') option.style.fontFamily = stack;
          select.add(option);
        }
        select.value = value;
        select.addEventListener('change', () => T.setLook({ [key]: select.value }));
        return select;
      }

      if ((group === 'appearance' || searchQuery) && T && matchesSearch('Типографика шрифты размер текста интерфейс заголовки ответы Inter Aptos IBM Plex Serif')) {
        const panel = makePanel('Шрифты');
        const look = T.getLook();
        const grid = document.createElement('div');
        grid.className = 'ae-workshop-grid ae-mt-sm';
        for (const [key, caption, options] of [
          ['ui', 'Интерфейс', T.FONTS.ui],
          ['head', 'Заголовки', T.FONTS.head],
          ['reply', 'Ответы в чате', { theme: ['Как в теме'], ui: ['Как интерфейс'], head: ['Как заголовки'] }],
          ['size', 'Размер текста', T.SIZES],
        ]) {
          const label = document.createElement('label');
          label.className = 'ae-field';
          label.append(caption, makeLookSelect(key, options, look[key]));
          grid.append(label);
        }
        const sample = document.createElement('div');
        sample.className = 'ae-type-sample';
        const title = document.createElement('strong');
        title.textContent = 'План на сегодня';
        const prose = document.createElement('span');
        prose.textContent = 'Проверил расписание. Следующая встреча в 15:00.';
        sample.append(title, prose);
        panel.append(sample, grid);
        wrap.append(panel);
      }

      // ── 4. Анимации и временный откат оболочки ──────────────────
      if ((group === 'window' || searchQuery) && matchesSearch('Анимации движение прошлый интерфейс откат legacy')) {
        const panel = makePanel('Движение и оболочка окна');
        panel.append(makeToggleRow(
          'Плавные анимации интерфейса и сфер',
          'Выключите для экономии заряда или строгого уменьшения движения.',
          store.state.settings.motion !== false,
          (v) => store.setSetting('motion', v)
        ));

        const rbRow = document.createElement('div');
        rbRow.className = 'ae-set-row';
        const rbTxt = document.createElement('div');
        rbTxt.className = 'ae-set-text';
        const rbh = document.createElement('strong');
        rbh.textContent = 'Прошлый интерфейс (временный откат)';
        const rbs = document.createElement('span');
        rbs.className = 'ae-item-meta';
        rbs.textContent = 'Переключиться на прежнее окно для сравнения или проверки.';
        rbTxt.append(rbh, rbs);
        const rbBtn = document.createElement('button');
        rbBtn.type = 'button';
        rbBtn.className = 'ae-btn ae-btn-ghost ae-btn-sm';
        rbBtn.textContent = 'Открыть прошлый вид';
        rbBtn.addEventListener('click', async () => {
          if (rbBtn.dataset.armed !== '1') {
            rbBtn.dataset.armed = '1';
            rbBtn.textContent = 'Точно переключить?';
            setTimeout(() => { rbBtn.dataset.armed = ''; rbBtn.textContent = 'Открыть прошлый вид'; }, 3500);
            return;
          }
          await store.setSetting('uiShell', 'legacy');
        });
        rbRow.append(rbTxt, rbBtn);
        panel.append(rbRow);
        wrap.append(panel);
      }

      return wrap;
    }

    function renderGeneral() {
      const wrap = document.createElement('div');
      const s = store.state.settings;
      wrap.className = 'ae-stack';

      if (matchesSearch('Подключённые папки доступ чтение запись рабочая папка')) {
        const p = makePanel('Подключённые папки', 'Папки, в которых Nox может искать и читать документы по вашему запросу.');
        const folders = Array.isArray(s.connectedFolders) ? s.connectedFolders : [];
        if (!folders.length) {
          const emp = document.createElement('p');
          emp.className = 'ae-muted';
          emp.textContent = 'Дополнительные папки не подключены.';
          p.append(emp);
        } else {
          for (const f of folders) {
            const row = document.createElement('div');
            row.className = 'ae-list-row';
            const txt = document.createElement('span');
            txt.className = 'ae-list-main';
            txt.textContent = f;
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'ae-btn ae-btn-ghost ae-btn-xs';
            rm.textContent = 'Убрать';
            rm.addEventListener('click', async () => {
              await bridge.call('removeFolder', f);
              await store.refreshSettings();
            });
            row.append(txt, rm);
            p.append(row);
          }
        }
        const btns = document.createElement('div');
        btns.className = 'ae-head-actions ae-mt-sm';
        const addF = document.createElement('button');
        addF.type = 'button';
        addF.className = 'ae-btn ae-btn-secondary ae-btn-sm';
        addF.textContent = '+ Подключить папку';
        addF.addEventListener('click', async () => {
          await bridge.call('addFolder');
          await store.refreshSettings();
        });
        const openWs = document.createElement('button');
        openWs.type = 'button';
        openWs.className = 'ae-btn ae-btn-ghost ae-btn-sm';
        openWs.textContent = 'Открыть рабочую папку';
        openWs.addEventListener('click', () => bridge.call('openWorkspace').catch(() => {}));
        btns.append(addF, openWs);
        p.append(btns);
        wrap.append(p);
      }

      if (matchesSearch('Поведение автозапуск поверх окон экран память краткие ответы стиль оформление оверлей буфер')) {
        const p = makePanel('Поведение и стиль ответов');
        const styleRow = document.createElement('label');
        styleRow.className = 'ae-field ae-mb-sm';
        const styleLbl = document.createElement('span');
        styleLbl.textContent = 'Оформление ответов в чате';
        const styleSel = document.createElement('select');
        styleSel.className = 'ae-select';
        for (const [k, t] of [
          ['rich', 'Выразительный (структура, формулы, акценты)'],
          ['notes', 'Конспект (пункты и итог)'],
          ['plain', 'Простой (короткий текст)'],
        ]) {
          const o = document.createElement('option');
          o.value = k;
          o.textContent = t;
          if ((s.replyStyle || 'rich') === k) o.selected = true;
          styleSel.append(o);
        }
        styleSel.addEventListener('change', async () => {
          await bridge.call('setReplyStyle', styleSel.value).catch(() => {});
          await store.refreshSettings();
        });
        styleRow.append(styleLbl, styleSel);
        p.append(styleRow);

        p.append(
          makeToggleRow('Автозапуск при входе в Windows', '', s.autoStart, (v) => store.setSetting('autoStart', v)),
          makeToggleRow('Окно поверх остальных окон', '', s.alwaysOnTop, (v) => store.setSetting('alwaysOnTop', v)),
          makeToggleRow('Мини-оверлей поверх других программ', '', s.desktopOverlay, (v) => store.setSetting('desktopOverlay', v)),
          makeToggleRow('Смотреть экран без отдельной просьбы', 'Только если вопрос связан с тем, что сейчас на экране.', s.screenAuto, (v) => store.setSetting('screenAuto', v)),
          makeToggleRow('Автоматически запоминать важное', '', s.memoryAuto !== false, (v) => store.setSetting('memoryAuto', v)),
          makeToggleRow('Краткие ответы по умолчанию', '', s.terseReplies !== false, (v) => store.setSetting('terseReplies', v)),
          makeToggleRow('Вести историю буфера обмена', '', s.clipboardHistory, (v) => store.setSetting('clipboardHistory', v))
        );
        wrap.append(p);
      }

      return wrap;
    }

    function voiceField(label, control, hint) {
      const field = document.createElement('label');
      field.className = 'ae-field ae-mt-sm';
      const name = document.createElement('span');
      name.textContent = label;
      field.append(name, control);
      if (hint) {
        const detail = document.createElement('span');
        detail.className = 'ae-item-meta';
        detail.textContent = hint;
        field.append(detail);
      }
      return field;
    }

    function voiceSelect(label, key, choices, fallback, hint) {
      const select = document.createElement('select');
      select.className = 'ae-select';
      for (const [id, title] of choices) select.add(new Option(title, id));
      select.value = store.state.settings[key] ?? fallback;
      select.addEventListener('change', () => store.setSetting(key, select.value));
      return voiceField(label, select, hint);
    }

    function voiceText(label, key, value, hint) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ae-input';
      input.value = Array.isArray(value) ? value.join(', ') : value;
      input.maxLength = 512;
      input.addEventListener('change', () => store.setSetting(key, input.value));
      if (key === 'wakeWords') input.id = 'lxWakeWordsInput';
      return voiceField(label, input, hint);
    }

    function speechButton(title, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ae-btn ae-btn-secondary ae-btn-sm';
      button.textContent = title;
      button.addEventListener('click', onClick);
      return button;
    }

    function voiceRange(label, key, fallback, min, max, format) {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = min;
      slider.max = max;
      slider.step = 0.05;
      slider.value = store.state.settings[key] ?? fallback;
      const value = document.createElement('output');
      value.textContent = format(Number(slider.value));
      slider.addEventListener('input', () => { value.textContent = format(Number(slider.value)); });
      slider.addEventListener('change', () => store.setSetting(key, Number(slider.value)));
      const field = voiceField(label, slider);
      field.append(value);
      return field;
    }

    async function previewVoice(status) {
      status.textContent = 'Воспроизводится…';
      const result = await bridge.call('voiceTest').catch(() => null);
      status.textContent = result?.ok ? 'Прослушивание завершилось.' : result?.error || 'Не удалось воспроизвести голос.';
    }

    async function fetchMicrophones(select, current) {
      const devices = await bridge.call('voiceMicrophones').catch(() => []);
      select.replaceChildren(new Option('По умолчанию в Windows', ''));
      for (const device of devices || []) select.add(new Option(device.title, device.id));
      if (current && !Array.from(select.options).some((item) => item.value === current)) {
        select.add(new Option('Выбранный микрофон', current));
      }
      select.value = current;
    }

    function renderVoiceInput() {
      const wrap = document.createElement('div');
      wrap.className = 'ae-stack';
      if (!matchesSearch('Голосовой ввод распознавание микрофон диктовка язык обращение префикс джарвис подтверждение')) return wrap;
      const s = store.state.settings;
      const panel = makePanel('Голосовой ввод');
      const modelRow = document.createElement('div');
      modelRow.className = 'ae-set-row';
      const modelStatus = document.createElement('span');
      modelStatus.className = 'ae-item-meta';
      modelStatus.setAttribute('role', 'status');
      modelStatus.textContent = s.speechModelInstalled ? 'Локальный движок готов' : 'Локальный движок нужен для работы без интернета';
      const download = speechButton('Скачать · 214 МБ', async () => {
        if (modelBusy) return;
        modelBusy = true;
        download.disabled = true;
        modelStatus.textContent = 'Начинаю загрузку…';
        const result = await bridge.call('voiceModelDownload').catch(() => null);
        modelBusy = false;
        modelStatus.textContent = result?.ok ? 'Локальный движок готов' : result?.error || 'Загрузка не удалась.';
        download.disabled = false;
        if (result?.ok) await store.refreshSettings();
      });
      download.hidden = s.speechModelInstalled === true;
      download.disabled = modelBusy;
      const folder = speechButton('Папка модели', async () => {
        const result = await bridge.call('voiceModelFolder').catch(() => null);
        if (result?.ok) await store.refreshSettings();
        else if (result?.error) modelStatus.textContent = result.error;
      });
      folder.title = s.sttModelFolder || 'Папка данных Nox';
      modelMessage = modelStatus;
      modelRow.append(modelStatus, download, folder);

      const mic = document.createElement('select');
      mic.className = 'ae-select';
      mic.add(new Option('По умолчанию в Windows', ''));
      mic.addEventListener('change', () => store.setSetting('microphone', mic.value));
      fetchMicrophones(mic, s.microphone || '');
      const modes = document.createElement('div');
      modes.className = 'ae-head-actions ae-voice-modes';
      modes.setAttribute('role', 'group');
      modes.setAttribute('aria-label', 'Режим микрофона');
      for (const [id, title] of [['listening', 'Слушаю'], ['quiet', 'Только имя'], ['off', 'Микрофон выкл']]) {
        const button = speechButton(title, async () => {
          await bridge.call('dictationMode', id).catch(() => {});
          await store.refreshDictation();
        });
        button.disabled = s.dictation === false;
        button.setAttribute('aria-pressed', String((store.state.dictation.mode || 'off') === id));
        modes.append(button);
      }
      panel.append(
        voiceSelect('Распознавание речи', 'sttEngine', [['auto', 'Авто'], ['local', 'Локальное'], ['cloud', 'Облачное']], 'auto',
          'В облачном режиме аудио отправляется настроенному сервису. При потере связи используется локальный движок.'),
        ...(s.sttEngine === 'auto' || !s.sttEngine ? [
          makeToggleRow('Разрешить облако в режиме «Авто»', s.speechCloudAvailable ? '' : 'Облачное распознавание пока не настроено',
            s.sttCloudAllowed, (value) => store.setSetting('sttCloudAllowed', value)),
        ] : []),
        modelRow,
        voiceSelect('Язык распознавания', 'sttLanguage', [['ru', 'Русский'], ['auto', 'Авто'], ['en', 'English']], 'ru',
          'Локальный движок поддерживает русский язык.'),
        voiceField('Микрофон', mic),
        ...(s.dictation === false ? [makeToggleRow('Включить голосовой ввод', '', false, (value) => store.setSetting('dictation', value))] : []),
        modes,
        makeToggleRow('Автовключение микрофона', '', s.alwaysListen, (value) => store.setSetting('alwaysListen', value)),
        voiceText('Обращение (префикс)', 'wakeWords', s.wakeWords ?? 'джарвис, жарвис, сэр',
          'Несколько вариантов через запятую. Пустое поле отключает требование обращаться по имени.'),
        makeToggleRow('Режим префикса', 'Для голосовой команды нужно обращение.', s.prefixMode, (value) => store.setSetting('prefixMode', value)),
        makeToggleRow('Оверлей команды', 'Показывает распознанную команду поверх окон.', s.commandOverlay !== false, (value) => store.setSetting('commandOverlay', value)),
        makeToggleRow('Диктовка в любое поле (Ctrl+Alt+D)', '', s.fieldDictation, (value) => store.setSetting('fieldDictation', value)),
        voiceText('Слова «да»', 'voiceYes', s.voiceYes ?? 'да, правильно, подтверждаю'),
        voiceText('Слова «нет»', 'voiceNo', s.voiceNo ?? 'нет, отмена, отменить'),
        voiceText('Связки голосовых команд', 'voiceLinkWords', s.voiceLinkWords ?? 'и, затем, потом, после этого')
      );
      wrap.append(panel);
      return wrap;
    }

    function renderVoiceOutput() {
      const wrap = document.createElement('div');
      wrap.className = 'ae-stack';
      if (!matchesSearch('Озвучка облачная голос ответы громкость тихий режим')) return wrap;
      const s = store.state.settings;
      const panel = makePanel('Озвучка');
      const cloud = s.voiceOutput === 'cloud';
      panel.append(voiceSelect('Режим озвучки', 'voiceOutput', [
        ['off', 'Выключена (по умолчанию)'], ['cloud', 'Облачная'],
      ], 'off', cloud ? 'Текст для озвучки передаётся в облако. Ответы остаются в чате.' : 'Ответы всегда остаются в чате.'));
      if (cloud) {
        const status = document.createElement('p');
        status.className = 'ae-item-meta';
        status.setAttribute('role', 'status');
        if (!s.voiceCloudAvailable) status.textContent = 'Облачная озвучка не настроена.';
        const actions = document.createElement('div');
        actions.className = 'ae-head-actions ae-mt-sm';
        const preview = speechButton('Проверить озвучку', () => previewVoice(status));
        preview.disabled = !s.voiceCloudAvailable || s.quiet;
        actions.append(preview);
        panel.append(
          makeToggleRow('Тихий режим', '', s.quiet, (value) => store.setSetting('quiet', value)),
          voiceRange('Громкость речи', 'voiceVolume', 0.8, 0, 1, (value) => Math.round(value * 100) + '%'),
          actions,
          status,
        );
      }
      wrap.append(panel);
      return wrap;
    }

    function renderBody() {
      for (const [id, b] of tabBtns.entries()) {
        const active = !searchQuery && id === section;
        b.classList.toggle('is-active', active);
        if (active) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
      }
      destroyPreview();
      body.replaceChildren();
      if (searchQuery) {
        const heading = document.createElement('h2');
        heading.className = 'ae-section-heading';
        heading.textContent = 'Результаты поиска';
        body.append(heading);
        const matches = [renderWorkshop(section), renderGeneral(), renderVoiceInput(), renderVoiceOutput()].filter((group) => group.childElementCount > 0);
        if (matches.length) body.append(...matches);
        else {
          const empty = document.createElement('p');
          empty.className = 'ae-empty-pane';
          empty.textContent = 'Настройки не найдены. Попробуйте другой запрос.';
          empty.setAttribute('role', 'status');
          body.append(empty);
        }
      } else if (['workshop', 'window', 'appearance'].includes(section)) body.append(renderWorkshop(section));
      else if (section === 'general') body.append(renderGeneral());
      else if (section === 'voice') body.append(renderVoiceInput());
      else if (section === 'speech') body.append(renderVoiceOutput());
    }

    async function loadQuickHotkey() {
      try {
        if (!bridge.has('quickHotkey')) {
          quickHotkeyText = 'Не определено';
          return;
        }
        const r = await bridge.call('quickHotkey');
        quickHotkeyText = (r && r.accelerator) ? `${r.accelerator}${r.ok === false ? ' (занята другой программой)' : ''}` : 'По умолчанию';
      } catch {
        quickHotkeyText = 'Не определено';
      }
    }

    function buildRenderSig(st) {
      const s = st.settings || {};
      const snap = lib ? lib.getSnapshot() : null;
      return [
        section,
        searchQuery,
        snap ? snap.activeId : '',
        document.documentElement.dataset.theme || '',
        typeof T?.getAccent === 'function' ? T.getAccent() : '',
        quickHotkeyText,
        s.sttEngine, s.sttLanguage, s.sttCloudAllowed, s.speechCloudAvailable, s.speechModelInstalled,
        s.sttModelFolder, s.microphone, s.commandOverlay, s.voiceYes, s.voiceNo, s.voiceLinkWords,
        s.voiceOutput, s.voiceCloudAvailable, s.quiet,
        (s.connectedFolders || []).join('|'),
        s.motion !== false ? '1' : '0',
        s.autoStart ? '1' : '0',
        s.alwaysOnTop ? '1' : '0',
        s.screenAuto ? '1' : '0',
        s.memoryAuto !== false ? '1' : '0',
        s.terseReplies !== false ? '1' : '0',
        s.clipboardHistory ? '1' : '0',
        s.dictation ? '1' : '0',
        s.alwaysListen ? '1' : '0',
        s.prefixMode ? '1' : '0',
        Array.isArray(s.wakeWords) ? s.wakeWords.join('|') : String(s.wakeWords || ''),
        s.fieldDictation ? '1' : '0',
        s.replyStyle || '',
        s.voiceVolume ?? '',
        s.desktopOverlay ? '1' : '0',
        st.dictation ? st.dictation.mode : '',
      ].join('::');
    }

    function render(st) {
      const show = st.route === 'settings';
      const wasHidden = root.hidden;
      root.hidden = !show;
      if (!show) {
        lastSig = '';
        destroyPreview();
        return;
      }
      if (wasHidden && !quickHotkeyText) loadQuickHotkey().then(() => { if (!root.hidden) render(store.state); });
      const sig = buildRenderSig(st);
      if (wasHidden || sig !== lastSig) {
        lastSig = sig;
        renderBody();
      }
    }

    return {
      el: root,
      openVoiceSettings: (target = 'voice') => {
        section = target === 'speech' ? 'speech' : 'voice';
        clearSearch();
        root.scrollTop = 0;
        lastSig = '';
        store.setRoute('settings');
        render(store.state);
        tabBtns.get(section).focus();
      },
      render,
      destroy: () => {
        unsubLib();
        unsubModelProgress?.();
        destroyPreview();
      },
    };
  }

  window.NoxAetherSettingsView = { createSettingsView };
})();
