'use strict';

// Инструменты «глаза и руки по id»: один снимок рабочего стола, нажатие и ввод по устойчивому id.
// Собираются из уже существующих ui_windows/ui_elements/ui_click/ui_type, поэтому не трогают их PowerShell,
// политику и проверки. Снимок экрана сюда не входит: screen_look остаётся отдельным и спрашивает разрешение по режиму.
const { buildScene, diffScene, sceneText, sceneSignature, expectMet } = require('../perception/scene');
const { isPayment, isDeletion, isInstall, isPowerOff, describe, hardDeny, setSceneSource, CREDENTIAL_WINDOW_RE } = require('../policy/modes');

const MAX_WINDOW = 120;
const MAX_FILTER = 120;
const MAX_LIMIT = 60;
const MAX_TEXT = 2000;
const ID_RE = /^e[0-9a-f]{12}$/;
// Пауза после действия: интерфейс успевает перерисоваться, дельта становится осмысленной.
const SETTLE_MS = 80;
// «В текущий фокус» без id: снимок сцены должен быть свежим, иначе фокус мог уйти (A-6, E-4).
const INPUT_SCENE_TTL_MS = 2000;
// Пауза между повторными чтениями окна после нажатия, если изменений ещё нет.
const PATIENCE_MS = 250;
// Сколько действий подряд без изменений на экране считаем застоем: дальше вслепую не действуем.
const STALL_LIMIT = 3;
// Типы, среди которых ui_type ищет поле: его номер вхождения считается только по ним.
const FIELD_KINDS = new Set(['Edit', 'Document', 'ComboBox']);

// Селектор для ui_*. AutomationId точно ищет и сам PowerShell-скрипт (ui.js, Find-JTarget),
// поэтому он главный. Имя + номер по сцене и имя + номер в ui_* считаются по-разному —
// без AutomationId действуем, только если подпись в окне единственная (A-2).
function selectorOf(scene, element, kinds = null) {
  const list = scene && Array.isArray(scene.elements) ? scene.elements : [];
  const aid = String((element && element.automationId) || '');
  const roleOk = (e) => !kinds || kinds.has(e.role);
  if (aid) {
    return list.filter((e) => String(e.automationId || '') === aid && roleOk(e)).length === 1
      ? { name: aid, occurrence: 0 }
      : null;
  }
  const name = String((element && element.name) || '');
  if (!name) return null;
  const lower = name.toLocaleLowerCase();
  const same = list.filter((e) => String(e.name || '').toLocaleLowerCase() === lower && roleOk(e));
  return same.length === 1 ? { name, occurrence: 0 } : null;
}

function strArg(value, { label, max, min = 0 } = {}) {
  if (value === undefined || value === null || value === '') return { value: '' };
  if (typeof value !== 'string') return { error: `${label}: нужна строка` };
  const text = value.trim();
  if (text.length < min || text.length > max) return { error: `${label}: от ${min} до ${max} символов` };
  return { value: text };
}

// Все подходящие окна: точные совпадения важнее частичных. Одно окно — ответ, два — отказ (A-3).
function findWindows(windows, want) {
  const list = (Array.isArray(windows) ? windows : []).filter((w) => w && w.title);
  const needle = String(want || '').trim().toLocaleLowerCase();
  if (!needle) return list.slice(0, 1);
  const exact = list.filter((w) => String(w.title).trim().toLocaleLowerCase() === needle);
  if (exact.length) return exact;
  return list.filter((w) => String(w.title).toLocaleLowerCase().includes(needle));
}

