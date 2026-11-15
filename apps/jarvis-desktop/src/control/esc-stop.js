'use strict';

// Esc останавливает ход, пока руки Джарвиса работают на рабочем столе. Esc ловится у всех программ,
// поэтому он занят только с первого действия рук в ходе и до конца хода; фон Esc не занимает.
// Свой Esc из ui_keys стопом не считается: пока такой шаг идёт (и 300 мс после), нажатие Esc пропускается.
// onChange(active) — руки начали или закончили работу в этом ходе: для надписи «Nox работает на вашем ПК».
const KEY = 'Escape';
const AFTER_OWN_KEY_MS = 60;

class EscStop {
  constructor({ register, unregister, onStop, onChange = () => {}, setTimer = setTimeout } = {}) {
    this.register = register;
    this.unregister = unregister;
    this.onStop = onStop;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.active = false; // руки работают в этом ходе
    this.armed = false; // Esc занят нами
    this._holders = new Set();
    this.inStepMuted = 0;
    this.tailMuted = 0;
    this._consumeStep = null;
    this._consumeTail = null;
  }

  get muted() {
    return this.inStepMuted + this.tailMuted;
  }

  set muted(v) {
    this.inStepMuted = Math.max(0, Number(v) || 0);
    this.tailMuted = 0;
  }

  _setActive(value) {
    if (this.active === value) return;
    this.active = value;
    try { this.onChange(value); } catch {}
  }

  arm(holder = 'default') {
    const key = holder || 'default';
    this._holders.add(key);
    this._setActive(true);
    if (this.armed) return;
    try {
      this.armed = Boolean(this.register(KEY, () => this.press()));
    } catch {
      this.armed = false; // Esc занят другой программой: остаются кнопка, «стоп» и Ctrl+Alt+Shift+K
    }
  }

  _disarmNow() {
    this._setActive(false);
    if (!this.armed) return;
    this.armed = false;
    try { this.unregister(KEY); } catch {}
  }

  release(holder = 'default') {
    const key = holder || 'default';
    this._holders.delete(key);
    if (this._holders.size > 0) return false;
    this._disarmNow();
    return true;
  }

  disarm(holder) {
    if (holder !== undefined) return this.release(holder);
    if (this._holders.size > 1) {
      if (this._holders.has('default')) this._holders.delete('default');
      else this._holders.delete(this._holders.values().next().value);
      return false;
    }
    this._holders.clear();
    this._disarmNow();
    return true;
  }

  press() {
    if (this.inStepMuted > 0 && typeof this._consumeStep === 'function' && this._consumeStep()) return false;
    if (this.tailMuted > 0 && typeof this._consumeTail === 'function' && this._consumeTail()) return false;
    this._holders.clear();
    this.inStepMuted = 0;
    this.tailMuted = 0;
    this._disarmNow();
    this.onStop();
    return true;
  }

  // Для замка рабочего стола: перед действием. Возвращает функцию «действие закончилось» или null.
  action(name, args, ctx = {}) {
    if (ctx && ctx.background) return null;
    const holder = (ctx && (ctx.runId || ctx.holder || ctx.agentId)) || 'default';
    this.arm(holder);
    const escCount = name === 'ui_keys'
      ? String((args && args.keys) || '').trim().split(/\s+/).filter((k) => /^(?:escape|esc)$/i.test(k)).length
      : 0;
    if (!escCount) return null;
    let stepRemaining = escCount;
    this.inStepMuted += stepRemaining;
    const prevStep = this._consumeStep;
    this._consumeStep = () => {
      if (stepRemaining > 0) {
        stepRemaining -= 1;
        this.inStepMuted = Math.max(0, this.inStepMuted - 1);
        return true;
      }
      return typeof prevStep === 'function' ? prevStep() : false;
    };
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (stepRemaining > 0) {
        this.inStepMuted = Math.max(0, this.inStepMuted - stepRemaining);
        stepRemaining = 0;
      }
      let tailRemaining = 1;
      this.tailMuted += 1;
      const prevTail = this._consumeTail;
      this._consumeTail = () => {
        if (tailRemaining > 0) {
          tailRemaining -= 1;
          this.tailMuted = Math.max(0, this.tailMuted - 1);
          return true;
        }
        return typeof prevTail === 'function' ? prevTail() : false;
      };
      this.setTimer(() => {
        if (tailRemaining > 0) {
          this.tailMuted = Math.max(0, this.tailMuted - tailRemaining);
          tailRemaining = 0;
        }
      }, AFTER_OWN_KEY_MS);
    };
  }
}

module.exports = { EscStop };
