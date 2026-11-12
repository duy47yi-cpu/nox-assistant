'use strict';

// Тесты интерфейса виджетов «Календарь» и «Встречи» в renderer/desks.js без Electron:
// проверяем реальные данные из src/desks/data.js + С3 через минимальный DOM и vm,
// состояния loading, not_connected, ok, empty, stale, error, пересечения, источник и подключение.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const deskData = require('../src/desks/data');
const { WIDGET_TYPES } = require('../src/desks/templates');

const DESKS_JS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'desks.js'), 'utf8');

class FakeClassList {
  constructor(node) { this.node = node; }
  _items() { return String(this.node.className || '').split(/\s+/).filter(Boolean); }
  add(name) {
    const items = this._items();
    if (!items.includes(name)) {
      items.push(name);
      this.node.className = items.join(' ');
    }
  }
  remove(name) {
    this.node.className = this._items().filter((item) => item !== name).join(' ');
  }
  contains(name) { return this._items().includes(name); }
}

class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = {};
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.open = false;
    this.style = {
      map: {},
      setProperty(k, v) { this.map[k] = String(v); },
      getPropertyValue(k) { return this.map[k] || ''; },
    };
    this.dataset = {};
    this.focusCount = 0;
    this.classList = new FakeClassList(this);
  }
  get className() { return this.attributes.class || ''; }
  set className(v) { this.attributes.class = String(v || ''); }
  get textContent() {
    if (!this.children.length) return this._text;
    return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v) {
    this.children = [];
    this._text = v == null ? '' : String(v);
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'hidden') this.hidden = true;
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  removeAttribute(k) {
    delete this.attributes[k];
    if (k === 'hidden') this.hidden = false;
  }
  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }
  appendChild(child) {
    if (!child) return child;
    if (typeof child !== 'string') child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node !== null && node !== undefined && node !== false) this.appendChild(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  focus() { this.focusCount += 1; }
  closest(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    let cur = this;
    while (cur) {
      if (cls && cur.classList && cur.classList.contains(cls)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  _matches(sel) {
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (attrMatch) {
      const val = this.getAttribute(attrMatch[1]);
      return attrMatch[2] !== undefined ? val === attrMatch[2] : val !== null;
    }
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }
  querySelectorAll(sel) {
    const out = [];
    const visit = (node) => {
      for (const ch of node.children) {
        if (typeof ch === 'string') continue;
        if (ch._matches(sel)) out.push(ch);
        visit(ch);
      }
    };
    visit(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  click() {
    if (this.disabled) return;
    return this.dispatch('click');
  }
  async dispatch(type, extra = {}) {
    const list = this.listeners[type] || [];
    let res;
    for (const fn of list) {
      res = await fn({
        target: this,
        currentTarget: this,
        preventDefault() {},
        stopPropagation() {},
        ...extra,
      });
    }
    return res;
  }
}

function createHarness(bridgeImpl) {
  const byId = new Map();
  const doc = {
    listeners: {},
    createElement(tag) { return new FakeNode(tag, doc); },
    createTextNode(text) { return String(text); },
    querySelector(sel) {
      if (sel.startsWith('#')) return byId.get(sel.slice(1)) || null;
      return root.querySelector(sel);
    },
    querySelectorAll(sel) { return root.querySelectorAll(sel); },
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
  };

  const root = new FakeNode('section', doc);
  root.classList.add('view-dialog');

  const ids = [
    'deskPage', 'deskTabs', 'deskGrid', 'deskEmpty', 'deskNote', 'deskAddRow',
    'deskOpen', 'deskClose', 'deskAdd', 'deskRename', 'deskDelete', 'deskRefresh',
    'deskDialog', 'deskForm', 'deskName', 'deskTemplate', 'deskSave', 'deskCancel', 'deskError', 'deskDialogTitle',
  ];
  for (const id of ids) {
    const node = new FakeNode(id === 'deskForm' ? 'form' : (id === 'deskPage' ? 'div' : 'div'), doc);
    node.id = id;
    if (id === 'deskPage') node.hidden = true;
    byId.set(id, node);
    root.appendChild(node);
  }

  const UI = {
    icon(name) {
      const span = doc.createElement('span');
      span.setAttribute('data-icon', name);
      return span;
    },
    fillIcons() {},
    el(tag, attrs, ...children) {
      const node = doc.createElement(tag);
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (v === undefined || v === null || v === false) continue;
          if (k === 'class') node.className = v;
          else if (k === 'text') node.textContent = v;
          else if (k === 'style') {
            for (const part of String(v).split(';')) {
              const idx = part.indexOf(':');
              if (idx > 0) node.style.setProperty(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
            }
          } else if (k.startsWith('on') && typeof v === 'function') {
            node.addEventListener(k.slice(2), v);
          } else if (v === true) {
            node.setAttribute(k, '');
          } else {
            node.setAttribute(k, String(v));
          }
        }
      }
      for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? c : c);
      }
      return node;
    },
    has: (name) => Boolean(bridgeImpl && typeof bridgeImpl[name] === 'function'),
    call: (name, ...args) => bridgeImpl[name](...args),
  };

  const toasts = [];
  const windowObj = {
    JarvisUI: UI,
    jarvis: bridgeImpl,
    matchMedia: () => ({ matches: false }),
  };

  const ctx = {
    window: windowObj,
    document: doc,
    Node: FakeNode,
    getComputedStyle: () => ({ gridTemplateColumns: 'repeat(12, 1fr)', columnGap: '8px', rowGap: '8px', paddingLeft: '0px', paddingTop: '0px' }),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    Date,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    Math,
    Boolean,
    Promise,
    Error,
  };
  vm.runInNewContext(DESKS_JS, ctx);
  windowObj.JarvisDesks.init({ toast: (msg, level) => toasts.push({ msg, level }), ask: async () => true });

  return {
    desks: windowObj.JarvisDesks,
    byId,
    root,
    toasts,
  };
}

function makeDeskWithWidgets() {
  return {
    id: 'd-main',
    name: 'Календарный',
    template: 'empty',
    version: 1,
    widgets: [
      { id: 'w-cal', type: 'calendar', version: 1, x: 1, y: 1, w: 6, h: 4, config: {} },
      { id: 'w-meet', type: 'meetings', version: 1, x: 7, y: 1, w: 6, h: 4, config: {} },
    ],
  };
}

test('renderer/desks.js: loading -> ok (данные, источник, локальное время, пересечения) -> disconnected -> connect -> empty -> stale -> error', async () => {
  const now = Date.parse('2026-11-12T07:30:00Z'); // 10:30 MSK
  const desk = makeDeskWithWidgets();
  let resolveInitial;
  let callCount = 0;
  const setSourceCalls = [];
  let pickFileCalls = 0;

  const calendarSnapshot = {
    connected: true,
    source: 'Рабочий календарь',
    fetchedAt: now - 4 * 60 * 1000,
    items: [
      {
        id: 'm1',
        title: 'Дизайн-ревью',
        startAt: '2026-11-12T07:00:00Z', // 10:00-11:30 MSK (ongoing)
        endAt: '2026-11-12T08:30:00Z',
        location: 'Комната 4',
        source: 'Яндекс Календарь',
      },
      {
        id: 'm2',
        title: 'Синхронизация команды',
        startAt: '2026-11-12T08:00:00Z', // 11:00-12:00 MSK (конфликт 30 мин)
        endAt: '2026-11-12T09:00:00Z',
        source: 'Google Calendar',
      },
    ],
  };

  let currentResponse = null;

  const harness = createHarness({
    desksState: () => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveInitial = resolve; });
      }
      return Promise.resolve(currentResponse);
    },
    calendarPickFile: async () => {
      pickFileCalls += 1;
      return { ok: true, canceled: false };
    },
    calendarSetSource: async (payload) => {
      setSourceCalls.push(payload);
      if (payload && payload.url && payload.url.includes('bad.example')) {
        return { ok: false, error: 'Не удалось прочитать адрес' };
      }
      return { ok: true };
    },
  });

  // 1. Состояние загрузки до ответа desksState
  harness.desks.open();
  const grid = harness.byId.get('deskGrid');
  assert.equal(grid.getAttribute('aria-busy'), 'true');
  assert.match(grid.textContent, /Загружаем виджеты и календарь/);

  // 2. Состояние ok с данными от С3
  const okData = deskData.buildDeskData(desk, { calendar: calendarSnapshot }, { now, timeZone: 'Europe/Moscow' });
  resolveInitial({
    ok: true,
    desks: [desk],
    activeId: desk.id,
    templates: [],
    types: WIDGET_TYPES,
    data: okData,
    now,
  });
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(grid.getAttribute('aria-busy'), 'false');
  const addCalBtn = harness.byId.get('deskAddRow').querySelector('[data-widget-type="calendar"]');
  const addMeetBtn = harness.byId.get('deskAddRow').querySelector('[data-widget-type="meetings"]');
  assert.ok(addCalBtn && addCalBtn.textContent.includes('Календарь'));
  assert.ok(addMeetBtn && addMeetBtn.textContent.includes('Встречи'));

  const calWidget = grid.querySelector('[data-widget="w-cal"]');
  const meetWidget = grid.querySelector('[data-widget="w-meet"]');
  assert.ok(calWidget && meetWidget);
  assert.match(calWidget.textContent, /Europe\/Moscow/);
  assert.match(calWidget.textContent, /Сегодня · 12 нояб\./);
  assert.match(calWidget.textContent, /10:00–11:30/);
  assert.match(calWidget.textContent, /Яндекс Календарь/);
  assert.match(calWidget.textContent, /Google Calendar/);
  assert.match(calWidget.textContent, /Пересечения: 1/);
  assert.ok(calWidget.querySelector('.is-conflict'));

  assert.match(meetWidget.textContent, /Дизайн-ревью/);
  assert.match(meetWidget.textContent, /идёт сейчас/);
  assert.match(meetWidget.textContent, /11:00–12:00/);
  assert.match(meetWidget.textContent, /Источник: Google Calendar/);
  assert.match(meetWidget.textContent, /пересечение/);
  assert.ok(meetWidget.querySelector('.desk-pill-conflict'));

  // Клик по «Отключить» вызывает calendarSetSource(null) и обновляет стол
  currentResponse = {
    ok: true,
    desks: [desk],
    activeId: desk.id,
    templates: [],
    types: WIDGET_TYPES,
    data: deskData.buildDeskData(desk, { calendar: null }, { now, timeZone: 'Europe/Moscow' }),
    now,
  };
  await calWidget.querySelector('.desk-cal-clear').click();
  assert.equal(setSourceCalls[0], null);

  // 3. Состояние not_connected + подключение файла и ссылки
  const calDisconnected = grid.querySelector('[data-widget="w-cal"]');
  const meetDisconnected = grid.querySelector('[data-widget="w-meet"]');
  assert.match(calDisconnected.textContent, /Календарь не подключён/);
  assert.match(calDisconnected.textContent, /Подключить \.ics\/\.json/);
  assert.match(meetDisconnected.textContent, /Источник встреч не подключён/);

  await calDisconnected.querySelector('.desk-cal-pick').click();
  assert.equal(pickFileCalls, 1);

  const urlToggle = grid.querySelector('[data-widget="w-meet"]').querySelector('.desk-cal-url-btn');
  await urlToggle.click();
  const urlForm = grid.querySelector('[data-widget="w-meet"]').querySelector('.desk-cal-url-form');
  assert.equal(urlForm.hidden, false);
  const urlInput = urlForm.querySelector('.desk-cal-url-input');

  // Пустая форма -> понятная подсказка
  await urlForm.dispatch('submit');
  assert.equal(urlForm.querySelector('.desk-cal-url-err').hidden, false);
  assert.match(urlForm.querySelector('.desk-cal-url-err').textContent, /Укажите адрес ленты/);

  // Рабочая ссылка -> calendarSetSource({ type: 'url', url })
  urlInput.value = 'https://calendar.example.com/team.ics';
  await urlForm.dispatch('submit');
  assert.deepEqual({ ...setSourceCalls[1] }, { type: 'url', url: 'https://calendar.example.com/team.ics' });

  // 4. Состояние empty (источник подключён, событий нет / нет предстоящих встреч)
  currentResponse = {
    ok: true,
    desks: [desk],
    activeId: desk.id,
    templates: [],
    types: WIDGET_TYPES,
    data: {
      'w-cal': deskData.calendar({ connected: true, source: 'Яндекс', items: [] }, { now, timeZone: 'Europe/Moscow' }),
      'w-meet': deskData.meetings({
        connected: true,
        source: 'Яндекс',
        items: [{ id: 'old-1', title: 'Вчерашний звонок', startAt: '2026-11-11T08:00:00Z', endAt: '2026-11-11T09:00:00Z' }],
      }, { now, timeZone: 'Europe/Moscow' }),
    },
    now,
  };
  await harness.desks.refresh();
  assert.match(grid.querySelector('[data-widget="w-cal"]').textContent, /Событий в календаре нет/);
  assert.match(grid.querySelector('[data-widget="w-meet"]').textContent, /На ближайшие 7 дн\. встреч нет/);
  assert.match(grid.querySelector('[data-widget="w-meet"]').textContent, /В календаре есть ещё 1/);

  // 5. Состояние stale (устаревшие данные)
  currentResponse = {
    ok: true,
    desks: [desk],
    activeId: desk.id,
    templates: [],
    types: WIDGET_TYPES,
    data: deskData.buildDeskData(desk, {
      calendar: { ...calendarSnapshot, fetchedAt: now - 4 * 60 * 60 * 1000 },
    }, { now, timeZone: 'Europe/Moscow' }),
    now,
  };
  await harness.desks.refresh();
  assert.match(grid.querySelector('[data-widget="w-cal"]').textContent, /устарело/);
  assert.match(grid.querySelector('[data-widget="w-meet"]').textContent, /устарело/);
  assert.match(grid.querySelector('[data-widget="w-meet"]').textContent, /Дизайн-ревью/);

  // 6. Состояние error
  currentResponse = {
    ok: true,
    desks: [desk],
    activeId: desk.id,
    templates: [],
    types: WIDGET_TYPES,
    data: {
      'w-cal': deskData.calendar({ connected: true, ok: false, source: 'Файл', reason: 'bad_ics' }, { now, timeZone: 'Europe/Moscow' }),
      'w-meet': deskData.meetings({ connected: true, ok: false, source: 'Файл', reason: 'not_found' }, { now, timeZone: 'Europe/Moscow' }),
    },
    now,
  };
  await harness.desks.refresh();
  assert.match(grid.querySelector('[data-widget="w-cal"]').textContent, /файл календаря не удалось разобрать/);
  assert.match(grid.querySelector('[data-widget="w-meet"]').textContent, /файл календаря не найден/);
  assert.doesNotMatch(grid.querySelector('[data-widget="w-meet"]').textContent, /загрузок/);

  // 7. Явное состояние loading внутри виджета
  currentResponse = {
    ok: true,
    desks: [desk],
    activeId: desk.id,
    templates: [],
    types: WIDGET_TYPES,
    data: {
      'w-cal': { type: 'calendar', state: 'loading', value: null, error: null },
      'w-meet': { type: 'meetings', state: 'loading', value: null, error: null },
    },
    now,
  };
  await harness.desks.refresh();
  assert.match(grid.querySelector('[data-widget="w-cal"]').textContent, /Загружаем события календаря/);
  assert.match(grid.querySelector('[data-widget="w-meet"]').textContent, /Загружаем ближайшие встречи/);
});
