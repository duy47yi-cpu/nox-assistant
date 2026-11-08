'use strict';

// Частые действия без модели: закрыть окно и окна, яркость, громкость, чтение вслух, экран, погода.
// Каждая фраза даёт шаги с настоящими инструментами; сами инструменты проверяются через подменённый PowerShell.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOffline } = require('../src/shortcuts/offline');
const { displayTools, parsePercent, SET_SCRIPT, READ_SCRIPT, MIN_PERCENT } = require('../src/tools/display');
const { windowsCloseTools, parseActive, ACTIVE_SCRIPT } = require('../src/tools/windows-close');
const { splitForSpeech, speakChunks, READ_LIMIT, READ_CHUNK, desktopTools } = require('../src/tools/desktop');
const { uiTools } = require('../src/tools/ui');
const { systemTools } = require('../src/tools/system');
const { weatherTools } = require('../src/tools/weather');

const ok = (stdout) => ({ ok: true, summary: 'ok', data: { stdout } });
// Ответы идут по очереди; функция вместо ответа получает скрипт и env и отвечает сама.
function fakeRunner(...answers) {
  const calls = [];
  const runner = async (script, env, opts) => {
    calls.push({ script, env, opts });
    const next = answers.shift();
    return typeof next === 'function' ? next(script, env) : next;
  };
  return { runner, calls };
}
const findTool = (tools, name) => tools.find((t) => t.name === name);

test('фразы окон: «закрой окна» и «закрой окно» без модели, разные инструменты', () => {
  assert.deepEqual(parseOffline('закрой окна').steps, [{ tool: 'windows_close_all', args: {} }]);
  assert.deepEqual(parseOffline('Закрой все окна.').steps, [{ tool: 'windows_close_all', args: {} }]);
  assert.deepEqual(parseOffline('закрой окно').steps, [{ tool: 'window_close_active', args: {} }]);
  assert.deepEqual(parseOffline('закрой это окно').steps, [{ tool: 'window_close_active', args: {} }]);
});

test('яркость: число, слова и относительное изменение; выход за 0–100 не распознаётся', () => {
  assert.deepEqual(parseOffline('яркость 40').steps, [{ tool: 'screen_brightness', args: { percent: 40 } }]);
  assert.deepEqual(parseOffline('поставь яркость экрана на 70 процентов').steps, [{ tool: 'screen_brightness', args: { percent: 70 } }]);
  assert.deepEqual(parseOffline('яркость пятьдесят').steps, [{ tool: 'screen_brightness', args: { percent: 50 } }]);
  assert.equal(parseOffline('яркость 150'), null);
  assert.deepEqual(parseOffline('ярче').steps, [{ tool: 'screen_brightness', args: { change: 20 } }]);
  assert.deepEqual(parseOffline('сделай темнее').steps, [{ tool: 'screen_brightness', args: { change: -20 } }]);
});

test('громкость: «уровень громкости N» — то же, что «громкость N»; «громче» и «тише» — нажатия клавиш', () => {
  assert.deepEqual(parseOffline('уровень громкости 30').steps, [{ tool: 'volume_set', args: { percent: 30 } }]);
  assert.deepEqual(parseOffline('громкость 30').steps, [{ tool: 'volume_set', args: { percent: 30 } }]);
  assert.equal(parseOffline('громкость 150'), null);
  const up = parseOffline('громче').steps[0];
  assert.equal(up.tool, 'ui_keys');
  assert.equal(up.args.keys.split(' ').length, 5);
  assert.ok(up.args.keys.split(' ').every((key) => key === 'volume_up'));
  assert.ok(parseOffline('тише').steps[0].args.keys.startsWith('volume_down'));
});

test('чтение вслух: буфер и выделенное (копирование, пауза, чтение)', () => {
  assert.deepEqual(parseOffline('прочитай вслух').steps, [{ tool: 'read_clipboard_aloud', args: {} }]);
  const sel = parseOffline('прочитай выделенное').steps;
  assert.deepEqual(sel.map((step) => step.tool), ['ui_keys', 'wait', 'read_clipboard_aloud']);
  assert.deepEqual(sel[0].args, { keys: 'ctrl+c' });
});

test('экран, погода и блокировка: короткие фразы; опасные выключения здесь не разбираются', () => {
  assert.deepEqual(parseOffline('выключи монитор').steps, [{ tool: 'monitor_off', args: {} }]);
  assert.deepEqual(parseOffline('заблокируй экран').steps, [{ tool: 'ui_keys', args: { keys: 'win+l' } }]);
  assert.deepEqual(parseOffline('погода').steps, [{ tool: 'weather_now', args: {} }]);
  assert.equal(parseOffline('выключи компьютер'), null);
  assert.equal(parseOffline('выключи звук'), null);
});

test('каждый шаг быстрых фраз — настоящий инструмент из реестров', () => {
  const registry = new Map([
    ...displayTools().map((t) => [t.name, t]),
    ...windowsCloseTools({}).map((t) => [t.name, t]),
    ...desktopTools.map((t) => [t.name, t]),
    ...uiTools().map((t) => [t.name, t]),
    ...systemTools.map((t) => [t.name, t]),
    ...weatherTools({}).map((t) => [t.name, t]),
  ]);
  const phrases = ['закрой окна', 'закрой окно', 'яркость 50', 'ярче', 'темнее', 'громче', 'тише', 'уровень громкости 20',
    'прочитай вслух', 'прочитай выделенное', 'выключи монитор', 'заблокируй экран', 'погода'];
  for (const phrase of phrases) {
    const parsed = parseOffline(phrase);
    assert.ok(parsed, phrase);
    for (const step of parsed.steps) assert.ok(registry.has(step.tool), `${phrase}: нет инструмента ${step.tool}`);
  }
});

