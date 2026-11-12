'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const { createFieldDictation, targetLabel, hintNeedsShow, CAPTURE_SCRIPT, INSERT_SCRIPT, REFUSED, KEPT } = require('../src/voice/field-dictation');

const FIELD = { status: 'ok', hwnd: 1234, rid: '42.1234.7', password: false, field: 'Текстовый редактор', title: 'Без имени – Блокнот', app: 'Блокнот' };

// Подставной PowerShell: первый ответ — чтение поля, второй — вставка.
function setup(capture, insert = { status: 'ok', known: true, seen: true }) {
  const calls = [];
  const states = [];
  const run = async (script, env) => {
    calls.push({ script, env });
    return { ok: true, data: { stdout: JSON.stringify(script === CAPTURE_SCRIPT ? capture : insert) } };
  };
  const d = createFieldDictation({ run, selfPid: 77, onChange: (s) => states.push(s) });
  return { d, calls, states };
}

test('цель запоминается до записи, владелец видит её словами, вставка идёт именно в неё', async () => {
  const { d, calls } = setup(FIELD);
  const s = await d.start();
  assert.strictEqual(s.phase, 'recording');
  assert.strictEqual(s.target, 'Без имени – Блокнот');
  assert.strictEqual(calls[0].env.JARVIS_UI_SELF_PID, '77');
  assert.ok(!('hwnd' in s) && !('rid' in s)); // окну-подсказке адрес поля не нужен
  d.addText('привет');
  d.addText('как\nдела {ок}');
  assert.strictEqual(d.state().text, 'привет как дела {ок}'); // перевод строки не станет нажатием Enter
  const done = await d.insert();
  assert.strictEqual(done.phase, 'done');
  assert.strictEqual(done.message, 'Вставлено.');
  const env = calls[1].env;
  assert.strictEqual(calls[1].script, INSERT_SCRIPT);
  assert.deepStrictEqual([env.NOX_DICT_HWND, env.NOX_DICT_RID, env.NOX_DICT_TEXT], ['1234', '42.1234.7', 'привет как дела {ок}']);
  assert.strictEqual(env.NOX_DICT_SENDKEYS, 'привет как дела {{}ок{}}');
});

test('поле пароля: отказ с объяснением, запись не начинается', async () => {
  for (const field of [{ ...FIELD, password: true }, { ...FIELD, field: 'Пароль' }]) {
    const { d, calls } = setup(field);
    const s = await d.start();
    assert.strictEqual(s.phase, 'refused');
    assert.strictEqual(s.message, REFUSED.password);
    d.addText('секрет');
    await d.insert();
    assert.strictEqual(d.state().text, '');
    assert.strictEqual(calls.length, 1); // скрипт вставки не запускался
  }
});

test('не поле, окно Nox и сбой чтения — отказ словами', async () => {
  for (const [raw, message] of [[{ status: 'no_field' }, REFUSED.no_field], [{ status: 'self' }, REFUSED.self], [{ status: 'что-то' }, REFUSED.error], [{ status: 'ok' }, REFUSED.error]]) {
    const { d } = setup(raw);
    assert.strictEqual((await d.start()).message, message);
  }
});

test('фокус ушёл, поле сменилось или окно закрыто: не вставлено, текст остался для копирования', async () => {
  for (const status of ['focus_moved', 'field_changed', 'window_gone', 'password']) {
    const { d } = setup(FIELD, { status });
    await d.start();
    d.addText('важный текст');
    const s = await d.insert();
    assert.strictEqual(s.phase, 'kept');
    assert.strictEqual(s.message, KEPT[status]);
    assert.strictEqual(s.text, 'важный текст');
  }
});

test('успех не верится на слово: текст не появился в поле — «не вставлено»; проверить нельзя — так и сказано', async () => {
  const a = setup(FIELD, { status: 'ok', known: true, seen: false });
  await a.d.start(); a.d.addText('текст');
  assert.strictEqual((await a.d.insert()).message, KEPT.not_seen);
  const b = setup(FIELD, { status: 'ok', known: false, seen: false });
  await b.d.start(); b.d.addText('текст');
  const s = await b.d.insert();
  assert.strictEqual(s.phase, 'done');
  assert.match(s.message, /Проверить.*не удалось/);
});

