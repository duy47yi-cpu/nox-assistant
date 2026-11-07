'use strict';

// Уборка загрузок: анализ только читает, удаление только по confirm и только внутри папки.
// Только временные папки (%TEMP%); настоящая папка загрузок не читается.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  analyze,
  remove,
  classifyType,
  sizeBucket,
  ageBucket,
  humanBytes,
  TEMP_EXT,
} = require('../src/extensions/downloads-cleanup');

const NOW = Date.parse('2026-11-07T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Файл заданного возраста (дни) и размера; время файла считается от NOW.
function makeFile(root, rel, { size = 16, ageDays = 0 } = {}) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(size, 7));
  const when = new Date(NOW - ageDays * DAY);
  fs.utimesSync(abs, when, when);
  return abs;
}

function snapshot(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(`${path.relative(root, abs)}:${fs.statSync(abs).mtimeMs}:${fs.statSync(abs).size}`);
    }
  };
  walk(root);
  return out.sort();
}

test('уборка: пустая папка — состояние empty, не ошибка', (t) => {
  const dir = tempDir(t);
  const res = analyze(dir, { now: () => NOW });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'empty');
  assert.match(res.message, /пуста/);
  assert.deepEqual(res.candidates, []);
  assert.equal(res.candidateBytes, 0);
});

test('уборка: анализ группирует по возрасту, типу и размеру; кандидаты — старое и временное', (t) => {
  const dir = tempDir(t);
  makeFile(dir, 'старый.pdf', { size: 1000, ageDays: 40 });
  makeFile(dir, 'новый.png', { size: 500, ageDays: 1 });
  makeFile(dir, 'загрузка.crdownload', { size: 10, ageDays: 1 });

  const res = analyze(dir, { now: () => NOW, minAgeDays: 30 });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'ok');
  assert.equal(res.scanned.files, 3);
  assert.equal(res.scanned.totalBytes, 1510);
  assert.equal(res.groups.byAge.month.count, 1);
  assert.equal(res.groups.byAge.fresh.count, 2);
  assert.equal(res.groups.byType.documents.count, 1);
  assert.equal(res.groups.byType.images.count, 1);
  assert.equal(res.groups.byType.temp.count, 1);
  assert.equal(res.groups.bySize.small.count, 3);

  const names = res.candidates.map((item) => item.name).sort();
  assert.deepEqual(names, ['загрузка.crdownload', 'старый.pdf']);
  assert.equal(res.candidatesTotal, 2);
  assert.equal(res.candidateBytes, 1010);
  assert.equal(res.candidates[0].name, 'старый.pdf', 'сначала самый крупный кандидат');
  assert.match(res.candidates.find((item) => item.name === 'старый.pdf').reason, /старый файл/);
  assert.match(res.candidates.find((item) => item.name === 'загрузка.crdownload').reason, /временный/);
});

test('уборка: анализ только читает — файлы и время изменения не меняются', (t) => {
  const dir = tempDir(t);
  makeFile(dir, 'a.mp4', { size: 100, ageDays: 60 });
  makeFile(dir, 'b.txt', { size: 5, ageDays: 1 });
  const before = snapshot(dir);
  const res = analyze(dir, { now: () => NOW });
  assert.equal(res.ok, true);
  assert.deepEqual(snapshot(dir), before);
});

test('уборка: пределы обхода — глубина и число файлов', (t) => {
  const dir = tempDir(t);
  makeFile(dir, 'в корне.txt', { size: 1, ageDays: 1 });
  makeFile(dir, 'папка/внутри.txt', { size: 1, ageDays: 1 });
  const shallow = analyze(dir, { now: () => NOW, maxDepth: 0 });
  assert.equal(shallow.scanned.files, 1);
  assert.equal(shallow.scanned.dirs, 1);
  assert.ok(shallow.scanned.dirsSkipped >= 1);

  makeFile(dir, 'ещё.txt', { size: 1, ageDays: 1 });
  const limited = analyze(dir, { now: () => NOW, maxFiles: 2 });
  assert.equal(limited.scanned.files, 2);
  assert.equal(limited.scanned.truncated, true);
});

test('уборка: отсутствующая папка и файл вместо папки — понятная причина', (t) => {
  const dir = tempDir(t);
  const missing = analyze(path.join(dir, 'нет-такой'), { now: () => NOW });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not_found');
  const file = makeFile(dir, 'файл.txt', { size: 1 });
  const notDir = analyze(file, { now: () => NOW });
  assert.equal(notDir.ok, false);
  assert.equal(notDir.reason, 'not_directory');
  const empty = analyze('', { now: () => NOW });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'folder_required');
});

test('уборка: без confirm удаление невозможно, файлы целы', (t) => {
  const dir = tempDir(t);
  const file = makeFile(dir, 'старый.zip', { size: 100, ageDays: 90 });
  for (const confirm of [undefined, false, 'true', 1]) {
    const res = remove(['старый.zip'], confirm, { folder: dir });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'confirm_required');
    assert.match(res.message, /подтвержден/);
    assert.equal(fs.existsSync(file), true);
  }
  const noFolder = remove(['старый.zip'], true, {});
  assert.equal(noFolder.reason, 'folder_required');
  const notList = remove('старый.zip', true, { folder: dir });
  assert.equal(notList.reason, 'candidates_required');
  assert.equal(fs.existsSync(file), true);
});

