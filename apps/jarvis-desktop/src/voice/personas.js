'use strict';

// Характеры речи: пресеты темпа и громкости. Это не голос и не имя помощника — сам голос
// (локальный Silero или облачный Fish) владелец выбирает отдельной строкой. Пресет меняет
// только скорость и громкость, поэтому ничего не подменяет молча и не зависит от модели.
// Неизвестный id и «Как есть» не задают ничего: остаются ручки из настроек.
// Фраз для озвучки здесь нет: приложение не говорит само по себе, повод даёт владелец.

const DEFAULT_PERSONA_ID = 'neutral';
const RATE_MIN = 0.5;
const RATE_MAX = 2;
const VOLUME_MIN = 0;
const VOLUME_MAX = 1;

const PERSONAS = [
  {
    id: 'neutral',
    name: 'Как есть',
    description: 'Скорость и громкость из ручек настроек',
    rate: null,
    volume: null,
  },
  {
    id: 'butler',
    name: 'Дворецкий',
    description: 'Сдержанно, негромко и чуть медленнее',
    rate: 0.95,
    volume: 0.9,
  },
  {
    id: 'assistant',
    name: 'Помощница',
    description: 'Ровная речь обычной громкости',
    rate: 1,
    volume: 1,
  },
  {
    id: 'engineer',
    name: 'Инженер',
    description: 'Быстрее и чётче — для работы за компьютером',
    rate: 1.05,
    volume: 1,
  },
];

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function copyOf(persona) {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description,
    rate: persona.rate,
    volume: persona.volume,
  };
}

// Список для окна: копии, чтобы вызывающий не менял общий массив.
function listPersonas() {
  return PERSONAS.map(copyOf);
}

function getPersona(id) {
  const found = PERSONAS.find((persona) => persona.id === id);
  return found ? copyOf(found) : null;
}

// Неизвестный или пустой id тихо открывает «Как есть» — как убранные темы открывают «Ночь».
function resolvePersona(id) {
  return getPersona(id) || getPersona(DEFAULT_PERSONA_ID);
}

// Только те поля, которые пресет действительно задаёт; для neutral и неизвестного — {}.
function personaVoiceOptions(id) {
  const found = PERSONAS.find((persona) => persona.id === id);
  if (!found) return {};
  const options = {};
  if (Number.isFinite(found.rate)) options.rate = clampNumber(found.rate, RATE_MIN, RATE_MAX);
  if (Number.isFinite(found.volume)) options.volume = clampNumber(found.volume, VOLUME_MIN, VOLUME_MAX);
  return options;
}

module.exports = {
  DEFAULT_PERSONA_ID,
  PERSONAS,
  RATE_MIN,
  RATE_MAX,
  VOLUME_MIN,
  VOLUME_MAX,
  listPersonas,
  getPersona,
  resolvePersona,
  personaVoiceOptions,
};
