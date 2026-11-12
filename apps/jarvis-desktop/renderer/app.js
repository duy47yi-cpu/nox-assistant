/* Джарвис — главное окно.
 *
 * Разделы: Диалог (лента, карточки поручений, лоток «Ждут вас», поле ввода), Команды (Мои и
 * Библиотека, редактор), Настройки (режим, ответы, окно, вид, папка, модель и связь, разговор, журнал).
 * В шапке — шар 32 px и строка состояния, чип режима, «Стоп»; под шапкой один баннер по приоритету.
 * Работает через window.jarvis (preload.js). Любой метод может отсутствовать:
 * тогда соответствующий блок показывает понятное пустое состояние.
 * Весь пользовательский и модельный текст вставляется только через textContent. */
(() => {
  'use strict';

  const U = window.JarvisUI;
  const { el, icon, call, has, errText } = U;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  // replaceChildren без пустых значений: null иначе превращается в текст «null».
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false && k !== ''));

  const VIEWS = { nox: 'Чат', dialog: 'Классический экран', deals: 'Дела', journal: 'Журнал', commands: 'Команды', mcp: 'Подключения', account: 'Аккаунт', settings: 'Настройки' };
  const VIEW_KEYS = ['nox', 'commands', 'journal', 'mcp', 'settings'];
  const MODE_NAMES = { full: 'Полный доступ', ask: 'Спрашивать', auto: 'Авто-умный' };
  const MODE_SHORT = { full: 'Полный', ask: 'Спрашивать', auto: 'Авто' };
  const THEMES = window.JarvisTheme.IDS;
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const TIER_NAMES = { fast: 'Быстрая', smart: 'Умная' };
  const SETTING_KEYS = ['voice', 'quiet', 'alwaysOnTop', 'desktopOverlay', 'alwaysListen', 'autoStart', 'screenAuto', 'memoryAuto', 'motion', 'dictation', 'terseReplies'];
  const JOURNAL_LIMIT = 200;
  const MAX_FILES = 5;
  const MAX_PHRASES = 5;
  const MAX_STEPS = 20;

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('jarvis.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem('jarvis.' + key, JSON.stringify(value)); } catch { /* хранилище недоступно */ }
    },
  };

  const S = {
    view: 'nox',
    link: 'none',
    mode: null,
    hasKey: null,
    stateOk: null,
    settings: { voice: false, quiet: false, alwaysOnTop: false, desktopOverlay: false, alwaysListen: false, autoStart: false, screenAuto: false, memoryAuto: true, motion: true, dictation: false, terseReplies: true },
    tier: 'fast',
    workspace: '',
    folders: [],
    model: '',
    orbAnim: store.get('orbAnim', true) !== false,
    theme: THEMES.includes(store.get('theme', 'dark')) ? store.get('theme', 'dark') : 'dark',
    // Окно не получает событий «стоп включён / возобновлено» и «бюджет исчерпан» (этап 2, main.js):
    // флаги ставятся по текстам ошибок ядра и снимаются по правилам раздела 5 спецификации.
    stopped: false,
    budget: null, // дата (YYYY-MM-DD), когда лимит модели исчерпан
  };

  // Тему до первой отрисовки уже поставил theme-boot.js.
  // Левая панель: свёрнута до значков или нет (localStorage jarvis.railCollapsed), до первой отрисовки.
  let railCollapsed = store.get('railCollapsed', false) === true;
  document.documentElement.dataset.rail = railCollapsed ? 'collapsed' : 'open';

  // Поле поручения остаётся с ответом, независимо от размера живой сцены.
  $('.convo').append($('.stage-dock'));
  $('#chatEmpty').append($('#quickChips'));
  $('.topbar-right').prepend($('#workspaceSwitch'));
  for (const chip of $$('[data-scene-draft]')) chip.addEventListener('click', () => {
    const input = $('#chatInput');
    if (input.disabled || tracker.busy) return;
    input.value = chip.dataset.sceneDraft;
    document.body.dataset.sceneOpen = 'false';
    $('#sceneToggle').setAttribute('aria-expanded', 'false');
    $('#sceneToggle').textContent = 'Сцена Джарвиса';
    autosize(input); input.focus(); renderComposerState();
  });
  $('#sceneToggle').addEventListener('click', () => {
    const open = document.body.dataset.sceneOpen !== 'true';
    document.body.dataset.sceneOpen = String(open);
    $('#sceneToggle').setAttribute('aria-expanded', String(open));
    $('#sceneToggle').textContent = open ? 'Вернуться в чат' : 'Сцена Джарвиса';
    if (orb && orb._resize) requestAnimationFrame(() => orb._resize());
  });

  let orb = null;
  const orbSamples = []; // живые образцы в Настройках
  const themeOrbs = []; // неподвижные шары в образцах тем
  const tracker = new U.StatusTracker(() => renderStatus(), () => { if (orb) orb.pulse(1); });

  // ── Тосты ─────────────────────────────────────────────────────
  // Только подтверждение мгновенных действий; ошибки хода показываются в ленте.
  function toast(text, kind) {
    const box = $('#toasts');
    const t = el('div', { class: 'toast', 'data-kind': kind || 'info', role: kind === 'error' ? 'alert' : null },
      icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'clock'),
      el('span', { text }));
    box.append(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3500);
  }

  // ── Навигация ─────────────────────────────────────────────────
  function setCrumbSub(text) {
    renderCrumb(text);
  }

  // Большой шар и слово состояния живут на сцене Главной; на других разделах — в шапке.
  function placeOrb() {
    const big = S.view === 'dialog';
    const wrap = $('#orbWrap');
    const home = big ? $('#stageOrb') : $('.status-line');
    if (wrap.parentElement === home) return;
    if (orb) orb.density = big ? 2.4 : 0.5;
    home.prepend(wrap);
    // Состояние в шапке остаётся доступным; сцена имеет собственную подпись.
    if (!$('.status-line .status-text')) $('.status-line').append($('.status-text'));
    if (orb && orb._resize) orb._resize();
  }

  // ── Дела ──────────────────────────────────────────────────────
  const D = { groups: null };
  const DEAL_GROUPS = [
    { key: 'waiting', head: 'Ждёт вас', glyph: '▲', clear: true },
    { key: 'failed', head: 'Провалено', glyph: '■', clear: true },
    { key: 'overdue', head: 'Срок прошёл', glyph: '▲', clear: false },
    { key: 'started', head: 'В работе', glyph: '◐', clear: false },
    { key: 'promised', head: 'Обещано', glyph: '○', clear: false },
    { key: 'unverified', head: 'Не проверено за сутки', glyph: '○', clear: true },
  ];

  let dealsRefreshSeq = 0;
  async function reloadDeals() {
    if (has('remindersList')) loadReminders().catch(() => {});
    if (!has('dealsList')) return;
    const seq = ++dealsRefreshSeq;
    try {
      const groups = await call('dealsList');
      if (seq !== dealsRefreshSeq) return;
      D.groups = groups;
      renderWidgetsDeals();
      D.error = '';
    } catch (e) {
      if (seq !== dealsRefreshSeq) return;
      D.error = 'Дела не прочитаны: ' + errText(e);
    }
    renderDeals();
    renderBoard();
  }

  function waitCount() {
    return A.queue.length + (D.groups ? D.groups.waiting.length : 0);
  }

  function renderBoard() {
    const g = D.groups || {};
    const scheduled = [...(g.promised || []), ...(g.started || [])]
      .filter((d) => d.due && new Date(d.due).toDateString() === new Date().toDateString())
      .sort((a, b) => new Date(a.due) - new Date(b.due)).slice(0, 2);
    // Сегодня: поручения со сроком и напоминания на сегодня (из списка напоминаний, если он уже загружен).
    const today = new Date().toDateString();
    const reminders = (MEM.reminders || []).filter((r) => r.due && !r.done && new Date(r.due).toDateString() === today).sort((a, b) => new Date(a.due) - new Date(b.due)).slice(0, 2);
    const lines = [
      ...scheduled.map((d) => `${U.toolTitle(d.title)} · ${U.shortTime(d.due)}`),
      ...reminders.map((r) => `Напомнить: ${U.clip(String(r.text || ''), 60)} · ${U.shortTime(r.due)}`),
    ].slice(0, 4);
    $('#todayList').replaceChildren(...(lines.length ? lines.map((text) => el('li', { text }))
      : [el('li', { text: D.error ? 'Не удалось прочитать поручения' : 'Нет поручений и напоминаний на сегодня' })]));
    const n = (k) => (g[k] ? g[k].length : 0);
    const rows = [
      ['waiting', '▲', 'Ждёт вас', waitCount()],
      ['failed', '■', 'Провалено', n('failed')],
      ['overdue', '▲', 'Срок прошёл', n('overdue')],
      ['unverified', '○', 'Не проверено', n('unverified')],
      ['promised', '○', 'Обещано', n('promised')],
    ];
    $('#board').replaceChildren(...rows.map(([kind, glyph, label, count]) => el('li', {}, el('button', {
      class: 'board-row', type: 'button', 'data-kind': kind, 'data-zero': String(count === 0), onclick: () => show('deals'),
    }, el('span', { class: 'board-glyph', 'aria-hidden': 'true' }, U.glyph(glyph)), el('span', { text: label }), el('b', { text: String(count) })))));
    const you = waitCount();
    $('#youNum').textContent = String(you);
    $('#youHalf').dataset.on = String(you > 0);
    $('#youHalf').setAttribute('aria-label', `Ждёт вас: ${you}`);
  }

  function dealRow(d, group) {
    const when = d.due && group.key !== 'waiting' ? d.due : d.since;
    return el('div', { class: 'deal-row' },
      el('span', { class: 'deal-glyph', 'aria-hidden': 'true' }, U.glyph(group.glyph)),
      el('span', { class: 'deal-title', title: U.toolTitle(d.title) }, U.clip(U.toolTitle(d.title), 110), d.reason && d.reason !== 'unknown' ? el('span', { class: 'deal-reason', text: U.cleanSummary(d.reason) }) : null),
      el('time', { class: 'deal-time', datetime: when || '', text: when ? U.shortTime(when) : '—' }),
      group.clear ? el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: 'Разобрано', 'aria-label': `Разобрано: ${d.title}`,
        onclick: async () => {
          try {
            await call('dealClear', d.ref);
          } catch (e) {
            toast('Не получилось: ' + errText(e), 'error');
          }
          reloadDeals();
        },
      }) : el('span', {}));
  }

  function renderDeals() {
    const page = $('#dealsPage');
    if (D.error) { page.replaceChildren(el('p', { class: 'page-lead', text: D.error })); return; }
    const g = D.groups || {};
    const blocks = DEAL_GROUPS.filter((x) => g[x.key] && g[x.key].length).map((x) => el('section', { class: 'deals-group' },
      el('h2', { class: 'deals-head', 'data-kind': x.key }, x.head, el('span', { text: String(g[x.key].length) })),
      ...g[x.key].map((d) => dealRow(d, x))));
    page.replaceChildren(...(blocks.length ? blocks : [el('p', { class: 'page-lead', text: 'Ничего не висит.' })]));
  }

  function show(view) {
    if (!VIEWS[view]) view = 'nox';
    S.view = view;
    document.body.dataset.view = view;
    for (const v of $$('.view')) v.hidden = v.dataset.view !== view;
    for (const b of $$('[data-nav]')) {
      if (b.dataset.nav === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    $('#viewTitle').textContent = VIEWS[view];
    setCrumbSub(view === 'commands' && K.draft ? draftTitle(K.draft) : '');
    if (view === 'settings') {
      loadSettings();
      safe('память', loadMemory);
      safe('напоминания', loadReminders);
      safe('голос', loadVoiceOptions);
      safe('расширения', () => { if (window.JarvisExtensions) window.JarvisExtensions.load(); });
    }
    if (view === 'journal') reloadJournal();
    // Экран Nox получает беседу и поле ввода; классический — возвращает их на место.
    document.dispatchEvent(new CustomEvent('jarvis:view', { detail: view }));
    if (view === 'deals' || view === 'dialog') reloadDeals();
    placeOrb();
    if (view === 'commands') { loadCatalog().then(loadCommands); loadLibrary(); }
    if (view === 'nox' || view === 'dialog') {
      requestAnimationFrame(() => { if (!$('#chatInput').disabled) $('#chatInput').focus(); scrollFeed(true); });
    }
  }

  // ── Виджеты ───────────────────────────────────────────────────
  // Три плашки на Главной: погода (город), дела (счётчики групп) и музыка. Данные даёт мост
  // (widgetsData); метода может не быть в старой сборке — тогда блок остаётся скрытым.
  const WGT = { data: null, editing: false, musicTools: new Map() }; // последние данные и признак открытой правки города; musicTools — id музыкальных вызовов в ходу

  function renderWidgetsWeather(weather) {
    const wgt = $('#wgtWeather');
    if (!wgt || WGT.editing) return; // при открытой правке города поле ввода не трогаем
    const w = weather || {};
    const city = typeof w.city === 'string' ? w.city : '';
    if (!city) {
      $('#wgtCity').textContent = 'Не задан';
      $('#wgtTemp').textContent = '';
      $('#wgtWeatherNote').textContent = 'Нажмите, чтобы указать город';
      wgt.dataset.empty = 'true';
      return;
    }
    $('#wgtCity').textContent = city;
    wgt.dataset.empty = 'false';
    if (w.error) {
      // Город задан, но данных нет: виджет не пустой, объясняем одной фразой.
      $('#wgtTemp').textContent = '';
      $('#wgtWeatherNote').textContent = w.error === 'network' ? 'Нет связи — попробуем позже'
        : w.error === 'not_found' ? 'Город не найден — проверьте название'
        : 'Погода пришла неполной';
      return;
    }
    if (typeof w.temp !== 'number') {
      $('#wgtTemp').textContent = '';
      $('#wgtWeatherNote').textContent = 'Данных о погоде пока нет';
      return;
    }
    $('#wgtTemp').textContent = `${Math.round(w.temp)}°`;
    const parts = [];
    if (typeof w.apparent === 'number') parts.push(`ощущается ${Math.round(w.apparent)}°`);
    if (typeof w.precipitation === 'number') parts.push(`осадки ${w.precipitation.toFixed(1)} мм`);
    $('#wgtWeatherNote').textContent = parts.join(' · ');
  }

  function renderWidgetsMusic(music) {
    const wgt = $('#wgtMusic');
    if (!wgt) return;
    if (music && music.query) {
      const t = music.at ? U.shortTime(music.at) : '';
      $('#wgtMusicBody').textContent = `«${music.query}»`;
      $('#wgtMusicNote').textContent = [music.service, t].filter(Boolean).join(' · ');
      wgt.dataset.empty = 'false';
    } else {
      $('#wgtMusicBody').textContent = 'Ещё не просили';
      $('#wgtMusicNote').textContent = '';
      wgt.dataset.empty = 'true';
    }
  }

  function renderWidgetsDeals() {
    const wgt = $('#wgtDeals');
    if (!wgt) return;
    const g = D.groups || {};
    const n = (k) => (g[k] ? g[k].length : 0);
    // «Повисло» — то, что ждёт владельца: Ждёт вас, Провалено, Срок прошёл, Застрявшее, Не проверено.
    // «В работе» — то, что Джарвис делает или обещал: В работе, Обещано.
    const hung = n('waiting') + n('failed') + n('overdue') + n('stale') + n('unverified');
    const work = n('started') + n('promised');
    if (hung + work > 0) {
      $('#wgtDealsBody').replaceChildren(
        el('span', { class: 'wgt-kv' }, el('b', { text: String(hung) }), ' повисло'),
        el('span', { class: 'wgt-kv' }, el('b', { text: String(work) }), ' в работе'));
      wgt.dataset.empty = 'false';
    } else {
      $('#wgtDealsBody').textContent = 'Всё чисто';
      wgt.dataset.empty = 'true';
    }
  }

  async function reloadWidgets() {
    if (!has('widgetsData')) return; // старая сборка без моста: виджеты остаются скрытыми
    try {
      WGT.data = (await call('widgetsData')) || {};
    } catch {
      return; // мост не ответил — попробуем на следующем тике
    }
    $('#widgets').hidden = false;
    renderWidgetsWeather(WGT.data.weather || null);
    renderWidgetsMusic(WGT.data.music || null);
    if (D.groups) renderWidgetsDeals();
  }

  // Правка города прямо в плашке: Enter или уход фокуса — сохранить, Esc — отмена.
  function editWidgetCity() {
    if (WGT.editing) return; // правка уже открыта
    const btn = $('#wgtCity');
    if (!btn) return;
    const cur = WGT.data && WGT.data.weather && WGT.data.weather.city ? WGT.data.weather.city : '';
    const input = el('input', { class: 'wgt-city', type: 'text', value: cur, maxlength: 100, 'aria-label': 'Город' });
    WGT.editing = true;
    btn.replaceChildren(input);
    input.focus();
    let closed = false;
    const close = async (save) => {
      if (closed) return;
      closed = true;
      const text = input.value.trim();
      input.remove();
      WGT.editing = false;
      let city = cur;
      if (save) {
        try {
          const r = await call('widgetsSetCity', text);
          if (r && r.ok) city = r.city || '';
        } catch (e) {
          toast('Город не сохранён: ' + errText(e), 'error');
        }
      }
      // Город только что сохранён: не ждём минутного тика, перечитываем погоду сразу.
      renderWidgetsWeather({ city });
      if (save) reloadWidgets();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      else if (e.key === 'Escape') { e.preventDefault(); close(false); }
    });
    input.addEventListener('blur', () => close(true));
  }

  function initWidgets() {
    const city = $('#wgtCity');
    const deals = $('#wgtDeals');
    if (!city || !deals) return; // разметки нет — виджеты остаются скрытыми
    city.addEventListener('click', editWidgetCity);
    deals.addEventListener('click', () => show('deals'));
  }

  // ── Меню режима доступа в шапке ───────────────────────────────
  // Тот же setMode, что в Настройках и в трее: политика не меняется, меняется только путь к ней.
  function modeItems() {
    return $$('#modeMenu .menu-item');
  }

  function openModeMenu(focusCurrent = true) {
    const menu = $('#modeMenu');
    if (!menu.hidden) return;
    menu.hidden = false;
    $('#modePill').setAttribute('aria-expanded', 'true');
    const items = modeItems();
    const cur = items.find((b) => b.dataset.mode === S.mode) || items[0];
    if (focusCurrent && cur) cur.focus();
  }

  function closeModeMenu(returnFocus) {
    const menu = $('#modeMenu');
    if (menu.hidden) return false;
    menu.hidden = true;
    $('#modePill').setAttribute('aria-expanded', 'false');
    if (returnFocus) $('#modePill').focus();
    return true;
  }

  function initModeMenu() {
    const pill = $('#modePill');
    const menu = $('#modeMenu');
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.hidden) openModeMenu(); else closeModeMenu(true);
    });
    pill.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openModeMenu(); }
    });
    menu.addEventListener('keydown', (e) => {
      const items = modeItems();
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModeMenu(true); return; }
      if (e.key === 'Tab') { closeModeMenu(false); return; }
      let j = -1;
      if (e.key === 'ArrowDown') j = (i + 1) % items.length;
      else if (e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = items.length - 1;
      if (j >= 0) { e.preventDefault(); items[j].focus(); }
    });
    for (const b of $$('[data-mode]', menu)) {
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-disabled') === 'true') return;
        closeModeMenu(true);
        changeMode(b.dataset.mode);
      });
    }
    $('#modeMore').addEventListener('click', () => {
      closeModeMenu(false);
      show('settings');
      requestAnimationFrame(() => {
        const sec = $('#settings-mode');
        if (sec) sec.scrollIntoView({ block: 'start' });
        const r = $('#modeOptions input:checked') || $('#modeOptions input');
        if (r) r.focus();
      });
    });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !e.target.closest('#modeWrap')) closeModeMenu(false);
    });
  }

  function goToModelSettings() {
    show('settings');
    requestAnimationFrame(() => {
      const sec = $('#settings-model');
      if (!sec) return;
      sec.scrollIntoView({ block: 'start' });
      const btn = $('#brainRecheck');
      if (btn) btn.focus();
    });
  }

  function initNav() {
    for (const b of $$('[data-nav]')) b.addEventListener('click', () => show(b.dataset.nav));
    $('#youHalf').addEventListener('click', () => show('deals'));
    const tick = () => {
      const now = new Date();
      $('#clock').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      $('#clockDate').textContent = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
    };
    tick();
    setInterval(tick, 10000);
    setInterval(() => { if (S.view === 'dialog' || S.view === 'deals') reloadDeals(); reloadWidgets(); }, 60000);
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-goto]');
      if (go) show(go.dataset.goto);
      const stop = e.target.closest('[data-action="stop"]');
      if (stop) stopTurn();
    });
    initModeMenu();
    $('#bannerAction').addEventListener('click', () => {
      const act = $('#bannerAction').dataset.act;
      if (act === 'recheck') loadState();
      else if (act === 'key') goToModelSettings();
    });
    document.addEventListener('keydown', onGlobalKey);
  }

  // Клавиши окна (глобальные Ctrl+Alt+J и Ctrl+Alt+Shift+K живут в main.js и здесь не трогаются).
  function onGlobalKey(e) {
    if (e.defaultPrevented) return;
    const modal = document.querySelector('dialog[open]');
    if (e.key === 'Escape') {
      if (modal) return; // окно подтверждения обрабатывает Esc само (= «Отклонить»)
      if (closeModeMenu(true)) { e.preventDefault(); return; }
      const det = e.target && e.target.closest ? e.target.closest('details[open]') : null;
      if (det) { det.open = false; const s = $('summary', det); if (s) s.focus(); e.preventDefault(); return; }
      if (tracker.busy) { e.preventDefault(); stopTurn(); }
      return;
    }
    if (modal) return;
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    if (!ctrl) return;
    const k = e.key.toLowerCase();
    if (['1', '2', '3', '4', '5'].includes(e.key) && !e.shiftKey) {
      e.preventDefault();
      show(VIEW_KEYS[Number(e.key) - 1]);
    } else if ((k === 'l' || k === 'д') && !e.shiftKey) {
      e.preventDefault();
      if (S.view !== 'nox') show('nox');
      requestAnimationFrame(() => $('#chatInput').focus());
    } else if ((k === 'n' || k === 'т') && !e.shiftKey && S.view === 'commands') {
      e.preventDefault();
      if (typeof newCommand === 'function') newCommand();
    } else if ((k === 's' || k === 'ы') && !e.shiftKey && S.view === 'commands' && K.draft) {
      e.preventDefault();
      saveDraft();
    }
  }

  // ── Шар и статус ──────────────────────────────────────────────
  function initOrb() {
    if (typeof window.JarvisOrb !== 'function') return;
    // Шар 32 px в шапке: плотность ниже, чтобы облако точек не сливалось в пятно (раздел 12 спецификации).
    // Старое имя вида reactor тихо открывает «Ядро».
    const raw = store.get('orbVariant', null);
    const saved = raw === 'reactor' ? 'core' : raw;
    const opts = $$('[data-orb-opt]');
    const variant = opts.some((b) => b.dataset.orbOpt === saved) ? saved : defaultOrb();
    orb = new window.JarvisOrb($('#orb'), { density: 0.5, variant });
    const stage = $('#stage');
    // Состояние шара следует за сценой: один источник правды, data-state.
    new MutationObserver(syncOrbState).observe(stage, { attributes: true, attributeFilter: ['data-state'] });
    // Шар в образце темы неподвижен: двенадцать живых холстов ради значка не нужны.
    for (const c of $$('.theme-mini canvas')) {
      const mini = new window.JarvisOrb(c, { density: 0.4, variant });
      mini.setAnimated(false);
      themeOrbs.push(mini);
    }
    for (const b of opts) {
      orbSamples.push(new window.JarvisOrb($('canvas', b), { density: 1.6, variant: b.dataset.orbOpt }));
      b.addEventListener('click', () => setOrbVariant(b.dataset.orbOpt));
    }
    segRadioKeys($('#orbPick'), (b) => setOrbVariant(b.dataset.orbOpt));
    setOrbVariant(variant, false);
    applyOrbAnimation();
    if (reduceMotion && reduceMotion.addEventListener) reduceMotion.addEventListener('change', applyOrbAnimation);
  }

  // Шар по умолчанию — Ядро. Вид, выбранный владельцем, сохраняется и важнее; старая «Обмотка» падает на Ядро.
  function defaultOrb() { return 'core'; }
  function setOrbVariant(id, save = true) {
    if (save) store.set('orbVariant', id);
    if (orb) orb.setVariant(id);
    for (const m of themeOrbs) m.setVariant(id);
    $('#stage').dataset.orb = id; // contour.js перерисовывает вырез по этому атрибуту
    for (const b of $$('[data-orb-opt]')) {
      const on = b.dataset.orbOpt === id;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  function syncOrbState() {
    const vs = $('#stage').dataset.state;
    if (orb) orb.setState(vs === 'offline' ? 'idle' : vs === 'stopped' ? 'error' : vs);
  }

  // «Уменьшить движение» в системе — статичный шар, как при выключенной анимации.
  function applyOrbAnimation() {
    document.documentElement.dataset.motion = S.orbAnim ? 'on' : 'off';
    // Шар живой, даже если в Windows выключены эффекты анимации: у него свой переключатель.
    if (window.JarvisOrb) window.JarvisOrb.ignoreSystemMotion = true;
    const on = S.orbAnim;
    $('#orbAnimHint').textContent = 'Только на этом компьютере. Выключено — шар не движется';
    if (orb) orb.setAnimated(on);
    for (const s of orbSamples) s.setAnimated(on);
  }

  function linkDown() {
    return S.link === 'none' || S.stateOk === false;
  }

  // Видимое состояние: «Слушаю» показываем во время диктовки (шар это умеет).
  function viewState() {
    if (linkDown()) return 'offline';
    if (S.stopped && !tracker.busy) return 'stopped';
    return tracker.state;
  }

  const VIEW_PHRASE = { offline: 'Нет связи', stopped: 'Стоп', verifying: 'Проверяю', cancelled: 'Остановлено' };

  function statusSub(vs) {
    const last = tracker.last;
    if (vs === 'offline') return '';
    if (vs === 'stopped') return 'Возобновите в трее';
    if (vs === 'error') return tracker.errorText || '';
    if (vs === 'cancelled') return 'Ход остановлен вами';
    // «Проверяю»: показываем, что именно проверяется, если ядро прислало безопасный текст шага.
    if (vs === 'verifying') return tracker.note || 'Сверяю с наблюдаемым результатом';
    if (vs === 'waiting_approval' && last) {
      const brief = U.argsBrief(last.args, 48);
      return U.toolTitle(last.tool) + (brief ? ': ' + brief : '');
    }
    if ((vs === 'acting' || vs === 'searching') && last && last.status === 'running') {
      const brief = U.argsBrief(last.args, 48);
      return U.toolTitle(last.tool) + (brief ? ': ' + brief : '');
    }
    // Планирование и обдумывание: короткий шаг от ядра вместо пустоты.
    if ((vs === 'thinking' || vs === 'searching') && tracker.note) return tracker.note;
    if (vs === 'idle' && S.hasKey === false) return 'Не подключён к модели — пока отвечаю заглушкой';
    return '';
  }

  function renderStatus() {
    const vs = viewState();
    $('#orbWrap').dataset.state = vs;
    $('#stage').dataset.state = vs;
    const text = VIEW_PHRASE[vs] || U.PHRASE[vs] || U.PHRASE.idle;
    const main = $('#statusText');
    if (main.textContent !== text) main.textContent = text;
    main.dataset.state = vs;
    const sub = statusSub(vs);
    $('#statusSub').textContent = sub;
    $('#statusSub').title = sub;
    $('#headerState').textContent = text;
    $('#headerState').dataset.state = vs;
    $('#sceneTitle').textContent = vs === 'idle' ? 'Готов помочь' : text;
    $('#sceneSubtitle').textContent = sub || (vs === 'idle' ? 'Ожидает задачу' : '');
    for (const chip of $$('[data-scene-draft]')) chip.disabled = tracker.busy || linkDown() || S.stopped;
    for (const b of $$('[data-action="stop"]')) b.hidden = !tracker.busy;
    $('#chatSend').hidden = tracker.busy;
    if (typeof renderComposerState === 'function') renderComposerState();
  }

  // ── Баннер: один, по приоритету ───────────────────────────────
  // 1) аварийный стоп, 2) нет связи с ядром, 3) бюджет исчерпан, 4) нет ключа.
  function budgetActive() {
    if (!S.budget) return false;
    if (S.budget !== today()) { S.budget = null; return false; }
    return true;
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function renderBanner() {
    let b = null;
    if (S.stopped) b = { kind: 'stop', icon: 'stop', role: 'alert', text: 'Аварийный стоп. Новые действия не выполняются. Возобновите в трее.' };
    else if (linkDown()) b = { kind: 'offline', icon: 'alert', role: 'alert', text: 'Нет связи с ядром. Перезапустите Джарвиса.', act: 'recheck', label: 'Проверить снова' };
    else if (budgetActive()) b = { kind: 'budget', icon: 'gauge', role: 'status', text: 'Дневной лимит модели исчерпан. Команды и быстрые действия работают.' };
    else if (S.hasKey === false) b = { kind: 'key', icon: 'key', role: 'status', text: 'Джарвис не подключён к модели — пока отвечает заглушкой.', act: 'key', label: 'Как подключить' };
    const wrap = $('#bannerWrap');
    wrap.hidden = !b;
    if (!b) return;
    const box = $('#banner');
    box.dataset.kind = b.kind;
    if (box.getAttribute('role') !== b.role) box.setAttribute('role', b.role);
    const ic = $('#bannerIcon');
    if (ic.dataset.icon !== b.icon) ic.replaceChildren(icon(b.icon));
    ic.dataset.icon = b.icon;
    $('#bannerText').textContent = b.text;
    const act = $('#bannerAction');
    act.hidden = !b.act;
    act.textContent = b.label || '';
    act.dataset.act = b.act || '';
  }

  function renderCrumb(text) {
    const c = $('#editorCrumb');
    const on = Boolean(text) && S.view === 'commands';
    c.hidden = !on;
    $('#viewTitle').classList.toggle('sr-only', on);
    if (on) $('#cmdEditorTitle').textContent = text;
  }

  // ── Переключатели ─────────────────────────────────────────────
  function initToggles() {
    for (const inp of $$('[data-setting]')) {
      inp.addEventListener('change', () => changeSetting(inp.dataset.setting, inp.checked));
    }
    for (const inp of $$('[data-local="orbAnim"]')) {
      inp.addEventListener('change', () => {
        S.orbAnim = inp.checked;
        store.set('orbAnim', S.orbAnim);
        applyOrbAnimation();
        syncToggles();
      });
    }
    const voiceTest = $('#voiceTest');
    if (voiceTest) voiceTest.addEventListener('click', () => testVoice(voiceTest));
    // Режим сна — строковая настройка, поэтому отдельно от переключателей-галочек.
    const keepAwake = $('#setKeepAwake');
    if (keepAwake) keepAwake.addEventListener('change', () => changeKeepAwake(keepAwake.value));
  }

  // Режим «не спать»: off / while-working / always. Сохраняется сразу, окно показывает выбор как есть.
  async function changeKeepAwake(value) {
    if (!has('setSetting')) return;
    const prev = S.settings.keepAwake || 'while-working';
    S.settings.keepAwake = value;
    syncToggles();
    let ok = false;
    let why = '';
    try {
      const r = await call('setSetting', 'keepAwake', value);
      ok = !(r && r.ok === false);
      if (r && r.error) why = String(r.error);
    } catch (err) {
      why = errText(err);
    }
    if (!ok) {
      S.settings.keepAwake = prev;
      syncToggles();
      toast('Настройка не сохранилась' + (why ? ': ' + why : ''), 'error');
    }
  }

  // Проверка голоса: пробная фраза через настоящее ядро. Ключ голоса читается из .env заново,
  // поэтому вписанный после запуска ключ подхватывается без перезапуска.
  async function testVoice(btn) {
    if (!has('voiceTest')) {
      toast('Проверка голоса недоступна в этой версии ядра', 'error');
      return;
    }
    const was = btn.disabled;
    btn.disabled = true;
    try {
      const r = await call('voiceTest');
      if (r && r.ok) toast('Голос работает', 'ok');
      else toast('Голос не сработал' + (r && r.error ? ': ' + r.error : ''), 'error');
    } catch (err) {
      toast('Голос не сработал: ' + errText(err), 'error');
    } finally {
      btn.disabled = was;
    }
  }

  function syncToggles() {
    const can = has('setSetting');
    for (const inp of $$('[data-setting]')) {
      inp.checked = Boolean(S.settings[inp.dataset.setting]);
      inp.disabled = !can;
    }
    for (const inp of $$('[data-local="orbAnim"]')) inp.checked = S.orbAnim;
    const voiceTest = $('#voiceTest');
    if (voiceTest) voiceTest.disabled = !has('voiceTest');
    const keepAwake = $('#setKeepAwake');
    if (keepAwake) {
      keepAwake.value = ['off', 'while-working', 'always'].includes(S.settings.keepAwake) ? S.settings.keepAwake : 'while-working';
      keepAwake.disabled = !can;
    }
    syncDictationVisible();
  }

  const settingRevisions = new Map();
  let settingsLoadSeq = 0;

  async function changeSetting(key, value) {
    if (!SETTING_KEYS.includes(key)) return;
    const revision = (settingRevisions.get(key) || 0) + 1;
    settingRevisions.set(key, revision);
    const prev = S.settings[key];
    S.settings[key] = value;
    syncToggles();
    let ok = false;
    let why = '';
    try {
      const r = await call('setSetting', key, value);
      ok = !(r && r.ok === false);
      if (r && r.error) why = String(r.error);
    } catch (e) {
      why = errText(e);
    }
    if (settingRevisions.get(key) !== revision) return;
    if (!ok) {
      S.settings[key] = prev;
      syncToggles();
      toast('Настройка не сохранилась' + (why ? ': ' + why : ''), 'error');
    }
  }

  // ── Лоток «Ждут вас» ──────────────────────────────────────────
  // Один блок между лентой и полем ввода: запросы подтверждения и задачи, которым нужно внимание.
  // Строка задачи: что случилось, когда, «Открыть отчёт» и «Скрыть». Скрытие не меняет задачу.
  const W = { tasks: [], expanded: false, collapsed: store.get('waitCollapsed', false) === true, hidden: store.get('waitHidden', false) === true };
  const WAIT_VISIBLE = 3;

  // Итог задачи по коду вердикта; технический код — в «Подробнее».
  const VERDICT_LABEL = {
    verified: 'Проверено',
    unverified: 'Не проверено',
    failed: 'Не получилось',
    not_applicable: 'Только чтение — изменений нет',
  };
  const VERDICT_TONE = { verified: 'ok', unverified: 'warn', failed: 'err', not_applicable: 'neutral' };
  const ATTN_LABEL = { blocked: 'Заблокирована', paused: 'На паузе', waiting_approval: 'Ждёт решения', unverified: 'Не проверено' };
  const ATTN_TONE = { blocked: 'err', paused: 'warn', waiting_approval: 'warn', unverified: 'warn' };
  const TONE_ICON = { ok: 'check', warn: 'alert', err: 'ban', neutral: 'list' };

  function attnInfo(task) {
    const code = task.verdict && task.verdict.code;
    if ((task.status === 'unverified' || task.status === 'done') && VERDICT_LABEL[code]) {
      return { label: VERDICT_LABEL[code], tone: VERDICT_TONE[code] || 'warn' };
    }
    return { label: ATTN_LABEL[task.status] || 'Задача', tone: ATTN_TONE[task.status] || 'warn' };
  }

  let taskRefreshSeq = 0;
  async function refreshTasks() {
    const seq = ++taskRefreshSeq;
    let list = [];
    try {
      const got = await call('tasksAttention');
      list = Array.isArray(got) ? got : [];
    } catch {
      list = [];
    }
    if (seq !== taskRefreshSeq) return;
    W.tasks = list.filter((t) => t && typeof t === 'object' && t.id);
    renderWaitTray();
  }

  function approvalRow(item) {
    const brief = U.argsBrief(item.args, 120);
    const text = `${U.toolTitle(item.name)}${brief ? ': ' + brief : ''}`;
    return el('li', { class: 'wait-row', 'data-tone': 'warn' },
      el('span', { class: 'wait-icon' }, icon('hourglass')),
      el('span', { class: 'wait-main' },
        el('span', { class: 'wait-text', title: text, text }),
        riskNode(item.risk)),
      el('span', { class: 'wait-acts' },
        el('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'aria-label': 'Решить: ' + text, text: 'Решить', onclick: () => openApproval(item.id) }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'Отклонить: ' + text, text: 'Отклонить', onclick: () => answerById(item.id, 'reject') })));
  }

  function taskRow(task) {
    const info = attnInfo(task);
    const text = `${info.label}: ${task.title || 'задача'}${task.reason ? ' — ' + task.reason : ''}`;
    const when = task.updatedAt ? U.shortTime(task.updatedAt) : '';
    const code = task.verdict && task.verdict.code;
    const open = task.report ? el('button', {
      class: 'btn btn-secondary btn-sm', type: 'button', text: 'Открыть отчёт', 'aria-label': 'Открыть отчёт: ' + (task.title || 'задача'),
      onclick: async () => {
        try {
          const res = await call('tasksOpenReport', task.id);
          if (res && res.ok === false) toast('Отчёт не открылся: ' + (res.error || 'причина неизвестна'), 'error');
        } catch (e) {
          toast('Отчёт не открылся: ' + errText(e), 'error');
        }
      },
    }) : null;
    const hide = el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: 'Скрыть', title: 'Скрыть строку. Задача не меняется',
      'aria-label': 'Скрыть строку: ' + (task.title || 'задача'),
      onclick: async () => {
        try { await call('tasksHideAttention', task.id); } catch { /* нет связи: строка останется, ничего не теряем */ }
        refreshTasks();
      },
    });
    return el('li', { class: 'wait-row', 'data-tone': info.tone },
      el('span', { class: 'wait-icon' }, icon(TONE_ICON[info.tone] || 'alert')),
      el('span', { class: 'wait-main' },
        el('span', { class: 'wait-text', title: text, text }),
        when ? el('time', { class: 'wait-when', datetime: new Date(U.toMs(task.updatedAt)).toISOString(), title: U.absTime(task.updatedAt), text: when }) : null,
        code ? el('details', { class: 'wait-more' },
          el('summary', { text: 'Подробнее' }),
          el('span', { text: `код: ${code}${task.verdict.reason ? '. ' + task.verdict.reason : ''}` })) : null),
      el('span', { class: 'wait-acts' }, open, hide));
  }

  function renderWaitTray() {
    const rows = [...A.queue.map(approvalRow), ...W.tasks.map(taskRow)];
    const n = rows.length;
    const tray = $('#waitTray');
    tray.hidden = n === 0 || W.hidden;
    // Скрытый лоток: остаётся кнопка со счётчиком; «Ждёт вас» на доске счётчик не теряет.
    const back = $('#waitRestore');
    back.hidden = !(W.hidden && n > 0);
    back.textContent = `Требуют внимания · ${n}`;
    $('#waitTitle').textContent = `Требуют внимания · ${n}`;
    renderBoard();
    if (!n) { $('#waitList').replaceChildren(); return; }
    const list = $('#waitList');
    list.replaceChildren(...(W.expanded ? rows : rows.slice(0, WAIT_VISIBLE)));
    list.classList.toggle('is-all', W.expanded);
    const all = $('#waitAll');
    all.hidden = n <= WAIT_VISIBLE;
    all.textContent = W.expanded ? 'Свернуть до трёх' : `Показать все (${n})`;
    $('#waitBody').hidden = W.collapsed;
    const tg = $('#waitToggle');
    tg.setAttribute('aria-expanded', String(!W.collapsed));
    const label = W.collapsed ? 'Развернуть список' : 'Свернуть список';
    tg.setAttribute('aria-label', label);
    tg.title = label;
  }

  function initWaitTray() {
    $('#waitToggle').addEventListener('click', () => {
      W.collapsed = !W.collapsed;
      store.set('waitCollapsed', W.collapsed);
      renderWaitTray();
    });
    $('#waitAll').addEventListener('click', () => { W.expanded = !W.expanded; renderWaitTray(); });
    const setHidden = (on) => {
      W.hidden = on;
      store.set('waitHidden', on);
      renderWaitTray();
      $(on ? '#waitRestore' : '#waitHide').focus();
    };
    $('#waitHide').addEventListener('click', () => setHidden(true));
    $('#waitRestore').addEventListener('click', () => setHidden(false));
  }

  // ── Центр управления миссиями ─────────────────────────────────
  // Сводка по задачам: что в работе, что в очереди, где ошибки и какие отчёты готовы.
  // Строки собирает главный процесс (src/tasks/board.js); здесь только показ и обновление.
  const M = { open: false, rows: [], line: '', reason: '', seq: 0 };

  async function refreshMissions() {
    // Каждому запросу свой номер: ответ на старый запрос не должен затирать более свежие данные.
    const seq = ++M.seq;
    let data = null;
    try {
      data = await call('missionsBoard');
    } catch (e) {
      if (seq !== M.seq) return;
      M.rows = [];
      M.line = '';
      M.reason = errText(e);
      renderMissions();
      return;
    }
    if (seq !== M.seq) return;
    M.rows = data && Array.isArray(data.rows) ? data.rows.filter((r) => r && typeof r === 'object') : [];
    M.line = data && data.summary && typeof data.summary.line === 'string' ? data.summary.line : '';
    M.reason = data && data.reason ? String(data.reason) : '';
    renderMissions();
  }

  function missionRow(row) {
    const tone = row.error ? 'err' : row.active ? 'warn' : row.reportReady ? 'ok' : 'neutral';
    const open = row.reportReady && row.id ? el('button', {
      class: 'btn btn-secondary btn-sm', type: 'button', text: 'Открыть отчёт',
      'aria-label': 'Открыть отчёт: ' + (row.title || 'задача'),
      onclick: async () => {
        try {
          const res = await call('tasksOpenReport', row.id);
          if (res && res.ok === false) toast('Отчёт не открылся: ' + (res.error || 'причина неизвестна'), 'error');
        } catch (e) {
          toast('Отчёт не открылся: ' + errText(e), 'error');
        }
      },
    }) : null;
    return el('li', { class: 'missions-row', 'data-tone': tone },
      el('span', { class: 'missions-status', text: row.statusHuman || '—' }),
      el('span', { class: 'missions-main' },
        el('span', { class: 'missions-text', title: row.title || 'задача', text: row.title || 'задача' }),
        row.reason ? el('span', { class: 'missions-reason', text: row.reason }) : null),
      open);
  }

  function renderMissions() {
    const list = $('#missionsList');
    if (!list) return;
    list.textContent = '';
    if (M.rows.length) {
      for (const row of M.rows) list.append(missionRow(row));
    } else {
      list.append(el('li', { class: 'missions-empty', text: M.reason ? 'Доска недоступна: ' + M.reason : 'Задач нет' }));
    }
    const line = $('#missionsLine');
    if (line) line.textContent = M.line;
    $('#missionsToggle').setAttribute('aria-expanded', String(M.open));
  }

  function initMissions() {
    $('#missionsToggle').addEventListener('click', async () => {
      M.open = !M.open;
      $('#missionsPanel').hidden = !M.open;
      $('#missionsToggle').setAttribute('aria-expanded', String(M.open));
      if (M.open) await refreshMissions();
    });
    $('#missionsHide').addEventListener('click', () => {
      M.open = false;
      $('#missionsPanel').hidden = true;
      $('#missionsToggle').setAttribute('aria-expanded', 'false');
      $('#missionsToggle').focus();
    });
  }

  // ── Левая панель ──────────────────────────────────────────────
  // Свёрнута — только значки; подписи и подсказки видны в развёрнутом виде.
  function initRail() {
    const btn = $('#railToggle');
    const apply = () => {
      document.documentElement.dataset.rail = railCollapsed ? 'collapsed' : 'open';
      const label = railCollapsed ? 'Развернуть панель' : 'Свернуть панель';
      btn.setAttribute('aria-expanded', String(!railCollapsed));
      btn.setAttribute('aria-label', label);
      btn.title = label;
    };
    btn.addEventListener('click', () => {
      railCollapsed = !railCollapsed;
      store.set('railCollapsed', railCollapsed);
      apply();
    });
    apply();
  }

  // ── Состояние ядра, режим, модель ───────────────────────────────
  async function loadState() {
    refreshTasks();
    try {
      const st = await call('getState');
      if (st && typeof st === 'object') {
        if (MODE_NAMES[st.mode]) S.mode = st.mode;
        S.hasKey = Boolean(st.hasKey);
        S.model = typeof st.model === 'string' ? st.model : '';
        S.stateOk = true;
      } else {
        S.stateOk = false;
      }
    } catch {
      S.hasKey = null;
      S.stateOk = false;
    }
    safe('режим', renderMode);
    safe('связь', renderLink);
    safe('статус', renderStatus);
  }

  async function loadSettings() {
    const seq = ++settingsLoadSeq;
    const revisions = new Map(settingRevisions);
    let s = null;
    try { s = await call('getSettings'); } catch { /* старое ядро: оставляем значения по умолчанию */ }
    if (seq !== settingsLoadSeq) return;
    if (s && typeof s === 'object') {
      for (const k of SETTING_KEYS) {
        if ((settingRevisions.get(k) || 0) === (revisions.get(k) || 0)) S.settings[k] = s[k] === true;
      }
      if (['off', 'while-working', 'always'].includes(s.keepAwake)) S.settings.keepAwake = s.keepAwake;
      if (TIER_NAMES[s.modelTier]) S.tier = s.modelTier;
      S.workspace = s.workspace ? String(s.workspace) : '';
      S.folders = Array.isArray(s.connectedFolders) ? s.connectedFolders.map(String) : [];
    }
    syncToggles();
    renderTier();
    renderWorkspace();
  }

  function renderMode() {
    const name = MODE_NAMES[S.mode] || 'неизвестно';
    const can = has('setMode');
    $('#modePillText').textContent = name;
    $('#modePillShort').textContent = MODE_SHORT[S.mode] || name;
    const pill = $('#modePill');
    pill.dataset.mode = S.mode || '';
    pill.setAttribute('aria-label', 'Режим доступа: ' + name);
    pill.title = can ? 'Режим доступа: ' + name + '. Сменить' : 'Режим доступа: ' + name;
    for (const b of modeItems()) {
      if (!b.dataset.mode) continue;
      b.setAttribute('aria-checked', String(b.dataset.mode === S.mode));
      b.setAttribute('aria-disabled', String(!can));
    }
    for (const r of $$('#modeOptions input[name="mode"]')) {
      r.checked = r.value === S.mode;
      r.disabled = !has('setMode');
    }
  }

  async function changeMode(next) {
    if (!MODE_NAMES[next] || next === S.mode) return;
    const prev = S.mode;
    S.mode = next;
    renderMode();
    try {
      const r = await call('setMode', next);
      if (r && r.ok === false) throw new Error('ядро отклонило режим');
      if (r && MODE_NAMES[r.mode]) S.mode = r.mode;
      // В «Полном доступе» вопросов не будет: говорим это прямо, а не молча переключаем.
      if (S.mode === 'full') toast('Полный доступ: вопросов не будет. Удаление всё равно спросит, оплата запрещена. Фон не трогает стол, пока вы за компьютером.', 'error');
      else toast('Режим: ' + MODE_NAMES[S.mode], 'ok');
    } catch (e) {
      S.mode = prev;
      toast('Режим не сменился: ' + errText(e), 'error');
    }
    renderMode();
  }

  function renderLink() {
    const box = $('#brainState');
    const text = $('#brainStateText');
    if (linkDown()) {
      box.dataset.ok = 'down';
      text.textContent = 'Нет связи с ядром';
    } else if (S.hasKey === true) {
      box.dataset.ok = 'yes';
      text.textContent = 'Модель подключена';
    } else if (S.hasKey === false) {
      box.dataset.ok = 'no';
      text.textContent = 'Нет ключа';
    } else {
      box.dataset.ok = 'unknown';
      text.textContent = 'Проверяю…';
    }
    const model = $('#brainModel');
    if (model) {
      model.textContent = S.hasKey === true && S.model ? S.model : '';
      model.hidden = !(S.hasKey === true && S.model);
    }
    $('#brainHint').hidden = S.hasKey !== false;
    $('#settingsDot').hidden = S.hasKey !== false && !linkDown();

    let core;
    if (S.link === 'none') core = 'нет связи';
    else if (S.stateOk === false) core = 'не ответило';
    else if (S.stateOk !== true) core = 'подключение…';
    else core = S.link === 'stub' ? 'эмуляция (dev-stub)' : 'на связи';
    $('#coreState').textContent = core;
    $('#stubTag').hidden = S.link !== 'stub';
    renderBanner();
  }


  // ── Скорость ответа ───────────────────────────────────────────
  function renderTier() {
    for (const b of $$('[data-tier]')) {
      b.setAttribute('aria-checked', String(b.dataset.tier === S.tier));
      b.tabIndex = b.dataset.tier === S.tier ? 0 : -1;
    }
  }

  // ── Тема окна ─────────────────────────────────────────────────
  // Локальная настройка окна (localStorage jarvis.theme), ядро не трогает. По умолчанию «Ночь».
  const systemLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function renderTheme() {
    for (const b of $$('[data-theme-opt]')) {
      const on = b.dataset.themeOpt === S.theme;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  // Фон самого окна Electron — под тему: иначе при растягивании видна чужая кайма.
  function syncWindowBackground() {
    if (!has('setWindowBackground')) return;
    // Прозрачность и скругление окна — из «Вид». При включённой прозрачности или радиусе
    // подложку окна отдаём странице ('#00000000'), иначе она перекрыла бы углы и фон.
    let look = {};
    try {
      look = window.JarvisTheme && typeof window.JarvisTheme.getLook === 'function' ? window.JarvisTheme.getLook() : {};
    } catch { look = {}; }
    const alpha = Number(look.winAlpha) || 0;
    const radius = Number(look.winRadius) || 0;
    const transparent = alpha > 0 || radius > 0;
    const color = transparent ? '#00000000' : getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    call('setWindowBackground', color).catch(() => {});
  }

  function refreshOrbColors() {
    syncWindowBackground();
    if (!orb || typeof orb._readColors !== 'function') return;
    orb._readColors();
    for (const s of orbSamples) { s._readColors(); s._draw(); }
    for (const m of themeOrbs) { m._readColors(); m._snap(); m._draw(); }
    applyOrbAnimation();
    renderStatus();
  }

  document.addEventListener('jarvis:toast', (e) => toast(e.detail.text, e.detail.kind));
  // Свой цвет акцента (accent.js, theme-boot.js): шар и фон окна читают цвет заново.
  document.addEventListener('jarvis:accent', () => requestAnimationFrame(refreshOrbColors));
  // Ручки «Вид» (тема, прозрачность и радиус окна): подложка окна обновляется сразу.
  document.addEventListener('jarvis:look', () => requestAnimationFrame(syncWindowBackground));

  function setTheme(next) {
    if (!THEMES.includes(next)) return;
    S.theme = next;
    store.set('theme', next);
    const swap = () => {
      window.JarvisTheme.apply(next);
      if (orb && store.get('orbVariant', null) === null) setOrbVariant(defaultOrb(), false);
      renderTheme();
      refreshOrbColors();
    };
    // Плавная смена цветов всего окна; без поддержки или без движения — сразу.
    if (document.startViewTransition && !(reduceMotion && reduceMotion.matches)) document.startViewTransition(swap);
    else swap();
  }

  // Радиогруппа из кнопок-сегментов: одна точка табуляции, стрелки двигают и выбирают.
  function segRadioKeys(group, pick) {
    // Некоторые группы (например, выбор модели) могут отсутствовать в разметке: это не ошибка запуска.
    if (!group) return;
    group.addEventListener('keydown', (e) => {
      const opts = $$('[role="radio"]', group).filter((b) => b.getAttribute('aria-disabled') !== 'true');
      const i = opts.indexOf(document.activeElement);
      if (i < 0) return;
      let j = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % opts.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + opts.length) % opts.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = opts.length - 1;
      if (j < 0) return;
      e.preventDefault();
      opts[j].focus();
      pick(opts[j]);
    });
  }

  function initTheme() {
    for (const b of $$('[data-theme-opt]')) b.addEventListener('click', () => setTheme(b.dataset.themeOpt));
    segRadioKeys($('#themeSeg'), (b) => setTheme(b.dataset.themeOpt));
    segRadioKeys($('#tierSeg'), (b) => changeTier(b.dataset.tier));
    if (systemLight && systemLight.addEventListener) {
      systemLight.addEventListener('change', () => {
        $('.theme-opt[data-theme-opt="system"] .theme-mini').dataset.theme = window.JarvisTheme.resolve('system');
        if (S.theme === 'system') window.JarvisTheme.apply('system');
        requestAnimationFrame(refreshOrbColors);
      });
    }
    $('.theme-opt[data-theme-opt="system"] .theme-mini').dataset.theme = window.JarvisTheme.resolve('system');
    renderTheme();
    syncWindowBackground();
  }

  async function changeTier(next) {
    if (!TIER_NAMES[next] || next === S.tier) return;
    let r = null;
    let why = '';
    try {
      r = await call('setModelTier', next);
    } catch (e) {
      why = errText(e);
    }
    if (r && r.ok !== false) {
      S.tier = r.tier && TIER_NAMES[r.tier] ? r.tier : next;
      renderTier();
      toast('Скорость: ' + TIER_NAMES[S.tier], 'ok');
      return;
    }
    renderTier();
    toast('Настройка не сохранилась' + (why ? ': ' + why : ''), 'error');
  }

  function initTier() {
    for (const b of $$('[data-tier]')) {
      b.addEventListener('click', () => {
        changeTier(b.dataset.tier);
      });
    }
  }

  // ── Рабочая папка, очистка разговора ──────────────────────────
  function renderWorkspace() {
    const p = $('#workspacePath');
    p.textContent = S.workspace || 'Ядро не сообщило путь';
    p.title = S.workspace || '';
    $('#workspaceOpen').disabled = !has('openWorkspace');
    renderFolders();
  }

  function renderFolders() {
    $('#folderAdd').disabled = !has('addFolder');
    $('#folderList').replaceChildren(...S.folders.map((dir) => el('div', { class: 'set-row' },
      el('span', { class: 'set-text' }, el('span', { class: 'set-name path-box mono', text: dir, title: dir })),
      el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Отключить', 'aria-label': 'Отключить ' + dir, onclick: () => changeFolders('removeFolder', dir) }))));
  }

  async function changeFolders(method, dir) {
    try {
      const r = await call(method, dir);
      if (!r || r.ok === false) throw new Error('ядро не приняло запрос');
      S.folders = Array.isArray(r.folders) ? r.folders.map(String) : S.folders;
      renderFolders();
    } catch (e) {
      toast('Папки не изменились: ' + errText(e), 'error');
    }
  }

  const clearArm = { on: false, timer: 0 };

  function disarmClear() {
    clearTimeout(clearArm.timer);
    clearArm.on = false;
    $('#chatClear').classList.remove('is-armed');
    $('#chatClearText').textContent = 'Очистить разговор';
  }

  async function clearChat() {
    if (!has('clearChat')) { toast('Очистка недоступна в этой версии ядра.', 'error'); return; }
    if (!clearArm.on) {
      clearArm.on = true;
      $('#chatClear').classList.add('is-armed');
      $('#chatClearText').textContent = 'Нажмите ещё раз';
      clearArm.timer = setTimeout(disarmClear, 4000);
      return;
    }
    disarmClear();
    if (tracker.busy) { toast('Разговор не очищен: Джарвис занят. Остановите ход и повторите.', 'error'); return; }
    try {
      const r = await call('clearChat');
      if (r && r.ok === false) throw new Error(r.error === 'busy' ? 'Джарвис занят' : (r.error || 'ядро не приняло запрос'));
      resetFeed();
      toast('Разговор очищен. Журнал остался.', 'ok');
    } catch (e) {
      toast('Разговор не очищен: ' + errText(e), 'error');
    }
  }

  async function refreshMail() {
    const state = await call('mailState');
    const available = Boolean(state && state.credentials);
    const connected = Boolean(state && state.connected);
    $('#mailStatus').textContent = !available ? 'Почта недоступна в этой сборке' : !connected ? 'Не подключена' : state.readable ? 'Подключена: отправка и чтение' : 'Подключена: только отправка';
    $('#mailRead').checked = Boolean(state && state.readable);
    $('#mailConnect').disabled = !available;
    $('#mailConnect').textContent = connected ? 'Обновить доступ' : 'Подключить';
    $('#mailDisconnectRow').hidden = !connected;
  }

  function initMailSettings() {
    if (!has('mailState') || !has('mailConnect') || !has('mailDisconnect')) return;
    $('#mailSettings').hidden = false;
    const connect = $('#mailConnect');
    const disconnect = $('#mailDisconnect');
    const toggle = $('#mailRead');
    const busy = (value) => { connect.disabled = value; disconnect.disabled = value; toggle.disabled = value; };
    refreshMail().catch(() => { $('#mailStatus').textContent = 'Не удалось проверить подключение'; connect.disabled = true; });
    connect.addEventListener('click', async () => {
      const read = toggle.checked;
      busy(true);
      $('#mailStatus').textContent = 'Завершите подключение в браузере';
      try {
        const result = await call('mailConnect', read);
        if (!result || !result.ok) throw new Error((result && result.error) || 'подключение не завершено');
        toast('Почта подключена', 'ok');
      } catch (err) { toast('Почта не подключена: ' + errText(err), 'error'); }
      finally {
        busy(false);
        await refreshMail().catch(() => { $('#mailStatus').textContent = 'Не удалось проверить подключение'; connect.disabled = true; });
      }
    });
    disconnect.addEventListener('click', async () => {
      busy(true);
      try {
        const result = await call('mailDisconnect');
        if (!result || !result.ok) throw new Error((result && result.error) || 'не удалось отключить почту');
        toast('Почта отключена на этом компьютере', 'ok');
      } catch (err) { toast('Почта не отключена: ' + errText(err), 'error'); }
      finally {
        busy(false);
        await refreshMail().catch(() => { $('#mailStatus').textContent = 'Не удалось проверить подключение'; connect.disabled = true; });
      }
    });
  }

  function initSettings() {
    initMailSettings();
    for (const r of $$('#modeOptions input[name="mode"]')) {
      r.addEventListener('change', () => { if (r.checked) changeMode(r.value); });
    }
    $('#brainRecheck').addEventListener('click', async () => {
      $('#brainState').dataset.ok = 'unknown';
      $('#brainStateText').textContent = 'Проверяю…';
      $('#brainModel').hidden = true;
      await loadState();
      toast(linkDown() ? 'Нет связи с ядром' : S.hasKey ? 'Модель подключена' : 'Ключа по-прежнему нет', S.hasKey && !linkDown() ? 'ok' : 'info');
    });
    $('#workspaceOpen').addEventListener('click', async () => {
      try {
        const r = await call('openWorkspace');
        if (r && r.ok === false) throw new Error(r.error || 'папка не открылась');
      } catch (e) {
        toast('Папка не открылась: ' + errText(e), 'error');
      }
    });
    $('#folderAdd').addEventListener('click', () => changeFolders('addFolder'));
    $('#chatClear').addEventListener('click', clearChat);
    $('#chatClear').addEventListener('dblclick', (e) => e.preventDefault());
  }

  // ── Журнал действий ──────────────────────────────
  function initCollectionViews() {
    const collections = [
      ['journal', '#journalPanel .filter-search', '#journalPanel'],
      ['commands', '#commands .nox-cmd-tools', '#commands'],
      ['connections', '#mcpPage .nox-conn-toolbar', '#mcpPage'],
    ];
    for (const [key, host, target] of collections) {
      const root = $(target);
      const toolbar = $(host);
      if (!root || !toolbar) continue;
      const pref = 'nox.collection.' + key;
      let mode = 'icons';
      try {
        const stored = localStorage.getItem(pref);
        if (stored === 'list' || stored === 'icons') mode = stored;
      } catch {}
      const group = el('div', { class: 'collection-view', role: 'group', 'aria-label': 'Вид раздела' });
      function select(value) {
        root.dataset.collectionView = value;
        for (const btn of group.children) btn.setAttribute('aria-pressed', String(btn.dataset.mode === value));
      }
      for (const [value, label] of [['icons', 'Крупные значки'], ['list', 'Список']]) {
        group.append(el('button', { type: 'button', dataset: { mode: value }, text: label, onclick: () => {
          select(value);
          try { localStorage.setItem(pref, value); } catch {}
        } }));
      }
      toolbar.append(group);
      select(mode);
    }
  }

  const journalStatus = { confirmed: 'Подтверждено', unverified: 'Не проверено', failed: 'Не получилось', refused: 'Отклонено' };
  const journalDay = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' });
  const journalTime = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
  const compactLinks = (text) => U.humanize(text).replace(/https?:\/\/[^\s<>]+/g, (url) => U.clip(url, 54));
  const H = { journal: [], loadError: '', filter: 'all', q: '' };

  function recordToEntry(r, i) {
    const rec = r && typeof r === 'object' ? r : {};
    return {
      key: 'j' + i,
      tool: rec.tool || rec.name || rec.kind || 'запись',
      args: rec.args,
      risk: typeof rec.risk === 'string' ? rec.risk : '',
      status: ({ done: 'unverified', error: 'failed' })[U.statusOfRecord(rec)] || U.statusOfRecord(rec),
      summary: U.cleanSummary(rec.summary),
      evidence: U.cleanSummary(rec.evidence),
      ts: U.toMs(rec.ts),
    };
  }

  async function reloadJournal() {
    if (!has('recentJournal')) {
      H.journal = [];
      H.loadError = 'Журнал недоступен в этой версии ядра.';
      renderJournal();
      return;
    }
    try {
      const recs = await call('recentJournal', JOURNAL_LIMIT);
      H.journal = (Array.isArray(recs) ? recs : []).map(recordToEntry).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      H.loadError = '';
    } catch (e) {
      H.loadError = 'Журнал не прочитан: ' + errText(e);
    }
    renderJournal();
  }

  function riskNode(risk) {
    const word = U.riskWord(risk);
    if (!word) return null;
    return el('span', { class: 'risk', 'data-risk': risk, title: 'Риск: ' + word, text: word });
  }

  function renderJournal() {
    const all = H.journal;
    const rows = all.filter((e) => {
      if (H.filter !== 'all' && e.status !== H.filter) return false;
      if (H.q) {
        const hay = (e.tool + ' ' + U.toolTitle(e.tool) + ' ' + U.argsBrief(e.args, 400) + ' ' + e.summary + ' ' + e.evidence).toLowerCase();
        if (!hay.includes(H.q)) return false;
      }
      return true;
    });
    $('#histCount').textContent = all.length ? `Показано ${rows.length} из ${all.length}` : '';
    const days = new Map();
    for (const e of rows) {
      const day = Number.isFinite(e.ts) && e.ts > 0 ? journalDay.format(e.ts) : 'Без даты';
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(el('li', { class: 'journal-entry', dataset: { status: e.status } },
        el('span', { class: 'journal-mark', 'aria-hidden': 'true' }, icon('file')),
        el('div', { class: 'journal-content' },
          el('div', { class: 'journal-entry-head' },
            el('strong', { text: U.toolTitle(e.tool) }),
            el('time', { text: day === 'Без даты' ? '—' : journalTime.format(e.ts) }),
            el('span', { class: 'journal-status', text: journalStatus[e.status] })),
          el('p', { text: e.summary ? compactLinks(e.summary) : 'Итог не записан.' }),
          e.evidence && e.evidence !== e.summary ? el('p', { class: 'journal-evidence', text: compactLinks(e.evidence) }) : null,
          e.args || e.risk ? el('details', { class: 'collection-details' },
            el('summary', { text: 'Подробнее' }),
            el('p', { text: [e.tool, U.argsBrief(e.args, 500)].filter(Boolean).join(' · ') }), riskNode(e.risk)) : null)));
    }
    $('#histBody').replaceChildren(...Array.from(days, ([day, entries]) => el('section', { class: 'journal-day' },
      el('h2', { text: day }), el('ul', {}, entries))));
    const empty = $('#histEmpty');
    empty.hidden = rows.length > 0;
    if (!rows.length) {
      $('#histEmptyText').textContent = H.loadError || (all.length ? 'Ничего не нашлось. Измените фильтр или запрос.' : 'Журнал пуст. Здесь появятся действия Джарвиса.');
    }
  }

  function initJournal() {
    const seg = $('#statusFilter');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      H.filter = b.dataset.value;
      for (const x of $$('.seg-btn', seg)) x.setAttribute('aria-pressed', String(x === b));
      renderJournal();
    });
    $('#histSearch').addEventListener('input', (e) => { H.q = e.target.value.trim().toLowerCase(); renderJournal(); });
    $('#histReload').addEventListener('click', async () => {
      await reloadJournal();
      toast('Журнал обновлён');
    });
  }

  // ── Подтверждения ─────────────────────────────────────────────
  // Ответ привязан к показу (R3-01): у каждого показа свой номер (view.seq) и токен ядра (approval:shown).
  // Кнопка отвечает только на id показа, при котором началось нажатие; смена показа гасит начатое нажатие.
  // Ушедший запрос не подменяется следующим в том же диалоге: нужен явный «Показать следующий».
  // sending — запросы, ответ на которые сейчас передаётся (R3-02: блокировка своя у каждого запроса).
  const APPROVAL_ARM_MS = 700; // «Разрешить» включается не раньше токена ядра и этой паузы — вторая линия защиты
  const A = { queue: [], sending: new Set(), view: null, viewSeq: 0, press: null, gate: false, countdownTimer: null, syncing: false, closedDuringSync: new Set() };

  // Обратный отсчёт до автоотмены: время приходит из ядра (autoCancelAt), окно только показывает.
  // Элемент строится из JS: разметку диалога в index.html не трогаем.
  function ensureApprovalCountdown() {
    let elc = $('#apCountdown');
    if (elc) return elc;
    const dlg = $('#approvalDialog');
    if (!dlg) return null;
    elc = document.createElement('p');
    elc.id = 'apCountdown';
    elc.hidden = true;
    elc.setAttribute('role', 'status');
    elc.style.cssText = 'margin:10px 0 0;font-size:var(--fs-xs);color:var(--text-3)';
    const actions = dlg.querySelector('.dialog-actions');
    const form = dlg.querySelector('form');
    if (actions && actions.parentNode) actions.parentNode.insertBefore(elc, actions);
    else if (form) form.appendChild(elc);
    else dlg.appendChild(elc);
    return elc;
  }

  function stopApprovalCountdown() {
    if (A.countdownTimer) { clearInterval(A.countdownTimer); A.countdownTimer = null; }
  }

  function startApprovalCountdown(cur) {
    stopApprovalCountdown();
    const elc = ensureApprovalCountdown();
    if (!elc) return;
    const at = Number(cur && cur.autoCancelAt);
    if (!Number.isFinite(at) || at <= 0) { elc.hidden = true; return; }
    const tick = () => {
      const left = Math.max(0, Math.ceil((at - Date.now()) / 1000));
      if (left <= 0) {
        elc.textContent = 'Время вышло — действие отменяется…';
        elc.style.color = 'var(--err)';
        return;
      }
      elc.textContent = 'Без ответа отменится через ' + left + ' ' + U.plural(left, ['секунду', 'секунды', 'секунд']);
      elc.style.color = left <= 10 ? 'var(--warn)' : 'var(--text-3)';
    };
    elc.hidden = false;
    tick();
    A.countdownTimer = setInterval(tick, 250);
  }

  // Строки предпросмотра изменений: плюсы и минусы разного цвета, служебные строки патча приглушены.
  function renderDiff(pre, text) {
    pre.textContent = '';
    for (const line of String(text).split('\n')) {
      const row = document.createElement('span');
      row.className = 'ap-diff-line';
      if (line.startsWith('+++') || line.startsWith('---')) row.classList.add('ap-diff-head');
      else if (line.startsWith('@@')) row.classList.add('ap-diff-hunk');
      else if (line.startsWith('+')) row.classList.add('ap-diff-add');
      else if (line.startsWith('-')) row.classList.add('ap-diff-del');
      row.textContent = line + '\n';
      pre.appendChild(row);
    }
  }

  function approvalPush(ev) {
    if (!ev.id || A.queue.some((q) => q.id === ev.id)) return;
    A.queue.push(ev);
    updatePending();
    // Диалог сам открывается только из закрытого состояния; открытый показ новым запросом не подменяется.
    if (!$('#approvalDialog').open) showApprovalView(A.queue[0].id);
    else refreshApproval();
  }

  function approvalDrop(id) {
    const i = A.queue.findIndex((q) => q.id === id);
    if (i < 0) return;
    A.queue.splice(i, 1);
    updatePending();
    refreshApproval();
  }

  function approvalClear() {
    A.queue.length = 0;
    updatePending();
    refreshApproval();
  }

  // Конец хода чата: его подтверждения уже решены или отменены. Запросы исполнителя задач (T.approvals)
  // с ходом чата не связаны и ждут владельца дальше — их не убираем.
  function approvalClearChat(runId) {
    if (!runId) return;
    const keep = A.queue.filter((q) => q.runId !== runId || T.approvals.has(q.id));
    if (keep.length === A.queue.length) return;
    A.queue.splice(0, A.queue.length, ...keep);
    updatePending();
    refreshApproval();
  }

  // Явное открытие запроса владельцем («Решить», «Показать следующий»).
  function openApproval(id) {
    const i = A.queue.findIndex((q) => q.id === id);
    if (i < 0) { toast('Запрос уже неактуален.'); return; }
    A.queue.unshift(A.queue.splice(i, 1)[0]);
    showApprovalView(id);
  }

  function updatePending() {
    const n = A.queue.length;
    const badge = $('#pendingCount');
    badge.hidden = n === 0;
    badge.textContent = String(n);
    const nav = $('[data-nav="nox"]');
    if (nav) nav.setAttribute('aria-label', n ? 'Чат, ждут вас: ' + n : 'Чат');
    renderWaitTray();
  }

  // Ответ на конкретный запрос из списка (не только на первый в очереди).
  async function answerById(id, decision) {
    const cur = A.queue.find((q) => q.id === id);
    if (!cur) return;
    let ok = false;
    let why = '';
    try {
      const r = await Promise.race([
        call('respondApproval', id, decision),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ответ ядра не получен за 5 секунд')), 5000)),
      ]);
      ok = !(r && r.ok === false);
      why = r && typeof r.reason === 'string' ? r.reason : '';
    } catch (err) { why = errText(err); ok = false; }
    if (!ok) { toast(why ? 'Не удалось передать ответ: ' + why : 'Не удалось передать ответ.', 'error'); return; }
    if (decision === 'reject') {
      tracker.markRejected(cur.callId || cur.id);
      C.rejected.add(cur.callId || cur.id);
    }
    approvalDrop(id);
  }

  // Вопрос окна: «Запуск программы: notepad?»; без понятного названия — «Выполнить: …?».
  function approvalQuestion(cur) {
    const brief = U.argsBrief(cur.args, 120);
    return U.toolTitle(cur.name) + (brief ? ': ' + brief : '') + '?';
  }

  // Кнопка «Показать следующий» строится из JS: разметку диалога не трогаем.
  function ensureApprovalNext() {
    let b = $('#apNext');
    if (b) return b;
    const actions = $('#approvalDialog .dialog-actions');
    b = document.createElement('button');
    b.id = 'apNext';
    b.type = 'button';
    b.className = 'btn btn-primary';
    b.hidden = true;
    b.textContent = 'Показать следующий';
    b.addEventListener('click', () => { if (A.gate && A.queue.length) openApproval(A.queue[0].id); });
    actions.appendChild(b);
    return b;
  }

  function setApprovalGateMode(on) {
    const dlg = $('#approvalDialog');
    for (const b of $$('[data-decision]', dlg)) b.hidden = on;
    $('#apMeta').hidden = on;
    $('#apDetails').hidden = on;
    if (on) $('#apPreview').hidden = true;
    ensureApprovalNext().hidden = !on;
  }

  function renderApprovalCount() {
    const n = A.queue.length;
    const count = $('#apQueue');
    count.hidden = A.gate || n < 2;
    count.textContent = '1 из ' + n;
  }

  // Кнопки показа: отказ доступен сразу, «Разрешить» и «На сессию» — только после токена ядра и паузы.
  function renderApprovalButtons() {
    const v = A.view;
    const sending = !v || A.sending.has(v.id);
    for (const b of $$('#approvalDialog [data-decision]')) {
      b.disabled = sending || (b.dataset.decision !== 'reject' && !v.armed);
    }
  }

  function gateText() {
    return 'Этот запрос больше не ждёт решения. Ждут ещё: ' + A.queue.length + '.';
  }

  // Показанный запрос ушёл (ответ, автоотмена, отмена ядром). Начатое нажатие гаснет, кнопок решения нет:
  // следующий запрос владелец открывает сам, иначе клик, нацеленный на ушедший, попал бы в чужой (R3-01).
  function showApprovalGate() {
    const dlg = $('#approvalDialog');
    A.viewSeq++;
    A.view = null;
    A.press = null;
    A.gate = true;
    stopApprovalCountdown();
    const elc = $('#apCountdown');
    if (elc) elc.hidden = true;
    delete dlg.dataset.current;
    setApprovalGateMode(true);
    $('#apQuestion').textContent = gateText();
    renderApprovalCount();
    ensureApprovalNext().focus();
  }

  // Обновление без смены показа: счётчик и кнопки. Ушедший показ — в «закрыт», пустая очередь — закрыть.
  function refreshApproval() {
    const dlg = $('#approvalDialog');
    if (!dlg.open) return;
    if (!A.queue.length) { dlg.close(); return; }
    if (A.view && !A.queue.some((q) => q.id === A.view.id)) { showApprovalGate(); return; }
    if (A.gate) $('#apQuestion').textContent = gateText();
    renderApprovalCount();
    renderApprovalButtons();
  }

  // Новый показ запроса id: новый номер показа, прежнее нажатие и токен недействительны.
  function showApprovalView(id) {
    const dlg = $('#approvalDialog');
    const cur = A.queue.find((q) => q.id === id);
    if (!cur) { refreshApproval(); return; }
    const seq = ++A.viewSeq;
    A.view = { id: cur.id, seq, token: null, armed: false };
    A.press = null;
    A.gate = false;
    dlg.dataset.current = String(cur.id);
    setApprovalGateMode(false);
    $('#apQuestion').textContent = approvalQuestion(cur);
    $('#apTool').textContent = U.toolTitle(cur.name);
    const risk = $('#apRisk');
    const riskText = U.riskWord(cur.risk);
    risk.textContent = riskText;
    risk.dataset.risk = cur.risk || '';
    risk.title = riskText ? 'Риск: ' + riskText : '';
    risk.hidden = !riskText;
    const reason = $('#apReason');
    reason.textContent = cur.reason ? U.scrub(cur.reason) : '';
    reason.hidden = !cur.reason;
    $('#apArgs').textContent = U.argsPretty(cur.args);
    // Предпросмотр изменений файла: показываем до кнопок, чтобы владелец видел, что именно перезапишется.
    const preview = cur.preview && typeof cur.preview.diff === 'string' && cur.preview.diff ? cur.preview : null;
    const previewBox = $('#apPreview');
    if (previewBox) {
      previewBox.hidden = !preview;
      const diffEl = $('#apDiff');
      const title = $('#apPreviewTitle');
      if (preview) {
        const stats = [];
        if (preview.additions) stats.push('+' + preview.additions);
        if (preview.deletions) stats.push('−' + preview.deletions);
        const name = preview.path ? ' ' + preview.path : '';
        const what = preview.created ? 'Новый файл' : 'Изменится файл';
        title.textContent = what + name + (stats.length ? ' (' + stats.join(', ') + ')' : '')
          + (preview.truncated ? ' — показано не всё' : '');
        renderDiff(diffEl, preview.diff);
      } else {
        diffEl.textContent = '';
        title.textContent = '';
      }
    }
    // Автоотмена: честно показываем, сколько осталось до отказа (30 с задаёт ядро).
    startApprovalCountdown(cur);
    $('#apDetails').open = false;
    // Отправка, публикация и удаление: «На сессию» не предлагаем (см. loop.js, allowSession).
    $('#apSession').hidden = cur.allowSession === false;
    renderApprovalCount();
    renderApprovalButtons();
    if (!dlg.open) {
      const back = document.activeElement;
      A.returnFocus = back && back !== document.body ? back : null;
      try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
    }
    $('[data-decision="reject"]', dlg).focus();
    armApproval(seq);
  }

  // Ядро запоминает показ и выдаёт токен; без токена «Разрешить» остаётся выключенным.
  async function armApproval(seq) {
    const id = A.view && A.view.id;
    if (!id) return;
    const pause = new Promise((resolve) => setTimeout(resolve, APPROVAL_ARM_MS));
    let token = null;
    try {
      const r = await call('markApprovalShown', id);
      token = r && r.ok === true && typeof r.token === 'string' ? r.token : null;
    } catch { token = null; }
    await pause;
    if (!A.view || A.view.seq !== seq || !token) return;
    A.view.token = token;
    A.view.armed = true;
    renderApprovalButtons();
  }

  async function answerApproval(decision, seq) {
    const v = A.view;
    if (!v || v.seq !== seq || A.sending.has(v.id)) return;
    if (decision !== 'reject' && !v.armed) return;
    const id = v.id;
    const cur = A.queue.find((q) => q.id === id);
    if (!cur) return;
    A.sending.add(id);
    renderApprovalButtons();
    let ok = false;
    let why = '';
    try {
      const r = await Promise.race([
        call('respondApproval', id, decision, v.token),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ответ ядра не получен за 5 секунд')), 5000)),
      ]);
      ok = !(r && r.ok === false);
      why = r && typeof r.reason === 'string' ? r.reason : '';
    } catch (err) { why = errText(err); ok = false; }
    A.sending.delete(id);
    if (!ok) {
      toast(why ? 'Не удалось передать решение: ' + why : 'Не удалось передать решение. Запрос остался в ожидании.', 'error');
      refreshApproval();
      // Событие о закрытии могло потеряться: сверяем с ядром и убираем снятый запрос (R3-03).
      try {
        const live = await call('listApprovals');
        if (Array.isArray(live) && !live.some((e) => e.id === id)) approvalDrop(id);
      } catch { /* ядро не ответило: карточка остаётся */ }
      return;
    }
    if (decision === 'reject') {
      tracker.markRejected(cur.callId || cur.id);
      C.rejected.add(cur.callId || cur.id);
    }
    approvalDrop(id);
  }

  function initApproval() {
    const dlg = $('#approvalDialog');
    ensureApprovalNext();
    // Нажатие засчитывается показу, при котором оно началось (мышь — pointerdown, клавиатура — первый keydown).
    // Клик без начала (экранный диктор) принимается, только если он доверенный и без мыши (detail 0).
    for (const b of $$('[data-decision]', dlg)) {
      const decision = b.dataset.decision;
      b.addEventListener('pointerdown', () => { A.press = A.view && !b.disabled ? { seq: A.view.seq, decision } : null; });
      b.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) A.press = A.view && !b.disabled ? { seq: A.view.seq, decision } : null;
      });
      b.addEventListener('click', (e) => {
        const p = A.press;
        A.press = null;
        if (!A.view) return;
        if (p) {
          if (p.seq !== A.view.seq || p.decision !== decision) return;
        } else if (!e.isTrusted || e.detail !== 0) return;
        answerApproval(decision, A.view.seq);
      });
    }
    // Esc в окне подтверждения = отказ показанному запросу; в «закрыт» — просто закрыть диалог.
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (A.view) answerApproval('reject', A.view.seq);
      else dlg.close();
    });
    // После закрытия фокус возвращается туда, где был.
    dlg.addEventListener('close', () => {
      // Сам код закрывает диалог только без показанного запроса. Если показ ещё жив, диалог закрыл браузер:
      // Esc без недавнего действия пользователя приходит без события cancel. Это тоже «Отклонить».
      const dismissed = A.view && !A.sending.has(A.view.id) && A.queue.some((q) => q.id === A.view.id) ? A.view.id : null;
      stopApprovalCountdown();
      delete dlg.dataset.current;
      A.viewSeq++;
      A.view = null;
      A.press = null;
      A.gate = false;
      setApprovalGateMode(false);
      if (dismissed) answerById(dismissed, 'reject');
      const back = A.returnFocus;
      A.returnFocus = null;
      if (back && back.isConnected && !back.disabled) back.focus();
      else if ((S.view === 'nox' || S.view === 'dialog') && !$('#chatInput').disabled) $('#chatInput').focus();
    });
  }

  // Общий вопрос «да/нет» (без системных confirm()).
  function ask(title, text, yes = 'Да', no = 'Отмена') {
    const dlg = $('#confirmDialog');
    $('#cfTitle').textContent = title;
    $('#cfText').textContent = text;
    $('#cfYes').textContent = yes;
    $('#cfNo').textContent = no;
    const back = document.activeElement;
    return new Promise((resolve) => {
      const done = (v) => {
        $('#cfYes').onclick = null;
        $('#cfNo').onclick = null;
        dlg.oncancel = null;
        if (dlg.open) dlg.close();
        if (back && back !== document.body && back.isConnected) back.focus();
        resolve(v);
      };
      $('#cfYes').onclick = () => done(true);
      $('#cfNo').onclick = () => done(false);
      dlg.oncancel = (e) => { e.preventDefault(); done(false); };
      try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
      $('#cfNo').focus();
    });
  }

  // ── Безопасный Markdown ───────────────────────────────────────
  // **жирный**, `код`, ```блоки```, списки, абзацы, заголовки как жирные строки.
  // HTML не разбирается: весь текст уходит в textContent.
  function renderMarkdown(src) {
    const frag = document.createDocumentFragment();
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let para = [];
    let list = null;
    let lastLi = null;
    const flush = () => {
      if (!para.length) return;
      const p = document.createElement('p');
      appendInline(p, para.join('\n'));
      frag.append(p);
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush(); list = null;
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        const code = document.createElement('code');
        code.textContent = buf.join('\n');
        const pre = document.createElement('pre');
        pre.append(code);
        frag.append(pre);
        continue;
      }
      if (!line.trim()) { flush(); list = null; continue; }
      // Формула на нескольких строках: $$ … $$ собирается в одну.
      if (/^\s*\$\$\s*$/.test(line)) {
        const end = lines.findIndex((l, k) => k > i && /^\s*\$\$\s*$/.test(l));
        if (end > i) {
          flush(); list = null;
          const p = document.createElement('p');
          appendInline(p, '$$' + lines.slice(i + 1, end).join(' ') + '$$');
          frag.append(p);
          i = end;
          continue;
        }
      }
      const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
      const ol = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flush();
        const type = ul ? 'ul' : 'ol';
        if (!list || list.type !== type) {
          const L = document.createElement(type);
          if (ol && ol[1] !== '1') L.start = Number(ol[1]);
          frag.append(L);
          list = { type, el: L };
        }
        lastLi = document.createElement('li');
        appendInline(lastLi, ul ? ul[1] : ol[2]);
        list.el.append(lastLi);
        continue;
      }
      if (list && lastLi && /^\s{2,}\S/.test(line)) {
        lastLi.append(document.createTextNode(' '));
        appendInline(lastLi, line.trim());
        continue;
      }
      list = null;
      const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (h) {
        flush();
        const p = document.createElement('p');
        const strong = document.createElement('strong');
        appendInline(strong, h[1]);
        p.append(strong);
        frag.append(p);
        continue;
      }
      para.push(line);
    }
    flush();
    return frag;
  }

  function appendInline(parent, text) {
    for (const part of String(text).split(/(`[^`\n]+`)/)) {
      if (!part) continue;
      if (part.length > 2 && part[0] === '`' && part[part.length - 1] === '`') {
        const c = document.createElement('code');
        c.textContent = part.slice(1, -1);
        parent.append(c);
      } else {
        appendMath(parent, part);
      }
    }
  }

  // Формулы: $$…$$ и \[…\] — отдельной строкой, $…$ и \(…\) — внутри текста. Одиночный $…$ считается формулой,
  // только если внутри есть признак математики (\ ^ _ =): суммы в долларах остаются текстом.
  const MATH_RE = /(\$\$[^$]+\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?=\S)[^$\n]*[\\^_=][^$\n]*\$)/;
  function appendMath(parent, text) {
    if (!window.NoxMath || !/[$\\]/.test(text)) { appendBold(parent, text); return; }
    String(text).split(MATH_RE).forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 0) { appendBold(parent, part); return; }
      const block = part.startsWith('$$') || part.startsWith('\\[');
      const cut = part.startsWith('$$') || part.startsWith('\\') ? 2 : 1;
      parent.append(window.NoxMath.render(part.slice(cut, -cut), block));
    });
  }

  function appendBold(parent, text) {
    const re = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
    let at = 0;
    let m;
    while ((m = re.exec(text))) {
      appendText(parent, text.slice(at, m.index));
      const b = document.createElement('strong');
      appendText(b, m[1]);
      parent.append(b);
      at = m.index + m[0].length;
    }
    appendText(parent, text.slice(at));
  }

  function appendText(parent, t) {
    t.split('\n').forEach((s, i) => {
      if (i) parent.append(document.createElement('br'));
      if (s) parent.append(document.createTextNode(s));
    });
  }

  // ── Диалог ────────────────────────────────────────────────────
  const HISTORY_PAGE = 100;
  const C = {
    turn: null, textEl: null, buf: '', raf: 0, stick: true,
    act: null,           // строка действий текущего хода: { node, sum, list, items: Map id → { entry, li } }
    thinking: null,      // индикатор «Думаю»
    turnText: false,     // в ходе был текст ответа (для «Ответ готов»)
    rejected: new Set(),
    files: [],           // [{ name, path, size }]
    lastSent: '',        // последнее отправленное поручение — для «Повторить»
    older: [],           // ранние реплики истории, ещё не показанные
  };

  function feedEmpty() {
    return $('#feedList').childElementCount === 0;
  }

  function updateEmpty() {
    $('#chatEmpty').hidden = !feedEmpty();
    renderComposerState();
  }

  function nearBottom() {
    const f = $('#feed');
    return f.scrollHeight - f.scrollTop - f.clientHeight < 140;
  }

  function scrollFeed(force) {
    const f = $('#feed');
    if (force || C.stick) {
      f.scrollTop = f.scrollHeight;
      $('#toBottom').hidden = true;
    } else {
      $('#toBottom').hidden = false;
    }
  }

  function appendToFeed(node) {
    C.stick = nearBottom();
    $('#feedList').append(node);
    updateEmpty();
    scrollFeed();
  }

  function resetFeed() {
    endTurn();
    T.cards.clear();
    C.lastSent = '';
    $('#chain').replaceChildren();
    if (orb && orb.setSteps) orb.setSteps([]);
    $('#said').textContent = '';
    $('#said').hidden = true;
    C.older = [];
    $('#feedMore').hidden = true;
    $('#feedList').replaceChildren();
    updateEmpty();
  }

  // Ход ассистента: без метки «Джарвис» — ответ отличается положением слева.
  function ensureTurn() {
    if (!C.turn) {
      C.turn = el('div', { class: 'turn' });
      appendToFeed(C.turn);
    }
    return C.turn;
  }

  // Строка действий хода всегда последняя в ходе: новые части ответа встают перед ней.
  function addToTurn(node) {
    C.stick = nearBottom();
    const turn = ensureTurn();
    if (C.act && C.act.node.parentNode === turn) turn.insertBefore(node, C.act.node);
    else turn.append(node);
    scrollFeed();
  }

  function showThinking() {
    hideThinking();
    C.thinking = el('div', { class: 'thinking' },
      el('span', { class: 'dots', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')),
      el('span', { text: 'Думаю…' }));
    addToTurn(C.thinking);
  }

  function hideThinking() {
    if (!C.thinking) return;
    C.thinking.remove();
    C.thinking = null;
    if (C.turn && !C.turn.childElementCount) {
      C.turn.remove();
      C.turn = null;
      updateEmpty();
    }
  }

  function chatText(delta) {
    hideThinking();
    if (!C.textEl) {
      C.textEl = el('div', { class: 'md is-streaming' });
      C.buf = '';
      addToTurn(C.textEl);
    }
    C.turnText = true;
    C.buf += String(delta ?? '');
    if (!C.raf) C.raf = requestAnimationFrame(flushText);
  }

  function flushText() {
    if (C.raf) cancelAnimationFrame(C.raf);
    C.raf = 0;
    if (!C.textEl) return;
    C.stick = nearBottom();
    // Пока текст идёт, незакрытый «**» в конце не показываем звёздочками.
    let src = C.buf;
    if (C.textEl.classList.contains('is-streaming') && (src.match(/\*\*/g) || []).length % 2) {
      const at = src.lastIndexOf('**');
      src = src.slice(0, at) + src.slice(at + 2);
    }
    C.textEl.replaceChildren(renderMarkdown(U.humanize(src)));
    scrollFeed();
  }

  function endText() {
    if (!C.textEl) return;
    flushText();
    C.textEl.classList.remove('is-streaming');
    C.textEl = null;
    C.buf = '';
  }

  function endTurn() {
    hideThinking();
    endText();
    if (C.act) renderActs();
    // Действие могло не успеть остановиться: его поздний итог (afterStop) допишется в эту же строку.
    // Строки помним по id «ход:шаг»: поздний итог может прийти уже после следующих ходов.
    if (C.act) {
      if (!C.lateRows) C.lateRows = new Map();
      for (const [id, rec] of C.act.items) C.lateRows.set(id, { rec, acts: C.act });
      while (C.lateRows.size > 50) C.lateRows.delete(C.lateRows.keys().next().value);
    }
    C.act = null;
    C.turn = null;
    C.turnText = false;
  }

  // ── Строка действий хода ──────────────────────────────────────
  // Свёрнута: обычные действия — итогом, поиск — маленькой кнопкой «Источники». Раскрытие только по клику.
  function ensureActs() {
    if (C.act) return C.act;
    const sum = el('summary', { class: 'acts-sum' });
    const list = el('ol', { class: 'acts-list' });
    const progress = el('progress', { class: 'acts-progress', 'aria-label': 'Завершённые действия' });
    const node = el('details', { class: 'turn-acts', open: false }, sum, progress, el('div', { class: 'acts-body' }, list));
    // В чате главное — ответ. Шаги видны под шаром и в Журнале, здесь одна строка, раскрывается по клику.
    C.act = { node, sum, list, items: new Map() };
    ensureTurn().append(node);
    return C.act;
  }

  const actWord = (n) => U.plural(n, ['действие', 'действия', 'действий']);

  function actLabel(e) {
    const brief = U.argsBrief(e.args, 60);
    return U.toolTitle(e.tool) + (brief ? ': ' + brief : '');
  }

  function searchingLabel() {
    return el('span', { class: 'search-status', role: 'status', 'aria-label': 'Ищу' },
      el('span', { class: 'search-word', 'aria-hidden': 'true', text: 'Ищу' }),
      el('span', { class: 'search-dots', 'aria-hidden': 'true' },
        el('span', { text: '.' }), el('span', { text: '.' }), el('span', { text: '.' })));
  }

  function sourceRows(sources, searches) {
    if (!sources.length) {
      const running = searches.some((e) => e.status === 'running');
      const failed = searches.find((e) => e.status === 'error' || e.status === 'failed');
      return [el('li', { class: 'research-empty', text: running ? 'Источники появятся после поиска.'
        : failed ? U.clip(U.cleanSummary(failed.summary) || 'Не удалось получить источники.', 180) : 'Источники не найдены.' })];
    }
    return sources.map((source, index) => el('li', { class: 'research-source' },
      el('button', {
        class: 'research-source-link', type: 'button', title: source.url,
        'aria-label': `Открыть источник: ${source.title}`,
        onclick: async () => {
          const res = await call('openSource', source.url).catch(() => null);
          if (!res || res.ok === false) toast((res && res.error) || 'Не удалось открыть источник.', 'error');
        },
      },
      el('span', { class: 'research-source-index', 'aria-hidden': 'true', text: String(index + 1) }),
      el('span', { class: 'research-source-copy' },
        el('span', { class: 'research-source-title', text: source.title }),
        el('span', { class: 'research-source-host', text: source.host })),
      source.status === 'unavailable' ? el('span', { class: 'research-source-state', text: 'недоступен' }) : null)));
  }

  // Поиск не показывает внутренние шаги и тексты страниц: в ленте только статус и настоящие ссылки.
  function renderResearchActs(act, items, searches) {
    const pending = items.find((e) => e.status === 'pending');
    const running = items.find((e) => e.status === 'running');
    const searching = searches.some((e) => e.status === 'running');
    const sources = [];
    const seen = new Set();
    for (const entry of searches) {
      for (const source of Array.isArray(entry.sources) ? entry.sources : []) {
        if (!source || typeof source.url !== 'string' || seen.has(source.url)) continue;
        let url;
        try { url = new URL(source.url); } catch { continue; }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        seen.add(source.url);
        sources.push({
          title: String(source.title || source.host || url.hostname).slice(0, 300),
          url: source.url.slice(0, 2048), host: String(source.host || url.hostname).slice(0, 255),
          ...(source.status === 'unavailable' ? { status: 'unavailable' } : {}),
        });
      }
    }
    const failed = items.some((e) => e.status === 'error' || e.status === 'failed');
    const unverified = items.some((e) => e.status === 'unverified');
    const refused = items.some((e) => e.status === 'refused');
    const tone = pending ? 'pending' : running ? 'running' : failed ? 'error' : unverified ? 'unverified' : refused ? 'refused' : 'done';
    const label = pending ? actLabel(pending) + ' · ждёт решения'
      : running && !searching ? actLabel(running)
        : sources.length ? `Источники · ${sources.length}` : failed ? 'Поиск не удался' : 'Поиск завершён';
    act.node.classList.add('is-research');
    act.node.dataset.tone = tone;
    act.sum.title = sources.length ? 'Показать источники' : 'Показать результат поиска';
    act.node.querySelector('progress').hidden = true;
    act.list.className = 'acts-list research-sources';
    act.list.replaceChildren(...sourceRows(sources, searches));
    fill(act.sum,
      el('span', { class: 'acts-icon' }, icon(pending ? 'hourglass' : searching ? 'search' : sources.length ? 'book' : failed ? 'help' : 'search')),
      searching && !pending ? searchingLabel() : el('span', { class: 'acts-text', text: label }),
      el('span', { class: 'acts-chev', 'data-icon': 'chevron', 'aria-hidden': 'true' }));
    U.fillIcons(act.sum);
  }

  function isSourceSearch(e) {
    return /^web_(?:search|wiki|fetch|research)$/.test(String(e.tool || ''))
      || (U.isSearchTool(e.tool, e.args) && Array.isArray(e.sources));
  }

  function renderActs(act = C.act) {
    if (!act) return;
    const items = [...act.items.values()].map((x) => x.entry);
    const searches = items.filter(isSourceSearch);
    if (searches.length) { renderResearchActs(act, items, searches); return; }
    act.node.classList.remove('is-research');
    const pending = items.find((e) => e.status === 'pending');
    const running = items.find((e) => e.status === 'running');
    let tone;
    let ic;
    let text;
    let verdict = null;
    if (pending) {
      tone = 'pending'; ic = 'hourglass'; text = actLabel(pending) + ' · ждёт решения';
    } else if (running) {
      tone = 'running'; ic = 'spinner'; text = actLabel(running);
    } else {
      const n = items.length;
      const err = items.filter((e) => e.status === 'error' || e.status === 'failed').length;
      const ref = items.filter((e) => e.status === 'refused').length;
      const unv = items.filter((e) => e.status === 'unverified').length;
      tone = err ? 'error' : unv ? 'unverified' : ref ? 'refused' : 'done';
      ic = err ? 'help' : unv ? 'help' : ref ? 'ban' : 'check';
      // Итог хода видно сразу: у каждого исхода своя форма значка и слово, не только цвет.
      const ok = items.filter((e) => e.status === 'confirmed').length;
      const done = items.filter((e) => e.status === 'done').length;
      const seg = (status, count, word) => count ? el('span', { class: 'verdict', 'data-status': status },
        el('span', { class: 'status-glyph', 'aria-hidden': 'true' }, U.glyph(U.STATUS_GLYPH[status])), el('b', { text: String(count) }), ' ' + word) : null;
      verdict = el('span', { class: 'acts-verdict' },
        el('span', { class: 'acts-count', text: `${n} ${actWord(n)}` }),
        // Сначала то, что требует внимания владельца.
        seg('failed', err, 'не получилось'),
        seg('unverified', unv, 'не проверено'),
        seg('confirmed', ok, 'подтверждено'),
        seg('done', done, 'без проверки'),
        seg('refused', ref, 'отклонено'));
    }
    act.node.dataset.tone = tone;
    const progress = act.node.querySelector('progress');
    // Общее число будущих шагов ядро не сообщает: только наблюдаемые действия.
    if (pending || running) { progress.removeAttribute('value'); }
    else { progress.max = Math.max(1, items.length); progress.value = items.length; }
    progress.hidden = !pending && !running && items.some((e) => e.status !== 'confirmed');
    fill(act.sum,
      verdict ? null : el('span', { class: 'acts-icon' }, icon(ic)),
      verdict || el('span', { class: 'acts-text', text }),
      el('span', { class: 'acts-chev', 'data-icon': 'chevron', 'aria-hidden': 'true' }));
    U.fillIcons(act.sum);
  }

  function fillActRow(li, e) {
    li.dataset.status = e.status;
    const brief = U.argsBrief(e.args, 120);
    const base = e.status === 'running' || e.status === 'pending' ? '' : U.cleanSummary(e.summary);
    // Чем подтверждено — видно прямо в строке; у «не проверено» и «провалено» причина уже в итоге.
    const sum = e.status === 'confirmed' && e.evidence ? `${base} · ${U.cleanSummary(e.evidence)}` : base;
    const showSum = sum && !(e.status === 'refused' && /^(отклонено|отказано)$/i.test(sum));
    fill(li,
      U.statusBadge(e.status),
      el('span', { class: 'act-name', text: U.toolTitle(e.tool) }),
      brief ? el('span', { class: 'act-args', title: U.argsBrief(e.args, 1000), text: brief }) : null,
      showSum ? el('span', { class: 'act-sum', title: sum, text: U.clip(sum, 160) }) : null,
      e.status === 'pending' ? el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Решить', onclick: () => openApproval(e.approvalId || e.id) }) : null);
  }

  // Цепочка шагов текущего поручения под шаром: шаг за шагом, у каждого значок проверки.
  function renderChain() {
    const items = C.act ? [...C.act.items.values()].map((x) => x.entry).filter((e) => !isSourceSearch(e)).slice(-5) : [];
    if (orb && orb.setSteps) orb.setSteps(items.map((e) => e.status));
    $('#chain').replaceChildren(...items.map((e) => el('li', { 'data-status': e.status, title: U.toolTitle(e.tool) },
      el('span', { class: 'chain-node', 'aria-hidden': 'true' }, U.glyph(U.STATUS_GLYPH[e.status] || '○')),
      el('span', { class: 'chain-name', text: U.toolTitle(e.tool) }))));
  }

  // Служебный вызов (quiet): его строка не попадает в карточку действий, пустую карточку убираем.
  function dropActRow(id, rec) {
    rec.li.remove();
    C.act.items.delete(id);
    if (C.act.items.size) renderActs();
    else { C.act.node.remove(); C.act = null; }
  }

  function chatTool(ev) {
    hideThinking();
    // У запроса разрешения свой одноразовый id; строка действия связана через callId.
    const actionId = ev.runId && Number.isInteger(ev.step)
      ? `${ev.runId}:${ev.step}`
      : (ev.type === 'approval_request' && ev.callId ? ev.callId : ev.id);
    // Итог действия, завершившегося после остановки хода, относится к строкам уже закрытого хода.
    const late = ev.type === 'tool_result' && ev.afterStop === true && !(C.act && C.act.items.has(actionId));
    const kept = late && C.lateRows ? C.lateRows.get(actionId) : null;
    const acts = late ? (kept && kept.acts) : C.act;
    let rec = late ? (kept && kept.rec) : (acts && acts.items.get(actionId));
    if (late) {
      if (!rec) return;
      rec.entry.summary = ev.summary;
      rec.entry.evidence = ev.evidence;
      rec.entry.sources = ev.sources;
      rec.entry.status = ev.hung === true ? 'unverified' : U.statusOfResult(ev.ok, ev.summary, false, ev.verified); // не ответило: исход неизвестен, а не «ошибка»
      fillActRow(rec.li, rec.entry);
      renderActs(acts);
      return;
    }
    if (ev.type === 'tool_result' && ev.quiet) {
      if (rec) dropActRow(actionId, rec);
      return;
    }
    if (!rec) {
      if (ev.type === 'tool_result') return;
      const act = ensureActs();
      rec = { li: el('li', { class: 'act-row' }), entry: { id: actionId, tool: ev.name, args: ev.args, status: 'running', summary: '' } };
      act.items.set(actionId, rec);
      if (!act.node.classList.contains('is-research')) act.list.append(rec.li);
    }
    const e = rec.entry;
    if (ev.type === 'approval_request') { e.status = 'pending'; e.approvalId = ev.id; }
    else if (ev.type === 'tool_start') e.status = 'running';
    else if (ev.type === 'tool_result') {
      e.summary = ev.summary;
      e.evidence = ev.evidence;
      e.sources = ev.sources;
      e.status = U.statusOfResult(ev.ok, ev.summary, C.rejected.has(actionId), ev.verified);
    }
    fillActRow(rec.li, e);
    renderActs();
    renderChain();
  }

  // Блок ошибки хода: что случилось и что делать; «Повторить» — если известно поручение.
  const BUDGET_RE = /Вызов модели не сделан/;
  const STOP_RE = /аварийный стоп/i;

  function chatError(message, opts = {}) {
    hideThinking();
    endText();
    const raw = U.scrub(message || '').trim();
    let text;
    let retry = Boolean(C.lastSent) && opts.retry !== false;
    if (BUDGET_RE.test(raw)) {
      S.budget = today();
      renderBanner();
      text = 'Дневной лимит модели исчерпан. Команды и быстрые действия работают.';
      retry = false;
    } else {
      text = (opts.prefix || 'Не получилось: ') + (raw || 'причина неизвестна');
      if (!/[.!?…]$/.test(text)) text += '.';
      // В ходе уже были действия: «Повторить» запустило бы их заново (ZM-005).
      if (retry && C.act && C.act.items.size > 0) {
        retry = false;
        text += ' Часть действий уже выполнялась, поэтому повтора кнопкой нет: проверьте результат и напишите, что продолжить.';
      }
    }
    const again = C.lastSent;
    addToTurn(el('div', { class: 'err-block', role: 'alert' },
      el('span', { class: 'err-icon' }, icon('alert')),
      el('span', { class: 'err-text', text }),
      retry ? el('button', {
        class: 'btn btn-secondary btn-sm', type: 'button', text: 'Повторить',
        onclick: () => sendMessage(again),
      }) : null));
  }

  function fileChips(names) {
    if (!names.length) return null;
    return el('div', { class: 'msg-files' }, names.map((n) => el('span', { class: 'file-chip file-chip-sm' }, icon('file'), el('span', { class: 'file-name', title: n, text: n }))));
  }

  function userNode(text, names = [], when = null) {
    return el('div', { class: 'msg-user' },
      when ? el('time', { class: 'msg-time', text: U.shortTime(when) }) : null,
      fileChips(names),
      text ? el('div', { class: 'msg-user-text', text }) : null);
  }

  function assistantNode(text) {
    const md = el('div', { class: 'md' });
    md.append(renderMarkdown(U.humanize(text)));
    return el('div', { class: 'turn' }, md);
  }

  function appendUser(text, names = []) {
    endTurn();
    appendToFeed(userNode(text, names, Date.now()));
    $('#chain').replaceChildren();
    if (orb && orb.setSteps) orb.setSteps([]);
    const said = $('#said');
    said.textContent = `«${U.clip(text, 60)}»`;
    said.hidden = !text;
    clearTimeout(said.timer);
    said.timer = setTimeout(() => { said.hidden = true; }, 5000);
  }

  function appendAssistant(text) {
    endTurn();
    appendToFeed(assistantNode(text));
  }

  // Реплика из истории: файлы, приложенные к сообщению, показываем чипами.
  function parseUserHistory(text) {
    const s = String(text || '');
    if (!/^Файл «/.test(s)) return { text: s, names: [] };
    const names = [];
    const re = /(?:^|\n\n)Файл «([^»\n]+)»/g;
    let m;
    while ((m = re.exec(s)) && names.length < MAX_FILES) names.push(m[1]);
    const cut = s.lastIndexOf('\n\n');
    return { text: cut >= 0 ? s.slice(cut + 2) : '', names };
  }

  function historyNode(m) {
    if (m.role === 'user') {
      const u = parseUserHistory(m.text);
      return userNode(u.text, u.names);
    }
    return assistantNode(m.text);
  }

  // Большая история: последние 100 реплик сразу, ранние — по кнопке «Показать раньше».
  function showOlder() {
    if (!C.older.length) return;
    const f = $('#feed');
    const before = f.scrollHeight - f.scrollTop;
    const batch = C.older.splice(Math.max(0, C.older.length - HISTORY_PAGE));
    const frag = document.createDocumentFragment();
    for (const m of batch) frag.append(historyNode(m));
    $('#feedList').prepend(frag);
    $('#feedMore').hidden = C.older.length === 0;
    f.scrollTop = f.scrollHeight - before;
    updateEmpty();
  }

  // ── Вкладки чатов ─────────────────────────────────────────────
  let workspaceSwitching = false;
  let workspaceCreating = false;
  let currentWorkspaceId = 'default';
  async function refreshWorkspaces() {
    if (!has('workspacesList')) return;
    const data = await call('workspacesList');
    if (!data || data.ok === false || !Array.isArray(data.spaces)) {
      if (data && data.error) toast(data.error, 'error');
      return;
    }
    const picker = $('#workspacePicker');
    picker.replaceChildren(...data.spaces.map((space) => {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      return option;
    }));
    picker.value = data.selected;
    currentWorkspaceId = data.selected;
    $('#workspaceSwitch').hidden = false;
    $('#workspaceNote').hidden = data.selected === 'default';
  }

  async function selectWorkspace(id) {
    if (workspaceSwitching) return false;
    if (S.view === 'commands' && K.dirty) { toast('Сначала сохраните или отмените изменения команды.', 'error'); await refreshWorkspaces(); return false; }
    if (tracker.busy) { toast('Джарвис занят. Остановите ход и повторите.', 'error'); await refreshWorkspaces(); return false; }
    if (C.files.length) { toast('Сначала отправьте или уберите вложения.', 'error'); await refreshWorkspaces(); return false; }
    if ($('#chatInput').value.trim()) { toast('Сначала отправьте или очистите текст в поле.', 'error'); await refreshWorkspaces(); return false; }
    workspaceSwitching = true;
    $('#workspacePicker').disabled = true;
    $('#workspaceCreate').disabled = true;
    try {
      const result = await call('workspacesSelect', id);
      if (!result || result.ok === false) throw new Error((result && result.error) || 'пространство не открылось');
      resetFeed();
      await refreshWorkspaces();
      await refreshChatTabs();
      await loadHistory();
      await loadSettings();
      if (S.view === 'commands') {
        K.draft = null;
        K.selectedId = null;
        K.dirty = false;
        $('#commands').classList.remove('is-editing');
        await loadCommands();
      }
      await Promise.all([refreshTasks(), refreshMissions(), reloadDeals()]);
      $('#chatInput').focus();
      return true;
    } catch (err) {
      toast('Пространство не открылось: ' + errText(err), 'error');
      await refreshWorkspaces();
      return false;
    } finally {
      workspaceSwitching = false;
      $('#workspacePicker').disabled = false;
      $('#workspaceCreate').disabled = false;
    }
  }

  function initWorkspaceControls() {
    if (!has('workspacesList') || !has('workspacesCreate') || !has('workspacesSelect')) return;
    $('#workspacePicker').addEventListener('change', (event) => selectWorkspace(event.target.value));
    $('#workspaceCreate').addEventListener('click', () => {
      if (workspaceSwitching) return;
      if (tracker.busy) { toast('Джарвис занят. Остановите ход и повторите.', 'error'); return; }
      if (C.files.length) { toast('Сначала отправьте или уберите вложения.', 'error'); return; }
      if ($('#chatInput').value.trim()) { toast('Сначала отправьте или очистите текст в поле.', 'error'); return; }
      $('#workspaceName').value = '';
      $('#workspaceDialog').showModal();
      $('#workspaceName').focus();
    });
    $('#workspaceCancel').addEventListener('click', () => $('#workspaceDialog').close());
    $('#workspaceForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (workspaceCreating) return;
      const name = $('#workspaceName').value.trim();
      if (!name) return;
      workspaceCreating = true;
      try {
        const result = await call('workspacesCreate', name);
        if (!result || result.ok === false) throw new Error((result && result.error) || 'не удалось создать');
        $('#workspaceDialog').close();
        await selectWorkspace(result.space.id);
      } catch (err) { toast('Пространство не создано: ' + errText(err), 'error'); }
      finally { workspaceCreating = false; }
    });
    refreshWorkspaces().catch((err) => toast('Пространства недоступны: ' + errText(err), 'error'));
  }

  function renderChatTabs(data) {
    if (!data || !Array.isArray(data.chats)) return;
    $('#chatTabs').hidden = false;
    $('#chatTabsList').replaceChildren(...data.chats.map((c) => {
      const active = c.id === data.activeId;
      const tab = el('span', { class: 'chat-tab' + (active ? ' is-active' : '') },
        el('button', {
          class: 'chat-tab-name', type: 'button', text: c.title, title: c.title, ...(active ? { 'aria-current': 'true' } : {}),
          onclick: () => { if (!active) changeChat('chatSelect', c.id); },
        }),
        el('button', {
          class: 'chat-tab-x', type: 'button', title: 'Закрыть чат', 'aria-label': `Закрыть чат «${c.title}»`,
          onclick: () => closeChat(c),
        }, icon('x')));
      if (active) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      return tab;
    }));
    U.fillIcons($('#chatTabsList'));
  }

  async function refreshChatTabs() {
    if (!has('chatList')) return;
    renderChatTabs(await call('chatList'));
  }

  async function changeChat(method, id) {
    if (tracker.busy) { toast('Джарвис занят. Остановите ход и повторите.', 'error'); return; }
    try {
      const r = await call(method, id);
      if (r && r.ok === false) throw new Error(r.error === 'busy' ? 'Джарвис занят' : (r.error || 'ядро не приняло запрос'));
      resetFeed();
      renderChatTabs(r);
      await loadHistory();
      $('#chatInput').focus();
    } catch (e) {
      toast('Чат не открылся: ' + errText(e), 'error');
    }
  }

  async function closeChat(chat) {
    if (chat.title !== 'Новый чат' && !(await ask('Закрыть чат?', `Разговор «${chat.title}» будет удалён. Журнал останется.`, 'Закрыть', 'Отмена'))) return;
    changeChat('chatClose', chat.id);
  }

  async function loadHistory() {
    if (!has('chatHistory')) { updateEmpty(); return; }
    try {
      const arr = await call('chatHistory');
      const msgs = (Array.isArray(arr) ? arr : []).filter((m) => m && typeof m.text === 'string' && m.text.trim() && (m.role === 'user' || m.role === 'assistant'));
      C.older = msgs.slice(0, Math.max(0, msgs.length - HISTORY_PAGE));
      const frag = document.createDocumentFragment();
      for (const m of msgs.slice(-HISTORY_PAGE)) frag.append(historyNode(m));
      $('#feedList').prepend(frag);
      $('#feedMore').hidden = C.older.length === 0;
    } catch (e) {
      chatError('разговор не загрузился: ' + errText(e), { retry: false });
      endTurn();
    }
    updateEmpty();
    scrollFeed(true);
  }

  // ── Вложения ──────────────────────────────────────────────────
  function renderFiles() {
    const box = $('#attachList');
    box.hidden = C.files.length === 0;
    box.replaceChildren(...C.files.map((f, i) => el('span', { class: 'file-chip', role: 'listitem', title: f.path },
      icon('file'),
      el('span', { class: 'file-name', text: f.name }),
      U.fmtSize(f.size) ? el('span', { class: 'file-size', text: U.fmtSize(f.size) }) : null,
      el('button', {
        type: 'button', class: 'file-x', 'aria-label': `Убрать файл «${f.name}»`, title: `Убрать файл «${f.name}»`,
        onclick: () => { C.files.splice(i, 1); renderFiles(); $('#chatInput').focus(); },
      }, icon('x')))));
    const full = C.files.length >= MAX_FILES;
    const btn = $('#attachBtn');
    btn.disabled = !has('pickFiles') || full || linkDown();
    const why = !has('pickFiles') ? 'Вложения недоступны в этой версии ядра' : full ? 'Не больше 5 файлов' : 'Прикрепить файлы (до 5)';
    btn.title = why;
    btn.setAttribute('aria-label', why);
  }

  async function pickFiles() {
    if (C.files.length >= MAX_FILES) { toast('Не больше 5 файлов'); return; }
    let picked;
    try {
      picked = await call('pickFiles');
    } catch (e) {
      toast('Файлы не выбраны: ' + errText(e), 'error');
      return;
    }
    const arr = (Array.isArray(picked) ? picked : []).filter((f) => f && typeof f.path === 'string' && f.path);
    let dropped = 0;
    for (const f of arr) {
      if (C.files.some((x) => x.path === f.path)) continue;
      if (C.files.length >= MAX_FILES) { dropped++; continue; }
      C.files.push({ name: String(f.name || f.path.split(/[\\/]/).pop()), path: f.path, size: Number(f.size) || 0 });
    }
    if (dropped) toast(`Не больше 5 файлов: ${dropped} ${U.plural(dropped, ['файл не добавлен', 'файла не добавлены', 'файлов не добавлено'])}`);
    renderFiles();
    $('#chatInput').focus();
  }

  // «Объясни, что я обвёл»: ядро прячет окно и даёт обвести рамкой (Esc — отмена), потом вопрос уходит в чат.
  async function explainRegion() {
    if (tracker.busy || linkDown()) return;
    let res;
    try { res = await call('pickRegion'); } catch (e) { toast('Область не выбрана: ' + errText(e), 'error'); return; }
    if (!res || res.cancelled) return;
    if (!res.ok) { toast('Область не выбрана: ' + (res.error || 'ошибка'), 'error'); return; }
    await sendMessage(`Объясни, что я обвёл на экране (${res.label}): что это и как решить?`);
  }

  // ── Диктовка ──────────────────────────────────────────────────
  // Кнопка микрофона и честный индикатор режима. Мост: dictation:start/stop/mode/state
  // и события dictation:event ({type:'state'|'text'|'error'|'wake'|'mode'}).
  // Режимы: «Слушаю» — вся речь; «Только имя» — в поле и чат только «Джарвис, …»; «Микрофон выкл».
  const DICT = { recording: false, busy: false, hint: '', mode: 'listening', full: false, hotkeyOk: true };
  const DICT_STATES = ['listening', 'quiet', 'off'];
  const DICT_LABELS = { listening: 'Слушаю', quiet: 'Только имя', off: 'Микрофон выкл' };
  const DICT_COLORS = { listening: 'var(--ok)', quiet: 'var(--warn)', off: 'var(--text-3)' };

  // Индикатор строится из JS: разметку index.html правит другой агент, её не трогаем.
  function ensureDictationIndicator() {
    let elm = $('#dictationStateBtn');
    if (elm) return elm;
    const dock = document.querySelector('.stage-dock');
    if (!dock) return null;
    elm = document.createElement('button');
    elm.type = 'button';
    elm.id = 'dictationStateBtn';
    elm.hidden = true;
    elm.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'margin:0 0 6px', 'padding:3px 9px', 'border:1px solid var(--border)',
      'border-radius:999px', 'background:var(--surface-2)', 'color:var(--text-2)',
      'font:inherit', 'font-size:var(--fs-xs)', 'cursor:pointer',
    ].join(';');
    const dot = document.createElement('span');
    dot.setAttribute('aria-hidden', 'true');
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:currentColor;flex:none';
    const label = document.createElement('span');
    elm.append(dot, label);
    elm.addEventListener('click', () => { cycleDictationMode(); });
    const hint = $('#composerHint');
    if (hint && hint.parentNode === dock) dock.insertBefore(elm, hint);
    else dock.appendChild(elm);
    return elm;
  }

  // Подпись честная: если микрофон не слушает или выключен, «Слушаю» не показываем.
  function dictationIndicatorView() {
    if (S.settings.dictation !== true) return null;
    if (!DICT.recording || DICT.mode === 'off') return { label: DICT_LABELS.off, color: DICT_COLORS.off, mode: 'off' };
    if (DICT.mode === 'quiet' || DICT.full === false) return { label: DICT_LABELS.quiet, color: DICT_COLORS.quiet, mode: 'quiet' };
    return { label: DICT_LABELS.listening, color: DICT_COLORS.listening, mode: 'listening' };
  }

  function renderDictationIndicator() {
    const elm = ensureDictationIndicator();
    if (!elm) return;
    const view = dictationIndicatorView();
    if (!view) { elm.hidden = true; return; }
    elm.hidden = false;
    elm.dataset.mode = view.mode;
    elm.title = 'Микрофон: ' + view.label + '. Нажмите, чтобы переключить (Ctrl+Alt+M)';
    elm.setAttribute('aria-label', 'Режим микрофона: ' + view.label + '. Переключить');
    const dot = elm.firstElementChild;
    const label = elm.lastElementChild;
    if (dot) dot.style.background = view.color;
    if (label) label.textContent = view.label;
  }

  function syncDictationVisible() {
    const btn = $('#dictationBtn');
    const on = S.settings.dictation === true && has('dictationStart') && has('onDictationEvent');
    if (!on && DICT.recording) stopDictation(); // выключили в настройках посреди записи
    if (btn) btn.hidden = !on;
    renderDictationIndicator();
  }

  function nextDictationMode() {
    const i = DICT_STATES.indexOf(DICT.mode);
    return DICT_STATES[(i + 1) % DICT_STATES.length];
  }

  // Клик по индикатору: микрофон не слушает — включить полную диктовку, иначе следующий режим по кругу.
  async function cycleDictationMode() {
    if (S.settings.dictation !== true) { toast('Включите диктовку в настройках'); return; }
    if (!has('dictationMode')) return;
    const target = DICT.recording ? nextDictationMode() : 'listening';
    try {
      const r = await call('dictationMode', target);
      if (r && r.ok === false) {
        toast(r.reason === 'disabled' ? 'Включите диктовку в настройках' : 'Режим не переключился', 'error');
        return;
      }
      if (r) applyDictationModeEvent({ type: 'mode', mode: r.mode, full: r.full === true, recording: r.recording === true });
    } catch (e) {
      toast('Режим не переключился: ' + errText(e), 'error');
    }
  }

  // Событие режима из ядра: подпись, полнота диктовки и ответ владельцу (тост).
  function applyDictationModeEvent(ev) {
    if (ev && DICT_STATES.includes(ev.mode)) DICT.mode = ev.mode;
    if (ev && typeof ev.full === 'boolean') DICT.full = ev.full;
    if (ev && typeof ev.recording === 'boolean') setRecordingUI(ev.recording);
    if (DICT.recording) setRecordingHint(); // подсказка зависит от режима
    renderDictationIndicator();
    if (ev && typeof ev.reply === 'string' && ev.reply.trim()) toast(ev.reply.trim());
  }

  async function refreshDictationState() {
    if (!has('dictationState')) return;
    try {
      const r = await call('dictationState');
      if (!r || r.ok === false) return;
      DICT.hotkeyOk = r.hotkeyOk !== false;
      applyDictationModeEvent({ type: 'mode', mode: r.mode, full: r.full === true, recording: r.recording === true });
    } catch {
      // старая сборка без моста: остаётся кнопка микрофона, индикатор скрыт
    }
  }

  function setRecordingHint() {
    const hint = $('#composerHint');
    if (!DICT.hint) DICT.hint = hint.textContent; // прежний текст вернём после остановки
    // В тихом режиме слова без имени не попадут в поле — подсказка не должна обещать обратное.
    hint.textContent = (DICT.mode === 'quiet' || DICT.full === false)
      ? 'Слушаю только имя «Джарвис»: скажите «Джарвис, открой ютуб». Ctrl+Alt+M — режим микрофона'
      : 'Распознанная речь остановит текущий ход и появится в поле. Нажмите ещё раз, чтобы закончить';
    hint.dataset.recording = 'true';
    hint.hidden = false;
  }

  function restoreRecordingHint() {
    if (!DICT.hint) return;
    $('#composerHint').textContent = DICT.hint;
    delete $('#composerHint').dataset.recording;
    DICT.hint = '';
    renderComposerState();
  }

  function setRecordingUI(on) {
    if (DICT.recording === on) return;
    DICT.recording = on;
    const btn = $('#dictationBtn');
    if (btn) {
      if (on) btn.setAttribute('data-recording', 'true');
      else btn.removeAttribute('data-recording');
    }
    if (on) setRecordingHint();
    else restoreRecordingHint();
    // Шар и заголовок показывают «Слушаю», пока идёт распознавание.
    if (typeof tracker !== 'undefined' && tracker && typeof tracker.setListening === 'function') {
      tracker.setListening(on);
      renderStatus();
    }
    renderDictationIndicator();
  }

  async function startDictation() {
    if (DICT.busy) return; // запрос в полёте: повторный клик игнорируем
    DICT.busy = true;
    try {
      const r = await call('dictationStart');
      if (r && r.ok === false) {
        toast(r.reason === 'disabled' ? 'Включите диктовку в настройках' : 'Диктовка не запустилась', 'error');
        return;
      }
      if (S.settings.dictation !== true) { stopDictation(); return; } // успели выключить, пока запрос шёл
      setRecordingUI(true);
    } catch (e) {
      toast('Диктовка не запустилась: ' + errText(e), 'error');
    } finally {
      DICT.busy = false;
    }
  }

  async function stopDictation() {
    if (DICT.busy) return;
    DICT.busy = true;
    setRecordingUI(false); // не ждём событие stopped: повторное «stopped» ничего не меняет
    try {
      await call('dictationStop');
    } catch (e) {
      toast('Диктовка не остановилась: ' + errText(e), 'error');
    } finally {
      DICT.busy = false;
    }
  }

  function dictationText(text) {
    const t = String(text || '').trim();
    const ta = $('#chatInput');
    if (!t || !ta) return;
    ta.value = ta.value ? ta.value + ' ' + t : t;
    ta.dispatchEvent(new Event('input', { bubbles: true })); // автоподгон высоты поля и кнопки отправки
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    if (DICT.recording) setRecordingHint(); // пересчёт состояний поля мог спрятать подсказку
  }

  // Обращение «Джарвис» без кнопки: сказанное сразу уходит в чат, если Джарвис свободен.
  function wakeCommand(command) {
    const cmd = String(command || '').trim();
    if (!cmd) { toast('Слушаю. Скажите команду после имени.'); return; }
    if (tracker.busy) { toast('Джарвис занят — голосовая команда не отправлена', 'error'); return; }
    const ta = $('#chatInput');
    if (ta) { ta.value = cmd; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    sendMessage(cmd);
  }

  function onDictationEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'mode') { applyDictationModeEvent(ev); return; }
    if (ev.type === 'state' && ev.state === 'listening') { setRecordingUI(true); renderDictationIndicator(); }
    else if (ev.type === 'state' && ev.state === 'stopped') { setRecordingUI(false); renderDictationIndicator(); }
    else if (ev.type === 'error') {
      setRecordingUI(false); // ошибка запуска приходит без события stopped
      renderDictationIndicator();
      toast(String(ev.message || 'Диктовка не удалась'), 'error');
    } else if (ev.type === 'text') dictationText(ev.text);
    else if (ev.type === 'wake') wakeCommand(ev.command);
  }

  function initDictation() {
    ensureDictationIndicator();
    if (!has('onDictationEvent') || !has('dictationStart')) {
      renderDictationIndicator();
      return; // старая сборка без моста: кнопка и индикатор остаются скрытыми
    }
    const btn = $('#dictationBtn');
    if (btn) btn.addEventListener('click', () => { if (DICT.recording) stopDictation(); else startDictation(); });
    window.jarvis.onDictationEvent(onDictationEvent); // подписка один раз
    // Если глобальную Ctrl+Alt+M заняло другое приложение (ядро сообщает hotkeyOk: false),
    // ловим сочетание в окне — режим остаётся доступен с клавиатуры.
    document.addEventListener('keydown', (e) => {
      if (DICT.hotkeyOk !== false) return;
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.code === 'KeyM' || e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        cycleDictationMode();
      }
    });
    syncDictationVisible();
    refreshDictationState();
  }

  // ── Поле ввода: состояния ─────────────────────────────────────
  function renderComposerState() {
    const ta = $('#chatInput');
    if (!ta) return;
    const off = linkDown();
    ta.disabled = off;
    ta.placeholder = off ? 'Нет связи с ядром' : S.stopped ? 'Аварийный стоп. Возобновите в трее.' : 'введите текст…';
    $('#chatSend').disabled = off || !ta.value.trim();
    $('#composerBusy').hidden = !tracker.busy;
    $('#composerHint').hidden = tracker.busy || !feedEmpty();
    if (DICT.recording) setRecordingHint(); // запись держит подсказку на виду
    const attach = $('#attachBtn');
    if (attach) attach.disabled = !has('pickFiles') || C.files.length >= MAX_FILES || off;
  }

  // ── Отправка и стоп ───────────────────────────────────────────
  async function sendMessage(raw) {
    const text = String(raw || '').trim();
    if (!text) return false;
    // Пока идёт ход, ядро отвечает только на «что повисло» и «стоп»; остальное остаётся в поле ввода.
    if (tracker.busy) {
      const side = has('side') ? await call('side', text).catch(() => null) : null;
      if (!side || !side.side) { renderComposerState(); return false; }
      appendUser(text, []);
      appendAssistant(side.reply);
      return true;
    }
    if (linkDown()) return false;
    if (S.view !== 'nox') show('nox');
    C.doneSinceSend = false;
    C.lastSent = text;
    const files = C.files.slice();
    appendUser(text, files.map((f) => f.name));
    showThinking();
    let res;
    try {
      res = await call('send', text, files.map((f) => f.path));
    } catch (e) {
      chatError(errText(e), { prefix: 'Сообщение не отправлено: ' });
      endTurn();
      return false;
    }
    if (res && res.ok === false) {
      const err = String(res.error || '');
      if (STOP_RE.test(err)) {
        S.stopped = true;
        renderBanner();
        renderStatus();
        chatError('аварийный стоп включён. Возобновите в трее', { prefix: 'Сообщение не отправлено: ', retry: true });
      } else {
        const why = { busy: 'Джарвис занят предыдущим поручением', empty: 'пустое сообщение', forbidden: 'окно не прошло проверку' }[err] || (err || 'ядро не приняло сообщение');
        chatError(why, { prefix: 'Сообщение не отправлено: ' });
      }
      endTurn();
      return false;
    }
    // Первая успешная отправка снимает флаг аварийного стопа (событий «возобновлено» окно не получает).
    if (S.stopped) { S.stopped = false; renderBanner(); }
    C.files = [];
    renderFiles();
    // Ход мог уже закончиться (быстрая команда) — тогда не включаем «Думаю» заново.
    if (!C.doneSinceSend) tracker.markSent();
    renderStatus();
    return true;
  }

  async function stopTurn() {
    try {
      await call('stop');
      toast('Останавливаю');
    } catch (e) {
      toast('Стоп не сработал: ' + errText(e), 'error');
    }
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 142) + 'px';
    ta.style.overflowY = ta.scrollHeight > 142 ? 'auto' : 'hidden';
  }

  function initChat() {
    if (has('chatNew')) $('#chatNew').addEventListener('click', () => changeChat('chatNew'));
    const form = $('#composer');
    const ta = $('#chatInput');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ta.value;
      if (!text.trim() || tracker.busy) { renderComposerState(); return; }
      if (orb && !linkDown() && !S.stopped) orb.gesture('send');
      const sent = sendMessage(text);
      ta.value = '';
      syncLife();
      autosize(ta);
      if (!(await sent)) { ta.value = text; autosize(ta); }
      syncLife();
      renderComposerState();
    });
    let composing = false;
    const caret = () => ta.value.length ? (ta.selectionStart / ta.value.length) * 2 - 1 : 0;
    const syncLife = () => {
      if (orb) orb.setComposer(document.activeElement === ta && !ta.disabled, Boolean(ta.value.trim()), caret());
    };
    ta.addEventListener('focus', syncLife);
    ta.addEventListener('blur', syncLife);
    ta.addEventListener('select', syncLife);
    ta.addEventListener('compositionstart', () => { composing = true; });
    ta.addEventListener('compositionend', () => {
      composing = false;
      syncLife();
      if (orb && !tracker.busy && !linkDown() && !S.stopped) orb.gesture('paste', caret());
    });
    ta.addEventListener('input', (e) => {
      autosize(ta); renderComposerState(); syncLife();
      if (!orb || composing || e.isComposing || e.inputType === 'insertFromComposition' || tracker.busy || linkDown() || S.stopped) return;
      const type = e.inputType || '';
      const kind = type.startsWith('delete') ? 'delete'
        : type === 'insertText' && e.data === ' ' ? 'space'
        : type === 'insertText' && e.data && e.data.length === 1 ? 'type' : 'paste';
      orb.gesture(kind, caret());
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !composing && e.keyCode !== 229) {
        e.preventDefault();
        if (!tracker.busy) form.requestSubmit();
      }
    });
    $('#attachBtn').addEventListener('click', pickFiles);
    if (has('pickRegion')) {
      const why = 'Объясни, что я обвёл: обвести область экрана';
      $('#attachBtn').after(el('button', { class: 'icon-btn icon-btn-sm', type: 'button', id: 'regionBtn', title: why, 'aria-label': why, onclick: explainRegion }, icon('target')));
    }
    $('#feedMore').addEventListener('click', showOlder);
    $('#toBottom').addEventListener('click', () => { C.stick = true; scrollFeed(true); $('#chatInput').focus(); });
    $('#feed').addEventListener('scroll', () => { if (nearBottom()) $('#toBottom').hidden = true; }, { passive: true });
    renderFiles();
    renderComposerState();
  }

  // Готовые фразы пустого Диалога: до 4 (2 при низком окне — через CSS), по одной из категорий библиотеки.
  function renderQuickChips() {
    const box = $('#quickChips');
    let picks = [];
    const lib = L.list;
    if (lib.length) {
      const seen = new Set();
      for (const c of lib) {
        if (!seen.has(c.category)) { seen.add(c.category); picks.push(c); }
        if (picks.length >= 4) break;
      }
      for (const c of lib) {
        if (picks.length >= 4) break;
        if (!picks.includes(c)) picks.push(c);
      }
      picks = picks.map((c) => ({ phrase: c.phrases[0] || c.title, title: c.title, needsArgs: c.args.length > 0 }));
    } else {
      picks = ['Что ты умеешь?', 'Сделай громкость 30', 'Напомни через 10 минут размяться'].map((p) => ({ phrase: p, title: p }));
    }
    box.replaceChildren(...picks.map((p) => el('button', {
      class: 'quick-chip', type: 'button', title: p.needsArgs ? p.title + ' — допишите и отправьте' : p.title,
      onclick: () => {
        const ta = $('#chatInput');
        if (p.needsArgs) { ta.value = p.phrase + ' '; autosize(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); renderComposerState(); return; }
        sendMessage(p.phrase);
      },
    }, el('span', { text: p.phrase }))));
  }

  // ── Поручения исполнителя ─────────────────────────────────────
  // Событие 'task' — карточка на taskId: ищется в любом месте ленты, шаги копятся (только в окне),
  // после итога (final) карточка замораживается. Без taskId — общая заметка. Только textContent.
  const T = {
    cards: new Map(),     // taskId → { node, steps, status, title, final, ev }
    approvals: new Map(), // id подтверждения исполнителя → taskId
  };
  const TASK_WORD = {
    queued: 'в очереди', running: 'работает', waiting_approval: 'ждёт решения', paused: 'на паузе',
    blocked: 'заблокирована', done: 'выполнено', unverified: 'не проверено', cancelled: 'отменена',
  };
  const TASK_TONE = {
    queued: 'accent', running: 'accent', waiting_approval: 'warn', paused: 'warn',
    blocked: 'err', done: 'ok', unverified: 'warn', cancelled: 'neutral',
  };
  const TASK_ICON = {
    queued: 'clock', running: 'spinner', waiting_approval: 'hourglass', paused: 'alert',
    blocked: 'ban', done: 'check', unverified: 'alert', cancelled: 'x',
  };

  function taskLook(rec) {
    const code = rec.verdict && rec.verdict.code;
    if ((rec.status === 'done' || rec.status === 'unverified') && VERDICT_LABEL[code]) {
      const tone = VERDICT_TONE[code] || 'warn';
      return { word: VERDICT_LABEL[code].toLowerCase(), tone, icon: code === 'failed' ? 'alert' : code === 'verified' ? 'check' : code === 'not_applicable' ? 'check' : 'alert' };
    }
    return { word: TASK_WORD[rec.status] || 'событие', tone: TASK_TONE[rec.status] || 'neutral', icon: TASK_ICON[rec.status] || 'list' };
  }

  function verdictLine(rec) {
    const v = rec.verdict;
    if (!rec.final || !v || !VERDICT_LABEL[v.code]) return '';
    if (v.code === 'not_applicable') return VERDICT_LABEL.not_applicable;
    const why = U.cleanSummary(v.reason);
    return VERDICT_LABEL[v.code] + (why ? ': ' + why : '');
  }

  function renderTaskCard(rec) {
    const look = taskLook(rec);
    const node = rec.node;
    const wasOpen = Boolean($('details', node) && $('details', node).open);
    node.dataset.tone = look.tone;
    node.setAttribute('aria-label', `Поручение «${rec.title}»: ${look.word}`);
    const last = rec.steps.length ? rec.steps[rec.steps.length - 1] : '';
    const verdict = verdictLine(rec);
    const report = rec.final && rec.report ? rec.report : '';
    const reportBtn = report ? el('button', {
      class: 'btn btn-secondary btn-sm', type: 'button', text: 'Открыть отчёт', title: report,
      onclick: async (e) => {
        const b = e.currentTarget;
        try {
          const res = await call('tasksOpenReport', rec.id);
          if (res && res.ok === false) b.textContent = 'Отчёт не открылся: ' + (res.error || 'причина неизвестна');
        } catch (err) {
          b.textContent = 'Отчёт не открылся: ' + errText(err);
        }
      },
    }) : null;
    const steps = rec.steps.length ? el('details', { class: 'task-steps', open: wasOpen },
      el('summary', {}, el('span', { text: `Шаги · ${rec.steps.length}` }), el('span', { class: 'acts-chev', 'data-icon': 'chevron', 'aria-hidden': 'true' })),
      el('div', { class: 'task-steps-body' }, el('ol', {}, rec.steps.map((s) => el('li', { text: s }))))) : null;
    fill(node,
      el('div', { class: 'task-head' },
        el('span', { class: 'task-icon' }, icon(look.icon)),
        el('span', { class: 'task-title', title: rec.title, text: `Поручение «${rec.title}»` }),
        el('span', { class: 'task-badge' }, icon(look.icon), el('span', { text: look.word }))),
      !rec.final && last ? el('p', { class: 'task-step', title: last, text: last }) : null,
      steps,
      verdict || reportBtn ? el('div', { class: 'task-foot' },
        verdict ? el('p', { class: 'task-verdict', text: verdict }) : null,
        reportBtn) : null);
    U.fillIcons(node);
  }

  function taskCard(ev) {
    const id = typeof ev.taskId === 'string' && ev.taskId ? ev.taskId : null;
    const status = typeof ev.status === 'string' && TASK_WORD[ev.status] ? ev.status : null;
    const message = U.cleanSummary(ev.message);
    if (!id) {
      appendToFeed(el('div', { class: 'notice', role: 'status' }, icon('alert'), el('span', { text: message || 'Событие задачи' })));
      return;
    }
    let rec = T.cards.get(id);
    if (rec && rec.final) rec = null; // замороженная карточка не меняется; новое событие — новая карточка
    if (!rec) {
      rec = { id, node: el('article', { class: 'task-card' }), steps: [], status: status || 'queued', title: '', final: false, verdict: null, report: '' };
      T.cards.set(id, rec);
      endTurn();
      appendToFeed(rec.node);
    }
    if (ev.title) rec.title = U.clip(String(ev.title), 80);
    if (!rec.title) rec.title = 'без названия';
    if (status) rec.status = status;
    if (message && rec.steps[rec.steps.length - 1] !== message) rec.steps.push(message);
    if (ev.verdict && typeof ev.verdict === 'object') rec.verdict = ev.verdict;
    if (ev.final) {
      rec.final = true;
      rec.report = typeof ev.report === 'string' ? ev.report : '';
    }
    C.stick = nearBottom();
    renderTaskCard(rec);
    scrollFeed();
  }

  function taskEvent(ev) {
    const id = typeof ev.taskId === 'string' && ev.taskId ? ev.taskId : null;
    if (id && typeof ev.approvalId === 'string' && ev.approvalId) T.approvals.set(ev.approvalId, id);
    // Задача больше не ждёт подтверждения (ответ, стоп, пауза): её запрос в окне неактуален.
    if (id && ev.status !== 'waiting_approval') {
      for (const [aid, tid] of [...T.approvals]) {
        if (tid !== id) continue;
        T.approvals.delete(aid);
        approvalDrop(aid);
      }
    }
    if (ev.workspaceId && ev.workspaceId !== currentWorkspaceId) return;
    // «на паузе: аварийный стоп» — окно узнаёт о стопе (событий «стоп включён» нет, этап 2).
    if (/^на паузе: аварийный стоп/i.test(String(ev.message || ''))) {
      S.stopped = true;
      renderBanner();
      renderStatus();
    }
    taskCard(ev);
    // Итог задачи: сводка — обычной репликой ассистента под карточкой.
    if (ev.final && typeof ev.summary === 'string' && ev.summary) appendAssistant(ev.summary);
  }

  // «Ответ готов» — отдельный скрытый live-регион вместо aria-live на всей ленте.
  function announceDone() {
    const live = $('#doneLive');
    live.textContent = '';
    setTimeout(() => { live.textContent = 'Ответ готов'; }, 50);
  }

  // ── События ядра ──────────────────────────────────────────────
  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    try {
      // Запрос подтверждения от исполнителя задачи: окно подтверждения — да, но ход чата он не занимает
      // (иначе поле ввода считалось бы занятым до конца следующего хода).
      if (ev.type === 'approval_request' && (T.approvals.has(ev.id) || ev.taskId)) {
        if (ev.taskId) T.approvals.set(ev.id, ev.taskId);
        approvalPush(ev);
        return;
      }
      // Запрос решён или отменён (задача заблокирована, на паузе, отменена, завершена; стоп): карточку убираем.
      if (ev.type === 'approval_closed') {
        if (A.syncing) A.closedDuringSync.add(ev.approvalId || ev.id);
        const own = T.approvals.has(ev.id);
        T.approvals.delete(ev.id);
        approvalDrop(ev.approvalId || ev.id);
        if (!own) tracker.handle(ev);
        return;
      }
      switch (ev.type) {
        case 'text':
          chatText(ev.delta);
          break;
        case 'task':
          taskEvent(ev);
          refreshTasks();
          if (M.open) refreshMissions();
          break;
        // Руки Джарвиса начали или закончили работу на ПК: надпись «Nox работает на вашем ПК · Esc — остановить».
        case 'hands': {
          const banner = document.getElementById('handsBanner');
          if (banner) banner.hidden = ev.active !== true;
          break;
        }
        // Запись действий: ядро сообщает о каждом реально выполненном шаге, пока идёт запись.
        case 'record:step':
          if (K.recording) {
            REC.steps.push({ tool: String(ev.tool || ''), warnings: Array.isArray(ev.warnings) ? ev.warnings : [] });
            renderRecordSteps();
          }
          break;
        // Короткое сообщение ядра в ленту (например: «жду, пока вы закончите печатать»).
        case 'notice':
          appendToFeed(el('div', { class: 'notice', role: 'status' }, icon('alert'), el('span', { text: U.cleanSummary(ev.message) || '' })));
          break;
        case 'tool_start':
        case 'approval_request':
          chatTool(ev);          if (ev.type === 'approval_request') approvalPush(ev);
          // Инструмент начал музыкальное действие: храним id — у tool_result имени инструмента нет.
          if (ev.type === 'tool_start' && typeof ev.name === 'string' && /^(music_|youtube_play$|media_control$)/.test(ev.name)) WGT.musicTools.set(ev.id, true);
          break;
        case 'tool_result':
          chatTool(ev);
          approvalDrop(ev.id);
          // Виджет обновляем только по завершении: историю пишет сам инструмент во время работы.
          if (WGT.musicTools.delete(ev.id)) reloadWidgets();
          break;
        case 'error':
          chatError(ev.message);
          break;
        case 'done': {
          refreshChatTabs().catch(() => {});
          C.doneSinceSend = true;
          const cancelled = ev.cancelled === true || ev.status === 'cancelled';
          const said = C.turnText;
          // Остановка — это не «ответ готов»: оборванный текст не выдаём за законченный.
          if (cancelled) {
            // Внешний вызов может ещё завершаться: обещать «ничего не выполнялось» нельзя.
            const runningTool = C.act
              ? [...C.act.items.values()].map((x) => x.entry).find((e) => e.status === 'running')
              : null;
            appendToFeed(el('div', { class: 'notice', role: 'status' },
              icon('alert'),
              el('span', {
                text: runningTool
                  ? 'Ход остановлен. Текущее действие ещё завершается — его результат в истории.'
                  : 'Ход остановлен. Действия после остановки не выполнялись.',
              })));
            const live = $('#doneLive');
            if (live) {
              live.textContent = '';
              setTimeout(() => { live.textContent = 'Ход остановлен'; }, 50);
            }
            endTurn();
            approvalClearChat(ev.runId);
            if (S.view === 'journal') reloadJournal();
            reloadDeals();
            break;
          }
          endTurn();
          if (said) announceDone();
          approvalClearChat(ev.runId);
          if (S.view === 'journal') reloadJournal();
          reloadDeals();
          break;
        }
        default:
          break;
      }
      tracker.handle(ev);
      if (orb && ev.type === 'tool_start' && tracker.state !== 'waiting_approval') orb.pulse(0.35);
      if (orb && ev.type === 'done' && tracker.state !== 'error') orb.pulse(0.3);
    } catch (err) {
      console.error('[jarvis] событие не обработано', ev && ev.type, err);
    }
  }

  // ── Команды: вкладки «Мои» и «Библиотека» ─────────────────────
  // Разметка раздела пересобрана под дизайн-систему Nox (renderer/nox-commands.css):
  // данные, IPC и правила остались прежними, изменились только строки отрисовки.
  const CMD_TABS = ['mine', 'lib'];
  let cmdTab = CMD_TABS.includes(store.get('cmdTab', 'mine')) ? store.get('cmdTab', 'mine') : 'mine';

  function setCmdTab(tab, focus) {
    if (!CMD_TABS.includes(tab)) tab = 'mine';
    cmdTab = tab;
    store.set('cmdTab', tab);
    for (const b of $$('#cmdLists [role="tab"]')) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    $('#panelMine').hidden = tab !== 'mine';
    $('#panelLib').hidden = tab !== 'lib';
    // «Новая» и поиск «Моих» — только на «Моих», поиск библиотеки — только в «Библиотеке».
    $('#cmdNew').hidden = tab !== 'mine';
    $('#cmdSearchWrap').hidden = tab !== 'mine';
    $('#libSearchWrap').hidden = tab !== 'lib';
  }

  function initCmdTabs() {
    const tabs = $$('#cmdLists [role="tab"]');
    for (const b of tabs) b.addEventListener('click', () => setCmdTab(b.dataset.tab));
    $('#cmdLists [role="tablist"]').addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      let j = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j >= 0) { e.preventDefault(); setCmdTab(tabs[j].dataset.tab, true); }
    });
    setCmdTab(cmdTab);
  }

  // Строка результата запуска: «Выполнено: …» или «Не получилось: …», со значком.
  function resultNode(res, cls) {
    return el('p', { class: cls || 'run-line', 'data-ok': res.ok ? 'yes' : 'no' },
      icon(res.ok ? 'check' : 'alert'),
      el('span', { text: res.text }));
  }

  // ── Библиотека команд ─────────────────────────────────────────
  const L = { list: [], q: '', note: '', results: new Map(), running: null };

  function normLib(c) {
    if (!c || typeof c !== 'object' || !c.id) return null;
    return {
      id: String(c.id),
      title: String(c.title || c.id),
      category: String(c.category || 'Разное'),
      phrases: Array.isArray(c.phrases) ? c.phrases.map(String).filter(Boolean) : [],
      risk: typeof c.risk === 'string' ? c.risk : '',
      description: c.description ? String(c.description) : '',
      args: Array.isArray(c.args) ? c.args.map(String).filter(Boolean) : [],
      values: {},
    };
  }

  async function loadLibrary() {
    if (!has('libraryList')) {
      L.list = [];
      L.note = 'Библиотека недоступна в этой версии ядра.';
    } else {
      try {
        const r = await call('libraryList');
        const prev = new Map(L.list.map((c) => [c.id, c.values]));
        L.list = (Array.isArray(r) ? r : []).map(normLib).filter(Boolean);
        for (const c of L.list) c.values = prev.get(c.id) || {};
        L.note = '';
      } catch (e) {
        L.list = [];
        L.note = 'Библиотека не загрузилась: ' + errText(e);
      }
    }
    U.registerTitles(Object.fromEntries(L.list.map((c) => ['lib_' + c.id, c.title])));
    renderLibrary();
    renderQuickChips();
  }

  function renderLibrary() {
    const note = $('#libNote');
    note.textContent = L.note;
    note.hidden = !L.note;
    $('#libCount').textContent = String(L.list.length);
    const q = L.q;
    const match = (c) => !q || (c.title + ' ' + c.category + ' ' + c.description + ' ' + c.phrases.join(' ')).toLowerCase().includes(q);
    const groups = new Map();
    for (const c of L.list) {
      if (!match(c)) continue;
      if (!groups.has(c.category)) groups.set(c.category, []);
      groups.get(c.category).push(c);
    }
    const box = $('#libGroups');
    if (!groups.size) {
      fill(box, L.note ? null : el('p', { class: 'muted lib-none', text: L.list.length ? 'Ничего не нашлось. Измените запрос.' : 'Библиотека пуста.' }));
      return;
    }
    box.replaceChildren(...Array.from(groups, ([cat, items]) => el('details', { class: 'lib-group', open: true },
      el('summary', { class: 'lib-group-head' },
        el('span', { class: 'lib-chev', 'data-icon': 'chevron', 'aria-hidden': 'true' }),
        el('span', { class: 'lib-group-name', text: cat }),
        el('span', { class: 'lib-group-count', text: `${items.length} ${U.plural(items.length, ['команда', 'команды', 'команд'])}` })),
      el('ul', { class: 'lib-list' }, items.map(libItem)))));
    U.fillIcons(box);
  }

  function libItem(c) {
    const res = L.results.get(c.id);
    const busy = L.running === c.id;
    const argsBox = c.args.length
      ? el('div', { class: 'lib-args' }, c.args.map((a) => {
        const id = `lib-${c.id}-${a}`.replace(/[^\w-]/g, '_');
        const inp = el('input', { id, class: 'input input-sm', type: 'text', maxlength: 500, placeholder: a });
        inp.value = c.values[a] || '';
        inp.addEventListener('input', () => { c.values[a] = inp.value; });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runLibrary(c); } });
        return el('label', { class: 'lib-arg', for: id }, el('span', { class: 'lib-arg-name', text: a }), inp);
      }))
      : null;
    return el('li', { class: 'lib-item', 'data-lib': c.id },
      el('div', { class: 'lib-main' },
        el('div', { class: 'lib-title-row' },
          el('span', { class: 'lib-title', text: c.title }),
          riskNode(c.risk)),
        c.description ? el('p', { class: 'lib-desc', text: c.description }) : null,
        c.phrases.length ? el('div', { class: 'lib-phrases', title: c.phrases.join(', ') }, c.phrases.slice(0, 3).map((p) => el('span', { class: 'phrase', text: `«${p}»` }))) : null,
        argsBox,
        res ? resultNode(res, 'run-line lib-result') : null),
      el('button', {
        class: 'lib-run' + (busy ? ' is-busy' : ''), type: 'button', disabled: busy || !has('libraryRun'),
        title: has('libraryRun') ? 'Запустить «' + c.title + '»' : 'Запуск недоступен в этой версии ядра',
        'aria-label': 'Запустить «' + c.title + '»',
        onclick: () => runLibrary(c),
      }, icon(busy ? 'spinner' : 'play'), busy ? 'Выполняю' : 'Запустить'));
  }

  function resultText(r) {
    if (!r) return '';
    if (typeof r.output === 'string' && U.cleanSummary(r.output)) return U.cleanSummary(r.output);
    if (Array.isArray(r.results)) {
      return r.results.map((x) => (x && U.cleanSummary(x.summary)) || '').filter(Boolean).join(' · ');
    }
    return '';
  }

  async function runLibrary(c) {
    if (L.running) return;
    if (tracker.busy) {
      L.results.set(c.id, { ok: false, text: 'Не получилось: Джарвис занят. Дождитесь конца хода.' });
      renderLibrary();
      return;
    }
    const values = {};
    for (const a of c.args) values[a] = String(c.values[a] || '').trim();
    const missing = c.args.filter((a) => !values[a]);
    if (missing.length) {
      L.results.set(c.id, { ok: false, text: 'Заполните: ' + missing.map((key) => ARG_LABELS[key] || 'параметр действия').join(', ') });
      renderLibrary();
      const first = $(`#${CSS.escape(`lib-${c.id}-${missing[0]}`.replace(/[^\w-]/g, '_'))}`);
      if (first) first.focus();
      return;
    }
    L.running = c.id;
    L.results.delete(c.id);
    renderLibrary();
    let r;
    let err = '';
    try {
      r = await call('libraryRun', c.id, values);
      if (!r || r.ok === false) err = r && r.error ? (r.error === 'busy' ? 'Джарвис занят' : String(r.error)) : '';
    } catch (e) {
      err = errText(e);
    }
    L.running = null;
    const out = resultText(r).replace(/^выполнено:?\s*/i, '');
    const ok = !err && r && r.ok !== false;
    L.results.set(c.id, {
      ok,
      text: ok ? 'Выполнено' + (out ? ': ' + out : '') : 'Не получилось' + (err || out ? ': ' + U.scrub(err || out) : ''),
    });
    renderLibrary();
    // Перерисовка карточек снимает фокус — возвращаем его на кнопку запуска.
    if (document.activeElement === document.body) {
      const b = $('#libGroups [data-lib="' + CSS.escape(c.id) + '"] .lib-run');
      if (b) b.focus();
    }
  }

  function initLibrary() {
    $('#libSearch').addEventListener('input', (e) => { L.q = e.target.value.trim().toLowerCase(); renderLibrary(); });
  }

  // ── Мои команды ───────────────────────────────────────────────
  const K = {
    list: [],
    catalog: [],
    byName: new Map(),
    catalogNote: '',
    selectedId: null,
    draft: null,
    dirty: false,
    armTimer: 0,
    q: '',
    recording: false,
    importToken: null,
    shownCount: 0,
  };

  function normCmd(c) {
    if (!c || typeof c !== 'object') return null;
    return {
      id: c.id ?? null,
      name: String(c.name || ''),
      phrases: Array.isArray(c.phrases) ? c.phrases.map((p) => String(p)).filter(Boolean) : [],
      steps: Array.isArray(c.steps)
        ? c.steps.map((s) => ({
          tool: String((s && s.tool) || ''),
          args: s && s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? { ...s.args } : {},
        }))
        : [],
      enabled: c.enabled !== false,
      lastRunAt: c.lastRunAt || null,
      folder: c.folder ? String(c.folder) : null,
      collections: Array.isArray(c.collections) ? c.collections.map((x) => String(x)).filter(Boolean) : [],
      hotkey: c.hotkey ? String(c.hotkey) : null,
      origin: c.origin ? String(c.origin) : 'manual',
      updatedAt: c.updatedAt || null,
    };
  }

  const clone = (c) => JSON.parse(JSON.stringify(c));

  function draftTitle(d) {
    if (!d) return '';
    if (d.id === null) return d.name.trim() || 'Новая команда';
    return d.name.trim() || 'Команда';
  }

  async function loadCatalog() {
    if (!has('toolCatalog')) {
      K.catalog = [];
      K.catalogNote = 'Каталог инструментов недоступен: эта версия ядра его не отдаёт.';
    } else {
      try {
        const r = await call('toolCatalog');
        K.catalog = (Array.isArray(r) ? r : []).filter((t) => t && typeof t.name === 'string');
        K.catalogNote = K.catalog.length ? '' : 'Каталог инструментов пуст.';
      } catch (e) {
        K.catalog = [];
        K.catalogNote = 'Каталог инструментов не загрузился: ' + errText(e);
      }
    }
    K.byName = new Map(K.catalog.map((t) => [t.name, t]));
    if (K.draft) renderSteps();
  }

  // Паки: карточки из ядра (describePacks). «Установить» ставит команды пака по клику и не запускает их.
  async function renderPacks() {
    const listBox = $('#cmdPacksList');
    const sub = $('#cmdPacksSub');
    if (!listBox) return;
    if (!has('installPack')) {
      listBox.replaceChildren(el('p', { class: 'nox-packs-empty', text: 'Готовые паки недоступны в этой версии ядра.' }));
      if (sub) sub.textContent = 'Установка по клику';
      return;
    }
    let packs = [];
    let err = '';
    try {
      const r = await call('installPack');
      if (r && r.ok && Array.isArray(r.packs)) packs = r.packs;
      else if (r && r.ok === false) err = String(r.error || '');
    } catch (e) { err = errText(e); }
    if (sub) {
      sub.textContent = packs.length
        ? `${packs.length} ${U.plural(packs.length, ['пак', 'пака', 'паков'])} · установка по клику`
        : 'Установка по клику';
    }
    if (err) {
      listBox.replaceChildren(el('p', { class: 'nox-packs-empty', text: 'Паки не загрузились: ' + U.scrub(err) }));
      return;
    }
    if (!packs.length) {
      listBox.replaceChildren(el('p', { class: 'nox-packs-empty', text: 'Паков пока нет.' }));
      return;
    }
    listBox.replaceChildren(...packs.map(packCard));
    U.fillIcons(listBox);
  }

  function packCard(p) {
    const total = Number(p.total) || 0;
    const installed = Number(p.installed) || 0;
    const all = total > 0 && installed >= total;
    const card = el('article', { class: 'pack-card', dataset: { pack: String(p.id || '') } });
    if (all) card.dataset.state = 'installed';

    const head = el('div', { class: 'pack-head' }, el('h3', { text: p.title || String(p.id || '') }));

    const stateText = all ? 'Все установлено' : installed ? `Установлено ${installed} из ${total}` : 'Не установлено';
    const meta = el('p', { class: 'pack-meta' },
      el('span', { class: 'pack-count', text: `${total} ${U.plural(total, ['команда', 'команды', 'команд'])}` }),
      el('span', { class: 'pack-meta-sep', 'aria-hidden': 'true', text: '·' }),
      el('span', { class: 'pack-state', text: stateText }));
    const hint = p.hint ? el('p', { class: 'pack-hint', text: p.hint }) : null;

    const btn = el('button', { class: 'pack-install', type: 'button' });
    if (all) {
      btn.textContent = '✓ Установлено';
      btn.disabled = true;
      btn.title = 'Все команды пака уже установлены';
    } else if (installed) {
      btn.textContent = 'Дополнить';
      btn.dataset.variant = 'secondary';
      btn.title = `Установить недостающие команды пака «${p.title}»`;
    } else {
      btn.textContent = 'Установить';
      btn.title = `Установить команды пака «${p.title}» — без запуска`;
    }
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await call('installPack', p.id);
        if (!r || !r.ok) throw new Error((r && r.error) || 'не получилось');
        toast(r.added ? `«${p.title}»: добавлено ${r.added}` : `«${p.title}» уже установлен`, r.added ? 'ok' : undefined);
        await loadCommands();
      } catch (e) {
        toast('Не получилось: ' + errText(e), 'error');
        btn.disabled = false;
      }
    });

    const details = el('details', { class: 'pack-list' },
      el('summary', { text: 'Что внутри' }),
      el('ul', {}, (p.commands || []).map((c) => el('li', {},
        el('span', { text: c.name }),
        el('span', { class: 'pack-phrase', text: `«${c.phrase}»` })))));

    card.append(head, meta, hint, el('div', { class: 'pack-foot' }, btn), details);
    return card;
  }

  async function loadCommands() {
    const note = $('#cmdApiNote');
    const loading = $('#cmdLoading');
    note.hidden = true;
    if (loading) loading.hidden = false;
    if (!has('listCommands')) {
      K.list = [];
      note.textContent = 'Эта версия ядра ещё не хранит команды.';
      note.hidden = false;
    } else {
      try {
        const r = await call('listCommands');
        const arr = Array.isArray(r) ? r : (r && Array.isArray(r.commands) ? r.commands : []);
        K.list = arr.map(normCmd).filter(Boolean);
      } catch (e) {
        K.list = [];
        note.textContent = 'Команды не загрузились: ' + errText(e);
        note.hidden = false;
      }
    }
    if (loading) loading.hidden = true;
    $('#cmdNew').disabled = !has('saveCommand');
    renderCmdList();
    renderPacks();
    if (!K.draft) renderEditor();
  }

  const stepsLabel = (n) => `${n} ${U.plural(n, ['шаг', 'шага', 'шагов'])}`;
  const phrasesLabel = (n) => `${n} ${U.plural(n, ['фраза', 'фразы', 'фраз'])}`;

  // Раскрытые в списке команды; живёт, пока открыто окно.
  const cmdOpen = new Set();

  // Превью шагов в раскрытой строке: одна строка моноширинным, как в макете.
  function describeCommandStep(step) {
    if (!step.tool) return 'Действие не выбрано';
    const args = step.args || {};
    if (step.tool === 'ui_keys') {
      const keys = typeof args.keys === 'string' ? args.keys.trim() : '';
      if (!keys) return 'Нажать клавиши';
      const chord = keys.split('+').map((key) => ({ win: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' })[key.toLowerCase()] || key.toUpperCase()).join('+');
      return `Нажать ${chord}${chord === 'Win+L' ? ' — заблокировать экран' : ''}`;
    }
    const brief = U.humanize(U.argsBrief(args, 80));
    return U.toolTitle(step.tool) + (brief ? ': ' + brief : '');
  }

  function cmdStepsPreview(c, listId) {
    const box = el('div', { class: 'cmd-steps cmd-steps-preview', id: listId });
    c.steps.forEach((step, i) => box.append(el('span', { class: 'cmd-step', text: `${i + 1}. ${describeCommandStep(step)}` })));
    if (!c.steps.length) box.append(el('span', { text: 'шагов нет' }));
    return box;
  }

  function renderCmdList() {
    const list = $('#cmdList');
    if (!list) return;
    const canSave = has('saveCommand');
    const canRun = has('runCommand');
    const q = String(K.q || '').trim().toLowerCase();
    const shown = q
      ? K.list.filter((c) => c.name.toLowerCase().includes(q)
        || (c.folder || '').toLowerCase().includes(q)
        || c.phrases.some((p) => p.toLowerCase().includes(q)))
      : K.list;
    list.replaceChildren(...window.CmdSteps.groupCommands(shown).map((group) =>
      el('li', { class: 'cmd-shelf' },
        el('h3', { text: group.folder ? group.title : 'Общие' }),
        el('ul', { class: 'cmd-shelf-items' }, group.commands.map((c) => cmdRow(c, canSave, canRun))))));
    U.fillIcons(list);

    const noteShown = !$('#cmdApiNote').hidden;
    $('#cmdCount').textContent = String(K.list.length);
    const noResults = $('#cmdNoResults');
    if (noResults) noResults.hidden = !(q && !shown.length && !noteShown);
    const empty = $('#cmdEmpty');
    if (empty) empty.hidden = noteShown || Boolean(q) || shown.length > 0;
    const tree = $('#cmdTreeNote');
    if (tree) { tree.textContent = ''; tree.hidden = true; }
  }

  function cmdRow(c, canSave, canRun) {
    const name = c.name || 'Без имени';
    const open = cmdOpen.has(c.id);
    const stepsId = `cmdSteps-${c.id}`;
    const sw = el('input', { type: 'checkbox', role: 'switch', class: 'switch', 'aria-label': `Команда «${name}» включена` });
    sw.checked = c.enabled;
    sw.disabled = !canSave;
    sw.title = c.enabled ? 'Включена: срабатывает на фразу' : 'Выключена: не срабатывает на фразу';
    sw.addEventListener('change', () => toggleCommand(c, sw));
    const ORIGIN_WORD = { recorded: 'запись', ai: 'из описания', imported: 'импорт', sample: 'пример' };
    const meta = [
      c.folder || '',
      c.hotkey || '',
      stepsLabel(c.steps.length),
      ORIGIN_WORD[c.origin] || '',
      c.enabled ? '' : 'выключена',
    ].filter(Boolean).join(' · ');
    const item = el('li', {
      class: 'cmd-item'
        + (c.enabled ? '' : ' is-off')
        + (open ? ' is-open' : '')
        + (K.selectedId !== null && c.id === K.selectedId ? ' is-selected' : ''),
    },
    el('button', {
      class: 'cmd-toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': stepsId,
      'aria-label': `${open ? 'Свернуть' : 'Показать'} шаги «${name}»`, title: open ? 'Свернуть шаги' : 'Показать шаги',
      onclick: () => {
        if (open) cmdOpen.delete(c.id); else cmdOpen.add(c.id);
        renderCmdList();
        const again = document.querySelector(`[aria-controls="${stepsId}"]`);
        if (again) again.focus();
      },
    }, icon('chevron')),
    el('div', { class: 'cmd-main' },
      el('div', { class: 'cmd-name-row' },
        el('button', { class: 'cmd-name', type: 'button', text: name, title: 'Открыть в редакторе', onclick: () => selectCommand(c.id) })),
      el('div', { class: 'cmd-phrases cmd-row-chips', title: c.phrases.join(', ') },
        c.phrases.length
          ? c.phrases.slice(0, 3).map((p) => el('span', { class: 'phrase', text: p }))
          : el('span', { class: 'muted', text: 'без фраз' })),
      el('div', {
        class: 'cmd-meta',
        title: c.lastRunAt ? 'Запускалась ' + U.absTime(c.lastRunAt) : '',
        text: meta,
      }),
      open ? cmdStepsPreview(c, stepsId) : null),
    el('div', { class: 'cmd-controls' },
      el('button', {
        class: 'cmd-run', type: 'button', disabled: !canRun || !c.enabled,
        title: !c.enabled ? 'Команда выключена' : !canRun ? 'Запуск недоступен в этой версии ядра' : 'Запустить сейчас',
        'aria-label': `Запустить «${name}»`,
        onclick: (e) => { e.stopPropagation(); runCommand(c, e.currentTarget); },
      }, el('span', { class: 'btn-label', text: 'Запустить' })),
      el('label', { class: 'cmd-enabled' }, sw, el('span', { text: c.enabled ? 'Включена' : 'Выключена' }))));
    item.addEventListener('click', (e) => {
      if (e.target.closest('button, input, label')) return;
      selectCommand(c.id);
    });
    return item;
  }

  async function confirmLeave() {
    if (!K.dirty) return true;
    return ask('Изменения не сохранены', 'Выйти без сохранения?', 'Выйти', 'Остаться');
  }

  async function selectCommand(id) {
    if (K.draft && K.draft.id === id && id !== null) {
      $('#commands').classList.add('is-editing');
      setCrumbSub(draftTitle(K.draft));
      return;
    }
    if (!(await confirmLeave())) return;
    const c = K.list.find((x) => x.id === id);
    if (!c) return;
    K.selectedId = id;
    K.draft = clone(c);
    K.dirty = false;
    openEditor();
  }

  async function newCommand() {
    if (!has('saveCommand')) return;
    if (!(await confirmLeave())) return;
    setCmdTab('mine');
    K.selectedId = null;
    K.draft = { id: null, name: '', phrases: ['рабочее утро'], steps: [{ tool: '', args: {} }], enabled: true, lastRunAt: null, folder: null, hotkey: null, origin: 'manual', warnings: [] };
    K.dirty = false;
    openEditor();
    $('#cmdName').focus();
  }

  function openEditor() {
    $('#commands').classList.add('is-editing');
    $('#cmdRunResult').hidden = true;
    renderEditor();
    renderCmdList();
    $('.view-commands').scrollTop = 0;
  }

  async function closeEditor() {
    if (!(await confirmLeave())) return;
    K.draft = null;
    K.selectedId = null;
    K.dirty = false;
    $('#commands').classList.remove('is-editing');
    renderEditor();
    renderCmdList();
  }

  function markDirty() {
    K.dirty = true;
    $('#cmdDirty').hidden = false;
    const res = $('#cmdRunResult');
    if (res) { res.hidden = true; res.replaceChildren(); }
    renderEditorButtons();
    renderEditorSide();
  }

  function showCmdError(text, focusEl) {
    const box = $('#cmdError');
    box.textContent = text || '';
    box.hidden = !text;
    for (const x of $$('#cmdEditor [aria-invalid="true"]')) x.removeAttribute('aria-invalid');
    if (focusEl) {
      focusEl.setAttribute('aria-invalid', 'true');
      focusEl.focus();
    }
  }

  function renderTitles() {
    const t = draftTitle(K.draft);
    $('#cmdEditorTitle').textContent = t;
    if (S.view === 'commands') setCrumbSub(K.draft ? t : '');
  }

  // Подписи полей аргументов: технический ключ остаётся в hint, человеку — слово.
  const ARG_LABELS = {
    name: 'Приложение',
    ms: 'Задержка, мс',
    keys: 'Клавиши',
    window: 'Окно',
    text: 'Текст',
    percent: 'Громкость, %',
  };

  function renderEditor() {
    const d = K.draft;
    $('#cmdEditor').hidden = !d;
    renderTitles();
    if (!d) return;
    $('#cmdName').value = d.name;
    $('#cmdDirty').hidden = !K.dirty;
    // Папка, горячая клавиша, происхождение и предупреждения записи.
    const folder = $('#cmdFolder');
    if (folder) folder.value = d.folder || '';
    const hotkey = $('#cmdHotkey');
    if (hotkey) hotkey.value = d.hotkey || '';
    const origin = $('#cmdOrigin');
    const originText = $('#cmdOriginText');
    if (origin && originText) {
      const words = { manual: 'Создана вручную', recorded: 'Записана с ваших действий', ai: 'Собрана из описания', sample: 'Готовый пример', imported: 'Импортирована из файла' };
      originText.textContent = words[d.origin] || '';
      origin.hidden = !originText.textContent;
    }
    const warn = $('#cmdWarnings');
    const warnText = $('#cmdWarningsText');
    if (warn && warnText) {
      const list = Array.isArray(d.warnings) ? d.warnings.filter(Boolean) : [];
      warnText.textContent = list.length ? 'Проверьте перед сохранением: ' + list.join('; ') : '';
      warn.hidden = !list.length;
    }
    showCmdError('');
    disarmDelete();
    renderPhrases();
    renderSteps();
    renderEditorButtons();
    renderEditorSide();
  }

  function renderEditorButtons() {
    const d = K.draft;
    if (!d) return;
    const save = $('#cmdSave');
    if (save) save.disabled = !has('saveCommand');
    const run = $('#cmdRun');
    if (run) {
      run.disabled = d.id === null || K.dirty || !has('runCommand');
      run.title = d.id === null || K.dirty ? 'Сначала сохраните команду' : 'Запустить сейчас';
    }
    const del = $('#cmdDelete');
    if (del) {
      del.hidden = d.id === null;
      del.disabled = !has('deleteCommand');
    }
  }

  function renderPhrases() {
    const d = K.draft;
    $('#cmdPhrases').replaceChildren(...d.phrases.map((p, i) => el('span', { class: 'chip', role: 'listitem' },
      el('span', { class: 'chip-text', title: p, text: p }),
      el('button', {
        type: 'button', 'aria-label': `Удалить фразу «${p}»`, title: 'Удалить фразу',
        onclick: () => { d.phrases.splice(i, 1); renderPhrases(); markDirty(); },
      }, icon('x')))));
    $('#cmdPhraseCount').textContent = `${d.phrases.length} / ${MAX_PHRASES}`;
    const full = d.phrases.length >= MAX_PHRASES;
    $('#cmdPhraseInput').disabled = full;
    $('#cmdPhraseAdd').disabled = full;
    $('#cmdPhraseInput').placeholder = full ? 'Не больше 5 фраз' : 'Добавить фразу';
  }

  function addPhrase() {
    const d = K.draft;
    const inp = $('#cmdPhraseInput');
    const val = inp.value.replace(/\s+/g, ' ').trim();
    if (!val) return;
    if (d.phrases.length >= MAX_PHRASES) { showCmdError('Не больше 5 фраз на команду.', inp); return; }
    if (d.phrases.some((p) => p.toLowerCase() === val.toLowerCase())) { showCmdError(`Фраза «${val}» уже есть в этой команде.`, inp); return; }
    d.phrases.push(val);
    inp.value = '';
    showCmdError('');
    renderPhrases();
    markDirty();
    inp.focus();
  }

  function schemaOf(toolName) {
    const t = K.byName.get(toolName);
    const p = t && t.parameters && typeof t.parameters === 'object' ? t.parameters : null;
    return {
      tool: t || null,
      props: p && p.properties && typeof p.properties === 'object' ? p.properties : {},
      required: p && Array.isArray(p.required) ? p.required : [],
    };
  }

  function renderSteps() {
    const d = K.draft;
    if (!d) return;
    const note = $('#cmdCatalogNote');
    note.textContent = K.catalogNote;
    note.hidden = !K.catalogNote;
    $('#cmdSteps').replaceChildren(...d.steps.map((s, i) => stepNode(s, i, d.steps.length)));
    $('#cmdStepCount').textContent = String(d.steps.length);
    const add = $('#cmdStepAdd');
    add.disabled = d.steps.length >= MAX_STEPS;
    add.title = d.steps.length >= MAX_STEPS ? `Достигнут лимит ${MAX_STEPS} шагов` : 'Выбрать действие для нового шага';
    renderEditorSide();
  }

  function stepNode(step, i, total) {
    const { tool, props, required } = schemaOf(step.tool);
    const change = el('button', { type: 'button', class: 'nox-btn step-change', text: step.tool ? 'Сменить действие' : 'Выбрать действие', onclick: () => openActionPicker(i) });

    const d = K.draft;
    const move = (dir) => {
      const j = i + dir;
      if (j < 0 || j >= d.steps.length) return;
      d.steps = window.CmdSteps.moveStep(d.steps, i, dir);
      renderSteps();
      markDirty();
      const li = $$('#cmdSteps .step')[j];
      if (li) $(dir < 0 ? '[data-move="up"]' : '[data-move="down"]', li)?.focus();
    };

    const args = el('div', { class: 'step-args' });
    let keys = Object.keys(props);
    if (!tool) keys = Object.keys(step.args);
    for (const key of keys) args.append(argField(step, key, tool ? props[key] || {} : { type: 'string' }, required.includes(key), i));

    const title = step.tool && !tool ? 'Действие недоступно' : describeCommandStep(step);

    return el('li', { class: 'step' },
      el('div', { class: 'step-head' },
        el('span', { class: 'step-num', text: String(i + 1) }),
        el('span', { class: 'step-title', text: title }),
        tool && /^T[23]$/.test(tool.risk || '') ? riskNode(tool.risk) : null,
        el('div', { class: 'step-tools' },
          el('button', { class: 'icon-btn', type: 'button', 'data-move': 'up', title: 'Выше', 'aria-label': `Шаг ${i + 1} выше`, disabled: i === 0, onclick: () => move(-1) }, icon('up')),
          el('button', { class: 'icon-btn', type: 'button', 'data-move': 'down', title: 'Ниже', 'aria-label': `Шаг ${i + 1} ниже`, disabled: i === total - 1, onclick: () => move(1) }, icon('down')),
          el('button', {
            class: 'icon-btn', type: 'button', title: 'Удалить шаг', 'aria-label': `Удалить шаг ${i + 1}`,
            onclick: () => { d.steps.splice(i, 1); renderSteps(); markDirty(); },
          }, icon('x')))),
      args, change,
      step.tool ? el('details', { class: 'collection-details' },
        el('summary', { text: 'Подробнее' }),
        el('p', { text: step.tool }),
        tool?.description ? el('p', { text: tool.description }) : null,
        step.tool === 'ui_keys' && props.keys?.description ? el('p', { text: props.keys.description }) : null) : null);
  }

  function argField(step, key, spec, req, stepIndex) {
    const id = `arg-${stepIndex}-${key}`.replace(/[^\w-]/g, '_');
    const type = Array.isArray(spec.type) ? spec.type[0] : spec.type;
    const label = el('label', { class: 'arg-label', for: id },
      el('span', { text: ARG_LABELS[key] || 'Параметр действия' }),
      req ? el('span', { class: 'req', 'aria-hidden': 'true', text: '*' }) : null);
    const hints = [];
    if (type === 'integer' || type === 'number') {
      if (spec.minimum !== undefined && spec.maximum !== undefined) hints.push(`от ${spec.minimum} до ${spec.maximum}`);
    }
    if (spec.description && !(step.tool === 'ui_keys' && key === 'keys')) hints.push(U.humanize(spec.description));
    const hint = hints.length ? el('span', { class: 'arg-hint', text: hints.join(' · ') }) : null;
    const cur = step.args[key];
    const set = (v) => {
      if (v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))) delete step.args[key];
      else step.args[key] = v;
      const title = document.querySelectorAll('#cmdSteps .step-title')[stepIndex];
      if (title) title.textContent = describeCommandStep(step);
      markDirty();
    };

    if (type === 'boolean') {
      const sw = el('input', { id, type: 'checkbox', role: 'switch', class: 'switch' });
      sw.checked = cur === true;
      sw.addEventListener('change', () => set(sw.checked));
      return el('div', { class: 'arg arg-bool' }, label, sw);
    }
    if (Array.isArray(spec.enum)) {
      const sel = el('select', { id, class: 'input', required: req });
      if (!req || cur === undefined) sel.append(el('option', { value: '', text: '—' }));
      for (const v of spec.enum) sel.append(el('option', { value: String(v), text: String(v) }));
      sel.value = cur === undefined ? '' : String(cur);
      sel.addEventListener('change', () => {
        const raw = spec.enum.find((v) => String(v) === sel.value);
        set(sel.value === '' ? undefined : raw);
      });
      return el('div', { class: 'arg' }, label, sel, hint);
    }
    if (type === 'integer' || type === 'number') {
      const inp = el('input', {
        id, class: 'input', type: 'number', inputmode: type === 'integer' ? 'numeric' : 'decimal',
        min: spec.minimum, max: spec.maximum, step: type === 'integer' ? 1 : 'any', required: req,
      });
      inp.value = typeof cur === 'number' ? String(cur) : '';
      inp.addEventListener('input', () => set(inp.value === '' ? undefined : Number(inp.value)));
      return el('div', { class: 'arg' }, label, inp, hint);
    }
    const long = (spec.maxLength || 0) > 300 || ['command', 'text', 'content', 'goal', 'note'].includes(key);
    const inp = long
      ? el('textarea', { id, class: 'input', rows: 2, maxlength: spec.maxLength, required: req })
      : el('input', { id, class: 'input', type: 'text', maxlength: spec.maxLength, required: req });
    inp.value = cur === undefined ? '' : (typeof cur === 'object' ? JSON.stringify(cur) : String(cur));
    inp.addEventListener('input', () => set(inp.value === '' ? undefined : inp.value));
    return el('div', { class: 'arg' + (long ? ' arg-wide' : '') }, label, inp, hint);
  }

  // Готовность одного шага: та же проверка, что при сохранении, но по шагу.
  function stepReadiness(step, i) {
    if (!step.tool) return { state: 'warn', text: 'выберите действие' };
    const { tool, required } = schemaOf(step.tool);
    if (!tool) return { state: 'err', text: 'инструмент недоступен' };
    const missing = required.filter((k) => {
      const v = step.args[k];
      return v === undefined || v === null || v === '';
    });
    if (missing.length) return { state: 'warn', text: 'заполните: ' + missing.map((key) => ARG_LABELS[key] || 'параметр действия').join(', ') };
    return { state: 'ok', text: 'готов к сохранению' };
  }

  // Правая колонка редактора: что уже готово к сохранению. Это подсказка, не запуск.
  function renderEditorSide() {
    const d = K.draft;
    const box = $('#cmdSideReady');
    if (!d || !box) return;
    const rows = d.steps.map((s, i) => {
      const r = stepReadiness(s, i);
      const titleText = `${i + 1}. ${describeCommandStep(s)}`;
      return el('li', { class: 'nox-ready-item' },
        el('span', { class: 'nox-ready-step' },
          el('span', { class: 'nox-dot', dataset: { state: r.state }, 'aria-hidden': 'true' }),
          el('span', { class: 'cmd-title', title: titleText, text: titleText })),
        el('span', { class: 'nox-ready-state', dataset: { state: r.state }, text: r.text }));
    });
    box.replaceChildren(...(rows.length
      ? rows
      : [el('li', { class: 'nox-ready-item' }, el('p', { class: 'nox-result-empty', text: 'Шагов пока нет. Добавьте действие.' }))]));
    const result = $('#cmdRunResult');
    box.hidden = Boolean(result && !result.hidden);
    const sub = $('#cmdSideSub');
    if (sub) sub.textContent = result && !result.hidden ? 'Текст шагов, без запуска' : 'Без запуска — только текст шагов';
  }

  // Ошибки проверки: тексты раздела 9; первое ошибочное поле получает фокус.
  function validateDraft(d) {
    const errs = [];
    const add = (text, field) => errs.push({ text, field });
    if (!d.name.trim()) add('Укажите имя.', () => $('#cmdName'));
    if (!d.phrases.length) add('Добавьте хотя бы одну фразу.', () => $('#cmdPhraseInput'));
    if (!d.steps.length) add('Добавьте хотя бы один шаг.', () => $('#cmdStepAdd'));
    d.steps.forEach((s, i) => {
      const n = i + 1;
      const stepEl = () => $$('#cmdSteps .step')[i];
      if (!s.tool) { add(`Заполните: шаг ${n} — инструмент.`, () => stepEl() && $('.step-change', stepEl())); return; }
      const { tool, required } = schemaOf(s.tool);
      if (!tool) return;
      const fieldEl = (k) => () => $('#' + CSS.escape(`arg-${i}-${k}`.replace(/[^\w-]/g, '_')));
      const missing = required.filter((k) => { const v = s.args[k]; return v === undefined || v === null || v === ''; });
      if (missing.length) add(`Заполните: шаг ${n} — ${missing.map((k) => '«' + (ARG_LABELS[k] || k) + '»').join(', ')}.`, fieldEl(missing[0]));
      for (const [k, spec] of Object.entries(schemaOf(s.tool).props)) {
        const v = s.args[k];
        if (typeof v !== 'number') continue;
        if (!Number.isFinite(v)) add(`Шаг ${n}: «${ARG_LABELS[k] || k}» — нужно число.`, fieldEl(k));
        else if (spec.type === 'integer' && !Number.isInteger(v)) add(`Шаг ${n}: «${ARG_LABELS[k] || k}» — нужно целое число.`, fieldEl(k));
        else if (spec.minimum !== undefined && v < spec.minimum) add(`Шаг ${n}: «${ARG_LABELS[k] || k}» — не меньше ${spec.minimum}.`, fieldEl(k));
        else if (spec.maximum !== undefined && v > spec.maximum) add(`Шаг ${n}: «${ARG_LABELS[k] || k}» — не больше ${spec.maximum}.`, fieldEl(k));
      }
    });
    return errs;
  }

  // «Проверить»: список шагов текстом, без запуска. Сначала проверка полей, как при сохранении.
  function showPreview() {
    const d = K.draft;
    if (!d) return;
    const errs = validateDraft(d);
    if (errs.length) {
      showCmdError(errs.map((e) => e.text).join('\n'), errs[0].field ? errs[0].field() : null);
      return;
    }
    showCmdError('');
    const lines = d.steps.map((step, i) => `${i + 1}. ${describeCommandStep(step)}`);
    const box = $('#cmdRunResult');
    box.hidden = false;
    box.replaceChildren(
      el('p', { class: 'run-line', text: `Без запуска. Шагов: ${lines.length}` }),
      el('ol', { class: 'cmd-steps' }, lines.map((l) => el('li', { class: 'cmd-step', text: l.replace(/^\d+\.\s/, '') }))));
    renderEditorSide();
  }

  async function saveDraft() {
    const d = K.draft;
    if (!d) return;
    const errs = validateDraft(d);
    if (errs.length) {
      const first = errs[0].field && errs[0].field();
      showCmdError(errs.map((e) => e.text).join('\n'), first || null);
      return;
    }
    showCmdError('');
    const payload = {
      name: d.name.trim(),
      phrases: d.phrases.slice(),
      steps: d.steps.map((s) => ({ tool: s.tool, args: { ...s.args } })),
      enabled: d.enabled,
      folder: d.folder || null,
      hotkey: d.hotkey || null,
      origin: d.origin || 'manual',
    };
    if (d.id !== null) payload.id = d.id;
    const btn = $('#cmdSave');
    btn.disabled = true;
    let r;
    try {
      r = await call('saveCommand', payload);
    } catch (e) {
      btn.disabled = false;
      showCmdError('Не получилось сохранить: ' + errText(e));
      return;
    }
    btn.disabled = false;
    if (!r || r.ok === false) {
      const why = (r && r.error) ? String(r.error) : 'ядро не сохранило команду';
      const busyPhrase = /занят/i.test(why) ? d.phrases.find((p) => why.toLowerCase().includes(p.toLowerCase())) : null;
      if (busyPhrase) showCmdError(`Не получилось сохранить: фраза «${busyPhrase}» уже занята.`, $('#cmdPhraseInput'));
      else showCmdError('Не получилось сохранить: ' + why + (/[.!?]$/.test(why) ? '' : '.'));
      return;
    }
    const saved = normCmd(r.command || payload);
    if (saved.id === null && d.id !== null) saved.id = d.id;
    const i = K.list.findIndex((c) => c.id === saved.id);
    if (i >= 0) K.list[i] = saved; else K.list.push(saved);
    K.draft = clone(saved);
    K.selectedId = saved.id;
    K.dirty = false;
    toast(`Команда «${saved.name}» сохранена`, 'ok');
    if (has('listCommands')) await loadCommands();
    else renderCmdList();
    renderEditor();
  }

  function disarmDelete() {
    clearTimeout(K.armTimer);
    const del = $('#cmdDelete');
    if (del) del.classList.remove('is-armed');
    const text = $('#cmdDeleteText');
    if (text) text.textContent = 'Удалить';
  }

  async function deleteDraft() {
    const d = K.draft;
    if (!d || d.id === null) return;
    const del = $('#cmdDelete');
    if (!del.classList.contains('is-armed')) {
      del.classList.add('is-armed');
      $('#cmdDeleteText').textContent = 'Нажмите ещё раз';
      K.armTimer = setTimeout(disarmDelete, 4000);
      return;
    }
    disarmDelete();
    let r;
    try {
      r = await call('deleteCommand', d.id);
    } catch (e) {
      showCmdError('Не получилось удалить: ' + errText(e));
      return;
    }
    if (r && r.ok === false) {
      showCmdError('Не получилось удалить: ' + (r.error ? String(r.error) : 'ядро не удалило команду.'));
      return;
    }
    K.list = K.list.filter((c) => c.id !== d.id);
    toast(`Команда «${d.name}» удалена`, 'ok');
    K.dirty = false;
    K.draft = null;
    K.selectedId = null;
    $('#commands').classList.remove('is-editing');
    if (has('listCommands')) await loadCommands(); else renderCmdList();
    renderEditor();
  }

  function resultLines(results) {
    const arr = Array.isArray(results) ? results : [];
    return arr.map((r, i) => {
      const obj = r && typeof r === 'object' ? r : { ok: Boolean(r), summary: String(r) };
      const status = U.statusOfResult(obj.ok, obj.summary, false, obj.verified);
      const sum = U.cleanSummary(obj.summary);
      return el('li', {},
        U.statusBadge(status),
        el('span', { class: 'mono', text: obj.tool ? U.toolTitle(obj.tool) : `шаг ${i + 1}` }),
        sum ? el('span', { text: U.clip(sum, 140) }) : null);
    });
  }

  async function runCommand(cmd, btn, inEditor) {
    if (!cmd || cmd.id === null) return;
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    let r;
    let err = '';
    try {
      r = await call('runCommand', cmd.id);
      if (!r || r.ok === false) err = (r && r.error) ? (r.error === 'busy' ? 'Джарвис занят' : String(r.error)) : 'команда не выполнена';
    } catch (e) {
      err = errText(e);
    }
    if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    const results = r && Array.isArray(r.results) ? r.results : [];
    const okCount = results.filter((x) => x && x.ok).length;
    const allOk = !err && results.length > 0 && okCount === results.length;
    const head = allOk
      ? { ok: true, text: `Выполнено: ${okCount} из ${results.length} ${U.plural(results.length, ['шага', 'шагов', 'шагов'])}` }
      : { ok: false, text: 'Не получилось: ' + (err && !results.length ? U.scrub(err) : `выполнено ${okCount} из ${results.length}`) };
    if (inEditor) {
      const box = $('#cmdRunResult');
      fill(box, resultNode(head, 'run-line run-head'), results.length ? el('ul', {}, resultLines(results)) : null);
      box.hidden = false;
      renderEditorSide();
    }
    toast(`«${cmd.name}»: ${head.text.charAt(0).toLowerCase() + head.text.slice(1)}`, head.ok ? 'ok' : 'error');
    if (has('listCommands')) {
      await loadCommands();
      if (K.draft && K.draft.id === cmd.id && !K.dirty) {
        const fresh = K.list.find((c) => c.id === cmd.id);
        if (fresh) K.draft.lastRunAt = fresh.lastRunAt;
      }
    }
  }

  async function toggleCommand(cmd, sw) {
    const next = sw.checked;
    sw.disabled = true;
    let err = '';
    try {
      const r = await call('saveCommand', { ...clone(cmd), enabled: next });
      if (!r || r.ok === false) err = (r && r.error) ? String(r.error) : 'ядро не сохранило';
    } catch (e) {
      err = errText(e);
    }
    sw.disabled = false;
    if (err) {
      sw.checked = !next;
      toast('Настройка не сохранилась: ' + err, 'error');
      return;
    }
    cmd.enabled = next;
    if (K.draft && K.draft.id === cmd.id) K.draft.enabled = next;
    renderCmdList();
  }

  // ── Выбор действия для шага ───────────────────────────────────
  // Список — из tools:catalog (сервер отдаёт только разрешённые EDITOR_STEP_TOOLS),
  // категории — локальные подписи к этим инструментам. Ничего не запускается.
  const PICK = { open: false, selected: null, cat: 'all', q: '' };
  const PICK_CATS = [
    { id: 'all', title: 'Все' },
    { id: 'apps', title: 'Программы', tools: ['app_open'] },
    { id: 'keys', title: 'Клавиши', tools: ['ui_keys'] },
    { id: 'time', title: 'Время', tools: ['wait'] },
    { id: 'voice', title: 'Голос', tools: ['speak'] },
    { id: 'sound', title: 'Звук', tools: ['volume_set'] },
    { id: 'other', title: 'Другое', tools: [] },
  ];
  const PICK_ICON = { app_open: 'window', ui_keys: 'key', wait: 'hourglass', speak: 'mic', volume_set: 'volume' };

  function pickerCatOf(name) {
    const found = PICK_CATS.find((c) => c.tools && c.tools.includes(name));
    return found ? found.id : 'other';
  }

  function pickerCategories() {
    const counts = new Map();
    for (const t of K.catalog) {
      const cat = pickerCatOf(t.name);
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    return PICK_CATS
      .filter((c) => c.id === 'all' || (counts.get(c.id) || 0) > 0)
      .map((c) => ({ ...c, count: c.id === 'all' ? K.catalog.length : (counts.get(c.id) || 0) }));
  }

  function pickerTools() {
    const q = PICK.q.toLowerCase();
    return K.catalog.filter((t) => {
      if (PICK.cat !== 'all' && pickerCatOf(t.name) !== PICK.cat) return false;
      if (!q) return true;
      return (t.name + ' ' + U.toolTitle(t.name) + ' ' + (t.description || '')).toLowerCase().includes(q);
    });
  }

  function pickerMarkup() {
    const cats = pickerCategories();
    const list = pickerTools();
    const catsBox = $('#npCats');
    const listBox = $('#npList');
    if (!catsBox || !listBox) return;
    catsBox.replaceChildren(...cats.map((c) => el('button', {
      class: 'nox-picker-cat', type: 'button', role: 'tab', 'aria-current': String(PICK.cat === c.id),
      onclick: () => { PICK.cat = c.id; pickerMarkup(); },
    }, el('span', { text: c.title }), el('span', { class: 'nox-picker-count', text: String(c.count) }))));

    if (!list.length) {
      listBox.replaceChildren(el('p', { class: 'nox-picker-empty', text: PICK.q ? 'Ничего не нашлось.' : 'В каталоге нет действий.' }));
      PICK.selected = null;
    } else {
      listBox.replaceChildren(...list.map((t) => {
        const item = el('button', {
          class: 'nox-picker-item', type: 'button', role: 'option',
          'aria-selected': String(PICK.selected === t.name),
          'data-tool': t.name,
          onclick: () => { PICK.selected = t.name; pickerMarkup(); },
          ondblclick: () => addPickedTool(t.name),
        },
        icon(PICK_ICON[t.name] || 'bolt'),
        el('span', { class: 'nox-picker-item-body' },
          el('span', { class: 'nox-picker-item-name', text: U.toolTitle(t.name) }),
          el('span', { class: 'nox-picker-item-desc', text: t.name === 'ui_keys' ? 'Нажать клавишу или сочетание, например Win+L.' : U.clip(U.humanize(t.description || 'Добавить это действие в команду.'), 130) })));
        return item;
      }));
    }
    U.fillIcons(listBox);
    const add = $('#npAdd');
    add.disabled = !PICK.selected;
    add.textContent = PICK.index !== null ? 'Выбрать действие' : 'Добавить действие';
  }

  function openActionPicker(index = null) {
    const d = K.draft;
    if (!d) return;
    if (!Number.isInteger(index)) index = null;
    if (index === null && d.steps.length >= MAX_STEPS) { showCmdError(`Достигнут предел ${MAX_STEPS} шагов.`, $('#cmdStepAdd')); return; }
    PICK.open = true;
    PICK.index = index;
    PICK.selected = index === null ? null : d.steps[index]?.tool || null;
    PICK.cat = 'all';
    PICK.q = '';
    const search = $('#npSearch');
    if (search) search.value = '';
    pickerMarkup();
    const dlg = $('#cmdActionDialog');
    if (dlg && !dlg.open) {
      try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
    }
    if (search) search.focus();
  }

  function closeActionPicker(back) {
    PICK.open = false;
    const dlg = $('#cmdActionDialog');
    if (dlg && dlg.open) dlg.close();
    if (back) ($$('#cmdSteps .step-change')[PICK.index] || $('#cmdStepAdd'))?.focus();
  }

  async function addPickedTool(name) {
    const d = K.draft;
    const tool = name || PICK.selected;
    if (!d || !tool) return;
    const index = PICK.index;
    if (index === null && d.steps.length >= MAX_STEPS) { closeActionPicker(true); showCmdError(`Достигнут предел ${MAX_STEPS} шагов.`, $('#cmdStepAdd')); return; }
    const prev = index === null ? null : d.steps[index];
    const props = schemaOf(tool).props;
    const args = Object.fromEntries(Object.entries(prev?.args || {}).filter(([key]) => Object.hasOwn(props, key)));
    closeActionPicker(false);
    if (prev && Object.keys(args).length < Object.keys(prev.args).length
      && !(await ask('Сменить действие?', 'Некоторые заполненные поля будут очищены.', 'Сменить', 'Оставить'))) {
      $$('#cmdSteps .step-change')[index]?.focus();
      return;
    }
    if (K.draft !== d) return;
    if (index === null) d.steps.push({ tool, args });
    else d.steps[index] = { tool, args };
    renderSteps();
    markDirty();
    const idx = index ?? d.steps.length - 1;
    const { required } = schemaOf(tool);
    const key = required[0];
    let focusEl = null;
    if (key) focusEl = $('#' + CSS.escape(`arg-${idx}-${key}`.replace(/[^\w-]/g, '_')));
    if (!focusEl) {
      const steps = $$('#cmdSteps .step');
      focusEl = steps[idx] ? $('.step-change', steps[idx]) : null;
    }
    if (focusEl) {
      focusEl.focus();
      if (typeof focusEl.scrollIntoView === 'function') focusEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function pickerKey(e) {
    if (!PICK.open) return;
    if (e.key === 'Escape') { e.preventDefault(); closeActionPicker(true); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (PICK.selected) addPickedTool(PICK.selected);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = $$('#npList .nox-picker-item', document);
    if (!items.length) return;
    e.preventDefault();
    const at = items.findIndex((x) => x.dataset.tool === PICK.selected);
    let next = e.key === 'ArrowDown' ? at + 1 : at - 1;
    if (at < 0) next = 0;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    PICK.selected = items[next].dataset.tool;
    pickerMarkup();
    const again = $(`#npList .nox-picker-item[data-tool="${CSS.escape(PICK.selected)}"]`);
    if (again) again.scrollIntoView({ block: 'nearest' });
  }

  function initActionPicker() {
    const dlg = $('#cmdActionDialog');
    if (!dlg) return;
    $('#npCancel').addEventListener('click', () => closeActionPicker(true));
    $('#npClose').addEventListener('click', () => closeActionPicker(true));
    $('#npAdd').addEventListener('click', () => addPickedTool(PICK.selected));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeActionPicker(true); });
    dlg.addEventListener('keydown', pickerKey);
    $('#npSearch').addEventListener('input', (e) => {
      PICK.q = e.target.value.trim();
      PICK.cat = 'all';
      pickerMarkup();
    });
  }

  function initCommands() {
    $('#cmdNew').addEventListener('click', newCommand);
    $('#cmdEmptyNew').addEventListener('click', newCommand);
    $('#cmdResetSearch')?.addEventListener('click', () => {
      K.q = '';
      const search = $('#cmdSearch');
      if (search) { search.value = ''; search.focus(); }
      renderCmdList();
    });
    initCmdTabs();
    $('#cmdBack').addEventListener('click', closeEditor);
    $('#cmdCancel').addEventListener('click', closeEditor);
    $('#cmdName').addEventListener('input', (e) => {
      if (!K.draft) return;
      K.draft.name = e.target.value;
      markDirty();
      renderTitles();
    });
    $('#cmdPhraseAdd').addEventListener('click', addPhrase);
    $('#cmdPhraseInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addPhrase(); }
      else if (e.key === 'Backspace' && !e.target.value && K.draft && K.draft.phrases.length) {
        K.draft.phrases.pop();
        renderPhrases();
        markDirty();
      }
    });
    $('#cmdStepAdd').addEventListener('click', openActionPicker);
    $('#cmdCheck').addEventListener('click', showPreview);
    $('#cmdEditor').addEventListener('submit', (e) => { e.preventDefault(); saveDraft(); });
    $('#cmdRun').addEventListener('click', (e) => {
      const c = K.list.find((x) => K.draft && x.id === K.draft.id) || K.draft;
      runCommand(c, e.currentTarget, true);
    });
    $('#cmdDelete').addEventListener('click', deleteDraft);
    initActionPicker();
  }

  // ── Импорт и экспорт команд, запись действий ──────────────────
  async function exportCommands() {
    if (!has('exportCommands')) { toast('Эта версия ядра не умеет выгружать команды.', 'error'); return; }
    let r;
    try { r = await call('exportCommands'); } catch (e) { toast('Экспорт не получился: ' + errText(e), 'error'); return; }
    if (!r || r.ok === false) { toast('Экспорт не получился: ' + U.scrub((r && r.error) || 'причина неизвестна'), 'error'); return; }
    if (r.canceled) return;
    toast('Команды сохранены в файл', 'ok');
  }

  function importCounts(p) {
    const c = (p && p.counts) || {};
    return `добавить ${c.add || 0} · обновить ${c.update || 0} · без изменений ${c.unchanged || 0} · конфликтов ${c.conflict || 0}`;
  }

  async function pickCommandsImport() {
    if (!has('pickCommandsImport')) { toast('Эта версия ядра не умеет импорт команд.', 'error'); return; }
    let r;
    try { r = await call('pickCommandsImport'); } catch (e) { toast('Импорт не начался: ' + errText(e), 'error'); return; }
    if (!r || r.ok === false) { toast('Файл не подошёл: ' + U.scrub((r && r.error) || 'причина неизвестна'), 'error'); return; }
    if (r.canceled) return;
    K.importToken = r.token;
    const dlg = $('#cmdImportDialog');
    $('#ciFrom').textContent = 'Файл: ' + U.scrub(r.file || '');
    $('#ciCount').textContent = `${r.preview.commandCount} ${U.plural(r.preview.commandCount, ['команда', 'команды', 'команд'])}`;
    $('#ciSummary').textContent = importCounts(r.preview);
    const actionWords = { add: 'добавить', update: 'обновить', unchanged: 'без изменений', conflict: 'конфликт' };
    fill($('#ciList'), ...r.preview.items.map((it) => el('li', { class: 'imp-item', 'data-action': it.action },
      U.statusBadge(it.action === 'add' ? 'done' : it.action === 'conflict' ? 'failed' : it.action === 'update' ? 'running' : 'unverified'),
      el('span', { class: 'imp-name', text: it.name || 'Без имени' }),
      el('span', { class: 'imp-action', text: actionWords[it.action] || it.action }),
      it.changes && it.changes.length
        ? el('span', { class: 'imp-changes', text: it.changes.map((c) => `${c.label}: было «${U.clip(String(c.before ?? ''), 40)}», станет «${U.clip(String(c.after ?? ''), 40)}»`).join('; ') })
        : null,
      it.conflicts && it.conflicts.length ? el('span', { class: 'imp-conflicts', text: it.conflicts.join('; ') }) : null)));
    const warn = $('#ciWarn');
    const warnings = Array.isArray(r.preview.warnings) ? r.preview.warnings.filter(Boolean) : [];
    warn.textContent = warnings.join('; ');
    warn.hidden = !warnings.length;
    const conflict = $('#ciConflicts');
    conflict.textContent = r.preview.applicable === false ? 'Есть конфликты: импорт невозможен, пока они не устранены в файле.' : '';
    conflict.hidden = !conflict.textContent;
    $('#ciApply').disabled = r.preview.applicable === false;
    if (!dlg.open) dlg.showModal();
  }

  async function applyCommandsImport() {
    if (!K.importToken) return;
    let r;
    try { r = await call('applyCommandsImport', K.importToken, true); } catch (e) { toast('Импорт не получился: ' + errText(e), 'error'); return; }
    if (!r || r.ok === false) { toast('Импорт не получился: ' + U.scrub((r && r.error) || 'причина неизвестна'), 'error'); return; }
    K.importToken = null;
    const dlg = $('#cmdImportDialog');
    if (dlg.open) dlg.close();
    toast(`Импорт: добавлено ${r.added || 0}, обновлено ${r.updated || 0}, без изменений ${r.unchanged || 0}`, 'ok');
    if (has('listCommands')) await loadCommands();
  }

  // ── Запись действий ───────────────────────────────────────────
  const REC = { steps: [] };

  function renderRecordSteps() {
    const list = $('#cmdRecordSteps');
    if (!list) return;
    if (!REC.steps.length) {
      list.replaceChildren(el('li', { class: 'nox-recording-empty' },
        icon('hourglass'),
        el('span', { text: 'Пока ничего не записано. Выполните действия в программах — шаги появятся здесь.' })));
      return;
    }
    list.replaceChildren(...REC.steps.map((s, i) => el('li', { class: 'cmd-step' },
      el('span', { class: 'step-num', text: String(i + 1) }),
      el('span', { class: 'cmd-step-name', text: U.toolTitle(s.tool) }),
      s.warnings && s.warnings.length ? el('span', { class: 'muted', text: s.warnings.join('; ') }) : null)));
  }

  // Кнопка «Записать» на время записи выключена: повторный старт ничего не делает.
  function setRecordButton(active) {
    const btn = $('#cmdRecord');
    if (!btn) return;
    btn.disabled = active;
    btn.title = active ? 'Запись идёт: остановите её кнопкой в панели записи' : 'Записать действия и превратить их в команду';
  }

  async function startRecording() {
    if (K.recording) return;
    if (!has('recordStart')) { toast('Эта версия ядра не умеет записывать действия.', 'error'); return; }
    let r;
    try { r = await call('recordStart'); } catch (e) { toast('Запись не началась: ' + errText(e), 'error'); return; }
    if (!r || r.ok === false) { toast('Запись не началась: ' + U.scrub((r && r.error) || 'причина неизвестна'), 'error'); return; }
    K.recording = true;
    REC.steps = [];
    $('#commands').classList.add('is-recording');
    $('#cmdRecordPanel').hidden = false;
    $('#cmdRecordError').hidden = true;
    setRecordButton(true);
    renderRecordSteps();
    toast('Запись идёт: выполните действия, затем «Остановить и открыть черновик».', 'ok');
  }

  async function stopRecording() {
    let r;
    try { r = await call('recordStop'); } catch (e) { toast('Запись не остановилась: ' + errText(e), 'error'); return; }
    K.recording = false;
    $('#commands').classList.remove('is-recording');
    $('#cmdRecordPanel').hidden = true;
    setRecordButton(false);
    if (!r || r.ok === false) { toast('Запись не остановилась: ' + U.scrub((r && r.error) || 'причина неизвестна'), 'error'); return; }
    const d = r.draft || {};
    K.draft = {
      id: null,
      name: '',
      phrases: [],
      steps: Array.isArray(d.steps) ? d.steps.map((s) => ({ tool: s.tool, args: { ...(s.args || {}) } })) : [],
      enabled: true,
      lastRunAt: null,
      folder: null,
      hotkey: null,
      origin: 'recorded',
      warnings: Array.isArray(d.warnings) ? d.warnings : [],
    };
    K.selectedId = null;
    K.dirty = true;
    setCmdTab('mine');
    openEditor();
    $('#cmdName').focus();
    toast(`Записано шагов: ${K.draft.steps.length}. Впишите имя и фразы, проверьте шаги и сохраните.`, 'ok');
  }

  async function cancelRecording() {
    try { await call('recordCancel'); } catch { /* запись и так не идёт */ }
    K.recording = false;
    REC.steps = [];
    $('#commands').classList.remove('is-recording');
    $('#cmdRecordPanel').hidden = true;
    setRecordButton(false);
    toast('Запись отменена, ничего не сохранено');
  }

  // ── Память и напоминания (Настройки) ─────────────────────────
  const MEM = { items: [], reminders: [], editing: null };

  const memoryWhen = (ts) => (ts ? U.relTime(ts) : '');

  function renderMemory() {
    const list = $('#memoryList');
    if (!list) return;
    list.replaceChildren(...MEM.items.map((item) => el('li', { class: 'memory-item' },
      el('div', { class: 'memory-text' },
        el('span', { class: 'memory-body', text: U.cleanSummary(item.text || '') }),
        el('span', { class: 'memory-meta', text: [item.about ? 'о: ' + item.about : '', item.kind || '', memoryWhen(item.updatedAt || item.createdAt)].filter(Boolean).join(' · ') })),
      el('div', { class: 'memory-tools' },
        el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Исправить', onclick: () => openMemoryEdit(item) }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Удалить', onclick: () => removeMemory(item) })))));
    $('#memoryCount').textContent = String(MEM.items.length);
    $('#memoryEmpty').hidden = MEM.items.length > 0;
  }

  async function loadMemory() {
    const note = $('#memoryNote');
    if (!note) return;
    note.hidden = true;
    if (!has('memoryList')) {
      note.textContent = 'Эта версия ядра не отдаёт память.';
      note.hidden = false;
      return;
    }
    let r;
    try { r = await call('memoryList', { limit: 200 }); } catch (e) { note.textContent = 'Память не загрузилась: ' + errText(e); note.hidden = false; return; }
    if (!r || r.ok === false) { note.textContent = 'Память не загрузилась: ' + U.scrub((r && r.error) || 'причина неизвестна'); note.hidden = false; return; }
    MEM.items = Array.isArray(r.items) ? r.items : [];
    renderMemory();
  }

  function openMemoryEdit(item) {
    MEM.editing = item;
    $('#memoryEditText').value = String(item.text || '');
    $('#memoryEditAbout').value = String(item.about || '');
    $('#memoryEditError').hidden = true;
    const dlg = $('#memoryDialog');
    if (!dlg.open) dlg.showModal();
    $('#memoryEditText').focus();
  }

  async function saveMemoryEdit() {
    if (!MEM.editing) return;
    const text = $('#memoryEditText').value.trim();
    if (!text) {
      $('#memoryEditError').textContent = 'Текст записи пуст.';
      $('#memoryEditError').hidden = false;
      return;
    }
    let r;
    try { r = await call('memoryUpdate', MEM.editing.id, { text, about: $('#memoryEditAbout').value.trim() }); }
    catch (e) { r = { ok: false, error: errText(e) }; }
    if (!r || r.ok === false) {
      $('#memoryEditError').textContent = 'Не получилось: ' + U.scrub((r && r.error) || 'причина неизвестна');
      $('#memoryEditError').hidden = false;
      return;
    }
    const dlg = $('#memoryDialog');
    if (dlg.open) dlg.close();
    MEM.editing = null;
    await loadMemory();
    toast('Запись памяти исправлена', 'ok');
  }

  async function removeMemory(item) {
    const ok = await ask('Удалить запись памяти?', U.clip(String(item.text || ''), 120), 'Удалить', 'Оставить');
    if (!ok) return;
    let r;
    try { r = await call('memoryRemove', item.id); } catch (e) { r = { ok: false, error: errText(e) }; }
    if (!r || r.ok === false) { toast('Не удалось удалить: ' + U.scrub((r && r.error) || 'причина неизвестна'), 'error'); return; }
    await loadMemory();
    toast('Запись удалена', 'ok');
  }

  async function clearMemory() {
    const ok = await ask('Очистить память этого пространства?', 'Удалятся все записи памяти. Журнал действий останется.', 'Очистить', 'Отмена');
    if (!ok) return;
    let r;
    try { r = await call('memoryClear', true); } catch (e) { r = { ok: false, error: errText(e) }; }
    if (!r || r.ok === false) { toast('Не удалось очистить: ' + U.scrub((r && r.error) || 'причина неизвестна'), 'error'); return; }
    await loadMemory();
    toast(`Память очищена: удалено ${r.removed || 0}`, 'ok');
  }

  function renderReminders() {
    const list = $('#remindersList');
    if (!list) return;
    list.replaceChildren(...MEM.reminders.map((item) => el('li', { class: 'memory-item' },
      el('div', { class: 'memory-text' },
        el('span', { class: 'memory-body', text: U.cleanSummary(item.text || '') }),
        el('span', { class: 'memory-meta', text: [item.dueAt ? U.shortTime(item.dueAt) : '', item.repeat === 'daily' ? 'каждый день' : ''].filter(Boolean).join(' · ') })),
      el('div', { class: 'memory-tools' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Отменить', onclick: () => cancelReminder(item) })))));
    $('#remindersCount').textContent = String(MEM.reminders.length);
    $('#remindersEmpty').hidden = MEM.reminders.length > 0;
  }

  async function loadReminders() {
    const note = $('#remindersNote');
    if (!note) return;
    note.hidden = true;
    if (!has('remindersList')) { note.textContent = 'Эта версия ядра не отдаёт напоминания.'; note.hidden = false; return; }
    let r;
    try { r = await call('remindersList', {}); } catch (e) { note.textContent = 'Напоминания не загрузились: ' + errText(e); note.hidden = false; return; }
    if (!r || r.ok === false) { note.textContent = 'Напоминания не загрузились: ' + U.scrub((r && r.error) || 'причина неизвестна'); note.hidden = false; return; }
    MEM.reminders = Array.isArray(r.items) ? r.items : [];
    renderReminders();
  }

  async function cancelReminder(item) {
    const ok = await ask('Отменить напоминание?', U.clip(String(item.text || ''), 120), 'Отменить напоминание', 'Оставить');
    if (!ok) return;
    let r;
    try { r = await call('remindersCancel', item.id); } catch (e) { r = { ok: false, error: errText(e) }; }
    if (!r || r.ok === false) { toast('Не удалось отменить: ' + U.scrub((r && r.error) || 'причина неизвестна'), 'error'); return; }
    await loadReminders();
    toast('Напоминание отменено', 'ok');
  }

  function initCommandsExtra() {
    const search = $('#cmdSearch');
    if (search) {
      search.addEventListener('input', (e) => { K.q = e.target.value.trim().toLowerCase(); renderCmdList(); });
    }
    const imp = $('#cmdImport');
    if (imp) imp.addEventListener('click', pickCommandsImport);
    const exp = $('#cmdExport');
    if (exp) exp.addEventListener('click', exportCommands);
    const rec = $('#cmdRecord');
    if (rec) rec.addEventListener('click', startRecording);
    const recStop = $('#cmdRecordStop');
    if (recStop) recStop.addEventListener('click', stopRecording);
    const recCancel = $('#cmdRecordCancel');
    if (recCancel) recCancel.addEventListener('click', cancelRecording);
    const ciCancel = $('#ciCancel');
    if (ciCancel) ciCancel.addEventListener('click', () => { K.importToken = null; const d = $('#cmdImportDialog'); if (d.open) d.close(); });
    const ciApply = $('#ciApply');
    if (ciApply) ciApply.addEventListener('click', applyCommandsImport);
    const folder = $('#cmdFolder');
    if (folder) folder.addEventListener('input', (e) => { if (!K.draft) return; K.draft.folder = e.target.value.trim() || null; markDirty(); });
    const hotkey = $('#cmdHotkey');
    if (hotkey) hotkey.addEventListener('input', (e) => { if (!K.draft) return; K.draft.hotkey = e.target.value.trim() || null; markDirty(); });
  }

  function initMemoryAndReminders() {
    const mr = $('#memoryReload');
    if (mr) mr.addEventListener('click', loadMemory);
    const mc = $('#memoryClear');
    if (mc) mc.addEventListener('click', clearMemory);
    const meCancel = $('#memoryEditCancel');
    if (meCancel) meCancel.addEventListener('click', () => { MEM.editing = null; const d = $('#memoryDialog'); if (d.open) d.close(); });
    const meSave = $('#memoryEditSave');
    if (meSave) meSave.addEventListener('click', saveMemoryEdit);
    const rr = $('#remindersReload');
    if (rr) rr.addEventListener('click', loadReminders);
  }

  // ── Голос: громкость, скорость, характер и выбор голоса (Настройки → Ответы) ──
  function renderVoicePersonas(personas, current) {
    const sel = $('#voicePersona');
    if (!sel) return;
    if (Array.isArray(personas) && personas.length > 0) {
      sel.innerHTML = '';
      for (const persona of personas) {
        if (!persona || typeof persona.id !== 'string' || !persona.id) continue;
        const option = document.createElement('option');
        option.value = persona.id;
        option.textContent = persona.name || persona.id;
        if (persona.description) option.title = persona.description;
        sel.appendChild(option);
      }
    }
    if (typeof current === 'string' && current) sel.value = current;
    const hint = $('#voicePersonaHint');
    if (hint) {
      const found = (Array.isArray(personas) ? personas : []).find((persona) => persona && persona.id === sel.value);
      hint.textContent = found && found.description
        ? found.description
        : 'Меняет только темп и громкость, голос остаётся выбранным';
    }
  }

  function renderVoiceOptions(opts = {}) {
    const vol = Number.isFinite(opts.volume) ? Math.min(1, Math.max(0, opts.volume)) : 1;
    const rate = Number.isFinite(opts.rate) ? Math.min(2, Math.max(0.5, opts.rate)) : 1;
    const volEl = $('#voiceVolume');
    if (volEl) {
      volEl.value = String(Math.round(vol * 100));
      const hint = $('#voiceVolumeHint');
      if (hint) hint.textContent = Math.round(vol * 100) + ' %';
    }
    const rateEl = $('#voiceRate');
    if (rateEl) {
      rateEl.value = String(rate);
      const hint = $('#voiceRateHint');
      if (hint) hint.textContent = String(rate).replace('.', ',') + ' из 2';
    }
  }

  async function loadVoiceOptions() {
    const note = $('#voiceOptionsNote');
    if (!note) return;
    if (!has('voiceState')) {
      note.textContent = 'Эта версия ядра не отдаёт настройки голоса.';
      note.hidden = false;
      return;
    }
    try {
      const st = await call('voiceState');
      if (!st || st.ok === false) {
        note.textContent = 'Настройки голоса недоступны.';
        note.hidden = false;
        return;
      }
      renderVoiceOptions(st.options || {});
      renderVoicePersonas(st.personas, st.persona);
      const sel = $('#voiceSpeaker');
      if (sel && st.options && st.options.speaker) sel.value = st.options.speaker;
      const hint = $('#voicePickHint');
      if (hint) {
        const which = st.provider === 'cloud' ? 'облачный голос' : 'локальный голос';
        hint.textContent = st.available
          ? `Сейчас: ${which}. «Список голосов» загрузит голоса модели.`
          : (st.reason || 'Голос не настроен — проверьте ключ или локальный синтез');
      }
      note.hidden = true;
    } catch (err) {
      note.textContent = 'Настройки голоса не загрузились: ' + errText(err);
      note.hidden = false;
    }
  }

  async function loadVoiceList(btn) {
    const note = $('#voiceOptionsNote');
    const sel = $('#voiceSpeaker');
    if (!sel || !note) return;
    if (!has('voiceVoices')) {
      note.textContent = 'Список голосов недоступен в этой версии ядра.';
      note.hidden = false;
      return;
    }
    const was = btn.disabled;
    btn.disabled = true;
    note.textContent = 'Загружаю список голосов…';
    note.hidden = false;
    try {
      const r = await call('voiceVoices');
      if (!r || r.ok === false) {
        note.textContent = 'Список голосов не загрузился: ' + U.scrub((r && r.error) || 'причина неизвестна');
        note.hidden = false;
        return;
      }
      const cur = sel.value;
      const frag = [el('option', { value: '', text: 'По умолчанию' })];
      for (const v of Array.isArray(r.voices) ? r.voices : []) frag.push(el('option', { value: v.id, text: v.title || v.id }));
      sel.replaceChildren(...frag);
      sel.value = (Array.isArray(r.voices) ? r.voices : []).some((v) => v.id === cur) ? cur : '';
      note.textContent = r.voices && r.voices.length ? `Голосов: ${r.voices.length}` : 'Список голосов пуст.';
      note.hidden = false;
    } catch (err) {
      note.textContent = 'Список голосов не загрузился: ' + errText(err);
      note.hidden = false;
    } finally {
      btn.disabled = was;
    }
  }

  async function saveVoiceOption(key, value, label) {
    if (!has('setSetting')) return;
    try {
      const r = await call('setSetting', key, value);
      if (r && r.ok === false) {
        toast('Не сохранилось: ' + U.scrub(r.error || 'ядро отказало'), 'error');
        return;
      }
      if (label) toast(label, 'ok');
    } catch (err) {
      toast('Не сохранилось: ' + errText(err), 'error');
    }
  }

  function initVoiceOptions() {
    const vol = $('#voiceVolume');
    const rate = $('#voiceRate');
    const sel = $('#voiceSpeaker');
    const list = $('#voiceList');
    if (!vol || !rate || !sel || !list) return;
    const volHint = $('#voiceVolumeHint');
    const rateHint = $('#voiceRateHint');
    vol.addEventListener('input', () => { if (volHint) volHint.textContent = vol.value + ' %'; });
    vol.addEventListener('change', () => { if (volHint) volHint.textContent = vol.value + ' %'; saveVoiceOption('voiceVolume', Number(vol.value) / 100, 'Громкость голоса: ' + vol.value + ' %'); });
    rate.addEventListener('input', () => { if (rateHint) rateHint.textContent = String(rate.value).replace('.', ',') + ' из 2'; });
    rate.addEventListener('change', () => { if (rateHint) rateHint.textContent = String(rate.value).replace('.', ',') + ' из 2'; saveVoiceOption('voiceRate', Number(rate.value), 'Скорость речи: ' + String(rate.value).replace('.', ',')); });
    sel.addEventListener('change', () => saveVoiceOption('voiceSpeaker', sel.value, sel.value ? 'Голос выбран' : 'Голос по умолчанию'));
    const persona = $('#voicePersona');
    if (persona) {
      persona.addEventListener('change', () => {
        saveVoiceOption('voicePersona', persona.value, 'Характер речи: ' + (persona.selectedOptions[0] ? persona.selectedOptions[0].textContent : persona.value));
      });
    }
    list.addEventListener('click', () => loadVoiceList(list));
  }

  // ── Запуск ────────────────────────────────────────────────────
  // Каждый шаг запуска изолирован: падение одного не мешает отрисовать остальное.
  function safe(name, fn) {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') {
        return r.catch((e) => console.error(`[jarvis] ${name}:`, e));
      }
      return r;
    } catch (e) {
      console.error(`[jarvis] ${name}:`, e);
      return undefined;
    }
  }

  async function boot() {
    safe('иконки', () => U.fillIcons(document));
    try {
      S.link = await U.ensureBridge();
    } catch {
      S.link = window.jarvis ? 'bridge' : 'none';
    }
    safe('меню', initNav);
    safe('переключатели', initToggles);
    safe('диктовка', initDictation);
    safe('шар', initOrb);
    safe('подтверждения', initApproval);
    safe('диалог', initChat);
    safe('пространства', initWorkspaceControls);
    safe('лоток', initWaitTray);
    safe('миссии', initMissions);
    safe('команды: импорт и запись', initCommandsExtra);
    safe('память и напоминания', initMemoryAndReminders);
    safe('голос: настройки', initVoiceOptions);
    safe('столы', () => { if (window.JarvisDesks) window.JarvisDesks.init({ toast, ask }); });
    safe('расширения', () => { if (window.JarvisExtensions) window.JarvisExtensions.init({ toast, ask }); });
    safe('левая панель', initRail);
    safe('скорость', initTier);
    safe('вид списков', initCollectionViews);
    safe('журнал', initJournal);
    safe('настройки', initSettings);
    safe('тема', initTheme);
    safe('команды', initCommands);
    safe('библиотека', initLibrary);
    safe('раздел', () => show('nox'));
    safe('виджеты', initWidgets);
    safe('виджеты', reloadWidgets);
    safe('переключатели', syncToggles);
    safe('связь', renderLink);
    safe('статус', renderStatus);
    safe('быстрые фразы', renderQuickChips);

    if (has('onEvent')) {
      safe('подписка на события', () => window.jarvis.onEvent(onEvent));
    }
    if (has('listApprovals')) {
      A.syncing = true;
      try {
        const pending = await call('listApprovals');
        if (Array.isArray(pending)) for (const entry of pending) {
          if (!A.closedDuringSync.has(entry.id)) {
            if (entry.taskId) T.approvals.set(entry.id, entry.taskId);
            approvalPush(entry);
          }
        }
      } catch { /* Очередь остаётся в ядре и отклоняется по таймеру. */ }
      finally { A.syncing = false; A.closedDuringSync.clear(); }
    }
    await Promise.all([
      safe('состояние', loadState),
      safe('настройки ядра', loadSettings),
      safe('история разговора', loadHistory),
      safe('вкладки чатов', refreshChatTabs),
      safe('библиотека', loadLibrary),
    ]);
  }

  // Мост для экрана Nox: переключение раздела и чатов теми же проверенными функциями,
  // что и у прежней панели, без второй копии логики беседы.
  window.JarvisNox = { show, changeChat, closeChat, clearChat, refreshChatTabs };

  boot().catch((e) => {
    console.error('[jarvis] запуск интерфейса не удался', e);
    toast('Интерфейс запустился с ошибкой: ' + errText(e), 'error');
  });
})();
