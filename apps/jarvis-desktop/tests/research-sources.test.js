'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent, sourcesForWindow } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { ApprovalBroker } = require('../src/policy/approvals');
const { Journal } = require('../src/journal/journal');

test('в окно уходят только безопасные карточки источников, без текста страниц', () => {
  const sources = sourcesForWindow({ data: { researchId: 'research_1', sources: [
    { id: 'S1', title: ' Первая страница ', url: 'https://user:pass@example.com/a#part', host: 'example.com', status: 'read', text: 'полный текст', snippet: 'фрагмент', found_by: ['запрос'] },
    { title: 'Копия', url: 'https://example.com/a', text: 'не показывать' },
    { title: 'Недоступная', url: 'https://example.net/b', status: 'unavailable', error: 'HTTP 403' },
    { title: 'Не веб', url: 'file:///C:/private.txt' },
  ] } });
  assert.deepEqual(sources, [
    { title: 'Первая страница', url: 'https://example.com/a', host: 'example.com', status: 'read' },
    { title: 'Недоступная', url: 'https://example.net/b', host: 'example.net', status: 'unavailable' },
  ]);
  assert.equal(JSON.stringify(sources).includes('полный текст'), false);
  assert.equal(JSON.stringify(sources).includes('user:pass'), false);
});

test('поисковая выдача и одна страница тоже становятся источниками; список ограничен', () => {
  assert.deepEqual(sourcesForWindow({ data: { results: [{ title: 'Результат', url: 'https://example.com/' }] } }), [
    { title: 'Результат', url: 'https://example.com/', host: 'example.com' },
  ]);
  assert.deepEqual(sourcesForWindow({ data: { url: 'https://example.org/page' } }), [
    { title: 'example.org', url: 'https://example.org/page', host: 'example.org' },
  ]);
  const many = Array.from({ length: 25 }, (_, i) => ({ title: String(i), url: `https://example.com/${i}` }));
  assert.equal(sourcesForWindow({ data: { sources: many } }).length, 20);
  assert.equal(sourcesForWindow({ data: { sources: [] } }), undefined);
  assert.equal(sourcesForWindow({ data: { text: 'без адреса' } }), undefined);
});

test('цикл отправляет источники окну, а модель получает полный материал', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  registry.register({
    name: 'web_research', risk: 'T0', parameters: { type: 'object', properties: {} },
    async run() {
      return { ok: true, summary: 'прочитано: 1', data: { sources: [
        { title: 'Источник', url: 'https://example.com/article', status: 'read', text: 'полный материал для модели', snippet: 'не нужен окну' },
      ] } };
    },
  });
  const replies = [
    { toolCalls: [{ id: 'r1', name: 'web_research', args: { queries: ['тема'] } }] },
    { content: 'Готово' },
  ];
  const brain = { async chat() { const next = replies.shift(); return { content: next.content || '', reasoningContent: null, toolCalls: next.toolCalls || [] }; } };
  const events = [];
  const agent = new Agent({
    brain, tools: registry, approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')), emit: (event) => events.push(event),
    mode: 'full', workspace: dir,
  });
  await agent.run('найди');
  const result = events.find((event) => event.type === 'tool_result');
  assert.deepEqual(result.sources, [{ title: 'Источник', url: 'https://example.com/article', host: 'example.com', status: 'read' }]);
  assert.equal(JSON.stringify(result).includes('полный материал'), false);
  assert.equal(JSON.stringify(agent.history).includes('полный материал для модели'), true);
});
