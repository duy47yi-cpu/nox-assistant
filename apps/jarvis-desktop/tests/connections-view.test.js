'use strict';

// Экран «Подключения» без Electron: минимальная подмена DOM и моста окна.
// Проверяем то, что видит владелец: карточки сервисов и честные состояния, детали и диалоги,
// причины ошибок, повтор/подключение/подтверждение набора действий/удаление, популярные
// сервисы и опрос состояния только в видимом разделе.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'connections.js'), 'utf8');

// ── крошечный DOM: только то, что использует connections.js

class FakeClassList {
  constructor(node) {
    this.node = node;
  }

  _items() {
    return String(this.node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }

  _write(items) {
    this.node.setAttribute('class', items.join(' '));
  }

  add(name) {
    const items = this._items();
    if (!items.includes(name)) {
      items.push(name);
      this._write(items);
    }
  }

  remove(name) {
    this._write(this._items().filter((item) => item !== name));
  }

  contains(name) {
    return this._items().includes(name);
  }

  toggle(name, force) {
    const has = this.contains(name);
    const want = force === undefined ? !has : Boolean(force);
    if (want && !has) this.add(name);
    if (!want && has) this.remove(name);
    return want;
  }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.textContent = '';
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.className = '';
    this.title = '';
    this.value = '';
    this.open = false;
    this.style = {};
    this.dataset = {};
    this.fields = new Map();
    this.focusCount = 0;
    this._submit = null;
    this.classList = new FakeClassList(this);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'title') this.title = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'class') this.className = '';
  }

  append(...kids) {
    for (const kid of kids) if (kid !== undefined && kid !== null) this.children.push(kid);
  }

  appendChild(kid) {
    this.append(kid);
    return kid;
  }

  replaceChildren(...kids) {
    this.children = kids.filter(Boolean);
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== fn);
  }

  fire(type, event = {}) {
    for (const fn of [...(this.listeners[type] || [])]) fn(event);
  }

  reset() {
    this.fields.clear();
  }

  querySelector(selector) {
    if (selector === 'button[type="submit"]') return this._submit;
    return null;
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return null;
  }

  focus() {
    this.focusCount += 1;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  remove() {}
}

function textOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  let out = node.textContent ? `${node.textContent} ` : '';
  for (const kid of node.children || []) out += textOf(kid);
  return out;
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node === 'string') return out;
  if (predicate(node)) out.push(node);
  for (const kid of node.children || []) findAll(kid, predicate, out);
  return out;
}

const byTag = (root, tag) => findAll(root, (node) => node.tagName === String(tag).toUpperCase());
const byClass = (root, name) => findAll(root, (node) => String(node.getAttribute('class') || '').split(/\s+/).includes(name));
const cardOf = (ids, name) => findAll(ids.mcpList, (node) => node.getAttribute('data-name') === name)[0];
const actionOf = (card) => byClass(card, 'mcp-card-action')[0];
const clickEvent = (node) => ({ stopPropagation() {}, currentTarget: node });

