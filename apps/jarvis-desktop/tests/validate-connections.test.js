'use strict';

// Проверка связей экрана «Подключения»: методы моста, id элементов и разделы должны существовать.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkConnections, checkRendererBridge } = require('../src/validate/connections');

const APP = path.join(__dirname, '..');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-validate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, relative, text) {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('настоящее приложение: мост и разметка «Подключений» согласованы', () => {
  assert.deepEqual(checkRendererBridge(APP), []);
  assert.deepEqual(checkConnections({ appDir: APP }), []);
});

test('экран ссылается на отсутствующий метод моста, id и раздел — три проблемы', (t) => {
  const dir = tmpDir(t);
  write(dir, 'preload.js', [
    'contextBridge.exposeInMainWorld(\'jarvis\', {',
    '  mcpState: () => ipcRenderer.invoke(\'mcp:state\'),',
    '});',
  ].join('\n'));
  write(dir, 'renderer/index.html', '<section data-view="mcp"><ul id="mcpList"></ul></section>');
  write(dir, 'renderer/connections.js', [
    "const list = document.getElementById('mcpList');",
    "const gone = document.getElementById('mcpGhost');",
    "const view = document.querySelector('[data-view=\"ghost\"]');",
    'window.jarvis.mcpGhost();',
  ].join('\n'));
  const problems = checkRendererBridge(dir);
  assert.ok(problems.some((p) => p.includes('не даёт метод «mcpGhost»')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('элемента «mcpGhost»')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('раздела «ghost»')), problems.join('\n'));
});

test('без файлов renderer проверка молчит, а не падает', (t) => {
  const dir = tmpDir(t);
  write(dir, 'preload.js', '');
  assert.deepEqual(checkRendererBridge(dir), []);
});
