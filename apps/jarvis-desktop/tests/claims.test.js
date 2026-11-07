'use strict';

// Проверка набора источников web_research: память процесса, TTL, лимиты объёма
// и сверка утверждений с дословными цитатами.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const claims = require('../src/research/claims');

beforeEach(() => claims.resetStore());

function source(id, text, extra = {}) {
  return { id, url: `https://example.com/${id}`, title: `Источник ${id}`, text, ...extra };
}

test('регистрация и получение: набор доступен по ID, latestBundle отдаёт его же', () => {
  const id = claims.registerBundle({ sources: [source('S1', 'Текст первой страницы'), source('s2', 'Текст второй')] });

  assert.equal(typeof id, 'string');
  assert.match(id, /^research_/);
  const sources = claims.getSources(id);
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((item) => item.id), ['S1', 's2']);
  assert.equal(sources[0].url, 'https://example.com/S1');
  assert.equal(sources[0].title, 'Источник S1');
  assert.equal(sources[0].text, 'Текст первой страницы');

  const latest = claims.latestBundle();
  assert.equal(latest.researchId, id);
  assert.equal(latest.sources.length, 2);
  assert.equal(claims.getBundle(id).researchId, id);
  assert.equal(claims.getSources('research_нет'), null);
  assert.equal(claims.getBundle(undefined), null);
});

test('регистрация: пустой набор не запоминается, повторные ID схлопываются', () => {
  assert.equal(claims.registerBundle({ sources: [] }), null);
  assert.equal(claims.registerBundle({}), null);
  assert.equal(claims.latestBundle(), null);

  const id = claims.registerBundle({ sources: [source('S1', 'первый'), source('s1', 'второй'), source('', 'без id')] });
  const sources = claims.getSources(id);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].text, 'первый');
});

test('совпадение с нормализацией: регистр, ё/е, лишние пробелы и переводы строк', () => {
  const id = claims.registerBundle({
    sources: [source('S1', 'Ёжик   живёт\nв лесу. Его дом — нора.')],
  });
  const bundle = claims.getBundle(id);

  const results = claims.checkClaims(bundle, [
    { text: 'Ёжики живут в лесу.', sources: ['s1'], quote: 'ежик живет В ЛЕСУ' },
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'supported');
  assert.equal(results[0].source, 'S1');
  assert.match(results[0].evidence, /^S1: «/);
  assert.match(results[0].evidence, /живёт/);
  assert.match(results[0].evidence, /в лесу/);
});

test('цитата ищется в любом из указанных источников и отдаёт его ID', () => {
  const id = claims.registerBundle({
    sources: [source('S1', 'Кошки любят тепло.'), source('S2', 'Собаки любят кости и прогулки.')],
  });

  const [result] = claims.checkClaims(claims.getBundle(id), [
    { text: 'Собаки любят кости.', sources: ['S1', 'S2'], quote: 'собаки любят кости' },
  ]);
  assert.equal(result.status, 'supported');
  assert.equal(result.source, 'S2');
});

test('пересказ без дословной цитаты — unsupported', () => {
  const id = claims.registerBundle({ sources: [source('S1', 'Кошки живут в домах и любят тепло.')] });

  const [result] = claims.checkClaims(claims.getBundle(id), [
    { text: 'Кошки домашние животные.', sources: ['S1'], quote: 'кошки — домашние животные' },
  ]);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.source, null);
  assert.match(result.evidence, /пересказ/);
});

test('нет цитаты — no_quote, подтвердить нельзя', () => {
  const id = claims.registerBundle({ sources: [source('S1', 'Любой текст.')] });
  const bundle = claims.getBundle(id);

  for (const quote of [undefined, '', '   ', '\n\t ']) {
    const [result] = claims.checkClaims(bundle, [{ text: 'Утверждение', sources: ['S1'], quote }]);
    assert.equal(result.status, 'no_quote');
    assert.equal(result.source, null);
    assert.match(result.evidence, /подтвердить нельзя/);
  }
});

test('неизвестный источник — unknown_source, даже если цитата есть в другом', () => {
  const id = claims.registerBundle({ sources: [source('S1', 'Кошки любят тепло.')] });
  const bundle = claims.getBundle(id);

  const unknown = claims.checkClaims(bundle, [
    { text: 'Утверждение', sources: ['S9'], quote: 'кошки любят тепло' },
  ])[0];
  assert.equal(unknown.status, 'unknown_source');
  assert.match(unknown.evidence, /S9/);

  const noSources = claims.checkClaims(bundle, [{ text: 'Утверждение', sources: [], quote: 'кошки любят тепло' }])[0];
  assert.equal(noSources.status, 'unknown_source');
  assert.match(noSources.evidence, /не указаны/);

  const partly = claims.checkClaims(bundle, [
    { text: 'Утверждение', sources: ['S1', 'S9'], quote: 'кошки любят тепло' },
  ])[0];
  assert.equal(partly.status, 'unknown_source');
  assert.match(partly.evidence, /S9/);
});

