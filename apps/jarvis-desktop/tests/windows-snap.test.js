'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { windowsTools } = require('../src/tools/windows');

const okRun = (obj) => ({ ok: true, summary: 'готово', data: { stdout: JSON.stringify(obj), stderr: '' } });
const snapTool = (runner) => windowsTools(runner).find((t) => t.name === 'windows_snap');
function fakeRunner(...replies) {
  const calls = [];
  const runner = async (script, env) => { calls.push({ script, env }); return replies[Math.min(calls.length - 1, replies.length - 1)]; };
  return { runner, calls };
}
const found = (side, extra = {}) => okRun({ ok: true, hwnd: 777, title: 'Безымянный — Блокнот', process: 'notepad', side, expected: { x: 0, y: 0, w: 960, h: 1040 }, ...extra });

describe('windows_snap', () => {
  test('риск T1, сторона обязательна и проверяется до запуска', async () => {
    const { runner, calls } = fakeRunner(found('left'));
    const tool = snapTool(runner);
    assert.equal(tool.risk, 'T1');
    const res = await tool.run({ side: 'diagonal' }, {});
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
  });

  test('передаёт title, сторону и pid Nox через env, не в тексте скрипта', async () => {
    const { runner, calls } = fakeRunner(found('left'));
    const res = await snapTool(runner).run({ title: 'Блокнот', side: 'left' }, {});
    assert.equal(res.ok, true);
    const req = JSON.parse(calls[0].env.JARVIS_SNAP);
    assert.deepEqual(req, { title: 'Блокнот', side: 'left', noxPid: process.pid });
    assert.ok(!calls[0].script.includes('Блокнот'));
    assert.equal(res.data.hwnd, 777);
  });

  test('без title — отказ до запуска, просит назвать окно', async () => {
    const { runner, calls } = fakeRunner(found('right'));
    const res = await snapTool(runner).run({ side: 'right' }, {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /назови окно/);
    assert.equal(calls.length, 0);
  });

  test('title не найден — отказ с названием', async () => {
    const { runner } = fakeRunner(okRun({ ok: false, reason: 'not_found' }));
    const res = await snapTool(runner).run({ title: 'Калькулятор', side: 'left' }, {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /Калькулятор/);
  });

  test('сбой запуска и битый ответ — не успех', async () => {
    const bad = await snapTool(fakeRunner({ ok: false, summary: 'таймаут', data: {} }).runner).run({ side: 'left' }, {});
    assert.equal(bad.ok, false);
    const junk = await snapTool(fakeRunner({ ok: true, summary: '', data: { stdout: 'не json' } }).runner).run({ side: 'left' }, {});
    assert.equal(junk.ok, false);
  });

  test('скрипт не закрывает окна и не трогает процессы Nox', async () => {
    const { runner, calls } = fakeRunner(found('left'));
    await snapTool(runner).run({ title: 'Блокнот', side: 'left' }, {});
    return Promise.resolve().then(() => {
      const s = calls[0].script;
      assert.match(s, /noxPid/);
      assert.match(s, /Shell_TrayWnd/);
      assert.ok(!/WM_CLOSE|CloseMainWindow|Stop-Process|\.Kill\(/.test(s));
    });
  });

  describe('verify', () => {
    const result = (side) => ({ ok: true, data: { hwnd: 777, title: 'Блокнот', process: 'notepad', side, expected: { x: 0, y: 0, w: 960, h: 1040 } } });
    const opts = { pollTimeoutMs: 50 };

    test('left: положение в допуске — confirmed', async () => {
      const { runner } = fakeRunner(okRun({ exists: true, iconic: false, zoomed: false, x: 2, y: 0, w: 958, h: 1040 }));
      assert.equal((await snapTool(runner).verify({}, result('left'), opts)).status, 'confirmed');
    });
    test('left: окно не сдвинулось — failed', async () => {
      const { runner } = fakeRunner(okRun({ exists: true, iconic: false, zoomed: false, x: 300, y: 100, w: 800, h: 600 }));
      assert.equal((await snapTool(runner).verify({}, result('left'), opts)).status, 'failed');
    });
    test('maximize и minimize читают состояние окна', async () => {
      const max = fakeRunner(okRun({ exists: true, iconic: false, zoomed: true, x: 0, y: 0, w: 1920, h: 1040 }));
      assert.equal((await snapTool(max.runner).verify({}, result('maximize'), opts)).status, 'confirmed');
      const min = fakeRunner(okRun({ exists: true, iconic: false, zoomed: false, x: 0, y: 0, w: 800, h: 600 }));
      assert.equal((await snapTool(min.runner).verify({}, result('minimize'), opts)).status, 'failed');
    });
    test('окно исчезло — failed; чтение не удалось — unknown; нет данных — unknown', async () => {
      assert.equal((await snapTool(fakeRunner(okRun({ exists: false })).runner).verify({}, result('left'), opts)).status, 'failed');
      assert.equal((await snapTool(fakeRunner({ ok: false, summary: 'x', data: {} }).runner).verify({}, result('left'), opts)).status, 'unknown');
      assert.equal((await snapTool(fakeRunner().runner).verify({}, { ok: false }, opts)).status, 'unknown');
    });
  });
});
