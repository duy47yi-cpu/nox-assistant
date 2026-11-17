'use strict';

// Итог хода не должен противоречить журналу: подтверждённый клик при «не проверенном» снимке
// экрана — это «Готово», а не «Не подтверждено». Итог понижают действия, а не наблюдения.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const { READ_ONLY_STATUS_ACTIONS, isReadOnlyStatusTool, hasUnverifiedAction } = require('../src/agent/chat-reply');

function scriptedBrain(steps) {
  let i = 0;
  const brain = {
    calls: 0,
    async chat() {
      brain.calls += 1;
      const s = steps[i++];
      if (!s) throw new Error('сценарий закончился');
      return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] };
    },
  };
  return brain;
}

function tool(name, risk, run, verify) {
  return { name, risk, description: name, parameters: { type: 'object', properties: {} }, ...(verify ? { verify } : {}), run };
}

function setup(t, { toolList, steps }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-turn-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reg = new ToolRegistry();
  for (const item of toolList) reg.register(item);
  const events = [];
  const agent = new Agent({
    brain: scriptedBrain(steps),
    tools: reg,
    policy: () => 'allow',
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'full',
    workspace: dir,
    chatReplies: true,
  });
  return { agent, events };
}

const doneOf = (events) => events.find((e) => e.type === 'done');

const confirmedClick = tool('ui_click', 'T1',
  async () => ({ ok: true, summary: 'нажал «Отметить»' }),
  async () => ({ status: 'confirmed', evidence: 'флажок переключён' }));
const unverifiedClick = tool('ui_click', 'T1', async () => ({ ok: true, summary: 'нажал' }));
const screenLook = tool('screen_look', 'T1', async () => ({ ok: true, summary: 'снимок экрана' }));

test('подтверждённый клик + «не проверенный» снимок экрана → итог «Готово» (succeeded)', async (t) => {
  const { agent, events } = setup(t, {
    toolList: [screenLook, confirmedClick],
    steps: [
      { toolCalls: [{ id: 'l1', name: 'screen_look', args: {} }] },
      { toolCalls: [{ id: 'c1', name: 'ui_click', args: { window: 'Тестовый чат', name: 'Отметить' } }] },
      { content: 'Готово: флажок «Отметить» переключён и подтверждён.' },
    ],
  });
  const res = await agent.run('Сделай на экране: отметь флажок');
  const done = doneOf(events);
  assert.equal(res.outcome, 'answer');
  assert.equal(done.status, 'succeeded', 'подтверждённое действие руками не превращается в «Не подтверждено»');
  // Сводка проверки по шагам честно помнит, что снимок экрана не проверялся: это журнал, не итог хода.
  assert.equal(done.verification.unverified, 1);
});

test('подтверждённый клик + автоснимок (args.auto) → итог «Готово» (succeeded)', async (t) => {
  const { agent, events } = setup(t, {
    toolList: [screenLook, confirmedClick],
    steps: [
      { toolCalls: [{ id: 'l1', name: 'screen_look', args: { auto: true } }] },
      { toolCalls: [{ id: 'c1', name: 'ui_click', args: { window: 'Тестовый чат', name: 'Отметить' } }] },
      { content: 'Готово: флажок «Отметить» переключён и подтверждён.' },
    ],
  });
  await agent.run('Сделай на экране: отметь флажок');
  assert.equal(doneOf(events).status, 'succeeded');
});

test('только чтения без действий руками → итог не понижается', async (t) => {
  const { agent, events } = setup(t, {
    toolList: [screenLook],
    steps: [
      { toolCalls: [{ id: 'l1', name: 'screen_look', args: {} }] },
      { content: 'В окне видны элементы: «Отметить», «Отправить».' },
    ],
  });
  await agent.run('Сделай на экране: прочитай, что написано на экране');
  assert.equal(doneOf(events).status, 'succeeded');
});

