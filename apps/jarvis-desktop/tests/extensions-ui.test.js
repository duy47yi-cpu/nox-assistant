'use strict';

// Регрессионные тесты интерфейса «Расширений» (без Electron):
//  - единая модель «Уборки загрузок» без скрытого/конкурирующего «Освободить место»;
//  - чекбоксы по умолчанию сняты, удаление только явно выбранных файлов;
//  - точный список файлов в диалоге подтверждения, отмена, снятие отметок, пустой выбор;
//  - блокировка изменения списка между подтверждением и исполнением + повторная проверка при сдвиге;
//  - сохранение результата удаления после обновления списка;
//  - честные статусы истории буфера и синхронизация срока хранения (включая 7 дней и Бессрочно);
//  - отсутствие ложного обещания автосрабатывания фраз-триггеров.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createDownloadsSession } = require('../src/extensions/downloads-cleanup');

const RENDERER = path.join(__dirname, '..', 'renderer');
const EXT_SOURCE = fs.readFileSync(path.join(RENDERER, 'extensions.js'), 'utf8');
const HTML_SOURCE = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const APP_SOURCE = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

const NOW = Date.parse('2026-11-12T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function tempDownloadsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-ext-ui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFile(root, rel, { size = 16, ageDays = 0 } = {}) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(size, 5));
  const when = new Date(NOW - ageDays * DAY);
  fs.utimesSync(abs, when, when);
  return abs;
}

const kebab = (key) => String(key).replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());

