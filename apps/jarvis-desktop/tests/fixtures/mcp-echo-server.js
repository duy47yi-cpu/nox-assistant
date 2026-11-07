#!/usr/bin/env node
'use strict';

// Тестовый MCP-сервер для локальной проверки подключений Nox.
// Официальный протокол MCP поверх stdio: JSON-RPC 2.0, по одному сообщению на строку.
// Пакеты не нужны: только встроенный readline. Сервер ничего не читает с диска и не ходит в сеть.
//
// Инструменты (специально разные, чтобы проверить и успех, и сбой):
//   echo   — возвращает текст обратно;
//   add    — складывает два числа (structuredContent);
//   slow   — отвечает через ms миллисекунд (проверка тайм-аута);
//   crash  — завершает процесс (проверка изоляции сбоя: остальные серверы и окно живы);
//   secret — возвращает ошибку с секретом из env (проверка маскировки).
//
// Режим сбоя при запуске: env MCP_FIXTURE_FAIL=stderr-secret → пишет секрет в stderr и выходит с кодом 3.
const readline = require('readline');

const PROTOCOL = '2025-06-18';

if (process.env.MCP_FIXTURE_FAIL === 'stderr-secret') {
  process.stderr.write(`тестовый сервер не поднялся: ${process.env.MCP_TEST_SECRET || 'секрет'}\n`);
  process.exit(3);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const ECHO = {
  name: 'echo',
  title: 'Повтор',
  description: 'Возвращает присланный текст обратно. Ничего не меняет.',
  inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Текст' } }, required: ['text'] },
};
const ADD = {
  name: 'add',
  title: 'Сложить',
  description: 'Складывает два числа.',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
};
const SLOW = {
  name: 'slow',
  title: 'Медленный ответ',
  description: 'Отвечает через заданное время: проверка тайм-аута.',
  inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
};
const CRASH = {
  name: 'crash',
  title: 'Сломать сервер',
  description: 'Завершает тестовый сервер. Проверка изоляции сбоя.',
  inputSchema: { type: 'object', properties: {} },
};
const SECRET = {
  name: 'secret',
  title: 'Секрет в ошибке',
  description: 'Возвращает ошибку с секретом из env: проверка маскировки.',
  inputSchema: { type: 'object', properties: {} },
};

const FIRST_PAGE = [ECHO];
const SECOND_PAGE = [ADD, SLOW, CRASH, SECRET];

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function callTool(id, name, args) {
  const toolArgs = args && typeof args === 'object' ? args : {};
  if (name === 'echo') {
    if (typeof toolArgs.text !== 'string') return error(id, -32602, 'нужен текст');
    return result(id, { content: [{ type: 'text', text: `эхо: ${toolArgs.text}` }] });
  }
  if (name === 'add') {
    const a = Number(toolArgs.a);
    const b = Number(toolArgs.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return error(id, -32602, 'нужны два числа');
    return result(id, { content: [{ type: 'text', text: String(a + b) }], structuredContent: { sum: a + b } });
  }
  if (name === 'slow') {
    const ms = Number.isFinite(Number(toolArgs.ms)) ? Math.max(0, Number(toolArgs.ms)) : 1000;
    setTimeout(() => result(id, { content: [{ type: 'text', text: `ответ через ${ms} мс` }] }), ms);
    return undefined;
  }
  if (name === 'crash') {
    // Нарочный сбой: ответа не будет, окно и другие серверы должны пережить это.
    process.exit(17);
  }
  if (name === 'secret') {
    return result(id, { isError: true, content: [{ type: 'text', text: `не удалось: ${process.env.MCP_TEST_SECRET || 'секрет'}` }] });
  }
  return error(id, -32602, `неизвестный инструмент: ${name}`);
}

function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  // Уведомления (без id) не требуют ответа.
  if (method === 'notifications/initialized') return;
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL,
      capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
      serverInfo: { name: 'echo-fixture', version: '1.0.0' },
      instructions: 'Тестовый MCP-сервер Nox: ничего не меняет на компьютере.',
    });
  }
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') {
    const cursor = params && params.cursor;
    if (!cursor) return result(id, { tools: FIRST_PAGE, nextCursor: 'page-2' });
    if (cursor === 'page-2') return result(id, { tools: SECOND_PAGE });
    return result(id, { tools: [] });
  }
  if (method === 'tools/call') {
    return callTool(id, params && params.name, params && params.arguments);
  }
  if (method === 'resources/list' || method === 'prompts/list') {
    // Возможность объявлена, но не реализована: клиент должен честно получить ошибку метода.
    return error(id, -32601, `метод не поддерживается: ${method}`);
  }
  return error(id, -32601, `метод не поддерживается: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return; // посторонняя строка — не наша забота
  }
  handle(message);
});
// Родитель закрыл stdin — завершаемся, как обычный stdio-сервер.
rl.on('close', () => process.exit(0));