test('отмена ничего не вставляет; без текста вставки нет; поздний ответ скрипта после отмены не считается', async () => {
  const { d, calls } = setup(FIELD);
  await d.start();
  await d.insert(); // текста ещё нет
  assert.strictEqual(calls.length, 1);
  d.addText('не надо');
  assert.strictEqual(d.cancel().phase, 'idle');
  await d.insert();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(d.state().text, '');

  let release;
  const slow = createFieldDictation({ run: (script) => (script === CAPTURE_SCRIPT
    ? Promise.resolve({ data: { stdout: JSON.stringify(FIELD) } })
    : new Promise((resolve) => { release = () => resolve({ data: { stdout: '{"status":"ok","known":true,"seen":true}' } }); })) });
  await slow.start();
  slow.addText('текст');
  const pending = slow.insert();
  slow.cancel();
  release();
  assert.strictEqual((await pending).phase, 'idle');
});

test('состояние микрофона видно только во время записи', async () => {
  const { d } = setup(FIELD);
  d.setMic('listening');
  assert.strictEqual(d.state().mic, 'off');
  await d.start();
  d.setMic('listening');
  assert.strictEqual(d.state().mic, 'listening');
  d.cancel();
  assert.strictEqual(d.state().mic, 'off');
});

test('буфер обмена: диктовка в поле его не читает и не меняет; вставка сверяет окно и поле до ввода', () => {
  assert.doesNotMatch(CAPTURE_SCRIPT + INSERT_SCRIPT, /clipboard/i);
  const order = ['IsWindow($h)', "status = 'focus_moved'", "status = 'field_changed'", "status = 'password'", 'SendKeys]::SendWait'].map((part) => INSERT_SCRIPT.indexOf(part));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), 'проверки стоят перед вводом');
  assert.doesNotMatch(CAPTURE_SCRIPT, /SendKeys|SetValue|SetFocus|Set-JForeground/); // запоминание цели — только чтение
});

test('окно-подсказка видно весь сеанс: скрытое окно показывается на любом состоянии, кроме простоя', () => {
  // Сбой, который здесь закреплён: показ висел только на ready-to-show. У скрытого прозрачного окна
  // это событие иногда не приходит, и владелец говорил в никуда: текст шёл, окна не было.
  assert.strictEqual(hintNeedsShow({ phase: 'capturing' }, false), true);
  assert.strictEqual(hintNeedsShow({ phase: 'recording' }, false), true);
  assert.strictEqual(hintNeedsShow({ phase: 'inserting' }, false), true);
  assert.strictEqual(hintNeedsShow({ phase: 'done' }, false), true);
  assert.strictEqual(hintNeedsShow({ phase: 'kept' }, false), true);
  assert.strictEqual(hintNeedsShow({ phase: 'refused' }, false), true);
  assert.strictEqual(hintNeedsShow({ phase: 'recording' }, true), false); // уже видно — второй раз не показываем
  assert.strictEqual(hintNeedsShow({ phase: 'idle' }, false), false);
  assert.strictEqual(hintNeedsShow({}, false), false);
  assert.strictEqual(hintNeedsShow(null, false), false);
});

test('показ окна-подсказки не висит на одном событии готовности страницы', () => {
  // Закрепляем состав: два независимых повода показать окно и повтор на каждое изменение состояния.
  const fs = require('fs');
  const path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /once\('ready-to-show', revealDictate\)/);
  assert.match(main, /once\('did-finish-load', revealDictate\)/);
  assert.match(main, /function revealDictate\(\)/);
  assert.ok((main.match(/revealDictate/g) || []).length >= 5, 'показ зовётся из загрузки страницы, готовности и на изменение состояния');
});

test('подпись цели: программа и окно без повтора', () => {
  assert.strictEqual(targetLabel({ app: 'Блокнот', title: 'Без имени – Блокнот' }), 'Без имени – Блокнот');
  assert.strictEqual(targetLabel({ app: 'Microsoft Edge', title: 'Форма' }), 'Microsoft Edge — Форма');
  assert.strictEqual(targetLabel({ app: 'Notepad.exe', title: 'a.txt — Блокнот' }), 'a.txt — Блокнот');
  assert.strictEqual(targetLabel({}), 'окно без названия');
});

test('скрипты PowerShell разбираются без синтаксических ошибок', { skip: process.platform !== 'win32' }, () => {
  for (const script of [CAPTURE_SCRIPT, INSERT_SCRIPT]) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:NOX_T_SCRIPT, [ref]$null, [ref]$e); $e.Count; $e | ForEach-Object { $_.Message }'],
    { env: { ...process.env, NOX_T_SCRIPT: script }, encoding: 'utf8' });
    assert.strictEqual(String(r.stdout).trim(), '0', r.stdout + r.stderr);
  }
});
