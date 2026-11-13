'use strict';
// Independent C5 re-audit probes. Does not modify or import-modified the audited sources.
// Run: node --test docs/audits/c5-rerun
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BRIDGE_DIR = path.join(ROOT, 'apps', 'nox-browser-bridge');
const load = createRequire(path.join(BRIDGE_DIR, 'package.json'));
const { createBridge } = load('./bridge.js');
const protocol = load('./protocol.js');
const WebSocket = load('ws');

const ORIGIN = 'chrome-extension://' + 'a'.repeat(32);
const { random, mac, equal } = protocol;

function connect(port, { origin = ORIGIN, omitOrigin = false, path: urlPath = '/nox' } = {}) {
  const options = {};
  if (!omitOrigin) options.origin = origin;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, options);
  ws.on('error', () => {});
  return ws;
}

function closeOf(ws) {
  return new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', resolve);
  });
}

function within(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
      t.unref?.();
    }),
  ]);
}

const next = ws => once(ws, 'message').then(([data]) => JSON.parse(data.toString('utf8')));

async function authenticate(ws, pair) {
  const challenge = await next(ws);
  assert.equal(challenge.type, 'challenge');
  const nonce = random();
  const answer = next(ws);
  ws.send(
    JSON.stringify({
      type: 'authenticate',
      id: pair.id,
      nonce,
      proof: mac(pair.secret, 'c2s', 'authenticate', ORIGIN, pair.id, challenge.challenge, nonce),
    }),
  );
  const result = await answer;
  assert.equal(result.type, 'authenticated');
  const sessionSecret = mac(
    pair.secret,
    'session-key',
    ORIGIN,
    pair.id,
    challenge.challenge,
    nonce,
    result.session,
    result.sessionExpires,
  );
  assert.ok(equal(result.proof, mac(pair.secret, 's2c', 'authenticated', ORIGIN, pair.id, challenge.challenge, nonce, result.session, result.sessionExpires)));
  return { session: result.session, sessionSecret, sessionExpires: result.sessionExpires };
}

async function openSession(bridge, { minAuth = true } = {}) {
  const port = await bridge.listen();
  const pair = bridge.pair();
  const ws = connect(port);
  const auth = minAuth ? await authenticate(ws, pair) : null;
  return { port, pair, ws, auth };
}

test('BR-01 upgrade: missing/foreign/malformed Origin, wrong path and oversized socket pool are refused', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  const port = await bridge.listen();
  const variants = [
    { omitOrigin: true }, // no Origin header at all (non-browser client)
    'https://example.com',
    'null',
    'chrome-extension://' + 'a'.repeat(31),
    'chrome-extension://' + 'a'.repeat(33),
    'chrome-extension://' + 'z'.repeat(32),
    'chrome-extension://' + 'A'.repeat(32),
    ORIGIN.toUpperCase(),
  ];
  for (const variant of variants) {
    const ws = typeof variant === 'string' ? connect(port, { origin: variant }) : connect(port, variant);
    await within(closeOf(ws), 2000, `close for origin ${JSON.stringify(variant)}`);
  }
  const wrongPath = connect(port, { path: '/nox/' });
  await within(closeOf(wrongPath), 2000, 'close for wrong path');

  // Control: the exact origin and path still works.
  const ok = connect(port);
  const challenge = await next(ok);
  assert.equal(challenge.type, 'challenge');
  ok.terminate();
  await bridge.close();
});

test('BR-02 upgrade pool is capped at 8 authenticated sockets', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  const port = await bridge.listen();
  const sockets = [];
  for (let i = 0; i < 8; i += 1) {
    const ws = connect(port);
    await authenticate(ws, bridge.pair());
    sockets.push(ws);
  }
  const ninth = connect(port);
  await within(closeOf(ninth), 2000, 'ninth socket');
  sockets.forEach(s => s.terminate());
  await bridge.close();
});

test('BR-03 HTTP handler leaks nothing and serves 404', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  const port = await bridge.listen();
  for (const reqPath of ['/', '/nox', '/health']) {
    const status = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: reqPath, headers: { Origin: ORIGIN } }, res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => resolve({ code: res.statusCode, body }));
      });
      req.on('error', reject);
    });
    assert.equal(status.code, 404);
    assert.equal(status.body, '');
  }
  await bridge.close();
});

