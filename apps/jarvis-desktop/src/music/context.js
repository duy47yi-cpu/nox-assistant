'use strict';

// Контекстный подбор фоновой музыки по фразе, недавней истории диалога, активным окнам и времени суток.

const { SERVICES, isMusicRequest, cleanQuery, isResetServiceRequest, isPronounPlay, hasOtherSteps } = require('./intent');

// Допустимые «контекстные» и пустые слова в ситуативном музыкальном запросе (названия исполнителей/треков сюда не попадают).
const CONTEXTUAL_TOKEN_RE = /^(?:музык[а-яё]*|музычк[а-яё]*|песн[а-яё]*|песенк[а-яё]*|трек[а-яё]*|мелоди[а-яё]*|плейлист[а-яё]*|подбор[а-яё]*|послуш[а-яё]*|постав[а-яё]*|включ[а-яё]*|запуст[а-яё]*|сыгра[а-яё]*|игра[а-яё]*|подбер[а-яё]*|посовету[а-яё]*|порекоменду[а-яё]*|да[йт][а-яё]*|сдела[а-яё]*|помог[а-яё]*|нужн[а-яё]*|надо|хочет[а-яё]*|хочу|хотел[а-яё]*|мож[а-яё]*|бы|я|мы|мне|нам|себе|тут|здесь|уже|пока|ещ[её]|что-?то|что-?нибудь|чего-?то|чего-?нибудь|какую-?то|какую-?нибудь|любую|любой|любое|хорошую|хорошей|приятную|приятной|классную|крутую|легкую|лёгкую|просто|давай|короче|пожалуйста|сейчас|сегодня|чуть|немного|очень|совсем|максимально|занимаюсь|учусь|пишу|делаю|работаю|сижу|готовлюсь|иду|еду|читаю|для|под|на|в|к|с|со|от|и|или|без|про|по|за|уч[её]б[а-яё]*|экзам[а-яё]*|сесс[а-яё]*|конспект[а-яё]*|домаш[а-яё]*|помодор[а-яё]*|pomodoro|билет[а-яё]*|лекц[а-яё]*|диплом[а-яё]*|курсов[а-яё]*|реферат[а-яё]*|школ[а-яё]*|универ[а-яё]*|пары|пар|код[а-яё]*|программ[а-яё]*|разработ[а-яё]*|дебаг[а-яё]*|верст[а-яё]*|проект[а-яё]*|работ[а-яё]*|фокус[а-яё]*|концентр[а-яё]*|вниман[а-яё]*|фон[а-яё]*|задн[а-яё]*|план[а-яё]*|спокойн[а-яё]*|успокаивающ[а-яё]*|расслабляющ[а-яё]*|расслаб[а-яё]*|отдых[а-яё]*|отдох[а-яё]*|устал[а-яё]*|спат[а-яё]*|сон|сна|сну|дожд[а-яё]*|ноч[а-яё]*|вечер[а-яё]*|утр[а-яё]*|тревож[а-яё]*|потише|тих[а-яё]*|бодр[а-яё]*|энерг[а-яё]*|мотивац[а-яё]*|трен[а-яё]*|спорт[а-яё]*|бег[а-яё]*|зал[а-яё]*|качалк[а-яё]*|кардио|зарядк[а-яё]*|просну[а-яё]*|весел[а-яё]*|груст[а-яё]*|тоск[а-яё]*|печал[а-яё]*|меланхол[а-яё]*|одинок[а-яё]*|настроен[а-яё]*|душу|души|инструментал[а-яё]*|эмбиент[а-яё]*|ambient|lofi|lo-fi|лоу-?фай|слов|ютуб[а-яё]*|youtube|яндекс[а-яё]*|спотифа[а-яё]*|spotify|музыка|джарвис[а-яё]*)$/i;

