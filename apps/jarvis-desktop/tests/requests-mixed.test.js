'use strict';

// Регрессионный набор: просьбы из нескольких дел («поставь мияги бадабум проверить погоду»).
// Музыка не забирает такую фразу целиком: она уходит модели, и делаются оба дела.
// Дополняйте MIXED: фраза и что должно уйти в поиск музыки.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasOtherSteps, cleanQuery, stripOtherDeals } = require('../src/music/intent');
const { parseOffline } = require('../src/shortcuts/offline');
const { youtubeTools } = require('../src/tools/youtube');
const modes = require('../src/policy/modes');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');

const MIXED = [
  ['поставь мияги бадабум проверить погоду', 'мияги бадабум'],
  ['поставь мияги бадабум проверь погоду', 'мияги бадабум'],
  ['включи мияги и скажи сколько времени', 'мияги'],
  ['поставь моргенштерна и какая погода в москве', 'моргенштерна'],
  ['скажи погоду и поставь мияги', 'мияги'],
  ['включи музыку и поставь таймер на 10 минут', 'музыка'],
  ['поставь мияги, а потом напомни через 10 минут позвонить маме', 'мияги'],
  ['поставь мияги и открой калькулятор', 'мияги'],
  ['открой калькулятор и включи песню мияги', 'мияги'],
  ['сыграй xcho и подскажи который час', 'xcho'],
  ['врубай моргенштерна, какой курс доллара?', 'моргенштерна'],
  ['поставь песню мияги и расскажи новости', 'мияги'],
  ['поставь мияги бадабум, какая сегодня погода?', 'мияги бадабум'],
  ['включи спокойную музыку и покажи прогноз на завтра', 'спокойную'],
  ['поставь мияги, что там с погодой', 'мияги'],
  ['поставь мияги и сколько сейчас градусов', 'мияги'],
  ['найди песню мияги и узнай температуру на улице', 'мияги'],
  ['поставь мияги и когда у меня встреча', 'мияги'],
  ['включи песню муцараева и поставь будильник на 7 утра', 'муцараева'],
  ['поставь мияги бадабум и проверь, где сейчас курс евро', 'мияги бадабум'],
];

// Слова дел, которых не должно быть в поиске музыки.
const DEAL_LEFT = /погод|провер|скажи|сколько|таймер|напомн|калькулятор|курс|новост|прогноз|температур|градус|будильник|который|встреч|какая|какой|когда|где/;

for (const [phrase, music] of MIXED) {
  test(`несколько дел: «${phrase}»`, () => {
    // Музыка без модели такую фразу не берёт (musicTurn в main.js возвращает null), короткие фразы — тоже.
    assert.equal(hasOtherSteps(phrase), true, 'второе дело найдено');
    assert.equal(parseOffline(phrase), null, 'короткие фразы без модели её не забирают');
    // Музыкальная часть на месте и без чужих слов.
    assert.equal(cleanQuery(phrase), music);
    assert.doesNotMatch(cleanQuery(phrase), DEAL_LEFT);
  });
}

test('чистая музыка остаётся без модели, названия-вопросы не режутся', () => {
  for (const p of ['поставь мияги бадабум', 'открой ютуб и поставь там музыку', 'поставь какую-нибудь музыку', 'именно то, что я хотел. Поставь любую музыку xcho']) {
    assert.equal(hasOtherSteps(p), false, p);
  }
  // Модель передала название песни: оно не дело, оставляем.
  assert.equal(stripOtherDeals('Погода в доме'), 'Погода в доме');
  assert.equal(stripOtherDeals('когда ты рядом'), 'когда ты рядом');
  assert.equal(stripOtherDeals('мияги бадабум'), 'мияги бадабум');
});

// Подменённая модель: на «поставь мияги бадабум проверить погоду» передаёт в youtube_play просьбу целиком
// и отдельно ищет погоду. В поиск музыки уходит только «мияги бадабум», ответ про погоду тоже есть.
test('ход модели: музыка и погода выполняются обе, в поиск музыки не попадает «погода»', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mixed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opened = [];
  const searched = [];
  const urlOpen = {
    name: 'url_open',
    async run(args) { opened.push(args.url); return { ok: true, summary: 'открыто', data: {} }; },
    async verify() { return { status: 'confirmed', evidence: 'окно найдено' }; },
  };
  const [yt] = youtubeTools(urlOpen, { find: async (q) => { searched.push(q); return null; } });
  const reg = new ToolRegistry();
  reg.register(yt);
  reg.register({
    name: 'web_search', risk: 'T0', description: 'поиск',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async run() { return { ok: true, summary: 'Москва: +5, облачно', data: {} }; },
  });
  const steps = [
    // Запрос для поиска формирует модель: в нём только песня, погоду она ищет отдельным инструментом.
    { toolCalls: [{ id: 'c1', name: 'youtube_play', args: { query: 'мияги бадабум' } }] },
    { toolCalls: [{ id: 'c2', name: 'web_search', args: { query: 'погода сегодня' } }] },
    { content: 'Включил мияги. На улице +5, облачно.' },
  ];
  let i = 0;
  const brain = { async chat() { const s = steps[i++]; return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] }; } };
  const texts = [];
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });
  const agent = new Agent({
    brain, tools: reg, policy: modes, approvals, mode: 'full', workspace: dir,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      if (e.type === 'text') texts.push(e.delta);
      if (e.type === 'approval_request') approvals.respond(e.id, 'once');
    },
  });
  await agent.run('поставь мияги бадабум проверить погоду');
  assert.deepEqual(searched, ['мияги бадабум']);
  assert.equal(opened.length, 1);
  assert.doesNotMatch(decodeURIComponent(opened[0]), /погод|провер|скажи/);
  assert.match(texts.join(''), /\+5/);
});
