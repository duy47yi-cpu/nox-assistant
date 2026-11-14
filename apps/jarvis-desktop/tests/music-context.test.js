'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isMusicRequest, cleanQuery, isPronounPlay } = require('../src/music/intent');
const { isContextualMusicQuery, pickMusicPlan, QUERY_POOLS } = require('../src/music/context');
const { chooseVideo } = require('../src/music/match');
const { youtubeTools } = require('../src/tools/youtube');
const { resolveLocalTurn, resolveLocalTurnAsync } = require('../src/shortcuts/scenarios');
const { runCommand } = require('../src/commands/runner');
const policy = require('../src/policy/modes');

test('isMusicRequest распознаёт разговорные и фоновые запросы, не задевая негативные', () => {
  const positive = [
    'нужна музыка',
    'хочется музыки',
    'музыку бы',
    'занимаюсь учебой, нужна музыка',
    'помодоро музыка',
    'фоновая музыка для учебы',
    'что-то потише и успокаивающее на фон',
    'подбери музыку под настроение',
    'спокойную музыку',
    'фоновая музыка для кода',
  ];
  for (const phrase of positive) {
    assert.equal(isMusicRequest(phrase), true, `ожидалось true для: ${phrase}`);
  }

  const negative = [
    'громкость 30',
    'включи свет',
    'открой github.com',
    'выключи музыку',
    'останови музыку',
    'не нужна музыка',
    'какая музыка играет?',
    'сделай музыку потише',
    'сбрось музыкальный сервис',
  ];
  for (const phrase of negative) {
    assert.equal(isMusicRequest(phrase), false, `ожидалось false для: ${phrase}`);
  }
  assert.equal(isPronounPlay('поставь музыку'), false);
});

test('isContextualMusicQuery отличает названные треки и артистов от ситуативных запросов', () => {
  const namedOrCompound = [
    'мияги бадабум',
    'тентасион',
    'поставь мияги бадабум',
    'включи imagine dragons',
    'поставь спокойную песню басты',
    'поставь её',
    'поставь музыку и закрой все окна',
    'сбрось музыкальный сервис',
  ];
  for (const phrase of namedOrCompound) {
    assert.equal(isContextualMusicQuery(phrase, cleanQuery(phrase)), false, `ожидалось false для: ${phrase}`);
  }

  const contextual = [
    'нужна музыка',
    'хочется музыки',
    'музыку бы',
    'что-нибудь потише для учёбы',
    'помодоро',
    'спокойную музыку',
    'фоновая музыка для кода',
    'занимаюсь учебой, нужна музыка',
    'что-то потише и успокаивающее на фон',
    'подбери музыку под настроение',
  ];
  for (const phrase of contextual) {
    assert.equal(isContextualMusicQuery(phrase, cleanQuery(phrase)), true, `ожидалось true для: ${phrase}`);
  }
});

