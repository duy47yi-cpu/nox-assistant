'use strict';

// Не давать компьютеру заснуть во время работы (идея Hermes Agent): долгие поручения
// не должны обрываться сном, но экран по-прежнему может гаснуть.
// Режимы: off — никогда; while-working — только пока идёт ход/миссия/задача;
// always — постоянно, пока приложение открыто.
const MODES = Object.freeze(['off', 'while-working', 'always']);
const DEFAULT_MODE = 'while-working';

// blocker — Electron powerSaveBlocker (или подставной объект в тестах).
// Один блокировщик на всё приложение: повторные begin не создают второй.
function createKeepAwake({ blocker = null, mode = DEFAULT_MODE } = {}) {
  let current = MODES.includes(mode) ? mode : DEFAULT_MODE;
  let working = 0;
  let id = null;

  const usable = () => Boolean(blocker) && typeof blocker.start === 'function' && typeof blocker.stop === 'function';

  function stopBlocker() {
    if (id === null) return;
    try {
      if (typeof blocker.isStarted !== 'function' || blocker.isStarted(id)) blocker.stop(id);
    } catch {
      // Система уже сняла блокировку: главное — не держать устаревший id.
    }
    id = null;
  }

  function startBlocker() {
    if (id !== null || !usable()) return;
    try {
      id = blocker.start('prevent-app-suspension');
    } catch {
      id = null; // блокировщик недоступен: работа продолжается без него
    }
  }

  function state() {
    return { mode: current, working: working > 0, active: working, blocked: id !== null };
  }

  function sync() {
    const want = current === 'always' || (current === 'while-working' && working > 0);
    if (want) startBlocker();
    else stopBlocker();
    return state();
  }

  return {
    begin() {
      working += 1;
      return sync();
    },
    end() {
      working = Math.max(0, working - 1);
      return sync();
    },
    setMode(next) {
      current = MODES.includes(next) ? next : DEFAULT_MODE;
      return sync();
    },
    getMode() {
      return current;
    },
    state,
    // Полная остановка: при выходе из приложения.
    stop() {
      working = 0;
      stopBlocker();
      return state();
    },
  };
}

module.exports = { createKeepAwake, MODES, DEFAULT_MODE };
