'use strict';

// Экран «Подключения» без Electron: минимальная подмена DOM и моста окна.
// Проверяем то, что видит владелец: имя сервиса, действия/возможности, состояние и честную причину сбоя.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'connections.js'), 'utf8');

// ── крошечный DOM: только то, что использует connections.js

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
    this.fields = new Map();
    this._submit = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'title') this.title = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  append(...kids) {
    for (const kid of kids) if (kid !== undefined && kid !== null) this.children.push(kid);
  }

  replaceChildren(...kids) {
    this.children = kids.filter(Boolean);
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  fire(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }

  reset() {
    this.fields = new Map();
  }

  querySelector(selector) {
    if (selector === 'button[type="submit"]') return this._submit;
    return null;
  }
}

function textOf(node) {
  if (!node) return '';
  let out = node.textContent ? `${node.textContent} ` : '';
  for (const kid of node.children || []) out += textOf(kid);
  return out;
}

function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const kid of node.children || []) findAll(kid, predicate, out);
  return out;
}

function makeSandbox(bridge, { viewHidden = false } = {}) {
  const toasts = [];
  const ids = {};
  for (const id of ['mcpList', 'mcpEmpty', 'mcpForm', 'mcpFormNote']) {
    ids[id] = new FakeNode(id === 'mcpForm' ? 'form' : id === 'mcpEmpty' ? 'div' : id === 'mcpList' ? 'ul' : 'p');
    ids[id].id = id;
  }
  const view = new FakeNode('section');
  view.hidden = viewHidden;
  const submit = new FakeNode('button');
  submit.setAttribute('type', 'submit');
  ids.mcpForm._submit = submit;
  const intervals = [];

  const document = {
    head: { append() {} },
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => (selector === '[data-view="mcp"]' ? view : null),
    addEventListener(type, fn) { (this.listeners = this.listeners || {}); (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatchEvent(event) {
      if (event && event.type === 'jarvis:toast') toasts.push(event.detail);
      for (const fn of (this.listeners && this.listeners[event.type]) || []) fn(event);
      return true;
    },
  };
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  class FormData {
    constructor(form) { this.form = form; }
    get(key) { return this.form.fields.has(key) ? this.form.fields.get(key) : null; }
  }
  const sandbox = {
    document,
    window: { jarvis: bridge },
    FormData,
    CustomEvent,
    console: { warn() {} },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
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

test('подключённый сервис показывает имя, действия, протокол и состояние', async () => {
  const bridge = { mcpState: async () => ({ servers: [connected] }) };
  const { ids } = makeSandbox(bridge);
  await wait();
  assert.equal(ids.mcpEmpty.hidden, true);
  assert.equal(ids.mcpList.children.length, 1);
  const row = ids.mcpList.children[0];
  const text = textOf(row);
  assert.match(text, /echo/);
  assert.match(text, /подключён/);
  assert.match(text, /Действия \(2\): Повтор, Сложить/);
  const nameNode = findAll(row, (node) => node.textContent === 'echo')[0];
  assert.match(nameNode.title, /Протокол MCP 2025-06-18/);
  assert.match(nameNode.title, /Сервер: echo-fixture 1.0.0/);
  assert.doesNotMatch(textOf(ids.mcpFormNote), /применятся после перезапуска/);
});

test('ошибка сервера видна причиной и кнопкой «Повторить», действия не показываются', async () => {
  const broken = { ...connected, status: 'error', error: 'программа не найдена: ENOENT', tools: [], toolCount: 0 };
  const bridge = { mcpState: async () => ({ servers: [broken] }) };
  const { ids } = makeSandbox(bridge);
  await wait();
  const text = textOf(ids.mcpList.children[0]);
  assert.match(text, /ошибка/);
  assert.match(text, /программа не найдена: ENOENT/);
  assert.doesNotMatch(text, /Действия \(/);
  const retry = findAll(ids.mcpList.children[0], (node) => node.textContent === 'Повторить');
  assert.equal(retry.length, 1);
  assert.equal((retry[0].listeners.click || []).length, 1);
});

test('переключатель выключает сервис и обновляет состояние без перезагрузки страницы', async () => {
  const switched = [{ ...connected, status: 'disabled', disabled: true, tools: [], toolCount: 0 }];
  const calls = [];
  const bridge = {
    mcpState: async () => ({ servers: [connected] }),
    mcpToggle: async (name, disabled) => { calls.push({ name, disabled }); return { ok: true, servers: switched }; },
  };
  const { ids } = makeSandbox(bridge);
  await wait();
  const switchNode = findAll(ids.mcpList.children[0], (node) => node.tagName === 'INPUT')[0];
  assert.equal(switchNode.checked, true);
  switchNode.checked = false;
  switchNode.fire('change');
  await wait();
  assert.deepEqual(calls, [{ name: 'echo', disabled: true }]);
  assert.match(textOf(ids.mcpList.children[0]), /выключен/);
  assert.equal(ids.mcpList.children[0].children.some((node) => node.textContent === 'Действия'), false);
});

test('добавление: успех, сохранение с ошибкой подключения и отказ — разные сообщения', async () => {
  const responses = [];
  let current = [];
  const bridge = {
    mcpState: async () => ({ servers: current }),
    mcpAdd: async () => responses.shift(),
  };
  const { ids, toasts } = makeSandbox(bridge);
  await wait();
  const form = ids.mcpForm;
  form.fields.set('name', 'echo');
  form.fields.set('target', 'node');
  form.fields.set('args', '');

  responses.push({ ok: true, servers: [connected] });
  form.fire('submit', { preventDefault() {} });
  await wait();
  assert.equal(ids.mcpList.children.length, 1);
  assert.ok(toasts.some((toast) => /Сервис подключён/.test(toast.text) && toast.kind === 'ok'));

  responses.push({ ok: true, servers: [], error: 'программа не найдена' });
  form.fire('submit', { preventDefault() {} });
  await wait();
  assert.ok(toasts.some((toast) => /Сервис сохранён, но не подключился: программа не найдена/.test(toast.text) && toast.kind === 'error'));

  responses.push({ ok: false, error: 'Такое название уже есть' });
  form.fire('submit', { preventDefault() {} });
  await wait();
  assert.ok(toasts.some((toast) => toast.text === 'Такое название уже есть' && toast.kind === 'error'));
});

test('старая сборка моста не ломает список: connected/disabled показываются по-прежнему', async () => {
  const bridge = {
    mcpState: async () => ({ servers: [
      { name: 'legacy', transport: 'stdio', target: 'npx.cmd', disabled: false, connected: false },
      { name: 'off', transport: 'http', target: 'https://example.com/mcp', disabled: true, connected: false },
    ] }),
  };
  const { ids } = makeSandbox(bridge);
  await wait();
  const rows = ids.mcpList.children.map(textOf);
  assert.match(rows[0], /подключится при запуске/);
  assert.match(rows[1], /выключен/);
});

test('вход в раздел запускает опрос состояния, чтобы сбой сервера стал виден без перезагрузки', async () => {
  let states = 0;
  const bridge = { mcpState: async () => { states += 1; return { servers: [connected] }; } };
  const { document, intervals, view } = makeSandbox(bridge, { viewHidden: true });
  await wait();
  assert.equal(states, 1, 'при загрузке страницы список всё равно прочитан');
  document.dispatchEvent({ type: 'jarvis:view', detail: 'mcp' });
  await wait();
  assert.equal(states, 2);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 3000);
  view.hidden = false;
  intervals[0].fn();
  await wait();
  assert.equal(states, 3, 'тик опроса обновляет состояние');
});
