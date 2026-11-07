'use strict';
// Контраст каждой темы по токенам из themes.css: текст от 4,5:1 на всех поверхностях и точках градиента.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, 'themes.css'), 'utf8');
const themes = {};
for (const [, id, body] of css.matchAll(/\[data-theme="([a-z]+)"\] \{([^}]*)\}/g)) {
  themes[id] = Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1], m[2]]));
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h) => {
  const [r, g, b] = rgb(h).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('есть все темы из theme-boot.js', () => {
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  const ids = [...boot.match(/IDS = \[([^\]]+)\]/)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).filter((i) => i !== 'system');
  assert.deepStrictEqual(Object.keys(themes).sort(), ids.sort());
  assert.ok(ids.length >= 8 && ids.length <= 24);
});

// Наборы по мотивам Luxify: каждый есть в IDS, в themes.css и кнопкой с подписью.
const LUX = {
  liquid: 'Жидкое стекло', liquidday: 'Жидкое стекло, день', frost: 'Матовое стекло', gradient: 'Градиент',
  gradientday: 'Градиент, день', midnight: 'Полночь', neon: 'Неон', starry: 'Звёздная ночь', moonlight: 'Лунный свет', sunrise: 'Рассвет',
};
test('наборы по мотивам Luxify: в IDS, в темах и кнопкой', () => {
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const ids = [...boot.match(/IDS = \[([^\]]+)\]/)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  for (const [id, name] of Object.entries(LUX)) {
    assert.ok(ids.includes(id), `${id} в IDS`);
    assert.ok(themes[id], `${id} в themes.css`);
    assert.match(html, new RegExp(`data-theme-opt="${id}"[^\\n]*</span>${name}</button>`), `кнопка ${id} «${name}»`);
  }
  // Подписи не повторяются: прежний «Рассвет» (dawn) теперь «Пастель».
  const labels = [...html.matchAll(/data-theme-opt="[a-z]+"[^\n]*<\/span>([^<]+)<\/button>/g)].map((m) => m[1]);
  assert.equal(new Set(labels).size, labels.length, labels.join(', '));
  assert.match(html, /<div class="theme-fx" aria-hidden="true"><\/div>/);
});

test('эффекты фона: у своих наборов, слабые, движение выключается', () => {
  for (const id of ['starry', 'liquid', 'moonlight', 'sunrise']) {
    assert.match(css, new RegExp(`html(\\[data-theme="${id}"\\]|:is\\([^)]*"${id}"[^)]*\\)) \\.theme-fx::before \\{[^}]*animation: fx`), `эффект ${id}`);
  }
  assert.match(css, /html\[data-bg="solid"\] \.theme-fx \{ display: none; \}/, 'сплошной фон убирает эффект');
  assert.match(css, /\.theme-fx \{[^}]*pointer-events: none/, 'эффект не ловит мышь');
  const rm = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.theme-fx::before, \.theme-fx::after \{ animation: none !important; \}/);
  assert.ok(rm, 'reduced-motion выключает движение эффектов');
  // Линии волн слабые (не больше 0,3): фон не спорит с текстом.
  const fx = css.slice(css.indexOf('/* ── Эффекты фона'), css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .theme-fx'));
  const waves = [...fx.matchAll(/stroke-opacity='(\.\d+)'/g)];
  assert.ok(waves.length >= 6);
  for (const [, a] of waves) assert.ok(Number(a) <= 0.3, `линия волны ${a}`);
});

