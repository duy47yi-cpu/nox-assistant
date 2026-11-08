'use strict';

// Умное сопоставление команд: нормализация, необязательные стартовые глаголы и склейка
// «и / затем / потом». Ни одного настоящего запуска здесь нет: только чистые функции.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizePhrase, stripWake, stripFillers, splitLinkWords, matchCommand, matchSequence,
  DEFAULT_LINK_WORDS,
} = require('../src/commands/match');
const {
  CommandStore, exportCommandPack, parseCommandPack,
  TRANSFER_FORMAT, TRANSFER_VERSION, COMMAND_SCHEMA_VERSION,
  MAX_OPTIONAL_PHRASES, MAX_OPTIONAL_PHRASE,
} = require('../src/commands/store');

const command = (name, phrases, extra = {}) => ({
  id: name,
  name,
  phrases: phrases.slice(),
  steps: [{ tool: 'wait', args: { ms: 1 } }],
  enabled: true,
  ...extra,
});

function tmpStore(t, name = 'commands.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-match-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new CommandStore(path.join(dir, name));
}

// ── Нормализация ────────────────────────────────────────────────

test('normalizePhrase: регистр, ё→е, пунктуация, «пожалуйста», обращение «джарвис»', () => {
  assert.equal(normalizePhrase('Джарвис, открой ЮТУБ!'), 'открой ютуб');
  assert.equal(normalizePhrase('— «Джарвис», запусти ютуб.'), 'запусти ютуб');
  assert.equal(normalizePhrase('  Открой...   YouTube?  '), 'открой youtube');
  assert.equal(normalizePhrase('включи ёлку, пожалуйста'), 'включи елку');
  assert.equal(normalizePhrase('открой, пожалуйста, ютуб'), 'открой ютуб');
});

test('normalizePhrase: пустое и не-строки не падают; «и» внутри слова не трогаем', () => {
  assert.equal(normalizePhrase(''), '');
  assert.equal(normalizePhrase('   '), '');
  assert.equal(normalizePhrase(null), '');
  assert.equal(normalizePhrase(undefined), '');
  assert.equal(normalizePhrase(42), '');
  assert.equal(normalizePhrase('игрушки'), 'игрушки');
  assert.equal(normalizePhrase('джарвисова дочка пришла'), 'джарвисова дочка пришла');
});

test('stripWake: только обращение в начале и только целым словом', () => {
  assert.equal(stripWake('Джарвис, открой'), 'открой');
  assert.equal(stripWake('«Джарвис», открой'), 'открой');
  assert.equal(stripWake('джарвисова дочка'), 'джарвисова дочка');
  assert.equal(stripWake('привет, джарвис'), 'привет, джарвис');
  assert.equal(stripWake(''), '');
});

test('stripFillers: «пожалуйста» убирается в любом месте и со знаками препинания', () => {
  assert.equal(stripFillers('открой пожалуйста ютуб'), 'открой ютуб');
  assert.equal(stripFillers('открой, пожалуйста, ютуб'), 'открой, ютуб');
  assert.equal(stripFillers('ютуб (пожалуйста)'), 'ютуб');
  assert.equal(stripFillers('ютуб'), 'ютуб');
});

// ── Деление по словам-связкам ───────────────────────────────────

test('splitLinkWords: «и, затем, потом» только целыми словами', () => {
  assert.deepEqual(splitLinkWords('ютуб и громкость 30'), ['ютуб', 'громкость 30']);
  assert.deepEqual(splitLinkWords('ютуб, затем громкость 30'), ['ютуб', 'громкость 30']);
  assert.deepEqual(splitLinkWords('ютуб потом громкость 30'), ['ютуб', 'громкость 30']);
  // «и» внутри слов не делит.
  assert.deepEqual(splitLinkWords('игры и музыка'), ['игры', 'музыка']);
  assert.deepEqual(splitLinkWords('играть в игры'), ['играть в игры']);
  assert.deepEqual(splitLinkWords('игрушки'), ['игрушки']);
  assert.deepEqual(splitLinkWords(''), []);
  assert.deepEqual(splitLinkWords(null), []);
});

