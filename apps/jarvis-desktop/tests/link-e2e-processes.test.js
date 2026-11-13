'use strict';

// Этап C: реальные двухпроцессные E2E-проверки по TCP (Node <-> Node и Electron <-> Electron)
// с временными профилями, разрывами, SIGKILL, повторным сопряжением, отзывом, истечением
// сертификатов, восстановлением после перезапуска, задержкой и склейкой TCP-данных.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  DAY_MS,
  PeerTrustStore,
  diagnoseIdentityRecovery,
  verifyDeviceCertPair,
} = require('../src/link');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWorkerSource(linkEntry) {
  return `'use strict';
const net = require('node:net');
const isElectron = Boolean(process.versions && process.versions.electron);
let electronApp = null;
let electronSafeStorage = null;

if (isElectron) {
  const electron = require('electron');
  electronApp = electron.app;
  electronSafeStorage = electron.safeStorage;
  const userDataArg = process.argv.find((a) => a.startsWith('--nox-user-data='));
  if (userDataArg) {
    electronApp.setPath('userData', userDataArg.slice('--nox-user-data='.length));
  }
  electronApp.on('window-all-closed', (e) => e.preventDefault());
}

const link = require(${JSON.stringify(linkEntry)});

let rpcSocket = null;
function emitRpc(obj) {
  if (rpcSocket && !rpcSocket.destroyed) {
    rpcSocket.write('__NOX_RPC__:' + JSON.stringify(obj) + '\\n');
  }
}

function emitEvent(event, data) {
  if (rpcSocket && !rpcSocket.destroyed) {
    rpcSocket.write('__NOX_EVT__:' + JSON.stringify({ event, data }) + '\\n');
  }
}

const state = {
  identity: null,
  peerStore: null,
  server: null,
  pendingSockets: [],
  socketWaiters: [],
  session: null,
  sessionSeq: 0,
  lastSas: null,
};

function pushIncomingSocket(sock) {
  try { sock.setNoDelay(true); } catch { /* ignore */ }
  sock.on('error', () => {});
  const waiter = state.socketWaiters.shift();
  if (waiter) {
    waiter.resolve(sock);
  } else {
    state.pendingSockets.push(sock);
  }
}

function nextIncomingSocket(timeoutMs = 15_000) {
  if (state.pendingSockets.length > 0) {
    return Promise.resolve(state.pendingSockets.shift());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = state.socketWaiters.indexOf(entry);
      if (idx !== -1) state.socketWaiters.splice(idx, 1);
      reject(new Error('tcp_accept_timeout'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const entry = {
      resolve: (sock) => { clearTimeout(timer); resolve(sock); },
    };
    state.socketWaiters.push(entry);
  });
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host, () => {
      try { sock.setNoDelay(true); } catch { /* ignore */ }
      resolve(sock);
    });
    sock.on('error', () => {});
    sock.once('error', reject);
  });
}

function attachSession(sess) {
  state.session = sess;
  state.sessionSeq += 1;
  const seq = state.sessionSeq;
  sess.onClose((err) => {
    emitEvent('session_closed', {
      sessionSeq: seq,
      code: err && err.code ? err.code : 'unknown',
      message: err && err.message ? err.message : '',
    });
  });
  return seq;
}

async function handleCommand(cmd, args = {}) {
  switch (cmd) {
    case 'init': {
      const protect = args.useSafeStorage ? electronSafeStorage : undefined;
      if (args.useSafeStorage && (!protect || !protect.isEncryptionAvailable())) {
        throw new Error('safeStorage_unavailable');
      }
      state.identity = await link.loadOrCreateIdentity({
        dataDir: args.dataDir,
        deviceName: args.deviceName,
        protect,
        allowTestUnencrypted: Boolean(args.allowTestUnencrypted),
        ...(args.leafDays ? { leafDays: args.leafDays } : {}),
        ...(args.renewBeforeDays !== undefined ? { renewBeforeDays: args.renewBeforeDays } : {}),
        ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
      });
      state.peerStore = new link.PeerTrustStore({ dataDir: args.dataDir });
      return {
        deviceId: state.identity.deviceId,
        deviceName: state.identity.deviceName,
        caPem: state.identity.caPem,
        caFp256: state.identity.caFp256,
        leafPem: state.identity.leafPem,
        leafFp256: state.identity.leafFp256,
        storageMode: state.identity.storageMode,
        lastRotationReason: state.identity.lastRotationReason,
        pendingLeafUpdate: state.identity.pendingLeafUpdate,
        electron: process.versions.electron || null,
        openssl: process.versions.openssl || null,
      };
    }

    case 'listenTcp': {
      if (state.server) {
        return { port: state.server.address().port };
      }
      state.server = net.createServer((sock) => pushIncomingSocket(sock));
      await new Promise((resolve, reject) => {
        state.server.once('error', reject);
        state.server.listen(0, '127.0.0.1', () => {
          state.server.off('error', reject);
          resolve();
        });
      });
      return { port: state.server.address().port };
    }

    case 'acceptPair': {
      const sock = await nextIncomingSocket(args.acceptTimeoutMs || 15_000);
      let sasSeen = null;
      const out = await link.runPairingSession({
        transport: sock,
        role: 'host',
        roomId: args.roomId,
        identity: state.identity,
        expectedPeer: args.expectedPeer,
        peerStore: state.peerStore,
        allowReplace: Boolean(args.allowReplace),
        allowCaChange: Boolean(args.allowCaChange),
        phaseTimeoutMs: args.phaseTimeoutMs || 15_000,
        confirmTimeoutMs: args.confirmTimeoutMs || 10_000,
        handshakeTimeoutMs: args.handshakeTimeoutMs || 15_000,
        onConfirmSas: async (info) => {
          sasSeen = info.sasCode;
          return { confirmed: args.confirmSas !== false };
        },
      });
      return {
        ok: out.ok,
        sasCode: out.sasCode,
        sas: sasSeen,
        transcriptHash: out.transcriptHash,
        certChange: out.certChange,
        peerDeviceId: out.peer.deviceId,
        peerLeafFp256: out.peer.leafFp256,
      };
    }

    case 'connectAndPair': {
      const sock = await connectTcp(args.host || '127.0.0.1', args.port);
      let sasSeen = null;
      const out = await link.runPairingSession({
        transport: sock,
        role: 'client',
        roomId: args.roomId,
        identity: state.identity,
        expectedPeer: args.expectedPeer,
        peerStore: state.peerStore,
        allowReplace: Boolean(args.allowReplace),
        allowCaChange: Boolean(args.allowCaChange),
        phaseTimeoutMs: args.phaseTimeoutMs || 15_000,
        confirmTimeoutMs: args.confirmTimeoutMs || 10_000,
        handshakeTimeoutMs: args.handshakeTimeoutMs || 15_000,
        onConfirmSas: async (info) => {
          sasSeen = info.sasCode;
          return { confirmed: args.confirmSas !== false };
        },
      });
      return {
        ok: out.ok,
        sasCode: out.sasCode,
        sas: sasSeen,
        transcriptHash: out.transcriptHash,
        certChange: out.certChange,
        peerDeviceId: out.peer.deviceId,
        peerLeafFp256: out.peer.leafFp256,
      };
    }

    case 'acceptTls': {
      const sock = await nextIncomingSocket(args.acceptTimeoutMs || 15_000);
      const sess = await link.establishMutualTls({
        stream: sock,
        role: 'server',
        identity: state.identity,
        expectedPeer: args.expectedPeer,
        peerStore: state.peerStore,
        handshakeTimeoutMs: args.handshakeTimeoutMs || 8_000,
        heartbeatIntervalMs: 0,
        ...(args.nowMs !== undefined ? { now: () => args.nowMs } : {}),
      });
      const seq = attachSession(sess);
      return {
        sessionSeq: seq,
        peerDeviceId: sess.peerDeviceId,
        peerLeafFp256: sess.peerLeafFp256,
        protocol: sess.protocol,
      };
    }

    case 'connectTls': {
      const sock = await connectTcp(args.host || '127.0.0.1', args.port);
      const sess = await link.establishMutualTls({
        stream: sock,
        role: 'client',
        identity: state.identity,
        expectedPeer: args.expectedPeer,
        peerStore: state.peerStore,
        handshakeTimeoutMs: args.handshakeTimeoutMs || 8_000,
        heartbeatIntervalMs: 0,
        ...(args.nowMs !== undefined ? { now: () => args.nowMs } : {}),
      });
      const seq = attachSession(sess);
      return {
        sessionSeq: seq,
        peerDeviceId: sess.peerDeviceId,
        peerLeafFp256: sess.peerLeafFp256,
        protocol: sess.protocol,
      };
    }

    case 'sendFrame': {
      await state.session.sendFrame(args.frame);
      return { sent: true };
    }

    case 'waitFrame': {
      const frame = await state.session.waitNextFrame({
        timeoutMs: args.timeoutMs || 5_000,
        predicate: args.type ? (f) => f.type === args.type : null,
      });
      return frame;
    }

    case 'closeSession': {
      if (state.session) {
        const s = state.session;
        state.session = null;
        await s.close();
      }
      return { closed: true };
    }

    case 'revokePeer': {
      state.peerStore.revokePeer(args.deviceId, { by: args.by || 'worker', reason: args.reason || 'revoked' });
      return { ok: true };
    }

    case 'getPeer': {
      state.peerStore.sync();
      return state.peerStore.getPeer(args.deviceId);
    }

    case 'rotateLeaf': {
      const rotated = await state.identity.rotateLeaf({
        reason: args.reason || 'proactive',
        ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
      });
      return {
        leafFp256: state.identity.leafFp256,
        pendingLeafUpdate: rotated.pendingLeafUpdate,
      };
    }

    case 'sendLeafUpdate': {
      return await link.sendLeafUpdateOverSession(state.session, {
        identity: state.identity,
        timeoutMs: args.timeoutMs || 5_000,
      });
    }

    case 'acceptLeafUpdate': {
      return await link.acceptLeafUpdateOverSession(state.session, {
        peerStore: state.peerStore,
        timeoutMs: args.timeoutMs || 5_000,
        confirmTimeoutMs: args.confirmTimeoutMs || 5_000,
        onConfirmCertUpdate: async () => ({ confirmed: args.confirm !== false }),
      });
    }

    case 'updateCertExpiry': {
      state.session.updateCertExpiry(args.expiresAtMs);
      return { ok: true };
    }

    case 'shutdown': {
      try { if (state.session) await state.session.close(); } catch { /* ignore */ }
      try { if (state.server) state.server.close(); } catch { /* ignore */ }
      try { if (state.peerStore) state.peerStore.close(); } catch { /* ignore */ }
      try { if (state.identity) state.identity.dispose(); } catch { /* ignore */ }
      setImmediate(() => {
        if (electronApp) {
          setTimeout(() => {
            try { electronApp.exit(0); } catch { /* ignore */ }
          }, 1500).unref();
          electronApp.quit();
        } else {
          process.exit(0);
        }
      });
      return { bye: true };
    }

    default:
      throw new Error('unknown_command: ' + cmd);
  }
}

function startRpcLoop(rpcPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(rpcPort, '127.0.0.1', () => {
      try { sock.setNoDelay(true); } catch { /* ignore */ }
      rpcSocket = sock;
      resolve();
    });
    sock.on('error', () => {});
    sock.once('error', reject);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        Promise.resolve()
          .then(() => handleCommand(req.cmd, req.args))
          .then(
            (result) => emitRpc({ id: req.id, ok: true, result }),
            (err) => emitRpc({
              id: req.id,
              ok: false,
              error: {
                name: err && err.name ? err.name : 'Error',
                code: err && err.code ? err.code : null,
                message: err && err.message ? err.message : String(err),
              },
            }),
          );
      }
    });
  });
}

(async () => {
  try {
    if (electronApp) {
      await electronApp.whenReady();
    }
    const rpcArg = process.argv.find((a) => a.startsWith('--nox-rpc-port='));
    const rpcPort = Number(rpcArg.slice('--nox-rpc-port='.length));
    await startRpcLoop(rpcPort);
    emitEvent('ready', { pid: process.pid, electron: process.versions.electron || null });
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\\n');
    if (electronApp) electronApp.exit(1);
    else process.exit(1);
  }
})();
`;
}

