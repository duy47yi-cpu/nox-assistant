'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { uiTools, escapeSendKeys, parseKeys, SCRIPTS, KEY_MAP } = require('../src/tools/ui');

// Подменённый runner: запоминает вызовы и отдаёт заранее заданный ответ.
// Реальный PowerShell не запускается: ни кликов, ни ввода, ни клавиш.
function fakeRunner(reply) {
  const calls = [];
  const runner = async (script, env, opts) => {
    calls.push({ script, env, opts });
    return typeof reply === 'function' ? reply(script, env, opts) : reply;
  };
  return { runner, calls };
}

const okRun = (stdout) => ({ ok: true, summary: 'готово', data: { stdout, stderr: '' } });
const okJson = (obj) => okRun(JSON.stringify(obj) + '\r\n');
const failRun = (summary) => ({ ok: false, summary, data: { stdout: '', stderr: '' } });

function tool(name, runner, selfPid = 4242) {
  const t = uiTools({ runner, selfPid }).find((x) => x.name === name);
  assert.ok(t, `нет инструмента ${name}`);
  return t;
}

describe('ui_windows: разбор списка окон', () => {
  test('один объект → одно окно', async () => {
    const { runner } = fakeRunner(okRun('{"title":"Блокнот","process":"notepad","handle":1234}\r\n'));
    const res = await tool('ui_windows', runner).run({}, {});
    assert.deepEqual(res, {
      ok: true,
      summary: 'окон: 1',
      data: { windows: [{ title: 'Блокнот', process: 'notepad', handle: 1234 }] },
    });
  });

  test('массив → все окна по порядку', async () => {
    const stdout = JSON.stringify([
      { title: 'Почта — Chrome', process: 'chrome', handle: 10 },
      { title: 'ui.js - VS Code', process: 'Code', handle: 20 },
    ]);
    const { runner } = fakeRunner(okRun(stdout));
    const res = await tool('ui_windows', runner).run({}, {});
    assert.equal(res.ok, true);
    assert.equal(res.summary, 'окон: 2');
    assert.deepEqual(res.data.windows.map((w) => w.process), ['chrome', 'Code']);
    assert.deepEqual(res.data.windows.map((w) => w.handle), [10, 20]);
  });

  test('пустой вывод и пустой массив → пустой список', async () => {
    for (const stdout of ['', '  \r\n', '[]']) {
      const { runner } = fakeRunner(okRun(stdout));
      const res = await tool('ui_windows', runner).run({}, {});
      assert.deepEqual(res, { ok: true, summary: 'окон: 0', data: { windows: [] } }, `stdout=${JSON.stringify(stdout)}`);
    }
  });

  test('заголовок длиннее 120 символов обрезается', async () => {
    const { runner } = fakeRunner(okJson([{ title: 'я'.repeat(300), process: 'x', handle: 1 }]));
    const res = await tool('ui_windows', runner).run({}, {});
    assert.equal(res.data.windows[0].title.length, 120);
  });

  test('битый JSON → понятная ошибка', async () => {
    const { runner } = fakeRunner(okRun('[{"title":"a'));
    const res = await tool('ui_windows', runner).run({}, {});
    assert.deepEqual(res, { ok: false, summary: 'не удалось разобрать список окон', data: {} });
  });

  test('ошибка UIA из скрипта передаётся текстом', async () => {
    const { runner } = fakeRunner(okJson({ status: 'error', message: 'нет доступа' }));
    const res = await tool('ui_windows', runner).run({}, {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /нет доступа/);
  });

  test('сбой запуска PowerShell возвращается как есть', async () => {
    const { runner } = fakeRunner(failRun('таймаут 15000 мс'));
    const res = await tool('ui_windows', runner).run({}, {});
    assert.deepEqual(res, { ok: false, summary: 'таймаут 15000 мс', data: {} });
  });

  test('таймаут 15 с, signal из ctx и свой pid уходят в runner', async () => {
    const { runner, calls } = fakeRunner(okRun('[]'));
    const ctrl = new AbortController();
    await tool('ui_windows', runner, 777).run({}, { signal: ctrl.signal });
    assert.equal(calls[0].opts.timeoutMs, 15000);
    assert.equal(calls[0].opts.signal, ctrl.signal);
    assert.equal(calls[0].env.JARVIS_UI_SELF_PID, '777');
  });
});

describe('ui_elements', () => {
  test('успешный ответ разбирается в name/type/enabled/value', async () => {
    const { runner, calls } = fakeRunner(okJson({
      status: 'ok', window: 'Блокнот', total: 2, truncated: false,
      items: [
        { name: 'Файл', type: 'MenuItem', enabled: true, value: '' },
        { name: 'Текстовый редактор', type: 'Document', enabled: true, value: 'привет' },
      ],
    }));
    const res = await tool('ui_elements', runner).run({ window: 'Блокнот', filter: 'menu', limit: 10 }, {});
    assert.equal(res.ok, true);
    assert.equal(res.data.elements.length, 2);
    assert.deepEqual(res.data.elements[1], { name: 'Текстовый редактор', type: 'Document', enabled: true, value: 'привет' });
    assert.equal(calls[0].env.JARVIS_UI_WINDOW, 'Блокнот');
    assert.equal(calls[0].env.JARVIS_UI_FILTER, 'menu');
    assert.equal(calls[0].env.JARVIS_UI_LIMIT, '10');
  });

  test('limit по умолчанию 40', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'ok', window: 'w', total: 0, items: [] }));
    await tool('ui_elements', runner).run({ window: 'w' }, {});
    assert.equal(calls[0].env.JARVIS_UI_LIMIT, '40');
  });

  test('limit вне 1–60 или не целый → отказ без вызова runner', async () => {
    for (const limit of [0, 61, 2.5, 'много']) {
      const { runner, calls } = fakeRunner(okJson({ status: 'ok', items: [] }));
      const res = await tool('ui_elements', runner).run({ window: 'w', limit }, {});
      assert.equal(res.ok, false, `limit=${limit}`);
      assert.equal(calls.length, 0);
    }
  });

  test('окно не найдено → понятный отказ', async () => {
    const { runner } = fakeRunner(okJson({ status: 'no_window' }));
    const res = await tool('ui_elements', runner).run({ window: 'Нет такого' }, {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /не найдено/);
    assert.match(res.summary, /ui_windows/);
  });
});

