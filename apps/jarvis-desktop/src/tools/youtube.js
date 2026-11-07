'use strict';

// youtube_play: найти песню или видео и открыть первое видео сразу на нужной секунде.
// Открывает через url_open (тот же браузер владельца и та же проверка окна), поиск — src/music/play.js.
const { findFirstYoutubeVideo, atSecond } = require('../music/play');
const { SERVICES, stripOtherDeals } = require('../music/intent');

function youtubeTools(urlOpen, { find = findFirstYoutubeVideo, notePlay = null } = {}) {
  const youtubePlay = {
    name: 'youtube_play',
    description: 'Найти на YouTube песню или видео по запросу и открыть первое видео в браузере. start — с какой секунды включить (например 16).',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        start: { type: 'integer', minimum: 0, maximum: 86400 },
      },
      required: ['query'],
    },
    async run(args, ctx = {}) {
      // Модель иногда передаёт просьбу целиком («мияги бадабум проверить погоду»): чужие дела в поиск не идут.
      const query = stripOtherDeals((args && args.query) || '');
      if (!query) return { ok: false, summary: 'пустой запрос', data: {} };
      const start = Number.isInteger(args.start) && args.start > 0 ? args.start : null;
      const video = await find(query);
      // Видео не нашли: открываем страницу поиска, секунду туда не передать.
      const url = video ? atSecond(video.url, start) : SERVICES.youtube.url(query);
      const res = await urlOpen.run({ url }, ctx);
      if (!res.ok) return res;
      // История не критична: музыка уже играет.
      try {
        if (notePlay) notePlay(query);
      } catch {
        // Историю не записали — ничего не ломаем.
      }
      const summary = video
        ? `открыто «${video.title}»${start ? ` с ${start}-й секунды` : ''}`
        : `открыт поиск «${query}»: первое видео не найдено${start ? ', перемотку сделать не удалось' : ''}`;
      return { ok: true, summary, data: { ...res.data, url, videoId: video ? video.id : null, start: video ? start : null } };
    },
    verify: (args, result, ctx) => urlOpen.verify(args, result, ctx),
  };
  return [youtubePlay];
}

module.exports = { youtubeTools };
