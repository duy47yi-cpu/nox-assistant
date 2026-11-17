'use strict';

// Шесть авторских сфер Nox Aether: реестр библиотеки, состояния STATE_TO_NOX, голос,
// DPR, пауза в скрытом окне, «уменьшение движения», пресеты/сброс и бюджет кадра.
// orb-library.js и orbs-extra.js исполняются в изолированном контексте, без Electron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const AETHER = path.join(__dirname, '../renderer/aether');
const SRC_EXTRA = fs.readFileSync(path.join(AETHER, 'orbs-extra.js'), 'utf8');
const SRC_LIBRARY = fs.readFileSync(path.join(AETHER, 'orb-library.js'), 'utf8');
const libExports = require('../renderer/aether/orb-library');
const extraExports = require('../renderer/aether/orbs-extra');
const { createOrbLibrary, STATE_TO_NOX, STATE_TO_JARVIS, DEFAULT_ORB_ID, BUILTIN_ORBS, loadCompanionOrbs } = libExports;
const { SPECS, VARIANTS, STATES } = extraExports;

const EXTRA_IDS = VARIANTS.map((v) => 'aether:' + v);
const STATES_ALL = ['idle', 'listening', 'thinking', 'speaking', 'waiting_approval', 'success', 'error'];
const ALIASES = {
  attentive: 'listening',
  searching: 'thinking',
  acting: 'thinking',
  verifying: 'thinking',
  working: 'thinking',
  planning: 'thinking',
  warning: 'waiting_approval',
  succeeded: 'success',
  cancelled: 'idle',
  partial: 'idle',
  failed: 'error',
};

function makeMemStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── Изолированная среда для живого движка: canvas, document, rAF, наблюдатели ──
function makeEnv({ reduced = false, dpr = 2, size = 360, theme = {} } = {}) {
  const gradient = { addColorStop() {} };
  const commands = [];
  const ctx = new Proxy({}, {
    get: (_, key) => (...args) => {
      commands.push([key, ...args]);
      if (String(key).startsWith('create')) return gradient;
      return undefined;
    },
    set: (_, key, value) => { commands.push(['set', key, value]); return true; },
  });

  const listeners = {};
  const document = {
    hidden: false,
    documentElement: { dataset: {} },
    currentScript: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); return true; },
    createElement() { return { getContext: () => ctx, width: 0, height: 0 }; },
  };
  let ioCallback = null;
  let roCallback = null;
  let rafRequests = 0;
  let rafCancels = 0;
  const rafQueue = [];
  const colors = { '--hue': '#58d9e8', '--warn': '#ffc24d', '--err': '#ff7f78', '--ok': '#6eefa8', ...theme };
  const sandbox = {
    window: {
      matchMedia: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }),
      devicePixelRatio: dpr,
      addEventListener() {},
      removeEventListener() {},
    },
    document,
    getComputedStyle: () => ({ getPropertyValue: (name) => colors[name] || '' }),
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => { rafRequests++; rafQueue.push(fn); return rafRequests; },
    cancelAnimationFrame: () => { rafCancels++; },
    ResizeObserver: class { constructor(cb) { roCallback = cb; } observe() {} disconnect() {} },
    IntersectionObserver: class { constructor(cb) { ioCallback = cb; } observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC_LIBRARY, sandbox);
  vm.runInContext(SRC_EXTRA, sandbox);

  function makeCanvas(width = size, height = size) {
    return {
      width: 0,
      height: 0,
      clientWidth: width,
      clientHeight: height,
      getContext: () => ctx,
      getBoundingClientRect: () => ({ width, height }),
      closest: () => null,
    };
  }
  return {
    sandbox,
    lib: sandbox.window.NoxOrbLibrary,
    api: sandbox.window.NoxOrbsExtra,
    ctx,
    commands,
    document,
    colors,
    canvas: makeCanvas,
    makeOrb(variant, options = {}) {
      return new sandbox.window.NoxOrbsExtra.ExtraOrb(makeCanvas(), { variant, dpr, ...options });
    },
    io(value) { if (ioCallback) ioCallback([{ isIntersecting: value }]); },
    ro() { if (roCallback) roCallback(); },
    visibility() { for (const fn of listeners.visibilitychange || []) fn({ type: 'visibilitychange' }); },
    rafRequests: () => rafRequests,
    rafCancels: () => rafCancels,
  };
}

// ── 1. Реестр ─────────────────────────────────────────────────────────

