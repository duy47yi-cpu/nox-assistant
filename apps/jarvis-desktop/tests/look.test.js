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

test('эффект на фоне: «как в теме» берёт эффект темы, свой выбор виден на любой теме и фоне', () => {
  const { T, root, store } = boot({ 'jarvis.theme': JSON.stringify('starry') });
  assert.equal(T.LOOK_DEFAULT.fx, 'theme');
  assert.equal(root.dataset.fx, 'stars', 'звёздная ночь показывает звёзды');
  T.setLook({ bg: 'solid' });
  assert.equal(root.dataset.fx, undefined, 'сплошной фон убирает эффект темы');
  T.setLook({ fx: 'rain' });
  assert.equal(root.dataset.fx, 'rain', 'явный выбор виден и на сплошном фоне');
  assert.equal(JSON.parse(store.get('jarvis.look')).fx, 'rain');
  T.setLook({ fx: 'off', bg: 'theme' });
  assert.equal(root.dataset.fx, undefined, '«Без эффекта» выключает и эффект темы');
  T.setLook({ fx: 'theme' });
  T.apply('dark');
  assert.equal(root.dataset.fx, undefined, 'у «Ночи» своего эффекта нет');
  T.apply('liquid');
  assert.equal(root.dataset.fx, 'waves', 'смена темы меняет эффект');
  T.setLook({ fx: 'snow' });
  T.apply('light');
  assert.equal(root.dataset.fx, 'snow');
  for (const bad of ['fog', '', 5, null, {}]) assert.equal(T.sanitizeLook({ fx: bad }).fx, 'theme');
  for (const fx of Object.values(T.THEME_FX)) assert.ok(T.FXS[fx], `эффект темы ${fx} можно выбрать вручную`);
  T.resetToTheme();
  assert.equal(root.dataset.fx, 'waves' === T.THEME_FX[root.dataset.theme] ? 'waves' : undefined);
});

test('своя картинка: фон image, затемнение и размытие уходят в CSS-переменные', () => {
  const { T, root, props } = boot();
  assert.equal(props['--own-bg-dim'], '40%');
  assert.equal(props['--own-bg-blur'], '6px');
  assert.equal(root.dataset.bg, undefined);
  T.setLook({ bg: 'image', bgDim: '35', bgBlur: '16' });
  assert.equal(root.dataset.bg, 'image');
  assert.equal(props['--own-bg-dim'], '35%');
  assert.equal(props['--own-bg-blur'], '16px');
  assert.equal(Object.keys(T.BG_DIMS).length, 19, '0–90 % шагом 5');
  for (const bad of ['95', '-5', '7', 40, null]) assert.equal(T.sanitizeLook({ bgDim: bad, bgBlur: bad }).bgDim, '40');
  assert.equal(T.sanitizeLook({ bg: 'video' }).bg, 'theme');
  T.setLook({ bg: 'solid' });
  assert.equal(root.dataset.bg, 'solid', 'сплошной фон работает как раньше');
  T.resetToTheme();
  assert.equal(root.dataset.bg, undefined);
});

test('backdrop.js: принимает только картинки до 25 МБ, без хранилища окно не падает', () => {
  const attrs = {};
  const sandbox = {
    window: {},
    document: { documentElement: { dataset: attrs, style: { setProperty() {}, removeProperty() {} } }, dispatchEvent() {} },
    indexedDB: { open() { throw new Error('нет хранилища'); } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Event: class {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(RENDERER, 'backdrop.js'), 'utf8'), sandbox);
  const B = sandbox.window.NoxBackdrop;
  assert.equal(B.has(), false);
  assert.equal(B.reject({ type: 'image/png', size: 1024 }), null);
  assert.equal(B.reject({ type: 'image/gif', size: B.MAX_BYTES }), null);
  assert.match(B.reject({ type: 'image/png', size: B.MAX_BYTES + 1 }), /25 МБ/);
  assert.match(B.reject({ type: 'image/png', size: 0 }), /пустой/);
  for (const type of ['image/svg+xml', 'video/mp4', 'text/html', '']) assert.match(B.reject({ type, size: 10 }), /Нужна картинка/, type);
  assert.match(B.reject(null), /Нужна картинка/);
});

test('фон в разделах Nox: слои под панелями, панели полупрозрачны только с картинкой или эффектом', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(RENDERER, 'backdrop.css'), 'utf8');
  assert.match(html, /<div class="theme-bg" aria-hidden="true"><\/div>/);
  assert.match(html, /img-src 'self' data: blob:;/, 'картинка показывается из blob: этого окна');
  assert.ok(html.indexOf('backdrop.css') > html.indexOf('nox-shell.css'), 'backdrop.css — последний слой');
  assert.ok(html.indexOf('backdrop.js') < html.indexOf('look.js'));
  assert.match(css, /html\[data-bg="image"\]\[data-own-bg\] \.theme-bg \{ display: block; \}/);
  assert.match(css, /\.theme-bg \{[^}]*pointer-events: none;[^}]*display: none; \}/);
  // Стекло у всех тем с градиентом фона и только у них: список в backdrop.css не расходится с themes.css.
  const themesCss = fs.readFileSync(path.join(RENDERER, 'themes.css'), 'utf8');
  const gradient = [...themesCss.matchAll(/\[data-theme="([a-z]+)"\] \{([^}]*)\}/g)].filter((m) => /--bg-image: (?!none)/.test(m[2])).map((m) => m[1]).sort();
  const glassRule = css.match(/html:is\(\[data-fx\], \[data-bg="image"\]\[data-own-bg\], :is\(([^)]*)\):not\(\[data-bg\]\)\) body\[data-view\] \{\s*--nox-surface-1:/);
  assert.ok(glassRule, 'правило полупрозрачных панелей');
  assert.deepEqual([...glassRule[1].matchAll(/data-theme="([a-z]+)"/g)].map((m) => m[1]).sort(), gradient);
  const settingsCss = fs.readFileSync(path.join(RENDERER, 'nox-settings.css'), 'utf8');
  assert.doesNotMatch(settingsCss, /\.theme-mini \.tm-panel \{ display: none; \}/, 'образец темы в Настройках показывается целиком');
  assert.match(lookSource, /row\('Своя картинка'/);
  assert.match(lookSource, /alpha\('bgDim', T\.BG_DIMS/);
  assert.match(lookSource, /seg\('bgBlur', T\.BG_BLURS/);
  assert.match(lookSource, /select\('fx', T\.FXS/);
});

test('строки настроек есть в look.js и берут значения из theme-boot', () => {
  assert.match(lookSource, /row\('Прозрачность окна'/);
  assert.match(lookSource, /alpha\('winAlpha', T\.WIN_ALPHAS/, 'компактный ползунок вместо 13 кнопок');
  assert.doesNotMatch(lookSource, /seg\('winAlpha'/);
  assert.match(lookSource, /row\('Радиус окна'/);
  assert.match(lookSource, /seg\('winRadius', T\.WIN_RADII/);
  assert.match(lookSource, /resetToTheme/);
  assert.match(lookSource, /прозрачность и радиус окна/, 'подпись сброса упоминает новые ручки');
});
