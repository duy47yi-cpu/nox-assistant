'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentLoop, DEFAULT_MAX_STEPS, STATUSES } = require('../src/screen/agent-loop');

function assertHonestOutcome(res, expectedStatus) {
  assert.ok(STATUSES.has(res.status), `недопустимый статус: ${res.status}`);
  assert.equal(res.status, expectedStatus);
  assert.equal(typeof res.message, 'string');
  assert.ok(res.message.trim().length > 0, 'сообщение не должно быть пустым');
  if (expectedStatus !== 'done') {
    assert.doesNotMatch(res.message, /готово/i, `запрещено «готово» при статусе ${expectedStatus}: ${res.message}`);
  }
}

test('успешный 3-шаговый сценарий: порядок observe → plan → act → verify → observe, память и логи', async () => {
  const trace = [];
  const logs = [];
  let tick = 1000;
  let screenStep = 0;

  const loop = createAgentLoop({
    now: () => { tick += 10; return tick; },
    log: (entry) => logs.push(entry),
    observe: async ({ phase, stepIndex }) => {
      trace.push(`observe:${phase}:${stepIndex}`);
      return { ok: true, window: { title: 'Блокнот' }, state: `s${screenStep}` };
    },
    plan: async ({ stepIndex, observation }) => {
      trace.push(`plan:${stepIndex}:${observation.state}`);
      if (stepIndex === 1) return { action: 'app_open', target: { app: 'notepad' }, expect: 'Окно Блокнот' };
      if (stepIndex === 2) return { action: 'ui_type', target: { name: 'Редактор', text: 'привет' }, expect: 'Текст введён' };
      if (stepIndex === 3) return { action: 'ui_click', target: { name: 'Файл' }, expect: 'Открылось меню Файл' };
      return { done: true };
    },
    act: async (step) => {
      trace.push(`act:${step.index}:${step.action}`);
      screenStep += 1;
      return { ok: true, summary: `${step.action} ок` };
    },
    verify: async (step) => {
      trace.push(`verify:${step.index}:${step.action}`);
      return { status: 'confirmed', evidence: `подтверждено: ${step.expect}` };
    },
  });

  const res = await loop.run({ goal: 'открыть блокнот, ввести текст и открыть меню' });
  assertHonestOutcome(res, 'done');
  assert.equal(res.steps.length, 3);
  assert.equal(res.evidence.length, 3);
  assert.ok(res.steps.every((s) => s.status === 'done' && s.verified === 'confirmed'));
  assert.match(res.message, /3 из 3/);

  // На каждый шаг: начальное наблюдение, затем plan -> act -> verify -> свежее наблюдение.
  assert.deepEqual(trace, [
    'observe:initial:0',
    'plan:1:s0', 'act:1:app_open', 'verify:1:app_open', 'observe:after_step:1',
    'plan:2:s1', 'act:2:ui_type', 'verify:2:ui_type', 'observe:after_step:2',
    'plan:3:s2', 'act:3:ui_click', 'verify:3:ui_click', 'observe:after_step:3',
    'plan:4:s3',
  ]);

  assert.equal(logs.length, 3);
  for (const entry of logs) {
    assert.ok(entry.action);
    assert.ok(entry.expect);
    assert.match(entry.verificationFact, /подтверждено/);
    assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs > 0);
  }
});

test('провал проверки (verify = failed): шаг failed, следующие шаги не идут, без «готово»', async () => {
  const acted = [];
  const logs = [];
  const loop = createAgentLoop({
    log: (e) => logs.push(e),
    observe: async () => ({ ok: true, window: { title: 'Окно' }, text: 'исходно' }),
    act: async (step) => { acted.push(step.action); return { ok: true }; },
    verify: async () => ({ status: 'failed', evidence: 'кнопка не переключилась' }),
  });

  const res = await loop.run({
    goal: 'нажать кнопку',
    steps: [
      { action: 'ui_click', target: { name: 'Далее' }, expect: 'Шаг 2' },
      { action: 'ui_click', target: { name: 'Финиш' }, expect: 'Завершено' },
    ],
  });

  assertHonestOutcome(res, 'failed');
  assert.deepEqual(acted, ['ui_click']);
  assert.equal(res.steps[0].status, 'failed');
  assert.equal(res.steps[0].verified, 'failed');
  assert.equal(res.steps[1].status, 'pending');
  assert.match(res.message, /не подтвердила|не удалось/i);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].verified, 'failed');
});

