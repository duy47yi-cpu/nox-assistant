'use strict';

// Умное сопоставление фразы владельца с сохранёнными сценариями (командами).
// Чистый модуль: без ввода-вывода, без времени и случайности — одинаковый вход даёт одинаковый ответ.
//
// Что умеет, чего не умеет `CommandStore.findByPhrase`:
// - нормализация шире точного равенства: ё→е, регистр, пунктуация, «пожалуйста», обращение «джарвис»;
// - необязательный стартовый глагол: команда «ютуб» находится по «открой ютуб», «запусти ютуб»,
//   «зайди в ютуб» (глаголы команды в optionalPhrases плюс общий список DEFAULT_START_VERBS);
// - склейка нескольких сценариев в одной фразе по словам «и», «затем», «потом»: «ютуб и громкость 30».
//
// Главное правило: лучше не найти команду, чем угадать не ту. Неоднозначность (две команды подходят
// одинаково) — это null, а фраза целиком уходит обычным путём к модели.
const { normalize } = require('./store');

// Слова-связки: только целыми словами. Внутри слова («игры», «музыку») они не делят.
const DEFAULT_LINK_WORDS = Object.freeze(['и', 'затем', 'потом']);

// Общие стартовые глаголы. Это не часть команды, а вежливая оболочка просьбы:
// «открой ютуб» = «ютуб», «зайди в ютуб» = «ютуб». Список сознательно короткий: чужие глаголы,
// вставленные перед фразой, могут значить другое действие, а угадывать мы не хотим.
const DEFAULT_START_VERBS = Object.freeze([
  'открой', 'открыть', 'открывай',
  'запусти', 'запустить', 'запускай',
  'зайди', 'зайди в', 'зайди на',
  'зайти', 'зайти в', 'зайти на',
  'перейди', 'перейди в', 'перейди на',
  'перейти', 'перейти в', 'перейти на',
  'включи', 'включить', 'включай',
  'выполни', 'выполнить',
]);

// Слова-наполнители: их можно сказать, но в фразе команды их нет.
const FILLER_WORDS = Object.freeze(['джарвис', 'пожалуйста', 'пожалуста', 'пожалуйсто', 'пжлста', 'плиз']);

// Числительные прописью из распознавания речи (whisper.cpp): «двадцать пять» → «25», «сто» → «100».
const SPOKEN_NUMBERS = Object.freeze({
  ноль: 0, нуль: 0,
  один: 1, одна: 1, одну: 1,
  два: 2, две: 2,
  три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
  шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  сто: 100,
});

function replaceSpokenNumbers(text) {
  if (!text) return '';
  const tokens = text.split(' ');
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const cur = SPOKEN_NUMBERS[tokens[i]];
    if (cur !== undefined) {
      const next = i + 1 < tokens.length ? SPOKEN_NUMBERS[tokens[i + 1]] : undefined;
      if (cur >= 20 && cur <= 90 && cur % 10 === 0 && next !== undefined && next >= 1 && next <= 9) {
        out.push(String(cur + next));
        i += 1;
        continue;
      }
      out.push(String(cur));
      continue;
    }
    out.push(tokens[i]);
  }
  return out.join(' ');
}

// Проверка расстояния Дамерау-Левенштейна <= 1 (одна замена, вставка, удаление или перестановка соседних букв).
// Применяется только к фразам длиной >= 5 символов без расхождения в цифрах (PowerToys CmdPal fuzzy-подход).
function isOneEditAway(a, b) {
  if (a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1 || Math.min(la, lb) < 5) return false;
  // Цифры в команде («папка1» vs «папка2», «громкость 20» vs «громкость 30») угадывать нельзя.
  const digitsA = a.replace(/\D+/g, '');
  const digitsB = b.replace(/\D+/g, '');
  if (digitsA !== digitsB) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    // Перестановка двух соседних символов
    if (la === lb && i + 1 < la && a[i] === b[j + 1] && a[i + 1] === b[j]) {
      i += 2;
      j += 2;
      continue;
    }
    if (la > lb) i += 1;
    else if (lb > la) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  if (i < la || j < lb) edits += 1;
  return edits === 1;
}

