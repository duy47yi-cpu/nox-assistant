'use strict';

// Забывание с причиной (идея Supermemory): запись не стирается, а помечается забытой;
// из текущей памяти (поиск, профиль, список) она уходит, но остаётся в истории.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryStore } = require('../src/memory/store');
const { memoryTools } = require('../src/tools/memory');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-forget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new MemoryStore(path.join(dir, 'memory.json')) };
}

test('забытая запись скрыта из текущей памяти, но остаётся в истории с причиной', (t) => {
  const { store } = tempStore(t);
  const record = store.add({ text: 'Люблю чай', kind: 'preference' });
  assert.equal(store.search('чай').length, 1);

  store.update(record.id, { forgottenAt: '2026-11-08T10:00:00.000Z', forgetReason: 'устарело' });
  assert.deepEqual(store.search('чай'), [], 'поиск не показывает забытое');
  assert.equal(store.list(10).some((item) => item.id === record.id), false, 'список не показывает забытое');
  assert.equal(store.count(), 1, 'запись осталась в файле');

  const history = store.list(10, { includeForgotten: true }).find((item) => item.id === record.id);
  assert.ok(history, 'история доступна явно');
  assert.equal(history.forgetReason, 'устарело');
  assert.equal(history.forgottenAt, '2026-11-08T10:00:00.000Z');
});

test('инструмент forget помечает запись, а не удаляет её', async (t) => {
  const { dir, store } = tempStore(t);
  const tools = Object.fromEntries(memoryTools(store).map((tool) => [tool.name, tool]));
  await tools.remember.run({ text: 'Люблю кофе', kind: 'preference' }, { workspace: dir });
  const record = store.list(10).find((item) => /кофе/.test(item.text));

  const out = await tools.forget.run({ id: record.id, reason: 'передумал' }, {});
  assert.equal(out.ok, true);
  assert.equal(store.count(), 1, 'запись не удалена');
  assert.deepEqual(store.search('кофе'), [], 'поиск забытое не отдаёт');

  const history = store.list(10, { includeForgotten: true }).find((item) => item.id === record.id);
  assert.equal(history.forgetReason, 'передумал');
  assert.ok(history.forgottenAt);

  const verdict = await tools.forget.verify({ id: record.id }, {});
  assert.equal(verdict.status, 'confirmed');
  assert.match(verdict.evidence, /истори/i);
});

test('после забывания тот же факт можно запомнить заново', async (t) => {
  const { dir, store } = tempStore(t);
  const tools = Object.fromEntries(memoryTools(store).map((tool) => [tool.name, tool]));
  await tools.remember.run({ text: 'Люблю кофе', kind: 'preference' }, { workspace: dir });
  const first = store.list(10).find((item) => /кофе/.test(item.text));
  await tools.forget.run({ id: first.id, reason: 'ошибся' }, {});

  const again = await tools.remember.run({ text: 'Люблю кофе', kind: 'preference' }, { workspace: dir });
  assert.equal(again.ok, true);
  assert.equal(store.count(), 2, 'одна запись в истории, одна текущая');
  assert.equal(store.search('кофе').length, 1);
});