test('отсутствие «готово» без подтверждения: verify = unknown и вызов без verify', async () => {
  const loopUnknown = createAgentLoop({
    observe: async () => ({ ok: true, window: { title: 'Редактор' } }),
    act: async () => ({ ok: true }),
    verify: async () => ({ status: 'unknown', evidence: 'значение поля не читается' }),
  });

  const resUnknown = await loopUnknown.run({
    goal: 'сохранить',
    steps: [{ action: 'ui_click', target: { name: 'Сохранить' }, expect: 'Файл сохранён' }],
  });
  assertHonestOutcome(resUnknown, 'needs_human');
  assert.equal(resUnknown.steps[0].status, 'failed');
  assert.equal(resUnknown.steps[0].verified, 'unknown');
  assert.match(resUnknown.message, /не уверен|подтверждения/i);

  // Если verify не передан вообще — по умолчанию всё равно unknown, а не успех.
  const loopNoVerify = createAgentLoop({
    observe: async () => ({ ok: true, window: { title: 'Окно' } }),
    act: async () => ({ ok: true }),
  });
  const resNoVerify = await loopNoVerify.run({
    goal: 'кликнуть',
    steps: [{ action: 'mouse_click', target: { x: 10, y: 20 }, expect: 'Открылось' }],
  });
  assertHonestOutcome(resNoVerify, 'needs_human');
  assert.equal(resNoVerify.steps[0].verified, 'unknown');
});

test('опасный шаг с отказом: approve вернул false -> needs_human, act не вызван, повтора нет', async () => {
  let approveCalls = 0;
  let actCalls = 0;
  const logs = [];

  const loop = createAgentLoop({
    log: (e) => logs.push(e),
    observe: async () => ({ ok: true, window: { title: 'Telegram' } }),
    approve: async (step) => {
      approveCalls += 1;
      assert.equal(step.dangerous, true);
      return false;
    },
    act: async () => { actCalls += 1; return { ok: true }; },
    verify: async () => ({ status: 'confirmed' }),
  });

  const res = await loop.run({
    goal: 'отправить сообщение',
    steps: [{ action: 'ui_click', target: { window: 'Telegram', name: 'Отправить' }, expect: 'Отправлено' }],
  });

  assertHonestOutcome(res, 'needs_human');
  assert.equal(approveCalls, 1);
  assert.equal(actCalls, 0);
  assert.equal(res.steps[0].status, 'skipped');
  assert.match(res.message, /не подтверждено|останавливаюсь без повтора/i);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'skipped');
});

test('опасный шаг с согласием и Enter после ввода текста', async () => {
  const asked = [];
  let seq = 0;

  const loop = createAgentLoop({
    observe: async () => ({ ok: true, window: { title: 'Telegram' }, state: `s${seq}` }),
    approve: async (step) => {
      asked.push(step.action);
      return 'once';
    },
    act: async () => { seq += 1; return { ok: true }; },
    verify: async () => ({ status: 'confirmed', evidence: 'ok' }),
  });

  // 1) Enter без предшествующего ввода текста не считается опасным.
  const plainEnter = await loop.run({
    goal: 'нажать enter',
    steps: [{ action: 'ui_keys', target: { keys: 'enter' }, expect: 'Новая строка' }],
  });
  assertHonestOutcome(plainEnter, 'done');
  assert.deepEqual(asked, []);

  // 2) Ввод текста + Enter: Enter спрашивается и после «once» выполняется.
  const sendWithEnter = await loop.run({
    goal: 'написать и отправить',
    steps: [
      { action: 'ui_type', target: { name: 'Сообщение', text: 'опоздаю' }, expect: 'Текст в поле' },
      { action: 'ui_keys', target: { keys: 'enter' }, expect: 'Сообщение в ленте' },
    ],
  });
  assertHonestOutcome(sendWithEnter, 'done');
  assert.deepEqual(asked, ['ui_keys']);
  assert.equal(sendWithEnter.steps[1].dangerous, true);
});

