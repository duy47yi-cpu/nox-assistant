'use strict';
// Уменьшение движения (Л5): настройка «Анимации» и настройка Windows «Уменьшение движения».
// Правило: Windows главнее, когда анимации включены; выключенные анимации стоят всегда —
// и эффекты фона при этом остаются нарисованными, гаснет только движение.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const { emulatedReducedMotion, emulatedMotionFeatures, motionAllowed } = require('../src/appearance/motion');
const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
const css = fs.readFileSync(path.join(APP, 'renderer', 'themes.css'), 'utf8');
const app = fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8');

// Четыре сочетания настроек: «Анимации» (Nox) × «Уменьшение движения» (Windows).
const COMBOS = [
  { name: 'анимации выключены, Windows разрешает движение', motion: false, systemReduce: false, moving: false, emulation: 'reduce' },
  { name: 'анимации выключены, Windows уменьшает движение', motion: false, systemReduce: true, moving: false, emulation: 'reduce' },
  { name: 'анимации включены, Windows разрешает движение', motion: true, systemReduce: false, moving: true, emulation: '' },
  { name: 'анимации включены, Windows уменьшает движение', motion: true, systemReduce: true, moving: false, emulation: '' },
];

test('все четыре сочетания настроек дают правильный итог', () => {
  for (const c of COMBOS) {
    assert.equal(motionAllowed(c.motion, c.systemReduce), c.moving, c.name);
    assert.equal(emulatedReducedMotion(c.motion), c.emulation, `${c.name}: подмена окна`);
    const features = emulatedMotionFeatures(c.motion);
    if (c.emulation === 'reduce') {
      assert.deepEqual(features, [{ name: 'prefers-reduced-motion', value: 'reduce' }], `${c.name}: просим reduce`);
    } else {
      assert.deepEqual(features, [], `${c.name}: окно не подменяем — решает Windows`);
    }
  }
});

test('окну никогда не навязывается no-preference', () => {
  // Это и был прежний баг: включённые «Анимации» перебивали системное уменьшение движения.
  for (const motion of [undefined, true, false, null, 0, 'true']) {
    assert.notEqual(emulatedReducedMotion(motion), 'no-preference', `motion=${String(motion)}`);
    for (const f of emulatedMotionFeatures(motion)) assert.notEqual(f.value, 'no-preference');
  }
  // Явное false — единственное, что включает reduce само по себе; всё остальное — как в Windows.
  assert.equal(emulatedReducedMotion(undefined), '');
  assert.equal(emulatedReducedMotion(true), '');
  assert.equal(emulatedReducedMotion(false), 'reduce');
});

test('main.js: applyMotion только снимает подмену или просит reduce', () => {
  const fn = main.match(/async function applyMotion\(contents\) \{([\s\S]*?)\n\}/);
  assert.ok(fn, 'applyMotion на месте');
  const body = fn[1];
  assert.match(body, /emulatedMotionFeatures\(readSettings\(\)\.motion\)/, 'решение берётся из общей функции');
  assert.doesNotMatch(body, /no-preference/, 'no-preference в окно не отправляется');
  assert.doesNotMatch(body, /prefers-reduced-motion/, 'строка media-запроса живёт в src/appearance/motion.js');
  assert.match(main, /require\('\.\/src\/appearance\/motion'\)/, 'модуль подключён');
  // Переключатель в Настройках сразу переставляет подмену, не дожидаясь перезапуска.
  assert.match(main, /if \(key === 'motion' && win\) applyMotion\(win\.webContents\)/, 'ключ motion перерисовывает движение');
  assert.match(main, /applyMotion\(win\.webContents\);/, 'окно получает настройку при создании');
});

test('themes.css: при уменьшении движения гаснет только анимация, рисунок остаётся', () => {
  const reduce = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*([^{}]+)\{([^{}]*)\}/);
  assert.ok(reduce, 'блок prefers-reduced-motion: reduce');
  const targets = reduce[1].split(',').map((s) => s.trim());
  for (const t of ['.theme-fx', '.theme-fx::before', '.theme-fx::after']) assert.ok(targets.includes(t), `гасится ${t}`);
  assert.match(reduce[2], /animation:\s*none\s*!important/);

  // Тот же выключатель без подмены в окне: html[data-animations="off"].
  const own = css.match(/html\[data-animations="off"\] \.theme-fx,\s*html\[data-animations="off"\] \.theme-fx::before,\s*html\[data-animations="off"\] \.theme-fx::after \{([^{}]*)\}/);
  assert.ok(own, 'правило для выключенных анимаций');
  assert.match(own[1], /animation:\s*none\s*!important/);

  // Ни одно из двух правил не прячет сам эффект: все девять остаются нарисованными.
  for (const body of [reduce[2], own[1]]) {
    assert.doesNotMatch(body, /display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])|background(?:-image)?:\s*none|mask(?:-image)?:\s*none/);
  }
  const boot = fs.readFileSync(path.join(APP, 'renderer', 'theme-boot.js'), 'utf8');
  const effects = [...boot.match(/const FXS = \{([\s\S]*?)\};/)[1].matchAll(/([a-z]+): \[/g)].map((m) => m[1]).filter((id) => id !== 'theme' && id !== 'off');
  assert.deepEqual(effects.sort(), ['dawn', 'drift', 'grid', 'moon', 'pattern', 'rain', 'snow', 'stars', 'waves'], 'девять эффектов в «Виде»');
  for (const id of effects) assert.ok(css.includes(`html[data-fx="${id}"] .theme-fx::before {`), `рисунок ${id} на месте`);
});

test('renderer/app.js: выключатель ставит html[data-animations] и не трогает тему', () => {
  const fn = app.match(/function applyMotionLook\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn, 'applyMotionLook на месте');
  assert.match(fn[1], /dataset\.animations = S\.settings\.motion === false \? 'off' : 'on'/);
  assert.match(app, /syncDictationVisible\(\);\n    applyMotionLook\(\);/, 'значение обновляется вместе с переключателями');
  // Тема и вид рисуются своими файлами: этот выключатель их не переписывает.
  assert.doesNotMatch(fn[1], /dataset\.theme|localStorage|theme-boot/);
});

test('подпись «Анимации» в Настройках говорит правду про Windows', () => {
  const row = html.match(/<span class="set-name">Анимации<\/span><span class="set-hint">([^<]*)<\/span>/);
  assert.ok(row, 'строка «Анимации» в Настройках');
  assert.doesNotMatch(row[1], /даже если эффекты выключены в Windows/, 'прежнее обещание перебивать Windows убрано');
  assert.match(row[1], /Windows/, 'сказано, что решает Windows');
  assert.match(row[1], /Уменьшение движения/, 'названа настройка Windows');
});
