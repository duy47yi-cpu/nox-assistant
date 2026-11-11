/* Nox — первый экран: история чатов, сфера, оболочка окна.
 * Тонкий слой поверх прежнего приложения: беседа и поле ввода переезжают сюда
 * из классического экрана (их логика остаётся в app.js), данные — из того же моста.
 * Вариант сферы переключается только для разработки: window.NoxScreen.setVariant,
 * localStorage 'noxOrb' или #orb=wire; в обычном интерфейсе переключателя нет. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  const api = () => window.jarvis || null;
  const app = () => window.JarvisNox || null;

  const S = {
    variant: 'nox',
    orb: null,
    orbState: 'idle',
    composerFocus: false,
    working: null,
    workingStart: 0,
    workingTimer: 0,
    workingTone: 'running',
    chatCount: 1,
    historySeq: 0,
  };

  let refs = null;

  // ── Разметка панелей ───────────────────────────────────────────
  function cacheRefs() {
    refs = {
      body: document.body,
      grid: $('.nox-grid'),
      history: $('#noxHistory'),
      histSections: $('#noxHistSections'),
      histEmpty: $('#noxHistEmpty'),
      wsSlot: $('#noxWsSlot'),
      chat: $('#noxChat'),
      chatMount: $('#noxChatMount'),
      composerSlot: $('#noxComposerSlot'),
      sphere: $('#noxSphere'),
      orbStage: $('#noxOrbStage'),
      orbCanvas: $('#noxOrb'),
      convo: $('.view-dialog .convo'),
      dock: $('.view-dialog .stage-dock'),
      dialog: $('.view-dialog'),
      stage: $('#stage'),
      feed: $('#feed'),
      feedList: $('#feedList'),
      chatInput: $('#chatInput'),
      composer: $('#composer'),
      chatTabsList: $('#chatTabsList'),
      workspaceSwitch: $('#workspaceSwitch'),
      headerState: $('#headerState'),
    };
  }

  // ── Шапка истории и список чатов ───────────────────────────────
  function chatRows(data) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();
    const groups = { today: [], earlier: [] };
    for (const chat of data.chats) {
      const at = Number(chat.updatedAt) || 0;
      (at >= todayStart ? groups.today : groups.earlier).push(chat);
    }
    const frag = document.createDocumentFragment();
    const addGroup = (title, chats) => {
      if (!chats.length) return;
      frag.append(el('div', 'nox-hist-label', title));
      for (const chat of chats) frag.append(chatRow(chat, chat.id === data.activeId));
    };
    addGroup('Сегодня', groups.today);
    addGroup('Ранее', groups.earlier);
    return frag;
  }

  function chatRow(chat, active) {
    const row = el('div', 'nox-hist-item');
    row.dataset.chatId = chat.id;
    if (active) row.dataset.active = 'true';
    const open = el('button', 'nox-hist-open');
    open.type = 'button';
    open.textContent = chat.title || 'Новый чат';
    open.title = chat.title || 'Новый чат';
    if (active) open.setAttribute('aria-current', 'true');
    open.addEventListener('click', () => selectChat(chat.id, row));
    const more = el('button', 'nox-hist-more', '…');
    more.type = 'button';
    more.title = 'Закрыть чат';
    more.setAttribute('aria-label', `Закрыть чат «${chat.title || 'Новый чат'}»`);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      closeChat(chat);
    });
    row.append(open, more);
    return row;
  }

  async function refreshHistory() {
    const bridge = api();
    if (!bridge || typeof bridge.chatList !== 'function') return;
    const seq = ++S.historySeq;
    let data = null;
    try { data = await bridge.chatList(); } catch { return; }
    if (seq !== S.historySeq || !data || !Array.isArray(data.chats)) return;
    S.chatCount = data.chats.length;
    refs.histSections.replaceChildren(chatRows(data));
    refs.histEmpty.hidden = data.chats.length > 0;
    syncEmpty();
  }

  function selectChat(id, row) {
    if (row && row.dataset.active === 'true') return;
    const nav = app();
    if (nav && typeof nav.changeChat === 'function') {
      nav.changeChat('chatSelect', id);
      return;
    }
    // Запасной путь для старой сборки: нажать ту же вкладку чата.
    const index = [...(refs.histSections?.querySelectorAll('.nox-hist-item') || [])].indexOf(row);
    const tabs = $$('#chatTabsList .chat-tab-name');
    if (tabs[index]) tabs[index].click();
  }

  function closeChat(chat) {
    const nav = app();
    if (nav && typeof nav.closeChat === 'function') { nav.closeChat(chat); return; }
    const tabs = $$('#chatTabsList .chat-tab');
    const row = refs.histSections?.querySelector(`.nox-hist-item[data-chat-id="${chat.id}"]`);
    const index = row ? [...refs.histSections.querySelectorAll('.nox-hist-item')].indexOf(row) : -1;
    const x = index >= 0 ? tabs[index]?.querySelector('.chat-tab-x') : null;
    if (x) x.click();
  }

  function newChat() {
    const nav = app();
    if (nav && typeof nav.changeChat === 'function') { nav.changeChat('chatNew'); return; }
    $('#chatNew')?.click();
  }

  // ── Пустое состояние: история скрыта, в шапке чата знак NOX ─────
  function syncEmpty() {
    if (!refs || !refs.grid) return;
    const empty = refs.feedList.childElementCount === 0 && S.chatCount <= 1;
    refs.grid.classList.toggle('is-empty', empty);
  }

  // Открытие экрана показывает конец разговора, как обычный мессенджер.
  function scrollToBottom() {
    const run = () => {
      const feed = refs && refs.feed;
      if (!feed) return;
      feed.scrollTop = feed.scrollHeight;
    };
    requestAnimationFrame(run);
    setTimeout(run, 60);
  }

  // ── Кнопка «Скопировать ответ» под ответом ассистента ─────────
  // Настоящее копирование текста конкретного ответа в буфер обмена (без фейковой иконки).
  const COPY_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M5.5 15V6.5a2 2 0 0 1 2-2H15"/></svg>';
  const CHECK_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function legacyCopy(value) {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }

  // Возвращает promise<boolean>: скопировалось или нет (это проверяется в тесте).
  function copyText(text) {
    const value = String(text || '');
    if (!value) return Promise.resolve(false);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(value).then(() => true).catch(() => legacyCopy(value));
    }
    return Promise.resolve(legacyCopy(value));
  }

  function answerText(turn) {
    const md = turn.querySelector('.md');
    if (!md) return '';
    const raw = (md.innerText || md.textContent || '').replace(/\u00a0/g, ' ');
    return raw.replace(/\n{3,}/g, '\n\n').trim();
  }

  function flashCopy(btn, ok) {
    btn.dataset.copied = ok ? 'true' : 'false';
    const label = ok ? 'Скопировано' : 'Не удалось скопировать';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = ok ? CHECK_GLYPH : COPY_GLYPH;
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      delete btn.dataset.copied;
      btn.setAttribute('aria-label', 'Скопировать ответ');
      btn.title = 'Скопировать ответ';
      btn.innerHTML = COPY_GLYPH;
    }, 1400);
  }

  function ensureCopyButtons() {
    if (!refs || !refs.feedList) return;
    // Кнопка добавляет ~28 px под ответ. Если лента была прижата к низу (или это первая
    // отрисовка истории), после добавления ленту надо снова прижать, иначе ответ уезжает
    // вверх и автопрокрутка «Готово» врёт. Если пользователь читает выше — не трогаем.
    const feed = refs.feed;
    const pinned = feed ? feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48 : false;
    let added = 0;
    for (const turn of refs.feedList.querySelectorAll('.turn')) {
      const md = turn.querySelector('.md');
      if (!md) continue;
      let btn = turn.querySelector(':scope > .nox-copy');
      if (!btn) {
        btn = el('button', 'nox-copy');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Скопировать ответ');
        btn.title = 'Скопировать ответ';
        btn.innerHTML = COPY_GLYPH;
        md.after(btn);
        btn.addEventListener('click', () => {
          copyText(answerText(turn)).then((ok) => flashCopy(btn, ok));
        });
        added += 1;
      }
    }
    if (added && pinned && feed) feed.scrollTop = feed.scrollHeight;
  }

  // ── Строка «Ход работы» с настоящим секундомером ───────────────
  function workingRow() {
    const row = el('div', 'nox-working');
    row.setAttribute('role', 'status');
    row.append(el('span', 'nox-tri', '▸'), el('span', 'nox-working-text', 'Ход работы · Выполняется'));
    return row;
  }

  function ensureWorking() {
    if (S.working && S.working.isConnected) return;
    if (!refs || !refs.feedList) return;
    const row = workingRow();
    const turns = refs.feedList.querySelectorAll('.turn');
    const last = turns.length ? turns[turns.length - 1] : null;
    if (last) refs.feedList.insertBefore(row, last); else refs.feedList.append(row);
    S.working = row;
    S.workingStart = performance.now();
    S.workingTone = 'running';
    row.dataset.tone = 'running';
    clearInterval(S.workingTimer);
    S.workingTimer = setInterval(tickWorking, 100);
    tickWorking();
  }

  function tickWorking() {
    if (!S.working || !S.working.isConnected) return;
    const ms = performance.now() - S.workingStart;
    const text = S.working.querySelector('.nox-working-text');
    if (text) text.textContent = `Ход работы · Выполняется · ${(ms / 1000).toFixed(1)} с`;
  }

  function finishWorking(label, tone) {
    if (!S.working || !S.working.isConnected) { S.working = null; clearInterval(S.workingTimer); return; }
    const ms = S.workingStart ? performance.now() - S.workingStart : 0;
    clearInterval(S.workingTimer);
    const text = S.working.querySelector('.nox-working-text');
    if (text) text.textContent = `Ход работы · ${label} · ${(ms / 1000).toFixed(1)} с`;
    S.working.dataset.tone = tone || 'done';
    S.working = null;
  }

  // ── Сфера: вариант, состояние, внимание поля ввода ─────────────
  const STAGE_TO_ORB = {
    idle: 'idle', listening: 'listening',
    thinking: 'thinking', planning: 'thinking', acting: 'thinking', searching: 'thinking', verifying: 'thinking',
    speaking: 'speaking', waiting_approval: 'waiting_approval',
    error: 'error', stopped: 'error', success: 'success', cancelled: 'idle',
  };

  function motionOn() {
    return document.documentElement.dataset.motion !== 'off';
  }

  function initOrb() {
    const canvas = refs.orbCanvas;
    if (!canvas) return;
    if (typeof window.NoxOrb !== 'function') {
      console.warn('[nox] orb-nox.js не загружен: сфера останется пустой');
      return;
    }
    try {
      window.NoxOrb.ignoreSystemMotion = true; // у шара свой переключатель, как у прежнего
      // 0.86 от «полного» радиуса модуля: диаметр сферы ≈ 23 % ширины окна, как в референсе.
      S.orb = new window.NoxOrb(canvas, { variant: S.variant, state: 'idle', animated: motionOn(), scale: 0.86 });
    } catch (err) {
      console.error('[nox] сфера не запустилась:', err);
      return;
    }
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => { try { S.orb.resize(); } catch { /* размер ещё не нужен */ } });
      ro.observe(refs.orbStage);
    }
    applyStageState();
    window.addEventListener('jarvis:orbtune', () => { if (S.orb) S.orb.setAnimated(motionOn()); });
  }

  function applyStageState() {
    if (!S.orb || !refs.stage) return;
    const raw = refs.stage.dataset.state || 'idle';
    const mapped = S.composerFocus && raw === 'idle' ? 'attentive' : (STAGE_TO_ORB[raw] || 'idle');
    S.orbState = mapped;
    try { S.orb.setState(mapped); } catch { /* старый модуль без состояния */ }
  }

  function setVariant(variant, save = true) {
    const value = variant === 'wire' ? 'wire' : 'nox';
    S.variant = value;
    if (save) { try { localStorage.setItem('noxOrb', value); } catch { /* приватный режим */ } }
    if (S.orb) { try { S.orb.setVariant(value); } catch (err) { console.warn('[nox] вариант сферы:', err); } }
    document.dispatchEvent(new CustomEvent('nox:variant', { detail: value }));
    return value;
  }

  function readVariant() {
    const fromHash = /(?:^|[#&])orb=(wire|nox)\b/.exec(location.hash || '');
    if (fromHash) return fromHash[1];
    try {
      const saved = localStorage.getItem('noxOrb');
      if (saved === 'wire' || saved === 'nox') return saved;
    } catch { /* хранилище недоступно */ }
    return 'nox'; // продакшн-вариант — точечная сфера с ядром
  }

  // ── Кнопки окна классического экрана (у разделов Nox — общая шапка, nox-shell.js) ──
  function windowControl(action) {
    const bridge = api();
    if (!bridge || typeof bridge.windowControl !== 'function') return;
    bridge.windowControl(action).catch(() => {});
  }

  // ── Перенос беседы и поля ввода между экранами ─────────────────
  function onView(view) {
    if (!refs) return;
    if (view === 'nox') {
      if (refs.convo.parentElement !== refs.chatMount) refs.chatMount.append(refs.convo);
      if (refs.dock.parentElement !== refs.composerSlot) refs.composerSlot.append(refs.dock);
      const picks = $('#composer .composer-picks');
      const row = $('#composer .composer-row');
      if (picks && row && picks.parentElement !== row) row.append(picks);
      if (refs.workspaceSwitch && refs.wsSlot && refs.workspaceSwitch.parentElement !== refs.wsSlot) {
        refs.wsSlot.append(refs.workspaceSwitch);
      }
      if (S.orb) S.orb.setAnimated(motionOn());
      syncEmpty();
      placePicks();
      ensureMic();
      ensureCopyButtons();
      refreshHistory();
      scrollToBottom();
      requestAnimationFrame(() => { try { S.orb?.resize(); } catch { /* нет сферы */ } });
    } else if (view === 'dialog') {
      if (refs.convo.parentElement !== refs.dialog) {
        const desk = $('#deskPage', refs.dialog);
        if (desk) desk.before(refs.convo); else refs.dialog.append(refs.convo);
      }
      // app.js при запуске переносит поле ввода в беседу; возвращаем туда же, не в сцену.
      if (refs.dock.parentElement !== refs.convo) refs.convo.append(refs.dock);
      const picks = $('#composer .composer-picks');
      const composer = $('#composer');
      if (picks && composer && picks.parentElement !== composer) composer.append(picks);
      if (refs.workspaceSwitch && refs.convo) {
        const tabs = $('#chatTabs', refs.convo);
        if (refs.workspaceSwitch.parentElement !== refs.convo) {
          if (tabs) refs.convo.insertBefore(refs.workspaceSwitch, tabs); else refs.convo.prepend(refs.workspaceSwitch);
        }
      }
      if (S.orb) S.orb.setAnimated(false);
    }
  }

  function ensurePlacement() {
    const view = refs.body.dataset.view || 'nox';
    if (view === 'nox') onView('nox');
  }

  // Выбор модели монтируется отдельным модулем позже — переносим его в строку инструментов.
  function placePicks() {
    if ((refs.body.dataset.view || 'nox') !== 'nox') return;
    const picks = $('#composer .composer-picks');
    const row = $('#composer .composer-row');
    if (picks && row && picks.parentElement !== row) row.append(picks);
  }

  // Микрофон в референсе всегда в строке инструментов. Он честно работает:
  // без включённой диктовки нажатие объясняет, что включить в настройках.
  function ensureMic() {
    if ((refs.body.dataset.view || 'nox') !== 'nox') return;
    const mic = $('#dictationBtn');
    if (mic && mic.hidden) mic.hidden = false;
  }

  // ── Осциллограмма: настоящая диктовка, не украшение ────────────
  function initWave() {
    const form = refs.composer;
    if (!form || form.querySelector('.nox-wave')) return;
    const wave = el('div', 'nox-wave');
    wave.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 28; i += 1) wave.append(el('i'));
    form.insertBefore(wave, form.firstChild);
    const mic = $('#dictationBtn');
    const sync = () => { wave.dataset.recording = mic && mic.dataset.recording === 'true' ? 'true' : 'false'; };
    sync();
    if (mic) new MutationObserver(sync).observe(mic, { attributes: true, attributeFilter: ['data-recording', 'hidden'] });
  }

  // ── Связывание кнопок и наблюдений ─────────────────────────────
  function initControls() {
    $('#noxNewChat')?.addEventListener('click', newChat);
    for (const btn of $$('.win-controls [data-act]')) {
      btn.addEventListener('click', () => windowControl(btn.dataset.act));
    }
    $('#openClassic')?.addEventListener('click', () => {
      const nav = app();
      if (nav && typeof nav.show === 'function') nav.show('dialog');
    });
    // Запасной жест разработчика: Ctrl+Alt+O меняет вариант сферы (в интерфейсе кнопки нет).
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'o' || e.key === 'O' || e.key === 'щ' || e.key === 'Щ')) {
        e.preventDefault();
        setVariant(S.variant === 'wire' ? 'nox' : 'wire');
      }
    });
  }

  function initObservers() {
    // Состояние ядра: шар и строка хода.
    if (refs.stage) {
      new MutationObserver(applyStageState).observe(refs.stage, { attributes: true, attributeFilter: ['data-state'] });
    }
    if (refs.headerState) {
      const BUSY = new Set(['thinking', 'planning', 'acting', 'searching', 'verifying', 'speaking', 'waiting_approval']);
      new MutationObserver(() => {
        const state = refs.headerState.dataset.state || 'idle';
        if (BUSY.has(state) && !S.working) ensureWorking();
      }).observe(refs.headerState, { attributes: true, attributeFilter: ['data-state'] });
    }
    if (refs.feedList) {
      let copyScheduled = false;
      new MutationObserver(() => {
        syncEmpty();
        if (S.working && !S.working.isConnected) { S.working = null; clearInterval(S.workingTimer); }
        // Кнопка копирования: под каждым готовым ответом, один раз на ход.
        if (!copyScheduled) {
          copyScheduled = true;
          requestAnimationFrame(() => { copyScheduled = false; ensureCopyButtons(); });
        }
        if (!S.working) return;
        // Новый ход: строка должна стоять перед ответом текущего хода.
        const turns = refs.feedList.querySelectorAll('.turn');
        const last = turns.length ? turns[turns.length - 1] : null;
        if (last && last.previousElementSibling !== S.working) refs.feedList.insertBefore(S.working, last);
      }).observe(refs.feedList, { childList: true, subtree: true });
    }
    if (refs.chatTabsList) {
      let timer = 0;
      new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => refreshHistory(), 40);
      }).observe(refs.chatTabsList, { childList: true });
    }
    // Модуль выбора модели и видимость микрофона приходят позже — подхватываем.
    if (refs.composer) new MutationObserver(placePicks).observe(refs.composer, { childList: true });
    const mic = $('#dictationBtn');
    if (mic) new MutationObserver(ensureMic).observe(mic, { attributes: true, attributeFilter: ['hidden'] });
    // Внимание сферы к полю ввода.
    if (refs.chatInput) {
      refs.chatInput.addEventListener('focus', () => { S.composerFocus = true; applyStageState(); });
      refs.chatInput.addEventListener('blur', () => { S.composerFocus = false; applyStageState(); });
      refs.chatInput.addEventListener('input', () => { try { S.orb?.pulse(0.08); } catch { /* модуль без pulse */ } });
    }
    document.addEventListener('jarvis:view', (e) => onView(e.detail));
    document.addEventListener('visibilitychange', () => {
      if (!S.orb) return;
      if (document.hidden) S.orb.setAnimated(false);
      else if ((refs.body.dataset.view || 'nox') === 'nox') S.orb.setAnimated(motionOn());
    });
  }

  function initEvents() {
    const bridge = api();
    if (!bridge || typeof bridge.onEvent !== 'function') return;
    bridge.onEvent((ev) => {
      if (!ev || typeof ev !== 'object') return;
      // Поздний итог действия после остановки: ход уже закрыт, «работаю» заново не показываем.
      if (ev.afterStop === true) return;
      switch (ev.type) {
        case 'text':
        case 'tool_start':
        case 'tool_result':
        case 'notice':
        case 'approval_request':
          ensureWorking();
          break;
        case 'error':
          finishWorking('Не получилось', 'error');
          break;
        case 'done':
          finishWorking(ev.cancelled === true || ev.status === 'cancelled' ? 'Остановлено' : 'Готово', 'done');
          break;
        default:
          break;
      }
    });
  }

  // ── Геометрия для сверки со скриншотом (только разработка) ─────
  function geometry() {
    const box = (sel) => {
      const node = $(sel);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      window: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      rail: box('.rail'), history: box('#noxHistory'), chat: box('#noxChat'),
      sphere: box('#noxSphere'), orb: box('#noxOrb'),
      variant: S.variant,
    };
  }

  function init() {
    cacheRefs();
    if (!refs.grid) return; // экрана нет в этой сборке
    S.variant = readVariant();
    ensurePlacement();
    initOrb();
    initWave();
    initControls();
    initObservers();
    initEvents();
    placePicks();
    ensureMic();
    ensureCopyButtons();
    refreshHistory();
  }

  // Публичный мост для сверки: переключение варианта, раздел, геометрия.
  window.NoxScreen = {
    onView,
    setVariant,
    getVariant: () => S.variant,
    refreshHistory,
    geometry,
    setState: (state) => { try { S.orb?.setState(state); } catch { /* нет сферы */ } },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

