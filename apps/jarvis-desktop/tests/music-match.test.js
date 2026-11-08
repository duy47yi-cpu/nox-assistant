'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreTitle, chooseVideo, parseChoice, skeleton } = require('../src/music/match');
const { cleanQuery } = require('../src/music/intent');
const { youtubeTools } = require('../src/tools/youtube');

const video = (id, title) => ({ id, title, url: `https://www.youtube.com/watch?v=${id}` });

test('русское произношение находит английское название: «тентасион» → XXXTentacion', () => {
  assert.equal(skeleton('тентасион'), skeleton('Tentacion'));
  assert.equal(scoreTitle('тентасион', 'XXXTENTACION - MOONLIGHT (OFFICIAL MUSIC VIDEO)').ratio, 1);
  assert.equal(scoreTitle('мияги бадабум', 'Miyagi & Andy Panda - Badabum').ratio, 1);
  assert.equal(skeleton('moonlight'), skeleton('мунлайт'));
});

test('слово, которого нет в названиях, не даёт полного совпадения', () => {
  const s = scoreTitle('тентасион спулаемулае', 'XXXTENTACION - MOONLIGHT (OFFICIAL MUSIC VIDEO)');
  assert.equal(s.ratio, 0.5);
  assert.equal(s.total, 2);
});

test('полное совпадение — открываем сразу; частичное — спрашиваем с вариантами', () => {
  const list = [video('aaaaaaaaaaa', 'Some Other Band - Song'), video('bbbbbbbbbbb', 'Miyagi & Andy Panda - Badabum'), video('ccccccccccc', 'Badabum Remix')];
  const pick = chooseVideo('мияги бадабум', list);
  assert.equal(pick.confident, true);
  assert.equal(pick.video.id, 'bbbbbbbbbbb');
  const unsure = chooseVideo('тентасион спулаемулае', [video('ddddddddddd', 'XXXTENTACION - MOONLIGHT'), video('eeeeeeeeeee', 'Another')]);
  assert.equal(unsure.confident, false);
  assert.equal(unsure.options.length, 2);
  assert.equal(chooseVideo('x y z', []).video, null);
});

test('ответ владельца: номер или порядковое слово', () => {
  assert.equal(parseChoice('2', 3), 2);
  assert.equal(parseChoice('второе', 3), 2);
  assert.equal(parseChoice('первую', 3), 1);
  assert.equal(parseChoice('5', 3), null);
  assert.equal(parseChoice('поставь мияги', 3), null);
});

test('опечатка «музика» не попадает в поисковый запрос', () => {
  assert.equal(cleanQuery('поставь музика тентасион'), 'тентасион');
});

test('youtube_play: не уверен — ничего не открывает и отдаёт варианты', async () => {
  const opened = [];
  const urlOpen = { run: async ({ url }) => { opened.push(url); return { ok: true, summary: 'открыто', data: { host: 'www.youtube.com' } }; }, verify: async () => ({ status: 'confirmed' }) };
  const [tool] = youtubeTools(urlOpen, { find: async () => [video('ddddddddddd', 'XXXTENTACION - MOONLIGHT'), video('eeeeeeeeeee', 'Another')] });
  const res = await tool.run({ query: 'тентасион спулаемулае' });
  // Это вопрос владельцу, а не сбой: ok и quiet, чтобы карточка действия в чате не появлялась.
  assert.equal(res.ok, true);
  assert.equal(res.quiet, true);
  assert.match(res.summary, /не открыл: не уверен/);
  assert.equal(opened.length, 0);
});

test('youtube_play: совпадение — открывает видео с нужной секундой', async () => {
  const opened = [];
  const urlOpen = { run: async ({ url }) => { opened.push(url); return { ok: true, summary: 'открыто', data: { host: 'www.youtube.com' } }; }, verify: async () => ({ status: 'confirmed' }) };
  const [tool] = youtubeTools(urlOpen, { find: async () => [video('bbbbbbbbbbb', 'Miyagi & Andy Panda - Badabum')] });
  const res = await tool.run({ query: 'мияги бадабум', start: 16 });
  assert.equal(res.ok, true);
  assert.deepEqual(opened, ['https://www.youtube.com/watch?v=bbbbbbbbbbb&t=16s']);
});
