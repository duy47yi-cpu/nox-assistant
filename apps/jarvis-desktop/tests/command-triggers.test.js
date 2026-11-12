'use strict';

// Задача С4: единая система запусков команд (горячая клавиша, расписание через MissionScheduler,
// системное/пользовательское событие), журнал, защита от повторов, восстановление и запрет обхода подтверждений.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CommandStore,
  CommandRunLog,
  nextScheduleIso,
  exportCommandPack,
  previewCommandImport,
  applyCommandImport,
  EVENT_CATALOG,
} = require('../src/commands/store');
const { UnifiedCommandLauncher } = require('../src/commands/runner');
const { MissionStore } = require('../src/missions/store');
const { MissionScheduler } = require('../src/missions/scheduler');
const { ToolRegistry } = require('../src/tools/registry');
const policy = require('../src/policy/modes');
const { ApprovalBroker } = require('../src/policy/approvals');
const { Journal } = require('../src/journal/journal');
const { StopSwitch } = require('../src/control/stop');
const CmdSteps = require('../renderer/cmd-steps');

function setupEnv(t, { mode = 'ask', clockRef = { now: new Date('2026-11-13T08:00:00.000Z') }, stop = new StopSwitch(), allowInteractiveApprovalForAuto = false, hotkeyDebounceMs = 0, isBusy = null, notify = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-c4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = new CommandStore(path.join(dir, 'commands.json'));
  const runLog = new CommandRunLog(path.join(dir, 'command-runs.json'));
  const journal = new Journal(path.join(dir, 'journal.jsonl'));
  const tools = new ToolRegistry();
  const calls = [];
  let currentMode = mode;

  const reg = (name, risk = 'T0', impl = null, extra = {}) => {
    tools.register({
      name,
      description: name,
      risk,
      parameters: { type: 'object', properties: { ms: { type: 'number' }, path: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' } } },
      async run(args, ctx) {
        calls.push({ name, args, hasSignal: Boolean(ctx && ctx.signal) });
        if (typeof impl === 'function') return impl(args, ctx);
        return { ok: true, summary: `выполнен ${name}`, data: { ...args } };
      },
      ...extra,
    });
  };

  reg('wait', 'T0');
  reg('notify', 'T0');
  reg('windows_list', 'T0');
  reg('file_write', 'T1');
  reg('app_open', 'T2');
  reg('file_delete', 'T2');
  reg('app_install', 'T2');
  reg('click_pay', 'T2');
  reg('shell_run', 'T3');

  const approvals = new ApprovalBroker();
  const launcher = new UnifiedCommandLauncher({
    store,
    runLog,
    stop,
    now: () => clockRef.now,
    notify,
    isBusy,
    hotkeyDebounceMs,
    allowInteractiveApprovalForAuto,
    depsProvider: () => ({
      tools,
      policy,
      journal,
      workspace: dir,
      mode: currentMode,
      approvals,
      stop,
      emit: () => {},
    }),
  });

  return {
    dir,
    store,
    runLog,
    journal,
    tools,
    approvals,
    stop,
    calls,
    clockRef,
    launcher,
    setMode(m) { currentMode = m; },
    recreate(overrides = {}) {
      const store2 = new CommandStore(path.join(dir, 'commands.json'));
      const runLog2 = new CommandRunLog(path.join(dir, 'command-runs.json'));
      const launcher2 = new UnifiedCommandLauncher({
        store: store2,
        runLog: runLog2,
        stop: overrides.stop || stop,
        now: () => clockRef.now,
        notify: overrides.notify || notify,
        isBusy: overrides.isBusy !== undefined ? overrides.isBusy : isBusy,
        hotkeyDebounceMs,
        allowInteractiveApprovalForAuto,
        depsProvider: () => ({
          tools,
          policy,
          journal,
          workspace: dir,
          mode: currentMode,
          approvals: overrides.approvals || approvals,
          stop: overrides.stop || stop,
          emit: () => {},
        }),
      });
      return { store: store2, runLog: runLog2, launcher: launcher2 };
    },
  };
}

test('единая настройка и отключение каждого способа запуска без потери параметров', (t) => {
  const { store, clockRef } = setupEnv(t);
  const created = store.save({
    name: 'Утренний отчёт',
    phrases: ['утренний отчёт'],
    steps: [{ tool: 'wait', args: { ms: 10 } }],
    triggers: {
      hotkey: { enabled: true, key: 'Ctrl+Alt+R', cooldownMs: 500 },
      schedule: { enabled: true, type: 'daily', at: '09:00', timeZone: 'UTC' },
      event: { enabled: true, eventType: 'system:unlock', match: 'desk', cooldownSec: 15 },
    },
  }, { now: clockRef.now });

  assert.equal(created.hotkey, 'Control+Alt+R');
  assert.equal(created.triggers.hotkey.enabled, true);
  assert.equal(created.triggers.hotkey.key, 'Control+Alt+R');
  assert.equal(created.triggers.hotkey.cooldownMs, 500);
  assert.equal(created.triggers.schedule.enabled, true);
  assert.equal(created.triggers.schedule.at, '09:00');
  assert.equal(created.triggerState.nextRunAt, '2026-11-13T09:00:00.000Z');
  assert.equal(created.triggers.event.eventType, 'system:unlock');
  assert.equal(created.triggers.event.match, 'desk');

  // Отключаем горячую клавишу и расписание по отдельности — настройки остаются на месте.
  const disabledHk = store.updateTriggers(created.id, { hotkey: { enabled: false }, schedule: { enabled: false } }, { now: clockRef.now });
  assert.equal(disabledHk.hotkey, null, 'выключенная клавиша не регистрируется глобально');
  assert.equal(disabledHk.triggers.hotkey.enabled, false);
  assert.equal(disabledHk.triggers.hotkey.key, 'Control+Alt+R', 'сочетание клавиш сохранилось для повторного включения');
  assert.equal(disabledHk.triggers.schedule.enabled, false);
  assert.equal(disabledHk.triggers.schedule.at, '09:00');
  assert.equal(disabledHk.triggerState.nextRunAt, null);
  assert.equal(disabledHk.triggers.event.enabled, true, 'третий способ запуска остался включённым');

  // Включаем клавишу обратно без повторного ввода комбинации.
  const reEnabled = store.updateTriggers(created.id, { hotkey: { enabled: true } }, { now: clockRef.now });
  assert.equal(reEnabled.hotkey, 'Control+Alt+R');
  assert.equal(reEnabled.triggers.hotkey.enabled, true);
});

test('способ 1 — горячая клавиша: запуск, отключение, несуществующая и дебаунс', async (t) => {
  const { store, launcher, runLog, calls, clockRef } = setupEnv(t, { hotkeyDebounceMs: 400 });
  const cmd = store.save({
    name: 'Список окон',
    phrases: ['покажи окна'],
    steps: [{ tool: 'windows_list', args: {} }],
    triggers: { hotkey: { enabled: true, key: 'Ctrl+Alt+W' } },
  }, { now: clockRef.now });

  const first = await launcher.fireHotkey('ctrl+alt+w');
  assert.equal(first.ok, true);
  assert.equal(first.status, 'succeeded');
  assert.equal(calls.length, 1);

  // Повторное нажатие через 100 мс отсекается дебаунсом.
  clockRef.now = new Date(clockRef.now.getTime() + 100);
  const bounce = await launcher.fireHotkey('Control+Alt+W');
  assert.equal(bounce.ok, false);
  assert.equal(bounce.skipped, true);
  assert.match(bounce.reason, /слишком частое нажатие/);
  assert.equal(calls.length, 1);

  // После паузы снова срабатывает.
  clockRef.now = new Date(clockRef.now.getTime() + 500);
  const second = await launcher.fireHotkey('Control+Alt+W');
  assert.equal(second.ok, true);
  assert.equal(calls.length, 2);

  // Отключаем способ запуска по клавише и проверяем понятный пропуск в журнале.
  store.updateTriggers(cmd.id, { hotkey: { enabled: false } }, { now: clockRef.now });
  const off = await launcher.fireHotkey('Control+Alt+W');
  assert.equal(off.ok, false);
  assert.equal(off.skipped, true);
  assert.match(off.reason, /по горячей клавише выключен/);
  assert.equal(calls.length, 2);

  const logs = runLog.list({ commandId: cmd.id, limit: 10 });
  assert.equal(logs.length, 4);
  assert.equal(logs[0].status, 'skipped');
  assert.match(logs[0].reason, /по горячей клавише выключен/);
});

test('способ 2 — расписание по времени через единый MissionScheduler (без второго планировщика), будни и DST', async (t) => {
  const { dir, store, launcher, runLog, calls, clockRef } = setupEnv(t);
  const missionStore = new MissionStore(path.join(dir, 'missions.json'));
  let missionRuns = 0;

  const cmd = store.save({
    name: 'Каждые 15 мин',
    phrases: ['чек'],
    steps: [{ tool: 'notify', args: { text: 'тик' } }],
    triggers: { schedule: { enabled: true, type: 'interval', minutes: 15 } },
  }, { now: clockRef.now });

  // Сразу срок ещё не наступил.
  const scheduler = new MissionScheduler({
    store: missionStore,
    run: async () => { missionRuns += 1; return { report: 'ок', verdict: 'done' }; },
    commandLauncher: launcher,
    now: () => clockRef.now,
  });

  assert.equal(await scheduler.tick(), 0);
  assert.equal(calls.length, 0);

  // Переводим время на 15 минут вперёд — один и тот же MissionScheduler запускает команду.
  clockRef.now = new Date('2026-11-13T08:15:00.000Z');
  assert.equal(await scheduler.tick(), 1);
  assert.equal(calls.length, 1);
  assert.equal(missionRuns, 0);

  // Повторный tick на ту же секунду НЕ дублирует запуск.
  assert.equal(await scheduler.tick(), 0);
  assert.equal(calls.length, 1);

  const reloaded = store.get(cmd.id);
  assert.equal(reloaded.triggerState.nextRunAt, '2026-11-13T08:30:00.000Z');
  assert.equal(runLog.list({ commandId: cmd.id })[0].trigger, 'schedule');

  // Проверка расписания по будням (пятница -> следующий запуск в понедельник).
  const fridayEvening = new Date('2026-11-13T18:00:00.000Z');
  const nextWeekday = nextScheduleIso({ enabled: true, type: 'weekdays', at: '09:00', timeZone: 'UTC' }, fridayEvening);
  assert.equal(nextWeekday, '2026-11-16T09:00:00.000Z');

  // Проверка перехода на летнее время (Europe/Berlin весна: 02:30 несуществующего часа сдвигается корректно).
  const beforeDstSpring = new Date('2026-03-29T00:30:00.000Z');
  const springNext = nextScheduleIso({ enabled: true, type: 'daily', at: '02:30', timeZone: 'Europe/Berlin' }, beforeDstSpring);
  assert.ok(new Date(springNext).getTime() > beforeDstSpring.getTime());
});

test('способ 3 — системные и пользовательские события: фильтр, кулдаун, отключение и дедупликация eventId', async (t) => {
  const { store, launcher, runLog, calls, clockRef } = setupEnv(t);

  const unlockCmd = store.save({
    name: 'Приветствие',
    phrases: ['приветствие'],
    steps: [{ tool: 'notify', args: { text: 'с возвращением' } }],
    triggers: {
      event: { enabled: true, eventType: 'system:unlock', cooldownSec: 30 },
    },
  }, { now: clockRef.now });

  const customCmd = store.save({
    name: 'Обработка PDF',
    phrases: ['обработка pdf'],
    steps: [{ tool: 'wait', args: { ms: 5 } }],
    triggers: {
      event: { enabled: true, eventType: 'user:custom', eventName: 'файл готов', match: '.pdf', cooldownSec: 0 },
    },
  }, { now: clockRef.now });

  const disabledEventCmd = store.save({
    name: 'Отключённый отклик',
    phrases: ['отклик'],
    steps: [{ tool: 'wait', args: { ms: 5 } }],
    triggers: {
      event: { enabled: false, eventType: 'system:unlock' },
    },
  }, { now: clockRef.now });

  // Системное событие: одна команда выполняется, выключенная фиксирует пропуск.
  const evRes = await launcher.fireEvent('system:unlock', { eventId: 'ev-1' });
  assert.equal(evRes.matched, 2);
  assert.equal(evRes.ran, 1);
  assert.equal(calls.length, 1);
  assert.equal(runLog.list({ commandId: disabledEventCmd.id })[0].status, 'skipped');
  assert.match(runLog.list({ commandId: disabledEventCmd.id })[0].reason, /по событию выключен/);

  // Кулдаун 30 с блокирует частое повторное событие через 10 с.
  clockRef.now = new Date(clockRef.now.getTime() + 10000);
  const tooSoon = await launcher.fireEvent('system:unlock', { eventId: 'ev-2' });
  assert.equal(tooSoon.ran, 0);
  const tooSoonUnlock = tooSoon.results.find((r) => r.commandId === unlockCmd.id);
  assert.match(tooSoonUnlock.reason, /пауза после прошлого срабатывания/);

  // Через 35 с с другим eventId снова запускается, а повтор того же eventId 'ev-1' всё равно отсечён.
  clockRef.now = new Date(clockRef.now.getTime() + 25000);
  const replay = await launcher.fireEvent('system:unlock', { eventId: 'ev-1' });
  assert.equal(replay.ran, 0);
  const replayUnlock = replay.results.find((r) => r.commandId === unlockCmd.id);
  assert.match(replayUnlock.reason, /уже обработано/);

  const fresh = await launcher.fireEvent('system:unlock', { eventId: 'ev-3' });
  assert.equal(fresh.ran, 1);
  assert.equal(calls.length, 2);

  // Пользовательское событие с фильтром: неподходящий payload игнорируется, .pdf запускается.
  const wrongTarget = await launcher.fireEvent('user:файл готов', { target: 'notes.txt', eventId: 'u-1' });
  assert.equal(wrongTarget.matched, 0);
  const pdfTarget = await launcher.fireEvent('user:custom', { eventName: 'Файл готов', target: 'report.PDF', eventId: 'u-2' });
  assert.equal(pdfTarget.matched, 1);
  assert.equal(pdfTarget.ran, 1);
  assert.equal(calls.length, 3);
  assert.equal(runLog.list({ commandId: customCmd.id })[0].triggerDetail, 'своё «файл готов»');
  assert.ok(unlockCmd.id !== customCmd.id);
});

test('защита от повторных и параллельных запусков + занятость другого поручения', async (t) => {
  let releaseStep;
  let busy = false;
  const env = setupEnv(t, { isBusy: () => (busy ? 'сейчас идёт другое поручение' : false) });
  const { store, launcher, runLog, tools } = env;

  tools.register({
    name: 'slow_step',
    description: 'медленный шаг',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run() {
      await new Promise((resolve) => { releaseStep = resolve; });
      return { ok: true, summary: 'готово' };
    },
  });

  const cmd = store.save({
    name: 'Долгая команда',
    phrases: ['долгая'],
    steps: [{ tool: 'slow_step', args: {} }],
    triggers: {
      hotkey: { enabled: true, key: 'Control+Alt+L' },
      event: { enabled: true, eventType: 'app:startup', cooldownSec: 0 },
    },
  });

  const pending = launcher.fireHotkey('Control+Alt+L');
  await new Promise((r) => setTimeout(r, 15));

  // Пока команда выполняется, событие и вторая клавиша не запускают дубликат.
  const parallelEvent = await launcher.fireEvent('app:startup', { eventId: 'boot-1' });
  assert.equal(parallelEvent.ran, 0);
  assert.match(parallelEvent.results[0].reason, /уже выполняется/);

  const parallelHotkey = await launcher.fireHotkey('Control+Alt+L');
  assert.equal(parallelHotkey.skipped, true);
  assert.match(parallelHotkey.reason, /уже выполняется/);

  releaseStep();
  const done = await pending;
  assert.equal(done.ok, true);

  // Глобальная занятость тоже защищает от наложения.
  busy = true;
  const blockedByBusy = await launcher.fireHotkey('Control+Alt+L');
  assert.equal(blockedByBusy.skipped, true);
  assert.equal(blockedByBusy.reason, 'сейчас идёт другое поручение');

  const logStatuses = runLog.list({ commandId: cmd.id }).map((e) => e.status);
  assert.deepEqual(logStatuses, ['skipped', 'succeeded', 'skipped', 'skipped']);
});

test('отмена аварийным стопом (до и во время шага) и обработка ошибки шага', async (t) => {
  const env = setupEnv(t);
  const { store, launcher, runLog, stop, tools, clockRef } = env;

  let secondStepCalled = false;
  tools.register({
    name: 'abort_midway',
    description: 'прерывает стоп посередине',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run() {
      stop.trigger();
      return { ok: true, summary: 'шаг 1 завершён' };
    },
  });
  tools.register({
    name: 'after_abort',
    description: 'после стопа',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run() {
      secondStepCalled = true;
      return { ok: true, summary: 'не должен был дойти' };
    },
  });
  tools.register({
    name: 'boom',
    description: 'ломается',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run() {
      throw new Error('диск переполнен token=secret1234567890abcd');
    },
  });

  const stopCmd = store.save({
    name: 'Прерываемая',
    phrases: ['прерываемая'],
    steps: [{ tool: 'abort_midway', args: {} }, { tool: 'after_abort', args: {} }],
    triggers: { hotkey: { enabled: true, key: 'Control+Alt+B' }, schedule: { enabled: true, type: 'interval', minutes: 10 } },
  }, { now: clockRef.now });

  const midAbort = await launcher.fireHotkey('Control+Alt+B');
  assert.equal(midAbort.ok, false);
  assert.equal(midAbort.status, 'cancelled');
  assert.equal(secondStepCalled, false);
  assert.equal(store.get(stopCmd.id).triggerState.status, 'idle');

  // Повторный тик расписания при включённом стопе логирует отмену один раз и не спамит.
  clockRef.now = new Date(clockRef.now.getTime() + 10 * 60000);
  assert.equal((await launcher.tickScheduled()).ran, 0);
  clockRef.now = new Date(clockRef.now.getTime() + 60000);
  assert.equal((await launcher.tickScheduled()).ran, 0);
  const cancelledSchLogs = runLog.list({ commandId: stopCmd.id, trigger: 'schedule', status: 'cancelled' });
  assert.equal(cancelledSchLogs.length, 1);

  stop.reset();
  const boomCmd = store.save({
    name: 'Падающая',
    phrases: ['падающая'],
    steps: [{ tool: 'boom', args: {} }],
    triggers: { hotkey: { enabled: true, key: 'Control+Alt+F' } },
  }, { now: clockRef.now });

  const failed = await launcher.fireHotkey('Control+Alt+F');
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /ошибка/);
  assert.equal(failed.logEntry.error, '[скрыто]', 'секрет не попадает даже в журнал ошибок');
  assert.equal(store.get(boomCmd.id).triggerState.status, 'idle');
});

test('восстановление после перезапуска: interrupted без слепого повтора, просроченное daily (сон >12 ч), сохранение кулдауна и eventId', async (t) => {
  const notices = [];
  const env = setupEnv(t, { notify: (n) => notices.push(n) });
  const { store, calls, clockRef } = env;

  const interruptedCmd = store.save({
    name: 'Незавершённая команда',
    phrases: ['незавершённая'],
    steps: [{ tool: 'wait', args: { ms: 5 } }],
    triggers: { schedule: { enabled: true, type: 'interval', minutes: 30 } },
  }, { now: clockRef.now });

  // Имитируем падение прямо посреди выполнения слота 08:30.
  const crashTime = new Date('2026-11-13T08:30:00.000Z');
  store.markTriggerStart(interruptedCmd.id, {
    trigger: 'schedule',
    scheduledFor: '2026-11-13T08:30:00.000Z',
    occurrenceKey: `schedule:${interruptedCmd.id}:2026-11-13T08:30:00.000Z`,
    now: crashTime,
  });

  // Имитируем ежедневную команду на 09:00 и событие с кулдауном 60 с.
  const staleCmd = store.save({
    name: 'Устаревшая daily',
    phrases: ['устаревшая'],
    steps: [{ tool: 'notify', args: { text: 'утро' } }],
    triggers: { schedule: { enabled: true, type: 'daily', at: '09:00', timeZone: 'UTC' } },
  }, { now: clockRef.now });

  const cooldownCmd = store.save({
    name: 'Событие с памятью',
    phrases: ['память события'],
    steps: [{ tool: 'notify', args: { text: 'разблок' } }],
    triggers: { event: { enabled: true, eventType: 'system:unlock', cooldownSec: 60 } },
  }, { now: clockRef.now });

  // Команда сработала до перезапуска.
  await env.launcher.fireEvent('system:unlock', { eventId: 'evt-before-reboot' });
  assert.equal(calls.length, 1);

  // Рестарт через 20 секунд (но с просроченной daily пусть будет другой тест-шаг — проверим сначала +20 с!).
  clockRef.now = new Date('2026-11-13T08:30:20.000Z');
  const restarted = env.recreate({ notify: (n) => notices.push(n) });
  const sched = new MissionScheduler({ commandLauncher: restarted.launcher, now: () => clockRef.now });
  await sched.reconcile();

  const fixedInterrupted = restarted.store.get(interruptedCmd.id);
  assert.equal(fixedInterrupted.triggerState.status, 'idle');
  assert.equal(fixedInterrupted.triggerState.lastStatus, 'interrupted');
  assert.match(fixedInterrupted.triggerState.lastReason, /повторного запуска не было/);
  assert.equal(fixedInterrupted.triggerState.nextRunAt, '2026-11-13T09:00:00.000Z');
  assert.equal(restarted.runLog.list({ commandId: interruptedCmd.id, status: 'interrupted' }).length, 1);
  assert.equal(calls.length, 1, 'после падения повторного запуска не было');
  assert.ok(notices.some((n) => /прервался/.test(n.title)));

  // Кулдаун и обработанный eventId сохраняются даже после пересоздания store и launcher!
  const dupAfterRestart = await restarted.launcher.fireEvent('system:unlock', { eventId: 'evt-before-reboot' });
  assert.equal(dupAfterRestart.ran, 0);
  assert.match(dupAfterRestart.results[0].reason, /уже обработано/);

  clockRef.now = new Date('2026-11-13T08:30:25.000Z');
  await restarted.launcher.fireEvent('system:unlock', { eventId: 'evt-new-1' });
  assert.equal(calls.length, 2);
  clockRef.now = new Date('2026-11-13T08:30:40.000Z');
  const thirdBoot = env.recreate();
  const cooldownBlocked = await thirdBoot.launcher.fireEvent('system:unlock', { eventId: 'evt-new-2' });
  assert.equal(cooldownBlocked.ran, 0);
  assert.match(cooldownBlocked.results[0].reason, /пауза после прошлого срабатывания/);

  // Теперь переносим время на двое суток вперёд — daily 09:00 устарела (>12 ч) и должна пропуститься,
  // а интервальная команда (раз в 30 мин) после простоя выполняется ровно один раз (правило устаревания касается календарных).
  clockRef.now = new Date('2026-11-15T12:00:00.000Z');
  assert.equal(await new MissionScheduler({ commandLauncher: thirdBoot.launcher, now: () => clockRef.now }).tick(), 1);
  assert.equal(calls.length, 3, 'интервальная выполнилась один раз, устаревшая daily не запустилась');
  assert.equal(await new MissionScheduler({ commandLauncher: thirdBoot.launcher, now: () => clockRef.now }).tick(), 0, 'повторный тик не запускает ничего');
  const staleAfter = thirdBoot.store.get(staleCmd.id);
  assert.equal(staleAfter.triggerState.lastStatus, 'skipped');
  assert.match(staleAfter.triggerState.lastReason, /компьютер был выключен/);
  assert.ok(new Date(staleAfter.triggerState.nextRunAt).getTime() > clockRef.now.getTime());
  assert.equal(thirdBoot.runLog.list({ commandId: staleCmd.id, status: 'skipped' }).length, 1);
  assert.ok(cooldownCmd.id);
});

test('запрет обхода подтверждений через автоматический запуск (ask, auto, full) + соблюдение правил политики', async (t) => {
  const env = setupEnv(t, { mode: 'full' });
  const { store, launcher, runLog, calls, clockRef, setMode } = env;

  const delCmd = store.save({
    name: 'Удаление по графику',
    phrases: ['удаление'],
    steps: [{ tool: 'file_delete', args: { path: 'temp.txt' } }],
    triggers: {
      hotkey: { enabled: true, key: 'Control+Alt+D' },
      schedule: { enabled: true, type: 'interval', minutes: 5 },
      event: { enabled: true, eventType: 'system:unlock', cooldownSec: 0 },
    },
  }, { now: clockRef.now });

  // 1) Даже в режиме full автоматические расписание и событие НЕ имеют ownerCommand=true и не могут удалять без подтверждения.
  clockRef.now = new Date(clockRef.now.getTime() + 5 * 60000);
  const autoSchedule = await launcher.tickScheduled();
  assert.equal(autoSchedule.results[0].ok, false);
  assert.equal(autoSchedule.results[0].status, 'blocked');
  assert.match(autoSchedule.results[0].reason, /не может обойти подтверждение/);
  assert.equal(calls.length, 0);

  // Попытка просунуть ownerCommand: true и фейковый approvals.request -> 'once' всё равно блокируется!
  const spoofedEvent = await launcher.launch({
    commandId: delCmd.id,
    trigger: 'event',
    ownerCommand: true,
    deps: {
      ownerCommand: true,
      approvals: { request: async () => 'once', respond: () => true },
    },
  });
  assert.equal(spoofedEvent.ok, false);
  assert.equal(spoofedEvent.status, 'blocked');
  assert.equal(calls.length, 0);

  // А прямая горячая клавиша в режиме full выполняется по праву явного действия владельца.
  const viaHotkey = await launcher.fireHotkey('Control+Alt+D');
  assert.equal(viaHotkey.ok, true);
  assert.equal(calls.length, 1);

  // 2) В режиме auto T2-шаг в автоматическом расписании тоже блокируется (не обходит политику).
  setMode('auto');
  const autoModeBlocked = await launcher.launch({
    commandId: delCmd.id,
    trigger: 'event',
    ownerCommand: true,
    deps: { approvals: { request: async () => 'once', respond: () => true } },
  });
  assert.equal(autoModeBlocked.ok, false);
  assert.equal(autoModeBlocked.status, 'blocked');
  assert.match(autoModeBlocked.reason, /не может обойти подтверждение/);
  assert.equal(calls.length, 1);

  // 3) В режиме ask и горячая клавиша спрашивает подтверждение (отказ отклоняет запуск).
  setMode('ask');
  const rejectedHk = await launcher.fireHotkey('Control+Alt+D', {
    deps: { approvals: { request: async () => 'reject', respond: () => true } },
  });
  assert.equal(rejectedHk.ok, false);
  assert.equal(rejectedHk.status, 'cancelled');
  assert.equal(calls.length, 1);

  // 3) Оплата всегда запрещена даже при горячей клавише в режиме full.
  setMode('full');
  store.save({
    name: 'Платный клик',
    phrases: ['оплати'],
    steps: [{ tool: 'click_pay', args: { text: 'Оплатить подписку 990 руб' } }],
    triggers: { hotkey: { enabled: true, key: 'Control+Alt+P' } },
  }, { now: clockRef.now });
  const payAttempt = await launcher.fireHotkey('Control+Alt+P');
  assert.equal(payAttempt.ok, false);
  assert.equal(payAttempt.status, 'blocked');
  assert.match(payAttempt.reason, /политикой безопасности/);
  assert.equal(calls.length, 1);

  // 4) shell_run заблокирован для автоматических запусков до выполнения шага (даже если оказался в файле команд).
  const rawData = JSON.parse(fs.readFileSync(path.join(env.dir, 'commands.json'), 'utf8'));
  rawData.items[0].steps = [{ tool: 'shell_run', args: { text: 'whoami' } }];
  fs.writeFileSync(path.join(env.dir, 'commands.json'), JSON.stringify(rawData, null, 2));
  const blockedShell = await launcher.fireEvent('system:unlock', { eventId: 'shell-bypass' });
  assert.equal(blockedShell.results[0].status, 'blocked');
  assert.match(blockedShell.results[0].reason, /недоступно при автоматическом запуске/);
  assert.ok(runLog.list({ commandId: delCmd.id, status: 'blocked' }).length >= 2);
});

test('интерактивное подтверждение для события (allowInteractiveApprovalForAuto: true) всё равно требует ApprovalBroker и не обходит full/ask', async (t) => {
  const env = setupEnv(t, { mode: 'ask', allowInteractiveApprovalForAuto: true });
  const { store, launcher, calls } = env;
  store.save({
    name: 'Запись по событию',
    phrases: ['запись по событию'],
    steps: [{ tool: 'file_write', args: { path: 'log.txt', text: 'ok' } }],
    triggers: { event: { enabled: true, eventType: 'system:unlock', cooldownSec: 0 } },
  });

  // Без явного подтверждения владельца шаг отклоняется через реальный ApprovalBroker.
  const pending = launcher.fireEvent('system:unlock', { eventId: 'ask-1' }, { interactive: true });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(env.approvals.list().length, 1);
  env.approvals.respond(env.approvals.list()[0].id, 'reject');
  const res = await pending;
  assert.equal(res.results[0].ok, false);
  assert.equal(calls.length, 0);

  // С явным подтверждением владельца — выполняется, а при mode='full' ownerCommand всё равно остаётся false.
  const pending2 = launcher.fireEvent('system:unlock', { eventId: 'ask-2' }, { interactive: true });
  await new Promise((r) => setTimeout(r, 15));
  env.approvals.respond(env.approvals.list()[0].id, 'once');
  const res2 = await pending2;
  assert.equal(res2.results[0].ok, true);
  assert.equal(calls.length, 1);
});

test('единый экран управления, экспорт/импорт и журнал в CmdSteps и launchOverview', async (t) => {
  const { dir, store, launcher, clockRef } = setupEnv(t);
  const cmd = store.save({
    name: 'Сборка проекта',
    phrases: ['собери проект'],
    steps: [{ tool: 'wait', args: { ms: 5 } }],
    triggers: {
      hotkey: { enabled: true, key: 'Ctrl+Alt+M' },
      schedule: { enabled: true, type: 'weekdays', at: '10:30', timeZone: 'UTC' },
      event: { enabled: true, eventType: 'user:custom', eventName: 'релиз', match: 'main', cooldownSec: 5 },
    },
  }, { now: clockRef.now });

  await launcher.triggerCommand(cmd.id, 'manual');
  await launcher.fireEvent('user:релиз', { target: 'branch-dev' }); // не проходит match='main'
  await launcher.fireEvent('user:релиз', { target: 'branch-main' });

  const overview = launcher.launchOverview();
  assert.equal(overview.commands.length, 1);
  assert.equal(overview.events.length, EVENT_CATALOG.length);
  assert.equal(overview.log.length, 2);

  const matrix = CmdSteps.buildLaunchMatrix(overview.commands, overview.log);
  assert.equal(matrix.summary.totalCommands, 1);
  assert.equal(matrix.summary.withHotkey, 1);
  assert.equal(matrix.summary.withSchedule, 1);
  assert.equal(matrix.summary.withEvent, 1);
  assert.equal(matrix.rows[0].activeCount, 3);
  assert.equal(matrix.rows[0].logCount, 2);
  assert.equal(matrix.rows[0].lastStatusLabel, 'Выполнена');

  const filtered = CmdSteps.filterLaunchLog(overview.log, { trigger: 'event', query: 'релиз' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].triggerLabel, 'Событие');

  const errors = CmdSteps.validateTriggersDraft(
    {
      hotkey: { enabled: true, key: 'X' },
      schedule: { enabled: true, type: 'daily', at: '99:99' },
      event: { enabled: true, eventType: 'user:custom', eventName: '' },
    },
    overview.commands,
    null,
  );
  assert.equal(errors.length, 3);

  // Экспорт и импорт переносят все 3 способа запуска без runtime-полей.
  const pack = exportCommandPack(store.list(), { now: clockRef.now });
  assert.equal(pack.commands[0].triggerState, undefined);
  assert.equal(pack.commands[0].triggers.schedule.type, 'weekdays');
  assert.equal(pack.commands[0].triggers.event.eventName, 'релиз');

  const storeB = new CommandStore(path.join(dir, 'commands-copy.json'));
  const prev = previewCommandImport(pack, storeB);
  assert.equal(prev.ok, true);
  assert.equal(prev.preview.counts.add, 1);
  const applied = applyCommandImport(pack, storeB, { confirm: true });
  assert.equal(applied.added, 1);
  const restored = storeB.list()[0];
  assert.ok(restored);
  assert.equal(restored.triggers.schedule.at, '10:30');
  assert.equal(restored.triggers.event.match, 'main');
  assert.equal(previewCommandImport(pack, storeB).preview.counts.unchanged, 1);

  // Изменение способа запуска отображается в предпросмотре импорта.
  const modifiedPack = exportCommandPack([
    { ...restored, triggers: { ...restored.triggers, schedule: { ...restored.triggers.schedule, enabled: false } } },
  ], { now: clockRef.now });
  const diffPreview = previewCommandImport(modifiedPack, storeB);
  assert.equal(diffPreview.preview.counts.update, 1);
  assert.ok(diffPreview.preview.items[0].changes.some((c) => c.field === 'triggers'));
});
