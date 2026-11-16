/* Поле ввода Nox Aether:
 * - авто-высота, отправка по Enter (Shift+Enter — новая строка), без двойной отправки;
 * - вложения файлов и «обвести область экрана»;
 * - кнопка микрофона и переключатель режима диктовки;
 * - выбор модели и глубины обдумывания (#pickTrigger / #pickPanel с теми же контрактами тестов). */
(() => {
  'use strict';

  const MODELS = [['fast', 'Быстрая'], ['smart', 'Умная']];
  const LEVELS = [['low', 'Кратко'], ['medium', 'Обычно'], ['high', 'Глубоко']];
  const SHORT = { low: 'думает кратко', medium: 'думает обычно', high: 'думает глубоко' };
  const COST = {
    low: 'Обычный расход лимита',
    medium: 'Лимит тратится в 1,5 раза быстрее',
    high: 'Лимит тратится в 2,5 раза быстрее',
  };
  const MODEL_HINT = {
    fast: 'Отвечает сразу. Подходит для команд и коротких вопросов.',
    smart: 'Сильнее в сложных поручениях и длинных текстах.',
  };
  const DICT_LABELS = { listening: 'Слушаю', quiet: 'Только имя', off: 'Микрофон выкл' };
  const fileSizeNumber = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) {
      bytes /= 1024;
      unit += 1;
    }
    return `${fileSizeNumber.format(bytes)} ${units[unit]}`;
  }

  function createComposer({ store, bridge, onSendTrigger, onTyping, onVoiceSettings }) {
    const { icon } = window.NoxAetherIcons;

    const wrap = document.createElement('div');
    wrap.className = 'ae-composer';
    wrap.id = 'aeComposer';

    // Полоса прикреплённых файлов
    const filesRow = document.createElement('div');
    filesRow.className = 'ae-files-row';
    filesRow.hidden = true;

    // Многострочный ввод
    const ta = document.createElement('textarea');
    ta.id = 'chatInput';
    ta.className = 'ae-textarea';
    ta.rows = 1;
    ta.placeholder = 'Напишите поручение или задайте вопрос…';
    ta.setAttribute('aria-label', 'Сообщение для Nox');

    function syncHeight() {
      ta.style.height = 'auto';
      const maxH = window.innerHeight < 580 ? 110 : 168;
      ta.style.height = `${Math.min(maxH, Math.max(24, ta.scrollHeight))}px`;
    }

    ta.addEventListener('input', () => {
      syncHeight();
      store.setDraftText(ta.value);
      updateSendBtn(store.state);
      if (typeof onTyping === 'function') onTyping(ta.value, ta.selectionStart || 0);
    });

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        triggerSend();
      }
    });

    // Нижняя строка инструментов композера
    const footer = document.createElement('div');
    footer.className = 'ae-composer-footer';

    const leftTools = document.createElement('div');
    leftTools.className = 'ae-composer-tools';

    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.id = 'attachBtn';
    attachBtn.className = 'ae-tool-btn';
    attachBtn.title = 'Прикрепить файл';
    attachBtn.setAttribute('aria-label', 'Прикрепить файл');
    attachBtn.append(icon('paperclip'));
    attachBtn.addEventListener('click', async () => {
      if (!bridge.has('pickFiles')) return;
      try {
        const picked = await bridge.call('pickFiles');
        if (Array.isArray(picked) && picked.length) store.addDraftFiles(picked);
      } catch (err) {
        store.toast(`Не удалось выбрать файлы: ${bridge.errText(err)}`, 'error');
      }
    });

    const regionBtn = document.createElement('button');
    regionBtn.type = 'button';
    regionBtn.id = 'regionBtn';
    regionBtn.className = 'ae-tool-btn';
    regionBtn.title = 'Обвести область экрана';
    regionBtn.setAttribute('aria-label', 'Обвести область экрана');
    regionBtn.append(icon('target'));
    regionBtn.hidden = true;
    regionBtn.addEventListener('click', async () => {
      if (!bridge.has('pickRegion')) return;
      try {
        const res = await bridge.call('pickRegion');
        if (!res || res.cancelled) return;
        if (!res.ok) {
          store.toast(`Область не выбрана: ${res.error || 'ошибка'}`, 'error');
          return;
        }
        await store.sendChatMessage(`Объясни, что я обвёл на экране (${res.label}): что это и как решить?`, []);
      } catch (err) {
        store.toast(`Область не выбрана: ${bridge.errText(err)}`, 'error');
      }
    });

    const micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.id = 'dictationBtn';
    micBtn.className = 'ae-tool-btn ae-mic-btn';
    const micLabel = document.createElement('span');
    micLabel.className = 'ae-mic-label';
    micBtn.append(icon('mic'), micLabel);
    micBtn.addEventListener('click', () => {
      if (store.state.settings.dictation !== true) onVoiceSettings();
      else store.toggleDictation();
    });

    const dictModeBtn = document.createElement('button');
    dictModeBtn.type = 'button';
    dictModeBtn.id = 'dictationStateBtn';
    dictModeBtn.className = 'ae-dict-chip';
    dictModeBtn.hidden = true;
    dictModeBtn.addEventListener('click', () => store.cycleDictationMode());

    const agentBtn = document.createElement('button');
    agentBtn.type = 'button';
    agentBtn.id = 'agentModeBtn';
    agentBtn.className = 'ae-agent-toggle';
    agentBtn.setAttribute('aria-pressed', 'false');
    agentBtn.title = 'Режим агента: пошаговые действия на экране и в системе';
    const agentLabel = document.createElement('span');
    agentLabel.textContent = 'Агент';
    agentBtn.append(icon('sparkles'), agentLabel);
    agentBtn.addEventListener('click', () => {
      if (typeof store.toggleAgentMode === 'function') store.toggleAgentMode();
    });

    // Выбор модели и обдумывания (#pickTrigger / #pickPanel — контракт model-pick-layout.test.js)
    const pickWrap = document.createElement('div');
    pickWrap.className = 'ae-pick-wrap';

    const pickTrigger = document.createElement('button');
    pickTrigger.type = 'button';
    pickTrigger.id = 'pickTrigger';
    pickTrigger.className = 'pick-trigger ae-pick-trigger';
    pickTrigger.setAttribute('aria-haspopup', 'dialog');
    pickTrigger.setAttribute('aria-expanded', 'false');
    pickTrigger.setAttribute('aria-controls', 'pickPanel');
    const trigText = document.createElement('span');
    trigText.className = 'pick-trigger-text';
    pickTrigger.append(trigText, icon('chevronDown', 'ae-chev-sm'));

    const pickPanel = document.createElement('div');
    pickPanel.id = 'pickPanel';
    pickPanel.className = 'pick-panel ae-pick-panel';
    pickPanel.hidden = true;
    pickPanel.setAttribute('role', 'dialog');
    pickPanel.setAttribute('aria-label', 'Модель и обдумывание');

    function makeSegGroup(name, label, options, onChange) {
      const box = document.createElement('fieldset');
      box.className = 'pick';
      const legend = document.createElement('legend');
      legend.className = 'pick-name';
      legend.textContent = label;
      const seg = document.createElement('div');
      seg.className = 'seg';
      const inputs = {};
      for (const [value, text] of options) {
        const opt = document.createElement('label');
        opt.className = 'seg-opt';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = name;
        input.value = value;
        input.addEventListener('change', () => {
          if (input.checked) onChange(value);
        });
        const sp = document.createElement('span');
        sp.textContent = text;
        opt.append(input, sp);
        seg.append(opt);
        inputs[value] = input;
      }
      box.append(legend, seg);
      return { box, inputs };
    }

    const modelNote = document.createElement('p');
    modelNote.className = 'pick-note';
    const costNote = document.createElement('p');
    costNote.className = 'pick-note';

    const modelGroup = makeSegGroup('pick-model', 'Модель', MODELS, (v) => store.setTier(v));
    const levelGroup = makeSegGroup('pick-level', 'Обдумывание', LEVELS, (v) => store.setThinking(v));
    pickPanel.append(modelGroup.box, modelNote, levelGroup.box, costNote);

    function positionPanelInsideChat() {
      pickPanel.style.left = '';
      pickPanel.style.right = '';
      const chatHost = wrap.closest('#noxChat') || document.body;
      const hr = chatHost.getBoundingClientRect();
      const pr = pickPanel.getBoundingClientRect();
      const vw = window.innerWidth;
      const pad = 10;
      const maxRight = Math.min(hr.right, vw) - pad;
      const minLeft = Math.max(hr.left, 0) + pad;
      let shift = 0;
      if (pr.right > maxRight) shift = maxRight - pr.right;
      else if (pr.left < minLeft) shift = minLeft - pr.left;
      if (Math.abs(shift) > 0.5) {
        pickPanel.style.transform = `translateX(${Math.round(shift)}px)`;
      } else {
        pickPanel.style.transform = '';
      }
    }

    function setPanelOpen(on) {
      pickPanel.hidden = !on;
      pickTrigger.setAttribute('aria-expanded', String(on));
      if (on) {
        pickPanel.style.transform = '';
        requestAnimationFrame(() => positionPanelInsideChat());
        const checked = pickPanel.querySelector('input:checked') || pickPanel.querySelector('input');
        if (checked) checked.focus();
      }
    }

    pickTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      setPanelOpen(pickPanel.hidden);
    });

    pickPanel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setPanelOpen(false);
        pickTrigger.focus();
      }
    });

    document.addEventListener('click', (e) => {
      if (!pickPanel.hidden && !pickWrap.contains(e.target)) setPanelOpen(false);
    });

    pickWrap.append(pickTrigger, pickPanel);
    leftTools.append(attachBtn, regionBtn, micBtn, dictModeBtn, agentBtn, pickWrap);

    const rightTools = document.createElement('div');
    rightTools.className = 'ae-composer-send-wrap';

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.id = 'sendBtn';
    sendBtn.className = 'ae-send-btn';
    sendBtn.addEventListener('click', () => {
      const st = store.state;
      if (st.trackerBusy) {
        store.stopRun();
      } else {
        triggerSend();
      }
    });

    rightTools.append(sendBtn);
    footer.append(leftTools, rightTools);
    wrap.append(filesRow, ta, footer);

    async function triggerSend(rawToSend = ta.value, files = store.state.currentDraftFiles) {
      const st = store.state;
      if (st.sendingLock || st.trackerBusy) return;
      const text = rawToSend.trim();
      if (!text && !files.length) return;
      if (typeof onSendTrigger === 'function') onSendTrigger();
      ta.value = '';
      syncHeight();
      await store.sendChatMessage(rawToSend, files);
    }

    function updateSendBtn(st) {
      const busy = Boolean(st.trackerBusy);
      const locked = Boolean(st.sendingLock);
      const canSend = Boolean(ta.value.trim() || st.currentDraftFiles.length > 0);
      sendBtn.replaceChildren();
      if (busy) {
        sendBtn.classList.add('is-stop');
        sendBtn.disabled = false;
        sendBtn.title = 'Остановить (Esc)';
        sendBtn.setAttribute('aria-label', 'Остановить выполнение');
        sendBtn.append(icon('stop'));
      } else {
        sendBtn.classList.remove('is-stop');
        sendBtn.disabled = locked || !canSend;
        sendBtn.title = 'Отправить (Enter)';
        sendBtn.setAttribute('aria-label', 'Отправить сообщение');
        sendBtn.append(icon('send'));
      }
    }

    function renderFiles(files) {
      if (!files.length) {
        filesRow.hidden = true;
        filesRow.replaceChildren();
        return;
      }
      filesRow.hidden = false;
      filesRow.replaceChildren();
      for (const f of files) {
        const chip = document.createElement('span');
        chip.className = 'ae-file-chip';
        const nm = document.createElement('span');
        nm.className = 'ae-file-name';
        const size = formatFileSize(f.size);
        nm.textContent = size ? `${f.name} · ${size}` : f.name;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ae-file-rm';
        rm.setAttribute('aria-label', `Убрать файл ${f.name}`);
        rm.append(icon('x'));
        rm.addEventListener('click', () => store.removeDraftFile(f.path));
        chip.append(nm, rm);
        filesRow.append(chip);
      }
    }

    let prevDraftRef = '';
    let prevChatId = null;
    let prevSendingLock = false;
    function render(st) {
      const chatChanged = st.activeChatId !== prevChatId;
      const sendStarted = Boolean(st.sendingLock && !prevSendingLock);
      prevChatId = st.activeChatId;
      prevSendingLock = Boolean(st.sendingLock);

      if (chatChanged || sendStarted || (ta.value !== st.currentDraftText && (st.currentDraftText !== prevDraftRef || document.activeElement !== ta))) {
        ta.value = st.currentDraftText || '';
        syncHeight();
      } else if (st.currentDraftText === '' && ta.value !== '' && prevDraftRef !== '') {
        ta.value = '';
        syncHeight();
      }
      prevDraftRef = st.currentDraftText || '';

      renderFiles(st.currentDraftFiles || []);
      regionBtn.hidden = !bridge.has('pickRegion');

      const dictAvailable = bridge.has('dictationStart');
      const dictEnabled = st.settings.dictation === true && dictAvailable;
      const dictError = dictEnabled ? st.dictation.error : '';
      const recording = dictEnabled && st.dictation.recording && !dictError;
      const namedMode = recording && (st.dictation.mode === 'quiet' || !st.dictation.full);
      micBtn.hidden = !dictAvailable || (!dictEnabled && !store.isEmptyChat());
      micBtn.classList.toggle('is-recording', Boolean(recording));
      micBtn.classList.toggle('has-error', Boolean(dictError));
      micLabel.textContent = !dictEnabled ? 'Настроить голос' : dictError ? 'Повторить' : recording ? 'Остановить' : 'Говорить';
      micBtn.title = dictError || (recording ? 'Остановить голосовой ввод' : micLabel.textContent);
      micBtn.setAttribute('aria-label', dictError ? `${dictError}. Повторить голосовой ввод` : micBtn.title);
      if (dictEnabled) micBtn.setAttribute('aria-pressed', String(Boolean(recording)));
      else micBtn.removeAttribute('aria-pressed');

      dictModeBtn.hidden = !dictEnabled;
      if (dictEnabled) {
        const dMode = !recording ? 'off' : namedMode ? 'quiet' : 'listening';
        dictModeBtn.textContent = dictError ? 'Микрофон не готов' : DICT_LABELS[dMode];
        dictModeBtn.dataset.dmode = dMode;
        dictModeBtn.title = dictError || 'Переключить режим микрофона (Ctrl+Alt+M)';
      }

      const agentActive = Boolean(st.agentMode);
      agentBtn.setAttribute('aria-pressed', String(agentActive));
      agentBtn.classList.toggle('is-active', agentActive);
      agentBtn.title = agentActive
        ? 'Режим агента включён — нажмите, чтобы переключить в обычный чат'
        : 'Режим агента: пошаговые действия на экране и в системе';

      if (recording) {
        ta.placeholder = namedMode
          ? 'Слушаю имя «Джарвис» перед командой…'
          : 'Говорите — речь попадёт сюда…';
      } else if (agentActive) {
        ta.placeholder = 'Опишите действие на экране или в системе — агент выполнит по шагам…';
      } else {
        ta.placeholder = 'Напишите поручение или задайте вопрос…';
      }

      const tier = st.tier || 'fast';
      const thinking = st.thinking || 'low';
      if (modelGroup.inputs[tier]) modelGroup.inputs[tier].checked = true;
      if (levelGroup.inputs[thinking]) levelGroup.inputs[thinking].checked = true;

      const tLabel = MODELS.find(([k]) => k === tier)?.[1] || 'Быстрая';
      const lShort = SHORT[thinking] || SHORT.low;
      trigText.textContent = `${tLabel} · ${lShort}`;
      pickTrigger.setAttribute('aria-label', `Модель: ${tLabel}, ${lShort}. Изменить`);
      modelNote.textContent = MODEL_HINT[tier] || MODEL_HINT.fast;
      costNote.textContent = `${COST[thinking] || COST.low}.`;

      updateSendBtn(st);
    }

    return {
      el: wrap,
      focus: () => ta.focus(),
      insertStarter: (txt) => {
        if (ta.value.trim() || store.state.currentDraftFiles.length) return;
        ta.value = txt;
        syncHeight();
        store.setDraftText(txt);
        updateSendBtn(store.state);
        ta.focus();
        ta.setSelectionRange(txt.length, txt.length);
        if (typeof onTyping === 'function') onTyping(txt, txt.length);
      },
      sendChoice: (txt) => {
        if (ta.value.trim() || store.state.currentDraftFiles.length) {
          store.toast('Чтобы выбрать вариант, отправьте или очистите черновик.');
          ta.focus();
          return;
        }
        ta.focus();
        return triggerSend(txt, []);
      },
      render,
    };
  }

  window.NoxAetherComposer = { createComposer, formatFileSize };
})();
