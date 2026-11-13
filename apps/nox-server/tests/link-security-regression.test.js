'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Duplex } = require('stream');
const { Worker } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');

const { createServer } = require('../server');
const { Store } = require('../store');
const { createLinkService, createLinkServer, redact } = require('../link-relay');
const { createProxyResolver, normalizeIp, isLoopbackAddress } = require('../proxy');

const PRICE = { inputPerM: 1, cachedPerM: 0.1, outputPerM: 2 };
const NOW = Date.parse('2026-11-13T09:00:00Z');
const MIN = 60 * 1000;

function makeUuidV4() {
  return crypto.randomUUID().toLowerCase();
}

function makePlans(dir) {
  const plansFile = path.join(dir, 'plans.json');
  fs.writeFileSync(plansFile, JSON.stringify({
    trial: { title: 'Пробный', priceUsd: 0, sessionUsd: 0.5, weekUsd: 2.5, trialDays: 7 },
    pro: { title: 'Pro', priceUsd: 10, sessionUsd: 2, weekUsd: 10 },
  }));
  return plansFile;
}

async function startIntegratedHarness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-sec-reg-'));
  const plansFile = makePlans(dir);
  const clock = { ms: overrides.now || NOW };
  const dbFile = path.join(dir, 'nox.db');

  const core = createServer({
    dbFile,
    models: {
      fast: { url: 'http://provider', key: 'PROVIDER-SECRET-KEY', model: 'm1', price: PRICE },
    },
    plansFile,
    adminKey: 'admin-secret-key-99999',
    fetchImpl: overrides.fetchImpl || (async () => new Response('')),
    now: () => clock.ms,
    link: { sseHeartbeatMs: 0, ...overrides.linkConfig },
    ...overrides.serverConfig,
  });

  await new Promise((resolve) => core.server.listen(0, '127.0.0.1', resolve));
  const port = core.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const openSockets = new Set();
  const openSseClosers = new Set();

  t.after(async () => {
    for (const closeSse of openSseClosers) closeSse();
    for (const s of openSockets) {
      if (!s.destroyed) s.destroy();
    }
    if (typeof core.server.closeIdleConnections === 'function') core.server.closeIdleConnections();
    await new Promise((resolve) => core.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method, url, { token, body, raw, headers = {} } = {}) => {
    const reqHeaders = { ...headers };
    if (token) reqHeaders.Authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) reqHeaders['Content-Type'] = 'application/json';
    const res = await fetch(base + url, {
      method,
      headers: reqHeaders,
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* noop */ }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
  };

  const registerUser = async (email = 'owner@nox.test', password = 'password123') => {
    const res = await call('POST', '/v1/auth/register', { body: { email, password } });
    assert.equal(res.status, 201);
    return res.json;
  };

  const registerDevice = async (token, { deviceId = makeUuidV4(), deviceName = 'PC', headers = {} } = {}) => {
    const res = await call('POST', '/v1/link/devices/register', {
      token,
      headers,
      body: { deviceId, deviceName },
    });
    assert.ok(res.status === 200 || res.status === 201);
    return { deviceId, res };
  };

  const openSse = (token, deviceId, extraHeaders = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/v1/link/events',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(deviceId ? { 'X-Nox-Device-Id': deviceId } : {}),
        ...extraHeaders,
      },
    });
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* noop */ }
          resolve({ status: res.statusCode, json, text: raw });
        });
        return;
      }

      let closed = false;
      let buf = '';
      const queue = [];
      const waiters = [];
      const closeWaiters = [];

      const markClosed = () => {
        if (closed) return;
        closed = true;
        while (waiters.length) waiters.shift().reject(new Error('SSE stream closed'));
        while (closeWaiters.length) closeWaiters.shift()();
      };

      const dispatch = (ev) => {
        for (let i = 0; i < waiters.length; i += 1) {
          if (waiters[i].pred(ev)) {
            const w = waiters.splice(i, 1)[0];
            clearTimeout(w.timer);
            w.resolve(ev);
            return;
          }
        }
        queue.push(ev);
      };

      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!block.trim() || block.startsWith(':')) continue;
          let type = 'message';
          let id = null;
          let dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('id:')) id = line.slice(3).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          let data = dataStr;
          try { data = JSON.parse(dataStr); } catch { /* noop */ }
          dispatch({ type, id, data });
        }
      });
      res.on('end', markClosed);
      res.on('close', markClosed);
      res.on('error', markClosed);

      const close = () => {
        req.destroy();
        if (!res.destroyed) res.destroy();
        markClosed();
      };
      openSseClosers.add(close);

      const nextEvent = (pred = () => true, timeoutMs = 2000) => {
        const hit = queue.findIndex(pred);
        if (hit !== -1) return Promise.resolve(queue.splice(hit, 1)[0]);
        if (closed) return Promise.reject(new Error('SSE already closed'));
        return new Promise((resEv, rejEv) => {
          const entry = {
            pred,
            resolve: resEv,
            reject: rejEv,
            timer: setTimeout(() => {
              const idx = waiters.indexOf(entry);
              if (idx !== -1) waiters.splice(idx, 1);
              rejEv(new Error('SSE event timeout'));
            }, timeoutMs),
          };
          waiters.push(entry);
        });
      };

      const waitClosed = (timeoutMs = 2000) => {
        if (closed) return Promise.resolve();
        return new Promise((resClose, rejClose) => {
          const timer = setTimeout(() => rejClose(new Error('SSE waitClosed timeout')), timeoutMs);
          closeWaiters.push(() => { clearTimeout(timer); resClose(); });
        });
      };

      nextEvent((e) => e.type === 'ready', 2000).then((ready) => {
        resolve({ status: 200, ready, nextEvent, waitClosed, close, isClosed: () => closed });
      }, reject);
    });
    req.on('error', reject);
    req.end();
  });

  const upgradeRelay = ({ token, deviceId, roomId, ticket, extraHeaders = {} }) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/v1/link/relay',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'nox-link',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(deviceId ? { 'X-Nox-Device-Id': deviceId } : {}),
        ...(roomId ? { 'X-Nox-Room-Id': roomId } : {}),
        ...(ticket ? { 'X-Nox-Join-Ticket': ticket } : {}),
        ...extraHeaders,
      },
    });
    req.on('upgrade', (_res, socket, head) => {
      openSockets.add(socket);
      resolve({ ok: true, socket, head });
    });
    req.on('response', (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* noop */ }
        resolve({ ok: false, status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });

  const openWaitingRelay = async ({ token, deviceId, roomId, ticket, allowHalfOpen = false }) => {
    const sock = net.connect({ host: '127.0.0.1', port, allowHalfOpen });
    openSockets.add(sock);
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    sock.on('error', () => { /* ожидаемый сброс при закрытии сервером */ });
    if (!allowHalfOpen) sock.resume();
    sock.write([
      'GET /v1/link/relay HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Connection: Upgrade',
      'Upgrade: nox-link',
      `Authorization: Bearer ${token}`,
      `X-Nox-Device-Id: ${deviceId}`,
      `X-Nox-Room-Id: ${roomId}`,
      `X-Nox-Join-Ticket: ${ticket}`,
      '',
      '',
    ].join('\r\n'));
    const deadline = Date.now() + 1500;
    while (core.link.stats().waitingRooms === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return sock;
  };

  return { dir, dbFile, plansFile, clock, core, port, base, call, registerUser, registerDevice, openSse, upgradeRelay, openWaitingRelay };
}

class MockSocket extends Duplex {
  constructor({ throwOnWrite = false, asyncWriteErr = null, unusable = false, stallWrites = false, highWaterMark } = {}) {
    super(highWaterMark ? { highWaterMark } : undefined);
    this.throwOnWrite = throwOnWrite;
    this.asyncWriteErr = asyncWriteErr;
    this.stallWrites = stallWrites;
    this._stalledCbs = [];
    this.written = [];
    this.remoteAddress = '127.0.0.1';
    this.allowHalfOpen = true;
    if (unusable) {
      this.destroy();
    }
  }
  _read() {}
  _write(chunk, _enc, cb) {
    if (this.throwOnWrite) {
      throw new Error('sync write failure');
    }
    if (this.asyncWriteErr) {
      queueMicrotask(() => cb(this.asyncWriteErr));
      return;
    }
    this.written.push(Buffer.from(chunk));
    if (this.stallWrites) {
      this._stalledCbs.push(cb);
      return;
    }
    cb();
  }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  cork() {}
  uncork() {}
}

function waitSocketClose(socket, timeoutMs = 2000) {
  if (!socket || socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket close timeout')), timeoutMs);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

// ── NEG-1: Безопасность сокетов — TDZ ReferenceError, ошибка записи HTTP 101, сбой 2-го сокета, error listeners
test('NEG-1 [P0-1]: ошибка записи 101 и сбой второго сокета не вызывают TDZ/краш и освобождают оба сокета', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-neg1-'));
  const store = new Store(path.join(dir, 'nox.db'));
  const acc = store.createAccount({ email: 'sock@nox.test', password: 'password123', plan: 'trial', trialUntil: NOW + 7 * 86400e3, now: NOW });
  const token = store.issueToken(acc.id, NOW);
  const service = createLinkService({ store, now: () => NOW, sseHeartbeatMs: 0 });
  t.after(() => {
    service.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const devA = makeUuidV4();
  const devB = makeUuidV4();
  service.linkStore.registerDevice({ accountId: acc.id, deviceId: devA, deviceName: 'A', now: NOW });
  service.linkStore.registerDevice({ accountId: acc.id, deviceId: devB, deviceName: 'B', now: NOW });

  // Сценарий А: синхронная ошибка socket.write при отправке HTTP 101 (ранее падало ReferenceError: torn TDZ).
  const r1 = service.linkStore.createRoom({ accountId: acc.id, purpose: 'session', hostDeviceId: devA, clientDeviceId: devB, now: NOW });
  const sockA1 = new MockSocket();
  const sockB1 = new MockSocket({ throwOnWrite: true });

  service.handleUpgrade({
    url: '/v1/link/relay',
    method: 'GET',
    headers: { upgrade: 'nox-link', authorization: `Bearer ${token}`, 'x-nox-device-id': devA, 'x-nox-room-id': r1.roomId, 'x-nox-join-ticket': r1.hostTicket },
    socket: { remoteAddress: '127.0.0.1' },
  }, sockA1, Buffer.alloc(0));
  assert.equal(service.stats().waitingRooms, 1);

  assert.doesNotThrow(() => {
    service.handleUpgrade({
      url: '/v1/link/relay',
      method: 'GET',
      headers: { upgrade: 'nox-link', authorization: `Bearer ${token}`, 'x-nox-device-id': devB, 'x-nox-room-id': r1.roomId, 'x-nox-join-ticket': r1.clientTicket },
      socket: { remoteAddress: '127.0.0.1' },
    }, sockB1, Buffer.alloc(0));
  });

  assert.equal(sockA1.destroyed, true);
  assert.equal(sockB1.destroyed, true);
  assert.equal(service.stats().activeRooms, 0);
  const dbRow1 = store.db.prepare('SELECT closed_at, close_reason FROM link_rooms WHERE room_id = ?').get(r1.roomId);
  assert.ok(dbRow1.closed_at !== null);
  assert.equal(dbRow1.close_reason, 'write_failed');
  // Поздняя ошибка на разрушенном сокете не должна ронять процесс (защитный error listener не удалён).
  assert.doesNotThrow(() => sockA1.emit('error', new Error('late socket error after destroy')));
  assert.doesNotThrow(() => sockB1.emit('error', new Error('late socket error after destroy')));

  // Сценарий Б: асинхронная ошибка записи 101 на втором сокете.
  const r2 = service.linkStore.createRoom({ accountId: acc.id, purpose: 'session', hostDeviceId: devA, clientDeviceId: devB, now: NOW });
  const sockA2 = new MockSocket();
  const sockB2 = new MockSocket({ asyncWriteErr: new Error('async EPIPE on 101') });
  service.handleUpgrade({
    url: '/v1/link/relay',
    method: 'GET',
    headers: { upgrade: 'nox-link', authorization: `Bearer ${token}`, 'x-nox-device-id': devA, 'x-nox-room-id': r2.roomId, 'x-nox-join-ticket': r2.hostTicket },
    socket: { remoteAddress: '127.0.0.1' },
  }, sockA2, Buffer.alloc(0));
  service.handleUpgrade({
    url: '/v1/link/relay',
    method: 'GET',
    headers: { upgrade: 'nox-link', authorization: `Bearer ${token}`, 'x-nox-device-id': devB, 'x-nox-room-id': r2.roomId, 'x-nox-join-ticket': r2.clientTicket },
    socket: { remoteAddress: '127.0.0.1' },
  }, sockB2, Buffer.alloc(0));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sockA2.destroyed, true);
  assert.equal(sockB2.destroyed, true);
  assert.equal(service.stats().activeRooms, 0);

  // Сценарий В: второй сокет уже повреждён/непригоден к моменту bridgeSockets.
  const r3 = service.linkStore.createRoom({ accountId: acc.id, purpose: 'session', hostDeviceId: devA, clientDeviceId: devB, now: NOW });
  const sockA3 = new MockSocket();
  const sockB3 = new MockSocket();
  service.handleUpgrade({
    url: '/v1/link/relay',
    method: 'GET',
    headers: { upgrade: 'nox-link', authorization: `Bearer ${token}`, 'x-nox-device-id': devA, 'x-nox-room-id': r3.roomId, 'x-nox-join-ticket': r3.hostTicket },
    socket: { remoteAddress: '127.0.0.1' },
  }, sockA3, Buffer.alloc(0));
  // Симулируем закрытие на уровне чтения перед мостом, но уже после проверки unusable при входе.
  sockB3.end();
  service.handleUpgrade({
    url: '/v1/link/relay',
    method: 'GET',
    headers: { upgrade: 'nox-link', authorization: `Bearer ${token}`, 'x-nox-device-id': devB, 'x-nox-room-id': r3.roomId, 'x-nox-join-ticket': r3.clientTicket },
    socket: { remoteAddress: '127.0.0.1' },
  }, sockB3, Buffer.alloc(0));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sockB3.destroyed, true);

  // Проверяем, что сервер после повреждённых каналов полностью работоспособен для нового соединения.
  const rOk = service.linkStore.createRoom({ accountId: acc.id, purpose: 'session', hostDeviceId: devA, clientDeviceId: devB, now: NOW });
  const sockAOk = new MockSocket();
  const sockBOk = new MockSocket();
  service.handleUpgrade({
    url: '/v1/link/relay',
    method: 'GET',
    headers: { upgrade: 'nox-link', authorization: `Bearer ${token}`, 'x-nox-device-id': devA, 'x-nox-room-id': rOk.roomId, 'x-nox-join-ticket': rOk.hostTicket },
    socket: { remoteAddress: '127.0.0.1' },
  }, sockAOk, Buffer.alloc(0));
  service.handleUpgrade({
    url: '/v1/link/relay',
    method: 'GET',
    headers: { upgrade: 'nox-link', authorization: `Bearer ${token}`, 'x-nox-device-id': devB, 'x-nox-room-id': rOk.roomId, 'x-nox-join-ticket': rOk.clientTicket },
    socket: { remoteAddress: '127.0.0.1' },
  }, sockBOk, Buffer.alloc(0));
  assert.equal(service.stats().bridgedRooms, 1);
  assert.ok(Buffer.concat(sockAOk.written).toString('utf8').includes('101 Switching Protocols'));
});

// ── NEG-2: Half-open соединения
test('NEG-2 [P0-1]: half-open соединения в ожидании и в активном мосту гарантированно закрываются', async (t) => {
  const h = await startIntegratedHarness(t, { linkConfig: { halfOpenGraceMs: 60 } });
  const a = await h.registerUser();
  const { deviceId: devA } = await h.registerDevice(a.token, { deviceName: 'A' });
  const { deviceId: devB } = await h.registerDevice(a.token, { deviceName: 'B' });

  // 1. Half-open на первом ожидающем сокете (FIN до прихода второго участника).
  const s1 = (await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  })).json;
  const u1Sock = await h.openWaitingRelay({ token: a.token, deviceId: devA, roomId: s1.roomId, ticket: s1.hostTicket, allowHalfOpen: true });
  assert.equal(h.core.link.stats().waitingRooms, 1);
  u1Sock.end(); // полузакрытие со стороны клиента (FIN)
  await waitSocketClose(u1Sock);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.core.link.stats().activeRooms, 0);

  // 2. Half-open на сбридженном канале: клиент А шлёт данные и end(), оба сокета гарантированно закрываются после доставки.
  const s2 = (await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  })).json;
  const pend2 = (await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devB } })).json;
  const [cA, cB] = await Promise.all([
    h.upgradeRelay({ token: a.token, deviceId: devA, roomId: s2.roomId, ticket: s2.hostTicket }),
    h.upgradeRelay({ token: a.token, deviceId: devB, roomId: s2.roomId, ticket: pend2.events[0].data.clientTicket }),
  ]);
  assert.equal(cA.ok && cB.ok, true);

  let gotTail = '';
  cB.socket.on('data', (d) => { gotTail += d.toString('utf8'); });
  cA.socket.end('final-tail-payload');

  await Promise.all([waitSocketClose(cA.socket), waitSocketClose(cB.socket)]);
  assert.equal(gotTail, 'final-tail-payload');
  assert.equal(h.core.link.stats().activeRooms, 0);
});

