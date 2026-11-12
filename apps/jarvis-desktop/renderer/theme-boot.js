/* Тема ставится этим файлом без defer, до первой отрисовки: иначе окно мелькнёт чужой темой.
 * Сохранённое значение может быть «system»; на корне всегда стоит настоящая тема.
 * Здесь же цвет акцента: свой цвет поверх цвета темы (localStorage jarvis.accent), только на этом компьютере. */
(() => {
  'use strict';

  const IDS = ['dark', 'light', 'graphite', 'lime', 'paper', 'forest', 'wine', 'cobalt', 'aurora', 'ember', 'dawn', 'glass',
    'liquid', 'liquidday', 'frost', 'gradient', 'gradientday', 'midnight', 'neon', 'starry', 'moonlight', 'sunrise', 'system'];
  const resolve = (id) => {
    // Убранные темы (archive, tablet, acrylic и их дневные) и мусор тихо открывают «Ночь».
    if (id !== 'system') return IDS.includes(id) ? id : 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  };
  const apply = (id) => { document.documentElement.dataset.theme = resolve(id); applyAccent(); applyFx(); };

  // Цвета акцента: на тёмных темах светлее, на светлых темнее, чтобы текст и значки акцентом читались (от 4,5:1).
  const LIGHT_THEMES = ['light', 'lime', 'paper', 'dawn', 'liquidday', 'frost', 'gradientday'];
  const ACCENTS = [
    { id: 'theme', name: 'Как в теме' },
    { id: 'blue', name: 'Синий', dark: '#6AA6FF', light: '#2554C7' },
    { id: 'violet', name: 'Фиолетовый', dark: '#AB92FF', light: '#5F3FCB' },
    { id: 'green', name: 'Зелёный', dark: '#5EE0A0', light: '#17703F' },
    { id: 'pink', name: 'Розовый', dark: '#FF86BC', light: '#A82B63' },
    { id: 'orange', name: 'Оранжевый', dark: '#FFA55E', light: '#9A4E00' },
    { id: 'teal', name: 'Бирюзовый', dark: '#4FD6C8', light: '#0E6B63' },
    { id: 'silver', name: 'Серебро', dark: '#D3DAE2', light: '#3E4752' },
  ];
  // Значение акцента: id из ACCENTS или свой цвет '#RRGGBB'. Всё прочее — «Как в теме».
  const normHex = (v) => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    return '#' + h.toUpperCase();
  };
  const normAccent = (v) => (typeof v === 'string' && ACCENTS.some((x) => x.id === v) ? v : (normHex(v) || 'theme'));
  let accent = 'theme';
  // Что получилось при последнем применении: просили, поставили, сдвинут ли цвет ради контраста.
  let accentInfo = { requested: null, applied: null, adjusted: false, direction: null };

  // ── Читаемость акцента ────────────────────────────────────────────────
  // Свой цвет не должен уронить контраст: если на фоне выбранной темы акцент как текст
  // хуже 4,5:1, он минимально сдвигается к белому или чёрному. Текст на плашке акцента —
  // белый или тёмный, что читается лучше. Чистые функции: их проверяет tests/appearance.test.js.
  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  };
  const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const contrast = (a, b) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const MIN_CONTRAST = 4.5;
  const readable = (hex, backgrounds, min = MIN_CONTRAST) => {
    const rgb = hexToRgb(hex);
    const backs = (backgrounds || []).map(hexToRgb).filter(Boolean);
    if (!rgb || !backs.length) return hex;
    const ok = (c) => backs.every((b) => contrast(c, b) >= min);
    if (ok(rgb)) return hex;
    const dark = backs.reduce((s, b) => s + luminance(b), 0) / backs.length < 0.4;
    const target = dark ? [255, 255, 255] : [0, 0, 0];
    for (let i = 1; i <= 20; i++) {
      const c = rgb.map((v, j) => v + (target[j] - v) * (i / 20));
      if (ok(c)) return rgbToHex(c);
    }
    return rgbToHex(target);
  };
  // Фоны, на которых акцент используется как текст: фон окна и панели поверх него.
  const themeBacks = () => {
    try {
      const cs = getComputedStyle(document.documentElement);
      return ['--bg', '--surface', '--surface-2', '--surface-3']
        .map((name) => cs.getPropertyValue(name).trim())
        .filter((v) => /^#[0-9a-f]{6}$/i.test(v));
    } catch { return []; }
  };
  const inkOn = (rgb) => (contrast(rgb, [255, 255, 255]) >= contrast(rgb, [11, 16, 24]) ? '#FFFFFF' : '#0B1018');

  function applyAccent() {
    const root = document.documentElement;
    const custom = normHex(accent);
    const a = custom ? { id: 'custom', dark: custom, light: custom } : ACCENTS.find((x) => x.id === accent);
    if (!a || a.id === 'theme') {
      root.removeAttribute('data-accent');
      root.style.removeProperty('--user-hue');
      root.style.removeProperty('--user-ink');
      accentInfo = { requested: null, applied: null, adjusted: false, direction: null };
      return;
    }
    const light = LIGHT_THEMES.includes(root.dataset.theme);
    const want = (light ? a.light : a.dark).toUpperCase();
    const hue = readable(want, themeBacks()).toUpperCase();
    const hueRgb = hexToRgb(hue);
    const adjusted = hue !== want;
    accentInfo = { requested: want, applied: hue, adjusted, direction: adjusted ? (luminance(hueRgb) > luminance(hexToRgb(want)) ? 'lighter' : 'darker') : null };
    root.dataset.accent = a.id;
    root.style.setProperty('--user-hue', hue);
    root.style.setProperty('--user-ink', hueRgb ? inkOn(hueRgb) : (light ? '#FFFFFF' : '#0B1018'));
  }
  // id из ACCENTS или свой цвет HEX. Возвращает, что применилось (accentInfo).
  function setAccent(id) {
    accent = normAccent(id);
    try { localStorage.setItem('jarvis.accent', JSON.stringify(accent)); } catch { /* нет хранилища */ }
    applyAccent();
    document.dispatchEvent(new Event('jarvis:accent'));
    return { ...accentInfo };
  }

  // ── Свой вид: шрифты, размер текста, скругление, прозрачность панелей, свет за окном, размер шара ──
  // Хранится в localStorage jarvis.look, применяется до первой отрисовки. Шрифты берутся из установленных в Windows
  // и встроенных Inter и IBM Plex Serif: сеть окну закрыта, скачивать шрифты нельзя.
  const SANS = '"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif';
  const SERIF_END = ', Georgia, "Times New Roman", serif';
  const FONTS = {
    ui: {
      theme: ['Как в теме', null],
      inter: ['Inter', `"Inter", ${SANS}`],
      system: ['Системный Windows', SANS],
      aptos: ['Aptos', `"Aptos", ${SANS}`],
      bahn: ['Bahnschrift', `"Bahnschrift", ${SANS}`],
      candara: ['Candara', `"Candara", ${SANS}`],
      century: ['Century Gothic', `"Century Gothic", ${SANS}`],
      book: ['Книжный Sitka', `"Sitka Text", "Sitka Small"${SERIF_END}`],
    },
    head: {
      theme: ['Как в теме', null],
      sitka: ['Sitka', `"Sitka Heading", "Sitka Text"${SERIF_END}`],
      plex: ['IBM Plex Serif', `"IBM Plex Serif"${SERIF_END}`],
      georgia: ['Georgia', `Georgia, "Times New Roman", serif`],
      cambria: ['Cambria', `"Cambria"${SERIF_END}`],
      constantia: ['Constantia', `"Constantia"${SERIF_END}`],
      ui: ['Тот же, что в интерфейсе', 'ui'],
    },
  };
  const SIZES = { s: ['Мелкий', 0.92], m: ['Обычный', 1], l: ['Крупный', 1.08], xl: ['Очень крупный', 1.16] };
  const ROUNDS = { s: ['Острое', 0.5], m: ['Обычное', 1], l: ['Мягкое', 1.5] };
  const PANELS = { s: ['Лёгкие', 2.5], m: ['Как в теме', 4], l: ['Плотные', 7], xl: ['Матовые', 11] };
  const ORBS = { s: ['Меньше', 0.8], m: ['Обычный', 1], l: ['Больше', 1.15] };
  // Размытие стеклянных поверхностей (поле ввода, диалоги). «Стекло» включает размытие и у панелей.
  const BLURS = { off: ['Без размытия', 0], m: ['Как в теме', 20], l: ['Стекло', 28] };
  // Фон окна: цвет темы с её градиентом или спокойный сплошной.
  const BGS = { theme: ['Как в теме', 'theme'], solid: ['Сплошной', 'solid'], image: ['Своя картинка', 'image'] };
  // Своя картинка (хранит backdrop.js): затемнение цветом темы в процентах и размытие в пикселях.
  const BG_DIMS = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [String(i * 5), [`${i * 5} %`, i * 5]]));
  const BG_BLURS = { 0: ['Чёткая', 0], 6: ['Лёгкое', 6], 16: ['Сильное', 16] };
  // Эффект на фоне отдельно от темы. «Как в теме» — тот, что задуман темой (THEME_FX), рисунки в themes.css.
  const FXS = {
    theme: ['Как в теме'], off: ['Без эффекта'], stars: ['Звёзды'], waves: ['Волны'], snow: ['Снег'], rain: ['Дождь'],
    pattern: ['Узоры'], moon: ['Лунный свет'], dawn: ['Зарево'], drift: ['Перелив'], grid: ['Сетка'],
  };
  const THEME_FX = { starry: 'stars', liquid: 'waves', liquidday: 'waves', moonlight: 'moon', sunrise: 'dawn', gradient: 'drift', gradientday: 'drift', neon: 'grid' };
  // Прозрачность и радиус самого окна. Ключи — проценты и пиксели строкой: так их хранит jarvis.look
  // (как остальные id настроек). 0 % прозрачности и 0 px радиуса — как было до настройки.
  const WIN_ALPHAS = {
    0: ['Как сейчас', 0], 5: ['5 %', 5], 10: ['10 %', 10], 15: ['15 %', 15], 20: ['20 %', 20],
    25: ['25 %', 25], 30: ['30 %', 30], 35: ['35 %', 35], 40: ['40 %', 40], 45: ['45 %', 45],
    50: ['50 %', 50], 55: ['55 %', 55], 60: ['60 %', 60],
  };
  const WIN_RADII = { 0: ['Прямые', 0], 8: ['8', 8], 14: ['14', 14], 22: ['22', 22], 28: ['28', 28] };
  const FS = { '2xs': 11, xs: 12, sm: 13, md: 14, read: 15, lg: 16, xl: 20, '2xl': 24 };
  const LOOK_DEFAULT = { ui: 'theme', head: 'theme', reply: 'theme', size: 'm', round: 'm', panel: 'm', orb: 'm', blur: 'm', bg: 'theme', bgDim: '40', bgBlur: '6', fx: 'theme', glow: true, winAlpha: '0', winRadius: '0' };
  let look = { ...LOOK_DEFAULT };

  // Битое сохранённое значение не должно ломать окно: каждая настройка проверяется по своему списку,
  // неизвестное значение падает на безопасный вариант по умолчанию.
  const pickId = (map, value, fallback) => (typeof value === 'string' && Object.prototype.hasOwnProperty.call(map, value) ? value : fallback);
  function sanitizeLook(raw) {
    const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      ui: pickId(FONTS.ui, v.ui, LOOK_DEFAULT.ui),
      head: pickId(FONTS.head, v.head, LOOK_DEFAULT.head),
      reply: pickId({ theme: 1, head: 1, ui: 1 }, v.reply, LOOK_DEFAULT.reply),
      size: pickId(SIZES, v.size, LOOK_DEFAULT.size),
      round: pickId(ROUNDS, v.round, LOOK_DEFAULT.round),
      panel: pickId(PANELS, v.panel, LOOK_DEFAULT.panel),
      orb: pickId(ORBS, v.orb, LOOK_DEFAULT.orb),
      blur: pickId(BLURS, v.blur, LOOK_DEFAULT.blur),
      bg: pickId(BGS, v.bg, LOOK_DEFAULT.bg),
      bgDim: pickId(BG_DIMS, v.bgDim, LOOK_DEFAULT.bgDim),
      bgBlur: pickId(BG_BLURS, v.bgBlur, LOOK_DEFAULT.bgBlur),
      fx: pickId(FXS, v.fx, LOOK_DEFAULT.fx),
      glow: v.glow !== false,
      winAlpha: pickId(WIN_ALPHAS, v.winAlpha, LOOK_DEFAULT.winAlpha),
      winRadius: pickId(WIN_RADII, v.winRadius, LOOK_DEFAULT.winRadius),
    };
  }
  function applyLook() {
    const r = document.documentElement;
    const ui = FONTS.ui[look.ui] || FONTS.ui.theme;
    const head = FONTS.head[look.head] || FONTS.head.theme;
    const uiStack = look.ui === 'theme' ? null : ui[1];
    const headStack = look.head === 'theme' ? null : (head[1] === 'ui' ? (uiStack || 'var(--font)') : head[1]);
    if (uiStack) r.style.setProperty('--font', uiStack);
    else r.style.removeProperty('--font');
    if (headStack) r.style.setProperty('--font-head', headStack);
    else r.style.removeProperty('--font-head');
    if (look.reply === 'theme') r.style.removeProperty('--font-reply');
    else if (look.reply === 'ui') r.style.setProperty('--font-reply', uiStack || 'var(--font)');
    else if (headStack) r.style.setProperty('--font-reply', headStack);
    else r.style.removeProperty('--font-reply');
    const k = (SIZES[look.size] || SIZES.m)[1];
    for (const [key, px] of Object.entries(FS)) r.style.setProperty(`--fs-${key}`, `${Math.round(px * k * 2) / 2}px`);
    const q = (ROUNDS[look.round] || ROUNDS.m)[1];
    r.style.setProperty('--panel-r', `${Math.round(16 * q)}px`);
    r.style.setProperty('--r-sm', `${Math.round(6 * q)}px`);
    r.style.setProperty('--r-md', `${Math.round(8 * q)}px`);
    r.style.setProperty('--r-lg', `${Math.round(12 * q)}px`);
    r.style.setProperty('--r-xl', `${Math.round(16 * q)}px`);
    // «Как в теме» не пишется на корень: плотность панелей и размытие тогда задаёт тема (themes.css).
    if (look.panel === 'm') r.style.removeProperty('--panel-pct');
    else r.style.setProperty('--panel-pct', `${(PANELS[look.panel] || PANELS.m)[1]}%`);
    r.style.setProperty('--orb-scale', String((ORBS[look.orb] || ORBS.m)[1]));
    if (look.blur === 'm') r.style.removeProperty('--glass-blur');
    else r.style.setProperty('--glass-blur', `${(BLURS[look.blur] || BLURS.m)[1]}px`);
    if (look.blur === 'off' || look.blur === 'l') r.dataset.glass = look.blur;
    else delete r.dataset.glass;
    if (look.bg === 'theme') delete r.dataset.bg;
    else r.dataset.bg = look.bg;
    r.style.setProperty('--own-bg-dim', `${(BG_DIMS[look.bgDim] || BG_DIMS['40'])[1]}%`);
    r.style.setProperty('--own-bg-blur', `${(BG_BLURS[look.bgBlur] || BG_BLURS['6'])[1]}px`);
    applyFx();
    if (look.glow === false) r.dataset.glow = 'off'; else delete r.dataset.glow;
    // Прозрачность окна: --win-alpha — доля прозрачности 0..0.6 (0 — как сейчас, фон непрозрачный).
    // Радиус окна: --win-radius в пикселях, 0 — прямые углы. Читает presence.css; текст не трогается.
    const winPercent = (WIN_ALPHAS[look.winAlpha] || WIN_ALPHAS['0'])[1];
    const winRadius = (WIN_RADII[look.winRadius] || WIN_RADII['0'])[1];
    r.style.setProperty('--win-alpha', String(winPercent / 100));
    r.style.setProperty('--win-radius', `${winRadius}px`);
    // Флаг для CSS: при прозрачности подложкой становится фон окна, а не сплошной body.
    if (winPercent > 0) r.dataset.winAlpha = 'on'; else delete r.dataset.winAlpha;
    // Радиус без прозрачности тоже требует прозрачной подложки: иначе углы закрасит body.
    if (winRadius > 0) r.dataset.winRadius = 'on'; else delete r.dataset.winRadius;
  }
  // Эффект темы слушается выбора фона (сплошной и своя картинка его убирают);
  // явно выбранный эффект виден на любой теме и любом фоне.
  function applyFx() {
    const r = document.documentElement;
    const fx = look.fx === 'theme' ? (look.bg === 'theme' ? THEME_FX[r.dataset.theme] : null) : (look.fx === 'off' ? null : look.fx);
    if (fx) r.dataset.fx = fx; else delete r.dataset.fx;
  }
  function setLook(patch) {
    look = sanitizeLook({ ...look, ...(patch && typeof patch === 'object' ? patch : {}) });
    try { localStorage.setItem('jarvis.look', JSON.stringify(look)); } catch { /* нет хранилища */ }
    applyLook();
    document.dispatchEvent(new Event('jarvis:look'));
  }
  function resetLook() {
    look = { ...LOOK_DEFAULT };
    try { localStorage.removeItem('jarvis.look'); } catch { /* нет хранилища */ }
    applyLook();
    document.dispatchEvent(new Event('jarvis:look'));
  }
  // «Сбросить к теме»: ручки и свой акцент очищаются, тема остаётся как есть.
  function resetToTheme() {
    resetLook();
    setAccent('theme');
  }
  try { look = sanitizeLook(JSON.parse(localStorage.getItem('jarvis.look'))); } catch { look = { ...LOOK_DEFAULT }; }
  applyLook();

  let saved = 'dark';
  try { saved = JSON.parse(localStorage.getItem('jarvis.theme')) || 'dark'; } catch { /* нет хранилища или мусор */ }
  try { accent = normAccent(JSON.parse(localStorage.getItem('jarvis.accent'))); } catch { /* нет хранилища или мусор */ }
  apply(saved);
  // Мини-окно и главное окно живут в одном хранилище: смена в Настройках доходит и сюда.
  window.addEventListener('storage', (e) => {
    if (e.key === 'jarvis.accent') {
      try { accent = normAccent(JSON.parse(e.newValue)); } catch { accent = 'theme'; }
      applyAccent();
      document.dispatchEvent(new Event('jarvis:accent'));
      return;
    }
    if (e.key !== 'jarvis.theme') return;
    try { apply(JSON.parse(e.newValue)); } catch { apply('dark'); }
  });

  window.JarvisTheme = {
    IDS, resolve, apply, ACCENTS, setAccent, getAccent: () => accent, getAccentInfo: () => ({ ...accentInfo }), normHex, MIN_CONTRAST,
    FONTS, SIZES, ROUNDS, PANELS, ORBS, BLURS, BGS, BG_DIMS, BG_BLURS, FXS, THEME_FX, WIN_ALPHAS, WIN_RADII, LOOK_DEFAULT, sanitizeLook,
    contrast, readable, getLook: () => ({ ...look }), setLook, resetLook, resetToTheme,
  };
})();
