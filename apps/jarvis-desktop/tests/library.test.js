'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLibrary, buildArgv, libraryTools, libraryModelTools } = require('../src/library');
const { MAX_MANIFEST_BYTES, MAX_SCRIPT_BYTES } = require('../src/library');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lib-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'files'));
  fs.writeFileSync(path.join(dir, 'files', 'ok.py'), 'print("ok")\n');
  fs.writeFileSync(path.join(dir, 'files', 'danger.py'), 'import argparse\np=argparse.ArgumentParser()\np.add_argument("--confirm", action="store_true")\n');
  return dir;
}

test('загрузка: годные записи берутся, битые и выход за папку отбрасываются', (t) => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, 'manifest-test.json'), JSON.stringify([
    { id: 'good', title: 'Хорошая', category: 'файлы', phrases: ['хорошая'], script: 'files/ok.py', args: ['path'], risk: 'T0' },
    { id: 'bad_risk', title: 'Плохая', script: 'files/ok.py', risk: 'T3' },
    { id: 'escape', title: 'Выход', script: '../../evil.py', risk: 'T0' },
    { id: 'missing', title: 'Нет файла', script: 'files/none.py', risk: 'T0' },
    { id: 'Bad Id', title: 'Имя с пробелом', script: 'files/ok.py', risk: 'T0' },
  ]), 'utf8');
  const list = loadLibrary(dir, { enabled: null });
  assert.deepEqual(list.map((e) => e.id), ['good']);
  assert.deepEqual(list[0].args, ['path']);
  assert.equal(list[0].needsConfirm, false);
});

test('buildArgv: аргументы отдельными элементами, --confirm только когда скрипт его знает', (t) => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, 'manifest-test.json'), JSON.stringify([
    { id: 'danger', title: 'Опасная', script: 'files/danger.py', args: ['path'], risk: 'T2' },
  ]), 'utf8');
  const [entry] = loadLibrary(dir, { enabled: null });
  assert.deepEqual(buildArgv(entry, { path: 'C:\\x y' }), [entry.script, '--path', 'C:\\x y']);
  assert.ok(buildArgv(entry, { __confirm: true }).includes('--confirm'));
  assert.ok(!buildArgv(entry, {}).includes('--confirm'));
});

test('модель не может запустить необратимую команду, обычную может', async (t) => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, 'manifest-test.json'), JSON.stringify([
    { id: 'ok', title: 'Обычная', script: 'files/ok.py', risk: 'T1' },
    { id: 'danger', title: 'Опасная', script: 'files/danger.py', risk: 'T2' },
  ]), 'utf8');
  const entries = loadLibrary(dir, { enabled: null });
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { ok: true, code: 0, output: 'ок' };
  };
  const [list, run] = libraryModelTools(entries, runner);
  const listed = await list.run({}, {});
  assert.equal(listed.data.commands.length, 2);
  const refused = await run.run({ id: 'danger' }, {});
  assert.equal(refused.ok, false);
  assert.equal(calls, 0);
  const done = await run.run({ id: 'ok' }, {});
  assert.equal(done.ok, true);
  assert.equal(calls, 1);
});

test('инструменты команд: риск из манифеста, T2 получает подтверждение', async (t) => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, 'manifest-test.json'), JSON.stringify([
    { id: 'danger', title: 'Опасная', script: 'files/danger.py', risk: 'T2' },
  ]), 'utf8');
  const entries = loadLibrary(dir, { enabled: null });
  let seen = null;
  const [tool] = libraryTools(entries, async (e, values) => {
    seen = values;
    return { ok: true, code: 0, output: '' };
  });
  assert.equal(tool.name, 'lib_danger');
  assert.equal(tool.risk, 'T2');
  await tool.run({}, {});
  assert.equal(seen.__confirm, true);
});

test('библиотека: огромный манифест не читается и не мешает остальным', (t) => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, 'manifest-test.json'), JSON.stringify([
    { id: 'ok', title: 'Обычная', script: 'files/ok.py', risk: 'T0' },
  ]), 'utf8');
  fs.writeFileSync(path.join(dir, 'manifest-huge.json'), 'x'.repeat(MAX_MANIFEST_BYTES + 10));
  const list = loadLibrary(dir, { enabled: null });
  assert.deepEqual(list.map((e) => e.id), ['ok']);
});

test('библиотека: огромный скрипт не загружается', (t) => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, 'files', 'huge.py'), '#'.repeat(MAX_SCRIPT_BYTES + 10));
  fs.writeFileSync(path.join(dir, 'manifest-test.json'), JSON.stringify([
    { id: 'huge', title: 'Огромная', script: 'files/huge.py', risk: 'T0' },
  ]), 'utf8');
  assert.deepEqual(loadLibrary(dir, { enabled: null }), []);
});
