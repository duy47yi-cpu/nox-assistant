'use strict';

// Диагностика мозга: короткий запрос к DeepSeek с замером времени.
// Запуск: npm run check-brain (из папки apps/jarvis-desktop).
//   npm run check-brain -- --compare   — по 3 запроса с размышлениями и без (NOX_BRAIN_REASONING=off), сравнение времени.
// Ключ не выводится ни полностью, ни частично.

const path = require('path');
const { makeConfig } = require('../src/config/env');
const { DeepSeekClient } = require('../src/brain/deepseek');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const cfg = makeConfig(ROOT);

const DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1/openai';
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const RUNS = 3;

// Один инструмент в запросе, чтобы условия были похожи на настоящий ход.
const URL_TOOL = {
  type: 'function',
  function: {
    name: 'url_open',
    description: 'Открыть ссылку или сайт (http/https) в браузере по умолчанию.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
};

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
}

async function measure(client, label, runs) {
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const res = await client.chat({
      messages: [{ role: 'user', content: 'Ответь одним словом: готов.' }],
      tools: [URL_TOOL],
    });
    const s = res.stats || {};
    times.push(s.ms);
    console.log(
      `[${label}] ${s.ms} мс; ответ: ${(res.content || '(пусто)').trim().slice(0, 40)}; `
      + `размышления: ${s.reasoningChars} симв.${s.reasoningTokens != null ? ` / ${s.reasoningTokens} ток.` : ''}; `
      + `токены: вход ${s.promptTokens ?? '?'}, выход ${s.completionTokens ?? '?'}; режим: ${s.reasoning}`,
    );
  }
  return median(times);
}

async function main() {
  const apiKey = cfg('NOX_BRAIN_KEY');
  const baseUrl = cfg('NOX_BRAIN_URL') || DEFAULT_BASE_URL;
  const model = cfg('NOX_BRAIN_MODEL') || DEFAULT_MODEL;
  const reasoning = cfg('NOX_BRAIN_REASONING');
  const compare = process.argv.includes('--compare');

  console.log(`ключ: ${apiKey ? 'задан' : 'НЕ ЗАДАН (добавь NOX_BRAIN_KEY в .env)'}`);
  console.log(`адрес: ${baseUrl}`);
  console.log(`модель: ${model}`);
  console.log(`NOX_BRAIN_REASONING: ${reasoning || '(не задано: размышления как у провайдера по умолчанию)'}`);
  if (/opencode/i.test(baseUrl)) {
    console.log('внимание: адрес похож на OpenCode. Для DeepInfra нужен https://api.deepinfra.com/v1/openai');
  }
  if (!apiKey) process.exit(1);

  try {
    if (compare) {
      const on = await measure(new DeepSeekClient({ baseUrl, apiKey, model, timeoutMs: 60000 }), 'по умолчанию', RUNS);
      const off = await measure(new DeepSeekClient({ baseUrl, apiKey, model, timeoutMs: 60000, reasoning: 'off' }), 'off', RUNS);
      console.log(`медиана: по умолчанию ${on} мс, off ${off} мс`);
      console.log('Если в строках off режим «off-rejected», провайдер не принял отключение размышлений.');
      console.log('Если у off размышлений 0 симв. и время меньше — можно ставить NOX_BRAIN_REASONING=off в .env.');
    } else {
      await measure(new DeepSeekClient({ baseUrl, apiKey, model, timeoutMs: 60000, reasoning }), 'проверка', 1);
    }
    console.log('проверка прошла');
  } catch (err) {
    // У сетевых ошибок fetch код лежит в err.cause, например ECONNREFUSED или ENOTFOUND.
    const cause = err.cause && err.cause.code ? ` (${err.cause.code})` : '';
    console.log(`ошибка [${err.code || 'network'}]: ${err.message}${cause}`);
    process.exit(2);
  }
}

main();
