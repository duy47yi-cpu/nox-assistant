'use strict';

// Тесты фазы 2: дерево шагов (произвольная вложенность), миграция v1/v2 → v3 на месте без потерь,
// валидация (пустые шаги, дубли id, битые ссылки на программы), сборка из фразы «Опишите словами»
// строго по каталогу и честный частичный отказ при выполнении дерева.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  COMMAND_SCHEMA_VERSION,
  CommandStore,
  CommandRunLog,
  flattenStepTree,
  countStepNodes,
  hasTreeSteps,
} = require('../src/commands/store');
const {
  runCommand,
  UnifiedCommandLauncher,
  formatPartialCommandReport,
  shortCommandReceipt,
} = require('../src/commands/runner');
const {
  assembleCommandFromDescription,
  parseDescriptionOffline,
} = require('../src/commands/builder');
const { PACKS, seedPackCommands, describePacks } = require('../src/commands/packs');
const { ToolRegistry } = require('../src/tools/registry');
const { resolveLocalTurn } = require('../src/shortcuts/scenarios');

function tmpDir(t, prefix = 'jarvis-p2-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fullPolicy = {
  decide: () => 'allow',
};

test('миграция плоских команд v1 и v2 на месте сохраняет id, фразы, триггеры и данные без потерь', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'commands.json');
  const legacy = {
    schemaVersion: 2,
    items: [
      {
        id: 'legacy-1',
        schemaVersion: 1,
        name: 'Старое утро',
        phrases: ['старое утро', 'утренний набор'],
        hotkey: 'Control+Alt+U',
        enabled: true,
        folder: 'Офис',
        collections: ['Работа'],
        lastRunAt: '2026-01-10T08:00:00.000Z',
        createdAt: '2026-01-01T08:00:00.000Z',
        steps: [
          { tool: 'app_open', args: { name: 'notepad' } },
          { tool: 'volume_set', args: { percent: 35 } },
        ],
      },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');

  const store = new CommandStore(file);
  const items = store.list();
  assert.equal(items.length, 1);
  const migrated = items[0];
  assert.equal(migrated.id, 'legacy-1');
  assert.equal(migrated.schemaVersion, COMMAND_SCHEMA_VERSION);
  assert.equal(migrated.name, 'Старое утро');
  assert.equal(migrated.folder, 'Офис');
  assert.deepEqual(migrated.collections, ['Работа']);
  assert.equal(migrated.lastRunAt, '2026-01-10T08:00:00.000Z');
  assert.equal(migrated.createdAt, '2026-01-01T08:00:00.000Z');
  assert.deepEqual(migrated.phrases, ['старое утро', 'утренний набор']);
  assert.equal(migrated.hotkey, 'Control+Alt+U');
  assert.equal(migrated.steps.length, 2);
  assert.equal(migrated.steps[0].type, 'app_start');
  assert.equal(migrated.steps[0].params.name, 'notepad');
  assert.equal(migrated.steps[0].tool, 'app_open');
  assert.deepEqual(migrated.steps[0].children, []);
  assert.equal(migrated.steps[1].type, 'volume');
  assert.deepEqual(migrated.steps[1].params, { percent: 35 });

  // В файле на диске запись обновлена на месте.
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.schemaVersion, COMMAND_SCHEMA_VERSION);
  assert.equal(persisted.items[0].schemaVersion, COMMAND_SCHEMA_VERSION);
  assert.ok(persisted.items[0].steps[0].id);
});

