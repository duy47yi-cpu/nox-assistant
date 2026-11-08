'use strict';

// Многошаговая просьба: «открой ютуб найди там песню моргенштерна прокрути до 16 секунд и закрой все окна».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseStartSeconds, cleanQuery, hasOtherSteps, isMusicRequest } = require('../src/music/intent');
const { atSecond } = require('../src/music/play');
const { youtubeTools } = require('../src/tools/youtube');
const { windowsCloseTools } = require('../src/tools/windows-close');
const modes = require('../src/policy/modes');
const { Agent, MAX_TOOL_STEPS } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');

const PHRASE = 'открой ютуб найди там песню моргенштерна прокрути до 16 секунд и закрой все окна';

test('время старта: до 16 секунд, с 16 секунды, на 16-й секунде', () => {
  assert.equal(parseStartSeconds(PHRASE), 16);
  assert.equal(parseStartSeconds('поставь мияги с 16 секунды'), 16);
  assert.equal(parseStartSeconds('включи песню на 16-й секунде'), 16);
  assert.equal(parseStartSeconds('включи песню на 90 сек'), 90);
  assert.equal(parseStartSeconds('поставь музыку на 30 минут'), null);
  assert.equal(parseStartSeconds('поставь моргенштерна'), null);
});

test('время не попадает в поисковый запрос', () => {
  assert.equal(cleanQuery('поставь песню моргенштерна прокрути до 16 секунд'), 'моргенштерна');
  assert.equal(cleanQuery('поставь мияги с 16 секунды'), 'мияги');
});

test('ссылка на видео получает t=16s', () => {
  assert.equal(atSecond('https://www.youtube.com/watch?v=abcdefghijk', 16), 'https://www.youtube.com/watch?v=abcdefghijk&t=16s');
  assert.equal(atSecond('https://www.youtube.com/watch?v=abcdefghijk', null), 'https://www.youtube.com/watch?v=abcdefghijk');
});

test('музыка с другим делом в той же просьбе уходит модели', () => {
  assert.equal(isMusicRequest(PHRASE), true);
  assert.equal(hasOtherSteps(PHRASE), true);
  assert.equal(hasOtherSteps('поставь моргенштерна до 16 секунд'), false);
  assert.equal(hasOtherSteps('включи песню и сверни окна'), true);
});

function fakeUrlOpen(opened) {
  return {
    name: 'url_open',
    async run(args) { opened.push(args.url); return { ok: true, summary: 'открыто', data: { host: new URL(args.url).host } }; },
    async verify() { return { status: 'confirmed', evidence: 'окно найдено' }; },
  };
}

test('youtube_play открывает первое видео с нужной секунды, без видео — страницу поиска', async () => {
  const opened = [];
  const [found] = youtubeTools(fakeUrlOpen(opened), { find: async () => [{ id: 'abcdefghijk', title: 'Моргенштерн — Песня', url: 'https://www.youtube.com/watch?v=abcdefghijk' }] });
  const res = await found.run({ query: 'моргенштерн', start: 16 }, {});
  assert.equal(res.ok, true);
  assert.match(opened[0], /[?&]t=16s/);
  assert.match(res.summary, /16-й секунды/);

  const [missing] = youtubeTools(fakeUrlOpen(opened), { find: async () => [] });
  const res2 = await missing.run({ query: 'моргенштерн', start: 16 }, {});
  assert.match(opened[1], /results\?search_query=/);
  assert.match(res2.summary, /перемотку сделать не удалось/);
});

test('закрытие всех окон спрашивает в режимах «Спрашивать» и «Авто»', () => {
  const [tool] = windowsCloseTools({ runner: async () => ({ ok: true, data: { stdout: '[]' } }) });
  assert.equal(tool.risk, 'T2');
  for (const mode of ['ask', 'auto']) {
    assert.equal(modes.decide({ mode, name: tool.name, risk: tool.risk, args: {}, workspace: os.tmpdir(), hasPathParam: false }), 'ask', mode);
  }
});

// Фейковый PowerShell: при JARVIS_CLOSE=1 отдаёт окна до закрытия, при 0 — то, что осталось.
function windowsRunner({ before, after, failList = false }) {
  const calls = [];
  const runner = async (script, env) => {
    calls.push(env);
    if (env.JARVIS_CLOSE === '1') return { ok: true, data: { stdout: JSON.stringify(before) } };
    if (failList) return { ok: false, summary: 'таймаут' };
    return { ok: true, data: { stdout: JSON.stringify(after) } };
  };
  return { runner, calls };
}