function findWindow(windows, want) {
  const hits = findWindows(windows, want);
  return hits.length === 1 ? hits[0] : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ui — массив инструментов из uiTools(). Функция отдельная, чтобы тесты подставляли свои ответы.
function observeTools(ui = [], { mouse = [] } = {}) {
  const windowsTool = ui.find((t) => t && t.name === 'ui_windows');
  const elementsTool = ui.find((t) => t && t.name === 'ui_elements');
  const clickTool = ui.find((t) => t && t.name === 'ui_click');
  const typeTool = ui.find((t) => t && t.name === 'ui_type');
  const mouseClick = (Array.isArray(mouse) ? mouse : []).find((t) => t && t.name === 'mouse_click');
  if (!windowsTool || !elementsTool) throw new Error('desktop_observe: нужны ui_windows и ui_elements');

  // Последняя сцена — для дельты и для действий по id. Одна на инструмент: сцена рабочего стола общая.
  let last = null;
  setSceneSource(() => last);
  // Счётчик действий подряд, после которых экран не изменился (застой),
  // и подпись прошлой сцены: по ней видно, менялся ли экран между действиями.
  let stalls = 0;
  let lastSignature = null;
  // Заголовок окна, выскочившего поверх после действия: пока его не прочитали, по старым id не действуем.
  let surprise = '';
  // filter и limit последнего наблюдения: перечитывание перед действием должно видеть тот же набор
  // элементов, иначе id из сцены не найдётся в перечитанном окне (A-2).
  let lastFilter = '';
  let lastLimit = MAX_LIMIT;

  // Читает окно и элементы, собирает сцену. Ничего не запоминает: это делают вызывающие.
  async function capture({ window: want = '', filter = '', limit = MAX_LIMIT } = {}, ctx = {}) {
    const windows = await windowsTool.run({}, ctx);
    if (!windows || !windows.ok) return { error: (windows && windows.summary) || 'окна не прочитаны' };
    const list = (windows.data && windows.data.windows) || [];
    if (!list.length) return { error: 'окон с заголовком нет' };
    const hits = findWindows(list, want);
    const chosen = hits.length === 1 ? hits[0] : null;
    if (!chosen) {
      if (hits.length > 1) {
        return {
          error: 'под заголовок «' + want + '» подходят ' + hits.length + ' окна: ' + hits.map((x) => '«' + x.title + '»').join(', ') + '. Уточни заголовок целиком или закрой лишнее окно',
          ambiguous: true,
        };
      }
      if (/^(?:nox(?:\s+assistant)?|джарвис|nox\s*[—–-]\s*джарвис)$/i.test(String(want || '').trim())) {
        return {
          error: `окно «${want}» принадлежит самому Nox (Джарвису): управлять собственным окном и читать его элементы нельзя`,
          windows: list.map((x) => x.title).slice(0, 20),
        };
      }
      return { error: `окно «${want}» не найдено`, windows: list.map((x) => x.title).slice(0, 20) };
    }
    // Пароли не читаем никогда, даже чтобы «просто посмотреть»: в окне менеджера они на виду.
    // Окно банка читать можно (нужно для «покажи баланс»), но действовать в нём запрещает политика (hardDeny).
    if (CREDENTIAL_WINDOW_RE.test(String(chosen.title || ''))) {
      return {
        error: `окно «${chosen.title}» не читаю: это менеджер паролей, там пароли и ключи`,
        sensitive: true,
        windows: list.map((x) => x.title).slice(0, 20),
      };
    }
    const elements = await elementsTool.run({ window: chosen.title, filter: filter || undefined, limit }, ctx);
    if (!elements || !elements.ok) return { error: (elements && elements.summary) || 'элементы не прочитаны' };
    const scene = buildScene({
      window: chosen,
      elements: (elements.data && elements.data.elements) || [],
      at: new Date(),
      limit,
    });
    scene.total = Number(elements.data && elements.data.total) || scene.total;
    scene.truncated = Boolean(elements.data && elements.data.truncated) || scene.total > scene.elements.length;
    return { scene, window: chosen, front: list.find((x) => x && x.active === true) || null };
  }

  // Перечитывает текущее состояние окна и находит элемент по id. Если id пропал — действие не выполняется.
  async function resolve(id, ctx) {
    if (!last) return { error: 'сначала сделай desktop_observe: действие по id требует текущего снимка' };
    if (surprise) return { error: `поверх появилось окно «${surprise}»: сначала прочитай его — desktop_observe с window «${surprise}»` };
    const current = await capture({ window: last.window.title, filter: lastFilter, limit: lastLimit }, ctx);
    if (current.error) return { error: current.error };
    // Заголовок один и тот же у разных экземпляров: без сверки handle действие уходит в чужое окно (A-3).
    if (String(current.window.handle || '') !== String(last.window.handle || '')) {
      return { error: 'то же название, но другое окно (другой handle): сделай новый desktop_observe и проверь, что это нужный экземпляр' };
    }
    if (current.scene.window.title !== last.window.title) return { error: 'окно сменилось; сделай новый desktop_observe' };
    const element = current.scene.elements.find((e) => e.id === id);
    if (!element) return { error: `элемент ${id} исчез или изменился; сделай новый desktop_observe` };
    return { scene: current.scene, element };
  }

  // Снимок после действия: что изменилось. Ошибка чтения не отменяет уже выполненное действие.
  // patience — сколько раз перечитать окно, если изменений пока не видно (медленный отклик программы).
  async function after(scene, ctx, patience = 0) {
    let current = await capture({ window: scene.window.title, filter: lastFilter, limit: lastLimit }, ctx);
    for (let i = 0; i < patience && !current.error && sceneSignature(current.scene) === sceneSignature(scene); i += 1) {
      await delay(PATIENCE_MS);
      current = await capture({ window: scene.window.title, filter: lastFilter, limit: lastLimit }, ctx);
    }
    if (current.error) {
      return { scene: null, diff: null, note: `состояние после действия не прочитано: ${current.error}`, stalled: false, stalls };
    }
    last = current.scene;
    // Неожиданное окно: после действия сверху оказалось другое окно той же программы (диалог, вопрос, ошибка).
    const front = current.front;
    surprise = front && front.handle !== current.window.handle && front.process === current.window.process ? String(front.title || 'без названия') : '';
    const diff = diffScene(scene, current.scene);
    // Застой: экран после действия не изменился. Подряд несколько раз — дальше вслепую не действуем.
    const signature = sceneSignature(current.scene);
    if (!diff.first && lastSignature !== null && lastSignature === signature) stalls += 1;
    else stalls = 0;
    lastSignature = signature;
    const stalled = stalls >= STALL_LIMIT;
    current.scene.text = sceneText(current.scene, { diff });
    const note = stalled
      ? `состояние не меняется: ${stalls} действия подряд без изменений — не повторяй, скажи владельцу`
      : '';
    return { scene: current.scene, diff, note, stalled, stalls, surprise };
  }

  // Хвост ответа действия: застой важнее обычной дельты, иначе модель не заметит предупреждение.
  function tailOf(state) {
    if (state.surprise) return `; поверх появилось окно «${state.surprise}» — следующим шагом прочитай его: desktop_observe с window «${state.surprise}»`;
    if (state.stalled) return `; ${state.note}`;
    if (state.diff) return `; ${state.diff.summary}`;
    return `; ${state.note}`;
  }

  const desktopObserve = {
    name: 'desktop_observe',
    description: 'Один снимок рабочего стола: активное окно, фокус, элементы с устойчивыми id, изменения с прошлого вызова. Начинай сложное действие с него; дальше нажимай и вводи по id (desktop_click, desktop_type) или по имени (ui_click, ui_type).',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', minLength: 1, maxLength: MAX_WINDOW, description: 'часть заголовка окна; без него — верхнее окно' },
        filter: { type: 'string', maxLength: MAX_FILTER, description: 'часть имени или роли: Button, Edit, «Сохранить»' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 60 },
      },
    },
    async run(args = {}, ctx = {}) {
      const w = strArg(args.window, { label: 'window', min: 1, max: MAX_WINDOW });
      if (w.error) return { ok: false, summary: w.error, data: {} };
      const f = strArg(args.filter, { label: 'filter', max: MAX_FILTER });
      if (f.error) return { ok: false, summary: f.error, data: {} };
      const rawLimit = args.limit === undefined ? 60 : Number(args.limit);
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) return { ok: false, summary: `limit: от 1 до ${MAX_LIMIT}`, data: {} };

      const current = await capture({ window: w.value, filter: f.value, limit: rawLimit }, ctx);
      const scene = current.scene;
      if (!scene) return { ok: false, summary: current.error, data: current.windows ? { windows: current.windows } : {} };
      const diff = diffScene(last, scene);
      last = scene;
      lastFilter = f.value;
      lastLimit = rawLimit;
      surprise = '';
      // Новый снимок — осознанная проверка экрана: счётчик застоя начинается заново.
      stalls = 0;
      lastSignature = sceneSignature(scene);
      scene.text = sceneText(scene, { diff });
      const tail = diff.first ? '' : `; ${diff.summary}`;
      return {
        ok: true,
        summary: `окно «${scene.window.title}»: элементов ${scene.elements.length}${tail}`,
        data: { scene, diff },
      };
    },
    // Снимок — чтение настоящего состояния: проверять нечего, evidence — сам снимок.
    async verify(args, result) {
      if (!result || !result.ok) return { status: 'failed', evidence: 'снимок не получен' };
      return { status: 'confirmed', evidence: `сцена: ${result.summary}` };
    },
  };

  const tools = [desktopObserve];

  if (clickTool || mouseClick) {
    tools.push({
      name: 'desktop_click',
      description: 'Нажать элемент по id из desktop_observe. Перед нажатием перечитывает окно и проверяет, что элемент ещё тот; после — снимает изменения. Если id исчез, откажет и попросит новый снимок. expect — что должно появиться после нажатия (название окна, кнопки или надпись): по нему подтверждается результат, указывай всегда, когда знаешь.',
      risk: 'T1',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', pattern: '^e[0-9a-f]{12}$' }, expect: { type: 'string', maxLength: 120 } },
        required: ['id'],
      },
      async run(args = {}, ctx = {}) {
        const id = String(args.id || '').trim();
        if (!ID_RE.test(id)) return { ok: false, summary: 'id: возьми из desktop_observe, например e12ab34cdef01', data: {} };
        const found = await resolve(id, ctx);
        if (found.error) return { ok: false, summary: found.error, data: {} };
        const { scene, element } = found;
        // Кнопку по имени политика режима проверяет сама (её аргументы — имя и окно).
        // desktop_click видит только id, поэтому такие проверки повторяем здесь по найденному имени.
        const byName = { name: 'ui_click', args: { name: element.name, window: scene.window.title } };
        if (isPayment(byName)) {
          return { ok: false, summary: 'оплату выполняет владелец самостоятельно', data: {} };
        }
        // Жёсткие запреты окон (почта, мессенджеры, банки) политика проверяет по имени инструмента и окну.
        // desktop_click видит только id, поэтому проверяем здесь: иначе он обошёл бы запрет ui_click.
        const denied = hardDeny(byName);
        if (denied) return { ok: false, summary: denied, data: {} };
        // Удаление, установка и выключение в «Полном доступе» спрашиваются, если владелец не просил прямо.
        // Это решение принимает политика по имени элемента — до desktop_click с одним id оно не доходит.
        if (element.name && (isDeletion(byName) || isInstall(byName) || isPowerOff(byName))) {
          const reason = describe(byName) || 'такое действие решает режим доступа';
          return {
            ok: false,
            summary: `${reason}: кнопку «${element.name}» через desktop_click не нажимаю; нажми её через ui_click — он спросит подтверждение`,
            data: {},
          };
        }
        const center = element.bounds
          ? { x: Math.round(element.bounds.x + element.bounds.w / 2), y: Math.round(element.bounds.y + element.bounds.h / 2) }
          : null;
        let action = null;
        let fallback = false;
        const selector = selectorOf(scene, element);
        // Подпись есть, но она не одна и AutomationId нет: нажимать «по номеру» нельзя — номер в сцене
        // и в ui_* считается по-разному (A-2). Честный отказ вместо нажатия не той кнопки.
        if (!selector && element.name) {
          return { ok: false, summary: 'подпись «' + element.name + '» в окне не одна, а устойчивого AutomationId нет: нажми через ui_click с occurrence или сузь filter в desktop_observe', data: {} };
        }
        // Первое действие начинается, только если есть устойчивый селектор и есть чем нажимать по имени.
        // Если оно началось и не дало успеха, повторять мышью по координатам нельзя: действие могло сработать.
        const started = Boolean(selector && clickTool);
        if (started) {
          action = await clickTool.run({ window: scene.window.title, name: selector.name, occurrence: selector.occurrence }, { ...ctx, quickCheck: true });
          if (!action || action.ok !== true) {
            // Пустой ответ вложенного инструмента — тоже неизвестный исход: мышью не повторяем.
            return action || { ok: false, summary: 'ui_click не вернул ответ: исход нажатия неизвестен, мышью не повторяю', data: {} };
          }
        }
        // Запасной путь: только когда нажатие по имени не начинали (безымянный элемент или нет ui_click) —
        // жмём мышью в центр координат.
        // Координаты из UI Automation в настоящих пикселях, поэтому units=physical.
        if (!started && center && mouseClick) {
          action = await mouseClick.run({ window: scene.window.title, x: center.x, y: center.y, button: 'left', units: 'physical' }, ctx);
          fallback = true;
        }
        if (!action || !action.ok) {
          if (!element.name && !mouseClick) return { ok: false, summary: `у элемента ${id} нет подписи, а mouse_click недоступен; сделай новый desktop_observe`, data: {} };
          return action || { ok: false, summary: 'нажатие не выполнено', data: {} };
        }
        await delay(SETTLE_MS);
        const state = await after(scene, ctx, 2);
        const tail = tailOf(state);
        return {
          ok: true,
          summary: fallback ? `нажал по координатам ${center.x}, ${center.y}${tail}` : `нажал «${element.name}»${tail}`,
          data: {
            element, action, fallback, coords: fallback ? center : null,
            scene: state.scene, diff: state.diff, afterNote: state.note,
            stalled: state.stalled === true, stalls: state.stalls || 0,
          },
        };
      },
      async verify(args, result) {
        if (!result || !result.ok) return { status: 'failed', evidence: 'нажатие не выполнено' };
        const data = result.data || {};
        // Застой важнее любой локальной проверки: если экран не меняется, повторять вслепую нельзя.
        if (data.stalled) return { status: 'unknown', evidence: `экран не меняется: ${data.stalls} действия подряд без изменений — нужно решение владельца` };
        if (!data.fallback && data.action && clickTool && typeof clickTool.verify === 'function' && data.element) {
          const verdict = await clickTool.verify({ name: data.element.name }, data.action);
          // Жёсткий приоритет: failed не смягчается до unknown и не заменяется ожиданием (B-3).
          if (verdict && verdict.status === 'failed') return verdict;
          if (verdict && verdict.status === 'confirmed') return verdict;
          // Названное заранее ожидание сбылось — это подтверждение. Просто «что-то изменилось» им не считается.
          // Кнопки с внешним эффектом (отправить, опубликовать, купить) так не подтверждаются: надпись на экране не доказывает доставку.
          const outward = /отправ|опублик|разместит|купит|оплат|заказат|send|submit|publish|post|pay|buy|order/i.test(data.element.name || '');
          const met = outward ? null : expectMet(args && args.expect, data.diff, data.scene);
          if (met) return { status: 'confirmed', evidence: `ожидание сбылось: ${met}` };
          if (verdict) return { status: 'unknown', evidence: verdict.evidence || 'результат нажатия не подтверждён' };
        }
        // Мышь по координатам не подтверждается ничем: доставку не проверить (B-2).
        // Эффект доказывается отдельным шагом чтения с названным ожиданием.
        return {
          status: 'unknown',
          evidence: data.fallback
            ? 'нажатие мышью по координатам: доставка не проверяется, нужен отдельный шаг чтения'
            : 'нажатие прошло, но изменение экрана не подтверждено',
        };
      },
    });
  }

  if (typeTool) {
    tools.push({
      name: 'desktop_type',
      description: 'Ввести текст по id поля из desktop_observe (или в текущий фокус окна, если id не указан). Перед вводом перечитывает окно; после — снимает изменения. Enter не нажимает — для этого ui_keys.',
      risk: 'T1',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^e[0-9a-f]{12}$' },
          text: { type: 'string', minLength: 1, maxLength: MAX_TEXT },
        },
        required: ['text'],
      },
      async run(args = {}, ctx = {}) {
        if (typeof args.text !== 'string' || !args.text.trim()) return { ok: false, summary: 'text: нужен непустой текст', data: {} };
        if (args.text.length > MAX_TEXT) return { ok: false, summary: `текст длиннее ${MAX_TEXT} символов`, data: {} };
        let windowTitle;
        let element = null;
        let sceneBefore = last;
        if (args.id !== undefined) {
          const id = String(args.id).trim();
          if (!ID_RE.test(id)) return { ok: false, summary: 'id: возьми из desktop_observe, например e12ab34cdef01', data: {} };
          const found = await resolve(id, ctx);
          if (found.error) return { ok: false, summary: found.error, data: {} };
          windowTitle = found.scene.window.title;
          element = found.element;
          sceneBefore = found.scene;
        } else {
          if (!last) return { ok: false, summary: 'сначала сделай desktop_observe', data: {} };
          // «В текущий фокус» без id: сцена должна быть свежей, иначе фокус мог уйти (A-6, E-4).
          const age = Date.now() - Date.parse(last.at || 0);
          if (!(age >= 0) || age > INPUT_SCENE_TTL_MS) {
            return { ok: false, summary: 'ввод без id: снимок сцены устарел — сделай новый desktop_observe и укажи id поля', data: {} };
          }
          windowTitle = last.window.title;
        }
        // Жёсткий запрет окон (почта, мессенджеры, банки) действует и на составной ввод:
        // политика проверяет его по имени ui_type и окну, а desktop_type иначе обошёл бы запрет.
        const deniedType = hardDeny({ name: 'ui_type', args: { window: windowTitle } });
        if (deniedType) return { ok: false, summary: deniedType, data: {} };
        const selector = element ? selectorOf(sceneBefore, element, FIELD_KINDS) : null;
        if (element && !selector) {
          return { ok: false, summary: 'поле «' + element.name + '» в окне не одно, а устойчивого AutomationId нет: уточни поле через ui_type с occurrence', data: {} };
        }
        const action = await typeTool.run({
          window: windowTitle,
          name: selector ? selector.name : undefined,
          occurrence: selector ? selector.occurrence : undefined,
          text: args.text,
        }, ctx);
        if (!action || !action.ok) return action || { ok: false, summary: 'ввод не выполнен', data: {} };
        await delay(SETTLE_MS);
        const state = await after(sceneBefore, ctx);
        const tail = tailOf(state);
        return {
          ok: true,
          summary: `ввёл ${args.text.length} симв.${element ? ` в «${element.name}»` : ''}${tail}`,
          data: {
            element, action, scene: state.scene, diff: state.diff, afterNote: state.note,
            stalled: state.stalled === true, stalls: state.stalls || 0,
          },
        };
      },
      async verify(args, result) {
        if (!result || !result.ok) return { status: 'failed', evidence: 'ввод не выполнен' };
        const data = result.data || {};
        if (data.stalled) return { status: 'unknown', evidence: `экран не меняется: ${data.stalls} действия подряд без изменений — нужно решение владельца` };
        if (data.action && typeof typeTool.verify === 'function') {
          const verdict = await typeTool.verify({ text: args.text }, data.action);
          // Жёсткий приоритет: другой текст в поле — failed, а не unknown (B-3).
          if (verdict && verdict.status === 'failed') return verdict;
          if (verdict && verdict.status === 'confirmed') return verdict;
          if (verdict) return { status: 'unknown', evidence: verdict.evidence || 'результат ввода не подтверждён' };
        }
        // Сверка по изменению поля остаётся только для инструмента без своей проверки.
        if (data.diff && data.diff.changed && data.diff.changed.length) {
          return { status: 'confirmed', evidence: `поле изменилось: ${data.diff.changed.map((c) => c.name).join(', ')}` };
        }
        return { status: 'unknown', evidence: 'ввод прошёл, но изменение поля не подтверждено' };
      },
    });
  }

  return tools;
}

module.exports = { observeTools, findWindow, findWindows, ID_RE };