test('модель видит «не проверено» в ответе инструмента без своей проверки', async (t) => {
  const toolList = [tool('act', 'T1', async () => ({ ok: true, summary: 'сделал' }))];
  const seen = [];
  let round = 0;
  const brain = {
    async chat({ messages }) {
      if (messages) seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      round += 1;
      return round === 1
        ? { content: '', toolCalls: [{ id: 'a1', name: 'act', args: {} }] }
        : { content: 'Сделал, но не проверил.', toolCalls: [] };
    },
  };
  const { agent } = setup(t, { toolList, steps: [] });
  agent.brain = brain;
  await agent.run('сделай действие');
  const last = seen.at(-1) || [];
  const toolMessage = last.filter((m) => m.role === 'tool').at(-1);
  assert.ok(toolMessage, 'ответ инструмента должен быть в контексте модели');
  const parsed = JSON.parse(toolMessage.content);
  assert.equal(parsed.verified, 'unknown', 'модель получает verified:unknown, если проверки не было');
  assert.match(String(parsed.summary), /не проверено/i, 'summary объясняет, почему эффект не подтверждён');
});

test('сам клик вернул unverified (проверки нет) → итог «Не подтверждено» (unverified)', async (t) => {
  const { agent, events } = setup(t, {
    toolList: [screenLook, unverifiedClick],
    steps: [
      { toolCalls: [{ id: 'l1', name: 'screen_look', args: {} }] },
      { toolCalls: [{ id: 'c1', name: 'ui_click', args: { window: 'Тестовый чат', name: 'Отметить' } }] },
      { content: 'Готово: флажок переключён.' },
    ],
  });
  await agent.run('Сделай на экране: отметь флажок');
  assert.equal(doneOf(events).status, 'unverified', 'неподтверждённое действие руками остаётся «Не подтверждено»');
});

test('подтверждающее чтение снимает «Не подтверждено» у непроверенного действия', async (t) => {
  const { agent, events } = setup(t, {
    toolList: [
      tool('windows_snap', 'T1', async () => ({ ok: true, summary: 'окно слева' })),
      tool('windows_list', 'T0', async () => ({ ok: true, summary: 'окон: 1' })),
    ],
    steps: [
      { toolCalls: [{ id: 's1', name: 'windows_snap', args: { title: 'Тестовое окно' } }] },
      { toolCalls: [{ id: 'w1', name: 'windows_list', args: {} }] },
      { content: 'Окно «Тестовое окно» стоит слева.' },
    ],
  });
  await agent.run('Поставь окно слева');
  const done = doneOf(events);
  assert.equal(done.status, 'succeeded', 'после подтверждающего чтения итог не держит «Не подтверждено»');
  assert.equal(done.verification.unverified, 1, 'журнал по-прежнему помнит, что проверки у snap не было');
});

test('клик с проверкой «не удалось» (unknown) → итог «Не подтверждено» (unverified)', async (t) => {
  const { agent, events } = setup(t, {
    toolList: [screenLook, tool('ui_click', 'T1',
      async () => ({ ok: true, summary: 'нажал' }),
      async () => ({ status: 'unknown', evidence: 'нечем проверить' }))],
    steps: [
      { toolCalls: [{ id: 'l1', name: 'screen_look', args: {} }] },
      { toolCalls: [{ id: 'c1', name: 'ui_click', args: { window: 'Тестовый чат', name: 'Отметить' } }] },
      { content: 'Нажал, но подтвердить не смог.' },
    ],
  });
  await agent.run('Сделай на экране: отметь флажок');
  assert.equal(doneOf(events).status, 'unverified');
});

test('служебные id инструментов и «Шаг N» вычищаются из текста ответа', async (t) => {
  const { agent, events } = setup(t, {
    toolList: [tool('remind_in', 'T0', async () => ({ ok: true, summary: 'напоминание' }))],
    steps: [{ content: 'Готово: напоминание. - Шаг 1 (remind_in): подтверждено — напомню через 20 мин' }],
  });
  await agent.run('Напомни через 20 минут');
  const done = doneOf(events);
  assert.doesNotMatch(String(done.replyText), /remind_in|Шаг\s*1/, 'в ответе не должно быть служебных id и формата шагов');
  assert.match(String(done.replyText), /напоминание/i);
  assert.doesNotMatch(String(agent.history.at(-1).content), /remind_in|Шаг\s*1/);
});

