'use strict';

// «Настройки» без Electron: навигация/поиск/чипы (settings-nav.js), карточки модели и сферы
// (nox-settings.js) в песочнице с маленьким DOM, плюс статические контракты разметки:
// ни одна прежняя настройка не потеряна, новые поля ядра на месте.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RENDERER = path.join(__dirname, '..', 'renderer');
const read = (file) => fs.readFileSync(path.join(RENDERER, file), 'utf8');
const NAV_SOURCE = read('settings-nav.js');
const SETTINGS_SOURCE = read('nox-settings.js');

// ── крошечный DOM: только то, что используют два модуля ─────────────────────

const kebab = (key) => String(key).replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());

function parseCompound(text) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  let rest = String(text || '').trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) {
    out.tag = tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  const re = /(?:\.([\w-]+))|(?:#([\w-]+))|(?:\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\])/g;
  let m;
  while ((m = re.exec(rest))) {
    if (m[1]) out.classes.push(m[1]);
    else if (m[2]) out.id = m[2];
    else out.attrs.push([m[3], m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : m[6]]);
  }
  return out;
}

function matchCompound(node, compound) {
  if (!node || typeof node === 'string') return false;
  if (compound.tag && node.tagName.toLowerCase() !== compound.tag) return false;
  if (compound.id && node.getAttribute('id') !== compound.id) return false;
  for (const name of compound.classes) if (!node.classList.contains(name)) return false;
  for (const [name, expected] of compound.attrs) {
    const actual = node.getAttribute(name);
    if (actual === null) return false;
    if (expected !== undefined && actual !== expected) return false;
  }
  return true;
}

function descendants(root, out = []) {
  for (const kid of root.children || []) {
    if (!kid || typeof kid === 'string') continue;
    out.push(kid);
    descendants(kid, out);
  }
  return out;
}

function splitGroups(selector) {
  return String(selector).split(',').map((part) => part.trim()).filter(Boolean);
}

function queryAll(root, selector) {
  const found = [];
  const seen = new Set();
  const push = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    found.push(node);
  };
  for (const group of splitGroups(selector)) {
    const direct = /^:scope\s*>\s*/.test(group);
    const body = direct ? group.replace(/^:scope\s*>\s*/, '') : group;
    const parts = body.split(/\s+/).filter(Boolean).map(parseCompound);
    if (!parts.length) continue;
    if (direct) {
      for (const kid of root.children || []) {
        if (matchCompound(kid, parts[0])) push(kid);
      }
      continue;
    }
    for (const node of descendants(root)) {
      // Последняя часть — сам узел, предыдущие — ближайшие предки в порядке селектора.
      if (!matchCompound(node, parts[parts.length - 1])) continue;
      let current = node.parent || null;
      let ok = true;
      for (let i = parts.length - 2; i >= 0; i -= 1) {
        let ancestor = current;
        while (ancestor && !matchCompound(ancestor, parts[i])) ancestor = ancestor.parent || null;
        if (!ancestor) { ok = false; break; }
        current = ancestor.parent || null;
      }
      if (ok) push(node);
    }
  }
  return found;
}

class FakeClassList {
  constructor(node) { this.node = node; }

