'use strict';

// Инструменты напоминаний: через N минут (T0), на время (T0), список (T0), отмена (T2).
// Работают через ReminderStore; любая ошибка возвращается как {ok: false, summary}.
const { MAX_TEXT } = require('../schedule/store');

const MAX_MINUTES = 10080;
const MAX_ID = 100;
const MINUTE_MS = 60 * 1000;
// ISO 8601 с обязательным часовым поясом: Z или +hh:mm. Без пояса время неоднозначно.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

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

function localDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} в ${localHhmm(date)}`;
}

// Date.parse нормализует несуществующие дни (например 30 февраля).
function validCalendarDate(iso) {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1] && Number(iso.slice(11, 13)) < 24;
}

// Преобразуем местное время ОС в один момент. При переходе часов время может
// не существовать или встречаться дважды; такие случаи требуют уточнения.
function resolveLocalTime(value) {
  const m = LOCAL_TIME.exec(value);
  if (!m || !validCalendarDate(value) || Number(m[5]) > 59 || Number(m[6] || 0) > 59 || Number(m[1]) < 100) return { error: 'неверная дата' };
  const [y, month, day, h, min, sec] = m.slice(1).map((v) => Number(v || 0));
  const utc = Date.UTC(y, month - 1, day, h, min, sec);
  const offsets = new Set();
  for (let minutes = -2880; minutes <= 2880; minutes += 30) offsets.add(new Date(utc + minutes * 60000).getTimezoneOffset());
  const candidates = [...offsets].map((offset) => utc + offset * 60000).filter((ms) => {
    const d = new Date(ms);
    return d.getFullYear() === y && d.getMonth() === month - 1 && d.getDate() === day && d.getHours() === h && d.getMinutes() === min && d.getSeconds() === sec;
  });
  if (!candidates.length) return { error: 'такого местного времени нет из-за перевода часов; уточните время' };
  if (candidates.length > 1) return { error: 'это местное время повторяется при переводе часов; укажите часовой пояс' };
  return { ms: candidates[0] };
}

function remindersTools(store, { now = () => new Date(), workspaceId = () => 'default' } = {}) {
  if (!store || typeof store.add !== 'function' || typeof store.cancel !== 'function') {
    throw new Error('remindersTools: нужен экземпляр ReminderStore');
  }
  const nowMs = () => new Date(now()).getTime();
  const space = () => typeof workspaceId === 'function' ? workspaceId() : workspaceId;

  // Сверка с файлом: напоминание лежит там с тем же временем.
  async function verifySaved(args, result) {
    const saved = store.get(result.data.id, { workspaceId: space() });
    if (!saved) return { status: 'failed', evidence: 'напоминания нет в файле' };
    if (saved.dueAt !== result.data.dueAt) return { status: 'failed', evidence: 'в файле другое время' };
    if (saved.text !== result.data.text) return { status: 'failed', evidence: 'в файле другой текст напоминания' };
    if (saved.done) return { status: 'failed', evidence: 'напоминание уже отмечено выполненным' };
    return { status: 'confirmed', evidence: `напоминание сохранено на ${saved.dueAt}` };
  }

  const remindIn = {
    name: 'remind_in',
    description: `Напомнить через указанное число минут (от 1 до ${MAX_MINUTES}).`,
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'integer', minimum: 1, maximum: MAX_MINUTES },
        text: { type: 'string', minLength: 1, maxLength: MAX_TEXT },
      },
      required: ['minutes', 'text'],
    },
    async run(args = {}) {
      try {
        const minutes = Number(args.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
          return failWith(`минуты: целое от 1 до ${MAX_MINUTES}`);
        }
        const dueAt = new Date(nowMs() + minutes * MINUTE_MS).toISOString();
        const record = store.add({ text: args.text, dueAt, repeat: null, workspaceId: space() });
        return {
          ok: true,
          summary: `напомню через ${minutes} мин`,
          data: { id: record.id, text: record.text, dueAt: record.dueAt },
        };
      } catch (err) {
        return fail(err);
      }
    },
    verify: verifySaved,
  };

  const remindAt = {
    name: 'remind_at',
    description: 'Напомнить в указанный момент. Для местного времени компьютера: YYYY-MM-DDTHH:mm; либо ISO 8601 с часовым поясом. Если время не указано, сначала уточни его.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        at: { type: 'string', description: 'Местное время YYYY-MM-DDTHH:mm или ISO 8601 с часовым поясом' },
        text: { type: 'string', minLength: 1, maxLength: MAX_TEXT },
      },
      required: ['at', 'text'],
    },
    async run(args = {}) {
      try {
        const at = String(args.at ?? '').trim();
        let dueMs;
        if (LOCAL_TIME.test(at)) {
          const local = resolveLocalTime(at);
          if (local.error) return failWith(local.error);
          dueMs = local.ms;
        } else if (ISO_WITH_ZONE.test(at)) dueMs = new Date(at).getTime();
        else return failWith('нужна дата YYYY-MM-DDTHH:mm или ISO 8601 с часовым поясом');
        if (!validCalendarDate(at) || Number.isNaN(dueMs)) return failWith('неверная дата');
        if (dueMs <= nowMs()) return failWith('время уже прошло');
        const record = store.add({ text: args.text, dueAt: new Date(dueMs).toISOString(), repeat: null, workspaceId: space() });
        return {
          ok: true,
          summary: `напомню ${localDateTime(new Date(dueMs))} (местное время)`,
          data: { id: record.id, text: record.text, dueAt: record.dueAt },
        };
      } catch (err) {
        return fail(err);
      }
    },
    verify: verifySaved,
  };

  const listReminders = {
    name: 'list_reminders',
    description: 'Показать невыполненные напоминания по времени срабатывания.',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run() {
      try {
        const items = store.list({ workspaceId: space() }).map(({ id, text, dueAt, repeat }) => ({ id, text, dueAt, repeat }));
        return { ok: true, summary: `напоминаний: ${items.length}`, data: items };
      } catch (err) {
        return fail(err);
      }
    },
  };

  const cancelReminder = {
    name: 'cancel_reminder',
    description: 'Отменить напоминание по id.',
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
        if (!id) return failWith('пустой id');
        if (!store.cancel(id, { workspaceId: space() })) return failWith('такого напоминания нет');
        return { ok: true, summary: 'отменил', data: { id } };
      } catch (err) {
        return fail(err);
      }
    },
    async verify(args, result) {
      return store.get(result.data.id, { workspaceId: space() })
        ? { status: 'failed', evidence: 'напоминание осталось в файле' }
        : { status: 'confirmed', evidence: 'напоминания больше нет в файле' };
    },
  };

  return [remindIn, remindAt, listReminders, cancelReminder];
}

module.exports = { remindersTools, resolveLocalTime, MAX_MINUTES };
