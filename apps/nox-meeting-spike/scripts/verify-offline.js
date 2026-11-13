'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');

const { ModelStore, ModelNotInstalledError } = require('../src/models/model-store');
const { RealASRProvider } = require('../src/asr/real-asr-provider');
const { SessionManager } = require('../src/core/session-manager');
const { PrivacyController } = require('../src/privacy/privacy-controller');
const { SyntheticAudioStreamAdapter } = require('../src/audio/audio-stream-adapter');
const { IsolatedSessionStore } = require('../src/storage/session-store');
const { runBenchmark, createMockBenchmarkHarness } = require('./benchmark-real-asr');

/**
 * Installs a strict runtime tripwire blocking all outbound TCP/TLS/HTTP/DNS/fetch calls.
 * Returns { attemptedCalls, uninstall } so callers can verify zero network attempts.
 */
function installNetworkTripwire() {
  const attemptedCalls = [];

  function deny(apiName, args) {
    const target = typeof args[0] === 'string'
      ? args[0]
      : (args[0] && (args[0].hostname || args[0].host || args[0].href)) || 'unknown';
    attemptedCalls.push({ api: apiName, target });
    const err = new Error(`Offline verification blocked network call: ${apiName}(${target})`);
    err.code = 'ERR_OFFLINE_NETWORK_FORBIDDEN';
    throw err;
  }

  const originals = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    socketConnect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
    dnsLookup: dns.lookup,
    dnsResolve: dns.resolve,
    fetch: globalThis.fetch,
  };

  http.request = (...args) => deny('http.request', args);
  http.get = (...args) => deny('http.get', args);
  https.request = (...args) => deny('https.request', args);
  https.get = (...args) => deny('https.get', args);
  net.connect = (...args) => deny('net.connect', args);
  net.createConnection = (...args) => deny('net.createConnection', args);
  net.Socket.prototype.connect = function blockedConnect(...args) {
    return deny('net.Socket.connect', args);
  };
  tls.connect = (...args) => deny('tls.connect', args);
  dns.lookup = (...args) => deny('dns.lookup', args);
  dns.resolve = (...args) => deny('dns.resolve', args);
  if (typeof globalThis.fetch === 'function') {
    globalThis.fetch = async (...args) => deny('globalThis.fetch', args);
  }

  return {
    attemptedCalls,
    uninstall() {
      http.request = originals.httpRequest;
      http.get = originals.httpGet;
      https.request = originals.httpsRequest;
      https.get = originals.httpsGet;
      net.connect = originals.netConnect;
      net.createConnection = originals.netCreateConnection;
      net.Socket.prototype.connect = originals.socketConnect;
      tls.connect = originals.tlsConnect;
      dns.lookup = originals.dnsLookup;
      dns.resolve = originals.dnsResolve;
      if (typeof originals.fetch === 'function') {
        globalThis.fetch = originals.fetch;
      }
    },
  };
}

/**
 * Exercises ModelStore, RealASRProvider, SessionManager, and benchmark harness
 * with all Node network APIs blocked, asserting zero network calls and clean offline failures.
 */
async function runOfflineVerification() {
  const tripwire = installNetworkTripwire();
  const sessionStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-c7-offline-sessions-'));
  const harness = createMockBenchmarkHarness('ru-zipformer-vosk-int8');

  try {
    const emptyModelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-c7-empty-models-'));
    const storeMissing = new ModelStore({ modelsDir: emptyModelsDir });
    let missingRejectedOffline = false;
    try {
      await storeMissing.resolveRecognizerFiles('ru-zipformer-vosk-int8');
    } catch (err) {
      missingRejectedOffline = err instanceof ModelNotInstalledError;
    } finally {
      fs.rmSync(emptyModelsDir, { recursive: true, force: true });
    }
    if (!missingRejectedOffline) {
      throw new Error('Expected ModelStore.resolveRecognizerFiles to fail closed offline when weights missing');
    }

    const store = new ModelStore({
      modelsDir: harness.modelsDir,
      requireManifestChecksums: false,
      requireAttributionNotice: true,
    });
    const resolved = await store.resolveRecognizerFiles('ru-zipformer-vosk-int8', {
      modelDir: harness.modelDir,
    });
    if (!resolved.offlineReady) {
      throw new Error('Expected offlineReady=true for locally verified model directory');
    }

    // Verify full SessionManager + RealASRProvider lifecycle without network access
    const provider = new RealASRProvider({
      mode: 'inline',
      modelId: 'ru-zipformer-vosk-int8',
      modelDir: harness.modelDir,
      modelStore: store,
      binding: harness.binding,
    });

    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: true, actor: 'offline-check' });
    const adapter = new SyntheticAudioStreamAdapter({
      utterances: [
        {
          channel: 'microphone',
          speakerHint: 'local:mic',
          text: 'тестовый поток',
          startMs: 0,
          endMs: 400,
        },
      ],
      sampleRate: 16000,
      chunkDurationMs: 100,
      paceMs: 0,
    });
    const sessionStore = new IsolatedSessionStore({ baseDir: sessionStorageDir });

    const manager = new SessionManager({
      privacy,
      store: sessionStore,
      adapter,
      provider,
      recoveryOptions: {
        stallTimeoutMs: 15000,
        maxRetries: 1,
      },
    });

    await manager.start();
    await new Promise((resolve) => {
      if (manager._streamEnded) return resolve();
      manager.once('stream_ended', resolve);
    });
    const sessionSummary = await manager.finish();
    if (!sessionSummary || sessionSummary.state !== 'completed') {
      throw new Error(`Expected completed offline session, got ${sessionSummary && sessionSummary.state}`);
    }

    // Verify benchmark dry-run works offline
    const benchReport = await runBenchmark({ mock: true });
    if (!benchReport.ok) {
      throw new Error('Offline mock benchmark did not report ok=true');
    }

    if (tripwire.attemptedCalls.length > 0) {
      throw new Error(
        `Detected unexpected network attempts during offline run: ${JSON.stringify(tripwire.attemptedCalls)}`
      );
    }

    return {
      ok: true,
      attemptedNetworkCalls: tripwire.attemptedCalls.length,
      checks: {
        missingModelRejectedOffline: missingRejectedOffline,
        localModelResolvedOffline: resolved.offlineReady,
        sessionCompletedOffline: sessionSummary.state === 'completed',
        finalSegmentsProduced: sessionSummary.transcript.finals.length,
        mockBenchmarkOk: benchReport.ok,
      },
    };
  } finally {
    tripwire.uninstall();
    harness.cleanup();
    fs.rmSync(sessionStorageDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runOfflineVerification()
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`verify-offline error: ${err.stack || err.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  installNetworkTripwire,
  runOfflineVerification,
};
