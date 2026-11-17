'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseOffline } = require('../src/shortcuts/offline');
const {
  resolveLocalTurn,
  resolveLocalTurnAsync,
  parseBreakDuration,
  isUntouchedSampleWorkCommand,
  SCENARIO_IDS,
} = require('../src/shortcuts/scenarios');
const { CommandStore } = require('../src/commands/store');
const { SAMPLE_COMMANDS, seedSampleCommands } = require('../src/commands/samples');
const { remoteAllowed } = require('../src/telegram/policy');

function withTempStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-stage1-phrases-'));
  try {
    const store = new CommandStore(path.join(dir, 'commands.json'));
    return fn(store, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('offline.js supports safe quiet/louder/mute and two-windows FREQUENT phrases while keeping DANGER blocks', () => {
  const baseQuiet = parseOffline('тише');
  const baseLouder = parseOffline('громче');
  assert.ok(baseQuiet);
  assert.ok(baseLouder);
  assert.equal(baseQuiet.steps[0].tool, 'ui_keys');
  assert.equal(baseLouder.steps[0].tool, 'ui_keys');

  for (const phrase of ['сделай тише', 'потише', 'звук тише', 'убавь громкость', 'убавь звук']) {
    const res = parseOffline(phrase);
    assert.ok(res, phrase);
    assert.equal(res.steps[0].tool, 'ui_keys');
    assert.deepEqual(res.steps[0].args.keys, baseQuiet.steps[0].args.keys);
  }

  for (const phrase of ['сделай громче', 'погромче', 'звук громче', 'прибавь громкость', 'прибавь звук']) {
    const res = parseOffline(phrase);
    assert.ok(res, phrase);
    assert.equal(res.steps[0].tool, 'ui_keys');
    assert.deepEqual(res.steps[0].args.keys, baseLouder.steps[0].args.keys);
  }

  for (const phrase of ['убери звук', 'без звука']) {
    const res = parseOffline(phrase);
    assert.ok(res, phrase);
    assert.deepEqual(res.steps, [{ tool: 'volume_set', args: { percent: 0 } }]);
  }

  for (const phrase of ['выключи звук', 'отключи звук']) {
    assert.equal(parseOffline(phrase), null, phrase);
    const viaTurn = resolveLocalTurn(phrase);
    assert.ok(viaTurn, phrase);
    assert.deepEqual(viaTurn.steps, [{ tool: 'volume_set', args: { percent: 0 } }]);
  }

  const quietAndMute = resolveLocalTurn('сделай тише и выключи звук');
  assert.ok(quietAndMute);
  assert.equal(quietAndMute.steps.length, 2);
  assert.deepEqual(quietAndMute.steps[1], { tool: 'volume_set', args: { percent: 0 } });

  for (const phrase of ['два окна рядом', 'поставь два окна рядом', 'расположи два окна рядом', 'размести два окна рядом']) {
    const res = parseOffline(phrase);
    assert.ok(res, phrase);
    assert.deepEqual(res.steps, [{ tool: 'windows_arrange', args: { layout: 'row', count: 2 } }]);
  }

  for (const dangerous of ['выключи компьютер', 'выключи звук компьютера', 'удали все файлы', 'форматируй диск']) {
    assert.equal(parseOffline(dangerous), null, dangerous);
    assert.equal(resolveLocalTurn(dangerous), null, dangerous);
  }
});

test('whole-phrase reminders with commas and payment words continue to work untouched', () => {
  const r1 = resolveLocalTurn('Джарвис, напомни через 10 минут, позвонить маме');
  assert.ok(r1);
  assert.equal(r1.kind, 'command');
  assert.equal(r1.isSequence, false);
  assert.equal(r1.source, 'offline');
  assert.deepEqual(r1.steps, [{ tool: 'remind_in', args: { minutes: 10, text: 'позвонить маме' } }]);

  const r2 = resolveLocalTurn('напомни мне через 2 дня: оплатить счёт');
  assert.ok(r2);
  assert.deepEqual(r2.steps, [{ tool: 'remind_in', args: { minutes: 2880, text: 'оплатить счёт' } }]);
});

test('Part A compound phrases resolve offline, wake/fillers, semicolons, linkers, and mixed sources', () => {
  const quietStep = parseOffline('тише').steps[0];
  const youtube = resolveLocalTurn('Сделай тише, сверни окна и открой YouTube');
  assert.ok(youtube);
  assert.equal(youtube.kind, 'command');
  assert.equal(youtube.isSequence, true);
  assert.equal(youtube.source, 'offline');
  assert.equal(youtube.ownerCommand, false);
  assert.equal(youtube.parts.length, 3);
  assert.deepEqual(youtube.steps, [
    quietStep,
    { tool: 'windows_minimize_all', args: {} },
    { tool: 'url_open', args: { url: 'https://www.youtube.com' } },
  ]);

  const withFillers = resolveLocalTurn('Джарвис, сделай тише, пожалуйста, сверни окна и открой YouTube!');
  assert.deepEqual(withFillers.steps, youtube.steps);

  const inlineFiller = resolveLocalTurn('открой, пожалуйста, ютуб и сверни окна');
  assert.ok(inlineFiller);
  assert.equal(inlineFiller.parts.length, 2);
  assert.deepEqual(inlineFiller.steps, [
    { tool: 'url_open', args: { url: 'https://www.youtube.com' } },
    { tool: 'windows_minimize_all', args: {} },
  ]);

  const linkers = resolveLocalTurn('сверни окна; сделай громче, а затем открой гугл, после этого без звука, а также два окна рядом');
  assert.ok(linkers);
  assert.equal(linkers.isSequence, true);
  assert.equal(linkers.source, 'mixed');
  assert.equal(linkers.ownerCommand, false);
  assert.equal(linkers.parts.length, 5);
  assert.equal(linkers.steps.length, 5);
  assert.deepEqual(linkers.steps[2], { tool: 'url_open', args: { url: 'https://www.google.com' } });
  assert.deepEqual(linkers.steps[4], { tool: 'windows_arrange', args: { layout: 'row', count: 2 } });

  withTempStore((store) => {
    store.save({
      name: 'Включи и игру',
      phrases: ['включи и игру'],
      steps: [{ tool: 'app_open', args: { name: 'steam' } }],
    });
    store.save({
      name: 'Свет',
      phrases: ['включи свет'],
      steps: [{ tool: 'speak', args: { text: 'Свет включен' } }],
    });

    const keepInternalI = resolveLocalTurn('сделай тише и включи и игру', { store });
    assert.ok(keepInternalI);
    assert.equal(keepInternalI.source, 'mixed');
    assert.equal(keepInternalI.ownerCommand, false);
    assert.equal(keepInternalI.parts.length, 2);
    assert.equal(keepInternalI.parts[1].commandName, 'Включи и игру');
    assert.deepEqual(keepInternalI.steps[1], { tool: 'app_open', args: { name: 'steam' } });

    const ownerOnly = resolveLocalTurn('включи и игру и включи свет', { store });
    assert.ok(ownerOnly);
    assert.equal(ownerOnly.source, 'command');
    assert.equal(ownerOnly.ownerCommand, true);
    assert.equal(ownerOnly.parts.length, 2);

    const libraryByPhrase = new Map([
      ['покажи курс', { id: 'rates', title: 'Курс валют', phrases: ['покажи курс'] }],
    ]);
    const mixedLib = resolveLocalTurn('включи свет, сделай тише, а потом покажи курс', { store, libraryByPhrase });
    assert.ok(mixedLib);
    assert.equal(mixedLib.source, 'mixed');
    assert.equal(mixedLib.ownerCommand, false);
    assert.equal(mixedLib.parts.length, 3);
    assert.equal(mixedLib.parts[2].source, 'library');
    assert.deepEqual(mixedLib.steps[2], { tool: 'lib_rates', args: {} });
  });
});

test('DEMO 1: составная фраза не сводится к одной части, непонятое честно названо', async () => {
  // Живой прогон 12-й фазы: «погода, курс и YouTube» получил ответ только про курс.
  // Локальный путь не вправе ответить одной частью: погода и YouTube здесь не разбираются,
  // значит фраза идёт дальше (к модели) целиком, а не превращается в ответ про курс.
  const demo = 'Джарвис, открой погоду в Яндексе, курсы доллара в ЭйДже и YouTube в Хроме';
  assert.equal(resolveLocalTurn(demo), null);
  assert.equal(await resolveLocalTurnAsync(demo), null);

  // Понятные части выполняются, непонятая названа в notes; шагов из непонятого нет.
  const partial = resolveLocalTurn('сделай тише, сверни окна, закажи пиццу');
  assert.ok(partial);
  assert.equal(partial.partial, true);
  assert.equal(partial.parts.length, 2);
  assert.deepEqual(partial.steps, [
    parseOffline('тише').steps[0],
    { tool: 'windows_minimize_all', args: {} },
  ]);
  assert.deepEqual(partial.unresolved, ['закажи пиццу']);
  assert.match(partial.notes[partial.notes.length - 1], /Не понято: «закажи пиццу»/);
  assert.match(partial.title, /не всё понято/);

  // Частичный план так же работает в асинхронном пути (его и зовёт main.js).
  const partialAsync = await resolveLocalTurnAsync('сделай тише, сверни окна, закажи пиццу');
  assert.ok(partialAsync);
  assert.equal(partialAsync.partial, true);
  assert.deepEqual(partialAsync.steps, partial.steps);

  // Одна понятная часть — по-прежнему null: половину цепочки не запускаем.
  assert.equal(resolveLocalTurn('сделай тише и закажи пиццу'), null);
  // Явно составная фраза из двух понятных частей — прежний полный план без пометок.
  const full = resolveLocalTurn('сделай тише и сверни окна');
  assert.ok(full);
  assert.equal(full.partial, undefined);
  assert.equal(full.parts.length, 2);
});

test('guardrails and limits return null for questions, prose, ambiguous/partial/unsafe chains, and excess lengths', () => {
  assert.equal(resolveLocalTurn(''), null);
  assert.equal(resolveLocalTurn('   '), null);
  assert.equal(resolveLocalTurn('сделай тише?'), null);
  assert.equal(resolveLocalTurn('Сделай тише и открой YouTube?'), null);
  assert.equal(resolveLocalTurn('сделай на экране: нажми кнопку Отмена'), null);
  assert.equal(resolveLocalTurn('продолжай в фоне проверять почту'), null);
  assert.equal(resolveLocalTurn('почему звук стал тише'), null);
  assert.equal(resolveLocalTurn('как сделать тише и свернуть окна'), null);
  assert.equal(resolveLocalTurn('объясни зачем открывать ютуб'), null);
  assert.equal(resolveLocalTurn('какая температура сегодня'), null);

  const weather = resolveLocalTurn('какая погода');
  assert.ok(weather);
  assert.equal(weather.steps[0].tool, 'weather_now');

  assert.equal(resolveLocalTurn('сделай тише и сделай что-нибудь странное'), null);
  assert.equal(resolveLocalTurn('сделай тише и выключи компьютер'), null);
  assert.equal(resolveLocalTurn('сверни окна, удали все файлы'), null);

  // Too long chars (> 400)
  assert.equal(resolveLocalTurn(`сделай тише и ${'а'.repeat(400)}`), null);

  // > 60 tokens
  const manyTokens = Array.from({ length: 61 }, () => 'сделай тише').join(' и ');
  assert.equal(resolveLocalTurn(manyTokens), null);

  // 10 parts allowed vs 11 parts rejected
  const tenParts = Array.from({ length: 10 }, () => 'тише').join(', ');
  const ok10 = resolveLocalTurn(tenParts);
  assert.ok(ok10);
  assert.equal(ok10.parts.length, 10);

  const elevenParts = Array.from({ length: 11 }, () => 'тише').join(', ');
  assert.equal(resolveLocalTurn(elevenParts), null);

  // > 12 flattened steps rejected
  withTempStore((store) => {
    store.save({
      name: 'Большая команда',
      phrases: ['большая команда'],
      steps: Array.from({ length: 7 }, (_, i) => ({ tool: 'speak', args: { text: String(i) } })),
    });
    assert.equal(resolveLocalTurn('большая команда и большая команда', { store }), null);
  });

  // Ambiguous user commands rejected
  const ambiguous = [
    { id: '1', name: 'A', phrases: ['кино'], steps: [{ tool: 'speak', args: { text: '1' } }], enabled: true },
    { id: '2', name: 'B', phrases: ['кино'], steps: [{ tool: 'speak', args: { text: '2' } }], enabled: true },
  ];
  assert.equal(resolveLocalTurn('кино', { store: ambiguous }), null);
  assert.equal(resolveLocalTurn('сделай тише и кино', { store: ambiguous }), null);
});

test('Scenario 1 (leave), Scenario 2 (boss), and Scenario 4 (two_windows vs row)', () => {
  const leave = resolveLocalTurn('Джарвис, пожалуйста, я ухожу!');
  assert.ok(leave);
  assert.equal(leave.kind, 'command');
  assert.equal(leave.scenarioId, SCENARIO_IDS.LEAVE);
  assert.equal(leave.ownerCommand, false);
  assert.deepEqual(leave.steps, [
    { tool: 'windows_minimize_all', args: {} },
    { tool: 'media_control', args: { action: 'pause', allowNoSession: true } },
    { tool: 'volume_set', args: { percent: 0 } },
    { tool: 'ui_keys', args: { keys: 'win+l' } },
  ]);
  assert.equal(leave.steps.some((s) => s.tool === 'pc_lock' || s.tool === 'pc_shutdown'), false);

  const boss = resolveLocalTurn('спрячь всё');
  assert.ok(boss);
  assert.equal(boss.scenarioId, SCENARIO_IDS.BOSS);
  assert.deepEqual(boss.steps, [
    { tool: 'windows_minimize_all', args: {} },
    { tool: 'media_control', args: { action: 'pause', allowNoSession: true } },
    { tool: 'volume_set', args: { percent: 0 } },
  ]);
  assert.equal(boss.steps.some((s) => s.tool === 'pc_lock' || s.tool === 'pc_shutdown'), false);

  const boss2 = resolveLocalTurn('босс идёт');
  assert.deepEqual(boss2.steps, boss.steps);

  const two = resolveLocalTurn('Два окна рядом');
  assert.ok(two);
  assert.equal(two.scenarioId, SCENARIO_IDS.TWO_WINDOWS);
  assert.equal(two.source, 'scenario');
  assert.deepEqual(two.steps, [{ tool: 'windows_arrange', args: { layout: 'row', count: 2 } }]);

  const row = resolveLocalTurn('окна рядом');
  assert.ok(row);
  assert.equal(row.source, 'offline');
  assert.equal(row.scenarioId, undefined);
  assert.deepEqual(row.steps, [{ tool: 'windows_arrange', args: { layout: 'row' } }]);
});

test('Scenario 3 (break) & parseBreakDuration cover valid, missing, and invalid durations', () => {
  assert.equal(parseBreakDuration('перерыв на 15 минут'), 15);
  assert.equal(parseBreakDuration('перерыв 5 минут'), 5);
  assert.equal(parseBreakDuration('перерыв на минуту'), 1);
  assert.equal(parseBreakDuration('перерыв полчаса'), 30);
  assert.equal(parseBreakDuration('перерыв на час'), 60);
  assert.equal(parseBreakDuration('перерыв полтора часа'), 90);
  assert.equal(parseBreakDuration('ухожу на перерыв на 20 минут'), 20);
  assert.equal(parseBreakDuration('пошёл на перерыв на десять минут'), 10);
  assert.equal(parseBreakDuration('сделаю перерыв на двадцать пять минут'), 25);
  assert.equal(parseBreakDuration('я на перерыв на два часа'), 120);

  for (const bad of [
    'перерыв',
    'перерыв на 0 минут',
    'перерыв ноль минут',
    'перерыв миллион минут',
    'перерыв на 10081 минут',
    'перерыв на 200 часов',
    'перерыв 2 полчаса',
    'перерыв на минут',
    'перерыв часов',
    'перерыв на пару минут',
    'что такое перерыв',
  ]) {
    assert.equal(parseBreakDuration(bad), null, bad);
  }

  const noDuration = resolveLocalTurn('перерыв');
  assert.ok(noDuration);
  assert.equal(noDuration.kind, 'command');
  assert.equal(noDuration.scenarioId, SCENARIO_IDS.BREAK);
  assert.deepEqual(noDuration.steps, [
    { tool: 'media_control', args: { action: 'pause', allowNoSession: true } },
    { tool: 'windows_minimize_all', args: {} },
  ]);
  assert.equal(noDuration.notes.length, 1);

  const withDuration = resolveLocalTurn('ухожу на перерыв на 15 минут');
  assert.ok(withDuration);
  assert.equal(withDuration.scenarioId, SCENARIO_IDS.BREAK);
  assert.equal(withDuration.steps.length, 3);
  assert.equal(withDuration.steps[2].tool, 'remind_in');
  assert.equal(withDuration.steps[2].args.minutes, 15);
  assert.deepEqual(withDuration.notes, []);

  assert.equal(resolveLocalTurn('перерыв на 0 минут'), null);
  assert.equal(resolveLocalTurn('перерыв миллион минут'), null);
  assert.equal(resolveLocalTurn('перерыв 2 полчаса'), null);

  const compoundBreak = resolveLocalTurn('сделай тише и перерыв на 15 минут');
  assert.ok(compoundBreak);
  assert.equal(compoundBreak.steps.length, 4);
  assert.equal(resolveLocalTurn('сделай тише и перерыв на 0 минут'), null);
});

test('Scenario 5 (work_mode) never runs untouched SAMPLE_COMMANDS ya.ru/code and checks app availability', async () => {
  await withTempStore(async (store) => {
    seedSampleCommands(store);
    const allSeeded = store.list();
    const rabota = allSeeded.find((c) => c.name === 'Работа');
    const workModeSample = allSeeded.find((c) => c.name === 'Рабочий режим');
    assert.equal(isUntouchedSampleWorkCommand(rabota), true);
    assert.equal(isUntouchedSampleWorkCommand(workModeSample), true);

    const otherSample = allSeeded.find((c) => c.name === 'Игра');
    assert.equal(isUntouchedSampleWorkCommand(otherSample), false);

    // Unconfigured work_mode NEVER launches ya.ru or code
    for (const phrase of ['режим работы', 'рабочий режим', 'работа', 'начинаем работу']) {
      const reply = resolveLocalTurn(phrase, { store });
      assert.ok(reply, phrase);
      assert.equal(reply.kind, 'reply', phrase);
      assert.equal(reply.scenarioId, SCENARIO_IDS.WORK_MODE);
      assert.equal(reply.steps, undefined);
    }

    // In compound phrase, unconfigured work_mode aborts all-or-nothing -> null
    assert.equal(resolveLocalTurn('сделай тише и включи рабочий режим', { store }), null);

    // Configured ctx.workMode validates urls & verifies every app (never assumes unverified apps exist!)
    const unverifiedAppsOnly = resolveLocalTurn('рабочий режим', {
      store,
      workMode: { apps: ['notepad'] },
    });
    assert.equal(unverifiedAppsOnly.kind, 'reply');
    assert.match(unverifiedAppsOnly.notes[0], /notepad/);

    const configured = resolveLocalTurn('рабочий режим', {
      store,
      workMode: {
        minimizeWindows: true,
        volume: 25,
        urls: ['https://github.com', 'javascript:alert(1)', 'https://u:p@bad.com'],
        apps: ['Code', 'MissingApp'],
      },
      isAppAvailable: (name) => name === 'Code',
    });
    assert.equal(configured.kind, 'command');
    assert.equal(configured.scenarioId, SCENARIO_IDS.WORK_MODE);
    assert.equal(configured.ownerCommand, false);
    assert.deepEqual(configured.steps, [
      { tool: 'windows_minimize_all', args: {} },
      { tool: 'volume_set', args: { percent: 25 } },
      { tool: 'url_open', args: { url: 'https://github.com' } },
      { tool: 'app_open', args: { name: 'Code' } },
    ]);
    assert.equal(configured.notes.length, 3);

    // Sync resolveLocalTurn never treats a Promise from async isAppAvailable as truthy
    const syncWithAsyncPred = resolveLocalTurn('рабочий режим', {
      store,
      workMode: { apps: ['Code'] },
      isAppAvailable: async () => true,
    });
    assert.equal(syncWithAsyncPred.kind, 'reply');

    // resolveLocalTurnAsync awaits async isAppAvailable
    const asyncWithPred = await resolveLocalTurnAsync('рабочий режим', {
      store,
      workMode: { apps: ['Code'] },
      isAppAvailable: async (name) => name === 'Code',
    });
    assert.equal(asyncWithPred.kind, 'command');
    assert.deepEqual(asyncWithPred.steps, [{ tool: 'app_open', args: { name: 'Code' } }]);

    // Lazy ensureInventoryScanned runs ONLY when work_mode needs app check and inventory is unscanned
    let scanCalls = 0;
    const inv = {
      scannedAt: null,
      entries: [],
      find(q) {
        return this.entries.filter((e) => e.name.toLowerCase().includes(q.toLowerCase()));
      },
    };
    const nonWork = await resolveLocalTurnAsync('сделай тише', {
      store,
      appInventory: inv,
      ensureInventoryScanned: async () => { scanCalls += 1; },
    });
    assert.ok(nonWork);
    assert.equal(scanCalls, 0);

    const noAppsWork = await resolveLocalTurnAsync('рабочий режим', {
      store,
      workMode: { minimizeWindows: true },
      appInventory: inv,
      ensureInventoryScanned: async () => { scanCalls += 1; },
    });
    assert.equal(noAppsWork.kind, 'command');
    assert.equal(scanCalls, 0);

    const scannedWork = await resolveLocalTurnAsync('сделай тише и включи рабочий режим', {
      store,
      workMode: { apps: ['VS Code', 'Slack'] },
      appInventory: inv,
      ensureInventoryScanned: async (target) => {
        scanCalls += 1;
        target.scannedAt = '2026-11-14T12:00:00.000Z';
        target.entries = [{ name: 'VS Code', exe: 'Code.exe' }];
      },
    });
    assert.equal(scanCalls, 1);
    assert.equal(scannedWork.kind, 'command');
    assert.equal(scannedWork.isSequence, true);
    assert.deepEqual(scannedWork.steps, [
      parseOffline('тише').steps[0],
      { tool: 'app_open', args: { name: 'VS Code' } },
    ]);
    assert.equal(scannedWork.notes.length, 1);
    assert.match(scannedWork.notes[0], /Slack/);

    // Editing sample command flips isUntouchedSampleWorkCommand to false (even with origin: 'sample' kept by store)
    const edited = store.save({
      ...workModeSample,
      steps: [
        { tool: 'windows_minimize_all', args: {} },
        { tool: 'wait', args: { ms: 500 } },
        { tool: 'app_open', args: { name: 'Obsidian' } },
        { tool: 'app_open', args: { name: 'Missing' } },
      ],
    });
    assert.equal(edited.origin, 'sample');
    assert.equal(isUntouchedSampleWorkCommand(edited), false);

    const customWorkRes = await resolveLocalTurnAsync('рабочий режим', {
      store,
      isAppAvailable: async (name) => name === 'Obsidian',
    });
    assert.equal(customWorkRes.kind, 'command');
    assert.equal(customWorkRes.ownerCommand, true);
    assert.equal(customWorkRes.source, 'command');
    assert.deepEqual(customWorkRes.steps, [
      { tool: 'windows_minimize_all', args: {} },
      { tool: 'wait', args: { ms: 500 } },
      { tool: 'app_open', args: { name: 'Obsidian' } },
    ]);
    assert.equal(customWorkRes.notes.length, 1);

    // If edited/custom work command has ONLY missing app_open + wait/speak -> reply instead of false success
    store.save({
      ...edited,
      steps: [
        { tool: 'wait', args: { ms: 500 } },
        { tool: 'app_open', args: { name: 'Missing' } },
        { tool: 'speak', args: { text: 'Готово' } },
      ],
    });
    const allSkippedReply = await resolveLocalTurnAsync('рабочий режим', {
      store,
      isAppAvailable: async () => false,
    });
    assert.equal(allSkippedReply.kind, 'reply');
    assert.equal(allSkippedReply.notes.length, 1);

    // Custom command bound via workMode.commandId triggers Scenario 5 work_mode & lazy inventory scan
    const bound = store.save({
      name: 'Мой утренний стек',
      phrases: ['мой утренний стек'],
      steps: [
        { tool: 'windows_minimize_all', args: {} },
        { tool: 'app_open', args: { name: 'VS Code' } },
        { tool: 'app_open', args: { name: 'GhostApp' } },
      ],
    });
    let boundScanCalls = 0;
    const boundInv = {
      scannedAt: null,
      entries: [],
      find(q) {
        return this.entries.filter((e) => e.name.toLowerCase().includes(q.toLowerCase()));
      },
    };
    const boundRes = await resolveLocalTurnAsync('режим работы', {
      store,
      workMode: { commandId: bound.id },
      appInventory: boundInv,
      ensureInventoryScanned: async (target) => {
        boundScanCalls += 1;
        target.scannedAt = '2026-11-14T12:00:00.000Z';
        target.entries = [{ name: 'VS Code', exe: 'Code.exe' }];
      },
    });
    assert.equal(boundScanCalls, 1);
    assert.equal(boundRes.kind, 'command');
    assert.equal(boundRes.ownerCommand, true);
    assert.equal(boundRes.source, 'command');
    assert.equal(boundRes.parts[0].commandId, bound.id);
    assert.deepEqual(boundRes.steps, [
      { tool: 'windows_minimize_all', args: {} },
      { tool: 'app_open', args: { name: 'VS Code' } },
    ]);
    assert.equal(boundRes.notes.length, 1);
    assert.match(boundRes.notes[0], /GhostApp/);

    // Compound phrase containing customized 'Рабочий режим' with app_open (workMode unset) triggers lazy scan too
    store.save({
      ...edited,
      steps: [
        { tool: 'windows_minimize_all', args: {} },
        { tool: 'app_open', args: { name: 'Obsidian' } },
        { tool: 'app_open', args: { name: 'Missing' } },
      ],
    });
    let compoundCustomScanCalls = 0;
    const compoundInv = {
      scannedAt: null,
      entries: [],
      find(q) {
        return this.entries.filter((e) => e.name.toLowerCase().includes(q.toLowerCase()));
      },
    };
    const compoundCustomWork = await resolveLocalTurnAsync('сделай тише и включи рабочий режим', {
      store,
      appInventory: compoundInv,
      ensureInventoryScanned: async (target) => {
        compoundCustomScanCalls += 1;
        target.scannedAt = '2026-11-14T12:00:00.000Z';
        target.entries = [{ name: 'Obsidian', exe: 'Obsidian.exe' }];
      },
    });
    assert.equal(compoundCustomScanCalls, 1);
    assert.equal(compoundCustomWork.kind, 'command');
    assert.equal(compoundCustomWork.isSequence, true);
    assert.equal(compoundCustomWork.source, 'mixed');
    assert.equal(compoundCustomWork.ownerCommand, false);
    assert.deepEqual(compoundCustomWork.steps, [
      parseOffline('тише').steps[0],
      { tool: 'windows_minimize_all', args: {} },
      { tool: 'app_open', args: { name: 'Obsidian' } },
    ]);
    assert.equal(compoundCustomWork.notes.length, 1);
    assert.match(compoundCustomWork.notes[0], /Missing/);
  });
});

test('security boundaries: scoped excludes library, remoteAllowed/commandsToolCheck/DANGEROUS_TOOLS/FORBIDDEN_PREFIXES enforced', () => {
  const libraryByPhrase = new Map([
    ['покажи курс', { id: 'rates', title: 'Курс валют', phrases: ['покажи курс'] }],
  ]);

  assert.ok(resolveLocalTurn('покажи курс', { libraryByPhrase, scoped: false }));
  assert.equal(resolveLocalTurn('покажи курс', { libraryByPhrase, scoped: true }), null);
  assert.equal(resolveLocalTurn('сделай тише и покажи курс', { libraryByPhrase, scoped: true }), null);

  const policyMap = {
    ui_keys: { name: 'ui_keys', risk: 'T1' },
    windows_minimize_all: { name: 'windows_minimize_all', risk: 'T1' },
    volume_set: { name: 'volume_set', risk: 'T1' },
    lib_rates: { name: 'lib_rates', risk: 'T1' },
    media_control: { name: 'media_control', risk: 'T1' },
  };
  const remoteCheck = (toolName) => remoteAllowed(policyMap[toolName]);

  // ui_keys and lib_* are blocked remotely by src/telegram/policy.js (including Scenario 1 ui_keys win+l)
  assert.equal(resolveLocalTurn('сделай тише', { remoteAllowed: remoteCheck }), null);
  assert.equal(resolveLocalTurn('покажи курс', { libraryByPhrase, remoteAllowed: remoteCheck }), null);
  assert.equal(resolveLocalTurn('я ухожу', { remoteAllowed: remoteCheck }), null);
  assert.ok(resolveLocalTurn('босс идёт', { remoteAllowed: remoteCheck }));
  assert.ok(resolveLocalTurn('выключи звук', { remoteAllowed: remoteCheck }));

  // commandsToolCheck enforces registered command tools
  assert.equal(
    resolveLocalTurn('два окна рядом', { commandsToolCheck: (tool) => tool !== 'windows_arrange' }),
    null
  );
  assert.ok(
    resolveLocalTurn('два окна рядом', { commandsToolCheck: (tool) => tool === 'windows_arrange' })
  );

  // DANGEROUS_TOOLS and FORBIDDEN_PREFIXES blocked even if bypassed into command list / disk JSON
  const injectedCommands = [
    {
      id: 'd1',
      name: 'Опасный',
      phrases: ['стоп всё'],
      steps: [{ tool: 'pc_shutdown', args: {} }],
      enabled: true,
    },
    {
      id: 'd2',
      name: 'Миссия',
      phrases: ['запусти миссию'],
      steps: [{ tool: 'mission_start', args: { id: '1' } }],
      enabled: true,
    },
    {
      id: 'd3',
      name: 'Редактор',
      phrases: ['удали сценарий'],
      steps: [{ tool: 'command_delete', args: { id: '1' } }],
      enabled: true,
    },
    {
      id: 'd4',
      name: 'Рабочий с выключением',
      phrases: ['рабочий режим'],
      steps: [{ tool: 'windows_minimize_all', args: {} }, { tool: 'pc_shutdown', args: {} }],
      enabled: true,
    },
  ];
  assert.equal(resolveLocalTurn('стоп всё', { store: injectedCommands }), null);
  assert.equal(resolveLocalTurn('сверни окна и стоп всё', { store: injectedCommands }), null);
  assert.equal(resolveLocalTurn('запусти миссию', { store: injectedCommands }), null);
  assert.equal(resolveLocalTurn('удали сценарий', { store: injectedCommands }), null);
  assert.equal(resolveLocalTurn('рабочий режим', { store: injectedCommands }), null);

  withTempStore((store, dir) => {
    fs.writeFileSync(
      path.join(dir, 'commands.json'),
      JSON.stringify({ items: injectedCommands.slice(0, 3) }),
      'utf8'
    );
    assert.equal(resolveLocalTurn('стоп всё', { store }), null);
    assert.equal(resolveLocalTurn('сверни окна и стоп всё', { store }), null);
    assert.equal(resolveLocalTurn('запусти миссию', { store }), null);
    assert.equal(resolveLocalTurn('удали сценарий', { store }), null);
  });
});
