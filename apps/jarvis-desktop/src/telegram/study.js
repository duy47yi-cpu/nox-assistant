'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const { Agent } = require('../agent/loop');
const { ToolRegistry } = require('../tools/registry');
const { writeFileAtomic } = require('../config/atomic');
const { studyTool, studyActivity, STUDY_PROMPT } = require('../tools/study');
const { imageTools } = require('../tools/ocr');
const { writeTarget } = require('../tools/workspace');
const { parseOffline } = require('../shortcuts/offline');
const { looksSecret } = require('../memory/store');
const { MEDIA_LIMIT } = require('./bridge');

function studyIntent(text) {
  const say = String(text || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?]+$/, '');
  if (/^(?:мой\s+)?(?:ответ|решение)\s*[:—-]\s*\S/u.test(say)) return 'attempt';
  if (/^(?:(?:покажи|какой) )?(?:мой |у меня )?(?:учебный )?прогресс(?: по учебе)?$/u.test(say)) return 'progress';
  if (/^(?:дай |давай )?(?:следующую|следующая) (?:учебную |учебная )?задач[ау]$/u.test(say)) return 'next';
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
  if (exercise.needsTranscription) lines.push('Откройте фото на ПК и проверьте условие перед решением.');
  else if (latest?.outcome === 'correct') lines.push('Эту задачу вы уже решили.');
  else {
    if (latest?.hint) lines.push(`Последняя подсказка: ${latest.hint}`);
    lines.push('Пришлите ход решения в сообщении «Мой ответ: …».');
  }
  return lines.join('\n\n');
}

function progressText(topics) {
  if (!topics.length) return 'Учебных попыток пока нет.';
  return ['Прогресс по темам', ...topics.slice(0, 12).map((topic) => {
    const counts = `решено ${topic.solved} из ${topic.exercises}, с первой попытки ${topic.firstTry}, с подсказкой или после повторной попытки ${topic.withHelp}`;
    return `«${topic.topic}» — ${counts}.${topic.difficulty ? ` Стоит повторить: ${topic.difficulty}` : ''}`;
  }), ...(topics.length > 12 ? [`Показаны 12 тем из ${topics.length}.`] : [])].join('\n\n');
}

