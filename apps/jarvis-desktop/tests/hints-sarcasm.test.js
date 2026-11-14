'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveHint } = require('../src/shortcuts/hints');
const { parseOffline } = require('../src/shortcuts/offline');
const { resolveLocalTurn, resolveLocalTurnAsync } = require('../src/shortcuts/scenarios');
const { runCommand } = require('../src/commands/runner');
const policy = require('../src/policy/modes');
const { remoteAllowed } = require('../src/telegram/policy');

function assertSteps(plan, expectedSteps) {
  assert.ok(plan, 'ожидался непустой план');
  assert.equal(plan.kind, 'command');
  assert.equal(plan.source, 'hint');
  assert.deepEqual(plan.steps, expectedSteps);
}

test('намёки и полуслова: слишком тихо -> повышение громкости (volume_up x5)', () => {
  const expected = [{ tool: 'ui_keys', args: { keys: 'volume_up volume_up volume_up volume_up volume_up' } }];
  const phrases = [
    'блин, слишком тихо',
    'слишком тихо',
    'чё так тихо',
    'что-то слишком тихо',
    'еле слышно',
    'ничего не слышно',
    'плохо слышно',
    'тиховато',
    'можно погромче',
    'добавь чуть',
  ];
  for (const phrase of phrases) {
    assertSteps(resolveHint(phrase), expected);
    assertSteps(resolveLocalTurn(phrase), expected);
  }
});

test('сарказм про тихий звук -> переворот полярности в повышение громкости', () => {
  const expected = [{ tool: 'ui_keys', args: { keys: 'volume_up volume_up volume_up volume_up volume_up' } }];
  const phrases = [
    'ну да, сделай ещё тише',
    'ага, сделай ещё тише',
    'класс, вообще ничего не слышно',
    'обожаю когда еле слышно',
    'супер, вообще не слышно',
  ];
  for (const phrase of phrases) {
    assertSteps(resolveHint(phrase), expected);
    assertSteps(resolveLocalTurn(phrase), expected);
  }
});

test('намёки и сарказм: слишком громко -> снижение громкости (volume_down x5)', () => {
  const expected = [{ tool: 'ui_keys', args: { keys: 'volume_down volume_down volume_down volume_down volume_down' } }];
  const phrases = [
    'слишком громко',
    'громковато',
    'орёт',
    'уши вянут',
    'уши заложило',
    'оглушает',
    'голова трещит от звука',
    'убавь чуть',
    'ну да, сделай ещё громче',
    'спасибо, сейчас оглохну',
    'класс, на весь дом орёт',
  ];
  for (const phrase of phrases) {
    assertSteps(resolveHint(phrase), expected);
    assertSteps(resolveLocalTurn(phrase), expected);
  }
});

test('намёки и сарказм: слишком ярко -> уменьшение яркости (-20)', () => {
  const expected = [{ tool: 'screen_brightness', args: { change: -20 } }];
  const phrases = [
    'слишком ярко',
    'глаза режет',
    'слепит',
    'яркость зашкаливает',
    'спасибо, как сварка',
    'спасибо, ослепнуть можно',
    'спасибо, ещё ярче сделай',
    'ну да, сделай ещё ярче',
  ];
  for (const phrase of phrases) {
    assertSteps(resolveHint(phrase), expected);
    assertSteps(resolveLocalTurn(phrase), expected);
  }
});

test('намёки: слишком темно -> увеличение яркости (+20)', () => {
  const expected = [{ tool: 'screen_brightness', args: { change: 20 } }];
  const phrases = [
    'слишком темно',
    'темно на экране',
    'темно как в пещере',
    'ничего не видно на экране',
    'ну да, сделай ещё темнее',
  ];
  for (const phrase of phrases) {
    assertSteps(resolveHint(phrase), expected);
    assertSteps(resolveLocalTurn(phrase), expected);
  }
});

test('намёки: бардак в окнах -> неразрушающая сетка windows_arrange', () => {
  const expected = [{ tool: 'windows_arrange', args: { layout: 'grid' } }];
  for (const phrase of ['тут бардак в окнах', 'каша из окон', 'разгреби окна']) {
    assertSteps(resolveHint(phrase), expected);
    assertSteps(resolveLocalTurn(phrase), expected);
  }
});

