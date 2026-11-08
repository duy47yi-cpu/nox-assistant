'use strict';

// Прозрачность и радиус окна: строки Настроек → Вид, пределы значений, дефолты,
// сохранение в jarvis.look, сброс к теме и связь с CSS-переменными --win-alpha / --win-radius.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const RENDERER = path.join(__dirname, '../renderer');
const source = fs.readFileSync(path.join(RENDERER, 'theme-boot.js'), 'utf8');
const lookSource = fs.readFileSync(path.join(RENDERER, 'look.js'), 'utf8');
const presence = fs.readFileSync(path.join(RENDERER, 'presence.css'), 'utf8');

// Окружение theme-boot.js: песочница без Electron, сети и настоящего DOM.
function boot(saved = {}) {
  const store = new Map(Object.entries(saved));
  const props = {};
  const attrs = {};
  const root = {
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
  const sandbox = {
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
    },
    document: { documentElement: root, dispatchEvent() {} },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Event: class { constructor(type) { this.type = type; } },
    console,
  };
  vm.runInNewContext(source, sandbox);
  return { T: sandbox.window.JarvisTheme, root, store, props };
}

const get = (t, key) => t.getLook()[key];

test('дефолты: прозрачность 0 % и прямые углы — окно как до настройки', () => {
  const { T, root, props } = boot();
  assert.equal(T.LOOK_DEFAULT.winAlpha, '0');
  assert.equal(T.LOOK_DEFAULT.winRadius, '0');
  assert.equal(get(T, 'winAlpha'), '0');
  assert.equal(get(T, 'winRadius'), '0');
  assert.equal(props['--win-alpha'], '0', '0 — фон непрозрачный, как сейчас');
  assert.equal(props['--win-radius'], '0px', '0 — прямые углы');
  assert.equal(root.dataset.winAlpha, undefined);
  // Прозрачность — 0..60 % шагом 5, радиус — 0/8/14/22/28.
  assert.deepEqual(Object.keys(T.WIN_ALPHAS), ['0', '5', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55', '60']);
  assert.equal(T.WIN_ALPHAS['0'][0], 'Как сейчас');
  assert.equal(T.WIN_ALPHAS['35'][1], 35);
  assert.deepEqual(Object.keys(T.WIN_RADII), ['0', '8', '14', '22', '28']);
  assert.deepEqual(Object.values(T.WIN_RADII).map((v) => v[1]), [0, 8, 14, 22, 28]);
});

test('прозрачность 0–60 %: --win-alpha 0..0.6, сохранение и флаг подложки', () => {
  const { T, root, store, props } = boot();
  for (const [id, [, percent]] of Object.entries(T.WIN_ALPHAS)) {
    T.setLook({ winAlpha: id });
    assert.equal(props['--win-alpha'], String(percent / 100), `${id} %`);
    assert.equal(JSON.parse(store.get('jarvis.look')).winAlpha, id, 'сохранено в jarvis.look');
    assert.equal(get(T, 'winAlpha'), id);
    if (percent > 0) assert.equal(root.dataset.winAlpha, 'on', `${id} %: подложка окна`);
    else assert.equal(root.dataset.winAlpha, undefined, '0 %: как сейчас');
  }
  T.setLook({ winAlpha: '60' });
  assert.equal(props['--win-alpha'], '0.6');
  T.setLook({ winAlpha: '0' });
  assert.equal(props['--win-alpha'], '0');
});

test('радиус окна 0/8/14/22/28: пиксели в --win-radius и сохранение', () => {
  const { T, store, props } = boot();
  for (const [id, [, px]] of Object.entries(T.WIN_RADII)) {
    T.setLook({ winRadius: id });
    assert.equal(props['--win-radius'], `${px}px`, id);
    assert.equal(JSON.parse(store.get('jarvis.look')).winRadius, id);
    assert.equal(get(T, 'winRadius'), id);
  }
});

test('пределы и мусор: вне списка — безопасный дефолт, сохранённое значение проверяется', () => {
  const { T } = boot();
  for (const bad of ['65', '-5', '17', '30.5', '', 35, 22, null, {}, [], 'нет']) {
    const clean = T.sanitizeLook({ winAlpha: bad, winRadius: bad });
    assert.equal(clean.winAlpha, '0', `winAlpha=${JSON.stringify(bad)}`);
    assert.equal(clean.winRadius, '0', `winRadius=${JSON.stringify(bad)}`);
  }
  const saved = boot({ 'jarvis.look': JSON.stringify({ winAlpha: '60', winRadius: '28' }) });
  assert.equal(saved.T.getLook().winAlpha, '60');
  assert.equal(saved.T.getLook().winRadius, '28');
  assert.equal(saved.props['--win-alpha'], '0.6');
  assert.equal(saved.props['--win-radius'], '28px');
  // Битый JSON не роняет окно: значения остаются по умолчанию.
  const broken = boot({ 'jarvis.look': '{не json' });
  assert.equal(broken.props['--win-alpha'], '0');
  assert.equal(broken.props['--win-radius'], '0px');
});

test('сброс к теме возвращает прозрачность 0 % и прямые углы', () => {
  const { T, root, store, props } = boot({ 'jarvis.theme': JSON.stringify('lime') });
  T.setLook({ winAlpha: '35', winRadius: '22' });
  assert.equal(props['--win-alpha'], '0.35');
  assert.equal(props['--win-radius'], '22px');
  T.resetToTheme();
  assert.equal(root.dataset.theme, 'lime', 'тема не меняется');
  assert.equal(props['--win-alpha'], '0');
  assert.equal(props['--win-radius'], '0px');
  assert.equal(root.dataset.winAlpha, undefined);
  assert.equal(store.has('jarvis.look'), false);
  assert.equal(get(T, 'winAlpha'), T.LOOK_DEFAULT.winAlpha);
  assert.equal(get(T, 'winRadius'), T.LOOK_DEFAULT.winRadius);
});

test('CSS читает переменные: color-mix с transparent, скругление корня с overflow: clip', () => {
  // Прозрачность — только фон: color-mix от цвета темы к прозрачному, текст не трогаем.
  assert.match(presence, /\.app \{ background: var\(--grain\), var\(--bg-image\), var\(--win-bg\)/);
  assert.match(presence, /--win-bg: color-mix\(in srgb, var\(--bg\) calc\(\(1 - var\(--win-alpha, 0\)\) \* 100%\), transparent\)/);
  // Радиус корня и обрезка содержимого; при 0 px — прямые углы.
  assert.match(presence, /\.app \{[^}]*overflow: clip;/);
  assert.match(presence, /\.app \{[^}]*border-radius: var\(--win-radius, 0px\);/);
  // При прозрачности подложкой становится фон окна, а не сплошной body.
  assert.match(presence, /html\[data-win-alpha\] \{ background: transparent; \}/);
  assert.match(presence, /html\[data-win-alpha\] body \{ background: transparent; \}/);
});

test('строки настроек есть в look.js и берут значения из theme-boot', () => {
  assert.match(lookSource, /row\('Прозрачность окна'/);
  assert.match(lookSource, /seg\('winAlpha', T\.WIN_ALPHAS/);
  assert.match(lookSource, /row\('Радиус окна'/);
  assert.match(lookSource, /seg\('winRadius', T\.WIN_RADII/);
  assert.match(lookSource, /resetToTheme/);
  assert.match(lookSource, /прозрачность и радиус окна/, 'подпись сброса упоминает новые ручки');
});