test('произвольная вложенность дерева шагов сохраняется, читается и выполняется в прямом обходе', async (t) => {
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));

  const saved = store.save({
    name: 'Вложенный сценарий',
    program: 'notepad',
    phrases: ['вложенный тест', 'тест дерева'],
    confirm: false,
    steps: [
      {
        id: 'n1',
        type: 'app_start',
        params: { name: 'notepad' },
        children: [
          {
            id: 'n1-1',
            type: 'type_text',
            params: { text: 'привет' },
            children: [
              { id: 'n1-1-1', type: 'hotkey', params: { keys: 'ctrl+s' }, children: [] },
            ],
          },
          { id: 'n1-2', type: 'click', params: { x: 120, y: 240 }, children: [] },
        ],
      },
      { id: 'n2', type: 'volume', params: { percent: 40 }, children: [] },
    ],
  });

  assert.equal(saved.schemaVersion, 3);
  assert.equal(saved.program, 'notepad');
  assert.equal(hasTreeSteps(saved.steps), true);
  assert.equal(countStepNodes(saved.steps), 5);
  assert.deepEqual(flattenStepTree(saved.steps).map((s) => s.id), ['n1', 'n1-1', 'n1-1-1', 'n1-2', 'n2']);

  // Повторное чтение с диска не теряет дерево.
  const reloaded = new CommandStore(store.filePath).get(saved.id);
  assert.equal(countStepNodes(reloaded.steps), 5);
  assert.equal(reloaded.steps[0].children[0].children[0].type, 'hotkey');

  // Выполнение в прямом обходе (pre-order).
  const order = [];
  const reg = new ToolRegistry();
  for (const name of ['app_open', 'ui_type', 'ui_keys', 'desktop_click', 'ui_click', 'volume_set']) {
    reg.register({
      name,
      risk: 'T0',
      async run(args) {
        order.push({ name, args });
        return { ok: true, summary: `выполнен ${name}`, data: args };
      },
      async verify() {
        return { status: 'confirmed', evidence: 'ok' };
      },
    });
  }

  const out = await runCommand(reloaded, { tools: reg, policy: fullPolicy, mode: 'full', ownerCommand: true });
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 5);
  assert.deepEqual(order.map((x) => x.name), ['app_open', 'ui_type', 'ui_keys', 'desktop_click', 'volume_set']);
  assert.equal(shortCommandReceipt(reloaded, out), 'Команда «Вложенный сценарий» выполнена.');

  // Сопоставление фразы из scenarios.js сохраняет вложенные шаги для runner.
  const matched = resolveLocalTurn('тест дерева', { store });
  assert.ok(matched);
  assert.equal(countStepNodes(matched.steps), 5);
});

test('валидация отклоняет пустые шаги, дубли id шагов и битые ссылки на программы понятной ошибкой', (t) => {
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));

  assert.throws(
    () => store.save({ name: 'Пустая', phrases: ['пустая'], steps: [] }),
    /шагов от 1 до/,
  );

  assert.throws(
    () => store.save({
      name: 'Дубли',
      phrases: ['дубли'],
      steps: [
        { id: 'dup-1', type: 'wait', params: { ms: 100 }, children: [{ id: 'dup-1', type: 'volume', params: { percent: 10 }, children: [] }] },
      ],
    }),
    /дубль id шага/,
  );

  assert.throws(
    () => store.save({
      name: 'Битый путь',
      phrases: ['битый'],
      steps: [{ type: 'app_start', params: { name: 'C:\\NoxMissingDir999\\app.exe' }, children: [] }],
    }),
    /битая ссылка на программу/,
  );

  assert.throws(
    () => store.save({
      name: 'Битая программа команды',
      program: 'C:\\NoxMissingDir999\\missing.exe',
      phrases: ['программа'],
      steps: [{ type: 'wait', params: { ms: 100 }, children: [] }],
    }),
    /битая ссылка на программу/,
  );
});

test('при отказе родительского шага дети пропускаются, но независимые ветки дают честный частичный отказ и статус partial', async (t) => {
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));
  const runLog = new CommandRunLog(path.join(dir, 'runs.json'));

  const cmd = store.save({
    name: 'Погода и YouTube',
    phrases: ['утренние вкладки'],
    steps: [
      { id: 's1', type: 'app_start', params: { name: 'Edge' }, children: [] },
      {
        id: 's2',
        type: 'app_start',
        params: { name: 'NonExistentChrome999' },
        children: [
          { id: 's2-1', type: 'type_text', params: { text: 'https://youtube.com' }, children: [] },
        ],
      },
      { id: 's3', type: 'volume', params: { percent: 45 }, children: [] },
    ],
  });

  const reg = new ToolRegistry();
  reg.register({
    name: 'app_open',
    risk: 'T1',
    async run(args) {
      if (args.name === 'Edge') return { ok: true, summary: 'в Edge открыто окно', data: {} };
      return { ok: false, summary: `программа не найдена: ${args.name}`, data: {} };
    },
    async verify() { return { status: 'confirmed', evidence: 'ok' }; },
  });
  reg.register({
    name: 'ui_type',
    risk: 'T1',
    async run() { return { ok: true, summary: 'введён текст', data: {} }; },
    async verify() { return { status: 'confirmed', evidence: 'ok' }; },
  });
  reg.register({
    name: 'volume_set',
    risk: 'T0',
    async run(args) { return { ok: true, summary: `громкость ${args.percent}%`, data: {} }; },
    async verify() { return { status: 'confirmed', evidence: 'ok' }; },
  });

  const launcher = new UnifiedCommandLauncher({
    store,
    runLog,
    depsProvider: () => ({ tools: reg, policy: fullPolicy, journal: { append() {} }, mode: 'full' }),
  });

  const launch = await launcher.triggerCommand(cmd.id, 'manual', { ownerCommand: true });
  assert.equal(launch.ok, false);
  assert.equal(launch.status, 'partial');
  assert.equal(launch.partial, true);
  // Ребёнок s2-1 (ui_type) пропущен, так как родитель NonExistentChrome999 не запустился; s3 выполнен.
  assert.equal(launch.results.length, 3);
  assert.deepEqual(launch.results.map((r) => r.tool), ['app_open', 'app_open', 'volume_set']);
  assert.match(launch.reason, /Выполнено частично/);
  assert.match(launch.reason, /NonExistentChrome999 не найден/i);

  const report = formatPartialCommandReport(cmd, launch);
  assert.doesNotMatch(report, /^Команда .+ выполнена\.$/);

  const entries = runLog.list({ commandId: cmd.id });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'partial');
  assert.equal(entries[0].stepsOk, 2);
  assert.equal(entries[0].stepsTotal, 4);
});