class FakeClassList {
  constructor(node) { this.node = node; }
  _items() { return String(this.node.attributes.class || '').split(/\s+/).filter(Boolean); }
  _write(items) { this.node.attributes.class = items.join(' '); }
  add(...names) { const a = this._items(); for (const n of names) if (!a.includes(n)) a.push(n); this._write(a); }
  remove(...names) { this._write(this._items().filter((i) => !names.includes(i))); }
  contains(name) { return this._items().includes(name); }
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
    this.parent = null;
    this.classList = new FakeClassList(this);
    this.dataset = new Proxy({}, {
      get: (_t, key) => {
        const val = this.getAttribute('data-' + kebab(String(key)));
        return val === null ? undefined : val;
      },
      set: (_t, key, val) => { this.setAttribute('data-' + kebab(String(key)), String(val)); return true; },
      deleteProperty: (_t, key) => { this.removeAttribute('data-' + kebab(String(key))); return true; },
    });
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', String(v)); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', String(v)); }
  get type() { return this.getAttribute('type') || ''; }
  set type(v) { this.setAttribute('type', String(v)); }
  get options() { return this.tagName === 'SELECT' ? this.children.filter((c) => c.tagName === 'OPTION') : []; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...kids) {
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined) continue;
      if (typeof kid === 'object') {
        if (kid.parent) kid.parent.children = kid.parent.children.filter((x) => x !== kid);
        kid.parent = this;
        this.children.push(kid);
      }
    }
  }
  replaceChildren(...kids) {
    for (const k of this.children) if (k && typeof k === 'object') k.parent = null;
    this.children = [];
    this.append(...kids);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, event = {}) { for (const fn of [...(this.listeners[type] || [])]) fn(event); }
  focus() {}
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children || []) {
        if (matchSel(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function matchSel(node, sel) {
  if (!node || typeof node !== 'object') return false;
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  if (sel === 'input[type="checkbox"]:checked') return node.tagName === 'INPUT' && node.type === 'checkbox' && node.checked === true;
  if (sel === 'input[type="checkbox"]') return node.tagName === 'INPUT' && node.type === 'checkbox';
  return false;
}

const el = (tag, attrs = {}, ...kids) => {
  const n = new FakeNode(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = String(v);
    else if (k === 'hidden' && v) n.hidden = true;
    else if (k === 'disabled' && v) n.disabled = true;
    else if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  }
  n.append(...kids);
  return n;
};

function setupExtensionsEnv({ dir, settings = {}, clipState = {}, clipItems = [], askImpl, diskFreeResult } = {}) {
  const docRoot = el('div');
  const clipTtl = el('select', { id: 'clipTtl' },
    el('option', { value: '900000', text: '15 минут' }),
    el('option', { value: '3600000', text: '1 час' }),
    el('option', { value: '86400000', text: '1 день' }),
    el('option', { value: '604800000', text: '7 дней' }),
    el('option', { value: '', text: 'Бессрочно' }),
  );
  clipTtl.value = '900000';

  const extSection = el('section', { id: 'extensionsSettings' },
    el('span', { id: 'clipCount' }),
    el('span', { id: 'clipStatusHint', text: 'Выключено — история не ведётся' }),
    el('input', { id: 'clipEnabled', type: 'checkbox' }),
    clipTtl,
    el('button', { id: 'clipPause', type: 'button', text: 'Пауза' }),
    el('button', { id: 'clipReload', type: 'button', text: 'Обновить' }),
    el('button', { id: 'clipClear', type: 'button', text: 'Очистить' }),
    el('p', { id: 'clipNote', hidden: true }),
    el('ul', { id: 'clipList' }),
    el('p', { id: 'clipEmpty', hidden: true }),
    el('span', { id: 'snipCount' }),
    el('form', { id: 'snipForm' },
      el('input', { id: 'snipTrigger', type: 'text' }),
      el('textarea', { id: 'snipText' }),
      el('button', { id: 'snipSave', type: 'submit', text: 'Сохранить' })),
    el('p', { id: 'snipError', hidden: true }),
    el('ul', { id: 'snipList' }),
    el('p', { id: 'snipEmpty', hidden: true }),
    el('span', { id: 'dlCount' }),
    el('button', { id: 'dlAnalyze', type: 'button', text: 'Проверить загрузки' }),
    el('button', { id: 'dlRemove', type: 'button', text: 'Удалить выбранное', disabled: true }),
    el('p', { id: 'dlResult', hidden: true }),
    el('p', { id: 'dlNote', hidden: true }),
    el('div', { id: 'dlSelectBar', hidden: true },
      el('span', { id: 'dlSelection' }),
      el('button', { id: 'dlSelectAll', type: 'button' }),
      el('button', { id: 'dlSelectNone', type: 'button' })),
    el('ul', { id: 'dlList' }),
  );
  docRoot.append(extSection);

  const session = createDownloadsSession({ now: () => NOW });
  let currentSettings = { clipboardHistory: false, ...settings };
  let currentClipState = { ok: true, paused: false, ttlMs: 604800000, count: clipItems.length, ...clipState };
  const calls = [];
  const toasts = [];
  const asks = [];

  const api = {
    getSettings: async () => ({ ...currentSettings }),
    setSetting: async (k, v) => { currentSettings[k] = v; return { ok: true }; },
    clipboardHistoryState: async () => ({ ...currentClipState }),
    clipboardHistoryList: async () => ({ ok: true, items: clipItems }),
    clipboardHistoryPause: async () => { currentClipState.paused = true; return { ok: true, ...currentClipState }; },
    clipboardHistoryResume: async () => { currentClipState.paused = false; return { ok: true, ...currentClipState }; },
    clipboardHistoryTtl: async (ms) => { currentClipState.ttlMs = ms; return { ok: true, ...currentClipState }; },
    clipboardHistoryClear: async () => ({ ok: true, removed: 0 }),
    clipboardHistoryRemove: async () => ({ ok: true, removed: true }),
    snippetsList: async () => ({ ok: true, items: [] }),
    snippetsSave: async () => ({ ok: true }),
    snippetsRemove: async () => ({ ok: true }),
    snippetsInsert: async () => ({ ok: true }),
    diskFree: async () => (diskFreeResult || { ok: true, data: { drives: [{ drive: 'D:', freeGB: 42 }] } }),
    downloadsAnalyze: async (opts) => session.analyze(dir, opts),
    downloadsRemove: async (payload, confirm) => session.remove(payload, confirm, { folder: dir }),
  };

  const windowObj = {
    JarvisUI: {
      el: (tag, attrs = {}, ...kids) => el(tag, attrs, ...kids),
      has: (name) => typeof api[name] === 'function',
      call: async (name, ...args) => { calls.push({ name, args }); return api[name](...args); },
      cleanSummary: (s) => String(s || ''),
      relTime: () => 'сейчас',
      clip: (s, n) => String(s || '').slice(0, n),
    },
  };

  const sandbox = {
    window: windowObj,
    document: { querySelector: (sel) => docRoot.querySelector(sel) },
    Event: class { constructor(t) { this.type = t; } },
    Promise,
    Number,
    String,
    Array,
    Map,
    Set,
    Math,
    Boolean,
    console,
  };
  vm.runInNewContext(EXT_SOURCE, sandbox, { filename: 'extensions.js' });

  windowObj.JarvisExtensions.init({
    toast: (msg, tone) => toasts.push({ msg, tone }),
    ask: async (title, text, yes, no, opts) => {
      asks.push({ title, text, yes, no, opts });
      return askImpl ? askImpl({ title, text, yes, no, opts, docRoot }) : false;
    },
  });

  const q = (id) => docRoot.querySelector('#' + id);
  return { windowObj, docRoot, q, calls, toasts, asks, api, currentClipState, currentSettings, session };
}

test('разметка и app.js: честные подписи, опция 7 дней, список в confirmDialog', () => {
  assert.ok(HTML_SOURCE.includes('<option value="604800000">7 дней</option>'), 'в select есть 7 дней');
  assert.ok(HTML_SOURCE.includes('id="clipStatusHint"'), 'статус буфера имеет id');
  assert.ok(HTML_SOURCE.includes('id="dlResult"'), 'результат удаления имеет отдельный блок');
  assert.ok(HTML_SOURCE.includes('id="cfList"'), 'в confirmDialog есть список файлов');
  assert.doesNotMatch(HTML_SOURCE, /Фраза-триггер/, 'нет ложного обещания автотриггера в форме');
  assert.doesNotMatch(HTML_SOURCE, /Текст по короткой фразе/, 'нет ложного обещания в подзаголовке');
  assert.match(HTML_SOURCE, /Автоподстановка по фразе-триггеру в этой версии не подключена/);
  assert.match(APP_SOURCE, /#cfList/, 'ask() умеет показывать точный список файлов');
});

test('буфер обмена: статус отражает выкл / вкл / пауза, а срок хранения синхронизируется с ядром', async () => {
  const env1 = setupExtensionsEnv({
    settings: { clipboardHistory: true },
    clipState: { paused: false, ttlMs: 604800000 },
  });
  await env1.windowObj.JarvisExtensions.load();
  assert.equal(env1.q('clipEnabled').checked, true);
  assert.equal(env1.q('clipStatusHint').textContent, 'Включено — история ведётся');
  assert.equal(env1.q('clipTtl').value, '604800000', 'показывает реальные 7 дней, а не 15 минут');
  assert.equal(env1.q('clipPause').disabled, false);

  // Пауза обновляет статус на «на паузе».
  env1.q('clipPause').fire('click');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(env1.q('clipStatusHint').textContent, 'Включено, но на паузе — новые копирования не сохраняются');
  assert.equal(env1.q('clipPause').textContent, 'Продолжить');

  // Бессрочно (null) отображается как '' (Бессрочно), а не '15 минут'.
  const env2 = setupExtensionsEnv({
    settings: { clipboardHistory: false },
    clipState: { paused: false, ttlMs: null },
  });
  await env2.windowObj.JarvisExtensions.load();
  assert.equal(env2.q('clipStatusHint').textContent, 'Выключено — история не ведётся');
  assert.equal(env2.q('clipPause').disabled, true);
  assert.equal(env2.q('clipTtl').value, '');
});

test('уборка загрузок: единая карточка без Освободить место, чекбоксы сняты по умолчанию, пустой выбор заблокирован', async (t) => {
  const dir = tempDownloadsDir(t);
  const f1 = makeFile(dir, 'old1.zip', { size: 1000, ageDays: 40 });
  const f2 = makeFile(dir, 'part.crdownload', { size: 500, ageDays: 1 });

  const env = setupExtensionsEnv({ dir });
  assert.equal(env.q('diskCard'), null, 'конкурирующая карточка «Освободить место» удалена');

  env.q('dlAnalyze').fire('click');
  await new Promise((r) => setTimeout(r, 15));

  const boxes = env.q('dlList').querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes.length, 2);
  assert.equal(boxes.every((b) => b.checked === false), true, 'ни один файл не выбран по умолчанию');
  assert.equal(boxes.every((b) => !b.classList.contains('switch')), true, 'используются чекбоксы, а не тумблеры');
  assert.equal(env.q('dlRemove').disabled, true, 'удаление недоступно при пустом выборе');
  assert.match(env.q('dlSelection').textContent, /Выбрано: 0 из 2/);

  // Нажать удаление при пустом выборе — ничего не происходит, файлы целы.
  env.q('dlRemove').fire('click');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(env.asks.length, 0);
  assert.equal(fs.existsSync(f1), true);
  assert.equal(fs.existsSync(f2), true);
});

test('уборка загрузок: точный список в подтверждении, отмена, снятие отметки и стойкий результат удаления', async (t) => {
  const dir = tempDownloadsDir(t);
  const f1 = makeFile(dir, 'keep-me.zip', { size: 2048, ageDays: 45 });
  const f2 = makeFile(dir, 'delete-me.tmp', { size: 1024, ageDays: 1 });

  let confirmDecision = false;
  const env = setupExtensionsEnv({
    dir,
    askImpl: ({ docRoot }) => {
      // Во время диалога подтверждения чекбоксы и кнопки заблокированы.
      const dlBoxes = docRoot.querySelector('#dlList').querySelectorAll('input[type="checkbox"]');
      assert.equal(dlBoxes.every((b) => b.disabled === true), true, 'чекбоксы заблокированы во время подтверждения');
      assert.equal(docRoot.querySelector('#dlAnalyze').disabled, true);
      return confirmDecision;
    },
  });

  env.q('dlAnalyze').fire('click');
  await new Promise((r) => setTimeout(r, 15));

  // Выбрать все, затем снять отметку с keep-me.zip.
  env.q('dlSelectAll').fire('click');
  const boxes = env.q('dlList').querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes.every((b) => b.checked === true), true);
  const keepBox = boxes.find((b) => b.dataset.path === 'keep-me.zip');
  keepBox.checked = false;
  keepBox.fire('change');
  assert.match(env.q('dlSelection').textContent, /Выбрано: 1 из 2/);

  // 1) Отмена: в диалоге показан ровно delete-me.tmp (и НЕТ keep-me.zip), файлы целы.
  confirmDecision = false;
  env.q('dlRemove').fire('click');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(env.asks.length, 1);
  assert.deepEqual(Array.from(env.asks[0].opts.items, (x) => x.label), ['delete-me.tmp']);
  assert.equal(env.asks[0].text.includes('keep-me.zip'), false);
  assert.equal(fs.existsSync(f1), true);
  assert.equal(fs.existsSync(f2), true);

  // 2) Подтверждение: удалён только delete-me.tmp, результат не затирается пересканом.
  confirmDecision = true;
  env.q('dlRemove').fire('click');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(fs.existsSync(f2), false);
  assert.equal(fs.existsSync(f1), true, 'снятый файл не удалён');
  assert.equal(env.q('dlResult').hidden, false, 'блок результата удаления виден');
  assert.match(env.q('dlResult').textContent, /Удалено файлов: 1, освобождено/);
  // Список внизу обновился до 1 оставшегося кандидата.
  assert.equal(env.q('dlList').querySelectorAll('input[type="checkbox"]').length, 1);
  assert.equal(env.q('dlList').querySelectorAll('input[type="checkbox"]')[0].checked, false);
});

test('уборка загрузок: изменение файла на диске во время подтверждения блокирует удаление и требует повторной проверки', async (t) => {
  const dir = tempDownloadsDir(t);
  const f1 = makeFile(dir, 'stable.zip', { size: 1000, ageDays: 45 });
  const f2 = makeFile(dir, 'changed.tmp', { size: 500, ageDays: 1 });

  const env = setupExtensionsEnv({
    dir,
    askImpl: () => {
      // Имитируем изменение файла на диске пока открыт диалог подтверждения.
      fs.writeFileSync(f2, Buffer.alloc(1234, 9));
      return true;
    },
  });

  env.q('dlAnalyze').fire('click');
  await new Promise((r) => setTimeout(r, 15));

  env.q('dlSelectAll').fire('click');
  env.q('dlRemove').fire('click');
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(fs.existsSync(f1), true, 'ни один файл из пачки не удалён при изменении списка');
  assert.equal(fs.existsSync(f2), true);
  assert.equal(env.q('dlResult').hidden, false);
  assert.equal(env.q('dlResult').classList.contains('note-err'), true);
  assert.match(env.q('dlResult').textContent, /изменились|повторн/i);
  // После перескана чекбоксы снова сняты — требуется явный новый выбор и повторное подтверждение.
  const boxesAfter = env.q('dlList').querySelectorAll('input[type="checkbox"]');
  assert.equal(boxesAfter.every((b) => b.checked === false), true);
  assert.equal(env.q('dlRemove').disabled, true);
});