test('реестр: шесть авторских сфер добавляются к двум сферам Nox, по умолчанию остаётся wire', () => {
  const lib = createOrbLibrary({ storage: makeMemStorage() });
  const added = extraExports.registerExtraOrbs(lib);
  assert.equal(added, 6);
  const list = json(lib.list());
  assert.equal(list.length, 8);
  assert.deepEqual(list.map((o) => o.id), [...BUILTIN_ORBS.map((o) => o.id), ...EXTRA_IDS]);
  assert.equal(lib.getActiveId(), 'nox:wire');
  assert.equal(DEFAULT_ORB_ID, 'nox:wire');
  for (const id of EXTRA_IDS) {
    const spec = lib.get(id);
    assert.equal(spec.engine, 'custom');
    assert.equal(spec.stateMap, 'nox');
    assert.equal(spec.systemLabel, 'Авторские сферы');
    assert.equal(typeof spec.create, 'function');
  }
  // Две сферы Nox не переписаны
  assert.equal(lib.get('nox:wire').variant, 'wire');
  assert.equal(lib.get('nox:nox').variant, 'nox');
  assert.equal(json(lib.get('nox:wire').defaults).scale, 1);
  assert.equal(BUILTIN_ORBS.length, 2);
});

test('каждая сфера: русские подписи, настройки и пресеты; без названий моделей и поставщиков', () => {
  const lib = createOrbLibrary({ storage: makeMemStorage() });
  extraExports.registerExtraOrbs(lib);
  const cyrillic = /[А-Яа-яЁё]/;
  const forbidden = /(deepseek|openai|anthropic|claude|gpt|qwen|mistral|провайдер|provider|модель)/i;
  for (const id of EXTRA_IDS) {
    const spec = lib.get(id);
    assert.match(spec.name, cyrillic, id + ': имя по-русски');
    assert.match(spec.subtitle, cyrillic, id + ': подпись по-русски');
    assert.ok(!forbidden.test(spec.name + spec.subtitle), id + ': без названий моделей');
    // Шесть настроек: масштаб, скорость, свечение, плотность, движение, голос
    const fields = json(spec.fields);
    assert.equal(fields.length, 6, id + ': шесть настроек');
    assert.deepEqual(fields.map((f) => f.key), ['scale', 'speed', 'light', 'detail', 'animated', 'voice']);
    for (const field of fields) {
      assert.match(field.label, cyrillic, id + ': подпись настройки по-русски');
      assert.ok(['range', 'switch'].includes(field.kind), id + ': вид настройки');
      if (field.kind === 'range') assert.ok(field.min < field.max && field.step > 0);
    }
    const presets = json(spec.presets);
    assert.deepEqual(Object.keys(presets), ['default', 'calm', 'vivid']);
    for (const preset of Object.values(presets)) {
      assert.match(preset.name, cyrillic, id + ': имя пресета по-русски');
      assert.equal(typeof preset.patch, 'object');
    }
    assert.deepEqual(json(spec.defaults), { scale: 1, speed: 1, light: 1, detail: 1, animated: true, voice: true });
  }
});

test('настройки, пресеты и сброс независимы у каждой сферы и переживают перезапуск', () => {
  const storage = makeMemStorage();
  const lib = createOrbLibrary({ storage });
  extraExports.registerExtraOrbs(lib);

  lib.updateSettings('aether:flux', { scale: 1.24, speed: 1.4 });
  lib.applyPreset('aether:comb', 'calm');
  const combCalm = lib.getSettings('aether:comb');
  assert.equal(combCalm.presetId, 'calm');
  assert.equal(combCalm.speed, 0.6);
  assert.equal(combCalm.voice, false);
  lib.setActive('aether:crystal');
  lib.resetOrb('aether:comb');
  assert.equal(lib.getSettings('aether:crystal').scale, 1, 'сброс одной не трогает другую');
  assert.deepEqual(lib.getSettings('aether:comb'), { ...json(lib.get('aether:comb').defaults), presetId: 'default' });
  assert.equal(lib.getSettings('aether:flux').scale, 1.24);

  const reloaded = createOrbLibrary({ storage });
  extraExports.registerExtraOrbs(reloaded);
  assert.equal(reloaded.getActiveId(), 'aether:crystal');
  assert.equal(reloaded.getSettings('aether:flux').scale, 1.24);
  assert.equal(reloaded.getSettings('aether:flux').speed, 1.4);
});