const DIRECT_CONTEXT_HINT_RE = /(?:^|[^a-zа-яё0-9])(?:помодоро|pomodoro|на\s+фон|фонов[а-яё]*|под\s+настроен|нужн[аоы]?\s+музык|хочется\s+музык|музык[уи]?\s+бы|спокойн[а-яё]*|успокаивающ[а-яё]*|расслабляющ[а-яё]*|потише|бодр[а-яё]*|энергичн[а-яё]*|грустн[а-яё]*|для\s+(?:уч[её]б|экзамен|сесс|код|работ|концентрац|фокус|трен|бег|спорт|сна|отдых|расслабл))(?=$|[^a-zа-яё0-9])/i;

const SOFTEN_HINT_RE = /(?:^|[^a-zа-яё0-9])(?:потише|тихую|тихое|тихой|тихон[а-яё]*|спокойн[а-яё]*|успокаивающ[а-яё]*|расслабляющ[а-яё]*|спать|сон|сна|сну|перед\s+сном|на\s+ночь|ноч[ьиью])(?=$|[^a-zа-яё0-9])/i;

const MOOD_RULES = [
  {
    mood: 'workout_energy',
    re: /(?:^|[^a-zа-яё0-9])(?:трениров[а-яё]*|спорт[а-яё]*|бег[а-яё]*|пробежк[а-яё]*|зал[аеу]?|качалк[а-яё]*|кардио|зарядк[а-яё]*|проснуть[а-яё]*|бодр[а-яё]*|энергичн[а-яё]*|мотивац[а-яё]*)(?=$|[^a-zа-яё0-9])/i,
  },
  {
    mood: 'study_pomodoro',
    re: /(?:^|[^a-zа-яё0-9])(?:уч[её]б[а-яё]*|учу(?:сь)?|экзамен[а-яё]*|сесс[а-яё]*|конспект[а-яё]*|домашк[а-яё]*|домашн[а-яё]*|помодоро|pomodoro|билет[а-яё]*|чита[а-яё]*|лекц[а-яё]*|диплом[а-яё]*|курсов[а-яё]*|реферат[а-яё]*|готовлюсь\s+к\s+(?:экзам|зач|тест|сесс))(?=$|[^a-zа-яё0-9])/i,
  },
  {
    mood: 'coding_focus',
    re: /(?:^|[^a-zа-яё0-9])(?:код[а-яё]*|программ[а-яё]*|пишу\s+код|разработ[а-яё]*|дебаг[а-яё]*|верста[а-яё]*|работа[а-яё]*|рабоч[а-яё]*|фокус[а-яё]*|концентрац[а-яё]*|сосредоточ[а-яё]*)(?=$|[^a-zа-яё0-9])/i,
  },
  {
    mood: 'sad_chill',
    re: /(?:^|[^a-zа-яё0-9])(?:грустн[а-яё]*|грусть|тоск[а-яё]*|печал[а-яё]*|меланхол[а-яё]*|одинок[а-яё]*|хандр[а-яё]*)(?=$|[^a-zа-яё0-9])/i,
  },
  {
    mood: 'sleep_relax',
    re: /(?:^|[^a-zа-яё0-9])(?:устал[а-яё]*|отдохн[а-яё]*|отдых[а-яё]*|расслаб[а-яё]*|спать|сон|сна|сну|перед\s+сном|дожд[а-яё]*|ноч[ьиью]|тревож[а-яё]*|успоко[а-яё]*)(?=$|[^a-zа-яё0-9])/i,
  },
];

const CALM_ADJECTIVE_RE = /(?:^|[^a-zа-яё0-9])(?:потише|тихую|тихое|тихой|спокойн[а-яё]*|успокаивающ[а-яё]*|расслабляющ[а-яё]*|эмбиент|ambient|lofi|lo-fi|лоу-?фай)(?=$|[^a-zа-яё0-9])/i;

