'use strict';

// Оболочка окна в выпуске одна — Nox Aether (renderer/aether/index.html).
// Прежний классический экран (renderer/index.html) остаётся в дереве только как скрытая
// отладочная опция: он открывается, если разработчик явно запустил приложение с NOX_UI=legacy.
// Настройки владельца на выбор оболочки больше не влияют: переключателя в интерфейсе нет.
function chooseShell(env = process.env) {
  return env && env.NOX_UI === 'legacy' ? 'legacy' : 'aether';
}

module.exports = { chooseShell };
