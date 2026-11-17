'use strict';

// Живой стенд проверки Шага 2 агента экрана (P0-1..P0-5 + интеграция _loop) в настоящем Electron
// с временным NOX_DATA_DIR, локальным SSE-стабом модели и настоящим внешним окном WinForms (отдельный PID).
// Запуск из apps/jarvis-desktop (со снятым ELECTRON_RUN_AS_NODE):
//   .\node_modules\electron\dist\electron.exe scripts\screen-agent-qa.js [--out-dir <папка>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let electron = null;
try { electron = require('electron'); } catch { electron = null; }
if (!electron || typeof electron !== 'object' || !electron.app || typeof electron.app.whenReady !== 'function') {
  console.error('screen-agent-qa: требуется запуск через electron.exe, а не node (снимите ELECTRON_RUN_AS_NODE)');
  process.exit(1);
}

const { app, globalShortcut, BrowserWindow } = electron;

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_OUT = path.join('C:', 'Users', 'abdut', 'OneDrive', 'Desktop', 'rev', 'impl', 'agent');
const OUT_DIR = path.resolve(arg('out-dir', DEFAULT_OUT));
const TIMEOUT_MS = 180000;

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Изолированный временный профиль и NOX_DATA_DIR ──────────────────────
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-screen-qa-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
for (const d of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  uiShell: 'aether',
  mode: 'full',
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

app.setPath('userData', profileDir);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = dataDir;
require('../src/config/paths').projectRoot = () => tempRoot;

globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

// ── Внешнее тестовое окно WinForms (отдельный PID для настоящего UIA) ───
const targetStateFile = path.join(tempRoot, 'target-state.json');
const targetTitleFile = path.join(tempRoot, 'target-title.txt');
const targetFlipFile = path.join(tempRoot, 'flip-to-telegram.txt');
fs.writeFileSync(targetTitleFile, 'Тестовый чат — QA', 'utf8');

let targetProc = null;
function startTargetWindow() {
  const scriptFile = path.join(tempRoot, 'target-win.ps1');
  const ps = [
    'Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase',
    '$w = New-Object System.Windows.Window',
    `$titleFile = ${JSON.stringify(targetTitleFile)}`,
    `$stateFile = ${JSON.stringify(targetStateFile)}`,
    `$flipFile = ${JSON.stringify(targetFlipFile)}`,
    '$w.Title = [System.IO.File]::ReadAllText($titleFile, [System.Text.Encoding]::UTF8).Trim()',
    '$w.Width = 420; $w.Height = 260',
    '$w.WindowStartupLocation = "Manual"; $w.Left = 40; $w.Top = 40',
    '$w.Topmost = $true',
    '$sp = New-Object System.Windows.Controls.StackPanel; $sp.Margin = 14',
    '$lbl = New-Object System.Windows.Controls.TextBlock; $lbl.Text = "Черновик готов"; $lbl.Margin = "0,0,0,8"',
    '$box = New-Object System.Windows.Controls.TextBox; $box.Name = "MessageBox"; $box.Margin = "0,0,0,8"; $box.Height = 28',
    '[System.Windows.Automation.AutomationProperties]::SetName($box, "Сообщение")',
    '$chk = New-Object System.Windows.Controls.CheckBox; $chk.Content = "Отметить"; $chk.Margin = "0,0,0,8"',
    '$btn = New-Object System.Windows.Controls.Button; $btn.Content = "Отправить"; $btn.Height = 32',
    '$sp.Children.Add($lbl); $sp.Children.Add($box); $sp.Children.Add($chk); $sp.Children.Add($btn)',
    '$w.Content = $sp',
    '$script:clicks = 0',
    '$save = {',
    '  $obj = @{ sendClicks = $script:clicks; text = $box.Text; checked = [bool]$chk.IsChecked; title = $w.Title } | ConvertTo-Json -Compress',
    '  [System.IO.File]::WriteAllText($stateFile, $obj, [System.Text.Encoding]::UTF8)',
    '}',
    '$btn.Add_Click({ $script:clicks += 1; $lbl.Text = "Отправлено: " + $script:clicks; & $save })',
    '$chk.Add_Checked({ if (Test-Path $flipFile) { $w.Title = "Telegram — Личный чат" }; & $save })',
    '$chk.Add_Unchecked({ if (Test-Path $flipFile) { $w.Title = "Telegram — Личный чат" }; & $save })',
    '$box.Add_TextChanged({ & $save })',
    '$w.Add_ContentRendered({ & $save })',
    '$timer = New-Object System.Windows.Threading.DispatcherTimer',
    '$timer.Interval = [TimeSpan]::FromMilliseconds(200)',
    '$timer.Add_Tick({',
    '  if (Test-Path $titleFile) {',
    '    $want = [System.IO.File]::ReadAllText($titleFile, [System.Text.Encoding]::UTF8).Trim()',
    '    if ($want -and -not (Test-Path $flipFile) -and $w.Title -ne $want) { $w.Title = $want }',
    '  }',
    '})',
    '$timer.Start()',
    '[void]$w.ShowDialog()',
  ].join('\n');
  fs.writeFileSync(scriptFile, '\uFEFF' + ps, 'utf8');
  targetProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptFile], {
    stdio: 'ignore',
    windowsHide: false,
  });
}

