'use strict';

// Вопрос о последствиях — это вопрос, а не просьба искать кнопку. Модель иногда добавляет
// в конец «если скажете, где кнопка — уточню»; такие хвосты убираем кодом, только для этого вопроса.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripButtonLocationTail } = require('../src/agent/chat-reply');

const OWNER = 'что будет, если я нажму удалить?';

test('хвост про кнопку убирается, пункты последствий остаются', () => {
  const answer = `Изменится: файл исчезнет из папки. Потеряется: восстановить можно только из корзины. Отменить: сразу после нажатия — да. Если скажете, что за кнопка — уточню точнее.`;
  const out = stripButtonLocationTail(answer, OWNER);
  assert.doesNotMatch(out, /кнопк/i);
  assert.match(out, /Изменится: файл исчезнет/);
  assert.match(out, /Потеряется/);
  assert.match(out, /Отменить/);
});

test('вариант «зависит от того, где эта кнопка» тоже убирается', () => {
  const answer = `Файл удалится из папки без возможности вернуть его обычным способом. Зависит от того, где эта кнопка: подскажу, где именно, если покажете.`;
  const out = stripButtonLocationTail(answer, OWNER);
  assert.doesNotMatch(out, /кнопк/i);
  assert.match(out, /Файл удалится/);
});

test('хвост про уточнение объекта тоже убирается', () => {
  const answer = `Изменится: файл исчезнет. Потеряется: без корзины. Если скажете, что именно перед вами — файл или письмо — уточню.`;
  const out = stripButtonLocationTail(answer, OWNER);
  assert.doesNotMatch(out, /уточню/i);
  assert.doesNotMatch(out, /если скажете/i);
  assert.match(out, /Изменится: файл исчезнет/);
});

test('обычный вопрос не трогаем', () => {
  const answer = `Завтра будет дождь. Если скажете, где кнопка — уточню.`;
  assert.equal(stripButtonLocationTail(answer, 'что будет завтра?'), answer);
});

test('ответ без хвостов не меняется', () => {
  const answer = `Изменится: файл исчезнет. Потеряется: без корзины. Отменить: нельзя.`;
  assert.equal(stripButtonLocationTail(answer, OWNER), answer);
});

test('без слов владельца текст не трогаем', () => {
  const answer = `Файл удалится. Если скажете, где кнопка — уточню.`;
  assert.equal(stripButtonLocationTail(answer, ''), answer);
});