  _items() {
    return String(this.node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }

  _write(items) {
    this.node.setAttribute('class', items.join(' '));
  }

  add(...names) {
    const items = this._items();
    for (const name of names) if (!items.includes(name)) items.push(name);
    this._write(items);
  }

  remove(...names) {
    this._write(this._items().filter((item) => !names.includes(item)));
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
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.type = '';
    this.title = '';
    this.open = false;
    this.parent = null;
    this.style = {};
    this.scrollTop = 0;
    this.focusCount = 0;
    this._top = 1000;
    this.classList = new FakeClassList(this);
    this.dataset = new Proxy({}, {
      get: (_target, key) => {
        const value = this.getAttribute('data-' + kebab(String(key)));
        return value === null ? undefined : value;
      },
      set: (_target, key, value) => {
        this.setAttribute('data-' + kebab(String(key)), String(value));
        return true;
      },
      deleteProperty: (_target, key) => {
        this.removeAttribute('data-' + kebab(String(key)));
        return true;
      },
    });
  }

  get id() { return this.getAttribute('id') || ''; }

  set id(value) { this.setAttribute('id', String(value)); }

  get className() { return this.getAttribute('class') || ''; }

  set className(value) { this.setAttribute('class', String(value)); }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  hasAttribute(name) {
    return name in this.attributes;
  }

  append(...kids) {
    for (const kid of kids) {
      if (kid === undefined || kid === null) continue;
      if (typeof kid === 'object' && kid.parent) {
        kid.parent.children = kid.parent.children.filter((item) => item !== kid);
      }
      if (typeof kid === 'object') kid.parent = this;
      this.children.push(kid);
    }
  }

  appendChild(kid) {
    this.append(kid);
    return kid;
  }

  replaceChildren(...kids) {
    for (const kid of this.children) if (kid && typeof kid === 'object') kid.parent = null;
    this.children = [];
    this.append(...kids);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((item) => item !== this);
    this.parent = null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  fire(type, event = {}) {
    for (const fn of [...(this.listeners[type] || [])]) fn(event);
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] || null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  closest(selector) {
    const groups = splitGroups(selector).map(parseCompound);
    let node = this;
    while (node) {
      if (groups.some((compound) => matchCompound(node, compound))) return node;
      node = node.parent || null;
    }
    return null;
  }

  focus() { this.focusCount += 1; }

  blur() {}

  scrollTo({ top } = {}) { this.scrollTop = Number(top) || 0; }

  getBoundingClientRect() {
    return { top: this._top, left: 0, width: 0, height: 0 };
  }
}

function findById(root, id) {
  for (const node of [root, ...descendants(root)]) {
    if (node.getAttribute && node.getAttribute('id') === id) return node;
  }
  return null;
}

function makeDocument() {
  const html = new FakeNode('html');
  const body = new FakeNode('body');
  html.append(body);
  const listeners = {};
  const document = {
    readyState: 'complete',
    documentElement: html,
    body,
    head: { append() {} },
    createElement: (tag) => new FakeNode(tag),
    getElementById: (id) => findById(html, id),
    querySelector: (selector) => queryAll(html, selector)[0] || null,
    querySelectorAll: (selector) => queryAll(html, selector),
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((item) => item !== fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners[event.type] || []) fn(event);
      return true;
    },
  };
  return { document, html, body, listeners };
}

const node = (tag, attrs = {}, ...children) => {
  const result = new FakeNode(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) result.setAttribute(name, String(value));
  }
  if (Object.prototype.hasOwnProperty.call(attrs, 'hidden') && attrs.hidden !== undefined) result.hidden = true;
  for (const child of children.flat()) result.append(child);
  return result;
};

const textOf = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  let out = value.textContent ? value.textContent : '';
  for (const kid of value.children || []) out += textOf(kid);
  return out;
};

const withId = (tag, id, attrs = {}) => node(tag, { ...attrs, id });
const withText = (nodeValue, text) => {
  nodeValue.textContent = text;
  return nodeValue;
};

// ── settings-nav.js: навигация, поиск и чипы ───────────────────────────────

const NAV_SECTIONS = [
  ['settings-ai', 'ai', 'ИИ и провайдеры', ['Модель', 'Мышление']],
  ['settings-mode', 'security', 'Режим доступа', ['Полный доступ']],
  ['mailSettings', 'security', 'Почта Gmail', ['Подключение']],
  ['answers', 'voice', 'Ответы', ['Громкость голоса', 'Скорость речи']],
  ['window', 'general', 'Окно и уведомления', ['Тихий режим']],
  ['memorySettings', 'voice', 'Память', ['Что Джарвис помнит о вас и о работе.']],
  ['remindersSettings', 'voice', 'Напоминания', ['Ближайшие напоминания этого пространства.']],
  ['extensionsSettings', 'security', 'Расширения', ['История буфера']],
  ['look', 'look', 'Вид', ['Тема', 'Шрифт интерфейса']],
  ['settings-sphere', 'sphere', 'Сфера Nox — предпросмотр', ['Вид сферы', 'Размер']],
  ['folder', 'general', 'Рабочая папка', ['Подключённые папки']],
  ['settings-model', 'ai', 'Модель и связь', ['Проверить снова']],
  ['chat', 'general', 'Разговор', ['Очистить переписку']],
];

