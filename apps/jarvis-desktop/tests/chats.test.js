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

test('время последней работы с чатом сохраняется и отдаётся экрану Nox', () => {
  const book = new ChatBook({ history: [said('а')] });
  assert.equal(book.list().chats[0].updatedAt, 0);
  book.touch();
  const stamp = book.list().chats[0].updatedAt;
  assert.ok(stamp > 0);
  const again = new ChatBook(JSON.parse(JSON.stringify(book.toJSON())));
  assert.equal(again.list().chats[0].updatedAt, stamp);
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

test('прерванный ход: реплика без ответа получает пометку, законченная история не меняется', () => {
  const { markCutTurn, INTERRUPTED_TEXT } = require('../src/chats/book');
  const cut = markCutTurn([{ role: 'user', content: 'запиши файл' }]);
  assert.deepEqual(cut.at(-1), { role: 'assistant', content: INTERRUPTED_TEXT });
  const tool = markCutTurn([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ id: 'a' }] }, { role: 'tool', tool_call_id: 'a', content: '{}' }]);
  assert.equal(tool.at(-1).content, INTERRUPTED_TEXT);
  const done = [{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'здравствуйте' }];
  assert.equal(markCutTurn(done).length, 2);
  assert.equal(markCutTurn([]).length, 0);
});

test('select() не переписывает updatedAt старого чата', () => {
  const olderAt = Date.UTC(2026, 10, 14, 12, 0);
  const newerAt = Date.UTC(2026, 10, 18, 9, 0);
  const book = new ChatBook({
    activeId: 'c2',
    chats: [
      { id: 'c1', title: 'Старый чат', history: [said('давно')], updatedAt: olderAt },
      { id: 'c2', title: 'Свежий чат', history: [said('сегодня')], updatedAt: newerAt },
    ],
  });
  book.select('c1');
  assert.equal(book.activeId, 'c1');
  const oldChat = book.chats.find((c) => c.id === 'c1');
  assert.equal(oldChat.updatedAt, olderAt, 'просмотр старого чата не должен менять его дату');
});
