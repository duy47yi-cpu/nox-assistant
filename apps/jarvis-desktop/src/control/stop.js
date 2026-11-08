'use strict';

// Аварийный стоп: один выключатель на весь процесс. Пока он включён, новые действия не начинаются:
// ни шаги чата, ни шаги команд, ни фоновые задачи. Выполненное не отменяется.
// Сброс — только явным действием владельца (пункт «Возобновить» в трее).
class StopSwitch {
  constructor() {
    this._stopped = false;
    this._reason = null;
    this._listeners = new Set();
  }

  isStopped() {
    return this._stopped;
  }

  get reason() {
    return this._reason;
  }

  // true, если стоп включился сейчас; повторный вызов ничего не делает.
  trigger(reason = 'стоп') {
    if (this._stopped) return false;
    this._stopped = true;
    this._reason = String(reason);
    for (const fn of [...this._listeners]) {
      try {
        fn({ reason: this._reason });
      } catch (err) {
        console.error(`стоп: подписчик упал: ${err && err.message ? err.message : err}`);
      }
    }
    return true;
  }

  reset() {
    this._stopped = false;
    this._reason = null;
  }

  // Возвращает функцию отписки.
  onTrigger(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}

const STOP_PHRASE = /^(стоп|стой|хватит|отмена|отмени|останови|остановись|прекрати)[\s!.]*$/i;

function isStopPhrase(text) {
  return STOP_PHRASE.test(String(text || '').trim());
}

// Что ответить, пока идёт ход: «что повисло» и «стоп» работают, остальное занято.
// Ответ уходит прямо в вызов: история хода и состояние окна не меняются, иначе вклинилось бы между вызовом инструмента и его результатом.
function busyRoute(text, { isHanging, hangingNow, stopTurn }) {
  if (isHanging(text)) return { ok: true, side: true, command: 'дела', reply: hangingNow() };
  if (isStopPhrase(text)) {
    stopTurn();
    return { ok: true, side: true, command: 'стоп', reply: 'Останавливаю текущий ход.' };
  }
  return { ok: false, error: 'busy' };
}

// Тот же текст, что показывает окно при отказе «занят» (renderer/app.js).
const BUSY_TEXT = 'Джарвис занят предыдущим поручением';

// Горячая клавиша сценария: второй ход не запускается, пока идёт первый. Отказ — тем же текстом, что в окне.
async function runHotkey({ isBusy, setBusy, run, report }) {
  if (isBusy()) {
    report(BUSY_TEXT);
    return false;
  }
  setBusy(true);
  try {
    await run();
    return true;
  } finally {
    setBusy(false);
  }
}

// Защита окон Electron (Hermes Agent window-open-policy + window-renderer-lifecycle):
// 1) запрет всплывающих окон (setWindowOpenHandler -> deny) с безопасным описанием URL без query/hash;
// 2) блокировка навигации окна со страницы интерфейса на внешние адреса (will-navigate);
// 3) ограниченный перезапуск упавшего рендерера (не более maxCrashes за windowMs, чтобы не уйти в бесконечный цикл).
function describeDeniedUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    return parsed.origin === 'null' ? parsed.protocol : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

function createWindowOpenHandler(log = console.warn) {
  return ({ url }) => {
    log(`[window-guard] blocked window.open to ${describeDeniedUrl(url)}`);
    return { action: 'deny' };
  };
}

const RECOVERABLE_CRASH_REASONS = new Set(['crashed', 'oom', 'killed']);

function createCrashLoopGuard({ maxCrashes = 3, windowMs = 60000, now = Date.now } = {}) {
  const timestamps = [];
  return {
    shouldReload(reason) {
      if (!RECOVERABLE_CRASH_REASONS.has(String(reason || ''))) return false;
      const t = now();
      while (timestamps.length > 0 && t - timestamps[0] > windowMs) {
        timestamps.shift();
      }
      if (timestamps.length >= maxCrashes) return false;
      timestamps.push(t);
      return true;
    },
  };
}

function attachWindowGuards(win, { log = console.warn, maxCrashes = 3, windowMs = 60000, now = Date.now } = {}) {
  const wc = win && win.webContents;
  if (!wc) return;
  if (typeof wc.setWindowOpenHandler === 'function') {
    wc.setWindowOpenHandler(createWindowOpenHandler(log));
  }
  if (typeof wc.on === 'function') {
    wc.on('will-navigate', (event, url) => {
      const target = String(url || '');
      if (!target.startsWith('file://')) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        log(`[window-guard] blocked navigation to ${describeDeniedUrl(target)}`);
      }
    });
    const crashGuard = createCrashLoopGuard({ maxCrashes, windowMs, now });
    wc.on('render-process-gone', (_event, details) => {
      const reason = details && details.reason;
      const exitCode = details && details.exitCode;
      log(`[window-guard] renderer gone: reason=${reason} exitCode=${exitCode}`);
      if (crashGuard.shouldReload(reason)) {
        if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
        if (typeof wc.reload === 'function') wc.reload();
      }
    });
  }
}

module.exports = {
  StopSwitch,
  isStopPhrase,
  busyRoute,
  runHotkey,
  BUSY_TEXT,
  describeDeniedUrl,
  createWindowOpenHandler,
  createCrashLoopGuard,
  attachWindowGuards,
};
