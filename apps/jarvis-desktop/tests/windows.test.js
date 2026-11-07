'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { windowsTools } = require('../src/tools/windows');

// Подменённый runner: запоминает вызовы и отдаёт заранее заданный ответ. Реальный PowerShell не запускается.
function fakeRunner(reply) {
  const calls = [];
  const runner = async (script, env, opts) => {
    calls.push({ script, env, opts });
    return reply;
  };
  return { runner, calls };
}

const okRun = (stdout) => ({ ok: true, summary: 'готово', data: { stdout, stderr: '' } });
const failRun = (summary) => ({ ok: false, summary, data: { stdout: '', stderr: '' } });

function byName(tools, name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `нет инструмента ${name}`);
  return tool;
}

describe('windows_list', () => {
  test('один объект в выводе даёт одно окно', async () => {
    const { runner } = fakeRunner(okRun('{"name":"notepad","title":"Untitled - Notepad"}\r\n'));
    const res = await byName(windowsTools(runner), 'windows_list').run({}, {});
    assert.deepEqual(res, {
      ok: true,
      summary: 'окон: 1',
      data: { windows: [{ name: 'notepad', title: 'Untitled - Notepad' }] },
    });
  });

  test('массив даёт все окна по порядку', async () => {
    const stdout = '[{"name":"chrome","title":"Почта - Chrome"},{"name":"Code","title":"windows.js - VS Code"}]';
    const { runner } = fakeRunner(okRun(stdout));
    const res = await byName(windowsTools(runner), 'windows_list').run({}, {});
    assert.deepEqual(res, {
      ok: true,
      summary: 'окон: 2',
      data: {
        windows: [
          { name: 'chrome', title: 'Почта - Chrome' },
          { name: 'Code', title: 'windows.js - VS Code' },
        ],
      },
    });
  });

  test('пустой вывод даёт пустой список', async () => {
    const { runner } = fakeRunner(okRun('  \r\n'));
    const res = await byName(windowsTools(runner), 'windows_list').run({}, {});
    assert.deepEqual(res, { ok: true, summary: 'окон: 0', data: { windows: [] } });
  });

  test('пустой массив в выводе даёт пустой список', async () => {
    const { runner } = fakeRunner(okRun('[]'));
    const res = await byName(windowsTools(runner), 'windows_list').run({}, {});
    assert.deepEqual(res, { ok: true, summary: 'окон: 0', data: { windows: [] } });
  });

  test('битый JSON → понятная ошибка разбора', async () => {
    const { runner } = fakeRunner(okRun('[{"name":"chrome","tit'));
    const res = await byName(windowsTools(runner), 'windows_list').run({}, {});
    assert.deepEqual(res, { ok: false, summary: 'не удалось разобрать список окон', data: {} });
  });

  test('элемент, не являющийся объектом → ошибка разбора', async () => {
    const { runner } = fakeRunner(okRun('[1, 2]'));
    const res = await byName(windowsTools(runner), 'windows_list').run({}, {});
    assert.deepEqual(res, { ok: false, summary: 'не удалось разобрать список окон', data: {} });
  });

  test('ошибка самого запуска PowerShell возвращается как есть', async () => {
    const { runner } = fakeRunner(failRun('таймаут 15000 мс'));
    const res = await byName(windowsTools(runner), 'windows_list').run({}, {});
    assert.deepEqual(res, { ok: false, summary: 'таймаут 15000 мс', data: {} });
  });

  test('signal из ctx передаётся в runner', async () => {
    const { runner, calls } = fakeRunner(okRun(''));
    const ctrl = new AbortController();
    await byName(windowsTools(runner), 'windows_list').run({}, { signal: ctrl.signal });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.signal, ctrl.signal);
  });
});