test('сборка из фразы «Опишите словами» строит только из каталога и честно называет недостающие возможности', async () => {
  const catalog = new Set(['app_open', 'ui_keys', 'ui_click', 'ui_type', 'volume_set', 'wait', 'speak', 'url_open']);

  // Офлайн-сборка понимает стандартные шаги из каталога.
  const okRes = await assembleCommandFromDescription({
    text: 'Открой блокнот, подожди 2 секунды и сделай громкость 50%',
    tools: catalog,
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.command.schemaVersion, 3);
  assert.equal(okRes.command.steps.length, 3);
  assert.equal(okRes.command.steps[0].type, 'app_start');
  assert.equal(okRes.command.steps[1].type, 'wait');
  assert.equal(okRes.command.steps[2].type, 'volume');

  // Запрос про отсутствующее действие (например оплата или письмо) не выдумывает пустышку.
  const missingOffline = parseDescriptionOffline('Оплати заказ картой и переведи деньги', { tools: catalog });
  assert.equal(missingOffline.ok, false);
  assert.ok(missingOffline.missing.length >= 1);

  const missingRes = await assembleCommandFromDescription({
    text: 'Оплати заказ картой и удали все файлы навсегда',
    tools: catalog,
  });
  assert.equal(missingRes.ok, false);
  assert.ok(Array.isArray(missingRes.missing) && missingRes.missing.length >= 1);

  // Модель пытается подсунуть отсутствующий/опасный инструмент → честный отказ или missing без пустышки.
  const badAi = await assembleCommandFromDescription({
    text: 'Смонтируй видео и отправь в Telegram',
    tools: catalog,
    modelCall: async () => JSON.stringify({
      name: 'Монтаж и отправка',
      phrases: ['смонтируй и отправь'],
      steps: [{ type: 'shell', params: { command: 'echo 1' } }],
      missing: ['Отправка сообщений в Telegram в командах недоступна'],
    }),
  });
  assert.equal(badAi.ok, false);
  assert.ok(badAi.missing.some((m) => /Telegram/i.test(m)));
});

test('паки Photoshop и Minecraft присутствуют, ставятся одной кнопкой и меняют счётчик describePacks', (t) => {
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));

  assert.ok(PACKS.some((p) => p.id === 'photoshop'));
  assert.ok(PACKS.some((p) => p.id === 'minecraft'));

  const before = describePacks(store.list());
  const psBefore = before.find((p) => p.id === 'photoshop');
  assert.equal(psBefore.installed, 0);
  assert.ok(psBefore.total >= 4);

  const addedPs = seedPackCommands(store, ['photoshop']);
  assert.equal(addedPs.length, psBefore.total);

  const after = describePacks(store.list());
  const psAfter = after.find((p) => p.id === 'photoshop');
  assert.equal(psAfter.installed, psAfter.total);
  const mcAfter = after.find((p) => p.id === 'minecraft');
  assert.equal(mcAfter.installed, 0);
});