describe('пустой или слишком длинный window → отказ без вызова runner', () => {
  const cases = {
    ui_elements: {},
    ui_click: { name: 'OK' },
    ui_type: { text: 'привет' },
    ui_focus: {},
    ui_close_window: {},
    ui_set_toggle: { name: 'OK', state: 'on' },
    ui_wait: { name: 'OK' },
  };
  for (const [name, extra] of Object.entries(cases)) {
    test(name, async () => {
      for (const window of ['', '   ', undefined, null, 'я'.repeat(121)]) {
        const { runner, calls } = fakeRunner(okJson({ status: 'ok' }));
        const res = await tool(name, runner).run({ ...extra, window }, {});
        assert.equal(res.ok, false, `window=${JSON.stringify(window)}`);
        assert.ok(res.summary.length > 0);
        assert.equal(calls.length, 0, `runner не должен вызываться, window=${JSON.stringify(window)}`);
      }
    });
  }
});

describe('ui_click: поиск элемента', () => {
  test('одно совпадение → нажато', async () => {
    const { runner, calls } = fakeRunner(okJson({
      status: 'ok', window: 'Параметры', method: 'invoke', count: 1,
      element: { name: 'Сохранить', type: 'Button', enabled: true },
    }));
    const res = await tool('ui_click', runner).run({ window: 'Параметры', name: 'Сохранить' }, {});
    assert.equal(res.ok, true);
    assert.match(res.summary, /Сохранить/);
    assert.equal(res.data.method, 'invoke');
    assert.equal(calls[0].env.JARVIS_UI_NAME, 'Сохранить');
    assert.equal(calls[0].env.JARVIS_UI_OCCURRENCE, '0', 'occurrence не задан → 0');
  });

  test('несколько совпадений без occurrence → ok:false и первые 5 совпадений', async () => {
    const matches = Array.from({ length: 5 }, (_, i) => ({ name: `OK ${i + 1}`, type: 'Button', enabled: true }));
    const { runner } = fakeRunner(okJson({ status: 'ambiguous', window: 'Диалог', count: 7, matches }));
    const res = await tool('ui_click', runner).run({ window: 'Диалог', name: 'OK' }, {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /несколько/);
    assert.match(res.summary, /occurrence от 1 до 7/);
    assert.match(res.summary, /1\) «OK 1» \(Button\)/);
    assert.match(res.summary, /5\) «OK 5»/);
    assert.equal(res.data.count, 7);
    assert.equal(res.data.matches.length, 5);
  });

  test('список совпадений не длиннее 5, даже если скрипт прислал больше', async () => {
    const matches = Array.from({ length: 9 }, (_, i) => ({ name: `Пункт ${i}`, type: 'ListItem', enabled: true }));
    const { runner } = fakeRunner(okJson({ status: 'ambiguous', count: 9, matches }));
    const res = await tool('ui_click', runner).run({ window: 'w', name: 'Пункт' }, {});
    assert.equal(res.data.matches.length, 5);
    assert.equal(res.summary.includes('Пункт 5'), false);
  });

  test('occurrence уходит в env', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'ok', window: 'w', method: 'toggle', element: { name: 'x', type: 'CheckBox' } }));
    await tool('ui_click', runner).run({ window: 'w', name: 'x', occurrence: 3 }, {});
    assert.equal(calls[0].env.JARVIS_UI_OCCURRENCE, '3');
  });

  test('occurrence больше числа совпадений → отказ', async () => {
    const { runner } = fakeRunner(okJson({ status: 'out_of_range', count: 2, matches: [{ name: 'a', type: 'Button' }] }));
    const res = await tool('ui_click', runner).run({ window: 'w', name: 'a', occurrence: 5 }, {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /occurrence 5/);
  });

  test('элемент не найден → отказ с подсказкой ui_elements', async () => {
    const { runner } = fakeRunner(okJson({ status: 'not_found', window: 'Блокнот' }));
    const res = await tool('ui_click', runner).run({ window: 'Блок', name: 'Удалить всё' }, {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /«Удалить всё» не найден/);
    assert.match(res.summary, /ui_elements/);
  });

  test('выключенный элемент и перекрытая точка клика → отказ', async () => {
    for (const status of ['disabled', 'occluded', 'no_point', 'no_focus']) {
      const { runner } = fakeRunner(okJson({ status, window: 'w', element: { name: 'OK', type: 'Button', enabled: false } }));
      const res = await tool('ui_click', runner).run({ window: 'w', name: 'OK' }, {});
      assert.equal(res.ok, false, status);
    }
  });

  test('недопустимый occurrence или пустое имя → отказ без вызова runner', async () => {
    for (const args of [{ name: '' }, { name: '  ' }, { name: 'OK', occurrence: 0 }, { name: 'OK', occurrence: 1.5 }]) {
      const { runner, calls } = fakeRunner(okJson({ status: 'ok' }));
      const res = await tool('ui_click', runner).run({ window: 'w', ...args }, {});
      assert.equal(res.ok, false, JSON.stringify(args));
      assert.equal(calls.length, 0);
    }
  });

  test('таймаут действия → подсказка, что действие могло выполниться', async () => {
    const { runner } = fakeRunner(failRun('таймаут 15000 мс'));
    const res = await tool('ui_click', runner).run({ window: 'w', name: 'OK' }, {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /возможно, уже выполнено/);
  });

  test('ошибка UIA и мусорный вывод → понятный отказ', async () => {
    let r = await tool('ui_click', fakeRunner(okJson({ status: 'error', message: 'Элемент недоступен' })).runner).run({ window: 'w', name: 'a' }, {});
    assert.match(r.summary, /ошибка UI Automation: Элемент недоступен/);
    r = await tool('ui_click', fakeRunner(okRun('не json')).runner).run({ window: 'w', name: 'a' }, {});
    assert.equal(r.ok, false);
    r = await tool('ui_click', fakeRunner(okRun('')).runner).run({ window: 'w', name: 'a' }, {});
    assert.equal(r.ok, false);
  });

  test('признак оплаты у элемента или его родителей → отказ, действие не выполнено', async () => {
    const { runner } = fakeRunner(okJson({ status: 'payment', window: 'Магазин', element: { name: 'Продолжить', type: 'Button', enabled: true } }));
    const res = await tool('ui_click', runner).run({ window: 'Магазин', name: 'Продолжить' }, {});
    assert.equal(res.ok, false);
    assert.equal(res.summary, 'оплату выполняет владелец самостоятельно');
  });

  test('скрипт ui_click проверяет сам элемент и родителей до нажатия', () => {
    const script = SCRIPTS.ui_click;
    // Защита есть в скрипте и вызывается раньше Invoke/Toggle/Select и запасного клика мышью.
    assert.match(script, /function Test-JPaymentElement/);
    const guard = script.indexOf('(Test-JPaymentElement $t)');
    assert.ok(guard > 0, 'нет вызова проверки оплаты перед действием');
    for (const call of ['$p.Invoke()', '$p.Toggle()', '$p.Select()', '::mouse_event(0x0002']) {
      const at = script.indexOf(call);
      assert.ok(at > 0, `в скрипте нет вызова ${call}`);
      assert.ok(guard < at, `проверка оплаты не раньше ${call}`);
    }
    // Смотрим Name, AutomationId и HelpText элемента и до 4 родителей по дереву управления, до окна.
    for (const word of ['$c.Name', '$c.AutomationId', '$c.HelpText', 'ControlViewWalker', '$depth -lt 4']) {
      assert.ok(script.includes(word), `нет проверки ${word}`);
    }
    // Признаки оплаты согласованы с PAY_ELEMENT в src/policy/modes.js и Test-JPaymentAtPoint в mouse.js.
    for (const word of [
      'оплат', 'купить', 'покупк', 'подписк', 'оформить заказ', 'подтвердить заказ', 'checkout',
      'pay(?:ment)?', 'buy', 'place (?:the )?order', 'complete (?:the )?(?:order|purchase)', 'purchase now',
    ]) {
      assert.ok(script.includes(word), `нет признака оплаты: ${word}`);
    }
  });
  test('скрипт ui_set_toggle тоже проверяет оплату до переключения', () => {
    const script = SCRIPTS.ui_set_toggle;
    assert.match(script, /function Test-JPaymentElement/);
    const guard = script.indexOf('(Test-JPaymentElement $t)');
    assert.ok(guard > 0, 'нет проверки оплаты в ui_set_toggle');
    assert.ok(guard < script.indexOf('$p.Toggle()'), 'проверка оплаты не раньше Toggle');
  });
});

describe('экранирование текста для SendKeys', () => {
  test('все спецсимволы {}+^%~()[] берутся в фигурные скобки', () => {
    assert.equal(escapeSendKeys('{}+^%~()[]'), '{{}{}}{+}{^}{%}{~}{(}{)}{[}{]}');
  });

  test('обычный текст и кириллица не меняются', () => {
    assert.equal(escapeSendKeys('Привет, мир! 123 @#$&*'), 'Привет, мир! 123 @#$&*');
  });

  test('смешанный текст', () => {
    assert.equal(escapeSendKeys('2+2=4 (точно) ~100%'), '2{+}2=4 {(}точно{)} {~}100{%}');
    assert.equal(escapeSendKeys('^a{ENTER}'), '{^}a{{}ENTER{}}', 'команды SendKeys в тексте становятся буквами');
  });

  test('ui_type кладёт сырой текст в JARVIS_UI_TEXT, экранированный — в JARVIS_UI_SENDKEYS', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'ok', window: 'Блокнот', method: 'sendkeys', element: { name: 'Текст', type: 'Edit' } }));
    const res = await tool('ui_type', runner).run({ window: 'Блокнот', text: 'a+b {x}' }, {});
    assert.equal(res.ok, true);
    assert.equal(calls[0].env.JARVIS_UI_TEXT, 'a+b {x}');
    assert.equal(calls[0].env.JARVIS_UI_SENDKEYS, 'a{+}b {{}x{}}');
    assert.equal(calls[0].env.JARVIS_UI_MULTILINE, '0');
    assert.equal(calls[0].env.JARVIS_UI_NAME, '', 'без name — текущий фокус');
  });

  test('Enter сам не добавляется', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'ok', window: 'w', method: 'sendkeys' }));
    await tool('ui_type', runner).run({ window: 'w', text: 'поиск' }, {});
    assert.equal(calls[0].env.JARVIS_UI_SENDKEYS, 'поиск');
    assert.equal(/ENTER|~/i.test(calls[0].env.JARVIS_UI_SENDKEYS), false);
  });

  test('многострочный текст: флаг multiline, в SendKeys ничего не уходит', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'multiline', window: 'w' }));
    const res = await tool('ui_type', runner).run({ window: 'w', text: 'строка 1\nстрока 2' }, {});
    assert.equal(calls[0].env.JARVIS_UI_MULTILINE, '1');
    assert.equal(calls[0].env.JARVIS_UI_SENDKEYS, '');
    assert.equal(res.ok, false);
    assert.match(res.summary, /Enter/);
  });

  test('пустой, слишком длинный текст и управляющие символы → отказ без вызова runner', async () => {
    for (const text of ['', undefined, 'я'.repeat(2001), 'a\u0007b', 'x\u001by']) {
      const { runner, calls } = fakeRunner(okJson({ status: 'ok' }));
      const res = await tool('ui_type', runner).run({ window: 'w', text }, {});
      assert.equal(res.ok, false, JSON.stringify(text));
      assert.equal(calls.length, 0);
    }
  });

  test('текст ровно 2000 символов допустим', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'ok', window: 'w', method: 'value' }));
    const res = await tool('ui_type', runner).run({ window: 'w', text: 'я'.repeat(2000) }, {});
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
  });
});