const W = [{ pid: 10, name: 'notepad', title: 'Без имени — Блокнот' }, { pid: 11, name: 'chrome', title: 'YouTube' }];

test('windows_close_all: окна Джарвиса передаются в исключения, verify честный', async () => {
  const ctx = { pollTimeoutMs: 50, pollStepMs: 10 };

  const all = windowsRunner({ before: W, after: [] });
  const [tool] = windowsCloseTools({ runner: all.runner, keepPids: () => [4242, 4243] });
  const res = await tool.run({}, ctx);
  assert.equal(res.ok, true);
  assert.equal(all.calls[0].JARVIS_KEEP_PIDS, '4242,4243');
  assert.match(all.calls[0].JARVIS_KEEP_NAMES, /explorer/);
  assert.equal((await tool.verify({}, res, ctx)).status, 'confirmed');

  const part = windowsRunner({ before: W, after: [W[0]] });
  const [tool2] = windowsCloseTools({ runner: part.runner });
  const v2 = await tool2.verify({}, await tool2.run({}, ctx), ctx);
  assert.equal(v2.status, 'failed');
  assert.match(v2.evidence, /закрыто 1 из 2/);
  assert.match(v2.evidence, /Блокнот/);

  const same = windowsRunner({ before: W, after: W });
  const [tool3] = windowsCloseTools({ runner: same.runner });
  const v3 = await tool3.verify({}, await tool3.run({}, ctx), ctx);
  assert.equal(v3.status, 'failed');
  assert.match(v3.evidence, /ни одно окно не закрылось/);

  const blind = windowsRunner({ before: W, failList: true });
  const [tool4] = windowsCloseTools({ runner: blind.runner });
  assert.equal((await tool4.verify({}, await tool4.run({}, ctx), ctx)).status, 'unknown');

  const empty = windowsRunner({ before: [], after: [] });
  const [tool5] = windowsCloseTools({ runner: empty.runner });
  const r5 = await tool5.run({}, ctx);
  assert.equal(r5.summary, 'открытых окон нет');
  assert.equal((await tool5.verify({}, r5, ctx)).status, 'confirmed');
});

test('цепочка из трёх шагов за один ход: видео, ожидание, закрытие окон с подтверждением', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-multistep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.ok(MAX_TOOL_STEPS >= 3);

  const opened = [];
  const ran = [];
  const reg = new ToolRegistry();
  const [yt] = youtubeTools(fakeUrlOpen(opened), { find: async () => [{ id: 'abcdefghijk', title: 'Моргенштерн — Песня', url: 'https://www.youtube.com/watch?v=abcdefghijk' }] });
  const [close] = windowsCloseTools({ runner: windowsRunner({ before: W, after: [] }).runner });
  const wait = { name: 'wait', risk: 'T0', description: 'wait', parameters: { type: 'object', properties: {} }, async run() { return { ok: true, summary: 'подождал', data: {} }; } };
  for (const tool of [yt, wait, close]) reg.register({ ...tool, run: async (a, c) => { ran.push(tool.name); return tool.run(a, c); } });

  const steps = [
    { toolCalls: [{ id: 'c1', name: 'youtube_play', args: { query: 'моргенштерн', start: 16 } }] },
    { toolCalls: [{ id: 'c2', name: 'wait', args: {} }] },
    { toolCalls: [{ id: 'c3', name: 'windows_close_all', args: {} }] },
    { content: 'Готово' },
  ];
  let i = 0;
  const brain = { async chat() { const s = steps[i++]; return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] }; } };
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });
  const asked = [];
  const agent = new Agent({
    brain,
    tools: reg,
    policy: modes,
    approvals,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => {
      if (e.type === 'approval_request') { asked.push(e.name); approvals.respond(e.id, 'once'); }
    },
    mode: 'auto',
    workspace: dir,
  });
  await agent.run(PHRASE);

  assert.deepEqual(ran, ['youtube_play', 'wait', 'windows_close_all']);
  assert.ok(asked.includes('windows_close_all'));
  assert.ok(!asked.includes('wait'));
  assert.match(opened[0], /t=16s/);
});
