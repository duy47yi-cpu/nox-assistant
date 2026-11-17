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
  function describeSteps(steps, titleOf, briefOf, prefix = '') {
    const out = [];
    const list = Array.isArray(steps) ? steps : [];
    list.forEach((s, i) => {
      if (!s) return;
      const num = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      const toolName = s.tool || STEP_TYPE_TO_TOOL[s.type] || s.type || '';
      const stepArgs = (s.args && typeof s.args === 'object') ? s.args : (s.params || {});
      const brief = briefOf(stepArgs, s);
      out.push(`${num}. ${titleOf(toolName)}${brief ? ': ' + brief : ''}`);
      if (Array.isArray(s.children) && s.children.length) {
        out.push(...describeSteps(s.children, titleOf, briefOf, num));
      }
    });
    return out;
  }

  // ── Дерево шагов редактора (Phase 2) ─────────────────────────────
  const STEP_TYPE_TO_TOOL = {
    app_start: 'app_open',
    hotkey: 'ui_keys',
    click: 'ui_click',
    volume: 'volume_set',
    type_text: 'ui_type',
    wait: 'wait',
    ai: 'speak',
    shell: 'shell_run',
  };

  const TOOL_TO_STEP_TYPE = {
    app_open: 'app_start',
    ui_keys: 'hotkey',
    ui_click: 'click',
    desktop_click: 'click',
    mouse_click: 'click',
    volume_set: 'volume',
    ui_type: 'type_text',
    desktop_type: 'type_text',
    wait: 'wait',
    speak: 'ai',
    url_open: 'app_start',
    shell_run: 'shell',
  };

  // ── Пауза: контракт инструмента wait — миллисекунды в ms (0…10000) ───────
  // Инструмент wait принимает только ms; запись в секундах он отвергает («пауза от 0 до 10000 мс»).
  // Новые шаги создаём сразу в миллисекундах, а старые команды переводим при загрузке.
  const WAIT_MAX_MS = 10000;
  const DEFAULT_WAIT_MS = 1000;

  function waitMsFromSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.min(WAIT_MAX_MS, Math.round(seconds * 1000));
  }

  // Новые параметры паузы с ms вместо секунд; null — переводить нечего (или это не пауза).
  function migrateWaitParams(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    if (!Object.prototype.hasOwnProperty.call(params, 'seconds')) return null;
    const { seconds, ...rest } = params;
    const explicitMs = Number(rest.ms);
    const ms = rest.ms !== undefined && Number.isFinite(explicitMs) ? explicitMs : waitMsFromSeconds(seconds);
    return { ...rest, ms };
  }

  // Параметры нового шага: пауза сразу в миллисекундах, другие типы — как раньше.
  function defaultStepParams(type, argKey = 'text') {
    if (type === 'volume') return { percent: 50 };
    if (type === 'wait') return { ms: DEFAULT_WAIT_MS };
    if (type === 'hotkey') return { keys: 'Ctrl+S' };
    return { [argKey || 'text']: '' };
  }

  // Приводит params и args паузы к миллисекундам: обе копии должны совпадать,
  // потому что runner читает args, а редактор показывает params.
  function waitStepArgs(type, tool, params, args) {
    if (type !== 'wait' && tool !== 'wait') return { params, args };
    let nextParams = migrateWaitParams(params) || params;
    let nextArgs = migrateWaitParams(args) || args;
    if (nextParams.ms === undefined && nextArgs.ms !== undefined) nextParams = { ...nextParams, ms: nextArgs.ms };
    if (nextArgs.ms === undefined && nextParams.ms !== undefined) nextArgs = { ...nextArgs, ms: nextParams.ms };
    return { params: nextParams, args: nextArgs };
  }

  function makeStepId(existingIds, hint = 'step') {
    let idx = 1;
    while (existingIds.has(`${hint}-${idx}`)) idx += 1;
    const id = `${hint}-${idx}`;
    existingIds.add(id);
    return id;
  }

  function cloneStepNode(node) {
    if (!node || typeof node !== 'object') return null;
    return {
      ...node,
      params: node.params && typeof node.params === 'object' ? { ...node.params } : {},
      args: node.args && typeof node.args === 'object' ? { ...node.args } : {},
      children: Array.isArray(node.children) ? node.children.map(cloneStepNode).filter(Boolean) : [],
    };
  }

  function normalizeStepTree(steps, usedIds = new Set()) {
    const list = Array.isArray(steps) ? steps : [];
    return list.map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
      if (!id || usedIds.has(id)) id = makeStepId(usedIds);
      else usedIds.add(id);
      const tool = typeof raw.tool === 'string' && raw.tool.trim()
        ? raw.tool.trim()
        : (STEP_TYPE_TO_TOOL[raw.type] || 'wait');
      const type = typeof raw.type === 'string' && raw.type.trim()
        ? raw.type.trim()
        : (TOOL_TO_STEP_TYPE[tool] || 'wait');
      const rawArgs = raw.args && typeof raw.args === 'object'
        ? { ...raw.args }
        : (raw.params && typeof raw.params === 'object' ? { ...raw.params } : {});
      const rawParams = raw.params && typeof raw.params === 'object'
        ? { ...raw.params }
        : { ...rawArgs };
      // Старая пауза в секундах переводится в миллисекунды; остальные шаги не трогаем.
      const { params, args } = waitStepArgs(type, tool, rawParams, rawArgs);
      return {
        ...raw,
        id,
        type,
        tool,
        params,
        args,
        children: normalizeStepTree(raw.children, usedIds),
      };
    }).filter(Boolean);
  }

  function countTreeSteps(steps) {
    let count = 0;
    for (const s of Array.isArray(steps) ? steps : []) {
      if (!s) continue;
      count += 1;
      if (Array.isArray(s.children) && s.children.length) {
        count += countTreeSteps(s.children);
      }
    }
    return count;
  }

  function flattenTreeForRender(steps, collapsedIds = new Set(), parentPath = [], prefixNum = '') {
    const out = [];
    const list = Array.isArray(steps) ? steps : [];
    list.forEach((node, idx) => {
      if (!node) return;
      const path = [...parentPath, idx];
      const children = Array.isArray(node.children) ? node.children : [];
      const hasChildren = children.length > 0;
      const collapsed = hasChildren && collapsedIds instanceof Set && collapsedIds.has(node.id);
      const labelIndex = prefixNum ? `${prefixNum}.${idx + 1}` : `${idx + 1}`;
      out.push({
        node,
        path,
        depth: parentPath.length,
        parentPath: parentPath.slice(),
        indexInParent: idx,
        siblingCount: list.length,
        hasChildren,
        collapsed,
        labelIndex,
      });
      if (hasChildren && !collapsed) {
        out.push(...flattenTreeForRender(children, collapsedIds, path, labelIndex));
      }
    });
    return out;
  }

  function getNodeAtPath(steps, path) {
    if (!Array.isArray(path) || path.length === 0) return null;
    let list = Array.isArray(steps) ? steps : [];
    let current = null;
    for (let i = 0; i < path.length; i += 1) {
      const idx = path[i];
      if (!Array.isArray(list) || idx < 0 || idx >= list.length) return null;
      current = list[idx];
      list = current && Array.isArray(current.children) ? current.children : [];
    }
    return current;
  }

  function cloneTree(steps) {
    return (Array.isArray(steps) ? steps : []).map(cloneStepNode).filter(Boolean);
  }

  function listAtParentPath(tree, parentPath) {
    if (!Array.isArray(parentPath) || parentPath.length === 0) return tree;
    const parent = getNodeAtPath(tree, parentPath);
    if (!parent) return null;
    if (!Array.isArray(parent.children)) parent.children = [];
    return parent.children;
  }

  function insertTreeNode(steps, parentPath, index, newNode) {
    const tree = cloneTree(steps);
    const pPath = Array.isArray(parentPath) ? parentPath : [];
    const list = listAtParentPath(tree, pPath);
    if (!list) return tree;
    const clampedIdx = typeof index === 'number' && Number.isInteger(index)
      ? Math.max(0, Math.min(list.length, index))
      : list.length;
    const nodeClone = cloneStepNode(newNode);
    if (!nodeClone) return tree;
    list.splice(clampedIdx, 0, nodeClone);
    return tree;
  }

  function updateTreeNode(steps, path, updater) {
    if (!Array.isArray(path) || path.length === 0) return cloneTree(steps);
    const tree = cloneTree(steps);
    const parentPath = path.slice(0, -1);
    const idx = path[path.length - 1];
    const list = listAtParentPath(tree, parentPath);
    if (!list || idx < 0 || idx >= list.length) return tree;
    const prev = list[idx];
    const next = typeof updater === 'function'
      ? updater(cloneStepNode(prev))
      : { ...prev, ...updater };
    if (next) list[idx] = cloneStepNode(next);
    return tree;
  }

  function deleteTreeNode(steps, path) {
    if (!Array.isArray(path) || path.length === 0) return cloneTree(steps);
    const tree = cloneTree(steps);
    const parentPath = path.slice(0, -1);
    const idx = path[path.length - 1];
    const list = listAtParentPath(tree, parentPath);
    if (!list || idx < 0 || idx >= list.length) return tree;
    list.splice(idx, 1);
    return tree;
  }

  function moveTreeNode(steps, path, dir) {
    if (!Array.isArray(path) || path.length === 0) return { steps: cloneTree(steps), path };
    const tree = cloneTree(steps);
    const parentPath = path.slice(0, -1);
    const idx = path[path.length - 1];
    const list = listAtParentPath(tree, parentPath);
    const targetIdx = idx + dir;
    if (!list || idx < 0 || idx >= list.length || targetIdx < 0 || targetIdx >= list.length) {
      return { steps: tree, path: path.slice() };
    }
    const [moved] = list.splice(idx, 1);
    list.splice(targetIdx, 0, moved);
    return { steps: tree, path: [...parentPath, targetIdx] };
  }

  function indentTreeNode(steps, path) {
    if (!Array.isArray(path) || path.length === 0) return { steps: cloneTree(steps), path };
    const tree = cloneTree(steps);
    const parentPath = path.slice(0, -1);
    const idx = path[path.length - 1];
    const list = listAtParentPath(tree, parentPath);
    if (!list || idx <= 0 || idx >= list.length) return { steps: tree, path: path.slice() };
    const [moved] = list.splice(idx, 1);
    const newParent = list[idx - 1];
    if (!Array.isArray(newParent.children)) newParent.children = [];
    newParent.children.push(moved);
    return { steps: tree, path: [...parentPath, idx - 1, newParent.children.length - 1] };
  }

  function outdentTreeNode(steps, path) {
    if (!Array.isArray(path) || path.length < 2) return { steps: cloneTree(steps), path: Array.isArray(path) ? path.slice() : [] };
    const tree = cloneTree(steps);
    const parentPath = path.slice(0, -1);
    const grandParentPath = parentPath.slice(0, -1);
    const idx = path[path.length - 1];
    const parentIdx = parentPath[parentPath.length - 1];
    const childrenList = listAtParentPath(tree, parentPath);
    const grandList = listAtParentPath(tree, grandParentPath);
    if (!childrenList || !grandList || idx < 0 || idx >= childrenList.length) {
      return { steps: tree, path: path.slice() };
    }
    const [moved] = childrenList.splice(idx, 1);
    const insertIdx = parentIdx + 1;
    grandList.splice(insertIdx, 0, moved);
    return { steps: tree, path: [...grandParentPath, insertIdx] };
  }

  function isPathPrefix(prefix, candidate) {
    if (prefix.length > candidate.length) return false;
    return prefix.every((val, i) => candidate[i] === val);
  }

  function moveTreeNodeTo(steps, fromPath, toParentPath, toIndex) {
    if (!Array.isArray(fromPath) || fromPath.length === 0) return { steps: cloneTree(steps), path: fromPath };
    const targetParent = Array.isArray(toParentPath) ? toParentPath : [];
    // Нельзя перенести узел в самого себя или в своего потомка.
    if (isPathPrefix(fromPath, targetParent)) {
      return { steps: cloneTree(steps), path: fromPath.slice() };
    }
    const tree = cloneTree(steps);
    const fromParentPath = fromPath.slice(0, -1);
    const fromIdx = fromPath[fromPath.length - 1];
    const sourceList = listAtParentPath(tree, fromParentPath);
    if (!sourceList || fromIdx < 0 || fromIdx >= sourceList.length) {
      return { steps: tree, path: fromPath.slice() };
    }

    // Корректируем целевой путь, если предок целевого пути шёл после удаляемого брата.
    const adjustedParent = targetParent.slice();
    if (adjustedParent.length > fromParentPath.length
      && isPathPrefix(fromParentPath, adjustedParent)
      && adjustedParent[fromParentPath.length] > fromIdx) {
      adjustedParent[fromParentPath.length] -= 1;
    }

    const [moved] = sourceList.splice(fromIdx, 1);
    const destList = listAtParentPath(tree, adjustedParent);
    if (!destList) return { steps: cloneTree(steps), path: fromPath.slice() };

    let insertIdx = typeof toIndex === 'number' && Number.isInteger(toIndex) ? toIndex : destList.length;
    if (fromParentPath.length === adjustedParent.length
      && isPathPrefix(fromParentPath, adjustedParent)
      && insertIdx > fromIdx) {
      insertIdx -= 1;
    }
    insertIdx = Math.max(0, Math.min(destList.length, insertIdx));
    destList.splice(insertIdx, 0, moved);
    return { steps: tree, path: [...adjustedParent, insertIdx] };
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

  // ── Единый экран способов запуска и журнал запусков ────────────────────
  const TRIGGER_KIND_LABELS = {
    hotkey: 'Клавиша',
    schedule: 'Расписание',
    event: 'Событие',
    manual: 'Вручную',
    phrase: 'По фразе',
  };

  const TRIGGER_STATUS_LABELS = {
    started: 'Выполняется',
    succeeded: 'Выполнена',
    partial: 'Частично',
    skipped: 'Пропущена',
    failed: 'Ошибка',
    cancelled: 'Отменена',
    blocked: 'Заблокирована',
    interrupted: 'Прервана',
  };

  const TRIGGER_STATUS_TONES = {
    started: 'live',
    succeeded: 'ok',
    partial: 'warn',
    skipped: 'muted',
    failed: 'bad',
    cancelled: 'warn',
    blocked: 'bad',
    interrupted: 'warn',
  };

  const TRIGGER_EVENT_OPTIONS = [
    { type: 'app:startup', label: 'Запуск ассистента' },
    { type: 'system:unlock', label: 'Разблокировка экрана' },
    { type: 'system:lock', label: 'Блокировка экрана' },
    { type: 'system:resume', label: 'Выход из сна' },
    { type: 'system:suspend', label: 'Перед уходом в сон' },
    { type: 'workspace:inbox_added', label: 'Новый файл во входящих' },
    { type: 'app:hung', label: 'Зависшая программа' },
    { type: 'user:custom', label: 'Своё событие' },
  ];

  const TRIGGER_WEEKDAYS = [
    { value: 1, short: 'пн', label: 'Понедельник' },
    { value: 2, short: 'вт', label: 'Вторник' },
    { value: 3, short: 'ср', label: 'Среда' },
    { value: 4, short: 'чт', label: 'Четверг' },
    { value: 5, short: 'пт', label: 'Пятница' },
    { value: 6, short: 'сб', label: 'Суббота' },
    { value: 7, short: 'вс', label: 'Воскресенье' },
  ];

  function normalizeTriggersModel(rawTriggers, fallbackHotkey) {
    const raw = rawTriggers && typeof rawTriggers === 'object' ? rawTriggers : {};
    const rawHt = raw.hotkey && typeof raw.hotkey === 'object' ? raw.hotkey : {};
    const rawSch = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};
    const rawEv = raw.event && typeof raw.event === 'object' ? raw.event : {};
    const key = typeof rawHt.key === 'string' && rawHt.key.trim()
      ? rawHt.key.trim()
      : (typeof fallbackHotkey === 'string' && fallbackHotkey.trim() ? fallbackHotkey.trim() : null);
    const scheduleType = ['interval', 'daily', 'weekdays', 'weekly'].includes(rawSch.type) ? rawSch.type : 'interval';
    const eventType = typeof rawEv.eventType === 'string' && rawEv.eventType.trim() ? rawEv.eventType.trim() : null;
    return {
      hotkey: {
        enabled: rawHt.enabled !== undefined ? Boolean(rawHt.enabled && key) : Boolean(key),
        key,
        cooldownMs: Number.isInteger(rawHt.cooldownMs) && rawHt.cooldownMs >= 0 ? rawHt.cooldownMs : 0,
      },
      schedule: {
        enabled: Boolean(rawSch.enabled),
        type: scheduleType,
        minutes: Number.isInteger(rawSch.minutes) && rawSch.minutes >= 1 ? rawSch.minutes : 60,
        at: typeof rawSch.at === 'string' && rawSch.at.trim() ? rawSch.at.trim() : '09:00',
        weekday: Number.isInteger(rawSch.weekday) && rawSch.weekday >= 1 && rawSch.weekday <= 7 ? rawSch.weekday : 1,
        timeZone: typeof rawSch.timeZone === 'string' && rawSch.timeZone.trim() ? rawSch.timeZone.trim() : null,
      },
      event: {
        enabled: Boolean(rawEv.enabled),
        eventType,
        eventName: typeof rawEv.eventName === 'string' && rawEv.eventName.trim() ? rawEv.eventName.trim() : null,
        match: typeof rawEv.match === 'string' && rawEv.match.trim() ? rawEv.match.trim() : null,
        cooldownSec: Number.isInteger(rawEv.cooldownSec) && rawEv.cooldownSec >= 0 ? rawEv.cooldownSec : 5,
      },
    };
  }

  function formatScheduleShort(schedule) {
    if (!schedule) return 'не настроено';
    if (schedule.type === 'interval') return `каждые ${schedule.minutes || 60} мин`;
    if (schedule.type === 'weekdays') return `будни ${schedule.at || '09:00'}`;
    if (schedule.type === 'weekly') {
      const wd = TRIGGER_WEEKDAYS.find((d) => d.value === schedule.weekday);
      return `по ${wd ? wd.short : schedule.weekday} в ${schedule.at || '09:00'}`;
    }
    return `ежедневно ${schedule.at || '09:00'}`;
  }

  function formatEventShort(event) {
    if (!event || !event.eventType) return 'не выбрано';
    if (event.eventType === 'user:custom') {
      return event.eventName ? `своё «${event.eventName}»` : 'своё событие';
    }
    const found = TRIGGER_EVENT_OPTIONS.find((item) => item.type === event.eventType);
    return found ? found.label : event.eventType;
  }

  function describeTriggerMethod(kind, triggerConfig, fallbackHotkey) {
    const model = normalizeTriggersModel(
      triggerConfig && triggerConfig.hotkey !== undefined && triggerConfig.schedule !== undefined
        ? triggerConfig
        : { [kind]: triggerConfig },
      fallbackHotkey,
    );
    if (kind === 'hotkey') {
      const ht = model.hotkey;
      return {
        kind: 'hotkey',
        title: 'Клавиша',
        enabled: ht.enabled,
        text: ht.key || 'Не назначена',
        active: Boolean(ht.enabled && ht.key),
      };
    }
    if (kind === 'schedule') {
      const sch = model.schedule;
      return {
        kind: 'schedule',
        title: 'Время',
        enabled: sch.enabled,
        text: sch.enabled ? formatScheduleShort(sch) : (sch.at || sch.minutes ? `${formatScheduleShort(sch)} (выкл)` : 'Выключено'),
        active: Boolean(sch.enabled),
      };
    }
    const ev = model.event;
    const baseText = formatEventShort(ev);
    const fullText = ev.eventType && ev.match ? `${baseText} [${ev.match}]` : baseText;
    return {
      kind: 'event',
      title: 'Событие',
      enabled: ev.enabled,
      text: ev.enabled ? fullText : (ev.eventType ? `${fullText} (выкл)` : 'Выключено'),
      active: Boolean(ev.enabled && ev.eventType),
    };
  }

  function triggersBadges(cmd) {
    const triggers = normalizeTriggersModel(cmd && cmd.triggers, cmd && cmd.hotkey);
    return [
      describeTriggerMethod('hotkey', triggers),
      describeTriggerMethod('schedule', triggers),
      describeTriggerMethod('event', triggers),
    ];
  }

  function validateTriggersDraft(rawTriggers, existingCommands, editingId) {
    const errors = [];
    const raw = rawTriggers && typeof rawTriggers === 'object' ? rawTriggers : {};
    const ht = raw.hotkey && typeof raw.hotkey === 'object' ? raw.hotkey : {};
    if (ht.enabled) {
      const key = typeof ht.key === 'string' ? ht.key.trim() : '';
      if (!key) {
        errors.push('Укажите сочетание клавиш или отключите запуск по клавише.');
      } else {
        const parts = key.split('+').map((p) => p.trim()).filter(Boolean);
        if (parts.length < 2) errors.push('Горячая клавиша должна содержать модификатор и клавишу.');
        const conflict = (Array.isArray(existingCommands) ? existingCommands : []).find((c) => {
          if (!c || c.id === editingId) return false;
          const otherKey = (c.triggers && c.triggers.hotkey && c.triggers.hotkey.enabled && c.triggers.hotkey.key) || c.hotkey;
          return otherKey && otherKey.toUpperCase() === key.toUpperCase();
        });
        if (conflict) errors.push(`Клавиша ${key} уже занята командой «${conflict.name}».`);
      }
    }
    const sch = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};
    if (sch.enabled) {
      if (sch.type === 'interval') {
        const min = Number(sch.minutes);
        if (!Number.isInteger(min) || min < 1 || min > 10080) {
          errors.push('Интервал расписания должен быть целым числом от 1 до 10080 минут.');
        }
      } else {
        const at = typeof sch.at === 'string' ? sch.at.trim() : '';
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
          errors.push('Время расписания укажите в формате ЧЧ:ММ, например 09:00.');
        }
      }
    }
    const ev = raw.event && typeof raw.event === 'object' ? raw.event : {};
    if (ev.enabled) {
      if (!ev.eventType) errors.push('Выберите событие для автоматического запуска.');
      if (ev.eventType === 'user:custom' && (!ev.eventName || !String(ev.eventName).trim())) {
        errors.push('Введите имя пользовательского события.');
      }
      const cd = ev.cooldownSec !== undefined && ev.cooldownSec !== null ? Number(ev.cooldownSec) : 5;
      if (!Number.isInteger(cd) || cd < 0 || cd > 86400) {
        errors.push('Пауза между срабатываниями должна быть от 0 до 86400 секунд.');
      }
    }
    return errors;
  }

  function formatLaunchLogRow(entry) {
    const item = entry && typeof entry === 'object' ? entry : {};
    const status = String(item.status || 'failed');
    const trigger = String(item.trigger || 'manual');
    const durationMs = typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) ? item.durationMs : null;
    const stepsTotal = Number.isInteger(item.stepsTotal) ? item.stepsTotal : 0;
    const stepsOk = Number.isInteger(item.stepsOk) ? item.stepsOk : 0;
    return {
      id: item.id || null,
      ts: item.ts || null,
      commandId: item.commandId || null,
      commandName: item.commandName || 'Без имени',
      trigger,
      triggerLabel: TRIGGER_KIND_LABELS[trigger] || trigger,
      triggerDetail: item.triggerDetail || '',
      status,
      statusLabel: TRIGGER_STATUS_LABELS[status] || status,
      statusTone: TRIGGER_STATUS_TONES[status] || 'muted',
      reason: item.reason || item.error || '',
      durationText: durationMs !== null ? (durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)} с` : `${durationMs} мс`) : '—',
      stepsText: stepsTotal > 0 ? `${stepsOk}/${stepsTotal}` : '—',
    };
  }

  function filterLaunchLog(entries, { commandId = null, trigger = null, status = null, query = '' } = {}) {
    const cid = commandId && commandId !== 'all' ? commandId : null;
    const trg = trigger && trigger !== 'all' ? trigger : null;
    const st = status && status !== 'all' ? status : null;
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    return (Array.isArray(entries) ? entries : [])
      .filter((entry) => {
        if (!entry) return false;
        if (cid && entry.commandId !== cid) return false;
        if (trg && entry.trigger !== trg) return false;
        if (st && entry.status !== st) return false;
        if (q) {
          const haystack = `${entry.commandName || ''} ${entry.triggerDetail || ''} ${entry.reason || ''} ${entry.error || ''}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .map(formatLaunchLogRow);
  }

  function buildLaunchMatrix(commands, logEntries) {
    const list = Array.isArray(commands) ? commands : [];
    const logs = Array.isArray(logEntries) ? logEntries : [];
    const countsByCommand = new Map();
    let recentProblems = 0;
    for (const entry of logs) {
      if (!entry) continue;
      if (entry.commandId) {
        countsByCommand.set(entry.commandId, (countsByCommand.get(entry.commandId) || 0) + 1);
      }
      if (entry.status === 'failed' || entry.status === 'blocked') recentProblems += 1;
    }

    let withHotkey = 0;
    let withSchedule = 0;
    let withEvent = 0;
    const rows = list.map((cmd) => {
      const triggers = normalizeTriggersModel(cmd && cmd.triggers, cmd && cmd.hotkey);
      const st = (cmd && cmd.triggerState && typeof cmd.triggerState === 'object') ? cmd.triggerState : {};
      const hk = describeTriggerMethod('hotkey', triggers);
      const sch = describeTriggerMethod('schedule', triggers);
      const ev = describeTriggerMethod('event', triggers);
      if (hk.active) withHotkey += 1;
      if (sch.active) withSchedule += 1;
      if (ev.active) withEvent += 1;
      const lastStatus = st.lastStatus || null;
      return {
        id: cmd.id,
        name: cmd.name || 'Без имени',
        commandEnabled: cmd.enabled !== false,
        folder: cmd.folder || null,
        stepsCount: Array.isArray(cmd.steps) ? countTreeSteps(cmd.steps) : (Number(cmd.stepsCount) || 0),
        triggers,
        hotkey: hk,
        schedule: sch,
        event: ev,
        activeCount: Number(hk.active) + Number(sch.active) + Number(ev.active),
        running: st.status === 'running',
        nextRunAt: sch.active ? (st.nextRunAt || null) : null,
        lastTrigger: st.lastTrigger || null,
        lastTriggerLabel: st.lastTrigger ? (TRIGGER_KIND_LABELS[st.lastTrigger] || st.lastTrigger) : null,
        lastTriggeredAt: st.lastTriggeredAt || cmd.lastRunAt || null,
        lastStatus,
        lastStatusLabel: lastStatus ? (TRIGGER_STATUS_LABELS[lastStatus] || lastStatus) : 'Не запускалась',
        lastStatusTone: lastStatus ? (TRIGGER_STATUS_TONES[lastStatus] || 'muted') : 'muted',
        lastReason: st.lastReason || null,
        logCount: countsByCommand.get(cmd.id) || 0,
      };
    });

    return {
      rows,
      summary: {
        totalCommands: rows.length,
        withHotkey,
        withSchedule,
        withEvent,
        recentProblems,
      },
    };
  }

  const api = {
    moveStep,
    describeSteps,
    stepWarning,
    warningsForSteps,
    STEP_TYPE_TO_TOOL,
    TOOL_TO_STEP_TYPE,
    WAIT_MAX_MS,
    DEFAULT_WAIT_MS,
    defaultStepParams,
    migrateWaitParams,
    waitStepArgs,
    normalizeStepTree,
    countTreeSteps,
    flattenTreeForRender,
    getNodeAtPath,
    insertTreeNode,
    updateTreeNode,
    deleteTreeNode,
    moveTreeNode,
    indentTreeNode,
    outdentTreeNode,
    moveTreeNodeTo,
    foldersOf,
    groupCommands,
    diffLines,
    previewCountsLine,
    canApplyImport,
    COORDINATE_TOOLS,
    TRIGGER_KIND_LABELS,
    TRIGGER_STATUS_LABELS,
    TRIGGER_STATUS_TONES,
    TRIGGER_EVENT_OPTIONS,
    TRIGGER_WEEKDAYS,
    normalizeTriggersModel,
    formatScheduleShort,
    formatEventShort,
    describeTriggerMethod,
    triggersBadges,
    validateTriggersDraft,
    formatLaunchLogRow,
    filterLaunchLog,
    buildLaunchMatrix,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CmdSteps = api;
})(typeof window !== 'undefined' ? window : globalThis);