test('лимит шагов: значение по умолчанию 40 и срабатывание при малом maxSteps', async () => {
  assert.equal(DEFAULT_MAX_STEPS, 40);
  let actCount = 0;
  let stateSeq = 0;

  const loop = createAgentLoop({
    observe: async () => ({ ok: true, window: { title: 'Окно' }, state: `s${stateSeq}` }),
    plan: async ({ stepIndex }) => ({ action: 'ui_keys', target: { keys: `k${stepIndex}` }, expect: 'Сдвиг' }),
    act: async () => { actCount += 1; stateSeq += 1; return { ok: true }; },
    verify: async () => ({ status: 'confirmed', evidence: 'нажато' }),
  });

  const res = await loop.run({ goal: 'длинный цикл', maxSteps: 3 });
  assertHonestOutcome(res, 'limit');
  assert.equal(actCount, 3);
  assert.equal(res.steps.filter((s) => s.status === 'done').length, 3);
  assert.match(res.message, /лимит шагов \(3\)/i);
});

test('таймаут (deadlineMs): остановка без исключений с честным итогом', async () => {
  let clock = 0;
  let stateSeq = 0;

  const loop = createAgentLoop({
    now: () => clock,
    observe: async () => ({ ok: true, window: { title: 'Окно' }, state: `s${stateSeq}` }),
    act: async () => {
      clock += 600;
      stateSeq += 1;
      return { ok: true };
    },
    verify: async () => ({ status: 'confirmed', evidence: 'шаг 1 ок' }),
  });

  const res = await loop.run({
    goal: 'два шага',
    deadlineMs: 500,
    steps: [
      { action: 'ui_click', target: { name: 'Шаг 1' }, expect: 'Экран 2' },
      { action: 'ui_click', target: { name: 'Шаг 2' }, expect: 'Экран 3' },
    ],
  });

  assertHonestOutcome(res, 'timeout');
  assert.equal(res.steps[0].status, 'done');
  assert.equal(res.steps[1].status, 'pending');
  assert.match(res.message, /лимит времени/i);
});

test('отмена (AbortSignal): до старта, во время действия и при ожидании подтверждения', async () => {
  const loop = createAgentLoop({
    observe: async () => ({ ok: true, window: { title: 'Окно' } }),
    approve: async () => new Promise(() => {}), // имитируем долгое ожидание ответа пользователя
    act: async () => ({ ok: true }),
    verify: async () => ({ status: 'confirmed', evidence: 'ok' }),
  });

  // 1) Уже отменён до старта.
  const c1 = new AbortController();
  c1.abort();
  const res1 = await loop.run({
    goal: 'клик',
    signal: c1.signal,
    steps: [{ action: 'ui_click', target: { name: 'Файл' }, expect: 'Меню' }],
  });
  assertHonestOutcome(res1, 'stopped');
  assert.equal(res1.steps[0].status, 'pending');

  // 2) Отмена во время ожидания подтверждения опасного шага не должна зависать.
  const c2 = new AbortController();
  const pendingTurn = loop.run({
    goal: 'удалить',
    signal: c2.signal,
    steps: [{ action: 'ui_click', target: { name: 'Удалить' }, expect: 'Удалено' }],
  });
  setTimeout(() => c2.abort(), 15);
  const res2 = await pendingTurn;
  assertHonestOutcome(res2, 'stopped');
  assert.match(res2.message, /остановлено/i);
});

