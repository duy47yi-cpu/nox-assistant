'use strict';

// Уменьшение движения: настройка Nox «Анимации» и настройка Windows «Уменьшение движения».
// Правило: Windows главнее, когда «Анимации» включены; выключены — окно стоит всегда,
// даже если в Windows движение разрешено. Поэтому окну никогда не навязывается
// no-preference: только reduce или ничего.

// Значение prefers-reduced-motion, которое просим у окна, или '' — не вмешиваться.
function emulatedReducedMotion(motion) {
  return motion === false ? 'reduce' : '';
}

// Аргумент Emulation.setEmulatedMedia: пустой список снимает подмену и возвращает
// настоящую настройку Windows.
function emulatedMotionFeatures(motion) {
  const value = emulatedReducedMotion(motion);
  return value ? [{ name: 'prefers-reduced-motion', value }] : [];
}

// Итог: движется ли что-нибудь в окне. systemReduce — настройка Windows.
function motionAllowed(motion, systemReduce) {
  return motion !== false && systemReduce !== true;
}

module.exports = { emulatedReducedMotion, emulatedMotionFeatures, motionAllowed };
