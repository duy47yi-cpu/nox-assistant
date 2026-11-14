'use strict';
// Контраст каждой темы по токенам из themes.css: текст от 4,5:1 на всех поверхностях и точках градиента.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, 'themes.css'), 'utf8');
const themes = {};
for (const [, id, body] of css.matchAll(/\[data-theme="([a-z-]+)"\] \{([^}]*)\}/g)) {
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
  const ids = [...boot.match(/IDS = \[([^\]]+)\]/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).filter((i) => i !== 'system');
  assert.deepStrictEqual(Object.keys(themes).sort(), ids.sort());
  assert.ok(ids.length >= 8);
});

// Наборы по мотивам Luxify: каждый есть в IDS, в themes.css и кнопкой с подписью.
const LUX = {
  'blue-hour': 'Синий час', eclipse: 'Затмение',
  liquid: 'Жидкое стекло', liquidday: 'Жидкое стекло, день', frost: 'Матовое стекло', gradient: 'Градиент',
  gradientday: 'Градиент, день', midnight: 'Полночь', neon: 'Неон', starry: 'Звёздная ночь', moonlight: 'Лунный свет', sunrise: 'Рассвет',
};
test('наборы по мотивам Luxify: в IDS, в темах и кнопкой', () => {
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const ids = [...boot.match(/IDS = \[([^\]]+)\]/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  for (const [id, name] of Object.entries(LUX)) {
    assert.ok(ids.includes(id), `${id} в IDS`);
    assert.ok(themes[id], `${id} в themes.css`);
    assert.match(html, new RegExp(`data-theme-opt="${id}"[^\\n]*</span>${name}</button>`), `кнопка ${id} «${name}»`);
  }
  // Подписи не повторяются: прежний «Рассвет» (dawn) теперь «Пастель».
  const labels = [...html.matchAll(/data-theme-opt="[a-z-]+"[^\n]*<\/span>([^<]+)<\/button>/g)].map((m) => m[1]);
  assert.equal(new Set(labels).size, labels.length, labels.join(', '));
  assert.match(html, /<div class="theme-fx" aria-hidden="true"><\/div>/);
});

test('эффекты фона: у своих наборов, слабые, движение выключается', () => {
  // Эффект выбирается отдельно от темы: рисунки висят на html[data-fx], а не на теме.
  for (const id of ['stars', 'waves', 'moon', 'dawn', 'snow', 'rain', 'pattern']) {
    assert.match(css, new RegExp(`html\\[data-fx="${id}"\\] \\.theme-fx::before \\{[^}]*animation: fx`), `эффект ${id}`);
  }
  assert.doesNotMatch(css, /\nhtml(:is\()?\[data-theme[^{\n]*\.theme-fx/, 'эффекты не привязаны к теме');
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  // У каждого эффекта из списка в «Виде» есть рисунок, и у каждого эффекта темы тоже.
  const offered = [...boot.match(/const FXS = \{([\s\S]*?)\};/)[1].matchAll(/([a-z-]+): \[/g)].map((m) => m[1]).filter((id) => id !== 'theme' && id !== 'off');
  const themed = [...boot.match(/const THEME_FX = \{([^}]*)\}/)[1].matchAll(/: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(offered.length >= 9);
  for (const id of new Set([...offered, ...themed])) assert.ok(css.includes(`html[data-fx="${id}"] .theme-fx::before {`), `рисунок эффекта ${id}`);
  assert.match(css, /html\[data-fx\] \.theme-fx \{ display: block; \}/);
  assert.match(css, /\.theme-fx \{[^}]*pointer-events: none/, 'эффект не ловит мышь');
  const rm = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*([^{}]+)\{\s*animation: none !important; \}/);
  assert.ok(rm, 'reduced-motion выключает движение эффектов');
  assert.match(rm[1], /\.theme-fx::before/, 'reduce гасит первый слой');
  assert.match(rm[1], /\.theme-fx::after/, 'reduce гасит второй слой');
  // Линии волн слабые (не больше 0,3): фон не спорит с текстом.
  const fx = css.slice(css.indexOf('/* ── Эффекты фона'), css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .theme-fx'));
  const waves = [...fx.matchAll(/stroke-opacity='(\.\d+)'/g)];
  assert.ok(waves.length >= 6);
  for (const [, a] of waves) assert.ok(Number(a) <= 0.3, `линия волны ${a}`);
});

test('все девять эффектов фона: при уменьшении движения гаснет только анимация, рисунок остаётся', () => {
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  const offered = [...boot.match(/const FXS = \{([\s\S]*?)\};/)[1].matchAll(/([a-z-]+): \[/g)]
    .map((m) => m[1]).filter((id) => id !== 'theme' && id !== 'off').sort();
  assert.deepStrictEqual(offered, ['dawn', 'drift', 'grid', 'moon', 'pattern', 'rain', 'snow', 'stars', 'waves'], 'в «Виде» ровно девять эффектов');

  const start = css.indexOf('/* ── Эффекты фона');
  const end = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(start > 0 && end > start, 'раздел эффектов и правило reduce на месте');
  const section = css.slice(start, end).replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const rules = [...section.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2] }))
    .filter((rule) => rule.selector && !rule.selector.startsWith('@'));

  // Движение живёт только на псевдоэлементах слоя: их и гасит правило reduce.
  const animated = rules.filter((rule) => /(?:^|;)\s*animation\s*:/.test(rule.body));
  const animatedIds = new Set();
  for (const rule of animated) {
    assert.match(rule.selector, /\.theme-fx::(?:before|after)$/, `анимация вне слоя эффекта: ${rule.selector}`);
    for (const [, id] of rule.selector.matchAll(/data-fx="([a-z-]+)"/g)) animatedIds.add(id);
  }
  // «Сетка» неподвижна по замыслу; остальные восемь двигаются.
  assert.deepStrictEqual([...animatedIds].sort(), offered.filter((id) => id !== 'grid'), 'движутся все эффекты, кроме «Сетки»');

  // Даже без анимации каждый эффект рисует статичную картинку.
  for (const id of offered) {
    const paint = rules.filter((rule) => rule.selector.includes(`data-fx="${id}"`) && /(?:^|;)\s*(?:background|mask|-webkit-mask)/.test(rule.body));
    assert.ok(paint.length > 0, `эффект ${id} рисует статичную картинку`);
  }

  const reduce = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*([^{}]+)\{([^{}]*)\}/);
  assert.ok(reduce, 'блок prefers-reduced-motion');
  const targets = new Set(reduce[1].split(',').map((s) => s.trim()));
  for (const target of ['.theme-fx', '.theme-fx::before', '.theme-fx::after']) {
    assert.ok(targets.has(target), `reduce гасит ${target}`);
  }
  assert.match(reduce[2], /animation:\s*none\s*!important/, '!important сильнее анимаций эффектов');
  assert.doesNotMatch(reduce[2], /display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])|background(?:-image)?:\s*none|mask(?:-image)?:\s*none/, 'рисунок эффекта не скрывается');
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
  const light = [...boot.match(/LIGHT_THEMES = \[([^\]]+)\]/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const scheme = Object.fromEntries([...css.matchAll(/\[data-theme="([a-z-]+)"\] \{\s*color-scheme: (dark|light)/g)].map((m) => [m[1], m[2]]));
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

test('все разделы Nox берут палитру и гарнитуры у активной темы', () => {
  for (const file of ['nox-screen.css', 'nox-settings.css', 'nox-commands.css', 'nox-connections.css', 'nox-shell.css']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(source, /--nox-bg:\s*var\(--bg\)/, file);
    assert.match(source, /--nox-surface-2:\s*var\(--surface\)/, file);
    assert.match(source, /--nox-text-1:\s*var\(--text\)/, file);
    assert.match(source, /--nox-accent:\s*var\(--accent\)/, file);
    assert.doesNotMatch(source, /--nox-(?:bg|surface-[1-4]|border(?:-strong)?|text-(?:1|2|3|ghost)|accent(?:-hover|-active|-ink)?|ok|warn|err):\s*#[0-9a-f]/i, file);
    assert.doesNotMatch(source, /--font:\s*['"]/, file);
  }
});

test('у каждой темы свои гарнитуры, а списки выбора окрашены токенами', () => {
  for (const id of Object.keys(themes)) {
    const block = css.match(new RegExp(`\\[data-theme="${id}"\\] \\{([^}]*)\\}`))[1];
    assert.match(block, /--theme-font:/, id);
    assert.match(block, /--theme-font-head:/, id);
  }
  assert.match(css, /select\.input option\s*\{[^}]*background:\s*var\(--surface\)/);
  assert.match(css, /select\.input option\s*\{[^}]*color:\s*var\(--text\)/);
});

test('звёзды и лунный свет берут цвет из темы и адаптируются для светлых тем', () => {
  const starsBlock = css.match(/html\[data-fx="stars"\] \.theme-fx::before \{[\s\S]*?@keyframes fxTwinkle \{[^\n]*\}/);
  const moonBlock = css.match(/html\[data-fx="moon"\] \.theme-fx::before \{[\s\S]*?@keyframes fxBreathe \{[^\n]*\}/);
  assert.ok(starsBlock, 'блок эффекта stars');
  assert.ok(moonBlock, 'блок эффекта moon');
  assert.doesNotMatch(starsBlock[0], /#[0-9a-f]{3,8}/i, 'stars без жёстких цветов');
  assert.doesNotMatch(moonBlock[0], /#[0-9a-f]{3,8}/i, 'moon без жёстких цветов');
  assert.match(starsBlock[0], /var\(--fx-star-1\)/);
  assert.match(starsBlock[0], /var\(--fx-twinkle-from\)/);
  assert.match(starsBlock[0], /var\(--fx-twinkle-to\)/);
  assert.match(moonBlock[0], /var\(--fx-moon-core\)/);
  assert.match(moonBlock[0], /var\(--fx-moon-halo\)/);
  assert.match(moonBlock[0], /var\(--fx-moon-beam\)/);

  const darkFx = css.match(/\[data-theme\] \{([^}]*--fx-star-1:[^}]*)\}/);
  const lightFx = css.match(/:is\(([^)]+)\) \{([^}]*--fx-star-1:[^}]*)\}/);
  assert.ok(darkFx, 'токены stars/moon для тёмных тем');
  assert.ok(lightFx, 'токены stars/moon для светлых тем');
  for (const block of [darkFx[1], lightFx[2]]) {
    assert.doesNotMatch(block, /#[0-9a-f]{3,8}/i, 'токены эффектов без жёстких цветов');
    assert.match(block, /var\(--text\)/);
    assert.match(block, /var\(--hue\)/);
    assert.match(block, /var\(--warn\)/);
  }

  const lightThemes = [...css.matchAll(/\[data-theme="([a-z-]+)"\] \{\s*color-scheme: light/g)].map((m) => m[1]).sort();
  const coveredLight = [...lightFx[1].matchAll(/data-theme="([a-z-]+)"/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(coveredLight, lightThemes, 'все светлые темы охвачены правилом эффектов');

  const num = (block, name) => Number(block.match(new RegExp(name + ':\\s*(\\.\\d+|\\d+(?:\\.\\d+)?)'))[1]);
  assert.ok(num(lightFx[2], '--fx-star-base') > num(darkFx[1], '--fx-star-base'));
  assert.ok(num(lightFx[2], '--fx-twinkle-to') > num(darkFx[1], '--fx-twinkle-to'));
  const pct = (block, name) => Number(block.match(new RegExp(name + ':[^;]*?(\\d+)%'))[1]);
  assert.ok(pct(lightFx[2], '--fx-moon-beam') > pct(darkFx[1], '--fx-moon-beam'));
});

test('звёзды и лунный свет на светлых темах различимы, уникальны и не портят читаемость текста', () => {
  const mix = (a, b, w) => a.map((v, i) => Math.round(v * w + b[i] * (1 - w)));
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const lightIds = [...css.matchAll(/\[data-theme="([a-z-]+)"\] \{\s*color-scheme: light/g)].map((m) => m[1]);
  const lightFx = css.match(/:is\([^)]+\) \{([^}]*--fx-star-1:[^}]*)\}/)[1];
  const coreAlpha = Number(lightFx.match(/--fx-moon-core:[^;]*?(\d+)%/)[1]) / 100;
  const beamAlpha = Number(lightFx.match(/--fx-moon-beam:[^;]*?(\d+)%/)[1]) / 100;

  const moonTints = new Set();
  const starAccents = new Set();
  for (const id of lightIds) {
    const t = themes[id];
    const textRgb = rgb(t.text);
    const hueRgb = rgb(t.hue);
    const warnRgb = rgb(t.warn);
    const starWarm = mix(warnRgb, textRgb, 0.65);
    const starHue = mix(hueRgb, textRgb, 0.75);
    const moonTint = mix(hueRgb, textRgb, 0.72);
    moonTints.add(hex(moonTint));
    starAccents.add(hex(starHue));

    for (const fg of [textRgb, starWarm, starHue, moonTint]) {
      assert.ok(ratio(hex(fg), t.bg) >= 4.5, `${id}: цвет эффекта различим на bg`);
      assert.ok(ratio(hex(fg), t.surface) >= 4.5, `${id}: цвет эффекта различим на surface`);
    }
    for (const bgKey of ['bg', 'g1', 'g2', 'g3'].filter((k) => t[k])) {
      const underCore = hex(mix(moonTint, rgb(t[bgKey]), coreAlpha));
      const underBeam = hex(mix(moonTint, rgb(t[bgKey]), beamAlpha));
      assert.ok(ratio(t.text, underCore) >= 4.5, `${id}: text под лунным пятном на ${bgKey}`);
      assert.ok(ratio(t['text-2'], underCore) >= 4.5, `${id}: text-2 под лунным пятном на ${bgKey}`);
      assert.ok(ratio(t['text-2'], underBeam) >= 4.5, `${id}: text-2 под лунным лучом на ${bgKey}`);
    }
  }
  assert.ok(moonTints.size >= 5, 'лунное свечение адаптируется к палитре каждой темы');
  assert.ok(starAccents.size >= 5, 'цвет звёзд адаптируется к палитре каждой темы');
});

test('уменьшение движения (Л5): гаснет движение всех девяти эффектов, рисунок остаётся', () => {
  // Два правила: системное «Уменьшение движения» и выключатель «Анимации» в Настройках
  // (html[data-animations] ставит renderer/app.js, когда подмена окна не дошла до страницы).
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  const offered = [...boot.match(/const FXS = \{([\s\S]*?)\};/)[1].matchAll(/([a-z-]+): \[/g)].map((m) => m[1]).filter((id) => id !== 'theme' && id !== 'off');
  assert.equal(offered.length, 9, 'девять эффектов в «Виде»');

  const gates = [
    { name: 'prefers-reduced-motion: reduce', rule: /@media \(prefers-reduced-motion: reduce\) \{\s*([^{}]+)\{([^{}]*)\}/ },
    { name: 'html[data-animations="off"]', rule: /(html\[data-animations="off"\][^{]*)\{([^{}]*)\}/ },
  ];
  for (const gate of gates) {
    const m = css.match(gate.rule);
    assert.ok(m, 'правило ' + gate.name);
    const targets = m[1].split(',').map((x) => x.trim());
    for (const t of ['.theme-fx', '.theme-fx::before', '.theme-fx::after']) {
      assert.ok(targets.some((x) => x.endsWith(t)), gate.name + ': гасит ' + t);
    }
    assert.match(m[2], /animation:\s*none\s*!important/, gate.name + ': гасит анимацию');
    assert.doesNotMatch(m[2], /display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])|background(?:-image)?:\s*none|mask(?:-image)?:\s*none/, gate.name + ': рисунок не прячется');
  }
  // Движение каждого эффекта объявлено на псевдоэлементах слоя — их и гасят оба правила.
  for (const id of offered) assert.ok(css.includes('html[data-fx="' + id + '"] .theme-fx::before {'), 'рисунок ' + id);
});
