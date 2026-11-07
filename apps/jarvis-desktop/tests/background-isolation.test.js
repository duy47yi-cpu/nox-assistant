'use strict';

// Фон и Telegram не наследуют «Полный доступ»: файловые инструменты у них от индекса, всегда внутри рабочей папки.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');
const { withOwnWorkspace, autonomousTools } = require('../src/tools/profiles');

test('в полном доступе фоновый инструмент чтения не открывает файл вне рабочей папки', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bg-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bg-out-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const secretFile = path.join(outside, 'секрет.txt');
  fs.writeFileSync(secretFile, 'чужой файл', 'utf8');

  // Общий индекс в «Полном доступе», как в main.js, и веб-инструмент, который есть у фона.
  const shared = new WorkspaceIndex(root);
  shared.unrestricted = true;
  const webFetch = { name: 'web_fetch', risk: 'T0', description: 'веб', parameters: {}, run: async () => ({ ok: true }) };
  const baseList = [...workspaceTools(shared), webFetch];
  const readOf = (list) => list.find((tool) => tool.name === 'workspace_read');

  // Для проверки: в полном доступе общий инструмент действительно читает файл снаружи.
  const leaked = await readOf(baseList).run({ path: secretFile });
  assert.equal(leaked.ok, true, 'общий индекс в полном доступе читает снаружи (это и есть утечка)');

  // Фон: собственный индекс, не unrestricted.
  const background = autonomousTools(withOwnWorkspace(baseList, workspaceTools(new WorkspaceIndex(root))));
  const res = await readOf(background).run({ path: secretFile });
  assert.equal(res.ok, false);
  assert.match(res.summary, /вне рабочей папки/);
  assert.ok(background.some((tool) => tool.name === 'web_fetch'), 'остальные инструменты фона на месте');
  assert.equal(background.filter((tool) => tool.name === 'workspace_read').length, 1, 'файловые инструменты не дублируются');
});

test('withOwnWorkspace: общие workspace_* заменяются, остальные инструменты остаются', () => {
  const list = [{ name: 'workspace_read' }, { name: 'volume_set' }, { name: 'workspace_write' }];
  const own = [{ name: 'workspace_read', own: true }];
  const out = withOwnWorkspace(list, own);
  assert.deepEqual(out.map((t) => t.name), ['volume_set', 'workspace_read']);
  assert.equal(out[1].own, true);
});