function makeSandbox(bridge, { viewHidden = false } = {}) {
  const toasts = [];
  const ids = {};
  const add = (id, tag = 'div') => {
    const node = new FakeNode(tag);
    node.id = id;
    ids[id] = node;
    return node;
  };

  // Список и форма ручного добавления.
  add('mcpList', 'ul');
  add('mcpEmpty');
  add('mcpForm', 'form');
  add('mcpFormNote', 'p');
  // Страница: загрузка, ошибка чтения, поиск, фильтры, счётчики.
  add('mcpNoResults');
  add('mcpLoading');
  add('mcpErrorNote', 'p');
  add('mcpErrorText', 'span');
  add('mcpErrorRetry', 'button');
  add('mcpReload', 'button');
  add('mcpSearch', 'input');
  add('mcpFilters');
  add('mcpResetFilters', 'button');
  add('mcpAddBtn', 'button');
  add('mcpEmptyAdd', 'button');
  for (const id of ['mcpFilterAllCount', 'mcpFilterConnectedCount', 'mcpFilterDisabledCount', 'mcpFilterErrorCount']) add(id, 'span');
  // Популярные.
  add('mcpPopularList');
  add('mcpPopularCats');
  // Диалог добавления.
  add('mcpAddDialog', 'dialog');
  add('mcpAddClose', 'button');
  add('mcpAddCancel', 'button');
  add('mcpName', 'input');
  add('mcpTarget', 'input');
  add('mcpArgs', 'input');
  add('mcpAddSubmit', 'button');
  add('mcpAddError', 'p');
  add('mcpAddErrorText', 'span');
  ids.mcpAddSubmit.setAttribute('type', 'submit');
  ids.mcpForm._submit = ids.mcpAddSubmit;
  // Детали сервиса.
  add('mcpDetailsDialog', 'dialog');
  add('mcpDetailsTitle', 'h2');
  add('mcpDetailsBody');
  add('mcpDetailsError', 'p');
  add('mcpDetailsErrorText', 'span');
  add('mcpDetailsDelete', 'button');
  add('mcpDetailsClose', 'button');
  add('mcpDetailsX', 'button');
  // Удаление.
  add('mcpDeleteDialog', 'dialog');
  add('mcpDeleteText', 'p');
  add('mcpDeleteInput', 'input');
  add('mcpDeleteConfirm', 'button');
  add('mcpDeleteError', 'p');
  add('mcpDeleteErrorText', 'span');
  add('mcpDeleteClose', 'button');
  add('mcpDeleteCancel', 'button');
  // Набор действий изменился.
  add('mcpDriftDialog', 'dialog');
  add('mcpDriftTitle', 'h2');
  add('mcpDriftText', 'p');
  add('mcpDriftBody');
  add('mcpDriftError', 'p');
  add('mcpDriftErrorText', 'span');
  add('mcpDriftConfirm', 'button');
  add('mcpDriftCancel', 'button');
  add('mcpDriftClose', 'button');
  // Ошибка подключения.
  add('mcpErrorDialog', 'dialog');
  add('mcpConnErrName', 'p');
  add('mcpConnErrReason', 'span');
  add('mcpConnErrRetry', 'button');
  add('mcpConnErrX', 'button');
  add('mcpConnErrClose', 'button');

  const view = new FakeNode('section');
  view.hidden = viewHidden;
  const intervals = [];

  const document = {
    head: { append() {} },
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => (selector === '[data-view="mcp"]' ? view : null),
    addEventListener(type, fn) {
      (this.listeners = this.listeners || {});
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== fn);
    },
    dispatchEvent(event) {
      if (event && event.type === 'jarvis:toast') toasts.push(event.detail);
      for (const fn of (this.listeners && this.listeners[event.type]) || []) fn(event);
      return true;
    },
  };

  class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  class FormData {
    constructor(form) {
      this.form = form;
    }

    get(key) {
      return this.form.fields.has(key) ? this.form.fields.get(key) : null;
    }
  }

  const sandbox = {
    document,
    window: { jarvis: bridge },
    FormData,
    CustomEvent,
    console: { warn() {} },
    setInterval: (fn, ms) => {
      const timer = { id: intervals.length + 1, fn, ms, cleared: false };
      intervals.push(timer);
      return timer.id;
    },
    clearInterval: (id) => {
      const timer = intervals.find((item) => item.id === id);
      if (timer) timer.cleared = true;
    },
    setTimeout,
    Promise,
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: 'connections.js' });
  return { ids, view, toasts, document, sandbox, intervals };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

const connected = {
  name: 'echo',
  transport: 'stdio',
  target: 'C:\\Program Files\\nodejs\\node.exe',
  disabled: false,
  status: 'connected',
  error: null,
  protocolVersion: '2025-06-18',
  serverInfo: { name: 'echo-fixture', version: '1.0.0' },
  capabilities: { tools: true, resources: true },
  tools: [{ name: 'echo_echo', title: 'Повтор', description: 'Возвращает текст' }, { name: 'echo_add', title: 'Сложить' }],
  toolCount: 2,
};

const broken = { ...connected, status: 'error', error: 'программа не найдена: ENOENT', tools: [], toolCount: 0 };

// ── Список и состояния ─────────────────────────────────────────

test('подключённый сервис: карточка, состояние, действия и подпись протокола', async () => {
  const bridge = { mcpState: async () => ({ servers: [connected] }) };
  const { ids } = makeSandbox(bridge);
  await wait();
  assert.equal(ids.mcpEmpty.hidden, true);
  assert.equal(ids.mcpList.children.length, 1);
  const card = cardOf(ids, 'echo');
  assert.ok(card, 'карточка сервиса есть');
  const text = textOf(card);
  assert.match(text, /echo/);
  assert.match(text, /Подключён/);
  assert.match(text, /Подключён · 2 действия/);
  assert.match(text, /Действия \(2\): Повтор, Сложить/);
  const nameNode = byClass(card, 'mcp-name')[0];
  assert.equal(nameNode.textContent, 'echo');
  assert.match(nameNode.title, /Протокол MCP 2025-06-18/);
  assert.match(nameNode.title, /Сервер: echo-fixture 1\.0\.0/);
  const action = actionOf(card);
  assert.equal(action.textContent, 'Детали');
  assert.doesNotMatch(textOf(ids.mcpFormNote), /применятся после перезапуска/);
  assert.match(textOf(ids.mcpFormNote), /перезапуск не нужен/);
});

