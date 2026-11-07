'use strict';

const { MAX_TEXT } = require('../schedule/store');
const { MAX_MINUTES } = require('../tools/reminders');

// Короткие фразы без модели: «громкость 50», «окна свернуть», «таймер 5 минут», «открой ютуб».
// Разбор только по точным шаблонам (вся фраза целиком). Всё остальное, включая опасные слова,
// возвращает null и идёт обычным путём к модели. Сам разбор ничего не запускает:
// вызывающий отдаёт шаги в исполнитель команд, а там их проверяют decide и verify.

const SITES = {
  ютуб: 'https://www.youtube.com',
  youtube: 'https://www.youtube.com',
  гугл: 'https://www.google.com',
  google: 'https://www.google.com',
  википедия: 'https://ru.wikipedia.org',
};

// Программы из короткого списка. Имя передаётся в app_open, сама программа ищется там же.
const PROGRAMS = {
  блокнот: 'notepad',
  калькулятор: 'calc',
};

// Страховка: такие слова никогда не разбираются здесь, даже если шаблон подошёл бы.
const DANGER = /удал|выключ|перезагруз|отправ|оплат|плат|перевед|купи|продай|пароль/;
const NUMBER_WORDS = { один: 1, одна: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90 };

function spokenNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const words = value.toLocaleLowerCase().replace(/ё/g, 'е').split(/\s+/);
  if (words.length === 1) return NUMBER_WORDS[words[0]] ?? NaN;
  const tens = NUMBER_WORDS[words[0]];
  const ones = NUMBER_WORDS[words[1]];
  return words.length === 2 && tens >= 20 && tens % 10 === 0 && ones >= 1 && ones <= 9 ? tens + ones : NaN;
}

function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Возвращает {title, steps: [{tool, args}]} или null.
function parseOffline(text) {
  const p = normalizePhrase(text);
  if (!p) return null;

  // Текст после времени только сохраняется как напоминание, не исполняется.
  // Сохраняем исходный регистр и пунктуацию, чтобы не изменить смысл просьбы.
  const raw = String(text || '').trim();
  const reminder = raw.match(/^(?:джарвис\s*[,!]?\s+)?напомни(?:\s+мне)?\s+через\s+(?:(\d{1,5}|[а-яё]+(?:\s+[а-яё]+)?)\s+)?(полчаса|минут(?:а|у|ы)?|мин|час(?:а|ов)?|день|дня|дней)(?:\s*[,.:—-]\s*|\s+)(\S[\s\S]*)$/iu);
  if (reminder) {
    const unit = reminder[2].toLocaleLowerCase();
    const count = reminder[1] ? spokenNumber(reminder[1]) : 1;
    // «через минут» и «через дней» без числа неоднозначны.
    if (!reminder[1] && !['полчаса', 'час', 'день', 'минута', 'минуту'].includes(unit)) return null;
    if (reminder[1] && unit === 'полчаса') return null;
    const factor = unit === 'полчаса' ? 30 : unit.startsWith('мин') ? 1 : unit.startsWith('час') ? 60 : 1440;
    const minutes = count * factor;
    const reminderText = reminder[3].trim();
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES || Array.from(reminderText).length > MAX_TEXT) return null;
    return { title: 'напоминание', steps: [{ tool: 'remind_in', args: { minutes, text: reminderText } }] };
  }

  if (DANGER.test(p)) return null;

  // Громкость: только целые от 0 до 100. «громкость 150» — не распознано.
  const vol = p.match(/^(?:(?:поставь|сделай|выставь|установи) )?(?:громкост(?:ь|и)|звук)(?: на)? (\d{1,3})(?: ?%| процент(?:а|ов)?)?$/);
  if (vol) {
    const percent = Number(vol[1]);
    if (percent > 100) return null;
    return { title: `громкость ${percent}`, steps: [{ tool: 'volume_set', args: { percent } }] };
  }

  if (/^(сверни|свернуть) (все )?окна$/.test(p) || p === 'окна свернуть') {
    return { title: 'свернуть окна', steps: [{ tool: 'windows_minimize_all', args: {} }] };
  }

  // Раскладка окон: «разложи окна», «размести окна красиво», «окна сеткой», «окна рядом», «окна каскадом».
  // Без названия раскладки — сетка: самый предсказуемый вид.
  const arrangeAll = /^(?:размести|разложи) (?:все )?окна(?: красиво| по экрану)?$/.test(p);
  const arrangeNamed = p.match(/^окна (рядом|сеткой|каскадом)$/);
  if (arrangeAll || arrangeNamed) {
    const layout = !arrangeNamed ? 'grid' : arrangeNamed[1] === 'рядом' ? 'row' : arrangeNamed[1] === 'каскадом' ? 'cascade' : 'grid';
    return { title: 'разложить окна', steps: [{ tool: 'windows_arrange', args: { layout } }] };
  }

  const timer = p.match(/^таймер(?: на)? (\d{1,3}) (минут[ауы]?|мин)$/);
  if (timer) {
    const minutes = Number(timer[1]);
    if (minutes < 1) return null;
    return {
      title: `таймер ${minutes} мин`,
      steps: [{ tool: 'remind_in', args: { minutes, text: `таймер на ${minutes} мин` } }],
    };
  }

  const open = p.match(/^(открой|открыть|открывай) (.+)$/);
  if (open) {
    const target = open[2];
    if (SITES[target]) {
      return { title: `открыть ${target}`, steps: [{ tool: 'url_open', args: { url: SITES[target] } }] };
    }
    if (PROGRAMS[target]) {
      return { title: `открыть ${target}`, steps: [{ tool: 'app_open', args: { name: PROGRAMS[target] } }] };
    }
  }

  return null;
}

module.exports = { parseOffline, normalizePhrase, SITES, PROGRAMS };