describe('ui_keys: белый список', () => {
  test('отказ по распознанной платёжной кнопке передаётся владельцу', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'payment', window: 'Магазин' }));
    const result = await tool('ui_keys', runner).run({ keys: 'tab enter', window: 'Магазин' }, {});
    assert.equal(result.ok, false);
    assert.match(result.summary, /оплату выполняет владелец/);
    assert.match(calls[0].script, /foreach \(\$combo in \$plan\.Split/);
    assert.ok(calls[0].script.indexOf('(Test-JPaymentFocus)') < calls[0].script.indexOf('::keybd_event([byte]$c'));
  });
  test('разрешённые клавиши переводятся в коды SendKeys', () => {
    assert.deepEqual(parseKeys('tab tab enter'), { ok: true, tokens: ['tab', 'tab', 'enter'], sendkeys: '{TAB}{TAB}{ENTER}' });
    assert.equal(parseKeys('Ctrl + A, ctrl+c').sendkeys, '^a^c');
    assert.equal(parseKeys('space').sendkeys, ' ');
    for (const k of Object.keys(KEY_MAP)) assert.equal(parseKeys(k).ok, true, k);
  });

  test('клавиши не из белого списка → отказ', () => {
    for (const k of ['win+r', 'ctrl+alt+delete', 'f5', 'ctrl+w', 'a', 'enter win', '{ENTER}', '^a', '%{F4}']) {
      const r = parseKeys(k);
      assert.equal(r.ok, false, k);
      assert.match(r.error, /белого списка|alt\+f4/);
    }
  });

  test('alt+f4 не поддерживается: подсказка про ui_close_window', () => {
    const r = parseKeys('alt+f4');
    assert.equal(r.ok, false);
    assert.match(r.error, /ui_close_window/);
  });

  test('пусто, длиннее 100 символов, больше 20 клавиш → отказ', () => {
    assert.equal(parseKeys('').ok, false);
    assert.equal(parseKeys('   ').ok, false);
    assert.equal(parseKeys('tab '.repeat(26)).ok, false);
    assert.equal(parseKeys(Array(21).fill('up').join(' ')).ok, false);
  });

  test('отказ по белому списку не вызывает runner', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'ok' }));
    const res = await tool('ui_keys', runner).run({ keys: 'win+r' }, {});
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
  });

  test('разрешённые клавиши уходят в env, окно — тоже', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'ok', window: 'Блокнот' }));
    const res = await tool('ui_keys', runner).run({ keys: 'ctrl+s', window: 'Блокнот' }, {});
    assert.equal(res.ok, true);
    assert.equal(calls[0].env.JARVIS_UI_KEYS, '^s');
    assert.equal(calls[0].env.JARVIS_UI_WINDOW, 'Блокнот');
  });

  test('активно окно самого Джарвиса → отказ', async () => {
    const { runner } = fakeRunner(okJson({ status: 'self_foreground' }));
    const res = await tool('ui_keys', runner).run({ keys: 'enter' }, {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /Джарвиса/);
  });
});

