/* Настройки → Вид: свой вид окна. Шрифты, размер текста, скругление, плотность панелей,
 * размытие стекла, фон, размер шара, свет за окном.
 * Значения хранит theme-boot.js (localStorage jarvis.look); здесь только строки настроек. Ядро не трогается. */
(() => {
  'use strict';
  const T = window.JarvisTheme;
  const look = document.getElementById('setLookTitle');
  if (!T || !T.FONTS || !look) return;
  const section = look.closest('.set-section');
  const anchor = section && (section.querySelector('.accent-row') || section.querySelector('.orb-pick-row'));
  if (!section || !anchor) return;

  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const rows = [];

  function row(label, hint, control) {
    const r = make('div', 'set-row look-row');
    const t = make('span', 'set-text');
    t.append(make('span', 'set-name', label), make('span', 'set-hint', hint));
    r.append(t, control);
    rows.push(r);
    return r;
  }
  function select(key, map, label) {
    const s = make('select', 'input input-sm look-select');
    s.setAttribute('aria-label', label);
    for (const [id, v] of Object.entries(map)) { const o = make('option', '', v[0]); o.value = id; s.append(o); }
    s.value = T.getLook()[key];
    s.addEventListener('change', () => T.setLook({ [key]: s.value }));
    s.dataset.lookKey = key;
    return s;
  }
  function seg(key, map, label) {
    const g = make('div', 'seg look-seg');
    g.setAttribute('role', 'radiogroup');
    g.setAttribute('aria-label', label);
    for (const [id, v] of Object.entries(map)) {
      const b = make('button', 'seg-btn', v[0]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.id = id;
      b.addEventListener('click', () => T.setLook({ [key]: id }));
      g.append(b);
    }
    // Одна точка табуляции и стрелки, как у остальных радиогрупп окна.
    g.addEventListener('keydown', (e) => {
      const opts = Array.from(g.querySelectorAll('button'));
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
      opts[j].click();
    });
    g.dataset.lookKey = key;
    return g;
  }
  function toggle(key, label) {
    const c = make('input', 'switch');
    c.type = 'checkbox';
    c.setAttribute('role', 'switch');
    c.setAttribute('aria-label', label);
    c.checked = T.getLook()[key] !== false;
    c.addEventListener('change', () => T.setLook({ [key]: c.checked }));
    c.dataset.lookKey = key;
    return c;
  }

  const uiFonts = Object.fromEntries(Object.entries(T.FONTS.ui).map(([k, v]) => [k, v]));
  const replyMap = { head: ['Книжным, как заголовки'], ui: ['Обычным, как интерфейс'] };

  row('Шрифт интерфейса', 'Меню, кнопки и подписи. Показываются установленные в Windows шрифты', select('ui', uiFonts, 'Шрифт интерфейса'));
  row('Шрифт заголовков', 'Названия разделов и слово состояния у шара', select('head', T.FONTS.head, 'Шрифт заголовков'));
  row('Шрифт ответов', 'Как Джарвис пишет ответы в чате', select('reply', replyMap, 'Шрифт ответов'));
  row('Размер текста', 'Меняет весь интерфейс сразу', seg('size', T.SIZES, 'Размер текста'));
  row('Скругление углов', 'Панели, кнопки и поля', seg('round', T.ROUNDS, 'Скругление углов'));
  row('Панели', 'Насколько заметны карточки на фоне. «Как в теме» — как задумано темой', seg('panel', T.PANELS, 'Панели'));
  row('Размытие стекла', '«Как в теме» — как задумано темой. «Стекло» размывает и панели', seg('blur', T.BLURS, 'Размытие стекла'));
  row('Фон окна', 'Как в теме — градиент темы; сплошной — ровный цвет', seg('bg', T.BGS, 'Фон окна'));
  row('Размер шара', 'Только на главной', seg('orb', T.ORBS, 'Размер шара'));
  row('Свет за окном', 'Цветное свечение фона, берёт цвет акцента', toggle('glow', 'Свет за окном'));

  const reset = make('button', 'btn btn-secondary btn-sm', 'Сбросить к теме');
  reset.type = 'button';
  reset.id = 'lookResetTheme';
  reset.addEventListener('click', () => { T.resetToTheme(); paint(); });
  const foot = make('div', 'set-row look-row');
  const ft = make('span', 'set-text');
  ft.append(make('span', 'set-name', 'Сбросить к теме'), make('span', 'set-hint', 'Шрифты, размер текста, скругление, панели, размытие, фон, размер шара и свой цвет акцента вернутся к выбранной теме. Тема и вид шара остаются'));
  foot.append(ft, reset);
  rows.push(foot);

  anchor.after(...rows);

  function paint() {
    const cur = T.getLook();
    for (const s of section.querySelectorAll('select[data-look-key]')) {
      const key = s.dataset.lookKey;
      // Битое сохранённое значение не оставляет пустой список: показываем вариант по умолчанию.
      if (cur[key] !== undefined && Array.from(s.options).some((o) => o.value === cur[key])) s.value = cur[key];
      else s.selectedIndex = 0;
    }
    for (const g of section.querySelectorAll('.look-seg')) {
      const opts = Array.from(g.querySelectorAll('button'));
      let anyOn = false;
      for (const b of opts) {
        const on = b.dataset.id === cur[g.dataset.lookKey];
        if (on) anyOn = true;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      // Если выбранного варианта нет, группа всё равно должна попадать в Tab.
      if (!anyOn && opts[0]) opts[0].tabIndex = 0;
    }
    for (const c of section.querySelectorAll('input[data-look-key]')) c.checked = cur[c.dataset.lookKey] !== false;
  }
  document.addEventListener('jarvis:look', paint);
  paint();
})();
