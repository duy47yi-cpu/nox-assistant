'use strict';

// Свой вид окна и цвет акцента: моментальное применение, сохранение, сброс,
// безопасный дефолт на битое значение и контраст от 4,5:1 на всех темах.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const RENDERER = path.join(__dirname, '../renderer');
const source = fs.readFileSync(path.join(RENDERER, 'theme-boot.js'), 'utf8');
const css = fs.readFileSync(path.join(RENDERER, 'themes.css'), 'utf8');
const themes = {};
for (const [, id, body] of css.matchAll(/\[data-theme="([a-z]+)"\] \{([^}]*)\}/g)) {
  themes[id] = Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1], m[2]]));
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const [r, g, b] = rgb(hex).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// Окружение theme-boot.js: корректная песочница без Electron и без сети.
function boot(saved = {}, opts = {}) {
  const store = new Map(Object.entries(saved));
  const props = {};
  const attrs = {};
  const root = {
    // dataset — те же атрибуты data-*, что и в настоящем DOM.
    dataset: new Proxy({}, {
      get: (_, key) => attrs['data-' + String(key)],
      set: (_, key, value) => { attrs['data-' + String(key)] = String(value); return true; },
      deleteProperty: (_, key) => { delete attrs['data-' + String(key)]; return true; },
    }),
    style: {
      setProperty(name, value) { props[name] = String(value); },
      removeProperty(name) { delete props[name]; },
      getPropertyValue(name) { return props[name] || ''; },
    },
    removeAttribute(name) { delete attrs[name]; },
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    setAttribute(name, value) { attrs[name] = String(value); },
  };
  let tokens = themes.dark;
  const sandbox = {
    window: {
      matchMedia: () => ({ matches: Boolean(opts.systemLight), addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
    },
    document: { documentElement: root, dispatchEvent() {} },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    getComputedStyle: () => ({ getPropertyValue: (name) => tokens[String(name).replace(/^--/, '')] || '' }),
    Event: class { constructor(type) { this.type = type; } },
    console,
  };
  vm.runInNewContext(source, sandbox);
  const T = sandbox.window.JarvisTheme;
  return { T, root, store, props, setTokens: (id) => { tokens = themes[id] || themes.dark; } };
}

const get = (t, key) => t.getLook()[key];

test('свой вид применяется сразу и сохраняется без перезагрузки', () => {
  const { T, root, store } = boot();
  T.setLook({ size: 'xl', round: 'l', panel: 'xl', orb: 'l', blur: 'l', bg: 'solid', glow: false });
  assert.equal(root.style.getPropertyValue('--fs-md'), '16px');
  assert.equal(root.style.getPropertyValue('--panel-r'), '24px');
  assert.equal(root.style.getPropertyValue('--panel-pct'), '11%');
  assert.equal(root.style.getPropertyValue('--orb-scale'), '1.15');
  assert.equal(root.style.getPropertyValue('--glass-blur'), '28px');
  assert.equal(root.dataset.glass, 'l');
  assert.equal(root.dataset.bg, 'solid');
  assert.equal(root.dataset.glow, 'off');
  const saved = JSON.parse(store.get('jarvis.look'));
  assert.equal(saved.size, 'xl');
  assert.equal(saved.blur, 'l');
  assert.equal(saved.bg, 'solid');
  assert.equal(get(T, 'blur'), 'l');
});

test('сброс возвращает вид по умолчанию и убирает сохранённое', () => {
  const { T, root, store } = boot();
  T.setLook({ size: 's', panel: 's', blur: 'off', bg: 'solid' });
  assert.ok(store.has('jarvis.look'));
  T.resetLook();
  assert.equal(store.has('jarvis.look'), false);
  assert.equal(root.style.getPropertyValue('--fs-md'), '14px');
  assert.equal(root.style.getPropertyValue('--panel-pct'), '4%');
  assert.equal(root.style.getPropertyValue('--glass-blur'), '20px');
  assert.equal(root.dataset.bg, undefined);
  assert.equal(root.dataset.glass, undefined);
  for (const key of ['ui', 'head', 'reply', 'size', 'round', 'panel', 'orb', 'blur', 'bg', 'glow']) {
    assert.equal(get(T, key), T.LOOK_DEFAULT[key], `поле ${key} вернулось к умолчанию`);
  }
});

test('битое сохранённое значение падает на безопасный дефолт, а не ломает окно', () => {
  const garbage = boot({ 'jarvis.look': '{"ui":"нет","size":"огромный","panel":42,"blur":"???","bg":[],"glow":"да"}' });
  assert.equal(garbage.props['--fs-md'], '14px');
  assert.equal(get(garbage.T, 'size'), 'm');
  assert.equal(get(garbage.T, 'blur'), 'm');
  assert.equal(get(garbage.T, 'bg'), 'theme');
  assert.equal(get(garbage.T, 'glow'), true);
  const broken = boot({ 'jarvis.look': '{не json' });
  assert.equal(broken.props['--fs-md'], '14px');
  assert.equal(broken.T.getLook().glow, true);
  // sanitizeLook — чистая функция, та же защита для будущих вызовов.
  const clean = broken.T.sanitizeLook('строка');
  assert.equal(clean.size, 'm');
  assert.equal(clean.glow, true);
});

test('неизвестная тема — «Ночь», «Как в системе» следует системной схеме', () => {
  const { T, root } = boot();
  T.apply('нет-такой');
  assert.equal(root.dataset.theme, 'dark');
  const light = boot({}, { systemLight: true });
  light.T.apply('system');
  assert.equal(light.root.dataset.theme, 'light');
});

test('свой акцент читается на каждой теме: текст от 4,5:1 и подпись на плашке', () => {
  for (const [id, tokens] of Object.entries(themes)) {
    const { T, root, props, setTokens } = boot();
    setTokens(id);
    T.apply(id);
    for (const a of T.ACCENTS) {
      if (a.id === 'theme') continue;
      T.setAccent(a.id);
      const hue = props['--user-hue'];
      const ink = props['--user-ink'];
      assert.match(hue, /^#[0-9a-f]{6}$/i, `${id}/${a.id}: цвет задан`);
      assert.equal(root.dataset.accent, a.id);
      for (const back of ['bg', 'surface', 'surface-2', 'surface-3']) {
        if (!tokens[back]) continue;
        const r = ratio(hue, tokens[back]);
        assert.ok(r >= 4.5, `${id}/${a.id}: акцент ${hue} на ${back} ${tokens[back]} = ${r.toFixed(2)}`);
      }
      const inkRatio = ratio(hue, ink);
      assert.ok(inkRatio >= 4.5, `${id}/${a.id}: подпись ${ink} на плашке ${hue} = ${inkRatio.toFixed(2)}`);
    }
    T.setAccent('theme');
    assert.equal(root.dataset.accent, undefined, 'возврат «как в теме» снимает подмену');
    assert.equal(props['--user-hue'], undefined);
  }
});
