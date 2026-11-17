'use strict';

// P0-3 (D-1): опасный шаг закрыт для всех рук, а не только ui_click/ui_type.
// desktop_click/desktop_type/mouse_click по id/координатам берут подпись из сцены (resolveSceneTarget);
// ctrl+enter/shift+enter/alt+enter разбираются по последней клавише; закрытие окна спрашивается всегда;
// desktop_type тоже ставит _typed, и частичный ввод (unknown) считается.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ScreenAgent, isDangerousStep, dangerLabel } = require('../src/screen/agent');
const { isDangerousStep: loopDanger } = require('../src/screen/agent-loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const modes = require('../src/policy/modes');

const SEND_ID = 'e12ab34cdef01';
const FIELD_ID = 'e12ab34cdef02';

// Сцена с кнопкой «Отправить» и полем «Поиск»: подпись для desktop_* берётся отсюда, в аргументах только id.
function scene() {
  return {
    window: { title: 'Форма', handle: 1, process: 'app' },
    elements: [
      { id: SEND_ID, name: 'Отправить', type: 'Button', bounds: { x: 10, y: 20, w: 100, h: 40 } },
      { id: FIELD_ID, name: 'Поиск', type: 'Edit', bounds: { x: 10, y: 80, w: 200, h: 30 } },
    ],
  };
}

function withScene(t, sc = scene()) {
  modes.setSceneSource(() => sc);
  t.after(() => modes.setSceneSource(null));
  return sc;
}

describe('D-1 матрица: инструмент × признак', () => {
  test('ui_click: отправка, ответ, подтверждение, удаление, установка, оплата — опасны; сохранение — нет', () => {
    for (const label of ['Отправить', 'Ответить', 'Подтвердить', 'Удалить', 'Установить', 'Оплатить', 'Переслать', 'Send', 'Reply', 'Confirm']) {
      assert.equal(isDangerousStep('ui_click', { name: label }), true, `«${label}» — опасный шаг`);
    }
    for (const label of ['Сохранить', 'Файл', 'Отмена', 'Поиск']) {
      assert.equal(isDangerousStep('ui_click', { name: label }), false, `«${label}» — безопасный шаг`);
    }
  });

  test('ui_keys: Enter с модификатором после ввода — опасен, без ввода — нет', () => {
    for (const keys of ['enter', 'return', 'ctrl+enter', 'shift+enter', 'alt+enter', 'Control+Enter', 'tab enter']) {
      assert.equal(isDangerousStep('ui_keys', { keys }, { typed: true }), true, `«${keys}» после ввода — отправка`);
      assert.equal(isDangerousStep('ui_keys', { keys }, { typed: false }), false, `«${keys}» без ввода — не отправка`);
    }
    assert.equal(isDangerousStep('ui_keys', { keys: 'ctrl+s' }, { typed: true }), false);
    assert.equal(isDangerousStep('ui_keys', { keys: 'tab' }, { typed: true }), false);
  });

  test('desktop_click/desktop_type/mouse_click: подпись из сцены, а не из аргументов', (t) => {
    withScene(t);
    assert.equal(isDangerousStep('desktop_click', { id: SEND_ID }), true, 'кнопка «Отправить» по id');
    assert.equal(isDangerousStep('desktop_click', { id: FIELD_ID }), false, 'поле «Поиск» по id — не опасно');
    assert.equal(isDangerousStep('desktop_type', { id: FIELD_ID, text: 'привет' }), false);
    // mouse_click по координатам центра кнопки «Отправить» (10+50, 20+20).
    assert.equal(isDangerousStep('mouse_click', { x: 60, y: 40 }), true, 'координаты кнопки «Отправить»');
    assert.equal(isDangerousStep('mouse_click', { x: 60, y: 95 }), false, 'координаты поля «Поиск»');
  });

  test('desktop_click без сцены не выдумывает подпись', (t) => {
    withScene(t, { window: { title: 'Пусто' }, elements: [] });
    assert.equal(isDangerousStep('desktop_click', { id: SEND_ID }), false);
  });

  test('закрытие окна спрашивается всегда', () => {
    assert.equal(isDangerousStep('ui_close_window', {}), true);
    assert.equal(isDangerousStep('windows_close_all', {}), true);
  });

  test('agent-loop: сочетание клавиш и подпись по id через resolveTarget', () => {
    const keysStep = { action: 'ui_keys', target: { keys: 'ctrl+enter' } };
    assert.equal(loopDanger(keysStep, { typed: true }), true);
    assert.equal(loopDanger(keysStep, { typed: false }), false);
    // desktop_click по id: без resolveTarget подписи нет, с ним — «Отправить».
    const clickStep = { action: 'desktop_click', target: { id: SEND_ID } };
    assert.equal(loopDanger(clickStep, {}), false, 'без сцены подпись не взять');
    assert.equal(loopDanger(clickStep, { resolveTarget: () => ({ name: 'Отправить' }) }), true);
  });
});

// ── Интеграция ScreenAgent ───────────────────────────────────────────────────

function fakeTools(verdict = 'confirmed') {
  const runs = [];
  const reg = new ToolRegistry();
  const action = (name) => ({
    name, risk: 'T1', description: name, parameters: { type: 'object', properties: {} },
    async run(args) { runs.push({ name, args }); return { ok: true, summary: `${name} выполнено` }; },
    async verify() { return { status: verdict, evidence: 'подмена' }; },
  });
  for (const n of ['ui_click', 'ui_type', 'ui_keys', 'ui_focus', 'app_open']) reg.register(action(n));
  reg.register({ name: 'ui_elements', risk: 'T0', description: '', async run() { return { ok: true, summary: 'элементы' }; } });
  const look = { name: 'screen_look', risk: 'T1', description: '', async run() { runs.push({ name: 'screen_look' }); return { ok: true, summary: 'снимок', image: 'data:image/jpeg;base64,AA==' }; } };
  return { reg, look, runs, action };
}

function setup(t, { brain, mode = 'full', extra = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-danger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { reg, look, runs, action } = fakeTools();
  const events = [];
  const approvals = new ApprovalBroker();
  const agent = new ScreenAgent({
    brain, tools: reg, look, policy: modes, approvals, journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e), mode, workspace: dir,
  });
  // desktop_* не входят в SCREEN_TOOL_NAMES: регистрируем прямо в реестр агента (симуляция будущей интеграции R1).
  for (const name of extra) agent.tools.register(action(name));
  return { agent, runs, events, approvals };
}

async function waitFor(check, tries = 1000) {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return false;
}

const call = (name, args = {}, id) => ({ id: id || `c${Math.random()}`, name, args });
function brainOf(step) {
  const brain = { calls: 0, async chat() { brain.calls += 1; return step(brain.calls); } };
  return brain;
}

test('ScreenAgent: desktop_click «Отправить» спрашивает, при отказе не выполняется и не повторяется', async (t) => {
  withScene(t);
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : { toolCalls: [call('desktop_click', { id: SEND_ID }, `send-${n}`)] }));
  const { agent, runs, events, approvals } = setup(t, { brain, extra: ['desktop_click'] });
  const turn = agent.run('нажми кнопку в форме');
  assert.ok(await waitFor(() => events.some((e) => e.type === 'approval_request' && e.name === 'desktop_click')), 'владельца спросили');
  const request = events.find((e) => e.type === 'approval_request' && e.name === 'desktop_click');
  assert.equal(request.allowSession, false);
  approvals.respond(request.id, 'reject');
  const res = await turn;
  assert.equal(res.outcome, 'needs_human');
  assert.equal(runs.filter((r) => r.name === 'desktop_click').length, 0, 'шаг не выполнен');
  assert.equal(brain.calls, 2, 'после отказа модель больше не зовут');
});