function makeNavDom() {
  const { document, body } = makeDocument();
  const view = node('section', { class: 'view view-settings' });
  const nav = withId('aside', 'setNav');
  const searchWrap = node('div');
  const search = withId('input', 'setSearch');
  searchWrap.append(search);
  const chips = withId('div', 'setChips', { role: 'group' });
  const chipsButtons = [['all', 'Все'], ['ai', 'ИИ'], ['look', 'Вид'], ['voice', 'Голос']].map(([id, text]) => {
    const button = node('button', { class: 'nox-chip-filter', 'data-set-chip': id });
    button.textContent = text;
    chips.append(button);
    return button;
  });
  const list = withId('ul', 'setNavList');
  nav.append(searchWrap, chips, withId('p', 'setNavHead'), list);
  const main = withId('div', 'setMain');
  main._top = 0;
  const page = withId('div', 'settingsPage', { class: 'page settings' });
  const noMatches = withId('p', 'setNoMatches', { class: 'nox-set-empty is-hidden' });
  main.append(page, noMatches);
  view.append(nav, main);
  body.append(view);

  const sections = NAV_SECTIONS.map(([id, cat, title, rows]) => {
    const section = node('section', { class: 'set-section', id, 'data-cat': cat });
    section.append(withText(node('h2', { class: 'set-title' }), title));
    for (const rowText of rows) {
      const row = node('label', { class: 'set-row' });
      row.append(withText(node('span', { class: 'set-name' }), rowText));
      section.append(row);
    }
    page.append(section);
    return section;
  });
  return { document, body, view, nav, search, chips, chipsButtons, list, main, page, noMatches, sections };
}

function runNav(dom) {
  const window = { matchMedia: () => ({ matches: false }) };
  const sandbox = {
    document: dom.document,
    window,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    console: { warn() {} },
  };
  vm.runInNewContext(NAV_SOURCE, sandbox, { filename: 'settings-nav.js' });
  return window.NoxSettingsNav;
}

const catOfPage = (page) => page.children.map((section) => section.dataset.cat);
const visibleSections = (dom) => dom.sections.filter((section) => !section.classList.contains('set-cat-hidden'));
const navButtons = (dom) => dom.list.children.map((li) => li.children[0]);

test('навигация: шесть категорий в утверждённом порядке, первая активна', () => {
  const dom = makeNavDom();
  const api = runNav(dom);
  const buttons = navButtons(dom);
  assert.deepEqual(buttons.map((b) => b.dataset.cat), ['general', 'ai', 'voice', 'look', 'sphere', 'security']);
  assert.deepEqual(buttons.map((b) => textOf(b)), ['Общие', 'ИИ и провайдеры', 'Голос и память', 'Внешний вид', 'Сфера Nox', 'Безопасность']);
  assert.equal(buttons[0].getAttribute('aria-current'), 'true');
  assert.equal(buttons.slice(1).some((b) => b.getAttribute('aria-current') === 'true'), false);
  // Карточки разложены по порядку категорий, внутри категории — как были.
  const cats = catOfPage(dom.page);
  assert.deepEqual(cats, ['general', 'general', 'general', 'ai', 'ai', 'voice', 'voice', 'voice', 'look', 'sphere', 'security', 'security', 'security']);
  assert.equal(api.getState().q, '');
  assert.equal(api.getState().chip, 'all');
});