// Пределы: сообщение — это короткая команда, а не текст. Длинный «мусор» не разбираем и не роняем.
const MAX_TEXT = 400;
const MAX_TOKENS = 60;
const MAX_SEGMENT_TOKENS = 30;
const MAX_PARTS = 10;

const regexEscape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function clipWord(word) {
  const clean = typeof word === 'string' ? word.trim() : '';
  return clean === '' ? '' : normalize(clean);
}

// Обращение в начале: «Джарвис, ...», ««Джарвис» ...», «— Джарвис ...». Только целым словом:
// «джарвисова дочка» обращением не считается.
function stripWake(text, { word = 'джарвис' } = {}) {
  const raw = String(text == null ? '' : text);
  const clean = typeof word === 'string' ? word.trim() : '';
  if (!raw || !clean) return raw;
  const re = new RegExp(`^[^\\p{L}\\p{N}]*${regexEscape(clean)}(?![\\p{L}\\p{N}])[^\\p{L}\\p{N}]*`, 'iu');
  return raw.replace(re, '');
}

// Слова-наполнители убираем в любом месте: «открой, пожалуйста, ютуб» = «открой ютуб».
// Знаки препинания вокруг слова не мешают: «пожалуйста,» и «(пожалуйста)» тоже считаются наполнителем.
function stripFillers(text, { words = FILLER_WORDS } = {}) {
  const set = new Set();
  for (const word of Array.isArray(words) ? words : []) {
    const clean = clipWord(word);
    if (clean) set.add(clean);
  }
  if (set.size === 0) return String(text == null ? '' : text);
  return String(text == null ? '' : text)
    .split(/\s+/)
    .filter((token) => {
      if (token === '') return false;
      const clean = normalize(token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
      return clean === '' || !set.has(clean);
    })
    .join(' ');
}

// Нормализация фразы для сопоставления: нижний регистр, ё→е, без обращения и «пожалуйста»,
// пунктуация как разделитель, одиночные пробелы. Сравниваем так обе стороны — и текст, и фразу команды,
// поэтому старые сохранённые фразы с запятыми и точками тоже находятся.
function normalizePhrase(text) {
  if (typeof text !== 'string') return '';
  let value = text.toLowerCase().replace(/ё/g, 'е');
  value = stripWake(value);
  value = value.replace(/[^\p{L}\p{N}\s-]+/gu, ' ');
  value = value.replace(/\s+/g, ' ').trim();
  value = stripFillers(value);
  value = replaceSpokenNumbers(value.replace(/\s+/g, ' ').trim());
  return value.replace(/\s+/g, ' ').trim();
}

// Фразы команды в нормализованном виде, без пустых и повторов.
function phraseListOf(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const phrase = normalizePhrase(typeof item === 'string' ? item : '');
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
  }
  return out;
}

// Список глаголов: либо задан снаружи (opts.optionalPhrases полностью заменяет общий список),
// либо берём DEFAULT_START_VERBS. Свои глаголы команды добавляются всегда.
function verbListOf(value) {
  const source = Array.isArray(value) ? value : DEFAULT_START_VERBS;
  const seen = new Set();
  const out = [];
  for (const item of source) {
    const verb = normalizePhrase(typeof item === 'string' ? item : '');
    if (!verb || seen.has(verb)) continue;
    seen.add(verb);
    out.push(verb);
  }
  return out;
}

