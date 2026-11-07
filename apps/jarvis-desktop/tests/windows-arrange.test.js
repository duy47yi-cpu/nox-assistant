'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { windowsTools, computeLayout } = require('../src/tools/windows');

function okRun(stdout) {
  return { ok: true, summary: 'готово', data: { stdout, stderr: '' } };
}
function failRun(summary) {
  return { ok: false, summary, data: { stdout: '', stderr: '' } };
}

function byName(tools, name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `нет инструмента ${name}`);
  return tool;
}

function fakeRunner(reply) {
  const calls = [];
  const runner = async (script, env, opts) => {
    calls.push({ script, env, opts });
    return reply;
  };
  return { runner, calls };
}

function enumWith(windows, area) {
  const a = area || { x: 0, y: 0, w: 1920, h: 1040 };
  return okRun(JSON.stringify({ area: a, windows }));
}

describe('computeLayout', () => {
  test('row — ровно count прямоугольников, по горизонтали, зазор 8px', () => {
    const r = computeLayout('row', 3, { x: 0, y: 0, w: 300, h: 200 });
    assert.equal(r.length, 3);
    assert.deepEqual(r[0], { x: 0, y: 0, w: 94, h: 200 });
    assert.deepEqual(r[1], { x: 102, y: 0, w: 94, h: 200 });
    assert.deepEqual(r[2], { x: 204, y: 0, w: 94, h: 200 });
  });

  test('grid 4 и 6 — правильное число строк и столбцов', () => {
    const r4 = computeLayout('grid', 4, { x: 0, y: 0, w: 300, h: 300 });
    assert.equal(r4.length, 4);
    assert.deepEqual(r4[0], { x: 0, y: 0, w: 146, h: 146 });
    assert.deepEqual(r4[1], { x: 154, y: 0, w: 146, h: 146 });
    assert.deepEqual(r4[2], { x: 0, y: 154, w: 146, h: 146 });
    assert.deepEqual(r4[3], { x: 154, y: 154, w: 146, h: 146 });

    const r6 = computeLayout('grid', 6, { x: 0, y: 0, w: 300, h: 300 });
    // cols=3, rows=2, cellW=94, cellH=146
    assert.equal(r6.length, 6);
    assert.deepEqual(r6[2], { x: 204, y: 0, w: 94, h: 146 });
    assert.deepEqual(r6[3], { x: 0, y: 154, w: 94, h: 146 });
  });

  test('cascade — смещение +40,+40, 70% площади, обрезка по границе', () => {
    const r = computeLayout('cascade', 3, { x: 0, y: 0, w: 300, h: 200 });
    assert.deepEqual(r[0], { x: 0, y: 0, w: 210, h: 140 });
    assert.deepEqual(r[1], { x: 40, y: 40, w: 210, h: 140 });
    assert.deepEqual(r[2], { x: 80, y: 60, w: 210, h: 140 });
  });

  test('fill — ровно count прямоугольников на всю область', () => {
    const r = computeLayout('fill', 3, { x: 0, y: 0, w: 300, h: 200 });
    assert.equal(r.length, 3);
    for (const rect of r) assert.deepEqual(rect, { x: 0, y: 0, w: 300, h: 200 });
  });

  test('все координаты целые и внутри area', () => {
    const a = { x: 10, y: 20, w: 100, h: 100 };
    for (const layout of ['row', 'grid', 'cascade']) {
      const r = computeLayout(layout, 2, a);
      for (const rect of r) {
        assert.ok(Number.isInteger(rect.x));
        assert.ok(Number.isInteger(rect.y));
        assert.ok(Number.isInteger(rect.w));
        assert.ok(Number.isInteger(rect.h));
        assert.ok(rect.x >= a.x && rect.x + rect.w <= a.x + a.w);
        assert.ok(rect.y >= a.y && rect.y + rect.h <= a.y + a.h);
      }
    }
  });

  test('row и grid не пересекаются', () => {
    for (const layout of ['row', 'grid']) {
      const r = computeLayout(layout, 4, { x: 0, y: 0, w: 300, h: 300 });
      for (let i = 0; i < r.length; i++) {
        for (let j = i + 1; j < r.length; j++) {
          const a = r[i], b = r[j];
          assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
            `overlap ${layout} ${i} ${j}`);
        }
      }
    }
  });

  test('неверный layout — TypeError', () => {
    assert.throws(() => computeLayout('diagonal', 2, { x: 0, y: 0, w: 100, h: 100 }), /неизвестная раскладка/);
  });

  test('меньше 2 окон или нецелое count — RangeError', () => {
    assert.throws(() => computeLayout('grid', 1, { x: 0, y: 0, w: 100, h: 100 }), /нужно от 2 до 9/);
    assert.throws(() => computeLayout('grid', 2.5, { x: 0, y: 0, w: 100, h: 100 }), /нужно от 2 до 9/);
  });
});

