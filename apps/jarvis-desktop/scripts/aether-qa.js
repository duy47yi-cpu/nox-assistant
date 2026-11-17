'use strict';

// Живая интерактивная и визуальная проверка Nox Aether в настоящем Electron
// во временном профиле (реальные %APPDATA% и data/ не затрагиваются).
// Запуск из apps/jarvis-desktop (со снятым ELECTRON_RUN_AS_NODE):
//   .\node_modules\electron\dist\electron.exe scripts\aether-qa.js [--out-dir <папка>] [--keep-temp]

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let electron = null;
try {
  electron = require('electron');
} catch {
  electron = null;
}
if (!electron || typeof electron !== 'object' || !electron.app || typeof electron.app.whenReady !== 'function') {
  console.error('aether-qa: требуется запуск через electron.exe, а не node (снимите ELECTRON_RUN_AS_NODE)');
  process.exit(1);
}

const { app, globalShortcut, shell } = electron;

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.resolve(arg('out-dir', path.join(REPO_ROOT, 'docs', 'design', 'nox-aether', 'screenshots-gate2')));
const KEEP_TEMP = has('keep-temp');
const CHAT_REDESIGN = has('chat-redesign');
const WIDGETS_ONLY = has('widgets-only');
const TIMEOUT_MS = 240000;
const CMD_EXE = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'cmd.exe');
const VSCODE_EXE = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
].find((file) => file && fs.existsSync(file)) || 'Visual Studio Code';

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Временный изолированный профиль и данные ──────────────────────────
for (const entry of (() => {
  try { return fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return []; }
})()) {
  if (!entry.isDirectory() || !/^nox-aether-qa-/i.test(entry.name)) continue;
  const full = path.join(os.tmpdir(), entry.name);
  try {
    if (Date.now() - fs.statSync(full).mtimeMs > 120000) fs.rmSync(full, { recursive: true, force: true });
  } catch { /* игнор */ }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-aether-qa-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(workspaceDir, 'plan.txt'), 'Список задач Aether QA\n1. Проверить пустой чат\n2. Проверить инструменты\n', 'utf8');
fs.writeFileSync(path.join(workspaceDir, 'notes.md'), '# Заметки\n\nРабочая папка стенда.\n', 'utf8');

fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  uiShell: 'aether',
  mode: 'ask',
  voice: false,
  backgroundModelRuns: false,
  alwaysListen: false,
  dictation: false,
  desktopOverlay: false,
  alwaysOnTop: false,
  motion: true,
  seededBrief: true,
  screenAuto: false,
}, null, 2), 'utf8');

const now = Date.now();
const day = 24 * 60 * 60 * 1000;
fs.writeFileSync(path.join(dataDir, 'conversation.json'), JSON.stringify({
  activeId: 'qa-empty',
  chats: [
    { id: 'qa-empty', title: 'Новый чат', updatedAt: now, history: [] },
    {
      id: 'qa-plans',
      title: 'Планы на неделю',
      updatedAt: now - 2 * day,
      history: [
        { role: 'user', content: 'Покажи план на неделю' },
        { role: 'assistant', content: 'Собрал ключевые задачи на эту неделю: обзор макетов, проверка сфер и тесты сборки.' },
      ],
    },
  ],
}, null, 2), 'utf8');

app.setPath('userData', profileDir);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = dataDir;
require('../src/config/paths').projectRoot = () => tempRoot;

// Глобальные клавиши не занимают хоткеи владельца
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

// ── Локальный OpenAI-совместимый SSE-сервер (без внешней сети) ────────
let qaErrorAttempts = 0;
let qaClockRequests = 0;
const openedPresentations = [];
const openedSources = [];
const revealedArtifacts = [];
const openedMusic = [];
if (CHAT_REDESIGN || WIDGETS_ONLY) {
  const { systemTools } = require('../src/tools/system');
  const tool = systemTools.find((tool) => tool.name === 'url_open');
  const { run, verify } = tool;
  tool.run = (args, ctx) => {
    if (!args.url.startsWith('https://www.youtube.com/results?')) return run(args, ctx);
    openedMusic.push(args.url);
    return { ok: true, summary: 'Принят адрес тестового музыкального поиска', data: { qaMusic: true } };
  };
  tool.verify = (args, result, ctx) => result.data?.qaMusic
    ? { status: 'confirmed', evidence: 'Адрес получен тестовым открывателем' } : verify(args, result, ctx);
}
shell.openExternal = async (url) => { openedSources.push(url); };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const address = new URL(input);
  if (address.hostname === 'icons.duckduckgo.com') {
    if (address.pathname.includes('example.net')) return Promise.resolve(new Response(''));
    if (has('live-source-icons')) return originalFetch(input, options);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAeUlEQVR4nGNkwAIUa/L+YxO/3zKJEV2MiVjNuOQYidGIzzVMDBQCJnJsR9bDiE/zveaJYFqpNh+/C/BpRmcTZcA9LBpwGcLEQCFgwiaIzc+4woEJl8nIGvAFIiO50QhLTEwwBjmaQTTFgYhhMyHvoLsWwwX4vINNDgCCdzEmO/zWegAAAABJRU5ErkJggg==';
    return Promise.resolve(new Response(Buffer.from(png, 'base64')));
  }
  const fixture = /^qa-sources-(\d+)-(\d+)$/.exec(address.searchParams.get('q') || '');
  if (address.hostname !== 'html.duckduckgo.com' || !fixture) return originalFetch(input, options);
  const count = Math.min(Number(fixture[1]), 5);
  const group = Number(fixture[2]);
  const hosts = ['github.com', 'ru.wikipedia.org', 'example.net'];
  const rows = Array.from({ length: count }, (_, i) => {
    const link = `https://${hosts[i % hosts.length]}/nox-qa/${group * 5 + i + 1}`;
    const title = i ? `Источник ${group * 5 + i + 1}` : 'Длинное название страницы '.repeat(9);
    return `<a class="result__a" href="${link}">${title}</a><a class="result__snippet">Фрагмент</a>`;
  });
  return Promise.resolve(new Response(rows.join('')));
};
const originalOpenPath = shell.openPath.bind(shell);
shell.openPath = (file) => {
  if (file === path.join(workspaceDir, 'qa-astronomy.pptx') ||
      (CHAT_REDESIGN && file === path.join(workspaceDir, 'Китай.pptx'))) {
    openedPresentations.push(file);
    return Promise.resolve('');
  }
  return originalOpenPath(file);
};
if (CHAT_REDESIGN) shell.showItemInFolder = (file) => { revealedArtifacts.push(file); };