function readTargetState() {
  try {
    return JSON.parse(fs.readFileSync(targetStateFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { sendClicks: 0, text: '', checked: false };
  }
}

// ── Локальный SSE-стаб модели ───────────────────────────────────────────
function sendCompletion(res, body, chunks, delayMs = 20, finishReason = 'stop') {
  if (!body.stream) {
    const content = chunks.map((c) => c.content || '').join('');
    const toolCalls = chunks.flatMap((c) => c.tool_calls || []).map((tc) => ({
      id: tc.id, type: 'function', function: tc.function,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'qa-screen-completion',
      object: 'chat.completion',
      model: body.model || 'qa-screen-model',
      choices: [{ index: 0, message: toolCalls.length ? { role: 'assistant', content: content || null, tool_calls: toolCalls } : { role: 'assistant', content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
    }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let idx = 0;
  let closed = false;
  let timer = null;
  res.on('close', () => { closed = true; if (timer) clearTimeout(timer); });
  const step = () => {
    if (closed) return;
    if (idx < chunks.length) {
      res.write(`data: ${JSON.stringify({ id: 'qa-screen-stream', object: 'chat.completion.chunk', model: 'qa-screen-model', choices: [{ index: 0, delta: chunks[idx], finish_reason: null }] })}\n\n`);
      idx += 1;
      timer = setTimeout(step, delayMs);
      return;
    }
    res.write(`data: ${JSON.stringify({ id: 'qa-screen-stream', object: 'chat.completion.chunk', model: 'qa-screen-model', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'qa-screen-stream', object: 'chat.completion.chunk', model: 'qa-screen-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  step();
}

const modelRequests = [];

function startBrainStub() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const firstUser = messages.find((m) => m && m.role === 'user');
        const userText = String((firstUser && firstUser.content) || '');
        const toolsSeen = messages.filter((m) => m && m.role === 'tool').length;
        const lastTool = [...messages].reverse().find((m) => m && m.role === 'tool');
        modelRequests.push({ userText: userText.slice(0, 80), toolsSeen });

        const call = (name, args, id) => sendCompletion(res, body, [{
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        }], 15, 'tool_calls');

        // DEMO 6 (отказ): напиши в чате и нажми Отправить
        if (/напиши в чате.*отправь/i.test(userText)) {
          if (toolsSeen === 0) return call('screen_look', {}, 'd6_look');
          if (toolsSeen === 1) return call('ui_type', { window: 'Тестовый чат — QA', name: 'Сообщение', text: 'опоздаю на 10 минут' }, 'd6_type');
          if (toolsSeen === 2) return call('ui_click', { window: 'Тестовый чат — QA', name: 'Отправить' }, 'd6_send');
          return sendCompletion(res, body, [{ content: 'Операция остановлена.' }], 15);
        }

        // DEMO 6 (одобрение): нажми Отправить
        if (/нажми Отправить в тестовом окне/i.test(userText)) {
          if (toolsSeen === 0) return call('screen_look', {}, 'd6a_look');
          if (toolsSeen === 1) return call('ui_click', { window: 'Тестовый чат — QA', name: 'Отправить' }, 'd6a_send');
          return sendCompletion(res, body, [{ content: 'Кнопка нажата.' }], 15);
        }

        // DEMO 7: прочитай экран
        if (/прочитай, что написано на экране/i.test(userText)) {
          if (toolsSeen === 0) return call('screen_look', {}, 'd7_look');
          if (toolsSeen === 1) return call('ui_elements', { window: 'Тестовый чат — QA' }, 'd7_els');
          let summary = 'Окно не прочитано.';
          try {
            const parsed = JSON.parse(lastTool.content);
            const names = ((parsed.data && parsed.data.elements) || []).map((e) => e.name).filter(Boolean);
            summary = `В окне «Тестовый чат — QA» видны элементы: ${names.join(', ')}.`;
          } catch { /* ignore */ }
          return sendCompletion(res, body, [{ content: summary }], 15);
        }

        // §5 CheckBox (confirmed) + много шагов (прогресс Шаг N из M)
        if (/отметь флажок/i.test(userText)) {
          if (toolsSeen === 0) return call('screen_look', {}, 'chk_look');
          if (toolsSeen === 1) return call('ui_windows', {}, 'chk_win');
          if (toolsSeen === 2) return call('ui_click', { window: 'Тестовый чат — QA', name: 'Отметить' }, 'chk_click');
          const confirmed = lastTool && /"verified"\s*:\s*"confirmed"/.test(lastTool.content);
          return sendCompletion(res, body, [{ content: confirmed ? 'Готово: флажок «Отметить» переключён и подтверждён.' : 'Не удалось подтвердить переключение флажка.' }], 15);
        }

        // §5 F-3: защищённое окно Telegram поверх
        if (/проверь защищённое окно/i.test(userText)) {
          if (toolsSeen === 0) return call('screen_look', {}, 'f3_look');
          if (toolsSeen === 1) return call('ui_click', { window: 'Тестовый чат — QA', name: 'Отметить' }, 'f3_click');
          return sendCompletion(res, body, [{ content: 'Операция завершена без автоснимка защищённого окна.' }], 15);
        }

        // §5 Стоп / Esc
        if (/подожди на экране/i.test(userText)) {
          if (toolsSeen === 0) return call('screen_look', {}, 'stop_look');
          return call('ui_wait', { seconds: 10 }, 'stop_wait');
        }

        return sendCompletion(res, body, [{ content: 'Ответ стенда.' }], 15);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ── Утилиты окна ────────────────────────────────────────────────────────
let mainWin = null;
let brainSrv = null;
const consoleErrors = [];
const pageErrors = [];
const checks = [];
const shots = [];

function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.error(`[QA] ${ok ? 'PASS' : 'FAIL'} ${name}`);
}

async function js(win, code) { return win.webContents.executeJavaScript(code, true); }
async function settle(win, ms = 120) {
  if (ms) await sleep(ms);
  await js(win, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))').catch(() => false);
}
async function setViewport(win, width, height) {
  try { win.setMinimumSize(200, 200); } catch {}
  win.setContentSize(width, height);
  for (let i = 0; i < 40; i += 1) {
    const [w, h] = win.getContentSize();
    if (w === width && h === height) break;
    await sleep(30);
  }
  await settle(win, 160);
}
async function shot(win, fileName) {
  try { win.showInactive(); } catch {}
  await settle(win, 120);
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const full = path.join(OUT_DIR, fileName);
  fs.writeFileSync(full, img.toPNG());
  shots.push(full);
  return full;
}
async function captureBoth(win, baseName) {
  await setViewport(win, 1200, 720);
  await shot(win, `${baseName}-1200x720.png`);
  await setViewport(win, 864, 520);
  await shot(win, `${baseName}-864x520.png`);
  await setViewport(win, 1200, 720);
}
async function waitUntil(fn, timeout = 20000, stepMs = 80) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const val = await fn();
    if (val) return val;
    await sleep(stepMs);
  }
  return null;
}
async function waitIdle(win, timeout = 25000) {
  return waitUntil(() => js(win, '(() => { const s = window.__noxAether.store.state; return !s.trackerBusy && !s.sendingLock; })()'), timeout, 80);
}
async function sendChat(win, text) {
  await js(win, `(() => {
    const ta = document.querySelector('#chatInput');
    ta.focus();
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
}
async function freshChat(win) {
  await js(win, 'window.__noxAether.store.createNewChat()');
  await settle(win, 120);
}
function readJournal() {
  const file = path.join(dataDir, 'journal.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Машинный отчёт стенда: все проверки и счётчики, по которым ревью сверяет прогон повторно.
// Лежит рядом со снимками (rev/impl/agent/verify-report.json).
function buildVerifyReport(code = 0) {
  const journal = readJournal();
  const decisions = {};
  for (const row of journal) {
    const key = String(row && row.decision ? row.decision : 'none');
    decisions[key] = (decisions[key] || 0) + 1;
  }
  const target = readTargetState();
  const passed = checks.filter((c) => c.ok).length;
  return {
    tool: 'screen-agent-qa',
    generatedAt: new Date().toISOString(),
    ok: code === 0 && passed === checks.length && consoleErrors.length === 0 && pageErrors.length === 0,
    passed,
    failed: checks.length - passed,
    total: checks.length,
    checks,
    counters: {
      shots: shots.length,
      decisions,
      sendClicks: Number(target && target.sendClicks) || 0,
      journalEntries: journal.length,
      modelRequests: modelRequests.length,
    },
    shots,
    consoleErrors,
    pageErrors,
  };
}

function finish(code = 0) {
  try { if (targetProc && !targetProc.killed) targetProc.kill(); } catch {}
  try { if (brainSrv && brainSrv.server) brainSrv.server.close(); } catch {}
  const report = buildVerifyReport(code);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'verify-report.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    console.error(`[QA] не удалось записать verify-report.json: ${err && err.message}`);
  }
  console.log(JSON.stringify(report, null, 2));
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  app.exit(code);
}

const deadline = setTimeout(() => {
  check('overall-timeout', false, { msg: 'Превышен лимит времени стенда' });
  finish(1);
}, TIMEOUT_MS);

async function runQa(win) {
  await waitUntil(() => js(win, 'Boolean(window.__noxAether)'), 15000);
  await js(win, "window.__noxAether.setRoute('chat')");
  await setViewport(win, 1200, 720);

  // Дождаться появления реального внешнего окна WinForms в UIA
  const targetReady = await waitUntil(() => fs.existsSync(targetStateFile), 12000, 150);
  await sleep(500);

  // Перехватить события прогресса в окне, чтобы проверить «Шаг N из M» в живом потоке
  await js(win, `(() => {
    window.__qaNotes = [];
    window.jarvis.onEvent((ev) => {
      if (ev && ev.type === 'status' && typeof ev.label === 'string') window.__qaNotes.push(ev.label);
    });
  })()`);

  // ── 1. DEMO 6 (отказ на опасном действии Отправить) ──────────────────
  await sendChat(win, 'Сделай на экране: напиши в чате и отправь');
  const d6Approval = await waitUntil(() => js(win, `(() => {
    const dock = document.querySelector('#aeApprovalDock');
    if (!dock || dock.hidden) return null;
    const once = dock.querySelector('[data-decision="once"]');
    const rej = dock.querySelector('[data-decision="reject"]');
    const sess = dock.querySelector('[data-decision="session"]');
    return rej ? { hasSessionBtn: Boolean(sess && !sess.hidden), reason: dock.textContent } : null;
  })()`), 25000, 80);
  await captureBoth(win, 'demo6-approval');
  if (d6Approval) {
    await js(win, `document.querySelector('#aeApprovalDock [data-decision="reject"]')?.click()`);
  }
  await waitIdle(win, 15000);
  const d6State = readTargetState();
  const d6Reply = await js(win, `window.__noxAether.store.state.feedItems.filter((m) => m.kind === 'assistant').at(-1)?.text || ''`);
  const d6JournalRaw = fs.readFileSync(path.join(dataDir, 'journal.jsonl'), 'utf8');
  const d6Journal = readJournal();
  const d6TypeEntry = d6Journal.find((r) => r.tool === 'ui_type');
  const d6SendEntry = d6Journal.find((r) => r.tool === 'ui_click');
  check('DEMO 6 (отказ): ввод текста замаскирован в журнале, Отправить не нажата без согласия', Boolean(
    targetReady
    && d6Approval && !d6Approval.hasSessionBtn
    && d6State.sendClicks === 0
    && /не подтвердили/i.test(d6Reply)
    && !/готово/i.test(d6Reply)
    && !d6JournalRaw.includes('опоздаю на 10 минут')
    && d6TypeEntry && /\[скрыто, 19 симв\.\]/.test(JSON.stringify(d6TypeEntry.args))
    && d6SendEntry && d6SendEntry.decision === 'reject'
  ), { d6Approval, d6State, d6Reply, d6TypeEntry, d6SendEntry });

  // ── 2. DEMO 6 (одобрение): клик Отправить -> кнопка без ownState = unverified, без «готово» ──
  await freshChat(win);
  await sendChat(win, 'Сделай на экране: нажми Отправить в тестовом окне');
  const d6aApproval = await waitUntil(() => js(win, `(() => {
    const dock = document.querySelector('#aeApprovalDock');
    const once = dock && !dock.hidden ? dock.querySelector('[data-decision="once"]') : null;
    return once && !once.disabled ? true : null;
  })()`), 25000, 80);
  if (d6aApproval) {
    await js(win, `document.querySelector('#aeApprovalDock [data-decision="once"]')?.click()`);
  }
  await waitIdle(win, 20000);
  await sleep(300);
  const d6aState = readTargetState();
  const d6aReply = await js(win, `window.__noxAether.store.state.feedItems.filter((m) => m.kind === 'assistant').at(-1)?.text || ''`);
  const d6aEntry = readJournal().filter((r) => r.tool === 'ui_click').at(-1);
  check('DEMO 6 (согласие) + P0-2 (B-1): Отправить реально нажата, без ownState не врёт «готово»', Boolean(
    d6aApproval
    && d6aState.sendClicks === 1
    && !/готово/i.test(d6aReply)
    && /не уверен|не подтвердила/i.test(d6aReply)
    && d6aEntry && d6aEntry.decision === 'once' && d6aEntry.verifiedStatus === 'unverified'
  ), { d6aState, d6aReply, d6aEntry });

  // ── 3. DEMO 7: чтение экрана ──────────────────────────────────────────
  await freshChat(win);
  await sendChat(win, 'Сделай на экране: прочитай, что написано на экране');
  await waitIdle(win, 20000);
  const d7Reply = await js(win, `window.__noxAether.store.state.feedItems.filter((m) => m.kind === 'assistant').at(-1)?.text || ''`);
  await captureBoth(win, 'demo7-read');
  check('DEMO 7: чтение реального окна по факту без выдумки', Boolean(
    /Тестовый чат — QA/.test(d7Reply)
    && /Отправить/.test(d7Reply)
    && !/готово/i.test(d7Reply)
  ), { d7Reply });

  // ── 4. §5: CheckBox (подтверждённое переключение) + прогресс «Шаг N из 40» ──
  await freshChat(win);
  await js(win, 'window.__qaNotes = []');
  await sendChat(win, 'Сделай на экране: отметь флажок');
  const seenStepProgress = await waitUntil(() => js(win, `window.__qaNotes.some((n) => /^Шаг \\d+ из 40/.test(n))`), 15000, 40);
  await waitIdle(win, 25000);
  const chkState = readTargetState();
  const chkReply = await js(win, `window.__noxAether.store.state.feedItems.filter((m) => m.kind === 'assistant').at(-1)?.text || ''`);
  const notes = await js(win, 'window.__qaNotes.slice()');
  const chkEntry = readJournal().filter((r) => r.tool === 'ui_click').at(-1);
  const chkWork = await js(win, `(() => {
    const msg = [...document.querySelectorAll('#feed .ae-msg.is-assistant')].at(-1);
    if (!msg) return null;
    const label = msg.querySelector('.ae-step-label');
    return { label: label ? label.textContent.trim() : '', text: msg.textContent };
  })()`);
  await captureBoth(win, 'progress-confirmed');
  check('Интеграция _loop: прогресс «Шаг N из 40» и confirmed для CheckBox', Boolean(
    seenStepProgress
    && chkState.checked === true
    && /подтверждён/i.test(chkReply)
    && chkEntry && chkEntry.verifiedStatus === 'confirmed'
  ), { notes, chkState, chkReply, chkEntry });
  // P1: журнал и модель говорят «подтверждено» — строка хода тоже обязана говорить «Готово».
  check('P1 (ревью шага 2): подтверждённое действие — строка хода «Готово», без «Не подтверждено»', Boolean(
    chkWork && chkWork.label === 'Готово' && !/Не подтверждено/.test(chkWork.text || '')
  ), { chkWork });

  // ── 5. §5 (F-3): защищённое окно поверх не даёт автоснимок ──────────
  fs.writeFileSync(targetFlipFile, '1', 'utf8');
  await freshChat(win);
  await sendChat(win, 'Сделай на экране: проверь защищённое окно');
  await waitIdle(win, 20000);
  const f3Denied = readJournal().filter((r) => r.tool === 'screen_look' && r.args && r.args.auto && r.decision === 'deny');
  check('P0-5 (F-3): поверх окно Telegram — автоснимок запрещён и записан в журнал без картинки', Boolean(
    f3Denied.length >= 1
  ), { f3Denied: f3Denied.at(-1) });
  try { fs.rmSync(targetFlipFile, { force: true }); } catch {}
  fs.writeFileSync(targetTitleFile, 'Тестовый чат — QA', 'utf8');

  // ── 6. §5 (P0-4): Стоп посреди шага ───────────────────────────────────
  await freshChat(win);
  await sendChat(win, 'Сделай на экране: подожди на экране');
  const stopBtnReady = await waitUntil(() => js(win, `Boolean(document.querySelector('.ae-live-stop:not(:disabled)'))`), 15000, 40);
  if (stopBtnReady) {
    await js(win, `document.querySelector('.ae-live-stop')?.click()`);
  }
  await waitIdle(win, 15000);
  const stopReply = await js(win, `document.querySelector('#feed .ae-reply-stopped')?.textContent || ''`);
  const stopFeed = await js(win, `(() => {
    const msgs = [...document.querySelectorAll('#feed .ae-msg.is-assistant')];
    const last = msgs.at(-1);
    const label = last && last.querySelector('.ae-step-label');
    return {
      live: document.querySelectorAll('#feed .ae-msg.is-live').length,
      stopButtons: document.querySelectorAll('#feed .ae-live-stop').length,
      text: msgs.map((m) => m.textContent).join(' \\n '),
      workLabel: label ? label.textContent.trim() : '',
      assistantCount: msgs.length,
    };
  })()`);
  await captureBoth(win, 'stop-turn');
  check('P0-4 (Esc/Стоп): остановка шага ui_wait без ложного «готово»', Boolean(
    stopBtnReady && /Остановлено/.test(stopReply)
  ), { stopBtnReady, stopReply });
  // P2: после стопа не остаётся живой строки «Ход работы → Думаю…» и лишнего «думающего» ответа.
  check('P2 (ревью шага 2): после Esc-стопа нет живой строки и «Думаю…»', Boolean(
    stopFeed.live === 0 && stopFeed.stopButtons === 0
    && !/Думаю/.test(stopFeed.text)
    && stopFeed.workLabel === 'Остановлено'
    && stopFeed.assistantCount === 1
  ), { stopFeed });

  const allPassed = checks.every((c) => c.ok) && consoleErrors.length === 0 && pageErrors.length === 0;
  clearTimeout(deadline);
  finish(allPassed ? 0 : 1);
}

app.on('browser-window-created', (_event, win) => {
  try { win.webContents.setBackgroundThrottling(false); } catch {}
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
      check('unhandled-qa-error', false, { error: err && err.stack ? err.stack : String(err) });
      clearTimeout(deadline);
      finish(1);
    });
  });
});

startTargetWindow();
startBrainStub()
  .then((srv) => {
    brainSrv = srv;
    process.env.NOX_BRAIN_KEY = 'qa-local-test-key';
    process.env.NOX_BRAIN_URL = `http://127.0.0.1:${srv.port}/v1`;
    require('../main');
  })
  .catch((err) => {
    check('startup-error', false, { error: err && err.stack ? err.stack : String(err) });
    clearTimeout(deadline);
    finish(1);
  });
