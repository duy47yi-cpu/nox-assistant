'use strict';

// Проверка вызова инструментов на настоящем DeepSeek.
// Даём только одно безопасное чтение (windows_list), ничего не меняем.
// Запуск: npm run check-tools (из папки apps/jarvis-desktop).
// Ключ не выводится.

const path = require('path');
const { makeConfig } = require('../src/config/env');
const { DeepSeekClient } = require('../src/brain/deepseek');
const { ToolRegistry } = require('../src/tools/registry');
const { windowsTools } = require('../src/tools/windows');
const { Agent } = require('../src/agent/loop');
const { ApprovalBroker } = require('../src/policy/approvals');
const { Journal } = require('../src/journal/journal');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const cfg = makeConfig(ROOT);

const DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1/openai';
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';

async function main() {
  const apiKey = cfg('NOX_BRAIN_KEY');
  if (!apiKey) {
    console.log('ключ не задан: добавь NOX_BRAIN_KEY в .env');
    process.exit(1);
  }
  const brain = new DeepSeekClient({
    baseUrl: cfg('NOX_BRAIN_URL') || DEFAULT_BASE_URL,
    apiKey,
    model: cfg('NOX_BRAIN_MODEL') || DEFAULT_MODEL,
    timeoutMs: 90000,
  });

  const tools = new ToolRegistry();
  for (const tool of windowsTools().filter((t) => t.name === 'windows_list')) tools.register(tool);

  const called = [];
  const events = [];
  const agent = new Agent({
    brain,
    tools,
    approvals: new ApprovalBroker({ timeoutMs: 5000 }),
    journal: new Journal(path.join(os.tmpdir(), 'jarvis-check-tools.jsonl')),
    emit: (e) => {
      events.push(e);
      if (e.type === 'tool_start') called.push(e.name);
    },
    mode: 'full',
    workspace: os.tmpdir(),
    systemPrompt: 'Ты помощник. Если просят список окон, вызови инструмент windows_list.',
  });

  await agent.run('Какие окна сейчас открыты на компьютере? Используй инструмент.');

  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  const errors = events.filter((e) => e.type === 'error').map((e) => e.message);
  console.log(`вызовы инструментов: ${called.length ? called.join(', ') : 'нет'}`);
  console.log(`ответ: ${text || '(пусто)'}`);
  if (errors.length) {
    console.log(`ошибки: ${errors.join('; ')}`);
    process.exit(2);
  }
  console.log(called.includes('windows_list') ? 'проверка прошла' : 'инструмент не вызван: проверь промпт или модель');
}

main();
