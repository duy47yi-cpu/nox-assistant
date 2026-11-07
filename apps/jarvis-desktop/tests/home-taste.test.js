'use strict';
// Главная «журнал ночных наблюдений»: крупный сериф, строки вместо пилюль, плоский знак, контраст тёплых тем.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const presence = fs.readFileSync(path.join(R, 'presence.css'), 'utf8');
const themesCss = fs.readFileSync(path.join(R, 'themes.css'), 'utf8');
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const all = [...presence.matchAll(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`, 'g'))];
  assert.ok(all.length, `нет правила ${sel}`);
  return all.at(-1)[1];
};

test('шрифт заголовка IBM Plex Serif подключён из fonts/ и стоит на обоих заголовках главной', () => {
  assert.match(themesCss, /@font-face \{ font-family: "IBM Plex Serif"; src: url\("fonts\/IBMPlexSerif-Regular\.ttf"\)/);
  assert.ok(fs.statSync(path.join(R, 'fonts', 'IBMPlexSerif-Regular.ttf')).size > 50000);
  assert.match(presence, /--font-display: "IBM Plex Serif"/);
  const size = (body) => Number(body.match(/(\d+)px\/\d+px var\(--font-display\)/)[1]);
  const h = size(rule('.chat-empty h2'));
  const s = size(rule('#stageStatus .status-main'));
  // Настоящий скачок размера относительно текста ответа (15px).
  assert.ok(h >= 15 * 3, `заголовок чата ${h}px`);
  assert.ok(s >= 15 * 2, `заголовок сцены ${s}px`);
});

test('«Готов помочь»: действия строками с номерами, без пилюль', () => {
  assert.ok(!html.includes('scene-chips'), 'старых пилюль в разметке нет');
  assert.ok(!presence.includes('scene-chips'), 'старых пилюль в стилях нет');
  const list = html.match(/<ol class="scene-list"[\s\S]*?<\/ol>/);
  assert.ok(list, 'есть список действий');
  const items = [...list[0].matchAll(/data-scene-draft="[^"]*"/g)];
  assert.strictEqual(items.length, 3);
  assert.deepStrictEqual([...list[0].matchAll(/class="scene-idx"[^>]*>(\d\d)</g)].map((m) => m[1]), ['01', '02', '03']);
  assert.match(rule('.scene-list button'), /border-radius: 0/);
  assert.doesNotMatch(rule('.scene-list button'), /999px/);
});

test('подпись «Джарвис» под шаром в обычном регистре', () => {
  assert.match(html, /<p class="scene-name">Джарвис<\/p>/);
  assert.match(rule('.scene-name'), /text-transform: none/);
});

test('знак «Nox» в рейке плоский: без градиента, блика и свечения', () => {
  const mark = rule('.rail-mark');
  assert.doesNotMatch(mark, /gradient/);
  assert.doesNotMatch(mark, /#fff/i);
  // Тень только сплошная внутренняя (серп), без размытия.
  for (const m of mark.matchAll(/box-shadow: ([^;]+)/g)) assert.match(m[1], /^inset -?\d+px -?\d+px 0 0 var\(--text\)$/);
});

test('зерно слабое и без пятен света', () => {
  const alpha = Number(presence.match(/--grain: url\([^)]*?0 0 0 \.(\d+) 0'/)[1].padEnd(2, '0')) / 100;
  assert.ok(alpha > 0 && alpha <= 0.12, `сила зерна ${alpha}`);
  assert.match(presence, /\.app::before, \.app::after \{ display: none !important; \}/);
});

// Контраст тёплых «Ночи» и «Дня» на поверхностях главной (общая проверка всех тем — в renderer/themes.test.js).
const token = (id, name) => themesCss.match(new RegExp(`\\[data-theme="${id}"\\] \\{[^}]*--${name}: (#[0-9A-Fa-f]{6})`))[1];
const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
  .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
for (const id of ['dark', 'light']) {
  test(`контраст текста главной в теме ${id} не ниже 4,5:1`, () => {
    for (const fg of ['text', 'text-2', 'text-3']) {
      for (const bg of ['bg', 'surface', 'surface-2']) {
        const r = ratio(token(id, fg), token(id, bg));
        assert.ok(r >= 4.5, `${fg} на ${bg} = ${r.toFixed(2)}`);
      }
    }
  });
  test(`нейтрали темы ${id} тёплые, а не холодно-серые`, () => {
    const [r, , b] = [1, 3, 5].map((i) => parseInt(token(id, 'bg').slice(i, i + 2), 16));
    assert.ok(r > b, `bg ${token(id, 'bg')}`);
  });
}

// Сочная главная: свет с источником, стекло панелей, движение только по состоянию.
test('свет главной: ключ золотом и заполняющий акцентом, в покое неподвижен, выключается настройкой', () => {
  const base = rule('body[data-view="dialog"] .main::before');
  assert.match(base, /var\(--light-key\)/);
  assert.match(base, /var\(--hue\)/);
  assert.doesNotMatch(base, /animation/, 'в покое свет не движется');
  assert.match(presence, /\.main:has\(#stage:is\(\[data-state="thinking"\][^)]*\)\)::before \{ animation: noxBreath/);
  assert.match(presence, /\.main:has\(#stage\[data-state="acting"\]\)::after \{ opacity: 1; animation: noxEdgeRun/);
  assert.match(presence, /html:is\(\[data-glow="off"\], \[data-bg="solid"\]\) \.main::before \{ display: none; \}/);
  assert.doesNotMatch(presence, /background-clip: text/, 'без градиентного текста');
});

test('стекло: рейка и сцена берут размытие из настройки, у панелей светлый край сверху', () => {
  assert.match(rule('.rail'), /backdrop-filter: var\(--glass-panel, none\)/);
  assert.match(rule('.stage'), /backdrop-filter: var\(--glass-panel, none\)/);
  assert.match(presence, /\.stage \{ box-shadow: inset 0 1px 0 var\(--edge-hi\)/);
});

test('reduced-motion выключает дыхание света, бегущую линию и ореол шара', () => {
  const blocks = [...presence.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  for (const sel of ['.main::before', '.main::after', '.orbit-core::after']) assert.ok(blocks.includes(sel), sel);
  assert.match(blocks, /animation: none !important/);
});