describe('windows_focus', () => {
  test('True → окно активировано', async () => {
    const { runner } = fakeRunner(okRun('True\r\n'));
    const res = await byName(windowsTools(runner), 'windows_focus').run({ title: 'Notepad' }, {});
    assert.deepEqual(res, { ok: true, summary: 'окно активировано', data: {} });
  });

  test('False → окно не найдено', async () => {
    const { runner } = fakeRunner(okRun('False\r\n'));
    const res = await byName(windowsTools(runner), 'windows_focus').run({ title: 'Notepad' }, {});
    assert.deepEqual(res, { ok: false, summary: 'окно с таким названием не найдено', data: {} });
  });

  test('ошибка запуска PowerShell не маскируется под «не найдено»', async () => {
    const { runner } = fakeRunner(failRun('код выхода 1'));
    const res = await byName(windowsTools(runner), 'windows_focus').run({ title: 'Notepad' }, {});
    assert.deepEqual(res, { ok: false, summary: 'код выхода 1', data: {} });
  });

  test('пустой или пробельный title отказывает без вызова runner', async () => {
    for (const title of ['', '   ', undefined, null]) {
      const { runner, calls } = fakeRunner(okRun('True'));
      const res = await byName(windowsTools(runner), 'windows_focus').run({ title }, {});
      assert.equal(res.ok, false, `title=${JSON.stringify(title)}`);
      assert.equal(calls.length, 0, `runner не должен вызываться, title=${JSON.stringify(title)}`);
    }
  });

  test('title длиннее 200 символов отказывает без вызова runner', async () => {
    const { runner, calls } = fakeRunner(okRun('True'));
    const res = await byName(windowsTools(runner), 'windows_focus').run({ title: 'я'.repeat(201) }, {});
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
  });

  test('title уходит в env JARVIS_TITLE и не попадает в текст скрипта', async () => {
    const title = 'Заметки "Блокнот"; Remove-Item C:\\ -Recurse';
    const { runner, calls } = fakeRunner(okRun('False'));
    await byName(windowsTools(runner), 'windows_focus').run({ title }, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].env.JARVIS_TITLE, title);
    assert.ok(calls[0].script.includes('$env:JARVIS_TITLE'));
    assert.equal(calls[0].script.includes(title), false);
    assert.equal(calls[0].script.includes('Remove-Item'), false);
  });

  test('title обрезается по краям перед передачей в env', async () => {
    const { runner, calls } = fakeRunner(okRun('True'));
    await byName(windowsTools(runner), 'windows_focus').run({ title: '  Notepad  ' }, {});
    assert.equal(calls[0].env.JARVIS_TITLE, 'Notepad');
  });

  test('signal из ctx передаётся в runner', async () => {
    const { runner, calls } = fakeRunner(okRun('True'));
    const ctrl = new AbortController();
    await byName(windowsTools(runner), 'windows_focus').run({ title: 'Notepad' }, { signal: ctrl.signal });
    assert.equal(calls[0].opts.signal, ctrl.signal);
  });
});

describe('метаданные инструментов', () => {
  test('три инструмента с нужными именами и рисками', () => {
    const tools = windowsTools(async () => okRun(''));
    assert.deepEqual(tools.map((t) => t.name), ['windows_list', 'windows_focus', 'windows_arrange', 'organize_workspace', 'restore_workspace']);
    assert.equal(byName(tools, 'windows_list').risk, 'T0');
    assert.equal(byName(tools, 'windows_focus').risk, 'T1');
    assert.equal(byName(tools, 'windows_arrange').risk, 'T1');
  });

  test('схема параметров: list без параметров, focus требует title 1–200, arrange требует layout', () => {
    const tools = windowsTools(async () => okRun(''));
    assert.deepEqual(byName(tools, 'windows_list').parameters, { type: 'object', properties: {} });
    const focus = byName(tools, 'windows_focus').parameters;
    assert.equal(focus.type, 'object');
    assert.deepEqual(focus.required, ['title']);
    assert.equal(focus.properties.title.type, 'string');
    assert.equal(focus.properties.title.minLength, 1);
    assert.equal(focus.properties.title.maxLength, 200);

    const arrange = byName(tools, 'windows_arrange').parameters;
    assert.equal(arrange.type, 'object');
    assert.deepEqual(arrange.required, ['layout']);
    assert.deepEqual(arrange.properties.layout.type, 'string');
    assert.deepEqual(arrange.properties.layout.enum, ['row', 'grid', 'cascade']);
  });
});
