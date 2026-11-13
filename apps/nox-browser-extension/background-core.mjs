import { connectBridge } from './client.mjs';
import { GRANT_TTL_MS, MAX_TEXT_BYTES, MAX_TITLE_BYTES, truncateUtf8 } from './messages.mjs';
import { allowedOrigin, extractPage } from './page.mjs';

export function createController({
  api,
  connect = connectBridge,
  origin,
  grantTtlMs = GRANT_TTL_MS,
  clock = {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: id => globalThis.clearTimeout(id),
    now: Date.now,
  },
}) {
  if (!Number.isSafeInteger(grantTtlMs) || grantTtlMs < 1 || grantTtlMs > GRANT_TTL_MS) {
    throw new RangeError('invalid grant lifetime');
  }

  let client = null;
  let grant = null;
  let generation = 0;
  let accessGeneration = 0;
  let timer = null;
  let grantTimer = null;
  let heartbeat = null;
  let connection = 'disconnected';
  let access = 'revoked';
  let error = '';
  let accessError = '';
  const inFlight = new Set();

  function expireGrantIfNeeded() {
    if (grant && clock.now() >= grant.expires) {
      revoke();
    }
  }

  const status = () => {
    expireGrantIfNeeded();
    return {
      connection,
      access,
      origin: grant?.origin || null,
      grantExpires: grant?.expires || null,
      error,
      accessError,
    };
  };

  function revoke() {
    for (const op of inFlight) op.aborted = true;
    accessGeneration++;
    clock.clearTimeout(grantTimer);
    grantTimer = null;
    grant = null;
    access = 'revoked';
    accessError = '';
  }

  function disconnect() {
    generation++;
    clock.clearTimeout(timer);
    clock.clearTimeout(heartbeat);
    timer = heartbeat = null;
    const old = client;
    client = null;
    connection = 'disconnected';
    error = '';
    revoke();
    if (old) old.close();
  }

  function scheduleHeartbeat(candidate, token) {
    heartbeat = clock.setTimeout(async () => {
      if (generation !== token || client !== candidate) return;
      try {
        await candidate.ping();
        if (generation === token && client === candidate) scheduleHeartbeat(candidate, token);
      } catch {
        if (generation === token && client === candidate) {
          disconnect();
          connection = 'error';
          error = 'Связь с мостом потеряна';
        }
      }
    }, 20000);
  }

  async function pair(message) {
    disconnect();
    const token = generation;
    connection = 'pairing';
    try {
      const candidate = await connect({
        port: message.port,
        origin,
        pairing: message.pairing,
        clock,
        onReadRequest: request => readGranted(request),
        onClose: () => {
          if (generation === token) disconnect();
        },
      });
      if (generation !== token) {
        candidate.close();
        return status();
      }
      client = candidate;
      await candidate.ping();
      if (generation !== token || client !== candidate) return status();
      connection = 'connected';
      const sessionExpires = Number.isSafeInteger(candidate.sessionExpires)
        ? candidate.sessionExpires
        : message.pairing?.expires;
      timer = clock.setTimeout(() => {
        if (generation === token) disconnect();
      }, Math.max(0, sessionExpires - clock.now()));
      scheduleHeartbeat(candidate, token);
    } catch {
      if (generation === token) {
        if (client) client.close();
        client = null;
        connection = 'error';
        error = 'Не удалось подтвердить мост';
      }
    }
    return status();
  }

  // Triggered ONLY by explicit owner click ("Разрешить и прочитать") in the popup.
  // Grants one-time read permission bound to tabId, origin, and <= 60s lifetime.
  async function read() {
    revoke();
    const token = generation;
    const accessToken = accessGeneration;
    let op = null;
    try {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      const tabOrigin = allowedOrigin(tab?.url);
      if (generation !== token || accessToken !== accessGeneration || !tabOrigin || !Number.isInteger(tab?.id)) {
        throw Error('unsupported');
      }
      op = { tabId: tab.id, origin: tabOrigin, aborted: false };
      inFlight.add(op);
      const result = await api.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: extractPage,
      });
      const current = await api.tabs.get(tab.id);
      if (
        generation !== token ||
        accessToken !== accessGeneration ||
        op.aborted ||
        !current ||
        allowedOrigin(current.url) !== tabOrigin ||
        current.active === false
      ) {
        throw Error('changed');
      }
      const titleCut = truncateUtf8(String(result[0]?.result?.title || ''), MAX_TITLE_BYTES);
      const textCut = truncateUtf8(String(result[0]?.result?.text || ''), MAX_TEXT_BYTES);
      const expires = clock.now() + grantTtlMs;
      const grantGen = ++accessGeneration;
      grant = { tabId: tab.id, origin: tabOrigin, expires, used: false, generation: grantGen };
      access = 'granted';
      accessError = '';
      grantTimer = clock.setTimeout(() => {
        if (grant?.generation === grantGen) revoke();
      }, grantTtlMs);
      grantTimer?.unref?.();
      return {
        ...status(),
        title: titleCut.text,
        text: textCut.text,
        truncated: Boolean(titleCut.truncated || textCut.truncated),
      };
    } catch {
      if (accessToken === accessGeneration || grant === null) {
        revoke();
        accessError = 'Нужно снова разрешить доступ к текущей вкладке';
      }
      return status();
    } finally {
      if (op) inFlight.delete(op);
    }
  }

  // Triggered ONLY to fulfill an authenticated bridge read_request (or direct granted read).
  // Never creates a grant and never accepts tabId/consent from the remote request.
  async function readGranted(request) {
    if (request && (Object.hasOwn(request, 'tabId') || Object.hasOwn(request, 'grant'))) {
      return { ok: false, error: 'tab_selection_forbidden' };
    }
    if (!grant) {
      return { ok: false, error: 'permission_required' };
    }
    if (grant.used) {
      revoke();
      return { ok: false, error: 'grant_used' };
    }
    if (clock.now() >= grant.expires) {
      revoke();
      return { ok: false, error: 'grant_expired' };
    }

    const { tabId, origin: expectedOrigin, expires } = grant;
    const token = generation;
    grant.used = true;
    revoke();

    const op = { tabId, origin: expectedOrigin, aborted: false };
    inFlight.add(op);
    try {
      let currentBefore;
      try {
        currentBefore = await api.tabs.get(tabId);
      } catch {
        return { ok: false, error: 'tab_closed' };
      }
      if (generation !== token || op.aborted) return { ok: false, error: 'revoked' };
      if (clock.now() >= expires) return { ok: false, error: 'grant_expired' };
      if (!currentBefore || allowedOrigin(currentBefore.url) !== expectedOrigin) {
        return { ok: false, error: 'origin_changed' };
      }
      if (currentBefore.active === false) {
        return { ok: false, error: 'tab_changed' };
      }
      if (typeof api.tabs?.query === 'function') {
        const queryFilter =
          typeof currentBefore.windowId === 'number'
            ? { active: true, windowId: currentBefore.windowId }
            : { active: true, currentWindow: true };
        const [activeTab] = await api.tabs.query(queryFilter);
        if (op.aborted || generation !== token) return { ok: false, error: 'revoked' };
        if (activeTab && Number.isInteger(activeTab.id) && activeTab.id !== tabId) {
          return { ok: false, error: 'tab_changed' };
        }
        if (typeof currentBefore.windowId === 'number' && !activeTab) {
          return { ok: false, error: 'tab_changed' };
        }
      }
      if (clock.now() >= expires) return { ok: false, error: 'grant_expired' };

      const result = await api.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: extractPage,
      });

      let currentAfter;
      try {
        currentAfter = await api.tabs.get(tabId);
      } catch {
        return { ok: false, error: 'tab_closed' };
      }
      if (generation !== token || op.aborted) return { ok: false, error: 'revoked' };
      if (clock.now() >= expires) return { ok: false, error: 'grant_expired' };
      if (!currentAfter || allowedOrigin(currentAfter.url) !== expectedOrigin) {
        return { ok: false, error: 'origin_changed' };
      }
      if (currentAfter.active === false) {
        return { ok: false, error: 'tab_changed' };
      }

      const titleCut = truncateUtf8(String(result[0]?.result?.title || ''), MAX_TITLE_BYTES);
      const textCut = truncateUtf8(String(result[0]?.result?.text || ''), MAX_TEXT_BYTES);
      return {
        ok: true,
        origin: expectedOrigin,
        title: titleCut.text,
        text: textCut.text,
        truncated: Boolean(titleCut.truncated || textCut.truncated),
      };
    } catch {
      return { ok: false, error: 'read_failed' };
    } finally {
      inFlight.delete(op);
    }
  }

  function updated(id, change) {
    const isUnsafeChange =
      change?.status === 'loading' ||
      change?.discarded === true ||
      Boolean(change?.url);
    if (!isUnsafeChange) return;
    for (const op of inFlight) {
      if (
        op.tabId === id &&
        (change?.status === 'loading' ||
          change?.discarded === true ||
          (change?.url && allowedOrigin(change.url) !== op.origin))
      ) {
        op.aborted = true;
      }
    }
    if (
      grant &&
      grant.tabId === id &&
      (change?.status === 'loading' ||
        change?.discarded === true ||
        (change?.url && allowedOrigin(change.url) !== grant.origin))
    ) {
      revoke();
    }
  }

  function removed(id) {
    for (const op of inFlight) {
      if (op.tabId === id) op.aborted = true;
    }
    if (grant?.tabId === id) revoke();
  }

  async function handle(message) {
    switch (message?.type) {
      case 'status':
        return status();
      case 'pair':
        return pair(message);
      case 'disconnect':
        disconnect();
        return status();
      case 'read-current':
        return read();
      case 'revoke':
        revoke();
        return status();
      default:
        return { ...status(), error: 'Действие недоступно' };
    }
  }

  return { handle, updated, removed, deactivate: revoke, read, readGranted };
}