test('BR-04 pairing: proof bound to origin, one-time use, expiry, 5-attempt lockout', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  const port = await bridge.listen();
  const pair = bridge.pair(5000);

  // Proof bound to another extension origin is rejected.
  {
    const ws = connect(port);
    const challenge = await next(ws);
    const nonce = random();
    const closed = closeOf(ws);
    ws.send(JSON.stringify({
      type: 'authenticate',
      id: pair.id,
      nonce,
      proof: mac(pair.secret, 'c2s', 'authenticate', 'chrome-extension://' + 'b'.repeat(32), pair.id, challenge.challenge, nonce),
    }));
    await within(closed, 2000, 'origin-bound proof');
  }
  // Pairing survives the failed attempt; a correct proof still works once.
  {
    const ws = connect(port);
    await authenticate(ws, pair);
    ws.terminate();
    await within(once(ws, 'close'), 2000, 'terminate');
  }
  // Replay is refused.
  {
    const ws = connect(port);
    const challenge = await next(ws);
    const nonce = random();
    const closed = closeOf(ws);
    ws.send(JSON.stringify({
      type: 'authenticate',
      id: pair.id,
      nonce,
      proof: mac(pair.secret, 'c2s', 'authenticate', ORIGIN, pair.id, challenge.challenge, nonce),
    }));
    await within(closed, 2000, 'pairing replay');
  }

  // Five bad proofs delete the pairing.
  const doomed = bridge.pair(5000);
  for (let i = 0; i < 5; i += 1) {
    const ws = connect(port);
    await next(ws);
    const closed = closeOf(ws);
    ws.send(JSON.stringify({ type: 'authenticate', id: doomed.id, nonce: random(), proof: random() }));
    await within(closed, 2000, `bad proof ${i}`);
  }
  {
    const ws = connect(port);
    const challenge = await next(ws);
    const nonce = random();
    const closed = closeOf(ws);
    ws.send(JSON.stringify({
      type: 'authenticate',
      id: doomed.id,
      nonce,
      proof: mac(doomed.secret, 'c2s', 'authenticate', ORIGIN, doomed.id, challenge.challenge, nonce),
    }));
    await within(closed, 2000, 'locked out pairing');
  }

  // Expired pairing is refused.
  const shortPair = bridge.pair(20);
  await new Promise(r => setTimeout(r, 40));
  {
    const ws = connect(port);
    const challenge = await next(ws);
    const nonce = random();
    const closed = closeOf(ws);
    ws.send(JSON.stringify({
      type: 'authenticate',
      id: shortPair.id,
      nonce,
      proof: mac(shortPair.secret, 'c2s', 'authenticate', ORIGIN, shortPair.id, challenge.challenge, nonce),
    }));
    await within(closed, 2000, 'expired pairing');
  }
  await bridge.close();
});

async function tamperCase(name, mutate) {
  const bridge = createBridge({ origin: ORIGIN });
  const { ws, auth } = await openSession(bridge);
  const pending = bridge.readPage({ timeoutMs: 2000 });
  const rejected = pending.then(
    value => ({ resolved: true, value }),
    error => ({ resolved: false, error }),
  );
  const request = await next(ws);
  assert.equal(request.type, 'read_request');
  const base = {
    type: 'read_result',
    seq: 1,
    requestId: request.requestId,
    ok: true,
    origin: 'https://example.test',
    title: 'Title',
    text: 'Body',
    truncated: false,
  };
  base.proof = mac(
    auth.sessionSecret,
    'c2s',
    'read_result',
    auth.session,
    base.seq,
    base.requestId,
    base.ok,
    base.origin,
    base.title,
    base.text,
    base.truncated,
  );
  const closed = closeOf(ws);
  ws.send(JSON.stringify(mutate(base, auth)));
  await within(closed, 3000, `close for ${name}`);
  const outcome = await rejected;
  assert.equal(outcome.resolved, false, `${name} must not resolve a read`);
  await bridge.close();
}

