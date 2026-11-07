/* Джарвис — эмуляция window.jarvis для проверки интерфейса в обычном браузере.
 *
 * Подключается ТОЛЬКО из shared.js (ensureBridge) и только если window.jarvis
 * не определён. В Electron не загружается.
 *
 * Параметры адреса:
 *   ?mode=full|ask|auto   стартовый режим (по умолчанию ask, чтобы видеть подтверждения)
 *   ?key=1                делать вид, что ключ NOX_BRAIN_KEY есть
 *   ?journal=0            пустой журнал
 *   ?history=1            разговор с прошлого запуска (по умолчанию пустой — видны быстрые фразы)
 *   ?failset=1            setSetting отвечает {ok:false}
 *   ?oldcore=1            старый мост: нет команд, библиотеки, вложений и т. п.
 *   ?cmdfail=1            методы команд бросают ошибку
 *
 * Сценарии по словам в сообщении:
 *   «демо»          думаю → ищу (web_search) → отвечаю → готово
 *   «действие»      думаю → выполняю (volume_set) → отвечаю
 *   «громкость 30» volume_set · «открой github.com» url_open · «запусти блокнот» app_open
 *   «окна» windows_list · «напомни» remind_in · «команда»/«ошибка» shell_run (ошибка — ok:false)
 *   «сбой» событие error · «долго» длинный ответ (проверить «Стоп») · «умеешь» Markdown
 *   «html» текст с разметкой (проверить экранирование) · «всё» всё сразу
 *   Фраза включённой команды или команды библиотеки запускает её без «мозга».
 *
 * Консоль: window.__jarvisStub.emit({...}), .state, .journal, .commands, .history.
 */
