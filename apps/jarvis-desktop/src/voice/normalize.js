'use strict';

// Пост-коррекция распознанной речи для команд Nox.
// Чистый модуль: без файлов, сети, времени и случайности — одинаковый вход даёт одинаковый выход.
// Источник правил: замер на 30 фразах (rev/VOICE_FIX_PROTOTYPE.md) и словарь rev/voice_aliases.json.
// Главное правило: только словарные замены целыми словами; чего нет в словаре — не трогаем.
// Порядок: регистр/ё/пунктуация → филлеры → предохранитель → склейки → числа по контексту → имена.
// Предохранитель (отрицание/опасное/секреты/перевод денег) выключает словарь целиком.

const NUMERALS = new Map(Object.entries({
  ноль: 0, нуль: 0,
  один: 1, одна: 1, одну: 1,
  два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
  шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  сто: 100,
}));

const UNIT_AFTER = new Set([
  'минута', 'минуту', 'минуты', 'минут',
  'секунда', 'секунду', 'секунды', 'секунд',
  'час', 'часа', 'часов',
  'градус', 'градуса', 'градусов',
  'процент', 'процента', 'процентов',
  'этаж', 'этажа', 'этажей',
  'шаг', 'шага', 'шагов',
  'день', 'дня', 'дней', 'неделя', 'недели', 'недель',
  'режим', 'режима', 'канал', 'канала', 'уровень', 'уровня',
  'номер', 'версия', 'версии', 'страница', 'страницы',
  'балл', 'балла', 'баллов', 'серия', 'серии',
]);

const SELECTOR_BEFORE = new Set([
  'на', 'через', 'громкость', 'уровень', 'режим', 'версия', 'номер', 'канал',
  'до', 'после', 'около', 'ровно', 'таймер',
]);

// Обороты, где число — не про проценты и минуты: «один раз», «в два раза», «половина».
// «половина» в NUMERALS отсутствует намеренно.
const BLOCK_AFTER = new Set(['раз', 'раза', 'разом', 'половина', 'части', 'часть']);

// Филлеры в любом месте. Список шире FILLER_WORDS из match.js и не заменяет его:
// match.js#stripFillers остаётся API для src/shortcuts/scenarios.js.
const FILLERS = [
  ['будь', 'добр'], ['будьте', 'добры'],
  ['джарвис'], ['джарвиз'], ['жарвис'], ['сэр'],
  ['пожалуйста'], ['пожалуста'], ['пожалуйсто'], ['пжлста'], ['плиз'],
  ['спасибо'], ['дружище'],
];

// Вводные слова — снимаются только в начале фразы.
const DISCOURSE_FILLERS = new Set(['слушай', 'ну', 'а', 'вот', 'э', 'эм', 'короче']);

// Склейки и разрезания: только exact-пары токенов, длинные раньше.
const SEGMENTATION = [
  [['компьютер', 'с', 'пять'], ['компьютер', 'с', '5']],
  [['компьютерспять'], ['компьютер', 'с', '5']],
  [['компьютер', 'спять'], ['компьютер', 'с', '5']],
  [['компьютерс', 'пять'], ['компьютер', 'с', '5']],
  [['игровая', 'режим'], ['игровой', 'режим']],
  [['в', 'се'], ['все']],
  [['во', 'се'], ['все']],
  [['игровый'], ['игровой']],
];

// Имена: только exact-пары, длинные фразы раньше. Identity-записи не нужны.
// «ютубе» — предложный падеж из замера (фраза 14), без него §6.1 №6 не совпадает с каноном.
const NAMES = [
  [['ютюб'], ['youtube']], [['ю', 'туб'], ['youtube']], [['ютуб'], ['youtube']], [['ютубе'], ['youtube']],
  [['лафимикс'], ['лофемикс']], [['хелэк'], ['халок']],
  [['свич', 'шоу'], ['switch', 'show']],
  [['дота', 'два'], ['dota', '2']], [['дота', '2'], ['dota', '2']],
  [['стим'], ['steam']], [['телеграм'], ['telegram']], [['телеграмм'], ['telegram']],
  [['дискорд'], ['discord']], [['хром'], ['chrome']], [['спотифай'], ['spotify']],
  [['фотошоп'], ['photoshop']], [['майнкрафт'], ['minecraft']], [['нотион'], ['notion']],
  [['вс', 'код'], ['vs', 'code']], [['виэс', 'код'], ['vs', 'code']],
  [['яндексе'], ['яндекс']],
];

const NEGATIONS = new Set(['не', 'ни', 'нет', 'нельзя', 'никогда']);
const DANGER = /^(удали|удалить|удаление|удаля|сотри|стереть|стира|оплати|оплатить|оплата|отправь|отправить|отправка|очисти|очистить|очистка|установи|установить|установка|выключи|выключить|перезагрузи|перезагрузить|переустанови|переустановить|отформатируй|формат|купи|купить|куплю|покуп|продай|продать|забань|взломай|прочита|прочитать|прочти)/u;
const SENSITIVE = new Set([
  'банк', 'банка', 'банке', 'банком', 'банки',
  'пароль', 'пароля', 'паролю', 'паролем', 'пароли',
  'bitwarden', 'битварден', 'кошелёк', 'кошелек', 'кошелька',
]);
const MONEY = new Set([
  'рубль', 'рубля', 'рублей', 'доллар', 'доллара', 'долларов', 'евро',
  'карта', 'карты', 'карту', 'картой', 'карте',
  'счет', 'счёт', 'баланс', 'деньги', 'денег', 'деньгами', 'монета', 'монеты',
  'платеж', 'платёж', 'перевод', 'перевода',
]);
const MONEY_ACTION = /^(перевед|перевод|сним|снять|спиш|спис)/u;

