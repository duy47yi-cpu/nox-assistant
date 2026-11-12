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
    skipped: 'Пропущена',
    failed: 'Ошибка',
    cancelled: 'Отменена',
    blocked: 'Заблокирована',
    interrupted: 'Прервана',
  };

  const TRIGGER_STATUS_TONES = {
    started: 'live',
    succeeded: 'ok',
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
        stepsCount: Array.isArray(cmd.steps) ? cmd.steps.length : (Number(cmd.stepsCount) || 0),
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
