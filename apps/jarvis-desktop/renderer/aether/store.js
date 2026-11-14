/* Хранилище состояния Nox Aether.
 * Объединяет реальные события ядра, маршрутизацию (5 разделов), историю чатов,
 * черновики при переключении чатов, спокойный прогресс (<=1 строка + «Подробности»)
 * и строгие инварианты безопасности подтверждений (токен показа + пауза 700 мс + затвор). */
(function (root) {
  'use strict';

  const ROUTES = ['chat', 'commands', 'mcp', 'personal', 'settings'];
  const MODE_NAMES = {
    full: 'Полный доступ',
    ask: 'Спрашивать',
    auto: 'Авто-умный',
  };
  const TIER_NAMES = {
    fast: 'Быстрая',
    smart: 'Умная',
  };
  const THINKING_NAMES = {
    low: 'Кратко',
    medium: 'Обычно',
    high: 'Глубоко',
  };
  const APPROVAL_ARM_MS = 700;

  // Извлекает прикреплённые файлы из сохранённой реплики (как parseUserHistory в app.js).
  function parseUserHistory(text) {
    const s = String(text || '');
    if (!/^Файл «/.test(s)) return { text: s, names: [] };
    const names = [];
    const re = /(?:^|\n\n)Файл «([^»\n]+)»/g;
    let m;
    while ((m = re.exec(s)) && names.length < 5) names.push(m[1]);
    const cut = s.lastIndexOf('\n\n');
    return { text: cut >= 0 ? s.slice(cut + 2) : '', names };
  }

  // Строгая формула пустого чата: никаких фейковых сообщений или перехода поверх существующей переписки.
  function isEmptyChatState({ feedItems, activeTurn, historyLoading }) {
    if (historyLoading) return false;
    if (activeTurn) return false;
    return !Array.isArray(feedItems) || feedItems.length === 0;
  }

  // Компактная живая строка для работы ассистента: не больше 1 строки, без спама «Выполняю/Проверяю/Готово».
  function formatLiveWorkSummary({ trackerState, note, currentAction, pendingApprovalCount }) {
    const cleanOneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    if (pendingApprovalCount > 0 || trackerState === 'waiting_approval') {
      return 'Жду вашего подтверждения';
    }
    if (trackerState === 'verifying') return 'Проверяю результат…';
    if (currentAction && currentAction.status === 'running') {
      const title = cleanOneLine(currentAction.title || 'Выполняю шаг');
      const brief = cleanOneLine(currentAction.brief);
      return brief ? `${title}: ${brief}` : `${title}…`;
    }
    const cleanNote = cleanOneLine(note);
    if (trackerState === 'searching') return cleanNote || 'Ищу в источниках…';
    if (trackerState === 'acting' || trackerState === 'working') return cleanNote || 'Выполняю действие…';
    if (trackerState === 'thinking') return cleanNote || 'Думаю…';
    if (trackerState === 'speaking') return 'Формулирую ответ…';
    return '';
  }

  const CMD_DENY_TOOLS = new Set([
    'mail_send', 'pc_shutdown', 'shell_run', 'app_close', 'ui_close_window',
    'app_install', 'windows_close_all', 'window_close_active',
    'forget', 'deal_clear', 'cancel_reminder',
  ]);
  const CMD_FORBIDDEN_PREFIXES = ['mission_', 'command_'];
  const CMD_READ_ONLY_TOOLS = new Set([
    'ui_windows', 'ui_elements', 'desktop_observe', 'windows_list',
    'screen_look', 'screen_region_look', 'image_look', 'image_read_text',
    'clipboard_get', 'workspace_read', 'workspace_list', 'workspace_search',
    'document_read', 'document_batch', 'project_brief', 'project_diagnostics',
    'project_commands', 'code_read', 'web_search', 'web_wiki', 'web_fetch',
    'web_research', 'web_check_claims', 'browser_read', 'browser_tab_read',
    'browser_tabs', 'browser_snapshot', 'recall', 'memory_about',
    'disk_free_space', 'disk_cleanup_suggest', 'weather_now', 'currency_rate',
    'calendar_upcoming', 'calendar_briefing', 'calendar_prep', 'mail_unread',
    'apps_find', 'apps_scan', 'apps_usage', 'app_search', 'deals_hanging',
    'list_reminders', 'library_list', 'skills_list', 'skill_read',
    'goal_list', 'long_task_list', 'task_list', 'command_list',
  ]);
  const CMD_SECRET_KEY = /^(?:password|passwd|pwd|secret|token|api_?key|apikey|access_?token|refresh_?token|access_?key|private_?key|client_?secret|authorization|auth|cookie|cookies|otp|totp|one_?time_?code|credentials?)$/i;
  const CMD_SECRET_LABEL = /(парол[^\s]*|password|passwd|api[\s_-]?key|токен[^\s]*|token|секрет[^\s]*|secret)\s*(?:[:=—–-]|это|is)\s*\S{4,}/i;
  const CMD_SECRET_PREFIX = /\b(?:sk|pk|ghp|xox[abp])[-_][\w-]{12,}\b/i;
  const CMD_SECRET_LIKE = /\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{20,}\b/i;
  const CMD_FAILED_STATUSES = new Set(['error', 'failed', 'refused', 'unverified', 'cancelled', 'canceled', 'pending', 'running', 'skipped']);

  function clientTextLooksSecret(text, keyName = '') {
    const s = String(text == null ? '' : text);
    if (!s) return false;
    if (CMD_SECRET_LABEL.test(s) || CMD_SECRET_PREFIX.test(s) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) return true;
    if (keyName === 'url' && /^https?:\/\//i.test(s)) {
      return /^[a-z]+:\/\/[^/@\s]+:[^/@\s]*@/i.test(s)
        || /[?&#](?:password|passwd|pwd|secret|token|api_?key|apikey|access_?token|refresh_?token|auth|otp|totp|code)=[^&#\s]+/i.test(s);
    }
    return CMD_SECRET_LIKE.test(s);
  }

  function clientArgsHaveSecret(val, keyName = '', depth = 0) {
    if (depth > 10 || val === null || val === undefined) return false;
    if (typeof val === 'string') return clientTextLooksSecret(val, keyName);
    if (Array.isArray(val)) return val.some((item) => clientArgsHaveSecret(item, keyName, depth + 1));
    if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        if (CMD_SECRET_KEY.test(k)) return true;
        if (clientArgsHaveSecret(v, k, depth + 1)) return true;
      }
    }
    return false;
  }

  function buildClientCommandDraft(phrase, actions, existingCommands = []) {
    if (typeof phrase !== 'string') return { ok: false, reason: 'Нужна фраза запуска команды' };
    const rawPhrase = phrase.trim();
    if (!rawPhrase) return { ok: false, reason: 'Нужна фраза запуска команды' };
    if (Array.from(rawPhrase).length > 200) return { ok: false, reason: 'Фраза слишком длинная (не больше 200 символов)' };
    if (clientTextLooksSecret(rawPhrase)) return { ok: false, reason: 'В фразе обнаружены секретные данные — команду не создаём' };
    let normPhrase = rawPhrase.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim().replace(/[\s.!?]+$/u, '');
    if (!normPhrase) return { ok: false, reason: 'Нужна фраза запуска команды' };
    if (Array.from(normPhrase).length > 120) normPhrase = Array.from(normPhrase).slice(0, 120).join('').trim();

    if (!Array.isArray(actions) || actions.length === 0) {
      return { ok: false, reason: 'В этом ответе нет выполненных шагов для команды' };
    }

    const steps = [];
    let sawSecret = false;
    let sawDenied = false;
    let sawReadOnly = false;
    let sawFailed = false;
    for (const a of actions) {
      if (!a || typeof a !== 'object') continue;
      const tool = typeof a.tool === 'string' ? a.tool.trim() : '';
      if (!tool) continue;
      const st = typeof a.status === 'string' ? a.status.trim().toLowerCase() : '';
      if (a.ok === false || CMD_FAILED_STATUSES.has(st)) { sawFailed = true; continue; }
      if (st !== 'confirmed' && st !== 'done' && !(st === '' && a.ok === true)) continue;
      if (CMD_DENY_TOOLS.has(tool) || CMD_FORBIDDEN_PREFIXES.some((p) => tool.startsWith(p))) { sawDenied = true; continue; }
      if (CMD_READ_ONLY_TOOLS.has(tool)) { sawReadOnly = true; continue; }
      let args = {};
      if (a.args && typeof a.args === 'object' && !Array.isArray(a.args)) {
        try { args = JSON.parse(JSON.stringify(a.args)); } catch { args = {}; }
      }
      if (clientArgsHaveSecret(args)) { sawSecret = true; continue; }
      steps.push({ tool, args });
    }

    if (!steps.length) {
      if (sawSecret) return { ok: false, reason: 'В шагах обнаружен пароль или ключ — такую команду не сохраняем' };
      if (sawDenied) return { ok: false, reason: 'Опасные или разовые шаги в повторяемую команду не сохраняются' };
      if (sawReadOnly) return { ok: false, reason: 'В ходе был только просмотр без повторяемого действия' };
      if (sawFailed) return { ok: false, reason: 'Неподтверждённые или неудавшиеся шаги нельзя сохранить как команду' };
      return { ok: false, reason: 'Нет подходящих повторяемых действий для сохранения' };
    }

    const cleanTitle = rawPhrase.replace(/^(?:джарвис|nox)[,:\s]+/i, '').replace(/[.!?]+$/u, '').trim() || 'Быстрая команда';
    const ch = Array.from(cleanTitle);
    let baseName = `${ch[0].toUpperCase()}${ch.slice(1).join('')}`;
    if (Array.from(baseName).length > 64) baseName = Array.from(baseName).slice(0, 64).join('').trim();
    const used = new Set((Array.isArray(existingCommands) ? existingCommands : []).map((c) => String(c?.name || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')));
    let name = baseName;
    let n = 2;
    while (used.has(name.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')) && n < 1000) {
      name = `${baseName} (${n++})`;
    }

    return {
      ok: true,
      draft: {
        schemaVersion: 2,
        version: 2,
        kind: 'sequence',
        name,
        phrases: [normPhrase],
        steps: steps.slice(0, 20),
        enabled: true,
        hotkey: null,
        folder: null,
        collections: [],
        origin: 'ai',
      },
    };
  }

  function createStore(deps = {}) {
    const ui = deps.ui || (typeof window !== 'undefined' ? window.JarvisUI : null);
    const bridge = deps.bridge || (typeof window !== 'undefined' ? window.NoxAetherBridge : null);
    const orbLib = deps.orbLib || (typeof window !== 'undefined' ? window.NoxOrbLibrary : null);
    const storage = deps.storage !== undefined ? deps.storage : (typeof localStorage !== 'undefined' ? localStorage : null);

    const scrub = (s) => (ui && typeof ui.scrub === 'function' ? ui.scrub(s) : String(s == null ? '' : s));
    const toolTitle = (name) => (ui && typeof ui.toolTitle === 'function' ? ui.toolTitle(name) : (name || 'Действие'));
    const cleanSummary = (s) => (ui && typeof ui.cleanSummary === 'function' ? ui.cleanSummary(s) : String(s || ''));
    const argsBrief = (a, max) => (ui && typeof ui.argsBrief === 'function' ? ui.argsBrief(a, max) : '');
    const statusOfResult = (ok, sum, rej, ver) => (ui && typeof ui.statusOfResult === 'function' ? ui.statusOfResult(ok, sum, rej, ver) : (ok ? 'done' : 'error'));

    let seq = 0;
    const nextId = (prefix = 'n') => `${prefix}-${++seq}`;

    const state = {
      route: 'chat',
      link: 'none',
      hasKey: false,
      stopped: false,
      handsActive: false,
      limitBanner: '',
      mode: 'ask',
      tier: 'fast',
      thinking: 'low',
      replyStyle: 'normal',
      settings: {
        voice: false,
        dictation: false,
        clipboardHistory: false,
        alwaysOnTop: false,
        desktopOverlay: false,
        alwaysListen: false,
        quiet: false,
        motion: true,
        autoStart: false,
        screenAuto: false,
        memoryAuto: true,
        terseReplies: true,
        keepAwake: 'while-working',
        uiShell: 'aether',
        workspace: '',
        connectedFolders: [],
      },
      account: null,
      workspaces: [],
      currentWorkspaceId: 'default',
      chats: [],
      activeChatId: null,
      historyOpen: false,
      historyLoading: false,
      sendingLock: false,
      pendingComposeAnim: false,
      agentMode: false,
      pendingCommandId: null,
      lastUserPhrase: '',
      feedItems: [],       // [{ id, kind: 'user'|'assistant'|'error'|'notice'|'task', ... }]
      activeTurn: null,    // { id, userPhrase, text, actions: [], actionsMap: Map, sources: [], detailsOpen: false, startedAt }
      lastSentPayload: null, // { text, files }
      drafts: new Map(),   // chatId -> { text, files }
      currentDraftText: '',
      currentDraftFiles: [],
      approvals: {
        queue: [],
        sending: new Set(),
        view: null,        // { id, seq, token, armed, shownAt }
        viewSeq: 0,
        gate: false,
        countdownTimer: 0,
      },
      taskApprovals: new Map(), // approvalId -> taskId
      taskCards: new Map(),     // taskId -> feedItem index/id
      rejectedCalls: new Set(),
      attentionTasks: [],
      dictation: {
        recording: false,
        mode: 'listening',
        full: false,
        hotkeyOk: true,
        level: 0,
        lastWake: '',
        error: '',
      },
      trackerState: 'idle',
      trackerBusy: false,
      trackerNote: '',
      trackerError: '',
      toasts: [],
    };

    const listeners = new Set();
    let emitQueued = false;
    function notify(immediate = false) {
      if (immediate || typeof queueMicrotask !== 'function') {
        emitQueued = false;
        for (const fn of listeners) {
          try { fn(state); } catch (e) { console.error('[aether/store] listener:', e); }
        }
        return;
      }
      if (emitQueued) return;
      emitQueued = true;
      queueMicrotask(() => {
        emitQueued = false;
        for (const fn of listeners) {
          try { fn(state); } catch (e) { console.error('[aether/store] listener:', e); }
        }
      });
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    function toast(text, kind = 'info') {
      const id = nextId('toast');
      state.toasts = [...state.toasts.slice(-3), { id, text: scrub(text), kind }];
      notify(true);
      setTimeout(() => {
        state.toasts = state.toasts.filter((t) => t.id !== id);
        notify();
      }, kind === 'error' ? 4500 : 2800);
    }

    const tracker = ui && typeof ui.StatusTracker === 'function'
      ? new ui.StatusTracker((t) => {
        state.trackerState = t.state;
        state.trackerBusy = Boolean(t.busy);
        state.trackerNote = t.note || '';
        state.trackerError = t.errorText || '';
        notify();
      }, () => {})
      : null;

    function getOrbEffectiveState() {
      if (state.link === 'none') return 'idle';
      if (state.stopped && !state.trackerBusy) return 'idle';
      if (state.approvals.queue.length > 0) return 'waiting_approval';
      if (state.dictation.recording && !state.trackerBusy) return 'listening';
      return state.trackerState || 'idle';
    }

    function saveCurrentDraft() {
      const key = state.activeChatId || '__default__';
      const hasContent = Boolean(state.currentDraftText.trim() || state.currentDraftFiles.length > 0);
      if (hasContent) {
        state.drafts.set(key, {
          text: state.currentDraftText,
          files: state.currentDraftFiles.slice(),
        });
      } else {
        state.drafts.delete(key);
      }
    }

    function restoreDraftFor(chatId) {
      const key = chatId || '__default__';
      const saved = state.drafts.get(key);
      state.currentDraftText = saved ? saved.text : '';
      state.currentDraftFiles = saved ? saved.files.slice() : [];
    }

    function setRoute(next) {
      if (!ROUTES.includes(next)) return;
      if (state.route === next) return;
      state.route = next;
      notify(true);
    }

    function toggleHistory(force) {
      state.historyOpen = typeof force === 'boolean' ? force : !state.historyOpen;
      try { if (storage) storage.setItem('aether.historyOpen', state.historyOpen ? '1' : '0'); } catch { /* ignore */ }
      notify(true);
    }

    function setDraftText(text) {
      state.currentDraftText = String(text || '');
      saveCurrentDraft();
    }

    function addDraftFiles(arr) {
      const incoming = Array.isArray(arr) ? arr : [];
      let skipped = 0;
      for (const f of incoming) {
        if (!f || !f.path) continue;
        if (state.currentDraftFiles.some((x) => x.path === f.path)) continue;
        if (state.currentDraftFiles.length >= 5) { skipped += 1; continue; }
        state.currentDraftFiles.push({
          name: String(f.name || f.path.split(/[\\/]/).pop()),
          path: String(f.path),
          size: Number(f.size) || 0,
        });
      }
      if (skipped > 0) toast('Не больше 5 вложений на сообщение');
      saveCurrentDraft();
      notify(true);
    }

    function removeDraftFile(pathToRemove) {
      state.currentDraftFiles = state.currentDraftFiles.filter((f) => f.path !== pathToRemove);
      saveCurrentDraft();
      notify(true);
    }

    // ── События ядра и спокойный ход ──────────────────────────────
    function lastFeedUserPhrase() {
      for (let i = state.feedItems.length - 1; i >= 0; i--) {
        const item = state.feedItems[i];
        if (item && item.kind === 'user' && item.text) return String(item.text).trim();
      }
      return String(state.lastUserPhrase || '').trim();
    }

    function ensureActiveTurn() {
      if (!state.activeTurn) {
        state.activeTurn = {
          id: nextId('turn'),
          kind: 'assistant',
          userPhrase: lastFeedUserPhrase(),
          text: '',
          actions: [],
          actionsMap: new Map(),
          sources: [],
          detailsOpen: false,
          startedAt: Date.now(),
        };
      } else if (!state.activeTurn.userPhrase) {
        state.activeTurn.userPhrase = lastFeedUserPhrase();
      }
      return state.activeTurn;
    }

    function finalizeActiveTurn(options = {}) {
      if (!state.activeTurn) return;
      const t = state.activeTurn;
      state.activeTurn = null;
      const hasBody = Boolean(t.text.trim() || t.actions.length > 0 || t.sources.length > 0);
      if (!hasBody && !options.cancelled && !options.forceKeep) {
        notify();
        return;
      }
      state.feedItems = [...state.feedItems, {
        id: t.id,
        kind: 'assistant',
        userPhrase: String(t.userPhrase || lastFeedUserPhrase() || '').trim(),
        text: t.text,
        actions: t.actions.map((a) => ({ ...a })),
        sources: t.sources.slice(),
        searchSources: options.searchSources || [],
        detailsOpen: false,
        cancelled: Boolean(options.cancelled),
        workStatus: options.status || '',
        workElapsedMs: Math.max(0, Date.now() - t.startedAt),
        savedCommandId: null,
        savedCommandName: '',
        savedCommandError: '',
        savingCommand: false,
      }];
      notify();
    }

    function appendNotice(text, extra = {}) {
      state.feedItems = [...state.feedItems, {
        id: nextId('notice'),
        kind: 'notice',
        text: scrub(text),
        ...extra,
      }];
      notify();
    }

    function humanErrorHeadline(raw) {
      const cleaned = scrub(raw || '');
      const m5 = /^Модель ответила ошибкой\s+(\d{3})/i.exec(cleaned);
      if (m5) return `Не удалось получить ответ (ошибка ${m5[1]}). Можно повторить запрос.`;
      if (/поток ответа модели оборвался|не ответила за|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT/i.test(cleaned)) {
        return 'Связь прервалась до завершения ответа. Попробуйте повторить запрос.';
      }
      return cleaned || 'Не удалось выполнить запрос';
    }

    function appendError(rawMessage, technical = '') {
      const full = scrub(technical || rawMessage || '');
      const headline = humanErrorHeadline(rawMessage);
      state.feedItems = [...state.feedItems, {
        id: nextId('err'),
        kind: 'error',
        text: headline,
        technical: full,
        retryPayload: state.lastSentPayload ? { ...state.lastSentPayload } : null,
      }];
      notify();
    }

    // Приводим tool_start/tool_result в подробный лог, оставляя снаружи только <=1 строку.
    function handleToolEvent(ev) {
      const turn = ensureActiveTurn();
      if (ev.type === 'tool_start' || ev.type === 'approval_request') {
        const id = ev.type === 'approval_request' ? (ev.callId || ev.id) : ev.id;
        const name = ev.name || ev.tool || '';
        let entry = turn.actionsMap.get(id);
        if (!entry) {
          entry = {
            id,
            tool: name,
            title: toolTitle(name),
            brief: argsBrief(ev.args, 64),
            args: ev.args || null,
            risk: ev.risk || null,
            status: ev.type === 'approval_request' ? 'pending' : 'running',
            summary: '',
            evidence: '',
            verified: null,
          };
          turn.actionsMap.set(id, entry);
          turn.actions.push(entry);
        } else {
          if (name) { entry.tool = name; entry.title = toolTitle(name); }
          entry.status = ev.type === 'approval_request' ? 'pending' : 'running';
        }
      } else if (ev.type === 'tool_result') {
        let entry = turn.actionsMap.get(ev.id);
        if (!entry) {
          entry = {
            id: ev.id,
            tool: ev.name || '',
            title: toolTitle(ev.name),
            brief: '',
            args: null,
            risk: null,
            status: 'done',
            summary: '',
            evidence: '',
            verified: null,
          };
          turn.actionsMap.set(ev.id, entry);
          turn.actions.push(entry);
        }
        if (ev.name) { entry.tool = ev.name; entry.title = toolTitle(ev.name); }
        entry.status = statusOfResult(ev.ok, ev.summary, state.rejectedCalls.has(ev.id), ev.verified);
        entry.summary = cleanSummary(ev.summary);
        entry.verified = ev.verified || null;
        entry.evidence = ev.evidence ? scrub(ev.evidence) : '';
        if (Array.isArray(ev.sources)) {
          for (const s of ev.sources) {
            if (s && s.url && !turn.sources.some((x) => x.url === s.url)) {
              turn.sources.push({ url: String(s.url), title: scrub(s.title || s.url), host: String(s.host || '') });
            }
          }
        }
      }
    }

    function toggleTurnDetails(turnId) {
      if (state.activeTurn && state.activeTurn.id === turnId) {
        state.activeTurn = { ...state.activeTurn, detailsOpen: !state.activeTurn.detailsOpen };
        notify(true);
        return;
      }
      state.feedItems = state.feedItems.map((item) => (item.id === turnId ? { ...item, detailsOpen: !item.detailsOpen } : item));
      notify(true);
    }

    // ── Безопасный поток подтверждений (R3-01 / 700ms arming) ───────
    function clearApprovalsForChat(runId) {
      if (!runId) return;
      const keep = state.approvals.queue.filter((q) => q.runId !== runId || state.taskApprovals.has(q.id));
      if (keep.length !== state.approvals.queue.length) {
        state.approvals.queue = keep;
        reconcileApprovalView();
        notify();
      }
    }

    function pushApproval(ev) {
      if (!ev || !ev.id) return;
      if (state.approvals.queue.some((q) => q.id === ev.id)) return;
      state.approvals.queue = [...state.approvals.queue, ev];
      if (!state.approvals.view && !state.approvals.gate) {
        showApprovalById(ev.id);
      }
      notify(true);
    }

    function dropApproval(id) {
      const had = state.approvals.queue.some((q) => q.id === id);
      if (!had) return;
      state.approvals.queue = state.approvals.queue.filter((q) => q.id !== id);
      reconcileApprovalView();
      notify(true);
    }

    function reconcileApprovalView() {
      const v = state.approvals.view;
      if (!v) return;
      if (!state.approvals.queue.length) {
        state.approvals.viewSeq += 1;
        state.approvals.view = null;
        state.approvals.gate = false;
        return;
      }
      if (!state.approvals.queue.some((q) => q.id === v.id)) {
        // Текущий запрос закрылся: не подменяем его другим под курсором! Ставим затвор (gate).
        state.approvals.viewSeq += 1;
        state.approvals.view = null;
        state.approvals.gate = true;
      }
    }

    async function showApprovalById(id) {
      const item = state.approvals.queue.find((q) => q.id === id);
      if (!item) return;
      const mySeq = ++state.approvals.viewSeq;
      state.approvals.gate = false;
      const view = {
        id: item.id,
        seq: mySeq,
        token: null,
        armed: false,
        delayDone: false,
        shownAt: Date.now(),
      };
      state.approvals.view = view;
      notify(true);

      setTimeout(() => {
        if (!state.approvals.view || state.approvals.view.seq !== mySeq) return;
        view.delayDone = true;
        view.armed = Boolean(view.token);
        notify(true);
      }, APPROVAL_ARM_MS);

      if (bridge && bridge.has('markApprovalShown')) {
        try {
          const res = await bridge.call('markApprovalShown', item.id);
          if (!state.approvals.view || state.approvals.view.seq !== mySeq) return;
          view.token = res && res.token ? res.token : null;
          view.armed = Boolean(view.token) && view.delayDone;
          notify(true);
        } catch {
          /* токен не получен — кнопки разрешения останутся неактивны, отказ работает всегда */
        }
      } else {
        view.token = 'stub-shown';
        view.armed = view.delayDone;
        notify(true);
      }
    }

    function openSpecificApproval(id) {
      const idx = state.approvals.queue.findIndex((q) => q.id === id);
      if (idx < 0) {
        toast('Запрос уже неактуален');
        return;
      }
      const next = state.approvals.queue.slice();
      const [picked] = next.splice(idx, 1);
      next.unshift(picked);
      state.approvals.queue = next;
      showApprovalById(picked.id);
    }

    async function respondApproval(decision, expectedSeq = null) {
      const v = state.approvals.view;
      if (!v) return;
      if (expectedSeq !== null && v.seq !== expectedSeq) return;
      if (decision !== 'reject' && !v.armed) return;
      if (state.approvals.sending.has(v.id)) return;
      const cur = state.approvals.queue.find((q) => q.id === v.id);
      if (!cur) return;

      state.approvals.sending.add(v.id);
      notify(true);
      let ok = false;
      let why = '';
      try {
        const res = await bridge.call('respondApproval', v.id, decision, v.token);
        ok = !(res && res.ok === false);
        why = res && typeof res.reason === 'string' ? res.reason : '';
      } catch (err) {
        ok = false;
        why = bridge ? bridge.errText(err) : String(err);
      }
      state.approvals.sending.delete(v.id);
      if (!ok) {
        toast(why ? `Не удалось передать решение: ${why}` : 'Решение не доставлено', 'error');
        if (bridge && bridge.has('listApprovals')) {
          try {
            const live = await bridge.call('listApprovals');
            if (Array.isArray(live) && !live.some((e) => e.id === v.id)) dropApproval(v.id);
          } catch { /* ignore */ }
        }
        notify(true);
        return;
      }
      if (decision === 'reject') state.rejectedCalls.add(cur.callId || cur.id);
      state.approvals.queue = state.approvals.queue.filter((q) => q.id !== v.id);
      state.approvals.viewSeq += 1;
      state.approvals.view = null;
      state.approvals.gate = false;
      if (state.approvals.queue.length > 0) showApprovalById(state.approvals.queue[0].id);
      else notify(true);
    }

    async function answerApprovalById(id, decision) {
      const cur = state.approvals.queue.find((q) => q.id === id);
      if (!cur) return;
      try {
        const r = await bridge.call('respondApproval', id, decision);
        if (r && r.ok === false) {
          toast(`Не удалось передать решение: ${r.reason || ''}`, 'error');
          return;
        }
      } catch (err) {
        toast(`Не удалось передать решение: ${bridge ? bridge.errText(err) : err}`, 'error');
        return;
      }
      if (decision === 'reject') state.rejectedCalls.add(cur.callId || cur.id);
      dropApproval(id);
    }

    // ── Событие от ядра ──────────────────────────────────────────
    function onAgentEvent(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'approval_request' && (state.taskApprovals.has(ev.id) || ev.taskId)) {
        if (ev.taskId) state.taskApprovals.set(ev.id, ev.taskId);
        pushApproval(ev);
        return;
      }
      if (ev.type === 'approval_closed') {
        const aid = ev.approvalId || ev.id;
        const ownTask = state.taskApprovals.has(aid);
        state.taskApprovals.delete(aid);
        dropApproval(aid);
        if (!ownTask && tracker) tracker.handle(ev);
        return;
      }

      switch (ev.type) {
        case 'quick_rearm_approval':
          if (state.approvals.view && state.approvals.view.id) showApprovalById(state.approvals.view.id);
          break;
        case 'quick_open_chat':
          (async () => {
            if (ev.workspaceId && ev.workspaceId !== state.currentWorkspaceId) await selectWorkspace(ev.workspaceId);
            if (ev.chatId && ev.chatId !== state.activeChatId) await selectChat(ev.chatId);
            setRoute('chat');
          })();
          break;
        case 'quick_user':
          state.lastUserPhrase = String(ev.text || '').trim();
          state.feedItems = [...state.feedItems, { id: nextId('u'), kind: 'user', text: String(ev.text || ''), files: [] }];
          ensureActiveTurn();
          break;
        case 'text': {
          const t = ensureActiveTurn();
          t.text += String(ev.delta || '');
          notify();
          break;
        }
        case 'hands':
          state.handsActive = ev.active === true;
          notify(true);
          break;
        case 'notice':
          appendNotice(ev.message || '');
          break;
        case 'tool_start':
        case 'approval_request':
          handleToolEvent(ev);
          if (ev.type === 'approval_request') pushApproval(ev);
          notify();
          break;
        case 'tool_result':
          handleToolEvent(ev);
          dropApproval(ev.id);
          notify();
          break;
        case 'error':
          appendError(ev.message, ev.message);
          break;
        case 'limit_pause': {
          const what = { week: 'Недельный лимит', day: 'Дневной лимит' }[ev.window] || 'Лимит на 5 часов';
          state.limitBanner = `${what} исчерпан. Продолжится автоматически позже.`;
          notify(true);
          break;
        }
        case 'limit_resume':
          state.limitBanner = '';
          notify(true);
          break;
        case 'task': {
          if (ev.workspaceId && ev.workspaceId !== state.currentWorkspaceId) break;
          if (/^на паузе: аварийный стоп/i.test(String(ev.message || ''))) state.stopped = true;
          const summary = cleanSummary(ev.message);
          if (ev.final && typeof ev.summary === 'string' && ev.summary.trim()) {
            state.feedItems = [...state.feedItems, { id: nextId('a'), kind: 'assistant', text: ev.summary, actions: [], sources: [], detailsOpen: false }];
          } else if (summary) {
            appendNotice(`Задача «${scrub(ev.title || 'без названия')}»: ${summary}`);
          }
          refreshAttention();
          break;
        }
        case 'done': {
          const cancelled = ev.cancelled === true || ev.status === 'cancelled';
          finalizeActiveTurn({ cancelled, status: ev.status, searchSources: ev.searchSources });
          clearApprovalsForChat(ev.runId);
          refreshChats().catch(() => {});
          break;
        }
        default:
          break;
      }
      if (tracker) tracker.handle(ev);
    }

    function onDictationEvent(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'mode') {
        if (typeof ev.mode === 'string') state.dictation.mode = ev.mode;
        if (typeof ev.full === 'boolean') state.dictation.full = ev.full;
        if (typeof ev.recording === 'boolean') state.dictation.recording = ev.recording;
        if (typeof ev.hotkeyOk === 'boolean') state.dictation.hotkeyOk = ev.hotkeyOk;
        if (tracker && typeof tracker.setListening === 'function') tracker.setListening(state.dictation.recording);
        if (typeof ev.reply === 'string' && ev.reply.trim()) toast(ev.reply.trim());
        notify(true);
      } else if (ev.type === 'state') {
        if (ev.state === 'listening') state.dictation.error = '';
        if (typeof ev.mode === 'string') state.dictation.mode = ev.mode;
        if (typeof ev.full === 'boolean') state.dictation.full = ev.full;
        if (typeof ev.recording === 'boolean') state.dictation.recording = ev.recording;
        else if (ev.state === 'listening' || ev.state === 'stopped') state.dictation.recording = ev.state === 'listening';
        if (tracker && typeof tracker.setListening === 'function') tracker.setListening(state.dictation.recording);
        notify(true);
      } else if (ev.type === 'level') {
        state.dictation.level = Math.max(0, Math.min(1, Number(ev.level) || 0));
        notify();
      } else if (ev.type === 'text') {
        const chunk = String(ev.text || '').trim();
        if (!chunk) return;
        state.currentDraftText = state.currentDraftText ? `${state.currentDraftText.replace(/\s+$/, '')} ${chunk}` : chunk;
        saveCurrentDraft();
        notify(true);
      } else if (ev.type === 'wake') {
        const cmd = String(ev.command || '').trim();
        state.dictation.lastWake = cmd;
        if (!cmd) {
          toast('Слушаю. Скажите команду после имени.');
          notify(true);
          return;
        }
        if (state.trackerBusy || state.sendingLock) {
          toast('Нокс занят — голосовая команда не отправлена', 'error');
          notify(true);
          return;
        }
        state.currentDraftText = cmd;
        saveCurrentDraft();
        sendChatMessage(cmd, state.currentDraftFiles);
      } else if (ev.type === 'error') {
        state.dictation.recording = false;
        state.dictation.error = String(ev.message || 'Голосовой ввод не запустился');
        if (tracker && typeof tracker.setListening === 'function') tracker.setListening(false);
        if (ev.message) toast(ev.message, 'error');
        notify(true);
      }
    }

    // ── Загрузка и синхронизация с IPC ───────────────────────────
    async function loadInitial() {
      const kind = await bridge.ensureBridge();
      state.link = kind;
      await Promise.allSettled([
        refreshCoreState(),
        refreshSettings(),
        refreshWorkspaces(),
        refreshChats(),
        refreshAccount(),
        refreshDictation(),
        refreshAttention(),
      ]);
      await loadChatHistory();
      notify(true);
    }

    async function refreshCoreState() {
      if (!bridge.has('getState')) return;
      try {
        const st = await bridge.call('getState');
        if (st && typeof st === 'object') {
          if (MODE_NAMES[st.mode]) state.mode = st.mode;
          state.hasKey = Boolean(st.hasKey);
          state.stopped = Boolean(st.stopped);
          notify();
        }
      } catch {
        state.link = 'none';
        notify();
      }
    }

    async function refreshSettings() {
      if (!bridge.has('getSettings')) return;
      try {
        const s = await bridge.call('getSettings');
        if (s && typeof s === 'object') {
          state.settings = { ...state.settings, ...s };
          if (TIER_NAMES[s.modelTier]) state.tier = s.modelTier;
          if (THINKING_NAMES[s.thinking]) state.thinking = s.thinking;
          if (s.replyStyle) state.replyStyle = s.replyStyle;
          if (document.documentElement) document.documentElement.dataset.animations = s.motion === false ? 'off' : 'on';
          notify();
        }
      } catch { /* ignore */ }
    }

    let accountRefreshId = 0;
    async function refreshAccount() {
      const id = ++accountRefreshId;
      try {
        const st = bridge.has('accountState') ? await bridge.call('accountState') : { enabled: false };
        if (id === accountRefreshId && st && typeof st === 'object') {
          state.account = st;
          notify();
        }
      } catch {
        if (id === accountRefreshId) {
          state.account = { enabled: true, offline: true };
          notify();
        }
      }
    }

    async function refreshWorkspaces() {
      if (!bridge.has('workspacesList')) return;
      try {
        const data = await bridge.call('workspacesList');
        if (data && data.ok !== false && Array.isArray(data.spaces)) {
          state.workspaces = data.spaces;
          state.currentWorkspaceId = data.selected || 'default';
        }
      } catch { /* ignore */ }
    }

    async function refreshChats(silent = false) {
      if (!bridge.has('chatList')) return;
      try {
        const data = await bridge.call('chatList');
        if (data && Array.isArray(data.chats)) {
          state.chats = data.chats;
          if (data.activeId) state.activeChatId = data.activeId;
          if (!silent) notify();
        }
      } catch { /* ignore */ }
    }

    async function refreshDictation() {
      if (!bridge.has('dictationState')) return;
      try {
        const r = await bridge.call('dictationState');
        if (r && r.ok !== false) {
          state.dictation.hotkeyOk = r.hotkeyOk !== false;
          state.dictation.mode = r.mode || 'listening';
          state.dictation.full = r.full === true;
          state.dictation.recording = r.recording === true;
        }
      } catch { /* ignore */ }
    }

    async function refreshAttention() {
      if (!bridge.has('tasksAttention')) return;
      try {
        const rows = await bridge.call('tasksAttention');
        state.attentionTasks = Array.isArray(rows) ? rows : [];
      } catch { state.attentionTasks = []; }
    }

    let histSeq = 0;
    async function loadChatHistory() {
      if (!bridge.has('chatHistory')) {
        state.feedItems = [];
        notify(true);
        return;
      }
      const mySeq = ++histSeq;
      state.historyLoading = true;
      notify();
      try {
        const rows = await bridge.call('chatHistory');
        if (mySeq !== histSeq) return;
        const arr = Array.isArray(rows) ? rows : [];
        state.activeTurn = null;
        state.pendingComposeAnim = false;
        state.lastUserPhrase = '';
        let prevUserPhrase = '';
        state.feedItems = arr.map((m) => {
          if (m.role === 'user') {
            const parsed = parseUserHistory(m.text);
            prevUserPhrase = String(parsed.text || '').trim();
            return { id: nextId('u'), kind: 'user', text: parsed.text, files: parsed.names.map((n) => ({ name: n })) };
          }
          return {
            id: nextId('a'),
            kind: 'assistant',
            userPhrase: prevUserPhrase,
            text: String(m.text || ''),
            actions: [],
            sources: [],
            searchSources: Array.isArray(m.searchSources) ? m.searchSources : [],
            detailsOpen: false,
            savedCommandId: null,
            savedCommandName: '',
            savedCommandError: '',
            savingCommand: false,
          };
        });
      } catch (err) {
        if (mySeq === histSeq) toast(`История не загрузилась: ${bridge.errText(err)}`, 'error');
      } finally {
        if (mySeq === histSeq) {
          state.historyLoading = false;
          notify(true);
        }
      }
    }

    // ── Действия чата, режима агента и сохранения команд ──────────
    function toggleAgentMode(force) {
      const next = typeof force === 'boolean' ? force : !state.agentMode;
      if (state.agentMode === next) return next;
      state.agentMode = next;
      notify(true);
      return next;
    }

    function openSavedCommand(id) {
      if (!id) return false;
      state.pendingCommandId = String(id);
      setRoute('commands');
      return true;
    }

    function consumePendingCommandId() {
      const id = state.pendingCommandId;
      state.pendingCommandId = null;
      return id || null;
    }

    async function saveTurnAsCommand(turnId) {
      const idx = state.feedItems.findIndex((x) => x && x.id === turnId && x.kind === 'assistant');
      if (idx < 0) return { ok: false, reason: 'Ответ не найден' };
      const item = state.feedItems[idx];
      if (item.savedCommandId) {
        return { ok: true, id: item.savedCommandId, alreadySaved: true };
      }
      if (item.savingCommand) {
        return { ok: false, reason: 'Уже сохраняем' };
      }

      const patchItem = (patch) => {
        const curIdx = state.feedItems.findIndex((x) => x && x.id === turnId && x.kind === 'assistant');
        if (curIdx < 0) return;
        const copy = state.feedItems.slice();
        copy[curIdx] = { ...copy[curIdx], ...patch };
        state.feedItems = copy;
      };

      let phrase = String(item.userPhrase || '').trim();
      if (!phrase) {
        for (let i = idx - 1; i >= 0; i--) {
          const prev = state.feedItems[i];
          if (prev && prev.kind === 'user' && prev.text) {
            phrase = String(prev.text).trim();
            break;
          }
        }
      }

      patchItem({ savingCommand: true, savedCommandError: '' });
      notify(true);

      let existingCommands = [];
      if (bridge && bridge.has('listCommands')) {
        try {
          const listRes = await bridge.call('listCommands');
          existingCommands = Array.isArray(listRes)
            ? listRes
            : (listRes && Array.isArray(listRes.commands) ? listRes.commands : []);
        } catch { existingCommands = []; }
      }

      let draftRes;
      try {
        if (bridge && bridge.has('draftCommandFromTurn')) {
          draftRes = await bridge.call('draftCommandFromTurn', {
            phrase,
            actions: item.actions || [],
            existingCommands,
          });
        } else {
          draftRes = buildClientCommandDraft(phrase, item.actions || [], existingCommands);
        }
      } catch (err) {
        draftRes = { ok: false, reason: bridge ? bridge.errText(err) : String(err && err.message || err) };
      }

      if (!draftRes || draftRes.ok === false || !draftRes.draft) {
        const reason = (draftRes && (draftRes.reason || draftRes.error)) || 'Не удалось собрать команду';
        patchItem({ savingCommand: false, savedCommandError: reason });
        toast(reason, 'error');
        notify(true);
        return { ok: false, reason };
      }

      if (!bridge || !bridge.has('saveCommand')) {
        const reason = 'Сохранение команд недоступно';
        patchItem({ savingCommand: false, savedCommandError: reason });
        toast(reason, 'error');
        notify(true);
        return { ok: false, reason };
      }

      let saved;
      try {
        saved = await bridge.call('saveCommand', draftRes.draft);
      } catch (err) {
        saved = { ok: false, error: bridge.errText(err) };
      }

      if (!saved || saved.ok === false) {
        const reason = (saved && (saved.error || saved.reason)) || 'Команда не сохранилась';
        patchItem({ savingCommand: false, savedCommandError: reason });
        toast(reason, 'error');
        notify(true);
        return { ok: false, reason };
      }

      const cmd = saved.command || draftRes.draft;
      const savedId = String(cmd.id || saved.id || draftRes.draft.name);
      const savedName = String(cmd.name || draftRes.draft.name || '');
      patchItem({
        savingCommand: false,
        savedCommandId: savedId,
        savedCommandName: savedName,
        savedCommandError: '',
      });
      toast(`Команда «${savedName || 'Новая команда'}» сохранена`);
      notify(true);
      return { ok: true, id: savedId, command: cmd };
    }

    async function sendChatMessage(rawText, rawFiles = state.currentDraftFiles) {
      if (state.sendingLock || state.trackerBusy) return { ok: false, reason: 'busy' };
      const text = String(rawText || '').trim();
      const files = Array.isArray(rawFiles) ? rawFiles.slice() : [];
      if (!text && !files.length) return { ok: false, reason: 'empty' };

      const wasEmpty = isEmptyChatState(state);
      const sendText = text || 'Посмотри приложенные файлы.';
      state.sendingLock = true;
      state.pendingComposeAnim = wasEmpty;
      state.lastSentPayload = { text: sendText, files: files.map((f) => ({ ...f })) };
      state.lastUserPhrase = text;

      // Сразу отображаем реплику и очищаем текущий черновик (без дублей).
      state.feedItems = [...state.feedItems, {
        id: nextId('u'),
        kind: 'user',
        text: sendText,
        files: files.map((f) => ({ name: f.name, path: f.path, size: f.size })),
      }];
      state.currentDraftText = '';
      state.currentDraftFiles = [];
      saveCurrentDraft();
      ensureActiveTurn();
      if (tracker) tracker.markSent();
      notify(true);

      let result;
      try {
        const filePaths = files.map((f) => f.path);
        result = state.agentMode
          ? await bridge.call('send', sendText, filePaths, { agentMode: true })
          : await bridge.call('send', sendText, filePaths);
      } catch (err) {
        result = { ok: false, error: bridge.errText(err) };
      } finally {
        state.sendingLock = false;
        state.pendingComposeAnim = false;
      }

      if (result && result.ok === false) {
        if (tracker) tracker.reset();
        finalizeActiveTurn({ status: 'failed' });
        appendError(result.error || 'Не удалось отправить сообщение', result.error || '');
      }
      await refreshChats();
      notify(true);
      return result || { ok: true };
    }

    async function stopRun() {
      try { await bridge.call('stop'); } catch (err) { toast(`Не удалось остановить: ${bridge.errText(err)}`, 'error'); }
      if (tracker) tracker.reset();
      notify(true);
    }

    async function createNewChat() {
      if (state.trackerBusy || state.sendingLock) {
        toast('Дождитесь окончания или остановите текущий ход');
        return false;
      }
      saveCurrentDraft();
      try {
        const res = await bridge.call('chatNew');
        if (res && res.ok === false) { toast(res.error || 'Не удалось создать чат', 'error'); return false; }
        await refreshChats(true);
        restoreDraftFor(state.activeChatId);
        await loadChatHistory();
        setRoute('chat');
        return true;
      } catch (err) {
        toast(`Не удалось создать чат: ${bridge.errText(err)}`, 'error');
        return false;
      }
    }

    async function selectChat(chatId) {
      if (!chatId || chatId === state.activeChatId) return true;
      if (state.trackerBusy || state.sendingLock) {
        toast('Остановите текущий ход перед сменой чата');
        return false;
      }
      saveCurrentDraft();
      try {
        const res = await bridge.call('chatSelect', chatId);
        if (res && res.ok === false) { toast(res.error || 'Чат не открылся', 'error'); return false; }
        await refreshChats(true);
        restoreDraftFor(state.activeChatId);
        await loadChatHistory();
        setRoute('chat');
        return true;
      } catch (err) {
        toast(`Чат не открылся: ${bridge.errText(err)}`, 'error');
        return false;
      }
    }

    async function closeChat(chatId) {
      if (state.trackerBusy || state.sendingLock) {
        toast('Сначала остановите текущий ход');
        return false;
      }
      try {
        const res = await bridge.call('chatClose', chatId);
        if (res && res.ok === false) { toast(res.error || 'Не удалось закрыть чат', 'error'); return false; }
        state.drafts.delete(chatId);
        await refreshChats(true);
        restoreDraftFor(state.activeChatId);
        await loadChatHistory();
        return true;
      } catch (err) {
        toast(`Не удалось закрыть чат: ${bridge.errText(err)}`, 'error');
        return false;
      }
    }

    async function clearActiveChat() {
      if (state.trackerBusy || state.sendingLock) {
        toast('Сначала остановите текущий ход');
        return false;
      }
      try {
        const res = await bridge.call('clearChat');
        if (res && res.ok === false) { toast(res.error || 'Не удалось очистить', 'error'); return false; }
        state.activeTurn = null;
        state.feedItems = [];
        state.lastUserPhrase = '';
        notify(true);
        toast('Чат очищен', 'ok');
        return true;
      } catch (err) {
        toast(`Не удалось очистить: ${bridge.errText(err)}`, 'error');
        return false;
      }
    }

    async function selectWorkspace(id) {
      if (state.trackerBusy || state.sendingLock) { toast('Остановите текущий ход'); return false; }
      saveCurrentDraft();
      try {
        const res = await bridge.call('workspacesSelect', id);
        if (res && res.ok === false) { toast(res.error || 'Пространство не открылось', 'error'); return false; }
        await refreshWorkspaces();
        await refreshChats(true);
        restoreDraftFor(state.activeChatId);
        await loadChatHistory();
        await refreshSettings();
        toast('Пространство переключено', 'ok');
        return true;
      } catch (err) {
        toast(`Пространство не открылось: ${bridge.errText(err)}`, 'error');
        return false;
      }
    }

    async function createWorkspace(name) {
      const clean = String(name || '').trim();
      if (!clean) return false;
      try {
        const res = await bridge.call('workspacesCreate', clean);
        if (!res || res.ok === false) { toast((res && res.error) || 'Не удалось создать', 'error'); return false; }
        await refreshWorkspaces();
        if (res.space && res.space.id) await selectWorkspace(res.space.id);
        return true;
      } catch (err) {
        toast(`Ошибка создания: ${bridge.errText(err)}`, 'error');
        return false;
      }
    }

    async function setMode(mode) {
      try {
        const r = await bridge.call('setMode', mode);
        if (r && r.ok !== false && MODE_NAMES[r.mode || mode]) {
          state.mode = r.mode || mode;
          notify(true);
          return true;
        }
      } catch (err) { toast(bridge.errText(err), 'error'); }
      return false;
    }

    async function setTier(tier) {
      try {
        const r = await bridge.call('setModelTier', tier);
        if (r && r.ok !== false) { state.tier = r.tier || tier; state.settings.modelTier = state.tier; notify(true); return true; }
      } catch (err) { toast(bridge.errText(err), 'error'); }
      return false;
    }

    async function setThinking(level) {
      try {
        const r = await bridge.call('setThinking', level);
        if (r && r.ok !== false) { state.thinking = r.level || level; state.settings.thinking = state.thinking; notify(true); return true; }
      } catch (err) { toast(bridge.errText(err), 'error'); }
      return false;
    }

    async function setSetting(key, value) {
      const prev = state.settings[key];
      state.settings[key] = value;
      if (key === 'motion' && typeof document !== 'undefined') {
        document.documentElement.dataset.animations = value ? 'on' : 'off';
        try { if (storage) storage.setItem('aether.motion', value ? 'on' : 'off'); } catch { /* ignore */ }
      }
      notify(true);
      try {
        const r = await bridge.call('setSetting', key, value);
        if (r && r.ok === false) throw new Error(r.error || 'отклонено');
        return true;
      } catch (err) {
        state.settings[key] = prev;
        notify(true);
        toast(`Настройка не сохранилась: ${bridge.errText(err)}`, 'error');
        return false;
      }
    }

    async function toggleDictation() {
      if (state.settings.dictation !== true) {
        toast('Сначала включите диктовку в Настройках');
        return;
      }
      try {
        if (state.dictation.recording && !state.dictation.error) {
          await bridge.call('dictationStop');
        } else {
          const result = await bridge.call('dictationStart');
          if (result?.ok === false) onDictationEvent({ type: 'error', message: 'Не удалось включить голосовой ввод' });
        }
      } catch (err) {
        toast(`Микрофон: ${bridge.errText(err)}`, 'error');
      }
    }

    async function cycleDictationMode() {
      if (state.settings.dictation !== true) { toast('Включите диктовку в Настройках'); return; }
      const order = ['listening', 'quiet', 'off'];
      const next = state.dictation.recording ? order[(order.indexOf(state.dictation.mode) + 1) % order.length] : 'listening';
      try {
        const r = await bridge.call('dictationMode', next);
        if (r && r.ok !== false) onDictationEvent({ type: 'mode', ...r });
      } catch (err) { toast(`Микрофон: ${bridge.errText(err)}`, 'error'); }
    }

    return {
      ROUTES,
      MODE_NAMES,
      TIER_NAMES,
      THINKING_NAMES,
      state,
      subscribe,
      notify,
      toast,
      setRoute,
      toggleHistory,
      consumeComposeAnim: () => {
        if (!state.pendingComposeAnim) return false;
        state.pendingComposeAnim = false;
        return true;
      },
      setDraftText,
      addDraftFiles,
      removeDraftFile,
      toggleTurnDetails,
      isEmptyChat: () => isEmptyChatState(state),
      getLiveWorkText: () => formatLiveWorkSummary({
        trackerState: state.trackerState,
        note: state.trackerNote,
        currentAction: state.activeTurn && state.activeTurn.actions[state.activeTurn.actions.length - 1],
        pendingApprovalCount: state.approvals.queue.length,
      }),
      getOrbEffectiveState,
      onAgentEvent,
      onDictationEvent,
      loadInitial,
      refreshCoreState,
      refreshSettings,
      refreshWorkspaces,
      refreshChats,
      refreshAccount,
      refreshDictation,
      refreshAttention,
      loadChatHistory,
      sendChatMessage,
      stopRun,
      toggleAgentMode,
      saveTurnAsCommand,
      openSavedCommand,
      consumePendingCommandId,
      createNewChat,
      selectChat,
      closeChat,
      clearActiveChat,
      selectWorkspace,
      createWorkspace,
      setMode,
      setTier,
      setThinking,
      setSetting,
      toggleDictation,
      cycleDictationMode,
      openSpecificApproval,
      respondApproval,
      answerApprovalById,
      showApprovalById,
    };
  }

  const exported = {
    ROUTES,
    MODE_NAMES,
    TIER_NAMES,
    THINKING_NAMES,
    APPROVAL_ARM_MS,
    parseUserHistory,
    isEmptyChatState,
    formatLiveWorkSummary,
    buildClientCommandDraft,
    createStore,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.NoxAetherStore = exported;
})(typeof window !== 'undefined' ? window : globalThis);
