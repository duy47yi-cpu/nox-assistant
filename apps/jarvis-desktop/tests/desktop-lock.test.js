'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DesktopLock, guardDesktopTools, BLOCKED_DESKTOP } = require('../src/control/desktop-lock');

const tool = (name, run) => ({ name, run, verify: async () => ({ status: 'confirmed' }) });

test('действия идут строго по одному, в порядке очереди', async () => {
  const lock = new DesktopLock();
  const log = [];
  let release;
  const first = lock.run(() => new Promise((r) => { log.push('a'); release = r; }));
  const second = lock.run(async () => { log.push('b'); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['a']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(log, ['a', 'b']);
  assert.equal(lock.busy, false);
});

test('заблокированный экран останавливает и владельца, и фон', async () => {
  const lock = new DesktopLock();
  lock.setLocked(true);
  let ran = false;
  for (const background of [false, true]) {
    const r = await lock.run(async () => { ran = true; }, { background });
    assert.equal(r.ok, false);
    assert.equal(r.data.state, BLOCKED_DESKTOP);
  }
  assert.equal(ran, false);
  lock.setLocked(false);
  await lock.run(async () => { ran = true; });
  assert.equal(ran, true);
});

test('фон не трогает стол, пока владелец за компьютером, а чат трогает', async () => {
  let idle = 5;
  const lock = new DesktopLock({ idleSeconds: () => idle });
  let runs = 0;
  const bg = await lock.run(async () => { runs += 1; }, { background: true });
  assert.equal(bg.data.state, BLOCKED_DESKTOP);
  await lock.run(async () => { runs += 1; });
  assert.equal(runs, 1);
  idle = 600;
  await lock.run(async () => { runs += 1; }, { background: true });
  assert.equal(runs, 2);
});

test('фон не ждёт в очереди занятый стол', async () => {
  const lock = new DesktopLock();
  let release;
  const held = lock.run(() => new Promise((r) => { release = r; }));
  const r = await lock.run(async () => {}, { background: true });
  assert.equal(r.data.state, BLOCKED_DESKTOP);
  release();
  await held;
});

test('стоп снимает ожидание в очереди, очередь не ломается', async () => {
  const lock = new DesktopLock();
  let release;
  const held = lock.run(() => new Promise((r) => { release = r; }));
  const ac = new AbortController();
  let ran = false;
  const waiting = lock.run(async () => { ran = true; }, { signal: ac.signal });
  const after = lock.run(async () => 'после');
  await new Promise((r) => setImmediate(r));
  ac.abort();
  const stopped = await waiting;
  assert.equal(stopped.data.stopped, true);
  release();
  await held;
  assert.equal(await after, 'после');
  assert.equal(ran, false);
  assert.equal(lock.busy, false);
});

test('ошибка действия освобождает стол', async () => {
  const lock = new DesktopLock();
  await assert.rejects(lock.run(async () => { throw new Error('сбой'); }));
  assert.equal(lock.busy, false);
});

test('отменённая фоновая задача не выполняется даже после получения стола', async () => {
  // Уже отменённый сигнал: до очереди дело не доходит.
  const aborted = new AbortController();
  aborted.abort();
  let ran = false;
  const one = new DesktopLock();
  const early = await one.run(async () => { ran = true; }, { background: true, signal: aborted.signal });
  assert.equal(early.data.stopped, true);
  assert.equal(ran, false);
  assert.equal(one.busy, false);
  // Стоп пришёл, пока задача получала стол: проверка после _acquire обязательна и для фона.
  let reads = 0;
  const signal = { get aborted() { reads += 1; return reads > 1; }, addEventListener() {}, removeEventListener() {} };
  const two = new DesktopLock();
  const late = await two.run(async () => { ran = true; }, { background: true, signal });
  assert.equal(late.data.stopped, true);
  assert.equal(ran, false);
  assert.equal(two.busy, false, 'стол освобождён после остановки');
});

test('замок надет только на руки, verify и ctx сохранены', async () => {
  const lock = new DesktopLock();
  lock.setLocked(true);
  const seen = [];
  const [click, read] = guardDesktopTools([
    tool('ui_click', async (a, ctx) => { seen.push(ctx); return { ok: true }; }),
    tool('ui_elements', async () => ({ ok: true })),
  ], lock);
  assert.equal((await click.run({}, {})).data.state, BLOCKED_DESKTOP);
  assert.equal((await read.run({}, {})).ok, true);
  assert.equal(typeof click.verify, 'function');
  lock.setLocked(false);
  await click.run({}, { background: false });
  assert.equal(seen[0].background, false);
});

test('составные руки desktop_click и desktop_type тоже под замком и Esc, а снимок — нет', async () => {
  const lock = new DesktopLock();
  lock.setLocked(true);
  const seen = [];
  const onAction = [];
  lock.onAction = (name) => { onAction.push(name); return null; };
  const [click, type, observe, elements] = guardDesktopTools([
    tool('desktop_click', async () => { seen.push('click'); return { ok: true }; }),
    tool('desktop_type', async () => { seen.push('type'); return { ok: true }; }),
    tool('desktop_observe', async () => { seen.push('observe'); return { ok: true }; }),
    tool('ui_elements', async () => { seen.push('elements'); return { ok: true }; }),
  ], lock);
  for (const tool of [click, type]) {
    const r = await tool.run({}, {});
    assert.equal(r.ok, false, `${tool.name} должен быть остановлен замком`);
    assert.equal(r.data.state, BLOCKED_DESKTOP);
  }
  assert.deepEqual(seen, [], 'на заблокированном экране руки не выполнялись');
  // Чтение сцены на заблокированном экране остаётся доступным.
  assert.equal((await observe.run({}, {})).ok, true);
  assert.equal((await elements.run({}, {})).ok, true);
  lock.setLocked(false);
  await click.run({}, { background: false });
  await type.run({}, { background: false });
  assert.deepEqual(seen, ['observe', 'elements', 'click', 'type']);
  // Хук Esc получает оба составных действия: иначе Esc не взведётся на новом пути.
  assert.ok(onAction.includes('desktop_click') && onAction.includes('desktop_type'), `хук Esc: ${onAction.join(', ')}`);
});

test('защита окон Electron: запрет window.open, блокировка внешней навигации и предохранитель цикла падений', () => {
  const { describeDeniedUrl, createWindowOpenHandler, createCrashLoopGuard, attachWindowGuards } = require('../src/control/stop');

  assert.equal(describeDeniedUrl('https://evil.example/secret?token=123#frag'), 'https://evil.example/secret');
  assert.equal(describeDeniedUrl('javascript:alert(1)'), 'javascript:');
  assert.equal(describeDeniedUrl('not a url'), '<invalid-url>');

  const logs = [];
  const openHandler = createWindowOpenHandler((msg) => logs.push(msg));
  assert.deepEqual(openHandler({ url: 'https://example.com/a?b=1' }), { action: 'deny' });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('https://example.com/a'));
  assert.ok(!logs[0].includes('b=1'), 'query-параметры не должны попадать в лог');

  // Предохранитель цикла падений: не более 3 перезагрузок за 60 секунд
  let now = 1000;
  const guard = createCrashLoopGuard({ maxCrashes: 3, windowMs: 60000, now: () => now });
  assert.equal(guard.shouldReload('crashed'), true);
  now += 1000;
  assert.equal(guard.shouldReload('oom'), true);
  now += 1000;
  assert.equal(guard.shouldReload('crashed'), true);
  now += 1000;
  assert.equal(guard.shouldReload('crashed'), false, '4-е падение подряд в окне 60 с блокируется');
  assert.equal(guard.shouldReload('clean-exit'), false, 'обычный выход не перезагружает окно');
  now += 61000;
  assert.equal(guard.shouldReload('crashed'), true, 'после истечения окна 60 с счётчик сбрасывается');

  // Подключение к BrowserWindow
  const handlers = {};
  let reloaded = 0;
  const fakeWin = {
    isDestroyed: () => false,
    webContents: {
      setWindowOpenHandler: (fn) => { handlers.windowOpen = fn; },
      on: (event, fn) => { handlers[event] = fn; },
      reload: () => { reloaded += 1; },
    },
  };
  attachWindowGuards(fakeWin, { log: (m) => logs.push(m) });
  assert.deepEqual(handlers.windowOpen({ url: 'https://evil.example/' }), { action: 'deny' });

  let prevented = false;
  handlers['will-navigate']({ preventDefault: () => { prevented = true; } }, 'https://evil.example/phish');
  assert.equal(prevented, true, 'внешняя навигация блокируется');

  let filePrevented = false;
  handlers['will-navigate']({ preventDefault: () => { filePrevented = true; } }, 'file:///D:/nox-release/renderer/index.html');
  assert.equal(filePrevented, false, 'локальный file:// разрешён');

  handlers['render-process-gone']({}, { reason: 'crashed', exitCode: 1 });
  assert.equal(reloaded, 1, 'первое падение перезагружает окно');
});