describe('ui_focus и ui_close_window', () => {
  test('ui_focus: ok и no_focus', async () => {
    let res = await tool('ui_focus', fakeRunner(okJson({ status: 'ok', window: 'Блокнот' })).runner).run({ window: 'блок' }, {});
    assert.deepEqual(res, { ok: true, summary: 'окно «Блокнот» активировано', data: { window: 'Блокнот' } });
    res = await tool('ui_focus', fakeRunner(okJson({ status: 'no_focus', window: 'Блокнот' })).runner).run({ window: 'блок' }, {});
    assert.equal(res.ok, false);
  });

  test('ui_close_window: окно оболочки защищено', async () => {
    const res = await tool('ui_close_window', fakeRunner(okJson({ status: 'protected', window: 'Program Manager' })).runner).run({ window: 'Program' }, {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /оболочке/);
  });

  test('ui_close_window: окно ещё открыто (спрашивает о сохранении)', async () => {
    const res = await tool('ui_close_window', fakeRunner(okJson({ status: 'ok', window: 'Блокнот', closed: false })).runner).run({ window: 'Блокнот' }, {});
    assert.equal(res.ok, true);
    assert.equal(res.data.closed, false);
    assert.match(res.summary, /ещё открыто/);
  });
});

describe('ui_set_toggle: состояние флажка', () => {
  const toggle = (runner, args = { window: 'w', name: 'Перенос', state: 'on' }) => tool('ui_set_toggle', runner).run(args, {});

  test('Off → On: один Toggle, итог confirmed', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'ok', window: 'w', element: { name: 'Перенос' }, was: 'Off', now: 'On', changed: true }));
    const res = await toggle(runner);
    assert.equal(res.ok, true);
    assert.deepEqual(res.data.now, 'on');
    assert.equal(res.data.was, 'off');
    assert.equal(res.data.changed, true);
    assert.match(res.summary, /off → on/);
    assert.deepEqual(await tool('ui_set_toggle', runner).verify({ state: 'on' }, res), { status: 'confirmed', evidence: 'переключатель: on' });
    assert.equal(calls[0].env.JARVIS_UI_STATE, 'on');
    assert.equal(calls[0].opts.timeoutMs, 15000);
  });

  test('уже нужное состояние: ok, changed=false, в summary «ничего не нажато»', async () => {
    const { runner } = fakeRunner(okJson({ status: 'ok', window: 'w', element: { name: 'Перенос' }, was: 'On', now: 'On', changed: false }));
    const res = await toggle(runner, { window: 'w', name: 'Перенос', state: 'on' });
    assert.equal(res.ok, true);
    assert.equal(res.data.changed, false);
    assert.match(res.summary, /ничего не нажато/);
  });

  test('состояние не сошлось с запросом → verify failed', async () => {
    const { runner } = fakeRunner(okJson({ status: 'ok', window: 'w', element: { name: 'Перенос' }, was: 'On', now: 'Off', changed: true }));
    const res = await toggle(runner, { window: 'w', name: 'Перенос', state: 'on' });
    const v = await tool('ui_set_toggle', runner).verify({ state: 'on' }, res);
    assert.equal(v.status, 'failed');
  });

  test('нет TogglePattern → отказ с подсказкой ui_click', async () => {
    const { runner } = fakeRunner(okJson({ status: 'no_toggle', window: 'w', element: { name: 'Сохранить', type: 'Button' } }));
    const res = await toggle(runner);
    assert.equal(res.ok, false);
    assert.match(res.summary, /нет переключателя/);
    assert.match(res.summary, /ui_click/);
  });

  test('state не on/off, окно пустое, occurrence мусорный → отказ без вызова runner', async () => {
    for (const args of [
      { window: 'w', name: 'x', state: 'maybe' },
      { window: 'w', name: 'x' },
      { window: 'w', name: 'x', state: true },
      { window: 'w', name: 'x', state: 'on', occurrence: 0 },
    ]) {
      const { runner, calls } = fakeRunner(okJson({ status: 'ok' }));
      const res = await toggle(runner, args);
      assert.equal(res.ok, false, JSON.stringify(args));
      assert.equal(calls.length, 0);
    }
  });

  test('имя и состояние не попадают в тело скрипта', async () => {
    const { runner, calls } = fakeRunner(okJson({ status: 'ok', was: 'Off', now: 'On', changed: true }));
    await toggle(runner, { window: 'w', name: 'Remove-Item', state: 'on' });
    assert.equal(calls[0].script, SCRIPTS.ui_set_toggle);
    assert.equal(calls[0].script.includes('Remove-Item'), false);
    assert.equal(calls[0].env.JARVIS_UI_NAME, 'Remove-Item');
  });
});

