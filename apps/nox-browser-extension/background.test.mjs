import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from './background-core.mjs';
import { GRANT_TTL_MS, SNAPSHOT_TRANSPORT_ENABLED } from './messages.mjs';

const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fixture() {
  let tab = { id: 1, url: 'https://example.test/a', active: true, windowId: 10 };
  let denied = false;
  let closed = false;
  let onClose;
  let onReadRequest;
  const api = {
    tabs: {
      query: async () => [tab],
      get: async id => {
        if (id !== tab.id) throw Error('missing');
        return tab;
      },
    },
    scripting: {
      executeScript: async () => {
        if (denied) throw Error('denied');
        return [{ result: { title: 'Title', text: 'visible' } }];
      },
    },
  };
  const connect = async options => {
    onClose = options.onClose;
    onReadRequest = options.onReadRequest;
    return { ping: async () => {}, close: () => { closed = true; } };
  };
  return {
    controller: createController({ api, connect, origin }),
    deny: () => { denied = true; },
    change: t => { tab = t; },
    closed: () => closed,
    drop: () => onClose(),
    requestRead: req => onReadRequest(req),
  };
}

test('worker pairs, survives popup status queries, handles disconnect and restart (P1.10)', async () => {
  const f = fixture();
  const c = f.controller;
  assert.equal((await c.handle({ type: 'status' })).connection, 'disconnected');
  assert.equal((await c.handle({ type: 'pair', port: 1, pairing: { expires: Date.now() + 10000 } })).connection, 'connected');
  assert.equal((await c.handle({ type: 'status' })).connection, 'connected');
  f.drop();
  assert.equal((await c.handle({ type: 'status' })).connection, 'disconnected');
  await c.handle({ type: 'pair', port: 1, pairing: { expires: Date.now() + 10000 } });
  await c.handle({ type: 'disconnect' });
  assert.ok(f.closed());

  // Fresh controller after worker restart never restores connection or tab grant.
  await c.handle({ type: 'read-current' });
  const restarted = fixture().controller;
  assert.equal((await restarted.handle({ type: 'status' })).connection, 'disconnected');
  assert.equal((await restarted.handle({ type: 'status' })).access, 'revoked');
  assert.deepEqual(await restarted.readGranted(), { ok: false, error: 'permission_required' });
});

test('P0.1/P0.2/P0.6/P0.7: read() and readGranted() are separated; read_request never creates grant or picks tabId', async () => {
  const f = fixture();
  const c = f.controller;

  // Without clicking "Разрешить и прочитать", readGranted() is denied and creates no grant.
  assert.deepEqual(await c.readGranted(), { ok: false, error: 'permission_required' });
  assert.equal((await c.handle({ type: 'status' })).access, 'revoked');

  // Remote read_request via popup/unknown channel is refused.
  assert.equal((await c.handle({ type: 'read_request' })).error, 'Действие недоступно');
  assert.equal((await c.handle({ type: 'snapshot.response' })).error, 'Действие недоступно');
  assert.equal(SNAPSHOT_TRANSPORT_ENABLED, false);

  // Remote request attempting to specify tabId or grant is refused even if a grant exists.
  await c.handle({ type: 'read-current' });
  assert.deepEqual(await c.readGranted({ tabId: 2 }), { ok: false, error: 'tab_selection_forbidden' });
  assert.deepEqual(await c.readGranted({ grant: true }), { ok: false, error: 'tab_selection_forbidden' });
});

