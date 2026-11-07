'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPowerShell, MAX_ENCODED } = require('../src/tools/system');
const { uiTools } = require('../src/tools/ui');

const win = process.platform === 'win32';

test('команда PowerShell выполняется в рабочей папке выбранного пространства', { skip: !win, timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-shell-cwd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shell = require('../src/tools/system').systemTools.find((tool) => tool.name === 'shell_run');
  const result = await shell.run({ command: '(Get-Location).Path' }, { workspace: dir });
  assert.equal(result.ok, true, result.summary);
  assert.equal(path.resolve(result.data.stdout.trim()).toLowerCase(), path.resolve(dir).toLowerCase());
});

function ourTempScripts() {
  try {
    return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`nox-ps-${process.pid}-`) && name.endsWith('.ps1'));
  } catch {
    return [];
  }
}

test('короткий скрипт идёт через EncodedCommand и видит переменные окружения', { skip: !win, timeout: 30000 }, async () => {
  const result = await runPowerShell('Write-Output $env:NOX_PS_TEST', { NOX_PS_TEST: '42' });
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.data.stdout.trim(), '42');
});

test('длинный скрипт уходит временным файлом и выполняется', { skip: !win, timeout: 60000 }, async () => {
  const before = ourTempScripts();
  // Кириллица в комментарии проверяет BOM: без него PowerShell 5.1 читает файл как ANSI.
  const script = `# ${'проверка длинной команды '.repeat(4000)}\nWrite-Output "ok"`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  assert.ok(encoded.length > MAX_ENCODED, 'скрипт должен быть длиннее предела командной строки');
  const result = await runPowerShell(script, {});
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.data.stdout.trim(), 'ok');
  const after = ourTempScripts().filter((name) => !before.includes(name));
  assert.deepEqual(after, [], 'временный файл скрипта должен удаляться');
});

test('длинный скрипт не оставляет файл при ошибке PowerShell', { skip: !win, timeout: 60000 }, async () => {
  const before = ourTempScripts();
  const script = `# ${'x'.repeat(40000)}\nWrite-Error "boom"; exit 7`;
  const result = await runPowerShell(script, {});
  assert.equal(result.ok, false);
  assert.match(result.summary, /код выхода 7/);
  const after = ourTempScripts().filter((name) => !before.includes(name));
  assert.deepEqual(after, [], 'временный файл должен удаляться и при ошибке');
});

test('ui_type с длинным текстом больше не падает ENAMETOOLONG', { skip: !win, timeout: 60000 }, async () => {
  const ui = uiTools({ runner: runPowerShell, selfPid: process.pid });
  const type = ui.find((tool) => tool.name === 'ui_type');
  // 2000 символов — предел ui_type; скрипт с текстом длиннее командной строки Windows.
  const result = await type.run({ window: 'Нет такого окна 987654', text: 'я'.repeat(2000) });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.summary, /ENAMETOOLONG|argument list too long/i);
  assert.match(result.summary, /окно/i);
});
