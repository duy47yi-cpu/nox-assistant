/* Боковая панель истории чатов и рабочих пространств.
 * На широких окнах плавно сворачивается; на узких (< 980px) открывается как наложенный ящик без сжатия чата. */
(() => {
  'use strict';

  function startOfTodayMs() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function createHistoryDrawer({ store }) {
    const { icon } = window.NoxAetherIcons;

    const wrap = document.createElement('aside');
    wrap.className = 'ae-sidebar-wrap';
    wrap.id = 'aeHistoryWrap';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = 'aeHistoryToggle';
    trigger.className = 'ae-icon-btn';
    trigger.title = 'История чатов (Ctrl+B)';
    trigger.setAttribute('aria-label', 'История чатов');
    trigger.setAttribute('aria-controls', wrap.id);
    trigger.append(icon('panelLeft'));

    function toggle() {
      const fromAnotherSection = store.state.route !== 'chat';
      if (fromAnotherSection) store.setRoute('chat');
      store.toggleHistory(fromAnotherSection ? true : undefined);
    }
    trigger.addEventListener('click', toggle);

    const backdrop = document.createElement('div');
    backdrop.className = 'ae-sidebar-backdrop';
    backdrop.addEventListener('click', () => store.toggleHistory(false));

    const aside = document.createElement('div');
    aside.className = 'ae-sidebar';
    aside.setAttribute('aria-label', 'История чатов и пространства');

    // ── Пространства ────────────────────────────────────────────
    const wsBlock = document.createElement('div');
    wsBlock.className = 'ae-ws-block';

    const wsRow = document.createElement('div');
    wsRow.className = 'ae-ws-row';

    const wsSelect = document.createElement('select');
    wsSelect.className = 'ae-select ae-ws-select';
    wsSelect.setAttribute('aria-label', 'Рабочее пространство');
    wsSelect.addEventListener('change', () => {
      if (wsSelect.value) store.selectWorkspace(wsSelect.value);
    });

    const wsAddBtn = document.createElement('button');
    wsAddBtn.type = 'button';
    wsAddBtn.className = 'ae-icon-btn ae-btn-sm';
    wsAddBtn.title = 'Новое пространство';
    wsAddBtn.setAttribute('aria-label', 'Новое пространство');
    wsAddBtn.append(icon('plus'));

    wsRow.append(wsSelect, wsAddBtn);

    const wsForm = document.createElement('form');
    wsForm.className = 'ae-ws-form';
    wsForm.hidden = true;
    const wsInput = document.createElement('input');
    wsInput.type = 'text';
    wsInput.className = 'ae-input ae-input-sm';
    wsInput.placeholder = 'Название пространства';
    wsInput.maxLength = 60;
    const wsOk = document.createElement('button');
    wsOk.type = 'submit';
    wsOk.className = 'ae-btn ae-btn-primary ae-btn-sm';
    wsOk.textContent = 'Создать';
    wsForm.append(wsInput, wsOk);

    wsAddBtn.addEventListener('click', () => {
      wsForm.hidden = !wsForm.hidden;
      if (!wsForm.hidden) {
        wsInput.value = '';
        wsInput.focus();
      }
    });
    wsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = wsInput.value.trim();
      if (!name) return;
      const ok = await store.createWorkspace(name);
      if (ok) wsForm.hidden = true;
    });

    const title = document.createElement('h2');
    title.className = 'ae-history-title';
    title.textContent = 'История';
    wsBlock.append(title, wsRow, wsForm);

    // ── Новый чат и поиск ──────────────────────────────────────
    const actionsRow = document.createElement('div');
    actionsRow.className = 'ae-sidebar-actions';

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.id = 'aeNewChatBtn';
    newBtn.className = 'ae-btn ae-btn-new-chat';
    newBtn.append(icon('plus'), (() => { const s = document.createElement('span'); s.textContent = 'Новый чат'; return s; })());
    newBtn.addEventListener('click', async () => {
      await store.createNewChat();
      if (window.innerWidth < 980) store.toggleHistory(false);
    });

    const searchWrap = document.createElement('div');
    searchWrap.className = 'ae-sidebar-search';
    const searchIco = icon('search', 'ae-search-ico');
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'ae-input ae-input-sm ae-search-input';
    searchInput.placeholder = 'Поиск по чатам…';
    searchInput.setAttribute('aria-label', 'Поиск по чатам');
    searchInput.addEventListener('input', () => renderList(store.state));
    searchWrap.append(searchIco, searchInput);

    actionsRow.append(newBtn, searchWrap);

    // ── Список чатов ───────────────────────────────────────────
    const listBox = document.createElement('div');
    listBox.className = 'ae-chat-list';

    let confirmDeleteId = null;
    let confirmTimer = 0;

    function askDelete(chatId) {
      if (confirmDeleteId === chatId) {
        clearTimeout(confirmTimer);
        confirmDeleteId = null;
        store.closeChat(chatId);
        return;
      }
      confirmDeleteId = chatId;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        confirmDeleteId = null;
        renderList(store.state);
      }, 3500);
      renderList(store.state);
    }

    function buildChatRow(chat, st) {
      const row = document.createElement('div');
      const active = chat.id === st.activeChatId;
      row.className = active ? 'ae-chat-row is-active' : 'ae-chat-row';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'ae-chat-open';
      openBtn.setAttribute('aria-current', active ? 'true' : 'false');

      const title = document.createElement('span');
      title.className = 'ae-chat-title';
      title.textContent = chat.title || 'Новый чат';
      openBtn.append(title);

      const hasDraft = st.drafts.has(chat.id) && chat.id !== st.activeChatId;
      if (hasDraft) {
        const draftTag = document.createElement('span');
        draftTag.className = 'ae-chat-draft-tag';
        draftTag.textContent = 'Черновик';
        openBtn.append(draftTag);
      }

      openBtn.addEventListener('click', async () => {
        await store.selectChat(chat.id);
        if (window.innerWidth < 980) store.toggleHistory(false);
      });

      row.append(openBtn);

      if (st.chats.length > 1) {
        const isConfirm = confirmDeleteId === chat.id;
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = isConfirm ? 'ae-chat-del is-confirm' : 'ae-chat-del';
        delBtn.title = isConfirm ? 'Нажмите ещё раз, чтобы закрыть чат' : 'Закрыть чат';
        delBtn.setAttribute('aria-label', isConfirm ? `Подтвердить закрытие: ${chat.title || 'чат'}` : `Закрыть чат ${chat.title || ''}`);
        if (isConfirm) {
          delBtn.textContent = 'Удалить?';
        } else {
          delBtn.append(icon('x'));
        }
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          askDelete(chat.id);
        });
        row.append(delBtn);
      }

      return row;
    }

    function renderList(st) {
      const query = searchInput.value.trim().toLowerCase();
      const chats = Array.isArray(st.chats) ? st.chats : [];
      const filtered = query
        ? chats.filter((c) => String(c.title || 'Новый чат').toLowerCase().includes(query))
        : chats;

      searchWrap.hidden = chats.length < 5 && !query;
      listBox.replaceChildren();

      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'ae-sidebar-empty';
        empty.textContent = query ? 'Ничего не найдено' : 'Чатов пока нет';
        listBox.append(empty);
        return;
      }

      const todayStart = startOfTodayMs();
      const today = [];
      const earlier = [];
      for (const c of filtered) {
        const ts = Number(c.updatedAt || c.createdAt || Date.now());
        if (ts >= todayStart) today.push(c);
        else earlier.push(c);
      }

      const addGroup = (label, items) => {
        if (!items.length) return;
        const g = document.createElement('div');
        g.className = 'ae-chat-group';
        const h = document.createElement('div');
        h.className = 'ae-chat-group-title';
        h.textContent = label;
        g.append(h);
        for (const item of items) g.append(buildChatRow(item, st));
        listBox.append(g);
      };

      addGroup('Сегодня', today);
      addGroup('Ранее', earlier);
    }

    function render(st) {
      const open = Boolean(st.historyOpen) && st.route === 'chat';
      trigger.setAttribute('aria-expanded', String(open));
      trigger.dataset.active = String(open);
      wrap.classList.toggle('is-open', open);
      wrap.inert = !open;
      wrap.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (st.route !== 'chat') return;

      // Синхронизация списка пространств только при изменении
      const ws = Array.isArray(st.workspaces) ? st.workspaces : [];
      const prevSig = wsSelect.dataset.sig || '';
      const nextSig = ws.map((w) => `${w.id}:${w.name}`).join('|') + `@${st.currentWorkspaceId}`;
      if (prevSig !== nextSig) {
        wsSelect.dataset.sig = nextSig;
        wsSelect.replaceChildren();
        const items = ws.length ? ws : [{ id: 'default', name: 'Основное пространство' }];
        for (const w of items) {
          const opt = document.createElement('option');
          opt.value = w.id;
          opt.textContent = w.name || w.id;
          if (w.id === st.currentWorkspaceId) opt.selected = true;
          wsSelect.append(opt);
        }
      }

      renderList(st);
    }

    aside.append(wsBlock, actionsRow, listBox);
    wrap.append(backdrop, aside);
    return { el: wrap, trigger, toggle, render };
  }

  window.NoxAetherHistory = { createHistoryDrawer };
})();
