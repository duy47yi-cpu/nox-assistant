'use strict';

// Живой стенд: план хода переживает перезапуск приложения. Два запуска настоящего Electron
// с одним временным профилем и NOX_DATA_DIR:
//   A) план из двух шагов, шаг 1 закрыт подтверждённой записью файла;
//   B) перезапуск, владелец пишет «продолжай» — модель получает заметку со сделанным,
//      файлом и следующим шагом, ответ называет их же.
// Модель — локальный SSE-стаб (--brain stub) или наш шлюз (--brain real, ключи из окружения).
// Запуск из apps/jarvis-desktop:  node scripts/plan-resume-qa.js  (из обычного node)
// Пользовательские данные не трогаются: всё во временной папке.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join('C:', 'Users', 'abdut', 'OneDrive', 'Desktop', 'rev', 'impl', 'night3');
const OWNER_A = 'QA: спланируй два шага и выполни только первый. Шаг 1 — создать в рабочей папке файл plans-live.md с текстом «Первая строка». Шаг 2 — дописать в plans-live.md вторую строку. Сначала вызови plan_set с этими двумя шагами. Потом создай файл и закрой шаг 1 через plan_done, указав в доказательстве путь plans-live.md. Второй шаг не выполняй.';
const OWNER_B = 'продолжай. Сначала коротко назови, что уже сделано, какой файл получился и какой шаг следующий. Пока ничего не делай.';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

let electron = null;
try { electron = require('electron'); } catch { electron = null; }
const isElectronMain = Boolean(electron && typeof electron === 'object' && electron.app && typeof electron.app.whenReady === 'function');

// Режим выбирается в конце файла: переменные модуля должны быть инициализированы раньше запуска.

