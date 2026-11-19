'use strict';

// P0: секрет узнаётся по смыслу, а не только по двоеточию.
// Проверка одна на проект (src/memory/secrets.js): её зовут память, журнал, буфер обмена и правила доступа.
// Тесты держат обе стороны: что обязано ловиться и что обязано оставаться читаемым.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  looksSecret,
  looksSecretEgress,
  maskSecretText,
  findSecrets,
} = require('../src/memory/secrets');
const { maskSecrets } = require('../src/journal/journal');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryStore } = require('../src/memory/store');

// Память пишет на диск: даём временный файл и убираем за собой.
function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-secrets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemoryStore(path.join(dir, 'memory.json'));
}

// Как люди пишут на самом деле: с пробелом, со словами между меткой и значением, с числом.
const SECRETS = [
  'пароль hunter2',
  'Пароль от Wi-Fi: hunter2',
  'мой пароль Qwerty2024 от почты',
  'pin 1234',
  'pin: 1234',
  'пин-код 4821',
  'вход: Qwerty',
  'логин: ivan.petrov',
  'token=ab12cd34ef',
  'api key: sk-abcdef1234567890abcdef',
  '8f3ba9d1c2e4a7b6',
  'AB12CD34EF56AB78',
  'ab12cd34ef56ab78cd90ef12',
  'Zx7Kq2Lm9Pw4Rt5',
  'sk-abcdef1234567890abcdef',
  'ghp_aBcDeF1234567890aBcDeF123456',
  'AKIAABCDEFGHIJKLMNOP',
];

// Обычный текст: маскировать его нельзя, иначе журнал и вопросы станут бесполезными.
const PLAIN = [
  'сколько время',
  'Купить молоко и хлеб',
  'Договорились: встреча в 15:00',
  'код ошибки 500',
  'код города 495',
  'вход в систему',
  'пароль обязателен',
  'Win32_OperatingSystem',
  'Release-2026-11-19',
  'Checkout-2026',
  'npm run check-tools',
  'learn-after-turn',
  'main-branch',
  'README.md',
  '8f3ba9d1-c2e4-a7b6-8f3b-a9d1c2e4a7b6',
  '2026-11-19T12:34:56.789Z',
];

test('секрет ловится в том виде, как его пишут люди', () => {
  for (const text of SECRETS) assert.equal(looksSecret(text), true, text);
});

// Код — слабая метка: память его принимает («код домофона» — обычный факт), а маска и вопрос ловят.
test('коды памяти не мешают, но в исходящем и в маске закрываются', () => {
  for (const text of ['код 4821', 'код подтверждения 4821', 'код: AB12CD', 'Код от домофона 4821']) {
    assert.equal(looksSecret(text), false, `${text}: память принимает`);
    assert.equal(looksSecretEgress(text), true, `${text}: исходящее спрашивает`);
    assert.match(maskSecretText(text), /\[скрыто\]/, `${text}: в журнале закрыто`);
  }
});

test('обычный текст секретом не считается', () => {
  for (const text of PLAIN) assert.equal(looksSecret(text), false, text);
});

test('двоеточие не обязательно, но метка не съедается маской', () => {
  assert.equal(maskSecretText('пароль hunter2'), 'пароль [скрыто]');
  assert.equal(maskSecretText('Пароль от Wi-Fi: hunter2'), 'Пароль от Wi-Fi: [скрыто]');
  assert.equal(maskSecretText('pin 1234, код 4821'), 'pin [скрыто], код [скрыто]');
  assert.equal(maskSecretText('ip 10.0.0.5 и пароль hunter2'), 'ip 10.0.0.5 и пароль [скрыто]');
});

test('маска журнала закрывает пароль и в описании, и в имени поля', () => {
  const text = maskSecrets('Пароль от Wi-Fi: hunter2');
  assert.equal(text, 'Пароль от Wi-Fi: [скрыто]');
  assert.equal(maskSecrets({ password: 'hunter2', login: 'ivan' }).password.startsWith('[скрыто'), true);
  assert.equal(maskSecrets({ login: 'ivan' }).login, 'ivan');
  assert.equal(maskSecrets('Release-2026-11-19'), 'Release-2026-11-19');
});

test('секрет в исходящем: адрес с параметром тоже считается', () => {
  const cases = [
    'https://x.ru/?k=8f3ba9d1c2',
    'https://x.ru/a?token=ab12cd34ef56',
    'https://user:pass@example.ru/x',
    'Authorization: Bearer abcdefghijkl123456',
    '{"password":"hunter2"}',
  ];
  for (const text of cases) assert.equal(looksSecretEgress(text), true, text);
  assert.equal(looksSecretEgress('https://example.ru/stati/2026/11'), false);
  assert.equal(looksSecretEgress('посмотри погоду на завтра'), false);
});

test('найденные диапазоны указывают ровно на значение', () => {
  const text = 'пароль hunter2, остальное потом';
  const [range] = findSecrets(text);
  assert.equal(text.slice(range.start, range.end), 'hunter2');
});

test('значение-стоп-слово не прячется', () => {
  assert.equal(looksSecret('пароль обязателен'), false);
  assert.equal(maskSecretText('пароль обязателен'), 'пароль обязателен');
  // Но с настоящим значением рядом — прячется.
  assert.equal(maskSecretText('пароль обязателен: hunter2'), 'пароль обязателен: [скрыто]');
});

test('память не принимает запись, похожую на пароль, в любой записи', (t) => {
  const store = tempStore(t);
  assert.throws(() => store.add({ text: 'пароль hunter2' }), /похоже на пароль/);
  assert.throws(() => store.add({ text: 'Wi-Fi: 8f3ba9d1c2e4a7b6' }), /похоже на пароль/);
  assert.doesNotThrow(() => store.add({ text: 'Люблю чай с молоком' }));
});

test('цитата-источник с секретом не сохраняется', (t) => {
  const store = tempStore(t);
  const base = { path: 'notes/wifi.md', sha256: 'a'.repeat(64), size: 10, at: new Date().toISOString() };
  assert.throws(() => store.add({ text: 'Wi-Fi дома описан в заметке', source: { ...base, quote: 'пароль hunter2' } }), /цитата похожа на пароль/);
  // Обычная цитата рядом с секретом остаётся.
  const item = store.add({ text: 'Wi-Fi дома описан в заметке', source: { ...base, quote: 'роутер стоит в коридоре' } });
  assert.equal(item.source.quote, 'роутер стоит в коридоре');
});
