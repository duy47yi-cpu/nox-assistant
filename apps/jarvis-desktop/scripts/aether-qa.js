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

const { app, globalShortcut } = electron;

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.resolve(arg('out-dir', path.join(REPO_ROOT, 'docs', 'design', 'nox-aether', 'screenshots-gate2')));
const KEEP_TEMP = has('keep-temp');
const TIMEOUT_MS = 240000;

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
require('../src/config/paths').projectRoot = () => tempRoot;

// Глобальные клавиши не занимают хоткеи владельца
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

// ── Локальный OpenAI-совместимый SSE-сервер (без внешней сети) ────────
let qaErrorAttempts = 0;

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
        console.error('[qa-brain]', req.method, req.url, 'stream=', Boolean(body.stream), 'lastRole=', lastRole, 'user=', text.slice(0, 60));

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
          // Небольшая пауза, чтобы QA успел снять живую строку состояния во время хода
          await sleep(1100);
          sendCompletion(res, body, [
            { content: 'Проверил рабочую папку: внутри найдены файлы `plan.txt` и `notes.md`. Все подробности и список шагов убраны в блок под ответом.' },
          ], 15);
          return;
        }

        // Запись файла в режиме ask -> вызывает R3-01 подтверждение
        if (/запиши заметку/i.test(text)) {
          if (lastRole !== 'tool') {
            const args = JSON.stringify({ path: 'qa-check.txt', content: 'Проверка подтверждения R3-01 в Nox Aether.\n' });
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

async function shot(win, fileName) {
  try { win.showInactive(); } catch { /* visible */ }
  await settle(win, 120);
  const img = await win.webContents.capturePage();
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
    const labels = [...document.querySelectorAll('#aeTopbar .ae-nav-btn')].filter((b) => b.offsetParent !== null).map((b) => b.innerText.trim());
    const chat = document.querySelector('#noxChat');
    const cr = chat.getBoundingClientRect();
    const cmp = document.querySelector('#aeComposer').getBoundingClientRect();
    const orb = document.querySelector('#aeOrbCanvas').getBoundingClientRect();
    const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    return {
      labels,
      hasLegacyGarbage: /Разговор|Поровну|Присутствие|Демо-данные/.test(topText),
      isEmpty: chat.classList.contains('is-empty'),
      composerCentered: cmp.top < cr.top + cr.height * 0.72,
      orbOk: orb.width > 80 && orb.height > 80,
      overflow,
      sig: document.querySelector('.ae-orb-signature')?.textContent.trim(),
    };
  })()`);
  push('topbar-clean-5-items', !navCheck.hasLegacyGarbage && navCheck.labels.length === 5, navCheck);
  push('empty-chat-centered-and-orb-1200', navCheck.isEmpty && navCheck.composerCentered && navCheck.orbOk && !navCheck.overflow && navCheck.sig === 'The Nox', navCheck);
  shots.push(await shot(win, '01-empty-1200x720.png'));

  await setViewport(win, 864, 520);
  const narrowEmpty = await js(win, `(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    overflowTriggerVisible: document.querySelector('.ae-overflow-trigger')?.offsetParent !== null,
    isEmpty: document.querySelector('#noxChat').classList.contains('is-empty'),
    orbW: Math.round(document.querySelector('#aeOrbCanvas').getBoundingClientRect().width),
    cmpBottom: Math.round(document.querySelector('#aeComposer').getBoundingClientRect().bottom),
    winH: window.innerHeight,
  }))()`);
  push('empty-chat-narrow-864', !narrowEmpty.overflow && narrowEmpty.overflowTriggerVisible && narrowEmpty.isEmpty && narrowEmpty.orbW > 50 && narrowEmpty.cmpBottom <= narrowEmpty.winH, narrowEmpty);
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
        r({ hasTable, hasCode, hasMath, shownOnScrollUp, gapAfter });
      }, 280);
    })));
  })()`);
  push('long-markdown-math-and-scroll', longStats.hasTable && longStats.hasCode && longStats.hasMath && longStats.shownOnScrollUp && longStats.gapAfter < 60, longStats);
  shots.push(await shot(win, '03-long-reply-1200x720.png'));

  // ── 5. Работа инструментов (не >1 строки живого статуса) + свёрнутые/раскрытые Подробности ──
  await sendText(win, 'Проверь файлы папки');
  const liveSeen = await waitUntil(() => js(win, `(() => {
    const w = document.querySelector('#feed .ae-live-line');
    return w && w.innerText.trim() ? { count: document.querySelectorAll('#feed .ae-live-line').length, text: w.innerText.trim(), orbState: document.querySelector('#aeOrbStage')?.dataset.state } : null;
  })()`).catch(() => null), 8000, 50);
  if (liveSeen) shots.push(await shot(win, '04-tool-live-1200x720.png'));
  await waitIdle(win, 18000);
  await settle(win, 180);
  const detailsCheck = await js(win, `(() => {
    const btns = [...document.querySelectorAll('#feed .ae-details-toggle')];
    const lastBtn = btns[btns.length - 1];
    if (!lastBtn) return { found: false };
    const msg = lastBtn.closest('.ae-msg.is-assistant');
    const msgId = msg ? msg.dataset.id : '';
    const collapsedBefore = lastBtn.getAttribute('aria-expanded') === 'false';
    lastBtn.focus();
    lastBtn.click();
    const afterMsg = msgId
      ? [...document.querySelectorAll('#feed .ae-msg.is-assistant')].find((m) => m.dataset.id === msgId)
      : [...document.querySelectorAll('#feed .ae-msg.is-assistant')].pop();
    const afterBtn = afterMsg ? afterMsg.querySelector('.ae-details-toggle') : null;
    const expandedAfter = Boolean(afterBtn && afterBtn.getAttribute('aria-expanded') === 'true');
    const focusPreserved = Boolean(afterBtn && document.activeElement === afterBtn);
    const drawer = afterMsg ? afterMsg.querySelector('.ae-details-panel') : null;
    return { found: true, collapsedBefore, expandedAfter, focusPreserved, drawerText: drawer ? drawer.innerText.trim().slice(0, 120) : '' };
  })()`);
  push('tool-work-minimal-noise-and-details', Boolean(liveSeen && liveSeen.count <= 1 && detailsCheck.found && detailsCheck.collapsedBefore && detailsCheck.expandedAfter && detailsCheck.focusPreserved), { liveSeen, detailsCheck });
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
  push('approval-r301-and-file-write', Boolean(approvalInit && approvalInit.onceDisabledEarly && approvalInit.rejectEnabledEarly && approvalArmed && fileWritten), { approvalInit, approvalArmed, fileWritten });

  // ── 7. Ошибка модели и восстановление кнопкой «Повторить» ──
  await sendText(win, 'Вызови ошибку модели');
  await waitIdle(win, 15000);
  await settle(win, 160);
  const errCard = await js(win, `(() => {
    const cards = [...document.querySelectorAll('#feed .ae-error-card')];
    const last = cards[cards.length - 1];
    if (!last) return { found: false };
    const retry = last.querySelector('.ae-retry-btn, button');
    const tech = last.querySelector('details');
    return { found: true, hasRetry: Boolean(retry), techClosed: Boolean(tech && !tech.open) };
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
  push('error-and-retry-recovery', errCard.found && errCard.hasRetry && errCard.techClosed && recovered, { errCard, recovered });

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

  await js(win, `document.querySelector('#aeNav_personal').click()`);
  const personalLoaded = await waitUntil(() => js(win, `(() => {
    const body = document.querySelector('#aePersonalView .ae-personal-body');
    if (!body || body.dataset.loading === '1') return null;
    return body.innerText.trim().length > 0 ? { len: body.innerText.trim().length, text: body.innerText.trim().slice(0, 140) } : null;
  })()`).catch(() => null), 8000, 50);
  await settle(win, 120);
  push('personal-space-desks-loaded', Boolean(personalLoaded && personalLoaded.len > 0), { personalLoaded });
  shots.push(await shot(win, '12-personal-1200x720.png'));

  // ── 11. Узкое окно 864x520: меню «Разделы», наложенная история, Мастерская ──
  await setViewport(win, 864, 520);
  await js(win, `document.querySelector('#aeNav_chat').click()`);
  await settle(win, 180);
  const narrowMenuOpen = await js(win, `(() => {
    const trig = document.querySelector('.ae-overflow-trigger');
    trig.click();
    const menu = document.querySelector('.ae-overflow-menu');
    const r = menu.getBoundingClientRect();
    return { open: !menu.hidden, fits: r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight };
  })()`);
  shots.push(await shot(win, '13-narrow-nav-864x520.png'));
  await js(win, `document.querySelector('.ae-overflow-trigger')?.click()`);

  // Наложенная панель истории на 864x520
  await js(win, `document.querySelector('#aeHistoryToggle').click()`);
  await settle(win, 180);
  shots.push(await shot(win, '14-narrow-history-864x520.png'));
  await js(win, `document.querySelector('#aeHistoryToggle').click()`);

  await js(win, `document.querySelector('#aeNav_settings').click()`);
  await settle(win, 200);
  const narrowSettingsOverflow = await js(win, `document.documentElement.scrollWidth > window.innerWidth + 1`);
  shots.push(await shot(win, '15-narrow-workshop-864x520.png'));
  push('narrow-864-nav-history-workshop', narrowMenuOpen.open && narrowMenuOpen.fits && !narrowSettingsOverflow, { narrowMenuOpen, narrowSettingsOverflow, dictCheck });

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
    runQa(win).catch((err) => {
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