function reminderTime(text, now) {
  const step = parseOffline(text)?.steps?.[0];
  if (step?.tool === 'remind_in' && /^повторить (?:тему|занятие|уч[её]бу|ошибку)[.!?]*$/iu.test(step.args.text)) {
    return { minutes: step.args.minutes };
  }
  const time = /^напомни(?: мне)? (сегодня|завтра) в (\d{1,2}):(\d{2}) повторить (?:тему|занятие|уч[её]бу|ошибку)[.!?]*$/iu.exec(text.trim());
  if (!time) return null;
  const day = new Date(now);
  if (time[1].toLowerCase() === 'завтра') day.setDate(day.getDate() + 1);
  const pad = (value) => String(value).padStart(2, '0');
  return { at: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad(time[2])}:${time[3]}` };
}

async function importPhoto({ location, tool, status, text, attachment, readPhoto }) {
  const source = attachment?.files?.[0]?.file;
  if (!source) throw new Error('Telegram не передал фото');
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.size > MEDIA_LIMIT) throw new Error('фото недоступно или слишком большое');
  const bytes = fs.readFileSync(source);
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!jpeg && !png) throw new Error('для занятия нужно фото JPG или PNG');
  const file = `Учебное фото ${randomUUID()}.${jpeg ? 'jpg' : 'png'}`;
  const target = writeTarget(location.index, file, ['.jpg', '.png']);
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  let saved;
  try {
    const ocr = await Promise.resolve().then(() => readPhoto(location.index.rootDir, file)).catch(() => null);
    const raw = typeof ocr?.data?.text === 'string' ? ocr.data.text.trim() : '';
    const recognized = ocr?.ok && raw.length <= 1800 && !looksSecret(raw) && raw;
    const topic = text.split(':').slice(1).join(':').trim() || status?.current?.topic || 'Задача с фото';
    saved = tool.run({
      action: 'start', newExercise: true, topic, reference: 'Фото из Telegram',
      exercise: recognized || 'Условие на фотографии.',
    }, { runId: randomUUID(), ownerText: text, studyPhoto: file, needsTranscription: !recognized });
    if (!saved.ok) throw new Error(saved.summary);
  } finally {
    if (!saved?.ok) fs.rmSync(target, { force: true });
  }
  if (tool.verify({ action: 'start' }, saved).status !== 'confirmed' || !fs.lstatSync(target).isFile()) {
    throw new Error('не удалось подтвердить сохранение фотографии');
  }
  return saved.data;
}

function createTelegramStudy({
  locations, pinFile, brain, policy, journal, stop, remind = null, now = () => new Date(),
  readPhoto = (root, file) => imageTools({ workspace: root })[0].run({ path: file }),
}) {
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
    const photo = media?.kind === 'photo' && /^на уч[её]бу(?:\s*:\s*\S.*)?[.!?]*$/iu.test(text);
    if (media?.kind && !photo && !['voice', 'audio'].includes(media.kind)) return null;
    const when = remind && reminderTime(String(text || ''), now());
    const named = /^(?:продолжим|продолжи) (?:занятие|тему)\s*:\s*(\S.*)$/iu.exec(text)?.[1]?.trim();
    const intent = photo ? 'photo' : when ? 'reminder' : named ? 'select' : studyIntent(text);
    if (!intent) return null;

    const candidates = locations();
    const pin = intent === 'attempt' ? readPin(pinFile) : null;
    let lookup = candidates;
    const key = (topic) => String(topic).trim().toLowerCase().replace(/ё/g, 'е');
    const context = { runId: randomUUID(), ownerText: text };
    if (named) {
      lookup = candidates.filter((item) => studyTool(item.file).run({ action: 'status' }, context).data?.topics
        .some((topic) => key(topic.topic) === key(named)));
      if (!lookup.length) return 'Такой темы среди сохранённых занятий нет. Напишите «Мой прогресс», чтобы увидеть темы.';
    }
    const location = intent === 'attempt' ? candidates.find(({ id }) => id === pin?.spaceId)
      : latestLocation(lookup) || (photo && lookup.find((item) => item.selected));
    if (!location) {
      if (intent === 'attempt') return 'Сначала напишите «Продолжим занятие», чтобы я показал, к какой задаче принять ответ.';
      if (intent === 'progress') return progressText([]);
      return intent === 'quick' && !/провер|ошибк/iu.test(text) ? null : 'Сохранённого занятия пока нет. Начните его на ПК в чате Nox AI.';
    }

    const tool = studyTool(location.file, { telegram: true });
    if (named) {
      const selected = tool.run({ action: 'select', topic: named }, context);
      if (!selected.ok) return `Не удалось открыть тему. ${selected.summary}.`;
    }
    const status = tool.run({ action: 'status' }, context);
    if (!status.ok) return `Не удалось открыть занятие. ${status.summary}.`;
    if (intent === 'progress') return progressText(status.data.topics);
    const seed = { current: status.data.current, reviewFocus: status.data.reviewFocus, progress: status.data.progress };
    let exercise = seed.current;
    if (photo) exercise = await importPhoto({ location, tool, status: status.data, text, attachment: media, readPhoto });
    if (!exercise) return 'В этом пространстве пока нет сохранённой задачи.';

    if (when) {
      const focus = seed.progress.focus;
      const detail = focus ? ` Повторить: ${focus.feedback.slice(0, 85)}. Напишите «Давай короткую проверку».` : '';
      return remind(location.id, { ...when, text: `Учёба · ${exercise.topic}.${detail}` });
    }
    if (intent === 'attempt') {
      if (pin.exerciseId !== exercise.id) return 'На ПК открылась другая задача. Напишите «Продолжим занятие», чтобы сверить условие перед ответом.';
      if (exercise.needsTranscription) return 'Сначала откройте фото в чате Nox AI на ПК и уточните условие.';
      if (exercise.attempts.at(-1)?.outcome === 'correct') return 'Эта задача уже решена. Напишите «Дай следующую задачу».';
      const saved = await work(tool, text, { action: 'review', exerciseId: exercise.id }, seed,
        'Владелец прислал ход решения. Проверь только задачу current. Передай дословный фрагмент ответа, оценку, первый ошибочный шаг и подсказку.');
      if (!saved) return 'Попытку не удалось сохранить. Напишите «Продолжим занятие», чтобы сверить текущую задачу.';
      const { outcome, feedback, hint } = saved.latest;
      const label = outcome === 'correct' ? 'Верно.' : outcome === 'incorrect' ? 'В решении есть ошибка.' : 'Решение ещё не закончено.';
      return [label, feedback, hint, outcome === 'correct' ? '' : 'Следующую попытку пришлите как «Мой ответ: …».'].filter(Boolean).join('\n\n');
    }

    let label = photo ? 'Фото сохранено в занятии' : 'Последняя задача';
    const focus = /(?:вчерашней|прошлой) ошибке/iu.test(text) ? seed.reviewFocus : seed.progress?.focus;
    if ((intent === 'quick' || intent === 'next') && focus && !exercise.needsTranscription) {
      label = 'Короткая проверка';
      if (exercise.reviewOf !== focus.id || exercise.attempts.length) {
        const saved = await work(tool, text, { action: 'start', reviewOf: focus.id }, { ...seed, reviewFocus: focus },
          'Подбери одну короткую задачу с новыми данными на ошибку из reviewFocus. В поле exercise дай только условие, без решения.');
        if (!saved) return 'Не удалось сохранить короткую проверку. Напишите «Продолжим занятие», чтобы открыть текущую задачу.';
        exercise = saved;
      }
    } else if ((intent === 'quick' || intent === 'next') && exercise.attempts.at(-1)?.outcome === 'correct') {
      const difficulty = seed.progress.next === 'next_level' ? 'с одним новым шагом' : 'того же уровня';
      const saved = await work(tool, text, { action: 'start', topic: exercise.topic, newExercise: true }, seed,
        `Дай одну новую короткую задачу по теме current, ${difficulty}. В поле exercise дай только условие, без решения.`);
      if (!saved) return 'Не удалось сохранить новую задачу. Скажите «Дай следующую задачу», чтобы повторить.';
      exercise = saved;
      label = 'Следующая задача';
    }
    const pinToSend = { spaceId: location.id, exerciseId: exercise.id };
    return {
      text: [display(exercise, label), ...(photo ? [`На ПК откройте пространство «${location.name}» и напишите «Продолжим занятие».`] : [])].join('\n\n'),
      onSent: () => writeFileAtomic(pinFile, JSON.stringify(pinToSend)),
    };
  };
}

module.exports = { createTelegramStudy };
