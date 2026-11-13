'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BUILTIN_ORBS, DEFAULT_ORB_ID, createOrbLibrary } = require('../renderer/aether/orb-library');

function makeMemStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

test('Библиотека сфер сохраняет обе системы и все 6 встроенных вариантов без путаницы', () => {
  const storage = makeMemStorage();
  const lib = createOrbLibrary({ storage });
  const list = lib.list();
  const ids = list.map((o) => o.id);

  assert.equal(BUILTIN_ORBS.length, 6);
  for (const id of ['nox:nox', 'nox:wire', 'nox:shutter', 'jarvis:core', 'jarvis:sphere', 'jarvis:iris']) {
    assert.ok(ids.includes(id), `Отсутствует сфера ${id}`);
  }

  const noxDot = lib.get('nox:nox');
  const jarvisDot = lib.get('jarvis:sphere');
  assert.equal(noxDot.engine, 'nox');
  assert.equal(jarvisDot.engine, 'jarvis');
  assert.notEqual(noxDot.id, jarvisDot.id);
  assert.equal(lib.getActiveId(), DEFAULT_ORB_ID);
});

test('Настройки каждой сферы независимы, пресеты и сброс не затирают другие сферы', () => {
  const storage = makeMemStorage();
  const lib = createOrbLibrary({ storage });

  lib.setActive('nox:nox');
  lib.updateSettings('nox:nox', { scale: 1.24 });

  lib.setActive('jarvis:sphere');
  lib.applyPreset('jarvis:sphere', 'vivid');
  const afterVivid = lib.getSettings('jarvis:sphere');
  assert.ok(afterVivid.glow > 1.0);

  // Переключились на третью и вернулись на первую — scale остался 1.24
  lib.setActive('nox:wire');
  lib.setActive('nox:nox');
  assert.equal(lib.getSettings('nox:nox').scale, 1.24);

  // Сброс Jarvis Sphere не затрагивает Nox Orb
  lib.resetOrb('jarvis:sphere');
  assert.equal(lib.getSettings('nox:nox').scale, 1.24);
  assert.equal(lib.getSettings('jarvis:sphere').glow, lib.get('jarvis:sphere').defaults.glow);

  // Перезагрузка из того же storage сохраняет выбор и параметры
  const reloaded = createOrbLibrary({ storage });
  assert.equal(reloaded.getActiveId(), 'nox:nox');
  assert.equal(reloaded.getSettings('nox:nox').scale, 1.24);
});

test('Регистрация будущих пользовательских движков через registerOrb работает', () => {
  const storage = makeMemStorage();
  const lib = createOrbLibrary({ storage });
  lib.registerOrb({
    id: 'custom:ring',
    engine: 'custom',
    variant: 'ring',
    name: 'Кольцо',
    desc: 'Экспериментальный движок',
    defaults: { radius: 0.8 },
    fields: [{ key: 'radius', label: 'Радиус', type: 'range', min: 0.4, max: 1.2, step: 0.05 }],
  });

  assert.ok(lib.get('custom:ring'));
  assert.equal(lib.setActive('custom:ring'), true);
  lib.updateSettings('custom:ring', { radius: 1.1 });
  assert.equal(lib.getSettings('custom:ring').radius, 1.1);
});

test('Маппинг состояний обеих систем переводит все рабочие статусы корректно', () => {
  const lib = createOrbLibrary({ storage: makeMemStorage() });
  assert.equal(lib.mapState('nox', 'waiting_approval'), 'waiting_approval');
  assert.equal(lib.mapState('jarvis', 'waiting_approval'), 'waiting_approval');
  assert.equal(lib.mapState('nox', 'verifying'), 'thinking');
  assert.equal(lib.mapState('jarvis', 'verifying'), 'verifying');
  assert.equal(lib.mapState('nox', 'cancelled'), 'idle');
  assert.equal(lib.mapState('jarvis', 'cancelled'), 'cancelled');
});

test('mount и applySettings всегда передают конечный числовой density в JarvisOrb.setTune', () => {
  const tuneCalls = [];
  const ctorCalls = [];
  const prevWin = globalThis.window;
  globalThis.window = {
    JarvisOrb: class FakeJarvisOrb {
      constructor(_canvas, opts) {
        ctorCalls.push(opts);
      }
      setTune(t) {
        tuneCalls.push(t);
      }
      setAnimated() {}
      destroy() {}
    },
  };
  try {
    const lib = createOrbLibrary({ storage: makeMemStorage() });
    for (const id of ['jarvis:core', 'jarvis:sphere', 'jarvis:iris']) {
      const h = lib.mount({}, id, { density: 0.72 });
      h.applySettings(lib.getSettings(id), true);
      h.destroy();
    }
    assert.equal(ctorCalls.length, 3);
    assert.equal(tuneCalls.length, 6);
    for (const c of ctorCalls) assert.ok(Number.isFinite(c.density) && c.density > 0);
    for (const t of tuneCalls) assert.ok(Number.isFinite(t.density) && t.density > 0);
  } finally {
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
  }
});
