'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { draftCommandFromTurn } = require('../src/commands/builder');
const { CommandStore } = require('../src/commands/store');
const AetherStore = require('../renderer/aether/store');

const ROOT_DIR = path.resolve(__dirname, '..');

function makeTempDir(prefix = 'nox-agent-save-ui-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeDom() {
  class FakeClassList {
    constructor(el) {
      this._el = el;
      this._set = new Set();
    }
    _sync() {
      this._el._className = [...this._set].join(' ');
    }
    setFromString(str) {
      this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
      this._sync();
    }
    add(...names) {
      for (const n of names) if (n) this._set.add(n);
      this._sync();
    }
    remove(...names) {
      for (const n of names) this._set.delete(n);
      this._sync();
    }
    toggle(name, force) {
      const has = this._set.has(name);
      const next = typeof force === 'boolean' ? force : !has;
      if (next) this._set.add(name);
      else this._set.delete(name);
      this._sync();
      return next;
    }
    contains(name) {
      return this._set.has(name);
    }
  }

  class FakeElement {
    constructor(tagName, ownerDocument) {
      this.tagName = String(tagName || 'div').toUpperCase();
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.parentElement = null;
      this.attributes = {};
      this.dataset = {};
      this.style = { setProperty() {}, removeProperty() {} };
      this.listeners = new Map();
      this.classList = new FakeClassList(this);
      this._className = '';
      this._id = '';
      this._textContent = '';
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.checked = false;
      this.type = '';
      this.title = '';
      this.placeholder = '';
      this.scrollHeight = 40;
      this.scrollTop = 0;
      this.clientHeight = 200;
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
    get id() { return this._id; }
    set id(v) { this._id = String(v || ''); this.attributes.id = this._id; }
    get className() { return this._className; }
    set className(v) { this.classList.setFromString(v); }
    get firstChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this._textContent + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this.children = [];
      this._textContent = String(v == null ? '' : v);
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n == null) continue;
        if (typeof n === 'string') {
          this._textContent += n;
        } else if (n._isFragment) {
          this.append(...n.children);
        } else {
          if (n.parentElement) n.remove();
          n.parentElement = this;
          this.children.push(n);
        }
      }
    }
    replaceChildren(...nodes) {
      for (const c of this.children) c.parentElement = null;
      this.children = [];
      this._textContent = '';
      this.append(...nodes);
    }
    insertBefore(node, reference) {
      if (!reference) {
        this.append(node);
        return node;
      }
      if (node.parentElement) node.remove();
      node.parentElement = this;
      this.children.splice(this.children.indexOf(reference), 0, node);
      return node;
    }
    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = v;
      if (k === 'class') this.className = v;
    }
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    }
    removeAttribute(k) { delete this.attributes[k]; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (!list) return;
      this.listeners.set(type, list.filter((f) => f !== fn));
    }
    dispatchEvent(ev) {
      const list = this.listeners.get(ev.type) || [];
      for (const fn of list.slice()) fn(ev);
    }
    click() {
      if (this.disabled) return;
      this.dispatchEvent({ type: 'click', target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} });
    }
    focus() {}
    scrollIntoView() {}
    setSelectionRange() {}
    closest() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; }
    querySelectorAll(selector) {
      const out = [];
      const parts = String(selector || '').split(',').map((s) => s.trim()).filter(Boolean);
      const matchesOne = (el, sel) => {
        if (sel.startsWith('#')) return el.id === sel.slice(1);
        if (sel.startsWith('.')) {
          const cls = sel.slice(1).split('.');
          return cls.every((c) => el.classList.contains(c));
        }
        return el.tagName.toLowerCase() === sel.toLowerCase();
      };
      const walk = (node) => {
        for (const c of node.children) {
          if (parts.some((p) => matchesOne(c, p))) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }
  }

  const doc = {
    body: null,
    documentElement: null,
    listeners: new Map(),
    createElement(tag) { return new FakeElement(tag, doc); },
    createElementNS(_ns, tag) { return new FakeElement(tag, doc); },
    createDocumentFragment() { return { _isFragment: true, children: [], append(...n) { this.children.push(...n); } }; },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (list) this.listeners.set(type, list.filter((f) => f !== fn));
    },
    getElementById(id) { return doc.body.querySelector(`#${id}`); },
  };
  doc.documentElement = new FakeElement('html', doc);
  doc.body = new FakeElement('body', doc);
  return doc;
}