test('намёки: нужна тишина -> пауза медиа и громкость 0', () => {
  const expected = [
    { tool: 'media_control', args: { action: 'pause', allowNoSession: true } },
    { tool: 'volume_set', args: { percent: 0 } },
  ];
  for (const phrase of ['нужна тишина', 'тишины бы']) {
    const plan = resolveLocalTurn(phrase);
    assertSteps(plan, expected);
    assert.equal(plan.isSequence, true);
  }
});

test('защита от ложных срабатываний: вопросы, сплетни, отрицания, идиомы и длинная проза', () => {
  const blocked = [
    'почему в комнате тихо?',
    'как сделать экран ярче?',
    'у соседа орет',
    'у соседа орёт музыка на всю улицу',
    'он орёт на весь дом',
    'не надо громче',
    'не делай тише',
    'звук не трогай',
    'темная тема выглядит отлично',
    'громко сказано конечно',
    'на улице темно',
    'я хочу в тихий океан',
    'удали всё с диска, тут бардак в окнах',
    'сделай ещё тише', // прямой императив без сарказма не переворачиваем в hints.js
    'сделай ещё громче',
    'Сегодня целый день обсуждали проект и потом я долго читал статьи в интернете, где мельком сказали что в соседнем зале слишком тихо звучит микрофон на сцене.',
  ];
  for (const phrase of blocked) {
    assert.equal(resolveHint(phrase), null, `ожидался null для resolveHint: ${phrase}`);
  }
  for (const phrase of ['почему в комнате тихо?', 'у соседа орет', 'не надо громче', 'темная тема выглядит отлично']) {
    assert.equal(resolveLocalTurn(phrase), null, `ожидался null для resolveLocalTurn: ${phrase}`);
  }
});

test('не ломает существующий оффлайн-разбор: «выключи звук» по-прежнему null в parseOffline', () => {
  assert.equal(parseOffline('выключи звук'), null);
  assert.equal(resolveHint('выключи звук'), null);
});

test('приоритет пользовательских команд и ограничения безопасности в resolveLocalTurn / resolveLocalTurnAsync', async () => {
  const store = {
    list: () => [
      {
        id: 'custom-silence',
        name: 'Свой режим тишины',
        phrases: ['нужна тишина'],
        steps: [{ tool: 'app_open', args: { name: 'notepad.exe' } }],
      },
    ],
  };
  const customHit = resolveLocalTurn('нужна тишина', { store });
  assert.equal(customHit.source, 'command');
  assert.equal(customHit.steps[0].tool, 'app_open');

  // Удалённый контекст (Telegram) запрещает ui_* и screen_*, но разрешает windows_arrange и media_control+volume_set.
  const remoteCheck = (name) => remoteAllowed({
    name,
    risk: name === 'volume_set' || name === 'screen_brightness' ? 'T0' : 'T1',
  });
  assert.equal(resolveLocalTurn('блин, слишком тихо', { remoteAllowed: remoteCheck }), null);
  assert.equal(await resolveLocalTurnAsync('темно как в пещере', { remoteAllowed: remoteCheck }), null);
  assertSteps(resolveLocalTurn('тут бардак в окнах', { remoteAllowed: remoteCheck }), [
    { tool: 'windows_arrange', args: { layout: 'grid' } },
  ]);
  assertSteps(await resolveLocalTurnAsync('нужна тишина', { remoteAllowed: remoteCheck }), [
    { tool: 'media_control', args: { action: 'pause', allowNoSession: true } },
    { tool: 'volume_set', args: { percent: 0 } },
  ]);

  // commandsToolCheck также уважается.
  assert.equal(resolveLocalTurn('тут бардак в окнах', { commandsToolCheck: () => ({ ok: false }) }), null);
});

test('сквозное выполнение плана намёка через runCommand', async () => {
  const plan = resolveLocalTurn('нужна тишина');
  const calls = [];
  const tools = new Map([
    ['media_control', { name: 'media_control', risk: 'T1', run: async (args) => { calls.push(['media_control', args]); return { ok: true, summary: 'пауза' }; } }],
    ['volume_set', { name: 'volume_set', risk: 'T0', run: async (args) => { calls.push(['volume_set', args]); return { ok: true, summary: 'звук 0%' }; } }],
  ]);
  const res = await runCommand(plan, { tools, mode: 'full', policy });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [
    ['media_control', { action: 'pause', allowNoSession: true }],
    ['volume_set', { percent: 0 }],
  ]);
});
