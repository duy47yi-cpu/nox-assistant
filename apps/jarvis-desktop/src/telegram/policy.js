'use strict';

// Что можно делать удалённо, через Telegram. Решение владельца (JARVIS-REQUIREMENTS D-05): только T0 и T1.
// Инструменты, которые меняют сами сценарии, задачи, миссии и библиотеку, с телефона не запускаются.
// Ввод в окна (ui_*), удаление, отправка и оболочка PowerShell — тоже только с ПК.

const RISK_OK = new Set(['T0', 'T1']);
const BLOCKED = /^(command_|mission_|task_|library_|lib_|ui_|screen_|shell_run$|code_|skill_|browser_|mouse_)|(^|_)(send|delete|remove|publish|post|upload|push|pay|transfer)(_|$)/i;

// true, если инструмент можно выполнить по команде из Telegram.
function remoteAllowed(tool) {
  if (!tool || typeof tool.name !== 'string') return false;
  if (!RISK_OK.has(tool.risk)) return false;
  return !BLOCKED.test(tool.name);
}

// Пояснение владельцу, почему команда не пойдёт с телефона (для ответа в чат).
function remoteRefusal(what) {
  return `«${what}» запускается только с ПК: удалённо доступны только безопасные действия (T0–T1).`;
}

// Кому можно писать: только владельцу, чей chat id задан в настройке. Любая исходящая отправка Telegram проходит здесь.
function mayWriteTo(chatId, ownerChatId) {
  if (!ownerChatId || chatId === undefined || chatId === null) return false;
  return String(chatId) === String(ownerChatId);
}

module.exports = { remoteAllowed, remoteRefusal, mayWriteTo };
