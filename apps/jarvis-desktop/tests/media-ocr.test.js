'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { mediaTools, parseLine } = require('../src/tools/media');
const { imageTools } = require('../src/tools/ocr');

test('разбор ответа плеера: нет сессии, статус, отказ', () => {
  assert.deepEqual(parseLine('NO_SESSION'), { session: false });
  assert.equal(parseLine('OK=True STATUS=Playing APP=x').status, 'Playing');
  assert.equal(parseLine('OK=False STATUS=Paused APP=x').ok, false);
});

test('media_control: неизвестное действие отклоняется, без сессии — честный отказ', async () => {
  const runner = async () => ({ ok: true, data: { stdout: 'NO_SESSION' }, summary: '' });
  const tool = mediaTools({ runner })[0];
  assert.equal((await tool.run({ action: 'delete' }, {})).ok, false);
  const none = await tool.run({ action: 'play' }, {});
  assert.equal(none.ok, false);
  assert.match(none.summary, /плеер не найден/);
});

test('media_control: пауза подтверждается статусом, переключение трека — не проверено', async () => {
  const runner = async () => ({ ok: true, data: { stdout: 'STATUS=Paused' }, summary: '' });
  const tool = mediaTools({ runner })[0];
  const v = await tool.verify({}, { data: { action: 'pause' } }, {});
  assert.equal(v.status, 'confirmed');
  const n = await tool.verify({}, { data: { action: 'next' } }, {});
  assert.equal(n.status, 'unknown');
});

test('image_read_text: не картинка и файл вне рабочей папки отклоняются', async () => {
  const root = path.resolve('C:/tmp/ws');
  const tool = imageTools({ runner: async () => ({ ok: true, data: { stdout: 'текст' } }), workspace: root })[0];
  assert.equal((await tool.run({ path: 'a.pdf' }, { workspace: root })).ok, false);
  assert.equal((await tool.run({ path: '../secret.png' }, { workspace: root })).ok, false);
});

test('image_read_text: картинка в рабочей папке читается', async () => {
  const root = path.resolve('C:/tmp/ws');
  const tool = imageTools({ runner: async () => ({ ok: true, data: { stdout: 'Игра Отбой' } }), workspace: root })[0];
  const res = await tool.run({ path: 'shot.png' }, { workspace: root });
  assert.equal(res.ok, true);
  assert.equal(res.data.text, 'Игра Отбой');
});

test('image_read_text: сохраняет координаты строк для понимания расположения подписей', async () => {
  const root = path.resolve('C:/tmp/ws');
  const rows = [{ text: 'Вход', x: 10, y: 12, width: 30, height: 9 }, { text: 'Выход', x: 90, y: 12, width: 36, height: 9 }];
  const tool = imageTools({ runner: async () => ({ ok: true, data: { stdout: JSON.stringify(rows) } }), workspace: root })[0];
  const res = await tool.run({ path: 'diagram.png' }, { workspace: root });
  assert.equal(res.ok, true);
  assert.equal(res.data.text, 'Вход\nВыход');
  assert.deepEqual(res.data.lines, rows);
  assert.match(res.summary, /координаты строк/);
});
