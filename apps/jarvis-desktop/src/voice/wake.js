'use strict';

// Обращение по имени «Джарвис» без кнопки: чистый разбор сказанного и роутер потока диктовки.
// Модуль не читает файлы, не ходит в сеть и не берёт время изнутри: `now` всегда внедряется.
// События приходят из того же раннера, что и в src/voice/dictation.js:
//   { type: 'text', text } | { type: 'error', ... } | { type: 'state', ... }.

// Пока поддерживается одно имя: выдуманных обращений в списке быть не должно.
const WAKE_WORDS = Object.freeze(['джарвис']);
const defaultWord = 'джарвис';

// Пауза по умолчанию: распознавание может прислать одну фразу двумя событиями подряд.
const DEFAULT_COOLDOWN_MS = 1500;

// Слово для сравнения: нижний регистр, ё как е, без пунктуации и лишних пробелов.
function normalizeWord(word) {
  return String(word ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Регулярное выражение обращения в начале фразы.
// Впереди допускаются кавычки и прочая пунктуация («Джарвис, …»), после слова —
// только граница слова, поэтому «джарвисова» и «не джарвис» не срабатывают.
function wordRegex(word) {
  const normalized = normalizeWord(word) || defaultWord;
  const letters = Array.from(normalized)
    .map((ch) => {
      if (ch === ' ') return '\\s+';
      if (ch === 'е') return '[её]';
      return escapeRegExp(ch);
    })
    .join('');
  const prefix = '[\\s"\'«»„“”‘’()\\[\\]\\-–—.,!?;:…]*';
  return new RegExp(`^${prefix}${letters}(?![\\p{L}\\p{N}])`, 'iu');
}

// Убрать пунктуацию по краям команды, внутреннюю не трогаем.
function trimPunctuation(text) {
  return String(text)
    .replace(/^[\s"'«»„“”‘’()\[\]\-–—.,!?;:…]+/u, '')
    .replace(/[\s"'«»„“”‘’()\[\]\-–—.,!?;:…]+$/u, '')
    .trim();
}

// Разобрать список вариантов обращения из массива или строки через запятую/точку с запятой.
// Пустое значение даёт пустой массив (обращение не требуется / отключено).
function parseWakeWords(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,;\n]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const clean = normalizeWord(item);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

// Разобрать сказанное: было ли обращение в начале и что осталось командой.
// Пустой ввод — null; без обращения — { woke: false, command: '' }.
function extractWake(text, options = {}) {
  if (typeof text !== 'string') return null;
  const phrase = text.trim();
  if (!phrase) return null;
  let candidates;
  if (options && options.words !== undefined) {
    candidates = parseWakeWords(options.words);
    if (candidates.length === 0) return { woke: false, command: '' };
  } else {
    const word = options && typeof options.word === 'string' ? options.word : defaultWord;
    const single = normalizeWord(word);
    candidates = single ? [single] : [defaultWord];
  }
  const ordered = [...candidates].sort((a, b) => b.length - a.length);
  for (const candidate of ordered) {
    const match = wordRegex(candidate).exec(phrase);
    if (match) {
      const rest = phrase.slice(match[0].length);
      return { woke: true, command: trimPunctuation(rest) };
    }
  }
  return { woke: false, command: '' };
}

// Превратить поток событий диктовки в вызовы onWake(command).
// Правила: пустые команды не передаются, кулдаун гасит повтор, чужие события
// (error/state/мусор) и сбой onWake роутер не ломают, close/stop прекращают работу.
function createWakeRouter({ word = defaultWord, words, cooldownMs = DEFAULT_COOLDOWN_MS, now, onWake } = {}) {
  if (typeof now !== 'function') throw new TypeError('createWakeRouter: нужен now — время снаружи');
  if (typeof onWake !== 'function') throw new TypeError('createWakeRouter: нужен onWake');
  const pause = Number.isFinite(cooldownMs) && cooldownMs >= 0 ? cooldownMs : DEFAULT_COOLDOWN_MS;
  let closed = false;
  let lastAt = null;
  const getWakeOpts = () => {
    if (typeof words === 'function') return { words: words() };
    if (words !== undefined) return { words };
    return { word };
  };

  const route = (event) => {
    if (closed || !event || typeof event !== 'object') return;
    if (event.type !== 'text') return; // ошибки и состояния диктовки к обращению не относятся
    const found = extractWake(event.text, getWakeOpts());
    if (!found || !found.woke || !found.command) return;
    const at = now();
    if (lastAt !== null && Number.isFinite(at) && at - lastAt < pause) return;
    lastAt = at;
    try {
      onWake(found.command);
    } catch {
      // Сбой подписчика не должен останавливать распознавание.
    }
  };
  route.close = () => { closed = true; };
  route.stop = () => { closed = true; };
  return route;
}

// Список допустимых обращений для настроек: копия, чтобы наружу нельзя было дописать имя.
function listWakeWords() {
  return [...WAKE_WORDS];
}

module.exports = {
  normalizeWord,
  parseWakeWords,
  wordRegex,
  extractWake,
  createWakeRouter,
  listWakeWords,
  defaultWord,
  WAKE_WORDS,
  DEFAULT_COOLDOWN_MS,
};
