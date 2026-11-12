'use strict';

// Сквозная интеграционная проверка С4: MissionScheduler (в т.ч. при выключенных миссиях модели),
// WatchNotifier -> события рабочего стола и зависших окон, перезапуск/восстановление, отмена/дубликаты/ошибки,
// не-обход подтверждений, контракт IPC/preload/main/UI и dev-stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { CommandStore, CommandRunLog, EVENT_CATALOG } = require('../src/commands/store');
const { UnifiedCommandLauncher } = require('../src/commands/runner');
const { MissionScheduler } = require('../src/missions/scheduler');
const { MissionStore } = require('../src/missions/store');
const { WatchNotifier } = require('../src/notify/watch');
const { StopSwitch } = require('../src/control/stop');
const { ApprovalBroker } = require('../src/policy/approvals');
const policyModes = require('../src/policy/modes');
const { ToolRegistry } = require('../src/tools/registry');
const CmdSteps = require('../renderer/cmd-steps');

function makeTempDir(t, prefix = 'nox-c4-e2e-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeTestTools() {
  const calls = [];
  const registry = new ToolRegistry();
  registry.register({
    name: 'volume_set',
    risk: 'T1',
    parameters: { type: 'object', properties: { percent: { type: 'number' } }, required: ['percent'] },
    run: async (args) => {
      calls.push({ tool: 'volume_set', args });
      return { ok: true, verified: true, summary: `громкость ${args.percent}%` };
    },
  });
  registry.register({
    name: 'speak',
    risk: 'T0',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async (args) => {
      calls.push({ tool: 'speak', args });
      if (String(args.text).includes('FAIL')) {
        return { ok: false, verified: false, summary: 'ошибка озвучки по проверке' };
      }
      return { ok: true, verified: true, summary: `сказано: ${args.text}` };
    },
  });
  registry.register({
    name: 'file_delete',
    risk: 'T3',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async (args) => {
      calls.push({ tool: 'file_delete', args });
      return { ok: true, verified: true, summary: 'удалено' };
    },
  });
  return { registry, calls };
}

test('E2E: MissionScheduler при backgroundModelRuns=false (missionsEnabled=false) НЕ запускает миссии модели, НО запускает команды по расписанию', async (t) => {
  const dir = makeTempDir(t);
  let nowMs = Date.parse('2026-11-12T08:59:00');
  const now = () => new Date(nowMs);

  const mStore = new MissionStore(path.join(dir, 'missions.json'));
  mStore.add({ goal: 'Фоновая миссия с моделью', schedule: { type: 'daily', at: '08:00' } }, new Date('2026-11-11T07:00:00'));

  const cStore = new CommandStore(path.join(dir, 'commands.json'));
  const runLog = new CommandRunLog(path.join(dir, 'command-runs.json'));
  const { registry, calls } = makeTestTools();
  const cmd = cStore.save({
    name: 'Утреннее приветствие',
    phrases: ['утреннее приветствие'],
    steps: [{ tool: 'speak', args: { text: 'Доброе утро' } }],
    triggers: {
      hotkey: { enabled: false, key: null },
      schedule: { enabled: true, type: 'daily', at: '09:00' },
      event: { enabled: false, eventType: 'app:startup' },
    },
  }, { now: now() });

  let modelRuns = 0;
  const launcher = new UnifiedCommandLauncher({
    store: cStore,
    runLog,
    now,
    depsProvider: () => ({
      tools: registry,
      policy: policyModes,
      approvals: new ApprovalBroker(),
      journal: { append: () => {} },
      workspace: dir,
      mode: 'ask',
    }),
  });

  const scheduler = new MissionScheduler({
    store: mStore,
    run: async () => { modelRuns += 1; return { report: 'ok', verdict: 'done' }; },
    missionsEnabled: () => false,
    commandLauncher: launcher,
    now,
  });

  // До 09:00 команда ещё не созрела, миссия модели отключена.
  const firstCount = await scheduler.tick();
  assert.equal(firstCount, 0);
  assert.equal(modelRuns, 0);
  assert.equal(calls.length, 0);

  // В 09:01 команда запускается, а миссия модели всё равно не запускается.
  nowMs = Date.parse('2026-11-12T09:01:00');
  const secondCount = await scheduler.tick();
  assert.equal(secondCount, 1);
  assert.equal(modelRuns, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'speak');
  assert.equal(calls[0].args.text, 'Доброе утро');

  const saved = cStore.get(cmd.id);
  assert.equal(saved.triggerState.lastStatus, 'succeeded');
  assert.equal(runLog.list({ commandId: cmd.id }).length, 1);
});

