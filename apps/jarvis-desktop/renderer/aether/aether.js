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
    const accountPanel = window.NoxAetherAccountPanel.createAccountPanel({ store, bridge });
    const historyDrawer = window.NoxAetherHistory.createHistoryDrawer({ store });
    const orbStage = window.NoxAetherOrbStage.createOrbStage({ store });
    const commandsView = window.NoxAetherCommandsView.createCommandsView({ store, bridge });
    const mcpView = window.NoxAetherMcpView.createMcpView({ store, bridge });
    const personalView = window.NoxAetherPersonalView.createPersonalView({ store, bridge });
    const settingsView = window.NoxAetherSettingsView.createSettingsView({ store, bridge });
    const aiModal = window.NoxAetherAiModal.createAiModal({ store, bridge });
    const chatView = window.NoxAetherChatView.createChatView({
      store, bridge, orbStage,
    });
    const dayWidgets = window.NoxAetherDayWidgets.createDayWidgets({
      bridge, choose: chatView.insertStarter, reportError: (text) => store.toast(text, 'error'),
    });

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

    const { icon, logoSphere } = window.NoxAetherIcons;

    const rail = document.createElement('aside');
    rail.className = 'ae-utility-rail ae-rail-v2';
    rail.id = 'aeUtilityRail';
    rail.setAttribute('aria-label', 'Служебная рейка');
    function railButton(id, label, iconName) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = id;
      button.className = 'ae-rail-button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.dataset.label = label;
      button.append(icon(iconName));
      return button;
    }

    const aiModalBtn = railButton('lxAiModalBtn', 'Настройки Nox AI', 'sparkles');
    aiModalBtn.setAttribute('aria-haspopup', 'dialog');
    aiModalBtn.setAttribute('aria-controls', 'lxAiModal');
    aiModalBtn.addEventListener('click', () => {
      aiModal.open();
      syncAll(store.state);
    });

    const stageBtn = railButton('aeStageToggle', 'Панель сферы', 'orb');
    stageBtn.setAttribute('aria-controls', orbStage.el.id);
    let stageCollapsed = false;
    stageBtn.addEventListener('click', () => {
      if (store.state.route !== 'chat') {
        store.setRoute('chat');
        if (!orbStage.el.hidden && document.documentElement.dataset.aeOrbPos !== 'hidden') return;
      }
      if (document.documentElement.dataset.aeOrbPos === 'hidden') {
        const boot = window.NoxAetherBoot;
        const workshop = { ...boot.readWorkshop(), orbPosition: 'right' };
        try { localStorage.setItem(boot.WORKSHOP_KEY, JSON.stringify(workshop)); } catch { /* ignore */ }
        boot.applyWorkshopToDom(workshop);
        stageCollapsed = false;
      } else {
        stageCollapsed = !stageCollapsed;
      }
      syncAll(store.state);
    });

    // Знак Nox вверху рейки — короткий путь на «Главную».
    const homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    homeBtn.id = 'aeRailHomeBtn';
    homeBtn.className = 'ae-rail-button ae-rail-brand';
    homeBtn.title = 'Главная';
    homeBtn.setAttribute('aria-label', 'Главная');
    homeBtn.dataset.label = 'Главная';
    homeBtn.append(logoSphere('ae-rail-logo'));
    homeBtn.addEventListener('click', () => store.setRoute('personal'));

    // История и аккаунт: те же обработчики и aria, но с понятным значком и подписью.
    historyDrawer.trigger.classList.add('ae-rail-button');
    historyDrawer.trigger.dataset.label = 'История чатов';
    historyDrawer.trigger.replaceChildren(icon('history'));
    const limitsTrigger = accountPanel.el.querySelector('#aeLimitsTrigger');
    if (limitsTrigger) limitsTrigger.dataset.label = 'Лимиты';
    const accountTrigger = accountPanel.el.querySelector('#aeAccountTrigger');
    if (accountTrigger) accountTrigger.dataset.label = 'Аккаунт';

    // Порядок элементов служебной рейки; ниже раскладываем их по смысловым группам.
    rail.append(aiModalBtn, historyDrawer.trigger, stageBtn, accountPanel.el);

    function railGroup(label, ...children) {
      const group = document.createElement('div');
      group.className = 'ae-rail-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      group.append(...children);
      return group;
    }
    function railSeparator() {
      const sep = document.createElement('div');
      sep.className = 'ae-rail-sep';
      sep.setAttribute('aria-hidden', 'true');
      return sep;
    }
    const railSpacer = document.createElement('div');
    railSpacer.className = 'ae-rail-spacer';
    railSpacer.setAttribute('aria-hidden', 'true');

    rail.replaceChildren(
      homeBtn,
      railSeparator(),
      railGroup('Nox AI', aiModalBtn, stageBtn),
      railSeparator(),
      railGroup('История', historyDrawer.trigger),
      railSpacer,
      railSeparator(),
      railGroup('Аккаунт', accountPanel.el)
    );

    appRoot.replaceChildren(topbar.el, rail, mainContent, toastHost, aiModal.el);

    // Открытие и закрытие окна Nox AI не меняет состояние store — подсвечиваем кнопку рейки отдельно.
    new MutationObserver(() => syncAll(store.state))
      .observe(aiModal.el, { attributes: true, attributeFilter: ['hidden'] });

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
      if (!isChat) chatStageShell.querySelector('.ae-sources-popover:popover-open')?.hidePopover();
      orbStage.el.hidden = !isChat || stageCollapsed;
      const { aeOrbPos, aeDayWidgets } = document.documentElement.dataset;
      const stageVisible = isChat && !stageCollapsed && aeOrbPos !== 'hidden';
      const docked = !stageVisible || aeOrbPos === 'top';
      dayWidgets.place({
        active: isChat && aeDayWidgets !== 'off',
        host: docked ? chatView.widgetDock : orbStage.el,
        docked,
        workspace: st.currentWorkspaceId,
      });
      stageBtn.setAttribute('aria-expanded', String(stageVisible));
      const stageLabel = stageVisible ? 'Свернуть панель сферы' : 'Показать панель сферы';
      const stageState = store.getOrbEffectiveState();
      const stageStatus = window.NoxAetherOrbStage.STATE_LABELS[stageState];
      stageBtn.dataset.state = stageState;
      stageBtn.title = stageStatus ? `${stageLabel} · ${stageStatus}` : stageLabel;
      stageBtn.setAttribute('aria-label', stageBtn.title);

      // Рейка: активные состояния и aria у служебных кнопок.
      const brandActive = st.route === 'personal';
      homeBtn.classList.toggle('is-active', brandActive);
      homeBtn.setAttribute('aria-current', brandActive ? 'page' : 'false');
      const aiOpen = aiModal.isOpen();
      aiModalBtn.classList.toggle('is-active', aiOpen);
      aiModalBtn.setAttribute('aria-expanded', String(aiOpen));

      topbar.render(st);
      accountPanel.render(st);
      historyDrawer.render(st);
      if (isChat) chatView.render(st);
      orbStage.render(st);
      commandsView.render(st);
      mcpView.render(st);
      personalView.render(st);
      settingsView.render(st);
      aiModal.update(st);
      renderToasts(st);
    }

    store.subscribe(syncAll);

    // Подписка на события ядра и диктовки
    bridge.subscribeEvents(
      (ev) => {
        store.onAgentEvent(ev);
        commandsView.onEvent(ev);
        if (mcpView && typeof mcpView.onEvent === 'function') mcpView.onEvent(ev);
        if ((store.state.account?.signedIn || accountPanel.isOpen())
          && ['done', 'limit_pause', 'limit_resume'].includes(ev.type)) store.refreshAccount();
      },
      (dev) => {
        store.onDictationEvent(dev);
        if (commandsView && typeof commandsView.onDictationEvent === 'function') commandsView.onDictationEvent(dev);
      }
    );

    // Глобальные клавиши окна
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (chatStageShell.querySelector('.ae-sources-popover:popover-open')) return;
        if (store.state.trackerBusy) {
          e.preventDefault();
          store.stopRun();
        } else if (window.innerWidth < 980 && store.state.historyOpen && store.state.route === 'chat') {
          const focusInHistory = historyDrawer.el.contains(document.activeElement);
          store.toggleHistory(false);
          if (focusInHistory) historyDrawer.trigger.focus();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        store.createNewChat();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        historyDrawer.toggle();
      } else if (e.ctrlKey && e.altKey && !e.shiftKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) {
        if (store.state.dictation.hotkeyOk === false) {
          e.preventDefault();
          store.cycleDictationMode();
        }
      }
    });

    // Подстройка боковой истории при смене ширины окна
    window.addEventListener('resize', () => store.syncHistoryViewport());

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
      openAiModal: () => aiModal.open(),
      closeAiModal: () => aiModal.close(),
      setAddonsTab: (tab) => mcpView.setTab(tab),
      commandsDebug: commandsView.getUiDebugApi ? commandsView.getUiDebugApi() : null,
      openCommand: (id) => commandsView.openCommand(id),
      orbLibrary: window.NoxOrbLibrary,
    };
  });
})();