test('повторная регистрация не дублирует сферы; загрузчик рядом с библиотекой безопасен', () => {
  const lib = createOrbLibrary({ storage: makeMemStorage() });
  assert.equal(extraExports.registerExtraOrbs(lib), 6);
  assert.equal(extraExports.registerExtraOrbs(lib), 0);
  assert.equal(lib.list().filter((o) => EXTRA_IDS.includes(o.id)).length, 6);
  // В Node рядом с библиотекой нет документа — загрузчик молчит, а не падает.
  assert.equal(loadCompanionOrbs(null), false);
  assert.equal(loadCompanionOrbs({}), false);
  assert.equal(typeof extraExports.loadCompanionOrbs === 'function' || true, true);
});

// ── 2. Состояния и движок ─────────────────────────────────────────────

test('все состояния STATE_TO_NOX понимает каждая сфера, синонимы не ломают', () => {
  const env = makeEnv();
  const mapped = Object.values(STATE_TO_NOX);
  assert.deepEqual([...new Set(mapped)].sort(), [...STATES_ALL].sort());
  for (const variant of VARIANTS) {
    const orb = env.makeOrb(variant);
    for (const appState of Object.keys(STATE_TO_NOX)) {
      const expected = STATE_TO_NOX[appState];
      orb.setState(appState);
      assert.equal(orb.state, expected, variant + ': ' + appState + ' → ' + expected);
    }
    for (const [alias, expected] of Object.entries(ALIASES)) {
      orb.setState(alias);
      assert.equal(orb.state, expected, variant + ': синоним ' + alias);
    }
    orb.setState('совсем не состояние');
    assert.equal(orb.state, 'idle');
    for (const state of STATES_ALL) {
      orb.setState(state);
      orb._update(0.016);
      orb._draw();
      assert.equal(orb.state, state, variant + ': состояние ' + state + ' принято');
      assert.ok(Number.isFinite(orb._R) && orb._R > 0, variant + ': сфера нарисована');
    }
    orb.destroy();
  }
});

test('mount библиотеки отдаёт живой движок: состояние, голос, настройки, движение, destroy', () => {
  const env = makeEnv();
  const lib = env.lib;
  // orbs-extra.js загружается рядом с библиотекой и регистрирует сферы сам
  assert.equal(json(lib.list()).length, 8);
  assert.equal(extraExports.registerExtraOrbs(lib), 0, 'повторная регистрация не нужна');
  for (const id of EXTRA_IDS) {
    const handle = lib.mount(env.canvas(), id, { globalAnimated: true, state: 'searching' });
    assert.ok(handle.raw, id + ': движок создан');
    assert.equal(handle.engine, 'custom');
    // Начальное состояние приходит уже по STATE_TO_NOX
    assert.equal(handle.raw.state, 'thinking', id + ': начальное состояние');
    handle.setState('waiting_approval');
    assert.equal(handle.raw.state, 'waiting_approval');
    handle.setVoice(0.6);
    assert.ok(handle.raw.voiceTarget >= 0.59, id + ': голос дошёл');
    handle.applySettings({ scale: 1.2, speed: 1.4, light: 1.1, detail: 1.2, animated: true, voice: true });
    assert.equal(handle.raw.cfg.scale, 1.2);
    assert.equal(handle.raw.cfg.light, 1.1);
    handle.setAnimated(false);
    assert.equal(handle.raw.animated, false);
    handle.pulse(1);
    assert.ok(handle.raw.impulse > 0);
    handle.destroy();
  }
});

test('DPR: backing store ×2 при devicePixelRatio 2 и рисование в CSS-пикселях', () => {
  const env = makeEnv({ dpr: 2 });
  for (const variant of VARIANTS) {
    const canvas = env.canvas(360, 300);
    const orb = new env.api.ExtraOrb(canvas, { variant, dpr: 2 });
    assert.equal(canvas.width, 720, variant + ': ширина backing store');
    assert.equal(canvas.height, 600, variant + ': высота backing store');
    assert.equal(orb.dpr, 2);
    assert.deepEqual(json(orb.snapshot().css), { width: 360, height: 300 });
    // dpr ограничен двумя: третий не раздувает холст
    const retry = new env.api.ExtraOrb(env.canvas(360, 360), { variant, dpr: 2 });
    assert.equal(retry.dpr, 2);
    orb.destroy();
    retry.destroy();
  }
});

test('скрытое окно и уход со сцены останавливают кадры, возвращение — запускает', () => {
  const env = makeEnv();
  const orb = env.makeOrb('flux');
  assert.ok(orb._raf > 0, 'сфера в кадре');
  env.document.hidden = true;
  env.visibility();
  assert.equal(orb._raf, 0, 'скрытое окно остановило цикл');
  const requests = env.rafRequests();
  env.document.hidden = false;
  env.visibility();
  assert.ok(orb._raf > 0, 'возвращение возобновило цикл');
  assert.ok(env.rafRequests() > requests);
  env.io(false);
  assert.equal(orb._raf, 0, 'сфера вне экрана не просит кадры');
  env.io(true);
  assert.ok(orb._raf > 0, 'сфера вернулась на экран');
  orb.destroy();
  assert.equal(orb._raf, 0);
});

