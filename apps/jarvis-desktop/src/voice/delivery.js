'use strict';

// Как доставить ответ (идея JARVIS-OS): очевидный успех видимого действия — текстом без голоса,
// ошибка — всегда голосом, обычный ответ — как раньше. Чистая функция без Electron и сети.
const SELF_EVIDENT = Object.freeze([
  'app_open', 'app_close',
  'windows_list', 'windows_focus', 'windows_snap', 'windows_close_all', 'window_close_active',
  'windows_minimize_all', 'windows_restore_all', 'windows_arrange',
  'ui_click', 'ui_type', 'ui_keys', 'ui_focus', 'ui_wait',
  'desktop_click', 'desktop_type', 'desktop_observe',
  'browser_', 'media_control', 'volume_set', 'mouse_click', 'mouse_scroll',
]);

// Видимое действие: его результат владелец и так видит на экране.
function selfEvident(name) {
  const tool = String(name || '');
  return SELF_EVIDENT.some((item) => (item.endsWith('_') ? tool.startsWith(item) : tool === item));
}

// mode: silent — ничего; brief — только строка в окне (результат виден); full — текст и голос.
// Ошибку и отказ не скрываем никогда: молчание об ошибке хуже лишней фразы.
function classifyDelivery({ text = '', tools = [], failed = false, terse = false } = {}) {
  const clean = String(text || '').trim();
  if (failed) return { mode: 'full', reason: 'ошибка всегда слышна' };
  if (!clean) return { mode: 'silent', reason: 'ответа нет' };
  if (!terse) return { mode: 'full', reason: 'настройка «тише» выключена' };
  const names = (Array.isArray(tools) ? tools : []).filter(Boolean);
  if (names.length > 0 && names.every(selfEvident)) {
    return { mode: 'brief', reason: 'результат виден на экране' };
  }
  return { mode: 'full', reason: 'в ответе есть пояснение или чтение' };
}

module.exports = { classifyDelivery, selfEvident, SELF_EVIDENT };