test('E2E: WatchNotifier onFresh пробрасывает новые файлы inbox и зависшие окна Windows в UnifiedCommandLauncher с дедупликацией', async (t) => {
  const dir = makeTempDir(t);
  let nowMs = Date.parse('2026-11-12T10:00:00Z');
  const now = () => new Date(nowMs);

  const cStore = new CommandStore(path.join(dir, 'commands.json'));
  const runLog = new CommandRunLog(path.join(dir, 'command-runs.json'));
  const { registry, calls } = makeTestTools();
  const launcher = new UnifiedCommandLauncher({
    store: cStore,
    runLog,
    now,
    depsProvider: () => ({
      tools: registry,
      policy: policyModes,
      approvals: new ApprovalBroker(),
      journal: { append: () => {} },
      workspace: dir,
      mode: 'ask',
    }),
  });

  const cmdInbox = cStore.save({
    name: 'Входящий отчёт',
    phrases: ['входящий отчёт'],
    steps: [{ tool: 'speak', args: { text: 'Пришёл отчёт' } }],
    triggers: {
      event: { enabled: true, eventType: 'workspace:inbox_added', match: 'report', cooldownSec: 0 },
    },
  }, { now: now() });

  const cmdHung = cStore.save({
    name: 'Реакция на зависание',
    phrases: ['зависло окно'],
    steps: [{ tool: 'speak', args: { text: 'Окно не отвечает' } }],
    triggers: {
      event: { enabled: true, eventType: 'app:hung', cooldownSec: 0 },
    },
  }, { now: now() });

  let inboxFiles = ['old-before-start.txt'];
  let hungApps = [];

  const watch = new WatchNotifier({
    now,
    settings: () => ({ quiet: true }),
    sources: {
      inbox: () => inboxFiles.slice(),
      apps: () => hungApps.slice(),
      tasks: () => [],
      missions: () => [],
      cost: () => null,
    },
    channels: {
      window: { available: () => false, send: async () => {} },
      telegram: { available: () => false, send: async () => {} },
    },
    onFresh: async (fresh) => {
      for (const item of fresh) {
        if (item.kind === 'inbox') {
          await launcher.fireEvent('workspace:inbox_added', { file: item.detail, name: item.detail, eventId: item.key });
        } else if (item.kind === 'app-hung') {
          await launcher.fireEvent('app:hung', { name: item.detail, detail: item.detail, eventId: item.key });
        }
      }
    },
  });

  // 1-й проход: только запоминает стартовое состояние (_primed), существующий файл не запускает команду.
  await watch.tick();
  assert.equal(calls.length, 0);

  // 2-й проход: файл без совпадения фильтра match ('notes.txt') команду не запускает.
  nowMs += 60000;
  inboxFiles = ['old-before-start.txt', 'notes.txt'];
  await watch.tick();
  assert.equal(calls.length, 0);

  // 3-й проход: появляются подходящий файл report.pdf и зависшее окно pid=4321.
  nowMs += 60000;
  inboxFiles = ['old-before-start.txt', 'notes.txt', 'report.pdf'];
  hungApps = [{ pid: 4321, name: 'notepad', hung: true }];
  await watch.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.text, 'Пришёл отчёт');
  assert.equal(calls[1].args.text, 'Окно не отвечает');

  // 4-й проход: те же активные элементы больше не запускают команды повторно.
  nowMs += 60000;
  await watch.tick();
  assert.equal(calls.length, 2);
  assert.equal(runLog.list({ commandId: cmdInbox.id }).length, 1);
  assert.equal(runLog.list({ commandId: cmdHung.id }).length, 1);
});

