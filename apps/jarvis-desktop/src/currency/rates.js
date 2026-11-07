'use strict';

// Курс валют ЦБ РФ. Источник — cbr-xml-daily.ru: открытый JSON, без ключей и регистрации.
// Это чтение (T0) и всегда быстрее, чем открывать браузер и читать страницы моделью.
// Ответ кэшируется на 15 минут в памяти процесса: курс ЦБ меняется раз в день.
const RATES_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
const CACHE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 8000;

// Какие валюты понимаем и как они называются по-русски. Код — ISO 4217.
const CURRENCIES = Object.freeze({
  USD: 'доллар',
  EUR: 'евро',
  CNY: 'юань',
  GBP: 'фунт',
  JPY: 'иена',
  CHF: 'франк',
  TRY: 'лира',
  KZT: 'тенге',
  BYN: 'белорусский рубль',
  UAH: 'гривна',
});
const CODES = Object.freeze(Object.keys(CURRENCIES));
const MAX_CODES = 5;

// Слова, которыми владелец называет валюту в просьбе.
const WORDS = [
  { code: 'USD', re: /доллар|бакс|\busd\b|\$|дол\.?\s*сша/iu },
  { code: 'EUR', re: /евро|\beur\b|€/iu },
  { code: 'CNY', re: /юан|женьмин|\bcny\b|rmb/iu },
  { code: 'GBP', re: /фунт|\bgbp\b|стерлинг/iu },
  { code: 'JPY', re: /иен|йен|\bjpy\b/iu },
  { code: 'CHF', re: /франк|\bchf\b/iu },
  { code: 'TRY', re: /лир[аыу]?\b|\btry\b/iu },
  { code: 'KZT', re: /тенге|\bkzt\b/iu },
  { code: 'BYN', re: /белорусск\S*\s+рубл|\bbyn\b/iu },
  { code: 'UAH', re: /гривн|\buah\b/iu },
];

// Кэш в памяти модуля: один и тот же ответ ЦБ на все запросы. Время считает now().
const cache = new Map();

// Очистка кэша (для тестов).
function resetCache() {
  cache.clear();
}

// Число из ответа: строка с запятой тоже годится, NaN и бесконечность — нет.
function num(value) {
  const parsed = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Просьба про курс: какие валюты называет владелец. null — это не просьба про курс.
// Понимает «курс доллара», «сколько стоит евро», «открой курс доллара и юаня».
// Просьбы вроде «купи доллары» сюда не попадают: там нет слова про курс, и это уже действие.
function parseCurrencyRequest(text) {
  const phrase = String(text ?? '').trim();
  if (!phrase || phrase.length > 120) return null;
  const asksRate = /курс|сколько\s+(?:стоит|стоят)|котиров/iu.test(phrase);
  if (!asksRate) return null;
  const found = [];
  for (const { code, re } of WORDS) {
    if (re.test(phrase) && !found.includes(code)) found.push(code);
  }
  return found.length ? found.slice(0, MAX_CODES) : null;
}

// Проверка кода валюты: только известные ISO-коды из списка, верхним регистром.
// Неизвестный код отклоняем целиком, а не молча подменяем долларом.
function normalizeCodes(codes) {
  if (!Array.isArray(codes) || !codes.length) return null;
  const out = [];
  for (const raw of codes.slice(0, MAX_CODES)) {
    const code = String(raw ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || !CODES.includes(code)) return null;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

// Запрос JSON с таймаутом: AbortController гасит зависший запрос, чтобы курс не держал ход.
async function requestJson(url, { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
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

// Курсы на дату ЦБ. Ничего не бросает: любая беда — {ok:false, reason, message}.
// opts для тестов: { fetch, timeoutMs, now }.
async function getRates(codes, opts = {}) {
  const wanted = normalizeCodes(codes) || ['USD'];
  const { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, now = Date.now } = opts;

  const key = wanted.join(',');
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return { ...hit.value };

  let data;
  try {
    data = await requestJson(RATES_URL, { fetch, timeoutMs });
  } catch {
    // Один повтор: первый запрос после запуска бывает холодным (DNS и TLS), и это не повод сдаваться.
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      data = await requestJson(RATES_URL, { fetch, timeoutMs });
    } catch {
      return { ok: false, reason: 'network', message: 'Нет связи с курсами ЦБ, попробуйте позже' };
    }
  }
  const valute = data && data.Valute && typeof data.Valute === 'object' ? data.Valute : null;
  if (!valute) return { ok: false, reason: 'bad_data', message: 'Курсы пришли неполными' };

  const rates = [];
  for (const code of wanted) {
    const item = valute[code];
    const nominal = num(item && item.Nominal) || 1;
    const value = num(item && item.Value);
    if (!item || value === null) continue;
    const previous = num(item.Previous);
    rates.push({
      code,
      name: CURRENCIES[code] || code,
      nominal,
      value: value / nominal,
      previous: previous === null ? null : previous / nominal,
      // ЦБ уже дал дату, за которую курс: без неё ответ был бы «сегодняшним» на глаз.
      date: typeof data.Date === 'string' ? data.Date : null,
    });
  }
  if (!rates.length) return { ok: false, reason: 'unknown', message: 'ЦБ не публикует курс этой валюты' };

  const value = { ok: true, date: typeof data.Date === 'string' ? data.Date : null, rates };
  cache.set(key, { expiresAt: now() + CACHE_MS, value });
  return { ...value };
}

// Курс одной валюты числом (для быстрых ответов и проверок).
function rubText(value) {
  return Number(value).toFixed(2).replace('.', ',');
}

function changeText(rate) {
  if (!rate || rate.previous === null || typeof rate.previous !== 'number') return '';
  const diff = rate.value - rate.previous;
  if (Math.abs(diff) < 0.005) return ' (без изменений)';
  return ` (${diff > 0 ? '+' : '−'}${rubText(Math.abs(diff))} за день)`;
}

// Человеческий текст курса: «Курс ЦБ на 06.11.2026: доллар 81,79 ₽ (+0,12 за день), евро 92,16 ₽».
function ratesText(result) {
  if (!result || !result.ok) return (result && result.message) || 'Курс не удалось узнать';
  const date = result.date ? new Date(result.date) : null;
  const day = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('ru-RU') : '';
  const parts = result.rates.map((rate) => `${rate.name} ${rubText(rate.value)} ₽${changeText(rate)}`);
  return `Курс ЦБ${day ? ` на ${day}` : ''}: ${parts.join(', ')}`;
}

module.exports = { getRates, parseCurrencyRequest, ratesText, normalizeCodes, resetCache, CURRENCIES, CODES, RATES_URL, CACHE_MS, MAX_CODES };
