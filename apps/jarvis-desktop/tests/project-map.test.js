'use strict';

// Карта для агентов не должна врать: новый файл попадает в неё, а указанные пути существуют.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const ROOT = path.join(APP, '..', '..');
const map = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('каждый файл ядра и интерфейса есть на карте', () => {
  const files = [...walk(path.join(APP, 'src')), ...walk(path.join(APP, 'renderer'))]
    .filter((f) => /\.(js|html|css)$/.test(f) && !/\.test\.js$/.test(f) && !/\.gen\./.test(f))
    .map((f) => path.relative(APP, f).split(path.sep).join('/'));
  assert.deepEqual(files.filter((f) => !map.includes(`\`${f}\``)), []);
});

test('пути на карте существуют', () => {
  const paths = [...map.matchAll(/`((?:apps|docs|src|renderer|tests|scripts|skills|workspace|core|schemas|corpus|eval|review|persona|tools|bus|orch|NIGHT|stt-spike|studio-spike|dist|\.megapowers)[\w./-]*)`/g)].map((m) => m[1]).filter((p) => p.includes('/'));
  assert.ok(paths.length > 50);
  const missing = paths.filter((p) => ![ROOT, APP].some((base) => fs.existsSync(path.join(base, p))));
  assert.deepEqual(missing, []);
});