test('BR-05 read_result tampering without a valid MAC is refused (matrix)', async () => {
  const cases = {
    'text swapped': m => ({ ...m, text: 'tampered' }),
    'title swapped': m => ({ ...m, title: 'Evil' }),
    'origin swapped': m => ({ ...m, origin: 'https://evil.test' }),
    'truncated flipped': m => ({ ...m, truncated: true }),
    'seq bumped': m => ({ ...m, seq: 2 }),
    'requestId swapped': m => ({ ...m, requestId: random() }),
    'ok flipped to string': m => ({ ...m, ok: 'true' }),
    'extra field': m => ({ ...m, tabId: 7 }),
    'missing text': m => { const c = { ...m }; delete c.text; return c; },
    'text type': m => ({ ...m, text: 5 }),
    'origin with path': m => ({ ...m, origin: 'https://example.test/path' }),
    'non-canonical origin': m => ({ ...m, origin: 'https://example.test:443' }),
    'overlong title': m => ({ ...m, title: 'Я'.repeat(300) }),
    'overlong text': m => ({ ...m, text: 'A'.repeat(49153) }),
    'uppercase proof': m => ({ ...m, proof: m.proof.toUpperCase() }),
    'null proof': m => ({ ...m, proof: null }),
    'wrong direction signed': (m, auth) => ({
      ...m,
      proof: mac(auth.sessionSecret, 's2c', 'read_result', auth.session, m.seq, m.requestId, true, m.origin, m.title, m.text, m.truncated),
    }),
    'error proof on success frame': (m, auth) => ({
      ...m,
      proof: mac(auth.sessionSecret, 'c2s', 'read_result', auth.session, m.seq, m.requestId, false, 'denied'),
    }),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await tamperCase(name, mutate);
  }
  assert.equal(Object.prototype.origin, undefined);
});

test('BR-06 oversized title/text are refused even when correctly signed', async () => {
  await tamperCase('overlong title signed', (m, auth) => {
    const next = { ...m, title: 'Я'.repeat(300) };
    next.proof = mac(auth.sessionSecret, 'c2s', 'read_result', auth.session, next.seq, next.requestId, true, next.origin, next.title, next.text, next.truncated);
    return next;
  });
  await tamperCase('overlong text signed', (m, auth) => {
    const next = { ...m, text: 'A'.repeat(49153) };
    next.proof = mac(auth.sessionSecret, 'c2s', 'read_result', auth.session, next.seq, next.requestId, true, next.origin, next.title, next.text, next.truncated);
    return next;
  });
  await tamperCase('overlong error signed', (m, auth) => {
    const next = {
      type: 'read_result',
      seq: m.seq,
      requestId: m.requestId,
      ok: false,
      error: 'e'.repeat(129),
    };
    next.proof = mac(auth.sessionSecret, 'c2s', 'read_result', auth.session, next.seq, next.requestId, false, next.error);
    return next;
  });
});

test('BR-07 valid result is accepted once; a second read_result for a different request is refused', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  const { ws, auth } = await openSession(bridge);
  const pending = bridge.readPage({ timeoutMs: 2000 });
  const req = await next(ws);
  ws.send(JSON.stringify({
    type: 'read_result',
    seq: 1,
    requestId: req.requestId,
    ok: true,
    origin: 'https://example.test',
    title: 'T',
    text: 'hello',
    truncated: false,
    proof: mac(auth.sessionSecret, 'c2s', 'read_result', auth.session, 1, req.requestId, true, 'https://example.test', 'T', 'hello', false),
  }));
  assert.deepEqual(await pending, { ok: true, origin: 'https://example.test', title: 'T', text: 'hello', truncated: false });

  const second = bridge.readPage({ timeoutMs: 2000 });
  const rejected = assert.rejects(second);
  const req2 = await next(ws);
  const closed = closeOf(ws);
  // Re-send the first frame (valid old requestId, seq 1 again is now a replay).
  ws.send(JSON.stringify({
    type: 'read_result',
    seq: 1,
    requestId: req.requestId,
    ok: false,
    error: 'denied',
    proof: mac(auth.sessionSecret, 'c2s', 'read_result', auth.session, 1, req.requestId, false, 'denied'),
  }));
  await within(closed, 2000, 'replayed result');
  await rejected;
  assert.ok(req2);
  await bridge.close();
});

