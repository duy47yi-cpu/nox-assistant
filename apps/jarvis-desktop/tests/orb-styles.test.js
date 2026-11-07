'use strict';

// Шар: три вида (Ядро, Диафрагма, Точечная сфера), свои настройки вида, голос,
// статичная картинка при «уменьшить движение» и остановка кадров вне видимости.
// orb.js, orb-variants.js и orb-tune.js исполняются в изолированном контексте, без Electron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const dir = path.join(__dirname, '../renderer');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const SRC = { orb: read('orb.js'), variants: read('orb-variants.js'), tune: read('orb-tune.js') };
const STATES = ['idle', 'listening', 'thinking', 'searching', 'speaking', 'acting', 'verifying', 'waiting_approval', 'success', 'cancelled', 'error'];

function setup({ reduced = false, size = 180, saved = null, hue = '' } = {}) {
  const query = { matches: reduced, addEventListener() {}, removeEventListener() {} };
  const commands = [];
  const gradient = { addColorStop: (...a) => commands.push(['stop', ...a]) };
  const ctx = new Proxy({}, { get: (_, key) => (...args) => {
    commands.push([key, ...args]);
    if (String(key).startsWith('create')) return gradient;
  }, set: (_, key, value) => { commands.push(['set', key, value]); return true; } });
  const listeners = {};
  const storage = new Map(saved ? [['jarvis.orbTune', JSON.stringify(saved)]] : []);
  let frames = 0;
  let io = null;
  const document = {
    documentElement: {}, hidden: false,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent: (ev) => { for (const fn of listeners[ev.type] || []) fn(ev); return true; },
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
    getElementById: () => null,
  };
  const sandbox = {
    window: { matchMedia: () => query, devicePixelRatio: 2 },
    document,
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    MutationObserver: class { observe() {} },
    IntersectionObserver: class { constructor(cb) { io = cb; } observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: (k) => (k === '--hue' ? hue : '') }),
    performance: { now: () => 0 },
    requestAnimationFrame: () => ++frames,
    cancelAnimationFrame() {},
  };
  sandbox.window.document = document;
  vm.createContext(sandbox);
  for (const s of [SRC.orb, SRC.variants, SRC.tune]) vm.runInContext(s, sandbox);
  const canvas = { dataset: {}, getContext: () => ctx, closest: () => null, getBoundingClientRect: () => ({ width: size, height: size }) };
  const Orb = sandbox.window.JarvisOrb;
  const make = (variant = 'core') => new Orb(canvas, { variant });
  return { Orb, make, commands, sandbox, query, storage, canvas, frames: () => frames, io: (v) => io([{ isIntersecting: v }]) };
}

