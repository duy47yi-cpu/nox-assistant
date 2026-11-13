import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const load = createRequire(new URL('../../../apps/nox-browser-bridge/package.json', import.meta.url));
const WebSocket = load('ws');
const { mac } = load('./protocol.js');
const { connectBridge } = await import('../../../apps/nox-browser-extension/client.mjs');

const VERSION = 'nox-bridge-2';
const ORIGIN = 'chrome-extension://' + 'a'.repeat(32);
const MAX_FRAME_BYTES = 65536;
const hex = () => randomBytes(32).toString('hex');

class BrowserSocket extends WebSocket {
  constructor(url) {
    super(url, { origin: ORIGIN });
  }
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

function waitClose(ws) {
  return new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', resolve);
  });
}

async function startRogue({ version = VERSION, authProof = 'valid', sessionTtl = 60000 } = {}) {
  const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(server, 'listening');
  const rogue = {
    server,
    port: server.address().port,
    pair: { id: hex(), secret: hex(), expires: Date.now() + 30000 },
    sockets: [],
    ready: null,
    firstClose: null,
    lastClose: null,
  };
  let resolveReady;
  rogue.ready = new Promise(resolve => { resolveReady = resolve; });
  let resolveFirstClose;
  rogue.firstClose = new Promise(resolve => { resolveFirstClose = resolve; });
  server.on('connection', ws => {
    rogue.sockets.push(ws);
    ws.on('error', () => {});
    rogue.lastClose = waitClose(ws);
    ws.once('close', resolveFirstClose);
    const challenge = hex();
    ws.send(JSON.stringify({ type: 'challenge', version, challenge }));
    ws.once('message', raw => {
      const msg = JSON.parse(raw.toString());
      const sid = hex();
      const sessionExpires = Date.now() + sessionTtl;
      const sSecret = mac(rogue.pair.secret, 'session-key', ORIGIN, rogue.pair.id, challenge, msg.nonce, sid, sessionExpires);
      const proof = authProof === 'valid'
        ? mac(rogue.pair.secret, 's2c', 'authenticated', ORIGIN, rogue.pair.id, challenge, msg.nonce, sid, sessionExpires)
        : hex();
      ws.send(JSON.stringify({ type: 'authenticated', session: sid, sessionExpires, proof }));
      resolveReady({ ws, sid, sSecret, challenge, sessionExpires });
    });
  });
  return rogue;
}

async function closeRogue(rogue) {
  for (const ws of rogue.sockets) {
    try { ws.terminate(); } catch {}
  }
  await new Promise(resolve => rogue.server.close(resolve));
}

async function withRogue(options, fn) {
  const rogue = await startRogue(options);
  try {
    return await fn(rogue);
  } finally {
    await closeRogue(rogue);
  }
}

function readRequest({ sid, sSecret, seq, requestId, issuedAt, expiresAt, extra = {} }) {
  const frame = {
    type: 'read_request',
    seq,
    requestId,
    issuedAt,
    expiresAt,
    ...extra,
  };
  frame.proof = mac(sSecret, 's2c', 'read_request', sid, seq, requestId, issuedAt, expiresAt);
  return frame;
}

async function expectReady(rogue, onReadRequest = async () => ({ ok: false, error: 'permission_required' })) {
  const ready = rogue.ready;
  const client = await connectBridge({
    port: rogue.port,
    origin: ORIGIN,
    pairing: rogue.pair,
    WebSocketClass: BrowserSocket,
    onReadRequest,
  });
  const ctx = await ready;
  return { client, ctx };
}

test('CL-01 wrong challenge version, forged authenticated proof, implausible session life are refused', async () => {
  await withRogue({ version: 'nox-bridge-1' }, async rogue => {
    await assert.rejects(
      connectBridge({ port: rogue.port, origin: ORIGIN, pairing: rogue.pair, WebSocketClass: BrowserSocket }),
    );
    await within(rogue.firstClose, 2000, 'bad version close');
  });
  await withRogue({ authProof: 'bad' }, async rogue => {
    await assert.rejects(
      connectBridge({ port: rogue.port, origin: ORIGIN, pairing: rogue.pair, WebSocketClass: BrowserSocket }),
    );
    await within(rogue.firstClose, 2000, 'bad proof close');
  });
  await withRogue({ sessionTtl: 3600000 + 1000 }, async rogue => {
    await assert.rejects(
      connectBridge({ port: rogue.port, origin: ORIGIN, pairing: rogue.pair, WebSocketClass: BrowserSocket }),
    );
    await within(rogue.firstClose, 2000, 'long session close');
  });
  await withRogue({ sessionTtl: -1000 }, async rogue => {
    await assert.rejects(
      connectBridge({ port: rogue.port, origin: ORIGIN, pairing: rogue.pair, WebSocketClass: BrowserSocket }),
    );
    await within(rogue.firstClose, 2000, 'expired session close');
  });
});

