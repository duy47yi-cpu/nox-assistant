// Browser-side bridge client (nox-bridge-2). Session keys remain non-extractable in memory only.
const VERSION = 'nox-bridge-2';
const MAX_FRAME_BYTES = 65536;
const MAX_TEXT_BYTES = 49152;
const MAX_TITLE_BYTES = 512;
const MAX_SESSION_TTL_MS = 3600000;
const MAX_READ_TIMEOUT_MS = 30000;
const MAX_QUEUED_FRAMES = 8;

const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g), x => parseInt(x, 16));
const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const utf8Bytes = value => encoder.encode(value).byteLength;
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function truncateUtf8(str, maxBytes) {
  if (typeof str !== 'string' || maxBytes < 0) return { text: '', truncated: Boolean(str) };
  if (utf8Bytes(str) <= maxBytes) return { text: str, truncated: false };
  if (maxBytes === 0) return { text: '', truncated: str.length > 0 };
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    let end = mid;
    if (end > 0) {
      const prev = str.charCodeAt(end - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) end--;
    }
    if (end === lo) {
      const pairEnd = lo + 2 <= hi ? lo + 2 : lo;
      if (pairEnd > lo && utf8Bytes(str.slice(0, pairEnd)) <= maxBytes) lo = pairEnd;
      break;
    }
    if (utf8Bytes(str.slice(0, end)) <= maxBytes) lo = end;
    else hi = end - 1;
  }
  if (lo > 0) {
    const last = str.charCodeAt(lo - 1);
    if (last >= 0xd800 && last <= 0xdbff) lo--;
  }
  return { text: str.slice(0, lo), truncated: true };
}

function fitReadResult({ seq, requestId, origin, title, text, truncated = false }) {
  const titleCut = truncateUtf8(title, MAX_TITLE_BYTES);
  const textCut = truncateUtf8(text, MAX_TEXT_BYTES);
  let isTruncated = Boolean(truncated || titleCut.truncated || textCut.truncated);
  let finalText = textCut.text;
  const placeholderProof = '0'.repeat(64);
  const buildJson = (candidateText, candidateTruncated) =>
    JSON.stringify({
      type: 'read_result',
      seq,
      requestId,
      ok: true,
      origin,
      title: titleCut.text,
      text: candidateText,
      truncated: candidateTruncated,
      proof: placeholderProof,
    });
  if (utf8Bytes(buildJson(finalText, isTruncated)) > MAX_FRAME_BYTES) {
    isTruncated = true;
    let lo = 0;
    let hi = finalText.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      let end = mid;
      if (end > 0) {
        const prev = finalText.charCodeAt(end - 1);
        if (prev >= 0xd800 && prev <= 0xdbff) end--;
      }
      if (end === lo) {
        const pairEnd = lo + 2 <= hi ? lo + 2 : lo;
        if (pairEnd > lo && utf8Bytes(buildJson(finalText.slice(0, pairEnd), true)) <= MAX_FRAME_BYTES) {
          lo = pairEnd;
        }
        break;
      }
      if (utf8Bytes(buildJson(finalText.slice(0, end), true)) <= MAX_FRAME_BYTES) lo = end;
      else hi = end - 1;
    }
    if (lo > 0) {
      const last = finalText.charCodeAt(lo - 1);
      if (last >= 0xd800 && last <= 0xdbff) lo--;
    }
    finalText = finalText.slice(0, lo);
    if (utf8Bytes(buildJson(finalText, true)) > MAX_FRAME_BYTES) {
      throw new Error('read_result exceeds 64 KiB frame limit');
    }
  }
  return { origin, title: titleCut.text, text: finalText, truncated: isTruncated };
}

async function importHmacKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signBytes(key, ...parts) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify([VERSION, ...parts]))));
}

async function signHex(key, ...parts) {
  return hex(await signBytes(key, ...parts));
}

async function verifyHex(key, proof, ...parts) {
  if (!valid(proof) || !key) return false;
  return crypto.subtle.verify('HMAC', key, unhex(proof), encoder.encode(JSON.stringify([VERSION, ...parts])));
}

