'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { getCurrentWeather, resetCache } = require('../src/weather/open-meteo');

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const T0 = 1_700_000_000_000;
const now = () => T0;

const SPB = { name: 'Санкт-Петербург', latitude: 59.93863, longitude: 30.31413 };
const GEO_BODY = { results: [SPB] };
const WEATHER_BODY = {
  current_weather: { temperature: 12.4 },
  current: { apparent_temperature: 10.1, precipitation: 0.3 },
};

// Подменённый fetch: считает вызовы и отдаёт заготовленный ответ по куску адреса.
// Реальной сети нет: каждый адрес должен найтись в заготовках.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const link = String(url);
    calls.push({ url: link, opts });
    const route = routes.find((r) => link.includes(r.match));
    if (!route) throw new Error('нет заготовки для ' + link);
    return { ok: route.ok !== false, text: async () => JSON.stringify(route.body) };
  };
  return { fetchImpl, calls };
}

const setup = (geoBody = GEO_BODY, weatherBody = WEATHER_BODY) =>
  fakeFetch([
    { match: '/v1/search', body: geoBody },
    { match: '/v1/forecast', body: weatherBody },
  ]);

describe('getCurrentWeather', () => {
  test('геокодер нашёл город: погода собрана из ответа', async () => {
    resetCache();
    const { fetchImpl, calls } = setup();
    const res = await getCurrentWeather('Санкт-Петербург', { fetch: fetchImpl, now });
    assert.deepEqual(res, {
      ok: true,
      city: 'Санкт-Петербург',
      name: 'Санкт-Петербург',
      temp: 12.4,
      apparent: 10.1,
      precipitation: 0.3,
    });
    assert.equal(typeof res.temp, 'number');
    // Два запроса: сначала геокодер, потом погода.
    assert.equal(calls.length, 2);
    assert.equal(calls[1].opts.signal instanceof AbortSignal, true);
  });

  test('геокодер вернул пустой список → город не найден, до погоды дело не дошло', async () => {
    resetCache();
    const { fetchImpl, calls } = setup({ results: [] });
    const res = await getCurrentWeather('Атлантида', { fetch: fetchImpl, now });
    assert.deepEqual(res, { ok: false, reason: 'not_found', message: 'Город не найден' });
    assert.equal(calls.length, 1);
  });

  test('fetch бросил ошибку → нет связи с погодой', async () => {
    resetCache();
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      throw new Error('ECONNRESET');
    };
    const res = await getCurrentWeather('Москва', { fetch: fetchImpl, now });
    assert.deepEqual(res, { ok: false, reason: 'network', message: 'Нет связи с погодой' });
    assert.equal(n, 1);
  });

  test('кэш: повторный вызов без сети; resetCache и просрочка на 31 минуту снова ходят в сеть', async () => {
    resetCache();
    let t = T0;
    const { fetchImpl, calls } = setup();
    const opts = { fetch: fetchImpl, now: () => t };
    // Один свежий ход — это два запроса (геокодер и погода), поэтому сеть считаем по адресам.
    const searchCount = () => calls.filter((c) => c.url.includes('/v1/search')).length;
    const forecastCount = () => calls.filter((c) => c.url.includes('/v1/forecast')).length;

    const first = await getCurrentWeather('Казань', opts);
    // Тот же город в другом регистре — тот же ключ кэша.
    const again = await getCurrentWeather('казань', opts);
    t = T0 + 29 * 60 * 1000; // ещё в окне кэша
    const fresh = await getCurrentWeather('Казань', opts);
    assert.equal(searchCount(), 1);
    assert.equal(forecastCount(), 1);
    assert.equal(again.ok, true);
    assert.equal(fresh.temp, first.temp);

    resetCache(); // для тестов
    t = T0;
    await getCurrentWeather('Казань', opts);
    assert.equal(searchCount(), 2);

    t = T0 + 31 * 60 * 1000; // кэш протух
    await getCurrentWeather('Казань', opts);
    assert.equal(searchCount(), 3);
  });

  test('город кодируется в адресе: percent-кодирование, count=1&language=ru, без сырого пробела', async () => {
    resetCache();
    const { fetchImpl, calls } = setup();
    await getCurrentWeather('Санкт-Петербург', { fetch: fetchImpl, now });
    await getCurrentWeather('Нижний Новгород', { fetch: fetchImpl, now });

    // Оба адреса в точности как в задаче, лишних данных в URL нет.
    assert.equal(calls[0].url, `${GEO_URL}?name=${encodeURIComponent('Санкт-Петербург')}&count=1&language=ru`);
    assert.equal(
      calls[1].url,
      `${WEATHER_URL}?latitude=59.93863&longitude=30.31413&current_weather=true&current=temperature_2m,apparent_temperature,precipitation`,
    );
    assert.equal(calls[0].url.includes(' '), false);
    // Город с пробелом уходит как %20, не сырым пробелом.
    assert.equal(calls[2].url, `${GEO_URL}?name=${encodeURIComponent('Нижний Новгород')}&count=1&language=ru`);
    assert.equal(calls[2].url.includes('%20'), true);
    assert.equal(calls[2].url.includes(' '), false);
  });

  test('погода без temperature (и с температурой-строкой) → неполные данные', async () => {
    resetCache();
    const { fetchImpl } = setup(GEO_BODY, { current_weather: {}, current: WEATHER_BODY.current });
    const res = await getCurrentWeather('Москва', { fetch: fetchImpl, now });
    assert.deepEqual(res, { ok: false, reason: 'bad_data', message: 'Погода пришла неполной' });

    resetCache();
    const second = setup(GEO_BODY, { current_weather: { temperature: '12' } });
    const res2 = await getCurrentWeather('Москва', { fetch: second.fetchImpl, now });
    assert.equal(res2.reason, 'bad_data');
  });

  test('зависший запрос обрывается по таймауту → сеть, тест быстрый', async () => {
    resetCache();
    // Подменный fetch висит, пока не придёт abort.
    const fetchImpl = (url, opts = {}) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const started = Date.now();
    const res = await getCurrentWeather('Москва', { fetch: fetchImpl, timeoutMs: 50, now });
    assert.deepEqual(res, { ok: false, reason: 'network', message: 'Нет связи с погодой' });
    assert.ok(Date.now() - started < 2000, 'тест не должен ждать дольше таймаута');
  });

  test('нет блока current → null вместо ощущаемой температуры и осадков', async () => {
    resetCache();
    const { fetchImpl } = setup(GEO_BODY, { current_weather: { temperature: 5 } });
    const res = await getCurrentWeather('Сочи', { fetch: fetchImpl, now });
    assert.deepEqual(res, {
      ok: true,
      city: 'Сочи',
      name: 'Санкт-Петербург',
      temp: 5,
      apparent: null,
      precipitation: null,
    });
  });

  test('у результата геокодера нет имени → исходная строка как name', async () => {
    resetCache();
    const { fetchImpl } = setup({ results: [{ latitude: 55.75, longitude: 37.62 }] });
    const res = await getCurrentWeather('Тверь', { fetch: fetchImpl, now });
    assert.equal(res.ok, true);
    assert.equal(res.name, 'Тверь');
    assert.equal(res.city, 'Тверь');
  });

  test('пустой или пробельный город → не найден, без вызова сети', async () => {
    resetCache();
    const { fetchImpl, calls } = setup();
    for (const city of ['', '   ', undefined, null]) {
      const res = await getCurrentWeather(city, { fetch: fetchImpl, now });
      assert.deepEqual(res, { ok: false, reason: 'not_found', message: 'Город не найден' });
    }
    assert.equal(calls.length, 0);
  });
});