for (const [id, t] of Object.entries(themes)) {
  test(`контраст темы ${id}`, () => {
    const backs = ['bg', 'g1', 'g2', 'g3', 'surface', 'surface-2'].filter((k) => t[k]);
    for (const fg of ['text', 'text-2', 'text-3', 'warn', 'hue']) {
      for (const bg of backs) {
        // Акцент и янтарь не лежат на голом градиенте: они на панелях.
        if ((fg === 'warn' || fg === 'hue') && bg.startsWith('g')) continue;
        const r = ratio(t[fg], t[bg]);
        assert.ok(r >= 4.5, `${fg} ${t[fg]} на ${bg} ${t[bg]} = ${r.toFixed(2)}`);
      }
    }
    assert.ok(ratio(t.text, t['surface-3']) >= 4.5, 'text на surface-3');
    for (const fg of ['ok', 'err']) assert.ok(ratio(t[fg], t.surface) >= 4.5, `${fg} на surface`);
    for (const hue of ['hue', 'hue-deals', 'hue-journal', 'hue-commands', 'hue-settings']) {
      if (!t[hue]) continue;
      assert.ok(ratio(t[hue], t.surface) >= 4.5, `${hue} на surface`);
      assert.ok(ratio(t['accent-ink'], t[hue]) >= 4.5, `accent-ink на ${hue}`);
      // «Ваша очередь» не сливается с акцентом: расстояние в RGB.
      const [a, b] = [rgb(t.warn), rgb(t[hue])];
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) >= 70, `warn близок к ${hue}`);
    }
  });
}

// Одна раскладка: варианты «Архив», «Планшет», «Акрил» убраны отовсюду.
test('убранные варианты archive, tablet, acrylic нигде не остались', () => {
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const presence = fs.readFileSync(path.join(__dirname, 'presence.css'), 'utf8');
  for (const v of ['archive', 'archiveday', 'tablet', 'tabletday', 'acrylic', 'acrylicday']) {
    assert.ok(!themes[v], `${v}: нет в themes.css`);
    assert.ok(!boot.includes(`'${v}'`), `${v}: нет в theme-boot.js`);
    assert.ok(!html.includes(`data-theme-opt="${v}"`), `${v}: нет кнопки`);
    assert.ok(!presence.includes(`data-theme^="${v}"`), `${v}: нет раскладки в presence.css`);
  }
  assert.ok(!presence.includes('Три варианта вида'));
});

test('у каждой темы кнопка, а светлые темы совпадают с color-scheme', () => {
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const light = [...boot.match(/LIGHT_THEMES = \[([^\]]+)\]/)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const scheme = Object.fromEntries([...css.matchAll(/\[data-theme="([a-z]+)"\] \{\s*color-scheme: (dark|light)/g)].map((m) => [m[1], m[2]]));
  for (const id of Object.keys(themes)) {
    assert.ok(html.includes(`data-theme-opt="${id}"`), `кнопка ${id}`);
    assert.ok(scheme[id], `color-scheme у ${id}`);
    assert.equal(light.includes(id), scheme[id] === 'light', `LIGHT_THEMES и color-scheme у ${id}`);
  }
});

test('тема — набор целиком: «Стекло» задаёт свою прозрачность и размытие', () => {
  const tok = (id) => css.match(new RegExp(`\\[data-theme${id ? `="${id}"` : ''}\\] \\{[^}]*--panel-pct: (\\d+)%; --glass-blur: (\\d+)px;`));
  assert.deepStrictEqual(tok('').slice(1), ['4', '20'], 'по умолчанию у всех тем');
  const glass = tok('glass');
  assert.ok(glass, 'у «Стекла» свои панели и размытие');
  assert.ok(Number(glass[2]) > 20, 'размытие сильнее обычного');
  assert.ok(themes.glass.bg && themes.glass.hue, 'токены «Стекла» на месте');
  assert.match(css, /html\[data-theme="glass"\]:not\(\[data-glass="off"\]\) \{[^}]*--glass-panel: blur\(var\(--glass-blur\)\)/);
  // Без свечений, пятен и градиентного текста.
  const block = css.slice(css.indexOf('/* Стекло:'), css.indexOf('/* Фон окна'));
  assert.ok(block.length > 100);
  assert.ok(!/radial-gradient|text-shadow|background-clip:\s*text/.test(block));
});
