'use strict';

// Пост-коррекция распознанной речи для команд Nox: правила из rev/VOICE_PATCH_PLAN.md §6.
// Чистые функции: без файлов, сети и времени, кроме одного набора данных — снимка 30 фраз замера
// (tests/fixtures/voice-bench-30.json). Детерминированные проверки защищают правила от регрессии;
// реальное качество движка подтверждает только прогон scripts/voice-bench.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSpeech, baseNormalize, buildHotwords, clipPrompt, MAX_CLOUD_PROMPT } = require('../src/voice/normalize');
const { cloudProvider, wavFromPcm } = require('../src/voice/stt');
const { voicePhrase } = require('../src/voice/input');
const { normalizePhrase, matchCommand, matchSequence } = require('../src/commands/match');
const fixture = require('./fixtures/voice-bench-30.json');

const command = (name, phrases, extra = {}) => ({
  id: name,
  name,
  phrases: phrases.slice(),
  steps: [{ tool: 'wait', args: { ms: 1 } }],
  enabled: true,
  ...extra,
});

// ── §6.1. Единичные правила и имена ─────────────────────────────

test('§6.1 normalizeSpeech: имена, филлеры, подстроки не трогаются', () => {
  assert.equal(normalizeSpeech('Открой YouTube'), 'открой youtube');
  assert.equal(normalizeSpeech('открой ютюб'), 'открой youtube');
  assert.equal(normalizeSpeech('открой, пожалуйста, ютуб'), 'открой youtube');
  assert.equal(normalizeSpeech('Джарвис, открой ютуб, пожалуйста'), 'открой youtube');
  assert.equal(normalizeSpeech('запусти стим'), 'запусти steam');
  assert.equal(normalizeSpeech('запустил рабочий лафимикс на ютубе сэр'), 'запустил рабочий лофемикс на youtube');
  assert.equal(normalizeSpeech('поставь фильм хелэк'), 'поставь фильм халок');
  assert.equal(normalizeSpeech('запусти дота два'), 'запусти dota 2');
  assert.equal(normalizeSpeech('запусти дота 2'), 'запусти dota 2');
  // Дефис — разделитель: правило «телеграм» видит отдельное слово.
  assert.equal(normalizeSpeech('напиши код для телеграм-бота по маркетингу'), 'напиши код для telegram бота по маркетингу');
  // «Телеграмма» — это сообщение, а не приложение: §2.6 запрещает подстроки и приводит её примером.
  assert.equal(normalizeSpeech('напиши код для телеграмм'), 'напиши код для telegram');
  assert.equal(normalizeSpeech('напиши код для телеграмма'), 'напиши код для телеграмма');
  assert.equal(normalizeSpeech('запусти свич шоу'), 'запусти switch show');
  assert.equal(normalizeSpeech('ю туб'), 'youtube');
  // Подстроки не трогаем: ни «ютубчик», ни «телеграмма».
  assert.equal(normalizeSpeech('ютубчик открой'), 'ютубчик открой');
  assert.equal(normalizeSpeech('телеграмма пришла'), 'телеграмма пришла');
  assert.equal(normalizeSpeech('включи ёлку'), 'включи елку');
  // Догадки по одной букве запрещены: «ш» остаётся «ш» (№13 закрывается только hotwords).
  assert.equal(normalizeSpeech('запусти ш'), 'запусти ш');
  // Вводные слова снимаются только в начале фразы.
  assert.equal(normalizeSpeech('а ну слушай открой ютуб'), 'открой youtube');
  assert.equal(normalizeSpeech('ютуб и громкость 30'), 'youtube и громкость 30');
});

// ── §6.2. Склейки и числа по контексту ──────────────────────────

