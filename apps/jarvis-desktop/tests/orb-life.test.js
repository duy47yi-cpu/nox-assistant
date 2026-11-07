'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../renderer/orb.js'), 'utf8');

function setup(reduced = false) {
  const query = { matches: reduced, addEventListener() {}, removeEventListener() {} };
  const gradient = { addColorStop() {} };
  const commands = [];
  const ctx = new Proxy({}, { get: (_, key) => (...args) => {
    commands.push([key, ...args]);
    if (String(key).startsWith('create')) return gradient;
  }, set: () => true });
  const canvas = { dataset: {}, getContext: () => ctx, closest: () => null,
    getBoundingClientRect: () => ({ width: 180, height: 180 }) };
  let frames = 0;
  const sprite = () => ({ width: 0, height: 0, getContext: () => ctx });
  const sandbox = { window: { matchMedia: () => query },
    document: { documentElement: {}, hidden: false, addEventListener() {}, removeEventListener() {}, createElement: sprite },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    performance: { now: () => 0 }, requestAnimationFrame: () => ++frames, cancelAnimationFrame() {} };
  vm.runInNewContext(source, sandbox);
  const Orb = sandbox.window.JarvisOrb;
  const orb = new Orb(canvas);
  return { Orb, orb, query, canvas, commands, sandbox, frames: () => frames };
}

test('сцена рисует точечный шар спрайтами, шаги дают бусины, другие виды доступны', () => {
  const { orb, canvas, commands, sandbox, query } = setup();
  canvas.closest = (selector) => selector === '#stageOrb' ? {} : null;
  sandbox.document.body = {};
  orb.variant = 'sphere';
  const arcs = () => commands.filter(([name]) => name === 'arc');
  const dots = () => commands.filter(([name]) => name === 'drawImage');
  commands.length = 0; orb._draw();
  // Точки — спрайты через drawImage, без arc на каждую; ореола и декоративной орбиты нет.
  assert.equal(commands.filter(([name]) => name === 'ellipse').length, 0);
  assert.ok(dots().length > 200);
  assert.equal(arcs().length, 0);
  query.matches = true; commands.length = 0; orb._onReduce();
  const still = JSON.stringify(dots());
  const quiet = arcs().length;
  orb.t += 10; commands.length = 0; orb._draw();
  assert.equal(JSON.stringify(dots()), still);
  // Кольцо шагов: каждый шаг — бусина с подложкой, без шагов кольца нет.
  commands.length = 0; orb.setSteps(['confirmed', 'running']);
  assert.ok(arcs().length > quiet + 100);
  commands.length = 0; orb.setSteps([]);
  assert.equal(arcs().length, quiet);
  let painted = false;
  sandbox.window.JarvisOrbVariants = { aperture: { paint() { painted = true; } } };
  orb.variant = 'aperture'; orb._draw();
  assert.equal(painted, true);
});

test('символ, пробел и удаление дают разные ограниченные жесты', () => {
  const { orb } = setup();
  orb.gesture('type', 1);
  const tap = orb._lifePose(false);
  assert.ok(tap.x !== 0 && tap.stretch > 0);
  orb.life.reset(); orb.gesture('space');
  assert.ok(orb._lifePose(false).y < 0);
  orb.life.reset(); orb.gesture('delete');
  assert.ok(orb._lifePose(false).stretch < 0);
  for (let i = 0; i < 10000; i++) orb.gesture('type', 5);
  assert.equal(orb.life.energy, 1);
  assert.equal(orb.life.caret, 1);
  assert.ok(Math.abs(orb._lifePose(false).x) < 0.03);
});

test('быстрый темп усиливает активность, пауза гасит её без таймеров', () => {
  const { Orb } = setup();
  const slow = new Orb.Life(), fast = new Orb.Life();
  for (let i = 0; i < 5; i++) {
    slow.step(0.5); slow.edit('type'); fast.step(0.08); fast.edit('type');
  }
  assert.ok(fast.energy > slow.energy * 2);
  fast.focused = true; fast.hasText = true;
  for (let i = 0; i < 14; i++) fast.step(0.05);
  assert.ok(fast.tap < 0.025);
  assert.ok(fast.energy < 0.22);
  assert.ok(fast.attention > 0.9);
  fast.focused = false;
  for (let i = 0; i < 30; i++) fast.step(0.05);
  assert.ok(fast.attention < 0.002);
});

test('рабочие состояния не перебиваются набором и не возвращают старые жесты', () => {
  for (const state of ['thinking', 'searching', 'speaking', 'acting', 'waiting_approval', 'error']) {
    const { orb } = setup();
    orb.gesture('type'); orb.setState(state); orb.gesture('delete');
    assert.equal(orb.state, state);
    assert.equal(orb.life.recoil, 0);
    assert.equal(orb._lifePose(false).stretch, 0);
    orb.setState('idle');
    assert.equal(orb.life.tap, 0);
  }
});

