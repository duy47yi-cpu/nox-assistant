/* Настройки: список разделов справа. Строится из заголовков карточек, ведёт к нужной по нажатию
 * и подсвечивает ту, что сейчас на экране. Ничего не хранит и не вызывает ядро. */
(() => {
  'use strict';
  const view = document.querySelector('.view-settings');
  const list = document.getElementById('setNavList');
  if (!view || !list) return;

  let items = [];
  function build() {
    const sections = [...view.querySelectorAll('.page.settings > .set-section')].filter((s) => !s.hidden);
    list.replaceChildren();
    items = sections.map((section) => {
      const title = section.querySelector('.set-title');
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-nav-item';
      b.textContent = title ? title.textContent.trim() : '';
      b.addEventListener('click', () => {
        // Прокручивается только область настроек: scrollIntoView сдвинул бы и каркас окна.
        const top = section.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop - 4;
        const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        view.scrollTo({ top, behavior: calm ? 'auto' : 'smooth' });
        if (section.hasAttribute('tabindex')) section.focus({ preventScroll: true });
      });
      li.append(b);
      list.append(li);
      return { section, b };
    }).filter((x) => x.b.textContent);
    mark();
  }

  // Активный раздел — тот, чей верх ближе всего к верху области прокрутки.
  function mark() {
    if (!items.length) return;
    const top = view.getBoundingClientRect().top + 24;
    let best = items[0];
    for (const it of items) if (it.section.getBoundingClientRect().top - top <= 8) best = it;
    for (const it of items) it.b.setAttribute('aria-current', it === best ? 'true' : 'false');
  }

  view.addEventListener('scroll', mark, { passive: true });
  // Разделы появляются и пропадают (почта, провайдеры владельца): перестраиваем при изменении атрибута hidden.
  new MutationObserver(build).observe(view, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  build();
})();
