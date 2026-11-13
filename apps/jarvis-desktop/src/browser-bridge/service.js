// Слой интеграции с расширением Chrome через локальный мост nox-bridge-2.
// Живёт строго в main process: секреты спаривания и сырой канал в renderer не попадают.
const crypto = require('node:crypto');
const path = require('node:path');

const DEFAULT_READ_TIMEOUT_MS = 15_000;
const MAX_TITLE_CHARS = 160;
const EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

function validateExtensionOrigin(origin) {
  return typeof origin === 'string' && EXT_ORIGIN_RE.test(origin);
}

function validatePageOrigin(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.origin !== raw) return null;
  return parsed.origin;
}

function sanitizeTitle(raw) {
  const clean = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return clean.length > MAX_TITLE_CHARS ? clean.slice(0, MAX_TITLE_CHARS) : clean;
}

function mapBridgeError(errOrCode) {
  const code = typeof errOrCode === 'string'
    ? errOrCode.trim()
    : String(errOrCode?.message || errOrCode || '').trim();

  switch (code) {
    case 'permission_required':
      return {
        errorCode: 'permission_required',
        status: 'denied',
        message: 'Чтение вкладки не разрешено в расширении Chrome: нажмите «Разрешить и прочитать» в расширении.',
      };
    case 'grant_used':
      return {
        errorCode: 'grant_used',
        status: 'denied',
        message: 'Одноразовое разрешение на чтение вкладки уже использовано.',
      };
    case 'grant_expired':
      return {
        errorCode: 'grant_expired',
        status: 'expired',
        message: 'Срок одноразового разрешения на чтение вкладки истёк.',
      };
    case 'revoked':
      return {
        errorCode: 'revoked',
        status: 'revoked',
        message: 'Доступ к вкладке браузера отозван.',
      };
    case 'origin_changed':
      return {
        errorCode: 'origin_changed',
        status: 'changed',
        message: 'Адрес сайта во вкладке изменился — чтение остановлено.',
      };
    case 'tab_changed':
      return {
        errorCode: 'tab_changed',
        status: 'changed',
        message: 'Активная вкладка переключена — чтение остановлено.',
      };
    case 'tab_closed':
      return {
        errorCode: 'tab_closed',
        status: 'changed',
        message: 'Выбранная вкладка браузера закрыта.',
      };
    case 'tab_selection_forbidden':
      return {
        errorCode: 'tab_selection_forbidden',
        status: 'denied',
        message: 'Модель и Nox не вправе выбирать вкладку вместо владельца.',
      };
    case 'no active session':
      return {
        errorCode: 'no_active_session',
        status: 'disconnected',
        message: 'Нет активного подключения к расширению Chrome.',
      };
    case 'multiple active sessions':
      return {
        errorCode: 'multiple_active_sessions',
        status: 'error',
        message: 'Подключено несколько сессий расширения одновременно.',
      };
    case 'busy':
    case 'read request already active':
      return {
        errorCode: 'read_in_progress',
        status: 'reading',
        message: 'Чтение вкладки уже выполняется.',
      };
    case 'read request timed out':
      return {
        errorCode: 'timeout',
        status: 'error',
        message: 'Расширение браузера не ответило вовремя.',
      };
    case 'bridge closed':
      return {
        errorCode: 'bridge_closed',
        status: 'disconnected',
        message: 'Локальный мост браузера остановлен.',
      };
    case 'read_failed':
      return {
        errorCode: 'read_failed',
        status: 'error',
        message: 'Не удалось прочитать текст разрешённой вкладки.',
      };
    default:
      return {
        errorCode: code || 'bridge_error',
        status: 'error',
        message: 'Ошибка моста браузера.',
      };
  }
}

function loadDefaultBridgeFactory() {
  const bridgePath = path.resolve(__dirname, '../../../nox-browser-bridge/bridge.js');
  const mod = require(bridgePath);
  return mod.createBridge;
}

class BrowserBridgeService {
  constructor({
    enabled = false,
    extensionOrigin = '',
    createBridge = null,
    now = () => Date.now(),
    sessionTtlMs,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
  } = {}) {
    this.enabled = enabled === true;
    this._extensionOrigin = extensionOrigin || '';
    this._createBridge = createBridge;
    this._now = now;
    this._sessionTtlMs = sessionTtlMs;
    this._readTimeoutMs = readTimeoutMs;

    this._bridge = null;
    this._port = null;
    this._connectionId = null;
    this._running = false;
    this._closed = false;
    this._reading = false;
    this._generation = 0;
    this._activeTab = null;
    this._lastError = null;
    this._lifecycleLock = Promise.resolve();
  }

  isEnabled() {
    return this.enabled === true;
  }

  _enqueueLifecycle(fn) {
    const run = this._lifecycleLock.then(fn, fn);
    this._lifecycleLock = run.catch(() => {});
    return run;
  }

