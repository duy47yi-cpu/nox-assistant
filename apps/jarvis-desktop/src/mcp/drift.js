'use strict';

// Отпечаток набора инструментов MCP-сервера (идея Aura): имя, описание и схема аргументов.
// Сервер может обновиться и начать присылать другие описания; описание уходит модели как текст,
// поэтому подмена описания — это фактически чужие указания. Отпечаток позволяет заметить это
// и не регистрировать инструменты, пока владелец не подтвердит изменения.
const crypto = require('crypto');

// Стабильная форма значения: ключи объектов отсортированы, поэтому отпечаток не зависит от их порядка.
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

// Что сервер отдаёт модели, в постоянном порядке: только имя, описание и схема.
function canonicalTools(list) {
  return (Array.isArray(list) ? list : [])
    .filter((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string' && tool.name)
    .map((tool) => ({
      name: tool.name,
      description: String(tool.description || tool.title || ''),
      inputSchema: stableValue(tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// SHA-256 канонического списка: одна строка для сравнения между запусками.
function toolsFingerprint(list) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalTools(list))).digest('hex');
}

// Что изменилось: добавленные, убранные и изменённые инструменты.
// changed содержит только имена и поля, без старых описаний: экран показывает, что менять, а не весь текст.
function toolDiff(previous, current) {
  const before = new Map(canonicalTools(previous).map((tool) => [tool.name, tool]));
  const after = new Map(canonicalTools(current).map((tool) => [tool.name, tool]));
  const added = [...after.keys()].filter((name) => !before.has(name));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const changed = [];
  for (const [name, tool] of after) {
    const old = before.get(name);
    if (!old) continue;
    const fields = [];
    if (old.description !== tool.description) fields.push('description');
    if (JSON.stringify(old.inputSchema) !== JSON.stringify(tool.inputSchema)) fields.push('inputSchema');
    if (fields.length) changed.push({ name, fields });
  }
  return { added, removed, changed };
}

module.exports = { stableValue, canonicalTools, toolsFingerprint, toolDiff };