test('BR-08 a result signed for another session is refused', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  const port = await bridge.listen();
  const pairA = bridge.pair();
  const pairB = bridge.pair();
  const wsA = connect(port);
  const authA = await authenticate(wsA, pairA);
  const wsB = connect(port);
  const authB = await authenticate(wsB, pairB);

  const pending = bridge.readPage({ sessionId: authA.session, timeoutMs: 2000 });
  const rejected = pending.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
  const req = await next(wsA);
  const closed = closeOf(wsA);
  wsA.send(JSON.stringify({
    type: 'read_result',
    seq: 1,
    requestId: req.requestId,
    ok: true,
    origin: 'https://example.test',
    title: 'T',
    text: 'cross-session',
    truncated: false,
    proof: mac(authB.sessionSecret, 'c2s', 'read_result', authB.session, 1, req.requestId, true, 'https://example.test', 'T', 'cross-session', false),
  }));
  await within(closed, 2000, 'cross-session result');
  assert.equal((await rejected).ok, false);
  wsB.terminate();
  await bridge.close();
});

test('BR-09 server never accepts client-side request types or unknown messages', async () => {
  for (const message of [
    { type: 'read_request' },
    { type: 'pong', seq: 1, proof: random() },
    { type: 'challenge', version: 'nox-bridge-2', challenge: random() },
    { type: 'snapshot.response' },
  ]) {
    const bridge = createBridge({ origin: ORIGIN });
    const { ws, auth } = await openSession(bridge);
    const closed = closeOf(ws);
    ws.send(JSON.stringify(message));
    await within(closed, 2000, `unknown ${message.type}`);
    assert.ok(auth.session);
    await bridge.close();
  }
});

test('BR-10 malformed frames: binary, invalid JSON, array, oversized, rate limit', async () => {
  const variants = [
    ['binary', ws => ws.send(Buffer.from([1, 2, 3]), { binary: true })],
    ['invalid json', ws => ws.send('{not json')],
    ['json array', ws => ws.send('[]')],
    ['json null', ws => ws.send('null')],
    ['json string', ws => ws.send('"ping"')],
    ['oversized', ws => ws.send('x'.repeat(65537))],
    ['protocol violation', ws => ws.send(JSON.stringify({ type: 'ping', seq: 1, proof: 'x' }))],
  ];
  for (const [name, attack] of variants) {
    const bridge = createBridge({ origin: ORIGIN });
    const { ws } = await openSession(bridge);
    const closed = closeOf(ws);
    attack(ws);
    await within(closed, 3000, name);
    await bridge.close();
  }

  const bridge = createBridge({ origin: ORIGIN });
  const { ws, auth } = await openSession(bridge);
  const closed = closeOf(ws);
  for (let seq = 1; seq <= 30; seq += 1) {
    ws.send(JSON.stringify({ type: 'ping', seq, proof: mac(auth.sessionSecret, 'c2s', 'ping', auth.session, seq) }));
  }
  await within(closed, 3000, 'rate limit');
  await bridge.close();
});

