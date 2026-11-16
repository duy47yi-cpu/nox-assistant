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

test('Библиотека сфер сохраняет 2 встроенных варианта System Nox', () => {
  const storage = makeMemStorage();
  const lib = createOrbLibrary({ storage });
  const list = lib.list();
  const ids = list.map((o) => o.id);

  assert.equal(BUILTIN_ORBS.length, 2);
  for (const id of ['nox:nox', 'nox:wire']) {
    assert.ok(ids.includes(id), `Отсутствует сфера ${id}`);
  }

  const sphereNox = lib.get('nox:nox');
  const gridNox = lib.get('nox:wire');
  assert.equal(sphereNox.engine, 'nox');
  assert.equal(gridNox.engine, 'nox');
  assert.notEqual(sphereNox.id, gridNox.id);
  assert.equal(lib.getActiveId(), DEFAULT_ORB_ID);
});

test('Настройки каждой сферы независимы, пресеты и сброс не затирают другие сферы', () => {
  const storage = makeMemStorage();
  const lib = createOrbLibrary({ storage });

  lib.setActive('nox:nox');
  lib.updateSettings('nox:nox', { scale: 1.24 });

  lib.setActive('nox:wire');
  lib.applyPreset('nox:wire', 'vivid');
  const afterVivid = lib.getSettings('nox:wire');
  assert.ok(afterVivid.scale > 1.0);

  // Переключились и вернулись — scale остался 1.24
  lib.setActive('nox:wire');
  lib.setActive('nox:nox');
  assert.equal(lib.getSettings('nox:nox').scale, 1.24);

  // Сброс второй сферы не затрагивает первую
  lib.resetOrb('nox:wire');
  assert.equal(lib.getSettings('nox:nox').scale, 1.24);
  assert.equal(lib.getSettings('nox:wire').scale, lib.get('nox:wire').defaults.scale);

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

test('mount и applySettings работают для оставшихся сфер Nox', () => {
  const prevWin = globalThis.window;
  globalThis.window = {
    NoxOrb: class FakeNoxOrb {
      constructor(_canvas, opts) { this.opts = opts; }
      setState() {}
      setScale() {}
      setAnimated() {}
      destroy() {}
    },
  };
  try {
    const lib = createOrbLibrary({ storage: makeMemStorage() });
    for (const id of ['nox:nox', 'nox:wire']) {
      const h = lib.mount({}, id);
      assert.ok(h.raw, `mount ${id} должен создать инстанс`);
      h.applySettings({ scale: 1.2 }, true);
      h.destroy();
    }
  } finally {
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
  }
});