test('обращение «Джарвис», филлеры «сэр»/«пожалуйста» и режим префикса работают согласованно', (t) => {
  const { matchCommand, matchSequence, normalizePhrase } = require('../src/commands/match');
  const { SAMPLE_COMMANDS } = require('../src/commands/samples');
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));

  const saved = store.save({
    name: 'Свернуть всё',
    phrases: ['сверни все окна'],
    steps: [{ type: 'hotkey', params: { keys: 'win+d' } }],
    enabled: true,
  });

  // 1) Все формы ввода (с обращением, с «сэр», с «пожалуйста» и без них) дают одно действие.
  for (const phrase of [
    'сверни все окна',
    'Джарвис, сверни все окна',
    'Джарвис, пожалуйста, сверни все окна',
    'сэр, сверни все окна',
  ]) {
    const hit = matchCommand(phrase, store.list());
    assert.ok(hit, `не сработала фраза: ${phrase}`);
    assert.equal(hit.command.id, saved.id);
    const local = resolveLocalTurn(phrase, { store });
    assert.ok(local && local.kind === 'command', `resolveLocalTurn не нашёл: ${phrase}`);
    assert.equal(local.title, 'Свернуть всё');
  }

  // 2) Команда, ошибочно сохранённая с обращением, всё равно срабатывает при вводе без обращения.
  const storeLegacy = new CommandStore(path.join(dir, 'commands-legacy.json'));
  const savedWithWake = storeLegacy.save({
    name: 'Наследие с префиксом',
    phrases: ['Джарвис, сверни все окна'],
    steps: [{ type: 'hotkey', params: { keys: 'win+d' } }],
    enabled: true,
  });
  const matchedBare = matchCommand('сверни все окна', storeLegacy.list());
  assert.ok(matchedBare);
  assert.equal(matchedBare.command.id, savedWithWake.id);

  // 3) Дефолтные команды и паки хранят фразы-триггеры без «Джарвис» и «сэр».
  for (const s of SAMPLE_COMMANDS) {
    for (const p of s.phrases) {
      assert.doesNotMatch(p, /джарвис|\bсэр\b/iu);
    }
  }
  for (const pack of PACKS) {
    for (const c of pack.commands) {
      for (const p of c.phrases) {
        assert.doesNotMatch(p, /джарвис|\bсэр\b/iu);
      }
    }
  }
  assert.equal(normalizePhrase('Джарвис, сэр, пожалуйста, сверни все окна'), 'сверни все окна');

  // 4) Режим префикса (prefixMode): при true без обращения не срабатывает; при false — необязателен.
  assert.equal(matchCommand('сверни все окна', store.list(), { prefixMode: true }), null);
  assert.equal(matchCommand('сэр, сверни все окна', store.list(), { prefixMode: true }), null);
  assert.deepEqual(matchSequence('сверни все окна', store.list(), { prefixMode: true }), []);
  assert.equal(resolveLocalTurn('сверни все окна', { store, prefixMode: true }), null);

  assert.equal(matchCommand('Джарвис, сверни все окна', store.list(), { prefixMode: true }).command.id, saved.id);
  assert.equal(resolveLocalTurn('Джарвис, пожалуйста, сверни все окна', { store, prefixMode: true }).title, 'Свернуть всё');
  assert.equal(resolveLocalTurn('сверни все окна', { store, prefixMode: false }).title, 'Свернуть всё');

  // 5) Префикс как список вариантов (1–2 слова, ё/е, граница слова; пустой список отключает требование).
  const multiOpts = { prefixMode: true, wakeWords: ['джарвис', 'эй сэр', 'сём'] };
  const results = [
    resolveLocalTurn('Джарвис, сверни все окна', { store, ...multiOpts }),
    resolveLocalTurn('Эй сэр, сверни все окна', { store, ...multiOpts }),
    resolveLocalTurn('сем, сверни все окна', { store, ...multiOpts }),
  ];
  for (const r of results) {
    assert.ok(r && r.kind === 'command');
    assert.equal(r.title, 'Свернуть всё');
  }
  assert.equal(matchCommand('джарвисова сверни все окна', store.list(), multiOpts), null);
  assert.equal(resolveLocalTurn('сверни все окна', { store, ...multiOpts }), null);

  // Пустое значение списка обращений означает, что обращение не требуется даже при prefixMode: true.
  assert.equal(matchCommand('сверни все окна', store.list(), { prefixMode: true, wakeWords: [] }).command.id, saved.id);
  assert.equal(resolveLocalTurn('сверни все окна', { store, prefixMode: true, wakeWords: [] }).title, 'Свернуть всё');
});