test('BR-11 timeouts: slot is released; a late result kills the session (observed behaviour)', async () => {
  // A. Timeout without a late frame leaves the session usable.
  {
    const bridge = createBridge({ origin: ORIGIN });
    const { ws, auth } = await openSession(bridge);
    await assert.rejects(bridge.readPage({ timeoutMs: 40 }), /timed out/);
    const req1 = null; // first request id intentionally ignored
    assert.equal(req1, null);
    const pending = bridge.readPage({ timeoutMs: 2000 });
    const req = await next(ws);
    ws.send(JSON.stringify({
      type: 'read_result',
      seq: 1,
      requestId: req.requestId,
      ok: false,
      error: 'permission_required',
      proof: mac(auth.sessionSecret, 'c2s', 'read_result', auth.session, 1, req.requestId, false, 'permission_required'),
    }));
    assert.deepEqual(await pending, { ok: false, error: 'permission_required' });
    await bridge.close();
  }

  // B. A late result after the bridge timeout is treated as unexpected and terminates the session.
  {
    const bridge = createBridge({ origin: ORIGIN });
    const { ws, auth } = await openSession(bridge);
    const pending = bridge.readPage({ timeoutMs: 40 });
    const req = await next(ws);
    await assert.rejects(pending, /timed out/);
    const closed = closeOf(ws);
    ws.send(JSON.stringify({
      type: 'read_result',
      seq: 1,
      requestId: req.requestId,
      ok: true,
      origin: 'https://example.test',
      title: 'T',
      text: 'late',
      truncated: false,
      proof: mac(auth.sessionSecret, 'c2s', 'read_result', auth.session, 1, req.requestId, true, 'https://example.test', 'T', 'late', false),
    }));
    await within(closed, 2000, 'late result');
    await assert.rejects(bridge.readPage(), /no active session/);
    await bridge.close();
  }
});

test('BR-12 concurrency, revoke and close reject pending reads without leaking text', async () => {
  {
    const bridge = createBridge({ origin: ORIGIN });
    const { ws } = await openSession(bridge);
    const pending = bridge.readPage({ timeoutMs: 2000 });
    await next(ws);
    await assert.rejects(bridge.readPage({ timeoutMs: 2000 }), /already active/);
    const rejected = assert.rejects(pending, /revoked/);
    assert.equal(bridge.revoke((await bridge.listSessions())[0].id), true);
    await rejected;
    await within(closeOf(ws), 2000, 'revoke close');
    await bridge.close();
  }
  {
    const bridge = createBridge({ origin: ORIGIN });
    const { ws } = await openSession(bridge);
    const pending = bridge.readPage({ timeoutMs: 2000 });
    await next(ws);
    const rejected = assert.rejects(pending, /bridge closed/);
    await bridge.close();
    await rejected;
    assert.ok(ws.readyState !== 1);
  }
});

test('BR-13 session TTL and idle handshake timeout close sockets', async () => {
  // Session TTL (real timer).
  {
    const bridge = createBridge({ origin: ORIGIN, sessionTtlMs: 60 });
    const { ws } = await openSession(bridge);
    await within(closeOf(ws), 2000, 'session ttl');
    await assert.rejects(bridge.readPage(), /no active session/);
    await bridge.close();
  }
  // Handshake must complete within 5 s.
  {
    const bridge = createBridge({ origin: ORIGIN });
    const port = await bridge.listen();
    const ws = connect(port);
    await next(ws);
    const started = Date.now();
    await within(closeOf(ws), 7000, 'handshake timeout');
    assert.ok(Date.now() - started >= 4500 && Date.now() - started < 7000);
    await bridge.close();
  }
});

test('BR-14 API misuse is rejected; sessions expose no secrets', async () => {
  assert.throws(() => createBridge({ origin: 'chrome-extension://short' }), TypeError);
  assert.throws(() => createBridge({ origin: ORIGIN, sessionTtlMs: 3600001 }), RangeError);
  assert.throws(() => createBridge({ origin: ORIGIN, maxPayload: 65537 }), RangeError);

  const bridge = createBridge({ origin: ORIGIN });
  assert.throws(() => bridge.pair(0), RangeError);
  await assert.rejects(bridge.readPage({ timeoutMs: 0 }), RangeError);
  await assert.rejects(bridge.readPage({ timeoutMs: 30001 }), RangeError);
  await assert.rejects(bridge.readPage({ timeoutMs: 1.5 }), RangeError);
  await assert.rejects(bridge.readPage(), /no active session/);
  await assert.rejects(bridge.readPage({ sessionId: random() }), /no active session/);

  const { auth } = await openSession(bridge);
  const sessions = bridge.listSessions();
  assert.equal(sessions.length, 1);
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['expires', 'id', 'pairingId']);
  assert.equal(JSON.stringify(sessions).includes(auth.sessionSecret), false);
  await bridge.close();
});

