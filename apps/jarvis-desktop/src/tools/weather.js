'use strict';

// weather_now: текущая погода по open-meteo.com, без ключей. Только чтение (T0):
// сетевой запрос и ничего больше. Город — из аргумента или из настроек через
// getCity (его передаёт вызывающий код). Любая ошибка возвращается как
// {ok: false, summary}; наружу исключения не выходят.

const MAX_CITY = 100;

function weatherTools({ getCity } = {}) {
  const weatherNow = {
    name: 'weather_now',
    description: 'Текущая погода в городе по open-meteo: температура, ощущается как, осадки. Город можно передать аргументом, иначе он берётся из настроек.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', maxLength: MAX_CITY },
      },
    },
    async run(args = {}) {
      try {
        // Модуль погоды требуем внутри run: если его нет, ломается только этот вызов,
        // а не загрузка всех инструментов.
        const { getCurrentWeather } = require('../weather/open-meteo');
        const fromSettings = typeof getCity === 'function' ? getCity() : '';
        const city = String((args && args.city) || fromSettings || '').trim();
        if (!city) return { ok: false, summary: 'Скажите город', data: {} };
        if (city.length > MAX_CITY) return { ok: false, summary: `город длиннее ${MAX_CITY} символов`, data: {} };

        const res = await getCurrentWeather(city);
        if (!res || !res.ok) {
          const reason = (res && res.reason) || 'bad_data';
          const summary = reason === 'network'
            ? 'Нет связи с погодой, попробуйте позже'
            : String((res && res.message) || 'Не удалось узнать погоду');
          return { ok: false, summary, data: { reason } };
        }

        const name = res.name || res.city || city;
        let summary = `${name}: ${Math.round(res.temp)}°`;
        if (typeof res.apparent === 'number') summary += `, ощущается ${Math.round(res.apparent)}°`;
        if (typeof res.precipitation === 'number') summary += `, осадки ${Number(res.precipitation).toFixed(1)} мм`;
        return {
          ok: true,
          summary,
          data: {
            city: res.city,
            name: res.name,
            temp: res.temp,
            apparent: res.apparent,
            precipitation: res.precipitation,
          },
        };
      } catch {
        return { ok: false, summary: 'Не удалось узнать погоду', data: { reason: 'bad_data' } };
      }
    },
    // Погода приходит свежим ответом от open-meteo: подтвердить можно тем, что температура — число.
    async verify(args, result) {
      if (result && result.ok && typeof result.data.temp === 'number') {
        return { status: 'confirmed', evidence: 'open-meteo вернул температуру' };
      }
      return { status: 'unknown', evidence: 'температуру подтвердить нечем' };
    },
  };
  return [weatherNow];
}

module.exports = { weatherTools };