describe('ui_wait: ожидание элемента в окне', () => {
  const wait = (runner, args) => tool('ui_wait', runner).run({ window: 'Блокнот', name: 'Сохранить', ...args }, {});

  test('appear: элемента ещё нет, потом появился', async () => {
    let n = 0;
    const { runner, calls } = fakeRunner(() => okJson({ status: 'ok', found: ++n >= 2 }));
    const res = await wait(runner, { timeout_ms: 5000 });
    assert.equal(res.ok, true);
    assert.equal(res.data.seen, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].opts.timeoutMs, 5000, 'каждый опрос через runner с таймаутом 5000');
    assert.equal(calls[0].env.JARVIS_UI_NAME, 'Сохранить');
  });

  test('appear: окна нет — это «элемента нет», срок истекает', async () => {
    const { runner } = fakeRunner(okJson({ status: 'no_window' }));
    const res = await wait(runner, { timeout_ms: 1 });
    assert.equal(res.ok, false);
    assert.match(res.summary, /не появился за 1 мс/);
    assert.equal(res.data.seen, false);
  });

  test('gone: окна нет — элемент исчез сразу', async () => {
    const { runner } = fakeRunner(okJson({ status: 'no_window' }));
    const res = await wait(runner, { until: 'gone' });
    assert.equal(res.ok, true);
    assert.match(res.summary, /исчез/);
  });

  test('сбой опроса не считается ни появлением, ни исчезновением: итог «неизвестно»', async () => {
    const { runner } = fakeRunner(failRun('таймаут 5000 мс'));
    let res = await wait(runner, { timeout_ms: 1 });
    assert.equal(res.ok, false);
    assert.match(res.summary, /неизвестно/);
    assert.equal(res.data.seen, null);
    res = await wait(runner, { until: 'gone', timeout_ms: 1 });
    assert.equal(res.ok, false);
    assert.match(res.summary, /неизвестно/);
  });

  test('остановка через signal прерывает опрос', async () => {
    const ctrl = new AbortController();
    const { runner } = fakeRunner(() => {
      ctrl.abort();
      return okJson({ status: 'ok', found: false });
    });
    const res = await tool('ui_wait', runner).run({ window: 'w', name: 'x' }, { signal: ctrl.signal });
    assert.equal(res.ok, false);
    assert.equal(res.data.stopped, true);
  });

  test('неверные аргументы → отказ без вызова runner', async () => {
    for (const args of [{ until: 'maybe' }, { timeout_ms: 0 }, { timeout_ms: 120001 }, { name: '' }]) {
      const { runner, calls } = fakeRunner(okJson({ status: 'ok', found: true }));
      const res = await wait(runner, args);
      assert.equal(res.ok, false, JSON.stringify(args));
      assert.equal(calls.length, 0);
    }
  });

  test('verify: условие прочитано', async () => {
    const { runner } = fakeRunner(okJson({ status: 'ok', found: true }));
    assert.deepEqual(await tool('ui_wait', runner).verify({}, {}), { status: 'confirmed', evidence: 'условие прочитано' });
  });
});

