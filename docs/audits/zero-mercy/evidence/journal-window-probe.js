'use strict';

// Electron entry point. The caller runs write and read in distinct processes with the same fresh profile.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { app, globalShortcut, ipcMain, nativeTheme } = require('electron');

const mode = process.argv[2];
const workRoot = path.resolve(__dirname, 'electron-temp', process.argv[3] || '');
const restartStart = mode === 'restart-abrupt' || mode === 'restart-clean';
const restartProbe = restartStart || mode === 'restart-read';
if (!['write', 'read', 'approval', 'approval-ipc', 'system', 'retry', 'record', 'restart-abrupt', 'restart-clean', 'restart-read'].includes(mode) ||
    !/^journal-window-[a-z0-9-]+$/.test(process.argv[3] || '')) {
  throw new Error('Expected an audit mode and a journal-window-* profile name');
}
const appRoot = path.resolve(__dirname, '../../../../apps/jarvis-desktop');
const data = path.join(workRoot, 'data');
const profile = path.join(workRoot, 'profile');
const log = path.join(data, 'journal.jsonl');
const output = path.join(workRoot, mode + '.json');
for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = data;
if (mode !== 'read' && mode !== 'restart-read') {
  fs.mkdirSync(workRoot);
  fs.mkdirSync(data);
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    voice: false, backgroundModelRuns: false, alwaysListen: false, dictation: false,
    desktopOverlay: false, alwaysOnTop: false, motion: false, seededBrief: true,
    clipboardHistory: false, quiet: true, keepAwake: 'off',
    ...(mode === 'retry' ? { mode: 'auto' } : mode === 'record' || restartStart ? { mode: 'ask' } : {}),
  }));
}
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
require(path.join(appRoot, 'src/config/paths.js')).projectRoot = () => workRoot;

let broker;
const retryEvents = [];
const retryPrompt = 'Сохрани отчёт аудита, затем проверь следующий пункт.';
const retryArgs = { path: 'reports/audit-retry.txt', content: 'Один фиктивный отчёт для аудита.\n' };
const recordPrompt = 'Подготовь пробную запись для проверки черновика.';
const recordArgs = { path: 'reports/audit-record-refused.txt', content: 'Этот фиктивный файл не должен появиться.\n' };
const restartPrompt = 'Подготовь пробную запись для проверки перезапуска.';
const restartArgs = { path: 'reports/audit-restart-unapproved.txt', content: 'Действие требует согласия.\n' };
let restartModelCalls = 0;
if (mode === 'retry' || mode === 'record' || restartProbe) {
  const { StubBrain } = require(path.join(appRoot, 'src/brain/stub.js'));
  const original = StubBrain.prototype.chat;
  StubBrain.prototype.chat = async function (request) {
    const messages = request.messages || [];
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const text = lastUser?.content;
    const expected = restartProbe ? restartPrompt : mode === 'retry' ? retryPrompt : recordPrompt;
    if (typeof text !== 'string' || (text !== expected && !text.endsWith('\n' + expected))) {
      return original.call(this, request);
    }
    const last = messages.at(-1);
    if (mode === 'record' || restartProbe) {
      if (restartProbe) restartModelCalls += 1;
      const id = restartProbe ? 'audit-restart-unapproved' : 'audit-record-refuse';
      const args = restartProbe ? restartArgs : recordArgs;
      return last?.role === 'tool' ? { content: 'Пробный ход завершён.', toolCalls: [] }
        : { content: '', toolCalls: [{ id, name: 'workspace_write', args }] };
    }
    if (last?.role === 'tool') {
      retryEvents.push({ type: 'fixture-failure-after-tool', toolResult: last.content });
      throw new Error('Сбой фиктивной модели после записи отчёта');
    }
    const id = 'audit-retry-' + (retryEvents.filter(({ type }) => type === 'fixture-write').length + 1);
    retryEvents.push({ type: 'fixture-write', user: text.split('\n').at(-1), args: retryArgs, id });
    return { content: '', toolCalls: [{ id, name: 'workspace_write', args: retryArgs }] };
  };
}
const intercepted = [];
let releaseStalledReply;
if (mode === 'approval-ipc') {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => handle(channel, channel === 'approval:respond'
    ? (event, id, decision) => {
      intercepted.push({ id, decision });
      if (id === 'audit-ipc-fail') throw new Error('Synthetic IPC failure before responding');
      if (id === 'audit-ipc-stall') {
        return new Promise((_resolve, reject) => {
          releaseStalledReply = () => reject(new Error('Release synthetic IPC failure'));
        });
      }
      return handler(event, id, decision);
    } : handler);
}
if (mode === 'approval' || mode === 'approval-ipc') {
  const approvalModule = require(path.join(appRoot, 'src/policy/approvals.js'));
  approvalModule.ApprovalBroker = class extends approvalModule.ApprovalBroker {
    constructor(options) {
      super(options);
      if (typeof options?.onAutoCancel === 'function') broker = this;
    }
  };
}

