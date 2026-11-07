'use strict';

// Шаги редактора команд без DOM: перестановка, текст для «Проверить», предупреждения записи,
// дерево папок и строки разницы при импорте. В окне через window.CmdSteps, в тестах через require.
(function (root) {
  // Меняет местами шаг i и соседний (dir = -1 вверх, 1 вниз). Возвращает новый массив.
  function moveStep(steps, i, dir) {
    const j = i + dir;
    const out = steps.slice();
    if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }

  // Строки «1. Запуск программы: notepad» — что сделает команда, без запуска.
  function describeSteps(steps, titleOf, briefOf) {
    return steps.map((s, i) => {
      const brief = briefOf(s.args);
      return `${i + 1}. ${titleOf(s.tool)}${brief ? ': ' + brief : ''}`;
    });
  }

  // Шаги, которые зависят от конкретного окна или координат. Их повтор после смены окна ненадёжен:
  // в редакторе и при записи показываем предупреждение, а не обещаем точный повтор.
  const COORDINATE_TOOLS = new Set(['desktop_click', 'mouse_click']);
  const TYPING_TOOLS = new Set(['ui_type', 'desktop_type']);

  function stepWarning(step) {
    const tool = String((step && step.tool) || '');
    const args = (step && step.args) || {};
    if (COORDINATE_TOOLS.has(tool) || ('x' in args && 'y' in args)) {
      return 'зависит от координат окна: после смены окна может нажать не туда';
    }
    if (TYPING_TOOLS.has(tool)) return 'ввод текста при записи скрывается: добавьте текст вручную';
    if (tool === 'ui_keys') return 'зависит от активного окна и раскладки клавиатуры';
    return null;
  }

  // Предупреждения по всем шагам с номерами: «2. зависит от координат…».
  function warningsForSteps(steps) {
    const out = [];
    (Array.isArray(steps) ? steps : []).forEach((step, i) => {
      const warning = stepWarning(step);
      if (warning) out.push(`${i + 1}. ${warning}`);
    });
    return out;
  }

  // Названия папок команд: без пустых, без повторов, по алфавиту.
  function foldersOf(commands) {
    const seen = new Set();
    const out = [];
    for (const cmd of Array.isArray(commands) ? commands : []) {
      const folder = cmd && typeof cmd.folder === 'string' ? cmd.folder.trim() : '';
      if (!folder) continue;
      const key = folder.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(folder);
    }
    return out.sort((a, b) => a.localeCompare(b, 'ru'));
  }

  // Дерево для списка: сначала папки по алфавиту, «Без папки» в конце. Порядок внутри — как пришёл.
  function groupCommands(commands) {
    const list = Array.isArray(commands) ? commands : [];
    const groups = new Map();
    for (const cmd of list) {
      const folder = cmd && typeof cmd.folder === 'string' && cmd.folder.trim() ? cmd.folder.trim() : null;
      const key = folder === null ? '' : folder.toLowerCase();
      if (!groups.has(key)) groups.set(key, { folder, title: folder || 'Без папки', commands: [] });
      groups.get(key).commands.push(cmd);
    }
    return [...groups.values()].sort((a, b) => {
      if (a.folder === null) return 1;
      if (b.folder === null) return -1;
      return a.folder.localeCompare(b.folder, 'ru');
    });
  }

  const ACTION_LABELS = { add: 'Добавится', update: 'Изменится', unchanged: 'Без изменений', conflict: 'Конфликт' };

  // Строки предпросмотра импорта: что добавится, что изменится и почему, где конфликты.
  function diffLines(preview) {
    const items = preview && Array.isArray(preview.items) ? preview.items : [];
    return items.map((item) => {
      const action = ACTION_LABELS[item.action] || String(item.action || '');
      let line = `${action}: «${item.name || 'без имени'}»`;
      if (item.action === 'update' && Array.isArray(item.changes) && item.changes.length) {
        line += ' — ' + item.changes.map((c) => c.label || c.field).join(', ');
      }
      if (item.action === 'conflict' && Array.isArray(item.conflicts) && item.conflicts.length) {
        line += ' — ' + item.conflicts.join('; ');
      }
      return line;
    });
  }

  // Короткая сводка предпросмотра для строки над списком.
  function previewCountsLine(preview) {
    const counts = (preview && preview.counts) || {};
    const parts = [
      `Добавится: ${counts.add || 0}`,
      `Изменится: ${counts.update || 0}`,
      `Без изменений: ${counts.unchanged || 0}`,
    ];
    if (counts.conflict) parts.push(`Конфликтов: ${counts.conflict}`);
    return parts.join(' · ');
  }

  // Можно ли применять импорт: конфликты и непрочитанный файл — нет.
  function canApplyImport(preview) {
    return Boolean(preview && preview.applicable === true);
  }

  const api = {
    moveStep,
    describeSteps,
    stepWarning,
    warningsForSteps,
    foldersOf,
    groupCommands,
    diffLines,
    previewCountsLine,
    canApplyImport,
    COORDINATE_TOOLS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CmdSteps = api;
})(typeof window !== 'undefined' ? window : globalThis);