test('§6.2 normalizeSpeech: склейки и разрезания целыми словами', () => {
  assert.equal(normalizeSpeech('игровый режим'), 'игровой режим');
  assert.equal(normalizeSpeech('игровая режим'), 'игровой режим');
  assert.equal(normalizeSpeech('сверни в се окна'), 'сверни все окна');
  assert.equal(normalizeSpeech('сверни во се окна'), 'сверни все окна');
  assert.equal(normalizeSpeech('переведи компьютерспять в режим'), 'переведи компьютер с 5 в режим');
  assert.equal(normalizeSpeech('переведи компьютер спять в режим'), 'переведи компьютер с 5 в режим');
  assert.equal(normalizeSpeech('переведи компьютерс пять в режим'), 'переведи компьютер с 5 в режим');
  assert.equal(normalizeSpeech('переведи компьютер с пять в режим'), 'переведи компьютер с 5 в режим');
  // Рискованное одиночное «спять → с пять» не возвращено: путает со «спать».
  assert.equal(normalizeSpeech('хочу спять'), 'хочу спять');
});

test('§6.2 normalizeSpeech: числа только по контексту', () => {
  assert.equal(normalizeSpeech('поставь таймер на тридцать минут'), 'поставь таймер на 30 минут');
  assert.equal(normalizeSpeech('на двадцать пять процентов'), 'на 25 процентов');
  assert.equal(normalizeSpeech('через пять минут'), 'через 5 минут');
  assert.equal(normalizeSpeech('поставь громкость сорок'), 'поставь громкость 40');
  // Обороты «раз/раза/части» и доля «половина» не числа.
  assert.equal(normalizeSpeech('покажите задачу один раз'), 'покажите задачу один раз');
  assert.equal(normalizeSpeech('тише в два раза'), 'тише в два раза');
  assert.equal(normalizeSpeech('половина экрана'), 'половина экрана');
  assert.equal(normalizeSpeech('осталось три части'), 'осталось три части');
  // Известный пробел P1: смешанная цифра-буква не лечится.
  assert.equal(normalizeSpeech('громкость 4о'), 'громкость 4о');
});

// ── §6.3. Предохранитель: отрицания и опасные фразы ─────────────

// Ожидание: равно baseNormalize(вход) — словарь не сработал, база (регистр, ё, пунктуация) работает.
const GUARD_CASES = [
  'не открывай ютюб',
  'не закрывай окно',
  'не надо громче',
  'ничего не делай',
  'удали папку лафимикс',
  'удали папку отчёты целиком',
  'оплати подписку на сервис',
  'переведи 5000 рублей на карту',
  'покажи баланс в моём банке',
  'прочитай пароль из bitwarden',
  'установи фотошоп',
  'отправь письмо на test@example.com',
  'сохрани, чтобы не потерять',
  'у соседа орёт музыка',
];

test('§6.3 предохранитель: словарь выключен, база применена', () => {
  for (const input of GUARD_CASES) {
    assert.equal(normalizeSpeech(input), baseNormalize(input), input);
  }
  // Явные ожидания плана (в том числе «только ё»).
  assert.equal(normalizeSpeech('не открывай ютюб'), 'не открывай ютюб');
  assert.equal(normalizeSpeech('удали папку отчёты целиком'), 'удали папку отчеты целиком');
  assert.equal(normalizeSpeech('покажи баланс в моём банке'), 'покажи баланс в моем банке');
  assert.equal(normalizeSpeech('отправь письмо на test@example.com'), 'отправь письмо на test example com');
  assert.equal(normalizeSpeech('сохрани, чтобы не потерять'), 'сохрани чтобы не потерять');
  assert.equal(normalizeSpeech('у соседа орёт музыка'), 'у соседа орет музыка');
  // Главный риск: объект удаления не меняется на реальную папку.
  assert.ok(!normalizeSpeech('удали папку лафимикс').includes('лофемикс'));
  // Осознанно: в опасных фразах имена остаются кириллицей.
  assert.equal(normalizeSpeech('установи фотошоп'), 'установи фотошоп');
  // «Переведи компьютер…» — не перевод денег: предохранитель не срабатывает, поэтому №22 закрывается.
  assert.equal(normalizeSpeech('переведи компьютер с 5 в режим'), 'переведи компьютер с 5 в режим');
  assert.ok(!normalizeSpeech('переведи компьютерспять в режим').includes('компьютерспять'));
});

