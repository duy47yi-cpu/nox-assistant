'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

const { createServer } = require('../server');
const { Store } = require('../store');
const { LinkStore, LinkError } = require('../link-store');
const { createLinkServer } = require('../link-relay');

const TEST_MODELS = {
  fast: {
    url: 'https://api.example.invalid/v1',
    model: 'fast-test',
    key: 'secret-fast-key',
    levels: { low: {}, medium: {}, high: {} },
    price: { inputPerM: 0.2, cachedPerM: 0.02, outputPerM: 0.6 },
  },
};

function makeTempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-r2-'));
  const cleanups = [];
  t.after(async () => {
    for (let i = cleanups.length - 1; i >= 0; i -= 1) {
      try {
        await cleanups[i]();
      } catch {
        // best-effort cleanup
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    dbFile: path.join(dir, 'nox.db'),
    addCleanup(fn) {
      cleanups.push(fn);
    },
  };
}

function fp256() {
  return crypto.randomBytes(32).toString('hex');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { port, baseUrl: `http://127.0.0.1:${port}` };
}

async function closeAsync(server, timeoutMs = 1000) {
  let timedOut = false;
  await Promise.race([
    new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    }),
    delay(timeoutMs).then(() => {
      timedOut = true;
    }),
  ]);
  return { timedOut };
}

async function httpJson(baseUrl, urlPath, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function setupUser(baseUrl, email = `u-${crypto.randomBytes(4).toString('hex')}@nox.test`, deviceCount = 2) {
  const reg = await httpJson(baseUrl, '/v1/auth/register', {
    method: 'POST',
    body: { email, password: 'Password1234!' },
  });
  assert.equal(reg.status, 201);
  const { token, account } = reg.json;
  const devices = [];
  for (let i = 0; i < deviceCount; i += 1) {
    const deviceId = crypto.randomUUID();
    const dRes = await httpJson(baseUrl, '/v1/link/devices/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { deviceId, deviceName: `Dev-${i}`, rootCaFp256: fp256() },
    });
    assert.equal(dRes.status, 201);
    devices.push(dRes.json.device);
  }
  return { email, token, account, devices };
}

function slowChunkedPost(port, urlPath, headers, jsonBody, midBodyHook) {
  const payload = JSON.stringify(jsonBody);
  const split = Math.max(2, Math.floor(payload.length / 2));
  const part1 = payload.slice(0, split);
  const part2 = payload.slice(split);

  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let raw = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`slowChunkedPost timeout on ${urlPath}: ${raw}`));
    }, 5000);

    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    sock.on('end', () => {
      clearTimeout(timer);
      const sep = raw.indexOf('\r\n\r\n');
      const head = sep === -1 ? raw : raw.slice(0, sep);
      const body = sep === -1 ? '' : raw.slice(sep + 4);
      const statusMatch = /^HTTP\/1\.\d\s+(\d+)/.exec(head);
      resolve({ status: statusMatch ? Number(statusMatch[1]) : 0, head, body });
    });
    sock.once('connect', async () => {
      const headerLines = [
        `POST ${urlPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: close',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(payload)}`,
        ...Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`),
        '',
        part1,
      ].join('\r\n');
      sock.write(headerLines);
      await delay(30);
      try {
        if (midBodyHook) await midBodyHook();
      } catch (err) {
        clearTimeout(timer);
        sock.destroy();
        reject(err);
        return;
      }
      await delay(10);
      if (!sock.destroyed) sock.write(part2);
    });
  });
}

function openSseRaw(port, { token, deviceId }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    let settled = false;
    const rawChunks = [];
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error('SSE open timeout'));
      }
    }, 3000);
    sock.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    sock.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      rawChunks.push(text);
      if (!settled) {
        buf += text;
        const idx = buf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          settled = true;
          clearTimeout(timer);
          const status = Number((/^HTTP\/1\.\d\s+(\d+)/.exec(buf.slice(0, idx)) || [])[1] || 0);
          resolve({ status, sock, rawChunks });
        }
      }
    });
    sock.once('connect', () => {
      sock.write([
        'GET /v1/link/events HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${token}`,
        `X-Nox-Device-Id: ${deviceId}`,
        '',
        '',
      ].join('\r\n'));
    });
  });
}

