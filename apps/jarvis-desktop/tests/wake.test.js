'use strict';

// Обращение по имени и роутер диктовки: начало фразы, ложные срабатывания, кулдаун.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeWord,
  wordRegex,
  extractWake,
  createWakeRouter,
  listWakeWords,
  defaultWord,
  WAKE_WORDS,
} = require('../src/voice/wake');

test('обращение в начале фразы отделяется от команды', () => {
  assert.deepEqual(extractWake('Джарвис, открой YouTube'), { woke: true, command: 'открой YouTube' });
  assert.deepEqual(extractWake('джарвис открой ютуб'), { woke: true, command: 'открой ютуб' });
});

test('регистр, лишние пробелы и запятая не мешают', () => {
  assert.deepEqual(extractWake('ДЖАРВИС, покажи погоду'), { woke: true, command: 'покажи погоду' });
  assert.deepEqual(extractWake('  ДжАрВиС   открой ютуб  '), { woke: true, command: 'открой ютуб' });
});

test('фраза без обращения не срабатывает', () => {
  assert.deepEqual(extractWake('открой YouTube'), { woke: false, command: '' });
  assert.deepEqual(extractWake('не джарвис, а кто-то другой'), { woke: false, command: '' });
});

test('обращение внутри слова не срабатывает', () => {
  assert.deepEqual(extractWake('джарвисова дочка пришла'), { woke: false, command: '' });
  assert.deepEqual(extractWake('джарвисджарвис'), { woke: false, command: '' });
});

test('кавычки, тире и знаки препинания вокруг обращения не мешают', () => {
  assert.deepEqual(extractWake('«Джарвис», который час?'), { woke: true, command: 'который час' });
  assert.deepEqual(extractWake('— Джарвис, включи музыку.'), { woke: true, command: 'включи музыку' });
  assert.deepEqual(extractWake('"Джарвис!", привет'), { woke: true, command: 'привет' });
});

test('ё и е при сравнении слова считаются одной буквой', () => {
  assert.deepEqual(extractWake('Алёна, включи свет', { word: 'Алена' }), { woke: true, command: 'включи свет' });
  assert.deepEqual(extractWake('Алена, включи свет', { word: 'Алёна' }), { woke: true, command: 'включи свет' });
});

test('пустой ввод даёт null', () => {
  assert.equal(extractWake(''), null);
  assert.equal(extractWake('   '), null);
  assert.equal(extractWake(null), null);
  assert.equal(extractWake(undefined), null);
  assert.equal(extractWake(42), null);
});

test('обращение без команды: woke есть, команда пустая', () => {
  assert.deepEqual(extractWake('Джарвис'), { woke: true, command: '' });
  assert.deepEqual(extractWake('Джарвис, ...'), { woke: true, command: '' });
  assert.deepEqual(extractWake('  Джарвис!  '), { woke: true, command: '' });
});

test('wordRegex ищет только начало фразы и не задевает слово внутри', () => {
  const re = wordRegex('джарвис');
  assert.equal(re.test('Джарвис, открой'), true);
  assert.equal(re.test('  джарвис открой'), true);
  assert.equal(re.test('джарвис'), true);
  assert.equal(re.test('джарвисова'), false);
  assert.equal(re.test('не джарвис'), false);
});

test('normalizeWord приводит слово к сравнению', () => {
  assert.equal(normalizeWord('  ДЖАРВИС, '), 'джарвис');
  assert.equal(normalizeWord('Алёна'), 'алена');
  assert.equal(normalizeWord(undefined), '');
});

test('список обращений: только «джарвис», наружу отдаётся копия', () => {
  assert.deepEqual(listWakeWords(), ['джарвис']);
  assert.equal(defaultWord, 'джарвис');
  assert.equal(Object.isFrozen(WAKE_WORDS), true);
  const copy = listWakeWords();
  copy.push('астра');
  assert.deepEqual(listWakeWords(), ['джарвис'], 'копию можно менять, настройку — нет');
});