test('CL-02 unsolicited pong and unknown/duplicate control frames close the client', async () => {
  await withRogue({}, async rogue => {
    const { client, ctx } = await expectReady(rogue);
    ctx.ws.send(JSON.stringify({ type: 'pong', seq: 1, proof: mac(ctx.sSecret, 's2c', 'pong', ctx.sid, 1) }));
    await within(rogue.lastClose, 2000, 'unsolicited pong');
    client.close();
  });
  await withRogue({}, async rogue => {
    const { client, ctx } = await expectReady(rogue);
    ctx.ws.send(JSON.stringify({ type: 'authenticated', session: hex(), sessionExpires: Date.now() + 1000, proof: hex() }));
    await within(rogue.lastClose, 2000, 'duplicate authenticated');
    client.close();
  });
});

test('CL-03 read_request schema/state machine violations never reach onReadRequest', async () => {
  const attacks = {
    'tabId extra': ctx => ({
      ...readRequest({ ...ctx, seq: 1, requestId: hex(), issuedAt: Date.now(), expiresAt: Date.now() + 5000 }),
      tabId: 3,
    }),
    'origin extra': ctx => ({
      ...readRequest({ ...ctx, seq: 1, requestId: hex(), issuedAt: Date.now(), expiresAt: Date.now() + 5000 }),
      origin: 'https://evil.test',
    }),
    'overlong timeout': ctx => {
      const issuedAt = Date.now();
      return readRequest({ ...ctx, seq: 1, requestId: hex(), issuedAt, expiresAt: issuedAt + 30001 });
    },
    'already expired': ctx => {
      const now = Date.now();
      return readRequest({ ...ctx, seq: 1, requestId: hex(), issuedAt: now - 100, expiresAt: now - 1 });
    },
    'seq skip': ctx => readRequest({ ...ctx, seq: 2, requestId: hex(), issuedAt: Date.now(), expiresAt: Date.now() + 5000 }),
    'fractional expiry': ctx => {
      const issuedAt = Date.now();
      return readRequest({ ...ctx, seq: 1, requestId: hex(), issuedAt, expiresAt: issuedAt + 5000.5 });
    },
    'requestId not hex': ctx => readRequest({ ...ctx, seq: 1, requestId: 'z'.repeat(64), issuedAt: Date.now(), expiresAt: Date.now() + 5000 }),
    'bad proof': ctx => ({
      ...readRequest({ ...ctx, seq: 1, requestId: hex(), issuedAt: Date.now(), expiresAt: Date.now() + 5000 }),
      proof: hex(),
    }),
    'wrong direction proof': ctx => {
      const issuedAt = Date.now();
      const requestId = hex();
      return {
        type: 'read_request',
        seq: 1,
        requestId,
        issuedAt,
        expiresAt: issuedAt + 5000,
        proof: mac(ctx.sSecret, 'c2s', 'read_request', ctx.sid, 1, requestId, issuedAt, issuedAt + 5000),
      };
    },
  };
  for (const [name, build] of Object.entries(attacks)) {
    await withRogue({}, async rogue => {
      let calls = 0;
      const { client, ctx } = await expectReady(rogue, async () => {
        calls += 1;
        return { ok: false, error: 'should_not_run' };
      });
      ctx.ws.send(JSON.stringify(build(ctx)));
      await within(rogue.lastClose, 2000, name);
      assert.equal(calls, 0, `${name} must not execute a read`);
      client.close();
    });
  }
});

test('CL-04 replayed requestId with a fresh valid seq is refused after one execution', async () => {
  await withRogue({}, async rogue => {
    let calls = 0;
    let release;
    const { client, ctx } = await expectReady(rogue, async () => {
      calls += 1;
      return new Promise(resolve => { release = resolve; });
    });
    const requestId = hex();
    const issuedAt = Date.now();
    ctx.ws.send(JSON.stringify(readRequest({ ...ctx, seq: 1, requestId, issuedAt, expiresAt: issuedAt + 10000 })));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(calls, 1);
    ctx.ws.send(JSON.stringify(readRequest({ ...ctx, seq: 2, requestId, issuedAt, expiresAt: issuedAt + 10000 })));
    await within(rogue.lastClose, 2000, 'replayed requestId');
    assert.equal(calls, 1);
    release?.({ ok: false, error: 'permission_required' });
    client.close();
  });
});

