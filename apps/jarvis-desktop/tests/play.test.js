'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findFirstYoutubeVideo, pickFromHtml, cleanTitle } = require('../src/music/play');

// Фрагмент страницы результатов YouTube: название экранировано, как в настоящей выдаче.
const PAGE = '<html>…"contents":[{"videoRenderer":{"videoId":"MQM06kieupQ","thumbnail":{"thumbnails":[]},'
  + '"title":{"runs":[{"text":"Miyagi - \\u0411\\u0430\\u0434\\u0430\\u0411\\u0443\\u043c (Lyric Video) | YouTube Exclusive"}],'
  + '"accessibility":{}},"longBylineText":{"runs":[{"text":"HAJIMAN"}]}}},'
  + '{"videoRenderer":{"videoId":"AO8dJ5kbruE","title":{"runs":[{"text":"Other"}]}}}…</html>';

test('первое видео берётся из HTML страницы результатов, название раскодировано', () => {
  const video = pickFromHtml(PAGE);
  assert.deepEqual(video, {
    id: 'MQM06kieupQ',
    title: 'Miyagi - БадаБум (Lyric Video) | YouTube Exclusive',
    url: 'https://www.youtube.com/watch?v=MQM06kieupQ',
  });
});

test('если видео в HTML нет, результат пустой', () => {
  assert.equal(pickFromHtml('<html>ничего</html>'), null);
  assert.equal(pickFromHtml(''), null);
  assert.equal(pickFromHtml(undefined), null);
});

test('эмодзи и хвост с длительностью убираются из названия', () => {
  assert.equal(cleanTitle('👍Бадабум музыка мияги эндшпиль. ❤ 40 seconds'), 'Бадабум музыка мияги эндшпиль.');
  assert.equal(cleanTitle('MiyaGi & Эндшпиль, Amigo - Самая 4 minutes, 48 seconds'), 'MiyaGi & Эндшпиль, Amigo - Самая');
  assert.equal(cleanTitle('   '), 'видео');
});

test('findFirstYoutubeVideo запрашивает поиск по закодированному запросу и разбирает ответ', async () => {
  let requested = null;
  const fetchImpl = async (url, opts) => {
    requested = { url, opts };
    return { ok: true, text: async () => PAGE };
  };
  const video = await findFirstYoutubeVideo('мияги бадабум', { fetchImpl });
  assert.equal(video.id, 'MQM06kieupQ');
  assert.equal(requested.url, 'https://www.youtube.com/results?search_query=%D0%BC%D0%B8%D1%8F%D0%B3%D0%B8%20%D0%B1%D0%B0%D0%B4%D0%B0%D0%B1%D1%83%D0%BC');
  assert.ok(requested.opts.signal, 'запрос должен поддерживать отмену по таймауту');
});

test('сбой сети, таймаут или пустой запрос дают null, без исключений', async () => {
  const broken = async () => { throw new Error('сеть недоступна'); };
  assert.equal(await findFirstYoutubeVideo('бадабум', { fetchImpl: broken }), null);
  assert.equal(await findFirstYoutubeVideo('   ', { fetchImpl: broken }), null);
  const bad = async () => ({ ok: false, text: async () => '' });
  assert.equal(await findFirstYoutubeVideo('бадабум', { fetchImpl: bad }), null);
});
