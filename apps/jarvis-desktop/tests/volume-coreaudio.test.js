'use strict';

// Точная громкость через Windows Core Audio: проверяем, что в PowerShell уходят вызовы
// IAudioEndpointVolume, что установка подтверждается чтением обратно (допуск ±2%) и что
// при недоступном API честно включается старый путь SendKeys с «не проверено», а не тихий успех.
const test = require('node:test');
const assert = require('node:assert/strict');
const { systemToolsFactory } = require('../src/tools/system');
const { checkEffect } = require('../src/agent/effects');

const find = (list, name) => list.find((t) => t.name === name);
const okJson = (obj) => ({ ok: true, summary: 'готово', data: { stdout: JSON.stringify(obj) + '\n' } });

// Подменный runner: запоминает скрипты и отдаёт заранее заданные ответы по порядку.
function fakeRunner(responses) {
  const calls = [];
  const runner = async (script, env, options) => {
    calls.push({ script, env, options });
    const next = responses.shift();
    if (!next) throw new Error('лишний вызов PowerShell');
    return typeof next === 'function' ? next(script, env) : next;
  };
  return { runner, calls };
}

const coreAudioRead = (percent, mute) => okJson({ ok: true, mode: 'coreaudio', percent, mute });
const coreAudioSet = (percent, before, after, mute) => okJson({ ok: true, mode: 'coreaudio', percent, before, after, mute });

const CORE_MARKERS = ['IAudioEndpointVolume', 'GetMasterVolumeLevelScalar', 'GetMute'];

function assertCoreAudioScript(script) {
  for (const marker of CORE_MARKERS) assert.ok(script.includes(marker), 'в скрипте нет ' + marker);
  assert.ok(script.includes("@'"), 'C# должен идти в here-string');
}

test('volume_get: T0, без параметров, отдаёт точный процент и mute', async () => {
  const { runner, calls } = fakeRunner([coreAudioRead(37, true)]);
  const tool = find(systemToolsFactory({ runner }), 'volume_get');
  assert.equal(tool.risk, 'T0');
  assert.deepEqual(tool.parameters, { type: 'object', properties: {} });
  const res = await tool.run({});
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { mode: 'coreaudio', percent: 37, mute: true });
  assert.match(res.summary, /37%/);
  assert.match(res.summary, /звук выключен/);
  assert.equal(calls.length, 1);
  assertCoreAudioScript(calls[0].script);
  assert.ok(calls[0].script.includes('GetMasterVolumeLevelScalar'));
});

test('volume_get: без Core Audio — честный отказ, а не выдуманный процент', async () => {
  const { runner } = fakeRunner([okJson({ ok: false, mode: 'unavailable', error: 'нет устройства' })]);
  const tool = find(systemToolsFactory({ runner }), 'volume_get');
  const res = await tool.run({});
  assert.equal(res.ok, false);
  assert.match(res.summary, /не удалось узнать громкость/);
  assert.match(res.summary, /Core Audio/);
  assert.deepEqual(res.data, { mode: 'unavailable' });

  const { runner: silent } = fakeRunner([{ ok: true, summary: 'готово', data: { stdout: '' } }]);
  const quiet = await find(systemToolsFactory({ runner: silent }), 'volume_get').run({});
  assert.equal(quiet.ok, false);
  assert.match(quiet.summary, /не удалось узнать громкость/);
});

test('volume_set: ставит через SetMasterVolumeLevelScalar, verify читает обратно и подтверждает', async () => {
  const { runner, calls } = fakeRunner([coreAudioSet(20, 38, 20, false), coreAudioRead(20, false)]);
  const tool = find(systemToolsFactory({ runner }), 'volume_set');
  const res = await tool.run({ percent: 20 });
  assert.equal(res.ok, true);
  assert.equal(res.data.mode, 'coreaudio');
  assert.equal(res.data.before, 38);
  assert.equal(res.data.after, 20);
  assert.match(res.summary, /громкость 20%/);
  assertCoreAudioScript(calls[0].script);
  assert.ok(calls[0].script.includes('SetMasterVolumeLevelScalar'));
  assert.ok(calls[0].script.includes('$target = 20'));

  const checked = await checkEffect(tool, { percent: 20 }, res, {});
  assert.equal(checked.verified, 'confirmed');
  assert.match(checked.evidence, /20%/);
  assert.equal(calls.length, 2);
  // Проверка только читает: в скрипте verify нет вызова установки (типы C# общие, это не вызов).
  assert.ok(calls[1].script.includes('[NoxVolume.Core]::GetPercent()'));
  assert.ok(!calls[1].script.includes('[NoxVolume.Core]::SetPercent('));
});