test('текст без модели (remember) тоже очищается от служебных id', async (t) => {
  const { agent } = setup(t, {
    toolList: [tool('remind_in', 'T0', async () => ({ ok: true, summary: 'напоминание' }))],
    steps: [],
  });
  agent.remember('Напомни через 20 минут', 'Готово: напоминание. - Шаг 1 (remind_in): подтверждено');
  assert.doesNotMatch(String(agent.history.at(-1).content), /remind_in|Шаг\s*1/);
  assert.match(String(agent.history.at(-1).content), /напоминание/i);
});

test('«Нет данных» и отказ — нейтральный итог «Ответ», а не «Готово»', async (t) => {
  for (const content of ['Нет данных: баланса карты не вижу.', 'Оплату не оформляю — это запрещено.']) {
    const { agent, events } = setup(t, { toolList: [], steps: [{ content }] });
    await agent.run('Вопрос');
    const done = doneOf(events);
    assert.equal(done.status, 'answered', content);
    assert.equal(done.verification.confirmed + done.verification.unverified + done.verification.failed, 0);
  }
});

test('обычный ответ без действий остаётся «Готово», ложного «Ответ» нет', async (t) => {
  const { agent, events } = setup(t, { toolList: [], steps: [{ content: 'Сегодня ясно, около +12.' }] });
  await agent.run('Какая погода?');
  assert.equal(doneOf(events).status, 'succeeded');
});

test('чтение + «Нет данных» остаётся нейтральным (действий с эффектом не было)', async (t) => {
  const readTool = tool('workspace_list', 'T0', async () => ({ ok: true, summary: 'файлов: 0' }));
  const { agent, events } = setup(t, {
    toolList: [readTool],
    steps: [
      { toolCalls: [{ id: 'w1', name: 'workspace_list', args: {} }] },
      { content: 'Нет данных: в рабочей папке пусто.' },
    ],
  });
  await agent.run('Что в папке?');
  assert.equal(doneOf(events).status, 'answered');
});

test('наблюдения не понижают итог, действия — понижают', () => {
  // Снимки, окна и чтения — наблюдение: проверки эффекта у них нет и итог хода они не трогают.
  for (const name of ['screen_look', 'screen_region_look', 'desktop_observe', 'ui_windows', 'ui_elements', 'workspace_read', 'read_file']) {
    assert.equal(isReadOnlyStatusTool(name), true, name);
    assert.ok(READ_ONLY_STATUS_ACTIONS.has(name) || name === 'read_file', name);
  }
  // Реальные действия без подтверждения понижают итог до «не проверено».
  for (const name of ['ui_click', 'desktop_click', 'ui_type', 'desktop_type', 'ui_keys', 'mouse_click', 'mouse_scroll', 'shell_run', 'workspace_write']) {
    assert.equal(isReadOnlyStatusTool(name), false, name);
  }
  // Автоснимок — тоже наблюдение, даже если у инструмента есть имя действия.
  assert.equal(isReadOnlyStatusTool('ui_click', { auto: true }), true);
  assert.equal(isReadOnlyStatusTool('screen_look', { auto: true }), true);
  // hasUnverifiedAction работает по записям шага (имя + args).
  assert.equal(hasUnverifiedAction([{ tool: 'screen_look', status: 'unverified' }]), false);
  assert.equal(hasUnverifiedAction([{ tool: 'ui_click', status: 'unverified' }]), true);
  assert.equal(hasUnverifiedAction([{ tool: 'ui_click', status: 'succeeded' }]), false);
  assert.equal(hasUnverifiedAction([{ tool: 'ui_click', status: 'unverified', args: { auto: true } }]), false);
  assert.equal(hasUnverifiedAction(null), false);
});
