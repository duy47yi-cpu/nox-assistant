'use strict';

// Рейка Aether v2: вставная панель, смысловые группы, подписи и доступность.
// Проверки статические: читают исходники окна, потому что node --test идёт без браузера.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AETHER = path.join(__dirname, '..', 'renderer', 'aether');
const read = (name) => fs.readFileSync(path.join(AETHER, name), 'utf8');

test('index.html подключает rail-v2.css последним — новой рейке ничто не мешает', () => {
  const html = read('index.html');
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.includes('rail-v2.css'), 'rail-v2.css должен быть подключён');
  const order = links.filter((href) => ['aether.css', 'nox-luxify.css', 'nox-commands-aether.css', 'rail-v2.css'].includes(href));
  assert.deepEqual(order, ['aether.css', 'nox-luxify.css', 'nox-commands-aether.css', 'rail-v2.css'],
    'rail-v2.css должен идти после остальных стилей Aether');
  assert.ok(html.indexOf('rail-v2.css') < html.indexOf('</head>'), 'ссылка должна быть в <head>');
});

test('рейка — вставная панель с прежними id, группами и разделителями', () => {
  const src = read('aether.js');
  assert.match(src, /rail\.className = 'ae-utility-rail ae-rail-v2'/);
  assert.match(src, /rail\.id = 'aeUtilityRail'/);
  assert.match(src, /rail\.setAttribute\('aria-label', 'Служебная рейка'\)/);

  for (const id of ['lxAiModalBtn', 'lxMuteBtn', 'aeStageToggle']) {
    assert.match(src, new RegExp("railButton\\('" + id + "'"), 'Кнопка рейки ' + id + ' должна остаться');
  }
  assert.match(src, /homeBtn\.id = 'aeRailHomeBtn'/);
  assert.match(src, /railGroup\('Nox AI', aiModalBtn, stageBtn\)/);
  assert.match(src, /railGroup\('История', historyDrawer\.trigger\)/);
  assert.match(src, /railGroup\('Озвучка и аккаунт', muteBtn, accountPanel\.el\)/);
  assert.match(src, /\.className = 'ae-rail-group'/);
  assert.match(src, /\.className = 'ae-rail-sep'/);
  assert.match(src, /rail\.replaceChildren\(/);
  assert.match(src, /rail\.append\(aiModalBtn, muteBtn, historyDrawer\.trigger, stageBtn, accountPanel\.el\)/);
});

test('все обработчики и aria прежних кнопок сохранены', () => {
  const src = read('aether.js');
  assert.match(src, /aiModalBtn\.addEventListener\('click', \(\) => \{\s*aiModal\.open\(\);/);
  assert.match(src, /aiModalBtn\.setAttribute\('aria-haspopup', 'dialog'\)/);
  assert.match(src, /aiModalBtn\.setAttribute\('aria-controls', 'lxAiModal'\)/);
  assert.match(src, /settingsView\.openVoiceSettings\('speech'\)/);
  assert.match(src, /store\.setSetting\('quiet', !store\.state\.settings\.quiet\)/);
  assert.match(src, /stageBtn\.setAttribute\('aria-controls', orbStage\.el\.id\)/);
  assert.match(src, /stageBtn\.setAttribute\('aria-expanded', String\(stageVisible\)\)/);

  const history = read(path.join('components', 'history-drawer.js'));
  assert.match(history, /trigger\.id = 'aeHistoryToggle'/);
  assert.match(history, /trigger\.setAttribute\('aria-expanded'/);
  assert.match(history, /trigger\.setAttribute\('aria-controls', wrap\.id\)/);

  const account = read(path.join('components', 'account-panel.js'));
  assert.match(account, /createPopover\('aeLimits', 'Лимиты'/);
  assert.match(account, /createPopover\('aeAccount', 'Аккаунт'/);
  assert.match(account, /trigger\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(src, /querySelector\('#aeLimitsTrigger'\)/);
  assert.match(src, /querySelector\('#aeAccountTrigger'\)/);
});

test('у каждой кнопки рейки есть title, aria-label и подпись-пилюля', () => {
  const src = read('aether.js');
  assert.match(src, /button\.title = label;/);
  assert.match(src, /button\.setAttribute\('aria-label', label\);/);
  assert.match(src, /button\.dataset\.label = label;/);
  assert.match(src, /homeBtn\.title = 'Главная'/);
  assert.match(src, /homeBtn\.setAttribute\('aria-label', 'Главная'\)/);
  assert.match(src, /homeBtn\.dataset\.label = 'Главная'/);
  assert.match(src, /historyDrawer\.trigger\.dataset\.label = 'История чатов'/);
  assert.match(src, /limitsTrigger\.dataset\.label = 'Лимиты'/);
  assert.match(src, /accountTrigger\.dataset\.label = 'Аккаунт'/);

  // Каждая кнопка, созданная фабрикой, получает подпись из своего же аргумента.
  const labels = [...src.matchAll(/railButton\('([\w]+)', '([^']+)'/g)].map((m) => ({ id: m[1], label: m[2] }));
  assert.deepEqual(labels.map((x) => x.id), ['lxAiModalBtn', 'lxMuteBtn', 'aeStageToggle']);
  assert.ok(labels.every((x) => x.label.trim().length > 2), 'подписи не должны быть пустыми');
  assert.deepEqual(labels.map((x) => x.label), ['Настройки Nox AI', 'Озвучка', 'Панель сферы']);

  // У озвучки подпись обновляется вместе с title (включён / выключен / открыть настройки).
  assert.match(src, /muteBtn\.dataset\.label = muteBtn\.title/);
});

test('бренд сверху: знак Nox на 28 px ведёт на «Главную»', () => {
  const src = read('aether.js');
  assert.match(src, /homeBtn\.append\(logoSphere\('ae-rail-logo'\)\)/);
  assert.match(src, /homeBtn\.addEventListener\('click', \(\) => store\.setRoute\('personal'\)\)/);
  assert.match(src, /const brandActive = st\.route === 'personal'/);
  assert.match(src, /homeBtn\.setAttribute\('aria-current', brandActive \? 'page' : 'false'\)/);

  const css = read('rail-v2.css');
  assert.match(css, /\.ae-rail-brand \.lx-logo-svg \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/);
});

test('непонятный значок истории заменён: циферблат со стрелкой назад и подпись', () => {
  const icons = read('icons.js');
  assert.match(icons, /\/\/ История: циферблат со стрелкой назад/);
  assert.match(icons, /history: \[/);
  assert.match(icons, /M3 12a9 9 0 1 0 9-9/);
  const src = read('aether.js');
  assert.match(src, /historyDrawer\.trigger\.replaceChildren\(icon\('history'\)\)/);
});

test('rail-v2.css: отступ 8, скругление 16, тонкая рамка и тень из токенов', () => {
  const css = read('rail-v2.css');
  assert.match(css, /--rlx-inset:\s*8px/);
  assert.match(css, /--rlx-radius:\s*16px/);
  assert.match(css, /margin:\s*var\(--rlx-inset\)/);
  assert.match(css, /border-radius:\s*var\(--rlx-radius\)/);
  assert.match(css, /border:\s*1px solid var\(--rlx-line\)/);
  assert.match(css, /--rlx-shadow:\s*var\(--shadow-pop/);
  assert.match(css, /box-shadow:\s*var\(--rlx-shadow\)/);
  assert.match(css, /--rlx-line:\s*color-mix\(in srgb, var\(--lx-text/);
});

test('rail-v2.css: подписи-пилюли, активное состояние и focus-visible', () => {
  const css = read('rail-v2.css');
  assert.match(css, /content:\s*attr\(data-label\)/);
  assert.match(css, /opacity:\s*0;/);
  assert.match(css, /:is\(:hover, :focus-visible\)::before/);
  assert.match(css, /\[aria-expanded="true"\], \[aria-current="page"\], \.is-active/);
  assert.match(css, /:focus-visible \{[\s\S]*?outline:\s*2px solid var\(--rlx-focus\)/);
  assert.match(css, /\.ae-rail-sep \{/);
  assert.match(css, /\.ae-rail-spacer \{/);
  // Пилюля — отдельный слой: заметный отступ от рейки, кольцо-подложка и многослойная тень.
  assert.match(css, /left:\s*calc\(100% \+ 18px\)/);
  assert.match(css, /--rlx-pill-shadow:\s*0 0 0 1px color-mix/);
  assert.match(css, /0 12px 30px rgba\(4, 9, 20, 0\.6\)/);
  assert.match(css, /box-shadow:\s*var\(--rlx-pill-shadow\)/);
  assert.match(css, /border-radius:\s*999px/);
});

test('живая QA проверяет новую рейку: бренд, 7 кнопок, панель 56/48 и пилюли', () => {
  const qa = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'aether-qa.js'), 'utf8');
  assert.match(qa, /#aeRailHomeBtn/);
  assert.match(qa, /railWide\.panel\.width === 56/);
  assert.match(qa, /railCompact\.panel\.width === 48/);
  assert.match(qa, /railWide\.brandIcon === 28/);
  assert.match(qa, /railCompact\.brandIcon === 24/);
  assert.match(qa, /hoverPill\('#aeLimitsTrigger'\)/);
  assert.match(qa, /hoverPill\('#aeAccountTrigger'\)/);
  assert.match(qa, /Бренд рейки ведёт на «Главную»/);
});

test('rail-v2.css: цвета из токенов темы; светлые темы светлые, тёмная — прежняя', () => {
  const css = read('rail-v2.css');
  assert.match(css, /--rlx-text:\s*var\(--text/);
  assert.match(css, /--rlx-text-2:\s*var\(--text-2/);
  assert.match(css, /--rlx-accent:\s*var\(--hue/);
  assert.match(css, /--rlx-bg:[\s\S]*?var\(--surface[\s\S]*?var\(--bg/);
  assert.match(css, /--rlx-pill-bg:[\s\S]*?var\(--surface-2/);
  assert.match(css, /--rlx-focus:\s*var\(--hue/);
  assert.match(css, /outline:\s*2px solid var\(--rlx-focus\)/);
  // На светлых палитрах панель и пилюля — из поверхности темы, текст тёмный.
  assert.match(css, /color:\s*var\(--rlx-text\)/);
  assert.match(css, /color:\s*var\(--rlx-text-2\)/);
  // Тёмная тема Aether явно сохраняет прежний тёмно-синий облик.
  assert.match(css, /html\[data-aether\]\[data-theme="dark"\] \.ae-rail-v2 \{/);
  assert.match(css, /--rlx-bg:[\s\S]*?var\(--lx-panel-2/);
});

test('rail-v2.css: компактный режим до 980 px и уважение уменьшения движения', () => {
  const css = read('rail-v2.css');
  assert.match(css, /@media \(max-width: 980px\)/);
  assert.match(css, /grid-template-columns: 64px minmax\(0, 1fr\)/);
  assert.match(css, /--rlx-btn:\s*36px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /html\[data-motion="off"\] \.ae-utility-rail \*/);
  assert.match(css, /html\[data-animations="off"\] \.ae-utility-rail \*/);
});

test('широкий экран: колонка под панель, узкий — компактнее', () => {
  const css = read('rail-v2.css');
  assert.match(css, /grid-template-columns: 72px minmax\(0, 1fr\)/);
  const compact = css.slice(css.indexOf('@media (max-width: 980px)'));
  assert.match(compact, /grid-template-columns: 64px minmax\(0, 1fr\)/);
  assert.match(compact, /--rlx-icon:\s*22px/);
});

test('токены рейки определены для всех 36 тем из IDS', () => {
  const boot = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'theme-boot.js'), 'utf8');
  const readIds = (name) => {
    const block = new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];').exec(boot);
    return block ? [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
  };
  const ids = [...readIds('IDS'), ...readIds('AETHER_IDS')].filter((id) => id !== 'system');
  assert.equal(ids.length, 36, 'в IDS и AETHER_IDS должно быть 36 настоящих тем');
  const themes = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'themes.css'), 'utf8');
  const missing = ids.filter((id) => !themes.includes('[data-theme="' + id + '"]'));
  assert.deepEqual(missing, [], 'у каждой темы должны быть токены в themes.css');
  const css = read('rail-v2.css');
  assert.match(css, /--rlx-text:\s*var\(--text/);
  assert.match(css, /--rlx-text-2:\s*var\(--text-2/);
  assert.match(css, /--rlx-accent:\s*var\(--hue/);
  assert.match(css, /--rlx-bg:[\s\S]*?var\(--surface[\s\S]*?var\(--bg/);
  assert.match(css, /--rlx-focus:\s*var\(--hue/);
  // Тёмная тема: кольцо фокуса светлее акцента, иначе контраст к панели ниже 4,5:1.
  assert.match(css, /html\[data-aether\]\[data-theme="dark"\] \.ae-rail-v2 \{[\s\S]*?--rlx-focus:\s*color-mix\(in srgb, var\(--lx-accent-glow[^;]+55%, #FFFFFF\)/);
});

test('режим --rail-themes проверяет все темы, контраст и поповеры', () => {
  const qa = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'aether-qa.js'), 'utf8');
  assert.match(qa, /has\('rail-themes'\)/);
  assert.match(qa, /async function runRailThemesQa/);
  assert.match(qa, /readIds\('IDS'\)/);
  assert.match(qa, /readIds\('AETHER_IDS'\)/);
  assert.match(qa, /themeIds\.length === 36/);
  assert.match(qa, /item\.min < 4\.5/);
  assert.match(qa, /'rail-theme-' \+ id \+ '-1200x720\.png'/);
  assert.match(qa, /'rail-theme-' \+ id \+ '-864x520\.png'/);
  assert.match(qa, /escClosed/);
  assert.match(qa, /outsideClosed/);
});