test('поиск: прячет неподходящие карточки и строки, «ничего не найдено» честно', () => {
  const dom = makeNavDom();
  runNav(dom);
  dom.search.value = 'громкость';
  dom.search.fire('input');
  const answers = dom.sections.find((section) => section.querySelector('.set-title').textContent === 'Ответы');
  assert.equal(answers.classList.contains('set-cat-hidden'), false, 'карточка со совпадением видна');
  const rows = answers.children.filter((child) => child.classList.contains('set-row'));
  assert.equal(rows[0].classList.contains('set-filtered'), false, 'строка «Громкость голоса» видна');
  assert.equal(rows[1].classList.contains('set-filtered'), true, 'строка «Скорость речи» отфильтрована');
  const look = dom.sections.find((section) => section.dataset.cat === 'look');
  assert.equal(look.classList.contains('set-cat-hidden'), true);
  assert.equal(dom.noMatches.classList.contains('is-hidden'), true);

  dom.search.value = '';
  dom.search.fire('input');
  assert.equal(visibleSections(dom).length, 13, 'пустой запрос возвращает все карточки');
  assert.equal(dom.page.querySelectorAll('.set-filtered').length, 0);
});

test('поиск: без совпадений показывает пустое состояние', () => {
  const dom = makeNavDom();
  runNav(dom);
  dom.search.value = 'такого-слова-точно-нет';
  dom.search.fire('input');
  assert.equal(visibleSections(dom).length, 0);
  assert.equal(dom.noMatches.classList.contains('is-hidden'), false);
});

test('чипы: ИИ, Вид (вид+сфера), Голос и Все', () => {
  const dom = makeNavDom();
  runNav(dom);
  const click = (chip) => dom.chips.fire('click', { target: chip });
  const chipOf = (id) => dom.chipsButtons.find((button) => button.dataset.setChip === id);

  click(chipOf('ai'));
  assert.deepEqual(visibleSections(dom).map((section) => section.dataset.cat), ['ai', 'ai']);
  assert.equal(chipOf('ai').getAttribute('aria-pressed'), 'true');
  assert.equal(chipOf('all').getAttribute('aria-pressed'), 'false');

  click(chipOf('look'));
  assert.deepEqual(visibleSections(dom).map((section) => section.dataset.cat), ['look', 'sphere']);

  click(chipOf('voice'));
  assert.deepEqual(visibleSections(dom).map((section) => section.dataset.cat), ['voice', 'voice', 'voice']);

  click(chipOf('all'));
  assert.equal(visibleSections(dom).length, 13);
  assert.equal(dom.noMatches.classList.contains('is-hidden'), true);
});

test('Escape очищает поиск, клик по категории сбрасывает фильтры', () => {
  const dom = makeNavDom();
  runNav(dom);
  dom.search.value = 'громкость';
  dom.search.fire('input');
  dom.search.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(dom.search.value, '');
  assert.equal(visibleSections(dom).length, 13);
  assert.equal(dom.noMatches.classList.contains('is-hidden'), true);

  // Клик по категории сбрасывает поиск и подсвечивает категорию.
  dom.search.value = 'громкость';
  dom.search.fire('input');
  const voiceButton = navButtons(dom).find((b) => b.dataset.cat === 'voice');
  voiceButton.fire('click');
  assert.equal(dom.search.value, '');
  assert.equal(voiceButton.getAttribute('aria-current'), 'true');
  assert.equal(typeof dom.main.scrollTop, 'number');
});

// ── nox-settings.js: карточки модели и сферы ──────────────────────────────

