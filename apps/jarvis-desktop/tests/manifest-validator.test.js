'use strict';

// Проверка манифестов библиотеки и связей приложения: на реальном репозитории и на синтетических ошибках.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkLibrary, pythonDescription } = require('../src/library/validator');
const { loadLibrary } = require('../src/library');
const { checkConnections, exportedNames, localRequires } = require('../src/validate/connections');
const { ENABLED, DISABLED, VERIFIED_SANDBOX, VERIFIED_READONLY } = require('../src/library/access');

const APP = path.resolve(__dirname, '..');
const COMMANDS = path.join(APP, 'scripts', 'commands');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, rel, text) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

// Синтетическая библиотека: один манифест с одной командой.
function library(t, { id, desc = 'Описание', source, manifestDesc = desc }) {
  const root = tmp(t);
  write(root, `apps/${id}.py`, source);
  write(root, 'manifest-test.json', JSON.stringify([{
    id, title: 'Тест', category: 'тест', phrases: [], script: `apps/${id}.py`, args: [], risk: 'T0', description: manifestDesc,
  }]));
  return root;
}

const PY_OK = (desc) => `import argparse\nparser = argparse.ArgumentParser(description='${desc}')\n`;

test('реальная библиотека согласована: нет проблем в манифестах, описаниях и доступе к файлам', () => {
  const { problems, info } = checkLibrary({ commandsDir: COMMANDS });
  assert.deepEqual(problems, []);
  assert.equal(info.entries, 72);
  assert.equal(info.enabled, ENABLED.length);
});

test('реальные связи main.js и preload.js согласованы', () => {
  assert.deepEqual(checkConnections({ appDir: APP }), []);
});

test('загрузчик отдаёт только включённые команды', () => {
  const ids = loadLibrary(COMMANDS).map((e) => e.id).sort();
  assert.deepEqual(ids, [...ENABLED].sort());
  for (const id of DISABLED) assert.equal(ids.includes(id), false, `${id} выключена`);
});

test('каждая проверенная команда есть в списке включённых и не пересекается с выключенными', () => {
  for (const id of [...VERIFIED_SANDBOX, ...VERIFIED_READONLY]) assert.ok(ENABLED.includes(id));
  for (const id of ENABLED) assert.equal(DISABLED.includes(id), false);
});

test('описание в скрипте должно совпадать с манифестом', (t) => {
  const root = library(t, { id: 'ok_cmd', desc: 'Скажи время', source: PY_OK('Другое описание') });
  const { problems } = checkLibrary({ commandsDir: root, policy: false });
  assert.ok(problems.some((p) => p.includes('не совпадает с манифестом')));
});

test('скрипт без Parser(description=...) — проблема', (t) => {
  const root = library(t, { id: 'no_desc', source: 'print("hi")\n' });
  const { problems } = checkLibrary({ commandsDir: root, policy: false });
  assert.ok(problems.some((p) => p.includes('нет Parser(description=...)')));
});

test('команда, которая трогает файлы и не включена явно, — проблема', (t) => {
  const source = `${PY_OK('Чужая папка')}import os\nprint(os.listdir(os.path.expanduser('~')))\n`;
  const root = library(t, { id: 'zz_unverified_files', desc: 'Чужая папка', source });
  const { problems } = checkLibrary({ commandsDir: root, policy: false });
  assert.ok(problems.some((p) => p.includes('обращается к файлам')), problems.join('\n'));
});

test('команда без обращения к файлам и не включённая — не проблема, а просто не загружается', (t) => {
  const root = library(t, { id: 'zz_plain', desc: 'Просто текст', source: `${PY_OK('Просто текст')}print("ok")\n` });
  const { problems, info } = checkLibrary({ commandsDir: root, policy: false });
  assert.deepEqual(problems, []);
  assert.equal(info.unverified, 1);
  assert.equal(loadLibrary(root).length, 0);
});

