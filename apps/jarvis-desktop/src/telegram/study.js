'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const { Agent } = require('../agent/loop');
const { ToolRegistry } = require('../tools/registry');
const { writeFileAtomic } = require('../config/atomic');
const { studyTool, studyActivity, STUDY_PROMPT } = require('../tools/study');

function studyIntent(text) {
  const say = String(text || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?]+$/, '');
  if (/^(?:мой\s+)?(?:ответ|решение)\s*[:—-]\s*\S/u.test(say)) return 'attempt';
  if (/^(?:у меня (?:есть )?|есть )(?:\d{1,2}|пять|десять|пятнадцать|двадцать) минут[ауы]?(?: на (?:учебу|занятие|проверку))?$/u.test(say) ||
      /^(?:дай |давай |начни )?(?:короткую|быструю|короткая|быстрая) (?:учебную |учебная )?проверк[ау](?: по (?:прошлой|вчерашней) ошибке)?$/u.test(say) ||
      /^(?:проверь|потренируй) меня (?:по (?:прошлой|вчерашней) ошибке|по вчерашней теме)$/u.test(say)) return 'quick';
  if (/^(?:давай )?(?:продолжим|продолжи|возобнови) (?:(?:вчерашнее|учебное) )?(?:учебу|занятие|урок|подготовку)(?: .+)?$/u.test(say) ||
      /^(?:покажи|напомни) (?:последнюю |учебную |вчерашнюю )+(?:задачу|тему)$/u.test(say)) return 'resume';
  return '';
}

function readPin(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('связь с учебной задачей не читается');
    const pin = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof pin?.spaceId !== 'string' || typeof pin?.exerciseId !== 'string') throw new Error('связь с учебной задачей повреждена');
    return pin;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function latestLocation(locations) {
  let latest = null;
  let time = 0;
  for (const location of locations) {
    const at = studyActivity(location.file);
    if (at > time) {
      latest = location;
      time = at;
    }
  }
  return latest;
}

function display(exercise, label) {
  const latest = exercise.attempts.at(-1);
  const lines = [`${label} по теме «${exercise.topic}».`, exercise.exercise];
  if (exercise.reference) lines.push(`Источник: ${exercise.reference}.`);
  if (latest?.outcome === 'correct') lines.push('Эту задачу вы уже решили.');
  else {
    if (latest?.hint) lines.push(`Последняя подсказка: ${latest.hint}`);
    lines.push('Пришлите ход решения в сообщении «Мой ответ: …».');
  }
  return lines.join('\n\n');
}

function createTelegramStudy({ locations, pinFile, brain, policy, journal, stop }) {
  async function work(tool, text, boundary, seed, instruction) {
    let saved = null;
    const registry = new ToolRegistry();
    registry.register({
      ...tool,
      run(args, ctx) {
        if (args.action === 'status') return { ok: true, summary: 'Текущее занятие', data: seed };
        if (args.action !== boundary.action) return { ok: false, summary: 'действие недоступно для этой просьбы' };
        return tool.run({ ...args, ...boundary }, ctx);
      },
      verify(args, result) {
        const checked = tool.verify(args, result);
        if (args.action === boundary.action && checked.status === 'confirmed') saved = result.data;
        return checked;
      },
    });
    const agent = new Agent({
      brain, tools: registry, policy, journal, stop, maxSteps: 5, turnDeadlineMs: 60000,
      systemPrompt: `${STUDY_PROMPT}\n${instruction} Сначала прочитай status. Начинай ответ после записи. Пользователю покажут сохранённую запись.`,
    });
    await agent.run(text, { ownerText: text });
    return saved;
  }

  return async (text, media) => {
    if (media?.kind && !['voice', 'audio'].includes(media.kind)) return null;
    const intent = studyIntent(text);
    if (!intent) return null;

    const candidates = locations();
    const pin = intent === 'attempt' ? readPin(pinFile) : null;
    const location = intent === 'attempt' ? candidates.find(({ id }) => id === pin?.spaceId) : latestLocation(candidates);
    if (!location) {
      if (intent === 'attempt') return 'Сначала напишите «Продолжим занятие», чтобы я показал, к какой задаче принять ответ.';
      return intent === 'quick' && !/провер|ошибк/iu.test(text) ? null : 'Сохранённого занятия пока нет. Начните его на ПК в чате Nox AI.';
    }

    const tool = studyTool(location.file, { telegram: true });
    const status = tool.run({ action: 'status' }, { runId: randomUUID(), ownerText: text });
    if (!status.ok) return `Не удалось открыть занятие. ${status.summary}.`;
    const seed = { current: status.data.current, reviewFocus: status.data.reviewFocus };
    let exercise = seed.current;
    if (!exercise) return 'В этом пространстве пока нет сохранённой задачи.';

    if (intent === 'attempt') {
      if (pin.exerciseId !== exercise.id) return 'На ПК открылась другая задача. Напишите «Продолжим занятие», чтобы сверить условие перед ответом.';
      if (exercise.attempts.at(-1)?.outcome === 'correct') return 'Эта задача уже решена. Напишите «Давай короткую проверку», чтобы повторить прошлую ошибку.';
      const saved = await work(tool, text, { action: 'review', exerciseId: exercise.id }, seed,
        'Владелец прислал ход решения. Проверь только задачу current. Передай дословный фрагмент ответа, оценку, первый ошибочный шаг и подсказку.');
      if (!saved) return 'Попытку не удалось сохранить. Напишите «Продолжим занятие», чтобы сверить текущую задачу.';
      const { outcome, feedback, hint } = saved.latest;
      const label = outcome === 'correct' ? 'Верно.' : outcome === 'incorrect' ? 'В решении есть ошибка.' : 'Решение ещё не закончено.';
      return [label, feedback, hint, outcome === 'correct' ? '' : 'Следующую попытку пришлите как «Мой ответ: …».'].filter(Boolean).join('\n\n');
    }

    let label = 'Последняя задача';
    if (intent === 'quick' && seed.reviewFocus) {
      label = 'Короткая проверка';
      if (exercise.reviewOf !== seed.reviewFocus.id || exercise.attempts.length) {
        const saved = await work(tool, text, { action: 'start', reviewOf: seed.reviewFocus.id }, seed,
          'Подбери одну короткую задачу с новыми данными на ошибку из reviewFocus. В поле exercise дай только условие, без решения.');
        if (!saved) return 'Не удалось сохранить короткую проверку. Напишите «Продолжим занятие», чтобы открыть текущую задачу.';
        exercise = saved;
      }
    }
    const pinToSend = { spaceId: location.id, exerciseId: exercise.id };
    return {
      text: display(exercise, label),
      onSent: () => writeFileAtomic(pinFile, JSON.stringify(pinToSend)),
    };
  };
}

module.exports = { createTelegramStudy };
