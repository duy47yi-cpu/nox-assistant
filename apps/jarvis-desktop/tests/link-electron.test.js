'use strict';

// Живая проверка в настоящем процессе Electron 44.9.3 (BoringSSL + реальный electron.safeStorage)
// в изолированных временных профилях без использования настоящей папки data/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('Electron 44.9.3 (BoringSSL + реальный safeStorage): PKI, сопряжение SAS, mTLS 1.3, пиннинг и отзыв', async () => {
  const electronPkg = require('electron');
  const electronExe = typeof electronPkg === 'string' ? electronPkg : process.execPath;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-link-electron-'));
  const userDataDir = path.join(tempRoot, 'electron-user-data');
  const profADir = path.join(tempRoot, 'profile-a');
  const profBDir = path.join(tempRoot, 'profile-b');
  const profCDir = path.join(tempRoot, 'profile-c');
  fs.mkdirSync(userDataDir, { recursive: true });

  const scriptPath = path.join(tempRoot, 'electron-verify.cjs');
  const linkEntry = path.resolve(__dirname, '../src/link');

  const childCode = `
    const { app, safeStorage } = require('electron');
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const { PassThrough, Duplex } = require('node:stream');
    const link = require(${JSON.stringify(linkEntry)});

    app.setPath('userData', ${JSON.stringify(userDataDir)});

    function makeDuplexPair() {
      const aToB = new PassThrough();
      const bToA = new PassThrough();
      const sideA = new Duplex({
        allowHalfOpen: false,
        read() {},
        write(chunk, enc, cb) { aToB.write(chunk, enc, cb); },
        final(cb) { aToB.end(); cb(); },
        destroy(err, cb) { aToB.destroy(); bToA.destroy(); cb(err); },
      });
      const sideB = new Duplex({
        allowHalfOpen: false,
        read() {},
        write(chunk, enc, cb) { bToA.write(chunk, enc, cb); },
        final(cb) { bToA.end(); cb(); },
        destroy(err, cb) { bToA.destroy(); aToB.destroy(); cb(err); },
      });
      bToA.on('data', (c) => sideA.push(c));
      bToA.on('end', () => sideA.push(null));
      bToA.on('close', () => { if (!sideA.destroyed) sideA.destroy(); });
      aToB.on('data', (c) => sideB.push(c));
      aToB.on('end', () => sideB.push(null));
      aToB.on('close', () => { if (!sideB.destroyed) sideB.destroy(); });
      return [sideA, sideB];
    }

    (async () => {
      try {
        await app.whenReady();
        assert.equal(safeStorage.isEncryptionAvailable(), true, 'safeStorage должен быть доступен в Electron');

        // 1. Fail-closed при отключённом safeStorage (имитация недоступности ОС-хранилища).
        let failClosedOk = false;
        try {
          await link.loadOrCreateIdentity({
            dataDir: path.join(${JSON.stringify(tempRoot)}, 'fail-closed'),
            deviceName: 'Blocked',
            protect: {
              isEncryptionAvailable: () => false,
              encryptString: () => Buffer.alloc(0),
              decryptString: () => '',
            },
            env: {},
          });
        } catch (err) {
          failClosedOk = err.code === 'safe_storage_unavailable';
        }
        assert.equal(failClosedOk, true);

        // 1b. P2-2: Тестовый режим по умолчанию запрещён и блокируется при isPackaged=true.
        await assert.rejects(
          () => link.loadOrCreateIdentity({
            dataDir: path.join(${JSON.stringify(tempRoot)}, 'blocked-default-test'),
            deviceName: 'Blocked-Default',
            protect: null,
            env: {
              NOX_DATA_DIR: path.join(${JSON.stringify(tempRoot)}, 'blocked-default-test'),
              NOX_LINK_TEST_UNENCRYPTED_KEYS: '1',
            },
          }),
          (err) => err && err.code === 'safe_storage_unavailable',
        );
        await assert.rejects(
          () => link.loadOrCreateIdentity({
            dataDir: path.join(${JSON.stringify(tempRoot)}, 'blocked-packaged'),
            deviceName: 'Blocked-Pkg',
            protect: null,
            allowTestUnencrypted: true,
            app: { isPackaged: true },
            env: {
              NOX_DATA_DIR: path.join(${JSON.stringify(tempRoot)}, 'blocked-packaged'),
              NOX_LINK_TEST_UNENCRYPTED_KEYS: '1',
            },
          }),
          (err) => err && err.code === 'safe_storage_unavailable',
        );

        // 2. Два независимых профиля с реальным Electron safeStorage.
        const idA = await link.loadOrCreateIdentity({ dataDir: ${JSON.stringify(profADir)}, deviceName: 'Electron-A', protect: safeStorage, env: {} });
        const idB = await link.loadOrCreateIdentity({ dataDir: ${JSON.stringify(profBDir)}, deviceName: 'Electron-B', protect: safeStorage, env: {} });
        const idC = await link.loadOrCreateIdentity({ dataDir: ${JSON.stringify(profCDir)}, deviceName: 'Electron-C', protect: safeStorage, env: {} });

        const rawIdA = fs.readFileSync(path.join(${JSON.stringify(profADir)}, 'link', 'identity.json'), 'utf8');
        assert.equal(rawIdA.includes('BEGIN PRIVATE KEY'), false);
        assert.equal(JSON.parse(rawIdA).storageMode, 'safeStorage');

        // Перезагрузка через реальный DPAPI safeStorage.
        const idAReloaded = await link.loadOrCreateIdentity({ dataDir: ${JSON.stringify(profADir)}, deviceName: 'Electron-A', protect: safeStorage, env: {} });
        assert.equal(idAReloaded.deviceId, idA.deviceId);
        assert.equal(idAReloaded.leafFp256, idA.leafFp256);

        const peersA = new link.PeerTrustStore({ dataDir: ${JSON.stringify(profADir)} });
        const peersB = new link.PeerTrustStore({ dataDir: ${JSON.stringify(profBDir)} });

        // 3. Сопряжение Commit-then-Reveal + mTLS 1.3 + PoP + SAS.
        const [p1, p2] = makeDuplexPair();
        const roomId = crypto.randomBytes(16).toString('hex');
        const [resA, resB] = await Promise.all([
          link.runPairingSession({
            transport: p1,
            role: 'host',
            roomId,
            identity: idA,
            expectedPeer: { deviceId: idB.deviceId, deviceName: 'Electron-B' },
            peerStore: peersA,
            onConfirmSas: async () => ({ confirmed: true }),
          }),
          link.runPairingSession({
            transport: p2,
            role: 'client',
            roomId,
            identity: idB,
            expectedPeer: { deviceId: idA.deviceId, deviceName: 'Electron-A' },
            peerStore: peersB,
            onConfirmSas: async () => ({ confirmed: true }),
          }),
        ]);
        assert.equal(resA.sasCode, resB.sasCode);

        // 4. Рабочее соединение BoringSSL mTLS 1.3 (CA:FALSE Leaf + NameConstraints CA + pinning).
        const [t1, t2] = makeDuplexPair();
        const [sessA, sessB] = await Promise.all([
          link.establishMutualTls({
            stream: t1,
            role: 'server',
            identity: idA,
            expectedPeer: peersA.requireTrustedPeer(idB.deviceId),
            peerStore: peersA,
            heartbeatIntervalMs: 0,
          }),
          link.establishMutualTls({
            stream: t2,
            role: 'client',
            identity: idB,
            expectedPeer: peersB.requireTrustedPeer(idA.deviceId),
            peerStore: peersB,
            heartbeatIntervalMs: 0,
          }),
        ]);
        assert.equal(sessA.protocol, 'TLSv1.3');
        assert.equal(sessB.protocol, 'TLSv1.3');
        assert.equal(sessA.authorized, true);
        assert.equal(sessB.authorized, true);

        const rx = sessA.waitNextFrame({ timeoutMs: 2000 });
        await sessB.sendFrame({ v: 3, type: 'electron_msg', ok: true });
        assert.equal((await rx).ok, true);

        // 5. Чужой сертификат (C вместо B) в BoringSSL отвергается.
        const [f1, f2] = makeDuplexPair();
        const foreignAttempt = await Promise.allSettled([
          link.establishMutualTls({
            stream: f1,
            role: 'server',
            identity: idA,
            expectedPeer: peersA.requireTrustedPeer(idB.deviceId),
            peerStore: peersA,
            handshakeTimeoutMs: 1200,
            heartbeatIntervalMs: 0,
          }),
          link.establishMutualTls({
            stream: f2,
            role: 'client',
            identity: idC,
            expectedPeer: { deviceId: idA.deviceId, rootCaPem: idA.caPem, leafFp256: idA.leafFp256 },
            handshakeTimeoutMs: 1200,
            heartbeatIntervalMs: 0,
          }),
        ]);
        assert.ok(foreignAttempt.every((r) => r.status === 'rejected'));

        // 5b. A2: обязательный leafFp256 пин в BoringSSL.
        const [m1, m2] = makeDuplexPair();
        await assert.rejects(
          () => link.establishMutualTls({
            stream: m1,
            role: 'server',
            identity: idA,
            expectedPeer: { deviceId: idB.deviceId, rootCaPem: idB.caPem },
            heartbeatIntervalMs: 0,
          }),
          (err) => err && err.code === 'missing_peer_leaf_pin',
        );
        m1.destroy();
        m2.destroy();

        // 6. A3: отзыв через второй экземпляр PeerTrustStore рвёт живой BoringSSL-сеанс и блокирует переподключение.
        const secondPeersA = new link.PeerTrustStore({ dataDir: ${JSON.stringify(profADir)} });
        const waitRevokeA = sessA.waitNextFrame({ timeoutMs: 3000 });
        const waitRevokeB = sessB.waitNextFrame({ timeoutMs: 3000 });
        secondPeersA.revokePeer(idB.deviceId, { by: 'owner_electron_second_instance' });
        await assert.rejects(waitRevokeA, (err) => err && err.code === 'peer_revoked');
        await assert.rejects(waitRevokeB);
        assert.throws(
          () => peersA.requireTrustedPeer(idB.deviceId),
          (err) => err && err.code === 'peer_revoked',
        );
        await sessA.close();
        await sessB.close();
        secondPeersA.close();

        // 7. A4b: склейка pair_reveal + ClientHello в одном куске на живом Electron BoringSSL (повтор с allowReplace).
        function makeCoalescedPair() {
          const aToB = new PassThrough();
          const bToA = new PassThrough();
          let held = [];
          let released = false;
          let seenCommit = false;
          const sA = new Duplex({
            allowHalfOpen: false,
            read() {},
            write(c, enc, cb) { aToB.write(c, enc, cb); },
            final(cb) { aToB.end(); cb(); },
            destroy(err, cb) { aToB.destroy(); bToA.destroy(); cb(err); },
          });
          const sB = new Duplex({
            allowHalfOpen: false,
            read() {},
            write(chunk, enc, cb) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
              if (!released) {
                held.push(buf);
                const all = Buffer.concat(held);
                if (!seenCommit && all.toString('utf8').includes('"pair_commit"')) {
                  const nl = all.indexOf(0x0a);
                  if (nl !== -1) {
                    seenCommit = true;
                    const commitPart = all.subarray(0, nl + 1);
                    const rest = all.subarray(nl + 1);
                    held = rest.length > 0 ? [rest] : [];
                    bToA.write(commitPart);
                  }
                }
                const cur = Buffer.concat(held);
                const nl2 = cur.indexOf(0x0a);
                if (seenCommit && nl2 !== -1 && cur.length > nl2 + 1 && cur[nl2 + 1] === 0x16) {
                  released = true;
                  held = [];
                  bToA.write(cur);
                }
                cb();
                return;
              }
              bToA.write(buf, cb);
            },
            final(cb) { bToA.end(); cb(); },
            destroy(err, cb) { bToA.destroy(); aToB.destroy(); cb(err); },
          });
          bToA.on('data', (c) => sA.push(c));
          bToA.on('end', () => sA.push(null));
          bToA.on('close', () => { if (!sA.destroyed) sA.destroy(); });
          aToB.on('data', (c) => sB.push(c));
          aToB.on('end', () => sB.push(null));
          aToB.on('close', () => { if (!sB.destroyed) sB.destroy(); });
          return [sA, sB];
        }
        const [c1, c2] = makeCoalescedPair();
        const roomCoalesced = crypto.randomBytes(16).toString('hex');
        const [cResA, cResB] = await Promise.all([
          link.runPairingSession({
            transport: c1,
            role: 'host',
            roomId: roomCoalesced,
            identity: idA,
            expectedPeer: { deviceId: idB.deviceId, deviceName: 'Electron-B' },
            peerStore: peersA,
            allowReplace: true,
            onConfirmSas: async () => ({ confirmed: true }),
          }),
          link.runPairingSession({
            transport: c2,
            role: 'client',
            roomId: roomCoalesced,
            identity: idB,
            expectedPeer: { deviceId: idA.deviceId, deviceName: 'Electron-A' },
            peerStore: peersB,
            allowReplace: true,
            onConfirmSas: async () => ({ confirmed: true }),
          }),
        ]);
        assert.equal(cResA.sasCode, cResB.sasCode);

        // 8. A5: предупредительная ротация и восстановление истёкшего leaf + подтверждённый update на пире B в DPAPI.
        const t80 = Date.now() + 80 * link.DAY_MS;
        idAReloaded.dispose();
        const idA80 = await link.loadOrCreateIdentity({ dataDir: ${JSON.stringify(profADir)}, deviceName: 'Electron-A', protect: safeStorage, nowMs: t80 });
        assert.equal(idA80.lastRotationReason, 'proactive_before_expiry');
        assert.ok(idA80.pendingLeafUpdate);
        await peersB.confirmAndUpdatePeerLeaf(idA80.deviceId, {
          envelope: idA80.pendingLeafUpdate,
          nowMs: t80,
          onConfirmCertUpdate: async () => ({ confirmed: true }),
        });

        const t175 = t80 + 95 * link.DAY_MS;
        idA80.dispose();
        const idA175 = await link.loadOrCreateIdentity({ dataDir: ${JSON.stringify(profADir)}, deviceName: 'Electron-A', protect: safeStorage, nowMs: t175 });
        assert.equal(idA175.lastRotationReason, 'expired_leaf_recovered');

        // Новый BoringSSL mTLS после ротации (в виртуальном времени t175).
        await peersB.confirmAndUpdatePeerLeaf(idA175.deviceId, {
          envelope: idA175.pendingLeafUpdate,
          nowMs: t175,
          onConfirmCertUpdate: async () => ({ confirmed: true }),
        });

        // Повреждённый DPAPI ciphertext в профиле C -> честная диагностика и resetIdentity.
        const idCPath = path.join(${JSON.stringify(profCDir)}, 'link', 'identity.json');
        const idCJson = JSON.parse(fs.readFileSync(idCPath, 'utf8'));
        idCJson.caKeyEnc = Buffer.from('corrupt-dpapi-blob').toString('base64');
        fs.writeFileSync(idCPath, JSON.stringify(idCJson, null, 2), 'utf8');
        const diagC = link.diagnoseIdentityRecovery({ dataDir: ${JSON.stringify(profCDir)}, protect: safeStorage });
        assert.equal(diagC.status, 'decrypt_failed_reset_required');
        assert.equal(diagC.recoverableKey, false);
        assert.equal(diagC.requiresResetAndRepairing, true);
        const oldCId = idC.deviceId;
        idC.dispose();
        const resetC = await link.resetIdentity({ dataDir: ${JSON.stringify(profCDir)}, deviceName: 'Electron-C-Reset', protect: safeStorage, confirmReset: true });
        assert.equal(resetC.requiresRepairing, true);
        assert.notEqual(resetC.identity.deviceId, oldCId);
        resetC.identity.dispose();

        idA.dispose();
        idB.dispose();
        idA175.dispose();
        peersA.close();
        peersB.close();

        process.stdout.write(JSON.stringify({
          ok: true,
          electron: process.versions.electron,
          openssl: process.versions.openssl,
          clientEphemeral: sessB.ephemeral,
        }) + '\\n');
        app.exit(0);
      } catch (err) {
        process.stderr.write(String(err && err.stack ? err.stack : err) + '\\n');
        app.exit(1);
      }
    })();
  `;

  fs.writeFileSync(scriptPath, childCode, 'utf8');

  try {
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    const result = await new Promise((resolve, reject) => {
      const proc = spawn(electronExe, [scriptPath], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let errOut = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new Error(`electron_timeout: stdout=${out} stderr=${errOut}`));
      }, 45_000);
      proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
      proc.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, out, errOut });
      });
    });

    assert.equal(result.code, 0, `Electron завершился с кодом ${result.code}: ${result.errOut}`);
    const lastLine = result.out.trim().split(/\r?\n/).pop();
    const summary = JSON.parse(lastLine);
    assert.equal(summary.ok, true);
    assert.ok(summary.electron);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
