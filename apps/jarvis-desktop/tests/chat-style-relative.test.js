'use strict';

// Правила ночного набора: относительная громкость (volume_get → арифметика → volume_set)
// и вопрос о последствиях действия. main.js не загрузить без Electron — читаем исходник
// и проверяем блок CHAT_REPLY_PROMPT, который входит и в общий, и в пространственный промпт.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function blockOf(name) {
  const start = source.indexOf('const ' + name + ' = [');
  assert.ok(start >= 0, 'в main.js должен быть блок ' + name);
  const end = source.indexOf("].join('\\n');", start);
  assert.ok(end > start, 'блок ' + name + ' должен собираться через join');
  return source.slice(start, end);
}

const reply = blockOf('CHAT_REPLY_PROMPT');

test('относительная громкость: сначала volume_get, потом точный расчёт и volume_set', () => {
  assert.match(reply, /тише в два раза/);
  assert.match(reply, /в три раза тише/);
  assert.match(reply, /громче на 10/);
  assert.match(reply, /сначала volume_get/);
  assert.match(reply, /volume_set/);
  assert.match(reply, /× 0,5/);
  assert.match(reply, /÷ 3/);
  assert.match(reply, /\+ 10 процентных пунктов/);
  assert.match(reply, /В ответе назови итог/);
});

test('если громкость не читается — честное «не могу измерить», без выдуманных процентов', () => {
  assert.match(reply, /«не могу измерить»/);
  assert.match(reply, /без выдуманных процентов/);
  assert.match(reply, /Если уровень не прочитался/);
});

test('абсолютная просьба о громкости не требует чтения', () => {
  assert.match(reply, /«Громкость 30» — сразу volume_set 30/);
});

test('вопрос о последствиях — это вопрос, а не просьба: ничего не выполнять', () => {
  assert.match(reply, /что будет, если я нажму/);
  assert.match(reply, /удалить\/оплатить\/отправить\/установить/);
  assert.match(reply, /это вопрос, а не просьба/);
  assert.match(reply, /ничего не выполняй/);
  assert.match(reply, /не ищи кнопку на экране/);
});

test('последствия объясняются 2–4 пунктами, даже если кнопка не названа', () => {
  assert.match(reply, /2–4 пунктами/);
  assert.match(reply, /что изменится/);
  assert.match(reply, /что потеряется/);
  assert.match(reply, /можно ли отменить/);
  assert.match(reply, /Если кнопка не названа/);
  assert.match(reply, /всё равно ответь про последствия/);
  assert.match(reply, /без вопросов и без просьб назвать кнопку или объект/);
  assert.match(reply, /не спрашивай «где кнопка», «что именно нажать» или «о каком объекте речь»/);
});

test('правила входят в обе сборки промпта', () => {
  assert.match(source, /const SYSTEM_PROMPT = \[[\s\S]*?CHAT_REPLY_PROMPT/);
  const occurrences = (source.match(/CHAT_REPLY_PROMPT,/g) || []).length;
  assert.ok(occurrences >= 2, 'CHAT_REPLY_PROMPT должен подключаться и в чате, и в пространствах');
});