function sendCompletion(res, body, chunks, delayMs, finishReason = 'stop') {
  if (!body.stream) {
    const content = chunks.map((c) => c.content || '').join('');
    const toolCalls = chunks.flatMap((c) => c.tool_calls || []).map((tc) => ({
      id: tc.id,
      type: 'function',
      function: tc.function,
    }));
    const payload = {
      id: 'qa-completion',
      object: 'chat.completion',
      model: body.model || 'deepseek-ai/DeepSeek-V3.2-Exp',
      choices: [{
        index: 0,
        message: toolCalls.length ? { role: 'assistant', content: content || null, tool_calls: toolCalls } : { role: 'assistant', content },
        finish_reason: finishReason,
      }],
      usage: { prompt_tokens: 18, completion_tokens: 32, total_tokens: 50 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  writeSse(res, chunks, delayMs, finishReason);
}

function writeSse(res, chunks, delayMs, finishReason = 'stop') {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  let timer = null;
  res.on('close', () => { closed = true; if (timer) clearTimeout(timer); });

  let idx = 0;
  const emit = (delta, reason) => {
    const payload = {
      id: 'qa-stream',
      object: 'chat.completion.chunk',
      model: 'qa-local-model',
      choices: [{ index: 0, delta, finish_reason: reason || null }],
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const step = () => {
    if (closed) return;
    if (idx < chunks.length) {
      emit(chunks[idx], null);
      idx += 1;
      timer = setTimeout(step, delayMs);
      return;
    }
    emit({}, finishReason);
    res.write(`data: ${JSON.stringify({ id: 'qa-stream', object: 'chat.completion.chunk', model: 'qa-local-model', choices: [], usage: { prompt_tokens: 18, completion_tokens: 32, total_tokens: 50 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  step();
}

function startQaBrainServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
        const lastRole = messages.length ? messages[messages.length - 1].role : '';
        const text = String((lastUser && lastUser.content) || '');
        if (/который час/i.test(text)) qaClockRequests += 1;
        console.error('[qa-brain]', req.method, req.url, 'stream=', Boolean(body.stream), 'lastRole=', lastRole, 'user=', text.slice(0, 60));

        if (CHAT_REDESIGN) {
          const latestTool = messages.at(-1);
          const call = (name, args, id) => sendCompletion(res, body, [{
            tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          }], 40, 'tool_calls');
          if (/Открой терминал и VS Code\s*$/i.test(text)) {
            if (lastRole !== 'tool') return call('app_open', { name: CMD_EXE }, 'chat_terminal');
            if (latestTool.tool_call_id === 'chat_terminal') return call('app_open', { name: VSCODE_EXE }, 'chat_code');
            const confirmed = (id) => messages.some((m) => m.tool_call_id === id && /"verified"\s*:\s*"confirmed"/.test(m.content));
            const terminal = confirmed('chat_terminal');
            const code = confirmed('chat_code');
            const result = terminal && code ? 'Открыл терминал и VS Code.'
              : [terminal ? 'Терминал открыт.' : 'Открытие терминала не подтверждено.', code ? 'VS Code открыт.' : 'Открытие VS Code не подтверждено.'].join(' ');
            return sendCompletion(res, body, [{ content: result }], 180);
          }
          if (/Сделай презентацию про Китай\s*$/i.test(text)) {
            if (lastRole !== 'tool') return call('document_write', {
              path: 'Китай.pptx', format: 'pptx', title: 'Китай', subtitle: 'Культура, география и технологии',
              slides: [
                ['География', 'Побережье Тихого океана и высокогорья запада'],
                ['Исторические города', 'Пекин, Сиань и Нанкин'],
                ['Письменность', 'Иероглифы в повседневной жизни'],
                ['Праздники', 'Китайский Новый год и Праздник фонарей'],
                ['Кухня', 'Региональное разнообразие традиций'],
                ['Промышленность', 'Производственные и транспортные связи'],
                ['Технологии', 'Электротранспорт и солнечная энергетика'],
                ['Вывод', 'История и современные технологии соседствуют'],
              ].map(([title, bullet]) => ({ title, bullets: [bullet] })),
            }, 'chat_pptx');
            const made = /"verified"\s*:\s*"confirmed"/.test(latestTool.content);
            return sendCompletion(res, body, [{ content: made ? 'Подготовил презентацию о Китае. В ней 9 слайдов.' : 'Не удалось создать презентацию.' }], 140);
          }
          if (/Создай таблицу и сохрани копию\s*$/i.test(text)) {
            if (lastRole !== 'tool') return call('document_write', { path: 'План.xlsx', format: 'xlsx', title: 'План', rows: [
              ['Задача', 'Статус'], ['Проверить файлы', 'Готово'], ['Сверить отчёт', 'В работе'],
            ] }, 'chat_table');
            if (latestTool.tool_call_id === 'chat_table') return call('document_write', { path: 'Копия.pdf', format: 'xlsx', rows: [['План']] }, 'chat_copy');
            const toolSucceeded = /"verified"\s*:\s*"confirmed"/.test(latestTool.content);
            return sendCompletion(res, body, [{ content: toolSucceeded
              ? 'Создал таблицу и копию.' : 'Создал таблицу. Копию пока не удалось сохранить.' }], 180);
          }
          if (/Помоги с учёбой\s*$/i.test(text)) return call('clarify', {
            question: 'Что подготовить для учёбы?',
            options: ['Доклад', 'Презентация', 'Таблица'],
          }, 'chat_clarify');
        }

        const sourceFixture = /Проверка ссылок (0|1|5|20)\b/.exec(text);
        if (sourceFixture) {
          const count = Number(sourceFixture[1]);
          if (lastRole !== 'tool') {
            const tool_calls = Array.from({ length: count === 20 ? 4 : 1 }, (_, i) => ({
              index: i,
              id: `qa_search_${i}`,
              type: 'function',
              function: { name: 'web_search', arguments: JSON.stringify({ query: `qa-sources-${count}-${i}` }) },
            }));
            sendCompletion(res, body, [{ tool_calls }], 10, 'tool_calls');
          } else {
            sendCompletion(res, body, [{ content: `Результат проверки ${count}. [Ссылка в тексте](https://example.org/model-only)` }], 10);
          }
          return;
        }

        if (/проверка появления ответа/i.test(text)) {
          await sleep(3500);
          sendCompletion(res, body, [
            { content: '**Сначала вывод.**' },
            { content: '\n\nЗатем короткое пояснение.\n\n$$\\frac{3}{5}+\\frac{1}{4}=\\frac{17}{20}$$\n\n**Ответ: $0{,}85$.**\n\n* Оговорка с *курсивом*.' },
          ], 1200);
          return;
        }
        if (/Стрелец A\*/i.test(text)) {
          sendCompletion(res, body, [{ content: 'Стрелец A* — сверхмассивная чёрная дыра в центре Млечного Пути.' }], 10);
          return;
        }
        if (/презентацию об этом/i.test(text)) {
          const prior = messages.some((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('Стрелец A*'));
          const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
          const call = (name, args) => sendCompletion(res, body, [{
            tool_calls: [{ index: 0, id: `qa_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          }], 15, 'tool_calls');
          if (!prior) { sendCompletion(res, body, [{ content: 'Не вижу тему.' }], 10); return; }
          if (lastRole !== 'tool') {
            call('document_write', { path: 'qa-astronomy.pptx', format: 'pptx', title: 'Стрелец A*',
              slides: [{ title: 'Где находится', bullets: ['Центр Млечного Пути'] }] });
          } else if (lastTool?.tool_call_id === 'qa_document_write') {
            call('presentation_open', { path: 'qa-astronomy.pptx' });
          } else {
            sendCompletion(res, body, [{ content: 'Создан файл qa-astronomy.pptx: 2 слайда. Проверка открытия показана ниже.' }], 10);
          }
          return;
        }
        // Тест ошибки и восстановления по кнопке «Повторить»
        if (/ошибку модели/i.test(text)) {
          qaErrorAttempts += 1;
          if (qaErrorAttempts === 1) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'QA upstream simulated 503 failure' } }));
            return;
          }
          sendCompletion(res, body, [{ content: 'Повторный запрос прошёл успешно: модель восстановила ответ.' }], 10);
          return;
        }

        // Вызов инструмента (без подтверждения: список файлов) + заметная живая фаза
        if (/проверь файлы папки/i.test(text)) {
          if (lastRole !== 'tool') {
            sendCompletion(res, body, [
              {
                tool_calls: [{
                  index: 0,
                  id: 'call_ws_list_1',
                  type: 'function',
                  function: { name: 'workspace_list', arguments: '{}' },
                }],
              },
            ], 20, 'tool_calls');
            return;
          }
          // Оставляем время увидеть несколько циклов блика после работы инструмента.
          await sleep(4000);
          sendCompletion(res, body, [
            { content: 'Проверил рабочую папку: внутри найдены файлы `plan.txt` и `notes.md`. Все подробности и список шагов убраны в блок под ответом.' },
          ], 15);
          return;
        }

        // Запись файла в режиме ask -> вызывает R3-01 подтверждение
        if (/запиши заметку/i.test(text)) {
          if (lastRole !== 'tool') {
            const args = JSON.stringify({ path: /qa-stop/i.test(text) ? 'qa-stop.txt' : 'qa-check.txt', content: 'Проверка подтверждения R3-01 в Nox Aether.\n' });
            sendCompletion(res, body, [
              {
                tool_calls: [{
                  index: 0,
                  id: 'call_ws_write_1',
                  type: 'function',
                  function: { name: 'workspace_write', arguments: args },
                }],
              },
            ], 20, 'tool_calls');
            return;
          }
          sendCompletion(res, body, [{ content: 'Готово: файл `qa-check.txt` создан после вашего подтверждения.' }], 15);
          return;
        }

        // Длинный структурированный ответ: заголовки, список, таблица, код, формулы
        if (/длинный ответ/i.test(text)) {
          const longMd = [
            '## Архитектурная сводка Nox Aether\n\n',
            'Новая оболочка разделяет слой состояния, композицию чата и библиотеку сфер.\n\n',
            '### Ключевые принципы\n\n',
            '1. **Спокойный диалог** — внимание сосредоточено на вопросе, ответе и живой сфере.\n',
            '2. **Оба движка сфер сохранены** — *NoxOrb* (`Nox`, `Контур`, `Диафрагма`) и *JarvisOrb* (`Ядро`, `Точечный`, `Ирис`) работают без изменений.\n',
            '3. **Минимум шума** — технические шаги и аргументы инструментов скрыты в «Подробности».\n\n',
            '| Модуль | Назначение | Состояние |\n',
            '| --- | --- | --- |\n',
            '| Topbar | 5 разделов + «Разделы» для узкого окна | Готово |\n',
            '| OrbLibrary | Независимые настройки и пресеты | Готово |\n',
            '| ApprovalCard | R3-01 защита и обратный отсчёт | Готово |\n\n',
            '```js\nconst snap = window.NoxOrbLibrary.getSnapshot();\nwindow.NoxOrbLibrary.setActive(\'jarvis:core\');\n```\n\n',
            'Проверка встроенной математики: энергия $E = mc^2$ и интеграл:\n\n',
            '$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\n\n',
            'Дополнительные абзацы для проверки прокрутки и кнопки возврата вниз:\n\n',
            Array.from({ length: 12 }, (_, i) => `- Пункт ${i + 1}: проверка плавной прокрутки длинного ответа без наезда на поле ввода и без смещения сферы.`).join('\n'),
          ];
          sendCompletion(res, body, longMd.map((c) => ({ content: c })), 8);
          return;
        }

        // Обычный короткий ответ
        sendCompletion(res, body, [
          { content: 'Привет! ' },
          { content: 'Готов помочь по проекту и файлам рабочей папки. Чем займёмся?' },
        ], 15);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ── Утилиты окна и снимков ────────────────────────────────────────────
let mainWin = null;
let finished = false;
const consoleErrors = [];
const pageErrors = [];
const startedAt = Date.now();

async function js(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

async function settle(win, ms = 120) {
  if (ms) await sleep(ms);
  await js(win, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))').catch(() => false);
}

async function setViewport(win, width, height) {
  try { win.setMinimumSize(200, 200); } catch { /* ignore */ }
  win.setContentSize(width, height);
  for (let i = 0; i < 60; i += 1) {
    const [w, h] = win.getContentSize();
    if (w === width && h === height) break;
    await sleep(30);
  }
  await settle(win, 180);
}

async function shot(win, fileName, rect) {
  try { win.showInactive(); } catch { /* visible */ }
  await settle(win, 120);
  const img = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const filePath = path.join(OUT_DIR, fileName);
  fs.writeFileSync(filePath, img.toPNG());
  const sz = img.getSize();
  return { name: fileName, file: filePath, width: sz.width, height: sz.height, bytes: fs.statSync(filePath).size };
}

function cleanupTemp() {
  if (KEEP_TEMP) return;
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* locked by chromium */ }
  if (process.platform === 'win32') {
    try {
      const child = require('child_process').spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${tempRoot}"`],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
    } catch { /* ignore */ }
  }
}

let brainSrv = null;
function finish(report, code = 0) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  try { if (brainSrv && brainSrv.server) brainSrv.server.close(); } catch { /* ignore */ }
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'qa-report.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log('AETHER_QA_RESULT ' + JSON.stringify({
    ok: report.ok,
    pass: report.pass,
    fail: report.fail,
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
    report: path.join(OUT_DIR, 'qa-report.json'),
  }));
  cleanupTemp();
  app.exit(code);
}

const deadline = setTimeout(() => {
  finish({ ok: false, error: `Timeout ${TIMEOUT_MS}ms`, consoleErrors, pageErrors }, 1);
}, TIMEOUT_MS);

async function sendText(win, text) {
  await js(win, `(() => {
    const ta = document.querySelector('#chatInput');
    ta.focus();
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return document.activeElement === ta;
  })()`);
}

async function waitUntil(fn, timeout = 15000, interval = 80) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const val = await fn();
    if (val) return val;
    await sleep(interval);
  }
  return null;
}

async function waitIdle(win, timeout = 18000) {
  const ok = await waitUntil(() => js(win, `(() => {
    const st = window.__noxAether && window.__noxAether.store && window.__noxAether.store.state;
    return st && !st.trackerBusy && !st.sendingLock;
  })()`).catch(() => false), timeout, 80);
  if (!ok) {
    const diag = await js(win, `(() => {
      const st = window.__noxAether?.store?.state;
      return { busy: st?.trackerBusy, lock: st?.sendingLock, activeTurn: st?.activeTurn, errs: window.__qaErrs };
    })()`).catch(() => null);
    throw new Error('waitIdle timeout: ' + JSON.stringify(diag));
  }
  return ok;
}

async function checkDayWidgets(win, check, captureBoth) {
  const panel = '.ae-day-widgets';
  const selector = (suffix) => JSON.stringify(`${panel} ${suffix}`);
  const waitForMusic = (state) => waitUntil(() =>
    js(win, `document.querySelector('${panel}')?.dataset.music === ${JSON.stringify(state)}`), 3000);
  const setRoute = (route) => js(win, `window.__noxAether.setRoute(${JSON.stringify(route)})`);
  const reopenChat = async () => {
    await setRoute('settings');
    await setRoute('chat');
  };
  const file = path.join(dataDir, 'music-history.json');
  const reminder = path.join(dataDir, 'reminders.json');
  const bad = '{ повреждённая история';
  const text = 'Кино — Группа крови';
  await setViewport(win, 1200, 720);
  const legacy = await js(win, 'window.jarvis.widgetsData()');
  check('Классический экран получает прежний ответ', legacy.weather && legacy.music === null && !legacy.version, legacy);

  const empty = await waitForMusic('empty') && await js(win, `(() => {
    const el = document.querySelector('${panel}');
    return el.innerText.includes('Ещё не включали') && el.querySelector('.ae-day-cover').hidden
      && el.querySelector('.ae-day-open').hidden && !el.querySelector('.ae-day-pick').hidden
      && el.querySelector('.ae-day-reminder').hidden;
  })()`);
  check('Пустая история и отсутствие напоминаний', empty);
  const draft = await js(win, `(() => {
    const store = window.__noxAether.store;
    const before = store.state.feedItems.length;
    document.querySelector(${selector('.ae-day-pick')}).click();
    const field = document.activeElement;
    const picked = field.matches('textarea') && field.value === 'включи музыку' && store.state.feedItems.length === before;
    field.value = 'Мой черновик';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector(${selector('.ae-day-pick')}).click();
    const kept = field.value === 'Мой черновик';
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return { picked, kept };
  })()`);
  check('Подобрать музыку заполняет черновик и сохраняет ранее написанное', draft.picked && draft.kept, draft);

  fs.writeFileSync(file, bad, 'utf8');
  await reopenChat();
  const damaged = await waitForMusic('error') && await js(win, `(() => {
    const el = document.querySelector('${panel}');
    return el.innerText.includes('Файл истории повреждён') &&
      el.querySelector('[role=status]').textContent.includes('История музыки недоступна');
  })()`);
  check('Повреждённая история, объявление ошибки и сохранность файла', damaged && fs.readFileSync(file, 'utf8') === bad);

  const due = new Date(Math.min(Date.now() + 40 * 60000, new Date().setHours(23, 59, 59, 999)));
  new (require('../src/schedule/store').ReminderStore)(reminder).add({ text: 'Созвон по макету', dueAt: due });
  fs.writeFileSync(file, JSON.stringify([{ query: text, service: 'youtube', at: new Date().toISOString() }]), 'utf8');
  const web = [];
  const fetch = globalThis.fetch;
  const settingsFile = path.join(dataDir, 'settings.json');
  const settings = fs.readFileSync(settingsFile, 'utf8');
  fs.writeFileSync(settingsFile, JSON.stringify({
    ...JSON.parse(settings),
    city: 'Астана',
    calendar: { type: 'url', url: 'https://calendar.example.test/schedule.ics' },
  }), 'utf8');
  globalThis.fetch = (input) => {
    web.push(new URL(input.url || input).hostname);
    return Promise.resolve(new Response('', { status: 503 }));
  };
  const resources = await js(win, 'performance.getEntriesByType("resource").length');
  let recovered;
  try {
    await js(win, `document.querySelector(${selector('.ae-day-retry')}).click()`);
    recovered = await waitForMusic('ok');
  } finally {
    globalThis.fetch = fetch;
    fs.writeFileSync(settingsFile, settings, 'utf8');
  }
  const network = await js(win, `performance.getEntriesByType('resource').slice(${resources})
    .map((entry) => entry.name).filter((url) => /^https?:/.test(url))`);
  check('Повторить обновляет панель и не обращается к сети', recovered && web.length === 0 && network.length === 0, { web, network });
  const reminderVisible = await js(win, `document.querySelector(${selector('.ae-day-reminder')}).innerText`);
  check('Строка «Далее» загружена из напоминаний', /Созвон по макету/.test(reminderVisible), reminderVisible);

  for (const [w, h] of [[1200, 720], [864, 520]]) {
    await setViewport(win, w, h);
    const geometry = await js(win, `(() => {
      const el = document.querySelector('${panel}');
      const stage = el.parentElement.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const sphere = document.querySelector('.ae-orb-caption').getBoundingClientRect();
      const time = el.querySelector('time');
      const system = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      return { width: Math.round(box.width), height: Math.round(box.height),
        fits: box.top >= sphere.bottom && box.bottom <= stage.bottom && box.left >= stage.left && box.right <= stage.right
          && el.scrollWidth === el.clientWidth && document.documentElement.scrollWidth <= innerWidth,
        time: time.textContent, system, offset: el.classList.contains('is-compact') };
    })()`);
    check(`Системные часы и геометрия ${w}×${h}`, geometry.fits && geometry.time === geometry.system
      && geometry.offset === (w === 864) && geometry.height === (w === 864 ? 64 : 164), geometry);
  }
  await captureBoth('09-виджеты');
  await setViewport(win, 1200, 720);
  win.focus();
  await js(win, "document.querySelector('.ae-orb-canvas-wrap').focus()");
  async function tab() {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await settle(win, 40);
    return js(win, `({ label: document.activeElement.getAttribute('aria-label'),
      outline: getComputedStyle(document.activeElement).outlineWidth })`);
  }
  const first = await tab();
  const second = await tab();
  check('Последовательность Tab и видимый контур', first.label === `Открыть снова: ${text}` && first.outline === '2px'
    && second.label === 'Подобрать музыку' && second.outline === '2px', { first, second });
  await js(win, `document.querySelector(${selector('.ae-day-open')}).click()`);
  const open = await waitUntil(() => openedMusic.at(-1), 3000);
  check('Открыть снова отправляет точный поиск в сохранённый сервис', open && new URL(open).searchParams.get('search_query') === text, open);

  const looks = await js(win, `(() => {
    const el = document.querySelector('${panel}');
    const root = document.documentElement;
    const previous = { theme: root.dataset.theme, motion: root.dataset.motion, glass: root.dataset.glass };
    const result = ['dark', 'light'].map((theme) => {
      root.dataset.theme = theme;
      root.dataset.motion = 'off';
      root.dataset.glass = 'off';
      const style = getComputedStyle(el);
      const luminance = (value) => value.match(/\\d+/g).slice(0, 3).map(Number).map((n) => n / 255)
        .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
      const bg = luminance(style.backgroundColor);
      const fg = luminance(getComputedStyle(el.querySelector('.ae-day-date')).color);
      return { theme, blur: style.backdropFilter, motion: style.animationName,
        contrast: (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05) };
    });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete root.dataset[name];
      else root.dataset[name] = value;
    }
    return result;
  })()`);
  check('Стекло и движение выключаются, контраст в светлой и тёмной теме', looks.every((s) =>
    s.blur === 'none' && s.motion === 'none' && s.contrast >= 4.5), looks);
  const positions = await js(win, `(() => {
    const boot = window.NoxAetherBoot;
    const current = boot.readWorkshop();
    const store = window.__noxAether.store;
    const el = document.querySelector('${panel}');
    const apply = (value) => { boot.applyWorkshopToDom({ ...current, ...value }); store.notify(true); };
    const dock = ['top', 'hidden'].map((orbPosition) => {
      apply({ orbPosition });
      const composer = document.querySelector('.ae-composer-dock');
      return { beforeComposer: composer.firstElementChild === el, height: Math.round(el.getBoundingClientRect().height) };
    });
    apply({});
    const setVisibility = (value) => {
      store.setRoute('settings');
      document.querySelector('#aeSettingsView [data-section="window"]').click();
      const control = [...document.querySelectorAll('#aeSettingsView label')].find((label) =>
        label.textContent.startsWith('Панель «Часы и музыка»'))?.querySelector('select');
      if (!control) return false;
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
      store.setRoute('chat');
      return boot.readWorkshop().dayWidgets === (value === 'on');
    };
    const off = setVisibility('off') && el.hidden && el.getBoundingClientRect().height === 0;
    const restored = setVisibility('on') && !el.hidden;
    return { dock, off, restored };
  })()`);
  check('Панель переносится над вводом и скрывается настройкой',
    positions.dock.every((slot) => slot.beforeComposer && slot.height === 56) && positions.off && positions.restored, positions);
  await setViewport(win, 864, 450);
  const low = await js(win, `document.querySelector(${selector('.ae-day-music')}).hidden`);
  await setViewport(win, 650, 520);
  const narrow = await js(win, `document.querySelector('${panel}').hidden`);
  check('В низком окне остаются часы, в узком панель скрыта', low && narrow, { low, narrow });
  await setViewport(win, 864, 520);

  // Учёт интервалов самого компонента, включая переход окна в нативное скрытое состояние.
  await setRoute('settings');
  await js(win, `(() => {
    const schedule = window.setInterval;
    const clear = window.clearInterval;
    const active = new Map();
    window.setInterval = (fn, delay, ...args) => {
      const id = schedule(fn, delay, ...args);
      if (fn.name === 'render' || fn.name === 'refresh') active.set(id, delay);
      return id;
    };
    window.clearInterval = (id) => { active.delete(id); clear(id); };
    window.__qaWidgetTimers = active;
  })()`);
  await setRoute('chat');
  const timers = await js(win, '[...window.__qaWidgetTimers.values()]');
  win.webContents.setBackgroundThrottling(true);
  win.minimize();
  const suspended = await waitUntil(() =>
    js(win, 'document.hidden && window.__qaWidgetTimers.size === 0'), 2500);
  win.restore();
  win.show();
  const resumed = await waitUntil(() =>
    js(win, '!document.hidden && window.__qaWidgetTimers.size === 2'), 2500);
  win.webContents.setBackgroundThrottling(false);
  check('Тик 10 с, обновление 60 с, оба интервала останавливаются в скрытом окне',
    timers.join() === '10000,60000' && suspended && resumed, { timers, suspended, resumed });
}

async function runChatRedesignQa(win) {
  const checks = [];
  const screenshots = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const captureBoth = async (name) => {
    for (const [w, h] of [[1200, 720], [864, 520]]) {
      await setViewport(win, w, h);
      screenshots.push(await shot(win, `${name}-${w}x${h}.png`));
    }
  };
  const freshChat = () => js(win, 'window.__noxAether.store.createNewChat()');
  const lastReply = () => js(win, `[...document.querySelectorAll('#feed .is-assistant')].at(-1)?.innerText || ''`);
  const queryText = (selector) => js(win, `document.querySelector(${JSON.stringify(selector)})?.innerText || ''`);
  const approveReady = () => js(win, `document.querySelector('#aeApprovalDock [data-decision="once"]:not(:disabled)')?.click()`);
  const waitForResult = async (timeout = 18000) => {
    const done = await waitUntil(async () => {
      await approveReady();
      return js(win, `(() => {
        const { trackerBusy, sendingLock } = window.__noxAether.store.state;
        return !trackerBusy && !sendingLock;
      })()`);
    }, timeout);
    if (!done) await waitIdle(win, 1000);
  };
  const diagnostics = () => js(win, `window.__noxAether.store.state.feedItems.filter((m) => m.kind === 'error').map((m) => m.technical)`);

  if (!await waitUntil(() => js(win, 'Boolean(window.__noxAether)'))) throw new Error('Окно чата не загрузилось');
  await js(win, "window.__noxAether.setRoute('chat')");
  await checkDayWidgets(win, check, captureBoth);
  if (WIDGETS_ONLY) {
    const fail = checks.filter((c) => !c.ok).length;
    finish({ ok: fail === 0, pass: checks.length - fail, fail, checks, screenshots }, fail ? 1 : 0);
    return;
  }
  const greetings = await js(win, `(() => {
    const { store } = window.__noxAether;
    const title = document.querySelector('.ae-empty-title');
    const hero = title.parentElement;
    const field = document.querySelector('#chatInput');
    const originalGetHours = Date.prototype.getHours;
    const input = (text) => {
      field.value = text;
      field.dispatchEvent(new Event('input'));
    };
    try {
      const byHour = [4, 5, 11, 12, 17, 18].map((hour) => {
        Date.prototype.getHours = () => hour;
        store.notify(true);
        return title.textContent;
      });
      store.onDictationEvent({ type: 'state', state: 'listening' });
      const voice = title.textContent;
      store.onDictationEvent({ type: 'state', state: 'stopped' });
      const before = store.state.feedItems.length;
      input('Nox..?');
      const easterEgg = title.textContent === 'Nox..?' && hero.classList.contains('is-easter-egg')
        && field.value === 'Nox..?' && store.state.feedItems.length === before && !store.state.sendingLock;
      input('');
      return { byHour, voice, easterEgg, restored: title.textContent, controls: hero.querySelectorAll('button').length };
    } finally {
      Date.prototype.getHours = originalGetHours;
      store.notify(true);
    }
  })()`);
  check('Приветствие следует времени и диктовке, пасхалка работает локально',
    greetings.byHour.join('|') === 'Я рядом|Кофе, чай, что желаете?|Кофе, чай, что желаете?|Я рядом|Я рядом|Добрый вечер.'
    && greetings.voice === 'Слушаю.' && greetings.easterEgg && greetings.restored === 'Добрый вечер.' && !greetings.controls, greetings);

  const measureComposer = async () => js(win, `(() => {
    const chat = document.querySelector('#noxChat').getBoundingClientRect();
    const composer = document.querySelector('#aeComposer');
    const bounds = composer.getBoundingClientRect();
    const hero = document.querySelector('.ae-empty-hero').getBoundingClientRect();
    const title = document.querySelector('.ae-empty-title').getBoundingClientRect();
    const context = document.createElement('canvas').getContext('2d');
    const alpha = () => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(composer).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3];
    };
    const root = document.documentElement;
    const glass = root.dataset.glass;
    const translucent = alpha();
    root.dataset.glass = 'off';
    const opaque = alpha();
    if (glass === undefined) delete root.dataset.glass;
    else root.dataset.glass = glass;
    return {
      bottom: bounds.bottom,
      inset: chat.bottom - bounds.bottom,
      centerX: Math.abs((hero.left + hero.right - title.left - title.right) / 2),
      centerY: Math.abs((hero.top + hero.bottom - title.top - title.bottom) / 2),
      translucent, opaque,
    };
  })()`);

  await js(win, `window.__chatStates = [];
    const stage = document.querySelector('#aeOrbStage');
    const button = document.querySelector('#aeStageToggle');
    new MutationObserver(() => {
      window.__chatStates.push({ orb: stage.dataset.state, rail: button.dataset.state });
    }).observe(stage, { attributes: true, attributeFilter: ['data-state'] });`);
  const emptyLayouts = [];
  for (const [w, h] of [[1200, 720], [864, 520]]) {
    await setViewport(win, w, h);
    const layout = await measureComposer();
    emptyLayouts.push(layout);
    check(`Нижнее поле ввода, прозрачность и центр приветствия ${w}×${h}`,
      layout.inset >= 8 && layout.inset <= 24 && layout.centerX < 2 && layout.centerY < 2
      && layout.translucent > 0 && layout.translucent < 180 && layout.opaque === 255, layout);
    screenshots.push(await shot(win, `01-пустой-чат-${w}x${h}.png`));
  }
  // Рейка v2: вставная панель, бренд → «Главная», группы, подписи-пилюли.
  const railProbe = () => js(win, `(() => {
    const rail = document.querySelector('.ae-utility-rail');
    const controls = [...rail.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
    const brand = document.querySelector('#aeRailHomeBtn');
    const brandIcon = brand && brand.querySelector('svg');
    const bounds = rail.getBoundingClientRect();
    return {
      ids: controls.map((b) => b.id),
      labels: controls.every((b) => b.getAttribute('title')
        && b.getAttribute('aria-label') && b.getAttribute('data-label')),
      brandIcon: brandIcon ? Math.round(brandIcon.getBoundingClientRect().width) : 0,
      groups: [...rail.querySelectorAll('.ae-rail-group')].map((g) => g.getAttribute('aria-label')),
      panel: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width) },
      radius: getComputedStyle(rail).borderRadius,
      overflow: document.documentElement.scrollWidth > innerWidth,
      tabs: [...document.querySelectorAll('#aeTopbar .ae-nav-label')].map((tab) => tab.innerText),
    };
  })()`);
  const hoverPill = async (selector) => {
    const point = await js(win, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const bounds = el.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
    await settle(win, 320);
    const detail = await js(win, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const pseudo = getComputedStyle(el, '::before');
      const bounds = el.getBoundingClientRect();
      const context = document.createElement('canvas').getContext('2d');
      context.font = [pseudo.fontStyle, pseudo.fontWeight, pseudo.fontSize, pseudo.fontFamily].join(' ');
      const text = context.measureText(el.getAttribute('data-label') || '').width;
      const width = text + parseFloat(pseudo.paddingLeft) + parseFloat(pseudo.paddingRight)
        + parseFloat(pseudo.borderLeftWidth) + parseFloat(pseudo.borderRightWidth);
      const left = bounds.right + parseFloat(pseudo.left);
      return {
        label: el.getAttribute('data-label'),
        title: el.getAttribute('title'),
        aria: el.getAttribute('aria-label'),
        visible: pseudo.visibility === 'visible' && pseudo.opacity === '1',
        left: Math.round(left), right: Math.round(left + width), fits: left + width <= innerWidth,
      };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: win.getContentSize()[0] - 40, y: 140 });
    await settle(win, 160);
    return detail;
  };
  await setViewport(win, 1200, 720);
  const railWide = await railProbe();
  check('Рейка v2 на 1200×720: панель 56, 7 кнопок с брендом 28, группы, без скролла',
    railWide.ids.join('|') === 'aeRailHomeBtn|lxAiModalBtn|aeStageToggle|aeHistoryToggle|lxMuteBtn|aeLimitsTrigger|aeAccountTrigger'
    && railWide.labels && railWide.brandIcon === 28 && railWide.panel.width === 56
    && railWide.panel.x === 8 && railWide.radius === '16px'
    && railWide.groups.join('|') === 'Nox AI|История|Озвучка и аккаунт' && !railWide.overflow
    && railWide.tabs.join(' · ') === 'Главная · Команды · Дополнения · Nox AI · Настройки', railWide);
  const brandHome = await js(win, `(() => {
    const brand = document.querySelector('#aeRailHomeBtn');
    brand.click();
    return { route: window.__noxAether.getRoute(), current: brand.getAttribute('aria-current') };
  })()`);
  check('Бренд рейки ведёт на «Главную»', brandHome.route === 'personal' && brandHome.current === 'page', brandHome);
  const aiPill = await hoverPill('#lxAiModalBtn');
  check('Подпись верхней кнопки видна при наведении и не уходит за окно', aiPill.visible && aiPill.fits
    && aiPill.title && aiPill.aria, aiPill);
  await js(win, `window.__noxAether.setRoute('chat')`);
  win.show();
  win.focus();
  await settle(win, 160);
  await js(win, `document.querySelector('#aeRailHomeBtn').focus()`);
  await settle(win, 80);
  let tabPressed = false;
  try {
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
    });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
    });
    tabPressed = true;
  } catch { /* CDP занят — ниже обычный ввод */ }
  finally { try { win.webContents.debugger.detach(); } catch { /* ignore */ } }
  if (!tabPressed) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  }
  await settle(win, 220);
  const railFocus = await js(win, `(() => {
    let el = document.activeElement;
    const rail = document.querySelector('.ae-utility-rail');
    if (rail.contains(el) && !el.matches(':focus-visible') && typeof el.focus === 'function') {
      el.focus({ focusVisible: true });
      el = document.activeElement;
    }
    const pseudo = getComputedStyle(el, '::before');
    return {
      insideRail: rail.contains(el), id: el.id, label: el.getAttribute('data-label'),
      pill: pseudo.visibility === 'visible' && pseudo.opacity === '1',
      focusVisible: el.matches(':focus-visible'),
      outline: getComputedStyle(el).outlineWidth,
    };
  })()`);
  check('Рейка: клавиатурный фокус даёт кольцо 2 px и подпись', railFocus.insideRail
    && railFocus.pill && railFocus.focusVisible && parseFloat(railFocus.outline) >= 2, railFocus);
  await js(win, `document.activeElement.blur()`);
  await setViewport(win, 864, 520);
  const railCompact = await railProbe();
  check('Рейка v2 на 864×520: компактная панель 48, бренд 24, без скролла',
    railCompact.ids.length === 7 && railCompact.labels && railCompact.brandIcon === 24
    && railCompact.panel.width === 48 && railCompact.panel.x === 8 && railCompact.radius === '16px'
    && !railCompact.overflow, railCompact);
  const limitsPill = await hoverPill('#aeLimitsTrigger');
  const accountPill = await hoverPill('#aeAccountTrigger');
  check('Подписи «Лимиты» и «Аккаунт» на 864: hover, title/aria и помещаются в окно',
    limitsPill.visible && limitsPill.fits && limitsPill.title && limitsPill.aria
    && accountPill.visible && accountPill.fits && accountPill.title && accountPill.aria,
  { limits: limitsPill, account: accountPill });
  const railActions = await js(win, `(() => {
    const rail = document.querySelector('.ae-utility-rail');
    const stage = document.querySelector('#aeOrbStage');
    const toggle = document.querySelector('#aeStageToggle');
    const chat = document.querySelector('#noxChat');
    const opened = chat.getBoundingClientRect().width;
    toggle.focus();
    toggle.click();
    const collapsed = stage.hidden && toggle.getAttribute('aria-expanded') === 'false'
      && chat.getBoundingClientRect().width > opened && document.activeElement === toggle;
    toggle.click();
    const restored = !stage.hidden && toggle.getAttribute('aria-expanded') === 'true';
    const panels = ['Limits', 'Account'].map((key) => {
      const trigger = document.querySelector('#ae' + key + 'Trigger');
      const panel = document.querySelector('#ae' + key + 'Panel');
      trigger.click();
      const bounds = panel.getBoundingClientRect();
      const position = !panel.hidden && bounds.left > rail.getBoundingClientRect().right
        && bounds.bottom <= innerHeight && bounds.right <= innerWidth;
      panel.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return position && panel.hidden && document.activeElement === trigger;
    });
    document.activeElement.blur();
    return { collapsed, restored, panels };
  })()`);
  check('Рейка: сворачивание сферы и поповеры лимитов/аккаунта', railActions.collapsed
    && railActions.restored && railActions.panels.every(Boolean), railActions);

  await sendText(win, 'Открой терминал и VS Code');
  const progress = await waitUntil(async () => {
    await approveReady();
    const line = await queryText('#feed .is-live .ae-step-label');
    return /Открываю|открыть/i.test(line) && line;
  }, 18000);
  if (progress) screenshots.push(await shot(win, '02-ход-864x520.png'));
  const activeLayout = await measureComposer();
  check('Первая отправка сохраняет положение поля ввода', Math.abs(activeLayout.bottom - emptyLayouts[1].bottom) < 2,
    { empty: emptyLayouts[1].bottom, active: activeLayout.bottom });
  await waitForResult(43000);
  const applicationTurn = await js(win, `(() => {
    const item = window.__noxAether.store.state.feedItems.filter((m) => m.kind === 'assistant').at(-1);
    return item ? { text: item.text, status: item.workStatus,
      actions: item.actions.map(({ title, target, status, evidence }) => ({ title, target, status, evidence })) } : null;
  })()`);
  check('Открой терминал и VS Code', progress && applicationTurn?.actions.length >= 2 &&
    applicationTurn.actions.filter((a) => ['confirmed', 'done'].includes(a.status)).length === 2,
  { progress, reply: applicationTurn, errors: await diagnostics() });
  await captureBoth('03-ответ');

  await freshChat();
  await sendText(win, 'Сделай презентацию про Китай');
  await waitForResult();
  const presentation = path.join(workspaceDir, 'Китай.pptx');
  const artifact = await queryText('#feed .ae-artifact-card');
  const artifactErrors = await diagnostics();
  const artifactChat = await js(win, 'window.__noxAether.store.state.activeChatId');
  await captureBoth('04-артефакт');
  await js(win, `[...document.querySelectorAll('#feed .ae-artifact-actions button')].forEach((button) => button.click())`);
  await waitUntil(() => openedPresentations.includes(presentation) && revealedArtifacts.includes(presentation), 3000);
  const unauthorized = await js(win, `window.jarvis.artifactAction({path: 'plan.txt', action:'open'})`);
  await freshChat();
  const otherChat = await js(win, `window.jarvis.artifactAction({path: 'Китай.pptx', action:'reveal'})`);
  await js(win, `window.__noxAether.store.selectChat(${JSON.stringify(artifactChat)})`);
  const reopenedArtifact = await queryText('#feed .ae-artifact-card');
  check('Сделай презентацию про Китай', /Китай\.pptx/.test(artifact) && /9 слайдов/.test(artifact) &&
    fs.existsSync(presentation) && openedPresentations.includes(presentation) && revealedArtifacts.includes(presentation) &&
    unauthorized.ok === false && otherChat.ok === false && reopenedArtifact === artifact,
  { artifact, reopenedArtifact, opened: openedPresentations.includes(presentation), revealed: revealedArtifacts.includes(presentation), unauthorized, otherChat, errors: artifactErrors });

  await freshChat();
  await sendText(win, 'Создай таблицу и сохрани копию');
  await waitForResult();
  const partial = await queryText('#feed .ae-partial-card');
  const spreadsheet = await queryText('#feed .ae-artifact-card');
  check('Создай таблицу и сохрани копию', /Выполнено/i.test(partial) && /Не (вышло|удалось|выполнено)/i.test(partial) &&
    /План\.xlsx/.test(spreadsheet) && /3 строки/.test(spreadsheet), { reply: await lastReply(), partial, spreadsheet, errors: await diagnostics() });
  await captureBoth('05-частичный-результат');

  await freshChat();
  await sendText(win, 'Помоги с учёбой');
  await waitIdle(win);
  const clarification = await lastReply();
  const choices = await js(win, `[...document.querySelectorAll('#feed .ae-clarification button')].map((button) => button.innerText)`);
  screenshots.push(await shot(win, '06-уточнение-864x520.png'));
  await js(win, `document.querySelector('#feed .ae-clarification button')?.click()`);
  await waitIdle(win);
  const usedChoice = await js(win, `[...document.querySelectorAll('#feed .is-user')].at(-1)?.innerText || document.querySelector('#chatInput').value`);
  check('Помоги с учёбой', clarification.includes('Что подготовить для учёбы?') &&
    choices.join(' · ') === 'Доклад · Презентация · Таблица' && usedChoice.includes('Доклад'),
  { clarification, choices, usedChoice });

  await freshChat();
  await sendText(win, 'Вызови ошибку модели');
  await waitIdle(win);
  const error = await queryText('#feed .ae-error-card');
  await captureBoth('07-ошибка');
  await js(win, `[...document.querySelectorAll('#feed .ae-error-card button')].find((b) => /Повторить/.test(b.textContent))?.click()`);
  await waitIdle(win);
  const retried = await lastReply();
  check('Ошибка модели и повтор', /Не удалось получить ответ/.test(error) && /Повторить/.test(error) &&
    !/503|upstream/i.test(error) && /Повторный запрос прошёл/.test(retried), { error, retried });

  const modelPicker = await js(win, `(() => {
    const trigger = document.querySelector('#pickTrigger');
    const panel = document.querySelector('#pickPanel');
    trigger.click();
    const { left, top, right, bottom } = panel.getBoundingClientRect();
    const detail = { fits: !panel.hidden && left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight,
      text: panel.innerText };
    trigger.click();
    return detail;
  })()`);
  check('Выбор модели помещается на 864×520', modelPicker.fits && /Быстрая/.test(modelPicker.text) && /Умная/.test(modelPicker.text)
    && !/deepseek|minimax|openai|gemini|claude/i.test(modelPicker.text), modelPicker);

  await freshChat();
  await sendText(win, 'Проверь источники. Проверка ссылок 5');
  await waitForResult();
  const sourcesChat = await js(win, 'window.__noxAether.store.state.activeChatId');
  const sources = await js(win, `(() => {
    const trigger = document.querySelector('.ae-sources-trigger');
    trigger?.click();
    const panel = document.querySelector('.ae-sources-popover:popover-open');
    const links = [...(panel?.querySelectorAll('.ae-source-link') || [])].map((a) => a.href);
    panel?.hidePopover();
    return { label: trigger?.innerText, links };
  })()`);
  await freshChat();
  await js(win, `window.__noxAether.store.selectChat(${JSON.stringify(sourcesChat)})`);
  const sourcesRestored = await queryText('.ae-sources-trigger');
  check('Источники открываются и сохраняются в истории', sources.links.length === 5 &&
    sources.links.every((link) => !link.includes('model-only')) && sourcesRestored === sources.label, { ...sources, sourcesRestored });

  await freshChat();
  await sendText(win, 'Проверка появления ответа');
  const busyBeforeEscape = await waitUntil(() => js(win, 'window.__noxAether.store.state.trackerBusy'), 3000);
  win.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitIdle(win);
  const stopped = await queryText('.ae-reply-stopped');
  check('Esc останавливает активный ход', busyBeforeEscape && /Остановлено/.test(stopped), { busyBeforeEscape, stopped });

  await freshChat();
  await sendText(win, 'Покажи длинный ответ со списком, таблицей, кодом и математикой');
  await waitIdle(win);
  const folding = await js(win, `(() => {
    const details = document.querySelector('#feed .ae-long-reply details');
    const control = details?.querySelector('summary');
    const initiallyFolded = details && !details.open && control.innerText === 'Показать полностью';
    control?.click();
    const showsContent = details?.open && ['table', 'pre code', '.math'].every((selector) => details.querySelector(selector)?.getClientRects().length > 0);
    control?.click();
    return { initiallyFolded, showsContent, foldedAgain: details && !details.open };
  })()`);
  check('Длинный ответ разворачивается с таблицей, кодом и формулой', Object.values(folding).every(Boolean), folding);

  await js(win, "document.querySelector('#lxMuteBtn').click()");
  const voice = await queryText('#aeSettingsView');
  await captureBoth('08-озвучка');
  check('Настройки озвучки', /Выключена \(по умолчанию\)/.test(voice) && /Облачная/.test(voice) &&
    !/Silero|SAPI|Режим задержки|Системный голос/i.test(voice), voice);
  const states = await js(win, `window.__chatStates.filter((s, i, a) => i === 0 || a[i - 1].orb !== s.orb)`);
  check('Состояния сферы и рейки совпадают', states.every((s) => s.orb === s.rail) &&
    ['thinking', 'acting', 'success', 'error'].every((state) => states.some((s) => s.orb === state)), states);
  check('Все снимки нужного размера и без ошибок окна', screenshots.every((s) => s.name.includes(`${s.width}x${s.height}`))
    && consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors, pageErrors });

  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.length - pass;
  finish({ ok: fail === 0, pass, fail, elapsedMs: Date.now() - startedAt, checks, screenshots }, fail === 0 ? 0 : 1);
}

