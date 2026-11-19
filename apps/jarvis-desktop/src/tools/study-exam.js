'use strict';

const { resolveLocalTime } = require('./reminders');
const { looksSecret } = require('../memory/store');
const { studyTool } = require('./study');

const HOUR = 3600000;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const EXAM = /контрольн|экзамен|зач[её]т/iu;
const key = (text) => text.trim().toLowerCase().replace(/ё/g, 'е');
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_DAY = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?`, 'iu');

function matchesDay(text, at, now) {
  const date = new Date(at);
  const iso = /\d{4}-\d{2}-\d{2}/u.exec(text)?.[0];
  if (iso) return at.startsWith(iso);
  const relative = /(?:^|\s)(завтра|сегодня|послезавтра)(?=[\s,.!?]|$)/iu.exec(text)?.[1]?.toLowerCase();
  if (relative) {
    const expected = new Date(now);
    expected.setDate(expected.getDate() + ['сегодня', 'завтра', 'послезавтра'].indexOf(relative));
    return date.toDateString() === expected.toDateString();
  }
  const numeric = /(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?(?!\d)/u.exec(text);
  const words = MONTH_DAY.exec(text);
  const day = numeric || words;
  return Boolean(day && date.getDate() === Number(day[1]) &&
    date.getMonth() === (numeric ? Number(day[2]) - 1 : MONTHS.indexOf(day[2].toLowerCase())) &&
    (!day[3] || date.getFullYear() === Number(day[3])));
}

function studyData(file) {
  return studyTool(file).run({ action: 'status' }, { runId: 'exam', ownerText: 'Учебная проверка' }).data;
}

function examReminderText(item, file, now = Date.now()) {
  const exam = item.studyExam;
  if (!exam) return item.text;
  if (now >= Date.parse(exam.at)) return '';
  const progress = studyData(file)?.topics.find((topic) => key(topic.topic) === key(exam.topic));
  const focus = progress?.difficulty ? ` Повтори: ${progress.difficulty.slice(0, 95)}.` : '';
  return `Перед контрольной по теме «${exam.topic}».${focus} Скажи «Давай короткую проверку» в этой теме.`;
}

function studyExamTool({ store, file, workspaceId = 'default', now = Date.now }) {
  return {
    name: 'study_exam',
    risk: 'T0',
    description: 'Запланировать одну короткую учебную проверку перед контрольной, зачётом или экзаменом. Используй, когда владелец явно сообщил о предстоящей проверке и назвал время. Если времени нет, уточни. at передавай как YYYY-MM-DDTHH:mm по местным часам.',
    parameters: {
      type: 'object',
      properties: { at: { type: 'string' }, topic: { type: 'string', maxLength: 160 } },
      required: ['at'],
    },
    run(args, ctx = {}) {
      try {
        const ownerText = String(ctx.ownerText || '');
        const stated = /(?:^|\s)(\d{1,2}):(\d{2})(?!\d)/u.exec(ownerText);
        if (ctx.background || !EXAM.test(ownerText) || !stated) throw new Error('нужны дата и время учебной проверки от владельца');
        const topic = (args.topic || studyData(file)?.current?.topic || '').trim();
        if (!topic || topic.length > 160 || looksSecret(topic)) throw new Error('нужно название учебной темы');
        if (!DATE.test(args.at)) throw new Error('нужны дата и местное время контрольной');
        if (!args.at.endsWith(`${stated[1].padStart(2, '0')}:${stated[2]}`)) throw new Error('время отличается от названного владельцем');
        const current = Number(now());
        if (!matchesDay(ownerText, args.at, current)) throw new Error('нужна дата, совпадающая с названной владельцем');
        const parsed = resolveLocalTime(args.at);
        if (parsed.error) throw new Error(parsed.error);
        const until = parsed.ms - current;
        if (until < 60000) throw new Error('контрольная должна быть в будущем');
        const at = new Date(parsed.ms).toISOString();
        const old = store.list({ includeDone: true, workspaceId })
          .find((item) => item.studyExam?.at === at && key(item.studyExam.topic) === key(topic));
        const lead = until > 25 * HOUR ? until - 24 * HOUR : until > 3 * HOUR ? until - 2 * HOUR : Math.round(until / 2);
        const item = old || store.add({
          workspaceId, text: `Повторить тему «${topic}» перед контрольной`,
          dueAt: new Date(current + lead), studyExam: { topic, at },
        });
        return { ok: true, summary: old ? 'Учебная проверка уже запланирована' : 'Учебная проверка запланирована',
          data: { id: item.id, topic, dueAt: item.dueAt, examAt: at, done: item.done } };
      } catch (err) {
        return { ok: false, summary: err.message };
      }
    },
    verify(_args, result) {
      const saved = store.get(result.data.id, { workspaceId });
      const ok = saved?.dueAt === result.data.dueAt && saved?.studyExam?.at === result.data.examAt;
      return { status: ok ? 'confirmed' : 'failed', evidence: ok ? 'учебная проверка есть в расписании' : 'записи в расписании нет' };
    },
  };
}

module.exports = { studyExamTool, examReminderText };
