'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SAMPLE_COMMANDS } = require('../src/commands/samples');

test('«Рабочий режим» есть среди примеров, с задержками wait и без закрытия программ', () => {
  const cmd = SAMPLE_COMMANDS.find((c) => c.name === 'Рабочий режим');
  assert.ok(cmd, 'пример не найден');
  assert.ok(cmd.phrases.includes('рабочий режим'));
  const tools = cmd.steps.map((s) => s.tool);
  assert.ok(tools.includes('wait'), 'нужны задержки между шагами');
  assert.ok(!tools.includes('app_close'), 'закрытие программ в команде запрещено');
  assert.ok(!tools.includes('shell_run'));
});