test('splitLinkWords: свои слова-связки, в том числе из двух слов', () => {
  assert.deepEqual(splitLinkWords('ютуб а затем музыка', ['а затем']), ['ютуб', 'музыка']);
  assert.deepEqual(splitLinkWords('ютуб затем музыка', ['потом']), ['ютуб затем музыка']);
  assert.deepEqual(DEFAULT_LINK_WORDS, ['и', 'затем', 'потом']);
});

// ── Одна команда: точное совпадение и необязательный глагол ────

const BASIC = [
  command('Ютуб', ['ютуб']),
  command('Громкость', ['громкость 30']),
];

test('matchCommand: точное совпадение после нормализации (регистр, пунктуация)', () => {
  assert.equal(matchCommand('ЮТУБ!', BASIC).command.name, 'Ютуб');
  assert.equal(matchCommand('«ютуб»', BASIC).via, 'exact');
  assert.equal(matchCommand('громкость, 30', BASIC).command.name, 'Громкость');
  assert.equal(matchCommand('доброе утро', BASIC), null);
});

test('matchCommand: «открой ютуб» находит команду «ютуб» через стартовый глагол', () => {
  const hit = matchCommand('открой ютуб', BASIC);
  assert.equal(hit.command.name, 'Ютуб');
  assert.equal(hit.via, 'verb');
  assert.equal(hit.verb, 'открой');
  // Формы конкурента: «запусти», «зайди в».
  assert.equal(matchCommand('запусти ютуб', BASIC).command.name, 'Ютуб');
  assert.equal(matchCommand('зайди в ютуб', BASIC).command.name, 'Ютуб');
  assert.equal(matchCommand('включи ютуб', BASIC).command.name, 'Ютуб');
  // Глагол + вся фраза, а не только первое слово.
  assert.equal(matchCommand('открой громкость 30', BASIC).command.name, 'Громкость');
  // Чужой глагол не подставляется.
  assert.equal(matchCommand('похвали ютуб', BASIC), null);
});

test('matchCommand: свои стартовые глаголы команды из optionalPhrases', () => {
  const commands = [command('Кино', ['кино'], { optionalPhrases: ['врубай', 'включай'] })];
  assert.equal(matchCommand('врубай кино', commands).command.name, 'Кино');
  assert.equal(matchCommand('включай кино', commands).verb, 'включай');
  // Общие глаголы продолжают работать вместе со своими.
  assert.equal(matchCommand('открой кино', commands).command.name, 'Кино');
});

test('matchCommand: opts.optionalPhrases заменяет общий список глаголов', () => {
  assert.equal(matchCommand('открой ютуб', BASIC, { optionalPhrases: ['запусти'] }), null);
  assert.equal(matchCommand('запусти ютуб', BASIC, { optionalPhrases: ['запусти'] }).command.name, 'Ютуб');
});

test('matchCommand: точная фраза важнее варианта с глаголом', () => {
  const commands = [command('Короткая', ['ютуб']), command('Длинная', ['открой ютуб'])];
  const hit = matchCommand('открой ютуб', commands);
  assert.equal(hit.command.name, 'Длинная');
  assert.equal(hit.via, 'exact');
});

test('matchCommand: неоднозначность не решается наугад', () => {
  const twins = [command('A', ['кино']), command('B', ['кино'])];
  assert.equal(matchCommand('кино', twins), null, 'две одинаковые фразы — не угадываем');
  assert.equal(matchCommand('открой кино', twins), null, 'два варианта по глаголу — тоже null');
});

test('matchCommand: выключенная команда не находится, если не попросили иначе', () => {
  const commands = [command('Спящая', ['кино'], { enabled: false })];
  assert.equal(matchCommand('кино', commands), null);
  assert.equal(matchCommand('кино', commands, { includeDisabled: true }).command.name, 'Спящая');
});

