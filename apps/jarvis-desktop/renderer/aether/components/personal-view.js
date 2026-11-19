/* «Главная»: сессия, голосовая сцена, диалог и быстрые настройки. */
(() => {
  'use strict';

  function createPersonalView({ store, bridge, openConversation }) {
    const { icon } = window.NoxAetherIcons;
    const { scrub } = window.JarvisUI;

    const root = document.createElement('section');
    root.id = 'aePersonalView';
    root.className = 'ae-page lx-main-page';
    root.hidden = true;
    root.setAttribute('aria-label', 'Главная');

    const stage = document.createElement('div');
    stage.className = 'lx-main-stage';

    const layout = document.createElement('div');
    layout.className = 'lx-home-layout';

    const col = document.createElement('section');
    col.className = 'lx-main-col';

    const sessionTitle = document.createElement('h2');
    sessionTitle.className = 'lx-home-label';
    sessionTitle.append(icon('clock'), document.createTextNode('Сессия'));

    const sessionTime = document.createElement('div');
    sessionTime.className = 'lx-home-timer';
    sessionTime.setAttribute('role', 'timer');
    sessionTime.setAttribute('aria-label', 'Время сессии');
    const sessionStart = Date.now();
    let sessionTicker = null;
    function updateSessionTime() {
      const seconds = Math.max(0, Math.floor((Date.now() - sessionStart) / 1000));
      sessionTime.textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map((part) => String(part).padStart(2, '0')).join(':');
    }

    const histTitle = document.createElement('h2');
    histTitle.className = 'lx-home-label';
    histTitle.append(icon('history'), document.createTextNode('История команд'));

    const histFeed = document.createElement('div');
    histFeed.id = 'lxCommandHistoryFeed';
    histFeed.className = 'lx-history-feed';

    col.append(sessionTitle, sessionTime, histTitle, histFeed);

    const ctrlCard = document.createElement('details');
    ctrlCard.className = 'lx-home-controls';

    const ctrlTitle = document.createElement('summary');
    ctrlTitle.className = 'lx-subtle-link';
    ctrlTitle.append(icon('sliders'), document.createTextNode('Управление'));

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
    extraToggleBtn.setAttribute('aria-expanded', 'false');
    extraToggleBtn.append(icon('layers'), document.createTextNode('Столы, память и журнал'));

    const extraDrawer = document.createElement('div');
    extraDrawer.className = 'lx-card lx-extra-drawer';
    extraDrawer.id = 'lxHomeWorkspace';
    extraDrawer.hidden = true;
    extraToggleBtn.setAttribute('aria-controls', extraDrawer.id);

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
      extraToggleBtn.setAttribute('aria-expanded', String(!extraDrawer.hidden));
      if (!extraDrawer.hidden) load();
    });

    const footer = document.createElement('footer');
    footer.className = 'lx-home-footer';
    footer.append(ctrlCard, extraToggleBtn);

    const approvalHost = document.createElement('div');
    approvalHost.className = 'lx-home-approval';

    const orbHost = document.createElement('div');
    orbHost.className = 'lx-home-orb';

    const exchange = document.createElement('section');
    exchange.className = 'lx-home-exchange';
    const exchangeTitle = document.createElement('h2');
    exchangeTitle.className = 'lx-home-label';
    exchangeTitle.append(icon('chat'), document.createTextNode('Диалог'));
    const prompt = document.createElement('p');
    prompt.className = 'lx-home-prompt';
    const reply = document.createElement('p');
    reply.className = 'lx-home-reply';
    reply.setAttribute('role', 'status');

    const openChat = document.createElement('button');
    openChat.type = 'button';
    openChat.className = 'lx-subtle-link lx-home-open-chat';
    openChat.textContent = 'Открыть чат';
    openChat.addEventListener('click', openConversation);

    exchange.append(exchangeTitle, prompt, reply, openChat);
    layout.append(col, orbHost, exchange);
    stage.append(layout, approvalHost, footer, extraDrawer);
    root.append(stage);

    function renderExchange(st) {
      // Берём результат только после последней реплики владельца.
      const lastUser = st.historyLoading ? -1 : st.feedItems.findLastIndex((item) => item.kind === 'user');
      const question = lastUser === -1 ? '' : scrub(st.feedItems[lastUser].text || '').trim();
      const result = lastUser === -1 ? null : st.feedItems.slice(lastUser + 1)
        .findLast((item) => item.kind === 'assistant' || item.kind === 'error');
      let summary;
      if (st.approvals.queue.length) summary = 'Ждёт разрешения';
      else if (st.activeTurn && (st.trackerBusy || st.sendingLock)) summary = store.getLiveWorkText() || 'Обрабатываю запрос…';
      else if (result?.cancelled) summary = 'Остановлено';
      else if (result) summary = result.text || result.artifacts?.[0]?.title || 'Открыть результат можно в чате.';
      else if (st.historyLoading) summary = 'Загружаю историю…';
      else summary = question ? 'Ответ пока не получен' : 'Здесь появятся ваша реплика и ответ Nox.';

      const text = scrub(summary).trim();
      prompt.hidden = !question;
      if (prompt.textContent !== question) prompt.textContent = question;
      if (reply.textContent !== text) reply.textContent = text;
    }

    function renderHistory(entries) {
      const items = entries.map((item) => scrub(item.summary || item.text || '').trim()).filter(Boolean).slice(0, 3);
      if (!items.length) items.push('Команд пока нет');
      histFeed.replaceChildren(...items.map((text) => {
        const div = document.createElement('div');
        div.className = 'lx-history-row';
        div.textContent = text;
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
      if (active && !wasActive) {
        updateSessionTime();
        sessionTicker = setInterval(updateSessionTime, 1000);
        load();
      } else if (!active && wasActive) {
        clearInterval(sessionTicker);
        sessionTicker = null;
      }
      if (active) renderExchange(st);
      wasActive = active;
    }

    return {
      el: root,
      orbHost,
      approvalHost,
      load,
      render,
    };
  }

  window.NoxAetherPersonalView = { createPersonalView };
})();
