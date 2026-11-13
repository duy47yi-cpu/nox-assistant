import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createController } from '../../../apps/nox-browser-extension/background-core.mjs';
import { GRANT_TTL_MS } from '../../../apps/nox-browser-extension/messages.mjs';

const load = createRequire(new URL('../../../apps/nox-browser-bridge/package.json', import.meta.url));
const { createBridge } = load('./bridge.js');
const WebSocket = load('ws');
const { connectBridge } = await import('../../../apps/nox-browser-extension/client.mjs');

const ORIGIN = 'chrome-extension://' + 'a'.repeat(32);

class BrowserSocket extends WebSocket {
  constructor(url) {
    super(url, { origin: ORIGIN });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label = 'condition', ms = 2000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > ms) throw new Error(`waitFor timeout: ${label}`);
    await new Promise(r => setTimeout(r, 1));
  }
}

function fakeClock(start = Date.now()) {
  let now = start;
  let nextId = 0;
  const jobs = new Map();
  return {
    now: () => now,
    setTimeout: (fn, delay) => {
      const id = ++nextId;
      jobs.set(id, { fn, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimeout: id => jobs.delete(id),
    advance: ms => { now += ms; },
    jobs,
  };
}

function makeFixture({ clock, connect, grantTtlMs, tab } = {}) {
  const state = {
    tab: tab || { id: 1, url: 'https://example.test/doc', active: true, windowId: 10 },
    activeId: 1,
    executeMode: 'now',
    gate: null,
    title: 'Title',
    text: 'Body',
    executeCalls: 0,
    queryCalls: 0,
    getCalls: 0,
    getThrows: false,
  };
  const api = {
    tabs: {
      query: async filter => {
        state.queryCalls += 1;
        const id = state.activeId;
        if (id === state.tab.id) return [{ id, url: state.tab.url, active: true, windowId: state.tab.windowId }];
        return [{ id, url: 'https://other.test/', active: true, windowId: state.tab.windowId }];
      },
      get: async id => {
        state.getCalls += 1;
        if (state.getThrows || id !== state.tab.id) throw new Error('missing');
        return { ...state.tab };
      },
    },
    scripting: {
      executeScript: async () => {
        state.executeCalls += 1;
        if (state.executeMode === 'throw') throw new Error('denied');
        if (state.executeMode === 'defer') return state.gate.promise;
        return [{ result: { title: state.title, text: state.text } }];
      },
    },
  };
  const controller = createController({
    api,
    origin: ORIGIN,
    ...(clock ? { clock } : {}),
    ...(connect ? { connect } : {}),
    ...(grantTtlMs ? { grantTtlMs } : {}),
  });
  return { state, api, controller };
}

async function grant(controller) {
  const result = await controller.handle({ type: 'read-current' });
  assert.equal(result.access, 'granted', `grant failed: ${JSON.stringify(result)}`);
  return result;
}

test('CT-01 no grant means no read and no script execution', async () => {
  const { state, controller } = makeFixture();
  assert.deepEqual(await controller.readGranted(), { ok: false, error: 'permission_required' });
  assert.equal(state.executeCalls, 0);
  const status = await controller.handle({ type: 'status' });
  assert.equal(status.access, 'revoked');
});

test('CT-02 grant is one-time and tied to the tab/origin; status never exposes text', async () => {
  const { state, controller } = makeFixture();
  const preview = await grant(controller);
  assert.equal(preview.text, 'Body');
  const first = await controller.readGranted();
  assert.deepEqual(first, {
    ok: true,
    origin: 'https://example.test',
    title: 'Title',
    text: 'Body',
    truncated: false,
  });
  assert.deepEqual(await controller.readGranted(), { ok: false, error: 'permission_required' });
  assert.equal(state.executeCalls, 2); // one preview click + one granted read
  const status = await controller.handle({ type: 'status' });
  assert.deepEqual(Object.keys(status).sort(), ['access', 'accessError', 'connection', 'error', 'grantExpires', 'origin']);
  assert.equal(JSON.stringify(status).includes('Body'), false);
});

test('CT-03 remote request cannot select tabId or mint consent; forbidden request keeps the grant', async () => {
  const { state, controller } = makeFixture();
  await grant(controller);
  assert.deepEqual(await controller.readGranted({ tabId: 2 }), { ok: false, error: 'tab_selection_forbidden' });
  assert.deepEqual(await controller.readGranted({ grant: true }), { ok: false, error: 'tab_selection_forbidden' });
  assert.equal(state.executeCalls, 1);
  assert.equal((await controller.handle({ type: 'status' })).access, 'granted');
  const okRead = await controller.readGranted();
  assert.equal(okRead.ok, true);
});

test('CT-04 concurrent reads execute at most once', async () => {
  const { state, controller } = makeFixture();
  await grant(controller);
  state.executeMode = 'defer';
  state.gate = deferred();
  const first = controller.readGranted();
  await waitFor(() => state.executeCalls === 2, 'execute started');
  const second = await controller.readGranted();
  assert.deepEqual(second, { ok: false, error: 'permission_required' });
  state.gate.resolve([{ result: { title: 'T', text: 'S' } }]);
  const res = await first;
  assert.equal(res.ok, true);
  assert.equal(state.executeCalls, 2);
});

test('CT-05 revoke during executeScript discards the text', async () => {
  const { state, controller } = makeFixture();
  await grant(controller);
  state.executeMode = 'defer';
  state.gate = deferred();
  const pending = controller.readGranted();
  await waitFor(() => state.executeCalls === 2, 'execute started');
  await controller.handle({ type: 'revoke' });
  state.gate.resolve([{ result: { title: 'T', text: 'SECRET' } }]);
  const res = await pending;
  assert.deepEqual(res, { ok: false, error: 'revoked' });
  assert.equal(JSON.stringify(res).includes('SECRET'), false);
});

test('CT-06 origin change, tab switch and tab closure during executeScript discard the text', async () => {
  {
    const { state, controller } = makeFixture();
    await grant(controller);
    state.executeMode = 'defer';
    state.gate = deferred();
    const pending = controller.readGranted();
    await waitFor(() => state.executeCalls === 2, 'origin execute');
    state.tab.url = 'https://evil.test/';
    state.gate.resolve([{ result: { title: 'T', text: 'SECRET' } }]);
    assert.deepEqual(await pending, { ok: false, error: 'origin_changed' });
  }
  {
    const { state, controller } = makeFixture();
    await grant(controller);
    state.executeMode = 'defer';
    state.gate = deferred();
    const pending = controller.readGranted();
    await waitFor(() => state.executeCalls === 2, 'switch execute');
    state.tab.active = false;
    state.activeId = 2;
    state.gate.resolve([{ result: { title: 'T', text: 'SECRET' } }]);
    assert.deepEqual(await pending, { ok: false, error: 'tab_changed' });
  }
  {
    const { state, controller } = makeFixture();
    await grant(controller);
    state.executeMode = 'defer';
    state.gate = deferred();
    const pending = controller.readGranted();
    await waitFor(() => state.executeCalls === 2, 'close execute');
    state.getThrows = true;
    state.gate.resolve([{ result: { title: 'T', text: 'SECRET' } }]);
    assert.deepEqual(await pending, { ok: false, error: 'tab_closed' });
  }
});

test('CT-07 grant expiry during executeScript discards the text', async () => {
  const clock = fakeClock(Date.now());
  const { state, controller } = makeFixture({ clock });
  await grant(controller);
  state.executeMode = 'defer';
  state.gate = deferred();
  const pending = controller.readGranted();
  await waitFor(() => state.executeCalls === 2, 'expiry execute');
  clock.advance(GRANT_TTL_MS);
  state.gate.resolve([{ result: { title: 'T', text: 'SECRET' } }]);
  assert.deepEqual(await pending, { ok: false, error: 'grant_expired' });
});

test('CT-08 popup read rejects mid-execute revoke/origin change and never returns text', async () => {
  {
    const { state, controller } = makeFixture();
    state.executeMode = 'defer';
    state.gate = deferred();
    const pending = controller.handle({ type: 'read-current' });
    await waitFor(() => state.executeCalls === 1, 'popup execute');
    await controller.handle({ type: 'revoke' });
    state.gate.resolve([{ result: { title: 'T', text: 'SECRET' } }]);
    const res = await pending;
    assert.equal(res.access, 'revoked');
    assert.equal(Object.hasOwn(res, 'text'), false);
  }
  {
    const { state, controller } = makeFixture();
    state.executeMode = 'defer';
    state.gate = deferred();
    const pending = controller.handle({ type: 'read-current' });
    await waitFor(() => state.executeCalls === 1, 'popup origin execute');
    state.tab.url = 'https://evil.test/';
    state.gate.resolve([{ result: { title: 'T', text: 'SECRET' } }]);
    const res = await pending;
    assert.equal(res.access, 'revoked');
    assert.equal(Object.hasOwn(res, 'text'), false);
  }
});

test('CT-09 unsupported schemes, denied scripting and detached grants fail closed', async () => {
  {
    const { state, controller } = makeFixture({ tab: { id: 1, url: 'file:///c:/secret.txt', active: true, windowId: 10 } });
    const res = await controller.handle({ type: 'read-current' });
    assert.equal(res.access, 'revoked');
    assert.equal(Object.hasOwn(res, 'text'), false);
    assert.equal(state.executeCalls, 0);
  }
  {
    const { state, controller } = makeFixture();
    state.executeMode = 'throw';
    const res = await controller.handle({ type: 'read-current' });
    assert.equal(res.access, 'revoked');
    assert.equal(state.executeCalls, 1);
  }
  {
    const clock = fakeClock(Date.now());
    const { controller } = makeFixture({ clock });
    await grant(controller);
    clock.advance(GRANT_TTL_MS);
    assert.deepEqual(await controller.readGranted(), { ok: false, error: 'grant_expired' });
    const status = await controller.handle({ type: 'status' });
    assert.equal(status.access, 'revoked');
  }
});

test('CT-10 large Russian text, titles and frame caps are respected', async () => {
  const { state, controller } = makeFixture();
  state.title = 'З'.repeat(400); // 800 bytes > 512
  state.text = 'Я'.repeat(30000); // 60 000 bytes > 49 152
  const res = await controller.handle({ type: 'read-current' });
  assert.equal(res.access, 'granted');
  assert.ok(Buffer.byteLength(res.title, 'utf8') <= 512);
  assert.ok(Buffer.byteLength(res.text, 'utf8') <= 49152);
  assert.equal(res.truncated, true);
  assert.equal('Я'.repeat(30000).startsWith(res.text), true);

  state.title = 'T';
  state.text = '"'.repeat(48000);
  const res2 = await controller.handle({ type: 'read-current' });
  assert.equal(res2.access, 'granted');
  assert.ok(Buffer.byteLength(res2.text, 'utf8') <= 49152);
  assert.equal('"'.repeat(48000).startsWith(res2.text), true);
});

test('CT-11 service-worker restart and popup close semantics', async () => {
  const { controller } = makeFixture();
  await grant(controller);
  // No popup lifecycle exists in the worker: closing the popup does not revoke the armed grant.
  assert.equal((await controller.handle({ type: 'status' })).access, 'granted');
  assert.equal((await controller.readGranted()).ok, true);

  // A fresh worker state (restart) has neither connection nor grant.
  const restarted = makeFixture().controller;
  const status = await restarted.handle({ type: 'status' });
  assert.equal(status.connection, 'disconnected');
  assert.equal(status.access, 'revoked');
  assert.deepEqual(await restarted.readGranted(), { ok: false, error: 'permission_required' });
});

test('CT-12 navigation/tab events revoke and abort; unrelated tab events do not', async () => {
  const { controller } = makeFixture();
  await grant(controller);
  controller.updated(99, { status: 'loading', url: 'https://other.test/' });
  assert.equal((await controller.handle({ type: 'status' })).access, 'granted');
  controller.updated(1, { status: 'loading' });
  assert.equal((await controller.handle({ type: 'status' })).access, 'revoked');

  await grant(controller);
  controller.updated(1, { url: 'https://example.test/other-path' });
  assert.equal((await controller.handle({ type: 'status' })).access, 'granted'); // same origin
  controller.updated(1, { url: 'https://evil.test/' });
  assert.equal((await controller.handle({ type: 'status' })).access, 'revoked');

  await grant(controller);
  controller.deactivate();
  assert.equal((await controller.handle({ type: 'status' })).access, 'revoked');
  await grant(controller);
  controller.removed(1);
  assert.equal((await controller.handle({ type: 'status' })).access, 'revoked');

  // TTL is capped.
  assert.throws(() => createController({ api: {}, origin: ORIGIN, grantTtlMs: GRANT_TTL_MS + 1 }), RangeError);
});

test('CT-13 timers are cleared on disconnect (resource leak probe)', async () => {
  const clock = fakeClock(Date.now());
  const stubConnect = async () => ({ ping: async () => {}, close: () => {} });
  const { controller } = makeFixture({ clock, connect: stubConnect });
  await controller.handle({ type: 'pair', port: 1, pairing: { expires: clock.now() + 60000 } });
  assert.equal(clock.jobs.size, 2); // session expiry + heartbeat
  await grant(controller);
  assert.equal(clock.jobs.size, 3); // + grant TTL
  await controller.readGranted();
  assert.equal(clock.jobs.size, 2); // grant timer cleared on consumption
  await controller.handle({ type: 'disconnect' });
  assert.equal(clock.jobs.size, 0);
});

test('CT-14 E2E over the real bridge: consent, single use, revoke, reconnect', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  const port = await bridge.listen();
  const { state, api } = makeFixture();
  const controller = createController({
    api,
    origin: ORIGIN,
    connect: opts => connectBridge({ ...opts, WebSocketClass: BrowserSocket }),
  });
  try {
    const pairing = bridge.pair();
    const paired = await controller.handle({ type: 'pair', port, pairing });
    assert.equal(paired.connection, 'connected');

    assert.deepEqual(await bridge.readPage(), { ok: false, error: 'permission_required' });
    assert.equal((await controller.handle({ type: 'status' })).access, 'revoked');

    const preview = await controller.handle({ type: 'read-current' });
    assert.equal(preview.access, 'granted');
    assert.equal(preview.text, 'Body');

    assert.deepEqual(await bridge.readPage(), {
      ok: true,
      origin: 'https://example.test',
      title: 'Title',
      text: 'Body',
      truncated: false,
    });
    assert.deepEqual(await bridge.readPage(), { ok: false, error: 'permission_required' });

    await grant(controller);
    bridge.revoke(pairing.id);
    await waitFor(async () => (await controller.handle({ type: 'status' })).connection === 'disconnected', 'bridge revoke');
    const afterRevoke = await controller.handle({ type: 'status' });
    assert.equal(afterRevoke.access, 'revoked');
    await assert.rejects(bridge.readPage(), /no active session/);

    // Reconnect requires a brand-new pairing, after which the flow works again.
    const pairing2 = bridge.pair();
    assert.equal((await controller.handle({ type: 'pair', port, pairing: pairing2 })).connection, 'connected');
    assert.deepEqual(await bridge.readPage(), { ok: false, error: 'permission_required' });
    await grant(controller);
    const again = await bridge.readPage();
    assert.equal(again.ok, true);
    assert.equal(again.text, 'Body');
    assert.equal(state.executeCalls, 5);
  } finally {
    await controller.handle({ type: 'disconnect' });
    await bridge.close();
  }
});

test('CT-15 E2E: origin change mid-read and mid-read revoke are refused by the bridge caller', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  const port = await bridge.listen();
  const { state, api } = makeFixture();
  const controller = createController({
    api,
    origin: ORIGIN,
    connect: opts => connectBridge({ ...opts, WebSocketClass: BrowserSocket }),
  });
  try {
    await controller.handle({ type: 'pair', port, pairing: bridge.pair() });
    await grant(controller);
    state.executeMode = 'defer';
    state.gate = deferred();
    const pending = bridge.readPage({ timeoutMs: 5000 });
    await waitFor(() => state.executeCalls === 2, 'e2e origin execute');
    state.tab.url = 'https://evil.test/';
    state.gate.resolve([{ result: { title: 'T', text: 'SECRET' } }]);
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'origin_changed');
    assert.equal(Object.hasOwn(res, 'text'), false);

    await grant(controller);
    state.executeMode = 'defer';
    state.gate = deferred();
    const pending2 = bridge.readPage({ timeoutMs: 5000 });
    await waitFor(() => state.executeCalls === 4, 'e2e revoke execute');
    await controller.handle({ type: 'revoke' });
    state.gate.resolve([{ result: { title: 'T', text: 'SECRET' } }]);
    const res2 = await pending2;
    assert.equal(res2.ok, false);
    assert.equal(res2.error, 'revoked');
  } finally {
    await controller.handle({ type: 'disconnect' });
    await bridge.close();
  }
});

