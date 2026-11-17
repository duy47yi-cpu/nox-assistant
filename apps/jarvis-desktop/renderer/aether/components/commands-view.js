/* Раздел «Редактор команд» Nox Aether (Фаза 2):
 * - Дерево команд и вложенных шагов (40px строки, отступ 24px/уровень, перетаскивание и смена родителя);
 * - Голосовая запись шага на микрофон строки (через существующее распознавание Windows, без выдуманных шагов);
 * - Создание команды: «Скажите / Напишите / Опишите словами» (3 шага: 1 Описание -> 2 Проверка -> 3 Готово);
 * - Паки команд в один клик и журнал запусков (успех / частично / отказ + длительность). */
(() => {
  'use strict';

  const STEP_TYPES = [
    { type: 'app_start', tool: 'app_open', label: 'Запуск программы', icon: 'terminal', argKey: 'name', placeholder: 'OBS Studio, chrome, notepad…' },
    { type: 'hotkey', tool: 'ui_keys', label: 'Сочетание клавиш', icon: 'keyboard', argKey: 'keys', placeholder: 'Ctrl+Shift+S, Alt+Tab…' },
    { type: 'click', tool: 'ui_click', label: 'Клик по элементу', icon: 'mousePointer', argKey: 'target', placeholder: 'Кнопка «Отправить» или координаты' },
    { type: 'volume', tool: 'volume_set', label: 'Громкость звука', icon: 'volume', argKey: 'percent', placeholder: '0–100' },
    { type: 'type_text', tool: 'ui_type', label: 'Ввод текста', icon: 'pencil', argKey: 'text', placeholder: 'Текст для ввода' },
    { type: 'wait', tool: 'wait', label: 'Пауза', icon: 'clock', argKey: 'ms', placeholder: 'Миллисекунд, например 1000' },
    { type: 'ai', tool: 'speak', label: 'Сказать / Ответ', icon: 'sparkles', argKey: 'text', placeholder: 'Что сказать или выполнить' },
  ];

  const STEP_TYPE_META = Object.fromEntries(STEP_TYPES.map((t) => [t.type, t]));

  function cloneJson(val, fallback) {
    try {
      return JSON.parse(JSON.stringify(val));
    } catch {
      return fallback;
    }
  }

  function spanText(text) {
    const el = document.createElement('span');
    el.textContent = String(text || '');
    return el;
  }

  function emitCommandsUpdated() {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('nox:commands-updated'));
    }
  }

  function createCommandsView({ store, bridge }) {
    const ui = window.JarvisUI || {};
    const { icon } = window.NoxAetherIcons;
    const scrub = typeof ui.scrub === 'function' ? ui.scrub : (s) => String(s || '');
    const toolTitle = typeof ui.toolTitle === 'function' ? ui.toolTitle : (t) => String(t || 'Шаг');
    const argsBrief = typeof ui.argsBrief === 'function' ? ui.argsBrief : () => '';
    const rawCs = window.CmdSteps || {};
    const TOOL_TO_TYPE_FB = {
      app_open: 'app_start', ui_keys: 'hotkey', ui_click: 'click', desktop_click: 'click',
      volume_set: 'volume', ui_type: 'type_text', desktop_type: 'type_text', wait: 'wait', speak: 'ai', shell_run: 'shell',
    };
    const TYPE_TO_TOOL_FB = Object.fromEntries(STEP_TYPES.map((s) => [s.type, s.tool]));
    const normTreeFb = (steps, depth = 0) => (Array.isArray(steps) ? steps : []).map((s, idx) => {
      if (!s || typeof s !== 'object') return null;
      const tool = s.tool || TYPE_TO_TOOL_FB[s.type] || 'wait';
      const type = s.type || TOOL_TO_TYPE_FB[tool] || 'wait';
      const args = s.args && typeof s.args === 'object' ? { ...s.args } : { ...(s.params || {}) };
      const params = s.params && typeof s.params === 'object' ? { ...s.params } : { ...args };
      return {
        ...s,
        id: s.id || `s-${depth}-${idx}`,
        type,
        tool,
        params,
        args,
        children: normTreeFb(s.children, depth + 1),
      };
    }).filter(Boolean);
    // Пауза живёт по контракту инструмента wait: миллисекунды в ms (0…10000), секунд нет.
    // Запасные копии нужны, если чистый модуль cmd-steps.js не загрузился.
    const FB_WAIT_MAX_MS = 10000;
    const fbWaitMsFromSeconds = (value) => {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) return 0;
      return Math.min(FB_WAIT_MAX_MS, Math.round(seconds * 1000));
    };
    const fbMigrateWaitParams = (params) => {
      if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
      if (!Object.prototype.hasOwnProperty.call(params, 'seconds')) return null;
      const { seconds, ...rest } = params;
      const explicitMs = Number(rest.ms);
      const ms = rest.ms !== undefined && Number.isFinite(explicitMs) ? explicitMs : fbWaitMsFromSeconds(seconds);
      return { ...rest, ms };
    };
    const fbWaitStepArgs = (type, tool, params, args) => {
      if (type !== 'wait' && tool !== 'wait') return { params, args };
      let nextParams = fbMigrateWaitParams(params) || params;
      let nextArgs = fbMigrateWaitParams(args) || args;
      if (nextParams.ms === undefined && nextArgs.ms !== undefined) nextParams = { ...nextParams, ms: nextArgs.ms };
      if (nextArgs.ms === undefined && nextParams.ms !== undefined) nextArgs = { ...nextArgs, ms: nextParams.ms };
      return { params: nextParams, args: nextArgs };
    };
    const cmdSteps = {
      TOOL_TO_STEP_TYPE: rawCs.TOOL_TO_STEP_TYPE || TOOL_TO_TYPE_FB,
      WAIT_MAX_MS: rawCs.WAIT_MAX_MS || FB_WAIT_MAX_MS,
      defaultStepParams: rawCs.defaultStepParams || ((type, argKey = 'text') => (
        type === 'volume' ? { percent: 50 }
          : type === 'wait' ? { ms: 1000 }
            : type === 'hotkey' ? { keys: 'Ctrl+S' }
              : { [argKey || 'text']: '' }
      )),
      migrateWaitParams: rawCs.migrateWaitParams || fbMigrateWaitParams,
      // Параметры паузы всегда в миллисекундах: params для редактора, args для runner.
      waitStepArgs: rawCs.waitStepArgs || fbWaitStepArgs,
      normalizeStepTree: rawCs.normalizeStepTree || normTreeFb,
      countTreeSteps: rawCs.countTreeSteps || ((arr) => (Array.isArray(arr) ? arr : []).reduce((n, s) => n + 1 + (s?.children ? normTreeFb(s.children).length : 0), 0)),
      groupCommands: rawCs.groupCommands || ((list) => [{ folder: null, title: 'Без папки', commands: Array.isArray(list) ? list : [] }]),
      foldersOf: rawCs.foldersOf || (() => []),
      flattenTreeForRender: rawCs.flattenTreeForRender || ((list, collapsed = new Set(), p = []) => {
        const out = [];
        (Array.isArray(list) ? list : []).forEach((node, i) => {
          const path = [...p, i];
          const ch = Array.isArray(node.children) ? node.children : [];
          out.push({ node, path, depth: p.length, hasChildren: ch.length > 0, collapsed: collapsed.has(node.id), labelIndex: `${i + 1}` });
          if (ch.length && !collapsed.has(node.id)) out.push(...cmdSteps.flattenTreeForRender(ch, collapsed, path));
        });
        return out;
      }),
      getNodeAtPath: rawCs.getNodeAtPath || ((list, path) => {
        let cur = null; let arr = Array.isArray(list) ? list : [];
        for (const i of path || []) { cur = arr[i]; if (!cur) return null; arr = cur.children || []; }
        return cur;
      }),
      insertTreeNode: rawCs.insertTreeNode || ((list, p, idx, node) => (!p || !p.length ? [...list.slice(0, idx), node, ...list.slice(idx)] : list)),
      updateTreeNode: rawCs.updateTreeNode || ((list) => list),
      deleteTreeNode: rawCs.deleteTreeNode || ((list, p) => (p && p.length === 1 ? list.filter((_, i) => i !== p[0]) : list)),
      moveTreeNode: rawCs.moveTreeNode || ((steps, path) => ({ steps, path })),
      indentTreeNode: rawCs.indentTreeNode || ((steps, path) => ({ steps, path })),
      outdentTreeNode: rawCs.outdentTreeNode || ((steps, path) => ({ steps, path })),
      moveTreeNodeTo: rawCs.moveTreeNodeTo || ((steps, fromPath) => ({ steps, path: fromPath })),
      describeSteps: rawCs.describeSteps || ((steps, titleFn, briefFn) => (Array.isArray(steps) ? steps : []).map((s, i) => `${i + 1}. ${titleFn(s.tool)}: ${briefFn(s.args)}`)),
      normalizeTriggersModel: rawCs.normalizeTriggersModel || ((tr, hk) => ({ hotkey: { enabled: Boolean(hk), key: hk || null }, schedule: { enabled: false }, event: { enabled: false }, ...(tr || {}) })),
      filterLaunchLog: rawCs.filterLaunchLog || (() => []),
    };

    const root = document.createElement('section');
    root.className = 'ae-page lx-cmd-page';
    root.id = 'aeCommandsView';
    root.hidden = true;
    root.setAttribute('aria-label', 'Редактор команд');

    // ── Состояние UI ─────────────────────────────────────────────
    let viewMode = 'tree'; // 'tree' | 'new' | 'packs' | 'launches'
    let newSubTab = 'describe'; // 'say' | 'write' | 'describe'
    let loaded = false;
    let dirtyReload = false;
    let commandsList = [];
    let packsList = [];
    let launchOverview = null;

    let searchQuery = '';
    let selectedKind = 'root'; // 'root' | 'folder' | 'command' | 'phrases' | 'step'
    let selectedCommandId = null;
    let selectedFolderKey = null;
    let selectedStepPath = null; // number[]
    let inspectorOpen = false;

    const collapsedFolders = new Set();
    const collapsedCommands = new Set();
    const collapsedStepIds = new Set();
    let rootCollapsed = false;

    let draft = null;
    let savedSnapshot = null;
    let dirty = false;
    let draftError = '';

    // Голосовая запись (строка или вкладка «Скажите»)
    let voiceTarget = null; // null | { mode: 'step', path } | { mode: 'say' }
    let voiceTranscript = '';
    let voiceBannerText = '';
    let voiceBannerIsError = false;

    // «Опишите словами» (шаги 1 -> 2 -> 3)
    let aiStep = 1; // 1 | 2 | 3
    let aiDescription = '';
    let aiBusy = false;
    let aiDraft = null; // { name, phrases, hotkey, confirm, program, steps: [{ step, checked }] }
    let aiMissing = [];
    let aiError = '';

    // Ручная новая команда («Напишите»)
    let writeDraft = null;
    let writeSelectedPath = null;

    // Фильтры журнала запусков
    let logFilterStatus = 'all';
    let logFilterTrigger = 'all';

    // Состояние перетаскивания
    let dragFromPath = null;

    // ── DOM каркас ───────────────────────────────────────────────
    const toolbar = document.createElement('div');
    toolbar.className = 'lx-cmd-toolbar';

    const seg = document.createElement('div');
    seg.className = 'lx-cmd-seg';
    seg.setAttribute('role', 'tablist');

    const segEditBtn = document.createElement('button');
    segEditBtn.type = 'button';
    segEditBtn.id = 'lxCmdTabEdit';
    segEditBtn.className = 'lx-cmd-seg-btn is-active';
    segEditBtn.textContent = 'Редактировать';
    segEditBtn.addEventListener('click', () => {
      viewMode = 'tree';
      renderView();
    });

    const segNewBtn = document.createElement('button');
    segNewBtn.type = 'button';
    segNewBtn.id = 'lxCmdTabNew';
    segNewBtn.className = 'lx-cmd-seg-btn';
    segNewBtn.textContent = 'Новая команда';
    segNewBtn.addEventListener('click', () => {
      viewMode = 'new';
      if (!writeDraft) resetWriteDraft();
      renderView();
    });

    seg.append(segEditBtn, segNewBtn);

    const toolsRight = document.createElement('div');
    toolsRight.className = 'lx-cmd-tools-right';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'lx-cmd-search-wrap';
    const searchIco = icon('search', 'lx-cmd-search-ico');
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.id = 'lxCmdSearch';
    searchInput.className = 'lx-cmd-search-input';
    searchInput.placeholder = 'Поиск..';
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      if (viewMode !== 'tree') viewMode = 'tree';
      renderBody();
    });
    searchWrap.append(searchIco, searchInput);

    function makeToolbarIcoBtn(id, iconName, title, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.className = 'lx-cmd-ico-btn';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.append(icon(iconName));
      b.addEventListener('click', onClick);
      return b;
    }

    const packsBtn = makeToolbarIcoBtn('lxCmdBtnPacks', 'archive', 'Готовые паки команд', async () => {
      viewMode = viewMode === 'packs' ? 'tree' : 'packs';
      if (viewMode === 'packs') await loadPacks();
      renderView();
    });

    const newFolderBtn = makeToolbarIcoBtn('lxCmdBtnFolder', 'folder', 'Назначить папку / Новая папка', () => {
      const name = (commandsList.length ? `Папка ${cmdSteps.foldersOf(commandsList).length + 1}` : 'Мои команды');
      if (draft) {
        draft.folder = draft.folder || name;
        inspectorOpen = true;
        markDirty();
        viewMode = 'tree';
        renderView();
      } else {
        openNewWriteCommand({ folder: name });
      }
    });

    const addStepBtn = makeToolbarIcoBtn('lxCmdBtnAddStep', 'file', 'Добавить шаг в команду', () => {
      if (!draft && commandsList.length) {
        selectCommandById(commandsList[0].id, false);
      }
      if (!draft) {
        openNewWriteCommand({});
        return;
      }
      const nextStep = makeDefaultStep('wait');
      if (selectedStepPath && selectedStepPath.length) {
        const parentPath = selectedStepPath.slice(0, -1);
        const insertAt = selectedStepPath[selectedStepPath.length - 1] + 1;
        draft.steps = cmdSteps.insertTreeNode(draft.steps, parentPath, insertAt, nextStep);
        selectedStepPath = [...parentPath, insertAt];
      } else {
        draft.steps = cmdSteps.insertTreeNode(draft.steps, [], draft.steps.length, nextStep);
        selectedStepPath = [draft.steps.length - 1];
      }
      selectedKind = 'step';
      collapsedCommands.delete(draft.id);
      inspectorOpen = true;
      viewMode = 'tree';
      markDirty();
      renderView();
    });

    const launchesBtn = makeToolbarIcoBtn('lxCmdBtnLaunches', 'link', 'Триггеры и журнал запусков', async () => {
      viewMode = viewMode === 'launches' ? 'tree' : 'launches';
      if (viewMode === 'launches') await loadLaunches();
      renderView();
    });

    const sepDot = document.createElement('span');
    sepDot.className = 'lx-cmd-sep';
    sepDot.setAttribute('aria-hidden', 'true');

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.id = 'lxCmdSave';
    saveBtn.className = 'lx-cmd-save-btn';
    saveBtn.textContent = 'Сохранить';
    saveBtn.addEventListener('click', () => {
      if (viewMode === 'new' && newSubTab === 'write') saveWriteDraft();
      else saveActiveDraft();
    });

    toolsRight.append(searchWrap, packsBtn, newFolderBtn, addStepBtn, launchesBtn, sepDot, saveBtn);
    toolbar.append(seg, toolsRight);

    const voiceBanner = document.createElement('div');
    voiceBanner.className = 'lx-cmd-voice-banner';
    voiceBanner.hidden = true;

    const body = document.createElement('div');
    body.className = 'lx-cmd-workspace';

    root.append(toolbar, voiceBanner, body);

    // ── Нормализация команды и шагов v3 ──────────────────────────
    function makeDefaultStep(type = 'app_start', overrideParams = null) {
      const meta = STEP_TYPE_META[type] || STEP_TYPE_META.wait;
      const params = overrideParams
        ? { ...overrideParams }
        : cmdSteps.defaultStepParams(meta.type, meta.argKey);
      return cmdSteps.normalizeStepTree([{
        id: `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        type: meta.type,
        tool: meta.tool,
        params,
        args: { ...params },
        children: [],
      }])[0];
    }

    function normCmd(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const steps = cmdSteps.normalizeStepTree(Array.isArray(raw.steps) ? raw.steps : []);
      const triggers = cmdSteps.normalizeTriggersModel(raw.triggers, raw.hotkey);
      return {
        id: raw.id ?? null,
        schemaVersion: 3,
        name: String(raw.name || ''),
        program: raw.program ? String(raw.program) : '',
        phrases: Array.isArray(raw.phrases) && raw.phrases.length ? raw.phrases.map(String) : [''],
        steps,
        enabled: raw.enabled !== false,
        confirm: Boolean(raw.confirm),
        folder: raw.folder ? String(raw.folder) : '',
        hotkey: raw.hotkey ? String(raw.hotkey) : (triggers.hotkey.enabled && triggers.hotkey.key ? triggers.hotkey.key : ''),
        triggers,
        triggerState: raw.triggerState && typeof raw.triggerState === 'object' ? cloneJson(raw.triggerState, {}) : {},
        origin: raw.origin || 'manual',
        lastRunAt: raw.lastRunAt || null,
      };
    }

    function selectCommandById(id, openPanel = false) {
      const hit = commandsList.find((c) => c.id === id);
      if (!hit) return false;
      selectedCommandId = hit.id;
      selectedKind = 'command';
      selectedStepPath = null;
      draft = normCmd(hit);
      savedSnapshot = cloneJson(draft, null);
      dirty = false;
      draftError = '';
      if (openPanel) inspectorOpen = true;
      return true;
    }

    function cancelDraftChanges() {
      if (!savedSnapshot) return;
      draft = cloneJson(savedSnapshot, null);
      selectedStepPath = null;
      selectedKind = draft ? 'command' : 'root';
      dirty = false;
      draftError = '';
      renderView();
      store.toast('Изменения отменены');
    }

    function markDirty() {
      dirty = true;
      draftError = '';
      syncToolbarState();
    }

    function resetWriteDraft(extra = {}) {
      writeDraft = normCmd({
        id: null,
        name: extra.name || '',
        program: extra.program || '',
        phrases: extra.phrases || [''],
        hotkey: extra.hotkey || '',
        confirm: Boolean(extra.confirm),
        folder: extra.folder || '',
        enabled: true,
        steps: [makeDefaultStep('app_start', { name: '' })],
      });
      writeSelectedPath = [0];
    }

    function openNewWriteCommand(extra = {}) {
      resetWriteDraft(extra);
      viewMode = 'new';
      newSubTab = 'write';
      renderView();
    }

    // ── Загрузка данных с ядра ────────────────────────────────────
    async function loadMyCommands() {
      if (!bridge.has('listCommands')) { commandsList = []; return; }
      try {
        const r = await bridge.call('listCommands');
        const arr = Array.isArray(r) ? r : (r && Array.isArray(r.commands) ? r.commands : []);
        commandsList = arr.map(normCmd).filter(Boolean);
        if (selectedCommandId && !dirty) {
          const hit = commandsList.find((c) => c.id === selectedCommandId);
          if (hit) {
            draft = normCmd(hit);
            savedSnapshot = cloneJson(draft, null);
          } else {
            selectedCommandId = null;
            draft = null;
            savedSnapshot = null;
          }
        }
      } catch (err) {
        store.toast(`Команды не загрузились: ${bridge.errText(err)}`, 'error');
      }
    }

    async function loadPacks() {
      if (!bridge.has('installPack')) { packsList = []; return; }
      try {
        const r = await bridge.call('installPack');
        packsList = r && r.ok && Array.isArray(r.packs) ? r.packs : [];
      } catch {
        packsList = [];
      }
    }

    async function loadLaunches() {
      if (!bridge.has('getCommandLaunches')) { launchOverview = null; return; }
      try {
        const r = await bridge.call('getCommandLaunches', {});
        launchOverview = r && r.ok ? r : null;
      } catch {
        launchOverview = null;
      }
    }

    async function loadAll() {
      loaded = true;
      await Promise.allSettled([loadMyCommands(), loadPacks()]);
      if (viewMode === 'launches') await loadLaunches();
      renderView();
    }

    function buildSavePayload(src) {
      const phrases = (Array.isArray(src.phrases) ? src.phrases : [])
        .map((p) => String(p || '').trim())
        .filter(Boolean);
      const triggers = cmdSteps.normalizeTriggersModel(src.triggers, src.hotkey);
      const hotkeyVal = src.hotkey && src.hotkey.trim() ? src.hotkey.trim() : null;
      triggers.hotkey.key = hotkeyVal;
      triggers.hotkey.enabled = Boolean(hotkeyVal);
      const payload = {
        schemaVersion: 3,
        name: String(src.name || '').trim(),
        program: String(src.program || '').trim() || undefined,
        phrases,
        steps: serializeSteps(src.steps),
        enabled: src.enabled !== false,
        confirm: Boolean(src.confirm),
        folder: String(src.folder || '').trim() || null,
        hotkey: hotkeyVal,
        triggers,
        origin: src.origin || 'manual',
      };
      if (src.id) payload.id = src.id;
      return payload;
    }

    function serializeSteps(steps) {
      return (Array.isArray(steps) ? steps : []).map((s) => {
        const meta = STEP_TYPE_META[s.type] || null;
        const tool = s.tool || (meta && meta.tool) || 'wait';
        const type = s.type || (cmdSteps.TOOL_TO_STEP_TYPE[tool] || 'wait');
        const rawArgs = { ...(s.args && typeof s.args === 'object' ? s.args : s.params) };
        const rawParams = { ...(s.params && typeof s.params === 'object' ? s.params : rawArgs) };
        // В сохранённой команде у паузы только ms: другого инструмент wait не принимает.
        const { params, args } = cmdSteps.waitStepArgs(type, tool, rawParams, rawArgs);
        return {
          id: s.id,
          type,
          tool,
          params,
          args,
          children: serializeSteps(s.children),
        };
      });
    }

    async function saveCommandPayload(payload) {
      if (!bridge.has('saveCommand')) return { ok: false, error: 'Недоступно сохранение' };
      try {
        const r = await bridge.call('saveCommand', payload);
        if (!r || r.ok === false) {
          return { ok: false, error: (r && r.error) || 'Не удалось сохранить команду' };
        }
        await loadMyCommands();
        emitCommandsUpdated();
        return { ok: true, command: r.command };
      } catch (err) {
        return { ok: false, error: bridge.errText(err) };
      }
    }

    async function saveActiveDraft() {
      if (!draft) return;
      const payload = buildSavePayload(draft);
      if (!payload.name) {
        draftError = 'Укажите название команды.';
        inspectorOpen = true;
        renderBody();
        return;
      }
      if (!payload.phrases.length && !payload.hotkey && !(payload.triggers.schedule?.enabled || payload.triggers.event?.enabled)) {
        draftError = 'Добавьте хотя бы одну фразу для запуска или горячую клавишу.';
        inspectorOpen = true;
        renderBody();
        return;
      }
      if (!payload.steps.length) {
        draftError = 'В команде должен быть хотя бы один шаг.';
        inspectorOpen = true;
        renderBody();
        return;
      }
      saveBtn.disabled = true;
      const res = await saveCommandPayload(payload);
      saveBtn.disabled = false;
      if (!res.ok) {
        draftError = res.error;
        inspectorOpen = true;
        renderBody();
        store.toast(res.error, 'error');
        return;
      }
      const savedId = res.command && res.command.id ? res.command.id : payload.id;
      selectCommandById(savedId, inspectorOpen);
      store.toast(`Команда «${payload.name}» сохранена`, 'ok');
      renderView();
    }

    async function saveWriteDraft() {
      if (!writeDraft) return;
      const payload = buildSavePayload(writeDraft);
      if (!payload.name) {
        draftError = 'Укажите название команды.';
        renderBody();
        return;
      }
      if (!payload.phrases.length && !payload.hotkey) {
        draftError = 'Укажите фразу запуска или горячую клавишу.';
        renderBody();
        return;
      }
      const res = await saveCommandPayload(payload);
      if (!res.ok) {
        draftError = res.error;
        renderBody();
        store.toast(res.error, 'error');
        return;
      }
      const savedId = res.command && res.command.id ? res.command.id : payload.id;
      viewMode = 'tree';
      inspectorOpen = true;
      selectCommandById(savedId, true);
      resetWriteDraft();
      store.toast(`Команда «${payload.name}» создана`, 'ok');
      renderView();
    }

    async function runCommandById(id) {
      if (!id || !bridge.has('runCommand')) return;
      try {
        const res = await bridge.call('runCommand', id);
        if (!res || res.ok === false) {
          store.toast((res && (res.reason || res.error)) || 'Не удалось выполнить команду', 'error');
        } else if (res.partial || res.status === 'partial') {
          store.toast(res.reason || 'Команда выполнена частично', 'error');
        } else {
          store.toast(res.reason || 'Команда выполнена', 'ok');
        }
        if (viewMode === 'launches') await loadLaunches();
        renderView();
      } catch (err) {
        store.toast(bridge.errText(err), 'error');
      }
    }

    async function deleteSelectedNode() {
      if (selectedKind === 'step' && draft && Array.isArray(selectedStepPath)) {
        draft.steps = cmdSteps.deleteTreeNode(draft.steps, selectedStepPath);
        selectedStepPath = null;
        selectedKind = 'command';
        markDirty();
        renderView();
        return;
      }
      if ((selectedKind === 'command' || selectedKind === 'phrases') && selectedCommandId && bridge.has('deleteCommand')) {
        try {
          const r = await bridge.call('deleteCommand', selectedCommandId);
          if (r && r.ok === false) throw new Error(r.error || 'Не удалось удалить');
          selectedCommandId = null;
          selectedKind = 'root';
          draft = null;
          savedSnapshot = null;
          dirty = false;
          inspectorOpen = false;
          await loadMyCommands();
          emitCommandsUpdated();
          store.toast('Команда удалена', 'ok');
          renderView();
        } catch (err) {
          store.toast(bridge.errText(err), 'error');
        }
      }
    }

    // ── Голосовая запись шага (существующее распознавание Windows) ──
    function syncVoiceBanner() {
      if (!voiceBannerText && !voiceTarget) {
        voiceBanner.hidden = true;
        voiceBanner.replaceChildren();
        return;
      }
      voiceBanner.hidden = false;
      voiceBanner.className = voiceBannerIsError ? 'lx-cmd-voice-banner is-error' : 'lx-cmd-voice-banner';
      const txt = document.createElement('span');
      txt.textContent = voiceBannerText;
      const right = document.createElement('div');
      right.className = 'lx-cmd-step-nav';
      if (voiceTarget) {
        const stopB = document.createElement('button');
        stopB.type = 'button';
        stopB.className = 'lx-cmd-mini-btn is-primary';
        stopB.textContent = 'Стоп';
        stopB.addEventListener('click', () => stopVoiceCapture(true));
        right.append(stopB);
      } else {
        const closeB = document.createElement('button');
        closeB.type = 'button';
        closeB.className = 'lx-cmd-mini-btn';
        closeB.textContent = 'Скрыть';
        closeB.addEventListener('click', () => {
          voiceBannerText = '';
          voiceBannerIsError = false;
          syncVoiceBanner();
        });
        right.append(closeB);
      }
      voiceBanner.replaceChildren(txt, right);
    }

    async function startVoiceCapture(target) {
      if (!bridge.has('dictationStart')) {
        voiceBannerIsError = true;
        voiceBannerText = 'Голосовая запись недоступна в этой среде: используйте «Опишите словами».';
        syncVoiceBanner();
        return;
      }
      voiceTarget = target;
      voiceTranscript = '';
      voiceBannerIsError = false;
      voiceBannerText = target.mode === 'step'
        ? 'Слушаю шаг (например: «открой калькулятор» или «сделай громкость 40»)...'
        : 'Говорите, что должна делать новая команда...';
      syncVoiceBanner();
      renderBody();
      try {
        const res = await bridge.call('dictationStart', 'single');
        if (res && res.ok === false) {
          voiceTarget = null;
          voiceBannerIsError = true;
          voiceBannerText = res.error || 'Не удалось включить микрофон для записи.';
          syncVoiceBanner();
          renderBody();
        }
      } catch (err) {
        voiceTarget = null;
        voiceBannerIsError = true;
        voiceBannerText = `Микрофон не запустился: ${bridge.errText(err)}`;
        syncVoiceBanner();
        renderBody();
      }
    }

    async function stopVoiceCapture(applyCurrent = false) {
      const activeTarget = voiceTarget;
      voiceTarget = null;
      if (bridge.has('dictationStop')) {
        await bridge.call('dictationStop').catch(() => {});
      }
      if (!activeTarget) {
        syncVoiceBanner();
        renderBody();
        return;
      }
      const phrase = voiceTranscript.trim();
      if (!phrase) {
        voiceBannerIsError = true;
        voiceBannerText = 'Речь не распознана — шаг не добавлен. Попробуйте ещё раз или введите вручную.';
        syncVoiceBanner();
        renderBody();
        return;
      }
      if (applyCurrent) {
        await applyRecognizedPhrase(activeTarget, phrase);
      }
    }

    async function applyRecognizedPhrase(target, phrase) {
      const clean = String(phrase || '').trim();
      if (!clean) {
        voiceBannerIsError = true;
        voiceBannerText = 'Речь не распознана — шаг не добавлен.';
        syncVoiceBanner();
        return;
      }
      if (target.mode === 'say') {
        aiDescription = clean;
        newSubTab = 'describe';
        voiceBannerText = `Распознано: «${clean}»`;
        voiceBannerIsError = false;
        syncVoiceBanner();
        await runAiDescribeAssemble();
        return;
      }
      // target.mode === 'step': если выбран шаг ввода текста — подставим текст прямо в него
      if (draft && Array.isArray(target.path) && target.path.length) {
        const node = cmdSteps.getNodeAtPath(draft.steps, target.path);
        if (node && node.type === 'type_text') {
          draft.steps = cmdSteps.updateTreeNode(draft.steps, target.path, (prev) => ({
            ...prev,
            params: { ...prev.params, text: clean },
            args: { ...prev.args, text: clean },
          }));
          markDirty();
          voiceBannerIsError = false;
          voiceBannerText = `Текст шага обновлён: «${clean}»`;
          syncVoiceBanner();
          renderView();
          return;
        }
      }
      // Иначе собираем конкретный шаг(и) из каталога через buildCommandFromText
      if (!bridge.has('buildCommandFromText')) {
        voiceBannerIsError = true;
        voiceBannerText = 'Сборка шага из речи недоступна без каталога действий.';
        syncVoiceBanner();
        return;
      }
      const built = await bridge.call('buildCommandFromText', { text: clean }).catch((e) => ({ ok: false, error: bridge.errText(e) }));
      const steps = built && built.command && Array.isArray(built.command.steps) ? built.command.steps : [];
      if (!built || built.ok === false || !steps.length) {
        const missingNote = built && Array.isArray(built.missing) && built.missing.length
          ? ` Не хватает действий: ${built.missing.join('; ')}.`
          : '';
        voiceBannerIsError = true;
        voiceBannerText = `Распознано «${clean}», но подходящее действие не найдено.${missingNote}`;
        syncVoiceBanner();
        renderView();
        return;
      }
      if (!draft) {
        if (commandsList.length) selectCommandById(commandsList[0].id, true);
        else {
          resetWriteDraft({ name: built.command.name || clean, phrases: [clean] });
          writeDraft.steps = cmdSteps.normalizeStepTree(steps);
          viewMode = 'new';
          newSubTab = 'write';
          voiceBannerIsError = false;
          voiceBannerText = `Создан черновик из речи: «${clean}»`;
          syncVoiceBanner();
          renderView();
          return;
        }
      }
      const normalizedNew = cmdSteps.normalizeStepTree(steps);
      let insertParent = [];
      let insertIndex = draft.steps.length;
      if (Array.isArray(target.path) && target.path.length) {
        insertParent = target.path;
        const parentNode = cmdSteps.getNodeAtPath(draft.steps, insertParent);
        insertIndex = parentNode && Array.isArray(parentNode.children) ? parentNode.children.length : 0;
        collapsedStepIds.delete(parentNode && parentNode.id);
      }
      let nextSteps = draft.steps;
      for (const s of normalizedNew) {
        nextSteps = cmdSteps.insertTreeNode(nextSteps, insertParent, insertIndex, s);
        insertIndex += 1;
      }
      draft.steps = nextSteps;
      selectedStepPath = [...insertParent, insertIndex - 1];
      selectedKind = 'step';
      collapsedCommands.delete(draft.id);
      inspectorOpen = true;
      markDirty();
      voiceBannerIsError = false;
      voiceBannerText = `Добавлен шаг по речи: «${clean}»`;
      syncVoiceBanner();
      renderView();
    }

    function onDictationEvent(ev) {
      if (!ev || !voiceTarget) return;
      if (ev.type === 'partial' && ev.text) {
        voiceTranscript = String(ev.text);
        voiceBannerIsError = false;
        voiceBannerText = `Слышу: «${voiceTranscript}»`;
        syncVoiceBanner();
      } else if (ev.type === 'final' && ev.text) {
        const text = String(ev.text).trim();
        const target = voiceTarget;
        voiceTranscript = text;
        voiceTarget = null;
        if (bridge.has('dictationStop')) bridge.call('dictationStop').catch(() => {});
        applyRecognizedPhrase(target, text);
      } else if (ev.type === 'error' || ev.type === 'stopped') {
        if (ev.type === 'error') {
          voiceTarget = null;
          voiceBannerIsError = true;
          voiceBannerText = ev.message ? scrub(ev.message) : 'Ошибка распознавания речи — попробуйте снова.';
          syncVoiceBanner();
          renderBody();
        } else if (voiceTarget) {
          stopVoiceCapture(Boolean(voiceTranscript.trim()));
        }
      }
    }

    // ── Вспомогательные подписи для шагов дерева ──────────────────
    function stepVisual(step) {
      const meta = STEP_TYPE_META[step.type] || null;
      const toolName = step.tool || (meta && meta.tool) || 'wait';
      const title = meta ? meta.label : toolTitle(toolName);
      const args = (step.args && typeof step.args === 'object' && Object.keys(step.args).length)
        ? step.args
        : (step.params || {});
      const brief = argsBrief(args, toolName) || Object.values(args).filter((v) => v !== '' && v !== undefined && v !== null).join(', ');
      return {
        iconName: meta ? meta.icon : 'file',
        label: brief ? `${title} · ${brief}` : title,
      };
    }

    function stepMatchesQuery(step, q) {
      if (!step) return false;
      const v = stepVisual(step);
      if (v.label.toLowerCase().includes(q)) return true;
      return Array.isArray(step.children) && step.children.some((c) => stepMatchesQuery(c, q));
    }

    // ── Отрисовка дерева (Редактировать) ──────────────────────────
    function makeGuideLines(depth) {
      if (depth <= 0) return null;
      const guides = document.createElement('div');
      guides.className = 'lx-tree-guides';
      for (let d = 0; d < depth; d += 1) {
        const line = document.createElement('span');
        line.className = 'lx-tree-guide-line';
        line.style.left = `${d * 24 + 12}px`;
        guides.append(line);
      }
      return guides;
    }

    function makeTreeRow({ depth, iconName, label, meta, selected, disabled, hasChildren, collapsed, onSelect, onToggle, rowActions }) {
      const wrap = document.createElement('div');
      wrap.className = 'lx-tree-item';
      wrap.style.setProperty('--depth', String(depth));
      const guides = makeGuideLines(depth);
      if (guides) wrap.append(guides);

      const row = document.createElement('div');
      row.className = 'lx-tree-row'
        + (selected ? ' is-selected' : '')
        + (disabled ? ' is-disabled' : '');
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', String(Boolean(selected)));
      row.tabIndex = 0;

      row.append(icon(iconName, 'lx-tree-row-ico'));

      const lbl = document.createElement('span');
      lbl.className = 'lx-tree-row-label';
      lbl.textContent = label;
      row.append(lbl);

      if (meta) {
        const m = document.createElement('span');
        m.className = 'lx-tree-row-meta';
        m.textContent = meta;
        row.append(m);
      }

      if (hasChildren) {
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.className = 'lx-tree-row-chev';
        chev.setAttribute('aria-label', collapsed ? 'Развернуть' : 'Свернуть');
        chev.append(icon(collapsed ? 'chevronDown' : 'chevronUp'));
        chev.addEventListener('click', (e) => {
          e.stopPropagation();
          if (onToggle) onToggle();
        });
        row.append(chev);
      }

      row.addEventListener('click', () => {
        if (onSelect) onSelect();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (onSelect) onSelect();
        }
      });

      wrap.append(row);

      if (selected && Array.isArray(rowActions) && rowActions.length) {
        const acts = document.createElement('div');
        acts.className = 'lx-tree-row-acts';
        for (const act of rowActions) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'lx-tree-act-btn' + (act.active ? ' is-listening' : '');
          b.title = act.title;
          b.setAttribute('aria-label', act.title);
          b.append(icon(act.icon));
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            act.onClick();
          });
          acts.append(b);
        }
        wrap.append(acts);
      }

      return { wrap, row };
    }

    function bindDragAndDrop(rowEl, stepPath) {
      rowEl.draggable = true;
      rowEl.addEventListener('dragstart', (e) => {
        dragFromPath = stepPath.slice();
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', stepPath.join('.'));
        }
      });
      rowEl.addEventListener('dragend', () => {
        dragFromPath = null;
        rowEl.classList.remove('is-drag-before', 'is-drag-inside', 'is-drag-after');
      });
      rowEl.addEventListener('dragover', (e) => {
        if (!dragFromPath) return;
        e.preventDefault();
        const rect = rowEl.getBoundingClientRect();
        const y = (e.clientY || 0) - rect.top;
        const zone = y < rect.height * 0.28 ? 'before' : (y > rect.height * 0.72 ? 'after' : 'inside');
        rowEl.classList.toggle('is-drag-before', zone === 'before');
        rowEl.classList.toggle('is-drag-inside', zone === 'inside');
        rowEl.classList.toggle('is-drag-after', zone === 'after');
        rowEl.dataset.dropZone = zone;
      });
      rowEl.addEventListener('dragleave', () => {
        rowEl.classList.remove('is-drag-before', 'is-drag-inside', 'is-drag-after');
      });
      rowEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const zone = rowEl.dataset.dropZone || 'inside';
        rowEl.classList.remove('is-drag-before', 'is-drag-inside', 'is-drag-after');
        if (!dragFromPath || !draft) return;
        const from = dragFromPath;
        dragFromPath = null;
        if (from.join('.') === stepPath.join('.')) return;

        let res;
        if (zone === 'inside') {
          const targetNode = cmdSteps.getNodeAtPath(draft.steps, stepPath);
          const idx = targetNode && Array.isArray(targetNode.children) ? targetNode.children.length : 0;
          if (targetNode) collapsedStepIds.delete(targetNode.id);
          res = cmdSteps.moveTreeNodeTo(draft.steps, from, stepPath, idx);
        } else {
          const parentPath = stepPath.slice(0, -1);
          const idx = stepPath[stepPath.length - 1] + (zone === 'after' ? 1 : 0);
          res = cmdSteps.moveTreeNodeTo(draft.steps, from, parentPath, idx);
        }
        draft.steps = res.steps;
        selectedStepPath = res.path;
        selectedKind = 'step';
        markDirty();
        renderView();
      });
    }

    function renderTreePanel() {
      const scroll = document.createElement('div');
      scroll.className = 'lx-cmd-tree-scroll';
      scroll.setAttribute('role', 'tree');

      const q = searchQuery.trim().toLowerCase();
      const filtered = commandsList.filter((cmd) => {
        if (!q) return true;
        if (cmd.name.toLowerCase().includes(q)) return true;
        if (cmd.folder && cmd.folder.toLowerCase().includes(q)) return true;
        if (cmd.phrases.some((p) => p.toLowerCase().includes(q))) return true;
        return cmd.steps.some((s) => stepMatchesQuery(s, q));
      });

      const groups = cmdSteps.groupCommands(filtered);
      const isRootSelected = selectedKind === 'root';
      const { wrap: rootRow } = makeTreeRow({
        depth: 0,
        iconName: 'archive',
        label: 'Мои команды',
        meta: commandsList.length ? `${commandsList.length} команд` : 'Пусто',
        selected: isRootSelected,
        hasChildren: groups.length > 0,
        collapsed: rootCollapsed,
        onSelect: () => {
          selectedKind = 'root';
          selectedStepPath = null;
          renderBody();
        },
        onToggle: () => {
          rootCollapsed = !rootCollapsed;
          renderBody();
        },
        rowActions: [
          {
            icon: 'mic',
            title: 'Создать команду голосом',
            active: Boolean(voiceTarget && voiceTarget.mode === 'say'),
            onClick: () => startVoiceCapture({ mode: 'say' }),
          },
          {
            icon: 'pencil',
            title: 'Создать команду вручную',
            onClick: () => openNewWriteCommand({}),
          },
        ],
      });
      scroll.append(rootRow);

      if (rootCollapsed) return scroll;

      if (!groups.length) {
        const empty = document.createElement('div');
        empty.className = 'lx-empty-box';
        empty.textContent = q ? 'Ничего не найдено по вашему запросу.' : 'Команд пока нет. Нажмите «Новая команда» или откройте Паки.';
        scroll.append(empty);
        return scroll;
      }

      for (const grp of groups) {
        const folderKey = grp.folder ? grp.folder.toLowerCase() : '__none__';
        const folderCollapsed = !q && collapsedFolders.has(folderKey);
        const { wrap: folderRow } = makeTreeRow({
          depth: 1,
          iconName: 'folder',
          label: grp.title,
          meta: `${grp.commands.length}`,
          selected: selectedKind === 'folder' && selectedFolderKey === folderKey,
          hasChildren: grp.commands.length > 0,
          collapsed: folderCollapsed,
          onSelect: () => {
            selectedKind = 'folder';
            selectedFolderKey = folderKey;
            selectedStepPath = null;
            renderBody();
          },
          onToggle: () => {
            if (folderCollapsed) collapsedFolders.delete(folderKey);
            else collapsedFolders.add(folderKey);
            renderBody();
          },
          rowActions: [
            {
              icon: 'pencil',
              title: 'Новая команда в этой папке',
              onClick: () => openNewWriteCommand({ folder: grp.folder || '' }),
            },
          ],
        });
        scroll.append(folderRow);
        if (folderCollapsed) continue;

        for (const cmd of grp.commands) {
          const isEditingThis = draft && draft.id === cmd.id;
          const activeCmd = isEditingThis ? draft : cmd;
          const cmdCollapsed = !q && collapsedCommands.has(cmd.id);
          const isCmdSelected = selectedCommandId === cmd.id && selectedKind === 'command';
          const stepTotal = cmdSteps.countTreeSteps(activeCmd.steps);

          const { wrap: cmdRow } = makeTreeRow({
            depth: 2,
            iconName: 'file',
            label: activeCmd.name || 'Без имени',
            meta: activeCmd.hotkey || `${stepTotal} ш.`,
            selected: isCmdSelected,
            disabled: !activeCmd.enabled,
            hasChildren: true,
            collapsed: cmdCollapsed,
            onSelect: () => {
              if (!isEditingThis) selectCommandById(cmd.id, false);
              selectedKind = 'command';
              selectedStepPath = null;
              collapsedCommands.delete(cmd.id);
              renderBody();
            },
            onToggle: () => {
              if (cmdCollapsed) collapsedCommands.delete(cmd.id);
              else collapsedCommands.add(cmd.id);
              renderBody();
            },
            rowActions: [
              {
                icon: 'mic',
                title: 'Добавить шаг голосом',
                active: Boolean(voiceTarget && voiceTarget.mode === 'step' && (!voiceTarget.path || !voiceTarget.path.length)),
                onClick: () => {
                  if (!isEditingThis) selectCommandById(cmd.id, true);
                  startVoiceCapture({ mode: 'step', path: [] });
                },
              },
              {
                icon: 'pencil',
                title: 'Редактировать команду',
                onClick: () => {
                  if (!isEditingThis) selectCommandById(cmd.id, true);
                  else inspectorOpen = !inspectorOpen;
                  renderBody();
                },
              },
              {
                icon: 'trash',
                title: 'Удалить команду',
                onClick: () => {
                  selectedCommandId = cmd.id;
                  selectedKind = 'command';
                  deleteSelectedNode();
                },
              },
            ],
          });
          scroll.append(cmdRow);
          if (cmdCollapsed) continue;

          // Строка триггеров / фраз активации
          const nonEmptyPhrases = activeCmd.phrases.filter((p) => p.trim());
          const { wrap: phrasesRow } = makeTreeRow({
            depth: 3,
            iconName: 'flag',
            label: nonEmptyPhrases.length ? nonEmptyPhrases.join(', ') : 'Фразы запуска не заданы',
            meta: activeCmd.confirm ? 'Подтверждать' : '',
            selected: selectedCommandId === cmd.id && selectedKind === 'phrases',
            hasChildren: false,
            onSelect: () => {
              if (!isEditingThis) selectCommandById(cmd.id, true);
              else inspectorOpen = true;
              selectedKind = 'phrases';
              selectedStepPath = null;
              renderBody();
            },
          });
          scroll.append(phrasesRow);

          // Вложенные шаги (рекурсивно, 24px на уровень!)
          const flatSteps = cmdSteps.flattenTreeForRender(activeCmd.steps, q ? new Set() : collapsedStepIds);
          for (const entry of flatSteps) {
            const { node, path, depth, hasChildren, collapsed } = entry;
            const vis = stepVisual(node);
            const pathKey = path.join('.');
            const isStepSelected = selectedCommandId === cmd.id
              && selectedKind === 'step'
              && Array.isArray(selectedStepPath)
              && selectedStepPath.join('.') === pathKey;
            const isMicHere = Boolean(
              voiceTarget && voiceTarget.mode === 'step'
              && Array.isArray(voiceTarget.path)
              && voiceTarget.path.join('.') === pathKey
            );

            const { wrap: stepWrap, row: stepRow } = makeTreeRow({
              depth: 3 + depth,
              iconName: vis.iconName,
              label: vis.label,
              meta: hasChildren ? `${node.children.length} влож.` : '',
              selected: isStepSelected,
              hasChildren,
              collapsed,
              onSelect: () => {
                if (!isEditingThis) selectCommandById(cmd.id, true);
                else inspectorOpen = true;
                selectedKind = 'step';
                selectedStepPath = path.slice();
                renderBody();
              },
              onToggle: () => {
                if (collapsedStepIds.has(node.id)) collapsedStepIds.delete(node.id);
                else collapsedStepIds.add(node.id);
                renderBody();
              },
              rowActions: [
                {
                  icon: 'mic',
                  title: 'Записать шаг голосом внутрь этого шага',
                  active: isMicHere,
                  onClick: () => {
                    if (!isEditingThis) selectCommandById(cmd.id, true);
                    selectedKind = 'step';
                    selectedStepPath = path.slice();
                    startVoiceCapture({ mode: 'step', path: path.slice() });
                  },
                },
                {
                  icon: 'pencil',
                  title: 'Свойства шага',
                  onClick: () => {
                    if (!isEditingThis) selectCommandById(cmd.id, true);
                    selectedKind = 'step';
                    selectedStepPath = path.slice();
                    inspectorOpen = true;
                    renderBody();
                  },
                },
                {
                  icon: 'trash',
                  title: 'Удалить шаг',
                  onClick: () => {
                    if (!isEditingThis) selectCommandById(cmd.id, true);
                    selectedKind = 'step';
                    selectedStepPath = path.slice();
                    deleteSelectedNode();
                  },
                },
              ],
            });
            if (isEditingThis) bindDragAndDrop(stepRow, path);
            scroll.append(stepWrap);
          }
        }
      }

      return scroll;
    }

    // ── Инспектор выбранной команды / шага ────────────────────────
    function buildStepEditorSection(targetDraft, stepPath, onChange) {
      const node = cmdSteps.getNodeAtPath(targetDraft.steps, stepPath);
      if (!node) return null;

      const box = document.createElement('div');
      box.className = 'lx-ai-card';
      box.style.padding = '12px';

      const head = document.createElement('div');
      head.className = 'lx-cmd-insp-head';
      const title = document.createElement('h4');
      title.className = 'lx-cmd-insp-title';
      title.textContent = `Шаг (${stepPath.map((n) => n + 1).join('.')})`;
      head.append(title);

      const navRow = document.createElement('div');
      navRow.className = 'lx-cmd-step-nav';

      const mkMove = (iconName, tip, handler) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lx-cmd-mini-btn';
        b.title = tip;
        b.setAttribute('aria-label', tip);
        b.append(icon(iconName));
        b.addEventListener('click', handler);
        return b;
      };

      const parentList = stepPath.length <= 1
        ? targetDraft.steps
        : (cmdSteps.getNodeAtPath(targetDraft.steps, stepPath.slice(0, -1))?.children || []);
      const idxInParent = stepPath[stepPath.length - 1];

      const upBtn = mkMove('arrowUp', 'Выше', () => {
        const res = cmdSteps.moveTreeNode(targetDraft.steps, stepPath, -1);
        onChange(res.steps, res.path);
      });
      upBtn.disabled = idxInParent <= 0;

      const downBtn = mkMove('arrowDown', 'Ниже', () => {
        const res = cmdSteps.moveTreeNode(targetDraft.steps, stepPath, 1);
        onChange(res.steps, res.path);
      });
      downBtn.disabled = idxInParent >= parentList.length - 1;

      const indentBtn = mkMove('cornerDownRight', 'Вложить внутрь предыдущего шага', () => {
        const res = cmdSteps.indentTreeNode(targetDraft.steps, stepPath);
        onChange(res.steps, res.path);
      });
      indentBtn.disabled = idxInParent <= 0;

      const outdentBtn = mkMove('cornerUpLeft', 'Вынести на уровень выше', () => {
        const res = cmdSteps.outdentTreeNode(targetDraft.steps, stepPath);
        onChange(res.steps, res.path);
      });
      outdentBtn.disabled = stepPath.length < 2;

      const addChildBtn = document.createElement('button');
      addChildBtn.type = 'button';
      addChildBtn.className = 'lx-cmd-mini-btn';
      addChildBtn.textContent = '+ Вложенный';
      addChildBtn.addEventListener('click', () => {
        const child = makeDefaultStep('wait');
        collapsedStepIds.delete(node.id);
        const curLen = Array.isArray(node.children) ? node.children.length : 0;
        const nextTree = cmdSteps.insertTreeNode(targetDraft.steps, stepPath, curLen, child);
        onChange(nextTree, [...stepPath, curLen]);
      });

      navRow.append(upBtn, downBtn, indentBtn, outdentBtn, addChildBtn);
      box.append(head, navRow);

      // Выбор типа шага
      const typeField = document.createElement('label');
      typeField.className = 'lx-cmd-field';
      const typeLbl = document.createElement('span');
      typeLbl.className = 'lx-cmd-field-label';
      typeLbl.textContent = 'Тип шага';
      const typeSel = document.createElement('select');
      typeSel.className = 'lx-cmd-select';
      for (const st of STEP_TYPES) {
        const opt = document.createElement('option');
        opt.value = st.type;
        opt.textContent = st.label;
        opt.selected = st.type === node.type;
        typeSel.append(opt);
      }
      typeSel.addEventListener('change', () => {
        const meta = STEP_TYPE_META[typeSel.value] || STEP_TYPE_META.wait;
        const nextParams = cmdSteps.defaultStepParams(meta.type, meta.argKey);
        const nextTree = cmdSteps.updateTreeNode(targetDraft.steps, stepPath, (prev) => ({
          ...prev,
          type: meta.type,
          tool: meta.tool,
          params: { ...nextParams },
          args: { ...nextParams },
        }));
        onChange(nextTree, stepPath);
      });
      typeField.append(typeLbl, typeSel);
      box.append(typeField);

      // Поля параметров под конкретный тип шага
      const meta = STEP_TYPE_META[node.type] || { argKey: Object.keys(node.params || {})[0] || 'text', placeholder: '' };
      const curParams = (node.params && Object.keys(node.params).length) ? node.params : (node.args || {});

      if (node.type === 'click') {
        const grid = document.createElement('div');
        grid.className = 'lx-cmd-grid-2';

        const targetIn = document.createElement('input');
        targetIn.className = 'lx-cmd-input';
        targetIn.placeholder = 'Элемент / подпись кнопки';
        targetIn.value = String(curParams.target || curParams.name || '');

        const coordsWrap = document.createElement('div');
        coordsWrap.className = 'lx-cmd-grid-2';
        const xIn = document.createElement('input');
        xIn.type = 'number';
        xIn.className = 'lx-cmd-input';
        xIn.placeholder = 'X';
        xIn.value = curParams.x !== undefined ? String(curParams.x) : '';
        const yIn = document.createElement('input');
        yIn.type = 'number';
        yIn.className = 'lx-cmd-input';
        yIn.placeholder = 'Y';
        yIn.value = curParams.y !== undefined ? String(curParams.y) : '';
        coordsWrap.append(xIn, yIn);

        const syncClick = () => {
          const patch = {};
          if (targetIn.value.trim()) patch.target = targetIn.value.trim();
          if (xIn.value !== '') patch.x = Number(xIn.value);
          if (yIn.value !== '') patch.y = Number(yIn.value);
          const nextTree = cmdSteps.updateTreeNode(targetDraft.steps, stepPath, (prev) => ({
            ...prev,
            params: patch,
            args: { ...patch },
          }));
          targetDraft.steps = nextTree;
          markDirty();
        };
        targetIn.addEventListener('input', syncClick);
        xIn.addEventListener('input', syncClick);
        yIn.addEventListener('input', syncClick);

        const f1 = document.createElement('label');
        f1.className = 'lx-cmd-field';
        const l1 = document.createElement('span');
        l1.className = 'lx-cmd-field-label';
        l1.textContent = 'Цель клика';
        f1.append(l1, targetIn);

        const f2 = document.createElement('div');
        f2.className = 'lx-cmd-field';
        const l2 = document.createElement('span');
        l2.className = 'lx-cmd-field-label';
        l2.textContent = 'Координаты (необяз.)';
        f2.append(l2, coordsWrap);

        grid.append(f1, f2);
        box.append(grid);
      } else {
        const paramField = document.createElement('label');
        paramField.className = 'lx-cmd-field';
        const paramLbl = document.createElement('span');
        paramLbl.className = 'lx-cmd-field-label';
        paramLbl.textContent = node.type === 'app_start' ? 'Программа или ссылка'
          : node.type === 'hotkey' ? 'Сочетание клавиш'
            : node.type === 'volume' ? 'Громкость (%)'
              : node.type === 'wait' ? `Пауза, мс (0–${cmdSteps.WAIT_MAX_MS})`
                : 'Параметр';
        const paramIn = document.createElement('input');
        paramIn.className = 'lx-cmd-input';
        paramIn.placeholder = meta.placeholder || '';
        const primaryKey = node.type === 'app_start' && curParams.url !== undefined ? 'url' : meta.argKey;
        const val = curParams[primaryKey] !== undefined ? curParams[primaryKey]
          : (curParams.name ?? curParams.target ?? curParams.keys ?? curParams.percent ?? curParams.ms ?? curParams.text ?? '');
        paramIn.type = (node.type === 'volume' || node.type === 'wait') ? 'number' : 'text';
        if (node.type === 'wait') {
          // Предел тот же, что у инструмента wait: 0…10000 мс.
          paramIn.min = '0';
          paramIn.max = String(cmdSteps.WAIT_MAX_MS);
        }
        paramIn.value = String(val);
        paramIn.addEventListener('input', () => {
          const parsed = paramIn.type === 'number' && paramIn.value !== '' ? Number(paramIn.value) : paramIn.value;
          const nextTree = cmdSteps.updateTreeNode(targetDraft.steps, stepPath, (prev) => {
            const p = { ...prev.params, [primaryKey]: parsed };
            const a = { ...prev.args, [primaryKey]: parsed };
            return { ...prev, params: p, args: a };
          });
          targetDraft.steps = nextTree;
          markDirty();
        });
        paramField.append(paramLbl, paramIn);
        box.append(paramField);
      }

      return box;
    }

    function renderInspectorPanel() {
      const aside = document.createElement('aside');
      aside.className = 'lx-cmd-inspector';

      if (!draft) {
        const title = document.createElement('h3');
        title.className = 'lx-cmd-insp-title';
        title.textContent = 'Выберите команду или шаг';
        const hint = document.createElement('p');
        hint.className = 'lx-ai-step-detail';
        hint.textContent = 'Нажмите на любую команду в дереве или создайте новую во вкладке «Новая команда».';
        aside.append(title, hint);
        return aside;
      }

      const head = document.createElement('div');
      head.className = 'lx-cmd-insp-head';
      const title = document.createElement('h3');
      title.className = 'lx-cmd-insp-title';
      title.textContent = draft.id ? 'Свойства команды' : 'Черновик команды';

      const headBtns = document.createElement('div');
      headBtns.className = 'lx-cmd-step-nav';
      if (draft.id) {
        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'lx-cmd-mini-btn is-primary';
        runBtn.append(icon('play'), spanText('Запустить'));
        runBtn.addEventListener('click', () => runCommandById(draft.id));
        headBtns.append(runBtn);
      }
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'lx-cmd-mini-btn';
      closeBtn.title = 'Свернуть панель';
      closeBtn.append(icon('x'));
      closeBtn.addEventListener('click', () => {
        inspectorOpen = false;
        renderBody();
      });
      headBtns.append(closeBtn);
      head.append(title, headBtns);
      aside.append(head);

      if (draftError) {
        const errBox = document.createElement('div');
        errBox.className = 'lx-error-box';
        errBox.textContent = draftError;
        aside.append(errBox);
      }

      // Название и программа
      const gridTop = document.createElement('div');
      gridTop.className = 'lx-cmd-grid-2';

      const nameField = document.createElement('label');
      nameField.className = 'lx-cmd-field';
      const nameLbl = document.createElement('span');
      nameLbl.className = 'lx-cmd-field-label';
      nameLbl.textContent = 'Название';
      const nameIn = document.createElement('input');
      nameIn.className = 'lx-cmd-input';
      nameIn.value = draft.name;
      nameIn.placeholder = 'Например: Новый абзац';
      nameIn.addEventListener('input', () => {
        draft.name = nameIn.value;
        markDirty();
      });
      nameField.append(nameLbl, nameIn);

      const progField = document.createElement('label');
      progField.className = 'lx-cmd-field';
      const progLbl = document.createElement('span');
      progLbl.className = 'lx-cmd-field-label';
      progLbl.textContent = 'Программа (необяз.)';
      const progIn = document.createElement('input');
      progIn.className = 'lx-cmd-input';
      progIn.value = draft.program || '';
      progIn.placeholder = 'Например: Chrome, OBS';
      progIn.addEventListener('input', () => {
        draft.program = progIn.value;
        markDirty();
      });
      progField.append(progLbl, progIn);

      gridTop.append(nameField, progField);
      aside.append(gridTop);

      // Папка и горячая клавиша
      const gridMid = document.createElement('div');
      gridMid.className = 'lx-cmd-grid-2';

      const folderField = document.createElement('label');
      folderField.className = 'lx-cmd-field';
      const folderLbl = document.createElement('span');
      folderLbl.className = 'lx-cmd-field-label';
      folderLbl.textContent = 'Папка';
      const folderIn = document.createElement('input');
      folderIn.className = 'lx-cmd-input';
      folderIn.value = draft.folder || '';
      folderIn.placeholder = 'Без папки';
      folderIn.addEventListener('input', () => {
        draft.folder = folderIn.value;
        markDirty();
      });
      folderField.append(folderLbl, folderIn);

      const hkField = document.createElement('label');
      hkField.className = 'lx-cmd-field';
      const hkLbl = document.createElement('span');
      hkLbl.className = 'lx-cmd-field-label';
      hkLbl.textContent = 'Горячая клавиша';
      const hkIn = document.createElement('input');
      hkIn.className = 'lx-cmd-input';
      hkIn.value = draft.hotkey || '';
      hkIn.placeholder = 'Ctrl+Alt+1';
      hkIn.addEventListener('input', () => {
        draft.hotkey = hkIn.value;
        markDirty();
      });
      hkField.append(hkLbl, hkIn);

      gridMid.append(folderField, hkField);
      aside.append(gridMid);

      // Флаги: включена / подтверждать
      const flagsRow = document.createElement('div');
      flagsRow.className = 'lx-cmd-check-row';
      for (const [key, label] of [['enabled', 'Команда активна'], ['confirm', 'Спрашивать подтверждение']]) {
        const lbl = document.createElement('label');
        lbl.className = 'lx-cmd-check-item';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = Boolean(draft[key]);
        chk.addEventListener('change', () => {
          draft[key] = chk.checked;
          markDirty();
        });
        lbl.append(chk, spanText(label));
        flagsRow.append(lbl);
      }
      aside.append(flagsRow);

      // Фразы активации (индивидуальные <input>, чтобы сохранялся точный value для каждой фразы)
      const phrasesBox = document.createElement('div');
      phrasesBox.className = 'lx-cmd-field';
      const phHead = document.createElement('div');
      phHead.className = 'lx-cmd-insp-head';
      const phLbl = document.createElement('span');
      phLbl.className = 'lx-cmd-field-label';
      phLbl.textContent = 'Фразы для запуска';
      const addPhBtn = document.createElement('button');
      addPhBtn.type = 'button';
      addPhBtn.className = 'lx-cmd-mini-btn';
      addPhBtn.textContent = '+ Фраза';
      addPhBtn.addEventListener('click', () => {
        draft.phrases.push('');
        markDirty();
        renderBody();
      });
      phHead.append(phLbl, addPhBtn);

      const phList = document.createElement('div');
      phList.className = 'lx-cmd-phrases-list';
      draft.phrases.forEach((p, idx) => {
        const row = document.createElement('div');
        row.className = 'lx-cmd-phrase-row';
        const pIn = document.createElement('input');
        pIn.className = 'lx-cmd-input';
        pIn.value = p;
        pIn.placeholder = idx === 0 ? 'Главная фраза запуска' : 'Дополнительная формулировка';
        pIn.addEventListener('input', () => {
          draft.phrases[idx] = pIn.value;
          markDirty();
        });
        row.append(pIn);
        if (draft.phrases.length > 1) {
          const remBtn = document.createElement('button');
          remBtn.type = 'button';
          remBtn.className = 'lx-cmd-mini-btn';
          remBtn.title = 'Убрать фразу';
          remBtn.append(icon('x'));
          remBtn.addEventListener('click', () => {
            draft.phrases.splice(idx, 1);
            markDirty();
            renderBody();
          });
          row.append(remBtn);
        }
        phList.append(row);
      });
      phrasesBox.append(phHead, phList);
      aside.append(phrasesBox);

      // Редактор выбранного шага (если выбран шаг в дереве)
      if (selectedKind === 'step' && Array.isArray(selectedStepPath)) {
        const stepSec = buildStepEditorSection(draft, selectedStepPath, (nextTree, nextPath) => {
          draft.steps = nextTree;
          selectedStepPath = nextPath;
          markDirty();
          renderBody();
        });
        if (stepSec) aside.append(stepSec);
      } else {
        const addTopStep = document.createElement('button');
        addTopStep.type = 'button';
        addTopStep.className = 'lx-cmd-mini-btn';
        addTopStep.textContent = '+ Добавить шаг в конец';
        addTopStep.addEventListener('click', () => {
          const next = makeDefaultStep('wait');
          draft.steps = cmdSteps.insertTreeNode(draft.steps, [], draft.steps.length, next);
          selectedStepPath = [draft.steps.length - 1];
          selectedKind = 'step';
          collapsedCommands.delete(draft.id);
          markDirty();
          renderBody();
        });
        aside.append(addTopStep);
      }

      // Низ инспектора: Проверить по порядку / Отмена / Сохранить
      const foot = document.createElement('div');
      foot.className = 'lx-cmd-insp-footer';

      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'lx-cmd-mini-btn';
      previewBtn.textContent = 'Проверить шаги';
      previewBtn.addEventListener('click', () => {
        const lines = cmdSteps.describeSteps(draft.steps, toolTitle, argsBrief);
        store.toast(lines.length ? lines.join(' → ') : 'Шагов пока нет');
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'lx-cmd-mini-btn';
      cancelBtn.textContent = 'Отмена';
      cancelBtn.disabled = !dirty;
      cancelBtn.addEventListener('click', cancelDraftChanges);

      const applySaveBtn = document.createElement('button');
      applySaveBtn.type = 'button';
      applySaveBtn.className = 'lx-cmd-mini-btn is-primary';
      applySaveBtn.textContent = 'Сохранить';
      applySaveBtn.addEventListener('click', saveActiveDraft);

      foot.append(previewBtn, cancelBtn, applySaveBtn);
      aside.append(foot);

      return aside;
    }

    // ── «Опишите словами»: шаги 1 Описание -> 2 Проверка -> 3 Готово ──
    async function runAiDescribeAssemble() {
      const desc = aiDescription.trim();
      if (!desc) {
        aiError = 'Опишите словами, что должна делать команда.';
        renderBody();
        return;
      }
      if (!bridge.has('buildCommandFromText')) {
        aiError = 'Сборщик команд сейчас недоступен.';
        renderBody();
        return;
      }
      aiBusy = true;
      aiError = '';
      aiMissing = [];
      renderBody();
      try {
        const res = await bridge.call('buildCommandFromText', { text: desc });
        aiBusy = false;
        if (!res || res.ok === false) {
          aiError = (res && res.error) || 'Не удалось собрать команду из описания.';
          aiMissing = res && Array.isArray(res.missing) ? res.missing : [];
          aiDraft = null;
          aiStep = aiMissing.length ? 2 : 1;
          renderBody();
          return;
        }
        const cmd = res.command || {};
        const normSteps = cmdSteps.normalizeStepTree(Array.isArray(cmd.steps) ? cmd.steps : []);
        aiMissing = Array.isArray(res.missing) ? res.missing : [];
        if (!normSteps.length) {
          aiDraft = null;
          aiStep = 2;
          aiError = aiMissing.length
            ? 'Не найдено подходящих действий в каталоге.'
            : 'Опишите конкретное действие (например: открыть программу, нажать клавиши, изменить громкость).';
          renderBody();
          return;
        }
        aiDraft = {
          name: String(cmd.name || desc.slice(0, 48)),
          program: cmd.program ? String(cmd.program) : '',
          phrases: Array.isArray(cmd.phrases) && cmd.phrases.length ? cmd.phrases.map(String) : [desc.toLowerCase()],
          hotkey: cmd.hotkey ? String(cmd.hotkey) : '',
          confirm: Boolean(cmd.confirm),
          steps: normSteps.map((step) => ({ step, checked: true })),
        };
        aiStep = 2;
        renderBody();
      } catch (err) {
        aiBusy = false;
        aiError = bridge.errText(err);
        renderBody();
      }
    }

    function renderDescribeTab() {
      const wrap = document.createElement('div');
      wrap.className = 'lx-ai-card';

      // Шаги 1 Описание -> 2 Проверка -> 3 Готово
      const stepper = document.createElement('div');
      stepper.className = 'lx-stepper';
      const STEP_DEFS = [
        [1, 'Описание'],
        [2, 'Проверка'],
        [3, 'Готово'],
      ];
      for (const [num, title] of STEP_DEFS) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.id = `lxDescribeStep_${num}`;
        const active = aiStep === num;
        const done = aiStep > num;
        pill.className = 'lx-stepper-pill' + (active ? ' is-active' : '') + (done ? ' is-done' : '');
        const badge = document.createElement('span');
        badge.className = 'lx-stepper-num';
        badge.textContent = String(num);
        const lbl = document.createElement('span');
        lbl.textContent = title;
        pill.append(badge, lbl);
        pill.addEventListener('click', () => {
          if (num === 1 || (num === 2 && (aiDraft || aiMissing.length)) || (num === 3 && aiDraft)) {
            aiStep = num;
            renderBody();
          }
        });
        stepper.append(pill);
      }
      wrap.append(stepper);

      if (aiError) {
        const err = document.createElement('div');
        err.className = 'lx-error-box';
        err.textContent = aiError;
        wrap.append(err);
      }

      if (aiStep === 1) {
        const f = document.createElement('label');
        f.className = 'lx-cmd-field';
        const lbl = document.createElement('span');
        lbl.className = 'lx-cmd-field-label';
        lbl.textContent = 'Опишите сценарий простыми словами';
        const ta = document.createElement('textarea');
        ta.id = 'lxDescribeInput';
        ta.className = 'lx-cmd-textarea';
        ta.placeholder = 'Например: Открой Блокнот, подожди 2 секунды и напечатай Привет';
        ta.value = aiDescription;
        ta.addEventListener('input', () => { aiDescription = ta.value; });
        f.append(lbl, ta);

        const examples = document.createElement('div');
        examples.className = 'lx-cmd-step-nav';
        for (const sample of [
          'Открой Блокнот и подожди 2 секунды',
          'Открой Chrome и сделай громкость 40%',
        ]) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'lx-cmd-mini-btn';
          chip.textContent = sample;
          chip.addEventListener('click', () => {
            aiDescription = sample;
            ta.value = sample;
          });
          examples.append(chip);
        }

        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.id = 'lxDescribeBuildBtn';
        goBtn.className = 'lx-pill-btn lx-pill-primary';
        goBtn.disabled = aiBusy;
        goBtn.append(icon('sparkles'), spanText(aiBusy ? 'Собираю из действий…' : 'Собрать из действий'));
        goBtn.addEventListener('click', runAiDescribeAssemble);

        wrap.append(f, examples, goBtn);
        return wrap;
      }

      if (aiStep === 2) {
        if (aiMissing.length) {
          const miss = document.createElement('div');
          miss.className = 'lx-missing-box';
          miss.textContent = `Не удалось подобрать из каталога: ${aiMissing.join(' · ')}. Недостающие действия не добавлены.`;
          wrap.append(miss);
        }

        if (!aiDraft || !aiDraft.steps.length) {
          const back = document.createElement('button');
          back.type = 'button';
          back.className = 'lx-pill-btn lx-pill-secondary';
          back.textContent = '← Изменить описание';
          back.addEventListener('click', () => {
            aiStep = 1;
            aiError = '';
            renderBody();
          });
          wrap.append(back);
          return wrap;
        }

        const metaGrid = document.createElement('div');
        metaGrid.className = 'lx-cmd-grid-2';

        const nField = document.createElement('label');
        nField.className = 'lx-cmd-field';
        const nLbl = document.createElement('span');
        nLbl.className = 'lx-cmd-field-label';
        nLbl.textContent = 'Название команды';
        const nIn = document.createElement('input');
        nIn.className = 'lx-cmd-input';
        nIn.value = aiDraft.name;
        nIn.addEventListener('input', () => { aiDraft.name = nIn.value; });
        nField.append(nLbl, nIn);

        const pField = document.createElement('label');
        pField.className = 'lx-cmd-field';
        const pLbl = document.createElement('span');
        pLbl.className = 'lx-cmd-field-label';
        pLbl.textContent = 'Фраза запуска';
        const pIn = document.createElement('input');
        pIn.className = 'lx-cmd-input';
        pIn.value = aiDraft.phrases[0] || '';
        pIn.addEventListener('input', () => { aiDraft.phrases[0] = pIn.value; });
        pField.append(pLbl, pIn);

        metaGrid.append(nField, pField);
        wrap.append(metaGrid);

        const list = document.createElement('div');
        list.className = 'lx-ai-checklist';
        aiDraft.steps.forEach((item, idx) => {
          const row = document.createElement('label');
          row.className = 'lx-ai-step-row';
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.checked = item.checked;
          chk.addEventListener('change', () => { item.checked = chk.checked; });

          const info = document.createElement('div');
          info.className = 'lx-ai-step-main';
          const vis = stepVisual(item.step);
          const t = document.createElement('span');
          t.className = 'lx-ai-step-title';
          t.textContent = `${idx + 1}. ${vis.label}`;
          const d = document.createElement('span');
          d.className = 'lx-ai-step-detail';
          d.textContent = `Тип: ${STEP_TYPE_META[item.step.type]?.label || item.step.type}`;
          info.append(t, d);

          row.append(chk, icon(vis.iconName, 'lx-tree-row-ico'), info);
          list.append(row);
        });
        wrap.append(list);

        const nav = document.createElement('div');
        nav.className = 'lx-cmd-insp-footer';
        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'lx-pill-btn lx-pill-secondary';
        backBtn.textContent = '← К описанию';
        backBtn.addEventListener('click', () => { aiStep = 1; renderBody(); });

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.id = 'lxDescribeNextBtn';
        nextBtn.className = 'lx-pill-btn lx-pill-primary';
        nextBtn.textContent = 'Далее →';
        nextBtn.addEventListener('click', () => {
          const kept = aiDraft.steps.filter((s) => s.checked);
          if (!kept.length) {
            aiError = 'Оставьте хотя бы один шаг с галочкой.';
            renderBody();
            return;
          }
          aiError = '';
          aiStep = 3;
          renderBody();
        });
        nav.append(backBtn, nextBtn);
        wrap.append(nav);
        return wrap;
      }

      // Step 3: Готово
      const chosenSteps = aiDraft ? aiDraft.steps.filter((s) => s.checked).map((s) => s.step) : [];
      const sumTitle = document.createElement('h3');
      sumTitle.className = 'lx-cmd-insp-title';
      sumTitle.textContent = `Готово к сохранению: «${aiDraft?.name || 'Новая команда'}»`;
      const sumSub = document.createElement('p');
      sumSub.className = 'lx-ai-step-detail';
      sumSub.textContent = `Фраза: «${aiDraft?.phrases?.[0] || ''}» · Шагов: ${chosenSteps.length}`;

      const previewList = document.createElement('div');
      previewList.className = 'lx-ai-checklist';
      for (const line of cmdSteps.describeSteps(chosenSteps, toolTitle, argsBrief)) {
        const row = document.createElement('div');
        row.className = 'lx-ai-step-row';
        row.textContent = line;
        previewList.append(row);
      }

      const actions = document.createElement('div');
      actions.className = 'lx-cmd-insp-footer';
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'lx-pill-btn lx-pill-secondary';
      prevBtn.textContent = '← Назад к проверке';
      prevBtn.addEventListener('click', () => { aiStep = 2; renderBody(); });

      const commitBtn = document.createElement('button');
      commitBtn.type = 'button';
      commitBtn.id = 'lxDescribeSaveBtn';
      commitBtn.className = 'lx-pill-btn lx-pill-primary';
      commitBtn.textContent = 'Сохранить команду';
      commitBtn.addEventListener('click', async () => {
        if (!aiDraft || !chosenSteps.length) return;
        const payload = buildSavePayload({
          id: null,
          name: aiDraft.name,
          program: aiDraft.program,
          phrases: aiDraft.phrases,
          hotkey: aiDraft.hotkey,
          confirm: aiDraft.confirm,
          folder: '',
          enabled: true,
          steps: chosenSteps,
          origin: 'ai',
        });
        const res = await saveCommandPayload(payload);
        if (!res.ok) {
          aiError = res.error;
          renderBody();
          store.toast(res.error, 'error');
          return;
        }
        const savedId = res.command && res.command.id ? res.command.id : null;
        aiStep = 1;
        aiDescription = '';
        aiDraft = null;
        aiMissing = [];
        viewMode = 'tree';
        inspectorOpen = true;
        if (savedId) selectCommandById(savedId, true);
        store.toast(`Команда «${payload.name}» сохранена`, 'ok');
        renderView();
      });

      actions.append(prevBtn, commitBtn);
      wrap.append(sumTitle, sumSub, previewList, actions);
      return wrap;
    }

    function renderSayTab() {
      const card = document.createElement('div');
      card.className = 'lx-ai-card';
      const title = document.createElement('h3');
      title.className = 'lx-cmd-insp-title';
      title.textContent = 'Скажите команду голосом';
      const hint = document.createElement('p');
      hint.className = 'lx-ai-step-detail';
      hint.textContent = 'Нажмите микрофон и произнесите сценарий, например: «Открой калькулятор и подожди 2 секунды». Используется встроенное распознавание Windows.';

      const active = Boolean(voiceTarget && voiceTarget.mode === 'say');
      const micBtn = document.createElement('button');
      micBtn.type = 'button';
      micBtn.className = active ? 'lx-pill-btn lx-pill-secondary' : 'lx-pill-btn lx-pill-primary';
      micBtn.append(icon(active ? 'stop' : 'mic'), spanText(active ? 'Остановить запись' : 'Начать запись голосом'));
      micBtn.addEventListener('click', () => {
        if (active) stopVoiceCapture(true);
        else startVoiceCapture({ mode: 'say' });
      });

      card.append(title, hint, micBtn);
      return card;
    }

    function renderWriteTab() {
      if (!writeDraft) resetWriteDraft();
      const card = document.createElement('div');
      card.className = 'lx-ai-card';

      if (draftError) {
        const err = document.createElement('div');
        err.className = 'lx-error-box';
        err.textContent = draftError;
        card.append(err);
      }

      const top = document.createElement('div');
      top.className = 'lx-cmd-grid-2';

      const nField = document.createElement('label');
      nField.className = 'lx-cmd-field';
      const nLbl = document.createElement('span');
      nLbl.className = 'lx-cmd-field-label';
      nLbl.textContent = 'Название';
      const nIn = document.createElement('input');
      nIn.className = 'lx-cmd-input';
      nIn.value = writeDraft.name;
      nIn.placeholder = 'Например: Утренний набор';
      nIn.addEventListener('input', () => { writeDraft.name = nIn.value; });
      nField.append(nLbl, nIn);

      const pField = document.createElement('label');
      pField.className = 'lx-cmd-field';
      const pLbl = document.createElement('span');
      pLbl.className = 'lx-cmd-field-label';
      pLbl.textContent = 'Фраза запуска';
      const pIn = document.createElement('input');
      pIn.className = 'lx-cmd-input';
      pIn.value = writeDraft.phrases[0] || '';
      pIn.placeholder = 'Например: доброе утро';
      pIn.addEventListener('input', () => { writeDraft.phrases[0] = pIn.value; });
      pField.append(pLbl, pIn);

      top.append(nField, pField);
      card.append(top);

      const stepsHeader = document.createElement('div');
      stepsHeader.className = 'lx-cmd-insp-head';
      const stLbl = document.createElement('span');
      stLbl.className = 'lx-cmd-field-label';
      stLbl.textContent = `Шаги (${cmdSteps.countTreeSteps(writeDraft.steps)})`;
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'lx-cmd-mini-btn';
      addBtn.textContent = '+ Добавить шаг';
      addBtn.addEventListener('click', () => {
        const next = makeDefaultStep('wait');
        writeDraft.steps = cmdSteps.insertTreeNode(writeDraft.steps, [], writeDraft.steps.length, next);
        writeSelectedPath = [writeDraft.steps.length - 1];
        renderBody();
      });
      stepsHeader.append(stLbl, addBtn);
      card.append(stepsHeader);

      const flat = cmdSteps.flattenTreeForRender(writeDraft.steps);
      for (const entry of flat) {
        const vis = stepVisual(entry.node);
        const sel = Array.isArray(writeSelectedPath) && writeSelectedPath.join('.') === entry.path.join('.');
        const { wrap } = makeTreeRow({
          depth: entry.depth,
          iconName: vis.iconName,
          label: `${entry.labelIndex}. ${vis.label}`,
          selected: sel,
          onSelect: () => { writeSelectedPath = entry.path.slice(); renderBody(); },
          rowActions: [
            {
              icon: 'trash',
              title: 'Удалить шаг',
              onClick: () => {
                writeDraft.steps = cmdSteps.deleteTreeNode(writeDraft.steps, entry.path);
                writeSelectedPath = writeDraft.steps.length ? [0] : null;
                renderBody();
              },
            },
          ],
        });
        card.append(wrap);
      }

      if (writeSelectedPath && writeSelectedPath.length) {
        const sec = buildStepEditorSection(writeDraft, writeSelectedPath, (nextTree, nextPath) => {
          writeDraft.steps = nextTree;
          writeSelectedPath = nextPath;
          renderBody();
        });
        if (sec) card.append(sec);
      }

      const foot = document.createElement('div');
      foot.className = 'lx-cmd-insp-footer';
      const cancelB = document.createElement('button');
      cancelB.type = 'button';
      cancelB.className = 'lx-pill-btn lx-pill-secondary';
      cancelB.textContent = 'Отмена';
      cancelB.addEventListener('click', () => {
        resetWriteDraft();
        viewMode = 'tree';
        renderView();
      });
      const saveB = document.createElement('button');
      saveB.type = 'button';
      saveB.className = 'lx-pill-btn lx-pill-primary';
      saveB.textContent = 'Сохранить команду';
      saveB.addEventListener('click', saveWriteDraft);
      foot.append(cancelB, saveB);
      card.append(foot);

      return card;
    }

    function renderNewPanel() {
      const shell = document.createElement('div');
      shell.className = 'lx-new-shell';

      const tabs = document.createElement('div');
      tabs.className = 'lx-new-tabs';
      for (const [id, label] of [
        ['say', 'Скажите'],
        ['write', 'Напишите'],
        ['describe', 'Опишите словами'],
      ]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = `lxNewTab_${id}`;
        b.className = newSubTab === id ? 'lx-new-tab is-active' : 'lx-new-tab';
        b.textContent = label;
        b.addEventListener('click', () => {
          newSubTab = id;
          draftError = '';
          renderBody();
        });
        tabs.append(b);
      }
      shell.append(tabs);

      if (newSubTab === 'say') shell.append(renderSayTab());
      else if (newSubTab === 'write') shell.append(renderWriteTab());
      else shell.append(renderDescribeTab());

      return shell;
    }

    // ── Готовые паки в один клик ─────────────────────────────────
    function renderPacksPanel() {
      const grid = document.createElement('div');
      grid.className = 'lx-cmd-packs-grid';
      if (!packsList.length) {
        const empty = document.createElement('div');
        empty.className = 'lx-empty-box';
        empty.textContent = 'Паки команд загружаются или отсутствуют.';
        grid.append(empty);
        return grid;
      }

      for (const p of packsList) {
        const total = Number(p.total) || 0;
        const installed = Number(p.installed) || 0;
        const done = total > 0 && installed >= total;

        const card = document.createElement('article');
        card.className = 'lx-cmd-pack-card';
        card.dataset.packId = p.id;

        const title = document.createElement('strong');
        title.textContent = p.title || p.id;
        const desc = document.createElement('span');
        desc.className = 'lx-ai-step-detail';
        desc.textContent = p.hint || p.description || '';

        const foot = document.createElement('div');
        foot.className = 'lx-cmd-pack-foot';
        const cnt = document.createElement('span');
        cnt.className = 'lx-tree-row-meta';
        cnt.textContent = done ? `Установлено ${installed}/${total}` : `${installed} из ${total}`;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = done ? 'lx-cmd-mini-btn' : 'lx-cmd-mini-btn is-primary';
        btn.disabled = done;
        btn.textContent = done ? 'Установлено' : 'Установить';
        btn.addEventListener('click', async () => {
          if (!bridge.has('installPack')) return;
          btn.disabled = true;
          try {
            const r = await bridge.call('installPack', p.id);
            if (!r || r.ok === false) throw new Error((r && r.error) || 'Не удалось установить пак');
            await Promise.all([loadPacks(), loadMyCommands()]);
            emitCommandsUpdated();
            store.toast(r.added ? `«${p.title}»: добавлено команд ${r.added}` : `Пак «${p.title}» уже установлен`, 'ok');
            renderBody();
          } catch (err) {
            btn.disabled = false;
            store.toast(bridge.errText(err), 'error');
          }
        });

        foot.append(cnt, btn);
        card.append(title, desc, foot);
        grid.append(card);
      }

      return grid;
    }

    // ── Журнал запусков и триггеры ───────────────────────────────
    function renderLaunchesPanel() {
      const shell = document.createElement('div');
      shell.className = 'lx-new-shell';

      const controls = document.createElement('div');
      controls.className = 'lx-cmd-step-nav';

      const stSel = document.createElement('select');
      stSel.className = 'lx-cmd-select';
      stSel.style.width = '180px';
      for (const [val, label] of [
        ['all', 'Все статусы'],
        ['succeeded', 'Выполнена'],
        ['partial', 'Частично'],
        ['failed', 'Ошибка'],
      ]) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        opt.selected = logFilterStatus === val;
        stSel.append(opt);
      }
      stSel.addEventListener('change', () => { logFilterStatus = stSel.value; renderBody(); });

      const trSel = document.createElement('select');
      trSel.className = 'lx-cmd-select';
      trSel.style.width = '180px';
      for (const [val, label] of [
        ['all', 'Все триггеры'],
        ['phrase', 'По фразе'],
        ['hotkey', 'Клавиша'],
        ['schedule', 'Расписание'],
        ['event', 'Событие'],
        ['manual', 'Вручную'],
      ]) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        opt.selected = logFilterTrigger === val;
        trSel.append(opt);
      }
      trSel.addEventListener('change', () => { logFilterTrigger = trSel.value; renderBody(); });

      const refreshB = document.createElement('button');
      refreshB.type = 'button';
      refreshB.className = 'lx-cmd-mini-btn';
      refreshB.textContent = 'Обновить';
      refreshB.addEventListener('click', async () => { await loadLaunches(); renderBody(); });

      controls.append(stSel, trSel, refreshB);
      shell.append(controls);

      const rawLog = launchOverview && Array.isArray(launchOverview.log) ? launchOverview.log : [];
      const rows = cmdSteps.filterLaunchLog(rawLog, {
        status: logFilterStatus,
        trigger: logFilterTrigger,
        query: searchQuery,
      });

      const list = document.createElement('div');
      list.className = 'lx-launch-table';
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'lx-empty-box';
        empty.textContent = 'Записей запусков пока нет.';
        list.append(empty);
      } else {
        for (const r of rows) {
          const row = document.createElement('div');
          row.className = 'lx-launch-row';
          const name = document.createElement('strong');
          name.textContent = r.commandName;
          const trig = document.createElement('span');
          trig.textContent = r.triggerLabel;
          const badge = document.createElement('span');
          badge.className = `lx-launch-badge is-${r.statusTone}`;
          badge.textContent = r.statusLabel;
          const dur = document.createElement('span');
          dur.textContent = r.durationText;
          const reason = document.createElement('span');
          reason.textContent = r.reason || (r.stepsText !== '—' ? `Шагов ${r.stepsText}` : '');
          row.append(name, trig, badge, dur, reason);
          list.append(row);
        }
      }
      shell.append(list);
      return shell;
    }

    // ── Синхронизация шапки и тела ────────────────────────────────
    function syncToolbarState() {
      segEditBtn.classList.toggle('is-active', viewMode === 'tree');
      segNewBtn.classList.toggle('is-active', viewMode === 'new');
      packsBtn.classList.toggle('is-active', viewMode === 'packs');
      launchesBtn.classList.toggle('is-active', viewMode === 'launches');

      saveBtn.hidden = viewMode === 'packs' || viewMode === 'launches';
      saveBtn.classList.toggle('is-dirty', dirty || (viewMode === 'new' && newSubTab === 'write'));
      if (viewMode === 'tree') {
        saveBtn.disabled = !draft || !dirty;
      } else if (viewMode === 'new') {
        saveBtn.hidden = newSubTab !== 'write';
        saveBtn.disabled = false;
      }
    }

    function renderBody() {
      syncToolbarState();
      syncVoiceBanner();
      const showInspector = viewMode === 'tree' && inspectorOpen;
      body.className = showInspector ? 'lx-cmd-workspace has-inspector' : 'lx-cmd-workspace';

      if (viewMode === 'new') {
        body.replaceChildren(renderNewPanel());
      } else if (viewMode === 'packs') {
        body.replaceChildren(renderPacksPanel());
      } else if (viewMode === 'launches') {
        body.replaceChildren(renderLaunchesPanel());
      } else {
        const children = [renderTreePanel()];
        if (showInspector) children.push(renderInspectorPanel());
        body.replaceChildren(...children);
      }
    }

    function scrollSelectedTreeRow(block = 'nearest') {
      if (typeof requestAnimationFrame !== 'function') return;
      requestAnimationFrame(() => {
        const sel = body.querySelector('.lx-tree-row.is-selected');
        if (sel && typeof sel.scrollIntoView === 'function') {
          sel.scrollIntoView({ block });
        }
      });
    }

    function renderView() {
      renderBody();
    }

    function reloadCurrentViewData() {
      return loadMyCommands().then(() => {
        if (viewMode === 'packs') return loadPacks();
        if (viewMode === 'launches') return loadLaunches();
        return null;
      }).then(() => renderView());
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('nox:commands-updated', () => {
        if (loaded && !root.hidden) reloadCurrentViewData();
        else dirtyReload = true;
      });
    }

    function onEvent(ev) {
      if (!ev) return;
      if (ev.type === 'commands:changed') {
        if (loaded && !root.hidden) {
          reloadCurrentViewData();
        } else {
          dirtyReload = true;
        }
      }
    }

    async function openCommand(id) {
      if (!id) return false;
      viewMode = 'tree';
      inspectorOpen = true;
      dirtyReload = false;
      if (!loaded) await loadAll();
      else await loadMyCommands();

      if (selectCommandById(String(id), true)) {
        collapsedCommands.delete(String(id));
        renderView();
        scrollSelectedTreeRow('center');
        return true;
      }
      return false;
    }

    function render(st) {
      const show = st.route === 'commands';
      root.hidden = !show;
      if (!show) return;
      const pendingId = typeof store.consumePendingCommandId === 'function'
        ? store.consumePendingCommandId()
        : (st.pendingCommandId ? (() => { const v = st.pendingCommandId; st.pendingCommandId = null; return v; })() : null);
      if (pendingId) {
        openCommand(pendingId);
      } else if (!loaded || dirtyReload) {
        dirtyReload = false;
        loadAll();
      }
    }

    return {
      el: root,
      render,
      onEvent,
      onDictationEvent,
      refresh: loadAll,
      openCommand,
      // Для автопроверок и снимков интерфейса (Фаза 2)
      getUiDebugApi: () => ({
        setMode: async (mode, subTab) => {
          viewMode = mode || 'tree';
          if (subTab) newSubTab = subTab;
          if (viewMode === 'packs') await loadPacks();
          if (viewMode === 'launches') await loadLaunches();
          renderView();
        },
        selectCommand: (id, openPanel = false) => {
          viewMode = 'tree';
          inspectorOpen = Boolean(openPanel);
          selectCommandById(String(id || ''), Boolean(openPanel));
          if (id) collapsedCommands.delete(String(id));
          renderView();
          scrollSelectedTreeRow('center');
        },
        setDescribeState: ({ description, step, draftObj, missing } = {}) => {
          viewMode = 'new';
          newSubTab = 'describe';
          if (typeof description === 'string') aiDescription = description;
          if (step) aiStep = step;
          if (draftObj) aiDraft = draftObj;
          if (Array.isArray(missing)) aiMissing = missing;
          renderView();
        },
      }),
    };
  }

  window.NoxAetherCommandsView = { createCommandsView };
})();
