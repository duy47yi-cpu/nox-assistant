'use strict';

// Заражение контекста: после текста со страницы, экрана, файла или чужого сервера модель может
// принять чужие указания за просьбу владельца. Тогда исходящие действия в «Полном доступе»
// спрашиваем, а не выполняем молча. Это не запрет: владелец подтверждает, если так и задумано.
const TAINT_SOURCES = new Set([
  'web_search', 'web_wiki', 'web_fetch', 'web_research', 'agents_parallel',
  'browser_open', 'browser_read',
  'screen_look', 'screen_region_look', 'desktop_observe', 'ui_elements', 'image_read_text', 'image_look',
  'workspace_read', 'workspace_search', 'document_read', 'code_read', 'clipboard_get',
  'project_brief', 'project_diagnostics', 'mail_unread',
]);

// Действия, которыми можно вынести данные наружу или запустить чужой код.
const EGRESS_TOOLS = new Set([
  'mail_send', 'shell_run', 'browser_type', 'browser_open', 'url_open', 'clipboard_set',
]);

// Действия руками: клики, ввод и клавиши могут выполнить чужие указания из прочитанного
// текста (например, нажать «Отправить» в чужом окне). После чужого текста они идут с вопросом,
// а в фоне без владельца — отклоняются. Прокрутка сюда не входит: она ничего не меняет.
const HAND_ACTIONS = new Set([
  'desktop_click', 'desktop_type',
  'ui_click', 'ui_type', 'ui_keys', 'ui_set_toggle',
  'mouse_click', 'browser_click',
]);

// Снимки собственного экрана — тоже недоверенный текст для исходящих действий, но для рук
// пометку «чужой текст» не ставят: иначе каждое нажатие после обязательного desktop_observe
// спрашивало бы и руки встали бы. Руки спрашиваются только после текстовых источников ниже.
const SCENE_SOURCES = new Set(['screen_look', 'screen_region_look', 'desktop_observe', 'ui_elements']);

// source — метка инструмента: mcp-инструменты приходят с чужого сервера, их ответы тоже недоверенные.
function isTaintSource(name, source) {
  if (source === 'mcp') return true;
  return TAINT_SOURCES.has(String(name || ''));
}

// Чужой текст (страница, файл, буфер, чужой сервер), после которого руки идут с вопросом.
// Снимки экрана сюда не входят (см. SCENE_SOURCES выше).
function isForeignTextSource(name, source) {
  if (source === 'mcp') return true;
  if (!TAINT_SOURCES.has(String(name || ''))) return false;
  return !SCENE_SOURCES.has(String(name || ''));
}

function isEgress(name) {
  return EGRESS_TOOLS.has(String(name || ''));
}

function isHandsAction(name) {
  return HAND_ACTIONS.has(String(name || ''));
}

module.exports = { TAINT_SOURCES, EGRESS_TOOLS, HAND_ACTIONS, SCENE_SOURCES, isTaintSource, isForeignTextSource, isEgress, isHandsAction };