// ── NEG-3: Logout, Disable, Отзыв устройства во время активной передачи через РЕАЛЬНЫЕ маршруты server.js
test('NEG-3 [P0-2]: реальные маршруты /logout, /admin/disable и /revoke рвут SSE, реле и completions; по умолчанию Link выключен', async (t) => {
  // 1. По умолчанию публичные маршруты Nox Link в createServer выключены (404).
  const dirOff = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-off-'));
  const offCore = createServer({
    dbFile: path.join(dirOff, 'off.db'),
    models: { fast: { url: 'http://provider', key: 'k', model: 'm', price: PRICE } },
    plansFile: makePlans(dirOff),
  });
  await new Promise((r) => offCore.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => offCore.server.close(r));
    fs.rmSync(dirOff, { recursive: true, force: true });
  });
  const offPort = offCore.server.address().port;
  const offRes = await fetch(`http://127.0.0.1:${offPort}/v1/link/devices`);
  assert.equal(offRes.status, 404);
  assert.equal(offCore.link, null);

  // 2. Интеграционная проверка реальных маршрутов на server.js.
  let streamController = null;
  let streamChunkCount = 0;
  const h = await startIntegratedHarness(t, {
    fetchImpl: async (_url, init) => {
      const stream = new ReadableStream({
        start(ctrl) {
          streamController = ctrl;
          ctrl.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
          streamChunkCount += 1;
        },
        cancel() {
          streamController = null;
        },
      });
      init.signal.addEventListener('abort', () => {
        try { streamController?.close(); } catch { /* noop */ }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const reg = await h.registerUser('life@nox.test', 'password123');
  const login2 = (await h.call('POST', '/v1/auth/login', { body: { email: 'life@nox.test', password: 'password123' } })).json;
  const token1 = reg.token;
  const token2 = login2.token;

  const { deviceId: devA } = await h.registerDevice(token1, { deviceName: 'A' });
  const { deviceId: devB } = await h.registerDevice(token2, { deviceName: 'B' });

  const sseA = await h.openSse(token1, devA);
  const sseB = await h.openSse(token2, devB);
  assert.equal(sseA.status, 200);
  assert.equal(sseB.status, 200);
  assert.equal(h.core.link.stats().activeSseCount, 2);

  // Открываем релейный канал (token1 для host A, token2 для client B).
  const s1 = (await h.call('POST', '/v1/link/sessions/open', {
    token: token1,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  })).json;
  const invB = await sseB.nextEvent((e) => e.type === 'link.session.incoming');
  const [pipeA, pipeB] = await Promise.all([
    h.upgradeRelay({ token: token1, deviceId: devA, roomId: s1.roomId, ticket: s1.hostTicket }),
    h.upgradeRelay({ token: token2, deviceId: devB, roomId: s1.roomId, ticket: invB.data.clientTicket }),
  ]);
  assert.equal(pipeA.ok && pipeB.ok, true);

  // Запускаем потоковый /v1/chat/completions под token1.
  const chatAbort = new AbortController();
  const chatPromise = fetch(`${h.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], stream: true }),
    signal: chatAbort.signal,
  }).then(async (res) => {
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      return 'ended';
    } catch {
      return 'aborted';
    }
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(streamChunkCount, 1);

  // Логаут по реальному POST /v1/auth/logout с token1:
  // должен немедленно закрыть sseA, pipeA<->pipeB и поток completions, НЕ трогая sseB (token2).
  const logoutRes = await h.call('POST', '/v1/auth/logout', { token: token1 });
  assert.equal(logoutRes.status, 200);

  await Promise.all([sseA.waitClosed(), waitSocketClose(pipeA.socket), waitSocketClose(pipeB.socket)]);
  const chatDone = await chatPromise;
  assert.ok(chatDone === 'ended' || chatDone === 'aborted');
  assert.equal(sseB.isClosed(), false);
  assert.equal(h.core.link.stats().activeSseCount, 1);

  // Повторный доступ по отозванному token1 невозможен.
  assert.equal((await h.openSse(token1, devA)).status, 401);

  // Отзыв устройства во время активной передачи (devB -> devC под token2).
  const { deviceId: devC } = await h.registerDevice(token2, { deviceName: 'C' });
  const sseC = await h.openSse(token2, devC);
  const s2 = (await h.call('POST', '/v1/link/sessions/open', {
    token: token2,
    headers: { 'X-Nox-Device-Id': devB },
    body: { targetDeviceId: devC },
  })).json;
  const invC = await sseC.nextEvent((e) => e.type === 'link.session.incoming');
  const [trB, trC] = await Promise.all([
    h.upgradeRelay({ token: token2, deviceId: devB, roomId: s2.roomId, ticket: s2.hostTicket }),
    h.upgradeRelay({ token: token2, deviceId: devC, roomId: s2.roomId, ticket: invC.data.clientTicket }),
  ]);
  assert.equal(trB.ok && trC.ok, true);

  // Начинаем активную передачу, во время которой отзываем devB.
  let receivedBeforeRevoke = '';
  trC.socket.on('data', (chunk) => { receivedBeforeRevoke += chunk.toString('utf8'); });
  trB.socket.write('chunk-before-revoke:');
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(receivedBeforeRevoke.includes('chunk-before-revoke:'));

  const revokeRes = await h.call('POST', `/v1/link/devices/${devB}/revoke`, { token: token2 });
  assert.equal(revokeRes.status, 200);
  await Promise.all([waitSocketClose(trB.socket), waitSocketClose(trC.socket), sseB.waitClosed()]);
  assert.equal((await h.call('GET', '/v1/link/pending', { token: token2, headers: { 'X-Nox-Device-Id': devB } })).status, 403);
  assert.equal((await h.openSse(token2, devB)).status, 403);

  // Теперь реальный маршрут POST /v1/admin/disable: закрывает оставшиеся потоки SSE (sseC) и активные релеи аккаунта.
  const { deviceId: devD } = await h.registerDevice(token2, { deviceName: 'D' });
  const s3 = (await h.call('POST', '/v1/link/sessions/open', {
    token: token2,
    headers: { 'X-Nox-Device-Id': devC },
    body: { targetDeviceId: devD },
  })).json;
  const waitSockC = await h.openWaitingRelay({ token: token2, deviceId: devC, roomId: s3.roomId, ticket: s3.hostTicket });
  assert.equal(h.core.link.stats().waitingRooms, 1);

  const disRes = await h.call('POST', '/v1/admin/disable', {
    token: 'admin-secret-key-99999',
    body: { email: 'life@nox.test', disabled: true },
  });
  assert.equal(disRes.status, 200);
  await Promise.all([sseC.waitClosed(), waitSocketClose(waitSockC)]);
  assert.equal(h.core.link.stats().activeSseCount, 0);
  assert.equal(h.core.link.stats().activeRooms, 0);
  assert.equal((await h.call('GET', '/v1/link/devices', { token: token2 })).status, 401);
});

// ── NEG-4: Реакция на истечение токена во время SSE и в активном канале
test('NEG-4 [P0-2]: истечение TTL токена автоматически завершает открытый SSE-поток и активные каналы', async (t) => {
  // Реальный короткий TTL (wall-clock): без каких-либо действий клиента SSE закрывается сам.
  const h = await startIntegratedHarness(t, {
    now: () => Date.now(),
    serverConfig: { sessionTtlMs: 140, now: () => Date.now() },
    linkConfig: { sseHeartbeatMs: 0, now: () => Date.now() },
  });
  const a = await h.registerUser('exp@nox.test');
  const { deviceId: devA } = await h.registerDevice(a.token, { deviceName: 'A' });
  const sse = await h.openSse(a.token, devA);
  assert.equal(sse.status, 200);

  await sse.waitClosed(1500);
  assert.equal(h.core.link.stats().activeSseCount, 0);
  assert.equal((await h.call('GET', '/v1/link/devices', { token: a.token })).status, 401);
});

// ── NEG-5 & NEG-6: Доверие к прокси (spoofing XFF/XFP, цепочка прокси справа налево, HTTPS)
test('NEG-5 & NEG-6 [P0-3]: X-Forwarded-For/Proto игнорируются от недоверенных пиров, цепочка прокси разбирается справа налево', async (t) => {
  // 1. Unit-проверка createProxyResolver для всех комбинаций цепочек прокси и поддельных заголовков.
  const untrusted = createProxyResolver({ trustProxy: false });
  const spoofReq = {
    socket: { remoteAddress: '203.0.113.50', encrypted: false },
    headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' },
  };
  assert.equal(untrusted.clientIp(spoofReq), '203.0.113.50');
  assert.equal(untrusted.isSecureTransport(spoofReq), false);

  const loopbackTrusted = createProxyResolver({ trustProxy: true }); // по умолчанию только loopback
  assert.equal(loopbackTrusted.clientIp(spoofReq), '203.0.113.50');
  assert.equal(loopbackTrusted.isSecureTransport(spoofReq), false);

  const proxyOnlyTen = createProxyResolver({ trustProxy: true, trustedProxies: '10.0.0.0/8' });
  // Пир 127.0.0.1 НЕ входит в trustedProxies=['10.0.0.0/8'], значит заголовки игнорируются.
  assert.equal(proxyOnlyTen.clientIp({
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    headers: { 'x-forwarded-for': '198.51.100.77', 'x-forwarded-proto': 'https' },
  }), '127.0.0.1');

  // Цепочка Client(203.0.113.9) -> Edge(10.0.0.1) -> Nginx(10.0.0.2) -> Server, плюс подмена 198.51.100.77 слева:
  assert.equal(proxyOnlyTen.clientIp({
    socket: { remoteAddress: '::ffff:10.0.0.2', encrypted: false },
    headers: { 'x-forwarded-for': '198.51.100.77, 203.0.113.9, 10.0.0.1' },
  }), '203.0.113.9');

  // Мусорный хоп в XFF останавливает разбор, не доверяя подделанному левому адресу 127.0.0.1:
  assert.equal(proxyOnlyTen.clientIp({
    socket: { remoteAddress: '10.0.0.2', encrypted: false },
    headers: { 'x-forwarded-for': '127.0.0.1, bad-ip, 10.0.0.1' },
  }), '10.0.0.1');

  // Подмена протокола слева ('https, http') отклоняется:
  assert.equal(proxyOnlyTen.isSecureTransport({
    socket: { remoteAddress: '10.0.0.2', encrypted: false },
    headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https, http' },
  }), false);

  // Удалённый клиент через доверенный прокси БЕЗ X-Forwarded-Proto: https -> 403 (HTTPS обязателен!):
  assert.equal(loopbackTrusted.isSecureTransport({
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    headers: { 'x-forwarded-for': '203.0.113.9' },
  }), false);

  assert.equal(isLoopbackAddress('127.0.0.5'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('203.0.113.9'), false);
  assert.equal(normalizeIp('::ffff:10.1.2.3'), '10.1.2.3');

  // 2. Интеграционная проверка через HTTP сервер: доверенный прокси только 10.99.0.1 (подключения с 127.0.0.1 не являются доверенным прокси),
  // попытка обойти лимит логина в server.js через X-Forwarded-For НЕ срабатывает,
  // а allowPlainHttp не ослабляет проверку HTTPS для удалённого клиента через прокси.
  const h = await startIntegratedHarness(t, {
    serverConfig: { trustProxy: true, trustedProxies: ['10.99.0.1'], loginPer15Min: 3 },
    linkConfig: { allowPlainHttp: true },
  });
  await h.registerUser('p@nox.test', 'correctpass1');

  // Злоумышленник (с 127.0.0.1, не входящего в 10.99.0.1) подделывает разные X-Forwarded-For, пытаясь обойти лимит 3 попыток входа:
  for (let i = 0; i < 3; i += 1) {
    const r = await h.call('POST', '/v1/auth/login', {
      headers: { 'X-Forwarded-For': `198.51.100.${i + 10}` },
      body: { email: 'p@nox.test', password: 'wrongpass' },
    });
    assert.equal(r.status, 401);
  }
  // 4-я попытка с новым поддельным XFF всё равно блокируется (лимит на реальном 127.0.0.1!):
  const blocked = await h.call('POST', '/v1/auth/login', {
    headers: { 'X-Forwarded-For': '198.51.100.250' },
    body: { email: 'p@nox.test', password: 'wrongpass' },
  });
  assert.equal(blocked.status, 429);

  // Даже с allowPlainHttp: true удалённое подключение без HTTPS от доверенного прокси отвергается 403.
  const hProxy = await startIntegratedHarness(t, {
    serverConfig: { trustProxy: true, trustedProxies: ['127.0.0.1'] },
    linkConfig: { allowPlainHttp: true },
  });
  const acc = await hProxy.registerUser('remote@nox.test');
  const httpRemoteRes = await hProxy.call('GET', '/v1/link/devices', {
    token: acc.token,
    headers: { 'X-Forwarded-For': '203.0.113.88', 'X-Forwarded-Proto': 'http' },
  });
  assert.equal(httpRemoteRes.status, 403);
  assert.equal(httpRemoteRes.json.error.code, 'insecure_transport');

  const noProtoRemoteRes = await hProxy.call('GET', '/v1/link/devices', {
    token: acc.token,
    headers: { 'X-Forwarded-For': '203.0.113.88' },
  });
  assert.equal(noProtoRemoteRes.status, 403);

  // Удалённое подключение с корректным HTTPS на edge + валидной цепочкой прокси проходит.
  const httpsRemoteRes = await hProxy.call('GET', '/v1/link/devices', {
    token: acc.token,
    headers: { 'X-Forwarded-For': '127.0.0.1, 203.0.113.88, 127.0.0.1', 'X-Forwarded-Proto': 'https' },
  });
  assert.equal(httpsRemoteRes.status, 200);
});

// ── NEG-7: Учёт SSE при вытеснении
test('NEG-7 [P1-1]: вытеснение SSE при maxSsePerDevice=1 и 2 не теряет подписку из учёта sseByDevice', async (t) => {
  const h = await startIntegratedHarness(t, { linkConfig: { maxSsePerDevice: 1 } });
  const a = await h.registerUser();
  const { deviceId: devA } = await h.registerDevice(a.token, { deviceName: 'A' });
  const { deviceId: devB } = await h.registerDevice(a.token, { deviceName: 'B' });

  const sse1 = await h.openSse(a.token, devB);
  assert.equal(sse1.status, 200);
  assert.equal(h.core.link.stats().activeSseCount, 1);

  // Подключаем второй SSE — первый вытесняется, но второй ОБЯЗАТЕЛЬНО остаётся в живой Map и получает события!
  const sse2 = await h.openSse(a.token, devB);
  assert.equal(sse2.status, 200);
  await sse1.waitClosed();
  assert.equal(h.core.link.stats().activeSseCount, 1);

  // Диспатчим реальное приглашение и проверяем, что sse2 его получает.
  const opened = await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  });
  assert.equal(opened.status, 201);
  const ev = await sse2.nextEvent((e) => e.type === 'link.session.incoming');
  assert.equal(ev.data.roomId, opened.json.roomId);

  sse2.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.core.link.stats().activeSseCount, 0);
});

// ── NEG-8: Backpressure для медленного SSE и релейного клиента + Idle Timeout
test('NEG-8 [P1-2, P1-3]: медленное чтение SSE, backpressure и idle timeout на релее завершают зависшие каналы', async (t) => {
  const h = await startIntegratedHarness(t, {
    linkConfig: {
      maxOpenRoomsPerAccount: 10,
      maxSseBufferBytes: 256,
      sseDrainTimeoutMs: 100,
      maxRelayBufferBytes: 4096,
      relayDrainTimeoutMs: 120,
      relayIdleTimeoutMs: 160,
    },
  });
  const a = await h.registerUser();
  const { deviceId: devA } = await h.registerDevice(a.token, { deviceName: 'A' });
  const { deviceId: devB } = await h.registerDevice(a.token, { deviceName: 'B' });

  // 1. Медленный SSE-клиент: подключаем ServerResponse поверх сокета с низким highWaterMark и тормозим запись после ready.
  const sseSock = new MockSocket({ highWaterMark: 16 });
  const fakeReq = new EventEmitter();
  fakeReq.method = 'GET';
  fakeReq.url = '/v1/link/events';
  fakeReq.headers = {
    host: `127.0.0.1:${h.port}`,
    authorization: `Bearer ${a.token}`,
    'x-nox-device-id': devB,
  };
  fakeReq.socket = sseSock;
  fakeReq.setTimeout = () => {};
  fakeReq.destroy = () => {};
  const slowRes = new http.ServerResponse(fakeReq);
  slowRes.assignSocket(sseSock);
  await h.core.link.handleHttp(fakeReq, slowRes);
  assert.equal(slowRes.statusCode, 200);
  assert.equal(h.core.link.stats().activeSseCount, 1);

  // Симулируем забитый буфер отправки медленного клиента после получения заголовков и ready.
  sseSock.stallWrites = true;
  const slowClosed = waitSocketClose(sseSock, 2000).then(() => true, () => false);

  // Создаём несколько комнат, чтобы переполнить крошечный буфер медленного SSE (maxSseBufferBytes: 256, drainTimeout: 100ms).
  for (let i = 0; i < 3; i += 1) {
    await h.call('POST', '/v1/link/sessions/open', {
      token: a.token,
      headers: { 'X-Nox-Device-Id': devA },
      body: { targetDeviceId: devB },
    });
  }
  assert.equal(await slowClosed, true);
  assert.equal(sseSock.destroyed, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.core.link.stats().activeSseCount, 0);

  // Очищаем открытые комнаты, отзывая и регистрируя C/D для теста релея.
  const { deviceId: devC } = await h.registerDevice(a.token, { deviceName: 'C' });
  const { deviceId: devD } = await h.registerDevice(a.token, { deviceName: 'D' });

  // 2. Idle timeout на молчащем сбридженном session-релее (160ms).
  const idleSessRes = await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devC },
    body: { targetDeviceId: devD },
  });
  assert.equal(idleSessRes.status, 201);
  const idleSess = idleSessRes.json;
  const idlePendRes = await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devD } });
  assert.equal(idlePendRes.status, 200);
  const idlePend = idlePendRes.json;
  assert.ok(Array.isArray(idlePend.events) && idlePend.events.length >= 1);
  const [idleA, idleB] = await Promise.all([
    h.upgradeRelay({ token: a.token, deviceId: devC, roomId: idleSess.roomId, ticket: idleSess.hostTicket }),
    h.upgradeRelay({ token: a.token, deviceId: devD, roomId: idleSess.roomId, ticket: idlePend.events[0].data.clientTicket }),
  ]);
  assert.equal(idleA.ok && idleB.ok, true);
  await Promise.all([waitSocketClose(idleA.socket, 1500), waitSocketClose(idleB.socket, 1500)]);
  assert.equal(
    h.core.store.db.prepare('SELECT close_reason FROM link_rooms WHERE room_id = ?').get(idleSess.roomId).close_reason,
    'idle_timeout',
  );

  // 3. Backpressure overflow на медленном получателе релея (используем MockSocket напрямую на bridgeSockets / upgrade).
  const bRoom = h.core.link.linkStore.createRoom({
    accountId: a.account.id,
    purpose: 'session',
    hostDeviceId: devC,
    clientDeviceId: devD,
    now: Date.now(),
  });
  const senderSock = new MockSocket();
  const slowRecvSock = new MockSocket();
  // Замедленный потребитель держит высокий writableLength: подменяем write после 101 на возврат false + накопление.
  let afterHandshake = false;
  const origWrite = slowRecvSock.write.bind(slowRecvSock);
  slowRecvSock.write = (chunk, cb) => {
    if (!afterHandshake) {
      afterHandshake = true;
      return origWrite(chunk, cb);
    }
    return false;
  };

  h.core.link.handleUpgrade({
    url: '/v1/link/relay',
    method: 'GET',
    headers: { upgrade: 'nox-link', authorization: `Bearer ${a.token}`, 'x-nox-device-id': devC, 'x-nox-room-id': bRoom.roomId, 'x-nox-join-ticket': bRoom.hostTicket },
    socket: { remoteAddress: '127.0.0.1' },
  }, senderSock, Buffer.alloc(0));
  h.core.link.handleUpgrade({
    url: '/v1/link/relay',
    method: 'GET',
    headers: { upgrade: 'nox-link', authorization: `Bearer ${a.token}`, 'x-nox-device-id': devD, 'x-nox-room-id': bRoom.roomId, 'x-nox-join-ticket': bRoom.clientTicket },
    socket: { remoteAddress: '127.0.0.1' },
  }, slowRecvSock, Buffer.alloc(0));

  senderSock.emit('data', Buffer.alloc(256, 0x41));
  // Причина backpressure ставит drainTimer (120ms): если получатель не просыпается, канал закрывается по drain_timeout.
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(senderSock.destroyed, true);
  assert.equal(slowRecvSock.destroyed, true);
  assert.equal(h.core.link.stats().activeRooms, 0);
});

// ── NEG-9: Рестарт до 2-го устройства (зомби-комнаты) + массовое создание и очистка link_rooms
test('NEG-9 [P1-4, P1-5]: рестарт сервера до подключения 2-го (и даже 1-го) участника закрывает зомби; таблица комнат ограничена', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-neg9-'));
  const dbFile = path.join(dir, 'nox.db');
  const clock = { ms: NOW };
  let srv1 = null;
  let srv2 = null;
  t.after(async () => {
    if (srv1) {
      try { srv1.store.close(); } catch { /* noop */ }
      if (typeof srv1.server.closeAllConnections === 'function') srv1.server.closeAllConnections();
      await new Promise((r) => { try { srv1.server.close(() => r()); } catch { r(); } });
    }
    if (srv2) {
      if (typeof srv2.server.closeAllConnections === 'function') srv2.server.closeAllConnections();
      await new Promise((r) => { try { srv2.server.close(() => r()); } catch { r(); } });
      try { srv2.store.close(); } catch { /* noop */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  srv1 = createLinkServer({
    dbFile,
    now: () => clock.ms,
    sseHeartbeatMs: 0,
    maxOpenRoomsPerAccount: 3,
    maxClosedRooms: 8,
    closedRoomRetentionMs: 60_000,
    pairTtlMs: 30_000,
    sessionTtlMs: 10_000,
  });
  await new Promise((r) => srv1.server.listen(0, '127.0.0.1', r));
  const acc = srv1.store.createAccount({ email: 'z@nox.test', password: 'password123', plan: 'trial', trialUntil: NOW + 7 * 86400e3, now: clock.ms });
  const token = srv1.store.issueToken(acc.id, clock.ms);
  const devA = makeUuidV4();
  const devB = makeUuidV4();
  srv1.service.linkStore.registerDevice({ accountId: acc.id, deviceId: devA, deviceName: 'A', now: clock.ms });
  srv1.service.linkStore.registerDevice({ accountId: acc.id, deviceId: devB, deviceName: 'B', now: clock.ms });

  // Создаём pair-комнату без единого подключения и session-комнату с 1-м подключением (имитируем падение процесса без close()).
  const zombiePair = srv1.service.linkStore.createRoom({ accountId: acc.id, purpose: 'pair', hostDeviceId: devA, clientDeviceId: devB, now: clock.ms });
  const halfSess = srv1.service.linkStore.createRoom({ accountId: acc.id, purpose: 'session', hostDeviceId: devA, clientDeviceId: devB, now: clock.ms });
  srv1.service.linkStore.admitToRoom({ accountId: acc.id, deviceId: devA, roomId: halfSess.roomId, joinTicket: halfSess.hostTicket, now: clock.ms });
  // Закрываем только серверный сокет и БД без вызова service.close(), имитируя внезапный рестарт.
  srv1.store.close();
  await new Promise((r) => {
    try { srv1.server.close(() => r()); } catch { r(); }
  });
  srv1 = null;

  // Рестарт на той же БД.
  srv2 = createLinkServer({
    dbFile,
    now: () => clock.ms,
    sseHeartbeatMs: 0,
    maxOpenRoomsPerAccount: 3,
    maxClosedRooms: 8,
    closedRoomRetentionMs: 60_000,
    pairTtlMs: 30_000,
    sessionTtlMs: 10_000,
  });
  await new Promise((r) => srv2.server.listen(0, '127.0.0.1', r));
  const port2 = srv2.server.address().port;

  // Обе до-рестартные комнаты (и 0-участников, и 1-участник) закрыты как server_restart -> никаких зомби!
  const zRow = srv2.store.db.prepare('SELECT closed_at, close_reason FROM link_rooms WHERE room_id = ?').get(zombiePair.roomId);
  const hRow = srv2.store.db.prepare('SELECT closed_at, close_reason FROM link_rooms WHERE room_id = ?').get(halfSess.roomId);
  assert.equal(zRow.close_reason, 'server_restart');
  assert.equal(hRow.close_reason, 'server_restart');

  // Новое сопряжение для этой пары устройств сразу разрешается (не блокируется прежним зомби pair).
  const newPairRes = await fetch(`http://127.0.0.1:${port2}/v1/link/pairings/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetDeviceId: devB }),
  });
  assert.equal(newPairRes.status, 201);

  // Старый билет второго устройства после рестарта отклонён 409.
  const staleRes = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: port2,
      method: 'GET',
      path: '/v1/link/relay',
      headers: { Connection: 'Upgrade', Upgrade: 'nox-link', Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devB, 'X-Nox-Room-Id': halfSess.roomId, 'X-Nox-Join-Ticket': halfSess.clientTicket },
    });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(staleRes, 409);

  // Массовое создание и истечение комнат (30 штук при maxClosedRooms = 8): размер link_rooms строго ограничен.
  for (let i = 0; i < 30; i += 1) {
    clock.ms += 11_000;
    const res = await fetch(`http://127.0.0.1:${port2}/v1/link/sessions/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDeviceId: devB }),
    });
    assert.equal(res.status, 201);
  }
  const counts = srv2.store.db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS open FROM link_rooms').get();
  assert.ok(counts.total <= 9, `link_rooms grew too large: ${counts.total}`);
  assert.ok(counts.open <= 3);
});

// ── NEG-10 & P1-6, P1-7, P1-8, P1-9, P1-10: устройства/общие IP/aborted body/SQLITE_BUSY/маскировка/некорректные токены/20 конкурентных
test('NEG-10 [P1-6..10 + 20 concurrent]: лимиты устройств, изоляция общих IP, aborted HTTP body, SQLITE_BUSY, маскировка и 20 конкурентных соединений', async (t) => {
  // 1. P1-6 Лимиты создания и отзыва устройств + общий предел истории устройств.
  const hDev = await startIntegratedHarness(t, {
    linkConfig: {
      maxDevicesPerAccount: 5,
      maxTotalDevicesPerAccount: 6,
      maxDeviceCreationsPerWindow: 4,
      maxDeviceRevocationsPerWindow: 3,
      deviceOpWindowMs: 10 * MIN,
    },
  });
  const uDev = await hDev.registerUser('devcap@nox.test');
  const createdIds = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await hDev.registerDevice(uDev.token, { deviceName: `D${i}` });
    createdIds.push(r.deviceId);
  }
  // Повторное обновление уже существующего активного устройства не расходует лимит создания!
  const updRes = await hDev.call('POST', '/v1/link/devices/register', {
    token: uDev.token,
    body: { deviceId: createdIds[0], deviceName: 'D0-renamed' },
  });
  assert.equal(updRes.status, 200);

  // 5-е новое устройство превышает maxDeviceCreationsPerWindow = 4 -> 429 too_many_device_ops.
  const rateCre = await hDev.call('POST', '/v1/link/devices/register', {
    token: uDev.token,
    body: { deviceId: makeUuidV4(), deviceName: 'D-rate' },
  });
  assert.equal(rateCre.status, 429);
  assert.equal(rateCre.json.error.code, 'too_many_device_ops');

  // Сдвиг времени на 10 мин: проверяем лимит отзывов (3) и общий исторический предел (6).
  hDev.clock.ms += 10 * MIN + 1;
  for (let i = 0; i < 3; i += 1) {
    const rev = await hDev.call('POST', `/v1/link/devices/${createdIds[i]}/revoke`, { token: uDev.token });
    assert.equal(rev.status, 200);
  }
  const revRate = await hDev.call('POST', `/v1/link/devices/${createdIds[3]}/revoke`, { token: uDev.token });
  assert.equal(revRate.status, 429);
  assert.equal(revRate.json.error.code, 'too_many_device_ops');

  // Регистрируем ещё 2 новых устройства (всего в БД 6: 3 отозваны + 3 активны), 7-е бьёт общий исторический лимит 6 -> 409.
  await hDev.registerDevice(uDev.token, { deviceName: 'D5' });
  await hDev.registerDevice(uDev.token, { deviceName: 'D6' });
  const histCap = await hDev.call('POST', '/v1/link/devices/register', {
    token: uDev.token,
    body: { deviceId: makeUuidV4(), deviceName: 'D7' },
  });
  assert.equal(histCap.status, 409);
  assert.equal(histCap.json.error.code, 'device_history_limit_reached');

  // 2. P1-7 Защита легитимного устройства при исчерпании квоты с того же общего IP + некорректные токены.
  const hShared = await startIntegratedHarness(t, { linkConfig: { maxFailedAttempts: 5 } });
  const alice = await hShared.registerUser('alice@nox.test');
  const bob = await hShared.registerUser('bob@nox.test');
  const { deviceId: aliceDevA } = await hShared.registerDevice(alice.token, { deviceName: 'Alice-A' });
  const { deviceId: aliceDevB } = await hShared.registerDevice(alice.token, { deviceName: 'Alice-B' });
  const { deviceId: bobDev } = await hShared.registerDevice(bob.token, { deviceName: 'Bob-A' });

  // Боб на том же IP 127.0.0.1 проваливает 5 попыток входа в комнату и ловит 429;
  // Анонимный злоумышленник на том же 127.0.0.1 шлёт 5+ некорректных токенов и тоже ловит 429.
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await hShared.upgradeRelay({ token: bob.token, deviceId: bobDev, roomId: 'e'.repeat(64), ticket: 'bad-ticket-1234567890' })).status, 404);
    assert.equal((await hShared.upgradeRelay({ token: `bad_${i}`, deviceId: aliceDevA, roomId: 'e'.repeat(64), ticket: 'bad-ticket-1234567890' })).status, 401);
  }
  assert.equal((await hShared.upgradeRelay({ token: bob.token, deviceId: bobDev, roomId: 'e'.repeat(64), ticket: 'bad-ticket-1234567890' })).status, 429);
  assert.equal((await hShared.upgradeRelay({ token: 'nox_invalid_token_xyz', deviceId: aliceDevA, roomId: 'e'.repeat(64), ticket: 'bad-ticket-1234567890' })).status, 429);

  // Легитимный аутентифицированный аккаунт Алисы с ТОГО ЖЕ самого 127.0.0.1 продолжает свободно работать!
  const aliceRoom = await hShared.call('POST', '/v1/link/sessions/open', {
    token: alice.token,
    headers: { 'X-Nox-Device-Id': aliceDevA },
    body: { targetDeviceId: aliceDevB },
  });
  assert.equal(aliceRoom.status, 201);
  const aliceSse = await hShared.openSse(alice.token, aliceDevB);
  assert.equal(aliceSse.status, 200);
  aliceSse.close();

  // 3. P1-8 Прерывание загрузки HTTP body (aborted HTTP upload) на server.js и link-relay.js.
  const sendAbortedBody = (port, pathUrl, token) => new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const hdrs = [
        `POST ${pathUrl} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Content-Type: application/json',
        'Content-Length: 200',
        ...(token ? [`Authorization: Bearer ${token}`] : []),
        '',
        '{"deviceId":"',
      ].join('\r\n');
      sock.write(hdrs);
      setTimeout(() => { sock.destroy(); resolve(); }, 25);
    });
    sock.on('error', () => resolve());
  });
  for (let i = 0; i < 6; i += 1) {
    await sendAbortedBody(hShared.port, '/v1/link/devices/register', alice.token);
    await sendAbortedBody(hShared.port, '/v1/link/sessions/open', alice.token);
    await sendAbortedBody(hShared.port, '/v1/auth/login');
  }
  await new Promise((r) => setTimeout(r, 30));
  // Прерывания не привели к падению и НЕ засчитались как подбор для Алисы:
  const afterAbort = await hShared.call('GET', '/v1/link/devices', { token: alice.token });
  assert.equal(afterAbort.status, 200);

  // 4. P1-9 Риски SQLITE_BUSY и безопасный откат Store.
  const dirBusy = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-busy-'));
  const busyDbFile = path.join(dirBusy, 'busy.db');
  t.after(() => fs.rmSync(dirBusy, { recursive: true, force: true }));
  const storeBusy = new Store(busyDbFile, { busyTimeoutMs: 5000 });
  assert.equal(Number(storeBusy.db.prepare('PRAGMA busy_timeout').get().timeout), 5000);
  const accBusy = storeBusy.createAccount({ email: 'busy@nox.test', password: 'password123', plan: 'trial', trialUntil: NOW + 7 * 86400e3, now: NOW });
  // Ошибка внутри charge (например, повреждённое ограничение FOREIGN KEY для несуществующего accountId) не роняет ROLLBACK.
  assert.throws(() => storeBusy.charge('non-existent-account', { usd: 0.01, estimated: false, now: NOW }));
  // Проверяем реальную конкурентную блокировку записи из отдельного worker_thread: busy_timeout + _inTx разрешают SQLITE_BUSY без ошибки.
  const workerLockReady = new Promise((resolve, reject) => {
    const w = new Worker(`
      const { parentPort, workerData } = require('worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.dbFile);
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      setTimeout(() => {
        try { db.exec('COMMIT'); db.close(); } catch {}
        parentPort.postMessage('done');
      }, 90);
    `, { eval: true, workerData: { dbFile: busyDbFile } });
    w.once('error', reject);
    w.on('message', (msg) => {
      if (msg === 'locked') resolve(w);
    });
  });
  const lockWorker = await workerLockReady;
  const workerDone = new Promise((resolve) => {
    lockWorker.on('message', (msg) => { if (msg === 'done') resolve(); });
    lockWorker.once('exit', () => resolve());
  });
  storeBusy.openWindows(accBusy.id, NOW);
  storeBusy.charge(accBusy.id, { usd: 0.01, estimated: false, now: NOW });
  await workerDone;
  storeBusy.close();

  // 5. P1-10 Очистка секретов и билетов в диагностике (link-relay и server).
  const secretTicket = 'SecretJoinTicket_Alpha_999999999999999999999';
  const gen43 = crypto.randomBytes(32).toString('base64url');
  const masked = redact(`hostTicket=${secretTicket} x-nox-join-ticket: myTicket123 {"clientTicket":"cT999"} token=${gen43} Bearer nox_1234567890 user@example.com`);
  assert.ok(!masked.includes(secretTicket));
  assert.ok(!masked.includes('myTicket123'));
  assert.ok(!masked.includes('cT999'));
  assert.ok(!masked.includes(gen43));
  assert.ok(!masked.includes('nox_1234567890'));
  assert.ok(!masked.includes('user@example.com'));

  const logs = [];
  const origErr = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  const origList = hShared.core.link.linkStore.listDevices.bind(hShared.core.link.linkStore);
  hShared.core.link.linkStore.listDevices = () => {
    throw new Error(`crash alice@nox.test ticket=secretTicketXYZ ${alice.token} ${gen43}`);
  };
  try {
    const errRes = await hShared.call('GET', '/v1/link/devices', {
      token: alice.token,
      headers: { 'X-Nox-Join-Ticket': 'customShortJoinTicket' },
    });
    assert.equal(errRes.status, 500);
    assert.ok(!errRes.text.includes('secretTicketXYZ') && !errRes.text.includes(alice.token));
  } finally {
    console.error = origErr;
    hShared.core.link.linkStore.listDevices = origList;
  }
  const logText = logs.join('\n');
  assert.ok(logText.length > 0);
  assert.ok(!logText.includes('secretTicketXYZ'));
  assert.ok(!logText.includes(gen43));
  assert.ok(!logText.includes(alice.token));
  assert.ok(!logText.includes('alice@nox.test'));

  // 6. Нагрузочный тест: 20 конкурентных SSE и 20 конкурентных релейных соединений (4 пользователя x 5 пар устройств, в пределах суточной IP-квоты регистраций).
  const hLoad = await startIntegratedHarness(t, { linkConfig: { maxOpenRoomsPerAccount: 25, maxDevicesPerAccount: 45, maxTotalDevicesPerAccount: 60 } });
  const loadUsers = await Promise.all(
    Array.from({ length: 4 }, (_, idx) => hLoad.registerUser(`load${idx}@nox.test`)),
  );
  const pairs = [];
  for (let i = 0; i < 20; i += 1) {
    const u = loadUsers[i % loadUsers.length];
    const d1 = (await hLoad.registerDevice(u.token, { deviceName: `H${i}` })).deviceId;
    const d2 = (await hLoad.registerDevice(u.token, { deviceName: `C${i}` })).deviceId;
    pairs.push({ token: u.token, hostId: d1, clientId: d2, idx: i });
  }

  // Открываем 20 SSE одновременно и 20 комнат параллельно.
  const sseList = await Promise.all(pairs.map((p) => hLoad.openSse(p.token, p.clientId)));
  assert.equal(hLoad.core.link.stats().activeSseCount, 20);

  const openRooms = await Promise.all(pairs.map(async (p) => {
    const r = await hLoad.call('POST', '/v1/link/sessions/open', {
      token: p.token,
      headers: { 'X-Nox-Device-Id': p.hostId },
      body: { targetDeviceId: p.clientId },
    });
    assert.equal(r.status, 201);
    const inv = await sseList[p.idx].nextEvent((e) => e.type === 'link.session.incoming' && e.data.roomId === r.json.roomId);
    return { ...p, roomId: r.json.roomId, hostTicket: r.json.hostTicket, clientTicket: inv.data.clientTicket };
  }));

  const relays = await Promise.all(openRooms.map(async (r) => {
    const [sHost, sClient] = await Promise.all([
      hLoad.upgradeRelay({ token: r.token, deviceId: r.hostId, roomId: r.roomId, ticket: r.hostTicket }),
      hLoad.upgradeRelay({ token: r.token, deviceId: r.clientId, roomId: r.roomId, ticket: r.clientTicket }),
    ]);
    assert.equal(sHost.ok && sClient.ok, true);
    return { idx: r.idx, sHost: sHost.socket, sClient: sClient.socket };
  }));
  assert.equal(hLoad.core.link.stats().bridgedRooms, 20);

  await Promise.all(relays.map(async ({ idx, sHost, sClient }) => {
    const msgH = `hello-from-host-${idx}-`;
    const msgC = `reply-from-client-${idx}-`;
    const recvClient = new Promise((resolve) => {
      let buf = '';
      sClient.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes(msgH)) resolve(buf); });
    });
    const recvHost = new Promise((resolve) => {
      let buf = '';
      sHost.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes(msgC)) resolve(buf); });
    });
    sHost.write(msgH);
    sClient.write(msgC);
    await Promise.all([recvClient, recvHost]);
    sHost.destroy();
    await waitSocketClose(sClient);
  }));

  for (const sse of sseList) sse.close();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(hLoad.core.link.stats(), {
    activeRooms: 0,
    waitingRooms: 0,
    bridgedRooms: 0,
    activeSseCount: 0,
  });
});