const APP_CODING_RE = /\b(?:code|vscode|visual\s+studio|cursor|webstorm|intellij|idea|pycharm|goland|clion|rider|sublime|neovim|nvim|vim|terminal|powershell|wt|iterm|git\s+bash|wsl|github)\b/i;
const APP_STUDY_RE = /\b(?:winword|word|onenote|notion|obsidian|anki|acrobat|foxit|sumatrapdf|libreoffice|writer|powerpoint|coursera|stepik|quizlet|pdf)\b|учеб|лекц|конспект|билет|диплом|курсов/i;

const QUERY_POOLS = {
  study_pomodoro: [
    'lofi hip hop pomodoro study beats calm instrumental',
    'quiet ambient piano study focus music',
    'спокойная фоновая музыка для учебы помодоро',
    'soft instrumental chill beats for studying and reading',
  ],
  coding_focus: [
    'deep focus ambient electronic music for coding',
    'chillstep programming instrumental work focus mix',
    'фоновая музыка для программирования и концентрации',
    'synthwave chill lofi beats for deep work coding',
  ],
  sleep_relax: [
    'calm ambient rain sleep relaxation instrumental music',
    'тихая успокаивающая музыка для отдыха и сна',
    'soft peaceful piano ambient relax evening music',
    'warm acoustic ambient chillout for deep rest',
  ],
  workout_energy: [
    'energetic workout gym motivation electronic mix',
    'бодрая энергичная музыка для тренировки и бега',
    'upbeat cardio running bass fitness mix',
    'high energy motivation beats workout playlist',
  ],
  sad_chill: [
    'melancholic calm indie chill instrumental music',
    'спокойная грустная атмосферная музыка пианино',
    'rainy evening soft lofi sad chill beats',
    'gentle ambient acoustic melancholy mix',
  ],
  general: [
    'chill instrumental background lofi beats mix',
    'приятная фоновая музыка без слов для фона',
    'warm indie chillout instrumental playlist',
    'relaxed acoustic and electronic background mix',
  ],
};

const MOOD_TITLES = {
  study_pomodoro: 'Музыка для учёбы и помодоро',
  coding_focus: 'Музыка для работы и фокуса',
  sleep_relax: 'Спокойная музыка для отдыха',
  workout_energy: 'Энергичная музыка для тренировки',
  sad_chill: 'Спокойная атмосферная музыка',
  general: 'Фоновая музыка под настроение',
};

function tokenizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`.,!?;:()\[\]{}]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/**
 * Отличает запрос с конкретным артистом/песней («мияги бадабум», «тентасион»)
 * от ситуативного/расплывчатого («нужна музыка», «помодоро», «спокойную музыку»).
 */
function isContextualMusicQuery(text, cleanedQuery) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isResetServiceRequest(raw) || isPronounPlay(raw) || hasOtherSteps(raw)) return false;

  const hasCue = isMusicRequest(raw) || DIRECT_CONTEXT_HINT_RE.test(raw);
  if (!hasCue) return false;

  const tokens = tokenizeWords(raw);
  if (cleanedQuery) {
    tokens.push(...tokenizeWords(cleanedQuery));
  }
  if (!tokens.length) return false;

  // Если осталось хотя бы одно слово не из словаря ситуативных/служебных слов — это имя, трек или чужая тема.
  for (const token of tokens) {
    if (!CONTEXTUAL_TOKEN_RE.test(token)) {
      return false;
    }
  }
  return true;
}

function detectStrongMood(text) {
  const s = String(text || '');
  for (const rule of MOOD_RULES) {
    if (rule.re.test(s)) return rule.mood;
  }
  return null;
}

function detectMoodFromHistory(history) {
  if (!Array.isArray(history) || !history.length) return null;
  const tail = history.slice(-6);
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const msg = tail[i];
    if (!msg || msg.role !== 'user') continue;
    const text = typeof msg.content === 'string' ? msg.content : '';
    const found = detectStrongMood(text);
    if (found) return found;
  }
  return null;
}

function appEntryText(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return [entry.title, entry.process, entry.name, entry.app].filter(Boolean).join(' ');
}

function detectMoodFromApps(activeApps) {
  const list = Array.isArray(activeApps) ? activeApps : (activeApps ? [activeApps] : []);
  for (const entry of list) {
    const label = appEntryText(entry);
    if (!label) continue;
    if (APP_STUDY_RE.test(label)) return 'study_pomodoro';
    if (APP_CODING_RE.test(label)) return 'coding_focus';
  }
  return null;
}

function getHour(now) {
  const date = now instanceof Date ? now : (now !== undefined && now !== null ? new Date(now) : new Date());
  if (Number.isNaN(date.getTime())) return new Date().getHours();
  return date.getHours();
}

function classifyMood({ phrase, history, now, activeApps }) {
  const fromPhrase = detectStrongMood(phrase);
  if (fromPhrase) return { mood: fromPhrase, reason: 'phrase' };

  const fromHistory = detectMoodFromHistory(history);
  if (fromHistory) return { mood: fromHistory, reason: 'history' };

  const fromApps = detectMoodFromApps(activeApps);
  if (fromApps) return { mood: fromApps, reason: 'apps' };

  if (CALM_ADJECTIVE_RE.test(String(phrase || ''))) {
    return { mood: 'sleep_relax', reason: 'calm_phrase' };
  }

  const hour = getHour(now);
  if (hour >= 22 || hour < 7) {
    return { mood: 'sleep_relax', reason: 'night' };
  }

  return { mood: 'general', reason: 'default' };
}

function extractHistoryQuery(item) {
  if (!item) return '';
  if (typeof item === 'string') return item.trim().toLowerCase();
  if (typeof item.query === 'string') return item.query.trim().toLowerCase();
  return '';
}

function pickNonRepeatingQuery(mood, musicHistory) {
  const pool = QUERY_POOLS[mood] || QUERY_POOLS.general;
  const entries = Array.isArray(musicHistory) ? musicHistory.map(extractHistoryQuery).filter(Boolean) : [];
  if (!entries.length) return pool[0];

  const recentSet = new Set(entries);
  const fresh = pool.find((q) => !recentSet.has(q.toLowerCase()));
  if (fresh) return fresh;

  const firstUsed = entries[0];
  const lastUsed = entries[entries.length - 1];
  const rotated = pool.find((q) => {
    const norm = q.toLowerCase();
    return norm !== firstUsed && norm !== lastUsed;
  });
  return rotated || pool[entries.length % pool.length];
}

function buildMusicSteps(service, query, softenVolume) {
  const steps = [];
  if (softenVolume) {
    steps.push({ tool: 'volume_set', args: { percent: 25 } });
  }
  if (service === 'yandex' || service === 'spotify') {
    const target = SERVICES[service] || SERVICES.youtube;
    steps.push({ tool: 'url_open', args: { url: target.url(query) } });
  } else {
    steps.push({ tool: 'youtube_play', args: { query, mood: true } });
  }
  return steps;
}

/**
 * Подбирает ситуативный музыкальный запрос и шаги воспроизведения с учётом контекста.
 */
function pickMusicPlan({ phrase = '', history = [], now, activeApps = [], musicService = 'youtube', musicHistory = [] } = {}) {
  const rawPhrase = String(phrase || '').trim();
  const service = SERVICES[musicService] ? musicService : 'youtube';
  const { mood, reason } = classifyMood({ phrase: rawPhrase, history, now, activeApps });
  const softenVolume = SOFTEN_HINT_RE.test(rawPhrase);
  const query = pickNonRepeatingQuery(mood, musicHistory);
  const steps = buildMusicSteps(service, query, softenVolume);
  const label = MOOD_TITLES[mood] || MOOD_TITLES.general;

  return {
    mood,
    reason,
    service,
    query,
    softenVolume,
    label,
    steps,
    summaryReply: softenVolume
      ? `Убавил громкость и включаю: ${label.toLowerCase()}.`
      : `Включаю: ${label.toLowerCase()}.`,
  };
}

module.exports = {
  QUERY_POOLS,
  isContextualMusicQuery,
  pickMusicPlan,
};
