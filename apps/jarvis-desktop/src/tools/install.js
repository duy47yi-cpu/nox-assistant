'use strict';

// Установка программ через winget (встроен в Windows). Поиск — только чтение;
// решение об установке принимает политика выбранного режима, в фон и команды инструмент не попадает.
// id передаётся через переменную окружения и сверяется с шаблоном: в текст команды он не попадает.
const { runPowerShell } = require('./system');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{1,99}$/;
const MAX_OUT = 3000;

const SEARCH_SCRIPT = [
  '[Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false',
  'winget search --query $env:JARVIS_Q --source winget --count 8 --disable-interactivity --accept-source-agreements 2>&1 | Out-String -Width 200',
].join('\n');
// Команда установки принимает условия пакета и источника; это важно при выборе режима и подтверждении.
const INSTALL_SCRIPT = [
  '[Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false',
  'winget install --id $env:JARVIS_ID --exact --source winget --silent --disable-interactivity --accept-package-agreements --accept-source-agreements 2>&1 | Out-String -Width 200',
  'exit $LASTEXITCODE',
].join('\n');
const LIST_SCRIPT = [
  '[Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false',
  '$out = winget list --id $env:JARVIS_ID --exact --disable-interactivity --accept-source-agreements 2>&1',
  '$code = $LASTEXITCODE',
  '$out | Out-String -Width 240',
  'exit $code',
].join('\n');

// Вывод winget с крутящимся индикатором: от строки остаётся то, что после последнего \r, пустые и индикатор — прочь.
const tail = (s) => String(s || '').split(/\n/).map((l) => l.split('\r').pop().trimEnd()).filter((l) => !/^\s*[-\\|/]?\s*$/.test(l)).join('\n').slice(-MAX_OUT);

// Доказательство выбирается только из полной таблицы winget. Восьмая строка
// может означать обрезку по --count, поэтому такая выдача неоднозначна.
function uniqueSearchMatch(query, text) {
  const q = String(query || '').trim().toLocaleLowerCase();
  if (!q || !/^[\p{L}\p{N}][\p{L}\p{N}.+ _-]{1,79}$/u.test(q)) return null;
  const lines = String(text || '').split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*(?:Name|Имя)\s{2,}(?:Id|Идентификатор)\s{2,}(?:Version|Версия)(?=\s|$)/iu.test(line));
  if (header < 0 || !/^\s*-{5,}/.test(lines[header + 1] || '')) return null;
  const h = lines[header];
  const idStart = h.search(/(?:Id|Идентификатор)(?=\s{2,})/iu);
  const versionStart = h.search(/(?:Version|Версия)(?=\s|$)/iu);
  if (idStart < 0 || versionStart <= idStart) return null;
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.trim()) continue;
    const name = line.slice(0, idStart).trim();
    const id = line.slice(idStart, versionStart).trim();
    if (!name || !ID_RE.test(id)) return null;
    rows.push({ name, id });
  }
  if (!rows.length || rows.length >= 8) return null;
  const matches = rows.filter(({ name, id }) => {
    const normalizedName = name.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    const nameContains = (` ${normalizedName} `).includes(` ${q} `);
    return normalizedName === q || (nameContains && id.split('.').pop().toLocaleLowerCase() === q);
  });
  return matches.length === 1 ? matches[0].id : null;
}

function installedIdPresent(text, id) {
  const lines = String(text || '').split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*(?:Name|Имя)\s{2,}(?:Id|Идентификатор)\s{2,}(?:Version|Версия)(?=\s|$)/iu.test(line));
  if (header < 0 || !/^\s*-{5,}/.test(lines[header + 1] || '')) return false;
  const start = lines[header].search(/(?:Id|Идентификатор)(?=\s{2,})/iu);
  const end = lines[header].search(/(?:Version|Версия)(?=\s|$)/iu);
  if (start < 0 || end <= start) return false;
  return lines.slice(header + 2).some((line) => line.slice(start, end).trim().toLowerCase() === String(id || '').toLowerCase());
}

function installTools({ runner = runPowerShell } = {}) {
  return [
    {
      name: 'app_search',
      description: 'Найти программу для установки в каталоге winget: имя, Id, версия. Только поиск для установки, ничего не ставит; поиск идёт секунды. Чтобы запустить уже установленную программу или нажимать в ней, app_search не нужен — это делает app_open.',
      risk: 'T0',
      parameters: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 80 } }, required: ['query'] },
      async run(args = {}, ctx = {}) {
        const q = String(args.query || '').trim();
        if (q.length < 2 || q.length > 80 || /[\u0000-\u001f]/.test(q)) return { ok: false, summary: 'query: от 2 до 80 символов', data: {} };
        const res = await runner(SEARCH_SCRIPT, { JARVIS_Q: q }, { timeoutMs: 60000, signal: ctx.signal });
        if (!res || !res.ok) return { ok: false, summary: `поиск не удался: ${(res && res.summary) || 'нет ответа от PowerShell'}`, data: {} };
        return { ok: true, summary: `результаты поиска «${q}»`, data: { text: tail(res.data && res.data.stdout) } };
      },
    },
    {
      name: 'app_install',
      description: 'Установить программу через winget по точному Id из app_search. Применяется политика выбранного режима; установка принимает условия пакета и источника.',
      risk: 'T3',
      parameters: { type: 'object', properties: { id: { type: 'string', minLength: 2, maxLength: 100 } }, required: ['id'] },
      async run(args = {}, ctx = {}) {
        const id = String(args.id || '').trim();
        if (!ID_RE.test(id)) return { ok: false, summary: 'id: точный Id из app_search, например Mozilla.Firefox', data: {} };
        const res = await runner(INSTALL_SCRIPT, { JARVIS_ID: id }, { timeoutMs: 15 * 60 * 1000, signal: ctx.signal });
        const out = tail(res && res.data && res.data.stdout);
        const ok = Boolean(res && res.ok);
        return { ok, summary: ok ? `установка ${id} завершена` : `установка ${id} не удалась: ${out.split('\n').pop() || (res && res.summary) || 'нет ответа от PowerShell'}`, data: { id, text: out } };
      },
      // Код выхода установщика не доказательство: спрашиваем winget, числится ли программа установленной.
      async verify(args, result, ctx = {}) {
        const id = result && result.data && typeof result.data.id === 'string' ? result.data.id : '';
        if (!id) return { status: 'unknown', evidence: 'нечего подтверждать: в результате установки нет Id программы' };
        if (!result || result.ok !== true) return { status: 'unknown', evidence: `установка ${id} не завершилась: подтверждать нечего` };
        const res = await runner(LIST_SCRIPT, { JARVIS_ID: id }, { timeoutMs: 60000, signal: ctx.signal });
        if (res && res.ok && installedIdPresent(res.data && res.data.stdout, id)) return { status: 'confirmed', evidence: `winget видит ${id} среди установленных` };
        return { status: 'unknown', evidence: `не удалось подтвердить ${id} в списке winget` };
      },
    },
  ];
}

module.exports = { installTools, ID_RE, SEARCH_SCRIPT, INSTALL_SCRIPT, uniqueSearchMatch };