test('CL-05 malformed / oversized / binary frames fail closed', async () => {
  const attacks = [
    ['oversized', ws => ws.send('x'.repeat(MAX_FRAME_BYTES + 1))],
    ['binary', ws => ws.send(Buffer.from([1, 2, 3]), { binary: true })],
    ['array', ws => ws.send('[]')],
    ['unknown type', ws => ws.send(JSON.stringify({ type: 'ping' }))],
    ['null', ws => ws.send('null')],
  ];
  for (const [name, attack] of attacks) {
    await withRogue({}, async rogue => {
      const { client, ctx } = await expectReady(rogue);
      attack(ctx.ws);
      await within(rogue.lastClose, 3000, name);
      client.close();
    });
  }
});

test('CL-06 valid read_result is signed correctly and carries exactly the expected fields', async () => {
  await withRogue({}, async rogue => {
    const { client, ctx } = await expectReady(rogue, async () => ({
      ok: true,
      origin: 'https://example.test',
      title: 'Title',
      text: 'Body',
      truncated: false,
    }));
    const issuedAt = Date.now();
    const requestId = hex();
    ctx.ws.send(JSON.stringify(readRequest({ ...ctx, seq: 1, requestId, issuedAt, expiresAt: issuedAt + 5000 })));
    const [raw] = await within(once(ctx.ws, 'message'), 3000, 'read_result');
    const result = JSON.parse(raw.toString());
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'origin', 'proof', 'requestId', 'seq', 'text', 'title', 'truncated', 'type']);
    assert.equal(result.seq, 1);
    assert.equal(result.requestId, requestId);
    assert.equal(result.ok, true);
    assert.equal(result.origin, 'https://example.test');
    assert.equal(result.title, 'Title');
    assert.equal(result.text, 'Body');
    assert.equal(result.truncated, false);
    assert.equal(
      result.proof,
      mac(ctx.sSecret, 'c2s', 'read_result', ctx.sid, 1, requestId, true, 'https://example.test', 'Title', 'Body', false),
    );
    client.close();
  });
});

test('CL-07 48 KiB of JSON-escaped text still fits the 64 KiB frame and keeps its MAC valid', async () => {
  await withRogue({}, async rogue => {
    const text = '"'.repeat(48000);
    const { client, ctx } = await expectReady(rogue, async () => ({
      ok: true,
      origin: 'https://example.test',
      title: 'Q',
      text,
      truncated: false,
    }));
    const issuedAt = Date.now();
    const requestId = hex();
    ctx.ws.send(JSON.stringify(readRequest({ ...ctx, seq: 1, requestId, issuedAt, expiresAt: issuedAt + 10000 })));
    const [raw] = await within(once(ctx.ws, 'message'), 5000, 'fitted read_result');
    const size = Buffer.byteLength(raw.toString('utf8'), 'utf8');
    assert.ok(size <= MAX_FRAME_BYTES, `frame ${size}`);
    const result = JSON.parse(raw.toString());
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.text, 'utf8') <= 49152);
    assert.equal(
      result.proof,
      mac(ctx.sSecret, 'c2s', 'read_result', ctx.sid, result.seq, requestId, true, result.origin, result.title, result.text, result.truncated),
    );
    client.close();
  });
});

test('CL-08 two pipelined read_requests: only one read executes and a busy result is emitted (protocol mismatch note)', async () => {
  await withRogue({}, async rogue => {
    let calls = 0;
    const { client, ctx } = await expectReady(rogue, async () => {
      calls += 1;
      return new Promise(() => {});
    });
    const issuedAt = Date.now();
    const first = hex();
    const second = hex();
    const busyFrame = within(once(ctx.ws, 'message'), 3000, 'busy result');
    ctx.ws.send(JSON.stringify(readRequest({ ...ctx, seq: 1, requestId: first, issuedAt, expiresAt: issuedAt + 10000 })));
    ctx.ws.send(JSON.stringify(readRequest({ ...ctx, seq: 2, requestId: second, issuedAt, expiresAt: issuedAt + 10000 })));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(calls, 1);
    const result = JSON.parse((await busyFrame)[0].toString());
    assert.equal(result.requestId, second);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'busy');
    assert.equal(result.seq, 1);
    client.close();
  });
});

test('CL-09 challenge-first state machine: no frame is accepted before the challenge', async () => {
  const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const pair = { id: hex(), secret: hex(), expires: Date.now() + 30000 };
  let socket;
  server.on('connection', ws => {
    socket = ws;
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'authenticated', session: hex(), sessionExpires: Date.now() + 5000, proof: hex() }));
  });
  try {
    await assert.rejects(
      connectBridge({ port: server.address().port, origin: ORIGIN, pairing: pair, WebSocketClass: BrowserSocket }),
    );
    if (socket.readyState !== WebSocket.CLOSED) {
      await within(waitClose(socket), 2000, 'pre-challenge close');
    }
  } finally {
    try { socket?.terminate(); } catch {}
    await new Promise(resolve => server.close(resolve));
  }
});
