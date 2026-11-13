'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ROUTES,
  APPROVAL_ARM_MS,
  isEmptyChatState,
  formatLiveWorkSummary,
  createStore,
} = require('../renderer/aether/store');

function makeMemStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function makeFakeBridge(overrides = {}) {
  const calls = [];
  const state = {
    chats: [
      { id: 'c1', title: 'Первый чат', updatedAt: Date.now() },
      { id: 'c2', title: 'С историей', updatedAt: Date.now() - 1000 },
    ],
    activeId: 'c1',
    histories: {
      c1: [],
      c2: [
        { role: 'user', text: 'Привет' },
        { role: 'assistant', text: 'Здравствуйте!' },
      ],
    },
  };
  const api = {
    getState: async () => ({ mode: 'ask', hasKey: true, stopped: false }),
    getSettings: async () => ({ motion: true, dictation: true, modelTier: 'fast', thinking: 'low', uiShell: 'aether' }),
    workspacesList: async () => ({ ok: true, workspaces: [{ id: 'default', name: 'Основное' }], currentId: 'default' }),
    chatList: async () => ({ ok: true, chats: state.chats, activeId: state.activeId }),
    chatHistory: async () => state.histories[state.activeId] || [],
    chatSelect: async (id) => { state.activeId = id; return { ok: true }; },
    chatNew: async () => {
      const nid = `c${state.chats.length + 1}`;
      state.chats.unshift({ id: nid, title: 'Новый чат', updatedAt: Date.now() });
      state.histories[nid] = [];
      state.activeId = nid;
      return { ok: true, id: nid };
    },
    send: async (txt) => {
      state.histories[state.activeId].push({ role: 'user', text: txt }, { role: 'assistant', text: 'Ответ' });
      return { ok: true };
    },
    markApprovalShown: async (id) => ({ ok: true, token: `tok_${id}` }),
    respondApproval: async (...args) => { calls.push(['respondApproval', ...args]); return { ok: true }; },
    listApprovals: async () => [],
    accountState: async () => ({ enabled: false }),
    dictationState: async () => ({ ok: true, mode: 'listening', full: false, recording: false }),
    tasksAttention: async () => [],
    ...overrides,
  };
  return {
    calls,
    bridge: {
      ensureBridge: async () => 'electron',
      has: (name) => typeof api[name] === 'function',
      call: async (name, ...args) => {
        calls.push([name, ...args]);
        return api[name](...args);
      },
      errText: (e) => (e && e.message) || String(e),
    },
  };
}

test('Store: 5 маршрутов, центрирование пустого чата, FLIP-флаг и черновики между чатами', async () => {
  assert.deepEqual(ROUTES, ['chat', 'commands', 'mcp', 'personal', 'settings']);
  const { bridge } = makeFakeBridge();
  const store = createStore({ bridge, storage: makeMemStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  await store.loadInitial();

  // Пустой чат с1 -> центрированное состояние
  assert.equal(store.isEmptyChat(), true);
  assert.equal(store.state.activeChatId, 'c1');

  // Печатаем черновик в c1, переключаемся на непустой c2
  store.setDraftText('Черновик первого чата');
  await store.selectChat('c2');

  // В c2 сразу непустой чат (докован, pendingComposeAnim = false — никаких ложных анимаций!)
  assert.equal(store.isEmptyChat(), false);
  assert.equal(store.consumeComposeAnim(), false);
  assert.equal(store.state.currentDraftText, '');

  // Возвращаемся в c1 -> черновик сохранён, чат пустой
  await store.selectChat('c1');
  assert.equal(store.state.currentDraftText, 'Черновик первого чата');
  assert.equal(store.isEmptyChat(), true);

  // Отправка из пустого чата запускает consumeComposeAnim
  const pSend = store.sendChatMessage('Запусти проверку', []);
  assert.equal(store.consumeComposeAnim(), true);
  assert.equal(store.consumeComposeAnim(), false);
  await pSend;
  assert.equal(isEmptyChatState(store.state), false);
});

test('Store: одна спокойная строка живого прогресса (без многострочного спама)', () => {
  const line = formatLiveWorkSummary({
    trackerState: 'acting',
    note: 'Читаю конфиг\nвторая строка лишняя',
    currentAction: { status: 'running', title: 'Чтение файла', brief: 'package.json' },
    pendingApprovalCount: 0,
  });
  assert.ok(!line.includes('\n'));
  assert.equal(line, 'Чтение файла: package.json');

  const fallbackLine = formatLiveWorkSummary({
    trackerState: 'acting',
    note: 'Первая строка\nвторая строка',
    currentAction: null,
    pendingApprovalCount: 0,
  });
  assert.ok(!fallbackLine.includes('\n'));
  assert.equal(fallbackLine, 'Первая строка вторая строка');
});

test('Store: R3-01 инварианты подтверждения (700мс взвод, токен показа, затвор вместо подмены)', async () => {
  const { bridge, calls } = makeFakeBridge();
  const store = createStore({ bridge, storage: makeMemStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  await store.loadInitial();

  store.onAgentEvent({
    type: 'approval_request',
    id: 'ap-1',
    tool: 'shell_run',
    summary: 'Удалить временную папку',
    autoCancelAt: Date.now() + 30000,
  });

  // Сразу после появления разрешение не взведено (700ms arming)
  assert.ok(store.state.approvals.view);
  assert.equal(store.state.approvals.view.armed, false);
  await store.respondApproval('once', store.state.approvals.view.seq);
  assert.equal(calls.filter((c) => c[0] === 'respondApproval').length, 0);

  // Ждём окончания окна безопасности + получения токена
  await new Promise((r) => setTimeout(r, APPROVAL_ARM_MS + 40));
  assert.equal(store.state.approvals.view.armed, true);
  assert.equal(store.state.approvals.view.token, 'tok_ap-1');

  // Запрос ap-2 приходит в очередь, а затем ap-1 закрывается ядром -> включается gate (затвор), не подменяя под курсором!
  store.onAgentEvent({ type: 'approval_request', id: 'ap-2', tool: 'fs_write', summary: 'Запись' });
  store.onAgentEvent({ type: 'approval_closed', id: 'ap-1' });
  assert.equal(store.state.approvals.view, null);
  assert.equal(store.state.approvals.gate, true);

  // Осознанное раскрытие следующего -> взвод и разрешение передают токен показа
  await store.showApprovalById('ap-2');
  assert.equal(store.state.approvals.gate, false);
  await new Promise((r) => setTimeout(r, APPROVAL_ARM_MS + 40));
  await store.respondApproval('once', store.state.approvals.view.seq);
  const resp = calls.find((c) => c[0] === 'respondApproval');
  assert.ok(resp);
  assert.equal(resp[1], 'ap-2');
  assert.equal(resp[2], 'once');
  assert.equal(resp[3], 'tok_ap-2');
});

test('Store: диктовка text дописывает черновик, ошибка сохраняет повторный запрос', async () => {
  const { bridge } = makeFakeBridge({
    send: async () => ({ ok: false, error: 'Сервер недоступен' }),
  });
  const store = createStore({ bridge, storage: makeMemStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  await store.loadInitial();

  store.onDictationEvent({ type: 'text', text: 'Открой журнал' });
  assert.equal(store.state.currentDraftText, 'Открой журнал');

  await store.sendChatMessage('Проверь почту', []);
  assert.ok(store.state.feedItems.some((i) => i.kind === 'error'));
  assert.equal(store.state.lastSentPayload.text, 'Проверь почту');
});
