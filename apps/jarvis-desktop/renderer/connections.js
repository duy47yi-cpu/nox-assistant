/* Раздел «Подключения»: внешние сервисы MCP.
 *
 * Экран в дизайн-системе Nox (Phase 3.2): список подключений с семью состояниями,
 * поиск и фильтры, панель популярных сервисов, диалоги добавления/деталей/удаления/
 * подтверждения изменений/ошибки. Данные и действия — только через существующий мост:
 * mcpState / mcpAdd / mcpToggle / mcpRemove / mcpApprove; новых каналов нет.
 *
 * Честность важнее вида: «Подключён» показывается только при реально установленном
 * соединении; сохранённый, но не подключившийся сервис — «Ошибка» с причиной; сервис
 * без подключения — «Не подключён»; изменившийся набор действий — «Изменения инструментов»
 * и блокировка действий до mcpApprove. Подтверждение набора действий сервиса (mcpApprove)
 * не смешивается с разрешением агенту выполнять системные действия (approval:respond). */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const list = document.getElementById('mcpList');
  const empty = document.getElementById('mcpEmpty');
  const form = document.getElementById('mcpForm');
  if (!list || !empty || !form) return;
  const note = document.getElementById('mcpFormNote');
  const view = document.querySelector('[data-view="mcp"]');
  const POLL_MS = 3000;

  // ── начало списка популярных
  // Заголовок панели в интерфейсе — «Популярные». Короткая безопасная часть каталога
  // src/mcp/catalog.js: окно не имеет доступа к ядру (nodeIntegration выключен), поэтому
  // данные записаны здесь; тест mcp-catalog сверяет id, команду и аргументы с каталогом.
  // Только записи без ключей и проверенные (verified: true): «Добавить» ставит сервис сразу,
  // секреты сюда не подставляются.
  const POPULAR = [
    { id: 'filesystem', title: 'Файлы', hint: 'Чтение и запись файлов в разрешённой папке', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-filesystem .' },
    { id: 'puppeteer', title: 'Браузер Puppeteer', hint: 'Страницы и снимки в настоящем браузере', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-puppeteer' },
    { id: 'memory', title: 'Память', hint: 'Долгая память в виде графа знаний', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-memory' },
    { id: 'postgres', title: 'PostgreSQL', hint: 'Запросы только на чтение к базе PostgreSQL', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-postgres postgresql://localhost/postgres' },
    { id: 'playwright', title: 'Браузер Playwright', hint: 'Управление настоящим браузером и снимки экрана', target: 'npx.cmd', args: '-y @playwright/mcp@latest' },
    { id: 'context7', title: 'Context7', hint: 'Свежая документация библиотек для модели', target: 'npx.cmd', args: '-y @upstash/context7-mcp' },
    { id: 'sequential-thinking', title: 'Рассуждения', hint: 'Пошаговые рассуждения со структурой мыслей', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-sequential-thinking' },
  ];
  // ── конец списка популярных

  // Сервисы из каталога, которым нужен ключ, вход или которые не проверены в работе.
  // Честное состояние: «Добавить» недоступно, в строке написано, чего не хватает.
  const POPULAR_UNAVAILABLE = [
    { id: 'slack', title: 'Slack', hint: 'Сообщения и каналы Slack', reason: 'Нужен ключ SLACK_BOT_TOKEN: добавьте вручную' },
    { id: 'github', title: 'GitHub', hint: 'Задачи и пул-реквесты GitHub', reason: 'Нужен вход GitHub, сервер не проверен' },
    { id: 'gdrive', title: 'Google Диск', hint: 'Файлы Google Диска', reason: 'Нужен вход Google и Python-запуск (uvx), не проверено' },
  ];
  // Порядок как в утверждённом макете: доступные и требующие настройки вперемешку.
  const POPULAR_ORDER = ['filesystem', 'puppeteer', 'memory', 'postgres', 'slack', 'github', 'gdrive', 'playwright', 'context7', 'sequential-thinking'];
  const POPULAR_GROUPS = {
    filesystem: 'files',
    memory: 'files',
    puppeteer: 'dev',
    playwright: 'dev',
    context7: 'dev',
    'sequential-thinking': 'dev',
    postgres: 'other',
    slack: 'other',
    github: 'other',
    gdrive: 'other',
  };
  const POPULAR_CATS = [
    { id: 'all', title: 'Все' },
    { id: 'files', title: 'Файлы', full: 'Файлы и память' },
    { id: 'dev', title: 'Разработка', full: 'Разработка и браузер' },
    { id: 'other', title: 'Прочее', full: 'Прочее' },
  ];

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') node.textContent = String(v);
      else if (k === 'class') node.setAttribute('class', String(v));
      else if (k === 'checked') node.checked = v;
      else if (k === 'disabled') node.disabled = v;
      else if (k === 'hidden') node.hidden = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
    node.append(...kids.filter(Boolean));
    return node;
  };
  const icon = (name) => el('span', { class: '', 'data-icon': name, 'aria-hidden': 'true' });
  const fillIcons = (node) => {
    const ui = window.JarvisUI;
    if (ui && typeof ui.fillIcons === 'function') ui.fillIcons(node);
  };
  const toast = (text, kind) => document.dispatchEvent(new CustomEvent('jarvis:toast', { detail: { text, kind } }));
  const bridge = () => (window.jarvis && window.jarvis.mcpState ? window.jarvis : null);
  const plural = (n, forms) => {
    const v = Math.abs(Number(n) || 0) % 100;
    const d = v % 10;
    if (v > 10 && v < 20) return forms[2];
    if (d === 1) return forms[0];
    if (d >= 2 && d <= 4) return forms[1];
    return forms[2];
  };

  // ── Состояние экрана ──────────────────────────────────────────
  const STATE = { q: '', filter: 'all', popularCat: 'all' };
  let SERVERS = [];
  let LOAD_ERROR = '';
  let listKey = '';
  let popularKey = '';
  let lastTrigger = null;

  // Статус сервиса: новые поля status/error, старые connected/disabled — тот же смысл.
  function statusOf(server) {
    if (server && server.status) return server.status;
    if (server && server.disabled) return 'disabled';
    if (server && server.connected) return 'connected';
    return 'legacy';
  }

  // Тексты и цвета семи состояний. Слова различимы без цвета (важно для a11y).
  const STATUS = {
    connected: { word: 'Подключён', tone: 'ok' },
    connecting: { word: 'Подключается', tone: 'accent' },
    disabled: { word: 'Выключен', tone: 'ghost' },
    idle: { word: 'Не подключён', tone: 'muted' },
    legacy: { word: 'Подключится при запуске', tone: 'muted' },
    error: { word: 'Ошибка', tone: 'err' },
    drift: { word: 'Изменения инструментов', tone: 'warn' },
  };

  function statusInfo(server) {
    return STATUS[statusOf(server)] || STATUS.idle;
  }

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

  // Служебная подпись: протокол и имя сервера. В карточке — title, в деталях — строка.
  function detailsTitle(server) {
    if (!server) return '';
    const parts = [];
    if (server.protocolVersion) parts.push(`Протокол MCP ${server.protocolVersion}`);
    const info = server.serverInfo && typeof server.serverInfo === 'object' ? server.serverInfo : null;
    if (info && info.name) parts.push(`Сервер: ${info.name}${info.version ? ` ${info.version}` : ''}`);
    return parts.join(' · ');
  }

  // Строка состояния под адресом: как в макете — «Подключён · 8 действий» и т. п.
  function statusLine(server) {
    const status = statusOf(server);
    if (status === 'connected') {
      const n = Number(server.toolCount) || (Array.isArray(server.tools) ? server.tools.length : 0);
      return `Подключён · ${n} ${plural(n, ['действие', 'действия', 'действий'])}`;
    }
    if (status === 'connecting') return 'Подключается…';
    if (status === 'disabled') return 'Выключен';
    if (status === 'idle') return 'Не подключён';
    if (status === 'legacy') return 'Подключится при запуске';
    if (status === 'error') return `Ошибка: ${String(server.error || 'причина не сообщена')}`;
    if (status === 'drift') return 'Набор действий изменился — нужно ваше подтверждение';
    return '';
  }

  function driftItems(server) {
    const d = server && server.drift && typeof server.drift === 'object' ? server.drift : {};
    const out = [];
    if (Array.isArray(d.added)) for (const name of d.added.slice(0, 4)) out.push({ kind: 'added', text: `+ ${name}` });
    if (Array.isArray(d.removed)) for (const name of d.removed.slice(0, 4)) out.push({ kind: 'removed', text: `− ${name}` });
    if (Array.isArray(d.changed)) {
      for (const item of d.changed.slice(0, 4)) {
        const name = item && typeof item === 'object' ? item.name : item;
        if (name) out.push({ kind: 'changed', text: `~ ${name}` });
      }
    }
    return out;
  }

  // ── Диалоги: открытие/закрытие, возврат фокуса ─────────────────
  const triggers = new Map();

  function openDialog(dialog, trigger) {
    if (!dialog) return false;
    if (trigger) triggers.set(dialog, trigger);
    try {
      if (typeof dialog.showModal === 'function' && dialog.open !== true) dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch {
      dialog.setAttribute('open', '');
    }
    return true;
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    try {
      if (typeof dialog.close === 'function' && dialog.open === true) dialog.close();
      else if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    } catch {
      dialog.removeAttribute('open');
    }
    const back = triggers.get(dialog);
    triggers.delete(dialog);
    let target = back;
    // Карточка могла перерисоваться опросом, пока диалог был открыт: ищем свежую по имени.
    if (target && typeof target.isConnected === 'boolean' && target.isConnected === false) {
      const name = dialog.dataset ? String(dialog.dataset.name || '') : '';
      target = name && typeof document.querySelector === 'function'
        ? document.querySelector(`#mcpList .mcp-card[data-name="${name.replace(/["\\]/g, '')}"]`)
        : null;
    }
    if (target && typeof target.focus === 'function') {
      try { target.focus(); } catch { /* элемент уже не на экране */ }
    }
  }

  function focusFirst(selector) {
    const node = $(selector);
    if (node && typeof node.focus === 'function') node.focus();
  }

  // ── Список подключений ────────────────────────────────────────
  function searchText(server) {
    return [
      server.name,
      server.target,
      statusInfo(server).word,
      capabilitiesText(server) || '',
      detailsTitle(server) || '',
    ].join(' ').toLowerCase();
  }

  function filteredServers() {
    const q = STATE.q.trim().toLowerCase();
    return SERVERS.filter((server) => {
      const status = statusOf(server);
      if (STATE.filter === 'connected' && !['connected', 'connecting', 'drift'].includes(status)) return false;
      if (STATE.filter === 'disabled' && status !== 'disabled') return false;
      if (STATE.filter === 'error' && status !== 'error') return false;
      if (!q) return true;
      return searchText(server).includes(q);
    });
  }

  function cardButton(server, status, api) {
    if (status === 'connected') {
      return el('button', {
        class: 'mcp-card-action', type: 'button', 'data-focus-key': `details:${server.name}`,
        text: 'Детали',
        onclick: (e) => { e.stopPropagation(); openDetails(server, e.currentTarget); },
      });
    }
    if (status === 'connecting') {
      const b = el('button', { class: 'mcp-card-action', type: 'button', disabled: true });
      b.append(el('span', { class: 'mcp-spinner', 'aria-hidden': 'true' }), el('span', { text: 'Подключается' }));
      return b;
    }
    if (status === 'disabled' || status === 'idle') {
      return el('button', {
        class: 'mcp-card-action', type: 'button', 'data-focus-key': `toggle:${server.name}`,
        disabled: !api, text: 'Включить',
        onclick: (e) => { e.stopPropagation(); toggleServer(server, false, e.currentTarget); },
      });
    }
    if (status === 'error') {
      return el('button', {
        class: 'mcp-card-action mcp-card-action-err', type: 'button', 'data-focus-key': `retry:${server.name}`,
        disabled: !api, text: 'Повторить',
        onclick: (e) => { e.stopPropagation(); retryServer(server, e.currentTarget); },
      });
    }
    if (status === 'drift') {
      return el('button', {
        class: 'mcp-card-action mcp-card-action-accent', type: 'button', 'data-focus-key': `approve:${server.name}`,
        disabled: !api, text: 'Подтвердить изменения',
        onclick: (e) => { e.stopPropagation(); openDrift(server, e.currentTarget); },
      });
    }
    return null;
  }

  function card(server) {
    const api = bridge();
    const status = statusOf(server);
    const info = statusInfo(server);
    const title = detailsTitle(server);
    const action = cardButton(server, status, api);

    const top = el('div', { class: 'mcp-card-top' },
      el('span', { class: 'mcp-name', title: title || server.name, text: String(server.name || '') }),
      el('span', { class: 'mcp-pill', 'data-tone': info.tone },
        el('span', { class: 'mcp-pill-dot', 'aria-hidden': 'true' }),
        el('span', { text: info.word })));

    const main = el('div', { class: 'mcp-card-main' }, top);
    const transport = server.transport === 'http' ? 'адрес' : 'команда';
    main.append(el('div', {
      class: 'mcp-target',
      title: `${transport}: ${String(server.target || '')}`,
      text: String(server.target || ''),
    }));

    const line = el('div', {
      class: 'mcp-line'
        + (status === 'error' ? ' mcp-line-error' : '')
        + (status === 'drift' ? ' mcp-line-warn' : ''),
      text: statusLine(server),
    });
    main.append(line);

    const caps = capabilitiesText(server);
    if (caps) main.append(el('div', { class: 'mcp-caps', text: caps }));

    if (status === 'drift') {
      const chips = driftItems(server);
      if (chips.length) {
        main.append(el('div', { class: 'mcp-diff' }, ...chips.map((item) => el('span', {
          class: 'mcp-diff-chip', 'data-kind': item.kind, text: item.text,
        }))));
      }
    }

    const actions = el('div', { class: 'mcp-card-actions' });
    if (action) actions.append(action);

    const node = el('li', {
      class: 'mcp-card', 'data-name': String(server.name || ''), 'data-status': status,
      'data-focus-key': `card:${server.name}`,
      tabindex: '0', role: 'group', 'aria-label': `${server.name}: ${info.word}`,
    }, el('span', { class: 'mcp-icon', 'aria-hidden': 'true' }, icon('plug')), main, actions);

    node.addEventListener('click', (e) => {
      if (e && e.target && typeof e.target.closest === 'function' && e.target.closest('button, input, a, canvas')) return;
      openDetails(server, node);
    });
    node.addEventListener('keydown', (e) => {
      if (!e || (e.key !== 'Enter' && e.key !== ' ')) return;
      if (e.target !== node) return;
      e.preventDefault();
      openDetails(server, node);
    });
    return node;
  }

  function restoreListFocus() {
    const active = document.activeElement;
    if (!active || typeof active.getAttribute !== 'function') return;
    const key = active.getAttribute('data-focus-key');
    if (!key || typeof list.querySelector !== 'function') return;
    let again = null;
    try { again = list.querySelector(`[data-focus-key="${key}"]`); } catch { again = null; }
    if (!again && key.startsWith('card:')) {
      const name = key.slice(5);
      try { again = list.querySelector(`.mcp-card[data-name="${name}"]`); } catch { again = null; }
    }
    if (again && typeof again.focus === 'function') again.focus();
  }

  function renderCounts() {
    const counts = { all: SERVERS.length, connected: 0, disabled: 0, error: 0 };
    for (const server of SERVERS) {
      const status = statusOf(server);
      if (['connected', 'connecting', 'drift'].includes(status)) counts.connected += 1;
      else if (status === 'disabled') counts.disabled += 1;
      else if (status === 'error') counts.error += 1;
    }
    const map = { mcpFilterAllCount: counts.all, mcpFilterConnectedCount: counts.connected, mcpFilterDisabledCount: counts.disabled, mcpFilterErrorCount: counts.error };
    for (const [id, value] of Object.entries(map)) {
      const node = $(id);
      if (node) node.textContent = String(value);
    }
    for (const chip of document.querySelectorAll ? document.querySelectorAll('#mcpFilters .nox-chip-filter') : []) {
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-filter') === STATE.filter));
    }
  }

  function renderList() {
    const filtered = filteredServers();
    const key = JSON.stringify(filtered) + '|' + STATE.q + '|' + STATE.filter + '|' + LOAD_ERROR;
    if (key === listKey) return;
    listKey = key;
    restoreListFocus();
    list.replaceChildren(...filtered.map(card));
    fillIcons(list);

    const noResults = $('mcpNoResults');
    const isEmpty = SERVERS.length === 0;
    const hasFilter = Boolean(STATE.q.trim()) || STATE.filter !== 'all';
    empty.hidden = !(isEmpty && !LOAD_ERROR);
    if (noResults) noResults.hidden = !(filtered.length === 0 && !isEmpty && hasFilter && !LOAD_ERROR);
    const loading = $('mcpLoading');
    if (loading) loading.hidden = true;
    const errNote = $('mcpErrorNote');
    if (errNote) errNote.hidden = !LOAD_ERROR;
    const errText = $('mcpErrorText');
    if (errText) errText.textContent = LOAD_ERROR;
  }

  function renderLoadError() {
    listKey = '';
    renderList();
  }

  // ── Действия с сервисом ───────────────────────────────────────
  async function toggleServer(server, disabled, button) {
    const api = bridge();
    if (!api) return;
    if (button) button.disabled = true;
    let r;
    try {
      r = await api.mcpToggle(server.name, disabled === true);
    } catch (err) {
      if (button) button.disabled = false;
      toast('Не получилось: ' + String((err && err.message) || err), 'error');
      return;
    }
    if (button) button.disabled = false;
    if (r && r.servers) paint(r.servers);
    if (!r || !r.ok) { toast((r && r.error) || 'Не получилось', 'error'); return; }
    if (r.error) { toast(String(r.error), 'error'); return; }
    toast(disabled ? `Сервис «${server.name}» выключен, его действия больше не доступны` : `Сервис «${server.name}» включён`, 'ok');
  }

  async function retryServer(server, button) {
    const api = bridge();
    if (!api) return;
    lastTrigger = button || lastTrigger;
    if (button) button.disabled = true;
    let r;
    try {
      r = await api.mcpToggle(server.name, false);
    } catch (err) {
      if (button) button.disabled = false;
      openConnectError(server.name, String((err && err.message) || err), button);
      return;
    }
    if (button) button.disabled = false;
    if (r && r.servers) paint(r.servers);
    if (!r || !r.ok) { openConnectError(server.name, (r && r.error) || 'не получилось переподключить', button); return; }
    if (r.error) { openConnectError(server.name, String(r.error), button); return; }
    toast(`Сервис «${server.name}» подключён`, 'ok');
  }

  function openConnectError(name, reason, trigger) {
    const dialog = $('mcpErrorDialog');
    if (!dialog) return;
    lastTrigger = trigger || lastTrigger;
    const nameNode = $('mcpConnErrName');
    if (nameNode) nameNode.textContent = `Сервис «${name}» сохранён, но не подключился.`;
    const reasonNode = $('mcpConnErrReason');
    if (reasonNode) reasonNode.textContent = String(reason || 'причина не сообщена');
    dialog.dataset.name = name;
    openDialog(dialog, trigger);
    focusFirst('mcpConnErrRetry');
  }

  // ── Детали сервиса ────────────────────────────────────────────
  let detailName = '';

  function detailPill(server) {
    const info = statusInfo(server);
    return el('span', { class: 'mcp-pill', 'data-tone': info.tone },
      el('span', { class: 'mcp-pill-dot', 'aria-hidden': 'true' }),
      el('span', { text: info.word }));
  }

  function renderDetails(server) {
    const body = $('mcpDetailsBody');
    if (!body || !server) return;
    detailName = server.name;
    const title = $('mcpDetailsTitle');
    if (title) title.textContent = server.name;
    const status = statusOf(server);
    const info = statusInfo(server);
    const meta = detailsTitle(server);
    const parts = [];

    parts.push(el('div', { class: 'mcp-detail-head' },
      el('span', { class: 'mcp-detail-name', text: String(server.name || '') }),
      detailPill(server)));
    if (meta) parts.push(el('div', { class: 'mcp-detail-meta', text: meta }));

    const transport = server.transport === 'http' ? 'Адрес' : 'Команда';
    const targetBox = el('div', { class: 'mcp-target-box' },
      el('code', { title: String(server.target || ''), text: String(server.target || '') }));
    targetBox.append(el('button', {
      class: 'nox-icon-btn', type: 'button', title: `${transport} — скопировать`, 'aria-label': `${transport} — скопировать`,
      onclick: async () => {
        const ok = await copyText(String(server.target || ''));
        toast(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'ok' : 'error');
      },
    }, icon('clip')));
    parts.push(el('div', { class: 'mcp-detail-section' },
      el('div', { class: 'mcp-detail-section-title', text: transport === 'Адрес' ? 'Адрес сервиса' : 'Команда запуска' }),
      targetBox));

    const tools = Array.isArray(server.tools) ? server.tools : [];
    const capsChips = tools.slice(0, 12).map((tool) => String((tool && (tool.title || tool.name)) || '').trim()).filter(Boolean);
    if (capsChips.length) {
      const cats = el('div', { class: 'mcp-detail-cats' }, ...capsChips.map((text) => el('span', { class: 'mcp-cap-chip', title: text, text })));
      if (tools.length > capsChips.length) cats.append(el('span', { class: 'mcp-cap-chip', text: `и ещё ${tools.length - capsChips.length}` }));
      parts.push(el('div', { class: 'mcp-detail-section' },
        el('div', { class: 'mcp-detail-section-title', text: `Действия сервиса (${tools.length})` }), cats));
    } else if (status === 'connected') {
      parts.push(el('div', { class: 'mcp-detail-section' },
        el('div', { class: 'mcp-detail-section-title', text: 'Действия сервиса' }),
        el('p', { class: 'mcp-detail-text', text: 'Сервис не сообщил список действий.' })));
    }

    if (status === 'error' && server.error) {
      parts.push(el('p', { class: 'mcp-dialog-error', 'data-server-error': 'true' },
        icon('alert'), el('span', { text: String(server.error) })));
    }
    if (status === 'drift') {
      const chips = driftItems(server);
      parts.push(el('div', { class: 'mcp-detail-section' },
        el('div', { class: 'mcp-detail-section-title', text: 'Набор действий изменился' }),
        el('p', { class: 'mcp-detail-text', text: 'Пока изменения не подтверждены, действия сервиса недоступны. Подтверждение — в карточке сервиса.' }),
        chips.length ? el('div', { class: 'mcp-diff' }, ...chips.map((item) => el('span', { class: 'mcp-diff-chip', 'data-kind': item.kind, text: item.text }))) : null));
    }

    parts.push(el('div', { class: 'mcp-detail-section' },
      el('div', { class: 'mcp-detail-section-title', text: 'Разрешения' }),
      el('p', { class: 'mcp-detail-text' },
        el('b', { text: 'Подключение не расширяет права приложения. ' }),
        'Действия сервиса проходят общую политику Nox: перед изменяющими системными действиями Джарвис спросит вас. Подтверждение набора действий сервиса — отдельное решение и не разрешает агенту системные действия.')));

    const sw = el('input', {
      type: 'checkbox', role: 'switch', class: 'switch', id: 'mcpDetailsToggle',
      'aria-label': `Сервис «${server.name}» включён`,
    });
    sw.checked = server.disabled !== true;
    sw.disabled = !bridge();
    sw.addEventListener('change', async () => {
      const api = bridge();
      if (!api) { sw.checked = !sw.checked; return; }
      sw.disabled = true;
      let r;
      try {
        r = await api.mcpToggle(server.name, !sw.checked);
      } catch (err) {
        sw.checked = !sw.checked;
        sw.disabled = false;
        toast('Не получилось: ' + String((err && err.message) || err), 'error');
        return;
      }
      sw.disabled = false;
      if (!r || !r.ok) { sw.checked = !sw.checked; toast((r && r.error) || 'Не получилось', 'error'); return; }
      if (r.error) toast(String(r.error), 'error');
      if (r.servers) {
        paint(r.servers, { force: true });
        const fresh = (Array.isArray(r.servers) ? r.servers : []).find((x) => x.name === server.name);
        if (fresh) renderDetails(fresh);
      }
    });
    parts.push(el('div', { class: 'mcp-toggle-row' },
      el('span', { class: 'mcp-toggle-text' },
        el('span', { class: 'mcp-toggle-name', text: server.disabled === true ? 'Сервис выключен' : 'Сервис включён' }),
        el('span', { class: 'mcp-toggle-hint', text: server.disabled === true ? 'Действия недоступны, пока не включите' : 'Действия доступны после вашего разрешения' })),
      sw));

    body.replaceChildren(...parts.filter(Boolean));
    fillIcons(body);
    const errorNode = $('mcpDetailsError');
    if (errorNode) errorNode.hidden = true;
    const deleteBtn = $('mcpDetailsDelete');
    if (deleteBtn) deleteBtn.disabled = !bridge();
  }

  function openDetails(server, trigger) {
    const dialog = $('mcpDetailsDialog');
    if (!dialog || !server) return;
    lastTrigger = trigger || null;
    renderDetails(server);
    openDialog(dialog, trigger);
    focusFirst('mcpDetailsClose');
  }

  // ── Удаление ──────────────────────────────────────────────────
  let deleteName = '';

  function openDelete(server) {
    const dialog = $('mcpDeleteDialog');
    if (!dialog || !server) return;
    deleteName = server.name;
    const text = $('mcpDeleteText');
    if (text) text.textContent = `Удалить «${server.name}»? Это действие нельзя отменить: сервис и его настройки будут удалены.`;
    const input = $('mcpDeleteInput');
    if (input) input.value = '';
    const confirm = $('mcpDeleteConfirm');
    if (confirm) confirm.disabled = true;
    const err = $('mcpDeleteError');
    if (err) err.hidden = true;
    openDialog(dialog, lastTrigger);
    if (input) input.focus();
  }

  async function confirmDelete() {
    const api = bridge();
    const dialog = $('mcpDeleteDialog');
    if (!api || !deleteName) return;
    const confirm = $('mcpDeleteConfirm');
    if (confirm) confirm.disabled = true;
    let r;
    try {
      r = await api.mcpRemove(deleteName);
    } catch (err) {
      if (confirm) confirm.disabled = false;
      showDeleteError(String((err && err.message) || err));
      return;
    }
    if (!r || !r.ok) {
      if (confirm) confirm.disabled = false;
      showDeleteError((r && r.error) || 'не получилось удалить');
      return;
    }
    if (r.servers) paint(r.servers, { force: true });
    closeDialog(dialog);
    closeDialog($('mcpDetailsDialog'));
    toast('Сервис удалён, его действия больше не доступны', 'ok');
    deleteName = '';
  }

  function showDeleteError(text) {
    const box = $('mcpDeleteError');
    const textNode = $('mcpDeleteErrorText');
    if (textNode) textNode.textContent = text;
    if (box) box.hidden = !text;
  }

  // ── Изменения набора действий (drift) ─────────────────────────
  let driftName = '';

  function openDrift(server, trigger) {
    const dialog = $('mcpDriftDialog');
    if (!dialog || !server) return;
    driftName = server.name;
    lastTrigger = trigger || null;
    const title = $('mcpDriftTitle');
    if (title) title.textContent = `Набор действий «${server.name}» изменился`;
    const text = $('mcpDriftText');
    if (text) {
      text.textContent = 'Сервис после обновления объявил другой набор действий. Сверьте изменения и подтвердите их, чтобы Джарвис снова мог пользоваться сервисом.';
    }
    const body = $('mcpDriftBody');
    if (body) {
      const chips = driftItems(server);
      body.replaceChildren(...(chips.length
        ? chips.map((item) => el('span', { class: 'mcp-diff-chip', 'data-kind': item.kind, text: item.text }))
        : [el('span', { class: 'mcp-diff-chip', text: 'изменения не перечислены сервисом' })]));
    }
    const err = $('mcpDriftError');
    if (err) err.hidden = true;
    openDialog(dialog, trigger);
    focusFirst('mcpDriftCancel');
  }

  async function confirmDrift() {
    const api = bridge();
    if (!api || !driftName) return;
    const button = $('mcpDriftConfirm');
    if (button) button.disabled = true;
    let r;
    try {
      r = await api.mcpApprove(driftName);
    } catch (err) {
      if (button) button.disabled = false;
      showDriftError(String((err && err.message) || err));
      return;
    }
    if (button) button.disabled = false;
    if (!r || !r.ok) { showDriftError((r && r.error) || 'не получилось подтвердить'); return; }
    if (r.servers) paint(r.servers, { force: true });
    closeDialog($('mcpDriftDialog'));
    toast('Изменения подтверждены: действия сервиса снова доступны', 'ok');
    driftName = '';
  }

  function showDriftError(text) {
    const box = $('mcpDriftError');
    const textNode = $('mcpDriftErrorText');
    if (textNode) textNode.textContent = text;
    if (box) box.hidden = !text;
  }

  // ── Добавление сервиса ────────────────────────────────────────
  const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

  function validateAdd(name, target, args) {
    if (!name) return 'Укажите название: латиница, цифры, «-» и «_», до 40 знаков';
    if (!NAME_RE.test(name)) return 'Название: латиница, цифры, «-» и «_», до 40 знаков';
    if (!target) return 'Укажите адрес или команду запуска';
    if (target.length > 400) return 'Адрес или команда длиннее 400 знаков';
    if (args.length > 400) return 'Аргументы длиннее 400 знаков';
    return '';
  }

  function showAddError(text) {
    const box = $('mcpAddError');
    const textNode = $('mcpAddErrorText');
    if (textNode) textNode.textContent = text || '';
    if (box) box.hidden = !text;
  }

  function updateAddValidity() {
    const nameNode = $('mcpName');
    const targetNode = $('mcpTarget');
    const argsNode = $('mcpArgs');
    const button = $('mcpAddSubmit');
    if (!button) return;
    const name = nameNode ? String(nameNode.value || '').trim() : '';
    const target = targetNode ? String(targetNode.value || '').trim() : '';
    const args = argsNode ? String(argsNode.value || '').trim() : '';
    button.disabled = Boolean(validateAdd(name, target, args));
    if (nameNode) nameNode.setAttribute('aria-invalid', String(Boolean(name) && !NAME_RE.test(name)));
  }

  function openAdd(trigger) {
    const dialog = $('mcpAddDialog');
    if (!dialog) return;
    lastTrigger = trigger || null;
    showAddError('');
    try { form.reset(); } catch { /* форма уже пуста */ }
    updateAddValidity();
    openDialog(dialog, trigger);
    focusFirst('mcpName');
  }

  form.addEventListener('submit', async (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const api = bridge();
    if (!api) return;
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const target = String(data.get('target') || '').trim();
    const args = String(data.get('args') || '').trim();
    const problem = validateAdd(name, target, args);
    if (problem) { showAddError(problem); return; }
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      const r = await api.mcpAdd(name, target, args);
      if (!r || !r.ok) {
        const why = (r && r.error) || 'Не получилось добавить';
        showAddError(why);
        toast(why, 'error');
        return;
      }
      if (r.servers) paint(r.servers, { force: true });
      try { form.reset(); } catch { /* форма уже пуста */ }
      showAddError('');
      closeDialog($('mcpAddDialog'));
      if (r.error) {
        toast(`Сервис сохранён, но не подключился: ${r.error}`, 'error');
        openConnectError(name, r.error);
      } else {
        toast('Сервис подключён. Его действия спрашиваются, пока вы не разрешите их в настройках', 'ok');
      }
    } finally {
      if (button) button.disabled = false;
    }
  });

  // ── Панель популярных ─────────────────────────────────────────
  function popularItems() {
    const items = [];
    for (const id of POPULAR_ORDER) {
      const available = POPULAR.find((item) => item.id === id);
      if (available) { items.push({ ...available, available: true }); continue; }
      const unavailable = POPULAR_UNAVAILABLE.find((item) => item.id === id);
      if (unavailable) items.push({ ...unavailable, available: false });
    }
    return items;
  }

  function popularMatches(item) {
    if (STATE.popularCat !== 'all' && POPULAR_GROUPS[item.id] !== STATE.popularCat) return false;
    const q = STATE.q.trim().toLowerCase();
    if (!q) return true;
    return [item.id, item.title, item.hint, item.reason || ''].join(' ').toLowerCase().includes(q);
  }

  function installedNames() {
    return new Set(SERVERS.map((server) => String(server.name || '')));
  }

  function renderPopular() {
    const listBox = $('mcpPopularList');
    const catsBox = $('mcpPopularCats');
    if (!listBox || !catsBox) return;
    const items = popularItems().filter(popularMatches);
    const names = installedNames();
    const key = JSON.stringify(items.map((item) => [item.id, item.available])) + '|' + STATE.popularCat + '|' + STATE.q + '|' + [...names].join(',');
    if (key === popularKey) return;
    popularKey = key;

    catsBox.replaceChildren(...POPULAR_CATS.map((cat) => el('button', {
      class: 'nox-chip-filter', type: 'button', 'data-popcat': cat.id,
      'aria-pressed': String(STATE.popularCat === cat.id),
      title: cat.full || cat.title,
      'aria-label': cat.full || cat.title,
      text: cat.title,
      onclick: () => { STATE.popularCat = cat.id; popularKey = ''; renderPopular(); },
    })));

    if (!items.length) {
      listBox.replaceChildren(el('p', { class: 'nox-popular-note', text: 'Ничего не нашлось — измените запрос.' }));
      return;
    }

    listBox.replaceChildren(...items.map((item) => {
      const already = names.has(item.id);
      let button;
      if (item.available && !already) {
        button = el('button', {
          class: 'mcp-popular-add', type: 'button', text: '+ Добавить',
          title: `Добавить сервис «${item.title}»`,
          onclick: (e) => addPopular(item, e.currentTarget),
        });
      } else if (already) {
        button = el('button', { class: 'mcp-popular-add', type: 'button', disabled: true, text: 'Добавлен' });
        button.title = 'Сервис уже есть в списке подключений';
      } else {
        button = el('button', { class: 'mcp-popular-add', type: 'button', disabled: true, text: 'Не настроено' });
        button.title = item.reason || 'Сервис пока недоступен';
      }
      const row = el('div', { class: 'mcp-popular-row', 'data-popular': item.id },
        el('span', { class: 'mcp-popular-icon', 'aria-hidden': 'true' }, icon('plug')),
        el('span', { class: 'mcp-popular-main' },
          el('span', { class: 'mcp-popular-name', title: item.title, text: item.title }),
          el('span', {
            class: 'mcp-popular-desc',
            title: item.available ? item.hint : (item.reason || item.hint),
            text: item.available ? item.hint : (item.reason || item.hint),
          })),
        button);
      return row;
    }));
    fillIcons(listBox);
  }

  async function addPopular(item, button) {
    const api = bridge();
    if (!api || !item || !item.available) return;
    if (button) { button.disabled = true; button.classList.add('is-busy'); }
    let r;
    try {
      r = await api.mcpAdd(item.id, item.target, item.args);
    } catch (err) {
      if (button) { button.disabled = false; button.classList.remove('is-busy'); }
      toast('Не получилось добавить: ' + String((err && err.message) || err), 'error');
      return;
    }
    if (button) { button.disabled = false; button.classList.remove('is-busy'); }
    if (!r || !r.ok) { toast((r && r.error) || 'Не получилось добавить', 'error'); return; }
    if (r.servers) paint(r.servers, { force: true });
    if (r.error) {
      toast(`Сервис «${item.title}» сохранён, но не подключился: ${r.error}`, 'error');
      openConnectError(item.id, r.error);
    } else {
      toast(`Сервис «${item.title}» подключён. Его действия спрашиваются, пока вы не разрешите их`, 'ok');
    }
  }

  // ── Копирование адреса (без секретов: target уже публичный) ────
  function legacyCopy(value) {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function copyText(value) {
    const text = String(value || '');
    if (!text) return Promise.resolve(false);
    try {
      if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => legacyCopy(text));
      }
    } catch { /* нет доступа к буферу */ }
    return Promise.resolve(legacyCopy(text));
  }

  // ── Загрузка состояния и опрос ────────────────────────────────
  function paint(servers, options = {}) {
    SERVERS = Array.isArray(servers) ? servers : [];
    if (options.force) { listKey = ''; popularKey = ''; }
    renderCounts();
    renderList();
    renderPopular();
  }

  function showLoading() {
    const loading = $('mcpLoading');
    if (loading) loading.hidden = false;
    if (empty) empty.hidden = true;
    const noResults = $('mcpNoResults');
    if (noResults) noResults.hidden = true;
  }

  let loadedOnce = false;

  async function load() {
    const api = bridge();
    if (!api) return;
    if (!loadedOnce) showLoading();
    try {
      const state = await api.mcpState();
      LOAD_ERROR = '';
      paint((state && state.servers) || []);
    } catch (err) {
      LOAD_ERROR = 'Не удалось прочитать подключения: ' + String((err && err.message) || err);
      renderLoadError();
    } finally {
      loadedOnce = true;
    }
  }

  // Непрерывная проверка состояния: сервер мог упасть или подключиться сам. Опрос идёт
  // только когда раздел «Подключения» виден на экране.
  let timer = null;
  function polling(on) {
    if (on && !timer) timer = setInterval(() => { if (view && !view.hidden) load(); }, POLL_MS);
    if (!on && timer) { clearInterval(timer); timer = null; }
  }

  // ── Связывание элементов ──────────────────────────────────────
  function initControls() {
    const search = $('mcpSearch');
    if (search) {
      search.addEventListener('input', () => {
        STATE.q = String(search.value || '');
        listKey = '';
        popularKey = '';
        renderList();
        renderPopular();
      });
    }
    const filters = $('mcpFilters');
    if (filters) {
      filters.addEventListener('click', (e) => {
        const chip = e && e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-filter]') : null;
        if (!chip) return;
        STATE.filter = chip.getAttribute('data-filter') || 'all';
        listKey = '';
        renderList();
        renderCounts();
      });
    }
    const reset = $('mcpResetFilters');
    if (reset) {
      reset.addEventListener('click', () => {
        STATE.q = '';
        STATE.filter = 'all';
        const searchNode = $('mcpSearch');
        if (searchNode) searchNode.value = '';
        listKey = '';
        popularKey = '';
        renderList();
        renderPopular();
        renderCounts();
      });
    }
    const reload = $('mcpReload');
    if (reload) reload.addEventListener('click', () => { listKey = ''; load(); });
    const retryLoad = $('mcpErrorRetry');
    if (retryLoad) retryLoad.addEventListener('click', () => { listKey = ''; load(); });

    const addBtn = $('mcpAddBtn');
    if (addBtn) addBtn.addEventListener('click', () => openAdd(addBtn));
    const emptyAdd = $('mcpEmptyAdd');
    if (emptyAdd) emptyAdd.addEventListener('click', () => openAdd(emptyAdd));

    // Диалог добавления.
    const closeAdd = () => closeDialog($('mcpAddDialog'));
    for (const id of ['mcpAddClose', 'mcpAddCancel']) {
      const node = $(id);
      if (node) node.addEventListener('click', closeAdd);
    }
    for (const id of ['mcpName', 'mcpTarget', 'mcpArgs']) {
      const node = $(id);
      if (node) node.addEventListener('input', updateAddValidity);
    }
    const addDialog = $('mcpAddDialog');
    if (addDialog) addDialog.addEventListener('cancel', () => { closeDialog(addDialog); });
    if (addDialog) addDialog.addEventListener('close', () => { if (lastTrigger && typeof lastTrigger.focus === 'function') { try { lastTrigger.focus(); } catch { /* пусто */ } } });

    // Детали.
    for (const id of ['mcpDetailsX', 'mcpDetailsClose']) {
      const node = $(id);
      if (node) node.addEventListener('click', () => closeDialog($('mcpDetailsDialog')));
    }
    const detailsDialog = $('mcpDetailsDialog');
    if (detailsDialog) detailsDialog.addEventListener('cancel', () => closeDialog(detailsDialog));
    const detailsDelete = $('mcpDetailsDelete');
    if (detailsDelete) detailsDelete.addEventListener('click', () => {
      const server = SERVERS.find((x) => x.name === detailName);
      if (server) openDelete(server);
    });

    // Удаление.
    const deleteDialog = $('mcpDeleteDialog');
    for (const id of ['mcpDeleteClose', 'mcpDeleteCancel']) {
      const node = $(id);
      if (node) node.addEventListener('click', () => closeDialog(deleteDialog));
    }
    if (deleteDialog) deleteDialog.addEventListener('cancel', () => closeDialog(deleteDialog));
    const deleteInput = $('mcpDeleteInput');
    if (deleteInput) {
      deleteInput.addEventListener('input', () => {
        const confirm = $('mcpDeleteConfirm');
        if (confirm) confirm.disabled = String(deleteInput.value || '').trim() !== deleteName;
      });
    }
    const deleteConfirm = $('mcpDeleteConfirm');
    if (deleteConfirm) deleteConfirm.addEventListener('click', confirmDelete);

    // Изменения набора действий.
    const driftDialog = $('mcpDriftDialog');
    for (const id of ['mcpDriftClose', 'mcpDriftCancel']) {
      const node = $(id);
      if (node) node.addEventListener('click', () => closeDialog(driftDialog));
    }
    if (driftDialog) driftDialog.addEventListener('cancel', () => closeDialog(driftDialog));
    const driftConfirm = $('mcpDriftConfirm');
    if (driftConfirm) driftConfirm.addEventListener('click', confirmDrift);

    // Ошибка подключения.
    const errorDialog = $('mcpErrorDialog');
    for (const id of ['mcpConnErrX', 'mcpConnErrClose']) {
      const node = $(id);
      if (node) node.addEventListener('click', () => closeDialog(errorDialog));
    }
    if (errorDialog) errorDialog.addEventListener('cancel', () => closeDialog(errorDialog));
    const errorRetry = $('mcpConnErrRetry');
    if (errorRetry) {
      errorRetry.addEventListener('click', async () => {
        const name = errorDialog ? String(errorDialog.dataset.name || '') : '';
        const api = bridge();
        if (!name || !api) return;
        errorRetry.disabled = true;
        let r;
        try { r = await api.mcpToggle(name, false); }
        catch (err) { errorRetry.disabled = false; openConnectError(name, String((err && err.message) || err)); return; }
        errorRetry.disabled = false;
        if (r && r.servers) paint(r.servers, { force: true });
        if (!r || !r.ok) { openConnectError(name, (r && r.error) || 'не получилось переподключить'); return; }
        if (r.error) { openConnectError(name, String(r.error)); return; }
        closeDialog(errorDialog);
        toast(`Сервис «${name}» подключён`, 'ok');
      });
    }

    // Подсказка о добавлении: новая сборка подключает сервис сразу, пакет ставится только по действию владельца.
    if (note) {
      note.textContent = 'Сервис подключается сразу, перезапуск не нужен. Если это команда npx или uvx, пакет сервера может скачаться при первом запуске — сервис ставится только по вашему действию. Действия сервиса всегда спрашиваются, пока вы не разрешите их в настройках.';
    }
  }

  // Мост окна может появиться позже страницы (в браузерной проверке его ставит dev-stub).
  document.addEventListener('jarvis:view', (e) => {
    const active = e.detail === 'mcp';
    polling(active);
    if (active) { listKey = ''; load(); }
  });

  initControls();
  showLoading();
  load();
})();
