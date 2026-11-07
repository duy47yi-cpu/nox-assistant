'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Journal } = require('../src/journal/journal');

test('append пишет строки JSON с ts, создаёт папку и дописывает', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'journal.jsonl');

  const journal = new Journal(file);
  journal.append({ tool: 'volume_set', ok: true });
  journal.append({ tool: 'shell_run', ok: false, ts: 'подменено' });

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const [first, second] = lines.map((line) => JSON.parse(line));
  assert.equal(first.tool, 'volume_set');
  assert.equal(first.ok, true);
  assert.equal(new Date(first.ts).toISOString(), first.ts);
  assert.equal(second.tool, 'shell_run');
  assert.equal(new Date(second.ts).toISOString(), second.ts, 'ts ставит журнал, а не вызывающий код');
});
