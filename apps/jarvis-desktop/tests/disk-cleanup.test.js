'use strict';

// disk_cleanup_suggest: большие файлы только внутри разрешённых папок (рабочая, но не данные и не папка программы),
// путь уходит в PowerShell через -LiteralPath, файлы, попавшие наружу через ссылку, в ответ не попадают.
// Суммирование ответа — чистое: байты/ГБ/категории, без чтения диска и без удаления.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { diskTools, summarizeCleanup, humanBytes, categoryOf, MB, GB } = require('../src/tools/disk');

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

// ── Суммирование: байты, ГБ, категории, мусорные входы, округление ──
// Вход — ответ PowerShell: [{ path, sizeMB }]. Функция ничего не читает и не удаляет.

test('суммирование: пустой и не-массив дают честные нули', () => {
  for (const input of [[], null, undefined, 'файлы', 42, {}]) {
    const sum = summarizeCleanup(input);
    assert.equal(sum.count, 0);
    assert.equal(sum.totalBytes, 0);
    assert.equal(sum.totalMB, 0);
    assert.equal(sum.totalGB, 0);
    assert.equal(sum.totalText, '0 Б');
    assert.deepEqual(sum.categories, []);
    assert.deepEqual(sum.files, []);
  }
});

test('суммирование: байты, ГБ, категории и порядок «крупные сверху»', () => {
  const files = [
    { path: 'D:\\загрузки\\setup.exe', sizeMB: 1024 },
    { path: 'D:\\загрузки\\фильм.mp4', sizeMB: 512 },
    { path: 'D:\\загрузки\\архив.zip', sizeMB: 2048.5 },
  ];
  const copy = JSON.parse(JSON.stringify(files));
  const sum = summarizeCleanup(files);

  assert.equal(sum.count, 3);
  assert.equal(sum.totalBytes, 3_758_620_672);
  assert.equal(sum.totalBytes, Math.round((1024 + 512 + 2048.5) * MB));
  assert.ok(Math.abs(sum.totalGB - 3.5005) < 0.001, String(sum.totalGB));
  assert.equal(sum.totalText, '3.5 ГБ');
  assert.deepEqual(files, copy, 'вход не меняется');

  assert.deepEqual(sum.files.map((file) => file.path), [
    'D:\\загрузки\\архив.zip',
    'D:\\загрузки\\setup.exe',
    'D:\\загрузки\\фильм.mp4',
  ]);
  assert.equal(sum.files[0].sizeMB, 2048.5);
  assert.equal(sum.files[0].category, 'archives');

  // Категории тоже по убыванию, с человеческой подписью размера.
  assert.deepEqual(sum.categories.map((group) => group.key), ['archives', 'installers', 'video']);
  assert.equal(sum.categories[0].count, 1);
  assert.equal(sum.categories[0].bytes, 2_148_007_936);
  assert.equal(sum.categories[0].title, 'архивы');
  assert.equal(sum.categories[0].text, '2.0 ГБ');
});

test('суммирование: мусорные входы не ломают счёт и не выдумывают байты', () => {
  const sum = summarizeCleanup([
    null,
    'строка',
    42,
    {},
    { path: '' },
    { path: '   ' },
    { path: 'нет-размера.bin' },
    { path: 'nan.bin', sizeMB: 'abc' },
    { path: 'neg.bin', sizeMB: -5 },
    { path: 'inf.bin', sizeMB: Infinity },
    { path: 'ok.bin', sizeMB: 1 },
  ]);
  assert.equal(sum.count, 5, 'считаются только записи с непустым путём');
  assert.equal(sum.totalBytes, MB);
  assert.equal(sum.totalText, '1.0 МБ');
  assert.equal(sum.files[0].path, 'ok.bin');
  assert.equal(sum.files[0].sizeBytes, MB);
  assert.equal(sum.categories.length, 1);
  assert.equal(sum.categories[0].key, 'other');
  assert.equal(sum.categories[0].count, 5);
  assert.equal(sum.categories[0].bytes, MB);
});

