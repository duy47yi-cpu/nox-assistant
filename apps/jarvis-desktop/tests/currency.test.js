'use strict';

// Курс валют: разбор просьбы, запрос к ЦБ с подменным fetch, кэш и честные ошибки.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getRates, parseCurrencyRequest, ratesText, normalizeCodes, resetCache } = require('../src/currency/rates');
const { currencyTools } = require('../src/tools/currency');

const CBR = {
  Date: '2026-11-05T11:30:00+03:00',
  Valute: {
    USD: { Nominal: 1, Name: 'Доллар США', Value: 81.2345, Previous: 81.0 },
    EUR: { Nominal: 1, Name: 'Евро', Value: 94.1, Previous: 94.4 },
    JPY: { Nominal: 100, Name: 'Японских иен', Value: 52.3, Previous: 52.0 },
  },
};

function fakeFetch(body, { calls = [] } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
  };
}

test('просьба про курс: валюты из слов владельца, действия не перехватываются', () => {
  assert.deepEqual(parseCurrencyRequest('какой курс доллара'), ['USD']);
  assert.deepEqual(parseCurrencyRequest('открой курс доллара и юаня'), ['USD', 'CNY']);
  assert.deepEqual(parseCurrencyRequest('сколько стоит евро'), ['EUR']);
  assert.deepEqual(parseCurrencyRequest('Курс USD'), ['USD']);
  assert.equal(parseCurrencyRequest('купи доллары'), null, 'это уже действие, а не справка');
  assert.equal(parseCurrencyRequest('курс по математике'), null);
  assert.equal(parseCurrencyRequest('привет'), null);
  assert.equal(parseCurrencyRequest(''), null);
});

test('коды валют: только ISO из известных, не больше пяти', () => {
  assert.deepEqual(normalizeCodes(['usd', 'EUR', 'USD']), ['USD', 'EUR']);
  assert.equal(normalizeCodes(['RUB']), null);
  assert.equal(normalizeCodes(['US']), null);
  assert.equal(normalizeCodes([]), null);
  assert.deepEqual(normalizeCodes(['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'CHF']).length, 5);
});

test('курс ЦБ: значения, номинал и предыдущий курс', async () => {
  resetCache();
  const res = await getRates(['USD', 'JPY'], { fetch: fakeFetch(CBR) });
  assert.equal(res.ok, true);
  assert.equal(res.date, CBR.Date);
  const usd = res.rates.find((r) => r.code === 'USD');
  assert.equal(usd.value, 81.2345);
  assert.equal(usd.previous, 81);
  const jpy = res.rates.find((r) => r.code === 'JPY');
  assert.ok(Math.abs(jpy.value - 0.523) < 1e-9, 'номинал 100 пересчитан на одну иену');
  assert.match(ratesText(res), /Курс ЦБ на 05\.11\.2026/);
  assert.match(ratesText(res), /доллар 81,23 ₽/);
  assert.match(ratesText(res), /\(\+0,23 за день\)/);
  assert.doesNotMatch(ratesText(res), /евро/, 'евро не запрашивали — его в тексте быть не должно');
});

test('курс кэшируется: повторный запрос не идёт в сеть', async () => {
  resetCache();
  const calls = [];
  const fetch = fakeFetch(CBR, { calls });
  await getRates(['USD'], { fetch });
  await getRates(['USD'], { fetch });
  assert.equal(calls.length, 1);
});

test('сеть, плохие данные и неизвестная валюта — честные отказы', async () => {
  resetCache();
  const network = await getRates(['USD'], { fetch: async () => { throw new Error('нет сети'); } });
  assert.equal(network.ok, false);
  assert.equal(network.reason, 'network');
  const bad = await getRates(['USD'], { fetch: fakeFetch({ Date: CBR.Date }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_data');
  const unknown = await getRates(['CHF'], { fetch: fakeFetch(CBR) });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown');
});

test('таймаут запроса: зависший сервис не держит ход', async () => {
  resetCache();
  const hangs = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const started = Date.now();
  const res = await getRates(['USD'], { fetch: hangs, timeoutMs: 30 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'network');
  assert.ok(Date.now() - started < 500);
});

test('инструмент currency_rate: T0, подтверждение числом, понятные отказы', async () => {
  const fake = async (codes) => (codes.includes('RUB')
    ? { ok: false, message: 'ЦБ не публикует курс этой валюты', reason: 'unknown' }
    : { ok: true, date: CBR.Date, rates: [{ code: 'USD', name: 'доллар', nominal: 1, value: 81.23, previous: 81, date: CBR.Date }] });
  const [tool] = currencyTools({ rates: fake });
  assert.equal(tool.name, 'currency_rate');
  assert.equal(tool.risk, 'T0');
  const bad = await tool.run({ codes: ['RUB'] });
  assert.equal(bad.ok, false);
  const good = await tool.run({ codes: ['USD'] });
  assert.equal(good.ok, true);
  assert.match(good.summary, /курс/i);
  const verdict = await tool.verify({}, good);
  assert.equal(verdict.status, 'confirmed');
  const unknown = await tool.verify({}, { data: { rates: [] } });
  assert.equal(unknown.status, 'unknown');
});