test('уборка: удаление по confirm внутри папки считает освобождённое место', (t) => {
  const dir = tempDir(t);
  const first = makeFile(dir, 'a.zip', { size: 100, ageDays: 90 });
  const second = makeFile(dir, 'b.tmp', { size: 40, ageDays: 1 });
  const keep = makeFile(dir, 'важное.pdf', { size: 10, ageDays: 1 });

  const res = remove([{ path: 'a.zip' }, 'b.tmp'], true, { folder: dir });
  assert.equal(res.ok, true);
  assert.deepEqual(res.removed.sort(), ['a.zip', 'b.tmp']);
  assert.equal(res.bytesFreed, 140);
  assert.equal(res.refused.length, 0);
  assert.equal(res.failed.length, 0);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
  assert.equal(fs.existsSync(keep), true);
});

test('уборка: пути вне папки и «..» отклоняются, чужие файлы целы', (t) => {
  const dir = tempDir(t);
  makeFile(dir, 'внутри.txt', { size: 1 });
  const outsideDir = tempDir(t);
  const outside = makeFile(outsideDir, 'чужой.txt', { size: 5 });

  const res = remove(
    ['../чужой.txt', outside, path.join(outsideDir, 'чужой.txt'), '..', ''],
    true,
    { folder: dir },
  );
  assert.equal(res.ok, false);
  assert.equal(res.removed.length, 0);
  assert.ok(res.refused.length >= 3);
  assert.equal(fs.existsSync(outside), true);
  for (const item of res.refused) assert.match(item.reason, /вне папки|выводит|\/|путь/);

  const keepInside = makeFile(dir, 'внутри.txt', { size: 1 });
  assert.equal(fs.existsSync(keepInside), true);
});

test('уборка: ссылка и junction не удаляются и не раскрываются', (t) => {
  const dir = tempDir(t);
  const outsideDir = tempDir(t);
  const secret = makeFile(outsideDir, 'секрет.txt', { size: 5 });
  let linked = false;
  try {
    fs.symlinkSync(outsideDir, path.join(dir, 'ссылка на папку'), 'junction');
    linked = true;
  } catch {
    linked = false;
  }
  if (!linked) {
    t.skip('создание ссылки недоступно в этом окружении');
    return;
  }
  const analysis = analyze(dir, { now: () => NOW });
  assert.equal(analysis.ok, true);
  assert.ok(analysis.scanned.linksSkipped >= 1, 'ссылка при обходе пропускается');

  const direct = remove(['ссылка на папку'], true, { folder: dir });
  assert.equal(direct.ok, false);
  assert.equal(direct.removed.length, 0);
  assert.match(direct.refused[0].reason, /ссылка/);

  const through = remove(['ссылка на папку/секрет.txt'], true, { folder: dir });
  assert.equal(through.ok, false);
  assert.equal(through.removed.length, 0);
  assert.match(through.refused[0].reason, /уводит за папку/);
  assert.equal(fs.existsSync(secret), true);
});

test('уборка: пропавший файл — failed с причиной, а не тихий успех', (t) => {
  const dir = tempDir(t);
  makeFile(dir, 'есть.txt', { size: 1 });
  const res = remove(['нет.txt', 'есть.txt'], true, { folder: dir });
  assert.equal(res.ok, false);
  assert.deepEqual(res.removed, ['есть.txt']);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].reason, /уже нет/);
});

test('уборка: пустой список с подтверждением — нечего удалять, без ошибки', (t) => {
  const dir = tempDir(t);
  const res = remove([], true, { folder: dir });
  assert.equal(res.ok, true);
  assert.deepEqual(res.removed, []);
  assert.match(res.message, /нечего удалять/);
});

test('уборка: удаление в несуществующей папке отклоняется', (t) => {
  const dir = tempDir(t);
  const res = remove(['x.txt'], true, { folder: path.join(dir, 'нет') });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_found');
});

test('уборка: вспомогательные классификаторы', () => {
  assert.equal(classifyType('setup.exe'), 'installers');
  assert.equal(classifyType('photo.JPG'), 'images');
  assert.equal(classifyType('часть.crdownload'), 'temp');
  assert.equal(classifyType('без расширения'), 'other');
  assert.equal(sizeBucket(500), 'small');
  assert.equal(sizeBucket(5 * 1024 * 1024), 'medium');
  assert.equal(sizeBucket(200 * 1024 * 1024), 'large');
  assert.equal(sizeBucket(2 * 1024 * 1024 * 1024), 'huge');
  assert.equal(ageBucket(1), 'fresh');
  assert.equal(ageBucket(10), 'week');
  assert.equal(ageBucket(60), 'month');
  assert.equal(ageBucket(400), 'old');
  assert.equal(humanBytes(0), '0 Б');
  assert.equal(TEMP_EXT.has('.part'), true);
});
