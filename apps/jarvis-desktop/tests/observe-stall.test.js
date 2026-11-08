'use strict';

// Счётчик застоя (идея Ghosthand): если после действий экран не меняется несколько раз подряд,
// агент должен остановиться и сказать владельцу, а не кликать вслепую до конца шагов.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { observeTools } = require('../src/tools/observe');

function fixture() {
  const state = {
    items: [
      { role: 'Button', name: 'Семь' },
      { role: 'Button', name: 'Восемь' },
      { role: 'Text', name: 'Результат: 0' },
    ],
  };
  const ui = [
    { name: 'ui_windows', run: async () => ({ ok: true, data: { windows: [{ title: 'Калькулятор', process: 'calc.exe', handle: '1' }] } }) },
    { name: 'ui_elements', run: async () => ({ ok: true, data: { elements: state.items, total: state.items.length } }) },
    { name: 'ui_click', run: async () => ({ ok: true, summary: 'нажал «Семь»' }) },
  ];
  const tools = observeTools(ui);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { state, tools: byName };
}

async function firstElementId(tools) {
  const observed = await tools.desktop_observe.run({ window: 'Калькулятор' });
  assert.equal(observed.ok, true);
  return observed.data.scene.elements.find((element) => element.role === 'Button').id;
}

test('три действия подряд без изменений помечают застой и останавливают', async () => {
  const { tools } = fixture();
  const id = await firstElementId(tools);

  const first = await tools.desktop_click.run({ id });
  assert.equal(first.ok, true);
  assert.equal(first.data.stalled, false, 'после первого действия застоя нет');

  const second = await tools.desktop_click.run({ id });
  assert.equal(second.data.stalled, false, 'двух действий мало');

  const third = await tools.desktop_click.run({ id });
  assert.equal(third.data.stalled, true, 'на третьем действии без изменений — застой');
  assert.match(third.summary, /не меняется|без изменений/);
  assert.match(third.data.afterNote || '', /не повторяй/);

  const verdict = await tools.desktop_click.verify({}, third);
  assert.equal(verdict.status, 'unknown');
  assert.match(verdict.evidence, /не меняется|без изменений/);
});

test('изменение экрана сбрасывает счётчик застоя', async () => {
  const { tools, state } = fixture();
  const id = await firstElementId(tools);
  await tools.desktop_click.run({ id });
  await tools.desktop_click.run({ id });
  const stalled = await tools.desktop_click.run({ id });
  assert.equal(stalled.data.stalled, true);

  state.items = [...state.items, { role: 'Text', name: 'Результат: 7' }];
  const afterChange = await tools.desktop_click.run({ id });
  assert.equal(afterChange.ok, true);
  assert.equal(afterChange.data.stalled, false, 'после изменения экрана счётчик сброшен');
  assert.doesNotMatch(afterChange.data.afterNote || '', /не повторяй/);
});

test('новый снимок экрана начинает счёт заново', async () => {
  const { tools } = fixture();
  const id = await firstElementId(tools);
  await tools.desktop_click.run({ id });
  await tools.desktop_click.run({ id });
  // Модель сама перечитала экран: это осознанная проверка, счётчик действий начинается заново.
  await tools.desktop_observe.run({ window: 'Калькулятор' });
  const next = await tools.desktop_click.run({ id });
  assert.equal(next.data.stalled, false);
});
