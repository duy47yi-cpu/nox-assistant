'use strict';

// Лимит подписки исчерпан: работа не падает, а ждёт сброса и продолжается с того же места.
// Обёртка над вызовом модели, поэтому одинаково работает для чата, задач и длинных поручений. Стоп снимает ожидание.
const MARGIN_MS = 2000; // часы приложения и сервера могут немного расходиться
const MIN_WAIT_MS = 5000; // сервер ещё не открыл окно: не долбим его запросами
const MAX_WAIT_MS = 2 ** 31 - 1; // предел setTimeout; дольше ждём следующим заходом

function sleepUntil(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, Math.min(ms, MAX_WAIT_MS));
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

function waitOnLimit(brain, { onPause = () => {}, onResume = () => {}, now = () => Date.now(), sleep = sleepUntil } = {}) {
  return {
    get model() {
      return brain.model;
    },
    async chat(args = {}) {
      let paused = false;
      for (;;) {
        try {
          const res = await brain.chat(args);
          if (paused) onResume();
          return res;
        } catch (err) {
          const canWait = err && err.accountCode === 'limit' && Number.isFinite(err.resetAt) && args.purpose !== 'warmup';
          if (!canWait) {
            if (paused) onResume();
            throw err;
          }
          // Время до сброса считает сервер: часы компьютера могут врать на часы. Сообщаем один раз за всё ожидание.
          const left = Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : err.resetAt - now();
          if (!paused) onPause({ window: err.window, resetAt: now() + Math.max(0, left) });
          paused = true;
          await sleep(Math.max(MIN_WAIT_MS, left + MARGIN_MS), args.signal);
          if (args.signal && args.signal.aborted) {
            onResume();
            throw err;
          }
        }
      }
    },
  };
}

module.exports = { waitOnLimit };
