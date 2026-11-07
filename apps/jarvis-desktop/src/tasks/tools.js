'use strict';

// Инструменты задач для модели: создать, задать план, отметить шаг, проверить, показать список.
// Все они меняют только состояние задач (файл tasks.json в данных приложения), на диск с пользовательскими данными не пишут.
// Проверка шага запускает только объективные проверки из verify.js. Модель не может сама объявить шаг выполненным.
// Задачу с мандатом ведёт исполнитель (executor.js): ход чата её только показывает (task_list), но не меняет.
const model = require('./model');
const { randomUUID } = require('crypto');
const { verify, reportLines } = require('./verify');

const BY_EXECUTOR = 'задача ведётся исполнителем';

function ok(summary, data) {
  return { ok: true, summary, data: data || {} };
}

function notOk(summary) {
  return { ok: false, summary, data: {} };
}

function describe(task) {
  const stepSummary = (step) => {
    if (step.result && step.result.summary) return step.result.summary;
    const entry = [...(task.log || [])].reverse().find((item) =>
      typeof item.event === 'string' && item.event.startsWith(`шаг ${step.id}:`));
    return entry && entry.summary ? entry.summary : '';
  };
  return {
    id: task.id,
    title: task.title,
    goal: task.goal || '',
    status: task.status,
    statusText: model.humanStatus(task),
    updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : null,
    reason: task.reason,
    ...(model.hasMandate(task) ? { byExecutor: true } : {}),
    ...(task.verdict ? { verdict: task.verdict } : {}),
    ...(Array.isArray(task.notes) && task.notes.length ? { notes: task.notes } : {}),
    ...(Array.isArray(task.criteria) ? { criteria: task.criteria } : {}),
    plan: task.plan.map((s) => ({
      id: s.id, title: s.title, status: s.status,
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.check ? { check: s.check } : {}),
      ...(stepSummary(s) ? { summary: stepSummary(s) } : {}),
      ...(s.result ? { result: s.result } : {}),
    })),
  };
}

// Мутирующий инструмент чата для задачи с мандатом — отказ: её план, шаги, проверки и запуск ведёт исполнитель.
function ownedByExecutor(queue, id) {
  return model.hasMandate(queue.get(id));
}