test('скрипт без манифеста — проблема (кроме известных исключений)', (t) => {
  const root = library(t, { id: 'zz_plain', desc: 'Текст', source: `${PY_OK('Текст')}` });
  write(root, 'apps/lonely.py', `${PY_OK('Один')}`);
  const { problems } = checkLibrary({ commandsDir: root, policy: false });
  assert.ok(problems.some((p) => p.includes('apps/lonely.py') && p.includes('не подключён')));
});

test('дубль id в двух манифестах — проблема', (t) => {
  const root = library(t, { id: 'dup', desc: 'Текст', source: PY_OK('Текст') });
  write(root, 'manifest-two.json', JSON.stringify([{
    id: 'dup', title: 'Тест', category: 'тест', phrases: [], script: 'apps/dup.py', args: [], risk: 'T0', description: 'Текст',
  }]));
  const { problems } = checkLibrary({ commandsDir: root, policy: false });
  assert.ok(problems.some((p) => p.includes('дубль id')));
});

test('битый JSON манифеста — проблема', (t) => {
  const root = tmp(t);
  write(root, 'manifest-bad.json', '[{');
  const { problems } = checkLibrary({ commandsDir: root, policy: false });
  assert.ok(problems.some((p) => p.includes('не читается как JSON')));
});

test('pythonDescription читает одинарные и двойные кавычки', () => {
  assert.equal(pythonDescription("Parser(description='Открыть')"), 'Открыть');
  assert.equal(pythonDescription('Parser(description="Открыть")'), 'Открыть');
  assert.equal(pythonDescription('print(1)'), null);
});

test('exportedNames понимает объект module.exports и пропускает не-объекты', () => {
  assert.deepEqual(exportedNames('module.exports = { a, b: 1, c };'), ['a', 'b', 'c']);
  assert.equal(exportedNames('module.exports = make();'), null);
});

test('localRequires находит деструктуризацию и bare require', () => {
  const src = "const { x, y: z } = require('./a');\nrequire('./b');";
  assert.deepEqual(localRequires(src), [{ spec: './a', names: ['x', 'y'] }, { spec: './b', names: [] }]);
});

test('связи: require на несуществующий файл и отсутствующий экспорт — проблемы', (t) => {
  const dir = tmp(t);
  write(dir, 'main.js', "const { gone } = require('./lib');\nconst { missing } = require('./there');\nrequire('./nothere');\n");
  write(dir, 'lib.js', 'module.exports = { present };\n');
  write(dir, 'there.js', 'module.exports = { other };\n');
  write(dir, 'preload.js', "const { contextBridge } = require('electron');\n");
  const problems = checkConnections({ appDir: dir });
  assert.ok(problems.some((p) => p.includes("require('./nothere')")), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('«gone»')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('«missing»')), problems.join('\n'));
});

test('связи: канал preload без обработчика в main — проблема', (t) => {
  const dir = tmp(t);
  write(dir, 'main.js', "ipcMain.handle('chat:send', () => 1);\n");
  write(dir, 'preload.js', "ipcRenderer.invoke('chat:send');\nipcRenderer.invoke('ghost:channel');\n");
  const problems = checkConnections({ appDir: dir });
  assert.ok(problems.some((p) => p.includes('ghost:channel')), problems.join('\n'));
  assert.equal(problems.some((p) => p.includes('chat:send')), false);
});

test('связи: путь библиотеки в main.js, которого нет на диске, — проблема', (t) => {
  const dir = tmp(t);
  write(dir, 'main.js', "const LIBRARY_DIR = path.join(__dirname, 'scripts', 'commands');\n");
  write(dir, 'preload.js', '');
  const problems = checkConnections({ appDir: dir });
  assert.ok(problems.some((p) => p.includes('несуществующую папку')), problems.join('\n'));
});

test('слишком большой манифест — проблема, а не падение', (t) => {
  const { MAX_MANIFEST_BYTES } = require('../src/library');
  const root = tmp(t);
  write(root, 'manifest-huge.json', 'x'.repeat(MAX_MANIFEST_BYTES + 10));
  const { problems } = checkLibrary({ commandsDir: root, policy: false });
  assert.ok(problems.some((p) => p.includes('manifest-huge.json') && p.includes('больше')), problems.join('\n'));
});
