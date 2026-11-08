// Сценарии по фразе из чата: модель создаёт команду по описанию владельца, а фраза потом запускает её без модели.
// Проверки: имена инструментов известны исполнителю команд, фразы не заняты, команды не вызывают команды и фоновые задачи.
// План отделён от сохранения: создание с dryRun: true только показывает редактируемый план, без dryRun сохраняет.
const { FORBIDDEN_PREFIXES } = require('../commands/runner');
const { DANGEROUS_TOOLS, EDITOR_STEP_TOOLS } = require('../commands/store');
const { buildCommandFromText, dryRunCommand } = require('../commands/builder');

const MAX_NAME = 60;
const MAX_STEPS_CHAT = 10;

const badStepTool = (tool) => DANGEROUS_TOOLS.has(tool) || FORBIDDEN_PREFIXES.some((p) => tool.startsWith(p));

// knownTools() — Set имён инструментов, которые исполнитель команд умеет запускать. Может вернуть Set, массив или Map.
function knownOf(source) {
  const value = typeof source === 'function' ? source() : source;
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map((item) => (typeof item === 'string' ? item : item && item.name)).filter(Boolean));
  if (value && typeof value.keys === 'function') return new Set([...value.keys()]);
  return new Set();
}

// Описания инструментов (name, risk, parameters) для проверки аргументов плана. Без них проверяются имена и типы шагов.
function defsOf(source) {
  const value = typeof source === 'function' ? source() : source;
  const list = Array.isArray(value) ? value : value && typeof value.values === 'function' ? [...value.values()] : [];
  const map = new Map();
  for (const def of list) {
    if (def && typeof def.name === 'string') map.set(def.name, def);
  }
  return map;
}

const typeOf = (spec) => (Array.isArray(spec && spec.type) ? spec.type.find((t) => t !== 'null') || 'null' : spec && spec.type);