test('ScreenAgent: ui_type затем ctrl+enter спрашивает (сочетание раньше не ловилось)', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('ui_type', { window: 'Чат', name: 'Сообщение', text: 'привет' })] }
      : n === 3 ? { toolCalls: [call('ui_keys', { window: 'Чат', keys: 'ctrl+enter' }, 'combo')] }
        : { content: 'Готово.' }));
  const { agent, runs, events, approvals } = setup(t, { brain });
  const turn = agent.run('напиши и отправь');
  assert.ok(await waitFor(() => events.some((e) => e.type === 'approval_request' && e.callId === 'combo')), 'спросили перед ctrl+enter');
  approvals.respond(events.find((e) => e.callId === 'combo').id, 'once');
  const res = await turn;
  assert.equal(res.outcome, 'answer');
  assert.deepEqual(runs.filter((r) => r.name === 'ui_type' || r.name === 'ui_keys').map((r) => r.name), ['ui_type', 'ui_keys']);
});

test('ScreenAgent: desktop_type затем enter спрашивает (desktop_type раньше не ставил _typed)', async (t) => {
  withScene(t);
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('desktop_type', { id: FIELD_ID, text: 'привет' })] }
      : n === 3 ? { toolCalls: [call('ui_keys', { window: 'Форма', keys: 'enter' }, 'after-type')] }
        : { content: 'Готово.' }));
  const { agent, runs, events, approvals } = setup(t, { brain, extra: ['desktop_type'] });
  const turn = agent.run('введи текст и нажми enter');
  assert.ok(await waitFor(() => events.some((e) => e.type === 'approval_request' && e.callId === 'after-type')), 'спросили перед enter после desktop_type');
  approvals.respond(events.find((e) => e.callId === 'after-type').id, 'once');
  const res = await turn;
  assert.equal(res.outcome, 'answer');
  assert.equal(runs.filter((r) => r.name === 'desktop_type').length, 1);
  assert.equal(runs.filter((r) => r.name === 'ui_keys').length, 1);
});

test('экспорт: isDangerousStep и dangerLabel из agent.js, resolveSceneTarget из modes.js', () => {
  assert.equal(typeof isDangerousStep, 'function');
  assert.equal(typeof dangerLabel, 'function');
  assert.equal(typeof modes.resolveSceneTarget, 'function');
  const hit = modes.resolveSceneTarget('desktop_click', { id: SEND_ID, _scene: scene() });
  assert.equal(hit.name, 'Отправить');
});