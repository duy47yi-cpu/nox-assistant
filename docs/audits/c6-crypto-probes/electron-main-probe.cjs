const { app, safeStorage } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const util = require('node:util');
const link = require('D:/nox-release/apps/jarvis-desktop/src/link');
const [step, userData, dataDir] = process.argv.slice(2);
app.setPath('userData', userData);
const out = {};
const code = async (fn) => { try { const r = await fn(); return r && r.storageMode ? `ok:${r.storageMode}` : 'ok'; } catch (e) { return `err:${e.code || e.message}`; } };
(async () => {
  if (step === 'preready') {
    out.availBeforeReady = safeStorage.isEncryptionAvailable();
    out.noFlagBeforeReady = await code(() => link.loadOrCreateIdentity({ dataDir: path.join(dataDir, 'e1'), deviceName: 'E1', env: {} }));
    out.flagBeforeReady = await code(() => link.loadOrCreateIdentity({ dataDir: path.join(dataDir, 'e2'), deviceName: 'E2', env: { NOX_DATA_DIR: 'x', NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' } }));
    await app.whenReady();
    out.availAfterReady = safeStorage.isEncryptionAvailable();
    out.flagAfterReady = await code(() => link.loadOrCreateIdentity({ dataDir: path.join(dataDir, 'e3'), deviceName: 'E3', env: { NOX_DATA_DIR: 'x', NOX_LINK_TEST_UNENCRYPTED_KEYS: '1' } }));
    out.reloadPlainAfterReady = await code(() => link.loadOrCreateIdentity({ dataDir: path.join(dataDir, 'e2'), deviceName: 'E2', env: {} }));
    const f = path.join(dataDir, 'e3', 'link', 'identity.json');
    const good = fs.readFileSync(f, 'utf8');
    out.e3PlainKeyOnDisk = good.includes('PRIVATE KEY');
    fs.writeFileSync(f, good.slice(0, good.length / 2));
    out.truncated = await code(() => link.loadOrCreateIdentity({ dataDir: path.join(dataDir, 'e3'), deviceName: 'E3', env: {} }));
    out.truncatedFileKept = fs.readFileSync(f, 'utf8').length === Math.floor(good.length / 2);
    const rec = JSON.parse(good); const b = Buffer.from(rec.leafKeyEnc, 'base64'); b[b.length - 3] ^= 0x01; rec.leafKeyEnc = b.toString('base64');
    fs.writeFileSync(f, JSON.stringify(rec));
    out.flippedCiphertext = await code(() => link.loadOrCreateIdentity({ dataDir: path.join(dataDir, 'e3'), deviceName: 'E3', env: {} }));
    const e1 = path.join(dataDir, 'e1', 'link', 'identity.json');
    if (fs.existsSync(e1)) {
      const rec2 = JSON.parse(good); rec2.leafKeyEnc = JSON.parse(fs.readFileSync(e1, 'utf8')).leafKeyEnc;
      fs.writeFileSync(f, JSON.stringify(rec2));
      out.swappedKeyFromOtherIdentity = await code(() => link.loadOrCreateIdentity({ dataDir: path.join(dataDir, 'e3'), deviceName: 'E3', env: {} }));
    }
    fs.writeFileSync(f, good);
    const id = await link.loadOrCreateIdentity({ dataDir: path.join(dataDir, 'e3'), deviceName: 'E3', env: {} });
    out.inspectOrJsonLeaks = util.inspect(id).includes('PRIVATE KEY') || JSON.stringify(id).includes('PRIVATE KEY');
    out.getTlsCredentialsReturnsPlainKey = id.getTlsCredentials().leafKeyPem.includes('PRIVATE KEY');
  } else {
    await app.whenReady();
    out[step] = await code(() => link.loadOrCreateIdentity({ dataDir, deviceName: 'P', env: {} }));
  }
  out.electron = process.versions.electron;
  process.stdout.write(JSON.stringify(out) + '\n');
  app.exit(0);
})().catch((e) => { process.stdout.write(JSON.stringify({ fatal: String(e && e.stack) }) + '\n'); app.exit(1); });
