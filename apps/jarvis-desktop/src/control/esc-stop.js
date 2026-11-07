'use strict';

// Esc останавливает ход, пока руки Джарвиса работают на рабочем столе. Esc ловится у всех программ,
// поэтому он занят только с первого действия рук в ходе и до конца хода; фон Esc не занимает.
// Свой Esc из ui_keys стопом не считается: пока такой шаг идёт (и 300 мс после), нажатие Esc пропускается.
// onChange(active) — руки начали или закончили работу в этом ходе: для надписи «Nox работает на вашем ПК».
const KEY = 'Escape';
const AFTER_OWN_KEY_MS = 300;

class EscStop {
  constructor({ register, unregister, onStop, onChange = () => {}, setTimer = setTimeout } = {}) {
    this.register = register;
    this.unregister = unregister;
    this.onStop = onStop;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.active = false; // руки работают в этом ходе
    this.armed = false; // Esc занят нами
    this.muted = 0;
  }

  _setActive(value) {
    if (this.active === value) return;
    this.active = value;
    try { this.onChange(value); } catch {}
  }

  arm() {
    this._setActive(true);
    if (this.armed) return;
    try {
      this.armed = Boolean(this.register(KEY, () => this.press()));
    } catch {
      this.armed = false; // Esc занят другой программой: остаются кнопка, «стоп» и Ctrl+Alt+Shift+K
    }
  }

  disarm() {
    this._setActive(false);
    if (!this.armed) return;
    this.armed = false;
    try { this.unregister(KEY); } catch {}
  }

  press() {
    if (this.muted > 0) return false;
    this.disarm();
    this.onStop();
    return true;
  }

  // Для замка рабочего стола: перед действием. Возвращает функцию «действие закончилось» или null.
  action(name, args, ctx = {}) {
    if (ctx.background) return null;
    this.arm();
    if (name !== 'ui_keys' || !/escape/i.test(String((args && args.keys) || ''))) return null;
    this.muted += 1;
    return () => { this.setTimer(() => { this.muted -= 1; }, AFTER_OWN_KEY_MS); };
  }
}

module.exports = { EscStop };
