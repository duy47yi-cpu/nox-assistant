'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { once } = require('node:events');
const { createBridge } = require('./bridge');
const { VERSION, MAX_FRAME_BYTES, MAX_TEXT_BYTES, random, mac, equal } = require('./protocol');

const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function connect(port, requestOrigin = origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/nox`, { origin: requestOrigin });
  ws.on('error', () => {});
  return ws;
}

function next(ws) {
  return once(ws, 'message').then(([data]) => JSON.parse(data.toString('utf8')));
}

async function auth(ws, pair, secret = pair.secret) {
  const challenge = await next(ws);
  assert.equal(challenge.version, VERSION);
  const nonce = random();
  const answer = next(ws);
  ws.send(
    JSON.stringify({
      type: 'authenticate',
      id: pair.id,
      nonce,
      proof: mac(secret, 'c2s', 'authenticate', origin, pair.id, challenge.challenge, nonce),
    })
  );
  const result = await answer;
  assert.equal(result.type, 'authenticated');
  assert.ok(
    equal(
      result.proof,
      mac(secret, 's2c', 'authenticated', origin, pair.id, challenge.challenge, nonce, result.session, result.sessionExpires)
    )
  );
  const sessionSecret = mac(
    secret,
    'session-key',
    origin,
    pair.id,
    challenge.challenge,
    nonce,
    result.session,
    result.sessionExpires
  );
  return { session: result.session, sessionExpires: result.sessionExpires, sessionSecret };
}

async function rejectedAuth(pairTransform) {
  let time = 1;
  const bridge = createBridge({ origin, now: () => time });
  const port = await bridge.listen();
  const pair = bridge.pair(10);
  const ws = await connect(port);
  const challenge = await next(ws);
  const nonce = random();
  const data = pairTransform(pair, () => {
    time = 11;
  });
  const closed = once(ws, 'close');
  ws.send(
    JSON.stringify({
      type: 'authenticate',
      id: data.id,
      nonce,
      proof: mac(data.secret, 'c2s', 'authenticate', origin, data.id, challenge.challenge, nonce),
    })
  );
  await closed;
  await bridge.close();
}

test('mutual proof, replay rejection, one-time pairing and revocation', async () => {
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  const pair = bridge.pair();
  const ws = await connect(port);
  const { session, sessionSecret } = await auth(ws, pair);

  // Pairing secret must not authenticate post-auth messages; session secret must.
  const request = { type: 'ping', seq: 1, proof: mac(sessionSecret, 'c2s', 'ping', session, 1) };
  const response = next(ws);
  ws.send(JSON.stringify(request));
  const pong = await response;
  assert.ok(equal(pong.proof, mac(sessionSecret, 's2c', 'pong', session, 1)));

  // Replay of seq=1 is rejected and closes socket.
  const closed = once(ws, 'close');
  ws.send(JSON.stringify(request));
  await closed;

  // P1.8: pairing is one-time and cannot be reused for a second connection.
  const wsReplay = await connect(port);
  const chReplay = await next(wsReplay);
  const nonceReplay = random();
  const rejectedReplay = once(wsReplay, 'close');
  wsReplay.send(
    JSON.stringify({
      type: 'authenticate',
      id: pair.id,
      nonce: nonceReplay,
      proof: mac(pair.secret, 'c2s', 'authenticate', origin, pair.id, chReplay.challenge, nonceReplay),
    })
  );
  await rejectedReplay;

  // Fresh pairing can be revoked by pairing.id or session.id immediately.
  const pair2 = bridge.pair();
  const ws2 = await connect(port);
  const s2 = await auth(ws2, pair2);
  const revoked = once(ws2, 'close');
  assert.equal(bridge.revoke(s2.session), true);
  await revoked;

  const pair3 = bridge.pair();
  const ws3 = await connect(port);
  await auth(ws3, pair3);
  const revokedByPairingId = once(ws3, 'close');
  assert.equal(bridge.revoke(pair3.id), true);
  await revokedByPairingId;

  await bridge.close();
});

test('forged client', () => rejectedAuth(pair => ({ ...pair, id: random() })));
test('wrong secret', () => rejectedAuth(pair => ({ ...pair, secret: random() })));
test('expired pairing', () => rejectedAuth((pair, expire) => { expire(); return pair; }));

test('foreign origin is rejected before upgrade', async () => {
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  const ws = await connect(port, 'https://example.com');
  await once(ws, 'close').catch(() => {});
  await bridge.close();
});

test('P1.8/P1.9: session outlives one-time pairing expiry and expires on its own TTL', async () => {
  const { connectBridge } = await import('./client.mjs');
  let now = 1000;
  let nextTimerId = 1;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      timers.set(id, { fn, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  };
  const bridge = createBridge({ origin, clock, sessionTtlMs: 5000 });
  const port = await bridge.listen();
  const pairing = bridge.pair(50);
  class BrowserSocket extends WebSocket {
    constructor(url) {
      super(url, { origin });
    }
  }
  const client = await connectBridge({
    port,
    origin,
    pairing,
    WebSocketClass: BrowserSocket,
    clock,
    onReadRequest: async () => ({ ok: true, origin: 'https://example.test', title: 'T', text: 'after pairing expiry', truncated: false }),
  });

  // Pairing expired at 1050, but session lasts until 6000.
  now = 2000;
  await client.ping();
  const res = await bridge.readPage({ timeoutMs: 1000 });
  assert.equal(res.ok, true);
  assert.equal(res.text, 'after pairing expiry');

  // At 6000 session expires and rejects further operations.
  now = 6000;
  await assert.rejects(client.ping());
  await assert.rejects(bridge.readPage({ timeoutMs: 1000 }));
  client.close();
  await bridge.close();
});

test('browser client verifies the bridge and exchanges signed read_request/read_result', async () => {
  const { connectBridge } = await import('./client.mjs');
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  const pairing = bridge.pair();
  class BrowserSocket extends WebSocket {
    constructor(url) {
      super(url, { origin });
    }
  }
  const client = await connectBridge({
    port,
    origin,
    pairing,
    WebSocketClass: BrowserSocket,
    onReadRequest: async () => ({
      ok: true,
      origin: 'https://example.com',
      title: 'Example',
      text: 'Visible text',
      truncated: false,
    }),
  });
  await client.ping();
  const result = await bridge.readPage();
  assert.deepEqual(result, {
    ok: true,
    origin: 'https://example.com',
    title: 'Example',
    text: 'Visible text',
    truncated: false,
  });
  client.close();
  await bridge.close();
});

test('browser client rejects a forged bridge', async () => {
  const { connectBridge } = await import('./client.mjs');
  const fake = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(fake, 'listening');
  fake.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'challenge', version: VERSION, challenge: random() }));
    ws.on('message', () =>
      ws.send(JSON.stringify({ type: 'authenticated', session: random(), sessionExpires: Date.now() + 5000, proof: random() }))
    );
  });
  const pairing = { id: random(), secret: random(), expires: Date.now() + 10000 };
  await assert.rejects(connectBridge({ port: fake.address().port, origin, pairing, WebSocketClass: WebSocket }));
  await new Promise(resolve => fake.close(resolve));
});

test('P1.11/P1.14: rejects tampered, unsigned, replayed, wrong-direction, or tabId-bearing read_request/read_result', async () => {
  const { connectBridge } = await import('./client.mjs');

  // 1. Tampered read_result text fails MAC and closes connection.
  {
    const bridge = createBridge({ origin });
    const port = await bridge.listen();
    const pair = bridge.pair();
    const ws = await connect(port);
    const { session, sessionSecret } = await auth(ws, pair);
    const pending = bridge.readPage({ timeoutMs: 2000 });
    const rejected = assert.rejects(pending);
    const req = await next(ws);
    assert.equal(req.type, 'read_request');
    const closed = once(ws, 'close');
    const proof = mac(
      sessionSecret,
      'c2s',
      'read_result',
      session,
      1,
      req.requestId,
      true,
      'https://example.com',
      'Title',
      'original',
      false
    );
    ws.send(
      JSON.stringify({
        type: 'read_result',
        seq: 1,
        requestId: req.requestId,
        ok: true,
        origin: 'https://example.com',
        title: 'Title',
        text: 'tampered',
        truncated: false,
        proof,
      })
    );
    await closed;
    await rejected;
    await bridge.close();
  }

  // 2. Unsigned or wrong-direction read_result is rejected.
  {
    const bridge = createBridge({ origin });
    const port = await bridge.listen();
    const pair = bridge.pair();
    const ws = await connect(port);
    const { session, sessionSecret } = await auth(ws, pair);
    const pending = bridge.readPage({ timeoutMs: 2000 });
    const rejected = assert.rejects(pending);
    const req = await next(ws);
    const closed = once(ws, 'close');
    const wrongDirProof = mac(
      sessionSecret,
      's2c',
      'read_result',
      session,
      1,
      req.requestId,
      false,
      'denied'
    );
    ws.send(JSON.stringify({ type: 'read_result', seq: 1, requestId: req.requestId, ok: false, error: 'denied', proof: wrongDirProof }));
    await closed;
    await rejected;
    await bridge.close();
  }

  // 3. Replayed read_result (old seq / old requestId) is rejected.
  {
    const bridge = createBridge({ origin });
    const port = await bridge.listen();
    const pair = bridge.pair();
    const ws = await connect(port);
    const { session, sessionSecret } = await auth(ws, pair);
    const p1 = bridge.readPage({ timeoutMs: 2000 });
    const req1 = await next(ws);
    const r1 = {
      type: 'read_result',
      seq: 1,
      requestId: req1.requestId,
      ok: false,
      error: 'permission_required',
      proof: mac(sessionSecret, 'c2s', 'read_result', session, 1, req1.requestId, false, 'permission_required'),
    };
    ws.send(JSON.stringify(r1));
    assert.deepEqual(await p1, { ok: false, error: 'permission_required' });

    const p2 = bridge.readPage({ timeoutMs: 2000 });
    const rejected2 = assert.rejects(p2);
    await next(ws);
    const closed = once(ws, 'close');
    ws.send(JSON.stringify(r1));
    await closed;
    await rejected2;
    await bridge.close();
  }

  // 4. Client rejects read_request containing tabId (P0.7), wrong proof, or replayed requestId.
  for (const mutate of [
    (req) => ({ ...req, tabId: 2 }),
    (req) => ({ ...req, proof: random() }),
    (req, sSecret, sid) => ({
      ...req,
      seq: 99,
      proof: mac(sSecret, 's2c', 'read_request', sid, 99, req.requestId, req.issuedAt, req.expiresAt),
    }),
  ]) {
    const fake = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(fake, 'listening');
    const pair = { id: random(), secret: random(), expires: Date.now() + 10000 };
    const challenge = random();
    let serverClosed;
    fake.on('connection', ws => {
      serverClosed = once(ws, 'close');
      ws.send(JSON.stringify({ type: 'challenge', version: VERSION, challenge }));
      ws.once('message', raw => {
        const msg = JSON.parse(raw.toString('utf8'));
        const sid = random();
        const sExp = Date.now() + 60000;
        const sSecret = mac(pair.secret, 'session-key', origin, pair.id, challenge, msg.nonce, sid, sExp);
        ws.send(
          JSON.stringify({
            type: 'authenticated',
            session: sid,
            sessionExpires: sExp,
            proof: mac(pair.secret, 's2c', 'authenticated', origin, pair.id, challenge, msg.nonce, sid, sExp),
          })
        );
        const reqId = random();
        const issuedAt = Date.now();
        const expiresAt = issuedAt + 5000;
        const baseReq = {
          type: 'read_request',
          seq: 1,
          requestId: reqId,
          issuedAt,
          expiresAt,
          proof: mac(sSecret, 's2c', 'read_request', sid, 1, reqId, issuedAt, expiresAt),
        };
        ws.send(JSON.stringify(mutate(baseReq, sSecret, sid)));
      });
    });
    let closedCalled = false;
    const client = await connectBridge({
      port: fake.address().port,
      origin,
      pairing: pair,
      WebSocketClass: WebSocket,
      onClose: () => {
        closedCalled = true;
      },
      onReadRequest: async () => {
        throw new Error('must not execute');
      },
    });
    await serverClosed;
    assert.equal(closedCalled, true);
    client.close();
    await new Promise(resolve => fake.close(resolve));
  }
});

test('P1.12: 64 KiB frame limit and UTF-8 byte truncation handle multi-byte and JSON-escaped overflow', async () => {
  const { connectBridge } = await import('./client.mjs');
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  const pairing = bridge.pair();
  class BrowserSocket extends WebSocket {
    constructor(url) {
      super(url, { origin });
    }
  }

  // Case A: multi-byte emoji exceeding MAX_TEXT_BYTES (49152 bytes) is cleanly truncated without broken surrogates.
  const hugeEmoji = '😀'.repeat(15000); // 60,000 UTF-8 bytes
  let mode = 'emoji';
  const client = await connectBridge({
    port,
    origin,
    pairing,
    WebSocketClass: BrowserSocket,
    onReadRequest: async () => ({
      ok: true,
      origin: 'https://example.com',
      title: 'Я'.repeat(400), // 800 UTF-8 bytes > 512
      text: mode === 'emoji' ? hugeEmoji : '"'.repeat(45000), // quotes expand 2x in JSON (> 64 KiB)
      truncated: false,
    }),
  });

  const resA = await bridge.readPage();
  assert.equal(resA.ok, true);
  assert.equal(resA.truncated, true);
  assert.ok(Buffer.byteLength(resA.title, 'utf8') <= 512);
  assert.ok(Buffer.byteLength(resA.text, 'utf8') <= MAX_TEXT_BYTES);
  assert.equal(Buffer.from(resA.text, 'utf8').toString('utf8'), resA.text);

  // Case B: heavy JSON escaping stays within 64 KiB frame limit cleanly.
  mode = 'quotes';
  const resB = await bridge.readPage();
  assert.equal(resB.ok, true);
  assert.equal(resB.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(resB), 'utf8') < MAX_FRAME_BYTES);

  client.close();
  await bridge.close();
});

test('P1.12: oversized incoming frame (> 64 KiB default or maxPayload) is rejected', async () => {
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  const ws = await connect(port);
  await next(ws);
  const closed = once(ws, 'close');
  ws.send('x'.repeat(MAX_FRAME_BYTES + 1));
  await closed;
  await bridge.close();
});

test('P1.13: single active request limit and timeout handling', async () => {
  const { connectBridge } = await import('./client.mjs');
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  const pairing = bridge.pair();
  class BrowserSocket extends WebSocket {
    constructor(url) {
      super(url, { origin });
    }
  }
  let releaseRead;
  let fast = false;
  const client = await connectBridge({
    port,
    origin,
    pairing,
    WebSocketClass: BrowserSocket,
    onReadRequest: async () => {
      if (fast) return { ok: true, origin: 'https://example.com', title: 'Ok', text: 'ready', truncated: false };
      return new Promise(resolve => {
        releaseRead = resolve;
      });
    },
  });

  const first = bridge.readPage({ timeoutMs: 80 });
  await assert.rejects(bridge.readPage({ timeoutMs: 80 }), /read request already active/);
  await assert.rejects(first, /read request timed out/);

  // Resolve stale handler late; session remains usable for next request.
  releaseRead({ ok: true, origin: 'https://example.com', title: 'Late', text: 'stale', truncated: false });
  fast = true;
  const nextRes = await bridge.readPage({ timeoutMs: 1000 });
  assert.equal(nextRes.ok, true);
  assert.equal(nextRes.text, 'ready');

  client.close();
  await bridge.close();
});

test('message rate is bounded', async () => {
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  const pair = bridge.pair();
  const ws = await connect(port);
  const { session, sessionSecret } = await auth(ws, pair);
  const closed = once(ws, 'close');
  for (let seq = 1; seq <= 30; seq++) {
    ws.send(JSON.stringify({ type: 'ping', seq, proof: mac(sessionSecret, 'c2s', 'ping', session, seq) }));
  }
  await closed;
  await bridge.close();
});

test('Privacy 15: bridge and client do not log or persist page text', () => {
  for (const file of ['bridge.js', 'protocol.js', 'client.mjs']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.equal(/\bconsole\.(log|info|debug|warn|error)\b/.test(src), false, `${file} must not log`);
    assert.equal(/\b(localStorage|sessionStorage|indexedDB|writeFile)\b/.test(src), false, `${file} must not persist`);
  }
});

test('F1: late valid read_result after timeout advances clientSeq, keeps session alive, and rejects replay', async () => {
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  const pair = bridge.pair();
  const ws = await connect(port);
  const { session, sessionSecret } = await auth(ws, pair);

  const reqPromise = bridge.readPage({ timeoutMs: 60 });
  const reqFrame = await next(ws);
  assert.equal(reqFrame.type, 'read_request');
  await assert.rejects(reqPromise, /read request timed out/);

  // Late valid read_result arrives AFTER bridge timed out.
  const lateOrigin = 'https://late.example.test';
  const lateTitle = 'Late Title';
  const lateText = 'late canary text that must be discarded';
  const lateProof = mac(
    sessionSecret,
    'c2s',
    'read_result',
    session,
    1,
    reqFrame.requestId,
    true,
    lateOrigin,
    lateTitle,
    lateText,
    false
  );
  ws.send(
    JSON.stringify({
      type: 'read_result',
      seq: 1,
      requestId: reqFrame.requestId,
      ok: true,
      origin: lateOrigin,
      title: lateTitle,
      text: lateText,
      truncated: false,
      proof: lateProof,
    })
  );

  // Wait briefly; session must remain open and usable for a fresh readPage.
  await new Promise(r => setTimeout(r, 40));
  assert.equal(ws.readyState, WebSocket.OPEN);

  const nextRead = bridge.readPage({ timeoutMs: 500 });
  const nextReq = await next(ws);
  assert.equal(nextReq.seq, 2);
  const freshProof = mac(
    sessionSecret,
    'c2s',
    'read_result',
    session,
    2,
    nextReq.requestId,
    true,
    'https://fresh.example.test',
    'Fresh',
    'fresh text',
    false
  );
  ws.send(
    JSON.stringify({
      type: 'read_result',
      seq: 2,
      requestId: nextReq.requestId,
      ok: true,
      origin: 'https://fresh.example.test',
      title: 'Fresh',
      text: 'fresh text',
      truncated: false,
      proof: freshProof,
    })
  );
  const freshRes = await nextRead;
  assert.equal(freshRes.ok, true);
  assert.equal(freshRes.text, 'fresh text');

  // Replay of the already-consumed timedOut requestId must terminate the session.
  const closed = once(ws, 'close');
  const replayProof = mac(
    sessionSecret,
    'c2s',
    'read_result',
    session,
    3,
    reqFrame.requestId,
    false,
    'busy'
  );
  ws.send(
    JSON.stringify({
      type: 'read_result',
      seq: 3,
      requestId: reqFrame.requestId,
      ok: false,
      error: 'busy',
      proof: replayProof,
    })
  );
  await closed;
  await bridge.close();
});

test('F1: tampered late read_result closes session', async () => {
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  const pair = bridge.pair();
  const ws = await connect(port);
  await auth(ws, pair);

  const reqPromise = bridge.readPage({ timeoutMs: 60 });
  const reqFrame = await next(ws);
  await assert.rejects(reqPromise, /read request timed out/);

  const closed = once(ws, 'close');
  ws.send(
    JSON.stringify({
      type: 'read_result',
      seq: 1,
      requestId: reqFrame.requestId,
      ok: true,
      origin: 'https://example.com',
      title: 'T',
      text: 'tampered',
      truncated: false,
      proof: '00'.repeat(32),
    })
  );
  await closed;
  await bridge.close();
});

test('F3: client sequence does not advance on send error', async () => {
  const { connectBridge } = await import('./client.mjs');
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  const pairing = bridge.pair();
  let failSendPing = true;
  let failSendReadResult = true;
  class FlakySocket extends WebSocket {
    constructor(url) {
      super(url, { origin });
    }
    send(data, ...rest) {
      if (failSendPing && typeof data === 'string' && data.includes('"ping"')) {
        failSendPing = false;
        throw new Error('simulated ping send failure');
      }
      if (failSendReadResult && typeof data === 'string' && data.includes('"read_result"')) {
        failSendReadResult = false;
        throw new Error('simulated read_result send failure');
      }
      return super.send(data, ...rest);
    }
  }
  const client = await connectBridge({
    port,
    origin,
    pairing,
    WebSocketClass: FlakySocket,
    onReadRequest: async () => ({
      ok: true,
      origin: 'https://example.com',
      title: 'Ok',
      text: 'body',
      truncated: false,
    }),
  });
  try {
    // 1) Failed ping send must not consume sequence.
    await assert.rejects(client.ping(), /simulated ping send failure/);

    // 2) Failed read_result send -> bridge times out, client sequence untouched.
    await assert.rejects(bridge.readPage({ timeoutMs: 80 }), /read request timed out/);

    // 3) Next readPage receives seq=1 (no gap), so session stays alive and read succeeds!
    const okRes = await bridge.readPage({ timeoutMs: 500 });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.text, 'body');

    // 4) Subsequent ping also succeeds at seq=2.
    await client.ping();
  } finally {
    client.close();
    await bridge.close();
  }
});

test('F4: client.mjs and protocol constants match nox-browser-extension byte-for-byte', async () => {
  const crypto = require('node:crypto');
  const { pathToFileURL } = require('node:url');
  const bridgeClient = fs.readFileSync(path.join(__dirname, 'client.mjs'));
  const extClient = fs.readFileSync(path.resolve(__dirname, '../nox-browser-extension/client.mjs'));
  const hash = buf => crypto.createHash('sha256').update(buf).digest('hex');
  assert.equal(hash(bridgeClient), hash(extClient));

  const protocol = require('./protocol');
  const extMessages = await import(pathToFileURL(path.resolve(__dirname, '../nox-browser-extension/messages.mjs')).href);
  assert.equal(protocol.VERSION, extMessages.VERSION);
  assert.equal(protocol.MAX_FRAME_BYTES, extMessages.MAX_FRAME_BYTES);
  assert.equal(protocol.MAX_TITLE_BYTES, extMessages.MAX_TITLE_BYTES);
  assert.equal(protocol.MAX_TEXT_BYTES, extMessages.MAX_TEXT_BYTES);
  assert.equal(protocol.READ_TIMEOUT_MS, extMessages.READ_TIMEOUT_MS);
  assert.equal(protocol.SESSION_TTL_MS, extMessages.SESSION_TTL_MS);
});
