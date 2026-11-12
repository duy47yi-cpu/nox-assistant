'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { app, dialog, globalShortcut } = require('electron');

const label = process.argv[2] || '';
const size = Number(process.argv[3]);
const soakMinutes = Number(process.argv[4] || 0);
const uiTransfer = process.argv[5] === 'ui-transfer';
const gcCycles = process.argv[5] === 'gc-cycles';
if (!/^commands-load-[a-z0-9-]+$/.test(label) || ![100, 600, 10000].includes(size) ||
    !Number.isInteger(soakMinutes) || soakMinutes < 0 || soakMinutes > 30) {
  throw new Error('Expected commands-load-* 100|600|10000 [0–30 minutes]');
}
const appDir = path.resolve(__dirname, '../../../../apps/jarvis-desktop');
const root = path.join(__dirname, 'electron-temp', label);
const data = path.join(root, 'data');
const profile = path.join(root, 'profile');
const exported = path.join(root, 'exported-commands.json');
fs.mkdirSync(root);
fs.mkdirSync(data);
fs.mkdirSync(profile);

for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = data;
require(path.join(appDir, 'src/config/paths.js')).projectRoot = () => root;
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

// Stub only the system file selection. Both IPC handlers and all transfer code stay intact.
let saveSelection = exported;
let openSelection = exported;
let openCount = 0;
dialog.showSaveDialog = async () => ({ canceled: !saveSelection, filePath: saveSelection || undefined });
dialog.showOpenDialog = async () => {
  openCount++;
  return { canceled: !openSelection, filePaths: openSelection ? [openSelection] : [] };
};
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  voice: false, backgroundModelRuns: false, alwaysListen: false, dictation: false,
  desktopOverlay: false, alwaysOnTop: false, motion: true, seededBrief: true,
  clipboardHistory: false, quiet: true, keepAwake: 'off', city: '',
}));
const items = Array.from({ length: size }, (_, i) => {
  const tag = String(i).padStart(5, '0');
  return {
    id: 'audit-' + tag, name: 'Audit command ' + tag, phrases: ['audit phrase ' + tag],
    enabled: true, steps: [{ tool: 'wait', args: { ms: 1 } }],
  };
});
fs.writeFileSync(path.join(data, 'commands.json'), JSON.stringify({ items }));

const start = performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const fail = (err) => {
  write('failure.json', { error: String(err.stack || err), elapsedMs: performance.now() - start });
  console.error(err.stack || err);
  app.exit(1);
};

