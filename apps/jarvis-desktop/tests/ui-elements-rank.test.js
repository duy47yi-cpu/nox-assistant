'use strict';

// Порядок элементов окна (идея Ghosthand): фокус и результат — вперёд, под текст результата
// резервируются места, чтобы сорок кнопок не вытеснили «Результат: 95»; лимит и бюджет соблюдаются.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankElements, SCRIPTS } = require('../src/tools/ui');

function button(i, extra = {}) {
  return { name: `Кнопка ${i}`, type: 'Button', enabled: true, value: '', bounds: { x: 10, y: i * 20, w: 40, h: 20 }, ...extra };
}

test('текст результата не вытесняется сорока кнопками', () => {
  const items = Array.from({ length: 50 }, (_, i) => button(i));
  items.push({ name: 'Результат: 95', type: 'Text', enabled: true, value: '95', bounds: { x: 10, y: 2000, w: 120, h: 20 } });

  const ranked = rankElements(items, { limit: 40 });
  assert.equal(ranked.items.length, 40);
  const result = ranked.items.find((item) => /Результат/.test(item.name));
  assert.ok(result, 'результат остался в выдаче');
  const texts = ranked.items.filter((item) => item.type === 'Text');
  assert.ok(texts.length <= 8, `под текст не больше 8 мест, а ${texts.length}`);
  assert.equal(ranked.truncated, true, 'часть элементов не поместилась');
});

test('элемент с фокусом идёт первым', () => {
  const items = [button(1), button(2), button(3, { focus: true }), button(4)];
  const ranked = rankElements(items, { limit: 10 });
  assert.equal(ranked.items[0].name, 'Кнопка 3');
  assert.equal(ranked.items[0].focus, true);
});

test('бюджет символов соблюдается', () => {
  const items = Array.from({ length: 100 }, (_, i) => button(i, { name: `Очень длинное название кнопки номер ${i} ${'я'.repeat(60)}` }));
  const ranked = rankElements(items, { limit: 60, budget: 2000 });
  const used = ranked.items.reduce((sum, item) => sum + String(item.name).length + String(item.value || '').length + String(item.type).length + 70, 0);
  assert.ok(used <= 2000, `бюджет не превышен: ${used}`);
  assert.equal(ranked.truncated, true);
});

test('сбор элементов кеширует фокус и больше не режет по старому лимиту в PowerShell', () => {
  assert.ok(SCRIPTS.ui_elements.includes('HasKeyboardFocusProperty'), 'фокус кешируется');
  assert.equal(SCRIPTS.ui_elements.includes('$budget -gt 6500'), false, 'лимит и бюджет считает JS');
});
