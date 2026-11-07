'use strict';

// Единый снимок рабочего стола для модели: окно, элементы с устойчивыми id, фокус, изменения.
// Чистые функции без ввода-вывода: сцену собирает инструмент из ответов ui_windows/ui_elements,
// а модуль только приводит её к компактному виду и считает разницу между шагами.
//
// Зачем: модель не должна вызывать ui_windows, ui_elements и screen_look по отдельности и держать
// в голове, что изменилось. Один снимок + дельта дешевле по токенам и понятнее для длинных задач.

const crypto = require('crypto');

const MAX_ELEMENTS = 80;
const MAX_NAME = 120;
const MAX_VALUE = 120;
const MAX_TEXT = 4000;
const MAX_DIFF = 12;
const MAX_URL = 300;

// Роли, с которыми можно взаимодействовать: в подсказке они идут первыми.
const INTERACTIVE = new Set([
  'Button', 'Edit', 'MenuItem', 'ListItem', 'Hyperlink', 'CheckBox', 'RadioButton',
  'ComboBox', 'TabItem', 'TreeItem', 'DataItem', 'Slider', 'Spinner', 'SplitButton',
]);

// Секреты в значениях полей и адресах: не показывать модели и не писать в память.
const SECRET_PAIR = /\b(?:password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi;
const SECRET_TOKEN = /\b(?:sk|pk|ghp|xox[abp])[-_][A-Za-z0-9_-]{12,}\b|\b[A-Za-z0-9_-]{28,}\b/g;

// Обрезка по кодовым точкам: эмодзи не рвётся пополам.
function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text;
}

function redact(value) {
  return String(value ?? '')
    .replace(SECRET_PAIR, (m) => `${m.split(/[:=]/)[0]}=***`)
    .replace(SECRET_TOKEN, '***');
}

function roleOf(element) {
  return clip(element && (element.role || element.type), 40);
}

function nameOf(element) {
  return clip(element && element.name, MAX_NAME);
}

function valueOf(element) {
  return clip(redact(element && element.value), MAX_VALUE);
}

