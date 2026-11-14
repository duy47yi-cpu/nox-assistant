/* Раздел «MCP-подключения» Nox Aether:
 * - честные 7 состояний подключения (подключён, подключается, выключен, настроено, drift, ошибка, при запуске);
 * - поиск, фильтры, добавление своего сервиса (stdio / http), каталог популярных сервисов;
 * - явное подтверждение изменения набора действий сервиса (mcpApprove — отдельно от approval:respond). */
(() => {
  'use strict';

  function statusInfo(s) {
    if (!s) return { key: 'idle', label: 'Настроено', tone: 'muted' };
    if (s.disabled) return { key: 'disabled', label: 'Выключен', tone: 'muted' };
    if (s.drift && (s.drift.added?.length || s.drift.removed?.length || s.drift.changed?.length)) {
      return { key: 'drift', label: 'Набор действий изменился', tone: 'warn' };
    }
    if (s.error) return { key: 'error', label: 'Ошибка подключения', tone: 'danger' };
    if (s.status === 'connecting' || s.connecting) return { key: 'connecting', label: 'Подключается…', tone: 'info' };
    if (s.connected || s.status === 'connected') {
      const n = Number(s.toolCount) || (Array.isArray(s.tools) ? s.tools.length : 0);
      return { key: 'connected', label: `Подключён · ${n} действ.`, tone: 'ok' };
    }
    if (s.status === 'legacy') return { key: 'legacy', label: 'Подключится при запуске', tone: 'muted' };
    return { key: 'idle', label: 'Настроено, не подключён', tone: 'muted' };
  }

  function createMcpView({ store, bridge }) {
    const ui = window.JarvisUI || {};
    const { icon } = window.NoxAetherIcons;
    const scrub = typeof ui.scrub === 'function' ? ui.scrub : (s) => String(s || '');

    const root = document.createElement('section');
    root.className = 'ae-page ae-mcp-page';
    root.id = 'aeMcpView';
    root.hidden = true;
    root.setAttribute('aria-label', 'MCP-подключения');

    let servers = [];
    let catalog = [];
    let mail = null;
    let filterGroup = 'all'; // 'all' | 'connected' | 'attention' | 'disabled'
    let query = '';
    let selectedName = null;
    let showAddForm = false;
    let confirmRemoveName = null;
    let loaded = false;

    const head = document.createElement('div');
    head.className = 'ae-page-head';
    const tw = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.className = 'ae-page-title';
    h1.textContent = 'Подключения';
    const sub = document.createElement('p');
    sub.className = 'ae-page-sub';
    sub.textContent = 'Внешние сервисы и аккаунты.';
    tw.append(h1, sub);

    const headBtns = document.createElement('div');
    headBtns.className = 'ae-head-actions';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'ae-btn ae-btn-ghost';
    refreshBtn.append(icon('refresh'), (() => { const s = document.createElement('span'); s.textContent = 'Обновить'; return s; })());
    refreshBtn.addEventListener('click', () => loadState());

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'ae-btn ae-btn-primary';
    addBtn.append(icon('plus'), (() => { const s = document.createElement('span'); s.textContent = 'Добавить сервис'; return s; })());
    addBtn.addEventListener('click', () => {
      showAddForm = !showAddForm;
      renderBody();
    });

    headBtns.append(refreshBtn, addBtn);
    head.append(tw, headBtns);

    // Строка фильтров и поиска
    const filterBar = document.createElement('div');
    filterBar.className = 'ae-filter-bar';

    const chips = document.createElement('div');
    chips.className = 'ae-chips-row';
    const FILTERS = [
      ['all', 'Все'],
      ['connected', 'Подключённые'],
      ['attention', 'Требуют внимания'],
      ['disabled', 'Выключенные'],
    ];
    const chipBtns = new Map();
    for (const [id, label] of FILTERS) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'ae-subtab';
      c.textContent = label;
      c.addEventListener('click', () => {
        filterGroup = id;
        renderBody();
      });
      chips.append(c);
      chipBtns.set(id, c);
    }

    const searchInp = document.createElement('input');
    searchInp.type = 'search';
    searchInp.className = 'ae-input ae-search-wide';
    searchInp.placeholder = 'Поиск подключений…';
    searchInp.setAttribute('aria-label', 'Поиск подключений');
    searchInp.addEventListener('input', () => {
      query = searchInp.value;
      renderBody();
    });

    const search = document.createElement('label');
    search.className = 'ae-page-search';
    search.append(icon('search'), searchInp);
    filterBar.append(chips, search);

    const addWrap = document.createElement('div');
    addWrap.className = 'ae-inline-panel';
    addWrap.hidden = true;

    const body = document.createElement('div');
    body.className = 'ae-mcp-body';

    const listGroup = document.createElement('section');
    listGroup.className = 'ae-mcp-list';
    const listHeading = document.createElement('h2');
    listHeading.className = 'ae-section-heading';
    listHeading.textContent = 'Мои подключения';
    const listSection = document.createElement('div');
    listSection.className = 'ae-mcp-list';
    listGroup.append(listHeading, filterBar, listSection);
    const catalogSection = document.createElement('section');
    catalogSection.className = 'ae-mcp-catalog';
    catalogSection.hidden = true;
    body.append(listGroup, catalogSection);
    root.append(head, addWrap, body);

    async function loadState() {
      loaded = true;
      if (!bridge.has('mcpState')) {
        servers = [];
        catalog = [];
        renderBody();
        return;
      }
      try {
        const [res, mailState] = await Promise.all([
          bridge.call('mcpState'),
          bridge.has('mailState') ? bridge.call('mailState').catch(() => null) : null,
        ]);
        servers = Array.isArray(res && res.servers) ? res.servers : [];
        catalog = Array.isArray(res && res.catalog) ? res.catalog : [];
        mail = mailState;
      } catch (err) {
        store.toast(`Не удалось загрузить подключения: ${bridge.errText(err)}`, 'error');
      }
      renderBody();
    }

    function renderAddForm(prefill = null) {
      if (!showAddForm && !prefill) {
        addWrap.hidden = true;
        addWrap.replaceChildren();
        return;
      }
      addWrap.hidden = false;
      const form = document.createElement('form');
      form.className = 'ae-form-grid';

      const fTitle = document.createElement('h2');
      fTitle.textContent = prefill ? `Подключение: ${prefill.title || prefill.name}` : 'Новое MCP-подключение';

      const nmInp = document.createElement('input');
      nmInp.type = 'text';
      nmInp.className = 'ae-input';
      nmInp.placeholder = 'Имя сервиса (например: github или notes)';
      nmInp.value = prefill ? (prefill.id || prefill.name || '') : '';
      nmInp.required = true;

      const tgtInp = document.createElement('input');
      tgtInp.type = 'text';
      tgtInp.className = 'ae-input';
      tgtInp.placeholder = 'Адрес https://… или команда запуска (например: npx)';
      tgtInp.value = prefill ? (prefill.command || prefill.url || '') : '';
      tgtInp.required = true;

      const argsInp = document.createElement('input');
      argsInp.type = 'text';
      argsInp.className = 'ae-input';
      argsInp.placeholder = 'Аргументы команды через пробел (необязательно)';
      argsInp.value = prefill && Array.isArray(prefill.args) ? prefill.args.join(' ') : '';

      const errP = document.createElement('p');
      errP.className = 'ae-form-err';
      errP.hidden = true;

      const actRow = document.createElement('div');
      actRow.className = 'ae-form-actions';
      const saveB = document.createElement('button');
      saveB.type = 'submit';
      saveB.className = 'ae-btn ae-btn-primary';
      saveB.textContent = 'Подключить';
      const cancelB = document.createElement('button');
      cancelB.type = 'button';
      cancelB.className = 'ae-btn ae-btn-ghost';
      cancelB.textContent = 'Отмена';
      cancelB.addEventListener('click', () => {
        showAddForm = false;
        renderAddForm(null);
      });
      actRow.append(saveB, cancelB);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = nmInp.value.trim();
        const target = tgtInp.value.trim();
        const args = argsInp.value.trim() ? argsInp.value.trim().split(/\s+/) : [];
        if (!name || !target) return;
        saveB.disabled = true;
        errP.hidden = true;
        try {
          const r = await bridge.call('mcpAdd', name, target, args);
          if (r && r.ok === false) throw new Error(r.error || 'не удалось подключить');
          if (r?.error) store.toast('Сервис сохранён. Подключение пока не установлено.', 'error');
          else store.toast(`Сервис «${name}» добавлен`, 'ok');
          showAddForm = false;
          await loadState();
        } catch (err) {
          errP.textContent = scrub(bridge.errText(err));
          errP.hidden = false;
        } finally {
          saveB.disabled = false;
        }
      });

      form.append(fTitle, nmInp, tgtInp, argsInp, errP, actRow);
      addWrap.replaceChildren(form);
    }

    function matchesFilter(s) {
      const info = statusInfo(s);
      if (filterGroup === 'connected' && info.key !== 'connected') return false;
      if (filterGroup === 'attention' && info.key !== 'error' && info.key !== 'drift') return false;
      if (filterGroup === 'disabled' && info.key !== 'disabled') return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return String(s.name || '').toLowerCase().includes(q) || String(s.target || s.url || s.command || '').toLowerCase().includes(q);
    }

    function renderBody() {
      for (const [id, b] of chipBtns.entries()) {
        b.classList.toggle('is-active', id === filterGroup);
        b.setAttribute('aria-pressed', String(id === filterGroup));
      }
      if (showAddForm && !addWrap.childElementCount) renderAddForm(null);
      else if (!showAddForm) renderAddForm(null);

      listSection.replaceChildren();
      catalogSection.replaceChildren();

      const filtered = servers.filter(matchesFilter);
      const installedNames = new Set(servers.map((s) => s.name));
      const mailMatches = mail?.connected && ['all', 'connected'].includes(filterGroup) &&
        (!query.trim() || `Gmail ${mail.email || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
      const availableCatalog = catalog.filter((c) => c && !installedNames.has(c.id) && !(c.integration === 'mail' && mail?.connected));
      if (!filtered.length && !mailMatches) {
        const emp = document.createElement('div');
        emp.className = 'ae-empty-pane';
        emp.textContent = 'Подключений пока нет.';
        if (servers.length || mail?.connected) emp.textContent = 'Подключения по этим условиям не найдены.';
        else if (availableCatalog.length) emp.textContent = 'Добавьте сервис вручную или выберите его из каталога.';
        listSection.append(emp);
      } else {
        if (mailMatches) {
          const card = document.createElement('div');
          card.className = 'ae-mcp-card';
          const row = document.createElement('div');
          row.className = 'ae-mcp-card-main';
          const name = document.createElement('strong');
          name.textContent = mail.email ? `Gmail · ${mail.email}` : 'Gmail';
          const disconnect = document.createElement('button');
          disconnect.type = 'button';
          disconnect.className = 'ae-btn ae-btn-secondary ae-btn-sm';
          disconnect.textContent = 'Отключить';
          disconnect.addEventListener('click', () => runMailAction(disconnect, 'mailDisconnect'));
          row.append(name, disconnect);
          card.append(row);
          listSection.append(card);
        }
        for (const s of filtered) {
          const info = statusInfo(s);
          const card = document.createElement('div');
          card.className = 'ae-mcp-card';

          const mainRow = document.createElement('div');
          mainRow.className = 'ae-mcp-card-main';

          const leftInfo = document.createElement('div');
          leftInfo.className = 'ae-mcp-info';
          const topLine = document.createElement('div');
          topLine.className = 'ae-mcp-name-row';
          const nameEl = document.createElement('strong');
          nameEl.textContent = s.title || s.name;
          const badge = document.createElement('span');
          badge.className = `ae-badge is-${info.tone}`;
          badge.textContent = info.label;
          topLine.append(nameEl, badge);

          const addr = document.createElement('div');
          addr.className = 'ae-mcp-addr';
          addr.textContent = scrub(s.url || [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter(Boolean).join(' ') || '');

          leftInfo.append(topLine, addr);

          if (info.key === 'error' && s.error) {
            const errL = document.createElement('div');
            errL.className = 'ae-mcp-err';
            errL.textContent = scrub(s.error);
            leftInfo.append(errL);
          }

          const ctrls = document.createElement('div');
          ctrls.className = 'ae-mcp-ctrls';

          if (info.key === 'drift') {
            const appBtn = document.createElement('button');
            appBtn.type = 'button';
            appBtn.className = 'ae-btn ae-btn-primary ae-btn-sm';
            appBtn.textContent = 'Подтвердить изменения';
            appBtn.addEventListener('click', async () => {
              try {
                await bridge.call('mcpApprove', s.name);
                store.toast(`Изменения «${s.name}» подтверждены`, 'ok');
                await loadState();
              } catch (err) {
                store.toast(`Ошибка: ${bridge.errText(err)}`, 'error');
              }
            });
            ctrls.append(appBtn);
          }

          const toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
          toggleBtn.textContent = s.disabled ? 'Включить' : 'Выключить';
          toggleBtn.addEventListener('click', async () => {
            toggleBtn.disabled = true;
            try {
              await bridge.call('mcpToggle', s.name, !s.disabled);
              await loadState();
            } catch (err) {
              store.toast(`Ошибка: ${bridge.errText(err)}`, 'error');
              toggleBtn.disabled = false;
            }
          });

          const detBtn = document.createElement('button');
          detBtn.type = 'button';
          detBtn.className = 'ae-btn ae-btn-ghost ae-btn-sm';
          detBtn.textContent = selectedName === s.name ? 'Скрыть' : 'Детали';
          detBtn.addEventListener('click', () => {
            selectedName = selectedName === s.name ? null : s.name;
            renderBody();
          });

          const isConf = confirmRemoveName === s.name;
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = isConf ? 'ae-btn ae-btn-danger ae-btn-sm' : 'ae-btn ae-btn-ghost ae-btn-sm';
          delBtn.textContent = isConf ? 'Удалить?' : 'Удалить';
          delBtn.addEventListener('click', async () => {
            if (confirmRemoveName !== s.name) {
              confirmRemoveName = s.name;
              renderBody();
              setTimeout(() => { if (confirmRemoveName === s.name) { confirmRemoveName = null; renderBody(); } }, 3500);
              return;
            }
            confirmRemoveName = null;
            try {
              await bridge.call('mcpRemove', s.name);
              store.toast(`Сервис «${s.name}» удалён`);
              await loadState();
            } catch (err) {
              store.toast(`Ошибка удаления: ${bridge.errText(err)}`, 'error');
            }
          });

          ctrls.append(toggleBtn, detBtn, delBtn);
          mainRow.append(leftInfo, ctrls);
          card.append(mainRow);

          if (selectedName === s.name) {
            const det = document.createElement('div');
            det.className = 'ae-mcp-details';
            const tools = Array.isArray(s.tools) ? s.tools : [];
            if (tools.length) {
              const tTitle = document.createElement('div');
              tTitle.className = 'ae-mcp-det-head';
              tTitle.textContent = `Доступные действия (${tools.length}):`;
              const tGrid = document.createElement('div');
              tGrid.className = 'ae-chips-wrap';
              for (const t of tools.slice(0, 24)) {
                const tag = document.createElement('span');
                tag.className = 'ae-tag';
                tag.textContent = String(t.title || t.name || t);
                tGrid.append(tag);
              }
              det.append(tTitle, tGrid);
            } else {
              const note = document.createElement('p');
              note.className = 'ae-muted';
              note.textContent = 'Набор действий будет известен после успешного подключения сервиса. Все действия выполняются по общим правилам доступа.';
              det.append(note);
            }
            card.append(det);
          }

          listSection.append(card);
        }
      }

      // Каталог популярных сервисов (без фейков — только то, что отдаёт ядро)
      catalogSection.hidden = !availableCatalog.length;
      if (availableCatalog.length) {
        const catHead = document.createElement('h2');
        catHead.className = 'ae-section-heading';
        catHead.textContent = 'Популярные сервисы';

        const grid = document.createElement('div');
        grid.className = 'ae-cards-grid';
        for (const item of availableCatalog) {
          const card = document.createElement('div');
          card.className = 'ae-grid-card';
          card.dataset.service = item.id;
          const title = document.createElement('strong');
          title.textContent = item.title || item.name;
          const desc = document.createElement('p');
          desc.className = 'ae-grid-card-desc';
          desc.textContent = item.description || '';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
          if (item.integration === 'mail') {
            btn.textContent = 'Войти через Google';
            btn.disabled = !mail?.credentials;
            if (btn.disabled) desc.append(' Для входа нужно настроить Gmail в сборке Nox.');
            btn.addEventListener('click', () => runMailAction(btn, 'mailConnect', true));
          } else if (item.ready) {
            btn.textContent = 'Настроить';
            btn.addEventListener('click', () => {
              showAddForm = true;
              renderAddForm(item);
              addWrap.scrollIntoView({ block: 'nearest' });
              addWrap.querySelector('input')?.focus({ preventScroll: true });
            });
          } else {
            if (item.accountKey) desc.append(` Для подключения укажите ${item.accountKey} в настройке сборки.`);
            else if (item.transport === 'http') desc.append(' Для входа нужен совместимый клиент.');
            else desc.append(' Требуется настройка доступа и сервера.');
            btn.textContent = 'Инструкция ↗';
            btn.disabled = !item.docs || !bridge.has('openSource');
            btn.addEventListener('click', async () => {
              try {
                const result = await bridge.call('openSource', item.docs);
                if (!result?.ok) throw new Error(result?.error || 'Не удалось открыть инструкцию');
              } catch (err) { store.toast(scrub(bridge.errText(err)), 'error'); }
            });
          }
          card.append(title, desc, btn);
          grid.append(card);
        }
        catalogSection.append(catHead, grid);
      }
    }

    async function runMailAction(button, action, ...args) {
      button.disabled = true;
      try {
        const result = await bridge.call(action, ...args);
        if (!result?.ok) throw new Error(result?.error || 'Не удалось изменить подключение Gmail');
        await loadState();
      } catch (err) {
        store.toast(scrub(bridge.errText(err)), 'error');
      } finally {
        button.disabled = false;
      }
    }

    function render(st) {
      const show = st.route === 'mcp';
      root.hidden = !show;
      if (show && !loaded) loadState();
    }

    return { el: root, render, refresh: loadState };
  }

  window.NoxAetherMcpView = { createMcpView };
})();
