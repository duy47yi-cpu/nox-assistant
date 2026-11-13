'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { PrivacyController, ConsentRequiredError } = require('../privacy/privacy-controller');
const { IsolatedSessionStore } = require('../storage/session-store');
const { SyntheticAudioStreamAdapter } = require('../audio/audio-stream-adapter');
const { SyntheticASRProvider } = require('../asr/asr-provider');
const { SessionManager } = require('../core/session-manager');
const { buildScenarioConfig } = require('../core/synthetic-scenarios');

const UI_DIR = path.resolve(__dirname, '..', '..', 'ui');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Превышен размер тела запроса'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Некорректный JSON в запросе'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Изолированный локальный контроллер и HTTP+SSE сервер прототипа C7.
 * Не обращается к сети, микрофону или истории основного Nox Assistant.
 */
class SpikeEngineHost {
  constructor(options = {}) {
    this.storageDir =
      options.storageDir || path.resolve(__dirname, '..', '..', '.spike-sessions');
    this.store = new IsolatedSessionStore({ baseDir: this.storageDir });
    this.sseClients = new Set();
    this.session = null;
    this.scenarioId = 'standup';
    this._activeProvider = null;
    this._createFreshSession();
  }

  _createFreshSession() {
    this.store.setWriteFailure(false);
    const privacy = new PrivacyController();
    const sessionId = `c7-${crypto.randomBytes(3).toString('hex')}`;
    const manager = new SessionManager({
      sessionId,
      privacy,
      store: this.store,
      autoFinishOnStreamEnd: true,
      stopGraceMs: 450,
      recoveryOptions: {
        maxRestarts: 2,
        backoffBaseMs: 30,
        stallTimeoutMs: 2500,
        watchdogIntervalMs: 100,
      },
    });

    const forward = (eventName) => (data) => {
      this._broadcast(eventName, data);
    };

    for (const ev of [
      'state_change',
      'partial_transcript',
      'final_transcript',
      'timeline_updated',
      'summary_ready',
      'error',
      'storage_error',
      'recovery',
      'backpressure',
      'pressure_change',
      'session_deleted',
      'audio_chunk',
      'stream_ended',
    ]) {
      manager.on(ev, forward(ev));
    }

    this.session = manager;
    return manager;
  }

