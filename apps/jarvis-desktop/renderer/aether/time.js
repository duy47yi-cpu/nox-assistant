/* Время в чате Nox Aether: подпись ЧЧ:ММ у реплики, дата/«вчера» в списке чатов
 * и сопоставление сохранённой истории с отметками, которые окно видело живьём.
 * Чистые функции без DOM и без хранилища — покрыты tests/aether-time.test.js. */
(function (root) {
  'use strict';

  const DAY_MS = 86400000;
  // chatHistoryRows обрезает реплику до 2000 символов: отпечаток считаем по тому же срезу.
  const TEXT_LIMIT = 2000;

  const pad = (n) => String(n).padStart(2, '0');

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function formatClock(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatChatStamp(ms, nowMs = Date.now()) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const days = Math.round((startOfDay(nowMs) - startOfDay(ms)) / DAY_MS);
    if (days <= 0) return formatClock(ms);
    if (days === 1) return 'вчера';
    const d = new Date(ms);
    const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
    return d.getFullYear() === new Date(nowMs).getFullYear() ? date : `${date}.${d.getFullYear()}`;
  }

  // Чат без сохранённой отметки времени уходит в «Ранее» и остаётся без подписи: не выдумываем.
  // Внутри каждой группы сортируем по свежести сверху вниз, чтобы старые чаты не прыгали и не путались.
  function splitChats(chats, nowMs = Date.now()) {
    const today = [];
    const earlier = [];
    const todayStart = startOfDay(nowMs);
    for (const chat of Array.isArray(chats) ? chats : []) {
      const ts = Number(chat && chat.updatedAt);
      if (Number.isFinite(ts) && ts >= todayStart) today.push(chat);
      else earlier.push(chat);
    }
    const byRecent = (a, b) => (Number(b && b.updatedAt) || 0) - (Number(a && a.updatedAt) || 0);
    today.sort(byRecent);
    earlier.sort(byRecent);
    return { today, earlier };
  }

  // Отпечаток вместо текста: в localStorage не попадает содержимое переписки.
  function fingerprint(text) {
    const s = String(text == null ? '' : text).slice(0, TEXT_LIMIT);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // Отметки живых ходов: [{ h — отпечаток вопроса, u — время вопроса, a — время ответа }].
  // В сохранённой истории реплик ассистента может быть больше, чем ходов в окне
  // (промежуточные ответы перед вызовом инструмента): время достаётся последней реплике
  // хода, остальные остаются без подписи. Несовпавший вопрос времени не даёт.
  function withTurnTimes(rows, turns) {
    const out = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
    const known = Array.isArray(turns) ? turns : [];
    if (!known.length) return out;
    let cursor = 0;
    let replyAt = null;
    let pending = [];
    const flush = () => {
      if (replyAt !== null && pending.length) pending[pending.length - 1].at = replyAt;
      pending = [];
      replyAt = null;
    };
    for (const row of out) {
      if (row.kind === 'user') {
        flush();
        const h = fingerprint(row.text);
        let found = -1;
        for (let i = cursor; i < known.length; i += 1) {
          if (known[i] && known[i].h === h) { found = i; break; }
        }
        if (found < 0) continue;
        cursor = found + 1;
        if (Number.isFinite(known[found].u)) row.at = known[found].u;
        replyAt = Number.isFinite(known[found].a) ? known[found].a : null;
      } else if (row.kind === 'assistant') {
        pending.push(row);
      }
    }
    flush();
    return out;
  }

  const exported = { DAY_MS, TEXT_LIMIT, formatClock, formatChatStamp, splitChats, fingerprint, withTurnTimes };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.NoxAetherTime = exported;
})(typeof window !== 'undefined' ? window : globalThis);