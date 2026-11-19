'use strict';

// Тесты безопасной очистки ОЗУ (ram_trim) и сборки ИИ-команд по описанию («вкладка + ОЗУ + музыка»).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ramTools, parseRamOutput } = require('../src/tools/ram');
const { assembleCommandFromDescription, parseDescriptionOffline } = require('../src/commands/builder');
const { CommandStore } = require('../src/commands/store');

const TOOLS = ['app_open', 'url_open', 'ram_trim', 'youtube_play', 'media_control', 'ui_keys', 'ui_type', 'ui_click', 'wait', 'speak', 'volume_set'];

test('parseRamOutput разбирает JSON из вывода PowerShell и считает freedMb', () => {
  const parsed = parseRamOutput('\n{"totalMb":16384,"availBeforeMb":4200,"availAfterMb":5650,"freedMb":1450,"trimmedCount":84}\r\n');
  assert.deepEqual(parsed, {
    totalMb: 16384,
    availBeforeMb: 4200,
    availAfterMb: 5650,
    freedMb: 1450,
    trimmedCount: 84,
  });
  assert.equal(parseRamOutput(''), null);
  assert.equal(parseRamOutput('not json'), null);
});

test('ram_trim возвращает verified confirmed при успешном измерении и failed/unknown при ошибке', async () => {
  const [ramTrim] = ramTools({
    runner: async () => ({
      ok: true,
      summary: 'готово',
      data: { stdout: JSON.stringify({ totalMb: 16384, availBeforeMb: 5000, availAfterMb: 5800, freedMb: 800, trimmedCount: 72 }) },
    }),
  });
  const res = await ramTrim.run({});
  assert.equal(res.ok, true);
  assert.match(res.summary, /освобождено 800 МБ/);
  assert.match(res.summary, /5800 из 16384 МБ/);
  const v = await ramTrim.verify({}, res);
  assert.equal(v.status, 'confirmed');
  assert.match(v.evidence, /5800 из 16384 МБ/);

  const [failing] = ramTools({
    runner: async () => ({ ok: false, summary: 'таймаут 25000 мс', data: {} }),
  });
  const failRes = await failing.run({});
  assert.equal(failRes.ok, false);
  const vFail = await failing.verify({}, failRes);
  assert.equal(vFail.status, 'failed');
});

test('assembleCommandFromDescription и parseDescriptionOffline собирают «вкладка + ОЗУ + музыка» и сохраняют в CommandStore', async () => {
  const res = await assembleCommandFromDescription({
    text: 'хочу команду: открытие вкладки youtube.com, очищение оперативной памяти и музыку moonlight',
    tools: TOOLS,
  });
  assert.equal(res.ok, true, res.error || '');
  const steps = res.command.steps;
  assert.equal(steps.length, 3);
  assert.equal(steps[0].tool, 'url_open');
  assert.equal(steps[0].args.url, 'https://youtube.com');
  assert.equal(steps[1].tool, 'ram_trim');
  assert.equal(steps[2].tool, 'youtube_play');
  assert.equal(steps[2].args.query, 'moonlight');

  const ellipsisRes = parseDescriptionOffline('открытие вкладки ... очищение оперативной памяти и музыку moonlight', { tools: TOOLS });
  assert.equal(ellipsisRes.ok, true, ellipsisRes.error || '');
  assert.deepEqual(ellipsisRes.command.steps.map((s) => s.tool), ['url_open', 'ram_trim', 'youtube_play']);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-ram-cmd-'));
  try {
    const store = new CommandStore(path.join(tmpDir, 'commands.json'));
    const saved = store.save(res.command);
    const loaded = store.get(saved.id);
    assert.deepEqual(loaded.steps.map((s) => s.tool), ['url_open', 'ram_trim', 'youtube_play']);
    assert.equal(loaded.steps[1].type, 'ram_trim');
    assert.equal(loaded.steps[2].type, 'youtube');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
