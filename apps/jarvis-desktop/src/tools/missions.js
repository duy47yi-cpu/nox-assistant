'use strict';

// Инструменты фоновых задач: добавить (T1), список (T0), отменить (T2).
// Работают через MissionStore; любая ошибка возвращается как {ok: false, summary}.
const { MAX_GOAL } = require('../missions/store');

const MIN_MINUTES = 5;
const MAX_MINUTES = 10080;
const LIST_RESULT_CHARS = 200;
const MAX_ID = 100;
const NO_SCHEDULE = 'укажи every_minutes или daily_at';

function fail(err) {
  return { ok: false, summary: err && err.message ? err.message : String(err), data: {} };
}

function failWith(summary) {
  return { ok: false, summary, data: {} };
}

// ЧЧ:ММ по локальным часам машины: так время понятно самому пользователю.
function localHhmm(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function truncate(text, max) {
  if (text === null) return null;
  return Array.from(text).slice(0, max).join('');
}

function missionTools(store, { now = () => new Date(), workspaceId = 'default' } = {}) {
  if (!store || typeof store.add !== 'function' || typeof store.cancel !== 'function') {
    throw new Error('missionTools: нужен экземпляр MissionStore');
  }
  const visible = (mission) => workspaceId === 'default'
    ? (!mission.workspaceId || mission.workspaceId === 'default')
    : mission.workspaceId === workspaceId;

  const missionAdd = {
    name: 'mission_add',
    description: `Поставить фоновую задачу: каждые N минут (от ${MIN_MINUTES} до ${MAX_MINUTES}) или каждый день в указанное время. Нужно указать ровно одно из every_minutes или daily_at.`,
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', minLength: 1, maxLength: MAX_GOAL, description: 'что нужно сделать' },
        every_minutes: { type: 'integer', minimum: MIN_MINUTES, maximum: MAX_MINUTES },
        daily_at: {
          type: 'string',
          pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
          description: 'время ЧЧ:ММ по местному времени, например 09:30',
        },
        expect: {
          type: 'array',
          maxItems: 5,
          description: 'что должно быть правдой после задачи; код проверит это чтением. Если задать нечего, не указывай',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['file', 'window', 'process'] },
              target: { type: 'string', minLength: 1, maxLength: 260 },
              until: { type: 'string', enum: ['appear', 'gone'] },
            },
            required: ['kind', 'target'],
          },
        },
        max_steps: { type: 'integer', minimum: 1, maximum: 60 },
        max_minutes: { type: 'integer', minimum: 1, maximum: 240 },
      },
      required: ['goal'],
    },
    async run(args = {}) {
      try {
        const hasEvery = args.every_minutes !== undefined && args.every_minutes !== null;
        const hasDaily = args.daily_at !== undefined && args.daily_at !== null;
        if (hasEvery === hasDaily) return failWith(NO_SCHEDULE);
        const schedule = hasEvery
          ? { type: 'interval', minutes: Number(args.every_minutes) }
          : { type: 'daily', at: String(args.daily_at).trim() };
        const limits = { maxSteps: args.max_steps, maxMinutes: args.max_minutes };
        const record = store.add({ goal: args.goal, schedule, expect: args.expect, limits, workspaceId }, now());
        return {
          ok: true,
          summary: `задача добавлена, первый запуск ${localHhmm(new Date(record.nextRunAt))}`,
          data: { id: record.id, goal: record.goal, schedule: record.schedule, nextRunAt: record.nextRunAt },
        };
      } catch (err) {
        return fail(err);
      }
    },
    async verify(args, result) {
      const saved = store.get(result.data.id);
      return saved && visible(saved)
        ? { status: 'confirmed', evidence: 'задача есть в файле' }
        : { status: 'failed', evidence: 'задачи нет в файле' };
    },
  };

  const missionList = {
    name: 'mission_list',
    description: 'Показать фоновые задачи: график, следующий запуск, итог последнего.',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run() {
      try {
        const items = store.list().filter(visible).map((m) => ({
          id: m.id,
          goal: m.goal,
          schedule: m.schedule,
          nextRunAt: m.nextRunAt,
          runs: m.runs,
          lastVerdict: m.lastVerdict || null,
          lastResult: truncate(m.lastResult, LIST_RESULT_CHARS),
        }));
        return { ok: true, summary: `задач: ${items.length}`, data: items };
      } catch (err) {
        return fail(err);
      }
    },
  };

  const missionCancel = {
    name: 'mission_cancel',
    description: 'Отменить фоновую задачу по id.',
    risk: 'T2',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: MAX_ID },
      },
      required: ['id'],
    },
    async run(args = {}) {
      try {
        const id = String(args.id ?? '').trim();
        const existing = store.get(id);
        if (!existing || !visible(existing) || !store.cancel(id)) return failWith('такой задачи нет');
        return { ok: true, summary: 'отменил', data: { id } };
      } catch (err) {
        return fail(err);
      }
    },
    async verify(args, result) {
      const saved = store.get(result.data.id);
      return saved && visible(saved)
        ? { status: 'failed', evidence: 'задача осталась в файле' }
        : { status: 'confirmed', evidence: 'задачи больше нет в файле' };
    },
  };

  return [missionAdd, missionList, missionCancel];
}

module.exports = { missionTools };
