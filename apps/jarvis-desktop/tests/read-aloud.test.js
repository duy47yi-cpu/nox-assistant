'use strict';

// Чтение вслух через инструмент: источники, управление, документы, честные отказы.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  desktopTools,
  setSpeaker,
  readDocumentText,
  htmlToText,
  docxXmlToText,
  getReader,
  readAloudBusy,
  stopReading,
} = require('../src/tools/desktop');

const tool = desktopTools.find((t) => t.name === 'read_clipboard_aloud');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-read-'));

function waitDone(reader) {
  return reader.finished();
}

test('read_clipboard_aloud: действие и источник объявлены, риск T1', () => {
  assert.equal(tool.risk, 'T1');
  assert.deepEqual(tool.parameters.properties.action.enum, ['start', 'pause', 'resume', 'stop', 'status']);
  assert.deepEqual(tool.parameters.properties.source.enum, ['clipboard', 'selection', 'file']);
  assert.deepEqual(tool.parameters.required, undefined);
});

test('управление без чтения: pause, resume, stop и status отвечают честно', async () => {
  stopReading();
  const status = await tool.run({ action: 'status' }, {});
  assert.equal(status.ok, true);
  assert.match(status.summary, /ничего не читаю/);
  const pause = await tool.run({ action: 'pause' }, {});
  assert.match(pause.summary, /ничего не читаю/);
  const stop = await tool.run({ action: 'stop' }, {});
  assert.equal(stop.ok, true);
  const bad = await tool.run({ action: 'переверни' }, {});
  assert.equal(bad.ok, false);
  const badSource = await tool.run({ source: 'камера' }, {});
  assert.equal(badSource.ok, false);
});

test('файл txt: читается вслух по предложениям, в фоне', async () => {
  const file = path.join(tmp, 'заметка.txt');
  fs.writeFileSync(file, 'Первое предложение. Второе предложение. Третье.');
  const said = [];
  setSpeaker(async (text, signal) => {
    said.push(text);
    if (signal?.aborted) throw new Error('прервано');
  });
  const res = await tool.run({ source: 'file', path: file }, {});
  assert.equal(res.ok, true);
  assert.match(res.summary, /читаю/);
  assert.match(res.summary, /читаю: 1 из 3 \(заметка\.txt\)/);
  await waitDone(getReader());
  assert.deepEqual(said, ['Первое предложение.', 'Второе предложение.', 'Третье.']);
  const after = await tool.run({ action: 'status' }, {});
  assert.match(after.summary, /дочитано/);
});

test('файл: .env, неподдерживаемое расширение и отсутствие файла — отказ с причиной', async () => {
  const env = await readDocumentText(path.join(tmp, '.env'));
  assert.equal(env.ok, false);
  assert.match(env.summary, /\.env/);

  const pdf = path.join(tmp, 'книга.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4');
  const pdfRes = await readDocumentText(pdf);
  assert.equal(pdfRes.ok, false);
  assert.match(pdfRes.summary, /не читаю/);

  const missing = await readDocumentText(path.join(tmp, 'нет.txt'));
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /не найден/);

  const empty = path.join(tmp, 'пусто.txt');
  fs.writeFileSync(empty, '   \n  ');
  const emptyRes = await readDocumentText(empty);
  assert.equal(emptyRes.ok, false);
  assert.match(emptyRes.summary, /нет текста/);
});

test('html: разметка, скрипты и стили не читаются', () => {
  const text = htmlToText('<html><head><style>p{color:red}</style></head><body><p>Привет &amp; пока</p><script>alert(1)</script><div>Второй абзац</div></body></html>');
  assert.match(text, /Привет & пока/);
  assert.match(text, /Второй абзац/);
  assert.doesNotMatch(text, /alert|color:red/);
});

test('docx: абзацы через перевод строки, теги прочь', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Первый абзац</w:t></w:r></w:p><w:p><w:r><w:t>Второй &amp; абзац</w:t></w:r></w:p></w:body></w:document>';
  const text = docxXmlToText(xml);
  assert.match(text, /Первый абзац/);
  assert.match(text, /Второй & абзац/);
  assert.doesNotMatch(text, /<w:/);
});

test('пауза и продолжение на настоящем чтении: место сохраняется', async () => {
  const file = path.join(tmp, 'длинный.txt');
  fs.writeFileSync(file, 'Первый кусок. Второй кусок. Третий кусок.');
  const said = [];
  let release = null;
  setSpeaker((text, signal) => {
    said.push(text);
    return new Promise((resolve, reject) => {
      release = resolve;
      if (signal) signal.addEventListener('abort', () => reject(new Error('прервано')), { once: true });
    });
  });
  await tool.run({ source: 'file', path: file }, {});
  assert.equal(readAloudBusy(), true);
  await new Promise((r) => setTimeout(r, 20));

  const paused = await tool.run({ action: 'pause' }, {});
  assert.match(paused.summary, /пауза на 1 из 3/);
  await new Promise((r) => setTimeout(r, 20));

  const resumed = await tool.run({ action: 'resume' }, {});
  assert.match(resumed.summary, /читаю/);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(said.slice(0, 2), ['Первый кусок.', 'Первый кусок.'], 'продолжение с того же куска');

  const stopped = await tool.run({ action: 'stop' }, {});
  assert.match(stopped.summary, /остановлено/);
  assert.equal(readAloudBusy(), false);
  if (release) release();
});

test('документ в другом окне: пробелы и переводы строк не мешают чтению', async () => {
  const file = path.join(tmp, 'многострочный.md');
  fs.writeFileSync(file, '# Заголовок\n\nПервый абзац.\nВторой абзац.\n');
  setSpeaker(async () => {});
  const res = await tool.run({ source: 'file', path: file }, {});
  assert.equal(res.ok, true);
  await waitDone(getReader());
  assert.equal(getReader().snapshot().state, 'done');
});