const start = performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (n, summary, extra = {}) => ({
  ts: new Date(Date.UTC(2026, 10, 10, 0, 0, n)).toISOString(),
  tool: 'workspace_read', risk: 'T0', decision: 'allow', ok: true, summary, ...extra,
});
const recordedTheme = `(() => {
  const root = document.documentElement;
  const state = (name) => JSON.parse(localStorage.getItem('jarvis.' + name) || 'null');
  return { theme: state('theme'), accent: state('accent'), look: state('look'),
    resolved: root.dataset.theme, systemLight: matchMedia('(prefers-color-scheme: light)').matches,
    bg: getComputedStyle(root).getPropertyValue('--bg').trim(),
    appBg: getComputedStyle(document.querySelector('.app')).backgroundColor };
})()`;

async function auditApproval(win, js, when) {
  const { Agent } = require(path.join(appRoot, 'src/agent/loop.js'));
  const wc = win.webContents;
  const effects = [];
  const events = [];
  const consoleErrors = [];
  wc.on('console-message', (details) => {
    if (details.level === 'error') consoleErrors.push(details.message);
  });
  function startAgent(id, marker) {
    const tool = {
      name: 'audit_fixture_effect', risk: 'T2', description: 'In-memory audit fixture',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async run({ text }) {
        effects.push({ id, text });
        return { ok: true, summary: 'In-memory effect only' };
      },
    };
    let turn = 0;
    return new Agent({
      brain: { async chat() {
        return turn++ === 0
          ? { content: '', toolCalls: [{ id, name: tool.name, args: { text: marker } }] }
          : { content: 'fixture finished', toolCalls: [] };
      } },
      tools: { get: (name) => name === tool.name ? tool : null, list: () => [tool] },
      approvals: broker, policy: () => 'ask', mode: 'full',
      journal: { append() {} },
      emit(event) {
        events.push({ marker, type: event.type, id: event.id || null });
        // The same channel as main.js sendToWindow, with all agent events including rejected tool_result.
        wc.send('agent:event', event);
      },
    }).run('Isolated approval fixture');
  }
  if (!broker) throw new Error('Application approval broker missing');
  const isOpen = 'document.querySelector("#approvalDialog").open';
  const snapshot = `(() => {
    const dialog = document.querySelector('#approvalDialog');
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return { open: dialog.open, text: document.querySelector('#apQuestion').innerText,
      arguments: document.querySelector('#apArgs').textContent,
      focus: document.activeElement?.getAttribute('data-decision') || document.activeElement?.id,
      countdown: document.querySelector('#apCountdown')?.innerText,
      width: innerWidth, height: innerHeight, left, right, top, bottom };
  })()`;
  win.setContentSize(864, 520);
  if (mode === 'approval-ipc') {
    const pendingIds = () => broker.list().map(({ id }) => id);
    const buttons = 'Array.from(document.querySelectorAll("#approvalDialog [data-decision]"), b => b.disabled)';
    const openLastPending = async () => {
      await when('Boolean(document.querySelector(".act-row[data-status=pending] button"))');
      await js('[...document.querySelectorAll(".act-row[data-status=pending] button")].at(-1).click()');
      await when(isOpen);
    };
    const clickOnce = () => js('document.querySelector("#approvalDialog [data-decision=once]").click()');
    const toastText = () => js('[...document.querySelectorAll("[role=status], [role=alert], .toast")].filter(e => e.getClientRects().length).map(e => e.innerText).filter(Boolean)');
    const failRun = startAgent('audit-ipc-fail', 'audit-failed-bridge');
    await openLastPending();
    await clickOnce();
    await sleep(180);
    const failed = { pending: pendingIds(), dialog: await js(snapshot), messages: await toastText() };
    await js('document.querySelector("#approvalDialog").close()');
    await js('[...document.querySelectorAll(".act-row[data-status=pending] button")].at(-1)?.click()');
    failed.afterReopen = { pending: pendingIds(), dialog: await js(snapshot), messages: await toastText() };
    broker.cancel('audit-ipc-fail', 'audit cleanup');
    await failRun;
    await js('document.querySelector("#approvalDialog").close()');

    const stallRun = startAgent('audit-ipc-stall', 'audit-stalled-bridge');
    await openLastPending();
    await clickOnce();
    await when(`(${buttons}).every(Boolean)`);
    const stalled = { afterClick: { pending: pendingIds(), dialog: await js(snapshot), buttons: await js(buttons) } };
    await stallRun;
    stalled.afterExpiry = { pending: pendingIds(), dialog: await js(snapshot), buttons: await js(buttons),
      reason: broker.closedReason('audit-ipc-stall') };
    await js('document.querySelector("#approvalDialog").close()');
    const nextRun = startAgent('audit-ipc-next', 'audit-next-after-stall');
    await openLastPending();
    await clickOnce();
    await sleep(180);
    stalled.next = { pending: pendingIds(), dialog: await js(snapshot), buttons: await js(buttons),
      calls: intercepted.slice(), effects: effects.slice() };
    releaseStalledReply();
    await sleep(100);
    await clickOnce();
    await nextRun;
    return { failed, stalled, effects, calls: intercepted, events, consoleErrors };
  }
  await js('document.querySelector("#chatInput").focus()');
  const baselineStart = performance.now();
  const baselineRun = startAgent('audit-baseline', 'audit-baseline-approval');
  await sleep(700);
  const baseline = {
    dialog: await js(snapshot),
    legacyNavExists: await js('Boolean(document.querySelector(\'[data-nav="dialog"]\'))'),
    pending: broker.list().map(({ id, args, autoCancelAt }) => ({ id, args, autoCancelAt })),
    rendererErrors: consoleErrors.slice(),
  };
  fs.writeFileSync(path.join(workRoot, 'approval-baseline-864.png'), (await wc.capturePage()).toPNG());
  await baselineRun;
  baseline.expired = { ms: performance.now() - baselineStart, reason: broker.closedReason('audit-baseline'),
    pending: broker.list().length, dialog: await js(snapshot), effects: effects.slice() };

  const openManually = async () => {
    await when('Boolean(document.querySelector(".act-row[data-status=pending] button"))');
    await js('document.querySelector(".act-row[data-status=pending] button").click()');
    await when(isOpen);
  };
  const closeForNextCase = () => js('document.querySelector("#approvalDialog").close()');
  const keyboardRun = startAgent('audit-keyboard', 'audit-fake-secret-for-display-only');
  await openManually();
  await js('document.querySelector("#apDetails").open = true');
  const keyboard = { initial: await js(snapshot) };
  fs.writeFileSync(path.join(workRoot, 'approval-864.png'), (await wc.capturePage()).toPNG());
  for (const [keyCode, modifiers] of [['Tab', []], ['Tab', ['shift']], ['Escape', []]]) {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(80);
    keyboard[keyCode + modifiers.join()] = await js(snapshot);
  }
  await keyboardRun;
  keyboard.effects = effects.slice();
  keyboard.afterSettlement = await js(snapshot);
  keyboard.pending = broker.list().length;
  await closeForNextCase();

  const observed = startAgent('audit-observe-collision', 'audit-visible-first');
  await openManually();
  const observedFirst = await js(snapshot);
  const next = startAgent('audit-observe-collision', 'audit-hidden-second');
  await sleep(250);
  const afterSettling = await js(snapshot);
  const pendingAfterSettling = broker.list().map(({ id, args }) => ({ id, args }));
  broker.cancel('audit-observe-collision', 'audit cleanup');
  await Promise.all([observed, next]);
  await closeForNextCase();

  const first = startAgent('audit-race-collision', 'audit-visible-race-first');
  await openManually();
  await js(`window.jarvis.onEvent((ev) => {
    if (ev.type !== 'approval_request' || ev.id !== 'audit-race-collision' ||
        ev.args?.text !== 'audit-hidden-race-second') return;
    const dialog = document.querySelector('#approvalDialog');
    window.auditClick = { open: dialog.open, text: document.querySelector('#apQuestion').innerText };
    if (dialog.open) dialog.querySelector('[data-decision="once"]').click();
  }); true`);
  const second = startAgent('audit-race-collision', 'audit-hidden-race-second');
  await sleep(300);
  const click = await js('window.auditClick || null');
  const collisionEffects = effects.slice();
  broker.cancel('audit-race-collision', 'audit cleanup');
  await Promise.all([first, second]);

  return { baseline, keyboard, observedFirst, afterSettling, pendingAfterSettling, click, collisionEffects, events, consoleErrors };
}

