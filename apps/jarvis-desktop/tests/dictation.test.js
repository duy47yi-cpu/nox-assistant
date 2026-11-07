'use strict';

// Разбор событий раннера диктовки: JSON-строки из stdout, мусор и пределы текста.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRunnerLine, validText, describeError, createDictationRouter, NO_LANGUAGE_MESSAGE } = require('../src/voice/dictation');

test('parseRunnerLine разбирает события раннера: текст, ошибка, состояние', () => {
  assert.deepEqual(parseRunnerLine('{"type":"text","text":"сказанное"}'), { type: 'text', text: 'сказанное' });
  assert.deepEqual(parseRunnerLine('{"type":"error","code":"no_language"}'), { type: 'error', code: 'no_language' });
  assert.deepEqual(parseRunnerLine('{"type":"error"}'), { type: 'error', code: 'unknown' }, 'без кода — unknown');
  assert.deepEqual(
    parseRunnerLine('{"type":"error","code":"mic_busy","message":"микрофон занят"}'),
    { type: 'error', code: 'mic_busy', message: 'микрофон занят' },
  );
  assert.deepEqual(parseRunnerLine('{"type":"state","state":"listening"}'), { type: 'state', state: 'listening' });
  assert.deepEqual(parseRunnerLine('{"type":"state","state":"stopped"}'), { type: 'state', state: 'stopped' });
  assert.deepEqual(
    parseRunnerLine('  {"type":"text","text":"после пробелов"}  '),
    { type: 'text', text: 'после пробелов' },
    'пробелы вокруг строки не мешают',
  );
});

test('мусор в stdout даёт null и не роняет разбор', () => {
  assert.equal(parseRunnerLine('не json'), null);
  assert.equal(parseRunnerLine(''), null);
  assert.equal(parseRunnerLine('   '), null);
  assert.equal(parseRunnerLine('[]'), null);
  assert.equal(parseRunnerLine('42'), null);
  assert.equal(parseRunnerLine('null'), null);
  assert.equal(parseRunnerLine('"строка"'), null);
  assert.equal(parseRunnerLine('{"type":"что-то"}'), null, 'неизвестный тип');
  assert.equal(parseRunnerLine('{"type":"text"}'), null, 'текст без текста');
  assert.equal(parseRunnerLine('{"type":"text","text":5}'), null, 'текст не строка');
  assert.equal(parseRunnerLine('{"type":"state","state":7}'), null, 'состояние не строка');
  assert.equal(parseRunnerLine(null), null);
});

test('validText: непустая строка не длиннее поля ввода', () => {
  assert.equal(validText('сказанное вслух'), true);
  assert.equal(validText('   с пробелами по краям   '), true);
  assert.equal(validText('   '), false, 'только пробелы');
  assert.equal(validText(''), false);
  assert.equal(validText(null), false);
  assert.equal(validText(undefined), false);
  assert.equal(validText(42), false);
  assert.equal(validText('а'.repeat(8000)), true, 'ровно предел поля');
  assert.equal(validText('а'.repeat(8001)), false, 'символ сверх предела');
});

test('describeError: понятные слова вместо кода', () => {
  assert.equal(describeError({ type: 'error', code: 'no_language' }), NO_LANGUAGE_MESSAGE);
  assert.equal(describeError({ type: 'error', code: 'mic_busy', message: 'микрофон занят' }), 'микрофон занят');
  assert.equal(describeError({ type: 'error', code: 'unknown' }), 'Распознавание не удалось');
  assert.equal(describeError({}), 'Распознавание не удалось');
  assert.equal(describeError(null), 'Распознавание не удалось');
  assert.equal(describeError({ message: '   ' }), 'Распознавание не удалось', 'пустое сообщение не показывается');
});

test('диктовка прерывает текущий ход один раз и передаёт слова без автоматической отправки', () => {
  const events = [];
  let stops = 0;
  const accept = createDictationRouter({ isBusy: () => true, interrupt: () => { stops += 1; }, emit: (event) => events.push(event) });
  accept({ type: 'state', state: 'listening' });
  accept({ type: 'text', text: '   ' });
  accept({ type: 'text', text: 'нет, проверь загрузки' });
  accept({ type: 'text', text: 'и покажи файлы' });
  assert.equal(stops, 1);
  assert.deepEqual(events, [
    { type: 'state', state: 'listening' },
    { type: 'text', text: 'нет, проверь загрузки' },
    { type: 'text', text: 'и покажи файлы' },
  ]);
});

test('диктовка без активного хода не останавливает работу', () => {
  let stops = 0;
  const events = [];
  const accept = createDictationRouter({ isBusy: () => false, interrupt: () => { stops += 1; }, emit: (event) => events.push(event) });
  accept({ type: 'text', text: 'новое поручение' });
  assert.equal(stops, 0);
  assert.equal(events[0].text, 'новое поручение');
});

test('поздний результат закрытой диктовки не останавливает новый ход и не попадает в поле', () => {
  let stops = 0;
  const events = [];
  const accept = createDictationRouter({ isBusy: () => true, interrupt: () => { stops += 1; }, emit: (event) => events.push(event) });
  accept.close();
  accept({ type: 'text', text: 'опоздавшая фраза' });
  assert.equal(stops, 0);
  assert.deepEqual(events, []);
});