test('пустое состояние: нет сервисов — подсказка видна, список пуст', async () => {
  const bridge = { mcpState: async () => ({ servers: [] }) };
  const { ids } = makeSandbox(bridge);
  await wait();
  assert.equal(ids.mcpList.children.length, 0);
  assert.equal(ids.mcpEmpty.hidden, false);
  assert.equal(ids.mcpNoResults.hidden, true);
  assert.equal(ids.mcpLoading.hidden, true);
});

test('старая сборка моста: прежние слова состояний и приоритет status', async () => {
  const bridge = {
    mcpState: async () => ({
      servers: [
        { name: 'legacy', transport: 'stdio', target: 'npx.cmd', disabled: false, connected: false },
        { name: 'off', transport: 'http', target: 'https://example.com/mcp', disabled: true, connected: false },
        { name: 'forced', transport: 'stdio', target: 'node', disabled: true, connected: false, status: 'connected', tools: [], toolCount: 0 },
      ],
    }),
  };
  const { ids } = makeSandbox(bridge);
  await wait();
  assert.match(textOf(cardOf(ids, 'legacy')), /Подключится при запуске/);
  assert.match(textOf(cardOf(ids, 'off')), /Выключен/);
  assert.equal(actionOf(cardOf(ids, 'off')).textContent, 'Включить');
  // Поле status главнее старых connected/disabled: сервис считается подключённым.
  assert.match(textOf(cardOf(ids, 'forced')), /Подключён/);
});

test('карточка открывает детали с протоколом и возможностями, закрытие возвращает фокус', async () => {
  const bridge = { mcpState: async () => ({ servers: [connected] }) };
  const { ids } = makeSandbox(bridge);
  await wait();
  const card = cardOf(ids, 'echo');
  card.fire('click', {});
  assert.equal(ids.mcpDetailsDialog.open, true);
  const bodyText = textOf(ids.mcpDetailsBody);
  assert.match(bodyText, /echo/);
  assert.match(bodyText, /Протокол MCP 2025-06-18/);
  assert.match(bodyText, /Сервер: echo-fixture 1\.0\.0/);
  assert.match(bodyText, /Действия сервиса \(2\)/);
  assert.match(bodyText, /Повтор/);
  assert.match(bodyText, /Сложить/);
  assert.match(bodyText, /Разрешения/);
  assert.equal(byClass(ids.mcpDetailsBody, 'nox-icon-btn').length, 1, 'кнопка копирования адреса');
  const switchNode = byTag(ids.mcpDetailsBody, 'INPUT')[0];
  assert.ok(switchNode, 'в деталях есть переключатель');
  assert.equal(switchNode.checked, true);
  assert.equal(ids.mcpDetailsDelete.disabled, false);
  ids.mcpDetailsClose.fire('click');
  assert.equal(ids.mcpDetailsDialog.open, false);
  assert.equal(card.focusCount, 1, 'фокус вернулся на карточку');
});

// ── Ошибка и повтор ────────────────────────────────────────────