test('импульс отправки продолжается в начале размышления и затухает', () => {
  const { orb } = setup();
  orb.gesture('send'); orb.setState('thinking');
  assert.ok(orb._lifePose(false).stretch < 0);
  orb.life.step(1.5);
  assert.ok(Math.abs(orb._lifePose(false).stretch) < 0.001);
});

test('отключение движения и системная настройка оставляют статичный шар', () => {
  const { orb, query, frames } = setup();
  orb.gesture('type'); orb.setAnimated(false); orb.gesture('space');
  assert.equal(orb.life.tap, 0); assert.equal(orb.life.inhale, 0); assert.equal(orb.raf, 0);
  orb.setAnimated(true);
  query.matches = true; orb._onReduce();
  const count = frames(); orb.gesture('delete'); orb.setState('searching');
  assert.equal(orb.life.recoil, 0); assert.equal(orb.raf, 0);
  assert.equal(orb.weights.searching, 1); assert.equal(frames(), count);
});

test('общая деформация передаётся каждому виду без изменения размера canvas', () => {
  const { orb, sandbox, canvas, commands } = setup();
  let painted = 0;
  sandbox.window.JarvisOrbVariants = { iris: { hole: 0.45, paint() { painted++; } }, coil: { hole: 0.44, paint() { painted++; } } };
  const width = canvas.width;
  for (const variant of ['sphere', 'iris', 'coil']) {
    orb.setVariant(variant); orb.gesture('delete'); commands.length = 0; orb._draw();
    assert.ok(commands.some(([key, x, y]) => key === 'scale' && x > 1 && y < 1));
    assert.equal(canvas.width, width);
  }
  assert.ok(painted >= 2);
});

test('скрытое окно отменяет цикл, возвращение возобновляет его', () => {
  const { orb, sandbox } = setup();
  sandbox.document.hidden = true; orb._onVisibility(); assert.equal(orb.raf, 0);
  sandbox.document.hidden = false; orb._onVisibility(); assert.ok(orb.raf > 0);
  orb.destroy(); assert.equal(orb.raf, 0);
});

// Исполняем настоящий initChat: проверяем маршрутизацию DOM-событий, а не копию правил.
function composer(sent = true) {
  const listeners = {};
  const ta = { value: '', selectionStart: 0, disabled: false, style: {}, scrollHeight: 30,
    addEventListener(type, fn) { listeners[type] = fn; } };
  let submitted = 0;
  const form = { addEventListener(type, fn) { listeners['form:' + type] = fn; }, requestSubmit() { submitted++; } };
  const calls = [];
  const tracker = { busy: false };
  const doc = { activeElement: ta };
  const noop = () => {};
  const generic = { addEventListener: noop };
  const sandbox = { document: doc, tracker, S: { stopped: false },
    orb: { gesture: (...args) => calls.push(args), setComposer: noop },
    $: (id) => id === '#chatInput' ? ta : id === '#composer' ? form : generic,
    has: () => false, linkDown: () => false, renderComposerState: noop, renderFiles: noop,
    pickFiles: noop, showOlder: noop, nearBottom: () => true,
    autosize: noop, sendMessage: async () => sent };
  const app = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const start = app.indexOf('  function initChat() {');
  const end = app.indexOf('\n  // Готовые фразы', start);
  vm.runInNewContext(app.slice(start, end) + '\ninitChat();', sandbox);
  return { ta, listeners, calls, tracker, submitted: () => submitted };
}

test('input различает печать, пробел, удаление и вставку; во время работы молчит', () => {
  const { ta, listeners, calls, tracker } = composer();
  ta.value = 'текст'; ta.selectionStart = 5;
  for (const event of [{ inputType: 'insertText', data: 'т' }, { inputType: 'insertText', data: ' ' },
    { inputType: 'deleteContentBackward' }, { inputType: 'insertFromPaste', data: 'много текста' }]) listeners.input(event);
  assert.deepEqual(calls.map((c) => c[0]), ['type', 'space', 'delete', 'paste']);
  tracker.busy = true; listeners.input({ inputType: 'insertText', data: 'а' }); assert.equal(calls.length, 4);
});

test('IME не отправляет Enter и даёт один мягкий отклик на подтверждение', () => {
  const { listeners, calls, submitted } = composer();
  listeners.compositionstart();
  listeners.input({ inputType: 'insertCompositionText', isComposing: true });
  listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(submitted(), 0); assert.equal(calls.length, 0);
  listeners.compositionend();
  listeners.input({ inputType: 'insertFromComposition' });
  assert.deepEqual(calls.map((c) => c[0]), ['paste']);
  listeners.keydown({ key: 'Enter', preventDefault() {} }); assert.equal(submitted(), 1);
});

test('отправка очищает поле, отказ восстанавливает черновик', async () => {
  const { ta, listeners, calls } = composer();
  ta.value = 'поручение';
  await listeners['form:submit']({ preventDefault() {} });
  assert.equal(ta.value, ''); assert.equal(calls[0][0], 'send');
  const refused = composer(false);
  refused.ta.value = 'сохранить черновик';
  await refused.listeners['form:submit']({ preventDefault() {} });
  assert.equal(refused.ta.value, 'сохранить черновик');
});
