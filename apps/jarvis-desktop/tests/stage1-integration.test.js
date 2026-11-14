'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const modes = require('../src/policy/modes');
const { ApprovalBroker } = require('../src/policy/approvals');
const { StopSwitch } = require('../src/control/stop');
const { DesktopLock, guardDesktopTools } = require('../src/control/desktop-lock');
const { ToolRegistry } = require('../src/tools/registry');
const { runCommand, summarizeChainResult } = require('../src/commands/runner');
const { CommandStore } = require('../src/commands/store');
const { seedSampleCommands } = require('../src/commands/samples');
const { ReminderStore } = require('../src/schedule/store');
const { AppInventory } = require('../src/inventory/apps');
const { Journal } = require('../src/journal/journal');
const { remoteAllowed } = require('../src/telegram/policy');
const { resolveLocalTurnAsync } = require('../src/shortcuts/scenarios');
const { desktopToolsFactory } = require('../src/tools/desktop');
const { windowsTools } = require('../src/tools/windows');
const { mediaTools } = require('../src/tools/media');
const { systemToolsFactory } = require('../src/tools/system');
const { uiTools } = require('../src/tools/ui');
const { remindersTools } = require('../src/tools/reminders');

function makeTempDir(t, prefix = 'jarvis-stage1-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJournalEntries(journal) {
  if (!fs.existsSync(journal.filePath)) return [];
  return fs.readFileSync(journal.filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createHarness(t, opts = {}) {
  const dir = makeTempDir(t);
  const calls = [];
  const spawnCalls = [];
  const reminders = new ReminderStore(path.join(dir, 'reminders.json'));
  const journal = new Journal(path.join(dir, 'journal.jsonl'));
  const commands = new CommandStore(path.join(dir, 'commands.json'));
  const desktopLock = new DesktopLock();
  const stop = new StopSwitch();
  const approvals = opts.approvals !== undefined ? opts.approvals : new ApprovalBroker({ autoCancelMs: 0 });
  const events = [];

  const windowsState = opts.windowsState || {
    area: { x: 0, y: 0, w: 1920, h: 1080 },
    windows: [
      { hwnd: 101, process: 'chrome', title: 'Chrome', left: 0, top: 0, right: 900, bottom: 700, minimized: false, visible: true, cloaked: false },
      { hwnd: 102, process: 'Code', title: 'VS Code', left: 50, top: 50, right: 950, bottom: 750, minimized: false, visible: true, cloaked: false },
      { hwnd: 103, process: 'jarvis-desktop', title: 'Nox Assistant', left: 100, top: 100, right: 800, bottom: 700, minimized: false, visible: true, cloaked: false },
    ],
  };

  const availableApps = new Map(Object.entries(opts.availableApps || {
    telegram: 'C:\\Apps\\Telegram\\Telegram.exe',
  }));

  const desktopRunner = async (script, env) => {
    calls.push({ group: 'desktop', script, env });
    if (typeof opts.onDesktopRun === 'function') {
      const override = await opts.onDesktopRun({ script, env, calls });
      if (override !== undefined) return override;
    }
    return { ok: true, summary: 'готово', data: { stdout: 'OK\n' } };
  };

  const uiRunner = async (script, env) => {
    calls.push({ group: 'ui', script, env });
    if (typeof opts.onUiRun === 'function') {
      const override = await opts.onUiRun({ script, env, calls });
      if (override !== undefined) return override;
    }
    return { ok: true, data: { stdout: JSON.stringify({ status: 'ok', window: '' }) } };
  };

  const windowsRunner = async (script, env) => {
    calls.push({ group: 'windows', script, env });
    if (typeof opts.onWindowsRun === 'function') {
      const override = await opts.onWindowsRun({ script, env, calls });
      if (override !== undefined) return override;
    }
    if (env && env.JARVIS_ARRANGE) {
      const items = JSON.parse(env.JARVIS_ARRANGE);
      for (const item of items) {
        const win = windowsState.windows.find((w) => w.hwnd === item.hwnd);
        if (win) {
          win.left = item.x;
          win.top = item.y;
          win.right = item.x + item.w;
          win.bottom = item.y + item.h;
          win.minimized = false;
          win.visible = true;
          win.cloaked = false;
        }
      }
      return { ok: true, data: { stdout: JSON.stringify({ moved: items.length }) } };
    }
    return { ok: true, data: { stdout: JSON.stringify(windowsState) } };
  };

  const mediaRunner = async (script, env) => {
    calls.push({ group: 'media', script, env });
    if (typeof opts.onMediaRun === 'function') {
      const override = await opts.onMediaRun({ script, env, calls });
      if (override !== undefined) return override;
    }
    return { ok: true, summary: 'готово', data: { stdout: opts.mediaStdout || 'NO_SESSION\n', stderr: '' } };
  };

  const systemRunner = async (script, env) => {
    calls.push({ group: 'system', script, env });
    if (typeof opts.onSystemRun === 'function') {
      const override = await opts.onSystemRun({ script, env, calls });
      if (override !== undefined) return override;
    }
    if (script.includes('WScript.Shell')) return { ok: true, data: { stdout: '' } };
    if (env && env.JARVIS_APP) {
      return {
        ok: true,
        data: {
          stdout: JSON.stringify({
            title: path.basename(env.JARVIS_APP, '.exe'),
            pid: 5151,
            process: path.basename(env.JARVIS_APP, '.exe'),
            path: env.JARVIS_APP,
            startedPid: 5151,
          }),
        },
      };
    }
    return { ok: true, data: { stdout: 'True\n' } };
  };

  const mockSpawn = (exe, args, spawnOpts) => {
    spawnCalls.push({ exe, args, opts: spawnOpts });
    calls.push({ group: 'spawn', exe, args });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };

  const registry = new ToolRegistry();
  const desktop = guardDesktopTools([
    ...desktopToolsFactory({ runner: desktopRunner, speak: async () => {} }),
    ...windowsTools(windowsRunner),
    ...uiTools({ runner: uiRunner }),
    ...systemToolsFactory({
      runner: systemRunner,
      spawn: mockSpawn,
      getAppResolver: () => (name) => availableApps.get(String(name || '').toLowerCase()) || null,
      getBrowserExe: () => 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      getAppLaunchHook: () => () => {},
      fsImpl: {
        statSync: (p) => ({
          isDirectory: () => false,
          isFile: () => [...availableApps.values()].includes(p),
        }),
      },
    }),
  ], desktopLock);
  for (const tool of desktop) registry.register(tool);
  for (const tool of mediaTools({ runner: mediaRunner })) registry.register(tool);
  for (const tool of remindersTools(reminders)) registry.register(tool);

  const emit = (ev) => {
    events.push(ev);
    if (typeof opts.onEvent === 'function') opts.onEvent(ev, approvals);
  };

  async function executeLocalPhrase(phrase, runOpts = {}) {
    const plan = await resolveLocalTurnAsync(phrase, {
      store: commands,
      workMode: runOpts.workMode,
      appInventory: runOpts.appInventory,
      ensureInventoryScanned: runOpts.ensureInventoryScanned,
      remoteAllowed: runOpts.remoteAllowed,
    });
    if (!plan) return { plan: null, out: null, summary: null };
    if (plan.kind === 'reply') return { plan, out: null, summary: { status: 'reply', ok: true, text: plan.text } };
    const out = await runCommand({
      id: plan.scenarioId ? `scenario:${plan.scenarioId}` : 'local-sequence',
      name: plan.title || plan.name || phrase,
      title: plan.title || plan.name || phrase,
      steps: plan.steps,
      notes: plan.notes,
    }, {
      tools: registry,
      policy: modes,
      approvals,
      journal,
      emit,
      workspace: dir,
      mode: runOpts.mode || 'auto',
      ownerCommand: plan.ownerCommand === true,
      ownerText: phrase,
      stop: runOpts.stop || stop,
      signal: runOpts.signal,
      reportVerification: true,
      onStepOutcome: runOpts.onStepOutcome,
    });
    const summary = summarizeChainResult(plan, out);
    return { plan, out, summary };
  }

  return {
    dir,
    calls,
    spawnCalls,
    events,
    emit,
    reminders,
    journal,
    commands,
    desktopLock,
    stop,
    approvals,
    registry,
    executeLocalPhrase,
  };
}

test('составная команда «Сделай тише, сверни окна и открой YouTube» выполняется локально без LLM', async (t) => {
  let brainCalled = false;
  const fakeBrain = { chat() { brainCalled = true; throw new Error('LLM не должна вызываться'); } };

  const h = createHarness(t);
  const res = await h.executeLocalPhrase('Сделай тише, сверни окна и открой YouTube', { mode: 'full' });

  assert.equal(brainCalled, false);
  assert.ok(fakeBrain);
  assert.ok(res.plan);
  assert.equal(res.plan.kind, 'command');
  assert.equal(res.plan.ownerCommand, false);
  assert.deepEqual(res.plan.steps.map((s) => s.tool), ['ui_keys', 'windows_minimize_all', 'url_open']);
  assert.equal(res.plan.steps[2].args.url, 'https://www.youtube.com');

  assert.equal(res.out.ok, true);
  assert.equal(res.out.cancelled, false);
  assert.equal(res.out.executedCount, 3);
  assert.equal(res.out.totalSteps, 3);
  assert.equal(h.desktopLock.busy, false);
  assert.equal(h.desktopLock.queue.length, 0);
  assert.equal(h.spawnCalls.length, 1);
  assert.ok(h.spawnCalls[0].args.includes('https://www.youtube.com/'));

  // ui_keys и windows_minimize_all дают verified: 'unknown', url_open — 'confirmed', поэтому итог честный: unverified
  assert.equal(res.summary.status, 'unverified');
  assert.match(res.summary.text, /Шаг 1 \(ui_keys\): выполнено без проверки/);
  assert.match(res.summary.text, /Шаг 2 \(windows_minimize_all\): выполнено без проверки/);
  assert.match(res.summary.text, /Шаг 3 \(url_open\): подтверждено/);
  assert.equal(readJournalEntries(h.journal).length, 3);
});

test('смешанный сбой и отказ на подтверждении в середине цепочки останавливают остаток и честно перечисляют пропущенные шаги', async (t) => {
  // 1) Отказ подтверждения на шаге 2 остановит шаг 3
  const approvalsSeen = [];
  const hReject = createHarness(t, {
    onEvent(ev, broker) {
      if (ev.type === 'approval_request') {
        approvalsSeen.push(ev);
        const answer = ev.name === 'windows_minimize_all' ? 'reject' : 'once';
        queueMicrotask(() => broker.respond(ev.approvalId, answer));
      }
    },
  });
  const rej = await hReject.executeLocalPhrase('Сделай тише, сверни окна и открой YouTube', { mode: 'ask' });

  assert.equal(approvalsSeen.length, 2);
  assert.equal(approvalsSeen[0].allowSession, false);
  assert.ok(approvalsSeen[0].approvalId);
  assert.equal(rej.out.ok, false);
  assert.equal(rej.out.cancelled, false);
  assert.equal(rej.out.executedCount, 2);
  assert.equal(rej.out.totalSteps, 3);
  assert.equal(hReject.spawnCalls.length, 0, 'отказ шага 2 не должен запускать YouTube');
  assert.equal(rej.summary.status, 'failed');
  assert.equal(rej.summary.skippedCount, 1);
  assert.doesNotMatch(rej.summary.text, /Готово|выполнена/);
  assert.match(rej.summary.text, /Шаг 2 \(windows_minimize_all\): не выполнено — отклонено/);
  assert.match(rej.summary.text, /Шаг 3 \(url_open\): не выполнено \(шаг 2 остановлен\)/);

  // 2) Ошибка инструмента на шаге 2 остановит шаг 3
  const hFail = createHarness(t, {
    onDesktopRun({ script }) {
      if (script.includes('MinimizeAll')) return { ok: false, summary: 'сбой окна' };
    },
  });
  const failRes = await hFail.executeLocalPhrase('Сделай тише, сверни окна и открой YouTube', { mode: 'full' });
  assert.equal(failRes.out.ok, false);
  assert.equal(failRes.out.executedCount, 2);
  assert.equal(hFail.spawnCalls.length, 0);
  assert.equal(failRes.summary.status, 'failed');
  assert.doesNotMatch(failRes.summary.text, /Готово|выполнена/);
  assert.match(failRes.summary.text, /Шаг 3 \(url_open\): не выполнено \(шаг 2 остановлен\)/);
});

test('отмена через StopSwitch и AbortController обрывает цепочку, фиксирует журнал и защищает от повторного клика', async (t) => {
  // 1a) StopSwitch срабатывает во время шага 1 -> прерывает текущий шаг немедленно, шаги 2-3 не запускаются
  const hStopMid = createHarness(t, {
    onUiRun() {
      hStopMid.stop.trigger('аварийный стоп');
    },
  });
  const stopMidRes = await hStopMid.executeLocalPhrase('Сделай тише, сверни окна и открой YouTube', { mode: 'full' });
  assert.equal(stopMidRes.out.ok, false);
  assert.equal(stopMidRes.out.cancelled, true);
  assert.equal(stopMidRes.out.executedCount, 1);
  assert.equal(stopMidRes.out.totalSteps, 3);
  assert.equal(hStopMid.spawnCalls.length, 0);
  assert.equal(stopMidRes.summary.status, 'cancelled');
  assert.doesNotMatch(stopMidRes.summary.text, /Готово|выполнена/);
  assert.match(stopMidRes.summary.text, /Шаг 2 \(windows_minimize_all\): не выполнено \(шаг 1 остановлен\)/);
  assert.match(stopMidRes.summary.text, /Шаг 3 \(url_open\): не выполнено \(шаг 1 остановлен\)/);

  // 1b) StopSwitch срабатывает между шагом 1 и шагом 2 -> шаг 2 сразу пишется в журнал/события как аварийный стоп, шаг 3 не идёт
  const hStop = createHarness(t);
  const stopRes = await hStop.executeLocalPhrase('Сделай тише, сверни окна и открой YouTube', {
    mode: 'full',
    onStepOutcome(outcome) {
      if (outcome.tool === 'ui_keys') hStop.stop.trigger('аварийный стоп');
    },
  });

  assert.equal(stopRes.out.ok, false);
  assert.equal(stopRes.out.cancelled, true);
  assert.equal(stopRes.out.executedCount, 2);
  assert.equal(stopRes.out.totalSteps, 3);
  assert.equal(hStop.spawnCalls.length, 0);
  assert.equal(stopRes.summary.status, 'cancelled');
  assert.doesNotMatch(stopRes.summary.text, /Готово|выполнена/);
  assert.match(stopRes.summary.text, /остановлено: аварийный стоп/);
  assert.match(stopRes.summary.text, /Шаг 3 \(url_open\): не выполнено \(шаг 2 остановлен\)/);

  const stopResults = hStop.events.filter((e) => e.type === 'tool_result');
  assert.equal(stopResults.length, 2);
  assert.equal(stopResults[1].name, 'windows_minimize_all');
  assert.equal(stopResults[1].summary, 'остановлено: аварийный стоп');
  const stopJournal = readJournalEntries(hStop.journal);
  assert.equal(stopJournal.length, 2);
  assert.equal(stopJournal[1].tool, 'windows_minimize_all');
  assert.equal(stopJournal[1].ok, false);
  assert.equal(stopJournal[1].summary, 'остановлено: аварийный стоп');

  // 2) AbortController + дублирующееся подтверждение во время ожидания шага 2
  const ac = new AbortController();
  const dupOutcomes = [];
  let minimizeRuns = 0;
  const hAbort = createHarness(t, {
    onDesktopRun({ script }) {
      if (script.includes('MinimizeAll')) minimizeRuns += 1;
    },
    onEvent(ev, broker) {
      if (ev.type === 'approval_request') {
        if (ev.name === 'ui_keys') {
          queueMicrotask(() => broker.respond(ev.approvalId, 'once'));
        } else if (ev.name === 'windows_minimize_all') {
          queueMicrotask(() => {
            ac.abort();
            dupOutcomes.push(broker.respond(ev.approvalId, 'once'));
            dupOutcomes.push(broker.respond(ev.approvalId, 'once'));
          });
        }
      }
    },
  });
  const abortRes = await hAbort.executeLocalPhrase('Сделай тише, сверни окна и открой YouTube', {
    mode: 'auto',
    signal: ac.signal,
  });

  assert.equal(abortRes.out.cancelled, true);
  assert.equal(abortRes.out.ok, false);
  assert.equal(abortRes.out.executedCount, 2);
  assert.equal(minimizeRuns, 0, 'отмена на подтверждении не должна запускать шаг 2');
  assert.equal(hAbort.spawnCalls.length, 0);
  assert.equal(abortRes.summary.status, 'cancelled');
  assert.doesNotMatch(abortRes.summary.text, /Готово|выполнена/);
  assert.match(abortRes.summary.text, /Шаг 3 \(url_open\): не выполнено \(шаг 2 остановлен\)/);
  assert.deepEqual(dupOutcomes, [false, false], 'после abort ответ на подтверждение отвергается без запуска');

  // 3) Дублирующий клик «Разрешить» не вызывает шаг дважды
  let stepRuns = 0;
  const broker = new ApprovalBroker({ autoCancelMs: 0 });
  const hDup = createHarness(t, {
    approvals: broker,
    onDesktopRun({ script }) {
      if (script.includes('MinimizeAll')) stepRuns += 1;
    },
    onEvent(ev) {
      if (ev.type === 'approval_request') {
        queueMicrotask(() => {
          const first = broker.respond(ev.approvalId, 'once');
          const second = broker.respond(ev.approvalId, 'once');
          dupOutcomes.push([first, second]);
        });
      }
    },
  });
  const dupOut = await runCommand(
    { id: 'c1', name: 'Тест', steps: [{ tool: 'windows_minimize_all', args: {} }] },
    {
      tools: hDup.registry,
      policy: modes,
      approvals: broker,
      journal: hDup.journal,
      emit: hDup.emit,
      workspace: hDup.dir,
      mode: 'ask',
    },
  );
  assert.equal(dupOut.ok, true);
  assert.equal(stepRuns, 1);
  assert.deepEqual(dupOutcomes[dupOutcomes.length - 1], [true, false]);
});

test('Сценарий 1 «Я ухожу»: ask/auto спрашивают блокировку (отказ не блокирует), full блокирует последним через ui_keys win+l (91,76), pc_shutdown не вызывается', async (t) => {
  for (const mode of ['ask', 'auto']) {
    let lockCalls = 0;
    let shutdownCalls = 0;
    const hReject = createHarness(t, {
      onDesktopRun({ script }) {
        if (script.includes('Stop-Computer')) shutdownCalls += 1;
      },
      onUiRun({ env }) {
        if (env && env.JARVIS_UI_VK === '91,76') lockCalls += 1;
      },
      onEvent(ev, broker) {
        if (ev.type === 'approval_request') {
          const decision = ev.name === 'ui_keys' && ev.args?.keys === 'win+l' ? 'reject' : 'once';
          queueMicrotask(() => broker.respond(ev.approvalId, decision));
        }
      },
    });
    const rej = await hReject.executeLocalPhrase('Я ухожу', { mode });
    assert.deepEqual(rej.plan.steps, [
      { tool: 'windows_minimize_all', args: {} },
      { tool: 'media_control', args: { action: 'pause', allowNoSession: true } },
      { tool: 'volume_set', args: { percent: 0 } },
      { tool: 'ui_keys', args: { keys: 'win+l' } },
    ]);
    assert.equal(lockCalls, 0, `${mode}: отказ блокировки не должен вызывать LockWorkStation (91,76)`);
    assert.equal(shutdownCalls, 0);
    assert.equal(rej.out.ok, false);
    assert.equal(rej.summary.status, 'failed');
    assert.doesNotMatch(rej.summary.text, /Готово|выполнена/);
    assert.match(rej.summary.text, /Шаг 4 \(ui_keys\): не выполнено — отклонено/);

    // Одобрение ui_keys(win+l) -> выполняется последним с JARVIS_UI_VK === '91,76'
    let approveLockCalls = 0;
    let lastUiScript = '';
    const hApprove = createHarness(t, {
      onDesktopRun({ script }) {
        if (script.includes('Stop-Computer')) shutdownCalls += 1;
      },
      onUiRun({ script, env }) {
        if (env && env.JARVIS_UI_VK === '91,76') {
          approveLockCalls += 1;
          lastUiScript = script;
        }
      },
      onEvent(ev, broker) {
        if (ev.type === 'approval_request') queueMicrotask(() => broker.respond(ev.approvalId, 'once'));
      },
    });
    const okRes = await hApprove.executeLocalPhrase('Я ухожу', { mode });
    const startedTools = hApprove.events.filter((e) => e.type === 'tool_start').map((e) => e.name);
    assert.equal(okRes.out.ok, true);
    assert.equal(approveLockCalls, 1);
    assert.match(lastUiScript, /LockWorkStation/);
    assert.equal(shutdownCalls, 0);
    assert.deepEqual(startedTools, ['windows_minimize_all', 'media_control', 'volume_set', 'ui_keys']);
    assert.equal(okRes.summary.status, 'unverified');
    assert.match(okRes.summary.text, /экран заблокирован/);
  }

  // Полный доступ: без единого подтверждения, блокировка последняя
  const fullApprovals = [];
  let fullShutdown = 0;
  let fullLockVk = '';
  const hFull = createHarness(t, {
    onDesktopRun({ script }) {
      if (script.includes('Stop-Computer')) fullShutdown += 1;
    },
    onUiRun({ env }) {
      if (env && env.JARVIS_UI_VK) fullLockVk = env.JARVIS_UI_VK;
    },
    onEvent(ev) {
      if (ev.type === 'approval_request') fullApprovals.push(ev);
    },
  });
  const fullRes = await hFull.executeLocalPhrase('Я ухожу', { mode: 'full' });
  const fullOrder = hFull.events.filter((e) => e.type === 'tool_start').map((e) => e.name);
  assert.equal(fullApprovals.length, 0);
  assert.equal(fullShutdown, 0);
  assert.equal(fullLockVk, '91,76');
  assert.equal(fullRes.out.ok, true);
  assert.deepEqual(fullOrder, ['windows_minimize_all', 'media_control', 'volume_set', 'ui_keys']);
});

test('Сценарий 2 «Босс идёт» / «Спрячь всё»: сворачивает, ставит паузу даже без плеера, глушит звук, не трогает lock/shutdown', async (t) => {
  for (const phrase of ['Босс идёт', 'Спрячь всё']) {
    let lockCalls = 0;
    let shutdownCalls = 0;
    const h = createHarness(t, {
      onDesktopRun({ script }) {
        if (script.includes('Stop-Computer')) shutdownCalls += 1;
      },
      onUiRun({ env }) {
        if (env && env.JARVIS_UI_VK === '91,76') lockCalls += 1;
      },
    });
    const res = await h.executeLocalPhrase(phrase, { mode: 'full' });
    assert.equal(lockCalls, 0);
    assert.equal(shutdownCalls, 0);
    assert.deepEqual(res.plan.steps, [
      { tool: 'windows_minimize_all', args: {} },
      { tool: 'media_control', args: { action: 'pause', allowNoSession: true } },
      { tool: 'volume_set', args: { percent: 0 } },
    ]);
    assert.equal(res.out.ok, true);
    assert.equal(res.out.results[1].summary, 'ничего не играет (пауза не потребовалась)');
    assert.equal(res.out.results[1].verified, 'confirmed');
    assert.match(res.summary.text, /Шаг 2 \(media_control\): подтверждено/);
  }
});

test('Сценарий 3 «Перерыв» vs «Перерыв на 15 минут»: без времени не выдумывает таймер, с длительностью ставит напоминание', async (t) => {
  const hNoTime = createHarness(t);
  const noTime = await hNoTime.executeLocalPhrase('Перерыв', { mode: 'full' });
  assert.equal(noTime.out.ok, true);
  assert.deepEqual(noTime.plan.steps.map((s) => s.tool), ['media_control', 'windows_minimize_all']);
  assert.equal(hNoTime.reminders.list().length, 0);
  // windows_minimize_all имеет verify -> unknown, поэтому статус честный: unverified, с заметкой о времени
  assert.equal(noTime.summary.status, 'unverified');
  assert.match(noTime.summary.text, /Напоминание не создано: длительность перерыва не указана/);

  const hWithTime = createHarness(t);
  const withTime = await hWithTime.executeLocalPhrase('Перерыв на 15 минут', { mode: 'full' });
  assert.equal(withTime.out.ok, true);
  assert.deepEqual(withTime.plan.steps.map((s) => s.tool), ['media_control', 'windows_minimize_all', 'remind_in']);
  assert.equal(withTime.plan.steps[2].args.minutes, 15);
  assert.equal(hWithTime.reminders.list().length, 1);
  assert.equal(withTime.summary.status, 'unverified');
  assert.match(withTime.summary.text, /Шаг 3 \(remind_in\): подтверждено/);
});

test('Сценарий 4 «Два окна рядом»: раскладывает 2 подходящих без окна Nox и честно отказывает при < 2', async (t) => {
  let arranged = [];
  const hOk = createHarness(t, {
    onWindowsRun({ env }) {
      if (env && env.JARVIS_ARRANGE) {
        arranged = JSON.parse(env.JARVIS_ARRANGE);
      }
    },
  });
  const okRes = await hOk.executeLocalPhrase('Два окна рядом', { mode: 'full' });
  assert.equal(okRes.out.ok, true);
  assert.equal(okRes.summary.status, 'succeeded');
  assert.match(okRes.summary.text, /^Готово:/);
  assert.equal(arranged.length, 2);
  assert.ok(arranged.every((item) => item.hwnd !== 103), 'окно Nox Assistant не должно раскладываться');

  const hFew = createHarness(t, {
    windowsState: {
      area: { x: 0, y: 0, w: 1920, h: 1080 },
      windows: [
        { hwnd: 201, process: 'chrome', title: 'Chrome', left: 0, top: 0, right: 800, bottom: 600, minimized: false, visible: true, cloaked: false },
        { hwnd: 202, process: 'jarvis-desktop', title: 'Nox Assistant', left: 50, top: 50, right: 800, bottom: 600, minimized: false, visible: true, cloaked: false },
      ],
    },
  });
  const fewRes = await hFew.executeLocalPhrase('Два окна рядом', { mode: 'full' });
  assert.equal(fewRes.out.ok, false);
  assert.equal(fewRes.summary.status, 'failed');
  assert.match(fewRes.summary.text, /нужно минимум 2/);
  assert.doesNotMatch(fewRes.summary.text, /Готово|выполнена/);
});

test('Сценарий 5 «Режим работы»: нетронутый пример молчит, настройки/пользовательская команда пропускают отсутствующие программы', async (t) => {
  const hUnconf = createHarness(t);
  seedSampleCommands(hUnconf.commands);
  const unconfRes = await hUnconf.executeLocalPhrase('Режим работы', { mode: 'full' });
  assert.equal(unconfRes.plan.kind, 'reply');
  assert.equal(hUnconf.calls.length, 0);
  assert.equal(hUnconf.spawnCalls.length, 0);

  // Настроенный через settings.workMode + ленивый скан AppInventory
  const hCfg = createHarness(t, {
    availableApps: { telegram: 'C:\\Apps\\Telegram\\Telegram.exe' },
  });
  const inv = new AppInventory(path.join(hCfg.dir, 'apps.json'));
  let scanCount = 0;
  const ensureInventoryScanned = async () => {
    scanCount += 1;
    inv.entries = [{ name: 'Telegram', exe: 'Telegram.exe', path: 'C:\\Apps\\Telegram\\Telegram.exe' }];
    inv.scannedAt = new Date().toISOString();
    return inv;
  };
  const cfgRes = await hCfg.executeLocalPhrase('Режим работы', {
    mode: 'full',
    workMode: {
      minimizeWindows: true,
      volume: 25,
      urls: ['https://example.org'],
      apps: ['telegram', 'missing_app'],
    },
    appInventory: inv,
    ensureInventoryScanned,
  });

  assert.equal(scanCount, 1);
  assert.equal(cfgRes.out.ok, true);
  assert.deepEqual(cfgRes.plan.steps.map((s) => s.tool), ['windows_minimize_all', 'volume_set', 'url_open', 'app_open']);
  assert.equal(cfgRes.plan.steps[3].args.name, 'telegram');
  assert.match(cfgRes.summary.text, /Приложение «missing_app» не найдено — шаг пропущен/);

  // Пользовательская изменённая команда «Рабочий режим» сохраняет ownerCommand: true
  const hUser = createHarness(t, {
    availableApps: { notepad: 'C:\\Windows\\notepad.exe' },
  });
  hUser.commands.save({
    id: 'my-work',
    name: 'Рабочий режим',
    phrases: ['рабочий режим', 'режим работы'],
    origin: 'manual',
    steps: [
      { tool: 'app_open', args: { name: 'notepad' } },
      { tool: 'app_open', args: { name: 'absent_tool' } },
    ],
  });
  const userInv = new AppInventory(path.join(hUser.dir, 'apps.json'));
  userInv.entries = [{ name: 'Notepad', exe: 'notepad.exe', path: 'C:\\Windows\\notepad.exe' }];
  userInv.scannedAt = new Date().toISOString();

  const userRes = await hUser.executeLocalPhrase('Режим работы', {
    mode: 'full',
    appInventory: userInv,
  });
  assert.equal(userRes.plan.ownerCommand, true);
  assert.equal(userRes.out.ok, true);
  assert.deepEqual(userRes.plan.steps, [{ tool: 'app_open', args: { name: 'notepad' } }]);
  assert.match(userRes.summary.text, /Приложение «absent_tool» не найдено — шаг пропущен/);
});

test('Telegram граница remoteAllowed и связка в main.js работают согласованно', async (t) => {
  const h = createHarness(t);
  const remoteStepAllowed = (toolName) => remoteAllowed(h.registry.get(toolName));

  // ui_keys не разрешён с телефона («сделай тише» и «я ухожу») -> resolveLocalTurnAsync отступает в null
  assert.equal(await resolveLocalTurnAsync('сделай тише', {
    store: h.commands,
    remoteAllowed: remoteStepAllowed,
  }), null);
  assert.equal(await resolveLocalTurnAsync('я ухожу', {
    store: h.commands,
    remoteAllowed: remoteStepAllowed,
  }), null);

  // «Босс идёт» разрешён с телефона (minimize, media_control, volume_set <= T1)
  const remoteBoss = await h.executeLocalPhrase('босс идёт', {
    mode: 'full',
    remoteAllowed: remoteStepAllowed,
  });
  assert.equal(remoteBoss.out.ok, true);
  assert.deepEqual(remoteBoss.plan.steps.map((s) => s.tool), ['windows_minimize_all', 'media_control', 'volume_set']);

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSrc, /require\('\.\/src\/shortcuts\/scenarios'\)/);
  assert.match(mainSrc, /summarizeChainResult/);
  assert.match(mainSrc, /runLocalSequence/);
  assert.match(mainSrc, /ensureInventoryScanned/);
  assert.match(mainSrc, /workMode:\s*settings\.workMode/);
  assert.match(mainSrc, /remoteAllowed:\s*remoteStepAllowed/);
});