(() => {
  'use strict';
  if (window.jarvis) return;

  const params = new URLSearchParams(location.search);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60000).toISOString();

  const state = {
    mode: ['full', 'ask', 'auto'].includes(params.get('mode')) ? params.get('mode') : 'ask',
    model: 'stub-model',
    hasKey: params.get('key') === '1',
    busy: false,
    aborted: false,
  };
  const mcpStub = [{ name: 'calendar', transport: 'http', target: 'https://mcp.example/calendar', disabled: false, connected: true }];
  const settings = {
    voice: false, dictation: false, alwaysOnTop: false, quiet: false, autoStart: false,
    screenAuto: false, memoryAuto: true,
    modelTier: 'fast', workspace: 'D:\\nox-assistant\\workspace', connectedFolders: [],
  };
  const listeners = new Set();
  const pending = new Map(); // id → resolve
  let seq = 0;

  const CATALOG = [
    { name: 'volume_set', risk: 'T0', description: 'Установить громкость системы в процентах (0–100).', parameters: { type: 'object', properties: { percent: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['percent'] } },
    { name: 'app_open', risk: 'T1', description: 'Запустить программу по имени или по полному пути к exe.', parameters: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 260 } }, required: ['name'] } },
    { name: 'url_open', risk: 'T1', description: 'Открыть адрес http или https в браузере по умолчанию.', parameters: { type: 'object', properties: { url: { type: 'string', maxLength: 2048 } }, required: ['url'] } },
    { name: 'shell_run', risk: 'T2', description: 'Выполнить команду PowerShell и вернуть вывод. Таймаут 30 с.', parameters: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['command'] } },
    { name: 'remind_in', risk: 'T0', description: 'Напомнить через указанное число минут.', parameters: { type: 'object', properties: { minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'через сколько минут' }, text: { type: 'string', maxLength: 500, description: 'текст напоминания' }, sound: { type: 'boolean', description: 'со звуком' } }, required: ['minutes', 'text'] } },
  ];
  const RISK = Object.fromEntries(CATALOG.map((t) => [t.name, t.risk]));
  RISK.windows_list = 'T0';
  RISK.web_search = 'T0';
  RISK.web_fetch = 'T0';

  const LIBRARY = [
    { id: 'sys_volume_mute', title: 'Выключить звук', category: 'Система', phrases: ['выключи звук', 'без звука'], risk: 'T0', description: 'Ставит громкость на ноль.', args: [] },
    { id: 'sys_lock', title: 'Заблокировать экран', category: 'Система', phrases: ['заблокируй экран'], risk: 'T1', description: 'Блокирует сеанс Windows.', args: [] },
    { id: 'web_open_site', title: 'Открыть сайт', category: 'Браузер', phrases: ['открой сайт'], risk: 'T1', description: 'Открывает адрес в браузере по умолчанию.', args: ['адрес'] },
    { id: 'files_downloads', title: 'Открыть загрузки', category: 'Файлы', phrases: ['открой загрузки'], risk: 'T0', description: 'Показывает папку «Загрузки» в проводнике.', args: [] },
    { id: 'media_pause', title: 'Пауза музыки', category: 'Медиа', phrases: ['пауза', 'поставь на паузу'], risk: 'T0', description: 'Ставит на паузу текущий плеер.', args: [] },
    { id: 'time_now', title: 'Который час', category: 'Ответы', phrases: ['который час'], risk: 'T0', description: 'Называет текущее время.', args: [] },
  ];
  for (const e of LIBRARY) RISK['lib_' + e.id] = e.risk;

  let commands = [
    { id: 'cmd-1', name: 'Рабочее утро', phrases: ['доброе утро', 'начинаем работу'], steps: [{ tool: 'app_open', args: { name: 'code' } }, { tool: 'url_open', args: { url: 'https://github.com' } }, { tool: 'volume_set', args: { percent: 25 } }], enabled: true, lastRunAt: ago(70) },
    { id: 'cmd-2', name: 'Тишина', phrases: ['тишина'], steps: [{ tool: 'volume_set', args: { percent: 0 } }], enabled: false, lastRunAt: null },
  ];

  const stubChats = { next: 2, activeId: 'c1', chats: [{ id: 'c1', title: 'Первый разговор' }, { id: 'c2', title: 'Новый чат' }] };
  const history = params.get('history') === '1' ? [
    { role: 'user', text: 'Сделай громкость 30' },
    { role: 'assistant', text: 'Готово, громкость **30%**.' },
    { role: 'user', text: 'Файл «заметки.txt»:\nкупить молоко\n\nКратко перескажи файл' },
    { role: 'assistant', text: 'В файле одна задача:\n- купить молоко' },
  ] : [];
  const stubSpaces = [{ id: 'default', name: 'Общее' }];
  const stubSpaceData = new Map();
  let stubSpace = 'default';

  const journal = params.get('journal') === '0' ? [] : [
    { ts: ago(0.5), tool: 'volume_set', args: { percent: 30 }, risk: 'T0', mode: 'ask', decision: 'allow', ok: true, summary: 'громкость ~30%' },
    { ts: ago(4), tool: 'url_open', args: { url: 'https://github.com' }, risk: 'T1', mode: 'ask', decision: 'once', ok: true, summary: 'открыто: https://github.com/ (не проверено: окно с адресом не найдено)', verified: 'unknown', evidence: 'окно с адресом не найдено' },
    { ts: ago(6), tool: 'workspace_write', args: { path: 'reports/итог.md' }, risk: 'T1', mode: 'auto', decision: 'allow', ok: true, summary: 'записано: reports/итог.md', verified: 'confirmed', evidence: 'файл прочитан обратно, текст совпал' },
    { ts: ago(9), tool: 'app_close', args: { name: 'Steam' }, risk: 'T2', mode: 'ask', decision: 'once', ok: false, summary: 'не подтверждено: процесс Steam ещё работает', verified: 'failed', evidence: 'процесс Steam ещё работает' },
    { ts: ago(12), tool: 'shell_run', args: { command: 'Get-Process | Sort CPU -desc | Select -First 5' }, risk: 'T2', mode: 'ask', decision: 'reject', ok: false, summary: 'отклонено' },
    { ts: ago(26), tool: 'app_open', args: { name: 'spotify' }, risk: 'T1', mode: 'auto', decision: 'allow', ok: false, summary: 'программа не найдена: spotify' },
    { ts: ago(40), tool: 'web_search', args: { query: 'погода в Москве' }, risk: 'T0', mode: 'auto', decision: 'allow', ok: true, summary: null },
    { ts: ago(55), tool: 'remind_in', args: { minutes: 10, text: 'размяться' }, risk: 'T0', mode: 'auto', decision: 'allow', ok: true, summary: 'напомню через 10 мин' },
    { ts: ago(140), tool: 'windows_list', args: {}, risk: null, mode: 'full', decision: 'allow', ok: true, summary: '7 окон' },
    { ts: ago(600), tool: 'shell_run', args: { command: 'Remove-Item C:\\temp\\old -Recurse' }, risk: 'T3', mode: 'auto', decision: 'deny', ok: false, summary: 'отклонено' },
    { ts: ago(1500), tool: 'url_open', args: { url: 'https://example.org/docs' }, risk: 'T1', mode: 'full', decision: 'allow', ok: true, summary: 'открыто' },
    { ts: ago(3000), tool: 'volume_set', args: { percent: 60 }, risk: 'T0', mode: 'full', decision: 'allow', ok: true, summary: 'громкость ~60%' },
  ];

  function emit(ev) {
    for (const cb of listeners) {
      try { cb(ev); } catch (err) { console.error('[dev-stub] слушатель упал', err); }
    }
  }
  const status = (s) => emit({ type: 'status', state: s });

  // Ответ приходит порциями: шар «говорит» волнами на каждую порцию.
  async function stream(text, chunk = 6, pause = 55) {
    const re = new RegExp(`[\\s\\S]{1,${chunk}}`, 'g');
    const parts = text.match(re) || [];
    for (const p of parts) {
      if (state.aborted) return;
      emit({ type: 'text', delta: p });
      await sleep(pause);
    }
  }

  const dealsStub = [
    { ref: 'call:s1', title: 'shell_run', state: 'waiting', reason: 'вызов прерван перезапуском, результат неизвестен', since: new Date(Date.now() - 42 * 60e3).toISOString() },
    { ref: 'call:s2', title: 'app_close', state: 'failed', reason: 'процесс Steam ещё работает: программа могла спросить о сохранении или уйти в трей', since: new Date(Date.now() - 9 * 60e3).toISOString() },
    { ref: 'call:s3', title: 'url_open', state: 'done', reason: 'unknown', since: new Date(Date.now() - 4 * 60e3).toISOString() },
    { ref: 'reminder:s4', title: 'Размяться', state: 'promised', reason: '', due: new Date(Date.now() + 50 * 60e3).toISOString(), since: new Date().toISOString() },
  ];
  let stubCity = 'Москва';
  let dictationStubCb = null; // слушатель событий диктовки в эмуляции
  let dictationStubSeq = 0; // номер сеанса: stop отменяет ещё не случившиеся события прошлого запуска

  function needsApproval(risk) {
    if (state.mode === 'full') return false;
    if (state.mode === 'ask') return risk !== 'T0';
    return risk === 'T2' || risk === 'T3';
  }

  function fakeRun(name, args) {
    switch (name) {
      case 'volume_set': return { ok: true, summary: `громкость ~${args.percent}%` };
      case 'url_open': return { ok: true, summary: `открыто: ${args.url} (не проверено: окно с адресом не найдено)`, verified: 'unknown', evidence: 'окно с адресом не найдено' };
      case 'app_open':
        if (/нет|missing/i.test(args.name)) return { ok: false, summary: 'программа не найдена: ' + args.name };
        if (/сбой/i.test(args.name)) return { ok: false, summary: 'не подтверждено: процесс завершился сразу после запуска', verified: 'failed', evidence: 'процесс завершился сразу после запуска' };
        return { ok: true, summary: 'запущено: ' + args.name, verified: 'confirmed', evidence: `процесс ${args.name} работает` };
      case 'shell_run': return /ошибк|fail/i.test(args.command) ? { ok: false, summary: 'код выхода 1: команда не найдена' } : { ok: true, summary: 'команда выполнена' };
      case 'remind_in': return { ok: true, summary: `напомню через ${args.minutes} мин` };
      case 'windows_list': return { ok: true, summary: '6 окон' };
      case 'web_search': return { ok: true, summary: '5 результатов' };
      case 'web_fetch': return { ok: true, summary: null };
      default:
        if (name.startsWith('lib_')) {
          const e = LIBRARY.find((x) => 'lib_' + x.id === name);
          if (e && e.id === 'time_now') return { ok: true, summary: 'сейчас ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) };
          return e ? { ok: true, summary: 'выполнено: ' + e.title.toLowerCase() } : { ok: false, summary: 'команда не найдена' };
        }
        return { ok: false, summary: 'неизвестный инструмент: ' + name };
    }
  }

  async function tool(name, args, opts = {}) {
    const id = 'call_' + (++seq);
    const risk = RISK[name] || 'T1';
    emit({ type: 'tool_start', id, name, args, risk });
    let decision = 'allow';
    if (!opts.skipPolicy && needsApproval(risk)) {
      status('waiting_approval');
      const wait = new Promise((resolve) => pending.set(id, resolve));
      emit({ type: 'approval_request', id, name, args, risk, reason: `режим «${state.mode}», риск ${risk}` });
      decision = await wait;
    }
    let result;
    if (decision === 'reject' || state.aborted) {
      decision = 'reject';
      result = { ok: false, summary: 'отклонено' };
    } else {
      status('acting');
      await sleep(opts.delay || 900);
      result = fakeRun(name, args);
    }
    journal.unshift({ ts: new Date().toISOString(), tool: name, args, risk, mode: state.mode, decision, ok: result.ok, summary: result.summary, verified: result.verified || null, evidence: result.evidence || null });
    emit({ type: 'tool_result', id, ok: result.ok, summary: result.summary, verified: result.verified, evidence: result.evidence });
    if (!state.aborted && !opts.noThink) status('thinking');
    return { tool: name, ...result };
  }

  const MD_SAMPLE = [
    'Вот что я умею **прямо сейчас**:',
    '',
    '- открывать программы и адреса (`app_open`, `url_open`);',
    '- менять громкость, например `громкость 30`;',
    '- ставить напоминания и фоновые задачи;',
    '- выполнять команды PowerShell, **с вашего разрешения**.',
    '',
    'Порядок работы:',
    '1. Вы пишете поручение.',
    '2. Я выбираю инструмент.',
    '3. Опасное спрашиваю заранее.',
    '',
    '```',
    'Get-Date | Format-List',
    '```',
  ].join('\n');

  const DEMO_ANSWER = [
    'Нашёл **5 источников**. Коротко:',
    '',
    '- завтра в Москве облачно, около `+7°`;',
    '- к вечеру возможен небольшой дождь;',
    '- ветер слабый, 3–5 м/с.',
    '',
    'Зонт лучше взять с собой.',
  ].join('\n');

  async function runCommandSteps(name, steps) {
    status('acting');
    const results = [];
    for (const s of steps) {
      if (state.aborted) break;
      results.push(await tool(s.tool, s.args, { skipPolicy: true, noThink: true, delay: 700 }));
    }
    const ok = results.length === steps.length && results.every((r) => r.ok);
    emit({ type: 'text', delta: ok ? `Команда «${name}» выполнена.` : `Команда «${name}» остановлена на шаге с ошибкой.` });
    return { ok, results };
  }

  function libByPhrase(t) {
    return LIBRARY.find((e) => e.phrases.some((p) => p.toLowerCase() === t));
  }

  async function runTurn(text, files) {
    state.busy = true;
    state.aborted = false;
    const t = text.toLowerCase().trim();
    let answer = '';
    const say = async (s, chunk, pause) => { answer += s; await stream(s, chunk, pause); };

    try {
      const cmd = commands.find((c) => c.enabled && c.phrases.some((p) => p.toLowerCase() === t));
      const lib = libByPhrase(t);
      if (cmd || lib) {
        const out = cmd
          ? await runCommandSteps(cmd.name, cmd.steps)
          : await runCommandSteps(lib.title, [{ tool: 'lib_' + lib.id, args: {} }]);
        if (cmd) cmd.lastRunAt = new Date().toISOString();
        answer = out.ok ? 'Команда выполнена.' : 'Команда остановлена.';
        return;
      }

      status('thinking');
      await sleep(1400);

      if (t.includes('сбой')) {
        emit({ type: 'error', message: 'Мозг недоступен: 503 Service Unavailable (эмуляция)' });
        status('error');
        return;
      }
      if (files.length) {
        await say(`Получил ${files.length} ${files.length === 1 ? 'файл' : 'файла(ов)'}: ${files.map((p) => '`' + p.split(/[\\/]/).pop() + '`').join(', ')}.\n\n`);
      }
      // Демо-сценарий для шара: думаю → ищу → отвечаю → готово.
      if (t.includes('демо')) {
        await tool('web_search', { query: 'погода завтра в Москве' }, { delay: 2600 });
        if (state.aborted) return;
        await sleep(900);
        await say(DEMO_ANSWER, 3, 70);
        return;
      }
      if (t.includes('действие')) {
        await tool('volume_set', { percent: 30 }, { delay: 2600 });
        await sleep(500);
        await say('Громкость теперь **30%**.', 4, 60);
        return;
      }
      const all = t.includes('всё');
      let did = false;
      const vol = /громкост\D*(\d{1,3})/.exec(t);
      if (vol || all) { await say('Меняю громкость.'); await tool('volume_set', { percent: vol ? Math.min(100, Number(vol[1])) : 30 }); did = true; }
      const url = /([a-z0-9-]+\.(?:com|org|ru|net|io)[^\s]*)/i.exec(text);
      if (url || all) { await say(did ? '\n\nТеперь открою адрес.' : 'Открываю адрес.'); await tool('url_open', { url: 'https://' + (url ? url[1] : 'github.com') }); did = true; }
      if (t.includes('блокнот') || t.includes('запусти') || all) { await say('\n\nЗапускаю программу.'); await tool('app_open', { name: t.includes('нет') ? 'нет-такой' : t.includes('провал') ? 'сбой' : 'notepad' }); did = true; }
      if (t.includes('окна')) { await tool('windows_list', {}); await say('Открыто **6 окон**: браузер, редактор, терминал и ещё три.'); did = true; }
      if (t.includes('напомни')) { const m = /(\d+)\s*мин/.exec(t); await tool('remind_in', { minutes: m ? Number(m[1]) : 10, text: 'размяться' }); await say('Напоминание поставлено.'); did = true; }
      if (t.includes('команд') || t.includes('ошибк') || all) { await say('\n\nВыполняю команду PowerShell.'); await tool('shell_run', { command: t.includes('ошибк') ? 'Get-Ошибка' : 'Get-Date' }); did = true; }
      if (t.includes('умеешь') || t.includes('markdown') || all) { await say((did ? '\n\n' : '') + MD_SAMPLE); did = true; }
      if (t.includes('html')) { await say((did ? '\n\n' : '') + 'Проверка экранирования: <img src=x onerror="alert(1)"> и <b>не жирный</b>, а **жирный**.'); did = true; }
      if (t.includes('долго')) {
        for (let i = 1; i <= 40 && !state.aborted; i++) { await say(`Абзац ${i}: длинный ответ, чтобы проверить кнопку «Стоп». `); await sleep(120); }
        did = true;
      }
      if (!did) {
        await say(`Принял: «${text}». Это **эмуляция**: мозг не подключён, поэтому отвечаю заглушкой.\n\nПопробуйте: \`демо\`, \`действие\`, \`открой github.com\`, \`громкость 30\`.`);
      }
      if (did && !state.aborted) await say('\n\nГотово.');
    } finally {
      if (state.aborted) emit({ type: 'text', delta: '\n\nОстановлено.' });
      if (answer) history.push({ role: 'assistant', text: answer });
      state.busy = false;
      emit({ type: 'done' });
      status('idle');
    }
  }

  const commandsFail = params.get('cmdfail') === '1';
const stubMemory = params.get('memory') === '0' ? [] : [
  { id: 'm1', text: 'Владелец предпочитает тёмную тему и короткие ответы', kind: 'preference', createdAt: new Date(Date.now() - 7200e3).toISOString() },
  { id: 'm2', text: 'Проект Nox — Electron-приложение для Windows', kind: 'project', about: 'Nox', createdAt: new Date(Date.now() - 86400e3).toISOString() },
];
const stubReminders = params.get('reminders') === '0' ? [] : [
  { id: 'r1', text: 'Размяться', dueAt: new Date(Date.now() + 3000e3).toISOString(), repeat: null, done: false },
];
  const failCmd = async () => { if (commandsFail) throw new Error('Error invoking remote method: No handler registered (эмуляция)'); };

  function validate(cmd) {
    if (!cmd || typeof cmd !== 'object') return 'пустая команда';
    if (!String(cmd.name || '').trim()) return 'Нужно имя команды.';
    if (!Array.isArray(cmd.phrases) || !cmd.phrases.length) return 'Нужна хотя бы одна фраза.';
    if (cmd.phrases.length > 5) return 'Не больше 5 фраз.';
    if (!Array.isArray(cmd.steps) || !cmd.steps.length) return 'Нужен хотя бы один шаг.';
    if (cmd.steps.length > 10) return 'Не больше 10 шагов.';
    for (const s of cmd.steps) if (!RISK[s.tool]) return `Неизвестный инструмент: ${s.tool}`;
    for (const p of cmd.phrases) {
      const other = commands.find((c) => c.id !== cmd.id && c.phrases.some((q) => q.toLowerCase() === String(p).toLowerCase()));
      if (other) return `Фраза «${p}» уже занята командой «${other.name}».`;
    }
    return '';
  }

  const SAMPLE_FILES = [
    { name: 'отчёт за квартал.pdf', path: 'C:\\Users\\me\\Documents\\отчёт за квартал.pdf', size: 248512 },
    { name: 'заметки.txt', path: 'C:\\Users\\me\\Desktop\\заметки.txt', size: 1830 },
    { name: 'план.md', path: 'C:\\Users\\me\\Documents\\план.md', size: 5120 },
    { name: 'фото.jpg', path: 'C:\\Users\\me\\Pictures\\фото.jpg', size: 3145728 },
  ];
  let pickRound = 0;

  const taskHidden = new Set();
  const TASK_ROWS = [
    { id: "tmvvbdz1p7fd80f", title: "Пять шагов о чае (jarvis-acceptance/live-03)", status: "unverified", reason: "", updatedAt: Date.now() - 3600e3, report: "D:/nox-assistant/workspace/reports/task-tmvvbdz1p7fd80f.md" },
    { id: "tmvvread0000001", title: "Прочитать файлы inbox (пример чтения)", status: "unverified", reason: "", updatedAt: Date.now() - 600e3, report: null, verdict: { code: "not_applicable", reason: "задача только читала: шагов-действий нет" } },
    { id: "tmvv9eqo58d6e66", title: "План калькулятора на Python (jarvis-acceptance/live-01)", status: "blocked", reason: "шаг не получился 3 раза подряд", updatedAt: Date.now() - 2 * 86400e3, report: null },
  ];
  const demoMail = { credentials: true, connected: false, readable: false };
  const api = {
    send: async (text, files) => {
      if (state.busy) return { ok: false, error: 'busy' };
      if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty' };
      const paths = Array.isArray(files) ? files.filter((p) => typeof p === 'string').slice(0, 5) : [];
      history.push({ role: 'user', text: text.trim() });
      runTurn(text.trim(), paths);
      return { ok: true, command: null };
    },
    stop: async () => {
      if (state.busy) state.aborted = true;
      for (const [id, resolve] of pending) { pending.delete(id); resolve('reject'); }
      return { ok: true };
    },
    getState: async () => ({ mode: state.mode, model: state.model, hasKey: state.hasKey }),
    mailState: async () => ({ ...demoMail }),
    mailConnect: async (read) => { demoMail.connected = true; demoMail.readable = read === true; return { ok: true }; },
    mailDisconnect: async () => { demoMail.connected = false; demoMail.readable = false; return { ok: true }; },
    setMode: async (mode) => {
      if (!['full', 'ask', 'auto'].includes(mode)) return { ok: false, mode: state.mode };
      state.mode = mode;
      return { ok: true, mode };
    },
    respondApproval: async (id, decision) => {
      const resolve = pending.get(id);
      if (!resolve || !['once', 'session', 'reject'].includes(decision)) return { ok: false };
      pending.delete(id);
      resolve(decision);
      return { ok: true };
    },
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    accountState: async () => ({ enabled: false }),
    mcpState: async () => ({ servers: mcpStub.map((s) => ({ ...s })) }),
    mcpAdd: async (name, target, args) => {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) return { ok: false, error: 'Название: латиница, цифры, «-» и «_», до 40 знаков' };
      if (mcpStub.some((s) => s.name === name)) return { ok: false, error: 'Такое название уже есть' };
      mcpStub.push({ name, transport: /^https?:/i.test(target) ? 'http' : 'stdio', target, disabled: false, connected: false });
      return { ok: true, servers: mcpStub.map((s) => ({ ...s })) };
    },
    mcpToggle: async (name, disabled) => { const s = mcpStub.find((x) => x.name === name); if (s) s.disabled = disabled; return { ok: true, servers: mcpStub.map((x) => ({ ...x })) }; },
    mcpRemove: async (name) => { const i = mcpStub.findIndex((x) => x.name === name); if (i >= 0) mcpStub.splice(i, 1); return { ok: true, servers: mcpStub.map((x) => ({ ...x })) }; },
    getSettings: async () => ({ ...settings, voiceVolume: 1, voiceRate: 1, voiceSpeaker: null, clipboardHistory: settings.clipboardHistory === true }),
    voiceState: async () => ({ ok: true, provider: 'local', available: true, reason: null, cloudAvailable: false, options: { speaker: settings.voiceSpeaker || null, volume: settings.voiceVolume ?? 1, rate: settings.voiceRate ?? 1 } }),
    voiceVoices: async () => ({ ok: true, voices: [{ id: 'baya', title: 'Бая' }, { id: 'aidar', title: 'Айдар' }] }),
    setSetting: async (key, value) => {
      await sleep(120);
      if (params.get('failset') === '1' || window.__jarvisStub.failSettings) return { ok: false };
      if (key === 'voiceVolume') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 1) return { ok: false };
        settings.voiceVolume = n;
        return { ok: true, value: n };
      }
      if (key === 'voiceRate') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0.5 || n > 2) return { ok: false };
        settings.voiceRate = n;
        return { ok: true, value: n };
      }
      if (key === 'voiceSpeaker') {
        settings.voiceSpeaker = typeof value === 'string' && value.trim() ? value.trim() : null;
        return { ok: true, speaker: settings.voiceSpeaker };
      }
      if (!['voice', 'alwaysOnTop', 'quiet', 'autoStart', 'screenAuto', 'memoryAuto', 'dictation', 'clipboardHistory'].includes(key) || typeof value !== 'boolean') return { ok: false };
      settings[key] = value;
      return { ok: true };
    },
    setModelTier: async (tier) => {
      await sleep(80);
      if (tier !== 'fast' && tier !== 'smart') return { ok: false };
      settings.modelTier = tier;
      return { ok: true, tier };
    },
    setThinking: async (level) => {
      if (!['low', 'medium', 'high'].includes(level)) return { ok: false };
      settings.thinking = level;
      return { ok: true, level };
    },
    dealsList: async () => ({
      waiting: dealsStub.filter((d) => d.state === 'waiting'),
      failed: dealsStub.filter((d) => d.state === 'failed'),
      overdue: [], stale: [], started: [],
      unverified: dealsStub.filter((d) => d.state === 'done'),
      promised: dealsStub.filter((d) => d.state === 'promised'),
    }),
    dealClear: async (ref) => {
      const i = dealsStub.findIndex((d) => d.ref === ref);
      if (i >= 0) dealsStub.splice(i, 1);
      return { ok: i >= 0 };
    },
    widgetsData: async () => ({ weather: { city: stubCity, temp: 21, apparent: 19, precipitation: 0.2, error: null }, music: { query: 'Кино — Группа крови', service: 'youtube', at: new Date(Date.now() - 40 * 60000).toISOString() } }),
    widgetsSetCity: async (city) => {
      stubCity = String(city ?? '').trim().slice(0, 100) || null;
      return { ok: true, city: stubCity };
    },
    // Диктовка в эмуляции: слушаем → через 0,3 с «слушаю», ещё через 0,8 с тестовая фраза.
    dictationStart: async () => {
      const session = ++dictationStubSeq;
      setTimeout(() => {
        if (!dictationStubCb || session !== dictationStubSeq) return;
        dictationStubCb({ type: 'state', state: 'listening' });
        setTimeout(() => {
          if (dictationStubCb && session === dictationStubSeq) dictationStubCb({ type: 'text', text: 'тест диктовки' });
        }, 800);
      }, 300);
      return { ok: true };
    },
    dictationStop: async () => {
      dictationStubSeq++;
      return { ok: true };
    },
    onDictationEvent: (cb) => { dictationStubCb = cb; },
    recentJournal: async (limit) => journal.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200)).map((r) => ({ ...r })),
    journalSearch: async (filters) => {
      const f = filters || {};
      const q = String(f.query || '').toLowerCase();
      const items = journal
        .filter((r) => (!q || JSON.stringify(r).toLowerCase().includes(q)) && (!f.status || f.status === 'all' || r.status === f.status))
        .map((r) => ({ ...r }));
      return { ok: true, items, total: items.length, skipped: 0, problem: null };
    },
    memoryList: async () => ({ ok: true, items: stubMemory.map((m) => ({ ...m })) }),
    memoryUpdate: async (id, patch) => {
      const item = stubMemory.find((m) => m.id === id);
      if (!item) return { ok: false, error: 'такой записи нет' };
      if (patch && typeof patch.text === 'string') item.text = patch.text;
      if (patch && typeof patch.about === 'string') item.about = patch.about;
      item.updatedAt = new Date().toISOString();
      return { ok: true, item: { ...item } };
    },
    memoryRemove: async (id) => {
      const i = stubMemory.findIndex((m) => m.id === id);
      if (i < 0) return { ok: true, removed: false };
      stubMemory.splice(i, 1);
      return { ok: true, removed: true };
    },
    memoryClear: async (confirm) => {
      if (confirm !== true) return { ok: false, error: 'очистка не подтверждена' };
      const n = stubMemory.length;
      stubMemory.splice(0, stubMemory.length);
      return { ok: true, removed: n };
    },
    remindersList: async () => ({ ok: true, items: stubReminders.map((r) => ({ ...r })) }),
    remindersUpdate: async (id, patch) => {
      const item = stubReminders.find((r) => r.id === id);
      if (!item) return { ok: false, error: 'такого напоминания нет' };
      if (patch && typeof patch.text === 'string') item.text = patch.text;
      return { ok: true, item: { ...item } };
    },
    remindersCancel: async (id) => {
      const i = stubReminders.findIndex((r) => r.id === id);
      if (i < 0) return { ok: true, removed: false };
      stubReminders.splice(i, 1);
      return { ok: true, removed: true };
    },
    exportCommands: async () => ({ ok: true, canceled: true }),
    pickCommandsImport: async () => ({ ok: true, canceled: true }),
    applyCommandsImport: async () => ({ ok: false, error: 'в заглушке импорт недоступен' }),
    downloadsAnalyze: async () => ({ ok: true, status: 'ok', scanned: 12, candidates: [
      { path: 'setup-old.exe', size: 52_000_000, reason: 'старый установщик' },
      { path: 'video.tmp', size: 3_400_000, reason: 'временный файл' },
    ], candidateBytes: 55_400_000, groups: {} }),
    downloadsRemove: async (payload, confirm) => (confirm === true
      ? { ok: true, removed: (payload && payload.paths) || [], refused: [], failed: [], bytesFreed: 3_400_000, message: 'готово' }
      : { ok: false, reason: 'confirm_required', message: 'удаление только по подтверждению' }),
    clipboardHistoryState: async () => ({ ok: true, paused: false, ttlMs: 3_600_000, count: 2, chars: 40 }),
    clipboardHistoryList: async () => ({ ok: true, items: [
      { id: 'c1', text: 'Короткая заметка из буфера', createdAt: new Date().toISOString() },
      { id: 'c2', text: 'https://example.com/страница', createdAt: new Date(Date.now() - 600e3).toISOString() },
    ] }),
    clipboardHistoryRemove: async () => ({ ok: true, removed: true }),
    clipboardHistoryClear: async () => ({ ok: true, removed: 2 }),
    clipboardHistoryPause: async () => ({ ok: true, paused: true }),
    clipboardHistoryResume: async () => ({ ok: true, paused: false }),
    clipboardHistoryTtl: async () => ({ ok: true }),
    snippetsList: async () => ({ ok: true, items: [
      { id: 's1', trigger: 'подпись', text: 'С уважением, владелец Nox', updatedAt: new Date().toISOString() },
    ], state: { ok: true, count: 1 } }),
    snippetsSave: async () => ({ ok: true, item: { id: 's2', trigger: 'т', text: 'т' } }),
    snippetsRemove: async () => ({ ok: true, removed: true }),
    snippetsPreview: async (id) => ({ ok: true, id, trigger: 'подпись', text: 'С уважением, владелец Nox' }),
    snippetsInsert: async () => ({ ok: true, inserted: true }),
    desksState: async () => ({
      ok: true,
      activeId: 'd1',
      desks: [
        { id: 'd1', name: 'Работа', template: 'work', widgets: [
          { id: 'w1', type: 'tasks', x: 1, y: 1, w: 6, h: 4, config: {} },
          { id: 'w2', type: 'system', x: 7, y: 1, w: 6, h: 3, config: {} },
          { id: 'w3', type: 'weather', x: 7, y: 4, w: 6, h: 2, config: {} },
        ] },
        { id: 'd2', name: 'Медиа', template: 'media', widgets: [] },
      ],
      templates: [
        { id: 'empty', title: 'Пустой' }, { id: 'work', title: 'Работа' }, { id: 'media', title: 'Медиа' },
      ],
      types: [
        { id: 'tasks', title: 'Задачи', defaultW: 6, defaultH: 4 },
        { id: 'today', title: 'Сегодня', defaultW: 6, defaultH: 4 },
        { id: 'music', title: 'Музыка', defaultW: 6, defaultH: 4 },
        { id: 'weather', title: 'Погода', defaultW: 4, defaultH: 2 },
        { id: 'currency', title: 'Курсы валют', defaultW: 4, defaultH: 3 },
        { id: 'system', title: 'Компьютер', defaultW: 4, defaultH: 3 },
        { id: 'apps', title: 'Программы', defaultW: 4, defaultH: 3 },
        { id: 'orb', title: 'Аватар', defaultW: 12, defaultH: 6 },
        { id: 'commands', title: 'Команды', defaultW: 6, defaultH: 3 },
      ],
      data: {
        w1: { type: 'tasks', state: 'ok', value: { items: [
          { id: 't1', title: 'Проверить отчёт', status: 'running' },
          { id: 't2', title: 'Ответить на письмо', status: 'waiting_approval' },
        ], total: 2, counts: { running: 1, waiting: 1, active: 2 } }, error: null },
        w2: { type: 'system', state: 'ok', value: { cpuPercent: 23, memPercent: 61, memUsed: 9_800_000_000, memTotal: 16_000_000_000, platform: 'win32' }, error: null },
        w3: { type: 'weather', state: 'ok', value: { city: 'Москва', temp: 4, apparent: 1, precipitation: 0 }, error: null },
      },
      now: Date.now(),
    }),
    desksCreate: async () => ({ ok: true }),
    desksRename: async () => ({ ok: true }),
    desksRemove: async () => ({ ok: true }),
    desksSelect: async () => ({ ok: true }),
    desksAddWidget: async () => ({ ok: true }),
    desksMoveWidget: async () => ({ ok: true }),
    desksResizeWidget: async () => ({ ok: true }),
    desksUpdateWidget: async () => ({ ok: true }),
    desksRemoveWidget: async () => ({ ok: true }),
    recordStart: async () => ({ ok: true, recording: true, startedAt: new Date().toISOString() }),
    recordStop: async () => ({ ok: true, draft: { steps: [], warnings: [], overview: [] } }),
    recordCancel: async () => ({ ok: true }),
    recordState: async () => ({ ok: true, state: 'idle', recording: false, steps: 0, warnings: [] }),

    chatHistory: async () => history.map((m) => ({ ...m })),
    workspacesList: async () => ({ ok: true, selected: stubSpace, spaces: stubSpaces.map((space) => ({ ...space })) }),
    workspacesCreate: async (name) => {
      if (state.busy) return { ok: false, error: 'Джарвис занят' };
      const clean = String(name || '').trim();
      if (!clean || stubSpaces.some((s) => s.name.toLowerCase() === clean.toLowerCase())) return { ok: false, error: 'нужно уникальное название' };
      const space = { id: `space-${stubSpaces.length}`, name: clean };
      stubSpaces.push(space);
      return { ok: true, space };
    },
    workspacesSelect: async (id) => {
      if (state.busy) return { ok: false, error: 'Джарвис занят' };
      if (!stubSpaces.some((s) => s.id === id)) return { ok: false, error: 'пространство не найдено' };
      stubSpaceData.set(stubSpace, { history: history.map((m) => ({ ...m })), chats: JSON.parse(JSON.stringify(stubChats)) });
      const saved = stubSpaceData.get(id) || { history: [], chats: { next: 1, activeId: 'c1', chats: [{ id: 'c1', title: 'Новый чат' }] } };
      history.splice(0, history.length, ...saved.history.map((m) => ({ ...m })));
      Object.assign(stubChats, JSON.parse(JSON.stringify(saved.chats)));
      stubSpace = id;
      return { ok: true, selected: stubSpace, spaces: stubSpaces.map((space) => ({ ...space })) };
    },
    // Вкладки в эмуляции: текущая история плюс пустые чаты, без сохранения.
    chatList: async () => ({ activeId: stubChats.activeId, chats: stubChats.chats.map(({ id, title }) => ({ id, title })) }),
    chatNew: async () => {
      if (state.busy) return { ok: false, error: 'busy' };
      const id = 'c' + (++stubChats.next);
      stubChats.chats.push({ id, title: 'Новый чат' });
      stubChats.activeId = id;
      history.length = 0;
      return { ok: true, activeId: id, chats: stubChats.chats.map(({ id: i, title }) => ({ id: i, title })) };
    },
    chatSelect: async (id) => {
      if (state.busy) return { ok: false, error: 'busy' };
      stubChats.activeId = id;
      return { ok: true, activeId: id, chats: stubChats.chats.map(({ id: i, title }) => ({ id: i, title })) };
    },
    chatClose: async (id) => {
      if (state.busy) return { ok: false, error: 'busy' };
      stubChats.chats = stubChats.chats.filter((c) => c.id !== id);
      if (!stubChats.chats.length) stubChats.chats.push({ id: 'c' + (++stubChats.next), title: 'Новый чат' });
      if (stubChats.activeId === id) stubChats.activeId = stubChats.chats[0].id;
      return { ok: true, activeId: stubChats.activeId, chats: stubChats.chats.map(({ id: i, title }) => ({ id: i, title })) };
    },
    clearChat: async () => {
      if (state.busy) return { ok: false, error: 'busy' };
      history.length = 0;
      return { ok: true };
    },
    pickFiles: async () => {
      await sleep(200);
      pickRound++;
      return pickRound % 3 === 0 ? [] : SAMPLE_FILES.slice((pickRound - 1) % 3, ((pickRound - 1) % 3) + 2).map((f) => ({ ...f }));
    },
    openWorkspace: async () => { console.info('[dev-stub] открыть папку', settings.workspace); return { ok: true }; },
    addFolder: async () => {
      settings.connectedFolders = [...settings.connectedFolders, `D:\\Проекты\\папка-${settings.connectedFolders.length + 1}`];
      return { ok: true, folders: [...settings.connectedFolders] };
    },
    removeFolder: async (dir) => {
      settings.connectedFolders = settings.connectedFolders.filter((p) => p !== dir);
      return { ok: true, folders: [...settings.connectedFolders] };
    },

    // Полоса задач (?tasks=0 — без задач). Строки скрываются в памяти страницы; данных задач здесь нет.
    tasksAttention: async () => (params.get("tasks") === "0" ? [] : TASK_ROWS.filter((r) => !taskHidden.has(r.id)).map((r) => ({ ...r }))),
    tasksHideAttention: async (taskId) => {
      if (!TASK_ROWS.some((r) => r.id === taskId)) return { ok: false, error: "задача не найдена" };
      taskHidden.add(taskId);
      return { ok: true };
    },
    tasksOpenReport: async (taskId) => {
      const row = TASK_ROWS.find((r) => r.id === taskId);
      if (!row || !row.report) return { ok: false, error: "отчёта пока нет" };
      console.info("[dev-stub] открыть отчёт", row.report);
      return { ok: true };
    },
    libraryList: async () => LIBRARY.map((e) => JSON.parse(JSON.stringify(e))),
    libraryRun: async (id, values) => {
      const e = LIBRARY.find((x) => x.id === id);
      if (!e) return { ok: false, error: 'команда не найдена' };
      if (state.busy) return { ok: false, error: 'busy' };
      state.busy = true;
      state.aborted = false;
      try {
        const args = {};
        for (const a of e.args) if (values && values[a] != null) args[a] = String(values[a]);
        const out = await runCommandSteps(e.title, [{ tool: 'lib_' + e.id, args }]);
        const sum = out.results.map((r) => r.summary).filter(Boolean).join('; ');
        return { ok: out.ok, output: sum, results: out.results };
      } finally {
        state.busy = false;
        emit({ type: 'done' });
        status('idle');
      }
    },

    listCommands: async () => { await failCmd(); return commands.map((c) => JSON.parse(JSON.stringify(c))); },
    saveCommand: async (cmd) => {
      await failCmd();
      await sleep(150);
      const err = validate(cmd);
      if (err) return { ok: false, error: err };
      const clean = {
        id: cmd.id || 'cmd-' + Math.random().toString(36).slice(2, 8),
        name: String(cmd.name).trim(),
        phrases: cmd.phrases.map((p) => String(p).trim()),
        steps: cmd.steps.map((s) => ({ tool: s.tool, args: { ...s.args } })),
        enabled: cmd.enabled !== false,
        lastRunAt: (commands.find((c) => c.id === cmd.id) || {}).lastRunAt || null,
      };
      const i = commands.findIndex((c) => c.id === clean.id);
      if (i >= 0) commands[i] = clean; else commands.push(clean);
      return { ok: true, command: JSON.parse(JSON.stringify(clean)) };
    },
    deleteCommand: async (id) => {
      await failCmd();
      const before = commands.length;
      commands = commands.filter((c) => c.id !== id);
      return { ok: commands.length < before };
    },
    runCommand: async (id) => {
      await failCmd();
      const cmd = commands.find((c) => c.id === id);
      if (!cmd) return { ok: false, error: 'команда не найдена' };
      if (state.busy) return { ok: false, error: 'busy' };
      state.busy = true;
      state.aborted = false;
      try {
        const out = await runCommandSteps(cmd.name, cmd.steps);
        cmd.lastRunAt = new Date().toISOString();
        return out;
      } finally {
        state.busy = false;
        emit({ type: 'done' });
        status('idle');
      }
    },
    toolCatalog: async () => { await failCmd(); return JSON.parse(JSON.stringify(CATALOG)); },

    // Мини-режим: в браузере просто переходим между страницами.
    openMini: async () => { location.href = 'mini.html' + location.search; return { ok: true }; },
    showMain: async () => { location.href = 'index.html' + location.search; return { ok: true }; },
  };

  if (params.get('oldcore') === '1') {
    for (const k of ['listCommands', 'saveCommand', 'deleteCommand', 'runCommand', 'toolCatalog', 'openMini',
      'chatHistory', 'clearChat', 'chatList', 'chatNew', 'chatSelect', 'chatClose', 'pickFiles', 'openWorkspace', 'addFolder', 'removeFolder', 'setModelTier', 'libraryList', 'libraryRun']) delete api[k];
  }

  window.jarvis = api;
  window.__jarvisStub = { emit, state, journal, settings, history, get commands() { return commands; }, failSettings: false };
  console.info('[dev-stub] window.jarvis эмулируется. Режим:', state.mode, '| ключ:', state.hasKey);
})();