test('зацикливание: два одинаковых шага подряд без эффекта — не долбить, честно остановиться', async () => {
  let actCount = 0;

  const loop = createAgentLoop({
    observe: async () => ({ ok: true, window: { title: 'Окно' }, elements: [{ id: 'e12ab34', name: 'Далее' }] }),
    plan: async () => ({ action: 'desktop_click', target: { id: 'e12ab34', name: 'Далее' }, expect: 'Страница 2' }),
    act: async () => { actCount += 1; return { ok: true }; },
    verify: async () => ({ status: 'confirmed', evidence: 'клик отправлен' }),
  });

  const res = await loop.run({ goal: 'перейти дальше' });
  assertHonestOutcome(res, 'failed');
  assert.equal(actCount, 1, 'повторный клик не должен выполняться при отсутствии изменений');
  assert.equal(res.steps.length, 2);
  assert.equal(res.steps[1].status, 'skipped');
  assert.match(res.message, /зацикл|одинаковы|эффекта нет/i);
});

test('частичный успех (partial): первый шаг подтверждён, второй провалился', async () => {
  let stepNum = 0;
  const loop = createAgentLoop({
    observe: async () => ({ ok: true, window: { title: 'Рабочий стол' }, state: `s${stepNum}` }),
    act: async () => { stepNum += 1; return { ok: true }; },
    verify: async (step) => {
      if (step.index === 1) return { status: 'confirmed', evidence: 'Edge открыт' };
      return { status: 'failed', evidence: 'Chrome не найден' };
    },
  });

  const res = await loop.run({
    goal: 'открыть сайты',
    steps: [
      { action: 'app_open', target: { app: 'edge' }, expect: 'Окно Edge' },
      { action: 'app_open', target: { app: 'chrome' }, expect: 'Окно Chrome' },
    ],
  });

  assertHonestOutcome(res, 'partial');
  assert.equal(res.steps[0].status, 'done');
  assert.equal(res.steps[0].verified, 'confirmed');
  assert.equal(res.steps[1].status, 'failed');
  assert.match(res.message, /частично.*1 из 2/i);
});

test('пустой план: ни одного шага не выполнено и не названо «готово»', async () => {
  const loop = createAgentLoop({
    observe: async () => ({ ok: true, window: { title: 'Рабочий стол' } }),
    act: async () => { throw new Error('не должно вызываться'); },
    verify: async () => ({ status: 'confirmed' }),
  });

  const resEmptyArray = await loop.run({ goal: 'пусто', steps: [] });
  assertHonestOutcome(resEmptyArray, 'failed');
  assert.equal(resEmptyArray.steps.length, 0);
  assert.match(resEmptyArray.message, /пуст/i);

  const resNullPlanner = await loop.run({ goal: 'пусто', plan: async () => null });
  assertHonestOutcome(resNullPlanner, 'failed');
  assert.equal(resNullPlanner.steps.length, 0);
  assert.match(resNullPlanner.message, /пуст/i);
});

test('сбой наблюдения (нет снимка): честный останов needs_human без вызова act', async () => {
  let actCalled = false;
  const loop = createAgentLoop({
    observe: async () => ({ ok: false, error: 'экран недоступен' }),
    act: async () => { actCalled = true; return { ok: true }; },
    verify: async () => ({ status: 'confirmed' }),
  });

  const res = await loop.run({
    goal: 'прочитать экран',
    steps: [{ action: 'ui_click', target: { name: 'Ок' }, expect: 'Закрыто' }],
  });
  assertHonestOutcome(res, 'needs_human');
  assert.equal(actCalled, false);
  assert.match(res.message, /снимок экрана/i);
});