test('непрочитанный источник — unknown_source с пояснением', () => {
  const id = claims.registerBundle({ sources: [source('S1', 'Текст прочитанной страницы.'), source('S2', '')] });

  const [result] = claims.checkClaims(claims.getBundle(id), [
    { text: 'Утверждение', sources: ['S2'], quote: 'текст прочитанной страницы' },
  ]);
  assert.equal(result.status, 'unknown_source');
  assert.match(result.evidence, /не прочитаны?/);
  assert.match(result.evidence, /S2/);
});

test('checkClaims — чистая функция: набор не меняется', () => {
  const id = claims.registerBundle({ sources: [source('S1', 'Кошки любят тепло.')] });
  const bundle = claims.getBundle(id);
  const before = JSON.stringify(bundle);

  claims.checkClaims(bundle, [
    { text: 'Кошки любят тепло.', sources: ['S1'], quote: 'кошки любят тепло' },
    { text: 'Собаки лают.', sources: ['S1'], quote: 'собаки лают' },
  ]);

  assert.equal(JSON.stringify(bundle), before);
});

test('TTL 30 минут: после срока набор не находится, latestBundle пуст', () => {
  const now = 1_000_000;
  const id = claims.registerBundle({ sources: [source('S1', 'Текст')] }, { now });
  assert.ok(claims.getSources(id, { now: now + claims.TTL_MS - 1 }));
  assert.equal(claims.getSources(id, { now: now + claims.TTL_MS }), null);
  assert.equal(claims.latestBundle({ now: now + claims.TTL_MS }), null);

  // Часы можно передать функцией, как в остальных модулях.
  const nowFn = () => now + claims.TTL_MS + 5;
  assert.equal(claims.getSources(id, { now: nowFn }), null);
});

test('вытеснение: хранятся только 5 последних наборов', () => {
  const ids = [];
  for (let i = 1; i <= 6; i += 1) {
    ids.push(claims.registerBundle({ sources: [source('S1', `набор ${i}`)] }));
  }
  assert.equal(new Set(ids).size, 6, 'ID уникальны');
  assert.equal(claims.getSources(ids[0]), null, 'самый старый вытеснен');
  assert.equal(claims.getSources(ids[1]).length, 1);
  assert.equal(claims.getSources(ids[5]).length, 1);
  assert.equal(claims.latestBundle().researchId, ids[5]);
});

test('latestBundle выбирает набор по времени сбора, а не по порядку вставки', () => {
  const now = 300;
  const oldId = claims.registerBundle({ sources: [source('S1', 'старый')], at: 200 }, { now });
  const newId = claims.registerBundle({ sources: [source('S1', 'новый')], at: 100 }, { now });
  assert.equal(claims.latestBundle({ now }).researchId, oldId);
  const freshId = claims.registerBundle({ sources: [source('S1', 'свежий')], at: 250 }, { now });
  assert.equal(claims.latestBundle({ now }).researchId, freshId);
  assert.ok(newId);
});

test('лимит объёма набора: текст обрезается, набор не больше 2 МБ символов', () => {
  const many = Array.from({ length: 30 }, (_, i) => source(`S${i + 1}`, 'а'.repeat(100000)));
  const id = claims.registerBundle({ sources: many });
  const sources = claims.getSources(id);

  assert.equal(sources.length, 30);
  const total = sources.reduce((sum, item) => sum + item.text.length, 0);
  assert.ok(total <= claims.MAX_BUNDLE_CHARS, `объём ${total} не больше ${claims.MAX_BUNDLE_CHARS}`);
  assert.ok(total > claims.MAX_BUNDLE_CHARS - claims.MAX_SOURCE_CHARS, 'набор заполнен почти целиком');
  assert.equal(sources[0].text.length, 100000);
  assert.ok(sources[sources.length - 1].text.length < 100000, 'хвост обрезан');
});

test('общий лимит объёма: старые наборы вытесняются, суммарно не больше 5 МБ', () => {
  const makeBundle = (label) => ({
    sources: Array.from({ length: 25 }, (_, i) => source(`S${i + 1}`, `${label}${'а'.repeat(99999)}`)),
  });
  const ids = [1, 2, 3].map((n) => claims.registerBundle(makeBundle(`набор${n}-`)));

  assert.equal(claims.getSources(ids[0]), null, 'самый старый вытеснен по общему объёму');
  assert.ok(claims.getSources(ids[1]));
  assert.ok(claims.getSources(ids[2]));
  let total = 0;
  for (const id of ids) {
    const sources = claims.getSources(id);
    if (sources) total += sources.reduce((sum, item) => sum + item.text.length, 0);
  }
  assert.ok(total <= claims.MAX_TOTAL_CHARS, `суммарный объём ${total} не больше ${claims.MAX_TOTAL_CHARS}`);
});

test('модуль не пишет на диск: нет require fs и операций записи', () => {
  const file = path.join(__dirname, '..', 'src', 'research', 'claims.js');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!/require\(\s*['"]fs['"]\s*\)/.test(text), 'модуль не требует fs');
  assert.ok(!/\b(writeFile|appendFile|createWriteStream|mkdir|openSync|writeSync)\b/.test(text), 'нет операций записи');
});