test('pickMusicPlan классифицирует настроение по фразе, истории, окнам и времени суток', () => {
  const day = new Date(2026, 10, 14, 14, 0, 0);
  const night = new Date(2026, 10, 14, 23, 30, 0);

  assert.equal(pickMusicPlan({ phrase: 'помодоро музыка', now: day }).mood, 'study_pomodoro');
  assert.equal(pickMusicPlan({ phrase: 'пишу код, нужна музыка', now: day }).mood, 'coding_focus');
  assert.equal(pickMusicPlan({ phrase: 'устал, хочется расслабиться', now: day }).mood, 'sleep_relax');
  assert.equal(pickMusicPlan({ phrase: 'иду на тренировку, нужна бодрая музыка', now: night }).mood, 'workout_energy');
  assert.equal(pickMusicPlan({ phrase: 'грустно, нужна музыка', now: day }).mood, 'sad_chill');
  assert.equal(pickMusicPlan({ phrase: 'нужна музыка', now: day }).mood, 'general');

  // История последних 6 сообщений влияет, более старая — нет.
  const recentHistory = [
    { role: 'user', content: 'готовлюсь к экзамену' },
    { role: 'assistant', content: 'Удачи!' },
  ];
  assert.equal(pickMusicPlan({ phrase: 'нужна музыка', history: recentHistory, now: day }).mood, 'study_pomodoro');

  const staleHistory = [
    { role: 'user', content: 'готовлюсь к экзамену' },
    { role: 'assistant', content: '1' },
    { role: 'user', content: '2' },
    { role: 'assistant', content: '3' },
    { role: 'user', content: '4' },
    { role: 'assistant', content: '5' },
    { role: 'user', content: 'просто посижу' },
    { role: 'assistant', content: '6' },
  ];
  assert.equal(pickMusicPlan({ phrase: 'нужна музыка', history: staleHistory, now: day }).mood, 'general');

  // Активные окна: IDE -> coding_focus, учёба/документы -> study_pomodoro, пустой браузер -> general.
  assert.equal(pickMusicPlan({ phrase: 'нужна музыка', activeApps: ['Code.exe'], now: day }).mood, 'coding_focus');
  assert.equal(pickMusicPlan({ phrase: 'нужна музыка', activeApps: ['Obsidian.exe'], now: day }).mood, 'study_pomodoro');
  assert.equal(pickMusicPlan({ phrase: 'нужна музыка', activeApps: ['chrome.exe'], now: day }).mood, 'general');

  // Ночное время (>=22 или <7) выбирает sleep_relax, но не трогает громкость без явного намёка во фразе.
  const nightPlan = pickMusicPlan({ phrase: 'нужна музыка', now: night });
  assert.equal(nightPlan.mood, 'sleep_relax');
  assert.equal(nightPlan.softenVolume, false);
  assert.deepEqual(nightPlan.steps, [{ tool: 'youtube_play', args: { query: nightPlan.query, mood: true } }]);
});

test('pickMusicPlan не повторяет последний запрос из musicHistory и мягко снижает громкость при намёке', () => {
  const day = new Date(2026, 10, 14, 15, 0, 0);
  const first = pickMusicPlan({ phrase: 'помодоро музыка', now: day, musicHistory: [] });
  const second = pickMusicPlan({ phrase: 'помодоро музыка', now: day, musicHistory: [first.query] });
  assert.notEqual(second.query, first.query);
  assert.ok(QUERY_POOLS.study_pomodoro.includes(second.query));

  // При явном намёке «потише / успокаивающее / ночь» добавляется volume_set 25 перед воспроизведением.
  const soft = pickMusicPlan({ phrase: 'что-то потише и успокаивающее на фон', now: day });
  assert.equal(soft.softenVolume, true);
  assert.equal(soft.steps.length, 2);
  assert.deepEqual(soft.steps[0], { tool: 'volume_set', args: { percent: 25 } });
  assert.equal(soft.steps[1].tool, 'youtube_play');
  assert.equal(soft.steps[1].args.mood, true);
});

