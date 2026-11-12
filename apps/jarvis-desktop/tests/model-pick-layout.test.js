'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);
const appDir = path.resolve(__dirname, '..');
const electron = process.platform === 'win32' ? require('electron') : null;

test('меню модели и обдумывания целиком доступно в окне Nox', {
  skip: electron ? false : 'нужно настольное приложение Windows',
}, async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'nox-model-pick-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const shots = process.env.NOX_PICK_SHOTS || output;
  const env = { ...process.env, TMP: output, TEMP: output };
  delete env.ELECTRON_RUN_AS_NODE;

  for (const [width, height] of [[864, 520], [1200, 720]]) {
    await t.test(`${width}×${height}`, async () => {
      const { stdout } = await run(electron, [
        'scripts/nox-shot.js', '--width', String(width), '--height', String(height),
        '--out', path.join(shots, `model-pick-${width}x${height}.png`),
        '--check-model-pick', '--wait', '350',
      ], { cwd: appDir, env, timeout: 45000, windowsHide: true });
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('NOX_SHOT_RESULT '));
      assert.ok(line, stdout);
      const result = JSON.parse(line.slice('NOX_SHOT_RESULT '.length));
      assert.deepEqual([result.imageWidth, result.imageHeight], [width, height]);
      const menu = result.modelPick;
      assert.ok(menu.expanded);
      assert.ok(menu.inside, `меню выходит за пределы чата, справа: ${menu.rightOverflow}px`);
      assert.deepEqual(menu.options.map(({ value }) => value), ['fast', 'smart', 'low', 'medium', 'high']);
      assert.ok(menu.options.every(({ reachable }) => reachable), JSON.stringify(menu.options));
    });
  }
});
