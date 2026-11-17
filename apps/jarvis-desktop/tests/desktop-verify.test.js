'use strict';

// P0-2: честная проверка. Слабые признаки (смена окна, закрытие, число элементов, исчезновение)
// не подтверждают нажатие; мышь по координатам не подтверждается ничем; failed вложенной проверки
// не смягчается до unknown; чтение (T0) не считается подтверждённым действием.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { clickVerdict } = require('../src/tools/ui');
const { observeTools } = require('../src/tools/observe');
const { checkEffect } = require('../src/agent/effects');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

const win = (over = {}) => ({ alive: true, fg: 1, readable: true, title: 'Окно', count: 10, tops: 1, ...over });
const target = (over = {}) => ({ found: 'ok', name: 'Кнопка', enabled: true, toggle: null, selected: null, expand: null, ...over });

function el(name, type, extra = {}) {
  return { name, type, enabled: true, value: '', ...extra };
}

function fakeUi(sequence, extra = []) {
  const calls = { elements: 0 };
  const windows = {
    name: 'ui_windows',
    async run() {
      return { ok: true, summary: 'окна', data: { windows: [{ title: 'Блокнот — привет.txt', process: 'notepad', handle: 1 }, { title: 'Проводник', process: 'explorer', handle: 2 }] } };
    },
  };
  const elements = {
    name: 'ui_elements',
    async run(args) {
      const items = sequence[Math.min(calls.elements, sequence.length - 1)];
      calls.elements += 1;
      return { ok: true, summary: 'элементы', data: { window: args.window, total: items.length, elements: items } };
    },
  };
  return { ui: [windows, elements, ...extra], calls };
}

function fakeAction(name) {
  const calls = [];
  return { calls, tool: { name, async run(args) { calls.push(args); return { ok: true, summary: `${name}: ок`, data: {} }; } } };
}

describe('B-1: clickVerdict подтверждает только собственное состояние элемента', () => {
  const base = { before: win(), target: target(), noisy: false };

  test('смена заголовка окна не подтверждает', () => {
    assert.equal(clickVerdict({ ...base, after: win({ title: 'Новый' }), targetAfter: target() }, { method: 'invoke' }).status, 'unknown');
  });

  test('число элементов не подтверждает', () => {
    assert.equal(clickVerdict({ ...base, after: win({ count: 12 }), targetAfter: target() }, { method: 'invoke' }).status, 'unknown');
  });

  test('исчезновение элемента не подтверждает нажатие кнопки', () => {
    assert.equal(clickVerdict({ ...base, after: win(), targetAfter: { found: 'not_found' } }, { method: 'invoke' }).status, 'unknown');
  });

  test('переключатель и выбор подтверждают, отсутствие изменения — failed', () => {
    const c = (tb, ta) => ({ before: win(), after: win(), target: target(tb), targetAfter: target(ta), noisy: false });
    assert.equal(clickVerdict(c({ toggle: 'Off' }, { toggle: 'On' }), { method: 'toggle' }).status, 'confirmed');
    assert.equal(clickVerdict(c({ selected: false }, { selected: true }), { method: 'select' }).status, 'confirmed');
    assert.equal(clickVerdict(c({ toggle: 'Off' }, { toggle: 'Off' }), { method: 'toggle' }).status, 'failed');
  });
});

describe('B-2: мышь по координатам не подтверждается', () => {
  test('fallback с появлением элемента всё равно unknown', async () => {
    const nameless = el('', 'Button', { bounds: { x: 10, y: 20, w: 30, h: 40 } });
    const frames = [[nameless], [nameless], [nameless, el('Готово', 'Text')]];
    const mouse = { name: 'mouse_click', async run() { return { ok: true, summary: 'нажатие', data: {} }; } };
    const { ui } = fakeUi(frames);
    const tools = observeTools(ui, { mouse: [mouse] });
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const byId = tools.find((t) => t.name === 'desktop_click');
    const id = seen.data.scene.elements[0].id;
    const result = await byId.run({ id });
    assert.equal(result.ok, true);
    assert.equal(result.data.fallback, true);
    assert.equal(result.data.diff.added.length, 1);
    const verdict = await byId.verify({ id }, result);
    assert.equal(verdict.status, 'unknown');
    assert.match(verdict.evidence, /мышью|координатам/);
  });
});