// Команды можно передать массивом, а можно хранилищем с list(): matchSequence(фраза, store).
function commandsOf(commands) {
  if (Array.isArray(commands)) return commands;
  if (commands && typeof commands.list === 'function') {
    try {
      const list = commands.list();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Слова-связки как последовательности токенов: «и», «затем», «потом»; своя связка может быть из двух слов.
function linkSequencesOf(linkWords) {
  const source = Array.isArray(linkWords) && linkWords.length ? linkWords : DEFAULT_LINK_WORDS;
  const seen = new Set();
  const out = [];
  for (const item of source) {
    const phrase = normalizePhrase(typeof item === 'string' ? item : '');
    if (!phrase) continue;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase.split(' '));
  }
  // Длинные связки проверяем первыми: «а затем» важнее одиночного «а».
  out.sort((a, b) => b.length - a.length);
  return out;
}

function linkLengthAt(tokens, index, links) {
  for (const link of links) {
    if (index + link.length > tokens.length) continue;
    let same = true;
    for (let i = 0; i < link.length; i += 1) {
      if (tokens[index + i] !== link[i]) {
        same = false;
        break;
      }
    }
    if (same) return link.length;
  }
  return 0;
}

// Деление фразы по словам-связкам. Возвращает части в порядке текста, связки выброшены.
// «включи игру и музыку» → ['включи игру', 'музыку']; «игрушки» остаётся целым словом.
function splitLinkWords(text, linkWords = DEFAULT_LINK_WORDS) {
  const normalized = normalizePhrase(typeof text === 'string' ? text : '');
  if (!normalized) return [];
  const tokens = normalized.split(' ');
  const links = linkSequencesOf(linkWords);
  const parts = [];
  let current = [];
  for (let i = 0; i < tokens.length;) {
    const length = linkLengthAt(tokens, i, links);
    if (length > 0) {
      if (current.length) parts.push(current.join(' '));
      current = [];
      i += length;
      continue;
    }
    current.push(tokens[i]);
    i += 1;
  }
  if (current.length) parts.push(current.join(' '));
  return parts;
}

// Необязательные глаголы одной команды: общие плюс собственные (optionalPhrases).
function verbsFor(command, globalVerbs) {
  const own = phraseListOf(command && command.optionalPhrases);
  if (own.length === 0) return globalVerbs;
  const seen = new Set(globalVerbs);
  const out = globalVerbs.slice();
  for (const verb of own) {
    if (seen.has(verb)) continue;
    seen.add(verb);
    out.push(verb);
  }
  return out;
}

// Подготовка к сопоставлению: фразы по командам и допустимые глаголы. Строится один раз
// на запрос, чтобы перебор частей в matchSequence не пересобирал карты на каждый кусок.
function prepareMatcher(commands, opts = {}) {
  const list = commandsOf(commands);
  const includeDisabled = opts.includeDisabled === true;
  const globalVerbs = verbListOf(opts.optionalPhrases);
  const byPhrase = new Map();
  const allowedVerbs = new Map();
  const allVerbs = new Set();
  for (const command of list) {
    if (!command || typeof command !== 'object') continue;
    if (!includeDisabled && command.enabled === false) continue;
    const phrases = phraseListOf(command.phrases);
    if (phrases.length === 0) continue;
    for (const phrase of phrases) {
      const owners = byPhrase.get(phrase);
      if (owners) {
        if (!owners.includes(command)) owners.push(command);
      } else {
        byPhrase.set(phrase, [command]);
      }
    }
    const verbs = new Set(verbsFor(command, globalVerbs));
    allowedVerbs.set(command, verbs);
    for (const verb of verbs) allVerbs.add(verb);
  }
  return { byPhrase, allowedVerbs, allVerbs: [...allVerbs] };
}

// Разбор уже нормализованной фразы по подготовленным картам. Порядок строгий:
// 1) точное совпадение фразы (самое сильное, ничем не перекрывается);
// 2) необязательный глагол + фраза команды.
// Если подходят две разные команды одинаково — null: не угадываем.
function matchPrepared(wanted, prepared) {
  if (!wanted) return null;
  const exact = prepared.byPhrase.get(wanted);
  if (exact && exact.length > 1) return null;
  if (exact && exact.length === 1) {
    return { command: exact[0], matched: wanted, phrase: wanted, verb: null, via: 'exact' };
  }
  const byVerb = new Map();
  for (const verb of prepared.allVerbs) {
    const prefix = `${verb} `;
    if (!wanted.startsWith(prefix)) continue;
    const remainder = wanted.slice(prefix.length);
    if (!remainder) continue;
    const commands = prepared.byPhrase.get(remainder);
    if (!commands) continue;
    for (const command of commands) {
      if (byVerb.has(command)) continue;
      const allowed = prepared.allowedVerbs.get(command);
      if (!allowed || !allowed.has(verb)) continue;
      byVerb.set(command, { command, matched: wanted, phrase: remainder, verb });
    }
  }
  if (byVerb.size === 1) {
    const [hit] = byVerb.values();
    return { ...hit, via: 'verb' };
  }
  if (byVerb.size > 1) return null;

  // Запасной шаг для опечатки ASR (1 редакционная правка в слове >= 5 букв, если подходит ровно одна команда).
  const byFuzzy = new Map();
  for (const [phrase, commands] of prepared.byPhrase.entries()) {
    if (isOneEditAway(wanted, phrase)) {
      for (const command of commands) {
        byFuzzy.set(command, { command, matched: wanted, phrase, verb: null, via: 'fuzzy' });
      }
    }
  }
  for (const verb of prepared.allVerbs) {
    const prefix = `${verb} `;
    if (!wanted.startsWith(prefix)) continue;
    const remainder = wanted.slice(prefix.length);
    if (!remainder) continue;
    for (const [phrase, commands] of prepared.byPhrase.entries()) {
      if (!isOneEditAway(remainder, phrase)) continue;
      for (const command of commands) {
        if (byFuzzy.has(command)) continue;
        const allowed = prepared.allowedVerbs.get(command);
        if (!allowed || !allowed.has(verb)) continue;
        byFuzzy.set(command, { command, matched: wanted, phrase, verb, via: 'fuzzy' });
      }
    }
  }
  if (byFuzzy.size === 1) {
    const [hit] = byFuzzy.values();
    return hit;
  }
  return null;
}

// Одна фраза — одна команда. Неоднозначность — null: фраза уйдёт обычным путём к модели.
function matchCommand(text, commands, opts = {}) {
  const wanted = normalizePhrase(typeof text === 'string' ? text : '');
  if (!wanted) return null;
  return matchPrepared(wanted, prepareMatcher(commands, opts));
}

// Разбор по частям: жадный от длинных частей перебор с запоминанием.
// Целая фраза проверяется отдельно (в matchSequence), поэтому здесь ищем только склейку.
// Каждая часть обязана найти команду — иначе деление не годится (половину сценария не запускаем).
function matchSequence(text, commands, opts = {}) {
  const normalized = normalizePhrase(typeof text === 'string' ? text : '');
  if (!normalized || normalized.length > MAX_TEXT) return [];

  // Карты строим один раз: перебор частей не должен пересобирать их на каждый кусок.
  const prepared = prepareMatcher(commands, opts);
  if (prepared.byPhrase.size === 0) return [];

  // Сначала целая фраза как одна команда: команда может сама содержать «и» в своей фразе.
  const single = matchPrepared(normalized, prepared);
  if (single) return [single];

  const tokens = normalized.split(' ');
  if (tokens.length < 3 || tokens.length > MAX_TOKENS) return [];
  const links = linkSequencesOf(opts.linkWords);
  const maxParts = Number.isInteger(opts.maxParts) && opts.maxParts > 0 ? Math.min(opts.maxParts, MAX_PARTS) : MAX_PARTS;
  const memo = new Map();

  // Что стоит после части, кончающейся на end: пропускаем связку целиком.
  const nextStart = (end) => {
    let index = end;
    while (index < tokens.length) {
      const length = linkLengthAt(tokens, index, links);
      if (length === 0) break;
      index += length;
    }
    return index;
  };

  const solve = (start) => {
    if (start >= tokens.length) return [];
    if (memo.has(start)) return memo.get(start);
    memo.set(start, null);
    // Длинная часть важнее: берём самый большой кусок, который находится как команда.
    for (let end = tokens.length; end > start; end -= 1) {
      const cutBefore = end < tokens.length;
      // Режем только перед словом-связкой: иначе «деление» съест слова команды.
      if (cutBefore && linkLengthAt(tokens, end, links) === 0) continue;
      if (end - start > MAX_SEGMENT_TOKENS) continue;
      const chunk = tokens.slice(start, end).join(' ');
      if (!chunk) continue;
      const match = matchPrepared(chunk, prepared);
      if (!match) continue;
      const rest = solve(nextStart(end));
      if (rest === null) continue;
      if (rest.length + 1 > maxParts) continue;
      const result = [match, ...rest];
      memo.set(start, result);
      return result;
    }
    return null;
  };

  return solve(0) || [];
}

module.exports = {
  normalizePhrase,
  stripWake,
  stripFillers,
  splitLinkWords,
  matchCommand,
  matchSequence,
  DEFAULT_LINK_WORDS,
  DEFAULT_START_VERBS,
  FILLER_WORDS,
};
