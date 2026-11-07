'use strict';

// disk_cleanup_suggest: большие файлы только внутри разрешённых папок (рабочая, но не данные и не папка программы),
// путь уходит в PowerShell через -LiteralPath, файлы, попавшие наружу через ссылку, в ответ не попадают.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { diskTools } = require('../src/tools/disk');

const win = process.platform === 'win32';

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-disk-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'workspace');
  const data = path.join(base, 'data');
  fs.mkdirSync(workspace);
  fs.mkdirSync(data);
  return { base, workspace, data };
}

// denyWrite: [] — без настоящей папки данных: тест не должен смотреть в data/ приложения.
const cleanup = (options = {}) => diskTools({ denyWrite: [], ...options }).find((tool) => tool.name === 'disk_cleanup_suggest');

test('disk_cleanup_suggest: папка вне рабочей отклоняется, PowerShell не запускается', async (t) => {
  const { base, workspace, data } = setup(t);
  let calls = 0;
  const tool = cleanup({ run: async () => { calls += 1; return { ok: true, data: { stdout: '[]' } }; } });
  for (const folder of [base, path.join(base, 'снаружи'), '..', '../снаружи', data, 'C:\\Windows']) {
    const res = await tool.run({ folder }, { workspace });
    assert.equal(res.ok, false, folder);
    assert.match(res.summary, /вне рабочей|рабочей папки/, folder);
  }
  assert.equal(calls, 0, 'на чужую папку PowerShell не запускался');
  const none = await tool.run({ folder: 'куда-то' }, {});
  assert.equal(none.ok, false);
  assert.match(none.summary, /рабочую папку/);
});

test('disk_cleanup_suggest: папка данных закрыта даже внутри разрешённой папки', async (t) => {
  const { base, data } = setup(t);
  fs.writeFileSync(path.join(data, 'секрет.txt'), 'данные');
  let calls = 0;
  const tool = cleanup({ root: base, denyWrite: [data], run: async () => { calls += 1; return { ok: true, data: { stdout: '[]' } }; } });
  const res = await tool.run({ folder: 'data' }, {});
  assert.equal(res.ok, false);
  assert.match(res.summary, /папку программы/);
  assert.equal(calls, 0);
});

test('disk_cleanup_suggest: папка программы закрыта, даже если она внутри разрешённой', async (t) => {
  const { base } = setup(t);
  const appDir = path.resolve(__dirname, '..');
  const root = path.resolve(appDir, '..', '..');
  const tool = cleanup({ root, denyWrite: [] });
  const res = await tool.run({ folder: path.relative(root, appDir) }, {});
  assert.equal(res.ok, false, 'обзор папки программы запрещён');
  assert.match(res.summary, /папку программы/);
});

test('disk_cleanup_suggest: внутри рабочей папки путь идёт через -LiteralPath, ответ содержит файлы', async (t) => {
  const { workspace } = setup(t);
  const folder = path.join(workspace, 'папка [1]');
  fs.mkdirSync(folder);
  const inside = path.join(folder, 'большой.bin');
  const calls = [];
  const tool = cleanup({
    run: async (script, env, opts) => {
      calls.push({ script, env, opts });
      return { ok: true, data: { stdout: JSON.stringify({ path: inside, sizeMB: 12.5 }) } };
    },
  });
  const res = await tool.run({ folder: 'папка [1]' }, { workspace });
  assert.equal(res.ok, true, res.summary);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.JARVIS_ROOT, folder, 'проверенный абсолютный путь');
  assert.match(calls[0].script, /-LiteralPath \$root/, 'PowerShell не разбирает имя как шаблон');
  assert.equal(calls[0].opts.timeoutMs > 0, true);
  assert.deepEqual(res.data.files, [{ path: inside, sizeMB: 12.5 }]);
});

test('disk_cleanup_suggest: файл, попавший за границу через ссылку, в ответ не попадает', async (t) => {
  const { base, workspace, data } = setup(t);
  const outside = path.join(data, 'чужой-большой.bin');
  fs.writeFileSync(outside, 'x');
  const inside = path.join(workspace, 'свой.txt');
  fs.writeFileSync(inside, 'x');
  const tool = cleanup({
    denyWrite: [data],
    run: async () => ({ ok: true, data: { stdout: JSON.stringify([{ path: inside, sizeMB: 1 }, { path: outside, sizeMB: 2 }]) } }),
  });
  const res = await tool.run({ folder: '' }, { workspace });
  assert.equal(res.ok, false, 'пустая папка не принимается');
  const ok = await tool.run({ folder: '.' }, { workspace });
  assert.equal(ok.ok, true, ok.summary);
  assert.deepEqual(ok.data.files.map((f) => f.path), [inside], 'наружу файлы не показываются');
  assert.equal(ok.data.hidden, 1);
  assert.match(ok.summary, /скрыто/);
  assert.equal(path.dirname(outside), data, 'папка данных осталась на месте');
  assert.equal(base.length > 0, true);
});

test('disk_cleanup_suggest: в полном доступе можно шире, но не папка данных', async (t) => {
  const { base, data } = setup(t);
  const outside = path.join(base, 'другая');
  fs.mkdirSync(outside);
  const calls = [];
  const tool = cleanup({ denyWrite: [data], unrestricted: true, run: async (script, env) => { calls.push(env); return { ok: true, data: { stdout: '[]' } }; } });
  const res = await tool.run({ folder: outside }, {});
  assert.equal(res.ok, true, res.summary);
  assert.equal(calls[0].JARVIS_ROOT, outside);
  const blocked = await tool.run({ folder: data }, {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.summary, /папку программы/);
});

test('disk_cleanup_suggest: живой PowerShell видит файл в папке со скобками', { skip: !win, timeout: 30000 }, async (t) => {
  const { workspace } = setup(t);
  const folder = path.join(workspace, 'отчёты [2026]');
  fs.mkdirSync(folder);
  const big = path.join(folder, 'большой.txt');
  fs.writeFileSync(big, Buffer.alloc(256 * 1024, 7));
  const tool = cleanup({ denyWrite: [] });
  const res = await tool.run({ folder: 'отчёты [2026]' }, { workspace });
  assert.equal(res.ok, true, res.summary);
  assert.equal(res.data.files.length, 1);
  assert.equal(res.data.files[0].path.toLowerCase(), big.toLowerCase());
  assert.ok(res.data.files[0].sizeMB >= 0.2, String(res.data.files[0].sizeMB));
});