describe('текст пользователя только в env, не в теле скрипта', () => {
  const evil = 'Окно"; Remove-Item C:\\ -Recurse; $(calc) `whoami` \'@';
  const cases = [
    ['ui_elements', { window: evil, filter: evil + 'F' }],
    ['ui_click', { window: evil, name: evil + 'N', occurrence: 2 }],
    ['ui_type', { window: evil, name: evil + 'N', text: evil + ' текст {+}' }],
    ['ui_keys', { window: evil, keys: 'tab enter' }],
    ['ui_focus', { window: evil }],
    ['ui_close_window', { window: evil }],
  ];
  for (const [name, args] of cases) {
    test(name, async () => {
      const { runner, calls } = fakeRunner(okJson({ status: 'no_window' }));
      await tool(name, runner).run(args, {});
      assert.equal(calls.length, 1);
      const { script, env } = calls[0];
      // Скрипт — постоянный текст, один и тот же при любых аргументах.
      assert.equal(script, SCRIPTS[name]);
      for (const [key, value] of Object.entries(args)) {
        if (typeof value !== 'string') continue;
        assert.equal(script.includes(value), false, `значение попало в скрипт: ${value}`);
        // keys уходят в env уже переведёнными в коды SendKeys из белого списка.
        if (key === 'keys') continue;
        assert.ok(Object.values(env).includes(value), `значение не найдено в env: ${value}`);
      }
      if (name === 'ui_keys') assert.equal(env.JARVIS_UI_KEYS, '{TAB}{ENTER}');
      assert.equal(script.includes('Remove-Item'), false);
      assert.equal(script.includes('whoami'), false);
      assert.equal(env.JARVIS_UI_WINDOW, evil);
      // Все переданные значения — строки (spawn ожидает строки в env).
      for (const v of Object.values(env)) assert.equal(typeof v, 'string');
    });
  }

  test('скрипты не содержат сетевых вызовов, запуска кода из переменных и чтения .env', () => {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      assert.equal(/Invoke-(WebRequest|RestMethod|Expression)|\biex\b|Net\.WebClient|DownloadString|https?:\/\//i.test(script), false, name);
      assert.equal(/\.env\b/i.test(script.replace(/\$env:/g, '')), false, name);
      assert.equal(/ScriptBlock\]::Create/i.test(script), false, name);
    }
  });
});