test('ошибка: причина видна, «Повторить» переподключает и обновляет экран', async () => {
  const calls = [];
  const bridge = {
    mcpState: async () => ({ servers: [broken] }),
    mcpToggle: async (name, disabled) => { calls.push({ name, disabled }); return { ok: true, servers: [connected] }; },
  };
  const { ids, toasts } = makeSandbox(bridge);
  await wait();
  const card = cardOf(ids, 'echo');
  const text = textOf(card);
  assert.match(text, /Ошибка/);
  assert.match(text, /Ошибка: программа не найдена: ENOENT/);
  assert.doesNotMatch(text, /Действия \(/);
  assert.equal(byClass(card, 'mcp-caps').length, 0);
  const retry = actionOf(card);
  assert.equal(retry.textContent, 'Повторить');
  retry.fire('click', clickEvent(retry));
  await wait();
  assert.deepEqual(calls, [{ name: 'echo', disabled: false }]);
  assert.ok(toasts.some((toast) => toast.text === 'Сервис «echo» подключён' && toast.kind === 'ok'));
  assert.match(textOf(cardOf(ids, 'echo')), /Подключён/);
});

test('ошибка: неудачный «Повторить» открывает диалог с честной причиной', async () => {
  const bridge = {
    mcpState: async () => ({ servers: [broken] }),
    mcpToggle: async () => ({ ok: false, error: 'всё ещё ENOENT' }),
  };
  const { ids } = makeSandbox(bridge);
  await wait();
  const retry = actionOf(cardOf(ids, 'echo'));
  retry.fire('click', clickEvent(retry));
  await wait();
  assert.equal(ids.mcpErrorDialog.open, true);
  assert.equal(ids.mcpErrorDialog.dataset.name, 'echo');
  assert.equal(ids.mcpConnErrReason.textContent, 'всё ещё ENOENT');
  assert.match(ids.mcpConnErrName.textContent, /Сервис «echo» сохранён, но не подключился/);
  ids.mcpConnErrClose.fire('click');
  assert.equal(ids.mcpErrorDialog.open, false);
});

// ── Переключатель в деталях ───────────────────────────────────

test('переключатель в деталях выключает сервис и перерисовывает карточку', async () => {
  const switched = [{ ...connected, status: 'disabled', disabled: true, tools: [], toolCount: 0 }];
  const calls = [];
  const bridge = {
    mcpState: async () => ({ servers: [connected] }),
    mcpToggle: async (name, disabled) => { calls.push({ name, disabled }); return { ok: true, servers: switched }; },
  };
  const { ids } = makeSandbox(bridge);
  await wait();
  cardOf(ids, 'echo').fire('click', {});
  const switchNode = byTag(ids.mcpDetailsBody, 'INPUT')[0];
  assert.equal(switchNode.checked, true);
  switchNode.checked = false;
  switchNode.fire('change');
  await wait();
  assert.deepEqual(calls, [{ name: 'echo', disabled: true }]);
  const card = cardOf(ids, 'echo');
  assert.match(textOf(card), /Выключен/);
  assert.equal(actionOf(card).textContent, 'Включить');
  assert.match(textOf(ids.mcpDetailsBody), /Выключен/);
  assert.match(textOf(ids.mcpDetailsBody), /Сервис выключен/);
});

// ── Ручное добавление ─────────────────────────────────────────

test('добавление: успех, сохранение с ошибкой подключения и отказ — разные сообщения', async () => {
  const calls = [];
  const responses = [];
  let current = [connected];
  const bridge = {
    mcpState: async () => ({ servers: current }),
    mcpAdd: async (...args) => { calls.push(args); return responses.shift(); },
  };
  const { ids, toasts } = makeSandbox(bridge);
  await wait();

  const submit = (name, target, args) => {
    ids.mcpForm.fields.set('name', name);
    ids.mcpForm.fields.set('target', target);
    ids.mcpForm.fields.set('args', args);
    ids.mcpForm.fire('submit', { preventDefault() {} });
  };

  // Диалог открывается и закрывается кнопкой «Отмена», фокус возвращается на кнопку.
  ids.mcpAddBtn.fire('click');
  assert.equal(ids.mcpAddDialog.open, true);
  ids.mcpAddCancel.fire('click');
  assert.equal(ids.mcpAddDialog.open, false);
  assert.equal(ids.mcpAddBtn.focusCount, 1);
  ids.mcpAddBtn.fire('click');

  responses.push({ ok: true, servers: [connected] });
  submit('echo', 'node', '');
  await wait();
  assert.deepEqual(calls[0], ['echo', 'node', '']);
  assert.equal(ids.mcpAddDialog.open, false);
  assert.equal(ids.mcpList.children.length, 1);
  assert.ok(toasts.some((toast) => toast.text === 'Сервис подключён. Его действия спрашиваются, пока вы не разрешите их в настройках' && toast.kind === 'ok'));

  current = [];
  responses.push({ ok: true, servers: [], error: 'программа не найдена' });
  submit('echo2', 'node', '');
  await wait();
  assert.deepEqual(calls[1], ['echo2', 'node', '']);
  assert.ok(toasts.some((toast) => toast.text === 'Сервис сохранён, но не подключился: программа не найдена' && toast.kind === 'error'));
  assert.equal(ids.mcpErrorDialog.open, true);
  assert.equal(ids.mcpConnErrReason.textContent, 'программа не найдена');
  assert.match(ids.mcpConnErrName.textContent, /echo2/);
  ids.mcpErrorDialog.close();

  responses.push({ ok: false, error: 'Такое название уже есть' });
  submit('echo', 'node', '');
  await wait();
  assert.ok(toasts.some((toast) => toast.text === 'Такое название уже есть' && toast.kind === 'error'));
  assert.equal(ids.mcpAddErrorText.textContent, 'Такое название уже есть');
  assert.equal(ids.mcpAddError.hidden, false);

  // Некорректное имя не доходит до ядра.
  const before = calls.length;
  responses.push({ ok: true, servers: [] });
  submit('Плохое Имя', 'node', '');
  await wait();
  assert.equal(calls.length, before, 'мост не вызывался');
  assert.match(ids.mcpAddErrorText.textContent, /Название: латиница/);
});

// ── Удаление ──────────────────────────────────────────────────

test('удаление: диалог требует название, mcpRemove и честный тост', async () => {
  const calls = [];
  const bridge = {
    mcpState: async () => ({ servers: [connected] }),
    mcpRemove: async (name) => { calls.push(name); return { ok: true, servers: [] }; },
  };
  const { ids, toasts } = makeSandbox(bridge);
  await wait();
  cardOf(ids, 'echo').fire('click', {});
  ids.mcpDetailsDelete.fire('click');
  assert.equal(ids.mcpDeleteDialog.open, true);
  assert.match(ids.mcpDeleteText.textContent, /Удалить «echo»\?/);
  assert.equal(ids.mcpDeleteConfirm.disabled, true, 'без введённого имени удалить нельзя');
  ids.mcpDeleteInput.value = 'ech';
  ids.mcpDeleteInput.fire('input');
  assert.equal(ids.mcpDeleteConfirm.disabled, true, 'чужое имя не подходит');
  ids.mcpDeleteInput.value = 'echo';
  ids.mcpDeleteInput.fire('input');
  assert.equal(ids.mcpDeleteConfirm.disabled, false);
  ids.mcpDeleteConfirm.fire('click');
  await wait();
  assert.deepEqual(calls, ['echo']);
  assert.equal(ids.mcpDeleteDialog.open, false);
  assert.equal(ids.mcpDetailsDialog.open, false);
  assert.ok(toasts.some((toast) => toast.text === 'Сервис удалён, его действия больше не доступны' && toast.kind === 'ok'));
  assert.equal(ids.mcpList.children.length, 0);
  assert.equal(ids.mcpEmpty.hidden, false);
});

test('удаление: ошибка видна в диалоге, диалог не закрывается', async () => {
  const bridge = {
    mcpState: async () => ({ servers: [connected] }),
    mcpRemove: async () => ({ ok: false, error: 'сервис занят' }),
  };
  const { ids } = makeSandbox(bridge);
  await wait();
  cardOf(ids, 'echo').fire('click', {});
  ids.mcpDetailsDelete.fire('click');
  ids.mcpDeleteInput.value = 'echo';
  ids.mcpDeleteInput.fire('input');
  ids.mcpDeleteConfirm.fire('click');
  await wait();
  assert.equal(ids.mcpDeleteDialog.open, true);
  assert.equal(ids.mcpDeleteError.hidden, false);
  assert.equal(ids.mcpDeleteErrorText.textContent, 'сервис занят');
  assert.equal(ids.mcpDeleteConfirm.disabled, false, 'можно повторить');
});

// ── Набор действий изменился ──────────────────────────────────

test('изменения набора действий: карточка, диалог и mcpApprove', async () => {
  const drift = {
    ...connected,
    status: 'drift',
    tools: [],
    toolCount: 0,
    drift: { added: ['new_tool'], removed: ['old_tool'], changed: [{ name: 'renamed' }] },
  };
  const approved = { ...connected, status: 'connected', tools: [{ name: 'new_tool', title: 'Новое действие' }], toolCount: 1 };
  const calls = [];
  const bridge = {
    mcpState: async () => ({ servers: [drift] }),
    mcpApprove: async (name) => { calls.push(name); return { ok: true, servers: [approved] }; },
  };
  const { ids, toasts } = makeSandbox(bridge);
  await wait();
  const card = cardOf(ids, 'echo');
  assert.match(textOf(card), /Изменения инструментов/);
  assert.match(textOf(card), /Набор действий изменился — нужно ваше подтверждение/);
  const chips = byClass(card, 'mcp-diff-chip');
  assert.deepEqual(chips.map((chip) => chip.getAttribute('data-kind')), ['added', 'removed', 'changed']);
  assert.deepEqual(chips.map((chip) => chip.textContent), ['+ new_tool', '− old_tool', '~ renamed']);
  const approve = actionOf(card);
  assert.equal(approve.textContent, 'Подтвердить изменения');
  approve.fire('click', clickEvent(approve));
  assert.equal(ids.mcpDriftDialog.open, true);
  assert.match(ids.mcpDriftTitle.textContent, /Набор действий «echo» изменился/);
  assert.deepEqual(byClass(ids.mcpDriftBody, 'mcp-diff-chip').map((chip) => chip.getAttribute('data-kind')), ['added', 'removed', 'changed']);
  ids.mcpDriftConfirm.fire('click');
  await wait();
  assert.deepEqual(calls, ['echo']);
  assert.equal(ids.mcpDriftDialog.open, false);
  assert.ok(toasts.some((toast) => toast.text === 'Изменения подтверждены: действия сервиса снова доступны' && toast.kind === 'ok'));
  assert.match(textOf(cardOf(ids, 'echo')), /Подключён/);
});

test('изменения набора действий: ошибка подтверждения видна в диалоге', async () => {
  const drift = { ...connected, status: 'drift', tools: [], toolCount: 0, drift: { added: ['new_tool'] } };
  const bridge = {
    mcpState: async () => ({ servers: [drift] }),
    mcpApprove: async () => ({ ok: false, error: 'пока нельзя' }),
  };
  const { ids } = makeSandbox(bridge);
  await wait();
  const approve = actionOf(cardOf(ids, 'echo'));
  approve.fire('click', clickEvent(approve));
  ids.mcpDriftConfirm.fire('click');
  await wait();
  assert.equal(ids.mcpDriftDialog.open, true);
  assert.equal(ids.mcpDriftError.hidden, false);
  assert.equal(ids.mcpDriftErrorText.textContent, 'пока нельзя');
  assert.equal(ids.mcpDriftConfirm.disabled, false, 'можно повторить');
});

// ── Популярные сервисы ────────────────────────────────────────

test('популярные: показываются только проверенные записи каталога', async () => {
  const catalog = [
    { id: 'filesystem', title: 'Файлы', verified: true, envKeys: [], category: 'files', docs: 'https://example.org/docs' },
    { id: 'github', title: 'GitHub', verified: false, envKeys: [], category: 'git' },
  ];
  const { ids } = makeSandbox({ mcpState: async () => ({ servers: [], catalog }) });
  await wait();
  assert.ok(findAll(ids.mcpPopularList, (n) => n.getAttribute('data-popular') === 'filesystem')[0]);
  assert.equal(findAll(ids.mcpPopularList, (n) => n.getAttribute('data-popular') === 'github').length, 0);
});

test('популярные: инструкция открывается по нажатию, ошибка отображается', async () => {
  const opened = [];
  const catalog = [{ id: 'filesystem', title: 'Файлы', verified: true, envKeys: [], category: 'files', docs: 'https://example.org/docs' }];
  const { ids, toasts } = makeSandbox({
    mcpState: async () => ({ servers: [], catalog }),
    openSource: async (url) => { opened.push(url); return { ok: false }; },
  });
  await wait();
  const row = findAll(ids.mcpPopularList, (n) => n.getAttribute('data-popular') === 'filesystem')[0];
  byTag(row, 'BUTTON')[0].fire('click');
  await wait();
  assert.deepEqual(opened, ['https://example.org/docs']);
  assert.ok(toasts.some((toast) => toast.kind === 'error'));
});

// ── Поиск и фильтры ───────────────────────────────────────────

test('поиск и фильтр: список, счётчики и «ничего не найдено» честные', async () => {
  const failed = { ...broken, name: 'broken', serverInfo: { name: 'broken-fixture' } };
  const paused = { ...connected, name: 'paused', serverInfo: undefined, protocolVersion: undefined, status: 'disabled', disabled: true, tools: [], toolCount: 0 };
  const bridge = { mcpState: async () => ({ servers: [connected, failed, paused] }) };
  const { ids } = makeSandbox(bridge);
  await wait();
  assert.equal(ids.mcpList.children.length, 3);
  assert.equal(ids.mcpFilterAllCount.textContent, '3');
  assert.equal(ids.mcpFilterConnectedCount.textContent, '1');
  assert.equal(ids.mcpFilterErrorCount.textContent, '1');

  ids.mcpSearch.value = 'echo';
  ids.mcpSearch.fire('input');
  assert.equal(ids.mcpList.children.length, 1);
  assert.ok(cardOf(ids, 'echo'));

  ids.mcpSearch.value = 'такого-сервиса-нет';
  ids.mcpSearch.fire('input');
  assert.equal(ids.mcpList.children.length, 0);
  assert.equal(ids.mcpNoResults.hidden, false);

  ids.mcpResetFilters.fire('click');
  assert.equal(ids.mcpSearch.value, '');
  assert.equal(ids.mcpList.children.length, 3);
  assert.equal(ids.mcpNoResults.hidden, true);

  const chip = { getAttribute: (name) => (name === 'data-filter' ? 'error' : null) };
  ids.mcpFilters.fire('click', { target: { closest: (selector) => (selector === '[data-filter]' ? chip : null) } });
  assert.equal(ids.mcpList.children.length, 1);
  assert.ok(cardOf(ids, 'broken'));
  assert.equal(textOf(ids.mcpList).includes('paused'), false);
});

// ── Опрос и отсутствие моста ──────────────────────────────────

test('опрос: 3000 мс только после входа в раздел и только когда он виден', async () => {
  let states = 0;
  const bridge = { mcpState: async () => { states += 1; return { servers: [connected] }; } };
  const { document, view, intervals } = makeSandbox(bridge, { viewHidden: true });
  await wait();
  assert.equal(states, 1, 'при загрузке список читается один раз');
  assert.equal(intervals.length, 0, 'до входа в раздел опроса нет');

  document.dispatchEvent({ type: 'jarvis:view', detail: 'mcp' });
  await wait();
  assert.equal(states, 2);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 3000);

  document.dispatchEvent({ type: 'jarvis:view', detail: 'mcp' });
  await wait();
  assert.equal(states, 3, 'повторный вход читает состояние и не плодит интервал');
  assert.equal(intervals.length, 1);

  view.hidden = true;
  intervals[0].fn();
  await wait();
  assert.equal(states, 3, 'на скрытом разделе тик ничего не читает');

  view.hidden = false;
  intervals[0].fn();
  await wait();
  assert.equal(states, 4, 'на видимом разделе тик обновляет состояние');

  document.dispatchEvent({ type: 'jarvis:view', detail: 'settings' });
  assert.equal(intervals[0].cleared, true, 'выход из раздела останавливает опрос');

  document.dispatchEvent({ type: 'jarvis:view', detail: 'mcp' });
  await wait();
  assert.equal(intervals.length, 2);
  assert.equal(states, 5);
});