test('суммирование: округление Б/КБ/МБ/ГБ', () => {
  assert.equal(humanBytes(0), '0 Б');
  assert.equal(humanBytes(NaN), '0 Б');
  assert.equal(humanBytes(-5), '0 Б');
  assert.equal(humanBytes(1023), '1023 Б');
  assert.equal(humanBytes(1024), '1 КБ');
  assert.equal(humanBytes(1536), '2 КБ');
  assert.equal(humanBytes(MB), '1.0 МБ');
  assert.equal(humanBytes(13 * GB + Math.round(0.4 * GB)), '13.4 ГБ');
  assert.equal(humanBytes(GB), '1.0 ГБ');
});

test('суммирование: категория по расширению, неизвестное — «другое»', () => {
  assert.equal(categoryOf('setup.EXE'), 'installers');
  assert.equal(categoryOf('кино.mkv'), 'video');
  assert.equal(categoryOf('фото.png'), 'images');
  assert.equal(categoryOf('архив.7z'), 'archives');
  assert.equal(categoryOf('документ.pdf'), 'documents');
  assert.equal(categoryOf('странное.xyz'), 'other');
  assert.equal(categoryOf(''), 'other');
});

test('суммирование: suggest считает итог только по видимым файлам, скрытые за границей не входят', async (t) => {
  const { base, workspace, data } = setup(t);
  const inside = path.join(workspace, 'свой.zip');
  fs.writeFileSync(inside, Buffer.alloc(256 * 1024));
  const outside = path.join(data, 'чужой.bin');
  fs.writeFileSync(outside, Buffer.alloc(1024));
  const tool = cleanup({
    denyWrite: [data],
    run: async () => ({ ok: true, data: { stdout: JSON.stringify([{ path: outside, sizeMB: 5 }, { path: inside, sizeMB: 0.25 }]) } }),
  });
  const res = await tool.run({ folder: '.' }, { workspace });
  assert.equal(res.ok, true, res.summary);
  assert.equal(res.data.hidden, 1);
  assert.equal(res.data.totalBytes, Math.round(0.25 * MB), 'чужой файл не раздувает цифру');
  assert.equal(res.data.totalText, '256 КБ');
  assert.deepEqual(res.data.categories.map((group) => group.key), ['archives']);
  assert.equal(base.length > 0, true);
});

test('суммирование: suggest ничего не удаляет; отказ по границе тоже не трогает файлы', async (t) => {
  const { workspace } = setup(t);
  const archive = path.join(workspace, 'большой.zip');
  const video = path.join(workspace, 'фильм.mp4');
  fs.writeFileSync(archive, Buffer.alloc(256 * 1024, 1));
  fs.writeFileSync(video, Buffer.alloc(128 * 1024, 2));
  const runner = async () => ({
    ok: true,
    data: { stdout: JSON.stringify([{ path: archive, sizeMB: 0.25 }, { path: video, sizeMB: 0.125 }]) },
  });
  const tool = cleanup({ denyWrite: [], run: runner });

  const res = await tool.run({ folder: '.' }, { workspace });
  assert.equal(res.ok, true, res.summary);
  assert.equal(res.data.totalBytes, Math.round(0.375 * MB));
  assert.equal(res.data.totalText, '384 КБ');
  assert.equal(res.data.categories[0].key, 'archives');
  assert.equal(fs.existsSync(archive), true, 'suggest не удаляет файлы');
  assert.equal(fs.existsSync(video), true, 'suggest не удаляет файлы');

  const refused = await tool.run({ folder: '..' }, { workspace });
  assert.equal(refused.ok, false, 'папка вне рабочей отклонена');
  assert.equal(fs.existsSync(archive), true, 'отказ ничего не удалил');
  assert.equal(fs.existsSync(video), true, 'отказ ничего не удалил');
});
