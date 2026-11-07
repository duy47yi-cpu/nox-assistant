'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { screenTools, CAPTURE_SCRIPT, MAX_WIDTH } = require('../src/tools/screen');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

const IMG = 'data:image/jpeg;base64,AAAA';

test('без разрешения снимок не делается и захват не вызывается', async () => {
  let called = false;
  const [tool] = screenTools({ allowed: () => false, capture: async () => { called = true; return { ok: true }; } });
  const res = await tool.run({}, {});
  assert.equal(res.ok, false);
  assert.match(res.summary, /по просьбе/);
  assert.equal(called, false);
});

test('с разрешением снимок возвращается картинкой и временный файл удаляется', async () => {
  let savedTo = null;
  const [tool] = screenTools({
    allowed: () => true,
    capture: async (script, env) => {
      savedTo = env.JARVIS_SHOT;
      fs.writeFileSync(env.JARVIS_SHOT, Buffer.from([0xff, 0xd8, 0xff]));
      return { ok: true, summary: 'готово', data: {} };
    },
  });
  const res = await tool.run({}, {});
  assert.equal(res.ok, true);
  assert.ok(res.image.startsWith('data:image/jpeg;base64,'));
  assert.equal(fs.existsSync(savedTo), false, 'временный файл должен быть удалён');
});

test('ошибка захвата честно возвращается как неуспех', async () => {
  const [tool] = screenTools({ allowed: () => true, capture: async () => ({ ok: false, summary: 'код выхода 1', data: {} }) });
  const res = await tool.run({}, {});
  assert.equal(res.ok, false);
  assert.match(res.summary, /не удалось снять экран/);
  assert.equal(res.image, undefined);
});

test('скрипт захвата ограничивает ширину и читает путь из переменной окружения', () => {
  assert.match(CAPTURE_SCRIPT, new RegExp(`Min\\(${MAX_WIDTH}`));
  assert.match(CAPTURE_SCRIPT, /\$env:JARVIS_SHOT/);
});

test('картинка уходит модели в текущем ходу, а в следующем ходу остаётся текстом', async () => {
  const reg = new ToolRegistry();
  for (const t of screenTools({ allowed: () => true, capture: async () => ({ ok: true, summary: '', data: {} }) })) {
    reg.register({ ...t, run: async () => ({ ok: true, summary: 'снимок', data: {}, image: IMG }) });
  }
  const calls = [];
  let step = 0;
  const brain = {
    async chat({ messages }) {
      calls.push(messages);
      step += 1;
      if (step === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'screen_look', args: {} }] };
      return { content: 'вижу окно', toolCalls: [] };
    },
  };
  const agent = new Agent({ brain, tools: reg, journal: { append() {} }, emit() {}, mode: 'full', systemPrompt: 'система' });
  await agent.run('что на экране?');
  const withImage = calls[1].filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  assert.equal(withImage.length, 1, 'в ответе на шаг инструмента картинка есть');
  assert.equal(withImage[0].content[1].image_url.url, IMG);

  await agent.run('а теперь что?');
  const next = calls[calls.length - 1];
  assert.equal(next.some((m) => Array.isArray(m.content)), false, 'в следующем ходу картинки нет');
  assert.equal(next.some((m) => 'image' in m), false, 'поле image в запрос не попадает');
});