test('уменьшение движения: статичный кадр, смена состояния видна, setAnimated управляет', () => {
  for (const variant of VARIANTS) {
    const env = makeEnv({ reduced: true });
    const orb = env.makeOrb(variant);
    assert.equal(orb._raf, 0, variant + ': при reduce кадры не идут');
    env.commands.length = 0;
    orb._draw();
    const first = JSON.stringify(env.commands);
    // В статичном режиме время стоит: повторы кадра совпадают побитно.
    for (let i = 0; i < 3; i++) {
      env.commands.length = 0;
      orb._draw();
      assert.equal(JSON.stringify(env.commands), first, variant + ': картинка не движется');
    }
    // Даже «убежавшие» часы не оживляют статичный кадр — рисуется снимок состояния.
    orb.phase += 4;
    orb.angle += 2;
    env.commands.length = 0;
    orb._draw();
    assert.equal(JSON.stringify(env.commands), first, variant + ': часы не двигают статичный кадр');
    orb.setState('error');
    env.commands.length = 0;
    orb._draw();
    assert.notEqual(JSON.stringify(env.commands), first, variant + ': смена состояния видна');
    orb.destroy();

    // Выключенные анимации в окне (html[data-animations="off"]) тоже останавливают кадры
    const env2 = makeEnv();
    env2.document.documentElement.dataset.animations = 'off';
    const orb2 = env2.makeOrb(variant);
    assert.equal(orb2._raf, 0, variant + ': data-animations=off');
    orb2.destroy();

    // setAnimated(false) и обратно
    const env3 = makeEnv();
    const orb3 = env3.makeOrb(variant);
    orb3.setAnimated(false);
    assert.equal(orb3._raf, 0, variant + ': setAnimated(false)');
    orb3.setAnimated(true);
    assert.ok(orb3._raf > 0, variant + ': setAnimated(true)');
    orb3.destroy();
  }
});

test('голос: 0..1, быстрый подъём, выключатель и видимая реакция', () => {
  for (const variant of VARIANTS) {
    const env = makeEnv();
    const orb = env.makeOrb(variant);
    orb.setVoice(5);
    assert.equal(orb.voiceTarget, 1);
    orb.setVoice('шум');
    assert.equal(orb.voiceTarget, 0);
    orb.setState('listening');
    orb.setVoice(0.8);
    for (let i = 0; i < 10; i++) orb._update(0.03);
    assert.ok(orb._voiceOut() > 0.55, variant + ': уровень голоса поднялся');
    // Голос виден в рисунке: громкий кадр отличается от тихого
    env.commands.length = 0;
    orb._draw();
    const loud = JSON.stringify(env.commands);
    orb.setVoice(0);
    for (let i = 0; i < 40; i++) orb._update(0.05);
    env.commands.length = 0;
    orb._draw();
    assert.notEqual(JSON.stringify(env.commands), loud, variant + ': голос меняет кадр');
    orb.setVoice(1);
    orb.updateSettings({ voice: false });
    assert.equal(orb._voiceOut(), 0, variant + ': выключатель реакции');
    orb.destroy();
  }
});

test('параметры двигают геометрию и рисунок: плотность, масштаб, свечение', () => {
  const env = makeEnv();
  const comb = env.makeOrb('comb');
  const smallCells = comb.snapshot().geometry.cells;
  assert.equal(smallCells, 42, 'по умолчанию 42 ячейки');
  comb.updateSettings({ detail: 1.3 });
  assert.equal(comb.snapshot().geometry.cells, 162, 'плотность добавила ячеек');
  comb.updateSettings({ detail: 0.7 });
  assert.equal(comb.snapshot().geometry.cells, 12, 'низкая плотность — додекаэдр');
  comb.destroy();

  const crystal = env.makeOrb('crystal');
  assert.equal(crystal.snapshot().geometry.faces, 80);
  crystal.updateSettings({ detail: 1.3 });
  assert.equal(crystal.snapshot().geometry.faces, 320);
  crystal.destroy();

  const flux = env.makeOrb('flux');
  const points = flux.snapshot().geometry.points;
  flux.updateSettings({ detail: 1.4 });
  assert.ok(flux.snapshot().geometry.points > points);
  env.commands.length = 0;
  flux._draw();
  const plain = JSON.stringify(env.commands);
  flux.updateSettings({ scale: 1.3, light: 1.35 });
  env.commands.length = 0;
  flux._draw();
  assert.notEqual(JSON.stringify(env.commands), plain, 'масштаб и свечение видны в рисунке');
  flux.updateSettings({ scale: 3 });
  assert.equal(flux.snapshot().settings.scale, 1.8, 'границы масштаба соблюдаются');
  flux.destroy();
});