// queue — TaskQueue; save() — записывает состояние на диск; resolve(rel) — путь внутри песочницы.
function taskTools({ queue, save, load, resolve, now = () => Date.now() }) {
  const persist = () => save(queue.list());
  // Все шаги выполнены: задача завершается. Пока есть невыполненные шаги, она остаётся в работе.
  const finishIfDone = (id) => {
    const task = queue.get(id);
    if (task.status === 'running' && task.plan.every((s) => s.status === 'done' || s.status === 'skipped')) {
      return queue.complete(id);
    }
    return task;
  };
  const wrap = (fn) => async (args = {}) => {
    try {
      return await fn(args || {});
    } catch (err) {
      return notOk(err && err.message ? err.message : String(err));
    }
  };

  return [
    {
      name: 'task_note',
      risk: 'T1',
      description: 'Добавить к задаче запись: решение, следующий шаг или ссылку на материал. Записывай только известное из разговора или результата работы; запись сама по себе не подтверждает выполнение действия. Повтор такой же записи не создаёт дубликат.',
      parameters: { type: 'object', properties: {
        id: { type: 'string', minLength: 1, maxLength: 200 },
        kind: { type: 'string', enum: ['decision', 'next', 'material'] },
        text: { type: 'string', minLength: 1, maxLength: 500 },
      }, required: ['id', 'kind', 'text'] },
      run: wrap(async (args) => {
        if (typeof args.id !== 'string' || !args.id || args.id.length > 200) return notOk('нужен id задачи');
        if (!['decision', 'next', 'material'].includes(args.kind)) return notOk('вид записи: decision, next или material');
        if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 500) return notOk('текст записи: от 1 до 500 символов');
        const task = queue.get(args.id);
        if (!task) return notOk('такой задачи нет');
        const notes = Array.isArray(task.notes) ? task.notes : [];
        const text = args.text.trim();
        const existing = notes.find((note) => note.kind === args.kind && note.text === text);
        if (existing) return ok('такая запись уже есть', { taskId: task.id, noteId: existing.id });
        if (notes.length >= 50) return notOk('в задаче уже 50 записей');
        const note = { id: randomUUID(), kind: args.kind, text, createdAt: now() };
        // Одно обновление очереди и одна запись на диск: параллельное сохранение исполнителя
        // не может записать состояние без заметки. Если диск не принял, очередь возвращаем назад.
        try {
          queue.addNote(task.id, note);
          persist();
        } catch (err) {
          queue._set(task);
          throw err;
        }
        return ok('запись добавлена к делу', { taskId: task.id, noteId: note.id });
      }),
      async verify(args, result) {
        if (!result.data || !result.data.noteId || typeof load !== 'function') return { status: 'unknown', evidence: 'повторное чтение файла задач недоступно' };
        try {
          const task = load().find((item) => item.id === result.data.taskId);
          return task && Array.isArray(task.notes) && task.notes.some((note) => note.id === result.data.noteId && note.kind === args.kind && note.text === args.text.trim())
            ? { status: 'confirmed', evidence: 'запись найдена в файле задач' }
            : { status: 'failed', evidence: 'запись не найдена в файле задач' };
        } catch {
          return { status: 'unknown', evidence: 'файл задач не удалось перечитать' };
        }
      },
    },
    {
      name: 'task_create',
      risk: 'T0',
      description: 'Создать задачу-черновик с целью. Потом задать план (task_plan) и поставить в очередь (task_enqueue).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 200 },
          goal: { type: 'string', maxLength: 2000 },
        },
        required: ['title'],
      },
      run: wrap(async (args) => {
        const id = `t${now().toString(36)}${randomUUID().replace(/-/g, '')}`;
        if (queue.get(id)) return notOk('не удалось создать уникальный номер задачи');
        const task = model.createTask({ id, title: args.title, goal: args.goal, now: now() });
        // Сначала очередь, потом одна запись на диск: так параллельное сохранение исполнителя не потеряет задачу.
        let added = false;
        try {
          queue.add(task);
          added = true;
          persist();
        } catch (err) {
          if (added) queue._tasks.delete(id); // диск не принял — задачи не должно остаться и в памяти
          throw err;
        }
        return ok(`задача создана: ${args.title}`, { id });
      }),
      async verify(args, result) {
        if (!result.data || !result.data.id || typeof load !== 'function') return { status: 'unknown', evidence: 'повторное чтение файла задач недоступно' };
        try {
          const task = load().find((item) => item.id === result.data.id);
          const expectedTitle = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : '';
          const expectedGoal = typeof args.goal === 'string' ? args.goal.slice(0, 2000) : '';
          return task && task.title === expectedTitle && task.goal === expectedGoal
            ? { status: 'confirmed', evidence: 'задача и её цель найдены в файле задач' }
            : { status: 'failed', evidence: 'задача или её цель не совпадают с запросом' };
        } catch {
          return { status: 'unknown', evidence: 'файл задач не удалось перечитать' };
        }
      },
    },
    {
      name: 'task_plan',
      risk: 'T0',
      description: 'Задать план задачи: список шагов {title, kind?, check?}. check — объективная проверка: {kind:"file_exists",path} — файл есть; '
        + '{kind:"file_absent",path} — файла нет (для шага «убедиться, что файл ещё не создан»); {kind:"file_contains",path,text} — текст есть. '
        + '{kind:"numbered_steps",path,section,count} — в разделе ровно count пунктов 1..count (без шестого, повторов и пропусков); '
        + '{kind:"sentence_count",path,count} — в файле ровно count предложений. '
        + 'Вид шага kind: action (по умолчанию) — действие с проверкой; observation — наблюдение, только чтение; '
        + 'service — служебный шаг, например итоговый ответ в чате. У observation и service нет check. '
        + 'Отчёт файлом — только если этого требует цель. Папки проверяются не file_exists, а шагом workspace_list. Пути — внутри песочницы.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          steps: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', maxLength: 300 },
                kind: { type: 'string', enum: [...model.STEP_KINDS] },
                check: { type: 'object' },
              },
              required: ['title'],
            },
          },
        },
        required: ['id', 'steps'],
      },
      run: wrap(async (args) => {
        const task = queue.get(args.id);
        if (!task) return notOk(`задача «${args.id}» не найдена`);
        if (model.hasMandate(task)) return notOk(BY_EXECUTOR);
        queue.replacePlan(args.id, model.setPlan(task, args.steps, { now: now() }).plan);
        persist();
        return ok(`план: ${args.steps.length} шагов`, describe(queue.get(args.id)));
      }),
    },
    {
      name: 'task_enqueue',
      risk: 'T0',
      description: 'Поставить задачу с планом в очередь. Запускается она отдельно, одна за раз.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: wrap(async (args) => {
        if (ownedByExecutor(queue, args.id)) return notOk(BY_EXECUTOR);
        const task = queue.enqueue(args.id);
        persist();
        return ok(`в очереди: ${task.title}`, describe(task));
      }),
    },
    {
      name: 'task_start',
      risk: 'T0',
      description: 'Запустить задачу из очереди. Одновременно выполняется только одна задача.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: wrap(async (args) => {
        if (ownedByExecutor(queue, args.id)) return notOk(BY_EXECUTOR);
        const task = queue.start(args.id);
        persist();
        return ok(`задача запущена: ${task.title}`, describe(task));
      }),
    },
    {
      name: 'task_step',
      risk: 'T0',
      description: 'Отметить шаг плана выполненным, в работе или неудачным. «Выполнено» модель ставит сама только для шагов без проверки; для шагов с проверкой используйте task_verify.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          step_id: { type: 'string' },
          status: { type: 'string', enum: ['doing', 'failed', 'skipped'] },
          summary: { type: 'string', maxLength: 300 },
        },
        required: ['id', 'step_id', 'status'],
      },
      run: wrap(async (args) => {
        const task = queue.get(args.id);
        if (!task) return notOk(`задача «${args.id}» не найдена`);
        if (model.hasMandate(task)) return notOk(BY_EXECUTOR);
        const step = task.plan.find((s) => s.id === args.step_id);
        if (!step) return notOk(`шага «${args.step_id}» нет в плане`);
        if (step.check) return notOk('у этого шага есть проверка: отмечается только через task_verify');
        queue.markStep(args.id, args.step_id, args.status, { summary: args.summary, now: now() });
        const next = finishIfDone(args.id);
        persist();
        return ok(`шаг ${args.step_id}: ${args.status}`, describe(next));
      }),
    },
    {
      name: 'task_verify',
      risk: 'T0',
      description: 'Проверить шаг объективно: есть ли файл, есть ли в нём нужный текст. Шаг становится выполненным, только если проверка подтвердила. Ответ «не проверено» указывайте в отчёте как есть.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          step_id: { type: 'string' },
        },
        required: ['id', 'step_id'],
      },
      run: wrap(async (args) => {
        const task = queue.get(args.id);
        if (!task) return notOk(`задача «${args.id}» не найдена`);
        if (model.hasMandate(task)) return notOk(BY_EXECUTOR);
        const step = task.plan.find((s) => s.id === args.step_id);
        if (!step) return notOk(`шага «${args.step_id}» нет в плане`);
        const outcome = verify(step.check ? [step.check] : [], { resolve });
        const status = outcome.status === 'confirmed' ? 'done' : 'failed';
        queue.markStep(args.id, args.step_id, status, { summary: reportLines(outcome).join('; '), now: now() });
        const next = finishIfDone(args.id);
        persist();
        return { ok: outcome.status === 'confirmed', summary: reportLines(outcome).join('; '), data: { outcome, task: describe(next) } };
      }),
    },
    {
      name: 'task_list',
      risk: 'T0',
      description: 'Показать задачи, их цели, шаги и результаты проверок. Для одной задачи укажите id. Для поиска незавершённых дел укажите unfinished: true: свежие будут первыми. Задачи с пометкой byExecutor ведёт исполнитель: их не менять.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Необязательный id одной задачи' }, unfinished: { type: 'boolean', description: 'Только незавершённые задачи, по времени изменения' } } },
      run: wrap(async (args) => {
        if (args.id !== undefined && (typeof args.id !== 'string' || !args.id.trim())) return notOk('id задачи должен быть непустой строкой');
        if (args.unfinished !== undefined && typeof args.unfinished !== 'boolean') return notOk('unfinished должен быть true или false');
        const task = args.id === undefined ? null : queue.get(args.id);
        if (args.id !== undefined && !task) return notOk('такой задачи нет');
        let tasks = task ? [task] : queue.list();
        if (args.unfinished) {
          tasks = tasks.filter((item) => !model.FINAL_STATUSES.includes(item.status))
            .sort((a, b) => (Number.isFinite(b.updatedAt) ? b.updatedAt : -Infinity) - (Number.isFinite(a.updatedAt) ? a.updatedAt : -Infinity));
        }
        const list = tasks.map(describe);
        return ok(`задач: ${list.length}`, { tasks: list });
      }),
    },
  ];
}

module.exports = { taskTools };
