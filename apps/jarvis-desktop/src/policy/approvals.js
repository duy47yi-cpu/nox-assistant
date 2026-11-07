'use strict';

const { randomUUID } = require('crypto');

const DECISIONS = new Set(['once', 'session', 'reject']);
// Автоотказа нет: решение ждёт владельца, сколько нужно. Таймаут можно задать явно (для тестов и особых случаев).
const DEFAULT_TIMEOUT_MS = null;
// Сколько отменённых запросов помнить, чтобы на поздний ответ сказать причину (старые забываются первыми).
const MAX_CLOSED = 200;

// Ожидание решения владельца. Без таймаута решение не принимается само: только ответ, отмена или стоп.
class ApprovalBroker {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    this._pending = new Map(); // id -> { resolve, timer, payload }
    this._closed = new Map(); // id -> причина отмены: отменённое подтверждение использовать нельзя
  }

  // Если id не передан, генерируем и записываем обратно в payload,
  // чтобы вызывающий код мог узнать id и передать его в respond().
  request(payload = {}) {
    if (!payload.id) payload.id = randomUUID();
    const id = payload.id;
    if (this._pending.has(id)) this._settle(id, 'reject');
    this._closed.delete(id); // новый запрос с тем же id — новое ожидание
    return new Promise((resolve) => {
      const timer = typeof this.timeoutMs === 'number' && this.timeoutMs > 0
        ? setTimeout(() => this._settle(id, 'reject'), this.timeoutMs)
        : null;
      this._pending.set(id, { resolve, timer, payload: { ...payload } });
    });
  }

  // true, если запрос с таким id ещё ждал ответа. Отменённый (cancel, cancelAll) — false: ответ не принимается,
  // причина — closedReason(id).
  respond(id, decision) {
    if (!DECISIONS.has(decision)) throw new TypeError(`неизвестное решение: ${decision}`);
    return this._settle(id, decision);
  }

  // Отмена одного запроса: ожидающий получает «отказ», поздний ответ владельца не принимается. true — запрос ждал.
  cancel(id, reason = 'подтверждение отменено') {
    if (!this._pending.has(id)) return false;
    this._remember(id, reason);
    return this._settle(id, 'reject');
  }

  // Отмена всех запросов, чей id начинается с prefix (например, «<id задачи>:»). Возвращает отменённые id.
  cancelPrefix(prefix, reason = 'подтверждение отменено') {
    if (typeof prefix !== 'string' || prefix === '') return [];
    const ids = [...this._pending.keys()].filter((id) => typeof id === 'string' && id.startsWith(prefix));
    for (const id of ids) this.cancel(id, reason);
    return ids;
  }

  // Отклоняет все ожидающие подтверждения (например, при стопе). Возвращает число отклонённых.
  cancelAll(reason = 'аварийный стоп') {
    const ids = [...this._pending.keys()];
    for (const id of ids) this.cancel(id, reason);
    return ids.length;
  }

  // Почему запрос больше не принимает ответ (он был отменён), или null.
  closedReason(id) {
    return this._closed.has(id) ? this._closed.get(id) : null;
  }

  // Что ждёт решения владельца: для списка подтверждений в окне.
  list() {
    return [...this._pending.values()].map((entry) => ({ ...entry.payload }));
  }

  _remember(id, reason) {
    this._closed.delete(id);
    this._closed.set(id, String(reason || 'подтверждение отменено'));
    while (this._closed.size > MAX_CLOSED) this._closed.delete(this._closed.keys().next().value);
  }

  _settle(id, decision) {
    const entry = this._pending.get(id);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this._pending.delete(id);
    entry.resolve(decision);
    return true;
  }
}

module.exports = { ApprovalBroker };
