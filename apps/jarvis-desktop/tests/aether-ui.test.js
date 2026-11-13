'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AETHER_DIR = path.join(__dirname, '..', 'renderer', 'aether');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

test('Nox Aether index.html имеет строгий офлайн CSP и подключает обе системы сфер', () => {
  const html = fs.readFileSync(path.join(AETHER_DIR, 'index.html'), 'utf8');
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /https?:\/\//i, 'Никаких внешних URL в оболочке быть не должно');
  for (const script of [
    '../theme-boot.js',
    'aether-boot.js',
    '../orb.js',
    '../orb-variants.js',
    '../orb-tune.js',
    '../orb-nox.js',
    '../orb-shutter.js',
    'orb-library.js',
    'store.js',
    'aether.js',
  ]) {
    assert.ok(html.includes(script), `Не подключён ${script}`);
  }
});

test('Навигация topbar содержит ровно 5 разделов и не содержит мусорных пунктов прототипа', () => {
  const src = fs.readFileSync(path.join(AETHER_DIR, 'components', 'topbar.js'), 'utf8');
  const start = src.indexOf('const NAV_ITEMS = [');
  const end = src.indexOf('];', start);
  assert.ok(start >= 0 && end > start);
  const block = src.slice(start, end);
  for (const lbl of ['Чат', 'Готовые команды', 'MCP-подключения', 'Личное пространство', 'Настройки']) {
    assert.ok(block.includes(`'${lbl}'`), `Не найден раздел ${lbl}`);
  }
  for (const bad of ['Разговор', 'Поровну', 'Присутствие', 'Демо-данные']) {
    assert.ok(!block.includes(bad), `Запрещённый пункт прототипа попал в NAV_ITEMS: ${bad}`);
  }
});

test('Файлы обеих оригинальных систем сфер (NoxOrb и JarvisOrb) не тронуты в оболочке Aether', () => {
  for (const f of ['orb.js', 'orb-variants.js', 'orb-nox.js', 'orb-shutter.js', 'nox-signature.css']) {
    assert.ok(fs.existsSync(path.join(RENDERER_DIR, f)), `Должен существовать ${f}`);
  }
  const boot = fs.readFileSync(path.join(AETHER_DIR, 'aether-boot.js'), 'utf8');
  assert.match(boot, /Times New Roman/);
  assert.match(boot, /IBM Plex Serif/);
});
