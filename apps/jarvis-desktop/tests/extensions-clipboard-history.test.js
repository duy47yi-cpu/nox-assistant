'use strict';

// История буфера: хранение, пределы, приватность, пауза, срок хранения, повреждённый файл.
// Только временные папки (%TEMP%), настоящая data/ не читается.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ClipboardHistoryStore,
  isPrivateText,
  MAX_ITEMS,
  MAX_TEXT,
  DEFAULT_TTL_MS,
} = require('../src/extensions/clipboard-history');

const BASE = Date.parse('2026-11-07T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-clip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'clipboard-history.json') };
}

function makeStore(t, options = {}) {
  const { dir, file } = tempFile(t);
  const clock = { now: BASE };
  const store = new ClipboardHistoryStore(file, { now: () => clock.now, ...options });
  return { dir, file, store, clock };
}

test('история: новые записи сверху, всё сохраняется и читается другим экземпляром', (t) => {
  const { dir, file, store } = makeStore(t);
  assert.equal(store.add({ text: 'первый' }).ok, true);
  assert.equal(store.add({ text: 'второй' }).ok, true);
  assert.deepEqual(store.list().map((item) => item.text), ['второй', 'первый']);

  const second = new ClipboardHistoryStore(file);
  assert.deepEqual(second.list().map((item) => item.text), ['второй', 'первый']);
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('история: дубликат не плодится, запись поднимается наверх', (t) => {
  const { store } = makeStore(t);
  store.add({ text: 'альфа' });
  store.add({ text: 'бета' });
  const again = store.add({ text: 'альфа' });
  assert.equal(again.duplicate, true);
  assert.deepEqual(store.list().map((item) => item.text), ['альфа', 'бета']);
  assert.equal(store.list().length, 1 + 1);
});

test('история: пустой текст и защищённое поле не сохраняются и не создают файл', (t) => {
  const { file, store } = makeStore(t);
  assert.equal(store.add({ text: '   ' }).reason, 'empty');
  assert.equal(store.add({ text: 'обычный текст', protected: true }).reason, 'protected');
  assert.equal(fs.existsSync(file), false);
});

test('история: пароли, коды, токены и карты не сохраняются; текста нет в файле', (t) => {
  const { file, store } = makeStore(t);
  const samples = [
    'password: hunter2',
    'Пароль = qwerty123',
    'token=abcdef123456',
    'api_key: sk-live-abcdefghijklmnop',
    'код подтверждения: 123456',
    'cvv: 123',
    'номер карты 4111 1111 1111 1111',
  ];
  for (const text of samples) {
    const res = store.add({ text });
    assert.equal(res.ok, false, `должно быть отклонено: ${text}`);
    assert.equal(res.reason, 'private');
    assert.equal(res.message.includes(text), false, 'текст не должен попадать в сообщение');
  }
  assert.equal(fs.existsSync(file), false, 'файл не должен создаваться при отказе');
  assert.equal(store.add({ text: 'безобидная заметка' }).ok, true);
  const raw = fs.readFileSync(file, 'utf8');
  for (const fragment of ['hunter2', 'qwerty123', 'abcdef123456', 'sk-live-abcdefghijklmnop', '123456', '4111']) {
    assert.equal(raw.includes(fragment), false, `секрет не должен оказаться в файле: ${fragment}`);
  }
});

test('история: проверка приватности видна интегратору', () => {
  assert.equal(isPrivateText('пароль: secret123'), true);
  assert.equal(isPrivateText('4111 1111 1111 1111'), true);
  assert.equal(isPrivateText('sk-abcdefghijklmnop'), true);
  assert.equal(isPrivateText('обычный текст без секретов'), false);
  assert.equal(isPrivateText('код 404 в ответе сервера'), true, 'осторожно: код с цифрами не сохраняется');
});

test('история: лимит записей вытесняет старые', (t) => {
  const { store } = makeStore(t, { maxItems: 3 });
  for (let i = 1; i <= 5; i += 1) store.add({ text: `запись ${i}` });
  assert.deepEqual(store.list().map((item) => item.text), ['запись 5', 'запись 4', 'запись 3']);
});

test('история: длинный текст обрезается, пометка truncated остаётся', (t) => {
  const { store } = makeStore(t, { maxText: 10 });
  const res = store.add({ text: 'abcdefghijklmno' });
  assert.equal(res.ok, true);
  assert.equal(res.item.text, 'abcdefghij');
  assert.equal(res.item.truncated, true);
  assert.equal(store.list()[0].text.length, 10);
});

test('история: суммарный лимит текста вытесняет самые старые', (t) => {
  const { store } = makeStore(t, { maxTotalChars: 6 });
  store.add({ text: 'aaaa' });
  store.add({ text: 'bbbb' });
  assert.deepEqual(store.list().map((item) => item.text), ['bbbb']);
});

test('история: пауза останавливает запись и переживает переоткрытие', (t) => {
  const { file, store } = makeStore(t);
  store.add({ text: 'до паузы' });
  store.pause();
  assert.equal(store.state().paused, true);
  const res = store.add({ text: 'во время паузы' });
  assert.equal(res.reason, 'paused');
  assert.deepEqual(store.list().map((item) => item.text), ['до паузы']);

  const reopened = new ClipboardHistoryStore(file);
  assert.equal(reopened.state().paused, true);
  reopened.resume();
  assert.equal(reopened.add({ text: 'после паузы' }).ok, true);
});

test('история: срок хранения убирает старое, null хранит бессрочно', (t) => {
  const { store, clock } = makeStore(t, { ttlMs: 1000 });
  store.add({ text: 'старое' });
  clock.now += 5000;
  assert.deepEqual(store.list(), []);
  assert.equal(store.state().ttlMs, 1000);

  store.add({ text: 'важное' });
  store.setTtl(null);
  clock.now += 365 * DAY;
  assert.deepEqual(store.list().map((item) => item.text), ['важное']);
  assert.throws(() => store.setTtl('не число'), /срок хранения/);
  assert.throws(() => store.setTtl(0), /срок хранения/);
});

test('история: по умолчанию срок хранения задан и конечен', (t) => {
  const { store } = makeStore(t);
  assert.equal(store.state().ttlMs, DEFAULT_TTL_MS);
  assert.equal(store.state().maxItems, MAX_ITEMS);
  assert.equal(MAX_TEXT, 4000);
});

test('история: удаление записи и явная очистка', (t) => {
  const { store } = makeStore(t);
  const first = store.add({ text: 'раз' }).item;
  store.add({ text: 'два' });
  assert.equal(store.remove(first.id), true);
  assert.equal(store.remove(first.id), false);
  assert.deepEqual(store.list().map((item) => item.text), ['два']);
  assert.deepEqual(store.clear(), { ok: true, removed: 1 });
  assert.deepEqual(store.list(), []);
});

test('история: повреждённый файл не перезаписывается, очистка сбрасывает его', (t) => {
  const { file, store } = makeStore(t);
  fs.writeFileSync(file, 'это не JSON', 'utf8');
  assert.throws(() => store.add({ text: 'новая' }), /повреждён/);
  assert.throws(() => store.list(), /повреждён/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'это не JSON');
  const cleared = store.clear();
  assert.equal(cleared.ok, true);
  assert.equal(store.add({ text: 'новая' }).ok, true);
  assert.deepEqual(store.list().map((item) => item.text), ['новая']);
});

test('история: секрет, попавший в файл снаружи, при чтении не показывается', (t) => {
  const { file, store } = makeStore(t);
  const stamp = new Date(BASE).toISOString();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    paused: false,
    ttlMs: null,
    items: [
      { id: 'плохая', text: 'password: hunter2', chars: 18, createdAt: stamp, copiedAt: stamp, truncated: false },
      { id: 'хорошая', text: 'безобидный текст', chars: 15, createdAt: stamp, copiedAt: stamp, truncated: false },
    ],
  }), 'utf8');
  assert.deepEqual(store.list().map((item) => item.id), ['хорошая']);
});

test('история: поиск по тексту и лимит выдачи', (t) => {
  const { store } = makeStore(t);
  store.add({ text: 'Адрес офиса: Москва' });
  store.add({ text: 'Телефон: 123' });
  assert.deepEqual(store.list({ query: 'адрес' }).map((item) => item.text), ['Адрес офиса: Москва']);
  store.add({ text: 'Ещё текст' });
  assert.equal(store.list({ limit: 2 }).length, 2);
});