async function spawnWorker({ label = 'worker', executable, args = [], env }) {
  let activeRpcSock = null;
  const queuedOutgoing = [];
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const eventWaiters = [];
  let stderr = '';
  let exited = false;
  let exitInfo = null;
  const exitWaiters = [];

  const rejectAll = (reason) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  };

  const rpcServer = net.createServer((sock) => {
    try { sock.setNoDelay(true); } catch { /* ignore */ }
    sock.on('error', () => {});
    activeRpcSock = sock;
    while (queuedOutgoing.length > 0) {
      sock.write(queuedOutgoing.shift());
    }
    let outBuf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      outBuf += chunk;
      let nl;
      while ((nl = outBuf.indexOf('\n')) !== -1) {
        const line = outBuf.slice(0, nl).replace(/\r$/, '');
        outBuf = outBuf.slice(nl + 1);
        if (line.startsWith('__NOX_RPC__:')) {
          const msg = JSON.parse(line.slice('__NOX_RPC__:'.length));
          const waiter = pending.get(msg.id);
          if (!waiter) continue;
          pending.delete(msg.id);
          clearTimeout(waiter.timer);
          if (msg.ok) {
            waiter.resolve(msg.result);
          } else {
            const err = new Error(msg.error?.message || 'worker_rpc_error');
            err.code = msg.error?.code || null;
            err.remoteName = msg.error?.name || null;
            waiter.reject(err);
          }
        } else if (line.startsWith('__NOX_EVT__:')) {
          const evt = JSON.parse(line.slice('__NOX_EVT__:'.length));
          const idx = eventWaiters.findIndex((w) => w.event === evt.event && (!w.predicate || w.predicate(evt.data)));
          if (idx !== -1) {
            const [w] = eventWaiters.splice(idx, 1);
            clearTimeout(w.timer);
            w.resolve(evt.data);
          } else {
            events.push(evt);
          }
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    rpcServer.once('error', reject);
    rpcServer.listen(0, '127.0.0.1', () => {
      rpcServer.off('error', reject);
      resolve();
    });
  });
  const rpcPort = rpcServer.address().port;

  const proc = spawn(executable, [...args, `--nox-rpc-port=${rpcPort}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  proc.once('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    if (activeRpcSock && !activeRpcSock.destroyed) {
      try { activeRpcSock.destroy(); } catch { /* ignore */ }
    }
    try { rpcServer.close(); } catch { /* ignore */ }
    rejectAll(new Error(`worker_exited code=${code} signal=${signal} stderr=${stderr}`));
    while (exitWaiters.length > 0) {
      exitWaiters.shift()(exitInfo);
    }
  });

  const controller = {
    proc,
    get pid() { return proc.pid; },
    get stderr() { return stderr; },
    call(cmd, cmdArgs = {}, timeoutMs = 20_000) {
      if (exited) {
        return Promise.reject(new Error(`worker_already_exited (${JSON.stringify(exitInfo)})`));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`worker_rpc_timeout cmd=${cmd} stderr=${stderr}`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(id, { resolve, reject, timer });
        const payload = `${JSON.stringify({ id, cmd, args: cmdArgs })}\n`;
        if (activeRpcSock && !activeRpcSock.destroyed) {
          activeRpcSock.write(payload);
        } else {
          queuedOutgoing.push(payload);
        }
      });
    },
    waitEvent(event, timeoutMs = 15_000, predicate = null) {
      const idx = events.findIndex((e) => e.event === event && (!predicate || predicate(e.data)));
      if (idx !== -1) {
        return Promise.resolve(events.splice(idx, 1)[0].data);
      }
      return new Promise((resolve, reject) => {
        const entry = {
          event,
          predicate,
          resolve,
          timer: setTimeout(() => {
            const pos = eventWaiters.indexOf(entry);
            if (pos !== -1) eventWaiters.splice(pos, 1);
            reject(new Error(`worker_event_timeout[${label}] event=${event} buffered=${JSON.stringify(events)} stderr=${stderr}`));
          }, timeoutMs),
        };
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
        eventWaiters.push(entry);
      });
    },
    waitExit(timeoutMs = 10_000) {
      if (exited) return Promise.resolve(exitInfo);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker_exit_timeout')), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        exitWaiters.push((info) => {
          clearTimeout(timer);
          resolve(info);
        });
      });
    },
    async shutdown() {
      if (!exited) {
        try {
          await controller.call('shutdown', {}, 3_000);
        } catch { /* ignore */ }
        await controller.waitExit(4_000).catch(() => {});
      }
      if (!exited) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        await controller.waitExit(3_000).catch(() => {});
      }
    },
    forceKill() {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      return controller.waitExit(5_000);
    },
  };

  return controller;
}

// Прозрачный TCP-прокси в процессе-координаторе: вносит задержки, режет кадры
// на мелкие куски и склеивает пару (pair_sas_ok + TLS ClientHello 0x16) в один TCP-write.
async function createTcpShaperProxy(targetPort) {
  const stats = {
    connections: 0,
    coalescedTlsStarts: 0,
    chunkedWrites: 0,
  };
  const openSockets = new Set();

  function forwardStream(src, dst, { coalesceBeforeTls = false } = {}) {
    let held = Buffer.alloc(0);
    let holdTimer = null;
    let queue = Promise.resolve();
    let seenSasOk = false;

    const flushHeld = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (held.length === 0 || dst.destroyed || dst.writableEnded) return;
      const toSend = held;
      held = Buffer.alloc(0);
      queue = queue.then(async () => {
        if (dst.destroyed || dst.writableEnded) return;
        // Первый байт TLS ClientHello — 0x16. Склеиваем pair_reveal\n и ClientHello в один TCP-пакет.
        const revealPos = toSend.indexOf('"type":"pair_reveal"');
        const revealNlIdx = revealPos !== -1 ? toSend.indexOf(0x0a, revealPos) : -1;
        if (coalesceBeforeTls && revealNlIdx !== -1 && revealNlIdx + 1 < toSend.length && toSend[revealNlIdx + 1] === 0x16) {
          stats.coalescedTlsStarts += 1;
          dst.write(toSend);
          return;
        }
        // Дробим трафик на маленькие фрагменты с небольшой TCP-задержкой.
        const sliceSizes = [1, 3, 7, 19, 31];
        let offset = 0;
        let idx = 0;
        while (offset < toSend.length) {
          if (dst.destroyed || dst.writableEnded) return;
          const step = sliceSizes[idx % sliceSizes.length];
          idx += 1;
          dst.write(toSend.subarray(offset, offset + step));
          stats.chunkedWrites += 1;
          offset += step;
          if (offset < toSend.length) {
            await new Promise((r) => setImmediate(r));
          }
        }
      }).catch(() => {});
    };

    src.on('data', (chunk) => {
      held = Buffer.concat([held, chunk]);
      const revealPos = held.indexOf('"type":"pair_reveal"');
      if (coalesceBeforeTls && revealPos !== -1 && !seenSasOk) {
        const revealNlIdx = held.indexOf(0x0a, revealPos);
        const hasTlsAfterReveal = revealNlIdx !== -1 && revealNlIdx + 1 < held.length && held[revealNlIdx + 1] === 0x16;
        // Если TLS ClientHello (0x16) ещё не пришёл — ждём до 1500 мс (сбрасывается мгновенно по приходу ClientHello),
        // чтобы гарантированно склеить pair_reveal + ClientHello даже под параллельной нагрузкой.
        if (!hasTlsAfterReveal) {
          if (holdTimer) clearTimeout(holdTimer);
          holdTimer = setTimeout(() => {
            seenSasOk = true;
            flushHeld();
          }, 1500);
          return;
        }
        seenSasOk = true;
        flushHeld();
        return;
      }

      if (coalesceBeforeTls && seenSasOk && held.includes(0x16)) {
        flushHeld();
        return;
      }

      setTimeout(flushHeld, 2);
    });

    src.once('end', () => {
      flushHeld();
      queue = queue.then(() => {
        if (!dst.destroyed && !dst.writableEnded) dst.end();
      });
    });
    src.once('close', () => {
      if (holdTimer) clearTimeout(holdTimer);
      queue = queue.then(() => {
        if (!dst.destroyed && src.destroyed) dst.destroy();
      });
    });
    src.once('error', () => {
      if (holdTimer) clearTimeout(holdTimer);
      if (!dst.destroyed) dst.destroy();
    });
  }

  const server = net.createServer((clientSock) => {
    stats.connections += 1;
    try { clientSock.setNoDelay(true); } catch { /* ignore */ }
    const serverSock = net.connect(targetPort, '127.0.0.1', () => {
      try { serverSock.setNoDelay(true); } catch { /* ignore */ }
    });
    openSockets.add(clientSock);
    openSockets.add(serverSock);
    clientSock.once('close', () => openSockets.delete(clientSock));
    serverSock.once('close', () => openSockets.delete(serverSock));

    forwardStream(clientSock, serverSock, { coalesceBeforeTls: true });
    forwardStream(serverSock, clientSock, { coalesceBeforeTls: false });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: server.address().port,
    stats,
    async close() {
      for (const s of openSockets) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test('Этап C1 (Node <-> Node, два ОС-процесса по TCP): сопряжение со склейкой, mTLS 1.3, отзыв, SIGKILL, перезапуск, истечение и ротация', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-e2e-node-'));
  const hostDir = path.join(tempRoot, 'host-data');
  const clientDir = path.join(tempRoot, 'client-data');
  const workerPath = path.join(tempRoot, 'worker.cjs');
  const linkEntry = path.resolve(__dirname, '../src/link');
  fs.mkdirSync(hostDir, { recursive: true });
  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(workerPath, buildWorkerSource(linkEntry), 'utf8');

  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;

  let hostProc = null;
  let clientProc = null;
  let clientProc2 = null;
  let clientProc3 = null;
  let proxy = null;

  try {
    hostProc = await spawnWorker({
      label: 'node-host',
      executable: process.execPath,
      args: [workerPath],
      env: { ...baseEnv, NOX_DATA_DIR: hostDir, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
    });
    clientProc = await spawnWorker({
      label: 'node-client',
      executable: process.execPath,
      args: [workerPath],
      env: { ...baseEnv, NOX_DATA_DIR: clientDir, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
    });
    await Promise.all([hostProc.waitEvent('ready'), clientProc.waitEvent('ready')]);

    const t0 = Date.now();
    const [hostId, clientId] = await Promise.all([
      hostProc.call('init', { dataDir: hostDir, deviceName: 'Node Host', allowTestUnencrypted: true, nowMs: t0 }),
      clientProc.call('init', { dataDir: clientDir, deviceName: 'Node Client', allowTestUnencrypted: true, nowMs: t0 }),
    ]);

    const { port: hostPort } = await hostProc.call('listenTcp');
    proxy = await createTcpShaperProxy(hostPort);

    // 1. Сопряжение через реальный TCP с задержкой, дроблением и склейкой pair_sas_ok + ClientHello.
    const [pairHost, pairClient] = await Promise.all([
      hostProc.call('acceptPair', {
        roomId: 'e2e-node-room-1',
        expectedPeer: { deviceId: clientId.deviceId, deviceName: 'Node Client' },
      }),
      clientProc.call('connectAndPair', {
        port: proxy.port,
        roomId: 'e2e-node-room-1',
        expectedPeer: { deviceId: hostId.deviceId, deviceName: 'Node Host' },
      }),
    ]);

    assert.equal(pairHost.ok, true);
    assert.equal(pairClient.ok, true);
    assert.equal(pairHost.sas, pairClient.sas);
    assert.equal(pairHost.transcriptHash, pairClient.transcriptHash);
    assert.ok(proxy.stats.chunkedWrites > 0, 'Ожидали реальное дробление TCP-данных через прокси');
    assert.ok(proxy.stats.coalescedTlsStarts >= 1, 'Ожидали склейку pair_reveal + TLS ClientHello в одном TCP-пакете');

    // Устанавливаем рабочий mTLS 1.3 сеанс поверх уже сохранённого доверия (peers.json).
    const [tlsH1, tlsC1] = await Promise.all([
      hostProc.call('acceptTls', {
        expectedPeer: { deviceId: clientId.deviceId, rootCaPem: clientId.caPem, leafFp256: clientId.leafFp256 },
      }),
      clientProc.call('connectTls', {
        port: hostPort,
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
      }),
    ]);
    assert.equal(tlsH1.protocol, 'TLSv1.3');
    assert.equal(tlsC1.protocol, 'TLSv1.3');

    const pingWait = hostProc.call('waitFrame', { type: 'e2e_ping' });
    await clientProc.call('sendFrame', { frame: { v: 3, type: 'e2e_ping', step: 1 } });
    const pingMsg = await pingWait;
    assert.equal(pingMsg.step, 1);

    // 2. Чистый разрыв соединения и переподключение по TCP без повторного сопряжения.
    await Promise.all([hostProc.call('closeSession'), clientProc.call('closeSession')]);
    await proxy.close();
    proxy = null;

    const [reconnH, reconnC] = await Promise.all([
      hostProc.call('acceptTls', {
        expectedPeer: { deviceId: clientId.deviceId, rootCaPem: clientId.caPem, leafFp256: clientId.leafFp256 },
      }),
      clientProc.call('connectTls', {
        port: hostPort,
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
      }),
    ]);
    assert.equal(reconnH.protocol, 'TLSv1.3');
    assert.equal(reconnC.protocol, 'TLSv1.3');

    // 3. Отзыв доверия из внешнего хранилища во время активной TCP-сессии -> немедленный разрыв и блок переподключения.
    const hostClosedAfterRevoke = hostProc.waitEvent('session_closed', 5_000, (d) => d.sessionSeq === reconnH.sessionSeq);
    const clientClosedAfterRevoke = clientProc.waitEvent('session_closed', 5_000, (d) => d.sessionSeq === reconnC.sessionSeq);
    const externalHostStore = new PeerTrustStore({ dataDir: hostDir });
    externalHostStore.revokePeer(clientId.deviceId, { by: 'external_process', reason: 'stage_c_revoke' });
    externalHostStore.close();

    const [hRevEvt, cRevEvt] = await Promise.all([hostClosedAfterRevoke, clientClosedAfterRevoke]);
    assert.equal(hRevEvt.code, 'peer_revoked');
    assert.ok(cRevEvt.code);

    const revokedAcceptPromise = hostProc.call('acceptTls', {
      expectedPeer: { deviceId: clientId.deviceId, rootCaPem: clientId.caPem, leafFp256: clientId.leafFp256 },
    });
    await assert.rejects(
      Promise.all([
        revokedAcceptPromise,
        clientProc.call('connectTls', {
          port: hostPort,
          expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
        }),
      ]),
    );

    // 4. Повторное сопряжение после отзыва (allowReplace: true) и обмен сообщениями.
    const [rePairH, rePairC] = await Promise.all([
      hostProc.call('acceptPair', {
        roomId: 'e2e-node-room-2',
        expectedPeer: { deviceId: clientId.deviceId, deviceName: 'Node Client' },
        allowReplace: true,
      }),
      clientProc.call('connectAndPair', {
        port: hostPort,
        roomId: 'e2e-node-room-2',
        expectedPeer: { deviceId: hostId.deviceId, deviceName: 'Node Host' },
        allowReplace: true,
      }),
    ]);
    assert.equal(rePairH.ok, true);
    assert.equal(rePairC.ok, true);
    assert.equal(rePairH.sas, rePairC.sas);

    const [killTlsH] = await Promise.all([
      hostProc.call('acceptTls', {
        expectedPeer: { deviceId: clientId.deviceId, rootCaPem: clientId.caPem, leafFp256: clientId.leafFp256 },
      }),
      clientProc.call('connectTls', {
        port: hostPort,
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
      }),
    ]);

    // 5. Аварийная остановка клиента (SIGKILL) + восстановление после перезапуска процесса.
    const hostClosedOnKill = hostProc.waitEvent('session_closed', 8_000, (d) => d.sessionSeq === killTlsH.sessionSeq);
    const killExit = await clientProc.forceKill();
    assert.notEqual(killExit.code, undefined);
    const killEvt = await hostClosedOnKill;
    assert.ok(killEvt.code === 'connection_closed' || killEvt.code === 'tls_socket_error');

    clientProc2 = await spawnWorker({
      executable: process.execPath,
      args: [workerPath],
      env: { ...baseEnv, NOX_DATA_DIR: clientDir, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
    });
    await clientProc2.waitEvent('ready');
    const client2Id = await clientProc2.call('init', {
      dataDir: clientDir,
      deviceName: 'Node Client',
      allowTestUnencrypted: true,
    });
    assert.equal(client2Id.deviceId, clientId.deviceId);
    assert.equal(client2Id.leafFp256, clientId.leafFp256);

    await Promise.all([
      hostProc.call('acceptTls', {
        expectedPeer: { deviceId: client2Id.deviceId, rootCaPem: client2Id.caPem, leafFp256: client2Id.leafFp256 },
      }),
      clientProc2.call('connectTls', {
        port: hostPort,
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
      }),
    ]);

    const afterRestartWait = hostProc.call('waitFrame', { type: 'after_sigkill' });
    await clientProc2.call('sendFrame', { frame: { v: 3, type: 'after_sigkill', ok: true } });
    assert.equal((await afterRestartWait).ok, true);

    // 6. Ротация leaf и подтверждённое обновление сертификата между живыми процессами по mTLS TCP.
    const rotated = await clientProc2.call('rotateLeaf', { reason: 'e2e_proactive' });
    assert.notEqual(rotated.leafFp256, client2Id.leafFp256);

    const [ackHost, ackClient] = await Promise.all([
      hostProc.call('acceptLeafUpdate', { confirm: true }),
      clientProc2.call('sendLeafUpdate'),
    ]);
    assert.equal(ackClient.ok, true);
    assert.equal(ackHost.leafFp256, rotated.leafFp256);

    await Promise.all([hostProc.call('closeSession'), clientProc2.call('closeSession')]);

    // Переподключаемся по TCP: сервер должен принять новый закреплённый leaf, а старый должен отвергаться.
    const [newLeafH, newLeafC] = await Promise.all([
      hostProc.call('acceptTls', {
        expectedPeer: { deviceId: client2Id.deviceId, rootCaPem: client2Id.caPem, leafFp256: rotated.leafFp256 },
      }),
      clientProc2.call('connectTls', {
        port: hostPort,
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
      }),
    ]);
    assert.equal(newLeafH.peerLeafFp256, rotated.leafFp256);
    assert.equal(newLeafC.protocol, 'TLSv1.3');

    // 7. Истечение сертификата во время активного сеанса + автоматическое восстановление истёкшего leaf на +95d при запуске.
    const expireEvtPromise = hostProc.waitEvent('session_closed', 5_000, (d) => d.sessionSeq === newLeafH.sessionSeq);
    await hostProc.call('updateCertExpiry', { expiresAtMs: Date.now() + 80 });
    const expireEvt = await expireEvtPromise;
    assert.equal(expireEvt.code, 'cert_expired');
    await clientProc2.shutdown();
    clientProc2 = null;

    // Запуск клиента через +95 суток (leaf на диске просрочен, Root CA действует):
    // новый процесс автоматически перевыпускает leaf, но старый хост без подтверждения нового пина должен его отвергнуть.
    const plus95d = t0 + 95 * DAY_MS;
    clientProc3 = await spawnWorker({
      executable: process.execPath,
      args: [workerPath],
      env: { ...baseEnv, NOX_DATA_DIR: clientDir, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
    });
    await clientProc3.waitEvent('ready');
    const recoveredClient = await clientProc3.call('init', {
      dataDir: clientDir,
      deviceName: 'Node Client',
      allowTestUnencrypted: true,
      nowMs: plus95d,
    });
    assert.equal(recoveredClient.deviceId, clientId.deviceId);
    assert.equal(recoveredClient.caFp256, clientId.caFp256);
    assert.equal(recoveredClient.lastRotationReason, 'expired_leaf_recovered');
    assert.notEqual(recoveredClient.leafFp256, rotated.leafFp256);
    const validRecovered = verifyDeviceCertPair({
      deviceId: recoveredClient.deviceId,
      caPem: recoveredClient.caPem,
      leafPem: recoveredClient.leafPem,
      nowMs: plus95d,
    });
    assert.equal(validRecovered.leafFp256, recoveredClient.leafFp256);

    await assert.rejects(
      Promise.all([
        hostProc.call('acceptTls', {
          expectedPeer: { deviceId: recoveredClient.deviceId },
          handshakeTimeoutMs: 4_000,
          nowMs: t0 + 10 * 1000,
        }),
        clientProc3.call('connectTls', {
          port: hostPort,
          expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
          handshakeTimeoutMs: 4_000,
          nowMs: plus95d,
        }),
      ]),
    );

    // Истёкший Root CA на +3700d даёт честный вердикт о необходимости сброса и повторного сопряжения.
    const expiredCaDiag = diagnoseIdentityRecovery({
      dataDir: clientDir,
      deviceName: 'Node Client',
      allowTestUnencrypted: true,
      env: { ...baseEnv, NOX_DATA_DIR: clientDir, NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' },
      nowMs: t0 + 3700 * DAY_MS,
    });
    assert.equal(expiredCaDiag.status, 'ca_expired_reset_required');
    assert.equal(expiredCaDiag.requiresResetAndRepairing, true);
  } finally {
    if (proxy) await proxy.close().catch(() => {});
    if (clientProc3) await clientProc3.shutdown().catch(() => {});
    if (clientProc2) await clientProc2.shutdown().catch(() => {});
    if (clientProc) await clientProc.shutdown().catch(() => {});
    if (hostProc) await hostProc.shutdown().catch(() => {});
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Этап C2 (Electron 44.9.3 <-> Electron 44.9.3 по TCP): реальный DPAPI safeStorage + BoringSSL, склейка TCP, отзыв, SIGKILL и ротация', async () => {
  const electronPkg = require('electron');
  const electronExe = typeof electronPkg === 'string' ? electronPkg : process.execPath;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-e2e-elec-'));
  const hostUserDir = path.join(tempRoot, 'host-user-data');
  const clientUserDir = path.join(tempRoot, 'client-user-data');
  const hostDataDir = path.join(tempRoot, 'host-link-data');
  const clientDataDir = path.join(tempRoot, 'client-link-data');
  const workerPath = path.join(tempRoot, 'worker-electron.cjs');
  const linkEntry = path.resolve(__dirname, '../src/link');

  fs.mkdirSync(hostUserDir, { recursive: true });
  fs.mkdirSync(clientUserDir, { recursive: true });
  fs.mkdirSync(hostDataDir, { recursive: true });
  fs.mkdirSync(clientDataDir, { recursive: true });
  fs.writeFileSync(workerPath, buildWorkerSource(linkEntry), 'utf8');

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  let hostElec = null;
  let clientElec = null;
  let clientElecB = null;
  let clientElec2 = null;
  let proxy = null;

  try {
    hostElec = await spawnWorker({
      label: 'elec-host',
      executable: electronExe,
      args: [workerPath, `--user-data-dir=${hostUserDir}`, `--nox-user-data=${hostUserDir}`],
      env: childEnv,
    });
    clientElec = await spawnWorker({
      label: 'elec-client',
      executable: electronExe,
      args: [workerPath, `--user-data-dir=${clientUserDir}`, `--nox-user-data=${clientUserDir}`],
      env: childEnv,
    });
    await Promise.all([hostElec.waitEvent('ready', 30_000), clientElec.waitEvent('ready', 30_000)]);

    const [hostId, clientId] = await Promise.all([
      hostElec.call('init', { dataDir: hostDataDir, deviceName: 'Electron Host', useSafeStorage: true }, 30_000),
      clientElec.call('init', { dataDir: clientDataDir, deviceName: 'Electron Client', useSafeStorage: true }, 30_000),
    ]);
    assert.equal(hostId.storageMode, 'safeStorage');
    assert.equal(clientId.storageMode, 'safeStorage');
    assert.ok(hostId.electron);

    const { port: hostPort } = await hostElec.call('listenTcp');
    proxy = await createTcpShaperProxy(hostPort);

    // 1. Сопряжение двух отдельных процессов Electron по TCP через прокси (BoringSSL + safeStorage).
    const [pairH, pairC] = await Promise.all([
      hostElec.call('acceptPair', {
        roomId: 'e2e-elec-room-1',
        expectedPeer: { deviceId: clientId.deviceId, deviceName: 'Electron Client' },
      }, 25_000),
      clientElec.call('connectAndPair', {
        port: proxy.port,
        roomId: 'e2e-elec-room-1',
        expectedPeer: { deviceId: hostId.deviceId, deviceName: 'Electron Host' },
      }, 25_000),
    ]);
    assert.equal(pairH.ok, true);
    assert.equal(pairC.ok, true);
    assert.equal(pairH.sas, pairC.sas);
    assert.ok(proxy.stats.coalescedTlsStarts >= 1, 'Ожидали склейку pair_reveal + ClientHello для Electron TCP');

    await Promise.all([hostElec.call('closeSession'), clientElec.call('closeSession')]);
    await proxy.close();
    proxy = null;

    const [elecH1, elecC1] = await Promise.all([
      hostElec.call('acceptTls', {
        expectedPeer: { deviceId: clientId.deviceId, rootCaPem: clientId.caPem, leafFp256: clientId.leafFp256 },
      }),
      clientElec.call('connectTls', {
        port: hostPort,
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
      }),
    ]);
    assert.equal(elecH1.protocol, 'TLSv1.3');
    assert.equal(elecC1.protocol, 'TLSv1.3');

    const waitMsg = hostElec.call('waitFrame', { type: 'elec_msg' });
    await clientElec.call('sendFrame', { frame: { v: 3, type: 'elec_msg', value: 'hello_electron_tcp' } });
    assert.equal((await waitMsg).value, 'hello_electron_tcp');

    await Promise.all([hostElec.call('closeSession'), clientElec.call('closeSession')]);

    // Чистый перезапуск clientElec -> clientElecB сохраняет Local State / DPAPI и восстанавливает связь по TCP без сопряжения.
    await clientElec.shutdown();
    clientElec = null;

    clientElecB = await spawnWorker({
      label: 'elec-client-b',
      executable: electronExe,
      args: [workerPath, `--user-data-dir=${clientUserDir}`, `--nox-user-data=${clientUserDir}`],
      env: childEnv,
    });
    await clientElecB.waitEvent('ready', 30_000);
    const clientBId = await clientElecB.call('init', {
      dataDir: clientDataDir,
      deviceName: 'Electron Client',
      useSafeStorage: true,
    }, 30_000);
    assert.equal(clientBId.deviceId, clientId.deviceId);
    assert.equal(clientBId.storageMode, 'safeStorage');

    // 2. Переподключение без сопряжения и отзыв доверия по внешнему изменению peers.json.
    const [elecH2, elecC2] = await Promise.all([
      hostElec.call('acceptTls', {
        expectedPeer: { deviceId: clientBId.deviceId, rootCaPem: clientBId.caPem, leafFp256: clientBId.leafFp256 },
      }),
      clientElecB.call('connectTls', {
        port: hostPort,
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
      }),
    ]);

    const hRevEvtPromise = hostElec.waitEvent('session_closed', 5_000, (d) => d.sessionSeq === elecH2.sessionSeq);
    const cRevEvtPromise = clientElecB.waitEvent('session_closed', 5_000, (d) => d.sessionSeq === elecC2.sessionSeq);
    const extStore = new PeerTrustStore({ dataDir: hostDataDir });
    extStore.revokePeer(clientBId.deviceId, { by: 'e2e_parent', reason: 'electron_revoke' });
    extStore.close();

    const [hRevEvt] = await Promise.all([hRevEvtPromise, cRevEvtPromise]);
    assert.equal(hRevEvt.code, 'peer_revoked');

    await assert.rejects(
      Promise.all([
        hostElec.call('acceptTls', {
          expectedPeer: { deviceId: clientBId.deviceId, rootCaPem: clientBId.caPem, leafFp256: clientBId.leafFp256 },
        }),
        clientElecB.call('connectTls', {
          port: hostPort,
          expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
        }),
      ]),
    );

    // 3. Повторное сопряжение (allowReplace: true) -> SIGKILL -> перезапуск нового Electron-процесса с DPAPI.
    await Promise.all([
      hostElec.call('acceptPair', {
        roomId: 'e2e-elec-room-2',
        expectedPeer: { deviceId: clientBId.deviceId, deviceName: 'Electron Client' },
        allowReplace: true,
      }, 25_000),
      clientElecB.call('connectAndPair', {
        port: hostPort,
        roomId: 'e2e-elec-room-2',
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, deviceName: 'Electron Host' },
        allowReplace: true,
      }, 25_000),
    ]);

    const [killElecH] = await Promise.all([
      hostElec.call('acceptTls', {
        expectedPeer: { deviceId: clientBId.deviceId, rootCaPem: clientBId.caPem, leafFp256: clientBId.leafFp256 },
      }),
      clientElecB.call('connectTls', {
        port: hostPort,
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
      }),
    ]);

    const hKillPromise = hostElec.waitEvent('session_closed', 8_000, (d) => d.sessionSeq === killElecH.sessionSeq);
    await clientElecB.forceKill();
    clientElecB = null;
    const hKillEvt = await hKillPromise;
    assert.ok(hKillEvt.code === 'connection_closed' || hKillEvt.code === 'tls_socket_error');

    clientElec2 = await spawnWorker({
      label: 'elec-client-2',
      executable: electronExe,
      args: [workerPath, `--user-data-dir=${clientUserDir}`, `--nox-user-data=${clientUserDir}`],
      env: childEnv,
    });
    await clientElec2.waitEvent('ready', 30_000);
    const client2Id = await clientElec2.call('init', {
      dataDir: clientDataDir,
      deviceName: 'Electron Client',
      useSafeStorage: true,
    }, 30_000);
    assert.equal(client2Id.deviceId, clientId.deviceId);
    assert.equal(client2Id.storageMode, 'safeStorage');

    await Promise.all([
      hostElec.call('acceptTls', {
        expectedPeer: { deviceId: client2Id.deviceId, rootCaPem: client2Id.caPem, leafFp256: client2Id.leafFp256 },
      }),
      clientElec2.call('connectTls', {
        port: hostPort,
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
      }),
    ]);

    // 4. Подтверждённая ротация leaf между двумя Electron-процессами по BoringSSL TCP.
    const rot = await clientElec2.call('rotateLeaf', { reason: 'elec_proactive' });
    const [updH, updC] = await Promise.all([
      hostElec.call('acceptLeafUpdate', { confirm: true }),
      clientElec2.call('sendLeafUpdate'),
    ]);
    assert.equal(updC.ok, true);
    assert.equal(updH.leafFp256, rot.leafFp256);

    await Promise.all([hostElec.call('closeSession'), clientElec2.call('closeSession')]);
    const [afterRotH, afterRotC] = await Promise.all([
      hostElec.call('acceptTls', {
        expectedPeer: { deviceId: client2Id.deviceId, rootCaPem: client2Id.caPem, leafFp256: rot.leafFp256 },
      }),
      clientElec2.call('connectTls', {
        port: hostPort,
        expectedPeer: { deviceId: hostId.deviceId, rootCaPem: hostId.caPem, leafFp256: hostId.leafFp256 },
      }),
    ]);
    assert.equal(afterRotH.peerLeafFp256, rot.leafFp256);
    assert.equal(afterRotC.protocol, 'TLSv1.3');
  } finally {
    if (proxy) await proxy.close().catch(() => {});
    if (clientElec2) await clientElec2.shutdown().catch(() => {});
    if (clientElecB) await clientElecB.shutdown().catch(() => {});
    if (clientElec) await clientElec.shutdown().catch(() => {});
    if (hostElec) await hostElec.shutdown().catch(() => {});
    // Небольшая пауза на освобождение дескрипторов Windows после выхода Electron.
    await sleep(150);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
