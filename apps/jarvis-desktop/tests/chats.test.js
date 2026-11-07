'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChatBook, NEW_TITLE } = require('../src/chats/book');

const said = (text) => ({ role: 'user', content: text });

test('старый файл с одним разговором становится первой вкладкой, история не теряется', () => {
  const book = new ChatBook({ history: [said('привет')] });
  assert.equal(book.chats.length, 1);
  assert.equal(book.active().history[0].content, 'привет');
  assert.equal(book.list().chats[0].title, 'привет');
});

test('нет файла или он повреждён — один пустой чат', () => {
  for (const data of [null, {}, { chats: 'x' }, { chats: [{ id: 1 }] }]) {
    const book = new ChatBook(data);
    assert.equal(book.chats.length, 1);
    assert.equal(book.list().chats[0].title, NEW_TITLE);
  }
});

test('новый чат отдельный; пустых вкладок не копится', () => {
  const book = new ChatBook({ history: [said('первый')] });
  const first = book.activeId;
  const chat = book.create();
  assert.notEqual(book.activeId, first);
  assert.equal(chat.history.length, 0);
  assert.equal(book.create(), chat);
  assert.equal(book.chats.length, 2);
});

test('переключение: у чатов разные истории, чужой id отклоняется', () => {
  const book = new ChatBook({ history: [said('первый')] });
  const first = book.activeId;
  book.create().history.push(said('второй'));
  assert.equal(book.select(first), true);
  assert.equal(book.active().history[0].content, 'первый');
  assert.equal(book.select('нет такого'), false);
  assert.equal(book.activeId, first);
});

test('закрытие: активным становится сосед, последний заменяется пустым', () => {
  const book = new ChatBook({ history: [said('а')] });
  const a = book.activeId;
  book.create().history.push(said('б'));
  const b = book.activeId;
  assert.equal(book.close(b), true);
  assert.equal(book.activeId, a);
  assert.equal(book.close('нет такого'), false);
  book.close(a);
  assert.equal(book.chats.length, 1);
  assert.equal(book.active().history.length, 0);
});

test('сохранение и загрузка возвращают чаты и активную вкладку', () => {
  const book = new ChatBook({ history: [said('а')] });
  book.create().history.push(said('длинное сообщение, которое не помещается на вкладке целиком\nвторая строка'));
  const again = new ChatBook(JSON.parse(JSON.stringify(book.toJSON())));
  assert.equal(again.activeId, book.activeId);
  assert.equal(again.chats.length, 2);
  const title = again.list().chats[1].title;
  assert.equal(title.length, 32);
  assert.ok(title.endsWith('…'));
});

test('планировщик задач: stop() остаётся методом и при переданном аварийном стопе', () => {
  const { MissionScheduler } = require('../src/missions/scheduler');
  const s = new MissionScheduler({ store: { due: () => [] }, run: async () => ({}), stop: { isStopped: () => false } });
  assert.doesNotThrow(() => s.stop());
});
