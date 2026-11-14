'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectSearchSources, chatHistoryRows } = require('../src/agent/sources');
const { maskHistory } = require('../src/journal/journal');

test('sources are unique search results, without credentials or non-web URLs', () => {
  const sources = new Map();
  const good = { title: '  A   page  ', url: 'https://example.org/page' };
  collectSearchSources(sources, 'web_search', { ok: true, data: { results: [
    good,
    { url: good.url + '#intro' },
    { url: 'https://name:pass@example.org/page' },
    { url: 'file:///sample' },
  ] } });
  collectSearchSources(sources, 'web_fetch', { ok: true, data: { url: 'https://example.org/model-input' } });
  collectSearchSources(sources, 'web_search', { ok: false, data: { results: [{ url: 'https://example.org/failed' }] } });
  assert.deepEqual([...sources.values()], [{ url: good.url, title: 'A page', host: 'example.org' }]);
});

test('history restores sources from stored answers and surviving older tool results', () => {
  const source = { title: 'Page', url: 'https://example.org/', host: 'example.org' };
  const question = { role: 'user', content: 'Look it up' };
  const search = { role: 'assistant', content: 'Searching', tool_calls: [{ id: '1', function: { name: 'web_search', arguments: '{}' } }] };
  const result = { role: 'tool', tool_call_id: '1', content: JSON.stringify({ ok: true, data: { results: [source] } }) };
  const answer = { role: 'assistant', content: 'Answer https://example.net/from-model' };
  const next = { role: 'assistant', content: 'Another answer' };
  const restored = (toolResult, reply) => chatHistoryRows(maskHistory([question, search, toolResult, reply, question, next]));
  const old = restored(result, answer);
  assert.deepEqual(old.map((row) => row.searchSources), [undefined, undefined, [source], undefined, undefined]);
  const redacted = { ...result, provenance: { untrusted: true } };
  assert.equal(restored(redacted, answer)[2].searchSources, undefined);
  assert.deepEqual(restored(redacted, { ...answer, searchSources: [source] }), old);
});