async function runQa(win) {
  const checks = [];
  const shots = [];
  const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  // Ждём инициализацию Aether
  const ready = await waitUntil(() => js(win, `(() => Boolean(window.__noxAether && document.querySelector('#aeTopbar') && document.querySelector('#aeOrbCanvas')))()`).catch(() => false), 15000);
  if (!ready) throw new Error('Aether UI не инициализировался за 15с');

  // Хук на ошибки внутри renderer
  await js(win, `(() => {
    window.__qaErrs = [];
    window.addEventListener('error', (e) => window.__qaErrs.push(String(e.message || e.error || 'error')));
    window.addEventListener('unhandledrejection', (e) => window.__qaErrs.push(String(e.reason || 'rejection')));
  })()`);

  // ── 1. Проверка чистоты шапки и геометрии на 1200x720 + 864x520 (Пустой чат) ──
  await setViewport(win, 1200, 720);
  const navCheck = await js(win, `(() => {
    const topText = document.querySelector('#aeTopbar').innerText;
    const tabs = [...document.querySelectorAll('#aeTopbar .ae-nav-btn')].filter((b) => b.offsetParent !== null);
    const labels = tabs.map((b) => b.title);
    const history = document.querySelector('#aeHistoryToggle');
    const account = document.querySelector('#aeAccountTrigger');
    const historyRect = history.getBoundingClientRect();
    const accountRect = account.getBoundingClientRect();
    tabs[0]?.focus();
    tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const arrowMovesFocus = document.activeElement === tabs[1];
    document.querySelector('#chatInput')?.focus();
    const chat = document.querySelector('#noxChat');
    const cr = chat.getBoundingClientRect();
    const cmp = document.querySelector('#aeComposer').getBoundingClientRect();
    const orb = document.querySelector('#aeOrbCanvas').getBoundingClientRect();
    const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    return {
      labels,
      historyInTopbar: Boolean(history.closest('#aeTopbar')),
      historyAboveAccount: history.closest('.ae-utility-rail') === account.closest('.ae-utility-rail')
        && Math.abs(historyRect.left + historyRect.width / 2 - accountRect.left - accountRect.width / 2) < 1
        && historyRect.bottom <= accountRect.top && accountRect.bottom > window.innerHeight - 24,
      arrowMovesFocus,
      hasLegacyGarbage: /Разговор|Поровну|Присутствие|Демо-данные/.test(topText),
      isEmpty: chat.classList.contains('is-empty'),
      composerAtBottom: cr.bottom - cmp.bottom >= 8 && cr.bottom - cmp.bottom <= 24,
      orbOk: orb.width > 80 && orb.height > 80,
      overflow,
      sig: document.querySelector('.ae-orb-signature')?.textContent.trim(),
    };
  })()`);
  push('topbar-clean-5-items', !navCheck.hasLegacyGarbage && navCheck.labels.length === 5 && !navCheck.historyInTopbar && navCheck.arrowMovesFocus, navCheck);
  push('history-above-account', navCheck.historyAboveAccount, navCheck);
  push('empty-chat-bottom-composer-and-orb-1200', navCheck.isEmpty && navCheck.composerAtBottom && navCheck.orbOk && !navCheck.overflow && navCheck.sig === 'The Nox', navCheck);
  shots.push(await shot(win, '01-empty-1200x720.png'));

  await setViewport(win, 864, 520);
  const narrowEmpty = await js(win, `(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    tabsFit: [...document.querySelectorAll('#aeTopbar .ae-nav-btn')].length === 5
      && [...document.querySelectorAll('#aeTopbar button')].filter((b) => b.offsetParent !== null).every((b) => {
        const rect = b.getBoundingClientRect();
        return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0
          && rect.bottom <= document.querySelector('#aeTopbar').getBoundingClientRect().bottom;
      }),
    isEmpty: document.querySelector('#noxChat').classList.contains('is-empty'),
    orbW: Math.round(document.querySelector('#aeOrbCanvas').getBoundingClientRect().width),
    cmpBottom: Math.round(document.querySelector('#aeComposer').getBoundingClientRect().bottom),
    winH: window.innerHeight,
  }))()`);
  push('empty-chat-narrow-864', !narrowEmpty.overflow && narrowEmpty.tabsFit && narrowEmpty.isEmpty && narrowEmpty.orbW > 50 && narrowEmpty.cmpBottom <= narrowEmpty.winH, narrowEmpty);
  shots.push(await shot(win, '01-empty-864x520.png'));

  // ── 2. Проверка выбора модели/обдумывания (границы и отсутствие утечек названий) ──
  const pick864 = await js(win, `(() => {
    const trig = document.querySelector('#pickTrigger');
    trig.click();
    const pan = document.querySelector('#pickPanel');
    const r = pan.getBoundingClientRect();
    const txt = pan.innerText;
    const leak = /deepseek|minimax|openai|gemini|claude/i.test(txt);
    const fits = !pan.hidden && r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
    trig.click();
    return { fits, leak, r: { l: r.left, t: r.top, r: r.right, b: r.bottom } };
  })()`);
  push('model-picker-bounds-864-no-leak', pick864.fits && !pick864.leak, pick864);

  // ── 3. Первый запуск с пустого чата -> стыковка вниз без потери фокуса, затем переключение на существующий чат ──
  await setViewport(win, 1200, 720);
  const focusKeep = await js(win, `(() => {
    const ta = document.querySelector('#chatInput');
    ta.focus();
    ta.value = 'Привет, как дела?';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return {
      activeSame: document.activeElement === ta,
      docked: document.querySelector('#noxChat').classList.contains('is-docked'),
    };
  })()`);
  await waitIdle(win);
  await settle(win, 200);
  const afterGreeting = await js(win, `(() => ({
    turns: document.querySelectorAll('#feed .ae-msg').length,
    answer: document.querySelector('#feed .ae-msg.is-assistant')?.innerText || '',
    inputCleared: document.querySelector('#chatInput').value === '',
    docked: document.querySelector('#noxChat').classList.contains('is-docked'),
  }))()`);
  push('first-send-focus-and-dock', focusKeep.activeSame && focusKeep.docked && afterGreeting.docked && afterGreeting.turns >= 2 && afterGreeting.inputCleared && afterGreeting.answer.includes('Готов помочь'), { focusKeep, afterGreeting });
  shots.push(await shot(win, '02-dialog-1200x720.png'));

  const cdp = win.webContents.debugger;
  if (!cdp.isAttached()) cdp.attach('1.3');
  const setReducedMotion = (value) => cdp.sendCommand('Emulation.setEmulatedMedia', {
    features: value ? [{ name: 'prefers-reduced-motion', value }] : [],
  });
  await setReducedMotion('no-preference');
  await js(win, `(() => {
    const root = document.documentElement;
    window.__qaReplyLook = { theme: root.dataset.theme, motion: root.dataset.motion };
    root.dataset.theme = 'signal';
    root.dataset.motion = 'off';
  })()`);
  await sendText(win, 'Проверка появления ответа');
  const replyPreparing = await waitUntil(() => js(win, `(() => {
    const live = document.querySelector('#feed .is-live');
    if (live?.querySelector('.ae-reply-author')?.textContent === 'Nox' &&
      live.querySelector('.ae-reply-thinking[role="status"]')?.textContent === 'Думаю…' &&
      !live.querySelector('.ae-assistant-body') && live.querySelector('.ae-msg-copy:disabled') &&
      !live.querySelector('.ae-step-line')) {
      window.__qaReplyUser = live.previousElementSibling;
      window.__qaReplyAuthor = live.querySelector('.ae-reply-author');
      window.__qaReplyContent = live.querySelector('.ae-reply-content');
      return true;
    }
    return false;
  })()`), 6000, 50);
  if (replyPreparing) shots.push(await shot(win, '02b-reply-preparing.png'));
  const thinkingMotion = await js(win, `(() => {
    const status = document.querySelector('.ae-reply-thinking');
    const label = status?.querySelector('.ae-reply-thinking-label');
    const dots = status?.querySelector('.ae-reply-dots');
    const steps = dots?.getAnimations().find((a) => a.animationName === 'aeReplyDots');
    const shimmer = label?.getAnimations().find((a) => a.animationName === 'aeReplyShimmer');
    if (!steps || !shimmer) return {
      frames: [],
      motion: document.documentElement.dataset.motion,
      animations: document.documentElement.dataset.animations,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
    steps.pause();
    shimmer.pause();
    const frames = [0, 500, 950].map((time) => {
      steps.currentTime = time;
      shimmer.currentTime = time;
      return {
        clip: getComputedStyle(dots).clipPath,
        light: getComputedStyle(label).backgroundPosition,
        width: dots.getBoundingClientRect().width,
      };
    });
    steps.play();
    shimmer.play();
    return {
      frames,
      confirmed: new Set(frames.map((f) => f.clip)).size === 3 &&
        new Set(frames.map((f) => f.light)).size === 3 &&
        new Set(frames.map((f) => f.width)).size === 1 &&
        getComputedStyle(label).backgroundClip === 'text' &&
        document.documentElement.dataset.motion === 'off' &&
        document.documentElement.dataset.theme === 'signal',
    };
  })()`);
  const labelRect = await js(win, `(() => {
    const rect = document.querySelector('.ae-reply-thinking-label')?.getBoundingClientRect();
    return rect ? { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) } : null;
  })()`);
  let changedLetterPixels = 0;
  if (thinkingMotion.confirmed && labelRect) {
    const pixels = [];
    for (const [idx, time] of [0, 510, 900].entries()) {
      await js(win, `(() => {
        const label = document.querySelector('.ae-reply-thinking-label');
        const dots = document.querySelector('.ae-reply-dots');
        for (const animation of [...label.getAnimations(), ...dots.getAnimations()]) {
          animation.pause();
          animation.currentTime = ${time};
        }
      })()`);
      await settle(win, 40);
      pixels.push((await win.webContents.capturePage(labelRect)).toBitmap());
      shots.push(await shot(win, `02b-thinking-close-${idx + 1}.png`, {
        x: labelRect.x - 3, y: labelRect.y - 21, width: 115, height: 78,
      }));
    }
    for (let i = 0; i < pixels[0].length; i += 4) {
      const level = pixels.map((frame) => (frame[i] + frame[i + 1] + frame[i + 2]) / 3);
      if (Math.max(...level) - Math.min(...level) >= 24) changedLetterPixels += 1;
    }
  }
  await setReducedMotion('reduce');
  const staticThinking = await js(win, `(() => {
    const status = document.querySelector('.ae-reply-thinking');
    return status?.textContent === 'Думаю…' &&
      status.getAnimations({ subtree: true }).length === 0 &&
      getComputedStyle(status.firstElementChild).backgroundImage === 'none';
  })()`);
  await setReducedMotion('no-preference');
  const staticWithAnimationsOff = await js(win, `(() => {
    const root = document.documentElement;
    const previous = root.dataset.animations;
    root.dataset.animations = 'off';
    const status = document.querySelector('.ae-reply-thinking');
    const still = status?.textContent === 'Думаю…' && status.getAnimations({ subtree: true }).length === 0;
    root.dataset.animations = previous;
    return still;
  })()`);
  await setReducedMotion('');
  await js(win, 'Object.assign(document.documentElement.dataset, window.__qaReplyLook)');
  const replyStreaming = await waitUntil(() => js(win, `(() => {
    const live = document.querySelector('#feed .is-live');
    return live?.querySelector('.ae-reply-author')?.textContent === 'Nox' &&
      !live.querySelector('.ae-reply-thinking') && live.querySelector('.ae-msg-copy:not(:disabled)') &&
      live.querySelector('.ae-assistant-body strong')?.textContent === 'Сначала вывод.' &&
      live.querySelector('.ae-reply-author') === window.__qaReplyAuthor &&
      live.querySelector('.ae-reply-content') === window.__qaReplyContent &&
      live.previousElementSibling === window.__qaReplyUser;
  })()`), 6000, 50);
  if (replyStreaming) shots.push(await shot(win, '02c-reply-streaming.png'));
  await waitIdle(win);
  const replyFinished = await js(win, `(() => {
    const last = [...document.querySelectorAll('#feed .is-assistant')].at(-1);
    return !document.querySelector('#feed .ae-reply-thinking') &&
      last?.querySelector('.ae-reply-author')?.textContent === 'Nox' &&
      last.querySelector('.ae-reply-author') === window.__qaReplyAuthor &&
      last.querySelector('.ae-reply-content') === window.__qaReplyContent &&
      last.querySelector('.ae-assistant-body')?.textContent.includes('Затем короткое пояснение.') &&
      last.querySelectorAll('.math-block .m-frac').length === 3 &&
      last.querySelector('strong .math')?.textContent === '0,85' &&
      last.querySelector('.md-footnote em')?.textContent === 'курсивом' &&
      last.querySelector('.ae-msg-copy')?.previousElementSibling === window.__qaReplyContent &&
      getComputedStyle(last.querySelector('.m-den')).borderTopWidth === '1px';
  })()`);
  push('reply-preparation-stream-and-finish',
    replyPreparing && thinkingMotion.confirmed && changedLetterPixels >= 15 && staticThinking && staticWithAnimationsOff && replyStreaming && replyFinished,
    { replyPreparing, thinkingMotion, changedLetterPixels, staticThinking, staticWithAnimationsOff, replyStreaming, replyFinished });
  if (replyFinished) {
    const rect = await js(win, `(() => {
      const box = [...document.querySelectorAll('#feed .ae-reply')].at(-1).getBoundingClientRect();
      return { x: Math.floor(box.x), y: Math.floor(box.y) - 8, width: 400, height: Math.ceil(box.height) + 16 };
    })()`);
    shots.push(await shot(win, '02d-final-reply-close.png', rect));
  }

  await sendText(win, 'Который час?');
  await waitIdle(win);
  const clockText = await js(win, `[...document.querySelectorAll('#feed .ae-assistant-body')].at(-1)?.textContent.trim()`);
  push('local-clock-answers-without-model', /^\d{2}:\d{2}$/.test(clockText) && qaClockRequests === 0, { clockText, qaClockRequests });

  // Черновики между чатами и немедленный docked на существующем чате
  await js(win, `(() => {
    const ta = document.querySelector('#chatInput');
    ta.value = 'Неотправленный черновик 42';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await js(win, `window.__noxAether.store.selectChat('qa-plans')`);
  await settle(win, 180);
  const switchedPlans = await js(win, `(() => ({
    dockedImmediate: document.querySelector('#noxChat').classList.contains('is-docked'),
    inputAfterSwitch: document.querySelector('#chatInput').value,
    plansMsg: document.querySelector('#feed')?.innerText.includes('план на неделю'),
  }))()`);
  await js(win, `window.__noxAether.store.selectChat('qa-empty')`);
  await settle(win, 180);
  const restoredDraft = await js(win, `document.querySelector('#chatInput').value`);
  push('chat-switch-immediate-dock-and-drafts', switchedPlans.dockedImmediate && switchedPlans.inputAfterSwitch === '' && switchedPlans.plansMsg && restoredDraft === 'Неотправленный черновик 42', { switchedPlans, restoredDraft });

  // Очистим черновик перед длинным ответом
  await js(win, `(() => { const ta = document.querySelector('#chatInput'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  // ── 4. Длинный ответ + прокрутка + кнопка #toBottom ──
  await sendText(win, 'Покажи длинный ответ со списком, таблицей, кодом и математикой');
  await waitIdle(win, 20000);
  await settle(win, 200);
  const longStats = await js(win, `(() => {
    const feed = document.querySelector('#feed');
    const details = feed.querySelector('.ae-long-reply details');
    const folded = details && !details.open && details.querySelector('summary').innerText === 'Показать полностью';
    details?.querySelector('summary').click();
    const expanded = details?.open;
    const hasTable = Boolean(feed.querySelector('table'));
    const hasCode = Boolean(feed.querySelector('pre code'));
    const hasMath = Boolean(feed.querySelector('.math'));
    feed.scrollTop = 0;
    feed.dispatchEvent(new Event('scroll'));
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const btn = document.querySelector('#toBottom');
      const shownOnScrollUp = !btn.hidden;
      btn.click();
      setTimeout(() => {
        const gapAfter = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
        r({ folded, expanded, hasTable, hasCode, hasMath, shownOnScrollUp, gapAfter });
      }, 280);
    })));
  })()`);
  push('long-markdown-math-and-scroll', longStats.folded && longStats.expanded &&
    longStats.hasTable && longStats.hasCode && longStats.hasMath && longStats.shownOnScrollUp && longStats.gapAfter < 60, longStats);
  shots.push(await shot(win, '03-long-reply-1200x720.png'));

  // ── 5. Работа инструментов (не >1 строки живого статуса) + свёрнутые/раскрытые Подробности ──
  await setReducedMotion('no-preference');
  await sendText(win, 'Проверь файлы папки');
  const liveSeen = await waitUntil(() => js(win, `(() => {
    const live = document.querySelector('#feed .is-live');
    const text = live?.querySelector('.ae-step-line[data-state="running"] .ae-step-label[role="status"]')?.textContent.trim();
    if (!text) return null;
    return {
      count: live.querySelectorAll('.ae-step-line').length,
      text,
      noDuplicateStatus: !live.querySelector('.ae-reply-thinking') && document.querySelector('#aeApprovalDock').hidden,
      stopReady: Boolean(live.querySelector('.ae-live-stop:not(:disabled)')),
    };
  })()`).catch(() => null), 8000, 50);
  if (liveSeen) shots.push(await shot(win, '04-tool-live-1200x720.png'));
  await waitIdle(win, 18000);
  await setReducedMotion('');
  await settle(win, 180);
  const detailsCheck = await js(win, `(() => {
    const btns = [...document.querySelectorAll('#feed .ae-details-toggle')];
    const lastBtn = btns[btns.length - 1];
    if (!lastBtn) return { found: false };
    const msg = lastBtn.closest('.ae-msg.is-assistant');
    const msgId = msg ? msg.dataset.id : '';
    const collapsedBefore = lastBtn.getAttribute('aria-expanded') === 'false';
    const finalStatus = lastBtn.querySelector('.ae-step-label')?.textContent;
    const beforeReply = lastBtn.closest('.ae-details-wrap') === msg.firstElementChild;
    const finishedReply = Boolean(msg.querySelector('.ae-assistant-body')) && !msg.querySelector('.ae-reply-thinking');
    lastBtn.focus();
    lastBtn.click();
    const afterMsg = msgId
      ? [...document.querySelectorAll('#feed .ae-msg.is-assistant')].find((m) => m.dataset.id === msgId)
      : [...document.querySelectorAll('#feed .ae-msg.is-assistant')].pop();
    const afterBtn = afterMsg ? afterMsg.querySelector('.ae-details-toggle') : null;
    const expandedAfter = Boolean(afterBtn && afterBtn.getAttribute('aria-expanded') === 'true');
    const focusPreserved = Boolean(afterBtn && document.activeElement === afterBtn);
    const drawer = afterMsg ? afterMsg.querySelector('.ae-details-panel') : null;
    return { found: true, collapsedBefore, expandedAfter, focusPreserved, finalStatus, beforeReply, finishedReply, drawerText: drawer ? drawer.innerText.trim().slice(0, 120) : '' };
  })()`);
  push('tool-work-minimal-noise-and-details', Boolean(liveSeen && liveSeen.count === 1 && liveSeen.noDuplicateStatus && liveSeen.stopReady &&
    detailsCheck.finishedReply && detailsCheck.found && detailsCheck.beforeReply && detailsCheck.finalStatus === 'Готово' &&
    detailsCheck.collapsedBefore && detailsCheck.expandedAfter && detailsCheck.focusPreserved), { liveSeen, detailsCheck });
  shots.push(await shot(win, '04b-tool-details-open-1200x720.png'));

  // ── 6. Ожидание подтверждения R3-01 (ask + workspace_write) на 1200x720 и 864x520 ──
  await sendText(win, 'Запиши заметку qa-check');
  const approvalInit = await waitUntil(() => js(win, `(() => {
    const dock = document.querySelector('#aeApprovalDock');
    if (!dock || dock.hidden) return null;
    const once = dock.querySelector('[data-decision="once"]');
    const rej = dock.querySelector('[data-decision="reject"]');
    const cd = dock.querySelector('.ae-approval-countdown');
    const prev = dock.querySelector('.ae-approval-preview');
    return once ? {
      onceDisabledEarly: once.disabled,
      rejectEnabledEarly: rej && !rej.disabled,
      countdown: cd ? cd.textContent.trim() : '',
      preview: prev ? prev.textContent.trim() : '',
      agentWaiting: Boolean(document.querySelector('#feed .is-live .ae-step-line[data-state="waiting"]')),
    } : null;
  })()`).catch(() => null), 10000, 35);
  shots.push(await shot(win, '05-approval-1200x720.png'));

  await setViewport(win, 864, 520);
  shots.push(await shot(win, '05-approval-864x520.png'));
  await setViewport(win, 1200, 720);

  // Через >= 750 мс кнопка «Разрешить один раз» должна активироваться
  const approvalArmed = await waitUntil(() => js(win, `(() => {
    const once = document.querySelector('#aeApprovalDock [data-decision="once"]');
    return once && !once.disabled;
  })()`).catch(() => false), 3000, 50);

  await js(win, `document.querySelector('#aeApprovalDock [data-decision="once"]')?.click()`);
  await waitIdle(win, 15000);
  await settle(win, 180);
  const fileWritten = fs.existsSync(path.join(workspaceDir, 'qa-check.txt'));
  push('approval-r301-and-file-write', Boolean(approvalInit && approvalInit.agentWaiting && approvalInit.onceDisabledEarly && approvalInit.rejectEnabledEarly && approvalArmed && fileWritten), { approvalInit, approvalArmed, fileWritten });

  await sendText(win, 'Запиши заметку qa-stop');
  const stopReady = await waitUntil(() => js(win, `Boolean(document.querySelector('.ae-step-line[data-state="waiting"] .ae-live-stop:not(:disabled)') && !document.querySelector('#aeApprovalDock').hidden)`), 10000, 50);
  if (stopReady) {
    await js(win, `document.querySelector('.ae-live-stop').click()`);
    await waitIdle(win, 10000);
  }
  const stopPanelClosed = await js(win, `!document.querySelector('.ae-live-stop') && document.querySelector('#aeApprovalDock').hidden`);
  const stoppedFileAbsent = !fs.existsSync(path.join(workspaceDir, 'qa-stop.txt'));
  const stoppedReply = await js(win, `document.querySelector('#feed .ae-reply-stopped')?.textContent === 'Остановлено.'`);
  push('agent-panel-stop-cancels-approval', stopReady && stopPanelClosed && stoppedFileAbsent && stoppedReply,
    { stopReady, stopPanelClosed, stoppedFileAbsent, stoppedReply });

  // ── 7. Ошибка модели и восстановление кнопкой «Повторить» ──
  await sendText(win, 'Вызови ошибку модели');
  await waitIdle(win, 15000);
  await settle(win, 160);
  const errCard = await js(win, `(() => {
    const cards = [...document.querySelectorAll('#feed .ae-error-card')];
    const last = cards[cards.length - 1];
    if (!last) return { found: false };
    const retry = last.querySelector('.ae-retry-btn, button');
    const readable = last.querySelector('.ae-error-text')?.textContent.startsWith('Не удалось');
    const hasStripe = getComputedStyle(last).borderInlineStartWidth === '3px';
    return { found: true, hasRetry: Boolean(retry), readable, hasStripe };
  })()`);
  shots.push(await shot(win, '06-error-1200x720.png'));
  await js(win, `(() => {
    const cards = [...document.querySelectorAll('#feed .ae-error-card')];
    const last = cards[cards.length - 1];
    last?.querySelector('button')?.click();
  })()`);
  await waitIdle(win, 15000);
  await settle(win, 180);
  const recovered = await js(win, `document.querySelector('#feed')?.innerText.includes('восстановила ответ')`);
  push('error-and-retry-recovery', errCard.found && errCard.hasRetry && errCard.readable && errCard.hasStripe && recovered, { errCard, recovered });

  // ── 8. Голосовой ввод (имитация IPC событий диктовки на настоящем окне) ──
  await js(win, `window.__noxAether.store.setSetting('dictation', true)`);
  win.webContents.send('dictation:event', { type: 'mode', mode: 'listening', recording: true });
  win.webContents.send('dictation:event', { type: 'state', state: 'listening', recording: true });
  win.webContents.send('dictation:event', { type: 'level', level: 0.72 });
  await settle(win, 180);
  const dictCheck = await js(win, `(() => {
    const btn = document.querySelector('#dictationBtn');
    const chip = document.querySelector('#dictationStateBtn');
    return {
      btnVisible: Boolean(btn && !btn.hidden),
      btnRecording: Boolean(btn && btn.classList.contains('is-recording')),
      chipVisible: Boolean(chip && !chip.hidden),
      stageState: document.querySelector('#aeOrbStage .ae-orb-status')?.dataset.state,
    };
  })()`);
  shots.push(await shot(win, '07-dictation-1200x720.png'));
  win.webContents.send('dictation:event', { type: 'state', state: 'stopped', recording: false });
  await js(win, `window.__noxAether.store.setSetting('dictation', false)`);

  // ── 9. Мастерская Nox и Библиотека сфер (оба движка, настройки, слайдер без пересоздания DOM, сброс) ──
  await js(win, `document.querySelector('#aeNav_settings').click()`);
  await settle(win, 220);
  const workshopInfo = await js(win, `(() => {
    const cards = [...document.querySelectorAll('#aeSettingsView .ae-orb-choice')].map((el) => el.id);
    const hasBothSystems = ['aeOrbCard_nox_nox', 'aeOrbCard_nox_wire', 'aeOrbCard_nox_shutter', 'aeOrbCard_jarvis_core', 'aeOrbCard_jarvis_sphere', 'aeOrbCard_jarvis_iris'].every((id) => cards.includes(id));
    return { cards, hasBothSystems };
  })()`);
  shots.push(await shot(win, '08-workshop-1200x720.png'));

  // Переключимся на Jarvis Ядро и проверим, что слайдер не пересоздаёт сам себя при drag и параметры сфер независимы
  await js(win, `document.querySelector('#aeOrbCard_jarvis_core').click()`);
  await settle(win, 180);
  const sliderPreserve = await js(win, `(() => {
    const range = document.querySelector('#aeSettingsView .ae-orb-controls-col input[type="range"]');
    if (!range) return { found: false };
    window.__qaSliderRef = range;
    range.value = String(Number(range.max || 1));
    range.dispatchEvent(new Event('input', { bubbles: true }));
    const sameDom = window.__qaSliderRef === document.querySelector('#aeSettingsView .ae-orb-controls-col input[type="range"]');
    const coreScale = window.NoxOrbLibrary.getSettings('jarvis:core');
    return { found: true, sameDom, active: window.NoxOrbLibrary.getSnapshot().activeId, coreScale };
  })()`);
  // Проверка пресета и сброса для активной сферы + шрифта подписи The Nox
  const presetAndFont = await js(win, `(() => {
    const presets = [...document.querySelectorAll('#aeSettingsView .ae-preset-row .ae-subtab')];
    const nonDefaultBtn = presets[presets.length - 1] || presets[0];
    if (nonDefaultBtn) nonDefaultBtn.click();
    const afterPreset = window.NoxOrbLibrary.getSettings('jarvis:core');
    const resetBtn = [...document.querySelectorAll('#aeSettingsView button')].find((b) => /Сбросить эту сферу/i.test(b.textContent));
    if (resetBtn) resetBtn.click();
    const afterReset = window.NoxOrbLibrary.getSettings('jarvis:core');
    if (nonDefaultBtn) nonDefaultBtn.click();
    document.querySelector('#aeSettingsView [data-section="window"]').click();
    const sel = [...document.querySelectorAll('#aeSettingsView select')].find((s) => [...s.options].some((o) => o.value === 'times'));
    if (sel) {
      sel.value = 'times';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return {
      presetCount: presets.length,
      presetIdAfterClick: afterPreset.presetId,
      presetIdAfterReset: afterReset.presetId,
      fontSelected: sel ? sel.value : '',
    };
  })()`);
  await settle(win, 140);
  const settingsSearch = await js(win, `(() => {
    const settings = document.querySelector('#aeSettingsView');
    const input = settings.querySelector('input[type="search"]');
    input.focus();
    const search = (value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    search('громкость');
    const foundVoice = settings.innerText.includes('Громкость речи') && document.activeElement === input;
    search('несуществующий параметр');
    const noResults = settings.innerText.includes('Настройки не найдены');
    settings.querySelector('[data-section="window"]').click();
    const sameCategoryClearsSearch = !input.value && settings.innerText.includes('Шрифт подписи');
    settings.querySelector('[data-section="appearance"]').click();
    const searchOnLeft = input.closest('.ae-settings-nav') === settings.querySelector('.ae-settings-nav') &&
      input.getBoundingClientRect().top < settings.querySelector('[data-section="workshop"]').getBoundingClientRect().top;
    return { foundVoice, noResults, sameCategoryClearsSearch, searchOnLeft, appearanceVisible: !!settings.querySelector('#aeThemeSelect') };
  })()`);
  push('settings-cross-category-search', Object.values(settingsSearch).every(Boolean), settingsSearch);
  shots.push(await shot(win, '08b-appearance-1200x720.png'));
  const appearanceChecks = await js(win, `(async () => {
    const root = document.documentElement;
    const theme = window.JarvisTheme;
    const saved = localStorage.getItem('jarvis.theme') || root.dataset.theme;
    const card = document.querySelector('[data-theme-id="porcelain"]');
    card.click();
    const lightPalette = root.dataset.theme === 'porcelain' && card.getAttribute('aria-pressed') === 'true' &&
      getComputedStyle(root).colorScheme === 'light';
    const hex = document.querySelector('#aeAccentHex');
    const submit = (value) => { hex.value = value; hex.form.requestSubmit(); };
    submit('oops');
    const rejectedHex = hex.getAttribute('aria-invalid') === 'true';
    submit('#295443');
    const appliedHex = theme.getAccent() === '#295443';
    const choose = (key, value) => {
      const select = document.querySelector('#aeSettingsView [data-look="' + key + '"]');
      select.value = value;
      select.dispatchEvent(new Event('change'));
    };
    choose('ui', 'plex');
    choose('reply', 'ui');
    const typeApplied = theme.getLook().ui === 'plex' &&
      getComputedStyle(document.querySelector('.ae-type-sample span')).fontFamily.includes('IBM Plex Serif');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const fileInput = document.querySelector('#aeSettingsView input[type="file"]');
    const files = new DataTransfer();
    files.items.add(new File([blob], 'qa-background.png', { type: 'image/png' }));
    fileInput.files = files.files;
    fileInput.dispatchEvent(new Event('change'));
    return { saved, lightPalette, rejectedHex, appliedHex, typeApplied };
  })()`);
  const { saved, ...appearanceResults } = appearanceChecks;
  push('appearance-gallery-hex-and-reply-font', Object.values(appearanceResults).every(Boolean), appearanceResults);
  const backgroundApplied = await waitUntil(() => js(win, `!!document.querySelector('#aeSettingsView [data-look="bgDim"]') && document.documentElement.dataset.bg === 'image'`), 3000);
  const backgroundControls = backgroundApplied && await js(win, `(() => {
    const blur = document.querySelector('#aeSettingsView [data-look="bgBlur"]');
    blur.value = '16';
    blur.dispatchEvent(new Event('change'));
    return document.documentElement.style.getPropertyValue('--own-bg-blur') === '16px';
  })()`);
  await js(win, `(async () => {
    await window.NoxBackdrop.clear();
    window.JarvisTheme.setLook({ bg: 'theme' });
    document.querySelector('#aeSettingsView [data-section="appearance"]').click();
  })()`);
  push('appearance-custom-background-controls', backgroundApplied && backgroundControls, { backgroundApplied, backgroundControls });
  await settle(win, 120);
  shots.push(await shot(win, '08c-porcelain-1200x720.png'));
  const picker = await js(win, `(() => {
    const select = document.querySelector('#aeThemeSelect');
    select.focus();
    select.showPicker();
    const style = getComputedStyle(select, '::picker(select)');
    return {
      open: select.matches(':open'),
      styled: style.appearance === 'base-select' && style.borderRadius === '9px',
      themeColor: style.backgroundColor === 'rgb(251, 250, 246)',
    };
  })()`);
  if (picker.open) shots.push(await shot(win, '08e-themed-select-1200x720.png'));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  const pickerDismissed = await waitUntil(() => js(win, `!document.querySelector('#aeThemeSelect').matches(':open')`), 2000);
  push('themed-select-opens-and-dismisses-with-escape', Object.values(picker).every(Boolean) && pickerDismissed, { picker, pickerDismissed });
  await setViewport(win, 864, 520);
  const appearsWithoutOverflow = await js(win, `(() => {
    const el = document.querySelector('#aeSettingsView');
    return el.scrollWidth <= el.clientWidth + 1;
  })()`);
  push('appearance-narrow-no-horizontal-overflow', appearsWithoutOverflow);
  shots.push(await shot(win, '08d-porcelain-864x520.png'));
  await setViewport(win, 1200, 720);
  await js(win, `(() => {
    window.JarvisTheme.resetToTheme();
    const select = document.querySelector('#aeThemeSelect');
    select.value = ${JSON.stringify(saved)};
    select.dispatchEvent(new Event('change'));
  })()`);
  // Возврат в Чат с активной сферой Jarvis Ядро -> проверить сцену и шрифт подписи
  await js(win, `document.querySelector('#aeNav_chat').click()`);
  await settle(win, 220);
  const jarvisActiveOnChat = await js(win, `({
    orbId: document.querySelector('#aeOrbStage')?.dataset.orbId,
    sigFont: getComputedStyle(document.querySelector('.ae-orb-signature')).fontFamily,
  })`);
  shots.push(await shot(win, '09-orb-jarvis-core-1200x720.png'));

  // Возврат на Nox Classic ('nox:nox') + проверка сохранения настроек jarvis:core + уменьшения анимаций
  await js(win, `window.NoxOrbLibrary.setActive('nox:nox')`);
  await settle(win, 180);
  await js(win, `window.__noxAether.store.setSetting('motion', false)`);
  await settle(win, 100);
  const reducedOff = await js(win, `document.documentElement.dataset.animations`);
  await js(win, `window.__noxAether.store.setSetting('motion', true)`);
  await settle(win, 100);
  const bothPreserved = await js(win, `({
    nowActive: window.NoxOrbLibrary.getSnapshot().activeId,
    noxStageId: document.querySelector('#aeOrbStage')?.dataset.orbId,
    jarvisCoreStillCustom: window.NoxOrbLibrary.getSettings('jarvis:core'),
  })`);
  push('orb-library-both-systems-and-slider-stability', Boolean(
    workshopInfo.hasBothSystems
    && sliderPreserve.sameDom
    && presetAndFont.presetCount >= 2
    && Boolean(presetAndFont.presetIdAfterClick)
    && presetAndFont.presetIdAfterClick !== 'default'
    && presetAndFont.presetIdAfterReset === 'default'
    && bothPreserved.jarvisCoreStillCustom.presetId === presetAndFont.presetIdAfterClick
    && /Times/i.test(jarvisActiveOnChat.sigFont)
    && jarvisActiveOnChat.orbId === 'jarvis:core'
    && bothPreserved.noxStageId === 'nox:nox'
    && reducedOff === 'off'
    && dictCheck.btnVisible
    && dictCheck.btnRecording
    && dictCheck.chipVisible
    && dictCheck.stageState === 'listening'
  ), { workshopInfo, sliderPreserve, presetAndFont, jarvisActiveOnChat, bothPreserved, reducedOff, dictCheck });

  // ── 10. Остальные разделы: Готовые команды, MCP-подключения, Личное пространство (1200x720) ──
  await js(win, `document.querySelector('#aeNav_commands').click()`);
  await settle(win, 220);
  shots.push(await shot(win, '10-commands-1200x720.png'));

  await js(win, `document.querySelector('#aeNav_mcp').click()`);
  await settle(win, 220);
  shots.push(await shot(win, '11-mcp-1200x720.png'));
  const featuredServices = await js(win, `[...document.querySelectorAll('#aeMcpView [data-service]')].map((el) => el.dataset.service)`);
  push('connections-feature-external-services', featuredServices.slice(0, 4).join(',') === 'github,gmail,linear,notion' &&
    !featuredServices.some((id) => ['filesystem', 'desktop-commander', 'time', 'evidence-check'].includes(id)), featuredServices);
  const connectionSearch = await js(win, `(() => {
    const input = document.querySelector('#aeMcpView input[type="search"]');
    if (!input) return false;
    input.focus();
    input.value = 'test search';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const keepsFocus = document.activeElement === input && input.value === 'test search';
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return keepsFocus;
  })()`);
  push('connections-search-keeps-focus', connectionSearch);

  await js(win, `document.querySelector('#aeNav_personal').click()`);
  const personalLoaded = await waitUntil(() => js(win, `(() => {
    const body = document.querySelector('#aePersonalView .ae-personal-body');
    if (!body || body.dataset.loading === '1') return null;
    return body.innerText.trim().length > 0 ? { len: body.innerText.trim().length, text: body.innerText.trim().slice(0, 140) } : null;
  })()`).catch(() => null), 8000, 50);
  await settle(win, 120);
  push('personal-space-desks-loaded', Boolean(personalLoaded && personalLoaded.len > 0), { personalLoaded });
  shots.push(await shot(win, '12-personal-1200x720.png'));

  // ── 11. Узкое окно 864x520: быстрые настройки, наложенная история, Мастерская ──
  await setViewport(win, 864, 520);
  await js(win, `document.querySelector('#aeNav_chat').click()`);
  await settle(win, 180);
  const narrowMenuOpen = await js(win, `(() => {
    const trig = document.querySelector('[aria-controls="aeQuickSettings"]');
    trig.click();
    const menu = document.querySelector('#aeQuickSettings');
    const r = menu.getBoundingClientRect();
    return { open: !menu.hidden, fits: r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      fields: menu.querySelectorAll('label').length };
  })()`);
  shots.push(await shot(win, '13-narrow-nav-864x520.png'));
  await js(win, `document.querySelector('[aria-controls="aeQuickSettings"]')?.click()`);

  // Наложенная панель истории на 864x520
  const historyFromSettings = await js(win, `(() => {
    const { store } = window.__noxAether;
    store.toggleHistory(true);
    store.setRoute('settings');
    const trigger = document.querySelector('#aeHistoryToggle');
    const collapsedOutsideChat = trigger.getAttribute('aria-expanded') === 'false';
    trigger.click();
    return collapsedOutsideChat && store.state.route === 'chat'
      && trigger.getAttribute('aria-expanded') === 'true'
      && document.querySelector('#aeHistoryWrap').classList.contains('is-open');
  })()`);
  await settle(win, 180);
  shots.push(await shot(win, '14-narrow-history-864x520.png'));
  const historyKeyboard = await js(win, `(() => {
    const trigger = document.querySelector('#aeHistoryToggle');
    const drawer = document.querySelector('#aeHistoryWrap');
    document.querySelector('#aeNewChatBtn').focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const closed = drawer.inert && document.activeElement === trigger;
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    const reopened = !drawer.inert && trigger.getAttribute('aria-expanded') === 'true';
    trigger.click();
    return closed && reopened && drawer.inert;
  })()`);
  push('history-from-settings-and-keyboard', historyFromSettings && historyKeyboard, { historyFromSettings, historyKeyboard });

  await js(win, `document.querySelector('#aeNav_settings').click()`);
  await js(win, `document.querySelector('#aeSettingsView [data-section="workshop"]').click()`);
  await settle(win, 200);
  const narrowSettingsOverflow = await js(win, `document.documentElement.scrollWidth > window.innerWidth + 1`);
  shots.push(await shot(win, '15-narrow-workshop-864x520.png'));
  push('narrow-864-nav-history-workshop', narrowMenuOpen.open && narrowMenuOpen.fits
    && narrowMenuOpen.fields === 6 && !narrowSettingsOverflow, { narrowMenuOpen, narrowSettingsOverflow, dictCheck });

  // Проверка разрешения для первого поручения в новом чате.
  await js(win, `window.__noxAether.store.createNewChat()`);
  await sendText(win, 'Открой Блокнот');
  const firstApproval = await waitUntil(() => js(win, `(() => {
    const dock = document.querySelector('#aeApprovalDock');
    const reject = dock.querySelector('[data-decision="reject"]');
    if (dock.hidden || !reject || !/notepad/i.test(dock.innerText)) return false;
    reject.click();
    return true;
  })()`), 6000, 60);
  await waitIdle(win, 10000);
  const firstRefused = await js(win, `Boolean(document.querySelector('.ae-action-outcome[data-status="refused"]'))`);
  push('first-command-uses-real-approval', firstApproval && firstRefused, { firstApproval, firstRefused });
  shots.push(await shot(win, '16-first-command-refused-864x520.png'));

  // Два реальных вызова ядра через чат. Запуск Office подменён только на границе Electron.
  await js(win, `window.NoxOrbLibrary.setActive('nox:wire')`);
  await js(win, `window.__noxAether.store.createNewChat()`);
  await sendText(win, 'Что такое Стрелец A*?');
  await waitIdle(win, 12000);
  await sendText(win, 'Создай презентацию об этом и открой её');
  for (const tool of ['document_write', 'presentation_open']) {
    const allowed = await waitUntil(() => js(win, `(() => {
      const store = window.__noxAether.store;
      const active = store.state.approvals.queue.find((item) => item.id === store.state.approvals.view?.id);
      const button = document.querySelector('#aeApprovalDock [data-decision="once"]');
      if ((active?.name || active?.tool) !== ${JSON.stringify(tool)} || !button || button.disabled) return false;
      button.click();
      return true;
    })()`), 9000, 60);
    if (!allowed) throw new Error(`Нет запроса разрешения для ${tool}`);
  }
  await waitIdle(win, 14000);
  const deckPath = path.join(workspaceDir, 'qa-astronomy.pptx');
  const deckOk = fs.existsSync(deckPath) && require('../src/tools/pptx').pptxCheck(fs.readFileSync(deckPath), 2).ok;
  const openingStatus = await js(win, `document.querySelector('.ae-action-outcome[data-status="unverified"]')?.innerText || ''`);
  push('context-pptx-create-and-open', deckOk && openedPresentations.length === 1 && /Открытие презентации не подтверждено/.test(openingStatus),
    { deckOk, openCalls: openedPresentations.length, openingStatus });
  shots.push(await shot(win, '17-presentation-864x520.png'));

  // Отдельные панели аккаунта и лимитов для локальной сборки и ответа сервера.
  const localAccount = await js(win, `(() => {
    const trigger = document.querySelector('#aeAccountTrigger');
    trigger.click();
    const rect = trigger.getBoundingClientRect();
    return rect.left < 48 && rect.bottom > window.innerHeight - 24
      && document.querySelector('#aeAccountPanel').innerText.includes('Локальный режим');
  })()`);
  const localLimits = await js(win, `(() => {
    const history = document.querySelector('#aeHistoryToggle').getBoundingClientRect();
    const account = document.querySelector('#aeAccountTrigger').getBoundingClientRect();
    const trigger = document.querySelector('#aeLimitsTrigger');
    const rect = trigger.getBoundingClientRect();
    trigger.click();
    const panel = document.querySelector('#aeLimitsPanel');
    return rect.top >= history.bottom && rect.bottom <= account.top
      && document.querySelector('#aeAccountPanel').hidden && !panel.hidden
      && panel.innerText.includes('при подключении к серверу Nox')
      && !trigger.querySelector('.has-data');
  })()`);
  await js(win, `(() => {
    const bridge = window.NoxAetherBridge;
    const call = bridge.call;
    bridge.call = (name, ...args) => {
      if (name !== 'accountState') return call(name, ...args);
      const now = Date.now();
      return Promise.resolve({ enabled: true, signedIn: true, account: {
        email: 'alex@example.test', planTitle: 'Pro', limits: {
          day: { percent: 37, resetAt: now + 3600000 },
          week: { percent: 64, resetAt: now + 86400000 },
          session: { percent: 18, resetAt: now + 1800000 },
        },
      } });
    };
    return window.__noxAether.store.refreshAccount();
  })()`);
  const accountLimits = await waitUntil(() => js(win, `(() => {
    const panel = document.querySelector('#aeLimitsPanel');
    const trigger = document.querySelector('#aeLimitsTrigger');
    const r = panel.getBoundingClientRect();
    const values = [...panel.querySelectorAll('progress')].map((p) => p.value);
    return !panel.hidden && r.left >= 48 && r.top >= 44 && r.right <= window.innerWidth
      && r.bottom <= window.innerHeight && values.join(',') === '37,64,18'
      && panel.innerText.includes('Дневной лимит') && panel.innerText.includes('Недельный лимит')
      && panel.innerText.includes('Лимит на 5 часов') && panel.innerText.includes('Обновится')
      && trigger.querySelector('.has-data')?.style.getPropertyValue('--used') === '64%'
      && trigger.title.includes('Недельный лимит');
  })()`), 2500);
  shots.push(await shot(win, '18-limits-864x520.png'));
  const limitsClose = await js(win, `(() => {
    const panel = document.querySelector('#aeLimitsPanel');
    panel.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return panel.hidden && document.activeElement.id === 'aeLimitsTrigger';
  })()`);
  const profileSeparate = await js(win, `(() => {
    document.querySelector('#aeAccountTrigger').click();
    const profile = document.querySelector('#aeAccountPanel');
    return !profile.hidden && profile.innerText.includes('alex@example.test')
      && !profile.querySelector('progress') && document.querySelector('#aeLimitsPanel').hidden;
  })()`);
  shots.push(await shot(win, '19-account-864x520.png'));
  const signedOutLimits = await js(win, `(async () => {
    const { store } = window.__noxAether;
    const bridge = window.NoxAetherBridge;
    const call = bridge.call;
    bridge.call = (name, ...args) => name === 'accountState'
      ? Promise.resolve({ enabled: true, signedIn: false }) : call(name, ...args);
    await store.refreshAccount();
    document.querySelector('#aeLimitsTrigger').click();
    const panel = document.querySelector('#aeLimitsPanel');
    const enter = panel.querySelector('.ae-account-body button');
    if (!enter || !enter.textContent.includes('Войти')) return false;
    enter.click();
    return panel.hidden && !document.querySelector('#aeAccountPanel').hidden
      && Boolean(document.querySelector('#aeAccountPanel input[type="email"]'))
      && !document.querySelector('#aeLimitsTrigger .has-data');
  })()`);
  push('limits-own-button-dialog-progress-and-escape', localAccount && localLimits && accountLimits
    && limitsClose && profileSeparate && signedOutLimits,
    { localAccount, localLimits, accountLimits, limitsClose, profileSeparate, signedOutLimits });

  // ── Источники поиска, история и нативное всплывающее окно ──
  await js(win, 'window.__noxAether.store.createNewChat()');
  const counts = [];
  for (const count of [0, 1, 5, 20]) {
    await sendText(win, `Проверка ссылок ${count}`);
    await waitIdle(win);
    counts.push(await js(win, `(() => {
      const last = [...document.querySelectorAll('#feed .is-assistant')].at(-1);
      return {
        label: last?.querySelector('.ae-sources-trigger')?.textContent || '',
        count: last?.querySelectorAll('.ae-source-link').length,
        textLinkExcluded: !last?.querySelector('.ae-source-link[href*="model-only"]'),
      };
    })()`));
  }
  const sourceChat = await js(win, 'window.__noxAether.store.state.activeChatId');
  await setViewport(win, 864, 520);
  const openLastSources = () => js(win, `(() => {
    const trigger = [...document.querySelectorAll('.ae-sources-trigger')].at(-1);
    if (!trigger) return;
    trigger.scrollIntoView({ block: 'nearest' });
    trigger.click();
  })()`);
  await openLastSources();
  await waitUntil(() => js(win, `(() => {
    const panel = document.querySelector('.ae-sources-popover:popover-open');
    return panel?.querySelectorAll('.is-loaded').length >= 2 &&
      panel.querySelector('.ae-source-favicon:not(:has(img)) svg');
  })()`), 4500, 50);
  const readPopover = () => js(win, `(() => {
    const panel = document.querySelector('.ae-sources-popover:popover-open');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const trigger = panel.previousElementSibling.getBoundingClientRect();
    const title = panel.querySelector('.ae-source-title');
    const feed = panel.closest('.ae-feed').getBoundingClientRect();
    return {
      width: rect.width, height: rect.height,
      side: panel.dataset.side,
      rowHeight: panel.querySelector('.ae-source-link').getBoundingClientRect().height,
      fits: rect.x >= 0 && rect.y >= feed.top - 1 && rect.right <= innerWidth && rect.bottom <= feed.bottom + 1,
      anchored: Math.abs(rect.x - trigger.x) <= 1 &&
        Math.abs(panel.dataset.side === 'below' ? rect.top - trigger.bottom : trigger.top - rect.bottom) <= 10,
      scroll: panel.scrollHeight > panel.clientHeight,
      clippedTitle: title.scrollWidth > title.clientWidth,
      icon: [...panel.querySelectorAll('.is-loaded')].some((image) => image.naturalWidth >= 16),
      fallback: Boolean(panel.querySelector('.ae-source-favicon:not(:has(img)) svg')),
    };
  })()`);
  const popover = await readPopover();
  if (popover?.fits) shots.push(await shot(win, '20-sources-864x520.png'));
  const dismissPoint = await js(win, `(() => {
    const rect = document.querySelector('.ae-sources-popover:popover-open')?.getBoundingClientRect();
    return rect ? { x: Math.floor(rect.right + 12), y: Math.floor(rect.top + 20) } : null;
  })()`);
  if (dismissPoint) {
    const cdp = win.webContents.debugger;
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...dismissPoint, button: 'left', clickCount: 1 });
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...dismissPoint, button: 'left', clickCount: 1 });
  }
  const lightDismissed = await js(win, '!document.querySelector(".ae-sources-popover:popover-open")');
  await openLastSources();
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const escapeDismissed = await js(win, '!document.querySelector(".ae-sources-popover:popover-open")');
  await openLastSources();
  await js(win, 'document.querySelector(".ae-sources-popover:popover-open .ae-source-link")?.click()');
  const opened = await waitUntil(() => openedSources.includes('https://github.com/nox-qa/1'), 3000, 50);
  const blocked = await js(win, `Promise.all(['file:///tmp/a', 'javascript:1', 'https://user:pass@example.org'].map((url) => window.jarvis.openSource(url)))`);
  await js(win, 'document.querySelector(".ae-sources-popover:popover-open")?.hidePopover()');
  await setViewport(win, 1200, 720);
  await openLastSources();
  const widePopover = await readPopover();
  if (widePopover?.fits) shots.push(await shot(win, '21-sources-1200x720.png'));
  await js(win, `(() => {
    document.querySelector('.ae-sources-popover:popover-open')?.hidePopover();
    const first = document.querySelector('.ae-sources-trigger');
    first.scrollIntoView({ block: 'start' });
    first.click();
  })()`);
  const downwardPopover = await readPopover();
  await js(win, 'window.__noxAether.store.createNewChat()');
  await js(win, `window.__noxAether.store.selectChat(${JSON.stringify(sourceChat)})`);
  const reopened = await js(win, `[...document.querySelectorAll('.ae-sources-trigger')].map((button) => button.textContent)`);
  const expected = [1, 5, 20].map((count) => `Источники · ${count}`);
  const history = JSON.parse(fs.readFileSync(path.join(dataDir, 'conversation.json'), 'utf8'));
  const persisted = history.chats.find((chat) => chat.id === sourceChat)?.history
    .filter((m) => m.searchSources).map((m) => m.searchSources.length);
  const compact = (panel) => panel?.fits && panel.anchored && panel.width >= 300 && panel.width <= 340 &&
    panel.height <= 272 && panel.rowHeight >= 48 && panel.rowHeight <= 54 && panel.icon && panel.clippedTitle;
  push('search-sources-popover-and-history',
    JSON.stringify(counts.map((item) => item.count)) === '[0,1,5,20]' &&
    counts.every((item) => item.textLinkExcluded) &&
    JSON.stringify(counts.slice(1).map((item) => item.label)) === JSON.stringify(expected) &&
    compact(popover) && popover.scroll && popover.fallback && popover.side === 'above' &&
    compact(widePopover) && widePopover.scroll && widePopover.side === 'above' &&
    compact(downwardPopover) && downwardPopover.side === 'below' &&
    lightDismissed && escapeDismissed && opened && blocked.every((result) => result.ok === false) &&
    JSON.stringify(reopened) === JSON.stringify(expected) && JSON.stringify(persisted) === '[1,5,20]',
    { counts, popover, widePopover, downwardPopover, lightDismissed, escapeDismissed, opened, openedSources, blocked, reopened, persisted });

  // ── 12. Финальная проверка утечек и ошибок консоли/рендерера ──
  const pageState = await js(win, `(() => ({
    pageErrors: window.__qaErrs || [],
    leaks: /deepseek|minimax|openai|gemini|claude/i.test(document.body.innerText),
  }))()`);
  push('no-console-or-page-errors-and-no-leaks', consoleErrors.length === 0 && pageErrors.length === 0 && pageState.pageErrors.length === 0 && !pageState.leaks, {
    consoleErrors,
    pageErrors,
    rendererErrors: pageState.pageErrors,
    leaks: pageState.leaks,
  });

  const pass = checks.filter((c) => c.ok).length;
  const failCount = checks.length - pass;
  finish({
    ok: failCount === 0,
    elapsedMs: Date.now() - startedAt,
    pass,
    fail: failCount,
    checks,
    screenshots: shots,
    consoleErrors,
    pageErrors,
  }, failCount === 0 ? 0 : 1);
}

