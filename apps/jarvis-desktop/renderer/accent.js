/* Настройки → Вид: строка «Цвет акцента». Кнопки-кружки меняют --hue поверх темы через theme-boot.js.
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
  text.append(name, hint);

  const group = document.createElement('div');
  group.className = 'accent-pick';
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

  function mark() {
    const cur = T.getAccent();
    for (const b of buttons) {
      const on = b.dataset.accentOpt === cur;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
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

  row.append(text, group);
  themeRow.after(row);
  mark();
  // Цвет могли сменить не кружком: сброс вида, другое окно (storage), сам theme-boot.js.
  document.addEventListener('jarvis:accent', mark);
})();
