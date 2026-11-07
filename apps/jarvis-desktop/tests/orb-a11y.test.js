'use strict';

// Шар: состояния из шага проверки, доступное описание и экономия кадров.
// Проверяем orb.js в изолированном контексте, без Electron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../renderer/orb.js'), 'utf8');

function setup(reduced = false) {
  const query = { matches: reduced, addEventListener() {}, removeEventListener() {} };
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, { get: () => () => gradient, set: () => true });
  const attrs = {};
  const wrap = {
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = String(value); },
  };
  const canvas = {
    dataset: {},
    id: 'orb',
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 180, height: 180 }),
    closest: (selector) => (selector === '.orb-wrap' ? wrap : null),
  };
  let frames = 0;
  let cancelled = 0;
  const sandbox = {
    window: { matchMedia: () => query },
    document: { documentElement: {}, hidden: false, addEventListener() {}, removeEventListener() {}, createElement: () => ({ getContext: () => ctx }) },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    performance: { now: () => 0 },
    requestAnimationFrame: () => ++frames,
    cancelAnimationFrame: () => { cancelled++; },
  };
  vm.runInNewContext(source, sandbox);
  const Orb = sandbox.window.JarvisOrb;
  const orb = new Orb(canvas);
  return { Orb, orb, query, canvas, wrap, attrs, sandbox, frames: () => frames, cancelled: () => cancelled };
}

test('все состояния шага доступны: включая проверку, успех и отмену', () => {
  const { Orb, orb, wrap } = setup();
  const states = ['idle', 'listening', 'thinking', 'searching', 'speaking', 'acting', 'verifying', 'waiting_approval', 'success', 'cancelled', 'error'];
  assert.deepEqual(Array.from(Orb.STATES), states);
  for (const state of states) {
    orb.setState(state);
    assert.equal(orb.state, state, `состояние ${state} принято`);
    assert.equal(wrap.getAttribute('role'), 'img');
    assert.equal(wrap.getAttribute('aria-label'), `Шар состояния: ${Orb.describe(state)}`);
  }
  // Подписи — человеческие слова, а не технические ключи.
  assert.equal(Orb.describe('verifying'), 'Проверяю');
  assert.equal(Orb.describe('cancelled'), 'Остановлено');
  assert.equal(Orb.describe('success'), 'Готово');
});

test('синонимы событий ядра не ломают шар', () => {
  const { orb } = setup();
  orb.setState('planning');
  assert.equal(orb.state, 'thinking');
  orb.setState('warning');
  assert.equal(orb.state, 'waiting_approval');
  orb.setState('succeeded');
  assert.equal(orb.state, 'success');
  orb.setState('несуществующее');
  assert.equal(orb.state, 'idle');
});

test('повтор того же состояния обновляет подпись, а не молчит', () => {
  const { orb, canvas, wrap } = setup();
  canvas.closest = () => null; // обёртки ещё нет в разметке
  orb.setState('idle');
  assert.equal(orb.state, 'idle');
  canvas.closest = (selector) => (selector === '.orb-wrap' ? wrap : null);
  orb.setState('idle');
  assert.equal(wrap.getAttribute('aria-label'), 'Шар состояния: Готов');
});

test('системное «уменьшить движение» останавливает шар, даже если окно просило не учитывать его', () => {
  const { orb, query } = setup();
  // app.js ставит этот флаг, считая, что у шара свой переключатель; системная настройка важнее.
  orb.constructor.ignoreSystemMotion = true;
  query.matches = true;
  orb._onReduce();
  assert.equal(orb.raf, 0);
  assert.equal(orb.weights.idle, 1);
  orb.gesture('type');
  assert.equal(orb.life.energy, 0);
  // Смена состояния остаётся видимой: статус не теряется при выключенном движении.
  orb.setState('waiting_approval');
  assert.equal(orb.state, 'waiting_approval');
  assert.equal(orb.weights.waiting_approval, 1);
});

test('ожидание, отмена и ошибка замирают и перестают просить кадры, любое новое состояние возвращает цикл', () => {
  for (const frozen of ['waiting_approval', 'cancelled', 'error']) {
    const { orb, cancelled } = setup();
    orb.setState(frozen);
    assert.ok(orb.raf > 0, 'переход рисуется кадрами');
    orb.t = 2;
    orb.stateAt = 0;
    const before = cancelled();
    orb._frame(1000);
    assert.equal(orb.raf, 0, `${frozen}: кадры остановлены`);
    assert.equal(cancelled(), before + 1, 'текущий кадр отменён');
    orb.setState('idle');
    assert.ok(orb.raf > 0, 'из замершего состояния цикл запускается снова');
  }
});

test('отключение анимации оставляет смену состояния и подпись', () => {
  const { orb, wrap } = setup();
  orb.setAnimated(false);
  assert.equal(orb.raf, 0);
  orb.setState('success');
  assert.equal(orb.state, 'success');
  assert.equal(wrap.getAttribute('aria-label'), 'Шар состояния: Готово');
  orb.setAnimated(true);
  assert.ok(orb.raf > 0);
});

test('без обёртки в разметке шар работает: отсутствие элемента не ломает запуск', () => {
  const { orb, canvas } = setup();
  canvas.closest = () => null;
  const label = orb._describe();
  assert.equal(label, undefined);
  orb.setState('thinking');
  assert.equal(orb.state, 'thinking');
});