  async start({ extensionOrigin } = {}) {
    return this._enqueueLifecycle(async () => {
      if (!this.enabled) {
        const err = new Error('Интеграция с расширением браузера выключена.');
        err.code = 'feature_disabled';
        throw err;
      }
      if (this._running && this._bridge && !this._closed) {
        return { port: this._port, connectionId: this._connectionId };
      }

      const origin = extensionOrigin !== undefined ? extensionOrigin : this._extensionOrigin;
      if (!validateExtensionOrigin(origin)) {
        const err = new Error('Некорректный origin расширения Chrome.');
        err.code = 'invalid_extension_origin';
        this._lastError = { code: err.code, message: err.message, at: this._now() };
        throw err;
      }

      const factory = this._createBridge || loadDefaultBridgeFactory();
      const opts = { origin, now: this._now };
      if (this._sessionTtlMs !== undefined) opts.sessionTtlMs = this._sessionTtlMs;

      const bridge = factory(opts);
      const gen = ++this._generation;
      try {
        const port = await bridge.listen();
        if (this._closed || gen !== this._generation) {
          try { bridge.revokeAll(); } catch { /* ignore */ }
          try { await bridge.close(); } catch { /* ignore */ }
          const err = new Error('Запуск моста отменён закрытием.');
          err.code = 'bridge_closed';
          throw err;
        }
        this._extensionOrigin = origin;
        this._bridge = bridge;
        this._port = port;
        this._connectionId = crypto.randomUUID();
        this._running = true;
        this._reading = false;
        this._lastError = null;
        this._activeTab = {
          origin: null,
          title: null,
          length: 0,
          truncated: false,
          status: 'idle',
          updatedAt: this._now(),
        };
        return { port, connectionId: this._connectionId };
      } catch (err) {
        try { bridge.revokeAll(); } catch { /* ignore */ }
        try { await bridge.close(); } catch { /* ignore */ }
        this._bridge = null;
        this._port = null;
        this._connectionId = null;
        this._running = false;
        if (!err.code) err.code = 'bridge_start_failed';
        this._lastError = { code: err.code, message: String(err.message || err), at: this._now() };
        throw err;
      }
    });
  }

  async stop() {
    return this._enqueueLifecycle(async () => {
      const bridge = this._bridge;
      this._generation++;
      this._bridge = null;
      this._port = null;
      this._connectionId = null;
      this._running = false;
      this._reading = false;
      if (this._activeTab) {
        this._activeTab = {
          origin: this._activeTab.origin || null,
          title: this._activeTab.title || null,
          length: this._activeTab.length || 0,
          truncated: Boolean(this._activeTab.truncated),
          status: 'disconnected',
          updatedAt: this._now(),
        };
      }
      if (!bridge) return;
      try { bridge.revokeAll(); } catch { /* ignore */ }
      try { await bridge.close(); } catch { /* ignore */ }
    });
  }

  async close() {
    this._closed = true;
    await this.stop();
  }

  // Только для main process: секрет спаривания никогда не отдаётся в renderer или агенту.
  createPairing(ttlMs, options) {
    if (!this.enabled || !this._running || !this._bridge || this._closed) {
      const err = new Error('Мост браузера не запущен.');
      err.code = 'bridge_not_running';
      throw err;
    }
    const paired = this._bridge.pair(ttlMs, options);
    return {
      ...paired,
      port: this._port,
      extensionOrigin: this._extensionOrigin,
      connectionId: this._connectionId,
    };
  }

  revoke(id) {
    if (!this._bridge) return false;
    const ok = Boolean(this._bridge.revoke(id));
    if (ok && this._activeTab) {
      this._activeTab = {
        ...this._activeTab,
        status: 'revoked',
        updatedAt: this._now(),
      };
    }
    return ok;
  }

  revokeAll() {
    if (!this._bridge) return;
    this._bridge.revokeAll();
    if (this._activeTab) {
      this._activeTab = {
        ...this._activeTab,
        status: 'revoked',
        updatedAt: this._now(),
      };
    }
  }

  getPublicState() {
    if (!this.enabled) {
      return {
        enabled: false,
        running: false,
        connected: false,
        sessionCount: 0,
        connectionId: null,
        sessionExpires: null,
        activeTab: null,
        lastError: null,
      };
    }
    let sessions = [];
    if (this._running && this._bridge && !this._closed) {
      try {
        sessions = this._bridge.listSessions() || [];
      } catch {
        sessions = [];
      }
    }
    return {
      enabled: true,
      running: Boolean(this._running && !this._closed),
      connected: sessions.length > 0,
      sessionCount: sessions.length,
      connectionId: this._connectionId || null,
      sessionExpires: sessions[0]?.expires ?? null,
      activeTab: this._activeTab ? { ...this._activeTab } : null,
      lastError: this._lastError ? { ...this._lastError } : null,
    };
  }

