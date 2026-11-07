'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../src/config/atomic');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-atomic-'));
  return { dir, file: path.join(dir, 'settings.json') };
}

test('запись через временный файл: итог на месте, временного файла не остаётся', () => {
  const { dir, file } = tempFile();
  writeFileAtomic(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('сбой переименования не трогает прежний файл настроек', () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, '{"mode":"full"}', 'utf8');
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('сбой диска'); };
  try {
    assert.throws(() => writeFileAtomic(file, '{"mode":"ask"}'), /сбой диска/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mode":"full"}');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('сбой записи временного файла не трогает прежний файл настроек', () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, '{"mode":"full"}', 'utf8');
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (target, ...rest) => {
    if (String(target).endsWith('.tmp')) throw new Error('нет места');
    return realWrite(target, ...rest);
  };
  try {
    assert.throws(() => writeFileAtomic(file, '{"mode":"ask"}'), /нет места/);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mode":"full"}');
  fs.rmSync(dir, { recursive: true, force: true });
});