// Проверка одного аргумента по описанию параметра инструмента: тип, диапазон, длина, допустимые значения.
// Возвращает ошибки (мешают сохранить) и предупреждения (неизвестное поле).
function checkArgValue(tool, key, value, spec, n, errors, warnings) {
  const where = `шаг ${n}: «${key}»`;
  if (!spec || typeof spec !== 'object') return;
  const type = typeOf(spec);
  if (Array.isArray(spec.enum) && spec.enum.length) {
    const ok = spec.enum.some((option) => String(option) === String(value));
    if (!ok) errors.push(`${where} — одно из: ${spec.enum.join(', ')}`);
    return;
  }
  if (type === 'string') {
    if (typeof value !== 'string') { errors.push(`${where} — нужна строка`); return; }
    if (typeof spec.minLength === 'number' && Array.from(value).length < spec.minLength) errors.push(`${where} короче ${spec.minLength} символов`);
    if (typeof spec.maxLength === 'number' && Array.from(value).length > spec.maxLength) errors.push(`${where} длиннее ${spec.maxLength} символов`);
    return;
  }
  if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(type === 'integer' ? `${where} — нужно целое число` : `${where} — нужно число`); return; }
    if (type === 'integer' && !Number.isInteger(value)) { errors.push(`${where} — нужно целое число`); return; }
    if (typeof spec.minimum === 'number' && value < spec.minimum) errors.push(`${where} — не меньше ${spec.minimum}`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) errors.push(`${where} — не больше ${spec.maximum}`);
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${where} — нужно true или false`);
    return;
  }
  if (type === 'array' && !Array.isArray(value)) errors.push(`${where} — нужен массив`);
  if (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) errors.push(`${where} — нужен объект`);
}

// Проверка шагов плана: известность инструмента, запрещённые действия и (если есть описания) аргументы.
function checkPlanSteps(steps, known, defs, { maxSteps = MAX_STEPS_CHAT } = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push('нужен хотя бы один шаг');
    return { steps: [], errors, warnings };
  }
  if (steps.length > maxSteps) errors.push(`шагов не больше ${maxSteps}`);
  const clean = steps.map((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`шаг ${n}: нужен объект {tool, args}`);
      return { tool: '', args: {} };
    }
    const tool = typeof raw.tool === 'string' ? raw.tool.trim() : '';
    const args = raw.args === undefined ? {} : raw.args;
    if (!tool) errors.push(`шаг ${n}: нужно имя инструмента`);
    else if (!known.has(tool)) errors.push(`шаг ${n}: нет инструмента «${tool}»`);
    else if (badStepTool(tool)) errors.push(`шаг ${n}: «${tool}» нельзя запускать из сценария`);
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      errors.push(`шаг ${n}: args должен быть объектом`);
      return { tool, args: {} };
    }
    if (tool && known.has(tool) && !badStepTool(tool) && defs.has(tool)) {
      const parameters = defs.get(tool).parameters || {};
      const props = parameters.properties || {};
      const required = Array.isArray(parameters.required) ? parameters.required : [];
      for (const key of required) {
        const value = args[key];
        if (value === undefined || value === null || value === '') errors.push(`шаг ${n}: «${key}» — обязательное поле`);
      }
      for (const [key, value] of Object.entries(args)) {
        if (!(key in props)) {
          warnings.push(`шаг ${n}: «${key}» не описан у «${tool}»`);
          continue;
        }
        checkArgValue(tool, key, value, props[key], n, errors, warnings);
      }
    }
    return { tool, args: { ...args } };
  });
  return { steps: clean, errors, warnings };
}

// Горячая клавиша: зарегистрирована ли клавиша в системе. Без проверки состояние unknown.
function hotkeyStateOf(cmd, hotkeyActive) {
  if (!cmd.hotkey || !cmd.enabled) return 'off';
  if (!hotkeyActive) return 'unknown';
  return hotkeyActive(cmd.hotkey) ? 'active' : 'busy';
}

// knownTools() — Set имён инструментов, которые исполнитель команд умеет запускать.
// hotkeyActive(key) — зарегистрирована ли клавиша в системе. Без него регистрацию проверить нечем.
// toolDefs() — описания инструментов (необязательно): без них план проверяет имена, но не аргументы.
// modelCall(prompt) — один вызов модели для сборки сценария из описания словами (необязательно).
function commandModelTools(store, knownTools, { onChange = () => {}, hotkeyActive = null, toolDefs = null, modelCall = null } = {}) {
  // Что с клавишей сценария: 'off' (клавиши нет или сценарий выключен), 'active', 'busy' или 'unknown'.
  const hotkeyState = (cmd) => hotkeyStateOf(cmd, hotkeyActive);
  const known = () => knownOf(knownTools);
  const defs = () => defsOf(toolDefs);

  const create = {
    name: 'command_create',
    description: 'Создать сценарий по фразе: имя, фразы-триггеры и шаги {tool, args} по порядку. Инструменты — только из списка, который есть у ассистента. С dryRun: true только показывает план: ничего не сохраняет и не запускает, владелец его правит. Без dryRun сохраняет и всё равно ничего не запускает. Фраза потом запускает шаги без модели.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: MAX_NAME },
        phrases: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 80 } },
        hotkey: { type: 'string', maxLength: 40, description: 'Необязательная горячая клавиша, например Ctrl+Alt+Y' },
        folder: { type: 'string', maxLength: 60, description: 'Необязательная папка в дереве сценариев' },
        dryRun: { type: 'boolean', description: 'true — только показать редактируемый план, не сохранять' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_STEPS_CHAT,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              args: { type: 'object' },
            },
            required: ['tool'],
          },
        },
      },
      required: ['name', 'phrases', 'steps'],
    },
    async run(args) {
      const name = String(args.name || '').trim();
      if (!name) return { ok: false, summary: 'нужно имя сценария', data: {} };
      const checked = checkPlanSteps(args.steps, known(), defs());
      if (checked.errors.length) return { ok: false, summary: checked.errors.join('; '), data: { errors: checked.errors } };
      const planData = { name, phrases: args.phrases, steps: checked.steps, hotkey: args.hotkey || null, folder: args.folder || null };
      // Создание из текста: сначала план, который владелец видит и правит; сохранение — отдельным вызовом.
      if (args.dryRun === true) {
        const notes = checked.warnings.length ? ` Замечания: ${checked.warnings.join('; ')}.` : '';
        return {
          ok: true,
          summary: `План «${name}» из ${planData.steps.length} шагов готов, не сохранён и не запущен.${notes}`,
          data: { plan: planData, warnings: checked.warnings, saved: false },
        };
      }
      try {
        const saved = store.save({
          name,
          phrases: args.phrases,
          steps: checked.steps,
          enabled: true,
          hotkey: args.hotkey,
          folder: args.folder,
          origin: 'ai',
        });
        onChange();
        const note = checked.warnings.length ? ` (${checked.warnings.join('; ')})` : '';
        return {
          ok: true,
          summary: `сценарий «${saved.name}» создан: ${saved.phrases.join(' | ')}${note}`,
          data: { id: saved.id, steps: saved.steps.length, saved: true },
        };
      } catch (err) {
        return { ok: false, summary: err.message, data: {} };
      }
    },
    async verify(args, result) {
      if (result.data.saved === false) return { status: 'confirmed', evidence: 'план показан, файл команд не менялся и запуска не было' };
      const saved = store.get(result.data.id);
      if (!saved) return { status: 'failed', evidence: 'сценария нет в файле' };
      if (hotkeyState(saved) === 'busy') return { status: 'unknown', evidence: `сценарий сохранён, но клавиша ${saved.hotkey} занята другим приложением` };
      return { status: 'confirmed', evidence: 'сценарий есть в файле' };
    },
  };

  const list = {
    name: 'command_list',
    description: 'Список сценариев по фразе: имена, фразы и число шагов. С withParameters: true — какие действия и параметры можно ставить в сценарий (только настоящие инструменты реестра команд).',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        withParameters: { type: 'boolean', description: 'true — показать каталог доступных действий с параметрами' },
      },
    },
    async run(args) {
      // Каталог действий: модель видит, что реально можно поставить в сценарий, и не выдумывает шаги.
      if (args && args.withParameters === true) {
        const names = known();
        const defsMap = defs();
        const listNames = [...names].filter((name) => !badStepTool(name)).sort((a, b) => a.localeCompare(b, 'en'));
        const actions = listNames.map((name) => {
          const def = defsMap.get(name);
          return {
            name,
            editable: EDITOR_STEP_TOOLS.includes(name),
            risk: def && def.risk ? def.risk : null,
            description: def && typeof def.description === 'string' ? def.description : '',
            parameters: def && def.parameters ? def.parameters : null,
          };
        });
        const summary = actions.length
          ? `Действий для сценариев: ${actions.length}. В редакторе окна доступны ${EDITOR_STEP_TOOLS.length}, остальные — через текст или импорт.`
          : 'Список действий пуст: реестр команд не передан.';
        return { ok: true, summary, data: { actions, editorTools: EDITOR_STEP_TOOLS.slice() } };
      }
      const items = store.list();
      if (items.length === 0) return { ok: true, summary: 'сценариев пока нет', data: { items: [] } };
      const summary = items.map((c) => `${c.name} (${c.phrases.join(' | ')})`).join('; ');
      return {
        ok: true,
        summary,
        data: {
          items: items.map((c) => ({
            name: c.name,
            phrases: c.phrases,
            steps: c.steps.length,
            enabled: c.enabled !== false,
            hotkey: c.hotkey || null,
            folder: c.folder || null,
            origin: c.origin || 'manual',
          })),
        },
      };
    },
  };

  const setHotkey = {
    name: 'command_set_hotkey',
    description: 'Повесить горячую клавишу на существующий сценарий или снять её (hotkey: null). Например Ctrl+Alt+Y.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: MAX_NAME },
        hotkey: { type: ['string', 'null'], maxLength: 40 },
      },
      required: ['name', 'hotkey'],
    },
    async run(args) {
      const target = store.list().find((c) => c.name.toLowerCase() === String(args.name || '').trim().toLowerCase());
      if (!target) return { ok: false, summary: `сценарий «${args.name}» не найден`, data: {} };
      try {
        const saved = store.save({ ...target, hotkey: args.hotkey ?? null });
        onChange();
        // Занятую клавишу не оставляем в сценарии: иначе в окне она есть, а не работает.
        if (hotkeyState(saved) === 'busy') {
          store.save(target);
          onChange();
          return { ok: false, summary: `клавиша ${saved.hotkey} занята другим приложением, оставил прежнюю настройку`, data: {} };
        }
        return { ok: true, summary: saved.hotkey ? `«${saved.name}»: ${saved.hotkey}` : `у «${saved.name}» горячей клавиши нет`, data: { id: saved.id, hotkey: saved.hotkey } };
      } catch (err) {
        return { ok: false, summary: err.message, data: {} };
      }
    },
    async verify(args, result) {
      const saved = store.get(result.data.id);
      if (!saved || saved.hotkey !== result.data.hotkey) return { status: 'failed', evidence: 'в файле другая клавиша' };
      if (hotkeyState(saved) === 'unknown') return { status: 'unknown', evidence: 'клавиша сохранена, регистрацию в системе проверить нечем' };
      return { status: 'confirmed', evidence: saved.hotkey ? (saved.enabled ? `клавиша ${saved.hotkey} зарегистрирована` : `клавиша ${saved.hotkey} сохранена, заработает после включения сценария`) : 'клавиша снята' };
    },
  };

  const build = {
    name: 'command_build',
    description: 'Собрать сценарий по описанию владельца словами: вернуть готовый план (имя, фразы, шаги) или уточняющие вопросы. С dryRun по умолчанию только показывает план и ничего не сохраняет и не запускает; с dryRun: false сохраняет. Инструменты — только из настоящего реестра команд, опасные запрещены.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 5, maxLength: 2000, description: 'Что должен делать сценарий, словами владельца' },
        dryRun: { type: 'boolean', description: 'false — сохранить собранный сценарий; по умолчанию только план' },
      },
      required: ['text'],
    },
    async run(args) {
      const text = String(args.text || '').trim();
      if (!text) return { ok: false, summary: 'нужно описание сценария словами', data: {} };
      if (typeof modelCall !== 'function') return { ok: false, summary: 'сборка сценариев недоступна в этой сборке', data: {} };
      let built;
      try {
        built = await buildCommandFromText({ text, modelCall, tools: known() });
      } catch (err) {
        return { ok: false, summary: `сборка сценария не удалась: ${err.message}`, data: {} };
      }
      if (!built || built.ok !== true) {
        const questions = built && Array.isArray(built.questions) ? built.questions : [];
        const why = built && built.error ? built.error : 'не удалось собрать сценарий';
        return { ok: false, summary: why, data: { questions, attempts: built && built.attempts ? built.attempts : 0 } };
      }
      const command = built.command;
      const view = dryRunCommand(command, { tools: known() });
      if (args.dryRun === false) {
        try {
          const saved = store.save(command);
          onChange();
          return {
            ok: true,
            summary: `сценарий «${saved.name}» собран и сохранён: ${saved.phrases.join(' | ')}`,
            data: { id: saved.id, plan: command, saved: true, attempts: built.attempts || 0 },
          };
        } catch (err) {
          return { ok: false, summary: err.message, data: { plan: command, saved: false } };
        }
      }
      return {
        ok: true,
        summary: `План «${command.name}» из ${command.steps.length} шагов готов, не сохранён и не запущен. ${view.text}`,
        data: { plan: command, questions: built.questions || [], warnings: view.warnings || [], saved: false, attempts: built.attempts || 0 },
      };
    },
    async verify(args, result) {
      if (!result || !result.data || result.data.saved !== true) return { status: 'confirmed', evidence: 'план показан, файл команд не менялся и запуска не было' };
      const saved = store.get(result.data.id);
      if (!saved) return { status: 'failed', evidence: 'сценария нет в файле' };
      return { status: 'confirmed', evidence: 'сценарий есть в файле' };
    },
  };

  // Порядок прежних инструментов не меняем: внешние вызовы и тесты берут их по позиции.
  return [create, list, setHotkey, build];
}

module.exports = { commandModelTools, checkPlanSteps, knownOf, defsOf };