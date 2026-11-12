'use strict';

// Инструменты плана хода и честной остановки. План принадлежит одному ходу (runId из кантекста
// инструмента); шаг закрывается только с доказательством. Это не разрешение действовать:
// каждое действие по-прежнему идёт через политику.
const { STOP_WORDS } = require('../agent/plan');

function planTools(plans) {
  return [
    {
      name: 'plan_set',
      risk: 'T0',
      source: 'plan',
      description: 'Назвать план хода: шаги словами, по порядку. Для дела из трёх и больше шагов — до первого действия. План живёт в этом ходе; дальше закрывай шаги через plan_done с доказательством.',
      parameters: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 300 }, minItems: 1, maxItems: 20 },
        },
        required: ['steps'],
      },
      run(args, ctx) {
        try {
          const plan = plans.set(ctx && ctx.runId, args && args.steps);
          const total = plan.steps.length;
          return {
            ok: true,
            summary: `план: шагов ${total}`,
            data: { plan: { total, steps: plan.steps.map((s) => ({ id: s.id, text: s.text, status: s.status })) } },
          };
        } catch (err) {
          return { ok: false, summary: err.message };
        }
      },
    },
    {
      name: 'plan_done',
      risk: 'T0',
      source: 'plan',
      description: 'Закрыть шаг плана, когда он действительно сделан. evidence — чем подтверждено: имя файла, ответ инструмента, что видно на экране. Шаг без доказательства не закрывается.',
      parameters: {
        type: 'object',
        properties: {
          step: { type: 'integer', minimum: 1, maximum: 20 },
          evidence: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['step', 'evidence'],
      },
      run(args, ctx) {
        try {
          const plan = plans.done(ctx && ctx.runId, args && args.step, args && args.evidence);
          const left = plan.steps.filter((s) => s.status !== 'done').length;
          return {
            ok: true,
            summary: `шаг ${args.step} закрыт; осталось ${left}`,
            data: { plan: { total: plan.steps.length, done: plan.steps.length - left, left } },
          };
        } catch (err) {
          return { ok: false, summary: err.message };
        }
      },
    },
    {
      name: 'turn_stop',
      risk: 'T0',
      source: 'plan',
      description: 'Закончить ход, если дело нельзя довести. kind: impossible — невозможно (нет программы, прав, данных); needs_human — нужен человек (капча, пароль, выбор); unsure — не уверен в результате. reason — коротко, что именно. Это не способ уйти от работы: обычный ответ даётся без него.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['impossible', 'needs_human', 'unsure'] },
          reason: { type: 'string', minLength: 3, maxLength: 300 },
        },
        required: ['kind', 'reason'],
      },
      run(args) {
        const kind = String((args && args.kind) || '').trim();
        if (!STOP_WORDS[kind]) return { ok: false, summary: 'kind: impossible, needs_human или unsure' };
        const reason = String((args && args.reason) || '').replace(/\s+/g, ' ').trim();
        if (reason.length < 3) return { ok: false, summary: 'reason: коротко, что именно' };
        if (reason.length > 300) return { ok: false, summary: 'reason: не больше 300 символов' };
        return {
          ok: true,
          summary: `${STOP_WORDS[kind]}: ${reason}`,
          data: { turnStop: { kind, reason } },
        };
      },
    },
  ];
}

module.exports = { planTools, STOP_WORDS };