// ── §6.4. Устойчивость ─────────────────────────────────────────

test('§6.4 пустой ввод, идемпотентность, длинный вход', () => {
  assert.equal(normalizeSpeech(''), '');
  assert.equal(normalizeSpeech(null), '');
  assert.equal(normalizeSpeech(undefined), '');
  assert.equal(normalizeSpeech(42), '');

  const quotes = [
    ...fixture.phrases.map((row) => row.expected),
    ...fixture.phrases.map((row) => row.recognized),
    ...GUARD_CASES,
    ...ADVERSARIAL_DANGEROUS,
    ...ADVERSARIAL_NEGATIONS,
    ...ADVERSARIAL_QUESTIONS,
  ];
  for (const text of quotes) {
    const once = normalizeSpeech(text);
    assert.equal(normalizeSpeech(once), once, text);
  }

  // 20 000 символов: без падения и без регэкспов-катастроф.
  const long = 'открой ютуб '.repeat(1600);
  const begin = performance.now();
  normalizeSpeech(long);
  assert.ok(performance.now() - begin < 1000, 'длинный вход должен обрабатываться линейно');
});

// ── §6.5. Интеграция с match.js: симметрия ─────────────────────

test('§6.5 matchCommand: сохранённая русская фраза находит каноническое имя', () => {
  const commands = [command('Ютуб', ['открой ютуб'])];
  const hit = matchCommand('открой ютюб', commands);
  assert.ok(hit, '«открой ютюб» должно найти команду «открой ютуб»');
  assert.equal(hit.via, 'exact');
});

test('§6.5 старая запись с опечаткой не требует миграции', () => {
  const commands = [command('Режим', ['запусти игровый режим'])];
  assert.equal(matchCommand('запусти игровой режим', commands).command.name, 'Режим');
});

test('§6.5 числительное словом находит запись с цифрой', () => {
  const commands = [command('Таймер', ['таймер на 30 минут'], { optionalPhrases: ['поставь'] })];
  assert.equal(normalizePhrase('поставь таймер на тридцать минут'), 'поставь таймер на 30 минут');
  // «поставь» — вежливая оболочка (необязательный глагол), а не часть фразы команды.
  assert.equal(matchCommand('поставь таймер на тридцать минут', commands).command.name, 'Таймер');
});

test('§6.5 склейка «в се» находится через симметричную нормализацию', () => {
  const commands = [command('Окна', ['сверни все окна'])];
  assert.equal(matchCommand('сверни в се окна', commands).command.name, 'Окна');
});

test('§6.5 предохранитель сохраняет объект: опасная фраза не находит чужую папку', () => {
  const real = [command('Лофемикс', ['удали папку лофемикс'])];
  const typo = [command('Лафимикс', ['удали папку лафимикс'])];
  assert.equal(matchCommand('удали папку лафимикс', real), null, '«лафимикс» не подменяется на «лофемикс»');
  assert.equal(matchCommand('удали папку лафимикс', typo).command.name, 'Лафимикс');
});

test('§6.5 отрицание не находит команду', () => {
  const commands = [command('Ютуб', ['ютуб'])];
  assert.equal(matchCommand('не открывай ютуб', commands), null);
});

test('§6.5 склейка двух команд: часть «ютуб» нормализована', () => {
  const commands = [command('Ютуб', ['ютуб']), command('Громкость', ['громкость 30'])];
  const parts = matchSequence('ютуб и громкость 30', commands);
  assert.deepEqual(parts.map((part) => part.command.name), ['Ютуб', 'Громкость']);
  assert.deepEqual(parts.map((part) => part.matched), ['youtube', 'громкость 30']);
});

