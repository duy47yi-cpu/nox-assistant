/* Точка входа новой оболочки Nox Aether:
 * - инициализирует store, мосты событий, верхнюю панель, ящик истории, сцену сферы и все 5 разделов;
 * - вешает единый обработчик горячих клавиш (Esc — стоп, Ctrl+N — новый чат, Ctrl+B — история, Ctrl+Alt+M — микрофон);
 * - выводит сдержанные уведомления (toast) без загромождения диалога. */
(() => {
  'use strict';

  document.addEventListener('DOMContentLoaded', async () => {
    const appRoot = document.getElementById('aeAppRoot');
    if (!appRoot) return;

    const bridge = window.NoxAetherBridge;
    const store = window.NoxAetherStore.createStore();

    const topbar = window.NoxAetherTopbar.createTopbar({ store, bridge });
    const historyDrawer = window.NoxAetherHistory.createHistoryDrawer({ store });
    const orbStage = window.NoxAetherOrbStage.createOrbStage({ store });
    const chatView = window.NoxAetherChatView.createChatView({ store, bridge, orbStage });
    const commandsView = window.NoxAetherCommandsView.createCommandsView({ store, bridge });
    const mcpView = window.NoxAetherMcpView.createMcpView({ store, bridge });
    const personalView = window.NoxAetherPersonalView.createPersonalView({ store, bridge });
    const settingsView = window.NoxAetherSettingsView.createSettingsView({ store, bridge });

    // Рабочая зона чата (история + диалог + сцена сферы)
    const chatStageShell = document.createElement('div');
    chatStageShell.className = 'ae-chat-workspace';
    chatStageShell.id = 'aeChatWorkspace';
    chatStageShell.append(historyDrawer.el, chatView.el, orbStage.el);

    const mainContent = document.createElement('main');
    mainContent.className = 'ae-main';
    mainContent.id = 'aeMain';
    mainContent.append(chatStageShell, commandsView.el, mcpView.el, personalView.el, settingsView.el);

    const toastHost = document.createElement('div');
    toastHost.className = 'ae-toast-host';
    toastHost.setAttribute('aria-live', 'polite');

    appRoot.replaceChildren(topbar.el, mainContent, toastHost);

    // Отрисовка тостов
    let lastToastSig = '';
    function renderToasts(st) {
      const list = Array.isArray(st.toasts) ? st.toasts : [];
      const sig = list.map((t) => t.id).join('|');
      if (sig === lastToastSig) return;
      lastToastSig = sig;
      toastHost.replaceChildren(...list.map((t) => {
        const el = document.createElement('div');
        el.className = t.kind === 'error' ? 'ae-toast is-error' : (t.kind === 'ok' ? 'ae-toast is-ok' : 'ae-toast');
        el.textContent = t.text || '';
        return el;
      }));
    }

    // Главный цикл рендера состояния
    function syncAll(st) {
      const isChat = st.route === 'chat';
      chatStageShell.hidden = !isChat;

      topbar.render(st);
      if (isChat) {
        historyDrawer.render(st);
        chatView.render(st);
        orbStage.render(st);
      }
      commandsView.render(st);
      mcpView.render(st);
      personalView.render(st);
      settingsView.render(st);
      renderToasts(st);
    }

    store.subscribe(syncAll);

    // Подписка на события ядра и диктовки
    bridge.subscribeEvents(
      (ev) => {
        store.onAgentEvent(ev);
        commandsView.onEvent(ev);
      },
      (dev) => store.onDictationEvent(dev)
    );

    // Глобальные клавиши окна
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (store.state.trackerBusy) {
          e.preventDefault();
          store.stopRun();
        } else if (window.innerWidth < 980 && store.state.historyOpen && store.state.route === 'chat') {
          store.toggleHistory(false);
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        store.createNewChat();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        if (store.state.route !== 'chat') store.setRoute('chat');
        store.toggleHistory();
      } else if (e.ctrlKey && e.altKey && !e.shiftKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) {
        if (store.state.dictation.hotkeyOk === false) {
          e.preventDefault();
          store.cycleDictationMode();
        }
      }
    });

    // Подстройка боковой истории при смене ширины окна
    window.addEventListener('resize', () => {
      if (window.innerWidth < 980 && store.state.historyOpen) {
        store.toggleHistory(false);
      }
    });

    // Первичная загрузка данных
    await store.loadInitial();
    syncAll(store.state);

    if (store.state.route === 'chat' && store.isEmptyChat()) {
      requestAnimationFrame(() => chatView.focusComposer());
    }

    // Ссылка для автотестов и отладки без утечки секретов
    window.__noxAether = {
      store,
      getRoute: () => store.state.route,
      setRoute: (r) => store.setRoute(r),
      orbLibrary: window.NoxOrbLibrary,
    };
  });
})();