test('E2E: восстановление после сбоя, сохранение дедупликации/ошибок/стопа и запрет обхода подтверждений через автозапуск после рестарта', async (t) => {
  const dir = makeTempDir(t);
  const cmdFile = path.join(dir, 'commands.json');
  const logFile = path.join(dir, 'command-runs.json');
  let nowMs = Date.parse('2026-11-12T11:00:00');
  const now = () => new Date(nowMs);

  // Сессия 1: сохраняем команды (опасная на авто-событии, обычная на событии, ошибочная на клавише), имитируем сбой.
  const s1 = new CommandStore(cmdFile);
  const l1 = new CommandRunLog(logFile);
  const crashedCmd = s1.save({
    name: 'Прерванная команда',
    phrases: ['прерванная'],
    steps: [{ tool: 'speak', args: { text: 'Шаг' } }],
    triggers: { event: { enabled: true, eventType: 'app:startup', cooldownSec: 60 } },
  }, { now: now() });
  s1.markTriggerStart(crashedCmd.id, { trigger: 'event', occurrenceKey: 'event:boot-1', now: now() });

  const bypassAttempt = s1.save({
    name: 'Автоудаление',
    phrases: ['автоудаление'],
    steps: [{ tool: 'file_delete', args: { path: 'secret.txt' } }],
    triggers: { event: { enabled: true, eventType: 'system:unlock', cooldownSec: 0 } },
  }, { now: now() });

  const failingCmd = s1.save({
    name: 'Падающая по шагу',
    phrases: ['падающая'],
    steps: [{ tool: 'speak', args: { text: 'FAIL тест' } }],
    triggers: { hotkey: { enabled: true, key: 'Ctrl+Alt+9' } },
  }, { now: now() });

  // Сессия 2: новый экземпляр после перезапуска приложения.
  nowMs += 15000;
  const s2 = new CommandStore(cmdFile);
  const l2 = new CommandRunLog(logFile);
  const { registry, calls } = makeTestTools();
  const stopSwitch = new StopSwitch(path.join(dir, 'stop.json'));
  let askCalled = 0;
  const approvals = {
    request: async () => { askCalled += 1; return 'allow'; },
    respond: () => true,
  };

  const launcher2 = new UnifiedCommandLauncher({
    store: s2,
    runLog: l2,
    stop: stopSwitch,
    now,
    allowInteractiveApprovalForAuto: false,
    depsProvider: () => ({
      tools: registry,
      policy: policyModes,
      approvals,
      journal: { append: () => {} },
      workspace: dir,
      mode: 'full',
    }),
  });
  const scheduler2 = new MissionScheduler({
    store: new MissionStore(path.join(dir, 'missions.json')),
    run: async () => ({ report: 'ok', verdict: 'done' }),
    missionsEnabled: () => false,
    commandLauncher: launcher2,
    stop: stopSwitch,
    now,
  });

  // Сверка на старте: оборванная команда отмечается interrupted без слепого повтора.
  await scheduler2.reconcile();
  const afterCrash = s2.get(crashedCmd.id);
  assert.equal(afterCrash.triggerState.lastStatus, 'interrupted');
  assert.equal(calls.length, 0);

  // Попытка повторного срабатывания с тем же occurrenceKey 'event:boot-1' после перезапуска отклоняется дедупликацией.
  const dupOut = await launcher2.fireEvent('app:startup', { eventId: 'boot-1' });
  assert.equal(dupOut.ran, 0);
  assert.equal(dupOut.results[0].status, 'skipped');
  assert.match(dupOut.results[0].reason, /повторного запуска/);

  // Автозапуск опасного шага блокируется даже в режиме full.
  const blkOut = await launcher2.fireEvent('system:unlock', { eventId: 'unlock-1' });
  assert.equal(blkOut.ran, 0);
  assert.equal(blkOut.results[0].status, 'blocked');
  assert.equal(askCalled, 0);
  assert.equal(calls.length, 0);

  // Ошибка шага по горячей клавише честно пишется как failed.
  const errOut = await launcher2.fireHotkey('Ctrl+Alt+9');
  assert.equal(errOut.ok, false);
  assert.equal(errOut.status, 'failed');
  assert.match(errOut.reason, /ошибка/i);

  // Аварийный стоп отменяет повторную попытку и пишет причину.
  stopSwitch.trigger('проверка стопа');
  const stopOut = await launcher2.fireHotkey('Ctrl+Alt+9');
  assert.equal(stopOut.cancelled, true);
  assert.equal(stopOut.status, 'cancelled');
  assert.match(stopOut.reason, /аварийный стоп/);

  const overview = launcher2.launchOverview();
  assert.equal(overview.events.length, EVENT_CATALOG.length);
  assert.ok(overview.log.some((x) => x.commandId === crashedCmd.id && x.status === 'interrupted'));
  assert.ok(overview.log.some((x) => x.commandId === bypassAttempt.id && x.status === 'blocked'));
  assert.ok(overview.log.some((x) => x.commandId === failingCmd.id && x.status === 'failed'));
  assert.ok(overview.log.some((x) => x.commandId === failingCmd.id && x.status === 'cancelled'));
});

