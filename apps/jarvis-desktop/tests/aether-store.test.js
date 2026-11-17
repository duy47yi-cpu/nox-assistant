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

test('Store: 5 маршрутов, состояние пустого чата и черновики между чатами', async () => {
  assert.deepEqual(ROUTES, ['chat', 'commands', 'mcp', 'personal', 'settings']);
  const { bridge } = makeFakeBridge();
  const store = createStore({ bridge, storage: makeMemStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  await store.loadInitial();

  // Чат c1 пуст.
  assert.equal(store.isEmptyChat(), true);
  assert.equal(store.state.activeChatId, 'c1');

  // Печатаем черновик в c1, переключаемся на непустой c2
  store.setDraftText('Черновик первого чата');
  await store.selectChat('c2');

  // В c2 сразу видна история.
  assert.equal(store.isEmptyChat(), false);
  assert.equal(store.state.currentDraftText, '');

  // Возвращаемся в c1 -> черновик сохранён, чат пустой
  await store.selectChat('c1');
  assert.equal(store.state.currentDraftText, 'Черновик первого чата');
  assert.equal(store.isEmptyChat(), true);

  // Первая реплика появляется сразу после отправки.
  const pSend = store.sendChatMessage('Запусти проверку', []);
  assert.equal(store.isEmptyChat(), false);
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

test('Store: запоздавший итог действия после стопа не воскрешает ход и не оставляет «Думаю…»', async () => {
  const { bridge } = makeFakeBridge();
  const store = createStore({ bridge, storage: makeMemStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  await store.loadInitial();

  // Ход на экране: ожидание шага, затем Esc/стоп и honest done(cancelled).
  store.onAgentEvent({ type: 'quick_user', text: 'Сделай на экране: подожди на экране' });
  store.onAgentEvent({ type: 'tool_start', id: 'w1', name: 'ui_wait', step: 1, status: 'running' });
  store.onAgentEvent({ type: 'tool_result', id: 'w1', name: 'ui_wait', ok: true, summary: 'ждёт' });
  store.onAgentEvent({ type: 'done', status: 'cancelled', cancelled: true, replyText: 'Остановлено.' });

  assert.equal(store.state.activeTurn, null, 'после стопа активного хода нет');
  assert.equal(store.state.feedItems.filter((i) => i.kind === 'assistant').length, 1, 'в ленте один отменённый ответ');
  assert.equal(store.state.feedItems.at(-1).cancelled, true);

  // Ядро присылает настоящий итог действия уже после стопа (afterStop/late).
  // Раньше из него рождался новый живой ход и в ленте висело «Ход работы → Думаю…».
  store.onAgentEvent({
    type: 'tool_result', id: 'w1', name: 'ui_wait', ok: false, status: 'failed',
    summary: 'завершилось после запроса остановки', afterStop: true, late: true,
  });

  assert.equal(store.state.activeTurn, null, 'поздний итог не создаёт новый ход');
  assert.equal(store.state.feedItems.filter((i) => i.kind === 'assistant').length, 1, 'нового ответа нет');
  assert.equal(store.getLiveWorkText(), '', 'живой строки прогресса нет');
  assert.doesNotMatch(JSON.stringify(store.state.feedItems) + store.getLiveWorkText(), /Думаю/);
});

test('Store: карточка берёт verifiedStatus и не пишет «выполнено» неподтверждённому действию', async () => {
  const { bridge } = makeFakeBridge();
  const store = createStore({ bridge, storage: makeMemStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  await store.loadInitial();

  store.onAgentEvent({ type: 'quick_user', text: 'Открой терминал и VS Code' });
  store.onAgentEvent({ type: 'tool_start', id: 'g1', name: 'organize_workspace', step: 1, status: 'running' });
  // Ядро прислало ok:true, но verified пуст, а verifiedStatus — unverified (у инструмента нет проверки эффекта).
  store.onAgentEvent({
    type: 'tool_result', id: 'g1', name: 'organize_workspace', ok: true,
    summary: 'запущено: 2', status: 'unverified', verifiedStatus: 'unverified',
  });
  store.onAgentEvent({ type: 'done', status: 'unverified', replyText: 'Открыл терминал и VS Code.' });

  const last = store.state.feedItems.filter((i) => i.kind === 'assistant').at(-1);
  assert.equal(last.workStatus, 'unverified');
  assert.equal(last.actions.length, 1);
  assert.equal(last.actions[0].status, 'unverified', 'карточка не должна говорить «выполнено» без подтверждения');
  assert.equal(last.actions[0].verified, 'unknown');
});

test('Store: после отмены незавершённая карточка закрывается как «остановлено»', async () => {
  const { bridge } = makeFakeBridge();
  const store = createStore({ bridge, storage: makeMemStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  await store.loadInitial();

  store.onAgentEvent({ type: 'quick_user', text: 'Найди факты о Риме' });
  store.onAgentEvent({ type: 'tool_start', id: 'r1', name: 'web_research', step: 1, status: 'running' });
  store.onAgentEvent({ type: 'done', status: 'cancelled', cancelled: true, replyText: '' });

  const last = store.state.feedItems.filter((i) => i.kind === 'assistant').at(-1);
  assert.equal(last.cancelled, true);
  assert.equal(last.actions.length, 1);
  assert.equal(last.actions[0].status, 'cancelled', 'карточка не должна висеть «выполняется» после отмены');
});

test('Store: текст ответа очищается от служебных id и «Шаг N»', async () => {
  const { bridge } = makeFakeBridge();
  const store = createStore({ bridge, storage: makeMemStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  await store.loadInitial();

  store.onAgentEvent({ type: 'quick_user', text: 'Напомни через 20 минут выпить воды' });
  store.onAgentEvent({ type: 'tool_start', id: 'r1', name: 'remind_in', step: 1, status: 'running' });
  store.onAgentEvent({ type: 'tool_result', id: 'r1', name: 'remind_in', ok: true, summary: 'напомню', verified: 'confirmed', verifiedStatus: 'confirmed' });
  store.onAgentEvent({ type: 'text', delta: 'Готово: напоминание. - Шаг 1 (remind_in): подтверждено — напомню через 20 мин' });
  store.onAgentEvent({ type: 'done', status: 'succeeded' });

  const last = store.state.feedItems.filter((i) => i.kind === 'assistant').at(-1);
  assert.doesNotMatch(last.text, /remind_in|Шаг\s*1/, 'служебный протокол не должен попадать в текст');
  assert.match(last.text, /напоминание/i);
});

test('Store: обычный итог действия без активного хода по-прежнему создаёт ход', async () => {
  const { bridge } = makeFakeBridge();
  const store = createStore({ bridge, storage: makeMemStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  await store.loadInitial();

  store.onAgentEvent({ type: 'quick_user', text: 'Открой журнал' });
  store.onAgentEvent({ type: 'tool_start', id: 'r1', name: 'workspace_read', step: 1, status: 'running' });
  store.onAgentEvent({ type: 'tool_result', id: 'r1', name: 'workspace_read', ok: true, summary: 'прочитал' });
  assert.ok(store.state.activeTurn, 'живой ход с обычным событием на месте');
  store.onAgentEvent({ type: 'done', status: 'succeeded', replyText: 'Готово.' });
  assert.equal(store.state.activeTurn, null);
  assert.equal(store.state.feedItems.filter((i) => i.kind === 'assistant').at(-1).text, 'Готово.');
});

