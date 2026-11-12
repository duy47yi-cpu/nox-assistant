'use strict';

// renderer/nox-shell.js: общая шапка и история чата, на маленьком поддельном DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'nox-shell.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const SCREEN_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'nox-screen.js'), 'utf8');
const SCREEN_CSS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'nox-screen.css'), 'utf8');
const THEMES_CSS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'themes.css'), 'utf8');

function node(id, attrs = {}) {
  const listeners = {};
  const classes = new Set();
  const n = {
    id,
    hidden: Boolean(attrs.hidden),
    dataset: { ...(attrs.dataset || {}) },
    attrs: {},
    title: '',
    focused: false,
    classList: {
      toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { n.attrs[k] = String(v); },
    getAttribute: (k) => n.attrs[k],
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    fire(t, ev = {}) { for (const fn of listeners[t] || []) fn({ target: n, ...ev }); },
    focus() { n.focused = true; },
    closest: () => null,
  };
  return n;
}

function setup({ narrow = false, stored = null } = {}) {
  const byId = {
    noxGrid: node('noxGrid'),
    noxHistOpen: node('noxHistOpen', { hidden: true }),
    noxHistToggle: node('noxHistToggle'),
    noxHistSections: node('noxHistSections'),
    settingsDot: node('settingsDot', { hidden: true }),
    noxTopDot: node('noxTopDot', { hidden: true }),
  };
  const winButtons = ['minimize', 'maximize', 'close'].map((act) => node('', { dataset: { act } }));
  const docListeners = {};
  const winListeners = {};
  const store = new Map(stored === null ? [] : [['noxHistCollapsed', stored]]);
  const calls = [];
  const observers = [];
  const document = {
    readyState: 'complete',
    querySelector: (sel) => (sel.startsWith('#') ? byId[sel.slice(1)] || null : null),
    querySelectorAll: (sel) => (sel === '#noxTopbar [data-act]' ? winButtons : []),
    addEventListener(t, fn) { (docListeners[t] ||= []).push(fn); },
  };
  const window = {
    jarvis: { windowControl: async (a) => { calls.push(a); return { ok: true }; } },
    matchMedia: () => ({ matches: narrow, addEventListener() {} }),
    addEventListener(t, fn) { (winListeners[t] ||= []).push(fn); },
  };
  const sandbox = {
    window, document,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
  };
  vm.runInNewContext(SRC, sandbox);
  const key = (k) => { const ev = { key: k, stopped: false, stopPropagation() { ev.stopped = true; }, preventDefault() {} }; for (const fn of winListeners.keydown || []) fn(ev); return ev; };
  return { byId, winButtons, calls, store, observers, key };
}

test('кнопки шапки идут через window:control', () => {
  const env = setup();
  env.winButtons[2].fire('click');
  assert.deepEqual(env.calls, ['close']);
});

test('точка у настроек повторяет #settingsDot', () => {
  const env = setup();
  env.byId.settingsDot.hidden = false;
  for (const fn of env.observers) fn();
  assert.equal(env.byId.noxTopDot.hidden, false);
});

test('широкое окно: история сворачивается, открывается и запоминается', () => {
  const env = setup();
  assert.equal(env.byId.noxGrid.classList.contains('hist-off'), false);
  assert.equal(env.byId.noxHistOpen.hidden, true);
  env.byId.noxHistToggle.fire('click');
  assert.equal(env.byId.noxGrid.classList.contains('hist-off'), true);
  assert.equal(env.byId.noxHistOpen.hidden, false);
  assert.equal(env.store.get('noxHistCollapsed'), '1');
  env.byId.noxHistOpen.fire('click');
  assert.equal(env.byId.noxGrid.classList.contains('hist-off'), false);
  assert.equal(env.store.get('noxHistCollapsed'), '0');
});

test('широкое окно: свёрнутая история остаётся свёрнутой после перезапуска', () => {
  const env = setup({ stored: '1' });
  assert.equal(env.byId.noxGrid.classList.contains('hist-off'), true);
});

test('узкое окно: история скрыта, выезжает и закрывается Esc, не пропуская Esc дальше', () => {
  const env = setup({ narrow: true, stored: '0' });
  const grid = env.byId.noxGrid;
  assert.equal(grid.classList.contains('hist-off'), true);
  env.byId.noxHistOpen.fire('click');
  assert.equal(grid.classList.contains('hist-drawer'), true);
  assert.equal(grid.classList.contains('hist-off'), false);
  const esc = env.key('Escape');
  assert.equal(esc.stopped, true);
  assert.equal(grid.classList.contains('hist-drawer'), false);
  assert.equal(env.byId.noxHistOpen.focused, true);
  // История закрыта — Esc снова доходит до «стопа» хода.
  assert.equal(env.key('Escape').stopped, false);
  // Выбор в узком окне не меняет запомненное для широкого.
  assert.equal(env.store.get('noxHistCollapsed'), '0');
});

test('переход раздела вызывает перенос беседы только через одно событие', () => {
  const start = APP_SRC.indexOf('function show(view)');
  const show = APP_SRC.slice(start, APP_SRC.indexOf('// ── Виджеты', start));
  assert.ok(show, 'функция show(view) найдена');
  assert.doesNotMatch(show, /NoxScreen\.onView/, 'show() не вызывает перенос напрямую вдобавок к событию');
  assert.match(show, /dispatchEvent\(new CustomEvent\('jarvis:view'/);
  assert.match(SCREEN_SRC, /addEventListener\('jarvis:view', \(e\) => onView\(e\.detail\)\)/);
});

test('секундомер и поток ответа не запускают обход всех сообщений', () => {
  const start = SCREEN_SRC.indexOf('function tickWorking()');
  const tick = SCREEN_SRC.slice(start, SCREEN_SRC.indexOf('function finishWorking', start));
  assert.match(tick, /nodeValue/, 'время меняется в текстовом узле без childList-мутации');
  assert.match(SCREEN_SRC, /new MutationObserver\(\(records\) =>/);
  assert.match(SCREEN_SRC, /closest\('\.nox-working'\)/, 'служебная строка отфильтрована наблюдателем');
  assert.match(SCREEN_SRC, /needsCopy/, 'кнопки копирования проверяются только для новых ответов');
});

test('Nox не наследует старое стекло чата и анимацию всего раздела', () => {
  const convo = SCREEN_CSS.slice(SCREEN_CSS.indexOf('.view-nox .convo {'), SCREEN_CSS.indexOf('.view-nox .convo > .chat-tabs'));
  assert.match(convo, /backdrop-filter:\s*none\s*!important/);
  assert.doesNotMatch(THEMES_CSS, /^\.view:not\(\[hidden\]\)/m, 'глобальная анимация старого каркаса не действует на разделы Nox');
});

test('поздние ответы настроек не перезаписывают новый выбор', () => {
  assert.match(APP_SRC, /const settingRevisions = new Map\(\)/);
  assert.match(APP_SRC, /settingRevisions\.get\(key\) !== revision/);
  assert.match(APP_SRC, /const revisions = new Map\(settingRevisions\)/);
});
