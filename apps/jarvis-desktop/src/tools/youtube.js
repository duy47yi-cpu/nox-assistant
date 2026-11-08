'use strict';

// youtube_play: найти песню или видео и открыть видео сразу на нужной секунде.
// Открывает через url_open (тот же браузер владельца и та же проверка окна), поиск — src/music/play.js.
// Видео открывается, только если его название совпадает с просьбой; иначе отдаёт варианты и не открывает ничего.
const { findYoutubeCandidates, atSecond } = require('../music/play');
const { chooseVideo } = require('../music/match');
const { SERVICES, stripOtherDeals } = require('../music/intent');

function youtubeTools(urlOpen, { find = findYoutubeCandidates, notePlay = null } = {}) {
  const youtubePlay = {
    name: 'youtube_play',
    description: 'Найти на YouTube песню или видео по запросу и открыть его. Открывает, только если название совпадает с запросом; иначе вернёт варианты, и надо спросить владельца. start — с какой секунды включить (например 16).',
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
      const candidates = await find(query);
      const pick = chooseVideo(query, candidates);
      if (!pick.video) {
        // Видео не нашли: открываем страницу поиска, секунду туда не передать.
        const url = SERVICES.youtube.url(query);
        const res = await urlOpen.run({ url }, ctx);
        if (!res.ok) return res;
        return { ok: true, summary: `открыт поиск «${query}»: первое видео не найдено${start ? ', перемотку сделать не удалось' : ''}`, data: { ...res.data, url, videoId: null, start: null } };
      }
      if (!pick.confident) {
        // Не уверены, что это то самое: ничего не открываем, варианты уходят модели, она спросит владельца.
        const options = pick.options.map((v, i) => `${i + 1}) ${v.title}`).join('; ');
        return { ok: false, summary: `не уверен, какое видео по запросу «${query}»: ${options}`, data: { options: pick.options.map((v) => ({ title: v.title, url: v.url })) } };
      }
      const url = atSecond(pick.video.url, start);
      const res = await urlOpen.run({ url }, ctx);
      if (!res.ok) return res;
      // История не критична: музыка уже играет.
      try {
        if (notePlay) notePlay(query);
      } catch {
        // Историю не записали — ничего не ломаем.
      }
      const summary = `открыто «${pick.video.title}»${start ? ` с ${start}-й секунды` : ''}`;
      return { ok: true, summary, data: { ...res.data, url, videoId: pick.video.id, start } };
    },
    verify: (args, result, ctx) => urlOpen.verify(args, result, ctx),
  };
  return [youtubePlay];
}

module.exports = { youtubeTools };
