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

test('есть все темы из theme-boot.js: старые и восемь новых', () => {
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  const ids = [...boot.match(/IDS = \[([^\]]+)\]/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).filter((i) => i !== 'system');
  const aether = [...boot.match(/AETHER_IDS = \[([^\]]+)\]/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(Object.keys(themes).sort(), [...ids, ...aether].sort());
  assert.ok(ids.length >= 8);
  assert.equal(aether.length, 8, 'восемь новых тем Nox');
  assert.equal(new Set([...ids, ...aether]).size, ids.length + aether.length, 'id не повторяются');
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

test('у каждой темы есть выбор, а светлые темы совпадают с color-scheme', () => {
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, 'aether', 'components', 'settings-view.js'), 'utf8');
  const aether = [...boot.match(/AETHER_IDS = \[([^\]]+)\]/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const light = [...boot.match(/LIGHT_THEMES = \[([^\]]+)\]/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const scheme = Object.fromEntries([...css.matchAll(/\[data-theme="([a-z-]+)"\] \{\s*color-scheme: (dark|light)/g)].map((m) => [m[1], m[2]]));
  for (const id of Object.keys(themes)) {
    // Старые темы выбираются кнопкой в классическом окне; новые — превью-карточкой в Aether.
    const inAether = aether.includes(id) && new RegExp(`['"]?${id}['"]?: '`).test(settings) && settings.includes('T.ALL_IDS');
    assert.ok(inAether || html.includes(`data-theme-opt="${id}"`), `выбор темы ${id}`);
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


// ── Восемь новых тем: русские названия, полный набор токенов, контраст ────
const settingsSource = fs.readFileSync(path.join(__dirname, 'aether', 'components', 'settings-view.js'), 'utf8');
const aetherCss = fs.readFileSync(path.join(__dirname, 'aether', 'aether.css'), 'utf8');
const bootSource = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
const NEW_THEMES = {
  ocean: 'Океан',
  terracotta: 'Терракота',
  'paper-white': 'Бумага',
  emerald: 'Изумруд',
  'neon-noir': 'Неон-нуар',
  lavender: 'Лаванда',
  coffee: 'Кофе',
  snow: 'Снег',
};
const themeLabels = (() => {
  const block = settingsSource.match(/const THEME_LABELS = \{([\s\S]*?)\n  \};/);
  assert.ok(block, 'THEME_LABELS в Настройках');
  return Object.fromEntries([...block[1].matchAll(/(?:'([a-z-]+)'|([a-z]+)): '([^']+)'/g)].map((m) => [m[1] || m[2], m[3]]));
})();

test('новые темы: восемь русских названий в Настройках без повторов', () => {
  const labels = Object.values(themeLabels);
  assert.equal(new Set(labels).size, labels.length, labels.join(', '));
  for (const [id, name] of Object.entries(NEW_THEMES)) {
    assert.equal(themeLabels[id], name, `подпись ${id}`);
    assert.ok(themes[id], `тема ${id} в themes.css`);
  }
  assert.equal(Object.keys(NEW_THEMES).length, 8);
});

test('новая тема — полный набор токенов: панели, три ступени текста, разделы, состояния и тени', () => {
  const required = ['bg', 'g1', 'g2', 'g3', 'surface', 'surface-2', 'surface-3', 'border',
    'text', 'text-2', 'text-3', 'hue', 'accent-ink', 'hue-deals', 'hue-journal', 'hue-commands', 'hue-settings',
    'contour', 'contour-index', 'ok', 'warn', 'err', 'on-stop'];
  for (const id of Object.keys(NEW_THEMES)) {
    const block = css.match(new RegExp(`\\[data-theme="${id}"\\] \\{([^}]*)\\}`))[1];
    for (const token of required) assert.ok(themes[id][token], `${id}: --${token}`);
    assert.match(block, /--bg-image: none/, `${id}: ровный фон без пятен`);
    assert.match(block, /--theme-font:/, `${id}: гарнитура интерфейса`);
    assert.match(block, /--theme-font-head:/, `${id}: гарнитура заголовков`);
    assert.match(block, /--panel-pct: \d+%; --glass-blur: \d+px;/, `${id}: плотность и размытие панелей`);
    assert.match(block, /--scrim: #[0-9A-Fa-f]{8}/, `${id}: затемнение диалогов`);
    assert.match(block, /color-scheme: (dark|light)/, `${id}: схема окна`);
  }
  // Тёмные темы должны быть тёмными, светлые — светлыми: иначе текст и подложка спорят.
  for (const id of Object.keys(NEW_THEMES)) {
    const light = /color-scheme: light/.test(css.match(new RegExp(`\\[data-theme="${id}"\\] \\{([^}]*)\\}`))[1]);
    assert.equal(lum(themes[id].bg) > 0.5, light, `${id}: фон соответствует схеме`);
  }
});

test('свой акцент читается и на новых темах, включая «Бумагу» и «Неон-нуар»', () => {
  const hexOf = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const read = (hex, backs) => {
    const rgb0 = rgb(hex);
    const ok = (c) => backs.every((b) => ratio(hexOf(c), b) >= 4.5);
    if (ok(rgb0)) return hex;
    const backsRgb = backs.map(rgb);
    const dark = backsRgb.reduce((sum, b) => sum + lum(hexOf(b)), 0) / backsRgb.length < 0.4;
    const target = dark ? [255, 255, 255] : [0, 0, 0];
    for (let i = 1; i <= 20; i++) {
      const c = rgb0.map((v, j) => Math.round(v + (target[j] - v) * (i / 20)));
      if (ok(c)) return hexOf(c);
    }
    return hexOf(target);
  };
  const inkOn = (hex) => (ratio(hex, '#FFFFFF') >= ratio(hex, '#0B1018') ? '#FFFFFF' : '#0B1018');
  const boot = fs.readFileSync(path.join(__dirname, 'theme-boot.js'), 'utf8');
  const accents = [...boot.match(/ACCENTS = \[([\s\S]*?)\n  \];/)[1].matchAll(/\{ id: '([a-z]+)', name: '[^']+', dark: '(#[0-9A-F]{6})', light: '(#[0-9A-F]{6})' \}/g)]
    .map((m) => ({ id: m[1], dark: m[2], light: m[3] }));
  assert.ok(accents.length >= 6);
  const hard = ['#111111', '#FAFAFA', '#FFFF00', '#777777', '#000080', '#3A7BD5'];
  for (const id of Object.keys(NEW_THEMES)) {
    const t = themes[id];
    const backs = ['bg', 'surface', 'surface-2', 'surface-3'].map((k) => t[k]);
    const light = /color-scheme: light/.test(css.match(new RegExp(`\\[data-theme="${id}"\\] \\{([^}]*)\\}`))[1]);
    for (const want of [...accents.map((a) => (light ? a.light : a.dark)), ...hard]) {
      const hue = read(want, backs);
      for (const back of backs) assert.ok(ratio(hue, back) >= 4.5, `${id}: акцент ${hue} на ${back}`);
      assert.ok(ratio(hue, inkOn(hue)) >= 4.5, `${id}: подпись на плашке ${hue}`);
    }
  }
});

// ── Вложенные шрифты: подключены файлами, доступны в Настройках, откат на системный ──
test('четыре новых шрифта подключены из fonts/ и предлагаются в Настройках', () => {
  const fonts = [
    ['Manrope', 'Manrope-Variable.ttf', '200 800'],
    ['Unbounded', 'Unbounded-Variable.ttf', '200 900'],
    ['Source Serif 4', 'SourceSerif4-Variable.ttf', '200 900'],
    ['JetBrains Mono', 'JetBrainsMono-Variable.ttf', '100 800'],
  ];
  for (const [family, file, weight] of fonts) {
    assert.match(css, new RegExp(`@font-face \\{ font-family: "${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"; src: url\\("fonts/${file}"\\).*?font-weight: ${weight};`), `@font-face ${family}`);
    const full = path.join(__dirname, 'fonts', file);
    assert.ok(fs.existsSync(full), `файл ${file}`);
    assert.ok(fs.statSync(full).size > 50000, `размер ${file}`);
  }
  // FONTS: интерфейс — Manrope, заголовки — Source Serif 4 и Unbounded, код — JetBrains Mono.
  assert.match(bootSource, /manrope: \['Manrope'/);
  assert.match(bootSource, /source: \['Source Serif 4'/);
  assert.match(bootSource, /unbounded: \['Unbounded'/);
  assert.match(bootSource, /mono: \{[\s\S]*?jetbrains: \['JetBrains Mono'/);
  assert.match(bootSource, /mono: 'theme'/);
  // У каждого списка есть системный откат, а не только вложенная гарнитура.
  assert.match(bootSource, /system: \['Системный Windows'/);
  assert.match(bootSource, /system: \['Системный \(Georgia\)'/);
  // Настройки: ручка «Код и формулы», образец и полный сброс.
  assert.match(settingsSource, /\['mono', 'Код и формулы', T\.FONTS\.mono\]/);
  assert.match(settingsSource, /ae-type-mono/);
  assert.match(settingsSource, /Сбросить оформление/);
  assert.match(settingsSource, /T\.resetAppearance\(\)/);
  assert.match(aetherCss, /\.ae-type-mono \{[^}]*font-family: var\(--mono\)/);
  assert.match(aetherCss, /\.ae-theme-card[\s\S]*?\.ae-theme-sample \{[^}]*background: var\(--bg-image, none\), var\(--bg\)/, 'превью темы берёт фон темы');
  assert.match(aetherCss, /\.ae-tm-rail \{[^}]*background: color-mix\(in srgb, var\(--surface\)/, 'превью показывает панель темы');
  assert.match(aetherCss, /\.ae-tm-dot \{[^}]*background: var\(--hue\)/, 'превью показывает акцент темы');
  // Выбор интерфейсной гарнитуры доходит до оболочки Aether (иначе nox-luxify держит свою).
  assert.match(aetherCss, /--lx-font: var\(--font,/, 'оболочка берёт выбранный шрифт интерфейса');
  assert.match(aetherCss, /html\[data-aether\]\[data-ui-font\]/, 'свой шрифт включает шрифт темы и у «Тёмной»');
  assert.match(bootSource, /dataset\.uiFont = 'custom'/, 'theme-boot ставит флаг своего шрифта');
  // Панели Настроек на новых и светлых темах — из токенов темы, а не тёмно-синие.
  assert.match(aetherCss, /\.ae-settings-page \.ae-settings-group \{\s*background: var\(--surface\);\s*border: 1px solid var\(--border\);/, 'панели настроек в цвет темы');
  // Тема хранится так же, как её читает theme-boot.js (JSON-строка), и список читает её обратно.
  assert.match(settingsSource, /JSON\.stringify\(themeSelect\.value\)/, 'тема сохраняется JSON-строкой');
  assert.match(settingsSource, /JSON\.parse\(localStorage\.getItem\('jarvis\.theme'\)\)/, 'сохранённая тема читается через JSON.parse');
});

test('тема, шрифты и сброс оформления работают без перезагрузки (theme-boot в песочнице)', () => {
  const vm = require('node:vm');
  const store = new Map();
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
    window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
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
  vm.runInNewContext(bootSource, sandbox);
  const T = sandbox.window.JarvisTheme;
  // Восемь новых тем — в общем списке и открываются без перезагрузки.
  for (const id of Object.keys(NEW_THEMES)) assert.ok(T.ALL_IDS.includes(id), id);
  T.apply('paper-white');
  assert.equal(root.dataset.theme, 'paper-white');
  T.apply('neon-noir');
  assert.equal(root.dataset.theme, 'neon-noir');
  // Выбор всех четырёх вложенных гарнитур: интерфейс, заголовки, ответы и код.
  T.setLook({ ui: 'manrope', head: 'source', reply: 'head', mono: 'jetbrains', size: 'm' });
  assert.match(props['--font'], /Manrope/);
  assert.match(props['--font-head'], /Source Serif 4/);
  assert.match(props['--font-reply'], /Source Serif 4/);
  assert.match(props['--mono'], /JetBrains Mono/);
  // «Сбросить оформление» возвращает «Ночь», шрифты и акцент темы.
  T.resetAppearance();
  assert.equal(root.dataset.theme, 'signal');
  assert.equal(props['--font'], undefined);
  assert.equal(props['--font-head'], undefined);
  assert.equal(props['--font-reply'], undefined);
  assert.equal(props['--mono'], undefined);
  assert.equal(JSON.parse(store.get('jarvis.theme')), 'signal');
  assert.equal(JSON.parse(store.get('jarvis.accent')), 'theme');
  // Битое значение моноширинного шрифта не ломает окно.
  assert.equal(T.sanitizeLook({ mono: 'нет-такого' }).mono, 'theme');
  assert.equal(T.sanitizeLook({ ui: 'manrope', head: 'unbounded', mono: 'jetbrains' }).mono, 'jetbrains');
});


// ── Светлый хром: шапка, рейка, история и служебные страницы ────────────────
const luxify = fs.readFileSync(path.join(__dirname, 'aether', 'nox-luxify.css'), 'utf8');
const railV2 = fs.readFileSync(path.join(__dirname, 'aether', 'rail-v2.css'), 'utf8');
const lightIds = [...css.matchAll(/\[data-theme="([a-z-]+)"\] \{\s*color-scheme: light/g)].map((m) => m[1]).sort();
const mixHex = (a, b, w) => {
  const A = rgb(a), B = rgb(b);
  return '#' + A.map((v, i) => Math.max(0, Math.min(255, Math.round(v * w + B[i] * (1 - w)))).toString(16).padStart(2, '0')).join('');
};

test('светлый хром покрывает все светлые темы и только их', () => {
  const block = luxify.match(/\/\* ── Светлый хром[\s\S]*?\n(html\[data-aether\]:is\(([^)]*)\) \{([\s\S]*?)\n\})/);
  assert.ok(block, 'блок «Светлый хром» в nox-luxify.css');
  const covered = [...block[2].matchAll(/data-theme="([a-z-]+)"/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(covered, lightIds, 'светлых тем ровно столько же, сколько в themes.css');
  assert.ok(covered.length >= 13, 'все светлые палитры, включая новые');
  for (const id of covered) {
    assert.ok(themes[id], 'тема ' + id + ' есть в themes.css');
    assert.ok(lum(themes[id].bg) > 0.5, id + ': фон светлый');
    assert.ok(lum(themes[id].surface) > 0.5, id + ': поверхность светлая');
  }
  const map = block[3];
  assert.match(map, /--lx-bg: var\(--surface\)/, 'шапка/панели берут поверхность темы');
  assert.match(map, /--lx-bg-deep: var\(--bg\)/, 'глубокий фон — фон темы');
  assert.match(map, /--lx-panel: var\(--surface-2\)/, 'панели — вторая поверхность темы');
  assert.match(map, /--lx-panel-2: var\(--surface-3\)/, 'вложенные панели — третья поверхность темы');
  assert.match(map, /--lx-card: var\(--surface\)/, 'карточки — поверхность темы');
  assert.match(map, /--lx-text: var\(--text\)/, 'текст хрома — текст темы');
  assert.match(map, /--lx-text-2: var\(--text-2\)/, 'второй текст хрома — второй текст темы');
  assert.match(map, /--lx-accent: var\(--hue\)/, 'акцент хрома — акцент темы');
});

test('шапка и рейка на светлых темах не тёмные, контраст текста от 4,5:1', () => {
  for (const id of lightIds) {
    const t = themes[id];
    const topbar = mixHex(t.surface, t.bg, 0.93);
    const accentBg = mixHex(t.hue, t.surface, 0.18);
    const railBg = mixHex(t.surface, t.bg, 0.64);
    const railActive = mixHex(t.hue, t.surface, 0.26);
    assert.ok(lum(topbar) > 0.5, id + ': шапка светлая');
    assert.ok(lum(railBg) > 0.5, id + ': рейка светлая');
    const cases = [
      ['текст бренда', t.text, topbar],
      ['вкладки', t['text-2'], topbar],
      ['иконки вкладок', t['text-3'], topbar],
      ['выбранная вкладка', t.text, accentBg],
      ['переключатель режима', t['text-2'], t.surface],
      ['кнопки окна', t['text-2'], topbar],
      ['поле поиска', t.text, t.surface],
      ['подсказка поиска', t['text-3'], t.surface],
      ['рейка', t.text, railBg],
      ['рейка, второй текст', t['text-2'], railBg],
      ['активная кнопка рейки', t.text, railActive],
    ];
    for (const [name, fg, bg] of cases) {
      const r = ratio(fg, bg);
      assert.ok(r >= 4.5, id + ': ' + name + ' ' + fg + ' на ' + bg + ' = ' + r.toFixed(2));
    }
  }
});

test('правила светлого хрома: шапка, вкладки, режим, окно, поиск и рейка', () => {
  // Фрагменты наших правил из блока «Светлый хром» (повторяющийся длинный селектор опускаем).
  for (const [label, re] of [
    ['фон шапки', /\.ae-topbar \{\s*background: color-mix\(in srgb, var\(--surface\) 93%, var\(--bg\)\);/],
    ['бренд', /\.lx-topbar-brand \{ color: var\(--text\); \}/],
    ['вкладки', /\.ae-topbar \.ae-nav-btn \{ color: var\(--text-2\); \}/],
    ['выбранная вкладка', /\.ae-topbar \.ae-nav-btn\.is-active,[\s\S]*?background: var\(--accent-bg/],
    ['переключатель режима', /\.ae-mode-pill \{ background: var\(--surface\); border-color: var\(--border\); color: var\(--text-2\); \}/],
    ['кнопки окна', /\.ae-win-btn \{ color: var\(--text-2\); \}/],
    ['поиск MCP', /\.lx-search-input \{ background: var\(--surface-2\); color: var\(--text\); \}/],
    ['поиск команд', /\.lx-cmd-search-input \{ background: var\(--surface-2\); border-color: var\(--border\); color: var\(--text\); \}/],
    ['поповер модалки', /\.lx-modal \{ background: var\(--surface\); color: var\(--text\);/],
    ['страница команд', /\.lx-tree-row \{ background: var\(--surface\); border-color: var\(--border\); color: var\(--text-2\); \}/],
    ['страница дополнений', /\.lx-addon-card \{ background: var\(--surface-2\); \}/],
    ['страница «Личное»', /\.lx-extra-stat \{ background: var\(--surface-2\); \}/],
  ]) {
    assert.match(luxify, re, 'правило: ' + label);
  }
  // Рейку делает отдельный агент (rail-v2.css): проверяем контракт, сам файл не правим.
  // На светлых темах рейка берёт --text/--surface/--bg темы, у «Тёмной» остаётся прежний облик.
  assert.match(railV2, /\.ae-rail-v2 \{[\s\S]*?--rlx-text: var\(--text/, 'рейка берёт текст темы');
  assert.match(railV2, /--rlx-bg: linear-gradient[\s\S]*?var\(--surface[\s\S]*?var\(--bg/, 'рейка берёт фон и поверхность темы');
  assert.match(railV2, /--rlx-accent: var\(--hue/, 'акцент рейки — акцент темы');
  assert.match(railV2, /html\[data-aether\]\[data-theme="dark"\] \.ae-rail-v2/, 'тёмная тема Aether сохраняет прежний облик рейки');
});

test('тёмные темы не попали в светлый хром', () => {
  const darkIds = [...css.matchAll(/\[data-theme="([a-z-]+)"\] \{\s*color-scheme: dark/g)].map((m) => m[1]);
  const block = luxify.match(/\/\* ── Светлый хром[\s\S]*?\n(html\[data-aether\]:is\(([^)]*)\) \{([\s\S]*?)\n\})/)[2];
  assert.ok(darkIds.length >= 15);
  for (const id of darkIds) {
    assert.ok(!block.includes('data-theme="' + id + '"'), 'тёмная тема ' + id + ' осталась как была');
  }
});


// ── Глубокие экраны и единый акцент тёмных тем ─────────────────────────────
const darkThemeIds = [...css.matchAll(/\[data-theme="([a-z-]+)"\] \{\s*color-scheme: dark/g)].map((m) => m[1]);
const darkChromeIds = darkThemeIds.filter((id) => id !== 'dark');
const lightChromeBlock = luxify.match(/\/\* ── Светлый хром[\s\S]*?\n(html\[data-aether\]:is\(([^)]*)\) \{([\s\S]*?)\n\})/);
const darkChromeBlock = luxify.match(/\/\* ── Единый акцент тёмных тем[\s\S]*?\n(html\[data-aether\]:is\(([^)]*)\) \{([\s\S]*?)\n\})/);
const tint = (color, surface, weight) => mixHex(color, surface, weight);
const hex8 = (value) => /^#([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})$/.exec(value || '');

test('глубокие экраны: мастер, журнал, MCP-форма и модалка — поверхности из темы', () => {
  const rules = [
    ['карточка мастера', /html\[data-aether\]:is\([^)]*\) \.lx-ai-card \{[^}]*background: var\(--surface-2\)/],
    ['строка шага мастера', /html\[data-aether\]:is\([^)]*\) \.lx-ai-step-row \{[^}]*background: var\(--surface\)/],
    ['степпер', /html\[data-aether\]:is\([^)]*\) \.lx-stepper-pill \{[^}]*background: var\(--surface-2\)/],
    ['номер шага', /html\[data-aether\]:is\([^)]*\) \.lx-stepper-num \{[^}]*color: var\(--text\)/],
    ['подсказка о нехватке', /html\[data-aether\]:is\([^)]*\) \.lx-missing-box \{[^}]*var\(--warn\)/],
    ['ошибка мастера', /html\[data-aether\]:is\([^)]*\) \.lx-error-box \{[^}]*var\(--err\)/],
    ['строка журнала', /html\[data-aether\]:is\([^)]*\) \.lx-launch-row \{[^}]*background: var\(--surface\)/],
    ['бейдж журнала', /\.lx-launch-badge\.is-ok \{ background: color-mix\(in srgb, var\(--ok\) 10%/],
    ['форма MCP', /html\[data-aether\]:is\([^)]*\) \.lx-input[^{]*\{[^}]*background: var\(--surface-2\)/],
    ['поиск MCP', /html\[data-aether\]:is\([^)]*\) \.lx-search-input \{ background: var\(--surface-2\)/],
    ['модалка Nox AI', /html\[data-aether\]:is\([^)]*\) \.lx-modal \{ background: var\(--surface\); color: var\(--text\);/],
    ['скрим модалки', /html\[data-aether\]:is\([^)]*\) \.lx-modal-backdrop \{ background: var\(--scrim/],
  ];
  for (const [label, re] of rules) assert.match(luxify, re, 'правило: ' + label);
  assert.ok(lightChromeBlock, 'светлый блок хрома');
});

test('глубокие экраны: контраст 4,5:1 на светлых темах, скрим затемняет', () => {
  for (const id of lightIds) {
    const t = themes[id];
    const pairs = [
      ['текст на surface-3', t.text, t['surface-3']],
      ['второй текст на surface-3', t['text-2'], t['surface-3']],
      ['третий текст на surface-3', t['text-3'], t['surface-3']],
      ['текст в плашке «не хватает»', t.text, tint(t.warn, t.surface, 0.12)],
      ['ошибка в плашке', t.err, tint(t.err, t.surface, 0.12)],
      ['успех в бейдже', t.ok, tint(t.ok, t.surface, 0.10)],
      ['предупреждение в бейдже', t.warn, tint(t.warn, t.surface, 0.10)],
      ['ошибка в бейдже', t.err, tint(t.err, t.surface, 0.10)],
    ];
    for (const [name, fg, bg] of pairs) {
      const r = ratio(fg, bg);
      assert.ok(r >= 4.5, id + ': ' + name + ' = ' + r.toFixed(2));
    }
    // Скрим: затемняет фон и отделяет поверхность модалки; альфа не меньше 20%.
    // Старые темы берут общий скрим из блока [data-theme], новые задают свой.
    const block = css.match(new RegExp('\\[data-theme="' + id + '"\\] \\{([^}]*)\\}'))[1];
    const defaultScrim = /\[data-theme\] \{[^}]*--scrim: (#[0-9A-Fa-f]{8})/.exec(css);
    const scrim = /--scrim: (#[0-9A-Fa-f]{8})/.exec(block) || defaultScrim;
    assert.ok(scrim, id + ': --scrim в теме или общий');
    const parts = hex8(scrim[1]);
    assert.ok(parts, id + ': --scrim восьмизначный');
    const alpha = parseInt(parts[2], 16) / 255;
    assert.ok(alpha >= 0.2, id + ': скрим заметно затемняет');
    const scrimRgb = rgb('#' + parts[1]);
    const bgRgb = rgb(t.bg);
    const under = '#' + scrimRgb.map((v, i) => Math.round(v * alpha + bgRgb[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
    assert.ok(lum(under) < lum(t.bg), id + ': скрим делает фон темнее');
    assert.ok(ratio(t.surface, under) >= 1.5, id + ': поверхность модалки отделяется от скрима');
  }
});

test('единый акцент тёмных тем: все тёмные, кроме «Тёмной», берут --hue', () => {
  assert.ok(darkChromeBlock, 'блок «Единый акцент тёмных тем»');
  const covered = [...darkChromeBlock[2].matchAll(/data-theme="([a-z-]+)"/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(covered, darkChromeIds.slice().sort(), 'все тёмные темы, кроме dark');
  assert.ok(!covered.includes('dark'), '«Тёмная» не входит в блок');
  const map = darkChromeBlock[3];
  const darkSection = luxify.slice(luxify.indexOf('/* ── Единый акцент тёмных тем'));
  assert.match(map, /--lx-accent: var\(--hue\)/, 'акцент облика — --hue темы');
  assert.match(map, /--lx-accent-glow: var\(--hue\)/, 'свечение/фокус — --hue');
  assert.match(map, /--lx-bg: var\(--surface\)/, 'поверхности хрома — поверхности темы');
  const rules = [
    ['выбранная вкладка шапки', /\.ae-topbar \.ae-nav-btn\.is-active,[\s\S]*?background: var\(--accent-bg/],
    ['тумблер', /\.lx-toggle-input:checked \+ \.lx-toggle-track \{ background: var\(--hue\)/],
    ['ползунок', /\.lx-slider \{ background: linear-gradient\(90deg, var\(--hue\)/],
    ['вкладка раздела', /\.lx-pill-tab\.is-active \{ background: var\(--hue\); color: var\(--accent-ink\)/],
    ['кнопка с акцентом', /\.lx-pill-primary \{ background: var\(--hue\); color: var\(--accent-ink\)/],
    ['выбранная строка команд', /\.lx-tree-row\.is-selected \{[\s\S]*?var\(--hue\)[\s\S]*?color: var\(--accent-ink\)/],
    ['активная вкладка команд', /\.lx-cmd-seg-btn\.is-active \{[\s\S]*?var\(--hue\)[\s\S]*?color: var\(--accent-ink\)/],
  ];
  for (const [label, re] of rules) assert.match(darkSection, re, 'акцент тёмных: ' + label);
  // «Тёмная» осталась прежней: старый блок облика на месте.
  assert.match(luxify, /html\[data-aether\]\[data-theme="dark"\],\s*\n\.ae-theme-sample\[data-theme="dark"\]/);
  const darkRules = darkSection.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!darkRules.includes('#2559E8'), 'в правилах тёмных нет старого синего');
});

test('единый акцент тёмных тем: контраст текста и плашек от 4,5:1', () => {
  for (const id of darkChromeIds) {
    const t = themes[id];
    const pairs = [
      ['текст на выбранной вкладке', t.text, tint(t.hue, t.surface, 0.18)],
      ['текст на активной кнопке рейки', t.text, tint(t.hue, t.surface, 0.26)],
      ['подпись на акцентной кнопке', t['accent-ink'], t.hue],
      ['успех в бейдже', t.ok, tint(t.ok, t.surface, 0.10)],
      ['предупреждение в бейдже', t.warn, tint(t.warn, t.surface, 0.10)],
      ['ошибка в бейдже', t.err, tint(t.err, t.surface, 0.10)],
    ];
    for (const [name, fg, bg] of pairs) {
      const r = ratio(fg, bg);
      assert.ok(r >= 4.5, id + ': ' + name + ' = ' + r.toFixed(2));
    }
  }
});

test('кольца фокуса: кнопки композера и карточки каталога — без полупрозрачности, от 3:1', () => {
  const aether = fs.readFileSync(path.join(__dirname, 'aether', 'aether.css'), 'utf8');
  const composer = aether.match(/\.ae-composer-footer button:focus-visible \{([^}]*)\}/);
  assert.ok(composer, 'правило фокуса кнопок композера');
  assert.match(composer[1], /outline: 2px solid var\(--accent\);/, 'кольцо сплошным акцентом');
  assert.doesNotMatch(composer[1], /70%, transparent/, 'без полупрозрачного кольца');
  const card = aether.match(/\.ae-grid-card:focus-visible \{([^}]*)\}/);
  assert.ok(card, 'правило фокуса карточки каталога');
  assert.match(card[1], /outline: 2px solid var\(--focus, var\(--accent\)\);/, 'контур из токена фокуса');
  assert.match(card[1], /outline-offset: 2px;/, 'отступ контура');
  for (const id of Object.keys(themes)) {
    const r = ratio(themes[id].hue, themes[id].surface);
    assert.ok(r >= 3, id + ': кольцо фокуса на поверхности = ' + r.toFixed(2));
  }
});