function loadRendererEnv(doc) {
  const ctx = vm.createContext({
    document: doc,
    location: { search: '' },
    navigator: {},
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (cb) => cb(),
    JarvisUI: {
      scrub: (s) => String(s == null ? '' : s),
      toolTitle: (t) => String(t || 'Действие'),
      argsPretty: (a) => JSON.stringify(a || {}),
      argsBrief: () => '',
      cleanSummary: (s) => String(s || ''),
      statusOfResult: (ok, _sum, rej) => (rej ? 'refused' : (ok ? 'confirmed' : 'error')),
      shortTime: () => 'сейчас',
    },
    NoxAetherMarkdown: {
      renderMarkdown: (text) => {
        const p = doc.createElement('p');
        p.textContent = String(text || '');
        return p;
      },
      copyPlain: async () => true,
    },
    NoxAetherBridge: null,
    CmdSteps: {
      TRIGGER_EVENT_OPTIONS: [],
      stepTitle: (t) => String(t || ''),
      stepDetail: () => '',
      moveStep: (arr) => arr,
      parseSchedule: () => ({}),
    },
    console,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    RegExp,
    URLSearchParams,
    queueMicrotask: (fn) => fn(),
  });
  ctx.window = ctx;
  ctx.globalThis = ctx;

  const scripts = [
    'renderer/aether/icons.js',
    'renderer/aether/store.js',
    'renderer/aether/components/approval-card.js',
    'renderer/aether/components/composer.js',
    'renderer/aether/components/chat-view.js',
    'renderer/aether/components/commands-view.js',
  ];
  for (const rel of scripts) {
    const code = fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }
  return ctx;
}

// ── 1. draftCommandFromTurn ─────────────────────────────────────────