test('CT-16 E2E: large Russian text, JSON escaping and control characters round-trip or truncate honestly', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  const port = await bridge.listen();
  const { state, api } = makeFixture();
  const controller = createController({
    api,
    origin: ORIGIN,
    connect: opts => connectBridge({ ...opts, WebSocketClass: BrowserSocket }),
  });
  try {
    await controller.handle({ type: 'pair', port, pairing: bridge.pair() });

    state.text = 'Я'.repeat(30000);
    await grant(controller);
    const russian = await bridge.readPage();
    assert.equal(russian.ok, true);
    assert.equal(russian.truncated, true);
    assert.ok(Buffer.byteLength(russian.text, 'utf8') <= 49152);
    assert.equal('Я'.repeat(30000).startsWith(russian.text), true);

    state.text = 'A\u0000B\nC\tD\u001fE';
    await grant(controller);
    const controls = await bridge.readPage();
    assert.equal(controls.ok, true);
    assert.equal(controls.text, 'A\u0000B\nC\tD\u001fE');

    state.text = '"'.repeat(48000);
    await grant(controller);
    const quotes = await bridge.readPage();
    assert.equal(quotes.ok, true);
    assert.equal(quotes.truncated, true);
    assert.ok(Buffer.byteLength(quotes.text, 'utf8') < 65536);
    assert.equal('"'.repeat(48000).startsWith(quotes.text), true);
  } finally {
    await controller.handle({ type: 'disconnect' });
    await bridge.close();
  }
});

test('CT-17 E2E: bridge session TTL expiry revokes access and disconnects', async () => {
  const bridge = createBridge({ origin: ORIGIN, sessionTtlMs: 80 });
  const port = await bridge.listen();
  const { api } = makeFixture();
  const controller = createController({
    api,
    origin: ORIGIN,
    connect: opts => connectBridge({ ...opts, WebSocketClass: BrowserSocket }),
  });
  try {
    await controller.handle({ type: 'pair', port, pairing: bridge.pair(1000) });
    await grant(controller);
    await new Promise(r => setTimeout(r, 200));
    const status = await controller.handle({ type: 'status' });
    assert.equal(status.connection, 'disconnected');
    assert.equal(status.access, 'revoked');
    await assert.rejects(bridge.readPage(), /no active session/);
  } finally {
    await bridge.close();
  }
});
