/* Раздел «Настройки» и «Мастерская Nox» Nox Aether:
 * - поиск по параметрам и 3 понятных категории: «Мастерская Nox», «Основные и доступ», «Голос и диктовка»;
 * - единая «Библиотека сфер» (сохраняет обе существующие системы NoxOrb и JarvisOrb и все их варианты без визуальных правок);
 * - независимые настройки для каждой сферы, пресеты и сброс без потери параметров при переключении;
 * - шрифт подписи «The Nox» (IBM Plex Serif, Times New Roman, Georgia, Sitka), 24 темы + акцент, свой фон и 9 эффектов;
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

    let section = 'workshop'; // 'workshop' | 'general' | 'voice'
    let searchQuery = '';
    let voicesLoaded = false;
    let voicesList = [];
    let quickHotkeyText = '';
    let previewHandle = null;
    let previewOrbId = null;

    const head = document.createElement('div');
    head.className = 'ae-page-head';
    const tw = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.className = 'ae-page-title';
    h1.textContent = 'Настройки и Мастерская Nox';
    const sub = document.createElement('p');
    sub.className = 'ae-page-sub';
    sub.textContent = 'Живой выбор сферы, оформление окна, правила доступа, папки и голосовые функции.';
    tw.append(h1, sub);

    const searchInp = document.createElement('input');
    searchInp.type = 'search';
    searchInp.className = 'ae-input ae-search-wide';
    searchInp.placeholder = 'Поиск по настройкам…';
    searchInp.addEventListener('input', () => {
      searchQuery = searchInp.value.trim().toLowerCase();
      renderBody();
    });
    head.append(tw, searchInp);

    const tabs = document.createElement('div');
    tabs.className = 'ae-subtabs';
    const SEC_DEFS = [
      ['workshop', 'Мастерская Nox'],
      ['general', 'Основные и доступ'],
      ['voice', 'Голос и диктовка'],
    ];
    const tabBtns = new Map();
    for (const [id, label] of SEC_DEFS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ae-subtab';
      b.textContent = label;
      b.addEventListener('click', () => {
        section = id;
        renderBody();
      });
      tabs.append(b);
      tabBtns.set(id, b);
    }

    const body = document.createElement('div');
    body.className = 'ae-settings-body';

    root.append(head, tabs, body);

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
      if (root.hidden || section !== 'workshop') return;
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
      return (`${title} ${desc}`).toLowerCase().includes(searchQuery);
    }

    function makePanel(title, desc = '') {
      const panel = document.createElement('div');
      panel.className = 'ae-panel';
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
      inp.checked = Boolean(checked);
      inp.addEventListener('change', () => onChange(inp.checked));
      row.append(txt, inp);
      return row;
    }

    function renderWorkshop() {
      const wrap = document.createElement('div');
      wrap.className = 'ae-stack';

      // ── 1. Библиотека сфер + Живой предпросмотр ────────────────
      if (lib && matchesSearch('Библиотека сфер сфера вариант пресет Nox Jarvis Контур Точечный Ядро Диафрагма')) {
        const snap = lib.getSnapshot();
        const activeSpec = snap.activeSpec;
        const activeCfg = snap.activeSettings;

        const panel = makePanel(
          'Библиотека сфер',
          'Обе системы визуализации сохранены полностью. Настройки и пресеты каждой сферы запоминаются отдельно.'
        );
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
      if (boot && matchesSearch('The Nox подпись шрифт Times New Roman IBM Plex Serif композиция ширина сфера положение')) {
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
      if (T && matchesSearch('Тема палитра акцент фон эффект звёзды дождь снег своя картинка прозрачность')) {
        const panel = makePanel('Тема, фон и эффекты', 'Все палитры и эффекты работают локально, без обращения в сеть.');

        // Сетка тем
        const curTheme = document.documentElement.dataset.theme || 'dark';
        const themeGrid = document.createElement('div');
        themeGrid.className = 'ae-theme-chips';
        for (const id of T.IDS) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = curTheme === id ? 'ae-subtab is-active' : 'ae-subtab';
          b.textContent = THEME_LABELS[id] || id;
          b.addEventListener('click', () => {
            try {
              if (boot) localStorage.setItem(boot.THEME_CHOSEN_KEY, '1');
              localStorage.setItem('jarvis.theme', id);
            } catch { /* ignore */ }
            T.apply(id);
            document.dispatchEvent(new Event('jarvis:themechange'));
            renderBody();
          });
          themeGrid.append(b);
        }
        panel.append(themeGrid);

        // Акцент
        const accRow = document.createElement('div');
        accRow.className = 'ae-chips-row ae-mt-sm';
        const curAcc = typeof T.getAccent === 'function' ? T.getAccent() : 'theme';
        for (const a of T.ACCENTS) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = curAcc === a.id ? 'ae-subtab is-active' : 'ae-subtab';
          b.textContent = a.name;
          b.addEventListener('click', () => {
            if (typeof T.setAccent === 'function') T.setAccent(a.id);
            document.dispatchEvent(new Event('jarvis:themechange'));
            renderBody();
          });
          accRow.append(b);
        }
        panel.append(accRow);

        // Эффект фона и своя картинка
        const look = typeof T.getLook === 'function' ? T.getLook() : {};
        const lookGrid = document.createElement('div');
        lookGrid.className = 'ae-workshop-grid ae-mt-sm';

        const fxSel = document.createElement('select');
        fxSel.className = 'ae-select';
        for (const [k, [lbl]] of Object.entries(T.FXS || {})) {
          const o = document.createElement('option');
          o.value = k;
          o.textContent = `Эффект: ${lbl}`;
          if (k === look.fx) o.selected = true;
          fxSel.append(o);
        }
        fxSel.addEventListener('change', () => {
          T.setLook({ fx: fxSel.value });
          renderBody();
        });

        const blurSel = document.createElement('select');
        blurSel.className = 'ae-select';
        for (const [k, [lbl]] of Object.entries(T.BLURS || {})) {
          const o = document.createElement('option');
          o.value = k;
          o.textContent = `Размытие: ${lbl}`;
          if (k === look.blur) o.selected = true;
          blurSel.append(o);
        }
        blurSel.addEventListener('change', () => {
          T.setLook({ blur: blurSel.value });
          renderBody();
        });

        lookGrid.append(fxSel, blurSel);
        panel.append(lookGrid);

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
            renderBody();
          });

          bgRow.append(fileInp, pickBgBtn, clrBgBtn, rstAllBtn);
          panel.append(bgRow);
        }

        wrap.append(panel);
      }

      // ── 4. Анимации и временный откат оболочки ──────────────────
      if (matchesSearch('Анимации движение прошлый интерфейс откат legacy')) {
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

    function renderVoice() {
      const wrap = document.createElement('div');
      const s = store.state.settings;
      wrap.className = 'ae-stack';

      if (matchesSearch('Голос озвучка ответы диктовка микрофон прослушивание громкость скорость характер режим')) {
        const p = makePanel('Речь и распознавание голоса');
        p.append(
          makeToggleRow('Озвучивать ответы ассистента', '', s.voice, (v) => store.setSetting('voice', v)),
          makeToggleRow('Голосовой ввод в чат (диктовка)', '', s.dictation, (v) => store.setSetting('dictation', v)),
          makeToggleRow('Всегда слушать обращение «Джарвис»', '', s.alwaysListen, (v) => store.setSetting('alwaysListen', v)),
          makeToggleRow('Диктовка в любое поле (Ctrl+Alt+D)', '', s.fieldDictation, (v) => store.setSetting('fieldDictation', v))
        );

        // Режим микрофона (Слушаю / Только имя / Выкл)
        const curDictMode = (store.state.dictation && store.state.dictation.mode) || 'off';
        const modeWrap = document.createElement('div');
        modeWrap.className = 'ae-field ae-mt-sm';
        const modeLbl = document.createElement('span');
        modeLbl.textContent = 'Режим микрофона';
        const modeRow = document.createElement('div');
        modeRow.className = 'ae-chips-row';
        for (const [mId, mTitle] of [
          ['listening', 'Слушаю'],
          ['quiet', 'Только имя «Джарвис»'],
          ['off', 'Выключен'],
        ]) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = curDictMode === mId ? 'ae-subtab is-active' : 'ae-subtab';
          b.textContent = mTitle;
          b.disabled = !s.dictation;
          b.addEventListener('click', async () => {
            await bridge.call('dictationMode', mId).catch(() => {});
            if (typeof store.refreshDictation === 'function') await store.refreshDictation();
            renderBody();
          });
          modeRow.append(b);
        }
        modeWrap.append(modeLbl, modeRow);
        p.append(modeWrap);

        // Характер речи + Громкость + Скорость (как в конкурентах)
        const personaRow = document.createElement('label');
        personaRow.className = 'ae-field ae-mt-sm';
        const personaLbl = document.createElement('span');
        personaLbl.textContent = 'Характер речи';
        const personaSel = document.createElement('select');
        personaSel.className = 'ae-select';
        for (const [pId, pTitle] of [
          ['neutral', 'Как есть (из ручек ниже)'],
          ['butler', 'Дворецкий (спокойнее, 0.95×)'],
          ['assistant', 'Помощница (ровно, 1.00×)'],
          ['engineer', 'Инженер (чётче, 1.05×)'],
        ]) {
          const o = document.createElement('option');
          o.value = pId;
          o.textContent = pTitle;
          if ((s.voicePersona || 'neutral') === pId) o.selected = true;
          personaSel.append(o);
        }
        personaSel.addEventListener('change', () => store.setSetting('voicePersona', personaSel.value));
        personaRow.append(personaLbl, personaSel);
        p.append(personaRow);

        const voiceGrid = document.createElement('div');
        voiceGrid.className = 'ae-workshop-grid ae-mt-sm';

        const mkVoiceRange = (label, val, min, max, step, fmt, onCommit) => {
          const box = document.createElement('div');
          box.className = 'ae-range-row';
          const hdr = document.createElement('div');
          hdr.className = 'ae-range-head';
          const lbl = document.createElement('span');
          lbl.textContent = label;
          const vEl = document.createElement('span');
          vEl.className = 'ae-range-val';
          vEl.textContent = fmt(val);
          hdr.append(lbl, vEl);
          const rng = document.createElement('input');
          rng.type = 'range';
          rng.min = String(min);
          rng.max = String(max);
          rng.step = String(step);
          rng.value = String(val);
          rng.addEventListener('input', () => { vEl.textContent = fmt(Number(rng.value)); });
          rng.addEventListener('change', () => onCommit(Number(rng.value)));
          box.append(hdr, rng);
          return box;
        };

        const curVol = Number.isFinite(Number(s.voiceVolume)) ? Number(s.voiceVolume) : 1;
        const curRate = Number.isFinite(Number(s.voiceRate)) ? Number(s.voiceRate) : 1;
        voiceGrid.append(
          mkVoiceRange('Громкость речи', curVol, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => store.setSetting('voiceVolume', v)),
          mkVoiceRange('Скорость речи', curRate, 0.5, 2, 0.05, (v) => `${v.toFixed(2)}×`, (v) => store.setSetting('voiceRate', v))
        );
        p.append(voiceGrid);

        const rowTest = document.createElement('div');
        rowTest.className = 'ae-head-actions ae-mt-sm';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
        testBtn.textContent = 'Прослушать голос';
        testBtn.addEventListener('click', () => bridge.call('voiceTest').catch(() => {}));

        const loadVBtn = document.createElement('button');
        loadVBtn.type = 'button';
        loadVBtn.className = 'ae-btn ae-btn-ghost ae-btn-sm';
        loadVBtn.textContent = voicesLoaded ? `Голосов найдено: ${voicesList.length}` : 'Показать доступные голоса';
        loadVBtn.addEventListener('click', async () => {
          const r = await bridge.call('voiceVoices').catch(() => null);
          voicesLoaded = true;
          voicesList = r && r.ok && Array.isArray(r.voices) ? r.voices : [];
          renderBody();
        });
        rowTest.append(testBtn, loadVBtn);
        p.append(rowTest);

        if (voicesLoaded && voicesList.length) {
          const vSel = document.createElement('select');
          vSel.className = 'ae-select ae-mt-sm';
          for (const v of voicesList) {
            const o = document.createElement('option');
            o.value = v.id;
            o.textContent = v.title || v.id;
            if (v.id === s.voiceSpeaker) o.selected = true;
            vSel.append(o);
          }
          vSel.addEventListener('change', () => store.setSetting('voiceSpeaker', vSel.value));
          p.append(vSel);
        }

        wrap.append(p);
      }

      if (matchesSearch('Быстрое окно горячая клавиша вызов чат')) {
        const p = makePanel('Быстрое окно вызова');
        const row = document.createElement('div');
        row.className = 'ae-set-row';
        const txt = document.createElement('div');
        txt.className = 'ae-set-text';
        const nm = document.createElement('strong');
        nm.textContent = 'Сочетание клавиш быстрого окна';
        const h = document.createElement('span');
        h.className = 'ae-item-meta';
        h.textContent = quickHotkeyText || 'Загружается…';
        txt.append(nm, h);
        row.append(txt);
        p.append(row);
        wrap.append(p);
      }

      return wrap;
    }

    function renderBody() {
      for (const [id, b] of tabBtns.entries()) {
        b.classList.toggle('is-active', id === section);
        b.setAttribute('aria-pressed', String(id === section));
      }
      if (section !== 'workshop') destroyPreview();
      body.replaceChildren();
      if (section === 'workshop') body.append(renderWorkshop());
      else if (section === 'general') body.append(renderGeneral());
      else if (section === 'voice') body.append(renderVoice());
    }

    async function loadQuickHotkey() {
      if (!bridge.has('quickHotkey')) return;
      try {
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
        voicesLoaded ? voicesList.length : 0,
        (s.connectedFolders || []).join('|'),
        s.motion !== false ? '1' : '0',
        s.autoStart ? '1' : '0',
        s.alwaysOnTop ? '1' : '0',
        s.screenAuto ? '1' : '0',
        s.memoryAuto !== false ? '1' : '0',
        s.terseReplies !== false ? '1' : '0',
        s.clipboardHistory ? '1' : '0',
        s.voice ? '1' : '0',
        s.dictation ? '1' : '0',
        s.alwaysListen ? '1' : '0',
        s.fieldDictation ? '1' : '0',
        s.voiceSpeaker || '',
        s.replyStyle || '',
        s.voicePersona || '',
        s.voiceVolume ?? '',
        s.voiceRate ?? '',
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
      if (!quickHotkeyText) loadQuickHotkey().then(() => { if (!root.hidden) { lastSig = ''; render(store.state); } });
      const sig = buildRenderSig(st);
      if (wasHidden || sig !== lastSig) {
        lastSig = sig;
        renderBody();
      }
    }

    return {
      el: root,
      render,
      destroy: () => {
        unsubLib();
        destroyPreview();
      },
    };
  }

  window.NoxAetherSettingsView = { createSettingsView };
})();