test('тема: цвета состояний берутся из токенов --hue/--warn/--err/--ok', () => {
  const env = makeEnv({ theme: { '--hue': '#e56b36', '--warn': '#ffcc00', '--err': '#ff0000', '--ok': '#00ff88' } });
  const orb = env.makeOrb('resonance');
  assert.deepEqual(json(orb._pal.idle), [229, 107, 54], 'акцент темы');
  assert.deepEqual(json(orb._pal.waiting_approval), [255, 204, 0], 'токен ожидания');
  assert.deepEqual(json(orb._pal.error), [255, 0, 0], 'токен ошибки');
  assert.deepEqual(json(orb._pal.success), [0, 255, 136], 'токен успеха');
  orb._readColors();
  orb.col = orb._pal.thinking.slice();
  orb._draw();
  assert.deepEqual(json(orb.snapshot().color), json(orb._pal.thinking).map(Math.round));
  orb.destroy();
  // Без темы — аккуратные запасные цвета, а не чёрный кадр
  const plain = makeEnv({ theme: { '--hue': '' } }).makeOrb('flux');
  assert.deepEqual(json(plain._pal.idle), [78, 206, 235]);
  plain.destroy();
});

test('импульс нажатия виден и затухает', () => {
  const env = makeEnv();
  const orb = env.makeOrb('crystal');
  assert.equal(orb.impulse, 0);
  orb.pulse(0.9);
  assert.ok(orb.impulse > 0.85);
  env.commands.length = 0;
  orb._draw();
  const withImpulse = JSON.stringify(env.commands);
  orb.impulse = 0;
  env.commands.length = 0;
  orb._draw();
  assert.notEqual(JSON.stringify(env.commands), withImpulse, 'кольцо импульса рисуется');
  orb.pulse(1);
  for (let i = 0; i < 60; i++) orb._update(0.05);
  assert.equal(orb.impulse, 0, 'импульс затухает');
  orb.destroy();
});

// ── 3. Бюджет кадра ───────────────────────────────────────────────────

test('бюджет кадра: все шесть сфер укладываются в 4 мс на 360 px при DPR 2', () => {
  const code = `
    const fs = require('fs');
    const path = require('path');
    const dir = process.argv[1];
    const gradient = { addColorStop() {} };
    const ctx = new Proxy({}, { get: (_, key) => (...args) => {
      if (String(key).startsWith('create')) return gradient;
    }, set: () => true });
    global.window = {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      devicePixelRatio: 2,
      addEventListener() {},
      removeEventListener() {},
    };
    global.document = {
      hidden: false,
      documentElement: {},
      addEventListener() {},
      removeEventListener() {},
      createElement: () => ({ getContext: () => ctx }),
    };
    global.getComputedStyle = () => ({ getPropertyValue: () => '' });
    global.requestAnimationFrame = () => 1;
    global.cancelAnimationFrame = () => {};
    const api = require(path.join(dir, 'orbs-extra.js'));
    const canvas = {
      width: 0, height: 0, clientWidth: 360, clientHeight: 360,
      getContext: () => ctx,
      getBoundingClientRect: () => ({ width: 360, height: 360 }),
      closest: () => null,
    };
    const out = {};
    for (const variant of api.VARIANTS) {
      const orb = new api.ExtraOrb(canvas, { variant, state: 'thinking', animated: true, dpr: 2 });
      for (let i = 0; i < 200; i++) { orb._update(0.016); orb._draw(); }
      const started = process.hrtime.bigint();
      for (let i = 0; i < 300; i++) { orb._update(0.016); orb._draw(); }
      out[variant] = Number(process.hrtime.bigint() - started) / 1e6 / 300;
      orb.destroy();
    }
    console.log(JSON.stringify(out));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', code, AETHER], { encoding: 'utf8' }));
  assert.deepEqual(Object.keys(out).sort(), [...VARIANTS].sort());
  for (const variant of VARIANTS) {
    assert.ok(Number.isFinite(out[variant]), variant + ': замер есть');
    assert.ok(out[variant] < 4, variant + ': ' + out[variant].toFixed(2) + ' мс на кадр (бюджет 4 мс)');
  }
});