test('P0.3/P0.4: grant is bound to tabId, origin, <= 60s lifetime, and is one-time', async () => {
  assert.throws(() => createController({ api: {}, origin, grantTtlMs: GRANT_TTL_MS + 1 }), RangeError);

  let now = 1000;
  let nextId = 1;
  const jobs = new Map();
  const clock = {
    now: () => now,
    setTimeout: (fn, delay) => {
      const id = nextId++;
      jobs.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: id => jobs.delete(id),
  };

  let tab = { id: 1, url: 'https://example.test/page', active: true, windowId: 5 };
  let scriptCalls = 0;
  const api = {
    tabs: {
      query: async () => [tab],
      get: async id => {
        if (id !== tab.id) throw Error('closed');
        return tab;
      },
    },
    scripting: {
      executeScript: async () => {
        scriptCalls += 1;
        return [{ result: { title: 'Test', text: 'visible' } }];
      },
    },
  };

  const c = createController({ api, origin, clock });

  // Owner grants once via read-current.
  const granted = await c.handle({ type: 'read-current' });
  assert.equal(granted.access, 'granted');
  assert.equal(granted.grantExpires, 1000 + GRANT_TTL_MS);
  assert.equal(granted.text, 'visible');

  // First readGranted() succeeds and consumes the one-time grant.
  const first = await c.readGranted();
  assert.deepEqual(first, {
    ok: true,
    origin: 'https://example.test',
    title: 'Test',
    text: 'visible',
    truncated: false,
  });
  assert.equal((await c.handle({ type: 'status' })).access, 'revoked');

  // Second readGranted() is refused until owner grants again.
  const second = await c.readGranted();
  assert.deepEqual(second, { ok: false, error: 'permission_required' });
  assert.equal(scriptCalls, 2);

  // Expiry after 60s revokes grant and refuses readGranted().
  await c.handle({ type: 'read-current' });
  now = 1000 + GRANT_TTL_MS;
  assert.deepEqual(await c.readGranted(), { ok: false, error: 'grant_expired' });
  assert.equal((await c.handle({ type: 'status' })).access, 'revoked');
});

test('P0.5: grant is revoked on navigation, origin change, tab switch, closure, failed browser permission, or mid-read change', async () => {
  const f = fixture();
  const c = f.controller;
  assert.equal((await c.handle({ type: 'read-current' })).text, 'visible');

  // Unrelated tab update does NOT revoke active grant on tab 1.
  c.updated(99, { status: 'loading', url: 'https://other.test/' });
  assert.equal((await c.handle({ type: 'status' })).access, 'granted');

  // Navigation on tab 1 revokes.
  c.updated(1, { status: 'loading' });
  assert.equal((await c.handle({ type: 'status' })).access, 'revoked');

  // Origin change on tab 1 revokes and readGranted refuses.
  await c.handle({ type: 'read-current' });
  f.change({ id: 1, url: 'https://evil.test/', active: true, windowId: 10 });
  assert.equal((await c.readGranted()).error, 'origin_changed');

  // Tab switch revokes even if onActivated was missed before readGranted check.
  f.change({ id: 1, url: 'https://example.test/a', active: true, windowId: 10 });
  await c.handle({ type: 'read-current' });
  f.change({ id: 2, url: 'https://example.test/b', active: true, windowId: 10 });
  assert.equal((await c.readGranted()).error, 'tab_closed');

  // Deactivate / remove / deny also revoke.
  f.change({ id: 1, url: 'https://example.test/a', active: true, windowId: 10 });
  await c.handle({ type: 'read-current' });
  c.deactivate();
  assert.equal((await c.handle({ type: 'status' })).access, 'revoked');

  await c.handle({ type: 'read-current' });
  c.removed(1);
  assert.equal((await c.handle({ type: 'status' })).access, 'revoked');

  f.deny();
  assert.equal((await c.handle({ type: 'read-current' })).access, 'revoked');
});

test('P0.5: mid-executeScript origin change discards extracted text and refuses', async () => {
  let tab = { id: 1, url: 'https://example.test/a', active: true, windowId: 10 };
  const api = {
    tabs: {
      query: async () => [tab],
      get: async () => tab,
    },
    scripting: {
      executeScript: async () => {
        // Simulate navigation right as script runs.
        tab = { id: 1, url: 'https://attacker.test/', active: true, windowId: 10 };
        return [{ result: { title: 'Secret', text: 'must not leak' } }];
      },
    },
  };
  const c = createController({ api, origin });
  // Even read() rejects mid-read change.
  assert.equal((await c.handle({ type: 'read-current' })).access, 'revoked');

  // Reset and grant cleanly, then mutate mid-readGranted().
  let navigateDuringGranted = false;
  tab = { id: 1, url: 'https://example.test/a', active: true, windowId: 10 };
  const api2 = {
    tabs: {
      query: async () => [tab],
      get: async () => tab,
    },
    scripting: {
      executeScript: async () => {
        if (navigateDuringGranted) {
          tab = { id: 1, url: 'https://attacker.test/', active: true, windowId: 10 };
        }
        return [{ result: { title: 'T', text: 'sensitive' } }];
      },
    },
  };
  const c2 = createController({ api: api2, origin });
  await c2.handle({ type: 'read-current' });
  navigateDuringGranted = true;
  const res = await c2.readGranted();
  assert.deepEqual(res, { ok: false, error: 'origin_changed' });
});

test('revoke clears access', async () => {
  const c = fixture().controller;
  await c.handle({ type: 'read-current' });
  assert.equal((await c.handle({ type: 'revoke' })).access, 'revoked');
});

test('P0/P1 end-to-end: controller pairs with real bridge, enforces consent, survives pairing expiry, and revokes', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../nox-browser-bridge/bridge.js', import.meta.url));
  const { createBridge } = require('./bridge');
  const WebSocket = require('ws');
  const { connectBridge } = await import('./client.mjs');

  const bridge = createBridge({ origin, sessionTtlMs: 10000 });
  const port = await bridge.listen();
  const pairing = bridge.pair(120); // Short pairing TTL (120ms), longer session (10s).
  class Socket extends WebSocket {
    constructor(url) {
      super(url, { origin });
    }
  }
  const tab = { id: 7, url: 'https://example.test/doc', active: true, windowId: 1 };
  const api = {
    tabs: {
      query: async () => [tab],
      get: async id => {
        if (id !== 7) throw Error('missing');
        return tab;
      },
    },
    scripting: {
      executeScript: async () => [{ result: { title: 'Doc', text: 'Approved content' } }],
    },
  };
  const c = createController({
    api,
    origin,
    connect: options => connectBridge({ ...options, WebSocketClass: Socket }),
  });

  try {
    assert.equal((await c.handle({ type: 'pair', port, pairing })).connection, 'connected');

    // Wait past pairing.expires (120ms): session must still be active!
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal((await c.handle({ type: 'status' })).connection, 'connected');

    // readPage before owner grants returns permission_required and creates no grant.
    assert.deepEqual(await bridge.readPage(), { ok: false, error: 'permission_required' });
    assert.equal((await c.handle({ type: 'status' })).access, 'revoked');

    // Owner explicitly clicks "Разрешить и прочитать".
    await c.handle({ type: 'read-current' });
    assert.equal((await c.handle({ type: 'status' })).access, 'granted');

    // First readPage succeeds once and consumes the grant.
    assert.deepEqual(await bridge.readPage(), {
      ok: true,
      origin: 'https://example.test',
      title: 'Doc',
      text: 'Approved content',
      truncated: false,
    });
    assert.equal((await c.handle({ type: 'status' })).access, 'revoked');

    // Second readPage without new user click is refused.
    assert.deepEqual(await bridge.readPage(), { ok: false, error: 'permission_required' });

    // Grant again, then revoke from bridge: disconnects and revokes grant immediately.
    await c.handle({ type: 'read-current' });
    bridge.revoke(pairing.id);
    await new Promise(resolve => setTimeout(resolve, 50));
    const st = await c.handle({ type: 'status' });
    assert.equal(st.connection, 'disconnected');
    assert.equal(st.access, 'revoked');
  } finally {
    await c.handle({ type: 'disconnect' });
    await bridge.close();
  }
});

