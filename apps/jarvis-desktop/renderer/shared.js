/* Джарвис — общие части интерфейса для index.html и mini.html:
 * иконки (свои, инлайн SVG), подписи инструментов, статусы, трекер состояния шара,
 * относительное время, загрузка dev-stub.js в обычном браузере. */
// Видимый журнал ошибок: если скрипт упал, текст ошибки показывается прямо в окне (консоль не нужна).
(() => {
  const showFatal = (text) => {
    let box = document.getElementById('fatalBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'fatalBox';
      box.setAttribute('role', 'alert');
      // Свойства по одному: строка style (cssText) под CSP style-src 'self' не применяется.
      Object.assign(box.style, { position: 'fixed', left: '8px', right: '8px', bottom: '8px', zIndex: '99999', background: '#3a1212', color: '#ffd7d7', padding: '10px 12px', borderRadius: '8px', font: '12px/1.4 system-ui, sans-serif', whiteSpace: 'pre-wrap', maxHeight: '40vh', overflow: 'auto' });
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent += `${text}\n`;
  };
  window.addEventListener('error', (e) => showFatal(`Сбой интерфейса: ${e.message || 'скрипт не выполнен'} (${e.filename || ''}:${e.lineno || ''})`));
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    showFatal(`Сбой интерфейса (промис): ${reason}`);
  });
})();