test('matchCommand: мусор и пустота не падают', () => {
  assert.equal(matchCommand('', BASIC), null);
  assert.equal(matchCommand(null, BASIC), null);
  assert.equal(matchCommand(123, BASIC), null);
  assert.equal(matchCommand('ютуб', null), null);
  assert.equal(matchCommand('ютуб', []), null);
  assert.equal(matchCommand('ютуб', [null, {}, { name: 'X' }, { phrases: 'нет' }]), null);
});

// ── Склейка нескольких команд ──────────────────────────────────

test('matchSequence: «ютуб и громкость 30» даёт две команды в порядке текста', () => {
  const parts = matchSequence('ютуб и громкость 30', BASIC);
  assert.deepEqual(parts.map((part) => part.command.name), ['Ютуб', 'Громкость']);
  assert.deepEqual(parts.map((part) => part.matched), ['ютуб', 'громкость 30']);
});

test('matchSequence: «затем» и «потом», глаголы в частях', () => {
  assert.deepEqual(
    matchSequence('ютуб, затем громкость 30', BASIC).map((part) => part.command.name),
    ['Ютуб', 'Громкость'],
  );
  assert.deepEqual(
    matchSequence('ютуб потом громкость 30', BASIC).map((part) => part.command.name),
    ['Ютуб', 'Громкость'],
  );
  const withVerbs = matchSequence('открой ютуб и запусти громкость 30', BASIC);
  assert.deepEqual(withVerbs.map((part) => part.command.name), ['Ютуб', 'Громкость']);
  assert.equal(withVerbs[1].verb, 'запусти');
});

test('matchSequence: целая фраза проверяется раньше деления — «и» может быть внутри команды', () => {
  const commands = [
    command('Всё сразу', ['ютуб и громкость 30']),
    command('Ютуб', ['ютуб']),
    command('Громкость', ['громкость 30']),
  ];
  const parts = matchSequence('ютуб и громкость 30', commands);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].command.name, 'Всё сразу');
});

test('matchSequence: DP, а не деление по всем «и» — часть может сама содержать «и»', () => {
  const commands = [
    command('Ютуб', ['ютуб']),
    command('Игра', ['включи и игру']),
    command('Громкость', ['громкость 30']),
  ];
  const parts = matchSequence('открой ютуб и включи и игру', commands);
  assert.deepEqual(parts.map((part) => part.command.name), ['Ютуб', 'Игра']);
  // Простое деление по всем «и» дало бы ['открой ютуб', 'включи', 'игру'] и не нашло команду «включи».
  assert.deepEqual(splitLinkWords('открой ютуб и включи и игру'), ['открой ютуб', 'включи', 'игру']);
});

test('matchSequence: половину склейки не запускаем — каждая часть должна найти команду', () => {
  assert.deepEqual(matchSequence('ютуб и что-то неизвестное', BASIC), []);
  assert.deepEqual(matchSequence('ютуб и громкость 30 и неизвестно', BASIC), []);
});

test('matchSequence: без связок и без точной фразы — пусто, а не догадка', () => {
  assert.deepEqual(matchSequence('доброе утро', BASIC), []);
  assert.deepEqual(matchSequence('', BASIC), []);
  assert.deepEqual(matchSequence(null, BASIC), []);
  assert.deepEqual(matchSequence('ютуб и громкость 30', null), []);
  assert.deepEqual(matchSequence('и и и', BASIC), []);
});

test('matchSequence: неоднозначная часть не превращается в догадку', () => {
  const commands = [command('A', ['ютуб']), command('B', ['ютуб']), command('Громкость', ['громкость 30'])];
  assert.deepEqual(matchSequence('ютуб и громкость 30', commands), []);
});

test('matchSequence: выключенные команды не участвуют', () => {
  const commands = [command('Ютуб', ['ютуб'], { enabled: false }), command('Громкость', ['громкость 30'])];
  assert.deepEqual(matchSequence('ютуб и громкость 30', commands), []);
});

// ── Поле optionalPhrases в хранилище ───────────────────────────

