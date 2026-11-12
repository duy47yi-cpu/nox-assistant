'use strict';

// Чтение вслух: пауза, продолжение с того же места, остановка, длинные тексты и сбои синтеза.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReader, splitForReading, normalizeReading, MAX_READ, FRAGMENT_MAX } = require('../src/voice/reader');

// Голос для проверок: запоминает, что и в каком порядке сказано; умеет «звучать» до сигнала отмены.
function fakeVoice({ failOn = null, failTimes = 0 } = {}) {
  const said = [];
  let failures = 0;
  const voice = async (text, signal) => {
    said.push(text);
    if (failOn && text.includes(failOn) && failures < failTimes) {
      failures += 1;
      throw new Error('синтез не удался');
    }
    if (signal?.aborted) throw new Error('остановлено');
  };
  voice.said = said;
  return voice;
}

// Ждём, пока состояние станет нужным: голос «говорит» мгновенно, поэтому ждём событий.
function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('не дождались состояния'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('деление на куски: ничего не теряется и не повторяется', () => {
  const text = 'Первое предложение. Второе! Третье? ' + 'Длинная фраза, '.repeat(40) + 'Конец.';
  const { parts } = splitForReading(text);
  assert.ok(parts.length > 3);
  assert.equal(parts.join(' '), text.replace(/\s+/g, ' ').trim());
  for (const part of parts) {
    assert.ok(part.length <= FRAGMENT_MAX, `кусок длиннее ${FRAGMENT_MAX}: ${part.length}`);
    assert.ok(part.trim().length > 0);
  }
});

test('деление на куски: каждое предложение отдельно, длинное режется по запятой', () => {
  const { parts } = splitForReading('Да. Нет. Хорошо. ' + 'Очень длинное перечисление, '.repeat(30) + 'конец.');
  assert.deepEqual(parts.slice(0, 3), ['Да.', 'Нет.', 'Хорошо.']);
  assert.ok(parts.every((part) => part.length <= FRAGMENT_MAX));
  assert.ok(parts.length > 3, 'длинное предложение разрезано на несколько кусков');
});

test('длинный текст: предел чтения и честный признак обрезки', () => {
  const long = 'Предложение про длинный текст. '.repeat(2000);
  const res = splitForReading(long);
  assert.equal(res.truncated, true);
  assert.ok(res.parts.join(' ').length <= MAX_READ + 1);
  assert.ok(res.parts.length > 10);
  const short = splitForReading('Короткий текст.');
  assert.equal(short.truncated, false);
});

test('пустой текст и пробелы: кусков нет', () => {
  assert.deepEqual(splitForReading('').parts, []);
  assert.deepEqual(splitForReading('   \n\t ').parts, []);
  assert.equal(normalizeReading('  а \n б  '), 'а б');
});

test('чтение доходит до конца и не повторяет куски', async () => {
  const voice = fakeVoice();
  const reader = createReader({ speak: voice });
  const started = reader.start('Раз. Два. Три.');
  assert.equal(started.state, 'playing');
  await reader.finished();
  assert.deepEqual(voice.said, ['Раз.', 'Два.', 'Три.']);
  assert.equal(reader.snapshot().state, 'done');
  assert.equal(reader.snapshot().index, 3);
});

test('пауза останавливает звук, продолжение начинает тот же кусок — без пропусков и повторов', async () => {
  const said = [];
  let release = null;
  // Голос «звучит», пока его не прервут: так проверяется настоящая пауза посреди куска.
  const voice = (text, signal) => {
    said.push(text);
    return new Promise((resolve, reject) => {
      release = () => resolve();
      if (signal) signal.addEventListener('abort', () => reject(new Error('прервано')), { once: true });
    });
  };
  const reader = createReader({ speak: voice });
  reader.start('Первый. Второй. Третий.');
  await waitFor(() => said.length === 1);

  const paused = reader.pause();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.index, 0, 'пауза на первом куске');
  await new Promise((r) => setTimeout(r, 20));

  const resumed = reader.resume();
  assert.equal(resumed.state, 'playing');
  await waitFor(() => said.length === 2);
  assert.equal(said[1], 'Первый.', 'после паузы тот же кусок, а не следующий и не сначала');

  // Дальше отпускаем куски по одному: второй и третий.
  release();
  await waitFor(() => said.length === 3);
  assert.equal(said[2], 'Второй.');
  release();
  await waitFor(() => said.length === 4);
  assert.equal(said[3], 'Третий.');
  release();
  await reader.finished();
  assert.deepEqual(said, ['Первый.', 'Первый.', 'Второй.', 'Третий.']);
  assert.equal(reader.snapshot().state, 'done');
});

test('остановка: звук обрывается, дальше не читает', async () => {
  const said = [];
  const voice = (text, signal) => new Promise((resolve, reject) => {
    said.push(text);
    if (signal) signal.addEventListener('abort', () => reject(new Error('прервано')), { once: true });
    else resolve();
  });
  const reader = createReader({ speak: voice });
  reader.start('Первый. Второй.');
  await waitFor(() => said.length === 1);
  const stopped = reader.stop();
  assert.equal(stopped.state, 'stopped');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(said, ['Первый.'], 'после стопа новых кусков нет');
  assert.equal(reader.busy, false);
});

test('пауза и продолжение ничего не делают, когда читать нечего', () => {
  const reader = createReader({ speak: async () => {} });
  assert.equal(reader.pause().state, 'idle');
  assert.equal(reader.resume().state, 'idle');
  assert.equal(reader.stop().state, 'idle');
  assert.equal(reader.busy, false);
});

test('сбой синтеза: одна повторная попытка, потом честная остановка с местом', async () => {
  const voice = fakeVoice({ failOn: 'Второй', failTimes: 1 });
  const reader = createReader({ speak: voice });
  reader.start('Первый. Второй. Третий.');
  await reader.finished();
  // Второй кусок повторили один раз и прочитали дальше — чтение не сломалось.
  assert.deepEqual(voice.said, ['Первый.', 'Второй.', 'Второй.', 'Третий.']);
  assert.equal(reader.snapshot().state, 'done');

  const broken = fakeVoice({ failOn: 'Второй', failTimes: 99 });
  const reader2 = createReader({ speak: broken });
  reader2.start('Первый. Второй. Третий.');
  await reader2.finished();
  const snap = reader2.snapshot();
  assert.equal(snap.state, 'error');
  assert.equal(snap.index, 1, 'остановились на втором куске, а не «дочитали»');
  assert.match(snap.error, /синтез/);
  assert.deepEqual(broken.said, ['Первый.', 'Второй.', 'Второй.']);
});

test('новое чтение заменяет старое, а не говорит двумя голосами', async () => {
  const said = [];
  const voice = async (text, signal) => {
    said.push(text);
    if (signal?.aborted) throw new Error('прервано');
  };
  const reader = createReader({ speak: voice });
  reader.start('Старое. Чтение.');
  await waitFor(() => said.length >= 1);
  reader.start('Новое. Чтение.');
  await reader.finished();
  const last = reader.snapshot();
  assert.equal(last.total, 2);
  assert.equal(last.state, 'done');
  assert.equal(said[said.length - 1], "Чтение.", "последним читается новое");
});