(() => {
  'use strict';

  const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  const P = {
    // Знак Джарвиса: сфера из точек с орбитальным разрезом.
    logo: '<circle cx="12" cy="12" r="8.2" stroke-width="1.6" opacity=".45"/><path d="M4.6 14.6c3.6 1.6 11.2 1.6 14.8-1.4" stroke-width="2"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/><circle cx="8" cy="8.4" r="1.05" fill="currentColor" stroke="none"/><circle cx="15.6" cy="7.6" r="1.05" fill="currentColor" stroke="none"/><circle cx="17.4" cy="11.4" r=".9" fill="currentColor" stroke="none"/><circle cx="6.4" cy="11.8" r=".9" fill="currentColor" stroke="none"/>',
    orb: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/><path d="M4.5 13.5c3.5 1.6 11 1.6 15-1"/>',
    list: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="M4 6.5l1.2 1.2L7.5 5.3M4 12l1.2 1.2 2.3-2.4"/><circle cx="5.6" cy="17.5" r="1.1" fill="currentColor" stroke="none"/>',
    bolt: '<path d="M13 3 5 13.5h6L10.5 21 19 10h-6z"/>',
    plug: '<path d="M9 4v5M15 4v5M6.5 9h11v3a5.5 5.5 0 0 1-11 0zM12 17.5V21"/>',
    user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.6-3.6 3.4-5.5 7-5.5s6.4 1.9 7 5.5"/>',
    blocks: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><path d="M16.75 14v5.5M14 16.75h5.5"/>',
    chat: '<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z"/><path d="M8 10h8M8 13h5"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 4.5v15M15.5 10l-2 2 2 2"/>',
    shield: '<path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z"/><path d="M9.5 12l2 2 3.5-3.5"/>',
    mini: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="15.5" cy="14.5" r="2.5"/>',
    expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
    send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.8"/><path d="M12 16.6v.1"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    stwait: '<path d="M12 5l8 14H4z" fill="currentColor"/>',
    stfail: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
    stopen: '<circle cx="12" cy="12" r="6.5"/>',
    stok: '<circle cx="12" cy="12" r="7" fill="currentColor"/>',
    sthalf: '<circle cx="12" cy="12" r="6.5"/><path d="M12 5.5a6.5 6.5 0 0 1 0 13z" fill="currentColor"/>',
    stno: '<circle cx="12" cy="12" r="6.5"/><path d="M7.5 7.5l9 9"/>',
    stdash: '<path d="M7 12h10"/>',
    play: '<path d="M8 5.5v13l10-6.5z"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
    up: '<path d="M12 18V6M7 11l5-5 5 5"/>',
    down: '<path d="M12 6v12M7 13l5 5 5-5"/>',
    chevron: '<path d="M7 10l5 5 5-5"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
    book: '<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/><path d="M9 8h6"/>',
    quote: '<path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-7l-4 3v-3H5A1.5 1.5 0 0 1 3.5 15V8A1.5 1.5 0 0 1 5 6.5z"/><path d="M9 10.5v2M12 10.5v2M15 10.5v2"/>',
    key: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H20M17 12v3M20 12v2"/>',
    refresh: '<path d="M19 12a7 7 0 1 1-2.05-4.95M19 5v4h-4"/>',
    alert: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16v.01"/>',
    ban: '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
    hourglass: '<path d="M7 4h10M7 20h10M8 4v2.5l4 5.5 4-5.5V4M8 20v-2.5l4-5.5 4 5.5V20"/>',
    spinner: '<path d="M12 4a8 8 0 1 1-8 8"/>',
    clip: '<path d="M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1"/>',
    file: '<path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13.5 3.5v4h4"/>',
    gauge: '<path d="M4.5 16a7.5 7.5 0 1 1 15 0"/><path d="M12 16l3.5-4.5"/><circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
    volume: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3M9 21h6"/>',
    window: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9h17"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>',
    calendar: '<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.2 9 4.5 4.5 0 0 0 7 18z"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
    globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.7 2.5 13.3 0 16M12 4c-2.5 2.7-2.5 13.3 0 16"/>',
  };

  function iconMarkup(name) {
    return P[name] ? SVG_OPEN + P[name] + '</svg>' : '';
  }

  // Иконки — постоянные строки из этого файла, пользовательский текст сюда не попадает.
  function icon(name) {
    const span = document.createElement('span');
    span.setAttribute('data-icon', name);
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = iconMarkup(name);
    return span;
  }

  function fillIcons(root) {
    for (const node of (root || document).querySelectorAll('[data-icon]')) {
      if (!node.firstElementChild) node.innerHTML = iconMarkup(node.getAttribute('data-icon'));
    }
  }

  // Безопасная сборка элементов: только textContent и атрибуты.
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const TOOL_TITLES = {
    agents_parallel: 'Параллельная работа ролей',
    deals_hanging: 'Что повисло',
    deal_clear: 'Разобрать дело',
    volume_set: 'Громкость',
    app_open: 'Запуск программы',
    app_close: 'Закрытие программы',
    apps_find: 'Поиск программы',
    apps_scan: 'Список программ',
    apps_usage: 'Частые программы',
    wait: 'Пауза',
    wait_for: 'Ожидание условия',
    speak: 'Сказать вслух',
    monitor_off: 'Выключить монитор',
    pc_shutdown: 'Выключение компьютера',
    windows_minimize_all: 'Свернуть окна',
    windows_restore_all: 'Вернуть окна',
    ui_close_window: 'Закрыть окно',
    desktop_observe: 'Снимок рабочего стола',
    desktop_click: 'Нажатие по id',
    desktop_type: 'Ввод по id',
    mouse_click: 'Нажатие мышью',
    mouse_scroll: 'Прокрутка',
    long_task_start: 'Долгое поручение',
    long_task_list: 'Долгие поручения',
    long_task_stop: 'Остановка поручения',
    long_task_resume: 'Продолжение поручения',
    ui_click: 'Нажатие в окне',
    app_search: 'Поиск программы',
    app_install: 'Установка программы',
    ui_type: 'Ввод текста в окне',
    ui_keys: 'Нажатие клавиш',
    ui_focus: 'Переключить окно',
    ui_windows: 'Список окон',
    ui_elements: 'Элементы окна',
    ui_set_toggle: 'Переключатель в окне',
    ui_wait: 'Ожидание элемента',
    deal_add: 'Записать дело',
    clipboard_get: 'Чтение буфера',
    clipboard_set: 'Запись в буфер',
    media_control: 'Управление плеером',
    image_read_text: 'Чтение текста с картинки',
    image_look: 'Просмотр картинки',
    currency_rate: 'Курс валют',
    web_check_claims: 'Проверка утверждений по источникам',
    command_create: 'Новая команда',
    command_build: 'Сценарий по описанию',
    command_list: 'Список команд',
    command_set_hotkey: 'Горячая клавиша',
    screen_look: 'Снимок экрана',
    screen_region_look: 'Обведённая область экрана',
    url_open: 'Открыть адрес',
    shell_run: 'Команда PowerShell',
    remember: 'Запомнить',
    recall: 'Вспомнить',
    memory_about: 'Всё про человека или дело',
    forget: 'Забыть',
    goal_create: 'План цели',
    goal_list: 'Цели',
    goal_next: 'Следующий шаг цели',
    goal_step: 'Шаг цели',
    goal_close: 'Закрытие цели',
    mission_add: 'Фоновая задача',
    mission_list: 'Список задач',
    mission_cancel: 'Отмена задачи',
    remind_in: 'Напоминание',
    remind_at: 'Напоминание на время',
    list_reminders: 'Список напоминаний',
    cancel_reminder: 'Отмена напоминания',
    windows_list: 'Список окон',
    windows_focus: 'Переключить окно',
    windows_arrange: 'Разложить окна',
    windows_snap: 'Прикрепить окно',
    windows_close_all: 'Закрыть все окна',
    youtube_play: 'Видео на YouTube',
    organize_workspace: 'Организовать рабочее пространство',
    restore_workspace: 'Вернуть окна как было',
    disk_free_space: 'Свободное место на дисках',
    disk_cleanup_suggest: 'Предложить очистку диска',
    project_commands: 'Команды проекта',
    project_run: 'Запуск команды проекта',
    workspace_search: 'Поиск в папке',
    workspace_read: 'Чтение файла',
    workspace_write: 'Запись файла',
    workspace_move: 'Перенос файла',
    workspace_copy: 'Копия файла',
    workspace_mkdir: 'Создание папки',    workspace_restore: 'Возврат прежней версии файла',
    project_brief: 'Разбор папки проекта',
    project_diagnostics: 'Разбор журнала проекта',
    document_read: 'Чтение документа',
    document_write: 'Запись документа',
    web_search: 'Поиск в интернете',
    web_wiki: 'Поиск в Википедии',
    web_fetch: 'Чтение страницы',
    web_research: 'Сбор и чтение источников',
    weather_now: 'Погода',
    browser_open: 'Открыть страницу',
    browser_read: 'Чтение страницы в браузере',
    browser_scroll: 'Прокрутка страницы',
    browser_click: 'Нажатие на странице',
    browser_type: 'Ввод на странице',
    code_test: 'Запуск тестов',
    code_read: 'Чтение кода',
    code_write: 'Запись кода',
    code_edit: 'Правка кода',
    library_list: 'Список готовых команд',
    library_run: 'Готовая команда',
    skills_list: 'Список навыков',
    skill_read: 'Чтение навыка',
    task_create: 'Новая задача',
    task_plan: 'План задачи',
    task_enqueue: 'Задача в очередь',
    task_start: 'Запуск задачи',
    task_step: 'Шаг задачи',
    task_verify: 'Проверка задачи',
    task_list: 'Список задач исполнителя',
    task_note: 'Запись к делу',
    task_submit: 'Поручение исполнителю',
    task_resume: 'Продолжение задачи',
    workspace_list: 'Список файлов',
    mail_send: 'Отправка письма',
    mail_unread: 'Непрочитанные письма',
  };
  // Коды риска владельцу не показываем: только слова.
  const RISK_WORDS = { T0: 'чтение', T1: 'действие', T2: 'важное действие', T3: 'необратимое' };
  const riskWord = (r) => RISK_WORDS[r] || '';
  // Названия команд библиотеки (инструменты lib_<id>) регистрирует app.js.
  const extraTitles = new Map();
  function registerTitles(map) {
    for (const [k, v] of Object.entries(map || {})) if (k && v) extraTitles.set(k, String(v));
  }

  // Имя инструмента (snake_case) без названия — «Действие»; обычный текст (подписи задач, журнала) показываем как есть.
  const IDENT = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
  const toolTitle = (name) => {
    const n = String(name || '');
    if (TOOL_TITLES[n] || extraTitles.has(n)) return TOOL_TITLES[n] || extraTitles.get(n);
    if (!n || IDENT.test(n)) return 'Действие';
    return n;
  };

  // Имена инструментов в тексте для показа. Код в ``` и адреса/пути не трогаем.
  // Открытый блок кода (стриминг) считаем до конца текста.
  const NAME_IN_TEXT = /`?\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b`?/g;
  const UNKNOWN_TOOL = /^(ui|web|workspace|mission|deal|task|command|skill|skills|apps|app|windows|shell|browser|clipboard|screen|url|library|lib)_[a-z0-9_]+$/;
  const nameWord = (m) => {
    const n = m.replace(/`/g, '');
    if (TOOL_TITLES[n] || extraTitles.has(n)) return `«${toolTitle(n)}»`;
    return UNKNOWN_TOOL.test(n) ? '«действие»' : m;
  };
  function humanize(raw) {
    const text = String(raw == null ? '' : raw).replace(/\]?<?\]minimax\[>\[[\s\S]*?(?:\]?<?\]minimax\[>\[<\/tool_call>|$)/gi, '');
    return text
      .split(/(```[\s\S]*?(?:```|$)|https?:\/\/\S+|\S*[\\/]\S*)/)
      .map((part, i) => (i % 2 ? part : part.replace(NAME_IN_TEXT, nameWord)))
      .join('');
  }

  // Инструменты поиска: при их запуске шар переходит в «Ищу».
  function isSearchTool(name, args) {
    const n = String(name || '');
    if (/^(web_search|web_wiki|web_fetch|workspace_search)$/.test(n)) return true;
    if (/search|wiki|research|lookup/i.test(n)) return true;
    if (/^mission_add$/.test(n) && args && typeof args === 'object') {
      return /поиск|найд|исслед|search|research/i.test(JSON.stringify(args));
    }
    return false;
  }

  // Убираем из видимого текста названия моделей и поставщиков, код риска из причины и имена инструментов.
  function scrub(s) {
    return humanize(String(s == null ? '' : s)
      .replace(/[\w.-]*\/?(?:deepseek|minimax|deepinfra)[\w./-]*/gi, 'модель')
      .replace(/deepinfra/gi, 'модель')
      .replace(/,?\s*риск T[0-3]\b/g, ''));
  }

  // Итог инструмента для показа: без «null», «undefined» и пустых строк.
  function cleanSummary(s) {
    if (s === null || s === undefined) return '';
    const str = String(s).trim();
    if (!str || str === 'null' || str === 'undefined') return '';
    return scrub(str);
  }

  function argsBrief(args, max = 60) {
    if (args === null || args === undefined) return '';
    if (typeof args !== 'object') return clip(String(args), max);
    const vals = Object.values(args).filter((v) => v !== null && v !== undefined && v !== '');
    if (!vals.length) return '';
    const s = vals.map((v) => (Array.isArray(v) && v.every((item) => typeof item === 'string')
      ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
    return clip(s.replace(/\s+/g, ' '), max);
  }

  function argsPretty(args) {
    if (args === null || args === undefined) return '(без аргументов)';
    try {
      const s = JSON.stringify(args, null, 2);
      return s === '{}' ? '(без аргументов)' : s;
    } catch {
      return String(args);
    }
  }

  function clip(s, max) {
    const str = String(s);
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  function fmtSize(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '';
    if (v < 1024) return `${v} Б`;
    if (v < 1024 * 1024) return `${Math.round(v / 1024)} КБ`;
    return `${(v / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  }

  const STATUS_TEXT = {
    done: 'выполнено', confirmed: 'подтверждено', unverified: 'не проверено', failed: 'провалено',
    error: 'не получилось', refused: 'отклонено', pending: 'ждёт решения', running: 'выполняется',
  };
  // Статус различается формой значка, а не только цветом (бриф, раздел 5).
  const GLYPH_ICONS = { '▲': 'stwait', '■': 'stfail', '○': 'stopen', '●': 'stok', '◐': 'sthalf', '⊘': 'stno', '–': 'stdash' };
  const glyph = (char) => icon(GLYPH_ICONS[char] || 'stopen');
  const STATUS_GLYPH = { done: '–', confirmed: '●', unverified: '○', failed: '■', error: '■', refused: '⊘', pending: '▲', running: '◐' };

  function statusBadge(status) {
    return el('span', { class: 'status', 'data-status': status }, el('span', { class: 'status-glyph', 'aria-hidden': 'true' }, glyph(STATUS_GLYPH[status] || '○')), STATUS_TEXT[status] || status);
  }

  const REFUSED_SUMMARY = /^(отклонено|отказано|запрещено|остановлено)$/i;

  // Успех без проверки — просто «выполнено»: у инструмента нет способа её сделать.
  function okStatus(verified) {
    if (verified === 'confirmed') return 'confirmed';
    return verified === 'unknown' ? 'unverified' : 'done';
  }

  // Итог записи журнала: отказ (reject/deny) отдельно от ошибки выполнения.
  function statusOfRecord(r) {
    if (!r) return 'error';
    if (r.decision === 'reject' || r.decision === 'deny') return 'refused';
    if (r.verified === 'failed') return 'failed';
    if (r.ok === true) return okStatus(r.verified);
    if (r.ok === false) return REFUSED_SUMMARY.test(String(r.summary || '').trim()) ? 'refused' : 'error';
    return 'done';
  }

  function statusOfResult(ok, summary, rejected, verified) {
    if (verified === 'failed') return 'failed';
    if (ok) return okStatus(verified);
    if (rejected || REFUSED_SUMMARY.test(String(summary || '').trim())) return 'refused';
    return 'error';
  }

  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  function toMs(ts) {
    if (typeof ts === 'number') return ts;
    const v = Date.parse(ts);
    return Number.isFinite(v) ? v : Date.now();
  }

  function relTime(ts, now = Date.now()) {
    const ms = toMs(ts);
    const sec = Math.round((now - ms) / 1000);
    if (sec < 45) return 'только что';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} ${plural(min, ['минуту', 'минуты', 'минут'])} назад`;
    const h = Math.round(min / 60);
    const d = new Date(ms);
    const today = new Date(now);
    const sameDay = d.toDateString() === today.toDateString();
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (sameDay && h < 24) return `${h} ${plural(h, ['час', 'часа', 'часов'])} назад`;
    const y = new Date(now - 86400000);
    if (d.toDateString() === y.toDateString()) return `вчера, ${hm}`;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + hm;
  }

  function absTime(ts) {
    return new Date(toMs(ts)).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function shortTime(ts) {
    const d = new Date(toMs(ts));
    const today = new Date();
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return hm;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + hm;
  }

  const ORB_STATES = ['idle', 'listening', 'thinking', 'searching', 'speaking', 'acting', 'verifying', 'waiting_approval', 'success', 'cancelled', 'error'];
  const PHRASE = {
    idle: 'Готов',
    listening: 'Слушаю',
    thinking: 'Думаю',
    searching: 'Ищу',
    speaking: 'Отвечаю',
    acting: 'Выполняю',
    verifying: 'Проверяю',
    waiting_approval: 'Нужно ваше решение',
    success: 'Готово',
    cancelled: 'Остановлено',
    error: 'Не получилось',
  };

  // Нормализованный статус хода (поле status в событиях ядра) → состояние шара.
  // Ядро шлёт status вместе со state; если state ещё старый, берём status как источник правды.
  const STATUS_TO_ORB = {
    planning: 'thinking',
    running: 'acting',
    awaiting_approval: 'waiting_approval',
    verifying: 'verifying',
    cancelled: 'cancelled',
    failed: 'error',
  };

  /* Состояние шара по событиям ядра (status, text, tool_start, tool_result,
   * approval_request, error, done). Общий для главного окна и мини-режима.
   * onText(delta) вызывается на каждую порцию текста — для волн «говорит». */
  class StatusTracker {
    constructor(onChange, onText) {
      this.onChange = onChange || (() => {});
      this.onText = onText || (() => {});
      this.state = 'idle';
      this.busy = false;
      this.listening = false;
      this.last = null; // { tool, args, risk, status, summary, ts }
      this.errorText = '';
      this.note = ''; // человекочитаемый шаг от ядра (status.label): «проверяю результат» и т.п.
      this.rejected = new Set();
      this.inflight = new Map(); // id → { name, search }
      this.timer = 0;
    }

    get phrase() {
      return PHRASE[this.state] || PHRASE.idle;
    }

    handle(ev) {
      if (!ev || typeof ev !== 'object') return;
      switch (ev.type) {
        case 'status': {
          if (typeof ev.label === 'string' && ev.label.trim()) this.note = ev.label.trim();
          // Сначала нормализованный status хода, затем привычный state: старый протокол продолжает работать.
          const mapped = STATUS_TO_ORB[ev.status] || ev.state;
          const s = ORB_STATES.includes(mapped) ? mapped : 'idle';
          if (s === 'idle' || s === 'cancelled') {
            this.busy = false;
            this.inflight.clear();
            if (s === 'cancelled') {
              this._set('cancelled');
              this._later(2600);
            } else if (this.state === 'cancelled' || this.state === 'success') {
              // «Остановлено»/«Готово» держим несколько секунд: поздний idle не должен их мгновенно стирать.
            } else if (this.state !== 'error') this._set(this._rest());
          } else if (s === 'acting' || s === 'verifying') {
            this.busy = true;
            this._set(s === 'verifying' ? 'verifying' : (this._searching() ? 'searching' : 'acting'));
          } else if (s === 'error') {
            this._set('error');
            this._later(3500);
          } else {
            this.busy = true;
            this._set(s);
          }
          break;
        }
        case 'tool_start': {
          const search = isSearchTool(ev.name, ev.args);
          this.busy = true;
          this.inflight.set(ev.id, { name: ev.name, search });
          this.last = { tool: ev.name, args: ev.args, risk: ev.risk, status: 'running', ts: Date.now() };
          if (this.state !== 'waiting_approval') this._set(search ? 'searching' : 'acting');
          break;
        }
        case 'approval_request':
          this.busy = true;
          this.last = { tool: ev.name, args: ev.args, risk: ev.risk, status: 'pending', ts: Date.now() };
          this._set('waiting_approval');
          break;
        case 'tool_result': {
          this.inflight.delete(ev.id);
          const status = statusOfResult(ev.ok, ev.summary, this.rejected.has(ev.id), ev.verified);
          this.last = { ...(this.last || {}), status, summary: cleanSummary(ev.summary), ts: Date.now() };
          if (this.state === 'searching' && !this._searching()) this._set('thinking');
          else if (this.state === 'waiting_approval') this._set('thinking');
          break;
        }
        // Запрос решён или отменён (у запросов исполнителя задач tool_result не бывает): больше не «жду решения».
        case 'approval_closed':
          if (this.state === 'waiting_approval') {
            if (this.inflight.size === 0) this.busy = false;
            this._set(this.busy ? 'thinking' : this._rest());
          }
          break;
        case 'text':
          if (this.state !== 'waiting_approval' && this.state !== 'error') this._set('speaking');
          this.onText(ev.delta);
          break;
        case 'error':
          this.errorText = scrub(ev.message || '');
          this.note = '';
          this._set('error');
          this._later(3500);
          break;
        case 'done':
          this.busy = false;
          this.inflight.clear();
          this.note = '';
          // Ход остановлен владельцем: честное «Остановлено», а не «Готов»/«Ответ готов».
          if (ev.cancelled === true || ev.status === 'cancelled') {
            this._set('cancelled');
            this._later(2600);
          } else if (ev.status === 'succeeded' && this.state !== 'error') {
            // Успешный итог виден коротко: «Готово», затем покой.
            this._set('success');
            this._later(1800);
          } else if (this.state !== 'error') this._set(this._rest());
          break;
        default:
          return;
      }
      this.onChange(this);
    }

    markSent() {
      clearTimeout(this.timer);
      this.busy = true;
      this.errorText = '';
      this.note = '';
      this._set('thinking');
      this.onChange(this);
    }

    // Окно остановило ход само (Стоп): сразу в покой.
    reset() {
      clearTimeout(this.timer);
      this.busy = false;
      this.inflight.clear();
      this._set(this._rest());
      this.onChange(this);
    }

    setListening(on) {
      this.listening = Boolean(on);
      if (this.busy) return;
      if (this.state === 'idle' || this.state === 'listening') {
        const next = this._rest();
        if (next !== this.state) {
          this._set(next);
          this.onChange(this);
        }
      }
    }

    markRejected(id) {
      this.rejected.add(id);
    }

    _rest() {
      return this.listening ? 'listening' : 'idle';
    }

    _searching() {
      for (const v of this.inflight.values()) if (v.search) return true;
      return false;
    }

    _set(s) {
      this.state = ORB_STATES.includes(s) ? s : 'idle';
      if (this.state !== 'error') clearTimeout(this.timer);
    }

    _later(ms) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.busy) return;
        this.state = this._rest();
        this.onChange(this);
      }, ms);
    }
  }

  // В обычном браузере (без Electron) догружаем эмуляцию ядра.
  function ensureBridge() {
    if (window.jarvis) return Promise.resolve(window.__jarvisStub ? 'stub' : 'bridge');
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'dev-stub.js';
      s.onload = () => resolve(window.jarvis ? 'stub' : 'none');
      s.onerror = () => resolve('none');
      document.head.appendChild(s);
    });
  }

  const has = (name) => Boolean(window.jarvis) && typeof window.jarvis[name] === 'function';

  async function call(name, ...args) {
    if (!has(name)) {
      const err = new Error(`метод ${name} недоступен в этой версии ядра`);
      err.missing = true;
      throw err;
    }
    return window.jarvis[name](...args);
  }

  const errText = (e) => scrub(e && e.message ? String(e.message) : String(e || 'неизвестная ошибка'));

  window.JarvisUI = {
    icon, fillIcons, el, toolTitle, registerTitles, humanize, riskWord, isSearchTool, scrub, cleanSummary,
    argsBrief, argsPretty, clip, fmtSize,
    glyph, STATUS_TEXT, STATUS_GLYPH, statusBadge, statusOfRecord, statusOfResult, plural, relTime, absTime, shortTime, toMs,
    ORB_STATES, PHRASE, StatusTracker, ensureBridge, has, call, errText,
  };
})();
