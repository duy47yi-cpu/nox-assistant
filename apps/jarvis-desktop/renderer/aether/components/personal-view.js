/* Раздел «Личное пространство» Nox Aether:
 * - «Рабочие столы»: вкладки столов, реальные виджеты (погода с городом, календарь, дела, новости, загрузки, место на диске);
 * - «Память и напоминания»: просмотр, редактирование, удаление памяти и отмена напоминаний;
 * - «Почта и календарь»: Gmail и источник календаря;
 * - «Журнал и расширения»: поиск по журналу, буфер обмена, быстрые вставки и уборка загрузок. */
(() => {
  'use strict';

  function fmtBytes(n) {
    if (!Number.isFinite(Number(n))) return '';
    const u = ['Б', 'КБ', 'МБ', 'ГБ'];
    let v = Math.max(0, Number(n));
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function createPersonalView({ store, bridge }) {
    const ui = window.JarvisUI || {};
    const { icon } = window.NoxAetherIcons;
    const scrub = typeof ui.scrub === 'function' ? ui.scrub : (s) => String(s || '');

    const root = document.createElement('section');
    root.className = 'ae-page ae-personal-page';
    root.id = 'aePersonalView';
    root.hidden = true;
    root.setAttribute('aria-label', 'Личное пространство');

    let subTab = 'desks';
    let desksPayload = null;
    let memoryItems = [];
    let remindersItems = [];
    let mailPayload = null;
    let calendarPayload = null;
    let journalEntries = [];
    let journalQuery = '';
    let clipItems = [];
    let clipPaused = false;
    let snippets = [];
    let dlAnalysis = null;
    let dlSelected = new Set();
    let loaded = false;
    let loading = false;
    let loadSeq = 0;

    const head = document.createElement('div');
    head.className = 'ae-page-head';
    const tw = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.className = 'ae-page-title';
    h1.textContent = 'Пространство';
    tw.append(h1);
    const refBtn = document.createElement('button');
    refBtn.type = 'button';
    refBtn.className = 'ae-btn ae-btn-ghost';
    refBtn.append(icon('refresh'), (() => { const s = document.createElement('span'); s.textContent = 'Обновить'; return s; })());
    refBtn.addEventListener('click', () => loadTabData(subTab));
    head.append(tw, refBtn);

    const tabs = document.createElement('div');
    tabs.className = 'ae-subtabs';
    const TAB_LIST = [
      ['desks', 'Столы и виджеты'],
      ['memory', 'Память и напоминания'],
      ['services', 'Почта и календарь'],
      ['journal', 'Журнал и утилиты'],
    ];
    const tabBtns = new Map();
    for (const [id, label] of TAB_LIST) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ae-subtab';
      b.textContent = label;
      b.addEventListener('click', () => {
        subTab = id;
        loadTabData(id);
      });
      tabs.append(b);
      tabBtns.set(id, b);
    }

    const body = document.createElement('div');
    body.className = 'ae-personal-body';

    root.append(head, tabs, body);

    async function loadTabData(tab) {
      loaded = true;
      const mySeq = ++loadSeq;
      loading = true;
      body.dataset.loading = '1';
      renderBody();
      if (tab === 'desks') {
        if (bridge.has('desksState')) {
          try { desksPayload = await bridge.call('desksState'); } catch { desksPayload = null; }
        }
      } else if (tab === 'memory') {
        await Promise.allSettled([
          bridge.has('memoryList') ? bridge.call('memoryList', { limit: 200 }).then((r) => { memoryItems = (r && r.ok && Array.isArray(r.items)) ? r.items : []; }) : Promise.resolve(),
          bridge.has('remindersList') ? bridge.call('remindersList', {}).then((r) => { remindersItems = (r && r.ok && Array.isArray(r.items)) ? r.items : []; }) : Promise.resolve(),
        ]);
      } else if (tab === 'services') {
        await Promise.allSettled([
          bridge.has('mailState') ? bridge.call('mailState').then((r) => { mailPayload = r; }) : Promise.resolve(),
          bridge.has('calendarState') ? bridge.call('calendarState').then((r) => { calendarPayload = r; }) : Promise.resolve(),
        ]);
      } else if (tab === 'journal') {
        await Promise.allSettled([
          bridge.has('journalSearch') ? bridge.call('journalSearch', { query: journalQuery, limit: 80 }).then((r) => { journalEntries = (r && r.ok && Array.isArray(r.items)) ? r.items : []; })
            : (bridge.has('recentJournal') ? bridge.call('recentJournal', 60).then((r) => { journalEntries = Array.isArray(r) ? r : []; }) : Promise.resolve()),
          bridge.has('clipboardHistoryState') ? bridge.call('clipboardHistoryState').then((r) => { clipPaused = Boolean(r && r.paused); }) : Promise.resolve(),
          bridge.has('clipboardHistoryList') ? bridge.call('clipboardHistoryList', { limit: 30 }).then((r) => { clipItems = (r && Array.isArray(r.items)) ? r.items : []; }) : Promise.resolve(),
          bridge.has('snippetsList') ? bridge.call('snippetsList').then((r) => { snippets = (r && Array.isArray(r.items)) ? r.items : []; }) : Promise.resolve(),
        ]);
      }
      if (mySeq !== loadSeq) return;
      loading = false;
      body.dataset.loading = '0';
      renderBody();
    }

    function renderDesks() {
      const wrap = document.createElement('div');
      wrap.className = 'ae-stack';
      if (!desksPayload || desksPayload.ok === false) {
        const emp = document.createElement('div');
        emp.className = 'ae-empty-pane';
        emp.textContent = 'Рабочие столы в этой среде недоступны.';
        wrap.append(emp);
        return wrap;
      }

      const desks = Array.isArray(desksPayload.desks) ? desksPayload.desks : [];
      const active = desks.find((d) => d.id === desksPayload.activeId) || desks[0];

      // Панель столов + добавление
      const top = document.createElement('div');
      top.className = 'ae-desk-bar';
      const tabsRow = document.createElement('div');
      tabsRow.className = 'ae-chips-row';
      for (const d of desks) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = active && d.id === active.id ? 'ae-subtab is-active' : 'ae-subtab';
        b.textContent = d.name || 'Стол';
        b.addEventListener('click', async () => {
          await bridge.call('desksSelect', d.id);
          await loadTabData('desks');
        });
        tabsRow.append(b);
      }

      const addControls = document.createElement('div');
      addControls.className = 'ae-head-actions';
      const newDeskBtn = document.createElement('button');
      newDeskBtn.type = 'button';
      newDeskBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
      newDeskBtn.append(icon('plus'), 'Новый стол');
      const form = document.createElement('form');
      form.className = 'ae-head-actions ae-new-desk';
      form.hidden = true;
      const name = document.createElement('input');
      name.className = 'ae-input';
      name.setAttribute('aria-label', 'Название стола');
      name.placeholder = 'Название стола';
      name.required = true;
      const template = document.createElement('select');
      template.className = 'ae-select';
      template.setAttribute('aria-label', 'Шаблон стола');
      for (const item of desksPayload.templates || []) template.add(new Option(item.title, item.id));
      const create = document.createElement('button');
      create.className = 'ae-btn ae-btn-secondary';
      create.textContent = 'Создать';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ae-btn ae-btn-secondary';
      cancel.textContent = 'Отмена';
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      form.append(name, template, create, cancel, status);
      newDeskBtn.addEventListener('click', () => {
        form.hidden = false;
        newDeskBtn.disabled = true;
        name.value = `Стол ${desks.length + 1}`;
        name.focus();
        name.select();
      });
      cancel.addEventListener('click', () => {
        form.reset();
        status.textContent = '';
        form.hidden = true;
        newDeskBtn.disabled = false;
        newDeskBtn.focus();
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (create.disabled) return;
        const title = name.value.trim();
        if (!title) {
          status.textContent = 'Введите название стола.';
          name.focus();
          return;
        }
        create.disabled = cancel.disabled = true;
        status.textContent = '';
        try {
          const result = await bridge.call('desksCreate', { name: title, template: template.value || 'empty' });
          if (result?.ok) {
            await loadTabData('desks');
            return;
          }
          status.textContent = result?.error || 'Не удалось создать стол.';
        } catch {
          status.textContent = 'Не удалось обновить рабочие столы.';
        } finally {
          create.disabled = cancel.disabled = false;
        }
      });

      const types = Array.isArray(desksPayload.types) ? desksPayload.types : [];
      if (active && types.length) {
        const wSel = document.createElement('select');
        wSel.className = 'ae-select ae-select-sm';
        const firstOpt = document.createElement('option');
        firstOpt.value = '';
        firstOpt.textContent = 'Добавить виджет…';
        wSel.setAttribute('aria-label', 'Добавить виджет');
        wSel.append(firstOpt);
        for (const wt of types) {
          const id = typeof wt === 'string' ? wt : wt.type || wt.id;
          const label = typeof wt === 'string' ? wt : (wt.title || wt.label || id);
          if (!id) continue;
          const o = document.createElement('option');
          o.value = id;
          o.textContent = label;
          wSel.append(o);
        }
        wSel.addEventListener('change', async () => {
          if (!wSel.value) return;
          await bridge.call('desksAddWidget', active.id, { type: wSel.value });
          wSel.value = '';
          await loadTabData('desks');
        });
        addControls.append(wSel);
      }
      addControls.append(newDeskBtn);
      top.append(tabsRow, addControls);
      wrap.append(top, form);

      // Виджеты активного стола
      const widgets = active && Array.isArray(active.widgets) ? active.widgets : [];
      const wData = desksPayload.data && typeof desksPayload.data === 'object' ? desksPayload.data : {};

      if (!widgets.length) {
        const emp = document.createElement('div');
        emp.className = 'ae-empty-pane';
        emp.textContent = 'На этом столе пока нет виджетов.';
        wrap.append(emp);
        return wrap;
      }

      const grid = document.createElement('div');
      grid.className = 'ae-cards-grid';
      for (const w of widgets) {
        const card = document.createElement('div');
        card.className = 'ae-grid-card ae-widget-card';
        const data = wData[w.id] || {};

        const wHead = document.createElement('div');
        wHead.className = 'ae-grid-card-head';
        const wt = document.createElement('strong');
        wt.textContent = data.title || w.type;
        const rmB = document.createElement('button');
        rmB.type = 'button';
        rmB.className = 'ae-btn ae-btn-ghost ae-btn-xs';
        rmB.textContent = '×';
        rmB.title = 'Убрать виджет';
        rmB.addEventListener('click', async () => {
          await bridge.call('desksRemoveWidget', active.id, w.id);
          await loadTabData('desks');
        });
        wHead.append(wt, rmB);
        card.append(wHead);

        if (data.summary || data.text) {
          const p = document.createElement('p');
          p.className = 'ae-grid-card-desc';
          p.textContent = scrub(data.summary || data.text);
          card.append(p);
        }

        const entries = Array.isArray(data.items) ? data.items : (Array.isArray(data.entries) ? data.entries : []);
        if (entries.length) {
          const ul = document.createElement('ul');
          ul.className = 'ae-mini-list';
          for (const item of entries.slice(0, 6)) {
            const li = document.createElement('li');
            li.textContent = scrub(typeof item === 'string' ? item : (item.title || item.text || item.name || ''));
            ul.append(li);
          }
          card.append(ul);
        } else if (!data.summary && !data.text) {
          const emptyW = document.createElement('p');
          emptyW.className = 'ae-muted';
          emptyW.textContent = 'Нет актуальных данных';
          card.append(emptyW);
        }

        if (w.type === 'weather' && bridge.has('widgetsSetCity')) {
          const cityForm = document.createElement('form');
          cityForm.className = 'ae-inline-mini';
          const cInp = document.createElement('input');
          cInp.type = 'text';
          cInp.className = 'ae-input ae-input-sm';
          cInp.placeholder = 'Город…';
          cInp.value = data.city || (w.config && w.config.city) || '';
          const cBtn = document.createElement('button');
          cBtn.type = 'submit';
          cBtn.className = 'ae-btn ae-btn-secondary ae-btn-xs';
          cBtn.textContent = 'ОК';
          cityForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!cInp.value.trim()) return;
            await bridge.call('widgetsSetCity', cInp.value.trim());
            await loadTabData('desks');
          });
          cityForm.append(cInp, cBtn);
          card.append(cityForm);
        }

        grid.append(card);
      }

      wrap.append(grid);
      return wrap;
    }

    function renderMemory() {
      const split = document.createElement('div');
      split.className = 'ae-split-2col';

      // Колонка памяти
      const memPanel = document.createElement('div');
      memPanel.className = 'ae-panel';
      const mh = document.createElement('div');
      mh.className = 'ae-panel-head';
      const mt = document.createElement('h2');
      mt.textContent = `Память ассистента (${memoryItems.length})`;
      const clearM = document.createElement('button');
      clearM.type = 'button';
      clearM.className = 'ae-btn ae-btn-ghost ae-btn-xs';
      clearM.textContent = 'Очистить всё';
      clearM.disabled = !memoryItems.length;
      clearM.addEventListener('click', async () => {
        if (clearM.dataset.armed !== '1') {
          clearM.dataset.armed = '1';
          clearM.textContent = 'Подтвердить очистку';
          setTimeout(() => { clearM.dataset.armed = ''; clearM.textContent = 'Очистить всё'; }, 3500);
          return;
        }
        await bridge.call('memoryClear', { confirm: true });
        await loadTabData('memory');
      });
      mh.append(mt, clearM);
      memPanel.append(mh);

      if (!memoryItems.length) {
        const emp = document.createElement('p');
        emp.className = 'ae-muted';
        emp.textContent = 'Сохранённых фактов и предпочтений пока нет.';
        memPanel.append(emp);
      } else {
        for (const item of memoryItems) {
          const row = document.createElement('div');
          row.className = 'ae-list-row';
          const textWrap = document.createElement('div');
          textWrap.className = 'ae-list-main';
          const bodyT = document.createElement('div');
          bodyT.textContent = scrub(item.text || '');
          const metaT = document.createElement('div');
          metaT.className = 'ae-item-meta';
          metaT.textContent = [item.about ? `о: ${item.about}` : '', item.kind || ''].filter(Boolean).join(' · ');
          textWrap.append(bodyT, metaT);

          const delB = document.createElement('button');
          delB.type = 'button';
          delB.className = 'ae-btn ae-btn-ghost ae-btn-xs';
          delB.textContent = 'Удалить';
          delB.addEventListener('click', async () => {
            await bridge.call('memoryRemove', item.id);
            await loadTabData('memory');
          });
          row.append(textWrap, delB);
          memPanel.append(row);
        }
      }

      // Колонка напоминаний
      const remPanel = document.createElement('div');
      remPanel.className = 'ae-panel';
      const rh = document.createElement('div');
      rh.className = 'ae-panel-head';
      const rt = document.createElement('h2');
      rt.textContent = `Напоминания (${remindersItems.length})`;
      rh.append(rt);
      remPanel.append(rh);

      if (!remindersItems.length) {
        const emp = document.createElement('p');
        emp.className = 'ae-muted';
        emp.textContent = 'Активных напоминаний нет. Попросите Nox в чате о чём-нибудь напомнить.';
        remPanel.append(emp);
      } else {
        for (const item of remindersItems) {
          const row = document.createElement('div');
          row.className = 'ae-list-row';
          const textWrap = document.createElement('div');
          textWrap.className = 'ae-list-main';
          const bodyT = document.createElement('div');
          bodyT.textContent = scrub(item.text || '');
          const metaT = document.createElement('div');
          metaT.className = 'ae-item-meta';
          metaT.textContent = [item.dueAt && ui.shortTime ? ui.shortTime(item.dueAt) : '', item.repeat === 'daily' ? 'каждый день' : ''].filter(Boolean).join(' · ');
          textWrap.append(bodyT, metaT);

          const cancelB = document.createElement('button');
          cancelB.type = 'button';
          cancelB.className = 'ae-btn ae-btn-ghost ae-btn-xs';
          cancelB.textContent = 'Отменить';
          cancelB.addEventListener('click', async () => {
            await bridge.call('remindersCancel', item.id);
            await loadTabData('memory');
          });
          row.append(textWrap, cancelB);
          remPanel.append(row);
        }
      }

      split.append(memPanel, remPanel);
      return split;
    }

    function renderServices() {
      const wrap = document.createElement('div');
      wrap.className = 'ae-stack';

      // Почта и календарь
      const svcPanel = document.createElement('div');
      svcPanel.className = 'ae-panel';
      const svcTitle = document.createElement('h2');
      svcTitle.textContent = 'Почта и календарь';
      svcPanel.append(svcTitle);

      const mailRow = document.createElement('div');
      mailRow.className = 'ae-list-row';
      const mailInfo = document.createElement('div');
      mailInfo.className = 'ae-list-main';
      const mailName = document.createElement('strong');
      mailName.textContent = 'Почта (Gmail)';
      const mailStateTxt = document.createElement('span');
      mailStateTxt.className = 'ae-item-meta';
      if (!mailPayload || !mailPayload.credentials) mailStateTxt.textContent = 'Не настроена (требуется файл доступа)';
      else if (mailPayload.connected) mailStateTxt.textContent = `Подключена${mailPayload.email ? `: ${mailPayload.email}` : ''}`;
      else mailStateTxt.textContent = 'Отключена';
      mailInfo.append(mailName, mailStateTxt);
      mailRow.append(mailInfo);

      if (mailPayload && mailPayload.credentials) {
        const mBtn = document.createElement('button');
        mBtn.type = 'button';
        mBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
        mBtn.textContent = mailPayload.connected ? 'Отключить' : 'Подключить';
        mBtn.addEventListener('click', async () => {
          await bridge.call(mailPayload.connected ? 'mailDisconnect' : 'mailConnect');
          await loadTabData('services');
        });
        mailRow.append(mBtn);
      }
      svcPanel.append(mailRow);

      const calRow = document.createElement('div');
      calRow.className = 'ae-list-row';
      const calInfo = document.createElement('div');
      calInfo.className = 'ae-list-main';
      const calName = document.createElement('strong');
      calName.textContent = 'Локальный календарь (.ics / .json)';
      const calSub = document.createElement('span');
      calSub.className = 'ae-item-meta';
      calSub.textContent = calendarPayload && calendarPayload.sourceLabel ? calendarPayload.sourceLabel : 'Источник не выбран';
      calInfo.append(calName, calSub);
      const calBtn = document.createElement('button');
      calBtn.type = 'button';
      calBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
      calBtn.textContent = 'Выбрать файл…';
      calBtn.addEventListener('click', async () => {
        await bridge.call('calendarPickFile');
        await loadTabData('services');
      });
      calRow.append(calInfo, calBtn);
      svcPanel.append(calRow);

      wrap.append(svcPanel);
      return wrap;
    }

    function renderJournalAndTools() {
      const wrap = document.createElement('div');
      wrap.className = 'ae-stack';

      // Журнал действий
      const jPanel = document.createElement('div');
      jPanel.className = 'ae-panel';
      const jHead = document.createElement('div');
      jHead.className = 'ae-panel-head';
      const jt = document.createElement('h2');
      jt.textContent = 'Журнал выполненных действий';
      const jSearch = document.createElement('input');
      jSearch.type = 'search';
      jSearch.className = 'ae-input ae-input-sm';
      jSearch.placeholder = 'Поиск по журналу…';
      jSearch.value = journalQuery;
      jSearch.addEventListener('change', () => {
        journalQuery = jSearch.value;
        loadTabData('journal');
      });
      jHead.append(jt, jSearch);
      jPanel.append(jHead);

      if (!journalEntries.length) {
        const emp = document.createElement('p');
        emp.className = 'ae-muted';
        emp.textContent = 'Записей в журнале пока нет.';
        jPanel.append(emp);
      } else {
        for (const e of journalEntries.slice(0, 25)) {
          const row = document.createElement('div');
          row.className = 'ae-list-row';
          const main = document.createElement('div');
          main.className = 'ae-list-main';
          const ttl = document.createElement('strong');
          ttl.textContent = ui.toolTitle ? ui.toolTitle(e.tool) : (e.tool || 'Действие');
          const subT = document.createElement('span');
          subT.className = 'ae-item-meta';
          subT.textContent = scrub(e.summary || e.status || '');
          main.append(ttl, subT);
          const timeEl = document.createElement('span');
          timeEl.className = 'ae-item-meta';
          timeEl.textContent = e.at && ui.shortTime ? ui.shortTime(e.at) : '';
          row.append(main, timeEl);
          jPanel.append(row);
        }
      }
      wrap.append(jPanel);

      // Буфер обмена и уборка загрузок рядом
      const toolsRow = document.createElement('div');
      toolsRow.className = 'ae-split-2col';

      // История буфера обмена
      const clipPanel = document.createElement('div');
      clipPanel.className = 'ae-panel';
      const ch = document.createElement('div');
      ch.className = 'ae-panel-head';
      const ct = document.createElement('h2');
      ct.textContent = `Буфер обмена (${clipItems.length})`;
      const chBtns = document.createElement('div');
      chBtns.className = 'ae-head-actions';
      if (bridge.has('clipboardHistoryPause')) {
        const pBtn = document.createElement('button');
        pBtn.type = 'button';
        pBtn.className = 'ae-btn ae-btn-ghost ae-btn-xs';
        pBtn.textContent = clipPaused ? 'Продолжить' : 'Пауза';
        pBtn.addEventListener('click', async () => {
          await bridge.call(clipPaused ? 'clipboardHistoryResume' : 'clipboardHistoryPause');
          await loadTabData('journal');
        });
        chBtns.append(pBtn);
      }
      if (bridge.has('clipboardHistoryClear') && clipItems.length) {
        const cBtn = document.createElement('button');
        cBtn.type = 'button';
        cBtn.className = 'ae-btn ae-btn-ghost ae-btn-xs';
        cBtn.textContent = 'Очистить';
        cBtn.addEventListener('click', async () => {
          await bridge.call('clipboardHistoryClear');
          await loadTabData('journal');
        });
        chBtns.append(cBtn);
      }
      ch.append(ct, chBtns);
      clipPanel.append(ch);
      if (!clipItems.length) {
        const p = document.createElement('p');
        p.className = 'ae-muted';
        p.textContent = store.state.settings.clipboardHistory
          ? 'История буфера пуста.'
          : 'Включите запись истории буфера в Настройках → Память и буфер.';
        clipPanel.append(p);
      } else {
        for (const c of clipItems.slice(0, 10)) {
          const row = document.createElement('div');
          row.className = 'ae-list-row';
          const txt = document.createElement('div');
          txt.className = 'ae-list-main';
          txt.textContent = scrub(String(c.preview || c.text || '').slice(0, 120));
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'ae-btn ae-btn-ghost ae-btn-xs';
          rm.textContent = '×';
          rm.addEventListener('click', async () => {
            await bridge.call('clipboardHistoryRemove', c.id);
            await loadTabData('journal');
          });
          row.append(txt, rm);
          clipPanel.append(row);
        }
      }

      // Уборка загрузок
      const dlPanel = document.createElement('div');
      dlPanel.className = 'ae-panel';
      const dh = document.createElement('div');
      dh.className = 'ae-panel-head';
      const dt = document.createElement('h2');
      dt.textContent = 'Уборка загрузок';
      const scanBtn = document.createElement('button');
      scanBtn.type = 'button';
      scanBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
      scanBtn.textContent = 'Проверить папку';
      scanBtn.addEventListener('click', async () => {
        if (!bridge.has('downloadsAnalyze')) return;
        scanBtn.disabled = true;
        try {
          dlAnalysis = await bridge.call('downloadsAnalyze', {});
          dlSelected = new Set();
          renderBody();
        } catch (err) {
          store.toast(`Анализ не удался: ${bridge.errText(err)}`, 'error');
        } finally {
          scanBtn.disabled = false;
        }
      });
      dh.append(dt, scanBtn);
      dlPanel.append(dh);

      if (!dlAnalysis) {
        const p = document.createElement('p');
        p.className = 'ae-muted';
        p.textContent = 'Нажмите «Проверить папку», чтобы найти старые архивы и установщики. Удаление возможно только после вашего подтверждения.';
        dlPanel.append(p);
      } else {
        const cands = Array.isArray(dlAnalysis.candidates) ? dlAnalysis.candidates : [];
        if (!cands.length) {
          const p = document.createElement('p');
          p.className = 'ae-muted';
          p.textContent = 'Старых лишних файлов в «Загрузках» не найдено.';
          dlPanel.append(p);
        } else {
          for (const item of cands.slice(0, 12)) {
            const lbl = document.createElement('label');
            lbl.className = 'ae-list-row ae-check-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = dlSelected.has(item.path);
            cb.addEventListener('change', () => {
              if (cb.checked) dlSelected.add(item.path);
              else dlSelected.delete(item.path);
              renderBody();
            });
            const nm = document.createElement('span');
            nm.className = 'ae-list-main';
            nm.textContent = `${item.name || item.path} · ${fmtBytes(item.size)}`;
            lbl.append(cb, nm);
            dlPanel.append(lbl);
          }
          const rmSelBtn = document.createElement('button');
          rmSelBtn.type = 'button';
          rmSelBtn.className = 'ae-btn ae-btn-danger ae-btn-sm';
          rmSelBtn.disabled = dlSelected.size === 0;
          rmSelBtn.textContent = `Удалить выбранные (${dlSelected.size})`;
          rmSelBtn.addEventListener('click', async () => {
            if (rmSelBtn.dataset.armed !== '1') {
              rmSelBtn.dataset.armed = '1';
              rmSelBtn.textContent = `Точно удалить (${dlSelected.size})?`;
              return;
            }
            const payload = cands.filter((c) => dlSelected.has(c.path));
            const res = await bridge.call('downloadsRemove', payload, true);
            if (res && res.ok !== false) {
              store.toast(`Удалено файлов: ${(res.removed && res.removed.length) || 0}`, 'ok');
              dlAnalysis = await bridge.call('downloadsAnalyze', {});
              dlSelected.clear();
              renderBody();
            } else {
              store.toast((res && res.message) || 'Не удалось удалить', 'error');
            }
          });
          dlPanel.append(rmSelBtn);
        }
      }

      toolsRow.append(clipPanel, dlPanel);
      wrap.append(toolsRow);

      // Быстрые вставки
      if (snippets.length || bridge.has('snippetsList')) {
        const snPanel = document.createElement('div');
        snPanel.className = 'ae-panel';
        const sh = document.createElement('div');
        sh.className = 'ae-panel-head';
        const stH = document.createElement('h2');
        stH.textContent = `Быстрые вставки (${snippets.length})`;
        sh.append(stH);
        snPanel.append(sh);
        if (!snippets.length) {
          const p = document.createElement('p');
          p.className = 'ae-muted';
          p.textContent = 'Сохранённых текстовых заготовок пока нет.';
          snPanel.append(p);
        } else {
          for (const sn of snippets.slice(0, 12)) {
            const row = document.createElement('div');
            row.className = 'ae-list-row';
            const main = document.createElement('div');
            main.className = 'ae-list-main';
            main.textContent = `${sn.trigger || ''} → ${String(sn.text || '').slice(0, 90)}`;
            row.append(main);
            snPanel.append(row);
          }
        }
        wrap.append(snPanel);
      }

      return wrap;
    }

    function renderBody() {
      for (const [id, b] of tabBtns.entries()) {
        b.classList.toggle('is-active', id === subTab);
        b.setAttribute('aria-pressed', String(id === subTab));
      }
      body.replaceChildren();
      if (loading) {
        const emp = document.createElement('div');
        emp.className = 'ae-empty-pane';
        emp.textContent = 'Загружаю данные…';
        body.append(emp);
        return;
      }
      if (subTab === 'desks') body.append(renderDesks());
      else if (subTab === 'memory') body.append(renderMemory());
      else if (subTab === 'services') body.append(renderServices());
      else if (subTab === 'journal') body.append(renderJournalAndTools());
    }

    function render(st) {
      const show = st.route === 'personal';
      root.hidden = !show;
      if (show && !loaded) loadTabData(subTab);
    }

    return { el: root, render, refresh: () => loadTabData(subTab) };
  }

  window.NoxAetherPersonalView = { createPersonalView };
})();