// ── §6.6. Замер: снимок 30 фраз ────────────────────────────────
// Та же формула сравнения, что в scripts/voice-bench.js: обращение снимает voicePhrase,
// затем «до» — прежняя формула, «после» — прежняя формула поверх normalizeSpeech.
function measured(text) {
  return (voicePhrase(text)?.command || '').toLowerCase().replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\b30\b/g, 'тридцать')
    .replace(/youtube/g, 'ютуб').replace(/dota 2/g, 'дота два')
    .replace(/(?:^| )пожалуйста(?= |$)/g, '').replace(/\s+/g, ' ').trim();
}
const normalized = (text) => measured(text);
const normalizedAfter = (text) => measured(normalizeSpeech(voicePhrase(text)?.command || ''));

test('§6.6 прежняя формула воспроизводит 23/30 из REPORT.md', () => {
  const matched = fixture.phrases.filter((row) => normalized(row.expected) === normalized(row.recognized));
  assert.equal(matched.length, fixture.expectedCounts.before);
});

test('§6.6 новый слой на текущем корпусе: 27/30, остаются №13, №22, №29', () => {
  const failed = fixture.phrases
    .filter((row) => normalizedAfter(row.expected) !== normalizedAfter(row.recognized))
    .map((row) => row.n);
  assert.deepEqual(failed, [13, 22, 29]);
  assert.equal(fixture.phrases.length - failed.length, fixture.expectedCounts.afterCurrentCorpus);
});

test('§6.6 исправленный корпус: 29/30, единственный остаток №13', () => {
  const fixed = fixture.phrases.map((row) => ({ ...row, expected: fixture.fixed[String(row.n)] || row.expected }));
  const failed = fixed
    .filter((row) => normalizedAfter(row.expected) !== normalizedAfter(row.recognized))
    .map((row) => row.n);
  assert.deepEqual(failed, [13]);
  assert.equal(fixed.length - failed.length, fixture.expectedCounts.afterFixedCorpus);
});

// ── §6.6. Состязательные фразы (rev/ADVERSARIAL_PHRASES.md) ─────

const ADVERSARIAL_NEGATIONS = [
  'не открывай ютуб', 'не закрывай окно', 'не надо громче',
  'не открывай браузер, открой блокнот', 'не выключай музыку, а сделай тише', 'ничего не делай',
];

const ADVERSARIAL_DANGEROUS = [
  'удали папку отчёты целиком', 'установи Photoshop', 'отправь письмо на test@example.com: я опаздываю',
  'оплати подписку на сервис', 'переведи 5000 рублей на карту 2200', 'покажи баланс в моём банке',
  'прочитай пароль из Bitwarden', 'очисти корзину и историю браузера',
];

const ADVERSARIAL_QUESTIONS = [
  'Почему ты не закрыл окна?', 'Ты уже открыл ютуб?', 'Сколько сейчас громкость?',
  'Что будет, если я нажму удалить?', 'Можно ли выключить компьютер без сохранения?',
  'Ты умеешь закрывать окна?', 'Можешь закрыть все окна?', 'Какая сейчас погода?',
];

test('§6.6 отрицания 31–36: ни одно «не/ни» не потеряно', () => {
  for (const input of ADVERSARIAL_NEGATIONS) {
    const before = baseNormalize(input).match(/(^| )(не|ни)( |$)/g) || [];
    const after = normalizeSpeech(input).match(/(^| )(не|ни)( |$)/g) || [];
    assert.deepEqual(after, before, input);
  }
});

test('§6.6 опасные 55–62: словарь не меняет ни одну фразу', () => {
  for (const input of ADVERSARIAL_DANGEROUS) {
    assert.equal(normalizeSpeech(input), baseNormalize(input), input);
  }
});