test('логи и память не содержат секретов и текста личных сообщений', async () => {
  const logs = [];
  let stateSeq = 0;
  const secretMsg = 'Встретимся в 19:00, код 994411';
  const apiToken = 'sk-secret-token-1234567890abcdef';

  const loop = createAgentLoop({
    log: (e) => logs.push(e),
    observe: async () => ({ ok: true, window: { title: 'Telegram' }, state: `s${stateSeq}` }),
    approve: async () => true,
    act: async () => { stateSeq += 1; return { ok: true }; },
    verify: async () => ({ status: 'confirmed', evidence: `поле заполнено, token=${apiToken}` }),
  });

  const res = await loop.run({
    goal: 'написать сообщение',
    steps: [
      {
        action: 'ui_type',
        target: { window: 'Telegram', name: 'Сообщение', text: secretMsg, password: 'my-secret-password' },
        expect: `текст виден, password=${apiToken}`,
      },
    ],
  });

  assertHonestOutcome(res, 'done');
  const serializedLogs = JSON.stringify(logs);
  const serializedResult = JSON.stringify(res);
  assert.equal(serializedLogs.includes(secretMsg), false, 'личный текст не должен попадать в лог');
  assert.equal(serializedLogs.includes('my-secret-password'), false, 'пароль не должен попадать в лог');
  assert.equal(serializedLogs.includes(apiToken), false, 'токен не должен попадать в лог');
  assert.equal(serializedResult.includes(secretMsg), false, 'личный текст не должен попадать в память шагов');
  assert.equal(serializedResult.includes(apiToken), false, 'токен не должен попадать в evidence');
});

test('застой из наблюдения (stalled: true) и сбой act ({ ok: false } / throw)', async () => {
  const stalledLoop = createAgentLoop({
    observe: async ({ phase }) => ({
      ok: true,
      window: { title: 'Окно' },
      stalled: phase === 'after_step',
    }),
    act: async () => ({ ok: true }),
    verify: async () => ({ status: 'confirmed', evidence: 'клик прошёл' }),
  });
  const resStalled = await stalledLoop.run({
    goal: 'нажать',
    steps: [
      { action: 'ui_click', target: { name: 'А' }, expect: 'Экран Б' },
      { action: 'ui_click', target: { name: 'Б' }, expect: 'Экран В' },
    ],
  });
  assertHonestOutcome(resStalled, 'failed');
  assert.match(resStalled.message, /не меняется/i);

  const actFailLoop = createAgentLoop({
    observe: async () => ({ ok: true, window: { title: 'Окно' } }),
    act: async () => ({ ok: false, error: 'элемент недоступен' }),
    verify: async () => { throw new Error('verify не должен вызываться при ok: false'); },
  });
  const resActFail = await actFailLoop.run({
    goal: 'нажать',
    steps: [{ action: 'ui_click', target: { name: 'Кнопка' }, expect: 'Открылось' }],
  });
  assertHonestOutcome(resActFail, 'failed');
  assert.equal(resActFail.steps[0].status, 'failed');
  assert.match(resActFail.message, /элемент недоступен/i);
});

test('опасный шаг с подтверждением (Отправить): выполняется после approve = true', async () => {
  let asked = 0;
  let acted = 0;
  let stateSeq = 0;

  const loop = createAgentLoop({
    observe: async () => ({ ok: true, window: { title: 'Telegram' }, state: `s${stateSeq}` }),
    approve: async (step) => {
      asked += 1;
      assert.equal(step.dangerous, true);
      return true;
    },
    act: async () => { acted += 1; stateSeq += 1; return { ok: true }; },
    verify: async () => ({ status: 'confirmed', evidence: 'сообщение появилось в чате' }),
  });

  const res = await loop.run({
    goal: 'отправить',
    steps: [{ action: 'ui_click', target: { window: 'Telegram', name: 'Отправить' }, expect: 'Сообщение в чате' }],
  });
  assertHonestOutcome(res, 'done');
  assert.equal(asked, 1);
  assert.equal(acted, 1);
});
