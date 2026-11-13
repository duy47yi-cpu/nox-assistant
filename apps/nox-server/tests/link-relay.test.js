'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { createServer } = require('../server');
const { Store } = require('../store');
const { createLinkService, createLinkServer } = require('../link-relay');
const { PAIR_TTL_MS, SESSION_TTL_MS } = require('../link-store');

const PRICE = { inputPerM: 1, cachedPerM: 0.1, outputPerM: 2 };
const NOW = Date.parse('2026-11-13T09:00:00Z');
const MIN = 60 * 1000;

function makeUuidV4() {
  return crypto.randomUUID().toLowerCase();
}

function makeFp256(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

// Собираем локальный тестовый сервер из немодифицированного server.js + изолированного link-relay.js поверх общего Store.
async function startHarness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-srv-'));
  const plansFile = path.join(dir, 'plans.json');
  fs.writeFileSync(plansFile, JSON.stringify({
    trial: { title: 'Пробный', priceUsd: 0, sessionUsd: 0.05, weekUsd: 0.25, trialDays: 7 },
    pro: { title: 'Pro', priceUsd: 10, sessionUsd: 1, weekUsd: 5 },
  }));

  const clock = { ms: overrides.now || NOW };
  const dbFile = path.join(dir, 'nox.db');
  const core = createServer({
    dbFile,
    models: {
      fast: { url: 'http://provider', key: 'PROVIDER-SECRET', model: 'm1', price: PRICE },
    },
    plansFile,
    adminKey: 'admin-key-12345',
    fetchImpl: async () => new Response(''),
    now: () => clock.ms,
    ...overrides.serverConfig,
  });

  const link = createLinkService({
    store: core.store,
    now: () => clock.ms,
    sseHeartbeatMs: 0,
    ...overrides.linkConfig,
  });

  const [coreRequestListener] = core.server.listeners('request');
  core.server.removeAllListeners('request');
  core.server.on('request', (req, res) => {
    if (link.matchesHttp(req)) {
      link.handleHttp(req, res);
      return;
    }
    coreRequestListener(req, res);
  });
  core.server.on('upgrade', (req, socket, head) => {
    link.handleUpgrade(req, socket, head);
  });
  core.server.prependListener('close', () => link.close());

  await new Promise((resolve) => core.server.listen(0, '127.0.0.1', resolve));
  const port = core.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const openSseClosers = [];
  const openSockets = [];

  t.after(async () => {
    for (const closeSse of openSseClosers) closeSse();
    for (const sock of openSockets) {
      if (!sock.destroyed) sock.destroy();
    }
    link.close();
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
    try { json = JSON.parse(text); } catch { /* не json */ }
    return { status: res.status, json, text, headers: res.headers };
  };

  const registerUser = async (email = 'owner@nox.test', password = 'password123') => {
    const res = await call('POST', '/v1/auth/register', { body: { email, password } });
    assert.equal(res.status, 201);
    return res.json;
  };

  const registerDevice = async (token, { deviceId = makeUuidV4(), deviceName = 'Тестовый ПК', rootCaFp256 } = {}) => {
    const res = await call('POST', '/v1/link/devices/register', {
      token,
      body: { deviceId, deviceName, ...(rootCaFp256 !== undefined ? { rootCaFp256 } : {}) },
    });
    return { res, deviceId };
  };

  const openSse = async (token, deviceId) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/link/events`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': deviceId },
      signal: ac.signal,
    });
    if (res.status !== 200) {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      ac.abort();
      return { status: res.status, json, text };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    const waiters = [];
    let buf = '';
    let ended = false;
    const endWaiters = [];

    const close = () => {
      try { ac.abort(); } catch { /* ignore */ }
      try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
    };
    openSseClosers.push(close);

    const pushEvent = (ev) => {
      const idx = waiters.findIndex((w) => w.pred(ev));
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(ev);
      } else {
        events.push(ev);
      }
    };

    const parseBlock = (block) => {
      let type = 'message';
      let id = null;
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) return;
      const rawData = dataLines.join('\n');
      let data = rawData;
      try { data = JSON.parse(rawData); } catch { /* text */ }
      pushEvent({ type, id, data });
    };

    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const part of parts) parseBlock(part);
        }
      } catch {
        // прервано клиентом или закрытием сервера
      } finally {
        ended = true;
        for (const w of waiters) {
          clearTimeout(w.timer);
          w.reject(new Error('sse_closed'));
        }
        waiters.length = 0;
        for (const r of endWaiters) r();
      }
    })();

    const nextEvent = (pred = () => true, timeoutMs = 2000) => {
      const idx = events.findIndex(pred);
      if (idx >= 0) return Promise.resolve(events.splice(idx, 1)[0]);
      if (ended) return Promise.reject(new Error('sse_closed'));
      return new Promise((resolve, reject) => {
        const entry = {
          pred,
          resolve,
          reject,
          timer: setTimeout(() => {
            const pos = waiters.indexOf(entry);
            if (pos >= 0) waiters.splice(pos, 1);
            reject(new Error('sse_timeout'));
          }, timeoutMs),
        };
        waiters.push(entry);
      });
    };

    const ready = await nextEvent((e) => e.type === 'ready');
    return { status: 200, ready, nextEvent, waitClosed: () => (ended ? Promise.resolve() : new Promise((r) => endWaiters.push(r))), close };
  };

  const upgradeRelay = ({ token, deviceId, roomId, ticket, upgrade = 'nox-link', pathOverride = '/v1/link/relay', extraHeaders = {} } = {}) => new Promise((resolve, reject) => {
    const headers = {
      Connection: 'Upgrade',
      ...(upgrade !== null ? { Upgrade: upgrade } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(deviceId ? { 'X-Nox-Device-Id': deviceId } : {}),
      ...(roomId ? { 'X-Nox-Room-Id': roomId } : {}),
      ...(ticket ? { 'X-Nox-Join-Ticket': ticket } : {}),
      ...extraHeaders,
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: pathOverride,
      headers,
    });
    req.on('upgrade', (res, socket) => {
      openSockets.push(socket);
      socket.on('error', () => {});
      resolve({ ok: true, status: res.statusCode, socket });
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ ok: false, status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    req.end();
  });

  return { dir, dbFile, base, port, clock, core, link, call, registerUser, registerDevice, openSse, upgradeRelay };
}

function readSocketChunk(socket, expectedBytes = null, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    const timer = setTimeout(() => { cleanup(); reject(new Error('socket_read_timeout')); }, timeoutMs);
    const onData = (chunk) => {
      parts.push(chunk);
      total += chunk.length;
      if (expectedBytes === null || total >= expectedBytes) {
        cleanup();
        resolve(Buffer.concat(parts));
      }
    };
    const onClose = () => {
      cleanup();
      if (total > 0) resolve(Buffer.concat(parts));
      else reject(new Error('socket_closed'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('end', onClose);
    };
    socket.on('data', onData);
    socket.on('close', onClose);
    socket.on('end', onClose);
  });
}

function waitSocketClose(socket, timeoutMs = 2000) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('close', done); reject(new Error('socket_close_timeout')); }, timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    socket.once('close', done);
  });
}

test('существующая аутентификация: анонимные, отозванные, истёкшие и отключённые аккаунты получают 401', async (t) => {
  const h = await startHarness(t);
  const a = await h.registerUser();
  const devA = (await h.registerDevice(a.token, { deviceName: 'ПК-1' })).deviceId;
  const devB = (await h.registerDevice(a.token, { deviceName: 'ПК-2' })).deviceId;
  const fakeRoom = '0'.repeat(64);

  // Анонимные запросы на все маршруты и Upgrade -> 401.
  assert.equal((await h.call('POST', '/v1/link/devices/register', { body: { deviceId: makeUuidV4(), deviceName: 'x' } })).status, 401);
  assert.equal((await h.call('GET', '/v1/link/devices')).status, 401);
  assert.equal((await h.call('POST', `/v1/link/devices/${devA}/revoke`)).status, 401);
  assert.equal((await h.call('POST', '/v1/link/pairings/start', { body: { fromDeviceId: devA, targetDeviceId: devB } })).status, 401);
  assert.equal((await h.call('POST', '/v1/link/sessions/open', { body: { fromDeviceId: devA, targetDeviceId: devB } })).status, 401);
  assert.equal((await h.call('GET', '/v1/link/pending', { headers: { 'X-Nox-Device-Id': devA } })).status, 401);
  assert.equal((await h.openSse('', devA)).status, 401);
  const anonUp = await h.upgradeRelay({ deviceId: devA, roomId: fakeRoom, ticket: 'x'.repeat(32) });
  assert.equal(anonUp.status, 401);

  // Выход (/v1/auth/logout) сразу закрывает доступ и к Link.
  assert.equal((await h.call('POST', '/v1/auth/logout', { token: a.token })).status, 200);
  assert.equal((await h.call('GET', '/v1/link/devices', { token: a.token })).status, 401);

  // Новый вход работает, но отключение аккаунта (/v1/admin/disable) также отзывает доступ к Link.
  const login = await h.call('POST', '/v1/auth/login', { body: { email: 'owner@nox.test', password: 'password123' } });
  assert.equal(login.status, 200);
  assert.equal((await h.call('GET', '/v1/link/devices', { token: login.json.token })).status, 200);
  assert.equal((await h.call('POST', '/v1/admin/disable', { token: 'admin-key-12345', body: { email: 'owner@nox.test' } })).status, 200);
  assert.equal((await h.call('GET', '/v1/link/devices', { token: login.json.token })).status, 401);
});

test('регистрация тестовых устройств: валидация, обновление, изоляция аккаунтов и лимит устройств', async (t) => {
  const h = await startHarness(t, { linkConfig: { maxDevicesPerAccount: 3 } });
  const a = await h.registerUser('a@nox.test');
  const b = await h.registerUser('b@nox.test');

  // Ошибки валидации.
  assert.equal((await h.registerDevice(a.token, { deviceId: 'not-a-uuid', deviceName: 'PC' })).res.status, 400);
  assert.equal((await h.registerDevice(a.token, { deviceId: makeUuidV4().toUpperCase(), deviceName: 'PC' })).res.status, 400);
  assert.equal((await h.registerDevice(a.token, { deviceId: makeUuidV4(), deviceName: '' })).res.status, 400);
  assert.equal((await h.registerDevice(a.token, { deviceId: makeUuidV4(), deviceName: 'a\nb' })).res.status, 400);
  assert.equal((await h.registerDevice(a.token, { deviceId: makeUuidV4(), deviceName: 'x'.repeat(65) })).res.status, 400);
  assert.equal((await h.registerDevice(a.token, { deviceId: makeUuidV4(), deviceName: 'PC', rootCaFp256: 'bad-fp' })).res.status, 400);

  // Регистрация без отпечатка (тестовое устройство Stage 1) и с отпечатком, затем идемпотентное обновление.
  const id1 = makeUuidV4();
  const fp1 = makeFp256('root-1');
  const r1 = await h.registerDevice(a.token, { deviceId: id1, deviceName: 'Домашний ПК' });
  assert.equal(r1.res.status, 201);
  assert.equal(r1.res.json.device.rootCaFp256, '');

  const r1Upd = await h.registerDevice(a.token, { deviceId: id1, deviceName: 'Домашний ПК 2', rootCaFp256: fp1 });
  assert.equal(r1Upd.res.status, 200);
  assert.equal(r1Upd.res.json.device.deviceName, 'Домашний ПК 2');
  assert.equal(r1Upd.res.json.device.rootCaFp256, fp1);

  // Попытка тихо подменить уже зафиксированный отпечаток другим -> 409.
  const r1BadFp = await h.registerDevice(a.token, { deviceId: id1, deviceName: 'Домашний ПК 2', rootCaFp256: makeFp256('evil') });
  assert.equal(r1BadFp.res.status, 409);
  assert.equal(r1BadFp.res.json.error.code, 'fingerprint_mismatch');

  // Чужой аккаунт не может захватить тот же deviceId и не видит устройства A.
  const hijack = await h.registerDevice(b.token, { deviceId: id1, deviceName: 'Чужой' });
  assert.equal(hijack.res.status, 403);
  assert.ok(!hijack.res.text.includes('Домашний ПК'));
  assert.deepEqual((await h.call('GET', '/v1/link/devices', { token: b.token })).json.devices, []);
  assert.equal((await h.call('POST', `/v1/link/devices/${id1}/revoke`, { token: b.token })).status, 404);

  // Лимит активных устройств (maxDevicesPerAccount = 3).
  assert.equal((await h.registerDevice(a.token, { deviceName: 'ПК-2' })).res.status, 201);
  assert.equal((await h.registerDevice(a.token, { deviceName: 'ПК-3' })).res.status, 201);
  const over = await h.registerDevice(a.token, { deviceName: 'ПК-4' });
  assert.equal(over.res.status, 409);
  assert.equal(over.res.json.error.code, 'device_limit_reached');
});

test('сопряжение и сеансы: SSE, fallback /pending, в БД только хеши билетов, двунаправленный relay (P0-4, P0-6)', async (t) => {
  const h = await startHarness(t);
  const a = await h.registerUser();
  const { deviceId: devA } = await h.registerDevice(a.token, { deviceName: 'Рабочий' });
  const { deviceId: devB } = await h.registerDevice(a.token, { deviceName: 'Ноутбук' });

  // Открываем SSE только на devB -> online = true только у devB.
  const sseB = await h.openSse(a.token, devB);
  assert.equal(sseB.status, 200);
  const listBefore = (await h.call('GET', '/v1/link/devices', { token: a.token })).json.devices;
  assert.equal(listBefore.find((d) => d.deviceId === devA).online, false);
  assert.equal(listBefore.find((d) => d.deviceId === devB).online, true);

  // devA запускает сопряжение с devB.
  const pairRes = await h.call('POST', '/v1/link/pairings/start', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  });
  assert.equal(pairRes.status, 201);
  const pair = pairRes.json;
  assert.match(pair.roomId, /^[0-9a-f]{64}$/);
  assert.ok(pair.hostTicket && pair.hostTicket.length >= 32);
  assert.equal(pair.clientTicket, undefined, 'инициатор никогда не получает clientTicket');
  assert.equal(pair.purpose, 'pair');
  assert.equal(pair.expiresAt, NOW + PAIR_TTL_MS);

  // devB получает приглашение через SSE.
  const invite = await sseB.nextEvent((e) => e.type === 'link.pair.invite');
  assert.equal(invite.data.roomId, pair.roomId);
  assert.equal(invite.data.fromDeviceId, devA);
  assert.equal(invite.data.fromDeviceName, 'Рабочий');
  assert.equal(invite.data.expiresAt, pair.expiresAt);
  assert.ok(invite.data.clientTicket && invite.data.clientTicket !== pair.hostTicket);

  // В SQLite никогда не попадают открытые билеты.
  const dbDump = JSON.stringify(h.core.store.db.prepare('SELECT * FROM link_rooms').all());
  assert.ok(!dbDump.includes(pair.hostTicket));
  assert.ok(!dbDump.includes(invite.data.clientTicket));

  // Обе стороны подключаются (client может зайти первым, host вторым) и обмениваются данными.
  const pClient = h.upgradeRelay({ token: a.token, deviceId: devB, roomId: pair.roomId, ticket: invite.data.clientTicket });
  const pHost = h.upgradeRelay({ token: a.token, deviceId: devA, roomId: pair.roomId, ticket: pair.hostTicket });
  const [cConn, hConn] = await Promise.all([pClient, pHost]);
  assert.equal(cConn.ok, true);
  assert.equal(hConn.ok, true);

  const pFromHost = readSocketChunk(cConn.socket);
  hConn.socket.write(Buffer.from('привет-от-host'));
  assert.equal((await pFromHost).toString('utf8'), 'привет-от-host');

  const pFromClient = readSocketChunk(hConn.socket);
  cConn.socket.write(Buffer.from([0x01, 0x02, 0x03, 0xff]));
  assert.deepEqual(await pFromClient, Buffer.from([0x01, 0x02, 0x03, 0xff]));

  // Закрытие одной стороны закрывает вторую.
  const closedPartner = waitSocketClose(cConn.socket);
  hConn.socket.end();
  await closedPartner;

  // Fallback GET /v1/link/pending: если devB был офлайн при sessions/open, забирает приглашение через pending.
  sseB.close();
  const sessRes = await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  });
  assert.equal(sessRes.status, 201);
  assert.equal(sessRes.json.purpose, 'session');
  assert.equal(sessRes.json.expiresAt, NOW + SESSION_TTL_MS);

  const pend = await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devB } });
  assert.equal(pend.status, 200);
  assert.equal(pend.json.events.length, 1);
  assert.equal(pend.json.events[0].type, 'link.session.incoming');
  assert.equal(pend.json.events[0].data.roomId, sessRes.json.roomId);
  const sessClientTicket = pend.json.events[0].data.clientTicket;

  // После входа клиента в relay приглашение удаляется из pending, а активный сеанс переживает истечение initial ticket TTL (15с).
  const [sh, sc] = await Promise.all([
    h.upgradeRelay({ token: a.token, deviceId: devA, roomId: sessRes.json.roomId, ticket: sessRes.json.hostTicket }),
    h.upgradeRelay({ token: a.token, deviceId: devB, roomId: sessRes.json.roomId, ticket: sessClientTicket }),
  ]);
  assert.equal(sh.ok && sc.ok, true);
  assert.deepEqual((await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devB } })).json.events, []);

  h.clock.ms += SESSION_TTL_MS + 30_000;
  h.link.sweepExpired();
  const pCheck = readSocketChunk(sc.socket);
  sh.socket.write('сеанс-жив');
  assert.equal((await pCheck).toString('utf8'), 'сеанс-жив');

  // Обычный HTTP GET на /v1/link/relay без Upgrade -> 426.
  assert.equal((await h.call('GET', '/v1/link/relay', { token: a.token })).status, 426);
});

test('защита от посторонних, подмены роли, повторного билета и переполнения комнаты (P0-4)', async (t) => {
  const h = await startHarness(t, { linkConfig: { maxFailedAttempts: 50 } });
  const a = await h.registerUser('a@nox.test');
  const b = await h.registerUser('b@nox.test');

  const { deviceId: devA } = await h.registerDevice(a.token, { deviceName: 'A' });
  const { deviceId: devB } = await h.registerDevice(a.token, { deviceName: 'B' });
  const { deviceId: devC } = await h.registerDevice(a.token, { deviceName: 'C' });
  const { deviceId: devEvil } = await h.registerDevice(b.token, { deviceName: 'Evil' });

  const openRes = await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  });
  const { roomId, hostTicket } = openRes.json;
  const clientTicket = (await h.call('GET', '/v1/link/pending', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devB },
  })).json.events[0].data.clientTicket;

  // 1. Чужой аккаунт со своим устройством -> 403.
  const evilJoin = await h.upgradeRelay({ token: b.token, deviceId: devEvil, roomId, ticket: clientTicket });
  assert.equal(evilJoin.ok, false);
  assert.equal(evilJoin.status, 403);

  // 2. Перепутанные роли/билеты -> 403 (комната остаётся пригодной для настоящих участников!).
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devA, roomId, ticket: clientTicket })).status, 403);
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devB, roomId, ticket: hostTicket })).status, 403);
  // 3-е устройство того же аккаунта -> 403.
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devC, roomId, ticket: hostTicket })).status, 403);
  // Неверный Upgrade заголовок -> 400.
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devA, roomId, ticket: hostTicket, upgrade: 'websocket' })).status, 400);

  // 3. Гонка одновременного повторного использования hostTicket: проходит ровно один, второй -> 409.
  const pRace1 = h.upgradeRelay({ token: a.token, deviceId: devA, roomId, ticket: hostTicket });
  const pRace2 = h.upgradeRelay({ token: a.token, deviceId: devA, roomId, ticket: hostTicket });
  const pClient = h.upgradeRelay({ token: a.token, deviceId: devB, roomId, ticket: clientTicket });
  const [race1, race2, clientJoin] = await Promise.all([pRace1, pRace2, pClient]);

  const winners = [race1, race2].filter((r) => r.ok);
  const losers = [race1, race2].filter((r) => !r.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].status, 409);
  assert.equal(losers[0].json.error.code, 'ticket_already_used');
  assert.equal(clientJoin.ok, true);

  const hostSock = winners[0].socket;
  const clientSock = clientJoin.socket;

  // 4. Переполнение комнаты (3-й клиент при 2 занятых слотах) -> 409/403, живой пайп 1<->2 не задет!
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devA, roomId, ticket: hostTicket })).status, 409);
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devB, roomId, ticket: clientTicket })).status, 409);
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devC, roomId, ticket: clientTicket })).status, 403);

  const readOnClient = readSocketChunk(clientSock);
  hostSock.write('пайп-не-прерван');
  assert.equal((await readOnClient).toString('utf8'), 'пайп-не-прерван');

  // 5. После закрытия комнаты повторное использование любого билета невозможно.
  const closed = waitSocketClose(clientSock);
  hostSock.destroy();
  await closed;
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devA, roomId, ticket: hostTicket })).status, 409);
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devB, roomId, ticket: clientTicket })).status, 409);
});

test('истечение срока комнат, таймаут ожидания 2-го участника и квоты комнат (P0-4)', async (t) => {
  const h = await startHarness(t, { linkConfig: { relayWaitTimeoutMs: 70, maxOpenRoomsPerAccount: 3 } });
  const a = await h.registerUser();
  const { deviceId: devA } = await h.registerDevice(a.token, { deviceName: 'A' });
  const { deviceId: devB } = await h.registerDevice(a.token, { deviceName: 'B' });
  const { deviceId: devC } = await h.registerDevice(a.token, { deviceName: 'C' });

  // 1. Истечение комнаты по TTL до подключения -> 403 ticket_expired, pending пуст.
  const s1 = (await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  })).json;
  const s1ClientTicket = (await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devB } })).json.events[0].data.clientTicket;

  h.clock.ms += SESSION_TTL_MS + 1;
  const expiredJoin = await h.upgradeRelay({ token: a.token, deviceId: devA, roomId: s1.roomId, ticket: s1.hostTicket });
  assert.equal(expiredJoin.status, 403);
  assert.equal(expiredJoin.json.error.code, 'ticket_expired');
  assert.deepEqual((await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devB } })).json.events, []);
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devB, roomId: s1.roomId, ticket: s1ClientTicket })).status, 403);

  // 2. Таймаут ожидания второго участника (relayWaitTimeoutMs: 70): сокет #1 закрывается с 408, комната уничтожается.
  const s2 = (await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  })).json;
  const s2ClientTicket = (await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devB } })).json.events[0].data.clientTicket;
  const waitRes = await h.upgradeRelay({ token: a.token, deviceId: devA, roomId: s2.roomId, ticket: s2.hostTicket });
  assert.equal(waitRes.ok, false);
  assert.equal(waitRes.status, 408);
  assert.equal(waitRes.json.error.code, 'wait_timeout');
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devB, roomId: s2.roomId, ticket: s2ClientTicket })).status, 409);

  // 3. Не более 1 активной комнаты сопряжения на пару (A, B) в любом направлении, и не более 3 открытых комнат на аккаунт.
  const pAB = await h.call('POST', '/v1/link/pairings/start', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  });
  assert.equal(pAB.status, 201);
  const pBA = await h.call('POST', '/v1/link/pairings/start', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devB },
    body: { targetDeviceId: devA },
  });
  assert.equal(pBA.status, 409);
  assert.equal(pBA.json.error.code, 'pairing_already_active');

  // Занимаем ещё 2 слота сеансами (итого 3 открытых комнаты на аккаунте), 4-й -> 429 с Retry-After.
  assert.equal((await h.call('POST', '/v1/link/sessions/open', { token: a.token, headers: { 'X-Nox-Device-Id': devA }, body: { targetDeviceId: devB } })).status, 201);
  assert.equal((await h.call('POST', '/v1/link/sessions/open', { token: a.token, headers: { 'X-Nox-Device-Id': devA }, body: { targetDeviceId: devC } })).status, 201);
  const fourth = await h.call('POST', '/v1/link/sessions/open', { token: a.token, headers: { 'X-Nox-Device-Id': devB }, body: { targetDeviceId: devC } });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.json.error.code, 'too_many_rooms');
  assert.ok(Number(fourth.headers.get('retry-after')) >= 1);

  // После истечения 15с сеансовые комнаты очищаются, слоты освобождаются (а pairing 120с всё ещё жив до 120с).
  h.clock.ms += SESSION_TTL_MS + 1;
  assert.equal((await h.call('POST', '/v1/link/sessions/open', { token: a.token, headers: { 'X-Nox-Device-Id': devB }, body: { targetDeviceId: devC } })).status, 201);

  // По истечении PAIR_TTL_MS (120с) старая комната сопряжения закрывается и можно открыть новое сопряжение.
  h.clock.ms += PAIR_TTL_MS + 1;
  assert.equal((await h.call('POST', '/v1/link/pairings/start', { token: a.token, headers: { 'X-Nox-Device-Id': devB }, body: { targetDeviceId: devA } })).status, 201);
});

test('непродлеваемый TTL комнаты сопряжения рвёт даже уже соединённый пайп сопряжения', async (t) => {
  const h = await startHarness(t, { linkConfig: { pairTtlMs: 80, relayWaitTimeoutMs: 500 } });
  const a = await h.registerUser();
  const { deviceId: devA } = await h.registerDevice(a.token, { deviceName: 'A' });
  const { deviceId: devB } = await h.registerDevice(a.token, { deviceName: 'B' });

  const pair = (await h.call('POST', '/v1/link/pairings/start', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  })).json;
  const clientTicket = (await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devB } })).json.events[0].data.clientTicket;

  const [c1, c2] = await Promise.all([
    h.upgradeRelay({ token: a.token, deviceId: devA, roomId: pair.roomId, ticket: pair.hostTicket }),
    h.upgradeRelay({ token: a.token, deviceId: devB, roomId: pair.roomId, ticket: clientTicket }),
  ]);
  assert.equal(c1.ok && c2.ok, true);
  await Promise.all([waitSocketClose(c1.socket), waitSocketClose(c2.socket)]);
});

test('отзыв устройства: рвёт живой пайп, закрывает ожидающие комнаты, рассылает SSE и блокирует повторный вход (P0-6)', async (t) => {
  const h = await startHarness(t);
  const a = await h.registerUser();
  const { deviceId: devA } = await h.registerDevice(a.token, { deviceName: 'A' });
  const { deviceId: devB } = await h.registerDevice(a.token, { deviceName: 'B' });
  const { deviceId: devC } = await h.registerDevice(a.token, { deviceName: 'C' });

  const sseA = await h.openSse(a.token, devA);
  const sseB = await h.openSse(a.token, devB);
  assert.equal(sseA.status, 200);
  assert.equal(sseB.status, 200);

  // 1. Активный пайп A <-> B.
  const activeSess = (await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  })).json;
  const inviteB = await sseB.nextEvent((e) => e.type === 'link.session.incoming');
  const [connA, connB] = await Promise.all([
    h.upgradeRelay({ token: a.token, deviceId: devA, roomId: activeSess.roomId, ticket: activeSess.hostTicket }),
    h.upgradeRelay({ token: a.token, deviceId: devB, roomId: activeSess.roomId, ticket: inviteB.data.clientTicket }),
  ]);
  assert.equal(connA.ok && connB.ok, true);

  // 2. Ещё одна неначатая комната A <-> C (devC офлайн).
  const pendingSess = (await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devC },
  })).json;
  const pendingClientTicket = (await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devC } })).json.events[0].data.clientTicket;

  // Отзываем устройство A.
  const revokeRes = await h.call('POST', `/v1/link/devices/${devA}/revoke`, { token: a.token });
  assert.equal(revokeRes.status, 200);
  assert.equal(revokeRes.json.device.revokedAt, NOW);

  // Живой пайп A <-> B немедленно разорван, SSE устройства A закрыт.
  await Promise.all([waitSocketClose(connA.socket), waitSocketClose(connB.socket), sseA.waitClosed()]);

  // Онлайн-устройство B получило SSE link.device.revoked.
  const revokedEvB = await sseB.nextEvent((e) => e.type === 'link.device.revoked');
  assert.equal(revokedEvB.data.deviceId, devA);
  assert.equal(revokedEvB.data.revokedAt, NOW);

  // Офлайн-устройство C при выходе на связь получает уведомление об отзыве A через /pending (один раз), а приглашение в комнату от A удалено.
  const pendC1 = await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devC } });
  assert.equal(pendC1.json.events.length, 1);
  assert.equal(pendC1.json.events[0].type, 'link.device.revoked');
  assert.equal(pendC1.json.events[0].data.deviceId, devA);
  assert.deepEqual((await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devC } })).json.events, []);

  // Комната A <-> C закрыта; ни A, ни C туда не войдут.
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devC, roomId: pendingSess.roomId, ticket: pendingClientTicket })).status, 403);
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devA, roomId: pendingSess.roomId, ticket: pendingSess.hostTicket })).status, 403);

  // Отозванный devA не может перерегистрироваться, слушать события или открывать комнаты даже под новым входом.
  const freshLogin = (await h.call('POST', '/v1/auth/login', { body: { email: 'owner@nox.test', password: 'password123' } })).json;
  assert.equal((await h.registerDevice(freshLogin.token, { deviceId: devA, deviceName: 'A-again' })).res.status, 403);
  assert.equal((await h.openSse(freshLogin.token, devA)).status, 403);
  assert.equal((await h.call('GET', '/v1/link/pending', { token: freshLogin.token, headers: { 'X-Nox-Device-Id': devA } })).status, 403);
  assert.equal((await h.call('POST', '/v1/link/sessions/open', { token: freshLogin.token, headers: { 'X-Nox-Device-Id': devA }, body: { targetDeviceId: devB } })).status, 403);
  assert.equal((await h.call('POST', '/v1/link/sessions/open', { token: freshLogin.token, headers: { 'X-Nox-Device-Id': devB }, body: { targetDeviceId: devA } })).status, 403);

  // Неотозванные устройства B и C продолжают работать между собой.
  assert.equal((await h.call('POST', '/v1/link/sessions/open', {
    token: freshLogin.token,
    headers: { 'X-Nox-Device-Id': devB },
    body: { targetDeviceId: devC },
  })).status, 201);
});

test('ограничение неудачных попыток (5 за 15 мин -> 429 Retry-After) и транспортная проверка trustProxy', async (t) => {
  const h = await startHarness(t, {
    linkConfig: { maxFailedAttempts: 5, failWindowMs: 15 * MIN, trustProxy: true },
  });
  const a = await h.registerUser();
  const httpsHeaders = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.10' };
  const httpHeaders = { 'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '203.0.113.10' };

  // При trustProxy=true открытый HTTP от прокси отвергается 403.
  assert.equal((await h.call('GET', '/v1/link/devices', { token: a.token, headers: httpHeaders })).status, 403);
  assert.equal((await h.call('GET', '/v1/link/devices', { token: a.token, headers: httpsHeaders })).status, 200);

  const devA = makeUuidV4();
  const reg = await h.call('POST', '/v1/link/devices/register', {
    token: a.token,
    headers: httpsHeaders,
    body: { deviceId: devA, deviceName: 'A' },
  });
  assert.equal(reg.status, 201);

  // 5 неудачных попыток входа в комнату -> 6-я получает 429 Retry-After.
  for (let i = 0; i < 5; i++) {
    const fail = await h.upgradeRelay({
      token: a.token,
      deviceId: devA,
      roomId: 'f'.repeat(64),
      ticket: 'bad-ticket-1234567890',
      extraHeaders: httpsHeaders,
    });
    assert.equal(fail.status, 404);
  }
  const blocked = await h.upgradeRelay({
    token: a.token,
    deviceId: devA,
    roomId: 'f'.repeat(64),
    ticket: 'bad-ticket-1234567890',
    extraHeaders: httpsHeaders,
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'too_many');
  assert.ok(Number(blocked.headers['retry-after']) >= 1);

  // Блокировка распространяется и на попытку создать комнату с того же аккаунта/IP до истечения 15 минут.
  const blockedCreate = await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { ...httpsHeaders, 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: makeUuidV4() },
  });
  assert.equal(blockedCreate.status, 429);

  // Через 15 минут окно сбрасывается.
  h.clock.ms += 15 * MIN + 1;
  const afterWindow = await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { ...httpsHeaders, 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: makeUuidV4() },
  });
  assert.equal(afterWindow.status, 404); // дошло до проверки targetDeviceId, а не 429
});

test('автономный запуск createLinkServer, восстановление после рестарта и 413 на большом теле', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-solo-'));
  const dbFile = path.join(dir, 'solo.db');
  const clock = { ms: NOW };

  // Создаём аккаунт штатным Store, без server.js.
  const store1 = new Store(dbFile);
  const acc = store1.createAccount({ email: 'solo@nox.test', password: 'password123', plan: 'trial', trialUntil: NOW + 7 * 24 * 3600 * 1000, now: NOW });
  const token = store1.issueToken(acc.id, NOW);
  const srv1 = createLinkServer({ store: store1, now: () => clock.ms, sseHeartbeatMs: 0 });
  await new Promise((r) => srv1.server.listen(0, '127.0.0.1', r));
  const port1 = srv1.server.address().port;

  const devA = makeUuidV4();
  const devB = makeUuidV4();
  await fetch(`http://127.0.0.1:${port1}/v1/link/devices/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: devA, deviceName: 'Solo-A' }),
  });
  await fetch(`http://127.0.0.1:${port1}/v1/link/devices/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: devB, deviceName: 'Solo-B' }),
  });

  // 413 при превышении лимита тела запроса.
  const bigRes = await fetch(`http://127.0.0.1:${port1}/v1/link/devices/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: devA, deviceName: 'x'.repeat(5000) }),
  });
  assert.equal(bigRes.status, 413);

  // Открываем комнату и частично входим только первым участником до рестарта сервера.
  const room = await (await fetch(`http://127.0.0.1:${port1}/v1/link/sessions/open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetDeviceId: devB }),
  })).json();
  const pend = await (await fetch(`http://127.0.0.1:${port1}/v1/link/pending`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devB },
  })).json();
  const clientTicket = pend.events[0].data.clientTicket;

  // Первый участник зашёл, и тут сервер штатно останавливается.
  let req1Status = null;
  const req1Closed = new Promise((resolve) => {
    const req1 = http.request({
      host: '127.0.0.1',
      port: port1,
      method: 'GET',
      path: '/v1/link/relay',
      headers: { Connection: 'Upgrade', Upgrade: 'nox-link', Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devA, 'X-Nox-Room-Id': room.roomId, 'X-Nox-Join-Ticket': room.hostTicket },
    });
    req1.on('response', (res) => { req1Status = res.statusCode; res.resume(); resolve(); });
    req1.on('error', () => resolve());
    req1.on('close', () => resolve());
    req1.end();
  });
  await new Promise((r) => setTimeout(r, 30));

  await new Promise((r) => srv1.server.close(r));
  await req1Closed;
  assert.equal(req1Status, null);
  assert.equal(store1.db.prepare('SELECT close_reason FROM link_rooms WHERE room_id = ?').get(room.roomId).close_reason, 'server_shutdown');

  // Эмулируем аварийный рестарт со второй незавершённой комнатой (осталась незакрытой в БД).
  const crashRoom = srv1.service.linkStore.createRoom({
    accountId: acc.id,
    purpose: 'session',
    hostDeviceId: devA,
    clientDeviceId: devB,
    now: clock.ms,
  });
  srv1.service.linkStore.admitToRoom({
    accountId: acc.id,
    deviceId: devA,
    roomId: crashRoom.roomId,
    joinTicket: crashRoom.hostTicket,
    now: clock.ms,
  });
  store1.close();

  // Повторный запуск на той же БД: частично использованная комната прошлого процесса закрыта как server_restart.
  const srv2 = createLinkServer({ dbFile, now: () => clock.ms, sseHeartbeatMs: 0 });
  await new Promise((r) => srv2.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => srv2.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const row = srv2.store.db.prepare('SELECT closed_at, close_reason FROM link_rooms WHERE room_id = ?').get(crashRoom.roomId);
  assert.ok(row.closed_at !== null);
  assert.equal(row.close_reason, 'server_restart');

  // Устройства сохранились, но второй участник со старым билетом после рестарта не проходит.
  const port2 = srv2.server.address().port;
  const staleStatus = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: port2,
      method: 'GET',
      path: '/v1/link/relay',
      headers: { Connection: 'Upgrade', Upgrade: 'nox-link', Authorization: `Bearer ${token}`, 'X-Nox-Device-Id': devB, 'X-Nox-Room-Id': crashRoom.roomId, 'X-Nox-Join-Ticket': crashRoom.clientTicket },
    });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(staleStatus, 409);

  // Резервная копия SQLite (backupTo) работает без ошибок и включает таблицы link_*.
  const copy = path.join(dir, 'backup.db');
  srv2.store.backupTo(copy);
  const restored = new Store(copy);
  try {
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM link_devices').get().n, 2);
  } finally {
    restored.close();
  }
});

