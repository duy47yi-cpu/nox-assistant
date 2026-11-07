'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SERVICES, isMusicRequest, parseService, cleanQuery, isResetServiceRequest, isPronounPlay, queryWords, hasPlayWord, matchHistory, repeatLast } = require('../src/music/intent');

test('после «поставь песню X» фраза «поставь ещё такую же» даёт тот же запрос', () => {
  const entries = [{ service: 'youtube', query: cleanQuery('поставь песню мияги бадабум') }];
  assert.deepEqual(repeatLast('поставь ещё такую же', entries), { service: 'youtube', query: 'мияги бадабум' });
  assert.deepEqual(repeatLast('поставь похожую', entries), { service: 'youtube', query: 'мияги бадабум' });
  assert.equal(repeatLast('поставь мияги', entries), null, 'обычная просьба с названием — не повтор');
  assert.equal(repeatLast('поставь ещё такую же мияги', entries), null, 'с новым названием — не повтор');
  assert.deepEqual(repeatLast('поставь ещё такую же', []), {}, 'истории нет — пустой результат, без поиска');
});

test('лишние слова «короче», «давай», «любую» не попадают в запрос', () => {
  assert.equal(cleanQuery('короче, поставь музыку на ютубе. Любую.'), 'музыка');
  assert.equal(cleanQuery('давай просто поставь мияги'), 'мияги');
});

test('«ладно, поставь музыку самая самая» даёт запрос «самая самая»', () => {
  assert.equal(cleanQuery('ладно. Поставь музыку "самая самая"'), 'самая самая');
});

test('«поставь её» распознаётся как повтор последней просьбы, «поставь музыку» — нет', () => {
  assert.equal(isPronounPlay('поставь её'), true);
  assert.equal(isPronounPlay('ладно, поставь ее.'), true);
  assert.equal(isPronounPlay('поставь музыку'), false);
  assert.equal(isPronounPlay('поставь'), false);
});

test('просьба сменить сервис распознаётся', () => {
  assert.equal(isResetServiceRequest('смени музыкальный сервис'), true);
  assert.equal(isResetServiceRequest('поставь музыку'), false);
});

test('музыкальная просьба распознаётся, обычные команды — нет', () => {
  assert.equal(isMusicRequest('поставь музыку любую от мияги'), true);
  assert.equal(isMusicRequest('открой ютуб и поставь там музыку'), true);
  assert.equal(isMusicRequest('джарвис, поставь спокойную песню'), true);
  assert.equal(isMusicRequest('громкость 30'), false);
  assert.equal(isMusicRequest('открой github.com'), false);
});

test('сервис распознаётся из ответа владельца', () => {
  assert.equal(parseService('YouTube Music'), 'youtube_music');
  assert.equal(parseService('ютуб музыка'), 'youtube_music');
  assert.equal(parseService('ютуб'), 'youtube');
  assert.equal(parseService('Яндекс Музыка'), 'yandex');
  assert.equal(parseService('давай spotify'), 'spotify');
  assert.equal(parseService('не знаю'), null);
});

test('ссылка «та самая самая» находит ранее сыгранный запрос', () => {
  const history = [{ service: 'youtube', query: 'мияги бадабум' }, { service: 'youtube', query: 'самая самая' }];
  const hit = matchHistory('ахахах слушай, а самая та самая самая.. что то так было, можешь поставить?', history);
  assert.deepEqual(hit, { service: 'youtube', query: 'самая самая' });
  assert.equal(matchHistory('поставь мияги бадабум', history), null, 'без маркера ссылки история не используется');
  assert.equal(matchHistory('та песня', []), null);
});

test('фраза без названия не даёт запроса: «это песня, найди её, не помню названием»', () => {
  assert.deepEqual(queryWords('это песня, найди её пожалуйста, я не помню названием'), []);
  assert.equal(hasPlayWord('найди её'), true);
});

test('«название» из живой фразы не попадает в поиск', () => {
  assert.equal(cleanQuery('поставь короче.. музыку от мияги, название бадабум'), 'мияги бадабум');
});

test('подтверждения «да согласен, ставь» не попадают в поиск', () => {
  assert.equal(cleanQuery('поставь музыку бадабум. Да согласен, ставь.'), 'бадабум');
  assert.equal(cleanQuery('ставь бадабум, согласна'), 'бадабум');
});

test('запрос очищается от слов-пустышек', () => {
  assert.equal(cleanQuery('поставь музыку любую от мияги'), 'мияги');
  assert.equal(cleanQuery('джарвис, поставь спокойную песню'), 'спокойную');
  assert.equal(cleanQuery('поставь музыку'), 'музыка');
});

test('адреса поиска кодируют запрос и не выходят за сервис', () => {
  assert.equal(SERVICES.youtube.url('мияги & андипанда'), 'https://www.youtube.com/results?search_query=%D0%BC%D0%B8%D1%8F%D0%B3%D0%B8%20%26%20%D0%B0%D0%BD%D0%B4%D0%B8%D0%BF%D0%B0%D0%BD%D0%B4%D0%B0');
  assert.ok(SERVICES.yandex.url('x').startsWith('https://music.yandex.ru/search?text='));
  assert.ok(SERVICES.spotify.url('x').startsWith('https://open.spotify.com/search/'));
});

test('песня по фрагменту и «поставь + название» — музыка; настройки ПК — нет; длительность не в запросе', () => {
  const { isMusicRequest, cleanQuery } = require('../src/music/intent');
  assert.equal(isMusicRequest('поставь Слава Мерлоу Лоу Кик'), true);
  assert.equal(isMusicRequest('я щас в тиктоке была песня ты как закаты ты как рассветы, найди и поставь'), true);
  assert.equal(isMusicRequest('поставь громкость 30'), false);
  assert.equal(isMusicRequest('поставь сценарий работа'), false);
  assert.equal(isMusicRequest('включи свет'), false);
  assert.doesNotMatch(cleanQuery('включи мне спокойную музыку на час'), /час/);
  assert.match(cleanQuery('включи мне спокойную музыку на 30 минут'), /спокойную/);
});

test('команды к кнопке и уточнения не попадают в поиск', () => {
  assert.equal(cleanQuery('поставь её, нажми на play'), 'музыка');
  assert.equal(cleanQuery('именно то, что я хотел. Поставь любую музыку xcho'), 'xcho');
});
test('приветствие не попадает в поиск', () => {
  assert.equal(cleanQuery('привет, поставь песню муцараева'), 'муцараева');
});