test('роутер передаёт команды обращения и пропускает обычную речь', () => {
  const commands = [];
  let clock = 0;
  const route = createWakeRouter({ now: () => clock, cooldownMs: 0, onWake: (command) => commands.push(command) });
  route({ type: 'state', state: 'listening' });
  route({ type: 'text', text: 'Джарвис, открой YouTube' });
  route({ type: 'text', text: 'просто болтовня' });
  clock += 10;
  route({ type: 'text', text: 'джарвис покажи погоду' });
  assert.deepEqual(commands, ['открой YouTube', 'покажи погоду']);
});

test('пустая команда не запускает обработчик и не тратит кулдаун', () => {
  const commands = [];
  let clock = 1000;
  const route = createWakeRouter({ now: () => clock, onWake: (command) => commands.push(command) });
  route({ type: 'text', text: 'Джарвис' });
  route({ type: 'text', text: 'Джарвис, ...' });
  route({ type: 'text', text: 'Джарвис, открой ютуб' });
  assert.deepEqual(commands, ['открой ютуб']);
});

test('кулдаун гасит повторное обращение и отпускает после паузы', () => {
  const commands = [];
  let clock = 1000;
  const route = createWakeRouter({ now: () => clock, cooldownMs: 1500, onWake: (command) => commands.push(command) });
  route({ type: 'text', text: 'Джарвис, раз' });
  route({ type: 'text', text: 'Джарвис, два' });
  clock += 500;
  route({ type: 'text', text: 'Джарвис, три' });
  assert.deepEqual(commands, ['раз'], 'внутри паузы повтор не проходит');
  clock += 1000; // прошло 1500 мс с первого срабатывания
  route({ type: 'text', text: 'Джарвис, четыре' });
  assert.deepEqual(commands, ['раз', 'четыре']);
});

test('кулдаун 0 пропускает каждое обращение', () => {
  const commands = [];
  const route = createWakeRouter({ now: () => 500, cooldownMs: 0, onWake: (command) => commands.push(command) });
  route({ type: 'text', text: 'Джарвис, раз' });
  route({ type: 'text', text: 'Джарвис, два' });
  assert.deepEqual(commands, ['раз', 'два']);
});

test('ошибки и мусор диктовки не роняют роутер', () => {
  const commands = [];
  let clock = 0;
  const route = createWakeRouter({ now: () => clock, onWake: (command) => commands.push(command) });
  assert.doesNotThrow(() => {
    route({ type: 'error', code: 'no_audio', message: 'микрофон занят' });
    route({ type: 'state', state: 'stopped' });
    route(null);
    route(undefined);
    route({});
    route({ type: 'text' });
    route({ type: 'text', text: 42 });
    route('строка');
  });
  clock += 10;
  route({ type: 'text', text: 'Джарвис, открой ютуб' });
  assert.deepEqual(commands, ['открой ютуб'], 'после ошибки обращение снова работает');
});

test('close и stop прекращают обработку событий', () => {
  const commands = [];
  const route = createWakeRouter({ now: () => 0, cooldownMs: 0, onWake: (command) => commands.push(command) });
  route({ type: 'text', text: 'Джарвис, раз' });
  route.stop();
  route({ type: 'text', text: 'Джарвис, два' });
  route.close();
  route({ type: 'text', text: 'Джарвис, три' });
  assert.deepEqual(commands, ['раз']);
});

test('сбой onWake не ломает роутер', () => {
  const commands = [];
  let clock = 0;
  const route = createWakeRouter({
    now: () => clock,
    onWake: (command) => {
      commands.push(command);
      throw new Error('подписчик упал');
    },
  });
  assert.doesNotThrow(() => route({ type: 'text', text: 'Джарвис, раз' }));
  clock += 2000;
  route({ type: 'text', text: 'Джарвис, два' });
  assert.deepEqual(commands, ['раз', 'два']);
});

test('роутеру нужны now и onWake: без времени изнутри модуль не работает', () => {
  assert.throws(() => createWakeRouter({ onWake: () => {} }), TypeError);
  assert.throws(() => createWakeRouter({ now: () => 0 }), TypeError);
});
