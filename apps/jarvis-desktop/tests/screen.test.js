'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { screenTools, regionTools, CAPTURE_SCRIPT, MAX_WIDTH, REGION_TTL_MS } = require('../src/tools/screen');
const { checkEffect } = require('../src/agent/effects');
const { remoteAllowed } = require('../src/telegram/policy');
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

// Подмена nativeImage: crop отдаёт картинку заданного размера, toJPEG — байты.
function fakeShot({ cropSize } = {}) {
  const seen = { crop: null, resize: null };
  const part = (size) => ({
    getSize: () => size,
    resize: (opts) => { seen.resize = opts; return part({ width: opts.width, height: Math.round(size.height * opts.width / size.width) }); },
    toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0x01]),
  });
  return { seen, shot: { crop: (r) => { seen.crop = r; return part(cropSize || { width: r.width, height: r.height }); } } };
}

test('область: без выбора владельца снимка нет', async () => {
  const [tool] = regionTools({ take: () => null });
  const res = await tool.run({}, {});
  assert.equal(res.ok, false);
  assert.match(res.summary, /не выбрана/);
  assert.equal(res.image, undefined);
});

test('область: вырезается ровно обведённое, verify подтверждает, снимок сбрасывается', async () => {
  const { shot, seen } = fakeShot();
  let cleared = 0;
  const pixels = { x: 10, y: 20, width: 300, height: 200 };
  const [tool] = regionTools({ take: () => ({ shot, pixels, label: 'область 300×200', at: Date.now() }), clear: () => { cleared += 1; } });
  assert.equal(tool.risk, 'T1');
  const res = await checkEffect(tool, {}, await tool.run({}, {}), {});
  assert.equal(res.ok, true);
  assert.equal(res.verified, 'confirmed');
  assert.deepEqual(seen.crop, pixels);
  assert.ok(res.image.startsWith('data:image/jpeg;base64,'));
  assert.equal(cleared, 1, 'снимок в памяти не задерживается');
});

test('область: размер не совпал — честный провал проверки', async () => {
  const { shot } = fakeShot({ cropSize: { width: 100, height: 200 } });
  const [tool] = regionTools({ take: () => ({ shot, pixels: { x: 0, y: 0, width: 300, height: 200 }, at: Date.now() }) });
  const res = await checkEffect(tool, {}, await tool.run({}, {}), {});
  assert.equal(res.ok, false);
  assert.equal(res.verified, 'failed');
  assert.match(res.summary, /размер не совпал/);
});

test('область: широкая сжимается до MAX_WIDTH, проверка идёт по вырезанному размеру', async () => {
  const { shot, seen } = fakeShot();
  const [tool] = regionTools({ take: () => ({ shot, pixels: { x: 0, y: 0, width: 2560, height: 400 }, at: Date.now() }) });
  const res = await checkEffect(tool, {}, await tool.run({}, {}), {});
  assert.equal(seen.resize.width, MAX_WIDTH);
  assert.equal(res.verified, 'confirmed');
});

test('область: устаревший выбор не показывается', async () => {
  const { shot } = fakeShot();
  let cleared = false;
  const [tool] = regionTools({ take: () => ({ shot, pixels: { x: 0, y: 0, width: 50, height: 50 }, at: 0 }), clear: () => { cleared = true; }, now: () => REGION_TTL_MS + 1 });
  const res = await tool.run({}, {});
  assert.equal(res.ok, false);
  assert.match(res.summary, /устарела/);
  assert.equal(cleared, true);
});

test('область: ошибка вырезания — неуспех без картинки', async () => {
  const [tool] = regionTools({ take: () => ({ shot: { crop: () => { throw new Error('нет'); } }, pixels: { x: 0, y: 0, width: 50, height: 50 }, at: Date.now() }) });
  const res = await tool.run({}, {});
  assert.equal(res.ok, false);
  assert.equal(res.image, undefined);
});

test('область: в Telegram инструмент не попадает', () => {
  const [tool] = regionTools();
  assert.equal(remoteAllowed(tool), false);
});