app.on('browser-window-created', (_event, win) => {
  try { win.webContents.setBackgroundThrottling(false); } catch { /* ignore */ }
  win.webContents.on('console-message', (_ev, level, msg) => {
    if (level === 3 || level === 'error') consoleErrors.push(String(msg || '').slice(0, 400));
  });
  win.webContents.on('render-process-gone', (_ev, details) => {
    pageErrors.push('render-process-gone: ' + JSON.stringify(details));
  });
  win.webContents.once('did-finish-load', () => {
    if (mainWin) return;
    const url = win.webContents.getURL();
    if (!/renderer[\\/]aether[\\/]index\.html/i.test(url)) return;
    mainWin = win;
    const run = CHAT_REDESIGN || WIDGETS_ONLY ? runChatRedesignQa : runQa;
    run(win).catch((err) => {
      finish({ ok: false, error: err && err.stack ? err.stack : String(err), consoleErrors, pageErrors }, 1);
    });
  });
});

startQaBrainServer()
  .then((srv) => {
    brainSrv = srv;
    process.env.NOX_BRAIN_KEY = 'qa-local-test-key';
    process.env.NOX_BRAIN_URL = `http://127.0.0.1:${srv.port}/v1`;
    require('../main');
  })
  .catch((err) => finish({ ok: false, error: err && err.stack ? err.stack : String(err) }, 1));
