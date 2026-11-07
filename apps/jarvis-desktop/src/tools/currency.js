'use strict';

// currency_rate: курс валют ЦБ РФ — быстро и без браузера. Только чтение (T0).
// Владелец вправе спросить «курс доллара»; это не повод открывать сайт и читать страницы моделью.
const { getRates, ratesText, normalizeCodes, CODES, MAX_CODES } = require('../currency/rates');

function currencyTools({ rates = getRates } = {}) {
  const readRates = typeof rates === 'function' ? rates : getRates;
  const currencyRate = {
    name: 'currency_rate',
    description: 'Курс валют ЦБ РФ к рублю (доллар, евро, юань и другие). Один быстрый запрос без браузера. Для «какой курс доллара», «сколько стоит евро» — этот инструмент, а не поиск в интернете.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        codes: {
          type: 'array',
          maxItems: MAX_CODES,
          items: { type: 'string', enum: CODES },
          description: 'коды валют, например ["USD", "EUR"]; без них — доллар',
        },
      },
    },
    async run(args = {}) {
      try {
        const codes = args && args.codes !== undefined ? normalizeCodes(args.codes) : ['USD'];
        if (codes === null) return { ok: false, summary: 'нужны коды валют из списка, например USD и EUR', data: {} };
        const res = await readRates(codes);
        if (!res || !res.ok) {
          return { ok: false, summary: (res && res.message) || 'Курс не удалось узнать', data: { reason: (res && res.reason) || 'bad_data' } };
        }
        return {
          ok: true,
          summary: ratesText(res),
          data: { date: res.date, rates: res.rates },
        };
      } catch {
        return { ok: false, summary: 'Курс не удалось узнать', data: { reason: 'bad_data' } };
      }
    },
    // Курс пришёл от ЦБ: подтверждение — число и дата в ответе, а не обещание модели.
    async verify(args, result) {
      const rates = result && result.data && Array.isArray(result.data.rates) ? result.data.rates : [];
      const good = rates.length > 0 && rates.every((rate) => rate && typeof rate.value === 'number' && rate.value > 0);
      return good
        ? { status: 'confirmed', evidence: 'ЦБ вернул курс числом' }
        : { status: 'unknown', evidence: 'курс подтвердить нечем' };
    },
  };
  return [currencyRate];
}

module.exports = { currencyTools };
