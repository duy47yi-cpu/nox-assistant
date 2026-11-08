'use strict';

const { randomUUID } = require('crypto');

const DECISIONS = new Set(['once', 'session', 'reject']);
// Явный таймаут запроса (для тестов и особых случаев). null — использовать автоотмену.
const DEFAULT_TIMEOUT_MS = null;
// Подтверждение не должно висеть вечно: без ответа действие отменяется через 30 с.
const DEFAULT_AUTO_CANCEL_MS = 30_000;
// Сколько отменённых запросов помнить, чтобы на поздний ответ сказать причину (старые забываются первыми).
const MAX_CLOSED = 200;

// Голосом можно ответить коротко и однозначно (см. parseApprovalAnswer).
const ACCEPT_ANSWERS = new Set(['да', 'давай', 'подтверждаю', 'правильно', 'разрешаю', 'согласен', 'согласна']);
const REJECT_ANSWERS = new Set(['нет', 'отмена', 'не надо', 'стоп', 'отменить', 'отклоняю', 'не разрешаю', 'не подтверждаю']);
// «Останови команду» — снять все ожидающие подтверждения, а не ответить на одно.
const CANCEL_ALL_PHRASES = Object.freeze([
  'останови команду', 'останови все команды', 'отмени все подтверждения', 'отмени все команды',
]);

// Фраза для сравнения: нижний регистр, ё как е, без пунктуации; «Джарвис» и «пожалуйста» не мешают.
function normalizeAnswerText(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && word !== 'джарвис' && word !== 'пожалуйста' && word !== 'плиз')
    .join(' ');
}

// Что владелец сказал про ожидающее подтверждение:
// 'once' — «да/давай/подтверждаю/правильно», 'reject' — «нет/отмена/не надо/стоп»,
// 'cancelAll' — «останови команду», null — это не ответ (обычная речь).
function parseApprovalAnswer(text) {
  const phrase = normalizeAnswerText(text);
  if (!phrase) return null;
  if (CANCEL_ALL_PHRASES.some((item) => phrase === item || phrase.startsWith(item + ' '))) return 'cancelAll';
  if (ACCEPT_ANSWERS.has(phrase)) return 'once';
  if (REJECT_ANSWERS.has(phrase)) return 'reject';
  // «да, давай», «нет, отмена» — все значимые слова из одного набора.
  const words = phrase.split(' ');
  if (words.every((word) => ACCEPT_ANSWERS.has(word))) return 'once';
  if (words.every((word) => REJECT_ANSWERS.has(word))) return 'reject';
  return null;
}

// Ожидание решения владельца с автоотменой. Явный timeoutMs (число) важнее автоотмены;
// autoCancelMs: 0 или null — ждать без ограничения (см. remaining()).
class ApprovalBroker {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, autoCancelMs = DEFAULT_AUTO_CANCEL_MS, now = () => Date.now(), onAutoCancel = null } = {}) {
    this.timeoutMs = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
    this.autoCancelMs = Number.isFinite(autoCancelMs) && autoCancelMs > 0 ? autoCancelMs : null;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._onAutoCancel = typeof onAutoCancel === 'function' ? onAutoCancel : null;
    this._pending = new Map(); // id -> { resolve, timer, timerMs, payload }
    this._closed = new Map(); // id -> причина отмены: отменённое подтверждение использовать нельзя
  }

  // Если id не передан, генерируем и записываем обратно в payload,
  // чтобы вызывающий код мог узнать id и передать его в respond().
  // В payload добавляется autoCancelAt (когда запрос отменится сам): окно показывает обратный отсчёт.
  request(payload = {}) {
    if (!payload.id) payload.id = randomUUID();
    const id = payload.id;
    if (this._pending.has(id)) this._settle(id, 'reject');
    this._closed.delete(id); // новый запрос с тем же id — новое ожидание
    const timerMs = this._timerMs();
    const expiresAt = timerMs ? this._now() + timerMs : null;
    if (expiresAt) payload.autoCancelAt = expiresAt;
    return new Promise((resolve) => {
      const timer = expiresAt
        ? setTimeout(() => this._autoCancel(id), timerMs)
        : null;
      // Таймер не держит процесс: в приложении событийный цикл жив, в тестах не тянет время.
      if (timer && typeof timer.unref === 'function') timer.unref();
      this._pending.set(id, { resolve, timer, timerMs, payload: { ...payload } });
    });
  }

  // Голосовой путь: тот же запрос с таймером (название ask() читается понятнее в коде окна).
  ask(payload = {}) {
    return this.request(payload);
  }

  // true, если запрос с таким id ещё ждал ответа. Отменённый (cancel, cancelAll, автоотмена) — false:
  // ответ не принимается, причина — closedReason(id).
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

  // Отклоняет все ожидающие подтверждения. Возвращает число отклонённых.
  cancelAll(reason = 'аварийный стоп') {
    const ids = [...this._pending.keys()];
    for (const id of ids) this.cancel(id, reason);
    return ids.length;
  }

  // Почему запрос больше не принимает ответ (он был отменён), или null.
  closedReason(id) {
    return this._closed.has(id) ? this._closed.get(id) : null;
  }

  // Сколько миллисекунд осталось до автоотмены запроса (null — таймера нет или запрос уже решён).
  remaining(id, at = this._now()) {
    const entry = this._pending.get(id);
    if (!entry || !entry.payload.autoCancelAt) return null;
    return Math.max(0, entry.payload.autoCancelAt - at);
  }

  // Что ждёт решения владельца: для списка подтверждений в окне (autoCancelAt — для отсчёта).
  list() {
    return [...this._pending.values()].map((entry) => ({ ...entry.payload }));
  }

  _timerMs() {
    if (typeof this.timeoutMs === 'number' && this.timeoutMs > 0) return this.timeoutMs;
    return this.autoCancelMs;
  }

  _autoCancel(id) {
    const entry = this._pending.get(id);
    if (!entry) return;
    const reason = 'время на подтверждение вышло';
    this._remember(id, reason);
    this._settle(id, 'reject');
    if (this._onAutoCancel) {
      try {
        this._onAutoCancel(id, reason);
      } catch {
        // подписчик окна не должен ломать брокер
      }
    }
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

module.exports = {
  ApprovalBroker,
  DECISIONS,
  DEFAULT_AUTO_CANCEL_MS,
  DEFAULT_TIMEOUT_MS,
  ACCEPT_ANSWERS,
  REJECT_ANSWERS,
  CANCEL_ALL_PHRASES,
  normalizeAnswerText,
  parseApprovalAnswer,
};