function boundsOf(element) {
  const source = element && (element.bounds || element.rect);
  if (!source || typeof source !== 'object') return null;
  const x = Number(source.x);
  const y = Number(source.y);
  const w = Number(source.w ?? source.width);
  const h = Number(source.h ?? source.height);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function automationIdOf(element) {
  return clip(element && (element.automationId || element.automation_id), 80);
}

// Ключ элемента. AutomationId важнее имени: у поля ввода имя может быть текущим текстом,
// а id остаётся прежним. Одинаковые ключи различаются номером вхождения.
function elementKey(windowTitle, element, occurrence = 1) {
  const aid = automationIdOf(element);
  const base = aid ? `aid:${aid}` : `${roleOf(element)}|${nameOf(element).toLocaleLowerCase()}`;
  return `${clip(windowTitle, 200)}|${base}|${occurrence}`;
}

function elementId(key) {
  return `e${crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 6)}`;
}

// Приводит элемент из ui_elements (или другого источника) к полям снимка.
function normalizeElement(raw) {
  const element = raw && typeof raw === 'object' ? raw : {};
  return {
    id: '',
    role: roleOf(element),
    name: nameOf(element),
    value: valueOf(element),
    enabled: element.enabled === undefined ? true : Boolean(element.enabled),
    bounds: boundsOf(element),
  };
}

function focusOf(scene, focused) {
  if (!focused || typeof focused !== 'object') return null;
  if (focused.id) {
    const hit = scene.elements.find((e) => e.id === focused.id);
    if (hit) return { id: hit.id, role: hit.role, name: hit.name };
  }
  const role = roleOf(focused);
  const name = nameOf(focused);
  const hit = scene.elements.find((e) => e.name === name && (!role || e.role === role));
  return hit ? { id: hit.id, role: hit.role, name: hit.name } : (name ? { id: null, role, name } : null);
}

// Собирает снимок. На вход — окно и элементы (как их отдаёт ui_elements), на выход — компактная сцена.
function buildScene({
  window = null,
  elements = [],
  focused = null,
  url = '',
  screenshot = null,
  clipboard = '',
  at = new Date(),
  limit = MAX_ELEMENTS,
} = {}) {
  const windowTitle = clip(window && window.title, 200);
  const seen = new Map();
  const list = [];
  for (const raw of Array.isArray(elements) ? elements : []) {
    const element = normalizeElement(raw);
    // Элемент без имени и значения бесполезен модели, если у него нет координат. Безымянную кнопку
    // с координатами оставляем: её можно нажать мышью запасным путём.
    if (!element.name && !element.value && !(element.bounds && INTERACTIVE.has(element.role))) continue;
    const aid = automationIdOf(raw);
    const base = aid ? `aid:${aid}` : `${element.role}|${element.name.toLocaleLowerCase()}`;
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    element.id = elementId(String(elementKey(windowTitle, raw, occurrence)));
    // Номер вхождения нужен действиям по id: ui_click/ui_type ищут элемент по подписи и occurrence.
    element.occurrence = occurrence;
    list.push(element);
  }
  const max = Math.max(1, Math.min(MAX_ELEMENTS, Number(limit) || MAX_ELEMENTS));
  const shown = list.slice(0, max);
  const scene = {
    at: new Date(at).toISOString(),
    window: {
      title: windowTitle,
      process: clip(window && window.process, 80),
      handle: window && window.handle !== undefined ? String(window.handle) : '',
    },
    focused: null,
    url: clip(redact(url), MAX_URL),
    screenshot: screenshot ? { width: Number(screenshot.width) || 0, height: Number(screenshot.height) || 0, bytes: Number(screenshot.bytes) || 0 } : null,
    clipboard: clip(redact(clipboard), 300),
    elements: shown,
    total: list.length,
    truncated: list.length > shown.length,
    counts: {
      total: list.length,
      shown: shown.length,
      interactive: shown.filter((e) => INTERACTIVE.has(e.role)).length,
    },
  };
  scene.focused = focusOf(scene, focused);
  scene.text = sceneText(scene);
  return scene;
}

function elementLine(element, withBounds = false) {
  const parts = [`[${element.id}]`, element.role || '?', `«${element.name || 'без имени'}»`];
  if (element.value) parts.push(`= «${element.value}»`);
  if (!element.enabled) parts.push('(недоступен)');
  if (withBounds && element.bounds) {
    const b = element.bounds;
    parts.push(`@${b.x},${b.y},${b.w},${b.h}`);
  }
  return parts.join(' ');
}

// Текст для модели: сначала изменение, потом окно и элементы. Бюджет символов соблюдается.
function sceneText(scene, { maxChars = MAX_TEXT, diff = null } = {}) {
  if (!scene) return '';
  const lines = [];
  if (scene.window && scene.window.title) {
    lines.push(`Окно: «${scene.window.title}»${scene.window.process ? ` (${scene.window.process})` : ''}`);
  }
  if (scene.focused) lines.push(`Фокус: ${scene.focused.role || '?'} «${scene.focused.name || ''}»`);
  if (scene.url) lines.push(`Адрес: ${scene.url}`);
  if (diff && !diff.first && diff.summary) lines.push(`Изменения: ${diff.summary}`);
  if (scene.truncated) lines.push(`Элементы: показано ${scene.counts.shown} из ${scene.total} (сузь filter или limit)`);
  else lines.push(`Элементы: ${scene.counts.total}`);

  const ordered = [...scene.elements].sort((a, b) => {
    const ai = INTERACTIVE.has(a.role) ? 0 : 1;
    const bi = INTERACTIVE.has(b.role) ? 0 : 1;
    return ai - bi;
  });
  let used = lines.join('\n').length;
  let shown = 0;
  for (const element of ordered) {
    const line = elementLine(element, true);
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < ordered.length) lines.push(`… ещё ${ordered.length - shown}`);
  return lines.join('\n');
}

// Разница двух снимков по устойчивым id. Нужна модели, чтобы не перечитывать весь экран.
function diffScene(prev, next) {
  if (!prev || !next) return { first: true, summary: 'первый снимок', added: [], removed: [], changed: [], windowChanged: false, focusChanged: false };
  const before = new Map((prev.elements || []).map((e) => [e.id, e]));
  const after = new Map((next.elements || []).map((e) => [e.id, e]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, element] of after) {
    const old = before.get(id);
    if (!old) {
      added.push({ id, role: element.role, name: element.name });
      continue;
    }
    const fields = [];
    if (old.name !== element.name) fields.push('имя');
    if (old.value !== element.value) fields.push('значение');
    if (old.enabled !== element.enabled) fields.push('доступность');
    if (old.role !== element.role) fields.push('роль');
    if (fields.length) changed.push({ id, role: element.role, name: element.name, fields });
  }
  for (const [id, element] of before) {
    if (!after.has(id)) removed.push({ id, role: element.role, name: element.name });
  }
  const windowChanged = (prev.window && prev.window.title) !== (next.window && next.window.title);
  const prevFocus = prev.focused ? prev.focused.id || prev.focused.name : '';
  const nextFocus = next.focused ? next.focused.id || next.focused.name : '';
  const focusChanged = prevFocus !== nextFocus;
  const parts = [];
  if (windowChanged) parts.push(`окно: «${prev.window && prev.window.title}» → «${next.window && next.window.title}»`);
  if (added.length) parts.push(`появилось ${added.length}`);
  if (removed.length) parts.push(`исчезло ${removed.length}`);
  if (changed.length) parts.push(`изменилось ${changed.length}`);
  if (focusChanged) parts.push('сменился фокус');
  return {
    first: false,
    windowChanged,
    focusChanged,
    added: added.slice(0, MAX_DIFF),
    removed: removed.slice(0, MAX_DIFF),
    changed: changed.slice(0, MAX_DIFF),
    summary: parts.length ? parts.join(', ') : 'без изменений',
  };
}

module.exports = {
  buildScene,
  diffScene,
  sceneText,
  elementLine,
  elementKey,
  elementId,
  normalizeElement,
  redact,
  INTERACTIVE,
  MAX_ELEMENTS,
  MAX_TEXT,
  MAX_DIFF,
};
