'use strict';

// Буфер обмена Windows. Идея из Windows-MCP (MIT), реализация на PowerShell проекта.
// Текст передаётся через переменную окружения, вывод — в UTF-8, чтобы кириллица не ломалась.
const { runPowerShell } = require('./system');

const MAX_TEXT = 4000;
const READ_SCRIPT = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $t = Get-Clipboard -Raw; if ($t) { [Console]::Out.Write($t) }';
const WRITE_SCRIPT = 'Set-Clipboard -Value $env:JARVIS_CLIP';

function clipboardTools({ runner = runPowerShell } = {}) {
  return [
    {
      name: 'clipboard_get',
      description: 'Текст из буфера обмена Windows (до 4000 символов). В буфере может быть что угодно, включая пароли: передавай его дальше только по делу.',
      risk: 'T1',
      parameters: { type: 'object', properties: {} },
      async run(args, ctx) {
        const res = await runner(READ_SCRIPT, {}, { signal: ctx && ctx.signal, timeoutMs: 10000 });
        if (!res.ok) return { ok: false, summary: res.summary, data: {} };
        const text = String((res.data && res.data.stdout) || '').slice(0, MAX_TEXT);
        return { ok: true, summary: text ? `в буфере ${text.length} символов` : 'буфер пуст', data: { text } };
      },
    },
    {
      name: 'clipboard_set',
      description: 'Положить текст в буфер обмена Windows (до 4000 символов).',
      risk: 'T1',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: MAX_TEXT } },
        required: ['text'],
      },
      async run(args, ctx) {
        const text = String((args && args.text) || '');
        if (!text.trim()) return { ok: false, summary: 'пустой текст', data: {} };
        if (text.length > MAX_TEXT) return { ok: false, summary: `текст длиннее ${MAX_TEXT} символов`, data: {} };
        const res = await runner(WRITE_SCRIPT, { JARVIS_CLIP: text }, { signal: ctx && ctx.signal, timeoutMs: 10000 });
        return res.ok
          ? { ok: true, summary: `в буфере ${text.length} символов`, data: {} }
          : { ok: false, summary: res.summary, data: {} };
      },
      // Сверка чтением обратно. Перевод строки в конце Windows может добавить сам.
      async verify(args, result, ctx = {}) {
        const res = await runner(READ_SCRIPT, {}, { signal: ctx.signal, timeoutMs: 10000 });
        if (!res.ok) return { status: 'unknown', evidence: `буфер не прочитан: ${res.summary}` };
        const norm = (t) => String(t || '').replace(/\r\n/g, '\n').trimEnd();
        return norm(res.data && res.data.stdout) === norm(args.text)
          ? { status: 'confirmed', evidence: 'текст в буфере совпал' }
          : { status: 'failed', evidence: 'в буфере другой текст' };
      },
    },
  ];
}

module.exports = { clipboardTools, READ_SCRIPT, WRITE_SCRIPT, MAX_TEXT };
