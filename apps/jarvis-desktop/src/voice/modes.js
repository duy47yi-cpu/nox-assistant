'use strict';

// Режимы микрофона для голосового управления: полная диктовка → только имя → выключен.
// Чистая машина состояний: без DOM, без ввода-вывода, без таймеров и без времени изнутри.
// Режим знает ядро (main.js); здесь только переходы, фразы и честные слова для окна.

const STATES = Object.freeze(['listening', 'quiet', 'off']);
const DEFAULT_STATE = 'listening';

// Что видит владелец: короткие подписи для индикатора у поля ввода.
const LABELS = Object.freeze({
  listening: 'Слушаю',
  quiet: 'Только имя',
  off: 'Микрофон выкл',
});

// Ответ словами на переход в режим.
const REPLIES = Object.freeze({
  listening: 'Слушаю всё: распознанная речь снова идёт в чат.',
  quiet: 'Тихий режим: слушаю только имя «Джарвис».',
  off: 'Микрофон выключен. Включить — Ctrl+Alt+M.',
});
const ALREADY = Object.freeze({
  listening: 'Уже слушаю всё.',
  quiet: 'Уже тихий режим: слушаю только имя «Джарвис».',
  off: 'Микрофон уже выключен.',
});

// Фразы перехода. Порядок важен: «не слушай» и «хватит слушать» — выключение,
// «слушай меня» — возврат к полной диктовке.
const PHRASES = Object.freeze([
  Object.freeze({ state: 'quiet', phrases: Object.freeze([
    'тихий режим', 'перейди в тихий режим', 'переключись в тихий режим', 'включи тихий режим', 'только имя',
  ]) }),
  Object.freeze({ state: 'listening', phrases: Object.freeze([
    'слушай меня', 'обычный режим', 'вернись в обычный режим', 'перейди в обычный режим', 'полный режим', 'слушай всё',
  ]) }),
  Object.freeze({ state: 'off', phrases: Object.freeze([
    'хватит слушать', 'выключи микрофон', 'не слушай', 'выключи диктовку', 'перестань слушать', 'микрофон выкл',
  ]) }),
]);

const POLITE = new Set(['пожалуйста', 'плиз']);
const WAKE_NAME = 'джарвис';

// Фраза для сравнения: нижний регистр, ё как е, без пунктуации; «Джарвис» и «пожалуйста» не мешают.
function normalizePhrase(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && word !== WAKE_NAME && !POLITE.has(word))
    .join(' ');
}

const PHRASE_MAP = new Map();
for (const entry of PHRASES) {
  for (const phrase of entry.phrases) PHRASE_MAP.set(normalizePhrase(phrase), entry.state);
}

function phraseState(phrase) {
  return PHRASE_MAP.has(phrase) ? PHRASE_MAP.get(phrase) : null;
}

// Неизвестное значение не должно ронять управление микрофоном: считаем, что слушаем всё.
function normalizeState(value) {
  return STATES.includes(value) ? value : DEFAULT_STATE;
}

function statusText(state) {
  return LABELS[normalizeState(state)];
}

// Следующий режим по кругу — для клика по индикатору, горячей клавиши и трея.
function nextState(state) {
  const current = normalizeState(state);
  return STATES[(STATES.indexOf(current) + 1) % STATES.length];
}

// Разобрать сказанное: это команда режима или обычная речь.
// Возвращает { state, action, reply }: state — режим после фразы,
// action — 'set-listening'|'set-quiet'|'set-off'|'none', reply — что показать владельцу.
function handlePhrase(text, state) {
  const current = normalizeState(state);
  if (typeof text !== 'string') return { state: current, action: 'none', reply: '' };
  const phrase = normalizePhrase(text);
  if (!phrase) return { state: current, action: 'none', reply: '' };
  const target = phraseState(phrase);
  if (!target) return { state: current, action: 'none', reply: '' };
  return {
    state: target,
    action: `set-${target}`,
    reply: target === current ? ALREADY[target] : REPLIES[target],
  };
}

module.exports = {
  STATES,
  DEFAULT_STATE,
  LABELS,
  normalizeState,
  normalizePhrase,
  statusText,
  nextState,
  handlePhrase,
};
