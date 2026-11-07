/* Настройки → Вид: строка «Цвет акцента». Кружки палитры и поле HEX меняют --hue поверх темы через theme-boot.js.
 * Перед применением theme-boot.js проверяет контраст (от 4,5:1); если цвет сдвинут, строка под названием говорит, на какой.
 * Ничего не отправляет в ядро: выбор живёт в localStorage этого окна. */
(() => {
  'use strict';
  const T = window.JarvisTheme;
  const look = document.getElementById('setLookTitle');
  if (!T || !T.ACCENTS || !look) return;
  const section = look.closest('.set-section');
  const themeRow = section && section.querySelector('.orb-pick-row');
  if (!themeRow) return;

  const row = document.createElement('div');
  row.className = 'set-row accent-row';
  const text = document.createElement('span');
  text.className = 'set-text';
  const name = document.createElement('span');
  name.className = 'set-name';
  name.id = 'accentLabel';
  name.textContent = 'Цвет акцента';
  const hint = document.createElement('span');
  hint.className = 'set-hint';
  hint.textContent = 'Только на этом компьютере. Меняет кнопки, подсветку и шар';
  const note = document.createElement('span');
  note.className = 'set-hint accent-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  text.append(name, hint, note);

  const pick = document.createElement('div');
  pick.className = 'accent-pick';
  const group = document.createElement('div');
  group.className = 'accent-swatches';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', 'accentLabel');

  const buttons = T.ACCENTS.map((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'accent-opt';
    b.setAttribute('role', 'radio');
    b.dataset.accentOpt = a.id;
    b.title = a.name;
    b.setAttribute('aria-label', a.name);
    if (a.dark) b.style.setProperty('--swatch', a.dark);
    b.addEventListener('click', () => { T.setAccent(a.id); mark(); });
    group.append(b);
    return b;
  });

  // Свой цвет: '#RRGGBB' или '#RGB', применяется по Enter или при уходе из поля.
  const hex = document.createElement('input');
  hex.type = 'text';
  hex.className = 'input input-sm accent-hex';
  hex.maxLength = 7;
  hex.placeholder = '#RRGGBB';
  hex.spellcheck = false;
  hex.autocomplete = 'off';
  hex.setAttribute('aria-label', 'Свой цвет акцента, код вида #3A7BD5');
  function applyHex() {
    const raw = hex.value.trim();
    if (!raw) return;
    const v = T.normHex(raw);
    if (!v) {
      hex.setAttribute('aria-invalid', 'true');
      note.textContent = 'Нужен код цвета вида #3A7BD5';
      return;
    }
    hex.removeAttribute('aria-invalid');
    T.setAccent(v);
    mark();
  }
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyHex(); } });
  hex.addEventListener('change', applyHex);

  function explain() {
    const info = T.getAccentInfo();
    if (!info.applied) { note.textContent = ''; return; }
    if (info.adjusted) {
      const how = info.direction === 'lighter' ? 'светлее' : 'темнее';
      note.textContent = `${info.requested} на этой теме читался бы плохо, поэтому взят ${info.applied} — ${how}, текст на нём читается`;
    } else if (T.normHex(T.getAccent())) {
      note.textContent = `Свой цвет ${info.applied}: текст читается`;
    } else note.textContent = '';
  }

  function mark() {
    const cur = T.getAccent();
    const custom = T.normHex(cur);
    // Кружок показывает тот оттенок, который встанет на этой теме: на светлых — тёмный вариант.
    let light = false;
    try { light = getComputedStyle(document.documentElement).colorScheme === 'light'; } catch { /* нет стилей */ }
    for (const b of buttons) {
      const a = T.ACCENTS.find((x) => x.id === b.dataset.accentOpt);
      if (a && a.dark) b.style.setProperty('--swatch', light ? a.light : a.dark);
      const on = b.dataset.accentOpt === cur;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    // Свой цвет не совпадает ни с одним кружком: в группу всё равно можно попасть Tab.
    if (custom && buttons[0]) buttons[0].tabIndex = 0;
    if (document.activeElement !== hex) { hex.value = custom || ''; hex.removeAttribute('aria-invalid'); }
    explain();
  }
  group.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = buttons.length - 1;
    if (j < 0) return;
    e.preventDefault();
    buttons[j].focus();
    T.setAccent(buttons[j].dataset.accentOpt);
    mark();
  });

  pick.append(group, hex);
  row.append(text, pick);
  themeRow.after(row);
  mark();
  // Цвет могли сменить не кружком: сброс вида, другое окно (storage), сам theme-boot.js.
  document.addEventListener('jarvis:accent', mark);
  // Смена темы меняет фон, а значит и нужный сдвиг цвета: пояснение пересчитывается.
  new MutationObserver(mark).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