test('idle heartbeat continues without popup and stops on failure without reconnecting', async () => {
  let now = 0;
  let next = 0;
  const jobs = new Map();
  let calls = 0;
  let attempts = 0;
  let closed = 0;
  let fail = false;
  const clock = {
    now: () => now,
    setTimeout: (fn, delay) => {
      const id = ++next;
      jobs.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: id => jobs.delete(id),
  };
  const advance = async ms => {
    const end = now + ms;
    while (true) {
      const item = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!item || item[1].at > end) break;
      jobs.delete(item[0]);
      now = item[1].at;
      await item[1].fn();
    }
    now = end;
  };
  const api = {
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.test/' }],
      get: async () => ({ url: 'https://example.test/' }),
    },
    scripting: { executeScript: async () => [{ result: { text: 'safe' } }] },
  };
  const c = createController({
    api,
    origin,
    clock,
    connect: async () => {
      attempts++;
      return {
        ping: async () => {
          calls++;
          if (fail) throw Error('lost');
        },
        close: () => {
          closed++;
        },
      };
    },
  });
  await c.handle({ type: 'pair', port: 1, pairing: { expires: 120000 } });
  await c.handle({ type: 'read-current' });
  await advance(61000);
  assert.equal(calls, 4);
  assert.equal((await c.handle({ type: 'status' })).connection, 'connected');
  fail = true;
  await advance(20000);
  const state = await c.handle({ type: 'status' });
  assert.equal(state.connection, 'error');
  assert.equal(state.access, 'revoked');
  assert.equal(closed, 1);
  await advance(50000);
  assert.equal(attempts, 1);
  assert.equal(calls, 5);
});

test('expiry terminates heartbeat and revokes grant', async () => {
  let now = 0;
  let id = 0;
  const jobs = new Map();
  let closed = 0;
  const clock = {
    now: () => now,
    setTimeout: (fn, delay) => {
      jobs.set(++id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: n => jobs.delete(n),
  };
  const c = createController({
    api: {
      tabs: {
        query: async () => [{ id: 1, url: 'http://localhost/' }],
        get: async () => ({ url: 'http://localhost/' }),
      },
      scripting: { executeScript: async () => [{ result: { text: 'x' } }] },
    },
    origin,
    clock,
    connect: async () => ({ ping: async () => {}, close: () => closed++ }),
  });
  await c.handle({ type: 'pair', port: 1, pairing: { expires: 1000 } });
  await c.handle({ type: 'read-current' });
  now = 1000;
  const expiry = [...jobs.values()].find(x => x.at === 1000);
  expiry.fn();
  assert.equal((await c.handle({ type: 'status' })).access, 'revoked');
  assert.equal(closed, 1);
  assert.equal(jobs.size, 0);
});

test('default timer functions are called with global receiver', async () => {
  const original = globalThis.clearTimeout;
  globalThis.clearTimeout = function (id) {
    assert.equal(this, globalThis);
    return original(id);
  };
  try {
    const c = createController({ api: {}, origin });
    assert.equal((await c.handle({ type: 'disconnect' })).connection, 'disconnected');
  } finally {
    globalThis.clearTimeout = original;
  }
});
