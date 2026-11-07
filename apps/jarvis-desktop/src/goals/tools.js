'use strict';

// Инструменты целей. Только план и отметки в goals.json: сами действия идут обычными инструментами
// и обычной политикой. Риск T0: запись локального плана, как remember или remind_in.

function view(item) {
  return {
    id: item.id,
    title: item.title,
    note: item.note,
    status: item.status,
    steps: item.steps.map((s, i) => ({ n: i + 1, text: s.text, status: s.status, evidence: s.evidence })),
    result: item.result,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    endedAt: item.endedAt,
  };
}

function progressOf(store, item) {
  return store.progress(item);
}

function goalTools(store) {
  return [
    {
      name: 'goal_create',
      description: 'Создать цель на несколько ходов: название и шаги. Дальше отмечай шаги через goal_step по одному, с доказательством. Для долгой работы без владельца есть long_task_start.',
      risk: 'T0',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 300 } },
          note: { type: 'string', maxLength: 1000 },
        },
        required: ['title', 'steps'],
      },
      async run(args = {}) {
        try {
          const item = store.create({ title: args.title, steps: args.steps, note: args.note });
          return { ok: true, summary: `цель создана: ${item.title}, шагов ${item.steps.length}`, data: { goal: view(item), progress: progressOf(store, item) } };
        } catch (err) {
          return { ok: false, summary: err.message, data: {} };
        }
      },
      async verify(args, result) {
        const id = result && result.data && result.data.goal && result.data.goal.id;
        return id && store.get(id) ? { status: 'confirmed', evidence: 'цель записана на диск' } : { status: 'failed', evidence: 'цели нет в файле' };
      },
    },
    {
      name: 'goal_list',
      description: 'Цели: активные и закрытые, с шагами и доказательствами. Загляни сюда, если владелец говорит «продолжай» или спрашивает, что осталось.',
      risk: 'T0',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['active', 'done', 'dropped'] }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      },
      async run(args = {}) {
        try {
          const items = store.list({ status: args.status || null, limit: args.limit || 20 });
          return {
            ok: true,
            summary: `целей: ${items.length}`,
            data: { goals: items.map((item) => ({ ...view(item), progress: progressOf(store, item) })) },
          };
        } catch (err) {
          return { ok: false, summary: err.message, data: {} };
        }
      },
    },
    {
      name: 'goal_next',
      description: 'Следующий незакрытый шаг цели по id: что делать дальше и чем это подтвердить.',
      risk: 'T0',
      parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['id'] },
      async run(args = {}) {
        try {
          const { goal, index, step } = store.next(String(args.id));
          if (goal.status !== 'active') return { ok: false, summary: `цель уже ${goal.status}`, data: { goal: view(goal) } };
          if (!step) return { ok: true, summary: 'все шаги отмечены; закрой цель через goal_close', data: { goal: view(goal), step: null } };
          return { ok: true, summary: `шаг ${index} из ${goal.steps.length}: ${step.text}`, data: { goal: view(goal), step: { n: index, text: step.text } } };
        } catch (err) {
          return { ok: false, summary: err.message, data: {} };
        }
      },
    },
    {
      name: 'goal_step',
      description: 'Отметить шаг цели: done (что именно подтвердило), failed (почему не вышло) или skipped. Номер шага — с 1, как в goal_next.',
      risk: 'T0',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          step: { type: 'integer', minimum: 1, maximum: 20 },
          status: { type: 'string', enum: ['done', 'failed', 'skipped'] },
          evidence: { type: 'string', maxLength: 500 },
        },
        required: ['id', 'step', 'status'],
      },
      async run(args = {}) {
        try {
          const item = store.step(String(args.id), { step: Number(args.step), status: args.status, evidence: args.evidence });
          return { ok: true, summary: `шаг ${args.step}: ${args.status}`, data: { goal: view(item), progress: progressOf(store, item) } };
        } catch (err) {
          return { ok: false, summary: err.message, data: {} };
        }
      },
      async verify(args, result) {
        const goal = store.get(String(args.id));
        const step = goal && goal.steps[Number(args.step) - 1];
        return step && step.status === args.status ? { status: 'confirmed', evidence: 'отметка шага сохранена' } : { status: 'failed', evidence: 'отметки нет' };
      },
    },
    {
      name: 'goal_close',
      description: 'Закрыть цель: done — все шаги закрыты и есть итог с доказательством; dropped — цель отменена, причина обязательна.',
      risk: 'T0',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          status: { type: 'string', enum: ['done', 'dropped'] },
          evidence: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['id', 'status', 'evidence'],
      },
      async run(args = {}) {
        try {
          const item = store.close(String(args.id), { status: args.status, evidence: args.evidence });
          return { ok: true, summary: `цель ${args.status}`, data: { goal: view(item), progress: progressOf(store, item) } };
        } catch (err) {
          return { ok: false, summary: err.message, data: {} };
        }
      },
      async verify(args) {
        const goal = store.get(String(args.id));
        return goal && goal.status === args.status ? { status: 'confirmed', evidence: 'итог записан' } : { status: 'failed', evidence: 'цель не закрыта' };
      },
    },
  ];
}

module.exports = { goalTools, view };