test('screen_brightness: ставит процент, меняет на шаг, держит минимум и честно отказывает на внешнем мониторе', async () => {
  assert.deepEqual([parsePercent('45\r\n'), parsePercent('none'), parsePercent('150')], [45, null, null]);
  const first = fakeRunner(ok('60'), ok('ok'));
  const res = await findTool(displayTools({ runner: first.runner }), 'screen_brightness').run({ percent: 40 }, {});
  assert.equal(res.ok, true);
  assert.equal(first.calls[0].script, READ_SCRIPT);
  assert.equal(first.calls[1].script, SET_SCRIPT);
  assert.equal(first.calls[1].env.JARVIS_BRIGHT, '40');

  const relative = fakeRunner(ok('50'), ok('ok'));
  const up = await findTool(displayTools({ runner: relative.runner }), 'screen_brightness').run({ change: 20 }, {});
  assert.equal(up.data.percent, 70);
  assert.equal(relative.calls[1].env.JARVIS_BRIGHT, '70');

  const low = fakeRunner(ok('30'), ok('ok'));
  const down = await findTool(displayTools({ runner: low.runner }), 'screen_brightness').run({ change: -50 }, {});
  assert.equal(down.data.percent, MIN_PERCENT);
  assert.match(down.summary, /меньше 10%/);

  const external = fakeRunner(ok('none'));
  const no = await findTool(displayTools({ runner: external.runner }), 'screen_brightness').run({ percent: 40 }, {});
  assert.equal(no.ok, false);
  assert.match(no.summary, /не отвечают/);
  // Оба пути есть в скрипте: DDC/CI для внешнего монитора и WMI для экрана ноутбука.
  assert.match(READ_SCRIPT, /JarvisDdc/);
  assert.match(READ_SCRIPT, /WmiMonitorBrightness/);
  assert.match(SET_SCRIPT, /WmiSetBrightness/);

  const both = await findTool(displayTools({ runner: fakeRunner().runner }), 'screen_brightness').run({ percent: 40, change: 10 }, {});
  assert.equal(both.ok, false);
});

test('screen_brightness: сверка чтением обратно с допуском в 2 пункта', async () => {
  const tool = (answer) => findTool(displayTools({ runner: fakeRunner(ok(answer)).runner }), 'screen_brightness');
  const confirmed = await tool('41').verify({}, { data: { percent: 40 } }, {});
  assert.equal(confirmed.status, 'confirmed');
  const failed = await tool('55').verify({}, { data: { percent: 40 } }, {});
  assert.equal(failed.status, 'failed');
});

test('window_close_active: разбор статусов скрипта и понятный ответ по каждому', async () => {
  assert.equal(parseActive('{"status":"closed","name":"notepad","title":"Заметки"}').status, 'closed');
  assert.equal(parseActive('').status, 'none');
  assert.match(ACTIVE_SCRIPT, /JARVIS_CLOSE/);
  assert.match(ACTIVE_SCRIPT, /JARVIS_KEEP_PIDS/);

  const run = async (answer) => {
    const runner = fakeRunner(ok(answer));
    const tool = findTool(windowsCloseTools({ runner: runner.runner }), 'window_close_active');
    return { res: await tool.run({}, {}), runner, tool };
  };
  const closed = await run('{"status":"closed","name":"notepad","title":"Без имени — Блокнот"}');
  assert.equal(closed.res.ok, true);
  assert.equal(closed.runner.calls[0].env.JARVIS_CLOSE, '1');
  assert.equal((await closed.tool.verify({}, closed.res, {})).status, 'confirmed');

  const stuck = await run('{"status":"still_open","name":"winword","title":"Отчёт.docx"}');
  assert.equal(stuck.res.ok, false);
  assert.match(stuck.res.summary, /сохранении/);

  const own = await run('{"status":"protected"}');
  assert.match(own.res.summary, /Джарвиса или Windows/);

  const dialog = await run('{"status":"not_main"}');
  assert.match(dialog.res.summary, /диалог/);

  const none = await run('{"status":"none"}');
  assert.match(none.res.summary, /активного окна нет/);
});

test('чтение вслух: режет по предложениям, не длиннее 220 символов на кусок, лимит 1500', () => {
  const sentence = 'Это короткое предложение для проверки чтения. ';
  const parts = splitForSpeech(sentence.repeat(60));
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= READ_CHUNK, part);
  assert.ok(parts.join(' ').length <= READ_LIMIT);
  assert.deepEqual(splitForSpeech('  Привет   мир  '), ['Привет мир']);
  assert.deepEqual(splitForSpeech(''), []);
  const long = splitForSpeech('а'.repeat(5000));
  assert.ok(long.join('').length <= READ_LIMIT);
});

test('чтение вслух: куски говорятся по очереди и останавливаются по сигналу', async () => {
  const said = [];
  await speakChunks(['один', 'два', 'три'], async (part) => { said.push(part); }, undefined);
  assert.deepEqual(said, ['один', 'два', 'три']);

  const controller = new AbortController();
  const stopped = [];
  await speakChunks(['а', 'б', 'в'], async (part) => {
    stopped.push(part);
    if (part === 'а') controller.abort();
  }, controller.signal);
  assert.deepEqual(stopped, ['а']);
});
