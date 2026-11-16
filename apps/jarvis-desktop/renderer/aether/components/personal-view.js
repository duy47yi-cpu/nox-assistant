/* Раздел «Главная» (в маршруте personal):
 * - Карточка «История команд» с синими и приглушёнными вертикальными маркерами;
 * - Карточка «Панель управления»: 4 тумблера (34x18) и слайдер громкости с процентом;
 * - Ненавязчивый переход к рабочим столам, памяти и журналу, чтобы ничего не терялось. */
(() => {
  'use strict';

  function createPersonalView({ store, bridge }) {
    const { icon } = window.NoxAetherIcons;

    const root = document.createElement('section');
    root.id = 'aePersonalView';
    root.className = 'ae-page lx-main-page';
    root.hidden = true;
    root.setAttribute('aria-label', 'Главная');

    const stage = document.createElement('div');
    stage.className = 'lx-main-stage';

    const col = document.createElement('div');
    col.className = 'lx-main-col';

    // ── 1. Карточка «История команд» ─────────────────────────────
    const histCard = document.createElement('div');
    histCard.className = 'lx-card';

    const histTitle = document.createElement('h2');
    histTitle.className = 'lx-card-title';
    histTitle.textContent = 'История команд';

    const histFeed = document.createElement('div');
    histFeed.id = 'lxCommandHistoryFeed';
    histFeed.className = 'lx-history-feed';

    histCard.append(histTitle, histFeed);

    // ── 2. Карточка «Панель управления» ──────────────────────────
    const ctrlCard = document.createElement('div');
    ctrlCard.className = 'lx-card';

    const ctrlTitle = document.createElement('h2');
    ctrlTitle.className = 'lx-card-title';
    ctrlTitle.textContent = 'Панель управления';

    const ctrlList = document.createElement('div');
    ctrlList.className = 'lx-ctrl-list';

    function makeToggleRow(id, labelText, checkedInitial, onToggle) {
      const row = document.createElement('label');
      row.className = 'lx-ctrl-row';
      row.htmlFor = id;

      const label = document.createElement('span');
      label.className = 'lx-ctrl-label';
      label.textContent = labelText;

      const wrap = document.createElement('span');
      wrap.className = 'lx-toggle-wrap';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.className = 'lx-toggle-input';
      input.checked = Boolean(checkedInitial);
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-checked', String(Boolean(checkedInitial)));

      const track = document.createElement('span');
      track.className = 'lx-toggle-track';

      input.addEventListener('change', () => {
        input.setAttribute('aria-checked', String(input.checked));
        onToggle(input.checked);
      });

      wrap.append(input, track);
      row.append(label, wrap);
      return { row, input };
    }

    async function persistSetting(key, val) {
      if (store && typeof store.setSetting === 'function') {
        await store.setSetting(key, val);
        return;
      }
      if (bridge && bridge.has('setSetting')) {
        try {
          await bridge.call('setSetting', key, val);
        } catch {}
      }
    }

    const prefixToggle = makeToggleRow('lxCtrlPrefix', 'Режим префикса', false, (v) => {
      persistSetting('prefixMode', v);
    });
    prefixToggle.row.title = 'Команды срабатывают только с обращением «Джарвис»';
    const quietToggle = makeToggleRow('lxCtrlQuiet', 'Тихий режим', false, (v) => {
      persistSetting('quiet', v);
    });
    const motionToggle = makeToggleRow('lxCtrlAvatarAnim', 'Анимация аватара', true, (v) => {
      persistSetting('motion', v);
    });
    const onTopToggle = makeToggleRow('lxCtrlAlwaysTop', 'Окно поверх', false, (v) => {
      persistSetting('alwaysOnTop', v);
    });

    // Строка слайдера громкости
    const volRow = document.createElement('div');
    volRow.className = 'lx-ctrl-row lx-ctrl-slider-row';

    const volLabel = document.createElement('label');
    volLabel.className = 'lx-ctrl-label';
    volLabel.htmlFor = 'lxCtrlVolume';
    volLabel.textContent = 'Громкость';

    const volControl = document.createElement('div');
    volControl.className = 'lx-slider-box';

    const volRange = document.createElement('input');
    volRange.id = 'lxCtrlVolume';
    volRange.type = 'range';
    volRange.min = '0';
    volRange.max = '100';
    volRange.step = '1';
    volRange.value = '80';
    volRange.className = 'lx-slider';

    const volPct = document.createElement('span');
    volPct.id = 'lxCtrlVolumePct';
    volPct.className = 'lx-slider-val';
    volPct.textContent = '80%';

    function syncSliderFill(val) {
      const n = Math.max(0, Math.min(100, Number(val) || 0));
      volRange.value = String(n);
      volRange.style.setProperty('--pct', `${n}%`);
      volPct.textContent = `${n}%`;
    }

    volRange.addEventListener('input', () => {
      syncSliderFill(volRange.value);
    });
    volRange.addEventListener('change', () => {
      const n = Math.max(0, Math.min(100, Number(volRange.value) || 0));
      syncSliderFill(n);
      persistSetting('voiceVolume', n / 100);
    });

    syncSliderFill(80);
    volControl.append(volRange, volPct);
    volRow.append(volLabel, volControl);

    ctrlList.append(
      prefixToggle.row,
      quietToggle.row,
      motionToggle.row,
      onTopToggle.row,
      volRow
    );
    ctrlCard.append(ctrlTitle, ctrlList);

    // ── Скрываемый блок рабочих столов и журнала (сохранение прежней функциональности) ─
    const extraToggleBtn = document.createElement('button');
    extraToggleBtn.type = 'button';
    extraToggleBtn.className = 'lx-subtle-link';
    extraToggleBtn.append(icon('layers'), document.createTextNode('Столы, память и журнал'));

    const extraDrawer = document.createElement('div');
    extraDrawer.className = 'lx-card lx-extra-drawer';
    extraDrawer.hidden = true;

    const extraHead = document.createElement('div');
    extraHead.className = 'lx-extra-head';
    const extraTitle = document.createElement('strong');
    extraTitle.textContent = 'Рабочее пространство';
    const extraRefresh = document.createElement('button');
    extraRefresh.type = 'button';
    extraRefresh.className = 'lx-pill-btn lx-pill-ghost';
    extraRefresh.textContent = 'Обновить';
    extraHead.append(extraTitle, extraRefresh);

    const extraGrid = document.createElement('div');
    extraGrid.className = 'lx-extra-grid';
    extraDrawer.append(extraHead, extraGrid);

    extraToggleBtn.addEventListener('click', () => {
      extraDrawer.hidden = !extraDrawer.hidden;
      if (!extraDrawer.hidden) load();
    });

    col.append(histCard, ctrlCard, extraToggleBtn, extraDrawer);

    // Декоративные концентрические кольца на правой стороне
    const rings = document.createElement('div');
    rings.className = 'lx-bg-rings';
    rings.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i += 1) {
      const circle = document.createElement('span');
      circle.className = `lx-bg-ring lx-bg-ring-${i + 1}`;
      rings.append(circle);
    }

    stage.append(col, rings);
    root.append(stage);

    function renderHistory(entries) {
      const items = [
        { text: 'Добро пожаловать в Nox Assistant!', accent: true },
      ];
      if (Array.isArray(entries) && entries.length) {
        for (const item of entries.slice(0, 4)) {
          const line = item.summary || item.text || item.tool || '';
          if (line) items.push({ text: String(line), accent: false });
        }
      } else {
        items.push({ text: 'Команды ещё не выполнялись', accent: false });
      }
      histFeed.replaceChildren(...items.map((row) => {
        const div = document.createElement('div');
        div.className = row.accent ? 'lx-history-row is-accent' : 'lx-history-row';
        div.textContent = row.text;
        return div;
      }));
    }

    renderHistory([]);

    async function load() {
      const [settings, journal, desks, mem] = await Promise.all([
        bridge.has('getSettings') ? bridge.call('getSettings').catch(() => ({})) : {},
        bridge.has('recentJournal') ? bridge.call('recentJournal', 6).catch(() => []) : [],
        bridge.has('desksList') ? bridge.call('desksList', store.state.activeWorkspace || 'default').catch(() => null) : null,
        bridge.has('memoryList') ? bridge.call('memoryList', { workspaceId: store.state.activeWorkspace || 'default' }).catch(() => []) : [],
      ]);

      if (settings && typeof settings === 'object') {
        prefixToggle.input.checked = Boolean(settings.prefixMode);
        prefixToggle.input.setAttribute('aria-checked', String(prefixToggle.input.checked));
        quietToggle.input.checked = Boolean(settings.quiet);
        quietToggle.input.setAttribute('aria-checked', String(quietToggle.input.checked));
        const animOn = settings.motion !== false;
        motionToggle.input.checked = animOn;
        motionToggle.input.setAttribute('aria-checked', String(animOn));
        onTopToggle.input.checked = Boolean(settings.alwaysOnTop);
        onTopToggle.input.setAttribute('aria-checked', String(onTopToggle.input.checked));
        if (typeof settings.voiceVolume === 'number' && !Number.isNaN(settings.voiceVolume)) {
          const pct = settings.voiceVolume <= 1 ? Math.round(settings.voiceVolume * 100) : Math.round(settings.voiceVolume);
          syncSliderFill(pct);
        }
      }

      renderHistory(Array.isArray(journal) ? journal : []);

      if (!extraDrawer.hidden) {
        const desksCount = Array.isArray(desks?.desks) ? desks.desks.length : 0;
        const memCount = Array.isArray(mem) ? mem.length : 0;
        const cards = [
          { title: 'Рабочие столы', meta: `${desksCount} конфиг.` },
          { title: 'Память', meta: `${memCount} записей` },
          { title: 'Журнал', meta: `${Array.isArray(journal) ? journal.length : 0} событий` },
        ];
        extraGrid.replaceChildren(...cards.map((c) => {
          const box = document.createElement('div');
          box.className = 'lx-extra-stat';
          const bTitle = document.createElement('div');
          bTitle.className = 'lx-extra-stat-title';
          bTitle.textContent = c.title;
          const bMeta = document.createElement('div');
          bMeta.className = 'lx-hint';
          bMeta.textContent = c.meta;
          box.append(bTitle, bMeta);
          return box;
        }));
      }
    }

    extraRefresh.addEventListener('click', load);

    let wasActive = false;
    function render(st) {
      const active = st.route === 'personal';
      root.hidden = !active;
      if (typeof st.motion === 'boolean') {
        motionToggle.input.checked = st.motion;
        motionToggle.input.setAttribute('aria-checked', String(st.motion));
      }
      if (active && !wasActive) load();
      wasActive = active;
    }

    return {
      el: root,
      load,
      render,
    };
  }

  window.NoxAetherPersonalView = { createPersonalView };
})();
