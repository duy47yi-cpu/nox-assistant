/* Nox Aether — общий движок трёх прототипов (Gate 1). Только макет: все данные вымышленные,
 * ядро не вызывается. Композицию задаёт index.html концепции, здесь — одинаковые для всех
 * сценарии 1–6, поле ввода, сферы (настоящие модули приложения, подключены без правок) и Мастерская.
 * Настройка концепции: window.NOX_PROTO = { defaults, layer(), onScenario(n, S), onSetting(key, S) }. */
(() => {
  'use strict';
  const CFG = window.NOX_PROTO || {};
  const root = document.documentElement;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? b : c);
  const errors = [];
  window.addEventListener('error', (e) => errors.push('js: ' + e.message));

  const ICON = {
    plus: 'M8 3v10M3 8h10', chev: 'M4 6l4 4 4-4', check: 'M3.5 8.5l3 3 6-7', x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
    clip: 'M11.5 7.5l-4 4a2 2 0 01-2.9-2.9l4.6-4.6a3.2 3.2 0 014.5 4.5', mic: 'M8 2.5a1.8 1.8 0 00-1.8 1.8v3.4a1.8 1.8 0 003.6 0V4.300A1.8 1.8 0 008 2.5zM4.500 8a3.5 3.5 0 007 0M8 11.5v2',
    send: 'M8 13V3.500M4 7.500l4-4 4 4', copy: 'M6 6h7v7H6zM3.500 10V3.500H10', menu: 'M3 5h10M3 8h10M3 11h10',
    tune: 'M3 5h6M12 5h1M3 11h1M7 11h6M10.500 3.500v3M5.500 9.500v3',
  };
  const ico = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;
  const ST_ICON = {
    ok: ico('check'), err: ico('x'),
    unk: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" stroke-dasharray="2.2 2.6"/></svg>',
    run: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3a5 5 0 105 5"/></svg>',
  };
  const ST_WORD = { ok: 'проверено', unk: 'создано, не подтверждено', err: 'не удалось', run: 'идёт' };
  const PHRASE = { idle: 'готов', listening: 'слушаю', thinking: 'работает', waiting_approval: 'ждёт вас', speaking: 'отвечаю', error: 'ошибка', success: 'готово' };

  // ── Библиотека сфер: обе настоящие системы без изменения исходников. ──
  const jarvis = (variant, extra = {}) => (c, opts = {}) => new window.JarvisOrb(c, { variant, ...extra, ...opts });
  const nox = (variant) => (c) => new window.NoxOrb(c, { variant, scale: 0.84 });
  const J_CAPS = ['state', 'voice', 'size', 'color', 'glow', 'speed'];
  const ORBS = {
    'nox-nox': {
      group: 'Точечные сферы (обе системы)',
      engine: 'NoxOrb (orb-nox.js)',
      title: 'Nox Точечная',
      hint: '1400+200 точек · голубая матрица',
      make: nox('nox'),
      caps: ['state', 'voice', 'size'],
      defaults: { orbK: 1 },
    },
    'jarvis-sphere': {
      group: 'Точечные сферы (обе системы)',
      engine: 'JarvisOrb (orb.js)',
      title: 'Jarvis Точечная',
      hint: 'Спрайтовые точки · цвет темы + шаги',
      make: jarvis('sphere'),
      makePreview: jarvis('sphere', { density: 1.75 }),
      caps: [...J_CAPS, 'density'],
      defaults: { orbK: 1, glow: 1.05, speed: 1, dens: 1.15 },
    },
    'nox-wire': {
      group: 'Контур и свет',
      engine: 'NoxOrb (orb-nox.js)',
      title: 'Nox Проволока',
      hint: '112×54 сетка с поясом · голубой контур',
      make: nox('wire'),
      caps: ['state', 'voice', 'size'],
      defaults: { orbK: 1 },
    },
    'jarvis-core': {
      group: 'Контур и свет',
      engine: 'JarvisOrb (orb-variants.js)',
      title: 'Jarvis Ядро',
      hint: 'Светящееся ядро · цвет темы',
      make: jarvis('core'),
      caps: J_CAPS,
      defaults: { orbK: 1, glow: 1, speed: 1 },
    },
    'jarvis-iris': {
      group: 'Контур и свет',
      engine: 'JarvisOrb (orb-variants.js)',
      title: 'Jarvis Диафрагма',
      hint: 'Вращающиеся дуги · цвет темы',
      make: jarvis('iris'),
      caps: J_CAPS,
      defaults: { orbK: 1, glow: 1, speed: 1 },
    },
  };
  const ORB_KEYS = ['orbK', 'glow', 'speed', 'dens'];
  const CAPS = { state: 'состояния', voice: 'голос', size: 'размер', color: 'цвет акцента', glow: 'свечение', speed: 'скорость', density: 'плотность точек' };

  // ── Настройки оформления. Эта же таблица — строгая схема для импорта: чего нет здесь, то не принимается. ──
  const SCHEMA = {
    orb: { sec: 'orbs', opts: Object.fromEntries(Object.keys(ORBS).map((k) => [k, ORBS[k].title])) },
    orbK: { sec: 'orbs', label: 'Размер сферы', min: 0.7, max: 1.2, step: 0.05, css: '--orb-k', cap: 'size' },
    glow: { sec: 'orbs', label: 'Свечение', min: 0.4, max: 1.6, step: 0.1, cap: 'glow' },
    speed: { sec: 'orbs', label: 'Скорость движения', min: 0.5, max: 1.6, step: 0.1, cap: 'speed' },
    dens: { sec: 'orbs', label: 'Плотность точек', min: 0.6, max: 1.4, step: 0.1, cap: 'density' },
    orbPos: { sec: 'layout', label: 'Где сфера', opts: { right: 'Справа', left: 'Слева', compact: 'Компактная', hidden: 'Скрыта' } },
    chatW: { sec: 'layout', label: 'Ширина диалога', min: 480, max: 920, step: 20, css: '--chat-w', unit: 'px' },
    density: { sec: 'layout', label: 'Плотность', opts: { compact: 'Компактно', comfortable: 'Комфортно', spacious: 'Просторно' } },
    autoshift: { sec: 'layout', label: 'Сфера уступает место длинному ответу', bool: true },
    msg: { sec: 'chat', label: 'Стиль сообщений', opts: { minimal: 'Minimal', cards: 'Cards', hybrid: 'Hybrid' } },
    fs: { sec: 'chat', label: 'Размер шрифта', min: 13, max: 18, step: 1, css: '--fs', unit: 'px' },
    lh: { sec: 'chat', label: 'Межстрочный интервал', min: 1.4, max: 1.9, step: 0.05, css: '--lh' },
    time: { sec: 'chat', label: 'Показывать время сообщений', bool: true },
    trail: { sec: 'chat', label: 'Ход задачи', opts: { auto: 'Как в сценарии', closed: 'Свёрнут', open: 'Раскрыт' } },
    hue: { sec: 'color', label: 'Акцент', colors: ['#58D9E8', '#8AA8FF', '#C7E08A', '#F2B7A0', '#C3A2FF', '#E8E8E8'], css: '--hue' },
    bg: { sec: 'color', label: 'Фон', opts: { solid: 'Ровный', soft: 'Мягкий свет', contour: 'Контур' } },
    motion: { sec: 'fx', label: 'Движение', opts: { off: 'Выключено', reduced: 'Меньше', balanced: 'Обычное', expressive: 'Выразительное' } },
  };
  const DEFAULTS = {
    orb: 'nox-nox', orbK: 1, glow: 1, speed: 1, dens: 1, orbPos: 'right', chatW: 680, density: 'comfortable', autoshift: false,
    msg: 'minimal', fs: 15, lh: 1.6, time: false, trail: 'auto', hue: '#58D9E8', bg: 'soft', motion: 'balanced', ...(CFG.defaults || {}),
  };
  const PRESETS = {
    'Стандартное': DEFAULTS,
    'Тихий текст': { ...DEFAULTS, orbPos: 'compact', chatW: 760, msg: 'minimal', bg: 'solid', motion: 'reduced' },
    'Сцена': { ...DEFAULTS, orbPos: 'right', orbK: 1.15, msg: 'hybrid', density: 'spacious', bg: 'soft', motion: 'expressive' },
  };
  // Настройки каждой сферы изолированы: переключение не стирает параметры другой сферы.
  const perOrb = Object.fromEntries(Object.keys(ORBS).map((id) => [id, { orbK: 1, glow: 1, speed: 1, dens: 1, ...ORBS[id].defaults }]));
  const orbPresets = [
    { id: 'calm-core', name: 'Спокойное ядро', orb: 'jarvis-core', vals: { orbK: 0.95, glow: 0.75, speed: 0.7 } },
    { id: 'dense-dots', name: 'Плотные точки', orb: 'jarvis-sphere', vals: { orbK: 1.05, glow: 1.2, speed: 1.0, dens: 1.35 } },
  ];
  function syncOrbParams(nextOrb) {
    ORB_KEYS.forEach((k) => { perOrb[S.orb][k] = S[k]; });
    S.orb = nextOrb;
    const saved = perOrb[nextOrb] || {};
    ORB_KEYS.forEach((k) => { S[k] = saved[k] ?? DEFAULTS[k]; });
    ORB_KEYS.forEach(apply);
  }
  // Берёт только известные ключи и только допустимые значения. Кода, путей и прав здесь быть не может.
  function clean(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const k of Object.keys(SCHEMA)) {
      const d = SCHEMA[k], v = obj[k];
      if (d.opts) { if (typeof v === 'string' && Object.hasOwn(d.opts, v)) out[k] = v; }
      else if (d.bool) { if (typeof v === 'boolean') out[k] = v; }
      else if (d.colors) { if (d.colors.includes(v)) out[k] = v; }
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(d.max, Math.max(d.min, v));
    }
    return out;
  }
  const S = { ...DEFAULTS, ...perOrb[DEFAULTS.orb] };

  let orb = null, state = 'idle', scenario = 0, previews = [], pending = null, raf = 0, wsTab = 'orbs', lastSet = '';

  function mountOrb() {
    if (orb) orb.destroy();
    const m = $('#orbMount');
    m.innerHTML = '<canvas aria-hidden="true"></canvas>';
    orb = ORBS[S.orb].make(m.firstChild);
    orb.setState(state);
    if (orb.setTune) orb.setTune({ glow: S.glow, speed: S.speed, density: S.dens });
    orb.setAnimated(S.motion !== 'off');
  }
  function apply(k) {
    const d = SCHEMA[k];
    if (d.css) root.style.setProperty(d.css, S[k] + (d.unit || ''));
    else root.dataset[k] = String(S[k]);
  }
  function after(keys) {
    if (ORB_KEYS.some((k) => keys.includes(k))) {
      ORB_KEYS.forEach((k) => { perOrb[S.orb][k] = S[k]; });
    }
    if (keys.includes('orb') || keys.includes('hue')) mountOrb();
    else {
      if ((keys.includes('glow') || keys.includes('speed') || keys.includes('dens')) && orb.setTune) {
        orb.setTune({ glow: S.glow, speed: S.speed, density: S.dens });
      }
      if (keys.includes('motion')) orb.setAnimated(S.motion !== 'off');
    }
    if (keys.includes('trail') || keys.includes('orbPos')) applyTrail();
    if (CFG.onSetting) keys.forEach((k) => CFG.onSetting(k, S));
  }
  function setAll(obj) { Object.assign(S, clean(obj)); Object.keys(SCHEMA).forEach(apply); after(Object.keys(SCHEMA)); }
  function setState(s) {
    state = s;
    root.dataset.state = s;
    $$('[data-state-label]').forEach((e) => { e.textContent = PHRASE[s]; });
    $('#orbMount').setAttribute('aria-label', 'Сфера Nox: ' + PHRASE[s]);
    if (orb) orb.setState(s);
  }

  // ── Демо-данные: одни и те же во всех трёх концепциях ──
  const U = (text, time) => `<article class="msg user"><div class="bubble">${text}</div><time>${time}</time></article>`;
  const N = (html, time) => `<article class="msg nox"><div class="md">${html}</div><time>${time}</time></article>`;
  const LONG = `<h2>Как разложить файлы проекта</h2>
<p>Коротко: одна папка на проект, внутри — четыре раздела. Чем короче путь к файлу, тем меньше сбоев — об этом пишет и <a href="#">справка Windows</a>.</p>
<ol><li><b>Входящие</b> — всё новое падает сюда.</li><li><b>В работе</b> — то, что вы правите сейчас.</li><li><b>Готово</b> — что уже отправлено.</li></ol>
<blockquote>Если файл нельзя найти за десять секунд, он лежит не там.</blockquote>
<h3>Что куда класть</h3>
<div class="tbl" tabindex="0" role="region" aria-label="Таблица: что куда класть"><table>
<tr><th>Раздел</th><th>Что лежит</th><th>Пример имени</th><th>Когда чистить</th><th>Копия</th></tr>
<tr><td>Входящие</td><td>Сканы, вложения из почты</td><td>2026-11-13 счёт от поставщика.pdf</td><td>Раз в неделю</td><td>Не нужна</td></tr>
<tr><td>В работе</td><td>Черновики, таблицы</td><td>Смета, версия 3.xlsx</td><td>После сдачи</td><td>Каждый день</td></tr>
<tr><td>Готово</td><td>Отправленные документы</td><td>Договор аренды, подписан.pdf</td><td>Никогда</td><td>Раз в неделю</td></tr>
<tr><td>Архив</td><td>Старые проекты целиком</td><td>2025 Ремонт офиса</td><td>Раз в год</td><td>Раз в месяц</td></tr>
</table></div>
<h3>Создать папки одной командой</h3>
<div class="code"><header><span>PowerShell</span><button class="btn-s" data-copy>${ico('copy')}<span>Копировать</span></button></header><pre><code>$p = "$HOME\\Documents\\Проект"
"Входящие","В работе","Готово","Архив" | ForEach-Object { New-Item -ItemType Directory -Path "$p\\$_" -Force }</code></pre></div>
<ul><li>Имена начинайте с даты: так файлы сами встают по порядку.</li><li>Не держите рабочие файлы на рабочем столе.</li></ul>
<p>Могу создать эти папки сам — скажите, где.</p>
<details class="src"><summary>Источники · 3</summary><ol><li><a href="#">Справка Windows: ограничение длины пути</a></li><li><a href="#">Ваша заметка «Порядок в проекте»</a></li><li><a href="#">Статья «Как называть файлы»</a></li></ol><p class="demo-note">Источники в макете вымышленные.</p></details>`;
  const STEPS_A = [['ok', 'Открыл папку «Договоры»'], ['ok', 'Прочитал список файлов'], ['ok', 'Посчитал размер']];
  const STEPS_B = [
    ['ok', 'Открыл папку «Договоры»'], ['ok', 'Прочитал список: 14 файлов'], ['ok', 'Прочитал «Договор аренды.docx»'], ['ok', 'Прочитал «Смета 2026.xlsx»'],
    ['err', 'Прочитал «Акт сверки.pdf»', 'Файл закрыт паролем, прочитать его я не могу. Остальные файлы не тронуты.'],
    ['ok', 'Собрал сводку по трём документам'],
    ['unk', 'Создал «Отчёт по договорам.docx»', 'Файл записан, но подтверждение, что он открывается, не пришло.'],
    ['ok', 'Положил копию в рабочую папку'], ['run', 'Записываю в журнал'],
  ];
  const NOW = { 4: 'Сейчас: записываю в журнал', 5: 'Жду вашего решения об удалении' };
  const VOICE_LINE = {
    idle: 'Скажите что-нибудь или напишите.', listening: 'Слышу: «Поставь таймер на десять минут»', thinking: 'Ставлю таймер…',
    waiting_approval: 'Нужен ваш ответ: да или нет.', speaking: '«Таймер на десять минут запущен.»', error: 'Не расслышал. Повторите, пожалуйста.',
  };
  const HISTORY = [['Сегодня'], ['План на день', 2], ['Как разложить файлы проекта', 3], ['Отчёт по папке «Договоры»', 4], ['Старые черновики в «Загрузках»', 5],
    ['Раньше'], ['Перенос архива фотографий на внешний диск и проверка копий', 2], ['Голосовой таймер', 6]];
  const TITLES = ['', 'Пустой чат', 'Обычный диалог', 'Длинный ответ', 'Ход задачи', 'Подтверждение', 'Голос'];
  const MODE = { 1: 'empty', 2: 'dialog', 3: 'long', 4: 'dialog', 5: 'dialog', 6: 'voice' };
  const ORB_STATE = { 1: 'idle', 2: 'idle', 3: 'idle', 4: 'thinking', 5: 'waiting_approval', 6: 'listening' };

  function stepHtml([st, text, more]) {
    const extra = !more ? '' : st === 'err'
      ? `<div class="fix"><p>${more}</p><div class="row"><button class="btn sm" data-fix="Пропущено по вашему решению. В отчёте будет пометка.">Пропустить этот файл</button><button class="btn sm" data-fix="Повтор запрошен.">Попробовать ещё раз</button></div></div>`
      : `<div class="why">${more}</div>`;
    return `<li class="step ${st}">${ST_ICON[st]}<span>${text}</span><span class="st">${ST_WORD[st]}</span>${extra}</li>`;
  }
  function trail(steps, open) {
    const c = {};
    steps.forEach((s) => { c[s[0]] = (c[s[0]] || 0) + 1; });
    const n = steps.length, parts = [`${n} ${plural(n, 'шаг', 'шага', 'шагов')}`];
    if (c.ok === n) parts.push('всё проверено');
    else ['ok', 'unk', 'err', 'run'].forEach((k) => { if (c[k]) parts.push(c[k] + ' ' + (k === 'unk' ? 'не подтверждено' : ST_WORD[k])); });
    const el = h(`<section class="trail"><button class="trail-head" aria-expanded="false"><b>Ход задачи</b><span class="trail-sum">${parts.join(' · ')}</span>${ico('chev', 'chev')}</button>
      <ol class="steps">${steps.map(stepHtml).join('')}<li class="demo-note" style="padding-top:6px">Статусы в макете — демо: настоящей проверки не было.</li></ol></section>`);
    el._body = $('.steps', el);
    el._open0 = open;
    return el;
  }
  // В концепции с «слоем» (B) подробности открываются во временном слое у сферы, иначе — прямо в ленте.
  function toggleTrail(el, open) {
    const layer = CFG.layer && CFG.layer(), any = $('#layer');
    el.toggleAttribute('data-open', open);
    $('.trail-head', el).setAttribute('aria-expanded', String(open));
    if (layer && open) {
      $$('.trail[data-open]').forEach((o) => { if (o !== el) toggleTrail(o, false); });
      $('.layer-body', layer).replaceChildren(el._body);
      layer.hidden = false;
      root.dataset.layer = 'open';
    } else if (!el.contains(el._body) && (!layer || !open)) {
      el.append(el._body);
      if (any) { any.hidden = true; delete root.dataset.layer; }
    }
  }
  function applyTrail() {
    $$('#thread .trail').forEach((el) => toggleTrail(el, S.trail === 'auto' ? el._open0 : S.trail === 'open'));
  }
  function approval() {
    return h(`<section class="approval" role="alertdialog" tabindex="-1" aria-labelledby="apT" aria-describedby="apD">
      <h3 id="apT">Нужно ваше решение</h3>
      <p class="for">К вашему запросу «Удали старые черновики из „Загрузок“» · сегодня, 14:21</p>
      <dl id="apD"><dt>Что</dt><dd>Удалить 12 файлов: черновики .docx и .tmp старше 30 дней</dd>
      <dt>Где</dt><dd>Папка «Загрузки» на этом компьютере</dd>
      <dt>Риск</dt><dd class="risk">Удаление насовсем, мимо корзины. Вернуть файлы будет нельзя.</dd></dl>
      <div class="row"><button class="btn" data-act="deny">Отклонить <kbd>Esc</kbd></button><button class="btn go" data-act="allow">Разрешить <kbd>Enter</kbd></button></div></section>`);
  }
  function decide(allow) {
    if (!pending) return;
    pending.replaceWith(h(`<p class="verdict">${allow ? 'Вы разрешили удаление. В макете ничего не удаляется.' : 'Вы отклонили. Файлы на месте.'}</p>`));
    pending = null;
    setState(allow ? 'success' : 'idle');
    $$('[data-now]').forEach((e) => { e.textContent = ''; });
    $('#composer textarea').focus();
  }

  function go(n) {
    scenario = n;
    root.dataset.scenario = n;
    root.dataset.mode = MODE[n];
    pending = null;
    const any = $('#layer'), t = $('#thread');
    if (any) { any.hidden = true; delete root.dataset.layer; }
    t.replaceChildren();
    const add = (x) => t.append(typeof x === 'string' ? h(x) : x);
    if (n === 2) {
      add(U('Что у меня на сегодня?', '14:02'));
      add(N('<p>Две вещи: в 15:00 созвон с Маратом, а до вечера нужно отправить смету. Напомнить за десять минут до созвона?</p>', '14:02'));
      add(U('Да, напомни.', '14:03'));
      add(N('<p>Поставил напоминание на 14:50.</p>', '14:03'));
      add(trail([['ok', 'Напоминание на 14:50 записано']], false));
    } else if (n === 3) {
      add(U('Как лучше разложить файлы проекта по папкам?', '14:10'));
      add(N(LONG, '14:10'));
    } else if (n === 4) {
      add(U('Что лежит в папке «Договоры»?', '14:14'));
      add(trail(STEPS_A, false));
      add(N('<p>14 файлов, 38 МБ. Самый свежий — «Смета 2026.xlsx».</p>', '14:14'));
      add(U('Собери по ней отчёт и положи в рабочую папку.', '14:16'));
      add(trail(STEPS_B, true));
    } else if (n === 5) {
      add(U('Удали старые черновики из «Загрузок».', '14:21'));
      add(N('<p>Нашёл 12 черновиков старше 30 дней. Удаление нельзя отменить, поэтому сначала спрошу.</p>', '14:21'));
      add(pending = approval());
    } else if (n === 6) {
      add(`<div class="voice"><div class="meter" aria-hidden="true">${'<i></i>'.repeat(28)}</div><p class="vline" aria-live="polite"></p>
        <div class="chips" role="group" aria-label="Состояния, демо">${Object.keys(VOICE_LINE).map((s) => `<button class="chip" data-st="${s}">${PHRASE[s]}</button>`).join('')}</div>
        <p class="demo-note">Уровень звука здесь — демо-сигнал, не микрофон. Вне «слушаю» и «отвечаю» сфера на звук не реагирует.</p></div>`);
    }
    $$('[data-now]').forEach((e) => { e.textContent = NOW[n] || ''; });
    $$('.h-item').forEach((b) => b.setAttribute('aria-current', String(+b.dataset.go === n && !b.dataset.old)));
    $$('.demo a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (href.includes('workshop=layout')) a.href = `#scenario=${n <= 5 ? n : 2}&workshop=layout`;
      if (href.includes('workshop=orbs')) a.href = `#scenario=${n <= 5 ? n : 2}&workshop=orbs`;
      a.setAttribute('aria-current', String(href === `#scenario=${n}`));
    });
    if (CFG.onScenario) CFG.onScenario(n, S);
    applyTrail();
    setState(ORB_STATE[n]);
    voiceUi();
    t.scrollTop = n === 3 ? 0 : t.scrollHeight;
    cancelAnimationFrame(raf);
    if (n === 6) raf = requestAnimationFrame(voiceTick);
    else if (orb) orb.setVoice(0);
    if (pending) pending.focus();
  }
  function voiceUi() {
    const line = $('.vline');
    if (!line) return;
    line.textContent = VOICE_LINE[state] || '';
    $$('.chip[data-st]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.st === state)));
  }
  // Демо-сигнал вместо микрофона: сфера и полоски получают один и тот же уровень.
  function voiceTick(ts) {
    const t = ts / 1000, on = state === 'listening' || state === 'speaking';
    const lv = on ? Math.min(1, Math.max(0, 0.48 + 0.34 * Math.sin(t * 6.1) * Math.sin(t * 1.3) + 0.18 * Math.sin(t * 14.7))) : 0;
    orb.setVoice(lv);
    $$('.meter i').forEach((b, i) => { b.style.height = 4 + Math.round(30 * lv * (0.35 + 0.65 * Math.abs(Math.sin(i * 0.9 + t * 5)))) + 'px'; });
    raf = requestAnimationFrame(voiceTick);
  }
  function send(text) {
    const t = $('#thread');
    if (MODE[scenario] !== 'dialog' || pending) { root.dataset.mode = 'dialog'; t.replaceChildren(); pending = null; cancelAnimationFrame(raf); }
    t.append(h(U(esc(text), 'сейчас')));
    setState('thinking');
    setTimeout(() => {
      t.append(h(N('<p>Это макет: настоящего ответа здесь нет. Готовые примеры — в сценариях 2–6 вверху справа.</p>', 'сейчас')));
      setState('idle');
      t.scrollTop = t.scrollHeight;
    }, 700);
    t.scrollTop = t.scrollHeight;
  }

  // ── Мастерская ──
  const SECTIONS = { orbs: 'Сферы', layout: 'Композиция', chat: 'Чат', color: 'Цвета и фон', fx: 'Эффекты', looks: 'Мои оформления' };
  const HINTS = {
    layout: 'В приложении сфера уступает место длинному ответу, только если вы сами это включили.',
    color: 'Темы приложения остаются как есть; в макете показана одна — «Ночь». Цвет акцента слушаются не все сферы — смотрите раздел «Сферы».',
    fx: 'Если в Windows включено «уменьшить движение», анимации выключаются сами. Когда окно скрыто, сфера не рисуется — это уже есть в её коде. Скорость и нагрузка в макете не измерялись.',
  };
  const fmt = (k) => (SCHEMA[k].unit ? S[k] + ' ' + SCHEMA[k].unit : String(Math.round(S[k] * 100) / 100));
  function field(k) {
    const d = SCHEMA[k], off = d.cap && !ORBS[S.orb].caps.includes(d.cap);
    if (d.opts) return `<fieldset class="f"><legend>${d.label}</legend><div class="seg">${Object.entries(d.opts).map(([v, t]) => `<label><input type="radio" name="${k}" value="${v}"${S[k] === v ? ' checked' : ''}>${t}</label>`).join('')}</div></fieldset>`;
    if (d.bool) return `<div class="f"><label class="sw"><input type="checkbox" name="${k}"${S[k] ? ' checked' : ''}>${d.label}</label></div>`;
    if (d.colors) return `<fieldset class="f"><legend>${d.label}</legend><div class="sws">${d.colors.map((c) => `<label style="--c:${c}" title="${c}"><input type="radio" name="${k}" value="${c}" aria-label="Цвет ${c}"${S[k] === c ? ' checked' : ''}></label>`).join('')}</div></fieldset>`;
    return `<fieldset class="f"${off ? ' disabled' : ''}><label class="l" for="f-${k}">${d.label}<output>${off ? 'эта сфера так не умеет' : fmt(k)}</output></label><input type="range" id="f-${k}" name="${k}" min="${d.min}" max="${d.max}" step="${d.step}" value="${S[k]}"></fieldset>`;
  }
  function killPreviews() { previews.forEach((o) => o.destroy()); previews = []; }
  function renderWs(tab) {
    wsTab = SECTIONS[tab] ? tab : 'orbs';
    killPreviews();
    $$('.ws nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === wsTab)));
    const body = $('.ws-body');
    let html = Object.keys(SCHEMA).filter((k) => SCHEMA[k].sec === wsTab && k !== 'orb').map(field).join('');
    if (HINTS[wsTab]) html += `<p class="hint" style="margin-top:4px">${HINTS[wsTab]}</p>`;
    if (wsTab === 'orbs') {
      const groups = [...new Set(Object.values(ORBS).map((o) => o.group))];
      html = `<p class="hint" style="margin-top:0">Обе системы (<b>NoxOrb</b> и <b>JarvisOrb</b>) подключены без изменения движков. Параметры каждой сферы хранятся отдельно. Карточки оживают при наведении.</p>`
        + groups.map((g) => `<h3>${g}</h3><div class="cards">${Object.entries(ORBS).filter(([, o]) => o.group === g).map(([id, o]) => `
          <div class="card" data-orb-card="${id}"${S.orb === id ? ' data-on' : ''}><canvas aria-hidden="true"></canvas><b>${o.title}</b>
          <span class="badge">${o.engine}<i>${o.hint}</i></span>
          <button class="btn sm pick" data-pick="${id}"${S.orb === id ? ' disabled' : ''}>${S.orb === id ? 'Активна' : 'Выбрать'}</button>
          <ul class="caps" aria-label="Что умеет">${Object.entries(CAPS).map(([c, t]) => `<li${o.caps.includes(c) ? '' : ' class="no" title="Этот движок так не умеет"'}>${t}</li>`).join('')}</ul></div>`).join('')}</div>`).join('')
        + `<div class="orb-presets"><b>Пресеты сфер:</b>${orbPresets.map((p) => `<button class="btn sm" data-orb-preset="${p.id}">${p.name}</button>`).join('')}<button class="btn sm" data-orb-act="save-preset">+ Сохранить</button><button class="btn sm" data-orb-act="reset">По умолчанию</button></div>`
        + `<p class="msgline" id="orbMsg" role="status"></p>`
        + `<h3>Параметры активной сферы («${ORBS[S.orb].title}»)</h3>` + html
        + `<h3>Мои сферы и будущие движки</h3><div class="cards"><div class="card" style="opacity:.82"><div style="width:56px;height:56px;border:1px dashed var(--border);border-radius:50%;display:grid;place-items:center;color:var(--text-3)">+</div><b>Своя сфера</b><span class="badge">Пользовательский пакет<i>будущие движки и пресеты (Gate 3)</i></span><button class="btn sm pick" disabled>Скоро</button></div></div>`;
    }
    if (wsTab === 'looks') {
      const mine = localStorage.getItem('nox-aether-look');
      html = `<fieldset class="f"><legend>Готовые</legend><div class="row">${Object.keys(PRESETS).map((p) => `<button class="btn sm" data-preset="${p}">${p}</button>`).join('')}${mine ? '<button class="btn sm" data-preset="mine">Моё</button>' : ''}</div></fieldset>
        <div class="f row"><button class="btn sm" data-look="save">Сохранить текущее как «Моё»</button><button class="btn sm" data-look="export">Показать настройки текстом</button><button class="btn sm" data-look="import">Применить из текста</button></div>
        <textarea aria-label="Настройки оформления текстом" spellcheck="false" placeholder="Сюда можно вставить настройки, сохранённые раньше"></textarea>
        <p class="msgline" role="status"></p>
        <p class="hint" style="margin-top:8px">В таком тексте только внешний вид. Прав, ключей, путей и переписки в нём нет, и принять их отсюда нельзя.</p>`;
    }
    body.innerHTML = html;
    if (wsTab === 'orbs') {
      $$('[data-orb-card]', body).forEach((card) => {
        const spec = ORBS[card.dataset.orbCard];
        const o = (spec.makePreview || spec.make)($('canvas', card));
        if (spec.makePreview && o.setTune) o.setTune({ glow: 1.15, speed: 1, density: 1.75 });
        o.setAnimated(false);
        card.onmouseenter = () => { if (S.motion !== 'off') o.setAnimated(true); };
        card.onmouseleave = () => o.setAnimated(false);
        previews.push(o);
      });
    }
  }
  function fitWs() {
    const share = innerWidth <= 960 ? 0.61 : 0.55;
    const s = Math.min((innerWidth * (1 - share) - 34) / innerWidth, (innerHeight - 78) / innerHeight);
    root.style.setProperty('--ws-s', s.toFixed(3));
  }
  function openWs(tab) {
    fitWs();
    root.dataset.ws = 'open';
    $('.ws').hidden = $('.ws-back').hidden = false;
    renderWs(tab || wsTab);
  }
  function closeWs() {
    if (root.dataset.ws !== 'open') return;
    killPreviews();
    $('.ws-body').replaceChildren();
    delete root.dataset.ws;
    $('.ws').hidden = $('.ws-back').hidden = true;
  }
  function look(act) {
    const ta = $('.ws textarea'), say = (t) => { $('.ws .msgline').textContent = t; };
    if (act === 'save') { localStorage.setItem('nox-aether-look', JSON.stringify(S)); renderWs('looks'); $('.ws .msgline').textContent = 'Сохранено на этом компьютере.'; }
    if (act === 'export') { ta.value = JSON.stringify({ kind: 'nox-look', v: 1, look: S }, null, 1); say('Скопируйте текст и сохраните где удобно.'); }
    if (act === 'import') {
      let data = null;
      try { data = ta.value.length <= 4000 ? JSON.parse(ta.value) : null; } catch { data = null; }
      if (!data || data.kind !== 'nox-look' || data.v !== 1) return say('Не похоже на настройки оформления Nox. Ничего не изменено.');
      const ok = clean(data.look);
      setAll(ok);
      say(`Применено настроек: ${Object.keys(ok).length}. Лишнее пропущено.`);
    }
  }

  // ── Сборка страницы ──
  function build() {
    $$('[data-composer]').forEach((e) => e.append(h(`<form class="composer" id="composer">
      <button type="button" class="ib" aria-label="Прикрепить файл" title="Прикрепить файл">${ico('clip')}</button>
      <textarea rows="1" placeholder="Что сделать?" aria-label="Сообщение для Nox"></textarea>
      <button type="button" class="tier" data-tier title="Какая модель отвечает">Быстрая${ico('chev')}</button>
      <button type="button" class="ib" data-mic aria-label="Говорить голосом" title="Говорить голосом">${ico('mic')}</button>
      <button class="ib send" aria-label="Отправить" title="Отправить (Enter)">${ico('send')}</button></form>`)));
    $$('[data-history]').forEach((e) => {
      let old = false;
      e.innerHTML = `<button class="h-item" data-go="1">${ico('plus')} &nbsp;Новый разговор</button>` + HISTORY.map(([t, n]) => {
        if (!n) { old = t === 'Раньше'; return `<p class="h-cap">${t}</p>`; }
        return `<button class="h-item" data-go="${n}"${old ? ' data-old="1"' : ''} title="${esc(t)}">${t}</button>`;
      }).join('');
    });
    document.body.append(
      h(`<nav class="demo" aria-label="Сценарии макета"><span class="tag">Демо-данные</span>${TITLES.slice(1, 6).map((t, i) => `<a href="#scenario=${i + 1}" title="${t}">${i + 1}</a>`).join('')}<a href="#scenario=2&workshop=layout" title="Настройка внешнего вида">6 Вид</a><a href="#scenario=2&workshop=orbs" title="Выбор сферы из библиотеки">7 Сферы</a><a href="#scenario=6" title="Голос (демо)">Голос</a></nav>`),
      h(`<section class="ws" hidden role="dialog" aria-label="Мастерская Nox"><header><h2>Мастерская Nox</h2><button class="btn sm" data-ws-close>Готово <kbd>Esc</kbd></button></header>
        <nav aria-label="Разделы">${Object.entries(SECTIONS).map(([k, t]) => `<button data-tab="${k}">${t}</button>`).join('')}</nav><div class="ws-body"></div></section>`),
      h('<button class="ws-back" hidden data-ws-close>Так окно выглядит сейчас · нажмите, чтобы вернуться</button>'),
    );
    $('#orbMount').setAttribute('role', 'img');
  }
  function route() {
    const m = /scenario=([1-6])/.exec(location.hash), w = /workshop(?:=([a-z]+))?/.exec(location.hash);
    const n = m ? +m[1] : w ? 2 : 1;
    if (n !== scenario) go(n);
    // Для проверки: #scenario=2&set=orbPos:left,msg:cards — настройки прямо в адресе, через ту же строгую схему.
    const sm = /set=([^&]+)/.exec(location.hash);
    if (sm && sm[1] !== lastSet) {
      const o = {};
      decodeURIComponent(lastSet = sm[1]).split(',').forEach((p) => { const [k, v] = p.split(':'), d = SCHEMA[k]; if (d) o[k] = d.bool ? v === 'true' : d.opts || d.colors ? v : +v; });
      setAll(o);
    }
    if (w) openWs(w[1]); else closeWs();
    setTimeout(selfcheck, 350);
  }
  const leaveWs = () => { location.hash = 'scenario=' + scenario; };

  document.addEventListener('click', (e) => {
    const q = (s) => e.target.closest(s);
    let b;
    if ((b = q('.trail-head'))) toggleTrail(b.parentElement, !b.parentElement.hasAttribute('data-open'));
    else if ((b = q('[data-copy]'))) {
      const done = () => { b.lastElementChild.textContent = 'Скопировано'; setTimeout(() => { b.lastElementChild.textContent = 'Копировать'; }, 1500); };
      const text = b.closest('.code').querySelector('code').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(done, done);
    } else if ((b = q('[data-fix]'))) b.closest('.fix').innerHTML = `<p style="margin:0">${b.dataset.fix} <span class="demo-note">В макете ничего не происходит.</span></p>`;
    else if ((b = q('[data-act]'))) decide(b.dataset.act === 'allow');
    else if ((b = q('.chip[data-st]'))) { setState(b.dataset.st); voiceUi(); }
    else if ((b = q('[data-tier]'))) b.firstChild.textContent = b.firstChild.textContent === 'Быстрая' ? 'Умная' : 'Быстрая';
    else if (q('[data-mic]')) location.hash = 'scenario=6';
    else if ((b = q('[data-go]'))) { location.hash = 'scenario=' + b.dataset.go; $$('.pop').forEach((p) => { p.hidden = true; }); }
    else if ((b = q('[data-rail-toggle]'))) b.setAttribute('aria-expanded', String($('#rail').toggleAttribute('data-open')));
    else if ((b = q('[data-hist-toggle]'))) { const p = $('.pop.hist'); p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); }
    else if (q('[data-layer-close]')) $$('.trail[data-open]').forEach((t) => toggleTrail(t, false));
    else if (q('[data-open-ws]')) location.hash = `scenario=${scenario}&workshop`;
    else if (q('[data-ws-close]')) leaveWs();
    else if ((b = q('.ws nav button'))) renderWs(b.dataset.tab);
    else if ((b = q('[data-pick]'))) { syncOrbParams(b.dataset.pick); after(['orb']); renderWs('orbs'); $('#orbMsg').textContent = `Включена «${ORBS[S.orb].title}»; её настройки восстановлены.`; }
    else if ((b = q('[data-orb-preset]'))) {
      const p = orbPresets.find((x) => x.id === b.dataset.orbPreset);
      if (p) { syncOrbParams(p.orb); Object.assign(S, p.vals); ORB_KEYS.forEach(apply); after(['orb', ...ORB_KEYS]); renderWs('orbs'); $('#orbMsg').textContent = `Применён пресет «${p.name}».`; }
    } else if ((b = q('[data-orb-act="reset"]'))) {
      Object.assign(S, { orbK: 1, glow: 1, speed: 1, dens: 1, ...(ORBS[S.orb].defaults || {}) });
      ORB_KEYS.forEach(apply); after(ORB_KEYS); renderWs('orbs'); $('#orbMsg').textContent = `Параметры «${ORBS[S.orb].title}» сброшены к умолчаниям.`;
    } else if ((b = q('[data-orb-act="save-preset"]'))) {
      const name = `Мой пресет (${ORBS[S.orb].title.split(' ')[0]})`;
      const idx = orbPresets.findIndex((x) => x.id === 'custom-last');
      const item = { id: 'custom-last', name, orb: S.orb, vals: { orbK: S.orbK, glow: S.glow, speed: S.speed, dens: S.dens } };
      if (idx >= 0) orbPresets[idx] = item; else orbPresets.push(item);
      renderWs('orbs'); $('#orbMsg').textContent = `Сохранено в библиотеке: «${name}».`;
    } else if ((b = q('[data-preset]'))) {
      let p = PRESETS[b.dataset.preset];
      if (!p) { try { p = JSON.parse(localStorage.getItem('nox-aether-look')); } catch { p = null; } }
      setAll({ ...DEFAULTS, ...clean(p) });
      $('.ws .msgline').textContent = `Применено: «${b.textContent}».`;
    } else if ((b = q('[data-look]'))) look(b.dataset.look);
    if (!q('.pop') && !q('[data-hist-toggle]')) $$('.pop').forEach((p) => { p.hidden = true; });
    if (e.target.closest('a[href="#"]')) e.preventDefault();
  });
  document.addEventListener('input', (e) => {
    const k = e.target.name, d = SCHEMA[k];
    if (e.target.matches('.composer textarea')) { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; return; }
    if (!d || !e.target.closest('.ws')) return;
    S[k] = d.bool ? e.target.checked : d.opts || d.colors ? e.target.value : +e.target.value;
    apply(k);
    after([k]);
    const out = e.target.closest('.f').querySelector('output');
    if (out) out.textContent = fmt(k);
  });
  document.addEventListener('submit', (e) => {
    e.preventDefault();
    const ta = $('textarea', e.target);
    if (!ta.value.trim()) return;
    send(ta.value.trim());
    ta.value = '';
    ta.style.height = 'auto';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.matches('.composer textarea')) { e.preventDefault(); e.target.form.requestSubmit(); return; }
    if (e.key === 'Escape' && root.dataset.ws === 'open') return leaveWs();
    if (e.key === 'Escape') $$('.pop').forEach((p) => { p.hidden = true; });
    // Подтверждение: Esc — отклонить; Enter — разрешить, только когда фокус на самой карточке, а не на кнопке или в поле.
    if (pending && root.dataset.ws !== 'open') {
      if (e.key === 'Escape') decide(false);
      else if (e.key === 'Enter' && e.target === pending) decide(true);
    }
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => { if (root.dataset.ws === 'open') fitWs(); });

  // Самопроверка макета: итог в <html data-selfcheck>. «ok» — нет ошибок, бокового скролла и обрезанного поля ввода.
  function selfcheck() {
    const bad = [...errors];
    const got = clean({ orbPos: 'evil', fs: 999, hue: 'red', time: 'yes', unsafe: true, chatW: 600 });
    if (JSON.stringify(got) !== '{"chatW":600,"fs":18}') bad.push('schema');
    if (!orb) bad.push('orb');
    if (root.dataset.ws !== 'open') {
      const r = $('#composer').getBoundingClientRect(), t = $('#thread');
      if (document.body.scrollWidth > innerWidth || t.scrollWidth > t.clientWidth + 1) bad.push('hscroll');
      if (r.left < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5 || r.top < 0 || r.width < 220) bad.push('composer');
    } else {
      const wb = $('.ws-body');
      if (wb && wb.scrollWidth > wb.clientWidth + 2) bad.push('ws_hscroll');
    }
    root.dataset.selfcheck = (bad.join('|') || 'ok') + ` @${innerWidth}x${innerHeight}`;
    return root.dataset.selfcheck;
  }

  build();
  Object.keys(SCHEMA).forEach(apply);
  mountOrb();
  route();
  setTimeout(selfcheck, 1200);
  window.NoxProto = { S, go, setAll, selfcheck };
})();