// Подсказка облачному распознавателю. Латиница — как должно прийти в тексте, кириллица — слова команд.
const HOTWORD_NAMES = [
  'YouTube', 'Switch show', 'Dota 2', 'Steam', 'Telegram', 'Discord', 'Chrome',
  'Spotify', 'Photoshop', 'Minecraft', 'Notion', 'VS Code', 'лофемикс', 'Халок',
];
const HOTWORD_COMMANDS = [
  'сверни все окна', 'верни все окна', 'активируй игровой режим',
  'запусти игровой режим', 'открой проводник', 'диспетчер задач',
  'найди курс доллара', 'открой погоду', 'поставь таймер на 30 минут',
  'переведи компьютер с 5 в режим', 'закрой окно',
];
// Ограничение Groq/Whisper: prompt <= 224 токена (rev/STT_OPTIONS.md, строка 122).
// Токенизатора в проекте нет, поэтому держим символьный потолок с запасом: 400 симв.
const MAX_CLOUD_PROMPT = 400;

function sortedRows(rows) {
  return rows.slice().sort((a, b) => b[0].length - a[0].length);
}

const FILLER_ROWS = sortedRows(FILLERS.map((source) => [source, null]));
const SEGMENTATION_ROWS = sortedRows(SEGMENTATION);
const NAME_ROWS = sortedRows(NAMES);

// Один проход по токенам: длинные правила первыми, цели замен не пересобираются заново.
function applyRows(tokens, rows) {
  const out = [];
  for (let index = 0; index < tokens.length;) {
    let applied = false;
    for (const [source, target] of rows) {
      if (index + source.length > tokens.length) continue;
      let same = true;
      for (let offset = 0; offset < source.length; offset += 1) {
        if (tokens[index + offset] !== source[offset]) { same = false; break; }
      }
      if (!same) continue;
      if (target) out.push(...target);
      index += source.length;
      applied = true;
      break;
    }
    if (!applied) { out.push(tokens[index]); index += 1; }
  }
  return out;
}

function baseNormalize(text) {
  let value = String(text == null ? '' : text).toLowerCase().replace(/ё/g, 'е');
  value = value.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return value.replace(/\s+/g, ' ').trim();
}

function stripFillerTokens(tokens) {
  let out = applyRows(tokens, FILLER_ROWS);
  while (out.length > 0 && DISCOURSE_FILLERS.has(out[0])) out = out.slice(1);
  return out;
}

function aliasesBlocked(tokens) {
  if (tokens.some((token) => NEGATIONS.has(token))) return true;
  if (tokens.some((token) => DANGER.test(token))) return true;
  if (tokens.some((token) => SENSITIVE.has(token))) return true;
  const money = tokens.some((token) => MONEY.has(token));
  return money && tokens.some((token) => MONEY_ACTION.test(token));
}

function numeralAt(tokens, index) {
  const current = NUMERALS.get(tokens[index]);
  if (current === undefined) return null;
  const nextWord = tokens[index + 1];
  const next = nextWord === undefined ? undefined : NUMERALS.get(nextWord);
  if (current >= 20 && current <= 90 && current % 10 === 0 && next >= 1 && next <= 9) {
    return { value: current + next, size: 2 };
  }
  return { value: current, size: 1 };
}

function applyNumbers(tokens) {
  const out = [];
  for (let index = 0; index < tokens.length;) {
    const found = numeralAt(tokens, index);
    if (!found) { out.push(tokens[index]); index += 1; continue; }
    const after = index + found.size;
    const next = tokens[after];
    const previous = index > 0 ? tokens[index - 1] : '';
    const allowed = UNIT_AFTER.has(next)
      || (SELECTOR_BEFORE.has(previous) && !BLOCK_AFTER.has(next));
    if (allowed) out.push(String(found.value));
    else for (let offset = index; offset < after; offset += 1) out.push(tokens[offset]);
    index = after;
  }
  return out;
}

// Главная точка входа. Возвращает нормализованную строку; на опасных фразах — только шаги 0–1.
// Не строка (null, число) — пустая строка: тот же контракт, что у normalizePhrase в match.js.
function normalizeSpeech(text) {
  if (typeof text !== 'string') return '';
  const base = baseNormalize(text);
  if (!base) return '';
  let tokens = stripFillerTokens(base.split(' '));
  if (tokens.length === 0) return '';
  if (aliasesBlocked(tokens)) return tokens.join(' ');
  tokens = applyRows(tokens, SEGMENTATION_ROWS);
  tokens = applyNumbers(tokens);
  tokens = applyRows(tokens, NAME_ROWS);
  return tokens.join(' ');
}

// Обрезка подсказки по границе слова: без токенизатора — символьный потолок, обрезка не рвёт слово.
function clipPrompt(text, limit = MAX_CLOUD_PROMPT) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[,\s]+$/u, '');
}

function buildHotwords({ names = HOTWORD_NAMES, commands = HOTWORD_COMMANDS } = {}) {
  return clipPrompt([...names, ...commands].join(', '));
}

module.exports = {
  normalizeSpeech,
  baseNormalize,
  aliasesBlocked,
  buildHotwords,
  clipPrompt,
  MAX_CLOUD_PROMPT,
  HOTWORD_NAMES,
  HOTWORD_COMMANDS,
};
