'use strict';

// Погода через open-meteo.com — единственный сервис, разрешённый владельцем: без ключей и регистрации.
// Два шага: геокодер превращает название города в координаты, прогноз отдаёт по ним текущую погоду.
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
// Добавка current= нужна ради ощущаемой температуры и осадков: в current_weather их нет.
const WEATHER_FIELDS = 'temperature_2m,apparent_temperature,precipitation';
const CACHE_MS = 30 * 60 * 1000; // полчаса

// Кэш в памяти модуля: город в нижнем регистре → ответ. Живёт полчаса, время считает now().
const cache = new Map();

// Очистка кэша (для тестов).
function resetCache() {
  cache.clear();
}

// Настоящее число: NaN и бесконечность погодой не считаем.
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Один запрос с таймаутом: AbortController гасит зависший запрос. Любая беда транспорта —
// обрыв, таймаут, плохой статус, нечитаемый ответ — наружу как ошибка сети.
async function requestJson(url, { fetch = globalThis.fetch, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error('сервис ответил ошибкой');
    return JSON.parse(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

// Текущая погода в городе. Ничего не бросает: любая беда — объект с ok:false.
// opts подменяемые для тестов: { fetch, timeoutMs = 5000, now = Date.now }.
async function getCurrentWeather(city, opts = {}) {
  const { fetch = globalThis.fetch, timeoutMs = 5000, now = Date.now } = opts;
  const query = String(city || '').trim();
  if (!query) return { ok: false, reason: 'not_found', message: 'Город не найден' };

  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return { ...hit.value, city };

  let geo;
  try {
    geo = await requestJson(`${GEO_URL}?name=${encodeURIComponent(query)}&count=1&language=ru`, { fetch, timeoutMs });
  } catch {
    return { ok: false, reason: 'network', message: 'Нет связи с погодой' };
  }
  // Первый результат — самое близкое совпадение. Без координат город считаем не найденным.
  const place = geo && Array.isArray(geo.results) ? geo.results[0] : null;
  if (!place || !isNum(place.latitude) || !isNum(place.longitude)) {
    return { ok: false, reason: 'not_found', message: 'Город не найден' };
  }

  let data;
  try {
    data = await requestJson(
      `${WEATHER_URL}?latitude=${place.latitude}&longitude=${place.longitude}&current_weather=true&current=${WEATHER_FIELDS}`,
      { fetch, timeoutMs },
    );
  } catch {
    return { ok: false, reason: 'network', message: 'Нет связи с погодой' };
  }

  const temp = data && data.current_weather ? data.current_weather.temperature : undefined;
  if (!isNum(temp)) return { ok: false, reason: 'bad_data', message: 'Погода пришла неполной' };
  const current = data.current || {};
  const value = {
    ok: true,
    city,
    name: typeof place.name === 'string' && place.name.trim() ? place.name : query,
    temp,
    apparent: isNum(current.apparent_temperature) ? current.apparent_temperature : null,
    precipitation: isNum(current.precipitation) ? current.precipitation : null,
  };
  // В кэш кладём только удачные ответы: «не найден» и ошибку сети запоминать нечего.
  cache.set(key, { expiresAt: now() + CACHE_MS, value });
  return { ...value };
}

module.exports = { getCurrentWeather, resetCache };
