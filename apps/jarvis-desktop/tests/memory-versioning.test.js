'use strict';

// Версии памяти (идея Supermemory): новый факт о том же предмете заменяет старый,
// но старая версия не удаляется — история остаётся доступной отдельно.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryStore } = require('../src/memory/store');
const { learnFromTurn } = require('../src/memory/learn');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemoryStore(path.join(dir, 'memory.json'));
}

test('новый факт о том же предмете заменяет старый, история остаётся', (t) => {
  const store = tempStore(t);
  learnFromTurn({ store, text: 'я живу в Москве' });
  const first = store.list(10)[0];
  assert.match(first.text, /Москве/);

  const result = learnFromTurn({ store, text: 'я живу в Питере' });
  assert.equal(result.added.length, 1, 'новый факт записан, а не выброшен');
  assert.equal(result.replaced.length, 1, 'видно, что заменён старый факт');
  assert.equal(store.count(), 2, 'старая запись не удалена');

  // Текущая память отдаёт только новую версию.
  assert.deepEqual(store.search('Москве'), [], 'заменённый факт не выдаётся как текущий');
  const current = store.search('Питере');
  assert.equal(current.length, 1);
  assert.match(current[0].text, /Питере/);

  // История доступна явно и хранит связь версий.
  const all = store.list(10, { includeSuperseded: true });
  const old = all.find((item) => /Москве/.test(item.text));
  const fresh = all.find((item) => /Питере/.test(item.text));
  assert.ok(old && fresh, 'обе версии лежат в файле памяти');
  assert.equal(old.supersededBy, fresh.id);
  assert.deepEqual(fresh.supersedes, [old.id]);
});

test('заменённый факт не попадает в профиль', (t) => {
  const store = tempStore(t);
  learnFromTurn({ store, text: 'я живу в Москве' });
  learnFromTurn({ store, text: 'я живу в Питере' });
  const profileText = store.profile().map((item) => item.text).join(' ');
  assert.match(profileText, /Питере/);
  assert.doesNotMatch(profileText, /Москве/);
});

test('версию можно пометить вручную; записи без пометки ведут себя как раньше', (t) => {
  const store = tempStore(t);
  const old = store.add({ text: 'Люблю чай', kind: 'preference' });
  const fresh = store.add({ text: 'Люблю кофе', kind: 'preference' });
  assert.equal(store.update(old.id, { supersededBy: fresh.id }).supersededBy, fresh.id);
  assert.deepEqual(store.search('чай').filter((item) => item.id === old.id), []);
  assert.equal(store.search('кофе').length, 1);
  assert.equal(store.list(10).filter((item) => item.id === old.id).length, 0);
  assert.equal(store.list(10, { includeSuperseded: true }).length, 2);
});