describe('метаданные инструментов', () => {
  test('имена и риски', () => {
    const tools = uiTools({ runner: async () => okRun('') });
    assert.deepEqual(
      tools.map((t) => [t.name, t.risk]),
      [
        ['ui_windows', 'T0'],
        ['ui_elements', 'T0'],
        ['ui_click', 'T1'],
        ['ui_type', 'T1'],
        ['ui_keys', 'T1'],
        ['ui_focus', 'T1'],
        ['ui_close_window', 'T2'],
        ['ui_set_toggle', 'T1'],
        ['ui_wait', 'T0'],
      ]
    );
    for (const t of tools) {
      assert.equal(typeof t.description, 'string');
      assert.equal(t.parameters.type, 'object');
      assert.equal(typeof t.run, 'function');
    }
  });

  test('схемы: window 1–120, text 1–2000, keys 1–100, limit 1–60', () => {
    const tools = uiTools({ runner: async () => okRun('') });
    const p = (n) => tools.find((t) => t.name === n).parameters;
    assert.deepEqual(p('ui_elements').required, ['window']);
    assert.equal(p('ui_elements').properties.window.maxLength, 120);
    assert.equal(p('ui_elements').properties.limit.maximum, 60);
    assert.equal(p('ui_elements').properties.limit.default, 40);
    assert.deepEqual(p('ui_click').required, ['window', 'name']);
    assert.deepEqual(p('ui_type').required, ['window', 'text']);
    assert.equal(p('ui_type').properties.text.maxLength, 2000);
    assert.deepEqual(p('ui_keys').required, ['keys']);
    assert.equal(p('ui_keys').properties.keys.maxLength, 100);
  });

  test('alt+f4 нет в белом списке', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(KEY_MAP, 'alt+f4'), false);
  });
});