async function run(win) {
  const wc = win.webContents;
  const js = (source) => wc.executeJavaScript(source, true);
  const errors = [];
  wc.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  async function when(source, limit = 25000) {
    const t = performance.now();
    while (performance.now() - t < limit) {
      const value = await js(source);
      if (value) return value;
      await sleep(25);
    }
    throw new Error('Timed out on ' + source);
  }
  await when('document.body.dataset.view === "nox" && Boolean(window.jarvis)');
  const bootMs = performance.now() - start;
  win.setContentSize(1200, 720);
  const sizes = await js('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
  const bridgeCount = await js('window.jarvis.listCommands().then((items) => items.length)');
  if (bridgeCount < size) throw new Error(`Fixture has only ${bridgeCount} of ${size} commands`);
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const measure = (script) => js(`(async () => {
    const start = performance.now();
    ${script}
    const syncMs = performance.now() - start;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { syncMs, twoFramesMs: performance.now() - start,
      rows: document.querySelector('#cmdList')?.childElementCount || 0 };
  })()`);
  const search = (query) => measure(`const input = document.querySelector('#cmdSearch');
    input.value = ${JSON.stringify(query)}; input.dispatchEvent(new Event('input', { bubbles: true }));`);
  const cmdNav = () => js(`window.auditPreviousCommand = document.querySelector('#cmdList').firstElementChild;
    document.querySelector('[data-nav="commands"]').click(); true`);
  const chatNav = () => click('[data-nav="nox"]');
  const loaded = `(() => {
    const list = document.querySelector('#cmdList');
    const ready = list.childElementCount === ${bridgeCount} && document.querySelector('#cmdLoading').hidden
      && list.firstElementChild !== window.auditPreviousCommand;
    if (ready) delete window.auditPreviousCommand;
    return ready;
  })()`;

  const beforeList = performance.now();
  await cmdNav();
  const firstRows = await when(loaded);
  const listReadyMs = performance.now() - beforeList;
  const first = {
    noMatch: await search('nothing-matches-audit-xyz'),
    oneMatch: await search('Audit command 00042'),
    all: await search('Audit command'),
    reset: await search(''),
  };
  const openEditor = await measure('document.querySelector("#cmdNew").click();');
  openEditor.visible = await when('!document.querySelector("#cmdEditor").hidden');
  await click('#cmdCancel');
  await when('document.querySelector("#cmdEditor").hidden');
  const cycles = [];
  const count = uiTransfer ? 3 : size === 10000 ? 4 : 20;
  for (let i = 0; i < count; i++) {
    const chat = await measure('document.querySelector(\'[data-nav="nox"]\').click();');
    const t = performance.now();
    await cmdNav();
    await when(loaded);
    cycles.push({ chat, commandsMs: performance.now() - t });
  }
  const transfer = {};
  if (size !== 10000) {
    transfer.exported = await js('window.jarvis.exportCommands()');
    if (!transfer.exported.saved || !fs.existsSync(exported)) throw new Error('Export did not write its fixture');
    const source = JSON.parse(fs.readFileSync(exported, 'utf8'));
    transfer.bytes = fs.statSync(exported).size;
    transfer.fileKeys = Object.keys(source);
    transfer.commandCount = (source.commands || source.items || []).length;
    transfer.preview = await js(`(async () => {
      const result = await window.jarvis.pickCommandsImport();
      return { ok: result.ok, error: result.error || null, canceled: result.canceled || false,
        tokenIssued: Boolean(result.token), preview: result.preview ? {
          counts: result.preview.counts || null, applicable: result.preview.applicable,
        } : null };
    })()`);
  }
  if (uiTransfer) {
    const source = JSON.parse(fs.readFileSync(exported, 'utf8'));
    const name = 'Команда проверки импорта';
    const incoming = path.join(root, 'incoming-fixture.json');
    const malformed = path.join(root, 'malformed-fixture.json');
    const command = { ...source.commands[0], id: 'new-audit-import', name, phrases: ['проверка переноса каталога'] };
    fs.writeFileSync(incoming, JSON.stringify({ ...source, commands: [command] }));
    fs.writeFileSync(malformed, '{');
    saveSelection = path.join(root, 'ui-export.json');
    await click('#cmdExport');
    await when('document.querySelector("#toasts").innerText.includes("Команды сохранены в файл")');
    const uiExportCount = JSON.parse(fs.readFileSync(saveSelection, 'utf8')).commands.length;
    const stored = () => JSON.parse(fs.readFileSync(path.join(data, 'commands.json'), 'utf8')).items;
    const baseline = stored().length;
    const status = `({ open: document.querySelector('#cmdImportDialog').open,
      focused: document.activeElement?.id, summary: document.querySelector('#ciSummary').innerText })`;
    openSelection = null;
    const beforeCancel = openCount;
    await click('#cmdImport');
    await sleep(180);
    const canceledPicker = { ...await js(status), invoked: openCount > beforeCancel, storedCount: stored().length };
    openSelection = incoming;
    await js('document.querySelector("#cmdImport").focus()');
    await click('#cmdImport');
    await when('document.querySelector("#cmdImportDialog").open');
    const preview = await js(status);
    await click('#ciCancel');
    await when('!document.querySelector("#cmdImportDialog").open');
    const canceledPreview = { ...await js(status), storedCount: stored().length };
    await click('#cmdImport');
    await when('document.querySelector("#cmdImportDialog").open');
    await click('#ciApply');
    await when(`[...document.querySelectorAll("#cmdList .cmd-name")].some((button) => button.textContent === ${JSON.stringify(name)})`);
    const applied = { ...await js(status), storedCount: stored().length,
      matchingNames: stored().filter((item) => item.name === name).length };
    openSelection = malformed;
    await click('#cmdImport');
    await when('document.querySelector("#toasts").innerText.includes("Файл не подошёл")');
    const malformedInput = { ...await js(status), storedCount: stored().length,
      toast: await js('document.querySelector("#toasts").innerText') };
    transfer.ui = { baseline, uiExportCount, canceledPicker, preview, canceledPreview, applied, malformedInput };
  }
  const info = {
    size, bridgeCount, sizes, bootMs, firstRows, listReadyMs, first, openEditor, cycles, transfer,
    electron: process.versions.electron, os: os.release(), errors,
  };
  if (gcCycles) {
    const own = !wc.debugger.isAttached();
    if (own) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Performance.enable');
    const snapshot = async () => {
      const { metrics } = await wc.debugger.sendCommand('Performance.getMetrics');
      const keep = new Set(['Documents', 'Frames', 'JSEventListeners', 'Nodes', 'JSHeapUsedSize', 'JSHeapTotalSize']);
      return Object.fromEntries(metrics.filter(({ name }) => keep.has(name)).map(({ name, value }) => [name, value]));
    };
    await chatNav();
    info.gcCycles = [];
    for (let completed = 0; completed <= 60; completed += 20) {
      if (completed > 0) {
        for (let i = 0; i < 20; i++) {
          await cmdNav();
          await when(loaded);
          await chatNav();
        }
      }
      await sleep(500);
      const before = await snapshot();
      await wc.debugger.sendCommand('HeapProfiler.collectGarbage');
      await sleep(100);
      info.gcCycles.push({ completed, before, after: await snapshot() });
    }
    if (own) wc.debugger.detach();
  }
  write('bench.json', info);
  console.log(JSON.stringify({ label, size, bridgeCount, listReadyMs, searchAllMs: first.all.syncMs, transfer }));
  if (soakMinutes > 0) {
    const own = !wc.debugger.isAttached();
    if (own) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Performance.enable');
    const started = performance.now();
    const expected = soakMinutes * 6;
    const samplesFile = path.join(root, 'soak-samples.jsonl');
    async function sample(i) {
      const result = await wc.debugger.sendCommand('Performance.getMetrics');
      const keep = new Set(['Nodes', 'Documents', 'Frames', 'JSEventListeners', 'JSHeapUsedSize',
        'JSHeapTotalSize', 'LayoutCount', 'RecalcStyleCount', 'ScriptDuration', 'TaskDuration']);
      const web = Object.fromEntries(result.metrics.filter(({ name }) => keep.has(name)).map(({ name, value }) => [name, value]));
      const processes = app.getAppMetrics().map(({ type, pid, cpu, memory }) => ({
        type, pid, cpuPercent: cpu.percentCPUUsage, workingSetKiB: memory.workingSetSize,
      }));
      const state = await js('({ view: document.body.dataset.view, visibility: document.visibilityState })');
      const row = { i, elapsedMs: performance.now() - started, web, processes, state, focused: win.isFocused(), errors: errors.length };
      fs.appendFileSync(samplesFile, JSON.stringify(row) + '\n');
    }
    await chatNav();
    await sample(0);
    for (let i = 1; i <= expected; i++) {
      const wait = started + i * 10000 - performance.now();
      if (wait > 0) await sleep(wait);
      if (i % 30 === 0) {
        await cmdNav();
        await when(loaded);
        await chatNav();
        await sleep(300);
      }
      await sample(i);
    }
    if (own) wc.debugger.detach();
    write('soak-complete.json', { expectedSamples: expected + 1, durationMs: performance.now() - started, errors });
    console.log(JSON.stringify({ label, soakMinutes, complete: true }));
  }
  app.quit();
}

app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => run(win).catch(fail));
});
app.whenReady().then(() => require(path.join(appDir, 'main.js'))).catch(fail);
setTimeout(() => fail(new Error('Audit driver timed out')), (soakMinutes + 3) * 60000).unref();
