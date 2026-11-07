'use strict';

// Сборка автономных задач: одна точка, которую вызывает main.js. Здесь соединяются учёт стоимости, страж бюджета,
// очередь, исполнитель, подтверждения владельца и инструменты задач для чата.
//
// createRuntime(opts) возвращает:
//   guardedBrain — модель через стража бюджета (cost/guard.js). Через него идут все вызовы модели: и чат
//                  (main.js отдаёт его агенту вместо сырого клиента), и исполнитель;
//   meter        — единственный Meter на файл учёта в процессе. Второй экземпляр на том же файле принял бы
//                  резервы первого за прерванные и записал бы их в расход (см. cost/meter.js);
//   queue        — очередь задач из tasksFile; задачи, которые выполнялись при выходе, — на паузе и сами не стартуют;
//   saveTasks    — запись задач в tasksFile;
//   approvals    — брокер подтверждений, который сообщает окну о каждом запросе (событие approval_request);
//   executor     — исполнитель задач с мандатом (tasks/executor.js);
//   chatTools    — инструменты задач для чата: task_* из tasks/tools.js, task_submit и task_resume;
//   submitTask, resumeTask — то, что делают task_submit и task_resume; runTool — запуск инструмента задачи;
//   whenIdle     — промис: запуски исполнителя, начатые отсюда, закончились; close — отписка от стопа.
//
// Самостоятельная работа — только с согласия владельца: мандат подтверждается при поручении, а каждое
// возобновление после паузы — отдельно. Принимается только ответ «один раз»; любой другой — отказ.
// Учёт расходов заблокирован (файл учёта был повреждён) — работа не начинается, а причина показывается как есть.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Meter } = require('../cost/meter');
const { taskCostSummary } = require('../cost/summary');
const { createGuard, DEFAULT_MAX_OUTPUT_TOKENS } = require('../cost/guard');
const taskModel = require('./model');
const mandates = require('./mandate');
const { TaskQueue, recoverAfterRestart } = require('./queue');
const { readTasks, writeTasks } = require('./store');
const { taskTools } = require('./tools');
const { createExecutor } = require('./executor');
const { checkEffect } = require('../agent/effects');
const { backgroundBrief } = require('../memory/store');

const HOUR_MS = 60 * 60 * 1000;
const MAX_GOAL = 2000;
const MAX_TITLE = 200;
const TITLE_FROM_GOAL = 80;
const MIN_EXPIRY_HOURS = 1;
const MAX_EXPIRY_HOURS = 168;
const DEFAULT_EXPIRY_HOURS = 24;
// Без явного списка задача получает только файлы песочницы. Интернет (web_*) — только если его назвать.
const DEFAULT_TASK_TOOLS = Object.freeze(mandates.ALLOWED_TOOLS.filter((name) => name.startsWith('workspace_')));
// Лимиты поручение не задаёт: модель не может ни ужесточить, ни ослабить согласованные по умолчанию значения
// (шагов 40, неудач подряд на шаге 3, активного времени 2 ч, токенов 300 000). Владелец видит их в подтверждении мандата.
const SUBMIT_KEYS = ['goal', 'title', 'tools', 'folders', 'expiresInHours', 'budgetUsd'];
const MANDATE_APPROVAL = 'мандат задачи';
const RESUME_APPROVAL = 'возобновление задачи';
const REJECTED = 'отклонено владельцем';
// Статусы, после которых ожидающие подтверждения задачи недействительны.
const CLOSE_APPROVALS_ON = Object.freeze(['blocked', 'paused', 'cancelled', 'done', 'unverified']);
const STOPPED = 'аварийный стоп включён';

function errText(err) {
  return (err && err.message) || String(err);
}

