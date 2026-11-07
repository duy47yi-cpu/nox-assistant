'use strict';

// «Что повисло» для модели и разбор дела. refresh() сверяет дела с источниками перед ответом.
const crypto = require('crypto');
const { hanging, hangingText } = require('../deals/deals');

const MAX_PROMISE = 300;

function dealTools(store, refresh = () => {}) {
  const dealsHanging = {
    name: 'deals_hanging',
    description: 'Что повисло: ждёт владельца, не получилось, срок прошёл, застряло, не проверено. В данных есть ref для deal_clear.',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run() {
      refresh();
      const groups = hanging(store);
      const refs = Object.values(groups).flat().map((d) => ({ ref: d.ref, title: d.title, state: d.state }));
      return { ok: true, summary: hangingText(groups), data: { items: refs } };
    },
  };

  const dealClear = {
    name: 'deal_clear',
    description: 'Убрать дело из «что повисло», когда владелец сказал, что разобрался. Сама задача или напоминание не меняются.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['ref'],
    },
    async run(args = {}) {
      const deal = store.clear(String(args.ref || ''));
      return deal
        ? { ok: true, summary: `убрал из списка: ${deal.title}`, data: { ref: deal.ref } }
        : { ok: false, summary: 'такого дела нет', data: {} };
    },
    async verify(args, result) {
      const deal = store.get(result.data.ref);
      return deal && deal.cleared
        ? { status: 'confirmed', evidence: 'дело помечено разобранным' }
        : { status: 'failed', evidence: 'дело не помечено' };
    },
  };

  // Обещание владельцу: дело без источника, поэтому сверка его не закрывает. Снимается через deal_clear.
  const dealAdd = {
    name: 'deal_add',
    description: 'Записать обещание владельцу, которое не должно повиснуть: текст и необязательный срок (дата или дата со временем, например 2026-11-05T18:00). Когда срок пройдёт без снятия, оно попадёт в «что повисло». Снимается через deal_clear.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: MAX_PROMISE },
        due: { type: 'string', maxLength: 40 },
      },
      required: ['text'],
    },
    async run(args = {}) {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, summary: 'пустой текст обещания', data: {} };
      if (text.length > MAX_PROMISE) return { ok: false, summary: `текст длиннее ${MAX_PROMISE} символов`, data: {} };
      let due = null;
      if (args.due !== undefined && args.due !== null && String(args.due).trim() !== '') {
        const ms = Date.parse(String(args.due).trim());
        if (Number.isNaN(ms)) return { ok: false, summary: 'срок: дата или дата со временем, например 2026-11-05T18:00', data: {} };
        due = new Date(ms).toISOString();
      }
      const ref = `promise:${crypto.randomUUID().slice(0, 8)}`;
      store.upsert({ ref, title: text, source: 'promise', state: 'promised', due });
      return {
        ok: true,
        summary: `записал обещание: ${text}${due ? ` (срок ${due})` : ''}`,
        data: { ref, title: text, due },
      };
    },
    // Читаем запись обратно: дело есть, открыто, с тем же текстом и сроком.
    async verify(args, result) {
      const deal = store.get(result.data.ref);
      if (!deal || deal.cleared) return { status: 'failed', evidence: 'обещание не записано' };
      if (deal.title !== result.data.title || (deal.due || null) !== result.data.due) return { status: 'failed', evidence: 'в записи другой текст или срок' };
      return { status: 'confirmed', evidence: 'обещание записано и открыто' };
    },
  };

  return [dealsHanging, dealClear, dealAdd];
}

module.exports = { dealTools };