// ── Драйвер: два запуска Electron с одной временной папкой ────────────────
async function runDriver() {
  const electronPath = electron;
  if (typeof electronPath !== 'string') throw new Error('не найден electron.exe: запускайте из apps/jarvis-desktop');
  const brain = arg('brain', process.env.NOX_BRAIN_KEY ? 'real' : 'stub');
  const root = arg('root', '') || fs.mkdtempSync(path.join(os.tmpdir(), 'nox-plan-resume-'));
  const outDir = path.resolve(arg('out-dir', DEFAULT_OUT));
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const report = { kind: 'plan-resume-live', brain, root, outDir, phases: {}, checks: [], ok: false };

  const runPhase = (phase) => new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.NOX_PLAN_QA_ROOT = root;
    env.NOX_PLAN_QA_PHASE = phase;
    env.NOX_PLAN_QA_BRAIN = brain;
    const child = spawn(electronPath, [__filename, '--app'], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdout.on('data', (chunk) => { const line = String(chunk); if (line.includes('NOX_PLAN_QA_RESULT')) process.stdout.write(line); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });

  const check = (name, ok, detail = {}) => {
    report.checks.push({ name, ok: Boolean(ok), detail });
    console.error(`[QA] ${ok ? 'PASS' : 'FAIL'} ${name}`);
  };
  const saveLogs = (phase, run) => {
    fs.writeFileSync(path.join(outDir, `plan-resume-${brain}-phase-${phase}.log`), `STDOUT\n${run.stdout}\nSTDERR\n${run.stderr}`, 'utf8');
  };

  try {
    const a = await runPhase('a');
    saveLogs('a', a);
    report.phases.a = readJson(path.join(root, 'phase-a.json')) || { ok: false, error: 'phase-a.json нет' };
    report.phases.a.exitCode = a.code;
    if (!report.phases.a.ok) report.phases.a.stderrTail = a.stderr.slice(-2000);
    check('A: окно загрузилось и ход завершился', report.phases.a.ok === true);
    const plansFile = path.join(root, 'data', 'plans.json');
    const saved = readJson(plansFile);
    report.planAfterA = saved;
    const item = saved && Array.isArray(saved.items) ? saved.items[0] : null;
    check('A: план сохранён на диск по чату и пространству', Boolean(item && item.chatId && item.workspaceId), item ? { chatId: item.chatId, workspaceId: item.workspaceId } : {});
    check('A: шаг 1 закрыт', Boolean(item && item.steps && item.steps[0] && item.steps[0].status === 'done'), item && item.steps ? item.steps.map((s) => s.status) : null);
    check('A: шаг 2 ждёт', Boolean(item && item.steps && item.steps[1] && item.steps[1].status === 'pending'));
    const liveFile = path.join(root, 'workspace', 'plans-live.md');
    const fileText = fs.existsSync(liveFile) ? fs.readFileSync(liveFile, 'utf8') : null;
    report.fileAfterA = fileText;
    check('A: файл действительно создан', typeof fileText === 'string' && fileText.length > 0, fileText);

    const b = await runPhase('b');
    saveLogs('b', b);
    report.phases.b = readJson(path.join(root, 'phase-b.json')) || { ok: false, error: 'phase-b.json нет' };
    report.phases.b.exitCode = b.code;
    if (!report.phases.b.ok) report.phases.b.stderrTail = b.stderr.slice(-2000);
    check('B: после перезапуска ход завершился', report.phases.b.ok === true);
    check('B: модель получила заметку «продолжаем»', report.phases.b.noteSeen === true);
    const reply = String(report.phases.b.reply || '');
    check('B: в ответе сделанное', /сделано|шаг 1/i.test(reply), reply.slice(0, 300));
    check('B: в ответе файл plans-live.md', reply.includes('plans-live.md'), reply.slice(0, 300));
    check('B: в ответе следующий шаг', /следующ|вторую строку|дописать/i.test(reply), reply.slice(0, 300));
    check('B: чат после перезапуска тот же', Boolean(report.phases.a.chatId) && report.phases.a.chatId === report.phases.b.chatId, { a: report.phases.a.chatId, b: report.phases.b.chatId });

    for (const phase of ['a', 'b']) {
      const shot = path.join(root, `phase-${phase}.png`);
      if (fs.existsSync(shot)) fs.copyFileSync(shot, path.join(outDir, `plan-resume-${brain}-phase-${phase}.png`));
    }
    if (saved) fs.writeFileSync(path.join(outDir, `plan-resume-${brain}-plans-after-a.json`), JSON.stringify(saved, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, `plan-resume-${brain}-live-report.json`), JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, `plan-resume-${brain}-phase-a.json`), JSON.stringify(report.phases.a, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, `plan-resume-${brain}-phase-b.json`), JSON.stringify(report.phases.b, null, 2), 'utf8');

    report.ok = report.checks.every((item) => item.ok);
    console.error(`[QA] ${report.ok ? 'PASS' : 'FAIL'} живой стенд ${report.ok ? 'зелёный' : 'не зелёный'}: ${report.checks.filter((c) => c.ok).length}/${report.checks.length}`);
    console.log(`NOX_PLAN_RESUME_RESULT ${JSON.stringify({ ok: report.ok, brain, root, checks: report.checks })})`);
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
    fs.writeFileSync(path.join(outDir, `plan-resume-${report.brain}-live-report.json`), JSON.stringify(report, null, 2), 'utf8');
    console.error(`plan-resume-qa: ${report.error}`);
    process.exit(1);
  }
}

// ── Приложение: настоящий Electron с временным профилем ───────────────────
let mainWin = null;
let doneOnce = false;
let tempRoot = '';
let qaPhase = 'a';