test('без моста окно не падает: список остаётся пустым, форма молчит', async () => {
  const { ids } = makeSandbox(null);
  await wait();
  assert.equal(ids.mcpList.children.length, 0);
  ids.mcpAddBtn.fire('click');
  assert.equal(ids.mcpAddDialog.open, true);
  ids.mcpForm.fields.set('name', 'echo');
  ids.mcpForm.fields.set('target', 'node');
  ids.mcpForm.fields.set('args', '');
  assert.doesNotThrow(() => ids.mcpForm.fire('submit', { preventDefault() {} }));
  await wait();
  assert.equal(ids.mcpAddError.hidden, true, 'без моста форма ничего не обещает');
});

// ── Четыре достоверных состояния (М2) ────────────────────────────────────────
const pillWord = (card) => textOf(byClass(card, 'mcp-pill')[0]).trim();

test('четыре состояния: слова пилюль достоверны, сервис не выглядит подключённым без соединения', async () => {
  const catalog = [{
    id: 'filesystem', title: 'Файлы', verified: true, envKeys: [], category: 'files', docs: 'https://example.org/docs',
    description: 'чтение и запись файлов в выбранной папке',
  }];
  const configured = { ...connected, name: 'waiting', status: 'idle', tools: [], toolCount: 0 };
  const off = { ...connected, name: 'off', status: 'disabled', disabled: true, tools: [], toolCount: 0 };
  const err = { ...broken, name: 'broken' };
  const { ids } = makeSandbox({ mcpState: async () => ({ servers: [connected, configured, off, err], catalog }) });
  await wait();

  assert.equal(pillWord(cardOf(ids, 'echo')), 'Подключён');
  assert.equal(pillWord(cardOf(ids, 'waiting')), 'Настроено');
  assert.equal(pillWord(cardOf(ids, 'off')), 'Настроено');
  assert.equal(pillWord(cardOf(ids, 'broken')), 'Ошибка');
  assert.equal(cardOf(ids, 'echo').getAttribute('data-group'), 'connected');
  assert.equal(cardOf(ids, 'waiting').getAttribute('data-group'), 'configured');
  assert.equal(cardOf(ids, 'broken').getAttribute('data-group'), 'error');

  // Запись каталога без сохранённого сервиса — «Предложено», а не подключённый сервис.
  const row = findAll(ids.mcpPopularList, (n) => n.getAttribute('data-popular') === 'filesystem')[0];
  assert.ok(row, 'карточка каталога есть');
  assert.equal(row.getAttribute('data-group'), 'proposed');
  assert.equal(textOf(byClass(row, 'mcp-pill')[0]).trim(), 'Предложено');
  assert.match(textOf(row), /чтение и запись файлов/);
});

