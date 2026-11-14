/* Источники одного ответа. Нативный popover остаётся поверх прокручиваемой ленты. */
(() => {
  'use strict';

  const { icon } = window.NoxAetherIcons;
  const { scrub } = window.JarvisUI;
  let nextId = 0;
  const panelLimit = 272;
  const panelGap = 5;

  function fitPopover(panel, trigger, feed) {
    const anchor = trigger.getBoundingClientRect();
    const bounds = feed.getBoundingClientRect();
    const top = Math.max(0, bounds.top);
    const bottom = Math.min(window.innerHeight, bounds.bottom);
    const above = Math.max(0, Math.floor(anchor.top - top - panelGap));
    const below = Math.max(0, Math.floor(bottom - anchor.bottom - panelGap));
    const opensBelow = above < panelLimit && below > above;
    panel.dataset.side = opensBelow ? 'below' : 'above';
    panel.style.setProperty('--source-panel-room', `${opensBelow ? below : above}px`);
    if (anchor.bottom <= top || anchor.top >= bottom) panel.hidePopover();
  }

  const placements = new WeakMap();
  const feedResize = new ResizeObserver(() => updatePlacement());
  function updatePlacement() {
    const panel = document.querySelector('.ae-sources-popover:popover-open');
    const placement = placements.get(panel);
    if (placement) fitPopover(panel, ...placement);
  }
  window.addEventListener('resize', updatePlacement);
  document.addEventListener('scroll', (event) => {
    if (event.target.id === 'feed') updatePlacement();
  }, { capture: true, passive: true });

  function favicon(host, loadIcon) {
    const wrap = document.createElement('span');
    wrap.className = 'ae-source-favicon';
    wrap.setAttribute('aria-hidden', 'true');
    const fallback = icon('globe');
    const image = document.createElement('img');
    image.alt = '';
    image.className = 'ae-source-favicon-image';
    image.addEventListener('load', () => {
      fallback.setAttribute('hidden', '');
      image.classList.add('is-loaded');
    }, { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    wrap.append(fallback, image);
    if (loadIcon) loadIcon(host).then((url) => {
      if (url) image.src = url;
      else image.remove();
    }).catch(() => image.remove());
    else image.remove();
    return wrap;
  }

  function createSourcesPopover(sources, openSource, loadIcon) {
    const wrap = document.createElement('div');
    wrap.className = 'ae-sources';

    const panel = document.createElement('div');
    panel.id = `aeSources${++nextId}`;
    panel.className = 'ae-sources-popover';
    panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Источники ответа');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ae-sources-trigger';
    trigger.setAttribute('popovertarget', panel.id);
    const icons = document.createElement('span');
    icons.className = 'ae-sources-favicons';
    for (const host of [...new Set(sources.map((source) => source.host))].slice(0, 3)) icons.append(favicon(host, loadIcon));
    trigger.append(icons, `Источники · ${sources.length}`, icon('chevronDown', 'ae-sources-chevron'));
    panel.addEventListener('beforetoggle', (event) => {
      if (event.newState !== 'open') return;
      const feed = trigger.closest('.ae-feed');
      if (!feed) return;
      placements.set(panel, [trigger, feed]);
      fitPopover(panel, trigger, feed);
    });
    panel.addEventListener('toggle', () => {
      const current = document.querySelector('.ae-sources-popover:popover-open');
      feedResize.disconnect();
      const placement = placements.get(current);
      if (placement) feedResize.observe(placement[1]);
    });

    for (const { url, title, host } of sources) {
      const link = document.createElement('a');
      link.className = 'ae-source-link';
      link.href = url;
      link.title = scrub(title);
      const text = document.createElement('span');
      const label = document.createElement('span');
      label.className = 'ae-source-title';
      label.textContent = link.title;
      const domain = document.createElement('span');
      domain.className = 'ae-source-domain';
      domain.textContent = host;
      text.append(label, domain);
      link.append(favicon(host, loadIcon), text, icon('external', 'ae-source-ext'));
      const open = (event) => {
        event.preventDefault();
        openSource(url);
      };
      link.addEventListener('click', open);
      link.addEventListener('auxclick', (event) => { if (event.button === 1) open(event); });
      panel.append(link);
    }

    wrap.append(trigger, panel);
    return wrap;
  }

  window.NoxAetherSources = { createSourcesPopover };
})();