test('E2E: контракт IPC/preload/main/HTML/dev-stub для единой системы запусков С4 согласован', async () => {
  const appDir = path.resolve(__dirname, '..');
  const mainSrc = fs.readFileSync(path.join(appDir, 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(appDir, 'preload.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(appDir, 'renderer', 'index.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(appDir, 'renderer', 'app.js'), 'utf8');
  const devStubSrc = fs.readFileSync(path.join(appDir, 'renderer', 'dev-stub.js'), 'utf8');

  for (const channel of ['commands:triggers-update', 'commands:launch-overview', 'commands:trigger', 'commands:fire-event', 'commands:launch-clear']) {
    assert.ok(mainSrc.includes(`'${channel}'`), `main.js должен обрабатывать ${channel}`);
    assert.ok(preloadSrc.includes(`'${channel}'`), `preload.js должен пробрасывать ${channel}`);
  }
  for (const evName of ['system:lock', 'system:unlock', 'system:suspend', 'system:resume', 'app:startup', 'workspace:inbox_added', 'app:hung']) {
    assert.ok(mainSrc.includes(`'${evName}'`), `main.js должен подключать реальное событие ${evName}`);
  }
  assert.ok(mainSrc.includes('missionsEnabled:'), 'MissionScheduler должен различать AI-миссии и расписание команд');
  assert.ok(/missionScheduler\.start\(\)/.test(mainSrc), 'missionScheduler.start() должен вызываться для расписания команд');

  for (const id of ['tabLaunches', 'panelLaunches', 'launchMatrix', 'launchLogList', 'cmdTriggersSection', 'cmdTrHotkeyOn', 'cmdTrSchedOn', 'cmdTrEventOn', 'cmdHotkey']) {
    assert.ok(htmlSrc.includes(`id="${id}"`), `index.html должен содержать #${id}`);
  }
  for (const method of ['updateCommandTriggers', 'getCommandLaunches', 'triggerCommandLaunch', 'fireCommandEvent', 'clearCommandLaunchLog']) {
    assert.ok(appSrc.includes(method), `app.js должен использовать window.jarvis.${method}`);
  }

  // Прогоняем настоящий renderer/dev-stub.js в изолированном VM для проверки заглушки и матрицы без Electron.
  const dispatchedEvents = [];
  const win = {
    CmdSteps,
    location: { search: '', href: '' },
    jarvis: null,
    __jarvisStub: null,
  };
  vm.runInNewContext(devStubSrc, {
    window: win,
    location: win.location,
    console: { info: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    Math,
    Date,
    JSON,
  });
  assert.ok(win.jarvis);
  win.jarvis.onEvent((ev) => dispatchedEvents.push(ev));

  const triggersUp = await win.jarvis.updateCommandTriggers('cmd-1', {
    hotkey: { enabled: true, key: 'Ctrl+Alt+5' },
    schedule: { enabled: true, type: 'daily', time: '09:30' },
    event: { enabled: true, eventType: 'user:custom', eventName: 'morning' },
  });
  assert.equal(triggersUp.ok, true);
  assert.equal(triggersUp.command.hotkey, 'Ctrl+Alt+5');

  const fired = await win.jarvis.fireCommandEvent({ eventType: 'user:custom', eventName: 'morning' });
  assert.equal(fired.matched, 1);
  assert.equal(fired.ran, 1);

  const overview = await win.jarvis.getCommandLaunches();
  assert.equal(overview.ok, true);
  assert.ok(overview.log.some((entry) => entry.trigger === 'event' && entry.status === 'succeeded'));
  assert.ok(dispatchedEvents.some((ev) => ev && ev.type === 'commands:changed'));

  const matrix = CmdSteps.buildLaunchMatrix(overview.commands, overview.log);
  assert.equal(matrix.summary.withHotkey >= 1, true);
  assert.equal(matrix.summary.withSchedule >= 1, true);
  assert.equal(matrix.summary.withEvent >= 1, true);
});