  _broadcast(event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(line);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  getFullState() {
    return {
      ...this.session.getSnapshot(),
      scenarioId: this.scenarioId,
      savedSessions: this.store.listSessions(),
    };
  }

  async startSession({ scenario = 'standup', captureConsent, storageConsent = false } = {}) {
    if (
      this.session.state === 'completed' ||
      this.session.state === 'cancelled' ||
      this.session.state === 'error'
    ) {
      this._createFreshSession();
    }
    if (this.session.state !== 'idle') {
      throw Object.assign(new Error(`Сессия уже активна (${this.session.state})`), {
        statusCode: 409,
        code: 'SESSION_ALREADY_ACTIVE',
      });
    }

    if (captureConsent !== true) {
      throw new ConsentRequiredError(
        'Запуск отклонён: требуется явное согласие пользователя на обработку тестового потока'
      );
    }

    this.scenarioId = scenario;
    const cfg = buildScenarioConfig(scenario);
    this.store.setWriteFailure(Boolean(cfg.failOnWrite));
    this.session.privacy.grantConsent({
      captureConsent: true,
      storageConsent: Boolean(storageConsent),
      actor: 'spike-ui-user',
    });

    const adapter = new SyntheticAudioStreamAdapter({
      utterances: cfg.utterances,
      ...cfg.adapterOptions,
    });

    const providerFactory = (attempt) => {
      const opts = { ...cfg.providerOptions };
      // После первой неудачной попытки при восстановлении отключаем инъекцию падения,
      // чтобы продемонстрировать успешное восстановление потока.
      if (attempt > 0) {
        opts.failAtPushCount = null;
      }
      const provider = new SyntheticASRProvider(opts);
      this._activeProvider = provider;
      return provider;
    };

    await this.session.start({ adapter, providerFactory });
    this._broadcast('snapshot', this.getFullState());
    return this.getFullState();
  }

  async pauseSession() {
    await this.session.pause();
    this._broadcast('snapshot', this.getFullState());
    return this.getFullState();
  }

  async resumeSession() {
    await this.session.resume();
    this._broadcast('snapshot', this.getFullState());
    return this.getFullState();
  }

  async finishSession() {
    await this.session.finish();
    this._broadcast('snapshot', this.getFullState());
    return this.getFullState();
  }

  async cancelSession() {
    await this.session.cancel('ui_user_cancelled');
    this._broadcast('snapshot', this.getFullState());
    return this.getFullState();
  }

  async triggerFault(kind = 'provider_drop') {
    if (kind === 'storage_fail') {
      this.store.setWriteFailure(true);
      this._broadcast('snapshot', this.getFullState());
      return { injected: 'storage_fail' };
    }
    if (kind === 'provider_drop' && this._activeProvider) {
      const err = new Error('Имитация обрыва соединения с провайдером ASR');
      err.code = 'ASR_SIMULATED_DISCONNECT';
      this._activeProvider.emit('error', err);
      return { injected: 'provider_drop' };
    }
    return { injected: null };
  }

  async revokeConsent() {
    await this.session.privacy.revokeConsent('ui_revoked');
    this._broadcast('snapshot', this.getFullState());
    return this.getFullState();
  }

  async deleteCurrentSession() {
    await this.session.deleteSession();
    this.store.purgeAll();
    this._createFreshSession();
    const state = this.getFullState();
    this._broadcast('snapshot', state);
    return state;
  }

  renameSpeaker({ speakerKey, label }) {
    this.session.timeline.setUserAssignedLabel(speakerKey, label, { userConfirmed: true });
    const state = this.getFullState();
    this._broadcast('snapshot', state);
    return state;
  }

  async shutdown() {
    if (this.session && (this.session.state === 'recording' || this.session.state === 'paused')) {
      await this.session.cancel('server_shutdown', { purgeMemory: true });
    }
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
  }
}

function createSpikeServer(options = {}) {
  const hostEngine = new SpikeEngineHost(options);

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    try {
      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, hostEngine.getFullState());
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: snapshot\ndata: ${JSON.stringify(hostEngine.getFullState())}\n\n`);
        hostEngine.sseClients.add(res);
        req.on('close', () => {
          hostEngine.sseClients.delete(res);
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/session/start') {
        const body = await readJsonBody(req);
        const state = await hostEngine.startSession(body);
        return sendJson(res, 200, state);
      }

      if (req.method === 'POST' && pathname === '/api/session/pause') {
        return sendJson(res, 200, await hostEngine.pauseSession());
      }

      if (req.method === 'POST' && pathname === '/api/session/resume') {
        return sendJson(res, 200, await hostEngine.resumeSession());
      }

      if (req.method === 'POST' && pathname === '/api/session/finish') {
        return sendJson(res, 200, await hostEngine.finishSession());
      }

      if (req.method === 'POST' && pathname === '/api/session/cancel') {
        return sendJson(res, 200, await hostEngine.cancelSession());
      }

      if (req.method === 'POST' && pathname === '/api/session/fault') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await hostEngine.triggerFault(body.kind));
      }

      if (req.method === 'POST' && pathname === '/api/session/revoke-consent') {
        return sendJson(res, 200, await hostEngine.revokeConsent());
      }

      if (req.method === 'POST' && pathname === '/api/session/rename-speaker') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, hostEngine.renameSpeaker(body));
      }

      if (
        (req.method === 'DELETE' && pathname === '/api/session') ||
        (req.method === 'POST' && pathname === '/api/session/delete')
      ) {
        return sendJson(res, 200, await hostEngine.deleteCurrentSession());
      }

      // Статические файлы изолированного интерфейса
      if (req.method === 'GET') {
        const cleanRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const resolved = path.resolve(UI_DIR, cleanRel);
        if (!resolved.startsWith(UI_DIR)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          const ext = path.extname(resolved);
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(resolved).pipe(res);
          return;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const statusCode =
        err instanceof ConsentRequiredError ? 403 : Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      sendJson(res, statusCode, {
        error: err?.message || 'Ошибка сервера прототипа',
        code: err?.code || 'SPIKE_ERROR',
      });
    }
  });

  return {
    server,
    hostEngine,
    async listen(port = Number(process.env.PORT || 4787), host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      return { port: addr.port, host: addr.address, url: `http://${addr.address}:${addr.port}` };
    },
    async close() {
      await hostEngine.shutdown();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (require.main === module) {
  const spike = createSpikeServer();
  spike
    .listen()
    .then(({ url }) => {
      console.log(`[Nox C7 Prototype UI] Локальный сервер запущен: ${url}`);
      console.log('Режим: ТОЛЬКО синтетический поток, без микрофона и внешних API.');
    })
    .catch((err) => {
      console.error('Не удалось запустить сервер C7:', err);
      process.exit(1);
    });
}

module.exports = {
  createSpikeServer,
  SpikeEngineHost,
};