describe('windows_arrange', () => {
  const baseWindows = [
    { hwnd: 100, title: 'Notepad', left: 0, top: 0, right: 400, bottom: 300, minimized: false },
    { hwnd: 200, title: 'VS Code', left: 0, top: 0, right: 800, bottom: 600, minimized: false },
    { hwnd: 300, title: 'Chrome', left: 0, top: 0, right: 1200, bottom: 900, minimized: true },
  ];

  test('менее 2 подходящих окон — отказ', async () => {
    const { runner } = fakeRunner(enumWith(baseWindows.slice(0, 1)));
    const res = await byName(windowsTools(runner), 'windows_arrange').run({ layout: 'grid' }, {});
    assert.equal(res.ok, false);
    assert.ok(res.summary.includes('нужно минимум 2'));
  });

  test('свёрнутые окна пропускаются', async () => {
    const { runner } = fakeRunner(enumWith(baseWindows));
    const res = await byName(windowsTools(runner), 'windows_arrange').run({ layout: 'row' }, {});
    assert.equal(res.ok, true);
    assert.equal(res.data.placed.length, 2);
    assert.equal(res.data.placed[0].title, 'Notepad');
    assert.equal(res.data.placed[1].title, 'VS Code');
  });

  test('фильтр по titles — подстрока без регистра', async () => {
    const { runner } = fakeRunner(enumWith(baseWindows));
    const res = await byName(windowsTools(runner), 'windows_arrange').run({ layout: 'cascade', titles: ['note', 'CODE'] }, {});
    assert.equal(res.ok, true);
    assert.equal(res.data.placed.length, 2);
    assert.equal(res.data.placed[0].title, 'Notepad');
    assert.equal(res.data.placed[1].title, 'VS Code');
  });

  test('не подходящие titles — ноль окон, отказ', async () => {
    const { runner } = fakeRunner(enumWith(baseWindows));
    const res = await byName(windowsTools(runner), 'windows_arrange').run({ layout: 'grid', titles: ['photoshop'] }, {});
    assert.equal(res.ok, false);
    assert.ok(res.summary.includes('нужно минимум 2'));
  });

  test('больше 9 — обрезает до 9', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      hwnd: 1000 + i, title: `Win ${i + 1}`, left: 0, top: 0, right: 100, bottom: 100, minimized: false,
    }));
    const { runner } = fakeRunner(enumWith(many));
    const res = await byName(windowsTools(runner), 'windows_arrange').run({ layout: 'grid' }, {});
    assert.equal(res.ok, true);
    assert.equal(res.data.placed.length, 9);
  });

  test('happy path — применяет MoveWindow и возвращает placed', async () => {
    const windows = [
      { hwnd: 10, title: 'A', left: 0, top: 0, right: 400, bottom: 300, minimized: false },
      { hwnd: 20, title: 'B', left: 0, top: 0, right: 800, bottom: 600, minimized: false },
    ];
    const applyReply = okRun(JSON.stringify({ moved: 2 }));
    const { runner, calls } = fakeRunner(enumWith(windows, { x: 0, y: 0, w: 1920, h: 1040 }, applyReply));
    const tool = byName(windowsTools(runner), 'windows_arrange');
    const res = await tool.run({ layout: 'grid' }, {});
    assert.equal(res.ok, true);
    assert.equal(res.summary, 'разложил 2 окон: сетка 2×1');
    assert.equal(res.data.placed.length, 2);
    assert.equal(res.data.layout, 'grid');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].env.JARVIS_ARRANGE.includes('"hwnd":10'));
    assert.ok(calls[1].env.JARVIS_ARRANGE.includes('"hwnd":20'));
  });

  test('layout в env не попадает в текст скрипта', async () => {
    const windows = [
      { hwnd: 10, title: 'A', left: 0, top: 0, right: 400, bottom: 300, minimized: false },
      { hwnd: 20, title: 'B', left: 0, top: 0, right: 800, bottom: 600, minimized: false },
    ];
    const { runner, calls } = fakeRunner(okRun(JSON.stringify({ area: { x: 0, y: 0, w: 1920, h: 1040 }, windows })));
    const tool = byName(windowsTools(runner), 'windows_arrange');
    await tool.run({ layout: 'grid', titles: ['A', 'B'] }, {});
    assert.equal(calls.length, 2);
    assert.equal(calls[1].env.JARVIS_ARRANGE.includes('MoveWindow'), false);
    assert.ok(calls[1].env.JARVIS_ARRANGE.includes('10'));
  });

  test('layout приходит в env и не в тексте скрипта', async () => {
    const windows = [
      { hwnd: 10, title: 'A', left: 0, top: 0, right: 400, bottom: 300, minimized: false },
      { hwnd: 20, title: 'B', left: 0, top: 0, right: 800, bottom: 600, minimized: false },
    ];
    const { runner, calls } = fakeRunner(okRun(JSON.stringify({ area: { x: 0, y: 0, w: 1920, h: 1040 }, windows })));
    const tool = byName(windowsTools(runner), 'windows_arrange');
    await tool.run({ layout: 'cascade', titles: ['A', 'B'] }, {});
    assert.equal(calls.length, 2);
    assert.ok(calls[1].env.JARVIS_ARRANGE.includes('cascade') === false);
    assert.ok(calls[1].env.JARVIS_ARRANGE.includes('"hwnd":10'));
  });

  test('signal из ctx передаётся в runner', async () => {
    const windows = [
      { hwnd: 10, title: 'A', left: 0, top: 0, right: 400, bottom: 300, minimized: false },
      { hwnd: 20, title: 'B', left: 0, top: 0, right: 800, bottom: 600, minimized: false },
    ];
    const { runner, calls } = fakeRunner(enumWith(windows, { x: 0, y: 0, w: 1920, h: 1040 }, okRun(JSON.stringify({ moved: 2 }))));
    const ctrl = new AbortController();
    const tool = byName(windowsTools(runner), 'windows_arrange');
    await tool.run({ layout: 'row' }, { signal: ctrl.signal });
    assert.equal(calls[0].opts.signal, ctrl.signal);
    assert.equal(calls[1].opts.signal, ctrl.signal);
  });

  test('verify: confirmed — все окна на месте', async () => {
    const placed = [
      { hwnd: 10, title: 'A', x: 0, y: 0, w: 100, h: 100 },
      { hwnd: 20, title: 'B', x: 110, y: 0, w: 100, h: 100 },
    ];
    const current = [
      { hwnd: 10, title: 'A', left: 0, top: 0, right: 100, bottom: 100, minimized: false },
      { hwnd: 20, title: 'B', left: 110, top: 0, right: 210, bottom: 100, minimized: false },
    ];
    const tool = byName(windowsTools(async (script) => {
      if (script.includes('MoveWindow')) return okRun(JSON.stringify({ moved: 2 }));
      return enumWith(current);
    }), 'windows_arrange');
    const verdict = await tool.verify({ layout: 'grid' }, { ok: true, data: { placed } }, {});
    assert.equal(verdict.status, 'confirmed');
    assert.ok(verdict.evidence.includes('на месте'));
  });

  test('verify: failed — окно сдвинулось', async () => {
    const placed = [
      { hwnd: 10, title: 'A', x: 0, y: 0, w: 100, h: 100 },
    ];
    const current = [
      { hwnd: 10, title: 'A', left: 20, top: 0, right: 120, bottom: 100, minimized: false },
    ];
    const tool = byName(windowsTools(async () => enumWith(current)), 'windows_arrange');
    const verdict = await tool.verify({ layout: 'grid' }, { ok: true, data: { placed } }, {});
    assert.equal(verdict.status, 'failed');
    assert.ok(verdict.evidence.includes('сдвинулось'));
  });

  test('verify: failed — окно исчезло', async () => {
    const placed = [
      { hwnd: 10, title: 'A', x: 0, y: 0, w: 100, h: 100 },
    ];
    const tool = byName(windowsTools(async () => enumWith([])), 'windows_arrange');
    const verdict = await tool.verify({ layout: 'grid' }, { ok: true, data: { placed } }, {});
    assert.equal(verdict.status, 'failed');
    assert.ok(verdict.evidence.includes('исчезло'));
  });

  test('verify: failed — окно свернуто', async () => {
    const placed = [
      { hwnd: 10, title: 'A', x: 0, y: 0, w: 100, h: 100 },
    ];
    const current = [
      { hwnd: 10, title: 'A', left: 0, top: 0, right: 100, bottom: 100, minimized: true },
    ];
    const tool = byName(windowsTools(async () => enumWith(current)), 'windows_arrange');
    const verdict = await tool.verify({ layout: 'grid' }, { ok: true, data: { placed } }, {});
    assert.equal(verdict.status, 'failed');
    assert.ok(verdict.evidence.includes('свернуто'));
  });

  test('verify: unknown — перечитать не удалось', async () => {
    const tool = byName(windowsTools(async () => failRun('таймаут')), 'windows_arrange');
    const verdict = await tool.verify({ layout: 'grid' }, { ok: true, data: { placed: [{ hwnd: 1, title: 'A', x: 0, y: 0, w: 100, h: 100 }] } }, {});
    assert.equal(verdict.status, 'unknown');
  });

  test('неверный layout — отказ до применения', async () => {
    const { runner } = fakeRunner(enumWith(baseWindows));
    const res = await byName(windowsTools(runner), 'windows_arrange').run({ layout: 'diagonal' }, {});
    assert.equal(res.ok, false);
    assert.ok(res.summary.includes('неизвестная раскладка'));
  });
});
