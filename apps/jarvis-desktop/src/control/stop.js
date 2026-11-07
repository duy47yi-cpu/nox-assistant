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

module.exports = { StopSwitch, isStopPhrase, busyRoute, runHotkey, BUSY_TEXT };
