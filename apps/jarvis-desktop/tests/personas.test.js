'use strict';

// Характеры речи: список, значения в пределах ручек голоса и честное поведение для
// неизвестного id. Пресет не задаёт голос и не трогает его — только темп и громкость.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_PERSONA_ID, PERSONAS, RATE_MIN, RATE_MAX, VOLUME_MIN, VOLUME_MAX,
  listPersonas, getPersona, resolvePersona, personaVoiceOptions,
} = require('../src/voice/personas');

test('есть «Как есть» и он по умолчанию', () => {
  assert.equal(DEFAULT_PERSONA_ID, 'neutral');
  assert.equal(PERSONAS[0].id, 'neutral');
  assert.equal(resolvePersona(undefined).id, 'neutral');
  assert.equal(resolvePersona('nope').id, 'neutral');
  assert.equal(getPersona('nope'), null);
});

test('id не повторяются, у каждого есть имя и описание', () => {
  const ids = new Set();
  for (const persona of listPersonas()) {
    assert.equal(typeof persona.id, 'string');
    assert.ok(persona.id.length > 0);
    assert.equal(ids.has(persona.id), false, `id повторяется: ${persona.id}`);
    ids.add(persona.id);
    assert.equal(typeof persona.name, 'string');
    assert.ok(persona.name.trim().length > 0, persona.id);
    assert.equal(typeof persona.description, 'string');
    assert.ok(persona.description.trim().length > 0, persona.id);
  }
});

test('«Как есть» не задаёт ничего, пресеты — только темп и громкость в пределах', () => {
  assert.deepEqual(personaVoiceOptions('neutral'), {});
  assert.deepEqual(personaVoiceOptions('nope'), {});
  assert.deepEqual(personaVoiceOptions(undefined), {});
  for (const persona of listPersonas()) {
    const options = personaVoiceOptions(persona.id);
    if (persona.id === 'neutral') {
      assert.deepEqual(options, {});
      continue;
    }
    assert.equal(Number.isFinite(options.rate), true, persona.id);
    assert.ok(options.rate >= RATE_MIN && options.rate <= RATE_MAX, persona.id);
    assert.equal(Number.isFinite(options.volume), true, persona.id);
    assert.ok(options.volume >= VOLUME_MIN && options.volume <= VOLUME_MAX, persona.id);
  }
  // Темп и громкость не подменяют голос: в пресетах нет поля speaker.
  for (const persona of listPersonas()) {
    assert.equal(Object.prototype.hasOwnProperty.call(persona, 'speaker'), false, persona.id);
  }
});

test('копии: правка результата не меняет общий список', () => {
  const first = listPersonas();
  first[0].name = 'сломано';
  first.push({ id: 'лишний' });
  assert.equal(getPersona('neutral').name, 'Как есть');
  assert.equal(PERSONAS.length, 4);
  const copy = getPersona('butler');
  copy.rate = 99;
  assert.equal(getPersona('butler').rate, 0.95);
});

test('значения пресетов проходят проверку настроек голоса', () => {
  // Те же пределы, что у settings:set для voiceRate и voiceVolume.
  const NUMBER_SETTINGS = { voiceRate: [0.5, 2], voiceVolume: [0, 1] };
  for (const persona of listPersonas()) {
    const options = personaVoiceOptions(persona.id);
    if (Object.prototype.hasOwnProperty.call(options, 'rate')) {
      assert.ok(options.rate >= NUMBER_SETTINGS.voiceRate[0] && options.rate <= NUMBER_SETTINGS.voiceRate[1]);
    }
    if (Object.prototype.hasOwnProperty.call(options, 'volume')) {
      assert.ok(options.volume >= NUMBER_SETTINGS.voiceVolume[0] && options.volume <= NUMBER_SETTINGS.voiceVolume[1]);
    }
  }
});
