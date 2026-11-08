/* Раздел «Подключения»: внешние сервисы MCP.
 * Показываем имя сервиса, адрес/команду без секретов, состояние, причину ошибки и доступные действия.
 * Мост окна даёт mcpState/mcpAdd/mcpToggle/mcpRemove; новый main сразу подключает сервис и отдаёт
 * capabilities/tools/status, поэтому экран обновляется без перезапуска. Пока новая сборка не собрана,
 * старый ответ (connected/disabled) тоже поддерживается: список не пустеет. */
(() => {
  'use strict';
  const list = document.getElementById('mcpList');
  const empty = document.getElementById('mcpEmpty');
  const form = document.getElementById('mcpForm');
  if (!list || !form) return;
  const note = document.getElementById('mcpFormNote');
  const view = document.querySelector('[data-view="mcp"]');
  const POLL_MS = 3000;

  // ── начало списка популярных
  // Короткая безопасная часть каталога src/mcp/catalog.js. Окно не имеет доступа к ядру
  // (nodeIntegration выключен), поэтому данные записаны здесь; тест mcp-catalog сверяет id,
  // команду и аргументы с каталогом. Все записи без ключей: секреты в окно не подставляются.
  const POPULAR = [
    { id: 'filesystem', title: 'Файлы', hint: 'Чтение и запись файлов в разрешённой папке', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-filesystem .' },
    { id: 'memory', title: 'Память', hint: 'Долгая память в виде графа знаний', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-memory' },
    { id: 'sequential-thinking', title: 'Рассуждения', hint: 'Пошаговые рассуждения со структурой мыслей', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-sequential-thinking' },
    { id: 'playwright', title: 'Браузер Playwright', hint: 'Управление настоящим браузером и снимки экрана', target: 'npx.cmd', args: '-y @playwright/mcp@latest' },
    { id: 'chrome-devtools', title: 'Chrome DevTools', hint: 'Сеть, консоль и отладка сайта в Chrome', target: 'npx.cmd', args: '-y chrome-devtools-mcp@latest' },
    { id: 'context7', title: 'Context7', hint: 'Свежая документация библиотек для модели', target: 'npx.cmd', args: '-y @upstash/context7-mcp' },
    { id: 'desktop-commander', title: 'Командная строка', hint: 'Терминал и файлы на компьютере', target: 'npx.cmd', args: '-y @wonderwhy-er/desktop-commander@latest' },
  ];
  // ── конец списка популярных


  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'checked') node.checked = v;
      else if (k === 'hidden') node.hidden = v;
      else node.setAttribute(k, v);
    }
    node.append(...kids.filter(Boolean));
    return node;
  };
  const toast = (text, kind) => document.dispatchEvent(new CustomEvent('jarvis:toast', { detail: { text, kind } }));
  const bridge = () => (window.jarvis && window.jarvis.mcpState ? window.jarvis : null);

  // Статус сервиса: новые поля status/error, старые connected/disabled — тот же смысл.
  function statusOf(server) {
    if (server && server.status) return server.status;
    if (server && server.disabled) return 'disabled';
    if (server && server.connected) return 'connected';
    return 'legacy';
  }

  const STATUS = {
    connected: ['подключён', 'ok'],
    connecting: ['подключается', 'busy'],
    disabled: ['выключен', 'idle'],
    idle: ['не подключён', 'idle'],
    error: ['ошибка', 'err'],
    legacy: ['подключится при запуске', 'idle'],
  };

  // Что сервис умеет: имена действий (не внутренние имена модели) или объявленные возможности.
  function capabilitiesText(server) {
    if (!server || statusOf(server) === 'error') return null;
    const tools = Array.isArray(server.tools) ? server.tools : [];
    if (tools.length) {
      const titles = tools.slice(0, 4).map((tool) => String((tool && (tool.title || tool.name)) || '').trim()).filter(Boolean);
      const tail = tools.length > titles.length ? ` и ещё ${tools.length - titles.length}` : '';
      return `Действия (${tools.length}): ${titles.join(', ')}${tail}`;
    }
    const caps = server.capabilities && typeof server.capabilities === 'object' ? server.capabilities : null;
    if (caps) {
      const words = [caps.tools && 'инструменты', caps.resources && 'ресурсы', caps.prompts && 'подсказки', caps.logging && 'журнал'].filter(Boolean);
      return words.length ? `Возможности: ${words.join(', ')}` : 'Возможности не объявлены';
    }
    if (statusOf(server) === 'connected') return 'Инструментов нет';
    return null;
  }

  // Служебная подпись для наведения: протокол и имя сервера. Пользователю это не мешает, но помогает при сбое.
  function detailsTitle(server) {
    const parts = [];
    if (server.protocolVersion) parts.push(`Протокол MCP ${server.protocolVersion}`);
    const info = server.serverInfo && typeof server.serverInfo === 'object' ? server.serverInfo : null;
    if (info && info.name) parts.push(`Сервер: ${info.name}${info.version ? ` ${info.version}` : ''}`);
    return parts.join(' · ');
  }

  function paint(servers) {
    const items = Array.isArray(servers) ? servers : [];
    empty.hidden = items.length > 0;
    list.replaceChildren(...items.map((s) => {
      const api = bridge();
      const status = statusOf(s);
      const [word, tone] = STATUS[status] || STATUS.idle;
      const name = el('span', { class: 'set-name', text: String(s.name || '') });
      const transport = s.transport === 'http' ? 'адрес' : 'команда';
      const text = el('span', { class: 'set-text' }, name);
      const title = detailsTitle(s);
      if (title) name.setAttribute('title', title);
      const hint = el('span', { class: 'set-hint mono', text: `${transport}: ${String(s.target || '').slice(0, 200)}` });
      text.append(hint);
      const capabilities = capabilitiesText(s);
      if (capabilities) text.append(el('span', { class: 'mcp-tools', text: capabilities }));
      if (status === 'error' && s.error) text.append(el('span', { class: 'mcp-tools mcp-error', role: 'status', text: String(s.error).slice(0, 400) }));
      const state = el('span', { class: 'mcp-state', 'data-tone': tone, text: word });
      const actions = el('span', { class: 'mcp-actions' });
      // Ошибку можно повторить, не удаляя сервис: включение заново переподключает его.
      if (status === 'error' && api) {
        actions.append(el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          text: 'Повторить',
          onclick: async () => {
            const r = await api.mcpToggle(s.name, false);
            if (r && r.servers) paint(r.servers);
            if (!r || !r.ok) toast((r && r.error) || 'Не получилось переподключить', 'error');
            else if (r.error) toast(`Не подключилось: ${r.error}`, 'error');
          },
        }));
      }
      const sw = el('input', { type: 'checkbox', role: 'switch', class: 'switch', 'aria-label': `Включить ${s.name}`, checked: !s.disabled });
      sw.addEventListener('change', async () => {
        const r = await api.mcpToggle(s.name, !sw.checked);
        if (r && r.servers) paint(r.servers);
        if (!r || !r.ok) { toast((r && r.error) || 'Не получилось', 'error'); return; }
        if (r.error) toast(`${r.error}`, 'error');
      });
      const del = el('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        text: 'Удалить',
        onclick: async () => {
          const r = await api.mcpRemove(s.name);
          if (r && r.servers) paint(r.servers);
          if (!r || !r.ok) toast((r && r.error) || 'Не получилось удалить', 'error');
          else toast('Сервис удалён, его действия больше не доступны', 'ok');
        },
      });
      actions.append(sw, del);
      return el('li', { class: 'set-row mcp-row' }, text, state, actions);
    }));
  }

  // Раздел «Популярные»: запись каталога добавляется тем же mcp:add, что и форма.
  // Если нужной разметки нет (проверка без index.html), раздел просто не строится.
  let popularMounted = false;
  function mountPopular() {
    if (popularMounted) return;
    const page = document.getElementById('mcpPage');
    if (!page || typeof page.append !== 'function') return;
    popularMounted = true;
    const section = el('section', { class: 'set-section', 'aria-labelledby': 'mcpPopularTitle' });
    const title = el('h2', { class: 'set-title', id: 'mcpPopularTitle', text: 'Популярные' });
    const lead = el('p', { class: 'set-hint', text: 'Готовые внешние сервисы: нажмите «Добавить», сервис сразу подключится. Ключи доступа сюда не подставляются, поэтому здесь только сервисы без ключей; остальные добавляются вручную ниже.' });
    const grid = el('ul', { class: 'mcp-popular' });
    grid.append(...POPULAR.map((item) => {
      const text = el('span', { class: 'set-text' },
        el('span', { class: 'set-name', text: item.title }),
        el('span', { class: 'set-hint', text: item.hint }));
      const add = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Добавить' });
      add.title = `Добавить сервис «${item.title}»`;
      add.addEventListener('click', async () => {
        const api = bridge();
        if (!api || !api.mcpAdd) return;
        add.disabled = true;
        try {
          const r = await api.mcpAdd(item.id, item.target, item.args);
          if (!r || !r.ok) { toast((r && r.error) || 'Не получилось добавить', 'error'); return; }
          if (r.servers) paint(r.servers);
          if (r.error) toast(`Сервис сохранён, но не подключился: ${r.error}`, 'error');
          else toast(`Сервис «${item.title}» подключён. Его действия спрашиваются, пока вы не разрешите их в настройках`, 'ok');
        } finally {
          add.disabled = false;
        }
      });
      return el('li', { class: 'set-row mcp-popular-row' }, text, add);
    }));
    section.append(title, lead, grid);
    // Ставим перед формой ручного добавления; если разметка другая — в конец страницы.
    const formSection = typeof form.closest === 'function' ? form.closest('.set-section') : null;
    if (formSection && formSection.parentNode && typeof formSection.parentNode.insertBefore === 'function') {
      formSection.parentNode.insertBefore(section, formSection);
    } else {
      page.append(section);
    }
  }

  async function load() {
    const api = bridge();
    if (!api) return;
    try {
      const state = await api.mcpState();
      paint((state && state.servers) || []);
    } catch {
      paint([]);
    }
  }

  // Непрерывная проверка состояния: сервер мог упасть или подключиться сам. Окно остаётся отзывчивым:
  // опрос идёт только когда раздел «Подключения» виден на экране.
  let timer = null;
  function polling(on) {
    if (on && !timer) timer = setInterval(() => { if (view && !view.hidden) load(); }, POLL_MS);
    if (!on && timer) { clearInterval(timer); timer = null; }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const api = bridge();
    if (!api) return;
    const d = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      const r = await api.mcpAdd(d.get('name'), d.get('target'), d.get('args'));
      if (!r || !r.ok) { toast((r && r.error) || 'Не получилось добавить', 'error'); return; }
      if (r.servers) paint(r.servers);
      form.reset();
      if (r.error) toast(`Сервис сохранён, но не подключился: ${r.error}`, 'error');
      else toast('Сервис подключён. Его действия спрашиваются, пока вы не разрешите их в настройках', 'ok');
    } finally {
      if (button) button.disabled = false;
    }
  });

  // На новой сборке подсказка «после перезапуска» больше не верна; текст ставим здесь,
  // чтобы старая разметка index.html не обещала лишнего.
  if (note) note.textContent = 'Сервис подключается сразу, перезапуск не нужен. Действия сервиса всегда спрашиваются, пока вы не разрешите их в настройках.';

  // Мост окна может появиться позже страницы (в браузерной проверке его ставит dev-stub): читаем при входе в раздел.
  document.addEventListener('jarvis:view', (e) => {
    const active = e.detail === 'mcp';
    polling(active);
    if (active) load();
  });
  mountPopular();
  load();
})();