async function probe(win) {
  const wc = win.webContents;
  const js = (source) => wc.executeJavaScript(source, true);
  const when = async (source) => {
    for (let i = 0; i < 160; i++) {
      const value = await js(source);
      if (value) return value;
      await sleep(50);
    }
    throw new Error('Timed out on ' + source);
  };
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const view = async (name) => {
    await click(`[data-nav="${name}"]`);
    await when(`document.body.dataset.view === ${JSON.stringify(name)}`);
  };
  const search = (q) => js(`(() => {
    const input = document.querySelector('#histSearch');
    input.value = ${JSON.stringify(q)};
    const start = performance.now();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { ms: performance.now() - start, rows: document.querySelector('#histBody').childElementCount,
      message: document.querySelector('#histEmpty').hidden ? null : document.querySelector('#histEmptyText').innerText };
  })()`);
  const currentTheme = () => js(recordedTheme);
  const submit = (text) => js(`(() => {
    const input = document.querySelector('#chatInput');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chatSend').click();
  })()`);
  await when('Boolean(window.JarvisNox && window.jarvis && document.querySelector("#histSearch"))');
  const readyMs = performance.now() - start;
  const result = { mode, pid: process.pid, readyMs, electron: process.versions.electron,
    chromium: process.versions.chrome, initialTheme: await currentTheme() };
  if (mode === 'approval' || mode === 'approval-ipc') {
    result.approval = await auditApproval(win, js, when);
  } else if (restartProbe) {
    if (restartStart) {
      await submit(restartPrompt);
      await when('Boolean(document.querySelector(".act-row[data-status=pending] button"))');
      await js('document.querySelector(".act-row[data-status=pending] button").click()');
      await when('document.querySelector("#approvalDialog").open');
    } else {
      await sleep(800);
    }
    const readRows = (file) => fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    result.restart = {
      modelCalls: restartModelCalls,
      ui: await js(`({ dialog: document.querySelector('#approvalDialog').open,
        pendingRows: document.querySelectorAll('.act-row[data-status=pending]').length,
        lastChat: document.querySelector('#feed')?.innerText.slice(-1200) || '' })`),
      fileExists: fs.existsSync(path.join(workRoot, 'workspace', restartArgs.path)),
      journal: readRows(log),
      turns: readRows(path.join(data, 'turns.jsonl')),
      deals: await js('window.jarvis.dealsList()'),
    };
  } else if (mode === 'record') {
    await view('commands');
    await click('#cmdRecord');
    await when('!document.querySelector("#cmdRecordPanel").hidden');
    await view('nox');
    await submit(recordPrompt);
    await when('Boolean(document.querySelector(".act-row[data-status=pending] button"))');
    const before = await js('window.jarvis.recordState()');
    const rejected = await js('window.jarvis.respondApproval("audit-record-refuse", "reject")');
    await when('document.querySelector("#chatStop").hidden');
    await view('commands');
    const recorder = await js('window.jarvis.recordState()');
    await click('#cmdRecordStop');
    await when('!document.querySelector("#cmdEditor").hidden');
    result.record = { before, rejected, recorder,
      fileExists: fs.existsSync(path.join(workRoot, 'workspace', recordArgs.path)),
      journal: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .filter(({ callId }) => callId === 'audit-record-refuse'),
      draft: await js(`({ count: document.querySelector('#cmdStepCount').innerText,
        text: document.querySelector('#cmdSteps').innerText })`),
    };
    fs.writeFileSync(path.join(workRoot, 'record-refused-draft.png'), (await wc.capturePage()).toPNG());
  } else if (mode === 'retry') {
    await submit(retryPrompt);
    await when('document.querySelectorAll(".err-block button").length === 1 && document.querySelector("#chatStop").hidden');
    const workspace = path.join(workRoot, 'workspace');
    const target = path.join(workspace, retryArgs.path);
    const fileContent = fs.readFileSync(target, 'utf8');
    await js('document.querySelector(".err-block button").click()');
    await when('document.querySelectorAll(".err-block button").length === 2 && document.querySelector("#chatStop").hidden');
    const records = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const written = records.filter(({ tool }) => tool === 'workspace_write');
    result.retry = { fileContent, afterRetry: fs.readFileSync(target, 'utf8'), events: retryEvents,
      writes: written.map(({ runId, callId, ok, status, verifiedStatus, summary }) => ({ runId, callId, ok, status, verifiedStatus, summary })),
      errorTexts: await js('[...document.querySelectorAll(".err-block")].map((el) => el.innerText)'),
      fixtureFiles: fs.readdirSync(workspace, { recursive: true }),
    };
    fs.writeFileSync(path.join(workRoot, 'retry.png'), (await wc.capturePage()).toPNG());
  } else if (mode === 'system') {
    await view('settings');
    await click('[data-theme-opt="system"]');
    await when('JSON.parse(localStorage.getItem("jarvis.theme")) === "system"');
    result.nativeSwitch = [];
    try {
      for (const theme of ['light', 'dark', 'light']) {
        // Electron override for this process only. Windows preferences stay untouched.
        nativeTheme.themeSource = theme;
        await sleep(500);
        result.nativeSwitch.push({ requested: theme, nativeDark: nativeTheme.shouldUseDarkColors,
          renderer: await currentTheme() });
      }
    } finally {
      nativeTheme.themeSource = 'system';
    }
    result.mediaEmulation = [];
    const ownDebugger = !wc.debugger.isAttached();
    if (ownDebugger) wc.debugger.attach('1.3');
    try {
      for (const theme of ['light', 'dark', 'light']) {
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: theme }],
        });
        await sleep(350);
        await view('journal');
        const journal = await currentTheme();
        await view('nox');
        result.mediaEmulation.push({ requested: theme, journal, nox: await currentTheme() });
      }
    } finally {
      if (ownDebugger) wc.debugger.detach();
    }
  } else if (mode === 'read') {
    await view('settings');
    result.afterOpeningSettings = await currentTheme();
    result.journalRowsAfterRestart = (await js('window.jarvis.recentJournal(200)')).length;
    result.saved = JSON.parse(fs.readFileSync(path.join(workRoot, 'write.json'), 'utf8')).savedTheme;
    result.sameThemeAccentLook = ['theme', 'accent', 'look'].every((key) =>
      JSON.stringify(result.saved[key]) === JSON.stringify(result.afterOpeningSettings[key]));
    result.savedThemeAndAppearance = result.sameThemeAccentLook && result.saved.theme === 'light' &&
      result.saved.accent === '#CC3388' && result.saved.look?.ui === 'book';
  } else {
    await view('journal');
    await when('!document.querySelector("#histEmpty").hidden');
    result.empty = await js('document.querySelector("#histEmptyText").innerText');

    // Keep one distinctive entry outside the visible tail, plus explicit status fixtures.
    const records = Array.from({ length: 50000 }, (_, i) => row(i, 'Журнал аудита ' + i));
    records[10].summary = 'audit-unique-old-marker';
    records.at(-1).summary = 'audit-unique-recent-marker';
    records[records.length - 2] = row(49998, 'audit-unverified-marker', { risk: 'T2', status: 'unverified', verifiedStatus: 'unverified' });
    records[records.length - 3] = row(49997, 'audit-confirmed-marker', { risk: 'T2', status: 'confirmed', verified: 'confirmed', evidence: 'Безопасное фиктивное доказательство' });
    records[records.length - 4] = row(49996, 'audit-stop-marker', { risk: 'T2', decision: 'stop', status: 'failed', ok: false });
    fs.writeFileSync(log, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    result.records = records.length;
    result.bytes = fs.statSync(log).size;
    const reloadStart = performance.now();
    await click('#histReload');
    result.visibleRows = await when('document.querySelector("#histBody").childElementCount');
    result.reloadMs = performance.now() - reloadStart;
    result.counter = await js('document.querySelector("#histCount").innerText');
    result.statuses = await js(`Object.fromEntries([...document.querySelectorAll('#histBody tr')]
      .filter((tr) => /audit-(unverified|confirmed|stop)-marker/.test(tr.innerText))
      .map((tr) => [tr.querySelector('.jt-sum span').innerText, { key: tr.dataset.status, label: tr.querySelector('.jt-status').innerText,
        evidence: tr.querySelector('.jt-evidence')?.innerText || null }]))`);
    result.recentSearch = await search('audit-unique-recent-marker');
    result.oldSearch = await search('audit-unique-old-marker');
    result.oldBridgeSearch = await js(`(async () => {
      const start = performance.now();
      const out = await window.jarvis.journalSearch({ query: 'audit-unique-old-marker', limit: 10 });
      return { ms: performance.now() - start, ok: out.ok, total: out.total,
        matches: (out.items || []).map((entry) => entry.summary) };
    })()`);
    await search('');
    await click('#statusFilter [data-value="unverified"]');
    result.unverifiedFilter = await js('({ rows: document.querySelector("#histBody").childElementCount, message: document.querySelector("#histEmptyText").innerText })');
    await click('#statusFilter [data-value="confirmed"]');
    result.confirmedFilter = await js('document.querySelector("#histBody").childElementCount');
    await click('#statusFilter [data-value="all"]');
    result.layouts = [];
    for (const [width, height] of [[864, 520], [960, 640], [1200, 720], [1600, 900]]) {
      win.setContentSize(width, height);
      await sleep(160);
      const layout = await js(`(() => {
        const card = document.querySelector('#journalCard');
        const filters = card.querySelector('.filters').getBoundingClientRect();
        const table = card.querySelector('.table-wrap');
        const rect = table.getBoundingClientRect();
        const page = card.closest('.view');
        page.scrollTop = 600;
        const scrollTop = page.scrollTop;
        page.scrollTop = 0;
        return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
          filterRight: filters.right, tableRight: rect.right, tableScrollWidth: table.scrollWidth,
          tableClientWidth: table.clientWidth, pageScrollTop: scrollTop };
      })()`);
      result.layouts.push(layout);
      if (width === 864 || width === 1200) {
        fs.writeFileSync(path.join(workRoot, `journal-${width}.png`), (await wc.capturePage()).toPNG());
      }
    }
    await view('settings');
    await click('[data-theme-opt="light"]');
    await when('document.documentElement.dataset.theme === "light"');
    await js(`(() => {
      const hex = document.querySelector('.accent-hex');
      const select = document.querySelector('select[data-look-key="ui"]');
      if (!hex || !select) throw new Error('Missing appearance controls');
      hex.value = '#CC3388';
      hex.dispatchEvent(new Event('change', { bubbles: true }));
      select.value = 'book';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(300);
    result.savedTheme = await currentTheme();
    result.recentIpcMs = [];
    for (let i = 0; i < 5; i++) {
      result.recentIpcMs.push(await js(`(async () => {
        const start = performance.now();
        const entries = await window.jarvis.recentJournal(200);
        return { ms: performance.now() - start, rows: entries.length };
      })()`));
    }
  }
  result.processes = app.getAppMetrics().map(({ type, cpu, memory }) => ({
    type, cpuPercent: cpu.percentCPUUsage, workingSetKiB: memory.workingSetSize,
  }));
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify({ mode, output, pid: process.pid }) + '\n');
  if (mode === 'restart-abrupt') app.exit(0);
  else app.quit();
}

const fail = (error) => {
  console.error(error.stack || error);
  app.exit(1);
};
app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => probe(win).catch(fail));
});
app.whenReady().then(() => require(path.join(appRoot, 'main.js'))).catch(fail);
setTimeout(() => fail(new Error('Audit timeout')), 60000).unref();
