'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { uniqueSearchMatch, installTools } = require('../src/tools/install');
const modes = require('../src/policy/modes');

const row = (name, id, version = '1.0') => name.padEnd(28) + id.padEnd(30) + version;
const table = (...rows) => [row('Name', 'Id', 'Version'), '-'.repeat(70), ...rows.map(([name, id]) => row(name, id))].join('\n');
const firefox = table(['Mozilla Firefox', 'Mozilla.Firefox']);

test('сопоставление требует полной и однозначной таблицы поиска', () => {
  assert.equal(uniqueSearchMatch('Firefox', firefox), 'Mozilla.Firefox');
  assert.equal(uniqueSearchMatch('Firefox', table(['Mozilla Firefox', 'Mozilla.Firefox'], ['Other Firefox', 'Other.Firefox'])), null);
  assert.equal(uniqueSearchMatch('Firefox', table(['Other Firefox', 'Other.Chrome'])), null);
  assert.equal(uniqueSearchMatch('Firefox', 'Mozilla Firefox Mozilla.Firefox 1.0'), null);
  assert.equal(uniqueSearchMatch('Firefox', [row('Имя', 'Идентификатор', 'Версия'), '-'.repeat(70), row('Mozilla Firefox', 'Mozilla.Firefox')].join('\n')), 'Mozilla.Firefox');
  assert.equal(uniqueSearchMatch('Firefox', table(...Array.from({ length: 8 }, (_, i) => [i ? `App ${i}` : 'Mozilla Firefox', i ? `Example.App${i}` : 'Mozilla.Firefox']))), null);
});

test('пустой или битый ответ PowerShell не роняет поиск и установку', async () => {
  const search = installTools({ runner: async () => undefined }).find((tool) => tool.name === 'app_search');
  const found = await search.run({ query: 'Firefox' });
  assert.equal(found.ok, false);
  assert.match(found.summary, /поиск не удался/);
  const empty = installTools({ runner: async () => null }).find((tool) => tool.name === 'app_search');
  assert.equal((await empty.run({ query: 'Firefox' })).ok, false);
  // Ответ «успех», но без данных: поиск не падает, текст пустой.
  const noData = installTools({ runner: async () => ({ ok: true }) }).find((tool) => tool.name === 'app_search');
  const blank = await noData.run({ query: 'Firefox' });
  assert.equal(blank.ok, true);
  assert.equal(blank.data.text, '');
  const install = installTools({ runner: async () => null }).find((tool) => tool.name === 'app_install');
  const started = await install.run({ id: 'Mozilla.Firefox' });
  assert.equal(started.ok, false);
  assert.match(started.summary, /установка Mozilla\.Firefox не удалась/);
});

test('проверка установки не подтверждает успех при неудачной установке и без Id', async () => {
  let listCalls = 0;
  const install = installTools({ runner: async () => { listCalls += 1; return { ok: true, data: { stdout: firefox } }; } })
    .find((tool) => tool.name === 'app_install');
  const failed = await install.verify({}, { ok: false, summary: 'код выхода 1', data: { id: 'Mozilla.Firefox' } });
  assert.equal(failed.status, 'unknown');
  assert.match(failed.evidence, /не завершилась/);
  assert.equal(listCalls, 0, 'при неудачной установке winget list не спрашиваем');
  const noId = await install.verify({}, { ok: true, data: {} });
  assert.equal(noId.status, 'unknown');
  assert.equal(listCalls, 0);
  const emptyRunner = installTools({ runner: async () => undefined }).find((tool) => tool.name === 'app_install');
  assert.equal((await emptyRunner.verify({}, { ok: true, data: { id: 'Mozilla.Firefox' } })).status, 'unknown');
});

function harness({ mode = 'full', text = firefox, query = 'Firefox', id = 'Mozilla.Firefox', ownerText = 'установи Firefox', searchFirst = true, realSearch = false } = {}) {
  let installs = 0;
  const tools = new ToolRegistry();
  tools.register(realSearch
    ? installTools({ runner: async () => ({ ok: true, data: { stdout: text } }) }).find((tool) => tool.name === 'app_search')
    : { name: 'app_search', risk: 'T0', parameters: { type: 'object', properties: {} }, async run() { return { ok: true, summary: 'найдено', data: { text } }; } });
  tools.register({ name: 'app_install', risk: 'T3', parameters: { type: 'object', properties: {} }, async run() { installs++; return { ok: true, summary: 'готово' }; } });
  const calls = [];
  if (searchFirst) calls.push({ id: 's', name: 'app_search', args: { query } });
  calls.push({ id: 'i', name: 'app_install', args: { id } });
  let round = 0;
  const brain = { async chat() { return round++ === 0 ? { toolCalls: calls } : { content: 'готово' }; } };
  const agent = new Agent({ brain, tools, policy: modes, mode, approvals: { async request() { return 'reject'; } }, journal: { append() {} }, emit() {} });
  return { agent, ownerText, installs: () => installs };
}

test('полный доступ использует только совпавший поиск текущего поручения', async () => {
  const yes = harness({ realSearch: true });
  await yes.agent.run(yes.ownerText, { ownerText: yes.ownerText });
  assert.equal(yes.installs(), 1);
  const punctuated = harness({ ownerText: 'установи Firefox.' });
  await punctuated.agent.run(punctuated.ownerText, { ownerText: punctuated.ownerText });
  assert.equal(punctuated.installs(), 1);
  for (const options of [
    { id: 'Google.Chrome' },
    { ownerText: 'проверь Firefox' },
    { ownerText: 'установи Chrome', query: 'Firefox' },
    { ownerText: 'установи Chrome и найди Firefox', query: 'Firefox' },
    { ownerText: 'установи Chrome и найди Mozilla.Firefox', query: 'Firefox' },
    { ownerText: 'установи Firefox.exe', query: 'Firefox' },
    { mode: 'auto' },
    { searchFirst: false },
    { text: table(['Mozilla Firefox', 'Mozilla.Firefox'], ['Other Firefox', 'Other.Firefox']) },
  ]) {
    const h = harness(options);
    await h.agent.run(h.ownerText, { ownerText: h.ownerText });
    assert.equal(h.installs(), 0, JSON.stringify(options));
  }
});

test('связь поиска не переносится на другой ход и другого агента', async () => {
  const h = harness();
  await h.agent.run(h.ownerText, { ownerText: h.ownerText });
  assert.equal(h.installs(), 1);
  assert.equal(h.agent._installEvidence, null);
  let round = 0;
  h.agent.brain = { async chat() { return round++ === 0 ? { toolCalls: [{ id: 'i2', name: 'app_install', args: { id: 'Mozilla.Firefox' } }] } : { content: 'готово' }; } };
  await h.agent.run(h.ownerText, { ownerText: h.ownerText });
  assert.equal(h.installs(), 1);
  const other = harness({ searchFirst: false });
  await other.agent.run(other.ownerText, { ownerText: other.ownerText });
  assert.equal(other.installs(), 0);
});