// Ложный антоним из живого прогона 12-й фазы (acceptance/phase12/live/s3b): «верни все окна»
// отличалось от «сверни все окна» одной вставленной буквой и запускало «Свернуть все окна»
// (windows_minimize_all). Опечатка в первом слове меняет действие на противоположное, поэтому
// запасной fuzzy-путь не должен её пропускать. Опечатки в остальных словах и в конце фразы
// остаются рабочими: fuzzy целиком не выключен.
test('фраза-антоним «верни все окна» не запускает «Свернуть все окна», а опечатки внутри фразы находятся', (t) => {
  const { matchCommand } = require('../src/commands/match');
  const { SAMPLE_COMMANDS } = require('../src/commands/samples');
  const dir = tmpDir(t);
  const store = new CommandStore(path.join(dir, 'commands.json'));
  const saved = store.save({
    name: 'Свернуть всё',
    phrases: ['сверни все окна'],
    steps: [{ type: 'hotkey', params: { keys: 'win+d' } }],
    enabled: true,
  });
  // Пара антиподов: в паке media обе фразы («включи звук», «выключи звук») лежат в одной команде
  // «Звук: выключить или включить», поэтому две разные команды собираем здесь руками.
  store.save({ name: 'Звук: включить', phrases: ['включи звук'], steps: [{ type: 'hotkey', params: { keys: 'win+d' } }] });
  store.save({ name: 'Звук: выключить', phrases: ['выключи звук'], steps: [{ type: 'hotkey', params: { keys: 'win+d' } }] });
  store.save({ name: 'Ютуб', phrases: ['ютуб'], optionalPhrases: ['врубай'], steps: [{ type: 'hotkey', params: { keys: 'win+d' } }] });

  // 1) Обратный глагол — не опечатка: «верни» и «сверни» просят разное.
  assert.equal(matchCommand('верни все окна', store.list()), null, '«верни» не превращается в «сверни»');
  assert.equal(matchCommand('верни все окна', SAMPLE_COMMANDS), null, 'на штатном наборе команд — тоже null');
  assert.equal(resolveLocalTurn('верни все окна', { store }), null, 'локальный путь не уводит в чужое действие');

  // 2) Точное совпадение и «необязательный глагол + фраза» не сломаны.
  const exact = matchCommand('сверни все окна', store.list());
  assert.equal(exact.command.id, saved.id);
  assert.equal(exact.via, 'exact');
  assert.equal(matchCommand('сверни все окна', SAMPLE_COMMANDS).command.name, 'Свернуть все окна');
  assert.equal(matchCommand('ютуб', store.list()).command.name, 'Ютуб');
  assert.equal(matchCommand('открой ютуб', store.list()).command.name, 'Ютуб');
  assert.equal(matchCommand('врубай ютуб', store.list()).verb, 'врубай');
  assert.equal(matchCommand('открой сверни все окна', store.list()).verb, 'открой');

  // 3) Опечатки в остальных словах и в конце фразы по-прежнему распознаются.
  for (const typo of ['сверни все окнa', 'сверни все окн', 'сверни вче окна', 'сверни все окно']) {
    const hit = matchCommand(typo, store.list());
    assert.ok(hit, 'опечатка «' + typo + '» должна находить команду');
    assert.equal(hit.command.id, saved.id, typo);
    assert.equal(hit.via, 'fuzzy', typo);
  }
  // Та же опечатка после необязательного глагола — второй запасной проход.
  assert.equal(matchCommand('открой сверни все окнa', store.list()).verb, 'открой');
  // Fuzzy не убит целиком: одиночное слово с опечаткой находится (правило про первое слово
  // касается только фраз из двух и более слов).
  const calendar = [{ id: 'k', name: 'Календарь', phrases: ['календарь'], steps: [], enabled: true }];
  assert.equal(matchCommand('календар', calendar).via, 'fuzzy');

  // 4) Антиподы «включи звук» / «выключи звук» не путаются: точное совпадение важнее,
  //    а одинокая команда не подтягивает противоположную фразу опечаткой.
  assert.equal(matchCommand('включи звук', store.list()).command.name, 'Звук: включить');
  assert.equal(matchCommand('выключи звук', store.list()).command.name, 'Звук: выключить');
  const muteOnly = store.list().filter((item) => item.name === 'Звук: выключить');
  const unmuteOnly = store.list().filter((item) => item.name === 'Звук: включить');
  assert.equal(matchCommand('включи звук', muteOnly), null, 'без своей команды фраза не становится антиподом');
  assert.equal(matchCommand('выключи звук', unmuteOnly), null, 'и наоборот');
});
