'use strict';

// Режимы микрофона: переходы, фразы, ё/регистр/пунктуация, неизвестное.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  STATES, DEFAULT_STATE, LABELS, normalizeState, normalizePhrase, statusText, nextState, handlePhrase,
} = require('../src/voice/modes');

test('по умолчанию слушаем всё, неизвестное состояние не ломает управление', () => {
  assert.equal(DEFAULT_STATE, 'listening');
  assert.deepEqual(STATES, ['listening', 'quiet', 'off']);
  assert.equal(normalizeState('quiet'), 'quiet');
  assert.equal(normalizeState('off'), 'off');
  assert.equal(normalizeState('что-то'), 'listening');
  assert.equal(normalizeState(undefined), 'listening');
  assert.equal(normalizeState(null), 'listening');
});

test('полная диктовка → тихий режим по фразе «тихий режим»', () => {
  const result = handlePhrase('тихий режим', 'listening');
  assert.equal(result.state, 'quiet');
  assert.equal(result.action, 'set-quiet');
  assert.match(result.reply, /Джарвис|тихий/i);
});

test('возврат в обычный режим: «слушай меня» и «обычный режим»', () => {
  for (const phrase of ['слушай меня', 'обычный режим', 'вернись в обычный режим']) {
    const result = handlePhrase(phrase, 'quiet');
    assert.equal(result.state, 'listening', phrase);
    assert.equal(result.action, 'set-listening', phrase);
    assert.ok(result.reply.length > 0, phrase);
  }
});

test('«хватит слушать», «выключи микрофон», «не слушай» выключают микрофон', () => {
  for (const phrase of ['хватит слушать', 'выключи микрофон', 'не слушай', 'перестань слушать']) {
    for (const state of ['listening', 'quiet']) {
      const result = handlePhrase(phrase, state);
      assert.equal(result.state, 'off', `${phrase} из ${state}`);
      assert.equal(result.action, 'set-off', `${phrase} из ${state}`);
    }
  }
});

test('регистр, ё и пунктуация не мешают', () => {
  assert.equal(handlePhrase('ТИХИЙ РЕЖИМ!', 'listening').state, 'quiet');
  assert.equal(handlePhrase('  Хватит, слушать.  ', 'listening').state, 'off');
  assert.equal(handlePhrase('пЕрЕйДи, пожалуйста, в тихий режим', 'listening').state, 'quiet');
  assert.equal(handlePhrase('Слушай меня!', 'quiet').state, 'listening');
});

test('обращение «Джарвис» перед фразой режима не мешает', () => {
  assert.equal(handlePhrase('Джарвис, тихий режим', 'listening').state, 'quiet');
  assert.equal(handlePhrase('Джарвис хватит слушать', 'listening').state, 'off');
  assert.equal(handlePhrase('Джарвис, слушай меня', 'quiet').state, 'listening');
});

test('неизвестная фраза — не команда режима: состояние не меняется, ответа нет', () => {
  for (const phrase of ['открой ютуб', 'сколько время', 'т', '']) {
    const result = handlePhrase(phrase, 'quiet');
    assert.equal(result.state, 'quiet', phrase);
    assert.equal(result.action, 'none', phrase);
    assert.equal(result.reply, '', phrase);
  }
  assert.deepEqual(handlePhrase(null, 'listening'), { state: 'listening', action: 'none', reply: '' });
  assert.deepEqual(handlePhrase(42, 'listening'), { state: 'listening', action: 'none', reply: '' });
});

test('повторный переход отвечает «уже», но действие остаётся тем же', () => {
  const result = handlePhrase('тихий режим', 'quiet');
  assert.equal(result.state, 'quiet');
  assert.equal(result.action, 'set-quiet');
  assert.match(result.reply, /Уже/i);
});

test('подписи для индикатора: «Слушаю», «Только имя», «Микрофон выкл»', () => {
  assert.deepEqual(LABELS, { listening: 'Слушаю', quiet: 'Только имя', off: 'Микрофон выкл' });
  assert.equal(statusText('listening'), 'Слушаю');
  assert.equal(statusText('quiet'), 'Только имя');
  assert.equal(statusText('off'), 'Микрофон выкл');
  assert.equal(statusText('мусор'), 'Слушаю');
});

test('клик/горячая клавиша переключают режим по кругу', () => {
  assert.equal(nextState('listening'), 'quiet');
  assert.equal(nextState('quiet'), 'off');
  assert.equal(nextState('off'), 'listening');
  assert.equal(nextState('мусор'), 'quiet');
});

test('normalizePhrase убирает пунктуацию, ё и лишние слова', () => {
  assert.equal(normalizePhrase('  Тихий, РЕЖИМ! '), 'тихий режим');
  assert.equal(normalizePhrase('Джарвис, послушай'), 'послушай');
  assert.equal(normalizePhrase('не надо, пожалуйста'), 'не надо');
  assert.equal(normalizePhrase(''), '');
  assert.equal(normalizePhrase(null), '');
});
