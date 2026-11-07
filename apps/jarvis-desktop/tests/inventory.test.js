'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { AppInventory, SCAN_SCRIPT, parseScan, category } = require('../src/inventory/apps');
const { isScanRequest, isForgetRequest } = require('../src/inventory/consent');
const { inventoryTools } = require('../src/tools/inventory');
const { AppUsage } = require('../src/inventory/usage');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-apps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Имитация runPowerShell: пишет готовый JSON в файл, который указан в JARVIS_INV_OUT.
function fakeRunPS(json, ok = true) {
  return async (script, env) => {
    if (!ok) return { ok: false, summary: 'код выхода 1', data: {} };
    fs.writeFileSync(env.JARVIS_INV_OUT, json, 'utf8');
    return { ok: true, summary: 'готово', data: {} };
  };
}

const SAMPLE = JSON.stringify([
  { name: 'LibreWolf', path: 'C:\\Program Files\\LibreWolf', source: 'uninstall' },
  { name: 'LibreWolf', path: 'C:\\Program Files\\LibreWolf', source: 'uninstall' },
  { name: 'LibreWolf', path: 'C:\\Program Files\\LibreWolf\\librewolf.exe', source: 'startmenu' },
  { name: 'AyuGram', path: 'C:\\Users\\u\\AppData\\Local\\AyuGram\\AyuGram.exe', source: 'startmenu' },
  { name: 'Counter-Strike 2', path: null, source: 'uninstall' },
  { name: '', path: 'C:\\bad.exe', source: 'startmenu' },
  null,
]);

test('parseScan: одиночный объект и массив, пустые и дубли отбрасываются', () => {
  const items = parseScan(SAMPLE);
  assert.equal(items.length, 4);
  assert.equal(parseScan(JSON.stringify({ name: 'Solo', path: null, source: 'startmenu' })).length, 1);
  assert.deepEqual(parseScan(''), []);
  assert.equal(parseScan('не json'), null);
  assert.equal(parseScan('\uFEFF' + SAMPLE).length, 4, 'BOM от PowerShell не мешает');
});

test('scan: пишет список на диск и помнит дату', async (t) => {
  const dir = tmpDir(t);
  const inv = new AppInventory(path.join(dir, 'apps.json'));
  const res = await inv.scan(fakeRunPS(SAMPLE));
  assert.deepEqual(res, { ok: true, count: 4 });
  assert.ok(inv.scannedAt);
  const again = new AppInventory(path.join(dir, 'apps.json'));
  assert.equal(again.entries.length, 4, 'после перезапуска список на месте');
});

test('scan: ошибка PowerShell не трогает прежний список', async (t) => {
  const dir = tmpDir(t);
  const inv = new AppInventory(path.join(dir, 'apps.json'));
  await inv.scan(fakeRunPS(SAMPLE));
  const res = await inv.scan(fakeRunPS('', false));
  assert.equal(res.ok, false);
  assert.equal(inv.entries.length, 4);
});

test('find и resolveExe: точное совпадение первым, путь берётся только у exe', async (t) => {
  const dir = tmpDir(t);
  const inv = new AppInventory(path.join(dir, 'apps.json'));
  await inv.scan(fakeRunPS(SAMPLE));
  assert.equal(inv.find('librewolf')[0].name, 'LibreWolf');
  assert.equal(inv.resolveExe('librewolf'), 'C:\\Program Files\\LibreWolf\\librewolf.exe');
  assert.equal(inv.resolveExe('ayugram'), 'C:\\Users\\u\\AppData\\Local\\AyuGram\\AyuGram.exe');
  assert.equal(inv.resolveExe('counter-strike'), null, 'у игры нет exe в списке');
  assert.equal(inv.resolveExe('spotify'), null, 'Spotify в списке нет');
  assert.equal(inv.has(/spotify/i), false);
  assert.equal(inv.has(/ayugram/i), true);
});

test('summary: категории и пустые группы; без скана summary = null', async (t) => {
  const dir = tmpDir(t);
  const inv = new AppInventory(path.join(dir, 'apps.json'));
  assert.equal(inv.summary(), null);
  await inv.scan(fakeRunPS(SAMPLE));
  const s = inv.summary();
  assert.deepEqual(s.browser, ['LibreWolf']);
  assert.deepEqual(s.messenger, ['AyuGram']);
  assert.deepEqual(s.music, []);
  assert.deepEqual(s.game, ['Counter-Strike 2']);
});

test('clear: удаляет файл и список', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'apps.json');
  const inv = new AppInventory(file);
  await inv.scan(fakeRunPS(SAMPLE));
  inv.clear();
  assert.equal(fs.existsSync(file), false);
  assert.equal(inv.entries.length, 0);
  assert.equal(inv.summary(), null);
});

