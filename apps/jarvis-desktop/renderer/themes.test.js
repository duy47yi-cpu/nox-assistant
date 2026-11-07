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
  assert.ok(ids.length >= 8 && ids.length <= 12);
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