function clip(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function ok(summary, data = {}) {
  return { ok: true, summary, data };
}

function notOk(summary) {
  return { ok: false, summary, data: {} };
}

const pathKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// abs лежит внутри dir и не совпадает с ней. Префикс с разделителем: «reports2» не внутри «reports».
function isStrictlyInside(dir, abs) {
  const d = pathKey(path.resolve(dir));
  const a = pathKey(path.resolve(abs));
  return a !== d && a.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

// Запись задачи, с которой справятся очередь и исполнитель. Иное — признак битого файла.
function isTaskRecord(t) {
  return Boolean(t) && typeof t === 'object' && !Array.isArray(t)
    && typeof t.id === 'string' && t.id !== ''
    && typeof t.title === 'string'
    && taskModel.STATUSES.includes(t.status)
    && Array.isArray(t.plan) && Array.isArray(t.log);
}

// Битый файл задач не затирается: он откладывается рядом как <файл>.corrupt-<метка времени>.
// Отложить не вышло — ошибка: пустой список поверх непрочитанного файла стёр бы задачи.
function setAside(file, stamp) {
  const base = `${file}.corrupt-${stamp}`;
  let target = base;
  for (let i = 2; fs.existsSync(target); i += 1) target = `${base}-${i}`;
  try {
    fs.renameSync(file, target);
  } catch (err) {
    throw new Error(`задачи: файл ${file} не читается и не отложен (${errText(err)}); запуск остановлен, чтобы не затереть его`);
  }
  return target;
}

// Задачи из файла после перезапуска: выполнявшиеся и ждавшие подтверждения — на паузе (recoverAfterRestart).
// Битый файл — отложен, список пуст.
function loadTasks(file, at) {
  try {
    const list = readTasks(file);
    if (!Array.isArray(list) || !list.every(isTaskRecord)) throw new Error('записи задач повреждены');
    return recoverAfterRestart(list, { now: at });
  } catch (err) {
    const target = setAside(file, at);
    console.error(`задачи: файл ${file} не читается (${errText(err)}), отложен как ${target}; список задач начат с пустого`);
    return [];
  }
}

// Бюджет задачи из мандата. Повреждённое значение заменяется значением по умолчанию, а не снимает лимит.
function taskBudgetOf(task) {
  const usd = task && task.mandate ? task.mandate.budgetUsd : undefined;
  const valid = typeof usd === 'number' && Number.isFinite(usd) && usd > 0 && usd <= mandates.MAX_BUDGET_USD;
  return valid ? usd : mandates.DEFAULTS.budgetUsd;
}

function titleFromGoal(goal) {
  const line = goal.split(/\r?\n/, 1)[0].trim();
  return line.length > TITLE_FROM_GOAL ? `${line.slice(0, TITLE_FROM_GOAL - 1)}…` : line;
}

// Параметры task_submit. Неизвестный параметр — ошибка: модель не должна думать, что задала то, чего нет.
// Инструменты, бюджет и лимиты окончательно проверяет createMandate.
function readSubmitArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('нужны параметры поручения: {goal, ...}');
  for (const key of Object.keys(args)) {
    if (!SUBMIT_KEYS.includes(key)) throw new Error(`неизвестный параметр «${clip(key, 50)}»; есть: ${SUBMIT_KEYS.join(', ')}`);
  }
  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  if (!goal) throw new Error('нужна цель задачи goal: непустая строка');
  if (goal.length > MAX_GOAL) throw new Error(`цель длиннее ${MAX_GOAL} символов`);
  if (args.title != null && typeof args.title !== 'string') throw new Error('title должен быть строкой');
  const title = clip((args.title || '').trim() || titleFromGoal(goal), MAX_TITLE);

  let folders;
  if (args.folders != null) {
    if (!Array.isArray(args.folders) || args.folders.length === 0) throw new Error('folders — непустой список подпапок песочницы');
    folders = args.folders.map((folder) => {
      if (typeof folder !== 'string' || !folder.trim()) throw new Error('папка должна быть непустой строкой');
      const rel = folder.trim();
      if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
        throw new Error(`папка «${clip(rel, 100)}»: укажите путь относительно песочницы; абсолютный путь не принимается, `
          + 'папки вне песочницы (в том числе проект Джарвиса) не разрешаются');
      }
      return rel;
    });
  }

  const hours = args.expiresInHours == null ? DEFAULT_EXPIRY_HOURS : args.expiresInHours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < MIN_EXPIRY_HOURS || hours > MAX_EXPIRY_HOURS) {
    throw new Error(`expiresInHours — срок мандата в часах, от ${MIN_EXPIRY_HOURS} до ${MAX_EXPIRY_HOURS}, получено: ${clip(hours, 50)}`);
  }
  return {
    goal,
    title,
    tools: args.tools == null ? [...DEFAULT_TASK_TOOLS] : args.tools,
    folders,
    expiresInMs: Math.round(hours * HOUR_MS),
    budgetUsd: args.budgetUsd == null ? undefined : args.budgetUsd,
  };
}