function finish(result, code) {
  if (doneOnce) return;
  doneOnce = true;
  try {
    const file = path.join(tempRoot || os.tmpdir(), `phase-${qaPhase}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
  } catch { /* отчёт уже мог быть записан */ }
  console.log(`NOX_PLAN_QA_RESULT ${JSON.stringify(result)}`);
  electron.app.exit(code);
}

function sendCompletion(res, body, chunks, finishReason = 'stop', delayMs = 10) {
  if (!body.stream) {
    const content = chunks.map((chunk) => chunk.content || '').join('');
    const toolCalls = chunks.flatMap((chunk) => chunk.tool_calls || []).map((toolCall) => ({ id: toolCall.id, type: 'function', function: toolCall.function }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'qa-plan-completion',
      object: 'chat.completion',
      model: body.model || 'qa-plan-model',
      choices: [{ index: 0, message: toolCalls.length ? { role: 'assistant', content: content || null, tool_calls: toolCalls } : { role: 'assistant', content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let index = 0;
  let closed = false;
  let timer = null;
  res.on('close', () => { closed = true; if (timer) clearTimeout(timer); });
  const step = () => {
    if (closed) return;
    if (index < chunks.length) {
      res.write(`data: ${JSON.stringify({ id: 'qa-plan-stream', object: 'chat.completion.chunk', model: 'qa-plan-model', choices: [{ index: 0, delta: chunks[index], finish_reason: null }] })}\n\n`);
      index += 1;
      timer = setTimeout(step, delayMs);
      return;
    }
    res.write(`data: ${JSON.stringify({ id: 'qa-plan-stream', object: 'chat.completion.chunk', model: 'qa-plan-model', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'qa-plan-stream', object: 'chat.completion.chunk', model: 'qa-plan-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  step();
}

function userTextOf(messages) {
  const parts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string') parts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const item of message.content) if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    }
  }
  return parts.join('\n');
}

function startBrainStub(phase) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
        if (body.max_tokens === 1) return sendCompletion(res, body, [{ content: '.' }]);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const toolsSeen = messages.filter((message) => message && message.role === 'tool').length;
        const call = (name, args, id) => sendCompletion(res, body, [
          { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        ], 'tool_calls');
        if (phase === 'a') {
          if (toolsSeen === 0) return call('plan_set', { steps: ['создать файл plans-live.md с первой строкой', 'дописать вторую строку в plans-live.md'] }, 'qa-plan-set');
          if (toolsSeen === 1) return call('workspace_write', { path: 'plans-live.md', content: 'Первая строка (QA).' }, 'qa-plan-write');
          if (toolsSeen === 2) return call('plan_done', { step: 1, evidence: 'файл plans-live.md записан, проверка подтвердила совпадение' }, 'qa-plan-done');
          return sendCompletion(res, body, [{ content: 'Шаг 1 готов: файл plans-live.md создан. Следующий шаг — дописать вторую строку.' }]);
        }
        const text = userTextOf(messages);
        const sent = /Продолжаем прошлый план/.test(text);
        if (sent) {
          const file = (/Файлы: (.+)/.exec(text) || [])[1] || 'plans-live.md';
          const next = (/Следующий шаг: (.+)/.exec(text) || [])[1] || 'дописать вторую строку';
          return sendCompletion(res, body, [{ content: `Сделано: шаг 1 — файл ${file.trim()} создан. Следующий шаг: ${next.trim()}` }]);
        }
        return sendCompletion(res, body, [{ content: 'Продолжать нечего: сохранённого плана нет.' }]);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function runApp() {
  const { app, globalShortcut } = electron;
  const root = String(process.env.NOX_PLAN_QA_ROOT || '').trim();
  const phase = process.env.NOX_PLAN_QA_PHASE || 'a';
  const brainMode = process.env.NOX_PLAN_QA_BRAIN || 'stub';
  tempRoot = root;
  qaPhase = phase;
  if (!root) throw new Error('нет NOX_PLAN_QA_ROOT: запускайте через scripts/plan-resume-qa.js');
  const profileDir = path.join(root, 'profile');
  const dataDir = path.join(root, 'data');
  for (const dir of [profileDir, dataDir]) fs.mkdirSync(dir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      uiShell: 'aether', mode: 'full', voice: false, backgroundModelRuns: false,
      alwaysListen: false, dictation: false, desktopOverlay: false, alwaysOnTop: false,
      motion: true, seededBrief: true, screenAuto: false,
    }, null, 2), 'utf8');
  }
  app.setPath('userData', profileDir);
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  globalShortcut.register = () => true;
  globalShortcut.unregister = () => {};
  globalShortcut.unregisterAll = () => {};

  let brainServer = null;
  if (brainMode === 'stub') {
    for (const key of Object.keys(process.env)) {
      if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
    }
    brainServer = await startBrainStub(phase);
    process.env.NOX_BRAIN_KEY = 'qa-local-test-key';
    process.env.NOX_BRAIN_URL = `http://127.0.0.1:${brainServer.address().port}/v1`;
    process.env.NOX_BRAIN_MODEL = 'deepseek-4.1-flash'; // модель из таблицы цен: страж бюджета не блокирует
    process.env.NOX_BRAIN_REASONING = 'off';
  }
  process.env.NOX_DATA_DIR = dataDir;
  require('../src/config/paths').projectRoot = () => root;

  // Запросы к модели перехватываем на уровне клиента: так видно, что именно получила модель.
  const requests = [];
  try {
    const { DeepSeekClient } = require('../src/brain/deepseek');
    const originalChat = DeepSeekClient.prototype.chat;
    DeepSeekClient.prototype.chat = function recordChat(args = {}) {
      try {
        requests.push({
          purpose: typeof args.purpose === 'string' ? args.purpose : 'chat',
          userText: userTextOf(args.messages).slice(0, 6000),
        });
      } catch { /* запись не должна ломать запрос */ }
      return originalChat.call(this, args);
    };
  } catch { /* без перехвата стенд всё равно работает */ }

  const timeout = setTimeout(() => finish({ ok: false, error: 'таймаут живого хода' }, 1), 240000);
  process.on('exit', () => {
    clearTimeout(timeout);
    if (brainServer) { try { brainServer.close(); } catch { /* закрываем */ } }
  });

  app.on('browser-window-created', (_event, win) => {
    try { win.webContents.setBackgroundThrottling(false); } catch { /* ignore */ }
    win.webContents.once('did-finish-load', () => {
      if (mainWin) return;
      const url = win.webContents.getURL();
      if (!/renderer[\\/](aether[\\/]index|index)\.html/i.test(url)) return;
      mainWin = win;
      runPhaseInWindow(win, { root, dataDir, phase, requests, brainMode })
        .then((result) => {
          clearTimeout(timeout);
          finish(result, result.ok ? 0 : 1);
        })
        .catch((err) => {
          clearTimeout(timeout);
          finish({ ok: false, error: err && err.stack ? err.stack : String(err), requests: requests.slice(-4) }, 1);
        });
    });
  });

  require('../main');
}

async function runPhaseInWindow(win, { root, dataDir, phase, requests, brainMode }) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitUntil = async (fn, timeout = 180000, stepMs = 150) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await sleep(stepMs);
    }
    return null;
  };
  await sleep(400);
  try { win.showInactive(); } catch { /* окно могло быть скрыто */ }
  try { win.setContentSize(1200, 720); } catch { /* размер не важен */ }

  for (let i = 0; i < 100; i += 1) {
    if (await js('typeof window.jarvis === "object" && typeof window.jarvis.send === "function"')) break;
    await sleep(100);
  }
  const chatId = await js('(async () => { const list = await window.jarvis.chatList(); return list && list.activeId ? list.activeId : null; })()').catch(() => null);
  // Показать в окне именно чат: главная страница Aether — личный раздел, а нам нужен разговор.
  await js('(() => { if (window.__noxAether && window.__noxAether.setRoute) window.__noxAether.setRoute("chat"); return true; })()').catch(() => false);
  await sleep(500);

  await js(`(() => {
    window.__planQa = { events: [], text: '' };
    window.jarvis.onEvent((event) => {
      window.__planQa.events.push(event);
      if (event && event.type === 'text' && typeof event.delta === 'string') window.__planQa.text += event.delta;
    });
    return true;
  })()`);

  const ownerText = phase === 'a' ? OWNER_A : OWNER_B;
  await js(`window.jarvis.send(${JSON.stringify(ownerText)}, [], { agentMode: true })`);
  const done = await waitUntil(() => js(`(() => {
    const event = window.__planQa.events.find((item) => item && item.type === 'done');
    if (!event) return null;
    return { status: event.status || null, outcome: event.outcome || null, replyText: event.replyText || '', text: window.__planQa.text };
  })()`));
  if (!done) throw new Error('ход не завершился: нет события done');
  await sleep(900); // план пишется в finally хода

  const requestsForPhase = requests.filter((item) => item.purpose !== 'warmup');
  const noteSeen = requestsForPhase.some((item) => /Продолжаем прошлый план/.test(item.userText));
  const reply = done.replyText || done.text || '';
  let shot = null;
  try {
    const image = await win.webContents.capturePage();
    shot = path.join(root, `phase-${phase}.png`);
    fs.writeFileSync(shot, image.toPNG());
  } catch { /* снимок не обязателен для проверки */ }

  const plansFile = path.join(dataDir, 'plans.json');
  const saved = readJson(plansFile);
  const item = saved && Array.isArray(saved.items) ? saved.items.find((x) => x && x.chatId === chatId) : null;
  return {
    ok: true,
    phase,
    brain: brainMode,
    chatId,
    doneStatus: done.status,
    outcome: done.outcome,
    reply,
    noteSeen,
    plan: item || null,
    shot: shot ? path.basename(shot) : null,
    requests: requestsForPhase.slice(-6).map((entry) => ({ purpose: entry.purpose, firstUserChars: entry.userText.slice(0, 400) })),
  };
}

// ── Запуск ────────────────────────────────────────────────────────────────
if (!isElectronMain) {
  runDriver().catch((err) => {
    console.error(`plan-resume-qa: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
} else {
  runApp().catch((err) => finish({ ok: false, error: err && err.stack ? err.stack : String(err) }, 1));
}
