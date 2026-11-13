'use strict';

const http = require('node:http');
const { WebSocketServer } = require('ws');
const {
  VERSION,
  MAX_FRAME_BYTES,
  MAX_TEXT_BYTES,
  MAX_TITLE_BYTES,
  DEFAULT_PAIRING_TTL_MS,
  MAX_PAIRING_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  MAX_READ_TIMEOUT_MS,
  random,
  validHex,
  utf8Bytes,
  mac,
  equal,
  hasExactKeys,
  allowedOrigin,
} = require('./protocol');

// Pairing, session secrets, and read results remain strictly in memory (no logs or disk).
function createBridge({
  origin,
  now = Date.now,
  maxPayload = MAX_FRAME_BYTES,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  clock: customClock,
} = {}) {
  if (typeof origin !== 'string' || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    throw new TypeError('A specific extension origin is required');
  }
  if (!Number.isSafeInteger(maxPayload) || maxPayload < 1 || maxPayload > MAX_FRAME_BYTES) {
    throw new RangeError('invalid maxPayload');
  }
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1 || sessionTtlMs > MAX_SESSION_TTL_MS) {
    throw new RangeError('invalid session lifetime');
  }

  const clock = {
    now: customClock?.now || now,
    setTimeout: customClock?.setTimeout || ((...args) => globalThis.setTimeout(...args)),
    clearTimeout: customClock?.clearTimeout || (id => globalThis.clearTimeout(id)),
  };

  const pairings = new Map();
  const sessions = new Map();
  const pairingToSession = new Map();
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });

  function terminateSession(sessionId, { terminate = true, reason = 'session revoked' } = {}) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    sessions.delete(sessionId);
    if (pairingToSession.get(session.pairingId) === sessionId) {
      pairingToSession.delete(session.pairingId);
    }
    clock.clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
    if (session.activeRead) {
      const pending = session.activeRead;
      session.activeRead = null;
      clock.clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    session.secretBuf.fill(0);
    if (terminate) session.ws.terminate();
    else session.ws.close(1008, 'rejected');
    return true;
  }

  function sweepExpired() {
    const t = clock.now();
    for (const [id, pairing] of pairings) {
      if (t >= pairing.expires || pairing.used) {
        pairing.secretBuf.fill(0);
        pairings.delete(id);
      }
    }
    for (const [sid, session] of sessions) {
      if (t >= session.expires) {
        terminateSession(sid, { terminate: true, reason: 'session expired' });
      }
    }
  }

  server.on('upgrade', (req, socket, head) => {
    if (req.headers.origin !== origin || req.url !== '/nox' || sockets.size >= 8) {
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  wss.on('connection', ws => {
    sockets.add(ws);
    let session = null;
    let windowStart = clock.now();
    let messageCount = 0;
    const challenge = random();
    const handshakeTimer = clock.setTimeout(() => ws.terminate(), 5000);

    const send = value => {
      const raw = JSON.stringify(value);
      if (utf8Bytes(raw) > maxPayload) throw new Error('frame exceeds maxPayload');
      ws.send(raw);
    };

    const reject = (reason = 'rejected') => {
      clock.clearTimeout(handshakeTimer);
      if (session) {
        terminateSession(session.id, { terminate: false, reason });
        session = null;
      } else {
        ws.close(1008, 'rejected');
      }
    };

    ws.on('close', () => {
      clock.clearTimeout(handshakeTimer);
      sockets.delete(ws);
      if (session) {
        terminateSession(session.id, { terminate: false, reason: 'connection closed' });
        session = null;
      }
    });
    ws.on('error', () => {});

    send({ type: 'challenge', version: VERSION, challenge });

    ws.on('message', (raw, binary) => {
      const t = clock.now();
      if (t - windowStart >= 10000) {
        windowStart = t;
        messageCount = 0;
      }
      if (++messageCount > 30) return reject('rate limit');
      if (binary) return reject('binary frame');
      if (Buffer.isBuffer(raw) && raw.byteLength > maxPayload) return reject('oversized');

      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return reject('invalid json');
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return reject('invalid message');

      if (!session) {
        if (
          !hasExactKeys(msg, ['type', 'id', 'nonce', 'proof']) ||
          msg.type !== 'authenticate' ||
          !validHex(msg.id) ||
          !validHex(msg.nonce) ||
          !validHex(msg.proof)
        ) {
          return reject('invalid authenticate');
        }
        const pairing = pairings.get(msg.id);
        if (!pairing || pairing.used || t >= pairing.expires) return reject('invalid pairing');
        const expected = mac(pairing.secretBuf, 'c2s', 'authenticate', origin, msg.id, challenge, msg.nonce);
        if (!equal(msg.proof, expected)) {
          pairing.attempts += 1;
          if (pairing.attempts >= 5) {
            pairing.secretBuf.fill(0);
            pairings.delete(msg.id);
          }
          return reject('bad proof');
        }

        // One-time pairing consumed; derive independent session secret and discard pairing secret.
        pairing.used = true;
        pairings.delete(msg.id);
        const sessionId = random();
        const sessionExpires = t + pairing.sessionTtlMs;
        const sessionSecretHex = mac(
          pairing.secretBuf,
          'session-key',
          origin,
          msg.id,
          challenge,
          msg.nonce,
          sessionId,
          sessionExpires
        );
        const serverProof = mac(
          pairing.secretBuf,
          's2c',
          'authenticated',
          origin,
          msg.id,
          challenge,
          msg.nonce,
          sessionId,
          sessionExpires
        );
        pairing.secretBuf.fill(0);

        session = {
          id: sessionId,
          pairingId: msg.id,
          secretBuf: Buffer.from(sessionSecretHex, 'hex'),
          expires: sessionExpires,
          ws,
          clientSeq: 0,
          serverSeq: 0,
          activeRead: null,
          timedOutReads: new Map(),
          expiryTimer: clock.setTimeout(() => {
            terminateSession(sessionId, { terminate: true, reason: 'session expired' });
          }, Math.max(0, sessionExpires - clock.now())),
        };
        sessions.set(sessionId, session);
        pairingToSession.set(msg.id, sessionId);
        clock.clearTimeout(handshakeTimer);
        send({ type: 'authenticated', session: sessionId, sessionExpires, proof: serverProof });
        return;
      }

      if (t >= session.expires || sessions.get(session.id) !== session) {
        return reject('session expired');
      }

      if (msg.type === 'ping') {
        if (
          !hasExactKeys(msg, ['type', 'seq', 'proof']) ||
          !Number.isSafeInteger(msg.seq) ||
          msg.seq !== session.clientSeq + 1 ||
          !equal(msg.proof, mac(session.secretBuf, 'c2s', 'ping', session.id, msg.seq))
        ) {
          return reject('invalid ping');
        }
        session.clientSeq = msg.seq;
        send({
          type: 'pong',
          seq: msg.seq,
          proof: mac(session.secretBuf, 's2c', 'pong', session.id, msg.seq),
        });
        return;
      }

      if (msg.type === 'read_result') {
        const pending = session.activeRead;
        const isCurrent = Boolean(pending && validHex(msg.requestId) && msg.requestId === pending.requestId);
        const isTimedOut = !isCurrent && validHex(msg.requestId) && session.timedOutReads.has(msg.requestId);
        if (
          (!isCurrent && !isTimedOut) ||
          !Number.isSafeInteger(msg.seq) ||
          msg.seq !== session.clientSeq + 1
        ) {
          return reject('unexpected read_result');
        }
        if (msg.ok === true) {
          if (
            !hasExactKeys(msg, ['type', 'seq', 'requestId', 'ok', 'origin', 'title', 'text', 'truncated', 'proof']) ||
            typeof msg.origin !== 'string' ||
            allowedOrigin(msg.origin) !== msg.origin ||
            typeof msg.title !== 'string' ||
            utf8Bytes(msg.title) > MAX_TITLE_BYTES ||
            typeof msg.text !== 'string' ||
            utf8Bytes(msg.text) > MAX_TEXT_BYTES ||
            typeof msg.truncated !== 'boolean' ||
            !equal(
              msg.proof,
              mac(
                session.secretBuf,
                'c2s',
                'read_result',
                session.id,
                msg.seq,
                msg.requestId,
                true,
                msg.origin,
                msg.title,
                msg.text,
                msg.truncated
              )
            )
          ) {
            return reject('invalid read_result');
          }
          session.clientSeq = msg.seq;
          if (isTimedOut) {
            session.timedOutReads.delete(msg.requestId);
            return;
          }
          session.activeRead = null;
          clock.clearTimeout(pending.timer);
          pending.resolve({
            ok: true,
            origin: msg.origin,
            title: msg.title,
            text: msg.text,
            truncated: msg.truncated,
          });
          return;
        }
        if (msg.ok === false) {
          if (
            !hasExactKeys(msg, ['type', 'seq', 'requestId', 'ok', 'error', 'proof']) ||
            typeof msg.error !== 'string' ||
            msg.error.length < 1 ||
            msg.error.length > 128 ||
            !equal(
              msg.proof,
              mac(session.secretBuf, 'c2s', 'read_result', session.id, msg.seq, msg.requestId, false, msg.error)
            )
          ) {
            return reject('invalid error read_result');
          }
          session.clientSeq = msg.seq;
          if (isTimedOut) {
            session.timedOutReads.delete(msg.requestId);
            return;
          }
          session.activeRead = null;
          clock.clearTimeout(pending.timer);
          pending.resolve({ ok: false, error: msg.error });
          return;
        }
        return reject('invalid read_result status');
      }

      return reject('unknown message');
    });
  });

  return {
    pair(ttlMs = DEFAULT_PAIRING_TTL_MS, options = {}) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_PAIRING_TTL_MS) {
        throw new RangeError('invalid pairing lifetime');
      }
      const sessTtl = options?.sessionTtlMs ?? sessionTtlMs;
      if (!Number.isSafeInteger(sessTtl) || sessTtl < 1 || sessTtl > MAX_SESSION_TTL_MS) {
        throw new RangeError('invalid session lifetime');
      }
      sweepExpired();
      if (pairings.size >= 16) throw new Error('too many pairings');
      const id = random();
      const secret = random();
      const expires = clock.now() + ttlMs;
      pairings.set(id, {
        id,
        secretBuf: Buffer.from(secret, 'hex'),
        expires,
        sessionTtlMs: sessTtl,
        attempts: 0,
        used: false,
      });
      return { id, secret, expires };
    },

    revoke(id) {
      let revoked = false;
      const pairing = pairings.get(id);
      if (pairing) {
        pairing.secretBuf.fill(0);
        pairings.delete(id);
        revoked = true;
      }
      const linkedSessionId = pairingToSession.get(id);
      if (linkedSessionId && terminateSession(linkedSessionId, { terminate: true, reason: 'revoked' })) {
        revoked = true;
      }
      if (terminateSession(id, { terminate: true, reason: 'revoked' })) {
        revoked = true;
      }
      return revoked;
    },

    revokeAll() {
      for (const pairing of pairings.values()) pairing.secretBuf.fill(0);
      pairings.clear();
      for (const sid of [...sessions.keys()]) {
        terminateSession(sid, { terminate: true, reason: 'revoked' });
      }
    },

    listSessions() {
      sweepExpired();
      return [...sessions.values()].map(s => ({ id: s.id, pairingId: s.pairingId, expires: s.expires }));
    },

    readPage({ sessionId, timeoutMs = DEFAULT_READ_TIMEOUT_MS } = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_READ_TIMEOUT_MS) {
        return Promise.reject(new RangeError('invalid read timeout'));
      }
      sweepExpired();
      let target;
      if (sessionId !== undefined) {
        target = sessions.get(sessionId);
      } else if (sessions.size === 1) {
        [target] = sessions.values();
      } else if (sessions.size > 1) {
        return Promise.reject(new Error('multiple active sessions'));
      }
      if (!target || clock.now() >= target.expires || target.ws.readyState !== 1) {
        return Promise.reject(new Error('no active session'));
      }
      if (target.activeRead) {
        return Promise.reject(new Error('read request already active'));
      }

      const requestId = random();
      const seq = target.serverSeq + 1;
      const issuedAt = clock.now();
      const expiresAt = issuedAt + timeoutMs;
      const proof = mac(target.secretBuf, 's2c', 'read_request', target.id, seq, requestId, issuedAt, expiresAt);
      const frame = JSON.stringify({ type: 'read_request', seq, requestId, issuedAt, expiresAt, proof });
      if (utf8Bytes(frame) > maxPayload) {
        return Promise.reject(new Error('read_request exceeds maxPayload'));
      }

      return new Promise((resolve, reject) => {
        const timer = clock.setTimeout(() => {
          if (target.activeRead?.requestId === requestId) {
            target.activeRead = null;
            target.timedOutReads.set(requestId, clock.now());
            if (target.timedOutReads.size > 64) {
              const oldest = target.timedOutReads.keys().next().value;
              target.timedOutReads.delete(oldest);
            }
            reject(new Error('read request timed out'));
          }
        }, timeoutMs);
        const pendingRead = { requestId, seq, resolve, reject, timer };
        target.activeRead = pendingRead;
        try {
          target.ws.send(frame);
          target.serverSeq = seq;
        } catch (err) {
          if (target.activeRead === pendingRead) {
            target.activeRead = null;
            clock.clearTimeout(timer);
          }
          reject(err);
        }
      });
    },

    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    },

    close() {
      for (const pairing of pairings.values()) pairing.secretBuf.fill(0);
      pairings.clear();
      for (const sid of [...sessions.keys()]) {
        terminateSession(sid, { terminate: true, reason: 'bridge closed' });
      }
      for (const ws of sockets) ws.terminate();
      return new Promise(resolve => wss.close(() => server.close(resolve)));
    },
  };
}

module.exports = { createBridge };
