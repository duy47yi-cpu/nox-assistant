'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clipboardTools, READ_SCRIPT, WRITE_SCRIPT, MAX_TEXT } = require('../src/tools/clipboard');

function fakeRunner(result) {
  const calls = [];
  const runner = async (script, env) => {
    calls.push({ script, env });
    return result;
  };
  return { runner, calls };
}

test('чтение буфера: текст возвращается, вывод в UTF-8', async () => {
  const { runner, calls } = fakeRunner({ ok: true, summary: 'готово', data: { stdout: 'привет мир' } });
  const [get] = clipboardTools({ runner });
  const res = await get.run({}, {});
  assert.equal(res.ok, true);
  assert.equal(res.data.text, 'привет мир');
  assert.match(calls[0].script, /UTF8/);
  assert.equal(calls[0].script, READ_SCRIPT);
});

test('пустой буфер — успех без текста', async () => {
  const { runner } = fakeRunner({ ok: true, summary: 'готово', data: { stdout: '' } });
  const [get] = clipboardTools({ runner });
  const res = await get.run({}, {});
  assert.equal(res.ok, true);
  assert.equal(res.summary, 'буфер пуст');
});

test('запись: текст передаётся через переменную окружения, не через скрипт', async () => {
  const { runner, calls } = fakeRunner({ ok: true, summary: 'готово', data: {} });
  const [, set] = clipboardTools({ runner });
  const text = 'строка "с кавычками"; Remove-Item x';
  const res = await set.run({ text }, {});
  assert.equal(res.ok, true);
  assert.equal(calls[0].script, WRITE_SCRIPT);
  assert.equal(calls[0].env.JARVIS_CLIP, text);
  assert.equal(calls[0].script.includes('Remove-Item'), false);
});

test('запись: пустой и слишком длинный текст отклоняются без запуска PowerShell', async () => {
  const { runner, calls } = fakeRunner({ ok: true, summary: '', data: {} });
  const [, set] = clipboardTools({ runner });
  assert.equal((await set.run({ text: '   ' }, {})).ok, false);
  assert.equal((await set.run({ text: 'x'.repeat(MAX_TEXT + 1) }, {})).ok, false);
  assert.equal(calls.length, 0);
});
