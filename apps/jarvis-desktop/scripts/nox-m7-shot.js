'use strict';

// Реальный рендерер и preload в отдельном окне Electron, с локальным стендом IPC.
// electron scripts/nox-m7-shot.js <папка снимков> before|after
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { checkEffect } = require('../src/agent/effects');
const { TurnPlans } = require('../src/agent/plan');
const { planTools } = require('../src/tools/plan');
const { WorkspaceIndex } = require('../src/rag');
const { workspaceTools } = require('../src/tools/workspace');
app.on('window-all-closed', () => {});

const [directory, phase] = process.argv.slice(2);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '..');

async function run() {
  assert.ok(directory && ['before', 'after'].includes(phase));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nox-m7-'));
  app.setPath('userData', temp);
  process.env.NOX_DATA_DIR = temp;
  let renderer = path.join(root, 'renderer');
  if (phase === 'before') {
    const baseline = path.join(temp, 'renderer');
    await fs.cp(renderer, baseline, { recursive: true });
    for (const file of ['nox-screen.js', 'nox-screen.css']) {
      await fs.writeFile(path.join(baseline, file), execFileSync('git',
        ['show', `HEAD:apps/jarvis-desktop/renderer/${file}`], { cwd: root }));
    }
    renderer = baseline;
  }
  await fs.mkdir(directory, { recursive: true });
  await app.whenReady();
  const history = [];
  const chat = { activeId: 'qa', chats: [{ id: 'qa', title: 'Отчёт по задачам', updatedAt: Date.now() }] };
  const handlers = {
    'chat:history': history, 'chat:list': chat, 'chat:new': chat,
    'state:get': { mode: 'normal', hasKey: true },
    'settings:get': { motion: false, voice: false }, 'account:state': { enabled: false },
  };
  const preload = path.join(root, 'preload.js');
  const bridge = await fs.readFile(preload, 'utf8');
  for (const channel of new Set([...bridge.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]))) {
    ipcMain.handle(channel, () => handlers[channel] ?? null);
  }
  const write = workspaceTools(new WorkspaceIndex(temp)).find(({ name }) => name === 'workspace_write');
  const args = { path: 'otchet.md', content: '# Сводка\n\nЗадачи за неделю собраны.\n' };
  const checked = await checkEffect(write, args, await write.run(args), {});
  assert.equal(checked.verified, 'confirmed');

  for (const [width, height] of [[1200, 720], [864, 520]]) {
    const win = new BrowserWindow({
      width, height, useContentSize: true, frame: false, show: false,
      focusable: false, skipTaskbar: true, webPreferences: { preload },
    });
    await win.loadFile(path.join(renderer, 'index.html'));
    await wait(450);
    win.showInactive();
    const runId = 'm7-' + width;
    const [set, done] = planTools(new TurnPlans());
    const steps = ['Собрать задачи за неделю', 'Сохранить сводку в файл', 'Перечитать и сверить сводку'];
    const send = (type, rest = {}) => win.webContents.send('agent:event', { type, runId, ...rest });
    const tool = (id, name, args, result) => {
      send('tool_start', { id, name, args, status: 'running' });
      send('tool_result', { id, ok: result.ok, summary: result.summary, verified: result.verified, evidence: result.evidence, status: 'succeeded' });
    };
    send('quick_user', { text: 'Собери задачи за неделю, сохрани и проверь сводку.' });
    send('status', { state: 'thinking', status: 'planning' });
    await wait(80);
    if (phase === 'after') assert.match(await win.webContents.executeJavaScript('document.querySelector(".nox-working").textContent'), /План пока не задан/);
    tool('p', set.name, { steps }, set.run({ steps }, { runId }));
    tool('d1', done.name, { step: 1 }, done.run({ step: 1, evidence: 'Список собран' }, { runId }));
    tool('w', 'workspace_write', {}, { ...checked, summary: 'Сводка сохранена' });
    tool('d2', done.name, { step: 2 }, done.run({ step: 2, evidence: checked.evidence }, { runId }));
    send('tool_start', { id: 'r', name: 'workspace_read', step: 5, status: 'running', target: { path: 'otchet.md' } });
    await wait(500);
    const state = () => win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.nox-working');
      const box = row?.getBoundingClientRect();
      return { text: row?.hidden ? '' : row?.innerText, visible: !!box && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight,
        pinned: !!row?.closest('#noxChatMount') && !row.closest('#feed'),
        w: innerWidth, h: innerHeight };
    })()`);
    const current = await state();
    assert.equal(current.w, width);
    assert.equal(current.h, height);
    if (phase === 'after') {
      assert.ok(current.visible && current.pinned, JSON.stringify(current));
      assert.match(current.text, /2 из 3/);
      assert.match(current.text, /Выполняется · Чтение файла/);
      assert.match(current.text, /otchet\.md совпадает с записью/);
      assert.match(current.text, /Перечитать и сверить сводку/);
    } else assert.match(current.text, /Ход работы/);
    const image = await win.webContents.capturePage();
    await fs.writeFile(path.join(directory, `${phase}-${width}x${height}.png`), image.toPNG());
    if (phase === 'after') {
      send('status', { state: 'acting', step: 5, status: 'verifying' });
      await wait(50);
      assert.match((await state()).text, /Проверка результата/);
      const details = await win.webContents.executeJavaScript(`(() => {
        document.querySelector('.nox-work-head button').click();
        const dialog = document.querySelector('.nox-work-dialog');
        const text = dialog.open && dialog.innerText;
        dialog.querySelector('button').click();
        return text;
      })()`);
      assert.match(details, /otchet\.md совпадает с записью/);
      send('status', { state: 'waiting_approval', status: 'awaiting_approval', step: 5 });
      await wait(50);
      assert.match((await state()).text, /Ждёт подтверждения/);
      send('done', { status: 'cancelled' });
      send('tool_result', { id: 'r', afterStop: true, ok: true, status: 'succeeded', verified: 'confirmed', evidence: 'Поздний итог' });
      await wait(50);
      assert.match((await state()).text, /Остановлено/);
      assert.doesNotMatch((await state()).text, /Поздний итог/);
      await win.webContents.executeJavaScript('window.JarvisNox.changeChat("chatNew")');
      assert.equal((await state()).text, '');
      for (const [status, label] of [['failed', 'Не получилось'], ['unverified', 'Результат не подтверждён'], ['succeeded', 'Ход завершён']]) {
        const runId = 'terminal-' + status;
        send('quick_user', { text: 'Проверь ещё раз', runId });
        send('status', { status: 'planning', runId });
        send('done', { status, runId });
        await wait(60);
        assert.ok((await state()).text.includes(label));
        assert.doesNotMatch((await state()).text, /Проверено|otchet\.md/);
      }
      send('quick_user', { text: 'Покажи восстановленный план', runId: 'resumed' });
      send('status', { status: 'planning', runId: 'resumed' });
      send('done', { status: 'unverified', plan: { total: 20, done: 14, unfinished: 6 }, runId: 'resumed' });
      await wait(60);
      assert.match((await state()).text, /14 из 20/);
      assert.match((await state()).text, /Названия шагов недоступны/);
    }
    console.log(phase, width, height, current);
    win.destroy();
  }
}

run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