test('BR-15 revokeAll and close terminate every pending read and socket', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  const port = await bridge.listen();
  const pairA = bridge.pair();
  const pairB = bridge.pair();
  const wsA = connect(port);
  const authA = await authenticate(wsA, pairA);
  const wsB = connect(port);
  await authenticate(wsB, pairB);
  const pending = bridge.readPage({ sessionId: authA.session, timeoutMs: 2000 });
  const rejected = assert.rejects(pending, /revoked/);
  await next(wsA);
  const closedA = closeOf(wsA);
  const closedB = closeOf(wsB);
  bridge.revokeAll();
  await within(closedA, 2000, 'revokeAll A');
  await within(closedB, 2000, 'revokeAll B');
  await rejected;
  assert.equal(bridge.listSessions().length, 0);
  await bridge.close();
});

test('BR-16 protocol.allowedOrigin accepts only canonical web origins', () => {
  const cases = [
    ['https://example.com', 'https://example.com'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['https://example.com:443', null],
    ['https://example.com/', null],
    ['https://example.com/path', null],
    ['https://example.com#x', null],
    ['https://user:pass@example.com', null],
    ['file:///c:/x', null],
    ['chrome-extension://' + 'a'.repeat(32), null],
    ['javascript:alert(1)', null],
    ['data:text/html,hi', null],
    ['not a url', null],
    ['https://example.com/' + 'a'.repeat(600), null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(protocol.allowedOrigin(input), expected, input);
  }
  assert.equal(protocol.hasExactKeys({ a: 1 }, ['a', 'b']), false);
  assert.equal(protocol.hasExactKeys(JSON.parse('{"__proto__":1,"a":2}'), ['__proto__', 'a']), true);
  assert.equal(protocol.equal('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(protocol.equal('A'.repeat(64), 'a'.repeat(64)), false);
  assert.equal(protocol.equal(null, null), false);
});

test('BR-17 one pairing cannot create two sessions (concurrent auth) or be replayed on another socket', async () => {
  const bridge = createBridge({ origin: ORIGIN });
  try {
    const port = await bridge.listen();
    const pair = bridge.pair(5000);
    const ws1 = connect(port);
    const ws2 = connect(port);
    const [ch1, ch2] = await Promise.all([next(ws1), next(ws2)]);
    const frame = challenge => {
      const nonce = random();
      return {
        type: 'authenticate',
        id: pair.id,
        nonce,
        proof: mac(pair.secret, 'c2s', 'authenticate', ORIGIN, pair.id, challenge, nonce),
      };
    };
    ws1.send(JSON.stringify(frame(ch1.challenge)));
    ws2.send(JSON.stringify(frame(ch2.challenge)));
    const loser = await within(
      Promise.race([closeOf(ws1).then(() => 'ws1'), closeOf(ws2).then(() => 'ws2')]),
      2000,
      'pairing race loser',
    );
    assert.ok(loser === 'ws1' || loser === 'ws2');
    assert.equal(bridge.listSessions().length, 1);
    for (const ws of [ws1, ws2]) {
      try { ws.terminate(); } catch {}
    }
  } finally {
    await bridge.close();
  }

  // Replay of a valid authenticate frame on a different connection cannot reuse the challenge.
  const bridge2 = createBridge({ origin: ORIGIN });
  try {
    const port2 = await bridge2.listen();
    const pair2 = bridge2.pair(5000);
    const a = connect(port2);
    const chA = await next(a);
    const nonce = random();
    const proof = mac(pair2.secret, 'c2s', 'authenticate', ORIGIN, pair2.id, chA.challenge, nonce);
    const b = connect(port2);
    await next(b);
    const closedB = closeOf(b);
    b.send(JSON.stringify({ type: 'authenticate', id: pair2.id, nonce, proof }));
    await within(closedB, 2000, 'cross-connection replay');
    // The genuine connection can still authenticate.
    const answer = next(a);
    a.send(JSON.stringify({ type: 'authenticate', id: pair2.id, nonce, proof }));
    assert.equal((await answer).type, 'authenticated');
    a.terminate();
  } finally {
    await bridge2.close();
  }
});