function createRuntime(opts = {}) {
  const {
    brain, model: modelId, tasksFile, budgetFile, sandboxRoot, reportsDir = 'reports', dailyLimitUsd, budgetTimezone,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS, toolRegistry, approvals: broker, stop, journal = null,
    emit = null, resolve, now = () => Date.now(), memory = null, workspaceForId = null,
  } = opts || {};
  const need = (cond, what) => {
    if (!cond) throw new Error(`createRuntime: ${what}`);
  };
  need(brain && typeof brain.chat === 'function', 'нужна модель brain с методом chat');
  need(typeof modelId === 'string' && modelId.trim() !== '', 'нужен model — ID модели, по цене которой считается бюджет');
  need(typeof tasksFile === 'string' && tasksFile !== '', 'нужен путь tasksFile');
  need(typeof budgetFile === 'string' && budgetFile !== '', 'нужен путь budgetFile');
  need(typeof sandboxRoot === 'string' && path.isAbsolute(sandboxRoot), 'нужен абсолютный путь sandboxRoot');
  need(toolRegistry && typeof toolRegistry.get === 'function' && typeof toolRegistry.list === 'function',
    'нужен toolRegistry с get(name) и list()');
  need(broker && typeof broker.request === 'function' && typeof broker.respond === 'function',
    'нужен брокер подтверждений approvals с request и respond');
  need(stop && typeof stop.isStopped === 'function' && typeof stop.onTrigger === 'function', 'нужен аварийный стоп stop (StopSwitch)');
  need(typeof resolve === 'function', 'нужна проверка путей песочницы resolve(rel)');
  need(typeof now === 'function', 'now — функция, возвращающая время в мс');
  const root = path.resolve(sandboxRoot);
  const reports = typeof reportsDir === 'string' ? reportsDir.trim() : '';
  // Папка отчётов — внутри песочницы, но не сама песочница: туда исполнитель пишет отчёты задач.
  need(reports !== '' && isStrictlyInside(root, path.resolve(root, reports)),
    `папка отчётов «${clip(reportsDir, 100)}» должна лежать внутри песочницы ${root}, но не быть ею самой`);
  const clock = now;

  // Один Meter на файл учёта: его получают и страж, и исполнитель (costOf), и поручения (остаток дня).
  // budgetTimezone — пояс дня бюджета (IANA, из settings.json); не задан — Asia/Dushanbe, негодный — ошибка запуска.
  const meter = new Meter({ file: budgetFile, dailyLimitUsd, timezone: budgetTimezone, now: () => new Date(clock()) });
  const guardedBrain = createGuard({ brain, meter, model: modelId, maxOutputTokens });

  // Задача ушла в blocked, paused, cancelled, done или unverified — её ожидающие подтверждения отменяются:
  // старое подтверждение использовать нельзя (ответ на него не принимается), окно получает approval_closed.
  const queue = new TaskQueue({
    tasks: loadTasks(tasksFile, clock()),
    now: clock,
    onStatus: (task) => {
      if (CLOSE_APPROVALS_ON.includes(task.status)) cancelTaskApprovals(task);
    },
  });
  const saveTasks = (list = queue.list()) => writeTasks(tasksFile, list);

  // Пространство выбирает доверенный код приложения, а не аргументы модели. Уже выданный мандат
  // связывает задачу с конкретным корнем: повреждённый id не должен перенаправить её в другую папку.
  function spaceContext(id) {
    if (!id || id === 'default') return { root, resolve, toolRegistry, memory };
    const space = typeof workspaceForId === 'function' ? workspaceForId(id) : null;
    if (!space || typeof space.root !== 'string' || !path.isAbsolute(space.root)
      || typeof space.resolve !== 'function' || !space.toolRegistry || typeof space.toolRegistry.get !== 'function') {
      throw new Error('пространство задачи недоступно');
    }
    return space;
  }
  function contextForTask(task) {
    if (!task || !task.mandate) throw new Error('задача или её мандат недоступны');
    const space = spaceContext(task.workspaceId);
    const key = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    if (typeof task.mandate.root !== 'string' || key(task.mandate.root) !== key(space.root)) {
      throw new Error('пространство задачи не совпадает с подтверждённым мандатом');
    }
    return space;
  }
  const taskResolve = (rel, taskId) => contextForTask(queue.get(taskId)).resolve(rel);

  // Сохранение для своих шагов: сбой записи не роняет поручение, но возвращает причину для владельца.
  function persist() {
    try {
      saveTasks(queue.list());
      return null;
    } catch (err) {
      console.error(`задачи: состояние не сохранено: ${errText(err)}`);
      return errText(err);
    }
  }
  // Паузы после перезапуска — сразу на диск.
  persist();

  function note(entry) {
    if (!journal || typeof journal.append !== 'function') return;
    try {
      journal.append({ ...entry, source: 'task' });
    } catch (err) {
      console.error(`задачи: журнал не записан: ${errText(err)}`);
    }
  }

  function tell(event) {
    if (typeof emit !== 'function') return;
    try {
      emit(event);
    } catch (err) {
      console.error(`задачи: событие не отправлено: ${errText(err)}`);
    }
  }

  // ---- Подтверждения.

  // Обёртка брокера. Запрос сначала регистрируется у брокера (он же выдаёт id, если его нет), затем окно получает
  // approval_request — показать запрос и уведомить владельца. Порядок как в agent/loop.js: ответ, пришедший сразу,
  // даже из обработчика события, не теряется. Ответ, отмена и список — как у брокера.
  // Решённый или отменённый запрос — окну approval_closed: карточка подтверждения исчезает (и в мини-окне).
  const approvals = {
    request(payload = {}) {
      const waiting = broker.request(payload);
      tell({ type: 'approval_request', ...payload });
      const { id } = payload;
      return Promise.resolve(waiting).then((decision) => {
        const reason = closedReason(id);
        tell({ type: 'approval_closed', id, decision, cancelled: Boolean(reason), ...(reason ? { reason } : {}) });
        return decision;
      });
    },
    respond: (id, decision) => broker.respond(id, decision),
    cancelAll: () => (typeof broker.cancelAll === 'function' ? broker.cancelAll() : 0),
    closedReason: (id) => closedReason(id),
    list: () => (typeof broker.list === 'function' ? broker.list() : []),
  };

  function closedReason(id) {
    return typeof broker.closedReason === 'function' ? broker.closedReason(id) : null;
  }

  // Ожидающие подтверждения задачи: шаги исполнителя («<id задачи>:…») и возобновление («resume:<id задачи>:…»).
  function cancelTaskApprovals(task) {
    if (typeof broker.cancelPrefix !== 'function') return [];
    const reason = `задача ${taskModel.humanStatus(task)}${task.reason ? ` (${clip(task.reason, 200)})` : ''}: подтверждение больше не действует`;
    return [`${task.id}:`, `resume:${task.id}:`].flatMap((prefix) => broker.cancelPrefix(prefix, reason));
  }

  // id запросов этой сборки (мандат, возобновление), которые ждут ответа.
  const ownPending = new Set();

  function rejectOwn(id) {
    try {
      broker.respond(id, 'reject');
    } catch {
      // уже решено
    }
  }

  // Решение владельца по запросу сборки. Отмена хода чата (signal), стоп и сбой брокера — отказ.
  async function askOwner(payload, signal) {
    let waiting;
    try {
      waiting = approvals.request(payload);
    } catch (err) {
      console.error(`задачи: запрос подтверждения не создан: ${errText(err)}`);
      return 'reject';
    }
    const { id } = payload;
    ownPending.add(id);
    const cancel = () => rejectOwn(id);
    const watch = Boolean(signal) && typeof signal.addEventListener === 'function';
    if (watch) {
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    }
    try {
      return await waiting;
    } catch {
      return 'reject';
    } finally {
      ownPending.delete(id);
      if (watch) signal.removeEventListener('abort', cancel);
    }
  }

  // Стоп отклоняет ожидающие подтверждения мандата и возобновления. Задачу в работе исполнитель ставит
  // на паузу сам; отмена прочих подтверждений и пауза задач чата — в обработчике стопа main.js.
  const offStop = stop.onTrigger(() => {
    for (const id of [...ownPending]) rejectOwn(id);
  });

  // ---- Инструменты и модель для исполнителя.

  // Инструмент задачи — только для выполняющейся задачи с мандатом и только в его рамках (срок, имя, папки:
  // checkTool). Исполнитель проверяет то же перед вызовом; здесь вторая линия: всё, что не разрешено, — отказ.
  async function runTool(name, args, ctx = {}) {
    const taskId = ctx && typeof ctx.taskId === 'string' ? ctx.taskId : null;
    const task = taskId ? queue.get(taskId) : null;
    const shown = clip(name, 100);
    if (!taskModel.hasMandate(task)) return notOk(`отказ: инструмент «${shown}» вне задачи с мандатом`);
    if (task.status !== 'running') return notOk(`отказ: задача не выполняется (${taskModel.humanStatus(task)})`);
    let space;
    try { space = contextForTask(task); } catch (err) { return notOk(`отказ: ${errText(err)}`); }
    const verdict = mandates.checkTool(task.mandate, { name, args, resolve: space.resolve, now: clock() });
    if (!verdict.ok) return notOk(`отказ: ${verdict.reason}`);
    const tool = space.toolRegistry.get(name);
    if (!tool || typeof tool.run !== 'function') return notOk(`отказ: инструмента «${shown}» нет`);
    const toolCtx = { workspace: space.root, signal: ctx.signal, taskId };
    return checkEffect(tool, args, await tool.run(args, toolCtx), toolCtx);
  }

  // Описания для модели — только инструменты, разрешённые автономным задачам. Реестр читается при каждом вызове:
  // его можно дополнять после сборки.
  const toolSpecs = () => toolRegistry.list()
    .filter((t) => t && mandates.ALLOWED_TOOLS.includes(t.name) && !mandates.isHardBanned(t.name));

  // Исполнитель не передаёт модели бюджет задачи — его добавляет сборка из мандата. Тогда страж откажет
  // ещё до запроса, если худший случай вызова не помещается в остаток бюджета задачи (scope 'task').
  const taskBrain = {
    chat(args = {}) {
      const task = typeof args.taskId === 'string' ? queue.get(args.taskId) : null;
      if (taskModel.hasMandate(task)) contextForTask(task);
      // Фон: «Быстрая» с низким мышлением; «Умную» задача получает только явно.
      const tier = task && task.tier === 'smart' ? 'smart' : 'fast';
      if (!taskModel.hasMandate(task)) return guardedBrain.chat({ ...args, tier, thinking: 'low' });
      return guardedBrain.chat({ ...args, tier, thinking: 'low', taskBudgetUsd: taskBudgetOf(task) });
    },
  };

  const executor = createExecutor({
    queue,
    saveTasks,
    brain: taskBrain,
    runTool,
    toolSpecs,
    approvals,
    stop,
    journal,
    resolve: taskResolve,
    emit,
    // Память владельца в промпты исполнителя: профиль и заметки к цели задачи.
    memoryBrief: (goal, taskId) => backgroundBrief(contextForTask(queue.get(taskId)).memory, goal),
    costOf: (taskId) => meter.spentForTask(taskId),
    // Сводка стоимости для отчёта — чтение того же журнала (budget.json), без записи и без второго Meter.
    costSummary: (taskId, task) => taskCostSummary({ file: budgetFile, taskId, since: task && task.createdAt, now: clock() }),
    now: clock,
    sandboxReportsDir: reports,
  });

  // Запуски исполнителя, начатые отсюда: поручение не ждёт итога задачи, но сбой не теряется.
  const runs = new Set();
  function track(promise) {
    const run = Promise.resolve(promise)
      .catch((err) => {
        console.error(`задачи: исполнитель не запустил задачу: ${errText(err)}`);
        return null;
      })
      .finally(() => runs.delete(run));
    runs.add(run);
    return run;
  }

  async function whenIdle() {
    while (runs.size) await Promise.allSettled([...runs]);
  }

  // ---- Поручение и возобновление.

  // Учёт заблокирован (файл учёта был повреждён): вызовы модели отклоняются. Причина — владельцу как есть.
  function meterBlocked() {
    const reason = meter.blockedReason();
    return reason
      ? `учёт расходов заблокирован: ${reason}; вызовы модели отклоняются, пока владелец не проверит копию файла учёта рядом с ${budgetFile}`
      : null;
  }

  function statusText(id) {
    const task = queue.get(id);
    if (!task) return 'неизвестно';
    return task.reason ? `${taskModel.humanStatus(task)} (${task.reason})` : taskModel.humanStatus(task);
  }

  function savedNote(unsaved) {
    return unsaved ? `; внимание: состояние задач не сохранено на диск (${unsaved})` : '';
  }

  function newTaskId() {
    for (;;) {
      const id = `t${Math.floor(clock()).toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      if (!queue.get(id)) return id;
    }
  }

  // Поручение: мандат → подтверждение владельца → задача в очереди → исполнитель. Итог задачи не ждём.
  async function submitTask(args = {}, { signal, workspaceId = 'default' } = {}) {
    try {
      if (stop.isStopped()) return notOk(`${STOPPED}: новые задачи не принимаются, сначала возобновите работу в трее`);
      const blocked = meterBlocked();
      if (blocked) return notOk(`задача не создана: ${blocked}`);
      const input = readSubmitArgs(args);
      const space = spaceContext(workspaceId);
      const remaining = meter.remainingToday();
      const mandate = mandates.createMandate({
        goal: input.goal,
        tools: input.tools,
        folders: input.folders,
        sandboxRoot: space.root,
        now: clock(),
        expiresInMs: input.expiresInMs,
        limits: input.limits,
        budgetUsd: input.budgetUsd,
        dailyBudgetUsd: remaining ?? meter.dailyLimitUsd,
      });
      // Код — только в папках, которые и после раскрытия ссылок (junction, symlink) лежат в песочнице.
      // Иначе отказ до вопроса владельцу: подтверждать нечего, инструмент всё равно откажет.
      if (mandates.hasCodeTools(mandate.tools)) {
        const problem = mandates.realFoldersProblem(mandate);
        if (problem) return notOk(`задача не создана: ${problem}`);
      }
      const decision = await askOwner({
        id: `mandate:${mandate.id}`,
        name: MANDATE_APPROVAL,
        args: { мандат: mandates.summarize(mandate), ...(workspaceId !== 'default' ? { пространство: space.name || workspaceId, папка: space.root } : {}) },
        risk: 'T1',
        reason: 'разрешить самостоятельную работу в песочнице по этому мандату',
        allowSession: false,
      }, signal);
      const approved = decision === 'once' && !stop.isStopped();
      if (!approved) {
        const why = stop.isStopped() ? `${STOPPED}: задача не создана` : REJECTED;
        note({ tool: MANDATE_APPROVAL, args: { mandateId: mandate.id }, risk: 'T1', decision: 'reject', ok: false, summary: `${why} (ответ: ${clip(decision, 20)})` });
        return notOk(why);
      }
      mandate.approvedBy = 'owner';
      mandate.approvedAt = clock();
      const id = newTaskId();
      const task = taskModel.createTask({ id, title: input.title, goal: mandate.goal, mandate, now: clock() });
      if (workspaceId !== 'default') task.workspaceId = workspaceId;
      contextForTask(task);
      queue.add(task);
      queue.enqueue(id);
      const unsaved = persist();
      note({ tool: MANDATE_APPROVAL, args: { mandateId: mandate.id }, risk: 'T1', decision: 'once', ok: true, summary: `мандат подтверждён владельцем: задача ${id}`, taskId: id });
      track(executor.submit(id));
      return ok(`мандат подтверждён владельцем, задача «${queue.get(id).title}» у исполнителя: ${statusText(id)}${savedNote(unsaved)}`, { id });
    } catch (err) {
      return notOk(errText(err));
    }
  }

  // Возобновление задачи на паузе по её прежнему мандату — только с подтверждения владельца.
  // То, что сразу снова остановит задачу (срок, бюджет задачи, блок учёта), — отказ без вопроса владельцу.
  async function resumeTask(id, { signal } = {}) {
    try {
      if (typeof id !== 'string' || !id) return notOk('нужен id задачи');
      if (stop.isStopped()) return notOk(`${STOPPED}: сначала возобновите работу в трее`);
      const task = queue.get(id);
      if (!task) return notOk(`задача «${clip(id, 100)}» не найдена`);
      if (!taskModel.hasMandate(task)) return notOk('у задачи нет мандата: её ведёт ход чата, а не исполнитель');
      contextForTask(task);
      if (task.status !== 'paused') return notOk(`задача не на паузе (${taskModel.humanStatus(task)}): возобновлять нечего`);
      if (!task.mandate.approvedBy) return notOk('мандат задачи не подтверждён владельцем: поручите её заново (task_submit)');
      if (mandates.isExpired(task.mandate, clock())) return notOk('срок мандата истёк: продолжить по нему нельзя, поручите задачу заново (task_submit)');
      if (meter.spentForTask(id) >= taskBudgetOf(task)) return notOk('бюджет задачи исчерпан: продолжить по этому мандату нельзя, поручите задачу заново (task_submit)');
      const blocked = meterBlocked();
      if (blocked) return notOk(`задача осталась на паузе: ${blocked}`);
      const decision = await askOwner({
        id: `resume:${id}:${clock()}`,
        name: RESUME_APPROVAL,
        args: { задача: task.title, 'причина паузы': task.reason || 'не указана' },
        risk: 'T1',
        reason: 'продолжить задачу по её мандату',
        allowSession: false,
      }, signal);
      const approved = decision === 'once' && !stop.isStopped();
      if (!approved) {
        const why = stop.isStopped() ? `${STOPPED}: задача осталась на паузе` : REJECTED;
        note({ tool: RESUME_APPROVAL, risk: 'T1', decision: 'reject', ok: false, summary: `${why} (ответ: ${clip(decision, 20)})`, taskId: id });
        return notOk(why);
      }
      const current = queue.get(id);
      if (!current || current.status !== 'paused') {
        return notOk(`задача уже не на паузе (${current ? taskModel.humanStatus(current) : 'её нет'}): возобновлять нечего`);
      }
      queue.resume(id);
      const unsaved = persist();
      note({ tool: RESUME_APPROVAL, risk: 'T1', decision: 'once', ok: true, summary: 'возобновление подтверждено владельцем', taskId: id });
      track(executor.submit(id));
      return ok(`возобновление подтверждено владельцем, задача «${current.title}»: ${statusText(id)}${savedNote(unsaved)}`, { id });
    } catch (err) {
      return notOk(errText(err));
    }
  }

  // ---- Инструменты чата. Риск T0: подтверждение владельца — внутри самих функций, через approvals,
  // а не политикой хода чата.

  const submitTool = {
    name: 'task_submit',
    risk: 'T0',
    description: 'Поручить многошаговое дело исполнителю: он сам составит план, выполнит шаги инструментами в песочнице '
      + 'и объективно проверит результат, без сообщений «продолжай». Перед стартом владелец подтверждает мандат: цель, '
      + 'инструменты, папки, срок и бюджет; без его ответа «один раз» задача не создаётся. goal — что должно получиться, '
      + 'лучше с путём файла результата. tools — по умолчанию только файлы песочницы (workspace_*); project_brief и project_diagnostics для разбора проекта и журнала, web_search, web_fetch, '
      + 'web_wiki, web_research — только если указать; web_research ищет и читает несколько страниц. code_read, code_write, code_edit — чтение и правка исходников, code_test — запуск тестов из белого списка с правами владельца, не песочница (только если указать), '
      + 'только в папках folders (их тогда нужно указать явно), пути — относительно песочницы, как у workspace_*; '
      + 'отдельного подтверждения на каждый вызов нет: разрешение — подтверждённый мандат. '
      + 'folders — подпапки песочницы относительными путями, по умолчанию вся песочница (кроме задач с code_*). '
      + 'Папки и инструменты мандата не меняются: другие папки — новое поручение с новым подтверждением. '
      + `expiresInHours — срок мандата, ${MIN_EXPIRY_HOURS}–${MAX_EXPIRY_HOURS} ч, по умолчанию ${DEFAULT_EXPIRY_HOURS}. `
      + `budgetUsd — бюджет задачи, больше 0 и до $${mandates.MAX_BUDGET_USD}, не больше остатка дня; по умолчанию $${mandates.DEFAULTS.budgetUsd}. `
      + `Ход задачи — task_list, итог — отчёт ${reports}/task-<id>.md.`,
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', minLength: 1, maxLength: MAX_GOAL },
        title: { type: 'string', maxLength: MAX_TITLE },
        tools: { type: 'array', minItems: 1, items: { type: 'string', enum: [...mandates.ALLOWED_TOOLS] } },
        folders: { type: 'array', minItems: 1, items: { type: 'string', maxLength: 300 } },
        expiresInHours: { type: 'number', minimum: MIN_EXPIRY_HOURS, maximum: MAX_EXPIRY_HOURS },
        budgetUsd: { type: 'number', minimum: 0, maximum: mandates.MAX_BUDGET_USD },
      },
      required: ['goal'],
    },
    run: (args, ctx) => submitTask(args, ctx || {}),
  };

  const resumeTool = {
    name: 'task_resume',
    risk: 'T0',
    description: 'Возобновить задачу исполнителя, которая стоит на паузе (стоп, лимит, перезапуск приложения). '
      + 'Каждое возобновление владелец подтверждает отдельно; без его ответа «один раз» задача остаётся на паузе. '
      + 'Мандат прежний: срок, инструменты, папки и бюджет не меняются.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (args, ctx) => resumeTask(args && args.id, ctx || {}),
  };

  const chatTools = [...taskTools({ queue, save: saveTasks, load: () => readTasks(tasksFile), resolve, now: clock }), submitTool, resumeTool];

  // Список и доступ по id ограничены пространством чата. Очередь и бюджет при этом остаются общими.
  function scopedChatTools(workspaceId = 'default') {
    const allowed = new Set(['task_submit', 'task_resume', 'task_list', 'task_note']);
    const belongs = (id) => {
      const task = queue.get(id);
      return Boolean(task) && (task.workspaceId || 'default') === workspaceId;
    };
    return chatTools.filter((tool) => workspaceId === 'default' || allowed.has(tool.name)).map((tool) => ({
      ...tool,
      async run(args = {}, ctx = {}) {
        if (tool.name === 'task_submit') return submitTask(args, { ...ctx, workspaceId });
        if (args && args.id !== undefined && !belongs(args.id)) return notOk('такой задачи нет');
        const result = await tool.run(args, ctx);
        if (tool.name !== 'task_list' || !result.ok) return result;
        const tasks = result.data.tasks.filter((task) => belongs(task.id));
        return ok(`задач: ${tasks.length}`, { tasks });
      },
    }));
  }

  function reportPath(taskId) {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(taskId)) return null;
    const task = queue.get(taskId);
    if (!task) return null;
    try {
      const space = taskModel.hasMandate(task) ? contextForTask(task) : spaceContext(task.workspaceId);
      const file = space.resolve(path.join(reports, `task-${taskId}.md`));
      return fs.statSync(file).isFile() ? file : null;
    } catch { return null; }
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (typeof offStop === 'function') offStop();
  }

  return {
    guardedBrain, meter, queue, saveTasks, approvals, executor, chatTools,
    submitTask, resumeTask, runTool, whenIdle, close, scopedChatTools, reportPath,
  };
}

module.exports = { createRuntime, DEFAULT_TASK_TOOLS };