function connectUpgradeRaw(port, headers) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(val);
    };
    const timer = setTimeout(() => done({ status: 0, timedOut: true }), 2000);
    sock.on('error', () => {
      clearTimeout(timer);
      done({ status: 0 });
    });
    sock.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        const status = Number((/^HTTP\/1\.\d\s+(\d+)/.exec(buf) || [])[1] || 0);
        const sep = buf.indexOf('\r\n\r\n');
        let bodyJson = null;
        if (sep !== -1) {
          try {
            bodyJson = JSON.parse(buf.slice(sep + 4));
          } catch { /* ignore */ }
        }
        done({ status, buf, bodyJson });
      }
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
    });
    sock.once('connect', () => {
      sock.write([
        'GET /v1/link/relay HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: nox-link',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ].join('\r\n'));
    });
  });
}

test('RED-01a/b/c/d [P0 TOCTOU]: re-checks logout, disable, TTL expiry after body read and releases canceled slots', async (t) => {
  const { dbFile, addCleanup } = makeTempDb(t);
  let clock = 1_700_000_000_000;
  let upstreamCalls = 0;

  const { server, store } = createServer({
    dbFile,
    models: TEST_MODELS,
    adminKey: 'admin-r2-secret',
    sessionTtlMs: 1000,
    now: () => clock,
    link: { sseHeartbeatMs: 60_000 },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  addCleanup(async () => {
    await closeAsync(server);
    store.close();
  });
  const { port, baseUrl } = await listen(server);

  // RED-01a: logout mid-body blocks /v1/link/sessions/open
  const uA = await setupUser(baseUrl, 'red01a@nox.test', 2);
  const rA = await slowChunkedPost(
    port,
    '/v1/link/sessions/open',
    { Authorization: `Bearer ${uA.token}`, 'X-Nox-Device-Id': uA.devices[0].deviceId },
    { targetDeviceId: uA.devices[1].deviceId },
    async () => {
      const lo = await httpJson(baseUrl, '/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${uA.token}` } });
      assert.equal(lo.status, 200);
    },
  );
  assert.equal(rA.status, 401);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM link_rooms WHERE account_id = ?').get(uA.account.id).n, 0);

  // RED-01b: admin disable mid-body blocks /v1/link/devices/register
  const uB = await setupUser(baseUrl, 'red01b@nox.test', 0);
  const devB = crypto.randomUUID();
  const rB = await slowChunkedPost(
    port,
    '/v1/link/devices/register',
    { Authorization: `Bearer ${uB.token}` },
    { deviceId: devB, deviceName: 'ShouldFail', rootCaFp256: fp256() },
    async () => {
      const dis = await httpJson(baseUrl, '/v1/admin/disable', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-r2-secret' },
        body: { email: uB.email, disabled: true },
      });
      assert.equal(dis.status, 200);
    },
  );
  assert.equal(rB.status, 401);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM link_devices WHERE device_id = ?').get(devB).n, 0);

  // RED-01c: logout mid-body blocks /v1/chat/completions BEFORE invoking provider
  const uC = await setupUser(baseUrl, 'red01c@nox.test', 0);
  const rC = await slowChunkedPost(
    port,
    '/v1/chat/completions',
    { Authorization: `Bearer ${uC.token}` },
    { messages: [{ role: 'user', content: 'hi' }], stream: false },
    async () => {
      const lo = await httpJson(baseUrl, '/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${uC.token}` } });
      assert.equal(lo.status, 200);
    },
  );
  assert.equal(rC.status, 401);
  assert.equal(upstreamCalls, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE account_id = ?').get(uC.account.id).n, 0);

  // Also check aborted client mid-body frees request resources/inflight slot cleanly
  const uAbort = await setupUser(baseUrl, 'red01-abort@nox.test', 0);
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.write([
          'POST /v1/chat/completions HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          `Authorization: Bearer ${uAbort.token}`,
          'Content-Type: application/json',
          'Content-Length: 200',
          '',
          '{"messages":',
        ].join('\r\n'));
        setTimeout(() => { s.destroy(); resolve(); }, 15);
      });
      s.on('error', () => resolve());
    });
  }
  const okComp = await httpJson(baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${uAbort.token}` },
    body: { messages: [{ role: 'user', content: 'ok' }], stream: false },
  });
  assert.equal(okComp.status, 200);
  assert.equal(upstreamCalls, 1);

  // RED-01d: TTL expiry mid-body blocks /v1/link/sessions/open without extra HTTP request
  const uD = await setupUser(baseUrl, 'red01d@nox.test', 2);
  const rD = await slowChunkedPost(
    port,
    '/v1/link/sessions/open',
    { Authorization: `Bearer ${uD.token}`, 'X-Nox-Device-Id': uD.devices[0].deviceId },
    { targetDeviceId: uD.devices[1].deviceId },
    async () => {
      clock += 1500;
    },
  );
  assert.equal(rD.status, 401);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM link_rooms WHERE account_id = ?').get(uD.account.id).n, 0);
});

test('SQLite nested _inTx SAVEPOINT rollback, LinkStore fallback SAVEPOINT, SQLITE_BUSY bounds, and crash recovery', async (t) => {
  const { dir, dbFile, addCleanup } = makeTempDb(t);
  const store = new Store(dbFile);
  addCleanup(() => store.close());

  // 1. Multi-level SAVEPOINT on Store._inTx
  store._inTx(() => {
    store.recordAttempt('outer-1', 1000);
    store._inTx(() => {
      store.recordAttempt('inner-commit', 1001);
    });
    try {
      store._inTx(() => {
        store.recordAttempt('inner-partial-1', 1002);
        try {
          store._inTx(() => {
            store.recordAttempt('deep-partial-2', 1003);
            throw new Error('deep-fail');
          });
        } catch {
          // caught inside middle savepoint, now middle writes another partial and fails too
        }
        store.recordAttempt('inner-partial-3', 1004);
        throw new Error('middle-fail');
      });
    } catch {
      // caught by outer tx
    }
    store.recordAttempt('outer-2', 1005);
  });

  assert.equal(store._txDepth, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE key = 'outer-1'").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE key = 'inner-commit'").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE key = 'outer-2'").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE key LIKE 'inner-partial-%' OR key LIKE 'deep-partial-%'").get().n, 0);

  // 2. LinkStore fallback _inTx SAVEPOINT (when store._inTx is absent)
  const fallbackStore = {
    db: store.db,
    accountByToken: store.accountByToken.bind(store),
    tooMany: store.tooMany.bind(store),
    recordAttempt: (k, ts) => store.db.prepare('INSERT INTO attempts (key, at) VALUES (?, ?)').run(k, ts),
  };
  const fallbackLink = new LinkStore(fallbackStore);
  fallbackLink._inTx(() => {
    fallbackStore.recordAttempt('fb-outer', 2000);
    try {
      fallbackLink._inTx(() => {
        fallbackStore.recordAttempt('fb-inner-fail', 2001);
        throw new Error('fb-boom');
      });
    } catch {
      // handled
    }
  });
  assert.equal(fallbackLink._fallbackTxDepth, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE key = 'fb-outer'").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE key = 'fb-inner-fail'").get().n, 0);

  // 3. Persistent SQLITE_BUSY does NOT block event loop for seconds when lock won't clear
  const busyFile = path.join(dir, 'busy.db');
  const busyStore = new Store(busyFile, { busyTimeoutMs: 10 });
  addCleanup(() => busyStore.close());
  const acc = busyStore.createAccount({ email: 'busy@nox.test', password: 'Password1234!', plan: 'trial', trialUntil: Date.now() + 86400_000, now: Date.now() });

  let workerExited = false;
  const lockReady = new Promise((resolve, reject) => {
    const w = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.busyFile);
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      parentPort.once('message', (msg) => {
        if (msg === 'unlock') {
          try { db.exec('ROLLBACK'); db.close(); } catch {}
          parentPort.postMessage('unlocked');
        }
      });
    `, { eval: true, workerData: { busyFile } });
    w.once('error', reject);
    w.once('exit', () => { workerExited = true; });
    w.on('message', (m) => { if (m === 'locked') resolve(w); });
  });
  const worker = await lockReady;
  addCleanup(async () => {
    if (!workerExited) {
      worker.postMessage('unlock');
      await Promise.race([
        new Promise((r) => worker.once('exit', r)),
        delay(300).then(() => worker.terminate()),
      ]);
    }
  });

  const started = Date.now();
  assert.throws(() => {
    busyStore.charge(acc.id, { usd: 0.01, estimated: false, now: Date.now() });
  }, /SQLITE_BUSY|database is locked/i);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 600, `persistent SQLITE_BUSY blocked event loop too long: ${elapsed}ms`);

  // Release lock and verify next charge + backup succeed cleanly
  const unlocked = new Promise((r) => worker.on('message', (m) => { if (m === 'unlocked') r(); }));
  worker.postMessage('unlock');
  await unlocked;
  if (!workerExited) await new Promise((r) => worker.once('exit', r));
  busyStore.openWindows(acc.id, Date.now());
  busyStore.charge(acc.id, { usd: 0.01, estimated: false, now: Date.now() });
  const bakFile = path.join(dir, 'backup.db');
  busyStore.backupTo(bakFile);
  const bak = new Store(bakFile);
  addCleanup(() => bak.close());
  assert.equal(bak.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('RED-02 [P1]: idempotent revoke enforces window rate limit without duplicate SSE or pending spam', async (t) => {
  const { dbFile, addCleanup } = makeTempDb(t);
  const { server, store } = createServer({
    dbFile,
    models: TEST_MODELS,
    link: {
      maxDeviceRevocationsPerWindow: 2,
      deviceOpWindowMs: 60_000,
      sseHeartbeatMs: 60_000,
    },
  });
  addCleanup(async () => {
    await closeAsync(server);
    store.close();
  });
  const { port, baseUrl } = await listen(server);
  const { token, devices } = await setupUser(baseUrl, 'red02@nox.test', 2);

  const ssePeer = await openSseRaw(port, { token, deviceId: devices[1].deviceId });
  assert.equal(ssePeer.status, 200);
  addCleanup(() => ssePeer.sock.destroy());

  const rev1 = await httpJson(baseUrl, `/v1/link/devices/${devices[0].deviceId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(rev1.status, 200);

  const p1 = await httpJson(baseUrl, '/v1/link/pending', {
    headers: { Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devices[1].deviceId },
  });
  assert.equal(p1.json.events.filter((e) => e.type === 'link.device.revoked').length, 1);

  const repeatStatuses = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await httpJson(baseUrl, `/v1/link/devices/${devices[0].deviceId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    repeatStatuses.push(r.status);
  }
  assert.deepEqual(repeatStatuses, [200, 429, 429, 429]);
  await delay(50);

  const sseDump = ssePeer.rawChunks.join('');
  assert.equal((sseDump.match(/event:\s*link\.device\.revoked/g) || []).length, 1);

  const p2 = await httpJson(baseUrl, '/v1/link/pending', {
    headers: { Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devices[1].deviceId },
  });
  assert.equal(p2.json.events.filter((e) => e.type === 'link.device.revoked').length, 0);
});

test('RED-03 & RED-04 & RED-06 [P1]: post-close SSE block, slow-POST shutdown, admitToRoom persistence, and 408 socket termination', async (t) => {
  // 1. RED-03a: post-close handleHttp/handleEvents cannot register SSE
  {
    const { dbFile, addCleanup } = makeTempDb(t);
    const { server, store, service } = createLinkServer({ dbFile, sseHeartbeatMs: 60_000 });
    addCleanup(async () => {
      await closeAsync(server, 500);
      store.close();
    });
    const acc = store.createAccount({ email: 'r3a@nox.test', password: 'Password1234!', plan: 'trial', trialUntil: Date.now() + 86400_000, now: Date.now() });
    const tok = store.issueToken(acc.id, Date.now());
    const d1 = crypto.randomUUID();
    service.linkStore.registerDevice({ accountId: acc.id, deviceId: d1, deviceName: 'D1', rootCaFp256: fp256() });
    service.close();

    const sock = Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1', destroyed: false, destroy() { this.destroyed = true; }, setNoDelay() {} });
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/v1/link/events', headers: { authorization: `Bearer ${tok}`, 'x-nox-device-id': d1 }, socket: sock, aborted: false, destroyed: false, setTimeout() {} });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { socket: sock, headersSent: false, destroyed: false, writableEnded: false, setTimeout() {}, writeHead(c) { status = c; this.headersSent = true; }, flushHeaders() {}, write() { return true; }, end() { this.writableEnded = true; } });
    await service.handleHttp(req, res);
    assert.equal(status, 503);
    assert.equal(service.stats().activeSseCount, 0);
  }

  // 2. RED-03b: server.close terminates slow-body POST sockets immediately
  {
    const { dbFile, addCleanup } = makeTempDb(t);
    const { server, store } = createServer({ dbFile, models: TEST_MODELS, bodyTimeoutMs: 30_000, link: { bodyTimeoutMs: 30_000 } });
    addCleanup(async () => {
      await closeAsync(server, 500);
      store.close();
    });
    const { port, baseUrl } = await listen(server);
    const { token } = await setupUser(baseUrl, 'r3b@nox.test', 1);

    const s1 = net.connect({ host: '127.0.0.1', port });
    const s2 = net.connect({ host: '127.0.0.1', port });
    s1.on('error', () => {});
    s2.on('error', () => {});
    addCleanup(() => { s1.destroy(); s2.destroy(); });
    await Promise.all([new Promise((r) => s1.once('connect', r)), new Promise((r) => s2.once('connect', r))]);
    s1.write(`POST /v1/link/devices/register HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"deviceId":"`);
    s2.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"messages":[`);
    await delay(30);

    const closedRes = await closeAsync(server, 500);
    assert.equal(closedRes.timedOut, false);
  }

  // 2b. RED-03b (createLinkServer standalone): slow-body POST closes promptly too
  {
    const { dbFile, addCleanup } = makeTempDb(t);
    const { server, store, service } = createLinkServer({ dbFile, bodyTimeoutMs: 30_000 });
    addCleanup(async () => {
      await closeAsync(server, 500);
      store.close();
    });
    const acc = store.createAccount({ email: 'r3link@nox.test', password: 'Password1234!', plan: 'trial', trialUntil: Date.now() + 86400_000, now: Date.now() });
    const tok = store.issueToken(acc.id, Date.now());
    const { port } = await listen(server);
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('error', () => {});
    addCleanup(() => s.destroy());
    await new Promise((r) => s.once('connect', r));
    s.write(`POST /v1/link/devices/register HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${tok}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"deviceId":"`);
    await delay(30);
    const closedLink = await closeAsync(server, 500);
    assert.equal(closedLink.timedOut, false);
    assert.ok(service);
  }

  // 3. RED-04: admitToRoom persists closed_at/close_reason and clears stale pending invite on expired and device_revoked rooms
  {
    const { dbFile, addCleanup } = makeTempDb(t);
    let clock = 1_700_000_000_000;
    const { server, store, link } = createServer({
      dbFile,
      models: TEST_MODELS,
      now: () => clock,
      link: { sessionTtlMs: 1000, relayWaitTimeoutMs: 1000 },
    });
    addCleanup(async () => {
      await closeAsync(server);
      store.close();
    });
    const { port, baseUrl } = await listen(server);
    const { token, account, devices } = await setupUser(baseUrl, 'r4@nox.test', 2);

    const open = await httpJson(baseUrl, '/v1/link/sessions/open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devices[0].deviceId },
      body: { targetDeviceId: devices[1].deviceId },
    });
    assert.equal(open.status, 201);
    const pendingBefore = await httpJson(baseUrl, '/v1/link/pending', {
      headers: { Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devices[1].deviceId },
    });
    const clientTicket = pendingBefore.json.events[0].data.clientTicket;

    clock += 1500;
    const up = await connectUpgradeRaw(port, {
      Authorization: `Bearer ${token}`,
      'X-Nox-Device-Id': devices[1].deviceId,
      'X-Nox-Room-Id': open.json.roomId,
      'X-Nox-Join-Ticket': clientTicket,
    });
    assert.equal(up.status, 403);
    assert.equal(up.bodyJson?.error?.code, 'ticket_expired');

    const row = store.db.prepare('SELECT closed_at, close_reason FROM link_rooms WHERE room_id = ?').get(open.json.roomId);
    assert.ok(row && row.closed_at !== null);
    assert.equal(row.close_reason, 'expired');

    const pendingAfter = await httpJson(baseUrl, '/v1/link/pending', {
      headers: { Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devices[1].deviceId },
    });
    assert.equal(pendingAfter.json.events.length, 0);

    // Also verify device_revoked persists close_reason = 'device_revoked' when admitToRoom denies an unclosed room
    const roomRev = link.linkStore.createRoom({
      accountId: account.id,
      purpose: 'session',
      hostDeviceId: devices[0].deviceId,
      clientDeviceId: devices[1].deviceId,
      now: clock,
    });
    store.db.prepare('UPDATE link_devices SET revoked_at = ? WHERE device_id = ?').run(clock, devices[0].deviceId);
    assert.throws(
      () => link.linkStore.admitToRoom({
        accountId: account.id,
        deviceId: devices[1].deviceId,
        roomId: roomRev.roomId,
        joinTicket: roomRev.clientTicket,
        now: clock,
      }),
      (err) => err instanceof LinkError && err.code === 'device_revoked',
    );
    const rowRev = store.db.prepare('SELECT closed_at, close_reason FROM link_rooms WHERE room_id = ?').get(roomRev.roomId);
    assert.ok(rowRev && rowRev.closed_at !== null);
    assert.equal(rowRev.close_reason, 'device_revoked');
  }

  // 4. RED-06: 408 request_timeout responds Connection: close and closes socket cleanly on both server.js and link-relay.js
  {
    const { dbFile, addCleanup } = makeTempDb(t);
    const { server, store } = createServer({
      dbFile,
      models: TEST_MODELS,
      bodyTimeoutMs: 50,
      link: { bodyTimeoutMs: 50 },
    });
    addCleanup(async () => {
      await closeAsync(server, 500);
      store.close();
    });
    const { port, baseUrl } = await listen(server);
    const { token } = await setupUser(baseUrl, 'r6@nox.test', 1);

    for (const targetPath of ['/v1/link/devices/register', '/v1/auth/login']) {
      const res = await new Promise((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port });
        let buf = '';
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error(`408 close timeout on ${targetPath}: ${buf}`));
        }, 1000);
        sock.on('error', () => {
          // ignore if closed cleanly
        });
        sock.on('close', () => {
          clearTimeout(timer);
          resolve(buf);
        });
        sock.on('data', (d) => {
          buf += d.toString('utf8');
        });
        sock.once('connect', () => {
          sock.write([
            `POST ${targetPath} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            `Authorization: Bearer ${token}`,
            'Content-Type: application/json',
            'Content-Length: 500',
            '',
            '{"partial":',
          ].join('\r\n'));
        });
      });
      assert.match(res, /^HTTP\/1\.1 408 /);
      assert.match(res, /Connection:\s*close/i);
      assert.match(res, /"code":"request_timeout"/);
    }

    // Keep-alive http.Agent recovers cleanly across a 408 and completes subsequent GET
    const agent = new http.Agent({ keepAlive: true });
    addCleanup(() => agent.destroy());
    const r408 = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/link/devices/register',
        agent,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': '500' },
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, conn: res.headers.connection, body }));
      });
      req.on('error', reject);
      req.write('{"partial":');
    });
    assert.equal(r408.status, 408);
    assert.equal(r408.conn, 'close');

    const rNext = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/v1/link/devices',
        agent,
        headers: { Authorization: `Bearer ${token}` },
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(rNext.status, 200);
  }
});