test('§6.6 вопросы 70–77: новых глаголов действия нет, допустимо только «ютуб→youtube»', () => {
  const ACTION = /^(открой|открыть|откройте|закрой|закрыть|удали|удалить|выключи|выключить|запусти|запустить|включи|включить|найди|поставь|переведи|отправь|очисти|установи)/u;
  for (const input of ADVERSARIAL_QUESTIONS) {
    const before = new Set(baseNormalize(input).split(' '));
    for (const token of normalizeSpeech(input).split(' ')) {
      if (!before.has(token)) assert.ok(!ACTION.test(token), `новый глагол действия в «${input}»`);
    }
  }
  // Единственное допустимое изменение — канонизация имени в вопросе №71.
  assert.equal(normalizeSpeech('Ты уже открыл ютуб?'), 'ты уже открыл youtube');
});

// ── §5.5. Подсказка облачному распознавателю (hotwords) ─────────

const fakeRequest = (seen) => async (url, options) => {
  seen.push(options.body);
  return { ok: true, json: async () => ({ text: 'проверка' }) };
};

test('§5.5 облачный движок кладёт prompt в форму и не ломает прежние поля', async () => {
  const seen = [];
  const provider = cloudProvider({
    url: 'https://example.invalid/asr', model: 'fixture', prompt: 'YouTube, Steam',
    request: fakeRequest(seen),
  });
  const result = await provider.transcribe(Buffer.from([1, 2, 3, 4]), { language: 'auto' });
  assert.equal(result.text, 'проверка');
  const form = seen[0];
  assert.equal(form.get('prompt'), 'YouTube, Steam');
  assert.equal(form.get('model'), 'fixture');
  assert.equal(form.get('language'), null);
  assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), wavFromPcm(Buffer.from([1, 2, 3, 4])));
});

test('§5.5 пустой prompt: поля нет; функция prompt собирается на каждый запрос', async () => {
  for (const prompt of ['', undefined, () => '']) {
    const seen = [];
    const provider = cloudProvider({ url: 'https://example.invalid/asr', model: 'fixture', prompt, request: fakeRequest(seen) });
    await provider.transcribe(Buffer.alloc(640));
    assert.equal(seen[0].get('prompt'), null, String(prompt));
  }
  let calls = 0;
  const seen = [];
  const provider = cloudProvider({
    url: 'https://example.invalid/asr', model: 'fixture', request: fakeRequest(seen),
    prompt: () => { calls += 1; return `YouTube, Steam, вызов ${calls}`; },
  });
  await provider.transcribe(Buffer.alloc(640));
  await provider.transcribe(Buffer.alloc(640));
  assert.equal(seen[0].get('prompt'), 'YouTube, Steam, вызов 1');
  assert.equal(seen[1].get('prompt'), 'YouTube, Steam, вызов 2');
});

test('§5.5 clipPrompt: не рвёт слово и не оставляет запятую', () => {
  assert.equal(clipPrompt('a, b, c', 4), 'a');
  assert.equal(clipPrompt('abcdefghij', 4), 'abcd');
  assert.equal(clipPrompt('YouTube, Steam, Discord', 12), 'YouTube');
  assert.equal(clipPrompt('  YouTube,  Steam  '), 'YouTube, Steam');
});

test('§5.5 buildHotwords: имена продукта, без обращения, в пределах потолка', () => {
  const hotwords = buildHotwords();
  assert.ok(hotwords.length > 0 && hotwords.length <= MAX_CLOUD_PROMPT, `${hotwords.length} символов`);
  assert.ok(hotwords.includes('Switch show'));
  assert.ok(hotwords.includes('YouTube'));
  assert.ok(hotwords.includes('лофемикс'));
  assert.ok(!hotwords.includes('Джарвис'), 'обращение — шум для распознавателя');
  // Те же имена, что в словаре §2.6, иначе подсказка и пост-коррекция спорят.
  for (const name of ['Dota 2', 'Steam', 'Telegram', 'Discord', 'Chrome', 'Spotify']) {
    assert.ok(hotwords.includes(name), name);
  }
});