test('store: optionalPhrases сохраняются, нормализуются и возвращаются', (t) => {
  const store = tmpStore(t);
  const saved = store.save({
    name: 'Кино',
    phrases: ['кино'],
    optionalPhrases: ['  Врубай ', 'запусти', 'зайди в'],
    steps: [{ tool: 'wait', args: { ms: 1 } }],
  });
  assert.deepEqual(saved.optionalPhrases, ['врубай', 'запусти', 'зайди в']);
  assert.deepEqual(store.get(saved.id).optionalPhrases, ['врубай', 'запусти', 'зайди в']);
  // Обычная правка команды поле не теряет.
  const edited = store.save({ ...saved, phrases: ['кино', 'фильм'] });
  assert.deepEqual(edited.optionalPhrases, ['врубай', 'запусти', 'зайди в']);
});

test('store: лимиты и проверки поля optionalPhrases', (t) => {
  const store = tmpStore(t);
  const base = { name: 'Кино', phrases: ['кино'], steps: [{ tool: 'wait', args: { ms: 1 } }] };
  assert.throws(() => store.save({ ...base, optionalPhrases: 'открой' }), /нужен массив строк/);
  assert.throws(() => store.save({ ...base, optionalPhrases: [42] }), /нужна строка/);
  assert.throws(() => store.save({ ...base, optionalPhrases: ['  '] }), /пустая строка/);
  assert.throws(
    () => store.save({ ...base, optionalPhrases: Array.from({ length: MAX_OPTIONAL_PHRASES + 1 }, (_, i) => `глагол ${i}`) }),
    new RegExp(`не больше ${MAX_OPTIONAL_PHRASES}`),
  );
  assert.throws(
    () => store.save({ ...base, optionalPhrases: ['г'.repeat(MAX_OPTIONAL_PHRASE + 1)] }),
    new RegExp(`длиннее ${MAX_OPTIONAL_PHRASE}`),
  );
  assert.throws(() => store.save({ ...base, optionalPhrases: ['открой', 'Открой'] }), /повторяется/);
  assert.equal(store.list().length, 0);
});

test('store: старый файл без optionalPhrases читается, а сохранение даёт пустой список', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-match-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'commands.json');
  fs.writeFileSync(file, JSON.stringify({
    items: [{
      id: 'old-1',
      schemaVersion: 2,
      name: 'Старая',
      phrases: ['старая фраза'],
      steps: [{ tool: 'wait', args: { ms: 1 } }],
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastRunAt: null,
      hotkey: null,
      folder: null,
      collections: [],
      origin: 'manual',
    }],
  }), 'utf8');
  const store = new CommandStore(file);
  const [legacy] = store.list();
  assert.equal(legacy.name, 'Старая');
  assert.equal(legacy.optionalPhrases, undefined);
  assert.equal(store.findByPhrase('старая фраза').name, 'Старая');
  const saved = store.save({ ...legacy, phrases: ['старая фраза'] });
  assert.deepEqual(saved.optionalPhrases, []);
});

test('экспорт и импорт: optionalPhrases переносятся; старый файл даёт пустой список', (t) => {
  const source = tmpStore(t, 'source.json');
  source.save({
    name: 'Кино',
    phrases: ['кино'],
    optionalPhrases: ['врубай', 'запусти'],
    steps: [{ tool: 'wait', args: { ms: 1 } }],
  });
  const pack = exportCommandPack(source.list(), { now: new Date('2026-11-08T10:00:00Z') });
  assert.deepEqual(pack.commands[0].optionalPhrases, ['врубай', 'запусти']);

  const parsed = parseCommandPack(JSON.stringify(pack));
  assert.deepEqual(parsed.commands[0].optionalPhrases, ['врубай', 'запусти']);

  const legacyPack = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    schemaVersion: COMMAND_SCHEMA_VERSION,
    commands: [{ name: 'Старая', phrases: ['старая фраза'], steps: [{ tool: 'wait', args: { ms: 1 } }] }],
  };
  const legacyParsed = parseCommandPack(JSON.stringify(legacyPack));
  assert.deepEqual(legacyParsed.commands[0].optionalPhrases, []);
});