test('три вида есть в выборе, Ядро по умолчанию, старая «Обмотка» и «Реактор» убраны', () => {
  const { sandbox } = setup();
  assert.deepEqual(Object.keys(sandbox.window.JarvisOrbVariants).sort(), ['core', 'iris']);
  const html = read('index.html');
  const opts = [...html.matchAll(/data-orb-opt="([a-z]+)"[^>]*><canvas[^>]*><\/canvas>([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(opts, [['core', 'Ядро'], ['iris', 'Диафрагма'], ['sphere', 'Точечная сфера']]);
  assert.ok(html.indexOf('orb-tune.js') > html.indexOf('orb-variants.js'));
  assert.ok(html.indexOf('orb-tune.js') < html.indexOf('app.js'));
  assert.match(read('app.js'), /function defaultOrb\(\) \{ return 'core'; \}/);
  assert.match(read('app.js'), /raw === 'reactor' \? 'core' : raw/, 'старое имя открывает Ядро');
  assert.doesNotMatch(html + SRC.variants + SRC.tune, /Реактор/);
  assert.doesNotMatch(SRC.variants, /coil/);
});

test('каждый вид рисуется во всех состояниях, с голосом и без, и не выходит за холст', () => {
  const { make, commands } = setup();
  for (const variant of ['core', 'iris', 'sphere']) {
    const orb = make(variant);
    for (const state of STATES) {
      orb.setState(state);
      orb.voice = 0.8; orb.t = 3; orb.clock = 2;
      commands.length = 0;
      orb._draw();
      assert.ok(commands.length > 10, `${variant}/${state} рисует`);
      for (const [name, ...args] of commands) {
        if (name !== 'arc') continue;
        assert.ok(args.slice(0, 5).every((v) => Number.isFinite(v)), `${variant}/${state}: дуга без NaN`);
      }
    }
    assert.ok(Number(orb.canvas.dataset.hole) > 0 && Number(orb.canvas.dataset.hole) <= 90);
  }
});

test('Точечная сфера: точки спрайтами, освещённая сторона ярче теневой', () => {
  const { make, commands } = setup();
  const orb = make('sphere');
  orb.setAnimated(false);
  commands.length = 0; orb._draw();
  const dots = commands.filter(([n]) => n === 'drawImage');
  assert.ok(dots.length >= 200);
  assert.equal(commands.filter(([n]) => n === 'arc').length, 0, 'без arc на каждую точку');
  // Ступень яркости спрайта: сверху слева (к свету) выше, чем снизу справа.
  const B = orb.buf;
  let lit = 0, nl = 0, dark = 0, nd = 0;
  for (let i = 0; i < B.sx.length; i++) {
    if (B.z[i] < 0.3) continue;
    const dx = B.sx[i] - 90, dy = B.sy[i] - 90;
    if (dx < -20 && dy < -20) { lit += B.lv[i]; nl++; } else if (dx > 20 && dy > 20) { dark += B.lv[i]; nd++; }
  }
  assert.ok(nl && nd);
  assert.ok(lit / nl > dark / nd + 0.8, `свет ${lit / nl} против тени ${dark / nd}`);
  // Спрайты не пересоздаются каждый кадр: тот же цвет — тот же набор.
  const first = orb.spr.list; orb._draw(); assert.equal(orb.spr.list, first);
});

test('настройки вида: границы, сохранение, событие доходит до шара, «Как было» сбрасывает', () => {
  const { sandbox, make, storage } = setup();
  const T = sandbox.window.JarvisOrbTune;
  assert.deepEqual(Object.keys(T.STYLES), ['core', 'iris', 'sphere']);
  for (const style of Object.keys(T.STYLES)) assert.ok(T.OWN[style].length + 2 <= 8, 'не больше 8 настроек на вид');
  assert.deepEqual(JSON.parse(JSON.stringify(T.normalize({ glow: 99, speed: -5, motion: 'abc', depth: null, voice: 'yes', voiceGain: 1.5, density: 0.1 }))),
    { glow: 1.6, speed: 0.3, motion: 1, depth: 1, voice: true, voiceGain: 1.5, density: 0.5 });
  const orb = make('core');
  const other = make('iris');
  T.set('core', { glow: 1.4, voice: false });
  assert.equal(orb.tune.glow, 1.4);
  assert.equal(orb.tune.voice, false);
  assert.equal(other.tune.glow, 1, 'у другого вида свои настройки');
  assert.equal(JSON.parse(storage.get('jarvis.orbTune')).core.glow, 1.4);
  T.set('core', null);
  assert.equal(orb.tune.glow, 1);
  assert.equal(T.set('чужой', { glow: 2 }).glow, 1, 'неизвестный вид не сохраняется');
});

test('сохранённые настройки читаются при запуске; плотность меняет число точек', () => {
  const { make, sandbox } = setup({ saved: { sphere: { density: 1.6 } } });
  const orb = make('sphere');
  const dense = orb.points.length;
  sandbox.window.JarvisOrbTune.set('sphere', { density: 0.5 });
  assert.ok(orb.points.length < dense / 2.5, `${orb.points.length} против ${dense}`);
});

test('скорость из настроек ускоряет движение, но не переход цвета', () => {
  const run = (speed) => {
    const { make } = setup();
    const orb = make('core');
    orb.setTune({ speed });
    let now = 0;
    for (let i = 0; i < 30; i++) { now += 34; orb._frame(now); }
    return orb;
  };
  const slow = run(0.5), fast = run(2);
  assert.ok(Math.abs(fast.clock / slow.clock - 4) < 0.01);
  assert.equal(fast.weights.idle, slow.weights.idle);
});

test('голос: вход 0..1, быстрый подъём, спад без новых значений, выключатель и сила', () => {
  const { make } = setup();
  const orb = make('core');
  let now = 0;
  const tick = (n) => { for (let i = 0; i < n; i++) { now += 34; orb._frame(now); } };
  orb.setVoice(5); assert.equal(orb.voiceTarget, 1);
  orb.setVoice('шум'); assert.equal(orb.voiceTarget, 0);
  orb.setVoice(0.8); tick(4);
  assert.ok(orb.voice > 0.6, `подъём ${orb.voice}`);
  tick(20);
  assert.ok(orb.voice < 0.05, `источник замолчал — уровень ушёл: ${orb.voice}`);
  orb.setVoice(1); tick(3);
  orb.setTune({ voiceGain: 2 }); assert.ok(orb._voiceOut() > 1.2);
  orb.setTune({ voice: false }); assert.equal(orb._voiceOut(), 0);
});

test('голос передаётся виду в окружении, а при статичной картинке — ноль', () => {
  const { make, sandbox } = setup();
  const seen = [];
  sandbox.window.JarvisOrbVariants.probe = { hole: 0.4, paint: (o, ctx, size, cx, cy, e) => seen.push(e.voice) };
  const orb = make('probe');
  orb.voice = 0.5; orb._draw();
  const live = seen.at(-1);
  orb.setAnimated(false); orb.voice = 0.5; orb._draw();
  assert.equal(live, 0.5);
  assert.equal(seen.at(-1), 0);
});

test('«уменьшить движение»: статичная картинка у каждого вида, состояние меняется', () => {
  for (const variant of ['core', 'iris', 'sphere']) {
    const { make, commands } = setup({ reduced: true });
    const orb = make(variant);
    assert.equal(orb.raf, 0, 'кадры не идут');
    commands.length = 0; orb._draw();
    const a = JSON.stringify(commands);
    orb.t += 7; orb.clock += 7; orb.voice = 1; orb.kick = 1;
    commands.length = 0; orb._draw();
    assert.equal(JSON.stringify(commands), a, `${variant}: картинка не движется`);
    orb.setState('error');
    assert.equal(orb.weights.error, 1, 'смена состояния видна сразу');
    commands.length = 0; orb._draw();
    assert.notEqual(JSON.stringify(commands), a);
  }
});

test('шар вне видимости или в скрытом окне не просит кадры, возвращение запускает цикл', () => {
  const { make, io, sandbox, frames } = setup();
  const orb = make('core');
  assert.ok(orb.raf > 0);
  io(false); assert.equal(orb.raf, 0);
  const n = frames(); orb.setVoice(1); orb.setTune({ glow: 1.2 });
  assert.equal(frames(), n, 'голос и настройки не будят кадры, пока шар не виден');
  io(true); assert.ok(orb.raf > 0);
  sandbox.document.hidden = true; orb._onVisibility(); assert.equal(orb.raf, 0);
});

// Замер в отдельном процессе: в vm-контексте доступ к глобальным объектам в разы медленнее, чем в окне.
test('расчёт кадра каждого вида на 360 px при DPR 2 укладывается в бюджет (только JS, без отрисовки)', () => {
  const code = `
    const fs = require('fs');
    const g = { addColorStop() {} }, noop = () => g, ctx = new Proxy({}, { get: () => noop, set: () => true });
    Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false, addEventListener() {} }), devicePixelRatio: 2 },
      document: { hidden: false, addEventListener() {}, createElement: () => ({ getContext: () => ctx }) },
      getComputedStyle: () => ({ getPropertyValue: () => '' }), requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
    for (const f of ['orb.js', 'orb-variants.js']) (0, eval)(fs.readFileSync(process.argv[1] + '/' + f, 'utf8'));
    const out = {};
    for (const v of ['sphere', 'core', 'iris']) {
      const o = new window.JarvisOrb({ dataset: {}, getContext: () => ctx, closest: () => null,
        getBoundingClientRect: () => ({ width: 360, height: 360 }) }, { variant: v });
      o.setState('thinking'); o.t = 5;
      for (let i = 0; i < 200; i++) { o.clock += 0.03; o._draw(); }
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 300; i++) { o.clock += 0.03; o.t += 0.03; o._draw(); }
      out[v] = Number(process.hrtime.bigint() - t0) / 1e6 / 300;
    }
    console.log(JSON.stringify(out));`;
  const out = JSON.parse(require('node:child_process').execFileSync(process.execPath, ['-e', code, dir], { encoding: 'utf8' }));
  assert.deepEqual(Object.keys(out), ['sphere', 'core', 'iris']);
  for (const [v, ms] of Object.entries(out)) assert.ok(ms < 3, `${v}: ${ms.toFixed(2)} мс на кадр`);
});

test('Ядро: старые настройки reactor читаются как настройки Ядра и переезжают под новое имя', () => {
  const { sandbox, make, storage } = setup({ saved: { reactor: { glow: 1.3 } } });
  const T = sandbox.window.JarvisOrbTune;
  assert.equal(make('core').tune.glow, 1.3);
  T.set('core', { speed: 1.5 });
  const all = JSON.parse(storage.get('jarvis.orbTune'));
  assert.deepEqual([all.core.glow, all.core.speed, all.reactor], [1.3, 1.5, undefined]);
});

// Цвета всех градиентов кадра: [r, g, b].
const stops = (commands) => commands.filter(([n]) => n === 'stop')
  .map(([, , c]) => /^rgba\((\d+),(\d+),(\d+)/.exec(c)).filter(Boolean).map((m) => m.slice(1, 4).map(Number));

test('Ядро: свет берёт цвет акцента темы, а не заданный голубой', () => {
  const { make, commands } = setup({ hue: '#e56b36' });
  make('core'); // спрайты света собираются при первой отрисовке, в конструкторе
  const all = stops(commands);
  assert.ok(all.some(([r, g, b]) => r > 200 && g > 100 && g < 160 && b < 110), 'есть тёплый оранжевый свет акцента');
  assert.ok(all.every(([r, , b]) => b <= r), 'нет голубых и синих оттенков');
  // Другой акцент — другой свет.
  const { make: make2, commands: c2 } = setup({ hue: '#3fb27f' });
  make2('core');
  assert.ok(stops(c2).some(([r, g, b]) => g > r + 40 && g > b), 'зелёный акцент даёт зелёный свет');
});

test('Ядро: ореола нет — свет только внутри тела, без теней, одно тонкое кольцо', () => {
  const { make, commands } = setup();
  const orb = make('core');
  const R = 180 * 0.43;
  for (const state of STATES) {
    orb.setState(state); orb.voice = 1; orb.kick = 1; orb.t += 1; orb.clock += 1;
    commands.length = 0; orb._draw();
    let depth = 0, clipAt = 0, glows = 0;
    for (const [name, ...a] of commands) {
      if (name === 'save') depth++;
      if (name === 'clip') clipAt = depth;
      if (name === 'restore') { if (clipAt === depth) clipAt = 0; depth--; }
      if (name === 'arc') assert.ok(a[2] <= R + 1e-6, `${state}: дуга ${a[2]} не выходит за тело ${R}`);
      if (name === 'set' && a[0] === 'shadowBlur') assert.equal(a[1], 0, `${state}: без размытой тени`);
      if (name === 'drawImage' && a.length === 5) {
        if (clipAt) glows++;
        else assert.ok(a[3] <= R * 2.06 + 1e-6, `${state}: спрайт вне обрезки не шире тела`);
      }
    }
    assert.equal(glows, 3, `${state}: три пятна света внутри обрезки по телу`);
    const strokes = commands.filter(([n]) => n === 'stroke').length;
    assert.ok(strokes <= 2, `${state}: ${strokes} линий — только поясок и светлый участок на нём`);
  }
});

test('Ядро: голос делает свет ярче и течение быстрее', () => {
  const run = (level) => {
    const { make, commands } = setup();
    const orb = make('core');
    let now = 0;
    for (let i = 0; i < 20; i++) { now += 34; orb.setVoice(level); orb._frame(now); }
    commands.length = 0; orb._draw();
    const alpha = commands.filter(([n, k]) => n === 'set' && k === 'globalAlpha').map(([, , v]) => v).filter((v) => v < 1);
    return { flow: orb._coreFlow, light: alpha.reduce((s, v) => s + v, 0) };
  };
  const quiet = run(0), loud = run(1);
  assert.ok(loud.flow > quiet.flow * 1.5, `течение ${loud.flow} против ${quiet.flow}`);
  assert.ok(loud.light > quiet.light * 1.3, `яркость ${loud.light} против ${quiet.light}`);
});

test('Ядро: ожидание решения замирает и останавливает кадры, возврат снова запускает', () => {
  const { make } = setup();
  const orb = make('core');
  orb.setState('waiting_approval');
  let now = 0;
  for (let i = 0; i < 50; i++) { now += 34; if (orb.raf) orb._frame(now); }
  assert.equal(orb.raf, 0, 'кадры остановлены');
  orb.setState('idle'); assert.ok(orb.raf > 0);
});