test('volume_set: verify с допуском ±2%: 21 при цели 20 — подтверждено, 25 — провал с числами', async () => {
  const near = fakeRunner([coreAudioSet(20, 40, 20, false), coreAudioRead(21, false)]);
  const nearTool = find(systemToolsFactory({ runner: near.runner }), 'volume_set');
  const nearRes = await nearTool.run({ percent: 20 });
  const nearChecked = await checkEffect(nearTool, { percent: 20 }, nearRes, {});
  assert.equal(nearChecked.verified, 'confirmed');

  const far = fakeRunner([coreAudioSet(20, 40, 20, false), coreAudioRead(25, false)]);
  const farTool = find(systemToolsFactory({ runner: far.runner }), 'volume_set');
  const farRes = await farTool.run({ percent: 20 });
  const farChecked = await checkEffect(farTool, { percent: 20 }, farRes, {});
  assert.equal(farChecked.verified, 'failed');
  assert.equal(farChecked.ok, false);
  assert.match(farChecked.summary, /25%/);
  assert.match(farChecked.evidence, /25%/);
  assert.match(farChecked.evidence, /20%/);
});

test('volume_set: Core Audio недоступен — старый SendKeys, verify «не проверено» с честной пометкой', async () => {
  const { runner, calls } = fakeRunner([okJson({ ok: true, mode: 'sendkeys', percent: 20, error: 'нет устройства' })]);
  const tool = find(systemToolsFactory({ runner }), 'volume_set');
  const res = await tool.run({ percent: 20 });
  assert.equal(res.ok, true);
  assert.equal(res.data.mode, 'sendkeys');
  assert.match(res.summary, /~20%/);
  assert.ok(calls[0].script.includes('[char]174'));
  assert.ok(calls[0].script.includes('[char]175'));

  const checked = await checkEffect(tool, { percent: 20 }, res, {});
  assert.equal(checked.verified, 'unknown');
  assert.equal(checked.ok, true);
  assert.match(checked.summary, /не проверено/);
  assert.match(checked.evidence, /нажатиями/);
});

test('volume_set: пустой ответ не выдаётся за точный — режим неизвестен, verify «не проверено»', async () => {
  const { runner } = fakeRunner([{ ok: true, summary: 'готово', data: { stdout: '' } }]);
  const tool = find(systemToolsFactory({ runner }), 'volume_set');
  const res = await tool.run({ percent: 20 });
  assert.equal(res.ok, true);
  assert.equal(res.data.mode, 'unknown');
  assert.match(res.summary, /~20%/);
  const checked = await checkEffect(tool, { percent: 20 }, res, {});
  assert.equal(checked.verified, 'unknown');
});

test('volume_set: ошибка Core Audio не подменяется нажатиями, процент проверяется', async () => {
  const { runner } = fakeRunner([okJson({ ok: false, mode: 'coreaudio', percent: 20, error: 'отказ устройства' })]);
  const tool = find(systemToolsFactory({ runner }), 'volume_set');
  const res = await tool.run({ percent: 20 });
  assert.equal(res.ok, false);
  assert.match(res.summary, /не удалось установить громкость/);
  assert.match(res.summary, /отказ устройства/);

  const unreachable = systemToolsFactory({ runner: async () => { throw new Error('не должен вызываться'); } });
  const bad = await find(unreachable, 'volume_set').run({ percent: 101 });
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /от 0 до 100/);
});

test('volume_set: verify при сбое чтения обратно — «не проверено», не подтверждено и не провалено', async () => {
  const { runner } = fakeRunner([coreAudioSet(20, 40, 20, false), okJson({ ok: false, mode: 'unavailable', error: 'устройство пропало' })]);
  const tool = find(systemToolsFactory({ runner }), 'volume_set');
  const res = await tool.run({ percent: 20 });
  const checked = await checkEffect(tool, { percent: 20 }, res, {});
  assert.equal(checked.verified, 'unknown');
  assert.match(checked.evidence, /прочитать громкость обратно/);
});
