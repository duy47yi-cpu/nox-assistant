'use strict';

// Скорость мыши и снимка экрана: оба идут через один живой PowerShell (ps-host), а не через новый
// powershell.exe со сборкой C# (Add-Type) на каждый вызов. Проверки оплаты и опасных кнопок не меняются.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mouseTools, SCRIPT } = require('../src/tools/mouse');
const { createPsHost } = require('../src/tools/ps-host');
const { runPowerShell } = require('../src/tools/system');

const win = process.platform === 'win32';
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('мышь: в скрипте нет exit — общий живой PowerShell после отказа не закрывается', () => {
  assert.doesNotMatch(SCRIPT, /\bexit\b/i);
  for (const status of ['no_window', 'outside', 'no_focus', 'occluded', 'payment', 'danger']) {
    assert.match(SCRIPT, new RegExp(`status = '${status}'[^\\n]*; return \\}`), `ранний выход ${status} — через return`);
  }
});

test('мышь: окно уже впереди — без повторной активации и без 150 мс ожидания; проверка фокуса осталась', () => {
  const lines = SCRIPT.split('\n').map((s) => s.trim());
  const i = lines.indexOf('if ([JarvisMouse.User32]::GetForegroundWindow() -ne $h) {');
  assert.ok(i >= 0, 'активация только если окно не впереди');
  assert.equal(lines[i + 1], '[void][JarvisMouse.User32]::SetForegroundWindow($h)');
  assert.equal(lines[i + 2], 'Start-Sleep -Milliseconds 150');
  assert.equal(lines[i + 3], '}');
  assert.match(lines[i + 4], /status = 'no_focus'/);
  assert.equal(SCRIPT.match(/SetForegroundWindow\(\$h\)/g).length, 1);
  // Оплата и опасные кнопки проверяются перед каждым нажатием, как и раньше.
  assert.ok(SCRIPT.indexOf('Test-JPaymentAtPoint $x $y') < SCRIPT.indexOf('mouse_event($down'));
  assert.ok(SCRIPT.indexOf('Test-JDangerAtPoint $x $y') < SCRIPT.indexOf('mouse_event($down'));
});

test('main.js: мышь и снимок экрана в чате и агенте экрана идут через живой PowerShell', () => {
  assert.match(main, /const mouseToolset = mouseTools\(\{ selfPid: process\.pid, runner: psHost\.run \}\)/);
  assert.match(main, /screenTools\(\{ allowed: \(\) => screenAllowed, capture: psHost\.run \}\)/);
  assert.match(main, /look: screenTools\(\{ allowed: \(\) => true, capture: psHost\.run \}\)\[0\]/);
});

test('мышь: живой PowerShell упал посреди нажатия — исход неизвестен, повтора нет', async () => {
  let calls = 0;
  const runner = async () => { calls += 1; return { ok: false, summary: 'PowerShell закрылся', data: {}, hostDied: true }; };
  const [click] = mouseTools({ runner, selfPid: 1 });
  const res = await click.run({ window: 'Блокнот', x: 10, y: 20, button: 'double' }, {});
  assert.equal(calls, 1, 'нажатие не повторяется вслепую');
  assert.equal(res.ok, false);
  assert.equal(res.verified, 'unknown');
});

test('мышь: ответ живого PowerShell (Out-String с переводом строки) разбирается', async () => {
  const runner = async () => ({ ok: true, summary: 'готово', data: { stdout: '{"status":"ok","title":"Блокнот"}\r\n', stderr: '' } });
  const [click] = mouseTools({ runner, selfPid: 1 });
  const res = await click.run({ window: 'Блокнот', x: 10, y: 20 }, {});
  assert.equal(res.ok, true);
  assert.match(res.summary, /Блокнот/);
});

// Только Windows: тот же скрипт дважды подряд в одном живом PowerShell (Add-Type второй раз не мешает,
// процесс не закрывается). В вывод теста идёт замер: новый процесс против живого. Нажатия нет: окна не существует.
test('мышь в живом PowerShell: два вызова подряд, процесс жив; замер против нового процесса', { skip: !win, timeout: 90000 }, async (t) => {
  const env = {
    JARVIS_MOUSE_WINDOW: `нет-такого-окна-${Date.now()}`, JARVIS_MOUSE_X: '1', JARVIS_MOUSE_Y: '1', JARVIS_MOUSE_ACTION: 'left',
    JARVIS_MOUSE_DELTA: '0', JARVIS_MOUSE_UNITS: 'shot', JARVIS_UI_SELF_PID: String(process.pid),
  };
  const t0 = Date.now();
  const cold = await runPowerShell(SCRIPT, env, { timeoutMs: 30000 });
  const coldMs = Date.now() - t0;
  const host = createPsHost();
  try {
    const first = await host.run(SCRIPT, env, { timeoutMs: 30000 });
    const t1 = Date.now();
    const warm = await host.run(SCRIPT, env, { timeoutMs: 30000 });
    const warmMs = Date.now() - t1;
    for (const r of [cold, first, warm]) {
      assert.equal(r.ok, true, r.summary);
      assert.equal(r.hostDied, undefined);
      assert.match(String(r.data.stdout), /"status"\s*:\s*"no_window"/);
    }
    t.diagnostic(`мышь, окно не найдено: новый powershell.exe ${coldMs} мс, живой PowerShell ${warmMs} мс`);
  } finally {
    host.close();
  }
});
