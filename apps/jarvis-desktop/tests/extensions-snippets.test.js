'use strict';

// Быстрые вставки: список, уникальные триггеры, пределы, приватность, явная вставка.
// Только временные папки (%TEMP%); настоящая data/ не читается.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SnippetStore, triggerKey, MAX_ITEMS, MAX_TEXT, MAX_TRIGGER } = require('../src/extensions/snippets');

const BASE = Date.parse('2026-11-07T10:00:00Z');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-snip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'snippets.json') };
}

function makeStore(t, options = {}) {
  const { dir, file } = tempFile(t);
  const clock = { now: BASE };
  const store = new SnippetStore(file, { now: () => clock.now, ...options });
  return { dir, file, store, clock };
}

test('вставки: добавление, список, поиск по триггеру, сохранение на диск', (t) => {
  const { file, store } = makeStore(t);
  const added = store.add({ trigger: '/адрес', text: 'Москва, Красная площадь, 1' });
  assert.equal(added.trigger, '/адрес');
  store.add({ trigger: '/подпись', text: 'С уважением, Иван' });
  assert.deepEqual(store.list().map((item) => item.trigger), ['/адрес', '/подпись']);
  assert.equal(store.get(added.id).text, 'Москва, Красная площадь, 1');

  const reopened = new SnippetStore(file);
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.findByTrigger(' /Адрес ').id, added.id);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
});

test('вставки: триггер уникален без учёта регистра и лишних пробелов', (t) => {
  const { store } = makeStore(t);
  store.add({ trigger: 'Адрес', text: 'первый' });
  assert.throws(() => store.add({ trigger: ' адрес ', text: 'второй' }), /уже занят/);
  assert.throws(() => store.add({ trigger: 'АДРЕС', text: 'третий' }), /уже занят/);
  assert.equal(triggerKey('  Моё   Имя '), 'мое имя');
});

test('вставки: правка текста и триггера; занятый чужой триггер отклоняется', (t) => {
  const { store, clock } = makeStore(t);
  const first = store.add({ trigger: 'дом', text: 'старый адрес' });
  store.add({ trigger: 'работа', text: 'рабочий адрес' });
  clock.now += 1000;
  const updated = store.update(first.id, { text: 'новый адрес' });
  assert.equal(updated.text, 'новый адрес');
  assert.equal(updated.trigger, 'дом');
  assert.notEqual(updated.updatedAt, first.createdAt);
  assert.throws(() => store.update(first.id, { trigger: 'работа' }), /уже занят/);
  assert.equal(store.update('нет-такого', { text: 'x' }), null);
});

test('вставки: пределы и проверка полей до записи', (t) => {
  const { file, store } = makeStore(t, { maxItems: 2 });
  assert.throws(() => store.add({ trigger: '', text: 'x' }), /пустой триггер/);
  assert.throws(() => store.add({ trigger: 'т', text: '   ' }), /пустой текст/);
  assert.throws(() => store.add({ trigger: 'т'.repeat(MAX_TRIGGER + 1), text: 'x' }), /длиннее/);
  assert.throws(() => store.add({ trigger: 'т', text: 'x'.repeat(MAX_TEXT + 1) }), /длиннее/);
  assert.throws(() => store.add({ trigger: 'плохой\nтриггер', text: 'x' }), /управляющие/);
  assert.equal(fs.existsSync(file), false, 'при отказе файл не создаётся');

  store.add({ trigger: 'один', text: 'x' });
  store.add({ trigger: 'два', text: 'y' });
  assert.throws(() => store.add({ trigger: 'три', text: 'z' }), /больше не храню/);
  assert.equal(MAX_ITEMS, 100);
});

test('вставки: пароли, коды и карты в тексте не сохраняются', (t) => {
  const { file, store } = makeStore(t);
  for (const text of ['password: hunter2', 'token=abc123456', 'код подтверждения 123456', '4111 1111 1111 1111']) {
    assert.throws(() => store.add({ trigger: '/x', text }), /пароль, код или ключ/);
  }
  assert.equal(fs.existsSync(file), false);
  store.add({ trigger: '/безопасно', text: 'обычный шаблон письма' });
  const raw = fs.readFileSync(file, 'utf8');
  for (const fragment of ['hunter2', 'abc123456', '4111']) {
    assert.equal(raw.includes(fragment), false);
  }
});

test('вставки: предпросмотр ничего не вставляет и не меняет', (t) => {
  const { store } = makeStore(t);
  const item = store.add({ trigger: '/адрес', text: 'Москва' });
  const preview = store.preview(item.id);
  assert.equal(preview.ok, true);
  assert.equal(preview.text, 'Москва');
  assert.equal(store.preview('нет').reason, 'not_found');
  assert.equal(store.list().length, 1);
});

test('вставки: insert без confirm не отдаёт текст и не зовёт получателя', async (t) => {
  const { store } = makeStore(t);
  const item = store.add({ trigger: '/адрес', text: 'секретный адрес' });
  let called = 0;
  const res = await store.insert(item.id, { writer: () => { called += 1; } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'confirm_required');
  assert.equal('text' in res, false);
  assert.equal(called, 0);
});

test('вставки: insert с confirm отдаёт текст, а с получателем — вставляет явно', async (t) => {
  const { store } = makeStore(t);
  const item = store.add({ trigger: '/адрес', text: 'Москва' });
  const bare = await store.insert(item.id, { confirm: true });
  assert.equal(bare.ok, true);
  assert.equal(bare.inserted, false);
  assert.equal(bare.text, 'Москва');

  const seen = [];
  const written = await store.insert(item.id, { confirm: true, writer: async (text, meta) => { seen.push({ text, meta }); } });
  assert.equal(written.ok, true);
  assert.equal(written.inserted, true);
  assert.equal(seen[0].text, 'Москва');
  assert.equal(seen[0].meta.trigger, '/адрес');

  const failed = await store.insert(item.id, { confirm: true, writer: () => { throw new Error('буфер занят'); } });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'writer_failed');
  assert.equal(failed.message.includes('Москва'), false, 'текст вставки не должен попадать в ошибку');
});

test('вставки: секрет, попавший в файл снаружи, при чтении не показывается', (t) => {
  const { file, store } = makeStore(t);
  const stamp = new Date(BASE).toISOString();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    items: [
      { id: 'плохая', trigger: '/пароль', text: 'password: hunter2', createdAt: stamp, updatedAt: stamp },
      { id: 'хорошая', trigger: '/адрес', text: 'Москва', createdAt: stamp, updatedAt: stamp },
    ],
  }), 'utf8');
  assert.deepEqual(store.list().map((item) => item.id), ['хорошая']);
});

test('вставки: удаление, очистка и состояние', (t) => {
  const { store } = makeStore(t);
  const item = store.add({ trigger: '/x', text: 'x' });
  assert.equal(store.remove(item.id), true);
  assert.equal(store.remove(item.id), false);
  store.add({ trigger: '/y', text: 'y' });
  assert.deepEqual(store.clear(), { ok: true, removed: 1 });
  assert.deepEqual(store.state(), { ok: true, count: 0, maxItems: MAX_ITEMS });
});

test('вставки: повреждённый файл не перезаписывается, очистка сбрасывает его', (t) => {
  const { file, store } = makeStore(t);
  fs.writeFileSync(file, '{битый', 'utf8');
  assert.throws(() => store.add({ trigger: '/x', text: 'x' }), /повреждён/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{битый');
  assert.equal(store.clear().ok, true);
  store.add({ trigger: '/x', text: 'x' });
  assert.equal(store.list().length, 1);
});