test('draftCommandFromTurn builds valid schema v2 draft accepted by CommandStore.save', () => {
  const res = draftCommandFromTurn({
    phrase: 'Открой Telegram и сделай тише!',
    actions: [
      { tool: 'windows_list', args: {}, status: 'confirmed', ok: true }, // вспомогательный просмотр отсеивается
      { tool: 'app_open', args: { name: 'Telegram' }, status: 'confirmed', ok: true },
      { tool: 'volume_set', args: { percent: 25 }, status: 'done', ok: true },
    ],
  });

  assert.equal(res.ok, true);
  assert.equal(res.draft.schemaVersion, 3);
  assert.equal(res.draft.version, 3);
  assert.equal(res.draft.kind, 'sequence');
  assert.equal(res.draft.enabled, true);
  assert.equal(res.draft.origin, 'ai');
  assert.equal(res.draft.name, 'Открой Telegram и сделай тише');
  assert.deepEqual(res.draft.phrases, ['открой telegram и сделай тише']);
  assert.deepEqual(res.draft.steps.map(({ tool, args }) => ({ tool, args })), [
    { tool: 'app_open', args: { name: 'Telegram' } },
    { tool: 'volume_set', args: { percent: 25 } },
  ]);

  const dir = makeTempDir();
  try {
    const cs = new CommandStore(path.join(dir, 'commands.json'));
    const saved = cs.save(res.draft);
    assert.ok(saved.id);
    assert.equal(saved.schemaVersion, 3);
    assert.equal(saved.origin, 'ai');
    assert.deepEqual(saved.phrases, ['открой telegram и сделай тише']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('draftCommandFromTurn deduplicates name against existingCommands', () => {
  const existing = [
    { id: '1', name: 'Открой блокнот', phrases: ['блокнот'] },
    { id: '2', name: 'Открой блокнот (2)', phrases: ['запусти блокнот'] },
  ];
  const res = draftCommandFromTurn({
    phrase: 'Джарвис, открой блокнот',
    actions: [{ tool: 'app_open', args: { name: 'notepad' }, status: 'confirmed', ok: true }],
    existingCommands: existing,
  });

  assert.equal(res.ok, true);
  assert.equal(res.draft.name, 'Открой блокнот (3)');
  assert.deepEqual(res.draft.phrases, ['джарвис, открой блокнот']);
});

test('draftCommandFromTurn rejects invalid/long phrases, failed turns, DENY_TOOLS, FORBIDDEN_PREFIXES, and read-only turns', () => {
  assert.equal(draftCommandFromTurn({ phrase: '', actions: [{ tool: 'app_open', args: { name: 'notepad' }, status: 'confirmed' }] }).ok, false);
  assert.equal(draftCommandFromTurn({ phrase: '!!!', actions: [{ tool: 'app_open', args: { name: 'notepad' }, status: 'confirmed' }] }).ok, false);
  assert.equal(draftCommandFromTurn({ phrase: 'а'.repeat(201), actions: [{ tool: 'app_open', args: { name: 'notepad' }, status: 'confirmed' }] }).ok, false);

  // Фраза длиной 150 символов допустима (1..200) и безопасно укорачивается до предела CommandStore.
  const longOk = draftCommandFromTurn({
    phrase: 'открой программу '.repeat(9).trim(), // ~153 символа
    actions: [{ tool: 'app_open', args: { name: 'notepad' }, status: 'confirmed' }],
  });
  assert.equal(longOk.ok, true);
  assert.ok(Array.from(longOk.draft.phrases[0]).length <= 120);

  // Ошибки / отказы / непроверенные / отменённые шаги не проходят.
  for (const status of ['error', 'failed', 'refused', 'unverified', 'cancelled']) {
    const r = draftCommandFromTurn({
      phrase: 'открой блокнот',
      actions: [{ tool: 'app_open', args: { name: 'notepad' }, status, ok: false }],
    });
    assert.equal(r.ok, false, `status=${status} must fail`);
  }

  // Запрещённые инструменты и префиксы.
  for (const tool of ['mail_send', 'pc_shutdown', 'shell_run', 'app_close', 'ui_close_window', 'app_install', 'windows_close_all', 'window_close_active', 'mission_add', 'command_run']) {
    const r = draftCommandFromTurn({
      phrase: 'сделай дело',
      actions: [{ tool, args: {}, status: 'confirmed', ok: true }],
    });
    assert.equal(r.ok, false, `forbidden tool=${tool} must be excluded`);
  }

  // Только просмотр/поиск без реального действия.
  for (const tool of ['windows_list', 'ui_windows', 'desktop_observe', 'screen_look', 'web_search', 'workspace_read', 'weather_now']) {
    const r = draftCommandFromTurn({
      phrase: 'посмотри что на экране',
      actions: [{ tool, args: {}, status: 'confirmed', ok: true }],
    });
    assert.equal(r.ok, false, `read-only tool=${tool} alone must be rejected`);
  }
});

test('draftCommandFromTurn rejects or strips secrets in args/phrase while keeping safe URLs', () => {
  const secretPhrase = draftCommandFromTurn({
    phrase: 'войди с пароль: mySecretPassword1',
    actions: [{ tool: 'app_open', args: { name: 'notepad' }, status: 'confirmed' }],
  });
  assert.equal(secretPhrase.ok, false);

  const secretArgKey = draftCommandFromTurn({
    phrase: 'введи токен',
    actions: [{ tool: 'ui_type', args: { text: 'ok', apiKey: 'sk-proj-1234567890abcdef' }, status: 'confirmed' }],
  });
  assert.equal(secretArgKey.ok, false);

  const secretArgText = draftCommandFromTurn({
    phrase: 'авторизуйся',
    actions: [
      { tool: 'app_open', args: { name: 'browser' }, status: 'confirmed' },
      { tool: 'ui_type', args: { text: 'token=ghp_abcdefghij1234567890' }, status: 'confirmed' },
    ],
  });
  assert.equal(secretArgText.ok, true);
  assert.deepEqual(secretArgText.draft.steps.map(({ tool, args }) => ({ tool, args })), [{ tool: 'app_open', args: { name: 'browser' } }]);

  const urlWithSecret = draftCommandFromTurn({
    phrase: 'открой ссылку',
    actions: [{ tool: 'url_open', args: { url: 'https://example.com/auth?token=supersecret123' }, status: 'confirmed' }],
  });
  assert.equal(urlWithSecret.ok, false);

  const safeHyphenUrl = draftCommandFromTurn({
    phrase: 'открой отчёт',
    actions: [{ tool: 'url_open', args: { url: 'https://example.com/project-2026-annual-report' }, status: 'confirmed' }],
  });
  assert.equal(safeHyphenUrl.ok, true);
  assert.equal(safeHyphenUrl.draft.steps[0].args.url, 'https://example.com/project-2026-annual-report');
});

// ── 2. store.js: agentMode, send payload, userPhrase, saveTurnAsCommand, openSavedCommand ──

test('store toggles agentMode, passes { agentMode: true } ONLY when enabled, and tracks userPhrase + saveTurnAsCommand', async () => {
  const sendCalls = [];
  const savedCommands = [];
  const fakeBridge = {
    has: (m) => ['send', 'listCommands', 'draftCommandFromTurn', 'saveCommand'].includes(m),
    call: async (m, ...args) => {
      if (m === 'send') {
        sendCalls.push(args);
        return { ok: true };
      }
      if (m === 'listCommands') return savedCommands.slice();
      if (m === 'draftCommandFromTurn') return draftCommandFromTurn(args[0]);
      if (m === 'saveCommand') {
        const rec = { ...args[0], id: `cmd-${savedCommands.length + 1}` };
        savedCommands.push(rec);
        return { ok: true, command: rec };
      }
      return {};
    },
    errText: (e) => String(e && e.message || e),
  };

  const store = AetherStore.createStore({ bridge: fakeBridge, storage: null });
  assert.equal(store.state.agentMode, false);

  await store.sendChatMessage('Открой калькулятор');
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].length, 2); // строго 2 аргумента, когда режим агента выключен
  assert.equal(sendCalls[0][0], 'Открой калькулятор');
  assert.deepEqual(sendCalls[0][1], []);

  store.onAgentEvent({ type: 'tool_call', id: 'c1', name: 'app_open', args: { name: 'calc' } });
  store.onAgentEvent({ type: 'tool_result', id: 'c1', name: 'app_open', ok: true, verified: 'confirmed', summary: 'запущено' });
  store.onAgentEvent({ type: 'text', delta: 'Готово.' });
  store.onAgentEvent({ type: 'done' });

  const assistant1 = store.state.feedItems.find((x) => x.kind === 'assistant');
  assert.ok(assistant1);
  assert.equal(assistant1.userPhrase, 'Открой калькулятор');
  assert.equal(assistant1.savedCommandId, null);

  assert.equal(store.toggleAgentMode(), true);
  assert.equal(store.state.agentMode, true);
  await store.sendChatMessage('Сделай громкость 20');
  assert.equal(sendCalls.length, 2);
  assert.equal(sendCalls[1].length, 3);
  assert.deepEqual(sendCalls[1][2], { agentMode: true });

  store.onAgentEvent({ type: 'tool_call', id: 'c2', name: 'volume_set', args: { percent: 20 } });
  store.onAgentEvent({ type: 'tool_result', id: 'c2', name: 'volume_set', ok: true, summary: '20%' });
  store.onAgentEvent({ type: 'done' });

  const assistant2 = store.state.feedItems.filter((x) => x.kind === 'assistant')[1];
  assert.equal(assistant2.userPhrase, 'Сделай громкость 20');

  const saveRes = await store.saveTurnAsCommand(assistant1.id);
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.id, 'cmd-1');

  const updated1 = store.state.feedItems.find((x) => x.id === assistant1.id);
  assert.equal(updated1.savedCommandId, 'cmd-1');
  assert.equal(updated1.savedCommandName, 'Открой калькулятор');

  // Повторный вызов не дублирует сохранение.
  const dupRes = await store.saveTurnAsCommand(assistant1.id);
  assert.equal(dupRes.alreadySaved, true);
  assert.equal(savedCommands.length, 1);

  assert.equal(store.openSavedCommand('cmd-1'), true);
  assert.equal(store.state.route, 'commands');
  assert.equal(store.state.pendingCommandId, 'cmd-1');
  assert.equal(store.consumePendingCommandId(), 'cmd-1');
  assert.equal(store.state.pendingCommandId, null);
});

test('store.saveTurnAsCommand works cleanly via client fallback when draftCommandFromTurn bridge method is absent', async () => {
  const saved = [];
  const fakeBridge = {
    has: (m) => ['saveCommand', 'listCommands'].includes(m),
    call: async (m, arg) => {
      if (m === 'listCommands') return saved;
      if (m === 'saveCommand') {
        const rec = { ...arg, id: 'cmd-fb-1' };
        saved.push(rec);
        return { ok: true, command: rec };
      }
      throw new Error('unexpected');
    },
    errText: (e) => String(e),
  };

  const store = AetherStore.createStore({ bridge: fakeBridge, storage: null });
  store.state.feedItems = [
    { id: 'u1', kind: 'user', text: 'Открой заметки', files: [] },
    {
      id: 'a1',
      kind: 'assistant',
      userPhrase: 'Открой заметки',
      text: 'Открыл.',
      actions: [{ id: 't1', tool: 'app_open', args: { name: 'notepad' }, status: 'confirmed' }],
      sources: [],
    },
  ];

  const r = await store.saveTurnAsCommand('a1');
  assert.equal(r.ok, true);
  assert.equal(r.id, 'cmd-fb-1');
  assert.equal(saved[0].schemaVersion, 3);
  assert.deepEqual(saved[0].phrases, ['открой заметки']);
  assert.equal(store.state.feedItems[1].savedCommandId, 'cmd-fb-1');
});

// ── 3. UI DOM wiring: composer + chat-view + commands-view ──────────

test('composer renders #agentModeBtn before #pickWrap and updates placeholder on toggle', () => {
  const doc = createFakeDom();
  const ctx = loadRendererEnv(doc);
  const store = ctx.NoxAetherStore.createStore({
    bridge: { has: () => false, call: async () => ({}), errText: (e) => String(e) },
    storage: null,
  });

  const composer = ctx.NoxAetherComposer.createComposer({
    store,
    bridge: { has: () => false, call: async () => ({}), errText: (e) => String(e) },
    onVoiceSettings: () => {},
  });
  doc.body.append(composer.el);
  composer.render(store.state);

  const btn = composer.el.querySelector('#agentModeBtn');
  const ta = composer.el.querySelector('.ae-textarea');
  const tools = composer.el.querySelector('.ae-composer-tools');
  assert.ok(btn, '#agentModeBtn must exist');
  assert.ok(btn.classList.contains('ae-agent-toggle'));
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(btn.textContent.trim(), 'Агент');
  assert.equal(ta.placeholder, 'Напишите поручение или задайте вопрос…');

  const btnIdx = tools.children.indexOf(btn);
  const pickIdx = tools.children.findIndex((c) => c.classList.contains('ae-pick-wrap'));
  assert.ok(btnIdx >= 0 && pickIdx > btnIdx, '#agentModeBtn should sit cleanly before #pickWrap');

  btn.click();
  composer.render(store.state);
  assert.equal(store.state.agentMode, true);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(btn.classList.contains('is-active'), true);
  assert.equal(ta.placeholder, 'Опишите действие на экране или в системе — агент выполнит по шагам…');
});

test('chat-view shows Save as command button on repeatable turns, transitions to Saved, and opens in commands-view editor', async () => {
  const doc = createFakeDom();
  const ctx = loadRendererEnv(doc);
  const storedCmds = [];

  const bridge = {
    has: (m) => ['send', 'listCommands', 'draftCommandFromTurn', 'saveCommand', 'toolCatalog', 'installPack', 'libraryList'].includes(m),
    call: async (m, ...args) => {
      if (m === 'send') return { ok: true };
      if (m === 'listCommands') return storedCmds.map((c) => ({ ...c }));
      if (m === 'draftCommandFromTurn') return draftCommandFromTurn(args[0]);
      if (m === 'saveCommand') {
        const rec = { ...args[0], id: 'cmd-saved-1' };
        storedCmds.push(rec);
        return { ok: true, command: rec };
      }
      if (m === 'toolCatalog') return [{ name: 'app_open', description: 'Открыть' }];
      if (m === 'installPack') return { ok: true, packs: [] };
      if (m === 'libraryList') return [];
      return {};
    },
    errText: (e) => String(e && e.message || e),
  };
  ctx.NoxAetherBridge = bridge;

  const store = ctx.NoxAetherStore.createStore({ bridge, storage: null });
  const chatView = ctx.NoxAetherChatView.createChatView({
    store,
    bridge,
    orbStage: { el: doc.createElement('div'), render() {} },
    onVoiceSettings: () => {},
  });
  const commandsView = ctx.NoxAetherCommandsView.createCommandsView({ store, bridge });
  doc.body.append(chatView.el, commandsView.el);

  const rerender = () => {
    chatView.render(store.state);
    commandsView.render(store.state);
  };
  store.subscribe(rerender);

  // Сначала ход только с просмотром — кнопки «Сохранить как команду» быть не должно.
  store.state.feedItems = [
    { id: 'u0', kind: 'user', text: 'Какие окна открыты?', files: [] },
    {
      id: 'a0',
      kind: 'assistant',
      userPhrase: 'Какие окна открыты?',
      text: 'Открыто 3 окна.',
      actions: [{ id: 'w0', tool: 'windows_list', args: {}, status: 'confirmed' }],
      sources: [],
    },
  ];
  rerender();
  assert.equal(chatView.el.querySelectorAll('.ae-save-cmd-btn').length, 0);

  // Завершённый ход с повторяемым действием.
  await store.sendChatMessage('Открой Telegram');
  store.onAgentEvent({ type: 'tool_call', id: 'c1', name: 'app_open', args: { name: 'Telegram' } });
  store.onAgentEvent({ type: 'tool_result', id: 'c1', name: 'app_open', ok: true, verified: 'confirmed', summary: 'открыто' });
  store.onAgentEvent({ type: 'text', delta: 'Готово.' });
  store.onAgentEvent({ type: 'done' });
  rerender();

  const saveBtn = chatView.el.querySelector('.ae-save-cmd-btn');
  assert.ok(saveBtn, 'Expected .ae-save-cmd-btn after repeatable confirmed turn');
  assert.equal(saveBtn.textContent.trim(), 'Сохранить как команду');

  // Нажатие «Сохранить как команду».
  await saveBtn.click();
  // Дождёмся микрозадач внутри асинхронного click-обработчика.
  await new Promise((r) => setTimeout(r, 20));
  rerender();

  const savedBtn = chatView.el.querySelector('.ae-save-cmd-btn.is-saved');
  const openBtn = chatView.el.querySelector('.ae-save-cmd-open');
  const sub = chatView.el.querySelector('.ae-save-cmd-sub');
  assert.ok(savedBtn, 'Button should change to .ae-save-cmd-btn.is-saved');
  assert.equal(savedBtn.disabled, true);
  assert.equal(savedBtn.textContent.trim(), 'Сохранено как команда');
  assert.equal(sub.textContent.trim(), 'В следующий раз — сразу, без нейросети');
  assert.ok(openBtn);
  assert.equal(openBtn.textContent.trim(), 'Открыть');

  // Нажатие «Открыть» переключает в раздел команд и открывает сохранённую команду в редакторе.
  openBtn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.state.route, 'commands');
  assert.equal(commandsView.el.hidden, false);

  const inputs = commandsView.el.querySelectorAll('input');
  const values = inputs.map((i) => i.value);
  assert.ok(values.includes('Открой Telegram'), 'Editor should show saved command name');
  assert.ok(values.includes('открой telegram'), 'Editor should show saved command trigger phrase');
});

test('dev-stub supports agentMode 3rd arg and draftCommandFromTurn', async () => {
  const doc = createFakeDom();
  const ctx = vm.createContext({
    document: doc,
    location: { search: '?mode=full' },
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    NoxAetherStore: AetherStore,
  });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const stubCode = fs.readFileSync(path.join(ROOT_DIR, 'renderer/dev-stub.js'), 'utf8');
  vm.runInContext(stubCode, ctx, { filename: 'renderer/dev-stub.js' });

  const stub = ctx.window.jarvis;
  assert.equal(typeof stub.draftCommandFromTurn, 'function');
  const draftRes = await stub.draftCommandFromTurn({
    phrase: 'Сделай тише',
    actions: [{ tool: 'volume_set', args: { percent: 15 }, status: 'done', ok: true }],
  });
  assert.equal(draftRes.ok, true);
  const saveRes = await stub.saveCommand(draftRes.draft);
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.command.origin, 'ai');

  const events = [];
  stub.onEvent((ev) => events.push(ev));
  const sendRes = await stub.send('сделай что-нибудь', [], { agentMode: true });
  assert.equal(sendRes.ok, true);
  await new Promise((r) => setTimeout(r, 150));
  await stub.stop();
});