test('pickMusicPlan формирует шаги для youtube, youtube_music, yandex и spotify', () => {
  const day = new Date(2026, 10, 14, 12, 0, 0);

  const yt = pickMusicPlan({ phrase: 'нужна музыка', now: day, musicService: 'youtube' });
  assert.equal(yt.steps[0].tool, 'youtube_play');
  assert.equal(yt.steps[0].args.mood, true);

  const ytm = pickMusicPlan({ phrase: 'нужна музыка', now: day, musicService: 'youtube_music' });
  assert.equal(ytm.steps[0].tool, 'youtube_play');
  assert.equal(ytm.steps[0].args.mood, true);

  const ya = pickMusicPlan({ phrase: 'нужна музыка', now: day, musicService: 'yandex' });
  assert.equal(ya.steps[0].tool, 'url_open');
  assert.match(ya.steps[0].args.url, /^https:\/\/music\.yandex\.ru\/search\?text=/);

  const sp = pickMusicPlan({ phrase: 'нужна музыка', now: day, musicService: 'spotify' });
  assert.equal(sp.steps[0].tool, 'url_open');
  assert.match(sp.steps[0].args.url, /^https:\/\/open\.spotify\.com\/search\//);
});

test('chooseVideo с mood=true пропускает Shorts и уверенно выбирает лучшее длинное видео', async () => {
  const candidates = [
    { id: 's1', title: 'lofi hip hop pomodoro #shorts', url: 'https://www.youtube.com/watch?v=s1' },
    { id: 's2', title: 'lofi beats', url: 'https://www.youtube.com/shorts/s2' },
    { id: 'long1', title: 'Calm Study Mix 2 Hours', url: 'https://www.youtube.com/watch?v=long1' },
    { id: 'long2', title: 'lofi hip hop pomodoro study mix', url: 'https://www.youtube.com/watch?v=long2' },
  ];

  const strictPick = chooseVideo('lofi hip hop pomodoro study beats', candidates);
  assert.equal(strictPick.confident, false);
  assert.equal(strictPick.video.id, 'long2');

  const moodPick = chooseVideo('lofi hip hop pomodoro study beats', candidates, { mood: true });
  assert.equal(moodPick.confident, true);
  assert.equal(moodPick.video.id, 'long2');

  const shortsOnlyPick = chooseVideo('lofi beats', candidates.slice(0, 2), { mood: true });
  assert.equal(shortsOnlyPick.video, null);
  assert.equal(shortsOnlyPick.confident, false);

  const opened = [];
  const [ytPlay] = youtubeTools(
    {
      run: async ({ url }) => { opened.push(url); return { ok: true, summary: url, data: { url } }; },
      verify: async () => ({ ok: true }),
    },
    { find: async () => candidates }
  );

  // Без mood=true youtube_play просит уточнение; с mood=true сразу открывает длинное видео.
  const askRes = await ytPlay.run({ query: 'lofi hip hop pomodoro study beats' });
  assert.equal(askRes.quiet, true);
  assert.equal(opened.length, 0);

  const moodRes = await ytPlay.run({ query: 'lofi hip hop pomodoro study beats', mood: true });
  assert.equal(moodRes.ok, true);
  assert.equal(moodRes.quiet, undefined);
  assert.deepEqual(opened, ['https://www.youtube.com/watch?v=long2']);
});

test('интеграция в resolveLocalTurn / resolveLocalTurnAsync: работает как фоллбек и не перебивает явные треки', async () => {
  const plan = resolveLocalTurn('что-то потише и успокаивающее на фон', { now: new Date(2026, 10, 14, 15, 0, 0) });
  assert.ok(plan);
  assert.equal(plan.source, 'music-context');
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps[0], { tool: 'volume_set', args: { percent: 25 } });
  assert.equal(plan.steps[1].tool, 'youtube_play');
  assert.equal(plan.steps[1].args.mood, true);

  const studyPlan = await resolveLocalTurnAsync('занимаюсь учебой, нужна музыка', { now: new Date(2026, 10, 14, 15, 0, 0) });
  assert.equal(studyPlan.source, 'music-context');
  assert.equal(studyPlan.mood, 'study_pomodoro');

  assert.equal(resolveLocalTurn('помодоро музыка').source, 'music-context');
  assert.equal(resolveLocalTurn('подбери музыку под настроение').source, 'music-context');

  // Конкретный трек или многошаговая фраза не перехватываются ситуативным резолвером.
  assert.equal(resolveLocalTurn('поставь мияги бадабум'), null);
  assert.equal(resolveLocalTurn('поставь спокойную музыку и закрой все окна'), null);

  // Сохранённая команда владельца побеждает.
  const store = {
    list: () => [{
      id: 'my-study-music',
      name: 'Моя музыка для помодоро',
      phrases: ['помодоро музыка'],
      steps: [{ tool: 'url_open', args: { url: 'https://music.yandex.ru/home' } }],
    }],
  };
  const custom = resolveLocalTurn('помодоро музыка', { store });
  assert.equal(custom.source, 'command');
  assert.equal(custom.steps[0].tool, 'url_open');

  // Сквозной прогон через runCommand.
  const log = [];
  const tools = new Map([
    ['volume_set', { name: 'volume_set', risk: 'T0', run: async (a) => { log.push(['volume_set', a]); return { ok: true, summary: '25%' }; } }],
    ['youtube_play', { name: 'youtube_play', risk: 'T1', run: async (a) => { log.push(['youtube_play', a]); return { ok: true, summary: a.query }; } }],
  ]);
  const runRes = await runCommand(plan, { tools, mode: 'full', policy });
  assert.equal(runRes.ok, true);
  assert.equal(log[0][0], 'volume_set');
  assert.equal(log[1][0], 'youtube_play');
  assert.equal(log[1][1].mood, true);
});