describe('B-3: failed вложенной проверки остаётся failed', () => {
  test('desktop_click: failed → ok=false после checkEffect', async () => {
    const frames = [[el('Далее', 'Button')], [el('Далее', 'Button')], [el('Далее', 'Button'), el('Страница 2', 'Text')]];
    const click = fakeAction('ui_click');
    click.tool.verify = async () => ({ status: 'failed', evidence: 'кнопка не сработала' });
    const { ui } = fakeUi(frames, [click.tool]);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const byId = tools.find((t) => t.name === 'desktop_click');
    const id = seen.data.scene.elements[0].id;
    const result = await byId.run({ id });
    assert.equal(result.ok, true);
    assert.equal((await byId.verify({ id }, result)).status, 'failed');
    const checked = await checkEffect(byId, { id }, result, {});
    assert.equal(checked.ok, false);
    assert.equal(checked.verified, 'failed');
  });

  test('desktop_type: failed → ok=false после checkEffect', async () => {
    const frames = [[el('Поиск', 'Edit', { value: '' })], [el('Поиск', 'Edit', { value: '' })], [el('Поиск', 'Edit', { value: 'привет' })]];
    const type = fakeAction('ui_type');
    type.tool.verify = async () => ({ status: 'failed', evidence: 'в поле другой текст' });
    const { ui } = fakeUi(frames, [type.tool]);
    const tools = observeTools(ui);
    const seen = await tools.find((t) => t.name === 'desktop_observe').run({ window: 'Блок' });
    const byId = tools.find((t) => t.name === 'desktop_type');
    const id = seen.data.scene.elements[0].id;
    const result = await byId.run({ id, text: 'привет' });
    assert.equal(result.ok, true);
    assert.equal((await byId.verify({ id, text: 'привет' }, result)).status, 'failed');
    const checked = await checkEffect(byId, { id, text: 'привет' }, result, {});
    assert.equal(checked.ok, false);
    assert.equal(checked.verified, 'failed');
  });
});

describe('B-4: чтение — не подтверждённое действие', () => {
  const obj = { type: 'object', properties: {} };
  const say = (content) => ({ content, toolCalls: [] });
  const call = (id, name, args = {}) => ({ content: '', toolCalls: [{ id, name, args }] });

  test('три desktop_observe и один подтверждённый клик: confirmed=1, reads=3', async () => {
    const tools = new ToolRegistry();
    tools.register({ name: 'desktop_observe', risk: 'T0', description: 'x', parameters: obj, run: async () => ({ ok: true, summary: 'сцена' }), verify: async () => ({ status: 'confirmed', evidence: 'снимок' }) });
    tools.register({ name: 'desktop_click', risk: 'T1', description: 'x', parameters: obj, run: async () => ({ ok: true, summary: 'нажал' }), verify: async () => ({ status: 'confirmed', evidence: 'эффект' }) });
    const steps = [
      call('1', 'desktop_observe', { window: 'Окно' }),
      call('2', 'desktop_observe', { window: 'Окно' }),
      call('3', 'desktop_observe', { window: 'Окно' }),
      call('4', 'desktop_click', { id: 'e12ab34cdef01' }),
      say('готово'),
    ];
    const brain = { chat: async () => steps.shift() || say('готово') };
    let done = null;
    const agent = new Agent({ brain, tools, policy: () => 'allow', journal: { append() {} }, mode: 'full', emit: (ev) => { if (ev.type === 'done') done = ev; } });
    await agent.run('сделай');
    assert.ok(done, 'done отправлен');
    assert.equal(done.verification.confirmed, 1);
    assert.equal(done.verification.reads, 3);
  });
});