test('category: Spotify и YouTube Music относятся к музыке, Telegram-клиент к мессенджерам', () => {
  assert.equal(category('Spotify'), 'music');
  assert.equal(category('YouTube Music Desktop'), 'music');
  assert.equal(category('AyuGram Desktop'), 'messenger');
  assert.equal(category('Notepad'), null);
});

test('SCAN_SCRIPT: синтаксически корректный PowerShell (без запуска сканирования)', (t) => {
  if (process.platform !== 'win32') return t.skip('проверка PowerShell только на Windows');
  const dir = tmpDir(t);
  const file = path.join(dir, 'scan.ps1');
  fs.writeFileSync(file, SCAN_SCRIPT, 'utf8');
  const check = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '[void][scriptblock]::Create([IO.File]::ReadAllText($env:JARVIS_CHECK_FILE))',
  ], { env: { ...process.env, JARVIS_CHECK_FILE: file }, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('просьбы сканировать и забыть список', () => {
  assert.equal(isScanRequest('просканируй программы'), true);
  assert.equal(isScanRequest('какие у меня стоят программы'), true);
  assert.equal(isScanRequest('включи музыку'), false);
  assert.equal(isForgetRequest('забудь список программ'), true);
  assert.equal(isForgetRequest('удали приложение телеграм'), false, 'удаление не путаем со списком');
});

test('инструмент apps_find: до чтения списка не ищет, после — ищет', async (t) => {
  const dir = tmpDir(t);
  const inv = new AppInventory(path.join(dir, 'apps.json'));
  const usage = new AppUsage(path.join(dir, 'usage.json'));
  const [find] = inventoryTools({ inventory: inv, usage });
  assert.equal(find.risk, 'T0');
  const early = await find.run({ query: 'librewolf' });
  assert.equal(early.ok, false);
  await inv.scan(fakeRunPS(SAMPLE));
  const found = await find.run({ query: 'librewolf' });
  assert.equal(found.ok, true);
  assert.equal(found.data.matches.length, 2);
  const none = await find.run({ query: 'spotify' });
  assert.equal(none.ok, true);
  assert.deepEqual(none.data.matches, []);
});

test('apps_scan: не перечитывает список, если он свежий', async (t) => {
  const dir = tmpDir(t);
  const inv = new AppInventory(path.join(dir, 'apps.json'));
  const usage = new AppUsage(path.join(dir, 'usage.json'));
  const [, scan] = inventoryTools({ inventory: inv, usage, runPS: fakeRunPS(SAMPLE) });
  const first = await scan.run({});
  assert.equal(first.ok, true);
  assert.equal(first.data.count, 4);
  const second = await scan.run({});
  assert.match(second.summary, /свежий/);
});

test('apps_usage: снимок запущенных сопоставляет exe из списка и не повторяется в сутки', async (t) => {
  const dir = tmpDir(t);
  const inv = new AppInventory(path.join(dir, 'apps.json'));
  await inv.scan(fakeRunPS(SAMPLE));
  const usage = new AppUsage(path.join(dir, 'usage.json'));
  const procs = (script, env) => {
    fs.writeFileSync(env.JARVIS_INV_OUT, 'System\nlibrewolf\nexplorer\nAyuGram\n', 'utf8');
    return { ok: true, summary: 'готово', data: {} };
  };
  const [, , snap] = inventoryTools({ inventory: inv, usage, runPS: procs });
  const res = await snap.run({});
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.seen.sort(), ['AyuGram', 'LibreWolf'].sort());
  assert.equal(usage.apps.LibreWolf.seenRunning, 1);
  const again = await snap.run({});
  assert.match(again.summary, /меньше суток/);
  const forced = await usage.snapshot(inv, procs, { force: true });
  assert.equal(forced.ok, true);
});

test('AppUsage: запуски, выбор музыкального сервиса по привычке, очистка', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'usage.json');
  const usage = new AppUsage(file);
  assert.equal(usage.topService(), null);
  usage.recordService('youtube');
  usage.recordService('youtube');
  usage.recordService('spotify');
  usage.recordService('youtube_music');
  assert.equal(usage.topService(), 'youtube');
  assert.equal(usage.topService(['yandex', 'spotify']), 'spotify');
  usage.recordLaunch('LibreWolf');
  assert.deepEqual(usage.topApps(), ['LibreWolf']);
  const reloaded = new AppUsage(file);
  assert.equal(reloaded.topService(), 'youtube', 'привычки переживают перезапуск');
  reloaded.clear();
  assert.equal(fs.existsSync(file), false);
  assert.equal(reloaded.topService(), null);
});