  async readActiveTab({ timeoutMs, sessionId } = {}) {
    if (!this.enabled) {
      return {
        ok: false,
        errorCode: 'feature_disabled',
        error: 'Чтение вкладок через расширение браузера выключено.',
      };
    }
    if (!this._running || !this._bridge || this._closed) {
      return {
        ok: false,
        errorCode: 'bridge_not_running',
        error: 'Локальный мост браузера не запущен.',
      };
    }
    if (this._reading) {
      return {
        ok: false,
        errorCode: 'read_in_progress',
        error: 'Чтение вкладки уже выполняется.',
      };
    }

    let sessions = [];
    try {
      sessions = this._bridge.listSessions() || [];
    } catch {
      sessions = [];
    }
    if (sessions.length === 0) {
      this._activeTab = {
        origin: this._activeTab?.origin || null,
        title: this._activeTab?.title || null,
        length: 0,
        truncated: false,
        status: 'disconnected',
        updatedAt: this._now(),
      };
      const mapped = mapBridgeError('no active session');
      this._lastError = { code: mapped.errorCode, message: mapped.message, at: this._now() };
      return { ok: false, errorCode: mapped.errorCode, error: mapped.message, connectionId: this._connectionId };
    }

    const gen = this._generation;
    const bridge = this._bridge;
    const connId = this._connectionId;
    this._reading = true;
    this._activeTab = {
      origin: this._activeTab?.origin || null,
      title: this._activeTab?.title || null,
      length: this._activeTab?.length || 0,
      truncated: Boolean(this._activeTab?.truncated),
      status: 'reading',
      updatedAt: this._now(),
    };

    try {
      const effectiveTimeout = Number.isSafeInteger(timeoutMs) ? timeoutMs : this._readTimeoutMs;
      const res = await bridge.readPage({ sessionId, timeoutMs: effectiveTimeout });

      if (this._closed || gen !== this._generation) {
        const mapped = mapBridgeError('bridge closed');
        this._lastError = { code: mapped.errorCode, message: mapped.message, at: this._now() };
        return { ok: false, errorCode: mapped.errorCode, error: mapped.message, connectionId: connId };
      }

      if (!res || res.ok !== true) {
        const mapped = mapBridgeError(res?.error || 'read_failed');
        this._activeTab = {
          origin: this._activeTab?.origin || null,
          title: this._activeTab?.title || null,
          length: 0,
          truncated: false,
          status: mapped.status,
          updatedAt: this._now(),
        };
        this._lastError = { code: mapped.errorCode, message: mapped.message, at: this._now() };
        return { ok: false, errorCode: mapped.errorCode, error: mapped.message, connectionId: connId };
      }

      const safeOrigin = validatePageOrigin(res.origin);
      if (!safeOrigin) {
        this._activeTab = {
          origin: null,
          title: null,
          length: 0,
          truncated: false,
          status: 'error',
          updatedAt: this._now(),
        };
        const message = 'Получен некорректный или небезопасный origin страницы.';
        this._lastError = { code: 'invalid_origin', message, at: this._now() };
        return { ok: false, errorCode: 'invalid_origin', error: message, connectionId: connId };
      }

      const safeTitle = sanitizeTitle(res.title);
      const text = typeof res.text === 'string' ? res.text : String(res.text || '');
      const textLength = Buffer.byteLength(text, 'utf8');
      const truncated = Boolean(res.truncated);

      // Храним только безопасные метаданные вкладки: сам текст страницы здесь не сохраняется.
      this._activeTab = {
        origin: safeOrigin,
        title: safeTitle,
        length: textLength,
        truncated,
        status: 'ready',
        updatedAt: this._now(),
      };
      this._lastError = null;

      return {
        ok: true,
        connectionId: connId,
        origin: safeOrigin,
        title: safeTitle,
        length: textLength,
        truncated,
        text,
      };
    } catch (err) {
      if (this._closed || gen !== this._generation) {
        const mapped = mapBridgeError('bridge closed');
        this._lastError = { code: mapped.errorCode, message: mapped.message, at: this._now() };
        return { ok: false, errorCode: mapped.errorCode, error: mapped.message, connectionId: connId };
      }
      const mapped = mapBridgeError(err);
      this._activeTab = {
        origin: this._activeTab?.origin || null,
        title: this._activeTab?.title || null,
        length: 0,
        truncated: false,
        status: mapped.status,
        updatedAt: this._now(),
      };
      this._lastError = { code: mapped.errorCode, message: mapped.message, at: this._now() };
      return { ok: false, errorCode: mapped.errorCode, error: mapped.message, connectionId: connId };
    } finally {
      if (gen === this._generation) {
        this._reading = false;
      }
    }
  }
}

module.exports = {
  BrowserBridgeService,
  validateExtensionOrigin,
  validatePageOrigin,
  sanitizeTitle,
  mapBridgeError,
};
