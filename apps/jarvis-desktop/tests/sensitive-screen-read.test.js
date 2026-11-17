'use strict';

// Живой состязательный прогон (фраза 61): чтение окна менеджера паролей проходило без вопроса.
// Теперь инструменты сцены отказываются читать такие окна. Окно банка читать можно (нужно для «покажи баланс»),
// но действовать в нём запрещает политика — это проверяет hardDeny в существующих тестах.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { observeTools } = require('../src/tools/observe');
const { hardDeny } = require('../src/policy/modes');

function fakeUi(windows) {
  return [
    { name: 'ui_windows', async run() { return { ok: true, data: { windows } }; } },
    { name: 'ui_elements', async run() { return { ok: true, data: { elements: [], total: 0 } }; } },
    { name: 'ui_click', async run() { return { ok: true, summary: 'клик' }; } },
    { name: 'ui_type', async run() { return { ok: true, summary: 'ввод' }; } },
  ];
}
const WINDOWS = [
  { title: 'Bitwarden — хранилище', active: true, handle: '1', process: 'Bitwarden' },
  { title: 'Сбербанк Онлайн — вход', active: false, handle: '2', process: 'browser' },
  { title: 'Блокнот — заметки', active: false, handle: '3', process: 'notepad' },
];
const byName = (tools, name) => tools.find((t) => t.name === name);

test('окно менеджера паролей не читается, отказ назван', async () => {
  const tools = observeTools(fakeUi(WINDOWS));
  const res = await byName(tools, 'desktop_observe').run({ window: 'Bitwarden' });
  assert.equal(res.ok, false);
  assert.match(String(res.summary), /не читаю/);
  assert.match(String(res.summary), /парол/i);
});

test('окно банка читается, но действие в нём политика запрещает', async () => {
  const tools = observeTools(fakeUi(WINDOWS));
  const res = await byName(tools, 'desktop_observe').run({ window: 'Сбербанк' });
  assert.equal(res.ok, true, 'чтение банка нужно для «покажи баланс»');
  const deny = hardDeny({ name: 'ui_type', args: { window: 'Сбербанк Онлайн — вход' } });
  assert.match(String(deny), /запрет/);
});

test('обычное окно читается как раньше', async () => {
  const tools = observeTools(fakeUi(WINDOWS));
  const res = await byName(tools, 'desktop_observe').run({ window: 'Блокнот' });
  assert.equal(res.ok, true, res.summary);
});