export async function connectBridge({
  port,
  origin,
  pairing,
  WebSocketClass = WebSocket,
  onClose = () => {},
  onReadRequest,
  clock: customClock,
}) {
  const clock = {
    now: customClock?.now || Date.now,
    setTimeout: customClock?.setTimeout || ((...args) => globalThis.setTimeout(...args)),
    clearTimeout: customClock?.clearTimeout || (id => globalThis.clearTimeout(id)),
  };

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
    !valid(pairing?.id) ||
    !valid(pairing?.secret) ||
    !Number.isSafeInteger(pairing.expires) ||
    clock.now() >= pairing.expires
  ) {
    throw new Error('invalid pairing');
  }

  const pairingId = pairing.id;
  const pairingExpires = pairing.expires;
  const rawPairingBytes = unhex(pairing.secret);
  let pairingKey = await importHmacKey(rawPairingBytes);
  rawPairingBytes.fill(0);

  const ws = new WebSocketClass(`ws://127.0.0.1:${port}/nox`);
  let state = 'challenge';
  let nonce;
  let challenge;
  let sessionId = null;
  let sessionKey = null;
  let sessionExpires = 0;
  let sequence = 0;
  let serverSeq = 0;
  let pendingPing = null;
  let activeRead = null;
  let activeReadTimer = null;
  let sessionTimer = null;
  let queuedFrames = 0;
  let receiveChain = Promise.resolve();
  let sendChain = Promise.resolve();
  const seenRequestIds = new Set();

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const handshakeTimer = clock.setTimeout(() => fail(), 5000);

  function fail() {
    if (state === 'closed') return;
    state = 'closed';
    clock.clearTimeout(handshakeTimer);
    clock.clearTimeout(sessionTimer);
    clock.clearTimeout(activeReadTimer);
    sessionTimer = activeReadTimer = null;
    activeRead = null;
    pairingKey = null;
    sessionKey = null;
    seenRequestIds.clear();
    rejectReady(new Error('bridge authentication failed'));
    if (pendingPing) {
      clock.clearTimeout(pendingPing.timer);
      pendingPing.reject(new Error('bridge disconnected'));
      pendingPing = null;
    }
    try {
      ws.close();
    } catch {}
  }

  function sendSigned(buildFrame) {
    const task = sendChain.then(async () => {
      if (state !== 'ready' || !sessionKey || clock.now() >= sessionExpires) {
        throw new Error('bridge unavailable');
      }
      const seq = sequence + 1;
      const frame = await buildFrame(seq, sessionKey, sessionId);
      const raw = JSON.stringify(frame);
      if (utf8Bytes(raw) > MAX_FRAME_BYTES) {
        throw new Error('frame exceeds 64 KiB');
      }
      ws.send(raw);
      sequence = seq;
      return seq;
    });
    sendChain = task.catch(() => {});
    return task;
  }

  function sendReadError(requestId, errorText) {
    const safeError = typeof errorText === 'string' && errorText.length > 0 ? errorText.slice(0, 128) : 'denied';
    return sendSigned(async (seq, key, sid) => ({
      type: 'read_result',
      seq,
      requestId,
      ok: false,
      error: safeError,
      proof: await signHex(key, 'c2s', 'read_result', sid, seq, requestId, false, safeError),
    })).catch(() => {});
  }

  function handleReadRequest(msg) {
    if (activeRead) {
      sendReadError(msg.requestId, 'busy');
      return;
    }
    if (typeof onReadRequest !== 'function') {
      sendReadError(msg.requestId, 'unsupported');
      return;
    }

    const requestId = msg.requestId;
    const expiresAt = msg.expiresAt;
    activeRead = requestId;
    const remainingMs = Math.max(1, expiresAt - clock.now());
    activeReadTimer = clock.setTimeout(() => {
      if (activeRead === requestId) {
        activeRead = null;
        activeReadTimer = null;
      }
    }, remainingMs);

    Promise.resolve()
      .then(() => onReadRequest({ requestId, expiresAt }))
      .then(async result => {
        if (activeRead !== requestId) {
          return;
        }
        clock.clearTimeout(activeReadTimer);
        activeReadTimer = null;
        activeRead = null;
        if (state !== 'ready' || clock.now() >= expiresAt || clock.now() >= sessionExpires) {
          return;
        }

        if (!result || result.ok !== true) {
          await sendReadError(requestId, result?.error || 'permission_required');
          return;
        }

        await sendSigned(async (seq, key, sid) => {
          const fitted = fitReadResult({
            seq,
            requestId,
            origin: result.origin,
            title: result.title || '',
            text: result.text || '',
            truncated: Boolean(result.truncated),
          });
          const proof = await signHex(
            key,
            'c2s',
            'read_result',
            sid,
            seq,
            requestId,
            true,
            fitted.origin,
            fitted.title,
            fitted.text,
            fitted.truncated
          );
          return {
            type: 'read_result',
            seq,
            requestId,
            ok: true,
            origin: fitted.origin,
            title: fitted.title,
            text: fitted.text,
            truncated: fitted.truncated,
            proof,
          };
        });
      })
      .catch(() => {
        if (activeRead !== requestId) {
          return;
        }
        clock.clearTimeout(activeReadTimer);
        activeReadTimer = null;
        activeRead = null;
        if (state === 'ready' && clock.now() < expiresAt && clock.now() < sessionExpires) {
          sendReadError(requestId, 'read_failed');
        }
      });
  }

  async function processFrame(raw) {
    if (state === 'closed') return;
    if (typeof raw !== 'string' || utf8Bytes(raw) > MAX_FRAME_BYTES) return fail();
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail();

    if (state === 'challenge') {
      if (
        clock.now() >= pairingExpires ||
        !hasExactKeys(msg, ['type', 'version', 'challenge']) ||
        msg.type !== 'challenge' ||
        msg.version !== VERSION ||
        !valid(msg.challenge)
      ) {
        return fail();
      }
      challenge = msg.challenge;
      nonce = random();
      const proof = await signHex(pairingKey, 'c2s', 'authenticate', origin, pairingId, challenge, nonce);
      if (state !== 'challenge') return;
      state = 'authentication';
      ws.send(JSON.stringify({ type: 'authenticate', id: pairingId, nonce, proof }));
      return;
    }

    if (state === 'authentication') {
      const t = clock.now();
      if (
        t >= pairingExpires ||
        !hasExactKeys(msg, ['type', 'session', 'sessionExpires', 'proof']) ||
        msg.type !== 'authenticated' ||
        !valid(msg.session) ||
        !Number.isSafeInteger(msg.sessionExpires) ||
        msg.sessionExpires <= t ||
        msg.sessionExpires - t > MAX_SESSION_TTL_MS
      ) {
        return fail();
      }
      const ok = await verifyHex(
        pairingKey,
        msg.proof,
        's2c',
        'authenticated',
        origin,
        pairingId,
        challenge,
        nonce,
        msg.session,
        msg.sessionExpires
      );
      if (!ok || state !== 'authentication') return fail();

      const derivedBytes = await signBytes(
        pairingKey,
        'session-key',
        origin,
        pairingId,
        challenge,
        nonce,
        msg.session,
        msg.sessionExpires
      );
      sessionKey = await importHmacKey(derivedBytes);
      derivedBytes.fill(0);
      pairingKey = null;

      sessionId = msg.session;
      sessionExpires = msg.sessionExpires;
      state = 'ready';
      clock.clearTimeout(handshakeTimer);
      sessionTimer = clock.setTimeout(() => fail(), Math.max(0, sessionExpires - clock.now()));
      resolveReady();
      return;
    }

    if (state === 'ready') {
      const t = clock.now();
      if (t >= sessionExpires || !sessionKey) return fail();

      if (msg.type === 'pong') {
        if (
          !hasExactKeys(msg, ['type', 'seq', 'proof']) ||
          !pendingPing ||
          msg.seq !== pendingPing.seq ||
          !(await verifyHex(sessionKey, msg.proof, 's2c', 'pong', sessionId, msg.seq))
        ) {
          return fail();
        }
        const current = pendingPing;
        pendingPing = null;
        clock.clearTimeout(current.timer);
        current.resolve();
        return;
      }

      if (msg.type === 'read_request') {
        if (
          !hasExactKeys(msg, ['type', 'seq', 'requestId', 'issuedAt', 'expiresAt', 'proof']) ||
          !Number.isSafeInteger(msg.seq) ||
          msg.seq !== serverSeq + 1 ||
          !valid(msg.requestId) ||
          seenRequestIds.has(msg.requestId) ||
          !Number.isSafeInteger(msg.issuedAt) ||
          !Number.isSafeInteger(msg.expiresAt) ||
          msg.expiresAt <= msg.issuedAt ||
          msg.expiresAt - msg.issuedAt > MAX_READ_TIMEOUT_MS ||
          !(await verifyHex(
            sessionKey,
            msg.proof,
            's2c',
            'read_request',
            sessionId,
            msg.seq,
            msg.requestId,
            msg.issuedAt,
            msg.expiresAt
          ))
        ) {
          return fail();
        }
        serverSeq = msg.seq;
        seenRequestIds.add(msg.requestId);
        if (seenRequestIds.size > 1024) {
          seenRequestIds.delete(seenRequestIds.values().next().value);
        }
        if (clock.now() >= msg.expiresAt) return fail();
        handleReadRequest(msg);
        return;
      }
    }

    fail();
  }

  ws.addEventListener('error', fail);
  ws.addEventListener('close', () => {
    fail();
    onClose();
  });
  ws.addEventListener('message', event => {
    if (state === 'closed' || queuedFrames >= MAX_QUEUED_FRAMES) {
      fail();
      return;
    }
    queuedFrames += 1;
    receiveChain = receiveChain
      .then(() => processFrame(event.data))
      .catch(fail)
      .finally(() => {
        queuedFrames = Math.max(0, queuedFrames - 1);
      });
  });

  await ready;

  return {
    get sessionId() {
      return sessionId;
    },
    get sessionExpires() {
      return sessionExpires;
    },
    async ping() {
      if (state !== 'ready' || pendingPing || clock.now() >= sessionExpires) {
        throw new Error('bridge unavailable');
      }
      let currentPing;
      const result = new Promise((resolve, reject) => {
        const timer = clock.setTimeout(fail, 5000);
        currentPing = { seq: null, resolve, reject, timer };
        pendingPing = currentPing;
      });
      try {
        await sendSigned(async (seq, key, sid) => {
          currentPing.seq = seq;
          return {
            type: 'ping',
            seq,
            proof: await signHex(key, 'c2s', 'ping', sid, seq),
          };
        });
      } catch (err) {
        if (pendingPing === currentPing) {
          clock.clearTimeout(currentPing.timer);
          pendingPing = null;
        }
        throw err;
      }
      return result;
    },
    close() {
      fail();
    },
  };
}