test('права до включения видны, а список действий — только после соединения', async () => {
  const catalog = [{ id: 'waiting', title: 'Ожидание', verified: true, envKeys: [], category: 'other', description: 'запуск локального сервера' }];
  const configured = { ...connected, name: 'waiting', status: 'idle', tools: [{ name: 'x', title: 'Действие' }], toolCount: 1 };
  const { ids } = makeSandbox({ mcpState: async () => ({ servers: [connected, configured], catalog }) });
  await wait();

  const configuredCard = textOf(cardOf(ids, 'waiting'));
  assert.match(configuredCard, /Права: запуск локального сервера/);
  assert.doesNotMatch(configuredCard, /Действия \(/);
  assert.equal(byClass(cardOf(ids, 'waiting'), 'mcp-caps').length, 0);

  const liveCard = textOf(cardOf(ids, 'echo'));
  assert.doesNotMatch(liveCard, /Права:/);
  assert.match(liveCard, /Действия \(2\)/);
});

test('ошибка объясняется словами, техническая причина остаётся дословно', async () => {
  const { ids } = makeSandbox({ mcpState: async () => ({ servers: [broken] }) });
  await wait();
  const text = textOf(cardOf(ids, 'echo'));
  assert.match(text, /Не удалось запустить: программы из команды нет/);
  assert.match(text, /Ошибка: программа не найдена: ENOENT/);
});

test('включение без соединения не объявляет «подключён»', async () => {
  const calls = [];
  const still = { ...connected, status: 'idle', tools: [], toolCount: 0 };
  const bridge = {
    mcpState: async () => ({ servers: [{ ...connected, status: 'disabled', disabled: true, tools: [], toolCount: 0 }] }),
    mcpToggle: async (name, disabled) => { calls.push([name, disabled]); return { ok: true, servers: [still] }; },
  };
  const { ids, toasts } = makeSandbox(bridge);
  await wait();
  const button = actionOf(cardOf(ids, 'echo'));
  button.fire('click', clickEvent(button));
  await wait();
  assert.deepEqual(calls, [['echo', false]]);
  assert.ok(toasts.some((toast) => toast.text === 'Сервис «echo» настроен, соединения ещё нет' && toast.kind === 'ok'));
  assert.equal(toasts.some((toast) => /подключён/.test(toast.text)), false, 'успех не выдуман');
});

test('«Повторить» без соединения показывает причину, а не успех', async () => {
  const bridge = {
    mcpState: async () => ({ servers: [broken] }),
    mcpToggle: async () => ({ ok: true, servers: [broken] }),
  };
  const { ids, toasts } = makeSandbox(bridge);
  await wait();
  const button = actionOf(cardOf(ids, 'echo'));
  assert.equal(button.textContent, 'Повторить');
  button.fire('click', clickEvent(button));
  await wait();
  assert.equal(ids.mcpErrorDialog.open, true);
  assert.equal(toasts.some((toast) => toast.text === 'Сервис «echo» подключён'), false);
});

test('детали: состояние словами и права до включения', async () => {
  const catalog = [{ id: 'waiting', title: 'Ожидание', verified: true, envKeys: [], category: 'other', description: 'запуск локального сервера' }];
  const configured = { ...connected, name: 'waiting', status: 'idle', tools: [], toolCount: 0 };
  const { ids } = makeSandbox({ mcpState: async () => ({ servers: [configured], catalog }) });
  await wait();
  const card = cardOf(ids, 'waiting');
  card.fire('click', clickEvent(card));
  const body = textOf(ids.mcpDetailsBody);
  assert.match(body, /Настроено · сохранено, но ещё не подключалось/);
  assert.match(body, /Разрешения до включения/);
  assert.match(body, /Что получит сервис:\s+запуск локального сервера/);
});