function makeSettingsDom({ bridge, withScreen = true, getSettings, setTimeoutImpl } = {}) {
  const { document, body } = makeDocument();
  const view = node('section', { class: 'view view-settings' });
  const header = node('header', { class: 'nox-set-head' });
  const controls = node('div', { class: 'nox-win-controls' });
  const winButtons = ['minimize', 'maximize', 'close'].map((act) => {
    const button = node('button', { class: 'nox-win-btn', 'data-act': act });
    controls.append(button);
    return button;
  });
  header.append(withId('div', 'setStatus', { class: 'nox-set-status' }), controls);
  const main = withId('div', 'setMain');
  const errorBox = withId('p', 'setError', { hidden: '' });
  errorBox.append(withId('span', 'setErrorText'));
  main.append(errorBox);

  const tier = withId('select', 'setModelTier');
  tier.append(node('option', { value: 'fast' }), node('option', { value: 'smart' }));
  tier.value = 'fast';
  const thinking = withId('select', 'setThinking');
  thinking.append(node('option', { value: 'low' }), node('option', { value: 'medium' }), node('option', { value: 'high' }));
  thinking.value = 'low';
  const page = withId('div', 'settingsPage', { class: 'page settings' });
  page.append(
    node('section', { class: 'set-section', 'data-cat': 'ai' },
      node('div', { class: 'set-row' },
        withText(withId('span', 'setModelHint', { class: 'set-hint' }), 'Отвечает сразу. Подходит для команд и коротких вопросов.'),
        tier),
      node('div', { class: 'set-row' },
        withText(withId('span', 'setThinkingHint', { class: 'set-hint' }), 'Обычный расход лимита.'),
        thinking)),
  );

  const variantGroup = withId('div', 'sphereVariant', { role: 'radiogroup' });
  const wire = node('button', { class: 'seg-btn', role: 'radio', 'data-sphere-variant': 'wire', 'aria-checked': 'false' });
  const nox = node('button', { class: 'seg-btn', role: 'radio', 'data-sphere-variant': 'nox', 'aria-checked': 'true' });
  variantGroup.append(wire, nox);
  const size = withId('input', 'sphereSize', { type: 'range', min: '70', max: '120', step: '5', value: '100' });
  const glow = withId('input', 'sphereGlow', { type: 'range', min: '40', max: '160', step: '5', value: '100' });
  const sizeValue = withText(withId('span', 'sphereSizeValue'), '100 %');
  const glowValue = withText(withId('span', 'sphereGlowValue'), '100 %');
  const reset = withId('button', 'sphereReset');
  const apply = withId('button', 'sphereApply');
  apply.disabled = true;
  const canvas = withId('canvas', 'spherePreview');
  page.append(
    node('section', { class: 'set-section', 'data-cat': 'sphere' },
      node('div', { class: 'set-sphere-controls' },
        node('div', { class: 'set-row' }, variantGroup),
        node('div', { class: 'set-row' }, sizeValue, size),
        node('div', { class: 'set-row' }, glowValue, glow)),
      node('div', { class: 'set-sphere-foot' }, reset, apply),
      canvas),
  );
  main.append(page);
  view.append(header, main);
  body.append(view);
  body.dataset.view = 'settings';

  const storage = new Map();
  const calls = { model: [], thinking: [], window: [], variant: [], orbScales: [] };
  const tierEvents = [];
  const finalBridge = bridge || {
    getSettings: async () => (getSettings ? getSettings() : { modelTier: 'fast', thinking: 'low' }),
    setModelTier: async (tierValue) => { calls.model.push(tierValue); return { ok: true, tier: tierValue }; },
    setThinking: async (level) => { calls.thinking.push(level); return { ok: true, level }; },
    windowControl: async (action) => { calls.window.push(action); return { ok: true }; },
  };
  const window = {
    jarvis: finalBridge,
    matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1,
    NoxOrb: class {
      constructor(target, options) { this.options = options; this.scales = []; }
      setVariant(value) { this.variant = value; }
      setScale(value) { calls.orbScales.push(value); }
      destroy() {}
    },
  };
  if (withScreen) {
    window.NoxScreen = {
      getVariant: () => 'nox',
      setVariant: (value) => { calls.variant.push(value); return value; },
    };
  }
  class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const documentWithEvents = {
    ...document,
    addEventListener(type, fn) {
      if (!documentListeners[type]) documentListeners[type] = [];
      documentListeners[type].push(fn);
    },
    dispatchEvent(event) {
      for (const fn of documentListeners[event.type] || []) fn(event);
      return true;
    },
    getElementById: (id) => findById(body.parent || document.documentElement, id) || document.getElementById(id),
  };
  const documentListeners = {};
  const sandbox = {
    document: documentWithEvents,
    window,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    CustomEvent,
    Promise,
    setTimeout: setTimeoutImpl || setTimeout,
    clearTimeout,
    console: { warn() {}, error() {} },
  };
  vm.runInNewContext(SETTINGS_SOURCE, sandbox, { filename: 'nox-settings.js' });
  return { document: documentWithEvents, body, view, main, page, tier, thinking, variantGroup, wire, nox, size, glow, sizeValue, glowValue, reset, apply, canvas, wireCanvas: canvas, winButtons, storage, calls, tierEvents, sandbox, window };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

test('карточка ИИ: значения из ядра, модель и мышление сохраняются через мост', async () => {
  const env = makeSettingsDom();
  env.document.addEventListener('jarvis:tier', (event) => env.tierEvents.push(event.detail));
  await wait();
  assert.equal(env.tier.value, 'fast');
  assert.equal(env.thinking.value, 'low');
  assert.match(env.document.getElementById('setModelHint').textContent, /Отвечает сразу/);
  assert.match(env.document.getElementById('setThinkingHint').textContent, /Обычный расход/);
  assert.equal(env.document.getElementById('setStatus').textContent, '');
  assert.equal(env.main.getAttribute('data-loading'), null, 'загрузка снята');

  env.tier.value = 'smart';
  env.tier.fire('change');
  await wait();
  assert.deepEqual(env.calls.model, ['smart']);
  assert.match(env.document.getElementById('setModelHint').textContent, /Сильнее/);
  assert.equal(env.tierEvents.at(-1).tier, 'smart');
  assert.equal(env.tierEvents.at(-1).level, 'low');

  env.thinking.value = 'high';
  env.thinking.fire('change');
  await wait();
  assert.deepEqual(env.calls.thinking, ['high']);
  assert.match(env.document.getElementById('setThinkingHint').textContent, /2,5/);
  assert.equal(env.tierEvents.at(-1).tier, 'smart');
  assert.equal(env.tierEvents.at(-1).level, 'high');
});

test('карточка ИИ: отказ ядра виден строкой ошибки, поле снова активно', async () => {
  const bridge = {
    getSettings: async () => ({ modelTier: 'fast', thinking: 'low' }),
    setModelTier: async () => ({ ok: false, error: 'нельзя' }),
    setThinking: async () => ({ ok: true, level: 'high' }),
    windowControl: async () => ({ ok: true }),
  };
  const env = makeSettingsDom({ bridge });
  await wait();
  env.tier.value = 'smart';
  env.tier.fire('change');
  await wait();
  assert.equal(env.tier.disabled, false, 'после отказа select снова активен');
  assert.equal(env.document.getElementById('setError').hidden, false);
  assert.match(env.document.getElementById('setErrorText').textContent, /Модель не сохранена/);
});

test('карточка сферы: вариант Wire настоящий, ползунки — только превью', async () => {
  const env = makeSettingsDom();
  await wait();
  env.variantGroup.fire('click', { target: env.wire });
  assert.deepEqual(env.calls.variant, ['wire'], 'реальный вариант применён через NoxScreen');
  assert.equal(env.wire.getAttribute('aria-checked'), 'true');
  assert.equal(env.nox.getAttribute('aria-checked'), 'false');

  env.size.value = '80';
  env.size.fire('input');
  assert.equal(env.sizeValue.textContent, '80 %');
  assert.equal(env.apply.disabled, true, '«Применить» остаётся недоступной: превью не применяется');
  assert.deepEqual(JSON.parse(env.storage.get('jarvis.spherePreview')), { size: 80, glow: 100 });
  const lastScale = env.calls.orbScales.at(-1);
  assert.ok(Math.abs(lastScale - 0.62 * 0.8) < 1e-9, `масштаб превью ${lastScale}`);

  env.reset.fire('click');
  assert.equal(env.size.value, '100');
  assert.equal(env.sizeValue.textContent, '100 %');
  assert.deepEqual(JSON.parse(env.storage.get('jarvis.spherePreview')), { size: 100, glow: 100 });
});

test('карточка сферы: без NoxScreen вариант всё равно запоминается в localStorage', async () => {
  const env = makeSettingsDom({ withScreen: false });
  await wait();
  env.variantGroup.fire('click', { target: env.wire });
  assert.equal(env.storage.get('noxOrb'), 'wire');
});

test('чтение настроек: ошибка ядра видна строкой, а не молчанием', async () => {
  const bridge = {
    getSettings: async () => { throw new Error('ядро не ответило'); },
    setModelTier: async () => ({ ok: true }),
    setThinking: async () => ({ ok: true }),
    windowControl: async () => ({ ok: true }),
  };
  const env = makeSettingsDom({ bridge });
  await wait();
  assert.equal(env.document.getElementById('setStatus').textContent, 'Не удалось прочитать настройки');
  assert.equal(env.document.getElementById('setError').hidden, false);
  assert.match(env.document.getElementById('setErrorText').textContent, /Настройки не прочитаны: ядро не ответило/);
});

test('зависшее чтение настроек снимает загрузку по таймауту', async () => {
  const env = makeSettingsDom({
    getSettings: () => new Promise(() => {}),
    setTimeoutImpl: (fn) => { fn(); return 1; },
  });
  await wait();
  await wait();
  assert.equal(env.main.getAttribute('data-loading'), null);
  assert.equal(env.document.getElementById('setStatus').textContent, 'Не удалось прочитать настройки');
  assert.match(env.document.getElementById('setErrorText').textContent, /не ответило вовремя/);
});

test('загрузка не блокирует нажатия в остальных карточках настроек', () => {
  const css = read('nox-settings.css');
  assert.doesNotMatch(css, /#setMain\[data-loading="true"\]\s*\{[^}]*pointer-events:\s*none/);
});

// ── статические контракты: ничего из прежних настроек не потеряно ─────────

test('app.js и main.js: новые ключи terseReplies и keepAwake на месте', () => {
  const app = read('app.js');
  const keys = /const SETTING_KEYS = \[([^\]]+)\]/.exec(app);
  assert.ok(keys, 'SETTING_KEYS не найден');
  assert.match(keys[1], /'terseReplies'/, 'тумблер «Тише озвучивать очевидное» сохраняется');
  assert.match(app, /terseReplies: true/, 'включён по умолчанию, как в ядре');

  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('settings:get'");
  const end = main.indexOf("ipcMain.handle('settings:set'", start);
  assert.ok(start >= 0 && end > start, 'обработчики settings:get/set не найдены');
  assert.match(main.slice(start, end), /keepAwake:/, 'окно получает режим сна из настроек');
});

test('model-pick.js слушает смену модели из Настроек', () => {
  assert.match(read('model-pick.js'), /addEventListener\('jarvis:tier'/);
  assert.match(read('nox-settings.js'), /dispatchEvent\(new CustomEvent\('jarvis:tier'/);
});

test('index.html: 15 карточек с категориями, новые карточки и прежние id на месте', () => {
  const html = read('index.html');
  const start = html.indexOf('class="view view-settings"');
  const end = html.indexOf('<!-- Подтверждение действия', start);
  assert.ok(start >= 0 && end > start, 'раздел настроек не найден');
  const view = html.slice(start, end);

  const sections = [...view.matchAll(/<section class="set-section"([^>]*)>/g)].map((match) => match[1]);
  assert.equal(sections.length, 15, 'карточек настроек');
  const cats = sections.map((attrs) => /data-cat="([a-z]+)"/.exec(attrs));
  assert.equal(cats.every(Boolean), true, 'у каждой карточки есть data-cat');
  const counts = {};
  for (const match of cats) counts[match[1]] = (counts[match[1]] || 0) + 1;
  assert.deepEqual(counts, { ai: 2, security: 3, voice: 4, general: 4, look: 1, sphere: 1 });
  assert.match(view, /<section[^>]+data-cat="voice"[^>]+id="notificationVoiceSettings"/);
  assert.match(view, /<section[^>]+data-cat="general"[^>]+id="restSettings"/);
  assert.equal((view.match(/class="set-title"/g) || []).length, 15, 'у каждой карточки есть заголовок');

  for (const id of ['setNav', 'setSearch', 'setChips', 'setNavList', 'setMain', 'settingsPage', 'setNoMatches', 'setStatus', 'setError', 'settings-ai', 'settings-sphere', 'setModelTier', 'setThinking', 'setModelHint', 'setThinkingHint', 'sphereVariant', 'sphereSize', 'sphereGlow', 'sphereReset', 'sphereApply', 'spherePreview']) {
    assert.ok(view.includes(`id="${id}"`), `id="${id}" потерян`);
  }
  assert.equal((view.match(/data-preview-only="true"/g) || []).length, 3, 'превью помечено честно');
  assert.match(view, /id="sphereApply"[^>]*disabled/, '«Применить» недоступна');
  assert.equal((view.match(/data-sphere-variant="/g) || []).length, 2);
  assert.equal((view.match(/data-theme-opt="/g) || []).length, 23, 'все темы на месте');
  assert.equal((view.match(/data-orb-opt="/g) || []).length, 3, 'все виды шара на месте');

  // Прежняя разметка — регрессионный страж «не удали настройку».
  const legacyIds = [
    'settings-mode', 'modeOptions', 'mailSettings', 'mailStatus', 'mailRead', 'mailConnect', 'mailDisconnect', 'mailDisconnectRow',
    'setAnswersTitle', 'voiceTest', 'voiceVolume', 'voiceVolumeHint', 'voiceRate', 'voiceRateHint', 'voiceSpeaker', 'voicePickHint',
    'voiceList', 'voicePersona', 'voicePersonaHint', 'voiceOptionsNote', 'setDictation', 'orbAnimHint', 'setKeepAwake',
    'memorySettings', 'memoryList', 'memoryCount', 'memoryEmpty', 'memoryNote', 'memoryReload', 'memoryClear',
    'remindersSettings', 'remindersList', 'remindersCount', 'remindersEmpty', 'remindersNote', 'remindersReload',
    'extensionsSettings', 'clipEnabled', 'clipTtl', 'clipPause', 'clipReload', 'clipClear', 'clipList', 'clipNote', 'clipEmpty',
    'snipForm', 'snipTrigger', 'snipText', 'snipSave', 'snipList', 'snipError', 'snipEmpty', 'dlAnalyze', 'dlRemove', 'dlNote', 'dlList',
    'setLookTitle', 'themeSeg', 'themeLabel', 'orbPick', 'orbPickLabel', 'openClassic',
    'setFolderTitle', 'workspacePath', 'workspaceOpen', 'folderAdd', 'folderList',
    'settings-model', 'brainState', 'brainStateText', 'brainModel', 'coreState', 'brainRecheck', 'brainHint',
    'setChatTitle', 'chatClear', 'chatClearText',
  ];
  const lost = legacyIds.filter((id) => !view.includes(`id="${id}"`));
  assert.deepEqual(lost, [], 'потерянные id настроек');

  const settings = [...view.matchAll(/data-setting="([a-zA-Z]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(settings, ['alwaysListen', 'alwaysOnTop', 'autoStart', 'desktopOverlay', 'dictation', 'memoryAuto', 'motion', 'quiet', 'restEnabled', 'screenAuto', 'terseReplies', 'voice'].sort());
  assert.ok(view.includes('data-local="orbAnim"'), 'настройка анимации шара на месте');

  assert.match(html, /href="nox-settings\.css"/, 'стиль Nox-настроек подключён');
  assert.match(html, /src="nox-settings\.js"/, 'модуль Nox-настроек подключён');
  assert.match(html, /src="settings-nav\.js"/, 'навигация настроек подключена');
});