test('дополнительные защиты: 401 по IP лимиту, уход ожидающего участника, disconnectAccount, плохой URL и маскировка логов', async (t) => {
  const h = await startHarness(t, { linkConfig: { maxFailedAttempts: 5, failWindowMs: 15 * MIN } });
  const a = await h.registerUser('a@nox.test');
  const b = await h.registerUser('b@nox.test');
  const { deviceId: devA } = await h.registerDevice(a.token, { deviceName: 'A' });
  const { deviceId: devB } = await h.registerDevice(a.token, { deviceName: 'B' });
  const { deviceId: devBUser } = await h.registerDevice(b.token, { deviceName: 'OtherUser' });

  // 1. Уход первого участника до прихода второго сразу закрывает комнату (peer_disconnected).
  const s1 = (await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  })).json;
  const s1ClientTicket = (await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devB } })).json.events[0].data.clientTicket;

  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: h.port,
      method: 'GET',
      path: '/v1/link/relay',
      headers: { Connection: 'Upgrade', Upgrade: 'nox-link', Authorization: `Bearer ${a.token}`, 'X-Nox-Device-Id': devA, 'X-Nox-Room-Id': s1.roomId, 'X-Nox-Join-Ticket': s1.hostTicket },
    });
    req.on('error', () => {});
    req.end();
    setTimeout(() => { req.destroy(); resolve(); }, 30);
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await h.upgradeRelay({ token: a.token, deviceId: devB, roomId: s1.roomId, ticket: s1ClientTicket })).status, 409);

  // 2. disconnectAccount рвёт живые каналы и SSE только целевого аккаунта, не трогая другой аккаунт.
  const s2 = (await h.call('POST', '/v1/link/sessions/open', {
    token: a.token,
    headers: { 'X-Nox-Device-Id': devA },
    body: { targetDeviceId: devB },
  })).json;
  const s2ClientTicket = (await h.call('GET', '/v1/link/pending', { token: a.token, headers: { 'X-Nox-Device-Id': devB } })).json.events[0].data.clientTicket;
  const [cA, cB] = await Promise.all([
    h.upgradeRelay({ token: a.token, deviceId: devA, roomId: s2.roomId, ticket: s2.hostTicket }),
    h.upgradeRelay({ token: a.token, deviceId: devB, roomId: s2.roomId, ticket: s2ClientTicket }),
  ]);
  const sseB = await h.openSse(a.token, devB);
  const sseOther = await h.openSse(b.token, devBUser);

  h.link.disconnectAccount(a.account.id, 'account_disabled');
  await Promise.all([waitSocketClose(cA.socket), waitSocketClose(cB.socket), sseB.waitClosed()]);
  assert.equal(h.link.stats().activeSseCount, 1);
  sseOther.close();

  // 3. Несуществующий маршрут -> 404, некорректный URL в Upgrade -> 400 (не 500), и при внутреннем сбое 500 секреты маскируются.
  assert.equal((await h.call('GET', '/v1/link/%%%', { token: a.token })).status, 404);
  const badUrlStatus = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: h.port,
      method: 'GET',
      path: '//%%%bad',
      headers: { Connection: 'Upgrade', Upgrade: 'nox-link' },
    });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(badUrlStatus, 400);

  const origList = h.link.linkStore.listDevices.bind(h.link.linkStore);
  h.link.linkStore.listDevices = () => { throw new Error(`сбой a@nox.test токен ${a.token}`); };
  const logs = [];
  const origErr = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const errRes = await h.call('GET', '/v1/link/devices', { token: a.token });
    assert.equal(errRes.status, 500);
    assert.ok(!errRes.text.includes(a.token));
  } finally {
    console.error = origErr;
    h.link.linkStore.listDevices = origList;
  }
  assert.ok(logs.length > 0 && !logs.join('\n').includes(a.token) && !logs.join('\n').includes('a@nox.test'));

  // 4. Анонимный перебор по IP (5 x 401 -> 429).
  for (let i = 0; i < 4; i++) { // 1 неудача уже была при s1 позднем или ещё 5 попыток ниже
    await h.upgradeRelay({ token: 'nox_wrong_token_123', deviceId: devA, roomId: '0'.repeat(64), ticket: 't'.repeat(32) });
  }
  await h.upgradeRelay({ token: 'nox_wrong_token_123', deviceId: devA, roomId: '0'.repeat(64), ticket: 't'.repeat(32) });
  const ipLimited = await h.upgradeRelay({ token: 'nox_wrong_token_123', deviceId: devA, roomId: '0'.repeat(64), ticket: 't'.repeat(32) });
  assert.equal(ipLimited.status, 429);
  assert.equal(ipLimited.json.error.code, 'too_many');
});
