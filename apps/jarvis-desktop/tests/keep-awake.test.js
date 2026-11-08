'use strict';

// Не давать компьютеру заснуть во время работы (идея Hermes): блокировка только пока идёт ход/миссия,
// экран гаснет как обычно; режимы off / while-working / always; один блокировщик на всё приложение.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createKeepAwake, MODES, DEFAULT_MODE } = require('../src/control/keep-awake');

function fakeBlocker() {
  let next = 1;
  const started = new Map();
  return {
    start(type) {
      const id = next++;
      started.set(id, type);
      return id;
    },
    isStarted(id) {
      return started.has(id);
    },
    stop(id) {
      started.delete(id);
    },
    count() {
      return started.size;
    },
    types() {
      return [...started.values()];
    },
  };
}

test('по умолчанию блокирует сон только во время работы', () => {
  const blocker = fakeBlocker();
  const keep = createKeepAwake({ blocker });
  assert.equal(keep.getMode(), DEFAULT_MODE);
  assert.equal(keep.state().blocked, false);

  keep.begin();
  assert.equal(keep.state().blocked, true);
  assert.deepEqual(blocker.types(), ['prevent-app-suspension']);
  assert.equal(blocker.count(), 1, 'один блокировщик на всё приложение');

  keep.end();
  assert.equal(keep.state().blocked, false);
  assert.equal(blocker.count(), 0);
});

test('несколько одновременных ходов держат один блокировщик до последнего', () => {
  const blocker = fakeBlocker();
  const keep = createKeepAwake({ blocker });
  keep.begin();
  keep.begin();
  keep.begin();
  assert.equal(blocker.count(), 1, 'повторный begin не создаёт второй блокировщик');
  keep.end();
  keep.end();
  assert.equal(keep.state().blocked, true, 'пока идёт хотя бы один ход — блокировка держится');
  keep.end();
  assert.equal(keep.state().blocked, false);
  keep.end();
  assert.equal(keep.state().blocked, false, 'лишний end не уходит в минус');
});

test('режим «выключено» не блокирует сон', () => {
  const blocker = fakeBlocker();
  const keep = createKeepAwake({ blocker, mode: 'off' });
  keep.begin();
  assert.equal(keep.state().blocked, false);
  keep.end();
});

test('режим «всегда» блокирует и после завершения хода; выключение снимает', () => {
  const blocker = fakeBlocker();
  const keep = createKeepAwake({ blocker, mode: 'always' });
  keep.begin();
  keep.end();
  assert.equal(keep.state().blocked, true, 'в режиме «всегда» сон заблокирован и без хода');
  keep.setMode('off');
  assert.equal(keep.state().blocked, false);
  assert.equal(blocker.count(), 0);
});

test('неизвестный режим и отсутствие блокировщика безопасны', () => {
  const keep = createKeepAwake({ blocker: null });
  keep.begin();
  assert.equal(keep.state().blocked, false);
  keep.end();
  const mode = createKeepAwake({ blocker: fakeBlocker(), mode: 'что-то' });
  assert.equal(mode.getMode(), DEFAULT_MODE);
  assert.deepEqual(MODES, ['off', 'while-working', 'always']);
});

test('в настройках есть выбор режима сна и он сохраняется через ядро', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(html, /id="setKeepAwake"/, 'в Настройках есть выбор режима');
  assert.match(html, /value="while-working"/, 'есть режим «пока работает»');
  assert.match(app, /setKeepAwake/, 'окно читает выбор');
  assert.match(app, /setSetting', 'keepAwake'/, 'выбор сохраняется через ядро');
});
