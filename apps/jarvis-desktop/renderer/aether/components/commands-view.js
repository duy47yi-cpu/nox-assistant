/* Раздел «Готовые команды» Nox Aether:
 * - «Мои команды»: список, поиск, редактор шагов (CmdSteps), запуск, запись действий, триггеры, экспорт/импорт;
 * - «Готовые паки»: карточки с установкой в один клик (packs:install — никогда не ставятся сами);
 * - «Библиотека»: встроенные быстрые шаблоны;
 * - «Запуски»: обзор триггеров, горячих клавиш, расписаний и журнал запусков. */
(() => {
  'use strict';

  function createCommandsView({ store, bridge }) {
    const ui = window.JarvisUI || {};
    const { icon } = window.NoxAetherIcons;
    const scrub = typeof ui.scrub === 'function' ? ui.scrub : (s) => String(s || '');
    const toolTitle = typeof ui.toolTitle === 'function' ? ui.toolTitle : (t) => String(t || 'Шаг');
    const argsBrief = typeof ui.argsBrief === 'function' ? ui.argsBrief : () => '';
    const cmdSteps = window.CmdSteps || null;

    const root = document.createElement('section');
    root.className = 'ae-page ae-commands-page';
    root.id = 'aeCommandsView';
    root.hidden = true;
    root.setAttribute('aria-label', 'Готовые команды');

    let activeTab = 'my'; // 'my' | 'packs' | 'library' | 'launches'
    let commandsList = [];
    let packsList = [];
    let libraryList = [];
    let toolCatalog = [];
    let launchOverview = null;
    let selectedId = null;
    let draft = null;
    let filterQuery = '';
    let recordingActive = false;
    let recordedSteps = [];
    let deleteConfirmId = null;
    let loaded = false;

    const header = document.createElement('div');
    header.className = 'ae-page-head';
    const titleWrap = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.className = 'ae-page-title';
    h1.textContent = 'Готовые команды';
    const sub = document.createElement('p');
    sub.className = 'ae-page-sub';
    sub.textContent = 'Сценарии и цепочки шагов по одной фразе, горячей клавише или расписанию.';
    titleWrap.append(h1, sub);

    const headActions = document.createElement('div');
    headActions.className = 'ae-head-actions';
    const recordBtn = document.createElement('button');
    recordBtn.type = 'button';
    recordBtn.className = 'ae-btn ae-btn-secondary';
    recordBtn.append(icon('play'), (() => { const s = document.createElement('span'); s.textContent = 'Записать шаги'; return s; })());

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'ae-btn ae-btn-ghost';
    importBtn.textContent = 'Импорт';

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'ae-btn ae-btn-primary';
    newBtn.append(icon('plus'), (() => { const s = document.createElement('span'); s.textContent = 'Новая команда'; return s; })());

    headActions.append(recordBtn, importBtn, newBtn);
    header.append(titleWrap, headActions);

    const tabsBar = document.createElement('div');
    tabsBar.className = 'ae-subtabs';
    const TAB_DEFS = [
      ['my', 'Мои команды'],
      ['packs', 'Готовые паки'],
      ['library', 'Библиотека'],
      ['launches', 'Запуски'],
    ];
    const tabBtns = new Map();
    for (const [id, label] of TAB_DEFS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ae-subtab';
      b.textContent = label;
      b.addEventListener('click', () => {
        activeTab = id;
        refreshCurrentTab();
      });
      tabsBar.append(b);
      tabBtns.set(id, b);
    }

    const recordStrip = document.createElement('div');
    recordStrip.className = 'ae-record-strip';
    recordStrip.hidden = true;

    const body = document.createElement('div');
    body.className = 'ae-commands-body';

    root.append(header, tabsBar, recordStrip, body);

    function normCmd(c) {
      if (!c || typeof c !== 'object') return null;
      return {
        id: c.id ?? null,
        name: String(c.name || ''),
        phrases: Array.isArray(c.phrases) ? c.phrases.map(String) : [],
        steps: Array.isArray(c.steps) ? c.steps.map((s) => ({ tool: String(s.tool || ''), args: s.args && typeof s.args === 'object' ? { ...s.args } : {} })) : [],
        enabled: c.enabled !== false,
        folder: c.folder ? String(c.folder) : '',
        hotkey: c.hotkey ? String(c.hotkey) : '',
        triggers: c.triggers && typeof c.triggers === 'object' ? JSON.parse(JSON.stringify(c.triggers)) : {},
        origin: c.origin || 'manual',
        lastRunAt: c.lastRunAt || null,
      };
    }

    async function loadAll() {
      loaded = true;
      await Promise.allSettled([loadMyCommands(), loadCatalog(), loadPacks(), loadLibrary()]);
      if (activeTab === 'launches') await loadLaunches();
      renderView();
    }

    async function loadMyCommands() {
      if (!bridge.has('listCommands')) { commandsList = []; return; }
      try {
        const r = await bridge.call('listCommands');
        const arr = Array.isArray(r) ? r : (r && Array.isArray(r.commands) ? r.commands : []);
        commandsList = arr.map(normCmd).filter(Boolean);
        if (selectedId && !draft) {
          const hit = commandsList.find((c) => c.id === selectedId);
          if (hit) draft = normCmd(hit);
        }
      } catch (err) {
        store.toast(`Команды не загрузились: ${bridge.errText(err)}`, 'error');
      }
    }

    async function loadCatalog() {
      if (!bridge.has('toolCatalog')) return;
      try {
        const r = await bridge.call('toolCatalog');
        toolCatalog = Array.isArray(r) ? r.filter((t) => t && t.name) : [];
      } catch { toolCatalog = []; }
    }

    async function loadPacks() {
      if (!bridge.has('installPack')) { packsList = []; return; }
      try {
        const r = await bridge.call('installPack');
        packsList = r && r.ok && Array.isArray(r.packs) ? r.packs : [];
      } catch { packsList = []; }
    }

    async function loadLibrary() {
      if (!bridge.has('libraryList')) { libraryList = []; return; }
      try {
        const r = await bridge.call('libraryList');
        libraryList = Array.isArray(r) ? r : [];
      } catch { libraryList = []; }
    }

    async function loadLaunches() {
      if (!bridge.has('getCommandLaunches')) { launchOverview = null; return; }
      try {
        const r = await bridge.call('getCommandLaunches', {});
        launchOverview = r && r.ok ? r : null;
      } catch { launchOverview = null; }
    }

    async function refreshCurrentTab() {
      if (activeTab === 'my') await loadMyCommands();
      else if (activeTab === 'packs') await loadPacks();
      else if (activeTab === 'library') await loadLibrary();
      else if (activeTab === 'launches') await loadLaunches();
      renderView();
    }

    newBtn.addEventListener('click', () => {
      activeTab = 'my';
      selectedId = null;
      draft = normCmd({ id: null, name: '', phrases: [], steps: [], enabled: true });
      renderView();
    });

    importBtn.addEventListener('click', async () => {
      if (!bridge.has('pickCommandsImport')) return;
      try {
        const preview = await bridge.call('pickCommandsImport');
        if (!preview || preview.canceled) return;
        if (preview.ok === false) {
          store.toast(preview.error || 'Не удалось прочитать файл импорта', 'error');
          return;
        }
        const apply = await bridge.call('applyCommandsImport', preview.token, true);
        if (apply && apply.ok !== false) {
          store.toast(`Импорт завершён: добавлено ${apply.added || 0}, обновлено ${apply.updated || 0}`, 'ok');
          await loadMyCommands();
          renderView();
        } else {
          store.toast((apply && apply.error) || 'Импорт не удался', 'error');
        }
      } catch (err) {
        store.toast(`Импорт не удался: ${bridge.errText(err)}`, 'error');
      }
    });

    recordBtn.addEventListener('click', async () => {
      if (recordingActive) {
        try {
          const r = await bridge.call('recordStop');
          recordingActive = false;
          const steps = r && Array.isArray(r.steps) ? r.steps : recordedSteps;
          if (steps.length) {
            activeTab = 'my';
            selectedId = null;
            draft = normCmd({ id: null, name: 'Записанная команда', phrases: [], steps, enabled: true, origin: 'recorded' });
            store.toast(`Записано шагов: ${steps.length}`, 'ok');
          } else {
            store.toast('Ни одного шага не записано');
          }
        } catch (err) {
          recordingActive = false;
          store.toast(`Ошибка остановки записи: ${bridge.errText(err)}`, 'error');
        }
        renderView();
        return;
      }

      if (!bridge.has('recordStart')) return;
      try {
        const r = await bridge.call('recordStart');
        if (r && r.ok === false) {
          store.toast(r.error || 'Запись не запустилась', 'error');
          return;
        }
        recordingActive = true;
        recordedSteps = [];
        store.toast('Запись включена: выполните нужные шаги в чате и нажмите «Остановить запись»');
        renderView();
      } catch (err) {
        store.toast(`Запись не запустилась: ${bridge.errText(err)}`, 'error');
      }
    });

    function renderRecordBar() {
      if (!recordingActive) {
        recordStrip.hidden = true;
        recordStrip.replaceChildren();
        return;
      }
      recordStrip.hidden = false;
      const txt = document.createElement('span');
      txt.textContent = `Идёт запись шагов (зафиксировано: ${recordedSteps.length}). Выполняйте действия через Nox, затем завершите запись.`;
      const stopB = document.createElement('button');
      stopB.type = 'button';
      stopB.className = 'ae-btn ae-btn-primary ae-btn-sm';
      stopB.textContent = 'Завершить и редактировать';
      stopB.addEventListener('click', () => recordBtn.click());
      const cancelB = document.createElement('button');
      cancelB.type = 'button';
      cancelB.className = 'ae-btn ae-btn-ghost ae-btn-sm';
      cancelB.textContent = 'Отменить';
      cancelB.addEventListener('click', async () => {
        recordingActive = false;
        recordedSteps = [];
        await bridge.call('recordCancel').catch(() => {});
        renderView();
      });
      recordStrip.replaceChildren(txt, stopB, cancelB);
    }

    function renderMyCommands() {
      const layout = document.createElement('div');
      layout.className = 'ae-split-pane';

      // Левая колонка: список + поиск
      const listCol = document.createElement('div');
      listCol.className = 'ae-pane-list';

      const searchBox = document.createElement('input');
      searchBox.type = 'search';
      searchBox.className = 'ae-input';
      searchBox.placeholder = 'Найти по названию или фразе…';
      searchBox.value = filterQuery;
      searchBox.addEventListener('input', () => {
        filterQuery = searchBox.value;
        renderListItems();
      });

      const ul = document.createElement('div');
      ul.className = 'ae-card-list';

      function renderListItems() {
        const q = filterQuery.trim().toLowerCase();
        const items = q
          ? commandsList.filter((c) => c.name.toLowerCase().includes(q) || c.phrases.some((p) => p.toLowerCase().includes(q)))
          : commandsList;
        ul.replaceChildren();
        if (!items.length) {
          const emp = document.createElement('div');
          emp.className = 'ae-empty-pane';
          emp.textContent = q ? 'По запросу команд нет.' : 'Команд пока нет. Создайте свою или установите готовый пак.';
          ul.append(emp);
          return;
        }
        for (const cmd of items) {
          const card = document.createElement('div');
          const active = draft && draft.id !== null && draft.id === cmd.id;
          card.className = active ? 'ae-item-card is-selected' : 'ae-item-card';

          const pickBtn = document.createElement('button');
          pickBtn.type = 'button';
          pickBtn.className = 'ae-item-main';
          const nm = document.createElement('strong');
          nm.className = 'ae-item-title';
          nm.textContent = cmd.name || 'Без названия';
          const meta = document.createElement('span');
          meta.className = 'ae-item-meta';
          const ph = cmd.phrases[0] ? `«${cmd.phrases[0]}»` : 'без фразы';
          meta.textContent = `${ph} · шагов: ${cmd.steps.length}${cmd.enabled ? '' : ' · выкл.'}`;
          pickBtn.append(nm, meta);
          pickBtn.addEventListener('click', () => {
            selectedId = cmd.id;
            draft = normCmd(cmd);
            renderView();
          });

          const runBtn = document.createElement('button');
          runBtn.type = 'button';
          runBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
          runBtn.textContent = 'Запустить';
          runBtn.disabled = !cmd.enabled;
          runBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!bridge.has('runCommand')) return;
            runBtn.disabled = true;
            try {
              const res = await bridge.call('runCommand', cmd.id);
              const ok = res && res.ok !== false;
              store.toast(ok ? `«${cmd.name}» выполнена` : `«${cmd.name}»: ${scrub((res && res.error) || 'ошибка')}`, ok ? 'ok' : 'error');
              await loadMyCommands();
              renderView();
            } catch (err) {
              store.toast(`Ошибка запуска: ${bridge.errText(err)}`, 'error');
            } finally {
              runBtn.disabled = false;
            }
          });

          card.append(pickBtn, runBtn);
          ul.append(card);
        }
      }

      renderListItems();
      listCol.append(searchBox, ul);

      // Правая колонка: редактор
      const editCol = document.createElement('div');
      editCol.className = 'ae-pane-detail';

      if (!draft) {
        const hint = document.createElement('div');
        hint.className = 'ae-empty-pane';
        hint.textContent = 'Выберите команду слева для настройки или создайте новую.';
        editCol.append(hint);
      } else {
        const form = document.createElement('div');
        form.className = 'ae-form-stack';

        const topRow = document.createElement('div');
        topRow.className = 'ae-detail-head';
        const h2 = document.createElement('h2');
        h2.textContent = draft.id ? (draft.name || 'Редактор команды') : 'Новая команда';
        const enLabel = document.createElement('label');
        enLabel.className = 'ae-switch-row';
        const enChk = document.createElement('input');
        enChk.type = 'checkbox';
        enChk.checked = draft.enabled !== false;
        enChk.addEventListener('change', () => { draft.enabled = enChk.checked; });
        const enTxt = document.createElement('span');
        enTxt.textContent = 'Включена';
        enLabel.append(enChk, enTxt);
        topRow.append(h2, enLabel);

        const nameField = document.createElement('label');
        nameField.className = 'ae-field';
        nameField.append((() => { const s = document.createElement('span'); s.textContent = 'Название'; return s; })());
        const nameInp = document.createElement('input');
        nameInp.type = 'text';
        nameInp.className = 'ae-input';
        nameInp.value = draft.name;
        nameInp.placeholder = 'Например: Утренний обзор';
        nameInp.addEventListener('input', () => { draft.name = nameInp.value; });
        nameField.append(nameInp);

        const phraseField = document.createElement('label');
        phraseField.className = 'ae-field';
        phraseField.append((() => { const s = document.createElement('span'); s.textContent = 'Фразы для запуска (через запятую)'; return s; })());
        const phraseInp = document.createElement('input');
        phraseInp.type = 'text';
        phraseInp.className = 'ae-input';
        phraseInp.value = draft.phrases.join(', ');
        phraseInp.placeholder = 'открой заметки, мои заметки';
        phraseInp.addEventListener('input', () => {
          draft.phrases = phraseInp.value.split(',').map((s) => s.trim()).filter(Boolean);
        });
        phraseField.append(phraseInp);

        const hotkeyField = document.createElement('label');
        hotkeyField.className = 'ae-field';
        hotkeyField.append((() => { const s = document.createElement('span'); s.textContent = 'Горячая клавиша (необязательно)'; return s; })());
        const hkInp = document.createElement('input');
        hkInp.type = 'text';
        hkInp.className = 'ae-input';
        hkInp.value = draft.hotkey || (draft.triggers && draft.triggers.hotkey && draft.triggers.hotkey.key) || '';
        hkInp.placeholder = 'Например: Ctrl+Alt+1';
        hkInp.addEventListener('input', () => { draft.hotkey = hkInp.value.trim(); });
        hotkeyField.append(hkInp);

        // Шаги команды
        const stepsSec = document.createElement('div');
        stepsSec.className = 'ae-steps-sec';
        const stepsHead = document.createElement('div');
        stepsHead.className = 'ae-steps-head';
        const stTitle = document.createElement('strong');
        stTitle.textContent = `Шаги (${draft.steps.length})`;

        const addToolSel = document.createElement('select');
        addToolSel.className = 'ae-select ae-select-sm';
        const defOpt = document.createElement('option');
        defOpt.value = '';
        defOpt.textContent = '+ Добавить шаг…';
        addToolSel.append(defOpt);
        for (const t of toolCatalog) {
          const o = document.createElement('option');
          o.value = t.name;
          o.textContent = t.title || toolTitle(t.name);
          addToolSel.append(o);
        }
        addToolSel.addEventListener('change', () => {
          if (!addToolSel.value) return;
          draft.steps.push({ tool: addToolSel.value, args: {} });
          addToolSel.value = '';
          renderView();
        });
        stepsHead.append(stTitle, addToolSel);

        const stepsUl = document.createElement('div');
        stepsUl.className = 'ae-steps-list';
        draft.steps.forEach((step, idx) => {
          const sRow = document.createElement('div');
          sRow.className = 'ae-step-row';
          const info = document.createElement('div');
          info.className = 'ae-step-info';
          const lbl = document.createElement('strong');
          lbl.textContent = `${idx + 1}. ${toolTitle(step.tool)}`;
          const argBrief = argsBrief(step.args);
          if (argBrief) {
            const subL = document.createElement('span');
            subL.className = 'ae-step-brief';
            subL.textContent = scrub(argBrief);
            info.append(lbl, subL);
          } else {
            info.append(lbl);
          }
          const warn = cmdSteps && typeof cmdSteps.stepWarning === 'function' ? cmdSteps.stepWarning(step) : null;
          if (warn) {
            const wEl = document.createElement('span');
            wEl.className = 'ae-step-warn';
            wEl.textContent = warn;
            info.append(wEl);
          }

          const ctrls = document.createElement('div');
          ctrls.className = 'ae-step-ctrls';
          const upB = document.createElement('button');
          upB.type = 'button';
          upB.className = 'ae-btn ae-btn-ghost ae-btn-xs';
          upB.textContent = '↑';
          upB.disabled = idx === 0;
          upB.addEventListener('click', () => {
            if (cmdSteps) draft.steps = cmdSteps.moveStep(draft.steps, idx, -1);
            renderView();
          });
          const dnB = document.createElement('button');
          dnB.type = 'button';
          dnB.className = 'ae-btn ae-btn-ghost ae-btn-xs';
          dnB.textContent = '↓';
          dnB.disabled = idx === draft.steps.length - 1;
          dnB.addEventListener('click', () => {
            if (cmdSteps) draft.steps = cmdSteps.moveStep(draft.steps, idx, 1);
            renderView();
          });
          const rmB = document.createElement('button');
          rmB.type = 'button';
          rmB.className = 'ae-btn ae-btn-ghost ae-btn-xs';
          rmB.textContent = '×';
          rmB.addEventListener('click', () => {
            draft.steps.splice(idx, 1);
            renderView();
          });
          ctrls.append(upB, dnB, rmB);
          sRow.append(info, ctrls);
          stepsUl.append(sRow);
        });

        stepsSec.append(stepsHead, stepsUl);

        const errBox = document.createElement('p');
        errBox.className = 'ae-form-err';
        errBox.hidden = true;

        const footer = document.createElement('div');
        footer.className = 'ae-form-actions';

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'ae-btn ae-btn-primary';
        saveBtn.textContent = 'Сохранить';
        saveBtn.addEventListener('click', async () => {
          if (!draft.name.trim()) {
            errBox.textContent = 'Укажите название команды.';
            errBox.hidden = false;
            return;
          }
          if (!draft.phrases.length && !draft.hotkey) {
            errBox.textContent = 'Добавьте хотя бы одну фразу для запуска или горячую клавишу.';
            errBox.hidden = false;
            return;
          }
          if (!draft.steps.length) {
            errBox.textContent = 'Добавьте хотя бы один шаг.';
            errBox.hidden = false;
            return;
          }
          errBox.hidden = true;
          const baseTr = cmdSteps && typeof cmdSteps.normalizeTriggersModel === 'function'
            ? cmdSteps.normalizeTriggersModel(draft.triggers, draft.hotkey || null)
            : { hotkey: { enabled: Boolean(draft.hotkey), key: draft.hotkey || null } };
          if (draft.hotkey) {
            baseTr.hotkey = { ...(baseTr.hotkey || {}), enabled: true, key: draft.hotkey };
          }
          const payload = {
            name: draft.name.trim(),
            phrases: draft.phrases.slice(),
            steps: draft.steps.map((s) => ({ tool: s.tool, args: { ...(s.args || {}) } })),
            enabled: draft.enabled !== false,
            folder: draft.folder || null,
            hotkey: draft.hotkey || null,
            triggers: baseTr,
            origin: draft.origin || 'manual',
          };
          if (draft.id !== null) payload.id = draft.id;
          saveBtn.disabled = true;
          try {
            const r = await bridge.call('saveCommand', payload);
            if (!r || r.ok === false) {
              errBox.textContent = scrub((r && r.error) || 'Не удалось сохранить команду.');
              errBox.hidden = false;
              return;
            }
            const saved = normCmd(r.command || payload);
            selectedId = saved.id;
            draft = saved;
            store.toast(`Команда «${saved.name}» сохранена`, 'ok');
            await loadMyCommands();
            renderView();
          } catch (err) {
            errBox.textContent = bridge.errText(err);
            errBox.hidden = false;
          } finally {
            saveBtn.disabled = false;
          }
        });

        footer.append(saveBtn);

        if (draft.id !== null) {
          const isConf = deleteConfirmId === draft.id;
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = isConf ? 'ae-btn ae-btn-danger' : 'ae-btn ae-btn-ghost';
          delBtn.textContent = isConf ? 'Подтвердить удаление' : 'Удалить';
          delBtn.addEventListener('click', async () => {
            if (deleteConfirmId !== draft.id) {
              deleteConfirmId = draft.id;
              renderView();
              setTimeout(() => { if (deleteConfirmId === (draft && draft.id)) { deleteConfirmId = null; renderView(); } }, 3500);
              return;
            }
            deleteConfirmId = null;
            try {
              await bridge.call('deleteCommand', draft.id);
              store.toast('Команда удалена');
              selectedId = null;
              draft = null;
              await loadMyCommands();
              renderView();
            } catch (err) {
              store.toast(`Не удалось удалить: ${bridge.errText(err)}`, 'error');
            }
          });
          footer.append(delBtn);
        }

        form.append(topRow, nameField, phraseField, hotkeyField, stepsSec, errBox, footer);
        editCol.append(form);
      }

      layout.append(listCol, editCol);
      return layout;
    }

    function renderPacks() {
      const grid = document.createElement('div');
      grid.className = 'ae-cards-grid';
      if (!packsList.length) {
        const emp = document.createElement('div');
        emp.className = 'ae-empty-pane';
        emp.textContent = 'Список готовых паков пуст или недоступен.';
        return emp;
      }
      for (const p of packsList) {
        const card = document.createElement('div');
        card.className = 'ae-grid-card';
        const head = document.createElement('div');
        head.className = 'ae-grid-card-head';
        const title = document.createElement('strong');
        title.textContent = p.title;
        const badge = document.createElement('span');
        badge.className = 'ae-badge';
        badge.textContent = `${p.installed || 0} / ${p.total || 0}`;
        head.append(title, badge);

        const desc = document.createElement('p');
        desc.className = 'ae-grid-card-desc';
        desc.textContent = p.description || '';

        const btn = document.createElement('button');
        btn.type = 'button';
        const complete = p.total > 0 && p.installed >= p.total;
        btn.className = complete ? 'ae-btn ae-btn-ghost ae-btn-sm' : 'ae-btn ae-btn-primary ae-btn-sm';
        btn.disabled = complete;
        btn.textContent = complete ? 'Уже установлен' : (p.installed > 0 ? 'Доустановить недостающие' : 'Установить пак');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const r = await bridge.call('installPack', p.id);
            if (!r || r.ok === false) throw new Error((r && r.error) || 'ошибка');
            store.toast(`Пак «${p.title}»: установлено ${r.added || 0}`, 'ok');
            await Promise.all([loadPacks(), loadMyCommands()]);
            renderView();
          } catch (err) {
            store.toast(`Пак не установлен: ${bridge.errText(err)}`, 'error');
            btn.disabled = false;
          }
        });

        card.append(head, desc, btn);
        grid.append(card);
      }
      return grid;
    }

    function renderLibrary() {
      const grid = document.createElement('div');
      grid.className = 'ae-cards-grid';
      if (!libraryList.length) {
        const emp = document.createElement('div');
        emp.className = 'ae-empty-pane';
        emp.textContent = 'Встроенная библиотека шаблонов пуста.';
        return emp;
      }
      for (const item of libraryList) {
        const card = document.createElement('div');
        card.className = 'ae-grid-card';
        const title = document.createElement('strong');
        title.textContent = item.title || item.phrase || item.id;
        const desc = document.createElement('p');
        desc.className = 'ae-grid-card-desc';
        desc.textContent = item.phrase ? `Фраза: «${item.phrase}»` : (item.description || '');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
        btn.textContent = 'Выполнить сейчас';
        btn.addEventListener('click', async () => {
          if (!bridge.has('libraryRun')) return;
          btn.disabled = true;
          try {
            const r = await bridge.call('libraryRun', item.id);
            store.toast(r && r.ok !== false ? 'Команда выполнена' : scrub((r && r.error) || 'Не удалось'), r && r.ok !== false ? 'ok' : 'error');
          } catch (err) {
            store.toast(`Ошибка: ${bridge.errText(err)}`, 'error');
          } finally {
            btn.disabled = false;
          }
        });
        card.append(title, desc, btn);
        grid.append(card);
      }
      return grid;
    }

    function renderLaunches() {
      const wrap = document.createElement('div');
      wrap.className = 'ae-launches-wrap';
      if (!launchOverview) {
        const emp = document.createElement('div');
        emp.className = 'ae-empty-pane';
        emp.textContent = 'Обзор запусков недоступен.';
        wrap.append(emp);
        return wrap;
      }

      const log = Array.isArray(launchOverview.log) ? launchOverview.log : [];
      const topBar = document.createElement('div');
      topBar.className = 'ae-detail-head';
      const title = document.createElement('h2');
      title.textContent = `Журнал запусков (${log.length})`;
      const clrBtn = document.createElement('button');
      clrBtn.type = 'button';
      clrBtn.className = 'ae-btn ae-btn-ghost ae-btn-sm';
      clrBtn.textContent = 'Очистить журнал';
      clrBtn.disabled = !log.length;
      clrBtn.addEventListener('click', async () => {
        await bridge.call('clearCommandLaunchLog').catch(() => {});
        await loadLaunches();
        renderView();
      });
      topBar.append(title, clrBtn);

      const list = document.createElement('div');
      list.className = 'ae-card-list';
      if (!log.length) {
        const emp = document.createElement('div');
        emp.className = 'ae-empty-pane';
        emp.textContent = 'Автоматических запусков пока не было.';
        list.append(emp);
      } else {
        for (const entry of log.slice(0, 40)) {
          const row = document.createElement('div');
          row.className = 'ae-item-card';
          const info = document.createElement('div');
          info.className = 'ae-item-main';
          const nm = document.createElement('strong');
          nm.textContent = entry.commandName || entry.name || 'Команда';
          const meta = document.createElement('span');
          meta.className = 'ae-item-meta';
          meta.textContent = `${entry.trigger || 'ручной'} · ${entry.ok === false ? 'ошибка' : 'выполнено'}${entry.at ? ' · ' + ui.shortTime(entry.at) : ''}`;
          info.append(nm, meta);
          row.append(info);
          list.append(row);
        }
      }

      wrap.append(topBar, list);
      return wrap;
    }

    function renderView() {
      for (const [id, b] of tabBtns.entries()) {
        b.classList.toggle('is-active', id === activeTab);
        b.setAttribute('aria-pressed', String(id === activeTab));
      }
      renderRecordBar();
      recordBtn.classList.toggle('is-danger-active', recordingActive);
      recordBtn.lastElementChild.textContent = recordingActive ? 'Остановить запись' : 'Записать шаги';

      body.replaceChildren();
      if (activeTab === 'my') body.append(renderMyCommands());
      else if (activeTab === 'packs') body.append(renderPacks());
      else if (activeTab === 'library') body.append(renderLibrary());
      else if (activeTab === 'launches') body.append(renderLaunches());
    }

    function onEvent(ev) {
      if (!ev) return;
      if (ev.type === 'record:step') {
        recordedSteps.push({ tool: ev.tool, args: {} });
        if (!root.hidden) renderRecordBar();
      } else if (ev.type === 'commands:changed' && loaded && !root.hidden) {
        refreshCurrentTab();
      }
    }

    function render(st) {
      const show = st.route === 'commands';
      root.hidden = !show;
      if (show && !loaded) {
        loadAll();
      }
    }

    return { el: root, render, onEvent, refresh: loadAll };
  }

  window.NoxAetherCommandsView = { createCommandsView };
})();
