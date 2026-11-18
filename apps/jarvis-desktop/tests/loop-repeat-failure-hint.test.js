'use strict';

// Ловушка Л7: владелец повторил ту же просьбу после неудачи. Модель должна назвать объект
// или уточнить, а не повторять тот же вызов вслепую. Подсказка детерминированная и только для модели.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Agent, repeatFailureHint } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

function turn(phrase, tool, result) {
  return [
    { role: 'user', content: phrase },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: tool, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(result) },
    { role: 'assistant', content: 'Не удалось завершить: закрыть окно.' },
  ];
}

test('повтор той же фразы после неудачного действия — подсказка не повторять вслепую', () => {
  const history = turn('закрой окно', 'window_close_active', { ok: false, summary: 'это окно Джарвиса или Windows, его не закрываю' });
  history.push({ role: 'user', content: 'закрой окно' });
  const hint = repeatFailureHint(history);
  assert.match(hint, /Прошлая попытка того же действия не удалась/i);
  assert.match(hint, /не повторяй тот же вызов вслепую/i);
  assert.match(hint, /назови объект по имени/i);
});

test('другая новая фраза — обычный ход без подсказки', () => {
  const history = turn('закрой окно', 'window_close_active', { ok: false, summary: 'не закрываю' });
  history.push({ role: 'user', content: 'открой блокнот' });
  assert.equal(repeatFailureHint(history), '');
});

test('успешное действие не даёт подсказки о неудаче', () => {
  const history = turn('закрой окно', 'window_close_active', { ok: true, summary: 'закрыто' });
  history.push({ role: 'user', content: 'закрой окно' });
  assert.equal(repeatFailureHint(history), '');
});

test('повтор после неудачного чтения — это сверка состояния, подсказки нет', () => {
  const history = turn('закрой окно', 'windows_list', { ok: false, summary: 'список не получен' });
  history.push({ role: 'user', content: 'закрой окно' });
  assert.equal(repeatFailureHint(history), '');
});

test('повторный вход инструмента (fromTool) не считается фразой владельца', () => {
  const history = turn('закрой окно', 'window_close_active', { ok: false, summary: 'не закрываю' });
  history.push({ role: 'user', content: 'закрой окно', fromTool: true });
  history.push({ role: 'assistant', content: 'ещё думаю' });
  history.push({ role: 'user', content: 'закрой окно' });
  // Предыдущая реплика владельца — в начале прошлого хода, фраза та же: подсказка уместна.
  assert.match(repeatFailureHint(history), /Прошлая попытка/i);
});

test('Agent кладёт подсказку в контекст последней реплики владельца', async () => {
  const tools = new ToolRegistry();
  const seen = [];
  const brain = {
    chat: async ({ messages }) => {
      seen.push(messages);
      return { content: 'Уточню: какое окно закрыть?', toolCalls: [] };
    },
  };
  const history = turn('закрой окно', 'window_close_active', { ok: false, summary: 'это окно Джарвиса или Windows, его не закрываю' });
  const agent = new Agent({
    brain,
    tools,
    policy: () => 'allow',
    journal: { append: () => {} },
    emit: () => {},
    mode: 'full',
    workspace: process.cwd(),
    history,
  });
  await agent.run('закрой окно');
  const lastUser = seen[0].filter((m) => m.role === 'user').at(-1);
  const text = String((lastUser && lastUser.content) || '');
  assert.match(text, /Прошлая попытка того же действия не удалась/i);
  assert.match(text, /не повторяй тот же вызов вслепую/i);
});