test('импорт: смена только optionalPhrases считается изменением команды', async (t) => {
  const { previewCommandImport } = require('../src/commands/store');
  const pack = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    schemaVersion: COMMAND_SCHEMA_VERSION,
    commands: [{
      name: 'Кино',
      phrases: ['кино'],
      optionalPhrases: ['врубай'],
      steps: [{ tool: 'wait', args: { ms: 1 } }],
    }],
  };
  const target = tmpStore(t, 'target.json');
  target.save({ name: 'Кино', phrases: ['кино'], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  const preview = previewCommandImport(JSON.stringify(pack), target);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.preview.counts.update, 1);
  const update = preview.preview.items.find((item) => item.action === 'update');
  assert.ok(update.changes.some((change) => change.field === 'optionalPhrases'));
});

// ── Вместе с хранилищем ────────────────────────────────────────

test('matchSequence умеет принимать само хранилище команд', (t) => {
  const store = tmpStore(t);
  store.save({ name: 'Ютуб', phrases: ['ютуб'], optionalPhrases: ['открой'], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  store.save({ name: 'Громкость', phrases: ['громкость 30'], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  const parts = matchSequence('открой ютуб и громкость 30', store);
  assert.deepEqual(parts.map((part) => part.command.name), ['Ютуб', 'Громкость']);
});

test('normalizePhrase и matchCommand: числительные словами и однозначная опечатка распознавания речи', () => {
  const { parseOffline } = require('../src/shortcuts/offline');
  assert.equal(normalizePhrase('громкость тридцать'), 'громкость 30');
  assert.equal(normalizePhrase('таймер двадцать пять'), 'таймер 25');
  assert.equal(normalizePhrase('громкость ноль'), 'громкость 0');
  assert.equal(normalizePhrase('громкость сто'), 'громкость 100');

  // Голосовая фраза «громкость тридцать» находит сохранённую команду «громкость 30»
  assert.equal(matchCommand('громкость тридцать', BASIC).command.name, 'Громкость');
  const seq = matchSequence('открой ютуб и громкость тридцать', BASIC);
  assert.deepEqual(seq.map((p) => p.command.name), ['Ютуб', 'Громкость']);

  // Однозначная опечатка ASR (1 правка в слове >= 5 букв) находится, неоднозначная — возвращает null
  const cmds = [
    command('Телеграм', ['телеграм']),
    command('Громкость', ['громкость 30']),
  ];
  const fuzzyHit = matchCommand('телегран', cmds);
  assert.ok(fuzzyHit, 'опечатка в 1 букву для длинного слова должна находить единственную команду');
  assert.equal(fuzzyHit.command.name, 'Телеграм');
  assert.equal(fuzzyHit.via, 'fuzzy');

  const fuzzyVerbHit = matchCommand('открой телегран', cmds);
  assert.ok(fuzzyVerbHit);
  assert.equal(fuzzyVerbHit.command.name, 'Телеграм');

  // Две похожие команды на расстоянии 1 правки — неоднозначность → null
  const ambiguous = [command('А', ['папка1']), command('Б', ['папка2'])];
  assert.equal(matchCommand('папка3', ambiguous), null);

  // parseOffline понимает русские числительные словами для громкости и таймера
  assert.deepEqual(parseOffline('громкость пятьдесят'), {
    title: 'громкость 50',
    steps: [{ tool: 'volume_set', args: { percent: 50 } }],
  });
  assert.deepEqual(parseOffline('поставь звук на двадцать пять процентов'), {
    title: 'громкость 25',
    steps: [{ tool: 'volume_set', args: { percent: 25 } }],
  });
  assert.deepEqual(parseOffline('громкость ноль'), {
    title: 'громкость 0',
    steps: [{ tool: 'volume_set', args: { percent: 0 } }],
  });
  assert.deepEqual(parseOffline('громкость сто'), {
    title: 'громкость 100',
    steps: [{ tool: 'volume_set', args: { percent: 100 } }],
  });
  assert.deepEqual(parseOffline('таймер на пятнадцать минут'), {
    title: 'таймер 15 мин',
    steps: [{ tool: 'remind_in', args: { minutes: 15, text: 'таймер на 15 мин' } }],
  });
});

